import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mountEvolution } from '../src/evolution.js';

async function fixture(t, chunks) {
  const directory = await mkdtemp(join(tmpdir(), 'skill-review-log-'));
  const logDirectory = join(directory, 'review-stream');
  const hooks = {};
  const dispose = [];
  t.after(async () => {
    for (const fn of dispose) fn();
    await rm(directory, { recursive: true, force: true });
  });
  const events = [{ type: 'user/message', seq: 1, data: {} }, { type: 'turn/end', seq: 2, data: {} }];
  const agent = { session: { id: 'fixture' }, provider: 'fixture', model: 'fixture' };
  const llm = { async *stream(options) {
    assert.equal(options.purpose, 'automatic-review');
    yield* chunks;
  } };
  const ctx = {
    on(name, callback) { hooks[name] = callback; }, inject() {}, effect(fn) { dispose.push(fn()); },
    get(name) { if (name === 'llm') return llm; },
    sessionProjections: { async register(p) { return { stateOf: () => p.key.endsWith('/automatic-evidence') ? { events } : {} }; } },
  };
  const mount = () => mountEvolution(ctx, { directory, owner: 'fixture' }, { stateOf: () => ({ evidence: [] }) });
  return { directory, logDirectory, agent, mount, hooks };
}

const verdict = JSON.stringify({ decision: 'no_change', reason: 'PRIVATE_ANSWER', evidence: [{ seq: 1, kind: 'user/message' }] });
const mixed = [{ type: 'reasoning-delta', text: 'PRIVATE_REASONING' }, { type: 'text-delta', text: verdict }, { type: 'finish', reason: { kind: 'stop' } }];

async function readTrace(directory) {
  const [file] = await readdir(directory);
  const raw = await readFile(join(directory, file), 'utf8');
  assert.doesNotMatch(raw, /PRIVATE_/);
  return JSON.parse(raw);
}

test('automatic review logs mixed stream metadata and accepts the valid answer', async t => {
  const f = await fixture(t, mixed);
  const { run } = await f.mount();
  assert.deepEqual(await run(f.agent, 'automatic'), { status: 'no_change' });
  const trace = await readTrace(f.logDirectory);
  assert.equal(trace.status, 'no_change');
  assert.equal(trace.source, 'automatic');
  assert.deepEqual(trace.counts, { 'reasoning-delta': 1, 'text-delta': 1, finish: 1 });
  assert.deepEqual(trace.events.map(event => event.type), mixed.map(chunk => chunk.type));
  assert.equal(trace.events[1].bytes, Buffer.byteLength(verdict));
  assert.equal(trace.finish, 'stop');
});

test('invalid output logs a stable error code and bounds the event sample', async t => {
  const f = await fixture(t, Array.from({ length: 300 }, () => ({ type: 'text-delta', text: 'PRIVATE_ANSWER' })));
  const { run } = await f.mount();
  assert.equal((await run(f.agent, 'automatic')).status, 'failed');
  const trace = await readTrace(f.logDirectory);
  assert.equal(trace.errorCode, 'reviewer_output_not_json');
  assert.equal(trace.stage, 'validate');
  assert.equal(trace.counts['text-delta'], 300);
  assert.equal(trace.events.length, 128);
  assert.equal(trace.omittedEvents, 172);
});

test('startup prunes expired traces and caps count while preserving unrelated files', async t => {
  const f = await fixture(t, []);
  await mkdir(f.logDirectory);
  const name = i => `review-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000.json`;
  const expired = join(f.logDirectory, name(0));
  const old = new Date(Date.now() - 8 * 86400000);
  await writeFile(expired, '{}');
  await utimes(expired, old, old);
  await writeFile(join(f.logDirectory, 'keep.json'), '{}');
  await Promise.all(Array.from({ length: 258 }, (_, i) => writeFile(join(f.logDirectory, name(i + 1)), '{}')));
  await mkdir(f.logDirectory, { recursive: true });
  await f.mount();
  const files = await readdir(f.logDirectory);
  assert(!files.includes(name(0)));
  assert(files.includes('keep.json'));
  assert.equal(files.length, 257);
});

test('log storage failures leave a valid review outcome intact', async t => {
  const f = await fixture(t, mixed);
  await writeFile(f.logDirectory, 'ordinary file');
  const { run } = await f.mount();
  assert.equal((await run(f.agent, 'automatic')).status, 'no_change');
  assert.equal(await readFile(f.logDirectory, 'utf8'), 'ordinary file');
});

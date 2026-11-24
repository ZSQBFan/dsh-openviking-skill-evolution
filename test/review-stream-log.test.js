import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCreateDiff, applySkillDiff } from '../src/review.js';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mountEvolution } from '../src/evolution.js';

async function fixture(t, chunks, { evidence = [], onRequest } = {}) {
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
    onRequest?.(JSON.parse(options.messages[0].content[0].text));
    yield* (typeof chunks === 'function' ? chunks() : chunks);
  } };
  const ctx = {
    on(name, callback) { hooks[name] = callback; }, inject() {}, effect(fn) { dispose.push(fn()); },
    get(name) { if (name === 'llm') return llm; },
    sessionProjections: { async register(p) { return { stateOf: () => p.key.endsWith('/automatic-evidence') ? { events } : {} }; } },
  };
  const mount = () => mountEvolution(ctx, { directory, owner: 'fixture', settings: { mode: 'shadow' } }, { stateOf: () => ({ evidence }) });
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

const uri = 'viking://user/fixture/skills/demo/SKILL.md';
const base = '---\r\nname: demo\r\ndescription: Demo\r\n---\r\n\r\nOld instruction.\r\nUnchanged.\r\n';
const baseSha256 = createHash('sha256').update(base).digest('hex');
const answer = proposal => [{ type: 'text-delta', text: JSON.stringify({ decision: 'approve', reason: 'Grounded change',
  evidence: [{ seq: 1, kind: 'user/message' }], proposal }) }, { type: 'finish', reason: { kind: 'stop' } }];

async function getShadow(f) {
  return JSON.parse(await readFile(join(f.directory, 'governance.json'), 'utf8')).shadows[0];
}

test('manual review quotes an older base and produces an exact patch without model hunk math', async t => {
  let request;
  const f = await fixture(t, answer({ action: 'patch', uri, baseSha256, reason: 'Use checked steps',
    replacement: { before: ['Old instruction.'], after: ['Check the result.', 'Record the outcome.'] } }), {
    evidence: [{ type: 'tool/result', seq: 0, uri, body: base, requestedUris: [uri] }], onRequest: value => { request = value; },
  });
  const { run } = await f.mount();
  assert.equal((await run(f.agent, 'manual')).status, 'shadow');
  assert.equal(request.events.some(event => event.seq === 0), false);
  assert(request.bases[0].bodyExcerpt.includes('Old instruction.'));
  assert(!request.bases[0].bodyExcerpt.includes('description: Demo'));
  const proposal = await getShadow(f);
  assert.equal(applySkillDiff(base, proposal.diff, uri), base.replace('Old instruction.', 'Check the result.\r\nRecord the outcome.'));
});

test('structured replacement rejects a duplicate anchor without recording a draft', async t => {
  const repeated = base.replace('Unchanged.', 'Old instruction.');
  const repeatedHash = createHash('sha256').update(repeated).digest('hex');
  const f = await fixture(t, answer({ action: 'patch', uri, baseSha256: repeatedHash, reason: 'Ambiguous selection',
    replacement: { before: ['Old instruction.'], after: ['New instruction.'] } }), {
    evidence: [{ type: 'tool/result', seq: 0, uri, body: repeated, requestedUris: [uri] }],
  });
  const { run } = await f.mount();
  assert.deepEqual(await run(f.agent, 'manual'), { status: 'failed', reason: 'reviewer_replacement_not_unique', stage: 'validate' });
  assert.equal(await getShadow(f), undefined);
});

test('newer incomplete read suppresses the older patch base and blocks its use', async t => {
  let request;
  const f = await fixture(t, answer({ action: 'patch', uri, baseSha256, reason: 'Stale source',
    replacement: { before: ['Old instruction.'], after: ['New instruction.'] } }), {
    evidence: [
      { type: 'tool/result', seq: 0, uri, body: base, requestedUris: [uri] },
      { type: 'tool/result', seq: 1, requestedUris: [uri] },
    ], onRequest: value => { request = value; },
  });
  const { run } = await f.mount();
  assert.deepEqual(await run(f.agent, 'manual'), { status: 'failed', reason: 'reviewer_stale_base', stage: 'validate' });
  assert.deepEqual(request.bases, []);
  assert.equal(await getShadow(f), undefined);
});

test('manual review builds a canonical create diff from Markdown and a description', async t => {
  const f = await fixture(t, answer({ action: 'create', uri, baseSha256: null, reason: 'Reusable result',
    description: 'Check: results', body: '## Procedure\n\nVerify the result.' }));
  const { run } = await f.mount();
  assert.equal((await run(f.agent, 'manual')).status, 'shadow');
  assert.equal(applyCreateDiff((await getShadow(f)).diff, uri), '---\nname: demo\ndescription: "Check: results"\n---\n\n## Procedure\n\nVerify the result.\n');
});

test('a failed validation can be retried manually after remount and yields a diagnostic code', async t => {
  let attempt = 0;
  const f = await fixture(t, () => ++attempt === 1
    ? answer({ action: 'create', uri, reason: 'Reproduce', diff: 'invalid diff' }) : mixed);
  const first = await f.mount();
  assert.deepEqual(await first.run(f.agent, 'manual'), { status: 'failed', reason: 'invalid_create_diff', stage: 'validate' });
  assert.equal((await readTrace(f.logDirectory)).errorCode, 'invalid_create_diff');
  const remounted = await f.mount();
  assert.deepEqual(await remounted.run(f.agent, 'manual'), { status: 'no_change' });
  assert.deepEqual(await remounted.run(f.agent, 'manual'), { status: 'deduped' });
});

test('an unavailable review model is recorded and the same evidence remains retryable', async t => {
  const f = await fixture(t, mixed);
  const { run } = await f.mount();
  assert.deepEqual(await run({ session: f.agent.session }, 'manual'), { status: 'review_model_unavailable' });
  const persisted = JSON.parse(await readFile(join(f.directory, 'governance.json'), 'utf8'));
  assert.equal(persisted.runs[0]?.status, 'review_model_unavailable');
  const { run: retry } = await f.mount();
  assert.deepEqual(await retry(f.agent, 'manual'), { status: 'no_change' });
});

test('a review interrupted by a settings change remains retryable after remount', async t => {
  const f = await fixture(t, mixed);
  const { run } = await f.mount();
  await run(f.agent, 'manual');
  const path = join(f.directory, 'governance.json');
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  persisted.runs[0].status = 'settings_changed';
  await writeFile(path, JSON.stringify(persisted));
  const { run: retry } = await f.mount();
  assert.deepEqual(await retry(f.agent, 'manual'), { status: 'no_change' });
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

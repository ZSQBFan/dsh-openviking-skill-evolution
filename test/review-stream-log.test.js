import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCreateDiff, applySkillDiff } from '../src/review.js';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mountEvolution } from '../src/evolution.js';
import { createGovernance } from '../src/governance.js';
import { createOpenVikingAdapter } from '../src/ov-adapter.js';

async function fixture(t, chunks, { evidence = [], onRequest, settings = {}, events: eventFixture, agents = [],
  sessionRoute = { provider: 'session-provider', model: 'session-model' },
  expectedRoute = { provider: 'fixture-provider', model: 'fixture-model' }, writer } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'skill-review-log-'));
  const logDirectory = join(directory, 'review-stream');
  const hooks = {};
  const dispose = [];
  t.after(async () => {
    for (const fn of dispose) fn();
    await rm(directory, { recursive: true, force: true });
  });
  const events = eventFixture ?? [{ type: 'user/message', seq: 1, data: {} }, { type: 'turn/end', seq: 2, data: {} }];
  const agent = { session: { id: 'fixture' }, model: { current: () => sessionRoute } };
  const llm = { async *stream(options) {
    assert.equal(options.purpose, 'automatic-review');
    assert.equal(options.provider, expectedRoute.provider);
    assert.equal(options.model, expectedRoute.model);
    onRequest?.(JSON.parse(options.messages[0].content[0].text), options);
    yield* (typeof chunks === 'function' ? chunks(options) : chunks);
  } };
  const ctx = {
    on(name, callback) { hooks[name] = callback; }, inject() {}, effect(fn) { dispose.push(fn()); },
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'agents') return { list: () => agents };
    },
    sessionProjections: { async register(p) { return { stateOf: () => p.key.endsWith('/automatic-evidence') ? { events } : {} }; } },
  };
  const mount = () => mountEvolution(ctx, { directory, owner: 'fixture', writer, settings: {
    mode: 'shadow', provider: 'fixture-provider', model: 'fixture-model', ...settings,
  } }, { stateOf: () => ({ evidence }) });
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
  const ledger = JSON.parse(await readFile(join(f.directory, 'governance.json'), 'utf8')).runs[0];
  assert.equal(ledger.traceId, trace.traceId);
  assert.equal(ledger.evidenceBytes, trace.evidenceBytes);
  assert((await readdir(f.logDirectory)).includes(`review-${ledger.traceId}.json`));
});

test('invalid output logs a stable error code and bounds the event sample', async t => {
  const f = await fixture(t, Array.from({ length: 300 }, () => ({ type: 'text-delta', text: 'PRIVATE_ANSWER' })));
  const { run } = await f.mount();
  assert.deepEqual(await run(f.agent, 'automatic'), { status: 'failed', reason: 'reviewer_output_not_json', errorCode: 'reviewer_output_not_json', stage: 'validate' });
  const trace = await readTrace(f.logDirectory);
  const ledger = JSON.parse(await readFile(join(f.directory, 'governance.json'), 'utf8')).runs[0];
  assert.equal(ledger.errorCode, trace.errorCode);
  assert.equal(ledger.stage, trace.stage);
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

test('a rejected snapshot request records only its HTTP status and operation', async t => {
  const server = createServer((_req, res) => res.writeHead(400).end('PRIVATE_RESPONSE'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = createOpenVikingAdapter({ origin: `http://127.0.0.1:${server.address().port}`,
    managedUri: uri, mode: 'isolated-single-writer' });
  const f = await fixture(t, answer({ action: 'create', uri, baseSha256: null, reason: 'Reusable result',
    description: 'Demo', body: 'Verify the result.' }), { writer: { adapter }, settings: { mode: 'auto' } });
  const result = await (await f.mount()).run(f.agent, 'automatic');
  assert.equal(result.errorCode, 'ov_http_bad_request');
  assert.deepEqual(result.ovRequest, { status: 400, operation: 'skill_detail' });
  assert.deepEqual((await readTrace(f.logDirectory)).ovRequest, result.ovRequest);
  const ledger = await readFile(join(f.directory, 'governance.json'), 'utf8');
  assert.doesNotMatch(ledger, /PRIVATE_RESPONSE/);
  assert.deepEqual(JSON.parse(ledger).runs[0].ovRequest, result.ovRequest);
});

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
  assert.deepEqual(await run(f.agent, 'manual'), { status: 'failed', reason: 'reviewer_replacement_not_unique', errorCode: 'reviewer_replacement_not_unique', stage: 'validate' });
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
  assert.deepEqual(await run(f.agent, 'manual'), { status: 'failed', reason: 'reviewer_stale_base', errorCode: 'reviewer_stale_base', stage: 'validate' });
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

test('failed validation throttles manual and automatic retries across restart without consuming evidence', async t => {
  let attempt = 0;
  const f = await fixture(t, () => ++attempt === 1
    ? answer({ action: 'create', uri, reason: 'Reproduce', diff: 'old operation' }) : mixed, { settings: { cooldownMs: 0 } });
  const first = await f.mount();
  assert.deepEqual(await first.run(f.agent, 'automatic'), { status: 'failed', reason: 'reviewer_operation_extra_field', errorCode: 'reviewer_operation_extra_field', stage: 'validate' });
  assert.equal((await readTrace(f.logDirectory)).errorCode, 'reviewer_operation_extra_field');
  const remounted = await f.mount();
  assert.equal((await remounted.run(f.agent, 'manual')).status, 'cooldown');
  assert.equal((await remounted.run(f.agent, 'automatic')).status, 'cooldown');
  assert.equal(attempt, 1);
  const path = join(f.directory, 'governance.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.runs.length, 1);
  const finishedAt = new Date(Date.now() - 6 * 60_000).toISOString();
  stored.runs[0].finishedAt = finishedAt;
  stored.durableRuns[0].finishedAt = finishedAt;
  await writeFile(path, JSON.stringify(stored));
  const afterCooldown = await f.mount();
  assert.deepEqual(await afterCooldown.run(f.agent, 'manual'), { status: 'no_change' });
  assert.deepEqual(await afterCooldown.run(f.agent, 'manual'), { status: 'deduped' });
});

test('generic OpenViking failures share a retry budget across new evidence, clear and restart', async t => {
  const start = Date.now();
  const minute = 60_000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const server = createServer((_req, res) => res.writeHead(418).end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = createOpenVikingAdapter({ origin: `http://127.0.0.1:${server.address().port}`,
    managedUri: uri, mode: 'isolated-single-writer' });
  const events = [{ type: 'user/message', seq: 1, data: {} }, { type: 'turn/end', seq: 2, data: {} }];
  let modelCalls = 0;
  const f = await fixture(t, answer({ action: 'create', uri, baseSha256: null, reason: 'Reusable result',
    description: 'Demo', body: 'Verify the result.' }), { writer: { adapter }, settings: { mode: 'auto' },
    events, onRequest: () => { modelCalls++; } });
  let { run } = await f.mount();
  const advanceEvidence = () => events.push({ type: 'turn/end', seq: events.at(-1).seq + 1, data: {} });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await run(f.agent, 'automatic')).errorCode, 'ov_request_failed');
    advanceEvidence();
    if (attempt === 0) assert.deepEqual(await run(f.agent, 'automatic'), {
      status: 'cooldown', retryAt: new Date(start + 15 * minute).toISOString(),
    });
    if (attempt < 2) t.mock.timers.tick(15 * minute);
  }
  const governance = await createGovernance({ directory: f.directory, owner: 'fixture' });
  assert.deepEqual(governance.durableHistory().map(row => [row.seq, row.failureCount]), [[4, 3], [3, 2], [2, 1]]);
  assert.equal((await governance.clearHistory({ confirm: true })).count, 3);
  ({ run } = await f.mount());
  assert.deepEqual(await run(f.agent, 'manual'), {
    status: 'retry_blocked', retryAt: new Date(start + 60 * minute).toISOString(),
  });
  assert.equal(modelCalls, 3);
  t.mock.timers.tick(30 * minute);
  assert.equal((await run(f.agent, 'automatic')).errorCode, 'ov_request_failed');
  assert.equal(modelCalls, 4);
});

test('review inherits the complete source session route when the override is empty or incomplete', async t => {
  const expectedRoute = { provider: 'session-provider', model: 'session-model' };
  for (const [settings, source] of [
    [{ provider: '', model: '' }, 'automatic'],
    [{ provider: 'override-provider', model: '' }, 'manual'],
    [{ provider: ' ', model: 'override-model' }, 'manual'],
  ]) {
    const f = await fixture(t, mixed, { settings, sessionRoute: expectedRoute, expectedRoute });
    const { run } = await f.mount();
    assert.deepEqual(await run(f.agent, source), { status: 'no_change' });
    const { runs: [row] } = JSON.parse(await readFile(join(f.directory, 'governance.json'), 'utf8'));
    assert.deepEqual({ provider: row.provider, model: row.model }, expectedRoute);
  }
});

test('an unavailable review model is recorded once and can be retried once the session has a route', async t => {
  const expectedRoute = { provider: 'session-provider', model: 'session-model' };
  const f = await fixture(t, mixed, { settings: { provider: '', model: '' }, sessionRoute: null, expectedRoute });
  const { run } = await f.mount();
  assert.deepEqual(await run(f.agent, 'manual'), { status: 'review_model_unavailable' });
  assert.deepEqual(await run(f.agent, 'automatic'), { status: 'review_model_unavailable' });
  const path = join(f.directory, 'governance.json');
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.runs.length, 1);
  assert.equal(persisted.runs[0]?.status, 'review_model_unavailable');
  f.agent.model.current = () => expectedRoute;
  assert.deepEqual(await run(f.agent, 'manual'), { status: 'no_change' });
});

test('a review interrupted by a settings change remains retryable after remount', async t => {
  const f = await fixture(t, mixed);
  const { run } = await f.mount();
  await run(f.agent, 'manual');
  const path = join(f.directory, 'governance.json');
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  persisted.runs[0].status = 'settings_changed';
  persisted.durableRuns[0].status = 'settings_changed';
  await writeFile(path, JSON.stringify(persisted));
  const { run: retry } = await f.mount();
  assert.deepEqual(await retry(f.agent, 'manual'), { status: 'no_change' });
});

test('replays verbatim actual GPT-6.1 Terra output through stream, validation, compilation and submission', async t => {
  const raw = await readFile(new URL('./fixtures/reviewer-gpt-6.1-terra-approve.json', import.meta.url), 'utf8');
  const capturedUri = 'viking://user/fixture/skills/check/SKILL.md';
  const capturedBase = '---\nname: check\ndescription: Demo\n---\nRun the smoke test.\nRecord the results.\n';
  const f = await fixture(t, [{ type: 'text-delta', text: raw }, { type: 'finish', reason: { kind: 'stop' } }], {
    events: [{ type: 'tool/result', seq: 1, text: 'Smoke script exited 1 but the surrounding pipeline returned 0.' },
      { type: 'user/message', seq: 2, text: 'Skill correction: replace Run the smoke test. with Run the smoke test and verify its exit status. We verified that a successful pipeline can mask a failing script.' }],
    evidence: [{ type: 'tool/result', seq: 1, uri: capturedUri, body: capturedBase, requestedUris: [capturedUri] }],
  });
  const { run } = await f.mount();
  const outcome = await run(f.agent, 'manual');
  assert.equal(outcome.status, 'shadow', JSON.stringify(outcome));
  const { diff } = await getShadow(f);
  assert.equal(applySkillDiff(capturedBase, diff, capturedUri), capturedBase.replace('Run the smoke test.', 'Run the smoke test and verify its exit status.'));
});

test('configured deadline and caller cancellation record distinct outcomes', async t => {
  const hold = async function* () { await new Promise(resolve => setTimeout(resolve, 80)); };
  const timed = await fixture(t, hold, { settings: { reviewTimeoutMs: 10 } });
  const { run } = await timed.mount();
  assert.deepEqual(await run(timed.agent, 'manual'), { status: 'timed_out', reason: 'TimeoutError', errorCode: 'TimeoutError', stage: 'stream' });
  assert.equal((await run(timed.agent, 'manual')).status, 'cooldown');
  assert.equal((await readTrace(timed.logDirectory)).status, 'timed_out');
  const cancel = new AbortController();
  const stopped = await fixture(t, hold, { onRequest: () => queueMicrotask(() => cancel.abort()) });
  const { run: cancelledRun } = await stopped.mount();
  assert.deepEqual(await cancelledRun(stopped.agent, 'manual', cancel.signal), { status: 'cancelled', reason: 'AbortError', errorCode: 'AbortError', stage: 'stream' });
  assert.equal((await readTrace(stopped.logDirectory)).status, 'cancelled');
});

test('manual review does not enter the model stream when its session is running', async t => {
  const f = await fixture(t, mixed, { onRequest: () => assert.fail('busy review requested a model') });
  const { run } = await f.mount();
  assert.deepEqual(await run({ ...f.agent, status: 'running' }, 'manual'), { status: 'review_source_busy' });
  await assert.rejects(readFile(join(f.directory, 'governance.json')), { code: 'ENOENT' });
});

test('manual review waits for an active session sharing the configured provider', async t => {
  const active = { status: 'running', model: { current: () => ({ provider: 'fixture-provider' }) } };
  let modelCalls = 0;
  const f = await fixture(t, mixed, { agents: [active], onRequest: () => { modelCalls++; } });
  const { run } = await f.mount();
  assert.deepEqual(await run(f.agent, 'manual'), { status: 'review_source_busy' });
  assert.equal(modelCalls, 0);
  await assert.rejects(readFile(join(f.directory, 'governance.json')), { code: 'ENOENT' });
  active.status = 'idle';
  assert.deepEqual(await run(f.agent, 'manual'), { status: 'no_change' });
  assert.equal(modelCalls, 1);
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

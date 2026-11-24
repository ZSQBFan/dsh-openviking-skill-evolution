import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGovernance } from '../src/governance.js';
import { createReviewStreamLog } from '../src/review-stream-log.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'review-history-attribution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logDirectory = join(directory, 'review-stream');
  await mkdir(logDirectory);
  const path = join(directory, 'governance.json');
  const mount = () => createGovernance({ directory, owner: 'fixture' });
  const governance = await mount();
  return {
    path, mount, logDirectory, log: createReviewStreamLog(directory),
    seed: async rows => { for (const row of rows) await governance.log(row); },
    trace: async (record, traceId = randomUUID()) => {
      const file = join(logDirectory, `review-${traceId}.json`);
      await writeFile(file, JSON.stringify({ version: 1, ...record }));
      return { traceId, file };
    },
  };
}

const legacy = (seq, overrides = {}) => ({ seq, at: new Date(Date.UTC(2025, 0, seq)).toISOString(),
  sessionId: 's1', source: 'manual', status: 'failed', reason: 'Error', ...overrides });

// Historical rows bypass the live logging path, as they would after an upgrade.
async function seedLegacy(f, rows) {
  await f.seed([{}]);
  const state = JSON.parse(await readFile(f.path, 'utf8'));
  await writeFile(f.path, JSON.stringify({ ...state, runs: rows }));
}

test('startup recovers legacy attribution from a unique exact trace before pruning expired logs', async t => {
  const f = await fixture(t);
  const row = legacy(1);
  await seedLegacy(f, [row]);
  const { traceId, file } = await f.trace({ ...row, stage: 'validate', errorCode: 'reviewer_operation_incomplete' });
  const expired = new Date(Date.now() - 8 * 86400000);
  await utimes(file, expired, expired);
  const governance = await f.mount();
  await f.log.prune();
  assert.deepEqual(await readdir(f.logDirectory), []);
  const expected = { ...row, traceId, stage: 'validate', errorCode: 'reviewer_operation_incomplete' };
  assert.deepEqual(governance.history(), [expected]);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).runs, [expected]);
  assert.deepEqual((await f.mount()).history(), [expected]);
});

test('startup never guesses across multiple exact matches, missing trace details, or nonmatching keys', async t => {
  const f = await fixture(t);
  const [ambiguous, partial, missing, unknown, collided] = [1, 2, 3, 4, 5].map(seq => legacy(seq));
  await seedLegacy(f, [ambiguous, partial, missing, unknown, collided, { ...collided, seq: 6 }]);
  await f.trace({ ...ambiguous, errorCode: 'reviewer_stream_failed' });
  await f.trace({ ...ambiguous, errorCode: 'reviewer_stream_failed' });
  await f.trace({ ...partial, source: 'automatic', errorCode: 'reviewer_output_not_json' });
  await f.trace({ ...partial, sessionId: 's2', errorCode: 'reviewer_output_not_json' });
  await f.trace({ ...partial, at: partial.at.replace('.000', '.001'), errorCode: 'reviewer_output_not_json' });
  const { traceId } = await f.trace({ ...unknown, stage: 'submit', errorCode: 'unexpected_error' });
  await f.trace({ ...collided, errorCode: 'reviewer_stream_failed' });
  const unavailable = row => ({ ...row, errorAttribution: 'unavailable' });
  assert.deepEqual((await f.mount()).history().reverse(), [unavailable(ambiguous), unavailable(partial),
    unavailable(missing), unavailable({ ...unknown, traceId, stage: 'submit' }), unavailable(collided), unavailable({ ...collided, seq: 6 })]);
});

test('known legacy reasons normalize and classify timeouts separately while preserving other terminal statuses', async t => {
  const f = await fixture(t);
  const [timeout, abort, named, terminal] = [legacy(1, { status: 'cancelled', reason: 'TimeoutError' }),
    legacy(2, { status: 'cancelled', reason: 'AbortError' }), legacy(3, { reason: 'Incomplete skill snapshot' }),
    legacy(4, { status: 'write_unconfirmed', reason: 'TimeoutError' })];
  const genericTimeout = legacy(5);
  await seedLegacy(f, [timeout, abort, named, terminal, genericTimeout]);
  const { traceId } = await f.trace({ ...genericTimeout, stage: 'stream', errorCode: 'TimeoutError' });
  assert.deepEqual((await f.mount()).history().reverse(), [
    { ...timeout, status: 'timed_out', errorCode: 'TimeoutError' }, { ...abort, errorCode: 'AbortError' },
    { ...named, errorCode: 'skill_snapshot_incomplete' }, { ...terminal, errorCode: 'TimeoutError' },
    { ...genericTimeout, status: 'timed_out', traceId, stage: 'stream', errorCode: 'TimeoutError' },
  ]);
});

test('logger names the trace using the caller UUID and startup preserves the existing link', async t => {
  const f = await fixture(t);
  const traceId = randomUUID();
  const row = legacy(1, { traceId });
  const { traceId: other } = await f.trace({ ...row, traceId: undefined, errorCode: 'reviewer_stream_failed' });
  await seedLegacy(f, [row]);
  assert.deepEqual((await f.mount()).history(), [{ ...row, errorAttribution: 'unavailable' }]);
  await f.log.write({ version: 1, ...row });
  assert.deepEqual((await readdir(f.logDirectory)).sort(), [`review-${other}.json`, `review-${traceId}.json`].sort());
  assert.equal(JSON.parse(await readFile(join(f.logDirectory, `review-${traceId}.json`), 'utf8')).traceId, traceId);
});

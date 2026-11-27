import assert from 'node:assert/strict';
import test from 'node:test';
import { consumesReviewEvidence, retryReviewDecision } from '../src/review-retry.js';

const finishedAt = '2026-11-24T20:00:00.000Z';
const finished = Date.parse(finishedAt);
const config = { revision: 2, cooldownMs: 0 };
const failure = { status: 'failed', seq: 85, finishedAt, settingsRevision: 2, failureCount: 1 };
function decision(row, elapsed, { seq = 85, source = 'manual', settings = config, history } = {}) {
  return retryReviewDecision({ row, history, seq, source, config: settings, now: finished + elapsed });
}

const cooldown = ms => ({ status: 'cooldown', retryAt: new Date(finished + ms).toISOString() });

test('transient backoff is shared by both sources and follows the configured floor', () => {
  for (const source of ['automatic', 'manual']) {
    const row = { ...failure, errorCode: 'RATE_LIMITED' };
    const history = [row, { ...row, finishedAt: new Date(finished - 30_000).toISOString() }];
    assert.deepEqual(decision(row, 59_999, { source, history }), cooldown(60_000));
    assert.equal(decision(row, 60_000, { source, history }), null);
    assert.deepEqual(decision(row, 80_000, { source, history, settings: { ...config, cooldownMs: 90_000 } }), cooldown(90_000));
  }
});

test('deterministic failures stop repeated attempts and fresh evidence can be reviewed', () => {
  const row = { ...failure, errorCode: 'reviewer_replacement_required' };
  assert.deepEqual(decision(row, 1), cooldown(300_000));
  assert.equal(decision(row, 1, { seq: 86 }), null);
  const previous = [2, 1].map(minutes => ({ ...row, finishedAt: new Date(finished - minutes * 60_000).toISOString() }));
  assert.deepEqual(retryReviewDecision({ row, history: [row, ...previous], seq: 85, source: 'manual', config, now: finished + 600_000 }),
    { status: 'retry_blocked', retryAt: new Date(finished + 58 * 60_000).toISOString() });
  assert.equal(consumesReviewEvidence(row), false);
});

test('configuration errors wait for changed settings and ambiguous writes wait for fresh evidence', () => {
  const auth = { ...failure, errorCode: 'AUTHENTICATION_FAILED' };
  assert.deepEqual(decision(auth, 900_000, { seq: 86 }), { status: 'retry_blocked' });
  assert.equal(decision(auth, 1, { settings: { ...config, revision: 3 } }), null);
  const write = { ...failure, status: 'write_unconfirmed' };
  assert.deepEqual(decision(write, 900_000), { status: 'retry_blocked' });
  assert.equal(consumesReviewEvidence(write), false);
});

test('generic submit failures back off across new evidence and share a rolling attempt cap', () => {
  const row = { ...failure, sessionId: 'review', stage: 'submit', errorCode: 'ov_request_failed' };
  const settings = { ...config, cooldownMs: 900_000 };
  const check = (elapsed, history = [row], source = 'automatic') => retryReviewDecision({
    row, history, seq: row.seq + 10, source, config: settings, now: finished + elapsed,
  });
  assert.deepEqual(check(90_100), cooldown(900_000));
  assert.equal(check(900_000), null);
  const earlier = [30, 15].map(minutes => ({ ...row, seq: row.seq - minutes,
    finishedAt: new Date(finished - minutes * 60_000).toISOString() }));
  const other = { ...row, errorCode: 'ov_http_not_found' };
  assert.deepEqual(check(900_000, [row, other, ...earlier]), {
    status: 'retry_blocked', retryAt: new Date(finished + 1_800_000).toISOString(),
  });
  assert.deepEqual(check(900_000, [row, other, ...earlier], 'manual'), {
    status: 'retry_blocked', retryAt: new Date(finished + 1_800_000).toISOString(),
  });
  assert.equal(check(1_800_000, [row, ...earlier]), null);
  assert.equal(check(900_000, [row, { ...earlier[0], sessionId: 'other' }, { ...earlier[1], settingsRevision: 1 }]), null);
});

test('new automatic evidence waits after repeatable validation errors as well', () => {
  const row = { ...failure, errorCode: 'reviewer_replacement_required' };
  const settings = { ...config, cooldownMs: 900_000 };
  assert.deepEqual(decision(row, 90_100, { seq: 86, source: 'automatic', settings }), cooldown(900_000));
});

test('new evidence does not make a forbidden request retryable', () => {
  const row = { ...failure, errorCode: 'ov_http_forbidden' };
  assert.deepEqual(decision(row, 7_200_000, { seq: 86 }), { status: 'retry_blocked' });
});

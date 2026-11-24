import assert from 'node:assert/strict';
import test from 'node:test';
import { consumesReviewEvidence, retryReviewDecision } from '../src/review-retry.js';

const finishedAt = '2026-11-24T20:00:00.000Z';
const finished = Date.parse(finishedAt);
const config = { revision: 2, cooldownMs: 0 };
const failure = { status: 'failed', seq: 85, finishedAt, settingsRevision: 2, failureCount: 1 };
function decision(row, elapsed, { seq = 85, source = 'manual', settings = config } = {}) {
  return retryReviewDecision({ row, seq, source, config: settings, now: finished + elapsed });
}

const cooldown = ms => ({ status: 'cooldown', retryAt: new Date(finished + ms).toISOString() });

test('transient backoff is shared by both sources and follows the configured floor', () => {
  for (const source of ['automatic', 'manual']) {
    const row = { ...failure, errorCode: 'RATE_LIMITED', failureCount: 2 };
    assert.deepEqual(decision(row, 59_999, { source }), cooldown(60_000));
    assert.equal(decision(row, 60_000, { source }), null);
    assert.deepEqual(decision(row, 80_000, { source, settings: { ...config, cooldownMs: 90_000 } }), cooldown(90_000));
  }
});

test('deterministic failures stop repeated attempts and fresh evidence can be reviewed', () => {
  const row = { ...failure, errorCode: 'reviewer_replacement_required' };
  assert.deepEqual(decision(row, 1), cooldown(300_000));
  assert.equal(decision(row, 1, { seq: 86 }), null);
  assert.deepEqual(decision({ ...row, failureCount: 3 }, 600_000), { status: 'retry_blocked' });
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

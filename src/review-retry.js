const NON_CONSUMING = new Set(['failed', 'timed_out', 'cancelled', 'settings_changed', 'disabled', 'review_model_unavailable', 'write_unconfirmed', 'index_unconfirmed', 'unresolved_write']);
const FAILURE_OUTCOMES = new Set(['failed', 'timed_out', 'write_unconfirmed', 'index_unconfirmed', 'unresolved_write']);
const TEMPORARY = new Set(['TimeoutError', 'RATE_LIMITED', 'STREAM_CLOSED', 'reviewer_stream_failed', 'ov_network_error', 'ov_request_timeout', 'ov_http_rate_limited', 'ov_http_server_error']);
const CONFIGURATION = new Set(['AUTHENTICATION_FAILED', 'ov_http_authentication_failed', 'llm_route_required', 'llm_stream_required', 'CONTEXT_OVERFLOW']);
const MAX_SAME_EVIDENCE_FAILURES = 3;

export const consumesReviewEvidence = row => !NON_CONSUMING.has(row.status);
export const isFailureOutcome = row => FAILURE_OUTCOMES.has(row.status);
export const applicableAttempt = (row, revision) => row && (row.settingsRevision === undefined || row.settingsRevision === revision);

export function retryReviewDecision({ row, seq, source, config, now }) {
  if (!applicableAttempt(row, config.revision)) return null;
  const finished = Date.parse(row.finishedAt ?? row.at);
  if (consumesReviewEvidence(row)) {
    if (source === 'automatic' && now - finished < config.cooldownMs) {
      return { status: 'cooldown', retryAt: new Date(finished + config.cooldownMs).toISOString() };
    }
    return null;
  }
  if (!isFailureOutcome(row)) return null;
  const sameEvidence = seq <= row.seq;
  const code = row.errorCode ?? row.reason;
  const failureCount = sameEvidence ? row.failureCount ?? 1 : 1;
  if ((sameEvidence && failureCount >= MAX_SAME_EVIDENCE_FAILURES) || CONFIGURATION.has(code) ||
      (sameEvidence && ['write_unconfirmed', 'index_unconfirmed', 'unresolved_write'].includes(row.status))) {
    return { status: 'retry_blocked' };
  }
  const temporary = TEMPORARY.has(code) || row.status === 'timed_out';
  if (!temporary && !sameEvidence) return null;
  const minimumDelay = temporary ? Math.min(120_000, 30_000 * 2 ** (failureCount - 1)) : 5 * 60_000;
  const delay = Math.max(minimumDelay, config.cooldownMs);
  const retryAt = finished + delay;
  return now < retryAt ? { status: 'cooldown', retryAt: new Date(retryAt).toISOString() } : null;
}

const NON_CONSUMING = new Set(['failed', 'timed_out', 'cancelled', 'settings_changed', 'disabled', 'review_model_unavailable', 'write_unconfirmed', 'index_unconfirmed', 'unresolved_write']);
const FAILURE_OUTCOMES = new Set(['failed', 'timed_out', 'write_unconfirmed', 'index_unconfirmed', 'unresolved_write']);
const TEMPORARY = new Set([
  'TimeoutError', 'RATE_LIMITED', 'STREAM_CLOSED', 'reviewer_stream_failed', 'ov_network_error',
  'ov_request_failed', 'ov_request_timeout', 'ov_http_request_timeout', 'ov_http_rate_limited',
  'ov_http_server_error', 'ov_http_bad_gateway', 'ov_http_service_unavailable', 'ov_http_gateway_timeout',
]);
const CONFIGURATION = new Set([
  'AUTHENTICATION_FAILED', 'ov_http_authentication_failed', 'ov_http_forbidden',
  'llm_route_required', 'llm_stream_required', 'CONTEXT_OVERFLOW',
]);
const AMBIGUOUS_WRITE = new Set(['write_unconfirmed', 'index_unconfirmed', 'unresolved_write']);
const RETRY_WINDOW_MS = 60 * 60_000;
const MAX_MATCHING_FAILURES = 3;

const finishedTime = row => Date.parse(row.finishedAt ?? row.at);
const errorCode = row => row.errorCode ?? row.reason ?? row.status;

export function matchingFailureTimes(history, row, now) {
  return history.filter(item => item.sessionId === row.sessionId && applicableAttempt(item, row.settingsRevision) &&
      isFailureOutcome(item) && errorCode(item) === errorCode(row))
    .map(finishedTime)
    .filter(time => time <= now && time > now - RETRY_WINDOW_MS)
    .sort((a, b) => b - a);
}

export const consumesReviewEvidence = row => !NON_CONSUMING.has(row.status);
export const isFailureOutcome = row => FAILURE_OUTCOMES.has(row.status);
export const applicableAttempt = (row, revision) => row && (row.settingsRevision === undefined || row.settingsRevision === revision);

export function retryReviewDecision({ row, history = [row], seq, source, config, now }) {
  if (!applicableAttempt(row, config.revision)) return null;
  const finished = finishedTime(row);
  if (consumesReviewEvidence(row)) {
    if (source === 'automatic' && now - finished < config.cooldownMs) {
      return { status: 'cooldown', retryAt: new Date(finished + config.cooldownMs).toISOString() };
    }
    return null;
  }
  if (!isFailureOutcome(row)) return null;
  const sameEvidence = seq <= row.seq;
  const code = errorCode(row);
  if (CONFIGURATION.has(code) || (sameEvidence && AMBIGUOUS_WRITE.has(row.status))) {
    return { status: 'retry_blocked' };
  }
  const failures = matchingFailureTimes(history, row, now);
  const temporary = TEMPORARY.has(code) || row.status === 'timed_out';
  const minimumDelay = temporary ? Math.min(120_000, 30_000 * 2 ** Math.max(0, failures.length - 1))
    : sameEvidence ? 5 * 60_000 : 0;
  const delay = source === 'automatic' || sameEvidence || temporary ? Math.max(minimumDelay, config.cooldownMs) : 0;
  const retryAt = finished + delay;
  if (failures.length >= MAX_MATCHING_FAILURES) {
    const available = failures[MAX_MATCHING_FAILURES - 1] + RETRY_WINDOW_MS;
    return { status: 'retry_blocked', retryAt: new Date(Math.max(retryAt, available)).toISOString() };
  }
  return now < retryAt ? { status: 'cooldown', retryAt: new Date(retryAt).toISOString() } : null;
}

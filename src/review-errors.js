// Only this registry's codes may leave an exception boundary. Literal messages
// stay in their originating modules for compatibility with existing callers.
const REVIEW_CODES = new Set([
  'reviewer_stream_failed', 'reviewer_output_not_json', 'reviewer_output_not_object',
  'reviewer_output_extra_field', 'reviewer_output_too_large', 'reviewer_output_truncated', 'reviewer_decision_invalid', 'reviewer_reason_required',
  'reviewer_evidence_required', 'reviewer_evidence_invalid', 'reviewer_proposal_invalid',
  'reviewer_proposal_required', 'reviewer_proposal_unexpected',
  'reviewer_evidence_uncommitted', 'reviewer_learning_evidence_required', 'reviewer_create_scope',
  'reviewer_stale_base', 'reviewer_operation_invalid', 'reviewer_operation_incomplete', 'reviewer_operation_extra_field',
  'reviewer_patch_base_required', 'reviewer_create_base_invalid', 'reviewer_operation_evidence_required',
  'invalid_skill_diff', 'skill_diff_base_mismatch', 'invalid_create_diff', 'invalid_create_frontmatter',
  'invalid_attachment_operations', 'invalid_attachment_operation', 'invalid_attachment_path', 'invalid_attachment_write',
  'reviewer_replacement_required', 'reviewer_replacement_invalid', 'reviewer_replacement_not_unique', 'reviewer_create_content_invalid',
  'llm_stream_required', 'session_id_required', 'llm_route_required',
  'review_source_busy', 'review_stream_log_not_directory', 'review_trace_id_invalid',
  'approval_snapshot_mismatch', 'approval_index_unconfirmed',
]);

const MESSAGE_CODES = new Map([
  ['Approval requires an absolute ledger directory, a private skill and a verified adapter', 'approval_configuration_invalid'],
  ['Invalid approval ledger', 'approval_ledger_invalid'],
  ['Incomplete skill snapshot', 'skill_snapshot_incomplete'],
  ['Invalid curator scope', 'curator_scope_invalid'],
  ['Curator state belongs to a different scope', 'curator_state_scope_mismatch'],
  ['Invalid dashboard service', 'dashboard_service_invalid'],
  ['Invalid governance scope', 'governance_scope_invalid'],
  ['Invalid private skill targets', 'governance_targets_invalid'],
  ['Invalid review settings or write mode', 'review_settings_invalid'],
  ['Invalid persisted governance state', 'governance_state_invalid'],
  ['Invalid skill attachment path', 'skill_archive_attachment_path_invalid'],
  ['Invalid skill directory path', 'skill_archive_directory_path_invalid'],
  ['Skill package exceeds supported archive limits', 'skill_archive_limits_exceeded'],
  ['Unsupported OpenViking writer endpoint', 'ov_writer_endpoint_unsupported'],
  ['Expected one canonical private skill', 'ov_private_skill_invalid'],
  ['Unexpected skill scope', 'ov_skill_scope_mismatch'],
  ['OpenViking returned an incomplete result', 'ov_result_incomplete'],
  ['Skill privacy settings are present or could not be ruled out', 'ov_skill_privacy_unverified'],
  ['Unexpected skill package', 'ov_skill_package_mismatch'],
  ['Incomplete skill package manifest', 'ov_skill_manifest_incomplete'],
  ['Invalid skill file manifest', 'ov_skill_file_manifest_invalid'],
  ['Skill package exceeds supported snapshot limits', 'ov_skill_snapshot_limits_exceeded'],
  ['Skill changed during the snapshot', 'ov_skill_snapshot_changed'],
  ['Skill Markdown differs from the manifest', 'ov_skill_markdown_mismatch'],
  ['Skill Markdown is absent from the manifest', 'ov_skill_markdown_missing'],
  ['OpenViking did not accept the temporary archive', 'ov_temp_archive_rejected'],
  ['Unexpected skill index response', 'ov_skill_index_invalid'],
  ['Skill privacy references are outside write scope', 'ov_skill_privacy_references'],
  ['Skill changed during archive upload', 'ov_skill_changed_during_upload'],
  ['invalid_maxTurns', 'review_max_turns_invalid'],
  ['invalid_maxToolCalls', 'review_max_tool_calls_invalid'],
  ['invalid_maxDurationMs', 'review_max_duration_invalid'],
  ['invalid_cooldownMs', 'review_cooldown_invalid'],
  ['invalid_maxFailures', 'review_max_failures_invalid'],
]);

const LLM_CODES = new Set(['MALFORMED_RESPONSE', 'STREAM_CLOSED', 'RATE_LIMITED', 'AUTHENTICATION_FAILED', 'CONTEXT_OVERFLOW']);
const INTERRUPTION_CODES = new Set(['TimeoutError', 'AbortError']);
const OV_HTTP_MESSAGE = /^OpenViking request failed \(([1-5]\d{2})\)$/;
const OV_CODES = ['ov_request_failed', 'ov_request_timeout', 'ov_network_error', 'ov_http_rate_limited', 'ov_http_server_error', 'ov_http_authentication_failed'];
const KNOWN_CODES = new Set([...REVIEW_CODES, ...MESSAGE_CODES.values(), ...LLM_CODES, ...INTERRUPTION_CODES, ...OV_CODES]);

export function normalizeReviewErrorCode(value) {
  if (typeof value !== 'string') return undefined;
  if (KNOWN_CODES.has(value)) return value;
  const http = OV_HTTP_MESSAGE.exec(value);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) return 'ov_http_authentication_failed';
    if (status === 429) return 'ov_http_rate_limited';
    if (status >= 500) return 'ov_http_server_error';
    return 'ov_request_failed';
  }
  return MESSAGE_CODES.get(value);
}

export function reviewStreamErrorCode(error, signal) {
  if (signal?.aborted) return signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
  if (INTERRUPTION_CODES.has(error?.name)) return error.name;
  if (LLM_CODES.has(error?.code)) return error.code;
  return normalizeReviewErrorCode(error?.message) ?? normalizeReviewErrorCode(error?.code) ?? 'unexpected_error';
}

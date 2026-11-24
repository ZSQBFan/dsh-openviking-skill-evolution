import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES = 256;
const MAX_EVENTS = 128;
const LOG_FILE = /^review-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.json$/;
const TYPES = new Set(['block-start', 'block-end', 'text', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'usage', 'finish', 'error']);
const FINISH_REASONS = new Set(['stop', 'end-turn', 'length', 'tool-use', 'tool-calls', 'content-filter', 'cancelled', 'aborted', 'error', 'context-overflow', 'completed']);
const REVIEW_ERRORS = new Set([
  'reviewer_stream_failed', 'reviewer_output_not_json', 'reviewer_output_not_object',
  'reviewer_output_extra_field', 'reviewer_decision_invalid', 'reviewer_reason_required',
  'reviewer_evidence_required', 'reviewer_evidence_invalid', 'reviewer_proposal_invalid',
  'reviewer_evidence_uncommitted', 'reviewer_learning_evidence_required', 'reviewer_create_scope',
  'reviewer_stale_base', 'reviewer_operation_invalid', 'reviewer_operation_incomplete',
  'reviewer_patch_base_required', 'reviewer_create_base_invalid', 'reviewer_operation_evidence_required',
  'invalid_skill_diff', 'skill_diff_base_mismatch', 'invalid_create_diff', 'invalid_create_frontmatter',
  'invalid_attachment_operations', 'invalid_attachment_operation', 'invalid_attachment_path', 'invalid_attachment_write',
  'reviewer_replacement_invalid', 'reviewer_replacement_not_unique', 'reviewer_create_content_invalid',
]);
const LLM_ERRORS = new Set(['MALFORMED_RESPONSE', 'STREAM_CLOSED', 'RATE_LIMITED', 'AUTHENTICATION_FAILED', 'CONTEXT_OVERFLOW']);

export function reviewStreamErrorCode(error, signal) {
  if (signal.aborted) return signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
  if (REVIEW_ERRORS.has(error?.message)) return error.message;
  if (LLM_ERRORS.has(error?.code)) return error.code;
  return 'unexpected_error';
}

export function createReviewStreamTrace() {
  const started = performance.now();
  const counts = {};
  const events = [];
  let omittedEvents = 0;
  let finish;
  return {
    onChunk(chunk) {
      const type = TYPES.has(chunk?.type) ? chunk.type : 'other';
      counts[type] = (counts[type] ?? 0) + 1;
      if (type === 'finish') finish = FINISH_REASONS.has(chunk.reason?.kind) ? chunk.reason.kind : 'other';
      if (events.length >= MAX_EVENTS) {
        omittedEvents++;
        return;
      }
      const event = { type, elapsedMs: Math.round(performance.now() - started) };
      if (Number.isSafeInteger(chunk?.index) && chunk.index >= 0) event.index = chunk.index;
      if ((type === 'text' || type === 'text-delta' || type === 'reasoning-delta') && typeof chunk.text === 'string') {
        event.bytes = Buffer.byteLength(chunk.text);
      }
      events.push(event);
    },
    snapshot: () => ({ counts, events, omittedEvents, finish }),
  };
}

export function createReviewStreamLog(directory) {
  const path = join(directory, 'review-stream');
  let pending = Promise.resolve();
  function serialize(operation) {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  }

  async function prune(limit) {
    // Only regular files with this logger's own format are cleanup targets.
    const dir = await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!dir) return;
    if (!dir.isDirectory()) throw new Error('review_stream_log_not_directory');
    const cutoff = Date.now() - RETENTION_MS;
    const files = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isFile() || !LOG_FILE.test(entry.name)) continue;
      const file = join(path, entry.name);
      const info = await lstat(file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (info?.isFile()) files.push({ file, time: info.mtimeMs });
    }
    files.sort((a, b) => b.time - a.time || a.file.localeCompare(b.file));
    for (const [index, { file, time }] of files.entries()) {
      if (time > cutoff && index < limit) continue;
      await unlink(file).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  return {
    prune: () => serialize(() => prune(MAX_FILES)),
    write: record => serialize(async () => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await prune(MAX_FILES - 1);
      const file = join(path, `review-${randomUUID()}.json`);
      await writeFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
    }),
  };
}

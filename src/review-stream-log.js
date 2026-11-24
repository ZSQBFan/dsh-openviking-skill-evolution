import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { normalizeReviewErrorCode } from './review-errors.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILES = 256;
const MAX_EVENTS = 128;
const LOG_FILE = /^review-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.json$/;
const STAGES = new Set(['stream', 'validate', 'submit']);
const INTERRUPTIBLE_STATUSES = new Set(['failed', 'cancelled', 'timed_out']);
const TYPES = new Set(['block-start', 'block-end', 'text', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'usage', 'finish', 'error']);
const FINISH_REASONS = new Set(['stop', 'end-turn', 'length', 'tool-use', 'tool-calls', 'content-filter', 'cancelled', 'aborted', 'error', 'context-overflow', 'completed']);
export { reviewStreamErrorCode } from './review-errors.js';

function traceKey(row) {
  const fields = [row?.at, row?.sessionId, row?.source];
  if (fields.every(value => typeof value === 'string' && value.length > 0)) return JSON.stringify(fields);
}

export function normalizeReviewRun(row, trace) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const next = { ...row };
  if (trace) {
    next.traceId ??= trace.traceId;
    if (STAGES.has(trace.stage)) next.stage ??= trace.stage;
  }
  const specific = normalizeReviewErrorCode(row.errorCode) ?? normalizeReviewErrorCode(row.reason) ??
    normalizeReviewErrorCode(trace?.errorCode);
  if (specific) {
    next.errorCode = specific;
    if (next.errorAttribution === 'unavailable') delete next.errorAttribution;
    if (INTERRUPTIBLE_STATUSES.has(row.status)) {
      if (specific === 'TimeoutError') next.status = 'timed_out';
      if (specific === 'AbortError') next.status = 'cancelled';
    }
  } else {
    if (next.errorCode !== 'unexpected_error') delete next.errorCode;
    if (row.reason === 'Error' || row.reason === 'unexpected_error' ||
        row.errorCode === 'unexpected_error' || row.status === 'failed') {
      next.errorAttribution = 'unavailable';
    }
  }
  return isDeepStrictEqual(row, next) ? row : next;
}

async function readTraceIndex(directory, keys) {
  const path = join(directory, 'review-stream');
  const traces = new Map();
  const dir = await lstat(path).catch(() => undefined);
  if (!dir?.isDirectory()) return traces;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const match = LOG_FILE.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    let record;
    try { record = JSON.parse(await readFile(join(path, entry.name), 'utf8')); }
    catch { continue; }
    const traceId = match[1];
    if (record?.version !== 1 || (record.traceId !== undefined && record.traceId !== traceId)) continue;
    const key = traceKey(record);
    if (!keys.has(key)) continue;
    traces.set(key, traces.has(key) ? null : { ...record, traceId });
  }
  return traces;
}

export async function backfillReviewRuns(directory, runs) {
  const keys = runs.map(traceKey);
  const uniqueKeys = new Set();
  const duplicateKeys = new Set();
  for (const key of keys) {
    if (key === undefined) continue;
    if (uniqueKeys.has(key)) duplicateKeys.add(key);
    else uniqueKeys.add(key);
  }
  for (const key of duplicateKeys) uniqueKeys.delete(key);
  const traces = uniqueKeys.size ? await readTraceIndex(directory, uniqueKeys) : new Map();
  const next = runs.map((row, index) => {
    const trace = traces.get(keys[index]);
    return normalizeReviewRun(row, trace && (row.traceId == null || row.traceId === trace.traceId) ? trace : undefined);
  });
  return next.some((row, index) => row !== runs[index]) ? next : runs;
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
      const traceId = record.traceId ?? randomUUID();
      const name = `review-${traceId}.json`;
      if (typeof traceId !== 'string' || !LOG_FILE.test(name)) throw Error('review_trace_id_invalid');
      await mkdir(path, { recursive: true, mode: 0o700 });
      await prune(MAX_FILES - 1);
      await writeFile(join(path, name), `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
    }),
  };
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createApprovalService, needsLegacyCreateVerification, saveState, verificationProgress } from './approval.js';
import { invalidReviewLimit, REVIEW_DEFAULTS } from './automatic-review.js';
import { isSkillUri } from './evidence.js';
import { createOpenVikingAdapter } from './ov-adapter.js';
import { normalizeOvRequest, reviewStreamErrorCode } from './review-errors.js';
import { backfillReviewRuns, normalizeReviewRun } from './review-stream-log.js';

const MODES = ['off', 'shadow', 'approval', 'auto'];
const MAX_HISTORY = 200;
const LEGACY_COOLDOWN_MS = 30 * 60_000;
const HEX = /^[a-f0-9]{64}$/;
const settingsDefaults = { ...REVIEW_DEFAULTS, mode: 'auto',
  correctionWords: ['技能纠正', '技能经验', 'instead', 'actually', 'correction'], provider: '', model: '' };
const SETTING_FIELDS = Object.keys(settingsDefaults);

function validSettings(input) {
  return MODES.includes(input.mode) && !invalidReviewLimit(input) &&
    Array.isArray(input.correctionWords) && input.correctionWords.length <= 30 &&
    input.correctionWords.every(word => typeof word === 'string' && word.trim() && word.length <= 60) &&
    ['provider', 'model'].every(key => typeof input[key] === 'string' && input[key].length <= 120 && !/[\r\n]/.test(input[key]));
}

export async function createGovernance({ directory, owner, writer, resolveConnection, targets = [], settings }) {
  if (!isAbsolute(directory) || (owner !== null && !/^[A-Za-z0-9_.-]+$/.test(owner ?? ''))) throw Error('Invalid governance scope');
  const initialTargets = new Set(targets);
  const belongsTo = (uri, account) => Boolean(account) && isSkillUri(uri) && uri.startsWith(`viking://user/${account}/skills/`);
  if (initialTargets.size !== targets.length || targets.some(uri => !belongsTo(uri, owner))) throw Error('Invalid private skill targets');
  const explicitConnection = writer ? { owner, writer, versions: join(directory, 'versions') } : undefined;
  const connection = async () => explicitConnection ?? await resolveConnection?.();
  const belongs = (uri, active) => belongsTo(uri, owner ?? active?.owner);
  const modes = MODES;
  const path = join(directory, 'governance.json');
  const initialSettings = { ...settingsDefaults,
    ...Object.fromEntries(SETTING_FIELDS.filter(key => Object.hasOwn(settings ?? {}, key)).map(key => [key, settings[key]])) };
  if (!validSettings(initialSettings) || !modes.includes(initialSettings.mode)) throw Error('Invalid review settings or write mode');
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { version: 1, owner, revision: 0, cooldownDefaultMigrated: true,
      settings: initialSettings, runs: [], durableRuns: [], shadows: [], hiddenProposalIds: [] };
  }
  state.settings = {
    maxDurationMs: initialSettings.maxDurationMs,
    reviewTimeoutMs: initialSettings.reviewTimeoutMs,
    ...state.settings,
  };
  if (state.version !== 1 || state.owner !== owner || !validSettings(state.settings) || !Array.isArray(state.runs) ||
      (state.durableRuns !== undefined && !Array.isArray(state.durableRuns)) ||
      (state.hiddenProposalIds !== undefined && (!Array.isArray(state.hiddenProposalIds) ||
        state.hiddenProposalIds.some(id => typeof id !== 'string')))) {
    throw Error('Invalid persisted governance state');
  }
  let changed = false;
  if (state.cooldownDefaultMigrated !== true) {
    if (state.settings.cooldownMs === LEGACY_COOLDOWN_MS && settings?.cooldownMs === undefined) {
      state.settings.cooldownMs = REVIEW_DEFAULTS.cooldownMs;
    }
    state.cooldownDefaultMigrated = true;
    changed = true;
  }
  if (!Array.isArray(state.durableRuns)) { state.durableRuns = [...state.runs]; changed = true; }
  if (!Array.isArray(state.hiddenProposalIds)) { state.hiddenProposalIds = []; changed = true; }
  const runs = await backfillReviewRuns(directory, state.runs);
  const durableRuns = await backfillReviewRuns(directory, state.durableRuns);
  if (runs !== state.runs) { state.runs = runs; changed = true; }
  if (durableRuns !== state.durableRuns) { state.durableRuns = durableRuns; changed = true; }
  if (changed) await saveState(directory, path, state);
  if (resolveConnection && state.revision === 0 && state.settings.mode === 'off') state.settings.mode = 'auto';
  const snapshotSettings = (active = explicitConnection) => {
    const mode = state.settings.mode;
    return { ...structuredClone(state.settings), revision: state.revision,
      modes: active?.writer ? modes : modes.filter(item => item !== 'approval' || item === mode),
      effectiveMode: !active?.writer && ['auto', 'approval'].includes(mode) ? 'shadow' : mode,
      writeConnection: active?.writer?.mode ?? (active?.writer ? 'configured' : 'unavailable') };
  };
  let queue = Promise.resolve();
  function mutate(operation) {
    const pending = queue.then(async () => {
      const next = structuredClone(state);
      const result = await operation(next);
      await saveState(directory, path, next);
      state = next;
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  }
  function targetBlock(uri, active) {
    if (!active?.writer) return active?.reason ?? 'draft_connection_unavailable';
    if (!belongsTo(uri, active.owner)) return 'draft_target_not_owned';
    if (initialTargets.size && !initialTargets.has(uri)) return 'draft_target_unmanaged';
  }
  function adapterFor(uri, active) {
    if (targetBlock(uri, active)) return null;
    return active.writer.adapter ?? createOpenVikingAdapter({ ...active.writer, managedUri: uri });
  }
  let wakeVerification = () => {};
  function service(uri, active) {
    const adapter = adapterFor(uri, active);
    if (!adapter) return null;
    return createApprovalService({ directory: active.versions, managedUri: uri, adapter, onVerificationDue: nextAt => wakeVerification(nextAt) });
  }
  async function records(active) {
    if (!active?.writer) return [];
    let ledger;
    try { ledger = JSON.parse(await readFile(join(active.versions, 'approvals.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (ledger.version !== 1 || !Array.isArray(ledger.records)) throw Error('Invalid approval ledger');
    return ledger.records.filter(record => !targetBlock(record.proposal.uri, active));
  }
  async function verifyDue(signal, onVerified) {
    signal?.throwIfAborted();
    const active = await connection();
    if (!active?.writer || active.current?.() === false) return Infinity;
    const due = (await records(active)).filter(record => needsLegacyCreateVerification(record) ||
      (verificationProgress(record)?.nextAt ?? Infinity) <= Date.now());
    for (const { proposal } of due) {
      signal?.throwIfAborted();
      if (active.current?.() === false) return Infinity;
      const result = await service(proposal.uri, active).verify({ id: proposal.proposalId, automatic: true,
        signal, isCurrent: active.current });
      if (result.status === 'applied' && active.current?.() !== false && !signal?.aborted) {
        await onVerified?.(proposal, active);
      }
    }
    return (await records(active)).reduce((next, record) =>
      Math.min(next, verificationProgress(record)?.nextAt ?? Infinity), Infinity);
  }
  function startVerification({ signal, onVerified, onError } = {}) {
    let timer, scheduledAt = Infinity, running = false, stopped = false, pendingAt = Infinity;
    function schedule(at) {
      if (stopped || signal?.aborted) return;
      if (running) { pendingAt = Math.min(pendingAt, at); return; }
      if (at >= scheduledAt) return;
      clearTimeout(timer);
      scheduledAt = at;
      timer = setTimeout(tick, Math.max(0, at - Date.now()));
      timer.unref?.();
    }
    async function tick() {
      if (stopped || signal?.aborted) return;
      scheduledAt = Infinity;
      running = true;
      let next = Infinity;
      try {
        next = await verifyDue(signal, onVerified);
      } catch (error) {
        if (!signal?.aborted) onError?.(error);
      } finally {
        running = false;
        const wakeAt = Math.min(next, pendingAt, Date.now() + 15_000);
        pendingAt = Infinity;
        schedule(Math.max(Date.now() + 100, wakeAt));
      }
    }
    wakeVerification = schedule;
    schedule(Date.now());
    return () => { stopped = true; clearTimeout(timer); };
  }
  function approvalResult({ status, errorCode, diagnostic }) {
    return { status, ...(diagnostic && { errorCode, diagnostic }) };
  }
  async function submit(proposal, { revision, signal, isArchived } = {}) {
    if (!HEX.test(proposal?.proposalId) || !isSkillUri(proposal?.uri)) return { status: 'no_change' };
    return mutate(async next => {
      signal?.throwIfAborted();
      const config = snapshotSettings();
      if (revision !== undefined && config.revision !== revision) return { status: 'settings_changed' };
      if (config.mode === 'off') return { status: 'disabled' };
      const active = config.mode === 'shadow' && !isArchived ? undefined : await connection();
      if (await isArchived?.(proposal.uri, active)) return { status: 'archived' };
      const draftReason = config.mode === 'shadow' ? 'draft_mode' : targetBlock(proposal.uri, active);
      if (draftReason) {
        if (!next.shadows.some(item => item.proposalId === proposal.proposalId))
          next.shadows = [...next.shadows, { ...proposal, createdAt: new Date().toISOString(), draftReason }].slice(-MAX_HISTORY);
        return { status: 'shadow', draftReason };
      }
      signal?.throwIfAborted();
      const target = service(proposal.uri, active);
      const staged = await target.stage(proposal);
      if (config.mode !== 'auto' || staged.status !== 'pending') return approvalResult(staged);
      if (active.current?.() === false) return { status: 'draft_identity_unverified' };
      const voted = await target.approve({ id: proposal.proposalId, digest: staged.approvalDigest,
        sessionId: proposal.evidence.sessionId, signal, isCurrent: active.current });
      return approvalResult(voted);
    });
  }
  return {
    settings: snapshotSettings,
    connection,
    update(input) {
      return mutate(next => {
        if (input.revision !== next.revision) return { status: 'settings_conflict' };
        const candidate = { ...next.settings, ...Object.fromEntries(SETTING_FIELDS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])) };
        if (!validSettings(candidate) || !modes.includes(candidate.mode)) return { status: 'invalid_settings' };
        next.settings = candidate;
        next.revision++;
        return { status: 'saved', revision: next.revision };
      });
    },
    submit,
    startVerification,
    async inspect(uri, signal) {
      if (snapshotSettings().mode === 'off') return { status: 'disabled' };
      const adapter = adapterFor(uri, await connection());
      if (!adapter) return { status: 'inspection_unavailable' };
      signal?.throwIfAborted();
      const snapshot = await adapter.read(uri);
      signal?.throwIfAborted();
      if (!snapshot) return { status: 'missing' };
      if (snapshot.body.length > 24000) return { status: 'body_too_large' };
      const sha = value => createHash('sha256').update(value).digest('hex');
      return { status: 'read', body: snapshot.body, baseSha256: sha(snapshot.body), files:
        Object.entries(snapshot.files).map(([path, encoded]) => {
          const bytes = Buffer.from(encoded, 'base64');
          return { path, size: bytes.length, sha256: sha(bytes) };
        }) };
    },
    log(run) {
      return mutate(next => {
        const row = normalizeReviewRun(run);
        next.runs = [...next.runs, row].slice(-MAX_HISTORY);
        next.durableRuns = [...(next.durableRuns ?? []), row].slice(-MAX_HISTORY);
      });
    },
    history: () => structuredClone(state.runs).reverse(),
    durableHistory: () => structuredClone(state.durableRuns ?? state.runs).reverse(),
    async clearHistory(input = {}) {
      if (input?.confirm !== true) return { status: 'invalid_confirm', count: 0 };
      return mutate(next => {
        const count = next.runs.length;
        next.runs = [];
        return { status: 'history_cleared', count };
      });
    },
    async clearProposals(input = {}) {
      if (input?.confirm !== true) return { status: 'invalid_confirm', count: 0 };
      return mutate(async next => {
        const all = await records(await connection());
        const official = all.map(item => item.proposal.proposalId);
        const shadow = next.shadows.map(item => item.proposalId);
        const visible = new Set([...official, ...shadow].filter(id => !next.hiddenProposalIds.includes(id)));
        next.hiddenProposalIds = [...new Set([...next.hiddenProposalIds, ...visible])];
        return { status: 'proposals_cleared', count: visible.size };
      });
    },
    async proposals(active = explicitConnection, isArchived = () => false) {
      const all = await records(active);
      const disabled = state.settings.mode === 'off';
      const hidden = new Set(state.hiddenProposalIds ?? []);
      const official = new Set(all.map(item => item.proposal.proposalId));
      const legacyTimes = new Map();
      for (const run of state.durableRuns ?? state.runs) {
        if (run.status === 'shadow' && run.proposalId && !legacyTimes.has(run.proposalId)) legacyTimes.set(run.proposalId, run.at);
      }
      const shadows = state.shadows.filter(item => !official.has(item.proposalId)).map(proposal => ({ status: 'shadow', proposal }));
      const creationTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.MIN_SAFE_INTEGER;
      return [...all, ...shadows].filter(({ proposal }) => !hidden.has(proposal.proposalId)).reverse()
        .map(record => {
          const { status, proposal, history } = record;
          const verification = verificationProgress(record);
          const draft = status === 'shadow';
          const blocked = draft && (disabled ? 'draft_reviews_disabled' : targetBlock(proposal.uri, active) ??
            (isArchived(proposal.uri) ? 'archived' : undefined));
          return { id: proposal.proposalId, uri: proposal.uri, status, summary: proposal.reason,
            sessionId: proposal.evidence.sessionId, action: proposal.action, history, ...(verification && { verification }),
            createdAt: history?.[0]?.at ?? proposal.createdAt ?? legacyTimes.get(proposal.proposalId),
            ...(draft && { draftReason: proposal.draftReason ?? 'draft_legacy', ...(blocked && { applyBlockedReason: blocked }) }),
            actions: ['preview', ...(draft && !blocked ? ['applyDraft'] : []), ...(status === 'pending' ? ['approve', 'reject'] : []),
              ...(status === 'applied' ? ['rollback'] : []), ...(['applying', 'restoring'].includes(status) ? ['verifyWrite'] : [])] };
        })
        .sort((left, right) => creationTime(right.createdAt) - creationTime(left.createdAt));
    },
    async preservedVersions(active = explicitConnection) {
      const recoverable = new Set(['applied', 'applying', 'restoring', 'write_unconfirmed', 'index_unconfirmed', 'rollback_conflict']);
      const hidden = new Set(state.hiddenProposalIds ?? []);
      return (await records(active)).filter(record => recoverable.has(record.status) && hidden.has(record.proposal.proposalId)).map(record => {
        const { proposal, history } = record;
        const verification = verificationProgress(record);
        return { id: proposal.proposalId, uri: proposal.uri, status: record.status, summary: proposal.reason,
          sessionId: proposal.evidence.sessionId, action: proposal.action, history, ...(verification && { verification }),
          createdAt: record.history?.[0]?.at ?? proposal.createdAt,
          actions: ['preview', ...(['applying', 'restoring'].includes(record.status) ? ['verifyWrite'] : []),
            ...(record.status === 'applied' ? ['rollback'] : [])] };
      });
    },
    async preview(id) {
      if (!HEX.test(id)) return { status: 'invalid_id' };
      const proposal = (await records(await connection())).find(record => record.proposal.proposalId === id)?.proposal ??
        state.shadows.find(item => item.proposalId === id);
      return proposal ? { diff: proposal.diff ?? null, operations: proposal.operations ?? [], evidence: proposal.evidence } : { status: 'missing' };
    },
    async verifyWrite(id, signal) {
      if (typeof id !== 'string' || !HEX.test(id)) return { status: 'invalid_id' };
      const active = await connection();
      const record = (await records(active)).find(item => item.proposal.proposalId === id);
      if (!record) return { status: 'missing' };
      const target = service(record.proposal.uri, active);
      const result = await target.verify({ id, signal, isCurrent: active.current });
      return { ...approvalResult(result), uri: record.proposal.uri, action: record.proposal.action };
    },
    async vote(action, id, signal) {
      if (!HEX.test(id) || !['approve', 'reject', 'rollback'].includes(action)) return { status: 'invalid_operation' };
      return mutate(async () => {
        signal?.throwIfAborted();
        const active = await connection();
        const record = (await records(active)).find(item => item.proposal.proposalId === id);
        if (!record) return { status: 'missing' };
        if ((state.hiddenProposalIds ?? []).includes(id) && ['approve', 'reject'].includes(action) && record.status === 'pending') return { status: 'proposal_cleared' };
        const { proposal, approvalDigest: digest } = record;
        const result = await service(proposal.uri, active)[action]({ id, digest, sessionId: proposal.evidence.sessionId, signal, isCurrent: active.current });
        return { ...approvalResult(result), uri: proposal.uri, action: proposal.action };
      });
    },
    async applyDraft(id, { signal, isArchived } = {}) {
      if (typeof id !== 'string' || !HEX.test(id)) return { status: 'invalid_id' };
      return mutate(async next => {
        signal?.throwIfAborted();
        if (next.hiddenProposalIds.includes(id)) return { status: 'proposal_cleared' };
        if (next.settings.mode === 'off') return { status: 'disabled' };
        const stored = next.shadows.find(item => item.proposalId === id);
        if (!stored) return { status: 'missing' };
        // These fields belong to the local card, not the signed proposal.
        const { createdAt, draftReason, ...proposal } = stored;
        const active = await connection();
        const blocked = targetBlock(proposal.uri, active);
        if (blocked) return { status: blocked };
        if (await isArchived?.(proposal.uri, active)) return { status: 'archived' };
        if (active.current?.() === false) return { status: 'draft_identity_unverified' };
        signal?.throwIfAborted();
        const target = service(proposal.uri, active);
        try {
          const staged = await target.stage(proposal);
          // Once stage has a ledger record, that record owns recovery and deduplication.
          if (!staged.approvalDigest) return approvalResult(staged);
          next.shadows = next.shadows.filter(item => item.proposalId !== id);
          if (staged.status !== 'pending' && staged.status !== 'applying') return approvalResult(staged);
          if (active.current?.() === false) return { status: 'draft_identity_unverified' };
          const result = await target.approve({ id, digest: staged.approvalDigest, sessionId: proposal.evidence.sessionId, signal, isCurrent: active.current });
          return { ...approvalResult(result), uri: proposal.uri, action: proposal.action };
        } catch (error) {
          if (signal?.aborted) throw error;
          const errorCode = reviewStreamErrorCode(error);
          const ovRequest = normalizeOvRequest(error?.ovRequest);
          return { status: 'failed', errorCode, ...(ovRequest && { ovRequest }) };
        }
      });
    },
    belongs,
  };
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createApprovalService, saveState } from './approval.js';
import { isSkillUri } from './evidence.js';
import { createOpenVikingAdapter } from './ov-adapter.js';

const MODES = ['off', 'shadow', 'approval', 'auto'];
const SETTING_FIELDS = ['mode', 'maxTurns', 'maxToolCalls', 'cooldownMs', 'maxFailures', 'correctionWords', 'provider', 'model'];
const MAX_HISTORY = 200;
const HEX = /^[a-f0-9]{64}$/;
const settingsDefaults = { mode: 'auto', maxTurns: 10, maxToolCalls: 10, cooldownMs: 1_800_000,
  maxFailures: 3, correctionWords: ['技能纠正', '技能经验', 'instead', 'actually', 'correction'], provider: '', model: '' };

function validSettings(input) {
  return MODES.includes(input.mode) && ['maxTurns', 'maxToolCalls', 'maxFailures'].every(key =>
    Number.isSafeInteger(input[key]) && input[key] >= 1 && input[key] <= 1000) &&
    Number.isSafeInteger(input.cooldownMs) && input.cooldownMs >= 0 && input.cooldownMs <= 604_800_000 &&
    Array.isArray(input.correctionWords) && input.correctionWords.length <= 30 &&
    input.correctionWords.every(word => typeof word === 'string' && word.trim() && word.length <= 60) &&
    ['provider', 'model'].every(key => typeof input[key] === 'string' && input[key].length <= 120 && !/[\r\n]/.test(input[key]));
}

export async function createGovernance({ directory, owner, writer, resolveConnection, targets = [], settings }) {
  if (!isAbsolute(directory) || (owner !== null && !/^[A-Za-z0-9_.-]+$/.test(owner ?? ''))) throw Error('Invalid governance scope');
  const initialTargets = new Set(targets);
  const belongsTo = (uri, account) => Boolean(account) && isSkillUri(uri) && uri.startsWith(`viking://user/${account}/skills/`);
  if (initialTargets.size !== targets.length || targets.some(uri => !belongsTo(uri, owner))) throw Error('Invalid private skill targets');
  const connection = () => writer ? { owner, writer, versions: join(directory, 'versions') } : resolveConnection?.();
  const belongs = uri => belongsTo(uri, owner ?? connection()?.owner);
  const modes = MODES;
  const path = join(directory, 'governance.json');
  const initialSettings = { ...settingsDefaults,
    ...Object.fromEntries(SETTING_FIELDS.filter(key => Object.hasOwn(settings ?? {}, key)).map(key => [key, settings[key]])) };
  if (!validSettings(initialSettings) || !modes.includes(initialSettings.mode)) throw Error('Invalid review settings or write mode');
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { version: 1, owner, revision: 0, settings: initialSettings, runs: [], shadows: [] };
  }
  if (state.version !== 1 || state.owner !== owner || !validSettings(state.settings)) throw Error('Invalid persisted governance state');
  if (resolveConnection && state.revision === 0 && state.settings.mode === 'off') state.settings.mode = 'auto';
  const snapshotSettings = () => {
    const active = connection();
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
  function adapterFor(uri, active) {
    if (!active?.writer || !belongsTo(uri, active.owner) || (initialTargets.size && !initialTargets.has(uri))) return null;
    return active.writer.adapter ?? createOpenVikingAdapter({ ...active.writer, managedUri: uri });
  }
  function service(uri, active = connection()) {
    const adapter = adapterFor(uri, active);
    if (!adapter) return null;
    return createApprovalService({ directory: active.versions, managedUri: uri, adapter });
  }
  async function records(active = connection()) {
    if (!active?.writer) return [];
    let ledger;
    try { ledger = JSON.parse(await readFile(join(active.versions, 'approvals.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (ledger.version !== 1 || !Array.isArray(ledger.records)) throw Error('Invalid approval ledger');
    return ledger.records.filter(record => service(record.proposal.uri, active));
  }
  async function submit(proposal, { revision, signal } = {}) {
    if (!HEX.test(proposal?.proposalId) || !isSkillUri(proposal?.uri)) return { status: 'no_change' };
    return mutate(async next => {
      signal?.throwIfAborted();
      const config = snapshotSettings();
      if (revision !== undefined && config.revision !== revision) return { status: 'settings_changed' };
      if (config.mode === 'off') return { status: 'disabled' };
      const target = config.effectiveMode === 'shadow' ? null : service(proposal.uri);
      if (!target) {
        if (!next.shadows.some(item => item.proposalId === proposal.proposalId))
          next.shadows = [...next.shadows, proposal].slice(-MAX_HISTORY);
        return { status: 'shadow' };
      }
      const staged = await target.stage(proposal);
      if (config.mode !== 'auto' || staged.status !== 'pending') return { status: staged.status };
      const voted = await target.approve({ id: proposal.proposalId, digest: staged.approvalDigest,
        sessionId: proposal.evidence.sessionId, signal });
      return { status: voted.status };
    });
  }
  return {
    settings: snapshotSettings,
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
    async inspect(uri, signal) {
      if (snapshotSettings().mode === 'off') return { status: 'disabled' };
      const adapter = adapterFor(uri, connection());
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
      return mutate(next => { next.runs = [...next.runs, run].slice(-MAX_HISTORY); });
    },
    history: () => structuredClone(state.runs).reverse(),
    async proposals() {
      const all = await records();
      const official = new Set(all.map(item => item.proposal.proposalId));
      return [...all, ...state.shadows.filter(item => !official.has(item.proposalId)).map(proposal => ({ status: 'shadow', proposal }))]
        .map(({ status, proposal, history }) => ({ id: proposal.proposalId, uri: proposal.uri, status, summary: proposal.reason,
          sessionId: proposal.evidence.sessionId, action: proposal.action, history,
          actions: ['preview', ...(status === 'pending' ? ['approve', 'reject'] : []),
            ...(status === 'applied' || status === 'restoring' ? ['rollback'] : []), ...(status === 'applying' ? ['approve'] : [])] })).reverse();
    },
    async preview(id) {
      if (!HEX.test(id)) return { status: 'invalid_id' };
      const proposal = (await records()).find(record => record.proposal.proposalId === id)?.proposal ??
        state.shadows.find(item => item.proposalId === id);
      return proposal ? { diff: proposal.diff ?? null, operations: proposal.operations ?? [], evidence: proposal.evidence } : { status: 'missing' };
    },
    async vote(action, id, signal) {
      if (!HEX.test(id) || !['approve', 'reject', 'rollback'].includes(action)) return { status: 'invalid_operation' };
      return mutate(async () => {
        signal?.throwIfAborted();
        const active = connection();
        const record = (await records(active)).find(item => item.proposal.proposalId === id);
        if (!record) return { status: 'missing' };
        const { proposal, approvalDigest: digest } = record;
        const result = await service(proposal.uri, active)[action]({ id, digest, sessionId: proposal.evidence.sessionId, signal });
        return { status: result.status, uri: proposal.uri, action: proposal.action };
      });
    },
    get canWrite() { return Boolean(connection()?.writer); },
    belongs,
  };
}

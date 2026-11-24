import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { skillManageTool } from './skill-tool.js';
import { automaticReviewProjection, buildEvidencePacket, createDshReviewAdapter, parseReviewerOutput, projectReviewPolicy, reviewerOperationToProposal } from './automatic-review.js';
import { createCurator } from './curator.js';
import { createReviewStreamLog, createReviewStreamTrace, reviewStreamErrorCode } from './review-stream-log.js';
import { applicableAttempt, consumesReviewEvidence, isFailureOutcome, retryReviewDecision } from './review-retry.js';
import { mountDashboard } from './dashboard.js';
import { isSkillUri } from './evidence.js';
import { createGovernance } from './governance.js';
import { memoryConnectionStatus, memoryLinkProjection, memoryLinkStatus } from './memory-link.js';
import { applyCreateDiff, applySkillDiff, buildCreateDiff, buildReplacementDiff, listReviewCandidates, review } from './review.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const sessionKey = session => String(session.id);
const eligible = session => session?.header?.origin !== 'subagent';
const automaticEvidence = {
  key: 'openviking-skill-evolution/automatic-evidence', stateVersion: 1,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, events: [] }),
  apply(state, event) {
    if (event.seq < state.inheritedEventCount || !/^(user\/message|assistant\/message|turn\/|tool\/|interruption|session\/interrupted|abort|error|failure)/.test(event.type)) return state;
    return { ...state, events: [...state.events, event].slice(-1024) };
  },
};

function latestRead(state, uri) {
  return state.evidence.findLast(event => event.type === 'tool/result' &&
    (event.uri === uri || event.requestedUris?.includes(uri) ||
     event.requestedUris?.includes(uri.replace(/^viking:\/\/user\/[^/]+/, 'viking://~'))));
}

function reviewBases(state) {
  const bases = [];
  let remaining = 8 * 1024 - 2;
  for (const item of state.evidence.filter(event => event.uri).slice(-8).reverse()) {
    if (latestRead(state, item.uri) !== item) continue;
    const body = item.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const base = { uri: item.uri, seq: item.seq, sha256: digest(item.body), bodyExcerpt: '', truncated: true };
    let size = Buffer.byteLength(JSON.stringify(base)) + Number(bases.length > 0) + 1;
    for (const line of body.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const lineSize = Buffer.byteLength(JSON.stringify(line)) - 2;
      if (size + lineSize > Math.min(remaining, 4096)) break;
      size += lineSize;
      base.bodyExcerpt += line;
    }
    if (!base.bodyExcerpt) continue;
    base.truncated = base.bodyExcerpt.length !== body.length;
    remaining -= size;
    bases.push(base);
  }
  return bases;
}

function compileReviewOperation(operation, state) {
  if (!operation || !isSkillUri(operation.uri)) return operation;
  if (operation.action === 'create' && (Object.hasOwn(operation, 'body') || Object.hasOwn(operation, 'description'))) {
    if (Object.hasOwn(operation, 'diff')) throw Error('reviewer_operation_invalid');
    return { ...operation, diff: buildCreateDiff(operation.uri, operation) };
  }
  if (operation.action === 'patch' && Object.hasOwn(operation, 'replacement')) {
    if (Object.hasOwn(operation, 'diff')) throw Error('reviewer_operation_invalid');
    const base = latestRead(state, operation.uri);
    if (base?.uri !== operation.uri || digest(base.body) !== operation.baseSha256) throw Error('reviewer_stale_base');
    return { ...operation, diff: buildReplacementDiff(base.body, operation.uri, operation.replacement) };
  }
  return operation;
}

function validateProposal(proposal, state, belongs) {
  if (!isSkillUri(proposal.uri) || (proposal.diff?.length ?? 0) > 24000 || proposal.reason.length > 1000) throw Error('reviewer_proposal_invalid');
  if (proposal.action === 'create') {
    if (!belongs(proposal.uri)) throw Error('reviewer_create_scope');
    applyCreateDiff(proposal.diff, proposal.uri);
    return proposal;
  }
  const latest = latestRead(state, proposal.uri);
  if (latest?.uri !== proposal.uri || digest(latest.body) !== proposal.baseSha256) throw Error('reviewer_stale_base');
  if (proposal.diff) applySkillDiff(latest.body, proposal.diff, proposal.uri);
  return proposal;
}

function bindProposal(output, packet, state, sessionId, belongs) {
  const parsed = parseReviewerOutput(output);
  const seen = new Map(packet.map(event => [event.seq, event.type]));
  if (!parsed.evidence.every(item => seen.get(item.seq) === item.kind)) throw Error('reviewer_evidence_uncommitted');
  if (parsed.decision !== 'approve') return null;
  if (!parsed.evidence.some(item => ['user/message', 'tool/result'].includes(item.kind))) throw Error('reviewer_learning_evidence_required');
  const operation = compileReviewOperation(parsed.proposal, state);
  const proposal = reviewerOperationToProposal(operation, { evidence: { sessionId, sequences: parsed.evidence.map(item => item.seq) } });
  return validateProposal(proposal, state, belongs);
}

export function resolveNativeConnection(runtime, directory) {
  const config = runtime?.config;
  if (!config || config.enabled === false || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(config.user ?? '')) return null;
  let base;
  try { base = new URL(config.baseUrl || config.endpoint); } catch { return null; }
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port)) ||
      base.pathname !== '/' || base.search || base.hash || base.username || base.password) return null;
  const nativeHeaders = {};
  if (config.apiKey) nativeHeaders.Authorization = `Bearer ${config.apiKey}`;
  if (config.sendIdentityHeaders) {
    if (config.account) nativeHeaders['X-OpenViking-Account'] = config.account;
    nativeHeaders['X-OpenViking-User'] = config.user;
  }
  if (!config.apiKey && !config.sendIdentityHeaders) return null;
  const identity = digest(JSON.stringify([base.origin, config.account ?? '', config.user]));
  return { owner: config.user, versions: join(directory, 'native', identity),
    writer: { origin: base.origin, nativeHeaders, mode: 'native-verified-readback' } };
}

export async function mountEvolution(ctx, options, evidence) {
  const resolveConnection = options.owner === null
    ? () => resolveNativeConnection(ctx.get('openvikingMemory'), options.directory) : undefined;
  const governance = await createGovernance({ ...options, resolveConnection });
  const profileCurator = await createCurator(options);
  const streamLog = createReviewStreamLog(options.directory);
  const logWarning = () => { ctx.logger?.warn('Skill evolution: review stream log unavailable'); };
  await streamLog.prune().catch(logWarning);
  const curators = new Map();
  async function getCurator() {
    const active = resolveConnection?.();
    if (!active) return profileCurator;
    if (!curators.has(active.versions)) {
      const pending = createCurator({ directory: active.versions, owner: active.owner });
      curators.set(active.versions, pending);
      pending.catch(() => curators.delete(active.versions));
    }
    return curators.get(active.versions);
  }
  const memory = await ctx.sessionProjections.register(memoryLinkProjection);
  const automatic = await ctx.sessionProjections.register(automaticEvidence);
  const agentById = new Map();
  const scope = new AbortController();
  const timers = new Set();
  let selected;
  let running;
  const seen = new Map();
  const queued = new Map();
  const attempts = new Map();
  const rememberRun = item => {
    if (consumesReviewEvidence(item)) seen.set(item.sessionId, item);
    if (isFailureOutcome(item) || consumesReviewEvidence(item) || item.status === 'review_model_unavailable') attempts.set(item.sessionId, item);
  };
  for (const item of governance.durableHistory().reverse()) rememberRun(item);

  const background = operation => {
    if (scope.signal.aborted) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      void Promise.resolve().then(operation).catch(error => ctx.logger?.warn('Skill evolution: %s', error.name));
    }, 0);
    timers.add(timer);
    timer.unref?.();
  };

  function track(agent) {
    const session = agent?.session;
    if (!session || !eligible(session)) return;
    selected = sessionKey(session);
    if (agentById.has(selected)) return;
    const id = selected;
    agentById.set(id, agent);
    agent.ctx?.effect?.(() => () => { if (agentById.get(id) === agent) agentById.delete(id); });
  }

  function policyFor(session, settings, previous) {
    return automatic.stateOf(session).events
      .filter(event => event.seq > (previous?.seq ?? -1))
      .reduce((policy, event) => automaticReviewProjection(policy, event, settings), undefined);
  }

  async function run(agent, source, requestedSignal) {
    const session = agent?.session;
    if (!session || !eligible(session)) return { status: 'no_session' };
    const sessionId = sessionKey(session);
    const config = governance.settings();
    const previous = seen.get(sessionId);
    const policy = policyFor(session, config, previous);
    const snapshot = evidence.stateOf(session);
    const seq = policy?.lastSeq ?? snapshot.evidence.at(-1)?.seq ?? -1;
    if (config.mode === 'off') return { status: 'disabled' };
    if (running) return { status: 'busy' };
    if (previous && seq <= previous.seq) return { status: 'deduped' };
    if (seq < 0) return { status: 'no_evidence' };
    if (source === 'manual' && agent.status === 'running') return { status: 'review_source_busy' };
    const lastAttempt = attempts.get(sessionId);
    const started = Date.now();
    const retry = retryReviewDecision({ row: lastAttempt, seq, source, config, now: started });
    if (retry) return retry;
    const at = new Date(started).toISOString();
    const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(config.reviewTimeoutMs), ...(requestedSignal ? [requestedSignal] : [])]);
    running = { sessionId, source, at };
    let outcome;
    let provider;
    let model;
    let trace;
    let traceId;
    let stage = 'prepare';
    let evidenceBytes;
    try {
      signal.throwIfAborted();
      const drafts = listReviewCandidates(snapshot, sessionId).candidates.filter(item => item.status === 'ready');
      let proposal = drafts.length === 1 ? review(snapshot, sessionId, drafts[0].uri) : null;
      if (!proposal?.proposalId || (previous && proposal.evidence.userSeq <= previous.seq)) proposal = null;
      if (!proposal && policy?.committedEvidence?.length) {
        const override = { provider: config.provider.trim(), model: config.model.trim() };
        const route = override.provider && override.model ? override : agent.model?.current?.();
        ({ provider, model } = route ?? {});
        const llm = ctx.get('llm');
        if (!provider || !model || !llm) {
          const unavailable = { status: 'review_model_unavailable' };
          if (lastAttempt?.status === unavailable.status && lastAttempt.seq === seq && applicableAttempt(lastAttempt, config.revision)) return unavailable;
          outcome = unavailable;
          return outcome;
        }
        if (source === 'manual') {
          const active = ctx.get('agents')?.list?.() ?? [];
          if ([...active].some(candidate => candidate.status === 'running' && candidate.model?.current?.()?.provider === provider)) {
            return { status: 'review_source_busy' };
          }
        }
        const packet = buildEvidencePacket(policy);
        if (!packet.length) {
          outcome = { status: 'no_change' };
          return outcome;
        }
        const bases = reviewBases(snapshot);
        const owner = options.owner ?? resolveConnection?.()?.owner;
        evidenceBytes = Buffer.byteLength(JSON.stringify({ events: packet, bases, owner }));
        trace = createReviewStreamTrace();
        traceId = randomUUID();
        stage = 'stream';
        const reviewer = createDshReviewAdapter({ llm, provider, model, sessionId });
        const output = await reviewer({ packet, bases, owner, signal, onChunk: trace.onChunk });
        signal.throwIfAborted();
        stage = 'validate';
        proposal = bindProposal(output, packet, snapshot, sessionId, governance.belongs);
      }
      if (proposal) stage = 'submit';
      outcome = proposal ? await submitProposal(proposal, config, signal, 'created_by_review') : { status: 'no_change' };
      if (outcome.status === 'cancelled') signal.throwIfAborted();
      return outcome;
    } catch (error) {
      const errorCode = reviewStreamErrorCode(error, signal);
      const status = errorCode === 'TimeoutError' ? 'timed_out' : errorCode === 'AbortError' ? 'cancelled' : 'failed';
      outcome = { status, reason: errorCode, errorCode, stage };
      return outcome;
    } finally {
      try {
        if (outcome) {
          const finished = Date.now();
          const durationMs = finished - started;
          const row = { ...outcome, stage, sessionId, source, seq, at, durationMs, provider, model,
            finishedAt: new Date(finished).toISOString(), settingsRevision: config.revision, traceId, evidenceBytes };
          if (isFailureOutcome(row)) {
            const sameAttempt = lastAttempt?.seq === seq && isFailureOutcome(lastAttempt) && applicableAttempt(lastAttempt, config.revision);
            row.failureCount = sameAttempt ? (lastAttempt.failureCount ?? 1) + 1 : 1;
          }
          await governance.log(row);
          rememberRun(row);
          if (trace) {
            await streamLog.write({ version: 1, traceId, at, durationMs, sessionId, source, seq, status: outcome.status,
              stage, errorCode: outcome.errorCode, evidenceBytes, ...trace.snapshot() }).catch(logWarning);
          }
        }
      } finally {
        running = undefined;
        drain();
      }
    }
  }

  function drain() {
    if (running || scope.signal.aborted || queued.size === 0) return;
    const [id] = queued.keys();
    queued.delete(id);
    background(async () => {
      try { await run(agentById.get(id), 'automatic'); }
      finally { drain(); }
    });
  }

  ctx.on('agent/created', ({ agent }) => { track(agent); });
  ctx.on('session/event', (session, event) => {
    if (!eligible(session) || scope.signal.aborted) return;
    const id = sessionKey(session);
    const settings = governance.settings();
    if (event.type === 'tool/result') background(async () => {
      const read = evidence.stateOf(session).evidence.find(item => item.seq === event.seq && item.uri);
      if (!read) return;
      const curator = await getCurator();
      if (settings.mode !== 'off' && resolveConnection?.()) await curator.adopt(read.uri, 'observed_read');
      return curator.loaded({ uri: read.uri, sessionId: id, seq: event.seq, at: Date.now() });
    });
    if (event.type === 'turn/end' && settings.mode !== 'off') {
      background(() => {
        const state = policyFor(session, settings, seen.get(id));
        const now = Date.now();
        const startedAt = state?.committedEvidence.find(event => Number.isSafeInteger(event.time) && event.time > 0)?.time ?? now;
        if (projectReviewPolicy(state, settings, now, startedAt).schedule && (queued.has(id) || queued.size < 16)) {
          queued.set(id, true);
          drain();
        }
      });
    }
  });
  ctx.on('tools/pre-execute', async (exec, next) => (await getCurator()).blocks(exec.name, exec.arguments)
    ? { kind: 'deny', reason: 'This OpenViking skill is archived in this DSH profile.' } : next());
  ctx.effect(() => {
    const interval = setInterval(() => background(async () => (await getCurator()).scan()), 60_000);
    interval.unref?.();
    return () => { scope.abort(); clearInterval(interval); for (const timer of timers) clearTimeout(timer); };
  }, 'skill-evolution-runtime');

  async function submitProposal(proposal, config, signal, source) {
    const curator = await getCurator();
    if (curator.isArchived(proposal.uri)) return { status: 'archived' };
    const result = await governance.submit(proposal, { revision: config.revision, signal });
    if (result.status === 'applied' && proposal.action === 'create') await curator.adopt(proposal.uri, source);
    return { ...result, proposalId: proposal.proposalId };
  }

  const inspected = new WeakMap();
  ctx.inject(['tools'], toolCtx => {
    toolCtx.tools.register(skillManageTool({
      async inspect(agent, uri, signal) {
        if (!agent?.session || !eligible(agent.session)) return { status: 'no_session' };
        if (!isSkillUri(uri)) return { status: 'invalid_uri' };
        const result = await governance.inspect(uri, signal);
        if (result.status === 'read') {
          const entries = inspected.get(agent.session) ?? new Map();
          const seq = automatic.stateOf(agent.session).events.at(-1)?.seq ?? -1;
          entries.delete(uri);
          entries.set(uri, { type: 'tool/result', uri, body: result.body, files: result.files, seq });
          if (entries.size > 16) entries.delete(entries.keys().next().value);
          inspected.set(agent.session, entries);
        }
        return result;
      },
      async submit(agent, input, signal) {
        const session = agent?.session;
        if (!session || !eligible(session)) return { status: 'no_session' };
        const config = governance.settings();
        if (config.mode === 'off') return { status: 'disabled' };
        const ownEvents = automatic.stateOf(session).events;
        const user = ownEvents.findLast(event => event.type === 'user/message' && event.data?.source?.kind === 'user');
        if (!user) return { status: 'no_learning_evidence' };
        const combined = AbortSignal.any([scope.signal, AbortSignal.timeout(config.reviewTimeoutMs), ...(signal ? [signal] : [])]);
        let proposal;
        try {
          const seq = ownEvents.findLast(event => event.type === 'tool/result' && event.data?.message?.isError === false)?.seq;
          const sequences = seq > user.seq ? [user.seq, seq] : [user.seq];
          const state = evidence.stateOf(session);
          const inspection = inspected.get(session)?.get(input.uri);
          const latest = inspection && { ...state, evidence: [...state.evidence, inspection].sort((a, b) => a.seq - b.seq) };
          proposal = validateProposal(reviewerOperationToProposal(input, { evidence: { sessionId: sessionKey(session), sequences, source: 'foreground' } }), latest ?? state, governance.belongs);
        } catch (error) {
          return { status: 'invalid_proposal', reason: error.message };
        }
        return submitProposal(proposal, config, combined, 'created_by_foreground');
      },
    }));
  });

  const actions = {
    async run(input, { signal }) {
      const id = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
      if (!id) return { status: 'no_session' };
      if (running) return { status: 'busy' };
      const agents = ctx.get('agents');
      const controller = ctx.get('sessionController');
      const agent = controller?.resolveAgent
        ? (await controller.resolveAgent(id)).agent
        : agents?.get(id) ?? agentById.get(id);
      signal.throwIfAborted();
      return run(agent, 'manual', signal);
    },
    settings: input => governance.update(input),
    preview: input => governance.preview(input.id),
    curator: async () => (await getCurator()).scan({ manual: true }),
    adopt: async input => (await getCurator()).adopt(input.uri),
    archive: async input => (await getCurator()).archive(input.uri),
    restore: async input => (await getCurator()).restore(input.uri),
    clearProposals: input => governance.clearProposals(input),
    clearHistory: input => governance.clearHistory(input),
  };
  for (const action of ['approve', 'reject', 'rollback']) actions[action] = async (input, { signal }) => {
    const result = await governance.vote(action, input.id, signal);
    if (action === 'approve' && result.status === 'applied' && result.action === 'create') await (await getCurator()).adopt(result.uri, 'created_by_review');
    return result;
  };
  ctx.inject(['connection'], connectionCtx => {
    mountDashboard(connectionCtx, { actions, snapshot: async ({ sessionId } = {}) => {
      const settings = governance.settings();
      const skillState = (await getCurator()).snapshot();
      const canManage = Boolean(options.owner ?? resolveConnection?.()?.owner);
      const runtime = ctx.get('openvikingMemory');
      const agent = sessionId && (ctx.get('agents')?.get(sessionId) ?? agentById.get(sessionId));
      const session = agent?.session;
      const history = governance.history();
      return { status: { state: running ? 'running' : settings.mode === 'off' ? 'disabled' : 'idle', mode: settings.mode,
        sessionId: running?.sessionId ?? selected, lastRun: history[0]?.at }, settings, history,
      proposals: await governance.proposals(), preservedVersions: await governance.preservedVersions(), ...skillState,
      memory: {
         connection: memoryConnectionStatus(runtime),
         ...(session ? memoryLinkStatus(session, memory.stateOf(session), runtime) : { state: sessionId ? 'unobserved' : 'no_session' }),
       },
      capabilities: { run: settings.mode !== 'off' && Boolean(ctx.get('sessionController')?.resolveAgent || ctx.get('agents') || agentById.size), settings: true, preview: true,
        approve: governance.canWrite, reject: governance.canWrite, rollback: governance.canWrite, curator: true,
        adopt: canManage, archive: canManage, restore: canManage, clearProposals: true, clearHistory: true } };
    } });
  });
  return { run, submit: (proposal, signal) => governance.submit(proposal, { signal }) };
}

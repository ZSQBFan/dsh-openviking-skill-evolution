import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { skillManageTool } from './skill-tool.js';
import { automaticReviewProjection, buildEvidencePacket, createDshReviewAdapter, parseReviewerOutput, projectReviewPolicy, reviewerOperationToProposal } from './automatic-review.js';
import { createCurator } from './curator.js';
import { mountDashboard } from './dashboard.js';
import { isSkillUri } from './evidence.js';
import { createGovernance } from './governance.js';
import { memoryLinkProjection, memoryLinkStatus } from './memory-link.js';
import { applyCreateDiff, applySkillDiff, listReviewCandidates, review } from './review.js';

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

function validateProposal(proposal, state, belongs) {
  if (!isSkillUri(proposal.uri) || (proposal.diff?.length ?? 0) > 24000 || proposal.reason.length > 1000) throw Error('reviewer_proposal_invalid');
  if (proposal.action === 'create') {
    if (!belongs(proposal.uri)) throw Error('reviewer_create_scope');
    applyCreateDiff(proposal.diff, proposal.uri);
    return proposal;
  }
  const latest = state.evidence.findLast(event => event.type === 'tool/result' &&
    (event.uri === proposal.uri || event.requestedUris?.includes(proposal.uri) ||
     event.requestedUris?.includes(proposal.uri.replace(/^viking:\/\/user\/[^/]+/, 'viking://~'))));
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
  const proposal = reviewerOperationToProposal(parsed.proposal, { evidence: { sessionId, sequences: parsed.evidence.map(item => item.seq) } });
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
  for (const item of governance.history().reverse()) seen.set(item.sessionId, item);

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
    if (source === 'automatic' && previous && Date.now() - Date.parse(previous.at) < config.cooldownMs) return { status: 'cooldown' };
    if (seq < 0) return { status: 'no_evidence' };
    const at = new Date().toISOString();
    const started = Date.now();
    const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(60_000), ...(requestedSignal ? [requestedSignal] : [])]);
    running = { sessionId, source, at };
    let outcome;
    let provider;
    let model;
    try {
      const drafts = listReviewCandidates(snapshot, sessionId).candidates.filter(item => item.status === 'ready');
      let proposal = drafts.length === 1 ? review(snapshot, sessionId, drafts[0].uri) : null;
      if (!proposal?.proposalId || (previous && proposal.evidence.userSeq <= previous.seq)) proposal = null;
      if (!proposal && policy?.committedEvidence?.length) {
        const sourceModel = policy.committedEvidence.findLast(event => event.type === 'assistant/message' && event.data?.message?.source?.kind === 'model')?.data.message.source;
        provider = config.provider || sourceModel?.provider || agent.provider || agent.model?.provider;
        model = config.model || sourceModel?.model || (typeof agent.model === 'string' ? agent.model : agent.model?.id);
        const llm = ctx.get('llm');
        if (!provider || !model || !llm) return { status: 'review_model_unavailable' };
        const reviewer = createDshReviewAdapter({ llm, provider, model, sessionId });
        const packet = buildEvidencePacket(policy);
        const bases = snapshot.evidence.filter(item => item.uri).slice(-8).map(item => ({ uri: item.uri, seq: item.seq, sha256: digest(item.body) }));
        const output = await reviewer({ packet, bases, owner: options.owner ?? resolveConnection?.()?.owner, signal });
        signal.throwIfAborted();
        proposal = bindProposal(output, packet, snapshot, sessionId, governance.belongs);
      }
      outcome = proposal ? await submitProposal(proposal, config, signal, 'created_by_review') : { status: 'no_change' };
      return outcome;
    } catch (error) {
      outcome = { status: signal.aborted ? 'cancelled' : 'failed', reason: signal.aborted ? signal.reason?.name : error.name };
      return outcome;
    } finally {
      try {
        if (outcome) {
          const row = { ...outcome, sessionId, source, seq, at, durationMs: Date.now() - started, provider, model };
          await governance.log(row);
          seen.set(sessionId, row);
          // The next window begins after the durably journaled sequence.
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
        if (projectReviewPolicy(state, settings).schedule && (queued.has(id) || queued.size < 16)) {
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
        const combined = AbortSignal.any([scope.signal, AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
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
    run: (input, { signal }) => run(agentById.get(input.sessionId ?? selected), 'manual', signal),
    settings: input => governance.update(input),
    preview: input => governance.preview(input.id),
    curator: async () => (await getCurator()).scan({ manual: true }),
    adopt: async input => (await getCurator()).adopt(input.uri),
    archive: async input => (await getCurator()).archive(input.uri),
    restore: async input => (await getCurator()).restore(input.uri),
  };
  for (const action of ['approve', 'reject', 'rollback']) actions[action] = async (input, { signal }) => {
    const result = await governance.vote(action, input.id, signal);
    if (action === 'approve' && result.status === 'applied' && result.action === 'create') await (await getCurator()).adopt(result.uri, 'created_by_review');
    return result;
  };
  ctx.inject(['connection'], connectionCtx => {
    mountDashboard(connectionCtx, { actions, snapshot: async () => {
      const settings = governance.settings();
      const skillState = (await getCurator()).snapshot();
      const canManage = Boolean(options.owner ?? resolveConnection?.()?.owner);
      const session = agentById.get(selected)?.session;
      const history = governance.history();
      return { status: { state: running ? 'running' : settings.mode === 'off' ? 'disabled' : 'idle', mode: settings.mode,
        sessionId: running?.sessionId ?? selected, lastRun: history[0]?.at }, settings, history,
      proposals: await governance.proposals(), ...skillState,
      memory: session ? memoryLinkStatus(session, memory.stateOf(session), ctx.get('openvikingMemory')) : { state: 'unobserved' },
      capabilities: { run: agentById.size > 0 && settings.mode !== 'off', settings: true, preview: true,
        approve: governance.canWrite, reject: governance.canWrite, rollback: governance.canWrite, curator: true,
        adopt: canManage, archive: canManage, restore: canManage } };
    } });
  });
  return { run, submit: (proposal, signal) => governance.submit(proposal, { signal }) };
}

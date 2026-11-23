const LIMIT = 64;
const MAX_TEXT = 64 * 1024;
const TOOLS = /^mcp__openviking__(find|search|list|read|multi_read)$/;
const ROOT = /^viking:\/\/(~|user\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)\/memories\/experiences$/;
const FILE = /^(viking:\/\/(?:~|user\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)\/memories\/experiences)\/((?:[^./\s?#%\\\x00-\x1f][^/\s?#%\\\x00-\x1f]*\/)*[^./\s?#%\\\x00-\x1f][^/\s?#%\\\x00-\x1f]*\.md)$/u;
const readTool = name => name === 'read' || name === 'multi_read';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const parse = value => {
  if (typeof value !== 'string') return value;
  if (value.length > MAX_TEXT) return null;
  try { return JSON.parse(value); } catch { return null; }
};
const fileRoot = uri => typeof uri === 'string' && uri.length <= 512 ? FILE.exec(uri)?.[1] : undefined;
const id = value => typeof value === 'string' && value.length <= 512 && value.length ? value : null;

function experienceCall(data, seq) {
  const tool = TOOLS.exec(data?.name)?.[1];
  if (!tool || !id(data.callId)) return null;
  const args = parse(data.arguments);
  if (!record(args)) return null;
  if (!readTool(tool)) {
    const root = tool === 'list' ? args.uri : args.target_uri;
    return typeof root === 'string' && root.length <= 512 && ROOT.test(root) ? { tool, seq, callId: data.callId, root } : null;
  }
  if (Object.hasOwn(args, 'uri') && Object.hasOwn(args, 'uris')) return null;
  if ((args.offset ?? 0) !== 0 || (args.limit ?? -1) !== -1) return null;
  const raw = args.uri ?? args.uris;
  const uris = Array.isArray(raw) ? raw : [raw];
  // A single exact read has an unambiguous body; batch results may partially fail.
  return uris.length === 1 && fileRoot(uris[0]) ? { tool, seq, callId: data.callId, uri: uris[0] } : null;
}

function canonicalRead(uri, text) {
  const header = /^=== (viking:\/\/[^\n ]+) ===\r?\n/.exec(text);
  const actual = header?.[1] ?? uri;
  if (!fileRoot(actual) || (actual !== uri && (!uri.startsWith('viking://~/') ||
    !actual.startsWith('viking://user/') || !actual.endsWith(uri.slice('viking://~'.length))))) return [];
  const body = header ? text.slice(header[0].length) : text;
  if (!body || /^(?:error\b|not_found\b|permission_denied\b|failed to read\b|\[error\])/i.test(body) ||
      /(?:\[truncated\]|\(line truncated|^=== viking:\/\/)/im.test(body)) return [];
  if (actual.startsWith('viking://~/')) return [];
  return [actual];
}

function scopedHits(root, tool, text) {
  const payload = parse(text);
  if (payload?.error || (payload?.status && payload.status !== 'ok')) return [];
  const body = payload?.result ?? payload;
  const hits = tool === 'list' ? body?.entries ?? body : body?.memories;
  if (!Array.isArray(hits)) return [];
  return [...new Set(hits.slice(0, LIMIT).flatMap(item => {
    const parent = fileRoot(item?.uri);
    return parent && item.is_dir !== true && item.isDir !== true && item.type !== 'directory' &&
      (parent === root || (root.startsWith('viking://~/') && parent.startsWith('viking://user/'))) ? [item.uri] : [];
  }))];
}

export const memoryLinkProjection = {
  key: 'openviking-skill-evolution/memory-link',
  stateVersion: 1,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, recentCalls: [], experiences: [], lastInjectedSeq: null,
    lastProfileSeq: null, lastCommitBoundarySeq: null }),
  apply(state, { seq, type, data }) {
    if (seq < state.inheritedEventCount) return state;
    if (type === 'turn/end' || type === 'compaction/start') return { ...state, lastCommitBoundarySeq: seq };
    if (type === 'user/message') {
      const source = data?.source;
      if (source?.kind === 'plugin:openviking-memory' || (source?.kind === 'plugin' && source.plugin === 'openviking-memory')) {
        if (source.form === 'recall') return { ...state, lastInjectedSeq: seq };
        if (source.form === 'instructions') return { ...state, lastProfileSeq: seq };
      }
    }
    if (type === 'tool/call') {
      const call = experienceCall(data, seq);
      if (call) return { ...state, recentCalls: [...state.recentCalls, call].slice(-LIMIT) };
    }
    if (type !== 'tool/result') return state;
    const message = data?.message;
    if (message?.source?.kind !== 'tool') return state;
    const call = state.recentCalls.find(item => item.callId === message.source.callId);
    if (!call) return state;
    const next = { ...state, recentCalls: state.recentCalls.filter(item => item.callId !== call.callId) };
    const block = Array.isArray(message.content) && message.content.length === 1 ? message.content[0] : null;
    if (message.isError !== false || data.error || block?.type !== 'text' ||
      typeof block.text !== 'string' || block.text.length > MAX_TEXT) return next;
    const text = block.text.trim();
    if (!text) return next;
    const injection = readTool(call.tool);
    const uris = injection ? canonicalRead(call.uri, text) : scopedHits(call.root, call.tool, text);
    if (!uris.length) return next;
    const items = uris.map(uri => ({ kind: injection ? 'injection' : 'recall', uri, tool: call.tool, callSeq: call.seq, resultSeq: seq }));
    return { ...next, experiences: [...state.experiences, ...items].slice(-LIMIT) };
  },
};

const enabled = (...settings) => !settings.some(value => value === false || (record(value) && value.enabled === false));

export function memoryLinkStatus(session, projected, runtime) {
  // stateFor() creates state, so only inspect an existing native entry. This is
  // a version-sensitive observation, not a second owner of the OV lifecycle.
  const dshSessionId = String(session.id);
  const entry = runtime?.states instanceof Map ? runtime.states.get(session.id) : undefined;
  const config = entry?.dshSessionId === dshSessionId && record(entry.config) && id(entry.ovSessionId) ? entry.config : null;
  const excluded = runtime?.config?.skipSubagentSessions === true && session.header?.origin === 'subagent';
  const owner = id(config?.user);
  const root = owner && `viking://user/${owner}/memories/experiences`;
  return {
    dshSessionId,
    state: !runtime ? 'unavailable' : excluded ? 'excluded' : !config ? 'unobserved' : entry.ready ? 'linked' : 'initializing',
    ovSessionId: config && !excluded ? entry.ovSessionId : null,
    peerId: config && !excluded ? id(config.peerId) : null,
    recall: {
      enabled: config && !excluded ? enabled(config.enabled, config.autoRecall, config.recall, config.syncRecall) : null,
      scope: config && !excluded ? (config.recallPeerScope === 'actor' ? 'actor' : 'all') : null,
      lastInjectedSeq: projected?.lastInjectedSeq ?? null,
      lastProfileSeq: projected?.lastProfileSeq ?? null,
    },
    capture: {
      enabled: config && !excluded ? enabled(config.enabled, config.autoCapture, config.capture, config.syncTurns) : null,
      toolResultsEnabled: config && !excluded ? config.captureToolResults === true : null,
      hasPendingWrites: config && !excluded && typeof entry.hasPendingWrites === 'boolean' ? entry.hasPendingWrites : null,
      lastCommitBoundarySeq: projected?.lastCommitBoundarySeq ?? null,
      remoteCommit: 'unverified',
    },
    experiences: root && ROOT.test(root) && !excluded
      ? (projected?.experiences ?? []).filter(item => fileRoot(item.uri) === root) : [],
  };
}

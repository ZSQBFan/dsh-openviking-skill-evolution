const READ = 'mcp__openviking__read';
const SKILL = /^viking:\/\/(?:user\/[A-Za-z0-9_.-]+|agent)\/skills\/[A-Za-z0-9_-]{1,64}\/SKILL\.md$/;
const HOME = /^viking:\/\/~\/skills\/[A-Za-z0-9_-]{1,64}\/SKILL\.md$/;
const LIMIT = 160;

export function isSkillUri(uri) {
  return typeof uri === 'string' && SKILL.test(uri);
}

export function textBlocks(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks) || !blocks.length || blocks.some(b => b.type !== 'text' || typeof b.text !== 'string')) return '';
  return blocks.map(b => b.text).join('\n');
}

export function readArguments(value) {
  try {
    const args = typeof value === 'string' ? JSON.parse(value) : value;
    if (!args || Object.keys(args).some(k => !['uri', 'uris', 'offset', 'limit'].includes(k))) return null;
    if (Object.hasOwn(args, 'uri') && (Object.hasOwn(args, 'uris') || typeof args.uri !== 'string')) return null;
    const requested = args.uri ?? args.uris;
    const uris = typeof requested === 'string' ? [requested] : requested;
    if (!Array.isArray(uris)) return null;
    const requestedUris = [...new Set(uris.filter(uri => typeof uri === 'string' && (isSkillUri(uri) || HOME.test(uri))))];
    if (!requestedUris.length) return null;
    // Batch results mark the requested skills as observed but cannot supply a patch base.
    const full = uris.length === 1 && (args.offset ?? 0) === 0 && (args.limit ?? -1) === -1;
    return { requestedUris, full };
  } catch {
    return null;
  }
}

export function skillRead(call, result) {
  const content = result.text;
  if (!call.full || !result.ok || !content || content.length > 24000) return null;
  const wrapper = /^=== (viking:\/\/[^\n ]+) ===\r?\n/.exec(content);
  const [requestedUri] = call.requestedUris;
  const uri = wrapper?.[1] ?? requestedUri;
  if (!isSkillUri(uri) || (isSkillUri(requestedUri) && uri !== requestedUri)) return null;
  if (HOME.test(requestedUri) && (!uri.startsWith('viking://user/') || !uri.endsWith(requestedUri.slice('viking://~'.length)))) return null;
  const body = wrapper ? content.slice(wrapper[0].length) : content;
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(body);
  if (!frontmatter || /^=== viking:\/\//m.test(body) || /(?:\[truncated\]|\(line truncated)/i.test(body)) return null;
  return { uri, body, frontmatter: frontmatter[0], seq: result.seq, callSeq: call.seq };
}

function compact(event) {
  const { type, data, seq } = event;
  if (type === 'tool/call' && data.name === READ) {
    const args = readArguments(data.arguments);
    if (args) return { type, seq, callId: data.callId, ...args };
  }
  if (type === 'tool/result' && data.message?.source?.kind === 'tool') {
    const msg = data.message;
    const text = msg.content?.length === 1 ? textBlocks(msg) : '';
    return { type, seq, callId: msg.source.callId, ok: msg.isError === false && !data.error,
      text: text.length <= 24000 ? text : '' };
  }
  if (type === 'user/message' && data.role === 'user' && data.source?.kind === 'user') {
    const text = textBlocks(data);
    if (text.length <= 4000 && /^(?:技能纠正|技能经验) /u.test(text)) return { type, seq, text };
  }
  if (type === 'command/run' && data.name === 'skill-refine') {
    return { type, seq, commandId: data.commandId };
  }
  if (type === 'command/done' && data.kind === 'success') {
    try {
      const id = JSON.parse(data.text)?.proposalId;
      if (typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)) return { type, seq, id, commandId: data.commandId };
    } catch { /* Other commands may return plain text. */ }
  }
  return null;
}

export const evidenceProjection = {
  key: 'openviking-skill-evolution/evidence',
  stateVersion: 2,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, calls: [], evidence: [] }),
  apply(state, event) {
    if (event.seq < state.inheritedEventCount) return state;
    const item = compact(event);
    if (!item) return state;
    if (item.type === 'command/done' && !state.evidence.some(e => e.type === 'command/run' && e.commandId === item.commandId)) return state;
    if (item.type === 'tool/call') return { ...state, calls: [...state.calls, item].slice(-LIMIT) };
    const call = item.type === 'tool/result' ? state.calls.find(c => c.callId === item.callId) : undefined;
    if (item.type === 'tool/result' && !call) return state;
    const evidence = call ? { ...item, ...skillRead(call, item), requestedUris: call.requestedUris, text: undefined } : item;
    if ('text' in evidence && evidence.text === undefined) delete evidence.text;
    return { ...state, evidence: [...state.evidence, evidence].slice(-LIMIT) };
  },
};

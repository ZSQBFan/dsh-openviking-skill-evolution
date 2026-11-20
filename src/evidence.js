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
    if (!args || Object.keys(args).some(k => !['uris', 'offset', 'limit'].includes(k))) return null;
    const uris = typeof args.uris === 'string' ? [args.uris] : args.uris;
    if (!Array.isArray(uris) || uris.length !== 1 || typeof uris[0] !== 'string') return null;
    if (!isSkillUri(uris[0]) && !HOME.test(uris[0])) return null;
    return { uri: uris[0], full: (args.offset ?? 0) === 0 && (args.limit ?? -1) === -1 };
  } catch {
    return null;
  }
}

export function skillRead(call, result) {
  const content = result.text;
  if (!call.full || !result.ok || !content || content.length > 24000) return null;
  const wrapper = /^=== (viking:\/\/[^\n ]+) ===\r?\n/.exec(content);
  const uri = wrapper?.[1] ?? call.uri;
  if (!isSkillUri(uri) || (isSkillUri(call.uri) && uri !== call.uri)) return null;
  if (HOME.test(call.uri) && (!uri.startsWith('viking://user/') || !uri.endsWith(call.uri.slice('viking://~'.length)))) return null;
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
  stateVersion: 1,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, calls: [], evidence: [] }),
  apply(state, event) {
    if (event.seq < state.inheritedEventCount) return state;
    const item = compact(event);
    if (!item) return state;
    if (item.type === 'command/done' && !state.evidence.some(e => e.type === 'command/run' && e.commandId === item.commandId)) return state;
    if (item.type === 'tool/call') return { ...state, calls: [...state.calls, item].slice(-LIMIT) };
    const call = item.type === 'tool/result' ? state.calls.find(c => c.callId === item.callId) : undefined;
    if (item.type === 'tool/result' && !call) return state;
    const evidence = call ? { ...item, ...skillRead(call, item), requestedUri: call.uri, text: undefined } : item;
    if ('text' in evidence && evidence.text === undefined) delete evidence.text;
    return { ...state, evidence: [...state.evidence, evidence].slice(-LIMIT) };
  },
};

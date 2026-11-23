import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function apply(ctx) {
  const hash = text => createHash('sha256').update(text).digest('hex');
  ctx.on('session/event', (session, { type, data, seq }) => {
    let fields;
    if (type === 'tool/call') fields = { callId: data.callId, name: data.name, arguments: data.arguments };
    if (type === 'tool/result') {
      const { source, isError, content } = data.message;
      fields = { callId: source.callId, isError, sha256: hash(content.map(block => block.text ?? '').join('\n')) };
    }
    if (type === 'command/done') fields = { kind: data.kind, text: data.text };
    if (fields) appendFileSync(process.env.SKILL_EVOLUTION_EVENTS, JSON.stringify({ sessionId: session.id, type, seq, generation: Number(process.env.SKILL_EVOLUTION_GENERATION) || 1, ...fields }) + '\n');
  });
}

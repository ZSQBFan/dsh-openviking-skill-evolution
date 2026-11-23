import { randomUUID } from 'node:crypto';
import { privateUri, sharedUri, missingUri } from './ov-fixture.mjs';

export const inject = ['llm'];
const route = 'skill-fixture';
const model = { provider: route, id: route, name: 'Skill fixture', context: { contextWindow: 65536 } };
const reads = {
  'Fixture read private': { uris: [privateUri] },
  'Fixture read shared': { uris: [sharedUri] },
  'Fixture read missing': { uris: [missingUri] },
  'Fixture read partial': { uris: [privateUri], limit: 4 },
};

async function* stream({ messages }) {
  const userIndex = messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user');
  const text = messages[userIndex]?.content?.map(part => part.text ?? '').join('');
  const realUri = process.env.SKILL_EVOLUTION_REAL_URI;
  const tool = messages.slice(userIndex + 1).find(message => message.role === 'tool');
  const realRead = realUri && text === 'Fixture use skill';
  const args = !tool && (realRead ? { uri: realUri } : Object.hasOwn(reads, text) && reads[text]);
  if (args) {
    yield { type: 'tool-call-delta', index: 0, id: `fixture-${randomUUID()}`, name: 'mcp__openviking__read', argumentsDelta: JSON.stringify(args) };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  } else {
    const skillText = tool?.content?.map(part => part.text ?? '').join('');
    const step = realRead && /^Run smoke(?: and check exit status)?\.$/m.exec(skillText ?? '')?.[0];
    yield { type: 'text-delta', index: 0, text: step ? `Skill step: ${step}` : 'Fixture response complete.' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter([route], {
    providerInfo: id => ({ id, name: 'Skill fixture' }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [model],
    resolveModel: async () => model,
    prepareCall: async () => ({ model, stream }),
  });
}

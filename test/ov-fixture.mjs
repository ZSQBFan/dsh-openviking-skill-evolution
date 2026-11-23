import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const privateUri = 'viking://user/fixture/skills/demo/SKILL.md';
export const sharedUri = 'viking://agent/skills/demo/SKILL.md';
export const body = '---\nname: demo\ndescription: Demo.\n---\n\nRun smoke.\n';
export const missingUri = 'viking://user/fixture/skills/missing/SKILL.md';
const reads = new Map();
const tool = {
  name: 'read', description: 'Read a fixture skill by canonical URI',
  inputSchema: { type: 'object', required: ['uris'], properties: {
    uris: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' },
  } },
};

function handle({ method, params }) {
  if (method === 'initialize') return { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ov-read-fixture', version: '1.0.0' } };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: [tool] };
  if (method !== 'tools/call' || params.name !== 'read') throw new Error('Fixture only exposes read');
  const { uris, limit } = params.arguments;
  const uri = uris[0];
  const key = `${uri}:${limit ?? -1}`;
  reads.set(key, (reads.get(key) ?? 0) + 1);
  const content = text => [{ type: 'text', text }];
  if (uri === missingUri || ![privateUri, sharedUri].includes(uri) || uris.length !== 1) {
    return { isError: true, content: content(`NOT_FOUND: ${uri}`) };
  }
  let skill = uri === sharedUri ? body.replace('Run smoke.', 'Run shared smoke.') : body;
  if (process.argv[3] === '--p0') skill = skill.replace('Run smoke.', 'Run smoke and report ORCHID-482.');
  else if (uri === privateUri && reads.get(key) > 1) skill += '\nFixture newer version.\n';
  if (limit > 0) skill = skill.split('\n').slice(0, limit).join('\n');
  return { content: content(skill) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    appendFileSync(process.argv[2], JSON.stringify({ method: request.method, ...(request.method === 'tools/call' ? request.params : {}) }) + '\n');
    if (!Object.hasOwn(request, 'id')) continue;
    const envelope = { jsonrpc: '2.0', id: request.id };
    try {
      envelope.result = handle(request);
    } catch (error) {
      envelope.error = { code: -32601, message: error.message };
    }
    process.stdout.write(JSON.stringify(envelope) + '\n');
  }
}

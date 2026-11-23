const string = { type: 'string' };
const nullableHash = { oneOf: [string, { type: 'null' }] };

export function skillManageTool({ inspect, submit }) {
  return {
    name: 'skill_manage',
    description: 'Save a reusable procedure learned during this task to OpenViking. Use inspect before patching an existing skill. Submit the verified Markdown correction and any reusable text files together. Returns the proposal ID and write status.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action', 'uri'],
      properties: {
        action: { enum: ['inspect', 'create', 'patch'] },
        uri: { ...string, description: 'Canonical OpenViking SKILL.md URI.' },
        baseSha256: { ...nullableHash, description: 'For patch, the SHA-256 from inspect or the complete read. For create, null.' },
        diff: { ...string, description: 'Exact unified diff, or a complete addition from /dev/null for create. Omit for attachment-only patch.' },
        reason: { ...string, description: 'Reusable lesson and how it was verified in this task.' },
        operations: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['action', 'path', 'baseSha256'],
          properties: {
            action: { enum: ['write_file', 'remove_file'] },
            path: { ...string, description: 'Relative path under references, scripts, templates, or assets.' },
            content: { ...string, description: 'Complete UTF-8 content for write_file. Omit for remove_file.' },
            baseSha256: { ...nullableHash, description: 'Use null for a new file, otherwise the SHA-256 from inspect.' },
          },
        } },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, { agent, signal }) {
      return args.action === 'inspect' ? inspect(agent, args.uri, signal) : submit(agent, args, signal);
    },
  };
}

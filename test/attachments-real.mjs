import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApprovalService } from '../src/approval.js';
import { createOpenVikingAdapter } from '../src/ov-adapter.js';

const { OV_M2_ORIGIN: origin, OV_M2_KEY: apiKey, OV_M2_URI: existingUri, OV_M2_LEDGER: directory } = process.env;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const content = '# 附件测试\r\n\r\nUTF-8 原字节\r\n';
const path = 'references/nested/steps.md';
const evidence = { sessionId: 'attachment-native-probe' };
const add = { action: 'write_file', path, content, baseSha256: null };

async function approve(service, display, read) {
  const proposalId = sha(JSON.stringify(display));
  const preview = await service.stage({ ...display, proposalId });
  assert.equal(preview.status, 'pending');
  const vote = { id: proposalId, digest: preview.approvalDigest, sessionId: evidence.sessionId };
  assert.equal((await service.approve(vote)).status, 'applied', JSON.stringify(await read()));
  return vote;
}

const connect = managedUri => createOpenVikingAdapter({ origin, apiKey, managedUri, mode: 'isolated-single-writer' });
const patchAdapter = connect(existingUri);
const readPatch = () => patchAdapter.read(existingUri);
const before = await readPatch();
const patch = createApprovalService({ directory, managedUri: existingUri, adapter: patchAdapter });
const assetPath = 'assets/blob.bin';
const remove = { action: 'remove_file', path: assetPath, baseSha256: sha(Buffer.from(before.files[assetPath], 'base64')) };
const patchVote = await approve(patch, { action: 'patch', uri: existingUri, evidence, baseSha256: sha(before.body), operations: [add, remove] }, readPatch);
const after = await readPatch();
assert.equal(after.body, before.body);
assert.equal(after.files[path], Buffer.from(content).toString('base64'));
assert.ok(!Object.hasOwn(after.files, assetPath));
assert.equal((await patch.rollback(patchVote)).status, 'rolled_back');
assert.deepEqual(await readPatch(), before);

const createdUri = existingUri.replace(/\/[^/]+\/SKILL\.md$/, '/attachments-probe/SKILL.md');
const createAdapter = connect(createdUri);
const readCreated = () => createAdapter.read(createdUri);
const create = createApprovalService({ directory, managedUri: createdUri, adapter: createAdapter });
const lines = ['---', 'name: attachments-probe', 'description: "Attachment create and rollback."', '---', '', 'Probe the exact bytes.'];
const diff = `--- /dev/null\n+++ ${createdUri}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`;
const createVote = await approve(create, { action: 'create', uri: createdUri, evidence, baseSha256: null, diff, operations: [add] }, readCreated);
assert.equal((await readCreated()).files[path], Buffer.from(content).toString('base64'));
assert.equal((await create.rollback(createVote)).status, 'rolled_back');
assert.equal(await readCreated(), null);
console.log(JSON.stringify({ event: 'attachment_lifecycle', patch: 'applied', create: 'applied', rollbacks: 2, attachmentSha256: sha(content) }));

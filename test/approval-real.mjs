import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApprovalService } from '../src/approval.js';
import { createOpenVikingAdapter } from '../src/ov-adapter.js';
import { review } from '../src/review.js';

const { OV_M2_ORIGIN: origin, OV_M2_KEY: apiKey, OV_M2_URI: managedUri, OV_M2_LEDGER: directory } = process.env;
const adapter = createOpenVikingAdapter({ origin, apiKey, managedUri, mode: 'native-verified-readback' });
const before = await adapter.read(managedUri);
assert.equal(Object.keys(before.files).length, 2);
const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(before.body)[0];
const sessionId = 'm2-real-probe';
const reviewed = review({ evidence: [
  { type: 'tool/result', uri: managedUri, body: before.body, frontmatter, seq: 3, callSeq: 2 },
  { type: 'user/message', seq: 4, text: '技能纠正 3\n原文：Run smoke.\n改为：Run smoke and check exit status.\n原因：Check the result.' },
] }, sessionId, managedUri);
assert.equal(reviewed.action, 'patch');
const { proposalId: _, ...display } = reviewed;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const added = { action: 'write_file', path: 'references/rollback-check.md', content: 'Verify rollback.\n', baseSha256: null };
const withAttachment = { ...display, operations: [added] };
const proposal = { ...withAttachment, proposalId: sha256(JSON.stringify(withAttachment)) };
const options = { directory, managedUri, adapter };
const service = createApprovalService(options);
const preview = await service.stage(proposal);
assert.equal(preview.status, 'pending');
const vote = { id: proposal.proposalId, digest: preview.approvalDigest, sessionId };
const privacy = new URL(`/api/v1/privacy-configs/skill/${encodeURIComponent(managedUri.split('/').at(-2))}`, origin);
const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
assert.equal((await fetch(privacy, { method: 'POST', headers, body: JSON.stringify({ values: { fixture: 'synthetic-p0-marker' } }) })).ok, true);
await assert.rejects(service.approve(vote), /Skill privacy settings are present/);
assert.equal((await fetch(`${privacy}/fields`, { headers })).ok, true);
assert.equal((await fetch(privacy, { method: 'DELETE', headers })).ok, true);
assert.deepEqual(await adapter.read(managedUri), before);
assert.equal((await service.approve(vote)).status, 'applied');
const applied = await adapter.read(managedUri);
assert.deepEqual(applied, {
  body: before.body.replace('Run smoke.', 'Run smoke and check exit status.'),
  files: { ...before.files, [added.path]: Buffer.from(added.content).toString('base64') },
  metadata: { ...before.metadata, directories: [...before.metadata.directories, 'references'].sort() },
});
// Reproduce a persisted snapshot whose JSON ordering differs from the live native adapter.
const ledgerPath = join(directory, 'approvals.json');
const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
const { source, directories } = ledger.records[0].after.metadata;
ledger.records[0].after.metadata = { source: Object.fromEntries(Object.entries(source).reverse()), directories };
await writeFile(ledgerPath, JSON.stringify(ledger));
const reopened = createApprovalService(options);
assert.equal((await reopened.approve(vote)).status, 'applied');

// Change real remote metadata after the restore archive is uploaded, before its PUT.
const external = { ...applied, metadata: { ...applied.metadata, source: { ...applied.metadata.source, marker: 'external' } } };
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, request) => {
  const response = await nativeFetch(url, request);
  if (url.origin === origin && url.pathname === '/api/v1/resources/temp_upload' && response.ok) {
    globalThis.fetch = nativeFetch;
    await adapter.replace(managedUri, external, applied);
  }
  return response;
};
let conflict;
try {
  conflict = await reopened.rollback(vote);
} finally {
  globalThis.fetch = nativeFetch;
}
assert.deepEqual(conflict, { status: 'rollback_conflict' });
assert.equal((await reopened.list())[0].status, 'applied');
assert.deepEqual(await adapter.read(managedUri), external);
await adapter.replace(managedUri, applied, external);

assert.equal((await reopened.rollback(vote)).status, 'rolled_back');
assert.deepEqual(await adapter.read(managedUri), before);
console.log(JSON.stringify({ event: 'approval_service', approvedSha256: sha256(applied.body), restoredSha256: sha256(before.body), attachments: Object.keys(before.files), conflict: conflict.status, restore: 'rolled_back' }));

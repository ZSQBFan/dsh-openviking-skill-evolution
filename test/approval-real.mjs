import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApprovalService } from '../src/approval.js';
import { createOpenVikingAdapter } from '../src/ov-adapter.js';
import { review } from '../src/review.js';

const { OV_M2_ORIGIN: origin, OV_M2_KEY: apiKey, OV_M2_URI: managedUri, OV_M2_LEDGER: directory } = process.env;
const adapter = createOpenVikingAdapter({ origin, apiKey, managedUri, mode: 'isolated-single-writer' });
const before = await adapter.read(managedUri);
assert.equal(Object.keys(before.files).length, 2);
const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(before.body)[0];
const sessionId = 'm2-real-probe';
const proposal = review({ evidence: [
  { type: 'tool/result', uri: managedUri, body: before.body, frontmatter, seq: 3, callSeq: 2 },
  { type: 'user/message', seq: 4, text: '技能纠正 3\n原文：Run smoke.\n改为：Run smoke and check exit status.\n原因：Check the result.' },
] }, sessionId, managedUri);
assert.equal(proposal.action, 'patch');
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
assert.deepEqual(applied, { ...before, body: before.body.replace('Run smoke.', 'Run smoke and check exit status.') });
assert.equal((await createApprovalService(options).approve(vote)).status, 'applied');
assert.equal((await service.rollback(vote)).status, 'rolled_back');
assert.deepEqual(await adapter.read(managedUri), before);
const sha256 = text => createHash('sha256').update(text).digest('hex');
console.log(JSON.stringify({ event: 'approval_service', approvedSha256: sha256(applied.body), restoredSha256: sha256(before.body), attachments: Object.keys(before.files), restore: 'rolled_back' }));

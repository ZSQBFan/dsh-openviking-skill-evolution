import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalService } from '../src/approval.js';
import { createGovernance } from '../src/governance.js';
import { review } from '../src/review.js';

const uri = 'viking://user/fixture/skills/new-skill/SKILL.md';
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'skill-governance-'));
  t.after(() => rm(directory, { recursive: true }));
  const original = { body: '---\nname: new-skill\ndescription: Old\n---\nOld step.\n', files: {}, metadata: {} };
  let live = null;
  let writes = 0;
  const service = () => createApprovalService({ directory, managedUri: uri, adapter: {
    mode: 'atomic-conditional', read: async () => structuredClone(live), verifyIndex: async () => true,
    create: async (_, next) => { assert.equal(live, null); live = next; writes++; },
    replace: async (_, next, before) => { assert.deepEqual(live, before); live = next; writes++; },
    remove: async (_, before) => { assert.deepEqual(live, before); live = null; writes++; },
  } });
  return { service, original, set: value => { live = value; }, live: () => live, writes: () => writes };
}

function proposal() {
  return review({ evidence: [{ type: 'user/message', seq: 5, text: `技能经验 ${uri}\n描述：Reusable description\n步骤：Run validation\n原因：Verified in this session` }] }, 'origin', uri);
}

function vote(staged) {
  return { id: staged.proposal.proposalId, digest: staged.approvalDigest, sessionId: 'origin' };
}

test('create is staged, audited, applied and rolled back against a verified absent package', async t => {
  const f = await fixture(t);
  const staged = await f.service().stage(proposal());
  assert.equal(staged.status, 'pending');
  assert.equal(f.writes(), 0);
  assert.equal((await f.service().list())[0].proposal.uri, uri);
  assert.equal((await f.service().approve(vote(staged))).status, 'applied');
  assert.match(f.live().body, /Run validation/);
  assert.equal((await f.service().rollback(vote(staged))).status, 'rolled_back');
  assert.equal(f.live(), null);
  assert.equal(f.writes(), 2);
});

test('a conflicting creation and a failed snapshot are distinguishable', async t => {
  const f = await fixture(t);
  const staged = await f.service().stage(proposal());
  f.set(f.original);
  assert.equal((await f.service().approve(vote(staged))).status, 'conflict');
  assert.equal(f.writes(), 0);
});

test('shadow makes no remote calls and auto applies only a current, managed proposal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-governance-mode-'));
  t.after(() => rm(directory, { recursive: true }));
  let reads = 0;
  let writes = 0;
  let live = null;
  const writer = { adapter: {
    mode: 'atomic-conditional',
    read: async () => { reads++; return structuredClone(live); },
    create: async (_, next) => { live = next; writes++; },
    replace: async () => assert.fail('unexpected replacement'),
    remove: async () => { live = null; writes++; },
    verifyIndex: async () => true,
    verifyAbsent: async () => live === null,
  } };
  const options = { directory, owner: 'fixture', targets: [uri], writer, settings: { mode: 'shadow' } };
  const governor = await createGovernance(options);
  const draft = proposal();
  assert.deepEqual(await governor.submit(draft, { revision: 0 }), { status: 'shadow' });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal((await governor.update({ revision: 0, mode: 'auto' })).status, 'saved');
  assert.equal((await governor.submit(draft, { revision: 0 })).status, 'settings_changed');
  assert.equal(writes, 0);
  assert.equal((await governor.submit(draft, { revision: 1 })).status, 'applied');
  assert.equal(writes, 1);
  const restarted = await createGovernance(options);
  assert.equal(restarted.settings().mode, 'auto');
  assert.equal((await restarted.submit(draft, { revision: 1 })).status, 'applied');
  assert.equal(writes, 1);
  assert.equal((await restarted.vote('rollback', draft.proposalId)).status, 'rolled_back');
  assert.equal(live, null);
});

test('default auto patches an existing private skill without a target list and recovers its ledger', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-governance-default-'));
  t.after(() => rm(directory, { recursive: true }));
  const original = { body: '---\nname: new-skill\n---\nOld.\n', files: { 'refs/data.bin': 'AAEC' }, metadata: {} };
  let live = original;
  const writer = { adapter: { mode: 'atomic-conditional', read: async () => structuredClone(live),
    replace: async (_, next) => { live = next; }, verifyIndex: async () => true } };
  const options = { directory, owner: 'fixture', writer };
  const governor = await createGovernance(options);
  const draft = { action: 'patch', uri, baseSha256: sha(original.body), reason: 'Verified', evidence: { sessionId: 'origin' },
    diff: `--- ${uri}\n+++ ${uri}\n@@ -4 +4 @@\n-Old.\n+New.\n` };
  const proposalId = sha(JSON.stringify(draft));
  assert.equal(governor.settings().mode, 'auto');
  assert.equal((await governor.submit({ ...draft, proposalId })).status, 'applied');
  assert.deepEqual(live, { ...original, body: original.body.replace('Old.', 'New.') });
  const restarted = await createGovernance(options);
  assert.equal((await restarted.proposals())[0].id, proposalId);
  assert.equal((await restarted.vote('rollback', proposalId)).status, 'rolled_back');
  assert.deepEqual(live, original);
});

test('reviewer patch writes only the bound body and preserves package metadata and attachments', async t => {
  const f = await fixture(t);
  f.set({ ...f.original, files: { 'refs/data.bin': 'AAEC' }, metadata: { source: 'fixture' } });
  const next = { action: 'patch', uri, baseSha256: sha(f.original.body), reason: 'Verified in this session',
    evidence: { sessionId: 'origin', sequences: [4, 5] }, diff: `--- ${uri}\n+++ ${uri}\n@@ -5 +5 @@\n-Old step.\n+New step.\n` };
  const staged = await f.service().stage({ ...next, proposalId: sha(JSON.stringify(next)) });
  assert.equal((await f.service().approve(vote(staged))).status, 'applied');
  assert.deepEqual(f.live().files, { 'refs/data.bin': 'AAEC' });
  assert.deepEqual(f.live().metadata, { source: 'fixture' });
});

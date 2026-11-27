import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalService } from '../src/approval.js';
import { projectReviewPolicy } from '../src/automatic-review.js';
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
  assert.deepEqual(await governor.submit(draft, { revision: 0 }), { status: 'shadow', draftReason: 'draft_mode' });
  assert.equal((await governor.proposals())[0].draftReason, 'draft_mode');
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

test('legacy governance settings gain millisecond defaults and persist custom duration and timeout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-governance-settings-'));
  t.after(() => rm(directory, { recursive: true }));
  const options = { directory, owner: 'fixture' };
  const path = join(directory, 'governance.json');
  await writeFile(path, JSON.stringify({ version: 1, owner: 'fixture', revision: 7, runs: [], shadows: [], settings: {
    mode: 'shadow', maxTurns: 12, maxToolCalls: 10, cooldownMs: 0, maxFailures: 3,
    correctionWords: ['correction'], provider: '', model: '',
  } }));
  const governor = await createGovernance(options);
  assert.equal(governor.settings().maxDurationMs, 1_800_000);
  assert.equal(governor.settings().reviewTimeoutMs, 300_000);
  for (const invalid of [{ maxDurationMs: 0 }, { reviewTimeoutMs: 0 }, { reviewTimeoutMs: '5000' }, { reviewTimeoutMs: 1.5 }]) {
    assert.deepEqual(await governor.update({ revision: 7, ...invalid }), { status: 'invalid_settings' });
  }
  assert.deepEqual(await governor.update({ revision: 7, maxDurationMs: 90_000, reviewTimeoutMs: 5000 }), { status: 'saved', revision: 8 });
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.settings.maxDurationMs, 90_000);
  assert.equal(persisted.settings.reviewTimeoutMs, 5000);
  const settings = (await createGovernance(options)).settings();
  assert.equal(settings.maxDurationMs, 90_000);
  assert.equal(settings.reviewTimeoutMs, 5000);
  assert.equal(settings.maxTurns, 12);
  assert.equal(settings.cooldownMs, 0);
});

test('legacy 30 minute cooldown migrates once and can still be explicitly selected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-governance-cooldown-'));
  t.after(() => rm(directory, { recursive: true }));
  const options = { directory, owner: 'fixture' };
  const path = join(directory, 'governance.json');
  await writeFile(path, JSON.stringify({ version: 1, owner: 'fixture', revision: 7, runs: [], shadows: [], settings: {
    mode: 'auto', maxTurns: 10, maxToolCalls: 10, cooldownMs: 1_800_000, maxFailures: 3,
    correctionWords: ['correction'], provider: '', model: '',
  } }));
  const governor = await createGovernance(options);
  assert.equal(governor.settings().cooldownMs, 900_000);
  assert.equal((await createGovernance(options)).settings().cooldownMs, 900_000);
  assert.equal((await governor.update({ revision: 7, cooldownMs: 1_800_000 })).status, 'saved');
  assert.equal((await createGovernance(options)).settings().cooldownMs, 1_800_000);
});

test('settings and runtime expose the same review limits and accept the same values', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-governance-contract-'));
  t.after(() => rm(directory, { recursive: true }));
  const governor = await createGovernance({ directory, owner: 'fixture' });
  const { mode, correctionWords, provider, model, revision, modes, effectiveMode, writeConnection, ...storedLimits } = governor.settings();
  const policyLimits = projectReviewPolicy(undefined).limits;
  assert.deepEqual(storedLimits, policyLimits);

  const changes = Object.fromEntries(Object.entries(policyLimits).map(([key, value]) => [key, value + 1]));
  for (const key of Object.keys(changes)) {
    const invalid = { [key]: -1 };
    assert.deepEqual(await governor.update({ revision, ...invalid }), { status: 'invalid_settings' });
    assert.throws(() => projectReviewPolicy(undefined, invalid), { message: `invalid_${key}` });
  }
  assert.equal((await governor.update({ revision, ...changes })).status, 'saved');
  const savedLimits = Object.fromEntries(Object.keys(changes).map(key => [key, governor.settings()[key]]));
  assert.deepEqual(savedLimits, projectReviewPolicy(undefined, changes).limits);
});

test('mixed official and shadow proposals are listed newest first by persisted creation time', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-governance-proposals-'));
  t.after(() => rm(directory, { recursive: true }));
  const writer = { adapter: { mode: 'atomic-conditional', read: async () => null, verifyIndex: async () => true,
    create() { assert.fail('unexpected apply'); }, replace() { assert.fail('unexpected apply'); },
    remove() { assert.fail('unexpected rollback'); } } };
  const options = { directory, owner: 'fixture', writer, settings: { mode: 'approval' } };
  const governor = await createGovernance(options);
  const { proposalId, ...original } = proposal();
  const makeProposal = reason => {
    const record = { ...original, reason };
    return { ...record, proposalId: sha(JSON.stringify(record)) };
  };
  const first = makeProposal('first');
  const second = makeProposal('second');
  const third = makeProposal('third');
  const dates = ['2026-11-20T12:00:00.000Z', '2026-11-21T12:00:00.000Z', '2026-11-22T12:00:00.000Z'];
  t.mock.timers.enable({ apis: ['Date'], now: new Date(dates[0]) });
  assert.equal((await governor.submit(first)).status, 'pending');
  await governor.update({ revision: 0, mode: 'shadow' });
  t.mock.timers.setTime(Date.parse(dates[1]));
  assert.equal((await governor.submit(second)).status, 'shadow');
  await governor.update({ revision: 1, mode: 'approval' });
  t.mock.timers.setTime(Date.parse(dates[2]));
  assert.equal((await governor.submit(third)).status, 'pending');
  assert.equal((await governor.vote('reject', first.proposalId)).status, 'rejected');
  const restarted = await createGovernance(options);
  const list = await restarted.proposals();
  assert.deepEqual(list.map(item => item.id), [third, second, first].map(item => item.proposalId));
  assert.deepEqual(list.map(item => item.createdAt), [...dates].reverse());
  assert.equal((await restarted.preview(second.proposalId)).diff, second.diff);
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


test('legacy draft gains an action after verification and keeps its original base', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-governance-draft-'));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, 'governance.json');
  const draft = proposal();
  let active = { reason: 'draft_identity_unverified' };
  let live = null;
  let writes = 0;
  const adapter = {
    mode: 'atomic-conditional', read: async () => structuredClone(live),
    create: async (_, next) => { live = next; writes++; },
    replace: async () => assert.fail('unexpected replacement'),
    remove: async () => { live = null; }, verifyIndex: async () => true,
  };
  const options = { directory, owner: null, resolveConnection: async () => active };
  let governor = await createGovernance(options);
  assert.equal((await governor.submit(draft)).draftReason, 'draft_identity_unverified');
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  delete legacy.shadows[0].draftReason;
  await writeFile(path, JSON.stringify(legacy));
  governor = await createGovernance(options);
  const blockedCard = (await governor.proposals(active))[0];
  assert.equal(blockedCard.draftReason, 'draft_legacy');
  assert.equal(blockedCard.applyBlockedReason, 'draft_identity_unverified');
  assert.equal((await governor.applyDraft(draft.proposalId)).status, 'draft_identity_unverified');
  active = { owner: 'other-user', writer: { adapter }, versions: join(directory, 'other') };
  assert.equal((await governor.applyDraft(draft.proposalId)).status, 'draft_target_not_owned');
  active = { owner: 'fixture', writer: { adapter }, versions: join(directory, 'verified') };
  assert.deepEqual((await governor.proposals(active))[0].actions, ['preview', 'applyDraft']);
  assert.equal((await governor.applyDraft(draft.proposalId, { isArchived: () => true })).status, 'archived');
  live = { body: 'An independently created skill.\n', files: {}, metadata: {} };
  assert.equal((await governor.applyDraft(draft.proposalId)).status, 'conflict');
  assert.equal((await governor.proposals(active))[0].status, 'shadow');
  assert.equal(writes, 0);
  live = null;
  const results = await Promise.all([governor.applyDraft(draft.proposalId), governor.applyDraft(draft.proposalId)]);
  assert.deepEqual(results.map(result => result.status), ['applied', 'missing']);
  assert.match(live.body, /Run validation/);
  assert.equal(writes, 1);
  const restarted = await createGovernance(options);
  assert.equal((await restarted.proposals(active))[0].status, 'applied');
});

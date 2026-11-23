import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApprovalService } from '../src/approval.js';

const uri = 'viking://user/fixture/skills/demo/SKILL.md';
const body = '---\nname: demo\n---\nRun smoke.\n';
const baseSha256 = createHash('sha256').update(body).digest('hex');
const draft = {
  action: 'patch', uri, baseSha256, reason: 'Confirm the result.',
  evidence: { sessionId: 'fixture-session', readCallSeq: 2, readResultSeq: 3, userSeq: 4 },
  diff: `--- ${uri}\n+++ ${uri}\n@@ -4 +4 @@\n-Run smoke.\n+Run smoke and check exit status.\n`,
};

draft.proposalId = createHash('sha256').update(JSON.stringify(draft)).digest('hex');

async function fixture(t, adapterOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'skill-approval-test-'));
  t.after(() => rm(directory, { recursive: true }));
  const original = { body, files: { 'references/data.bin': 'AAEC' }, metadata: { owner: 'fixture' } };
  let snapshot = structuredClone(original);
  let writes = 0;
  let failAfterWrite = false;
  let failBeforeWrite = false;
  let failIndex = false;
  const create = () => createApprovalService({
    directory, managedUri: uri,
    adapter: {
      mode: 'isolated-single-writer',
      read: async () => structuredClone(snapshot),
      replace: async (_, next, expected) => {
        assert.deepEqual(snapshot, expected);
        writes++;
        if (failBeforeWrite) throw Error('request timed out');
        snapshot = structuredClone(next);
        if (failAfterWrite) throw Error('request timed out');
      },
      verifyIndex: async (_, expected) => !failIndex && snapshot.body === expected.body,
      ...adapterOverrides,
    },
  });
  return {
    create, original,
    get snapshot() { return snapshot; }, get writes() { return writes; },
    change: next => { snapshot = next; }, timeoutAfter: () => { failAfterWrite = true; },
    timeoutBefore: () => { failBeforeWrite = true; }, failIndex: () => { failIndex = true; },
  };
}

test('explicit approval applies exactly the displayed patch and restores full snapshot', async t => {
  const f = await fixture(t);
  const s = f.create();
  const preview = await s.stage(draft);
  assert.equal(preview.status, 'pending');
  assert.equal(f.writes, 0);
  const vote = { sessionId: draft.evidence.sessionId, id: draft.proposalId, digest: preview.approvalDigest };
  assert.equal((await s.approve({ ...vote, sessionId: 'other-session' })).status, 'approval_mismatch');
  assert.equal((await s.approve({ ...vote, digest: 'wrong' })).status, 'approval_mismatch');
  assert.equal((await s.approve(vote)).status, 'applied');
  assert.deepEqual(f.snapshot, { ...f.original, body: body.replace('Run smoke.', 'Run smoke and check exit status.') });
  assert.equal((await f.create().approve(vote)).status, 'applied');
  assert.equal(f.writes, 1);
  assert.equal((await s.rollback(vote)).status, 'rolled_back');
  assert.deepEqual(f.snapshot, f.original);
  assert.equal((await s.rollback(vote)).status, 'rolled_back');
  assert.equal(f.writes, 2);
});

async function stage(f) {
  const service = f.create();
  const { approvalDigest } = await service.stage(draft);
  return [service, { sessionId: draft.evidence.sessionId, id: draft.proposalId, digest: approvalDigest }];
}

test('cancellation during preflight or queue wait does not mutate the skill', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { preflight: async () => { entered.resolve(); await release.promise; } });
  const [s, vote] = await stage(f);
  const one = new AbortController();
  const two = new AbortController();
  const first = s.approve({ ...vote, signal: one.signal });
  await entered.promise;
  const second = s.approve({ ...vote, signal: two.signal });
  const checked = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
  one.abort();
  two.abort();
  release.resolve();
  await checked;
  assert.equal(f.writes, 0);
  assert.equal((await s.approve(vote)).status, 'applied');
});

test('reject persists and prevents later application', async t => {
  const f = await fixture(t);
  const [s, vote] = await stage(f);
  assert.equal((await s.reject(vote)).status, 'rejected');
  assert.equal((await f.create().approve(vote)).status, 'rejected');
  assert.equal(f.writes, 0);
});

test('unknown live version and a post-preview body change both block the write', async t => {
  const f = await fixture(t);
  const changed = { ...f.original, body: `${body}\nAnother edit.\n` };
  f.change(changed);
  assert.deepEqual(await f.create().stage(draft), { status: 'conflict' });
  f.change(f.original);
  const [s, vote] = await stage(f);
  f.change(changed);
  assert.equal((await s.approve(vote)).status, 'conflict');
  assert.equal(f.writes, 0);
});

test('attachment changes after approval preview conflict even with the same body', async t => {
  const f = await fixture(t);
  const [s, vote] = await stage(f);
  f.change({ ...f.original, files: { 'references/data.bin': 'AAAA' } });
  assert.equal((await s.approve(vote)).status, 'conflict');
  assert.equal(f.writes, 0);
});

test('response loss after commit is confirmed without repeating the write', async t => {
  const f = await fixture(t);
  const [s, vote] = await stage(f);
  f.timeoutAfter();
  const votes = await Promise.all([s.approve(vote), f.create().approve(vote)]);
  assert.deepEqual(votes.map(result => result.status), ['applied', 'applied']);
  assert.equal(f.writes, 1);
});

test('uncertain write survives restart and is never blindly retried', async t => {
  const f = await fixture(t);
  const [s, vote] = await stage(f);
  f.timeoutBefore();
  assert.equal((await s.approve(vote)).status, 'write_unconfirmed');
  assert.equal((await f.create().approve(vote)).status, 'write_unconfirmed');
  assert.equal(f.writes, 1);
});

test('changing metadata after application prevents rollback', async t => {
  const f = await fixture(t);
  const [s, vote] = await stage(f);
  assert.equal((await s.approve(vote)).status, 'applied');
  f.change({ ...f.snapshot, metadata: { owner: 'fixture', tag: 'later' } });
  assert.equal((await s.rollback(vote)).status, 'rollback_conflict');
  assert.equal(f.writes, 1);
});

test('an unverified index is reported without repeating the write', async t => {
  const f = await fixture(t);
  const [s, vote] = await stage(f);
  f.failIndex();
  assert.equal((await s.approve(vote)).status, 'index_unconfirmed');
  assert.equal((await f.create().approve(vote)).status, 'index_unconfirmed');
  assert.equal(f.writes, 1);
});

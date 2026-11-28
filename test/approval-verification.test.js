import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApprovalService } from '../src/approval.js';
import { createGovernance } from '../src/governance.js';
import { createOpenVikingAdapter } from '../src/ov-adapter.js';
import { review } from '../src/review.js';

const uri = 'viking://user/fixture/skills/demo/SKILL.md';
const body = '---\nname: demo\n---\nOld.\n';
const initial = { body, files: {}, metadata: {} };
const hash = value => createHash('sha256').update(value).digest('hex');
const patch = { action: 'patch', uri, baseSha256: hash(body), reason: 'Verified', evidence: { sessionId: 'fixture' },
  diff: `--- ${uri}\n+++ ${uri}\n@@ -4 +4 @@\n-Old.\n+New.\n` };
patch.proposalId = hash(JSON.stringify(patch));
const create = review({ evidence: [{ type: 'user/message', seq: 5,
  text: `技能经验 ${uri}\n描述：Reusable description\n步骤：Run validation\n原因：Verified in this session` }] }, 'fixture', uri);
const conflict409 = () => Object.assign(Error('OpenViking request failed (409)'), {
  ovRequest: { status: 409, operation: 'skill_detail' },
});

async function fixture(t, start = initial) {
  const directory = await mkdtemp(join(tmpdir(), 'skill-verification-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = { live: start, writes: [], reads: 0, indexes: [] };
  const adapter = { mode: 'isolated-single-writer',
    async read() { f.reads++; return structuredClone(f.read ? f.read() : f.live); },
    async replace(_, value) { f.writes.push('replace'); f.live = value; },
    async create(_, value) { f.writes.push('create'); return f.create ? f.create(value) : void (f.live = value); },
    async remove() { f.writes.push('remove'); return f.remove ? f.remove() : void (f.live = null); },
    matchesCreated: (...args) => f.matchesCreated?.(...args),
    async verifyIndex(_, value) { f.indexes.push(value); return true; },
    async verifyAbsent() { f.indexes.push(null); return true; },
  };
  f.service = () => createApprovalService({ directory: join(directory, 'versions'), managedUri: uri, adapter });
  f.governance = () => createGovernance({ directory, owner: 'fixture', writer: { adapter } });
  f.ledger = join(directory, 'versions', 'approvals.json');
  f.record = async () => JSON.parse(await readFile(f.ledger, 'utf8')).records[0];
  return f;
}

async function stage(service, proposal) {
  const result = await service.stage(proposal);
  assert.equal(result.status, 'pending');
  return { id: proposal.proposalId, digest: result.approvalDigest, sessionId: proposal.evidence.sessionId };
}

test('409 readback follows four durable deadlines and manual verify never reopens the automatic budget', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const f = await fixture(t);
  const s = f.service();
  const vote = await stage(s, patch);
  f.read = () => { if (f.writes.length) throw conflict409(); return f.live; };
  const result = await s.approve(vote);
  assert.equal(result.status, 'write_unconfirmed');
  assert.deepEqual(result.diagnostic.ovRequest, { status: 409, operation: 'skill_detail' });
  const afterInitial = f.reads;
  for (const [index, offset] of [2_000, 5_000, 15_000, 30_000].entries()) {
    assert.equal((await f.record()).verification.nextAt, 100_000 + offset);
    t.mock.timers.setTime(100_000 + offset - 1);
    await f.service().verify({ id: vote.id, automatic: true });
    assert.equal(f.reads, afterInitial + index);
    t.mock.timers.setTime(100_000 + offset);
    assert.equal((await f.service().verify({ id: vote.id, automatic: true })).status, 'write_unconfirmed');
  }
  const exhausted = await f.record();
  assert.deepEqual(exhausted.verification, { attempts: 4, nextAt: null });
  assert.equal(exhausted.history.filter(event => event.status === 'write_unconfirmed').length, 1);
  t.mock.timers.setTime(200_000);
  await f.service().verify({ id: vote.id, automatic: true });
  assert.equal(f.reads, afterInitial + 4);
  assert.equal((await f.service().verify({ id: vote.id })).status, 'write_unconfirmed');
  assert.deepEqual((await f.record()).verification, exhausted.verification);
  assert.deepEqual(f.writes, ['replace']);
});

test('create timeout resumes after reopening, accepts the matched server snapshot, and checks its index', async t => {
  const f = await fixture(t, null);
  const governor = await f.governance();
  let expected;
  f.create = value => { expected = value; throw Error('ov_request_timeout'); };
  assert.equal((await governor.submit(create)).errorCode, 'ov_request_timeout');
  const [{ verification, actions }] = await governor.proposals();
  assert.equal(verification.attempts, 0);
  assert.deepEqual(actions, ['preview', 'verifyWrite']);
  const canonical = { ...expected, body: expected.body.replace('"Reusable description"', 'Reusable description').trimEnd(),
    metadata: { ...expected.metadata, source: { type: 'skill_evolution', skill_name: 'demo', tracked: true,
      metadata_uri: uri.replace('SKILL.md', '.source.json') } } };
  f.matchesCreated = createOpenVikingAdapter({ origin: 'http://127.0.0.1:1234', mode: 'isolated-single-writer', managedUri: uri }).matchesCreated;
  f.live = { ...canonical, files: { 'unexpected.txt': 'eA==' } };
  assert.equal((await governor.verifyWrite(create.proposalId)).status, 'write_unconfirmed');
  assert.deepEqual(f.indexes, []);
  f.live = canonical;
  const reopened = await f.governance();
  const verified = Promise.withResolvers();
  const stop = reopened.startVerification({ onVerified: (proposal, active) => verified.resolve({ proposal, owner: active.owner }),
    onError: verified.reject });
  t.after(stop);
  const keepAlive = new AbortController();
  try {
    const done = await Promise.race([verified.promise, delay(6_000, undefined, { signal: keepAlive.signal }).then(() => assert.fail('background verification did not resume'))]);
    assert.equal(done.proposal.proposalId, create.proposalId);
    assert.equal(done.owner, 'fixture');
  } finally {
    keepAlive.abort();
    stop();
  }
  const record = await f.record();
  assert.equal(record.status, 'applied');
  assert.deepEqual(record.after, canonical);
  assert.equal(record.verification, undefined);
  assert.deepEqual(f.indexes, [canonical]);
  assert.deepEqual(f.writes, ['create']);
});

test('manual verification accepts the folded description of a cleared legacy create', async t => {
  const f = await fixture(t, null);
  const s = f.service();
  const vote = await stage(s, create);
  let proposed;
  f.create = value => { proposed = value; throw Error('ov_request_timeout'); };
  assert.equal((await s.approve(vote)).status, 'write_unconfirmed');
  const governor = await f.governance();
  assert.equal((await governor.clearProposals({ confirm: true })).count, 1);
  assert.deepEqual(await governor.proposals(), []);
  f.matchesCreated = createOpenVikingAdapter({ origin: 'http://127.0.0.1:1234', mode: 'native-verified-readback', managedUri: uri }).matchesCreated;
  const canonical = {
    ...proposed,
    body: proposed.body.replace('description: "Reusable description"', 'description: Reusable\n  description').trimEnd(),
    metadata: { ...proposed.metadata, source: { type: 'skill_evolution', skill_name: 'demo', tracked: true,
      metadata_uri: uri.replace('SKILL.md', '.source.json') } },
  };
  for (const [from, to] of [
    ['  description', '  different description'],
    ['  description', '\n  description'],
    ['  description', 'tags: extra'],
    ['  description', '  description # inline comment'],
    ['Run validation', 'Run different validation'],
  ]) {
    f.live = { ...canonical, body: canonical.body.replace(from, to) };
    assert.equal((await governor.verifyWrite(vote.id)).status, 'write_unconfirmed');
  }
  f.live = canonical;
  assert.equal((await governor.verifyWrite(vote.id)).status, 'applied');
  assert.deepEqual((await f.record()).after, canonical);
  assert.deepEqual((await governor.preservedVersions())[0].actions, ['preview', 'rollback']);
  assert.deepEqual(f.writes, ['create']);
});

test('starting the worker rechecks an unresolved create recorded before scheduling existed', async t => {
  const f = await fixture(t, null);
  const s = f.service();
  const vote = await stage(s, create);
  let proposed;
  f.create = value => { proposed = value; throw Error('ov_request_timeout'); };
  assert.equal((await s.approve(vote)).status, 'write_unconfirmed');
  const legacy = await f.record();
  delete legacy.verification;
  await writeFile(f.ledger, JSON.stringify({ version: 1, records: [legacy] }));
  const governor = await f.governance();
  await governor.clearProposals({ confirm: true });
  f.live = proposed;
  const verified = Promise.withResolvers();
  const stop = governor.startVerification({ onVerified: verified.resolve, onError: verified.reject });
  const keepAlive = new AbortController();
  try {
    const proposal = await Promise.race([verified.promise, delay(600, undefined, { signal: keepAlive.signal })
      .then(() => assert.fail('legacy create was not rechecked'))]);
    assert.equal(proposal.proposalId, vote.id);
  } finally {
    keepAlive.abort();
    stop();
  }
  assert.equal((await f.record()).status, 'applied');
  assert.deepEqual(f.writes, ['create']);
});

test('manual verify never dispatches a pending proposal or a completed rollback', async t => {
  const f = await fixture(t, null);
  const s = f.service();
  const vote = await stage(s, create);
  const governor = await f.governance();
  assert.equal((await governor.verifyWrite(vote.id)).status, 'pending');
  assert.deepEqual(f.writes, []);
  assert.equal((await s.approve(vote)).status, 'applied');
  f.remove = () => { throw Error('ov_request_timeout'); };
  assert.equal((await s.rollback(vote)).status, 'write_unconfirmed');
  assert.equal((await governor.clearProposals({ confirm: true })).count, 1);
  assert.deepEqual((await governor.preservedVersions())[0].actions, ['preview', 'verifyWrite']);
  assert.equal((await governor.verifyWrite(vote.id)).status, 'write_unconfirmed');
  f.live = null;
  assert.equal((await governor.verifyWrite(vote.id)).status, 'rolled_back');
  assert.equal((await governor.verifyWrite(vote.id)).status, 'rolled_back');
  assert.deepEqual(f.writes, ['create', 'remove']);
});

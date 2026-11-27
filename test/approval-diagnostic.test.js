import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGovernance } from '../src/governance.js';

const owner = 'fixture';
const uri = `viking://user/${owner}/skills/demo/SKILL.md`;
const body = '---\nname: demo\n---\nRun smoke.\n';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const proposal = { action: 'patch', uri, baseSha256: sha256(body), reason: 'Confirm the result.',
  evidence: { sessionId: 's1' },
  diff: `--- ${uri}\n+++ ${uri}\n@@ -4 +4 @@\n-Run smoke.\n+Run smoke and check exit status.\n` };
proposal.proposalId = sha256(JSON.stringify(proposal));

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'approval-diagnostic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let live = { body, files: {}, metadata: {} };
  let writes = 0;
  const adapter = {
    mode: 'isolated-single-writer',
    read: async () => overrides.read ? overrides.read(live, writes) : live,
    replace: async (_, next) => {
      writes++;
      if (overrides.replace) return overrides.replace(next, value => { live = value; });
      live = next;
    },
    verifyIndex: async () => overrides.verifyIndex ? overrides.verifyIndex() : true,
  };
  const create = settings => createGovernance({ directory, owner, writer: { adapter }, settings });
  const history = async () => JSON.parse(await readFile(join(directory, 'versions', 'approvals.json'), 'utf8')).records[0];
  return { create, history, get writes() { return writes; } };
}

const diagnosis = (stage, errorCode) => ({ errorCode, diagnostic: { stage, errorCode } });
const voted = (status, diagnosis) => ({ status, uri, action: 'patch', ...diagnosis });

test('known dispatch failures survive re-open while write remains unconfirmed', async t => {
  const ovRequest = { status: 503, operation: 'skill_replace' };
  const f = await fixture(t, { replace: () => {
    throw Object.assign(Error('OpenViking request failed (503)'), { ovRequest: { ...ovRequest, body: 'private body' } });
  } });
  const first = await f.create();
  const info = diagnosis('dispatch', 'ov_http_service_unavailable');
  info.diagnostic.ovRequest = ovRequest;
  assert.deepEqual(await first.submit(proposal), { status: 'write_unconfirmed', ...info });
  const reopened = await f.create();
  assert.deepEqual(await reopened.vote('approve', proposal.proposalId), voted('write_unconfirmed', info));
  assert.deepEqual(await reopened.submit(proposal), { status: 'applying', ...info });
  assert.equal(f.writes, 1);
  const record = await f.history();
  assert.equal(record.status, 'applying');
  assert.equal(record.history.filter(event => event.status === 'write_unconfirmed').length, 1);
  assert.deepEqual(record.history.at(-1).diagnostic, info.diagnostic);
});

test('readback and index diagnostics classify known errors and omit private exception messages', async t => {
  const readback = await fixture(t, { read: (live, writes) => writes ? { body: live.body } : live });
  assert.deepEqual(await (await readback.create()).submit(proposal), {
    status: 'write_unconfirmed', ...diagnosis('readback', 'skill_snapshot_incomplete'),
  });
  const index = await fixture(t, { verifyIndex: () => { throw Error('private adapter payload'); } });
  assert.deepEqual(await (await index.create()).submit(proposal), {
    status: 'index_unconfirmed', ...diagnosis('index', 'unexpected_error'),
  });
  assert.doesNotMatch(JSON.stringify(await index.history()), /private adapter payload/);
});

test('successful reconciliation remains terminal after an ambiguous dispatch response', async t => {
  const f = await fixture(t, { replace: (next, commit) => { commit(next); throw Error('OpenViking request failed (503)'); } });
  assert.deepEqual(await (await f.create()).submit(proposal), { status: 'applied' });
  assert.deepEqual(await (await f.create()).vote('approve', proposal.proposalId), voted('applied'));
  assert.equal(f.writes, 1);
});

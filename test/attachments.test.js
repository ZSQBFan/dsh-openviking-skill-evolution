import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApprovalService } from '../src/approval.js';
import { validateAttachmentOperations } from '../src/attachments.js';
import { createOpenVikingAdapter } from '../src/ov-adapter.js';

const uri = 'viking://user/fixture/skills/demo/SKILL.md';
const sha = value => createHash('sha256').update(value).digest('hex');
const body = '---\nname: demo\ndescription: Demo.\n---\nUse this.\n';
const encode = value => Buffer.from(value).toString('base64');
const original = {
  body,
  files: { 'references/old.md': encode('旧\r\n'), 'references/keep.bin': 'AAEC' },
  metadata: { directories: ['references', 'templates/empty'], source: { type: 'fixture' } },
};
const replace = { action: 'write_file', path: 'references/old.md', content: '新\n', baseSha256: sha('旧\r\n') };
const add = { action: 'write_file', path: 'scripts/nested/check.sh', content: 'printf "ok\\n"\n', baseSha256: null };

function proposal(fields) {
  const display = { action: 'patch', uri, baseSha256: sha(body), evidence: { sessionId: 'attachment-test' }, ...fields };
  return { ...display, proposalId: sha(JSON.stringify(display)) };
}

async function fixture(t, start = original) {
  const directory = await mkdtemp(join(tmpdir(), 'skill-attachments-'));
  t.after(() => rm(directory, { recursive: true }));
  let live = structuredClone(start);
  let writes = 0;
  const adapter = {
    mode: 'atomic-conditional',
    read: async () => structuredClone(live),
    replace: async (_, next, previous) => {
      assert.deepEqual(live, previous);
      writes++;
      live = structuredClone(next);
    },
    create: async (_, next) => { assert.equal(live, null); live = structuredClone(next); writes++; },
    remove: async (_, previous) => { assert.deepEqual(live, previous); live = null; writes++; },
    verifyIndex: async () => true,
  };
  const service = createApprovalService({ directory, managedUri: uri, adapter });
  return { service, adapter, setLive: next => { live = next; }, get live() { return live; }, get writes() { return writes; } };
}

function vote(draft, preview) {
  return { sessionId: draft.evidence.sessionId, id: draft.proposalId, digest: preview.approvalDigest };
}

test('operations-only patch approves exact bytes and restores the complete original package', async t => {
  const f = await fixture(t);
  const draft = proposal({ operations: [replace, add] });
  const preview = await f.service.stage(draft);
  assert.equal(preview.status, 'pending');
  assert.equal(f.writes, 0);
  const approval = vote(draft, preview);
  assert.equal((await f.service.approve({ ...approval, digest: 'invalid' })).status, 'approval_mismatch');
  assert.equal((await f.service.approve(approval)).status, 'applied');
  assert.deepEqual(f.live, {
    body,
    files: { ...original.files, [replace.path]: encode(replace.content), [add.path]: encode(add.content) },
    metadata: { ...original.metadata, directories: ['references', 'scripts', 'scripts/nested', 'templates/empty'] },
  });
  assert.equal((await f.service.rollback(approval)).status, 'rolled_back');
  assert.deepEqual(f.live, original);
});

test('create readback accepts expected attachments through native normalization', async t => {
  const f = await fixture(t, null);
  const native = createOpenVikingAdapter({ origin: 'http://127.0.0.1:1234', mode: 'isolated-single-writer', managedUri: uri });
  f.adapter.matchesCreated = native.matchesCreated;
  f.adapter.create = async (_, next) => {
    f.setLive({ ...next, body: next.body.replace('"Demo."', 'Demo.').trimEnd(), metadata: { ...next.metadata,
      source: { type: 'skill_evolution', skill_name: 'demo', tracked: true, metadata_uri: uri.replace('SKILL.md', '.source.json') },
    } });
  };
  const lines = body.replace('Demo.', '"Demo."').trimEnd().split('\n');
  const diff = `--- /dev/null\n+++ ${uri}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`;
  const draft = proposal({ action: 'create', baseSha256: null, diff, operations: [add] });
  const preview = await f.service.stage(draft);
  assert.equal(preview.status, 'pending');
  const approval = vote(draft, preview);
  assert.equal((await f.service.approve(approval)).status, 'applied');
  assert.equal(f.live.files[add.path], encode(add.content));
  assert.deepEqual(f.live.metadata.directories, ['scripts', 'scripts/nested']);
  assert.equal((await f.service.rollback(approval)).status, 'rolled_back');
  assert.equal(f.live, null);
});

test('a combined patch removes the selected bytes and edits SKILL.md', async t => {
  const f = await fixture(t);
  const diff = `--- ${uri}\n+++ ${uri}\n@@ -5 +5 @@\n-Use this.\n+Use the new flow.\n`;
  const remove = { action: 'remove_file', path: replace.path, baseSha256: replace.baseSha256 };
  const draft = proposal({ diff, operations: [remove] });
  const preview = await f.service.stage(draft);
  const approval = vote(draft, preview);
  assert.equal((await f.service.approve(approval)).status, 'applied');
  assert.equal(f.live.body, body.replace('Use this.', 'Use the new flow.'));
  assert.deepEqual(f.live.files, { 'references/keep.bin': original.files['references/keep.bin'] });
  assert.equal((await f.service.rollback(approval)).status, 'rolled_back');
  assert.deepEqual(f.live, original);
});

test('removing the last file prunes its empty ancestor directories and restores them on rollback', async t => {
  const f = await fixture(t, {
    ...original,
    files: { ...original.files, 'scripts/nested/check.sh': encode(add.content) },
    metadata: { ...original.metadata, directories: ['references', 'scripts', 'scripts/nested', 'templates/empty'] },
  });
  const before = f.live;
  const draft = proposal({ operations: [{ action: 'remove_file', path: add.path, baseSha256: sha(add.content) }] });
  const approval = vote(draft, await f.service.stage(draft));
  assert.equal((await f.service.approve(approval)).status, 'applied');
  assert.deepEqual(f.live, original);
  assert.equal((await f.service.rollback(approval)).status, 'rolled_back');
  assert.deepEqual(f.live, before);
});

test('different attachment bytes make a declared base SHA conflict', async t => {
  const f = await fixture(t);
  const draft = proposal({ operations: [{ ...replace, baseSha256: sha('旧\n') }] });
  assert.deepEqual(await f.service.stage(draft), { status: 'conflict' });
  assert.equal(f.writes, 0);
});

test('tampering with attachment content invalidates the proposal ID', async t => {
  const f = await fixture(t);
  const draft = proposal({ operations: [replace] });
  const modified = { ...draft, operations: [{ ...replace, content: 'tampered' }] };
  assert.deepEqual(await f.service.stage(modified), { status: 'invalid_proposal' });
  assert.equal(f.writes, 0);
});

test('staging binds the displayed attachment content before waiting for the snapshot', async t => {
  const f = await fixture(t);
  const read = f.adapter.read;
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  f.adapter.read = async () => { started.resolve(); await finish.promise; return read(); };
  const draft = proposal({ operations: [{ ...replace }] });
  const pending = f.service.stage(draft);
  await started.promise;
  draft.operations[0].content = 'changed during snapshot';
  finish.resolve();
  const preview = await pending;
  assert.equal(preview.proposal.operations[0].content, replace.content);
  assert.equal((await f.service.approve(vote(draft, preview))).status, 'applied');
  assert.equal(f.live.files[replace.path], encode(replace.content));
});

test('validator accepts only declared UTF-8 file operations on non-overlapping attachment paths', () => {
  assert.deepEqual(validateAttachmentOperations(undefined), []);
  assert.deepEqual(validateAttachmentOperations([{ ...replace, baseSha256: replace.baseSha256.toUpperCase() }]), [replace]);
  assert.deepEqual(validateAttachmentOperations([{ ...add, content: '' }]), [{ ...add, content: '' }]);
  for (const path of ['SKILL.md', 'scripts', 'other/file', 'assets/../SKILL.md', 'assets//x', 'assets\\x', 'assets/.SOURCE.JSON', '/assets/file']) {
    assert.throws(() => validateAttachmentOperations([{ ...add, path }]), { name: 'TypeError' });
  }
  assert.throws(() => validateAttachmentOperations([add, add]), { name: 'TypeError' });
  assert.throws(() => validateAttachmentOperations([add, { ...add, path: 'scripts/nested' }]), { name: 'TypeError' });
  assert.throws(() => validateAttachmentOperations([{ ...add, content: '\ud800' }]), { name: 'TypeError' });
  assert.throws(() => validateAttachmentOperations([{ ...add, baseSha256: undefined }]), { name: 'TypeError' });
  assert.throws(() => validateAttachmentOperations([{ action: 'remove_file', path: add.path, baseSha256: null }]), { name: 'TypeError' });
});

test('native create normalization verifies attachment bytes and directory set', () => {
  const native = createOpenVikingAdapter({ origin: 'http://127.0.0.1:1234', mode: 'isolated-single-writer', managedUri: uri });
  const expected = { body: body.replace('Demo.', '"Demo."'), files: { [add.path]: encode(add.content) },
    metadata: { directories: ['scripts', 'scripts/nested'], source: { type: 'skill_evolution' } } };
  const live = { ...expected, body: body.trimEnd(), metadata: { directories: ['scripts/nested', 'scripts'],
    source: { type: 'skill_evolution', skill_name: 'demo', tracked: true, metadata_uri: uri.replace('SKILL.md', '.source.json') } } };
  assert.equal(native.matchesCreated(uri, expected, live), true);
  assert.equal(native.matchesCreated(uri, expected, { ...live, files: { [add.path]: 'AAEC' } }), false);
  assert.equal(native.matchesCreated(uri, expected, { ...live, metadata: { ...live.metadata, directories: ['scripts'] } }), false);
});

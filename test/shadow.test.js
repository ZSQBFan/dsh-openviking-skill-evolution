import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceProjection as projection } from '../src/evidence.js';
import { applySkillDiff, review } from '../src/review.js';

const own = 'viking://user/fixture/skills/demo/SKILL.md';
const shared = 'viking://agent/skills/demo/SKILL.md';
const original = '---\nname: demo\ndescription: Demo.\n---\n\nRun smoke.\n';
const text = value => [{ type: 'text', text: value }];

function fixture(inherited = 0) {
  let seq = 0;
  let state = projection.init({}, inherited);
  function add(type, data) {
    state = projection.apply(state, { seq, type, data });
    return seq++;
  }
  const f = {
    add,
    read(uri, body = original, { isError = false, args = {} } = {}) {
      const callId = `read-${seq}`;
      add('tool/call', { name: 'mcp__openviking__read', callId, arguments: JSON.stringify({ uris: [uri], ...args }) });
      return add('tool/result', { message: { source: { kind: 'tool', callId }, isError, content: text(body) } });
    },
    user(value, kind = 'user') { return add('user/message', { role: 'user', source: { kind }, content: text(value) }); },
    correct(readSeq) { return f.user(`技能纠正 ${readSeq}\n原文：Run smoke.\n改为：Run smoke and verify exit status.\n原因：需要核对退出状态`); },
    review(uri = own) { return review(state, 'fixture', uri); },
  };
  return f;
}

test('native MCP singular read supplies an exact patch base', () => {
  const f = fixture();
  const seq = f.read(own, original, { args: { uris: undefined, uri: own } });
  f.correct(seq);
  assert.equal(f.review().action, 'patch');
});

test('binds a small diff to the read bytes, call and user correction', () => {
  const f = fixture();
  const readResultSeq = f.read(own);
  const userSeq = f.correct(readResultSeq);
  const proposal = f.review();
  assert.equal(proposal.action, 'patch');
  assert.equal(proposal.baseSha256, createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(proposal.evidence, { sessionId: 'fixture', readCallSeq: 0, readResultSeq, userSeq });
  assert.match(proposal.diff, /@@ -6 \+6 @@\n-Run smoke\.\n\+Run smoke and verify exit status\./);
  f.add('command/run', { commandId: 'same', name: 'skill-refine' });
  f.add('command/done', { commandId: 'same', kind: 'success', text: JSON.stringify(proposal) });
  assert.equal(f.review().reason, 'duplicate');
});

function assertGitApplies(proposal, base, expected) {
  assert.equal(proposal.action, 'patch');
  assert.equal(proposal.baseSha256, createHash('sha256').update(base).digest('hex'));
  const cwd = mkdtempSync(join(tmpdir(), 'skill-evolution-patch-'));
  try {
    const file = join(cwd, 'SKILL.md');
    writeFileSync(file, base);
    // Map the canonical URI headers to the local fixture path without touching the hunk.
    const input = proposal.diff.replace(`--- ${own}\n+++ ${own}\n`, '--- a/SKILL.md\n+++ b/SKILL.md\n');
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--unidiff-zero', '--whitespace=nowarn'], { cwd, input });
    assert.deepEqual(readFileSync(file), Buffer.from(expected));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('Git applies the patch to CRLF source without changing line endings', () => {
  const f = fixture();
  const base = original.replaceAll('\n', '\r\n');
  f.correct(f.read(own, base));
  assertGitApplies(f.review(), base, base.replace('Run smoke.', 'Run smoke and verify exit status.'));
});

test('Git applies the patch to an unterminated final line without adding a terminator', () => {
  const f = fixture();
  const base = original.slice(0, -1);
  f.correct(f.read(own, base));
  assertGitApplies(f.review(), base, base.replace('Run smoke.', 'Run smoke and verify exit status.'));
});

test('applySkillDiff applies one approved hunk at its exact position with its original terminator', () => {
  for (const base of [original, original.replaceAll('\n', '\r\n'), original.slice(0, -1)]) {
    const f = fixture();
    f.correct(f.read(own, base));
    const { diff } = f.review();
    const expected = base.replace('Run smoke.', 'Run smoke and verify exit status.');
    assert.equal(applySkillDiff(base, diff, own), expected);
    assert.throws(() => applySkillDiff(base, diff, shared));
    assert.throws(() => applySkillDiff(base.replace('Run smoke.', 'Run other.'), diff, own));
    assert.throws(() => applySkillDiff(base, diff.replace('@@ -6 +6 @@', '@@ -7 +7 @@'), own));
    assert.throws(() => applySkillDiff(base, `${diff}+extra\n`, own));
    const otherTerminator = base.endsWith('\n') ? base.replace(/\r?\n$/, '') : `${base}\n`;
    assert.throws(() => applySkillDiff(otherTerminator, diff, own));
  }
});

test('same name retains private and shared scope independently', () => {
  const f = fixture();
  f.correct(f.read(own));
  f.read(shared);
  assert.equal(f.review(shared).action, 'no_change');
  assert.equal(f.review().uri, own);
});

test('successful read alone and injected corrections are not learning evidence', () => {
  const f = fixture();
  const seq = f.read(own);
  f.user(`技能纠正 ${seq}\n原文：Run smoke.\n改为：fake\n原因：fake`, 'plugin:fixture');
  assert.equal(f.review().reason, 'no_learning_evidence');
});

test('failed, partial and later unusable reads fail closed', () => {
  for (const options of [{ isError: true }, { args: { limit: 3 } }]) {
    const f = fixture();
    f.correct(f.read(own, original, options));
    assert.equal(f.review().reason, 'latest_read_unusable');
  }
  const f = fixture();
  f.correct(f.read(own));
  f.read(own, 'Error: denied', { isError: true });
  assert.equal(f.review().reason, 'latest_read_unusable');
});

test('a later distinct version invalidates the cited base', () => {
  const f = fixture();
  f.correct(f.read(own));
  f.read(own, `${original}\nOther changes.\n`);
  assert.equal(f.review().reason, 'stale_read');
});

test('a later batch read blocks only the requested skill and cannot supply a base', () => {
  const f = fixture();
  f.correct(f.read(own));
  f.correct(f.read(shared));
  const unrelated = 'viking://resources/notes.md';
  const changed = original.replace('Run smoke.', 'Run checks.');
  const batchSeq = f.read(own, `=== ${own} ===\n${changed}\n=== ${unrelated} ===\nNotes.`, {
    args: { uris: [own, unrelated] },
  });
  f.correct(batchSeq);
  assert.equal(f.review().reason, 'latest_read_unusable');
  assert.equal(f.review(shared).action, 'patch');
  f.read(own, changed);
  assert.equal(f.review().reason, 'stale_read');
});

test('canonical URI is required when a home alias result has no attribution', () => {
  const f = fixture();
  const alias = 'viking://~/skills/demo/SKILL.md';
  f.correct(f.read(alias));
  assert.equal(f.review().action, 'no_change');
  f.correct(f.read(alias, `=== ${own} ===\n${original}`));
  assert.equal(f.review().uri, own);
});

test('explicit transferable experience creates a draft with existence unverified', () => {
  const f = fixture();
  const userSeq = f.user(`技能经验 ${own}\n描述：验证构建\n步骤：核对冒烟测试退出状态\n原因：本会话验证通过`);
  const proposal = f.review();
  assert.equal(proposal.action, 'create');
  assert.equal(proposal.existence, 'unverified');
  assert.deepEqual(proposal.evidence, { sessionId: 'fixture', userSeq });
  assert.match(proposal.diff, /\+name: demo/);
  assert.equal(f.review(shared).action, 'no_change');
});

test('fork-inherited read and correction are skipped', () => {
  const f = fixture(3);
  f.correct(f.read(own));
  assert.equal(f.review().action, 'no_change');
});

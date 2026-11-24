import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidencePacket, parseReviewerOutput } from '../src/automatic-review.js';

const uri = 'viking://user/fixture/skills/check/SKILL.md';
const base = { action: 'patch', uri, baseSha256: '8'.repeat(64), reason: 'Verified procedure' };
const response = proposal => ({ decision: 'approve', reason: 'Reusable correction', evidence: [{ seq: 1, kind: 'user/message' }], proposal });

test('approval requires a proposal and non-approval cannot carry one', () => {
  assert.throws(() => parseReviewerOutput(response(undefined)), /reviewer_proposal_required/);
  assert.throws(() => parseReviewerOutput({ ...response(base), decision: 'no_change' }), /reviewer_proposal_unexpected/);
});

test('proposal, replacement and attachment fields have strict allowlists', () => {
  assert.throws(() => parseReviewerOutput(response({ ...base, diff: 'old contract' })), /reviewer_operation_extra_field/);
  assert.throws(() => parseReviewerOutput(response({ ...base, patch: { before: ['Old'], after: ['New'] } })), /reviewer_operation_extra_field/);
  assert.throws(() => parseReviewerOutput(response(base)), /reviewer_replacement_required/);
  assert.throws(() => parseReviewerOutput(response({ ...base, replacement: { before: ['Old'], after: ['New'], path: 'foo' } })), /reviewer_operation_extra_field/);
  const attachment = { action: 'write_file', path: 'references/check.md', baseSha256: null, content: 'Verified' };
  assert.throws(() => parseReviewerOutput(response({ ...base, operations: [{ ...attachment, extra: true }] })), /reviewer_operation_extra_field/);
  assert.doesNotThrow(() => parseReviewerOutput(response({ ...base, operations: [attachment] })));
});

test('packet budgets serialized UTF-8 and prioritizes substantive user and tool evidence', () => {
  const big = '测试\\"'.repeat(2500);
  const evidence = [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '技能纠正： Preserve this earlier evidence.' }], cookie: 'never-forward' } }];
  evidence.push({ type: 'tool/result', seq: 2, data: { message: { source: { kind: 'tool', callId: 'checked' }, content: [{ type: 'text', text: 'Verified exit status' }], isError: false } } });
  for (let seq = 3; seq <= 75; seq++) evidence.push({ type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text: big }, { type: 'reasoning', text: 'NEVER_PUBLISH_REASONING' }], extra: { text: 'NEVER_PUBLISH_ENVELOPE' } } } });
  evidence.push({ type: 'tool/call', seq: 76, data: { name: 'shell', arguments: { password: 'never-forward' } } });
  const packet = buildEvidencePacket({ committedEvidence: evidence });
  const serialized = JSON.stringify(packet);
  assert(Buffer.byteLength(serialized) <= 12 * 1024);
  assert(packet.some(event => event.seq === 1));
  assert(packet.some(event => event.seq === 2));
  assert(packet.some(event => event.seq === 75));
  assert.deepEqual(packet.map(event => event.seq), packet.map(event => event.seq).sort((a, b) => a - b));
  assert.match(serialized, /Verified exit status/);
  assert.doesNotMatch(serialized, /never-forward|NEVER_PUBLISH|\ufffd/);
});

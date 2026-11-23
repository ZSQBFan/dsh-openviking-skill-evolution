import test from 'node:test';
import assert from 'node:assert/strict';
import {
  automaticReviewProjection,
  buildEvidencePacket,
  createDshReviewAdapter,
  parseReviewerOutput,
  projectReviewPolicy,
  reviewerOperationToProposal,
} from '../src/automatic-review.js';

test('policy bounds turns, tools, duration and repeated failures', () => {
  let state;
  for (let seq = 0; seq < 3; seq++) state = automaticReviewProjection(state, { seq, type: 'error' });
  assert.equal(projectReviewPolicy(state, {}, 1, 0).reason, 'failure');
  assert.equal(projectReviewPolicy({ committedEvidence: [], turns: 0, toolCalls: 0, failureCount: 0 }, {}).limits.cooldownMs, 30 * 60 * 1000);
  assert.equal(projectReviewPolicy({ ...state, failure: false, failureCount: 0, turns: 10 }, {}, 1, 0).reason, 'turn_limit');
  assert.equal(projectReviewPolicy({ ...state, failure: false, failureCount: 0, turns: 0 }, {}, 1_800_000, 0).reason, 'duration_limit');
});

test('reviewer output is strict and evidence must be committed', () => {
  const state = automaticReviewProjection(undefined, { seq: 1, type: 'tool/result', data: { ok: true } });
  const packet = buildEvidencePacket(state);
  const result = parseReviewerOutput(JSON.stringify({ decision: 'approve', reason: 'evidence supports it', evidence: [{ seq: 1, kind: 'tool/result' }] }));
  assert.equal(result.decision, 'approve');
  assert.throws(() => parseReviewerOutput('{"decision":"approve","reason":"x","evidence":[]}'), /reviewer_evidence_required/);
  assert.equal(packet[0].seq, 1);
  const secretState = automaticReviewProjection(undefined, { seq: 2, type: 'tool/call', data: { authorization: 'secret-token', nested: { password: 'pw' } } });
  assert.deepEqual(buildEvidencePacket(secretState)[0].data, { authorization: '[redacted]', nested: { password: '[redacted]' } });
});

test('DSH adapter uses zero-tool ctx.llm.stream contract', async () => {
  let request;
  const adapter = createDshReviewAdapter({
    provider: 'fixture-provider', model: 'fixture-model', sessionId: 's1',
    llm: { stream: async options => { request = options; return (async function* () { yield { type: 'text-delta', text: JSON.stringify({ decision: 'approve', reason: 'ok', evidence: [{ seq: 1, kind: 'x' }] }) }; })(); } },
  });
  const output = await adapter({ packet: [{ seq: 1, type: 'x' }], signal: new AbortController().signal });
  assert.match(output, /approve/);
  assert.equal(request.temperature, 0);
  assert.equal(request.tools, undefined);
  assert.equal(request.purpose, 'automatic-review');
});

test('review parses valid JSON from a mixed DSH response stream', async () => {
  const verdict = { decision: 'no_change', reason: 'Nothing to learn', evidence: [{ seq: 1, kind: 'user/message' }] };
  const text = JSON.stringify(verdict);
  const chunks = [
    { type: 'reasoning-delta', text: 'Evaluating evidence' },
    { type: 'text-delta', text: text.slice(0, 20) },
    { type: 'reasoning-delta', text: 'Still evaluating' },
    { type: 'text-delta', text: text.slice(20) },
    { type: 'block-end', block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const observed = [];
  const adapter = createDshReviewAdapter({ provider: 'fixture', model: 'fixture', sessionId: 'test',
    llm: { async *stream() { yield* chunks; } } });
  const output = await adapter({ packet: [], onChunk: chunk => observed.push(chunk.type) });
  assert.deepEqual(parseReviewerOutput(output), verdict);
  assert.deepEqual(observed, chunks.map(chunk => chunk.type));
});

test('review retains upstream stream errors even after receiving valid JSON', async () => {
  const adapter = createDshReviewAdapter({ provider: 'fixture', model: 'fixture', sessionId: 'test',
    llm: { async *stream() { yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'error' } }; } } });
  await assert.rejects(adapter({ packet: [] }), /reviewer_stream_failed/);
});

test('proposal conversion preserves review shape and hashes without proposalId', () => {
  const proposal = reviewerOperationToProposal({ action: 'patch', uri: 'viking://user/u/skills/s/SKILL.md', baseSha256: 'a', reason: 'r', diff: 'd' }, { evidence: { sessionId: 's', readResultSeq: 2 } });
  assert.equal(proposal.action, 'patch');
  assert.match(proposal.proposalId, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(proposal).includes('proposalId'), true);
});

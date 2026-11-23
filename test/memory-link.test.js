import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryLinkProjection as projection, memoryLinkStatus } from '../src/memory-link.js';

const uri = 'viking://user/fixture/memories/experiences/run-smoke.md';
const root = 'viking://~/memories/experiences';
const session = { id: 'a', header: { cwd: '/fixture/workspace' } };
const state = { dshSessionId: 'a', ovSessionId: 'dsh-a', ready: true, hasPendingWrites: false,
  config: { user: 'fixture', peerId: 'repo:fixture', recallPeerScope: 'actor', captureToolResults: true, apiKey: 'secret' } };
const runtime = { states: new Map([['a', state]]), stateFor() { throw new Error('must not initialize'); } };
const event = (seq, type, data) => ({ seq, type, data });
const call = (seq, name, args, callId = 'call') => event(seq, 'tool/call', {
  name: `mcp__openviking__${name}`, arguments: JSON.stringify(args), callId,
});
const result = (seq, text, isError = false, callId = 'call') => event(seq, 'tool/result', {
  message: { role: 'tool', source: { kind: 'tool', callId }, isError, content: [{ type: 'text', text }] },
});
const fold = (events, inherited = 0) => events.reduce(projection.apply, projection.init({}, inherited));

test('reads existing workspace linkage without touching runtime methods or exposing config', () => {
  const status = memoryLinkStatus(session, fold([]), runtime);
  assert.equal(status.state, 'linked');
  assert.equal(status.peerId, 'repo:fixture');
  assert.equal(status.ovSessionId, 'dsh-a');
  assert.equal(status.recall.scope, 'actor');
  assert.equal(status.capture.toolResultsEnabled, true);
  assert.equal(status.capture.remoteCommit, 'unverified');
  assert.doesNotMatch(JSON.stringify(status), /secret|\/fixture\/workspace/);
  assert.equal(memoryLinkStatus({ id: 'other' }, fold([]), runtime).state, 'unobserved');
  assert.equal(memoryLinkStatus(session, fold([])).state, 'unavailable');
});

test('records native recall and successful scoped Experience provenance without retaining bodies', () => {
  const projected = fold([
    event(1, 'user/message', { source: { kind: 'plugin:openviking-memory', form: 'recall' } }),
    call(2, 'find', { target_uri: root, query: 'secret' }),
    result(3, JSON.stringify({ memories: [{ uri, abstract: 'secret' }] })),
    call(4, 'read', { uri }),
    result(5, '# Fixture\nsecret'),
  ]);
  const status = memoryLinkStatus(session, projected, runtime);
  assert.equal(status.recall.lastInjectedSeq, 1);
  assert.deepEqual(status.experiences, [
    { kind: 'recall', uri, tool: 'find', callSeq: 2, resultSeq: 3 },
    { kind: 'injection', uri, tool: 'read', callSeq: 4, resultSeq: 5 },
  ]);
  assert.doesNotMatch(JSON.stringify({ projected, status }), /secret/);
});

test('skips inherited, unrelated, failed, partial and cross-account evidence', () => {
  const wrong = uri.replace('/fixture/', '/other/');
  const projected = fold([
    call(1, 'read', { uri }), result(2, '# Old'),
    call(3, 'read', { uri }), result(4, '# Error', true),
    call(5, 'read', { uri, limit: 7 }), result(6, '# Partial'),
    call(7, 'find', { query: 'unscoped' }), result(8, JSON.stringify({ memories: [{ uri }] })),
    call(9, 'find', { target_uri: root }), result(10, JSON.stringify({ memories: [{ uri: wrong }, { uri: `${uri}?q=x` }] })),
    call(11, 'read', { uri }), result(12, `=== ${wrong} ===\n# Wrong owner`),
    call(13, 'read', { uri }), result(14, 'Error: NOT_FOUND'),
    call(15, 'read', { uri }), result(16, '# Mismatched', false, 'different'),
    event(17, 'user/message', { source: { kind: 'user', form: 'recall' }, content: [{ type: 'text', text: '<openviking-context>' }] }),
  ], 3);
  assert.deepEqual(memoryLinkStatus(session, projected, runtime).experiences, []);
  assert.equal(memoryLinkStatus(session, projected, runtime).recall.lastInjectedSeq, null);
});

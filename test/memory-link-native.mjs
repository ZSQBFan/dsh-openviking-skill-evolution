import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { memoryLinkProjection as projection, memoryLinkStatus } from '../src/memory-link.js';

// Use the installed Electron and its ASAR-aware resolver with an explicit native plugin directory.
const [pluginDir] = process.argv.slice(2);
assert.ok(pluginDir && process.env.DSH_INSTALL_DIR);
const fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-memory-link-'));
process.env.HOME = fixtureDir;
process.env.USERPROFILE = fixtureDir;
process.env.OPENVIKING_PENDING_DIR = join(fixtureDir, 'pending');
process.on('exit', () => rmSync(fixtureDir, { recursive: true, force: true }));
const requireFromHost = createRequire(`${process.env.DSH_INSTALL_DIR}/package.json`);
const llm = new URL('./lib/index.js', pathToFileURL(requireFromHost.resolve('@deepseek-ai/dsh-llm/package.json'))).href;
const hooks = registerHooks({ resolve(name, context, next) {
  return next(name === '@deepseek-ai/dsh-llm' ? llm : name, context);
} });
const { OpenVikingRuntime } = await import(pathToFileURL(`${pluginDir}/runtime.mjs`));
const requests = [];
const ok = (result = {}) => ({ ok: true, result });
const client = {
  async healthResult() { return ok(); },
  async ensureSessionResult(id, peer) { requests.push(['ensure', id, peer]); return ok(); },
  async fetchJSON(path, init, options) {
    if (path !== '/api/v1/search/search') return ok();
    const body = JSON.parse(init.body);
    requests.push(['recall', body.session_id, options.actorPeerId]);
    return ok({ rendered: 'Isolated recall' });
  },
  async addMessage(id, message, peer) { requests.push(['capture', id, peer, message]); return ok(); },
  async getSession() { return { pending_tokens: 10 }; },
  async commitSession(id, peer) { requests.push(['commit', id, peer]); return ok(); },
};
const runtime = new OpenVikingRuntime(client, {
  user: 'fixture', minQueryLength: 1, profileTokenBudget: 0, commitTokenThreshold: 1,
  recallPeerScope: 'actor', recallMode: 'server', recallRewrite: 'off',
}, {}, cwd => ({ peerId: cwd.split('/').at(-1) }));
const a = { id: 'session-fixture-a', header: { cwd: '/fixture/peer-a' } };
const b = { id: 'session-fixture-b', header: { cwd: '/fixture/peer-b' } };
assert.equal(memoryLinkStatus(a, projection.init({}, 0), runtime).state, 'unobserved');
assert.equal(requests.length, 0);
const input = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic fixture input' }] };
const recall = await runtime.recallMessage({ session: a }, [input]);
assert.equal(recall?.source?.form, 'recall');
const committed = [
  { seq: 0, type: 'user/message', data: input },
  { seq: 1, type: 'user/message', data: recall },
  { seq: 2, type: 'turn/end', data: {} },
];
for (const event of committed) {
  runtime.capture(a, event);
  runtime.maybeCommit(a, event);
}
await runtime.flush(a);
await runtime.initialize({ session: b });
const projected = committed.reduce(projection.apply, projection.init({}, 0));
const before = requests.length;
const aStatus = memoryLinkStatus(a, projected, runtime);
const bStatus = memoryLinkStatus(b, projection.init({}, 0), runtime);
assert.equal(requests.length, before);
assert.equal(aStatus.state, 'linked');
assert.equal(aStatus.peerId, 'peer-a');
assert.equal(bStatus.peerId, 'peer-b');
assert.notEqual(aStatus.ovSessionId, bStatus.ovSessionId);
assert.equal(aStatus.recall.lastInjectedSeq, 1);
assert.equal(aStatus.capture.lastCommitBoundarySeq, 2);
assert.equal(aStatus.capture.remoteCommit, 'unverified');
assert.deepEqual(requests.map(request => request[0]), ['ensure', 'recall', 'capture', 'commit', 'ensure']);
for (const request of requests.slice(0, 4)) assert.deepEqual(request.slice(1, 3), [aStatus.ovSessionId, 'peer-a']);
assert.deepEqual(requests[4].slice(1), [bStatus.ovSessionId, 'peer-b']);
assert.doesNotMatch(JSON.stringify(aStatus), /Synthetic fixture input|Isolated recall/);
hooks.deregister();
console.log('Native runtime fixture passed: two workspace peers; one native recall, capture, and commit; zero audit requests.');

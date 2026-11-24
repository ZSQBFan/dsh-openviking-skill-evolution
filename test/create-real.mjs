import assert from 'node:assert/strict';
import { createGovernance } from '../src/governance.js';
import { createOpenVikingAdapter } from '../src/ov-adapter.js';
import { review } from '../src/review.js';

const { OV_M2_ORIGIN: origin, OV_M2_KEY: apiKey, OV_M2_URI, OV_M2_LEDGER: directory } = process.env;
const owner = OV_M2_URI.split('/')[3];
const writer = { origin, apiKey, mode: 'native-verified-readback' };
const governance = await createGovernance({ directory, owner, writer, settings: { mode: 'auto' } });
const managedUri = OV_M2_URI.replace(/\/[^/]+\/SKILL\.md$/, '/new-governance-skill/SKILL.md');
const adapter = createOpenVikingAdapter({ ...writer, managedUri });
const sessionId = 'create-native-probe';
const text = `技能经验 ${managedUri}\n描述：核对发布台账差异，并记录核对结论。\n步骤：对照发布台账和变更记录，记录差异。\n原因：Verify the exact URI after every mutation.`;
const proposal = review({ evidence: [{ type: 'user/message', seq: 4, text }] }, sessionId, managedUri);
assert.equal(await adapter.read(managedUri), null);

// Keep native writes and exact reads intact while reproducing the missing search hit.
const nativeFetch = globalThis.fetch;
let omittedHits = 0;
globalThis.fetch = async (url, options) => {
  if (url.origin === origin && url.pathname === '/api/v1/skills/find') {
    omittedHits++;
    return Response.json({ status: 'ok', result: { skills: [] } });
  }
  return nativeFetch(url, options);
};
try {
  assert.equal((await governance.submit(proposal)).status, 'applied');
} finally {
  globalThis.fetch = nativeFetch;
}
assert.equal(omittedHits, 1);
const live = await adapter.read(managedUri);
assert.match(live.body, /核对发布台账差异，并记录核对结论。/);
assert.match(live.body, /对照发布台账和变更记录，记录差异。/);
assert.equal(live.metadata.source.type, 'skill_evolution');
const reopened = await createGovernance({ directory, owner, writer });
const [card] = await reopened.proposals();
assert.equal(card.status, 'applied');
assert.deepEqual(card.actions, ['preview', 'rollback']);
assert.deepEqual(card.history.map(entry => entry.status), ['pending', 'applying', 'index_unconfirmed', 'applied']);
// Simulate a stale search hit after the real package deletion.
globalThis.fetch = async (url, options) => {
  if (url.origin === origin && url.pathname === '/api/v1/skills/find') {
    return Response.json({ status: 'ok', result: { skills: [{ root_uri: managedUri.replace(/\/SKILL\.md$/, '') }] } });
  }
  return nativeFetch(url, options);
};
try {
  assert.equal((await reopened.vote('rollback', card.id)).status, 'rolled_back');
} finally {
  globalThis.fetch = nativeFetch;
}
assert.equal(await adapter.read(managedUri), null);
assert.deepEqual((await reopened.proposals())[0].history.slice(-3).map(entry => entry.status),
  ['restoring', 'index_unconfirmed', 'rolled_back']);
console.log(JSON.stringify({ event: 'create_service', create: 'applied', searchHitOmitted: true, restore: 'rolled_back', staleSearchHit: true, absent: true }));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCurator } from '../src/curator.js';

const day = 86400000;
const first = 'viking://user/alice/skills/fixture/SKILL.md';
const shared = 'viking://agent/skills/fixture/SKILL.md';

test('curator archives only adopted private skills, survives restart and restores exact read access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-curator-'));
  t.after(() => rm(directory, { recursive: true }));
  let now = day;
  const setup = () => createCurator({ directory, owner: 'alice', now: () => now });
  let curator = await setup();
  assert.equal(await curator.adopt(shared), 'out_of_scope');
  assert.equal(await curator.adopt(first), 'active');
  await curator.loaded({ uri: first, sessionId: 's1', seq: 4, at: now });
  await curator.loaded({ uri: first, sessionId: 's1', seq: 4, at: now });
  await curator.loaded({ uri: shared, sessionId: 's1', seq: 5, at: now });
  now += 30 * day;
  assert.equal((await curator.scan({ manual: true })).skills[0].status, 'stale');
  now += 60 * day;
  assert.equal((await curator.scan({ manual: true })).skills[0].status, 'archived');
  curator = await setup();
  assert.equal(curator.snapshot().usage.skills.find(s => s.uri === first).loads, 1);
  assert.equal(curator.blocks('mcp__openviking__read', { uri: 'viking://~/skills/fixture/SKILL.md' }), true);
  assert.equal(curator.blocks('mcp__openviking__read', { uri: shared }), false);
  assert.equal(await curator.restore(first), 'active');
  assert.equal(curator.blocks('mcp__openviking__read', { uri: first }), false);
});

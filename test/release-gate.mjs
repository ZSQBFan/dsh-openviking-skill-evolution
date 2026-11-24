import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const dashboardPath = '/api/dsh-openviking-skill-evolution/dashboard';
export const uri = 'viking://user/fixture/skills/demo/SKILL.md';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function contentsSha256(packageDir, files) {
  const entries = await Promise.all(files.map(async file => [file, sha256(await readFile(join(packageDir, file)))]));
  return sha256(JSON.stringify(entries));
}
const baselineLine = 'Run smoke.';
export const baseline = '---\nname: demo\ndescription: Demo.\n---\n\n' + baselineLine + '\n';
export const reviewedLine = 'Run smoke and check exit status.';
export const reviewed = baseline.replace(baselineLine, reviewedLine);
export const provider = 'release-fixture';
export const model = 'release-reviewer';

export function seedReview(append, body, replacement) {
  append('user/message', {
    id: 'release-user', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: `Use this verified instruction: ${replacement}` }],
  });
  const call = append('tool/call', { callId: 'release-review-read', name: 'mcp__openviking__read', arguments: JSON.stringify({ uri }) });
  append('tool/result', { message: {
    id: 'release-review-result', role: 'tool', source: { kind: 'tool', callId: 'release-review-read' },
    toolCallId: 'release-review-read', isError: false, content: [{ type: 'text', text: body }],
  } }, [call.seq]);
}

export async function* reviewer(messages, observed) {
  const { events, bases, owner } = JSON.parse(messages.at(-1).content[0].text);
  assert.equal(owner, 'fixture');
  assert.equal(bases.length, 1);
  const [base] = bases;
  const user = events.find(event => event.type === 'user/message');
  const read = events.find(event => event.type === 'tool/result');
  assert.equal(base.uri, uri);
  assert.equal(base.seq, read.seq);
  const before = base.bodyExcerpt.trim();
  assert.equal(base.sha256, sha256(baseline.replace(baselineLine, before)));
  const after = /^Use this verified instruction: (.+)$/.exec(user.text)?.[1];
  assert(after);
  observed.push({ decision: 'approve', evidence: [user.seq, read.seq], baseSha256: base.sha256 });
  yield { type: 'text-delta', index: 0, text: JSON.stringify({
    decision: 'approve', reason: 'The fixture user verified the revised instruction.',
    evidence: [user, read].map(({ seq, type }) => ({ seq, kind: type })),
    proposal: { action: 'patch', uri, baseSha256: base.sha256, reason: 'Update the smoke instruction.',
      replacement: { before: [before], after: [after] } },
  }) };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

export async function verifyPublicReview({ request, session, liveBody, observed }) {
  const settings = async (mode, revision, route = { provider, model }) => {
    const result = await request('settings', { mode, revision, ...route, reviewTimeoutMs: 5000, maxDurationMs: 90000 });
    assert.deepEqual(result, { status: 'saved', revision: revision + 1 });
    const { settings } = await request();
    for (const [field, value] of Object.entries({ mode, effectiveMode: mode, revision: revision + 1, ...route, reviewTimeoutMs: 5000, maxDurationMs: 90000 })) {
      assert.equal(settings[field], value, `dashboard settings: ${field}`);
    }
  };
  const run = async (label, status, base, replacement) => {
    const sessionId = await session(label, base, replacement);
    const result = await request('run', { sessionId });
    assert.equal(result.status, status, JSON.stringify(result));
    assert.match(result.proposalId, /^[a-f0-9]{64}$/);
    const { proposals, history } = await request();
    const card = proposals.find(item => item.id === result.proposalId);
    assert.equal(card?.status, status);
    assert.equal(card.sessionId, sessionId);
    assert.deepEqual(card.actions, status === 'shadow' ? ['preview'] : ['preview', 'approve', 'reject']);
    const row = history.find(item => item.proposalId === result.proposalId);
    assert.equal(row?.status, status);
    assert.equal(row.source, 'manual');
    assert.equal(row.provider, provider);
    assert.equal(row.model, model);
    assert.equal(row.stage, 'submit');
    const preview = await request('preview', { id: result.proposalId });
    assert(preview.diff.includes(`+${replacement}\n`), preview.diff);
    assert.equal(preview.evidence.sessionId, sessionId);
    assert.deepEqual(preview.evidence.sequences, observed.at(-1).evidence);
    return result.proposalId;
  };
  const start = await request();
  assert.equal(start.capabilities.run, true);
  assert.equal(start.capabilities.approve, true);
  await settings('approval', start.settings.revision);
  const approved = await run('approve', 'pending', baseline, reviewedLine);
  assert.equal(await liveBody(), baseline, 'pending proposal must not write');
  assert.equal((await request('approve', { id: approved })).status, 'applied');
  assert.equal(await liveBody(), reviewed, 'public approval must write the reviewed fixture body');
  assert.equal((await request()).proposals.find(item => item.id === approved)?.status, 'applied');

  await settings('shadow', start.settings.revision + 1, { provider: '', model: '' });
  const shadow = await run('shadow', 'shadow', reviewed, 'Run smoke and check exit status before archiving the output.');
  assert.equal(await liveBody(), reviewed, 'shadow proposal must not write');

  await settings('approval', start.settings.revision + 2);
  const pending = await run('pending', 'pending', reviewed, 'Run smoke and check exit status before signing off.');
  assert.equal(await liveBody(), reviewed, 'second pending proposal must not write');
  assert.equal(observed.length, 3, 'all three proposals must use reviewer approval');
  assert.equal(new Set([approved, shadow, pending]).size, 3);
  const { proposals } = await request();
  assert.deepEqual(new Map(proposals.map(({ id, status }) => [id, status])), new Map([
    [approved, 'applied'], [shadow, 'shadow'], [pending, 'pending'],
  ]));
  assert.deepEqual(await request('clearHistory', { confirm: false }), { status: 'invalid_confirm', count: 0 });
  const historySize = (await request()).history.length;
  assert(historySize >= 3);
  assert.deepEqual(await request('clearHistory', { confirm: true }), { status: 'history_cleared', count: historySize });
  const afterHistory = await request();
  assert.deepEqual(afterHistory.history, []);
  assert.deepEqual(afterHistory.proposals, proposals);
  assert.deepEqual(await request('clearProposals', { confirm: true }), { status: 'proposals_cleared', count: proposals.length });
  const afterProposals = await request();
  assert.deepEqual(afterProposals.proposals, []);
  assert(afterProposals.preservedVersions.some(item => item.id === approved && item.actions.includes('rollback')));
  assert.equal((await request('approve', { id: pending })).status, 'proposal_cleared');
  assert.equal(await liveBody(), reviewed, 'clearing does not alter the applied skill');
  return { path: dashboardPath, proposals: { applied: approved, shadow, pending }, approvals: observed,
    bodySha256: { initial: sha256(baseline), final: sha256(reviewed) }, cleared: { history: historySize, proposals: proposals.length } };
}

export async function verifyPackedReview(packageDir, name, version) {
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  const directory = await mkdtemp(join(tmpdir(), 'skill-evolution-packed-review-'));
  const dispose = [];
  try {
    let body = baseline;
    let writes = 0;
    const adapter = {
      mode: 'atomic-conditional',
      async read(target) {
        assert.equal(target, uri);
        return { body, files: {}, metadata: { directories: [], source: null } };
      },
      async replace(target, next, previous) {
        assert.equal(target, uri);
        assert.equal(previous.body, body);
        body = next.body;
        writes++;
      },
      async verifyIndex(target, snapshot) { return target === uri && body === snapshot.body; },
    };
    let route;
    const observed = [];
    const agents = new Map();
    const ctx = {
      get: name => ({ agents: { get: id => agents.get(id), list: () => agents.values() }, llm: { stream: options => {
        assert.equal(options.provider, provider);
        assert.equal(options.model, model);
        assert.equal(options.purpose, 'automatic-review');
        return reviewer(options.messages, observed);
      } } })[name],
      on() {}, effect(fn) { dispose.push(fn()); }, commands: { register() {} },
      sessionProjections: { async register(projection) {
        return { stateOf: session => session.events.reduce((state, event) => projection.apply(state, event), projection.init({}, 0)) };
      } },
      inject(dependencies, mount) {
        if (dependencies.includes('connection')) mount({ connection: { fetch: { register(value) { route = value; } } } });
      },
    };
    const candidate = await import(pathToFileURL(join(packageDir, 'index.js')).href);
    await candidate.apply(ctx, { evolution: { directory, owner: 'fixture', writer: { adapter } } });
    assert.equal(route?.path, dashboardPath);
    const report = await verifyPublicReview({ observed, liveBody: () => body,
      session(label, input, replacement) {
        const id = `release-review-${label}`;
        const events = [];
        seedReview((type, data) => {
          const event = { type, data, seq: events.length + 1 };
          events.push(event);
          return event;
        }, input, replacement);
        const sessionRoute = label === 'shadow' ? { provider, model } : { provider: 'unused-session-provider', model: 'unused-session-model' };
        agents.set(id, { session: { id, events }, model: { current: () => sessionRoute } });
        return id;
      },
      async request(action, input) {
        const response = await route.fetch(new Request(`http://localhost${dashboardPath}`, action === undefined ? {} : {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, input }),
        }));
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.equal(result.ok, true);
        return result.data;
      },
    });
    assert.equal(writes, 1, 'fixture write count');
    return { ...report, writes };
  } finally {
    for (const fn of dispose) fn?.();
    await rm(directory, { recursive: true, force: true });
  }
}

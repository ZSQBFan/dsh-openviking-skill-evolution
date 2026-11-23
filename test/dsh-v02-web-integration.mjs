import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { createOpenVikingAdapter } from '../src/ov-adapter.js';

const runtime = process.env.DSH_NODE_EXECUTABLE;
const install = process.env.DSH_INSTALL_DIR;
const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const nativeOrigin = process.env.OV_M2_ORIGIN;
const uri = process.env.OV_M2_URI ?? 'viking://user/fixture/skills/demo/SKILL.md';
const owner = uri.split('/')[3];
const nativeOptions = nativeOrigin && { origin: nativeOrigin, apiKey: process.env.OV_M2_KEY, managedUri: uri, mode: 'isolated-single-writer' };
const nativeAdapter = nativeOptions && createOpenVikingAdapter(nativeOptions);
const baseline = nativeAdapter ? await nativeAdapter.read(uri) : null;
const body = baseline?.body ?? '---\nname: demo\ndescription: Demo.\n---\n\nRun smoke.\n';
const foreground = process.env.SKILL_EVOLUTION_FOREGROUND === '1';
const attachment = { action: 'write_file', path: 'references/verification.md', baseSha256: null, content: '# Verification\nCheck the smoke test exit status.\n' };
const changedBody = body.replace('Run smoke.', 'Run smoke and check exit status.');
const line = body.split('\n').indexOf('Run smoke.') + 1;
const ending = line === body.split('\n').length ? '\n\\ No newline at end of file\n' : '\n';
const patch = `--- ${uri}\n+++ ${uri}\n@@ -${line} +${line} @@\n-Run smoke.${ending}+Run smoke and check exit status.${ending}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function hostPlugin(root) {
  const evolution = join(repo, 'src/evolution.js');
  const evidence = join(repo, 'src/evidence.js');
  const sessionId = 'dsh-v02-fixture-session';
  return `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEvolution } from ${JSON.stringify(evolution)};
import { evidenceProjection } from ${JSON.stringify(evidence)};
export const inject = ['agents', 'sessions', 'sessionProjections', 'llm', 'tools'];
const uri = ${JSON.stringify(uri)};
const body = ${JSON.stringify(body)};
const sessionId = ${JSON.stringify(sessionId)};
const root = ${JSON.stringify(root)};
const generation = Number(process.env.DSH_V02_GENERATION || 1);
const snapshot = { body, files: {}, metadata: { source: 'fixture' } };
const model = { provider: 'skill-fixture', id: 'skill-fixture', name: 'Skill fixture', context: { contextWindow: 65536 } };
const adapter = {
  mode: 'atomic-conditional',
  async read() { return structuredClone(snapshot); },
  async replace(_uri, next) { snapshot.body = next.body; snapshot.files = next.files; snapshot.metadata = next.metadata; return true; },
  async verifyIndex() { return true; }
};
export function apply(ctx) {
  ctx.llm.registerAdapter(['skill-fixture'], {
    providerInfo: id => ({ id, name: 'Skill fixture' }), providerRetryPolicy: () => undefined,
    listModels: async () => [model], resolveModel: async () => model,
    prepareCall: async () => ({ model, stream: async function* ({ messages }) {
      const payload = JSON.parse(messages.at(-1).content[0].text);
      const evidence = payload.events.filter(event => event.type === 'tool/result' || event.type === 'user/message');
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ decision: 'approve', reason: 'Fixture evidence supports a bounded correction.', evidence: evidence.map(event => ({ seq: event.seq, kind: event.type })), proposal: { action: 'patch', uri: ${JSON.stringify(uri)}, baseSha256: ${JSON.stringify(sha256(body))}, reason: 'Clarify the smoke instruction.', diff: ${JSON.stringify(patch)}, operations: [${JSON.stringify(attachment)}] } }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } })
  });
  setTimeout(async () => {
  try {
  writeFileSync(${JSON.stringify(join(root, 'started'))}, 'started');
  const projection = await ctx.sessionProjections.register(evidenceProjection);
  const native = Boolean(process.env.OV_M2_ORIGIN);
  if (native) ctx.provide('openvikingMemory', { config: { baseUrl: process.env.OV_M2_ORIGIN, apiKey: process.env.OV_M2_KEY, user: ${JSON.stringify(owner)} } });
  const evolution = await mountEvolution(ctx, {
    directory: root, owner: native ? null : ${JSON.stringify(owner)},
    ...(native ? {} : { writer: { adapter } }),
    settings: { ...(native ? {} : { mode: 'approval' }), maxTurns: ${foreground ? 999 : 1}, maxToolCalls: 10, maxFailures: 3, cooldownMs: 0,
      correctionWords: ['技能纠正'], provider: 'skill-fixture', model: 'skill-fixture' }
  }, projection);
  const handle = generation === 1
    ? await ctx.agents.create({ sessionId, meta: { cwd: root } })
    : await ctx.agents.resume({ resumeSessionId: sessionId });
  const agent = handle.agent;
  const session = agent.session;
  const callId = 'fixture-read';
  if (generation === 1) {
  session.append('user/message', { id: 'fixture-correction', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Run smoke and verify the exit status before reporting.' }] }, { surfaceOp: 'append' });
  session.append('turn/start', { turn: generation });
  session.append('step/start', { turn: generation, step: 1 });
  session.append('assistant/message', { turn: generation, step: 1, stream: [], message: {
    id: 'fixture-assistant', role: 'assistant', source: { kind: 'model', provider: 'skill-fixture', model: 'skill-fixture' },
    content: [{ type: 'tool-call', id: callId, name: 'mcp__openviking__read', arguments: JSON.stringify({ uri }) }]
  } }, { surfaceOp: 'append' });
  const call = session.append('tool/call', { turn: generation, step: 1, callId, name: 'mcp__openviking__read', arguments: JSON.stringify({ uri }) });
  session.append('tool/result', { turn: generation, step: 1, message: {
    id: 'fixture-tool-result', role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
    isError: false, content: [{ type: 'text', text: body }]
  } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
  if (${foreground}) {
    const invoke = async (callId, args) => {
      const batch = await ctx.tools.execute({ agent, signal: new AbortController().signal,
        calls: [{ type: 'tool-call', id: callId, name: 'skill_manage', arguments: JSON.stringify(args) }] });
      const message = batch.results?.[0]?.result;
      return message?.content?.[0]?.text ? { value: JSON.parse(message.content[0].text) } : batch;
    };
    const inspection = await invoke('skill-inspect', { action: 'inspect', uri });
    const learned = await invoke('skill-learn', { action: 'patch', uri, baseSha256: ${JSON.stringify(sha256(body))},
      reason: 'Preserve verified smoke procedure.', diff: ${JSON.stringify(patch)}, operations: [${JSON.stringify(attachment)}] });
    writeFileSync(${JSON.stringify(join(root, 'foreground.json'))}, JSON.stringify({ inspection, learned }));
  }
  session.append('step/end', { turn: generation, step: 1 });
  session.append('turn/end', { turn: generation, reason: { kind: 'completed' } });
  }
  await ctx.sessions.flush(session);
  if (generation === 1) await delay(1200);
  const manual = ${foreground} ? { status: 'foreground' } : await evolution.run(agent, 'manual');
  appendFileSync(${JSON.stringify(join(root, 'runtime.jsonl'))}, JSON.stringify({ generation, sessionId, provider: agent.provider, model: agent.model, manual }) + '\\n');
  } catch (error) {
    appendFileSync(${JSON.stringify(join(root, 'runtime.jsonl'))}, JSON.stringify({ generation, error: error.stack }) + '\\n');
  }
  }, 0);
}
`;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForFile(path, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const content = await readFile(path, 'utf8').catch(() => '');
    if (content) return content;
    await delay(100);
  }
  throw Error(`Timed out waiting for ${path}`);
}

async function waitForFileGeneration(path, generation, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const content = await readFile(path, 'utf8').catch(() => '');
    if (content && content.split('\n').some(line => { try { return JSON.parse(line).generation === generation; } catch { return false; } })) return content;
    await delay(100);
  }
  throw Error(`Timed out waiting for generation ${generation}`);
}

async function runGeneration(root, generation, overlay, port) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(root, 'profile'), DSH_AGENTS_HOME: join(root, 'agents'),
    HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), DSH_V02_GENERATION: String(generation), DSH_V02_ORIGIN: `http://127.0.0.1:${port}` };
  const child = spawn(runtime, [join(install, 'lib/bin.js'), '--profile', 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { logs = (logs + chunk).slice(-16000); });
  child.stderr.setEncoding('utf8').on('data', chunk => { logs = (logs + chunk).slice(-16000); });
  try {
    const runtimeLine = await waitForFileGeneration(join(root, 'runtime.jsonl'), generation);
    const rows = runtimeLine.trim().split('\n').map(JSON.parse);
    const current = rows.findLast(row => row.generation === generation);
    assert(current, `missing generation ${generation}`);
    assert(!current.error, current.error);
    return { child, logs, rows: [current], port };
  } catch (error) {
    child.kill('SIGTERM');
    const started = await readFile(join(root, 'started'), 'utf8').catch(() => 'missing');
    throw Error(`${error.message} (fixture=${started})\n${logs}`);
  }
}

test('isolated DSH Web v0.2 lifecycle, fixture inference, dashboard modes and restart', { timeout: 90000 }, async t => {
  if (!runtime || !install) {
    t.skip('Set DSH_NODE_EXECUTABLE and DSH_INSTALL_DIR to run the isolated DSH fixture.');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-v02-review-'));
  let child;
  try {
    for (const directory of ['home', 'tmp', 'Documents']) await mkdir(join(root, directory));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'skill-evolution-v02-fixture', version: '0.0.0', type: 'module' }));
    await writeFile(join(root, 'fixture-plugin.mjs'), hostPlugin(root));
    const overlay = join(root, 'overlay.yml');
    await writeFile(overlay, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(root, 'Documents'))}\n- id: agent-default-model\n  config:\n    provider: skill-fixture\n    model: skill-fixture\n- insert:\n    - id: skill-evolution-v02-fixture\n      name: ${JSON.stringify(join(root, 'fixture-plugin.mjs'))}\n`);
    const port = await freePort();
    const first = await runGeneration(root, 1, overlay, port);
    child = first.child;
    const loginUrl = first.logs.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
    assert(loginUrl, 'DSH login URL missing');
    const login = await fetch(loginUrl.trim(), { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert(cookie, 'DSH owner cookie missing');
    const dashboardUrl = `http://127.0.0.1:${port}/api/dsh-openviking-skill-evolution/dashboard`;
    const dashboard = await fetch(dashboardUrl, { headers: { Cookie: cookie } });
    assert.equal(dashboard.status, 200);
    const dashboardData = await dashboard.json();
    assert.equal(dashboardData.data.settings.mode, nativeAdapter ? 'auto' : 'approval');
    assert.equal(dashboardData.data.capabilities.run, true);
    const forbidden = await fetch(dashboardUrl, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reject', input: {} }) });
    assert.equal(forbidden.status, 200);
    assert.equal((await forbidden.json()).data.status, 'invalid_operation');
    const firstRows = first.rows;
    assert.equal(typeof firstRows[0].manual.status, 'string', JSON.stringify(firstRows[0]));
    assert.equal(firstRows[0].manual.status, foreground ? 'foreground' : 'deduped', JSON.stringify(firstRows[0]));
    assert.equal(dashboardData.data.proposals[0]?.status, nativeAdapter ? 'applied' : 'pending', JSON.stringify(dashboardData.data.history));
    const id = dashboardData.data.proposals[0].id;
    const action = async (action, input) => {
      const response = await fetch(dashboardUrl, { method: 'POST', headers: { Cookie: cookie, Origin: new URL(dashboardUrl).origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, input }) });
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    const preview = await action('preview', { id });
    assert.match(preview.diff, /\+Run smoke and check exit status\./);
    assert.deepEqual(preview.operations, [attachment]);
    if (foreground) {
      const { inspection, learned } = JSON.parse(await readFile(join(root, 'foreground.json'), 'utf8'));
      assert.equal(inspection.value?.status, 'read', JSON.stringify(inspection));
      assert.equal(learned.value?.proposalId, id, JSON.stringify(learned));
    }
    if (!nativeAdapter) assert.equal((await action('approve', { id })).status, 'applied');
    if (nativeAdapter) assert.deepEqual(await nativeAdapter.read(uri), { ...baseline, body: changedBody, files: { ...baseline.files, [attachment.path]: Buffer.from(attachment.content).toString('base64') }, metadata: { ...baseline.metadata, directories: [...new Set([...baseline.metadata.directories, 'references'])].sort() } });
    assert.equal((await action('rollback', { id })).status, 'rolled_back');
    if (nativeAdapter) assert.deepEqual(await nativeAdapter.read(uri), baseline);
    assert.equal((await action('settings', { revision: 0, mode: 'shadow' })).status, 'saved');
    const ledger = JSON.parse(await readFile(join(root, 'governance.json'), 'utf8'));
    assert.equal(ledger.settings.mode, 'shadow');
    if (!foreground) {
      assert.equal(ledger.runs.at(-1).provider, 'skill-fixture');
      assert.equal(ledger.runs.at(-1).model, 'skill-fixture');
    }
    child.kill('SIGTERM');
    await delay(400);
    const second = await runGeneration(root, 2, overlay, await freePort());
    child = second.child;
    const secondRows = second.rows;
    assert.equal(secondRows.at(-1).sessionId, 'dsh-v02-fixture-session');
    assert.equal(secondRows.at(-1).generation, 2);
    assert.equal(secondRows.at(-1).manual.status, foreground ? 'foreground' : 'deduped');
    const persisted = JSON.parse(await readFile(join(root, 'governance.json'), 'utf8'));
    assert.equal(persisted.runs.length, foreground ? 0 : 1);
    assert.equal(persisted.owner, nativeAdapter ? null : owner);
  } finally {
    child?.kill('SIGTERM');
    await delay(300);
    await rm(root, { recursive: true, force: true });
  }
});

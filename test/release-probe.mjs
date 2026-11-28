import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile, rename } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { contentsSha256, dashboardPath, model, provider, reviewer, seedReview, verifyPublicReview } from './release-gate.mjs';
import { startWriterFixture } from './release-ov-fixture.mjs';

export const inject = ['agents', 'commands', 'sessions', 'pluginManager', 'profileContext', 'hmr', 'connection', 'webServer', 'llm'];

export async function apply(ctx) {
  const firstGeneration = process.env.SKILL_EVOLUTION_RELEASE_PREVIOUS === undefined;
  const writer = firstGeneration ? await startWriterFixture() : undefined;
  const approvals = [];
  const memoryStates = new Map();
  if (writer) {
    ctx.effect(() => () => writer.close());
    ctx.provide('openvikingMemory', { config: writer.config, states: memoryStates });
    const reviewerModel = { provider, id: model, name: 'Release reviewer fixture', context: { contextWindow: 65536 } };
    ctx.llm.registerAdapter([provider], {
      providerInfo: id => ({ id, name: 'Release fixture' }), providerRetryPolicy: () => undefined,
      listModels: async () => [reviewerModel], resolveModel: async () => reviewerModel,
      prepareCall: async () => ({ model: reviewerModel, stream: ({ messages }) => reviewer(messages, approvals) }),
    });
  }
  // Cancel delayed work from any instance replaced during profile composition.
  const timer = setTimeout(async () => {
    const steps = [];
    let report;
    try {
      const spec = JSON.parse(await readFile(process.env.SKILL_EVOLUTION_RELEASE_INPUT, 'utf8'));
      const expected = join(await realpath(process.env.DSH_HOME), 'profiles', 'web');
      assert.equal(await realpath(ctx.profileContext.dir), expected);
      const { name, version, tarball, sha256, files } = spec;
      assert.equal(createHash('sha256').update(await readFile(tarball)).digest('hex'), sha256);
      const manager = ctx.pluginManager;
      const getBundle = async () => (await manager.listBundles()).find(bundle => bundle.name === name);
      const sessionId = 'skill-evolution-release';
      const uri = 'viking://user/fixture/skills/demo/SKILL.md';
      const previous = process.env.SKILL_EVOLUTION_RELEASE_PREVIOUS;
      const agentHandle = previous === undefined
        ? await ctx.agents.create({ sessionId, meta: { cwd: process.cwd() } })
        : await ctx.agents.resume({ resumeSessionId: sessionId });
      const { agent } = agentHandle;
      const { session } = agent;
      assert.equal(session.id, sessionId);
      const command = name => ctx.commands.find(agent, name);
      const execute = line => ctx.commands.execute(agent, line, [], AbortSignal.timeout(5000));
      const outcome = async line => {
        const response = await execute(line);
        assert.equal(response?.result.kind, 'success');
        return JSON.parse(response.result.text);
      };
      const changed = async (label, operation) => {
        const result = await operation;
        assert.equal(result.application, 'applied', JSON.stringify(result));
        assert.equal(result.changed, true, JSON.stringify(result));
        steps.push(label);
      };
      if (previous === undefined) {
        assert.equal(await getBundle(), undefined);
        assert.equal(command('skill-refine'), undefined);
        await changed('installed and enabled', manager.installBundle(tarball));
      }
      const bundle = await getBundle();
      assert.equal(bundle?.version, version);
      assert.equal(bundle?.enabled, true);
      assert.equal(bundle?.installed, true);
      assert.equal(bundle?.error, undefined);
      const packageDir = join(expected, 'node_modules', name);
      const packageRelative = relative(expected, await realpath(packageDir));
      assert(!packageRelative.startsWith(`..${sep}`) && packageRelative.startsWith(`node_modules${sep}`));
      for (const file of files) assert((await lstat(join(packageDir, file))).isFile(), file);
      const installedHash = await contentsSha256(packageDir, files);
      assert.equal(installedHash, spec.contentsSha256, 'installed file contents match the candidate');
      assert.equal(command('skill-refine')?.name, 'skill-refine');
      for (const name of ['skill-approve', 'skill-reject', 'skill-rollback']) assert.equal(command(name), undefined);

      if (previous === undefined) {
        const origin = `http://127.0.0.1:${ctx.webServer.port}`;
        const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
        const cookie = login.headers.get('set-cookie')?.split(';')[0];
        assert(cookie, 'fixture login established an owner session');
        async function request(action, input, currentSession) {
          const init = action === undefined ? { headers: { Cookie: cookie } } : {
            method: 'POST', headers: { Cookie: cookie, Origin: origin, 'content-type': 'application/json' },
            body: JSON.stringify({ action, input }),
          };
          const url = new URL(dashboardPath, origin);
          if (currentSession) url.searchParams.set('sessionId', currentSession);
          const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
          const result = await response.json();
          assert.equal(response.status, 200, JSON.stringify(result));
          assert.equal(result.ok, true);
          return result.data;
        }
        memoryStates.set(sessionId, { dshSessionId: sessionId, ovSessionId: 'release-ov-session', config: writer.config, ready: true });
        const currentMemory = (await request(undefined, undefined, sessionId)).memory;
        assert.equal(currentMemory.connection, 'observed');
        assert.equal(currentMemory.state, 'linked');
        assert.equal(currentMemory.ovSessionId, 'release-ov-session');
        assert.deepEqual((await request()).memory, { connection: 'observed', state: 'no_session' });
        steps.push('memory status finds an open session after installation');
        assert.deepEqual(await request('run', { sessionId }), { status: 'no_evidence' });
        steps.push('dashboard can review a session created before bundle installation');
        const proposalId = await checkProposal(session, outcome, uri);
        await ctx.sessions.flush(session);
        steps.push('skill-refine patch preview and deduplication');
        const publicReview = await verifyPublicReview({
          request, observed: approvals, liveBody: writer.liveBody, readbackConflict: true,
          async session(label, body, replacement) {
            const id = `release-review-${label}`;
            const { agent } = await ctx.agents.create({ sessionId: id, meta: { cwd: process.cwd() } });
            if (label === 'shadow') agent.model.select({ provider, model });
            seedReview((type, data, sourceEventSeqs) => agent.session.append(type, data,
              type === 'tool/call' ? undefined : { surfaceOp: 'append', sourceEventSeqs }), body, replacement);
            await ctx.sessions.flush(agent.session);
            return id;
          },
        });
        assert.deepEqual(writer.errors, []);
        assert.deepEqual(writer.writes, ['upload', 'replace', 'upload', 'replace']);
        steps.push('public reviewer submission, approval and fixture readback');
        report = { ok: true, steps, name, version, sha256, contentsSha256: installedHash, sessionId, proposalId, pid: process.pid,
          publicReview: { ...publicReview, writes: writer.writes } };
      } else {
        const first = JSON.parse(await readFile(previous, 'utf8'));
        assert.notEqual(process.pid, first.pid);
        assert.equal(first.sessionId, sessionId);
        assert.equal(first.sha256, sha256);
        const duplicate = await outcome(`/skill-refine ${uri}`);
        assert.equal(duplicate.reason, 'duplicate');
        assert.equal(duplicate.previousProposalId, first.proposalId);
        steps.push('persisted install and same-session deduplication after restart');
        await checkRemoval({ manager, name, packageDir, changed, getBundle, command, execute });
        report = { ok: true, steps, name, version, sha256, contentsSha256: installedHash, sessionId, pid: process.pid };
      }
    } catch (error) {
      report = { ok: false, steps, error: error.stack };
    }
    const result = process.env.SKILL_EVOLUTION_RELEASE_RESULT;
    await writeFile(`${result}.tmp`, JSON.stringify(report));
    await rename(`${result}.tmp`, result);
  });
  ctx.effect(() => () => clearTimeout(timer));
}

async function checkProposal(session, outcome, uri) {
  const body = '---\nname: demo\ndescription: Demo.\n---\n\nRun smoke.\n';
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  const tool = { id: 'release-read', name: 'mcp__openviking__read', arguments: JSON.stringify({ uri }) };
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: {
    id: 'release-assistant-message', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', ...tool }],
  } }, { surfaceOp: 'append' });
  const call = session.append('tool/call', { turn: 1, step: 1, callId: tool.id,
    name: tool.name, arguments: tool.arguments });
  const read = session.append('tool/result', { turn: 1, step: 1, message: {
    id: 'release-tool-message', role: 'tool', source: { kind: 'tool', callId: 'release-read' },
    toolCallId: 'release-read', isError: false, content: [{ type: 'text', text: body }],
  } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  session.append('user/message', { id: 'release-correction', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: `\u6280\u80fd\u7ea0\u6b63 ${uri}\n\u539f\u6587\uff1aRun smoke.\n\u6539\u4e3a\uff1aRun smoke and check exit status.\n\u539f\u56e0\uff1aVerify the result.` }],
  }, { surfaceOp: 'append' });
  const listing = await outcome('/skill-refine');
  assert.deepEqual(listing.loaded, [{ uri, readResultSeq: read.seq }]);
  assert.equal(listing.candidates[0].status, 'ready');
  assert.equal(listing.candidates[0].command, `/skill-refine ${uri}`);
  const proposal = await outcome(listing.candidates[0].command);
  assert.equal(proposal.action, 'patch');
  assert.equal(proposal.baseSha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(listing.candidates[0].baseSha256, proposal.baseSha256);
  assert.match(proposal.diff, /^\+Run smoke and check exit status\.$/m);
  assert.equal(proposal.approval, undefined);
  assert.equal((await outcome(listing.candidates[0].command)).reason, 'duplicate');
  return proposal.proposalId;
}

async function checkRemoval({ manager, name, packageDir, changed, getBundle, command, execute }) {
  const assertInactive = async () => {
    assert.equal(command('skill-refine'), undefined);
    assert.equal(await execute('/skill-refine'), undefined);
  };
  await changed('disabled', manager.setBundleEnabled(name, false));
  const disabled = await getBundle();
  assert.equal(disabled?.installed, true);
  assert.equal(disabled?.enabled, false);
  await assertInactive();
  await changed('re-enabled', manager.setBundleEnabled(name, true));
  assert.equal((await getBundle())?.enabled, true);
  assert.equal(command('skill-refine')?.name, 'skill-refine');
  await changed('removed', manager.removeBundle(name));
  assert.equal(await getBundle(), undefined);
  await assert.rejects(lstat(packageDir), { code: 'ENOENT' });
  await assertInactive();
}

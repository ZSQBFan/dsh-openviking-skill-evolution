import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile, rename } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const inject = ['agents', 'commands', 'sessions', 'pluginManager', 'profileContext', 'hmr'];

export function apply(ctx) {
  // Cancel delayed work from any instance replaced during profile composition.
  const timer = setTimeout(async () => {
    const steps = [];
    let report;
    try {
      const spec = JSON.parse(await readFile(process.env.SKILL_EVOLUTION_RELEASE_INPUT, 'utf8'));
      const expected = join(await realpath(process.env.DSH_HOME), 'profiles', 'web');
      assert.equal(await realpath(ctx.profileContext.dir), expected);
      const { name, version, tarball, sha256 } = spec;
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
      for (const file of ['package.json', 'index.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg']) {
        assert((await lstat(join(packageDir, file))).isFile(), file);
      }
      assert.equal(command('skill-refine')?.name, 'skill-refine');
      for (const name of ['skill-approve', 'skill-reject', 'skill-rollback']) assert.equal(command(name), undefined);

      if (previous === undefined) {
        const proposalId = await checkProposal(session, outcome, uri);
        await ctx.sessions.flush(session);
        steps.push('shadow proposal and deduplication');
        report = { ok: true, steps, name, version, sha256, sessionId, proposalId, pid: process.pid };
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
        report = { ok: true, steps, name, version, sha256, sessionId, pid: process.pid };
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

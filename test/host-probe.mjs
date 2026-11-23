import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as plugin from '../index.js';

export const inject = ['commands', 'sessions'];

export function apply(ctx) {
  setTimeout(async () => {
    try {
      const session = ctx.sessions.create('skill-evolution-probe');
      const agent = { ctx, session };
      const events = [];
      ctx.on('session/event', (source, event) => {
        if (source === session) events.push(event.type);
      });
      assert.equal(ctx.commands.find(agent, 'skill-refine'), undefined);
      const uri = 'viking://user/fixture/skills/demo/SKILL.md';
      const body = '---\nname: demo\ndescription: Demo.\n---\n\nRun smoke.\n';
      const original = { body, files: { 'asset.bin': 'AAEC' }, metadata: {} };
      let live = original;
      let writes = 0;
      const fork = ctx.plugin(plugin, { approval: {
        managedUri: uri, directory: join(dirname(process.env.SKILL_EVOLUTION_PROBE), 'approvals'),
        adapter: {
          mode: 'isolated-single-writer', read: async () => live,
          replace: async (_, next) => { live = next; writes++; },
          verifyIndex: async (_, expected) => expected.body === live.body,
        },
      } });
      for (let i = 0; i < 50 && !ctx.commands.find(agent, 'skill-refine'); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(ctx.commands.find(agent, 'skill-refine')?.name, 'skill-refine');
      const result = await ctx.commands.execute(agent, '/skill-refine', [], new AbortController().signal);
      assert.equal(result.result.kind, 'success');
      assert.deepEqual(events, ['command/run', 'command/done']);
      const call = session.append('tool/call', { turn: 1, step: 1, callId: 'fixture-read', name: 'mcp__openviking__read', arguments: JSON.stringify({ uris: [uri] }) });
      const read = session.append('tool/result', { turn: 1, step: 1, message: {
        id: 'fixture-tool-message', role: 'tool', source: { kind: 'tool', callId: 'fixture-read' },
        toolCallId: 'fixture-read', isError: false, content: [{ type: 'text', text: body }],
      } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
      session.append('user/message', { id: 'fixture-correction', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: `技能纠正 ${uri}\n原文：Run smoke.\n改为：Run smoke and check exit status.\n原因：Verify the result.` }],
      }, { surfaceOp: 'append' });
      const execute = () => ctx.commands.execute(agent, `/skill-refine ${uri}`, [], new AbortController().signal);
      const listing = JSON.parse((await ctx.commands.execute(agent, '/skill-refine', [], new AbortController().signal)).result.text);
      assert.deepEqual(listing.loaded, [{ uri, readResultSeq: read.seq }]);
      assert.equal(listing.candidates[0].command, `/skill-refine ${uri}`);
      assert.equal(listing.candidates[0].status, 'ready');
      const proposal = JSON.parse((await execute()).result.text);
      assert.equal(listing.candidates[0].baseSha256, proposal.baseSha256);
      assert.equal(proposal.action, 'patch');
      assert.equal(proposal.evidence.readResultSeq, read.seq);
      assert.match(proposal.diff, /\+Run smoke and check exit status\./);
      assert.equal(JSON.parse((await execute()).result.text).reason, 'duplicate');
      assert.equal(proposal.approval.status, 'pending');
      assert.equal(writes, 0);
      const token = `${proposal.proposalId} ${proposal.approval.approvalDigest}`;
      const vote = async command => JSON.parse((await ctx.commands.execute(agent, `/${command} ${token}`, [], new AbortController().signal)).result.text);
      assert.equal((await vote('skill-approve')).status, 'applied');
      assert.equal((await vote('skill-approve')).status, 'applied');
      assert.equal(writes, 1);
      assert.equal((await vote('skill-rollback')).status, 'rolled_back');
      assert.deepEqual(live, original);
      assert.equal(writes, 2);
      await fork.dispose();
      for (const name of ['skill-refine', 'skill-approve', 'skill-reject', 'skill-rollback']) {
        assert.equal(ctx.commands.find(agent, name), undefined);
      }
      assert.equal(await ctx.commands.execute(agent, '/skill-refine', [], new AbortController().signal), undefined);
      await writeFile(process.env.SKILL_EVOLUTION_PROBE, JSON.stringify({ ok: true, events, result: result.result.kind, proposal, duplicate: true, unloaded: true }));
    } catch (error) {
      await writeFile(process.env.SKILL_EVOLUTION_PROBE, JSON.stringify({ ok: false, error: error.stack }));
    }
  });
}

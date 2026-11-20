import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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
      const fork = ctx.plugin(plugin);
      for (let i = 0; i < 50 && !ctx.commands.find(agent, 'skill-refine'); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(ctx.commands.find(agent, 'skill-refine')?.name, 'skill-refine');
      const result = await ctx.commands.execute(agent, '/skill-refine', [], new AbortController().signal);
      assert.equal(result.result.kind, 'success');
      assert.deepEqual(events, ['command/run', 'command/done']);
      const uri = 'viking://user/fixture/skills/demo/SKILL.md';
      const body = '---\nname: demo\ndescription: Demo.\n---\n\nRun smoke.\n';
      const call = session.append('tool/call', { turn: 1, step: 1, callId: 'fixture-read', name: 'mcp__openviking__read', arguments: JSON.stringify({ uris: [uri] }) });
      const read = session.append('tool/result', { turn: 1, step: 1, message: {
        id: 'fixture-tool-message', role: 'tool', source: { kind: 'tool', callId: 'fixture-read' },
        toolCallId: 'fixture-read', isError: false, content: [{ type: 'text', text: body }],
      } }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
      session.append('user/message', { id: 'fixture-correction', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: `技能纠正 ${read.seq}\n原文：Run smoke.\n改为：Run smoke and check exit status.\n原因：Verify the result.` }],
      }, { surfaceOp: 'append' });
      const execute = () => ctx.commands.execute(agent, `/skill-refine ${uri}`, [], new AbortController().signal);
      const proposal = JSON.parse((await execute()).result.text);
      assert.equal(proposal.action, 'patch');
      assert.equal(proposal.evidence.readResultSeq, read.seq);
      assert.match(proposal.diff, /\+Run smoke and check exit status\./);
      assert.equal(JSON.parse((await execute()).result.text).reason, 'duplicate');
      await fork.dispose();
      assert.equal(ctx.commands.find(agent, 'skill-refine'), undefined);
      assert.equal(await ctx.commands.execute(agent, '/skill-refine', [], new AbortController().signal), undefined);
      await writeFile(process.env.SKILL_EVOLUTION_PROBE, JSON.stringify({ ok: true, events, result: result.result.kind, proposal, duplicate: true, unloaded: true }));
    } catch (error) {
      await writeFile(process.env.SKILL_EVOLUTION_PROBE, JSON.stringify({ ok: false, error: error.stack }));
    }
  });
}

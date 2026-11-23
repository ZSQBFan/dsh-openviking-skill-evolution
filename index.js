import { join } from 'node:path';
import { evidenceProjection } from './src/evidence.js';
import { listReviewCandidates, review } from './src/review.js';
import { createApprovalService } from './src/approval.js';

function result(outcome) {
  return { kind: 'success', text: JSON.stringify(outcome, null, 2) };
}

async function loadApproval(options) {
  const { directory, managedUri } = options;
  const adapter = options.adapter ?? (await import('./src/ov-adapter.js')).createOpenVikingAdapter(options);
  return createApprovalService({ directory, managedUri, adapter });
}

export const inject = ['commands', 'sessionProjections'];

export async function apply(ctx, config = {}) {
  const approval = config.approval ? await loadApproval(config.approval) : undefined;
  const projection = await ctx.sessionProjections.register(evidenceProjection);
  const profile = ctx.get('profileContext');
  const options = config.evolution ?? (profile?.dir && {
    directory: join(profile.dir, 'skill-evolution'), owner: null,
  });
  const evolution = options ? await (await import('./src/evolution.js')).mountEvolution(ctx, options, projection) : null;
  if (evolution) ctx.commands.register({
    name: 'skill-review', description: 'Run an immediate skill evolution review',
    handler: async ({ agent, signal }) => result(await evolution.run(agent, 'manual', signal)),
  });
  ctx.commands.register({
    name: 'skill-refine',
    description: 'Review OpenViking skill use in this session',
    input: { hint: '[canonical skill URI]' },
    handler: async ({ agent, rawInput }) => {
      const state = projection.stateOf(agent.session);
      const uri = rawInput.trim();
      const sessionId = String(agent.session.id);
      const outcome = uri ? review(state, sessionId, uri) : listReviewCandidates(state, sessionId);
      if (approval && outcome.action === 'patch' && outcome.uri === config.approval.managedUri) {
        const { status, approvalDigest } = await approval.stage(outcome);
        return result({ ...outcome, approval: { status, approvalDigest } });
      }
      return result(outcome);
    },
  });
  if (!approval) return;
  for (const [action, description] of [
    ['approve', 'Approve and apply a reviewed private skill patch'],
    ['reject', 'Reject a reviewed private skill patch'],
    ['rollback', 'Restore the skill package saved before application'],
  ]) {
    ctx.commands.register({
      name: `skill-${action}`,
      description,
      input: { hint: '<proposal ID> <approval digest>' },
      handler: async ({ agent, rawInput, signal }) => {
        const match = /^([a-f0-9]{64})\s+([a-f0-9]{64})$/.exec(rawInput.trim());
        if (!match) return { kind: 'error', text: 'Expected a proposal ID and approval digest' };
        signal.throwIfAborted();
        const [ , id, digest ] = match;
        const { status } = await approval[action]({ id, digest, sessionId: String(agent.session.id), signal });
        return result({ status, proposalId: id });
      },
    });
  }
}

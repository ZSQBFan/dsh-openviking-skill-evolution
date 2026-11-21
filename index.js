import { evidenceProjection } from './src/evidence.js';
import { review } from './src/review.js';
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
  ctx.commands.register({
    name: 'skill-refine',
    description: 'Review OpenViking skill use in this session',
    input: { hint: '[canonical skill URI]' },
    handler: async ({ agent, rawInput }) => {
      const state = projection.stateOf(agent.session);
      const uri = rawInput.trim();
      const outcome = uri ? review(state, String(agent.session.id), uri) : {
        action: 'no_change', reason: 'select_skill',
        loaded: state.evidence.filter(item => item.uri).map(({ uri, seq }) => ({ uri, readResultSeq: seq })),
      };
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

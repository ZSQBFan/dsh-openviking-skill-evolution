import { evidenceProjection } from './src/evidence.js';
import { review } from './src/review.js';

export const inject = ['commands', 'sessionProjections'];

export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register(evidenceProjection);
  ctx.commands.register({
    name: 'skill-refine',
    description: 'Review OpenViking skill use in this session',
    input: { hint: '[canonical skill URI]' },
    handler: ({ agent, rawInput }) => {
      const state = projection.stateOf(agent.session);
      const uri = rawInput.trim();
      const outcome = uri ? review(state, String(agent.session.id), uri) : {
        action: 'no_change', reason: 'select_skill',
        loaded: state.evidence.filter(item => item.uri).map(({ uri, seq }) => ({ uri, readResultSeq: seq })),
      };
      return { kind: 'success', text: JSON.stringify(outcome, null, 2) };
    },
  });
}

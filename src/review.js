import { createHash } from 'node:crypto';
import { isSkillUri } from './evidence.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const noChange = reason => ({ action: 'no_change', reason });

function patch(skill, correction, sessionId) {
  const [, , before, after, rationale] = /^技能纠正 (\d+)\n原文：([^\r\n]+)\n改为：([^\r\n]+)\n原因：([^\r\n]+)$/u.exec(correction.text) ?? [];
  if (!before || !after || !rationale) return noChange('invalid_correction');
  const body = skill.body.slice(skill.frontmatter.length);
  const lines = body.split(/\r?\n/);
  const index = lines.indexOf(before);
  if (index < 0 || lines.lastIndexOf(before) !== index || before === after || /^---\s*$/.test(after)) return noChange('change_not_unique');
  const line = skill.frontmatter.split('\n').length + index;
  return {
    action: 'patch', uri: skill.uri, baseSha256: digest(skill.body), reason: rationale,
    evidence: { sessionId, readCallSeq: skill.callSeq, readResultSeq: skill.seq, userSeq: correction.seq },
    diff: `--- ${skill.uri}\n+++ ${skill.uri}\n@@ -${line} +${line} @@\n-${before}\n+${after}\n`,
  };
}

function create(uri, experience, sessionId) {
  const [, description, step, reason] = /^技能经验 [^\r\n]+\n描述：([^\r\n]+)\n步骤：([^\r\n]+)\n原因：([^\r\n]+)$/u.exec(experience.text) ?? [];
  if (!description || !step || !reason) return noChange('invalid_experience');
  const name = uri.split('/').at(-2);
  const lines = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, '---', '', `- ${step}`];
  return {
    action: 'create', uri, baseSha256: null, reason, existence: 'unverified',
    evidence: { sessionId, userSeq: experience.seq },
    diff: `--- /dev/null\n+++ ${uri}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`,
  };
}

export function review(state, sessionId, uri) {
  if (!isSkillUri(uri)) return noChange('canonical_skill_uri_required');
  const history = state.evidence;
  const successful = history.filter(event => event.type === 'tool/result' && event.uri === uri);
  const latest = successful.at(-1);
  const userEvidence = history.filter(event => event.type === 'user/message');
  const targetName = uri.split('/').at(-2);
  const blocked = history.some(event => event.type === 'tool/result' && event.seq > (latest?.seq ?? -1)
    && (event.requestedUri === uri || (uri.startsWith('viking://user/') && event.requestedUri === `viking://~/skills/${targetName}/SKILL.md`)));
  const corrections = userEvidence.filter(event => {
    const seq = /^技能纠正 (\d+)\n/u.exec(event.text)?.[1];
    return seq != null && successful.some(read => read.seq === Number(seq) && read.seq < event.seq);
  });
  const correction = corrections.at(-1);
  const experience = userEvidence.filter(event => event.text.startsWith(`技能经验 ${uri}\n`)).at(-1);
  let proposal;
  if (blocked) return noChange('latest_read_unusable');
  if (correction) {
    const cited = successful.find(read => read.seq === Number(/^技能纠正 (\d+)\n/u.exec(correction.text)[1]));
    if (cited.body !== latest.body) return noChange('stale_read');
    proposal = patch(cited, correction, sessionId);
  } else if (experience && !latest && /^viking:\/\/user\/[A-Za-z0-9_.-]+\/skills\/[a-z0-9-]+\/SKILL\.md$/.test(uri)) {
    proposal = create(uri, experience, sessionId);
  } else {
    return noChange('no_learning_evidence');
  }
  if (proposal.action === 'no_change') return proposal;
  const proposalId = digest(JSON.stringify(proposal));
  if (history.some(event => event.id === proposalId)) return { ...noChange('duplicate'), previousProposalId: proposalId };
  return { ...proposal, proposalId };
}

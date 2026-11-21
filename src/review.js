import { createHash } from 'node:crypto';
import { isSkillUri } from './evidence.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const noChange = reason => ({ action: 'no_change', reason });
const NO_NEWLINE = '\\ No newline at end of file';

function patch(skill, correction, sessionId) {
  const [, , before, after, rationale] = /^技能纠正 (\d+)\n原文：([^\r\n]+)\n改为：([^\r\n]+)\n原因：([^\r\n]+)$/u.exec(correction.text) ?? [];
  if (!before || !after || !rationale) return noChange('invalid_correction');
  const body = skill.body.slice(skill.frontmatter.length);
  const rawLines = body.split('\n');
  const lines = rawLines.map((line, index) => index < rawLines.length - 1 ? line.replace(/\r$/, '') : line);
  const index = lines.indexOf(before);
  if (index < 0 || lines.lastIndexOf(before) !== index || before === after || /^---\s*$/.test(after)) return noChange('change_not_unique');
  const line = skill.frontmatter.split('\n').length + index;
  const ending = index === rawLines.length - 1 ? `\n${NO_NEWLINE}\n` : rawLines[index] === before ? '\n' : '\r\n';
  return {
    action: 'patch', uri: skill.uri, baseSha256: digest(skill.body), reason: rationale,
    evidence: { sessionId, readCallSeq: skill.callSeq, readResultSeq: skill.seq, userSeq: correction.seq },
    diff: `--- ${skill.uri}\n+++ ${skill.uri}\n@@ -${line} +${line} @@\n-${before}${ending}+${after}${ending}`,
  };
}

// Apply the single-line patch emitted by review to the exact supplied base.
export function applySkillDiff(base, diff, uri) {
  if (typeof base !== 'string' || typeof diff !== 'string' || !isSkillUri(uri)) throw new Error('invalid_skill_diff');
  const [oldHeader, newHeader, hunk, ...body] = diff.split('\n');
  const line = Number(/^@@ -([1-9]\d*) \+\1 @@$/.exec(hunk)?.[1]);
  if (oldHeader !== `--- ${uri}` || newHeader !== `+++ ${uri}` || !Number.isSafeInteger(line) || body.pop() !== '') {
    throw new Error('invalid_skill_diff');
  }
  const unterminated = body.length === 4 && body[1] === NO_NEWLINE && body[3] === NO_NEWLINE;
  if (!unterminated && body.length !== 2) throw new Error('invalid_skill_diff');
  const oldLine = /^-([^\r\n]+)(\r?)$/.exec(body[0]);
  const newLine = /^\+([^\r\n]+)(\r?)$/.exec(body[unterminated ? 2 : 1]);
  if (!oldLine || !newLine || oldLine[2] !== newLine[2] || (unterminated && oldLine[2])) {
    throw new Error('invalid_skill_diff');
  }
  const lines = base.split('\n');
  const index = line - 1;
  if (lines[index] !== oldLine[0].slice(1) || unterminated !== (index === lines.length - 1)) {
    throw new Error('skill_diff_base_mismatch');
  }
  lines[index] = newLine[0].slice(1);
  return lines.join('\n');
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
  const homeAlias = uri.startsWith('viking://user/') ? uri.replace(/^viking:\/\/user\/[^/]+/, 'viking://~') : null;
  const blocked = history.some(event => event.type === 'tool/result' && event.seq > (latest?.seq ?? -1)
    && (event.requestedUris.includes(uri) || event.requestedUris.includes(homeAlias)));
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

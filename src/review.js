import { createHash } from 'node:crypto';
import { isSkillUri } from './evidence.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const noChange = reason => ({ action: 'no_change', reason });
const NO_NEWLINE = '\\ No newline at end of file';
const correctionTarget = text => /^技能纠正 ([^\r\n]+)\r?\n/u.exec(text)?.[1];

function patch(skill, correction, sessionId) {
  const [, before, after, rationale] = /^技能纠正 [^\r\n]+\r?\n原文：([^\r\n]+)\r?\n改为：([^\r\n]+)\r?\n原因：([^\r\n]+)$/u.exec(correction.text) ?? [];
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

// Apply ordered unified hunks to an exact base without modifying frontmatter.
export function applySkillDiff(base, diff, uri) {
  if (typeof base !== 'string' || typeof diff !== 'string' || diff.length > 24000 || !isSkillUri(uri)) throw Error('invalid_skill_diff');
  const [oldHeader, newHeader, ...patchLines] = diff.split('\n');
  if (oldHeader !== `--- ${uri}` || newHeader !== `+++ ${uri}` || patchLines.pop() !== '') throw Error('invalid_skill_diff');
  const source = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const originalFrontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(base)?.[0];
  if (!originalFrontmatter) throw Error('invalid_skill_diff');
  const frontmatterLines = originalFrontmatter.split('\n').length - 1;
  const output = [];
  let cursor = 0;
  let index = 0;
  let modifications = 0;
  while (index < patchLines.length) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(patchLines[index++]);
    if (!hunk) throw Error('invalid_skill_diff');
    const oldCount = Number(hunk[2] ?? 1);
    const newCount = Number(hunk[4] ?? 1);
    const start = Number(hunk[1]) - (oldCount === 0 ? 0 : 1);
    const newStart = Number(hunk[3]) - (newCount === 0 ? 0 : 1);
    if (![oldCount, newCount, start, newStart].every(Number.isSafeInteger) || start < cursor || start > source.length ||
        newStart !== output.length + start - cursor || (oldCount === 0 && newCount === 0)) throw Error('invalid_skill_diff');
    output.push(...source.slice(cursor, start));
    cursor = start;
    let removed = 0;
    let added = 0;
    while (index < patchLines.length && !patchLines[index].startsWith('@@ ')) {
      const line = patchLines[index++];
      const marker = line[0];
      if (![' ', '-', '+'].includes(marker)) throw Error('invalid_skill_diff');
      const unterminated = patchLines[index] === NO_NEWLINE;
      if (unterminated) index++;
      const content = line.slice(1) + (unterminated ? '' : '\n');
      if (marker !== ' ' && cursor < frontmatterLines) throw Error('invalid_skill_diff');
      if (marker !== '+') {
        if (source[cursor++] !== content) throw Error('skill_diff_base_mismatch');
        removed++;
      }
      if (marker !== '-') {
        output.push(content);
        added++;
      }
      if (marker !== ' ') modifications++;
    }
    if (removed !== oldCount || added !== newCount) throw Error('invalid_skill_diff');
  }
  output.push(...source.slice(cursor));
  const result = output.join('');
  if (modifications === 0 || result === base || output.slice(0, -1).some(line => !line.endsWith('\n')) ||
      !result.startsWith(originalFrontmatter)) throw Error('invalid_skill_diff');
  return result;
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

export function applyCreateDiff(diff, uri) {
  if (typeof diff !== 'string' || diff.length > 24000 || !isSkillUri(uri)) throw Error('invalid_create_diff');
  const [oldHeader, newHeader, hunk, ...lines] = diff.split('\n');
  const count = Number(/^@@ -0,0 \+1,([1-9]\d*) @@$/.exec(hunk)?.[1]);
  if (oldHeader !== '--- /dev/null' || newHeader !== `+++ ${uri}` || lines.pop() !== '' ||
      count !== lines.length || !lines.every(line => line.startsWith('+') && !line.includes('\r'))) {
    throw Error('invalid_create_diff');
  }
  const body = lines.map(line => line.slice(1)).join('\n') + '\n';
  const name = uri.split('/').at(-2);
  if (!body.startsWith(`---\nname: ${name}\ndescription: `) || !/^description: .+\n---\n/m.test(body)) {
    throw Error('invalid_create_frontmatter');
  }
  return body;
}

function relatedReads(history, uri) {
  const homeAlias = uri.startsWith('viking://user/') ? uri.replace(/^viking:\/\/user\/[^/]+/, 'viking://~') : null;
  return history.filter(event => event.type === 'tool/result' &&
    (event.uri === uri || event.requestedUris.includes(uri) || event.requestedUris.includes(homeAlias)));
}

export function listReviewCandidates(state, sessionId) {
  const loaded = state.evidence.filter(item => item.uri);
  const uris = new Set();
  for (const event of state.evidence) {
    if (event.type === 'tool/result') {
      for (const uri of [event.uri, ...event.requestedUris]) if (isSkillUri(uri)) uris.add(uri);
    } else if (event.type === 'user/message') {
      const uri = /^(?:技能纠正|技能经验) ([^\r\n]+)\r?\n/u.exec(event.text)?.[1];
      if (isSkillUri(uri)) uris.add(uri);
    }
  }
  return {
    action: 'no_change', reason: uris.size ? 'select_skill' : 'no_candidates',
    loaded: loaded.map(({ uri, seq }) => ({ uri, readResultSeq: seq })),
    candidates: [...uris].map(uri => {
      const latest = relatedReads(state.evidence, uri).at(-1);
      const draft = review(state, sessionId, uri);
      return {
        uri, scope: uri.startsWith('viking://agent/') ? 'shared' : 'private',
        command: `/skill-refine ${uri}`,
        ...(latest && { readResultSeq: latest.seq, readStatus: latest.uri === uri ? 'complete' : 'unusable' }),
        ...(latest?.uri === uri && { baseSha256: digest(latest.body) }),
        status: draft.action === 'no_change' ? draft.reason : 'ready',
      };
    }),
  };
}

export function review(state, sessionId, uri) {
  if (!isSkillUri(uri)) return noChange('canonical_skill_uri_required');
  const history = state.evidence;
  const successful = history.filter(event => event.type === 'tool/result' && event.uri === uri);
  const latest = successful.at(-1);
  const userEvidence = history.filter(event => event.type === 'user/message');
  const observed = relatedReads(history, uri);
  const blocked = observed.at(-1)?.seq > (latest?.seq ?? -1);
  const correction = userEvidence.findLast(event => {
    const target = correctionTarget(event.text);
    return target === uri || (/^\d+$/.test(target ?? '') && successful.some(read => read.seq === Number(target) && read.seq < event.seq));
  });
  const experience = userEvidence.filter(event => event.text.startsWith(`技能经验 ${uri}\n`)).at(-1);
  let proposal;
  if (blocked) return noChange('latest_read_unusable');
  if (correction) {
    const target = correctionTarget(correction.text);
    const cited = target === uri
      ? observed.findLast(read => read.seq < correction.seq)
      : successful.find(read => read.seq === Number(target));
    if (cited?.uri !== uri) return noChange('correction_read_required');
    if (cited.body !== latest?.body) return noChange('stale_read');
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

import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { saveState } from './approval.js';
import { isSkillUri } from './evidence.js';

const DAY = 86_400_000;
export async function createCurator({ directory, owner, now = Date.now }) {
  if (!isAbsolute(directory) || (owner !== null && !/^[A-Za-z0-9_.-]+$/.test(owner ?? ''))) throw Error('Invalid curator scope');
  const target = join(directory, 'curator.json');
  const prefix = owner === null ? null : `viking://user/${owner}/skills/`;
  const managed = uri => Boolean(prefix) && isSkillUri(uri) && uri.startsWith(prefix);
  let state;
  try { state = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { version: 1, owner, nextScan: now() + DAY, skills: {}, usage: {}, audit: [] };
    await saveState(directory, target, state);
  }
  if (state.version !== 1 || state.owner !== owner) throw Error('Curator state belongs to a different scope');
  let queue = Promise.resolve();
  function modify(change) {
    const operation = queue.then(async () => {
      const next = structuredClone(state);
      const result = change(next);
      if (result.changed) {
        await saveState(directory, target, next);
        state = next;
      }
      return result.value;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  function transition(next, uri, status, source) {
    const entry = next.skills[uri];
    entry.status = status;
    entry.updatedAt = now();
    next.audit = [...next.audit, { uri, status, source, at: entry.updatedAt }].slice(-200);
  }
  const snapshot = () => ({
    usage: { skills: Object.entries(state.usage).map(([uri, { loads, lastUsed }]) => ({ uri, loads, lastUsed })) },
    curator: { status: 'ready', scope: 'this-dsh-profile', nextScan: state.nextScan,
      skills: Object.entries(state.skills).map(([uri, entry]) => ({ uri, ...entry,
        actions: entry.status === 'archived' ? ['restore'] : ['archive'] })), audit: structuredClone(state.audit) },
  });
  function setStatus(uri, status) {
    return modify(next => {
      if (!managed(uri) || !next.skills[uri]) return { value: 'out_of_scope' };
      if (next.skills[uri].status === status) return { value: status };
      transition(next, uri, status, 'operator');
      if (status === 'active') next.skills[uri].baseline = now();
      return { value: status, changed: true };
    });
  }
  return {
    snapshot,
    adopt(uri, source = 'operator') {
      return modify(next => {
        if (!managed(uri)) return { value: 'out_of_scope' };
        if (next.skills[uri]) return { value: next.skills[uri].status };
        next.skills[uri] = { source, baseline: now() };
        transition(next, uri, 'active', source);
        return { value: 'active', changed: true };
      });
    },
    archive: uri => setStatus(uri, 'archived'),
    restore: uri => setStatus(uri, 'active'),
    isArchived: uri => state.skills[uri]?.status === 'archived',
    loaded({ uri, sessionId, seq, at }) {
      return modify(next => {
        if (!isSkillUri(uri) || typeof sessionId !== 'string' || !Number.isSafeInteger(seq) || !Number.isFinite(at)) return {};
        const usage = next.usage[uri] ??= { loads: 0, lastUsed: 0, sessions: {} };
        const key = `s:${sessionId}`;
        if (seq <= (usage.sessions[key] ?? -1)) return {};
        usage.sessions[key] = seq;
        usage.loads++;
        usage.lastUsed = Math.max(usage.lastUsed, at);
        if (next.skills[uri]?.status === 'stale') transition(next, uri, 'active', 'load');
        return { changed: true };
      });
    },
    async scan({ manual = false } = {}) {
      await modify(next => {
        const current = now();
        if (!manual && current < next.nextScan) return {};
        next.nextScan = current + DAY;
        for (const [uri, entry] of Object.entries(next.skills)) {
          if (entry.status === 'archived') continue;
          const elapsed = current - Math.max(entry.baseline, next.usage[uri]?.lastUsed ?? 0);
          const status = elapsed >= 90 * DAY ? 'archived' : elapsed >= 30 * DAY ? 'stale' : 'active';
          if (status !== entry.status) transition(next, uri, status, 'scheduled_scan');
        }
        return { changed: true };
      });
      return snapshot().curator;
    },
    blocks(name, args) {
      if (!/^mcp__openviking__(read|multi_read|download|open|overview|abstract)$/.test(name)) return false;
      const uris = [args?.uri, ...(Array.isArray(args?.uris) ? args.uris : [args?.uris])];
      return uris.some(input => {
        if (typeof input !== 'string') return false;
        const uri = prefix ? input.replace(/^viking:\/\/~\/skills\//, prefix) : input;
        return Object.entries(state.skills).some(([definition, entry]) => {
          if (entry.status !== 'archived') return false;
          const root = definition.slice(0, -'/SKILL.md'.length);
          return uri === root || uri.startsWith(`${root}/`);
        });
      });
    },
  };
}

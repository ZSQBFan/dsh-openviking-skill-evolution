import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { skillArchive, validPackagePath } from './skill-archive.js';

export class SkillSnapshotConflict extends Error {}

const MAX_BYTES = 16 * 1024 * 1024;
const sha256 = data => createHash('sha256').update(data).digest('hex');

const generated = new Set(['.abstract.md', '.overview.md', '.source.json']);

function sameFiles(left, right) {
  const paths = Object.keys(left);
  return paths.length === Object.keys(right).length &&
    paths.every(path => Object.hasOwn(right, path) && left[path] === right[path]);
}

function sameDirectories(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function createOpenVikingAdapter({ origin, managedUri, mode, apiKey, nativeHeaders = {} }) {
  const base = new URL(origin);
  const loopback = base.protocol === 'http:' && base.hostname === '127.0.0.1' && Boolean(base.port);
  const supported = (mode === 'isolated-single-writer' && loopback) ||
    (mode === 'native-verified-readback' && (base.protocol === 'https:' || loopback));
  if (!supported || base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
    throw Error('Unsupported OpenViking writer endpoint');
  }
  const match = /^(viking:\/\/user\/[A-Za-z0-9_.-]+\/skills)\/([a-zA-Z0-9_-]{1,64})\/SKILL\.md$/.exec(managedUri);
  if (!match) throw Error('Expected one canonical private skill');
  const [, target, skill] = match;
  const packageUri = `${target}/${skill}`;
  const endpoint = `/api/v1/skills/${encodeURIComponent(skill)}`;
  const headers = { ...(apiKey ? { 'X-API-Key': apiKey } : {}), ...nativeHeaders };
  function requireManaged(uri) {
    if (uri !== managedUri) throw Error('Unexpected skill scope');
  }
  async function request(operation, path, options = {}) {
    const response = await fetch(new URL(path, base), {
      ...options, redirect: 'error', headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(15000),
    }).catch(error => {
      if (error.name === 'TimeoutError') throw Error('ov_request_timeout');
      throw Error('ov_network_error');
    });
    if (!response.ok) {
      const error = Error(`OpenViking request failed (${response.status})`);
      error.status = response.status;
      error.ovRequest = { status: response.status, operation };
      if (response.status === 404) error.code = (await response.json().catch(() => null))?.error?.code;
      throw error;
    }
    return response;
  }
  async function json(operation, path, options) {
    const payload = await (await request(operation, path, options)).json();
    if (payload.status !== 'ok' || !payload.result) throw Error('OpenViking returned an incomplete result');
    return payload.result;
  }
  async function assertNoSkillPrivacy() {
    // Listing returns target names only. Do not fetch or persist secret values.
    const names = await json('privacy_list', '/api/v1/privacy-configs/skill');
    if (!Array.isArray(names) || names.some(value => typeof value !== 'string') || names.includes(skill)) {
      throw Error('Skill privacy settings are present or could not be ruled out');
    }
  }
  async function detailOfSkill() {
    const query = new URLSearchParams({ target_uri: target, level: '2', include_files: 'true', include_integrity: 'true', include_source: 'true' });
    const detail = await json('skill_detail', `${endpoint}?${query}`);
    if (detail.root_uri !== packageUri) throw Error('Unexpected skill package');
    return detail;
  }
  async function read(uri) {
    requireManaged(uri);
    const detail = await detailOfSkill().catch(error => {
      if (error.status === 404 && error.code === 'NOT_FOUND') return null;
      throw error;
    });
    if (detail === null) return null;
    if (typeof detail.content !== 'string' || !Array.isArray(detail.files) || detail.files.length > 255 ||
        sha256(detail.content) !== detail.content_sha256) throw Error('Incomplete skill package manifest');
    const files = new Map();
    const directories = [];
    let total = 0;
    let bodyVerified = false;
    const seen = new Set();
    for (const item of detail.files) {
      const path = item.path;
      if (!validPackagePath(path) || seen.has(path) || item.uri !== `${packageUri}/${path}`) throw Error('Invalid skill file manifest');
      seen.add(path);
      if (generated.has(path.split('/').at(-1))) continue;
      if (item.is_dir === true) {
        directories.push(path);
        continue;
      }
      if (item.is_dir !== false || !Number.isSafeInteger(item.size) || item.size < 0 || (total += item.size) > MAX_BYTES) {
        throw Error('Skill package exceeds supported snapshot limits');
      }
      const query = new URLSearchParams({ uri: item.uri });
      const bytes = Buffer.from(await (await request('file_download', `/api/v1/content/download?${query}`)).arrayBuffer());
      if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw Error('Skill changed during the snapshot');
      if (path === 'SKILL.md') {
        if (sha256(bytes) !== detail.content_sha256) throw Error('Skill Markdown differs from the manifest');
        bodyVerified = true;
      } else files.set(path, bytes.toString('base64'));
    }
    if (!bodyVerified) throw Error('Skill Markdown is absent from the manifest');
    return { body: detail.content, files: Object.fromEntries(files), metadata: { directories: directories.sort(), source: detail.source ?? null } };
  }

  async function upload(next, signal) {
    if (signal?.aborted) return null;
    const form = new FormData();
    form.append('file', new Blob([skillArchive(next)], { type: 'application/zip' }), `${skill}.zip`);
    const { temp_file_id } = await json('temp_upload', '/api/v1/resources/temp_upload', { method: 'POST', body: form });
    if (typeof temp_file_id !== 'string' || !temp_file_id) throw Error('OpenViking did not accept the temporary archive');
    if (signal?.aborted) return null;
    return JSON.stringify({ target_uri: target, temp_file_id, wait: true,
      ...(next.metadata.source ? { source_metadata: next.metadata.source } : {}) });
  }

  async function indexedSkills(scope) {
    const response = await json('skill_search', '/api/v1/skills/find', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: skill, target_uri: scope, limit: 20, score_threshold: 0 }),
    });
    if (!Array.isArray(response.skills)) throw Error('Unexpected skill index response');
    return response.skills.filter(item => [managedUri, packageUri].includes(item.root_uri ?? item.uri));
  }

  return {
    mode, read,
    matchesCreated(uri, expected, live) {
      requireManaged(uri);
      const source = live.metadata.source;
      if (!sameFiles(expected.files, live.files) || !sameDirectories(expected.metadata.directories, live.metadata.directories) ||
          source?.type !== 'skill_evolution' ||
          source.skill_name !== skill || source.tracked !== true || source.metadata_uri !== `${packageUri}/.source.json` ||
          Object.keys(source).length !== 4) return false;
      const parse = body => /^---\nname: ([a-z0-9_-]+)\ndescription: ([^\n]+)\n---\n([\s\S]*)$/.exec(body);
      const proposed = parse(expected.body);
      const stored = parse(live.body);
      if (!proposed || !stored || proposed[1] !== skill || stored[1] !== skill || proposed[3].trimEnd() !== stored[3]) return false;
      try {
        const description = JSON.parse(proposed[2]);
        const value = stored[2];
        return value.startsWith('"') ? description === JSON.parse(value)
          : value.startsWith("'") && value.endsWith("'") ? description === value.slice(1, -1).replaceAll("''", "'")
          : description === value;
      } catch { return false; }
    },
    async create(uri, next, _previous, signal) {
      requireManaged(uri);
      const body = await upload(next, signal);
      if (!body) return false;
      await json('skill_create', '/api/v1/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    },
    async remove(uri, _previous, signal) {
      requireManaged(uri);
      if (signal?.aborted) return false;
      const query = new URLSearchParams({ target_uri: target });
      await json('skill_remove', `${endpoint}?${query}`, { method: 'DELETE' });
    },
    async verifyAbsent(uri) {
      requireManaged(uri);
      return (await indexedSkills(target)).length === 0;
    },
    async preflight(uri, next) {
      requireManaged(uri);
      if (/\{\{\s*ov_privacy:/i.test(next?.body ?? '')) throw Error('Skill privacy references are outside write scope');
      await assertNoSkillPrivacy();
    },
    async replace(uri, next, previous, signal) {
      requireManaged(uri);
      const body = await upload(next, signal);
      if (!body) return false;
      if (mode === 'native-verified-readback') {
        const live = await read(uri);
        if (!isDeepStrictEqual(live, previous)) throw new SkillSnapshotConflict('Skill changed during archive upload');
        if (signal?.aborted) return false;
      }
      await json('skill_replace', endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    },
    async verifyIndex(uri, snapshot) {
      requireManaged(uri);
      const detail = await detailOfSkill();
      if (detail.content_sha256 !== sha256(snapshot.body)) return false;
      return (await indexedSkills(packageUri)).some(item => item.description === detail.description);
    },
  };
}

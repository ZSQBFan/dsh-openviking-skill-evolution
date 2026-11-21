import { createHash } from 'node:crypto';
import { skillArchive, validPackagePath } from './skill-archive.js';

const MAX_BYTES = 16 * 1024 * 1024;
const sha256 = data => createHash('sha256').update(data).digest('hex');

const generated = new Set(['.abstract.md', '.overview.md', '.source.json']);

export function createOpenVikingAdapter({ origin, managedUri, mode, apiKey }) {
  const base = new URL(origin);
  if (mode !== 'isolated-single-writer' || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' ||
      !base.port || base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
    throw Error('OpenViking approvals require an explicitly isolated loopback server with one writer');
  }
  const match = /^(viking:\/\/user\/[A-Za-z0-9_.-]+\/skills)\/([a-zA-Z0-9_-]{1,64})\/SKILL\.md$/.exec(managedUri);
  if (!match) throw Error('Expected one canonical private skill');
  const [, target, skill] = match;
  const packageUri = `${target}/${skill}`;
  const endpoint = `/api/v1/skills/${encodeURIComponent(skill)}`;
  const headers = apiKey ? { 'X-API-Key': apiKey } : {};
  function requireManaged(uri) {
    if (uri !== managedUri) throw Error('Unexpected skill scope');
  }
  async function request(path, options = {}) {
    const response = await fetch(new URL(path, base), {
      ...options, redirect: 'error', headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error(`OpenViking request failed (${response.status})`);
    return response;
  }
  async function json(path, options) {
    const payload = await (await request(path, options)).json();
    if (payload.status !== 'ok' || !payload.result) throw Error('OpenViking returned an incomplete result');
    return payload.result;
  }
  async function assertNoSkillPrivacy() {
    // Listing returns target names only. Do not fetch or persist secret values.
    const names = await json('/api/v1/privacy-configs/skill');
    if (!Array.isArray(names) || names.some(value => typeof value !== 'string') || names.includes(skill)) {
      throw Error('Skill privacy settings are present or could not be ruled out');
    }
  }
  async function detailOfSkill() {
    const query = new URLSearchParams({ target_uri: target, level: '2', include_files: 'true', include_integrity: 'true', include_source: 'true' });
    const detail = await json(`${endpoint}?${query}`);
    if (detail.root_uri !== packageUri) throw Error('Unexpected skill package');
    return detail;
  }
  async function read(uri) {
    requireManaged(uri);
    const detail = await detailOfSkill();
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
      const bytes = Buffer.from(await (await request(`/api/v1/content/download?${query}`)).arrayBuffer());
      if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw Error('Skill changed during the snapshot');
      if (path === 'SKILL.md') {
        if (sha256(bytes) !== detail.content_sha256) throw Error('Skill Markdown differs from the manifest');
        bodyVerified = true;
      } else files.set(path, bytes.toString('base64'));
    }
    if (!bodyVerified) throw Error('Skill Markdown is absent from the manifest');
    return { body: detail.content, files: Object.fromEntries(files), metadata: { directories: directories.sort(), source: detail.source ?? null } };
  }

  return {
    mode, read,
    async preflight(uri, next) {
      requireManaged(uri);
      if (/\{\{\s*ov_privacy:/i.test(next.body)) throw Error('Skill privacy references are outside write scope');
      await assertNoSkillPrivacy();
    },
    async replace(uri, next, _previous, signal) {
      requireManaged(uri);
      if (signal?.aborted) return false;
      const form = new FormData();
      form.append('file', new Blob([skillArchive(next)], { type: 'application/zip' }), `${skill}.zip`);
      const { temp_file_id } = await json('/api/v1/resources/temp_upload', { method: 'POST', body: form });
        if (typeof temp_file_id !== 'string' || !temp_file_id) throw Error('OpenViking did not accept the temporary archive');
      if (signal?.aborted) return false;
      await json(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_uri: target, temp_file_id, wait: true,
          ...(next.metadata.source ? { source_metadata: next.metadata.source } : {}) }),
      });
    },
    async verifyIndex(uri, snapshot) {
      requireManaged(uri);
      const detail = await detailOfSkill();
      if (detail.content_sha256 !== sha256(snapshot.body)) return false;
      const response = await json('/api/v1/skills/find', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: skill, target_uri: target, limit: 20, score_threshold: 0 }),
      });
      return Array.isArray(response.skills) && response.skills.some(item =>
        [uri, packageUri].includes(item.root_uri ?? item.uri) && item.description === detail.description);
    },
  };
}

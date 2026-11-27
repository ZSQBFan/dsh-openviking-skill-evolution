import { createHash } from 'node:crypto';
import { join } from 'node:path';

const USER = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = { reason: 'draft_connection_unavailable' };
const unverified = { reason: 'draft_identity_unverified' };

function nativeConfig(runtime) {
  const config = runtime?.config;
  if (!config || config.enabled === false) return null;
  let base;
  try { base = new URL(config.baseUrl || config.endpoint); } catch { return null; }
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && base.hostname === '127.0.0.1' && base.port)) ||
      base.pathname !== '/' || base.search || base.hash || base.username || base.password) return null;
  const nativeHeaders = {};
  if (config.apiKey) nativeHeaders.Authorization = `Bearer ${config.apiKey}`;
  if (config.sendIdentityHeaders) {
    if (typeof config.user !== 'string' || !USER.test(config.user)) return null;
    if (config.account) nativeHeaders['X-OpenViking-Account'] = config.account;
    nativeHeaders['X-OpenViking-User'] = config.user;
  }
  if (!config.apiKey && !config.sendIdentityHeaders) return null;
  const account = config.account ?? '';
  const origin = base.origin;
  return { origin, account, nativeHeaders, key: digest([origin, account, nativeHeaders]) };
}

export function createNativeConnectionResolver(getRuntime, directory) {
  let cached;
  return async function resolveConnection() {
    const config = nativeConfig(getRuntime());
    if (!config) {
      cached = undefined;
      return unavailable;
    }
    const current = () => nativeConfig(getRuntime())?.key === config.key;
    if (cached?.key === config.key && Date.now() < cached.expires) {
      const result = await cached.pending;
      return current() ? result : unverified;
    }
    const entry = { key: config.key, expires: Infinity };
    cached = entry;
    entry.pending = (async () => {
      try {
        const { origin, nativeHeaders, account } = config;
        const response = await fetch(new URL('/api/v1/system/status', origin), {
          headers: nativeHeaders, redirect: 'error', signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) return unverified;
        const payload = await response.json();
        const owner = payload?.result?.user;
        if (payload?.status !== 'ok' || payload.result.initialized !== true || typeof owner !== 'string' || !USER.test(owner)) return unverified;
        // With a Bearer key, the server can authenticate a different user than the configured header.
        if (!nativeHeaders.Authorization && nativeHeaders['X-OpenViking-User'] !== owner) return unverified;
        const versions = join(directory, 'native', digest([origin, account, owner]));
        return { owner, versions, current, writer: { origin, nativeHeaders, mode: 'native-verified-readback' } };
      } catch {
        return unverified;
      }
    })();
    const result = await entry.pending;
    entry.expires = Date.now() + (result.writer ? 60_000 : 5000);
    return current() ? result : unverified;
  };
}

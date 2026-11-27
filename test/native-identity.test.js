import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createNativeConnectionResolver } from '../src/native-identity.js';

test('Bearer identity uses the server user and changing auth invalidates the cache', async t => {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ url: request.url, authorization: request.headers.authorization, user: request.headers['x-openviking-user'] });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'ok', result: { initialized: true, user: 'fixture' } }));
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture-key', user: 'owner' };
  const resolve = createNativeConnectionResolver(() => ({ config }), tmpdir());
  const [active, duplicate] = await Promise.all([resolve(), resolve()]);
  assert.equal(active, duplicate);
  assert.equal(active.owner, 'fixture');
  assert.equal(active.current(), true);
  assert.deepEqual(calls, [{ url: '/api/v1/system/status', authorization: 'Bearer fixture-key', user: undefined }]);
  config.sendIdentityHeaders = true;
  assert.equal(active.current(), false);
  assert.equal((await resolve()).owner, 'fixture');
  assert.equal(calls[1].user, 'owner');
  assert.equal(calls[1].authorization, 'Bearer fixture-key');
  delete config.apiKey;
  assert.deepEqual(await resolve(), { reason: 'draft_identity_unverified' });
  config.user = 'fixture';
  assert.equal((await resolve()).versions, active.versions);
  config.enabled = false;
  assert.deepEqual(await resolve(), { reason: 'draft_connection_unavailable' });
});

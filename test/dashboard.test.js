import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function mount(options) {
  const { mountDashboard } = await import('../src/dashboard.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof mountDashboard, 'function', 'dashboard route must be implemented');
  let route;
  mountDashboard({ connection: { fetch: { register(value) { route = value; } } } }, options);
  assert.equal(route.path, '/api/dsh-openviking-skill-evolution/dashboard');
  return (body, init = {}) => route.fetch(new Request(`http://localhost${route.path}`, body === undefined ? init : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init,
  }));
}

test('dashboard only dispatches server-enabled operations', async () => {
  const request = await mount({
    snapshot: async () => ({ status: { state: 'idle' }, capabilities: { run: true } }),
    actions: { run: async ({ sessionId }) => ({ sessionId }), archive: async () => assert.fail('disabled operation ran') },
  });
  const status = await request();
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status.json(), { ok: true, data: { status: { state: 'idle' }, capabilities: { run: true, archive: false } } });
  const allowed = await request({ action: 'run', input: { sessionId: 'session-1' } });
  assert.deepEqual(await allowed.json(), { ok: true, data: { sessionId: 'session-1' } });
  for (const action of ['archive', 'toString', '__proto__']) {
    assert.equal((await request({ action, input: {} })).status, 403);
  }
});

test('dashboard rejects improperly typed and oversized action bodies before dispatch', async () => {
  const request = await mount({
    snapshot: () => ({ capabilities: { run: true } }),
    actions: { run: () => assert.fail('malformed operation ran') },
  });
  const body = { action: 'run', input: {} };
  assert.equal((await request(body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request(body, { body: '{' })).status, 400);
  assert.equal((await request({ action: 'run', input: [] })).status, 400);
  assert.equal((await request({ action: 'run', input: { text: 'x'.repeat(20_000) } })).status, 413);
});

test('native client contributes a localized Settings section through the DSH module loader', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  let module;
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { module = value; } } } });
  assert.equal(module?.id, 'dsh-openviking-skill-evolution');
  const client = module.factory(name => {
    assert.equal(name, 'react');
    return { createElement() {} };
  });
  let section;
  client.apply({
    effect(effect) { return effect(); },
    locale: { register() {}, bind: () => key => key },
    slots: {
      inject(parent, add) { assert.equal(parent, 'settings.section'); return add(); },
      register(options, component) { section = { options, component }; },
    },
  });
  assert.equal(section?.options.name, 'settings.section');
  assert.equal(section?.options.id, module.id);
  assert.equal(section?.options.locale, module.id);
  assert.equal(typeof section?.component, 'function');
});

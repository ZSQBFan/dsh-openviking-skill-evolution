import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { mountEvolution } from '../src/evolution.js';

async function mountReview(t, { existing = [], mode = 'shadow', resolveAgent, openvikingMemory } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'skill-dashboard-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = new Map(existing.map(id => [id, { session: { id } }]));
  const agents = { get: id => sessions.get(id), list: () => [...sessions.values()] };
  let route;
  const ctx = {
    get: name => ({ agents, openvikingMemory, sessionController: resolveAgent && { resolveAgent } })[name],
    on() {}, effect(create) { t.after(create()); },
    inject(dependencies, mount) {
      if (dependencies.includes('connection')) {
        mount({ connection: { fetch: { register(value) { route = value; } } } });
      }
    },
    sessionProjections: { async register() { return { stateOf: () => ({ events: [] }) }; } },
  };
  await mountEvolution(ctx, { directory, owner: 'fixture', settings: { mode } }, { stateOf: () => ({ evidence: [] }) });
  return (input, query = '') => route.fetch(new Request(`http://localhost${route.path}${query}`, input === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run', input }),
  }));
}

test('manual dashboard review finds an agent created before the plugin mounted', async t => {
  const request = await mountReview(t, { existing: ['existing-session'] });
  assert.equal((await (await request()).json()).data.capabilities.run, true);
  assert.deepEqual(await (await request({ sessionId: 'existing-session' })).json(), { ok: true, data: { status: 'no_evidence' } });
  assert.deepEqual(await (await request({})).json(), { ok: true, data: { status: 'no_session' } });
});

test('memory dashboard reads the requested live session, including agents open before plugin reload', async t => {
  const request = await mountReview(t, {
    existing: ['existing-session', 'another-session'],
    resolveAgent: () => assert.fail('status checks must not resume a session'),
    openvikingMemory: { config: { enabled: true }, states: new Map([['existing-session', {
      dshSessionId: 'existing-session', ovSessionId: 'ov-existing', config: { enabled: true }, ready: true,
    }]]) },
  });
  const status = async id => (await (await request(undefined, id && `?sessionId=${id}`)).json()).data.memory;
  const linked = await status('existing-session');
  assert.equal(linked.connection, 'observed');
  assert.equal(linked.state, 'linked');
  assert.equal(linked.ovSessionId, 'ov-existing');
  const other = await status('another-session');
  assert.equal(other.connection, 'observed');
  assert.equal(other.state, 'unobserved');
  assert.equal(other.ovSessionId, null);
  const none = await status('');
  assert.equal(none.connection, 'observed');
  assert.equal(none.state, 'no_session');
});

test('manual dashboard review resolves a stored session with no live agent', async t => {
  const request = await mountReview(t, {
    resolveAgent: async id => id === 'stored-session' ? { agent: { session: { id } } } : { error: {} },
  });
  assert.equal((await (await request()).json()).data.capabilities.run, true);
  assert.deepEqual(await (await request({ sessionId: 'stored-session' })).json(), { ok: true, data: { status: 'no_evidence' } });
  assert.deepEqual(await (await request({ sessionId: 'missing-session' })).json(), { ok: true, data: { status: 'no_session' } });
});

test('turning reviews off blocks manual requests before session resolution', async t => {
  const request = await mountReview(t, { mode: 'off', resolveAgent: () => assert.fail('must not resolve a session') });
  assert.equal((await (await request()).json()).data.capabilities.run, false);
  assert.equal((await request({ sessionId: 'stored-session' })).status, 403);
});

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

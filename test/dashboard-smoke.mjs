// Run with Node >=22. Optional DSH_NODE_EXECUTABLE, DSH_INSTALL_DIR and CHROME_BIN overrides.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const app = '/Applications/DeepSeek Harness.app/Contents';
const runtime = process.env.DSH_NODE_EXECUTABLE ?? `${app}/MacOS/DeepSeek Harness`;
const install = process.env.DSH_INSTALL_DIR ?? `${app}/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh`;
const chrome = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const path = '/api/dsh-openviking-skill-evolution/dashboard';
const uri = 'viking://user/fixture/skills/demo/SKILL.md';
const name = 'dsh-openviking-skill-evolution';
const root = await mkdtemp(join(tmpdir(), 'dsh-dashboard-smoke-'));
const children = [];
let socket;

async function retry(read, label) {
  const until = Date.now() + 15_000;
  let result;
  while (Date.now() < until) {
    result = await read();
    if (result) return result;
    await delay(60);
  }
  throw Error(`Timed out waiting for ${label}`);
}

async function getOrigin() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

function launch(program, args, env) {
  const proc = spawn(program, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = '';
  proc.stderr.setEncoding('utf8').on('data', data => { logs = (logs + data).slice(-12000); });
  proc.on('error', error => { logs += error.message; });
  children.push({ proc, logs: () => logs });
  return proc;
}

async function fixture(origin) {
  const dir = join(root, 'fixture');
  await mkdir(dir);
  await copyFile(new URL('../client.js', import.meta.url), join(dir, 'client.js'));
  await copyFile(new URL('../src/dashboard.js', import.meta.url), join(dir, 'dashboard.js'));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, name);
  assert.equal(manifest.exports['./client'], './client.js');
  assert(manifest.files.includes('client.js'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name, version: manifest.version, type: manifest.type, exports: { '.': './index.js', './client': manifest.exports['./client'] },
    dsh: { client: manifest.dsh.client },
  }));
  await writeFile(join(dir, 'index.js'), `
import { writeFileSync } from 'node:fs';
import { mountDashboard } from './dashboard.js';
const uri = ${JSON.stringify(uri)};
export const inject = ['connection', 'agents', 'sessions', 'sessionController', 'workspaceController'];
export async function apply(ctx) {
  const { workspace } = await ctx.workspaceController.create({ path: ${JSON.stringify(join(root, 'Documents'))} });
  for (const id of ['fixture-current', 'fixture-newest']) {
    await ctx.sessionController.create({ sessionId: id, workspaceId: workspace.workspaceId });
    const agent = ctx.agents.get(id);
    agent.session.append('turn/start', { turn: 1 });
    agent.session.append('user/message', { id: id + '-message', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: id }] }, { surfaceOp: 'append' });
    agent.session.append('session/title', { title: id, messageSeqs: [], source: { kind: 'user' } });
    await ctx.sessions.flush(agent.session);
  }
  const state = {
    status: { state: 'idle' }, settings: { mode: 'auto', modes: ['auto', 'shadow', 'off'], revision: 1, effectiveMode: 'shadow', writeConnection: 'unavailable' },
    history: [], proposals: [{ id: 'fixture-proposal', uri, status: 'pending', summary: 'Tighten instructions', actions: ['preview', 'approve'] }],
    usage: { inputTokens: 41 }, curator: { skills: [] }, memory: { status: 'ready' },
  };
  const result = status => ({ status });
  const actions = {
    run: ({ sessionId }) => { state.history.push({ id: sessionId, status: 'ready' }); return result('ready'); },
    settings: ({ revision, ...patch }) => {
      if (revision !== state.settings.revision) throw Error('stale settings');
      state.settings = { ...state.settings, ...patch, revision: revision + 1 };
      return result('applied');
    },
    preview: () => ({diff: '-old line\\n+new line'}),
    approve: () => {
      Object.assign(state.proposals[0], { status: 'applied', actions: ['preview', 'rollback'],
        history: [{ status: 'index_unconfirmed' }, { status: 'applied' }] });
      return result('applied');
    },
    rollback: () => {
      Object.assign(state.proposals[0], { status: 'rolled_back', actions: ['preview'],
        history: [{ status: 'index_unconfirmed' }, { status: 'rolled_back' }] });
      return result('rolled_back');
    },
    reject: () => { throw Error('disabled action dispatched'); },
    curator: () => { state.curator.status = 'ready'; return result('ready'); },
    adopt: input => { state.curator.skills = [{ uri: input.uri, status: 'active' }]; return result('active'); },
    archive: () => { state.curator.skills[0].status = 'archived'; return result('archived'); },
    restore: () => { state.curator.skills[0].status = 'active'; return result('active'); },
  };
  state.capabilities = Object.fromEntries(Object.keys(actions).map(key => [key, key !== 'reject']));
  mountDashboard(ctx, { snapshot: () => state, actions });
  writeFileSync(${JSON.stringify(join(root, 'login'))}, ctx.connection.authenticatedUrl(${JSON.stringify(origin)}), {mode: 0o600});
}`);
  const patch = join(root, 'overlay.yml');
  await writeFile(patch, `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(root, 'Documents'))}\n- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n- insert:\n    - id: dashboard-smoke-fixture\n      name: ${JSON.stringify(join(dir, 'index.js'))}\n`);
  return patch;
}

async function connectDebugger(endpoint) {
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const waiting = new Map();
  const events = new Map();
  const exceptions = [];
  let id = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    waiting.get(message.id)?.(message);
    events.get(message.method)?.(message.params);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  });
  async function cdp(method, params) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(requestId); reject(Error(`CDP timeout: ${method}`)); }, 5000);
      waiting.set(requestId, message => {
        clearTimeout(timer);
        waiting.delete(requestId);
        if (message.error) reject(Error(message.error.message));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  function nextEvent(method) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.delete(method);
        reject(Error(`CDP event timeout: ${method}`));
      }, 5000);
      events.set(method, params => {
        clearTimeout(timer);
        events.delete(method);
        resolve(params);
      });
    });
  }
  await cdp('Runtime.enable');
  return { cdp, exceptions, nextEvent };
}

try {
  for (const dir of ['home', 'tmp', 'Documents']) await mkdir(join(root, dir));
  const origin = await getOrigin();
  const overlay = await fixture(origin);
  const host = launch(runtime, [join(install, 'lib/bin.js'), '--profile', 'web', '--patch', overlay, '--host', '127.0.0.1', '--port', origin.split(':').at(-1), '--no-open'], {
    PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    DSH_HOME: join(root, 'profile'), DSH_AGENTS_HOME: join(root, 'agents'), ELECTRON_RUN_AS_NODE: '1',
  });
  const anonymous = await retry(async () => {
    if (host.exitCode !== null) throw Error(`DSH exited: ${host.exitCode}`);
    const response = await fetch(origin + path).catch(() => null);
    return response?.status === 404 ? null : response;
  }, 'anonymous API');
  assert.equal(anonymous.status, 401);
  const loginUrl = await retry(() => readFile(join(root, 'login'), 'utf8').catch(() => null), 'fixture login');
  const auth = await fetch(loginUrl, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'expected DSH cookie');
  const snapshot = await fetch(origin + path, { headers: { Cookie: cookie } });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get('cache-control'), 'no-store');
  assert.equal((await snapshot.json()).data.capabilities.reject, false);
  function post(action, originHeader) {
    return fetch(origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: originHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, input: {} }) });
  }
  assert.equal((await post('run', 'http://other.test')).status, 403);
  assert.equal((await post('reject', origin)).status, 403);
  console.log('DSH host returned 401 anonymously, 200 with owner cookie, and 403 for cross-origin or disabled actions.');

  const chromeDir = join(root, 'chrome');
  const browser = launch(chrome, ['--headless', '--disable-background-networking', '--no-first-run', '--lang=en-US',
    '--remote-debugging-port=0', `--user-data-dir=${chromeDir}`, 'about:blank'], process.env);
  const debugPort = await retry(async () => {
    if (browser.exitCode !== null) throw Error(`Chrome exited: ${browser.exitCode}`);
    const info = await readFile(join(chromeDir, 'DevToolsActivePort'), 'utf8').catch(() => '');
    return info.split('\n')[0];
  }, 'isolated Chrome debugger');
  const [tab] = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const { cdp, exceptions, nextEvent } = await connectDebugger(tab.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const reply = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  };
  await cdp('Page.navigate', { url: loginUrl });
  const press = async (label, scope = 'document') => retry(() => evaluate(`(() => {
    const button = [...${scope}.querySelectorAll('button,[role=button],[role=tab],[role=menuitem]')].find(b => !b.disabled && b.getClientRects().length && [b.textContent.trim(), b.getAttribute('aria-label'), b.title].includes(${JSON.stringify(label)}));
    if (!button) return false;
    button.click(); return true;
  })()`), `button ${label}`);
  async function keyPress(key, code, virtualKeyCode, text) {
    const fields = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
    await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...fields, text });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
  }
  const enter = () => keyPress('Enter', 'Enter', 13);
  const panel = `document.querySelector('.ove-dashboard')`;
  const inPanel = (label) => press(label, `(${panel} ?? document.createElement('div'))`);
  const text = (label) => retry(() => evaluate(`${panel}?.innerText.includes(${JSON.stringify(label)})`), `dashboard text ${label}`);
  const fill = (label, value) => evaluate(`(() => {
    const input = [...${panel}.querySelectorAll('input,select,textarea')].find(input => input.parentElement.textContent.includes(${JSON.stringify(label)}));
    const prototype = Object.getPrototypeOf(input);
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', {bubbles: true}));
  })()`);
  try {
    await press('继续');
    await retry(() => evaluate(`!document.body?.innerText.includes('预览版说明')`), 'dismissed welcome');
    const openSettings = () => evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', metaKey: true, altKey: true, bubbles: true, cancelable: true }))`);
    await openSettings();
    await press('技能演进');
    await text('打开一个会话，或输入会话 ID 后再运行复盘。');
    assert.equal(await evaluate(`${panel}.querySelector('input[placeholder="输入会话 ID"]').value`), '');
    assert.equal(await evaluate(`[...${panel}.querySelectorAll('button')].find(button => button.textContent === '运行复盘').disabled`), true);
    await press('关闭');
    await retry(() => evaluate(`!${panel}`), 'closed Settings');
    await retry(() => evaluate(`(() => {
      const row = document.querySelector('[data-row-key="session:fixture-current"]');
      if (!row?.getClientRects().length) return false;
      row.click();
      return true;
    })()`), 'open older fixture session');
    await retry(() => evaluate(`document.title.includes('fixture-current')`), 'older fixture session active');
    await openSettings();
    await press('技能演进');
  } catch (error) {
    console.error(await evaluate(`({text:document.body?.innerText?.slice(0,1500), buttons:[...document.querySelectorAll('button')].slice(0,25).map(b=>[b.textContent.trim(), b.title,b.getAttribute('aria-label')])})`));
    console.error('Page exceptions:', exceptions);
    throw error;
  }
  await text('技能治理');
  await text('当前实际行为 · 只保存草稿');
  await cdp('Fetch.enable', { patterns: [{ urlPattern: origin + path }] });
  const [paused] = await Promise.all([nextEvent('Fetch.requestPaused'), inPanel('刷新')]);
  assert.equal(paused.request.method, 'GET');
  assert.equal(await evaluate(`${panel}.querySelector('header button').disabled`), true, 'Refresh stays disabled while the request is pending');
  assert.equal(await evaluate(`${panel}.querySelector('[role="status"]')?.textContent`), '正在刷新仪表板…');
  await cdp('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'InternetDisconnected' });
  await cdp('Fetch.disable');
  await text('与主机的连接中断。');
  await inPanel('刷新');
  await retry(() => evaluate(`!${panel}.querySelector('[role="alert"]') && !${panel}.querySelector('header button').disabled`), 'dashboard recovered after refresh');
  assert(await evaluate(`${panel}.innerText.includes('输入 token') && ${panel}.innerText.includes('记忆')`));
  await inPanel('运行复盘');
  const getHistory = async () => (await (await fetch(origin + path, { headers: { Cookie: cookie } })).json()).data.history;
  await retry(async () => (await getHistory()).length === 1, 'recorded dashboard run');
  assert.deepEqual(await getHistory(), [{ id: 'fixture-current', status: 'ready' }]);
  await fill('会话 ID', '  fixture-newest  ');
  await inPanel('运行复盘');
  await text('fixture-newest');
  assert.deepEqual((await getHistory()).map(item => item.id), ['fixture-current', 'fixture-newest']);
  await evaluate(`[...${panel}.querySelectorAll('button')].find(button => button.textContent === '预览').focus()`);
  assert.equal(await evaluate(`document.activeElement.textContent`), '预览');
  await enter();
  await text('+new line');
  await inPanel('关闭');
  await evaluate(`(() => {
    const button = [...${panel}.querySelectorAll('button')].find(button => button.textContent === '预览');
    button.dataset.activationCount = 0;
    button.addEventListener('click', () => { button.dataset.activationCount = Number(button.dataset.activationCount) + 1; });
    button.focus();
  })()`);
  await keyPress('Enter', 'Enter', 13, '\r');
  await text('+new line');
  assert.equal(await evaluate(`[...${panel}.querySelectorAll('button')].find(button => button.textContent === '预览').dataset.activationCount`), '1');
  await inPanel('批准');
  await inPanel('取消');
  await inPanel('批准');
  await inPanel('确认');
  await text('技能版本已核验，搜索索引尚未确认。');
  await inPanel('回滚');
  await inPanel('确认');
  await text('已回滚');
  await text('已核验技能移除，搜索索引尚未确认。');
  assert.equal(await evaluate(`${panel}.innerText.includes('技能版本已核验，搜索索引尚未确认。')`), false);
  assert.equal(await evaluate(`${panel}.querySelector('.ove-advanced').open`), false);
  assert.equal(await evaluate(`${panel}.querySelector('.ove-advanced input').getClientRects().length`), 0);
  await fill('复盘模式', 'shadow');
  await evaluate(`${panel}.querySelector('select').focus()`);
  await keyPress('Tab', 'Tab', 9);
  assert.equal(await evaluate(`document.activeElement.matches('.ove-advanced summary')`), true);
  await enter();
  await retry(() => evaluate(`${panel}.querySelector('.ove-advanced').open`), 'advanced settings opened by Enter');
  await keyPress(' ', 'Space', 32, ' ');
  assert.equal(await evaluate(`${panel}.querySelector('.ove-advanced').open`), false, 'native Space still closes the focused disclosure');
  await keyPress('Enter', 'Enter', 13, '\r');
  assert.equal(await evaluate(`${panel}.querySelector('.ove-advanced').open`), true, 'full Enter sequence toggles the disclosure once');
  await keyPress('Tab', 'Tab', 9);
  assert.equal(await evaluate(`document.activeElement === ${panel}.querySelector('.ove-advanced input')`), true);
  await fill('轮次上限', '12');
  await fill('工具调用上限', '15');
  await fill('失败次数上限', '4');
  await fill('自动复盘最短间隔（分钟）', '2.5');
  await fill('提供商', 'fixture-provider');
  await fill('模型', 'fixture-model');
  await fill('纠正短语（每行一个）', 'before\nafter');
  await inPanel('保存设置');
  await inPanel('运行治理');
  await fill('私有技能 URI', uri);
  await inPanel('纳管');
  await inPanel('归档');
  await inPanel('确认');
  await inPanel('恢复');
  await inPanel('确认');
  await text('活跃');
  assert.equal(await evaluate(`${panel}.querySelector('select').value`), 'shadow');
  const persisted = await (await fetch(origin + path, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(persisted.data.settings, {
    mode: 'shadow', modes: ['auto', 'shadow', 'off'], revision: 2, effectiveMode: 'shadow', writeConnection: 'unavailable',
    maxTurns: 12, maxToolCalls: 15, maxFailures: 4, cooldownMs: 150000,
    provider: 'fixture-provider', model: 'fixture-model', correctionWords: ['before', 'after'],
  });
  assert.deepEqual(exceptions, []);
  console.log('Native React Settings exercised manual review, history, diff, approval/cancel/rollback, mode change, curator/adopt/archive/restore, usage and memory.');
} catch (error) {
  // DSH may emit a connect URL during startup. Never dump it to test logs.
  for (const child of children) console.error(child.logs().replace(/https?:\/\/[^\s\x1b]+/g, '[url]'));
  throw error;
} finally {
  socket?.close();
  await Promise.all(children.map(async ({ proc }) => {
    if (proc.exitCode !== null || !proc.pid) return;
    proc.kill('SIGTERM');
    const until = Date.now() + 3000;
    while (proc.exitCode === null && proc.signalCode === null && Date.now() < until) await delay(25);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }));
  await rm(root, { recursive: true, force: true });
}

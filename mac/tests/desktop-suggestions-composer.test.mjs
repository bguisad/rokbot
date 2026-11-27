// Desktop preload loader for the shared composer assist (mac/clients/desktop/suggestions-composer.cjs):
// every request the shared code makes maps to a main-process IPC channel; aborting a completion
// request tells the main process to cancel the Host call.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../clients/desktop');

function loadLoader() {
  const invoked = [];
  const sent = [];
  const ipcRenderer = {
    invoke: (channel, payload) => { invoked.push([channel, payload]); return Promise.resolve({ channel }); },
    send: (channel, payload) => sent.push([channel, payload]),
    sendSync: () => 'zh-CN',
  };
  let installed = null;
  const assistPath = require.resolve(path.join(DESKTOP, 'composer-assist.cjs'));
  const loaderPath = require.resolve(path.join(DESKTOP, 'suggestions-composer.cjs'));
  const originalLoad = Module._load;
  const saved = { document: globalThis.document, window: globalThis.window };
  const listeners = {};
  globalThis.document = { readyState: 'complete' };
  globalThis.window = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  globalThis.window.top = globalThis.window;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer };
    if (request === './composer-assist.cjs') return { installComposerSuggestions: options => { installed = options; return () => {}; } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[loaderPath];
    require(loaderPath);
  } finally {
    Module._load = originalLoad;
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    delete require.cache[loaderPath];
  }
  assert.ok(assistPath);
  return { invoked, sent, installed };
}

test('desktop loader installs the shared composer assist with an IPC-backed request()', async () => {
  const { invoked, sent, installed } = loadLoader();
  assert.ok(installed, 'installComposerSuggestions was called');
  assert.equal(installed.locale, 'zh-CN');
  const { request } = installed;

  await request('/local/suggestions/settings', null, undefined, 'GET');
  await request('/local/suggestions/settings', { completionEnabled: false }, undefined, 'PUT');
  await request('/local/suggestions/phrases', { text: '继续' }, undefined, 'POST');
  await request('/local/suggestions/phrases/reorder', { ids: ['p_1', 'p_2'] }, undefined, 'PUT');
  await request('/local/suggestions/phrases/p_1', { text: '请继续' }, undefined, 'PUT');
  await request('/local/suggestions/phrases/p_1', null, undefined, 'DELETE');
  await request('/local/suggestions', { agentId: 'bot' }, undefined, 'POST');
  assert.deepEqual(invoked.map(([channel]) => channel), [
    'rokbot-local:suggestions-settings-get',
    'rokbot-local:suggestions-settings-put',
    'rokbot-local:suggestions-phrase-add',
    'rokbot-local:suggestions-phrase-reorder',
    'rokbot-local:suggestions-phrase-update',
    'rokbot-local:suggestions-phrase-delete',
    'rokbot-local:suggestions-generate',
  ]);
  assert.deepEqual(invoked[1][1], { completionEnabled: false });
  assert.deepEqual(invoked[4][1], { id: 'p_1', text: '请继续' });
  assert.deepEqual(invoked[6][1].body, { agentId: 'bot' });

  const controller = new AbortController();
  await request('/local/suggestions/complete', { text: '帮我' }, controller.signal, 'POST');
  const [channel, payload] = invoked.at(-1);
  assert.equal(channel, 'rokbot-local:suggestions-complete');
  assert.deepEqual(payload.body, { text: '帮我' });
  assert.match(payload.requestId, /^[a-z0-9]+-\d+$/);
  controller.abort();
  assert.deepEqual(sent, [], 'an abort after the reply sends nothing');

  // Abort while in flight: the main process is told to cancel that request id.
  const pendingController = new AbortController();
  const pending = request('/local/suggestions/complete', { text: '帮我看' }, pendingController.signal, 'POST');
  pendingController.abort();
  await pending;
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'rokbot-local:suggestions-cancel');
  assert.equal(sent[0][1], invoked.at(-1)[1].requestId);

  // Habit learning goes through its own channels.
  await request('/local/suggestions/feedback', { agentId: 'bot', action: 'tap', text: '先修 upload', shown: ['先修 upload'] }, undefined, 'POST');
  assert.deepEqual(invoked.at(-1), ['rokbot-local:suggestions-feedback', { agentId: 'bot', action: 'tap', text: '先修 upload', shown: ['先修 upload'] }]);
  await request('/local/suggestions/habits', null, undefined, 'DELETE');
  assert.equal(invoked.at(-1)[0], 'rokbot-local:suggestions-habits-clear');

  await assert.rejects(() => request('/local/other', {}, undefined, 'POST'), /Unsupported suggestions request/);
});

test('desktop main process exposes the habit channels to the trusted renderer only', async () => {
  const fs = await import('node:fs');
  const main = fs.readFileSync(path.join(DESKTOP, 'main.mjs'), 'utf8');
  for (const channel of ['rokbot-local:suggestions-feedback', 'rokbot-local:suggestions-habits-clear']) {
    const at = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at > 0, channel);
    assert.ok(main.slice(at, at + 400).includes('trusted(event, mainWindow)'), `${channel} checks the renderer`);
  }
  assert.ok(main.includes("gateway.request('/local/suggestions/feedback', body, AbortSignal.timeout(8000), 'POST')"));
  assert.ok(main.includes("gateway.request('/local/suggestions/habits', null, AbortSignal.timeout(10000), 'DELETE')"));
});

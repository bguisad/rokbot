// Desktop preload wiring and main-process IPC contract for grouped settings navigation,
// Input Suggestions scroll container, and the Bot details page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '../clients/desktop');

test('bot-profile-loader wires IPC channels for contextIsolated desktop preload', async () => {
  const invoked = [];
  const listeners = new Map();
  let capturedOptions = null;

  const fakeElectron = {
    ipcRenderer: {
      sendSync: channel => {
        if (channel === 'rokbot-local:locale') return 'zh-CN';
        if (channel === 'rokbot-local:viewing-agent-get') return 'bot-99';
        return '';
      },
      invoke: (channel, payload) => {
        invoked.push([channel, payload]);
        return Promise.resolve({ ok: true });
      },
      on: (channel, fn) => { listeners.set(channel, fn); },
    },
  };
  const fakeProfile = {
    installBotProfile: opts => {
      capturedOptions = opts;
      return { setLocale() {}, destroy() {} };
    },
  };

  const origLoad = Module._load;
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const loaderPath = require.resolve(path.join(DESKTOP, 'bot-profile-loader.cjs'));
  delete require.cache[loaderPath];

  globalThis.document = { readyState: 'complete' };
  globalThis.window = { top: null };
  globalThis.window.top = globalThis.window;

  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === './bot-profile.cjs') return fakeProfile;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    require(loaderPath);
  } finally {
    Module._load = origLoad;
    delete require.cache[loaderPath];
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }

  assert.ok(capturedOptions, 'installBotProfile was called');
  assert.equal(capturedOptions.locale, 'zh-CN');
  assert.equal(capturedOptions.getViewingAgentId(), 'bot-99');
  listeners.get('rokbot-local:viewing-agent')?.(null, 'bot-100');
  assert.equal(capturedOptions.getViewingAgentId(), 'bot-100');

  await capturedOptions.getAgent('bot-100');
  await capturedOptions.getAutomations('bot-100');
  await capturedOptions.setNotify('bot-100', false);
  await capturedOptions.usage();
  await capturedOptions.modelConfig();
  await capturedOptions.connection();

  assert.deepEqual(invoked, [
    ['rokbot-local:bot-profile-get', { id: 'bot-100' }],
    ['rokbot-local:bot-automations-get', { id: 'bot-100' }],
    ['rokbot-local:bot-notify-set', { id: 'bot-100', isEnabled: false }],
    ['rokbot-local:usage', {}],
    ['rokbot-local:model-get', undefined],
    ['rokbot-local:status', undefined],
  ]);
});

test('desktop main.mjs registers Bot details IPC channels with trusted() guards and existing gateway commands', () => {
  const main = readFileSync(path.join(DESKTOP, 'main.mjs'), 'utf8');
  for (const [channel, command] of [
    ['rokbot-local:bot-profile-get', 'getAgent'],
    ['rokbot-local:bot-automations-get', 'getAgentAutomations'],
    ['rokbot-local:bot-notify-set', 'setAgentNotifyOnUpdates'],
  ]) {
    const at = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(at > 0, `${channel} is registered in main.mjs`);
    const body = main.slice(at, at + 420);
    assert.match(body, /trusted\(event, mainWindow\)/, `${channel} verifies trusted sender`);
    assert.match(body, new RegExp(`gateway\\.command\\('${command}'`), `${channel} reuses existing ${command} gateway command`);
  }
});

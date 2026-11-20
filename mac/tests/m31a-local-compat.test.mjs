import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadLocalExecDaemon } from '../clients/desktop/local-exec.mjs';
import {
  boot,
  createLocalServices,
  desktopEdges,
  experiments,
  probeLocalMethod,
} from '../clients/desktop/local-services.mjs';
import { createVoiceAvailability } from '../clients/desktop/voice.mjs';

function fakeWindow() {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    webContents: {
      send(channel, value) {
        sent.push({ channel, value });
      },
    },
  };
}

test('experiments.featureGates.sand_client_pause stays false in boot, getExperimentsSnapshot, and voiceAvailability.refresh()', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31a-gates-'));
  t.after(() => rm(profile, { recursive: true, force: true }));

  assert.equal(experiments.featureGates.sand_client_pause, false);
  assert.equal(boot.experiments.featureGates.sand_client_pause, false);

  const win = fakeWindow();
  let voiceEnabled = true;
  let prefEnabled = true;
  const voiceAvailability = createVoiceAvailability({
    request: async () => ({ enabled: voiceEnabled }),
    window: win,
    experiments,
    getPreference: () => prefEnabled,
  });
  t.after(() => voiceAvailability.close());

  const call = await createLocalServices(profile, win, {
    command: async () => ({}),
    request: async () => ({}),
    settings: {
      getExperimentsSnapshot: () => voiceAvailability.refresh(),
    },
  });

  const snap1 = await call('getExperimentsSnapshot');
  assert.equal(snap1.featureGates.sand_client_pause, false);
  assert.equal(snap1.featureGates.sand_voice_call, true);

  voiceEnabled = false;
  const snap2 = await call('getExperimentsSnapshot');
  assert.equal(snap2.featureGates.sand_client_pause, false);
  assert.equal(snap2.featureGates.sand_voice_call, false);
  assert.ok(win.sent.some(ev => ev.channel === 'dune-rpc:main:e:experiments-changed' && ev.value.featureGates.sand_client_pause === false));
});

test('1.2.3 .desktop.* IPC handlers return exact verified schemas and preserve probeLocalMethod contract', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31a-ipc-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  t.mock.method(console, 'error', () => {});

  const call = await createLocalServices(profile, fakeWindow(), {
    command: async () => ({}),
    request: async () => ({}),
  });

  assert.deepEqual(await call('getMessagesCapabilities'), { read: false, send: false });
  await assert.rejects(call('setMessagesCapabilities', { read: true, send: true }), /Messages service unavailable|信息服务不可用/);

  assert.equal(await call('getMacMailSendEnabled'), false);
  await assert.rejects(call('setMacMailSendEnabled', { enabled: true }), /Mail send service unavailable|邮件发送服务不可用/);

  assert.deepEqual(await call('getLocalToolActionGrant', { action: 'send-imessage' }), { granted: false });
  const grantResult = await call('setLocalToolActionGrant', { action: 'send-imessage', granted: true });
  assert.deepEqual(grantResult, { stored: false });
  const { stored } = grantResult;
  assert.equal(stored, false);

  assert.deepEqual(await call('getDesktopNotificationPermission'), { status: 'granted', canOpenSettings: false });
  assert.deepEqual(await call('requestDesktopNotificationPermission'), { status: 'granted', canOpenSettings: false });
  assert.equal(await call('openDesktopNotificationSettings'), false);

  // Verify probeLocalMethod and unimplemented-method rejection remain strict.
  const declared = new Set([
    'getMessagesCapabilities',
    'setMessagesCapabilities',
    'getMacMailSendEnabled',
    'setMacMailSendEnabled',
    'getLocalToolActionGrant',
    'setLocalToolActionGrant',
    'getDesktopNotificationPermission',
    'requestDesktopNotificationPermission',
    'openDesktopNotificationSettings',
    'unimplemented123Method',
  ]);
  for (const method of [
    'getMessagesCapabilities',
    'setMessagesCapabilities',
    'getMacMailSendEnabled',
    'setMacMailSendEnabled',
    'getLocalToolActionGrant',
    'setLocalToolActionGrant',
    'getDesktopNotificationPermission',
    'requestDesktopNotificationPermission',
    'openDesktopNotificationSettings',
  ]) {
    assert.deepEqual(probeLocalMethod(true, declared, call, method), { ok: true, value: true }, method);
    assert.deepEqual(probeLocalMethod(false, declared, call, method), { ok: false, value: false }, method);
  }
  assert.deepEqual(probeLocalMethod(true, declared, call, 'unimplemented123Method'), { ok: true, value: false });
  await assert.rejects(call('unimplemented123Method'), /Local desktop does not implement unimplemented123Method/);

  // Verify desktopEdges parses 1.2.3-style preload declarations cleanly.
  const preloadFixture = [
    'const n = () => ({ noArgs: () => 0, args: () => 0 });',
    'const mount = ge("desktop-mount",{methods:{mountPanel:n().noArgs}});',
    'const main = ge("main",{methods:{',
    '  getMessagesCapabilities:n().noArgs,',
    '  setMessagesCapabilities:n().args({}),',
    '  getMacMailSendEnabled:n().noArgs,',
    '  setMacMailSendEnabled:n().args({}),',
    '  getLocalToolActionGrant:n().args({}),',
    '  setLocalToolActionGrant:n().args({}),',
    '  getDesktopNotificationPermission:n().noArgs,',
    '  requestDesktopNotificationPermission:n().noArgs,',
    '  openDesktopNotificationSettings:n().noArgs,',
    '}});',
  ].join('\n');
  const { main, others } = desktopEdges(preloadFixture);
  assert.equal(others.get('desktop-mount').has('mountPanel'), true);
  for (const name of declared) {
    if (name !== 'unimplemented123Method') assert.equal(main.has(name), true, name);
  }
});

test('loadLocalExecDaemon recognizes 0.71.2 patch, 1.1.0 UTF8_BUILT_IN, and 1.2.3 powershellUtf8Console without warnings', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31a-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));

  // 0.71.2 style: sixth arg patched on win32, untouched on darwin.
  const v0712 = path.join(dir, 'daemon-0712.cjs');
  await writeFile(v0712, `class e3 { constructor(a,b,c,d,e,utf8,keep){ this.utf8 = utf8; this.keep = keep; } }
function make(){ let i={},s=!0,t="pwsh"; return new e3(i,t,t,void 0,void 0,void 0,s); }
module.exports = { make };`);
  assert.equal(loadLocalExecDaemon(v0712, 'win32').make().utf8, true);
  assert.equal(loadLocalExecDaemon(v0712, 'darwin').make().utf8, undefined);

  // 1.1.0 style: exact UTF8_BUILT_IN literal.
  const v110 = path.join(dir, 'daemon-110.cjs');
  await writeFile(v110, `const opts = {keepBackgroundJobs:!0,powershellUtf8Console:!0,powershellUtf8ChildEnv:!0};
module.exports = { opts };`);
  assert.equal(loadLocalExecDaemon(v110, 'win32').opts.powershellUtf8Console, true);
  assert.equal(loadLocalExecDaemon(v110, 'darwin').opts.powershellUtf8Console, true);

  // 1.2.3 style: powershellUtf8Console check without exact 1.1.0 literal.
  const v123 = path.join(dir, 'daemon-123.cjs');
  await writeFile(v123, `function fee(h, n){ return { utf8Console: h && n?.powershellUtf8Console === !0 }; }
module.exports = { fee };`);
  assert.deepEqual(loadLocalExecDaemon(v123, 'win32').fee(true, { powershellUtf8Console: true }), { utf8Console: true });
  assert.deepEqual(loadLocalExecDaemon(v123, 'darwin').fee(true, { powershellUtf8Console: true }), { utf8Console: true });

  assert.deepEqual(warnings, [], 'should not emit UTF-8 console missing warning for 0.71.2, 1.1.0, or 1.2.3');
});

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { bundleFiles, bundleZip, readWebIcons, webIndexHtml } from '../patchers/patch.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function stageClientDir(t) {
  const stageDir = await mkdtemp(path.join(tmpdir(), 'rokbot-web-m33-client-'));
  t.after(() => rm(stageDir, { recursive: true, force: true }));
  const clientStage = path.join(stageDir, 'client');
  await cp(path.join(repo, 'web/client'), clientStage, { recursive: true });
  await cp(path.join(repo, 'mac/clients/desktop'), path.join(clientStage, 'desktop'), { recursive: true });
  // The bundle serves shared .cjs scripts as .js (web/patchers/patch.mjs bundleFiles).
  await cp(path.join(repo, 'mac/clients/desktop/composer-assist.cjs'), path.join(clientStage, 'desktop/composer-assist.js'));
  return { stageDir, clientStage };
}

test('compat.js polyfills ES5 AbortSignal.timeout for Chromium 89-102 without overriding native implementations', async () => {
  const compatSource = await readFile(path.join(repo, 'web/client/compat.js'), 'utf8');

  class FakeAbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; }
  }
  class FakeAbortController {
    constructor() { this.signal = new FakeAbortSignal(); }
    abort(reason) { this.signal.aborted = true; this.signal.reason = reason; }
  }
  const scheduled = [];
  const sandbox = {
    AbortSignal: FakeAbortSignal,
    AbortController: FakeAbortController,
    DOMException: class FakeDOMException extends Error {
      constructor(message, name) { super(message); this.name = name; }
    },
    navigator: { userAgent: 'Chrome/96.0', language: 'en-US' },
    location: { href: 'http://host.test/web/', reload() {} },
    document: { readyState: 'complete', head: { appendChild() {} }, body: { appendChild() {} }, getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }) },
    addEventListener() {},
    setTimeout(fn, ms) { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimeout() {},
    setInterval() { return 1; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(compatSource, sandbox);

  assert.equal(typeof sandbox.AbortSignal.timeout, 'function');
  assert.ok(sandbox.__rokbotCompat.added.includes('AbortSignal.timeout'));
  const signal = sandbox.AbortSignal.timeout(150);
  assert.equal(signal.aborted, false);
  const timeoutTimer = scheduled.find(item => item.ms === 150);
  assert.ok(timeoutTimer);
  timeoutTimer.fn();
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, 'TimeoutError');

  // Edge cases: ms = 0, NaN, and DOMException fallback to Error('The operation timed out.').
  const zeroSignal = sandbox.AbortSignal.timeout(0);
  const zeroTimer = scheduled.find(item => item.ms === 0);
  assert.ok(zeroTimer);
  zeroTimer.fn();
  assert.equal(zeroSignal.aborted, true);
  assert.equal(zeroSignal.reason.name, 'TimeoutError');

  const nanSignal = sandbox.AbortSignal.timeout(Number.NaN);
  const nanTimer = scheduled.find(item => Number.isNaN(item.ms));
  assert.ok(nanTimer);
  nanTimer.fn();
  assert.equal(nanSignal.aborted, true);
  assert.equal(nanSignal.reason.name, 'TimeoutError');

  const fallbackScheduled = [];
  const fallbackSandbox = {
    ...sandbox,
    AbortSignal: class FallbackAbortSignal {},
    AbortController: FakeAbortController,
    DOMException: class ThrowingDOMException {
      constructor() { throw new Error('DOMException unavailable'); }
    },
    __rokbotCompat: undefined,
    setTimeout(fn, ms) { fallbackScheduled.push({ fn, ms }); return fallbackScheduled.length; },
  };
  fallbackSandbox.window = fallbackSandbox;
  fallbackSandbox.globalThis = fallbackSandbox;
  vm.runInNewContext(compatSource, fallbackSandbox);
  const fallbackSignal = fallbackSandbox.AbortSignal.timeout(0);
  const fallbackTimer = fallbackScheduled.find(item => item.ms === 0);
  assert.ok(fallbackTimer);
  fallbackTimer.fn();
  assert.equal(fallbackSignal.aborted, true);
  assert.equal(fallbackSignal.reason.name, 'TimeoutError');
  assert.equal(fallbackSignal.reason.message, 'The operation timed out.');

  // Must not replace an existing native AbortSignal.timeout.
  const nativeFn = ms => ({ ms, native: true });
  class NativeAbortSignal {}
  NativeAbortSignal.timeout = nativeFn;
  const sandbox2 = { ...sandbox, AbortSignal: NativeAbortSignal, __rokbotCompat: undefined };
  sandbox2.window = sandbox2;
  sandbox2.globalThis = sandbox2;
  vm.runInNewContext(compatSource, sandbox2);
  assert.equal(sandbox2.AbortSignal.timeout, nativeFn);
});

test('gateway.js forwards sanitized extraHeaders and deduplicates concurrent 401 /connect/status storms', async t => {
  const { clientStage } = await stageClientDir(t);
  const { createGateway, subscribe } = await import(pathToFileURL(path.join(clientStage, 'gateway.js')).href);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const calls = [];
  let connectStatus = 200;
  let connectBody = { ok: true, connected: true };
  let connectReject = null;
  let endpointStatus = 401;

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (String(url) === '/connect/status') {
      if (connectReject) throw connectReject;
      return new Response(JSON.stringify(connectBody), {
        status: connectStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url) === '/events') {
      return new Response('unauthorized', { status: 401 });
    }
    if (endpointStatus === 401) {
      return new Response(JSON.stringify({ error: 'step-up required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  let unauthorizedCalls = 0;
  const gw = createGateway({ onUnauthorized: () => { unauthorizedCalls++; } });
  t.after(() => gw.close());

  // 1. extraHeaders forwarding & security filtering
  endpointStatus = 200;
  await gw.request('/local/model', { version: 1 }, undefined, 'PUT', {
    authorization: 'Bearer evil',
    Authorization: 'Bearer evil2',
    'content-type': 'text/plain',
    'x-rokbot-web': '0',
    cookie: 'rokbot_web=evil',
    'x-rokbot-admin-password': 'secret-pass',
  });
  const req0 = calls[calls.length - 1];
  assert.equal(req0.headers['x-rokbot-web'], '1');
  assert.equal(req0.headers['Content-Type'], 'application/json');
  assert.equal(req0.headers['x-rokbot-admin-password'], 'secret-pass');
  assert.equal(req0.headers.authorization, undefined);
  assert.equal(req0.headers.Authorization, undefined);
  assert.equal(req0.headers.cookie, undefined);

  const storm5 = () => Promise.all(
    Array.from({ length: 5 }, () =>
      assert.rejects(gw.request('/local/model', null, undefined, 'GET'), err => err.httpStatus === 401)),
  );

  // 2. 5x concurrent 401 storm with /connect/status 200 { connected: true } -> 1 probe, 0 onUnauthorized
  calls.length = 0;
  endpointStatus = 401;
  connectStatus = 200;
  connectBody = { ok: true, connected: true };
  await storm5();
  assert.equal(calls.filter(c => c.url === '/connect/status').length, 1);
  assert.equal(calls.find(c => c.url === '/connect/status').headers['x-rokbot-web'], '1');
  assert.equal(unauthorizedCalls, 0);

  // 3. 5x concurrent 401 storm with /connect/status 500 -> 1 probe, 0 onUnauthorized
  calls.length = 0;
  connectStatus = 500;
  connectBody = { error: 'temporary' };
  await storm5();
  assert.equal(calls.filter(c => c.url === '/connect/status').length, 1);
  assert.equal(unauthorizedCalls, 0);

  // 4. 5x concurrent 401 storm with /connect/status network error -> 1 probe, 0 onUnauthorized
  calls.length = 0;
  connectReject = new TypeError('network down');
  await storm5();
  connectReject = null;
  assert.equal(calls.filter(c => c.url === '/connect/status').length, 1);
  assert.equal(unauthorizedCalls, 0);

  // 5. 5x concurrent 401 storm with /connect/status 200 { connected: false } -> 1 probe, 1 onUnauthorized
  calls.length = 0;
  connectStatus = 200;
  connectBody = { ok: true, connected: false };
  await storm5();
  assert.equal(calls.filter(c => c.url === '/connect/status').length, 1);
  assert.equal(unauthorizedCalls, 1);

  // 6. Sequential 5x concurrent 401 storm with /connect/status 401 -> 1 probe, +1 onUnauthorized
  calls.length = 0;
  connectStatus = 401;
  connectBody = { error: 'revoked' };
  await storm5();
  assert.equal(calls.filter(c => c.url === '/connect/status').length, 1);
  assert.equal(unauthorizedCalls, 2);

  // 7. Sequential 5x concurrent 401 storm with /connect/status 404 -> 1 probe, +1 onUnauthorized
  calls.length = 0;
  connectStatus = 404;
  await storm5();
  assert.equal(calls.filter(c => c.url === '/connect/status').length, 1);
  assert.equal(unauthorizedCalls, 3);

  // 8. Standalone subscribe() 401 invokes onUnauthorized once without emitting onDisconnected
  let sseUnauth = 0;
  let sseDisconnect = 0;
  const sseCtl = new AbortController();
  await subscribe('/events', () => {}, sseCtl.signal, {
    onUnauthorized: () => { sseUnauth++; },
    onDisconnected: () => { sseDisconnect++; },
  });
  assert.equal(sseUnauth, 1);
  assert.equal(sseDisconnect, 0);
});

const hostDeps = existsSync(new URL('../../host/server/node_modules/ws/package.json', import.meta.url));

test('real bridge.js + services.js + boot-data.js + model-bridge.mjs against live createSelfHostServer', {
  skip: !hostDeps && 'run npm ci --prefix host/server',
}, async t => {
  const { createSelfHostServer } = await import('../../host/server/index.mjs');

  const dataDir = await mkdtemp(path.join(tmpdir(), 'rokbot-web-m33-host-'));
  const stageDir = await mkdtemp(path.join(tmpdir(), 'rokbot-web-m33-stage-'));
  t.after(() => rm(stageDir, { recursive: true, force: true }));

  // Mock OpenAI upstream for /local/model/catalog and /local/model/test
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-5-mini' }, { id: 'gpt-5' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"id":"chat-1","model":"gpt-5","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const core = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/listAgents' ? [{ id: 'demo', name: 'Demo Bot' }] : null));
  });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  t.after(() => new Promise(resolve => core.close(resolve)));

  let voiceEnabled = true;
  const host = await createSelfHostServer({
    dataDir,
    hostUrl: coreUrl,
    vncUrl: coreUrl,
    forkVncUrl: coreUrl,
    internalToken: randomBytes(24).toString('base64url'),
    onModelSaved: async () => ({ status: 'applied', error: '' }),
  });
  // Intercept /local/voice/status cleanly via core or hook? Host handles /local/voice/status directly;
  // check Host startup and install a valid 1.2.3 Web bundle.
  await host.start(0, '127.0.0.1');
  // Close first: the Host finishes its pending writes (canvas link origin, stores) on close.
  t.after(async () => { await host.close(); await rm(dataDir, { recursive: true, force: true }); });

  const hostOrigin = `http://127.0.0.1:${host.server.address().port}`;
  const webOrigin = `http://127.0.0.1:${host.webServer.address().port}`;
  const adminPassword = 'AdminPass123!';
  const adminToken = await host.auth.setup(host.auth.setupKey, adminPassword);
  const adminCookie = `rokbot_admin=${adminToken}`;

  // Build and install a valid Web bundle carrying icon.png, icon-512.png, and model-bridge.mjs
  const fakeDist = path.join(stageDir, 'dist');
  await mkdir(path.join(fakeDist, 'renderer/assets'), { recursive: true });
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\' ws: sand-media:; frame-src sand-html-preview: sand-canvas: sand-mcp-app:;" />';
  await writeFile(path.join(fakeDist, 'renderer/index.html'), webIndexHtml(
    `<!doctype html><html><head>${csp}</head><body><div id="root"></div><script type="module" crossorigin src="./assets/index-Demo.js"></script></body></html>`,
  ));
  await writeFile(path.join(fakeDist, 'renderer/assets/index-Demo.js'), 'export {};\n');
  const { icon, icon512 } = await readWebIcons(repo);
  const buildInfo = { rendererVersion: '1.2.3', recommended: true, sourceAsarSha256: 'a'.repeat(64), builtAt: '2026-11-19T00:00:00.000Z' };
  const files = await bundleFiles({ dist: fakeDist, preload: 'module.exports = {};', vncPreload: 'module.exports = {};', icon, icon512, build: buildInfo });
  const { zip } = bundleZip(files, buildInfo);
  await host.webClient.install(zip);

  // Verify /web/manifest.webmanifest and /local-client/icon.png on the web listener
  const manifestRes = await fetch(`${webOrigin}/web/manifest.webmanifest`);
  assert.equal(manifestRes.status, 200);
  const manifestJson = await manifestRes.json();
  assert.deepEqual(manifestJson.icons.map(i => i.src), ['/web/client/icon.png', '/web/client/icon-512.png']);

  // 1. Pair an admin-web session via /admin/api/web-client/open ticket -> /web/api/ticket
  const openRes = await fetch(`${hostOrigin}/admin/api/web-client/open`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-rokbot-csrf': '1' },
    body: JSON.stringify({ deviceName: 'Admin Web Test' }),
  });
  assert.equal(openRes.status, 201);
  assert.equal(openRes.headers.get('set-cookie'), null);
  const openTicket = new URLSearchParams((await openRes.json()).url.split('#')[1]).get('ticket');
  const ticketRes = await fetch(`${webOrigin}/web/api/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rokbot-web': '1' },
    body: JSON.stringify({ ticket: openTicket }),
  });
  assert.equal(ticketRes.status, 201);
  let activeWebCookie = ticketRes.headers.get('set-cookie').split(';')[0];

  const iconRes = await fetch(`${webOrigin}/local-client/icon.png`, {
    headers: { cookie: activeWebCookie },
  });
  assert.equal(iconRes.status, 200);
  const iconBytes = Buffer.from(await iconRes.arrayBuffer());
  assert.equal(sha(iconBytes), sha(icon));

  // Stage real web/client + mac/clients/desktop into stageDir/client to import real bridge.js
  const clientStage = path.join(stageDir, 'client');
  await cp(path.join(repo, 'web/client'), clientStage, { recursive: true });
  await cp(path.join(repo, 'mac/clients/desktop'), path.join(clientStage, 'desktop'), { recursive: true });
  // The bundle serves shared .cjs scripts as .js (web/patchers/patch.mjs bundleFiles).
  await cp(path.join(repo, 'mac/clients/desktop/composer-assist.cjs'), path.join(clientStage, 'desktop/composer-assist.js'));
  await writeFile(path.join(clientStage, 'official-preload.js'), [
    'export const methods = ["listAgents"];',
    'export const edges = { "desktop-mount": ["mountPanel"] };',
    'export default function preload(require, proc) {',
    '  const { ipcRenderer, contextBridge } = require("electron");',
    '  if (typeof proc?.getSystemVersion !== "function") throw new TypeError("process.getSystemVersion is not a function");',
    '  const systemVersion = proc.getSystemVersion();',
    '  if (typeof systemVersion !== "string") throw new TypeError("process.getSystemVersion() must return a string");',
    '  contextBridge.exposeInMainWorld("__testPreloadIpc", ipcRenderer);',
    '  contextBridge.exposeInMainWorld("__testPreloadProcess", proc);',
    '  contextBridge.exposeInMainWorld("desktop", {',
    '    environment: { platform: proc.platform, systemVersion },',
    '  });',
    '}',
  ].join('\n'));

  // Prepare browser globals + boot-data.js wrapped fetch with real Host cookie jar
  const savedGlobals = new Map();
  const setGlobal = (key, value) => {
    if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  t.after(() => {
    for (const [key, desc] of savedGlobals) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  });

  const redirects = [];
  const store = new Map();
  const classes = new Set();
  const docEl = {
    nodeType: 1,
    localName: 'html',
    lang: 'en',
    style: { colorScheme: '' },
    classList: {
      add: (...xs) => xs.forEach(x => classes.add(x)),
      toggle: (x, force) => (force ? classes.add(x) : classes.delete(x)),
    },
  };
  const fakeDoc = {
    readyState: 'complete',
    visibilityState: 'visible',
    documentElement: docEl,
    head: { append() {}, appendChild() {} },
    body: { append() {}, appendChild() {} },
    activeElement: null,
    hasFocus: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, remove() {}, append() {}, appendChild() {} }),
    addEventListener() {},
  };

  let interceptLocalModel401 = false;
  const realNodeFetch = fetch;
  const wrappedTransport = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const resolved = new URL(rawUrl, webOrigin);
    if (interceptLocalModel401 && resolved.pathname === '/local/model') {
      return new Response(JSON.stringify({ error: 'feature unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const headers = new Headers(init.headers ?? {});
    if (activeWebCookie && resolved.origin === webOrigin) headers.set('cookie', activeWebCookie);
    return realNodeFetch(resolved.href, { ...init, headers });
  };

  setGlobal('localStorage', {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  });
  setGlobal('document', fakeDoc);
  setGlobal('location', {
    origin: webOrigin,
    href: `${webOrigin}/web/renderer/index.html`,
    pathname: '/web/renderer/index.html',
    search: '',
    hash: '',
    assign: url => { redirects.push(url); },
    reload: () => {},
  });
  setGlobal('history', { state: null, replaceState() {} });
  setGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/126.0', language: 'en-US', platform: 'Linux', maxTouchPoints: 0 });
  setGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  setGlobal('CSS', { supports: () => true });
  const eventListeners = new Map();
  setGlobal('Node', { ELEMENT_NODE: 1 });
  setGlobal('Element', class FakeElement {});
  setGlobal('HTMLElement', class FakeHTMLElement {});
  setGlobal('MutationObserver', class FakeMutationObserver { observe() {} disconnect() {} });
  setGlobal('getComputedStyle', () => ({ backgroundColor: 'rgb(255, 255, 255)', visibility: 'visible' }));
  setGlobal('requestAnimationFrame', () => 1);
  setGlobal('addEventListener', (type, fn) => {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type).add(fn);
  });
  t.after(() => {
    for (const fn of eventListeners.get('pagehide') ?? []) fn();
  });
  setGlobal('window', globalThis);
  setGlobal('fetch', wrappedTransport);

  // Run real boot-data.js so window.fetch injects x-rokbot-web: 1 and __rokbotAndroidBoot is populated
  const bootSource = await readFile(path.join(clientStage, 'boot-data.js'), 'utf8');
  vm.runInThisContext(bootSource);

  // Import real bridge.js
  await import(pathToFileURL(path.join(clientStage, 'bridge.js')).href);
  const ipc = globalThis.__testPreloadIpc;
  const preloadProc = globalThis.__testPreloadProcess;
  const desktop = globalThis.window.desktop;
  const localBot = globalThis.window.localBot;
  assert.ok(ipc, 'official preload should receive ipcRenderer from bridge.js');
  assert.ok(preloadProc && typeof preloadProc.getSystemVersion === 'function', 'bridge.js must pass preloadProcess.getSystemVersion()');
  assert.equal(typeof preloadProc.getSystemVersion(), 'string');
  assert.equal(preloadProc.platform, 'android');
  assert.equal(preloadProc.type, 'renderer');
  assert.ok(Array.isArray(preloadProc.argv));
  assert.equal(typeof preloadProc.env, 'object');
  assert.equal(typeof preloadProc.versions, 'object');
  assert.deepEqual(desktop?.environment, { platform: 'android', systemVersion: '' });
  assert.ok(localBot, 'window.localBot must exist on window');
  assert.ok(Object.isFrozen(localBot), 'window.localBot must be frozen on window');

  // Verify sand_client_pause across boot snapshot, getExperimentsSnapshot, and experiments-changed
  const bootSnap = ipc.sendSync('sand:boot-snapshot-sync');
  assert.equal(bootSnap.experiments.featureGates.sand_client_pause, false);

  const emittedEvents = [];
  ipc.on('dune-rpc:main:e:experiments-changed', (_ev, payload) => emittedEvents.push(payload));
  const snapRes = await ipc.invoke('dune-rpc:main:m:getExperimentsSnapshot');
  assert.equal(snapRes.ok, true);
  assert.equal(snapRes.value.featureGates.sand_client_pause, false);

  // Trigger experiments-changed via voice preference toggle
  await ipc.invoke('dune-rpc:main:m:setRealtimeVoiceEnabled', { enabled: voiceEnabled });
  assert.equal(bootSnap.experiments.featureGates.sand_client_pause, false);
  // Also verify sand_client_pause stays false if voice gate toggles via fetch
  const origBootFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (new URL(raw, webOrigin).pathname === '/local/voice/status') {
      return new Response(JSON.stringify({ enabled: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return origBootFetch(input, init);
  };
  const snapAfterVoice = await ipc.invoke('dune-rpc:main:m:getExperimentsSnapshot');
  assert.equal(snapAfterVoice.value.featureGates.sand_client_pause, false);
  assert.equal(snapAfterVoice.value.featureGates.sand_voice_call, true);
  assert.ok(emittedEvents.some(ev => ev.featureGates.sand_client_pause === false));
  globalThis.fetch = origBootFetch;

  // Verify all 9 1.2.3 .desktop.* IPC methods and dune-rpc:main:probe
  const desktopMethods = [
    'getMessagesCapabilities',
    'setMessagesCapabilities',
    'getMacMailSendEnabled',
    'setMacMailSendEnabled',
    'getLocalToolActionGrant',
    'setLocalToolActionGrant',
    'getDesktopNotificationPermission',
    'requestDesktopNotificationPermission',
    'openDesktopNotificationSettings',
  ];
  for (const name of desktopMethods) {
    assert.deepEqual(await ipc.invoke('dune-rpc:main:probe', name), { ok: true, value: true }, `probe ${name}`);
  }
  assert.deepEqual(await ipc.invoke('dune-rpc:main:probe', 'nonexistentDesktop123Method'), { ok: true, value: false });
  assert.equal((await ipc.invoke('dune-rpc:main:m:nonexistentDesktop123Method')).ok, false);

  // Guard against Object.prototype keys and non-string method names on dune-rpc:main:probe and services.call
  const { createServices } = await import(pathToFileURL(path.join(clientStage, 'services.js')).href);
  const isolatedServices = createServices({
    gateway: { command: async () => null, request: async () => null },
    server: hostOrigin,
    emit: () => {},
    settings: {},
    systemLocale: 'en-US',
    theme: {},
    language: {},
    boot: {},
    experiments: {},
    profile: {},
    voice: { refresh: () => ({ featureGates: {} }), set: async () => null },
    persistence: { readClientPersistence: () => null },
    attachments: {},
    onSettingsChanged: () => {},
    systemDark: () => false,
    applyChrome: () => {},
  });
  for (const protoMethod of ['__proto__', 'toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    assert.deepEqual(await ipc.invoke('dune-rpc:main:probe', protoMethod), { ok: true, value: false }, `probe ${protoMethod}`);
    const callRes = await ipc.invoke(`dune-rpc:main:m:${protoMethod}`);
    assert.equal(callRes.ok, false, `ipc call ${protoMethod} must fail`);
    assert.match(callRes.failure.detail, /Unknown desktop service method/);
    assert.equal(isolatedServices.has(protoMethod), false, `services.has(${protoMethod})`);
    await assert.rejects(() => isolatedServices.call(protoMethod), /Unknown desktop service method/);
  }
  for (const nonString of [123, null, undefined, {}, Symbol('bad'), Object.create(null)]) {
    assert.deepEqual(await ipc.invoke('dune-rpc:main:probe', nonString), { ok: true, value: false });
    assert.equal(isolatedServices.has(nonString), false);
    await assert.rejects(() => isolatedServices.call(nonString), /Unknown desktop service method/);
  }

  assert.deepEqual(await ipc.invoke('dune-rpc:main:m:getMessagesCapabilities'), { ok: true, value: { read: false, send: false } });
  const setMsg = await ipc.invoke('dune-rpc:main:m:setMessagesCapabilities', { read: true });
  assert.equal(setMsg.ok, false);
  assert.match(setMsg.failure.detail, /Messages service unavailable|信息服务不可用/);

  assert.deepEqual(await ipc.invoke('dune-rpc:main:m:getMacMailSendEnabled'), { ok: true, value: false });
  const setMail = await ipc.invoke('dune-rpc:main:m:setMacMailSendEnabled', { enabled: true });
  assert.equal(setMail.ok, false);
  assert.match(setMail.failure.detail, /Mail send service unavailable|邮件发送服务不可用/);

  assert.deepEqual(await ipc.invoke('dune-rpc:main:m:getLocalToolActionGrant', { action: 'send-imessage' }), { ok: true, value: { granted: false } });
  assert.deepEqual(await ipc.invoke('dune-rpc:main:m:setLocalToolActionGrant', { action: 'send-imessage', granted: true }), { ok: true, value: { stored: false } });
  assert.deepEqual(await ipc.invoke('dune-rpc:main:m:getDesktopNotificationPermission'), { ok: true, value: { status: 'granted', canOpenSettings: false } });
  assert.deepEqual(await ipc.invoke('dune-rpc:main:m:requestDesktopNotificationPermission'), { ok: true, value: { status: 'granted', canOpenSettings: false } });
  assert.deepEqual(await ipc.invoke('dune-rpc:main:m:openDesktopNotificationSettings'), { ok: true, value: false });

  // window.localBot.getUsage reads the Host's usage ledger: today's totals plus periods per model.
  const usageAt = new Date(Date.now() - 60000).toISOString();
  await mkdir(path.join(dataDir, 'usage'), { recursive: true });
  await writeFile(path.join(dataDir, 'usage', usageAt.slice(0, 10) + '.jsonl'), [
    { id: 'u1', at: usageAt, model: 'gpt-5', kind: 'chat', input: 12000, output: 345, total: 12345, cached: 10000, cacheWrite: 0, reasoning: 0 },
    { id: 'u2', at: usageAt, model: 'claude-opus', kind: 'chat', input: 900, output: 100, total: 1000, cached: 0, cacheWrite: 50, reasoning: 0 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const usage = await localBot.getUsage({ timeZone: 'UTC' });
  assert.equal(usage.ok, true);
  assert.equal(usage.timeZone, 'UTC');
  assert.equal(usage.total, 13345);
  assert.equal(usage.requests, 2);
  assert.deepEqual(usage.periods.map(period => [period.id, period.total]), [['today', 13345], ['7d', 13345], ['30d', 13345]]);
  assert.deepEqual(usage.models.map(item => [item.model, item.input, item.output, item.cached, item.cacheWrite, item.total, item.requests]),
    [['gpt-5', 12000, 345, 10000, 0, 12345, 1], ['claude-opus', 900, 100, 0, 50, 1000, 1]]);
  // A time zone the Host rejects falls back to this browser's own.
  assert.equal((await localBot.getUsage({ timeZone: 'Not/AZone' })).ok, true);
  // The usage report through the web listener: range, filters, a page of requests and CSV.
  const report = await localBot.getUsage({ timeZone: 'UTC', report: { range: '7d', model: 'gpt-5', limit: 5 } });
  assert.equal(report.ok, true);
  assert.equal(report.version, 2);
  assert.deepEqual([report.totals.requests, report.totals.total, report.requests.items[0].id], [1, 12345, 'u1']);
  assert.deepEqual(report.options.model.map(item => item.key), ['gpt-5', 'claude-opus']);
  const exported = await localBot.getUsage({ timeZone: 'UTC', report: { range: 'today', export: 'csv' } });
  assert.equal(exported.count, 2);
  assert.match(exported.csv, /^\ufeff时间,Bot,场景,模型/);
  assert.equal((await localBot.getUsage({ timeZone: 'UTC', report: { range: 'custom', from: '2026-02-30', to: '2026-03-01' } })).status, 400);

  // Verify window.localBot model endpoints under admin-web session
  const adminStatus = await localBot.getLocalStatus();
  assert.equal(adminStatus.ok, true);
  assert.equal(adminStatus.needsModel, true);
  assert.equal(adminStatus.canConfigureModel, true);

  const adminGet = await localBot.getModelConfig();
  assert.equal(adminGet.ok, true);
  assert.equal(adminGet.canConfigureModel, true);

  const adminPut = await localBot.updateModelConfig({
    version: 1,
    providers: [{ id: 'openai-1', name: 'OpenAI', apiFormat: 'openai', baseUrl: upstreamUrl, apiKey: 'sk-real-secret' }],
    profiles: [{
      id: 'fast',
      name: 'Fast Profile',
      providerId: 'openai-1',
      model: 'gpt-5',
      efforts: ['low', 'high'],
      contextWindowTokens: 64000,
      summaryThresholdTokens: 48000,
    }],
    defaultRoute: { profileId: 'fast', effort: 'low', fallbacks: [] },
    botRoutes: {},
  });
  assert.equal(adminPut.ok, true);
  assert.equal(adminPut.config.providers[0].hasApiKey, true);
  assert.equal(adminPut.config.providers[0].apiKey, undefined);

  const catRes = await localBot.fetchModelCatalog({ providerId: 'openai-1' });
  assert.equal(catRes.ok, true);
  assert.ok(catRes.models.some(m => m.id === 'gpt-5-mini'));

  const testRes = await localBot.testModelConfig({ profileId: 'fast' });
  assert.equal(testRes.ok, true);
  assert.equal(testRes.reply, 'OK');
  assert.equal(typeof testRes.latencyMs, 'number');

  // Switch activeWebCookie to a pairing-key Web session -> canConfigureModel: false, 403, step-up with adminPassword, blank apiKey preservation
  const { pairingKey } = await host.auth.createPairing();
  const pairRes = await fetch(`${webOrigin}/web/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rokbot-web': '1' },
    body: JSON.stringify({ pairingKey, deviceName: 'Guest Web Browser', clientDeviceId: 'web-guest-1' }),
  });
  assert.equal(pairRes.status, 201);
  activeWebCookie = pairRes.headers.get('set-cookie').split(';')[0];
  const guestDeviceId = (await pairRes.json()).deviceId;

  const guestStatus = await localBot.getLocalStatus();
  assert.equal(guestStatus.ok, true);
  assert.equal(guestStatus.canConfigureModel, false);
  assert.equal(guestStatus.needsModel, false);

  const guest403 = await localBot.getModelConfig();
  assert.equal(guest403.ok, false);
  assert.equal(guest403.status, 403);
  assert.equal(guest403.canConfigureModel, false);
  assert.deepEqual(redirects, [], '403 must not redirect session');

  // Step-up via adminPassword with blank apiKey preserves stored sk-real-secret on Host
  const stepUpPut = await localBot.updateModelConfig({
    adminPassword,
    version: 1,
    providers: [{ id: 'openai-1', name: 'OpenAI Renamed', apiFormat: 'openai', baseUrl: upstreamUrl, apiKey: '   ' }],
    profiles: [{
      id: 'fast',
      name: 'Fast Profile',
      providerId: 'openai-1',
      model: 'gpt-5-mini',
      efforts: ['low', 'high'],
      contextWindowTokens: 64000,
      summaryThresholdTokens: 48000,
    }],
    defaultRoute: { profileId: 'fast', effort: 'low', fallbacks: [] },
    botRoutes: {},
  });
  assert.equal(stepUpPut.ok, true);
  assert.equal(stepUpPut.config.providers[0].name, 'OpenAI Renamed');
  assert.equal(stepUpPut.config.providers[0].hasApiKey, true);
  const savedEnv = await readFile(path.join(dataDir, 'model.env'), 'utf8');
  assert.ok(savedEnv.includes('sk-real-secret'), 'blank apiKey must preserve stored Host secret');
  assert.equal(savedEnv.includes(adminPassword), false, 'adminPassword must never be persisted to model.env');

  // Non-revoking feature 401 when /connect/status still reports connected: true
  interceptLocalModel401 = true;
  const feature401 = await localBot.getModelConfig();
  assert.equal(feature401.ok, false);
  assert.equal(feature401.status, 401);
  assert.equal(feature401.canConfigureModel, false);
  assert.deepEqual(redirects, [], 'valid rokbot_web session must not be logged out on feature 401');
  interceptLocalModel401 = false;

  // Revoked rokbot_web cookie -> /connect/status returns 401 -> triggers onUnauthorized (/web/login?expired=1)
  await host.auth.revoke(guestDeviceId);
  const revoked401 = await localBot.getModelConfig();
  assert.equal(revoked401.ok, false);
  assert.equal(revoked401.status, 401);
  assert.equal(revoked401.canConfigureModel, false);
  assert.deepEqual(redirects, ['/web/login?expired=1']);
});

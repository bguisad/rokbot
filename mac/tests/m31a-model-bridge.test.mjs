import assert from 'node:assert/strict';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../clients/desktop/gateway.mjs';
import { createModelBridge, sanitizeModelPayload } from '../clients/desktop/model-bridge.mjs';

const desktopDir = fileURLToPath(new URL('../clients/desktop/', import.meta.url));
const preloadPath = path.join(desktopDir, 'preload.cjs');

async function startServer(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    await handler(req, res, bodyText ? JSON.parse(bodyText) : null);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('preload.cjs exposes all window.localBot methods including /local/status and /local/model* IPC bridges', () => {
  const invoked = [];
  const sent = [];
  const exposed = {};
  const fakeElectron = {
    ipcRenderer: {
      sendSync: channel => (channel === 'rokbot-local:locale' ? 'zh-CN' : null),
      send: (channel, arg) => sent.push({ channel, arg }),
      invoke: async (channel, arg) => {
        invoked.push({ channel, arg });
        return { ok: true, channel, arg };
      },
      on: () => {},
      removeListener: () => {},
    },
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        exposed[name] = api;
      },
    },
  };

  const prevWindow = globalThis.window;
  const origLoad = Module._load;
  globalThis.window = {
    addEventListener: () => {},
  };
  globalThis.window.top = globalThis.window;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === '../dist/electron-preload/preload.cjs') return {};
    return origLoad.apply(this, arguments);
  };
  try {
    const req = createRequire(import.meta.url);
    delete req.cache[preloadPath];
    req(preloadPath);
  } finally {
    Module._load = origLoad;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }

  const api = exposed.localBot;
  assert.ok(api, 'window.localBot must be exposed');
  assert.equal(api.locale, 'zh-CN');

  for (const name of [
    'locale',
    'openManagement',
    'updateProfile',
    'connectionStatus',
    'mintVoiceCredential',
    'getVoicePreference',
    'setVoicePreference',
    'onVoicePreferenceChanged',
    'pair',
    'disconnect',
    'onConnectionChanged',
    'getLocalStatus',
    'getModelConfig',
    'updateModelConfig',
    'fetchModelCatalog',
    'testModelConfig',
    'getUsage',
  ]) {
    assert.ok(name in api, `missing window.localBot.${name}`);
  }

  api.getLocalStatus();
  api.getModelConfig();
  api.updateModelConfig({ defaultRoute: { profileId: 'p1' } });
  api.fetchModelCatalog({ providerId: 'prov1' });
  api.testModelConfig({ profileId: 'p1' });
  api.getUsage({ timeZone: 'Asia/Shanghai' });

  assert.deepEqual(invoked, [
    { channel: 'rokbot-local:local-status', arg: undefined },
    { channel: 'rokbot-local:model-get', arg: undefined },
    { channel: 'rokbot-local:model-put', arg: { defaultRoute: { profileId: 'p1' } } },
    { channel: 'rokbot-local:model-catalog', arg: { providerId: 'prov1' } },
    { channel: 'rokbot-local:model-test', arg: { profileId: 'p1' } },
    { channel: 'rokbot-local:usage', arg: { timeZone: 'Asia/Shanghai' } },
  ]);
});

test('sanitizeModelPayload recursively omits blank apiKey/jevApiKey and strips adminPassword without inventing dummy keys', () => {
  const sanitized = sanitizeModelPayload({
    version: 1,
    adminPassword: 'top-secret-password',
    apiKey: '   ',
    jevApiKey: '',
    providers: [
      { id: 'p1', baseUrl: 'https://api.example/v1', apiKey: '' },
      { id: 'p2', baseUrl: 'https://api2.example/v1', apiKey: null },
      { id: 'p3', baseUrl: 'https://api3.example/v1', apiKey: undefined },
      { id: 'p4', baseUrl: 'https://api4.example/v1', apiKey: 'sk-real-key' },
    ],
    provider: { id: 'p5', apiKey: '\t\n' },
  });

  assert.equal('adminPassword' in sanitized, false);
  assert.equal('apiKey' in sanitized, false);
  assert.equal('jevApiKey' in sanitized, false);
  assert.deepEqual(sanitized.providers, [
    { id: 'p1', baseUrl: 'https://api.example/v1' },
    { id: 'p2', baseUrl: 'https://api2.example/v1' },
    { id: 'p3', baseUrl: 'https://api3.example/v1' },
    { id: 'p4', baseUrl: 'https://api4.example/v1', apiKey: 'sk-real-key' },
  ]);
  assert.deepEqual(sanitized.provider, { id: 'p5' });
});

test('model-bridge + gateway handle 200, 401 without revoking valid device, 403, 503, reload normalization, latencyMs, and x-rokbot-admin-password', async t => {
  const requests = [];
  let mode = 'normal';
  let connectStatus = 200;

  const srv = await startServer((req, res, body) => {
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      contentType: req.headers['content-type'],
      adminPassword: req.headers['x-rokbot-admin-password'],
      body,
    });

    if (req.url === '/connect/status') {
      res.writeHead(connectStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(connectStatus === 200 ? { deviceId: 'dev-1', connected: true } : { error: 'revoked' }));
      return;
    }
    if (req.url === '/local/status' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        initialized: true,
        needsModel: true,
        canConfigureModel: true,
        hostVersion: '2bb5e41',
        defaultMachineId: 'mac-1',
      }));
      return;
    }
    if (req.url === '/local/model' && req.method === 'GET') {
      if (mode === '401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '需要管理员密码授权' }));
        return;
      }
      if (mode === '403') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Host 已禁用客户端修改模型配置' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        canConfigureModel: true,
        config: { providers: [{ id: 'default', hasApiKey: true }] },
        reload: { revision: 'rev-1', status: 'error', message: 'Host 未能应用配置' },
      }));
      return;
    }
    if (req.url === '/local/model' && req.method === 'PUT') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        config: { providers: [{ id: 'default', hasApiKey: true }] },
        reload: { revision: 'rev-2', status: 'waiting', updatedAt: '2026-11-19T21:00:00Z' },
      }));
      return;
    }
    if (req.url === '/local/model/catalog' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, models: [{ id: 'gpt-5', efforts: ['low', 'high'] }] }));
      return;
    }
    if (req.url.startsWith('/local/usage?') && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ date: '2026-11-25', total: 12345, models: [{ model: 'gpt-5', total: 12345 }], periods: [] }));
      return;
    }
    if (req.url === '/local/model/test' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: 'gpt-5', message: 'OK' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => srv.close());

  let unauthorizedCalls = 0;
  let connected = true;
  const gw = createGateway({ server: srv.url, token: 'device-token-123' }, () => { unauthorizedCalls++; });
  t.after(() => gw.close());

  const bridge = createModelBridge({
    getGateway: () => gw,
    getConnected: () => connected,
  });

  // Disconnected -> 503 plain JSON, never throws.
  connected = false;
  const offline = await bridge.getLocalStatus();
  assert.deepEqual(offline.ok, false);
  assert.equal(offline.status, 503);
  connected = true;

  // 200 GET /local/status
  const statusRes = await bridge.getLocalStatus();
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.needsModel, true);
  assert.equal(statusRes.canConfigureModel, true);

  // 200 GET /local/model with reload.message -> reload.error normalization
  const getRes = await bridge.getModelConfig();
  assert.equal(getRes.ok, true);
  assert.equal(getRes.reload.status, 'error');
  assert.equal(getRes.reload.error, 'Host 未能应用配置');

  // PUT /local/model preserves omitted/empty apiKey, forwards x-rokbot-admin-password header, never puts adminPassword in JSON
  const putRes = await bridge.updateModelConfig({
    version: 1,
    adminPassword: 'admin-step-up-pw',
    providers: [{ id: 'default', apiFormat: 'openai', baseUrl: 'https://api.example/v1', apiKey: '   ' }],
  });
  assert.equal(putRes.ok, true);
  assert.equal(putRes.reload.status, 'waiting');
  assert.equal(putRes.reload.error, '');
  const putReq = requests.find(r => r.method === 'PUT' && r.url === '/local/model');
  assert.equal(putReq.adminPassword, 'admin-step-up-pw');
  assert.equal(putReq.auth, 'Bearer device-token-123');
  assert.equal('adminPassword' in putReq.body, false);
  assert.equal('apiKey' in putReq.body.providers[0], false);

  // POST /local/model/catalog & POST /local/model/test
  const catRes = await bridge.fetchModelCatalog({
    adminPassword: 'pw2',
    provider: { id: 'default', baseUrl: 'https://api.example/v1', apiKey: '' },
  });
  assert.equal(catRes.ok, true);
  assert.equal(catRes.models[0].id, 'gpt-5');
  const catReq = requests.find(r => r.url === '/local/model/catalog');
  assert.equal(catReq.adminPassword, 'pw2');
  assert.equal('apiKey' in catReq.body.provider, false);

  const testRes = await bridge.testModelConfig({ profileId: 'default', apiKey: null });
  assert.equal(testRes.ok, true);
  assert.equal(testRes.reply, 'OK');
  assert.equal(typeof testRes.latencyMs, 'number');
  assert.ok(testRes.latencyMs >= 0);

  // GET /local/usage carries the time zone; an invalid one falls back to this computer's.
  const usageRes = await bridge.getUsage({ timeZone: 'Asia/Shanghai' });
  assert.equal(usageRes.ok, true);
  assert.equal(usageRes.models[0].model, 'gpt-5');
  assert.equal(requests.at(-1).url, '/local/usage?timeZone=Asia%2FShanghai');
  assert.equal(requests.at(-1).auth, 'Bearer device-token-123');
  await bridge.getUsage({ timeZone: 'Not/AZone' });
  assert.equal(requests.at(-1).url, `/local/usage?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
  connected = false;
  assert.equal((await bridge.getUsage()).status, 503);
  connected = true;

  // extraHeaders in gateway.request cannot clobber Authorization or Content-Type
  await gw.request('/local/status', undefined, undefined, 'GET', {
    authorization: 'Bearer evil',
    'content-type': 'text/plain',
    'x-rokbot-admin-password': 'pw3',
  });
  const lastStatusReq = requests[requests.length - 1];
  assert.equal(lastStatusReq.auth, 'Bearer device-token-123');
  assert.equal(lastStatusReq.contentType, 'application/json');
  assert.equal(lastStatusReq.adminPassword, 'pw3');

  // 401 on /local/model when /connect/status is 200 -> returns { ok: false, status: 401, canConfigureModel: false } WITHOUT revoking device!
  mode = '401';
  connectStatus = 200;
  const res401 = await bridge.getModelConfig();
  assert.equal(res401.ok, false);
  assert.equal(res401.status, 401);
  assert.equal(res401.canConfigureModel, false);
  assert.equal(unauthorizedCalls, 0);
  assert.notEqual(gw.getState(), 'disconnected');

  // 403 on /local/model -> returns { ok: false, status: 403, canConfigureModel: false }
  mode = '403';
  const res403 = await bridge.getModelConfig();
  assert.equal(res403.ok, false);
  assert.equal(res403.status, 403);
  assert.equal(res403.canConfigureModel, false);

  // Subsequent request still works because device was not revoked.
  mode = 'normal';
  assert.equal((await bridge.getLocalStatus()).ok, true);
});

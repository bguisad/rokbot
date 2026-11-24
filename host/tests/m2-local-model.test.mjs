import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Auth } from '../server/auth.mjs';
import { Models } from '../server/models.mjs';

const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));

function v1Payload(baseUrl, { apiKey = 'sk-test-secret-123', model = 'grok-test' } = {}) {
  return {
    version: 1,
    providers: [
      {
        id: 'primary',
        name: 'Primary Provider',
        apiFormat: 'openai',
        baseUrl,
        ...(apiKey !== undefined ? { apiKey } : {}),
      },
    ],
    profiles: [
      {
        id: 'fast',
        name: 'Fast Profile',
        providerId: 'primary',
        model,
        efforts: ['low', 'medium'],
        contextWindowTokens: 64000,
        summaryThresholdTokens: 48000,
      },
    ],
    defaultRoute: { profileId: 'fast', effort: 'low', fallbacks: [] },
    botRoutes: {},
  };
}

async function startMockModelUpstream(t) {
  let failChat = false;
  let emptyChat = false;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      assert.equal(req.headers.authorization, 'Bearer sk-test-secret-123');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        data: [
          { id: 'grok-test', context_window: 128000, supported_reasoning_efforts: ['low', 'high'] },
          { id: 'grok-mini' },
        ],
      }));
    }
    if (req.method === 'GET' && req.url === '/anthropic/v1/models') {
      assert.equal(req.headers['x-api-key'], 'sk-anthropic-456');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        data: [{ id: 'claude-test-1', max_input_tokens: 200000 }],
      }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (failChat) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'upstream error' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (emptyChat) {
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        return res.end('data: [DONE]\n\n');
      }
      res.write('data: {"id":"chat-1","model":"grok-test","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    setFailChat: val => { failChat = val; },
    setEmptyChat: val => { emptyChat = val; },
  };
}

async function startHostFixture(t, extraOptions = {}) {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-m2-model-'));
  const core = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/listAgents' ? [{ id: 'bot_1', name: 'Test Bot' }] : null));
  });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const host = await createSelfHostServer({
    dataDir: dir,
    hostUrl: coreUrl,
    vncUrl: coreUrl,
    forkVncUrl: coreUrl,
    internalToken: 'b'.repeat(40),
    ...extraOptions,
  });
  await host.start(0, '127.0.0.1');
  t.after(async () => {
    await host.close();
    await new Promise(resolve => core.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const call = (path, { token, cookie, headers, body, method = 'GET' } = {}) => fetch(origin + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return { dir, host, origin, call };
}

test('Auth tracks pairedWith across password, pairing-key, admin-web, and clientDeviceId reuse', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-auth-pairedwith-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = await new Auth(dir).load();
  await auth.setup(auth.setupKey, 'AdminPass123');

  const pwdDevice = await auth.pair({
    password: 'AdminPass123',
    deviceName: 'Admin Phone',
    platform: 'desktop',
    clientKind: 'android',
    clientDeviceId: 'dev-same-1',
  });
  assert.equal(auth.authenticate(pwdDevice.token).pairedWith, 'password');

  // Re-pairing same clientDeviceId via pairing-key downgrades pairedWith to 'pairing-key'
  const { pairingKey } = await auth.createPairing();
  const keyDevice = await auth.pair({
    pairingKey,
    deviceName: 'Admin Phone',
    platform: 'desktop',
    clientKind: 'android',
    clientDeviceId: 'dev-same-1',
  });
  assert.equal(keyDevice.deviceId, pwdDevice.deviceId);
  assert.equal(keyDevice.reused, true);
  assert.equal(auth.authenticate(keyDevice.token).pairedWith, 'pairing-key');

  const webAdmin = await auth.addWebDevice('Admin Web');
  assert.equal(auth.authenticate(webAdmin.token).pairedWith, 'admin-web');
});

test('Models.validated allows fresh Host v1 saves without migrateLegacyRouting and preserves whitespace apiKey in legacy mode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-models-fresh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = new Models(dir);

  // Fresh Host with no model.env must accept v1 payload without migrateLegacyRouting
  const saved = await models.save(v1Payload('https://api.example.com/v1'));
  assert.equal(saved.configured, true);
  assert.equal(saved.providers[0].hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes('sk-test-secret-123'), false);

  // Omitting apiKey or passing empty string retains stored key
  await models.save(v1Payload('https://api.example.com/v1', { apiKey: '' }));
  assert.equal((await models.current()).routing.providers[0].apiKey, 'sk-test-secret-123');

  // Legacy single-provider whitespace apiKey retains stored key
  await models.save({
    apiFormat: 'openai',
    baseUrl: 'https://legacy.example.com/v1',
    apiKey: '   ',
    model: 'gpt-legacy',
  });
  assert.equal((await models.current()).apiKey, 'sk-test-secret-123');
});

test('GET /connect/status dual-mode & GET /local/status onboarding and revocation detection', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const savedEnv = {
    ROKBOT_DEFAULT_MACHINE_ID: process.env.ROKBOT_DEFAULT_MACHINE_ID,
    GROKBOT_DEFAULT_MACHINE_ID: process.env.GROKBOT_DEFAULT_MACHINE_ID,
    ROKBOT_STATE_DIR: process.env.ROKBOT_STATE_DIR,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const { dir, host, call } = await startHostFixture(t);
  const runtimeDir = join(dir, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, 'host-status.json'), JSON.stringify({ ready: true, revision: '2bb5e41-test' }));
  process.env.ROKBOT_STATE_DIR = runtimeDir;
  process.env.GROKBOT_DEFAULT_MACHINE_ID = 'legacy-machine-99';

  // 1. Unauthenticated fresh Host /connect/status returns public onboarding summary without secrets
  const unauthFresh = await call('/connect/status');
  assert.equal(unauthFresh.status, 200);
  const freshJson = await unauthFresh.json();
  assert.deepEqual(freshJson, {
    ok: true,
    brand: 'RokBot',
    initialized: false,
    needsModel: true,
    configured: false,
    connected: false,
    hostName: host.profile.current().hostName,
  });
  assert.equal(freshJson.deviceId, undefined);

  // 2. Unauthenticated /local/status must reject 401
  assert.equal((await call('/local/status')).status, 401);

  // 3. Setup admin + pair password device and pairing-key device
  await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const pwdPair = await host.auth.pair({ password: 'AdminPass123', deviceName: 'My Mac', platform: 'desktop' });
  const { pairingKey } = await host.auth.createPairing();
  const keyPair = await host.auth.pair({ pairingKey, deviceName: 'Guest Phone', platform: 'desktop', clientKind: 'android' });

  // 4. Authenticated /connect/status returns connected: true + device metadata; revoked token returns 401
  const authConnect = await call('/connect/status', { token: pwdPair.token });
  assert.equal(authConnect.status, 200);
  const authConnectJson = await authConnect.json();
  assert.equal(authConnectJson.connected, true);
  assert.equal(authConnectJson.deviceId, pwdPair.deviceId);
  assert.equal(authConnectJson.initialized, true);
  assert.equal(authConnectJson.needsModel, true);

  assert.equal((await call('/connect/status', { token: 'r'.repeat(40) })).status, 401);

  // 5. /local/status reflects canConfigureModel, hostVersion, defaultMachineId (ROKBOT_* takes precedence over GROKBOT_*)
  const localPwd = await call('/local/status', { token: pwdPair.token });
  assert.equal(localPwd.status, 200);
  const localPwdJson = await localPwd.json();
  assert.equal(localPwdJson.canConfigureModel, true);
  assert.equal(localPwdJson.pairedWith, 'password');
  assert.equal(localPwdJson.hostVersion, '2bb5e41-test');
  assert.equal(localPwdJson.defaultMachineId, 'legacy-machine-99');
  assert.equal(localPwdJson.needsModel, true);
  assert.equal(localPwdJson.reload.status, 'none');

  process.env.ROKBOT_DEFAULT_MACHINE_ID = 'rokbot-machine-01';
  const localKey = await call('/local/status', { token: keyPair.token });
  assert.equal(localKey.status, 200);
  const localKeyJson = await localKey.json();
  assert.equal(localKeyJson.canConfigureModel, false);
  assert.equal(localKeyJson.pairedWith, 'pairing-key');
  assert.equal(localKeyJson.defaultMachineId, 'rokbot-machine-01');

  // Revoke password device -> /connect/status returns 401
  await host.auth.revoke(pwdPair.deviceId);
  assert.equal((await call('/connect/status', { token: pwdPair.token })).status, 401);
});

test('/local/model* authorization matrix: password, pairing-key, step-up rate limit, admin policy toggles & env override', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const prevEnv = {
    ROKBOT_ALLOW_DEVICE_MODEL_CONFIG: process.env.ROKBOT_ALLOW_DEVICE_MODEL_CONFIG,
    GROKBOT_ALLOW_DEVICE_MODEL_CONFIG: process.env.GROKBOT_ALLOW_DEVICE_MODEL_CONFIG,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const { host, call } = await startHostFixture(t);
  const adminToken = await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const adminCookie = `rokbot_admin=${adminToken}`;
  const adminHeaders = { 'x-rokbot-csrf': '1' };

  const pwdPair = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'Admin Mac',
    platform: 'desktop',
    clientDeviceId: 'mac-client-1',
  });
  const { pairingKey } = await host.auth.createPairing();
  const keyPair = await host.auth.pair({
    pairingKey,
    deviceName: 'Guest Android',
    platform: 'desktop',
    clientKind: 'android',
    clientDeviceId: 'android-guest-1',
  });

  // 1. Unauthenticated -> 401 on all /local/model* routes
  assert.equal((await call('/local/model')).status, 401);
  assert.equal((await call('/local/model', { method: 'PUT', body: {} })).status, 401);
  assert.equal((await call('/local/model/catalog', { method: 'POST', body: {} })).status, 401);
  assert.equal((await call('/local/model/test', { method: 'POST', body: {} })).status, 401);

  // 2. Password-paired device -> 200 on GET /local/model
  assert.equal((await call('/local/model', { token: pwdPair.token })).status, 200);

  // 3. Pairing-key device denied (403) on all 4 routes by default
  assert.equal((await call('/local/model', { token: keyPair.token })).status, 403);
  assert.equal((await call('/local/model', { method: 'PUT', token: keyPair.token, body: v1Payload('https://example.com/v1') })).status, 403);
  assert.equal((await call('/local/model/catalog', { method: 'POST', token: keyPair.token, body: {} })).status, 403);
  assert.equal((await call('/local/model/test', { method: 'POST', token: keyPair.token, body: {} })).status, 403);

  // 4. Pairing-key device with valid x-rokbot-admin-password -> 200
  const stepUpOk = await call('/local/model', {
    token: keyPair.token,
    headers: { 'x-rokbot-admin-password': 'AdminPass123' },
  });
  assert.equal(stepUpOk.status, 200);

  // 5. Wrong x-rokbot-admin-password -> 403, rate limited at 429 after 5 total step-up attempts (1 valid + 4 wrong)
  for (let i = 0; i < 4; i++) {
    const wrong = await call('/local/model', {
      token: keyPair.token,
      headers: { 'x-rokbot-admin-password': `WrongPass${i}` },
    });
    assert.equal(wrong.status, 403);
  }
  const blocked = await call('/local/model', {
    token: keyPair.token,
    headers: { 'x-rokbot-admin-password': 'AdminPass123' },
  });
  assert.equal(blocked.status, 429);

  // 6. Admin enables allowGuestModelConfig -> pairing-key device allowed without step-up
  const policyRes = await call('/admin/api/model/policy', {
    method: 'PUT',
    cookie: adminCookie,
    headers: adminHeaders,
    body: { allowDeviceModelConfig: true, allowGuestModelConfig: true },
  });
  assert.equal(policyRes.status, 200);
  assert.equal((await policyRes.json()).allowGuestModelConfig, true);
  assert.equal((await call('/local/model', { token: keyPair.token })).status, 200);
  assert.equal((await (await call('/local/status', { token: keyPair.token })).json()).canConfigureModel, true);

  // 7. Admin disables allowDeviceModelConfig -> both password & guest devices blocked (403)
  await call('/admin/api/model/policy', {
    method: 'PUT',
    cookie: adminCookie,
    headers: adminHeaders,
    body: { allowDeviceModelConfig: false, allowGuestModelConfig: true },
  });
  assert.equal((await call('/local/model', { token: pwdPair.token })).status, 403);
  assert.equal((await call('/local/model', { token: keyPair.token })).status, 403);
  assert.equal((await (await call('/local/status', { token: pwdPair.token })).json()).canConfigureModel, false);

  // Re-enable in DB, test ROKBOT_ALLOW_DEVICE_MODEL_CONFIG=0 and GROKBOT_ALLOW_DEVICE_MODEL_CONFIG=0
  await call('/admin/api/model/policy', {
    method: 'PUT',
    cookie: adminCookie,
    headers: adminHeaders,
    body: { allowDeviceModelConfig: true, allowGuestModelConfig: false },
  });
  process.env.GROKBOT_ALLOW_DEVICE_MODEL_CONFIG = '0';
  assert.equal((await call('/local/model', { token: pwdPair.token })).status, 403);
  delete process.env.GROKBOT_ALLOW_DEVICE_MODEL_CONFIG;
  process.env.ROKBOT_ALLOW_DEVICE_MODEL_CONFIG = '0';
  assert.equal((await call('/local/model', { token: pwdPair.token })).status, 403);
  delete process.env.ROKBOT_ALLOW_DEVICE_MODEL_CONFIG;
  assert.equal((await call('/local/model', { token: pwdPair.token })).status, 200);

  // 8. Re-pairing pwdPair's clientDeviceId with a pairing-key revokes its password privilege
  const code2 = (await host.auth.createPairing()).pairingKey;
  const downgraded = await host.auth.pair({
    pairingKey: code2,
    deviceName: 'Admin Mac',
    platform: 'desktop',
    clientDeviceId: 'mac-client-1',
  });
  assert.equal(downgraded.deviceId, pwdPair.deviceId);
  assert.equal((await call('/local/model', { token: downgraded.token })).status, 403);
});

test('/local/model CRUD, reload status transitions, catalog probe, and live model test', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const upstream = await startMockModelUpstream(t);
  let savedHookCount = 0;
  const { dir, host, call } = await startHostFixture(t, {
    onModelSaved: () => { savedHookCount++; },
  });
  await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const { token } = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'MacBook',
    platform: 'desktop',
  });

  // 1. PUT /local/model on fresh Host saves v1 config, strips secrets, triggers reload
  const putRes = await call('/local/model', {
    method: 'PUT',
    token,
    body: v1Payload(`${upstream.origin}/v1`),
  });
  assert.equal(putRes.status, 200);
  const putJson = await putRes.json();
  assert.equal(putJson.ok, true);
  assert.equal(putJson.configured, true);
  assert.equal(putJson.needsModel, false);
  assert.equal(putJson.reload.status, 'waiting');
  assert.ok(putJson.reload.revision);
  assert.equal(putJson.config.providers[0].hasApiKey, true);
  assert.equal(JSON.stringify(putJson).includes('sk-test-secret-123'), false);
  assert.equal(savedHookCount, 1);

  const envText = await readFile(join(dir, 'model.env'), 'utf8');
  assert.match(envText, /OPENAI_API_KEY=sk-test-secret-123/);

  // 2. Public /connect/status now reports needsModel: false
  const publicStatus = await (await call('/connect/status')).json();
  assert.equal(publicStatus.needsModel, false);
  assert.equal(publicStatus.configured, true);

  // 3. Simulate HostSupervisor writing model-reload-status.json ('applied' and 'error')
  const revision = putJson.reload.revision;
  await writeFile(join(dir, 'model-reload-status.json'), JSON.stringify({
    revision,
    status: 'applied',
    updatedAt: '2026-11-19T21:00:00.000Z',
  }));
  const getApplied = await (await call('/local/model', { token })).json();
  assert.equal(getApplied.reload.status, 'applied');
  assert.equal(getApplied.reload.error, null);

  await writeFile(join(dir, 'model-reload-status.json'), JSON.stringify({
    revision,
    status: 'error',
    message: 'Runtime failed',
    updatedAt: '2026-11-19T21:01:00.000Z',
  }));
  const getError = await (await call('/local/model', { token })).json();
  assert.equal(getError.reload.status, 'error');
  assert.ok(getError.reload.error);

  // 4. PUT /local/model omitting apiKey preserves stored key
  const putPreserve = await call('/local/model', {
    method: 'PUT',
    token,
    body: v1Payload(`${upstream.origin}/v1`, { apiKey: '', model: 'grok-mini' }),
  });
  assert.equal(putPreserve.status, 200);
  assert.equal((await host.models.current()).routing.providers[0].apiKey, 'sk-test-secret-123');
  assert.equal((await host.models.current()).model, 'grok-mini');

  // 5. POST /local/model/catalog using saved providerId (no apiKey re-sent) and inline Anthropic candidate
  const savedCatalog = await call('/local/model/catalog', {
    method: 'POST',
    token,
    body: { providerId: 'primary' },
  });
  assert.equal(savedCatalog.status, 200);
  const savedCatalogJson = await savedCatalog.json();
  assert.equal(savedCatalogJson.ok, true);
  assert.equal(savedCatalogJson.models[0].id, 'grok-test');
  assert.equal(savedCatalogJson.models[0].contextWindowTokens, 128000);

  const inlineCatalog = await call('/local/model/catalog', {
    method: 'POST',
    token,
    body: {
      provider: {
        id: 'anth',
        name: 'Anthropic',
        apiFormat: 'anthropic',
        baseUrl: `${upstream.origin}/anthropic`,
        apiKey: 'sk-anthropic-456',
      },
    },
  });
  assert.equal(inlineCatalog.status, 200);
  assert.equal((await inlineCatalog.json()).models[0].id, 'claude-test-1');

  // 6. POST /local/model/test returns latencyMs & reply; returns 502 on upstream failure / empty reply
  const testOk = await call('/local/model/test', {
    method: 'POST',
    token,
    body: {},
  });
  assert.equal(testOk.status, 200);
  const testOkJson = await testOk.json();
  assert.equal(testOkJson.ok, true);
  assert.equal(testOkJson.reply, 'OK');
  assert.equal(typeof testOkJson.latencyMs, 'number');
  assert.ok(testOkJson.latencyMs >= 0);

  upstream.setFailChat(true);
  assert.equal((await call('/local/model/test', { method: 'POST', token, body: {} })).status, 502);
  upstream.setFailChat(false);
  upstream.setEmptyChat(true);
  assert.equal((await call('/local/model/test', { method: 'POST', token, body: {} })).status, 502);
});

test('Iteration 2 regressions: short apiKey redaction, corrupt reload/model.env recovery, jevApiKey whitespace & routeFor model override', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const seenModels = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let bodyText = '';
      for await (const chunk of req) bodyText += chunk;
      const parsed = JSON.parse(bodyText);
      seenModels.push(parsed.model);
      if (req.headers.authorization === 'Bearer sk-777') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid key rejected: sk-777' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chat-2","model":"' + parsed.model + '","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  const { dir, host, call } = await startHostFixture(t);
  const adminToken = await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const adminCookie = `rokbot_admin=${adminToken}`;
  const { token } = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'MacBook',
    platform: 'desktop',
  });

  // 1. Short apiKey (< 8 chars) echoed in upstream 401 must be redacted in 502 error response
  await call('/local/model', {
    method: 'PUT',
    token,
    body: v1Payload(upstreamUrl, { apiKey: 'sk-777', model: 'grok-mini' }),
  });
  const shortTest = await call('/local/model/test', { method: 'POST', token, body: {} });
  assert.equal(shortTest.status, 502);
  const shortTestText = await shortTest.text();
  assert.equal(shortTestText.includes('sk-777'), false);
  assert.match(shortTestText, /\[redacted\]/);

  // 2. routeFor({ model }) honors inline model override on POST /local/model/test
  await call('/local/model', {
    method: 'PUT',
    token,
    body: v1Payload(upstreamUrl, { apiKey: 'sk-valid-long-key-1234', model: 'grok-mini' }),
  });
  const overrideTest = await call('/local/model/test', {
    method: 'POST',
    token,
    body: { model: 'grok-override' },
  });
  assert.equal(overrideTest.status, 200);
  assert.equal(seenModels.at(-1), 'grok-override');

  // 3. Whitespace-only jevApiKey preserves stored jevApiKey on PUT /local/model
  const withJev = await call('/local/model', {
    method: 'PUT',
    token,
    body: { ...v1Payload(upstreamUrl, { apiKey: 'sk-valid-long-key-1234' }), jevApiKey: 'sk-jev-secret-999' },
  });
  assert.equal(withJev.status, 200);
  const wsJev = await call('/local/model', {
    method: 'PUT',
    token,
    body: { ...v1Payload(upstreamUrl, { apiKey: '' }), jevApiKey: '   ' },
  });
  assert.equal(wsJev.status, 200);
  assert.equal((await host.models.current()).jevApiKey, 'sk-jev-secret-999');

  // 4. Corrupt model-reload-status.json & model-reload-request.json never crash /local/status, /local/model, or /admin/api/* with 500
  await writeFile(join(dir, 'model-reload-status.json'), '{broken');
  assert.equal((await call('/local/status', { token })).status, 200);
  assert.equal((await call('/local/model', { token })).status, 200);
  assert.equal((await call('/admin/api/status', { cookie: adminCookie })).status, 200);
  assert.equal((await call('/admin/api/model', { cookie: adminCookie })).status, 200);
  await writeFile(join(dir, 'model-reload-request.json'), '{broken');
  const corruptBoth = await call('/local/model', { token });
  assert.equal(corruptBoth.status, 200);
  assert.equal((await corruptBoth.json()).reload.status, 'none');

  // Preserve safe HostSupervisor status.message on error
  const rev = 'rev-sup-1';
  await writeFile(join(dir, 'model-reload-request.json'), JSON.stringify({ revision: rev, requestedAt: '2026-11-19T21:00:00.000Z' }));
  await writeFile(join(dir, 'model-reload-status.json'), JSON.stringify({
    revision: rev,
    status: 'error',
    message: 'Host 已退出，正在等待自动重试',
    updatedAt: '2026-11-19T21:01:00.000Z',
  }));
  const supErr = await (await call('/local/model', { token })).json();
  assert.equal(supErr.reload.status, 'error');
  assert.equal(supErr.reload.error, 'Host 已退出，正在等待自动重试');

  // 5. Corrupt model.env (ROKBOT_MODEL_ROUTING) degrades cleanly on GET /local/model & recovers via PUT /local/model
  await writeFile(join(dir, 'model.env'), 'ROKBOT_MODEL_ROUTING={broken\n');
  const corruptGet = await call('/local/model', { token });
  assert.equal(corruptGet.status, 200);
  const corruptGetJson = await corruptGet.json();
  assert.equal(corruptGetJson.needsModel, true);
  assert.equal(corruptGetJson.configured, false);
  assert.deepEqual(corruptGetJson.config.providers, []);
  assert.equal((await call('/admin/api/model', { cookie: adminCookie })).status, 200);

  const repairPut = await call('/local/model', {
    method: 'PUT',
    token,
    body: v1Payload(upstreamUrl, { apiKey: 'sk-repaired-key-1234', model: 'grok-repaired' }),
  });
  assert.equal(repairPut.status, 200);
  const repairJson = await repairPut.json();
  assert.equal(repairJson.configured, true);
  assert.equal(repairJson.needsModel, false);
  assert.equal((await host.models.current()).model, 'grok-repaired');
});

test('Iteration 3 regressions: saved-config jevApiKey redaction on /test & /catalog and empty/partial model-reload-request.json resilience', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const upstream = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Rejected keys: sk-777 | jv-99' } }));
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Rejected catalog keys: sk-777 | jv-99' } }));
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

  const { dir, host, call } = await startHostFixture(t);
  const adminToken = await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const adminCookie = `rokbot_admin=${adminToken}`;
  const { token } = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'MacBook',
    platform: 'desktop',
  });

  // 1. Saved-config POST /local/model/test ({}) and POST /admin/api/model/test ({}) must redact jevApiKey & apiKey
  const saveRes = await call('/local/model', {
    method: 'PUT',
    token,
    body: {
      ...v1Payload(upstreamUrl, { apiKey: 'sk-777', model: 'grok-mini' }),
      jevApiKey: 'jv-99',
    },
  });
  assert.equal(saveRes.status, 200);

  for (const [path, opts] of [
    ['/local/model/test', { method: 'POST', token, body: {} }],
    ['/admin/api/model/test', { method: 'POST', cookie: adminCookie, headers: { 'x-rokbot-csrf': '1' }, body: {} }],
  ]) {
    const res = await call(path, opts);
    assert.equal(res.status, 502);
    const bodyText = await res.text();
    assert.equal(bodyText.includes('jv-99'), false, `${path} leaked jevApiKey`);
    assert.equal(bodyText.includes('sk-777'), false, `${path} leaked apiKey`);
    assert.match(bodyText, /\[redacted\]/);
  }

  const catalogErrRes = await call('/local/model/catalog', {
    method: 'POST',
    token,
    body: {},
  });
  assert.equal(catalogErrRes.status, 502);
  const catalogErrText = await catalogErrRes.text();
  assert.equal(catalogErrText.includes('jv-99'), false);
  assert.equal(catalogErrText.includes('sk-777'), false);

  // 2. model-reload-request.json missing revision ({} / {"requestedAt":...} / {"revision":""})
  // paired with missing or corrupt model-reload-status.json must return 200 (never 500 TypeError)
  const reqVariants = ['{}', '{"requestedAt":"2026-11-19T21:00:00Z"}', '{"revision":""}'];
  const statusVariants = [null, '{broken', 'null', '[]', '123', '"str"'];
  const statusPath = join(dir, 'model-reload-status.json');
  const requestPath = join(dir, 'model-reload-request.json');

  for (const reqRaw of reqVariants) {
    await writeFile(requestPath, reqRaw);
    for (const statusRaw of statusVariants) {
      if (statusRaw === null) await rm(statusPath, { force: true });
      else await writeFile(statusPath, statusRaw);

      for (const [path, opts] of [
        ['/local/status', { token }],
        ['/local/model', { token }],
        ['/admin/api/status', { cookie: adminCookie }],
        ['/admin/api/model', { cookie: adminCookie }],
      ]) {
        const res = await call(path, opts);
        assert.equal(res.status, 200, `Expected 200 for ${path} with req=${reqRaw} status=${statusRaw}`);
      }
      const localModel = await (await call('/local/model', { token })).json();
      assert.equal(localModel.reload.status, 'none');
    }
  }
});

test('v1 adaptiveRouting and hasJevApiKey round-trip across /admin/api/model and /local/model without leaking jevApiKey', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { dir, host, call } = await startHostFixture(t);
  const adminToken = await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const adminCookie = `rokbot_admin=${adminToken}`;
  const adminHeaders = { 'x-rokbot-csrf': '1' };
  const { token } = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'MacBook',
    platform: 'desktop',
  });

  const payload = (adaptiveRouting) => ({
    version: 1,
    providers: [
      { id: 'primary', name: 'Primary', apiFormat: 'openai', baseUrl: 'https://primary.example/v1', apiKey: 'sk-primary-secret-1' },
      { id: 'deep', name: 'Deep', apiFormat: 'anthropic', baseUrl: 'https://deep.example', apiKey: 'sk-deep-secret-2' },
    ],
    profiles: [
      { id: 'fast', name: 'Fast', providerId: 'primary', model: 'gpt-fast', efforts: ['none', 'low'] },
      { id: 'expert', name: 'Expert', providerId: 'deep', model: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high'] },
    ],
    defaultRoute: { profileId: 'fast', effort: 'low', fallbacks: [{ profileId: 'expert', effort: 'high' }] },
    botRoutes: {},
    adaptiveRouting,
  });

  // 1. Enabling adaptiveRouting without jevApiKey is rejected (400)
  const missingKeyRes = await call('/admin/api/model', {
    method: 'PUT',
    cookie: adminCookie,
    headers: adminHeaders,
    body: payload({
      enabled: true,
      classifierModel: 'jev-latest',
      tiers: {
        simple: { profileId: 'fast', effort: 'low' },
        medium: { profileId: 'fast', effort: 'default' },
        complex: { profileId: 'expert', effort: 'auto' },
      },
    }),
  });
  assert.equal(missingKeyRes.status, 400);

  // 2. Saving with jevApiKey via /admin/api/model returns hasJevApiKey: true and redacts secrets
  const saveAdmin = await call('/admin/api/model', {
    method: 'PUT',
    cookie: adminCookie,
    headers: adminHeaders,
    body: {
      ...payload({
        enabled: true,
        classifierModel: 'jev-v2',
        tiers: {
          simple: { profileId: 'fast', effort: 'low' },
          medium: { profileId: 'fast', effort: 'default' },
          complex: { profileId: 'expert', effort: 'auto' },
        },
      }),
      jevApiKey: 'jev-super-secret-888',
    },
  });
  assert.equal(saveAdmin.status, 200);
  const saveAdminText = await saveAdmin.text();
  assert.equal(saveAdminText.includes('jev-super-secret-888'), false);
  const saveAdminJson = JSON.parse(saveAdminText);
  assert.equal(saveAdminJson.hasJevApiKey, true);
  assert.equal(saveAdminJson.adaptiveRouting.enabled, true);
  assert.equal(saveAdminJson.adaptiveRouting.classifierModel, 'jev-v2');
  assert.deepEqual(saveAdminJson.adaptiveRouting.tiers.complex, { profileId: 'expert', effort: 'auto' });

  // 3. GET /local/model exposes adaptiveRouting and hasJevApiKey without jevApiKey
  const getLocal = await call('/local/model', { token });
  assert.equal(getLocal.status, 200);
  const getLocalText = await getLocal.text();
  assert.equal(getLocalText.includes('jev-super-secret-888'), false);
  const getLocalJson = JSON.parse(getLocalText);
  assert.equal(getLocalJson.hasJevApiKey, true);
  assert.equal(getLocalJson.config.adaptiveRouting.enabled, true);
  assert.equal(getLocalJson.config.adaptiveRouting.tiers.complex.profileId, 'expert');

  // 4. PUT /local/model omitting jevApiKey preserves stored JEV_API_KEY and updates tiers
  const putLocal = await call('/local/model', {
    method: 'PUT',
    token,
    body: {
      ...payload({
        enabled: true,
        classifierModel: 'jev-latest',
        tiers: {
          simple: { profileId: 'fast', effort: 'none' },
          medium: { profileId: 'expert', effort: 'medium' },
          complex: { profileId: 'expert', effort: 'auto' },
        },
      }),
      providers: payload().providers.map(({ apiKey, ...rest }) => rest),
    },
  });
  assert.equal(putLocal.status, 200);
  const putLocalJson = await putLocal.json();
  assert.equal(putLocalJson.hasJevApiKey, true);
  assert.equal(putLocalJson.config.adaptiveRouting.tiers.medium.profileId, 'expert');
  assert.equal((await host.models.current()).jevApiKey, 'jev-super-secret-888');
  assert.match(await readFile(join(dir, 'model.env'), 'utf8'), /JEV_API_KEY=jev-super-secret-888/);

  // 5. Explicit clearJevApiKey with adaptiveRouting disabled clears JEV_API_KEY
  const clearAdmin = await call('/admin/api/model', {
    method: 'PUT',
    cookie: adminCookie,
    headers: adminHeaders,
    body: {
      ...payload({
        enabled: false,
        classifierModel: 'jev-latest',
        tiers: {
          simple: { profileId: 'fast', effort: 'none' },
          medium: { profileId: 'expert', effort: 'medium' },
          complex: { profileId: 'expert', effort: 'auto' },
        },
      }),
      providers: payload().providers.map(({ apiKey, ...rest }) => rest),
      clearJevApiKey: true,
    },
  });
  assert.equal(clearAdmin.status, 200);
  const clearJson = await clearAdmin.json();
  assert.equal(clearJson.hasJevApiKey, false);
  assert.equal(clearJson.adaptiveRouting.enabled, false);
  assert.equal((await host.models.current()).jevApiKey, '');

  // 6. POST /admin/api/model/classify works with v1 adaptiveRouting config and redacts secrets
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });
  globalThis.fetch = async (url, opts) => {
    if (String(url) === 'https://api.typesafe.ai/v1/systemone') {
      assert.equal(opts.headers.authorization, 'Bearer jev-classify-secret-777');
      return new Response(JSON.stringify({
        model: 'jev-latest',
        answers: { difficulty: { choice: 'expert', confidence: 0.94 }, effort_0: { choice: 'high' } },
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return origFetch(url, opts);
  };
  const classifyRes = await call('/admin/api/model/classify', {
    method: 'POST',
    cookie: adminCookie,
    headers: adminHeaders,
    body: {
      ...payload({
        enabled: true,
        classifierModel: 'jev-latest',
        tiers: {
          simple: { profileId: 'fast', effort: 'low' },
          medium: { profileId: 'fast', effort: 'default' },
          complex: { profileId: 'expert', effort: 'auto' },
        },
      }),
      jevApiKey: 'jev-classify-secret-777',
      task: 'Design a distributed consensus engine',
    },
  });
  assert.equal(classifyRes.status, 200);
  const classifyText = await classifyRes.text();
  assert.equal(classifyText.includes('jev-classify-secret-777'), false);
  assert.equal(classifyText.includes('sk-deep-secret-2'), false);
  const classifyJson = JSON.parse(classifyText);
  assert.equal(classifyJson.difficulty, 'expert');
  assert.equal(classifyJson.tier, 'complex');
  assert.equal(classifyJson.profileId, 'expert');
  assert.equal(classifyJson.model, 'claude-sonnet-4-6');
  assert.equal(classifyJson.effort, 'high');
});

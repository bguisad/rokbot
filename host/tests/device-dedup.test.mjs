import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Auth, handleConnectPair } from '../server/auth.mjs';
import { PushService } from '../server/push-service.mjs';
import { bearer, HttpError, jsonBody, RateLimit, sendJson } from '../server/security.mjs';

function memory(store) {
  store.value = structuredClone(store.initial);
  store.mutate = async update => update(store.value);
}

test('Auth.pair reuses deviceId, rotates token, preserves push/displayName, and bypasses 100-device cap on same clientDeviceId', async () => {
  const auth = new Auth('.');
  memory(auth.store);
  const push = new PushService('.', auth);
  memory(push.store);
  memory(push.config.store);
  auth.setupKey = 'setup-secret';
  await auth.setup('setup-secret', 'Pass123456');

  const cid = 'android-11223344556677889900aabbccddeeff';
  const first = await auth.pair({
    password: 'Pass123456',
    deviceName: 'OPPO Find X9',
    platform: 'desktop',
    clientKind: 'android',
    clientDeviceId: cid,
    bundleId: 'ai.x.grok.bot.local',
  });
  assert.ok(first.deviceId);
  assert.equal(first.reused, false);
  await push.rename(first.deviceId, 'My Custom Find X9');
  await push.register(first.deviceId, {
    kind: 'desktop',
    clientKind: 'android',
    clientDeviceId: cid,
    bundleId: 'ai.x.grok.bot.local',
    appVersion: '1.16.0',
    authorization: 'granted',
    push: { provider: 'ntfy', ntfyUrl: 'https://ntfy.example/sub/topic1' },
  });

  // Fill remaining 99 active slots with distinct devices so we hit 100 active devices total
  for (let i = 0; i < 99; i++) {
    await auth.pair({
      password: 'Pass123456',
      deviceName: `Other-${i}`,
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: `android-other-${i}`,
    });
  }
  assert.equal(auth.devices().filter(d => !d.revokedAt).length, 100);

  // Re-pair with same clientDeviceId via pairing code (must reuse despite 100 active limit)
  const { pairingKey } = await auth.createPairing();
  const second = await auth.pair({
    pairingKey,
    deviceName: 'OPPO Find X9 Pro',
    platform: 'desktop',
    clientKind: 'android',
    clientDeviceId: cid,
    bundleId: 'ai.x.grok.bot.local',
  });
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(second.reused, true);
  assert.notEqual(second.token, first.token);
  assert.equal(auth.authenticate(first.token), null, 'old token must be invalidated after rotation');
  assert.equal(auth.authenticate(second.token).id, first.deviceId);
  assert.equal(auth.devices().filter(d => !d.revokedAt).length, 100);

  const publicDev = push.get(first.deviceId);
  assert.equal(publicDev.name, 'My Custom Find X9', 'custom displayName must be preserved');
  assert.equal(publicDev.push.provider, 'ntfy', 'push config must be preserved across re-pair');
  assert.equal(publicDev.clientDeviceId, cid);
});

test('Distinct clientDeviceIds (e.g. coexist vs stock package) remain separate active devices', async () => {
  const auth = new Auth('.');
  memory(auth.store);
  auth.setupKey = 'setup-secret';
  await auth.setup('setup-secret', 'Pass123456');

  const stock = await auth.pair({
    password: 'Pass123456',
    deviceName: 'OPPO Find X9',
    platform: 'desktop',
    clientKind: 'android',
    clientDeviceId: 'android-stock-hash',
    bundleId: 'ai.x.grok.bot',
  });
  const coexist = await auth.pair({
    password: 'Pass123456',
    deviceName: 'OPPO Find X9',
    platform: 'desktop',
    clientKind: 'android',
    clientDeviceId: 'android-coexist-hash',
    bundleId: 'ai.x.grok.bot.local',
  });
  assert.notEqual(stock.deviceId, coexist.deviceId);
  assert.equal(auth.devices().filter(d => !d.revokedAt).length, 2);
});

test('Legacy devices (no clientDeviceId) match by (platform, bundleId, name), while generic devices remain separate', async () => {
  const auth = new Auth('.');
  memory(auth.store);
  const push = new PushService('.', auth);
  memory(push.store);
  memory(push.config.store);
  auth.setupKey = 'setup-secret';
  await auth.setup('setup-secret', 'Pass123456');

  // Legacy pair + register with bundleId
  const legacy1 = await auth.pair({
    password: 'Pass123456',
    deviceName: 'OPPO Find X9',
    platform: 'desktop',
    clientKind: 'android',
  });
  await push.register(legacy1.deviceId, {
    kind: 'desktop',
    clientKind: 'android',
    bundleId: 'ai.x.grok.bot.local',
  });

  // Generic device with neither clientDeviceId nor bundleId must not be collapsed
  const generic1 = await auth.pair({ password: 'Pass123456', deviceName: 'Demo', platform: 'desktop', clientKind: 'android' });
  const generic2 = await auth.pair({ password: 'Pass123456', deviceName: 'Demo', platform: 'desktop', clientKind: 'android' });
  assert.notEqual(generic1.deviceId, generic2.deviceId);

  // Pairing with new clientDeviceId + matching bundleId & name adopts legacy1 and keeps generics intact
  const upgraded = await auth.pair(
    {
      password: 'Pass123456',
      deviceName: 'OPPO Find X9',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'android-oppo-adopted',
      bundleId: 'ai.x.grok.bot.local',
    },
    { legacyBundleIdFor: id => push.bundleIdOf(id) },
  );
  assert.equal(upgraded.deviceId, legacy1.deviceId);
  assert.equal(upgraded.reused, true);
  assert.equal(auth.authenticate(legacy1.token), null);
  assert.equal(auth.devices().filter(d => !d.revokedAt).length, 3);
});

test('PUT /local/device bindClientIdentity & deduplicateDevices clean up historical duplicates', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-dedup-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const auth = await new Auth(dataDir).load();
  await auth.setup(auth.setupKey, 'Pass123456');
  const push = await new PushService(dataDir, auth).load();
  t.after(() => { push.closed = true; clearTimeout(push.timer); });

  const old1 = await auth.pair({ password: 'Pass123456', deviceName: 'OPPO Find X9', platform: 'desktop', clientKind: 'android' });
  await push.register(old1.deviceId, { kind: 'desktop', clientKind: 'android', bundleId: 'dev.grokbot.local' });
  const old2 = await auth.pair({ password: 'Pass123456', deviceName: 'OPPO Find X9', platform: 'desktop', clientKind: 'android' });
  await push.store.mutate(state => {
    state.devices[old2.deviceId] = { bundleId: 'dev.grokbot.local', provider: 'none', enabled: true };
  });

  // Explicit deduplicateDevices removes duplicate active legacy entry and leaves 1
  const res = await push.deduplicateDevices({
    revokeDevice: async id => {
      await auth.revoke(id);
      await push.revoke(id);
    },
  });
  assert.equal(res.removed, 1);
  assert.equal(auth.devices().filter(d => !d.revokedAt).length, 1);
});

test('HTTP routes integration: /connect/pair, /connect/status, PUT /local/device, POST /admin/api/devices/deduplicate, and web pair', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-dedup-srv-'));
  const auth = new Auth(dir);
  await auth.load();
  const push = new PushService(dir, auth);
  await push.load();
  const limiter = new RateLimit();
  const adminToken = await auth.setup(auth.setupKey, 'Pass123456');
  const supersededIds = [];
  const revokeDevice = async id => {
    await auth.revoke(id);
    await push.revoke(id);
  };
  const server = http.createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const reqPath = new URL(request.url ?? '/', origin).pathname;
      if (request.method === 'POST' && reqPath === '/connect/pair') {
        return await handleConnectPair({
          request,
          response,
          origin,
          auth,
          federation: { role: () => 'primary' },
          limiter,
          legacyBundleIdFor: id => push.bundleIdOf(id),
          onPaired: async result => {
            for (const dupId of result.revokedDuplicateIds ?? []) await push.revoke(dupId);
          },
        });
      }
      if (request.method === 'GET' && reqPath === '/connect/status') {
        const device = auth.authenticate(bearer(request));
        if (!device) throw new HttpError(401, 'Unauthorized');
        return sendJson(response, 200, {
          deviceId: device.id,
          deviceName: device.name,
          platform: device.platform,
          connected: true,
        });
      }
      if (request.method === 'PUT' && reqPath === '/local/device') {
        const device = auth.authenticate(bearer(request));
        if (!device) throw new HttpError(401, 'Unauthorized');
        const saved = await push.register(device.id, await jsonBody(request), {
          onSuperseded: ids => {
            supersededIds.push(...ids);
          },
        });
        return sendJson(response, 200, saved);
      }
      if (request.method === 'POST' && reqPath === '/admin/api/devices/deduplicate') {
        if (request.headers['x-admin-token'] !== adminToken) throw new HttpError(401, 'Unauthorized');
        return sendJson(response, 200, { ok: true, ...(await push.deduplicateDevices({ revokeDevice })) });
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const cid = 'android-live-host-test-123456';

  // Pair twice with same clientDeviceId -> single active device, old token 401
  const p1 = await fetch(`${origin}/connect/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      password: 'Pass123456',
      deviceName: 'OPPO Find X9',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: cid,
      bundleId: 'ai.x.grok.bot.local',
    }),
  }).then(r => r.json());
  assert.ok(p1.deviceId && p1.token);
  assert.equal(p1.reused, undefined);
  assert.equal(p1.revokedDuplicateIds, undefined);

  const p2 = await fetch(`${origin}/connect/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      password: 'Pass123456',
      deviceName: 'OPPO Find X9',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: cid,
      bundleId: 'ai.x.grok.bot.local',
    }),
  }).then(r => r.json());
  assert.equal(p2.deviceId, p1.deviceId);
  assert.notEqual(p2.token, p1.token);
  assert.equal(
    (await fetch(`${origin}/connect/status`, { headers: { authorization: `Bearer ${p1.token}` } })).status,
    401,
  );
  assert.equal(
    (await fetch(`${origin}/connect/status`, { headers: { authorization: `Bearer ${p2.token}` } })).status,
    200,
  );
  assert.equal(auth.devices().filter(d => !d.revokedAt).length, 1);

  // Create a legacy duplicate without clientDeviceId -> PUT /local/device binds & supersedes it
  const dLegacySame = await auth.pair({
    password: 'Pass123456',
    deviceName: 'OPPO Find X9',
    platform: 'desktop',
    clientKind: 'android',
  });
  await push.register(dLegacySame.deviceId, {
    kind: 'desktop',
    clientKind: 'android',
    bundleId: 'ai.x.grok.bot.local',
    provider: 'none',
    enabled: false,
  });
  assert.equal(auth.devices().filter(d => !d.revokedAt).length, 2);

  // Register p2 via PUT /local/device -> supersedes legacy matching (desktop, ai.x.grok.bot.local, OPPO Find X9)
  const syncRes = await fetch(`${origin}/local/device`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p2.token}` },
    body: JSON.stringify({
      kind: 'desktop',
      clientKind: 'android',
      clientDeviceId: cid,
      bundleId: 'ai.x.grok.bot.local',
      provider: 'ntfy',
      enabled: true,
    }),
  });
  assert.equal(syncRes.status, 200);
  const synced = await syncRes.json();
  assert.equal(synced.clientDeviceId, cid);
  assert.equal(synced.bundleId, 'ai.x.grok.bot.local');
  assert.deepEqual(supersededIds, [dLegacySame.deviceId]);
  assert.equal(auth.devices().filter(d => !d.revokedAt).length, 1);

  // Two legacy duplicate devices without clientDeviceId -> POST /admin/api/devices/deduplicate removes 1
  const dA = await auth.pair({ password: 'Pass123456', deviceName: 'Legacy Phone', platform: 'desktop', clientKind: 'android' });
  const dB = await auth.pair({ password: 'Pass123456', deviceName: 'Legacy Phone', platform: 'desktop', clientKind: 'android' });
  await push.store.mutate(state => {
    state.devices[dA.deviceId] = { bundleId: 'dev.grokbot.local', provider: 'none', enabled: true };
    state.devices[dB.deviceId] = { bundleId: 'dev.grokbot.local', provider: 'none', enabled: true };
  });

  const dedupRes = await fetch(`${origin}/admin/api/devices/deduplicate`, {
    method: 'POST',
    headers: { 'x-admin-token': adminToken, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(dedupRes.status, 200);
  const dedupJson = await dedupRes.json();
  assert.equal(dedupJson.removed, 1);
  assert.equal(auth.devices().filter(d => !d.revokedAt).length, 2);

  // Web pair with same clientDeviceId reuses browser device
  const k1 = (await auth.createPairing()).pairingKey;
  const k2 = (await auth.createPairing()).pairingKey;
  const w1 = await auth.pair({ pairingKey: k1, deviceName: 'Chrome', clientDeviceId: 'web-browser-1' }, { web: true });
  const w2 = await auth.pair({ pairingKey: k2, deviceName: 'Chrome', clientDeviceId: 'web-browser-1' }, { web: true });
  assert.equal(w2.deviceId, w1.deviceId);
  assert.equal(auth.devices().filter(d => !d.revokedAt && d.platform === 'web').length, 1);
});

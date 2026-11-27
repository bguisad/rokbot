import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));

test('self-host server: POST /local/device/revoke revokes only the caller device', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-self-revoke-'));
  const core = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('null');
  });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const host = await createSelfHostServer({
    dataDir: dir,
    hostUrl: coreUrl,
    vncUrl: coreUrl,
    forkVncUrl: coreUrl,
    internalToken: 'r'.repeat(40),
  });
  await host.start(0, '127.0.0.1');
  t.after(async () => {
    await host.close();
    await new Promise(resolve => core.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const adminToken = await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const deviceA = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'iPhone A',
    platform: 'ios',
    clientDeviceId: 'ios-device-a',
  });
  const deviceB = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'iPhone B',
    platform: 'ios',
    clientDeviceId: 'ios-device-b',
  });

  // Unauthenticated and invalid bearer tokens are rejected.
  assert.equal((await fetch(`${origin}/local/device/revoke`, { method: 'POST' })).status, 401);
  assert.equal(
    (await fetch(`${origin}/local/device/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer invalid-token' },
    })).status,
    401,
  );
  // Non-POST methods are rejected for authenticated callers.
  assert.equal(
    (await fetch(`${origin}/local/device/revoke`, {
      method: 'GET',
      headers: { authorization: `Bearer ${deviceA.token}` },
    })).status,
    405,
  );

  // Register push info on deviceA so we can verify push state is cleared on revoke.
  const putPush = await fetch(`${origin}/local/device`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${deviceA.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'iPhone A',
      kind: 'iphone',
      bundleId: 'dev.rokbot.local',
      clientDeviceId: 'ios-device-a',
      apnsCapable: false,
      authorization: 'notDetermined',
    }),
  });
  assert.equal(putPush.status, 200);

  // Even if caller passes another device's id in the body, only caller (deviceA) is revoked.
  const revokeRes = await fetch(`${origin}/local/device/revoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deviceA.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ deviceId: deviceB.deviceId }),
  });
  assert.equal(revokeRes.status, 200);
  const revokeBody = await revokeRes.json();
  assert.deepEqual(revokeBody, { ok: true, deviceId: deviceA.deviceId });

  // deviceA token is immediately invalidated everywhere.
  assert.equal(
    (await fetch(`${origin}/connect/status`, {
      headers: { authorization: `Bearer ${deviceA.token}` },
    })).status,
    401,
  );
  assert.equal(
    (await fetch(`${origin}/local/device/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceA.token}` },
    })).status,
    401,
  );

  // deviceB remains active and usable.
  const statusB = await fetch(`${origin}/connect/status`, {
    headers: { authorization: `Bearer ${deviceB.token}` },
  });
  assert.equal(statusB.status, 200);
  const statusBJson = await statusB.json();
  assert.equal(statusBJson.connected, true);
  assert.equal(statusBJson.deviceId, deviceB.deviceId);

  // Admin API confirms deviceA has revokedAt set while deviceB does not.
  const statusRes = await fetch(`${origin}/admin/api/status`, {
    headers: { cookie: `rokbot_admin=${adminToken}` },
  });
  assert.equal(statusRes.status, 200);
  const { devices } = await statusRes.json();
  const recordA = devices.find(d => d.id === deviceA.deviceId);
  const recordB = devices.find(d => d.id === deviceB.deviceId);
  assert.ok(recordA?.revokedAt, 'deviceA should have revokedAt set');
  assert.equal(recordB?.revokedAt, null, 'deviceB should remain active');
  assert.equal(recordA.push?.enabled, false, 'deviceA push should be disabled after revoke');
});

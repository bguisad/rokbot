import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The 1.26 mobile app reads these before it shows the Auto-review switch and locks it ("Couldn't
// check your team settings" + Retry) when both fail. A paired device gets `{}`: no team, no
// cloud-agent settings (desktop and web answer the same locally, iOS on the device).
const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));
const RPCS = [
  '/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
  '/aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings',
];

test('self-host server: the mobile Auto-review preference reads need a paired device and answer {}', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-preference-rpc-'));
  const coreCalls = [];
  const core = http.createServer((req, res) => { coreCalls.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl, internalToken: 'c'.repeat(40) });
  await host.start(0, '127.0.0.1');
  t.after(async () => {
    await host.close();
    await new Promise(resolve => core.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const { token } = await host.auth.pair({ password: 'AdminPass123', deviceName: 'Phone', platform: 'desktop', clientKind: 'android' });
  const json = { 'content-type': 'application/json', 'connect-protocol-version': '1' };

  for (const rpc of RPCS) {
    assert.equal((await fetch(`${origin}${rpc}`, { method: 'POST', headers: json, body: '{}' })).status, 401, `${rpc} without a token`);
    assert.equal((await fetch(`${origin}${rpc}`, { method: 'POST', headers: { ...json, authorization: 'Bearer nope' }, body: '{}' })).status, 401);
    const auth = { ...json, authorization: `Bearer ${token}` };
    for (const body of ['{}', '']) {
      const response = await fetch(`${origin}${rpc}`, { method: 'POST', headers: auth, body });
      assert.equal(response.status, 200, `${rpc} body=${JSON.stringify(body)}`);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await response.json(), {});
    }
    assert.equal((await fetch(`${origin}${rpc}`, { headers: { authorization: `Bearer ${token}` } })).status, 405);
  }
  // Other aiserver paths are still unknown, and nothing reached the original Host.
  assert.equal((await fetch(`${origin}/aiserver.v1.DashboardService/GetTeamAdminSettings`, { method: 'POST',
    headers: { ...json, authorization: `Bearer ${token}` }, body: '{}' })).status, 404);
  assert.deepEqual(coreCalls.filter(url => url.startsWith('/aiserver')), []);
});

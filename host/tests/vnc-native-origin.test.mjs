import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NATIVE_APP_VNC_PLATFORMS, vncUpgradeRejectionLog } from '../server/vnc.mjs';

const dependencies = existsSync(new URL('../server/node_modules/ws', import.meta.url));

/** Sends a raw WebSocket upgrade and returns the status line's code. */
function upgrade(port, path, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        (origin === undefined ? '' : `Origin: ${origin}\r\n`) + '\r\n');
    });
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      const line = data.split('\r\n')[0];
      if (/^HTTP\/1\.1 \d{3}/.test(line)) { socket.destroy(); resolve(Number(line.split(' ')[1])); }
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('upgrade timed out')); });
  });
}

test('the rejection log line names status, reason, path and origin but never the ticket', () => {
  const line = vncUpgradeRejectionLog(
    { url: '/vnc/desktop/websockify?ticket=supersecret', headers: { origin: 'null' } },
    Object.assign(new Error('桌面请求来源不匹配'), { status: 403 }));
  assert.equal(line, '[selfhost] websocket upgrade rejected: 403 桌面请求来源不匹配 path=/vnc/desktop/websockify origin=null');
  assert.doesNotMatch(line, /supersecret/);
  assert.match(vncUpgradeRejectionLog({ url: '/x\r\ninjected', headers: {} }, new TypeError('boom')),
    /^\[selfhost\] websocket upgrade rejected: 500 TypeError path=\/x\?\?injected origin=-$/);
  assert.deepEqual([...NATIVE_APP_VNC_PLATFORMS].sort(), ['android', 'ios']);
});

test('the Android Bot-computer screen (inline noVNC, Origin: null) reaches the desktop socket with its ticket',
  { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-vnc-origin-'));
  const core = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); });
  const upstreamPaths = [];
  core.on('upgrade', (request, socket) => {
    upstreamPaths.push(request.url);
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
  });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl, internalToken: 'v'.repeat(40) });
  await host.start(0, '127.0.0.1');
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(async () => {
    console.warn = warn;
    await host.close();
    await new Promise(resolve => core.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const port = host.server.address().port;
  await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const pair = (deviceName, platform, clientKind) =>
    host.auth.pair({ password: 'AdminPass123', deviceName, platform, clientKind });
  const android = await pair('OPPO Find X9', 'desktop', 'android');
  const ios = await pair('iPhone', 'ios');
  const desktop = await pair('Mac', 'desktop');
  assert.equal(host.auth.device(android.deviceId).platform, 'android');
  const socketPath = device => `/vnc/desktop/websockify?ticket=${host.tickets.issue(device.deviceId, 'desktop')}`;

  // The official Android screen: noVNC inline in a WebView without baseUrl, so the socket's origin is "null".
  assert.equal(await upgrade(port, socketPath(android), 'null'), 101);
  assert.equal(await upgrade(port, socketPath(ios), 'null'), 101);
  // ComputerViewerActivity's loopback proxy sends the Host's own origin; that keeps working.
  assert.equal(await upgrade(port, socketPath(android), `http://127.0.0.1:${port}`), 101);
  assert.equal(upstreamPaths.length, 3);
  assert.ok(upstreamPaths.every(path => path === '/websockify'), 'the ticket never reaches the box');

  // A desktop app's ticket still needs a matching origin, a forged origin still fails, and so does a cookie-only ticket.
  assert.equal(await upgrade(port, socketPath(desktop), 'null'), 403);
  assert.equal(await upgrade(port, socketPath(android), 'https://evil.example'), 403);
  assert.equal(await upgrade(port, '/vnc/desktop/websockify?ticket=bogus', 'null'), 401);
  const rejected = warnings.filter(line => line.startsWith('[selfhost] websocket upgrade rejected:'));
  assert.equal(rejected.length, 3);
  assert.match(rejected[0], /^\[selfhost\] websocket upgrade rejected: 403 \S+ path=\/vnc\/desktop\/websockify origin=null$/);
  assert.match(rejected[2], / 401 /);
  assert.ok(rejected.every(line => !/ticket=/.test(line)), 'tickets stay out of the log');
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RateLimit } from '../server/security.mjs';
import { SPEEDTEST_LIMITS, SPEEDTEST_MAX_BYTES, createSpeedTest, parseSpeedTestBytes } from '../server/speedtest.mjs';

const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));

/** A bare server around createSpeedTest; every request is device "dev-1" unless x-device says otherwise. */
async function startSpeedServer(t, options = {}) {
  const speed = createSpeedTest({ limiter: new RateLimit(), ...options });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://local');
    speed.handle(request, response, url.pathname, url, request.headers['x-device'] ?? 'dev-1')
      .then(handled => { if (!handled) { response.writeHead(404); response.end(); } })
      .catch(error => {
        if (response.headersSent) return response.destroy();
        response.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  return { speed, origin: `http://127.0.0.1:${server.address().port}` };
}

/** Raw request so a test can send a chunked body or stop reading a response. */
function rawRequest(origin, { method = 'GET', path, headers = {}, body = null, chunks = null }) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${path}`, { method, headers }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    if (chunks) {
      for (const chunk of chunks) request.write(chunk);
      request.end();
    } else request.end(body ?? undefined);
  });
}

test('parseSpeedTestBytes: default, bounds and junk', () => {
  assert.equal(parseSpeedTestBytes(null), 4 * 1024 * 1024);
  assert.equal(parseSpeedTestBytes(''), 4 * 1024 * 1024);
  assert.equal(parseSpeedTestBytes('1'), 1);
  assert.equal(parseSpeedTestBytes(String(SPEEDTEST_MAX_BYTES)), SPEEDTEST_MAX_BYTES);
  for (const bad of ['0', '-5', '1.5', 'abc', '1e6', ' 12', String(SPEEDTEST_MAX_BYTES + 1), '99999999999']) {
    assert.throws(() => parseSpeedTestBytes(bad), error => error.status === 400, bad);
  }
  assert.equal(parseSpeedTestBytes(null, 1000), 1000, 'the default never exceeds the cap');
});

test('download sends exactly N incompressible, uncached bytes', async t => {
  const { origin } = await startSpeedServer(t);
  const response = await fetch(`${origin}/local/speedtest/download?bytes=200000`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-length'), '200000');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-rokbot-speedtest-bytes'), '200000');
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, 200000);
  // Random payload: no single byte value dominates (a zero-filled buffer would compress away).
  const counts = new Array(256).fill(0);
  for (const byte of body.subarray(0, 65536)) counts[byte]++;
  assert.ok(Math.max(...counts) < 65536 / 64, 'payload looks random');
  for (const bad of ['0', 'abc', String(SPEEDTEST_MAX_BYTES + 1)]) {
    assert.equal((await fetch(`${origin}/local/speedtest/download?bytes=${bad}`)).status, 400, bad);
  }
  assert.equal((await fetch(`${origin}/local/speedtest/download`, { method: 'POST' })).status, 405);
});

test('upload counts the body and enforces the size cap (declared and chunked)', async t => {
  const { origin, speed } = await startSpeedServer(t, { maxBytes: 64 * 1024 });
  const ok = await fetch(`${origin}/local/speedtest/upload`, { method: 'POST', body: Buffer.alloc(50_000, 7) });
  assert.equal(ok.status, 200);
  const info = await ok.json();
  assert.equal(info.bytes, 50_000);
  assert.ok(Number.isFinite(info.ms) && info.ms >= 0);

  const declared = await rawRequest(origin, { method: 'POST', path: '/local/speedtest/upload',
    headers: { 'content-length': String(64 * 1024 + 1) }, body: Buffer.alloc(64 * 1024 + 1) });
  assert.equal(declared.status, 413);

  const chunked = await rawRequest(origin, { method: 'POST', path: '/local/speedtest/upload',
    headers: { 'transfer-encoding': 'chunked' }, chunks: Array.from({ length: 4 }, () => Buffer.alloc(32 * 1024, 1)) }).catch(error => ({ error }));
  if (!chunked.error) assert.equal(chunked.status, 413);
  else assert.match(String(chunked.error.code), /ECONNRESET|EPIPE/, 'the oversized upload is cut off');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(speed.activeCount(), 0, 'slots are released');
  assert.equal((await fetch(`${origin}/local/speedtest/upload`)).status, 405);
});

test('ping answers JSON; per-device rate limits return 429', async t => {
  const limits = { ...SPEEDTEST_LIMITS, pingsPerMinute: 3, transfersPerMinute: 2 };
  const { origin } = await startSpeedServer(t, { limits });
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${origin}/local/speedtest/ping`);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.ok, true);
    assert.ok(Number.isFinite(value.at));
  }
  assert.equal((await fetch(`${origin}/local/speedtest/ping`)).status, 429);
  assert.equal((await fetch(`${origin}/local/speedtest/download?bytes=10`)).status, 200);
  assert.equal((await fetch(`${origin}/local/speedtest/upload`, { method: 'POST', body: 'x' })).status, 200);
  assert.equal((await fetch(`${origin}/local/speedtest/download?bytes=10`)).status, 429);
  // Another device has its own budget.
  assert.equal((await fetch(`${origin}/local/speedtest/download?bytes=10`, { headers: { 'x-device': 'dev-2' } })).status, 200);
});

test('concurrent transfers are capped per device and freed when the client goes away', async t => {
  const limits = { ...SPEEDTEST_LIMITS, activePerDevice: 1, activeTotal: 2 };
  const { origin, speed } = await startSpeedServer(t, { limits });
  const controller = new AbortController();
  const slow = await fetch(`${origin}/local/speedtest/download?bytes=${16 * 1024 * 1024}`, { signal: controller.signal });
  assert.equal(slow.status, 200);
  assert.equal(speed.activeCount(), 1);
  assert.equal((await fetch(`${origin}/local/speedtest/download?bytes=10`)).status, 429, 'second transfer of the same device');
  const other = await fetch(`${origin}/local/speedtest/download?bytes=10`, { headers: { 'x-device': 'dev-2' } });
  assert.equal(other.status, 200);
  await other.arrayBuffer();
  controller.abort();
  await slow.arrayBuffer().catch(() => {});
  for (let i = 0; i < 50 && speed.activeCount() > 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(speed.activeCount(), 0, 'cancelled download frees its slot');
  assert.equal((await fetch(`${origin}/local/speedtest/download?bytes=10`)).status, 200);
});

test('a stalled transfer is cut at the time cap', async t => {
  const limits = { ...SPEEDTEST_LIMITS, transferTimeoutMs: 150 };
  const { origin, speed } = await startSpeedServer(t, { limits });
  const result = await new Promise(resolve => {
    const request = http.request(`${origin}/local/speedtest/upload`, { method: 'POST', headers: { 'content-length': '1000' } }, response => {
      response.resume();
      response.on('end', () => resolve('answered'));
    });
    request.on('error', () => resolve('cut'));
    request.write(Buffer.alloc(10)); // never finishes the body
  });
  assert.ok(['cut', 'answered'].includes(result));
  for (let i = 0; i < 50 && speed.activeCount() > 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(speed.activeCount(), 0);
});

test('self-host server: speed test routes need a paired device token', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-speedtest-'));
  const core = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('null'); });
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
  const { token } = await host.auth.pair({ password: 'AdminPass123', deviceName: 'Phone', platform: 'ios' });

  for (const [method, path] of [['GET', '/local/speedtest/ping'], ['GET', '/local/speedtest/download?bytes=10'], ['POST', '/local/speedtest/upload']]) {
    assert.equal((await fetch(`${origin}${path}`, { method })).status, 401, `${method} ${path} without a token`);
    assert.equal((await fetch(`${origin}${path}`, { method, headers: { authorization: 'Bearer nope' } })).status, 401);
  }
  const auth = { authorization: `Bearer ${token}` };
  const ping = await fetch(`${origin}/local/speedtest/ping`, { headers: auth });
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).ok, true);
  const down = await fetch(`${origin}/local/speedtest/download?bytes=4096`, { headers: auth });
  assert.equal(down.status, 200);
  assert.equal((await down.arrayBuffer()).byteLength, 4096);
  const up = await fetch(`${origin}/local/speedtest/upload`, { method: 'POST', headers: auth, body: Buffer.alloc(3000) });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).bytes, 3000);
  const big = await fetch(`${origin}/local/speedtest/download?bytes=${SPEEDTEST_MAX_BYTES + 1}`, { headers: auth });
  assert.equal(big.status, 400);
  assert.equal((await fetch(`${origin}/local/speedtest/nope`, { headers: auth })).status, 404);
});

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HttpError } from '../server/security.mjs';
import { handleUpdateProxy } from '../server/update-proxy.mjs';

function makeServer({ allowOrigin, updateDir, lookupImpl } = {}) {
  const tracked = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const handled = await handleUpdateProxy(req, res, url.pathname, url, {
        device: request => {
          if (request.headers.authorization !== 'Bearer valid-token') {
            throw new HttpError(401, 'Unauthorized');
          }
          return { id: 'dev-1', platform: 'android' };
        },
        connections: { track: id => tracked.push(id) },
        allowOrigin,
        updateDir,
        lookupImpl,
      });
      if (!handled) {
        res.writeHead(404).end('not found');
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.status ?? 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.destroy();
      }
    }
  });
  return { server, tracked };
}

test('Host /local/updates/fetch requires auth, blocks private/SSRF targets, and streams verified updates', async () => {
  const upstreamPayload = Buffer.from('upstream-binary-update-payload-0123456789');
  const upstream = http.createServer((req, res) => {
    if (req.url === '/updates/win32-x64.json') {
      const body = JSON.stringify({ version: '1.1.1' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (req.url === '/updates/app.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': upstreamPayload.length });
      return res.end(req.method === 'HEAD' ? undefined : upstreamPayload);
    }
    res.writeHead(404).end();
  });

  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;

  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-host-update-proxy-'));
  await mkdir(path.join(dir, 'deltas'), { recursive: true });
  await writeFile(path.join(dir, 'deltas', 'local-mirror.rbdelta'), 'mirror-rbdelta-bytes');
  await writeFile(path.join(dir, 'deltas', 'local-mirror.gbdelta'), 'mirror-delta-bytes');

  const { server: hostServer, tracked } = makeServer({
    allowOrigin: upstreamOrigin,
    updateDir: dir,
    lookupImpl: async host => {
      if (host === 'private.example') return [{ address: '10.0.0.5', family: 4 }];
      if (host === 'meta.example') return [{ address: '169.254.169.254', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });
  await new Promise(resolve => hostServer.listen(0, '127.0.0.1', resolve));
  const hostBase = `http://127.0.0.1:${hostServer.address().port}`;

  try {
    // 1. Unauthenticated device is rejected.
    const unauth = await fetch(`${hostBase}/local/updates/fetch?url=${encodeURIComponent(`${upstreamOrigin}/updates/win32-x64.json`)}`);
    assert.equal(unauth.status, 401);

    // 2. Non-configured HTTP and private SSRF hosts are rejected.
    const badProto = await fetch(`${hostBase}/local/updates/fetch?url=${encodeURIComponent('http://evil.example/a.apk')}`, {
      headers: { authorization: 'Bearer valid-token' },
    });
    assert.equal(badProto.status, 400);

    for (const ssrfUrl of [
      'https://127.0.0.1/secret',
      'https://169.254.169.254/latest/meta-data',
      'https://private.example/internal',
      'https://meta.example/meta',
    ]) {
      const blocked = await fetch(`${hostBase}/local/updates/fetch?url=${encodeURIComponent(ssrfUrl)}`, {
        headers: { authorization: 'Bearer valid-token' },
      });
      assert.equal(blocked.status, 403, ssrfUrl);
    }

    // 3. Configured update upstream streams manifest & binary cleanly over Host proxy.
    const feedRes = await fetch(`${hostBase}/local/updates/fetch?url=${encodeURIComponent(`${upstreamOrigin}/updates/win32-x64.json`)}`, {
      headers: { authorization: 'Bearer valid-token' },
    });
    assert.equal(feedRes.status, 200);
    assert.deepEqual(await feedRes.json(), { version: '1.1.1' });

    const binRes = await fetch(`${hostBase}/local/updates/fetch?url=${encodeURIComponent(`${upstreamOrigin}/updates/app.bin`)}`, {
      headers: { authorization: 'Bearer valid-token' },
    });
    assert.equal(binRes.status, 200);
    assert.equal(Number(binRes.headers.get('content-length')), upstreamPayload.length);
    assert.ok(Buffer.from(await binRes.arrayBuffer()).equals(upstreamPayload));

    // 4. Host local mirror directory serves matching .rbdelta and legacy .gbdelta files directly without upstream hit.
    const rbMirrorRes = await fetch(`${hostBase}/local/updates/fetch?url=${encodeURIComponent('https://public.example/updates/deltas/local-mirror.rbdelta')}`, {
      headers: { authorization: 'Bearer valid-token' },
    });
    assert.equal(rbMirrorRes.status, 200);
    assert.equal(await rbMirrorRes.text(), 'mirror-rbdelta-bytes');

    const mirrorRes = await fetch(`${hostBase}/local/updates/fetch?url=${encodeURIComponent('https://public.example/updates/deltas/local-mirror.gbdelta')}`, {
      headers: { authorization: 'Bearer valid-token' },
    });
    assert.equal(mirrorRes.status, 200);
    assert.equal(await mirrorRes.text(), 'mirror-delta-bytes');
    assert.ok(tracked.includes('dev-1'));
  } finally {
    await new Promise(resolve => hostServer.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('Host /local/updates/fetch reads ROKBOT_UPDATE_UPSTREAM_ORIGIN and ROKBOT_UPDATE_DIR with GROKBOT_* fallback', async t => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 17 });
    res.end('{"version":"2.0"}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-update-env-'));
  await writeFile(path.join(dir, 'update.rbdelta'), 'env-rbdelta-bytes');

  const prev = {
    ROKBOT_UPDATE_UPSTREAM_ORIGIN: process.env.ROKBOT_UPDATE_UPSTREAM_ORIGIN,
    GROKBOT_UPDATE_UPSTREAM_ORIGIN: process.env.GROKBOT_UPDATE_UPSTREAM_ORIGIN,
    ROKBOT_UPDATE_DIR: process.env.ROKBOT_UPDATE_DIR,
    GROKBOT_UPDATE_DIR: process.env.GROKBOT_UPDATE_DIR,
  };
  t.after(async () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const { server } = makeServer({
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const hostBase = `http://127.0.0.1:${server.address().port}`;

  process.env.GROKBOT_UPDATE_UPSTREAM_ORIGIN = upstreamOrigin;
  process.env.GROKBOT_UPDATE_DIR = dir;
  const legacyRes = await fetch(`${hostBase}/local/updates/fetch?url=${encodeURIComponent(`${upstreamOrigin}/updates/update.rbdelta`)}`, {
    headers: { authorization: 'Bearer valid-token' },
  });
  assert.equal(legacyRes.status, 200);
  assert.equal(await legacyRes.text(), 'env-rbdelta-bytes');

  process.env.ROKBOT_UPDATE_UPSTREAM_ORIGIN = upstreamOrigin;
  process.env.ROKBOT_UPDATE_DIR = path.join(dir, 'nonexistent');
  const rokbotRes = await fetch(`${hostBase}/local/updates/fetch?url=${encodeURIComponent(`${upstreamOrigin}/updates/feed.json`)}`, {
    headers: { authorization: 'Bearer valid-token' },
  });
  assert.equal(rokbotRes.status, 200);
  assert.deepEqual(await rokbotRes.json(), { version: '2.0' });
});

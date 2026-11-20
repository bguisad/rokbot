import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  DESKTOP_UPDATE_SCHEMA,
  canonicalDesktopPayload,
  createDesktopUpdater,
  createTailcatUpdateFetch,
  resolveDesktopUpdateSource,
  validUpdateUrl,
} from '../clients/desktop/updater.mjs';
import {
  canonicalDesktopDeltasPayload,
  createDeltaBuffer,
} from '../clients/shared/delta.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey,
    pem: publicKey.export({ format: 'pem', type: 'spki' }),
    spkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function buildSyntheticAsar(headerObj, payloadText) {
  const json = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const pickleSize = 4 + 4 + json.length;
  const alignedSize = Math.ceil(pickleSize / 4) * 4;
  const buf = Buffer.alloc(8 + alignedSize + Buffer.byteLength(payloadText));
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(alignedSize, 4);
  buf.writeUInt32LE(pickleSize, 8);
  buf.writeInt32LE(json.length, 12);
  json.copy(buf, 16);
  buf.write(payloadText, 8 + alignedSize, 'utf8');
  return {
    bytes: buf,
    headerSha256: sha(json),
    sha256: sha(buf),
  };
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('validUpdateUrl preserves single-arg strictness and allows non-loopback HTTP only for matching allowOrigin', () => {
  assert.equal(validUpdateUrl('http://192.168.1.50:8000/local/updates/'), null);
  assert.equal(
    validUpdateUrl('http://192.168.1.50:8000/local/updates/', { allowOrigin: 'http://192.168.1.50:8000' }),
    'http://192.168.1.50:8000/local/updates',
  );
  assert.equal(
    validUpdateUrl('http://192.168.1.99:8000/local/updates/', { allowOrigin: 'http://192.168.1.50:8000' }),
    null,
  );
  assert.equal(validUpdateUrl('https://cdn.example.com/updates/', { allowOrigin: 'http://192.168.1.50:8000' }), 'https://cdn.example.com/updates');
});

test('resolveDesktopUpdateSource prefers pinned static config and otherwise auto-discovers paired Host /local/updates', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31a-src-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = p256();

  const macHost = await resolveDesktopUpdateSource({
    resourcesDir: dir,
    profileDir: dir,
    server: 'http://192.168.1.50:8000/',
    platform: 'darwin',
  });
  assert.deepEqual(macHost, {
    updateUrl: 'http://192.168.1.50:8000/local/updates',
    feedFile: 'macos.json',
    allowOrigin: 'http://192.168.1.50:8000',
    hostOrigin: 'http://192.168.1.50:8000',
    allowHostManifestKey: true,
  });

  const winHost = await resolveDesktopUpdateSource({
    resourcesDir: dir,
    profileDir: dir,
    server: 'https://host.example:8443',
    platform: 'win32',
  });
  assert.equal(winHost.feedFile, 'windows.json');
  assert.equal(winHost.allowOrigin, 'https://host.example:8443');

  // Static rokbot-local-update.json wins over Host server and does not enable allowHostManifestKey.
  await writeFile(path.join(dir, 'rokbot-local-update.json'), JSON.stringify({
    updateUrl: 'https://pinned.example/updates',
    updatePublicKey: key.spkiBase64,
  }));
  const pinned = await resolveDesktopUpdateSource({
    resourcesDir: dir,
    profileDir: dir,
    server: 'https://host.example:8443',
    platform: 'darwin',
  });
  assert.equal(pinned.updateUrl, 'https://pinned.example/updates');
  assert.equal(pinned.updatePublicKey, key.spkiBase64);
  assert.equal(pinned.allowHostManifestKey, undefined);
});

test('createTailcatUpdateFetch attaches Bearer auth directly on same-origin Host even when tunneled, and never leaks token externally', async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url, auth: headers.get('authorization') });
    if (url.includes('/local/updates/fetch?') && url.includes('404')) {
      return new Response('missing', { status: 404 });
    }
    return new Response('ok', { status: 200 });
  };

  // Same-origin direct while tunneled: must NOT wrap into /local/updates/fetch.
  const tunneledFetch = createTailcatUpdateFetch({
    isTunneled: () => true,
    getServerUrl: () => 'http://127.0.0.1:41234',
    getToken: () => 'host-secret-token',
    fetchImpl: fetchMock,
  });
  await tunneledFetch('http://127.0.0.1:41234/local/updates/macos.json');
  assert.deepEqual(calls[0], {
    url: 'http://127.0.0.1:41234/local/updates/macos.json',
    auth: 'Bearer host-secret-token',
  });

  // External CDN while tunneled -> proxy with Bearer token; on 404 fallback -> direct WITHOUT Bearer token.
  await tunneledFetch('https://cdn.example.com/404.dmg');
  assert.equal(calls[1].url, 'http://127.0.0.1:41234/local/updates/fetch?url=https%3A%2F%2Fcdn.example.com%2F404.dmg');
  assert.equal(calls[1].auth, 'Bearer host-secret-token');
  assert.equal(calls[2].url, 'https://cdn.example.com/404.dmg');
  assert.equal(calls[2].auth, null);

  // External CDN while NOT tunneled -> direct WITHOUT Bearer token.
  const directFetch = createTailcatUpdateFetch({
    isTunneled: () => false,
    getServerUrl: () => 'https://host.example:8000',
    getToken: () => 'host-secret-token',
    fetchImpl: fetchMock,
  });
  await directFetch('https://cdn.example.com/file.dmg');
  assert.deepEqual(calls[3], { url: 'https://cdn.example.com/file.dmg', auth: null });
  await directFetch('https://host.example:8000/local/updates/macos.json');
  assert.deepEqual(calls[4], {
    url: 'https://host.example:8000/local/updates/macos.json',
    auth: 'Bearer host-secret-token',
  });
});

test('updater verifies Host /local/updates/macos.json with latest wrapper, publicKeyPem, RBD1/GBD1 asarDeltas, and platformId fallback', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31a-host-upd-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = p256();

  const resDir = path.join(dir, 'resources');
  const profileDir = path.join(dir, 'profile');
  await mkdir(resDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const oldAsar = buildSyntheticAsar({ files: { 'index.js': { size: 100, offset: '0' } } }, 'X'.repeat(30000));
  const newAsar = buildSyntheticAsar({ files: { 'index.js': { size: 100, offset: '0' }, 'new.js': { size: 6, offset: '30000' } } }, 'X'.repeat(30000) + 'rokbot');
  await writeFile(path.join(resDir, 'app.asar'), oldAsar.bytes);

  const rbdAsarDelta = createDeltaBuffer(oldAsar.bytes, newAsar.bytes);
  const rawRbd = gunzipSync(rbdAsarDelta);
  const gbdAsarDelta = gzipSync(Buffer.concat([Buffer.from('GBD1', 'ascii'), rawRbd.subarray(4)]));
  const fullDmg = Buffer.from('full-dmg-1.2.4-payload');

  let useGbd = false;
  let servePlatformIdOnly = false;
  const reqUrls = [];

  const signHostManifest = (deltaBytes, deltaFileName) => {
    const manifestUrl = `/local/updates/files/macos/RokBot-1.2.4.dmg`;
    const deltaUrl = `/local/updates/files/macos/${deltaFileName}`;
    const publishedAt = '2026-11-19T21:00:00.000Z';
    const flatForSign = {
      schema: DESKTOP_UPDATE_SCHEMA,
      platform: 'macos',
      track: 'stable',
      version: '1.2.4',
      sha256: sha(fullDmg),
      size: fullDmg.length,
      url: manifestUrl,
      publishedAt,
      asarDeltas: [{
        baseSha256: oldAsar.sha256,
        baseSize: oldAsar.bytes.length,
        baseHeaderSha256: oldAsar.headerSha256,
        targetSha256: newAsar.sha256,
        targetSize: newAsar.bytes.length,
        targetHeaderSha256: newAsar.headerSha256,
        sha256: sha(deltaBytes),
        size: deltaBytes.length,
        url: deltaUrl,
      }],
    };
    const signature = sign('sha256', Buffer.from(canonicalDesktopPayload(flatForSign), 'utf8'), key.privateKey).toString('base64');
    const deltasSignature = sign('sha256', Buffer.from(canonicalDesktopDeltasPayload(flatForSign), 'utf8'), key.privateKey).toString('base64');
    return {
      schema: DESKTOP_UPDATE_SCHEMA,
      platform: 'macos',
      track: 'stable',
      publishedAt,
      signatureAlgorithm: 'ecdsa-p256-sha256',
      signature,
      publicKeyPem: key.pem,
      latest: {
        version: '1.2.4',
        url: manifestUrl,
        sha256: sha(fullDmg),
        size: fullDmg.length,
        asarSha256: newAsar.sha256,
        asarHeaderSha256: newAsar.headerSha256,
        asarDeltas: flatForSign.asarDeltas,
        deltasSignature,
      },
    };
  };

  const srv = await startServer((req, res) => {
    reqUrls.push(req.url);
    if (req.headers.authorization !== 'Bearer device-tok') {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/local/updates/macos.json' && !servePlatformIdOnly) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(signHostManifest(useGbd ? gbdAsarDelta : rbdAsarDelta, 'asar.rbdelta')));
      return;
    }
    if (pathname === '/local/updates/darwin-arm64.json' && servePlatformIdOnly) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(signHostManifest(gbdAsarDelta, 'asar-gbd.rbdelta')));
      return;
    }
    if (pathname === '/local/updates/files/macos/asar.rbdelta') {
      res.writeHead(200, { 'content-length': String(rbdAsarDelta.length) });
      res.end(rbdAsarDelta);
      return;
    }
    if (pathname === '/local/updates/files/macos/asar-gbd.rbdelta') {
      res.writeHead(200, { 'content-length': String(gbdAsarDelta.length) });
      res.end(gbdAsarDelta);
      return;
    }
    if (pathname === '/local/updates/files/macos/RokBot-1.2.4.dmg') {
      res.writeHead(200, { 'content-length': String(fullDmg.length) });
      res.end(fullDmg);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => srv.close());

  const source = await resolveDesktopUpdateSource({
    resourcesDir: resDir,
    profileDir,
    server: srv.url,
    platform: 'darwin',
  });
  const hostFetch = createTailcatUpdateFetch({
    isTunneled: () => false,
    getServerUrl: () => srv.url,
    getToken: () => 'device-tok',
  });

  // 1) RBD1 ASAR delta via /local/updates/macos.json
  const asarInstalls = [];
  const updater = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'darwin-arm64',
    profileDir,
    resourcesDir: resDir,
    execPath: path.join(dir, 'RokBot'),
    config: source,
    fetchImpl: hostFetch,
    canUseAsarUpdate: async () => true,
    onInstallAsar: async info => asarInstalls.push(info),
  });
  const ready = await updater.check();
  assert.equal(ready.state.type, 'ready');
  assert.equal(ready.state.version, '1.2.4');
  assert.equal(reqUrls.some(u => u.includes('RokBot-1.2.4.dmg')), false, 'must use ASAR delta without full DMG');
  await updater.quitAndInstall({ expectedVersion: '1.2.4' });
  assert.equal(asarInstalls.length, 1);
  assert.ok((await readFile(asarInstalls[0].asarFile)).equals(newAsar.bytes));

  // 2) Fallback to ${platformId}.json when macos.json returns 404, plus GBD1 ASAR delta read-compat
  const profileDir2 = path.join(dir, 'profile2');
  await mkdir(profileDir2, { recursive: true });
  servePlatformIdOnly = true;
  useGbd = true;
  const asarInstalls2 = [];
  const updater2 = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'darwin-arm64',
    profileDir: profileDir2,
    resourcesDir: resDir,
    execPath: path.join(dir, 'RokBot'),
    config: source,
    fetchImpl: hostFetch,
    canUseAsarUpdate: async () => true,
    onInstallAsar: async info => asarInstalls2.push(info),
  });
  const ready2 = await updater2.check();
  assert.equal(ready2.state.type, 'ready');
  assert.ok(reqUrls.some(u => u.startsWith('/local/updates/darwin-arm64.json')));
  await updater2.quitAndInstall({ expectedVersion: '1.2.4' });
  assert.ok((await readFile(asarInstalls2[0].asarFile)).equals(newAsar.bytes));
});

test('updater security: pinned key rejects mismatched manifest publicKeyPem, rejects unsupported algorithm, and falls back to full package when delta fails', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31a-sec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pinnedKey = p256();
  const attackerKey = p256();

  const fullPkg = Buffer.from('full-installer-package-1.2.4');
  const baseInstaller = Buffer.from('B'.repeat(4096) + 'old-1.2.3');
  const deltaBytes = createDeltaBuffer(baseInstaller, fullPkg);

  const updatesDir = path.join(dir, 'updates');
  await mkdir(updatesDir, { recursive: true });
  await writeFile(path.join(updatesDir, 'base-stable.exe'), baseInstaller);

  const makeManifest = (signingKey, opts = {}) => {
    const base = {
      schema: DESKTOP_UPDATE_SCHEMA,
      platform: 'win32-x64',
      track: 'stable',
      version: '1.2.4',
      sha256: sha(fullPkg),
      size: fullPkg.length,
      url: 'https://updates.example/RokBotLocal-1.2.4-x64-Setup.exe',
      publishedAt: '2026-11-19T21:00:00.000Z',
      ...(opts.badAlg ? { signatureAlgorithm: 'rsa-sha256' } : { signatureAlgorithm: 'ecdsa-p256-sha256' }),
      ...(opts.includePem ? { publicKeyPem: signingKey.pem } : {}),
    };
    base.signature = sign('sha256', Buffer.from(canonicalDesktopPayload(base), 'utf8'), signingKey.privateKey).toString('base64');
    if (opts.withCorruptDelta) {
      base.deltas = [{
        baseSha256: sha(baseInstaller),
        baseSize: baseInstaller.length,
        sha256: sha(deltaBytes),
        size: deltaBytes.length,
        url: 'https://updates.example/deltas/bad.rbdelta',
      }];
      base.deltasSignature = sign('sha256', Buffer.from(canonicalDesktopDeltasPayload(base), 'utf8'), signingKey.privateKey).toString('base64');
    }
    return base;
  };

  // 1) Pinned key must NEVER be overridden by manifest.publicKeyPem signed with attackerKey
  let currentManifest = makeManifest(attackerKey, { includePem: true });
  const updater1 = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'win32-x64',
    profileDir: dir,
    config: { updateUrl: 'https://updates.example', updatePublicKey: pinnedKey.spkiBase64 },
    fetchImpl: async url => {
      if (url.includes('/win32-x64.json')) return new Response(JSON.stringify(currentManifest), { status: 200 });
      return new Response(fullPkg, { status: 200 });
    },
  });
  const res1 = await updater1.check();
  assert.equal(res1.state.type, 'idle');
  assert.equal(res1.state.lastCheck.result, 'error');
  assert.equal(res1.state.lastCheck.failure.kind, 'installer_signature_invalid');
  assert.equal(res1.state.lastCheck.errorMessage, 'Manifest public key does not match pinned update key');
  assert.equal(res1.state.lastCheck.message, res1.state.lastCheck.errorMessage);

  // 2) Unsupported signatureAlgorithm rejected even if signature bytes were signed by pinnedKey
  currentManifest = makeManifest(pinnedKey, { badAlg: true });
  const res2 = await updater1.check();
  assert.equal(res2.state.lastCheck.result, 'error');
  assert.equal(res2.state.lastCheck.failure.kind, 'installer_signature_invalid');

  // 3) Host /local/updates/windows.json with platform: 'windows' and installer RBD1 delta apply + SHA-256 verify
  const profileWin = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31a-win-delta-'));
  t.after(() => rm(profileWin, { recursive: true, force: true }));
  await mkdir(path.join(profileWin, 'updates'), { recursive: true });
  await writeFile(path.join(profileWin, 'updates', 'base-stable.exe'), baseInstaller);

  const winPublishedAt = '2026-11-19T21:05:00.000Z';
  const winFlat = {
    schema: DESKTOP_UPDATE_SCHEMA,
    platform: 'windows',
    track: 'stable',
    version: '1.2.4',
    sha256: sha(fullPkg),
    size: fullPkg.length,
    url: '/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe',
    publishedAt: winPublishedAt,
    deltas: [{
      baseSha256: sha(baseInstaller),
      baseSize: baseInstaller.length,
      sha256: sha(deltaBytes),
      size: deltaBytes.length,
      url: '/local/updates/files/windows/setup.rbdelta',
    }],
  };
  const winManifest = {
    schema: DESKTOP_UPDATE_SCHEMA,
    platform: 'windows',
    track: 'stable',
    publishedAt: winPublishedAt,
    signatureAlgorithm: 'ecdsa-p256-sha256',
    signature: sign('sha256', Buffer.from(canonicalDesktopPayload(winFlat), 'utf8'), pinnedKey.privateKey).toString('base64'),
    publicKeyPem: pinnedKey.pem,
    latest: {
      version: '1.2.4',
      url: winFlat.url,
      sha256: winFlat.sha256,
      size: winFlat.size,
      deltas: winFlat.deltas,
      deltasSignature: sign('sha256', Buffer.from(canonicalDesktopDeltasPayload(winFlat), 'utf8'), pinnedKey.privateKey).toString('base64'),
    },
  };
  const winSrv = await startServer((req, res) => {
    if (req.headers.authorization !== 'Bearer win-tok') { res.writeHead(401); res.end(); return; }
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/local/updates/windows.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(winManifest));
      return;
    }
    if (pathname === '/local/updates/files/windows/setup.rbdelta') {
      res.writeHead(200, { 'content-length': String(deltaBytes.length) });
      res.end(deltaBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => winSrv.close());

  const winSource = await resolveDesktopUpdateSource({
    resourcesDir: profileWin,
    profileDir: profileWin,
    server: winSrv.url,
    platform: 'win32',
  });
  const winInstalled = [];
  const winUpdater = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'win32-x64',
    profileDir: profileWin,
    config: winSource,
    fetchImpl: createTailcatUpdateFetch({ isTunneled: () => false, getServerUrl: () => winSrv.url, getToken: () => 'win-tok' }),
    onInstallFile: async (file, ver) => winInstalled.push({ bytes: await readFile(file), ver }),
  });
  const winReady = await winUpdater.check();
  assert.equal(winReady.state.type, 'ready');
  await winUpdater.quitAndInstall({ expectedVersion: '1.2.4' });
  assert.equal(winInstalled.length, 1);
  assert.ok(winInstalled[0].bytes.equals(fullPkg));

  // 4) allowHostManifestKey rejects manifest when feed origin mismatches paired hostOrigin
  const mismatchedOriginUpdater = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'win32-x64',
    profileDir: dir,
    config: {
      updateUrl: 'https://rogue.example/local/updates',
      feedFile: 'windows.json',
      hostOrigin: 'https://paired.example',
      allowHostManifestKey: true,
    },
    fetchImpl: async () => new Response(JSON.stringify(winManifest), { status: 200 }),
  });
  const mismatchRes = await mismatchedOriginUpdater.check();
  assert.equal(mismatchRes.state.lastCheck.result, 'error');
  assert.equal(mismatchRes.state.lastCheck.failure.kind, 'installer_signature_invalid');

  // 5) Valid manifest with corrupt delta download falls back cleanly to full package download
  currentManifest = makeManifest(pinnedKey, { withCorruptDelta: true });
  const fetched = [];
  const installed = [];
  const updater2 = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'win32-x64',
    profileDir: dir,
    config: { updateUrl: 'https://updates.example', updatePublicKey: pinnedKey.spkiBase64 },
    onInstallFile: async (file, ver) => installed.push({ bytes: await readFile(file), ver }),
    fetchImpl: async url => {
      fetched.push(url);
      if (url.includes('/win32-x64.json')) return new Response(JSON.stringify(currentManifest), { status: 200 });
      if (url.includes('bad.rbdelta')) return new Response(Buffer.from('corrupt-delta-bytes'), { status: 200 });
      return new Response(fullPkg, { status: 200, headers: { 'content-length': String(fullPkg.length) } });
    },
  });
  const res3 = await updater2.check();
  assert.equal(res3.state.type, 'ready');
  assert.equal(fetched.some(u => u.includes('bad.rbdelta')), true);
  assert.equal(fetched.some(u => u.includes('Setup.exe')), true);
  await updater2.quitAndInstall({ expectedVersion: '1.2.4' });
  assert.ok(installed[0].bytes.equals(fullPkg));
});

test('updater emits downloading progress in [0, 1] and idle error lastCheck with both errorMessage and message', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31a-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = p256();

  const fullPkg = Buffer.from('0123456789'.repeat(10)); // 100 bytes
  const manifest = {
    schema: DESKTOP_UPDATE_SCHEMA,
    platform: 'darwin-arm64',
    track: 'stable',
    version: '1.2.4',
    sha256: sha(fullPkg),
    size: fullPkg.length,
    url: 'https://updates.example/RokBot-1.2.4.dmg',
    publishedAt: '2026-11-19T21:15:00.000Z',
    signatureAlgorithm: 'ecdsa-p256-sha256',
  };
  manifest.signature = sign('sha256', Buffer.from(canonicalDesktopPayload(manifest), 'utf8'), key.privateKey).toString('base64');

  // 1) Multi-chunk download emits fractional progress in [0, 1]
  const downloadingProgress = [];
  const updater = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'darwin-arm64',
    profileDir: dir,
    config: { updateUrl: 'https://updates.example', updatePublicKey: key.spkiBase64 },
    onStatus: snap => {
      if (snap.state.type === 'downloading') {
        downloadingProgress.push(snap.state.progress);
      }
    },
    fetchImpl: async url => {
      if (url.includes('/darwin-arm64.json')) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      const half = Math.floor(fullPkg.length / 2);
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(fullPkg.subarray(0, half));
          await new Promise(resolve => setTimeout(resolve, 10));
          controller.enqueue(fullPkg.subarray(half));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-length': String(fullPkg.length) },
      });
    },
  });

  const ready = await updater.check();
  assert.equal(ready.state.type, 'ready');
  assert.ok(downloadingProgress.length >= 1, 'expected at least one downloading progress event');
  for (const p of downloadingProgress) {
    assert.equal(typeof p, 'number');
    assert.ok(p >= 0 && p <= 1, `expected progress in [0, 1], got ${p}`);
  }
  assert.ok(
    downloadingProgress.some(p => p > 0 && p < 1),
    `expected fractional progress in (0, 1), got ${JSON.stringify(downloadingProgress)}`,
  );

  // 2) Failed feed check emits idle error state with both lastCheck.errorMessage and lastCheck.message
  const errEvents = [];
  const errUpdater = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'darwin-arm64',
    profileDir: dir,
    config: { updateUrl: 'https://updates.example', updatePublicKey: key.spkiBase64 },
    onStatus: snap => {
      if (snap.state.type === 'idle' && snap.state.lastCheck?.result === 'error') {
        errEvents.push(snap.state.lastCheck);
      }
    },
    fetchImpl: async () => new Response('service unavailable', { status: 503 }),
  });

  const errSnap = await errUpdater.check();
  assert.equal(errSnap.state.type, 'idle');
  assert.equal(errSnap.state.lastCheck.result, 'error');
  assert.deepEqual(errSnap.state.lastCheck.failure, { kind: 'feed_http_status', httpStatus: 503 });
  assert.equal(errSnap.state.lastCheck.errorMessage, 'HTTP 503');
  assert.equal(errSnap.state.lastCheck.message, 'HTTP 503');
  assert.equal(errEvents.length, 1);
  assert.equal(errEvents[0].errorMessage, 'HTTP 503');
  assert.equal(errEvents[0].message, 'HTTP 503');
});

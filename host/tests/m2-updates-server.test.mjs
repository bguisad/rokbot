import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { verifyDesktopDeltas, verifyDesktopUpdateManifest } from '../../ci/release-sign.mjs';
import { verifyDesktopDeltasManifest, verifyDesktopManifest } from '../../mac/clients/desktop/updater.mjs';
import { applyDeltaBuffer, applyDeltaFile, readAsarHeaderInfo } from '../../mac/clients/shared/delta.mjs';
import { applyDelta as applyAndroidDelta } from '../../android/release/delta-update.mjs';
import { createEntry, createSigningIdentity, signApk, writeZip } from '../../android/patchers/signing.mjs';

const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function makeAsarBuffer(manifestObj, payloadBuf) {
  const jsonBytes = Buffer.from(JSON.stringify(manifestObj), 'utf8');
  const alignedLen = Math.ceil((jsonBytes.length + 4) / 4) * 4;
  const headerBuf = Buffer.alloc(16 + alignedLen);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(alignedLen + 8, 4);
  headerBuf.writeUInt32LE(alignedLen + 4, 8);
  headerBuf.writeInt32LE(jsonBytes.length, 12);
  jsonBytes.copy(headerBuf, 16);
  return Buffer.concat([headerBuf, payloadBuf]);
}

async function startHostFixture(t, extraOptions = {}) {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-m2-updates-'));
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
    internalToken: 'c'.repeat(40),
    ...extraOptions,
  });
  await host.start(0, '127.0.0.1');
  t.after(async () => {
    await host.close();
    await new Promise(resolve => core.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const adminToken = await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const adminCookie = `rokbot_admin=${adminToken}`;
  const devicePair = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'Test Client',
    platform: 'desktop',
  });
  return {
    dir,
    host,
    origin,
    adminCookie,
    deviceToken: devicePair.token,
  };
}

test('Admin auth/CSRF, ROKBOT_UPDATE_DIR, streaming upload validation, and path traversal protections', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const customUpdateDir = await mkdtemp(join(tmpdir(), 'rokbot-custom-update-dir-'));
  const prevUpdateDir = process.env.ROKBOT_UPDATE_DIR;
  process.env.ROKBOT_UPDATE_DIR = customUpdateDir;
  t.after(async () => {
    if (prevUpdateDir === undefined) delete process.env.ROKBOT_UPDATE_DIR;
    else process.env.ROKBOT_UPDATE_DIR = prevUpdateDir;
    await rm(customUpdateDir, { recursive: true, force: true });
  });

  const { origin, adminCookie, deviceToken } = await startHostFixture(t, { maxUploadBytes: 64 * 1024 });

  // 1. Admin routes require cookie + x-rokbot-csrf: 1
  assert.equal((await fetch(`${origin}/admin/api/updates`)).status, 401);
  assert.equal((await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: '{}',
  })).status, 403);
  assert.equal((await fetch(`${origin}/local/updates/android.json`)).status, 401);
  assert.equal((await fetch(`${origin}/local/updates/files/android/app.apk`)).status, 401);

  // 2. Keypair created with 0600 inside custom ROKBOT_UPDATE_DIR
  const overviewRes = await fetch(`${origin}/admin/api/updates`, { headers: { cookie: adminCookie } });
  assert.equal(overviewRes.status, 200);
  const overview = await overviewRes.json();
  assert.equal(overview.updateDir, customUpdateDir);
  assert.equal(overview.signingKey.algorithm, 'ecdsa-p256-sha256');
  assert.match(overview.signingKey.publicKeyPem, /BEGIN PUBLIC KEY/);
  const keyStat = await stat(join(customUpdateDir, 'manifest-signing-key.json'));
  assert.equal(keyStat.mode & 0o777, 0o600);

  // 3. Reject traversal, bad extension, empty upload, and oversized upload (413)
  const badUpload = (platform, filename, body = 'abc', headers = {}) => fetch(
    `${origin}/admin/api/updates/upload?platform=${encodeURIComponent(platform)}&filename=${encodeURIComponent(filename)}`,
    {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', ...headers },
      body,
    },
  );
  assert.equal((await badUpload('android', '../evil.apk')).status, 400);
  assert.equal((await badUpload('android', '%2e%2e.apk')).status, 400);
  assert.equal((await badUpload('android', 'payload.sh')).status, 400);
  assert.equal((await badUpload('android', 'empty.apk', Buffer.alloc(0))).status, 400);
  assert.equal((await badUpload('android', 'too-big.apk', Buffer.alloc(65 * 1024))).status, 413);

  // 4. Valid streaming upload stores exact bytes under ROKBOT_UPDATE_DIR
  const payload = randomBytes(16384);
  const upOk = await badUpload('android', 'sample.apk', payload);
  assert.equal(upOk.status, 201);
  const upJson = await upOk.json();
  assert.equal(upJson.sha256, sha256(payload));
  assert.equal(upJson.size, payload.length);
  const diskBytes = await readFile(join(customUpdateDir, 'artifacts', 'android', 'sample.apk'));
  assert.ok(diskBytes.equals(payload));

  // 5. File serving traversal checks & Range (206 / 416 / 304 / HEAD)
  assert.equal((await fetch(`${origin}/local/updates/files/android/..%2Fsecret.apk`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  })).status, 400);
  const parsedOrigin = new URL(origin);
  const rawTraversalStatus = await new Promise((resolve, reject) => {
    const req = http.get({
      hostname: parsedOrigin.hostname,
      port: Number(parsedOrigin.port),
      path: '/local/updates/files/android/%2e%2e',
      headers: { authorization: `Bearer ${deviceToken}` },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(rawTraversalStatus, 400);
  const headRes = await fetch(`${origin}/local/updates/files/android/sample.apk`, {
    method: 'HEAD',
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(headRes.headers.get('content-length')), payload.length);

  const rangeRes = await fetch(`${origin}/local/updates/files/android/sample.apk`, {
    headers: { authorization: `Bearer ${deviceToken}`, range: 'bytes=100-199' },
  });
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get('content-range'), `bytes 100-199/${payload.length}`);
  assert.ok(Buffer.from(await rangeRes.arrayBuffer()).equals(payload.subarray(100, 200)));

  const suffixRangeRes = await fetch(`${origin}/local/updates/files/android/sample.apk`, {
    headers: { authorization: `Bearer ${deviceToken}`, range: 'bytes=-32' },
  });
  assert.equal(suffixRangeRes.status, 206);
  assert.ok(Buffer.from(await suffixRangeRes.arrayBuffer()).equals(payload.subarray(-32)));

  const oobRangeRes = await fetch(`${origin}/local/updates/files/android/sample.apk`, {
    headers: { authorization: `Bearer ${deviceToken}`, range: 'bytes=999999-' },
  });
  assert.equal(oobRangeRes.status, 416);

  const fullRes = await fetch(`${origin}/local/updates/files/android/sample.apk`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  const etag = fullRes.headers.get('etag');
  assert.ok(etag);
  const notModified = await fetch(`${origin}/local/updates/files/android/sample.apk`, {
    headers: { authorization: `Bearer ${deviceToken}`, 'if-none-match': etag },
  });
  assert.equal(notModified.status, 304);
});

test('Desktop (win32-x64 & darwin-arm64) manifest signing and RBD1 installer + ASAR deltas cross-verify against mac/clients & ci/release-sign', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { dir, origin, adminCookie, deviceToken } = await startHostFixture(t);
  const workDir = join(dir, 'client-work');

  const commonBody = randomBytes(48 * 1024);
  const instV1 = Buffer.concat([Buffer.from('SETUP-V1:'), commonBody, Buffer.from(':END-V1')]);
  const instV2 = Buffer.concat([Buffer.from('SETUP-V2-NEW:'), commonBody, Buffer.from(':TAIL-V2')]);

  const asarPayload = randomBytes(32 * 1024);
  const asarV1 = makeAsarBuffer({ files: { 'index.js': { size: 100, offset: '0' } } }, Buffer.concat([Buffer.from('ASAR1:'), asarPayload]));
  const asarV2 = makeAsarBuffer({ files: { 'index.js': { size: 200, offset: '0' }, 'v2.js': { size: 10, offset: '200' } } }, Buffer.concat([Buffer.from('ASAR2-UPDATED:'), asarPayload]));

  const upload = async (platform, filename, bytes) => {
    const res = await fetch(`${origin}/admin/api/updates/upload?platform=${platform}&filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
      body: bytes,
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  const publish = async body => {
    const res = await fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 201);
    return res.json();
  };

  await upload('windows', 'RokBotLocal-1.2.2-x64-Setup.exe', instV1);
  await upload('windows', 'app-1.2.2.asar', asarV1);
  const pubV1 = await publish({
    platform: 'windows',
    version: '1.2.2',
    filename: 'RokBotLocal-1.2.2-x64-Setup.exe',
    asarFilename: 'app-1.2.2.asar',
    releaseNotes: 'Initial 1.2.2',
  });

  await upload('windows', 'RokBotLocal-1.2.3-x64-Setup.exe', instV2);
  await upload('windows', 'app-1.2.3.asar', asarV2);
  const pubV2 = await publish({
    platform: 'windows',
    version: '1.2.3',
    filename: 'RokBotLocal-1.2.3-x64-Setup.exe',
    asarFilename: 'app-1.2.3.asar',
    generateDeltaFrom: pubV1.release.id,
    releaseNotes: 'Delta upgrade to 1.2.3',
  });
  assert.equal(pubV2.release.deltas.length, 1);
  assert.equal(pubV2.release.asarDeltas.length, 1);

  // Also test macOS nightly track
  await upload('macos', 'RokBotLocal-1.2.3-arm64.dmg', instV2);
  await publish({
    platform: 'macos',
    targetPlatform: 'darwin-arm64',
    track: 'nightly',
    version: '1.2.3-nightly.1',
    filename: 'RokBotLocal-1.2.3-arm64.dmg',
  });

  const winFeedRes = await fetch(`${origin}/local/updates/win32-x64.json`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(winFeedRes.status, 200);
  const winManifest = await winFeedRes.json();
  assert.equal(winManifest.schema, 'rokbot-desktop-update/v1');
  assert.equal(winManifest.platform, 'win32-x64');
  assert.equal(winManifest.signatureAlgorithm, 'ecdsa-p256-sha256');
  assert.equal(winManifest.latest.version, '1.2.3');

  // Cross-verify with actual mac/clients/desktop/updater.mjs & ci/release-sign.mjs!
  verifyDesktopManifest(winManifest, winManifest.publicKeySpkiBase64);
  verifyDesktopDeltasManifest(winManifest, winManifest.publicKeySpkiBase64);
  verifyDesktopUpdateManifest(winManifest, winManifest.publicKeySpkiBase64);
  verifyDesktopDeltas(winManifest, winManifest.publicKeySpkiBase64);

  // Download installer delta and apply with actual mac/clients/shared/delta.mjs
  const instDeltaRes = await fetch(winManifest.deltas[0].url, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(instDeltaRes.status, 200);
  const instDeltaBuf = Buffer.from(await instDeltaRes.arrayBuffer());
  const reconstructedInst = applyDeltaBuffer(instV1, instDeltaBuf);
  assert.ok(reconstructedInst.equals(instV2));

  // Download ASAR delta and apply via applyDeltaFile + readAsarHeaderInfo
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(workDir, { recursive: true });
  const asarV1Path = join(workDir, 'v1.asar');
  const asarDeltaPath = join(workDir, 'v1-to-v2.rbdelta');
  const asarOutPath = join(workDir, 'v2-reconstructed.asar');
  await writeFile(asarV1Path, asarV1);
  const asarDeltaRes = await fetch(winManifest.asarDeltas[0].url, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(asarDeltaRes.status, 200);
  await writeFile(asarDeltaPath, Buffer.from(await asarDeltaRes.arrayBuffer()));
  const applied = await applyDeltaFile(asarV1Path, asarDeltaPath, asarOutPath, {
    expectedSourceSha256: winManifest.asarDeltas[0].baseSha256,
    expectedTargetSha256: winManifest.asarDeltas[0].targetSha256,
    expectedTargetSize: winManifest.asarDeltas[0].targetSize,
  });
  assert.equal(applied.sha256, sha256(asarV2));
  assert.equal((await readAsarHeaderInfo(asarOutPath)).headerSha256, winManifest.asarDeltas[0].targetHeaderSha256);

  // macOS nightly manifest check
  const macNightly = await (await fetch(`${origin}/local/updates/darwin-arm64-nightly.json`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  })).json();
  assert.equal(macNightly.platform, 'darwin-arm64');
  assert.equal(macNightly.track, 'nightly');
  verifyDesktopManifest(macNightly, macNightly.publicKeySpkiBase64);
});

test('Android RBDELTA1 delta generation, signing cert extraction, and cross-verification against android/release/delta-update.mjs', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { origin, adminCookie, deviceToken } = await startHostFixture(t);
  const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
  const expectedCertSha = sha256(identity.certificate).toLowerCase();

  const sharedNativeLib = randomBytes(128 * 1024);
  const apkV1 = signApk(
    writeZip([
      createEntry('classes.dex', Buffer.alloc(16 * 1024, 0x11)),
      createEntry('lib/arm64-v8a/librokbot.so', sharedNativeLib, { store: true }),
    ]),
    identity,
  );
  const apkV2 = signApk(
    writeZip([
      createEntry('classes.dex', Buffer.alloc(17 * 1024 + 333, 0x22)),
      createEntry('lib/arm64-v8a/librokbot.so', sharedNativeLib, { store: true }),
    ]),
    identity,
  );

  const up1 = await fetch(`${origin}/admin/api/updates/upload?platform=android&filename=RokBot-1.15.0.apk`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
    body: apkV1,
  });
  assert.equal(up1.status, 201);
  const up1Json = await up1.json();
  assert.equal(up1Json.apkInfo.certificateSha256, expectedCertSha);

  const pub1 = await (await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'android',
      filename: 'RokBot-1.15.0.apk',
      packageName: 'dev.rokbot.nativeapp',
      versionName: '1.15.0',
      versionCode: 150,
    }),
  })).json();
  assert.equal(pub1.release.certificateSha256, expectedCertSha);

  await fetch(`${origin}/admin/api/updates/upload?platform=android&filename=RokBot-1.16.0.apk`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
    body: apkV2,
  });
  await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'android',
      filename: 'RokBot-1.16.0.apk',
      packageName: 'dev.rokbot.nativeapp',
      versionName: '1.16.0',
      versionCode: 160,
      generateDeltaFrom: pub1.release.id,
      releaseNotes: 'Android 1.16.0 with RBDELTA1',
    }),
  });

  const manifestRes = await fetch(`${origin}/local/updates/android.json`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(manifestRes.status, 200);
  const manifest = await manifestRes.json();
  assert.equal(manifest.schema, 'rokbot-android-native-update/v1');
  assert.equal(manifest.packageName, 'dev.rokbot.nativeapp');
  assert.equal(manifest.versionCode, 160);
  assert.equal(manifest.certificateSha256, expectedCertSha);
  assert.equal(manifest.sha256, sha256(apkV2));
  assert.equal(manifest.latest.apkSha256, sha256(apkV2));
  assert.equal(manifest.deltas.length, 1);
  assert.equal(manifest.deltas[0].fromSha256, sha256(apkV1));
  assert.equal(manifest.deltas[0].fromApkSha256, sha256(apkV1));
  assert.equal(manifest.deltas[0].fromVersionCode, 150);
  assert.equal(manifest.deltas[0].format, 'RBDELTA1');
  assert.ok(manifest.deltas[0].size < apkV2.length * 0.3);

  const deltaRes = await fetch(manifest.deltas[0].url, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(deltaRes.status, 200);
  const deltaBuf = Buffer.from(await deltaRes.arrayBuffer());
  assert.equal(gunzipSync(deltaBuf).subarray(0, 8).toString('ascii'), 'RBDELTA1');

  // Cross-verify with android/release/delta-update.mjs applyDelta()
  const reconstructed = applyAndroidDelta(apkV1, deltaBuf);
  assert.ok(reconstructed.equals(apkV2));
});

test('iOS OTA capability-scoped endpoints, public feed toggle, and release deletion with artifact GC', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { host, origin, adminCookie, deviceToken } = await startHostFixture(t);
  const ipaV1 = randomBytes(4096);
  const ipaV2 = randomBytes(4096);

  await fetch(`${origin}/admin/api/updates/upload?platform=ios&filename=RokBot-1.15.0.ipa`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
    body: ipaV1,
  });
  const pub1 = await (await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', filename: 'RokBot-1.15.0.ipa', version: '1.15.0', build: '680', bundleId: 'dev.rokbot.local' }),
  })).json();

  await fetch(`${origin}/admin/api/updates/upload?platform=ios&filename=RokBot-1.16.0.ipa`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
    body: ipaV2,
  });
  const pub2 = await (await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'ios',
      filename: 'RokBot-1.16.0.ipa',
      version: '1.16.0',
      build: '694',
      bundleId: 'dev.rokbot.local',
      releaseNotes: 'iOS 1.16.0 OTA',
    }),
  })).json();

  const iosFeed = await (await fetch(`${origin}/local/updates/ios.json`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  })).json();
  assert.equal(iosFeed.schema, 'rokbot-ios-update/v1');
  assert.equal(iosFeed.latest.version, '1.16.0');
  assert.equal(iosFeed.latest.build, '694');
  assert.ok(iosFeed.latest.installMethods.itmsServicesUrl.startsWith('itms-services://?action=download-manifest&url='));

  // External OTA endpoints work without Bearer token when given valid capability token, and reject forged tokens
  assert.equal((await fetch(`${origin}/updates/ios/forged-token/manifest.plist`)).status, 403);
  assert.equal((await fetch(`${origin}/updates/ios/public/manifest.plist`)).status, 403);

  const plistRes = await fetch(iosFeed.latest.installMethods.manifestPlistUrl);
  assert.equal(plistRes.status, 200);
  const plistText = await plistRes.text();
  assert.match(plistText, /<key>software-package<\/key>|<string>software-package<\/string>/);
  assert.match(plistText, /RokBot-1\.16\.0\.ipa/);
  assert.match(plistText, /dev\.rokbot\.local/);

  const altStoreRes = await fetch(iosFeed.latest.installMethods.altStoreSourceUrl);
  assert.equal(altStoreRes.status, 200);
  const altStoreJson = await altStoreRes.json();
  assert.equal(altStoreJson.apps[0].bundleIdentifier, 'dev.rokbot.local');
  assert.equal(altStoreJson.apps[0].versions[0].version, '1.16.0');

  const ipaRangeRes = await fetch(iosFeed.latest.installMethods.ipaDownloadUrl, {
    headers: { range: 'bytes=0-127' },
  });
  assert.equal(ipaRangeRes.status, 206);
  assert.ok(Buffer.from(await ipaRangeRes.arrayBuffer()).equals(ipaV2.subarray(0, 128)));

  // Public iOS feed toggle
  const enablePub = await fetch(`${origin}/admin/api/updates/settings`, {
    method: 'PATCH',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ publicIosFeed: true }),
  });
  assert.equal(enablePub.status, 200);
  assert.equal((await fetch(`${origin}/updates/ios/public/manifest.plist`)).status, 200);

  // Delete pub1 -> cleans RokBot-1.15.0.ipa while keeping RokBot-1.16.0.ipa
  const delRes = await fetch(`${origin}/admin/api/updates/ios/${pub1.release.id}`, {
    method: 'DELETE',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
  });
  assert.equal(delRes.status, 200);
  const delJson = await delRes.json();
  assert.deepEqual(delJson.cleanedFiles, ['RokBot-1.15.0.ipa']);
  assert.equal(existsSync(join(host.updates.artifactsDir, 'ios', 'RokBot-1.15.0.ipa')), false);
  assert.equal(existsSync(join(host.updates.artifactsDir, 'ios', 'RokBot-1.16.0.ipa')), true);
  assert.ok(pub2.release.id);
});

test('Iteration 2 regressions: symlink escape, macOS arch feed strictness, public iOS AltStore URLs, empty ROKBOT_UPDATE_DIR, active upload 409, XML control chars & i18n coverage', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  // 1. Empty ROKBOT_UPDATE_DIR="" falls back to join(dataDir, 'updates'), never process.cwd()
  const { UpdatesManager } = await import('../server/updates.mjs');
  const tmpDataDir = await mkdtemp(join(tmpdir(), 'rokbot-empty-updatedir-'));
  const prevUpdateEnv = {
    ROKBOT_UPDATE_DIR: process.env.ROKBOT_UPDATE_DIR,
    GROKBOT_UPDATE_DIR: process.env.GROKBOT_UPDATE_DIR,
  };
  t.after(async () => {
    for (const [k, v] of Object.entries(prevUpdateEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDataDir, { recursive: true, force: true });
  });
  process.env.ROKBOT_UPDATE_DIR = '';
  process.env.GROKBOT_UPDATE_DIR = '   ';
  const emptyEnvMgr = new UpdatesManager(tmpDataDir);
  assert.equal(emptyEnvMgr.root, join(tmpDataDir, 'updates'));

  const { dir, host, origin, adminCookie, deviceToken } = await startHostFixture(t);

  // 2. Symlink escape in artifacts/ & deltas/ must be rejected (403/404, never 200)
  const outsideSecret = join(dir, 'outside-secret.txt');
  await writeFile(outsideSecret, 'TOP_SECRET_OUTSIDE_DATA_12345');
  await symlink(outsideSecret, join(host.updates.artifactsDir, 'android', 'sym-escape.apk'));
  await symlink(outsideSecret, join(host.updates.deltasDir, 'sym-escape.rbdelta'));
  await symlink(outsideSecret, join(host.updates.artifactsDir, 'ios', 'sym-escape.ipa'));

  const symApkRes = await fetch(`${origin}/local/updates/files/android/sym-escape.apk`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.ok([403, 404].includes(symApkRes.status));
  assert.equal((await symApkRes.text()).includes('TOP_SECRET_OUTSIDE_DATA_12345'), false);

  const symDeltaRes = await fetch(`${origin}/local/updates/files/android/sym-escape.rbdelta`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.ok([403, 404].includes(symDeltaRes.status));
  assert.equal((await symDeltaRes.text()).includes('TOP_SECRET_OUTSIDE_DATA_12345'), false);

  const symPublishRes = await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', filename: 'sym-escape.ipa', version: '1.0.0' }),
  });
  assert.ok([403, 404].includes(symPublishRes.status));

  // 3. macOS architecture feed strict matching: darwin-x64.json must 404 if only darwin-arm64 is published
  const macDmg = randomBytes(4096);
  assert.equal((await fetch(`${origin}/admin/api/updates/upload?platform=macos&filename=RokBot-1.2.3-arm64.dmg`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
    body: macDmg,
  })).status, 201);
  assert.equal((await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'macos',
      targetPlatform: 'darwin-arm64',
      track: 'stable',
      version: '1.2.3',
      filename: 'RokBot-1.2.3-arm64.dmg',
    }),
  })).status, 201);
  assert.equal((await fetch(`${origin}/local/updates/darwin-x64.json`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  })).status, 404);
  const armFeed = await fetch(`${origin}/local/updates/darwin-arm64.json`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(armFeed.status, 200);
  assert.equal((await armFeed.json()).platform, 'darwin-arm64');

  // 4. publicIosFeed: true serves ALL published iOS versions referenced in /updates/ios/public/altstore.json
  const ipaV1 = randomBytes(2048);
  const ipaV2 = randomBytes(2048);
  await fetch(`${origin}/admin/api/updates/upload?platform=ios&filename=RokBot-1.15.0.ipa`, {
    method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: ipaV1,
  });
  await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', filename: 'RokBot-1.15.0.ipa', version: '1.15.0', build: '680', bundleId: 'dev.rokbot.local' }),
  });
  await fetch(`${origin}/admin/api/updates/upload?platform=ios&filename=RokBot-1.16.0.ipa`, {
    method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: ipaV2,
  });
  await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', filename: 'RokBot-1.16.0.ipa', version: '1.16.0', build: '694', bundleId: 'dev.rokbot.local' }),
  });
  await fetch(`${origin}/admin/api/updates/settings`, {
    method: 'PATCH',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ publicIosFeed: true }),
  });
  const altRes = await fetch(`${origin}/updates/ios/public/altstore.json`);
  assert.equal(altRes.status, 200);
  const altJson = await altRes.json();
  assert.equal(altJson.apps[0].versions.length, 2);
  for (const ver of altJson.apps[0].versions) {
    const dl = await fetch(ver.downloadURL);
    assert.equal(dl.status, 200, `Expected 200 for ${ver.downloadURL}`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.ok(bytes.equals(ver.version === '1.16.0' ? ipaV2 : ipaV1));
  }

  // 5. Re-uploading an active release filename must return 409 and not overwrite/desync disk artifact
  const apkV1 = randomBytes(1024);
  const apkV2 = randomBytes(2048);
  assert.equal((await fetch(`${origin}/admin/api/updates/upload?platform=android&filename=RokBot-same.apk`, {
    method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: apkV1,
  })).status, 201);
  const pubSame = await (await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'android', filename: 'RokBot-same.apk', versionName: '1.0.0', versionCode: 100 }),
  })).json();
  const overwriteRes = await fetch(`${origin}/admin/api/updates/upload?platform=android&filename=RokBot-same.apk`, {
    method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: apkV2,
  });
  assert.equal(overwriteRes.status, 409);
  const servedSame = await fetch(`${origin}/local/updates/files/android/RokBot-same.apk`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(servedSame.status, 200);
  assert.equal(servedSame.headers.get('etag'), `"sha256:${sha256(apkV1)}"`);
  assert.ok(Buffer.from(await servedSame.arrayBuffer()).equals(apkV1));

  // Deleting release allows re-uploading same filename
  assert.equal((await fetch(`${origin}/admin/api/updates/android/${pubSame.release.id}`, {
    method: 'DELETE', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
  })).status, 200);
  assert.equal((await fetch(`${origin}/admin/api/updates/upload?platform=android&filename=RokBot-same.apk`, {
    method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: apkV2,
  })).status, 201);

  // 6. XML 1.0 control characters rejected at publish()
  await fetch(`${origin}/admin/api/updates/upload?platform=ios&filename=RokBot-ctrl.ipa`, {
    method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: randomBytes(512),
  });
  const ctrlRes = await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', filename: 'RokBot-ctrl.ipa', version: '1.0.0\x07bell' }),
  });
  assert.equal(ctrlRes.status, 400);

  // 7. i18n completeness for M2.2 model.js hint and all updates.mjs error strings
  const { default: enDict } = await import('../server/public/locales-en.js');
  const modelJs = await readFile(new URL('../server/public/model.js', import.meta.url), 'utf8');
  assert.ok(modelJs.includes('关闭时，仅使用管理员密码配对或提供管理密码的设备可修改模型'));
  assert.ok(enDict['关闭时，仅使用管理员密码配对或提供管理密码的设备可修改模型']);

  const updatesSrc = await readFile(new URL('../server/updates.mjs', import.meta.url), 'utf8');
  for (const match of updatesSrc.matchAll(/(?:check\([^,]+,\s*\d+\s*,|HttpError\(\d+\s*,)\s*'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) {
    assert.ok(enDict[match[1]], `Missing locales-en.js translation for updates.mjs error: ${match[1]}`);
  }
  for (const key of [
    'ASAR SHA-256 格式无效',
    'ASAR 文件头无效',
    '未找到用于生成增量补丁的基础版本文件',
    '该文件名已被已发布版本引用，请使用新文件名或先删除旧版本',
    '不支持的请求方法',
  ]) {
    assert.ok(enDict[key], `Missing locales-en.js key: ${key}`);
  }
});

test('Iteration 3 regressions: DELETE symlinked parent/leaf preservation, upload pre-mkdir symlink guard, case-variant 409, and tokenized iOS altstore.json URLs', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  // 1. DELETE with symlinked artifacts/<platform> or deltas/ rejects 403 and preserves outside files;
  //    leaf symlink also preserves outside target.
  {
    const { dir, host, origin, adminCookie } = await startHostFixture(t);
    const outsideDir = join(dir, 'outside-artifacts-platform');
    const outsideDeltas = join(dir, 'outside-deltas');
    const outsideSecret = join(dir, 'outside-leaf-secret.txt');
    await mkdir(outsideDir, { recursive: true });
    await mkdir(outsideDeltas, { recursive: true });
    await writeFile(join(outsideDir, 'victim.apk'), 'KEEP_ME_OUTSIDE_APK');
    await writeFile(outsideSecret, 'KEEP_ME_OUTSIDE_LEAF');

    // Upload & publish Android release, then swap artifacts/android -> outsideDir
    assert.equal((await fetch(`${origin}/admin/api/updates/upload?platform=android&filename=victim.apk`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: randomBytes(1024),
    })).status, 201);
    const pubAnd = await (await fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'android', filename: 'victim.apk', versionName: '1.0.0', versionCode: 10 }),
    })).json();

    const androidDir = join(host.updates.artifactsDir, 'android');
    await rename(androidDir, join(dir, 'backup-android-dir'));
    await symlink(outsideDir, androidDir);

    const delSymlinkPlatform = await fetch(`${origin}/admin/api/updates/android/${pubAnd.release.id}`, {
      method: 'DELETE', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
    });
    assert.equal(delSymlinkPlatform.status, 403);
    assert.equal(existsSync(join(outsideDir, 'victim.apk')), true);

    // Restore artifacts/android so later Windows delta test runs cleanly
    await rm(androidDir, { force: true });
    await rename(join(dir, 'backup-android-dir'), androidDir);

    // Upload & publish two Windows releases with generated delta, then swap deltas -> outsideDeltas
    const common = randomBytes(32 * 1024);
    const winV1 = Buffer.concat([Buffer.from('WIN1:'), common]);
    const winV2 = Buffer.concat([Buffer.from('WIN2-DIFF:'), common]);
    assert.equal((await fetch(`${origin}/admin/api/updates/upload?platform=windows&filename=Win-1.0.exe`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: winV1,
    })).status, 201);
    const pubW1 = await (await fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'windows', filename: 'Win-1.0.exe', version: '1.0.0' }),
    })).json();
    assert.equal((await fetch(`${origin}/admin/api/updates/upload?platform=windows&filename=Win-2.0.exe`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: winV2,
    })).status, 201);
    const pubW2 = await (await fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'windows', filename: 'Win-2.0.exe', version: '2.0.0', generateDeltaFrom: pubW1.release.id }),
    })).json();
    const deltaName = pubW2.release.deltas[0].filename;
    await writeFile(join(outsideDeltas, deltaName), 'KEEP_ME_OUTSIDE_DELTA');
    await rename(host.updates.deltasDir, join(dir, 'backup-deltas-dir'));
    await symlink(outsideDeltas, host.updates.deltasDir);

    const delSymlinkDeltas = await fetch(`${origin}/admin/api/updates/windows/${pubW2.release.id}`, {
      method: 'DELETE', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
    });
    assert.equal(delSymlinkDeltas.status, 403);
    assert.equal(existsSync(join(outsideDeltas, deltaName)), true);

    await rm(host.updates.deltasDir, { force: true });
    await rename(join(dir, 'backup-deltas-dir'), host.updates.deltasDir);

    // Leaf symlink on DELETE preserves outsideSecret
    assert.equal((await fetch(`${origin}/admin/api/updates/upload?platform=ios&filename=leaf-sym.ipa`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: randomBytes(512),
    })).status, 201);
    const pubIosLeaf = await (await fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'ios', filename: 'leaf-sym.ipa', version: '1.0.0' }),
    })).json();
    const leafPath = join(host.updates.artifactsDir, 'ios', 'leaf-sym.ipa');
    await rm(leafPath, { force: true });
    await symlink(outsideSecret, leafPath);

    const delLeaf = await fetch(`${origin}/admin/api/updates/ios/${pubIosLeaf.release.id}`, {
      method: 'DELETE', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
    });
    assert.equal(delLeaf.status, 200);
    assert.equal(existsSync(outsideSecret), true);
  }

  // 2. handleUpload must check assertSafeDirectory(artifactsDir) BEFORE mkdir(platformDir)
  {
    const { dir, host, origin, adminCookie } = await startHostFixture(t);
    const outsideArtifacts = join(dir, 'outside-artifacts-root');
    await mkdir(outsideArtifacts, { recursive: true });
    await rename(host.updates.artifactsDir, join(dir, 'backup-artifacts-root'));
    await symlink(outsideArtifacts, host.updates.artifactsDir);

    const uploadSymlinkRoot = await fetch(`${origin}/admin/api/updates/upload?platform=android&filename=pre-mkdir.apk`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: randomBytes(256),
    });
    assert.equal(uploadSymlinkRoot.status, 403);
    assert.equal(existsSync(join(outsideArtifacts, 'android')), false);
  }

  // 3. Case-variant active re-upload returns 409 and preserves original bytes/SHA-256
  // 4. Tokenized /updates/ios/:token/altstore.json emits 200 downloadURLs when publicIosFeed is true or false
  {
    const { origin, adminCookie, deviceToken } = await startHostFixture(t);

    const setupExe = randomBytes(1024);
    const asarOrig = makeAsarBuffer({ files: { 'a.js': { size: 5, offset: '0' } } }, Buffer.from('ASAR-CASE'));
    assert.equal((await fetch(`${origin}/admin/api/updates/upload?platform=windows&filename=Setup.exe`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: setupExe,
    })).status, 201);
    assert.equal((await fetch(`${origin}/admin/api/updates/upload?platform=windows&filename=app-1.0.asar`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: asarOrig,
    })).status, 201);
    assert.equal((await fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'windows',
        filename: 'Setup.exe',
        asarFilename: 'app-1.0.asar',
        version: '1.0.0',
      }),
    })).status, 201);

    const caseExeRes = await fetch(`${origin}/admin/api/updates/upload?platform=windows&filename=setup.exe`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: randomBytes(2048),
    });
    assert.equal(caseExeRes.status, 409);

    const caseAsarRes = await fetch(`${origin}/admin/api/updates/upload?platform=windows&filename=APP-1.0.ASAR`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: randomBytes(2048),
    });
    assert.equal(caseAsarRes.status, 409);

    const dlSetup = await fetch(`${origin}/local/updates/files/windows/Setup.exe`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    assert.equal(dlSetup.status, 200);
    assert.equal(dlSetup.headers.get('etag'), `"sha256:${sha256(setupExe)}"`);
    assert.ok(Buffer.from(await dlSetup.arrayBuffer()).equals(setupExe));

    const dlAsar = await fetch(`${origin}/local/updates/files/windows/app-1.0.asar`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    assert.equal(dlAsar.status, 200);
    assert.ok(Buffer.from(await dlAsar.arrayBuffer()).equals(asarOrig));

    // Legacy desktop clients configured with .../macos.json or .../windows.json must still resolve the feed.
    const directFeed = await fetch(`${origin}/local/updates/win32-x64.json`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    assert.equal(directFeed.status, 200);
    const legacyNestedFeed = await fetch(`${origin}/local/updates/windows.json/win32-x64.json`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    assert.equal(legacyNestedFeed.status, 200);
    assert.equal((await legacyNestedFeed.json()).version, '1.0.0');

    // iOS tokenized altstore.json + public altstore.json
    const ipa1 = randomBytes(1024);
    const ipa2 = randomBytes(1536);
    await fetch(`${origin}/admin/api/updates/upload?platform=ios&filename=RokBot-1.15.0.ipa`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: ipa1,
    });
    const pub1 = await (await fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'ios', filename: 'RokBot-1.15.0.ipa', version: '1.15.0', build: '680', bundleId: 'dev.rokbot.local' }),
    })).json();
    await fetch(`${origin}/admin/api/updates/upload?platform=ios&filename=RokBot-1.16.0.ipa`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' }, body: ipa2,
    });
    await fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'ios', filename: 'RokBot-1.16.0.ipa', version: '1.16.0', build: '694', bundleId: 'dev.rokbot.local' }),
    });

    await fetch(`${origin}/admin/api/updates/settings`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ publicIosFeed: true }),
    });

    const token1AltRes = await fetch(pub1.release.installMethods.altStoreSourceUrl);
    assert.equal(token1AltRes.status, 200);
    const token1Alt = await token1AltRes.json();
    assert.ok(token1Alt.apps[0].versions.length >= 1);
    for (const ver of token1Alt.apps[0].versions) {
      const dl = await fetch(ver.downloadURL);
      assert.equal(dl.status, 200, `Expected 200 for tokenized AltStore URL ${ver.downloadURL}`);
      const bytes = Buffer.from(await dl.arrayBuffer());
      assert.ok(bytes.equals(ipa1));
    }

    const publicAltRes = await fetch(`${origin}/updates/ios/public/altstore.json`);
    assert.equal(publicAltRes.status, 200);
    const publicAlt = await publicAltRes.json();
    assert.equal(publicAlt.apps[0].versions.length, 2);
    for (const ver of publicAlt.apps[0].versions) {
      const dl = await fetch(ver.downloadURL);
      assert.equal(dl.status, 200, `Expected 200 for public AltStore URL ${ver.downloadURL}`);
    }

    await fetch(`${origin}/admin/api/updates/settings`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ publicIosFeed: false }),
    });
    assert.equal((await fetch(`${origin}/updates/ios/public/altstore.json`)).status, 403);
    const token1AfterDisable = await fetch(pub1.release.installMethods.altStoreSourceUrl);
    assert.equal(token1AfterDisable.status, 200);
    const token1AfterJson = await token1AfterDisable.json();
    assert.equal((await fetch(token1AfterJson.apps[0].versions[0].downloadURL)).status, 200);
  }
});

test('createRbdelta1Buffer linear PK scan and non-blocking worker offload during Android publish', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  // 1. Verify O(N) PK_LOCAL_HEADER tracking handles scattered headers across unmatched regions cleanly
  {
    const { createRbdelta1Buffer } = await import('../server/updates.mjs');
    const prefix = randomBytes(512 * 1024);
    const suffix = randomBytes(512 * 1024);
    const base = Buffer.concat([prefix, randomBytes(128 * 1024), suffix]);
    const diff = randomBytes(1024 * 1024);
    for (const offset of [0, 3, 61, 64, 129, 4095, 65536, 512 * 1024 + 7]) {
      diff.set([0x50, 0x4b, 0x03, 0x04], offset);
    }
    const target = Buffer.concat([prefix, diff, suffix]);

    const t0 = performance.now();
    const delta = createRbdelta1Buffer(base, target);
    const elapsedMs = performance.now() - t0;

    assert.ok(elapsedMs < 3000, `Expected createRbdelta1Buffer to finish well under 3s, took ${elapsedMs.toFixed(1)}ms`);
    assert.ok(applyAndroidDelta(base, delta).equals(target));
  }

  // 2. Verify /healthz remains responsive while publish() generates an Android RBDELTA1 patch in worker_threads
  {
    const { origin, adminCookie, deviceToken } = await startHostFixture(t);
    const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
    const sharedLib = randomBytes(2 * 1024 * 1024);
    const apkV1 = signApk(
      writeZip([
        createEntry('classes.dex', randomBytes(256 * 1024)),
        createEntry('lib/arm64-v8a/librokbot.so', sharedLib, { store: true }),
      ]),
      identity,
    );
    const apkV2 = signApk(
      writeZip([
        createEntry('classes.dex', randomBytes(3 * 1024 * 1024)),
        createEntry('lib/arm64-v8a/librokbot.so', sharedLib, { store: true }),
      ]),
      identity,
    );

    const upload = async (filename, body) => {
      const res = await fetch(`${origin}/admin/api/updates/upload?platform=android&filename=${encodeURIComponent(filename)}`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
        body,
      });
      assert.equal(res.status, 201);
      return res.json();
    };

    await upload('RokBot-worker-v1.apk', apkV1);
    const pub1 = await (await fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'android',
        filename: 'RokBot-worker-v1.apk',
        packageName: 'dev.rokbot.nativeapp',
        versionName: '1.0.0',
        versionCode: 100,
      }),
    })).json();

    await upload('RokBot-worker-v2.apk', apkV2);

    let publishDone = false;
    const healthChecks = [];
    const publishPromise = fetch(`${origin}/admin/api/updates/publish`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'android',
        filename: 'RokBot-worker-v2.apk',
        packageName: 'dev.rokbot.nativeapp',
        versionName: '2.0.0',
        versionCode: 200,
        generateDeltaFrom: pub1.release.id,
      }),
    }).then(async res => {
      publishDone = true;
      return { status: res.status, json: await res.json() };
    });

    while (!publishDone) {
      const start = performance.now();
      const res = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
      const body = await res.json();
      healthChecks.push({
        status: res.status,
        ok: body.ok,
        ms: performance.now() - start,
        duringPublish: !publishDone,
      });
      if (!publishDone) await new Promise(resolve => setTimeout(resolve, 5));
    }

    const pub2 = await publishPromise;
    assert.equal(pub2.status, 201);
    assert.equal(pub2.json.release.deltas.length, 1);
    assert.ok(healthChecks.length >= 1);
    assert.ok(healthChecks.some(c => c.duringPublish), 'Expected at least one /healthz to complete before publish() resolved');
    for (const checkRes of healthChecks) {
      assert.equal(checkRes.status, 200);
      assert.equal(checkRes.ok, true);
      assert.ok(checkRes.ms < 500, `Expected /healthz to remain fast during publish, took ${checkRes.ms.toFixed(1)}ms`);
    }

    const manifest = await (await fetch(`${origin}/local/updates/android.json`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })).json();
    const deltaRes = await fetch(manifest.deltas[0].url, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    assert.equal(deltaRes.status, 200);
    const deltaBuf = Buffer.from(await deltaRes.arrayBuffer());
    assert.ok(applyAndroidDelta(apkV1, deltaBuf).equals(apkV2));
  }
});

test('Update proxy self-target: old Apps fetching the Host public /local/updates/* URL via /local/updates/fetch get manifest, APK and delta in-process', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const publicUrl = 'https://rokbot-public.invalid';
  const { origin, adminCookie, deviceToken } = await startHostFixture(t, { publicUrl });
  const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
  const shared = randomBytes(64 * 1024);
  const mk = fill => signApk(writeZip([
    createEntry('classes.dex', Buffer.alloc(8 * 1024 + fill, fill)),
    createEntry('lib/arm64-v8a/librokbot.so', shared, { store: true }),
  ]), identity);
  const apkV1 = mk(1);
  const apkV2 = mk(2);
  const admin = { cookie: adminCookie, 'x-rokbot-csrf': '1' };
  for (const [name, buf] of [['RokBot-a.apk', apkV1], ['RokBot-b.apk', apkV2]]) {
    const up = await fetch(`${origin}/admin/api/updates/upload?platform=android&filename=${name}`, { method: 'POST', headers: admin, body: buf });
    assert.equal(up.status, 201);
  }
  const pub = async body => (await fetch(`${origin}/admin/api/updates/publish`, {
    method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const p1 = await pub({ platform: 'android', filename: 'RokBot-a.apk', packageName: 'dev.rokbot.local', versionName: '1.0.0', versionCode: 100 });
  await pub({ platform: 'android', filename: 'RokBot-b.apk', packageName: 'dev.rokbot.local', versionName: '1.0.1', versionCode: 101, generateDeltaFrom: p1.release.id });

  const viaProxy = (target, auth = true) => fetch(`${origin}/local/updates/fetch?url=${encodeURIComponent(target)}`, {
    headers: auth ? { authorization: `Bearer ${deviceToken}` } : {},
  });

  assert.equal((await viaProxy(`${publicUrl}/local/updates/android.json`, false)).status, 401);

  const manifestRes = await viaProxy(`${publicUrl}/local/updates/android.json`);
  assert.equal(manifestRes.status, 200);
  const manifest = await manifestRes.json();
  assert.equal(manifest.versionCode, 101);
  assert.equal(manifest.url, `${publicUrl}/local/updates/files/android/RokBot-b.apk`);
  assert.equal(manifest.deltas.length, 1);
  assert.ok(manifest.deltas[0].url.startsWith(`${publicUrl}/local/updates/files/android/`));

  const apkRes = await viaProxy(manifest.url);
  assert.equal(apkRes.status, 200);
  const apkBuf = Buffer.from(await apkRes.arrayBuffer());
  assert.equal(sha256(apkBuf), manifest.sha256);

  const deltaRes = await viaProxy(manifest.deltas[0].url);
  assert.equal(deltaRes.status, 200);
  const deltaBuf = Buffer.from(await deltaRes.arrayBuffer());
  assert.equal(sha256(deltaBuf), manifest.deltas[0].sha256);
  assert.ok(applyAndroidDelta(apkV1, deltaBuf).equals(apkV2));

  // Direct route behaviour is unchanged.
  const direct = await fetch(`${origin}/local/updates/android.json`, { headers: { authorization: `Bearer ${deviceToken}` } });
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).url, `${origin}/local/updates/files/android/RokBot-b.apk`);
  assert.equal((await fetch(`${origin}/local/updates/android.json`)).status, 401);
});

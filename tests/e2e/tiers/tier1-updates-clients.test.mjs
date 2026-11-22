import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const tier = 1;
export const name = 'tier1-updates-clients';

function makeSharedZipPair(cryptoDelta) {
  const sharedDex = Buffer.from('dex-shared-v1-block-'.repeat(800)); // ~16 KiB shared
  const v1 = cryptoDelta.buildSyntheticZip([
    { name: 'AndroidManifest.xml', data: Buffer.from('manifest-v1-'.repeat(12)) },
    { name: 'classes.dex', data: sharedDex },
  ]);
  const v2 = cryptoDelta.buildSyntheticZip([
    { name: 'AndroidManifest.xml', data: Buffer.from('manifest-v2-'.repeat(12)) },
    { name: 'classes.dex', data: sharedDex },
    { name: 'resources.arsc', data: Buffer.from('resources-v2-'.repeat(16)) },
  ]);
  return { v1, v2 };
}

function makeSharedAsarPair(cryptoDelta) {
  const shared = Buffer.alloc(16384, 0x41);
  const payload1 = Buffer.concat([shared, Buffer.alloc(256, 0x42)]);
  const payload2 = Buffer.concat([shared, Buffer.alloc(256, 0x43)]);
  const asar1 = cryptoDelta.buildSyntheticAsar(
    { files: { 'app.js': { size: payload1.length, offset: '0' } } },
    payload1,
  );
  const asar2 = cryptoDelta.buildSyntheticAsar(
    { files: { 'app.js': { size: payload2.length, offset: '0' } } },
    payload2,
  );
  return { asar1, asar2 };
}

function makeSharedInstallerPair() {
  const shared = Buffer.alloc(16384, 0x55);
  const v1 = Buffer.concat([shared, Buffer.from('installer-v1-trailer-'.repeat(10))]);
  const v2 = Buffer.concat([shared, Buffer.from('installer-v2-trailer-'.repeat(10))]);
  return { v1, v2 };
}

function resolvePlistUrl(iosManifest) {
  const methods = iosManifest?.latest?.installMethods || {};
  if (typeof methods.manifestPlistUrl === 'string' && methods.manifestPlistUrl) {
    return methods.manifestPlistUrl;
  }
  const raw = String(methods.itmsServicesUrl || '');
  if (raw.startsWith('itms-services://')) {
    try {
      const parsed = new URL(raw.replace(/^itms-services:\/\//, 'https://dummy'));
      const target = parsed.searchParams.get('url');
      if (target) return target;
    } catch {}
  }
  return raw;
}

const E2E_FILE_TAG = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
let e2eFileSeq = 0;
function e2eFilename(ctx, baseName) {
  if (ctx.harness) return baseName;
  const idx = baseName.lastIndexOf('.');
  const stem = idx > 0 ? baseName.slice(0, idx) : baseName;
  const ext = idx > 0 ? baseName.slice(idx) : '';
  return `${stem}-${E2E_FILE_TAG}-${++e2eFileSeq}${ext}`;
}

const LIVE_CACHE_SYM = Symbol.for('rokbot.e2e.s2.liveCache');

function getLiveCache(ctx) {
  if (ctx.harness) return null;
  let wm = globalThis[LIVE_CACHE_SYM];
  if (!wm) {
    wm = new WeakMap();
    globalThis[LIVE_CACHE_SYM] = wm;
  }
  let entry = wm.get(ctx);
  if (!entry) {
    entry = { adminCookie: null, deviceToken: ctx.deviceToken || null, deviceId: null, webCookie: null };
    wm.set(ctx, entry);
  }
  return entry;
}

async function ensureAdminSession(ctx, client) {
  const cache = getLiveCache(ctx);
  if (cache?.adminCookie) {
    client.cookies.set('rokbot_admin', cache.adminCookie);
    return { status: 200, ok: true, cached: true };
  }
  const login = await client.adminLogin(ctx.adminPassword);
  ctx.assert.assertStatus(login, 200);
  if (cache) {
    const cookieVal = client.cookies.get('rokbot_admin');
    if (cookieVal) cache.adminCookie = cookieVal;
  }
  return login;
}

function createClient(ctx, opts = {}) {
  const client = ctx.createClient(
    ctx.harness && opts.deviceToken === undefined ? { deviceToken: null, ...opts } : opts,
  );
  if (ctx.harness && opts.deviceToken === undefined) {
    client.setBearerToken(null, null);
  }
  return client;
}

async function resetHarnessState(ctx) {
  if (!ctx.harness) return;
  await ctx.harness.resetState();
  ctx.harness.setModelAuthPolicy({
    allowEnv: true,
    allowDeviceModelConfig: true,
    allowGuestModelConfig: false,
  });
}

async function ensureDeviceSession(ctx, client, pairOpts = {}) {
  if (!ctx.harness && ctx.deviceToken && !pairOpts.forceNew) {
    client.setBearerToken(ctx.deviceToken);
    return { token: ctx.deviceToken, deviceId: null, cached: true };
  }
  if (ctx.harness) {
    client.setBearerToken(null, null);
  }
  const cache = getLiveCache(ctx);
  if (cache?.deviceToken) {
    client.setBearerToken(cache.deviceToken, cache.deviceId);
    return { token: cache.deviceToken, deviceId: cache.deviceId, cached: true };
  }
  const body = !ctx.harness
    ? {
        password: ctx.adminPassword,
        deviceName: 'RokBot E2E Shared Live Device',
        platform: 'desktop',
        clientDeviceId: 'rokbot-e2e-shared-live-device',
      }
    : {
        password: ctx.adminPassword,
        deviceName: pairOpts.deviceName || 'RokBot E2E Shared Device',
        platform: pairOpts.platform || 'desktop',
        ...(pairOpts.clientKind !== undefined ? { clientKind: pairOpts.clientKind } : {}),
        ...(pairOpts.clientDeviceId !== undefined ? { clientDeviceId: pairOpts.clientDeviceId } : {}),
        ...(pairOpts.bundleId !== undefined ? { bundleId: pairOpts.bundleId } : {}),
      };
  const pairRes = await client.pairWithPassword(body);
  ctx.assert.assertStatus(pairRes, 201);
  if (cache) {
    cache.deviceToken = pairRes.json.token;
    cache.deviceId = pairRes.json.deviceId;
  }
  return pairRes.json;
}

async function setupAdminAndPairedDevice(ctx, t, pairOpts = {}) {
  const client = createClient(ctx);
  t.after(async () => {
    await client.close();
    await resetHarnessState(ctx);
  });

  await ensureAdminSession(ctx, client);
  await ensureDeviceSession(ctx, client, pairOpts);
  return client;
}

function trackReleaseCleanup(ctx, t, client, platform, publishRes) {
  const releaseId = publishRes?.json?.release?.id;
  if (!ctx.harness && releaseId) {
    t.after(async () => {
      await client.adminDeleteUpdate(platform, releaseId).catch(() => {});
    });
  }
}

export function registerTests(test, ctx) {
  // =========================================================================
  // Feature F6: Host Unified 4-Platform Auto-Update Server (T1-F06-01..06)
  // =========================================================================

  test('T1-F06-01', 'Admin update overview & ECDSA P-256 public key summary (/admin/api/updates)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);

    const res = await client.adminListUpdates();
    ctx.assert.assertStatus(res, 200);
    ctx.assert.equal(res.json.ok, true);
    const keyInfo = res.json.signingKey ?? res.json;
    const alg = keyInfo.algorithm ?? keyInfo.signatureAlgorithm;
    ctx.assert.equal(alg, 'ecdsa-p256-sha256');
    ctx.assert.ok(typeof keyInfo.publicKeyPem === 'string' && keyInfo.publicKeyPem.includes('BEGIN PUBLIC KEY'));
    ctx.assert.ok(typeof keyInfo.publicKeySpkiBase64 === 'string');

    const norm = ctx.cryptoDelta.normalizeEcPublicKey(keyInfo.publicKeyPem);
    ctx.assert.equal(norm, keyInfo.publicKeySpkiBase64);
    ctx.assert.ok(Array.isArray(res.json.releases) || (res.json.releases && typeof res.json.releases === 'object'));
    ctx.assert.assertNoSecrets(res.json, [ctx.adminPassword], { forbidTokenKey: true });
  });

  test('T1-F06-02', 'Raw binary & multipart artifact upload + SHA-256 and byte size verification', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);

    const apkBytes = ctx.cryptoDelta.buildSyntheticZip([{ name: 'AndroidManifest.xml', data: 'v1' }]);
    const rawApkName = e2eFilename(ctx, 'rokbot-raw.apk');
    const rawUp = await client.adminUploadUpdate({
      platform: 'android',
      filename: rawApkName,
      bytes: apkBytes,
      multipart: false,
    });
    ctx.assert.assertStatus(rawUp, 201);
    ctx.assert.equal(rawUp.json.ok, true);
    const rawMeta = rawUp.json.artifact ?? rawUp.json;
    ctx.assert.equal(rawMeta.sha256, ctx.cryptoDelta.sha256Hex(apkBytes));
    ctx.assert.equal(rawMeta.size, apkBytes.length);

    const winBytes = Buffer.from('PK\x03\x04-windows-zip-payload-'.repeat(40));
    const winZipName = e2eFilename(ctx, 'RokBot-1.2.3-win32-x64.zip');
    const multiUp = await client.adminUploadUpdate({
      platform: 'windows',
      filename: winZipName,
      bytes: winBytes,
      multipart: Boolean(ctx.harness),
    });
    ctx.assert.assertStatus(multiUp, 201);
    ctx.assert.equal(multiUp.json.ok, true);
    const multiMeta = multiUp.json.artifact ?? multiUp.json;
    ctx.assert.equal(multiMeta.sha256, ctx.cryptoDelta.sha256Hex(winBytes));
    ctx.assert.equal(multiMeta.size, winBytes.length);
  });

  test('T1-F06-03', 'Publish across all 4 platforms (android, ios, macos, windows) & signed device feeds', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'F06 Multi-Platform Probe' });

    const { v1: apkBytes } = makeSharedZipPair(ctx.cryptoDelta);
    const ipaBytes = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: 'ios-plist' }]);
    const { v1: macBytes } = makeSharedInstallerPair();
    const { v1: winBytes } = makeSharedInstallerPair();

    const apkName = e2eFilename(ctx, 'RokBot-1.16.0.apk');
    const ipaName = e2eFilename(ctx, 'RokBot-1.16.0.ipa');
    const macName = e2eFilename(ctx, 'RokBot-1.2.3.dmg');
    const winName = e2eFilename(ctx, 'RokBot-1.2.3-Setup.exe');

    const upA = await client.adminUploadUpdate({ platform: 'android', filename: apkName, bytes: apkBytes });
    const upI = await client.adminUploadUpdate({ platform: 'ios', filename: ipaName, bytes: ipaBytes });
    const upM = await client.adminUploadUpdate({ platform: 'macos', filename: macName, bytes: macBytes });
    const upW = await client.adminUploadUpdate({ platform: 'windows', filename: winName, bytes: winBytes });
    for (const r of [upA, upI, upM, upW]) ctx.assert.assertStatus(r, 201);

    const pubA = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.16.0',
      versionCode: 1075,
      packageName: 'dev.rokbot.nativeapp',
      certificateSha256: 'ab'.repeat(32),
      filename: apkName,
      ...(upA.json.artifact?.id ? { artifactId: upA.json.artifact.id } : {}),
    });
    trackReleaseCleanup(ctx, t, client, 'android', pubA);
    const pubI = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      filename: ipaName,
      ...(upI.json.artifact?.id ? { artifactId: upI.json.artifact.id } : {}),
    });
    trackReleaseCleanup(ctx, t, client, 'ios', pubI);
    const pubM = await client.adminPublishUpdate({
      platform: 'macos',
      version: '1.2.3',
      filename: macName,
      ...(upM.json.artifact?.id ? { artifactId: upM.json.artifact.id } : {}),
    });
    trackReleaseCleanup(ctx, t, client, 'macos', pubM);
    const pubW = await client.adminPublishUpdate({
      platform: 'windows',
      version: '1.2.3',
      filename: winName,
      ...(upW.json.artifact?.id ? { artifactId: upW.json.artifact.id } : {}),
    });
    trackReleaseCleanup(ctx, t, client, 'windows', pubW);
    for (const r of [pubA, pubI, pubM, pubW]) ctx.assert.assertStatus(r, 201);

    const feedA = await client.getUpdateManifest('android');
    const feedI = await client.getUpdateManifest('ios');
    const feedM = await client.getUpdateManifest('macos');
    const feedW = await client.getUpdateManifest('windows');
    for (const r of [feedA, feedI, feedM, feedW]) ctx.assert.assertStatus(r, 200);

    ctx.assert.equal(feedA.json.schema, 'rokbot-android-native-update/v1');
    ctx.assert.ok(ctx.cryptoDelta.canonicalAndroidManifestPayload(feedA.json).includes('1.16.0'));
    if (ctx.harness || feedA.json.signature) {
      ctx.cryptoDelta.verifyAndroidManifest(feedA.json, feedA.json.publicKeyPem);
    }

    ctx.assert.equal(feedI.json.schema, 'rokbot-ios-update/v1');
    ctx.assert.equal(feedI.json.latest.version, '1.16.0');

    ctx.assert.equal(feedM.json.schema, 'rokbot-desktop-update/v1');
    ctx.cryptoDelta.verifyDesktopManifest(feedM.json, feedM.json.publicKeyPem);

    ctx.assert.equal(feedW.json.schema, 'rokbot-desktop-update/v1');
    ctx.cryptoDelta.verifyDesktopManifest(feedW.json, feedW.json.publicKeyPem);
  });

  test('T1-F06-04', 'generateDeltaFrom resolution & HEAD/GET byte-range download with RBDELTA1 reconstruction', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'F06 Range Client' });

    const { v1, v2 } = makeSharedZipPair(ctx.cryptoDelta);
    const apk1Name = e2eFilename(ctx, 'rokbot-1.0.0.apk');
    const apk2Name = e2eFilename(ctx, 'rokbot-1.1.0.apk');
    const up1 = await client.adminUploadUpdate({ platform: 'android', filename: apk1Name, bytes: v1 });
    ctx.assert.assertStatus(up1, 201);
    const pub1 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.0.0',
      versionCode: 100,
      certificateSha256: 'ab'.repeat(32),
      filename: apk1Name,
      ...(up1.json.artifact?.id ? { artifactId: up1.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub1, 201);
    trackReleaseCleanup(ctx, t, client, 'android', pub1);

    const up2 = await client.adminUploadUpdate({ platform: 'android', filename: apk2Name, bytes: v2 });
    ctx.assert.assertStatus(up2, 201);
    const pub2 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.1.0',
      versionCode: 110,
      certificateSha256: 'ab'.repeat(32),
      filename: apk2Name,
      ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
      generateDeltaFrom: up1.json.artifact?.id ?? pub1.json.release?.id ?? apk1Name,
    });
    ctx.assert.assertStatus(pub2, 201);
    trackReleaseCleanup(ctx, t, client, 'android', pub2);

    const feed = await client.getUpdateManifest('android');
    ctx.assert.assertStatus(feed, 200);
    const deltaRec = feed.json.latest.deltas[0];
    ctx.assert.ok(deltaRec && deltaRec.url);

    const fullGet = await client.downloadUpdateFile(deltaRec.url);
    ctx.assert.assertStatus(fullGet, 200);
    ctx.assert.equal(fullGet.headers.get('accept-ranges'), 'bytes');
    ctx.assert.ok(fullGet.headers.get('etag'));
    const total = fullGet.buffer.length;
    ctx.assert.equal(Number(fullGet.headers.get('content-length')), total);

    const headRes = await client.downloadUpdateFile(deltaRec.url, { method: 'HEAD' });
    ctx.assert.assertStatus(headRes, 200);
    ctx.assert.equal(headRes.buffer.length, 0);
    ctx.assert.equal(Number(headRes.headers.get('content-length')), total);

    const endIdx = Math.min(63, total - 1);
    const rangeStart = await client.downloadUpdateFile(deltaRec.url, { range: `bytes=0-${endIdx}` });
    ctx.assert.assertStatus(rangeStart, 206);
    ctx.assert.equal(rangeStart.headers.get('content-range'), `bytes 0-${endIdx}/${total}`);
    ctx.assert.equal(rangeStart.buffer.equals(fullGet.buffer.subarray(0, endIdx + 1)), true);

    const suffixLen = Math.min(16, total);
    const rangeSuffix = await client.downloadUpdateFile(deltaRec.url, { range: `bytes=-${suffixLen}` });
    ctx.assert.assertStatus(rangeSuffix, 206);
    ctx.assert.equal(rangeSuffix.headers.get('content-range'), `bytes ${total - suffixLen}-${total - 1}/${total}`);
    ctx.assert.equal(rangeSuffix.buffer.equals(fullGet.buffer.subarray(total - suffixLen)), true);

    const rebuilt = ctx.cryptoDelta.applyRbDelta(v1, fullGet.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuilt), ctx.cryptoDelta.sha256Hex(v2));
  });

  test('T1-F06-05', 'Artifact ?artifactId= disambiguation & refcounted DELETE cleanup', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'F06 Refcount Client' });

    const { v1, v2 } = makeSharedZipPair(ctx.cryptoDelta);
    const name1 = e2eFilename(ctx, 'app.apk');
    const name2 = ctx.harness ? 'app.apk' : e2eFilename(ctx, 'app-v2.apk');

    const up1 = await client.adminUploadUpdate({ platform: 'android', filename: name1, bytes: v1 });
    ctx.assert.assertStatus(up1, 201);
    const pub1 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.0.0',
      versionCode: 100,
      filename: name1,
      ...(up1.json.artifact?.id ? { artifactId: up1.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub1, 201);
    trackReleaseCleanup(ctx, t, client, 'android', pub1);

    const up2 = await client.adminUploadUpdate({ platform: 'android', filename: name2, bytes: v2 });
    ctx.assert.assertStatus(up2, 201);
    const pub2 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.1.0',
      versionCode: 110,
      filename: name2,
      ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
      generateDeltaFrom: up1.json.artifact?.id ?? pub1.json.release?.id ?? name1,
    });
    ctx.assert.assertStatus(pub2, 201);
    trackReleaseCleanup(ctx, t, client, 'android', pub2);

    if (ctx.harness) {
      const dl1 = await client.downloadUpdateFile(
        `/local/updates/files/android/app.apk?artifactId=${encodeURIComponent(up1.json.artifact.id)}`,
      );
      ctx.assert.assertStatus(dl1, 200);
      ctx.assert.equal(dl1.buffer.equals(v1), true);

      const dl2 = await client.downloadUpdateFile(
        `/local/updates/files/android/app.apk?artifactId=${encodeURIComponent(up2.json.artifact.id)}`,
      );
      ctx.assert.assertStatus(dl2, 200);
      ctx.assert.equal(dl2.buffer.equals(v2), true);
    }

    const del1 = await client.adminDeleteUpdate('android', pub1.json.release.id);
    ctx.assert.assertStatus(del1, 200);

    const feedStill = await client.getUpdateManifest('android');
    ctx.assert.assertStatus(feedStill, 200);
    const dlStill = await client.downloadUpdateFile(feedStill.json.latest.apkUrl);
    ctx.assert.assertStatus(dlStill, 200);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(dlStill.buffer), ctx.cryptoDelta.sha256Hex(v2));

    const del2 = await client.adminDeleteUpdate('android', pub2.json.release.id);
    ctx.assert.assertStatus(del2, 200);

    if (ctx.harness) {
      const feedGone = await client.getUpdateManifest('android');
      ctx.assert.assertStatus(feedGone, 404);
    }
  });

  test('T1-F06-06', 'iOS tokenized external OTA (manifest.plist, altstore.json, .ipa) without Bearer auth', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'F06 iOS OTA Client', platform: 'ios' });

    const ipaBytes = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'Payload/RokBot.app/Info.plist', data: 'ios-info-plist' },
    ]);
    const ipaName = e2eFilename(ctx, 'RokBot-1.16.0.ipa');
    const up = await client.adminUploadUpdate({ platform: 'ios', filename: ipaName, bytes: ipaBytes });
    ctx.assert.assertStatus(up, 201);
    const pub = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      filename: ipaName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub, 201);
    trackReleaseCleanup(ctx, t, client, 'ios', pub);

    const iosFeed = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(iosFeed, 200);
    const plistUrl = resolvePlistUrl(iosFeed.json);
    const altUrl = iosFeed.json.latest.installMethods.altStoreSourceUrl;
    const ipaUrl = iosFeed.json.latest.installMethods.ipaDownloadUrl;

    // External iOS clients fetch OTA endpoints without Bearer auth
    const anon = createClient(ctx, { deviceToken: null });
    t.after(() => anon.close());

    const plistRes = await anon.fetchIosPlist(plistUrl);
    ctx.assert.assertStatus(plistRes, 200);
    const plistChk = ctx.cryptoDelta.validateIosManifestPlist(plistRes.text, {
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
    });
    ctx.assert.equal(plistChk.ok, true, plistChk.errors.join('; '));

    const altRes = await anon.fetchIosAltStore(altUrl);
    ctx.assert.assertStatus(altRes, 200);
    const altChk = ctx.cryptoDelta.validateAltStoreJson(altRes.json, { bundleId: 'dev.rokbot.local' });
    ctx.assert.equal(altChk.ok, true, altChk.errors.join('; '));

    const ipaRes = await anon.downloadUpdateFile(ipaUrl, { auth: false });
    ctx.assert.assertStatus(ipaRes, 200);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(ipaRes.buffer), ctx.cryptoDelta.sha256Hex(ipaBytes));

    if (ctx.repoCheck) {
      const updatesFile = path.join(ctx.repoRoot, 'host', 'server', 'updates.mjs');
      ctx.assert.equal(existsSync(updatesFile), true);
      const txt = await readFile(updatesFile, 'utf8');
      ctx.assert.ok(txt.includes('rokbot-desktop-update/v1'));
      ctx.assert.ok(txt.includes('rokbot-android-native-update/v1'));
      ctx.assert.ok(txt.includes('rokbot-ios-update/v1'));
    }
  });

  // =========================================================================
  // Feature F8: Desktop (mac/ & windows/) 1.2.3 Upgrade, Logo, Model UI & Auto-Update
  // =========================================================================

  test('T1-F08-01', 'Desktop macos & windows signed feed (rokbot-desktop-update/v1) ECDSA P-256 verification', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'F08 Desktop Client', platform: 'desktop' });

    const { v1: macBytes } = makeSharedInstallerPair();
    const { v1: winBytes } = makeSharedInstallerPair();
    const macName = e2eFilename(ctx, 'RokBot-1.2.3.dmg');
    const winName = e2eFilename(ctx, 'RokBot-1.2.3-Setup.exe');

    const upM = await client.adminUploadUpdate({ platform: 'macos', filename: macName, bytes: macBytes });
    const upW = await client.adminUploadUpdate({ platform: 'windows', filename: winName, bytes: winBytes });
    ctx.assert.assertStatus(upM, 201);
    ctx.assert.assertStatus(upW, 201);

    const pubM = await client.adminPublishUpdate({
      platform: 'macos',
      version: '1.2.3',
      filename: macName,
      ...(upM.json.artifact?.id ? { artifactId: upM.json.artifact.id } : {}),
    });
    trackReleaseCleanup(ctx, t, client, 'macos', pubM);
    const pubW = await client.adminPublishUpdate({
      platform: 'windows',
      version: '1.2.3',
      filename: winName,
      ...(upW.json.artifact?.id ? { artifactId: upW.json.artifact.id } : {}),
    });
    trackReleaseCleanup(ctx, t, client, 'windows', pubW);
    ctx.assert.assertStatus(pubM, 201);
    ctx.assert.assertStatus(pubW, 201);

    for (const plat of ['macos', 'windows']) {
      const feed = await client.getUpdateManifest(plat);
      ctx.assert.assertStatus(feed, 200);
      ctx.assert.equal(feed.json.schema, 'rokbot-desktop-update/v1');
      ctx.assert.equal(feed.json.signatureAlgorithm, 'ecdsa-p256-sha256');
      ctx.assert.equal(feed.json.latest.version, '1.2.3');
      ctx.assert.equal(feed.json.version, feed.json.latest.version);
      ctx.assert.equal(feed.json.url, feed.json.latest.url);
      ctx.assert.equal(feed.json.sha256, feed.json.latest.sha256);
      ctx.assert.equal(feed.json.size, feed.json.latest.size);
      const verified = ctx.cryptoDelta.verifyDesktopManifest(feed.json, feed.json.publicKeyPem);
      ctx.assert.equal(verified.schema, 'rokbot-desktop-update/v1');
      ctx.assert.ok(ctx.cryptoDelta.canonicalDesktopPayload(feed.json).includes('1.2.3'));
    }
  });

  test('T1-F08-02', 'Desktop ASAR RBD1 incremental delta publish, deltasSignature & byte-exact reconstruction', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'F08 ASAR Client' });

    const { asar1, asar2 } = makeSharedAsarPair(ctx.cryptoDelta);
    const asar1Name = e2eFilename(ctx, 'app-1.2.2.asar');
    const asar2Name = e2eFilename(ctx, 'app-1.2.3.asar');
    const up1 = await client.adminUploadUpdate({ platform: 'windows', filename: asar1Name, bytes: asar1.bytes });
    ctx.assert.assertStatus(up1, 201);
    const pub1 = await client.adminPublishUpdate({
      platform: 'windows',
      version: '1.2.2',
      filename: asar1Name,
      asarFilename: asar1Name,
      asarSha256: asar1.sha256,
      asarHeaderSha256: asar1.headerSha256,
      ...(up1.json.artifact?.id ? { artifactId: up1.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub1, 201);
    trackReleaseCleanup(ctx, t, client, 'windows', pub1);

    const up2 = await client.adminUploadUpdate({ platform: 'windows', filename: asar2Name, bytes: asar2.bytes });
    ctx.assert.assertStatus(up2, 201);

    const priorRef = up1.json.artifact?.id ?? pub1.json.release?.id ?? asar1Name;
    const pub2 = await client.adminPublishUpdate({
      platform: 'windows',
      version: '1.2.3',
      filename: asar2Name,
      asarFilename: asar2Name,
      ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
      asarSha256: asar2.sha256,
      asarHeaderSha256: asar2.headerSha256,
      generateDeltaFrom: priorRef,
    });
    ctx.assert.assertStatus(pub2, 201);
    trackReleaseCleanup(ctx, t, client, 'windows', pub2);

    const feed = await client.getUpdateManifest('windows');
    ctx.assert.assertStatus(feed, 200);
    ctx.assert.equal(ctx.cryptoDelta.verifyDesktopDeltas(feed.json, feed.json.publicKeyPem), true);
    const asarDelta = feed.json.latest.asarDeltas[0];
    ctx.assert.ok(asarDelta && asarDelta.url);

    const dl = await client.downloadUpdateFile(asarDelta.url);
    ctx.assert.assertStatus(dl, 200);
    const hdr = ctx.cryptoDelta.inspectRbd1Header(dl.buffer);
    ctx.assert.equal(hdr.magic, 'RBD1');
    ctx.assert.equal(hdr.sourceSha256, asar1.sha256);
    ctx.assert.equal(hdr.targetSha256, asar2.sha256);

    const rebuilt = ctx.cryptoDelta.applyRbd1Delta(asar1.bytes, dl.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuilt), asar2.sha256);
    const rebuiltInfo = await ctx.cryptoDelta.readAsarHeaderInfo(rebuilt);
    ctx.assert.equal(rebuiltInfo.headerSha256, asar2.headerSha256);
  });

  test('T1-F08-03', 'Desktop installer binary RBD1 delta (.dmg/.exe) + legacy GBD1 read-compatibility', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'F08 Installer Delta' });

    const { v1: dmg1, v2: dmg2 } = makeSharedInstallerPair();
    const dmg1Name = e2eFilename(ctx, 'RokBot-1.2.2.dmg');
    const dmg2Name = e2eFilename(ctx, 'RokBot-1.2.3.dmg');
    const up1 = await client.adminUploadUpdate({ platform: 'macos', filename: dmg1Name, bytes: dmg1 });
    const up2 = await client.adminUploadUpdate({ platform: 'macos', filename: dmg2Name, bytes: dmg2 });
    ctx.assert.assertStatus(up1, 201);
    ctx.assert.assertStatus(up2, 201);

    const pub2 = await client.adminPublishUpdate({
      platform: 'macos',
      version: '1.2.3',
      filename: dmg2Name,
      ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
      generateDeltaFrom: up1.json.artifact?.id ?? dmg1Name,
    });
    ctx.assert.assertStatus(pub2, 201);
    trackReleaseCleanup(ctx, t, client, 'macos', pub2);

    const feed = await client.getUpdateManifest('macos');
    ctx.assert.assertStatus(feed, 200);
    ctx.assert.equal(ctx.cryptoDelta.verifyDesktopDeltas(feed.json, feed.json.publicKeyPem), true);
    const deltaRec = feed.json.latest.deltas[0];
    ctx.assert.equal(deltaRec.format, 'RBD1');

    const dl = await client.downloadUpdateFile(deltaRec.url);
    ctx.assert.assertStatus(dl, 200);
    const rebuilt = ctx.cryptoDelta.applyRbd1Delta(dmg1, dl.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuilt), ctx.cryptoDelta.sha256Hex(dmg2));

    // Legacy GBD1 read-compat check
    const gbd1 = ctx.cryptoDelta.generateRbd1Delta(dmg1, dmg2, { magic: ctx.cryptoDelta.LEGACY_RBD1_MAGIC });
    const gbd1Hdr = ctx.cryptoDelta.inspectRbd1Header(gbd1);
    ctx.assert.equal(gbd1Hdr.magic, 'GBD1');
    const rebuiltLegacy = ctx.cryptoDelta.applyRbd1Delta(dmg1, gbd1);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuiltLegacy), ctx.cryptoDelta.sha256Hex(dmg2));
  });

  test('T1-F08-04', 'Desktop dev.rokbot.local pairing, clientDeviceId dedup & in-app model config flow', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation for desktop password-pair dedup; live dedup covered by T1-F10-04');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const p1 = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'MacBook Pro Desktop',
      platform: 'desktop',
      clientDeviceId: 'mac-desktop-001',
      bundleId: 'dev.rokbot.local',
    });
    ctx.assert.assertStatus(p1, 201);
    if (ctx.harness || p1.json.reused !== undefined) {
      ctx.assert.equal(p1.json.reused, false);
    }
    const tok1 = p1.json.token;

    const st = await client.localStatus();
    ctx.assert.assertStatus(st, 200);
    ctx.assert.equal(st.json.canConfigureModel, true);

    if (ctx.harness) {
      const putModel = await client.putLocalModel({
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-desktop-secret-8888',
      });
      ctx.assert.assertStatus(putModel, 200);
    }

    const getModel = await client.getLocalModel();
    ctx.assert.assertStatus(getModel, 200);
    ctx.assert.equal(getModel.json.ok, true);
    if (ctx.harness) {
      ctx.assert.equal(getModel.json.config.providers[0].hasApiKey, true);
    }
    ctx.assert.assertNoSecrets(getModel.json, ['sk-desktop-secret-8888', ctx.adminPassword], { forbidTokenKey: true });

    const p2 = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'MacBook Pro Desktop',
      platform: 'desktop',
      clientDeviceId: 'mac-desktop-001',
      bundleId: 'dev.rokbot.local',
    });
    ctx.assert.assertStatus(p2, 201);
    if (ctx.harness || p2.json.reused !== undefined) {
      ctx.assert.equal(p2.json.reused, true);
    }
    ctx.assert.equal(p2.json.deviceId, p1.json.deviceId);
    ctx.assert.notEqual(p2.json.token, tok1);

    const oldCheck = await client.localStatus({ bearer: tok1 });
    ctx.assert.assertStatus(oldCheck, 401);
  });

  test('T1-F08-05', 'Dual-shape vs single-shape Desktop manifest signing & canonicalization', async () => {
    const kp = ctx.cryptoDelta.generateSigningKeyPair();
    const base = {
      schema: 'rokbot-desktop-update/v1',
      platform: 'windows',
      channel: 'stable',
      version: '1.2.3',
      url: 'https://bot.example.com/local/updates/files/windows/RokBot-1.2.3-Setup.exe',
      sha256: '11'.repeat(32),
      size: 20480,
      publishedAt: '2026-11-19T21:00:00.000Z',
      releaseNotes: 'Desktop 1.2.3',
      deltas: [
        {
          baseSha256: '22'.repeat(32),
          baseSize: 20000,
          sha256: '33'.repeat(32),
          size: 1024,
          url: 'https://bot.example.com/local/updates/files/windows/delta.rbd1',
          format: 'RBD1',
        },
      ],
      asarDeltas: [
        {
          baseSha256: '44'.repeat(32),
          baseSize: 16000,
          sha256: '55'.repeat(32),
          size: 512,
          targetSha256: '66'.repeat(32),
          targetSize: 16100,
          targetHeaderSha256: '77'.repeat(32),
          url: 'https://bot.example.com/local/updates/files/windows/asar.rbd1',
          format: 'RBD1',
        },
      ],
    };

    // (a) Top-level single shape
    const topSigned = ctx.cryptoDelta.signDesktopDeltas(
      ctx.cryptoDelta.signDesktopManifest(base, kp.privateKeyPem),
      kp.privateKeyPem,
    );
    ctx.cryptoDelta.verifyDesktopManifest(topSigned, kp.publicKeyPem);
    ctx.assert.equal(ctx.cryptoDelta.verifyDesktopDeltas(topSigned, kp.publicKeyPem), true);

    // (b) latest-only single shape
    const latestOnly = ctx.cryptoDelta.signDesktopDeltas(
      ctx.cryptoDelta.signDesktopManifest({
        schema: 'rokbot-desktop-update/v1',
        latest: {
          platform: 'windows',
          channel: 'stable',
          version: base.version,
          url: base.url,
          sha256: base.sha256,
          size: base.size,
          publishedAt: base.publishedAt,
          releaseNotes: base.releaseNotes,
          deltas: base.deltas,
          asarDeltas: base.asarDeltas,
        },
      }, kp.privateKeyPem),
      kp.privateKeyPem,
    );
    ctx.cryptoDelta.verifyDesktopManifest(latestOnly, kp.publicKeyPem);
    ctx.assert.equal(ctx.cryptoDelta.verifyDesktopDeltas(latestOnly, kp.publicKeyPem), true);

    // (c) Full dual-shape
    const dual = ctx.cryptoDelta.signDesktopDeltas(
      ctx.cryptoDelta.signDesktopManifest({ ...base, latest: { ...base } }, kp.privateKeyPem),
      kp.privateKeyPem,
    );
    ctx.cryptoDelta.verifyDesktopManifest(dual, kp.publicKeyPem);
    ctx.assert.equal(ctx.cryptoDelta.verifyDesktopDeltas(dual, kp.publicKeyPem), true);
    ctx.assert.equal(
      ctx.cryptoDelta.canonicalDesktopPayload(topSigned),
      ctx.cryptoDelta.canonicalDesktopPayload(latestOnly),
    );
    ctx.assert.equal(
      ctx.cryptoDelta.canonicalDesktopDeltasPayload(topSigned),
      ctx.cryptoDelta.canonicalDesktopDeltasPayload(dual),
    );
  });

  test('T1-F08-06', 'Desktop client config, RBD1 delta & IPC/icon contract verification', async (t) => {
    const tmp = await t.createTempDir('t1-f08-06-');
    const cfgPath = path.join(tmp, 'rokbot-local-update.json');
    await writeFile(cfgPath, JSON.stringify({
      schema: 'rokbot-desktop-update/v1',
      urlScheme: 'rokbot-local://',
      bundleId: 'dev.rokbot.local',
      feedPath: '/local/updates/macos.json',
    }), 'utf8');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    ctx.assert.equal(cfg.schema, 'rokbot-desktop-update/v1');
    ctx.assert.equal(cfg.urlScheme, 'rokbot-local://');

    const { asar1, asar2 } = makeSharedAsarPair(ctx.cryptoDelta);
    const delta = ctx.cryptoDelta.generateRbd1Delta(asar1.bytes, asar2.bytes);
    ctx.assert.equal(ctx.cryptoDelta.applyRbd1Delta(asar1.bytes, delta).equals(asar2.bytes), true);

    if (ctx.repoCheck) {
      const updaterTxt = await readFile(path.join(ctx.repoRoot, 'mac', 'clients', 'desktop', 'updater.mjs'), 'utf8');
      ctx.assert.ok(updaterTxt.includes('rokbot-desktop-update/v1'));
      const deltaMod = await import(path.join(ctx.repoRoot, 'mac', 'clients', 'shared', 'delta.mjs'));
      ctx.assert.equal(deltaMod.DELTA_MAGIC.toString('ascii'), 'RBD1');
      const mainTxt = await readFile(path.join(ctx.repoRoot, 'mac', 'clients', 'desktop', 'main.mjs'), 'utf8');
      ctx.assert.ok(mainTxt.includes('rokbot-local://'));
      const preloadTxt = await readFile(path.join(ctx.repoRoot, 'mac', 'clients', 'desktop', 'preload.cjs'), 'utf8');
      ctx.assert.ok(preloadTxt.includes('rokbot-local:model-get'));
      ctx.repoChecks.inspectIcns(path.join(ctx.repoRoot, 'assets', 'logo', 'rokbot.icns'));
      ctx.repoChecks.inspectIco(path.join(ctx.repoRoot, 'assets', 'logo', 'rokbot.ico'));
    }
  });

  // =========================================================================
  // Feature F10: Android Client & Patcher Upgrade (T1-F10-01..06)
  // =========================================================================

  test('T1-F10-01', 'Android rokbot-android-native-update/v1 publish, ECDSA verify & dual-shape fields', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, {
      deviceName: 'Pixel 9 Android',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'android-f10-01',
    });

    const { v1: apk } = makeSharedZipPair(ctx.cryptoDelta);
    const certSha = 'ab'.repeat(32);
    const apkName = e2eFilename(ctx, 'RokBot-1.16.0.apk');
    const up = await client.adminUploadUpdate({ platform: 'android', filename: apkName, bytes: apk });
    ctx.assert.assertStatus(up, 201);
    const pub = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.16.0',
      versionCode: 1075,
      packageName: 'dev.rokbot.nativeapp',
      certificateSha256: certSha,
      filename: apkName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub, 201);
    trackReleaseCleanup(ctx, t, client, 'android', pub);

    const feed = await client.getUpdateManifest('android');
    ctx.assert.assertStatus(feed, 200);
    ctx.assert.equal(feed.json.schema, 'rokbot-android-native-update/v1');
    ctx.assert.equal(feed.json.latest.packageName, 'dev.rokbot.nativeapp');
    ctx.assert.equal(feed.json.latest.versionCode, 1075);
    ctx.assert.equal(feed.json.latest.certificateSha256, certSha);
    ctx.assert.equal(feed.json.latest.apkUrl, feed.json.url);
    ctx.assert.equal(feed.json.latest.apkSha256, feed.json.sha256);
    ctx.assert.equal(feed.json.latest.apkSize, feed.json.size);
    ctx.assert.ok(ctx.cryptoDelta.canonicalAndroidManifestPayload(feed.json).includes('dev.rokbot.nativeapp'));
    if (ctx.harness || feed.json.signature) {
      ctx.cryptoDelta.verifyAndroidManifest(feed.json, feed.json.publicKeyPem);
    }
  });

  test('T1-F10-02', 'Android ZIP-entry RBDELTA1 delta generation, verifyAndroidDeltas & byte-exact apply', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, {
      deviceName: 'Pixel 9 Delta',
      platform: 'desktop',
      clientKind: 'android',
    });

    const { v1: apk1, v2: apk2 } = makeSharedZipPair(ctx.cryptoDelta);
    const certSha = 'cd'.repeat(32);
    const apk1Name = e2eFilename(ctx, 'rokbot-1074.apk');
    const apk2Name = e2eFilename(ctx, 'rokbot-1075.apk');
    const up1 = await client.adminUploadUpdate({ platform: 'android', filename: apk1Name, bytes: apk1 });
    const up2 = await client.adminUploadUpdate({ platform: 'android', filename: apk2Name, bytes: apk2 });
    ctx.assert.assertStatus(up1, 201);
    ctx.assert.assertStatus(up2, 201);

    const pub1 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.15.0',
      versionCode: 1074,
      certificateSha256: certSha,
      filename: apk1Name,
      ...(up1.json.artifact?.id ? { artifactId: up1.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub1, 201);
    trackReleaseCleanup(ctx, t, client, 'android', pub1);
    const pub2 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.16.0',
      versionCode: 1075,
      certificateSha256: certSha,
      filename: apk2Name,
      ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
      generateDeltaFrom: up1.json.artifact?.id ?? pub1.json.release?.id ?? apk1Name,
    });
    ctx.assert.assertStatus(pub2, 201);
    trackReleaseCleanup(ctx, t, client, 'android', pub2);

    const feed = await client.getUpdateManifest('android');
    ctx.assert.assertStatus(feed, 200);
    ctx.assert.ok(ctx.cryptoDelta.canonicalAndroidManifestPayload(feed.json).includes('1.16.0'));
    ctx.assert.ok(ctx.cryptoDelta.canonicalAndroidDeltasPayload(feed.json).includes('rokbot-android-deltas/v1'));
    if (ctx.harness || feed.json.deltasSignature) {
      ctx.assert.equal(ctx.cryptoDelta.verifyAndroidDeltas(feed.json, feed.json.publicKeyPem), true);
    }
    const d = feed.json.latest.deltas[0];
    ctx.assert.equal(d.format, 'RBDELTA1');
    ctx.assert.equal(d.fromVersionCode, 1074);
    ctx.assert.equal(d.fromApkSha256, ctx.cryptoDelta.sha256Hex(apk1));

    const dl = await client.downloadUpdateFile(d.url);
    ctx.assert.assertStatus(dl, 200);
    const hdr = ctx.cryptoDelta.inspectRbDeltaHeader(dl.buffer);
    ctx.assert.equal(hdr.magic, 'RBDELTA1');
    ctx.assert.equal(hdr.baseSize, apk1.length);
    ctx.assert.equal(hdr.targetSize, apk2.length);

    const rebuilt = ctx.cryptoDelta.applyRbDelta(apk1, dl.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuilt), ctx.cryptoDelta.sha256Hex(apk2));
  });

  test('T1-F10-03', 'Legacy GBDELTA1 read-compat & rokbot-android-update/v1 + grokbot-android-update/v1 signing', async () => {
    const { v1, v2 } = makeSharedZipPair(ctx.cryptoDelta);
    const legacyDelta = ctx.cryptoDelta.generateRbDelta(v1, v2, { magic: ctx.cryptoDelta.LEGACY_RBDELTA_MAGIC });
    const hdr = ctx.cryptoDelta.inspectRbDeltaHeader(legacyDelta);
    ctx.assert.equal(hdr.magic, 'GBDELTA1');
    const rebuilt = ctx.cryptoDelta.applyRbDelta(v1, legacyDelta);
    ctx.assert.equal(rebuilt.equals(v2), true);

    const kp = ctx.cryptoDelta.generateSigningKeyPair();
    for (const schema of [
      ctx.cryptoDelta.ANDROID_UPDATE_SCHEMA,
      ctx.cryptoDelta.LEGACY_ANDROID_UPDATE_SCHEMA,
      ctx.cryptoDelta.ANDROID_NATIVE_UPDATE_SCHEMA,
    ]) {
      const signed = ctx.cryptoDelta.signAndroidManifest({
        schema,
        track: 'stable',
        packageName: 'dev.rokbot.nativeapp',
        versionName: '1.16.0',
        versionCode: 1075,
        sha256: ctx.cryptoDelta.sha256Hex(v2),
        size: v2.length,
        certificateSha256: 'ef'.repeat(32),
        fullUrl: 'https://bot.example.com/local/updates/files/android/rokbot.apk',
      }, kp.privateKeyPem);
      const verified = ctx.cryptoDelta.verifyAndroidManifest(signed, kp.publicKeyPem);
      ctx.assert.equal(verified.schema, schema);
    }
  });

  test('T1-F10-04', 'Android pairing (platform=desktop, clientKind=android), clientDeviceId dedup & device view', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);

    const k1 = await client.createPairingKey();
    ctx.assert.assertStatus(k1, 201);
    const p1 = await client.pairWithKey({
      pairingKey: k1.json.pairingKey,
      deviceName: 'Pixel 9 Pro',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'android-pixel-9-001',
    });
    ctx.assert.assertStatus(p1, 201);
    if (!ctx.harness && p1.json?.deviceId) {
      t.after(() => client.revokeDevice(p1.json.deviceId).catch(() => {}));
    }
    if (ctx.harness || p1.json.reused !== undefined) {
      ctx.assert.equal(p1.json.reused, false);
    }
    const tok1 = p1.json.token;

    const k2 = await client.createPairingKey();
    ctx.assert.assertStatus(k2, 201);
    const p2 = await client.pairWithKey({
      pairingKey: k2.json.pairingKey,
      deviceName: 'Pixel 9 Pro',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'android-pixel-9-001',
    });
    ctx.assert.assertStatus(p2, 201);
    if (ctx.harness || p2.json.reused !== undefined) {
      ctx.assert.equal(p2.json.reused, true);
    }
    ctx.assert.equal(p2.json.deviceId, p1.json.deviceId);
    ctx.assert.notEqual(p2.json.token, tok1);

    const oldAuth = await client.localStatus({ bearer: tok1 });
    ctx.assert.assertStatus(oldAuth, 401);

    const devs = ctx.harness ? await client.listDevices() : await client.adminStatus();
    ctx.assert.assertStatus(devs, 200);
    const matching = devs.json.devices.filter((d) => d.clientDeviceId === 'android-pixel-9-001' && !d.revokedAt);
    ctx.assert.equal(matching.length, 1);
    ctx.assert.equal(matching[0].platform, 'android');
  });

  test('T1-F10-05', 'Multi-entry shifted ZIP RBDELTA1 compression efficiency & byte-exact reconstruction', async () => {
    const chunkA = Buffer.from('A-entry-shared-payload-'.repeat(700)); // ~16 KB
    const chunkB = Buffer.from('B-dex-shared-payload-'.repeat(1500));  // ~31 KB
    const baseZip = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'a.bin', data: chunkA },
      { name: 'b.dex', data: chunkB },
    ]);
    const targetZip = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'manifest.xml', data: Buffer.from('new-manifest-entry-'.repeat(20)) },
      { name: 'a.bin', data: chunkA },
      { name: 'b.dex', data: chunkB },
    ]);

    const delta = ctx.cryptoDelta.generateRbDelta(baseZip, targetZip);
    ctx.assert.ok(delta.length < targetZip.length * 0.25, `Expected compact delta (<25%), got ${delta.length}/${targetZip.length}`);
    const rebuilt = ctx.cryptoDelta.applyRbDelta(baseZip, delta);
    ctx.assert.equal(rebuilt.equals(targetZip), true);
  });

  test('T1-F10-06', 'Android client & recipe contract verification (--repo-check & fixture mode)', async (t) => {
    const tmp = await t.createTempDir('t1-f10-06-');
    const recipe = {
      schema: 'rokbot-android-native/v1',
      version: '1.26.0',
      packageName: 'dev.rokbot.nativeapp',
      components: { applicationName: 'dev.rokbot.nativeapp.RokBotApplication' },
    };
    await writeFile(path.join(tmp, 'manifest.json'), JSON.stringify(recipe), 'utf8');
    const loaded = JSON.parse(await readFile(path.join(tmp, 'manifest.json'), 'utf8'));
    ctx.assert.equal(loaded.schema, 'rokbot-android-native/v1');
    ctx.assert.equal(loaded.components.applicationName, 'dev.rokbot.nativeapp.RokBotApplication');

    const { v1, v2 } = makeSharedZipPair(ctx.cryptoDelta);
    const d = ctx.cryptoDelta.generateRbDelta(v1, v2);
    ctx.assert.equal(ctx.cryptoDelta.applyRbDelta(v1, d).equals(v2), true);

    if (ctx.repoCheck) {
      const realRecipe = JSON.parse(await readFile(path.join(ctx.repoRoot, 'android', 'recipes', 'manifest.json'), 'utf8'));
      ctx.assert.equal(realRecipe.schema, 'rokbot-android-native/v1');
      ctx.assert.equal(realRecipe.version, '1.26.0');
      const javaDir = path.join(ctx.repoRoot, 'android', 'companion', 'src', 'main', 'java', 'dev', 'rokbot', 'nativeapp');
      const umTxt = await readFile(path.join(javaDir, 'UpdateManager.java'), 'utf8');
      ctx.assert.ok(umTxt.includes('rokbot-android-native-update/v1'));
      ctx.assert.ok(umTxt.includes('RBDELTA1'));
      const dpTxt = await readFile(path.join(javaDir, 'DeltaPatcher.java'), 'utf8');
      ctx.assert.ok(dpTxt.includes('RBDELTA1'));
      ctx.assert.equal(existsSync(path.join(javaDir, 'ModelsActivity.java')), true);
      ctx.assert.equal(existsSync(path.join(javaDir, 'PairingActivity.java')), true);
    }
  });

  // =========================================================================
  // Feature F11: iOS Client & Patcher Upgrade (T1-F11-01..06)
  // =========================================================================

  test('T1-F11-01', 'iOS rokbot-ios-update/v1 manifest publish & installMethods retrieval', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, {
      deviceName: 'iPhone 16 Pro',
      platform: 'ios',
      clientDeviceId: 'ios-f11-01',
      bundleId: 'dev.rokbot.local',
    });

    const ipaBuf = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: 'ios' }]);
    const ipaName = e2eFilename(ctx, 'RokBot-1.16.0.ipa');
    const up = await client.adminUploadUpdate({ platform: 'ios', filename: ipaName, bytes: ipaBuf });
    ctx.assert.assertStatus(up, 201);
    const pub = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      releaseNotes: 'iOS OTA',
      filename: ipaName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub, 201);
    trackReleaseCleanup(ctx, t, client, 'ios', pub);

    const feed = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed, 200);
    ctx.assert.equal(feed.json.schema, 'rokbot-ios-update/v1');
    ctx.assert.equal(feed.json.latest.version, '1.16.0');
    ctx.assert.equal(feed.json.latest.build, '23152');
    ctx.assert.equal(feed.json.latest.bundleId, 'dev.rokbot.local');
    ctx.assert.equal(feed.json.latest.sha256, ctx.cryptoDelta.sha256Hex(ipaBuf));
    ctx.assert.equal(feed.json.latest.size, ipaBuf.length);
    const methods = feed.json.latest.installMethods;
    ctx.assert.ok(methods.altStoreSourceUrl);
    ctx.assert.ok(methods.ipaDownloadUrl);
    ctx.assert.ok(methods.manifestPlistUrl || methods.itmsServicesUrl);
  });

  test('T1-F11-02', 'Apple itms-services manifest.plist generation, XML escaping & validation', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'iPhone Plist', platform: 'ios' });

    const ipaBuf = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: 'ios-plist' }]);
    const ipaName = e2eFilename(ctx, 'RokBot-1.16.0.ipa');
    const up = await client.adminUploadUpdate({ platform: 'ios', filename: ipaName, bytes: ipaBuf });
    ctx.assert.assertStatus(up, 201);
    const pub = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      filename: ipaName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub, 201);
    trackReleaseCleanup(ctx, t, client, 'ios', pub);

    const feed = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed, 200);
    const plistRes = await client.fetchIosPlist(resolvePlistUrl(feed.json));
    ctx.assert.assertStatus(plistRes, 200);
    ctx.assert.ok((plistRes.headers.get('content-type') || '').includes('xml'));

    const check = ctx.cryptoDelta.validateIosManifestPlist(plistRes.text, {
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
    });
    ctx.assert.equal(check.ok, true, check.errors.join('; '));

    // Custom plist with XML special characters in title & icon URLs
    const customXml = ctx.cryptoDelta.buildIosManifestPlist({
      ipaUrl: 'https://bot.example.com/updates/ios/tok/RokBot.ipa',
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
      title: 'RokBot & "Local" <1>',
      displayImageUrl: 'https://bot.example.com/rokbot-icon.png',
      fullSizeImageUrl: 'https://bot.example.com/rokbot-icon.png',
    });
    const customChk = ctx.cryptoDelta.validateIosManifestPlist(customXml, {
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
    });
    ctx.assert.equal(customChk.ok, true, customChk.errors.join('; '));
    ctx.assert.equal(customChk.parsed.metadata.title, 'RokBot & "Local" <1>');
  });

  test('T1-F11-03', 'AltStore / SideStore altstore.json source structure & validation', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'iPhone AltStore', platform: 'ios' });

    const ipaBuf = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: 'altstore' }]);
    const ipaName = e2eFilename(ctx, 'RokBot-1.16.0.ipa');
    const up = await client.adminUploadUpdate({ platform: 'ios', filename: ipaName, bytes: ipaBuf });
    ctx.assert.assertStatus(up, 201);
    const pub = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      filename: ipaName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub, 201);
    trackReleaseCleanup(ctx, t, client, 'ios', pub);

    const feed = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed, 200);
    const altRes = await client.fetchIosAltStore(feed.json.latest.installMethods.altStoreSourceUrl);
    ctx.assert.assertStatus(altRes, 200);
    ctx.assert.equal(altRes.json.apps[0].bundleIdentifier, 'dev.rokbot.local');
    ctx.assert.equal(altRes.json.apps[0].versions[0].version, '1.16.0');
    ctx.assert.equal(altRes.json.apps[0].versions[0].size, ipaBuf.length);

    const check = ctx.cryptoDelta.validateAltStoreJson(altRes.json, { bundleId: 'dev.rokbot.local' });
    ctx.assert.equal(check.ok, true, check.errors.join('; '));

    const multiSrc = ctx.cryptoDelta.buildAltStoreSource({
      name: 'RokBot AltStore',
      identifier: 'dev.rokbot.local.source',
      sourceURL: 'https://bot.example.com/updates/ios/tok/altstore.json',
      apps: [
        {
          name: 'RokBot',
          bundleIdentifier: 'dev.rokbot.local',
          developerName: 'RokBot Maintainers',
          localizedDescription: 'Self-hosted AI assistant client',
          versions: [
            {
              version: '1.16.0',
              date: '2026-11-19T21:00:00.000Z',
              downloadURL: 'https://bot.example.com/updates/ios/tok/RokBot-1.16.0.ipa',
              size: 1024,
              sha256: 'ab'.repeat(32),
            },
          ],
        },
      ],
    });
    const multiChk = ctx.cryptoDelta.validateAltStoreJson(multiSrc, { bundleId: 'dev.rokbot.local' });
    ctx.assert.equal(multiChk.ok, true, multiChk.errors.join('; '));
  });

  test('T1-F11-04', 'iOS device pairing (platform=ios), clientDeviceId dedup & foreground push suppression', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation & foreground push sink; live dedup covered by T1-F10-04');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);

    const k1 = await client.createPairingKey();
    const p1 = await client.pairWithKey({
      pairingKey: k1.json.pairingKey,
      deviceName: 'iPhone 16',
      platform: 'ios',
      clientDeviceId: 'ios-uuid-001',
      bundleId: 'dev.rokbot.local',
    });
    ctx.assert.assertStatus(p1, 201);
    const tok1 = p1.json.token;

    const k2 = await client.createPairingKey();
    const p2 = await client.pairWithKey({
      pairingKey: k2.json.pairingKey,
      deviceName: 'iPhone 16',
      platform: 'ios',
      clientDeviceId: 'ios-uuid-001',
      bundleId: 'dev.rokbot.local',
    });
    ctx.assert.assertStatus(p2, 201);
    if (ctx.harness || p2.json.reused !== undefined) {
      ctx.assert.equal(p2.json.reused, true);
    }
    ctx.assert.equal(p2.json.deviceId, p1.json.deviceId);
    ctx.assert.notEqual(p2.json.token, tok1);

    const putPush = await client.updateDevice({
      foreground: true,
      push: { provider: 'webhook', webhookUrl: 'https://push.example.com/ios-hook' },
    });
    ctx.assert.assertStatus(putPush, 200);
    ctx.assert.equal(putPush.json.platform, 'ios');
    ctx.assert.equal(putPush.json.bundleId, 'dev.rokbot.local');
    if (ctx.harness) {
      ctx.assert.equal(putPush.json.push.foreground, true);
    } else {
      ctx.assert.equal(typeof putPush.json.push.foreground, 'boolean');
    }

    const sse = await client.openSse('/notifications/events', {
      headers: { 'x-rokbot-foreground': '1' },
    });
    t.after(() => sse.close());

    const devFg = await client.getDevice();
    ctx.assert.assertStatus(devFg, 200);
    ctx.assert.equal(devFg.json.push.foreground, true);

    if (ctx.harness) {
      ctx.harness.publishNotification({ title: 'iOS Ping', body: 'Foreground test' });
      const ev = await sse.nextEvent((e) => e.event === 'notification', 3000);
      ctx.assert.equal(ev.data.title, 'iOS Ping');
      const hist = ctx.harness.getPushHistory();
      ctx.assert.ok(hist.suppressed.some((s) => s.deviceId === p2.json.deviceId && s.reason === 'foreground'));
    }
  });

  test('T1-F11-05', 'Tokenized .ipa streaming download with HEAD, Range 206 & full SHA-256 match', async (t) => {
    await resetHarnessState(ctx);
    const client = await setupAdminAndPairedDevice(ctx, t, { deviceName: 'iPhone Download', platform: 'ios' });

    const ipaBuf = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'Payload/RokBot.app/Info.plist', data: Buffer.from('plist-data-'.repeat(64)) },
    ]);
    const ipaName = e2eFilename(ctx, 'RokBot-1.16.0.ipa');
    const up = await client.adminUploadUpdate({ platform: 'ios', filename: ipaName, bytes: ipaBuf });
    ctx.assert.assertStatus(up, 201);
    const pub = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      filename: ipaName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub, 201);
    trackReleaseCleanup(ctx, t, client, 'ios', pub);

    const feed = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed, 200);
    const ipaUrl = feed.json.latest.installMethods.ipaDownloadUrl;

    const anon = createClient(ctx, { deviceToken: null });
    t.after(() => anon.close());

    const headRes = await anon.downloadUpdateFile(ipaUrl, { method: 'HEAD', auth: false });
    ctx.assert.assertStatus(headRes, 200);
    ctx.assert.equal(Number(headRes.headers.get('content-length')), ipaBuf.length);

    const part = await anon.downloadUpdateFile(ipaUrl, { range: 'bytes=0-31', auth: false });
    ctx.assert.assertStatus(part, 206);
    ctx.assert.equal(part.headers.get('content-range'), `bytes 0-31/${ipaBuf.length}`);
    ctx.assert.equal(part.buffer.equals(ipaBuf.subarray(0, 32)), true);

    const full = await anon.downloadUpdateFile(ipaUrl, { auth: false });
    ctx.assert.assertStatus(full, 200);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(full.buffer), feed.json.latest.sha256);
  });

  test('T1-F11-06', 'iOS client & patcher contract verification (--repo-check & fixture mode)', async (t) => {
    const tmp = await t.createTempDir('t1-f11-06-');
    const plistXml = ctx.cryptoDelta.buildIosManifestPlist({
      ipaUrl: 'https://bot.example.com/updates/ios/tok/RokBot.ipa',
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
      title: 'RokBot',
    });
    await writeFile(path.join(tmp, 'manifest.plist'), plistXml, 'utf8');
    const plistChk = ctx.cryptoDelta.validateIosManifestPlist(await readFile(path.join(tmp, 'manifest.plist'), 'utf8'), {
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
    });
    ctx.assert.equal(plistChk.ok, true);

    if (ctx.repoCheck) {
      const rbUpdater = await readFile(path.join(ctx.repoRoot, 'ios', 'clients', 'ios', 'RBUpdater.m'), 'utf8');
      ctx.assert.ok(rbUpdater.includes('rokbot-ios-update/v1'));
      const rbIdentity = await readFile(path.join(ctx.repoRoot, 'ios', 'clients', 'ios', 'RBDeviceIdentity.m'), 'utf8');
      ctx.assert.ok(rbIdentity.includes('RBClientDeviceId'));
      ctx.assert.ok(rbIdentity.includes('RokBotLocal.clientDeviceId'));
      ctx.assert.equal(existsSync(path.join(ctx.repoRoot, 'ios', 'clients', 'ios', 'RBModels.m')), true);
      const patchIos = await readFile(path.join(ctx.repoRoot, 'ios', 'release', 'patch-ios.py'), 'utf8');
      ctx.assert.ok(patchIos.includes('dev.rokbot.local'));
      const icon1024 = ctx.repoChecks.inspectPng(path.join(ctx.repoRoot, 'assets', 'logo', 'ios', 'AppIcon-1024.png'));
      ctx.assert.equal(icon1024.hasAlpha, false);
    }
  });
}

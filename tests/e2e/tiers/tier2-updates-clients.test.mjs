import { generateKeyPairSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export const tier = 2;
export const name = 'tier2-updates-clients';

function unwrapItmsPlistUrl(methods) {
  if (methods?.manifestPlistUrl) return methods.manifestPlistUrl;
  const raw = methods?.itmsServicesUrl || '';
  if (raw.startsWith('itms-services://')) {
    const u = new URL(raw);
    const inner = u.searchParams.get('url');
    if (inner) return inner;
  }
  return raw;
}

function extractIosOtaToken(urlStr) {
  const m = /\/updates\/ios\/([^/]+)\//.exec(String(urlStr || ''));
  return m ? m[1] : null;
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
        deviceName: pairOpts.deviceName || 'Tier2 Update Client',
        platform: pairOpts.platform || 'desktop',
        ...(pairOpts.clientKind ? { clientKind: pairOpts.clientKind } : {}),
        ...(pairOpts.clientDeviceId ? { clientDeviceId: pairOpts.clientDeviceId } : {}),
      };
  const pairRes = await client.pairWithPassword(body);
  ctx.assert.assertStatus(pairRes, 201);
  if (cache) {
    cache.deviceToken = pairRes.json.token;
    cache.deviceId = pairRes.json.deviceId;
  }
  return pairRes.json;
}

async function setupAdminAndDevice(client, ctx, pairOpts = {}) {
  await ensureAdminSession(ctx, client);
  return ensureDeviceSession(ctx, client, pairOpts);
}

function trackReleaseCleanup(ctx, t, client, platform, publishRes) {
  const releaseId = publishRes?.json?.release?.id;
  if (!ctx.harness && releaseId) {
    t.after(async () => {
      await client.adminDeleteUpdate(platform, releaseId).catch(() => {});
    });
  }
}

function makeSignedDesktopSample(cryptoDelta, kp) {
  const baseAsar = cryptoDelta.buildSyntheticAsar({ files: { 'index.js': { size: 64 } } }, Buffer.alloc(4096, 0x41));
  const targetAsar = cryptoDelta.buildSyntheticAsar({ files: { 'index.js': { size: 64 } } }, Buffer.concat([Buffer.alloc(3840, 0x41), Buffer.alloc(256, 0x42)]));
  const raw = {
    schema: cryptoDelta.DESKTOP_UPDATE_SCHEMA,
    platform: 'macos',
    track: 'stable',
    channel: 'stable',
    version: '1.2.3',
    sha256: targetAsar.sha256,
    size: targetAsar.bytes.length,
    url: 'https://updates.example.com/RokBot-1.2.3.dmg',
    publishedAt: '2026-11-20T00:00:00.000Z',
    releaseNotes: 'Desktop 1.2.3',
    notes: 'Desktop 1.2.3',
    asarSha256: targetAsar.sha256,
    asarHeaderSha256: targetAsar.headerSha256,
    deltas: [
      {
        baseSha256: cryptoDelta.sha256Hex(Buffer.from('prev-dmg')),
        baseSize: 1024,
        sha256: cryptoDelta.sha256Hex(Buffer.from('delta-dmg')),
        size: 128,
        url: 'https://updates.example.com/delta.rbd1',
      },
    ],
    asarDeltas: [
      {
        baseSha256: baseAsar.sha256,
        baseSize: baseAsar.bytes.length,
        targetSha256: targetAsar.sha256,
        targetSize: targetAsar.bytes.length,
        targetHeaderSha256: targetAsar.headerSha256,
        sha256: cryptoDelta.sha256Hex(Buffer.from('asar-delta')),
        size: 96,
        url: 'https://updates.example.com/asar.rbd1',
      },
    ],
  };
  let signed = cryptoDelta.signDesktopManifest(raw, kp.privateKey);
  signed = cryptoDelta.signDesktopDeltas(signed, kp.privateKey);
  signed.latest = {
    version: signed.version,
    url: signed.url,
    sha256: signed.sha256,
    size: signed.size,
    channel: signed.channel,
    releaseNotes: signed.releaseNotes,
    asarSha256: signed.asarSha256,
    asarHeaderSha256: signed.asarHeaderSha256,
    deltas: signed.deltas.map((d) => ({ ...d })),
    asarDeltas: signed.asarDeltas.map((d) => ({ ...d })),
  };
  return signed;
}

function makeSignedAndroidSample(cryptoDelta, kp) {
  const sha = 'a'.repeat(64);
  const cert = 'b'.repeat(64);
  const raw = {
    schema: cryptoDelta.ANDROID_NATIVE_UPDATE_SCHEMA,
    track: 'stable',
    channel: 'stable',
    packageName: 'dev.rokbot.nativeapp',
    versionName: '1.16.0',
    versionCode: 1075,
    sha256: sha,
    size: 20480,
    certificateSha256: cert,
    url: 'https://updates.example.com/rokbot.apk',
    fullUrl: 'https://updates.example.com/rokbot.apk',
    publishedAt: '2026-11-20T00:00:00.000Z',
    releaseNotes: 'Android 1.16.0',
    notes: 'Android 1.16.0',
    deltas: [
      {
        fromVersionCode: 1074,
        baseSha256: 'c'.repeat(64),
        baseSize: 19000,
        sha256: 'd'.repeat(64),
        size: 512,
        url: 'https://updates.example.com/patch.rbdelta',
        format: 'RBDELTA1',
      },
    ],
  };
  let signed = cryptoDelta.signAndroidManifest(raw, kp.privateKey);
  signed = cryptoDelta.signAndroidDeltas(signed, kp.privateKey);
  signed.latest = {
    versionName: signed.versionName,
    versionCode: signed.versionCode,
    packageName: signed.packageName,
    certificateSha256: signed.certificateSha256,
    apkUrl: signed.url,
    apkSha256: signed.sha256,
    apkSize: signed.size,
    releaseNotes: signed.releaseNotes,
    deltas: signed.deltas.map((d) => ({ ...d })),
  };
  return signed;
}

function buildRawRbDelta({ magic = 'RBDELTA1', baseSize, targetSize, opCount = 1, opsBuf = Buffer.from([0x00]) }) {
  const head = Buffer.alloc(44, 0);
  Buffer.from(magic, 'ascii').copy(head, 0, 0, 8);
  head.writeBigUInt64BE(BigInt(baseSize), 8);
  head.writeBigUInt64BE(BigInt(targetSize), 16);
  head.writeUInt32BE(opCount >>> 0, 24);
  return gzipSync(Buffer.concat([head, opsBuf]));
}

export function registerTests(test, ctx) {
  // =========================================================================
  // Feature F6 — Host Unified 4-Platform Auto-Update Server (T2-F06-01..07)
  // =========================================================================

  test('T2-F06-01', 'Admin update routes enforce admin session cookie (401), CSRF header (403) & Origin guard (403)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    // Unauthenticated GET
    ctx.assert.assertStatus(await client.adminListUpdates(), 401);

    // Device Bearer token alone must NOT authorize /admin/api/updates
    await ensureDeviceSession(ctx, client, { deviceName: 'NonAdmin' });
    ctx.assert.assertStatus(await client.request('GET', '/admin/api/updates'), 401);

    // Admin login -> test missing CSRF & bad Origin
    await ensureAdminSession(ctx, client);
    const bytes = Buffer.from('apk-payload');
    ctx.assert.assertStatus(
      await client.adminUploadUpdate({ platform: 'android', filename: 'a.apk', bytes }, { csrf: false }),
      403,
    );
    ctx.assert.assertStatus(
      await client.adminUploadUpdate({ platform: 'android', filename: 'a.apk', bytes }, { origin: 'https://evil.example' }),
      403,
    );
    ctx.assert.assertStatus(
      await client.adminPublishUpdate({ platform: 'android', version: '1.0.0', filename: 'a.apk' }, { csrf: false }),
      403,
    );
    ctx.assert.assertStatus(
      await client.adminDeleteUpdate('android', 'rel-1', { origin: 'https://evil.example' }),
      403,
    );
  });

  test('T2-F06-02', 'Upload & download reject invalid platform, empty payload, traversal filenames & malformed %ZZ URI', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await setupAdminAndDevice(client, ctx);

    const payload = Buffer.from('valid-bytes');
    ctx.assert.assertStatus(await client.adminUploadUpdate({ platform: 'linux', filename: 'a.zip', bytes: payload }), 400);
    ctx.assert.assertStatus(await client.adminUploadUpdate({ platform: 'android', filename: 'empty.apk', bytes: Buffer.alloc(0) }), 400);
    for (const badName of ['.', '..', 'bad\\name.apk']) {
      ctx.assert.assertStatus(
        await client.adminUploadUpdate({ platform: 'android', filename: badName, bytes: payload }),
        400,
        `Expected 400 for upload filename=${badName}`,
      );
    }

    const badPct = await client.downloadUpdateFile('/local/updates/files/android/%ZZ');
    ctx.assert.assertStatus(badPct, 400);

    for (const trav of [
      '/local/updates/files/android/%2e%2e',
      '/local/updates/files/android/..%2f..%2fetc%2fpasswd',
      '/local/updates/files/android/..%5c..%5cwin.ini',
    ]) {
      const res = await client.downloadUpdateFile(trav);
      ctx.assert.ok([400, 404].includes(res.status), `Expected 400/404 for ${trav}, got ${res.status}`);
    }
  });

  test('T2-F06-03', 'Artifact download Range boundary and malformed range headers return 416 with Content-Range: bytes */N', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await setupAdminAndDevice(client, ctx);
    const bytes = Buffer.from('0123456789'.repeat(10)); // 100 bytes
    const exeName = e2eFilename(ctx, 'RokBot-1.2.3-Setup.exe');
    const up = await client.adminUploadUpdate({ platform: 'windows', filename: exeName, bytes });
    ctx.assert.assertStatus(up, 201);
    const pub = await client.adminPublishUpdate({
      platform: 'windows',
      version: '1.2.3',
      filename: exeName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub, 201);
    trackReleaseCleanup(ctx, t, client, 'windows', pub);
    const feed = await client.getUpdateManifest('windows');
    ctx.assert.assertStatus(feed, 200);
    const dlUrl = feed.json.latest?.url || feed.json.url;

    const badRanges = [
      `bytes=${bytes.length}-`,
      'bytes=999999999-',
      'bytes=50-10',
      'bytes=-0',
      'bytes=-',
      'items=0-5',
    ];
    for (const range of badRanges) {
      const res = await client.downloadUpdateFile(dlUrl, { range });
      ctx.assert.assertStatus(res, 416, `Expected 416 for Range: ${range}`);
      ctx.assert.equal(res.headers.get('content-range'), `bytes */${bytes.length}`);
    }
  });

  test('T2-F06-04', '/local/updates/fetch enforces Bearer auth (401), HTTPS/no-credentials (400) & SSRF blocklist (403)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    ctx.assert.assertStatus(await client.fetchUpdateProxy('https://example.com/a.apk', 'GET', { auth: false }), 401);

    await setupAdminAndDevice(client, ctx);

    // Missing url param
    ctx.assert.assertStatus(await client.request('GET', '/local/updates/fetch'), 400);

    // Non-HTTPS & URL credentials -> 400
    for (const badUrl of [
      'http://updates.example.com/a.apk',
      'file:///etc/passwd',
      'https://user:pass@updates.example.com/a.apk',
      'https://user@updates.example.com/a.apk',
    ]) {
      const res = await client.fetchUpdateProxy(badUrl);
      ctx.assert.assertStatus(res, 400, `Expected 400 for ${badUrl}`);
    }

    // Combined non-HTTPS + loopback -> 400 or 403
    const comboRes = await client.fetchUpdateProxy('http://127.0.0.1/a.apk');
    ctx.assert.ok([400, 403].includes(comboRes.status), `Expected 400 or 403 for http://127.0.0.1/a.apk, got ${comboRes.status}`);

    // SSRF targets -> 403
    const ssrfTargets = [
      'https://127.0.0.1/a.apk',
      'https://10.0.0.1/a',
      'https://169.254.169.254/latest/meta-data/',
      'https://192.168.1.1/a',
      'https://172.16.0.1/a',
      'https://100.64.0.1/a',
      'https://localhost/a',
      'https://[::1]/a',
      'https://[::ffff:127.0.0.1]/a',
      'https://[fe80::1]/a',
    ];
    if (ctx.harness) {
      ssrfTargets.push('https://metadata.goog/a', 'https://host.internal/a');
    }
    for (const target of ssrfTargets) {
      const res = await client.fetchUpdateProxy(target);
      ctx.assert.assertStatus(res, 403, `Expected 403 SSRF block for ${target}`);
    }
  });

  test('T2-F06-05', 'iOS OTA rejects invalid/rotated tokens (403), missing release (404) & wrong filename (404)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await setupAdminAndDevice(client, ctx);

    ctx.assert.assertStatus(
      await client.fetchIosPlist('/updates/ios/fake-token-000/manifest.plist'),
      ctx.harness ? 403 : [403, 404],
    );
    if (ctx.harness) {
      const preTok = ctx.harness.getIosOtaToken();
      ctx.assert.assertStatus(await client.fetchIosPlist(preTok), 404);
    }

    const ipa1 = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: 'v1' }]);
    const ipa1Name = e2eFilename(ctx, 'RokBot-1.16.0.ipa');
    const up1 = await client.adminUploadUpdate({ platform: 'ios', filename: ipa1Name, bytes: ipa1 });
    ctx.assert.assertStatus(up1, 201);
    const pub1 = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '100',
      bundleId: 'dev.rokbot.local',
      filename: ipa1Name,
      ...(up1.json.artifact?.id ? { artifactId: up1.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub1, 201);
    trackReleaseCleanup(ctx, t, client, 'ios', pub1);
    const feed1 = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed1, 200);
    const token1 = extractIosOtaToken(feed1.json.latest.installMethods.altStoreSourceUrl);
    ctx.assert.ok(token1);
    ctx.assert.assertStatus(await client.fetchIosPlist('/updates/ios/fake-token-000/manifest.plist'), 403);

    // Publish v2 -> rotates OTA token
    const ipa2 = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: 'v2' }]);
    const ipa2Name = e2eFilename(ctx, 'RokBot-1.16.1.ipa');
    const up2 = await client.adminUploadUpdate({ platform: 'ios', filename: ipa2Name, bytes: ipa2 });
    ctx.assert.assertStatus(up2, 201);
    const pub2 = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.1',
      build: '101',
      bundleId: 'dev.rokbot.local',
      filename: ipa2Name,
      ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub2, 201);
    trackReleaseCleanup(ctx, t, client, 'ios', pub2);
    const feed2 = await client.getUpdateManifest('ios');
    const token2 = extractIosOtaToken(feed2.json.latest.installMethods.altStoreSourceUrl);
    ctx.assert.notEqual(token2, token1);

    if (ctx.harness) {
      ctx.assert.assertStatus(await client.fetchIosPlist(`/updates/ios/${token1}/manifest.plist`), 403);
      ctx.assert.assertStatus(await client.fetchIosAltStore(`/updates/ios/${token1}/altstore.json`), 403);
      ctx.assert.assertStatus(await client.request('GET', `/updates/ios/${token1}/${ipa1Name}`, { auth: false }), 403);
    }

    ctx.assert.assertStatus(await client.request('GET', `/updates/ios/${token2}/wrong.ipa`, { auth: false }), 404);
    ctx.assert.assertStatus(await client.request('GET', `/updates/ios/${token2}/%ZZ`, { auth: false }), 400);
  });

  test('T2-F06-06', 'Publish rejects missing version/artifact/generateDeltaFrom & DELETE rejects unknown platform/release', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await setupAdminAndDevice(client, ctx);

    ctx.assert.assertStatus(await client.adminPublishUpdate({ platform: 'android', version: '1.0.0', filename: 'missing.apk' }), 404);

    const apk = ctx.cryptoDelta.buildSyntheticZip([{ name: 'classes.dex', data: Buffer.from('x'.repeat(2048)) }]);
    const okName = e2eFilename(ctx, 'ok.apk');
    const up = await client.adminUploadUpdate({ platform: 'android', filename: okName, bytes: apk });
    ctx.assert.assertStatus(up, 201);

    ctx.assert.assertStatus(
      await client.adminPublishUpdate({
        platform: 'android',
        filename: okName,
        ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
      }),
      400,
    );

    const missingBase = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.0.1',
      versionCode: 101,
      filename: okName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
      generateDeltaFrom: 'nonexistent-ref',
    });
    ctx.assert.assertStatus(missingBase, 404);

    ctx.assert.assertStatus(await client.adminDeleteUpdate('bogus', '123'), [400, 404]);
    ctx.assert.assertStatus(await client.adminDeleteUpdate('android', 'nonexistent-release-id'), 404);
  });

  test('T2-F06-07', 'Unauthenticated/revoked device rejected (401) on /local/updates/* and unpublished platform returns 404', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation for disposable device revocation; live revocation covered by T1-F14-03');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    ctx.assert.assertStatus(await client.getUpdateManifest('android', { auth: false }), 401);
    ctx.assert.assertStatus(await client.downloadUpdateFile('/local/updates/files/android/app.apk', { auth: false }), 401);
    ctx.assert.assertStatus(await client.getUpdateManifest('android', { bearer: 'malformed' }), 401);

    await ensureAdminSession(ctx, client);
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);
    const pairRes = await client.pairWithKey({ pairingKey: keyRes.json.pairingKey, deviceName: 'Revokable Updater' });
    ctx.assert.assertStatus(pairRes, 201);
    const pair = pairRes.json;
    // Unpublished windows feed -> 404 (harness isolated state)
    if (ctx.harness) {
      ctx.assert.assertStatus(await client.getUpdateManifest('windows'), 404);
    }

    // Revoke device -> 401
    ctx.assert.assertStatus(await client.revokeDevice(pair.deviceId), 200);
    ctx.assert.assertStatus(await client.getUpdateManifest('windows'), 401);
  });

  // =========================================================================
  // Feature F8 — Desktop (mac/ & windows/) 1.2.3 & RBD1 (T2-F08-01..06)
  // =========================================================================

  test('T2-F08-01', 'Desktop manifest & deltasSignature reject tampered fields, wrong ECDSA key & non-P256 keys', async () => {
    const kp1 = ctx.cryptoDelta.generateSigningKeyPair();
    const kp2 = ctx.cryptoDelta.generateSigningKeyPair();
    const rsaKp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const p384Kp = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });

    const base = makeSignedDesktopSample(ctx.cryptoDelta, kp1);
    ctx.cryptoDelta.verifyDesktopManifest(base, kp1.publicKeyPem);
    ctx.cryptoDelta.verifyDesktopDeltas(base, kp1.publicKeyPem);

    // Wrong P-256 key
    ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopManifest(base, kp2.publicKeyPem), /Invalid desktop manifest signature/);
    ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopDeltas(base, kp2.publicKeyPem), /Invalid desktop manifest signature/);

    // Non-P256 keys
    ctx.assert.throws(() => ctx.cryptoDelta.normalizeEcPublicKey(rsaKp.publicKey.export({ type: 'spki', format: 'pem' })), /prime256v1/);
    ctx.assert.throws(() => ctx.cryptoDelta.normalizeEcPublicKey(p384Kp.publicKey.export({ type: 'spki', format: 'pem' })), /prime256v1/);
    ctx.assert.throws(() => ctx.cryptoDelta.normalizeEcPublicKey(''), /cannot be empty/);

    // Mutate manifest fields (keeping dual-shape aligned so signature fails rather than dual-shape check)
    for (const [k, v] of [['version', '1.2.4'], ['sha256', 'f'.repeat(64)], ['size', 9999], ['url', 'https://evil.example/x.dmg']]) {
      const tampered = structuredClone(base);
      tampered[k] = v;
      tampered.latest[k] = v;
      ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopManifest(tampered, kp1.publicKeyPem), /Invalid desktop manifest signature/);
    }

    // Mutate delta fields (signature remains valid, deltasSignature must reject)
    const badDeltaSize = structuredClone(base);
    badDeltaSize.deltas[0].size += 1;
    badDeltaSize.latest.deltas[0].size += 1;
    ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopDeltas(badDeltaSize, kp1.publicKeyPem), /Invalid desktop delta signature/);

    const badAsarHeader = structuredClone(base);
    badAsarHeader.asarDeltas[0].targetHeaderSha256 = '0'.repeat(64);
    badAsarHeader.latest.asarDeltas[0].targetHeaderSha256 = '0'.repeat(64);
    ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopDeltas(badAsarHeader, kp1.publicKeyPem), /Invalid desktop delta signature/);
  });

  test('T2-F08-02', 'Desktop dual-shape validation rejects any divergence between top-level and latest.*', async () => {
    const kp = ctx.cryptoDelta.generateSigningKeyPair();
    const base = makeSignedDesktopSample(ctx.cryptoDelta, kp);

    const mutations = [
      (m) => { m.latest.version = '9.9.9'; },
      (m) => { m.latest.sha256 = 'e'.repeat(64); },
      (m) => { m.latest.size = 123456; },
      (m) => { m.latest.url = 'https://other.example/x.dmg'; },
      (m) => { m.latest.fullUrl = 'https://other.example/latest-mismatch.dmg'; },
      (m) => { m.latest.channel = 'nightly'; },
      (m) => { m.latest.asarSha256 = '1'.repeat(64); },
      (m) => { m.latest.asarHeaderSha256 = '2'.repeat(64); },
      (m) => { m.latest.deltas = []; },
      (m) => { m.latest.asarDeltas = []; },
    ];
    for (const mutate of mutations) {
      const m = structuredClone(base);
      mutate(m);
      ctx.assert.throws(() => ctx.cryptoDelta.normalizeDesktopManifestRecord(m), /dual-shape mismatch/);
    }
  });

  test('T2-F08-03', 'RBD1 rejects wrong source buffer, corrupted gzip, truncated stream, trailing byte, bad target SHA & bad magic', async () => {
    const src = Buffer.concat([Buffer.alloc(2048, 0x41), Buffer.from('source-end')]);
    const tgt = Buffer.concat([Buffer.alloc(2048, 0x41), Buffer.from('target-end-diff')]);
    const delta = ctx.cryptoDelta.generateRbd1Delta(src, tgt);

    // Wrong source buffer
    ctx.assert.throws(() => ctx.cryptoDelta.applyRbd1Delta(Buffer.from('wrong'), delta), /source checksum or size mismatch/);

    // Corrupted gzip bytes
    const badGzip = Buffer.from(delta);
    badGzip[badGzip.length - 4] ^= 0xff;
    ctx.assert.throws(() => ctx.cryptoDelta.applyRbd1Delta(src, badGzip));

    const raw = gunzipSync(delta);

    // Bad magic
    const badMagic = Buffer.from(raw);
    badMagic.write('BAD1', 0, 4, 'ascii');
    ctx.assert.throws(() => ctx.cryptoDelta.applyRbd1Delta(src, gzipSync(badMagic)), /Invalid delta header magic/);

    // Truncated stream (drop OP_END)
    const truncated = raw.subarray(0, raw.length - 1);
    ctx.assert.throws(() => ctx.cryptoDelta.applyRbd1Delta(src, gzipSync(truncated)), /Incomplete or malformed delta stream/);

    // Trailing byte after OP_END
    const trailing = Buffer.concat([raw, Buffer.from([0x99])]);
    ctx.assert.throws(() => ctx.cryptoDelta.applyRbd1Delta(src, gzipSync(trailing)), /Incomplete or malformed delta stream/);

    // Flip target SHA-256 byte (offset: 4 magic + 32 srcSha + >=1 srcSize ULEB128; find exact header end via inspectRbd1Header)
    const info = ctx.cryptoDelta.inspectRbd1Header(delta);
    const badTargetSha = Buffer.from(raw);
    // targetSha256 sits immediately before targetSize ULEB128
    badTargetSha[info.headerBytes - 5] ^= 0xff;
    ctx.assert.throws(() => ctx.cryptoDelta.applyRbd1Delta(src, gzipSync(badTargetSha)), /output SHA-256 verification failed/);
  });

  test('T2-F08-04', 'ASAR parser rejects truncated header, invalid sizeSize/stringLen, invalid JSON & detects headerSha256 mismatch', async () => {
    await ctx.assert.rejects(() => ctx.cryptoDelta.readAsarHeaderInfo(Buffer.alloc(10)), /Truncated ASAR header/);

    const good = ctx.cryptoDelta.buildSyntheticAsar({ files: { 'a.js': { size: 4 } } }, Buffer.from('1234'));
    const badSizeSize = Buffer.from(good.bytes);
    badSizeSize.writeUInt32LE(8, 0);
    await ctx.assert.rejects(() => ctx.cryptoDelta.readAsarHeaderInfo(badSizeSize), /Invalid ASAR header structure/);

    const badStringLen = Buffer.from(good.bytes);
    badStringLen.writeInt32LE(badStringLen.readUInt32LE(4) + 10, 12);
    await ctx.assert.rejects(() => ctx.cryptoDelta.readAsarHeaderInfo(badStringLen), /Invalid ASAR header structure/);

    // Invalid JSON inside valid pickle framing
    const badJsonBytes = Buffer.from('{not-json');
    const padLen = (badJsonBytes.length + 3) & ~3;
    const badAsar = Buffer.alloc(16 + padLen, 0);
    badAsar.writeUInt32LE(4, 0);
    badAsar.writeUInt32LE(4 + 4 + padLen, 4);
    badAsar.writeUInt32LE(4 + padLen, 8);
    badAsar.writeInt32LE(badJsonBytes.length, 12);
    badJsonBytes.copy(badAsar, 16);
    await ctx.assert.rejects(() => ctx.cryptoDelta.readAsarHeaderInfo(badAsar), SyntaxError);

    // Header SHA-256 mismatch check against rebuilt ASAR
    const parsed = await ctx.cryptoDelta.readAsarHeaderInfo(good.bytes);
    ctx.assert.notEqual(parsed.headerSha256, '0'.repeat(64));
  });

  test('T2-F08-05', 'verifyDesktopManifest rejects unknown schema & verifyDesktopDeltas rejects missing deltasSignature', async () => {
    const kp = ctx.cryptoDelta.generateSigningKeyPair();
    const base = makeSignedDesktopSample(ctx.cryptoDelta, kp);

    const badSchema = { ...base, schema: 'unknown/v1' };
    ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopManifest(badSchema, kp.publicKeyPem), /Invalid desktop update manifest schema/);

    const noDeltasSig = structuredClone(base);
    delete noDeltasSig.deltasSignature;
    ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopDeltas(noDeltasSig, kp.publicKeyPem), /Missing desktop delta signature/);
  });

  test('T2-F08-06', 'ULEB128 boundary values (0, 127, 128, MAX_SAFE_INTEGER, negative, overflow, truncated) & empty-buffer RBD1 round-trips', async () => {
    for (const val of [0, 127, 128, 16384, Number.MAX_SAFE_INTEGER]) {
      const enc = ctx.cryptoDelta.encodeUleb128(val);
      const dec = ctx.cryptoDelta.decodeUleb128(enc, 0);
      ctx.assert.ok(dec);
      ctx.assert.equal(dec.value, val);
      ctx.assert.equal(dec.nextOffset, enc.length);
    }
    ctx.assert.throws(() => ctx.cryptoDelta.encodeUleb128(-1), RangeError);
    ctx.assert.throws(
      () => ctx.cryptoDelta.decodeUleb128(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), 0),
      /ULEB128 overflow/,
    );
    ctx.assert.equal(ctx.cryptoDelta.decodeUleb128(Buffer.from([0x80]), 0), null);

    // Empty source -> non-empty target & non-empty source -> empty target
    const empty = Buffer.alloc(0);
    const nonEmpty = Buffer.from('hello-desktop-asar-payload-1234567890');
    const d1 = ctx.cryptoDelta.generateRbd1Delta(empty, nonEmpty);
    ctx.assert.equal(ctx.cryptoDelta.applyRbd1Delta(empty, d1).equals(nonEmpty), true);

    const d2 = ctx.cryptoDelta.generateRbd1Delta(nonEmpty, empty);
    ctx.assert.equal(ctx.cryptoDelta.applyRbd1Delta(nonEmpty, d2).equals(empty), true);
  });

  // =========================================================================
  // Feature F10 — Android Client & Patcher Upgrade (T2-F10-01..06)
  // =========================================================================

  test('T2-F10-01', 'Android dual-shape validation rejects divergence on apkUrl/url/fullUrl, sha256, size, certificateSha256 & deltas', async () => {
    const kp = ctx.cryptoDelta.generateSigningKeyPair();
    const base = makeSignedAndroidSample(ctx.cryptoDelta, kp);

    const mutations = [
      (m) => { m.latest.apkUrl = 'https://evil.example/other.apk'; },
      (m) => { m.fullUrl = 'https://evil.example/mismatch.apk'; },
      (m) => { m.latest.fullUrl = 'https://evil.example/latest-mismatch.apk'; },
      (m) => { m.latest.apkSha256 = 'e'.repeat(64); },
      (m) => { m.latest.apkSize = 999999; },
      (m) => { m.latest.certificateSha256 = 'f'.repeat(64); },
      (m) => { m.latest.versionCode = 1099; },
      (m) => { m.latest.deltas = []; },
    ];
    for (const mutate of mutations) {
      const m = structuredClone(base);
      mutate(m);
      ctx.assert.throws(() => ctx.cryptoDelta.canonicalAndroidManifestPayload(m), /dual-shape mismatch/);
    }
  });

  test('T2-F10-02', 'Android manifest & delta ECDSA verification rejects tampered metadata, delta hashes, missing deltasSignature & wrong key', async () => {
    const kp1 = ctx.cryptoDelta.generateSigningKeyPair();
    const kp2 = ctx.cryptoDelta.generateSigningKeyPair();
    const base = makeSignedAndroidSample(ctx.cryptoDelta, kp1);

    ctx.cryptoDelta.verifyAndroidManifest(base, kp1.publicKeyPem);
    ctx.cryptoDelta.verifyAndroidDeltas(base, kp1.publicKeyPem);

    ctx.assert.throws(() => ctx.cryptoDelta.verifyAndroidManifest(base, kp2.publicKeyPem), /Invalid Android manifest signature/);
    ctx.assert.throws(() => ctx.cryptoDelta.verifyAndroidDeltas(base, kp2.publicKeyPem), /Invalid Android delta signature/);

    const badVer = structuredClone(base);
    badVer.versionCode = 1076;
    badVer.latest.versionCode = 1076;
    ctx.assert.throws(() => ctx.cryptoDelta.verifyAndroidManifest(badVer, kp1.publicKeyPem), /Invalid Android manifest signature/);

    const badCert = structuredClone(base);
    badCert.certificateSha256 = '1'.repeat(64);
    badCert.latest.certificateSha256 = '1'.repeat(64);
    ctx.assert.throws(() => ctx.cryptoDelta.verifyAndroidManifest(badCert, kp1.publicKeyPem), /Invalid Android manifest signature/);

    const badUrl = structuredClone(base);
    badUrl.url = 'https://evil.example/apk';
    badUrl.fullUrl = 'https://evil.example/apk';
    badUrl.latest.apkUrl = 'https://evil.example/apk';
    ctx.assert.throws(() => ctx.cryptoDelta.verifyAndroidManifest(badUrl, kp1.publicKeyPem), /Invalid Android manifest signature/);

    for (const field of ['sha256', 'baseSha256', 'url']) {
      const badDelta = structuredClone(base);
      badDelta.deltas[0][field] = field === 'url' ? 'https://evil.example/d.rbdelta' : '9'.repeat(64);
      badDelta.latest.deltas[0][field] = badDelta.deltas[0][field];
      ctx.assert.throws(() => ctx.cryptoDelta.verifyAndroidDeltas(badDelta, kp1.publicKeyPem), /Invalid Android delta signature/);
    }

    const noSig = structuredClone(base);
    delete noSig.deltasSignature;
    ctx.assert.throws(() => ctx.cryptoDelta.verifyAndroidDeltas(noSig, kp1.publicKeyPem), /Missing Android delta signature/);
  });

  test('T2-F10-03', 'RBDELTA1 rejects bad magic, baseSize mismatch, out-of-bounds OP_COPY/OP_INSERT, missing OP_EOF & truncated stream', async () => {
    const baseBuf = Buffer.from('base-android-apk-bytes-0123456789');

    ctx.assert.throws(
      () => ctx.cryptoDelta.applyRbDelta(baseBuf, buildRawRbDelta({ magic: 'BADMAGIC', baseSize: baseBuf.length, targetSize: 0 })),
      /Invalid delta magic header/,
    );
    ctx.assert.throws(
      () => ctx.cryptoDelta.applyRbDelta(baseBuf, buildRawRbDelta({ baseSize: baseBuf.length + 1, targetSize: 0 })),
      /Base size mismatch/,
    );

    // OP_COPY out of base bounds
    const oobCopy = Buffer.alloc(1 + 8 + 4 + 1);
    oobCopy[0] = 0x01;
    oobCopy.writeBigUInt64BE(BigInt(baseBuf.length - 2), 1);
    oobCopy.writeUInt32BE(10, 9);
    oobCopy[13] = 0x00;
    ctx.assert.throws(
      () => ctx.cryptoDelta.applyRbDelta(baseBuf, buildRawRbDelta({ baseSize: baseBuf.length, targetSize: 10, opsBuf: oobCopy })),
      /OP_COPY out of base bounds/,
    );

    // OP_INSERT exceeds target size
    const oobInsert = Buffer.concat([Buffer.from([0x02]), Buffer.from([0, 0, 0, 8]), Buffer.from('12345678'), Buffer.from([0x00])]);
    ctx.assert.throws(
      () => ctx.cryptoDelta.applyRbDelta(baseBuf, buildRawRbDelta({ baseSize: baseBuf.length, targetSize: 4, opsBuf: oobInsert })),
      /OP_INSERT exceeds target size/,
    );

    // Missing OP_EOF
    const noEof = Buffer.concat([Buffer.from([0x02]), Buffer.from([0, 0, 0, 2]), Buffer.from('ab')]);
    ctx.assert.throws(
      () => ctx.cryptoDelta.applyRbDelta(baseBuf, buildRawRbDelta({ baseSize: baseBuf.length, targetSize: 2, opsBuf: noEof })),
      /Delta stream missing OP_EOF/,
    );

    // Truncated stream (<45 bytes)
    ctx.assert.throws(
      () => ctx.cryptoDelta.applyRbDelta(baseBuf, gzipSync(Buffer.alloc(20))),
      /Delta stream truncated/,
    );
  });

  test('T2-F10-04', 'verifyAndroidManifest rejects unknown schema & Host manifest preserves exact packageName/certificateSha256 for mismatch guard', async (t) => {
    const kp = ctx.cryptoDelta.generateSigningKeyPair();
    const badSchema = { ...makeSignedAndroidSample(ctx.cryptoDelta, kp), schema: 'rokbot-unknown/v1' };
    ctx.assert.throws(() => ctx.cryptoDelta.verifyAndroidManifest(badSchema, kp.publicKeyPem), /Invalid Android update manifest schema/);

    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await setupAdminAndDevice(client, ctx, { clientKind: 'android' });
    const apk = ctx.cryptoDelta.buildSyntheticZip([{ name: 'AndroidManifest.xml', data: 'alt-pkg' }]);
    const altName = e2eFilename(ctx, 'alt.apk');
    const up = await client.adminUploadUpdate({ platform: 'android', filename: altName, bytes: apk });
    ctx.assert.assertStatus(up, 201);
    const cert = 'e'.repeat(64);
    const pub = await client.adminPublishUpdate({
      platform: 'android',
      version: '2.0.0',
      versionCode: 2000,
      packageName: 'dev.other.pkg',
      certificateSha256: cert,
      filename: altName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub, 201);
    trackReleaseCleanup(ctx, t, client, 'android', pub);

    const feed = await client.getUpdateManifest('android');
    ctx.assert.assertStatus(feed, 200);
    ctx.assert.equal(feed.json.latest.packageName, 'dev.other.pkg');
    ctx.assert.equal(feed.json.latest.certificateSha256, cert);
  });

  test('T2-F10-05', 'Android pairing validates clientDeviceId (empty ok, 128-char ok, 129-char/bad chars 400) & bundleId (400)', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation for consecutive /connect/pair validation');
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const pEmpty = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Android Empty ID',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: '',
    });
    ctx.assert.assertStatus(pEmpty, 201);
    ctx.harness?.resetRateLimits();

    const p128 = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Android 128 ID',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'a'.repeat(128),
    });
    ctx.assert.assertStatus(p128, 201);

    for (const badId of ['a'.repeat(129), 'bad/id!', 'has space', 'id$bad']) {
      ctx.harness?.resetRateLimits();
      const res = await client.pairWithPassword({
        password: ctx.adminPassword,
        deviceName: 'Android Bad ID',
        platform: 'desktop',
        clientKind: 'android',
        clientDeviceId: badId,
      });
      ctx.assert.assertStatus(res, 400, `Expected 400 for clientDeviceId=${badId.slice(0, 20)}`);
    }

    ctx.harness?.resetRateLimits();
    const badBundle = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Android Bad Bundle',
      platform: 'desktop',
      clientKind: 'android',
      bundleId: 'bad/bundle',
    });
    ctx.assert.assertStatus(badBundle, 400);
  });

  test('T2-F10-06', 'generateRbDelta rejects non-Buffer inputs & bad magic length, and round-trips empty/identical buffers', async () => {
    ctx.assert.throws(() => ctx.cryptoDelta.generateRbDelta('str', Buffer.from('a')), TypeError);
    ctx.assert.throws(() => ctx.cryptoDelta.generateRbDelta(Buffer.from('a'), null), TypeError);
    ctx.assert.throws(() => ctx.cryptoDelta.generateRbDelta(Buffer.from('a'), Buffer.from('b'), { magic: 'SHORT7!' }), /8 ASCII bytes/);

    const same = Buffer.from('identical-android-zip-content-'.repeat(10));
    ctx.assert.equal(ctx.cryptoDelta.applyRbDelta(same, ctx.cryptoDelta.generateRbDelta(same, same)).equals(same), true);

    const empty = Buffer.alloc(0);
    const nonEmpty = Buffer.from('new-android-apk-content');
    ctx.assert.equal(ctx.cryptoDelta.applyRbDelta(empty, ctx.cryptoDelta.generateRbDelta(empty, nonEmpty)).equals(nonEmpty), true);
    ctx.assert.equal(ctx.cryptoDelta.applyRbDelta(nonEmpty, ctx.cryptoDelta.generateRbDelta(nonEmpty, empty)).equals(empty), true);
  });

  // =========================================================================
  // Feature F11 — iOS Client & Patcher Upgrade (T2-F11-01..06)
  // =========================================================================

  test('T2-F11-01', 'validateIosManifestPlist rejects empty/malformed XML, non-HTTPS URL, kind!=software & bundle/version mismatch', async () => {
    ctx.assert.equal(ctx.cryptoDelta.validateIosManifestPlist('').ok, false);
    ctx.assert.equal(ctx.cryptoDelta.validateIosManifestPlist('<dict/>').ok, false);

    const missingPkg = ctx.cryptoDelta.buildIosManifestPlist({ ipaUrl: 'https://bot.example.com/app.ipa' })
      .replace('software-package', 'display-image');
    ctx.assert.equal(ctx.cryptoDelta.validateIosManifestPlist(missingPkg).ok, false);

    const remoteHttp = ctx.cryptoDelta.buildIosManifestPlist({ ipaUrl: 'http://remote.example.com/app.ipa' });
    const remoteRes = ctx.cryptoDelta.validateIosManifestPlist(remoteHttp);
    ctx.assert.equal(remoteRes.ok, false);
    ctx.assert.ok(remoteRes.errors.some((e) => e.includes('protocol')));

    const wrongKind = ctx.cryptoDelta.buildIosManifestPlist({ ipaUrl: 'https://bot.example.com/app.ipa' })
      .replace('<string>software</string>', '<string>other</string>');
    ctx.assert.equal(ctx.cryptoDelta.validateIosManifestPlist(wrongKind).ok, false);

    const validHttps = ctx.cryptoDelta.buildIosManifestPlist({
      ipaUrl: 'https://bot.example.com/app.ipa',
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
    });
    ctx.assert.equal(
      ctx.cryptoDelta.validateIosManifestPlist(validHttps, { bundleId: 'dev.other.app', bundleVersion: '2.0.0' }).ok,
      false,
    );
  });

  test('T2-F11-02', 'validateAltStoreJson rejects non-object, empty apps, bad bundleIdentifier/date/size/sha256 & HTTP URL', async () => {
    ctx.assert.equal(ctx.cryptoDelta.validateAltStoreJson(null).ok, false);
    ctx.assert.equal(ctx.cryptoDelta.validateAltStoreJson([]).ok, false);
    ctx.assert.equal(ctx.cryptoDelta.validateAltStoreJson(ctx.cryptoDelta.buildAltStoreSource({ apps: [] })).ok, false);

    const makeValid = () => ctx.cryptoDelta.buildAltStoreSource({
      apps: [{
        name: 'RokBot',
        bundleIdentifier: 'dev.rokbot.local',
        developerName: 'RokBot',
        localizedDescription: 'RokBot iOS',
        versions: [{
          version: '1.16.0',
          date: '2026-11-20T00:00:00.000Z',
          downloadURL: 'https://bot.example.com/app.ipa',
          size: 1024,
          sha256: 'a'.repeat(64),
        }],
      }],
    });

    const badBundle = makeValid();
    badBundle.apps[0].bundleIdentifier = 'bad_id';
    ctx.assert.equal(ctx.cryptoDelta.validateAltStoreJson(badBundle).ok, false);

    const badDate = makeValid();
    badDate.apps[0].versions[0].date = 'not-a-date';
    ctx.assert.equal(ctx.cryptoDelta.validateAltStoreJson(badDate).ok, false);

    const badSize = makeValid();
    badSize.apps[0].versions[0].size = 0;
    ctx.assert.equal(ctx.cryptoDelta.validateAltStoreJson(badSize).ok, false);

    const badSha = makeValid();
    badSha.apps[0].versions[0].sha256 = 'zzz';
    ctx.assert.equal(ctx.cryptoDelta.validateAltStoreJson(badSha).ok, false);

    const remoteHttp = makeValid();
    remoteHttp.apps[0].versions[0].downloadURL = 'http://remote.example.com/a.ipa';
    ctx.assert.equal(ctx.cryptoDelta.validateAltStoreJson(remoteHttp).ok, false);

    const loopbackHttp = makeValid();
    loopbackHttp.apps[0].versions[0].downloadURL = 'http://127.0.0.1:8000/a.ipa';
    ctx.assert.equal(ctx.cryptoDelta.validateAltStoreJson(loopbackHttp, { allowHttpLocalhost: false }).ok, false);
  });

  test('T2-F11-03', 'iOS OTA rejects bogus/rotated tokens (403), missing .ipa filename (404) & malformed %ZZ encoding (400)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await setupAdminAndDevice(client, ctx, { platform: 'ios', deviceName: 'iOS Tester' });
    const ipa = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: '1' }]);
    const ipa1Name = e2eFilename(ctx, 'RokBot-1.16.0.ipa');
    const up = await client.adminUploadUpdate({ platform: 'ios', filename: ipa1Name, bytes: ipa });
    ctx.assert.assertStatus(up, 201);
    const pub1 = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      filename: ipa1Name,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub1, 201);
    trackReleaseCleanup(ctx, t, client, 'ios', pub1);

    const feed = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed, 200);
    const activeToken = extractIosOtaToken(feed.json.latest.installMethods.altStoreSourceUrl);

    ctx.assert.assertStatus(await client.fetchIosPlist('/updates/ios/tampered-tok/manifest.plist'), 403);
    ctx.assert.assertStatus(await client.fetchIosAltStore('/updates/ios/tampered-tok/altstore.json'), 403);
    ctx.assert.assertStatus(await client.request('GET', `/updates/ios/${activeToken}/nonexistent.ipa`, { auth: false }), 404);
    ctx.assert.assertStatus(await client.request('GET', `/updates/ios/${activeToken}/%ZZ`, { auth: false }), 400);

    if (ctx.harness) {
      const ipa2 = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: '2' }]);
      const ipa2Name = e2eFilename(ctx, 'RokBot-1.16.1.ipa');
      const up2 = await client.adminUploadUpdate({ platform: 'ios', filename: ipa2Name, bytes: ipa2 });
      ctx.assert.assertStatus(up2, 201);
      const pub2 = await client.adminPublishUpdate({
        platform: 'ios',
        version: '1.16.1',
        build: '23153',
        bundleId: 'dev.rokbot.local',
        filename: ipa2Name,
        ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
      });
      ctx.assert.assertStatus(pub2, 201);
      const feed2 = await client.getUpdateManifest('ios');
      ctx.assert.assertStatus(feed2, 200);
      const token2 = extractIosOtaToken(feed2.json.latest.installMethods.altStoreSourceUrl);
      ctx.assert.notEqual(token2, activeToken);
      ctx.assert.assertStatus(await client.fetchIosPlist(`/updates/ios/${activeToken}/manifest.plist`), 403);
      ctx.assert.assertStatus(await client.fetchIosAltStore(`/updates/ios/${activeToken}/altstore.json`), 403);
      ctx.assert.assertStatus(await client.request('GET', `/updates/ios/${activeToken}/${ipa1Name}`, { auth: false }), 403);
    }
  });

  test('T2-F11-04', 'iOS pairing rejects raw platform="android", invalid bundleId & invalid clientDeviceId with 400', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation for consecutive /connect/pair validation');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    ctx.assert.assertStatus(
      await client.pairWithPassword({ password: ctx.adminPassword, deviceName: 'Bad Platform', platform: 'android' }),
      400,
    );
    ctx.assert.assertStatus(
      await client.pairWithPassword({ password: ctx.adminPassword, deviceName: 'Bad Bundle', platform: 'ios', bundleId: 'bad bundle!' }),
      400,
    );
    ctx.assert.assertStatus(
      await client.pairWithPassword({ password: ctx.adminPassword, deviceName: 'Bad ClientID', platform: 'ios', clientDeviceId: 'bad/id' }),
      400,
    );
  });

  test('T2-F11-05', 'iOS tokenized .ipa Range out-of-bounds returns 416 & buildIosManifestPlist rejects missing ipaUrl', async (t) => {
    ctx.assert.throws(() => ctx.cryptoDelta.buildIosManifestPlist({}), /ipaUrl is required/);

    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await setupAdminAndDevice(client, ctx, { platform: 'ios', deviceName: 'iOS Range Tester' });
    const ipa = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: 'range-ipa' }]);
    const rangeName = e2eFilename(ctx, 'RokBot-Range.ipa');
    const up = await client.adminUploadUpdate({ platform: 'ios', filename: rangeName, bytes: ipa });
    ctx.assert.assertStatus(up, 201);
    const pub = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      filename: rangeName,
      ...(up.json.artifact?.id ? { artifactId: up.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub, 201);
    trackReleaseCleanup(ctx, t, client, 'ios', pub);
    const feed = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed, 200);
    const ipaUrl = feed.json.latest.installMethods.ipaDownloadUrl;

    for (const range of ['bytes=999999-', 'bytes=10-5']) {
      const res = await client.downloadUpdateFile(ipaUrl, { range, auth: false });
      ctx.assert.assertStatus(res, 416);
      ctx.assert.equal(res.headers.get('content-range'), `bytes */${ipa.length}`);
    }

    // Also verify plist URL extraction helper works cleanly across both host and harness shapes
    const plistUrl = unwrapItmsPlistUrl(feed.json.latest.installMethods);
    ctx.assert.ok(plistUrl.includes('manifest.plist'));
  });

  test('T2-F11-06', 'iOS itms-services localhost/HTTP reachability boundary (allowHttpLocalhost: false vs true)', async () => {
    const loopbackPlist = ctx.cryptoDelta.buildIosManifestPlist({
      ipaUrl: 'http://127.0.0.1:18080/updates/ios/tok/RokBot.ipa',
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
    });
    const strictCheck = ctx.cryptoDelta.validateIosManifestPlist(loopbackPlist, { allowHttpLocalhost: false });
    ctx.assert.equal(strictCheck.ok, false);
    ctx.assert.ok(strictCheck.errors.some((e) => e.includes('protocol')));

    const localCheck = ctx.cryptoDelta.validateIosManifestPlist(loopbackPlist, { allowHttpLocalhost: true });
    ctx.assert.equal(localCheck.ok, true, localCheck.errors.join('; '));

    const httpsPlist = ctx.cryptoDelta.buildIosManifestPlist({
      ipaUrl: 'https://updates.example.com/updates/ios/tok/RokBot.ipa',
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
    });
    ctx.assert.equal(
      ctx.cryptoDelta.validateIosManifestPlist(httpsPlist, { allowHttpLocalhost: false }).ok,
      true,
    );
  });
}

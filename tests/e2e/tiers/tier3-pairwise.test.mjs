import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const tier = 3;
export const name = 'pairwise-combinations';

const SYNTHETIC_ROKBOT_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
  '  <path class="brand-face" d="M 20 30 C 20 10 80 10 80 30 C 92 50 85 82 50 86 C 15 82 8 50 20 30 C 22 26 24 28 20 30 Z" fill="#111111"/>',
  '  <rect class="brand-eye" x="30" y="38" width="10" height="18" rx="4" transform="rotate(-26 35 47)" fill="#ffffff"/>',
  '  <rect class="brand-eye" x="58" y="40" width="10" height="12" rx="4" transform="rotate(-26 63 46)" fill="#ffffff"/>',
  '  <circle class="brand-accent" cx="76" cy="24" r="6" fill="#22c55e"/>',
  '</svg>',
].join('\n');

const SYNTHETIC_COMPOSE_YML = [
  'name: rokbot',
  'services:',
  '  host:',
  '    image: ${ROKBOT_HOST_IMAGE:-ghcr.io/hongfaqiu/rokbot/host:latest}',
  '    ports:',
  '      - "${ROKBOT_LISTEN_ADDRESS:-127.0.0.1}:${ROKBOT_PUBLIC_PORT:-18080}:8000"',
  '    environment:',
  '      ROKBOT_BOX_TOKEN: ${ROKBOT_BOX_TOKEN:-local}',
  '      ROKBOT_TEST_SECRET: ${ROKBOT_TEST_SECRET:?Set ROKBOT_TEST_SECRET}',
  '      ROKBOT_DEFAULT_MACHINE_ID: ${ROKBOT_DEFAULT_MACHINE_ID:-}',
  '    healthcheck:',
  '      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:8000/health\').then(r=>process.exit(r.ok?0:1))"]',
  '      interval: 15s',
  '      timeout: 10s',
  '      retries: 3',
  '  box:',
  '    image: ${ROKBOT_BOX_IMAGE:-ghcr.io/hongfaqiu/rokbot/box:2bb5e41}',
].join('\n');

const SYNTHETIC_ENV_EXAMPLE = [
  'ROKBOT_LISTEN_ADDRESS=127.0.0.1',
  'ROKBOT_PUBLIC_PORT=18080',
  'ROKBOT_HOST_IMAGE=ghcr.io/hongfaqiu/rokbot/host:latest',
  'ROKBOT_BOX_IMAGE=ghcr.io/hongfaqiu/rokbot/box:2bb5e41',
  'ROKBOT_BOX_TOKEN=local',
  'ROKBOT_TEST_SECRET=',
  'ROKBOT_ALLOW_DEVICE_MODEL_CONFIG=1',
  'ROKBOT_UPDATE_DIR=/data/updates',
].join('\n');

const SYNTHETIC_INSTALL_SCRIPT = [
  '#!/usr/bin/env bash',
  'set -Eeuo pipefail',
  'prepare_only=false',
  'offline=false',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    --prepare-only) prepare_only=true ;;',
  '    --offline) offline=true ;;',
  '    --local|--pull-never) ;;',
  '  esac',
  'done',
  'DOWNLOAD_BASE="${ROKBOT_DOWNLOAD_BASE:-https://raw.githubusercontent.com/hongfaqiu/rokbot/main/host/release}"',
  'case "$DOWNLOAD_BASE" in',
  '  https://*|file://*) ;;',
  '  *) echo "ROKBOT_DOWNLOAD_BASE must use https:// or file://." >&2; exit 1 ;;',
  'esac',
  'command -v docker >/dev/null 2>&1 || { echo "docker required" >&2; exit 1; }',
  'docker compose version >/dev/null 2>&1 || { echo "compose required" >&2; exit 1; }',
  'umask 077',
  'if [[ ! -f .env ]]; then',
  '  : > .env.tmp',
  '  while IFS= read -r line || [[ -n "$line" ]]; do',
  '    if [[ "$line" == "ROKBOT_TEST_SECRET=" ]]; then',
  '      printf "ROKBOT_TEST_SECRET=%s\\n" "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d " \\n")" >> .env.tmp',
  '    else',
  '      printf "%s\\n" "$line" >> .env.tmp',
  '    fi',
  '  done < .env.images.example',
  '  chmod 600 .env.tmp',
  '  mv .env.tmp .env',
  'fi',
  'docker compose --env-file .env -f docker-compose.images.yml config --environment >/dev/null',
  'if [[ "$prepare_only" == true ]]; then',
  '  echo "RokBot files are ready (offline=$offline)."',
  '  exit 0',
  'fi',
].join('\n');

const LIVE_SESSION_CACHE_KEY = Symbol.for('rokbot.e2e.liveSessionCache');
const S2_LIVE_CACHE_KEY = Symbol.for('rokbot.e2e.s2.liveCache');

function getS2LiveCache(ctx) {
  if (ctx.harness) return null;
  let wm = globalThis[S2_LIVE_CACHE_KEY];
  if (!wm) {
    wm = new WeakMap();
    globalThis[S2_LIVE_CACHE_KEY] = wm;
  }
  let s2 = wm.get(ctx);
  if (!s2) {
    s2 = { adminCookie: null, deviceToken: ctx.deviceToken || null, deviceId: null, webCookie: null };
    wm.set(ctx, s2);
  }
  return s2;
}

function getLiveSessionEntry(ctx) {
  let root = globalThis[LIVE_SESSION_CACHE_KEY];
  if (!root) {
    root = new Map();
    globalThis[LIVE_SESSION_CACHE_KEY] = root;
  }
  const cacheKey = `${ctx.baseUrl}::${ctx.adminPassword || ''}`;
  let entry = root.get(cacheKey);
  if (!entry) {
    entry = { adminCookies: new Map(), deviceToken: null, deviceId: null };
    root.set(cacheKey, entry);
  }
  const s2 = getS2LiveCache(ctx);
  if (s2) {
    if (!entry.deviceToken && s2.deviceToken) {
      entry.deviceToken = s2.deviceToken;
      entry.deviceId = s2.deviceId;
    }
    if (entry.adminCookies.size === 0 && s2.adminCookie) {
      entry.adminCookies.set('rokbot_admin', s2.adminCookie);
    }
  }
  return entry;
}

function resolveIosPlistUrl(methods) {
  if (typeof methods?.manifestPlistUrl === 'string' && methods.manifestPlistUrl) {
    return methods.manifestPlistUrl;
  }
  const raw = String(methods?.itmsServicesUrl || '');
  if (raw.startsWith('itms-services://')) {
    try {
      const parsed = new URL(raw.replace(/^itms-services:\/\//, 'https://dummy'));
      const target = parsed.searchParams.get('url');
      if (target) return target;
    } catch {}
  }
  return raw;
}

async function setupPairwiseTest(t, ctx, resetOpts = {}, clientOpts = {}) {
  if (ctx.harness) {
    await ctx.harness.resetState(resetOpts);
  }
  const client = ctx.createClient(clientOpts);
  t.after(() => client.close());
  return client;
}

async function ensureAdminLogin(client, ctx) {
  if (!ctx.adminPassword) {
    throw new Error('Admin password is required for admin-authenticated test operations');
  }
  if (ctx.harness) {
    const res = await client.adminLogin(ctx.adminPassword);
    ctx.assert.assertStatus(res, 200, 'adminLogin');
    return res;
  }
  const entry = getLiveSessionEntry(ctx);
  if (entry.adminCookies.size > 0) {
    for (const [k, v] of entry.adminCookies) {
      client.cookies.set(k, v);
    }
    const sess = await client.adminSession();
    if (sess.ok && sess.json?.authenticated) {
      return sess;
    }
    entry.adminCookies.clear();
    client.cookies.delete('rokbot_admin');
  }
  const res = await client.adminLogin(ctx.adminPassword);
  ctx.assert.assertStatus(res, 200, 'adminLogin');
  for (const [k, v] of client.cookies) {
    if (k !== 'rokbot_web') entry.adminCookies.set(k, v);
  }
  const s2 = getS2LiveCache(ctx);
  if (s2 && client.cookies.has('rokbot_admin')) {
    s2.adminCookie = client.cookies.get('rokbot_admin');
  }
  return res;
}

async function ensureSharedLiveDevice(client, ctx) {
  if (ctx.deviceToken) {
    client.setBearerToken(ctx.deviceToken, null);
    return { status: 201, ok: true, json: { deviceId: null, token: ctx.deviceToken, reused: true } };
  }
  const entry = getLiveSessionEntry(ctx);
  const s2 = getS2LiveCache(ctx);
  if (entry.deviceToken) {
    const checkRes = await client.localStatus({ bearer: entry.deviceToken });
    if (checkRes.status === 200) {
      client.setBearerToken(entry.deviceToken, entry.deviceId);
      return { status: 201, ok: true, json: { deviceId: entry.deviceId, token: entry.deviceToken, reused: true } };
    }
    entry.deviceToken = null;
    entry.deviceId = null;
    if (s2) {
      s2.deviceToken = null;
      s2.deviceId = null;
    }
  }
  await ensureAdminLogin(client, ctx);
  const keyRes = await client.createPairingKey();
  ctx.assert.assertStatus(keyRes, 201, 'createPairingKey');
  const pairRes = await client.pairWithKey({
    pairingKey: keyRes.json.pairingKey,
    deviceName: 'RokBot E2E Shared Live Device',
    platform: 'desktop',
    clientDeviceId: 'rokbot-e2e-shared-live-device',
  });
  ctx.assert.assertStatus(pairRes, 201, 'pair shared live device');
  entry.deviceToken = pairRes.json.token;
  entry.deviceId = pairRes.json.deviceId;
  if (s2) {
    s2.deviceToken = entry.deviceToken;
    s2.deviceId = entry.deviceId;
  }
  client.setBearerToken(entry.deviceToken, entry.deviceId);
  return pairRes;
}

async function pairDeviceWithCleanup(t, client, ctx, {
  deviceName,
  platform = 'desktop',
  clientKind,
  clientDeviceId,
  bundleId,
  usePassword = false,
  forceNewPair = false,
} = {}) {
  if (!ctx.harness && !forceNewPair) {
    return ensureSharedLiveDevice(client, ctx);
  }
  let res;
  if (usePassword) {
    res = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName,
      platform,
      clientKind,
      clientDeviceId,
      bundleId,
    });
  } else {
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201, 'createPairingKey');
    res = await client.pairWithKey({
      pairingKey: keyRes.json.pairingKey,
      deviceName,
      platform,
      clientKind,
      clientDeviceId,
      bundleId,
    });
  }
  ctx.assert.assertStatus(res, 201, `pair ${deviceName}`);
  if (!ctx.harness && res.json?.deviceId) {
    const devId = res.json.deviceId;
    t.after(async () => {
      await client.revokeDevice(devId).catch(() => {});
    });
  }
  return res;
}

function registerUpdateCleanup(t, client, ctx, platform, releaseId) {
  if (!ctx.harness && releaseId) {
    t.after(async () => {
      await client.adminDeleteUpdate(platform, releaseId).catch(() => {});
    });
  }
}

async function pollUntil(fn, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastVal;
  while (Date.now() < deadline) {
    lastVal = await fn();
    if (lastVal.done) return lastVal.value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return lastVal?.value;
}

export function registerTests(test, ctx) {
  // T3-01: Pair -> needsModel -> /local/model probe + save -> chat/SSE stream
  test('T3-01', 'Pair -> needsModel -> /local/model probe + save -> chat/SSE stream', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness resetState({ needsModel: true })');
    }
    const client = await setupPairwiseTest(t, ctx, { needsModel: true });
    await ensureAdminLogin(client, ctx);

    const pubBefore = await client.connectStatus({ auth: false });
    ctx.assert.assertStatus(pubBefore, 200);
    ctx.assert.equal(pubBefore.json.needsModel, true);

    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Onboarding Android',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 't3-01-and-device',
    });

    const locBefore = await client.localStatus();
    ctx.assert.assertStatus(locBefore, 200);
    ctx.assert.equal(locBefore.json.needsModel, true);
    ctx.assert.equal(locBefore.json.canConfigureModel, false);

    const blockedPrompt = await client.apiCall('sendPrompt', { prompt: 'hello before model' });
    ctx.assert.assertStatus(blockedPrompt, 409);

    const testKey = 'sk-t301-onboarding-key-123456';
    const catalogRes = await client.probeModelCatalog(
      { baseUrl: 'https://api.openai.com/v1', apiKey: testKey },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(catalogRes, 200);
    ctx.assert.ok(Array.isArray(catalogRes.json.models) && catalogRes.json.models.length > 0);
    const chosenModel = catalogRes.json.models[0].id;

    const testRes = await client.testModel(
      { baseUrl: 'https://api.openai.com/v1', apiKey: testKey, model: chosenModel },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(testRes, 200);
    ctx.assert.equal(testRes.json.reply, 'OK');
    ctx.assert.equal(testRes.json.model, chosenModel);

    const putRes = await client.putLocalModel(
      {
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: chosenModel,
        apiKey: testKey,
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(putRes, 200);
    ctx.assert.equal(putRes.json.reload.status, 'applied');
    ctx.assert.equal(putRes.json.config.hasApiKey, true);
    ctx.assert.assertNoSecrets(putRes.json, [testKey, ctx.adminPassword], { forbidTokenKey: true });

    const pubAfter = await client.connectStatus({ auth: false });
    ctx.assert.assertStatus(pubAfter, 200);
    ctx.assert.equal(pubAfter.json.needsModel, false);

    const sse = await client.openSse('/events');
    t.after(() => sse.close());
    const promptRes = await client.apiCall('sendPrompt', { prompt: 'first rokbot chat' });
    ctx.assert.assertStatus(promptRes, 200);

    const chunkEv = await sse.nextEvent((ev) => ev.data?.channel === 'agent-chunk', 3000);
    ctx.assert.ok(typeof chunkEv.data.payload.delta === 'string');
    const doneEv = await sse.nextEvent((ev) => ev.data?.channel === 'agent-done', 3000);
    ctx.assert.equal(doneEv.data.payload.reply, 'OK: first rokbot chat');
    ctx.assert.equal(doneEv.data.payload.model, chosenModel);
  });

  // T3-02: Admin update upload -> RBDELTA1 delta generation -> Android manifest -> SHA-256 & cert verification
  test('T3-02', 'Admin upload -> RBDELTA1 delta -> Android manifest -> SHA-256 & cert verification', async (t) => {
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Android Updater',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 't3-02-and-upd',
    });

    const apkV1 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'AndroidManifest.xml', data: Buffer.from('android-manifest-v1-'.repeat(20)) },
      { name: 'classes.dex', data: Buffer.from('dex-shared-bytecode-block-'.repeat(250)) },
      { name: 'lib/arm64-v8a/libtailcat.so', data: Buffer.from('so-shared-bytes-'.repeat(80)) },
    ]);
    const apkV2 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'AndroidManifest.xml', data: Buffer.from('android-manifest-v2-'.repeat(20)) },
      { name: 'classes.dex', data: Buffer.from('dex-shared-bytecode-block-'.repeat(250)) },
      { name: 'lib/arm64-v8a/libtailcat.so', data: Buffer.from('so-shared-bytes-'.repeat(80)) },
      { name: 'assets/model-ui.json', data: Buffer.from('{"inAppModelConfig":true}'.repeat(20)) },
    ]);
    const certSha = 'a1'.repeat(32);

    const upV1 = await client.adminUploadUpdate({
      platform: 'android',
      filename: 'rokbot-1.16.0.apk',
      bytes: apkV1,
      multipart: false,
    });
    ctx.assert.assertStatus(upV1, 201);
    const pubV1 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.16.0',
      versionCode: 160,
      packageName: 'dev.rokbot.nativeapp',
      certificateSha256: certSha,
      filename: 'rokbot-1.16.0.apk',
      ...(upV1.json.artifact?.id ? { artifactId: upV1.json.artifact.id } : {}),
      releaseNotes: 'Base Android release',
    });
    ctx.assert.assertStatus(pubV1, 201);
    registerUpdateCleanup(t, client, ctx, 'android', pubV1.json.release.id);

    const upV2 = await client.adminUploadUpdate({
      platform: 'android',
      filename: 'rokbot-1.17.0.apk',
      bytes: apkV2,
      multipart: Boolean(ctx.harness),
    });
    ctx.assert.assertStatus(upV2, 201);
    const pubV2 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.17.0',
      versionCode: 170,
      packageName: 'dev.rokbot.nativeapp',
      certificateSha256: certSha,
      filename: 'rokbot-1.17.0.apk',
      ...(upV2.json.artifact?.id ? { artifactId: upV2.json.artifact.id } : {}),
      generateDeltaFrom: upV1.json.artifact?.id ?? pubV1.json.release?.id ?? 'rokbot-1.16.0.apk',
      releaseNotes: 'Incremental Android release',
    });
    ctx.assert.assertStatus(pubV2, 201);
    registerUpdateCleanup(t, client, ctx, 'android', pubV2.json.release.id);

    const manifestRes = await client.getUpdateManifest('android');
    ctx.assert.assertStatus(manifestRes, 200);
    const manifest = manifestRes.json;
    ctx.assert.equal(manifest.schema, ctx.cryptoDelta.ANDROID_NATIVE_UPDATE_SCHEMA);
    ctx.assert.equal(manifest.latest.packageName, 'dev.rokbot.nativeapp');
    ctx.assert.equal(manifest.latest.certificateSha256, certSha);

    if (ctx.harness || (manifest.signature && manifest.publicKeyPem)) {
      ctx.cryptoDelta.verifyAndroidManifest(manifest, manifest.publicKeyPem);
      ctx.cryptoDelta.verifyAndroidDeltas(manifest, manifest.publicKeyPem);
    }

    const deltaRec = manifest.latest.deltas[0];
    ctx.assert.ok(deltaRec, 'Android manifest must contain delta entry');
    ctx.assert.equal(deltaRec.format, 'RBDELTA1');
    if (ctx.harness) {
      ctx.assert.ok(deltaRec.url.includes('?artifactId='), 'Delta URL must preserve ?artifactId=');
    }

    const rangeRes = await client.downloadUpdateFile(deltaRec.url, { range: 'bytes=0-15' });
    ctx.assert.assertStatus(rangeRes, 206);
    ctx.assert.equal(rangeRes.buffer.length, 16);
    ctx.assert.ok(rangeRes.headers.get('content-range')?.startsWith('bytes 0-15/'));

    const fullDeltaRes = await client.downloadUpdateFile(deltaRec.url);
    ctx.assert.assertStatus(fullDeltaRes, 200);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(fullDeltaRes.buffer), deltaRec.sha256);

    const deltaHdr = ctx.cryptoDelta.inspectRbDeltaHeader(fullDeltaRes.buffer);
    ctx.assert.equal(deltaHdr.magic, 'RBDELTA1');
    ctx.assert.equal(deltaHdr.baseSize, apkV1.length);
    ctx.assert.equal(deltaHdr.targetSize, apkV2.length);

    const rebuiltApk = ctx.cryptoDelta.applyRbDelta(apkV1, fullDeltaRes.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuiltApk), ctx.cryptoDelta.sha256Hex(apkV2));
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuiltApk), manifest.latest.apkSha256);
  });

  // T3-03: Admin desktop upload -> RBD1 ASAR/installer delta -> ECDSA P-256 verify -> reconstruction + tamper reject
  test('T3-03', 'Admin desktop upload -> RBD1 ASAR/installer delta -> ECDSA P-256 verify & reconstruction', async (t) => {
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Desktop Updater',
      platform: 'desktop',
      clientDeviceId: 't3-03-desk-upd',
    });

    // macOS ASAR path -> asarDeltas (harness) or deltas/asarDeltas (live)
    const asar1 = ctx.cryptoDelta.buildSyntheticAsar(
      { files: { 'main.js': { size: 4096, offset: '0' } } },
      Buffer.alloc(4096, 0x31),
    );
    const asar2 = ctx.cryptoDelta.buildSyntheticAsar(
      { files: { 'main.js': { size: 4096, offset: '0' }, 'models.js': { size: 256, offset: '4096' } } },
      Buffer.concat([Buffer.alloc(4096, 0x31), Buffer.alloc(256, 0x32)]),
    );

    const upM1 = await client.adminUploadUpdate({ platform: 'macos', filename: 'app-1.2.2.asar', bytes: asar1.bytes });
    ctx.assert.assertStatus(upM1, 201);
    const upM2 = await client.adminUploadUpdate({ platform: 'macos', filename: 'app-1.2.3.asar', bytes: asar2.bytes });
    ctx.assert.assertStatus(upM2, 201);
    const pubMac = await client.adminPublishUpdate({
      platform: 'macos',
      version: '1.2.3',
      filename: 'app-1.2.3.asar',
      ...(upM2.json.artifact?.id ? { artifactId: upM2.json.artifact.id } : {}),
      asarSha256: asar2.sha256,
      asarHeaderSha256: asar2.headerSha256,
      generateDeltaFrom: upM1.json.artifact?.id ?? 'app-1.2.2.asar',
    });
    ctx.assert.assertStatus(pubMac, 201);
    registerUpdateCleanup(t, client, ctx, 'macos', pubMac.json.release.id);

    const macFeed = await client.getUpdateManifest('macos');
    ctx.assert.assertStatus(macFeed, 200);
    ctx.assert.equal(macFeed.json.schema, ctx.cryptoDelta.DESKTOP_UPDATE_SCHEMA);
    ctx.cryptoDelta.verifyDesktopManifest(macFeed.json, macFeed.json.publicKeyPem);
    ctx.cryptoDelta.verifyDesktopDeltas(macFeed.json, macFeed.json.publicKeyPem);

    let asarDeltaUrl;
    if (ctx.harness) {
      ctx.assert.equal(macFeed.json.latest.asarDeltas.length, 1);
      ctx.assert.equal(macFeed.json.latest.deltas.length, 0);
      asarDeltaUrl = macFeed.json.latest.asarDeltas[0].url;
    } else {
      const macDeltas = macFeed.json.latest.asarDeltas?.length
        ? macFeed.json.latest.asarDeltas
        : macFeed.json.latest.deltas;
      ctx.assert.equal(macDeltas.length, 1, 'Expected desktop delta entry for macOS ASAR');
      asarDeltaUrl = macDeltas[0].url;
    }

    const macDeltaDl = await client.downloadUpdateFile(asarDeltaUrl);
    ctx.assert.assertStatus(macDeltaDl, 200);
    const macRbdHdr = ctx.cryptoDelta.inspectRbd1Header(macDeltaDl.buffer);
    ctx.assert.equal(macRbdHdr.magic, 'RBD1');
    ctx.assert.equal(macRbdHdr.targetSha256, asar2.sha256);

    const rebuiltAsar = ctx.cryptoDelta.applyRbd1Delta(asar1.bytes, macDeltaDl.buffer);
    const asarInfo = await ctx.cryptoDelta.readAsarHeaderInfo(rebuiltAsar);
    ctx.assert.equal(asarInfo.sha256, asar2.sha256);
    ctx.assert.equal(asarInfo.headerSha256, asar2.headerSha256);

    // Windows installer path -> deltas
    const win1 = Buffer.concat([Buffer.from('ROKBOT-WIN-INST-'), Buffer.alloc(4096, 0x55)]);
    const win2 = Buffer.concat([Buffer.from('ROKBOT-WIN-INST-'), Buffer.alloc(3840, 0x55), Buffer.alloc(512, 0x66)]);
    const upW1 = await client.adminUploadUpdate({ platform: 'windows', filename: 'RokBot-1.2.2-Setup.exe', bytes: win1 });
    ctx.assert.assertStatus(upW1, 201);
    const upW2 = await client.adminUploadUpdate({ platform: 'windows', filename: 'RokBot-1.2.3-Setup.exe', bytes: win2 });
    ctx.assert.assertStatus(upW2, 201);
    const pubWin = await client.adminPublishUpdate({
      platform: 'windows',
      version: '1.2.3',
      filename: 'RokBot-1.2.3-Setup.exe',
      ...(upW2.json.artifact?.id ? { artifactId: upW2.json.artifact.id } : {}),
      generateDeltaFrom: upW1.json.artifact?.id ?? 'RokBot-1.2.2-Setup.exe',
    });
    ctx.assert.assertStatus(pubWin, 201);
    registerUpdateCleanup(t, client, ctx, 'windows', pubWin.json.release.id);

    const winFeed = await client.getUpdateManifest('windows');
    ctx.assert.assertStatus(winFeed, 200);
    ctx.assert.equal(winFeed.json.latest.deltas.length, 1);
    ctx.assert.equal(winFeed.json.latest.asarDeltas.length, 0);
    ctx.cryptoDelta.verifyDesktopManifest(winFeed.json, winFeed.json.publicKeyPem);
    ctx.cryptoDelta.verifyDesktopDeltas(winFeed.json, winFeed.json.publicKeyPem);

    const winDeltaDl = await client.downloadUpdateFile(winFeed.json.latest.deltas[0].url);
    ctx.assert.assertStatus(winDeltaDl, 200);
    const rebuiltWin = ctx.cryptoDelta.applyRbd1Delta(win1, winDeltaDl.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuiltWin), ctx.cryptoDelta.sha256Hex(win2));

    // Tamper rejection
    const tampered = structuredClone(macFeed.json);
    tampered.version = '9.9.9';
    tampered.latest.version = '9.9.9';
    ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopManifest(tampered, macFeed.json.publicKeyPem));

    const wrongKeys = ctx.cryptoDelta.generateSigningKeyPair();
    ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopDeltas(macFeed.json, wrongKeys.publicKeyPem));
  });

  // T3-04: iOS release publish -> rokbot-ios-update/v1 -> tokenized manifest.plist & altstore.json -> IPA fetch + token rotation
  test('T3-04', 'iOS publish -> rokbot-ios-update/v1 -> tokenized manifest.plist & altstore.json -> IPA fetch + rotation', async (t) => {
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'iPhone 16',
      platform: 'ios',
      clientDeviceId: 't3-04-ios-ota',
      bundleId: 'dev.rokbot.local',
    });

    const ipaV1 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'Payload/RokBot.app/Info.plist', data: 'CFBundleIdentifier=dev.rokbot.local;v=1.16.0' },
      { name: 'Payload/RokBot.app/RokBot', data: Buffer.alloc(512, 0xaa) },
    ]);
    const up1 = await client.adminUploadUpdate({ platform: 'ios', filename: 'RokBot-1.16.0.ipa', bytes: ipaV1 });
    ctx.assert.assertStatus(up1, 201);
    const pub1 = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      filename: 'RokBot-1.16.0.ipa',
      ...(up1.json.artifact?.id ? { artifactId: up1.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub1, 201);
    registerUpdateCleanup(t, client, ctx, 'ios', pub1.json.release.id);

    const feed1 = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed1, 200);
    ctx.assert.equal(feed1.json.schema, ctx.cryptoDelta.IOS_UPDATE_SCHEMA);
    ctx.assert.equal(feed1.json.latest.bundleId, 'dev.rokbot.local');
    const methods1 = feed1.json.latest.installMethods;
    const itmsHref1 = methods1.itmsServicesHref ?? methods1.itmsServicesUrl;
    ctx.assert.ok(
      typeof itmsHref1 === 'string' && itmsHref1.startsWith('itms-services://?action=download-manifest&url='),
      'Expected itms-services:// download-manifest URL',
    );
    const plist1Url = resolveIosPlistUrl(methods1);

    const plist1 = await client.fetchIosPlist(plist1Url);
    ctx.assert.assertStatus(plist1, 200);
    const plistValid = ctx.cryptoDelta.validateIosManifestPlist(plist1.text, {
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
      ipaUrl: methods1.ipaDownloadUrl,
    });
    ctx.assert.equal(plistValid.ok, true, plistValid.errors.join('; '));

    const alt1 = await client.fetchIosAltStore(methods1.altStoreSourceUrl);
    ctx.assert.assertStatus(alt1, 200);
    const altValid = ctx.cryptoDelta.validateAltStoreJson(alt1.json, { bundleId: 'dev.rokbot.local' });
    ctx.assert.equal(altValid.ok, true, altValid.errors.join('; '));

    const ipaDl = await client.downloadUpdateFile(methods1.ipaDownloadUrl, { auth: false });
    ctx.assert.assertStatus(ipaDl, 200);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(ipaDl.buffer), feed1.json.latest.sha256);

    const badTokenRes = await client.fetchIosPlist('/updates/ios/invalid-token-t304/manifest.plist');
    ctx.assert.assertStatus(badTokenRes, 403);

    // Publish second iOS release -> new OTA token; verify token invalidation
    const ipaV2 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'Payload/RokBot.app/Info.plist', data: 'CFBundleIdentifier=dev.rokbot.local;v=1.16.1' },
      { name: 'Payload/RokBot.app/RokBot', data: Buffer.alloc(512, 0xbb) },
    ]);
    const up2 = await client.adminUploadUpdate({ platform: 'ios', filename: 'RokBot-1.16.1.ipa', bytes: ipaV2 });
    ctx.assert.assertStatus(up2, 201);
    const pub2 = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.1',
      build: '23153',
      bundleId: 'dev.rokbot.local',
      filename: 'RokBot-1.16.1.ipa',
      ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub2, 201);
    registerUpdateCleanup(t, client, ctx, 'ios', pub2.json.release.id);

    const feed2 = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed2, 200);
    const plist2Url = resolveIosPlistUrl(feed2.json.latest.installMethods);
    const newPlist = await client.fetchIosPlist(plist2Url);
    ctx.assert.assertStatus(newPlist, 200);

    if (ctx.harness) {
      const oldPlistAfterRotate = await client.fetchIosPlist(plist1Url);
      ctx.assert.assertStatus(oldPlistAfterRotate, 403);
      const oldAltAfterRotate = await client.fetchIosAltStore(methods1.altStoreSourceUrl);
      ctx.assert.assertStatus(oldAltAfterRotate, 403);
      const oldIpaAfterRotate = await client.downloadUpdateFile(methods1.ipaDownloadUrl, { auth: false });
      ctx.assert.assertStatus(oldIpaAfterRotate, 403);
    } else {
      ctx.assert.notEqual(plist2Url, plist1Url);
      ctx.assert.assertStatus(await client.adminDeleteUpdate('ios', pub1.json.release.id), 200);
      ctx.assert.assertStatus(await client.fetchIosPlist(plist1Url), 403);
      ctx.assert.assertStatus(await client.fetchIosAltStore(methods1.altStoreSourceUrl), 403);
      ctx.assert.assertStatus(await client.downloadUpdateFile(methods1.ipaDownloadUrl, { auth: false }), 403);
    }
  });

  // T3-05: ExternalShell default machine routing + clientDeviceId dedup + push suppression (x-rokbot-foreground: 1)
  test('T3-05', 'ExternalShell routing + clientDeviceId dedup + foreground push suppression', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness setComputers/setDefaultMachineId/publishNotification hooks');
    }
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);

    const pair1 = await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Pixel 8',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'and-t305-dedup',
    });
    const oldToken = pair1.json.token;

    const pair2 = await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Pixel 8 Updated',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'and-t305-dedup',
    });
    ctx.assert.equal(pair2.json.reused, true);
    ctx.assert.equal(pair2.json.deviceId, pair1.json.deviceId);
    ctx.assert.notEqual(pair2.json.token, oldToken);

    const oldCheck = await client.localStatus({ bearer: oldToken });
    ctx.assert.assertStatus(oldCheck, 401);

    ctx.harness.setComputers([
      { id: 'win-node', label: 'Windows Node', connected: true, platform: 'win32' },
      { id: 'mac-node', label: 'Mac Studio', connected: true, platform: 'darwin' },
    ]);
    ctx.harness.setDefaultMachineId('mac-node');

    const compRes = await client.getComputers();
    ctx.assert.assertStatus(compRes, 200);
    ctx.assert.equal(compRes.json.available, true);
    ctx.assert.equal(compRes.json.defaultMachineId, 'mac-node');

    const implicitExec = await client.apiCall('localExec', { command: 'uname -s' });
    ctx.assert.assertStatus(implicitExec, 200);
    ctx.assert.equal(implicitExec.json.machineId, 'mac-node');

    const overrideExec = await client.apiCall('localExec', { computerId: 'win-node', command: 'ver' });
    ctx.assert.assertStatus(overrideExec, 200);
    ctx.assert.equal(overrideExec.json.machineId, 'win-node');

    const pushReg = await client.updateDevice({
      push: { provider: 'webhook', webhookUrl: 'https://push.example.com/android-hook' },
    });
    ctx.assert.assertStatus(pushReg, 200);
    ctx.assert.equal(pushReg.json.push.enabled, true);

    const notifSse = await client.openSse('/notifications/events', {
      headers: { 'x-rokbot-foreground': '1' },
    });
    t.after(() => notifSse.close());

    const notifItem = ctx.harness.publishNotification({
      deviceId: pair2.json.deviceId,
      title: 'Execution Done',
      body: 'Ran on mac-node',
    });
    const ev = await notifSse.nextEvent((e) => e.data?.id === notifItem.id, 3000);
    ctx.assert.equal(ev.event, 'notification');
    ctx.assert.equal(ev.data.title, 'Execution Done');

    const hist = ctx.harness.getPushHistory();
    ctx.assert.equal(hist.sent.length, 0);
    ctx.assert.equal(hist.suppressed.length, 1);
    ctx.assert.equal(hist.suppressed[0].reason, 'foreground');
  });

  // T3-06: One-click install-images.sh --prepare-only + docker-compose.images.yml -> admin auth -> pairing -> model config
  test('T3-06', 'One-click install-images.sh --prepare-only -> admin auth -> pairing -> model config', async (t) => {
    const workDir = await t.createTempDir('rokbot-t306-work-');
    let deployRes;
    if (ctx.repoCheck) {
      deployRes = await ctx.repoChecks.checkOneClickDeploy(ctx.repoRoot, {
        repoCheck: true,
        tempDir: workDir,
      });
      ctx.assert.equal(deployRes.source, 'repo');
    } else {
      const fakeRepoRoot = await t.createTempDir('rokbot-t306-empty-');
      const fixtureDir = await t.createTempDir('rokbot-t306-fix-');
      await writeFile(path.join(fixtureDir, 'docker-compose.images.yml'), SYNTHETIC_COMPOSE_YML, 'utf8');
      await writeFile(path.join(fixtureDir, '.env.images.example'), SYNTHETIC_ENV_EXAMPLE, 'utf8');
      await writeFile(path.join(fixtureDir, 'install-images.sh'), SYNTHETIC_INSTALL_SCRIPT, { mode: 0o755 });
      deployRes = await ctx.repoChecks.checkOneClickDeploy(fakeRepoRoot, {
        repoCheck: false,
        fixtureDir,
        tempDir: workDir,
      });
      ctx.assert.equal(deployRes.source, 'fixture');
      ctx.assert.ok(deployRes.runResult.generatedSecretsCount >= 1);
    }

    ctx.assert.equal(deployRes.available, true);
    ctx.assert.equal(deployRes.validation.ok, true, deployRes.validation.errors.join('; '));
    ctx.assert.equal(deployRes.runResult.exitCode, 0, deployRes.runResult.stderr);
    ctx.assert.equal(deployRes.runResult.envMode, 0o600);
    ctx.assert.equal(deployRes.runResult.parsedEnv.ROKBOT_BOX_TOKEN, 'local');
    ctx.assert.assertNoSecrets(
      `${deployRes.runResult.stdout}\n${deployRes.runResult.stderr}`,
      Object.values(deployRes.runResult.parsedEnv).filter((v) => v.length >= 12),
    );

    const client = await setupPairwiseTest(t, ctx, { initialized: false, needsModel: true });
    if (ctx.harness) {
      const setupRes = await client.adminSetup(ctx.harness.getSetupKey(), ctx.adminPassword);
      ctx.assert.assertStatus(setupRes, 200);

      const keyRes = await client.createPairingKey();
      ctx.assert.assertStatus(keyRes, 201);
      ctx.assert.ok(keyRes.json.pairingKey.length >= 6);

      const pairRes = await pairDeviceWithCleanup(t, client, ctx, {
        deviceName: 'First Setup Client',
        platform: 'desktop',
        usePassword: true,
      });
      ctx.assert.equal(typeof pairRes.json.deviceId, 'string');

      const modelKey = 'sk-t306-setup-model-key-1234';
      const putRes = await client.putLocalModel({
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: modelKey,
      });
      ctx.assert.assertStatus(putRes, 200);

      const getRes = await client.getLocalModel();
      ctx.assert.assertStatus(getRes, 200);
      ctx.assert.equal(getRes.json.config.hasApiKey, true);
      ctx.assert.assertNoSecrets(getRes.json, [modelKey, ctx.adminPassword], { forbidTokenKey: true });
    } else {
      await ensureAdminLogin(client, ctx);
      const sess = await client.adminSession();
      ctx.assert.assertStatus(sess, 200);
      ctx.assert.equal(sess.json.initialized, true);

      const admSt = await client.adminStatus();
      ctx.assert.assertStatus(admSt, 200);

      const keyRes = await client.createPairingKey();
      ctx.assert.assertStatus(keyRes, 201);
      ctx.assert.ok(keyRes.json.pairingKey.length >= 6);

      await ensureSharedLiveDevice(client, ctx);
      const locSt = await client.localStatus();
      ctx.assert.assertStatus(locSt, 200);
      ctx.assert.equal(locSt.json.brand, 'RokBot');
      ctx.assert.assertNoSecrets(locSt.json, [ctx.adminPassword, client.deviceToken].filter(Boolean), { forbidTokenKey: true });
    }
  });

  // T3-07: apiKey preservation across model edit + reload.status (waiting -> applied) + SSE reconnect (Last-Event-ID)
  test('T3-07', 'apiKey preservation + reload waiting -> applied + SSE Last-Event-ID reconnect', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness setModelReloadBehavior & publishNotification hooks');
    }
    const client = await setupPairwiseTest(t, ctx);
    ctx.harness.setModelReloadBehavior({ mode: 'waiting-then-applied', delayMs: 40 });
    t.after(() => ctx.harness.setModelReloadBehavior({ mode: 'immediate', delayMs: 40 }));

    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Model HotSwap Desktop',
      platform: 'desktop',
      usePassword: true,
    });

    const initialKey = 'sk-t307-initial-secret-8888';
    const put1 = await client.putLocalModel({
      apiFormat: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: initialKey,
    });
    ctx.assert.assertStatus(put1, 200);
    ctx.assert.equal(put1.json.reload.status, 'waiting');

    const applied1 = await pollUntil(async () => {
      const r = await client.getLocalModel();
      return { done: r.json?.reload?.status === 'applied', value: r };
    });
    ctx.assert.equal(applied1.json.reload.status, 'applied');

    // Edit model omitting apiKey
    const put2 = await client.putLocalModel({
      apiFormat: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1',
    });
    ctx.assert.assertStatus(put2, 200);
    ctx.assert.equal(put2.json.reload.status, 'waiting');
    ctx.assert.equal(put2.json.config.hasApiKey, true);
    ctx.assert.assertNoSecrets(put2.json, [initialKey], { forbidTokenKey: true });

    const applied2 = await pollUntil(async () => {
      const r = await client.getLocalModel();
      return { done: r.json?.reload?.status === 'applied', value: r };
    });
    ctx.assert.equal(applied2.json.reload.status, 'applied');
    ctx.assert.equal(applied2.json.config.profiles[0].model, 'gpt-4.1');
    ctx.assert.equal(applied2.json.config.hasApiKey, true);
    ctx.assert.assertNoSecrets(applied2.json, [initialKey], { forbidTokenKey: true });

    // SSE reconnect with Last-Event-ID
    const sse1 = await client.openSse('/notifications/events');
    const n1 = ctx.harness.publishNotification({ title: 'First', body: 'n1' });
    const ev1 = await sse1.nextEvent((e) => e.data?.id === n1.id, 3000);
    await sse1.close();

    const n2 = ctx.harness.publishNotification({ title: 'Missed-2', body: 'n2' });
    const n3 = ctx.harness.publishNotification({ title: 'Missed-3', body: 'n3' });

    const sse2 = await client.openSse('/notifications/events', { lastEventId: ev1.id });
    t.after(() => sse2.close());
    const replayed2 = await sse2.nextEvent((e) => e.data?.id === n2.id, 3000);
    const replayed3 = await sse2.nextEvent((e) => e.data?.id === n3.id, 3000);
    ctx.assert.equal(replayed2.data.title, 'Missed-2');
    ctx.assert.equal(replayed3.data.title, 'Missed-3');
    ctx.assert.equal(sse2.events.some((e) => e.data?.id === n1.id), false);
  });

  // T3-08: Web rokbot_web + x-rokbot-web: 1 + /web/manifest.webmanifest + /local/model auth guard
  test('T3-08', 'Web rokbot_web + x-rokbot-web + /web/manifest.webmanifest + /local/model guard', async (t) => {
    const adminClient = await setupPairwiseTest(t, ctx, {}, { deviceToken: null });
    await ensureAdminLogin(adminClient, ctx);

    const manifestRes = await adminClient.getWebManifest();
    if (!ctx.harness && manifestRes.status === 404) {
      t.skip('Web client bundle is not installed on live Host');
    }
    ctx.assert.assertStatus(manifestRes, 200);
    ctx.assert.equal(manifestRes.json.name, 'RokBot');
    const allowedIconSrcs = ctx.harness
      ? ['/rokbot-icon.png']
      : ['/rokbot-icon.png', '/web/client/icon.png', '/web/client/icon-512.png'];
    ctx.assert.ok(Array.isArray(manifestRes.json.icons) && manifestRes.json.icons.length > 0);
    const matchedIcon = manifestRes.json.icons.find((icon) => allowedIconSrcs.includes(icon.src));
    ctx.assert.ok(
      matchedIcon,
      `Expected manifest icon src in ${allowedIconSrcs.join(', ')}, got ${JSON.stringify(manifestRes.json.icons)}`,
    );

    const webClient = ctx.createClient({ deviceToken: null });
    t.after(async () => {
      await webClient.webLogout().catch(() => {});
      await webClient.close();
    });

    if (ctx.harness) {
      const keyRes = await adminClient.createPairingKey();
      ctx.assert.assertStatus(keyRes, 201);

      const webPair = await webClient.webPair({
        pairingKey: keyRes.json.pairingKey,
        deviceName: 'Web Browser Client',
        clientDeviceId: 'web-t308-browser',
      });
      ctx.assert.assertStatus(webPair, 201);
    } else {
      // Avoid consuming a pair:<ip> (6/60s) slot in combined --mode live runs; T1-F09-02 already covers POST /web/api/pair.
      const opener = ctx.createClient({ deviceToken: null });
      t.after(() => opener.close());
      const adminCookie = adminClient.cookies.get('rokbot_admin');
      if (adminCookie) opener.cookies.set('rokbot_admin', adminCookie);
      const openRes = await opener.adminOpenWebClient({
        deviceName: 'Web Browser Client',
        clientDeviceId: 'web-t308-browser',
      });
      if (openRes.status === 409) {
        t.skip('Web client bundle is not installed on live Host');
      }
      ctx.assert.assertStatus(openRes, [200, 201]);
      const webCookie = opener.cookies.get('rokbot_web');
      if (webCookie) webClient.cookies.set('rokbot_web', webCookie);
    }
    ctx.assert.ok(webClient.cookies.has('rokbot_web'), 'rokbot_web cookie must be set');

    const resolvedIconRes = await webClient.request('GET', matchedIcon.src, { auth: false });
    ctx.assert.assertStatus(resolvedIconRes, 200, `GET ${matchedIcon.src}`);
    const resolvedPng = ctx.repoChecks.inspectPng(resolvedIconRes.buffer);
    ctx.assert.ok(resolvedPng.width > 0 && resolvedPng.height > 0, `Invalid PNG at ${matchedIcon.src}`);

    const sessRes = await webClient.webSession();
    ctx.assert.assertStatus(sessRes, 200);
    ctx.assert.equal(sessRes.json.paired, true);

    const noWebHdr = await webClient.localStatus({ webHeader: false });
    ctx.assert.assertStatus(noWebHdr, 403);

    const webLocStatus = await webClient.localStatus();
    ctx.assert.assertStatus(webLocStatus, 200);

    if (ctx.harness) {
      const guestBlocked = await webClient.getLocalModel();
      ctx.assert.assertStatus(guestBlocked, 403);

      const stepUpOk = await webClient.putLocalModel(
        {
          apiFormat: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
          apiKey: 'sk-t308-web-stepup-9999',
        },
        { adminPassword: ctx.adminPassword },
      );
      ctx.assert.assertStatus(stepUpOk, 200);

      ctx.harness.setModelAuthPolicy({ allowGuestModelConfig: true });
      t.after(() => ctx.harness.setModelAuthPolicy({ allowGuestModelConfig: false }));
      const guestAllowed = await webClient.getLocalModel();
      ctx.assert.assertStatus(guestAllowed, 200);
    } else {
      const modelRes = await webClient.getLocalModel();
      ctx.assert.assertStatus(modelRes, webLocStatus.json?.canConfigureModel === false ? 403 : 200);
      ctx.assert.assertNoSecrets(modelRes.json ?? modelRes.text, [ctx.adminPassword], { forbidTokenKey: true });
    }

    const logoutRes = await webClient.webLogout();
    ctx.assert.assertStatus(logoutRes, 200);
    const afterLogout = await webClient.localStatus();
    ctx.assert.assertStatus(afterLogout, 401);
  });

  // T3-09: Rebranding Category-A/B + Logo /rokbot-icon.png + assertNoSecrets across logs/responses
  test('T3-09', 'Rebranding Category-A/B + Logo /rokbot-icon.png + assertNoSecrets', async (t) => {
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Brand Audit Device',
      platform: 'desktop',
      usePassword: true,
    });

    const iconRes = await client.getIcon('GET');
    ctx.assert.assertStatus(iconRes, 200);
    const png = ctx.repoChecks.inspectPng(iconRes.buffer);
    ctx.assert.equal(png.width, 512);
    ctx.assert.equal(png.height, 512);
    ctx.assert.equal(png.colorType, 6);
    ctx.assert.equal(png.hasAlpha, true);

    if (ctx.repoCheck) {
      const logoRes = ctx.repoChecks.verifyLogoSuite(ctx.repoRoot);
      ctx.assert.equal(logoRes.ok, true, logoRes.errors.join('; '));
    } else {
      const svgInfo = ctx.repoChecks.inspectSvg(SYNTHETIC_ROKBOT_SVG);
      ctx.assert.equal(svgInfo.hasBrandFace, true);
      ctx.assert.equal(svgInfo.eyeCount, 2);
      ctx.assert.equal(svgInfo.hasTiltedEyes, true);
      ctx.assert.equal(svgInfo.hasAsymmetricEyes, true);
      ctx.assert.equal(svgInfo.hasBrandAccent, true);
      ctx.assert.equal(svgInfo.rebrandingOk, true);
    }

    // Category-B preserved vs Category-A blocked + toggle checks
    const catBSample = 'const url = "grokbot://app/v1/chat"; const svc = "/aiserver.v1.GrokBotService/Chat";';
    ctx.assert.equal(ctx.repoChecks.scanTextForRebranding(catBSample).ok, true);

    const abiSample = 'JNIEXPORT void JNICALL Java_dev_grokbot_local_TailcatBridge_nativeStart(void);';
    ctx.assert.equal(ctx.repoChecks.scanTextForRebranding(abiSample, { allowAbiCompat: false }).ok, false);
    ctx.assert.equal(ctx.repoChecks.scanTextForRebranding(abiSample, { allowAbiCompat: true }).ok, true);

    const bridgeSample = 'PORT="${ROKBOT_PORT:-${GROKBOT_PORT:-8000}}"\nMAGIC="GBDELTA1"';
    ctx.assert.equal(ctx.repoChecks.scanTextForRebranding(bridgeSample, { allowMigrationBridges: false }).ok, false);
    ctx.assert.equal(ctx.repoChecks.scanTextForRebranding(bridgeSample, { allowMigrationBridges: true }).ok, true);

    const health = await client.health();
    const pubStatus = await client.connectStatus({ auth: false });
    const locStatus = await client.localStatus();
    ctx.assert.assertStatus(health, 200);
    ctx.assert.assertStatus(pubStatus, 200);
    ctx.assert.assertStatus(locStatus, 200);

    const secrets = [ctx.adminPassword, client.deviceToken].filter(Boolean);
    ctx.assert.assertNoSecrets(health.json, secrets, { forbidTokenKey: true, label: '/health' });
    ctx.assert.assertNoSecrets(pubStatus.json, secrets, { forbidTokenKey: true, label: '/connect/status' });
    ctx.assert.assertNoSecrets(locStatus.json, secrets, { forbidTokenKey: true, label: '/local/status' });
    if (ctx.harness) {
      ctx.assert.assertNoSecrets(ctx.harness.getAuditLog(), secrets, { forbidTokenKey: true, label: 'auditLog' });
    }

    // assertNoSecrets must never echo the leaked secret in its error message
    const canarySecret = 'SecretCanaryToken!2026';
    let caught = null;
    try {
      ctx.assert.assertNoSecrets({ msg: `token=${canarySecret}` }, [canarySecret]);
    } catch (err) {
      caught = err;
    }
    ctx.assert.ok(caught, 'Expected assertNoSecrets to throw on leaked secret');
    ctx.assert.equal(caught.message.includes(canarySecret), false);
  });

  // T3-10: Attachment upload (/connect/attachment) + library file CRUD (/local/files) + blocked RPC guard
  test('T3-10', 'Attachment /connect/attachment + /local/files CRUD + blocked admin RPC guard', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness seedAttachment hook');
    }
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Files & Attachment Client',
      platform: 'desktop',
      usePassword: true,
    });

    const agentsRes = await client.apiCall('listAgents', {});
    ctx.assert.assertStatus(agentsRes, 200);
    const agentId = agentsRes.json[0].id;

    const iconRes = await client.getIcon();
    ctx.assert.assertStatus(iconRes, 200);
    const attUrl = await ctx.harness.seedAttachment(agentId, 'shot.png', iconRes.buffer);
    const readAtt = await client.readAttachment(attUrl);
    ctx.assert.assertStatus(readAtt, 200);
    ctx.assert.ok(readAtt.json.dataUrl.startsWith('data:image/png;base64,'));

    const traversal = await client.readAttachment('file:///etc/passwd');
    ctx.assert.assertStatus(traversal, 403);

    const badExtUrl = await ctx.harness.seedAttachment(agentId, 'notes.txt', Buffer.from('plain text'));
    const badExtRes = await client.readAttachment(badExtUrl);
    ctx.assert.assertStatus(badExtRes, 415);

    // /local/files CRUD
    const payloadBuf = Buffer.from('{"hello":"rokbot-library"}', 'utf8');
    const upFile = await client.uploadFile({
      agentId,
      fileName: 'config.json',
      contentType: 'application/json',
      base64: payloadBuf.toString('base64'),
    });
    ctx.assert.assertStatus(upFile, 200);
    ctx.assert.equal(upFile.json.name, 'config.json');

    const listRes = await client.listFiles(agentId);
    ctx.assert.assertStatus(listRes, 200);
    ctx.assert.ok(listRes.json.files.some((f) => f.name === 'config.json'));

    const contentRes = await client.getFileContent(agentId, 'config.json');
    ctx.assert.assertStatus(contentRes, 200);
    ctx.assert.equal(contentRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    ctx.assert.equal(contentRes.buffer.equals(payloadBuf), true);

    const delRes = await client.deleteFile({ agentId, name: 'config.json' });
    ctx.assert.assertStatus(delRes, 200);
    const missingContent = await client.getFileContent(agentId, 'config.json');
    ctx.assert.assertStatus(missingContent, 404);

    // Blocked RPC guard
    const blocked1 = await client.apiCall('importLocalSharedBot', {});
    ctx.assert.assertStatus(blocked1, 403);
    const blocked2 = await client.apiCall('localApplicationRpc', {});
    ctx.assert.assertStatus(blocked2, 403);
  });

  // T3-11: ExternalShell multi-machine 409 vs single auto-route vs 404 + createAgent / deleteAgents file cascade
  test('T3-11', 'ExternalShell 409/auto-route/404 + createAgent / deleteAgents file cascade', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness setComputers/setDefaultMachineId hooks');
    }
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Routing Test Device',
      platform: 'desktop',
      usePassword: true,
    });

    ctx.harness.setComputers([
      { id: 'box-a', label: 'Box A', connected: true },
      { id: 'box-b', label: 'Box B', connected: true },
    ]);
    ctx.harness.setDefaultMachineId(null);

    const conflictExec = await client.apiCall('localExec', { command: 'id' });
    ctx.assert.assertStatus(conflictExec, 409);

    ctx.harness.setComputers([{ id: 'solo-box', label: 'Solo Box', connected: true }]);
    const autoExec = await client.apiCall('localExec', { command: 'id' });
    ctx.assert.assertStatus(autoExec, 200);
    ctx.assert.equal(autoExec.json.machineId, 'solo-box');

    const unknownExec = await client.apiCall('localExec', { computerId: 'nonexistent-box', command: 'id' });
    ctx.assert.assertStatus(unknownExec, 404);

    // Agent creation + file upload + cascade delete
    const created = await client.createAgent({ name: 'Cascade Agent' });
    ctx.assert.assertStatus(created, 200);
    const agentId = created.agentId;

    const up = await client.uploadFile({
      agentId,
      fileName: 'cascade.txt',
      contentType: 'text/plain',
      base64: Buffer.from('cascade-data').toString('base64'),
    });
    ctx.assert.assertStatus(up, 200);

    const del = await client.apiCall('deleteAgents', { ids: [agentId] });
    ctx.assert.assertStatus(del, 200);

    const listAfter = await client.listFiles(agentId);
    ctx.assert.assertStatus(listAfter, 404);
  });

  // T3-12: Legacy compat codecs (GBDELTA1 & GBD1) + dual-shape & manifest tamper rejection
  test('T3-12', 'Legacy compat codecs (GBDELTA1 & GBD1) + dual-shape/manifest tamper rejection', async () => {
    const apkBase = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'classes.dex', data: Buffer.from('legacy-dex-'.repeat(100)) },
    ]);
    const apkNext = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'classes.dex', data: Buffer.from('legacy-dex-'.repeat(100)) },
      { name: 'extra.bin', data: Buffer.from('new-entry-'.repeat(30)) },
    ]);
    const legacyRbDelta = ctx.cryptoDelta.generateRbDelta(apkBase, apkNext, {
      magic: ctx.cryptoDelta.LEGACY_RBDELTA_MAGIC,
    });
    const rbHdr = ctx.cryptoDelta.inspectRbDeltaHeader(legacyRbDelta);
    ctx.assert.equal(rbHdr.magic, 'GBDELTA1');
    const rebuiltApk = ctx.cryptoDelta.applyRbDelta(apkBase, legacyRbDelta);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuiltApk), ctx.cryptoDelta.sha256Hex(apkNext));

    const asarBase = ctx.cryptoDelta.buildSyntheticAsar({ files: { 'a.js': { size: 128, offset: '0' } } }, Buffer.alloc(128, 0x11));
    const asarNext = ctx.cryptoDelta.buildSyntheticAsar({ files: { 'a.js': { size: 128, offset: '0' } } }, Buffer.alloc(128, 0x22));
    const legacyRbd1 = ctx.cryptoDelta.generateRbd1Delta(asarBase.bytes, asarNext.bytes, {
      magic: ctx.cryptoDelta.LEGACY_RBD1_MAGIC,
    });
    const rbd1Hdr = ctx.cryptoDelta.inspectRbd1Header(legacyRbd1);
    ctx.assert.equal(rbd1Hdr.magic, 'GBD1');
    const rebuiltAsar = ctx.cryptoDelta.applyRbd1Delta(asarBase.bytes, legacyRbd1);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuiltAsar), asarNext.sha256);

    // Dual-shape consistency and tamper rejection
    const kp = ctx.cryptoDelta.generateSigningKeyPair();
    const validAndroid = ctx.cryptoDelta.signAndroidManifest({
      schema: ctx.cryptoDelta.ANDROID_NATIVE_UPDATE_SCHEMA,
      track: 'stable',
      packageName: 'dev.rokbot.nativeapp',
      versionName: '1.2.0',
      versionCode: 120,
      sha256: ctx.cryptoDelta.sha256Hex(apkNext),
      size: apkNext.length,
      certificateSha256: 'bb'.repeat(32),
      url: 'https://bot.example.com/app.apk',
      fullUrl: 'https://bot.example.com/app.apk',
      publishedAt: new Date().toISOString(),
      deltas: [],
    }, kp.privateKey);
    ctx.cryptoDelta.verifyAndroidManifest(validAndroid, kp.publicKeyPem);

    const mismatchedAndroid = {
      ...validAndroid,
      fullUrl: 'https://evil.example.com/app.apk',
    };
    ctx.assert.throws(() => ctx.cryptoDelta.verifyAndroidManifest(mismatchedAndroid, kp.publicKeyPem));
  });

  // T3-13: Update proxy SSRF guard + push webhook isPublicPushUrl guard + reference-counted adminDeleteUpdate cleanup
  test('T3-13', 'Update proxy SSRF guard + push URL guard + reference-counted adminDeleteUpdate', async (t) => {
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'SSRF & Cleanup Device',
      platform: 'desktop',
      usePassword: true,
    });

    // SSRF checks on /local/updates/fetch
    ctx.assert.assertStatus(await client.fetchUpdateProxy('http://example.com/rokbot.apk'), 400);
    ctx.assert.assertStatus(await client.fetchUpdateProxy('https://user:pass@example.com/rokbot.apk'), 400);
    ctx.assert.assertStatus(await client.fetchUpdateProxy('https://127.0.0.1/rokbot.apk'), 403);
    ctx.assert.assertStatus(await client.fetchUpdateProxy('https://169.254.169.254/latest/meta-data'), 403);
    if (ctx.harness) {
      const allowedFetch = await client.fetchUpdateProxy('https://updates.example.com/rokbot.apk');
      ctx.assert.assertStatus(allowedFetch, 200);
      ctx.assert.equal(allowedFetch.json.ok, true);
    }

    // Push webhook URL guard
    const badPush = await client.updateDevice({
      push: { provider: 'webhook', webhookUrl: 'http://127.0.0.1:9999/hook' },
    });
    ctx.assert.assertStatus(badPush, 400);
    if (ctx.harness || !ctx.deviceToken) {
      const goodPush = await client.updateDevice({
        push: { provider: 'webhook', webhookUrl: 'https://push.example.com/t313' },
      });
      ctx.assert.assertStatus(goodPush, 200);
      if (!ctx.harness) {
        t.after(async () => {
          await client.updateDevice({ push: { provider: 'none' } }).catch(() => {});
        });
      }
    }

    // Reference-counted release deletion preserving base artifact shared with other release
    const sharedBase = 'base-v1-'.repeat(512);
    const b1 = ctx.cryptoDelta.buildSyntheticZip([{ name: 'a.txt', data: sharedBase }]);
    const b2 = ctx.cryptoDelta.buildSyntheticZip([{ name: 'a.txt', data: sharedBase }, { name: 'b.txt', data: 'v2' }]);
    const b3 = ctx.cryptoDelta.buildSyntheticZip([{ name: 'a.txt', data: sharedBase }, { name: 'c.txt', data: 'v3' }]);

    const u1 = await client.adminUploadUpdate({ platform: 'android', filename: 'rokbot-base.apk', bytes: b1 });
    ctx.assert.assertStatus(u1, 201);
    const p1 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.0.0',
      versionCode: 10,
      filename: 'rokbot-base.apk',
      ...(u1.json.artifact?.id ? { artifactId: u1.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(p1, 201);
    registerUpdateCleanup(t, client, ctx, 'android', p1.json.release.id);

    const u2 = await client.adminUploadUpdate({ platform: 'android', filename: 'rokbot-v2.apk', bytes: b2 });
    ctx.assert.assertStatus(u2, 201);
    const p2 = await client.adminPublishUpdate({
      platform: 'android',
      version: '2.0.0',
      versionCode: 20,
      filename: 'rokbot-v2.apk',
      ...(u2.json.artifact?.id ? { artifactId: u2.json.artifact.id } : {}),
      generateDeltaFrom: u1.json.artifact?.id ?? p1.json.release.id,
    });
    ctx.assert.assertStatus(p2, 201);
    registerUpdateCleanup(t, client, ctx, 'android', p2.json.release.id);
    const p2DeltaUrl = p2.json.release.deltas?.[0]?.url ?? p2.json.manifest?.latest?.deltas?.[0]?.url;
    ctx.assert.ok(p2DeltaUrl, 'Expected p2 delta URL');

    const u3 = await client.adminUploadUpdate({ platform: 'android', filename: 'rokbot-v3.apk', bytes: b3 });
    ctx.assert.assertStatus(u3, 201);
    const p3 = await client.adminPublishUpdate({
      platform: 'android',
      version: '3.0.0',
      versionCode: 30,
      filename: 'rokbot-v3.apk',
      ...(u3.json.artifact?.id ? { artifactId: u3.json.artifact.id } : {}),
      generateDeltaFrom: u1.json.artifact?.id ?? p1.json.release.id,
    });
    ctx.assert.assertStatus(p3, 201);
    registerUpdateCleanup(t, client, ctx, 'android', p3.json.release.id);

    const p1Url = p1.json.release.fileUrl ?? p1.json.manifest?.latest?.apkUrl ?? p1.json.manifest?.url;
    const p2Url = p2.json.release.fileUrl ?? p2.json.manifest?.latest?.apkUrl ?? p2.json.manifest?.url;
    const p3Url = p3.json.release.fileUrl ?? p3.json.manifest?.latest?.apkUrl ?? p3.json.manifest?.url;

    // Delete v2; v1 and v3 remain downloadable while v2 and its delta are gone
    const del2 = await client.adminDeleteUpdate('android', p2.json.release.id);
    ctx.assert.assertStatus(del2, 200);

    ctx.assert.assertStatus(await client.downloadUpdateFile(p1Url), 200);
    ctx.assert.assertStatus(await client.downloadUpdateFile(p3Url), 200);
    ctx.assert.assertStatus(await client.downloadUpdateFile(p2Url), 404);
    ctx.assert.assertStatus(await client.downloadUpdateFile(p2DeltaUrl), 404);
  });

  // T3-14: federationRole: 'secondary' blocking pairing/device/updates while /health & /connect/status stay 200 + revokeDevice closes SSE
  test('T3-14', 'federationRole secondary blocks pairing/device/updates + revokeDevice closes SSE', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness setFederationRole hook');
    }
    const client = await setupPairwiseTest(t, ctx, {}, { deviceToken: null });
    await ensureAdminLogin(client, ctx);
    const pair = await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Federation SSE Device',
      platform: 'desktop',
      usePassword: true,
    });

    const activeClient = ctx.createClient({ deviceToken: null });
    t.after(() => activeClient.close());
    const activeKeyRes = await client.createPairingKey();
    ctx.assert.assertStatus(activeKeyRes, 201);
    const activePair = await activeClient.pairWithKey({
      pairingKey: activeKeyRes.json.pairingKey,
      deviceName: 'Active SSE Observer',
      platform: 'desktop',
    });
    ctx.assert.assertStatus(activePair, 201);

    const eventsSse = await client.openSse('/events');
    t.after(() => eventsSse.close());
    const notifSse = await client.openSse('/notifications/events');
    t.after(() => notifSse.close());

    const activeEventsSse = await activeClient.openSse('/events');
    t.after(() => activeEventsSse.close());
    const activeNotifSse = await activeClient.openSse('/notifications/events');
    t.after(() => activeNotifSse.close());

    ctx.harness.setFederationRole('secondary');
    t.after(() => ctx.harness.setFederationRole('primary'));

    ctx.assert.assertStatus(await client.health(), 200);
    ctx.assert.assertStatus(await client.connectStatus({ auth: false }), 200);

    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);
    ctx.assert.assertStatus(
      await client.pairWithKey({ pairingKey: keyRes.json.pairingKey, deviceName: 'Blocked' }),
      403,
    );
    ctx.assert.assertStatus(await client.localStatus(), 403);
    ctx.assert.assertStatus(await client.getUpdateManifest('android'), 403);

    ctx.harness.setFederationRole('primary');
    ctx.assert.assertStatus(await client.localStatus(), 200);

    const eventsBefore = eventsSse.events.length;
    const notifBefore = notifSse.events.length;

    const revRes = await client.revokeDevice(pair.json.deviceId);
    ctx.assert.assertStatus(revRes, 200);
    ctx.assert.assertStatus(await client.localStatus(), 401);

    // Emit post-revocation /events and /notifications/events items: active device MUST receive them, revoked device MUST NOT
    ctx.harness.emitEvent('agent-chunk', { marker: 'post-revoke-check' });
    const postNotif = ctx.harness.publishNotification({
      title: 'Post-Revoke Check',
      body: 'Only active SSE clients receive this',
    });

    const activeEvent = await activeEventsSse.nextEvent(
      (ev) => ev.data?.payload?.marker === 'post-revoke-check',
      3000,
    );
    ctx.assert.equal(activeEvent.data.payload.marker, 'post-revoke-check');
    const activeNotif = await activeNotifSse.nextEvent(
      (ev) => ev.data?.id === postNotif.id,
      3000,
    );
    ctx.assert.equal(activeNotif.data.title, 'Post-Revoke Check');

    await ctx.assert.rejects(() => eventsSse.nextEvent(() => true, 120), /Timed out/);
    await ctx.assert.rejects(() => notifSse.nextEvent(() => true, 120), /Timed out/);
    ctx.assert.equal(eventsSse.events.length, eventsBefore, 'Revoked device /events SSE must receive zero post-revocation events');
    ctx.assert.equal(notifSse.events.length, notifBefore, 'Revoked device /notifications/events SSE must receive zero post-revocation events');

    const devicesRes = await client.listDevices();
    ctx.assert.assertStatus(devicesRes, 200);
    const devView = devicesRes.json.devices.find((d) => d.id === pair.json.deviceId);
    ctx.assert.ok(devView && devView.revokedAt !== null);
  });

  // T3-15: Upstream model catalog/test faults (502) + modelReloadBehavior: 'error' + recovery to healthy prompt
  test('T3-15', 'Upstream model faults (502) + reload error + recovery to healthy streaming prompt', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness seedUpstreamCatalog/setModelTestFault/setModelReloadBehavior hooks');
    }
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Fault Recovery Client',
      platform: 'desktop',
      usePassword: true,
    });

    t.after(() => {
      ctx.harness.seedUpstreamCatalog(null, null);
      ctx.harness.setModelTestFault(null);
      ctx.harness.setModelReloadBehavior({ mode: 'immediate', delayMs: 40 });
    });

    ctx.harness.seedUpstreamCatalog([], { status: 502, message: 'Catalog upstream timeout' });
    const badCatalog = await client.probeModelCatalog({ apiKey: 'sk-t315-fault-key-1234' });
    ctx.assert.assertStatus(badCatalog, 502);

    ctx.harness.setModelTestFault({ status: 502, message: 'Preflight upstream error' });
    const badTest = await client.testModel({ apiKey: 'sk-t315-fault-key-1234', model: 'gpt-4o' });
    ctx.assert.assertStatus(badTest, 502);

    ctx.harness.setModelReloadBehavior({ mode: 'error' });
    const errPut = await client.putLocalModel({
      apiFormat: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'sk-t315-fault-key-1234',
    });
    ctx.assert.assertStatus(errPut, 200);
    ctx.assert.equal(errPut.json.reload.status, 'error');
    ctx.assert.ok(typeof errPut.json.reload.error === 'string' && errPut.json.reload.error.length > 0);

    // Recover
    ctx.harness.seedUpstreamCatalog([{ id: 'gpt-4.1-mini', name: 'gpt-4.1-mini', provider: 'openai' }], null);
    ctx.harness.setModelTestFault(null);
    ctx.harness.setModelReloadBehavior({ mode: 'immediate', delayMs: 40 });

    const goodCatalog = await client.probeModelCatalog({ apiKey: 'sk-t315-fault-key-1234' });
    ctx.assert.assertStatus(goodCatalog, 200);
    ctx.assert.equal(goodCatalog.json.models[0].id, 'gpt-4.1-mini');

    const goodTest = await client.testModel({ model: 'gpt-4.1-mini' });
    ctx.assert.assertStatus(goodTest, 200);
    ctx.assert.equal(goodTest.json.reply, 'OK');

    const goodPut = await client.putLocalModel({
      apiFormat: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
    });
    ctx.assert.assertStatus(goodPut, 200);
    ctx.assert.equal(goodPut.json.reload.status, 'applied');

    const sse = await client.openSse('/events');
    t.after(() => sse.close());
    const promptRes = await client.apiCall('sendPrompt', { prompt: 'recovered' });
    ctx.assert.assertStatus(promptRes, 200);
    const doneEv = await sse.nextEvent((e) => e.data?.channel === 'agent-done', 3000);
    ctx.assert.equal(doneEv.data.payload.model, 'gpt-4.1-mini');
    ctx.assert.equal(doneEv.data.payload.reply, 'OK: recovered');
  });

  // T3-16: Connectors + Voice status + testDevicePush(bypassForeground) + /connect/pair rate-limit (429)
  test('T3-16', 'Connectors + Voice status + testDevicePush(bypassForeground) + pair rate-limit 429', async (t) => {
    const client = await setupPairwiseTest(t, ctx);
    await ensureAdminLogin(client, ctx);
    await pairDeviceWithCleanup(t, client, ctx, {
      deviceName: 'Mobile Features Phone',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 't3-16-mobile',
    });

    const connGet = await client.listConnectors();
    ctx.assert.assertStatus(connGet, 200);
    ctx.assert.ok(Array.isArray(connGet.json.connectors));
    ctx.assert.ok(connGet.json.redirectUri.endsWith('/connectors/oauth/callback'));

    const connPost = await client.request('POST', '/local/connectors', { body: {} });
    ctx.assert.assertStatus(connPost, 403);

    const voiceRes = await client.getVoiceStatus();
    ctx.assert.assertStatus(voiceRes, 200);
    ctx.assert.equal(typeof voiceRes.json.enabled, 'boolean');

    if (ctx.harness) {
      const sse = await client.openSse('/notifications/events', {
        headers: { 'x-rokbot-foreground': '1' },
      });
      t.after(() => sse.close());

      const skipPush = await client.testDevicePush({ bypassForeground: false });
      ctx.assert.assertStatus(skipPush, 200);
      ctx.assert.equal(skipPush.json.status, 'skipped');
      ctx.assert.equal(skipPush.json.reason, 'foreground');

      const sentPush = await client.testDevicePush({ bypassForeground: true });
      ctx.assert.assertStatus(sentPush, 200);
      ctx.assert.equal(sentPush.json.status, 'sent');

      // Enforce /connect/pair rate-limit (6/min per IP)
      ctx.harness.resetRateLimits();
      t.after(() => ctx.harness.resetRateLimits());
      for (let i = 0; i < 6; i++) {
        const k = await client.createPairingKey();
        ctx.assert.assertStatus(k, 201);
        const p = await client.pairWithKey({
          pairingKey: k.json.pairingKey,
          deviceName: `RL Device ${i}`,
          platform: 'desktop',
        });
        ctx.assert.assertStatus(p, 201);
      }
      const k7 = await client.createPairingKey();
      ctx.assert.assertStatus(k7, 201);
      const rateLimited = await client.pairWithKey({
        pairingKey: k7.json.pairingKey,
        deviceName: 'RL Device 7',
        platform: 'desktop',
      });
      ctx.assert.assertStatus(rateLimited, 429);
    }
  });

  // T3-17: Scoped repo & operational URL rebranding (MZ UTF-8 vs PE/ELF binary) + ROKBOT_DOWNLOAD_BASE=http:// rejection
  test('T3-17', 'Scoped rebranding (MZ UTF-8 vs PE/ELF binary) + operational URLs + http:// download base reject', async (t) => {
    const scanDir = await t.createTempDir('rokbot-t317-scan-');
    // Plain UTF-8 starting with "MZ" containing a Category-A leak MUST be scanned & flagged
    await writeFile(path.join(scanDir, 'mz-clean.txt'), 'MZ plain utf-8 clean RokBot notes\n', 'utf8');
    await writeFile(path.join(scanDir, 'mz-leak.txt'), 'MZ note header=x-grokbot-csrf\n', 'utf8');
    // PE binary (MZ + NUL) and ELF binary (\x7fELF) with same string MUST be skipped as binary
    await writeFile(
      path.join(scanDir, 'sample.exe'),
      Buffer.concat([Buffer.from('MZ\x00\x00'), Buffer.from('x-grokbot-csrf')]),
    );
    await writeFile(
      path.join(scanDir, 'sample.bin'),
      Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('x-grokbot-csrf')]),
    );

    const tempScan = await ctx.repoChecks.scanRepoRebranding(scanDir);
    ctx.assert.equal(tempScan.ok, false);
    ctx.assert.equal(tempScan.violations.length, 1);
    ctx.assert.equal(tempScan.violations[0].filePath, 'mz-leak.txt');
    ctx.assert.equal(tempScan.violations[0].token, 'x-grokbot-csrf');

    // Operational URL checks
    const badGhcr = ctx.repoChecks.checkOperationalRepoUrls('image: ghcr.io/other/rokbot/host:latest');
    ctx.assert.equal(badGhcr.ok, false);
    const goodGhcr = ctx.repoChecks.checkOperationalRepoUrls('image: ghcr.io/hongfaqiu/rokbot/host:latest');
    ctx.assert.equal(goodGhcr.ok, true);
    const badSlug = ctx.repoChecks.checkOperationalRepoUrls('https://github.com/ferretgeek/prokbot-plus');
    ctx.assert.equal(badSlug.ok, false);
    const histSlug = ctx.repoChecks.checkOperationalRepoUrls('https://github.com/ferretgeek/prokbot-plus', {
      allowHistoricalAttribution: true,
    });
    ctx.assert.equal(histSlug.ok, true);

    // ROKBOT_DOWNLOAD_BASE=http:// must fail fast in install-images.sh
    const workDir = await t.createTempDir('rokbot-t317-http-');
    let scriptPath;
    let composePath;
    let envExamplePath;
    if (ctx.repoCheck && existsSync(path.join(ctx.repoRoot, 'host/release/install-images.sh'))) {
      scriptPath = path.join(ctx.repoRoot, 'host/release/install-images.sh');
      composePath = path.join(ctx.repoRoot, 'host/release/docker-compose.images.yml');
      envExamplePath = path.join(ctx.repoRoot, 'host/release/.env.images.example');
    } else {
      const fixDir = await t.createTempDir('rokbot-t317-fix-');
      scriptPath = path.join(fixDir, 'install-images.sh');
      composePath = path.join(fixDir, 'docker-compose.images.yml');
      envExamplePath = path.join(fixDir, '.env.images.example');
      await writeFile(scriptPath, SYNTHETIC_INSTALL_SCRIPT, { mode: 0o755 });
      await writeFile(composePath, SYNTHETIC_COMPOSE_YML, 'utf8');
      await writeFile(envExamplePath, SYNTHETIC_ENV_EXAMPLE, 'utf8');
    }

    const badBaseRes = await ctx.repoChecks.runInstallImagesPrepareOnly({
      workDir,
      scriptPath,
      composePath,
      envExamplePath,
      args: ['--prepare-only'],
      env: { ROKBOT_DOWNLOAD_BASE: 'http://insecure.example.com/rokbot' },
    });
    ctx.assert.notEqual(badBaseRes.exitCode, 0);
    ctx.assert.ok(badBaseRes.stderr.includes('https://'), `Expected https:// validation error, got: ${badBaseRes.stderr}`);

    if (ctx.repoCheck) {
      const repoScan = await ctx.repoChecks.scanRepoRebranding(ctx.repoRoot, {
        includePaths: ['assets', 'docs', 'mac', 'windows', 'web/client', 'web/patchers'],
        excludePaths: ['docs/REBRAND_COMPAT.md'],
      });
      ctx.assert.equal(
        repoScan.ok,
        true,
        `Scoped repo rebranding violations: ${JSON.stringify(repoScan.violations.slice(0, 5))}`,
      );
      for (const rel of ['README.md', 'README.en.md', 'SECURITY.md', 'NOTICE']) {
        const full = path.join(ctx.repoRoot, rel);
        if (existsSync(full)) {
          const text = await readFile(full, 'utf8');
          const res = ctx.repoChecks.scanTextForRebranding(text, {
            filePath: rel,
            allowHistoricalAttribution: true,
            allowMigrationBridges: true,
            allowAbiCompat: true,
          });
          ctx.assert.equal(res.ok, true, `${rel} rebranding violation: ${JSON.stringify(res.violations)}`);
        }
      }
    }
  });
}

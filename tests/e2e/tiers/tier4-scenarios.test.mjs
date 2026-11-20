import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const tier = 4;
export const name = 'real-world-scenarios';

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
  'ROKBOT_ALLOW_DEVICE_MODEL_CONFIG=1',
  'ROKBOT_UPDATE_DIR=/data/updates',
].join('\n');

const SYNTHETIC_INSTALL_SCRIPT = [
  '#!/usr/bin/env bash',
  'set -Eeuo pipefail',
  'prepare_only=false',
  'for arg in "$@"; do',
  '  [[ "$arg" == "--prepare-only" ]] && prepare_only=true',
  'done',
  'DOWNLOAD_BASE="${ROKBOT_DOWNLOAD_BASE:-https://raw.githubusercontent.com/hongfaqiu/rokbot/main/host/release}"',
  'case "$DOWNLOAD_BASE" in',
  '  https://*|file://*) ;;',
  '  *) echo "ROKBOT_DOWNLOAD_BASE must use https:// or file://." >&2; exit 1 ;;',
  'esac',
  'command -v docker >/dev/null 2>&1 || exit 1',
  'docker compose version >/dev/null 2>&1 || exit 1',
  'umask 077',
  'if [[ ! -f .env ]]; then',
  '  cp .env.images.example .env.tmp',
  '  chmod 600 .env.tmp',
  '  mv .env.tmp .env',
  'fi',
  'docker compose --env-file .env -f docker-compose.images.yml config --environment >/dev/null',
  'if [[ "$prepare_only" == true ]]; then',
  '  echo "RokBot files are ready."',
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

async function resetIfHarness(ctx, opts = {}) {
  if (ctx.harness) {
    await ctx.harness.resetState(opts);
  }
}

function makeClient(t, ctx, opts = {}) {
  const client = ctx.createClient(opts);
  t.after(() => client.close());
  return client;
}

async function loginAdmin(client, ctx) {
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

async function ensureSharedLiveDevice(adminClient, deviceClient, ctx) {
  if (ctx.deviceToken) {
    deviceClient.setBearerToken(ctx.deviceToken, null);
    return { status: 201, ok: true, json: { deviceId: null, token: ctx.deviceToken, reused: true } };
  }
  const entry = getLiveSessionEntry(ctx);
  const s2 = getS2LiveCache(ctx);
  if (entry.deviceToken) {
    const checkRes = await deviceClient.localStatus({ bearer: entry.deviceToken });
    if (checkRes.status === 200) {
      deviceClient.setBearerToken(entry.deviceToken, entry.deviceId);
      return { status: 201, ok: true, json: { deviceId: entry.deviceId, token: entry.deviceToken, reused: true } };
    }
    entry.deviceToken = null;
    entry.deviceId = null;
    if (s2) {
      s2.deviceToken = null;
      s2.deviceId = null;
    }
  }
  await loginAdmin(adminClient, ctx);
  const keyRes = await adminClient.createPairingKey();
  ctx.assert.assertStatus(keyRes, 201, 'createPairingKey');
  const pairRes = await deviceClient.pairWithKey({
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
  deviceClient.setBearerToken(entry.deviceToken, entry.deviceId);
  return pairRes;
}

function registerLiveDeviceCleanup(t, adminClient, ctx, deviceId) {
  if (!ctx.harness && deviceId) {
    t.after(async () => {
      await adminClient.revokeDevice(deviceId).catch(() => {});
    });
  }
}

function registerLiveReleaseCleanup(t, adminClient, ctx, platform, releaseId) {
  if (!ctx.harness && releaseId) {
    t.after(async () => {
      await adminClient.adminDeleteUpdate(platform, releaseId).catch(() => {});
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
  // T4-01: Fresh One-Click Setup -> Pairing -> needsModel -> In-App Model Probe & Save -> First Streaming Chat
  test('T4-01', 'Fresh One-Click Setup -> Pairing -> needsModel -> In-App Model Probe & Save -> First Streaming Chat', async (t) => {
    // Step 1: One-click setup preparation
    const workDir = await t.createTempDir('rokbot-t401-deploy-');
    let deployRes;
    if (ctx.repoCheck) {
      deployRes = await ctx.repoChecks.checkOneClickDeploy(ctx.repoRoot, {
        repoCheck: true,
        tempDir: workDir,
      });
      ctx.assert.equal(deployRes.source, 'repo');
    } else {
      const emptyRoot = await t.createTempDir('rokbot-t401-root-');
      const fixDir = await t.createTempDir('rokbot-t401-fix-');
      await writeFile(path.join(fixDir, 'docker-compose.images.yml'), SYNTHETIC_COMPOSE_YML, 'utf8');
      await writeFile(path.join(fixDir, '.env.images.example'), SYNTHETIC_ENV_EXAMPLE, 'utf8');
      await writeFile(path.join(fixDir, 'install-images.sh'), SYNTHETIC_INSTALL_SCRIPT, { mode: 0o755 });
      deployRes = await ctx.repoChecks.checkOneClickDeploy(emptyRoot, {
        repoCheck: false,
        fixtureDir: fixDir,
        tempDir: workDir,
      });
    }
    ctx.assert.equal(deployRes.available, true);
    ctx.assert.equal(deployRes.validation.ok, true, deployRes.validation.errors.join('; '));
    ctx.assert.equal(deployRes.runResult.exitCode, 0, deployRes.runResult.stderr);
    ctx.assert.equal(deployRes.runResult.envMode, 0o600);
    ctx.assert.assertNoSecrets(`${deployRes.runResult.stdout}\n${deployRes.runResult.stderr}`);

    // Step 2: Host setup/login & non-destructive live verification vs full harness onboarding
    await resetIfHarness(ctx, { initialized: false, needsModel: true });
    const adminClient = makeClient(t, ctx, { deviceToken: null });
    const deviceClient = makeClient(t, ctx);

    if (ctx.harness) {
      const setupKey = ctx.harness.getSetupKey();
      const setupRes = await adminClient.adminSetup(setupKey, ctx.adminPassword);
      ctx.assert.assertStatus(setupRes, 200);

      const health = await adminClient.health();
      ctx.assert.assertStatus(health, 200);
      ctx.assert.equal(health.json.initialized, true);
      ctx.assert.equal(health.json.brand, 'RokBot');

      // Step 3: Public /connect/status shows needsModel before pairing
      const pubBefore = await deviceClient.connectStatus({ auth: false });
      ctx.assert.assertStatus(pubBefore, 200);
      ctx.assert.assertNoSecrets(pubBefore.json, [ctx.adminPassword], { forbidTokenKey: true });
      ctx.assert.equal(pubBefore.json.needsModel, true);

      // Step 4: Admin issues pairing key & user pairs device with admin password for model config
      const keyRes = await adminClient.createPairingKey();
      ctx.assert.assertStatus(keyRes, 201);
      const pairRes = await deviceClient.pairWithPassword({
        password: ctx.adminPassword,
        deviceName: 'Beginner Desktop',
        platform: 'desktop',
        clientDeviceId: 't4-01-beginner-desktop',
      });
      ctx.assert.assertStatus(pairRes, 201);

      const locBefore = await deviceClient.localStatus();
      ctx.assert.assertStatus(locBefore, 200);
      ctx.assert.equal(locBefore.json.canConfigureModel, true);
      ctx.assert.equal(locBefore.json.brand, 'RokBot');
      ctx.assert.equal(locBefore.json.needsModel, true);

      const blockedPrompt = await deviceClient.apiCall('sendPrompt', { prompt: 'hello' });
      ctx.assert.assertStatus(blockedPrompt, 409);

      // Step 5: Probe upstream catalog, test model, and save /local/model
      const apiKey = 'sk-t401-user-api-key-9988';
      const catRes = await deviceClient.probeModelCatalog({
        baseUrl: 'https://api.openai.com/v1',
        apiKey,
      });
      ctx.assert.assertStatus(catRes, 200);
      ctx.assert.ok(catRes.json.models.length > 0);
      const selectedModel = catRes.json.models[0].id;

      const testRes = await deviceClient.testModel({
        baseUrl: 'https://api.openai.com/v1',
        apiKey,
        model: selectedModel,
      });
      ctx.assert.assertStatus(testRes, 200);
      ctx.assert.equal(testRes.json.reply, 'OK');

      const saveRes = await deviceClient.putLocalModel({
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: selectedModel,
        apiKey,
      });
      ctx.assert.assertStatus(saveRes, 200);
      ctx.assert.equal(saveRes.json.config.hasApiKey, true);
      ctx.assert.assertNoSecrets(saveRes.json, [apiKey, ctx.adminPassword], { forbidTokenKey: true });

      const pubAfter = await deviceClient.connectStatus({ auth: false });
      ctx.assert.assertStatus(pubAfter, 200);
      ctx.assert.equal(pubAfter.json.needsModel, false);

      // Step 6: First streaming chat over /events SSE
      const sse = await deviceClient.openSse('/events');
      t.after(() => sse.close());
      const promptRes = await deviceClient.apiCall('sendPrompt', { prompt: 'Verify RokBot ready' });
      ctx.assert.assertStatus(promptRes, 200);

      const chunkEv = await sse.nextEvent((ev) => ev.data?.channel === 'agent-chunk', 3000);
      ctx.assert.ok(chunkEv.data.payload.delta.length > 0);
      const doneEv = await sse.nextEvent((ev) => ev.data?.channel === 'agent-done', 3000);
      ctx.assert.equal(doneEv.data.payload.reply, 'OK: Verify RokBot ready');
      ctx.assert.assertNoSecrets(doneEv.data, [apiKey, ctx.adminPassword], { forbidTokenKey: true });
    } else {
      await loginAdmin(adminClient, ctx);
      const sess = await adminClient.adminSession();
      ctx.assert.assertStatus(sess, 200);
      if (!sess.json.initialized) {
        t.skip('Live uninitialized host requires one-time setup key');
      }

      const health = await adminClient.health();
      ctx.assert.assertStatus(health, 200);
      ctx.assert.equal(health.json.initialized, true);

      const pubStatus = await deviceClient.connectStatus({ auth: false });
      ctx.assert.assertStatus(pubStatus, 200);
      ctx.assert.equal(pubStatus.json.brand, 'RokBot');
      ctx.assert.assertNoSecrets(pubStatus.json, [ctx.adminPassword], { forbidTokenKey: true });

      const keyRes = await adminClient.createPairingKey();
      ctx.assert.assertStatus(keyRes, 201);
      ctx.assert.ok(keyRes.json.pairingKey.length >= 6);

      await ensureSharedLiveDevice(adminClient, deviceClient, ctx);
      const locStatus = await deviceClient.localStatus();
      ctx.assert.assertStatus(locStatus, 200);
      ctx.assert.equal(locStatus.json.brand, 'RokBot');
      ctx.assert.equal(locStatus.json.initialized, true);
      ctx.assert.assertNoSecrets(locStatus.json, [ctx.adminPassword, deviceClient.deviceToken].filter(Boolean), { forbidTokenKey: true });
    }
  });

  // T4-02: Multi-Device Lifecycle: Android + iOS + Desktop + Web Pairing, clientDeviceId Dedup & Push Suppression
  test('T4-02', 'Multi-Device Lifecycle: Android/iOS/Desktop/Web pairing, dedup, push suppression & revoke', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness publishNotification & getPushHistory hooks');
    }
    await resetIfHarness(ctx);
    const adminClient = makeClient(t, ctx, { deviceToken: null });
    await loginAdmin(adminClient, ctx);

    const androidClient = makeClient(t, ctx, { deviceToken: null });
    const iosClient = makeClient(t, ctx, { deviceToken: null });
    const desktopClient = makeClient(t, ctx, { deviceToken: null });
    const webClient = makeClient(t, ctx, { deviceToken: null });

    // 1. Pair Android (must use platform: 'desktop', clientKind: 'android'), iOS, Desktop, and Web
    const kAnd1 = await adminClient.createPairingKey();
    const pairAnd1 = await androidClient.pairWithKey({
      pairingKey: kAnd1.json.pairingKey,
      deviceName: 'Pixel Emulator',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'and-life-001',
    });
    ctx.assert.assertStatus(pairAnd1, 201);
    const firstAndToken = pairAnd1.json.token;

    const kIos = await adminClient.createPairingKey();
    const pairIos = await iosClient.pairWithKey({
      pairingKey: kIos.json.pairingKey,
      deviceName: 'iPhone 16 Pro',
      platform: 'ios',
      clientDeviceId: 'ios-life-001',
      bundleId: 'dev.rokbot.local',
    });
    ctx.assert.assertStatus(pairIos, 201);

    const kDesk = await adminClient.createPairingKey();
    const pairDesk = await desktopClient.pairWithKey({
      pairingKey: kDesk.json.pairingKey,
      deviceName: 'MacBook Pro',
      platform: 'desktop',
      clientDeviceId: 'desk-life-001',
    });
    ctx.assert.assertStatus(pairDesk, 201);

    const kWeb = await adminClient.createPairingKey();
    const pairWeb = await webClient.webPair({
      pairingKey: kWeb.json.pairingKey,
      deviceName: 'Chrome Web',
      clientDeviceId: 'web-life-001',
    });
    ctx.assert.assertStatus(pairWeb, 201);

    // 2. Re-pair Android with same clientDeviceId -> dedup reuses deviceId and rotates token
    const kAnd2 = await adminClient.createPairingKey();
    const pairAnd2 = await androidClient.pairWithKey({
      pairingKey: kAnd2.json.pairingKey,
      deviceName: 'Pixel Emulator Re-paired',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'and-life-001',
    });
    ctx.assert.assertStatus(pairAnd2, 201);
    ctx.assert.equal(pairAnd2.json.reused, true);
    ctx.assert.equal(pairAnd2.json.deviceId, pairAnd1.json.deviceId);
    ctx.assert.notEqual(pairAnd2.json.token, firstAndToken);
    ctx.assert.assertStatus(await androidClient.localStatus({ bearer: firstAndToken }), 401);

    // 3. Admin confirms 4 distinct active devices
    const devicesRes = await adminClient.listDevices();
    ctx.assert.assertStatus(devicesRes, 200);
    const active = devicesRes.json.devices.filter((d) => !d.revokedAt);
    ctx.assert.equal(active.length, 4);

    // 4. Register public HTTPS webhook push on Android & iOS
    ctx.assert.assertStatus(
      await androidClient.updateDevice({ push: { provider: 'webhook', webhookUrl: 'https://push.example.com/and' } }),
      200,
    );
    ctx.assert.assertStatus(
      await iosClient.updateDevice({ push: { provider: 'apns', webhookUrl: 'https://push.example.com/ios' } }),
      200,
    );

    // 5. Open Android foreground SSE -> suppress Android push while iOS receives push
    const andSse = await androidClient.openSse('/notifications/events', {
      headers: { 'x-rokbot-foreground': '1' },
    });
    const n1 = ctx.harness.publishNotification({ title: 'Message 1', body: 'Foreground active' });
    const ev1 = await andSse.nextEvent((e) => e.data?.id === n1.id, 3000);
    ctx.assert.equal(ev1.data.title, 'Message 1');

    const hist1 = ctx.harness.getPushHistory();
    ctx.assert.ok(hist1.suppressed.some((s) => s.deviceId === pairAnd2.json.deviceId && s.reason === 'foreground'));
    ctx.assert.ok(hist1.sent.some((s) => s.deviceId === pairIos.json.deviceId));

    // 6. Close Android SSE -> background push now sent AND Last-Event-ID replays missed notification
    await andSse.close();
    const bgState = await pollUntil(async () => {
      const d = await androidClient.getDevice();
      return { done: d.json?.push?.foreground === false, value: d };
    });
    ctx.assert.equal(bgState.json.push.foreground, false);

    const n2 = ctx.harness.publishNotification({ title: 'Message 2', body: 'Background wake' });
    const hist2 = ctx.harness.getPushHistory();
    ctx.assert.ok(hist2.sent.some((s) => s.deviceId === pairAnd2.json.deviceId && s.payload.id === n2.id));

    const andSseReplay = await androidClient.openSse('/notifications/events', { lastEventId: ev1.id });
    t.after(() => andSseReplay.close());
    const replayed = await andSseReplay.nextEvent((e) => e.data?.id === n2.id, 3000);
    ctx.assert.equal(replayed.data.title, 'Message 2');

    // 7. Revoke Desktop & log out Web
    ctx.assert.assertStatus(await adminClient.revokeDevice(pairDesk.json.deviceId), 200);
    ctx.assert.assertStatus(await desktopClient.localStatus(), 401);
    ctx.assert.assertStatus(await webClient.webLogout(), 200);
    ctx.assert.assertStatus(await webClient.localStatus(), 401);
  });

  // T4-03: Android Admin Release Upload -> RBDELTA1 Delta Generation -> Client Fetch, Reconstruct & SHA-256/Cert Verify
  test('T4-03', 'Android release upload -> RBDELTA1 delta -> client fetch, reconstruct & SHA-256/cert verify', async (t) => {
    await resetIfHarness(ctx);
    const adminClient = makeClient(t, ctx, { deviceToken: null });
    const androidClient = makeClient(t, ctx);
    await loginAdmin(adminClient, ctx);

    if (ctx.harness) {
      const kAnd = await adminClient.createPairingKey();
      ctx.assert.assertStatus(kAnd, 201);
      const pairRes = await androidClient.pairWithKey({
        pairingKey: kAnd.json.pairingKey,
        deviceName: 'Android Release Tester',
        platform: 'desktop',
        clientKind: 'android',
        clientDeviceId: 't4-03-and-rel',
      });
      ctx.assert.assertStatus(pairRes, 201);
    } else {
      await ensureSharedLiveDevice(adminClient, androidClient, ctx);
    }

    const certSha = 'c3'.repeat(32);
    const apkV1 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'AndroidManifest.xml', data: Buffer.from('package="dev.rokbot.nativeapp" versionCode="100"') },
      { name: 'classes.dex', data: Buffer.from('rokbot-android-dex-payload-'.repeat(300)) },
      { name: 'res/mipmap-xxxhdpi/ic_launcher.png', data: Buffer.from('png-logo-v1-'.repeat(40)) },
    ]);
    const apkV2 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'AndroidManifest.xml', data: Buffer.from('package="dev.rokbot.nativeapp" versionCode="200"') },
      { name: 'classes.dex', data: Buffer.from('rokbot-android-dex-payload-'.repeat(300)) },
      { name: 'res/mipmap-xxxhdpi/ic_launcher.png', data: Buffer.from('png-logo-v2-'.repeat(40)) },
      { name: 'classes2.dex', data: Buffer.from('rokbot-models-activity-'.repeat(100)) },
    ]);

    const up1 = await adminClient.adminUploadUpdate({
      platform: 'android',
      filename: 'rokbot-1.16.0.apk',
      bytes: apkV1,
    });
    ctx.assert.assertStatus(up1, 201);
    const pub1 = await adminClient.adminPublishUpdate({
      platform: 'android',
      version: '1.16.0',
      versionCode: 100,
      packageName: 'dev.rokbot.nativeapp',
      certificateSha256: certSha,
      filename: 'rokbot-1.16.0.apk',
      ...(up1.json.artifact?.id ? { artifactId: up1.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub1, 201);
    registerLiveReleaseCleanup(t, adminClient, ctx, 'android', pub1.json.release.id);

    const up2 = await adminClient.adminUploadUpdate({
      platform: 'android',
      filename: 'rokbot-1.17.0.apk',
      bytes: apkV2,
      multipart: Boolean(ctx.harness),
    });
    ctx.assert.assertStatus(up2, 201);
    const pub2 = await adminClient.adminPublishUpdate({
      platform: 'android',
      version: '1.17.0',
      versionCode: 200,
      packageName: 'dev.rokbot.nativeapp',
      certificateSha256: certSha,
      filename: 'rokbot-1.17.0.apk',
      ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
      generateDeltaFrom: up1.json.artifact?.id ?? pub1.json.release?.id ?? 'rokbot-1.16.0.apk',
      releaseNotes: 'RokBot Android 1.17.0 with in-app ModelsActivity',
    });
    ctx.assert.assertStatus(pub2, 201);
    registerLiveReleaseCleanup(t, adminClient, ctx, 'android', pub2.json.release.id);

    const adminUpdates = await adminClient.adminListUpdates();
    ctx.assert.assertStatus(adminUpdates, 200);
    const sigAlg = adminUpdates.json.signatureAlgorithm ?? adminUpdates.json.signingKey?.algorithm;
    ctx.assert.equal(sigAlg, 'ecdsa-p256-sha256');

    // Paired Android checks manifest
    const feedRes = await androidClient.getUpdateManifest('android');
    ctx.assert.assertStatus(feedRes, 200);
    const manifest = feedRes.json;
    ctx.assert.equal(manifest.schema, ctx.cryptoDelta.ANDROID_NATIVE_UPDATE_SCHEMA);
    ctx.assert.equal(manifest.latest.certificateSha256, certSha);

    if (ctx.harness || (manifest.signature && manifest.publicKeyPem)) {
      const adminPubPem = adminUpdates.json.publicKeyPem ?? adminUpdates.json.signingKey?.publicKeyPem;
      if (adminPubPem) {
        ctx.assert.equal(manifest.publicKeyPem, adminPubPem);
      }
      ctx.cryptoDelta.verifyAndroidManifest(manifest, manifest.publicKeyPem);
      ctx.cryptoDelta.verifyAndroidDeltas(manifest, manifest.publicKeyPem);
    }

    const delta = manifest.latest.deltas.find((d) => d.fromVersionCode === 100);
    ctx.assert.ok(delta, 'Expected delta from versionCode 100');
    ctx.assert.equal(delta.format, 'RBDELTA1');
    ctx.assert.equal(delta.baseSha256, ctx.cryptoDelta.sha256Hex(apkV1));

    // Client downloads delta (Range check + full download)
    const rangeRes = await androidClient.downloadUpdateFile(delta.url, { range: 'bytes=0-31' });
    ctx.assert.assertStatus(rangeRes, 206);
    ctx.assert.equal(rangeRes.buffer.length, 32);

    const deltaDl = await androidClient.downloadUpdateFile(delta.url);
    ctx.assert.assertStatus(deltaDl, 200);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(deltaDl.buffer), delta.sha256);

    const hdr = ctx.cryptoDelta.inspectRbDeltaHeader(deltaDl.buffer);
    ctx.assert.equal(hdr.magic, 'RBDELTA1');
    ctx.assert.equal(hdr.baseSize, apkV1.length);
    ctx.assert.equal(hdr.targetSize, apkV2.length);

    const rebuilt = ctx.cryptoDelta.applyRbDelta(apkV1, deltaDl.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuilt), ctx.cryptoDelta.sha256Hex(apkV2));
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuilt), manifest.latest.apkSha256);

    // Full APK URL also serves exact bytes
    const fullApkDl = await androidClient.downloadUpdateFile(manifest.latest.apkUrl ?? manifest.url);
    ctx.assert.assertStatus(fullApkDl, 200);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(fullApkDl.buffer), manifest.latest.apkSha256);
  });

  // T4-04: Desktop (macOS/Windows) Signed RBD1 ASAR/Installer Delta -> ECDSA P-256 Verify -> Reconstruct & Integrity Check
  test('T4-04', 'Desktop (macOS/Windows) signed RBD1 ASAR/installer delta -> ECDSA P-256 verify -> reconstruct', async (t) => {
    await resetIfHarness(ctx);
    const adminClient = makeClient(t, ctx, { deviceToken: null });
    const desktopClient = makeClient(t, ctx);
    await loginAdmin(adminClient, ctx);

    if (ctx.harness) {
      const kDesk = await adminClient.createPairingKey();
      ctx.assert.assertStatus(kDesk, 201);
      const pairRes = await desktopClient.pairWithKey({
        pairingKey: kDesk.json.pairingKey,
        deviceName: 'Desktop Release Verifier',
        platform: 'desktop',
        clientDeviceId: 't4-04-desk-rel',
      });
      ctx.assert.assertStatus(pairRes, 201);
    } else {
      await ensureSharedLiveDevice(adminClient, desktopClient, ctx);
    }

    // macOS ASAR delta
    const asarV1 = ctx.cryptoDelta.buildSyntheticAsar(
      { files: { 'index.js': { size: 4096, offset: '0' } } },
      Buffer.alloc(4096, 0x41),
    );
    const asarV2 = ctx.cryptoDelta.buildSyntheticAsar(
      { files: { 'index.js': { size: 4096, offset: '0' }, 'model-config.js': { size: 400, offset: '4096' } } },
      Buffer.concat([Buffer.alloc(4096, 0x41), Buffer.alloc(400, 0x42)]),
    );

    const upM1 = await adminClient.adminUploadUpdate({ platform: 'macos', filename: 'app-1.2.2.asar', bytes: asarV1.bytes });
    ctx.assert.assertStatus(upM1, 201);
    const upM2 = await adminClient.adminUploadUpdate({ platform: 'macos', filename: 'app-1.2.3.asar', bytes: asarV2.bytes });
    ctx.assert.assertStatus(upM2, 201);
    const pubMac = await adminClient.adminPublishUpdate({
      platform: 'macos',
      version: '1.2.3',
      filename: 'app-1.2.3.asar',
      ...(upM2.json.artifact?.id ? { artifactId: upM2.json.artifact.id } : {}),
      asarSha256: asarV2.sha256,
      asarHeaderSha256: asarV2.headerSha256,
      generateDeltaFrom: upM1.json.artifact?.id ?? 'app-1.2.2.asar',
      releaseNotes: 'RokBot macOS 1.2.3 ASAR delta',
    });
    ctx.assert.assertStatus(pubMac, 201);
    registerLiveReleaseCleanup(t, adminClient, ctx, 'macos', pubMac.json.release.id);

    const macFeed = await desktopClient.getUpdateManifest('macos');
    ctx.assert.assertStatus(macFeed, 200);
    ctx.assert.equal(macFeed.json.schema, ctx.cryptoDelta.DESKTOP_UPDATE_SCHEMA);
    ctx.cryptoDelta.verifyDesktopManifest(macFeed.json, macFeed.json.publicKeyPem);
    ctx.cryptoDelta.verifyDesktopDeltas(macFeed.json, macFeed.json.publicKeyPem);

    let macDeltaUrl;
    if (ctx.harness) {
      ctx.assert.equal(macFeed.json.latest.asarDeltas.length, 1);
      macDeltaUrl = macFeed.json.latest.asarDeltas[0].url;
    } else {
      const macDeltas = macFeed.json.latest.asarDeltas?.length
        ? macFeed.json.latest.asarDeltas
        : macFeed.json.latest.deltas;
      ctx.assert.equal(macDeltas.length, 1, 'Expected desktop delta entry for macOS ASAR');
      macDeltaUrl = macDeltas[0].url;
    }

    const macDeltaDl = await desktopClient.downloadUpdateFile(macDeltaUrl);
    ctx.assert.assertStatus(macDeltaDl, 200);
    const macHdr = ctx.cryptoDelta.inspectRbd1Header(macDeltaDl.buffer);
    ctx.assert.equal(macHdr.magic, 'RBD1');
    ctx.assert.equal(macHdr.sourceSha256, asarV1.sha256);
    ctx.assert.equal(macHdr.targetSha256, asarV2.sha256);

    const rebuiltAsar = ctx.cryptoDelta.applyRbd1Delta(asarV1.bytes, macDeltaDl.buffer);
    const rebuiltInfo = await ctx.cryptoDelta.readAsarHeaderInfo(rebuiltAsar);
    ctx.assert.equal(rebuiltInfo.sha256, asarV2.sha256);
    ctx.assert.equal(rebuiltInfo.headerSha256, asarV2.headerSha256);

    // Windows installer delta
    const winV1 = Buffer.concat([Buffer.from('ROKBOT-WIN-1.2.2-'), Buffer.alloc(4096, 0x71)]);
    const winV2 = Buffer.concat([Buffer.from('ROKBOT-WIN-1.2.3-'), Buffer.alloc(3840, 0x71), Buffer.alloc(512, 0x72)]);
    const upW1 = await adminClient.adminUploadUpdate({ platform: 'windows', filename: 'RokBot-Setup-1.2.2.exe', bytes: winV1 });
    ctx.assert.assertStatus(upW1, 201);
    const upW2 = await adminClient.adminUploadUpdate({ platform: 'windows', filename: 'RokBot-Setup-1.2.3.exe', bytes: winV2 });
    ctx.assert.assertStatus(upW2, 201);
    const pubWin = await adminClient.adminPublishUpdate({
      platform: 'windows',
      version: '1.2.3',
      filename: 'RokBot-Setup-1.2.3.exe',
      ...(upW2.json.artifact?.id ? { artifactId: upW2.json.artifact.id } : {}),
      generateDeltaFrom: upW1.json.artifact?.id ?? 'RokBot-Setup-1.2.2.exe',
    });
    ctx.assert.assertStatus(pubWin, 201);
    registerLiveReleaseCleanup(t, adminClient, ctx, 'windows', pubWin.json.release.id);

    const winFeed = await desktopClient.getUpdateManifest('windows');
    ctx.assert.assertStatus(winFeed, 200);
    ctx.cryptoDelta.verifyDesktopManifest(winFeed.json, winFeed.json.publicKeyPem);
    ctx.cryptoDelta.verifyDesktopDeltas(winFeed.json, winFeed.json.publicKeyPem);
    ctx.assert.equal(winFeed.json.latest.deltas.length, 1);

    const winDeltaDl = await desktopClient.downloadUpdateFile(winFeed.json.latest.deltas[0].url);
    ctx.assert.assertStatus(winDeltaDl, 200);
    const rebuiltWin = ctx.cryptoDelta.applyRbd1Delta(winV1, winDeltaDl.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuiltWin), ctx.cryptoDelta.sha256Hex(winV2));

    // Tamper rejection
    const tamperedMac = structuredClone(macFeed.json);
    tamperedMac.sha256 = '00'.repeat(32);
    tamperedMac.latest.sha256 = '00'.repeat(32);
    ctx.assert.throws(() => ctx.cryptoDelta.verifyDesktopManifest(tamperedMac, macFeed.json.publicKeyPem));
  });

  // T4-05: iOS OTA Dual-Channel Flow: rokbot-ios-update/v1 -> Tokenized manifest.plist & altstore.json
  test('T4-05', 'iOS OTA Dual-Channel Flow: rokbot-ios-update/v1 -> manifest.plist & altstore.json', async (t) => {
    await resetIfHarness(ctx);
    const adminClient = makeClient(t, ctx, { deviceToken: null });
    const iosClient = makeClient(t, ctx);
    const otaClient = makeClient(t, ctx, { deviceToken: null });
    await loginAdmin(adminClient, ctx);

    if (ctx.harness) {
      const kIos = await adminClient.createPairingKey();
      ctx.assert.assertStatus(kIos, 201);
      const pairRes = await iosClient.pairWithKey({
        pairingKey: kIos.json.pairingKey,
        deviceName: 'iPhone OTA Verifier',
        platform: 'ios',
        clientDeviceId: 't4-05-ios-ota',
        bundleId: 'dev.rokbot.local',
      });
      ctx.assert.assertStatus(pairRes, 201);
    } else {
      await ensureSharedLiveDevice(adminClient, iosClient, ctx);
    }

    const ipaV1 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'Payload/RokBot.app/Info.plist', data: 'CFBundleIdentifier=dev.rokbot.local;1.16.0' },
      { name: 'Payload/RokBot.app/Frameworks/RokBotLocal.dylib', data: Buffer.alloc(512, 0xcd) },
    ]);
    const up1 = await adminClient.adminUploadUpdate({ platform: 'ios', filename: 'RokBot-1.16.0.ipa', bytes: ipaV1 });
    ctx.assert.assertStatus(up1, 201);
    const pub1 = await adminClient.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      filename: 'RokBot-1.16.0.ipa',
      ...(up1.json.artifact?.id ? { artifactId: up1.json.artifact.id } : {}),
      releaseNotes: 'RokBot iOS 1.16.0 OTA',
    });
    ctx.assert.assertStatus(pub1, 201);
    registerLiveReleaseCleanup(t, adminClient, ctx, 'ios', pub1.json.release.id);

    const feed1 = await iosClient.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed1, 200);
    ctx.assert.equal(feed1.json.schema, ctx.cryptoDelta.IOS_UPDATE_SCHEMA);
    const m1 = feed1.json.latest.installMethods;
    const itmsHref1 = m1.itmsServicesHref ?? m1.itmsServicesUrl;
    ctx.assert.ok(
      typeof itmsHref1 === 'string' && itmsHref1.startsWith('itms-services://?action=download-manifest&url='),
      'Expected itms-services:// download-manifest URL',
    );
    const plist1Url = resolveIosPlistUrl(m1);

    // Unauthenticated iOS OTA fetches (Apple itms-services & AltStore/SideStore)
    const plistRes = await otaClient.fetchIosPlist(plist1Url);
    ctx.assert.assertStatus(plistRes, 200);
    const plistCheck = ctx.cryptoDelta.validateIosManifestPlist(plistRes.text, {
      bundleId: 'dev.rokbot.local',
      bundleVersion: '1.16.0',
      ipaUrl: m1.ipaDownloadUrl,
    });
    ctx.assert.equal(plistCheck.ok, true, plistCheck.errors.join('; '));

    const altRes = await otaClient.fetchIosAltStore(m1.altStoreSourceUrl);
    ctx.assert.assertStatus(altRes, 200);
    const altCheck = ctx.cryptoDelta.validateAltStoreJson(altRes.json, { bundleId: 'dev.rokbot.local' });
    ctx.assert.equal(altCheck.ok, true, altCheck.errors.join('; '));

    const ipaRange = await otaClient.downloadUpdateFile(m1.ipaDownloadUrl, { auth: false, range: 'bytes=0-15' });
    ctx.assert.assertStatus(ipaRange, 206);
    const ipaFull = await otaClient.downloadUpdateFile(m1.ipaDownloadUrl, { auth: false });
    ctx.assert.assertStatus(ipaFull, 200);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(ipaFull.buffer), feed1.json.latest.sha256);

    // Second iOS release -> verify new plist & old tokenized URL invalidation
    const ipaV2 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'Payload/RokBot.app/Info.plist', data: 'CFBundleIdentifier=dev.rokbot.local;1.16.1' },
      { name: 'Payload/RokBot.app/Frameworks/RokBotLocal.dylib', data: Buffer.alloc(512, 0xef) },
    ]);
    const up2 = await adminClient.adminUploadUpdate({ platform: 'ios', filename: 'RokBot-1.16.1.ipa', bytes: ipaV2 });
    ctx.assert.assertStatus(up2, 201);
    const pub2 = await adminClient.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.1',
      build: '23153',
      bundleId: 'dev.rokbot.local',
      filename: 'RokBot-1.16.1.ipa',
      ...(up2.json.artifact?.id ? { artifactId: up2.json.artifact.id } : {}),
    });
    ctx.assert.assertStatus(pub2, 201);
    registerLiveReleaseCleanup(t, adminClient, ctx, 'ios', pub2.json.release.id);

    const feed2 = await iosClient.getUpdateManifest('ios');
    ctx.assert.assertStatus(feed2, 200);
    const plist2Url = resolveIosPlistUrl(feed2.json.latest.installMethods);
    ctx.assert.assertStatus(await otaClient.fetchIosPlist(plist2Url), 200);

    if (ctx.harness) {
      ctx.assert.assertStatus(await otaClient.fetchIosPlist(plist1Url), 403);
      ctx.assert.assertStatus(await otaClient.fetchIosAltStore(m1.altStoreSourceUrl), 403);
    } else {
      ctx.assert.notEqual(plist2Url, plist1Url);
      ctx.assert.assertStatus(await adminClient.adminDeleteUpdate('ios', pub1.json.release.id), 200);
      ctx.assert.assertStatus(await otaClient.fetchIosPlist(plist1Url), 403);
      ctx.assert.assertStatus(await otaClient.fetchIosAltStore(m1.altStoreSourceUrl), 403);
    }

    // Delete release cleans up
    const del2 = await adminClient.adminDeleteUpdate('ios', pub2.json.release.id);
    ctx.assert.assertStatus(del2, 200);
  });

  // T4-06: ExternalShell Default Machine Routing + Attachment Upload + Library File CRUD + SSE Chat
  test('T4-06', 'ExternalShell Default Machine Routing + Attachment + Library File CRUD + SSE Chat', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness setComputers/setDefaultMachineId/seedAttachment hooks');
    }
    await resetIfHarness(ctx);
    const adminClient = makeClient(t, ctx, { deviceToken: null });
    const client = makeClient(t, ctx, { deviceToken: null });
    await loginAdmin(adminClient, ctx);

    const pairRes = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'ExternalShell Controller',
      platform: 'desktop',
      clientDeviceId: 't4-06-shell-desk',
    });
    ctx.assert.assertStatus(pairRes, 201);

    ctx.harness.setComputers([
      { id: 'win-box-1', label: 'Windows Runner', connected: true, platform: 'win32' },
      { id: 'mac-box-2', label: 'Mac Studio', connected: true, platform: 'darwin' },
    ]);
    ctx.harness.setDefaultMachineId('mac-box-2');

    const compRes = await client.getComputers();
    ctx.assert.assertStatus(compRes, 200);
    ctx.assert.equal(compRes.json.defaultMachineId, 'mac-box-2');

    const defaultExec = await client.apiCall('localExec', { command: 'uname -a' });
    ctx.assert.assertStatus(defaultExec, 200);
    ctx.assert.equal(defaultExec.json.machineId, 'mac-box-2');

    const explicitExec = await client.apiCall('localExec', { computerId: 'win-box-1', command: 'hostname' });
    ctx.assert.assertStatus(explicitExec, 200);
    ctx.assert.equal(explicitExec.json.machineId, 'win-box-1');

    // Create dedicated agent -> seed attachment -> library CRUD -> SSE chat -> delete agent
    const agentRes = await client.createAgent({ name: 'Workspace Assistant' });
    ctx.assert.assertStatus(agentRes, 200);
    const agentId = agentRes.agentId;

    const iconRes = await client.getIcon();
    ctx.assert.assertStatus(iconRes, 200);
    const attUrl = await ctx.harness.seedAttachment(agentId, 'capture.png', iconRes.buffer);
    const attRes = await client.readAttachment(attUrl);
    ctx.assert.assertStatus(attRes, 200);
    ctx.assert.ok(attRes.json.dataUrl.startsWith('data:image/png;base64,'));

    const docBytes = Buffer.from('# RokBot Runbook\nMachine: mac-box-2\n', 'utf8');
    const upFile = await client.uploadFile({
      agentId,
      fileName: 'runbook.md',
      contentType: 'text/markdown',
      base64: docBytes.toString('base64'),
    });
    ctx.assert.assertStatus(upFile, 200);

    const listRes = await client.listFiles(agentId);
    ctx.assert.assertStatus(listRes, 200);
    ctx.assert.equal(listRes.json.files.length, 1);

    const getRes = await client.getFileContent(agentId, 'runbook.md');
    ctx.assert.assertStatus(getRes, 200);
    ctx.assert.equal(getRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    ctx.assert.equal(getRes.buffer.equals(docBytes), true);

    const sse = await client.openSse('/events');
    t.after(() => sse.close());
    const chatRes = await client.apiCall('sendPrompt', { agentId, prompt: 'summarize runbook' });
    ctx.assert.assertStatus(chatRes, 200);
    const doneEv = await sse.nextEvent((e) => e.data?.channel === 'agent-done', 3000);
    ctx.assert.equal(doneEv.data.payload.agentId, agentId);
    ctx.assert.equal(doneEv.data.payload.reply, 'OK: summarize runbook');

    ctx.assert.assertStatus(await client.deleteFile({ agentId, name: 'runbook.md' }), 200);
    ctx.assert.assertStatus(await client.apiCall('deleteAgents', { ids: [agentId] }), 200);
    ctx.assert.assertStatus(await client.listFiles(agentId), 404);
  });

  // T4-07: Model Hot-Swap & Security Audit: apiKey Preservation, Reload State Transition, Unauthorized Guest Block
  test('T4-07', 'Model Hot-Swap & Security Audit: apiKey preservation, waiting -> applied, guest block', async (t) => {
    if (!ctx.harness) {
      t.skip('Requires harness setModelReloadBehavior & getAuditLog hooks');
    }
    await resetIfHarness(ctx);
    ctx.harness.setModelReloadBehavior({ mode: 'waiting-then-applied', delayMs: 40 });
    t.after(() => ctx.harness.setModelReloadBehavior({ mode: 'immediate', delayMs: 40 }));

    const adminClient = makeClient(t, ctx, { deviceToken: null });
    const adminDevice = makeClient(t, ctx, { deviceToken: null });
    const guestDevice = makeClient(t, ctx, { deviceToken: null });
    await loginAdmin(adminClient, ctx);

    // Seed initial model via admin-password-paired device
    const adminPairRes = await adminDevice.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Admin Workstation',
      platform: 'desktop',
      clientDeviceId: 't4-07-admin-ws',
    });
    ctx.assert.assertStatus(adminPairRes, 201, 'pair admin workstation');

    const initialKey = 'sk-t407-initial-secret-1111';
    const rotatedKey = 'sk-ant-t407-rotated-secret-2222';
    const putInit = await adminDevice.putLocalModel({
      apiFormat: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: initialKey,
    });
    ctx.assert.assertStatus(putInit, 200);
    ctx.assert.equal(putInit.json.reload.status, 'waiting');

    await pollUntil(async () => {
      const r = await adminDevice.getLocalModel();
      return { done: r.json?.reload?.status === 'applied', value: r };
    });

    // Pair guest device with pairing key -> blocked 403 on /local/model
    const keyRes = await adminClient.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201, 'createPairingKey');
    const guestPairRes = await guestDevice.pairWithKey({
      pairingKey: keyRes.json.pairingKey,
      deviceName: 'Guest Phone',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 't4-07-guest-and',
    });
    ctx.assert.assertStatus(guestPairRes, 201, 'pair guest phone');

    ctx.assert.assertStatus(await guestDevice.getLocalModel(), 403);
    ctx.assert.assertStatus(
      await guestDevice.putLocalModel({
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
      }),
      403,
    );

    // Step-up admin password header allows edit while preserving existing apiKey when omitted
    const stepUpEdit = await guestDevice.putLocalModel(
      {
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(stepUpEdit, 200);
    ctx.assert.equal(stepUpEdit.json.reload.status, 'waiting');
    ctx.assert.equal(stepUpEdit.json.config.hasApiKey, true);

    const polledEdit = await pollUntil(async () => {
      const r = await adminDevice.getLocalModel();
      return { done: r.json?.reload?.status === 'applied', value: r };
    });
    ctx.assert.equal(polledEdit.json.reload.status, 'applied');
    ctx.assert.equal(polledEdit.json.config.profiles[0].model, 'gpt-4.1');

    // Hot-swap to Anthropic profile with rotated key
    const hotSwap = await adminDevice.putLocalModel({
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-7-sonnet',
      apiKey: rotatedKey,
    });
    ctx.assert.assertStatus(hotSwap, 200);
    ctx.assert.equal(hotSwap.json.reload.status, 'waiting');

    const polledSwap = await pollUntil(async () => {
      const r = await adminDevice.getLocalModel();
      return { done: r.json?.reload?.status === 'applied', value: r };
    });
    ctx.assert.equal(polledSwap.json.reload.status, 'applied');

    const testSwap = await adminDevice.testModel({ model: 'claude-3-7-sonnet' });
    ctx.assert.assertStatus(testSwap, 200);
    ctx.assert.equal(testSwap.json.model, 'claude-3-7-sonnet');

    const sse = await adminDevice.openSse('/events');
    t.after(() => sse.close());
    const promptRes = await adminDevice.apiCall('sendPrompt', { prompt: 'check hot-swap' });
    ctx.assert.assertStatus(promptRes, 200);
    const doneEv = await sse.nextEvent((e) => e.data?.channel === 'agent-done', 3000);
    ctx.assert.equal(doneEv.data.payload.model, 'claude-3-7-sonnet');

    // Full secret audit across responses and audit log
    const secrets = [initialKey, rotatedKey, ctx.adminPassword, adminDevice.deviceToken, guestDevice.deviceToken];
    ctx.assert.assertNoSecrets(polledSwap.json, secrets, { forbidTokenKey: true, label: 'GET /local/model' });
    ctx.assert.assertNoSecrets((await adminDevice.connectStatus()).json, secrets, { forbidTokenKey: true, label: '/connect/status' });
    ctx.assert.assertNoSecrets((await adminDevice.localStatus()).json, secrets, { forbidTokenKey: true, label: '/local/status' });
    ctx.assert.assertNoSecrets(ctx.harness.getAuditLog(), secrets, { forbidTokenKey: true, label: 'auditLog' });
  });

  // T4-08: Brand & Asset End-to-End Consistency: Logo, Category-A Rebranding, Category-B Compat & Privacy Hygiene
  test('T4-08', 'Brand & Asset End-to-End Consistency: Logo, Category-A/B Rebranding & Privacy Hygiene', async (t) => {
    await resetIfHarness(ctx);
    const client = makeClient(t, ctx);
    await loginAdmin(client, ctx);
    if (ctx.harness) {
      const pairRes = await client.pairWithPassword({
        password: ctx.adminPassword,
        deviceName: 'Brand Consistency Client',
        platform: 'desktop',
        clientDeviceId: 't4-08-brand',
      });
      ctx.assert.assertStatus(pairRes, 201);
    } else {
      await ensureSharedLiveDevice(client, client, ctx);
    }

    // 1. Live HTTP icon + web manifest
    const iconRes = await client.getIcon('GET');
    ctx.assert.assertStatus(iconRes, 200);
    const pngInfo = ctx.repoChecks.inspectPng(iconRes.buffer);
    ctx.assert.equal(pngInfo.width, 512);
    ctx.assert.equal(pngInfo.height, 512);
    ctx.assert.equal(pngInfo.colorType, 6);
    ctx.assert.equal(pngInfo.hasAlpha, true);

    const webManifest = await client.getWebManifest();
    if (ctx.harness || webManifest.status !== 404) {
      ctx.assert.assertStatus(webManifest, 200);
      ctx.assert.equal(webManifest.json.name, 'RokBot');
      const allowedIconSrcs = ctx.harness
        ? ['/rokbot-icon.png']
        : ['/rokbot-icon.png', '/web/client/icon.png', '/web/client/icon-512.png'];
      ctx.assert.ok(Array.isArray(webManifest.json.icons) && webManifest.json.icons.length > 0);
      const matchedIcon = webManifest.json.icons.find((i) => allowedIconSrcs.includes(i.src));
      ctx.assert.ok(
        matchedIcon,
        `Expected manifest icon src in ${allowedIconSrcs.join(', ')}, got ${JSON.stringify(webManifest.json.icons)}`,
      );
      const manifestScan = ctx.repoChecks.scanTextForRebranding(JSON.stringify(webManifest.json));
      ctx.assert.equal(manifestScan.ok, true);
    }

    // 2. Deformed SVG geometry + Category-A/B contract validation
    const svgInput = ctx.repoCheck && existsSync(path.join(ctx.repoRoot, 'assets/logo/rokbot-logo.svg'))
      ? path.join(ctx.repoRoot, 'assets/logo/rokbot-logo.svg')
      : SYNTHETIC_ROKBOT_SVG;
    const svgInfo = ctx.repoChecks.inspectSvg(svgInput);
    ctx.assert.equal(svgInfo.hasBrandFace, true);
    ctx.assert.equal(svgInfo.eyeCount, 2);
    ctx.assert.equal(svgInfo.hasTiltedEyes, true);
    ctx.assert.equal(svgInfo.hasAsymmetricEyes, true);
    ctx.assert.equal(svgInfo.hasBrandAccent, true);
    ctx.assert.equal(svgInfo.rebrandingOk, true);

    const compatSample = [
      'const bundle = "co.anysphere.sand";',
      'const svc = "/aiserver.v1.GrokBotService/StreamChat";',
      'const url = "grokbot://app/v1/chat";',
    ].join('\n');
    ctx.assert.equal(ctx.repoChecks.scanTextForRebranding(compatSample).ok, true);
    ctx.assert.equal(ctx.repoChecks.scanTextForRebranding('ROKBOT_ADMIN_COOKIE=grokbot_admin').ok, false);

    // 3. Integrated repo checks when --repo-check is enabled
    if (ctx.repoCheck) {
      const suiteRes = ctx.repoChecks.verifyLogoSuite(ctx.repoRoot);
      ctx.assert.equal(suiteRes.ok, true, suiteRes.errors.join('; '));

      const repoScan = await ctx.repoChecks.scanRepoRebranding(ctx.repoRoot, {
        includePaths: ['assets', 'docs', 'mac', 'windows', 'web/client', 'web/patchers'],
        excludePaths: ['docs/REBRAND_COMPAT.md'],
      });
      ctx.assert.equal(
        repoScan.ok,
        true,
        `Repo rebranding violations: ${JSON.stringify(repoScan.violations.slice(0, 5))}`,
      );

      for (const rel of [
        'README.md',
        'README.en.md',
        'SECURITY.md',
        'NOTICE',
        'host/release/docker-compose.images.yml',
        'host/release/.env.images.example',
        'host/release/install-images.sh',
      ]) {
        const full = path.join(ctx.repoRoot, rel);
        if (!existsSync(full)) continue;
        const text = await readFile(full, 'utf8');
        const scan = ctx.repoChecks.scanTextForRebranding(text, {
          filePath: rel,
          allowMigrationBridges: true,
          allowHistoricalAttribution: true,
          allowAbiCompat: true,
        });
        ctx.assert.equal(scan.ok, true, `${rel} rebranding violation: ${JSON.stringify(scan.violations)}`);
        const urlCheck = ctx.repoChecks.checkOperationalRepoUrls(text, { allowHistoricalAttribution: true });
        ctx.assert.equal(urlCheck.ok, true, `${rel} URL violation: ${urlCheck.errors.join('; ')}`);
      }
    }

    // 4. Privacy & zero-secret hygiene across public and host metadata endpoints
    const secrets = [ctx.adminPassword, client.deviceToken].filter(Boolean);
    const health = await client.health();
    const pubStatus = await client.connectStatus({ auth: false });
    const webSess = await client.webSession();
    const hostSettings = await client.apiCall('getHostSettings', {});

    ctx.assert.assertStatus(health, 200);
    ctx.assert.assertStatus(pubStatus, 200);
    ctx.assert.assertStatus(webSess, 200);
    ctx.assert.assertStatus(hostSettings, 200);

    ctx.assert.assertNoSecrets(health.json, secrets, { forbidTokenKey: true, label: '/health' });
    ctx.assert.assertNoSecrets(pubStatus.json, secrets, { forbidTokenKey: true, label: '/connect/status' });
    ctx.assert.assertNoSecrets(webSess.json, secrets, { forbidTokenKey: true, label: '/web/api/session' });
    ctx.assert.assertNoSecrets(hostSettings.json, secrets, { forbidTokenKey: true, label: '/api/getHostSettings' });
  });
}

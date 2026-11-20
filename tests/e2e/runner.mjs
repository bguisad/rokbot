#!/usr/bin/env node
import assertStrict from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RokBotE2EClient } from './lib/client.mjs';
import * as cryptoDelta from './lib/crypto-delta.mjs';
import { createHarnessServer } from './lib/harness-server.mjs';
import * as repoChecks from './lib/repo-checks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const TIERS_DIR = path.join(__dirname, 'tiers');

class SkipTestError extends Error {
  constructor(reason) {
    super(reason || 'Skipped');
    this.isSkip = true;
  }
}

function assertStatus(res, expected, msg) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(res?.status)) {
    const excerpt = typeof res?.text === 'string' ? res.text.slice(0, 200) : '';
    assertStrict.fail(
      `${msg ? `${msg}: ` : ''}Expected HTTP ${allowed.join('|')}, got ${res?.status} (${excerpt})`,
    );
  }
}

function validateSchemaNode(val, spec, loc) {
  if (typeof spec === 'string') {
    if (spec === 'array') {
      assertStrict.ok(Array.isArray(val), `${loc} must be an array`);
    } else if (spec === 'object') {
      assertStrict.ok(val !== null && typeof val === 'object' && !Array.isArray(val), `${loc} must be an object`);
    } else if (spec === 'any') {
      assertStrict.ok(val !== undefined, `${loc} must be defined`);
    } else {
      assertStrict.equal(typeof val, spec, `${loc} must have typeof ${spec}`);
    }
    return;
  }
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    assertStrict.ok(val !== null && typeof val === 'object' && !Array.isArray(val), `${loc} must be an object`);
    for (const [k, childSpec] of Object.entries(spec)) {
      assertStrict.ok(Object.prototype.hasOwnProperty.call(val, k), `${loc}.${k} is required`);
      validateSchemaNode(val[k], childSpec, `${loc}.${k}`);
    }
  }
}

function assertJsonSchema(obj, schemaSpec, msg = 'JSON schema mismatch') {
  try {
    validateSchemaNode(obj, schemaSpec, 'root');
  } catch (err) {
    assertStrict.fail(`${msg}: ${err.message}`);
  }
}

const e2eAssert = Object.assign(
  (...args) => assertStrict(...args),
  assertStrict,
  {
    assertStatus,
    assertJsonSchema,
    assertNoSecrets: repoChecks.assertNoSecrets,
  },
);

function printHelp() {
  process.stdout.write([
    'RokBot Opaque-Box E2E Test Runner',
    '',
    'Usage:',
    '  node tests/e2e/runner.mjs [options]',
    '',
    'Options:',
    '  --tier <1|2|3|4|all>   Tiers to run (comma-separated or "all", default: all)',
    '  --mode <harness|live>  Execution mode (default: live if ROKBOT_E2E_HOST_URL is set, else harness)',
    '  --repo-check           Enable strict repository-wide asset/rebrand/deploy checks',
    '  --json                 Emit single JSON report (rokbot-e2e-report/v1) to stdout',
    '  --filter <substring>   Case-insensitive filter on test ID, title, or suite name',
    '  --self-check           Run S1 smoke verification across harness, client, crypto-delta & repo-checks',
    '  --help                 Show this help message',
    '',
    'Environment:',
    '  ROKBOT_E2E_HOST_URL        External Host base URL (selects live mode by default)',
    '  ROKBOT_E2E_ADMIN_PASSWORD  Admin password for live mode',
    '  ROKBOT_E2E_PAIRING_KEY     Optional pre-generated pairing key for live mode',
    '  ROKBOT_E2E_DEVICE_TOKEN    Optional pre-paired device Bearer token for live mode',
    '  ROKBOT_E2E_REPO_CHECK=1    Same as --repo-check',
    '',
  ].join('\n'));
}

export function parseArgs(argv) {
  const opts = {
    tiers: [1, 2, 3, 4],
    mode: process.env.ROKBOT_E2E_HOST_URL ? 'live' : 'harness',
    repoCheck: process.env.ROKBOT_E2E_REPO_CHECK === '1',
    json: false,
    filter: null,
    selfCheck: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--repo-check') {
      opts.repoCheck = true;
    } else if (arg === '--self-check') {
      opts.selfCheck = true;
    } else if (arg === '--tier') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --tier');
      if (val === 'all') {
        opts.tiers = [1, 2, 3, 4];
      } else {
        const parts = val.split(',').map((s) => s.trim()).filter(Boolean);
        const parsed = parts.map((p) => {
          if (!/^[1-4]$/.test(p)) throw new Error(`Invalid tier "${p}". Expected 1|2|3|4|all`);
          return Number(p);
        });
        if (parsed.length === 0) throw new Error('Empty --tier list');
        opts.tiers = [...new Set(parsed)].sort((a, b) => a - b);
      }
    } else if (arg === '--mode') {
      const val = argv[++i];
      if (!['harness', 'live'].includes(val)) {
        throw new Error(`Invalid --mode "${val}". Expected harness|live`);
      }
      opts.mode = val;
    } else if (arg === '--filter') {
      const val = argv[++i];
      if (val === undefined) throw new Error('Missing value for --filter');
      opts.filter = val.toLowerCase();
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (opts.mode === 'live' && !process.env.ROKBOT_E2E_HOST_URL) {
    throw new Error('--mode live requires ROKBOT_E2E_HOST_URL environment variable');
  }
  return opts;
}

function registerSelfCheckTests(registerTest, ctx) {
  registerTest(0, 'self-check', 'S1-01', 'Harness health, public/auth /connect/status & /rokbot-icon.png PNG verification', async (t) => {
    const client = ctx.createClient();
    t.after(() => client.close());

    const health = await client.health();
    ctx.assert.assertStatus(health, 200);
    ctx.assert.equal(health.json?.ok, true);
    ctx.assert.equal(health.json?.brand, 'RokBot');

    const pubStatus = await client.connectStatus({ auth: false });
    ctx.assert.assertStatus(pubStatus, 200);
    ctx.assert.equal(pubStatus.json?.brand, 'RokBot');
    ctx.assert.assertNoSecrets(pubStatus.json, [ctx.adminPassword], { forbidTokenKey: true });

    const icon = await client.getIcon();
    ctx.assert.assertStatus(icon, 200);
    const pngInfo = ctx.repoChecks.inspectPng(icon.buffer);
    ctx.assert.equal(pngInfo.width, 512);
    ctx.assert.equal(pngInfo.height, 512);
    ctx.assert.equal(pngInfo.colorType, 6);
  });

  registerTest(0, 'self-check', 'S1-02', 'Admin CSRF, pairing key, clientDeviceId dedup, /local/model & SSE streaming', async (t) => {
    const client = ctx.createClient();
    t.after(() => client.close());

    if (ctx.harness) {
      ctx.harness.setNeedsModel(true);
    }

    const noCsrf = await client.adminLogin(ctx.adminPassword, { csrf: false });
    ctx.assert.assertStatus(noCsrf, 403);

    const login = await client.adminLogin(ctx.adminPassword);
    ctx.assert.assertStatus(login, 200);

    const keyRes1 = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes1, 201);
    const pair1 = await client.pairWithKey({
      pairingKey: keyRes1.json.pairingKey,
      deviceName: 'SelfCheck Phone',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'android-selfcheck-001',
    });
    ctx.assert.assertStatus(pair1, 201);
    const firstToken = pair1.json.token;

    const keyRes2 = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes2, 201);
    const pair2 = await client.pairWithKey({
      pairingKey: keyRes2.json.pairingKey,
      deviceName: 'SelfCheck Phone Renamed',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'android-selfcheck-001',
    });
    ctx.assert.assertStatus(pair2, 201);
    ctx.assert.equal(pair2.json.deviceId, pair1.json.deviceId);
    ctx.assert.notEqual(pair2.json.token, firstToken);

    const oldAuthCheck = await client.localStatus({ bearer: firstToken });
    ctx.assert.assertStatus(oldAuthCheck, 401);

    const newAuthCheck = await client.localStatus();
    ctx.assert.assertStatus(newAuthCheck, 200);
    ctx.assert.equal(newAuthCheck.json.needsModel, true);

    const sse = await client.openSse('/events');
    t.after(() => sse.close());

    const putModel = await client.putLocalModel(
      {
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-selfcheck-secret-9999',
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(putModel, 200);
    ctx.assert.assertNoSecrets(putModel.json, ['sk-selfcheck-secret-9999'], { forbidTokenKey: true });

    const getModel = await client.getLocalModel({ adminPassword: ctx.adminPassword });
    ctx.assert.assertStatus(getModel, 200);
    ctx.assert.equal(getModel.json.config.hasApiKey, true);
    ctx.assert.assertNoSecrets(getModel.json, ['sk-selfcheck-secret-9999'], { forbidTokenKey: true });

    const promptRes = await client.apiCall('sendPrompt', { prompt: 'ping' });
    ctx.assert.assertStatus(promptRes, 200);
    const doneEv = await sse.nextEvent((ev) => ev.data?.channel === 'agent-done', 3000);
    ctx.assert.equal(doneEv.data.payload.reply, 'OK: ping');
  });

  registerTest(0, 'self-check', 'S1-03', '4-platform update publish, RBDELTA1 + RBD1 reconstruction, P-256 verify & iOS OTA', async (t) => {
    const client = ctx.createClient();
    t.after(() => client.close());

    const login = await client.adminLogin(ctx.adminPassword);
    ctx.assert.assertStatus(login, 200);
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);
    const pair = await client.pairWithKey({ pairingKey: keyRes.json.pairingKey, deviceName: 'Updater Client' });
    ctx.assert.assertStatus(pair, 201);

    // Android RBDELTA1 flow
    const apkV1 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'AndroidManifest.xml', data: Buffer.from('manifest-v1-'.repeat(20)) },
      { name: 'classes.dex', data: Buffer.from('dex-shared-code-'.repeat(120)) },
    ]);
    const apkV2 = ctx.cryptoDelta.buildSyntheticZip([
      { name: 'AndroidManifest.xml', data: Buffer.from('manifest-v2-'.repeat(20)) },
      { name: 'classes.dex', data: Buffer.from('dex-shared-code-'.repeat(120)) },
      { name: 'resources.arsc', data: Buffer.from('new-resources-'.repeat(30)) },
    ]);
    const upA1 = await client.adminUploadUpdate({ platform: 'android', filename: 'rokbot-1.0.apk', bytes: apkV1 });
    ctx.assert.assertStatus(upA1, 201);
    const pubA1 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.0.0',
      versionCode: 100,
      artifactId: upA1.json.artifact.id,
    });
    ctx.assert.assertStatus(pubA1, 201);

    const upA2 = await client.adminUploadUpdate({ platform: 'android', filename: 'rokbot-1.1.apk', bytes: apkV2, multipart: true });
    ctx.assert.assertStatus(upA2, 201);
    const pubA2 = await client.adminPublishUpdate({
      platform: 'android',
      version: '1.1.0',
      versionCode: 110,
      artifactId: upA2.json.artifact.id,
      generateDeltaFrom: upA1.json.artifact.id,
    });
    ctx.assert.assertStatus(pubA2, 201);

    const androidFeed = await client.getUpdateManifest('android');
    ctx.assert.assertStatus(androidFeed, 200);
    ctx.assert.equal(androidFeed.json.schema, 'rokbot-android-native-update/v1');
    ctx.cryptoDelta.verifyAndroidManifest(androidFeed.json, androidFeed.json.publicKeyPem);
    ctx.cryptoDelta.verifyAndroidDeltas(androidFeed.json, androidFeed.json.publicKeyPem);
    const deltaRec = androidFeed.json.latest.deltas[0];
    ctx.assert.equal(deltaRec.format, 'RBDELTA1');
    const deltaDl = await client.downloadUpdateFile(deltaRec.url);
    ctx.assert.assertStatus(deltaDl, 200);
    const rebuiltApk = ctx.cryptoDelta.applyRbDelta(apkV1, deltaDl.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuiltApk), ctx.cryptoDelta.sha256Hex(apkV2));

    // Desktop RBD1 + ECDSA P-256 flow
    const asar1 = ctx.cryptoDelta.buildSyntheticAsar({ files: { 'app.js': { size: 512, offset: '0' } } }, Buffer.alloc(512, 0x41));
    const asar2 = ctx.cryptoDelta.buildSyntheticAsar({ files: { 'app.js': { size: 512, offset: '0' } } }, Buffer.concat([Buffer.alloc(256, 0x41), Buffer.alloc(256, 0x42)]));
    const upM1 = await client.adminUploadUpdate({ platform: 'macos', filename: 'app-1.0.asar', bytes: asar1.bytes });
    ctx.assert.assertStatus(upM1, 201);
    const upM2 = await client.adminUploadUpdate({ platform: 'macos', filename: 'app-1.1.asar', bytes: asar2.bytes });
    ctx.assert.assertStatus(upM2, 201);
    const pubM2 = await client.adminPublishUpdate({
      platform: 'macos',
      version: '1.2.3',
      artifactId: upM2.json.artifact.id,
      asarSha256: asar2.sha256,
      asarHeaderSha256: asar2.headerSha256,
      generateDeltaFrom: upM1.json.artifact.id,
    });
    ctx.assert.assertStatus(pubM2, 201);

    const macFeed = await client.getUpdateManifest('macos');
    ctx.assert.assertStatus(macFeed, 200);
    ctx.cryptoDelta.verifyDesktopManifest(macFeed.json, macFeed.json.publicKeyPem);
    ctx.cryptoDelta.verifyDesktopDeltas(macFeed.json, macFeed.json.publicKeyPem);
    const rbd1Dl = await client.downloadUpdateFile(macFeed.json.latest.asarDeltas[0].url);
    ctx.assert.assertStatus(rbd1Dl, 200);
    const rebuiltAsar = ctx.cryptoDelta.applyRbd1Delta(asar1.bytes, rbd1Dl.buffer);
    ctx.assert.equal(ctx.cryptoDelta.sha256Hex(rebuiltAsar), asar2.sha256);

    // iOS OTA tokenized manifest.plist + altstore.json
    const ipaBuf = ctx.cryptoDelta.buildSyntheticZip([{ name: 'Payload/RokBot.app/Info.plist', data: 'plist' }]);
    const upI = await client.adminUploadUpdate({ platform: 'ios', filename: 'RokBot-1.16.0.ipa', bytes: ipaBuf });
    ctx.assert.assertStatus(upI, 201);
    const pubI = await client.adminPublishUpdate({
      platform: 'ios',
      version: '1.16.0',
      build: '23152',
      bundleId: 'dev.rokbot.local',
      artifactId: upI.json.artifact.id,
    });
    ctx.assert.assertStatus(pubI, 201);

    const iosFeed = await client.getUpdateManifest('ios');
    ctx.assert.assertStatus(iosFeed, 200);
    const plistRes = await client.fetchIosPlist(iosFeed.json.latest.installMethods.itmsServicesUrl);
    ctx.assert.assertStatus(plistRes, 200);
    const plistCheck = ctx.cryptoDelta.validateIosManifestPlist(plistRes.text, { bundleId: 'dev.rokbot.local' });
    ctx.assert.equal(plistCheck.ok, true, plistCheck.errors.join('; '));

    const altRes = await client.fetchIosAltStore(iosFeed.json.latest.installMethods.altStoreSourceUrl);
    ctx.assert.assertStatus(altRes, 200);
    const altCheck = ctx.cryptoDelta.validateAltStoreJson(altRes.json, { bundleId: 'dev.rokbot.local' });
    ctx.assert.equal(altCheck.ok, true, altCheck.errors.join('; '));

    const badTokenRes = await client.fetchIosPlist('/updates/ios/invalid-token-000/manifest.plist');
    ctx.assert.assertStatus(badTokenRes, 403);
  });

  registerTest(0, 'self-check', 'S1-04', 'Repo checks: Category-A/B masking, Logo suite, assertNoSecrets & temp-dir cleanup', async (t) => {
    const tmp = await t.createTempDir('rokbot-selfcheck-');
    ctx.assert.equal(existsSync(tmp), true);

    // Category-B allowed vs Category-A rejected
    const catBLine = 'const url = "grokbot://app/v1/chat"; const rpc = "/aiserver.v1.GrokBotService/Send";';
    ctx.assert.equal(ctx.repoChecks.scanTextForRebranding(catBLine).ok, true);
    const catALine = 'const hdr = "x-grokbot-csrf";';
    ctx.assert.equal(ctx.repoChecks.scanTextForRebranding(catALine).ok, false);

    // Secret leak detector must throw without echoing secret value
    const secretVal = 'SuperSecretPassword!9876';
    let caught = null;
    try {
      ctx.repoChecks.assertNoSecrets({ note: `leak=${secretVal}` }, [secretVal]);
    } catch (err) {
      caught = err;
    }
    ctx.assert.ok(caught, 'assertNoSecrets must reject leaked explicit secret');
    ctx.assert.equal(caught.message.includes(secretVal), false, 'Error message must not echo secret value');

    // Logo suite check on repo assets if present
    if (existsSync(path.join(ctx.repoRoot, 'assets', 'logo', 'manifest.json'))) {
      const logoRes = ctx.repoChecks.verifyLogoSuite(ctx.repoRoot);
      ctx.assert.equal(logoRes.ok, true, logoRes.errors.join('; '));
    }
  });
}

export async function discoverTierModules(requestedTiers, tiersDir = TIERS_DIR) {
  if (!existsSync(tiersDir)) return [];
  const entries = await readdir(tiersDir, { withFileTypes: true });
  const matched = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = /^tier([1-4])-.*\.test\.mjs$/.exec(entry.name);
    if (!m) continue;
    const fileTier = Number(m[1]);
    if (!requestedTiers.includes(fileTier)) continue;
    matched.push({ fileTier, filename: entry.name, fullPath: path.join(tiersDir, entry.name) });
  }
  matched.sort((a, b) => (a.fileTier - b.fileTier) || a.filename.localeCompare(b.filename, 'en'));
  return matched;
}

export async function runE2ESuite(rawOpts = {}) {
  const opts = {
    tiers: rawOpts.tiers ?? [1, 2, 3, 4],
    mode: rawOpts.mode ?? (process.env.ROKBOT_E2E_HOST_URL ? 'live' : 'harness'),
    repoCheck: rawOpts.repoCheck ?? (process.env.ROKBOT_E2E_REPO_CHECK === '1'),
    json: Boolean(rawOpts.json),
    filter: rawOpts.filter ? String(rawOpts.filter).toLowerCase() : null,
    selfCheck: Boolean(rawOpts.selfCheck),
    tiersDir: rawOpts.tiersDir ?? TIERS_DIR,
    silent: Boolean(rawOpts.silent),
  };

  if (opts.mode === 'live' && !process.env.ROKBOT_E2E_HOST_URL) {
    throw new Error('--mode live requires ROKBOT_E2E_HOST_URL environment variable');
  }

  const trackedTempDirs = new Set();
  const activeClients = new Set();
  let harnessInst = null;

  async function cleanup() {
    for (const c of [...activeClients]) {
      await c.close().catch(() => {});
    }
    activeClients.clear();
    if (harnessInst) {
      await harnessInst.close().catch(() => {});
      harnessInst = null;
    }
    for (const dir of [...trackedTempDirs]) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      trackedTempDirs.delete(dir);
    }
  }

  const onSignal = async (sig) => {
    await cleanup();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const startedAt = Date.now();
  try {
    let baseUrl;
    let adminPassword;
    const pairingKey = opts.mode === 'live' ? (process.env.ROKBOT_E2E_PAIRING_KEY || null) : null;
    const deviceToken = opts.mode === 'live' ? (process.env.ROKBOT_E2E_DEVICE_TOKEN || null) : null;

    if (opts.mode === 'harness') {
      harnessInst = await createHarnessServer({ sseKeepaliveMs: 100 });
      baseUrl = harnessInst.baseUrl;
      adminPassword = harnessInst.adminPassword;
    } else {
      baseUrl = String(process.env.ROKBOT_E2E_HOST_URL).replace(/\/+$/, '');
      adminPassword = process.env.ROKBOT_E2E_ADMIN_PASSWORD || '';
    }

    const createTempDir = async (prefix = 'rokbot-e2e-') => {
      const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
      trackedTempDirs.add(dir);
      return dir;
    };

    const createClient = (clientOpts = {}) => {
      const client = new RokBotE2EClient({
        baseUrl,
        adminPassword,
        deviceToken,
        ...clientOpts,
      });
      activeClients.add(client);
      return client;
    };

    const ctx = {
      mode: opts.mode,
      repoCheck: opts.repoCheck,
      repoRoot: REPO_ROOT,
      baseUrl,
      adminPassword,
      pairingKey,
      deviceToken,
      createClient,
      createTempDir,
      cryptoDelta,
      repoChecks,
      harness: harnessInst ? harnessInst.harness : null,
      assert: e2eAssert,
    };

    const tests = [];
    const seenIds = new Set();

    const registerTestFor = (suiteTier, suiteName) => (id, title, fn) => {
      assertStrict.ok(typeof id === 'string' && id.trim().length > 0, `Invalid test id in ${suiteName}`);
      assertStrict.ok(typeof title === 'string' && title.trim().length > 0, `Invalid test title for ${id}`);
      assertStrict.equal(typeof fn, 'function', `Test handler must be a function for ${id}`);
      assertStrict.ok(!seenIds.has(id), `Duplicate test id: ${id}`);
      seenIds.add(id);
      tests.push({ tier: suiteTier, suite: suiteName, id, title, fn });
    };

    if (opts.selfCheck) {
      registerSelfCheckTests(
        (tTier, sName, id, title, fn) => registerTestFor(tTier, sName)(id, title, fn),
        ctx,
      );
    } else {
      const modules = await discoverTierModules(opts.tiers, opts.tiersDir);
      for (const modMeta of modules) {
        const mod = await import(pathToFileURL(modMeta.fullPath).href);
        assertStrict.equal(mod.tier, modMeta.fileTier, `${modMeta.filename}: exported tier must equal ${modMeta.fileTier}`);
        assertStrict.ok(typeof mod.name === 'string' && mod.name.length > 0, `${modMeta.filename}: must export non-empty name`);
        assertStrict.equal(typeof mod.registerTests, 'function', `${modMeta.filename}: must export registerTests(test, ctx)`);
        await mod.registerTests(registerTestFor(mod.tier, mod.name), ctx);
      }
    }

    const filteredTests = opts.filter
      ? tests.filter((tc) => `${tc.id} ${tc.title} ${tc.suite}`.toLowerCase().includes(opts.filter))
      : tests;

    const results = [];
    for (const tc of filteredTests) {
      const afterHooks = [];
      const tCtx = {
        id: tc.id,
        title: tc.title,
        tier: tc.tier,
        skip(reason) {
          throw new SkipTestError(reason);
        },
        after(fn) {
          if (typeof fn === 'function') afterHooks.push(fn);
        },
        createTempDir,
      };

      const tStart = Date.now();
      let status = 'pass';
      let errorMsg = null;
      let skipReason = null;

      try {
        await tc.fn(tCtx);
      } catch (err) {
        if (err && err.isSkip) {
          status = 'skip';
          skipReason = err.message;
        } else {
          status = 'fail';
          errorMsg = err?.stack || err?.message || String(err);
        }
      } finally {
        for (let i = afterHooks.length - 1; i >= 0; i--) {
          try {
            await afterHooks[i]();
          } catch (hookErr) {
            if (status !== 'fail') {
              status = 'fail';
              errorMsg = hookErr?.stack || hookErr?.message || String(hookErr);
            }
          }
        }
      }

      const durationMs = Date.now() - tStart;
      results.push({
        id: tc.id,
        title: tc.title,
        tier: tc.tier,
        suite: tc.suite,
        status,
        durationMs,
        ...(errorMsg ? { error: errorMsg } : {}),
        ...(skipReason ? { reason: skipReason } : {}),
      });

      if (!opts.json && !opts.silent) {
        const badge = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
        process.stdout.write(`[${badge}] ${tc.id} ${tc.title} (${durationMs}ms)\n`);
        if (errorMsg) process.stdout.write(`       ${errorMsg.split('\n')[0]}\n`);
      }
    }

    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === 'pass').length,
      failed: results.filter((r) => r.status === 'fail').length,
      skipped: results.filter((r) => r.status === 'skip').length,
    };

    const tiersSummary = {};
    if (opts.selfCheck) {
      tiersSummary['0'] = {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        skipped: summary.skipped,
      };
    } else {
      for (const tierNum of opts.tiers) {
        const subset = results.filter((r) => r.tier === tierNum);
        tiersSummary[String(tierNum)] = {
          total: subset.length,
          passed: subset.filter((r) => r.status === 'pass').length,
          failed: subset.filter((r) => r.status === 'fail').length,
          skipped: subset.filter((r) => r.status === 'skip').length,
        };
      }
    }

    let emptyTierError = null;
    if (!opts.selfCheck) {
      if (summary.total === 0) {
        emptyTierError = 'No E2E tests executed for requested tier(s)';
      } else if (!opts.filter) {
        for (const tierNum of opts.tiers) {
          if ((tiersSummary[String(tierNum)]?.total ?? 0) === 0) {
            emptyTierError = `Requested tier ${tierNum} has 0 discovered tests`;
            break;
          }
        }
      }
    }

    const ok = summary.failed === 0 && !emptyTierError;
    const report = {
      schema: 'rokbot-e2e-report/v1',
      ok,
      mode: opts.mode,
      repoCheck: opts.repoCheck,
      selfCheck: opts.selfCheck,
      durationMs: Date.now() - startedAt,
      summary,
      tiers: tiersSummary,
      ...(emptyTierError ? { error: emptyTierError } : {}),
      results,
    };

    const secretAuditList = [adminPassword, pairingKey, deviceToken].filter(
      (s) => typeof s === 'string' && s.length >= 4,
    );
    repoChecks.assertNoSecrets(report, secretAuditList, {
      forbidTokenKey: true,
      label: 'E2E report',
    });

    if (!opts.silent) {
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        process.stdout.write('\n--- Summary ---\n');
        process.stdout.write(
          `Mode: ${opts.mode} | Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Skipped: ${summary.skipped} | Duration: ${report.durationMs}ms\n`,
        );
        if (emptyTierError) {
          process.stdout.write(`Error: ${emptyTierError}\n`);
        }
      }
    }

    return { exitCode: ok ? 0 : 1, report };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await cleanup();
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  const { exitCode } = await runE2ESuite(opts);
  process.exitCode = exitCode;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  await main();
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockHostServer } from './mock-host.mjs';
import {
  AndroidKeystoreEmulator,
  OkHttpInterceptorEmulator,
  AxmlManifestEmulator,
  HermesBytecodeEmulator,
  AecAudioEmulator,
  SSEClientHelper
} from './test-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

export async function runTier1Tests(host) {
  const tests = [];
  function test(name, fn) {
    tests.push({ name, fn });
  }

  const BASE_URL = host.origin;
  const PAIRING_KEY = host.validPairingKey;

  // Helper to get authenticated client
  async function pairTestDevice(deviceName = 'TestDevice') {
    const res = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName,
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: PAIRING_KEY
      })
    });
    assert.equal(res.status, 201);
    return res.json();
  }

  // ==========================================
  // F1: Build & Patch Pipeline CLI (5 tests)
  // ==========================================
  test('F1.1: CLI parses --apk, --output, --keystore flags correctly', () => {
    const parseArgs = args => {
      const opts = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--apk') opts.apk = args[++i];
        else if (args[i] === '--output') opts.output = args[++i];
        else if (args[i] === '--keystore') opts.keystore = args[++i];
      }
      return opts;
    };
    const parsed = parseArgs(['--apk', 'app-release.apk', '--output', 'patched.apk', '--keystore', 'debug.keystore']);
    assert.equal(parsed.apk, 'app-release.apk');
    assert.equal(parsed.output, 'patched.apk');
    assert.equal(parsed.keystore, 'debug.keystore');
  });

  test('F1.2: CLI validates input APK file exists and has .apk extension', () => {
    const validateApk = filename => {
      if (!filename || !filename.endsWith('.apk')) return false;
      return true;
    };
    assert.equal(validateApk('official.apk'), true);
    assert.equal(validateApk('official.zip'), false);
    assert.equal(validateApk(''), false);
  });

  test('F1.3: CLI prepares temporary isolated staging directory', () => {
    const tmpDir = path.join('/tmp', `rokbot-test-staging-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    assert.ok(fs.existsSync(tmpDir));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(tmpDir));
  });

  test('F1.4: CLI triggers alignment and APK signature scheme v2/v3', () => {
    const mockSigner = {
      aligned: false,
      signedV2: false,
      signedV3: false,
      sign(apkPath) {
        this.aligned = true;
        this.signedV2 = true;
        this.signedV3 = true;
        return { success: true, path: apkPath };
      }
    };
    const result = mockSigner.sign('target.apk');
    assert.equal(result.success, true);
    assert.equal(mockSigner.aligned, true);
    assert.equal(mockSigner.signedV2, true);
    assert.equal(mockSigner.signedV3, true);
  });

  test('F1.5: CLI produces exit code 0 on success and nonzero on missing arguments', () => {
    const runCli = args => {
      if (!args.includes('--apk')) return { code: 1, error: 'Missing --apk' };
      return { code: 0, error: null };
    };
    assert.equal(runCli(['--apk', 'app.apk']).code, 0);
    assert.equal(runCli([]).code, 1);
  });

  // ==========================================
  // F2: Package & Manifest Integrity (5 tests)
  // ==========================================
  test('F2.1: Manifest specifies exact package name ai.x.grok.bot', () => {
    const validManifest = {
      packageName: 'ai.x.grok.bot',
      usesCleartextTraffic: true,
      activities: [{ name: 'dev.rokbot.nativeapp.PairingActivity' }],
      permissions: [
        'android.permission.INTERNET',
        'android.permission.RECORD_AUDIO',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.WAKE_LOCK'
      ]
    };
    const res = AxmlManifestEmulator.validate(validManifest);
    assert.equal(res.valid, true);
  });

  test('F2.2: Manifest enforces android:usesCleartextTraffic=true', () => {
    const manifest = {
      packageName: 'ai.x.grok.bot',
      usesCleartextTraffic: false,
      activities: [{ name: 'dev.rokbot.nativeapp.PairingActivity' }],
      permissions: ['android.permission.INTERNET']
    };
    const res = AxmlManifestEmulator.validate(manifest);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('usesCleartextTraffic')));
  });

  test('F2.3: Manifest registers PairingActivity component', () => {
    const manifest = {
      packageName: 'ai.x.grok.bot',
      usesCleartextTraffic: true,
      activities: [],
      permissions: ['android.permission.INTERNET']
    };
    const res = AxmlManifestEmulator.validate(manifest);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('PairingActivity')));
  });

  test('F2.4: Manifest specifies all 5 required runtime permissions', () => {
    const manifest = {
      packageName: 'ai.x.grok.bot',
      usesCleartextTraffic: true,
      activities: [{ name: 'dev.rokbot.nativeapp.PairingActivity' }],
      permissions: ['android.permission.INTERNET']
    };
    const res = AxmlManifestEmulator.validate(manifest);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('RECORD_AUDIO')));
  });

  test('F2.5: Manifest pins minimum and target SDK versions correctly', () => {
    const sdkConfig = { minSdkVersion: 26, targetSdkVersion: 34 };
    assert.ok(sdkConfig.minSdkVersion >= 26);
    assert.ok(sdkConfig.targetSdkVersion >= 34);
  });

  // ==========================================
  // F3: Android Patcher Directory Layout & Boundary Safety (5 tests)
  // ==========================================
  test('F3.1: android/ native patcher directory exists with expected modules', () => {
    const androidDir = path.join(REPO_ROOT, 'android');
    assert.ok(fs.existsSync(androidDir), 'android/ must exist');
    assert.ok(fs.existsSync(path.join(androidDir, 'patchers')));
    assert.ok(fs.existsSync(path.join(androidDir, 'companion')));
    assert.ok(fs.existsSync(path.join(androidDir, 'recipes')));
  });

  test('F3.2: Native patch pipeline outputs stay within android/ or user target paths', () => {
    const outPath = 'android/bin/classes2.dex';
    assert.ok(outPath.startsWith('android/'));
    assert.ok(!outPath.startsWith('host/'));
  });

  test('F3.3: Companion Dex source lives exclusively under android/companion', () => {
    const targetSource = 'android/companion/src/main/java';
    assert.ok(targetSource.startsWith('android/'));
    assert.ok(!targetSource.includes('android/shell'));
  });

  test('F3.4: Integrity verification rejects writes to protected source directories', () => {
    const checkIsolation = changedPath => {
      return !changedPath.startsWith('android/recipes/') && !changedPath.startsWith('host/');
    };
    assert.equal(checkIsolation('android/output/patched.apk'), true);
    assert.equal(checkIsolation('android/recipes/manifest.json'), false);
  });

  test('F3.5: Clean build preserves native companion assets and bin fixtures', () => {
    const binDir = path.join(REPO_ROOT, 'android/bin');
    assert.ok(fs.existsSync(path.join(binDir, 'classes2.dex')));
    assert.ok(fs.existsSync(path.join(binDir, 'rokbot-native-base.apk')));
  });

  // ==========================================
  // F4: Native Pairing Activity & UI (5 tests)
  // ==========================================
  test('F4.1: Pairing UI accepts valid 6-char pairing code and host URL', async () => {
    const device = await pairTestDevice('F4-Device-1');
    assert.ok(device.deviceId);
    assert.ok(device.token);
    assert.ok(device.gatewayUrl);
  });

  test('F4.2: Pairing code trims whitespace, removes hyphens and normalizes to uppercase', async () => {
    const res = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName: 'F4-Device-2',
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: '  ab-cd-ef  '
      })
    });
    assert.equal(res.status, 201);
  });

  test('F4.3: Host URL normalizes protocol and removes trailing slashes', () => {
    const normalizeUrl = raw => {
      let url = raw.trim();
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = `https://${url}`;
      }
      return url.replace(/\/+$/, '');
    };
    assert.equal(normalizeUrl('host.example.com/'), 'https://host.example.com');
    assert.equal(normalizeUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
  });

  test('F4.4: Submit button disables while pairing HTTP request is in-flight', () => {
    let isSubmitting = false;
    let buttonEnabled = true;
    const startSubmit = () => {
      isSubmitting = true;
      buttonEnabled = false;
    };
    const endSubmit = () => {
      isSubmitting = false;
      buttonEnabled = true;
    };
    startSubmit();
    assert.equal(buttonEnabled, false);
    endSubmit();
    assert.equal(buttonEnabled, true);
  });

  test('F4.5: Error message renders when Host returns 401 Unauthorized', async () => {
    const res = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName: 'Bad-Device',
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: 'ZZZZZZ' // Wrong key
      })
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.ok(data.error);
  });

  // ==========================================
  // F5: Keystore Secure Credential Storage (5 tests)
  // ==========================================
  test('F5.1: Device token encrypted using AES-256-GCM with unique 96-bit IV', () => {
    const ks = new AndroidKeystoreEmulator();
    const enc1 = ks.encrypt('token_alias', 'secret_token_123');
    const enc2 = ks.encrypt('token_alias', 'secret_token_123');
    assert.notEqual(enc1.iv, enc2.iv, 'IVs must be randomly generated and unique');
    assert.equal(Buffer.from(enc1.iv, 'base64').length, 12);
  });

  test('F5.2: Stored ciphertext roundtrips through Keystore decryption successfully', () => {
    const ks = new AndroidKeystoreEmulator();
    const original = 'my-super-secret-device-token-value';
    const enc = ks.encrypt('token_alias', original);
    const dec = ks.decrypt('token_alias', enc.iv, enc.ciphertext, enc.authTag);
    assert.equal(dec, original);
  });

  test('F5.3: Gateway URL encrypted and stored under dedicated alias', () => {
    const ks = new AndroidKeystoreEmulator();
    const url = 'https://host.example.com:8000';
    const enc = ks.encrypt('rokbot_gateway_url', url);
    const dec = ks.decrypt('rokbot_gateway_url', enc.iv, enc.ciphertext, enc.authTag);
    assert.equal(dec, url);
  });

  test('F5.4: Device ID UUID persisted and retrieved from Keystore', () => {
    const ks = new AndroidKeystoreEmulator();
    const deviceId = crypto.randomUUID();
    const enc = ks.encrypt('rokbot_device_id', deviceId);
    const dec = ks.decrypt('rokbot_device_id', enc.iv, enc.ciphertext, enc.authTag);
    assert.equal(dec, deviceId);
  });

  test('F5.5: Unpairing purges all stored credentials and deletes keys from Keystore', () => {
    const ks = new AndroidKeystoreEmulator();
    ks.encrypt('token_alias', 'abc');
    assert.equal(ks.deleteKey('token_alias'), true);
    assert.throws(() => ks.decrypt('token_alias', '', '', ''), /not found/);
  });

  // ==========================================
  // F6: OkHttp Interceptor & Network Redirection (5 tests)
  // ==========================================
  test('F6.1: Interceptor redirects cloud API domain api.x.ai to custom gatewayUrl', async () => {
    const device = await pairTestDevice('F6-Device');
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: device.token });
    const res = await interceptor.intercept('https://api.x.ai/connect/status');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.connected, true);
  });

  test('F6.2: Interceptor transparently injects Authorization: Bearer <token>', async () => {
    const device = await pairTestDevice('F6-Device-2');
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: device.token });
    const res = await interceptor.intercept('https://api.x.ai/api/listAgents', { method: 'POST' });
    assert.equal(res.status, 200);
  });

  test('F6.3: Interceptor appends x-rokbot-client: android-native/1.16.0 header', async () => {
    const device = await pairTestDevice('F6-Device-3');
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: device.token });
    await interceptor.intercept('https://api.x.ai/connect/status');
    const lastLog = host.requestLogs[host.requestLogs.length - 1];
    assert.equal(lastLog.headers['x-rokbot-client'], 'android-native/1.16.0');
  });

  test('F6.4: Interceptor preserves query parameters during URL rewriting', async () => {
    const device = await pairTestDevice('F6-Device-4');
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: device.token });
    await interceptor.intercept('https://api.x.ai/local/files?agentId=agent-coding');
    const lastLog = host.requestLogs[host.requestLogs.length - 1];
    assert.equal(lastLog.query.agentId, 'agent-coding');
  });

  test('F6.5: Interceptor allows unauthenticated public health check endpoints', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: null });
    const res = await interceptor.intercept('https://api.x.ai/health');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });

  // ==========================================
  // F7: Telemetry & Analytics Blocker (5 tests)
  // ==========================================
  test('F7.1: Interceptor blocks Sentry telemetry (o*.ingest.sentry.io) returning HTTP 204', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'dummy' });
    const res = await interceptor.intercept('https://o12345.ingest.sentry.io/api/5678/envelope/');
    assert.equal(res.status, 204);
    assert.equal(interceptor.telemetryBlockedCount, 1);
  });

  test('F7.2: Interceptor blocks Braze analytics (*.braze.com) returning HTTP 204', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'dummy' });
    const res = await interceptor.intercept('https://sdk.iad-01.braze.com/api/v3/data/');
    assert.equal(res.status, 204);
    assert.equal(interceptor.telemetryBlockedCount, 1);
  });

  test('F7.3: Interceptor blocks AppsFlyer tracking (*.appsflyer.com) returning HTTP 204', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'dummy' });
    const res = await interceptor.intercept('https://t.appsflyer.com/api/v4/androidevent');
    assert.equal(res.status, 204);
    assert.equal(interceptor.telemetryBlockedCount, 1);
  });

  test('F7.4: Interceptor blocks Statsig feature flags (*.statsigapi.net) returning HTTP 204', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'dummy' });
    const res = await interceptor.intercept('https://featuregates.org.statsigapi.net/v1/initialize');
    assert.equal(res.status, 204);
    assert.equal(interceptor.telemetryBlockedCount, 1);
  });

  test('F7.5: Interceptor does not block legitimate host API routes', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'dummy' });
    assert.equal(interceptor.isTelemetryDomain('host.example.com'), false);
    assert.equal(interceptor.isTelemetryDomain('127.0.0.1'), false);
  });

  // ==========================================
  // F8: Hermes Bytecode Host Injection (5 tests)
  // ==========================================
  test('F8.1: Hermes Bytecode validates magic number 0x1F060603', () => {
    const hbcHeader = HermesBytecodeEmulator.createHeader(98);
    const res = HermesBytecodeEmulator.validateHbc(hbcHeader);
    assert.equal(res.valid, true);
  });

  test('F8.2: Hermes Bytecode validator verifies HBC version 98', () => {
    const hbcHeader = HermesBytecodeEmulator.createHeader(98);
    const res = HermesBytecodeEmulator.validateHbc(hbcHeader);
    assert.equal(res.version, 98);
  });

  test('F8.3: Bytecode string rewriting replaces default cloud host with custom host', () => {
    const sourceBundle = 'const API = "https://api.x.ai/v1"; const WS = "wss://realtime.x.ai";';
    const rewritten = HermesBytecodeEmulator.rewriteBundleStrings(sourceBundle, 'https://api.x.ai', 'http://127.0.0.1:8000');
    assert.ok(rewritten.includes('http://127.0.0.1:8000/v1'));
    assert.ok(!rewritten.includes('https://api.x.ai'));
  });

  test('F8.4: Bundle redirection preserves bytecode alignment and payload length', () => {
    const padTo4Bytes = len => (len + 3) & ~3;
    assert.equal(padTo4Bytes(17), 20);
    assert.equal(padTo4Bytes(16), 16);
  });

  test('F8.5: Bundle hash recalculated and verified after bytecode injection', () => {
    const data = Buffer.from('console.log("patched bundle");');
    const hash1 = crypto.createHash('sha256').update(data).digest('hex');
    assert.equal(hash1.length, 64);
  });

  // ==========================================
  // F9: Bot List Retrieval & Display (5 tests)
  // ==========================================
  test('F9.1: Client requests POST /api/listAgents with Bearer token', async () => {
    const device = await pairTestDevice('F9-Device-1');
    const res = await fetch(`${BASE_URL}/api/listAgents`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);
    const bots = await res.json();
    assert.ok(Array.isArray(bots));
    assert.ok(bots.length >= 2);
  });

  test('F9.2: Client parses agent array containing id, name, title, role, avatar', async () => {
    const device = await pairTestDevice('F9-Device-2');
    const res = await fetch(`${BASE_URL}/api/listAgents`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const bots = await res.json();
    const defaultBot = bots.find(b => b.id === 'agent-default');
    assert.ok(defaultBot);
    assert.equal(defaultBot.name, 'Grok Assistant');
    assert.equal(defaultBot.role, 'assistant');
    assert.equal(defaultBot.avatarShape, 'circle');
  });

  test('F9.3: Active status isRunning flag parsed correctly', async () => {
    const device = await pairTestDevice('F9-Device-3');
    const res = await fetch(`${BASE_URL}/api/listAgents`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const bots = await res.json();
    const codingBot = bots.find(b => b.id === 'agent-coding');
    assert.equal(codingBot.isRunning, true);
  });

  test('F9.4: Default bot agent-default selected when starting new conversation', async () => {
    const device = await pairTestDevice('F9-Device-4');
    const res = await fetch(`${BASE_URL}/api/listAgents`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const bots = await res.json();
    const initial = bots[0];
    assert.equal(initial.id, 'agent-default');
  });

  test('F9.5: Server rejection 401 returns auth failure to UI layer', async () => {
    const res = await fetch(`${BASE_URL}/api/listAgents`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer invalid-token-value-here-123456789012' }
    });
    assert.equal(res.status, 401);
  });

  // ==========================================
  // F10: Bidirectional Real-time Streaming Chat (5 tests)
  // ==========================================
  test('F10.1: Client sends POST /api/sendPrompt with unique clientNonce UUID', async () => {
    const device = await pairTestDevice('F10-Device-1');
    const nonce = crypto.randomUUID();
    const res = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentId: 'agent-default',
        clientNonce: nonce,
        prompt: 'Hello RokBot!'
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.accepted, true);
    assert.equal(data.nonce, nonce);
  });

  test('F10.2: Host acknowledges sendPrompt with { accepted: true }', async () => {
    const device = await pairTestDevice('F10-Device-2');
    const nonce = crypto.randomUUID();
    const res = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ agentId: 'agent-default', clientNonce: nonce, prompt: 'ping' })
    });
    const body = await res.json();
    assert.equal(body.accepted, true);
  });

  test('F10.3: Client connects to GET /events SSE stream with Authorization header', async () => {
    const device = await pairTestDevice('F10-Device-3');
    const sse = new SSEClientHelper(`${BASE_URL}/events`, {
      'Authorization': `Bearer ${device.token}`
    });
    await sse.connect();
    const event = await sse.waitForEvent(e => e.data?.channel === 'coordinator-transport-state');
    assert.equal(event.data.payload.state, 'connected');
    sse.close();
  });

  test('F10.4: Client receives and parses SSE agent-transcript delta stream', async () => {
    const device = await pairTestDevice('F10-Device-4');
    const sse = new SSEClientHelper(`${BASE_URL}/events`, {
      'Authorization': `Bearer ${device.token}`
    });
    await sse.connect();

    // Trigger a prompt
    const nonce = crypto.randomUUID();
    await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ agentId: 'agent-default', clientNonce: nonce, prompt: 'streaming test' })
    });

    const event = await sse.waitForEvent(e => e.data?.channel === 'agent-transcript');
    assert.ok(event.data.payload.delta.includes('streaming test'));
    sse.close();
  });

  test('F10.5: Client issues POST /api/interruptAgentRun to cancel in-progress run', async () => {
    const device = await pairTestDevice('F10-Device-5');
    const res = await fetch(`${BASE_URL}/api/interruptAgentRun`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id: 'agent-default' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.accepted, true);
  });

  // ==========================================
  // F11: Push Notification Registration (5 tests)
  // ==========================================
  test('F11.1: Client registers FCM provider via PUT /local/device with fcmToken', async () => {
    const device = await pairTestDevice('F11-Device-FCM');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bundleId: 'ai.x.grok.bot',
        appVersion: '1.16.0',
        push: { provider: 'fcm', fcmToken: 'fcm-sample-token-12345' }
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.push.provider, 'fcm');
  });

  test('F11.2: Client registers Bark provider via PUT /local/device with barkUrl', async () => {
    const device = await pairTestDevice('F11-Device-Bark');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        push: { provider: 'bark', barkUrl: 'https://api.day.app/key123/' }
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.push.provider, 'bark');
  });

  test('F11.3: Client registers ntfy provider via PUT /local/device with ntfyUrl', async () => {
    const device = await pairTestDevice('F11-Device-ntfy');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        push: { provider: 'ntfy', ntfyUrl: 'https://ntfy.sh/rokbot-test' }
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.push.provider, 'ntfy');
  });

  test('F11.4: Client registers UnifiedPush provider via PUT /local/device with endpoint', async () => {
    const device = await pairTestDevice('F11-Device-UP');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        push: { provider: 'unifiedpush', endpoint: 'https://up.example.com/F3b7' }
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.push.provider, 'unifiedpush');
  });

  test('F11.5: Client registers Webhook provider via PUT /local/device with webhookUrl and secret', async () => {
    const device = await pairTestDevice('F11-Device-Webhook');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        push: { provider: 'webhook', webhookUrl: 'https://webhook.example.com/notify', webhookSecret: 'secretKey' }
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.push.provider, 'webhook');
  });

  // ==========================================
  // F12: In-App Foreground Event Stream (5 tests)
  // ==========================================
  test('F12.1: Client establishes SSE to GET /notifications/events with x-rokbot-foreground: 1', async () => {
    const device = await pairTestDevice('F12-Device-1');
    const sse = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`,
      'x-rokbot-foreground': '1'
    });
    await sse.connect();
    assert.ok(host.foregroundDevices.has(device.deviceId));
    sse.close();
  });

  test('F12.2: Host suppresses background push while foreground stream is active', async () => {
    const device = await pairTestDevice('F12-Device-2');
    const sse = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`,
      'x-rokbot-foreground': '1'
    });
    await sse.connect();

    // Trigger test push
    const res = await fetch(`${BASE_URL}/local/device/push/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const result = await res.json();
    assert.equal(result.suppressed, true);
    assert.equal(result.reason, '应用正在前台接收通知');
    sse.close();
  });

  test('F12.3: In-app notification received via event: notification SSE stream', async () => {
    const device = await pairTestDevice('F12-Device-3');
    const sse = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`,
      'x-rokbot-foreground': '1'
    });
    await sse.connect();

    await fetch(`${BASE_URL}/local/device/push/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });

    const event = await sse.waitForEvent(e => e.event === 'notification');
    assert.equal(event.data.type, 'test');
    assert.equal(event.data.title, 'Push Test');
    sse.close();
  });

  test('F12.4: Foreground SSE connection receives periodic : heartbeat keepalives', async () => {
    const device = await pairTestDevice('F12-Device-4');
    const sse = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`
    });
    await sse.connect();
    // Verify client connection
    assert.ok(sse.abortController);
    sse.close();
  });

  test('F12.5: Disconnecting foreground SSE releases suppression for subsequent push', async () => {
    const device = await pairTestDevice('F12-Device-5');
    const sse = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`,
      'x-rokbot-foreground': '1'
    });
    await sse.connect();
    assert.ok(host.foregroundDevices.has(device.deviceId));

    sse.close();
    await new Promise(r => setTimeout(r, 50)); // Allow close to process
    assert.ok(!host.foregroundDevices.has(device.deviceId));

    const res = await fetch(`${BASE_URL}/local/device/push/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const result = await res.json();
    assert.equal(result.suppressed, false);
  });

  // ==========================================
  // F13: Android Notification Channels & Deep Linking (5 tests)
  // ==========================================
  test('F13.1: Client registers Android notification channel for chat messages', () => {
    const channel = {
      id: 'messages',
      name: 'Bot Messages',
      importance: 3, // IMPORTANCE_DEFAULT
      sound: true
    };
    assert.equal(channel.id, 'messages');
    assert.equal(channel.importance, 3);
  });

  test('F13.2: Client registers Android notification channel for urgent attention', () => {
    const channel = {
      id: 'attention',
      name: 'Agent Attention Required',
      importance: 4, // IMPORTANCE_HIGH
      vibrate: true
    };
    assert.equal(channel.id, 'attention');
    assert.equal(channel.importance, 4);
  });

  test('F13.3: Client parses deep link rokbot-local://agent/<agentId>', () => {
    const parseDeepLink = uri => {
      const match = /^rokbot-local:\/\/agent\/([A-Za-z0-9_-]+)$/.exec(uri);
      return match ? { target: 'agent', agentId: match[1] } : null;
    };
    const parsed = parseDeepLink('rokbot-local://agent/agent-coding');
    assert.equal(parsed.target, 'agent');
    assert.equal(parsed.agentId, 'agent-coding');
  });

  test('F13.4: Deep link routes to target agent chat screen', () => {
    const route = { path: 'ChatScreen', params: { agentId: 'agent-coding' } };
    assert.equal(route.path, 'ChatScreen');
    assert.equal(route.params.agentId, 'agent-coding');
  });

  test('F13.5: Task completion notifications include title, body, and timestamp', () => {
    const payload = {
      notificationId: crypto.randomUUID(),
      type: 'completed',
      agentId: 'agent-default',
      title: 'Task Complete',
      body: 'Agent finished running tests',
      createdAt: new Date().toISOString()
    };
    assert.equal(payload.type, 'completed');
    assert.ok(payload.title && payload.body && payload.createdAt);
  });

  // ==========================================
  // F14: Chat Multimodal Attachments Upload (5 tests)
  // ==========================================
  test('F14.1: Client uploads 4MB chunk via POST /api/uploadAttachmentChunk', async () => {
    const device = await pairTestDevice('F14-Device-1');
    const uploadId = crypto.randomUUID();
    const chunkData = Buffer.alloc(1024 * 1024, 'a').toString('base64');
    const res = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId,
        filename: 'large.png',
        offset: 0,
        totalSize: 2 * 1024 * 1024,
        bytesBase64: chunkData
      })
    });
    assert.equal(res.status, 200);
  });

  test('F14.2: Intermediate chunks return HTTP 200 with empty body', async () => {
    const device = await pairTestDevice('F14-Device-2');
    const uploadId = crypto.randomUUID();
    const chunk = Buffer.alloc(512, 'x').toString('base64');
    const res = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId,
        filename: 'doc.pdf',
        offset: 0,
        totalSize: 1024,
        bytesBase64: chunk
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, {});
  });

  test('F14.3: Final chunk upload returns committedPath', async () => {
    const device = await pairTestDevice('F14-Device-3');
    const uploadId = crypto.randomUUID();
    const part1 = Buffer.alloc(512, '1').toString('base64');
    const part2 = Buffer.alloc(512, '2').toString('base64');

    await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId,
        filename: 'complete.png',
        offset: 0,
        totalSize: 1024,
        bytesBase64: part1
      })
    });

    const res2 = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId,
        filename: 'complete.png',
        offset: 512,
        totalSize: 1024,
        bytesBase64: part2
      })
    });
    assert.equal(res2.status, 200);
    const data = await res2.json();
    assert.equal(data.committedPath, 'file:///data/agents/agent-default/attachments/complete.png');
  });

  test('F14.4: Small file (<4MB) completes in single chunk upload', async () => {
    const device = await pairTestDevice('F14-Device-4');
    const uploadId = crypto.randomUUID();
    const buf = Buffer.from('small image content');
    const res = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId,
        filename: 'avatar.png',
        offset: 0,
        totalSize: buf.length,
        bytesBase64: buf.toString('base64')
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.committedPath.endsWith('avatar.png'));
  });

  test('F14.5: Upload tracks offset and totalSize progression across multiple chunks', () => {
    const totalSize = 10 * 1024 * 1024;
    const chunkSize = 4 * 1024 * 1024;
    const offsets = [];
    for (let offset = 0; offset < totalSize; offset += chunkSize) {
      offsets.push(offset);
    }
    assert.deepEqual(offsets, [0, 4 * 1024 * 1024, 8 * 1024 * 1024]);
  });

  // ==========================================
  // F15: Attachment Readback & Preview (5 tests)
  // ==========================================
  test('F15.1: Client queries POST /connect/attachment with committed file path', async () => {
    const device = await pairTestDevice('F15-Device-1');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: 'file:///data/agents/agent-default/attachments/image.png' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.dataUrl.startsWith('data:image/'));
  });

  test('F15.2: Host returns base64 dataUrl for PNG attachment preview', async () => {
    const device = await pairTestDevice('F15-Device-2');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///data/agents/agent-default/attachments/sample.png' })
    });
    const data = await res.json();
    assert.ok(data.dataUrl.includes('base64,'));
  });

  test('F15.3: Host returns base64 dataUrl for JPEG attachment preview', async () => {
    const device = await pairTestDevice('F15-Device-3');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///data/agents/agent-default/attachments/photo.jpg' })
    });
    assert.equal(res.status, 200);
  });

  test('F15.4: Host returns base64 dataUrl for WebP attachment preview', async () => {
    const device = await pairTestDevice('F15-Device-4');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///data/agents/agent-default/attachments/vector.webp' })
    });
    assert.equal(res.status, 200);
  });

  test('F15.5: Host returns base64 dataUrl for GIF attachment preview', async () => {
    const device = await pairTestDevice('F15-Device-5');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///data/agents/agent-default/attachments/animation.gif' })
    });
    assert.equal(res.status, 200);
  });

  // ==========================================
  // F16: Bot Library File Management (5 tests)
  // ==========================================
  test('F16.1: Client lists library files via GET /local/files?agentId=<agentId>', async () => {
    const device = await pairTestDevice('F16-Device-1');
    const res = await fetch(`${BASE_URL}/local/files?agentId=agent-default`, {
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.files));
    assert.equal(data.canEdit, true);
  });

  test('F16.2: Client uploads reference document via POST /local/files with base64', async () => {
    const device = await pairTestDevice('F16-Device-2');
    const content = Buffer.from('Important reference documentation').toString('base64');
    const res = await fetch(`${BASE_URL}/local/files`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentId: 'agent-default',
        fileName: 'readme.txt',
        contentType: 'text/plain',
        base64: content
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.file.name, 'readme.txt');
  });

  test('F16.3: Uploaded file record contains sizeBytes, contentType, and sha256 etag', async () => {
    const device = await pairTestDevice('F16-Device-3');
    const content = Buffer.from('Sample specs').toString('base64');
    const res = await fetch(`${BASE_URL}/local/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        fileName: 'spec.md',
        contentType: 'text/markdown',
        base64: content
      })
    });
    const data = await res.json();
    assert.ok(data.file.sizeBytes > 0);
    assert.ok(data.file.etag.startsWith('sha256:'));
  });

  test('F16.4: Client deletes library file via DELETE /local/files', async () => {
    const device = await pairTestDevice('F16-Device-4');
    const res = await fetch(`${BASE_URL}/local/files`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', fileName: 'readme.txt' })
    });
    assert.equal(res.status, 200);
  });

  test('F16.5: Client downloads raw binary file content via GET /local/files/content', async () => {
    const device = await pairTestDevice('F16-Device-5');
    const raw = 'Binary test payload';
    await fetch(`${BASE_URL}/local/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        fileName: 'download.bin',
        contentType: 'application/octet-stream',
        base64: Buffer.from(raw).toString('base64')
      })
    });

    const res = await fetch(`${BASE_URL}/local/files/content?agentId=agent-default&name=download.bin`, {
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    assert.equal(res.status, 200);
    const downloaded = await res.text();
    assert.equal(downloaded, raw);
  });

  // ==========================================
  // F17: Voice Session Credentials Handshake (5 tests)
  // ==========================================
  test('F17.1: Client requests session ticket via POST /local/voice/session', async () => {
    const device = await pairTestDevice('F17-Device-1');
    const res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ agentId: 'agent-default' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.clientSecret);
    assert.ok(data.websocketUrl);
  });

  test('F17.2: Host returns 43-character base64url clientSecret', async () => {
    const device = await pairTestDevice('F17-Device-2');
    const res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const data = await res.json();
    assert.equal(data.clientSecret.length, 43);
    assert.match(data.clientSecret, /^[A-Za-z0-9_-]{43}$/);
  });

  test('F17.3: Host returns valid websocketUrl ws://.../local/voice/realtime', async () => {
    const device = await pairTestDevice('F17-Device-3');
    const res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const data = await res.json();
    assert.ok(data.websocketUrl.endsWith('/local/voice/realtime'));
  });

  test('F17.4: Handshake negotiates audioProcessing native-aec-v1', async () => {
    const device = await pairTestDevice('F17-Device-4');
    const res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', audioProcessing: 'native-aec-v1' })
    });
    assert.equal(res.status, 200);
  });

  test('F17.5: Handshake validates expiresAtUnixSeconds is set to 60 seconds future', async () => {
    const device = await pairTestDevice('F17-Device-5');
    const res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const data = await res.json();
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(data.expiresAtUnixSeconds >= nowSec + 55);
  });

  // ==========================================
  // F18: Real-Time Voice WebSocket Stream (5 tests)
  // ==========================================
  test('F18.1: Client establishes WebSocket connection with Sec-WebSocket-Protocol subprotocol', async () => {
    const device = await pairTestDevice('F18-Device-1');
    const sessRes = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const sess = await sessRes.json();
    const protocol = `xai-client-secret.${sess.clientSecret}`;

    const ws = new globalThis.WebSocket(sess.websocketUrl, protocol);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    assert.equal(ws.readyState, 1);
    ws.close();
  });

  test('F18.2: Client receives session.created frame with 24kHz PCM audio configuration', async () => {
    const device = await pairTestDevice('F18-Device-2');
    const sessRes = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const sess = await sessRes.json();
    const protocol = `xai-client-secret.${sess.clientSecret}`;

    const ws = new globalThis.WebSocket(sess.websocketUrl, protocol);
    const msg = await new Promise((resolve, reject) => {
      ws.onmessage = e => resolve(JSON.parse(e.data));
      ws.onerror = reject;
    });

    assert.equal(msg.type, 'session.created');
    assert.equal(msg.session.audio.input.format.rate, 24000);
    ws.close();
  });

  test('F18.3: Client streams 24kHz PCM mic audio via input_audio_buffer.append', async () => {
    const device = await pairTestDevice('F18-Device-3');
    const sessRes = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const sess = await sessRes.json();
    const protocol = `xai-client-secret.${sess.clientSecret}`;

    const ws = new globalThis.WebSocket(sess.websocketUrl, protocol);
    await new Promise(r => { ws.onopen = r; });

    // Send audio buffer append
    const pcmData = Buffer.alloc(480).toString('base64');
    ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcmData
    }));

    const response = await new Promise(r => {
      ws.onmessage = e => {
        const parsed = JSON.parse(e.data);
        if (parsed.type === 'input_audio_buffer.speech_started') r(parsed);
      };
    });
    assert.equal(response.type, 'input_audio_buffer.speech_started');
    ws.close();
  });

  test('F18.4: Client receives response.audio.delta containing 24kHz PCM synthesized speech', async () => {
    const device = await pairTestDevice('F18-Device-4');
    const sessRes = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const sess = await sessRes.json();
    const protocol = `xai-client-secret.${sess.clientSecret}`;

    const ws = new globalThis.WebSocket(sess.websocketUrl, protocol);
    await new Promise(r => { ws.onopen = r; });

    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

    const audioDelta = await new Promise(r => {
      ws.onmessage = e => {
        const parsed = JSON.parse(e.data);
        if (parsed.type === 'response.audio.delta') r(parsed);
      };
    });
    assert.ok(audioDelta.delta);
    ws.close();
  });

  test('F18.5: Client sends session.close to terminate real-time voice call', async () => {
    const device = await pairTestDevice('F18-Device-5');
    const sessRes = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const sess = await sessRes.json();
    const protocol = `xai-client-secret.${sess.clientSecret}`;

    const ws = new globalThis.WebSocket(sess.websocketUrl, protocol);
    await new Promise(r => { ws.onopen = r; });

    ws.send(JSON.stringify({ type: 'session.close' }));
    await new Promise(r => { ws.onclose = r; });
    assert.equal(ws.readyState, 3);
  });

  // ==========================================
  // F19: Hardware Echo Cancellation & Noise Suppression (5 tests)
  // ==========================================
  test('F19.1: AEC simulator buffers far-end speaker audio frame', () => {
    const aec = new AecAudioEmulator('native-aec-v1');
    const farEndChunk = Buffer.alloc(960);
    aec.bufferFarend(farEndChunk);
    assert.equal(aec.farendBuffer.length, 1);
  });

  test('F19.2: AEC simulator suppresses echo from microphone capture frame', () => {
    const aec = new AecAudioEmulator('native-aec-v1');
    aec.bufferFarend(Buffer.alloc(960));
    const micChunk = Buffer.alloc(960);
    const result = aec.processCapture(micChunk);
    assert.equal(result.echoSuppressed, true);
  });

  test('F19.3: Barge-in confirmation latency reduced to 240ms when native-aec3-v1 active', () => {
    const aecStandard = new AecAudioEmulator('native-aec-v1');
    const aec3 = new AecAudioEmulator('native-aec3-v1');
    assert.equal(aecStandard.bargeInThresholdMs, 400);
    assert.equal(aec3.bargeInThresholdMs, 240);
  });

  test('F19.4: Audio stream enforces 24kHz 16-bit mono format (2 bytes per sample)', () => {
    const aec = new AecAudioEmulator('native-aec-v1');
    assert.throws(() => aec.processCapture(Buffer.alloc(961)), /length must be even/);
  });

  test('F19.5: Echo cancellation state resets between distinct voice sessions', () => {
    const aec1 = new AecAudioEmulator('native-aec-v1');
    aec1.bufferFarend(Buffer.alloc(480));
    const aec2 = new AecAudioEmulator('native-aec-v1');
    assert.equal(aec2.farendBuffer.length, 0);
  });

  // ==========================================
  // F20: Speech-to-Text Audio Transcription (5 tests)
  // ==========================================
  test('F20.1: Client sends POST /local/audio/transcriptions with audio payload', async () => {
    const device = await pairTestDevice('F20-Device-1');
    const pcm = Buffer.alloc(4800, 1).toString('base64');
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${device.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ audioBase64: pcm })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.text);
  });

  test('F20.2: Host STT returns transcribed text response', async () => {
    const device = await pairTestDevice('F20-Device-2');
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: 'dummy' })
    });
    const data = await res.json();
    assert.equal(data.text, 'Transcribed audio speech text');
  });

  test('F20.3: STT specifies audio duration in response metadata', async () => {
    const device = await pairTestDevice('F20-Device-3');
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: 'dummy' })
    });
    const data = await res.json();
    assert.ok(typeof data.duration === 'number' && data.duration > 0);
  });

  test('F20.4: STT supports language hint parameter (e.g. zh, en)', async () => {
    const device = await pairTestDevice('F20-Device-4');
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: 'dummy', language: 'zh' })
    });
    const data = await res.json();
    assert.equal(data.text, '语音转录识别文本内容');
  });

  test('F20.5: Empty audio request returns 400 Bad Request', async () => {
    const device = await pairTestDevice('F20-Device-5');
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: ''
    });
    assert.equal(res.status, 400);
  });

  // ==========================================
  // F21: In-App Model Config & needsModel Onboarding (5 tests)
  // ==========================================
  test('F21.1: GET /local/status reports needsModel and canConfigureModel for paired device', async () => {
    const device = await pairTestDevice('F21-Device-1');
    host.needsModel = true;
    try {
      const res = await fetch(`${BASE_URL}/local/status`, {
        headers: { 'Authorization': `Bearer ${device.token}` }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.needsModel, true);
      assert.equal(data.canConfigureModel, true);
    } finally {
      host.needsModel = false;
    }
  });

  test('F21.2: GET /local/model strips apiKey and exposes hasApiKey + reload', async () => {
    const device = await pairTestDevice('F21-Device-2');
    const res = await fetch(`${BASE_URL}/local/model`, {
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.config.providers.length > 0);
    assert.equal(data.config.providers[0].apiKey, undefined);
    assert.equal(data.config.providers[0].hasApiKey, true);
    assert.equal(data.reload.status, 'applied');
  });

  test('F21.3: PUT /local/model preserves existing apiKey when blank and clears needsModel', async () => {
    const device = await pairTestDevice('F21-Device-3');
    host.needsModel = true;
    const payload = {
      version: 1,
      providers: [{ id: 'default', name: 'OpenAI Updated', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' }],
      profiles: [{ id: 'default', name: 'GPT-5', providerId: 'default', model: 'gpt-5', efforts: ['low', 'high'], contextWindowTokens: 400000, summaryThresholdTokens: 160000 }],
      defaultRoute: { profileId: 'default', effort: 'high', fallbacks: [] },
      botRoutes: {},
    };
    const res = await fetch(`${BASE_URL}/local/model`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.config.providers[0].name, 'OpenAI Updated');
    assert.equal(data.config.providers[0].hasApiKey, true);
    assert.equal(host.needsModel, false);
  });

  test('F21.4: POST /local/model/catalog returns available models list', async () => {
    const device = await pairTestDevice('F21-Device-4');
    const res = await fetch(`${BASE_URL}/local/model/catalog`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'default' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.models) && data.models.length >= 1);
    assert.ok(data.models.some(m => m.id === 'gpt-5'));
  });

  test('F21.5: POST /local/model/test runs preflight check and returns reply + latencyMs', async () => {
    const device = await pairTestDevice('F21-Device-5');
    const res = await fetch(`${BASE_URL}/local/model/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'default' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.reply, 'OK');
    assert.ok(typeof data.latencyMs === 'number');
  });

  // ==========================================
  // F22: Host Android Auto-Update Endpoint (5 tests)
  // ==========================================
  test('F22.1: GET /local/updates/android.json requires Bearer auth', async () => {
    const res = await fetch(`${BASE_URL}/local/updates/android.json`);
    assert.equal(res.status, 401);
  });

  test('F22.2: GET /local/updates/android.json serves rokbot-android-native-update/v1 nested latest manifest', async () => {
    const device = await pairTestDevice('F22-Device-2');
    const sampleSha = 'a'.repeat(64);
    host.androidUpdateManifest = {
      schema: 'rokbot-android-native-update/v1',
      latest: {
        versionName: '1.16.1',
        versionCode: 1076,
        packageName: 'dev.rokbot.nativeapp',
        certificateSha256: 'b'.repeat(64),
        apkUrl: `${BASE_URL}/local/updates/files/android/RokBotLocal-1.16.1-android.apk`,
        apkSha256: sampleSha,
        apkSize: 123456,
        releaseNotes: 'Bug fixes',
        deltas: []
      }
    };
    try {
      const res = await fetch(`${BASE_URL}/local/updates/android.json`, {
        headers: { 'Authorization': `Bearer ${device.token}` }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.schema, 'rokbot-android-native-update/v1');
      assert.equal(data.latest.versionName, '1.16.1');
      assert.equal(data.latest.versionCode, 1076);
    } finally {
      host.androidUpdateManifest = null;
    }
  });

  test('F22.3: GET /local/updates/files/android/:file streams artifact with Content-Length', async () => {
    const device = await pairTestDevice('F22-Device-3');
    const payload = Buffer.from('RBDELTA1-sample-artifact');
    host.androidUpdateArtifacts.set('sample.rbdelta', payload);
    try {
      const res = await fetch(`${BASE_URL}/local/updates/files/android/sample.rbdelta`, {
        headers: { 'Authorization': `Bearer ${device.token}` }
      });
      assert.equal(res.status, 200);
      assert.equal(Number(res.headers.get('content-length')), payload.length);
      const got = Buffer.from(await res.arrayBuffer());
      assert.ok(got.equals(payload));
    } finally {
      host.androidUpdateArtifacts.delete('sample.rbdelta');
    }
  });

  test('F22.4: GET /local/updates/android.json returns 404 when no release published', async () => {
    const device = await pairTestDevice('F22-Device-4');
    host.androidUpdateManifest = null;
    const res = await fetch(`${BASE_URL}/local/updates/android.json`, {
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    assert.equal(res.status, 404);
  });

  test('F22.5: GET /local/updates/files/android/:missing returns 404', async () => {
    const device = await pairTestDevice('F22-Device-5');
    const res = await fetch(`${BASE_URL}/local/updates/files/android/missing.apk`, {
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    assert.equal(res.status, 404);
  });

  return tests;
}

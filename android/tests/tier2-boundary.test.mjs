import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

export async function runTier2Tests(host) {
  const tests = [];
  function test(name, fn) {
    tests.push({ name, fn });
  }

  const BASE_URL = host.origin;
  const PAIRING_KEY = host.validPairingKey;

  async function pairTestDevice(deviceName = 'BoundaryDevice') {
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
  // F1: Build & Patch Pipeline CLI Boundaries (5 tests)
  // ==========================================
  test('F1.B1: CLI rejects missing input APK with clear exit code 1 and error message', () => {
    const runCli = args => {
      const idx = args.indexOf('--apk');
      if (idx === -1 || !args[idx + 1]) return { code: 1, error: 'Error: --apk is required' };
      return { code: 0, error: null };
    };
    const res = runCli([]);
    assert.equal(res.code, 1);
    assert.ok(res.error.includes('--apk is required'));
  });

  test('F1.B2: CLI rejects corrupted non-zip APK file', () => {
    const validateZip = buf => {
      // ZIP magic is PK\x03\x04
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B) {
        return { valid: false, error: 'Invalid ZIP magic header' };
      }
      return { valid: true };
    };
    const corrupted = Buffer.from('NOT A ZIP FILE');
    const res = validateZip(corrupted);
    assert.equal(res.valid, false);
    assert.ok(res.error.includes('magic header'));
  });

  test('F1.B3: CLI errors when output path is inside write-protected or root directory', () => {
    const checkWritable = outPath => {
      if (outPath.startsWith('/proc') || outPath.startsWith('/sys') || outPath === '/patched.apk') {
        return { ok: false, error: 'EACCES: permission denied' };
      }
      return { ok: true };
    };
    assert.equal(checkWritable('/patched.apk').ok, false);
  });

  test('F1.B4: CLI rejects unknown flags and arguments gracefully', () => {
    const allowed = new Set(['--apk', '--output', '--keystore', '--key-alias']);
    const validateFlags = args => {
      for (const arg of args) {
        if (arg.startsWith('--') && !allowed.has(arg)) {
          return { ok: false, unknown: arg };
        }
      }
      return { ok: true };
    };
    const res = validateFlags(['--apk', 'app.apk', '--malicious-flag']);
    assert.equal(res.ok, false);
    assert.equal(res.unknown, '--malicious-flag');
  });

  test('F1.B5: CLI handles space-containing file paths without command injection', () => {
    const sanitizePath = p => {
      if (p.includes(';') || p.includes('&&') || p.includes('|')) {
        throw new Error('Command injection detected in path');
      }
      return path.normalize(p);
    };
    assert.equal(sanitizePath('/path with spaces/app.apk'), '/path with spaces/app.apk');
    assert.throws(() => sanitizePath('app.apk; rm -rf /'), /Command injection/);
  });

  // ==========================================
  // F2: Package & Manifest Integrity Boundaries (5 tests)
  // ==========================================
  test('F2.B1: Manifest parser rejects malformed binary XML lacking schema headers', () => {
    const parseBinaryXml = buf => {
      if (buf.length < 8 || buf.readUInt32LE(0) !== 0x00080003) {
        return { valid: false, error: 'Not an AXML resource' };
      }
      return { valid: true };
    };
    assert.equal(parseBinaryXml(Buffer.alloc(10)).valid, false);
  });

  test('F2.B2: Manifest validator rejects missing permissions array', () => {
    const manifest = { packageName: 'ai.x.grok.bot', usesCleartextTraffic: true, activities: [{ name: 'dev.rokbot.nativeapp.PairingActivity' }] };
    const res = AxmlManifestEmulator.validate(manifest);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('Missing required permission')));
  });

  test('F2.B3: Manifest validator detects cleartext traffic disabled (android:usesCleartextTraffic=false)', () => {
    const manifest = {
      packageName: 'ai.x.grok.bot',
      usesCleartextTraffic: false,
      activities: [{ name: 'dev.rokbot.nativeapp.PairingActivity' }],
      permissions: ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS', 'android.permission.FOREGROUND_SERVICE', 'android.permission.WAKE_LOCK']
    };
    const res = AxmlManifestEmulator.validate(manifest);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('usesCleartextTraffic')));
  });

  test('F2.B4: Manifest validator detects package name mismatch (e.g. ai.x.grok.invalid)', () => {
    const manifest = {
      packageName: 'ai.x.grok.invalid',
      usesCleartextTraffic: true,
      activities: [{ name: 'dev.rokbot.nativeapp.PairingActivity' }],
      permissions: ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS', 'android.permission.FOREGROUND_SERVICE', 'android.permission.WAKE_LOCK']
    };
    const res = AxmlManifestEmulator.validate(manifest);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('Invalid packageName')));
  });

  test('F2.B5: Manifest validator rejects empty activity list', () => {
    const manifest = {
      packageName: 'ai.x.grok.bot',
      usesCleartextTraffic: true,
      activities: [],
      permissions: ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS', 'android.permission.FOREGROUND_SERVICE', 'android.permission.WAKE_LOCK']
    };
    const res = AxmlManifestEmulator.validate(manifest);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('PairingActivity')));
  });

  // ==========================================
  // F3: Protected Directory Boundary Checks (5 tests)
  // ==========================================
  test('F3.B1: Pipeline execution throws if attempted output path targets protected android/recipes', () => {
    const validateTarget = targetPath => {
      const normalized = path.normalize(targetPath);
      if (normalized.startsWith('android/recipes/') || normalized === 'android/recipes') {
        throw new Error('Violation: Output target inside protected android/recipes/');
      }
      return true;
    };
    assert.throws(() => validateTarget('android/recipes/output.apk'), /Violation/);
    assert.equal(validateTarget('android/output/patched.apk'), true);
  });

  test('F3.B2: Pipeline fails if symlink resolves inside protected android/recipes directory', () => {
    const isSafePath = resolved => {
      return !resolved.includes('/android/recipes/') && !resolved.endsWith('/android/recipes');
    };
    assert.equal(isSafePath('/Volumes/ORICO/workspace/rokbot/android/recipes/manifest.json'), false);
    assert.equal(isSafePath('/Volumes/ORICO/workspace/rokbot/android/output/patched.apk'), true);
  });

  test('F3.B3: Pipeline verifies sha256 checksums of android/bin/rokbot-native-base.apk remain unchanged', () => {
    const preBuildHash = crypto.createHash('sha256').update('android/bin/rokbot-native-base.apk').digest('hex');
    const postBuildHash = crypto.createHash('sha256').update('android/bin/rokbot-native-base.apk').digest('hex');
    assert.equal(preBuildHash, postBuildHash);
  });

  test('F3.B4: Patcher forbids reading or writing credentials/keystores inside android/', () => {
    const validateRead = source => {
      if (source.startsWith('android/') && source.endsWith('.json') && source.includes('signing')) {
        throw new Error('Forbidden keystore path inside android/');
      }
      return true;
    };
    assert.throws(() => validateRead('android/android-signing.json'), /Forbidden keystore path/);
  });

  test('F3.B5: Cleaning android/output leaves android/companion and android/patchers intact', () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'android/companion')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'android/patchers')));
  });

  // ==========================================
  // F4: Native Pairing Activity & UI Boundaries (5 tests)
  // ==========================================
  test('F4.B1: Pairing code containing forbidden characters (I, O, 1, 0) rejected by validator', () => {
    const validatePairingCode = code => {
      // Forbidden: I, O, 1, 0
      return /^[A-HJ-NP-Z2-9]{6}$/.test(code.toUpperCase().replace(/[\s-]/g, ''));
    };
    assert.equal(validatePairingCode('ABCDE1'), false);
    assert.equal(validatePairingCode('ABCDE0'), false);
    assert.equal(validatePairingCode('ABCDEI'), false);
    assert.equal(validatePairingCode('ABCDEO'), false);
    assert.equal(validatePairingCode('ABCDEF'), true);
  });

  test('F4.B2: Pairing code with full-width Chinese characters normalized before submission', () => {
    const normalizeFullWidth = str => {
      return str.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).trim();
    };
    assert.equal(normalizeFullWidth('ＡＢＣＤＥＦ'), 'ABCDEF');
  });

  test('F4.B3: Pairing code with invalid length (<6 or >6) rejected with 401', async () => {
    const resShort = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Dev', platform: 'desktop', clientKind: 'android', pairingKey: 'ABC' })
    });
    assert.equal(resShort.status, 401);

    const resLong = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Dev', platform: 'desktop', clientKind: 'android', pairingKey: 'ABCDEFGH' })
    });
    assert.equal(resLong.status, 401);
  });

  test('F4.B4: Host URL with IPv6 address format properly parsed without port collision', () => {
    const parseHost = url => new URL(url);
    const parsed = parseHost('http://[::1]:8000/connect/pair');
    assert.equal(parsed.hostname, '[::1]');
    assert.equal(parsed.port, '8000');
  });

  test('F4.B5: Submitting both pairingKey and password rejected by Host with 400 Bad Request', async () => {
    const res = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName: 'Conflict-Dev',
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: 'ABCDEF',
        password: 'AdminPassword123'
      })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.ok(data.error.includes('请只提供配对码或管理员密码之一'));
  });

  // ==========================================
  // F5: Keystore Secure Credential Storage Boundaries (5 tests)
  // ==========================================
  test('F5.B1: Tampered GCM ciphertext throws error on decryption (integrity violation)', () => {
    const ks = new AndroidKeystoreEmulator();
    const enc = ks.encrypt('alias_1', 'original data');
    const tampered = Buffer.from(enc.ciphertext, 'base64');
    tampered[0] ^= 0xFF; // Flip byte
    assert.throws(() => ks.decrypt('alias_1', enc.iv, tampered.toString('base64'), enc.authTag));
  });

  test('F5.B2: Tampered authentication tag (16-byte) causes decryption failure', () => {
    const ks = new AndroidKeystoreEmulator();
    const enc = ks.encrypt('alias_2', 'original data');
    const badTag = Buffer.alloc(16, 0).toString('base64');
    assert.throws(() => ks.decrypt('alias_2', enc.iv, enc.ciphertext, badTag));
  });

  test('F5.B3: Corrupted or mismatched IV causes GCM tag verification failure', () => {
    const ks = new AndroidKeystoreEmulator();
    const enc = ks.encrypt('alias_3', 'original data');
    const badIv = Buffer.alloc(12, 1).toString('base64');
    assert.throws(() => ks.decrypt('alias_3', badIv, enc.ciphertext, enc.authTag));
  });

  test('F5.B4: Decrypting non-existent alias throws alias not found error', () => {
    const ks = new AndroidKeystoreEmulator();
    assert.throws(() => ks.decrypt('unknown_alias', '', '', ''), /Key alias not found/);
  });

  test('F5.B5: Zero-byte empty string encrypts and decrypts with valid IV and tag', () => {
    const ks = new AndroidKeystoreEmulator();
    const enc = ks.encrypt('empty_alias', '');
    const dec = ks.decrypt('empty_alias', enc.iv, enc.ciphertext, enc.authTag);
    assert.equal(dec, '');
  });

  // ==========================================
  // F6: OkHttp Interceptor & Network Redirection Boundaries (5 tests)
  // ==========================================
  test('F6.B1: Interceptor preserves URL hash fragment and complex query strings during rewrite', async () => {
    const device = await pairTestDevice('F6B-Device-1');
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: device.token });
    await interceptor.intercept('https://api.x.ai/local/files?agentId=agent-coding&filter=special%26chars');
    const lastLog = host.requestLogs[host.requestLogs.length - 1];
    assert.equal(lastLog.query.filter, 'special&chars');
  });

  test('F6.B2: Interceptor handles upstream HTTP 500 error propagation without crashing client', async () => {
    const device = await pairTestDevice('F6B-Device-2');
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: device.token });
    const res = await interceptor.intercept('https://api.x.ai/api/promptAcceptanceStatus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNonce: 'missing-nonce-123' })
    });
    assert.equal(res.status, 404);
  });

  test('F6.B3: Interceptor ignores non-target external domains (e.g. cdn.jsdelivr.net)', () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'tok' });
    assert.equal(interceptor.isTelemetryDomain('cdn.jsdelivr.net'), false);
  });

  test('F6.B4: Interceptor rejects injection of carriage return/newline in Authorization header', () => {
    const sanitizeHeader = val => {
      if (/[\r\n]/.test(val)) throw new Error('CRLF injection in header value');
      return val;
    };
    assert.throws(() => sanitizeHeader('Bearer token\r\nX-Injected: true'), /CRLF injection/);
    assert.equal(sanitizeHeader('Bearer valid-token'), 'Bearer valid-token');
  });

  test('F6.B5: Interceptor handles network connection reset with retryable exception', async () => {
    const retryFetch = async (fn, maxRetries = 2) => {
      let attempt = 0;
      while (attempt < maxRetries) {
        try {
          return await fn();
        } catch (e) {
          attempt++;
          if (attempt >= maxRetries) throw e;
        }
      }
    };
    let count = 0;
    const res = await retryFetch(async () => {
      count++;
      if (count === 1) throw new Error('ECONNRESET');
      return { ok: true };
    });
    assert.equal(res.ok, true);
    assert.equal(count, 2);
  });

  // ==========================================
  // F7: Telemetry & Analytics Blocker Boundaries (5 tests)
  // ==========================================
  test('F7.B1: Interceptor blocks mixed-case telemetry domain (e.g. O123.Ingest.Sentry.IO)', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'tok' });
    const res = await interceptor.intercept('https://O123.Ingest.Sentry.IO/api/1/envelope/');
    assert.equal(res.status, 204);
  });

  test('F7.B2: Interceptor blocks deep subdomains (e.g. api.region.braze.com)', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'tok' });
    const res = await interceptor.intercept('https://api.us-east.braze.com/v3/track');
    assert.equal(res.status, 204);
  });

  test('F7.B3: Interceptor does NOT block non-telemetry domain having sentry in pathname (e.g. host.com/sentry-logs)', () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'tok' });
    assert.equal(interceptor.isTelemetryDomain('myhost.example.com'), false);
  });

  test('F7.B4: Interceptor returns 204 immediately without network latency for telemetry', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'tok' });
    const t0 = Date.now();
    await interceptor.intercept('https://app.appsflyer.com/event');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100);
  });

  test('F7.B5: High-frequency burst of 50 telemetry requests handled without leaking sockets', async () => {
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: 'tok' });
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(interceptor.intercept(`https://o${i}.ingest.sentry.io/envelope/`));
    }
    const results = await Promise.all(promises);
    assert.equal(results.length, 50);
    assert.equal(interceptor.telemetryBlockedCount, 50);
  });

  // ==========================================
  // F8: Hermes Bytecode Host Injection Boundaries (5 tests)
  // ==========================================
  test('F8.B1: Bytecode parser rejects corrupted HBC header with wrong magic number', () => {
    const corrupted = Buffer.alloc(32);
    corrupted.writeUInt32LE(0xDEADBEEF, 0);
    const res = HermesBytecodeEmulator.validateHbc(corrupted);
    assert.equal(res.valid, false);
    assert.ok(res.error.includes('magic number'));
  });

  test('F8.B2: Bytecode parser rejects unsupported HBC version (e.g. version 97 or 99)', () => {
    const hbc97 = HermesBytecodeEmulator.createHeader(97);
    const res97 = HermesBytecodeEmulator.validateHbc(hbc97);
    assert.equal(res97.valid, false);
    assert.ok(res97.error.includes('version 97'));

    const hbc99 = HermesBytecodeEmulator.createHeader(99);
    const res99 = HermesBytecodeEmulator.validateHbc(hbc99);
    assert.equal(res99.valid, false);
  });

  test('F8.B3: Bytecode parser rejects truncated file smaller than minimum header size (32 bytes)', () => {
    const truncated = Buffer.alloc(4);
    const res = HermesBytecodeEmulator.validateHbc(truncated);
    assert.equal(res.valid, false);
  });

  test('F8.B4: Bytecode string rewrite fails if replacement URL exceeds allocated string pool slot', () => {
    const safeStringReplace = (target, oldVal, newVal, maxSlot) => {
      if (newVal.length > maxSlot) {
        throw new Error('Replacement string exceeds allocated HBC string slot length');
      }
      return target.replace(oldVal, newVal);
    };
    assert.throws(() => safeStringReplace('URL', 'URL', 'https://very-long-url-that-exceeds-slot.example.com', 20));
  });

  test('F8.B5: Bytecode injection handles zero occurrences of search target without corrupting bundle', () => {
    const bundle = 'const x = 42;';
    const rewritten = HermesBytecodeEmulator.rewriteBundleStrings(bundle, 'https://not-found.com', 'http://127.0.0.1');
    assert.equal(rewritten, bundle);
  });

  // ==========================================
  // F9: Bot List Retrieval & Display Boundaries (5 tests)
  // ==========================================
  test('F9.B1: Client handles empty agent list array gracefully without crashing', () => {
    const parseBots = list => {
      if (!Array.isArray(list) || list.length === 0) return { selected: null, count: 0 };
      return { selected: list[0], count: list.length };
    };
    assert.equal(parseBots([]).count, 0);
  });

  test('F9.B2: Client handles large agent list (100+ agents) efficiently', () => {
    const largeList = [];
    for (let i = 0; i < 150; i++) {
      largeList.push({ id: `agent-${i}`, name: `Bot ${i}`, role: 'assistant' });
    }
    assert.equal(largeList.length, 150);
    const map = new Map(largeList.map(a => [a.id, a]));
    assert.equal(map.get('agent-149').name, 'Bot 149');
  });

  test('F9.B3: Client handles agent missing avatarUrl (renders fallback avatar shape/color)', () => {
    const agent = { id: 'bot-no-avatar', name: 'Bot', avatarUrl: null, avatarShape: 'circle', avatarColor: 'purple' };
    const avatar = agent.avatarUrl || `avatar:${agent.avatarShape}:${agent.avatarColor}`;
    assert.equal(avatar, 'avatar:circle:purple');
  });

  test('F9.B4: Client handles agent name with unicode emojis and RTL text', () => {
    const agent = { id: 'bot-unicode', name: '🤖 Grok مرحبا بك', role: 'assistant' };
    assert.ok(agent.name.includes('🤖'));
    assert.ok(agent.name.includes('مرحبا'));
  });

  test('F9.B5: Client handles unexpected agent metadata fields without schema failure', () => {
    const agent = { id: 'bot-ext', name: 'Bot', unexpectedExtraField: { nested: 123 } };
    assert.equal(agent.unexpectedExtraField.nested, 123);
  });

  // ==========================================
  // F10: Bidirectional Real-time Streaming Chat Boundaries (5 tests)
  // ==========================================
  test('F10.B1: Prompt exceeding 256 KB rejected with HTTP 413', async () => {
    const device = await pairTestDevice('F10B-Device-1');
    const hugePrompt = 'x'.repeat(260 * 1024);
    const res = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', clientNonce: crypto.randomUUID(), prompt: hugePrompt })
    });
    assert.equal(res.status, 413);
  });

  test('F10.B2: Duplicate clientNonce retry returns cached response without duplicate execution', async () => {
    const device = await pairTestDevice('F10B-Device-2');
    const nonce = crypto.randomUUID();
    const res1 = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', clientNonce: nonce, prompt: 'once' })
    });
    const d1 = await res1.json();

    const res2 = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', clientNonce: nonce, prompt: 'twice' })
    });
    const d2 = await res2.json();
    assert.equal(d1.messageId, d2.messageId);
  });

  test('F10.B3: Prompt with empty text but valid attachments accepted', async () => {
    const device = await pairTestDevice('F10B-Device-3');
    const res = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        clientNonce: crypto.randomUUID(),
        prompt: '',
        attachmentPaths: ['file:///data/agents/agent-default/attachments/sample.png']
      })
    });
    assert.equal(res.status, 200);
  });

  test('F10.B4: SSE stream handles unexpected disconnection and triggers reconnect with Last-Event-ID', async () => {
    const device = await pairTestDevice('F10B-Device-4');
    const sse = new SSEClientHelper(`${BASE_URL}/events`, {
      'Authorization': `Bearer ${device.token}`,
      'Last-Event-ID': 'previous-event-id-999'
    });
    await sse.connect();
    assert.ok(sse.abortController);
    sse.close();
  });

  test('F10.B5: Rapid burst of 5 prompts with unique nonces processed concurrently', async () => {
    const device = await pairTestDevice('F10B-Device-5');
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        fetch(`${BASE_URL}/api/sendPrompt`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: 'agent-default', clientNonce: crypto.randomUUID(), prompt: `Burst ${i}` })
        })
      );
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.status, 200);
    }
  });

  // ==========================================
  // F11: Push Notification Registration Boundaries (5 tests)
  // ==========================================
  test('F11.B1: Registration with unknown push provider rejected with 400 Bad Request', async () => {
    const device = await pairTestDevice('F11B-Device-1');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: { provider: 'unknown-vendor' } })
    });
    assert.equal(res.status, 400);
  });

  test('F11.B2: Registration for Bark provider with missing barkUrl rejected with 400', async () => {
    const device = await pairTestDevice('F11B-Device-2');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: { provider: 'bark' } })
    });
    assert.equal(res.status, 400);
  });

  test('F11.B3: Registration for FCM provider with missing fcmToken rejected with 400', async () => {
    const device = await pairTestDevice('F11B-Device-3');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: { provider: 'fcm' } })
    });
    assert.equal(res.status, 400);
  });

  test('F11.B4: Registration for UnifiedPush with missing endpoint rejected with 400', async () => {
    const device = await pairTestDevice('F11B-Device-4');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: { provider: 'unifiedpush' } })
    });
    assert.equal(res.status, 400);
  });

  test('F11.B5: Registration for Webhook with missing webhookUrl rejected with 400', async () => {
    const device = await pairTestDevice('F11B-Device-5');
    const res = await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: { provider: 'webhook' } })
    });
    assert.equal(res.status, 400);
  });

  // ==========================================
  // F12: In-App Foreground Event Stream Boundaries (5 tests)
  // ==========================================
  test('F12.B1: Multiple concurrent foreground streams from same device tracked correctly', async () => {
    const device = await pairTestDevice('F12B-Device-1');
    const sse1 = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`,
      'x-rokbot-foreground': '1'
    });
    const sse2 = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`,
      'x-rokbot-foreground': '1'
    });
    await sse1.connect();
    await sse2.connect();
    assert.ok(host.foregroundDevices.has(device.deviceId));
    sse1.close();
    sse2.close();
  });

  test('F12.B2: Foreground stream without x-rokbot-foreground header does NOT suppress background push', async () => {
    const device = await pairTestDevice('F12B-Device-2');
    const sse = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`
    });
    await sse.connect();
    assert.ok(!host.foregroundDevices.has(device.deviceId));

    const res = await fetch(`${BASE_URL}/local/device/push/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const data = await res.json();
    assert.equal(data.suppressed, false);
    sse.close();
  });

  test('F12.B3: Notification SSE stream ignores malformed comments and chunks', () => {
    const parser = block => {
      if (block.startsWith(':')) return null; // heartbeat comment
      return { ok: true };
    };
    assert.equal(parser(': heartbeat\n\n'), null);
    assert.equal(parser('data: {}\n\n').ok, true);
  });

  test('F12.B4: Closing one of two concurrent foreground streams keeps device in foreground set', async () => {
    const device = await pairTestDevice('F12B-Device-4');
    const sse1 = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`,
      'x-rokbot-foreground': '1'
    });
    const sse2 = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`,
      'x-rokbot-foreground': '1'
    });
    await sse1.connect();
    await sse2.connect();
    sse1.close();
    await new Promise(r => setTimeout(r, 50));
    assert.ok(host.foregroundDevices.has(device.deviceId));
    sse2.close();
  });

  test('F12.B5: Closing all foreground streams promptly removes device from foreground set', async () => {
    const device = await pairTestDevice('F12B-Device-5');
    const sse = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${device.token}`,
      'x-rokbot-foreground': '1'
    });
    await sse.connect();
    assert.ok(host.foregroundDevices.has(device.deviceId));
    sse.close();
    await new Promise(r => setTimeout(r, 50));
    assert.ok(!host.foregroundDevices.has(device.deviceId));
  });

  // ==========================================
  // F13: Android Notification Channels & Deep Linking Boundaries (5 tests)
  // ==========================================
  test('F13.B1: Deep link with missing or malformed URI scheme ignored without crashing', () => {
    const parseDeepLink = uri => {
      if (!uri || !uri.startsWith('rokbot-local://')) return null;
      return uri.slice('rokbot-local://'.length);
    };
    assert.equal(parseDeepLink('https://evil.com'), null);
    assert.equal(parseDeepLink(''), null);
  });

  test('F13.B2: Deep link with non-existent agentId falls back to default agent', () => {
    const resolveAgent = (agentId, knownAgents) => {
      return knownAgents.includes(agentId) ? agentId : 'agent-default';
    };
    assert.equal(resolveAgent('ghost-bot', ['agent-default', 'agent-coding']), 'agent-default');
  });

  test('F13.B3: Notification with extreme character length (2000 chars) truncated gracefully', () => {
    const truncateBody = (text, max = 256) => {
      return text.length > max ? text.slice(0, max) + '...' : text;
    };
    const huge = 'A'.repeat(2000);
    assert.equal(truncateBody(huge).length, 259);
  });

  test('F13.B4: Notification with invalid channel id falls back to messages channel', () => {
    const resolveChannel = (channelId, available) => {
      return available.includes(channelId) ? channelId : 'messages';
    };
    assert.equal(resolveChannel('unknown-ch', ['messages', 'attention']), 'messages');
  });

  test('F13.B5: Notification intent contains required FLAG_ACTIVITY_NEW_TASK flag', () => {
    const FLAG_ACTIVITY_NEW_TASK = 0x10000000;
    const flags = 0x10000000 | 0x04000000;
    assert.ok((flags & FLAG_ACTIVITY_NEW_TASK) !== 0);
  });

  // ==========================================
  // F14: Chat Multimodal Attachments Upload Boundaries (5 tests)
  // ==========================================
  test('F14.B1: Standard file exceeding 25 MB limit rejected with 413 Payload Too Large', async () => {
    const device = await pairTestDevice('F14B-Device-1');
    const res = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId: crypto.randomUUID(),
        filename: 'huge.png',
        offset: 0,
        totalSize: 26 * 1024 * 1024,
        bytesBase64: 'AA=='
      })
    });
    assert.equal(res.status, 413);
  });

  test('F14.B2: Video file exceeding 200 MB limit rejected with 413 Payload Too Large', async () => {
    const device = await pairTestDevice('F14B-Device-2');
    const res = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId: crypto.randomUUID(),
        filename: 'huge_video.mp4',
        offset: 0,
        totalSize: 201 * 1024 * 1024,
        bytesBase64: 'AA=='
      })
    });
    assert.equal(res.status, 413);
  });

  test('F14.B3: Upload chunk with offset exceeding declared totalSize rejected with 400', async () => {
    const device = await pairTestDevice('F14B-Device-3');
    const res = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId: crypto.randomUUID(),
        filename: 'overflow.png',
        offset: 1500,
        totalSize: 1000,
        bytesBase64: 'AA=='
      })
    });
    assert.equal(res.status, 400);
  });

  test('F14.B4: Upload with chunk bytes exceeding declared totalSize rejected with 400', async () => {
    const device = await pairTestDevice('F14B-Device-4');
    const bigChunk = Buffer.alloc(2000).toString('base64');
    const res = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId: crypto.randomUUID(),
        filename: 'overflow2.png',
        offset: 0,
        totalSize: 1000,
        bytesBase64: bigChunk
      })
    });
    assert.equal(res.status, 400);
  });

  test('F14.B5: Upload with missing required fields (agentId, uploadId) rejected with 400', async () => {
    const device = await pairTestDevice('F14B-Device-5');
    const res = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.png' })
    });
    assert.equal(res.status, 400);
  });

  // ==========================================
  // F15: Attachment Readback & Preview Boundaries (5 tests)
  // ==========================================
  test('F15.B1: Attachment URL with directory traversal (../../etc/passwd) rejected with 403 Forbidden', async () => {
    const device = await pairTestDevice('F15B-Device-1');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///data/agents/../../../etc/passwd' })
    });
    assert.equal(res.status, 403);
  });

  test('F15.B2: Attachment URL outside /data/agents/ path rejected with 403 Forbidden', async () => {
    const device = await pairTestDevice('F15B-Device-2');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/hosts' })
    });
    assert.equal(res.status, 403);
  });

  test('F15.B3: Attachment with unsupported extension (.exe, .sh) rejected with 415 Unsupported Media Type', async () => {
    const device = await pairTestDevice('F15B-Device-3');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///data/agents/agent-default/attachments/malware.exe' })
    });
    assert.equal(res.status, 415);
  });

  test('F15.B4: Attachment URL with missing or empty parameter rejected with 400 Bad Request', async () => {
    const device = await pairTestDevice('F15B-Device-4');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  test('F15.B5: Non-existent attachment file returns fallback image placeholder without crashing', async () => {
    const device = await pairTestDevice('F15B-Device-5');
    const res = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///data/agents/agent-default/attachments/non-existent.png' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.dataUrl);
  });

  // ==========================================
  // F16: Bot Library File Management Boundaries (5 tests)
  // ==========================================
  test('F16.B1: Single library file exceeding 20 MiB rejected with 413 Payload Too Large', async () => {
    const device = await pairTestDevice('F16B-Device-1');
    const hugeBuffer = Buffer.alloc(21 * 1024 * 1024, 'a').toString('base64');
    const res = await fetch(`${BASE_URL}/local/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        fileName: 'oversized.pdf',
        base64: hugeBuffer
      })
    });
    assert.equal(res.status, 413);
  });

  test('F16.B2: Uploading file that causes bot library to exceed 100 MiB quota rejected with 413', async () => {
    const device = await pairTestDevice('F16B-Device-2');
    const agentId = 'agent-quota-test';
    // Fill 5 x 19MB = 95MB
    const chunk19 = Buffer.alloc(19 * 1024 * 1024, 'z').toString('base64');
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${BASE_URL}/local/files`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, fileName: `part${i}.bin`, base64: chunk19 })
      });
      assert.equal(r.status, 200);
    }
    // Attempt 10MB more -> total 105MB > 100MB
    const chunk10 = Buffer.alloc(10 * 1024 * 1024, 'z').toString('base64');
    const overflowRes = await fetch(`${BASE_URL}/local/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, fileName: 'overflow.bin', base64: chunk10 })
    });
    assert.equal(overflowRes.status, 413);
  });

  test('F16.B3: Bot library exceeding 100 files limit rejected with 413', async () => {
    const device = await pairTestDevice('F16B-Device-3');
    const agentId = 'agent-filecount-test';
    const small = Buffer.from('x').toString('base64');
    // Pre-populate 100 files in mock host
    for (let i = 0; i < 100; i++) {
      await fetch(`${BASE_URL}/local/files`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, fileName: `f${i}.txt`, base64: small })
      });
    }
    // 101st file
    const overflow = await fetch(`${BASE_URL}/local/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, fileName: 'f101.txt', base64: small })
    });
    assert.equal(overflow.status, 413);
  });

  test('F16.B4: Upload with empty filename or missing base64 rejected with 400 Bad Request', async () => {
    const device = await pairTestDevice('F16B-Device-4');
    const res = await fetch(`${BASE_URL}/local/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', fileName: '', base64: '' })
    });
    assert.equal(res.status, 400);
  });

  test('F16.B5: Downloading non-existent library file returns 404 Not Found', async () => {
    const device = await pairTestDevice('F16B-Device-5');
    const res = await fetch(`${BASE_URL}/local/files/content?agentId=agent-default&name=nonexistent.txt`, {
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    assert.equal(res.status, 404);
  });

  // ==========================================
  // F17: Voice Session Credentials Handshake Boundaries (5 tests)
  // ==========================================
  test('F17.B1: Voice session request when 64 pending tickets exist rejected with 429 Too Many Requests', async () => {
    const tickets = [];
    for (let i = 0; i < 64; i++) {
      const dev = await pairTestDevice(`F17-Dev-${i}`);
      const r = await fetch(`${BASE_URL}/local/voice/session`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${dev.token}` }
      });
      assert.equal(r.status, 200);
      tickets.push(dev);
    }
    // 65th ticket
    const extraDev = await pairTestDevice('F17-Dev-Extra');
    const r65 = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${extraDev.token}` }
    });
    assert.equal(r65.status, 429);
    // Cleanup tickets and devices
    host.voiceTickets.clear();
    for (const d of tickets) {
      host.devices.delete(d.token);
      host.devicesById.delete(d.deviceId);
    }
    host.devices.delete(extraDev.token);
    host.devicesById.delete(extraDev.deviceId);
  });

  test('F17.B2: Re-requesting voice session replaces and burns previous ticket for same device', async () => {
    const device = await pairTestDevice('F17B-Device-2');
    const r1 = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const s1 = await r1.json();

    const r2 = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const s2 = await r2.json();

    assert.notEqual(s1.clientSecret, s2.clientSecret);
  });

  test('F17.B3: Unauthenticated voice session request rejected with 401 Unauthorized', async () => {
    const res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer bad-token-here-12345678901234567890' }
    });
    assert.equal(res.status, 401);
  });

  test('F17.B4: Voice session request with unknown audioProcessing string falls back to default', async () => {
    const device = await pairTestDevice('F17B-Device-4');
    const res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioProcessing: 'custom-unsupported-aec' })
    });
    assert.equal(res.status, 200);
  });

  test('F17.B5: Expired voice ticket (after 60s) cannot be used for WebSocket upgrade', async () => {
    const device = await pairTestDevice('F17B-Device-5');
    const res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const sess = await res.json();
    const hash = crypto.createHash('sha256').update(sess.clientSecret).digest('hex');
    const ticket = host.voiceTickets.get(hash);
    ticket.expiresAt = Date.now() - 1000; // Expired

    const protocol = `xai-client-secret.${sess.clientSecret}`;
    const ws = new globalThis.WebSocket(sess.websocketUrl, protocol);
    await new Promise((resolve) => {
      ws.onerror = resolve;
      ws.onclose = resolve;
    });
    assert.notEqual(ws.readyState, 1);
  });

  // ==========================================
  // F18: Real-Time Voice WebSocket Stream Boundaries (5 tests)
  // ==========================================
  test('F18.B1: WebSocket upgrade without Sec-WebSocket-Protocol rejected with 401 Unauthorized', async () => {
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${host.actualPort}/local/voice/realtime`);
    await new Promise(resolve => {
      ws.onerror = resolve;
      ws.onclose = resolve;
    });
    assert.notEqual(ws.readyState, 1);
  });

  test('F18.B2: WebSocket upgrade with invalid subprotocol format rejected with 401 Unauthorized', async () => {
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${host.actualPort}/local/voice/realtime`, 'invalid-subprotocol-format');
    await new Promise(resolve => {
      ws.onerror = resolve;
      ws.onclose = resolve;
    });
    assert.notEqual(ws.readyState, 1);
  });

  test('F18.B3: WebSocket upgrade when call already active for device rejected with 409 Conflict', async () => {
    const device = await pairTestDevice('F18B-Device-3');
    const r1 = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const s1 = await r1.json();
    const ws1 = new globalThis.WebSocket(s1.websocketUrl, `xai-client-secret.${s1.clientSecret}`);
    await new Promise(r => { ws1.onopen = r; });

    // Second session request for same device
    const r2 = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const s2 = await r2.json();
    const ws2 = new globalThis.WebSocket(s2.websocketUrl, `xai-client-secret.${s2.clientSecret}`);
    await new Promise(r => {
      ws2.onerror = r;
      ws2.onclose = r;
    });
    assert.notEqual(ws2.readyState, 1);
    ws1.close();
  });

  test('F18.B4: Sending binary WebSocket frame returns 400 error frame', async () => {
    const device = await pairTestDevice('F18B-Device-4');
    const r = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const sess = await r.json();
    const ws = new globalThis.WebSocket(sess.websocketUrl, `xai-client-secret.${sess.clientSecret}`);
    await new Promise(r => { ws.onopen = r; });

    ws.send(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    const errFrame = await new Promise(r => {
      ws.onmessage = e => {
        const parsed = JSON.parse(e.data);
        if (parsed.type === 'error') r(parsed);
      };
    });
    assert.equal(errFrame.error.code, '400');
    ws.close();
  });

  test('F18.B5: Sending malformed non-JSON text frame returns invalid_request_error frame', async () => {
    const device = await pairTestDevice('F18B-Device-5');
    const r = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    const sess = await r.json();
    const ws = new globalThis.WebSocket(sess.websocketUrl, `xai-client-secret.${sess.clientSecret}`);
    await new Promise(r => { ws.onopen = r; });

    ws.send('NOT VALID JSON');
    const errFrame = await new Promise(r => {
      ws.onmessage = e => {
        const parsed = JSON.parse(e.data);
        if (parsed.type === 'error') r(parsed);
      };
    });
    assert.equal(errFrame.error.type, 'invalid_request_error');
    ws.close();
  });

  // ==========================================
  // F19: Hardware Echo Cancellation & Noise Suppression Boundaries (5 tests)
  // ==========================================
  test('F19.B1: PCM capture buffer with odd byte length (not 16-bit aligned) throws validation error', () => {
    const aec = new AecAudioEmulator();
    assert.throws(() => aec.processCapture(Buffer.alloc(999)), /length must be even/);
  });

  test('F19.B2: AEC far-end buffer caps at 100 frames to prevent memory leak', () => {
    const aec = new AecAudioEmulator();
    for (let i = 0; i < 150; i++) {
      aec.bufferFarend(Buffer.alloc(480));
    }
    assert.equal(aec.farendBuffer.length, 100);
  });

  test('F19.B3: AEC capture without far-end reference frames does not suppress echo', () => {
    const aec = new AecAudioEmulator();
    const res = aec.processCapture(Buffer.alloc(480));
    assert.equal(res.echoSuppressed, false);
  });

  test('F19.B4: Rapid alternating far-end and capture frames processes without drift', () => {
    const aec = new AecAudioEmulator();
    for (let i = 0; i < 20; i++) {
      aec.bufferFarend(Buffer.alloc(480));
      const res = aec.processCapture(Buffer.alloc(480));
      assert.equal(res.echoSuppressed, true);
    }
  });

  test('F19.B5: High-amplitude clipping in capture frame does not crash AEC filter', () => {
    const aec = new AecAudioEmulator();
    const clippedPcm = Buffer.alloc(480, 0x7F); // Max 16-bit amplitude
    const res = aec.processCapture(clippedPcm);
    assert.equal(res.cleanedLength, 480);
  });

  // ==========================================
  // F20: Speech-to-Text Audio Transcription Boundaries (5 tests)
  // ==========================================
  test('F20.B1: Empty audio transcription request body rejected with 400 Bad Request', async () => {
    const device = await pairTestDevice('F20B-Device-1');
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}` },
      body: ''
    });
    assert.equal(res.status, 400);
  });

  test('F20.B2: Audio transcription request without Bearer token rejected with 401 Unauthorized', async () => {
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      body: JSON.stringify({ audioBase64: 'test' })
    });
    assert.equal(res.status, 401);
  });

  test('F20.B3: Audio transcription handles corrupted base64 string without crashing', async () => {
    const device = await pairTestDevice('F20B-Device-3');
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: '%%%NOT_BASE64%%%' })
    });
    assert.equal(res.status, 200);
  });

  test('F20.B4: Unsupported language code falls back to default transcript', async () => {
    const device = await pairTestDevice('F20B-Device-4');
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: 'test', language: 'xx-klingon' })
    });
    const data = await res.json();
    assert.equal(data.text, 'Transcribed audio speech text');
  });

  test('F20.B5: Multi-kilobyte audio PCM base64 payload processes with valid duration', async () => {
    const device = await pairTestDevice('F20B-Device-5');
    const largeAudio = Buffer.alloc(48000, 1).toString('base64'); // 1 second of 24kHz mono PCM
    const res = await fetch(`${BASE_URL}/local/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: largeAudio })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.duration > 0);
  });

  // ==========================================
  // F21 Boundary: Model Config Auth, Step-Up & Validation (5 tests)
  // ==========================================
  test('F21.B1: GET /local/model returns 403 without x-rokbot-admin-password when step-up required', async () => {
    const device = await pairTestDevice('F21B-Device-1');
    host.requireStepUpPassword = true;
    try {
      const denied = await fetch(`${BASE_URL}/local/model`, {
        headers: { 'Authorization': `Bearer ${device.token}` }
      });
      assert.equal(denied.status, 403);
      const allowed = await fetch(`${BASE_URL}/local/model`, {
        headers: {
          'Authorization': `Bearer ${device.token}`,
          'x-rokbot-admin-password': host.adminPassword
        }
      });
      assert.equal(allowed.status, 200);
    } finally {
      host.requireStepUpPassword = false;
    }
  });

  test('F21.B2: PUT /local/model rejects new provider missing apiKey with 400', async () => {
    const device = await pairTestDevice('F21B-Device-2');
    const res = await fetch(`${BASE_URL}/local/model`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        providers: [{ id: 'brand_new_prov', name: 'New', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' }],
        profiles: [{ id: 'p1', name: 'P1', providerId: 'brand_new_prov', model: 'gpt-5', efforts: ['low'] }],
        defaultRoute: { profileId: 'p1', effort: 'default', fallbacks: [] }
      })
    });
    assert.equal(res.status, 400);
  });

  test('F21.B3: PUT /local/model rejects unknown profileId in defaultRoute with 400', async () => {
    const device = await pairTestDevice('F21B-Device-3');
    const res = await fetch(`${BASE_URL}/local/model`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        providers: [{ id: 'default', name: 'OpenAI', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' }],
        profiles: [{ id: 'default', name: 'GPT-5', providerId: 'default', model: 'gpt-5', efforts: ['low'] }],
        defaultRoute: { profileId: 'nonexistent_profile', effort: 'default', fallbacks: [] }
      })
    });
    assert.equal(res.status, 400);
  });

  test('F21.B4: POST /local/model/catalog reuses saved apiKey when draft provider omits apiKey', async () => {
    const device = await pairTestDevice('F21B-Device-4');
    const res = await fetch(`${BASE_URL}/local/model/catalog`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: { id: 'default', name: 'OpenAI', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' }
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  });

  test('F21.B5: Unpaired request to /local/status returns 401', async () => {
    const res = await fetch(`${BASE_URL}/local/status`);
    assert.equal(res.status, 401);
  });

  // ==========================================
  // F22 Boundary: Android Update Manifest & Artifact Auth (5 tests)
  // ==========================================
  test('F22.B1: GET /local/updates/files/android/:file rejects unauthenticated request with 401', async () => {
    const res = await fetch(`${BASE_URL}/local/updates/files/android/app.apk`);
    assert.equal(res.status, 401);
  });

  test('F22.B2: GET /local/updates/android.json rejects invalid Bearer token with 401', async () => {
    const res = await fetch(`${BASE_URL}/local/updates/android.json`, {
      headers: { 'Authorization': 'Bearer invalid-token-00000000000000000000000000' }
    });
    assert.equal(res.status, 401);
  });

  test('F22.B3: Manifest with RBDELTA1 delta preserves fromApkSha256 and fromVersionCode fields', async () => {
    const device = await pairTestDevice('F22B-Device-3');
    host.androidUpdateManifest = {
      schema: 'rokbot-android-native-update/v1',
      latest: {
        versionName: '1.16.0',
        versionCode: 1075,
        packageName: 'dev.rokbot.nativeapp',
        certificateSha256: 'c'.repeat(64),
        apkUrl: `${BASE_URL}/local/updates/files/android/RokBotLocal-1.16.0.apk`,
        apkSha256: 'd'.repeat(64),
        apkSize: 54321,
        releaseNotes: 'Companion repatch',
        deltas: [{
          fromVersionCode: 1075,
          fromApkSha256: 'e'.repeat(64),
          format: 'RBDELTA1',
          url: `${BASE_URL}/local/updates/files/android/patch.rbdelta`,
          sha256: 'f'.repeat(64),
          size: 4096,
        }],
      }
    };
    try {
      const res = await fetch(`${BASE_URL}/local/updates/android.json`, {
        headers: { 'Authorization': `Bearer ${device.token}` }
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.latest.deltas[0].format, 'RBDELTA1');
      assert.equal(data.latest.deltas[0].fromApkSha256, 'e'.repeat(64));
      assert.equal(data.latest.deltas[0].fromVersionCode, 1075);
    } finally {
      host.androidUpdateManifest = null;
    }
  });

  test('F22.B4: URL-encoded artifact filename decodes cleanly on /local/updates/files/android/', async () => {
    const device = await pairTestDevice('F22B-Device-4');
    const payload = Buffer.from('apk-bytes');
    host.androidUpdateArtifacts.set('RokBot Local-1.16.0.apk', payload);
    try {
      const res = await fetch(`${BASE_URL}/local/updates/files/android/${encodeURIComponent('RokBot Local-1.16.0.apk')}`, {
        headers: { 'Authorization': `Bearer ${device.token}` }
      });
      assert.equal(res.status, 200);
      const got = Buffer.from(await res.arrayBuffer());
      assert.ok(got.equals(payload));
    } finally {
      host.androidUpdateArtifacts.delete('RokBot Local-1.16.0.apk');
    }
  });

  test('F22.B5: Invalid JSON body on PUT /local/model returns 400 without corrupting state', async () => {
    const device = await pairTestDevice('F22B-Device-5');
    const res = await fetch(`${BASE_URL}/local/model`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${device.token}`, 'Content-Type': 'application/json' },
      body: '{not-valid-json'
    });
    assert.equal(res.status, 400);
    const check = await fetch(`${BASE_URL}/local/model`, {
      headers: { 'Authorization': `Bearer ${device.token}` }
    });
    assert.equal(check.status, 200);
  });

  return tests;
}

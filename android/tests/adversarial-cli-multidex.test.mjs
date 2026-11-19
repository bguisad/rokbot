// Adversarial Stress Testing Harness: CLI Pipeline & MultiDex (Milestone 1)
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getNextDexName, injectCompanionDex, loadDefaultCompanionDex } from '../patchers/dex.mjs';
import { parseAxml, patchManifest } from '../patchers/manifest.mjs';
import { readZip, writeZip, createEntry, entryBytes, verifyApk } from '../patchers/signing.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const FIXTURE_APK = path.join(ROOT_DIR, 'android/bin/rokbot-native-base.apk');
const PATCH_CLI = path.join(__dirname, '../release/patch-android.mjs');

function runCli(args) {
  return cp.spawnSync('node', [PATCH_CLI, ...args], { encoding: 'utf8' });
}

function hashProtectedAndroidAssets() {
  const targets = [
    path.join(ROOT_DIR, 'android/recipes'),
    path.join(ROOT_DIR, 'android/bin/rokbot-native-base.apk'),
  ];
  function scan(current, base) {
    let list = [];
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const file of fs.readdirSync(current)) {
        list = list.concat(scan(path.join(current, file), base));
      }
    } else {
      const h = crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex');
      list.push({ path: path.relative(base, current), size: stat.size, sha256: h });
    }
    return list;
  }
  const files = targets.flatMap(t => scan(t, ROOT_DIR));
  const combined = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { count: files.length, hash: combined };
}

const INITIAL_PROTECTED_ASSETS = hashProtectedAndroidAssets();

// =========================================================================
// 1. MultiDex Injection Invariants
// =========================================================================

test('ADV-DEX-1: getNextDexName properly detects K=3 and returns classes4.dex', () => {
  const entries = ['classes.dex', 'classes2.dex', 'classes3.dex'];
  const next = getNextDexName(entries);
  assert.equal(next, 'classes4.dex', 'MultiDex with K=3 must yield classes4.dex');
});

test('ADV-DEX-2: MultiDex gap resolution - getNextDexName fills missing intermediate index', () => {
  // APK with classes.dex and classes3.dex (classes2.dex is missing)
  const entriesWithGap = ['classes.dex', 'classes3.dex'];
  const next = getNextDexName(entriesWithGap);

  // Gap-filling logic must return classes2.dex to maintain sequential continuity for Android ART
  assert.equal(next, 'classes2.dex', 'Gap filling: must fill missing classes2.dex to ensure ART sequential loading');
});

test('ADV-DEX-3: MultiDex primary dex validation - rejects missing classes.dex when secondary dexes exist', () => {
  const entriesNoPrimary = ['classes2.dex', 'classes3.dex'];
  assert.throws(() => {
    getNextDexName(entriesNoPrimary);
  }, /Primary dex \(classes\.dex\) is missing/);
});

test('ADV-DEX-4: Non-root dex entries strictly ignored by root entry matcher', () => {
  // Nested assets/classes5.dex must not be matched as a root dex entry
  const entriesWithAsset = ['classes.dex', 'assets/classes5.dex'];
  const next = getNextDexName(entriesWithAsset);
  assert.equal(next, 'classes2.dex', 'Strict root matching must ignore nested asset dex');
});

test('ADV-DEX-5: injectCompanionDex validates DEX header magic', () => {
  const invalidBuffers = [
    Buffer.alloc(0),
    Buffer.from('corrupt'),
    Buffer.from('dex_035\0'), // wrong magic
    Buffer.from('PK\x03\x041234') // zip magic instead of dex
  ];

  for (const invalidBuf of invalidBuffers) {
    assert.throws(() => {
      injectCompanionDex([], invalidBuf);
    }, /Invalid (companion dex buffer|DEX magic header)/);
  }
});

test('ADV-DEX-6: injectCompanionDex verifies companion dex in bin/classes2.dex has valid magic', () => {
  const companionDex = loadDefaultCompanionDex();
  assert.ok(companionDex.length >= 8);
  const magic = companionDex.subarray(0, 4).toString('latin1');
  assert.equal(magic, 'dex\n');
  const version = companionDex.subarray(4, 7).toString('latin1');
  assert.equal(version, '038');
});

test('ADV-DEX-7: Repatching deduplication - repeated injectCompanionDex updates in-place without accumulation', () => {
  const companionDex = loadDefaultCompanionDex();
  const initial = [
    createEntry('classes.dex', Buffer.from('dex\n035\0dummy-dex-content'), { store: false })
  ];

  const patch1 = injectCompanionDex(initial, companionDex);
  assert.equal(patch1.injectedName, 'classes2.dex');
  assert.equal(patch1.entries.filter(e => e.name.endsWith('.dex')).length, 2);

  const patch2 = injectCompanionDex(patch1.entries, companionDex);
  assert.equal(patch2.injectedName, 'classes2.dex', 'Repatching must reuse existing companion slot classes2.dex');
  assert.equal(patch2.entries.filter(e => e.name.endsWith('.dex')).length, 2, 'Must not accumulate duplicate dex entries');

  const patch3 = injectCompanionDex(patch2.entries, companionDex);
  assert.equal(patch3.injectedName, 'classes2.dex', 'Subsequent repatching must remain idempotent at classes2.dex');
  assert.equal(patch3.entries.filter(e => e.name.endsWith('.dex')).length, 2, 'DEX entry count must remain exactly 2');
});

// =========================================================================
// 2. CLI Argument Fuzzing
// =========================================================================

test('ADV-CLI-1: Non-existent input APK exits with code 1 and clean error message', () => {
  const res = runCli(['--input-apk', '/nonexistent/file.apk', '--output-apk', '/tmp/out.apk']);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('Error: Input APK file not found'));
  assert.ok(!res.stderr.includes('at runPatchPipeline'), 'Must not leak raw stack trace');
});

test('ADV-CLI-2: Directory input instead of file exits with code 1', () => {
  const res = runCli(['--input-apk', path.join(ROOT_DIR, 'android'), '--output-apk', '/tmp/out.apk']);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('EISDIR'));
  assert.ok(!res.stderr.includes('UnhandledPromiseRejection'), 'Must not have unhandled promise rejection');
});

test('ADV-CLI-3: Read-only output directory exits with code 1 and permission denied', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-test-'));
  const roDir = path.join(tmpDir, 'readonly');
  fs.mkdirSync(roDir, { mode: 0o555 });
  const outApk = path.join(roDir, 'out.apk');

  try {
    const res = runCli(['--input-apk', FIXTURE_APK, '--output-apk', outApk]);
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes('EACCES: permission denied'));
  } finally {
    fs.chmodSync(roDir, 0o777);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ADV-CLI-4: Host URL protocol validation rejects invalid protocols', () => {
  const invalidProtocols = [
    'not-a-url',
    'javascript:alert(1)',
    'ftp://127.0.0.1:8080',
    'ws://127.0.0.1:8080',
    'file:///etc/passwd'
  ];

  for (const host of invalidProtocols) {
    const res = runCli(['--input-apk', FIXTURE_APK, '--output-apk', '/tmp/out.apk', '--host', host]);
    assert.equal(res.status, 1, `Host ${host} must be rejected`);
    assert.ok(res.stderr.includes('Error: --host must be a valid HTTP or HTTPS URL'));
  }
});

test('ADV-CLI-5: Host URL rejects embedded user credentials', () => {
  const res = runCli([
    '--input-apk', FIXTURE_APK,
    '--output-apk', '/tmp/out.apk',
    '--host', 'http://admin:secret@127.0.0.1:8080'
  ]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('Error: --host must not contain user credentials'));
});

test('ADV-CLI-6: Host URL validation strictly rejects malformed HTTP/HTTPS URLs', () => {
  const malformedHttpUrls = ['http://', 'http://[::1', 'http://:8080'];
  for (const host of malformedHttpUrls) {
    assert.throws(() => new URL(host), TypeError, `URL ${host} is invalid per WHATWG standard`);
    const res = runCli([
      '--input-apk', FIXTURE_APK,
      '--output-apk', '/tmp/out_malformed_url.apk',
      '--host', host,
      '--force'
    ]);
    assert.equal(res.status, 1, `Malformed URL ${host} must be rejected`);
    assert.ok(res.stderr.includes('Error: --host must be a valid HTTP or HTTPS URL'));
  }
});

test('ADV-CLI-7: Pairing code empty string is rejected by strict validation', () => {
  const res = runCli([
    '--input-apk', FIXTURE_APK,
    '--output-apk', '/tmp/out_empty_code.apk',
    '--pairing-code', '',
    '--force'
  ]);
  assert.equal(res.status, 1, 'Empty string pairing code must be rejected');
  assert.ok(res.stderr.includes('--pairing-code must be exactly 6 uppercase alphanumeric characters excluding I/O/1/0'));
});

test('ADV-CLI-8: Pairing code rejects excluded characters (1, 0, I, O)', () => {
  const invalidCodes = ['K7M9P1', 'K7M9P0', 'K7M9PI', 'K7M9PO', '123456', 'OOOOOO', 'IIIIII'];
  for (const code of invalidCodes) {
    const res = runCli([
      '--input-apk', FIXTURE_APK,
      '--output-apk', '/tmp/out.apk',
      '--pairing-code', code,
      '--force'
    ]);
    assert.equal(res.status, 1, `Code ${code} must be rejected`);
    assert.ok(res.stderr.includes('--pairing-code must be exactly 6 uppercase alphanumeric characters excluding I/O/1/0'));
  }
});

test('ADV-CLI-9: Pairing code rejects invalid lengths and non-alphanumeric formats', () => {
  const malformedCodes = ['ABC', 'ABCDE', 'ABCDEFG', 'ABC-DEF', 'AB CD', 'AB@#12'];
  for (const code of malformedCodes) {
    const res = runCli([
      '--input-apk', FIXTURE_APK,
      '--output-apk', '/tmp/out.apk',
      '--pairing-code', code,
      '--force'
    ]);
    assert.equal(res.status, 1, `Code ${code} must be rejected`);
    assert.ok(res.stderr.includes('--pairing-code must be exactly 6 uppercase alphanumeric characters excluding I/O/1/0'));
  }
});

test('ADV-CLI-10: Pairing code accepts valid 6-char code', () => {
  const res = runCli([
    '--input-apk', FIXTURE_APK,
    '--output-apk', '/tmp/out_valid_code.apk',
    '--pairing-code', 'K7M9P2',
    '--force'
  ]);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('Patched APK generated successfully'));
});

// =========================================================================
// 3. Output Integrity & Idempotency
// =========================================================================

test('ADV-OUT-1: Output collision protection without --force exits with code 1', () => {
  const outApk = '/tmp/out_collision_test.apk';
  // Step 1: create initial output
  const r1 = runCli(['--input-apk', FIXTURE_APK, '--output-apk', outApk, '--force']);
  assert.equal(r1.status, 0);

  // Step 2: run without --force
  const r2 = runCli(['--input-apk', FIXTURE_APK, '--output-apk', outApk]);
  assert.equal(r2.status, 1);
  assert.ok(r2.stderr.includes('Output APK already exists at'));
  assert.ok(r2.stderr.includes('Use --force to overwrite'));

  // Step 3: run with --force
  const r3 = runCli(['--input-apk', FIXTURE_APK, '--output-apk', outApk, '--force']);
  assert.equal(r3.status, 0);
});

test('ADV-OUT-2: Repatching generates valid signed APKs at each level', () => {
  const out1 = '/tmp/repatch_lvl1.apk';
  const out2 = '/tmp/repatch_lvl2.apk';
  const out3 = '/tmp/repatch_lvl3.apk';

  const r1 = runCli(['--input-apk', FIXTURE_APK, '--output-apk', out1, '--force']);
  assert.equal(r1.status, 0);
  const r2 = runCli(['--input-apk', out1, '--output-apk', out2, '--force']);
  assert.equal(r2.status, 0);
  const r3 = runCli(['--input-apk', out2, '--output-apk', out3, '--force']);
  assert.equal(r3.status, 0);

  for (const apkPath of [out1, out2, out3]) {
    const bytes = fs.readFileSync(apkPath);
    const result = verifyApk(bytes);
    assert.equal(result.verified, true);
    assert.equal(result.hasV2, true);
    assert.equal(result.hasV3, true);
    assert.ok(result.certificate);
  }
});

test('ADV-OUT-3: Repatching manifest idempotency - does not duplicate components or permissions', () => {
  const out1 = '/tmp/repatch_lvl1.apk';
  const out2 = '/tmp/repatch_lvl2.apk';

  const zip1 = readZip(fs.readFileSync(out1));
  const zip2 = readZip(fs.readFileSync(out2));

  const manifest1 = parseAxml(entryBytes(zip1.entries.find(e => e.name === 'AndroidManifest.xml')));
  const manifest2 = parseAxml(entryBytes(zip2.entries.find(e => e.name === 'AndroidManifest.xml')));

  const root1 = manifest1.rootNodes.find(n => n.name === 'manifest');
  const root2 = manifest2.rootNodes.find(n => n.name === 'manifest');

  const app1 = root1.children.find(n => n.name === 'application');
  const app2 = root2.children.find(n => n.name === 'application');

  const pairingCount1 = app1.children.filter(c => c.name === 'activity' && c.attributes.some(a => a.value === 'dev.rokbot.nativeapp.PairingActivity')).length;
  const pairingCount2 = app2.children.filter(c => c.name === 'activity' && c.attributes.some(a => a.value === 'dev.rokbot.nativeapp.PairingActivity')).length;
  assert.equal(pairingCount1, 1);
  assert.equal(pairingCount2, 1, 'PairingActivity must not be duplicated on repatch');

  const notifCount1 = app1.children.filter(c => c.name === 'service' && c.attributes.some(a => a.value === 'dev.rokbot.nativeapp.NotificationService')).length;
  const notifCount2 = app2.children.filter(c => c.name === 'service' && c.attributes.some(a => a.value === 'dev.rokbot.nativeapp.NotificationService')).length;
  assert.equal(notifCount1, 1);
  assert.equal(notifCount2, 1, 'NotificationService must not be duplicated on repatch');

  const permCount1 = root1.children.filter(c => c.name === 'uses-permission').length;
  const permCount2 = root2.children.filter(c => c.name === 'uses-permission').length;
  assert.equal(permCount1, permCount2, 'Permissions list must remain identical on repatch');
});

// =========================================================================
// 4. Boundary Preservation & Companion DEX Isolation
// =========================================================================

function readDexClassDescriptors(dexBuf) {
  const stringIdsOff = dexBuf.readUInt32LE(60);
  const typeIdsOff = dexBuf.readUInt32LE(68);
  const classDefsSize = dexBuf.readUInt32LE(96);
  const classDefsOff = dexBuf.readUInt32LE(100);

  const readStringAt = (strIdx) => {
    const dataOff = dexBuf.readUInt32LE(stringIdsOff + strIdx * 4);
    let pos = dataOff;
    let byte;
    do {
      byte = dexBuf[pos++];
    } while (byte & 0x80); // skip ULEB128 utf16 size
    const end = dexBuf.indexOf(0x00, pos);
    return dexBuf.toString('utf8', pos, end);
  };

  const out = [];
  for (let i = 0; i < classDefsSize; i++) {
    const typeIdx = dexBuf.readUInt32LE(classDefsOff + i * 32);
    const descStrIdx = dexBuf.readUInt32LE(typeIdsOff + typeIdx * 4);
    out.push(readStringAt(descStrIdx));
  }
  return out;
}

test('ADV-DEX-4: Companion DEX contains only dev.rokbot.nativeapp and dev.grokbot.local.TailcatBridge without homemade primary UI', () => {
  const dexBuf = loadDefaultCompanionDex();
  const classes = readDexClassDescriptors(dexBuf);
  assert.ok(classes.length > 0, 'Companion DEX must define classes');
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/RokBotBootstrap;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/RokBotInitProvider;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/NetworkInterceptor;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/VoiceCallService;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/NotificationService;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/PairingActivity;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/LibraryActivity;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/ProfileActivity;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/PushSettingsActivity;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/UsageActivity;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/ComputersActivity;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/ComputerViewerActivity;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/ModelsActivity;'));
  assert.ok(classes.includes('Ldev/rokbot/nativeapp/ShareTargetActivity;'));
  assert.ok(classes.includes('Ldev/grokbot/local/TailcatBridge;'));
  for (const forbidden of [
    'Ldev/rokbot/nativeapp/BotListActivity;',
    'Ldev/rokbot/nativeapp/ChatActivity;',
    'Ldev/rokbot/nativeapp/VoiceCallActivity;',
    'Ldev/rokbot/nativeapp/ConnectorsActivity;',
    'Ldev/rokbot/nativeapp/MarkdownRenderer;',
  ]) {
    assert.ok(!classes.includes(forbidden), `Companion DEX must NOT reimplement primary UI class ${forbidden}`);
  }
  const nonNative = classes.filter(
    c => !c.startsWith('Ldev/rokbot/nativeapp/') && c !== 'Ldev/grokbot/local/TailcatBridge;'
  );
  assert.deepEqual(nonNative, [], `Companion DEX must not bundle stub classes: ${nonNative.join(', ')}`);
});

test('ADV-BND-1: Strict zero modification tolerance on android recipes and base fixture APK', () => {
  const current = hashProtectedAndroidAssets();
  assert.ok(INITIAL_PROTECTED_ASSETS.count > 0, 'protected android assets must be non-empty');
  assert.equal(current.count, INITIAL_PROTECTED_ASSETS.count, 'protected asset count must remain unchanged during test execution');
  assert.equal(current.hash, INITIAL_PROTECTED_ASSETS.hash, 'protected asset SHA-256 combined digest must remain identical throughout test execution');
});

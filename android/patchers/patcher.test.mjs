// Unit Verification Suite for Android Native Patch Engine.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAxml, serializeAxml, patchManifest, KNOWN_RES_IDS, ANDROID_NS } from './manifest.mjs';
import { injectCompanionDex, getNextDexName, loadDefaultCompanionDex } from './dex.mjs';
import { synthesizeHermesBytecode, loadGatewayTemplateMetadata, suppressExpoUpdates } from './hermes.mjs';
import {
  createEntry,
  writeZip,
  readZip,
  entryBytes,
  createSigningIdentity,
  signApk,
  verifyApk,
  findEnd
} from './signing.mjs';
import { runPatchPipeline } from '../release/patch-android.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_APK = path.join(REPO_ROOT, 'android/bin/rokbot-native-base.apk');

test('AXML: parse and round-trip serialize AndroidManifest.xml', () => {
  const apkBytes = fs.readFileSync(FIXTURE_APK);
  const { entries } = readZip(apkBytes);
  const manifestEntry = entries.find(e => e.name === 'AndroidManifest.xml');
  const originalBytes = entryBytes(manifestEntry);

  const ast = parseAxml(originalBytes);
  assert.ok(ast.rootNodes.length > 0);
  assert.equal(ast.rootNodes[0].name, 'manifest');

  const reSerialized = serializeAxml(ast);
  assert.ok(reSerialized.length > 0);
  const reParsed = parseAxml(reSerialized);
  assert.equal(reParsed.rootNodes[0].name, 'manifest');
});

test('AXML: patchManifest injects usesCleartextTraffic, PairingActivity, NotificationService, and permissions', () => {
  const apkBytes = fs.readFileSync(FIXTURE_APK);
  const { entries } = readZip(apkBytes);
  const originalBytes = entryBytes(entries.find(e => e.name === 'AndroidManifest.xml'));

  const patched = patchManifest(originalBytes, {
    pairingActivity: 'dev.rokbot.nativeapp.PairingActivity',
    notificationService: 'dev.rokbot.nativeapp.NotificationService',
    permissions: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.RECORD_AUDIO',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.WAKE_LOCK'
    ]
  });

  const parsed = parseAxml(patched);
  const manifest = parsed.rootNodes.find(n => n.name === 'manifest');
  const app = manifest.children.find(n => n.name === 'application');

  // Verify usesCleartextTraffic
  const cleartext = app.attributes.find(a => a.name === 'usesCleartextTraffic');
  assert.ok(cleartext, 'usesCleartextTraffic attribute must exist');
  assert.equal(cleartext.value, true);

  // Android ignores attributes that are out of resource-ID order (live emulator: "Cleartext HTTP traffic
  // not permitted" because usesCleartextTraffic was appended after enableOnBackInvokedCallback).
  const walk = (node) => {
    const ids = (node.attributes || []).map(a => a.resourceId >>> 0).filter(Boolean);
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i - 1] < ids[i], `<${node.name}> attributes must be sorted by resource ID (0x${ids[i - 1].toString(16)} before 0x${ids[i].toString(16)})`);
    }
    const firstPlain = (node.attributes || []).findIndex(a => !a.resourceId);
    if (firstPlain >= 0) {
      assert.ok((node.attributes || []).slice(firstPlain).every(a => !a.resourceId), `<${node.name}> resource-ID attributes must precede plain ones`);
    }
    for (const child of node.children || []) walk(child);
  };
  walk(manifest);
  const cleartextIdx = app.attributes.indexOf(cleartext);
  assert.ok(app.attributes[cleartextIdx - 1].resourceId < KNOWN_RES_IDS.usesCleartextTraffic);
  // Verify PairingActivity
  const hasPairing = app.children.some(
    c => c.name === 'activity' && c.attributes.some(a => a.name === 'name' && a.value === 'dev.rokbot.nativeapp.PairingActivity')
  );
  assert.ok(hasPairing, 'PairingActivity must be registered');

  // Verify NotificationService
  const hasNotif = app.children.some(
    c => c.name === 'service' && c.attributes.some(a => a.name === 'name' && a.value === 'dev.rokbot.nativeapp.NotificationService')
  );
  assert.ok(hasNotif, 'NotificationService must be registered');

  // Verify DATA_SYNC permission
  const hasDataSync = manifest.children.some(
    c => c.name === 'uses-permission' && c.attributes.some(a => a.name === 'name' && a.value === 'android.permission.FOREGROUND_SERVICE_DATA_SYNC')
  );
  assert.ok(hasDataSync, 'FOREGROUND_SERVICE_DATA_SYNC permission must be registered');
});

test('DEX: getNextDexName identifies next index in classes sequence', () => {
  assert.equal(getNextDexName([]), 'classes.dex');
  assert.equal(getNextDexName(['classes.dex']), 'classes2.dex');
  assert.equal(getNextDexName(['classes.dex', 'classes2.dex']), 'classes3.dex');
  assert.equal(getNextDexName(['classes.dex', 'classes2.dex', 'classes3.dex']), 'classes4.dex');
});

test('DEX: injectCompanionDex merges valid companion dex', () => {
  const companionDex = loadDefaultCompanionDex();
  assert.ok(companionDex.length > 0);

  const initialEntries = [
    createEntry('classes.dex', Buffer.from('dex\n035\0header'), { store: false }),
  ];

  const res = injectCompanionDex(initialEntries, companionDex);
  assert.equal(res.injectedName, 'classes2.dex');
  assert.equal(res.entries.length, 2);
  assert.ok(res.entries.some(e => e.name === 'classes2.dex'));
});

test('Hermes: synthesizeHermesBytecode encodes opcodes, body and valid SHA-1 footer', () => {
  const meta = loadGatewayTemplateMetadata();
  // Create dummy bundle with capacity
  const bundle = Buffer.alloc(Math.max(meta.bodyOffset + meta.bodyCapacity, meta.bodyLengthOffset + 4) + 100);
  const url = 'http://192.168.1.100:18080';
  const token = 'K7M9P2';

  const patched = synthesizeHermesBytecode(bundle, meta, url, token);
  assert.equal(patched.length, bundle.length);

  // Check body length written
  const bodyLen = patched.readUInt32LE(meta.bodyLengthOffset);
  assert.ok(bodyLen > 0 && bodyLen <= meta.bodyCapacity);

  // Check SHA-1
  const expectedSha1 = crypto.createHash('sha1').update(patched.subarray(0, patched.length - 20)).digest();
  assert.ok(expectedSha1.equals(patched.subarray(patched.length - 20)));
});

test('Hermes: suppressExpoUpdates strips OTA configs', () => {
  const orig = {
    updates: {
      enabled: true,
      url: 'https://u.expo.dev/test',
      checkOnLaunch: 'ALWAYS'
    }
  };
  const suppressed = suppressExpoUpdates(orig);
  assert.equal(suppressed.updates.enabled, false);
  assert.equal(suppressed.updates.checkOnLaunch, 'NEVER');
  assert.equal(suppressed.updates.url, undefined);
});

test('Signing: writeZip aligns .so to 16KB and data to 4B', () => {
  const entries = [
    createEntry('classes.dex', Buffer.from('test dex data'), { store: false }),
    createEntry('lib/arm64-v8a/libnative.so', Buffer.from('test native library'), { store: true }),
    createEntry('assets/data.bin', Buffer.from('test asset data'), { store: false }),
  ];

  const zipBuf = writeZip(entries);
  const zip = readZip(zipBuf);

  const soEntry = zip.entries.find(e => e.name.endsWith('.so'));
  assert.ok(soEntry);
  assert.equal(soEntry.dataStart % 16384, 0, '.so dataStart must be 16KB aligned');
});

test('Signing: createSigningIdentity supports RSA 2048 and signApk produces valid v2/v3 signatures', () => {
  const entries = [
    createEntry('AndroidManifest.xml', Buffer.from('dummy manifest'), { store: true }),
    createEntry('classes.dex', Buffer.from('dummy dex'), { store: false }),
  ];

  const unsigned = writeZip(entries);
  const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
  const signed = signApk(unsigned, identity, { schemes: ['v2', 'v3'], minSdk: 28 });

  const result = verifyApk(signed);
  assert.equal(result.verified, true);
  assert.equal(result.hasV2, true);
  assert.equal(result.hasV3, true);
  assert.ok(result.certificate);
});

test('Pipeline: runPatchPipeline end-to-end creates patched APK and patch-report.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-patcher-e2e-'));
  const tmpOut = path.join(tmpDir, 'rokbot-test-out.apk');
  try {
    const report = await runPatchPipeline({
      inputApk: FIXTURE_APK,
      outputApk: tmpOut,
      host: 'http://127.0.0.1:18080',
      pairingCode: 'K7M9P2',
      devSigning: true,
      force: true,
      verbose: false
    });

    assert.ok(fs.existsSync(tmpOut));
    assert.equal(report.manifestPatched, true);
    assert.equal(report.dexInjected, 'classes2.dex');
    assert.equal(report.bundlePatched, false);
    assert.equal(report.expoUpdatesDisabled, true);
    assert.equal(report.cleartextTrafficAllowed, true);
    assert.equal(report.devSigning, true);
    assert.match(report.signingCertificateSha256, /^[0-9a-f]{64}$/);
    assert.equal(report.signingVerification?.verified, true);

    const reportFile = path.join(path.dirname(tmpOut), 'patch-report.json');
    assert.ok(fs.existsSync(reportFile));

    // Verify output APK validity
    const signedBytes = fs.readFileSync(tmpOut);
    const verifyResult = verifyApk(signedBytes);
    assert.equal(verifyResult.verified, true);
    assert.equal(verifyResult.hasV3, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Pipeline: runPatchPipeline accurately sets bundlePatched: true when assets/index.android.bundle is present', async () => {
  const meta = loadGatewayTemplateMetadata();
  const dummyBundle = Buffer.alloc(Math.max(meta.bodyOffset + meta.bodyCapacity, meta.bodyLengthOffset + 4) + 100);
  const apkBytes = fs.readFileSync(FIXTURE_APK);
  const { entries } = readZip(apkBytes);
  entries.push(createEntry('assets/index.android.bundle', dummyBundle, { store: false }));
  const inputWithBundle = writeZip(entries);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-patcher-bundle-'));
  const tmpIn = path.join(tmpDir, 'rokbot-bundle-in.apk');
  const tmpOut = path.join(tmpDir, 'rokbot-bundle-out.apk');
  try {
    fs.writeFileSync(tmpIn, inputWithBundle);
    const report = await runPatchPipeline({
      inputApk: tmpIn,
      outputApk: tmpOut,
      host: 'http://127.0.0.1:18080',
      pairingCode: 'K7M9P2',
      devSigning: true,
      force: true,
      verbose: false
    });
    assert.equal(report.bundlePatched, true, 'bundlePatched must be true when bundle is present');
    assert.equal(report.devSigning, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

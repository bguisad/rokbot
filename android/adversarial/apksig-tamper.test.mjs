// Adversarial Test Harness: APK Signature Scheme v2/v3 Verification & Tampering Hardening
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createEntry,
  writeZip,
  createSigningIdentity,
  signApk,
  verifyApk,
  findEnd
} from '../patchers/signing.mjs';

const APKSIGNER_BIN = '/Users/lianqishi/Library/Android/sdk/build-tools/36.0.0/apksigner';

function runApksignerVerify(apkPath, { minSdk = 24, maxSdk = 35 } = {}) {
  try {
    const cmd = `${APKSIGNER_BIN} verify -v --min-sdk-version ${minSdk} --max-sdk-version ${maxSdk} ${apkPath}`;
    const output = execSync(cmd, { stdio: 'pipe' }).toString();
    return { ok: true, output };
  } catch (err) {
    return {
      ok: false,
      output: err.stdout?.toString() || err.message,
      stderr: err.stderr?.toString()
    };
  }
}

function createTestSignedApk({ schemes = ['v2', 'v3'], minSdk = 24 } = {}) {
  const entries = [
    createEntry('AndroidManifest.xml', Buffer.from('<manifest package="ai.x.grok.bot"/>'), { store: true }),
    createEntry('classes.dex', Buffer.from('dex\n038\0' + 'x'.repeat(100)), { store: false }),
    createEntry('lib/arm64-v8a/libtest.so', Buffer.from('ELF binary content'), { store: true }),
  ];
  const unsigned = writeZip(entries);
  const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
  return signApk(unsigned, identity, { schemes, minSdk });
}

test('APK Signer: Verifies across Android API levels 24 through 35 with official apksigner', () => {
  const apkBytes = createTestSignedApk({ schemes: ['v2', 'v3'], minSdk: 24 });
  const tmpApk = path.join(os.tmpdir(), `test-sig-matrix-${Date.now()}.apk`);
  fs.writeFileSync(tmpApk, apkBytes);

  try {
    const testSdks = [24, 26, 28, 29, 30, 31, 33, 34, 35];
    for (const sdk of testSdks) {
      const res = runApksignerVerify(tmpApk, { minSdk: sdk, maxSdk: 35 });
      assert.ok(res.ok, `apksigner failed for minSdk ${sdk}: ${res.output} ${res.stderr}`);
      assert.match(res.output, /Verifies/);
    }
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('APK Signer Tampering: Rejects modified ZIP content entry after signing', () => {
  const apkBytes = createTestSignedApk();
  // Tamper: flip 1 byte at offset 50 (inside local file header / entry data)
  const tampered = Buffer.from(apkBytes);
  tampered[50] ^= 0xff;

  const tmpApk = path.join(os.tmpdir(), `test-tamper-content-${Date.now()}.apk`);
  fs.writeFileSync(tmpApk, tampered);

  try {
    // 1. In-engine verification must reject
    assert.throws(
      () => verifyApk(tampered),
      /APK contents do not match the signature/
    );

    // 2. Official Android SDK apksigner must reject
    const res = runApksignerVerify(tmpApk);
    assert.equal(res.ok, false, 'apksigner must reject tampered content');
    assert.match(res.output + res.stderr, /DOES NOT VERIFY|digest.*mismatch|failed/i);
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('APK Signer Tampering: Rejects corrupted ZIP central directory after signing', () => {
  const apkBytes = createTestSignedApk();
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);

  // Tamper: flip 1 byte inside central directory
  const tampered = Buffer.from(apkBytes);
  tampered[centralOffset + 10] ^= 0x5a;

  const tmpApk = path.join(os.tmpdir(), `test-tamper-cd-${Date.now()}.apk`);
  fs.writeFileSync(tmpApk, tampered);

  try {
    // 1. In-engine verification must reject
    assert.throws(() => verifyApk(tampered));

    // 2. Official Android SDK apksigner must reject
    const res = runApksignerVerify(tmpApk);
    assert.equal(res.ok, false, 'apksigner must reject tampered central directory');
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('APK Signer Tampering: Rejects corrupted cryptographic signature in v2 block', () => {
  const apkBytes = createTestSignedApk({ schemes: ['v2'], minSdk: 24 });
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);
  const size = Number(apkBytes.readBigUInt64LE(centralOffset - 24));
  const blockStart = centralOffset - size - 8;

  // Corrupt 1 bit inside v2 block
  const tampered = Buffer.from(apkBytes);
  tampered[blockStart + 50] ^= 0x01;

  const tmpApk = path.join(os.tmpdir(), `test-tamper-v2-${Date.now()}.apk`);
  fs.writeFileSync(tmpApk, tampered);

  try {
    // 1. In-engine verification must reject
    assert.throws(
      () => verifyApk(tampered),
      /APK signature does not verify/
    );

    // 2. Official Android SDK apksigner must reject
    const res = runApksignerVerify(tmpApk);
    assert.equal(res.ok, false, 'apksigner must reject tampered v2 signature');
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('APK Signer Hardening: verifyApk validates both v2 and v3 signatures and rejects corrupted v3 block', () => {
  const apkBytes = createTestSignedApk({ schemes: ['v2', 'v3'], minSdk: 24 });
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);

  // Corrupt v3 block located near centralOffset - 100
  const tampered = Buffer.from(apkBytes);
  tampered[centralOffset - 100] ^= 0x01;

  // 1. In-engine verifyApk must reject corrupted v3 block
  assert.throws(
    () => verifyApk(tampered),
    /APK signature does not verify|APK contents do not match the signature/
  );

  // 2. Official Android SDK apksigner rejects with DOES NOT VERIFY
  const tmpApk = path.join(os.tmpdir(), `test-tamper-v3-${Date.now()}.apk`);
  fs.writeFileSync(tmpApk, tampered);
  try {
    const res = runApksignerVerify(tmpApk, { minSdk: 28, maxSdk: 35 });
    assert.equal(res.ok, false, 'Official apksigner rejects APK with corrupted v3 signature');
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('APK Signer Tampering: Rejects corrupted APK Signing Block Magic header', () => {
  const apkBytes = createTestSignedApk();
  const end = findEnd(apkBytes);
  const centralOffset = apkBytes.readUInt32LE(end + 16);

  // Tamper the 16-byte magic: 'APK Sig Block 42'
  const tampered = Buffer.from(apkBytes);
  tampered[centralOffset - 5] ^= 0xff;

  const tmpApk = path.join(os.tmpdir(), `test-tamper-magic-${Date.now()}.apk`);
  fs.writeFileSync(tmpApk, tampered);

  try {
    // 1. In-engine verification must reject
    assert.throws(
      () => verifyApk(tampered),
      /No APK Signing Block/
    );

    // 2. Official Android SDK apksigner must reject
    const res = runApksignerVerify(tmpApk);
    assert.equal(res.ok, false, 'apksigner must reject corrupt magic');
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

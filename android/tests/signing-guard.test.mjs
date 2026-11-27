// Tests for Android release signing pin & guard (prevents silent key regeneration or wrong cert signing).
// All tests use temporary keys and fake HOME directories; never reads or touches ~/.rokbot-local/android-signing.json.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSigningIdentity, signApk, verifyApk } from '../patchers/signing.mjs';
import {
  RELEASE_CERTIFICATE_SHA256,
  SIGNING_PIN_PATH,
  assertSignedApkCertificate,
  computeCertificateSha256,
  findApksigner,
  loadSigningPin,
  resolveReleaseSigningIdentity,
} from '../release/signing-guard.mjs';
import { parseCliArgs, runPatchPipeline } from '../release/patch-android.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const FIXTURE_APK = path.join(ROOT_DIR, 'android/bin/rokbot-native-base.apk');
const PATCH_CLI = path.join(__dirname, '../release/patch-android.mjs');
const EXPECTED_RELEASE_SHA256 = '46214d3d1737ebdf1c0cde3ba29671f5ae057c87570e29daaa74da6558e9fe79';

function writeTempKeystore(keystorePath, identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 })) {
  const payload = {
    schema: 'rokbot-android-signing/v1',
    createdAt: new Date().toISOString(),
    privateKey: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certificate: identity.certificate.toString('base64'),
  };
  fs.mkdirSync(path.dirname(keystorePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keystorePath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  return {
    identity,
    certificateSha256: computeCertificateSha256(identity.certificate),
  };
}

function runPatchCli(args, envOverrides = {}) {
  const env = { ...process.env };
  delete env.ROKBOT_ANDROID_DEV_SIGNING;
  Object.assign(env, envOverrides);
  return cp.spawnSync(process.execPath, [PATCH_CLI, ...args], { encoding: 'utf8', env });
}

test('Signing pin: android/release/signing-pin.json pins the official release certificate SHA-256', () => {
  assert.ok(fs.existsSync(SIGNING_PIN_PATH), 'signing-pin.json must exist');
  const pin = loadSigningPin();
  assert.equal(pin.releaseCertificateSha256, EXPECTED_RELEASE_SHA256);
  assert.equal(RELEASE_CERTIFICATE_SHA256, EXPECTED_RELEASE_SHA256);
  assert.equal(parseCliArgs(['--dev-signing']).devSigning, true);
  assert.equal(parseCliArgs([]).devSigning, undefined);
});

test('Signing guard (release mode): missing keystore fails closed without auto-generating a key', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-signguard-missing-'));
  try {
    const missingKeystore = path.join(tmpDir, 'nonexistent', 'android-signing.json');
    const outApk = path.join(tmpDir, 'out.apk');

    // 1. Direct pipeline call with explicit nonexistent --keystore
    await assert.rejects(
      () => runPatchPipeline({
        inputApk: FIXTURE_APK,
        outputApk: outApk,
        keystore: missingKeystore,
        force: true,
      }),
      err => {
        assert.match(err.message, new RegExp(EXPECTED_RELEASE_SHA256));
        assert.match(err.message, /missing/i);
        assert.ok(err.message.includes(missingKeystore), 'error must include keystore path');
        assert.match(err.message, /mini/i);
        assert.match(err.message, /~\/\.rokbot-local\/android-signing\.json/);
        assert.match(err.message, /--dev-signing/);
        assert.match(err.message, /ROKBOT_ANDROID_DEV_SIGNING=1/);
        return true;
      },
    );
    assert.equal(fs.existsSync(missingKeystore), false, 'missing keystore must NEVER be auto-created in release mode');
    assert.equal(fs.existsSync(outApk), false, 'output APK must NOT be written when keystore is missing');

    // 2. CLI invocation with isolated fake HOME (tests default ~/.rokbot-local/android-signing.json path safely)
    const fakeHome = path.join(tmpDir, 'fake-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    const defaultKeystore = path.join(fakeHome, '.rokbot-local', 'android-signing.json');
    const cliRes = runPatchCli(
      ['--input-apk', FIXTURE_APK, '--output-apk', outApk, '--force'],
      { HOME: fakeHome, USERPROFILE: fakeHome },
    );
    assert.equal(cliRes.status, 1, 'CLI must exit non-zero when default release keystore is missing');
    assert.ok(cliRes.stderr.includes(EXPECTED_RELEASE_SHA256), 'stderr must print expected fingerprint');
    assert.ok(cliRes.stderr.includes(defaultKeystore), 'stderr must print default keystore path');
    assert.match(cliRes.stderr, /mini/i);
    assert.equal(fs.existsSync(defaultKeystore), false, 'default ~/.rokbot-local/android-signing.json must NOT be auto-created');
    assert.equal(fs.existsSync(outApk), false, 'output APK must NOT be written');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Signing guard (release mode): wrong certificate fingerprint fails closed with clear diagnostics', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-signguard-mismatch-'));
  try {
    const wrongKeystore = path.join(tmpDir, 'wrong-android-signing.json');
    const outApk = path.join(tmpDir, 'out.apk');
    const { certificateSha256: wrongSha } = writeTempKeystore(wrongKeystore);
    assert.notEqual(wrongSha, EXPECTED_RELEASE_SHA256);

    // 1. Direct pipeline call
    await assert.rejects(
      () => runPatchPipeline({
        inputApk: FIXTURE_APK,
        outputApk: outApk,
        keystore: wrongKeystore,
        force: true,
      }),
      err => {
        assert.ok(err.message.includes(EXPECTED_RELEASE_SHA256), 'error must include expected release fingerprint');
        assert.ok(err.message.includes(wrongSha), 'error must include actual wrong fingerprint');
        assert.ok(err.message.includes(wrongKeystore), 'error must include keystore path');
        assert.match(err.message, /mini/i);
        assert.match(err.message, /~\/\.rokbot-local\/android-signing\.json/);
        return true;
      },
    );
    assert.equal(fs.existsSync(outApk), false, 'output APK must NOT be written on fingerprint mismatch');

    // 2. CLI invocation
    const cliRes = runPatchCli([
      '--input-apk', FIXTURE_APK,
      '--output-apk', outApk,
      '--keystore', wrongKeystore,
      '--force',
    ]);
    assert.equal(cliRes.status, 1, 'CLI must exit non-zero on fingerprint mismatch');
    assert.ok(cliRes.stderr.includes(EXPECTED_RELEASE_SHA256));
    assert.ok(cliRes.stderr.includes(wrongSha));
    assert.ok(cliRes.stderr.includes(wrongKeystore));
    assert.match(cliRes.stderr, /mini/i);
    assert.equal(fs.existsSync(outApk), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Signing guard (dev mode): --dev-signing and ROKBOT_ANDROID_DEV_SIGNING=1 allow temp signing with warning and report flags', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-signguard-dev-'));
  try {
    const fakeHome = path.join(tmpDir, 'fake-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    const fakeDefaultKeystore = path.join(fakeHome, '.rokbot-local', 'android-signing.json');

    // 1. CLI with --dev-signing and NO --keystore => ephemeral in-memory key, never touches default keystore path
    const out1Dir = path.join(tmpDir, 'ephemeral');
    const out1 = path.join(out1Dir, 'dev-ephemeral.apk');
    const res1 = runPatchCli(
      ['--input-apk', FIXTURE_APK, '--output-apk', out1, '--dev-signing', '--force'],
      { HOME: fakeHome, USERPROFILE: fakeHome },
    );
    assert.equal(res1.status, 0, `expected exit 0, got stderr: ${res1.stderr}`);
    assert.match(res1.stderr, /WARNING: ANDROID DEV SIGNING MODE ENABLED/);
    assert.equal(fs.existsSync(fakeDefaultKeystore), false, 'ephemeral --dev-signing must NOT create ~/.rokbot-local/android-signing.json');

    const report1 = JSON.parse(fs.readFileSync(path.join(out1Dir, 'patch-report.json'), 'utf8'));
    const verified1 = verifyApk(fs.readFileSync(out1));
    const apkCertSha1 = computeCertificateSha256(verified1.certificate.raw);
    assert.equal(report1.devSigning, true);
    assert.equal(report1.keystorePath, null);
    assert.equal(report1.signingCertificateSha256, apkCertSha1);
    assert.equal(report1.signingVerification?.verified, true);
    assert.equal(report1.signingVerification?.certificateSha256, apkCertSha1);
    assert.equal(report1.signingVerification?.matchesReleasePin, false);
    if (findApksigner()) {
      assert.equal(report1.signingVerification?.verifier, 'apksigner+builtin');
    }

    // 2. CLI with ROKBOT_ANDROID_DEV_SIGNING=1 and explicit temp --keystore => auto-generates and reuses temp keystore
    const devKeystore = path.join(tmpDir, 'dev-keystore.json');
    const out2Dir = path.join(tmpDir, 'env-dev');
    const out2 = path.join(out2Dir, 'dev-env.apk');
    const res2 = runPatchCli(
      ['--input-apk', FIXTURE_APK, '--output-apk', out2, '--keystore', devKeystore, '--force'],
      { HOME: fakeHome, USERPROFILE: fakeHome, ROKBOT_ANDROID_DEV_SIGNING: '1' },
    );
    assert.equal(res2.status, 0, `expected exit 0, got stderr: ${res2.stderr}`);
    assert.match(res2.stderr, /WARNING: ANDROID DEV SIGNING MODE ENABLED/);
    assert.ok(fs.existsSync(devKeystore), 'explicit dev keystore should be created');
    const report2 = JSON.parse(fs.readFileSync(path.join(out2Dir, 'patch-report.json'), 'utf8'));
    assert.equal(report2.devSigning, true);
    assert.equal(report2.keystorePath, devKeystore);
    assert.match(report2.signingCertificateSha256, /^[0-9a-f]{64}$/);

    // 3. Even in dev mode, refuse to auto-generate at the default production keystore path ~/.rokbot-local/android-signing.json
    assert.throws(
      () => resolveReleaseSigningIdentity({
        keystorePath: fakeDefaultKeystore,
        devSigning: true,
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      }),
      /Refusing to auto-generate a dev signing key at the default release keystore path/,
    );
    assert.equal(fs.existsSync(fakeDefaultKeystore), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Signing guard (release happy path & post-sign verification): matching pin records cert SHA-256 and verifies APK', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-signguard-release-ok-'));
  try {
    const ksPath = path.join(tmpDir, 'temp-release-sim.json');
    const { certificateSha256: simReleaseSha } = writeTempKeystore(ksPath);
    const outDir = path.join(tmpDir, 'release-out');
    const outApk = path.join(outDir, 'release.apk');

    const report = await runPatchPipeline({
      inputApk: FIXTURE_APK,
      outputApk: outApk,
      keystore: ksPath,
      expectedCertificateSha256: simReleaseSha,
      devSigning: false,
      force: true,
    });

    assert.equal(report.devSigning, false);
    assert.equal(report.signingCertificateSha256, simReleaseSha);
    assert.equal(report.signingVerification?.verified, true);
    assert.equal(report.signingVerification?.certificateSha256, simReleaseSha);
    assert.equal(report.signingVerification?.matchesReleasePin, true);

    const diskReport = JSON.parse(fs.readFileSync(path.join(outDir, 'patch-report.json'), 'utf8'));
    assert.equal(diskReport.devSigning, false);
    assert.equal(diskReport.signingCertificateSha256, simReleaseSha);

    // Post-sign verification rejects when checked against the real release pin (different cert)
    assert.throws(
      () => assertSignedApkCertificate({
        apkPath: outApk,
        enforceReleasePin: true,
        minSdk: 28,
        keystorePath: ksPath,
      }),
      err => {
        assert.ok(err.message.includes(EXPECTED_RELEASE_SHA256));
        assert.ok(err.message.includes(simReleaseSha));
        return true;
      },
    );

    // Built-in fallback path (apksignerBin: null) still verifies signature and cert fingerprint
    const builtinRes = assertSignedApkCertificate({
      apkPath: outApk,
      expectedCertificateSha256: simReleaseSha,
      releaseCertificateSha256: simReleaseSha,
      enforceReleasePin: true,
      apksignerBin: null,
      minSdk: 28,
    });
    assert.equal(builtinRes.verified, true);
    assert.equal(builtinRes.verifier, 'builtin');
    assert.equal(builtinRes.certificateSha256, simReleaseSha);
    assert.equal(builtinRes.matchesReleasePin, true);

    // If apksigner is installed on this host, verify apksigner+builtin ran cleanly
    const apksignerPath = findApksigner();
    if (apksignerPath) {
      assert.equal(report.signingVerification?.verifier, 'apksigner+builtin');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { generateDelta, applyDelta, DELTA_MAGIC, LEGACY_DELTA_MAGIC, sha256Hex } from '../release/delta-update.mjs';
import { parseAxml, patchManifest } from '../patchers/manifest.mjs';
import { writeZip, createEntry } from '../patchers/signing.mjs';

function makeSyntheticZip(entries) {
  return writeZip(entries.map(([name, content, store]) => createEntry(name, Buffer.from(content), { store })));
}

test('RBDELTA1: ZIP-entry-aware delta emits RBDELTA1 magic and handles shifted large payloads with high savings and exact reconstruction', () => {
  const bigLib = crypto.randomBytes(512 * 1024); // 512 KB incompressible native lib
  const bigAsset = crypto.randomBytes(256 * 1024); // 256 KB incompressible asset
  const baseApk = makeSyntheticZip([
    ['AndroidManifest.xml', 'manifest-v1', false],
    ['classes2.dex', Buffer.alloc(40000, 0x41), false],
    ['lib/arm64-v8a/libnative.so', bigLib, true],
    ['assets/index.android.bundle', bigAsset, true],
  ]);

  // Change classes2.dex length (shifts all subsequent ZIP entries by +1337 bytes!)
  const newDex = Buffer.alloc(41337, 0x42);
  const targetApk = makeSyntheticZip([
    ['AndroidManifest.xml', 'manifest-v2-updated', false],
    ['classes2.dex', newDex, false],
    ['lib/arm64-v8a/libnative.so', bigLib, true],
    ['assets/index.android.bundle', bigAsset, true],
  ]);

  const delta = generateDelta(baseApk, targetApk);
  assert.ok(delta.length < targetApk.length * 0.1, `Expected delta (${delta.length}) to be <10% of target (${targetApk.length})`);
  assert.ok(zlib.gunzipSync(delta).subarray(0, 8).equals(DELTA_MAGIC), 'generateDelta() must emit RBDELTA1 magic');

  const reconstructed = applyDelta(baseApk, delta);
  assert.equal(sha256Hex(reconstructed), sha256Hex(targetApk));
  assert.equal(reconstructed.length, targetApk.length);
});

test('RBDELTA1: rejects base size mismatch, bad magic, and truncated streams', () => {
  const base = crypto.randomBytes(16384);
  const target = Buffer.concat([base.subarray(0, 8192), crypto.randomBytes(4096), base.subarray(8192)]);
  const delta = generateDelta(base, target);

  assert.throws(() => applyDelta(base.subarray(0, 1000), delta), /Base size mismatch/);
  assert.throws(() => applyDelta(base, Buffer.from('not-gzip')), /.+/);
  const badMagicRaw = zlib.gunzipSync(delta);
  Buffer.from('XXDELTA1', 'ascii').copy(badMagicRaw, 0);
  assert.throws(() => applyDelta(base, zlib.gzipSync(badMagicRaw)), /Invalid delta magic header/);

  const valid = applyDelta(base, delta);
  assert.equal(sha256Hex(valid), sha256Hex(target));
});

test('RBDELTA1 cross-language & GBDELTA1 compat: Node.js applyDelta() and Android DeltaPatcher.java support both RBDELTA1 and legacy GBDELTA1', () => {
  const javac = fs.existsSync('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac')
    ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac'
    : 'javac';
  const java = fs.existsSync('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java')
    ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java'
    : 'java';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-delta-jvm-'));
  try {
    const bigPayload = crypto.randomBytes(196 * 1024);
    const baseApk = makeSyntheticZip([
      ['classes2.dex', crypto.randomBytes(8192), false],
      ['lib/arm64-v8a/libtest.so', bigPayload, true],
    ]);
    const targetApk = makeSyntheticZip([
      ['classes2.dex', crypto.randomBytes(9777), false],
      ['lib/arm64-v8a/libtest.so', bigPayload, true],
    ]);
    const delta = generateDelta(baseApk, targetApk);
    const legacyRaw = zlib.gunzipSync(delta);
    LEGACY_DELTA_MAGIC.copy(legacyRaw, 0);
    const legacyDelta = zlib.gzipSync(legacyRaw);

    // Node backward read-compat for legacy GBDELTA1
    const nodeLegacyOut = applyDelta(baseApk, legacyDelta);
    assert.equal(sha256Hex(nodeLegacyOut), sha256Hex(targetApk));

    const basePath = path.join(tmpDir, 'base.apk');
    const deltaPath = path.join(tmpDir, 'patch.rbdelta');
    const legacyDeltaPath = path.join(tmpDir, 'legacy.gbdelta');
    const badDeltaPath = path.join(tmpDir, 'bad.rbdelta');
    const outPath = path.join(tmpDir, 'reconstructed.apk');
    const legacyOutPath = path.join(tmpDir, 'reconstructed-legacy.apk');
    fs.writeFileSync(basePath, baseApk);
    fs.writeFileSync(deltaPath, delta);
    fs.writeFileSync(legacyDeltaPath, legacyDelta);
    const badRaw = zlib.gunzipSync(delta);
    Buffer.from('XXDELTA1', 'ascii').copy(badRaw, 0);
    fs.writeFileSync(badDeltaPath, zlib.gzipSync(badRaw));

    const deltaJavaSrc = path.resolve('android/companion/src/main/java/dev/rokbot/nativeapp/DeltaPatcher.java');
    const runnerSrc = path.join(tmpDir, 'RunDelta.java');
    fs.writeFileSync(runnerSrc, `
import dev.rokbot.nativeapp.DeltaPatcher;
import java.io.File;
import java.io.IOException;
public class RunDelta {
  public static void main(String[] args) throws Exception {
    DeltaPatcher.apply(new File(args[0]), new File(args[1]), new File(args[2]), null);
    DeltaPatcher.apply(new File(args[0]), new File(args[3]), new File(args[4]), null);
    try {
      DeltaPatcher.apply(new File(args[0]), new File(args[5]), new File(args[4] + ".bad"), null);
      throw new AssertionError("Expected IOException for bad magic");
    } catch (IOException expected) {}
  }
}
`);
    execFileSync(javac, ['--release', '17', '-d', tmpDir, deltaJavaSrc, runnerSrc], { stdio: 'pipe' });
    execFileSync(java, ['-cp', tmpDir, 'RunDelta', basePath, deltaPath, outPath, legacyDeltaPath, legacyOutPath, badDeltaPath], { stdio: 'pipe' });

    const reconstructed = fs.readFileSync(outPath);
    assert.equal(sha256Hex(reconstructed), sha256Hex(targetApk));
    assert.equal(reconstructed.length, targetApk.length);
    const reconstructedLegacy = fs.readFileSync(legacyOutPath);
    assert.equal(sha256Hex(reconstructedLegacy), sha256Hex(targetApk));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Manifest: patchManifest registers ApkUpdateProvider and REQUEST_INSTALL_PACKAGES', () => {
  const sampleApk = path.resolve('android/output/rokbot-native-coexist.apk');
  if (!fs.existsSync(sampleApk)) return;
  const rawManifest = execFileSync('unzip', ['-p', sampleApk, 'AndroidManifest.xml'], { maxBuffer: 8 * 1024 * 1024 });
  const patched = patchManifest(rawManifest, { packageName: 'ai.x.grok.bot.local' });
  const ast = parseAxml(patched);
  const manifest = ast.rootNodes.find(n => n.name === 'manifest');
  const app = manifest.children.find(c => c.name === 'application');
  const updateProvider = app.children.find(
    c => c.name === 'provider' && c.attributes.some(a => a.name === 'name' && a.value === 'dev.rokbot.nativeapp.ApkUpdateProvider')
  );
  assert.ok(updateProvider, 'ApkUpdateProvider must be registered');
  assert.ok(
    updateProvider.attributes.some(a => a.name === 'authorities' && a.value === 'ai.x.grok.bot.local.rokbot.updateprovider'),
    'ApkUpdateProvider authority must use target packageName'
  );
  assert.ok(
    updateProvider.attributes.some(a => a.name === 'grantUriPermissions' && a.value === true),
    'ApkUpdateProvider must enable grantUriPermissions'
  );
  const hasReqInstall = manifest.children.some(
    c => c.name === 'uses-permission' && c.attributes.some(a => a.name === 'name' && a.value === 'android.permission.REQUEST_INSTALL_PACKAGES')
  );
  assert.ok(hasReqInstall, 'REQUEST_INSTALL_PACKAGES permission must be registered');
});

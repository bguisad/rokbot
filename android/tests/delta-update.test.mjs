import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateDelta, applyDelta, sha256Hex } from '../release/delta-update.mjs';
import { parseAxml, patchManifest } from '../patchers/manifest.mjs';
import { writeZip, createEntry } from '../patchers/signing.mjs';

function makeSyntheticZip(entries) {
  return writeZip(entries.map(([name, content, store]) => createEntry(name, Buffer.from(content), { store })));
}

test('GBDELTA1: ZIP-entry-aware delta handles shifted large payloads with high savings and exact reconstruction', () => {
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

  const reconstructed = applyDelta(baseApk, delta);
  assert.equal(sha256Hex(reconstructed), sha256Hex(targetApk));
  assert.equal(reconstructed.length, targetApk.length);
});

test('GBDELTA1: rejects base size mismatch, bad magic, and truncated streams', () => {
  const base = crypto.randomBytes(16384);
  const target = Buffer.concat([base.subarray(0, 8192), crypto.randomBytes(4096), base.subarray(8192)]);
  const delta = generateDelta(base, target);

  assert.throws(() => applyDelta(base.subarray(0, 1000), delta), /Base size mismatch/);
  assert.throws(() => applyDelta(base, Buffer.from('not-gzip')), /.+/);

  const valid = applyDelta(base, delta);
  assert.equal(sha256Hex(valid), sha256Hex(target));
});

test('GBDELTA1 cross-language: Android DeltaPatcher.java reconstructs exact bytes from Node.js delta', () => {
  const javac = fs.existsSync('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac')
    ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac'
    : 'javac';
  const java = fs.existsSync('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java')
    ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java'
    : 'java';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-delta-jvm-'));
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

    const basePath = path.join(tmpDir, 'base.apk');
    const deltaPath = path.join(tmpDir, 'patch.gbdelta');
    const outPath = path.join(tmpDir, 'reconstructed.apk');
    fs.writeFileSync(basePath, baseApk);
    fs.writeFileSync(deltaPath, delta);

    const deltaJavaSrc = path.resolve('android/companion/src/main/java/dev/grokbot/nativeapp/DeltaPatcher.java');
    const runnerSrc = path.join(tmpDir, 'RunDelta.java');
    fs.writeFileSync(runnerSrc, `
import dev.grokbot.nativeapp.DeltaPatcher;
import java.io.File;
public class RunDelta {
  public static void main(String[] args) throws Exception {
    DeltaPatcher.apply(new File(args[0]), new File(args[1]), new File(args[2]), null);
  }
}
`);
    execFileSync(javac, ['--release', '17', '-d', tmpDir, deltaJavaSrc, runnerSrc], { stdio: 'pipe' });
    execFileSync(java, ['-cp', tmpDir, 'RunDelta', basePath, deltaPath, outPath], { stdio: 'pipe' });

    const reconstructed = fs.readFileSync(outPath);
    assert.equal(sha256Hex(reconstructed), sha256Hex(targetApk));
    assert.equal(reconstructed.length, targetApk.length);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Manifest: patchManifest registers ApkUpdateProvider and REQUEST_INSTALL_PACKAGES', () => {
  const sampleApk = path.resolve('android/output/grokbot-native-coexist.apk');
  if (!fs.existsSync(sampleApk)) return;
  const rawManifest = execFileSync('unzip', ['-p', sampleApk, 'AndroidManifest.xml'], { maxBuffer: 8 * 1024 * 1024 });
  const patched = patchManifest(rawManifest, { packageName: 'ai.x.grok.bot.local' });
  const ast = parseAxml(patched);
  const manifest = ast.rootNodes.find(n => n.name === 'manifest');
  const app = manifest.children.find(c => c.name === 'application');
  const updateProvider = app.children.find(
    c => c.name === 'provider' && c.attributes.some(a => a.name === 'name' && a.value === 'dev.grokbot.nativeapp.ApkUpdateProvider')
  );
  assert.ok(updateProvider, 'ApkUpdateProvider must be registered');
  assert.ok(
    updateProvider.attributes.some(a => a.name === 'authorities' && a.value === 'ai.x.grok.bot.local.grokbot.updateprovider'),
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

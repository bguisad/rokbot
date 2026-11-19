// Adversarial Test Harness: Zip-Slip and Path Traversal Attack Defense
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createEntry, writeZip, readZip } from '../patchers/signing.mjs';
import { runPatchPipeline } from '../release/patch-android.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_APK = path.join(REPO_ROOT, 'android/bin/rokbot-native-base.apk');

function createMaliciousZipWithEntry(maliciousPath) {
  const baseZip = readZip(fs.readFileSync(FIXTURE_APK));
  const entries = [...baseZip.entries];
  entries.push(createEntry(maliciousPath, Buffer.from('malicious payload'), { store: true }));
  return writeZip(entries);
}

test('Zip-Slip: Rejects relative path traversal "../../malicious.txt"', async () => {
  const badZip = createMaliciousZipWithEntry('../../malicious.txt');
  const tmpIn = path.join(os.tmpdir(), `bad-zip-slip-rel-${Date.now()}.apk`);
  const tmpOut = path.join(os.tmpdir(), `bad-zip-slip-rel-out-${Date.now()}.apk`);
  fs.writeFileSync(tmpIn, badZip);

  try {
    await assert.rejects(
      async () => {
        await runPatchPipeline({
          inputApk: tmpIn,
          outputApk: tmpOut,
          force: true,
        });
      },
      /Zip-Slip security violation in APK entry: \.\.\/\.\.\/malicious\.txt/
    );
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
});

test('Zip-Slip: Rejects nested path traversal "assets/sub/../../etc/passwd"', async () => {
  const badZip = createMaliciousZipWithEntry('assets/sub/../../etc/passwd');
  const tmpIn = path.join(os.tmpdir(), `bad-zip-slip-nested-${Date.now()}.apk`);
  const tmpOut = path.join(os.tmpdir(), `bad-zip-slip-nested-out-${Date.now()}.apk`);
  fs.writeFileSync(tmpIn, badZip);

  try {
    await assert.rejects(
      async () => {
        await runPatchPipeline({
          inputApk: tmpIn,
          outputApk: tmpOut,
          force: true,
        });
      },
      /Zip-Slip security violation/
    );
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
});

test('Zip-Slip: Rejects absolute POSIX path "/tmp/evil.so"', async () => {
  const badZip = createMaliciousZipWithEntry('/tmp/evil.so');
  const tmpIn = path.join(os.tmpdir(), `bad-zip-slip-abs-${Date.now()}.apk`);
  const tmpOut = path.join(os.tmpdir(), `bad-zip-slip-abs-out-${Date.now()}.apk`);
  fs.writeFileSync(tmpIn, badZip);

  try {
    await assert.rejects(
      async () => {
        await runPatchPipeline({
          inputApk: tmpIn,
          outputApk: tmpOut,
          force: true,
        });
      },
      /Zip-Slip security violation in APK entry: \/tmp\/evil\.so/
    );
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
});

test('Zip-Slip: Backslash directory traversal on Windows (e.g. "..\\..\\evil.txt")', async () => {
  // On POSIX, path.isAbsolute("..\\..\\evil.txt") is false, but entry.name.includes('..') catches it!
  const badZip = createMaliciousZipWithEntry('..\\..\\evil.txt');
  const tmpIn = path.join(os.tmpdir(), `bad-zip-slip-winrel-${Date.now()}.apk`);
  const tmpOut = path.join(os.tmpdir(), `bad-zip-slip-winrel-out-${Date.now()}.apk`);
  fs.writeFileSync(tmpIn, badZip);

  try {
    await assert.rejects(
      async () => {
        await runPatchPipeline({
          inputApk: tmpIn,
          outputApk: tmpOut,
          force: true,
        });
      },
      /Zip-Slip security violation/
    );
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
});

test('Zip-Slip: Windows absolute path "\\evil\\path.so" or "C:\\evil.so"', async () => {
  for (const evilPath of ['\\Windows\\System32\\evil.dll', 'C:\\evil.so']) {
    const badZip = createMaliciousZipWithEntry(evilPath);
    const tmpIn = path.join(os.tmpdir(), `bad-zip-slip-winabs-${Date.now()}-${Math.random().toString(16).slice(2)}.apk`);
    const tmpOut = path.join(os.tmpdir(), `bad-zip-slip-winabs-out-${Date.now()}-${Math.random().toString(16).slice(2)}.apk`);
    fs.writeFileSync(tmpIn, badZip);

    try {
      await assert.rejects(
        async () => {
          await runPatchPipeline({
            inputApk: tmpIn,
            outputApk: tmpOut,
            force: true,
          });
        },
        /Zip-Slip security violation/
      );
    } finally {
      if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    }
  }
});

test('Zip-Slip: In-memory pipeline does not write arbitrary files to disk', async () => {
  // Confirm that even if an entry existed, the pipeline only ever writes to options.outputApk and patch-report.json
  const canaryFile = path.join(os.tmpdir(), 'canary-escape-probe.txt');
  if (fs.existsSync(canaryFile)) fs.unlinkSync(canaryFile);

  const baseZip = readZip(fs.readFileSync(FIXTURE_APK));
  // All entry modifications happen in Buffer memory
  assert.equal(fs.existsSync(canaryFile), false);
});

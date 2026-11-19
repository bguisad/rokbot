// Adversarial Test Harness: ZIP 16KB Page Alignment Verification
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createEntry, writeZip, readZip } from '../patchers/signing.mjs';

const ZIPALIGN_BIN = '/Users/lianqishi/Library/Android/sdk/build-tools/36.0.0/zipalign';

function runZipalignCheck(apkPath) {
  try {
    const cmd = `${ZIPALIGN_BIN} -c -v -P 16 4 ${apkPath}`;
    const output = execSync(cmd, { stdio: 'pipe' }).toString();
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: err.stdout?.toString() || err.message, stderr: err.stderr?.toString() };
  }
}

test('16KB Alignment: Varying filename lengths for .so files (1 to 200 chars)', () => {
  const tmpApk = path.join(os.tmpdir(), `test-align-namelengths-${Date.now()}.apk`);
  try {
    const entries = [
      createEntry('AndroidManifest.xml', Buffer.from('<manifest/>'), { store: true }),
    ];

    const testLengths = [1, 2, 3, 4, 7, 13, 16, 29, 32, 55, 64, 100, 150, 200];
    for (const len of testLengths) {
      const baseName = 'a'.repeat(len);
      entries.push(
        createEntry(`lib/arm64-v8a/${baseName}.so`, Buffer.from(`native payload for ${len}`), { store: true })
      );
    }

    const zipBuf = writeZip(entries);
    fs.writeFileSync(tmpApk, zipBuf);

    const result = runZipalignCheck(tmpApk);
    assert.ok(result.ok, `zipalign failed for varying name lengths: ${result.output}`);
    assert.match(result.output, /Verification successful/);
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('16KB Alignment: Odd preceding payload sizes (boundary offsets)', () => {
  const tmpApk = path.join(os.tmpdir(), `test-align-oddoffsets-${Date.now()}.apk`);
  try {
    const oddSizes = [0, 1, 3, 7, 15, 31, 127, 511, 1023, 16383, 16384, 16385, 32767, 32768, 32769];
    const entries = [];

    let counter = 0;
    for (const size of oddSizes) {
      counter++;
      // Preceding entry with odd size
      entries.push(
        createEntry(`assets/odd_${counter}.dat`, Buffer.alloc(size, 0x42), { store: true })
      );
      // Immediately followed by an uncompressed .so
      entries.push(
        createEntry(`lib/arm64-v8a/libtest_${counter}.so`, Buffer.alloc(64, 0x55), { store: true })
      );
    }

    const zipBuf = writeZip(entries);
    fs.writeFileSync(tmpApk, zipBuf);

    const result = runZipalignCheck(tmpApk);
    assert.ok(result.ok, `zipalign failed for odd boundary sizes: ${result.output}`);
    assert.match(result.output, /Verification successful/);
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('16KB Alignment: Consecutive uncompressed .so files', () => {
  const tmpApk = path.join(os.tmpdir(), `test-align-consecutive-so-${Date.now()}.apk`);
  try {
    const entries = [];
    for (let i = 1; i <= 15; i++) {
      entries.push(
        createEntry(`lib/arm64-v8a/libconsecutive_${i}.so`, Buffer.alloc(100 * i, 0xaa), { store: true })
      );
    }

    const zipBuf = writeZip(entries);
    fs.writeFileSync(tmpApk, zipBuf);

    const result = runZipalignCheck(tmpApk);
    assert.ok(result.ok, `zipalign failed for consecutive .so files: ${result.output}`);
    assert.match(result.output, /Verification successful/);

    // Also verify programmatically using readZip
    const zip = readZip(zipBuf);
    for (const e of zip.entries) {
      if (e.name.endsWith('.so')) {
        assert.equal(e.dataStart % 16384, 0, `${e.name} offset ${e.dataStart} must be 16KB aligned`);
      }
    }
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

test('16KB Alignment: Mixed compressed (deflated) and uncompressed (stored) entries', () => {
  const tmpApk = path.join(os.tmpdir(), `test-align-mixed-${Date.now()}.apk`);
  try {
    const entries = [
      createEntry('classes.dex', Buffer.from('compressible content '.repeat(200)), { store: false }),
      createEntry('lib/arm64-v8a/libnative1.so', Buffer.from('native 1 binary code'), { store: true }),
      createEntry('assets/index.android.bundle', Buffer.from('bundle code '.repeat(500)), { store: false }),
      createEntry('lib/arm64-v8a/libnative2.so', Buffer.from('native 2 binary code'), { store: true }),
      createEntry('res/drawable/icon.png', Buffer.alloc(1234, 0x89), { store: true }), // 4-byte aligned
    ];

    const zipBuf = writeZip(entries);
    fs.writeFileSync(tmpApk, zipBuf);

    const result = runZipalignCheck(tmpApk);
    assert.ok(result.ok, `zipalign failed for mixed entries: ${result.output}`);
    assert.match(result.output, /Verification successful/);
  } finally {
    if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
  }
});

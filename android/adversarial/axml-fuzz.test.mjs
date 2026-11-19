// Adversarial Test Harness: AXML Fuzzing & Boundary Stress Testing
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAxml, serializeAxml, patchManifest } from '../patchers/manifest.mjs';
import { readZip, entryBytes } from '../patchers/signing.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_APK = path.join(REPO_ROOT, 'android/bin/rokbot-native-base.apk');

function getBaseAxml() {
  const apkBytes = fs.readFileSync(FIXTURE_APK);
  const { entries } = readZip(apkBytes);
  const manifestEntry = entries.find(e => e.name === 'AndroidManifest.xml');
  return entryBytes(manifestEntry);
}

test('AXML Adversarial: Rejects buffer smaller than 8 bytes', () => {
  for (let len = 0; len < 8; len++) {
    const buf = Buffer.alloc(len);
    assert.throws(() => parseAxml(buf), /AXML buffer too short/);
  }
});

test('AXML Adversarial: Rejects invalid docType or mismatched docSize', () => {
  const base = getBaseAxml();
  
  // Corrupt docType
  const badType = Buffer.from(base);
  badType.writeUInt16LE(0x1234, 0);
  assert.throws(() => parseAxml(badType), /Not a valid AXML binary document/);

  // Corrupt docSize
  const badSize = Buffer.from(base);
  badSize.writeUInt32LE(badSize.length + 10, 4);
  assert.throws(() => parseAxml(badSize), /Not a valid AXML binary document/);
});

test('AXML Adversarial: Zero chunkSize causes infinite loop (DoS probe)', async () => {
  // We craft an AXML doc with a chunk header that has chunkSize = 0.
  // We execute parseAxml in an isolated worker with a 1500ms timeout to prove hang.
  const workerCode = `
    import { parseAxml } from '${path.resolve(__dirname, '../patchers/manifest.mjs')}';
    const buf = Buffer.alloc(16);
    buf.writeUInt16LE(0x0003, 0); // RES_XML_TYPE
    buf.writeUInt16LE(8, 2);      // headerSize = 8
    buf.writeUInt32LE(16, 4);     // docSize = 16
    buf.writeUInt16LE(0x9999, 8); // chunkType = 0x9999 (unhandled chunk)
    buf.writeUInt16LE(8, 10);     // chunkHeaderSize = 8
    buf.writeUInt32LE(0, 12);     // chunkSize = 0! (Triggers infinite loop in while (at < buffer.length))
    try {
      parseAxml(buf);
      process.exit(0);
    } catch (e) {
      process.exit(1);
    }
  `;

  const tmpScript = path.join(__dirname, 'temp_infinite_loop_probe.mjs');
  fs.writeFileSync(tmpScript, workerCode);

  let timedOut = false;
  const child = fork(tmpScript, { stdio: 'pipe' });

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 1000);

  const code = await exitPromise;
  clearTimeout(timer);
  if (fs.existsSync(tmpScript)) fs.unlinkSync(tmpScript);

  assert.equal(timedOut, false, 'parseAxml must reject zero chunkSize immediately without hanging');
  assert.equal(code, 1, 'Worker must exit with error code 1 indicating exception was thrown');
});

test('AXML Adversarial: Truncated chunk headers throw or reject gracefully', () => {
  const base = getBaseAxml();
  // Truncate halfway through the string pool chunk
  const truncated = base.subarray(0, 40);
  // Adjust docSize to match truncated length so it passes initial check
  const badDoc = Buffer.from(truncated);
  badDoc.writeUInt32LE(badDoc.length, 4);

  // Must reject (either via catchable bounds error or custom Error), not hang
  assert.throws(() => parseAxml(badDoc));
});

test('AXML Adversarial: Out-of-bounds string pool offsets', () => {
  const base = getBaseAxml();
  const corrupted = Buffer.from(base);
  // In the string pool (offset 8 is string pool chunk header):
  // Offset 8 + 8 = stringCount, offset 8 + 20 = stringsStart.
  // The first string offset is at 8 + 28 = 36.
  // Corrupt first string offset to 0x0fffffff
  corrupted.writeUInt32LE(0x0fffffff, 36);

  // Must reject or handle without memory corruption
  assert.throws(() => parseAxml(corrupted));
});

test('AXML Adversarial: Duplicate attributes handling in patchManifest', () => {
  const base = getBaseAxml();
  const ast = parseAxml(base);
  const manifest = ast.rootNodes.find(n => n.name === 'manifest');
  const app = manifest.children.find(n => n.name === 'application');

  // Inject duplicate usesCleartextTraffic with conflicting values (false and true)
  app.attributes.push({
    name: 'usesCleartextTraffic',
    namespace: 'http://schemas.android.com/apk/res/android',
    resourceId: 0x010104ec,
    type: 0x12,
    rawValue: 'false',
    value: false,
    data: 0,
  });
  app.attributes.push({
    name: 'usesCleartextTraffic',
    namespace: 'http://schemas.android.com/apk/res/android',
    resourceId: 0x010104ec,
    type: 0x12,
    rawValue: 'false',
    value: false,
    data: 0,
  });

  const serialized = serializeAxml(ast);
  assert.ok(serialized.length > 0);

  // Run patchManifest on this AST
  const patched = patchManifest(serialized);
  const reParsed = parseAxml(patched);
  const reApp = reParsed.rootNodes.find(n => n.name === 'manifest').children.find(n => n.name === 'application');
  const cleartextAttrs = reApp.attributes.filter(a => a.name === 'usesCleartextTraffic');
  assert.equal(cleartextAttrs.length, 1, 'Exactly one usesCleartextTraffic attribute should remain');
  assert.equal(cleartextAttrs[0].value, true, 'usesCleartextTraffic must be true');
});

test('AXML Adversarial: Missing <manifest> or <application> root elements', () => {
  const base = getBaseAxml();
  const ast = parseAxml(base);
  // Clear root nodes
  ast.rootNodes = [];
  const badAxml = serializeAxml(ast);
  assert.throws(() => patchManifest(badAxml), /root <manifest> not found/);

  // Remove <application>
  const ast2 = parseAxml(base);
  const manifest = ast2.rootNodes.find(n => n.name === 'manifest');
  manifest.children = manifest.children.filter(c => c.name !== 'application');
  const badAxml2 = serializeAxml(ast2);
  assert.throws(() => patchManifest(badAxml2), /<application> element not found in manifest/);
});

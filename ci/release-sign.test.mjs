import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  ANDROID_UPDATE_SCHEMA,
  DESKTOP_UPDATE_SCHEMA,
  canonicalAndroidManifestPayload,
  canonicalDesktopManifestPayload,
  loadManifestSigningKey,
  normalizeEcPublicKey,
  sha256Hex,
  signAndroidDeltas,
  signAndroidUpdateManifest,
  signDesktopDeltas,
  signDesktopUpdateManifest,
  verifyAndroidDeltas,
  verifyAndroidUpdateManifest,
  verifyDesktopDeltas,
  verifyDesktopUpdateManifest,
} from './release-sign.mjs';
import { createEntry, createSigningIdentity, entryBytes, readZip, writeZip } from '../android/patchers/signing.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const releaseSignPath = fileURLToPath(new URL('./release-sign.mjs', import.meta.url));

function makeFakeAsar(filesObj, bodyBuf) {
  const jsonBytes = Buffer.from(JSON.stringify(filesObj), 'utf8');
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const headerLen = 8 + jsonBytes.length + pad;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerLen, 4);
  head.writeUInt32LE(4 + jsonBytes.length + pad, 8);
  head.writeInt32LE(jsonBytes.length, 12);
  return Buffer.concat([head, jsonBytes, Buffer.alloc(pad), bodyBuf]);
}

test('exported schemas and key load support primary rokbot-* and legacy grokbot-* read-compat', async () => {
  assert.equal(ANDROID_UPDATE_SCHEMA, 'rokbot-android-update/v1');
  assert.equal(DESKTOP_UPDATE_SCHEMA, 'rokbot-desktop-update/v1');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-release-sign-key-'));
  try {
    const keyPath = path.join(dir, 'manifest-key.json');
    const created = await loadManifestSigningKey(keyPath);
    assert.equal(created.created, true);

    const stored = JSON.parse(await readFile(keyPath, 'utf8'));
    assert.equal(stored.schema, 'rokbot-release-manifest-key/v1');
    assert.equal(normalizeEcPublicKey(stored.publicKeySpkiBase64), created.publicKeySpkiBase64);

    const reloaded = await loadManifestSigningKey(keyPath);
    assert.equal(reloaded.created, false);
    assert.equal(reloaded.publicKeySpkiBase64, created.publicKeySpkiBase64);

    const legacyPath = path.join(dir, 'legacy-key.json');
    await writeFile(legacyPath, JSON.stringify({ ...stored, schema: 'grokbot-release-manifest-key/v1' }));
    const legacy = await loadManifestSigningKey(legacyPath);
    assert.equal(legacy.created, false);
    assert.equal(legacy.publicKeySpkiBase64, created.publicKeySpkiBase64);

    const badPath = path.join(dir, 'bad-key.json');
    await writeFile(badPath, JSON.stringify({ ...stored, schema: 'unexpected-key/v1' }));
    await assert.rejects(() => loadManifestSigningKey(badPath), /Invalid manifest signing key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Android and Desktop manifests + deltas sign and verify (including legacy schema read-compat)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  const androidEntry = {
    track: 'stable',
    packageName: 'dev.rokbot.nativeapp',
    versionName: '1.16.0',
    versionCode: 1075,
    sha256: 'a'.repeat(64),
    size: 12345,
    certificateSha256: 'b'.repeat(64),
    url: 'https://updates.example/RokBotLocal-1.16.0-android.apk',
    publishedAt: '2026-11-19T12:00:00.000Z',
  };
  const signedAndroid = signAndroidUpdateManifest(androidEntry, privateKey);
  assert.equal(signedAndroid.schema, 'rokbot-android-update/v1');
  assert.equal(verifyAndroidUpdateManifest(signedAndroid, pubB64).versionName, '1.16.0');
  assert.throws(
    () => verifyAndroidUpdateManifest({ ...signedAndroid, versionName: '1.16.1' }, pubB64),
    /signature invalid/,
  );
  assert.throws(
    () => verifyAndroidUpdateManifest({ ...signedAndroid, schema: 'invalid-android/v1' }, pubB64),
    /Invalid Android update manifest schema/,
  );

  const legacyAndroidRecord = { ...androidEntry, schema: 'grokbot-android-update/v1' };
  const legacyAndroidSig = sign(
    'sha256',
    Buffer.from(canonicalAndroidManifestPayload(legacyAndroidRecord), 'utf8'),
    privateKey,
  ).toString('base64');
  assert.equal(
    verifyAndroidUpdateManifest({ ...legacyAndroidRecord, signature: legacyAndroidSig }, pubB64).schema,
    'grokbot-android-update/v1',
  );

  const androidWithDeltas = signAndroidDeltas({
    ...signedAndroid,
    deltas: [{
      baseSha256: 'c'.repeat(64),
      baseSize: 12000,
      sha256: 'd'.repeat(64),
      size: 512,
      url: 'https://updates.example/deltas/android-1.16.0.rbdelta',
    }],
  }, privateKey);
  assert.equal(verifyAndroidDeltas(androidWithDeltas, pubB64).deltas.length, 1);
  assert.throws(
    () => verifyAndroidDeltas({ ...androidWithDeltas, deltas: [] }, pubB64),
    /deltasSignature invalid/,
  );

  const desktopEntry = {
    platform: 'win32-x64',
    track: 'stable',
    version: '1.2.3',
    sha256: 'e'.repeat(64),
    size: 54321,
    url: 'https://updates.example/RokBotLocal-1.2.3-x64-Setup.exe',
    publishedAt: '2026-11-19T12:00:00.000Z',
  };
  const signedDesktop = signDesktopUpdateManifest(desktopEntry, privateKey);
  assert.equal(signedDesktop.schema, 'rokbot-desktop-update/v1');
  assert.equal(verifyDesktopUpdateManifest(signedDesktop, pubB64).version, '1.2.3');
  assert.throws(
    () => verifyDesktopUpdateManifest({ ...signedDesktop, version: '1.2.4' }, pubB64),
    /signature invalid/,
  );
  assert.throws(
    () => verifyDesktopUpdateManifest({ ...signedDesktop, schema: 'invalid-desktop/v1' }, pubB64),
    /Invalid desktop update manifest schema/,
  );

  const legacyDesktopRecord = { ...desktopEntry, schema: 'grokbot-desktop-update/v1' };
  const legacyDesktopSig = sign(
    'sha256',
    Buffer.from(canonicalDesktopManifestPayload(legacyDesktopRecord), 'utf8'),
    privateKey,
  ).toString('base64');
  assert.equal(
    verifyDesktopUpdateManifest({ ...legacyDesktopRecord, signature: legacyDesktopSig }, pubB64).schema,
    'grokbot-desktop-update/v1',
  );

  const desktopWithDeltas = signDesktopDeltas({
    ...signedDesktop,
    deltas: [{
      baseSha256: 'f'.repeat(64),
      baseSize: 50000,
      sha256: '1'.repeat(64),
      size: 1024,
      url: 'https://updates.example/deltas/win32-x64-1.2.3.rbdelta',
    }],
  }, privateKey);
  assert.equal(verifyDesktopDeltas(desktopWithDeltas, pubB64).deltas.length, 1);
  assert.throws(
    () => verifyDesktopDeltas({ ...desktopWithDeltas, deltas: [] }, pubB64),
    /deltasSignature invalid/,
  );
});

test('CLI publish-desktop emits rokbot-desktop-update/v1 and .rbdelta artifacts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-publish-desktop-'));
  try {
    const outDir = path.join(dir, 'out');
    await mkdir(outDir, { recursive: true });
    const keyPath = path.join(dir, 'manifest-key.json');
    const shared = Buffer.alloc(16384, 0x41);
    const prevInstaller = path.join(outDir, 'RokBotLocal-1.2.2-x64-Setup.exe');
    const legacyInstaller = path.join(outDir, 'GrokBotLocal-1.2.1-x64-Setup.exe');
    const nextInstaller = path.join(dir, 'RokBotLocal-1.2.3-x64-Setup.exe');

    await execFileAsync(process.execPath, [releaseSignPath, 'init-manifest-key', '--key', keyPath]);
    await writeFile(prevInstaller, Buffer.concat([shared, Buffer.from('v122')]).slice(0));
    await writeFile(legacyInstaller, Buffer.concat([shared, Buffer.from('v121')]).slice(0));
    await writeFile(nextInstaller, Buffer.concat([shared, Buffer.from('v123')]).slice(0));

    const prevAsar = path.join(dir, 'prev.asar');
    const nextAsar = path.join(dir, 'next.asar');
    await writeFile(prevAsar, makeFakeAsar({ files: { 'a.js': { size: 16384 } } }, Buffer.concat([shared, Buffer.from('old-asar')])));
    await writeFile(nextAsar, makeFakeAsar({ files: { 'a.js': { size: 16384 } } }, Buffer.concat([shared, Buffer.from('new-asar')])));

    const { stdout } = await execFileAsync(process.execPath, [
      releaseSignPath,
      'publish-desktop',
      '--file', nextInstaller,
      '--platform', 'win32-x64',
      '--version', '1.2.3',
      '--out-dir', outDir,
      '--base-url', 'https://updates.example',
      '--manifest-key', keyPath,
      '--asar', nextAsar,
      '--prev-asar', prevAsar,
    ]);
    const res = JSON.parse(stdout);
    assert.equal(res.published, true);
    assert.equal(res.feed, 'win32-x64.json');
    assert.equal(res.manifest.schema, 'rokbot-desktop-update/v1');
    assert.equal(res.manifest.deltas.length, 2);
    assert.equal(res.manifest.asarDeltas.length, 1);
    for (const d of [...res.manifest.deltas, ...res.manifest.asarDeltas]) {
      assert.match(d.url, /\.rbdelta$/);
      const deltaName = path.basename(new URL(d.url).pathname);
      const deltaStat = await stat(path.join(outDir, 'deltas', deltaName));
      assert.ok(deltaStat.size > 0);
    }
    verifyDesktopUpdateManifest(res.manifest, res.publicKeySpkiBase64);
    verifyDesktopDeltas(res.manifest, res.publicKeySpkiBase64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI sign-apk and publish-android support rokbot-android-signing/v1, RokBotLocal-*.apk, and .rbdelta', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-publish-android-'));
  try {
    const baseApk = await readFile(path.join(repoRoot, 'android/bin/rokbot-native-base.apk'));
    const manifestEntry = readZip(baseApk).entries.find(e => e.name === 'AndroidManifest.xml');
    assert.ok(manifestEntry);
    const manifestBytes = entryBytes(manifestEntry);

    const shared = Buffer.alloc(16384, 0x52);
    const unsignedPrev = path.join(dir, 'unsigned-prev.apk');
    const unsignedNext = path.join(dir, 'unsigned-next.apk');
    await writeFile(unsignedPrev, writeZip([
      createEntry('AndroidManifest.xml', manifestBytes, { store: true }),
      createEntry('assets/payload.bin', Buffer.concat([shared, Buffer.from('prev-apk')]), { store: true }),
    ]));
    await writeFile(unsignedNext, writeZip([
      createEntry('AndroidManifest.xml', manifestBytes, { store: true }),
      createEntry('assets/payload.bin', Buffer.concat([shared, Buffer.from('next-apk')]), { store: true }),
    ]));

    const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
    const signingPath = path.join(dir, 'android-signing.json');
    await writeFile(signingPath, JSON.stringify({
      schema: 'rokbot-android-signing/v1',
      privateKey: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      certificate: identity.certificate.toString('base64'),
    }));

    const legacySigningPath = path.join(dir, 'legacy-android-signing.json');
    await writeFile(legacySigningPath, JSON.stringify({
      schema: 'grokbot-android-signing/v1',
      privateKey: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      certificate: identity.certificate.toString('base64'),
    }));

    const badSigningPath = path.join(dir, 'bad-android-signing.json');
    await writeFile(badSigningPath, JSON.stringify({
      schema: 'invalid-android-signing/v1',
      privateKey: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      certificate: identity.certificate.toString('base64'),
    }));

    const outDir = path.join(dir, 'out');
    const signedPrev = path.join(outDir, 'GrokBotLocal-0.0.1-android.apk');
    const signedNext = path.join(dir, 'signed-next.apk');
    await execFileAsync(process.execPath, [
      releaseSignPath, 'sign-apk', '--input', unsignedPrev, '--output', signedPrev, '--signing-key', legacySigningPath,
    ]);
    await execFileAsync(process.execPath, [
      releaseSignPath, 'sign-apk', '--input', unsignedNext, '--output', signedNext, '--signing-key', signingPath,
    ]);
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        releaseSignPath, 'sign-apk', '--input', unsignedNext, '--output', path.join(dir, 'nope.apk'), '--signing-key', badSigningPath,
      ]),
      /Invalid Android signing key schema/,
    );

    const keyPath = path.join(dir, 'manifest-key.json');
    const { stdout } = await execFileAsync(process.execPath, [
      releaseSignPath,
      'publish-android',
      '--apk', signedNext,
      '--out-dir', outDir,
      '--base-url', 'https://updates.example',
      '--manifest-key', keyPath,
    ]);
    const res = JSON.parse(stdout);
    assert.equal(res.published, true);
    assert.equal(res.feed, 'android.json');
    assert.equal(path.basename(res.apk), `RokBotLocal-${res.manifest.versionName}-android.apk`);
    assert.equal(res.manifest.schema, 'rokbot-android-update/v1');
    assert.equal(res.manifest.url, `https://updates.example/RokBotLocal-${res.manifest.versionName}-android.apk`);
    assert.equal(res.manifest.deltas.length, 1);
    assert.match(res.manifest.deltas[0].url, /\.rbdelta$/);
    assert.equal(res.manifest.deltas[0].baseSha256, sha256Hex(await readFile(signedPrev)));
    verifyAndroidUpdateManifest(res.manifest, res.publicKeySpkiBase64);
    verifyAndroidDeltas(res.manifest, res.publicKeySpkiBase64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

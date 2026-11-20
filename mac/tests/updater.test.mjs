import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { loadManifestSigningKey, signDesktopDeltas, signDesktopUpdateManifest } from '../../ci/release-sign.mjs';
import {
  ANDROID_DELTAS_SCHEMA,
  DELTA_MAGIC,
  DELTA_SCHEMA,
  DESKTOP_DELTAS_SCHEMA,
  applyDeltaBuffer,
  applyDeltaFile,
  createDeltaBuffer,
  createDeltaFile,
} from '../clients/shared/delta.mjs';
import { replaceWindowsAsarIntegrityHex } from '../clients/desktop/asar-install.mjs';
import {
  DESKTOP_UPDATE_SCHEMA,
  canonicalDesktopPayload,
  createDesktopUpdater,
  createTailcatUpdateFetch,
  loadDesktopUpdateConfig,
  verifyDesktopDeltasManifest,
  verifyDesktopManifest,
} from '../clients/desktop/updater.mjs';

test('desktop updater stays disabled without manifest config', async () => {
  const updater = createDesktopUpdater({ appVersion: '1.2.3', profileDir: os.tmpdir(), config: null });
  assert.equal(updater.status().state.type, 'disabled');
  assert.equal(updater.status().delivery, 'package-manager');
  assert.equal((await updater.check()).state.type, 'disabled');
});

test('desktop updater verifies signature, downloads artifact, verifies checksum, and stages ready update', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-desktop-updater-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const installerBytes = Buffer.from('fake-desktop-installer-payload-1.2.4');
    const sha256 = createHash('sha256').update(installerBytes).digest('hex');

    const manifest = signDesktopUpdateManifest({
      platform: 'win32-x64',
      track: 'stable',
      version: '1.2.4',
      sha256,
      size: installerBytes.length,
      url: 'https://updates.example/RokBotLocal-1.2.4-x64-Setup.exe',
      publishedAt: '2026-11-16T12:00:00.000Z',
    }, key.privateKey);

    let corruptBody = false;
    const states = [];
    const installed = [];
    const updater = createDesktopUpdater({
      appVersion: '1.2.3',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      onStatus: s => states.push(s.state.type),
      onInstallFile: async (file, version) => installed.push({ bytes: (await readFile(file)).length, version }),
      fetchImpl: async url => {
        if (url.includes('/win32-x64.json')) return new Response(JSON.stringify(manifest), { status: 200 });
        return new Response(corruptBody ? Buffer.from('tampered') : installerBytes, {
          status: 200,
          headers: { 'content-length': String(installerBytes.length) },
        });
      },
    });

    corruptBody = true;
    const failed = await updater.check();
    assert.equal(failed.state.type, 'idle');
    assert.equal(failed.state.lastCheck.result, 'error');
    assert.equal(failed.state.lastCheck.failure.kind, 'installer_signature_invalid');

    corruptBody = false;
    const ready = await updater.check();
    assert.equal(ready.state.type, 'ready');
    assert.equal(ready.state.version, '1.2.4');
    assert.ok(states.includes('checking'));
    assert.ok(states.includes('staging'));

    const installRes = await updater.quitAndInstall({ expectedVersion: '1.2.4' });
    assert.deepEqual(installRes, { status: 'requested' });
    assert.deepEqual(installed, [{ bytes: installerBytes.length, version: '1.2.4' }]);

    const supersededRes = await updater.quitAndInstall({ expectedVersion: '1.2.3' });
    assert.deepEqual(supersededRes, { status: 'superseded' });

    updater.setTrack({ track: 'nightly' });
    updater.setAutoUpdateWhenIdle({ enabled: true });
    await new Promise(resolve => setTimeout(resolve, 15));
    const reloaded = createDesktopUpdater({
      appVersion: '1.2.3',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
    });
    assert.equal(reloaded.status().currentTrack, 'nightly');
    assert.equal(reloaded.status().autoUpdateWhenIdle, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('desktop updater discards in-flight check result if setTrack switches track concurrently', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-desktop-track-race-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const installerBytes = Buffer.from('stable-payload');
    const manifest = signDesktopUpdateManifest({
      platform: 'win32-x64',
      track: 'stable',
      version: '1.2.4',
      sha256: createHash('sha256').update(installerBytes).digest('hex'),
      size: installerBytes.length,
      url: 'https://updates.example/RokBotLocal-1.2.4-x64-Setup.exe',
      publishedAt: '2026-11-16T12:00:00.000Z',
    }, key.privateKey);
    const gate = Promise.withResolvers();
    const updater = createDesktopUpdater({
      appVersion: '1.2.3',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      fetchImpl: async url => {
        if (url.includes('/win32-x64.json')) {
          await gate.promise;
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response(installerBytes, { status: 200 });
      },
    });
    const inFlight = updater.check();
    updater.setTrack({ track: 'nightly' });
    gate.resolve();
    const settled = await inFlight;
    assert.equal(settled.currentTrack, 'nightly');
    assert.equal(updater.status().state.type, 'idle');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


function buildSyntheticAsar(headerObj, payloadText) {
  const json = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const pickleSize = 4 + 4 + json.length;
  const alignedSize = Math.ceil(pickleSize / 4) * 4;
  const buf = Buffer.alloc(8 + alignedSize + Buffer.byteLength(payloadText));
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(alignedSize, 4);
  buf.writeUInt32LE(pickleSize, 8);
  buf.writeInt32LE(json.length, 12);
  json.copy(buf, 16);
  buf.write(payloadText, 8 + alignedSize, 'utf8');
  return {
    bytes: buf,
    headerSha256: createHash('sha256').update(json).digest('hex'),
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

test('desktop updater stages installer binary delta without downloading full installer, and falls back if tampered', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-desktop-delta-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const sharedTail = Buffer.alloc(128 * 1024, 0x41);
    const oldInstaller = Buffer.concat([Buffer.from('OLD-HDR-1.2.3-'), sharedTail, Buffer.from('-END')]);
    const newInstaller = Buffer.concat([Buffer.from('NEW-HDR-1.2.4-'), sharedTail, Buffer.from('-PATCHED')]);
    const deltaBytes = createDeltaBuffer(oldInstaller, newInstaller);
    assert.ok(deltaBytes.length < 4096, `expected tiny delta, got ${deltaBytes.length}`);

    const updatesDir = path.join(dir, 'updates');
    await mkdir(updatesDir, { recursive: true });
    await writeFile(path.join(updatesDir, 'ready-stable-1.2.3.exe'), oldInstaller);

    const signed = signDesktopDeltas(
      signDesktopUpdateManifest({
        platform: 'win32-x64',
        track: 'stable',
        version: '1.2.4',
        sha256: createHash('sha256').update(newInstaller).digest('hex'),
        size: newInstaller.length,
        url: 'https://updates.example/RokBotLocal-1.2.4-x64-Setup.exe',
        publishedAt: '2026-11-16T12:00:00.000Z',
      }, key.privateKey)
        ? {
            ...signDesktopUpdateManifest({
              platform: 'win32-x64',
              track: 'stable',
              version: '1.2.4',
              sha256: createHash('sha256').update(newInstaller).digest('hex'),
              size: newInstaller.length,
              url: 'https://updates.example/RokBotLocal-1.2.4-x64-Setup.exe',
              publishedAt: '2026-11-16T12:00:00.000Z',
            }, key.privateKey),
            deltas: [{
              baseSha256: createHash('sha256').update(oldInstaller).digest('hex'),
              baseSize: oldInstaller.length,
              sha256: createHash('sha256').update(deltaBytes).digest('hex'),
              size: deltaBytes.length,
              url: 'https://updates.example/deltas/1240.rbdelta',
            }],
          }
        : {},
      key.privateKey,
    );

    const fetched = [];
    const installed = [];
    const updater = createDesktopUpdater({
      appVersion: '1.2.3',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      onInstallFile: async (file, ver) => installed.push({ bytes: await readFile(file), ver }),
      fetchImpl: async url => {
        fetched.push(url);
        if (url.includes('/win32-x64.json')) return new Response(JSON.stringify(signed), { status: 200 });
        if (url.includes('1240.rbdelta')) return new Response(deltaBytes, { status: 200, headers: { 'content-length': String(deltaBytes.length) } });
        return new Response(newInstaller, { status: 200, headers: { 'content-length': String(newInstaller.length) } });
      },
    });

    const ready = await updater.check();
    assert.equal(ready.state.type, 'ready');
    assert.equal(fetched.some(u => u.includes('1240.rbdelta')), true);
    assert.equal(fetched.some(u => u.includes('Setup.exe')), false);
    await updater.quitAndInstall({ expectedVersion: '1.2.4' });
    assert.equal(installed.length, 1);
    assert.ok(installed[0].bytes.equals(newInstaller));

    // If delta signature is tampered, updater safely falls back to full installer download.
    const profile2 = await mkdtemp(path.join(os.tmpdir(), 'rokbot-desktop-fallback-'));
    try {
      await mkdir(path.join(profile2, 'updates'), { recursive: true });
      await writeFile(path.join(profile2, 'updates', 'base-stable.exe'), oldInstaller);
      const tamperedSigned = { ...signed, deltasSignature: 'AAAA' };
      const fetched2 = [];
      const updater2 = createDesktopUpdater({
        appVersion: '1.2.3',
        platformId: 'win32-x64',
        profileDir: profile2,
        config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
        fetchImpl: async url => {
          fetched2.push(url);
          if (url.includes('/win32-x64.json')) return new Response(JSON.stringify(tamperedSigned), { status: 200 });
          if (url.includes('1240.rbdelta')) throw new Error('should not download delta with bad deltasSignature');
          return new Response(newInstaller, { status: 200, headers: { 'content-length': String(newInstaller.length) } });
        },
      });
      const fallbackReady = await updater2.check();
      assert.equal(fallbackReady.state.type, 'ready');
      assert.equal(fetched2.some(u => u.includes('Setup.exe')), true);
    } finally {
      await rm(profile2, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('desktop updater stages ASAR incremental delta and passes header hashes to onInstallAsar', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-desktop-asar-delta-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const resDir = path.join(dir, 'resources');
    const profileDir = path.join(dir, 'profile');
    await mkdir(resDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const oldAsar = buildSyntheticAsar({ files: { 'a.js': { size: 1000, offset: '0' } } }, 'A'.repeat(40000));
    const newAsar = buildSyntheticAsar({ files: { 'a.js': { size: 1000, offset: '0' }, 'b.js': { size: 5, offset: '40000' } } }, 'A'.repeat(40000) + 'hello');
    await writeFile(path.join(resDir, 'app.asar'), oldAsar.bytes);
    const asarDelta = createDeltaBuffer(oldAsar.bytes, newAsar.bytes);
    const fullInstaller = Buffer.from('full-installer-fallback');

    const baseManifest = signDesktopUpdateManifest({
      platform: 'darwin-arm64',
      track: 'stable',
      version: '1.2.4',
      sha256: createHash('sha256').update(fullInstaller).digest('hex'),
      size: fullInstaller.length,
      url: 'https://updates.example/RokBotLocal-1.2.4-arm64.dmg',
      publishedAt: '2026-11-16T12:00:00.000Z',
    }, key.privateKey);
    const signed = signDesktopDeltas({
      ...baseManifest,
      asarDeltas: [{
        baseSha256: oldAsar.sha256,
        baseSize: oldAsar.bytes.length,
        baseHeaderSha256: oldAsar.headerSha256,
        targetSha256: newAsar.sha256,
        targetSize: newAsar.bytes.length,
        targetHeaderSha256: newAsar.headerSha256,
        sha256: createHash('sha256').update(asarDelta).digest('hex'),
        size: asarDelta.length,
        url: 'https://updates.example/deltas/mac-asar.rbdelta',
      }],
    }, key.privateKey);

    const asarInstalls = [];
    const fetched = [];
    const updater = createDesktopUpdater({
      appVersion: '1.2.3',
      platformId: 'darwin-arm64',
      profileDir,
      resourcesDir: resDir,
      execPath: path.join(dir, 'RokBot'),
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      canUseAsarUpdate: async () => true,
      onInstallAsar: async info => asarInstalls.push(info),
      fetchImpl: async url => {
        fetched.push(url);
        if (url.includes('/darwin-arm64.json')) return new Response(JSON.stringify(signed), { status: 200 });
        if (url.includes('mac-asar.rbdelta')) return new Response(asarDelta, { status: 200 });
        return new Response(fullInstaller, { status: 200 });
      },
    });

    const ready = await updater.check();
    assert.equal(ready.state.type, 'ready');
    assert.equal(fetched.some(u => u.includes('mac-asar.rbdelta')), true);
    assert.equal(fetched.some(u => u.includes('.dmg')), false);
    await updater.quitAndInstall({ expectedVersion: '1.2.4' });
    assert.equal(asarInstalls.length, 1);
    assert.equal(asarInstalls[0].headerSha256, newAsar.headerSha256);
    assert.equal(asarInstalls[0].baseHeaderSha256, oldAsar.headerSha256);
    assert.ok((await readFile(asarInstalls[0].asarFile)).equals(newAsar.bytes));

    // Also verify Windows PE integrity record replacement helper.
    const oldHash = '0'.repeat(64);
    const newHash = 'f'.repeat(64);
    const fakeExe = Buffer.from(`MZ...[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${oldHash}"}]...`, 'latin1');
    const patchedExe = replaceWindowsAsarIntegrityHex(fakeExe, oldHash, newHash);
    assert.equal(patchedExe.toString('latin1').includes(newHash), true);
    assert.equal(patchedExe.length, fakeExe.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('createTailcatUpdateFetch routes manifest and installer downloads through Host /local/updates/fetch and falls back when older Host returns 404', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-tailcat-updater-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const installerBytes = Buffer.from('tailcat-tunneled-installer-1.2.4');
    const manifest = signDesktopUpdateManifest({
      platform: 'win32-x64',
      track: 'stable',
      version: '1.2.4',
      sha256: createHash('sha256').update(installerBytes).digest('hex'),
      size: installerBytes.length,
      url: 'https://updates.example/RokBotLocal-1.2.4-x64-Setup.exe',
      publishedAt: '2026-11-16T12:00:00.000Z',
    }, key.privateKey);

    const calls = [];
    const proxiedFetch = createTailcatUpdateFetch({
      isTunneled: () => true,
      getServerUrl: () => 'http://127.0.0.1:41234',
      getToken: () => 'tailcat-device-token',
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers ?? {});
        calls.push({ url, auth: headers.get('authorization') });
        if (url.startsWith('http://127.0.0.1:41234/local/updates/fetch?')) {
          const inner = decodeURIComponent(new URL(url).searchParams.get('url'));
          assert.equal(headers.get('authorization'), 'Bearer tailcat-device-token');
          if (inner.includes('/win32-x64.json')) return new Response(JSON.stringify(manifest), { status: 200 });
          if (inner.includes('Setup.exe')) return new Response(installerBytes, { status: 200, headers: { 'content-length': String(installerBytes.length) } });
        }
        throw new Error(`unexpected direct fetch: ${url}`);
      },
    });

    const updater = createDesktopUpdater({
      appVersion: '1.2.3',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      fetchImpl: proxiedFetch,
    });

    const ready = await updater.check();
    assert.equal(ready.state.type, 'ready');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.url.startsWith('http://127.0.0.1:41234/local/updates/fetch?')));

    // Older Host returning 404 on /local/updates/fetch falls back to direct URL cleanly.
    const fallbackCalls = [];
    const fallbackFetch = createTailcatUpdateFetch({
      isTunneled: () => true,
      getServerUrl: () => 'http://127.0.0.1:41234',
      getToken: () => 'tailcat-device-token',
      fetchImpl: async url => {
        fallbackCalls.push(url);
        if (url.startsWith('http://127.0.0.1:41234/')) return new Response('not found', { status: 404 });
        return new Response('direct-ok', { status: 200 });
      },
    });
    const directRes = await fallbackFetch('https://updates.example/win32-x64.json');
    assert.equal(directRes.status, 200);
    assert.equal(await directRes.text(), 'direct-ok');
    assert.equal(fallbackCalls.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});



test('updater & delta support rokbot-* schemas, RBD1 magic, rokbot-local-* configs, and legacy GBD1/grokbot-* backward compat', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-updater-compat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(DELTA_SCHEMA, 'rokbot-delta/v1');
  assert.equal(DELTA_MAGIC.toString('ascii'), 'RBD1');
  assert.equal(ANDROID_DELTAS_SCHEMA, 'rokbot-android-deltas/v1');
  assert.equal(DESKTOP_DELTAS_SCHEMA, 'rokbot-desktop-deltas/v1');
  assert.equal(DESKTOP_UPDATE_SCHEMA, 'rokbot-desktop-update/v1');

  const source = Buffer.concat([Buffer.from('OLD-'), Buffer.alloc(4096, 0x31)]);
  const target = Buffer.concat([Buffer.from('NEW-'), Buffer.alloc(4096, 0x31), Buffer.from('-TAIL')]);
  const rbdDelta = createDeltaBuffer(source, target);
  const rawRbd = gunzipSync(rbdDelta);
  assert.equal(rawRbd.subarray(0, 4).toString('ascii'), 'RBD1');
  assert.ok(applyDeltaBuffer(source, rbdDelta).equals(target));

  // Legacy GBD1 delta stream remains readable by both applyDeltaBuffer and applyDeltaFile.
  const rawGbd = Buffer.from(rawRbd);
  Buffer.from('GBD1', 'ascii').copy(rawGbd, 0);
  const gbdDelta = gzipSync(rawGbd);
  assert.ok(applyDeltaBuffer(source, gbdDelta).equals(target));

  const srcPath = path.join(dir, 'src.bin');
  const targetPath = path.join(dir, 'target.bin');
  const gbdPath = path.join(dir, 'legacy.gbdelta');
  const rbdPath = path.join(dir, 'modern.rbdelta');
  const outFromGbd = path.join(dir, 'out-gbd.bin');
  const outFromRbd = path.join(dir, 'out-rbd.bin');
  await writeFile(srcPath, source);
  await writeFile(targetPath, target);
  await writeFile(gbdPath, gbdDelta);
  await createDeltaFile(srcPath, targetPath, rbdPath);
  await applyDeltaFile(srcPath, gbdPath, outFromGbd, { expectedTargetSize: target.length });
  await applyDeltaFile(srcPath, rbdPath, outFromRbd, { expectedTargetSize: target.length });
  assert.ok((await readFile(outFromGbd)).equals(target));
  assert.ok((await readFile(outFromRbd)).equals(target));

  // rokbot-desktop-update/v1 manifest verifies cleanly alongside grokbot-desktop-update/v1 compat.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const rokManifest = {
    schema: 'rokbot-desktop-update/v1',
    platform: 'darwin-arm64',
    track: 'stable',
    version: '0.73.0',
    sha256: createHash('sha256').update(target).digest('hex'),
    size: target.length,
    url: 'https://updates.example/RokBotLocal-0.73.0-arm64.dmg',
    publishedAt: '2026-11-19T00:00:00.000Z',
  };
  rokManifest.signature = sign('sha256', Buffer.from(canonicalDesktopPayload(rokManifest), 'utf8'), privateKey).toString('base64');
  assert.equal(verifyDesktopManifest(rokManifest, spkiBase64).schema, 'rokbot-desktop-update/v1');

  const signedRokDeltas = signDesktopDeltas(rokManifest, privateKey);
  assert.equal(verifyDesktopDeltasManifest(signedRokDeltas, spkiBase64), true);

  // loadDesktopUpdateConfig prefers rokbot-local-* and falls back to grokbot-local-*.
  const resPrimary = path.join(dir, 'res-primary');
  const resFallback = path.join(dir, 'res-fallback');
  await mkdir(resPrimary, { recursive: true });
  await mkdir(resFallback, { recursive: true });
  await writeFile(path.join(resPrimary, 'grokbot-local-update.json'), JSON.stringify({
    updateUrl: 'https://legacy.example/updates',
    updatePublicKey: spkiBase64,
  }));
  await writeFile(path.join(resPrimary, 'rokbot-local-update.json'), JSON.stringify({
    updateUrl: 'https://rokbot.example/updates',
    updatePublicKey: spkiBase64,
  }));
  assert.equal((await loadDesktopUpdateConfig({ resourcesDir: resPrimary })).updateUrl, 'https://rokbot.example/updates');

  await writeFile(path.join(resFallback, 'grokbot-local.patch.json'), JSON.stringify({
    updateUrl: 'https://legacy-patch.example/updates',
    updatePublicKey: spkiBase64,
  }));
  assert.equal((await loadDesktopUpdateConfig({ resourcesDir: resFallback })).updateUrl, 'https://legacy-patch.example/updates');
});

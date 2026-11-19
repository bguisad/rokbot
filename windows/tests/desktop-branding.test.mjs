import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  APP_DISPLAY_NAME,
  APP_USER_MODEL_ID as WINDOWS_APP_USER_MODEL_ID,
  PROFILE_DISPLAY_PATH,
  resolveRokBotWindowsLogoPaths,
  resolveSetupStubSource,
  resolveWindowsTailcatSource,
  stageLocalClientWindowsIcons,
  verifyRokBotWindowsIcons,
} from '../patchers/desktop/brand-assets.mjs';
import { applicationIcon, replaceAsarIntegrity } from '../patchers/desktop/pe.mjs';
import { buildWindowsResourceSyso } from '../tools/build-installer-syso.mjs';
import { acquireDesktopSource, resolveDesktopDownloadUrl } from '../../mac/patchers/desktop/download-original.mjs';
import { replaceWindowsAsarIntegrityHex } from '../../mac/clients/desktop/asar-install.mjs';
import {
  APP_USER_MODEL_ID,
  SHORTCUT_NAME,
  canRegisterDesktopIntegration,
  resolveDesktopProfile,
} from '../../mac/clients/desktop/platform.mjs';
import {
  DESKTOP_UPDATE_SCHEMA,
  canonicalDesktopPayload,
  createDesktopUpdater,
  loadDesktopUpdateConfig,
} from '../../mac/clients/desktop/updater.mjs';
import {
  canonicalDesktopDeltasPayload,
  createDeltaBuffer,
} from '../../mac/clients/shared/delta.mjs';

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(windowsRoot, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('assets/logo RokBot Windows icons match manifest.json and carry valid ICO/PNG headers', async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'assets/logo/manifest.json'), 'utf8'));
  const { icoPath, iconPngPath } = resolveRokBotWindowsLogoPaths(repoRoot);
  const [icoBytes, pngBytes] = await Promise.all([readFile(icoPath), readFile(iconPngPath)]);

  assert.equal(icoBytes.readUInt16LE(0), 0);
  assert.equal(icoBytes.readUInt16LE(2), 1);
  assert.equal(icoBytes.readUInt16LE(4), manifest.ico.sizes.length);
  assert.equal(sha(icoBytes), manifest.ico.sha256);

  assert.deepEqual([...pngBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(pngBytes.readUInt32BE(16), 512);
  assert.equal(pngBytes.readUInt32BE(20), 512);
  const manifest512 = manifest.png.find(item => item.width === 512);
  assert.ok(manifest512);
  assert.equal(sha(pngBytes), manifest512.sha256);
});

test('brand-assets stages RokBot Windows icons into app.asar, resolves binaries, and fails closed on mismatch', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-win-branding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const asar = createRequire(path.join(repoRoot, 'mac/patchers/desktop/package.json'))('@electron/asar');
  const { icoPath, iconPngPath } = resolveRokBotWindowsLogoPaths(repoRoot);

  const unpacked = path.join(dir, 'unpacked');
  const outAsar = path.join(dir, 'app.asar');
  await mkdir(path.join(unpacked, 'local-client'), { recursive: true });
  await writeFile(path.join(unpacked, 'package.json'), JSON.stringify({ name: 'rokbot', main: 'local-client/main.mjs' }));

  await stageLocalClientWindowsIcons({ unpackedDir: unpacked, icoPath, iconPngPath });
  await asar.createPackageWithOptions(unpacked, outAsar, {});

  const verified = await verifyRokBotWindowsIcons({ icoPath, iconPngPath, outAsarPath: outAsar, asarModule: asar });
  assert.equal(verified.rokbotIconApplied, true);
  assert.equal(verified.iconSha256, sha(await readFile(icoPath)));
  assert.equal(verified.localIconSha256, sha(await readFile(iconPngPath)));

  // Tamper local-client/icon.png -> must fail closed.
  await writeFile(path.join(unpacked, 'local-client/icon.png'), 'tampered-png');
  const tamperedPngAsar = path.join(dir, 'tampered-png.asar');
  await asar.createPackageWithOptions(unpacked, tamperedPngAsar, {});
  await assert.rejects(
    verifyRokBotWindowsIcons({ icoPath, iconPngPath, outAsarPath: tamperedPngAsar, asarModule: asar }),
    /local-client\/icon\.png/,
  );

  // Restore icon.png, then tamper local-client/icon.ico -> must fail closed.
  await stageLocalClientWindowsIcons({ unpackedDir: unpacked, icoPath, iconPngPath });
  await writeFile(path.join(unpacked, 'local-client/icon.ico'), 'tampered-ico');
  const tamperedIcoAsar = path.join(dir, 'tampered-ico.asar');
  await asar.createPackageWithOptions(unpacked, tamperedIcoAsar, {});
  await assert.rejects(
    verifyRokBotWindowsIcons({ icoPath, iconPngPath, outAsarPath: tamperedIcoAsar, asarModule: asar }),
    /local-client\/icon\.ico/,
  );

  // Verify tailcat / stub source resolvers point to rokbot-* binaries on disk.
  assert.equal(path.basename(resolveWindowsTailcatSource(windowsRoot)), 'rokbot-tailcat.exe');
  assert.equal(path.basename(resolveSetupStubSource(windowsRoot)), 'rokbot-setup-stub.exe');
  assert.equal(existsSync(resolveWindowsTailcatSource(windowsRoot)), true);
  assert.equal(existsSync(resolveSetupStubSource(windowsRoot)), true);
});

test('rsrc_windows_amd64.syso is deterministically reproducible and setup stub embeds RokBot icon & ROKBOT-SETUP-V1', async () => {
  const { icoPath } = resolveRokBotWindowsLogoPaths(repoRoot);
  const icoBytes = await readFile(icoPath);
  const png256Bytes = await readFile(path.join(repoRoot, 'assets/logo/rokbot-icon-256.png'));

  const generatedA = buildWindowsResourceSyso(icoBytes);
  const generatedB = buildWindowsResourceSyso(icoBytes);
  assert.equal(generatedA.equals(generatedB), true);

  const committedSyso = await readFile(path.join(windowsRoot, 'installer/rsrc_windows_amd64.syso'));
  assert.equal(committedSyso.equals(generatedA), true);

  const stub = await readFile(resolveSetupStubSource(windowsRoot));
  const extracted = applicationIcon(stub);
  assert.equal(extracted.ico.equals(icoBytes), true);
  assert.equal(extracted.png.equals(png256Bytes), true);
  assert.equal(stub.includes(Buffer.from('ROKBOT-SETUP-V1\0', 'latin1')), true);
  assert.equal(stub.includes(Buffer.from('GROKBOT-SETUP-V1', 'latin1')), false);
  assert.equal(stub.includes(Buffer.from('RokBot Local', 'utf8')), true);
});

test('Windows branding, installer ownership receipt, ASAR integrity, and RBD1/GBD1 updater contracts align', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-win-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(APP_DISPLAY_NAME, 'RokBot Local');
  assert.equal(WINDOWS_APP_USER_MODEL_ID, 'dev.rokbot.local');
  assert.equal(PROFILE_DISPLAY_PATH, '%APPDATA%\\RokBot Local');
  assert.equal(APP_USER_MODEL_ID, 'dev.rokbot.local');
  assert.equal(SHORTCUT_NAME, 'RokBot Local.lnk');

  const appDataDir = path.join(dir, 'appdata');
  assert.equal(resolveDesktopProfile({ env: {}, appDataDir }).profile, path.join(appDataDir, 'RokBot Local'));

  // Installer receipt ownership check (.rokbot-installation.json).
  const installDir = path.join(dir, 'RokBot Local');
  await mkdir(installDir, { recursive: true });
  const execPath = path.join(installDir, 'Grok Bot.exe');
  await writeFile(path.join(installDir, '.rokbot-installation.json'), JSON.stringify({
    format: 1,
    appId: 'dev.rokbot.local',
    directory: installDir,
  }));
  assert.equal(await canRegisterDesktopIntegration({ isolatedProfile: false, platform: 'win32', execPath }), true);
  await writeFile(path.join(installDir, '.rokbot-installation.json'), JSON.stringify({
    format: 1,
    appId: 'dev.rokbot.local',
    directory: installDir,
    sideBySideOf: 'C:\\legacy',
  }));
  assert.equal(await canRegisterDesktopIntegration({ isolatedProfile: false, platform: 'win32', execPath }), false);

  // Update config precedence: rokbot-local-update.json > rokbot-local.patch.json.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubSpki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const resourcesDir = path.join(installDir, 'resources');
  await mkdir(resourcesDir, { recursive: true });
  await writeFile(path.join(resourcesDir, 'rokbot-local.patch.json'), JSON.stringify({
    updateUrl: 'https://patch.example/updates',
    updatePublicKey: pubSpki,
    patchedAt: '2026-11-19T00:00:00.000Z',
  }));
  assert.equal((await loadDesktopUpdateConfig({ resourcesDir }))?.updateUrl, 'https://patch.example/updates');
  await writeFile(path.join(resourcesDir, 'rokbot-local-update.json'), JSON.stringify({
    updateUrl: 'https://override.example/updates',
    updatePublicKey: pubSpki,
  }));
  assert.equal((await loadDesktopUpdateConfig({ resourcesDir }))?.updateUrl, 'https://override.example/updates');

  // PE ASAR integrity replacement parity between pe.mjs and asar-install.mjs.
  const oldHash = '1'.repeat(64);
  const newHash = '2'.repeat(64);
  const syntheticExe = Buffer.from(`MZ...[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${oldHash}"}]...`, 'latin1');
  assert.equal(
    replaceAsarIntegrity(syntheticExe, oldHash, newHash).equals(replaceWindowsAsarIntegrityHex(syntheticExe, oldHash, newHash)),
    true,
  );

  // Desktop updater win32-x64 with rokbot-desktop-update/v1 + RBD1 and legacy GBD1 delta read-compat.
  const signManifest = payload => {
    const sig = sign('sha256', Buffer.from(canonicalDesktopPayload(payload), 'utf8'), privateKey).toString('base64');
    return { ...payload, signatureAlgorithm: 'ecdsa-p256-sha256', signature: sig };
  };
  const signDeltas = payload => {
    const deltasSignature = sign('sha256', Buffer.from(canonicalDesktopDeltasPayload(payload), 'utf8'), privateKey).toString('base64');
    return { ...payload, deltasSignature };
  };

  const baseInstaller = Buffer.from('A'.repeat(4096) + 'win-base-1.1.0');
  const targetInstaller = Buffer.from('A'.repeat(4096) + 'win-target-1.2.3');
  const rbdDelta = createDeltaBuffer(baseInstaller, targetInstaller);
  const rawRbd = gunzipSync(rbdDelta);
  assert.equal(rawRbd.subarray(0, 4).toString('ascii'), 'RBD1');
  const gbdDelta = gzipSync(Buffer.concat([Buffer.from('GBD1', 'ascii'), rawRbd.subarray(4)]));

  for (const [label, deltaBytes] of [['RBD1', rbdDelta], ['GBD1', gbdDelta]]) {
    const prof = path.join(dir, `profile-${label}`);
    await mkdir(path.join(prof, 'updates'), { recursive: true });
    await writeFile(path.join(prof, 'updates', 'base-stable.exe'), baseInstaller);

    const feed = signDeltas(signManifest({
      schema: DESKTOP_UPDATE_SCHEMA,
      platform: 'win32-x64',
      track: 'stable',
      version: '1.2.3',
      sha256: sha(targetInstaller),
      size: targetInstaller.length,
      url: 'https://updates.example/RokBotLocal-1.2.3-x64-Setup.exe',
      publishedAt: '2026-11-19T12:00:00.000Z',
      deltas: [{
        baseSha256: sha(baseInstaller),
        baseSize: baseInstaller.length,
        sha256: sha(deltaBytes),
        size: deltaBytes.length,
        url: `https://updates.example/deltas/1.2.3-${label}.rbdelta`,
      }],
    }));

    const fetched = [];
    const updater = createDesktopUpdater({
      appVersion: '1.1.0',
      platformId: 'win32-x64',
      profileDir: prof,
      config: { updateUrl: 'https://updates.example', updatePublicKey: pubSpki },
      fetchImpl: async url => {
        fetched.push(url);
        if (url.includes('/win32-x64.json')) return new Response(JSON.stringify(feed), { status: 200 });
        if (url.includes('.rbdelta')) return new Response(deltaBytes, { status: 200, headers: { 'content-length': String(deltaBytes.length) } });
        throw new Error(`Unexpected full installer fetch for ${label}`);
      },
    });
    const res = await updater.check();
    assert.equal(res.state.type, 'ready');
    assert.equal(res.state.version, '1.2.3');
    assert.equal(fetched.some(u => u.includes(`.rbdelta`)), true);
  }
});

test('ROKBOT_DESKTOP_DOWNLOAD_BASE overrides Windows official installer URLs and enforces strict validation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-win-mirror-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const supported110 = JSON.parse(await readFile(path.join(windowsRoot, 'patchers/desktop/supported.json'), 'utf8'));
  const supported0712 = JSON.parse(await readFile(path.join(windowsRoot, 'patchers/desktop/0.71.2/supported.json'), 'utf8'));

  assert.equal(
    resolveDesktopDownloadUrl(supported110.archive.url, 'https://mirror.rokbot.example/desktop///'),
    'https://mirror.rokbot.example/desktop/win32-x64/1.1.0/Grok_Bot_1.1.0_Setup.exe',
  );
  assert.equal(
    resolveDesktopDownloadUrl(supported0712.archive.url, 'http://127.0.0.1:9000/files'),
    'http://127.0.0.1:9000/files/win32-x64/0.71.2/Grok_Bot_0.71.2_Setup.exe',
  );

  for (const invalid of [
    'ftp://mirror.example/files',
    'file:///tmp/files',
    'https://user:pass@mirror.example/files',
    'https://mirror.example/files?token=1',
    'https://mirror.example/files#frag',
    'not-a-url',
  ]) {
    assert.throws(() => resolveDesktopDownloadUrl(supported110.archive.url, invalid), /ROKBOT_DESKTOP_DOWNLOAD_BASE/);
  }

  const fakePayload = Buffer.from('synthetic-windows-setup-payload');
  const fakeSupported = {
    version: '1.1.0',
    archive: {
      url: supported110.archive.url,
      bytes: fakePayload.length,
      sha256: sha(fakePayload),
    },
  };
  const requests = [];
  const cachedFile = await acquireDesktopSource({
    cacheDirectory: dir,
    supported: fakeSupported,
    downloadBase: 'https://mirror.rokbot.example/desktop',
    fetchImpl: async (url, init) => {
      requests.push({ url, userAgent: init.headers['user-agent'] });
      return new Response(fakePayload, { status: 200 });
    },
  });
  assert.equal(path.basename(cachedFile), 'Grok_Bot_1.1.0_Setup.exe');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://mirror.rokbot.example/desktop/win32-x64/1.1.0/Grok_Bot_1.1.0_Setup.exe');
  assert.equal(requests[0].userAgent, 'Mozilla/5.0 (compatible; RokBot-Patcher)');

  // Corrupt payload from mirror must fail closed before writing destination.
  const corruptDir = path.join(dir, 'corrupt-cache');
  await assert.rejects(
    acquireDesktopSource({
      cacheDirectory: corruptDir,
      supported: fakeSupported,
      downloadBase: 'https://mirror.rokbot.example/desktop',
      fetchImpl: async () => new Response(Buffer.from('wrong-bytes-wrong-bytes-wrong!!'), { status: 200 }),
    }),
    /校验失败|大小不匹配/,
  );
});

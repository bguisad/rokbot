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
  WINDOWS_PE_VERSION_STRINGS,
  resolveRokBotWindowsLogoPaths,
  resolveSetupStubSource,
  resolveWindowsTailcatSource,
  stageLocalClientWindowsIcons,
  verifyRokBotWindowsIcons,
} from '../patchers/desktop/brand-assets.mjs';
import { applicationIcon, hasAuthenticode, replaceAsarIntegrity, replaceResources, versionInfo } from '../patchers/desktop/pe.mjs';
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

  const baseInstaller = Buffer.from('A'.repeat(4096) + 'win-base-1.2.3');
  const targetInstaller = Buffer.from('A'.repeat(4096) + 'win-target-1.2.4');
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
      version: '1.2.4',
      sha256: sha(targetInstaller),
      size: targetInstaller.length,
      url: 'https://updates.example/RokBotLocal-1.2.4-x64-Setup.exe',
      publishedAt: '2026-11-19T12:00:00.000Z',
      deltas: [{
        baseSha256: sha(baseInstaller),
        baseSize: baseInstaller.length,
        sha256: sha(deltaBytes),
        size: deltaBytes.length,
        url: `https://updates.example/deltas/1.2.4-${label}.rbdelta`,
      }],
    }));

    const fetched = [];
    const updater = createDesktopUpdater({
      appVersion: '1.2.3',
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
    assert.equal(res.state.version, '1.2.4');
    assert.equal(fetched.some(u => u.includes(`.rbdelta`)), true);
  }
});

test('Windows Host /local/updates/windows.json asarDeltas (RBD1/GBD1) reconstruct target ASAR and update PE ElectronAsarIntegrity', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-win-asardelta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const asar = createRequire(path.join(repoRoot, 'mac/patchers/desktop/package.json'))('@electron/asar');
  const { readAsarHeaderInfo } = await import('../../mac/clients/shared/delta.mjs');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubPem = publicKey.export({ format: 'pem', type: 'spki' });

  const baseSrc = path.join(dir, 'asar-src-base');
  const targetSrc = path.join(dir, 'asar-src-target');
  await mkdir(path.join(baseSrc, 'local-client'), { recursive: true });
  await mkdir(path.join(targetSrc, 'local-client'), { recursive: true });
  await writeFile(path.join(baseSrc, 'package.json'), JSON.stringify({ name: 'rokbot', version: '1.2.3', main: 'local-client/main.mjs' }));
  await writeFile(path.join(targetSrc, 'package.json'), JSON.stringify({ name: 'rokbot', version: '1.2.4', main: 'local-client/main.mjs' }));
  await writeFile(path.join(baseSrc, 'local-client/main.mjs'), `export const v = '1.2.3';\n${'/* shared */\n'.repeat(128)}`);
  await writeFile(path.join(targetSrc, 'local-client/main.mjs'), `export const v = '1.2.4';\n${'/* shared */\n'.repeat(128)}`);

  const baseAsarPath = path.join(dir, 'base.asar');
  const targetAsarPath = path.join(dir, 'target.asar');
  await asar.createPackageWithOptions(baseSrc, baseAsarPath, {});
  await asar.createPackageWithOptions(targetSrc, targetAsarPath, {});
  const [baseAsarBytes, targetAsarBytes, baseHeader, targetHeader] = await Promise.all([
    readFile(baseAsarPath),
    readFile(targetAsarPath),
    readAsarHeaderInfo(baseAsarPath),
    readAsarHeaderInfo(targetAsarPath),
  ]);

  const rbdAsarDelta = createDeltaBuffer(baseAsarBytes, targetAsarBytes);
  const rawRbd = gunzipSync(rbdAsarDelta);
  assert.equal(rawRbd.subarray(0, 4).toString('ascii'), 'RBD1');
  const gbdAsarDelta = gzipSync(Buffer.concat([Buffer.from('GBD1', 'ascii'), rawRbd.subarray(4)]));

  for (const [label, deltaBytes] of [['RBD1', rbdAsarDelta], ['GBD1', gbdAsarDelta]]) {
    const appDir = path.join(dir, `app-${label}`);
    const resourcesDir = path.join(appDir, 'resources');
    const profileDir = path.join(dir, `profile-${label}`);
    await mkdir(resourcesDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(resourcesDir, 'app.asar'), baseAsarBytes);
    const execPath = path.join(appDir, 'Grok Bot.exe');
    const syntheticExe = Buffer.from(`MZ...[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${baseHeader.headerSha256}"}]...`, 'latin1');
    await writeFile(execPath, syntheticExe);

    const unsigned = {
      schema: DESKTOP_UPDATE_SCHEMA,
      platform: 'windows',
      track: 'stable',
      version: '1.2.4',
      sha256: sha(Buffer.from('full-setup-1.2.4')),
      size: 16,
      url: 'https://host.example/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe',
      publishedAt: '2026-11-19T12:00:00.000Z',
      asarDeltas: [{
        baseSha256: sha(baseAsarBytes),
        baseSize: baseAsarBytes.length,
        baseHeaderSha256: baseHeader.headerSha256,
        targetSha256: sha(targetAsarBytes),
        targetSize: targetAsarBytes.length,
        targetHeaderSha256: targetHeader.headerSha256,
        sha256: sha(deltaBytes),
        size: deltaBytes.length,
        url: `/local/updates/files/windows/1.2.4-${label}.rbdelta`,
      }],
    };
    const manifest = {
      schema: DESKTOP_UPDATE_SCHEMA,
      platform: 'windows',
      track: 'stable',
      signatureAlgorithm: 'ecdsa-p256-sha256',
      signature: sign('sha256', Buffer.from(canonicalDesktopPayload(unsigned), 'utf8'), privateKey).toString('base64'),
      deltasSignature: sign('sha256', Buffer.from(canonicalDesktopDeltasPayload(unsigned), 'utf8'), privateKey).toString('base64'),
      publicKeyPem: pubPem,
      latest: unsigned,
    };

    const fetched = [];
    const updater = createDesktopUpdater({
      appVersion: '1.2.3',
      platformId: 'win32-x64',
      profileDir,
      resourcesDir,
      execPath,
      onInstallAsar: async () => {},
      config: {
        updateUrl: 'https://host.example/local/updates',
        feedFile: 'windows.json',
        allowOrigin: 'https://host.example',
        hostOrigin: 'https://host.example',
        allowHostManifestKey: true,
      },
      fetchImpl: async url => {
        fetched.push(url);
        if (url.includes('/local/updates/windows.json')) return new Response(JSON.stringify(manifest), { status: 200 });
        if (url.includes(`.rbdelta`)) return new Response(deltaBytes, { status: 200, headers: { 'content-length': String(deltaBytes.length) } });
        throw new Error(`Unexpected fetch for ${label}: ${url}`);
      },
    });

    const res = await updater.check();
    assert.equal(res.state.type, 'ready');
    assert.equal(res.state.version, '1.2.4');
    assert.equal(fetched.some(u => u.includes('/local/updates/windows.json')), true);
    assert.equal(fetched.some(u => u.includes(`1.2.4-${label}.rbdelta`)), true);

    const reconstructedPath = path.join(profileDir, 'updates', 'asar-stable-1.2.4.asar');
    const reconstructedBytes = await readFile(reconstructedPath);
    assert.equal(sha(reconstructedBytes), sha(targetAsarBytes));
    assert.equal((await readAsarHeaderInfo(reconstructedPath)).headerSha256, targetHeader.headerSha256);

    const peUpdated = replaceAsarIntegrity(syntheticExe, baseHeader.headerSha256, targetHeader.headerSha256);
    const helperUpdated = replaceWindowsAsarIntegrityHex(syntheticExe, baseHeader.headerSha256, targetHeader.headerSha256);
    assert.equal(peUpdated.equals(helperUpdated), true);
    assert.equal(peUpdated.toString('latin1').includes(targetHeader.headerSha256), true);
  }
});

test('ROKBOT_DESKTOP_DOWNLOAD_BASE overrides Windows official installer URLs and enforces strict validation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-win-mirror-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const supportedCurrent = JSON.parse(await readFile(path.join(windowsRoot, 'patchers/desktop/supported.json'), 'utf8'));
  const supported0712 = JSON.parse(await readFile(path.join(windowsRoot, 'patchers/desktop/0.71.2/supported.json'), 'utf8'));
  assert.equal(supportedCurrent.version, '1.3.0');

  assert.equal(
    resolveDesktopDownloadUrl(supportedCurrent.archive.url, 'https://mirror.rokbot.example/desktop///'),
    `https://mirror.rokbot.example/desktop/win32-x64/${supportedCurrent.version}/Grok_Bot_${supportedCurrent.version}_Setup.exe`,
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
    assert.throws(() => resolveDesktopDownloadUrl(supportedCurrent.archive.url, invalid), /ROKBOT_DESKTOP_DOWNLOAD_BASE/);
  }

  const fakePayload = Buffer.from('synthetic-windows-setup-payload');
  const fakeSupported = {
    version: supportedCurrent.version,
    archive: {
      url: supportedCurrent.archive.url,
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
  assert.equal(path.basename(cachedFile), `Grok_Bot_${supportedCurrent.version}_Setup.exe`);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `https://mirror.rokbot.example/desktop/win32-x64/${supportedCurrent.version}/Grok_Bot_${supportedCurrent.version}_Setup.exe`,
  );
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

test('pe.replaceResources replaces RT_ICON, RT_GROUP_ICON, and RT_VERSION while preserving other resources and shifting .reloc', async () => {
  const { icoPath } = resolveRokBotWindowsLogoPaths(repoRoot);
  const rokbotIco = await readFile(icoPath);
  const rokbot256Png = await readFile(path.join(repoRoot, 'assets/logo/rokbot-icon-256.png'));

  // 1. Real PE (rokbot-setup-stub.exe, where .rsrc is the last section): replace icon cleanly.
  const stub = await readFile(resolveSetupStubSource(windowsRoot));
  const patchedStub = replaceResources(stub, { ico: rokbotIco });
  assert.equal(applicationIcon(patchedStub).ico.equals(rokbotIco), true);
  assert.equal(applicationIcon(patchedStub).png.equals(rokbot256Png), true);

  // 2. Synthetic 64-bit PE with .text, .rsrc (icon + RT_VERSION + RT_MANIFEST), .reloc, and Authenticode.
  const align4 = v => (v + 3) & ~3;
  const encodeVersionNode = (key, type, value, children = []) => {
    const keyBuf = Buffer.from(`${key}\0`, 'utf16le');
    const hdrLen = align4(6 + keyBuf.length);
    const valWords = type === 1 ? value.length / 2 : value.length;
    const parts = [Buffer.alloc(hdrLen)];
    keyBuf.copy(parts[0], 6);
    if (value.length) parts.push(value);
    let cur = hdrLen + value.length;
    if (children.length) {
      const pad = align4(cur) - cur;
      if (pad) { parts.push(Buffer.alloc(pad)); cur += pad; }
      children.forEach((child, i) => {
        if (i > 0) {
          const spad = align4(cur) - cur;
          if (spad) { parts.push(Buffer.alloc(spad)); cur += spad; }
        }
        parts.push(child);
        cur += child.length;
      });
    }
    const out = Buffer.concat(parts);
    out.writeUInt16LE(out.length, 0);
    out.writeUInt16LE(valWords, 2);
    out.writeUInt16LE(type, 4);
    return out;
  };
  const verStr = (k, v) => encodeVersionNode(k, 1, Buffer.from(`${v}\0`, 'utf16le'));
  const fixedInfo = Buffer.alloc(52);
  fixedInfo.writeUInt32LE(0xfeef04bd, 0);
  const stringTable = encodeVersionNode('040904b0', 1, Buffer.alloc(0), [
    verStr('CompanyName', 'xAI'),
    verStr('FileDescription', 'Grok Bot'),
    verStr('FileVersion', '1.2.3'),
    verStr('InternalName', 'Grok Bot'),
    verStr('LegalCopyright', 'Copyright xAI'),
    verStr('OriginalFilename', 'Grok Bot.exe'),
    verStr('ProductName', 'Grok Bot'),
    verStr('ProductVersion', '1.2.3'),
  ]);
  const stringFileInfo = encodeVersionNode('StringFileInfo', 1, Buffer.alloc(0), [stringTable]);
  const translation = encodeVersionNode('Translation', 0, Buffer.from([0x09, 0x04, 0xb0, 0x04]));
  const varFileInfo = encodeVersionNode('VarFileInfo', 1, Buffer.alloc(0), [translation]);
  const oldVersionBytes = encodeVersionNode('VS_VERSION_INFO', 0, fixedInfo, [stringFileInfo, varFileInfo]);

  const oldIconPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const oldGroup = Buffer.alloc(6 + 14);
  oldGroup.writeUInt16LE(1, 2);
  oldGroup.writeUInt16LE(1, 4);
  oldGroup[6] = 16; oldGroup[7] = 16;
  oldGroup.writeUInt32LE(oldIconPng.length, 6 + 8);
  oldGroup.writeUInt16LE(1, 6 + 12);
  const manifestXml = Buffer.from('<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"/>', 'utf8');

  // Build minimal .rsrc with RT_ICON(3), RT_GROUP_ICON(14), RT_VERSION(16), RT_MANIFEST(24) at VA 0x2000.
  const rsrcVa = 0x2000;
  const rsrcRawOff = 0x400;
  const items = [
    { type: 3, id: 1, data: oldIconPng },
    { type: 14, id: 101, data: oldGroup },
    { type: 16, id: 1, data: oldVersionBytes },
    { type: 24, id: 1, data: manifestXml },
  ];
  const rootSize = 16 + items.length * 8;
  const typeDirSize = 16 + 8;
  const langDirSize = 16 + 8;
  const dataEntrySize = 16;
  const headerSize = rootSize + items.length * (typeDirSize + langDirSize + dataEntrySize);
  let cursor = align4(headerSize);
  const offsets = items.map(it => { const at = cursor; cursor = align4(cursor + it.data.length); return at; });
  const rsrcBuf = Buffer.alloc(cursor);
  rsrcBuf.writeUInt16LE(items.length, 14);
  items.forEach((it, idx) => {
    const typeDirAt = rootSize + idx * typeDirSize;
    const langDirAt = rootSize + items.length * typeDirSize + idx * langDirSize;
    const entryAt = rootSize + items.length * (typeDirSize + langDirSize) + idx * dataEntrySize;
    rsrcBuf.writeUInt32LE(it.type, 16 + idx * 8);
    rsrcBuf.writeUInt32LE((0x80000000 | typeDirAt) >>> 0, 16 + idx * 8 + 4);
    rsrcBuf.writeUInt16LE(1, typeDirAt + 14);
    rsrcBuf.writeUInt32LE(it.id, typeDirAt + 16);
    rsrcBuf.writeUInt32LE((0x80000000 | langDirAt) >>> 0, typeDirAt + 20);
    rsrcBuf.writeUInt16LE(1, langDirAt + 14);
    rsrcBuf.writeUInt32LE(0x0409, langDirAt + 16);
    rsrcBuf.writeUInt32LE(entryAt, langDirAt + 20);
    rsrcBuf.writeUInt32LE(rsrcVa + offsets[idx], entryAt);
    rsrcBuf.writeUInt32LE(it.data.length, entryAt + 4);
    it.data.copy(rsrcBuf, offsets[idx]);
  });

  const rsrcRawSize = Math.ceil(rsrcBuf.length / 0x200) * 0x200;
  const relocVa = 0x3000;
  const relocRawOff = rsrcRawOff + rsrcRawSize;
  const relocBytes = Buffer.from([0x00, 0x10, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const relocRawSize = 0x200;
  const certOff = relocRawOff + relocRawSize;
  const certBytes = Buffer.from('FAKE-AUTH-CERT');

  const peBuf = Buffer.alloc(certOff + certBytes.length);
  peBuf.write('MZ', 0, 'latin1');
  peBuf.writeUInt32LE(0x80, 0x3c);
  peBuf.write('PE\0\0', 0x80, 'latin1');
  peBuf.writeUInt16LE(3, 0x80 + 6); // 3 sections: .text, .rsrc, .reloc
  const optSize = 240;
  peBuf.writeUInt16LE(optSize, 0x80 + 20);
  const opt = 0x80 + 24;
  peBuf.writeUInt16LE(0x20b, opt);
  peBuf.writeUInt32LE(rsrcRawSize + relocRawSize, opt + 8); // SizeOfInitializedData
  peBuf.writeUInt32LE(0x1000, opt + 32); // SectionAlignment
  peBuf.writeUInt32LE(0x200, opt + 36); // FileAlignment
  peBuf.writeUInt32LE(0x4000, opt + 56); // SizeOfImage
  const dirs = opt + 112;
  peBuf.writeUInt32LE(rsrcVa, dirs + 2 * 8);
  peBuf.writeUInt32LE(rsrcBuf.length, dirs + 2 * 8 + 4);
  peBuf.writeUInt32LE(certOff, dirs + 4 * 8);
  peBuf.writeUInt32LE(certBytes.length, dirs + 4 * 8 + 4);
  peBuf.writeUInt32LE(relocVa, dirs + 5 * 8);
  peBuf.writeUInt32LE(relocBytes.length, dirs + 5 * 8 + 4);

  const secAt = opt + optSize;
  const writeSec = (idx, name, vsize, va, rsize, roff) => {
    const at = secAt + idx * 40;
    peBuf.write(name, at, 'ascii');
    peBuf.writeUInt32LE(vsize, at + 8);
    peBuf.writeUInt32LE(va, at + 12);
    peBuf.writeUInt32LE(rsize, at + 16);
    peBuf.writeUInt32LE(roff, at + 20);
  };
  writeSec(0, '.text', 0x100, 0x1000, 0x200, 0x200);
  writeSec(1, '.rsrc', rsrcBuf.length, rsrcVa, rsrcRawSize, rsrcRawOff);
  writeSec(2, '.reloc', relocBytes.length, relocVa, relocRawSize, relocRawOff);
  rsrcBuf.copy(peBuf, rsrcRawOff);
  relocBytes.copy(peBuf, relocRawOff);
  certBytes.copy(peBuf, certOff);

  assert.equal(hasAuthenticode(peBuf), true);
  assert.equal(versionInfo(peBuf).ProductName, 'Grok Bot');

  const patchedPe = replaceResources(peBuf, {
    ico: rokbotIco,
    versionStrings: WINDOWS_PE_VERSION_STRINGS,
  });
  assert.equal(hasAuthenticode(patchedPe), false);
  assert.equal(applicationIcon(patchedPe).ico.equals(rokbotIco), true);
  assert.equal(applicationIcon(patchedPe).png.equals(rokbot256Png), true);
  assert.deepEqual(versionInfo(patchedPe), {
    CompanyName: 'RokBot',
    FileDescription: 'RokBot Local',
    FileVersion: '1.2.3',
    InternalName: 'RokBot Local',
    LegalCopyright: 'RokBot',
    OriginalFilename: 'RokBot Local.exe',
    ProductName: 'RokBot Local',
    ProductVersion: '1.2.3',
  });
  // Verify RT_MANIFEST was preserved and .reloc was shifted cleanly.
  assert.equal(patchedPe.includes(manifestXml), true);
  const newRelocVa = patchedPe.readUInt32LE(dirs + 5 * 8);
  assert.ok(newRelocVa > relocVa);
  assert.equal(patchedPe.readUInt32LE(secAt + 2 * 40 + 12), newRelocVa);
  assert.ok(patchedPe.readUInt32LE(opt + 56) >= newRelocVa + relocRawSize);
});

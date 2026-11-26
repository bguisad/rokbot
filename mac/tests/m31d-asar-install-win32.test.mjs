import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WINDOWS_INSTALLER_RECEIPTS,
  applyAsarUpdateAndRestart,
  canApplyAsarUpdate,
  isWindowsInstallerManaged,
} from '../clients/desktop/asar-install.mjs';
import {
  DESKTOP_UPDATE_SCHEMA,
  canonicalDesktopPayload,
  createDesktopUpdater,
  createTailcatUpdateFetch,
  resolveDesktopUpdateSource,
} from '../clients/desktop/updater.mjs';
import { canonicalDesktopDeltasPayload, createDeltaBuffer } from '../clients/shared/delta.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey,
    pem: publicKey.export({ format: 'pem', type: 'spki' }),
    spkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

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
    headerSha256: sha(json),
    sha256: sha(buf),
  };
}

function makeFakeWinExe(headerHash = 'a'.repeat(64)) {
  return Buffer.from(
    `MZ\x90\x00FAKEPE[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${headerHash}"}]TRAILER`,
    'latin1',
  );
}

async function createWinLayout(root, { exeHash = 'a'.repeat(64), asarBytes = Buffer.from('asar-bytes') } = {}) {
  const resourcesDir = path.join(root, 'resources');
  const execPath = path.join(root, 'Grok Bot.exe');
  const asarPath = path.join(resourcesDir, 'app.asar');
  await mkdir(resourcesDir, { recursive: true });
  await writeFile(execPath, makeFakeWinExe(exeHash));
  await writeFile(asarPath, asarBytes);
  return { resourcesDir, execPath, asarPath };
}

function makeStandardReceipt(installDir, { exeHash, asarHash, sideBySideOf } = {}) {
  const receipt = {
    format: 1,
    appId: 'dev.rokbot.local',
    directory: installDir,
    rootId: { volume: 1, index: 2, birth: 3 },
    createdRoot: true,
    ...(sideBySideOf ? { sideBySideOf } : {}),
    files: [
      { path: 'Grok Bot.exe', sha256: exeHash },
      { path: 'Uninstall RokBot Local.exe', sha256: 'b'.repeat(64) },
      { path: 'resources/app.asar', sha256: asarHash },
      { path: 'resources/rokbot-local.patch.json', sha256: 'c'.repeat(64) },
    ],
    dirs: [{ path: 'resources', id: { volume: 1, index: 4, birth: 5 } }],
  };
  return JSON.stringify(receipt, null, 2);
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('win32 installer-managed receipts block canApplyAsarUpdate and are detected by isWindowsInstallerManaged', async t => {
  assert.deepEqual(WINDOWS_INSTALLER_RECEIPTS, ['.rokbot-installation.json', '.grokbot-installation.json']);

  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-receipts-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  // 1) Standard schema .rokbot-installation.json in <installRoot>
  const stdRoot = path.join(base, 'standard');
  const std = await createWinLayout(stdRoot);
  await writeFile(
    path.join(stdRoot, '.rokbot-installation.json'),
    makeStandardReceipt(stdRoot, {
      exeHash: sha(await readFile(std.execPath)),
      asarHash: sha(await readFile(std.asarPath)),
    }),
  );
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: std.resourcesDir, execPath: std.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: std.resourcesDir, execPath: std.execPath, platform: 'win32' }), false);

  // 2) sideBySideOf receipt
  const sbsRoot = path.join(base, 'side-by-side');
  const sbs = await createWinLayout(sbsRoot);
  await writeFile(
    path.join(sbsRoot, '.rokbot-installation.json'),
    makeStandardReceipt(sbsRoot, {
      exeHash: sha(await readFile(sbs.execPath)),
      asarHash: sha(await readFile(sbs.asarPath)),
      sideBySideOf: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Grok Bot',
    }),
  );
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: sbs.resourcesDir, execPath: sbs.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: sbs.resourcesDir, execPath: sbs.execPath, platform: 'win32' }), false);

  // 3) Legacy .grokbot-installation.json
  const legacyRoot = path.join(base, 'legacy-receipt');
  const legacy = await createWinLayout(legacyRoot);
  await writeFile(path.join(legacyRoot, '.grokbot-installation.json'), '{"format":1}');
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: legacy.resourcesDir, execPath: legacy.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: legacy.resourcesDir, execPath: legacy.execPath, platform: 'win32' }), false);

  // 4) Empty file and malformed JSON receipt -> fail closed
  const emptyRoot = path.join(base, 'empty-receipt');
  const empty = await createWinLayout(emptyRoot);
  await writeFile(path.join(emptyRoot, '.rokbot-installation.json'), '');
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: empty.resourcesDir, execPath: empty.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: empty.resourcesDir, execPath: empty.execPath, platform: 'win32' }), false);

  const malformedRoot = path.join(base, 'malformed-receipt');
  const malformed = await createWinLayout(malformedRoot);
  await writeFile(path.join(malformedRoot, '.rokbot-installation.json'), '{not-valid-json');
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: malformed.resourcesDir, execPath: malformed.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: malformed.resourcesDir, execPath: malformed.execPath, platform: 'win32' }), false);

  // 5) Directory named .rokbot-installation.json -> fail closed
  const dirReceiptRoot = path.join(base, 'dir-receipt');
  const dirReceipt = await createWinLayout(dirReceiptRoot);
  await mkdir(path.join(dirReceiptRoot, '.rokbot-installation.json'));
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: dirReceipt.resourcesDir, execPath: dirReceipt.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: dirReceipt.resourcesDir, execPath: dirReceipt.execPath, platform: 'win32' }), false);

  // 6) Valid symlink and dangling symlink named .rokbot-installation.json -> fail closed
  const validSymRoot = path.join(base, 'valid-symlink-receipt');
  const validSym = await createWinLayout(validSymRoot);
  await writeFile(path.join(base, 'target-receipt.json'), '{"format":1}');
  await symlink(path.join(base, 'target-receipt.json'), path.join(validSymRoot, '.rokbot-installation.json'));
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: validSym.resourcesDir, execPath: validSym.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: validSym.resourcesDir, execPath: validSym.execPath, platform: 'win32' }), false);

  const danglingSymRoot = path.join(base, 'dangling-symlink-receipt');
  const danglingSym = await createWinLayout(danglingSymRoot);
  await symlink(path.join(base, 'does-not-exist.json'), path.join(danglingSymRoot, '.rokbot-installation.json'));
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: danglingSym.resourcesDir, execPath: danglingSym.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: danglingSym.resourcesDir, execPath: danglingSym.execPath, platform: 'win32' }), false);
});

test('win32 layout edge cases: split paths, symlinks into managed root, missing args, and non-ENOENT stat errors', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-edges-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const managedRoot = path.join(base, 'managed-root');
  const unmanagedRoot = path.join(base, 'unmanaged-root');
  const managed = await createWinLayout(managedRoot);
  const unmanaged = await createWinLayout(unmanagedRoot);
  await writeFile(path.join(managedRoot, '.rokbot-installation.json'), '{"format":1}');

  // Receipt only in path.dirname(resourcesDir)
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: managed.resourcesDir, execPath: unmanaged.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: managed.resourcesDir, execPath: unmanaged.execPath, platform: 'win32' }), false);

  // Receipt only in path.dirname(execPath)
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: unmanaged.resourcesDir, execPath: managed.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: unmanaged.resourcesDir, execPath: managed.execPath, platform: 'win32' }), false);

  // Single-argument isWindowsInstallerManaged
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: managed.resourcesDir }), true);
  assert.equal(await isWindowsInstallerManaged({ execPath: managed.execPath }), true);
  assert.equal(await isWindowsInstallerManaged(), false);

  // Symlinked execPath pointing into managed root
  const symExecDir = path.join(base, 'sym-exec-dir');
  await mkdir(symExecDir, { recursive: true });
  const symExecPath = path.join(symExecDir, 'Grok Bot.exe');
  await symlink(managed.execPath, symExecPath);
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: unmanaged.resourcesDir, execPath: symExecPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: unmanaged.resourcesDir, execPath: symExecPath, platform: 'win32' }), false);

  // Symlinked resourcesDir pointing into managed root
  const symResParent = path.join(base, 'sym-res-parent');
  await mkdir(symResParent, { recursive: true });
  const symResourcesDir = path.join(symResParent, 'resources');
  await symlink(managed.resourcesDir, symResourcesDir);
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: symResourcesDir, execPath: unmanaged.execPath }), true);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: symResourcesDir, execPath: unmanaged.execPath, platform: 'win32' }), false);

  // Symlinked parent directory pointing to managed root
  const symRootLink = path.join(base, 'sym-root-link');
  await symlink(managedRoot, symRootLink);
  assert.equal(
    await isWindowsInstallerManaged({
      resourcesDir: path.join(symRootLink, 'resources'),
      execPath: path.join(symRootLink, 'Grok Bot.exe'),
    }),
    true,
  );
  assert.equal(
    await canApplyAsarUpdate({
      resourcesDir: path.join(symRootLink, 'resources'),
      execPath: path.join(symRootLink, 'Grok Bot.exe'),
      platform: 'win32',
    }),
    false,
  );

  // Missing / empty args -> strict false
  assert.equal(await canApplyAsarUpdate(), false);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: '   ', execPath: unmanaged.execPath, platform: 'win32' }), false);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: unmanaged.resourcesDir, execPath: '', platform: 'win32' }), false);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: unmanaged.resourcesDir, execPath: unmanaged.execPath, platform: 'freebsd' }), false);

  // Non-ENOENT error (unreadable parent directory chmod 0o000 when non-root) -> fail closed
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const lockedRoot = path.join(base, 'locked-root');
    const locked = await createWinLayout(lockedRoot);
    await chmod(lockedRoot, 0o000);
    t.after(async () => {
      await chmod(lockedRoot, 0o755).catch(() => {});
    });
    assert.equal(await isWindowsInstallerManaged({ resourcesDir: unmanaged.resourcesDir, execPath: locked.execPath }), true);
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: unmanaged.resourcesDir, execPath: locked.execPath, platform: 'win32' }),
      false,
    );
    await chmod(lockedRoot, 0o755);
  }
});

test('win32 portable / unmanaged builds allow ASAR update and enforce integrity + writability checks', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-portable-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const portableRoot = path.join(base, 'portable');
  const portable = await createWinLayout(portableRoot);
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: portable.resourcesDir, execPath: portable.execPath }), false);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: portable.resourcesDir, execPath: portable.execPath, platform: 'win32' }), true);

  // Missing WIN_INTEGRITY_RE
  const noIntegrityRoot = path.join(base, 'no-integrity');
  const noIntegrity = await createWinLayout(noIntegrityRoot);
  await writeFile(noIntegrity.execPath, Buffer.from('MZ-NO-INTEGRITY-RECORD', 'latin1'));
  assert.equal(await canApplyAsarUpdate({ resourcesDir: noIntegrity.resourcesDir, execPath: noIntegrity.execPath, platform: 'win32' }), false);

  // Multiple WIN_INTEGRITY_RE records
  const multiIntegrityRoot = path.join(base, 'multi-integrity');
  const multiIntegrity = await createWinLayout(multiIntegrityRoot);
  const single = makeFakeWinExe('a'.repeat(64));
  await writeFile(multiIntegrity.execPath, Buffer.concat([single, single]));
  assert.equal(
    await canApplyAsarUpdate({ resourcesDir: multiIntegrity.resourcesDir, execPath: multiIntegrity.execPath, platform: 'win32' }),
    false,
  );

  // Non-writable resourcesDir (when non-root)
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    await chmod(portable.resourcesDir, 0o555);
    t.after(async () => {
      await chmod(portable.resourcesDir, 0o755).catch(() => {});
    });
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: portable.resourcesDir, execPath: portable.execPath, platform: 'win32' }),
      false,
    );
    await chmod(portable.resourcesDir, 0o755);
  }
});

test('applyAsarUpdateAndRestart defense-in-depth refuses installer-managed Windows roots with zero side effects', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-apply-guard-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const stagedDir = path.join(base, 'staged');
  await mkdir(stagedDir, { recursive: true });
  const stagedAsar = path.join(stagedDir, 'asar-stable-1.2.4.asar');
  await writeFile(stagedAsar, Buffer.from('new-asar-payload'));

  for (const receiptName of WINDOWS_INSTALLER_RECEIPTS) {
    const installRoot = path.join(base, `managed-${receiptName.replace(/\W+/g, '_')}`);
    const oldHash = '1'.repeat(64);
    const newHash = '2'.repeat(64);
    const initialAsar = Buffer.from('original-owned-app-asar');
    const layout = await createWinLayout(installRoot, { exeHash: oldHash, asarBytes: initialAsar });
    const exeBefore = await readFile(layout.execPath);
    const asarBefore = await readFile(layout.asarPath);
    await writeFile(path.join(installRoot, receiptName), '{"format":1}');

    let quitCalls = 0;
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile: stagedAsar,
        headerSha256: newHash,
        baseHeaderSha256: oldHash,
        version: '1.2.4',
        resourcesDir: layout.resourcesDir,
        execPath: layout.execPath,
        quitApp: () => { quitCalls += 1; },
        platform: 'win32',
      }),
      /installer-managed/i,
    );

    assert.equal(quitCalls, 0);
    assert.ok((await readFile(layout.execPath)).equals(exeBefore));
    assert.ok((await readFile(layout.asarPath)).equals(asarBefore));
    const entries = await readdir(stagedDir);
    assert.equal(entries.some(name => name.startsWith('apply-')), false, 'must not create apply-* staging directory');
  }

  // Missing resourcesDir/execPath and unsupported platform reject before touching stageRoot
  await assert.rejects(
    () => applyAsarUpdateAndRestart({
      asarFile: stagedAsar,
      version: '1.2.4',
      resourcesDir: '',
      execPath: '',
      quitApp: () => {},
      platform: 'win32',
    }),
    /Missing resourcesDir or execPath/,
  );
  await assert.rejects(
    () => applyAsarUpdateAndRestart({
      asarFile: stagedAsar,
      version: '1.2.4',
      quitApp: () => {},
      platform: 'freebsd',
    }),
    /unsupported on freebsd/i,
  );
  assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);

  // Portable win32 staging error (baseHeaderSha256 mismatch) cleans up apply-* stageRoot
  const portableRoot = path.join(base, 'portable-stage-err');
  const portable = await createWinLayout(portableRoot, { exeHash: 'a'.repeat(64) });
  await assert.rejects(
    () => applyAsarUpdateAndRestart({
      asarFile: stagedAsar,
      headerSha256: 'b'.repeat(64),
      baseHeaderSha256: 'c'.repeat(64),
      version: '1.2.4',
      resourcesDir: portable.resourcesDir,
      execPath: portable.execPath,
      quitApp: () => {},
      platform: 'win32',
    }),
    /Embedded Windows ASAR integrity mismatch/,
  );
  assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false, 'failed win32 staging must clean up apply-*');
});

test('createDesktopUpdater + canApplyAsarUpdate routes installer-managed Windows to Setup.exe/delta and portable to ASAR delta', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-updater-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const key = p256();

  const oldAsar = buildSyntheticAsar({ files: { 'index.js': { size: 100, offset: '0' } } }, 'X'.repeat(30000));
  const newAsar = buildSyntheticAsar(
    { files: { 'index.js': { size: 100, offset: '0' }, 'new.js': { size: 6, offset: '30000' } } },
    'X'.repeat(30000) + 'rokbot',
  );
  const asarDelta = createDeltaBuffer(oldAsar.bytes, newAsar.bytes);

  const sharedTail = Buffer.alloc(64 * 1024, 0x52);
  const oldInstaller = Buffer.concat([Buffer.from('SETUP-1.2.3-'), sharedTail, Buffer.from('-END')]);
  const fullSetup = Buffer.concat([Buffer.from('SETUP-1.2.4-'), sharedTail, Buffer.from('-PATCHED')]);
  const installerDelta = createDeltaBuffer(oldInstaller, fullSetup);

  const publishedAt = '2026-11-19T22:00:00.000Z';
  const flatForSign = {
    schema: DESKTOP_UPDATE_SCHEMA,
    platform: 'windows',
    track: 'stable',
    version: '1.2.4',
    sha256: sha(fullSetup),
    size: fullSetup.length,
    url: '/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe',
    publishedAt,
    deltas: [{
      baseSha256: sha(oldInstaller),
      baseSize: oldInstaller.length,
      sha256: sha(installerDelta),
      size: installerDelta.length,
      url: '/local/updates/files/windows/setup-1.2.4.rbdelta',
    }],
    asarDeltas: [{
      baseSha256: oldAsar.sha256,
      baseSize: oldAsar.bytes.length,
      baseHeaderSha256: oldAsar.headerSha256,
      targetSha256: newAsar.sha256,
      targetSize: newAsar.bytes.length,
      targetHeaderSha256: newAsar.headerSha256,
      sha256: sha(asarDelta),
      size: asarDelta.length,
      url: '/local/updates/files/windows/asar-1.2.4.rbdelta',
    }],
  };

  const windowsManifest = {
    schema: DESKTOP_UPDATE_SCHEMA,
    platform: 'windows',
    track: 'stable',
    publishedAt,
    signatureAlgorithm: 'ecdsa-p256-sha256',
    signature: sign('sha256', Buffer.from(canonicalDesktopPayload(flatForSign), 'utf8'), key.privateKey).toString('base64'),
    publicKeyPem: key.pem,
    latest: {
      version: '1.2.4',
      url: flatForSign.url,
      sha256: flatForSign.sha256,
      size: flatForSign.size,
      asarSha256: newAsar.sha256,
      asarHeaderSha256: newAsar.headerSha256,
      deltas: flatForSign.deltas,
      asarDeltas: flatForSign.asarDeltas,
      deltasSignature: sign('sha256', Buffer.from(canonicalDesktopDeltasPayload(flatForSign), 'utf8'), key.privateKey).toString('base64'),
    },
  };

  const requests = [];
  const srv = await startServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push(pathname);
    if (req.headers.authorization !== 'Bearer win-device-tok') {
      res.writeHead(401);
      res.end();
      return;
    }
    if (pathname === '/local/updates/windows.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(windowsManifest));
      return;
    }
    if (pathname === '/local/updates/files/windows/setup-1.2.4.rbdelta') {
      res.writeHead(200, { 'content-length': String(installerDelta.length) });
      res.end(installerDelta);
      return;
    }
    if (pathname === '/local/updates/files/windows/asar-1.2.4.rbdelta') {
      res.writeHead(200, { 'content-length': String(asarDelta.length) });
      res.end(asarDelta);
      return;
    }
    if (pathname === '/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe') {
      res.writeHead(200, { 'content-length': String(fullSetup.length) });
      res.end(fullSetup);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => srv.close());

  const hostFetch = createTailcatUpdateFetch({
    isTunneled: () => false,
    getServerUrl: () => srv.url,
    getToken: () => 'win-device-tok',
  });

  // Case A: Installer-managed + matching base-stable.exe -> installer .rbdelta only
  requests.length = 0;
  const managedRootA = path.join(base, 'managed-a');
  const layoutA = await createWinLayout(managedRootA, { exeHash: oldAsar.headerSha256, asarBytes: oldAsar.bytes });
  const exeBytesA = await readFile(layoutA.execPath);
  await writeFile(
    path.join(managedRootA, '.rokbot-installation.json'),
    makeStandardReceipt(managedRootA, { exeHash: sha(exeBytesA), asarHash: oldAsar.sha256 }),
  );
  const profileA = path.join(base, 'profile-a');
  await mkdir(path.join(profileA, 'updates'), { recursive: true });
  await writeFile(path.join(profileA, 'updates', 'base-stable.exe'), oldInstaller);

  const sourceA = await resolveDesktopUpdateSource({
    resourcesDir: layoutA.resourcesDir,
    profileDir: profileA,
    server: srv.url,
    platform: 'win32',
  });
  const fileInstallsA = [];
  const asarInstallsA = [];
  const updaterA = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'win32-x64',
    profileDir: profileA,
    resourcesDir: layoutA.resourcesDir,
    execPath: layoutA.execPath,
    config: sourceA,
    fetchImpl: hostFetch,
    canUseAsarUpdate: opts => canApplyAsarUpdate({ ...opts, platform: 'win32' }),
    onInstallAsar: async info => asarInstallsA.push(info),
    onInstallFile: async (file, version) => fileInstallsA.push({ file, version, bytes: await readFile(file) }),
  });

  const readyA = await updaterA.check();
  assert.equal(readyA.state.type, 'ready');
  assert.equal(requests.includes('/local/updates/files/windows/asar-1.2.4.rbdelta'), false);
  assert.equal(requests.includes('/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe'), false);
  assert.equal(requests.includes('/local/updates/files/windows/setup-1.2.4.rbdelta'), true);
  await updaterA.quitAndInstall({ expectedVersion: '1.2.4' });
  assert.equal(asarInstallsA.length, 0);
  assert.equal(fileInstallsA.length, 1);
  assert.ok(fileInstallsA[0].bytes.equals(fullSetup));
  assert.ok((await readFile(layoutA.asarPath)).equals(oldAsar.bytes));
  assert.ok((await readFile(layoutA.execPath)).equals(exeBytesA));

  // Case B: Installer-managed + no base installer -> full Setup.exe (0 asarDeltas requests)
  requests.length = 0;
  const profileB = path.join(base, 'profile-b');
  await mkdir(profileB, { recursive: true });
  const fileInstallsB = [];
  const asarInstallsB = [];
  const updaterB = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'win32-x64',
    profileDir: profileB,
    resourcesDir: layoutA.resourcesDir,
    execPath: layoutA.execPath,
    config: sourceA,
    fetchImpl: hostFetch,
    canUseAsarUpdate: opts => canApplyAsarUpdate({ ...opts, platform: 'win32' }),
    onInstallAsar: async info => asarInstallsB.push(info),
    onInstallFile: async (file, version) => fileInstallsB.push({ file, version, bytes: await readFile(file) }),
  });

  const readyB = await updaterB.check();
  assert.equal(readyB.state.type, 'ready');
  assert.equal(requests.includes('/local/updates/files/windows/asar-1.2.4.rbdelta'), false);
  assert.equal(requests.includes('/local/updates/files/windows/setup-1.2.4.rbdelta'), false);
  assert.equal(requests.includes('/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe'), true);
  await updaterB.quitAndInstall({ expectedVersion: '1.2.4' });
  assert.equal(asarInstallsB.length, 0);
  assert.equal(fileInstallsB.length, 1);
  assert.ok(fileInstallsB[0].bytes.equals(fullSetup));

  // Case C: Portable / unmanaged (no receipt) -> uses asarDeltas (0 requests to installer delta or full Setup.exe)
  requests.length = 0;
  const portableRoot = path.join(base, 'portable-c');
  const layoutC = await createWinLayout(portableRoot, { exeHash: oldAsar.headerSha256, asarBytes: oldAsar.bytes });
  const profileC = path.join(base, 'profile-c');
  await mkdir(path.join(profileC, 'updates'), { recursive: true });
  await writeFile(path.join(profileC, 'updates', 'base-stable.exe'), oldInstaller);

  const fileInstallsC = [];
  const asarInstallsC = [];
  const updaterC = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'win32-x64',
    profileDir: profileC,
    resourcesDir: layoutC.resourcesDir,
    execPath: layoutC.execPath,
    config: sourceA,
    fetchImpl: hostFetch,
    canUseAsarUpdate: opts => canApplyAsarUpdate({ ...opts, platform: 'win32' }),
    onInstallAsar: async info => asarInstallsC.push(info),
    onInstallFile: async (file, version) => fileInstallsC.push({ file, version, bytes: await readFile(file) }),
  });

  const readyC = await updaterC.check();
  assert.equal(readyC.state.type, 'ready');
  assert.equal(requests.includes('/local/updates/files/windows/asar-1.2.4.rbdelta'), true);
  assert.equal(requests.includes('/local/updates/files/windows/setup-1.2.4.rbdelta'), false);
  assert.equal(requests.includes('/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe'), false);
  await updaterC.quitAndInstall({ expectedVersion: '1.2.4' });
  assert.equal(fileInstallsC.length, 0);
  assert.equal(asarInstallsC.length, 1);
  assert.ok((await readFile(asarInstallsC[0].asarFile)).equals(newAsar.bytes));
  assert.equal(asarInstallsC[0].headerSha256, newAsar.headerSha256);
  assert.equal(asarInstallsC[0].baseHeaderSha256, oldAsar.headerSha256);
});

test('darwin RokBot.app ad-hoc bundle allows ASAR update even near Windows receipt, while /Volumes and non-.app reject', {
  skip: process.platform !== 'darwin',
}, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-darwin-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const appBundle = path.join(base, 'RokBot.app');
  const macosDir = path.join(appBundle, 'Contents', 'MacOS');
  const resourcesDir = path.join(appBundle, 'Contents', 'Resources');
  const execPath = path.join(macosDir, 'RokBot');
  await mkdir(macosDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });
  await writeFile(execPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(resourcesDir, 'app.asar'), 'synthetic-asar');
  await writeFile(
    path.join(appBundle, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>' +
      '<key>CFBundleExecutable</key><string>RokBot</string>' +
      '<key>CFBundleIdentifier</key><string>dev.rokbot.local</string>' +
      '<key>CFBundlePackageType</key><string>APPL</string>' +
      '</dict></plist>\n',
  );

  // Unsigned bundle must return false
  assert.equal(await canApplyAsarUpdate({ resourcesDir, execPath, platform: 'darwin' }), false);

  // Ad-hoc signed bundle in os.tmpdir() must return true
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'ignore' });
  assert.equal(await canApplyAsarUpdate({ resourcesDir, execPath, platform: 'darwin' }), true);

  // Even if Windows receipt files sit beside RokBot.app or Contents/, darwin must NOT block
  await writeFile(path.join(base, '.rokbot-installation.json'), '{"format":1}');
  await writeFile(path.join(appBundle, 'Contents', '.rokbot-installation.json'), '{"format":1}');
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'ignore' });
  assert.equal(await canApplyAsarUpdate({ resourcesDir, execPath, platform: 'darwin' }), true);

  // Non-.app path returns false
  const nonAppRes = path.join(base, 'PlainDir', 'Contents', 'Resources');
  const nonAppExec = path.join(base, 'PlainDir', 'Contents', 'MacOS', 'RokBot');
  await mkdir(nonAppRes, { recursive: true });
  await mkdir(path.dirname(nonAppExec), { recursive: true });
  await writeFile(nonAppExec, '');
  assert.equal(await canApplyAsarUpdate({ resourcesDir: nonAppRes, execPath: nonAppExec, platform: 'darwin' }), false);

  // /Volumes/... path returns false
  assert.equal(
    await canApplyAsarUpdate({
      resourcesDir: '/Volumes/RokBot/RokBot.app/Contents/Resources',
      execPath: '/Volumes/RokBot/RokBot.app/Contents/MacOS/RokBot',
      platform: 'darwin',
    }),
    false,
  );
});

test('win32 guard defeats <symlink>/../ traversal with and without trailing slashes', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-symdot-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const managed = path.join(base, 'managed');
  const managedSub = path.join(managed, 'sub');
  const decoy = path.join(base, 'decoy');
  const portable = path.join(base, 'portable');
  const stagedDir = path.join(base, 'staged');

  await mkdir(managedSub, { recursive: true });
  await mkdir(decoy, { recursive: true });
  await mkdir(stagedDir, { recursive: true });

  const layout = await createWinLayout(managed, { exeHash: '1'.repeat(64), asarBytes: Buffer.from('owned-asar') });
  const portableLayout = await createWinLayout(portable);
  await writeFile(path.join(managed, '.rokbot-installation.json'), '{"format":1}');

  const sublink = path.join(decoy, 'sublink');
  await symlink(managedSub, sublink);

  const stagedAsar = path.join(stagedDir, 'asar-1.2.4.asar');
  await writeFile(stagedAsar, Buffer.from('new-asar'));
  const exeBefore = await readFile(layout.execPath);
  const asarBefore = await readFile(layout.asarPath);

  const traversalPairs = [
    {
      resourcesDir: `${sublink}/../resources`,
      execPath: `${sublink}/../Grok Bot.exe`,
    },
    {
      resourcesDir: `${sublink}/../resources/`,
      execPath: `${sublink}/../Grok Bot.exe`,
    },
    {
      resourcesDir: `${sublink}/../resources///`,
      execPath: `${sublink}/.././Grok Bot.exe`,
    },
    {
      resourcesDir: `${sublink}/../resources`,
      execPath: portableLayout.execPath,
    },
    {
      resourcesDir: portableLayout.resourcesDir,
      execPath: `${sublink}/../Grok Bot.exe`,
    },
  ];

  for (const pair of traversalPairs) {
    assert.equal(await isWindowsInstallerManaged(pair), true);
    assert.equal(await canApplyAsarUpdate({ ...pair, platform: 'win32' }), false);

    let quitCalls = 0;
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile: stagedAsar,
        headerSha256: '2'.repeat(64),
        baseHeaderSha256: '1'.repeat(64),
        version: '1.2.4',
        ...pair,
        quitApp: () => { quitCalls += 1; },
        platform: 'win32',
      }),
      /installer-managed/i,
    );
    assert.equal(quitCalls, 0);
    assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);
  }

  assert.ok((await readFile(layout.execPath)).equals(exeBefore));
  assert.ok((await readFile(layout.asarPath)).equals(asarBefore));

  // Also verify <symlink>/../ when leaf target does NOT exist in managed root
  const managedNoLeaf = path.join(base, 'managed-no-leaf');
  const managedNoLeafSub = path.join(managedNoLeaf, 'sub');
  const decoyNoLeaf = path.join(base, 'decoy-no-leaf');
  await mkdir(managedNoLeafSub, { recursive: true });
  await mkdir(decoyNoLeaf, { recursive: true });
  await writeFile(path.join(managedNoLeaf, '.grokbot-installation.json'), '{"format":1}');
  const sublinkNoLeaf = path.join(decoyNoLeaf, 'sublink');
  await symlink(managedNoLeafSub, sublinkNoLeaf);
  assert.equal(
    await isWindowsInstallerManaged({
      resourcesDir: `${sublinkNoLeaf}/../resources/`,
      execPath: `${sublinkNoLeaf}/../Grok Bot.exe`,
    }),
    true,
  );
  assert.equal(
    await canApplyAsarUpdate({
      resourcesDir: `${sublinkNoLeaf}/../resources/`,
      execPath: `${sublinkNoLeaf}/../Grok Bot.exe`,
      platform: 'win32',
    }),
    false,
  );
});

test('exported guard and apply functions handle top-level null and primitive inputs cleanly', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-nulls-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  for (const invalid of [null, undefined, 123, 'str', true, false]) {
    assert.equal(await isWindowsInstallerManaged(invalid), false);
    assert.equal(await canApplyAsarUpdate(invalid), false);
  }

  for (const invalid of [null, 123, 'str', true]) {
    await assert.rejects(() => applyAsarUpdateAndRestart(invalid), /Invalid ASAR update options/);
  }
  await assert.rejects(() => applyAsarUpdateAndRestart(undefined), /Missing asarFile|unsupported/);
  assert.equal((await readdir(base)).some(name => name.startsWith('apply-')), false);
});

test('darwin applyAsarUpdateAndRestart validates inputs pre-staging and cleans up apply-* on failure', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-darwin-stage-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const stagedDir = path.join(base, 'staged');
  await mkdir(stagedDir, { recursive: true });
  const asarFile = path.join(stagedDir, 'asar-1.2.4.asar');
  await writeFile(asarFile, Buffer.from('new-darwin-asar'));

  // Null/empty resourcesDir on darwin rejects pre-staging with zero apply-* created
  for (const badResourcesDir of [null, undefined, '', '   ', 123]) {
    let quitCalls = 0;
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile,
        version: '1.2.4',
        resourcesDir: badResourcesDir,
        execPath: null,
        quitApp: () => { quitCalls += 1; },
        platform: 'darwin',
      }),
      /Missing resourcesDir for ASAR update/,
    );
    assert.equal(quitCalls, 0);
    assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);
  }

  // Invalid asarFile (non-string, empty, missing file, directory) rejects pre-staging with zero apply-* created
  for (const badAsar of [null, undefined, '', '   ', 123]) {
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile: badAsar,
        version: '1.2.4',
        resourcesDir: path.join(base, 'RokBot.app/Contents/Resources'),
        quitApp: () => {},
        platform: 'darwin',
      }),
      /Missing asarFile for ASAR update/,
    );
  }
  await assert.rejects(
    () => applyAsarUpdateAndRestart({
      asarFile: path.join(stagedDir, 'does-not-exist.asar'),
      version: '1.2.4',
      resourcesDir: path.join(base, 'RokBot.app/Contents/Resources'),
      quitApp: () => {},
      platform: 'darwin',
    }),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    () => applyAsarUpdateAndRestart({
      asarFile: stagedDir,
      version: '1.2.4',
      resourcesDir: path.join(base, 'RokBot.app/Contents/Resources'),
      quitApp: () => {},
      platform: 'darwin',
    }),
    /Missing asarFile for ASAR update/,
  );
  assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);

  // Runtime failure inside darwin staging (non-existent RokBot.app) cleans up apply-* stageRoot
  let darwinQuitCalls = 0;
  await assert.rejects(
    () => applyAsarUpdateAndRestart({
      asarFile,
      headerSha256: 'a'.repeat(64),
      version: '1.2.4',
      resourcesDir: path.join(base, 'Missing.app/Contents/Resources'),
      quitApp: () => { darwinQuitCalls += 1; },
      platform: 'darwin',
    }),
  );
  assert.equal(darwinQuitCalls, 0);
  assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);
});

test('win32 guard strips trailing /. and /./ segments before path.dirname on missing and symlinked resources', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-dotseg-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const stagedDir = path.join(base, 'staged');
  await mkdir(stagedDir, { recursive: true });
  const stagedAsar = path.join(stagedDir, 'asar-1.2.4.asar');
  await writeFile(stagedAsar, Buffer.from('new-asar'));

  const dotSuffixes = ['/.', '/./', '/././', '/.///', '///.///'];

  // 1) Missing resources leaf in managed root + portable execPath (so only resourcesDir triggers the guard)
  const managedMissing = path.join(base, 'managed-missing');
  const managedMissingSub = path.join(managedMissing, 'sub');
  const decoyMissing = path.join(base, 'decoy-missing');
  const portable = path.join(base, 'portable');
  await mkdir(managedMissingSub, { recursive: true });
  await mkdir(decoyMissing, { recursive: true });
  await writeFile(path.join(managedMissing, '.rokbot-installation.json'), '{"format":1}');
  const sublinkMissing = path.join(decoyMissing, 'sublink');
  await symlink(managedMissingSub, sublinkMissing);
  const portableLayout = await createWinLayout(portable);

  for (const suffix of dotSuffixes) {
    const resourcesDir = `${sublinkMissing}/../resources${suffix}`;
    assert.equal(await isWindowsInstallerManaged({ resourcesDir }), true, `single-arg missing leaf: ${suffix}`);
    assert.equal(
      await isWindowsInstallerManaged({ resourcesDir, execPath: portableLayout.execPath }),
      true,
      `split missing leaf: ${suffix}`,
    );
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir, execPath: portableLayout.execPath, platform: 'win32' }),
      false,
      `canApplyAsarUpdate missing leaf: ${suffix}`,
    );

    let quitCalls = 0;
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile: stagedAsar,
        headerSha256: '2'.repeat(64),
        baseHeaderSha256: 'a'.repeat(64),
        version: '1.2.4',
        resourcesDir,
        execPath: portableLayout.execPath,
        quitApp: () => { quitCalls += 1; },
        platform: 'win32',
      }),
      /installer-managed/i,
    );
    assert.equal(quitCalls, 0);
    assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);
  }

  // 2) Symlinked managed/resources -> external/resources with execPath inside external/
  const managedSym = path.join(base, 'managed-sym');
  const managedSymSub = path.join(managedSym, 'sub');
  const decoySym = path.join(base, 'decoy-sym');
  const external = path.join(base, 'external');
  await mkdir(managedSymSub, { recursive: true });
  await mkdir(decoySym, { recursive: true });
  await writeFile(path.join(managedSym, '.rokbot-installation.json'), '{"format":1}');
  const externalLayout = await createWinLayout(external, { exeHash: '1'.repeat(64), asarBytes: Buffer.from('external-asar') });
  await symlink(externalLayout.resourcesDir, path.join(managedSym, 'resources'));
  const sublinkSym = path.join(decoySym, 'sublink');
  await symlink(managedSymSub, sublinkSym);

  // Baseline: external itself is unmanaged/portable so canApplyAsarUpdate is genuinely true without the managed parent
  assert.equal(
    await isWindowsInstallerManaged({ resourcesDir: externalLayout.resourcesDir, execPath: externalLayout.execPath }),
    false,
  );
  assert.equal(
    await canApplyAsarUpdate({ resourcesDir: externalLayout.resourcesDir, execPath: externalLayout.execPath, platform: 'win32' }),
    true,
  );

  const extExeBefore = await readFile(externalLayout.execPath);
  const extAsarBefore = await readFile(externalLayout.asarPath);

  for (const suffix of dotSuffixes) {
    const resourcesDir = `${sublinkSym}/../resources${suffix}`;
    assert.equal(
      await isWindowsInstallerManaged({ resourcesDir, execPath: externalLayout.execPath }),
      true,
      `symlinked resources: ${suffix}`,
    );
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir, execPath: externalLayout.execPath, platform: 'win32' }),
      false,
      `canApplyAsarUpdate symlinked resources: ${suffix}`,
    );

    let quitCalls = 0;
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile: stagedAsar,
        headerSha256: '2'.repeat(64),
        baseHeaderSha256: '1'.repeat(64),
        version: '1.2.4',
        resourcesDir,
        execPath: externalLayout.execPath,
        quitApp: () => { quitCalls += 1; },
        platform: 'win32',
      }),
      /installer-managed/i,
    );
    assert.equal(quitCalls, 0);
    assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);
  }

  assert.ok((await readFile(externalLayout.execPath)).equals(extExeBefore));
  assert.ok((await readFile(externalLayout.asarPath)).equals(extAsarBefore));

  // 3) Root/dot path boundary checks do not regress
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: '/.' }), false);
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: '/./' }), false);
  assert.equal(await canApplyAsarUpdate({ resourcesDir: '/.', execPath: '/Grok Bot.exe', platform: 'win32' }), false);
});

test('win32 guard defeats intermediate <existing-subdir>/.. after symlinked resources and routes updater E2E to Setup.exe', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-subdir-dotdot-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const stagedDir = path.join(base, 'staged');
  await mkdir(stagedDir, { recursive: true });
  const stagedAsar = path.join(stagedDir, 'asar-1.2.4.asar');
  await writeFile(stagedAsar, Buffer.from('new-asar'));

  const oldAsar = buildSyntheticAsar({ files: { 'index.js': { size: 100, offset: '0' } } }, 'X'.repeat(30000));
  const newAsar = buildSyntheticAsar(
    { files: { 'index.js': { size: 100, offset: '0' }, 'new.js': { size: 6, offset: '30000' } } },
    'X'.repeat(30000) + 'rokbot',
  );

  for (const receiptName of WINDOWS_INSTALLER_RECEIPTS) {
    const caseRoot = path.join(base, `case-${receiptName.replace(/\W+/g, '_')}`);
    const managed = path.join(caseRoot, 'managed');
    const managedSub = path.join(managed, 'sub');
    const decoy = path.join(caseRoot, 'decoy');
    const external = path.join(caseRoot, 'external');
    await mkdir(managedSub, { recursive: true });
    await mkdir(decoy, { recursive: true });
    await writeFile(path.join(managed, receiptName), '{"format":1}');

    const externalLayout = await createWinLayout(external, { exeHash: oldAsar.headerSha256, asarBytes: oldAsar.bytes });
    await mkdir(path.join(externalLayout.resourcesDir, 'app.asar.unpacked', 'dist', 'native'), { recursive: true });
    await symlink(externalLayout.resourcesDir, path.join(managed, 'resources'));
    const sublink = path.join(decoy, 'sublink');
    await symlink(managedSub, sublink);
    const reslink = path.join(decoy, 'reslink');
    await symlink(path.join(managed, 'resources'), reslink);

    // Non-vacuous baseline: external/ directly is unmanaged and allows ASAR updates.
    assert.equal(
      await isWindowsInstallerManaged({ resourcesDir: externalLayout.resourcesDir, execPath: externalLayout.execPath }),
      false,
    );
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: externalLayout.resourcesDir, execPath: externalLayout.execPath, platform: 'win32' }),
      true,
    );

    const extExeBefore = await readFile(externalLayout.execPath);
    const extAsarBefore = await readFile(externalLayout.asarPath);
    const extDirBefore = (await readdir(externalLayout.resourcesDir)).sort();

    const vectors = [
      `${sublink}/../resources/app.asar.unpacked/..`,
      `${sublink}/../resources/app.asar.unpacked/../.`,
      `${sublink}/../resources/app.asar.unpacked/.././`,
      `${sublink}/../resources/app.asar.unpacked/dist/native/../..`,
      `${sublink}/../resources/app.asar.unpacked/dist/native/../../..`,
      `${sublink}/../resources/./app.asar.unpacked/../.`,
      `  ${sublink}/../resources/app.asar.unpacked/../.  `,
      `${reslink}/app.asar.unpacked/..`,
      `${reslink}/app.asar.unpacked/../.`,
    ];

    for (const resourcesDir of vectors) {
      assert.equal(await isWindowsInstallerManaged({ resourcesDir }), true, `single-arg: ${resourcesDir}`);
      assert.equal(
        await isWindowsInstallerManaged({ resourcesDir, execPath: externalLayout.execPath }),
        true,
        `split: ${resourcesDir}`,
      );
      assert.equal(
        await canApplyAsarUpdate({ resourcesDir, execPath: externalLayout.execPath, platform: 'win32' }),
        false,
        `canApplyAsarUpdate: ${resourcesDir}`,
      );

      let quitCalls = 0;
      await assert.rejects(
        () => applyAsarUpdateAndRestart({
          asarFile: stagedAsar,
          headerSha256: newAsar.headerSha256,
          baseHeaderSha256: oldAsar.headerSha256,
          version: '1.2.4',
          resourcesDir,
          execPath: externalLayout.execPath,
          quitApp: () => { quitCalls += 1; },
          platform: 'win32',
        }),
        /installer-managed/i,
      );
      assert.equal(quitCalls, 0);
      assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);
    }

    assert.ok((await readFile(externalLayout.execPath)).equals(extExeBefore));
    assert.ok((await readFile(externalLayout.asarPath)).equals(extAsarBefore));
    assert.deepEqual((await readdir(externalLayout.resourcesDir)).sort(), extDirBefore);
  }

  // E2E createDesktopUpdater routing: baseline external/ uses ASAR delta; traversal vectors fall back to Setup.exe / installer delta.
  const key = p256();
  const asarDelta = createDeltaBuffer(oldAsar.bytes, newAsar.bytes);
  const sharedTail = Buffer.alloc(64 * 1024, 0x53);
  const oldInstaller = Buffer.concat([Buffer.from('SETUP-1.2.3-'), sharedTail, Buffer.from('-END')]);
  const fullSetup = Buffer.concat([Buffer.from('SETUP-1.2.4-'), sharedTail, Buffer.from('-PATCHED')]);
  const installerDelta = createDeltaBuffer(oldInstaller, fullSetup);
  const publishedAt = '2026-11-20T01:00:00.000Z';
  const flatForSign = {
    schema: DESKTOP_UPDATE_SCHEMA,
    platform: 'windows',
    track: 'stable',
    version: '1.2.4',
    sha256: sha(fullSetup),
    size: fullSetup.length,
    url: '/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe',
    publishedAt,
    deltas: [{
      baseSha256: sha(oldInstaller),
      baseSize: oldInstaller.length,
      sha256: sha(installerDelta),
      size: installerDelta.length,
      url: '/local/updates/files/windows/setup-1.2.4.rbdelta',
    }],
    asarDeltas: [{
      baseSha256: oldAsar.sha256,
      baseSize: oldAsar.bytes.length,
      baseHeaderSha256: oldAsar.headerSha256,
      targetSha256: newAsar.sha256,
      targetSize: newAsar.bytes.length,
      targetHeaderSha256: newAsar.headerSha256,
      sha256: sha(asarDelta),
      size: asarDelta.length,
      url: '/local/updates/files/windows/asar-1.2.4.rbdelta',
    }],
  };
  const manifest = {
    schema: DESKTOP_UPDATE_SCHEMA,
    platform: 'windows',
    track: 'stable',
    publishedAt,
    signatureAlgorithm: 'ecdsa-p256-sha256',
    signature: sign('sha256', Buffer.from(canonicalDesktopPayload(flatForSign), 'utf8'), key.privateKey).toString('base64'),
    publicKeyPem: key.pem,
    latest: {
      version: '1.2.4',
      url: flatForSign.url,
      sha256: flatForSign.sha256,
      size: flatForSign.size,
      asarSha256: newAsar.sha256,
      asarHeaderSha256: newAsar.headerSha256,
      deltas: flatForSign.deltas,
      asarDeltas: flatForSign.asarDeltas,
      deltasSignature: sign('sha256', Buffer.from(canonicalDesktopDeltasPayload(flatForSign), 'utf8'), key.privateKey).toString('base64'),
    },
  };

  const requests = [];
  const srv = await startServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push(pathname);
    if (req.headers.authorization !== 'Bearer win-e2e-tok') { res.writeHead(401); res.end(); return; }
    if (pathname === '/local/updates/windows.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifest));
      return;
    }
    if (pathname === '/local/updates/files/windows/asar-1.2.4.rbdelta') {
      res.writeHead(200, { 'content-length': String(asarDelta.length) });
      res.end(asarDelta);
      return;
    }
    if (pathname === '/local/updates/files/windows/setup-1.2.4.rbdelta') {
      res.writeHead(200, { 'content-length': String(installerDelta.length) });
      res.end(installerDelta);
      return;
    }
    if (pathname === '/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe') {
      res.writeHead(200, { 'content-length': String(fullSetup.length) });
      res.end(fullSetup);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  t.after(() => srv.close());

  const hostFetch = createTailcatUpdateFetch({
    isTunneled: () => false,
    getServerUrl: () => srv.url,
    getToken: () => 'win-e2e-tok',
  });

  const e2eManaged = path.join(base, 'e2e-managed');
  const e2eManagedSub = path.join(e2eManaged, 'sub');
  const e2eDecoy = path.join(base, 'e2e-decoy');
  const e2eExternal = path.join(base, 'e2e-external');
  await mkdir(e2eManagedSub, { recursive: true });
  await mkdir(e2eDecoy, { recursive: true });
  await writeFile(path.join(e2eManaged, '.rokbot-installation.json'), '{"format":1}');
  const e2eExtLayout = await createWinLayout(e2eExternal, { exeHash: oldAsar.headerSha256, asarBytes: oldAsar.bytes });
  await mkdir(path.join(e2eExtLayout.resourcesDir, 'app.asar.unpacked'), { recursive: true });
  await symlink(e2eExtLayout.resourcesDir, path.join(e2eManaged, 'resources'));
  const e2eSublink = path.join(e2eDecoy, 'sublink');
  await symlink(e2eManagedSub, e2eSublink);

  const e2eExeBefore = await readFile(e2eExtLayout.execPath);
  const e2eAsarBefore = await readFile(e2eExtLayout.asarPath);

  const source = await resolveDesktopUpdateSource({
    resourcesDir: e2eExtLayout.resourcesDir,
    profileDir: path.join(base, 'e2e-prof-base'),
    server: srv.url,
    platform: 'win32',
  });

  // Non-vacuous E2E baseline: external/ directly selects ASAR delta
  requests.length = 0;
  const profBase = path.join(base, 'e2e-prof-base');
  await mkdir(profBase, { recursive: true });
  const baseAsarInstalls = [];
  const baseFileInstalls = [];
  const updaterBase = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'win32-x64',
    profileDir: profBase,
    resourcesDir: e2eExtLayout.resourcesDir,
    execPath: e2eExtLayout.execPath,
    config: source,
    fetchImpl: hostFetch,
    canUseAsarUpdate: opts => canApplyAsarUpdate({ ...opts, platform: 'win32' }),
    onInstallAsar: async info => baseAsarInstalls.push(info),
    onInstallFile: async (file, ver) => baseFileInstalls.push({ file, ver }),
  });
  assert.equal((await updaterBase.check()).state.type, 'ready');
  assert.equal(requests.includes('/local/updates/files/windows/asar-1.2.4.rbdelta'), true);
  assert.equal(requests.includes('/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe'), false);
  await updaterBase.quitAndInstall({ expectedVersion: '1.2.4' });
  assert.equal(baseAsarInstalls.length, 1);
  assert.equal(baseFileInstalls.length, 0);
  assert.ok((await readFile(baseAsarInstalls[0].asarFile)).equals(newAsar.bytes));

  // Traversal vector without base-stable.exe -> routes to full Setup.exe (0 ASAR delta requests)
  for (const traversalRes of [
    `${e2eSublink}/../resources/app.asar.unpacked/..`,
    `${e2eSublink}/../resources/app.asar.unpacked/../.`,
  ]) {
    requests.length = 0;
    const profSetup = await mkdtemp(path.join(base, 'e2e-prof-setup-'));
    const asarInstalls = [];
    const fileInstalls = [];
    const updaterSetup = createDesktopUpdater({
      appVersion: '1.2.3',
      platformId: 'win32-x64',
      profileDir: profSetup,
      resourcesDir: traversalRes,
      execPath: e2eExtLayout.execPath,
      config: source,
      fetchImpl: hostFetch,
      canUseAsarUpdate: opts => canApplyAsarUpdate({ ...opts, platform: 'win32' }),
      onInstallAsar: async info => asarInstalls.push(info),
      onInstallFile: async (file, ver) => fileInstalls.push({ file, ver, bytes: await readFile(file) }),
    });
    assert.equal((await updaterSetup.check()).state.type, 'ready');
    assert.equal(requests.includes('/local/updates/files/windows/asar-1.2.4.rbdelta'), false);
    assert.equal(requests.includes('/local/updates/files/windows/setup-1.2.4.rbdelta'), false);
    assert.equal(requests.includes('/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe'), true);
    await updaterSetup.quitAndInstall({ expectedVersion: '1.2.4' });
    assert.equal(asarInstalls.length, 0);
    assert.equal(fileInstalls.length, 1);
    assert.ok(fileInstalls[0].bytes.equals(fullSetup));

    // Stale ready-asar-stable-1.2.4.json defense-in-depth (e.g., cached before guard/mount): applyAsarUpdateAndRestart still refuses
    const profStale = await mkdtemp(path.join(base, 'e2e-prof-stale-'));
    await mkdir(path.join(profStale, 'updates'), { recursive: true });
    const staleAsarFile = path.join(profStale, 'updates', 'asar-stable-1.2.4.asar');
    await writeFile(staleAsarFile, newAsar.bytes);
    await writeFile(
      path.join(profStale, 'updates', 'ready-asar-stable-1.2.4.json'),
      JSON.stringify({
        version: '1.2.4',
        asarFile: staleAsarFile,
        sha256: newAsar.sha256,
        size: newAsar.bytes.length,
        headerSha256: newAsar.headerSha256,
        baseHeaderSha256: oldAsar.headerSha256,
        resourcesDir: traversalRes,
        execPath: e2eExtLayout.execPath,
      }),
    );
    let staleQuitCalls = 0;
    const staleUpdater = createDesktopUpdater({
      appVersion: '1.2.3',
      platformId: 'win32-x64',
      profileDir: profStale,
      resourcesDir: traversalRes,
      execPath: e2eExtLayout.execPath,
      config: source,
      fetchImpl: hostFetch,
      canUseAsarUpdate: opts => canApplyAsarUpdate({ ...opts, platform: 'win32' }),
      onInstallAsar: info => applyAsarUpdateAndRestart({ ...info, quitApp: () => { staleQuitCalls += 1; }, platform: 'win32' }),
      onInstallFile: async () => {},
    });
    assert.equal((await staleUpdater.check()).state.type, 'ready');
    await assert.rejects(() => staleUpdater.quitAndInstall({ expectedVersion: '1.2.4' }), /installer-managed/i);
    assert.equal(staleQuitCalls, 0);
    assert.equal((await readdir(path.join(profStale, 'updates'))).some(name => name.startsWith('apply-')), false);
  }

  // Traversal vector with base-stable.exe -> routes to installer .rbdelta (0 ASAR delta requests)
  requests.length = 0;
  const profDelta = path.join(base, 'e2e-prof-delta');
  await mkdir(path.join(profDelta, 'updates'), { recursive: true });
  await writeFile(path.join(profDelta, 'updates', 'base-stable.exe'), oldInstaller);
  const deltaAsarInstalls = [];
  const deltaFileInstalls = [];
  const updaterDelta = createDesktopUpdater({
    appVersion: '1.2.3',
    platformId: 'win32-x64',
    profileDir: profDelta,
    resourcesDir: `${e2eSublink}/../resources/app.asar.unpacked/..`,
    execPath: e2eExtLayout.execPath,
    config: source,
    fetchImpl: hostFetch,
    canUseAsarUpdate: opts => canApplyAsarUpdate({ ...opts, platform: 'win32' }),
    onInstallAsar: async info => deltaAsarInstalls.push(info),
    onInstallFile: async (file, ver) => deltaFileInstalls.push({ file, ver, bytes: await readFile(file) }),
  });
  assert.equal((await updaterDelta.check()).state.type, 'ready');
  assert.equal(requests.includes('/local/updates/files/windows/asar-1.2.4.rbdelta'), false);
  assert.equal(requests.includes('/local/updates/files/windows/setup-1.2.4.rbdelta'), true);
  assert.equal(requests.includes('/local/updates/files/windows/RokBotLocal-1.2.4-x64-Setup.exe'), false);
  await updaterDelta.quitAndInstall({ expectedVersion: '1.2.4' });
  assert.equal(deltaAsarInstalls.length, 0);
  assert.equal(deltaFileInstalls.length, 1);
  assert.ok(deltaFileInstalls[0].bytes.equals(fullSetup));

  assert.ok((await readFile(e2eExtLayout.execPath)).equals(e2eExeBefore));
  assert.ok((await readFile(e2eExtLayout.asarPath)).equals(e2eAsarBefore));
});

test('win32 guard defeats multi-level subdir/.., symlinked bin escapes, and resources/.. landing on managed root', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-multihop-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const stagedDir = path.join(base, 'staged');
  await mkdir(stagedDir, { recursive: true });
  const stagedAsar = path.join(stagedDir, 'asar-1.2.4.asar');
  await writeFile(stagedAsar, Buffer.from('new-asar'));

  const managed = path.join(base, 'managed');
  const managedSub2 = path.join(managed, 'subdir', 'subdir2');
  const decoy = path.join(base, 'decoy');
  const external = path.join(base, 'external');
  const external2 = path.join(external, 'external2');
  await mkdir(managedSub2, { recursive: true });
  await mkdir(decoy, { recursive: true });
  await mkdir(path.join(external, 'bin'), { recursive: true });
  await writeFile(path.join(managed, '.rokbot-installation.json'), '{"format":1}');

  const extLayout = await createWinLayout(external, { exeHash: '1'.repeat(64), asarBytes: Buffer.from('ext-asar') });
  const ext2Layout = await createWinLayout(external2, { exeHash: '1'.repeat(64), asarBytes: Buffer.from('ext2-asar') });
  await mkdir(path.join(extLayout.resourcesDir, 'app.asar.unpacked'), { recursive: true });

  await symlink(extLayout.resourcesDir, path.join(managed, 'resources'));
  await symlink(path.join(external, 'bin'), path.join(managed, 'bin'));
  const deepLink = path.join(decoy, 'deep-link');
  const hop1 = path.join(decoy, 'hop1');
  const hop2 = path.join(decoy, 'hop2');
  await symlink(managedSub2, deepLink);
  await symlink(managedSub2, hop1);
  await symlink(hop1, hop2);

  // Non-vacuous baselines for external and external2
  for (const layout of [extLayout, ext2Layout]) {
    assert.equal(await isWindowsInstallerManaged({ resourcesDir: layout.resourcesDir, execPath: layout.execPath }), false);
    assert.equal(await canApplyAsarUpdate({ resourcesDir: layout.resourcesDir, execPath: layout.execPath, platform: 'win32' }), true);
  }

  const cases = [
    // 1) Multi-level subdir/subdir2/../..
    { resourcesDir: `${deepLink}/../../resources`, execPath: extLayout.execPath },
    { resourcesDir: `${deepLink}/../../resources/.`, execPath: extLayout.execPath },
    { resourcesDir: `${deepLink}/../../resources/app.asar.unpacked/..`, execPath: extLayout.execPath },
    { resourcesDir: `${hop2}/../../resources/app.asar.unpacked/../.`, execPath: extLayout.execPath },
    { resourcesDir: `${managed}/subdir/subdir2/../../resources/app.asar.unpacked/..`, execPath: extLayout.execPath },
    // 2) Symlinked bin -> external/bin escape via execPath
    { resourcesDir: ext2Layout.resourcesDir, execPath: `${managed}/bin/../external2/Grok Bot.exe` },
    { resourcesDir: extLayout.resourcesDir, execPath: `${deepLink}/../../bin/../Grok Bot.exe` },
    { resourcesDir: extLayout.resourcesDir, execPath: `${hop2}/../../bin/../Grok Bot.exe` },
    // 3) resources/.. landing on external/ via managed/resources symlink
    { resourcesDir: `${deepLink}/../../resources/..`, execPath: extLayout.execPath },
  ];

  for (const pair of cases) {
    assert.equal(await isWindowsInstallerManaged(pair), true, `expected managed: ${JSON.stringify(pair)}`);
    assert.equal(await canApplyAsarUpdate({ ...pair, platform: 'win32' }), false, `expected blocked: ${JSON.stringify(pair)}`);
    let quitCalls = 0;
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile: stagedAsar,
        headerSha256: '2'.repeat(64),
        baseHeaderSha256: '1'.repeat(64),
        version: '1.2.4',
        ...pair,
        quitApp: () => { quitCalls += 1; },
        platform: 'win32',
      }),
      /installer-managed/i,
    );
    assert.equal(quitCalls, 0);
    assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);
  }

  // 4) ${sublink}/../resources/.. landing directly on managed/ (both plain resources dir and missing resources dir)
  const portable = path.join(base, 'portable');
  const portableLayout = await createWinLayout(portable, { exeHash: '1'.repeat(64) });
  for (const variant of ['plain', 'missing']) {
    const mRoot = path.join(base, `managed-${variant}`);
    const mSub = path.join(mRoot, 'sub');
    const dRoot = path.join(base, `decoy-${variant}`);
    await mkdir(mSub, { recursive: true });
    await mkdir(dRoot, { recursive: true });
    await writeFile(path.join(mRoot, '.rokbot-installation.json'), '{"format":1}');
    if (variant === 'plain') {
      await createWinLayout(mRoot, { exeHash: '1'.repeat(64) });
    }
    const sublink = path.join(dRoot, 'sublink');
    await symlink(mSub, sublink);

    for (const resourcesDir of [mRoot, `${sublink}/../resources/..`, `${sublink}/../resources/../.`]) {
      assert.equal(await isWindowsInstallerManaged({ resourcesDir }), true, `${variant}: ${resourcesDir}`);
      assert.equal(
        await isWindowsInstallerManaged({ resourcesDir, execPath: portableLayout.execPath }),
        true,
        `${variant} split: ${resourcesDir}`,
      );
      assert.equal(
        await canApplyAsarUpdate({ resourcesDir, execPath: portableLayout.execPath, platform: 'win32' }),
        false,
        `${variant} canApply: ${resourcesDir}`,
      );
      let quitCalls = 0;
      await assert.rejects(
        () => applyAsarUpdateAndRestart({
          asarFile: stagedAsar,
          headerSha256: '2'.repeat(64),
          baseHeaderSha256: '1'.repeat(64),
          version: '1.2.4',
          resourcesDir,
          execPath: portableLayout.execPath,
          quitApp: () => { quitCalls += 1; },
          platform: 'win32',
        }),
        /installer-managed/i,
      );
      assert.equal(quitCalls, 0);
    }
  }
});

test('win32 guard fails closed on ENOTDIR (regularfile/., regularfile/), dangling symlinks, ELOOP cycles, and chmod 0o000', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-fserr-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const stagedDir = path.join(base, 'staged');
  await mkdir(stagedDir, { recursive: true });
  const stagedAsar = path.join(stagedDir, 'asar-1.2.4.asar');
  await writeFile(stagedAsar, Buffer.from('new-asar'));

  const portable = path.join(base, 'portable');
  const portableLayout = await createWinLayout(portable, { exeHash: '1'.repeat(64) });

  // 1) ENOTDIR: regularfile/, regularfile/., regularfile/./, regularfile/resources, regularfile/app.asar
  const regFile = path.join(base, 'regularfile');
  await writeFile(regFile, 'not-a-directory');
  for (const badPath of [`${regFile}/`, `${regFile}/.`, `${regFile}/./`, `${regFile}/resources`, `${regFile}/app.asar`]) {
    assert.equal(await isWindowsInstallerManaged({ resourcesDir: badPath }), true, `single resourcesDir: ${badPath}`);
    assert.equal(await isWindowsInstallerManaged({ execPath: badPath }), true, `single execPath: ${badPath}`);
    assert.equal(
      await isWindowsInstallerManaged({ resourcesDir: badPath, execPath: portableLayout.execPath }),
      true,
      `split resourcesDir: ${badPath}`,
    );
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: badPath, execPath: portableLayout.execPath, platform: 'win32' }),
      false,
    );
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: portableLayout.resourcesDir, execPath: badPath, platform: 'win32' }),
      false,
    );
    let quitCalls = 0;
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile: stagedAsar,
        headerSha256: '2'.repeat(64),
        baseHeaderSha256: '1'.repeat(64),
        version: '1.2.4',
        resourcesDir: badPath,
        execPath: portableLayout.execPath,
        quitApp: () => { quitCalls += 1; },
        platform: 'win32',
      }),
      /installer-managed/i,
    );
    assert.equal(quitCalls, 0);
    assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);
  }

  // Writable regular file (without trailing slash) as resourcesDir -> canApplyAsarUpdate === false and applyAsarUpdateAndRestart rejects cleanly with 0 apply-* dirs
  assert.equal(
    await canApplyAsarUpdate({ resourcesDir: regFile, execPath: portableLayout.execPath, platform: 'win32' }),
    false,
  );
  {
    let quitCalls = 0;
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile: stagedAsar,
        headerSha256: '2'.repeat(64),
        baseHeaderSha256: '1'.repeat(64),
        version: '1.2.4',
        resourcesDir: regFile,
        execPath: portableLayout.execPath,
        quitApp: () => { quitCalls += 1; },
        platform: 'win32',
      }),
      /Invalid resourcesDir/,
    );
    assert.equal(quitCalls, 0);
    assert.equal((await readdir(stagedDir)).some(name => name.startsWith('apply-')), false);
  }

  // 2) Dangling symlinks: decoy/dangling -> managed/missing (true) vs decoy/dangling -> portable/missing (false)
  const managedDangling = path.join(base, 'managed-dangling');
  const decoyDangling = path.join(base, 'decoy-dangling');
  await mkdir(managedDangling, { recursive: true });
  await mkdir(decoyDangling, { recursive: true });
  await writeFile(path.join(managedDangling, '.rokbot-installation.json'), '{"format":1}');
  const danglingToManaged = path.join(decoyDangling, 'dangling-managed');
  const danglingToPortable = path.join(decoyDangling, 'dangling-portable');
  await symlink(path.join(managedDangling, 'missing'), danglingToManaged);
  await symlink(path.join(portable, 'missing'), danglingToPortable);

  assert.equal(await isWindowsInstallerManaged({ resourcesDir: danglingToManaged }), true);
  assert.equal(
    await canApplyAsarUpdate({ resourcesDir: danglingToManaged, execPath: portableLayout.execPath, platform: 'win32' }),
    false,
  );
  assert.equal(await isWindowsInstallerManaged({ resourcesDir: danglingToPortable }), false);

  // 3) ELOOP symlink cycle
  const loopA = path.join(base, 'loop-a');
  const loopB = path.join(base, 'loop-b');
  await symlink(loopB, loopA);
  await symlink(loopA, loopB);
  for (const loopPath of [loopA, `${loopA}/.`, `${loopA}/resources`, `${loopA}/Grok Bot.exe`]) {
    assert.equal(await isWindowsInstallerManaged({ resourcesDir: loopPath }), true, `ELOOP resourcesDir: ${loopPath}`);
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: loopPath, execPath: portableLayout.execPath, platform: 'win32' }),
      false,
    );
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: portableLayout.resourcesDir, execPath: loopPath, platform: 'win32' }),
      false,
    );
    let quitCalls = 0;
    await assert.rejects(
      () => applyAsarUpdateAndRestart({
        asarFile: stagedAsar,
        headerSha256: '2'.repeat(64),
        baseHeaderSha256: '1'.repeat(64),
        version: '1.2.4',
        resourcesDir: loopPath,
        execPath: portableLayout.execPath,
        quitApp: () => { quitCalls += 1; },
        platform: 'win32',
      }),
      /installer-managed/i,
    );
    assert.equal(quitCalls, 0);
  }

  // 4) EACCES via chmod 0o000 (when non-root)
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const lockedRoot = path.join(base, 'locked-root');
    const lockedSub = path.join(lockedRoot, 'sub');
    const lockedDecoy = path.join(base, 'locked-decoy');
    await mkdir(lockedSub, { recursive: true });
    await mkdir(lockedDecoy, { recursive: true });
    const locked = await createWinLayout(lockedRoot, { exeHash: '1'.repeat(64) });
    await mkdir(path.join(locked.resourcesDir, 'app.asar.unpacked'), { recursive: true });
    const lockedSublink = path.join(lockedDecoy, 'sublink');
    await symlink(lockedSub, lockedSublink);

    await chmod(locked.resourcesDir, 0o000);
    t.after(async () => {
      await chmod(locked.resourcesDir, 0o755).catch(() => {});
      await chmod(lockedRoot, 0o755).catch(() => {});
    });
    assert.equal(
      await isWindowsInstallerManaged({
        resourcesDir: `${locked.resourcesDir}/app.asar.unpacked/..`,
        execPath: portableLayout.execPath,
      }),
      true,
    );
    assert.equal(
      await canApplyAsarUpdate({
        resourcesDir: `${locked.resourcesDir}/app.asar.unpacked/..`,
        execPath: portableLayout.execPath,
        platform: 'win32',
      }),
      false,
    );
    await chmod(locked.resourcesDir, 0o755);

    await chmod(lockedRoot, 0o000);
    assert.equal(
      await isWindowsInstallerManaged({ resourcesDir: `${lockedSublink}/../resources/.`, execPath: portableLayout.execPath }),
      true,
    );
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: `${lockedSublink}/../resources/.`, execPath: portableLayout.execPath, platform: 'win32' }),
      false,
    );
    await chmod(lockedRoot, 0o755);
  }
});

test('win32 portable traversal, false-positive safety, missing intermediates, relative cwd, and cross-platform root/drive boundaries behave safely', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rokbot-m31d-portable-adv-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const managed = path.join(base, 'managed-sibling');
  const managedSub = path.join(managed, 'sub');
  const decoy = path.join(base, 'decoy');
  const portable = path.join(base, 'portable-sibling');
  const portableSub = path.join(portable, 'sub');
  await mkdir(managedSub, { recursive: true });
  await mkdir(decoy, { recursive: true });
  await mkdir(portableSub, { recursive: true });
  await writeFile(path.join(managed, '.rokbot-installation.json'), '{"format":1}');
  const portableLayout = await createWinLayout(portable);
  await mkdir(path.join(portableLayout.resourcesDir, 'app.asar.unpacked'), { recursive: true });
  await symlink(managedSub, path.join(decoy, 'sublink'));

  // 1) Portable sibling with traversal segments still permits ASAR updates
  for (const [resourcesDir, execPath] of [
    [`${portableLayout.resourcesDir}/app.asar.unpacked/..`, portableLayout.execPath],
    [`${portableLayout.resourcesDir}/app.asar.unpacked/../.`, portableLayout.execPath],
    [`${portable}/sub/../resources`, `${portable}/sub/../Grok Bot.exe`],
    [`${portable}/sub/../resources/.`, `${portable}/sub/.././Grok Bot.exe`],
  ]) {
    assert.equal(await isWindowsInstallerManaged({ resourcesDir, execPath }), false, `portable should be unmanaged: ${resourcesDir}`);
    assert.equal(await canApplyAsarUpdate({ resourcesDir, execPath, platform: 'win32' }), true, `portable should allow ASAR: ${resourcesDir}`);
  }

  // 2) False-positive safety check: parent-with-receipt/portable/{Grok Bot.exe, resources/app.asar}
  const parentWithReceipt = path.join(base, 'parent-with-receipt');
  const nestedPortable = path.join(parentWithReceipt, 'portable');
  await mkdir(nestedPortable, { recursive: true });
  await writeFile(path.join(parentWithReceipt, '.rokbot-installation.json'), '{"format":1}');
  const nestedLayout = await createWinLayout(nestedPortable);
  await mkdir(path.join(nestedLayout.resourcesDir, 'app.asar.unpacked'), { recursive: true });
  for (const resDir of [
    nestedLayout.resourcesDir,
    `${nestedLayout.resourcesDir}/.`,
    `${nestedLayout.resourcesDir}/app.asar.unpacked/..`,
  ]) {
    assert.equal(
      await isWindowsInstallerManaged({ resourcesDir: resDir, execPath: nestedLayout.execPath }),
      false,
      `nested portable under receipt parent must not false-positive: ${resDir}`,
    );
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: resDir, execPath: nestedLayout.execPath, platform: 'win32' }),
      true,
      `nested portable under receipt parent must allow ASAR: ${resDir}`,
    );
  }

  // 3) 0711 parent directory containing portable/ (when non-root) -> must not false-positive
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const parent0711 = path.join(base, 'parent-0711');
    const childPortable = path.join(parent0711, 'portable');
    await mkdir(childPortable, { recursive: true });
    const childLayout = await createWinLayout(childPortable);
    await chmod(parent0711, 0o711);
    t.after(async () => {
      await chmod(parent0711, 0o755).catch(() => {});
    });
    try {
      assert.equal(
        await isWindowsInstallerManaged({ resourcesDir: childLayout.resourcesDir, execPath: childLayout.execPath }),
        false,
      );
      assert.equal(
        await canApplyAsarUpdate({ resourcesDir: childLayout.resourcesDir, execPath: childLayout.execPath, platform: 'win32' }),
        true,
      );
    } finally {
      await chmod(parent0711, 0o755);
    }
  }

  // 4) ENOENT intermediate segment must NOT fail closed on portable, while lexical fallback still catches managed
  assert.equal(
    await isWindowsInstallerManaged({
      resourcesDir: `${portable}/nonexistent/../resources`,
      execPath: portableLayout.execPath,
    }),
    false,
  );
  assert.equal(
    await isWindowsInstallerManaged({
      resourcesDir: `${managed}/nonexistent/../resources`,
      execPath: portableLayout.execPath,
    }),
    true,
  );

  // 5) Relative cwd traversal paths
  const prevCwd = process.cwd();
  t.after(() => {
    try { process.chdir(prevCwd); } catch {}
  });
  try {
    process.chdir(decoy);
    assert.equal(await isWindowsInstallerManaged({ resourcesDir: 'sublink/../resources/app.asar.unpacked/..' }), true);
    assert.equal(await isWindowsInstallerManaged({ resourcesDir: 'sublink/../resources/app.asar.unpacked/../.' }), true);
    assert.equal(
      await canApplyAsarUpdate({
        resourcesDir: 'sublink/../resources/app.asar.unpacked/..',
        execPath: portableLayout.execPath,
        platform: 'win32',
      }),
      false,
    );

    process.chdir(portable);
    assert.equal(await isWindowsInstallerManaged({ resourcesDir: 'sub/../resources/.', execPath: 'Grok Bot.exe' }), false);
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: 'sub/../resources/.', execPath: 'Grok Bot.exe', platform: 'win32' }),
      true,
    );
  } finally {
    process.chdir(prevCwd);
  }

  // 6) Cross-platform root / dot / Windows drive-root & backslash boundaries do not throw or false-positive
  for (const edge of ['/', '/.', '/./', '//', '///./', 'C:\\', 'C:\\.', 'C:\\.\\', 'C:/', 'C:/.', '\\\\server\\share\\.']) {
    assert.equal(await isWindowsInstallerManaged({ resourcesDir: edge }), false, `edge should not fail closed: ${edge}`);
    assert.equal(
      await canApplyAsarUpdate({ resourcesDir: edge, execPath: 'C:\\Grok Bot.exe', platform: 'win32' }),
      false,
    );
  }
});

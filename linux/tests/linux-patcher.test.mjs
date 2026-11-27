import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { allLinuxReleases, linuxReleasesForArch, normalizeLinuxArch, selectLinuxRelease } from '../patchers/desktop/inputs.mjs';
import { buildArArchive, buildDeb, parseArArchive } from '../patchers/desktop/deb.mjs';
import {
  applyRokBotLinuxAsarIcons,
  buildAppArmorProfile,
  buildDebianControl,
  buildDesktopEntry,
  buildPostinstScript,
  buildPostrmScript,
  LINUX_BINARY_NAME,
  LINUX_ICON_SIZES,
  LINUX_INSTALL_DIR,
  LINUX_PACKAGE_NAME,
  resolveLinuxTailcatBinary,
  resolveRokBotLinuxLogoPaths,
  stageDebianTree,
} from '../patchers/desktop/brand-assets.mjs';
import { connectWindowChrome, createTray, windowChrome, windowIcon } from '../../mac/clients/desktop/platform.mjs';
import { canApplyAsarUpdate } from '../../mac/clients/desktop/asar-install.mjs';
import { normalizeDesktopUpdateUrl, resolveDesktopUpdateSource } from '../../mac/clients/desktop/updater.mjs';
import { UpdatesManager } from '../../host/server/updates.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const linuxPatchCli = fileURLToPath(new URL('../patchers/desktop/patch.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('Linux x64 and arm64 1.3.0 supported.json, notification-policy.json, recipes, and tailcat binaries are aligned', async () => {
  assert.equal(normalizeLinuxArch('amd64'), 'x64');
  assert.equal(normalizeLinuxArch('x86_64'), 'x64');
  assert.equal(normalizeLinuxArch('aarch64'), 'arm64');
  assert.throws(() => normalizeLinuxArch('riscv64'), /不支持的 Linux 架构/);

  const releases = await allLinuxReleases();
  assert.deepEqual(releases.map(r => `${r.arch}:${r.supported.version}`), ['x64:1.3.0', 'arm64:1.3.0']);

  for (const arch of ['x64', 'arm64']) {
    const list = await linuxReleasesForArch(arch);
    assert.equal(list.length, 1);
    const { supported, directory } = list[0];
    assert.equal(supported.version, '1.3.0');
    assert.equal(supported.architecture, arch);
    assert.equal(supported.debianArchitecture, arch === 'x64' ? 'amd64' : 'arm64');
    for (const key of ['binSha256', 'asarSha256', 'asarHeaderSha256', 'preloadSha256', 'vncPreloadSha256']) {
      assert.match(supported[key] ?? '', /^[0-9a-f]{64}$/, `linux-${arch} missing ${key}`);
    }
    const policy = JSON.parse(await readFile(path.join(directory, 'notification-policy.json'), 'utf8'));
    assert.equal(policy.exportName, 'SO');
    assert.equal(policy.byteOffset, 3191546);
    assert.equal(policy.byteLength, 4485);

    const { binaryPath } = resolveLinuxTailcatBinary(repoRoot, arch);
    assert.equal(existsSync(binaryPath), true, `Missing prebuilt Tailcat for linux-${arch}: ${binaryPath}`);
  }

  const logos = resolveRokBotLinuxLogoPaths(repoRoot);
  for (const size of LINUX_ICON_SIZES) {
    assert.equal(existsSync(logos.sized[size]), true, `Missing RokBot PNG icon ${size}px`);
  }

  const x64 = await selectLinuxRelease({ arch: 'x64' });
  const arm64 = await selectLinuxRelease({ arch: 'arm64' });
  assert.equal(x64.arch, 'x64');
  assert.equal(arm64.arch, 'arm64');
  await assert.rejects(selectLinuxRelease({ arch: 'x64', version: '0.1.0' }), /不支持 Grok Bot 0\.1\.0/);
});

test('ar archive builder/parser and .deb builder produce valid Debian 2.0 packages with clean RokBot branding', async t => {
  const ar = buildArArchive([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'odd.bin', data: Buffer.from('abc') },
    { name: 'even.bin', data: Buffer.from('wxyz') },
  ]);
  const parsed = parseArArchive(ar);
  assert.deepEqual(parsed.map(m => [m.name, m.data.toString()]), [
    ['debian-binary', '2.0\n'],
    ['odd.bin', 'abc'],
    ['even.bin', 'wxyz'],
  ]);
  assert.throws(() => parseArArchive(Buffer.from('not-an-ar')), /missing ar magic/);

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rokbot-linux-deb-test-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const portableDir = path.join(tmp, 'portable');
  await mkdir(path.join(portableDir, 'resources'), { recursive: true });
  await writeFile(path.join(portableDir, LINUX_BINARY_NAME), '#!/bin/sh\necho rokbot\n', { mode: 0o755 });
  await writeFile(path.join(portableDir, 'resources/app.asar'), 'synthetic-asar');

  const { controlDir, dataDir } = await stageDebianTree({
    portableDir,
    version: '1.3.0',
    debianArchitecture: 'amd64',
    upstreamControlText: 'Depends: libgtk-3-0, libnss3\nRecommends: libappindicator3-1\n',
    repoRoot,
    debRoot: path.join(tmp, 'deb-root'),
  });

  const desktopText = buildDesktopEntry();
  assert.match(desktopText, /^Name=RokBot$/m);
  assert.match(desktopText, new RegExp(`^Exec=${LINUX_INSTALL_DIR}/${LINUX_BINARY_NAME} -- %U$`, 'm'));
  assert.match(desktopText, /^MimeType=x-scheme-handler\/rokbot-local;$/m);
  assert.doesNotMatch(desktopText, /grokbot|Grok Bot/i);

  const apparmor = buildAppArmorProfile();
  assert.match(apparmor, /profile "rokbot" "\/opt\/RokBot\/rokbot"/);

  const postinst = buildPostinstScript();
  const postrm = buildPostrmScript();
  assert.doesNotMatch(postinst, /downloads\.cursor\.com|aptrepo|grok-bot\.sources|Anysphere/i);
  assert.doesNotMatch(postrm, /grok-bot\.sources|grok-bot\.gpg/i);
  assert.match(postinst, /\/usr\/bin\/rokbot/);
  assert.match(postrm, /\/etc\/apparmor\.d\/rokbot/);

  const control = await buildDebianControl({
    version: '1.3.0',
    debianArchitecture: 'amd64',
    upstreamControlText: 'Depends: libgtk-3-0, libnss3\n',
    dataDir,
  });
  assert.match(control, new RegExp(`^Package: ${LINUX_PACKAGE_NAME}$`, 'm'));
  assert.match(control, /^Architecture: amd64$/m);
  assert.match(control, /^Depends: libgtk-3-0, libnss3$/m);
  assert.doesNotMatch(control, /cursor\.com|SpaceXAI|Grok Bot/i);

  const debPath = path.join(tmp, 'RokBotLocal-1.3.0-linux-x64.deb');
  const debBytes = await buildDeb({ controlDir, dataDir, outputPath: debPath });
  const debMembers = parseArArchive(debBytes);
  assert.deepEqual(debMembers.map(m => m.name), ['debian-binary', 'control.tar.gz', 'data.tar.gz']);
  assert.equal(debMembers[0].data.toString('ascii'), '2.0\n');
});

test('Linux desktop runtime helpers: windowChrome, windowIcon, tray icon, ASAR about icon, updater feeds, and writable ASAR eligibility', async t => {
  assert.deepEqual(windowChrome('#111111', 'linux'), { frame: true });
  assert.deepEqual(connectWindowChrome('linux'), {});
  assert.equal(windowIcon('/opt/RokBot/local-client', 'linux'), '/opt/RokBot/local-client/icon.png');
  assert.equal(windowIcon('/opt/RokBot/local-client', 'darwin'), undefined);
  assert.equal(windowIcon('/opt/RokBot/local-client', 'win32'), undefined);

  const asarStage = await mkdtemp(path.join(os.tmpdir(), 'rokbot-linux-asar-icons-'));
  t.after(() => rm(asarStage, { recursive: true, force: true }));
  await mkdir(path.join(asarStage, 'dist/renderer/assets'), { recursive: true });
  await writeFile(path.join(asarStage, 'dist/renderer/assets/app-icon-B8tEBssC.png'), 'stale-official-about-icon');
  const iconRes = await applyRokBotLinuxAsarIcons(asarStage, repoRoot);
  const logos = resolveRokBotLinuxLogoPaths(repoRoot);
  assert.equal(iconRes.icon512Sha256, sha(await readFile(logos.icon512Path)));
  assert.deepEqual(iconRes.rendererAppIcons, ['dist/renderer/assets/app-icon-B8tEBssC.png']);
  assert.equal(
    sha(await readFile(path.join(asarStage, 'dist/renderer/assets/app-icon-B8tEBssC.png'))),
    sha(await readFile(logos.sized[256])),
  );

  let trayPath = '';
  const FakeTray = class {
    constructor(img) { trayPath = img; }
    setToolTip() {}
    setContextMenu() {}
    on() {}
  };
  createTray({
    Tray: FakeTray,
    Menu: { buildFromTemplate: items => items },
    nativeImage: { createFromPath: p => p },
    clientRoot: '/opt/RokBot/local-client',
    show: () => {},
    quit: () => {},
    text: (zh) => zh,
    platform: 'linux',
  });
  assert.equal(path.basename(trayPath), 'icon.png');

  assert.deepEqual(normalizeDesktopUpdateUrl('https://updates.example/local/updates/linux-x64.json'), {
    baseUpdateUrl: 'https://updates.example/local/updates',
    feedFile: 'linux-x64.json',
  });
  assert.deepEqual(normalizeDesktopUpdateUrl('https://updates.example/local/updates/linux-arm64.json'), {
    baseUpdateUrl: 'https://updates.example/local/updates',
    feedFile: 'linux-arm64.json',
  });

  const srcX64 = await resolveDesktopUpdateSource({ server: 'https://host.example', platform: 'linux', arch: 'x64' });
  assert.equal(srcX64.feedFile, 'linux-x64.json');
  const srcArm64 = await resolveDesktopUpdateSource({ server: 'https://host.example', platform: 'linux', arch: 'arm64' });
  assert.equal(srcArm64.feedFile, 'linux-arm64.json');

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rokbot-linux-asar-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const resDir = path.join(tmp, 'resources');
  await mkdir(resDir, { recursive: true });
  const execFilePath = path.join(tmp, 'rokbot');
  await writeFile(execFilePath, '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(path.join(resDir, 'app.asar'), 'fake-asar');
  assert.equal(await canApplyAsarUpdate({ resourcesDir: resDir, execPath: execFilePath, platform: 'linux' }), true);
  await chmod(path.join(resDir, 'app.asar'), 0o444);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    assert.equal(await canApplyAsarUpdate({ resourcesDir: resDir, execPath: execFilePath, platform: 'linux' }), false);
  }
  await chmod(path.join(resDir, 'app.asar'), 0o644);
});

test('Host updates server accepts Linux x64/arm64 .deb releases and serves signed feeds', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-host-linux-upd-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const updates = await new UpdatesManager(dir, { updateDir: dir }).load();

  const uploadDeb = async (filename, bytes) => {
    async function* stream() { yield bytes; }
    const req = Object.assign(stream(), { headers: { 'content-length': String(bytes.length) }, once() {}, off() {} });
    const url = new URL(`http://127.0.0.1/admin/api/updates/upload?platform=linux&filename=${encodeURIComponent(filename)}`);
    return updates.handleUpload(req, url);
  };

  const x64Bytes = Buffer.from('rokbot-linux-x64-deb-1.3.0');
  const arm64Bytes = Buffer.from('rokbot-linux-arm64-deb-1.3.0');
  const upX64 = await uploadDeb('RokBotLocal-1.3.0-linux-x64.deb', x64Bytes);
  const upArm64 = await uploadDeb('RokBotLocal-1.3.0-linux-arm64.deb', arm64Bytes);
  assert.equal(upX64.platform, 'linux');
  assert.equal(upX64.sha256, sha(x64Bytes));
  assert.equal(upArm64.platform, 'linux');

  await updates.publish({ platform: 'linux', targetPlatform: 'linux-x64', track: 'stable', filename: upX64.filename, version: '1.3.0' }, 'https://host.example');
  await updates.publish({ platform: 'linux', track: 'stable', filename: upArm64.filename, version: '1.3.0' }, 'https://host.example');

  const feedX64 = updates.manifestFor('linux-x64.json', 'https://host.example');
  assert.equal(feedX64.platform, 'linux-x64');
  assert.equal(feedX64.version, '1.3.0');
  assert.equal(feedX64.sha256, sha(x64Bytes));
  assert.ok(feedX64.signature);

  const feedArm64 = updates.manifestFor('linux-arm64.json', 'https://host.example');
  assert.equal(feedArm64.platform, 'linux-arm64');
  assert.equal(feedArm64.sha256, sha(arm64Bytes));
});

test('Linux patch CLI --help documents options and rejects invalid update arguments', async () => {
  const { stdout } = await execFileAsync(process.execPath, [linuxPatchCli, '--help']);
  assert.match(stdout, /--arch/);
  assert.match(stdout, /--no-deb/);
  assert.match(stdout, /--update-url/);
  await assert.rejects(
    execFileAsync(process.execPath, [linuxPatchCli, '--update-url', 'https://updates.example/']),
    err => err.code === 1 && /--update-public-key/.test(err.stderr),
  );
});

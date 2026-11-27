#!/usr/bin/env node
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, cp, readdir, open, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { patchNativeHelperTeam } from './native-helper.mjs';
import { fileURLToPath } from 'node:url';
import { applyReleaseRecipes } from './release-recipes.mjs';
import { extractNotificationPolicy } from './extract-policy.mjs';
import { acquireDesktopSource } from './download-original.mjs';
import { macReleases, selectMacRelease } from './inputs.mjs';
import { patchDesktopUpdateSettingsUi, resolveDesktopUpdateConfig } from './update-config.mjs';
import {
  PROFILE_DISPLAY_PATH,
  applyRokBotHelperInfoPlist,
  applyRokBotInfoPlist,
  installBundleIcon,
  resolveRokBotLogoPaths,
  resolveTailcatSource,
  stageLocalClientIcon,
  verifyRokBotIcons,
} from './brand-assets.mjs';

export const NATIVE_HELPERS = ['sand-meeting-recorder', 'sand-op-launcher', 'sand-webauthn-signer'];

export async function chmodNativeHelpers(unpacked) {
  // ASAR extraction does not retain Unix executable bits for native helpers.
  for (const name of NATIVE_HELPERS) {
    await chmod(path.join(unpacked, 'dist/native', name), 0o755);
  }
}

function unpackedFiles(header, prefix = '') {
  const result = [];
  for (const [name, entry] of Object.entries(header.files ?? {})) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (entry.files) result.push(...unpackedFiles(entry, relative));
    else if (entry.unpacked) result.push(relative);
  }
  return result;
}

const isMain = Boolean(process.argv[1]) && (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]));
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  }
})();

async function main() {
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const repo = path.resolve(root, '..');
const { icnsPath, iconPngPath, rendererIconPngPath } = resolveRokBotLogoPaths(repo);
const releases = (await macReleases()).map(({ supported: item }) => item.version);
const startedAt = performance.now();
const timings = {};
const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
if (args.includes('--help')) {
  const [recommended, ...older] = releases;
  console.log(`node patchers/desktop/patch.mjs [--source <原版.app或.dmg>] [--version <${releases.join('|')}>] [--output <新.app>] [--backup <原版备份.app>] [--identity <auto|证书名称或SHA1|->] [--update-url <URL> (--update-public-key <SPKI Base64|PEM> | --update-public-key-file <文件>)] [--verify-only]
推荐官方 ${recommended}；${older.length ? `${older.join('、')} 是回退版本，${recommended} 用不了时再用。` : ''}省略 --source 时自动下载指定版本原版。
--update-url / --update-public-key / --update-public-key-file 为客户端启用签名验证的自动更新。`);
  process.exit(0);
}
const updateConfig = await resolveDesktopUpdateConfig(args);
if (process.platform !== 'darwin') throw new Error('macOS App 构建与签名必须在 macOS 上进行。');
const explicitSource = arg('--source');
const { directory: releaseDir, supported } = await selectMacRelease({ source: explicitSource, version: arg('--version') });
let source;
const output = path.resolve(arg('--output') ?? path.join(root, 'output.noindex/RokBot.app'));
const backup = path.resolve(arg('--backup') ?? path.join(root, 'backup.noindex/RokBot.app'));
let signingIdentity = arg('--identity') ?? '-';
let signingKind = signingIdentity === '-' ? 'ad-hoc' : 'certificate';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = async filename => sha(await readFile(filename));
const exists = async filename => { try { await stat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const run = (command, argv, options = {}) => execFileSync(command, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const plist = filename => JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', filename]));
const writePlist = async (filename, value) => { await writeFile(filename, JSON.stringify(value)); run('plutil', ['-convert', 'xml1', filename]); };
async function nativeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await nativeFiles(filename));
    else if (entry.isFile()) {
      const file = await open(filename, 'r');
      try {
        const bytes = Buffer.alloc(4); await file.read(bytes, 0, 4, 0);
        if (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(bytes.toString('hex'))) files.push(filename);
      } finally { await file.close(); }
    }
  }
  return files;
}
if (signingIdentity === 'auto') {
  const listing = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = [...listing.matchAll(/\d+\)\s+([A-F0-9]{40})\s+"([^"]+)"/g)];
  const selected = identities.find(([, , name]) => name.startsWith('Developer ID Application:'))
    ?? identities.find(([, , name]) => name.startsWith('Apple Development:'));
  if (!selected) throw new Error('没有可用的 Apple Development 或 Developer ID Application 签名证书。');
  signingIdentity = selected[1];
  signingKind = selected[2].startsWith('Developer ID Application:') ? 'Developer ID Application' : 'Apple Development';
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'rokbot-desktop-patch-'));
let mounted = false, createdOutput = false;
try {
  source = await acquireDesktopSource({ source: arg('--source'), cacheDirectory: path.join(root, '.cache'), supported,
    onDownload: ({ version }) => console.error(`正在下载原版 Grok Bot ${version}…`) });
  let app = source;
  if (path.extname(source).toLowerCase() === '.dmg') {
    const mount = path.join(temporary, 'mount'); await mkdir(mount);
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, source]); mounted = true;
    app = path.join(mount, 'Grok Bot.app');
  }
  if (!app.endsWith('.app')) throw new Error('输入必须是原版 Grok Bot.app 或 DMG。');
  run('codesign', ['--verify', '--deep', '--strict', app]);
  const infoPath = path.join(app, 'Contents/Info.plist');
  const info = plist(infoPath);
  const asarPath = path.join(app, 'Contents/Resources/app.asar');
  const frameworkRelative = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
  const [asarSha256, frameworkSha256] = await Promise.all([hash(asarPath), hash(path.join(app, frameworkRelative))]);
  if (info.CFBundleIdentifier !== supported.bundleId || info.CFBundleShortVersionString !== supported.version ||
      asarSha256 !== supported.asarSha256 || frameworkSha256 !== supported.frameworkSha256)
    throw new Error(`不支持此发行包。仅支持未经修改的 Grok Bot ${supported.version} macOS ${supported.architecture}；版本、ASAR 或 Electron Framework 摘要不匹配。`);
  const asar = createRequire(import.meta.url)('@electron/asar');
  const originalHeader = asar.getRawHeader(asarPath);
  if (supported.asarHeaderSha256 && sha(originalHeader.headerString) !== supported.asarHeaderSha256) {
    throw new Error(`不支持此发行包。仅支持未经修改的 Grok Bot ${supported.version} macOS ${supported.architecture}；ASAR Header 摘要不匹配。`);
  }
  const originalUnpacked = new Set(unpackedFiles(originalHeader.header));
  const unpacked = path.join(temporary, 'app');
  asar.extractAll(asarPath, unpacked);
  const notificationPolicy = await extractNotificationPolicy(unpacked, releaseDir);
  const pkgPath = path.join(unpacked, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath));
  if (pkg.version !== supported.version) throw new Error('ASAR 包版本不一致。');
  const patchStarted = performance.now();
  await applyReleaseRecipes(unpacked, path.join(releaseDir, 'recipes'));
  await patchDesktopUpdateSettingsUi(unpacked);
  timings.patchSeconds = Number(((performance.now() - patchStarted) / 1000).toFixed(3));
  console.log(JSON.stringify({ verified: true, recipesVerified: true, version: supported.version, recommended: supported.version === releases[0], architecture: supported.architecture, asarSha256 }));
  if (!args.includes('--verify-only')) {
    if (await exists(output)) throw new Error(`输出已存在，不会覆盖：${output}`);
    if (output === backup || output.startsWith(`${backup}/`) || backup.startsWith(`${output}/`)) throw new Error('输出与备份路径必须独立。');
    if (await exists(backup)) {
      if (await hash(path.join(backup, 'Contents/Resources/app.asar')) !== asarSha256 ||
          await hash(path.join(backup, frameworkRelative)) !== frameworkSha256)
        throw new Error('现有备份与输入不一致，请使用新的备份路径。');
    } else {
      await mkdir(path.dirname(backup), { recursive: true });
      run('ditto', [app, backup]);
    }
    await mkdir(path.dirname(output), { recursive: true });
    run('ditto', [app, output]); createdOutput = true;
    const previousMain = pkg.main;
    pkg.main = 'local-client/main.mjs';
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    await cp(path.join(root, 'clients/desktop'), path.join(unpacked, 'local-client'), { recursive: true, filter: filename => !filename.endsWith('/notification-policy.mjs') });
    await writeFile(path.join(unpacked, 'local-client/notification-policy.mjs'), notificationPolicy);
    await cp(path.join(root, 'clients/shared'), path.join(unpacked, 'shared'), { recursive: true });
    await cp(resolveTailcatSource(root), path.join(output, 'Contents/Resources/rokbot-tailcat'));
    // Copies made on Windows or extracted from some archives lose the executable bit.
    await chmod(path.join(output, 'Contents/Resources/rokbot-tailcat'), 0o755);
    await cp(path.join(root, 'network/TAILCAT-LICENSE'), path.join(output, 'Contents/Resources/TAILCAT-LICENSE'));
    await chmodNativeHelpers(unpacked);
    await stageLocalClientIcon({ unpackedDir: unpacked, iconPngPath, rendererIconPngPath });
    const outResources = path.join(output, 'Contents/Resources');
    const outAsar = path.join(outResources, 'app.asar');
    await rm(outAsar);
    await rm(`${outAsar}.unpacked`, { recursive: true, force: true });
    await asar.createPackageWithOptions(unpacked, outAsar, {
      unpack: '{**/*.node,**/dist/native/**,**/dist/deps/**,**/onepassword-connection-service.cjs}',
    });
    const patchedUnpacked = new Set(unpackedFiles(asar.getRawHeader(outAsar).header));
    const missingUnpacked = [...originalUnpacked].filter(name => !patchedUnpacked.has(name));
    const extraUnpacked = [...patchedUnpacked].filter(name => !originalUnpacked.has(name));
    if (missingUnpacked.length || extraUnpacked.length) {
      throw new Error(`解包文件与原版不一致：${[...missingUnpacked, ...extraUnpacked].slice(0, 5).join(', ')}`);
    }
    const header = asar.getRawHeader(outAsar).headerString;
    applyRokBotInfoPlist(info);
    info.ElectronAsarIntegrity = { 'Resources/app.asar': { algorithm: 'SHA256', hash: sha(header) } };
    await writePlist(path.join(output, 'Contents/Info.plist'), info);
    // Helper identities must not collide with the unmodified app. The original
    // engine, executable names, and ASAR integrity fuses remain unchanged.
    const helpers = run('find', [path.join(output, 'Contents/Frameworks'), '-name', 'Info.plist']).trim().split('\n').filter(Boolean);
    for (const filename of helpers) {
      const helper = plist(filename);
      if (applyRokBotHelperInfoPlist(helper, { originalBundleId: supported.bundleId, targetBundleId: info.CFBundleIdentifier })) {
        await writePlist(filename, helper);
      }
    }
    const entitlements = path.join(temporary, 'entitlements.plist');
    try {
      await writeFile(entitlements, run('codesign', ['-d', '--entitlements', ':-', app]));
      const entitlementsValue = plist(entitlements);
      // Ad-hoc signatures have no Team ID; hardened-runtime library validation
      // otherwise rejects the original Electron Framework even after signing.
      if (signingIdentity === '-') entitlementsValue['com.apple.security.cs.disable-library-validation'] = true;
      await writePlist(entitlements, entitlementsValue);
    }
    catch { throw new Error('无法读取原应用签名权限。'); }
    let computerHelper = { available: false, reason: 'Certificate signing required' };
    if (signingIdentity !== '-') {
      const probe = path.join(temporary, 'signing-probe');
      await cp('/usr/bin/true', probe);
      run('codesign', ['--force', '--sign', signingIdentity, '--timestamp=none', probe]);
      const signature = spawnSync('codesign', ['-d', '--verbose=4', probe], { encoding: 'utf8' });
      const teamId = signature.stderr.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
      if (signature.status !== 0 || !teamId) throw new Error('无法读取签名证书的 Team ID。');
      computerHelper = { available: true, ...await patchNativeHelperTeam(
        path.join(output, 'Contents/Helpers/Grok Bot Computer Use.app/Contents/MacOS/CUGrokBotService'), teamId) };
    }
    if (updateConfig) {
      await writeFile(path.join(outResources, 'rokbot-local-update.json'), JSON.stringify(updateConfig, null, 2) + '\n');
    }
    await installBundleIcon({ outResources, icnsPath });
    run('xattr', ['-cr', output]);
    // --deep does not cover every library under Electron's Framework/Libraries
    // directory. Sign each native binary first so hardened-runtime library
    // validation sees the same developer identity throughout the bundle.
    // On Intel Macs, codesign defaults to 4 KiB pages even for arm64 slices;
    // explicitly use 16 KiB pages for arm64 builds to match Apple Silicon.
    const signPageSize = supported.architecture === 'arm64' ? ['--pagesize', '16384'] : [];
    for (const filename of (await nativeFiles(path.join(output, 'Contents'))).sort((a, b) => b.length - a.length))
      run('codesign', ['--force', '--sign', signingIdentity, '--timestamp=none', ...signPageSize, filename], { timeout: 120000 });
    run('codesign', ['--force', '--deep', '--sign', signingIdentity, '--options', 'runtime', '--timestamp=none', ...signPageSize, '--entitlements', entitlements, output], { timeout: 120000 });
    run('codesign', ['--verify', '--deep', '--strict', output]);
    if (await hash(asarPath) !== asarSha256) throw new Error('原版文件意外变化。');
    const iconVerification = await verifyRokBotIcons({
      icnsPath,
      iconPngPath,
      rendererIconPngPath,
      outIconPath: path.join(outResources, 'icon.icns'),
      outAsarPath: outAsar,
      asarModule: asar,
    });
    const manifest = { patchedAt: new Date().toISOString(), source, output, backup,
      version: supported.version, architecture: supported.architecture, originalAsarSha256: asarSha256,
      patchedAsarSha256: await hash(outAsar), originalEntry: previousMain, patchedEntry: pkg.main,
      bundleId: info.CFBundleIdentifier, signature: signingKind, ...iconVerification,
      originalFrameworkSha256: frameworkSha256, originalUnchanged: true,
      originalWindow: { frame: true, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } },
      profile: PROFILE_DISPLAY_PATH, automaticUpdates: Boolean(updateConfig), ...(updateConfig ?? {}), computerHelper,
      timings: { ...timings, totalSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)) } };
    await writeFile(`${output}.patch.json`, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
  }
} catch (error) {
  if (createdOutput) await rm(output, { recursive: true, force: true });
  console.error(error.message); process.exitCode = 1;
} finally {
  if (mounted) { try { run('hdiutil', ['detach', path.join(temporary, 'mount')]); } catch {} }
  await rm(temporary, { recursive: true, force: true });
}
}

if (isMain) {
  await main();
}

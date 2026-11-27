#!/usr/bin/env node
// Build the RokBot Linux desktop client (portable folder, .tar.gz, and .deb) from the user's
// own official Grok Bot Linux .deb (verified against pinned SHA-256 hashes).
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDesktopSource } from '../../../mac/patchers/desktop/download-original.mjs';
import { extractNotificationPolicy } from '../../../mac/patchers/desktop/extract-policy.mjs';
import { applyReleaseRecipes } from '../../../mac/patchers/desktop/release-recipes.mjs';
import { patchDesktopUpdateSettingsUi, resolveDesktopUpdateConfig } from '../../../mac/patchers/desktop/update-config.mjs';
import { LINUX_ARCHITECTURES, selectLinuxRelease } from './inputs.mjs';
import { appVersionArg, resolveAppVersion } from '../../../mac/patchers/desktop/app-version.mjs';
import { buildDeb, createTarGz, unpackDeb } from './deb.mjs';
import {
  applyRokBotLinuxAsarIcons,
  buildAppArmorProfile,
  LINUX_BINARY_NAME,
  resolveLinuxTailcatBinary,
  resolveRokBotLinuxLogoPaths,
  stageDebianTree,
} from './brand-assets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const linuxRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(linuxRoot, '..');
const clientsRoot = path.join(repoRoot, 'mac/clients');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) { return sha(await readFile(file)); }

function printHelp() {
  console.log(`node linux/patchers/desktop/patch.mjs [--source <grok-bot_1.3.0_<arch>.deb | 安装目录>] [--arch <${LINUX_ARCHITECTURES.join('|')}>]
    [--output <目录>] [--app-version <x.y.z>] [--no-deb] [--no-tar] [--verify-only] [--force]
    [--update-url <URL> --update-public-key <PEM|Base64> | --update-public-key-file <文件>]
生成 RokBot Linux 桌面客户端（便携目录、.tar.gz 与 .deb 安装包）。
--source 指定的官方 Linux .deb 按摘要自动识别架构与版本；省略 --source 时自动下载并校验 --arch（默认当前架构）对应的官方包。
--verify-only 在临时目录验证官方包、recipe 与更新设置补丁，不生成输出文件。
--no-deb / --no-tar 可跳过生成对应分发包。
--app-version 设置 RokBot 对外版本号（package.json、deb control 与文件名），不低于官方输入版本；默认与官方版本相同。
默认输出到 linux/output/。`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { printHelp(); return; }
  const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const updateConfig = await resolveDesktopUpdateConfig(args);
  const verifyOnly = args.includes('--verify-only');
  const skipDeb = args.includes('--no-deb');
  const skipTar = args.includes('--no-tar');
  const force = args.includes('--force');
  const requestedAppVersion = appVersionArg(args);

  const explicitSource = arg('--source');
  const release = await selectLinuxRelease({
    source: explicitSource,
    arch: arg('--arch'),
    version: arg('--version'),
  });
  const { directory: releaseDir, supported, arch } = release;
  const appVersion = resolveAppVersion(requestedAppVersion, supported.version);

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rokbot-linux-patch-'));
  try {
    let sourcePath;
    let isDirectorySource = false;
    if (explicitSource) {
      const info = await stat(explicitSource).catch(() => null);
      if (info?.isDirectory()) {
        sourcePath = path.resolve(explicitSource);
        isDirectorySource = true;
      }
    }
    if (!isDirectorySource) {
      sourcePath = await acquireDesktopSource({
        source: explicitSource,
        cacheDirectory: verifyOnly ? path.join(temporary, 'download') : path.join(linuxRoot, '.cache'),
        supported,
        onDownload: ({ version }) => console.error(`正在下载 Grok Bot ${version} Linux ${arch} 官方安装包…`),
      });
    }

    let appDir;
    let upstreamControlText = '';
    if (isDirectorySource) {
      appDir = (await stat(path.join(sourcePath, 'resources/app.asar')).catch(() => null))?.isFile()
        ? sourcePath
        : path.join(sourcePath, 'opt/Grok Bot');
    } else {
      const unpackedDeb = await unpackDeb(sourcePath, path.join(temporary, 'orig'));
      appDir = unpackedDeb.appDir;
      upstreamControlText = await readFile(path.join(unpackedDeb.controlDir, 'control'), 'utf8').catch(() => '');
    }

    const originalBin = path.join(appDir, 'grok-bot');
    const originalAsar = path.join(appDir, 'resources/app.asar');
    const [binSha, asarSha] = await Promise.all([hashFile(originalBin), hashFile(originalAsar)]);
    if (binSha !== supported.binSha256 || asarSha !== supported.asarSha256) {
      throw new Error(`不支持此发行包。仅支持未经修改的 Grok Bot ${supported.version} Linux ${arch}；程序或 ASAR 摘要不匹配。`);
    }

    let asar;
    try { asar = createRequire(path.join(repoRoot, 'mac/patchers/desktop/package.json'))('@electron/asar'); }
    catch { throw new Error('缺少 @electron/asar；执行 npm install --prefix mac/patchers/desktop。'); }

    const rawHeader = asar.getRawHeader(originalAsar);
    const asarHeaderSha256 = sha(rawHeader.headerString);
    if (supported.asarHeaderSha256 && asarHeaderSha256 !== supported.asarHeaderSha256) {
      throw new Error(`ASAR 头摘要不匹配（Linux ${arch}）。`);
    }

    const unpacked = path.join(temporary, 'unpacked');
    asar.extractAll(originalAsar, unpacked);
    const [preloadSha, vncPreloadSha] = await Promise.all([
      hashFile(path.join(unpacked, 'dist/electron-preload/preload.cjs')),
      hashFile(path.join(unpacked, 'dist/electron-preload/preload-vnc.cjs')),
    ]);
    if (preloadSha !== supported.preloadSha256 || vncPreloadSha !== supported.vncPreloadSha256) {
      throw new Error('原版 preload 摘要不匹配。');
    }

    const notificationPolicy = await extractNotificationPolicy(unpacked, releaseDir);
    const recipesDir = path.join(releaseDir, 'recipes');
    const recipesManifest = JSON.parse(await readFile(path.join(recipesDir, 'manifest.json'), 'utf8'));
    await applyReleaseRecipes(unpacked, recipesDir);
    const recipesCount = recipesManifest.files.length;
    const updateUiPatch = await patchDesktopUpdateSettingsUi(unpacked);

    const { binaryPath: tailcatPath, licensePath: tailcatLicensePath } = resolveLinuxTailcatBinary(repoRoot, arch);
    const tailcatStat = await stat(tailcatPath).catch(() => null);
    if (!tailcatStat?.isFile()) {
      throw new Error(`缺少 Linux ${arch} Tailcat 二进制文件：${tailcatPath}`);
    }

    if (verifyOnly) {
      console.log(JSON.stringify({
        verified: true,
        recipesVerified: true,
        recipesCount,
        version: supported.version,
        appVersion,
        architecture: arch,
        debianArchitecture: supported.debianArchitecture,
        asarSha256: asarSha,
        asarHeaderSha256,
        updateUiPatched: Boolean(updateUiPatch),
        tailcatBinary: path.relative(repoRoot, tailcatPath),
      }));
      return;
    }

    // Inject RokBot local-client, shared helpers, notification policy, and RokBot icon.
    const pkgPath = path.join(unpacked, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    pkg.main = 'local-client/main.mjs';
    pkg.version = appVersion; // app.getVersion() and the updater compare against this.
    pkg.name = 'rokbot-local';
    pkg.productName = 'RokBot Local';
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

    await cp(path.join(clientsRoot, 'desktop'), path.join(unpacked, 'local-client'), {
      recursive: true,
      filter: filename => !filename.endsWith('/notification-policy.mjs'),
    });
    await writeFile(path.join(unpacked, 'local-client/notification-policy.mjs'), notificationPolicy);
    await cp(path.join(clientsRoot, 'shared'), path.join(unpacked, 'shared'), { recursive: true });
    await applyRokBotLinuxAsarIcons(unpacked, repoRoot);

    const outputRoot = path.resolve(arg('--output') ?? path.join(linuxRoot, 'output'));
    await mkdir(outputRoot, { recursive: true });
    const baseName = `RokBotLocal-${appVersion}-linux-${arch}`;
    const portableDir = path.join(outputRoot, baseName);
    const tarPath = path.join(outputRoot, `${baseName}.tar.gz`);
    const debPath = path.join(outputRoot, `${baseName}.deb`);
    const reportPath = path.join(outputRoot, `${baseName}.patch.json`);

    if (!force && (await stat(portableDir).catch(() => null))) {
      throw new Error(`输出目录已存在：${portableDir}（可加 --force 覆盖）`);
    }

    const stagePortable = path.join(temporary, 'portable');
    await cp(appDir, stagePortable, { recursive: true });

    // Rename main Electron binary to `rokbot` and ensure executable bits.
    await rename(path.join(stagePortable, 'grok-bot'), path.join(stagePortable, LINUX_BINARY_NAME));
    await chmod(path.join(stagePortable, LINUX_BINARY_NAME), 0o755);

    // Repack app.asar cleanly.
    const outResources = path.join(stagePortable, 'resources');
    const outAsar = path.join(outResources, 'app.asar');
    await rm(outAsar, { force: true });
    await asar.createPackageWithOptions(unpacked, outAsar, { unpackDir: '{dist/native}' });

    // Copy RokBot icon, Tailcat binary, license, AppArmor profile, and optional update config.
    const { icon512Path } = resolveRokBotLinuxLogoPaths(repoRoot);
    await cp(icon512Path, path.join(outResources, 'icon.png'));
    await cp(tailcatPath, path.join(outResources, 'rokbot-tailcat'));
    await chmod(path.join(outResources, 'rokbot-tailcat'), 0o755);
    if ((await stat(tailcatLicensePath).catch(() => null))?.isFile()) {
      await cp(tailcatLicensePath, path.join(outResources, 'TAILCAT-LICENSE'));
    }
    await writeFile(path.join(outResources, 'apparmor-profile'), buildAppArmorProfile(), 'utf8');
    if (updateConfig) {
      await writeFile(
        path.join(outResources, 'rokbot-local-update.json'),
        JSON.stringify({ updateUrl: updateConfig.updateUrl, updatePublicKey: updateConfig.updatePublicKey }, null, 2),
        'utf8',
      );
    }

    const outAsarSha256 = await hashFile(outAsar);
    const outAsarHeaderSha256 = sha(asar.getRawHeader(outAsar).headerString);
    const outAsarSize = (await stat(outAsar)).size;

    // Publish portable directory atomically.
    await rm(portableDir, { recursive: true, force: true });
    await cp(stagePortable, portableDir, { recursive: true });

    const outputs = { portableDir };
    if (!skipTar) {
      const tmpTar = path.join(temporary, `${baseName}.tar.gz`);
      await createTarGz(outputRoot, tmpTar, [baseName]);
      await cp(tmpTar, tarPath);
      outputs.tarGz = { path: tarPath, bytes: (await stat(tarPath)).size, sha256: await hashFile(tarPath) };
    }

    if (!skipDeb) {
      const debRoot = path.join(temporary, 'deb-out');
      const { controlDir, dataDir } = await stageDebianTree({
        portableDir: stagePortable,
        version: appVersion,
        debianArchitecture: supported.debianArchitecture,
        upstreamControlText,
        repoRoot,
        debRoot,
      });
      const tmpDeb = path.join(temporary, `${baseName}.deb`);
      await buildDeb({ controlDir, dataDir, outputPath: tmpDeb });
      await cp(tmpDeb, debPath);
      outputs.deb = { path: debPath, bytes: (await stat(debPath)).size, sha256: await hashFile(debPath) };
    }

    const report = {
      schema: 'rokbot-linux-patch/v1',
      version: appVersion,
      upstreamVersion: supported.version,
      architecture: arch,
      debianArchitecture: supported.debianArchitecture,
      patchedAt: new Date().toISOString(),
      sourceArchiveSha256: supported.archive.sha256,
      sourceAsarSha256: asarSha,
      asarSha256: outAsarSha256,
      asarHeaderSha256: outAsarHeaderSha256,
      asarSize: outAsarSize,
      recipesApplied: recipesCount,
      rokbotIconApplied: true,
      ...(updateConfig ? { updateUrl: updateConfig.updateUrl, updatePublicKey: updateConfig.updatePublicKey } : {}),
      outputs,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

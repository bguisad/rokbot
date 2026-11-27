import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_DISPLAY_NAME = 'RokBot Local';
export const APP_USER_MODEL_ID = 'dev.rokbot.local';
export const PROFILE_DISPLAY_PATH = '%APPDATA%\\RokBot Local';
export const WINDOWS_PE_VERSION_STRINGS = {
  ProductName: APP_DISPLAY_NAME,
  FileDescription: APP_DISPLAY_NAME,
  CompanyName: 'RokBot',
  InternalName: APP_DISPLAY_NAME,
  OriginalFilename: 'RokBot Local.exe',
  LegalCopyright: 'RokBot',
};
const RENDERER_APP_ICON_RE = /^app-icon-[^/]+\.png$/;

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// @electron/asar resolves archive paths by splitting on path.sep, so on Windows a
// forward-slash path like dist/renderer/assets/x.png is "not found". Always hand it
// native separators; report/compare with forward slashes.
const toArchivePath = (rel, sep = path.sep) => rel.split('/').join(sep);
const fromArchivePath = name => name.replaceAll('\\', '/').replace(/^\//, '');

export function resolveRokBotWindowsLogoPaths(repoRoot) {
  return {
    icoPath: path.join(repoRoot, 'assets/logo/rokbot.ico'),
    iconPngPath: path.join(repoRoot, 'assets/logo/rokbot-icon-512.png'),
    rendererIconPngPath: path.join(repoRoot, 'assets/logo/rokbot-icon-256.png'),
  };
}

export function resolveWindowsTailcatSource(windowsRoot) {
  return path.join(windowsRoot, 'dist/network/rokbot-tailcat.exe');
}

export function resolveSetupStubSource(windowsRoot) {
  return path.join(windowsRoot, 'dist/installer/rokbot-setup-stub.exe');
}

export async function stageLocalClientWindowsIcons({ unpackedDir, icoPath, iconPngPath, rendererIconPngPath = iconPngPath }) {
  await cp(iconPngPath, path.join(unpackedDir, 'local-client/icon.png'));
  await cp(icoPath, path.join(unpackedDir, 'local-client/icon.ico'));
  const assetsDir = path.join(unpackedDir, 'dist/renderer/assets');
  if (existsSync(assetsDir)) {
    for (const name of (await readdir(assetsDir)).sort()) {
      if (RENDERER_APP_ICON_RE.test(name)) {
        await cp(rendererIconPngPath, path.join(assetsDir, name));
      }
    }
  }
}

export async function verifyRokBotWindowsIcons({ icoPath, iconPngPath, rendererIconPngPath = iconPngPath, outAsarPath, asarModule, pathSep = path.sep }) {
  const extract = rel => asarModule.extractFile(outAsarPath, toArchivePath(rel, pathSep));
  const [expectedIcoSha256, expectedPngSha256, expectedRendererPngSha256] = await Promise.all([
    readFile(icoPath).then(sha),
    readFile(iconPngPath).then(sha),
    readFile(rendererIconPngPath).then(sha),
  ]);
  const localIconSha256 = sha(extract('local-client/icon.png'));
  if (localIconSha256 !== expectedPngSha256) {
    throw new Error('RokBot 图标替换校验失败（local-client/icon.png）。');
  }
  const iconSha256 = sha(extract('local-client/icon.ico'));
  if (iconSha256 !== expectedIcoSha256) {
    throw new Error('RokBot 图标替换校验失败（local-client/icon.ico）。');
  }
  const rendererAppIcons = asarModule.listPackage(outAsarPath)
    .map(fromArchivePath)
    .filter(name => /^dist\/renderer\/assets\/app-icon-[^/]+\.png$/.test(name));
  for (const rel of rendererAppIcons) {
    if (sha(extract(rel)) !== expectedRendererPngSha256) {
      throw new Error(`RokBot 图标替换校验失败（${rel}）。`);
    }
  }
  return { rokbotIconApplied: true, iconSha256, localIconSha256, rendererAppIcons };
}

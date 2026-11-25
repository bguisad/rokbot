import { createHash } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
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

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function resolveRokBotWindowsLogoPaths(repoRoot) {
  return {
    icoPath: path.join(repoRoot, 'assets/logo/rokbot.ico'),
    iconPngPath: path.join(repoRoot, 'assets/logo/rokbot-icon-512.png'),
  };
}

export function resolveWindowsTailcatSource(windowsRoot) {
  return path.join(windowsRoot, 'dist/network/rokbot-tailcat.exe');
}

export function resolveSetupStubSource(windowsRoot) {
  return path.join(windowsRoot, 'dist/installer/rokbot-setup-stub.exe');
}

export async function stageLocalClientWindowsIcons({ unpackedDir, icoPath, iconPngPath }) {
  await cp(iconPngPath, path.join(unpackedDir, 'local-client/icon.png'));
  await cp(icoPath, path.join(unpackedDir, 'local-client/icon.ico'));
}

export async function verifyRokBotWindowsIcons({ icoPath, iconPngPath, outAsarPath, asarModule }) {
  const [expectedIcoSha256, expectedPngSha256] = await Promise.all([
    readFile(icoPath).then(sha),
    readFile(iconPngPath).then(sha),
  ]);
  const localIconSha256 = sha(asarModule.extractFile(outAsarPath, 'local-client/icon.png'));
  if (localIconSha256 !== expectedPngSha256) {
    throw new Error('RokBot 图标替换校验失败（local-client/icon.png）。');
  }
  const iconSha256 = sha(asarModule.extractFile(outAsarPath, 'local-client/icon.ico'));
  if (iconSha256 !== expectedIcoSha256) {
    throw new Error('RokBot 图标替换校验失败（local-client/icon.ico）。');
  }
  return { rokbotIconApplied: true, iconSha256, localIconSha256 };
}

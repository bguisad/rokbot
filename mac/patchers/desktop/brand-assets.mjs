import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export const BUNDLE_IDENTIFIER = 'dev.rokbot.local';
export const BUNDLE_NAME = 'RokBot';
export const URL_SCHEME = 'rokbot-local';
export const URL_SCHEME_NAME = 'RokBot Local';
export const LOCAL_NETWORK_USAGE_DESCRIPTION = 'Connect to your RokBot Host on the local network.';
export const PROFILE_DISPLAY_PATH = '~/Library/Application Support/RokBot Local';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function resolveRokBotLogoPaths(repoRoot) {
  return {
    icnsPath: path.join(repoRoot, 'assets/logo/rokbot.icns'),
    iconPngPath: path.join(repoRoot, 'assets/logo/rokbot-icon-512.png'),
  };
}

export function resolveTailcatSource(macRoot) {
  return path.join(macRoot, 'dist/network/rokbot-tailcat');
}

export async function stageLocalClientIcon({ unpackedDir, iconPngPath }) {
  await cp(iconPngPath, path.join(unpackedDir, 'local-client/icon.png'));
}

export async function installBundleIcon({ outResources, icnsPath }) {
  await rm(path.join(outResources, 'Assets.car'), { force: true });
  await cp(icnsPath, path.join(outResources, 'icon.icns'));
}

export function applyRokBotInfoPlist(info) {
  info.CFBundleIdentifier = BUNDLE_IDENTIFIER;
  // Electron resolves Contents/Frameworks/<CFBundleName> Helper*.app on macOS;
  // keep CFBundleName aligned with CFBundleExecutable / helper bundle names while
  // CFBundleDisplayName and app.setName() rebrand user-facing surfaces.
  info.CFBundleDisplayName = BUNDLE_NAME;
  info.CFBundleIconFile = 'icon.icns';
  delete info.CFBundleIconName;
  info.NSLocalNetworkUsageDescription = LOCAL_NETWORK_USAGE_DESCRIPTION;
  info.CFBundleURLTypes = [
    { CFBundleTypeRole: 'Viewer', CFBundleURLName: URL_SCHEME_NAME, CFBundleURLSchemes: [URL_SCHEME] },
  ];
  for (const key of ['SUFeedURL', 'SUPublicEDKey', 'SUEnableAutomaticChecks', 'SUAutomaticallyUpdate']) {
    delete info[key];
  }
  return info;
}

/** Rebrand Electron Framework helper Info.plist metadata while keeping CFBundleExecutable intact. */
export function applyRokBotHelperInfoPlist(helper, { originalBundleId, targetBundleId = BUNDLE_IDENTIFIER }) {
  let changed = false;
  if (typeof helper.CFBundleIdentifier === 'string' && helper.CFBundleIdentifier.startsWith(originalBundleId)) {
    helper.CFBundleIdentifier = helper.CFBundleIdentifier.replace(originalBundleId, targetBundleId);
    changed = true;
  }
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    if (typeof helper[key] === 'string' && /\bGrok\s*Bot\b/i.test(helper[key])) {
      helper[key] = helper[key].replace(/\bGrok\s*Bot\b/gi, BUNDLE_NAME);
      changed = true;
    }
  }
  return changed;
}

export async function verifyRokBotIcons({ icnsPath, iconPngPath, outIconPath, outAsarPath, asarModule }) {
  if (existsSync(path.join(path.dirname(outIconPath), 'Assets.car'))) {
    throw new Error('RokBot 图标替换校验失败（Assets.car 未移除）。');
  }
  const [expectedIcnsSha256, iconSha256, expectedPngSha256] = await Promise.all([
    readFile(icnsPath).then(sha),
    readFile(outIconPath).then(sha),
    readFile(iconPngPath).then(sha),
  ]);
  if (iconSha256 !== expectedIcnsSha256) {
    throw new Error('RokBot 图标替换校验失败（icon.icns）。');
  }
  const localIconSha256 = sha(asarModule.extractFile(outAsarPath, 'local-client/icon.png'));
  if (localIconSha256 !== expectedPngSha256) {
    throw new Error('RokBot 图标替换校验失败（local-client/icon.png）。');
  }
  return { rokbotIconApplied: true, iconSha256, localIconSha256 };
}

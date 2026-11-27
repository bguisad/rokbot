// Outward-facing version of a RokBot desktop/web build. The official input
// installer stays pinned (supported.json); --app-version only changes the
// version RokBot reports (package.json, Info.plist, PE resources, deb control,
// artifact names), so already-installed clients see the rebuild as newer.
import { compareVersions } from '../../clients/desktop/updater.mjs';

const RELEASE_VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;

export function resolveAppVersion(requested, upstreamVersion) {
  if (requested === undefined || requested === null) return upstreamVersion;
  const value = String(requested).trim();
  if (!RELEASE_VERSION.test(value)) throw new Error(`--app-version 必须是 x.y.z 形式的数字版本：${requested}`);
  if (compareVersions(value, upstreamVersion) < 0) {
    throw new Error(`--app-version ${value} 不能低于官方输入版本 ${upstreamVersion}。`);
  }
  return value;
}

/** Read --app-version from argv; a flag without a value is an error rather than silently ignored. */
export function appVersionArg(args) {
  const index = args.indexOf('--app-version');
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--app-version 需要一个版本号，例如 --app-version 1.3.1');
  return value;
}

/** Windows VS_FIXEDFILEINFO wants four 16-bit parts. */
export function windowsFixedVersion(version) {
  const parts = String(version).split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff)) {
    throw new Error(`无法写入 Windows 版本资源：${version}`);
  }
  return parts;
}

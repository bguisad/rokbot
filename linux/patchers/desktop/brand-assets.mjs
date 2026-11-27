// RokBot Linux desktop branding, icons, .desktop entry, AppArmor profile, Debian control/maintainer scripts, and Tailcat binary resolution.
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const LINUX_ICON_SIZES = [16, 32, 48, 64, 128, 256, 512];
export const LINUX_PACKAGE_NAME = 'rokbot-local';
export const LINUX_INSTALL_DIR = '/opt/RokBot';
export const LINUX_BINARY_NAME = 'rokbot';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function assertValidPng(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC) ||
      bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`Invalid RokBot PNG icon: ${label}`);
  }
}

export function resolveRokBotLinuxLogoPaths(repoRoot) {
  const logoDir = path.join(repoRoot, 'assets/logo');
  const sized = Object.fromEntries(
    LINUX_ICON_SIZES.map(size => [size, path.join(logoDir, `rokbot-icon-${size}.png`)]),
  );
  return {
    sized,
    icon512Path: sized[512],
  };
}

export function resolveLinuxTailcatBinary(repoRoot, arch) {
  const rel = arch === 'arm64' ? 'host/bin/linux-arm64/rokbot-tailcat' : 'host/bin/rokbot-tailcat';
  return {
    binaryPath: path.join(repoRoot, rel),
    licensePath: path.join(repoRoot, 'mac/clients/tailcat/LICENSE'),
  };
}

export async function applyRokBotLinuxAsarIcons(unpackedDir, repoRoot) {
  const { sized, icon512Path } = resolveRokBotLinuxLogoPaths(repoRoot);
  const [pngBytes, png256Bytes] = await Promise.all([readFile(icon512Path), readFile(sized[256])]);
  assertValidPng(pngBytes, icon512Path);
  assertValidPng(png256Bytes, sized[256]);
  const dest = path.join(unpackedDir, 'local-client/icon.png');
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, pngBytes);
  const assetsDir = path.join(unpackedDir, 'dist/renderer/assets');
  const rendererAppIcons = [];
  const entries = await readdir(assetsDir).catch(() => []);
  for (const name of entries.sort()) {
    if (!/^app-icon-[^/]+\.png$/.test(name)) continue;
    await writeFile(path.join(assetsDir, name), png256Bytes);
    rendererAppIcons.push(`dist/renderer/assets/${name}`);
  }
  return { icon512Sha256: sha(pngBytes), rendererAppIcons };
}

export async function installRokBotLinuxSystemIcons(dataDir, appResourcesDir, repoRoot) {
  const { sized, icon512Path } = resolveRokBotLinuxLogoPaths(repoRoot);
  const icon512 = await readFile(icon512Path);
  assertValidPng(icon512, icon512Path);
  await mkdir(appResourcesDir, { recursive: true });
  await writeFile(path.join(appResourcesDir, 'icon.png'), icon512);
  for (const size of LINUX_ICON_SIZES) {
    const bytes = await readFile(sized[size]);
    assertValidPng(bytes, sized[size]);
    const dest = path.join(dataDir, `usr/share/icons/hicolor/${size}x${size}/apps/${LINUX_BINARY_NAME}.png`);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }
}

export function buildDesktopEntry() {
  return [
    '[Desktop Entry]',
    'Name=RokBot',
    `Exec=${LINUX_INSTALL_DIR}/${LINUX_BINARY_NAME} -- %U`,
    'Terminal=false',
    'Type=Application',
    `Icon=${LINUX_BINARY_NAME}`,
    `StartupWMClass=${LINUX_BINARY_NAME}`,
    'Comment=RokBot Self-Hosted AI Assistant',
    'MimeType=x-scheme-handler/rokbot-local;',
    'Categories=Development;Network;Chat;',
    '',
  ].join('\n');
}

export function buildAppArmorProfile() {
  return [
    'abi <abi/4.0>,',
    'include <tunables/global>',
    '',
    `profile "${LINUX_BINARY_NAME}" "${LINUX_INSTALL_DIR}/${LINUX_BINARY_NAME}" flags=(unconfined) {`,
    '  userns,',
    '',
    `  include if exists <local/${LINUX_BINARY_NAME}>`,
    '}',
    '',
  ].join('\n');
}

async function directorySizeKb(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySizeKb(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return Math.max(1, Math.ceil(total / 1024));
}

export async function buildDebianControl({ version, debianArchitecture, upstreamControlText = '', dataDir }) {
  const dependsMatch = /^Depends:\s*(.+)$/m.exec(upstreamControlText);
  const recommendsMatch = /^Recommends:\s*(.+)$/m.exec(upstreamControlText);
  const depends = dependsMatch?.[1]?.trim()
    || 'libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0, libasound2t64 | libasound2, libgbm1, libxkbcommon0, libdrm2';
  const recommends = recommendsMatch?.[1]?.trim() || 'libappindicator3-1';
  const installedSize = dataDir ? await directorySizeKb(dataDir) : 395800;
  return [
    `Package: ${LINUX_PACKAGE_NAME}`,
    `Version: ${version}`,
    `Architecture: ${debianArchitecture}`,
    'Maintainer: RokBot Self-Hosted',
    `Installed-Size: ${installedSize}`,
    `Depends: ${depends}`,
    `Recommends: ${recommends}`,
    'Section: net',
    'Priority: optional',
    'Homepage: https://github.com/hongfaqiu/rokbot',
    'Description: RokBot Self-Hosted Desktop Client',
    ' Self-hosted RokBot desktop client built locally from official Electron resources.',
    '',
  ].join('\n');
}

/** Clean maintainer script: registers /usr/bin/rokbot, desktop/MIME/AppArmor, and NEVER installs upstream apt repositories. */
export function buildPostinstScript() {
  return `#!/bin/bash
set -e

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${LINUX_BINARY_NAME}' -a -e '/usr/bin/${LINUX_BINARY_NAME}' -a "$(readlink '/usr/bin/${LINUX_BINARY_NAME}')" != '/etc/alternatives/${LINUX_BINARY_NAME}' ]; then
        rm -f '/usr/bin/${LINUX_BINARY_NAME}'
    fi
    update-alternatives --install '/usr/bin/${LINUX_BINARY_NAME}' '${LINUX_BINARY_NAME}' '${LINUX_INSTALL_DIR}/${LINUX_BINARY_NAME}' 100 || ln -sf '${LINUX_INSTALL_DIR}/${LINUX_BINARY_NAME}' '/usr/bin/${LINUX_BINARY_NAME}'
else
    ln -sf '${LINUX_INSTALL_DIR}/${LINUX_BINARY_NAME}' '/usr/bin/${LINUX_BINARY_NAME}'
fi

if [ -f '${LINUX_INSTALL_DIR}/chrome-sandbox' ]; then
    if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
        chmod 4755 '${LINUX_INSTALL_DIR}/chrome-sandbox' || true
    else
        chmod 0755 '${LINUX_INSTALL_DIR}/chrome-sandbox' || true
    fi
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

if hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

if apparmor_status --enabled > /dev/null 2>&1; then
    APPARMOR_PROFILE_SOURCE='${LINUX_INSTALL_DIR}/resources/apparmor-profile'
    APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${LINUX_BINARY_NAME}'
    if [ -f "$APPARMOR_PROFILE_SOURCE" ] && apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
        cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
        if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
            apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET" || true
        fi
    fi
fi
`;
}

export function buildPostrmScript() {
  return `#!/bin/bash
set -e

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${LINUX_BINARY_NAME}' '${LINUX_INSTALL_DIR}/${LINUX_BINARY_NAME}' || true
else
    rm -f '/usr/bin/${LINUX_BINARY_NAME}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${LINUX_BINARY_NAME}'
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
    if apparmor_status --enabled > /dev/null 2>&1; then
        if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
            apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
        fi
    fi
    rm -f "$APPARMOR_PROFILE_DEST"
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
`;
}

export async function stageDebianTree({ portableDir, version, debianArchitecture, upstreamControlText, repoRoot, debRoot }) {
  const dataDir = path.join(debRoot, 'data');
  const controlDir = path.join(debRoot, 'control');
  const installDir = path.join(dataDir, LINUX_INSTALL_DIR.slice(1));
  await mkdir(path.dirname(installDir), { recursive: true });
  await mkdir(controlDir, { recursive: true });
  await cp(portableDir, installDir, { recursive: true });

  await installRokBotLinuxSystemIcons(dataDir, path.join(installDir, 'resources'), repoRoot);
  await writeFile(path.join(installDir, 'resources/apparmor-profile'), buildAppArmorProfile(), 'utf8');

  const applicationsDir = path.join(dataDir, 'usr/share/applications');
  await mkdir(applicationsDir, { recursive: true });
  await writeFile(path.join(applicationsDir, `${LINUX_BINARY_NAME}.desktop`), buildDesktopEntry(), 'utf8');

  const control = await buildDebianControl({ version, debianArchitecture, upstreamControlText, dataDir });
  await writeFile(path.join(controlDir, 'control'), control, 'utf8');
  await writeFile(path.join(controlDir, 'postinst'), buildPostinstScript(), { mode: 0o755 });
  await writeFile(path.join(controlDir, 'postrm'), buildPostrmScript(), { mode: 0o755 });
  await chmod(path.join(controlDir, 'postinst'), 0o755);
  await chmod(path.join(controlDir, 'postrm'), 0o755);

  return { dataDir, controlDir };
}

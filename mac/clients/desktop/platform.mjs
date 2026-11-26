// Platform window chrome and shell integration. macOS keeps the original inset
// traffic lights; Windows uses the original frameless window with native caption
// buttons drawn by the title-bar overlay, a notification-area icon and a Start menu
// shortcut that carries the toast identity.
import path from 'node:path';
import { linkSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';

export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';
export const APP_USER_MODEL_ID = 'dev.rokbot.local';
export const SHORTCUT_NAME = 'RokBot Local.lnk';

export function resolveDesktopProfile({ env = process.env, appDataDir }) {
  const debugPort = typeof env.ROKBOT_LOCAL_DEBUG_PORT === 'string' && env.ROKBOT_LOCAL_DEBUG_PORT.trim()
    ? env.ROKBOT_LOCAL_DEBUG_PORT.trim()
    : '';
  const testProfile = typeof env.ROKBOT_LOCAL_TEST_PROFILE === 'string' && env.ROKBOT_LOCAL_TEST_PROFILE.trim()
    ? env.ROKBOT_LOCAL_TEST_PROFILE.trim()
    : '';
  const isolatedProfile = Boolean(debugPort && testProfile);
  const profile = isolatedProfile
    ? path.resolve(testProfile)
    : path.join(appDataDir, 'RokBot Local');
  return { isolatedProfile, profile, debugPort };
}

// Values of the original Windows client: 52 px chrome minus its divider, and the
// modal dimming layers used while a sheet covers the window.
const OVERLAY_HEIGHT = 51, OVERLAY_TONE_HEIGHT = 43;
const COVER = { rgb: [20, 20, 20], alpha: 0.95 }, TOP_BAR = { rgb: [0, 0, 0], alpha: 0.55 }, FALLBACK = [24, 24, 24];
const rgb = hex => /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) : undefined;
const blend = (layer, hex) => {
  const base = rgb(hex) ?? FALLBACK;
  return `#${layer.rgb.map((value, index) => Math.round(value * layer.alpha + base[index] * (1 - layer.alpha))
    .toString(16).padStart(2, '0')).join('')}`;
};
const symbolColor = hex => {
  const [red, green, blue] = rgb(hex) ?? FALLBACK;
  return (red * 299 + green * 587 + blue * 114) / 1000 < 128 ? '#FFFFFF' : '#000000';
};

export function titleBarOverlay(background, tone = false) {
  const color = tone ? blend(TOP_BAR, blend(COVER, background)) : background;
  return { color, symbolColor: symbolColor(color), height: tone ? OVERLAY_TONE_HEIGHT : OVERLAY_HEIGHT };
}

export function windowChrome(background, platform = process.platform) {
  if (platform === 'win32') return { frame: false, titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(background) };
  if (platform === 'linux') return { frame: true };
  return { frame: true, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } };
}

/** The pairing window keeps its 42 px drag strip on macOS/Windows and uses native chrome on Linux. */
export function connectWindowChrome(platform = process.platform) {
  if (platform === 'win32') return { frame: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#111111', symbolColor: '#FFFFFF', height: 42 } };
  if (platform === 'linux') return {};
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } };
}

/** Original window RPCs used by the Windows renderer's title bar. */
export function windowHandlers(win, background, { platform = process.platform, workArea } = {}) {
  let color = background, tone = false;
  const windows = platform === 'win32';
  const apply = () => { if (windows && !win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay(color, tone)); };
  const state = () => ({ isFullscreen: win.isFullScreen(), isMaximized: win.isMaximized() });
  if (windows) for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'])
    win.on(event, () => { if (!win.isDestroyed()) win.webContents.send('dune-rpc:main:e:window-state', state()); });
  return {
    setBackground(value) { color = value; apply(); },
    handlers: windows ? {
      getWindowState: state,
      minimizeWindow: () => { win.minimize(); return null; },
      focusWindow: () => { win.show(); win.focus(); return null; },
      toggleMaximizeWindow: () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); return null; },
      closeWindow: () => { win.close(); return null; },
      resizeWindowWidth: ({ deltaWidth }) => {
        if (!Number.isFinite(deltaWidth) || win.isMaximized() || win.isFullScreen()) return null;
        const bounds = win.getBounds(), area = workArea?.(win) ?? bounds;
        const width = Math.max(720, Math.min(area.width, Math.round(bounds.width + deltaWidth)));
        win.setBounds({ ...bounds, width, x: Math.min(bounds.x, area.x + area.width - width) });
        return null;
      },
      setTitleBarOverlayTone: ({ isOverlayTone }) => { tone = isOverlayTone === true; apply(); return null; },
    } : {},
  };
}

/** A side-by-side install shares userData, but the legacy install keeps the OS registrations. */
export async function canRegisterDesktopIntegration({ isolatedProfile, platform = process.platform, execPath = process.execPath }) {
  if (isolatedProfile) return false;
  if (platform !== 'win32') return true;
  const directory = path.dirname(execPath), file = path.join(directory, '.rokbot-installation.json');
  let stat;
  try { stat = await lstat(file); }
  catch (error) { return error.code === 'ENOENT'; } // Portable build: no installer receipt.
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return false;
  try {
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    return receipt.format === 1 && receipt.appId === APP_USER_MODEL_ID &&
      receipt.directory?.toLowerCase() === directory.toLowerCase() && !Object.hasOwn(receipt, 'sideBySideOf');
  } catch { return false; }
}

/** Windows delivers toasts only for an app with a Start menu shortcut carrying its AppUserModelID. */
export function ensureStartMenuShortcut({ app, shell, execPath = process.execPath }) {
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', SHORTCUT_NAME);
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isFile()) return false;
    let current;
    try { current = shell.readShortcutLink(link); } catch { return false; }
    if (typeof current?.target !== 'string' || path.resolve(current.target).toLowerCase() !== execPath.toLowerCase() ||
        current.appUserModelId === APP_USER_MODEL_ID) return false;
    if (!shell.writeShortcutLink(link, 'update', { appUserModelId: APP_USER_MODEL_ID })) throw new Error('Could not update the Start menu shortcut');
    return true;
  }
  const options = { target: execPath, cwd: path.dirname(execPath), description: 'RokBot Local',
    icon: execPath, iconIndex: 0, appUserModelId: APP_USER_MODEL_ID };
  // Electron's create mode overwrites. Publish the finished link only if the destination is still free.
  const stage = mkdtempSync(path.join(path.dirname(link), '.rokbot-link-')), pending = path.join(stage, SHORTCUT_NAME);
  try {
    if (!shell.writeShortcutLink(pending, 'create', options)) throw new Error('Could not create the Start menu shortcut');
    try { linkSync(pending, link); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    return true;
  } finally {
    try { unlinkSync(pending); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(stage);
  }
}

export function createTray({ Tray, Menu, nativeImage, clientRoot, show, quit, text, platform = process.platform }) {
  const iconFile = platform === 'win32' ? 'icon.ico' : 'icon.png';
  const tray = new Tray(nativeImage.createFromPath(path.join(clientRoot, iconFile)));
  tray.setToolTip('RokBot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: text('打开 RokBot', 'Open RokBot'), click: show },
    { type: 'separator' },
    { label: text('退出', 'Quit'), click: quit },
  ]));
  tray.on('click', show);
  return tray;
}

export function initialLink(argv) {
  return argv.find(value => typeof value === 'string' && value.startsWith('rokbot-local:'))
    ?? argv.find(value => typeof value === 'string' && value.startsWith('grokbot-local:'))
    ?? null;
}

export function agentFromLink(link) {
  try {
    if (typeof link !== 'string' || !/^rokbot-local:\/\/agent\/[a-zA-Z0-9_-]{1,128}$/.test(link)) return null;
    const url = new URL(link);
    if (url.protocol !== 'rokbot-local:' || url.hostname !== 'agent' || url.search || url.hash) return null;
    return decodeURIComponent(url.pathname.slice(1));
  } catch { return null; }
}

/** Rewrite upstream renderer window titles (e.g. "Grok Bot") to "RokBot". */
export function normalizeDesktopWindowTitle(title) {
  if (typeof title !== 'string' || !title.trim()) return 'RokBot';
  return title.replace(/\bGrok\s*Bot\b/gi, 'RokBot');
}

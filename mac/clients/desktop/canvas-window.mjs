// Local canvases (`/canvas/<token>` on the Host) open in a RokBot window instead of the browser.
//
// The bot builds canvas links from the address it last saw a client use, which may not be the
// address this client reaches the Host at (LAN, Tailcat loopback forward, public URL). A link
// whose path is a canvas path is re-pointed at the Host this client is connected to, then shown
// in a sandboxed window with its own session partition and no preload, so canvas pages never
// see the workspace's bridge, cookies or storage. The canvas code itself additionally runs in a
// sandboxed iframe served with a `sandbox` CSP by the Host.
export const CANVAS_PATH_RE = /^\/canvas\/([A-Za-z0-9_-]{43})\/?$/;

/** The canvas URL on the connected Host, or null when `value` is not a local canvas link. */
export function canvasTarget(value, server) {
  if (typeof value !== 'string' || typeof server !== 'string' || !server) return null;
  let url, base;
  try { url = new URL(value.trim()); base = new URL(server); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const match = CANVAS_PATH_RE.exec(url.pathname);
  if (!match) return null;
  const theme = url.searchParams.get('theme');
  const target = new URL(`/canvas/${match[1]}`, base.origin);
  if (theme === 'dark' || theme === 'light') target.searchParams.set('theme', theme);
  return target.toString();
}

export function createCanvasWindows({ BrowserWindow, nativeTheme, openExternal, icon, text, getServer }) {
  const open = new Map();
  const api = {
    /** Opens `value` as a canvas window; false when it is not a local canvas link. */
    open(value) {
      const target = canvasTarget(value, getServer());
      if (!target) return false;
      const key = new URL(target).pathname;
      const existing = open.get(key);
      if (existing && !existing.isDestroyed()) {
        if (existing.webContents.getURL() !== target) void existing.loadURL(target);
        existing.show(); existing.focus();
        return true;
      }
      const win = new BrowserWindow({
        width: 1100, height: 820, minWidth: 420, minHeight: 360,
        title: text('RokBot 画布', 'RokBot Canvas'),
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#121212' : '#fcfcfc',
        ...(icon ? { icon } : {}),
        webPreferences: {
          partition: 'rokbot-canvas', sandbox: true, contextIsolation: true, nodeIntegration: false,
          webviewTag: false, spellcheck: false, safeDialogs: true, navigateOnDragDrop: false,
        },
      });
      open.set(key, win);
      win.on('closed', () => { if (open.get(key) === win) open.delete(key); });
      win.setMenuBarVisibility?.(false);
      // Links inside the page leave the window; the page itself never navigates away.
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (!api.open(url)) void Promise.resolve(openExternal(url)).catch(() => {});
        return { action: 'deny' };
      });
      win.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).pathname === key) return;
        event.preventDefault();
        if (!api.open(url)) void Promise.resolve(openExternal(url)).catch(() => {});
      });
      win.webContents.on('page-title-updated', (event, title) => {
        event.preventDefault();
        win.setTitle(String(title || text('RokBot 画布', 'RokBot Canvas')));
      });
      win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      void win.loadURL(target);
      return true;
    },
    closeAll() {
      for (const win of open.values()) if (!win.isDestroyed()) win.destroy();
      open.clear();
    },
  };
  return api;
}

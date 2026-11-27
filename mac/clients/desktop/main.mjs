import { app, BrowserWindow, clipboard, dialog, ipcMain, MessageChannelMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, session, shell, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rokText as localText, setLocaleSource } from './i18n.mjs';
import { credentialStore, credentialUnavailableText, finishPairingWindow, pair, verifyDevice, openTransport, restoreConnection, savedConnectionMatches } from './connection.mjs';
import { APP_USER_MODEL_ID, canRegisterDesktopIntegration, connectWindowChrome, createTray, ensureStartMenuShortcut, initialLink, isLinux, isWindows,
  normalizeDesktopWindowTitle, resolveDesktopProfile, windowChrome, windowHandlers, windowIcon } from './platform.mjs';
import { createGateway } from './gateway.mjs';
import { createClientPersistence } from './client-persistence.mjs';
import { createAttachmentHandlers, createAttachmentMediaResolver } from './attachments.mjs';
import { createAttachmentUploads } from './attachment-uploads.mjs';
import { createNotifications, agentFromLink } from './notifications.mjs';
import { loadSettings, createSettings } from './settings.mjs';
import { createProfile } from './profile.mjs';
import { createLocalExec } from './local-exec.mjs';
import { createBrowserProviders } from './browser-providers.mjs';
import { createSounds } from './sounds.mjs';
import { mintVoiceCredential, createVoiceAvailability } from './voice.mjs';
import { externalHttpUrl } from './external-url.mjs';
import { installExternalLinks } from './external-links.mjs';
import { createCanvasWindows } from './canvas-window.mjs';
import { auth, boot, theme, language, experiments, createLocalServices, desktopEdges, probeLocalMethod } from './local-services.mjs';
import { createModelBridge } from './model-bridge.mjs';
import { createDesktopUpdater, createTailcatUpdateFetch, resolveDesktopUpdateSource } from './updater.mjs';
import { applyAsarUpdateAndRestart, canApplyAsarUpdate } from './asar-install.mjs';
import { createMigration } from './migrate-desktop.mjs';

const clientRoot = path.dirname(fileURLToPath(import.meta.url));
const payload = path.join(clientRoot, '../dist');
const { isolatedProfile, profile, debugPort } = resolveDesktopProfile({ appDataDir: app.getPath('appData') });
app.setPath('userData', profile);
app.setName('RokBot Local');
// Windows groups windows and delivers toasts by this ID; it matches the Start menu shortcut.
if (isWindows) app.setAppUserModelId(APP_USER_MODEL_ID);
const clientSettings = loadSettings(profile);
const enabledAtLaunch = clientSettings.hardwareAcceleration;
if (!enabledAtLaunch) app.disableHardwareAcceleration();
process.env.SAND_DISABLE_UPDATES = '1';
process.env.SAND_DISABLE_TELEMETRY = '1';
app.commandLine.appendSwitch('disable-breakpad');
// Debugging is opt-in and loopback only; packaged clients expose no debug port.
if (debugPort) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}
let config, mainWindow, connectWindow, gateway, notifications, connectionError = '';
let quitting = false, starting = true;
let transport, tray;
const transportBinary = path.join(process.resourcesPath, isWindows ? 'rokbot-tailcat.exe' : 'rokbot-tailcat');
let methodCall, accountProfile, localExec, browserProviders, voiceAvailability, deepLinksReady = false, pendingAgent = null;
const ports = new Set();
const store = credentialStore(profile, safeStorage);
const persistence = createClientPersistence(profile);
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', (_event, argv) => {
  const link = initialLink(argv);
  if (link) routeLink(link);
  else void showApp();
});
app.on('open-url', (event, url) => { event.preventDefault(); routeLink(url); });
// Re-pairing replaces the workspace window. Keep the process alive during that
// transition, just as closing the regular window keeps the client running
// (in the menu bar on macOS, in the notification area on Windows).
app.on('window-all-closed', () => {});
/** Bring back the current window, as the Dock icon does on macOS. */
async function showApp() {
  if (!app.isReady()) return;
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : connectWindow;
  if (window && !window.isDestroyed()) {
    // Windows may bring a hidden window back iconic when the call comes from the background.
    window.show();
    if (window.isMinimized()) window.restore();
    window.focus(); return;
  }
  if (!starting) await (transport && config ? showWorkspace() : showConnection());
}
function routeLink(url) { const id = agentFromLink(url); if (id) openAgent(id); }
// The chat on screen, as the official renderer reports it (setViewingAgent) or a link opens it.
// The composer suggestions (suggestions-composer.cjs) only show answers for this Bot.
let suggestionsAgentId = '';
function noteSuggestionsAgent(id) {
  const next = typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
  if (!next || next === suggestionsAgentId) return;
  suggestionsAgentId = next;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rokbot-local:viewing-agent', next);
}
function openAgent(id) {
  noteSuggestionsAgent(id);
  pendingAgent = id;
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (transport && config && app.isReady()) void showWorkspace();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
  if (deepLinksReady) {
    mainWindow.webContents.send('dune-rpc:main:e:focus-agent', { id });
    pendingAgent = null;
  }
}
function trusted(event, window) {
  return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}
function requireConnection(event) {
  if (!trusted(event, connectWindow) && !trusted(event, mainWindow)) throw new Error('Unexpected renderer');
}
function stopConnection() {
  voiceAvailability?.close(); voiceAvailability = null;
  browserProviders?.close(); browserProviders = null;
  localExec?.close(); localExec = null;
  for (const dispose of ports) dispose(); ports.clear();
  notifications?.stop(); notifications = null;
  gateway?.close();
}
function disposeWorkspace() {
  stopConnection();
  canvasWindows.closeAll();
  deepLinksReady = false; methodCall = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
}
function connectionStatus() {
  return { paired: Boolean(config), connected: Boolean(transport && config), server: config?.address ?? config?.server,
    tailcat: config?.tailcat === true, transportPath: transport?.tunnel?.status.path ?? 'direct',
    state: transport && config ? gateway?.getState() ?? 'connecting' : 'disconnected',
    profile: config ? accountProfile?.current() ?? null : null, error: connectionError };
}
function reportConnection() {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('rokbot-local:connection-changed', connectionStatus());
}
function unauthorized() {
  connectionError = localText('连接已失效，请重新配对。', 'Connection expired. Pair again.');
  void showConnection();
}
async function openBrowser(value) {
  const target = externalHttpUrl(value);
  if (!target) throw new Error(localText('链接地址无效。', 'Invalid link address.'));
  await shell.openExternal(target);
}
const canvasWindows = createCanvasWindows({ BrowserWindow, nativeTheme, openExternal: openBrowser,
  icon: windowIcon(clientRoot), text: localText, getServer: () => config?.server });
// Local canvas links open in a RokBot window on the connected Host; everything else in the browser.
async function openExternal(value) {
  if (canvasWindows.open(value)) return;
  await openBrowser(value);
}
async function showConnection() {
  if (!app.isReady()) return;
  if (connectWindow && !connectWindow.isDestroyed()) { connectWindow.show(); connectWindow.focus(); return; }
  nativeTheme.themeSource = ['dark', 'light', 'system'].includes(clientSettings.theme) ? clientSettings.theme : 'system';
  const connectBg = nativeTheme.shouldUseDarkColors ? '#111111' : '#ffffff';
  const desktopIcon = windowIcon(clientRoot);
  connectWindow = new BrowserWindow({ width: 510, height: 550, resizable: false, maximizable: false,
    title: localText('连接 RokBot', 'Connect RokBot'), backgroundColor: connectBg,
    ...(desktopIcon ? { icon: desktopIcon } : {}), ...connectWindowChrome(),
    webPreferences: { preload: path.join(clientRoot, 'connect-preload.cjs'), sandbox: true, nodeIntegration: false, contextIsolation: true } });
  connectWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  connectWindow.webContents.on('will-navigate', event => event.preventDefault());
  connectWindow.on('closed', () => { connectWindow = null; });
  await connectWindow.loadFile(path.join(clientRoot, 'connect.html'));
}
let migrateWindow = null;
const migration = createMigration({ getConfig: () => config, request: (...args) => {
  if (!gateway) throw new Error(localText('尚未连接 Host', 'Not connected to a Host'));
  return gateway.request(...args);
}, dialog, clipboard, getWindow: () => migrateWindow });
/** "Migrate from Grok Bot" window: the shared wizard over the device migration API. */
async function showMigration() {
  if (!app.isReady() || !config) return;
  if (migrateWindow && !migrateWindow.isDestroyed()) { migrateWindow.show(); migrateWindow.focus(); return; }
  const background = nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff';
  const desktopIcon = windowIcon(clientRoot);
  migrateWindow = new BrowserWindow({ width: 940, height: 780, minWidth: 560, minHeight: 520, title: localText('从 Grok Bot 迁移', 'Migrate from Grok Bot'),
    backgroundColor: background, ...(desktopIcon ? { icon: desktopIcon } : {}), ...windowChrome(background),
    webPreferences: { preload: path.join(clientRoot, 'migrate-preload.cjs'), sandbox: true, nodeIntegration: false, contextIsolation: true } });
  migrateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  migrateWindow.webContents.on('will-navigate', event => event.preventDefault());
  migrateWindow.on('closed', () => { migrateWindow = null; });
  await migrateWindow.loadFile(path.join(clientRoot, 'migrate.html'));
}
for (const [name, handler] of Object.entries({
  detect: () => migration.detect(),
  'upload-folder': (progress, folder) => migration.uploadFolder(String(folder ?? ''), progress),
  'choose-folder': progress => migration.chooseFolder(progress),
  'choose-file': progress => migration.chooseFile(progress),
  list: () => migration.list(),
  'create-token': (_progress, body) => migration.createToken(body),
  'revoke-token': (_progress, id) => migration.revokeToken(String(id)),
  prompt: (_progress, options) => migration.prompt(options ?? {}),
  preview: (_progress, id) => migration.preview(String(id)),
  import: (_progress, id, selection) => migration.import(String(id), selection),
  discard: (_progress, id) => migration.discard(String(id)),
  copy: (_progress, text) => migration.copy(text),
})) ipcMain.handle(`rokbot-migrate:${name}`, (event, ...args) => {
  if (!trusted(event, migrateWindow)) throw new Error('Unexpected renderer');
  const progress = value => { if (!event.sender.isDestroyed()) event.sender.send('rokbot-migrate:progress', value); };
  return handler(progress, ...args);
});
ipcMain.on('rokbot-local:migrate-open', event => { if (trusted(event, mainWindow)) void showMigration(); });

function updateMenu() {
  // Windows windows are frameless with native caption buttons; Linux uses standard File/Edit/View/Window menus.
  Menu.setApplicationMenu(Menu.buildFromTemplate(isWindows
    ? [{ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]
    : isLinux
      ? [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]
      : [{ label: 'RokBot', submenu: [{ role: 'about' }, { type: 'separator' },
        { label: localText('从 Grok Bot 迁移…', 'Migrate from Grok Bot…'), enabled: Boolean(config), click: () => void showMigration() }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
}
async function showWorkspace() {
  const pairingWindow = connectWindow;
  disposeWorkspace();
  const activeConfig = config;
  const reportFocus = () => {
    void gateway.command('setWindowFocused', { isFocused: Boolean(mainWindow?.isFocused()) }).catch(() => {});
    if (mainWindow?.isFocused()) void accountProfile?.refresh().catch(() => {});
  };
  gateway = createGateway(activeConfig, unauthorized, reportFocus, reportConnection);
  // The Host lists unnamed desktop clients as Macs; Windows and Linux report themselves once per session.
  if (isWindows || isLinux) void gateway.request('/local/device', { kind: 'desktop', clientKind: isWindows ? 'windows' : 'linux', appVersion: app.getVersion() },
    AbortSignal.timeout(15000), 'PUT').catch(() => {});
  // Apply the saved theme (system by default) before the first paint; createSettings applies it again.
  nativeTheme.themeSource = ['dark', 'light', 'system'].includes(clientSettings.theme) ? clientSettings.theme : 'system';
  const background = nativeTheme.shouldUseDarkColors ? '#111111' : '#ffffff';
  const desktopIcon = windowIcon(clientRoot);
  const win = new BrowserWindow({ width: 1200, height: 850, minWidth: 720, minHeight: 500,
    title: 'RokBot', backgroundColor: background,
    ...(desktopIcon ? { icon: desktopIcon } : {}), ...windowChrome(background),
    webPreferences: { preload: path.join(clientRoot, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: false, webviewTag: true } });
  mainWindow = win;
  const chrome = windowHandlers(win, background, { workArea: window => screen.getDisplayMatching(window.getBounds()).workArea });
  voiceAvailability = createVoiceAvailability({ request: gateway.request, window: win, experiments, getPreference: () => clientSettings.realtimeVoice });
  void voiceAvailability.refresh();
  accountProfile = createProfile({ request: gateway.request, window: win, auth, server: activeConfig.server, onChange: reportConnection });
  await accountProfile.refresh().catch(() => {});
  localExec = await createLocalExec({ payload, profile, config: activeConfig, command: gateway.command, request: gateway.request, window: win });
  browserProviders = await createBrowserProviders({ payload, profile, config: activeConfig, window: win,
    BrowserWindow, locale: () => language.resolved });
  win.on('focus', reportFocus); win.on('blur', reportFocus);
  // 1.1.0 tracks whether the workspace is on screen; 0.71.2 ignores these events.
  const send = (name, value) => { if (!win.isDestroyed()) win.webContents.send(`dune-rpc:main:e:${name}`, value); };
  for (const event of ['show', 'hide', 'minimize', 'restore'])
    win.on(event, () => send('window-visibility', { visible: win.isVisible() && !win.isMinimized() }));
  win.on('focus', () => send('window-focus', {}));
  win.on('close', event => {
    const keepInBackground = !isLinux || Boolean(tray);
    if (!quitting && keepInBackground) { event.preventDefault(); win.hide(); }
    else if (!quitting && isLinux) { quitting = true; app.quit(); }
    if (debugPort) console.log('[notification-window]', JSON.stringify({visible:win.isVisible(),focused:win.isFocused(),quitting}));
    void gateway.command('setWindowFocused', { isFocused: false }).catch(() => {});
  });
  notifications = await createNotifications({ config: activeConfig, profile, Notification, openAgent,
    sounds: await createSounds(profile, payload), command: gateway.command, getWindow: () => BrowserWindow.getFocusedWindow() ?? mainWindow,
    reportDecision: item => { if (debugPort) console.log('[notification-decision]', JSON.stringify(item)); },
    onUnauthorized: unauthorized });
  const uploads = createAttachmentUploads({ profile, command: gateway.command,
    onProgress: progress => { if (!win.isDestroyed()) win.webContents.send('dune-rpc:main:e:attachment-commit-progress', progress); } });
  const updater = createDesktopUpdater({
    appVersion: app.getVersion(),
    profileDir: profile,
    resourcesDir: process.resourcesPath,
    execPath: process.execPath,
    config: await resolveDesktopUpdateSource({
      resourcesDir: process.resourcesPath,
      profileDir: profile,
      server: activeConfig?.server,
    }),
    fetchImpl: createTailcatUpdateFetch({
      isTunneled: () => activeConfig?.tailcat === true,
      getServerUrl: () => activeConfig?.server ?? '',
      getToken: () => activeConfig?.token ?? '',
    }),
    onStatus: status => { if (!win.isDestroyed()) win.webContents.send('dune-rpc:main:e:update-status', status); },
    canUseAsarUpdate: canApplyAsarUpdate,
    onInstallAsar: info => applyAsarUpdateAndRestart({ ...info, quitApp: () => app.quit() }),
    onInstallFile: async file => {
      if (isWindows && String(file).toLowerCase().endsWith('.exe')) {
        spawn(file, ['/S', '/LAUNCH'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        app.quit();
        return;
      }
      const openError = await shell.openPath(file);
      if (openError) throw new Error(openError);
      app.quit();
    },
  });
  if (updater.status().delivery === 'in-app' && updater.status().autoUpdateWhenIdle) {
    void updater.check();
  }
  methodCall = await createLocalServices(profile, win, {
    appVersion: app.getVersion(), persistence, updater, emit: send,
    command: gateway.command, request: gateway.request, connection: showConnection, openExternal,
    attachmentHandlers: { ...uploads.handlers, ...createAttachmentHandlers({
      command: gateway.command,
      withStaged: uploads.withStaged,
      chooseDestination: async name => {
        const result = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
        return result.canceled ? null : result.filePath;
      },
      chooseDirectory: async () => {
        const result = await dialog.showOpenDialog(win, {
          defaultPath: app.getPath('downloads'),
          buttonLabel: localText('保存到此处', 'Save here'),
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
      },
      showDownloadError: () => dialog.showMessageBox(win, { type: 'error',
        message: localText('无法下载文件，请重试。', 'Could not download this file. Try again.') }),
    }) },
    disconnect: async () => { await store.clear(); config = null; disposeWorkspace(); await transport?.close(); transport = null; await showConnection(); },
    notifications: { ...notifications, noteViewingAgent: id => { notifications?.noteViewingAgent(id); noteSuggestionsAgent(id); } },
    settings: { ...createSettings({ profile, window: win, app, nativeTheme, settings: clientSettings, enabledAtLaunch, command: gateway.command, theme, language, boot,
      onVoicePreference: () => voiceAvailability.refresh(), onBackground: chrome.setBackground }), ...chrome.handlers,
      ...accountProfile.handlers, ...localExec.handlers, ...browserProviders.handlers,
      getExperimentsSnapshot: () => voiceAvailability.refresh() },
    pickAvatarFile: async () => {
      const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: localText('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      const bytes = await readFile(result.filePaths[0]);
      if (bytes.length > 20 * 1024 * 1024) throw new Error(localText('图片不能超过 20 MB。', 'Image must be smaller than 20 MB.'));
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error(localText('无法读取图片。', 'Could not read this image.'));
      return { dataUrl: image.toDataURL(), fileName: path.basename(result.filePaths[0]) };
    },
    attachment: createAttachmentMediaResolver({ command: gateway.command, withStaged: uploads.withStaged, nativeImage }),
  });
  installExternalLinks(win, { openExternal, clipboard, Menu, text: localText });
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    try {
      const url = new URL(params.src);
      if (url.origin !== activeConfig.server || !['http:', 'https:'].includes(url.protocol)) { event.preventDefault(); return; }
      preferences.sandbox = true; preferences.nodeIntegration = false; preferences.contextIsolation = true;
      preferences.preload = path.join(clientRoot, 'preload-vnc.cjs');
    } catch { event.preventDefault(); }
  });
  win.on('closed', () => {
    localExec?.close(); localExec = null;
    for (const dispose of ports) dispose(); ports.clear();
    deepLinksReady = false;
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on('preload-error', (_event, _file, error) => console.error('[preload]', error.message));
  win.webContents.on('render-process-gone', (_event, details) => console.error('[renderer]', details.reason));
  const workspaceStyle = await readFile(path.join(clientRoot, 'workspace.css'), 'utf8');
  win.on('page-title-updated', (event, title) => {
    const nextTitle = normalizeDesktopWindowTitle(title);
    if (nextTitle !== title) {
      event.preventDefault();
      win.setTitle(nextTitle);
    }
  });
  win.webContents.on('did-finish-load', () => {
    void win.webContents.insertCSS(workspaceStyle).catch(error => console.error('[workspace-style]', error.message));
  });
  await win.loadFile(path.join(payload, 'renderer/index.html'));
  updateMenu();
  finishPairingWindow(pairingWindow, connectWindow, connectionError);
}

const modelBridge = createModelBridge({
  getGateway: () => gateway,
  getConnected: () => Boolean(transport && config && gateway),
  text: localText,
});

ipcMain.on('rokbot-local:locale', event => { event.returnValue = trusted(event, mainWindow) || trusted(event, connectWindow) ? (clientSettings.language === 'system' ? app.getLocale() : clientSettings.language) : 'en'; });
ipcMain.on('sand:boot-snapshot-sync', event => { event.returnValue = trusted(event, mainWindow) ? boot : {}; });
ipcMain.handle('rokbot-local:status', async event => {
  requireConnection(event);
  if (config && accountProfile) await accountProfile.refresh().catch(() => {});
  return connectionStatus();
});
ipcMain.handle('rokbot-local:local-status', event => {
  if (!trusted(event, mainWindow)) throw new Error('Unexpected renderer');
  return modelBridge.getLocalStatus();
});
ipcMain.handle('rokbot-local:model-get', event => {
  if (!trusted(event, mainWindow)) throw new Error('Unexpected renderer');
  return modelBridge.getModelConfig();
});
ipcMain.handle('rokbot-local:usage', (event, payload) => {
  if (!trusted(event, mainWindow)) throw new Error('Unexpected renderer');
  return modelBridge.getUsage(payload);
});
ipcMain.handle('rokbot-local:model-put', (event, payload) => {
  if (!trusted(event, mainWindow)) throw new Error('Unexpected renderer');
  return modelBridge.updateModelConfig(payload);
});
ipcMain.handle('rokbot-local:model-catalog', (event, payload) => {
  if (!trusted(event, mainWindow)) throw new Error('Unexpected renderer');
  return modelBridge.fetchModelCatalog(payload);
});
ipcMain.handle('rokbot-local:model-test', (event, payload) => {
  if (!trusted(event, mainWindow)) throw new Error('Unexpected renderer');
  return modelBridge.testModelConfig(payload);
});
ipcMain.handle('rokbot-local:suggestions-settings-get', event => {
  if (!trusted(event, mainWindow) || !gateway) throw new Error('Unexpected renderer');
  return gateway.request('/local/suggestions/settings', null, AbortSignal.timeout(10000), 'GET');
});
ipcMain.handle('rokbot-local:suggestions-settings-put', (event, payload) => {
  if (!trusted(event, mainWindow) || !gateway) throw new Error('Unexpected renderer');
  return gateway.request('/local/suggestions/settings', payload ?? {}, AbortSignal.timeout(10000), 'PUT');
});
ipcMain.handle('rokbot-local:suggestions-phrase-add', (event, payload) => {
  if (!trusted(event, mainWindow) || !gateway) throw new Error('Unexpected renderer');
  return gateway.request('/local/suggestions/phrases', { text: payload?.text ?? '' }, AbortSignal.timeout(10000), 'POST');
});
ipcMain.handle('rokbot-local:suggestions-phrase-update', (event, payload) => {
  if (!trusted(event, mainWindow) || !gateway) throw new Error('Unexpected renderer');
  const id = String(payload?.id ?? '');
  return gateway.request(`/local/suggestions/phrases/${encodeURIComponent(id)}`, { text: payload?.text ?? '' }, AbortSignal.timeout(10000), 'PUT');
});
ipcMain.handle('rokbot-local:suggestions-phrase-delete', (event, payload) => {
  if (!trusted(event, mainWindow) || !gateway) throw new Error('Unexpected renderer');
  const id = String(payload?.id ?? '');
  return gateway.request(`/local/suggestions/phrases/${encodeURIComponent(id)}`, null, AbortSignal.timeout(10000), 'DELETE');
});
ipcMain.handle('rokbot-local:suggestions-phrase-reorder', (event, payload) => {
  if (!trusted(event, mainWindow) || !gateway) throw new Error('Unexpected renderer');
  return gateway.request('/local/suggestions/phrases/reorder', { ids: Array.isArray(payload?.ids) ? payload.ids : [] }, AbortSignal.timeout(10000), 'PUT');
});
// Composer suggestions and inline completion. Each call carries a renderer request id so a newer
// keystroke (rokbot-local:suggestions-cancel) aborts the Host request it replaces.
const suggestionCalls = new Map();
function suggestionCall(event, payload, path, timeoutMs) {
  if (!trusted(event, mainWindow) || !gateway) throw new Error('Unexpected renderer');
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId.slice(0, 64) : '';
  const body = payload?.body && typeof payload.body === 'object' && !Array.isArray(payload.body) ? payload.body : {};
  const controller = new AbortController();
  if (requestId) suggestionCalls.set(requestId, controller);
  return gateway.request(path, body, AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]), 'POST')
    .finally(() => { if (requestId && suggestionCalls.get(requestId) === controller) suggestionCalls.delete(requestId); });
}
ipcMain.handle('rokbot-local:suggestions-generate', (event, payload) => suggestionCall(event, payload, '/local/suggestions', 10000));
ipcMain.on('rokbot-local:viewing-agent-get', event => { event.returnValue = trusted(event, mainWindow) ? suggestionsAgentId : ''; });
ipcMain.handle('rokbot-local:suggestions-complete', (event, payload) => suggestionCall(event, payload, '/local/suggestions/complete', 9000));
ipcMain.on('rokbot-local:suggestions-cancel', (event, requestId) => {
  if (!trusted(event, mainWindow) || typeof requestId !== 'string') return;
  suggestionCalls.get(requestId)?.abort();
  suggestionCalls.delete(requestId);
});
ipcMain.handle('rokbot-local:download-attachments-zip', async (event, payload) => {
  if (!trusted(event, mainWindow) || !methodCall) throw new Error('Unexpected renderer');
  return methodCall('downloadAttachmentsZip', payload);
});
ipcMain.handle('rokbot-local:voice-credential', async (event, agentId) => {
  if (!trusted(event, mainWindow) || !config || !gateway) throw new Error('Unexpected renderer');
  try {
    if (clientSettings.realtimeVoice !== true) throw new Error(localText('请启用实时语音。', 'Enable realtime voice.'));
    return { ok: true, credential: await mintVoiceCredential({ request: gateway.request, server: config.server }, agentId) };
  }
  // 1.1.0 reads a missing usage refusal as a usage limit; this failure is never one.
  catch (error) { return { ok: false, fault: { reason: 'unavailable' }, usageRefusal: null, detail: error.message }; }
});
ipcMain.handle('rokbot-local:voice-preference', async (event, enabled) => {
  if (!trusted(event, mainWindow) || !methodCall) throw new Error('Unexpected renderer');
  return enabled === undefined ? methodCall('getRealtimeVoiceEnabled') : methodCall('setRealtimeVoiceEnabled', { enabled });
});
ipcMain.handle('rokbot-local:pair', async (event, args) => {
  requireConnection(event);
  try {
    const saved = config, editing = args.edit === true, tunneled = args.tailcat === true, mode = args.mode === 'password' ? 'password' : 'code';
    if (editing && !savedConnectionMatches(saved, args.server, tunneled))
      throw new Error(localText('更改 Host 地址需要新的配对码。', 'Enter a new pairing code to change the Host address.'));
    // Check the keychain before consuming a one-use pairing Key.
    if (!safeStorage.isEncryptionAvailable()) throw new Error(credentialUnavailableText());
    const reuse = editing && tunneled && transport?.tunnel?.status.state === 'ready';
    const nextTransport = reuse ? transport : await openTransport(args.server, tunneled,
      { binary: transportBinary, identity: editing && tunneled ? saved.networkIdentity : undefined });
    let next;
    try {
      if (editing) {
        if (config !== saved) throw new Error(localText('连接已更改，请重试。', 'Connection changed. Try again.'));
        await verifyDevice(nextTransport.server, saved);
        if (config !== saved) throw new Error(localText('连接已更改，请重试。', 'Connection changed. Try again.'));
        next = { ...saved, ...nextTransport };
      } else next = { ...await pair(nextTransport.server, mode === 'password' ? (args.password ?? args.key) : args.key, fetch, { tunneled: nextTransport.tailcat, mode }), ...nextTransport };
      await store.save(next);
    } catch (error) { if (!reuse) await nextTransport.close(); throw error; }
    disposeWorkspace(); if (!reuse) await transport?.close(); transport = nextTransport; config = next; connectionError = '';
    setTimeout(() => { if (config === next && !quitting) void showWorkspace(); }, 200);
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('rokbot-local:disconnect', async event => {
  requireConnection(event); await store.clear(); config = null; connectionError = '';
  stopConnection(); await transport?.close(); transport = null; reportConnection(); updateMenu();
  return { ok: true };
});
ipcMain.on('rokbot-local:open-management', event => { if (trusted(event, mainWindow) && config) void shell.openExternal(`${config.server}/admin`); });
ipcMain.handle('rokbot-local:update-profile', async (event, args) => {
  if (!trusted(event, mainWindow)) throw new Error('Unexpected renderer');
  if (typeof args?.id !== 'string' || !args.profile || Object.entries(args.profile).some(([key, value]) => !['title', 'description'].includes(key) || typeof value !== 'string')) throw new Error('Invalid Bot profile');
  const agents = await gateway.command('listAgents');
  const current = agents.find(agent => agent.id === args.id);
  if (!current) throw new Error(localText('Bot 不存在', 'Bot not found'));
  return gateway.command('updateAgent', { id: args.id, profile: {
    name: current.name, title: current.title ?? '', description: current.description ?? '',
    ...args.profile,
  } });
});
ipcMain.handle('sand:coordinator-port-request', event => {
  if (!trusted(event, mainWindow) || !gateway || !config) return;
  const { port1, port2 } = new MessageChannelMain();
  const dispose = gateway.attach(port1); ports.add(dispose);
  port1.on('close', () => ports.delete(dispose));
  event.sender.postMessage('sand:coordinator-port', null, [port2]);
});

app.whenReady().then(async () => {
setLocaleSource(() => clientSettings.language === 'system' ? app.getLocale() : clientSettings.language);
await mkdir(profile, { recursive: true, mode: 0o700 });
const registerIntegration = await canRegisterDesktopIntegration({ isolatedProfile });
if (registerIntegration && (!isWindows || !app.getApplicationNameForProtocol('rokbot-local://'))) app.setAsDefaultProtocolClient('rokbot-local');
// Official update and account network code is never started. Renderer traffic
// is restricted to the current Host; credentials stay in this main process.
const restrict = target => target.webRequest.onBeforeRequest((details, callback) => {
  try {
    const url = new URL(details.url);
    const isAsset = ['file:', 'data:', 'blob:', 'devtools:'].includes(url.protocol);
    const hostOrigin = ['ws:', 'wss:'].includes(url.protocol) ? url.origin.replace(/^ws/, 'http') : url.origin;
    callback({ cancel: !(isAsset || (config && hostOrigin === config.server)) });
  } catch { callback({ cancel: true }); }
});
restrict(session.defaultSession); app.on('session-created', restrict);
const { main: names, others } = desktopEdges(await readFile(path.join(payload, 'electron-preload/preload.cjs'), 'utf8'));
// The desktop mount panels and Spotlight are official windows this client never opens.
for (const [edge, methods] of others) {
  const failure = { code: 'edge/unknown-method', detail: `The local client does not provide ${edge}` };
  for (const method of methods) ipcMain.handle(`dune-rpc:${edge}:m:${method}`, () => ({ ok: false, failure }));
  ipcMain.handle(`dune-rpc:${edge}:probe`, event => ({ ok: Boolean(trusted(event, mainWindow)), value: false }));
}
for (const method of names) ipcMain.handle(`dune-rpc:main:m:${method}`, async (event, args) => {
  if (!trusted(event, mainWindow)) return { ok: false, failure: { code: 'edge/untrusted', detail: 'Unexpected renderer' } };
  try {
    if (method === 'markDeepLinksReady') {
      deepLinksReady = true;
      if (pendingAgent) setTimeout(() => openAgent(pendingAgent), 0);
      return { ok: true, value: null };
    }
    return { ok: true, value: await methodCall(method, args) };
  } catch (error) { return { ok: false, failure: { code: 'edge/handler-failed', detail: error.message } }; }
});
ipcMain.handle('dune-rpc:main:probe', (event, method) => probeLocalMethod(trusted(event, mainWindow), names, methodCall, method));
updateMenu();
app.on('activate', () => {
  if (starting) return;
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else if (!connectWindow) void (transport && config ? showWorkspace() : showConnection());
});
if (isWindows) {
  try { if (registerIntegration) ensureStartMenuShortcut({ app, shell }); }
  catch (error) { console.warn('[shortcut]', error.message); }
  tray = createTray({ Tray, Menu, nativeImage, clientRoot, show: () => void showApp(), quit: () => app.quit(), text: localText });
} else if (isLinux) {
  try {
    tray = createTray({ Tray, Menu, nativeImage, clientRoot, show: () => void showApp(), quit: () => app.quit(), text: localText });
  } catch (error) { console.warn('[tray]', error.message); }
}
app.on('before-quit', () => { quitting = true; stopConnection(); void transport?.close(); });
// Activate the app for any Keychain prompt, then choose the first window from
// the saved credentials. Dock activation must not open pairing during loading.
app.focus();
({ config, transport, connectionError } = await restoreConnection(store, transportBinary));
if (transport && config) await showWorkspace();
else await showConnection();
starting = false;
// Windows starts a new process for a link when the client is not running yet.
const launchLink = initialLink(process.argv);
if (launchLink) routeLink(launchLink);
}).catch(error => { console.error('[startup]', error); app.quit(); });

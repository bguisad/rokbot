import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { canvasTarget, createCanvasWindows } from '../clients/desktop/canvas-window.mjs';

const TOKEN = 'Abc_-0123456789abcdefghijABCDEFGHIJ01234567';

test('canvas links are re-pointed at the connected Host; other links are not canvases', () => {
  assert.equal(TOKEN.length, 43);
  assert.equal(canvasTarget(`http://127.0.0.1:8000/canvas/${TOKEN}`, 'http://127.0.0.1:53111'), `http://127.0.0.1:53111/canvas/${TOKEN}`);
  assert.equal(canvasTarget(`https://bot.example/canvas/${TOKEN}/?theme=dark&x=1`, 'https://lan.example:8000/'), `https://lan.example:8000/canvas/${TOKEN}?theme=dark`);
  assert.equal(canvasTarget(`https://cursor.com/canvas/store-1/${TOKEN}`, 'http://h'), null);
  assert.equal(canvasTarget(`https://bot.example/canvas/${TOKEN}/frame`, 'http://h'), null);
  assert.equal(canvasTarget(`https://u:p@bot.example/canvas/${TOKEN}`, 'http://h'), null);
  assert.equal(canvasTarget(`file:///canvas/${TOKEN}`, 'http://h'), null);
  assert.equal(canvasTarget('https://example.com/', 'http://h'), null);
  assert.equal(canvasTarget(`https://bot.example/canvas/${TOKEN}`, undefined), null);
});

test('canvas windows are sandboxed, isolated, reused per canvas and send other links to the browser', async () => {
  const created = [], external = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; created.push(this); this.destroyed = false;
      const contents = new EventEmitter();
      contents.setWindowOpenHandler = (fn) => { contents.openHandler = fn; };
      contents.getURL = () => this.url;
      contents.session = { setPermissionRequestHandler: (fn) => { contents.permission = fn; } };
      this.webContents = contents;
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    show() { this.shown = true; } focus() {} setTitle(title) { this.title = title; }
  }
  const windows = createCanvasWindows({ BrowserWindow: FakeWindow, nativeTheme: { shouldUseDarkColors: true },
    openExternal: async (url) => external.push(url), text: (zh) => zh, getServer: () => 'http://127.0.0.1:9000' });
  assert.equal(windows.open('https://example.com/'), false);
  assert.equal(windows.open(`http://10.0.0.2:8000/canvas/${TOKEN}`), true);
  assert.equal(created.length, 1);
  const [win] = created;
  assert.equal(win.url, `http://127.0.0.1:9000/canvas/${TOKEN}`);
  const prefs = win.options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.preload, undefined, 'canvas windows get no preload bridge');
  assert.equal(prefs.partition, 'rokbot-canvas', 'canvas windows never share the workspace session');
  assert.equal(win.options.title, 'RokBot 画布');
  assert.ok(!/grok/i.test(win.options.title));

  assert.equal(windows.open(`http://127.0.0.1:9000/canvas/${TOKEN}`), true);
  assert.equal(created.length, 1, 'the same canvas reuses its window');
  assert.equal(win.shown, true);

  assert.deepEqual(win.webContents.openHandler({ url: 'https://example.com/doc' }), { action: 'deny' });
  let prevented = 0;
  win.webContents.emit('will-navigate', { preventDefault: () => prevented++ }, `http://127.0.0.1:9000/canvas/${TOKEN}?theme=light`);
  assert.equal(prevented, 0, 'reloading the canvas stays in the window');
  win.webContents.emit('will-navigate', { preventDefault: () => prevented++ }, 'https://example.com/away');
  assert.equal(prevented, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(external, ['https://example.com/doc', 'https://example.com/away']);
  let granted;
  win.webContents.permission(null, 'media', (value) => { granted = value; });
  assert.equal(granted, false);

  windows.closeAll();
  assert.equal(win.destroyed, true);
  windows.open(`http://127.0.0.1:9000/canvas/${TOKEN}`);
  assert.equal(created.length, 2);
});

// Desktop canvases (mac/clients/desktop/canvas-bridge.mjs, shared by macOS, Windows and Linux):
// in-app links are recognised on any Host address, frames come over sand-canvas:// with this
// device's credential and keep the Host's sandbox CSP, and the API calls go to /local/canvases.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canvasAppId, canvasFrameUrl, createCanvasBridge, embeddableCsp, parseCanvasFrameUrl } from '../clients/desktop/canvas-bridge.mjs';

const ID = '044e3b41-0828-4466-9f6d-325569f828c6';
const TOKEN = 'Abc_-0123456789abcdefghijABCDEFGHIJ01234567';

test('in-app canvas links are recognised on any Host address; public and foreign links are not', () => {
  assert.equal(canvasAppId(`http://127.0.0.1:8000/canvas/app/${ID}`), ID);
  assert.equal(canvasAppId(`https://bot.example/canvas/app/${ID.toUpperCase()}/`), ID);
  assert.equal(canvasAppId(`https://bot.example/canvas/${TOKEN}`), null, 'a public link stays a web link');
  assert.equal(canvasAppId(`https://bot.example/canvas/app/${ID}/frame`), null);
  assert.equal(canvasAppId(`https://u:p@bot.example/canvas/app/${ID}`), null);
  assert.equal(canvasAppId(`file:///canvas/app/${ID}`), null);
  assert.equal(canvasAppId(`https://cursor.com/canvas/store-x/${ID}`), null);
  assert.equal(canvasAppId('not a url'), null);
  assert.equal(canvasFrameUrl(ID, 'dark'), `sand-canvas://rokbot/${ID}?theme=dark`);
  assert.throws(() => canvasFrameUrl('../x', 'light'));
  assert.deepEqual(parseCanvasFrameUrl(`sand-canvas://rokbot/${ID}?theme=dark`), { id: ID, theme: 'dark' });
  assert.equal(parseCanvasFrameUrl(`sand-canvas://other/${ID}`), null);
  assert.equal(parseCanvasFrameUrl(`sand-canvas://rokbot/${ID}/x`), null);
  assert.equal(embeddableCsp("sandbox allow-scripts; default-src 'none'; frame-ancestors 'self'"), "sandbox allow-scripts; default-src 'none'");
});

test('frames are fetched with the device credential, keep the sandbox CSP and refuse an unsandboxed page', async () => {
  const calls = [];
  const csp = "sandbox allow-scripts allow-modals allow-downloads; default-src 'none'; connect-src 'none'; frame-ancestors 'self'";
  let reply = () => new Response('<html>canvas</html>', { status: 200, headers: { 'content-security-policy': csp, 'x-frame-options': 'SAMEORIGIN' } });
  const bridge = createCanvasBridge({ getConfig: () => ({ server: 'http://h:8000', token: 'dev-token' }), request: async () => null,
    openExternal: async () => {}, fetchImpl: async (url, init) => { calls.push([url, init.headers.Authorization]); return reply(); } });
  const ok = await bridge.frame(`sand-canvas://rokbot/${ID}?theme=dark`);
  assert.equal(ok.status, 200);
  assert.deepEqual(calls[0], [`http://h:8000/canvas/app/${ID}/frame?theme=dark`, 'Bearer dev-token']);
  assert.equal(ok.headers.get('content-security-policy'), "sandbox allow-scripts allow-modals allow-downloads; default-src 'none'; connect-src 'none'");
  assert.equal(ok.headers.get('x-frame-options'), null);
  assert.equal(await ok.text(), '<html>canvas</html>');
  reply = () => new Response('<html>x</html>', { status: 200, headers: { 'content-security-policy': "default-src 'none'" } });
  assert.equal((await bridge.frame(`sand-canvas://rokbot/${ID}`)).status, 404, 'no sandbox, no frame');
  reply = () => new Response('nope', { status: 404 });
  assert.equal((await bridge.frame(`sand-canvas://rokbot/${ID}`)).status, 404);
  assert.equal((await bridge.frame('sand-canvas://rokbot/../../etc')).status, 404);
  const offline = createCanvasBridge({ getConfig: () => null, request: async () => null, openExternal: async () => {} });
  assert.equal((await offline.frame(`sand-canvas://rokbot/${ID}`)).status, 404);
});

test('canvas actions call /local/canvases and only a public link leaves for the browser', async () => {
  const requests = [], opened = [];
  const bridge = createCanvasBridge({ getConfig: () => null, openExternal: async (url) => opened.push(url),
    request: async (path, body, signal, method) => { requests.push([method, path, body]); return { ok: true }; } });
  await bridge.handle({ action: 'list', agentId: 'a0a0-0001' });
  await bridge.handle({ action: 'get', id: ID });
  await bridge.handle({ action: 'visibility', id: ID, visibility: 'public' });
  await bridge.handle({ action: 'link', id: ID });
  await bridge.handle({ action: 'delete', id: ID });
  assert.deepEqual(requests, [
    ['GET', '/local/canvases?agentId=a0a0-0001', null],
    ['GET', `/local/canvases/${ID}`, null],
    ['POST', `/local/canvases/${ID}/visibility`, { visibility: 'public' }],
    ['POST', `/local/canvases/${ID}/link`, {}],
    ['DELETE', `/local/canvases/${ID}`, null],
  ]);
  await assert.rejects(bridge.handle({ action: 'visibility', id: ID, visibility: 'team' }), /可见性无效/);
  await assert.rejects(bridge.handle({ action: 'get', id: '../tokens' }), /画布不存在/);
  await assert.rejects(bridge.handle({ action: 'list', agentId: '../x' }), /Bot ID/);
  await bridge.handle({ action: 'open-external', url: `https://bot.example/canvas/${TOKEN}` });
  assert.deepEqual(opened, [`https://bot.example/canvas/${TOKEN}`]);
  await assert.rejects(bridge.handle({ action: 'open-external', url: 'https://evil.example/' }), /链接地址无效/);
  await assert.rejects(bridge.handle({ action: 'nope' }));
});

test('main process registers sand-canvas, admits it past the Host-only filter and routes in-app links to the renderer', async () => {
  const main = await readFile(new URL('../clients/desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /protocol\.registerSchemesAsPrivileged\(\[\{ scheme: CANVAS_SCHEME, privileges: \{ standard: true, secure: true \} \}\]\);\napp\.whenReady\(\)/);
  assert.match(main, /protocol\.handle\(CANVAS_SCHEME, request => canvasBridge\.frame\(request\.url\)\)/);
  assert.match(main, /'devtools:', `\$\{CANVAS_SCHEME\}:`\]\.includes\(url\.protocol\)/);
  assert.match(main, /ipcMain\.handle\('rokbot-local:canvas', \(event, payload\) => \{\n  if \(!trusted\(event, mainWindow\)\) throw/);
  assert.match(main, /const canvasId = canvasAppId\(value\);[\s\S]{0,200}webContents\.send\('rokbot-local:open-canvas', canvasId\)/);
  const preload = await readFile(new URL('../clients/desktop/preload.cjs', import.meta.url), 'utf8');
  for (const name of ['canvasList', 'canvasGet', 'canvasSetVisibility', 'canvasRegenerateLink', 'canvasDelete', 'canvasOpenExternal', 'canvasFrameUrl', 'onOpenCanvas'])
    assert.ok(preload.includes(`  ${name}: `), name);
  assert.ok(!/canvas-window/.test(main));
});

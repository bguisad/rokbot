import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { localCanvasAppId, localCanvasUrl } from '../client/native.js';

const TOKEN = 'x'.repeat(43);
const ID = '044e3b41-0828-4466-9f6d-325569f828c6';

test('web client opens public canvas links on its own listener', () => {
  assert.equal(localCanvasUrl(`http://127.0.0.1:8000/canvas/${TOKEN}`, 'https://web.example:8001'), `https://web.example:8001/canvas/${TOKEN}`);
  assert.equal(localCanvasUrl(`https://bot.example/canvas/${TOKEN}/`, 'http://127.0.0.1:8001'), `http://127.0.0.1:8001/canvas/${TOKEN}`);
  assert.equal(localCanvasUrl(`https://bot.example/canvas/${TOKEN}/frame`, 'http://w'), null);
  assert.equal(localCanvasUrl(`https://cursor.com/canvas/store-a/${TOKEN}`, 'http://w'), null);
  assert.equal(localCanvasUrl(`https://a:b@bot.example/canvas/${TOKEN}`, 'http://w'), null);
  assert.equal(localCanvasUrl('mailto:a@b.c', 'http://w'), null);
  assert.equal(localCanvasUrl('not a url', 'http://w'), null);
});

test('web client recognises in-app canvas links and hands them to the canvas view', async () => {
  assert.equal(localCanvasAppId(`http://127.0.0.1:8000/canvas/app/${ID}`), ID);
  assert.equal(localCanvasAppId(`https://bot.example/canvas/app/${ID.toUpperCase()}/`), ID);
  assert.equal(localCanvasAppId(`https://bot.example/canvas/${TOKEN}`), null);
  assert.equal(localCanvasAppId(`https://u:p@bot.example/canvas/app/${ID}`), null);
  assert.equal(localCanvasAppId(`https://bot.example/canvas/app/${ID}/frame`), null);
  const native = await readFile(new URL('../client/native.js', import.meta.url), 'utf8');
  assert.match(native, /new CustomEvent\('rokbot-local:open-canvas', \{ detail: \{ id: canvasId \}, cancelable: true \}\)/);
  assert.match(native, /if \(!window\.dispatchEvent\(opening\)\) return \{ ok: true \};/);
  const bridge = await readFile(new URL('../client/bridge.js', import.meta.url), 'utf8');
  for (const [name, path] of [['canvasList', '/local/canvases?agentId='], ['canvasGet', '/local/canvases/${canvasId(id)}`'],
    ['canvasSetVisibility', '/visibility`'], ['canvasRegenerateLink', '/link`'], ['canvasFrameUrl', '/canvas/app/${canvasId(id)}/frame?theme=']]) {
    const line = bridge.split('\n').find(l => l.trim().startsWith(`${name}:`));
    assert.ok(line && line.includes(path), `${name} -> ${path}`);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { localCanvasUrl } from '../client/native.js';

const TOKEN = 'x'.repeat(43);

test('web client opens local canvas links on its own listener', () => {
  assert.equal(localCanvasUrl(`http://127.0.0.1:8000/canvas/${TOKEN}`, 'https://web.example:8001'), `https://web.example:8001/canvas/${TOKEN}`);
  assert.equal(localCanvasUrl(`https://bot.example/canvas/${TOKEN}/`, 'http://127.0.0.1:8001'), `http://127.0.0.1:8001/canvas/${TOKEN}`);
  assert.equal(localCanvasUrl(`https://bot.example/canvas/${TOKEN}/frame`, 'http://w'), null);
  assert.equal(localCanvasUrl(`https://cursor.com/canvas/store-a/${TOKEN}`, 'http://w'), null);
  assert.equal(localCanvasUrl(`https://a:b@bot.example/canvas/${TOKEN}`, 'http://w'), null);
  assert.equal(localCanvasUrl('mailto:a@b.c', 'http://w'), null);
  assert.equal(localCanvasUrl('not a url', 'http://w'), null);
});

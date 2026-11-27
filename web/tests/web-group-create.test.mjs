// Web client integration checks for shared group-chat creation (mac/clients/desktop/group-create.cjs).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { bundleFiles, readWebIcons, webIndexHtml } from '../patchers/patch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

test('web bridge imports desktop/group-create.js and installs RokBotGroupCreate', async () => {
  const bridge = await readFile(path.join(REPO, 'web/client/bridge.js'), 'utf8');
  assert.ok(bridge.includes("import './desktop/group-create.js';"), 'bridge.js imports desktop/group-create.js');
  assert.match(bridge, /RokBotGroupCreate\?\.installGroupCreate\?\.\(/, 'bridge.js guards and calls installGroupCreate');
  assert.ok(bridge.includes("gateway.command('listAgents', {})"), 'bridge.js wires listAgents');
  assert.ok(bridge.includes("gateway.command('createGroup', body)"), 'bridge.js wires createGroup');
  assert.match(bridge, /installGroupCreate\?\.\([\s\S]*?openAgent/, 'bridge.js wires openAgent');
});

test('web patcher ships group-create.cjs as client/desktop/group-create.js in bundleFiles', async t => {
  const patchSrc = await readFile(path.join(REPO, 'web/patchers/patch.mjs'), 'utf8');
  assert.match(patchSrc, /sharedAssets = \[[^\]]*'group-create\.cjs'/, 'sharedAssets includes group-create.cjs');

  const dist = await mkdtemp(path.join(tmpdir(), 'rokbot-web-group-create-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(path.join(dist, 'renderer/assets'), { recursive: true });
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\' ws: sand-media:; frame-src sand-html-preview: sand-canvas: sand-mcp-app:;" />';
  await writeFile(path.join(dist, 'renderer/index.html'), webIndexHtml(
    `<!doctype html><html><head>${csp}</head><body><div id="root"></div><script type="module" crossorigin src="./assets/index-Demo.js"></script></body></html>`,
  ));
  await writeFile(path.join(dist, 'renderer/assets/index-Demo.js'), 'export {};\n');

  const { icon, icon512 } = await readWebIcons(REPO);
  const build = { rendererVersion: '1.3.0', recommended: true, sourceAsarSha256: 'a'.repeat(64), builtAt: '2026-01-01T00:00:00.000Z' };
  const files = await bundleFiles({ dist, preload: 'module.exports = {};', vncPreload: 'module.exports = {};', icon, icon512, build });

  assert.equal(files.has('client/desktop/group-create.js'), true, 'bundle includes client/desktop/group-create.js');
  const expected = await readFile(path.join(REPO, 'mac/clients/desktop/group-create.cjs'));
  assert.deepEqual(files.get('client/desktop/group-create.js'), expected);
});

test('group-create.cjs exposes globalThis.RokBotGroupCreate in a browser script context without module.exports', async () => {
  const src = await readFile(path.join(REPO, 'mac/clients/desktop/group-create.cjs'), 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);

  assert.ok(sandbox.RokBotGroupCreate, 'globalThis.RokBotGroupCreate is defined');
  assert.equal(typeof sandbox.RokBotGroupCreate.installGroupCreate, 'function');
  assert.equal(sandbox.RokBotGroupCreate.autoGroupName([{ name: 'A' }, { name: 'B' }, { name: 'C' }], true), 'A、B和C');
  assert.equal(sandbox.RokBotGroupCreate.autoGroupName([{ name: 'A' }, { name: 'B' }, { name: 'C' }], false), 'A, B, and C');
});

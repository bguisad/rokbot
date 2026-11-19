import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { BUNDLE_SCHEMA, WEB_TAGS, bundleFiles, bundleZip, readWebIcons, resolveWebIcons, webIndexHtml } from '../patchers/patch.mjs';
import { adminPassword, hostOrigin, uploadBundle } from '../patchers/upload.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const CSP = (frames, connect = "connect-src 'self' ws: sand-media: https://grok.com;") =>
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ${connect} ${frames}" />`;
const page = (frames = 'frame-src sand-html-preview: sand-canvas: sand-mcp-app: sand-visualization:;') =>
  `<!doctype html><html><head>${CSP(frames)}<title>Grok Bot</title>\n    ` +
  '<script type="module" crossorigin src="./assets/index-Demo.js"></script></head><body><div id="root"></div></body></html>';

test('the interface entry gains the web bridge, its own frames and secure realtime connections', () => {
  for (const frames of ['frame-src sand-html-preview: sand-canvas: sand-mcp-app: sand-visualization:;', 'frame-src sand-html-preview: sand-canvas: sand-mcp-app:;']) {
    const html = webIndexHtml(page(frames));
    assert.ok(html.indexOf(WEB_TAGS) < html.indexOf('<script type="module" crossorigin src="./assets/index-'), 'the bridge loads before the interface');
    assert.match(html, /frame-src sand-html-preview: sand-canvas: sand-mcp-app:[a-z: -]* 'self';/);
    assert.match(html, /connect-src 'self' ws: wss: sand-media:/);
    for (const asset of ['../client/boot-data.js', '../client/bridge.js', '../client/web-shell.js', '../client/web.css',
      '../client/icon.png', '../client/icon-512.png', '/web/manifest.webmanifest'])
      assert.ok(html.includes(asset), asset);
    assert.ok(WEB_TAGS.includes('<link rel="icon" type="image/png" sizes="256x256" href="../client/icon.png">'));
    assert.ok(WEB_TAGS.includes('<link rel="icon" type="image/png" sizes="512x512" href="../client/icon-512.png">'));
    assert.ok(WEB_TAGS.includes('<link rel="apple-touch-icon" href="../client/icon-512.png">'));
    assert.ok(WEB_TAGS.includes('<meta name="apple-mobile-web-app-title" content="RokBot">'));
    assert.ok(html.indexOf('boot-data.js') < html.indexOf('compat.js'), 'start-up data comes first');
  }
  assert.throws(() => webIndexHtml(page().replace('<script type="module" crossorigin src="./assets/index-', '<script src="./other-')), /版本不一致/);
  assert.throws(() => webIndexHtml(page().replace('frame-src', 'child-src')), /版本不一致/);
  assert.throws(() => webIndexHtml(page() + page()), /版本不一致/);
});

async function fakeDist(t) {
  const dist = await mkdtemp(path.join(tmpdir(), 'rokbot-web-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(path.join(dist, 'renderer/assets'), { recursive: true });
  await writeFile(path.join(dist, 'renderer/index.html'), webIndexHtml(page()));
  await writeFile(path.join(dist, 'renderer/assets/index-Demo.js'), 'export {};\n');
  return dist;
}

test('assets/logo RokBot icons match manifest.json and readWebIcons fails closed on missing or invalid PNGs', async t => {
  const manifest = JSON.parse(await readFile(path.join(repo, 'assets/logo/manifest.json'), 'utf8'));
  const { icon256Path, icon512Path } = resolveWebIcons(repo);
  assert.equal(path.relative(repo, icon256Path), 'assets/logo/rokbot-icon-256.png');
  assert.equal(path.relative(repo, icon512Path), 'assets/logo/rokbot-icon-512.png');

  const { icon, icon512 } = await readWebIcons(repo);
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
  assert.equal(icon512.readUInt32BE(16), 512);
  assert.equal(icon512.readUInt32BE(20), 512);

  const expected256 = manifest.png.find(entry => entry.width === 256 && entry.height === 256);
  const expected512 = manifest.png.find(entry => entry.width === 512 && entry.height === 512);
  assert.ok(expected256 && expected512);
  assert.equal(sha(icon), expected256.sha256);
  assert.equal(sha(icon512), expected512.sha256);

  const badRoot = await mkdtemp(path.join(tmpdir(), 'rokbot-web-bad-icons-'));
  t.after(() => rm(badRoot, { recursive: true, force: true }));
  await assert.rejects(() => readWebIcons(badRoot), { code: 'ENOENT' });

  await mkdir(path.join(badRoot, 'assets/logo'), { recursive: true });
  await writeFile(path.join(badRoot, 'assets/logo/rokbot-icon-256.png'), 'not-a-png');
  await writeFile(path.join(badRoot, 'assets/logo/rokbot-icon-512.png'), icon512);
  await assert.rejects(() => readWebIcons(badRoot), /Invalid RokBot PNG icon/);

  // Wrong dimensions (512x512 in 256x256 slot) must fail closed.
  await writeFile(path.join(badRoot, 'assets/logo/rokbot-icon-256.png'), icon512);
  await assert.rejects(() => readWebIcons(badRoot), /Unexpected RokBot icon dimensions/);
});

test('the bundle carries the interface, the shared bridge and the browser layer, with a manifest of every file', async t => {
  const build = { rendererVersion: '1.1.0', recommended: true, sourceAsarSha256: 'a'.repeat(64), builtAt: '2026-01-01T00:00:00.000Z' };
  const dist = await fakeDist(t);
  const { icon, icon512 } = await readWebIcons(repo);
  const files = await bundleFiles({ dist, preload: 'module.exports = {};', vncPreload: 'module.exports = {};',
    icon, icon512, build });
  for (const name of ['renderer/index.html', 'renderer/assets/index-Demo.js', 'client/bridge.js', 'client/gateway.js', 'client/vnc-bridge.js',
    'client/android.css', 'client/boot-data.js', 'client/web-shell.js', 'client/web.css', 'client/desktop/workspace.css',
    'client/desktop/workspace-keys.js', 'client/desktop/sand-machines.mjs', 'client/official-preload.js', 'client/vnc-preload.js',
    'client/icon.png', 'client/icon-512.png', 'client/build.json'])
    assert.ok(files.has(name), name);
  // The Android shell's own pages stay out; the browser's native layer replaces the shell's.
  for (const name of ['client/connect.html', 'client/connect.js', 'client/connect.css']) assert.equal(files.has(name), false, name);
  assert.deepEqual(files.get('client/native.js'), await readFile(path.join(repo, 'web/client/native.js')));
  assert.equal(sha(files.get('client/icon.png')), sha(icon));
  assert.equal(sha(files.get('client/icon-512.png')), sha(icon512));

  // Backwards-compatible when icon512 is omitted by callers.
  const minimalFiles = await bundleFiles({ dist, preload: 'module.exports = {};', vncPreload: 'module.exports = {};',
    icon: Buffer.from('demo-icon'), build });
  assert.equal(minimalFiles.has('client/icon.png'), true);
  assert.equal(minimalFiles.has('client/icon-512.png'), false);

  const { zip, manifest } = bundleZip(files, build);
  assert.equal(manifest.schema, BUNDLE_SCHEMA);
  assert.equal(BUNDLE_SCHEMA, 'rokbot-web-bundle/v1');
  assert.equal(zip.subarray(30, 30 + 'web-bundle.json'.length).toString(), 'web-bundle.json', 'the manifest is the first entry');
  assert.deepEqual(Object.keys(manifest.files), [...files.keys()].sort((a, b) => a.localeCompare(b)));
  for (const [name, bytes] of files) assert.deepEqual(manifest.files[name], { bytes: bytes.length, sha256: sha(bytes) });

  // The Host accepts exactly what the generator writes (host/ is not part of the web tool package).
  const host = path.join(repo, 'host/server/web-client.mjs');
  if (!existsSync(host)) return t.diagnostic('host/server/web-client.mjs not present; Host acceptance not checked');
  const { readBundleZip, verifyBundle, BUNDLE_SCHEMA: hostSchema } = await import('../../host/server/web-client.mjs');
  assert.equal(hostSchema, BUNDLE_SCHEMA);
  assert.equal(verifyBundle(readBundleZip(zip)).rendererVersion, '1.1.0');
});

test('uploading signs in, installs, enables and signs out without putting the password on the command line', async t => {
  assert.equal(hostOrigin('https://host.example:8443/admin?view=web-client'), 'https://host.example:8443');
  assert.throws(() => hostOrigin('ftp://host.example'), /http/);
  assert.throws(() => hostOrigin('https://user:secret@host.example'), /用户名和密码/);
  assert.throws(() => hostOrigin('host.example'), /地址无效/);

  const legacyAdminEnvKey = ['GROKBOT', 'ADMIN_PASSWORD'].join('_');
  const previousRok = process.env.ROKBOT_ADMIN_PASSWORD;
  const previousLegacy = process.env[legacyAdminEnvKey];
  try {
    process.env.ROKBOT_ADMIN_PASSWORD = 'rok-secret';
    delete process.env[legacyAdminEnvKey];
    assert.equal(await adminPassword(), 'rok-secret');
    delete process.env.ROKBOT_ADMIN_PASSWORD;
    process.env[legacyAdminEnvKey] = 'legacy-secret';
    if (!process.stdin.isTTY) {
      await assert.rejects(() => adminPassword(), /ROKBOT_ADMIN_PASSWORD/);
    }
  } finally {
    if (previousRok === undefined) delete process.env.ROKBOT_ADMIN_PASSWORD;
    else process.env.ROKBOT_ADMIN_PASSWORD = previousRok;
    if (previousLegacy === undefined) delete process.env[legacyAdminEnvKey];
    else process.env[legacyAdminEnvKey] = previousLegacy;
  }

  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push([request.method, request.url, request.headers['x-rokbot-csrf'], request.headers.cookie ?? null,
      request.url === '/admin/api/web-client' && request.method === 'PUT' ? body.length : body.toString()]);
    const reply = (status, value, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)); };
    if (request.url === '/admin/api/login')
      return JSON.parse(body).password === 'demo' ? reply(200, { ok: true }, { 'set-cookie': 'rokbot_admin=session; Path=/; HttpOnly' }) : reply(401, { error: '管理员密码不正确' });
    if (request.url === '/admin/api/web-client' && request.method === 'PUT') return reply(200, { installed: true, enabled: false });
    if (request.url === '/admin/api/web-client' && request.method === 'PATCH') return reply(200, { installed: true, enabled: true });
    reply(200, { ok: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = `http://127.0.0.1:${server.address().port}`;

  assert.deepEqual(await uploadBundle(address, Buffer.from('zip-bytes'), 'demo'), { installed: true, enabled: true });
  assert.deepEqual(calls, [
    ['POST', '/admin/api/login', '1', null, '{"password":"demo"}'],
    ['PUT', '/admin/api/web-client', '1', 'rokbot_admin=session', 9],
    ['PATCH', '/admin/api/web-client', '1', 'rokbot_admin=session', '{"enabled":true}'],
    ['POST', '/admin/api/logout', '1', 'rokbot_admin=session', '{}'],
  ]);
  await assert.rejects(uploadBundle(address, Buffer.from('zip-bytes'), 'wrong'), /管理员密码不正确/);
});

test('compat mount-failure overlay routes Connection settings via __rokbotAndroidBoot.connectPage or falls back', async () => {
  const compatSource = await readFile(path.join(repo, 'web/client/compat.js'), 'utf8');
  async function runOverlayClick(boot) {
    let scheduled = null;
    const buttons = [];
    const links = [];
    const pres = [];
    const rootNode = { firstChild: null, children: [], textContent: '' };
    const makeNode = tag => {
      const node = {
        tagName: tag.toUpperCase(),
        style: {},
        children: [],
        textContent: '',
        listeners: {},
        setAttribute() {},
        appendChild(child) { this.children.push(child); },
        addEventListener(type, fn) { this.listeners[type] = fn; },
      };
      if (tag === 'button') buttons.push(node);
      if (tag === 'a') links.push(node);
      if (tag === 'pre') pres.push(node);
      return node;
    };
    let now = 1000;
    const FakeDate = class extends Date {
      static now() { return now; }
    };
    const sandbox = {
      Date: FakeDate,
      navigator: { userAgent: 'Chrome/80.0', language: 'en-US' },
      location: { href: 'http://host.test/web/', reload() {} },
      document: {
        readyState: 'complete',
        head: { appendChild() {} },
        body: { appendChild() {} },
        getElementById(id) { return id === 'root' ? rootNode : null; },
        createElement: makeNode,
      },
      addEventListener() {},
      setTimeout(fn) { scheduled = fn; return 1; },
      clearTimeout() { scheduled = null; },
      setInterval() { return 2; },
      __rokbotAndroidBoot: boot,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(compatSource, sandbox);
    assert.ok(sandbox.__rokbotCompat);
    assert.match(sandbox.__rokbotCompat.details()[0], /^RokBot Android /);
    assert.doesNotMatch(sandbox.__rokbotCompat.details()[0], new RegExp(['prok', 'bot'].join(''), 'i'));
    assert.ok(scheduled, 'expected compat.js to schedule a mount check');
    now += 35000;
    scheduled();
    assert.equal(links[0].href, 'https://github.com/hongfaqiu/rokbot/issues');
    assert.equal(links[0].textContent, 'github.com/hongfaqiu/rokbot/issues');
    assert.match(pres[0].textContent, /^RokBot Android /);
    const settingsBtn = buttons.find(btn => btn.textContent === 'Connection settings');
    assert.ok(settingsBtn && typeof settingsBtn.listeners.click === 'function');
    settingsBtn.listeners.click();
    return sandbox.location.href;
  }
  assert.equal(await runOverlayClick({ connectPage: '/web/login', systemDark: false }), '/web/login');
  assert.equal(await runOverlayClick(undefined), '../client/connect.html');
});

test('boot-data.js and compat.js wire __rokbotAndroidBoot, x-rokbot-web, storage keys, ?agent= strip, and routing', async () => {
  const [bootSource, compatSource] = await Promise.all([
    readFile(path.join(repo, 'web/client/boot-data.js'), 'utf8'),
    readFile(path.join(repo, 'web/client/compat.js'), 'utf8'),
  ]);

  async function runBootAndCompat({ userAgent = 'Chrome/80.0', search = '?agent=bot_1&tab=chat' } = {}) {
    let scheduled = null;
    const buttons = [];
    const replaced = [];
    const fetchCalls = [];
    const classes = new Set();
    const viewportAttrs = {};
    const storage = new Map([
      ['rokbot-web:settings', JSON.stringify({ language: 'en-US' })],
      ['rokbot-web:persistence', JSON.stringify({ draft: 'hello' })],
    ]);
    const rootNode = { firstChild: null, children: [], textContent: '' };
    const makeNode = tag => {
      const node = {
        tagName: tag.toUpperCase(),
        style: {},
        children: [],
        textContent: '',
        listeners: {},
        setAttribute() {},
        appendChild(child) { this.children.push(child); },
        addEventListener(type, fn) { this.listeners[type] = fn; },
      };
      if (tag === 'button') buttons.push(node);
      return node;
    };
    let now = 1000;
    const FakeDate = class extends Date {
      static now() { return now; }
    };
    const sandbox = {
      Date: FakeDate,
      URL,
      URLSearchParams,
      Headers,
      Request,
      navigator: { userAgent, language: 'en-US', platform: 'Linux', maxTouchPoints: 0 },
      location: {
        origin: 'https://host.test',
        href: `https://host.test/web/${search}`,
        pathname: '/web/',
        search,
        hash: '#bottom',
        reload() {},
      },
      history: {
        state: { idx: 1 },
        replaceState(state, title, url) { replaced.push({ state, title, url }); },
      },
      localStorage: {
        getItem(key) { return storage.get(key) ?? null; },
      },
      matchMedia: () => ({ matches: true }),
      fetch: async (input, init) => {
        fetchCalls.push({ input, init });
        return { ok: true };
      },
      document: {
        readyState: 'complete',
        documentElement: {
          classList: {
            add: (...items) => items.forEach(item => classes.add(item)),
          },
        },
        head: { appendChild() {} },
        body: { appendChild() {} },
        querySelector: selector => selector === 'meta[name=viewport]'
          ? { setAttribute(name, value) { viewportAttrs[name] = value; } }
          : null,
        getElementById: id => (id === 'root' ? rootNode : null),
        createElement: makeNode,
      },
      addEventListener() {},
      setTimeout(fn) { scheduled = fn; return 1; },
      clearTimeout() { scheduled = null; },
      setInterval() { return 2; },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(bootSource, sandbox);
    vm.runInNewContext(compatSource, sandbox);

    await sandbox.window.fetch('/api/listAgents', { method: 'POST' });
    await sandbox.window.fetch('/local/model', { method: 'GET' });
    await sandbox.window.fetch('/events');
    await sandbox.window.fetch('/web/assets/index.js');
    await sandbox.window.fetch('https://other.example/api/listAgents');

    now += 35000;
    scheduled();
    const settingsBtn = buttons.find(btn => btn.textContent === 'Connection settings');
    assert.ok(settingsBtn);
    settingsBtn.listeners.click();
    return { sandbox, replaced, classes, viewportAttrs, fetchCalls };
  }

  const standard = await runBootAndCompat();
  assert.equal(standard.sandbox.__rokbotAndroidBoot.client, 'web');
  assert.equal(standard.sandbox.__rokbotAndroidBoot.connectPage, '/web/login');
  assert.equal(standard.sandbox.__rokbotAndroidBoot.pendingAgent, 'bot_1');
  assert.deepEqual(JSON.parse(JSON.stringify(standard.sandbox.__rokbotAndroidBoot.settings)), { language: 'en-US' });
  assert.deepEqual(JSON.parse(JSON.stringify(standard.sandbox.__rokbotAndroidBoot.persistence)), { draft: 'hello' });
  assert.equal(standard.replaced.length, 1);
  assert.equal(standard.replaced[0].url, '/web/?tab=chat#bottom');
  assert.equal(standard.classes.has('rokbot-web'), true);
  assert.equal(standard.classes.has('rokbot-apple'), false);
  assert.match(standard.viewportAttrs.content, /interactive-widget=resizes-content/);
  assert.equal(standard.fetchCalls[0].init.headers.get('x-rokbot-web'), '1');
  assert.equal(standard.fetchCalls[1].init.headers.get('x-rokbot-web'), '1');
  assert.equal(standard.fetchCalls[2].init.headers.get('x-rokbot-web'), '1');
  assert.equal(standard.fetchCalls[3].init, undefined);
  assert.equal(standard.fetchCalls[4].init, undefined);
  assert.match(standard.sandbox.__rokbotCompat.details()[0], /^RokBot Web web · WebView Chromium 80$/);
  assert.equal(standard.sandbox.location.href, '/web/login');

  const iphone = await runBootAndCompat({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    search: '',
  });
  assert.equal(iphone.classes.has('rokbot-web'), true);
  assert.equal(iphone.classes.has('rokbot-apple'), true);
  assert.match(iphone.viewportAttrs.content, /maximum-scale=1/);
});

// Builds from the pinned official installers when they are available locally; never downloads.
const sources = [process.env.ROKBOT_WEB_TEST_SOURCE ?? process.env.ROKBOT_ANDROID_TEST_SOURCE, process.env.ROKBOT_WEB_TEST_FALLBACK_SOURCE].filter(Boolean);
test('pinned installers verify as web client sources', { skip: !sources.length && 'set ROKBOT_WEB_TEST_SOURCE to a pinned local installer' }, async t => {
  for (const source of sources) {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(repo, 'web/patchers/patch.mjs'), '--source', source, '--verify-only'],
      { cwd: repo, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const result = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(result.verified, true);
    assert.match(result.rendererVersion, /^\d+\.\d+\.\d+$/);
  }

  // Also execute a full non---verify-only bundle build into a temp output dir and validate ZIP + icons.
  const outDir = await mkdtemp(path.join(tmpdir(), 'rokbot-web-build-test-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(repo, 'web/patchers/patch.mjs'), '--source', sources[0], '--output', outDir],
    { cwd: repo, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const built = JSON.parse(stdout.trim());
  assert.equal(path.basename(built.output), `RokBotLocal-web-${built.rendererVersion}.zip`);
  assert.ok(existsSync(built.output));

  const host = path.join(repo, 'host/server/web-client.mjs');
  const { readBundleZip, verifyBundle } = await import('../../host/server/web-client.mjs');
  assert.ok(existsSync(host));
  const entries = readBundleZip(await readFile(built.output));
  const manifest = verifyBundle(entries);
  assert.equal(manifest.schema, 'rokbot-web-bundle/v1');
  const { icon, icon512 } = await readWebIcons(repo);
  assert.equal(sha(entries.get('client/icon.png')), sha(icon));
  assert.equal(sha(entries.get('client/icon-512.png')), sha(icon512));
});

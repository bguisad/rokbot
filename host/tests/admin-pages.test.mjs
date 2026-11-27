// The admin console's page structure (host/server/public/admin-routes.js): registry, router,
// legacy ?view= / #anchor redirects, that every former section is still reachable, and (when a
// Chromium and playwright-core are available) that every page renders in a real browser against a
// demo Host with history, reload and narrow-screen navigation.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { allViews, legacyAnchors, legacyViews, lookup, modules, pages, resolve, routeHash, viewsOf } from '../server/public/admin-routes.js';

const read = rel => readFile(new URL(`../server/public/${rel}`, import.meta.url), 'utf8');
const emoji = /\p{Extended_Pictographic}/u;

// Every view of the former single-level console (navigation.js before the page split).
const formerViews = ['overview', 'general', 'model', 'speech', 'media', 'web-services', 'harness', 'skills', 'apps', 'prompts',
  'devices', 'web-client', 'updates', 'network', 'execution', 'federation', 'webhooks', 'sharing', 'migrate', 'profile', 'notifications', 'plugins', 'connectors'];

// Former section -> [module, an element id inside it]. Each must be shown by at least one tab.
const formerSections = {
  'Overview hero, Bot crew and today usage': ['overview', 'hero-title'],
  'Overview to-do list': ['overview', 'attention'],
  'Usage dashboard': ['usage', 'usage-view'],
  'Account profile': ['general', 'profile-form'],
  'Theme': ['general', 'data-theme-picker'],
  'Log out': ['general', 'logout'],
  'Model services': ['model', 'model-providers'],
  'Model profiles and upstream sync': ['model', 'sync-model-contexts'],
  'Default route and fallback models': ['model', 'model-default-route'],
  'Scenario models': ['model', 'model-scenario-section'],
  'Bot routes': ['model', 'model-bot-routes'],
  'Adaptive routing': ['model', 'model-adaptive-section'],
  'Model save bar': ['model', 'model-error'],
  'Client model permissions': ['model', 'model-device-policy'],
  'Model routing log': ['model', 'routing-log'],
  'Speech and voice calls': ['speech', 'speech-form'],
  'Images and video': ['media', 'media-defaults'],
  'Web tools': ['web-services', 'web-routing'],
  'Built-in capabilities': ['harness', 'harness-form'],
  'Skills': ['skills', 'skills-list'],
  'Apps': ['apps', 'connector-list'],
  'Prompts': ['prompts', 'prompt-workspace'],
  'Pairing code': ['devices', 'pairing-panel'],
  'Paired devices': ['devices', 'device-list'],
  'Notification preferences': ['devices', 'notification-frequency'],
  'Test notification': ['devices', 'device-test-agent'],
  'Apple and Android push': ['devices', 'push-form'],
  'Recent notifications': ['devices', 'notification-list'],
  'Web client': ['web-client', 'web-client-open'],
  'Publish a client update': ['updates', 'updates-publish-form'],
  'Published releases': ['updates', 'updates-releases'],
  'iOS OTA': ['updates', 'updates-ios-section'],
  'Update signing key': ['updates', 'updates-key-spki'],
  'Remote access': ['network', 'network-form'],
  'Execution computer': ['execution', 'execution-form'],
  'Host collaboration': ['federation', 'federation-settings'],
  'Webhooks': ['webhooks', 'hook-list'],
  'Webhook runs': ['webhooks', 'hook-events'],
  'Sharing': ['sharing', 'sharing-list'],
  'Migration from Grok Bot': ['migrate', 'migrate-root'],
  'Host runtime details': ['system', 'system-info'],
};

// Whether a block shows the element `id`, judged from its selectors (mirrors app.js applyBlock).
const mentions = (selectors, id) => (selectors ?? []).some(selector => selector.includes(`#${id}`) || selector.includes(`[${id}]`));
const blockShows = (block, id) => block.only ? mentions(block.only, id) : !mentions(block.except, id);

test('the registry lists the pages in order, each with a title, description, icon and tabs', async () => {
  assert.deepEqual(pages.map(page => page.id), ['overview', 'models', 'usage', 'clients', 'devices', 'bots', 'account', 'system']);
  const icons = await read('icons.js');
  const seen = new Set();
  for (const page of pages) {
    assert.ok(!seen.has(page.id), `duplicate page ${page.id}`); seen.add(page.id);
    assert.match(page.label, /\S/); assert.ok(page.description.length >= 8, `${page.id} has a description`);
    assert.ok(icons.includes(`  ${page.icon}: '`), `icon ${page.icon} exists`);
    assert.ok(page.tabs.length >= 1);
    assert.equal(new Set(page.tabs.map(tab => tab.id)).size, page.tabs.length, `${page.id} tab ids are unique`);
    for (const tab of page.tabs) {
      assert.ok(tab.blocks.length >= 1, `${page.id}/${tab.id} shows something`);
      for (const block of tab.blocks) assert.ok(modules[block.view], `${page.id}/${tab.id} uses a registered module (${block.view})`);
    }
  }
});

test('every registered module file exists and exports its factory; every module is used', async () => {
  const files = new Set(readdirSync(new URL('../server/public/', import.meta.url)));
  for (const [id, [file, factory, options]] of Object.entries(modules)) {
    assert.ok(files.has(file), `${id}: ${file} exists`);
    assert.match(await read(file), new RegExp(`export function ${factory}\\(`), `${file} exports ${factory}`);
    if (options) assert.deepEqual(Object.keys(options).filter(key => key !== 'lazy'), []);
  }
  assert.deepEqual(new Set(allViews()), new Set(Object.keys(modules)), 'no registered module is unreachable');
  // The shell creates modules from the registry instead of importing them one by one.
  const app = await read('app.js');
  assert.match(app, /import \{[^}]*\bmodules\b[^}]*\} from '\.\/admin-routes\.js'/);
  assert.match(app, /import\(`\.\/\$\{file\}`\)/);
  for (const [file] of Object.values(modules)) assert.doesNotMatch(app, new RegExp(`from '\\./${file.replace('.', '\\.')}'`));
});

test('routes resolve to canonical #/page/tab hashes and unknown ones fall back to the overview', () => {
  assert.equal(resolve('#/models/routing').hash, '#/models/routing');
  assert.equal(resolve('#/models/routing').redirected, false);
  assert.equal(resolve('#/models').hash, '#/models/providers', 'a page opens its first tab');
  assert.equal(resolve('#/usage').hash, '#/usage', 'single-tab pages have a one-part hash');
  assert.equal(resolve('#/usage/report').hash, '#/usage');
  assert.equal(resolve('#/overview').hash, '#/overview');
  assert.equal(resolve('').hash, '#/overview');
  assert.equal(resolve('#/nope').hash, '#/overview');
  assert.equal(resolve('#/nope').redirected, true);
  assert.deepEqual([resolve('#/models/bogus').hash, resolve('#/models/bogus').redirected], ['#/models/providers', true]);
  for (const page of pages) for (const tab of page.tabs) {
    const hash = routeHash(page, tab), back = resolve(hash);
    assert.equal(back.page, page); assert.equal(back.tab, tab); assert.equal(back.redirected, false, hash);
    assert.deepEqual(lookup(hash.slice(2)), { page, tab });
  }
});

test('former ?view= links, view hashes and in-page anchors redirect to the page that holds them now', () => {
  for (const view of formerViews) {
    const target = legacyViews[view];
    assert.ok(target, `${view} has a new home`);
    assert.ok(lookup(target), `${view} -> ${target} exists`);
    const fromQuery = resolve('', `?view=${view}`);
    assert.equal(fromQuery.hash, routeHash(lookup(target).page, lookup(target).tab), `?view=${view}`);
    assert.equal(fromQuery.redirected, true);
    assert.equal(resolve(`#${view}`).hash, fromQuery.hash, `#${view}`);
    assert.equal(resolve(`#/${view}`).hash, fromQuery.hash, `#/${view}`);
  }
  // The connector OAuth callback (index.mjs) and share links (sharing.mjs) still use ?view=.
  assert.equal(resolve('', '?view=connectors&authorization=success').hash, '#/bots/apps');
  assert.equal(resolve('', '?view=sharing').hash, '#/bots/sharing');
  assert.equal(resolve('#usage').hash, '#/usage');
  assert.deepEqual([resolve('#model-scenario-section').hash, resolve('#model-scenario-section').scrollTo], ['#/models/routing', 'model-scenario-section']);
  assert.equal(resolve('#routing-log').hash, '#/system/logs');
  assert.equal(resolve('#model-device-policy').hash, '#/account');
  assert.equal(resolve('#push-form').hash, '#/devices/notify');
  assert.equal(resolve('#/devices/notify', '?view=model').hash, '#/devices/notify', 'a new hash wins over an old ?view=');
  for (const [anchor, [path, scrollTo]] of Object.entries(legacyAnchors)) {
    assert.ok(lookup(path), `#${anchor} -> ${path}`);
    if (scrollTo) assert.match(scrollTo, /^[a-z][\w-]*$/);
  }
});

test('every former section is shown by at least one tab, and each tab only loads its own modules', async () => {
  for (const [name, [view, id]] of Object.entries(formerSections)) {
    const source = await read(modules[view][0]);
    assert.ok(source.includes(`id="${id}"`) || source.includes(id), `${name}: #${id} still exists in ${modules[view][0]}`);
    const homes = pages.flatMap(page => page.tabs.filter(tab => tab.blocks.some(block => block.view === view && blockShows(block, id)))
      .map(tab => `${page.id}/${tab.id}`));
    assert.ok(homes.length >= 1, `${name} (#${id}) is on some page`);
  }
  // Model tabs split one form: both keep its save bar.
  for (const path of ['models/providers', 'models/routing']) {
    const { tab } = lookup(path);
    assert.ok(tab.blocks[0].only.includes('#model-form > .actions'), `${path} keeps the save button`);
  }
  for (const page of pages) for (const tab of page.tabs) assert.ok(viewsOf(tab).length <= 3, `${page.id}/${tab.id} loads at most 3 modules`);
  const overview = await read('overview.js');
  assert.doesNotMatch(overview, /usage\/report|mountUsageDashboard/, 'the overview no longer loads the full usage report');
  assert.match(await read('usage.js'), /mountUsageDashboard/);
});

test('the shell has one page container, hash routing and a collapsible menu', async () => {
  const index = await read('index.html'), app = await read('app.js'), nav = await read('navigation.js'), shell = await read('shell.css');
  for (const id of ['page', 'page-head', 'page-body', 'nav', 'nav-toggle', 'sidebar']) assert.match(index, new RegExp(`id="${id}"`));
  assert.doesNotMatch(index, /data-panel=/, 'module panels are created from the registry');
  assert.match(index, /href="#\/account"/);
  assert.match(app, /addEventListener\('hashchange'/);
  assert.match(app, /history\.replaceState\(/);
  assert.match(app, /params\.delete\('view'\)/, 'an old ?view= is removed from the address bar');
  assert.match(app, /data-route-hidden/);
  assert.match(nav, /aria-current/);
  assert.match(shell, /\[data-route-hidden\] \{ display: none !important; \}/);
  assert.match(shell, /@media \(max-width: 820px\)[\s\S]*\.sidebar\.open/);
  assert.match(shell, /\.route-tabs \{[^}]*overflow-x: auto/);
});

test('pages use the Sand drop-down instead of native selects', async () => {
  const i18n = await read('i18n.js');
  assert.match(i18n, /sandSelects = source => String\(source\)\.replace\(\/<\(\\\/\?\)select\\b\/gi, '<\$1sand-select'\)/);
  assert.match(i18n, /template\.innerHTML = sandSelects\(source\)/);
  const ui = await read('ui.js');
  assert.match(ui, /defineSandSelect\(\);\n/, 'sand-select is defined when ui.js loads');
  assert.match(ui, /setValidity\(\{ valueMissing: true \}/, 'required drop-downs block form submission like a select');
  for (const file of readdirSync(new URL('../server/public/', import.meta.url)).filter(name => name.endsWith('.js'))) {
    const source = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(source, /createElement\(\s*['"]select['"]\s*\)/, `${file} creates no native select`);
    if (/<select\b/.test(source) && file !== 'i18n.js') assert.match(source, /\bhtml\(/, `${file} renders select markup through html()`);
  }
});

test('page labels have English text and the new files stay free of emoji and the upstream name', async () => {
  const english = (await import('../server/public/locales-en.js')).default;
  for (const page of pages) {
    for (const text of [page.label, page.description, ...page.tabs.map(tab => tab.label)])
      assert.ok(text in english || /^[\x20-\x7e]+$/.test(text), `English for ${text}`);
  }
  for (const file of ['admin-routes.js', 'navigation.js', 'app.js', 'overview.js', 'usage.js', 'system.js', 'shell.css', 'stage.css', 'index.html']) {
    const source = await read(file);
    assert.doesNotMatch(source, emoji, `${file} has no emoji`);
    // The only allowed mention is the migration source, spelled exactly "Grok Bot".
    assert.doesNotMatch(source.replaceAll('Grok Bot', ''), /grok/i, `${file} has no upstream product name`);
  }
});

// ---- Real browser (optional): needs playwright-core and a Chromium build. ----
function findBrowser() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.ROKBOT_PLAYWRIGHT_CORE, 'playwright-core'].filter(Boolean);
  let module = null;
  for (const candidate of candidates) { try { module = require.resolve(candidate); break; } catch {} }
  if (!module) return null;
  let executable = process.env.ROKBOT_CHROMIUM;
  if (!executable) {
    const cache = join(homedir(), 'Library/Caches/ms-playwright');
    const shells = existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse() : [];
    for (const name of shells) for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
      const path = join(cache, name, arch, 'chrome-headless-shell');
      if (!executable && existsSync(path)) executable = path;
    }
    if (!executable && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return executable ? { module, executable } : null;
}
const browserSetup = findBrowser();

test('every page renders in a browser; tabs, history, reload, redirects and the narrow menu work', {
  skip: browserSetup ? false : 'set ROKBOT_PLAYWRIGHT_CORE (path to playwright-core) and ROKBOT_CHROMIUM to run',
  timeout: 180_000,
}, async t => {
  const playwright = await import(pathToFileURL(browserSetup.module).href);
  const chromium = playwright.chromium ?? playwright.default.chromium;
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-admin-pages-'));
  const core = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('null'); });
  await new Promise(done => core.listen(0, '127.0.0.1', done));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl, internalToken: 'd'.repeat(40) });
  await host.start(0, '127.0.0.1', 0);
  const browser = await chromium.launch({ executablePath: browserSetup.executable });
  t.after(async () => { await browser.close(); await host.close(); await new Promise(done => core.close(done)); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const setupKey = (await readFile(join(dir, 'setup-key'), 'utf8')).trim();

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${origin}/admin?view=model`);
  await page.fill('#setup-key', setupKey);
  await page.fill('#auth-password', 'demo-only-password-1234');
  await page.click('#auth-submit');
  await page.waitForSelector('#console:not([hidden])');
  await page.waitForFunction(() => location.hash === '#/models/providers');
  assert.equal(new URL(page.url()).search, '', '?view= is replaced by the new hash');

  const visible = selector => page.evaluate(selector => {
    const element = document.querySelector(selector);
    return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  }, selector);
  for (const entry of pages) for (const tab of entry.tabs) {
    const hash = routeHash(entry, tab);
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await page.waitForFunction(hash => location.hash === hash && document.querySelector('#page')?.dataset.route, hash);
    await page.waitForLoadState('networkidle');
    assert.equal(await page.textContent('#route-title'), entry.label, `${hash} title`);
    assert.ok((await page.textContent('.route-description')).length > 8, `${hash} description`);
    assert.equal(await page.getAttribute(`#nav .nav-item[data-route="${entry.id}"]`, 'aria-current'), 'page', `${hash} sidebar`);
    if (entry.tabs.length > 1) assert.equal(await page.textContent('.route-tab[aria-current=page]'), tab.label, `${hash} tab`);
    const shown = await page.$$eval('#page-body > [data-panel]:not([hidden])', panels => panels.map(panel => panel.dataset.panel));
    assert.deepEqual(new Set(shown), new Set(viewsOf(tab)), `${hash} shows only its modules`);
    for (const [, [view, id]] of Object.entries(formerSections).filter(([, [view]]) => viewsOf(tab).includes(view))) {
      const block = tab.blocks.find(item => item.view === view);
      const selector = id === 'data-theme-picker' ? '[data-theme-picker]' : `#${id}`;
      if (!blockShows(block, id)) assert.equal(await visible(selector), false, `${hash} hides #${id}`);
    }
    assert.equal(await page.$$eval('#page select', items => items.length), 0, `${hash} has no native select`);
  }
  // Sections from the former pages show where the registry says.
  await page.evaluate(() => { location.hash = '#/models/routing'; });
  await page.waitForFunction(() => location.hash === '#/models/routing');
  assert.equal(await visible('#model-default-route'), true);
  assert.equal(await visible('#model-providers'), false);
  assert.equal(await visible('#model-form > .actions button[type=submit]'), true);

  // Back and forward walk the visited tabs; a reload stays on the current one.
  await page.goBack(); await page.waitForFunction(() => location.hash === '#/system/logs');
  assert.equal(await page.textContent('.route-tab[aria-current=page]'), '日志');
  await page.goForward(); await page.waitForFunction(() => location.hash === '#/models/routing');
  await page.reload(); await page.waitForSelector('#console:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#page')?.dataset.route === 'models/routing');
  assert.equal(await page.textContent('.route-tab[aria-current=page]'), '路由与备用');

  // Clicking a tab and a sidebar entry uses real links.
  await page.click('.route-tab[data-tab=speech]');
  await page.waitForFunction(() => location.hash === '#/models/speech');
  await page.click('#nav .nav-item[data-route=usage]');
  await page.waitForFunction(() => location.hash === '#/usage');
  // An old anchor and an old in-page button land on the new page.
  await page.goto(`${origin}/admin#model-scenario-section`);
  await page.waitForFunction(() => location.hash === '#/models/routing');
  await page.goto(`${origin}/admin#/overview`);
  await page.waitForSelector('#attention:not([hidden]) [data-view=devices]');
  await page.click('#attention [data-view=devices]');
  await page.waitForFunction(() => location.hash === '#/devices/list');
  assert.deepEqual(errors, []);

  // 390 px: the sidebar folds into a menu button; choosing a page closes it.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US',
    storageState: await context.storageState() });
  const mobile = await phone.newPage();
  mobile.on('pageerror', error => errors.push(String(error)));
  await mobile.goto(`${origin}/admin#/devices/notify`);
  await mobile.waitForSelector('#console:not([hidden])');
  await mobile.waitForFunction(() => document.querySelector('#page')?.dataset.route === 'devices/notify');
  assert.equal(await mobile.textContent('#route-title'), 'Devices & connections');
  assert.equal(await mobile.isVisible('#nav'), false);
  await mobile.click('#nav-toggle');
  assert.equal(await mobile.isVisible('#nav'), true);
  await mobile.click('#nav .nav-item[data-route=system]');
  await mobile.waitForFunction(() => document.querySelector('#page')?.dataset.route === 'system/settings');
  assert.equal(await mobile.isVisible('#nav'), false);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `no sideways scrolling at 390 px (${overflow}px)`);
  await phone.close(); await context.close();
  assert.deepEqual(errors, []);
});

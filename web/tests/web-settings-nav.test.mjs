// Desktop settings navigation: the official dialog's flat section list regrouped by function
// (mac/clients/desktop/settings-nav.cjs), the scroll container of the 输入建议 page
// (mac/clients/desktop/workspace.css), and the Bot details page opened from the conversation header
// (mac/clients/desktop/bot-profile.cjs). The grouping follows the Android settings menu
// (android/patchers/hermes-settings.mjs) and the Bot screen android/companion renders.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DESKTOP = path.join(REPO, 'mac/clients/desktop');

const settingsNav = require(path.join(DESKTOP, 'settings-nav.cjs'));
const botProfile = require(path.join(DESKTOP, 'bot-profile.cjs'));
const read = name => readFileSync(path.join(DESKTOP, name), 'utf8');

// A small DOM stub: only what the pages touch (querySelector with simple/child selectors, classes,
// attributes, events). Enough for deterministic unit tests of the DOM paths without a browser.
class StubElement {
  constructor(tagName, document, className = '') {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.className = className;
    this.hidden = false;
    this.dataset = {};
    this.scrollTop = 0;
    if (tagName !== '#text') this.isConnected = true;
    let html = '';
    let literal = null;
    this.initial = '';
    Object.defineProperty(this, 'textContent', {
      get: () => {
        if (this.children.length) return this.children.map(child => child.textContent).join('');
        return this.initial;
      },
      set: value => {
        const text = value == null ? '' : String(value);
        this.initial = text;
        this.children = [];
        html = '';
        literal = null;
      },
    });
    Object.defineProperty(this, 'innerHTML', {
      get: () => (literal ? literal.outerHTML : html),
      set: value => {
        html = String(value);
        this.children = [];
        if (/<[a-z]/i.test(html)) {
          literal = parseMarkup(html, document);
          this.children = literal.children;
          for (const child of this.children) child.parentElement = this;
          this.markup = literal.markup;
        } else {
          literal = null;
        }
      },
    });
  }
  get classList() {
    const self = this;
    const list = () => String(self.className || '').split(/\s+/).filter(Boolean);
    return {
      contains: name => list().includes(name),
      add: (...names) => { self.className = [...new Set([...list(), ...names])].join(' '); },
      remove: (...names) => { self.className = list().filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const has = list().includes(name);
        const next = force === undefined ? !has : Boolean(force);
        if (next && !has) self.className = [...list(), name].join(' ');
        if (!next && has) self.className = list().filter(item => item !== name).join(' ');
        return next;
      },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  prepend(node) { node.parentElement = this; this.children.unshift(node); }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }
  cloneNode(deep = false) {
    const copy = new StubElement(this.tagName.toLowerCase(), this.ownerDocument, this.className);
    copy.initial = this.initial;
    copy.markup = this.markup;
    for (const [k, v] of this.attributes) copy.setAttribute(k, v);
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  insertBefore(node, next) {
    const index = this.children.indexOf(next);
    node.parentElement = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    return node;
  }
  after(node) { const parent = this.parentElement; if (parent) parent.insertBefore(node, this.nextElementSibling); }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const idx = siblings.indexOf(this);
    if (idx >= 0) siblings.splice(idx, 1);
    this.parentElement = null;
    this.isConnected = false;
  }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  get firstChild() { return this.children[0] || null; }
  get childNodes() { return this.children; }
  get outerHTML() {
    if (this.markup !== undefined) return this.markup;
    if (this.tagName === '#TEXT') return this.textContent;
    const attrs = [...this.attributes].map(([name, value]) => ` ${name}="${value}"`).join('');
    const cls = this.className ? ` class="${this.className}"` : '';
    const children = this.children.length ? this.children.map(child => child.outerHTML).join('') : this.initial;
    return `<${this.tagName.toLowerCase()}${cls}${attrs}>${children}</${this.tagName.toLowerCase()}>`;
  }
  set outerHTML(value) { this.markup = String(value); }
  get firstElementChild() { return this.children[0] || null; }
  get nextSibling() { return this.nextElementSibling; }
  addEventListener(type, fn) { (this.listeners.get(type) || this.listeners.set(type, []).get(type)).push(fn); }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter(item => item !== fn));
  }
  dispatch(type, event = {}) {
    const payload = { type, target: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const fn of this.listeners.get(type) || []) fn(payload);
    return payload;
  }
  click() {
    this.clicked = (this.clicked || 0) + 1;
    this.dispatch('click');
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.matches?.(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  matches(selector) {
    const matchCompound = (el, sel) => {
      const cleaned = sel.replace(/:first-child/g, '');
      if (!cleaned) return true;
      return cleaned.split(/(?=[.#\[])/).filter(Boolean).every(part => {
        if (part.startsWith('.')) return el.classList.contains(part.slice(1));
        if (part === '*') return true;
        if (part.startsWith('[')) {
          const m = /^\[([^=\]^$*]+)(?:([*^$]?)=["']?([^"'\]]*)["']?)?\]$/.exec(part);
          if (!m) return false;
          const [, attr, op, val] = m;
          if (!el.hasAttribute(attr)) return false;
          if (val === undefined) return true;
          const actual = el.getAttribute(attr);
          if (op === '*') return actual.includes(val);
          if (op === '^') return actual.startsWith(val);
          if (op === '$') return actual.endsWith(val);
          return actual === val;
        }
        return /^[a-z][a-z0-9-]*$/i.test(part) ? el.tagName === part.toUpperCase() : false;
      });
    };
    return String(selector).trim().split(',').some(branch => {
      const tokens = branch.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
      if (!tokens.length) return false;
      let idx = tokens.length - 1;
      if (!matchCompound(this, tokens[idx])) return false;
      idx -= 1;
      let node = this.parentElement;
      while (idx >= 0) {
        if (tokens[idx] === '>') {
          idx -= 1;
          if (!node || !matchCompound(node, tokens[idx])) return false;
          node = node.parentElement;
          idx -= 1;
        } else {
          while (node && !matchCompound(node, tokens[idx])) node = node.parentElement;
          if (!node) return false;
          node = node.parentElement;
          idx -= 1;
        }
      }
      return true;
    });
  }
}

// Minimal HTML parse for literal icons and the Bot details template.
function parseMarkup(source, doc) {
  const root = new StubElement('div', doc);
  const stack = [root];
  const re = /<(\/?)([a-z][a-z0-9-]*)((?:\s+[a-z:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
  for (const match of String(source).matchAll(re)) {
    const [, close, tag, attrs, selfClose, text] = match;
    const parent = stack[stack.length - 1];
    if (text !== undefined) {
      if (text.trim()) {
        const node = new StubElement('#text', doc);
        node.textContent = text.trim();
        parent.appendChild(node);
      }
      continue;
    }
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const node = new StubElement(tag, doc);
    node.className = (/\bclass="([^"]*)"/i.exec(attrs || '') || [])[1] || '';
    for (const [, name, value] of (attrs || '').matchAll(/([a-z:-]+)(?:="([^"]*)")?/gi)) node.setAttribute(name, value ?? '');
    parent.appendChild(node);
    if (!selfClose) stack.push(node);
  }
  root.markup = String(source);
  return root;
}

function createDocument() {
  const doc = {
    documentElement: null,
    head: null,
    listeners: new Map(),
    createElement: tag => new StubElement(tag, doc),
    getElementById: id => doc.head.querySelector(`[id="${id}"]`) || doc.root.querySelector(`[id="${id}"]`) || null,
    querySelector: selector => doc.root.querySelector(selector),
    querySelectorAll: selector => doc.root.querySelectorAll(selector),
    addEventListener(type, fn) { (doc.listeners.get(type) || doc.listeners.set(type, []).get(type)).push(fn); },
    removeEventListener(type, fn) { doc.listeners.set(type, (doc.listeners.get(type) || []).filter(item => item !== fn)); },
    dispatch(type, event = {}) {
      const payload = { type, target: null, preventDefault() {}, stopPropagation() {}, ...event };
      for (const fn of doc.listeners.get(type) || []) fn(payload);
      return payload;
    },
  };
  const html = new StubElement('html', doc);
  html.setAttribute('lang', 'zh-CN');
  html.style = {};
  const head = new StubElement('head', doc);
  html.appendChild(head);
  const body = new StubElement('body', doc);
  html.appendChild(body);
  doc.documentElement = html;
  doc.head = head;
  doc.body = body;
  doc.root = body;
  return doc;
}

function officialSettings(doc, { items = null, generalSections = null } = {}) {
  const layout = doc.createElement('div');
  layout.className = 'sand-settings-layout';
  const nav = doc.createElement('nav');
  nav.className = 'sand-settings-nav';
  const list = items || [
    ['account', '账户'], ['appearance', '外观'], ['language', '语言'], ['timezone', '时区'], ['microphone', '麦克风'],
    ['spell-check', '拼写检查'], ['notification-sound-enabled', '通知声音'], ['model', '模型'],
    ['usage-and-billing', '使用情况和账单'], ['computer', '电脑'], ['vault', '保险库'], ['updates', '更新'],
    ['mystery-setting', '神秘设置'],
  ];
  const rows = new Map();
  for (const [key, label] of list) {
    const button = doc.createElement('button');
    button.className = 'sand-settings-nav__item';
    if (key === 'input-suggestions') {
      button.setAttribute('data-rokbot-suggestions-nav', '1');
    } else {
      button.setAttribute('aria-controls', `sand-settings-panel-${key}`);
    }
    if (key === 'appearance' || key === 'general') {
      button.setAttribute('aria-current', 'page');
      button.setAttribute('data-active', 'true');
    }
    const text = doc.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    button.addEventListener('click', () => {
      for (const other of rows.values()) { other.removeAttribute('aria-current'); other.removeAttribute('data-active'); }
      button.setAttribute('aria-current', 'page');
      button.setAttribute('data-active', 'true');
    });
    nav.appendChild(button);
    rows.set(key, button);
  }
  const panel = doc.createElement('section');
  panel.className = 'sand-settings-panel';
  const header = doc.createElement('div');
  header.className = 'sand-settings-pane-header';
  const body = doc.createElement('div');
  body.className = 'sand-settings-panel__body';
  const pane = doc.createElement('div');
  pane.className = 'sand-settings-pane';
  if (generalSections) {
    const general = doc.createElement('div');
    general.className = 'sand-settings-general';
    for (const spec of generalSections) {
      const sec = doc.createElement('section');
      if (spec.id) sec.setAttribute('id', spec.id);
      if (spec.isMigrate) sec.setAttribute('data-rokbot-migrate-settings', '1');
      const h3 = doc.createElement('h3');
      h3.textContent = spec.heading;
      sec.appendChild(h3);
      general.appendChild(sec);
    }
    pane.appendChild(general);
  }
  body.appendChild(pane);
  panel.append(header, body);
  layout.append(nav, panel);
  doc.root.appendChild(layout);
  return { layout, nav, panel, header, body, pane, rows };
}

test('settings groups follow the Android settings menu order with every official section kept', () => {
  const items = [
    { key: 'account', text: '账户' }, { key: 'appearance', text: '外观' }, { key: 'language', text: '语言' },
    { key: 'notification-sound-enabled', text: '通知声音' }, { key: 'model', text: '模型' },
    { key: 'usage-and-billing', text: '使用情况和账单' }, { key: 'computer', text: '电脑' },
    { key: 'vault', text: '保险库' }, { key: 'updates', text: '更新' },
  ];
  const groups = settingsNav.catalog(items, { label: 'zh-CN' });
  assert.deepEqual(groups.map(group => group.group), ['general', 'notifications', 'models', 'computer', 'data', 'about']);
  assert.deepEqual(groups.map(group => group.label), ['通用与外观', '通知', '模型与用量', '电脑与连接', '数据与迁移', '关于']);
  const seen = groups.flatMap(group => group.rows);
  assert.deepEqual(seen.sort(), items.map(item => item.key).sort(), 'every official section is in exactly one group');
  assert.deepEqual(groups.find(group => group.group === 'models').rows, ['model', 'usage-and-billing']);
  assert.deepEqual(
    settingsNav.catalog(items, { label: 'en' }).map(group => group.label),
    ['General & appearance', 'Notifications', 'Models & usage', 'Computers', 'Data & migration', 'About'],
  );
});

test('settings groups keep pages outside the official list as links and never drop General or unknown rows', () => {
  const items = [{ key: 'general', text: '常规' }, { key: 'label:输入建议', text: '输入建议' }];
  const groups = settingsNav.catalog(items, { label: 'zh-CN' });
  assert.deepEqual(groups, [
    { group: 'input-suggestions', label: '输入建议', rows: ['label:输入建议'] },
    { group: 'general', label: '通用与外观', rows: ['general'] },
  ]);
  assert.deepEqual(settingsNav.catalog(items, { label: 'en' })[0], { group: 'input-suggestions', label: 'Input suggestions', rows: ['label:输入建议'] });
  assert.equal(settingsNav.groupOf('label:mystery'), 'general');
  assert.equal(settingsNav.groupOf('label:检查更新'), 'about');
  assert.equal(settingsNav.groupOf('label:通知'), 'notifications');
  assert.equal(settingsNav.groupOf('general'), 'general');
  for (const label of ['设置', '分区']) {
    assert.deepEqual(settingsNav.catalog([{ key: `label:${label}`, text: label }], { label: 'zh-CN' }), [], `${label} is not a section`);
  }
});

test('installSettingsNav rebuilds the official nav into groups while keeping official panel and handlers intact', () => {
  const doc = createDocument();
  const { nav, panel, body, rows } = officialSettings(doc);
  const changes = [];
  const ui = settingsNav.installSettingsNav({ document: doc, locale: 'zh-CN', onChange: state => changes.push(state) });
  ui.sync();
  assert.ok(doc.documentElement.classList.contains('rokbot-settings-grouped'));
  assert.deepEqual(ui.groups.map(group => group.group), ['general', 'notifications', 'models', 'computer', 'data', 'about']);

  // The official panel stays visible (never hidden by grouping).
  assert.notEqual(body.style.display, 'none', 'official settings panel body remains visible');
  assert.equal(panel.querySelector('.rokbot-settings-pane'), null, 'does not replace official settings panel with a link overlay');

  // Official nav buttons stay mounted in the nav (React keeps identity) but are hidden.
  for (const [key, button] of rows) {
    assert.equal(button.parentElement, nav, `${key} stays in the official nav`);
    assert.equal(button.style.display, 'none', `${key} is hidden in the official nav`);
  }
  // Every official section has exactly one row in the grouped list.
  const grouped = ui.groups.flatMap(group => group.rows.map(row => row.key));
  assert.deepEqual([...grouped].sort(), [...rows.keys()].sort());

  // Clicking a grouped row clicks the real official button so every setting keeps its behaviour.
  const modelsGroup = doc.querySelectorAll('.rokbot-settings-nav-list__group').find(b => b.getAttribute('data-rokbot-settings-group') === 'models');
  assert.ok(modelsGroup, 'models group header is rendered');
  const modelRow = doc.querySelectorAll('.rokbot-settings-nav-list__row').find(r => r.getAttribute('data-rokbot-settings-row') === 'model');
  modelRow.click();
  assert.equal(rows.get('model').clicked, 1, 'the official 模型 button was clicked');
  assert.equal(rows.get('model').getAttribute('aria-current'), 'page');
  assert.equal(changes.at(-1).view, 'group');
  assert.equal(changes.at(-1).group, 'models');

  const usageRow = doc.querySelectorAll('.rokbot-settings-nav-list__row').find(r => r.getAttribute('data-rokbot-settings-row') === 'usage-and-billing');
  usageRow.click();
  assert.equal(rows.get('usage-and-billing').clicked, 1);

  // Removing the dialog and syncing restores the official rows untouched.
  doc.querySelector('.sand-settings-layout').remove();
  ui.sync();
  assert.equal(doc.documentElement.classList.contains('rokbot-settings-grouped'), false);
  for (const button of rows.values()) assert.ok(!button.style.display, 'the official row is visible again');
});

test('installSettingsNav splits consolidated desktop General pane sections into functional groups without losing any section', () => {
  const doc = createDocument();
  const { panel, rows } = officialSettings(doc, {
    items: [
      ['general', '常规'],
      ['input-suggestions', '输入建议'],
      ['computer', '电脑'],
      ['updates', '更新'],
    ],
    generalSections: [
      { id: 'sand-setting-account', heading: '账户' },
      { id: 'sand-setting-appearance', heading: '外观' },
      { id: 'sand-setting-notifications', heading: '通知' },
      { id: 'sand-setting-models', heading: '模型配置' },
      { id: 'sand-setting-usage', heading: '用量' },
      { heading: '迁移', isMigrate: true },
      { heading: '未知新设置' },
    ],
  });
  const ui = settingsNav.installSettingsNav({ document: doc, locale: 'zh-CN' });
  ui.sync();

  assert.deepEqual(
    ui.groups.map(g => g.group),
    ['input-suggestions', 'general', 'notifications', 'models', 'computer', 'data', 'about'],
  );

  const visibleHeadings = () => [...panel.querySelectorAll('.sand-settings-general > section')]
    .filter(sec => sec.getAttribute('data-rokbot-section-hidden') !== '1')
    .map(sec => sec.querySelector('h3').textContent);

  // Initially on General: shows general/appearance/unknown sections (unknown is never dropped).
  assert.deepEqual(visibleHeadings(), ['账户', '外观', '未知新设置']);

  // Switching to 通知 filters to notification section only.
  ui.showGroup('notifications');
  assert.deepEqual(visibleHeadings(), ['通知']);

  // Switching to 模型与用量 shows Model & Usage sections.
  ui.showGroup('models');
  assert.deepEqual(visibleHeadings(), ['模型配置', '用量']);

  // Switching to 数据与迁移 shows Migration section.
  ui.showGroup('data');
  assert.deepEqual(visibleHeadings(), ['迁移']);

  // Switching to 电脑 clicks the official Computer tab and clears section filtering.
  ui.showGroup('computer');
  assert.equal(rows.get('computer').clicked, 1);
  assert.equal(panel.querySelectorAll('[data-rokbot-section-hidden="1"]').length, 0);

  // Switching to 输入建议 clicks composer-assist's nav button.
  ui.showGroup('input-suggestions');
  assert.equal(rows.get('input-suggestions').clicked, 1);

  ui.destroy();
});

test('the settings nav survives a rebuild of the official dialog and keeps its own list', () => {
  const doc = createDocument();
  const first = officialSettings(doc);
  const ui = settingsNav.installSettingsNav({ document: doc, locale: 'zh-CN' });
  ui.sync();
  first.layout.remove();
  const second = officialSettings(doc);
  ui.sync();
  assert.equal(second.nav.querySelectorAll('.rokbot-settings-nav-list__group').length, 6);
  for (const button of second.rows.values()) assert.equal(button.style.display, 'none');
  ui.destroy();
  second.layout.remove();
  const third = officialSettings(doc);
  assert.equal(third.nav.querySelectorAll('.rokbot-settings-nav-list__group').length, 0, 'destroy leaves no grouped list behind');
  ui.sync();
  assert.equal(third.nav.querySelectorAll('.rokbot-settings-nav-list__group').length, 0, 'destroy stops the grouping');
});

test('the 输入建议 settings page has a bounded, scrollable body chain beating StyleX overflow:hidden', () => {
  const css = read('workspace.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    assert.ok(match, `${selector} is styled`);
    return [...match[1].matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].reduce((acc, [, prop, value]) => ({ ...acc, [prop]: value.trim() }), {});
  };
  const page = rule('.rokbot-sug-page');
  assert.match(page.display, /^flex\b/);
  assert.match(page['flex-direction'], /^column\b/);
  assert.match(page['min-height'], /^0\b/);
  assert.match(page.flex, /1 1 auto/);
  const body = rule('.rokbot-sug-page__body');
  assert.match(body['overflow-y'], /^auto\s*!important$/, 'overflow-y: auto !important overrides official StyleX sand-b3r6kr overflow:hidden');
  assert.match(body['min-height'], /^0\s*!important$/);
  assert.match(body.flex, /1 1 auto/);
  const header = rule('.rokbot-sug-page__header');
  assert.match(header.flex, /^none\b/, 'the header keeps its height; only the body scrolls');
  const panel = rule('.sand-settings-panel.rokbot-sug-page-open');
  assert.match(panel.display, /^flex\b/);
  assert.match(panel['flex-direction'], /^column\b/);
  assert.match(panel['min-height'], /^0\b/);
  assert.match(panel.overflow, /^hidden\b/);
  assert.equal(settingsNav.overflows({ clientHeight: 300, scrollHeight: 900 }), true);
  assert.equal(settingsNav.overflows({ clientHeight: 300, scrollHeight: 300 }), false);
});

test('the 输入建议 page keeps the official header and body it clones', () => {
  const source = read('composer-assist.cjs');
  assert.match(source, /body\.className = officialBody\?\.className \|\| 'sand-settings-panel__body'/);
  assert.match(source, /body\.classList\.add\('rokbot-sug-page__body'\)/);
  assert.match(source, /header\.classList\.add\('rokbot-sug-page__header'\)/);
});

test('Bot details fields come from the existing interfaces (model, usage, connection summaries)', () => {
  const config = {
    profiles: [{ id: 'opus', name: 'Claude Opus', model: 'claude-opus-5-5' }, { id: 'mini', model: 'gpt-5-mini' }],
    botRoutes: { 'bot-a': { profileId: 'opus', effort: 'high' }, 'bot-b': { profileId: 'mini', effort: 'default' } },
  };
  assert.deepEqual(botProfile.modelSummary(config, 'bot-a'), { routed: true, name: 'Claude Opus', effort: 'high', text: 'Claude Opus · high' });
  assert.deepEqual(botProfile.modelSummary(config, 'bot-b'), { routed: true, name: 'gpt-5-mini', effort: '', text: 'gpt-5-mini' });
  assert.deepEqual(botProfile.modelSummary(config, 'bot-c'), { routed: false, name: '', effort: '', text: '' });
  assert.deepEqual(botProfile.usageSummary(null), { ok: false, today: null, requests: null, text: '' });
  assert.deepEqual(
    botProfile.usageSummary({ ok: true, total: 13345, requests: 2, periods: [{ id: 'today', total: 1000, requests: 3 }, { id: '7d', total: 13345 }] }),
    { ok: true, today: 1000, requests: 3, text: '' },
  );
  assert.deepEqual(
    botProfile.connectionSummary({ connected: true, paired: true, transportPath: 'direct', server: 'http://127.0.0.1:9', version: '1.2.3' }),
    { connected: true, paired: true, transport: 'direct', host: 'http://127.0.0.1:9', version: '1.2.3', error: '' },
  );
  assert.equal(botProfile.connectionSummary({ connection: { connected: true, tailcat: true } }).transport, 'tailcat');
  assert.equal(botProfile.connectionSummary({}).connected, false);
  assert.equal(botProfile.formatCount(13345), '13k');
  assert.equal(botProfile.formatCount(999), '999');
});

test('Bot details page opens from the conversation header on a desktop and lists the Android Bot screen fields', async () => {
  const doc = createDocument();
  const raf = [];
  const win = {
    document: doc,
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: fn => raf.push(fn),
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    console,
    Promise,
    localBot: { connectionStatus: async () => ({ connected: true, paired: true, transportPath: 'direct', server: 'http://host' }) },
  };
  doc.defaultView = win;
  const notifyCalls = [];
  globalThis.__rokbotProfile = {
    getAgent: async id => ({ agent: { id, name: '研究员', title: '资料检索与分析', description: '帮我查资料并整理结论。', notifyOnUpdatesEnabled: false } }),
    getAutomations: async () => ({ automations: [{ id: 'a', isEnabled: true }, { id: 'b', isEnabled: false }, { id: 'c' }] }),
    setNotify: async (id, next) => { notifyCalls.push([id, next]); return { ok: true }; },
  };
  // The official header, sidebar, and details pane, as the renderer draws them.
  const chat = doc.createElement('div');
  chat.className = 'sand-chat';
  const header = doc.createElement('div');
  header.className = 'sand-chat-header';
  const title = doc.createElement('span');
  title.className = 'sand-chat-header__title';
  const titleText = doc.createElement('#text');
  titleText.textContent = '研究员';
  title.appendChild(titleText);
  const identity = doc.createElement('button');
  identity.className = 'sand-chat-header__identity';
  identity.appendChild(title);
  const avatar = doc.createElement('span');
  avatar.className = 'sand-chat-header__avatar';
  const avatarInner = doc.createElement('div');
  avatarInner.textContent = '头';
  avatar.appendChild(avatarInner);
  header.append(identity, avatar);
  chat.appendChild(header);
  const sidebar = doc.createElement('nav');
  sidebar.className = 'sand-agents-sidebar';
  const item = doc.createElement('div');
  item.className = 'sand-agent-item';
  item.setAttribute('aria-current', 'page');
  item.dataset.agentId = 'bot-a';
  item.setAttribute('data-agent-id', 'bot-a');
  sidebar.appendChild(item);
  const pane = doc.createElement('section');
  pane.className = 'sand-info-pane';
  pane.setAttribute('data-open', 'true');
  const inner = doc.createElement('div');
  inner.className = 'sand-info-pane__inner';
  const settingsRow = doc.createElement('button');
  settingsRow.setAttribute('data-info-row', 'settings');
  settingsRow.textContent = 'Settings';
  inner.appendChild(settingsRow);
  pane.appendChild(inner);
  doc.root.append(chat, sidebar, pane);

  const usageCalls = [];
  const ui = botProfile.installBotProfile({
    document: doc,
    window: win,
    locale: 'zh-CN',
    usage: async () => { usageCalls.push(1); return { ok: true, periods: [{ id: 'today', total: 4200, requests: 7 }] }; },
    modelConfig: async () => ({ ok: true, config: { profiles: [{ id: 'opus', name: 'Claude Opus' }], botRoutes: { 'bot-a': { profileId: 'opus', effort: 'medium' } } } }),
  });

  const event = { target: identity };
  identity.dispatch('click', event);
  for (const fn of doc.listeners.get('click') || []) fn(event);
  for (const fn of raf.splice(0)) fn(0);
  assert.equal(ui.isOpen, true, 'the header click opens the Bot details page');
  assert.equal(doc.documentElement.classList.contains('rokbot-bot-details-open'), true, 'details overlay hides official pane body');
  const root = inner.querySelector('.rokbot-bot-details');
  assert.ok(root, 'the page is mounted in the official details pane');
  const text = selector => root.querySelector(selector)?.textContent;
  for (let i = 0; i < 10 && text('.rokbot-bot-details__intro') !== '帮我查资料并整理结论。'; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(text('.rokbot-bot-details__name'), '研究员');
  assert.equal(text('.rokbot-bot-details__intro'), '帮我查资料并整理结论。');
  assert.equal(text('[data-bot-fact="model"] .rokbot-bot-details__fact-value'), 'Claude Opus · medium');
  assert.match(text('[data-bot-fact="connection"] .rokbot-bot-details__fact-value'), /已连接/);
  assert.match(text('[data-bot-fact="connection"] .rokbot-bot-details__fact-value'), /已配对/);
  assert.equal(text('[data-bot-fact="usage"] .rokbot-bot-details__fact-value'), '今日 4.2k tokens · 7 次请求');
  assert.equal(text('[data-bot-meta="routines"]'), '2 已开启');
  assert.equal(root.querySelector('[data-bot-toggle="notify"]').getAttribute('aria-checked'), 'false');
  assert.equal(usageCalls.length, 1, 'usage comes from the host bridge registered by the client');
  for (const action of ['edit', 'routines', 'library', 'computer', 'settings']) {
    assert.ok(root.querySelector(`[data-bot-action="${action}"]`), `quick action ${action}`);
  }

  // Toggling notify calls setNotify with the new state.
  root.querySelector('[data-bot-toggle="notify"]').click();
  assert.deepEqual(notifyCalls, [['bot-a', true]]);

  // Clicking Bot Settings steps aside so the official settings subpage is visible and clicks it.
  root.querySelector('[data-bot-action="settings"]').click();
  assert.equal(settingsRow.clicked, 1);
  assert.equal(root.hidden, true);
  assert.equal(doc.documentElement.classList.contains('rokbot-bot-details-open'), false);

  // Back closes the page instead of leaving the conversation.
  root.querySelector('.rokbot-bot-details__back').click();
  assert.equal(ui.isOpen, false);
  ui.destroy();
  delete globalThis.__rokbotProfile;
});

test('Bot details page stays out of the way on a phone layout, where the mobile hub already handles the header', () => {
  const doc = createDocument();
  const win = {
    document: doc,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: fn => fn(0),
    addEventListener() {},
    removeEventListener() {},
  };
  const identity = doc.createElement('button');
  identity.className = 'sand-chat-header__identity';
  doc.root.appendChild(identity);
  const ui = botProfile.installBotProfile({ document: doc, window: win, locale: 'zh-CN' });
  const event = { target: identity };
  for (const fn of doc.listeners.get('click') || []) fn(event);
  assert.equal(ui.isOpen, false);
  assert.equal(doc.querySelector('.rokbot-bot-details'), null);
  ui.destroy();
});

test('settings nav, the 输入建议 page and Bot details are shared by the Web bundle and the desktop preload', () => {
  const preload = read('preload.cjs');
  assert.match(preload, /require\('\.\/settings-nav-loader\.cjs'\)/);
  assert.match(preload, /require\('\.\/bot-profile-loader\.cjs'\)/);
  const navLoader = read('settings-nav-loader.cjs');
  assert.match(navLoader, /require\('\.\/settings-nav\.cjs'\)/);
  assert.match(navLoader, /installSettingsNav/);
  const profileLoader = read('bot-profile-loader.cjs');
  assert.match(profileLoader, /require\('\.\/bot-profile\.cjs'\)/);
  assert.match(profileLoader, /installBotProfile/);
  assert.match(profileLoader, /rokbot-local:bot-profile-get/);
  assert.match(profileLoader, /rokbot-local:usage/);
  assert.match(profileLoader, /rokbot-local:model-get/);
  assert.match(profileLoader, /rokbot-local:status/);

  const patch = readFileSync(path.join(REPO, 'web/patchers/patch.mjs'), 'utf8');
  for (const asset of ['settings-nav.cjs', 'bot-profile.cjs']) assert.match(patch, new RegExp(`sharedAssets = \\[[^\\]]*'${asset.replace('.', '\\.')}'`), asset);
  const bridge = readFileSync(path.join(REPO, 'web/client/bridge.js'), 'utf8');
  for (const asset of ['settings-nav.js', 'bot-profile.js']) assert.ok(bridge.includes(`import './desktop/${asset}';`), asset);
  assert.match(bridge, /RokBotSettingsNav\?\.installSettingsNav\?\./);
  assert.match(bridge, /RokBotBotProfile\?\.installBotProfile\?\./);
  assert.match(bridge, /modelBridge\.getUsage/, 'the Web client hands the usage bridge to the Bot page');
  assert.match(bridge, /modelBridge\.getModelConfig/, 'the Web client hands the model bridge to the Bot page');
});

test('shared files run in a pure browser context without Node globals (no process reference)', () => {
  for (const [file, globalName] of [['settings-nav.cjs', 'RokBotSettingsNav'], ['bot-profile.cjs', 'RokBotBotProfile']]) {
    const source = read(file);
    assert.doesNotMatch(source, /\bprocess\.env\b/, `${file} must not touch process.env in browser context`);
    const sandbox = {};
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox);
    assert.ok(sandbox[globalName], `${globalName} is defined`);
  }
});

test('the new desktop files contain no legacy brand strings and no emoji', () => {
  const forbiddenBrand = new RegExp(['g', 'rok'].join(''), 'i');
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/u;
  for (const file of ['settings-nav.cjs', 'settings-nav-loader.cjs', 'bot-profile.cjs', 'bot-profile-loader.cjs']) {
    const source = read(file);
    assert.doesNotMatch(source, forbiddenBrand, file);
    assert.doesNotMatch(source, emoji, file);
  }
  const css = read('workspace.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css.slice(css.indexOf('First-level "Input suggestions" settings page')), forbiddenBrand);
});

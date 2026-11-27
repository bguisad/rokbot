// 「完成」 / submit never leaves the user with nothing (desktop + Web share these files):
//  - migration wizard: 开始导入 calls the Host, shows progress, then the report with a wired 完成
//    that closes it; a failing import keeps the dialog and shows the error; a failing list refresh
//    after a successful import no longer hides the report;
//  - connection / account-name dialogs: a stale IME composition flag never swallows a click on the
//    submit button, and a failure without a message still shows an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../clients/desktop/', import.meta.url);
const recipes = new URL('../../windows/tools/desktop-recipes/extensions/', import.meta.url);

// ---- a DOM just big enough for the wizard ------------------------------------------------
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {};
    this.className = ''; this._text = ''; this.hidden = false; this.disabled = false; this.style = {}; this.parent = null;
    this.classList = { add: name => { this.className = `${this.className} ${name}`.trim(); } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(value) { this._text = ''; this.children = []; }
  append(...nodes) { for (const node of nodes) { if (node == null || node === false) continue; const n = typeof node === 'string' ? Object.assign(new FakeNode('#text'), { _text: node }) : node; n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); }
  focus() {}
  click() { if (this.disabled) return; for (const fn of this.listeners.click ?? []) fn({ currentTarget: this, target: this, preventDefault() {} }); }
  *walk() { yield this; for (const child of this.children) yield* child.walk(); }
  querySelector(selector) { const cls = selector.replace(/^\./, ''); for (const node of this.walk()) if (node !== this && node.className.split(/\s+/).includes(cls)) return node; return null; }
  buttons() { return [...this.walk()].filter(node => node.tagName === 'BUTTON'); }
  button(label) { return this.buttons().find(node => node.textContent.trim() === label); }
}
globalThis.document = { createElement: tag => new FakeNode(tag), addEventListener() {}, removeEventListener() {} };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

const { createMigrationWizard } = await import(new URL('migrate-wizard.js', root));

function fixture({ importImpl, listImpl } = {}) {
  const calls = [];
  const toasts = [];
  const preview = { id: 'p1', label: 'Grok Bot 导出', counts: { bots: 1 }, hostAvailable: true, bots: [{ key: 'b1', name: 'Ops', status: 'new', counts: { memory: 1, skills: 0, routines: 0, files: 0, chat: 0 }, secrets: [] }], skills: [], secrets: [], userMemory: 0 };
  const adapter = {
    toast: (message, error) => toasts.push([message, Boolean(error)]),
    list: async () => { calls.push('list'); return listImpl ? listImpl() : { packages: [], tokens: [] }; },
    preview: async id => { calls.push(['preview', id]); return preview; },
    import: async (id, selection) => { calls.push(['import', id, selection.bots.b1.include]); return importImpl ? importImpl() : { bots: [{ name: 'Ops', action: 'created', added: { memory: 1 } }] }; },
  };
  const rootNode = new FakeNode('div');
  const wizard = createMigrationWizard(rootNode, adapter);
  const modal = rootNode.children.at(-1);
  return { calls, toasts, wizard, modal };
}

test('migration wizard: 开始导入 -> Host import -> report with a working 完成', async () => {
  const { calls, wizard, modal } = fixture();
  await wizard.openReview('p1');
  modal.button('下一步').click();
  const start = modal.button('开始导入');
  assert.ok(start, '开始导入 is wired');
  start.click();
  assert.equal(start.disabled, true, 'progress: the button is busy (no double submit)');
  assert.equal(start.textContent, '处理中…');
  start.click();
  await flush();
  assert.deepEqual(calls.filter(call => call[0] === 'import'), [['import', 'p1', true]], 'one Host import');
  assert.match(modal.textContent, /导入结果/);
  const done = modal.button('完成');
  assert.ok(done, '完成 is shown with the report');
  assert.equal(modal.hidden, false);
  done.click();
  assert.equal(modal.hidden, true, '完成 closes the dialog');
});

test('migration wizard: a failing import keeps the dialog and shows the error', async () => {
  const { toasts, wizard, modal } = fixture({ importImpl: () => { throw new Error('Host 不可用'); } });
  await wizard.openReview('p1');
  modal.button('下一步').click();
  const start = modal.button('开始导入');
  start.click();
  await flush();
  assert.deepEqual(toasts.at(-1), ['Host 不可用', true]);
  assert.equal(modal.hidden, false, 'the dialog stays open');
  assert.equal(start.disabled, false, 'and can be retried');
  assert.equal(start.textContent, '开始导入');
});

test('migration wizard: a failed list refresh after a successful import still shows the report', async () => {
  const { toasts, wizard, modal } = fixture({ listImpl: () => { throw new Error('刷新失败'); } });
  await wizard.openReview('p1');
  modal.button('下一步').click();
  modal.button('开始导入').click();
  await flush();
  assert.ok(modal.button('完成'), 'report + 完成 shown');
  assert.equal(modal.hidden, false);
  assert.ok(toasts.some(([message, error]) => message === '刷新失败' && error), 'the refresh error is reported too');
});

test('connection / account dialogs: 完成 wired, submit never swallowed by a stale IME flag, errors always visible', async () => {
  const sources = {
    'mac general-settings-extension.js': await readFile(new URL('general-settings-extension.js', root), 'utf8'),
    'mac account-settings-extension.js': await readFile(new URL('account-settings-extension.js', root), 'utf8'),
    'recipe general-pane.js (1.3.0 desktop + Web)': await readFile(new URL('general-pane.js', recipes), 'utf8'),
  };
  for (const [name, src] of Object.entries(sources)) {
    assert.doesNotMatch(src, /if \(composing\.current \|\| submitting\.current/, `${name}: a stuck composition flag must not turn the submit click into a no-op`);
    assert.doesNotMatch(src, /isComposing \|\| composing\.current/, `${name}: Enter is blocked only while the IME really composes`);
    assert.doesNotMatch(src, /catch \(failure\) \{ setError\(failure\.message\); \}/, `${name}: a failure without a message still shows an error`);
    assert.doesNotMatch(src, /throw new Error\(result\.error\);/, `${name}: a failed pair without error text still explains itself`);
  }
  for (const name of ['mac general-settings-extension.js', 'recipe general-pane.js (1.3.0 desktop + Web)']) {
    assert.match(sources[name], /onClick: \(\) => setOpen\(false\), variant: 'primary', children: \w+\('完成', 'Done'\)/, `${name}: 完成 closes the dialog`);
    assert.match(sources[name], /type: 'submit', disabled: busy[\s\S]{0,120}?pending: busy/, `${name}: submit shows progress and blocks double submits`);
  }
  const connect = await readFile(new URL('connect.js', root), 'utf8');
  assert.match(connect, /error\?\.message \|\| text\('连接失败，请重试。'/);
});

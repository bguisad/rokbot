import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const extDir = new URL('./desktop-recipes/extensions/', import.meta.url);
const source = await readFile(new URL('list-arrangement.js', extDir), 'utf8');
const generalPane = (await readFile(new URL('general-pane.js', extDir), 'utf8')).replace(/export \{[^}]+\};?/g, '')
  .replaceAll('import.meta.url', JSON.stringify(new URL('module.js', extDir).href));

const zh = (zhText) => zhText;

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    dispatch: (type, event) => { for (const fn of listeners.get(type) ?? []) fn(event); },
  };
}

/** The extension in a fresh page: React hooks run outside a renderer (memo recomputes). */
function load({ storage = memoryStorage(), window = eventTarget() } = {}) {
  const context = vm.createContext({
    localStorage: storage, window, grokText: zh,
    X: { useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), useMemo: fn => fn() },
  });
  context.globalThis = context;
  vm.runInContext(source, context);
  return { context, storage, window };
}

const agent = (id, fields = {}) => ({ id, name: id, createdAt: 1, updatedAt: 1, hasUnread: false, isRunning: false, awaitingUserResponse: null, ...fields });

test('activity order: waiting on you, then unread, then read; each newest message first', () => {
  const { context } = load();
  const rows = [
    agent('read-old', { lastActivityAt: 100 }),
    agent('unread-old', { hasUnread: true, lastActivityAt: 200 }),
    agent('read-new', { lastMessageAt: 900 }),
    agent('running', { isRunning: true, lastActivityAt: 50 }),
    agent('question', { pendingAction: { kind: 'question', since: 10 }, lastMessageAt: 10 }),
    agent('thread-unread', { unreadThreadCount: 2, lastActivityAt: 300 }),
    agent('handoff', { awaitingUserResponse: { tabId: 'box', reason: 'Sign in', since: 5 }, lastActivityAt: 5, hasUnread: true }),
    agent('typing', { isComposingMessage: true, lastActivityAt: 70 }),
  ];
  const { agents, groups } = context.rokArrangeAgents(rows);
  assert.deepEqual(agents.map(item => item.id), ['question', 'handoff', 'typing', 'running', 'thread-unread', 'unread-old', 'read-new', 'read-old']);
  assert.deepEqual(JSON.parse(JSON.stringify(groups)), [
    { id: 'rokbot:pending', kind: 'pending', agentIds: ['question', 'handoff', 'typing', 'running'] },
    { id: 'rokbot:unread', kind: 'unread', agentIds: ['thread-unread', 'unread-old'] },
    { id: 'rokbot:read', kind: 'read', agentIds: ['read-new', 'read-old'] },
  ]);
});

test('the last message time uses the Host field, then the official activity time, then creation', () => {
  const { context } = load();
  assert.equal(context.rokListLastMessageAt(agent('a', { lastMessageAt: 500, lastActivityAt: 400 })), 500);
  assert.equal(context.rokListLastMessageAt(agent('a', { lastMessageAt: 400, lastActivityAt: 600 })), 600, 'a newer message seen before the next summary');
  assert.equal(context.rokListLastMessageAt(agent('a', { lastMessageAt: null, createdAt: 42 })), 42);
  const { agents } = context.rokArrangeAgents([agent('same-1', { lastActivityAt: 5 }), agent('same-2', { lastActivityAt: 5 }), null, { name: 'no id' }]);
  assert.deepEqual(agents.map(item => item.id), ['same-1', 'same-2'], 'ties keep the incoming order; invalid rows are dropped');
  assert.equal(context.rokArrangeAgents(undefined).groups.length, 0);
});

test('the choice and folded groups persist, and follow other tabs', () => {
  const storage = memoryStorage();
  const first = load({ storage });
  const store = first.context.rokListStore();
  assert.equal(store.getMode(), 'default');
  let changes = 0;
  store.subscribe(() => changes++);
  store.setMode('activity');
  store.setCollapsed('rokbot:read', true);
  store.setCollapsed('rokbot:read', true);
  store.setCollapsed('user-section', true);
  store.setMode('sideways');
  assert.equal(changes, 2);
  assert.deepEqual(JSON.parse(storage.getItem('rokbot.listArrangement.v1')), { mode: 'activity', collapsed: ['rokbot:read'] });

  const reopened = load({ storage }).context.rokListStore();
  assert.equal(reopened.getMode(), 'activity', 'a restart keeps the choice');
  assert.equal(reopened.isCollapsed('rokbot:read'), true);
  reopened.toggle();
  assert.equal(reopened.getMode(), 'default', 'switching back to the official order');

  first.window.dispatch('storage', { key: 'rokbot.listArrangement.v1', newValue: JSON.stringify({ mode: 'default', collapsed: [] }) });
  assert.equal(store.getMode(), 'default', 'another tab switched back');
  first.window.dispatch('storage', { key: 'other', newValue: '{}' });
  assert.equal(changes, 3);
});

test('unreadable or missing storage falls back to the official order', () => {
  assert.equal(load({ storage: memoryStorage({ 'rokbot.listArrangement.v1': '{not json' }) }).context.rokListStore().getMode(), 'default');
  const context = vm.createContext({ window: null, X: {}, grokText: zh });
  context.globalThis = context;
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('denied'); } });
  vm.runInContext(source, context);
  const store = context.rokListStore();
  store.setMode('activity');
  assert.equal(store.getMode(), 'activity', 'works for this page without storage');
});

test('the sidebar keeps the official inputs in the default order', () => {
  const { context } = load();
  const input = { visibleAgents: [agent('a')], sidebarSections: [{ id: 's', name: 'Mine', agentIds: ['a'] }], setSectionCollapsed: () => {}, editSections: {} };
  const result = context.RokUseArrangedSidebar(input);
  for (const key of Object.keys(input)) assert.equal(result[key], input[key], key);
});

test('activity mode: generated sections, local folding, and no section edits reach the Host', () => {
  const { context } = load();
  const store = context.rokListStore();
  store.setMode('activity');
  store.setCollapsed('rokbot:read', true);
  const folded = [], edits = [];
  const input = {
    visibleAgents: [agent('read', { lastActivityAt: 1 }), agent('unread', { hasUnread: true })],
    sidebarSections: [{ id: 'mine', name: 'Mine', agentIds: ['read'] }],
    setSectionCollapsed: (id, collapsed) => folded.push([id, collapsed]),
    editSections: { create: name => { edits.push(['create', name]); return 'new-id'; }, assign: (ids, to) => { edits.push(['assign', ids, to]); return true; }, label: 'kept' },
  };
  const result = context.RokUseArrangedSidebar(input);
  assert.deepEqual(result.visibleAgents.map(item => item.id), ['unread', 'read']);
  assert.deepEqual(JSON.parse(JSON.stringify(result.sidebarSections)), [
    { id: 'rokbot:unread', name: '未读', agentIds: ['unread'], isCollapsed: false },
    { id: 'rokbot:read', name: '已读', agentIds: ['read'], isCollapsed: true },
  ]);
  result.setSectionCollapsed('rokbot:unread', true);
  assert.equal(store.isCollapsed('rokbot:unread'), true);
  result.setSectionCollapsed('mine', true);
  assert.deepEqual(folded, [['mine', true]], 'a real section folds through the original store');
  assert.equal(result.editSections.assign(['read'], 'rokbot:unread'), null);
  assert.equal(result.editSections.assign(['read'], 'mine'), true);
  assert.equal(result.editSections.create('Work'), 'new-id');
  assert.equal(result.editSections.label, 'kept');
  assert.deepEqual(edits, [['assign', ['read'], 'mine'], ['create', 'Work']]);
  assert.equal(context.rokListGuardEdits(null), null);
  assert.equal(context.rokListIsGroupId('rokbot:pending'), true);
  assert.equal(context.rokListIsGroupId('__agents__'), false);
  assert.equal(context.rokListGroupName('rokbot:pending', (zhText, en) => en), 'Needs attention');
});

test('Settings > General switches the arrangement through the shared store', () => {
  const page = load();
  const store = page.context.rokListStore();
  const jsx = (type, props) => ({ type, props });
  const context = vm.createContext({
    __rokListArrangement: store, grokText: zh, window: {},
    $: { jsx, jsxs: jsx }, Q: { useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot() },
    Vn: 'Section', X: 'Row', gn: 'Toggle', q: 'Button', Ft: {}, gr: {},
  });
  context.globalThis = context;
  vm.runInContext(generalPane, context);
  const render = () => {
    const section = context.RokListArrangementSettings();
    return { section, toggle: section.props.children.props.children };
  };
  let { section, toggle } = render();
  assert.equal(section.props.title, '会话列表');
  assert.equal(toggle.type, 'Toggle');
  assert.equal(toggle.props.isChecked, false);
  assert.equal(toggle.props.isDisabled, false);
  toggle.props.onToggle();
  assert.equal(store.getMode(), 'activity');
  ({ toggle } = render());
  assert.equal(toggle.props.isChecked, true);
  toggle.props.onToggle();
  assert.equal(store.getMode(), 'default');

  context.__rokListArrangement = undefined;
  assert.equal(render().toggle.props.isDisabled, true, 'no app store: the toggle is shown disabled');
});

/** The extension with the app module's header parts: tooltip He, round button ET, Z (JSX). */
function loadWithHeader(options) {
  const page = load(options);
  const jsx = (type, props, key) => ({ type, props, key });
  Object.assign(page.context, { Z: { jsx, jsxs: jsx }, He: 'Tooltip', ET: 'HeaderButton', fA: { newButton: { header: true } } });
  return page;
}
const svgParts = glyph => {
  const icon = glyph.type(glyph.props);
  return { icon, svg: icon.props.children, parts: icon.props.children.props.children };
};

test('the wind chime toggle left of Search switches the order and shows its state', () => {
  const { context, storage } = loadWithHeader();
  const store = context.rokListStore();
  const render = () => {
    const tooltip = context.RokListModeButton();
    return { tooltip, button: tooltip.props.children };
  };
  let { tooltip, button } = render();
  assert.equal(tooltip.type, 'Tooltip');
  assert.equal(tooltip.props.content, '按最后消息时间排列');
  assert.equal(button.type, 'HeaderButton', 'the official round header button');
  assert.equal(button.props['aria-label'], '按最后消息时间排列');
  assert.equal(button.props['aria-pressed'], false);
  assert.equal(button.props.isSelected, false);
  assert.equal(button.props.className, 'rokbot-list-mode-toggle');
  assert.deepEqual(button.props.style, { header: true }, 'the header button style of Search and New Bot');
  let { svg, parts } = svgParts(button.props.glyph);
  assert.equal(svg.props.viewBox, '0 0 16 16');
  assert.equal(parts.filter(part => part.type === 'rect').length, 3, 'three chime tubes');
  assert.ok(parts.filter(part => part.type === 'rect').every(part => part.props.fill === 'none'), 'outlined while off');

  button.props.onClick();
  assert.equal(store.getMode(), 'activity');
  assert.deepEqual(JSON.parse(storage.getItem('rokbot.listArrangement.v1')), { mode: 'activity', collapsed: [] }, 'the Settings switch reads the same entry');
  ({ tooltip, button } = render());
  assert.equal(button.props['aria-pressed'], true);
  assert.equal(button.props.isSelected, true, 'the official selected state');
  assert.equal(button.props['aria-label'], '按最后消息时间排列', 'the name stays; the pressed state carries on/off');
  assert.equal(tooltip.props.content, '恢复默认排序');
  ({ parts } = svgParts(button.props.glyph));
  assert.ok(parts.filter(part => part.type === 'rect').every(part => part.props.fill === 'currentColor'), 'filled while on');

  // Settings switches back: the button follows the store.
  store.setMode('default');
  ({ button } = render());
  assert.equal(button.props['aria-pressed'], false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.rokListToggleText(true, undefined))), { label: 'Sort by last message', tooltip: 'Back to the default order' });
});

test('the toggle and the Settings switch stay in sync both ways', () => {
  const page = loadWithHeader();
  const store = page.context.rokListStore();
  const jsx = (type, props) => ({ type, props });
  const settings = vm.createContext({
    __rokListArrangement: store, grokText: zh, window: {},
    $: { jsx, jsxs: jsx }, Q: { useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot() },
    Vn: 'Section', X: 'Row', gn: 'Toggle', q: 'Button', Ft: {}, gr: {},
  });
  settings.globalThis = settings;
  vm.runInContext(generalPane, settings);
  const switchProps = () => settings.RokListArrangementSettings().props.children.props.children.props;
  const buttonProps = () => page.context.RokListModeButton().props.children.props;
  buttonProps().onClick();
  assert.equal(switchProps().isChecked, true, 'the button turned the Settings switch on');
  switchProps().onToggle();
  assert.equal(buttonProps()['aria-pressed'], false, 'the Settings switch turned the button off');
  let notified = 0;
  store.subscribe(() => notified++);
  buttonProps().onClick();
  assert.equal(notified, 1, 'subscribers (the sidebar and Settings) hear about every change');
});

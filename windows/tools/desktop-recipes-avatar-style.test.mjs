import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const extDir = new URL('./desktop-recipes/extensions/', import.meta.url);
const avatarSource = await readFile(new URL('avatar-style.js', extDir), 'utf8');
const generalPane = (await readFile(new URL('general-pane.js', extDir), 'utf8'))
  .replace(/export \{[^}]+\};?/g, '')
  .replaceAll('import.meta.url', JSON.stringify(new URL('module.js', extDir).href));

const zh = zhText => zhText;

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
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== fn)),
    dispatch: (type, event) => { for (const fn of listeners.get(type) ?? []) fn(event); },
  };
}

function createJsxRuntime() {
  const jsx = (type, props, key) => ({ type, props, key });
  return { jsx, jsxs: jsx, Fragment: 'Fragment' };
}

function load({ storage = memoryStorage(), window = eventTarget(), extra = {} } = {}) {
  const Z = createJsxRuntime();
  const context = vm.createContext({
    localStorage: storage,
    window,
    grokText: zh,
    Z,
    X: {
      useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
      useRef: value => ({ current: value }),
      useEffect: () => {},
      useLayoutEffect: () => {},
    },
    mo: (root, style) => ({ className: root?.className ?? '', style: style ?? {} }),
    kst: { root: { className: 'sand-root' } },
    JS: (...parts) => parts.filter(Boolean).join(' '),
    Mst: (props, color, ink, eyeColor, style) => ({
      ...style,
      width: props.sizePx ?? '100%',
      height: props.sizePx ?? '100%',
      '--grok-bot-ink': ink ?? `var(--${color})`,
      ...(eyeColor === undefined ? {} : { '--grok-bot-eye': eyeColor }),
    }),
    ...extra,
  });
  context.globalThis = context;
  vm.runInContext(avatarSource, context);
  return { context, storage, window };
}

test('avatar style store defaults to chassis, persists valid choices, rejects invalid values, and syncs across tabs', () => {
  const storage = memoryStorage();
  const first = load({ storage });
  const store = first.context.rokAvatarStyleStore();
  assert.equal(store.getStyle(), 'chassis');

  let updates = 0;
  store.subscribe(() => updates++);
  for (const style of ['antenna', 'visor', 'pixel', 'orb', 'official', 'chassis']) {
    store.setStyle(style);
    assert.equal(store.getStyle(), style);
  }
  assert.equal(updates, 6);

  // Repeating same style or passing invalid style must be ignored.
  store.setStyle('chassis');
  store.setStyle('unknown-style');
  store.setStyle(123);
  assert.equal(updates, 6);
  assert.equal(store.getStyle(), 'chassis');

  // Corrupt or denied storage gracefully falls back to chassis.
  const corrupt = load({ storage: memoryStorage({ 'rokbot.avatarStyle.v1': '{broken json' }) });
  assert.equal(corrupt.context.rokAvatarStyleStore().getStyle(), 'chassis');

  // Persistence across reloads.
  store.setStyle('visor');
  assert.deepEqual(JSON.parse(storage.getItem('rokbot.avatarStyle.v1')), { style: 'visor' });
  const reloaded = load({ storage });
  assert.equal(reloaded.context.rokAvatarStyleStore().getStyle(), 'visor');

  // Cross-tab storage sync.
  first.window.dispatch('storage', { key: 'rokbot.avatarStyle.v1', newValue: JSON.stringify({ style: 'pixel' }) });
  assert.equal(store.getStyle(), 'pixel');
  first.window.dispatch('storage', { key: 'unrelated', newValue: '{}' });
  assert.equal(store.getStyle(), 'pixel');
});

test('rokNormalizeAvatarState maps all official Bot states accurately', () => {
  const { context } = load();
  const norm = context.rokNormalizeAvatarState;
  assert.equal(norm('idle'), 'idle');
  assert.equal(norm(undefined), 'idle');
  assert.equal(norm('sleeping'), 'sleeping');
  for (const s of ['happy', 'excited', 'laughing', 'proud', 'finished', 'playful']) {
    assert.equal(norm(s), 'happy', s);
  }
  for (const s of ['failed', 'error']) {
    assert.equal(norm(s), 'error', s);
  }
  for (const s of ['waiting', 'blocked', 'attention', 'needs-attention']) {
    assert.equal(norm(s), 'waiting', s);
  }
  for (const s of ['working', 'coding', 'running', 'computing', 'controlling', 'streaming']) {
    assert.equal(norm(s), 'working', s);
  }
  for (const s of ['thinking', 'searching', 'reading', 'listening', 'curious', 'waking']) {
    assert.equal(norm(s), 'thinking', s);
  }
});

test('rokAvatarPalette produces valid gradients for all 11 official colors and custom hex/rgb inks', () => {
  const { context } = load();
  const palette = context.rokAvatarPalette;
  const officialColors = ['black', 'gray', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta'];
  for (const color of officialColors) {
    const dark = palette(color, null, false);
    const light = palette(color, null, true);
    for (const p of [dark, light]) {
      assert.ok(p.top && p.mid && p.bot && p.accent && p.rim, color);
    }
  }
  assert.notDeepEqual(JSON.parse(JSON.stringify(palette('black', null, false))), JSON.parse(JSON.stringify(palette('black', null, true))));
  const customHex = palette(undefined, '#33aa55', false);
  assert.equal(customHex.mid, '#33aa55');
  assert.ok(customHex.top.startsWith('#') && customHex.bot.startsWith('#'));
  const customRgb = palette(undefined, 'rgb(200, 100, 50)', false);
  assert.equal(customRgb.mid, '#c86432');
});

test('RokGrokBotMark and RokGrokBotMarkMirror preserve mirror DOM structure, shape attribute, and safe Ott colors', () => {
  const shapes = [];
  const { context } = load({
    extra: {
      Ir: ({ body }) => {
        shapes.push(body);
        return `<path d="M 10 10 L 90 10 L 50 90 Z" fill="#000"/>`;
      },
      ki: s => `shape:${s}`,
      Ui: 0.84,
    },
  });
  const markTree = context.RokGrokBotMark({ sizePx: 22, className: 'custom', color: undefined, shape: 'star' });
  assert.equal(markTree.type, 'span');
  assert.ok(markTree.props.className.includes('sand-grok-bot-mark'));
  assert.equal(markTree.props.style['--grok-bot-ink'], 'var(--cyan)');
  assert.equal(markTree.props['data-rokbot-avatar-style'], 'chassis');
  assert.equal(markTree.props['data-rokbot-avatar-shape'], 'star');

  const mirrorTree = context.RokGrokBotMarkMirror({ sourceId: 'bot-1', sizePx: 22, shape: 'heart' });
  assert.ok(mirrorTree.props.className.includes('sand-grok-bot-mark--mirror'));
  assert.equal(mirrorTree.props.style['--grok-bot-ink'], 'var(--cyan)');
  assert.equal(mirrorTree.props['data-rokbot-avatar-shape'], 'heart');

  assert.equal(context.rokResolveShapePathD('star'), 'M 10 10 L 90 10 L 50 90 Z');
  assert.deepEqual(shapes, ['shape:star']);
});

test('Settings > General renders all 6 avatar style radio options and switches live via shared store', () => {
  const page = load();
  const store = page.context.rokAvatarStyleStore();
  const $ = createJsxRuntime();
  const context = vm.createContext({
    __rokAvatarStyle: store,
    __rokAvatarDraw: page.context.__rokAvatarDraw,
    grokText: zh,
    window: {},
    $: $,
    Q: {
      useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
      useRef: value => ({ current: value }),
      useEffect: () => {},
    },
    Wn: 'Section',
    X: 'Row',
    He: 'Toggle',
    K: 'Button',
    L: {},
    vr: {},
  });
  context.globalThis = context;
  vm.runInContext(generalPane, context);

  const findRadios = node => {
    if (!node || typeof node !== 'object') return [];
    const results = node.props?.role === 'radio' ? [node] : [];
    const ch = node.props?.children;
    if (Array.isArray(ch)) for (const c of ch) results.push(...findRadios(c));
    else if (ch && typeof ch === 'object') results.push(...findRadios(ch));
    return results;
  };

  let radios = findRadios(context.RokAvatarStyleSettings());
  assert.equal(radios.length, 6);
  assert.deepEqual(radios.map(r => r.props['data-rok-avatar-option']), ['chassis', 'antenna', 'visor', 'pixel', 'orb', 'official']);
  assert.equal(radios[0].props['aria-checked'], true);
  assert.equal(radios[5].props['aria-checked'], false);

  radios[5].props.onClick();
  assert.equal(store.getStyle(), 'official');
  radios = findRadios(context.RokAvatarStyleSettings());
  assert.equal(radios[0].props['aria-checked'], false);
  assert.equal(radios[5].props['aria-checked'], true);

  radios[2].props.onClick();
  assert.equal(store.getStyle(), 'visor');
});

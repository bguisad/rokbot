// rokbot.5b: the Bot list arrangement switches in place and its groups fold. The paired bundle
// always carries both arrangements (hermes-settings.mjs listSortEdits); the mode is the id
// 'sorted' in RN's collapsed-sections state, toggled by the header bell. The rewritten bodies are
// executed here in a small HBC interpreter (hbc-vm.mjs) against mocks of the RN objects they use.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { synthesizePinnedResources } from '../patchers/hermes.mjs';
import {
  LIST_GROUP_IDS, LIST_GROUP_TITLES, LIST_MODE_ID, applyListSortEdits, listSortEdits, rebrandPinnedHermesResources,
} from '../patchers/hermes-settings.mjs';
import { entryBytes, readZip } from '../patchers/signing.mjs';
import { Closure, Env, HbcVm, functionAt, parseHbc, stringAt } from './hbc-vm.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(PROJECT_ROOT, 'android/companion/src/main/java/dev/rokbot/nativeapp');

function resolveXapk() {
  if (process.env.ROKBOT_ANDROID_TEST_XAPK !== undefined) {
    const p = process.env.ROKBOT_ANDROID_TEST_XAPK.trim();
    return p && fs.existsSync(p) ? p : null;
  }
  return [
    path.join(PROJECT_ROOT, 'inputs/android/grok-bot-1.26.0.xapk'),
    '/Volumes/ORICO/grokbot/inputs/android/grok-bot-1.26.0.xapk',
    path.join(process.env.HOME || '', '.cache/rokbot-inputs/grok-bot-1.26.0.xapk'),
  ].find(p => fs.existsSync(p)) || null;
}
const XAPK = resolveXapk();
const skip = !XAPK && 'Official grok-bot-1.26.0.xapk not found; set ROKBOT_ANDROID_TEST_XAPK';

const footerOk = buf =>
  buf.subarray(buf.length - 20).equals(crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest());

let cached;
function loadTemplate() {
  if (cached) return cached;
  const xapk = readZip(fs.readFileSync(XAPK));
  const base = readZip(entryBytes(xapk.entries.find(e => e.name === 'ai.x.grok.bot.apk')));
  const orig = entryBytes(base.entries.find(e => e.name === 'assets/index.android.bundle'));
  const out = rebrandPinnedHermesResources(synthesizePinnedResources(orig));
  const meta = JSON.parse(out.gatewayTemplateJson.toString('utf8'));
  const live = {};
  for (const lang of ['zh', 'en']) live[lang] = applyListSortEdits(out.gatewayTemplateHbc, [...meta.listSort.edits, ...meta.listSort.titles[lang]]);
  cached = { hbc: out.gatewayTemplateHbc, meta, report: out.settingsRebrand, live };
  return cached;
}

/** Function index by name (+ size) in a bundle. */
function fnIndex(buf, name, size) {
  const h = parseHbc(buf);
  const hits = [];
  for (let i = 0; i < h.functionCount; i++) {
    const f = functionAt(buf, h, i);
    if (f.name === name && (size === undefined || f.size === size)) hits.push(i);
  }
  assert.equal(hits.length, 1, `${name} once`);
  return hits[0];
}

const row = (id, extra = {}) => ({ id, createdAt: 1, ...extra });

test('List arrangement: fail closed on anything but the pinned template', () => {
  assert.equal(listSortEdits(Buffer.alloc(4096, 3)), null);
});

test('List arrangement: companion wiring (always applied, no reload, titles language)', () => {
  assert.deepEqual(LIST_GROUP_IDS, ['pending', 'running', 'unread', 'read']);
  assert.deepEqual(LIST_GROUP_TITLES.zh, ['待处理', '进行中', '未读', '已读']);
  assert.deepEqual(LIST_GROUP_TITLES.en, ['Needs attention', 'In progress', 'Unread', 'Read']);
  assert.equal(LIST_MODE_ID, 'sorted');
  // Same wording as the Web / desktop arrangement for the groups it has.
  const web = fs.readFileSync(path.join(PROJECT_ROOT, 'windows/tools/desktop-recipes/extensions/list-arrangement.js'), 'utf8');
  for (const i of [0, 2, 3]) assert.ok(web.includes(`zh: '${LIST_GROUP_TITLES.zh[i]}', en: '${LIST_GROUP_TITLES.en[i]}'`));
  const hp = fs.readFileSync(path.join(SRC, 'HermesPatcher.java'), 'utf8');
  assert.match(hp, /if \(applyListArrangement\(bundle, meta\.optJSONObject\("listSort"\), ListArrangement\.titleLanguage\(context\)\) == LIST_SORT_NONE\)/,
    'applied to every paired bundle, whatever the mode');
  assert.doesNotMatch(hp, /ListArrangement\.isLastMessage\(context\)\) \{/, 'the mode no longer decides what the bundle contains');
  assert.match(hp, /titles\.optJSONArray\(titles\.has\(titleLanguage\) \? titleLanguage : "en"\)/);
  assert.match(hp, /return "\\nlistSort=live:" \+ ListArrangement\.titleLanguage\(context\);/);
  const la = fs.readFileSync(path.join(SRC, 'ListArrangement.java'), 'utf8');
  // The RN language seen on screen is remembered while the app runs (the next cold start builds the
  // titles in it); before rokbot.5b only the bell's bundle regeneration did that.
  assert.match(la, /static void refreshNow\(\) \{[\s\S]{0,400}titleLanguage\(activity\);[\s\S]{0,200}findRawBell/);
  assert.doesNotMatch(la, /reloadReactHost|ensurePairedBundleFile|setLastMessage/, 'the bell never regenerates the bundle or reloads RN');
  const boot = fs.readFileSync(path.join(SRC, 'RokBotBootstrap.java'), 'utf8');
  assert.match(boot, /if \(ListArrangement\.isHeaderBellLabel\(activity, s\)\) \{[^}]*return null;\s*\}/, 'the tap stays in React Native');
  assert.doesNotMatch(boot, /target == ListArrangement\.class/);
});

test('List arrangement: pinned template publishes the live edits; they apply cleanly once', { skip }, () => {
  const { hbc, meta, report, live } = loadTemplate();
  assert.equal(report.listSort.available, true);
  assert.deepEqual(report.listSort.modules, { queries: 4415, session: 2758, agents: 3091 });
  const sort = meta.listSort;
  assert.equal(sort.field, 'lastMessageAt');
  assert.equal(sort.live, 1);
  assert.deepEqual(sort.groups, LIST_GROUP_IDS);
  assert.equal(sort.edits.length, 4);
  assert.deepEqual(Object.keys(sort.titles).sort(), ['en', 'zh']);
  const all = [...sort.edits, ...sort.titles.zh];
  for (const e of [...all, ...sort.titles.en]) {
    assert.equal(e.original.length, e.patched.length);
    assert.equal(hbc.subarray(e.offset, e.offset + e.original.length / 2).toString('hex'), e.original, `anchor at ${e.offset}`);
    assert.ok(e.offset + e.original.length / 2 <= hbc.length - 20, 'never the footer');
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [a, la] = [all[i].offset, all[i].original.length / 2], [b, lb] = [all[j].offset, all[j].original.length / 2];
      assert.ok(a + la <= b || b + lb <= a, `edits ${i} and ${j} overlap`);
    }
  }
  assert.equal(sort.titles.zh[0].offset, sort.titles.en[0].offset, 'one function, two languages');
  for (const lang of ['zh', 'en']) {
    assert.ok(footerOk(live[lang]));
    assert.throws(() => applyListSortEdits(live[lang], sort.edits), /anchor differs/, 'not twice');
    assert.equal(listSortEdits(live[lang]), null);
  }
});

function vmFor(buf, global) {
  return new HbcVm(buf, { global: Object.assign(global, { Math, Array, String }) });
}

test('List arrangement: (A) sections for resolve — official when off, four non-empty groups when on', { skip }, () => {
  const { live } = loadTemplate();
  for (const lang of ['zh', 'en']) {
    const buf = live[lang];
    const fs_ = fnIndex(buf, 'FeedbackSheet', 2698);
    const g = {};
    const vm = vmFor(buf, g);
    const user = [{ id: 'u1', name: 'Work', agentIds: ['a'] }];
    const agents = [
      row('run', { isRunning: true, lastMessageAt: 50 }),
      row('ask', { pendingAction: { kind: 'question', since: 10 }, isRunning: true }),
      row('new', { hasUnread: true }),
      row('old'),
      row('thread', { unreadThreadCount: 2 }),
      row('handoff', { awaitingUserResponse: { reason: 'box' } }),
      row('typing', { isComposingMessage: true }),
      row('none', { pendingAction: null, awaitingUserResponse: null, isRunning: false, hasUnread: false, unreadThreadCount: 0 }),
    ];
    for (const collapsed of [[], ['read', 'pending'], undefined, null, 'sorted']) {
      const params = { agents, sections: user, collapsedSectionIds: collapsed };
      assert.equal(vm.run(fs_, new Env(null, 4), params, []), user, `off (${JSON.stringify(collapsed)}): the user's sections`);
      assert.equal(g.sorted, false);
    }
    const params = { agents, sections: user, collapsedSectionIds: ['x', 'sorted', 'read'] };
    const sections = vm.run(fs_, new Env(null, 4), params, []);
    assert.equal(g.sorted, true, 'global.sorted mirrors the mode');
    assert.deepEqual(sections, [
      { id: 'pending', name: LIST_GROUP_TITLES[lang][0], agentIds: ['ask', 'handoff'] },
      { id: 'running', name: LIST_GROUP_TITLES[lang][1], agentIds: ['run', 'typing'] },
      { id: 'unread', name: LIST_GROUP_TITLES[lang][2], agentIds: ['new', 'thread'] },
      { id: 'read', name: LIST_GROUP_TITLES[lang][3], agentIds: ['old', 'none'] },
    ]);
    // Empty groups are left out; no rows, no groups.
    const some = vm.run(fs_, new Env(null, 4), { ...params, agents: [row('x'), row('y', { isRunning: true })] }, []);
    assert.deepEqual(some.map(s => s.id), ['running', 'read']);
    assert.deepEqual(vm.run(fs_, new Env(null, 4), { ...params, agents: [] }, []), []);
  }
});

test('List arrangement: recencyOf — last message in the grouped mode, official recency otherwise', { skip }, () => {
  const { live } = loadTemplate();
  const buf = live.zh;
  const rec = fnIndex(buf, 'recencyOf', 174);
  const g = {};
  const vm = vmFor(buf, g);
  const shared = new Set(['team']);
  const env = new Env(null, 2);
  env.slots[1] = { isTeammateSharedBot: r => shared.has(r.id) };
  const r = { id: 'a', lastMessageAt: 10, lastActivityAt: 20, createdAt: 1, localActivityAt: 30, updatedAt: 40 };
  const call = (row_, mode) => vm.run(rec, env, undefined, [row_, mode]);
  g.sorted = true;
  assert.equal(call(r, 'activity'), 10, 'lastMessageAt first');
  assert.equal(call({ ...r, lastMessageAt: null }, 'row-updated'), 20, 'then lastActivityAt');
  assert.equal(call({ id: 'b', createdAt: 7 }, 'activity'), 7, 'then createdAt');
  assert.equal(call({ id: 'c', lastMessageAt: 3, createdAt: 9 }, undefined), 9, 'never before creation');
  for (const off of [false, undefined]) {
    g.sorted = off;
    assert.equal(call(r, 'activity'), 30, 'official activity: max(localActivityAt, lastActivityAt, createdAt)');
    assert.equal(call({ id: 'a', lastActivityAt: 20, updatedAt: 40 }, 'row-updated'), 40, 'official row-updated: max(updatedAt, lastActivityAt)');
    assert.equal(call({ id: 'team', lastActivityAt: 20, createdAt: 25, updatedAt: 99 }, 'row-updated'), 25, 'teammate-shared: max(lastActivityAt, createdAt)');
    assert.equal(call(r, 'other'), undefined, 'unknown modes stay unranked');
  }
});

/** The bell rendered for SearchButton, and its onPress, against RN mocks. */
function renderBell(buf, { collapsed, isSelected }) {
  const fsIdx = fnIndex(buf, 'FeedbackSheet', 2698);
  const searchIdx = fnIndex(buf, 'SearchButton', 263);
  const toggled = [];
  let ids = Array.isArray(collapsed) ? [...collapsed] : collapsed;
  const svc = {
    currentCollapsedSections() { assert.equal(this, svc); return ids; },
    toggleSectionCollapsed(id) { assert.equal(this, svc); toggled.push(id); ids = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]; },
  };
  const hooks = [];
  const modules = {
    4415: { useCollapsedSectionIdsQuery: () => { hooks.push('collapsed'); return { data: ids }; } },
    2758: { useSessionService: token => { hooks.push('session'); assert.equal(token, 'AGENTS'); return svc; } },
    3091: { AgentsService: { token: 'AGENTS' } },
  };
  const g = { __r: id => { assert.ok(modules[id], `module ${id}`); return modules[id]; } };
  const vm = vmFor(buf, g);
  const moduleEnv = new Env(null, 5);
  moduleEnv.slots[1] = { useLingui: () => { hooks.push('lingui'); return { _: d => `t:${d.id}` }; } };
  moduleEnv.slots[2] = { SandButton: 'SandButton' };
  moduleEnv.slots[3] = { CursorIcon: 'CursorIcon' };
  moduleEnv.slots[4] = { jsx: (type, props) => ({ type, props }) };
  const onSearch = () => 'search';
  const out = vm.run(searchIdx, moduleEnv, undefined, [{ isSelected, onPress: onSearch }]);
  return { out, vm, g, toggled, hooks, ids: () => ids, svc, fsIdx, onSearch };
}

test('List arrangement: (B) the bell shows the mode; (C) its onPress flips it in place', { skip }, () => {
  const { live } = loadTemplate();
  const buf = live.en;
  // Off, Search in the header: [bell, search].
  const off = renderBell(buf, { collapsed: ['pending'], isSelected: true });
  assert.deepEqual(off.hooks, ['lingui', 'collapsed', 'session'], 'hooks in a fixed order');
  assert.equal(off.g.sorted, false);
  assert.ok(Array.isArray(off.out) && off.out.length === 2);
  const [bell, search] = off.out;
  assert.equal(bell.type, 'SandButton');
  assert.equal(bell.props.variant, 'toolbar');
  assert.equal(bell.props.accessibilityLabel, 'sort');
  assert.deepEqual({ ...bell.props.icon.props }, { name: 'bell', variant: undefined, size: 20, tone: 'primary', color: undefined, weight: 'medium' });
  assert.equal(bell.props.icon.type, 'CursorIcon');
  assert.equal(search.props.onPress, off.onSearch);
  assert.equal(search.props.accessibilityLabel, 't:A1taO8');
  assert.equal(search.props.icon.props.name, 'magnifying-glass');
  // Press: global.sorted flips first (the re-render sorts with it), then 'sorted' is toggled.
  assert.ok(bell.props.onPress instanceof Closure);
  assert.equal(off.vm.call(bell.props.onPress, undefined, [{ nativeEvent: {} }]), undefined);
  assert.deepEqual(off.toggled, ['sorted']);
  assert.equal(off.g.sorted, true);
  assert.deepEqual(off.ids(), ['pending', 'sorted']);
  off.vm.call(bell.props.onPress, undefined, []);
  assert.deepEqual(off.ids(), ['pending']);
  assert.equal(off.g.sorted, false);

  // On, no Search in the header: the bell alone, copper, label 'sorted'.
  const on = renderBell(buf, { collapsed: ['sorted'], isSelected: false });
  assert.equal(on.g.sorted, true);
  assert.equal(on.out.type, 'SandButton');
  assert.equal(on.out.props.accessibilityLabel, 'sorted');
  assert.equal(on.out.props.icon.props.tone, undefined, 'a tone would win over the colour');
  assert.equal(on.out.props.icon.props.color, '#C27400');

  // Loading (no data yet) reads as off; a missing service never throws on press.
  const loading = renderBell(buf, { collapsed: undefined, isSelected: false });
  assert.equal(loading.out.props.accessibilityLabel, 'sort');
  const env = new Env(null, 1);
  assert.equal(loading.vm.run(loading.fsIdx, env, undefined, [{}]), undefined, 'no service');
  env.slots[0] = {};
  assert.equal(loading.vm.run(loading.fsIdx, env, undefined, [{}]), undefined, 'service without the methods');
});

test('List arrangement: group headers fold (toggleSectionCollapsed accepts any id); resolve calls the builder', { skip }, () => {
  const { live, hbc } = loadTemplate();
  const buf = live.zh;
  const h = parseHbc(buf);
  const toggle = functionAt(buf, h, fnIndex(buf, 'toggleSectionCollapsed', 126));
  // +43: JmpTrue @50 (only the user's sections) -> Jmp @50.
  assert.equal(hbc.subarray(toggle.offset + 43, toggle.offset + 46).toString('hex'), 'b00702');
  assert.equal(buf.subarray(toggle.offset + 43, toggle.offset + 46).toString('hex'), 'ae077e');
  assert.equal(stringAt(buf, h, buf.readUInt16LE(toggle.offset + 54)), 'currentCollapsedSections');
  // resolve +18: CreateClosure r4, r2, FeedbackSheet ; Call1 r4, r4, r3 (this = params) ; the original
  // collapsedSectionIds read ; LoadConstUndefined r1.
  const resolveIdx = (() => {
    const hits = [];
    for (let i = 0; i < h.functionCount; i++) {
      const f = functionAt(buf, h, i);
      if (f.name === 'resolve' && f.size === 199) hits.push(f);
    }
    assert.equal(hits.length, 1);
    return hits[0];
  })();
  const p = buf.subarray(resolveIdx.offset + 18, resolveIdx.offset + 48);
  assert.equal(p[0], 132);
  assert.equal(p.readUInt16LE(3), fnIndex(buf, 'FeedbackSheet', 2698));
  assert.deepEqual([...p.subarray(5, 9)], [108, 4, 4, 3]);
  assert.equal(stringAt(buf, h, p.readUInt16LE(13)), 'collapsedSectionIds');
  assert.deepEqual([...p.subarray(15, 17)], [147, 1]);
  assert.ok(p.subarray(17).every(b => b === 126), "padding");
});

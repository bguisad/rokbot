// rokbot.6: the rokbot section is the first group under the account card. The former "Send
// Feedback" group (rokbot.3: one "Connection & Diagnostics" row) becomes a titled section built in
// the dead link-group block (hermes-settings.mjs applySettingsMenu): native InsetGroupNavRow rows
// (Bot Icon Style, Model Settings, Input Suggestions (rokbot.7), Connection & Diagnostics, App
// Updates) plus the official Appearance, Language and Usage rows moved out of their groups; the
// companion opens the native page for each label.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { patchHermesBundleSafely } from '../patchers/hermes.mjs';
import {
  MENU_LABELS, MENU_ORDER, SHEET_CHILD_INDEX, SUGGESTIONS_MESSAGE, applyConnectionEntry, applySettingsMenu, applySettingsRebrand,
} from '../patchers/hermes-settings.mjs';
import { entryBytes, readZip } from '../patchers/signing.mjs';

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
  ].find(p => fs.existsSync(p)) || null;
}
const XAPK = resolveXapk();
const skip = !XAPK && 'Official grok-bot-1.26.0.xapk not found; set ROKBOT_ANDROID_TEST_XAPK';

const footerOk = buf =>
  buf.subarray(buf.length - 20).equals(crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest());

const SETTINGS_OFFSET = 30973717; // SettingsSheet bytecode in the pinned 1.26.0 bundle
const SETTINGS_SIZE = 4376;

// HBC v98 sizes of every opcode the rokbot.6 feedback-group path executes.
const SIZE = {
  2: 10, 8: 4, 21: 3, 30: 4, 59: 4, 61: 2, 68: 5, 69: 6, 72: 6, 82: 4, 90: 4, 93: 4, 94: 4, 110: 5, 111: 6, 112: 7, 126: 1,
  133: 7, 139: 3, 140: 6, 1: 6, 144: 4, 145: 6, 147: 2, 148: 2, 151: 2, 174: 2, 175: 5, 176: 3, 180: 3, 211: 4, 212: 7,
  213: 4, 214: 7,
};
const EXY_LITERAL = 399145;

/**
 * Executes SettingsSheet from +3689 (former memo check of the group) to +3819 (memo store)
 * symbolically. `messages` maps the {id} literal offsets i18n._ is called with to what it
 * returns (exyUec: the connection label); `memo` stands for the render's memo cache (r7).
 * Returns the built group.
 */
function runFeedbackGroup(fn, messages, sid, memo) {
  const r = new Map();
  const i18n = { kind: 'i18n' };
  r.set(31, i18n);
  r.set(1, undefined);
  r.set(6, { kind: 'env' });
  r.set(7, memo);
  // SettingsSheet's frame: r0 is the number register, r1..r4 are non-pointer registers.
  const set = r.set.bind(r);
  r.set = (reg, v) => {
    if (reg === 0) assert.equal(typeof v, 'number', `non-number in r0 at +${pc}`);
    else if (reg >= 1 && reg <= 4) assert.ok(v === undefined || v === null || typeof v !== 'object', `pointer in r${reg} at +${pc}`);
    return set(reg, v);
  };
  const visited = new Set();
  let pc = 3689;
  let steps = 0;
  const rd = n => r.get(n);
  while (pc !== 3819) {
    assert.ok(++steps < 2000, 'runaway');
    assert.ok(pc >= 0 && pc < fn.length, `pc out of range +${pc}`);
    visited.add(pc);
    const op = fn[pc];
    const u8 = k => fn[pc + k];
    const size = SIZE[op];
    assert.ok(size, `unexpected opcode ${op} at +${pc}`);
    let next = pc + size;
    switch (op) {
      case 148: r.set(u8(1), null); break;                                   // LoadConstNull
      case 176: if (rd(u8(2))) next = pc + fn.readInt8(pc + 1); break;       // JmpTrue
      case 174: next = pc + fn.readInt8(pc + 1); break;                       // Jmp
      case 94: r.set(u8(1), rd(u8(2))[u8(3)]); break;                         // GetByIndex
      case 93: {                                                              // GetByVal (array index)
        const key = rd(u8(3));
        assert.equal(typeof key, 'number');
        r.set(u8(1), rd(u8(2))[key]);
        break;
      }
      case 21: r.set(u8(1), typeof rd(u8(2))); break;                         // TypeOf
      case 126: break;                                                        // AsyncBreakCheck
      case 180: if (rd(u8(2)) === undefined) next = pc + fn.readInt8(pc + 1); break;   // JmpUndefined
      case 175: next = pc + fn.readInt32LE(pc + 1); break;                    // JmpLong
      case 59: r.set(u8(1), { kind: 'module', slot: u8(3) }); break;          // LoadFromEnvironment
      case 68: {                                                              // GetByIdShort
        const name = sid[u8(4)];
        const obj = rd(u8(2));
        r.set(u8(1), name === 'charCodeAt' ? { kind: 'charCodeAt' } : name === 'push' ? { kind: 'push' } : { kind: 'fn', name, of: obj });
        break;
      }
      case 69: case 72: {                                                     // GetById / TryGetById
        const name = sid[fn.readUInt16LE(pc + 4)];
        r.set(u8(1), { kind: 'fn', name });
        break;
      }
      case 61: r.set(u8(1), { kind: 'global' }); break;
      case 2: r.set(u8(1), { kind: 'object', shape: fn.readUInt32LE(pc + 2), lit: fn.readUInt32LE(pc + 6), slots: [] }); break; // NewObjectWithBufferLong
      case 1: r.set(u8(1), { kind: 'object', shape: fn.readUInt16LE(pc + 2), slots: [] }); break;
      case 82: rd(u8(1)).slots[u8(3)] = rd(u8(2)); break;                     // PutOwnBySlotIdx
      case 8: r.set(u8(1), []); break;                                        // NewArray
      case 90: rd(u8(1))[u8(3)] = rd(u8(2)); break;                           // DefineOwnInDenseArray
      case 151: r.set(u8(1), 0); break;
      case 139: r.set(u8(1), u8(2)); break;                                   // LoadConstUInt8
      case 140: r.set(u8(1), fn.readInt32LE(pc + 2)); break;                  // LoadConstInt
      case 144: r.set(u8(1), sid[fn.readUInt16LE(pc + 2)]); break;
      case 145: r.set(u8(1), sid[fn.readUInt32LE(pc + 2)]); break;
      case 30: {                                                              // Add (strings, or the loop counter)
        const [a, b] = [rd(u8(2)), rd(u8(3))];
        assert.equal(typeof a, typeof b, `Add of ${typeof a} and ${typeof b} at +${pc}`);
        r.set(u8(1), a + b);
        break;
      }
      case 133: r.set(u8(1), { kind: 'closure', index: fn.readUInt32LE(pc + 3) }); break; // CreateClosureLongIndex
      case 211: if (rd(u8(2)) === rd(u8(3))) next = pc + fn.readInt8(pc + 1); break;
      case 212: if (rd(u8(5)) === rd(u8(6))) next = pc + fn.readInt32LE(pc + 1); break;
      case 213: if (rd(u8(2)) !== rd(u8(3))) next = pc + fn.readInt8(pc + 1); break;
      case 214: if (rd(u8(5)) !== rd(u8(6))) next = pc + fn.readInt32LE(pc + 1); break;
      case 110: case 111: case 112: {                                         // Call2 / Call3 / Call4
        const callee = rd(u8(2));
        const args = [rd(u8(4)), rd(u8(5)), rd(u8(6))].slice(0, op - 109);
        let out;
        if (callee === i18n) {
          assert.equal(args[0].kind, 'object');
          assert.equal(args[0].shape, 347, '{id}');
          assert.ok(Object.hasOwn(messages, args[0].lit), `i18n message literal ${args[0].lit}`);
          out = messages[args[0].lit];
        } else if (callee.kind === 'push') {
          const self = rd(u8(3));
          assert.ok(Array.isArray(self));
          out = self.push(args[0]);
        } else if (callee.kind === 'charCodeAt') {
          out = rd(u8(3)).charCodeAt(args[0]);
        } else if (callee.name === 'fromCharCode') {
          out = String.fromCharCode(...args);
        } else if (callee.name === 'jsx' || callee.name === 'jsxs') {
          out = { element: args[0].name, props: args[1] };
        } else {
          assert.fail(`unexpected call at +${pc}`);
        }
        // SettingsSheet's frame reserves outgoing room for Call3 only: a Call4's extra argument
        // slot is r40 (the frame's last non-call register), which the call overwrites.
        if (op === 112) r.set(40, { kind: 'clobbered by Call4' });
        r.set(u8(1), out);
        break;
      }
      default: assert.fail(`unhandled opcode ${op} at +${pc}`);
    }
    pc = next;
  }
  return { group: rd(19), visited };
}

function loadOfficial() {
  const xapk = readZip(fs.readFileSync(XAPK));
  const base = readZip(entryBytes(xapk.entries.find(e => e.name === 'ai.x.grok.bot.apk')));
  return entryBytes(base.entries.find(e => e.name === 'assets/index.android.bundle'));
}

test('Settings menu: fail closed on anything but the rokbot.3 settings sheet', () => {
  const junk = Buffer.alloc(4096, 7);
  const res = applySettingsMenu(junk);
  assert.equal(res.applied, false);
  assert.equal(res.buffer, junk);
});

test('Settings menu: labels match the companion routing and the native page titles', () => {
  const boot = fs.readFileSync(path.join(SRC, 'RokBotBootstrap.java'), 'utf8');
  for (const key of ['models', 'update', 'avatar', 'suggestions']) {
    assert.ok(boot.includes(`matchesLabelOrCommaPrefix(s, "${MENU_LABELS.zh[key]}", false) || matchesLabelOrCommaPrefix(s, "${MENU_LABELS.en[key]}", true)`), key);
  }
  const row = '\\(paired && isInteractiveTarget && effW >= 240f && effH >= 40f && effH <= 140f\\)';
  assert.match(boot, new RegExp(`matchesModelSettingsLabel\\(s\\)\\) \\{\\s*//[^\\n]*\\n\\s*return ${row} \\? ModelsActivity\\.class`));
  assert.match(boot, new RegExp(`matchesSoftwareUpdateLabel\\(s\\)\\) \\{\\s*return ${row} \\? UpdateActivity\\.class`));
  assert.match(boot, new RegExp(`matchesAvatarStyleLabel\\(s\\)\\) \\{\\s*return ${row} \\? AvatarStyleActivity\\.class`));
  assert.match(boot, new RegExp(`matchesSuggestionsSettingsLabel\\(s\\)\\) \\{\\s*return ${row} \\? SuggestionsSettingsActivity\\.class`));
  // Same wording as the pages they open.
  assert.ok(fs.readFileSync(path.join(SRC, 'ModelsActivity.java'), 'utf8').includes(`Localize.t(this, "${MENU_LABELS.zh.models}", "${MENU_LABELS.en.models}")`));
  const titles = file => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.ok(src.includes('UiChrome.makeHeaderBar(this, Localize.t(this, TITLE_ZH, TITLE_EN)'), `${file} header uses its title`);
    return [src.match(/TITLE_ZH = "([^"]+)"/)[1], src.match(/TITLE_EN = "([^"]+)"/)[1]];
  };
  assert.deepEqual(titles('UpdateActivity.java'), [MENU_LABELS.zh.update, MENU_LABELS.en.update]);
  assert.deepEqual(titles('AvatarStyleActivity.java'), [MENU_LABELS.zh.avatar, MENU_LABELS.en.avatar]);
  assert.deepEqual(titles('SuggestionsSettingsActivity.java'), [MENU_LABELS.zh.suggestions, MENU_LABELS.en.suggestions]);
  // Only one configuration entry: no floating card on the settings sheet, no jump row in Model Settings.
  assert.ok(!fs.existsSync(path.join(SRC, 'SettingsSuggestionsOverlay.java')));
  assert.ok(!boot.includes('SettingsSuggestionsOverlay'));
  const models = fs.readFileSync(path.join(SRC, 'ModelsActivity.java'), 'utf8');
  assert.ok(!models.includes('SuggestionsSettingsActivity') && !models.includes('输入建议开关与常用语'));
  // The new page is declared in the patched manifest.
  assert.match(fs.readFileSync(path.join(PROJECT_ROOT, 'android/patchers/manifest.mjs'), 'utf8'),
    /upsertAppChild\('activity', 'dev\.rokbot\.nativeapp\.AvatarStyleActivity', \[\s*makeAttrStr\('name', 'dev\.rokbot\.nativeapp\.AvatarStyleActivity'\),\s*makeAttrBool\('exported', false\)/);
});

test('Settings menu: profile page keeps only avatar and name; updates and the icon style have their own pages', () => {
  const profile = fs.readFileSync(path.join(SRC, 'ProfileActivity.java'), 'utf8');
  assert.deepEqual([profile.match(/TITLE_ZH = "([^"]+)"/)[1], profile.match(/TITLE_EN = "([^"]+)"/)[1]], ['个人资料', 'Profile']);
  for (const gone of ['个人资料与偏好', '外观与语言', '内部增量更新', '检查增量更新', 'setPreferredLanguage', 'setThemePreference',
    'UpdateManager', 'update_feed_url_input']) {
    assert.ok(!profile.includes(gone), `profile page still has ${gone}`);
  }
  for (const kept of ['REQ_PICK_AVATAR', '"保存资料"', '"移除头像"', 'mNameInput', 'HostApiClient.updateProfile']) {
    assert.ok(profile.includes(kept), `profile page keeps ${kept}`);
  }
  // The incremental update moved to the App Updates page.
  const update = fs.readFileSync(path.join(SRC, 'UpdateActivity.java'), 'utf8');
  for (const moved of ['"增量更新"', 'update_feed_url_input', 'check_incremental_update_button', 'install_staged_update_button',
    'UpdateManager.checkAndStageAsync', 'Storage.setUpdateFeedUrl']) {
    assert.ok(update.includes(moved), `App Updates page has ${moved}`);
  }
  // The Bot icon style grid moved off the connection page.
  const pairing = fs.readFileSync(path.join(SRC, 'PairingActivity.java'), 'utf8');
  for (const gone of ['buildAvatarStyleCard', 'Bot 动态图标', 'RokBotAvatarManager.setStyle']) {
    assert.ok(!pairing.includes(gone), `connection page still has ${gone}`);
  }
  const style = fs.readFileSync(path.join(SRC, 'AvatarStyleActivity.java'), 'utf8');
  assert.ok(style.includes('RokBotAvatarManager.setStyle(this, styleId)'));
  assert.ok(style.includes('RokBotAvatarRenderer.STYLES'));
  assert.ok(style.includes('"avatar_style_" + info.id'));
  assert.ok(!/Bitmap|setImageResource|R\.drawable/.test(style), 'vector only (Canvas paths, RokBotAvatarView)');
  // Appearance & language: the official rows rule once paired.
  const chrome = fs.readFileSync(path.join(SRC, 'UiChrome.java'), 'utf8');
  assert.match(chrome, /Storage\.isPaired\(context\) \? observedAppearance\(context\) : null/);
  assert.match(boot(), /observeAppearanceRow\(activity, view, label\.trim\(\)\)/);
  assert.match(fs.readFileSync(path.join(SRC, 'Localize.java'), 'utf8'), /if \(paired && LANG_ZH\.equals\(observed\)\) return true;/);
  assert.match(pairing, /if \(Storage\.isPaired\(this\)\) \{\s*\/\/[^\n]*\n\s*return top;/);
});

const boot = () => fs.readFileSync(path.join(SRC, 'RokBotBootstrap.java'), 'utf8');

test('Settings menu: the connection page no longer repeats first-level entries', () => {
  const page = fs.readFileSync(path.join(SRC, 'PairingActivity.java'), 'utf8');
  const start = page.indexOf('private void buildConnectedUi()');
  const end = page.indexOf('private void confirmUnpair()');
  const body = page.slice(start, end);
  for (const gone of ['通知设置', '个人资料', '资料库', 'Bot 电脑', '"用量"', '模型设置', '检查更新', '回到 RokBot', '按最后消息排序', '"更多"',
    'makePillButton(this, Localize.t(this, "修改连接"', 'Bot 动态图标', 'avatar style', '外观', '应用更新']) {
    assert.ok(!body.includes(gone), `connection page still has ${gone}`);
  }
  for (const kept of ['连接历史', '诊断', '测速', '修改连接', '断开并解除配对']) {
    assert.ok(body.includes(kept), `connection page keeps ${kept}`);
  }
  assert.ok(!page.includes('runUpdateCheck'), 'in-page update flow removed (UpdateActivity owns it)');
});

/** DefineOwnInDenseArray writes (reg, index) of `count` instructions at SettingsSheet +rel, after NewArray at rel - 4. */
function arrayWrites(fn, rel, count) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const at = rel + 4 * k;
    assert.equal(fn[at], 90, `DefineOwnInDenseArray at +${at}`);
    out.push([fn[at + 2], fn[at + 3]]);
  }
  return out;
}

/** The array the writes build (NewArray size `n` at rel - 4), as register names. */
function builtArray(fn, rel, count) {
  assert.equal(fn[rel - 4], 8, 'NewArray');
  const size = fn.readUInt16LE(rel - 2);
  const arr = new Array(size);
  for (const [reg, i] of arrayWrites(fn, rel, count)) {
    assert.ok(i < size, `write ${i} inside NewArray(${size})`);
    arr[i] = `r${reg}`;
  }
  assert.equal(Object.keys(arr).length, size, 'no holes');
  return arr;
}

test('Settings menu: real 1.26.0 bundle gets the rokbot section, decoded and executed', { skip }, () => {
  const orig = loadOfficial();
  const plain = patchHermesBundleSafely(orig, { rebrandSettings: false });
  const conn = applyConnectionEntry(applySettingsRebrand(plain.buffer).buffer);
  assert.equal(conn.applied, true, conn.reason);
  const menu = applySettingsMenu(conn.buffer);
  assert.equal(menu.applied, true, menu.reason);
  assert.deepEqual(menu.edits, [
    'settings: account group without the Usage row',
    'settings: preferences group without Appearance and Language',
    'settings: rokbot section program in the dead link-group block',
    'settings: rokbot section rebuilt on every render (prologue over the memo check)',
    'settings: last label stored after the label builder',
    'settings: feedback group -> rokbot section',
    'settings: rokbot section right after the account group',
  ]);
  assert.ok(menu.size <= 3689 - 3001, `fits the dead block (${menu.size})`);
  assert.ok(footerOk(menu.buffer));
  assert.equal(applySettingsMenu(menu.buffer).applied, false, 'not applied twice');
  assert.equal(applySettingsMenu(applySettingsRebrand(plain.buffer).buffer).applied, false, 'needs the rokbot.3 row first');

  // Only SettingsSheet bytes change: the two shrunk groups, the dead block + the former memo check
  // +3001..+3721, the padding +3778..+3787, the jump at +3809, the sheet children +4224..+4271, and the footer.
  const ranges = [[1254, 1278], [2857, 2885], [3001, 3722], [3778, 3788], [3809, 3819], [4224, 4272]]
    .map(([a, b]) => [SETTINGS_OFFSET + a, SETTINGS_OFFSET + b]);
  for (let i = 0; i < conn.buffer.length - 20; i++) {
    if (conn.buffer[i] !== menu.buffer[i]) assert.ok(ranges.some(([a, b]) => i >= a && i < b), `stray change at ${i}`);
  }

  // The shipped unpaired bundle and the paired template both carry it.
  const shipped = patchHermesBundleSafely(orig);
  assert.equal(shipped.settingsRebrand.settingsMenu.applied, true, shipped.settingsRebrand.settingsMenu.reason);
  assert.ok(shipped.buffer.equals(menu.buffer));
  const paired = patchHermesBundleSafely(orig, { host: 'http://127.0.0.1:18080', token: 'tok-abc' });
  const fnAt = buf => buf.subarray(SETTINGS_OFFSET, SETTINGS_OFFSET + SETTINGS_SIZE);
  assert.ok(fnAt(paired.gatewayTemplateHbc).equals(fnAt(menu.buffer)), 'paired template: same SettingsSheet');

  const fn = fnAt(menu.buffer);
  // Account group: AccountRow (r14) + Manage / Passkeys / Vault, no Usage (r36).
  assert.deepEqual(builtArray(fn, 1258, 5), ['r14', 'r35', 'r34', 'r28']);
  // Preferences group: Notifications (r39), Sound (r23), Haptics (r37), DataSharing (r36);
  // no Appearance (r19) / Language (r10).
  assert.deepEqual(builtArray(fn, 2861, 6), ['r39', 'r23', 'r37', 'r36']);
  // Sheet children: the rokbot section (r9, from the group at +3847) right after the account group (r15).
  const sheet = builtArray(fn, 4216, 17);
  assert.equal(sheet.length, 17);
  assert.deepEqual(sheet.slice(0, 5), ['r30', 'r29', 'r15', 'r9', 'r28']);
  assert.equal(sheet.indexOf('r9'), SHEET_CHILD_INDEX);
  assert.deepEqual([...sheet].sort(), ['r30', 'r29', 'r15', 'r28', 'r27', 'r14', 'r12', 'r26', 'r25', 'r24', 'r11', 'r23', 'r10',
    'r9', 'r8', 'r22', 'r21'].sort(), 'every official child kept once');
  assert.deepEqual([...fn.subarray(3847, 3850)], [16, 9, 19], 'Mov r9, r19 (the group)');

  // Execute the feedback-group path for each language the rokbot.3 label can produce.
  const sid = new Proxy({}, {
    get: (_, id) => {
      const n = Number(id);
      return { 44: 'String', 87: 'charCodeAt', 182: 'jsx', 183: 'jsxs', 12628: 'fromCharCode', 13382: ' ', 14250: '&', 38602: 'Diagnostics',
        37606: 'InsetGroup', 40009: 'InsetGroupNavRow', 75365: 'rokbot', 11408: 'Icon', 65679: 'Style', 11627: 'Settings',
        14015: 'App', 13238: 'string', 214: 'push' }[n];
    },
  });
  const memo = [];
  memo[19] = { element: 'UsageGroup' };
  memo[60] = { element: 'InsetGroupNavRow', label: 'Appearance' };
  memo[71] = { element: 'InsetGroupNavRow', label: 'Language' };
  memo[103] = 'stale deps';
  memo[106] = { element: 'stale group' };
  // The {id:'8J32PY'} literal ("Suggestions" / "建议") the English Input Suggestions label uses.
  assert.equal(SUGGESTIONS_MESSAGE.literal, 382263);
  const cases = [
    ['连接', '连接与诊断', MENU_LABELS.zh, '建议'],
    ['連線', '连接与诊断', MENU_LABELS.zh, '建議'],
    ['Connection', 'Connection & Diagnostics', MENU_LABELS.en, 'Suggestions'],
    ['Verbindung', 'Verbindung & Diagnostics', { ...MENU_LABELS.en, suggestions: 'Input Vorschläge' }, 'Vorschläge'],
  ];
  assert.deepEqual(MENU_ORDER, ['avatar', 'appearance', 'language', 'usage', 'models', 'suggestions', 'connection', 'update']);
  // The former memo check (+3689) is the prologue now: the memoized group (slot 106) is never reused.
  assert.ok(!fn.subarray(3689, 3722).includes(Buffer.from([0x5e, 0x09, 0x07, 0x6a])), 'no GetByIndex r9, r7, 106 left');
  for (const [i18nLabel, connLabel, labels, suggestionsWord] of cases) {
    const messages = { [EXY_LITERAL]: i18nLabel, [SUGGESTIONS_MESSAGE.literal]: suggestionsWord };
    const { group, visited } = runFeedbackGroup(fn, messages, sid, memo);
    assert.ok(visited.has(3722) && visited.has(3788) && visited.has(3809), 'prologue, rokbot.3 row and tail all run');
    assert.notEqual(group, memo[106]);
    assert.equal(group.element, 'InsetGroup');
    assert.equal(group.props.shape, 10320, '{header, children}');
    assert.equal(group.props.slots[0], 'rokbot');
    const rows = group.props.slots[1];
    assert.equal(rows.length, 8);
    assert.equal(rows[1], memo[60], 'official Appearance row');
    assert.equal(rows[2], memo[71], 'official Language row');
    assert.equal(rows[3], memo[19], 'official Usage row');
    const native = [0, 4, 5, 6, 7].map(i => rows[i]);
    for (const row of native) {
      assert.equal(row.element, 'InsetGroupNavRow');
      assert.equal(row.props.shape, 11202, '{label, onPress}: chevron row like the official ones');
      assert.equal(row.props.slots[1].kind, 'closure');
    }
    assert.deepEqual(native.map(row => row.props.slots[0]),
      [labels.avatar, labels.models, labels.suggestions, connLabel, labels.update], i18nLabel);
    // One shared onPress: the rokbot.3 no-op.
    assert.ok(native.every(row => row.props.slots[1] === native[0].props.slots[1]));
  }
});

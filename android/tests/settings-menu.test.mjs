// rokbot.5: the rokbot entries are first-level settings rows. The former "Send Feedback" group
// (rokbot.3: one "Connection & Diagnostics" row) becomes a titled section of native
// InsetGroupNavRow rows built in the dead link-group block (hermes-settings.mjs
// applySettingsMenu); the companion opens the native page for each label.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { patchHermesBundleSafely } from '../patchers/hermes.mjs';
import {
  MENU_LABELS, applyConnectionEntry, applySettingsMenu, applySettingsRebrand,
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

// HBC v98 sizes of every opcode the rokbot.3 + rokbot.5 feedback-group path executes.
const SIZE = {
  2: 10, 8: 4, 30: 4, 59: 4, 61: 2, 68: 5, 69: 6, 72: 6, 82: 4, 90: 4, 110: 5, 111: 6, 133: 7, 139: 3, 140: 6,
  1: 6, 144: 4, 145: 6, 147: 2, 148: 2, 151: 2, 175: 5, 176: 3, 211: 4, 212: 7,
};

/**
 * Executes SettingsSheet from +3722 (feedback group) to +3819 (memo store) symbolically.
 * `connectionLabel` is what i18n._({id:'exyUec'}) returns. Returns the built group.
 */
function runFeedbackGroup(fn, connectionLabel, sid) {
  const r = new Map();
  const i18n = { kind: 'i18n' };
  r.set(31, i18n);
  r.set(1, undefined);
  r.set(6, { kind: 'env' });
  const visited = new Set();
  let pc = 3722;
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
      case 175: next = pc + fn.readInt32LE(pc + 1); break;                    // JmpLong
      case 59: r.set(u8(1), { kind: 'module', slot: u8(3) }); break;          // LoadFromEnvironment
      case 68: {                                                              // GetByIdShort
        const name = sid[u8(4)];
        const obj = rd(u8(2));
        r.set(u8(1), name === 'charCodeAt' ? { kind: 'charCodeAt' } : { kind: 'fn', name, of: obj });
        break;
      }
      case 69: case 72: {                                                     // GetById / TryGetById
        const name = sid[fn.readUInt16LE(pc + 4)];
        r.set(u8(1), { kind: 'fn', name });
        break;
      }
      case 61: r.set(u8(1), { kind: 'global' }); break;
      case 2: r.set(u8(1), { kind: 'object', shape: fn.readUInt32LE(pc + 2), slots: [] }); break; // NewObjectWithBufferLong
      case 1: r.set(u8(1), { kind: 'object', shape: fn.readUInt16LE(pc + 2), slots: [] }); break;
      case 82: rd(u8(1)).slots[u8(3)] = rd(u8(2)); break;                     // PutOwnBySlotIdx
      case 8: r.set(u8(1), []); break;                                        // NewArray
      case 90: rd(u8(1))[u8(3)] = rd(u8(2)); break;                           // DefineOwnInDenseArray
      case 151: r.set(u8(1), 0); break;
      case 139: r.set(u8(1), u8(2)); break;                                   // LoadConstUInt8
      case 140: r.set(u8(1), fn.readInt32LE(pc + 2)); break;                  // LoadConstInt
      case 144: r.set(u8(1), sid[fn.readUInt16LE(pc + 2)]); break;
      case 145: r.set(u8(1), sid[fn.readUInt32LE(pc + 2)]); break;
      case 30: r.set(u8(1), rd(u8(2)) + rd(u8(3))); break;                    // Add (strings only here)
      case 133: r.set(u8(1), { kind: 'closure', index: fn.readUInt32LE(pc + 3) }); break; // CreateClosureLongIndex
      case 211: if (rd(u8(2)) === rd(u8(3))) next = pc + fn.readInt8(pc + 1); break;
      case 212: if (rd(u8(5)) === rd(u8(6))) next = pc + fn.readInt32LE(pc + 1); break;
      case 110: case 111: {                                                   // Call2 / Call3
        const callee = rd(u8(2));
        const args = op === 110 ? [rd(u8(4))] : [rd(u8(4)), rd(u8(5))];
        let out;
        if (callee === i18n) {
          assert.equal(args[0].kind, 'object');
          out = connectionLabel;
        } else if (callee.kind === 'charCodeAt') {
          out = rd(u8(3)).charCodeAt(args[0]);
        } else if (callee.name === 'fromCharCode') {
          out = String.fromCharCode(...args);
        } else if (callee.name === 'jsx' || callee.name === 'jsxs') {
          out = { element: args[0].name, props: args[1] };
        } else {
          assert.fail(`unexpected call at +${pc}`);
        }
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
  assert.ok(boot.includes(`matchesLabelOrCommaPrefix(s, "${MENU_LABELS.zh.models}", false) || matchesLabelOrCommaPrefix(s, "${MENU_LABELS.en.models}", true)`));
  assert.ok(boot.includes(`matchesLabelOrCommaPrefix(s, "${MENU_LABELS.zh.update}", false) || matchesLabelOrCommaPrefix(s, "${MENU_LABELS.en.update}", true)`));
  assert.match(boot, /matchesModelSettingsLabel\(s\)\) \{\s*\/\/[^\n]*\n\s*return \(paired && isInteractiveTarget && effW >= 240f && effH >= 40f && effH <= 140f\) \? ModelsActivity\.class/);
  assert.match(boot, /matchesSoftwareUpdateLabel\(s\)\) \{\s*return \(paired && isInteractiveTarget && effW >= 240f && effH >= 40f && effH <= 140f\) \? UpdateActivity\.class/);
  // Same wording as the pages they open.
  assert.ok(fs.readFileSync(path.join(SRC, 'ModelsActivity.java'), 'utf8').includes(`Localize.t(this, "${MENU_LABELS.zh.models}", "${MENU_LABELS.en.models}")`));
  assert.ok(fs.readFileSync(path.join(SRC, 'UpdateActivity.java'), 'utf8').includes(`Localize.t(this, "${MENU_LABELS.zh.update}", "${MENU_LABELS.en.update}")`));
});

test('Settings menu: the connection page no longer repeats first-level entries', () => {
  const page = fs.readFileSync(path.join(SRC, 'PairingActivity.java'), 'utf8');
  const start = page.indexOf('private void buildConnectedUi()');
  const end = page.indexOf('private void confirmUnpair()');
  const body = page.slice(start, end);
  for (const gone of ['通知设置', '个人资料', '资料库', 'Bot 电脑', '"用量"', '模型设置', '检查更新', '回到 RokBot', '按最后消息排序', '"更多"', 'makePillButton(this, Localize.t(this, "修改连接"']) {
    assert.ok(!body.includes(gone), `connection page still has ${gone}`);
  }
  for (const kept of ['连接历史', '诊断', '测速', '修改连接', '断开并解除配对']) {
    assert.ok(body.includes(kept), `connection page keeps ${kept}`);
  }
  assert.ok(!page.includes('runUpdateCheck'), 'in-page update flow removed (UpdateActivity owns it)');
});

test('Settings menu: real 1.26.0 bundle gets the rokbot section, decoded and executed', { skip }, () => {
  const orig = loadOfficial();
  const plain = patchHermesBundleSafely(orig, { rebrandSettings: false });
  const conn = applyConnectionEntry(applySettingsRebrand(plain.buffer).buffer);
  assert.equal(conn.applied, true, conn.reason);
  const menu = applySettingsMenu(conn.buffer);
  assert.equal(menu.applied, true, menu.reason);
  assert.deepEqual(menu.edits, ['settings: rokbot section rows in the dead link-group block', 'settings: feedback group -> rokbot section']);
  assert.ok(menu.size <= 3689 - 3155, `fits the cave (${menu.size})`);
  assert.ok(footerOk(menu.buffer));
  assert.equal(applySettingsMenu(menu.buffer).applied, false, 'not applied twice');
  assert.equal(applySettingsMenu(applySettingsRebrand(plain.buffer).buffer).applied, false, 'needs the rokbot.3 row first');

  // Only SettingsSheet bytes (+3155..+3818) and the footer change.
  const lo = SETTINGS_OFFSET + 3155;
  const hi = SETTINGS_OFFSET + 3819;
  for (let i = 0; i < conn.buffer.length - 20; i++) {
    if (conn.buffer[i] !== menu.buffer[i]) assert.ok(i >= lo && i < hi, `stray change at ${i}`);
  }

  // The shipped unpaired bundle and the paired template both carry it.
  const shipped = patchHermesBundleSafely(orig);
  assert.equal(shipped.settingsRebrand.settingsMenu.applied, true, shipped.settingsRebrand.settingsMenu.reason);
  assert.ok(shipped.buffer.equals(menu.buffer));
  const paired = patchHermesBundleSafely(orig, { host: 'http://127.0.0.1:18080', token: 'tok-abc' });
  assert.ok(paired.gatewayTemplateHbc.subarray(lo, hi).equals(menu.buffer.subarray(lo, hi)));

  // Execute the feedback-group path for each language the rokbot.3 label can produce.
  const fn = menu.buffer.subarray(SETTINGS_OFFSET, SETTINGS_OFFSET + SETTINGS_SIZE);
  const sid = new Proxy({}, {
    get: (_, id) => {
      const n = Number(id);
      return { 44: 'String', 87: 'charCodeAt', 182: 'jsx', 183: 'jsxs', 12628: 'fromCharCode', 13382: ' ', 14250: '&', 38602: 'Diagnostics',
        37606: 'InsetGroup', 40009: 'InsetGroupNavRow', 75365: 'rokbot' }[n];
    },
  });
  const cases = [
    ['连接', '连接与诊断', MENU_LABELS.zh],
    ['連線', '连接与诊断', MENU_LABELS.zh],
    ['Connection', 'Connection & Diagnostics', MENU_LABELS.en],
    ['Verbindung', 'Verbindung & Diagnostics', MENU_LABELS.en],
  ];
  for (const [i18nLabel, connLabel, labels] of cases) {
    const { group } = runFeedbackGroup(fn, i18nLabel, sid);
    assert.equal(group.element, 'InsetGroup');
    assert.equal(group.props.shape, 10320, '{header, children}');
    assert.equal(group.props.slots[0], 'rokbot');
    const rows = group.props.slots[1];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.element, 'InsetGroupNavRow');
      assert.equal(row.props.shape, 11202, '{label, onPress}: chevron row like the official ones');
      assert.equal(row.props.slots[1].kind, 'closure');
    }
    assert.deepEqual(rows.map(row => row.props.slots[0]), [connLabel, labels.models, labels.update], i18nLabel);
    // One shared onPress: the rokbot.3 no-op.
    assert.ok(rows.every(row => row.props.slots[1] === rows[0].props.slots[1]));
  }
});

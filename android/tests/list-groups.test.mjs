// rokbot.4: "sort by last message" groups the Bot list (Needs attention -> Unread -> Read) with
// section headers, built from in-place edits of the pinned 1.26.0 bundle (hermes-settings.mjs
// listGroupEdits). The edits only exist in gateway-template.json; the companion applies them
// with the ordering edits and one titles set (HermesPatcher.applyListArrangement).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { synthesizePinnedResources } from '../patchers/hermes.mjs';
import { LIST_GROUP_TITLES, applyListSortEdits, listGroupEdits, rebrandPinnedHermesResources } from '../patchers/hermes-settings.mjs';
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

// Instruction sizes (HBC v98 BytecodeList.def) of every opcode the rewritten bodies use.
const SIZE = {
  2: 10, 8: 4, 23: 4, 30: 4, 52: 3, 59: 4, 61: 2, 68: 5, 69: 6, 72: 6, 82: 4, 90: 4, 93: 4, 108: 4, 110: 5, 111: 6, 112: 7,
  118: 2, 126: 1, 132: 5, 137: 3, 140: 6, 144: 4, 145: 6, 147: 2, 148: 2, 151: 2, 174: 2, 176: 3, 180: 3, 199: 4, 209: 4,
};
const JUMPS = new Set([174, 176, 180, 199, 209]);
const CACHED = new Set([68, 69, 72]);

/** Decodes a rewritten body: known opcodes only, jumps on boundaries, caches off, ends in Ret + padding. */
function decodeBody(bytes) {
  const starts = new Set();
  const jumps = [];
  const ops = [];
  let pc = 0;
  while (pc < bytes.length) {
    const op = bytes[pc];
    if (op === 126 && bytes.subarray(pc).every(b => b === 126)) break;   // padding
    assert.ok(SIZE[op], `unknown opcode ${op} at +${pc}`);
    starts.add(pc);
    ops.push({ pc, op });
    if (JUMPS.has(op)) jumps.push({ pc, to: pc + bytes.readInt8(pc + 1) });
    if (CACHED.has(op)) assert.equal(bytes[pc + 3], 255, `property cache disabled at +${pc}`);
    pc += SIZE[op];
  }
  assert.ok(pc <= bytes.length);
  for (const j of jumps) assert.ok(starts.has(j.to), `jump at +${j.pc} lands inside an instruction (+${j.to})`);
  assert.equal(ops[ops.length - 1].op, 118, 'ends with Ret');
  return ops;
}

function loadTemplate() {
  const xapk = readZip(fs.readFileSync(XAPK));
  const base = readZip(entryBytes(xapk.entries.find(e => e.name === 'ai.x.grok.bot.apk')));
  const orig = entryBytes(base.entries.find(e => e.name === 'assets/index.android.bundle'));
  const out = rebrandPinnedHermesResources(synthesizePinnedResources(orig));
  return { hbc: out.gatewayTemplateHbc, meta: JSON.parse(out.gatewayTemplateJson.toString('utf8')), report: out.settingsRebrand };
}

test('List groups: fail closed on anything but the pinned template', () => {
  assert.equal(listGroupEdits(Buffer.alloc(4096, 3)), null);
});

test('List groups: companion wiring (titles language, fallback, Web wording)', () => {
  assert.deepEqual(LIST_GROUP_TITLES.zh, ['待处理', '未读', '已读']);
  assert.deepEqual(LIST_GROUP_TITLES.en, ['Needs attention', 'Unread', 'Read']);
  // Same wording as the Web / desktop arrangement.
  const web = fs.readFileSync(path.join(PROJECT_ROOT, 'windows/tools/desktop-recipes/extensions/list-arrangement.js'), 'utf8');
  for (const [zh, en] of LIST_GROUP_TITLES.zh.map((z, i) => [z, LIST_GROUP_TITLES.en[i]])) {
    assert.ok(web.includes(`zh: '${zh}', en: '${en}'`), `${zh} / ${en} as on the Web`);
  }
  const hp = fs.readFileSync(path.join(SRC, 'HermesPatcher.java'), 'utf8');
  assert.match(hp, /titles\.optJSONArray\(titles\.has\(titleLanguage\) \? titleLanguage : "en"\)/);
});

test('List groups: pinned template publishes order + group edits that decode cleanly', { skip }, () => {
  const { hbc, meta, report } = loadTemplate();
  assert.equal(report.listSort.available, true);
  assert.equal(report.listSort.groups, true);
  const sort = meta.listSort;
  assert.equal(sort.field, 'lastMessageAt');
  assert.equal(sort.edits.length, 4);
  assert.equal(sort.groups.edits.length, 3);
  assert.deepEqual(Object.keys(sort.groups.titles).sort(), ['en', 'zh']);

  const all = [...sort.edits, ...sort.groups.edits, ...sort.groups.titles.zh];
  const ranges = all.map(e => [e.offset, e.original.length / 2]);
  for (const e of [...all, ...sort.groups.titles.en]) {
    assert.equal(typeof e.offset, 'number');
    assert.equal(e.original.length, e.patched.length);
    assert.equal(hbc.subarray(e.offset, e.offset + e.original.length / 2).toString('hex'), e.original, `anchor at ${e.offset}`);
    assert.ok(e.offset + e.original.length / 2 <= hbc.length - 20, 'never the footer');
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const [a, la] = ranges[i], [b, lb] = ranges[j];
      assert.ok(a + la <= b || b + lb <= a, `edits ${i} and ${j} overlap`);
    }
  }
  // zh and en builders rewrite the same function.
  assert.equal(sort.groups.titles.zh[0].offset, sort.groups.titles.en[0].offset);

  for (const lang of ['zh', 'en']) {
    const out = applyListSortEdits(hbc, [...sort.edits, ...sort.groups.edits, ...sort.groups.titles[lang]]);
    assert.ok(footerOk(out));
    // Already applied: the anchors no longer match.
    assert.throws(() => applyListSortEdits(out, sort.groups.edits));
    assert.equal(listGroupEdits(out), null);
  }

  // Whole-body rewrites: recencyOf, the section filter and the builder.
  const body = e => Buffer.from(e.patched, 'hex');
  const recency = decodeBody(body(sort.edits[0]));
  assert.ok(recency.length < 20, 'recencyOf stays a small timestamp function');
  assert.ok(!recency.some(o => o.op === 30), 'no group offset is added to the row time');
  const filter = decodeBody(body(sort.groups.edits[1]));
  assert.ok(filter.some(o => o.op === 93), 'pendingAction is read by value');
  assert.equal(filter[filter.length - 2].op, 23, 'StrictEq group id vs section id');
  for (const lang of ['zh', 'en']) {
    const builder = body(sort.groups.titles[lang][0]);
    const ops = decodeBody(builder);
    assert.equal(ops[1].op, 180, 'JmpUndefined: rendered as a component it returns null');
    const codes = ops.filter(o => o.op === 140).map(o => builder.readInt32LE(o.pc + 2));
    assert.equal(String.fromCharCode(...codes), LIST_GROUP_TITLES[lang].join(''), `${lang} titles`);
  }
  // resolve prologue: CreateClosure + Call1 + the original collapsedSectionIds read + LoadConstUndefined r1.
  const prologue = body(sort.groups.edits[0]);
  const pOps = [];
  for (let pc = 0; pc < prologue.length && prologue[pc] !== 126;) { pOps.push(prologue[pc]); pc += SIZE[prologue[pc]]; }
  assert.deepEqual(pOps, [132, 108, 69, 147]);
  // Hide-empty filter: the isSynthetic test becomes padding.
  assert.match(sort.groups.edits[2].patched, /^(7e)+$/);
});

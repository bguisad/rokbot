import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { patchHermesBundleSafely, synthesizeHermesBytecode } from '../patchers/hermes.mjs';
import {
  applyConnectionEntry, applyHomeBarBell, applyListSortEdits, applySettingsRebrand, listSortEdits, rebrandPinnedHermesResources,
} from '../patchers/hermes-settings.mjs';
import { entryBytes, readZip } from '../patchers/signing.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

function loadOfficialBundle() {
  const xapk = readZip(fs.readFileSync(XAPK));
  const base = readZip(entryBytes(xapk.entries.find(e => e.name === 'ai.x.grok.bot.apk')));
  return entryBytes(base.entries.find(e => e.name === 'assets/index.android.bundle'));
}

function diffRanges(a, b) {
  assert.equal(a.length, b.length);
  const ranges = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const last = ranges[ranges.length - 1];
    if (last && last[1] >= i - 4) last[1] = i;
    else ranges.push([i, i]);
  }
  return ranges.map(([s, e]) => [s, e - s + 1]);
}

const footerOk = buf =>
  buf.subarray(buf.length - 20).equals(crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest());

test('Settings rebrand: non-HBC input is returned untouched (fail closed)', () => {
  const junk = Buffer.alloc(4096, 0x11);
  const res = applySettingsRebrand(junk);
  assert.equal(res.applied, false);
  assert.equal(res.buffer, junk);
  const pinned = { unpairedHbc: junk, gatewayTemplateHbc: junk, gatewayTemplateJson: Buffer.from('{}'), gatewayMeta: {} };
  const out = rebrandPinnedHermesResources(pinned);
  assert.equal(out.settingsRebrand.applied, false);
  assert.equal(out.unpairedHbc, junk);
  assert.equal(out.gatewayTemplateHbc, junk);
});

test(
  'Settings rebrand: real 1.26.0 bundle drops links/feedback, renames About title to rokbot, keeps layout',
  { skip: !XAPK && 'Official grok-bot-1.26.0.xapk not found; set ROKBOT_ANDROID_TEST_XAPK' },
  () => {
    const orig = loadOfficialBundle();
    const plain = patchHermesBundleSafely(orig, { rebrandSettings: false });
    const unpaired = patchHermesBundleSafely(orig);
    assert.equal(plain.mode, 'bytepatch-unpaired');
    assert.equal(unpaired.mode, 'bytepatch-unpaired');
    assert.equal(unpaired.settingsRebrand.applied, true, unpaired.settingsRebrand.reason);
    assert.equal(unpaired.settingsRebrand.edits.length, 5);
    assert.ok(footerOk(unpaired.buffer));

    // The rebrand alone: only the five in-place edits + footer SHA-1 differ from the plain recipe output.
    const rebrandOnly = applySettingsRebrand(plain.buffer);
    assert.equal(rebrandOnly.applied, true, rebrandOnly.reason);
    // rokbot.3: the shipped unpaired bundle is the rebrand + the Connection & Diagnostics row.
    const withConnection = applyConnectionEntry(rebrandOnly.buffer);
    assert.equal(withConnection.applied, true, withConnection.reason);
    assert.ok(unpaired.buffer.equals(withConnection.buffer), 'unpaired = rebrand + connection entry (no header bell)');
    assert.equal(unpaired.settingsRebrand.connectionEntry.applied, true);
    const footer = unpaired.buffer.length - 20;
    assert.deepEqual(diffRanges(plain.buffer, rebrandOnly.buffer), [
      [1556812, 3], // string table entry '6YgCQb' -> "rokbot" bytes
      [21090221, 1], // AboutBlock title literal tag: ShortString x4 -> ShortString x3
      [21090228, 5], // ... + LongString(6YgCQb) for children
      [30976710, 8], // SettingsSheet +2993: LoadConstNull r10; JmpLong +694; AsyncBreakCheck
      [30977443, 1], // SettingsSheet +3724: JmpTrue r32 -> r31
      [30981672, 1], // AboutBlock +1194: JStrictEqual r43, r43
      [footer, 20],
    ]);
    assert.deepEqual([...unpaired.buffer.subarray(30976710, 30976718)], [0x94, 0x0a, 0xaf, 0xb6, 0x02, 0x00, 0x00, 0x7e]);
    assert.deepEqual([...rebrandOnly.buffer.subarray(30977441, 30977444)], [0xb0, 0x5f, 0x1f]);
    // applyConnectionEntry builds that group again (JmpTrue on r19, null) for "Connection & Diagnostics".
    assert.deepEqual([...unpaired.buffer.subarray(30977441, 30977444)], [0xb0, 0x5f, 0x13]);
    assert.deepEqual([...unpaired.buffer.subarray(30981669, 30981673)], [0xd3, 0x47, 0x2b, 0x2b]);

    // The donor string now reads "rokbot" (6 latin1 bytes inside "grokbot://mcp/oauth/callback").
    const word = unpaired.buffer.readUInt32LE(1556812 - (1556812 % 4));
    assert.equal(word & 1, 0);
    assert.equal(word >>> 24, 6);

    // Re-applying is rejected because the anchors no longer match.
    assert.equal(applySettingsRebrand(unpaired.buffer).applied, false);
    assert.equal(applyConnectionEntry(unpaired.buffer).applied, false);

    // Paired mode: the template carries the same edits and the JSON pin follows the patched template.
    const paired = patchHermesBundleSafely(orig, { host: 'http://127.0.0.1:18080', token: 'tok-abc' });
    assert.equal(paired.mode, 'bytepatch-hbc-synthesized');
    assert.equal(paired.settingsRebrand.applied, true);
    const meta = JSON.parse(paired.gatewayTemplateJson.toString('utf8'));
    assert.equal(meta.templateSha256, crypto.createHash('sha256').update(paired.gatewayTemplateHbc).digest('hex'));
    assert.notEqual(meta.templateSha256, JSON.parse(plain.gatewayTemplateJson.toString('utf8')).templateSha256);
    assert.equal(meta.bodyOffset, 38303476);
    assert.equal(meta.bodyLengthOffset, 38328844);
    assert.ok(footerOk(paired.gatewayTemplateHbc));
    assert.ok(footerOk(paired.buffer));
    for (const buf of [paired.buffer, paired.gatewayTemplateHbc]) {
      assert.deepEqual([...buf.subarray(30976710, 30976718)], [0x94, 0x0a, 0xaf, 0xb6, 0x02, 0x00, 0x00, 0x7e]);
      assert.deepEqual([...buf.subarray(30981669, 30981673)], [0xd3, 0x47, 0x2b, 0x2b]);
    }
    // rokbot.3b header bell: only the template carries it; exactly SearchButton + HomeScreen +7489 change.
    assert.equal(paired.settingsRebrand.homeBell.applied, true, paired.settingsRebrand.homeBell.reason);
    assert.equal(paired.settingsRebrand.homeBell.edits.length, 2);
    const templateConn = applyConnectionEntry(applySettingsRebrand(plain.gatewayTemplateHbc).buffer).buffer;
    const bellRanges = diffRanges(templateConn, paired.gatewayTemplateHbc);
    assert.equal(bellRanges.length, 3, JSON.stringify(bellRanges));
    assert.deepEqual(bellRanges[2], [paired.gatewayTemplateHbc.length - 20, 20]);
    assert.ok(bellRanges[0][1] <= 36 && bellRanges[1][1] <= 263, JSON.stringify(bellRanges));
    assert.ok(applyHomeBarBell(templateConn).buffer.equals(paired.gatewayTemplateHbc));
    assert.equal(applyHomeBarBell(paired.gatewayTemplateHbc).applied, false, 'not applied twice');
    assert.equal(applyHomeBarBell(rebrandOnly.buffer).applied, false, 'needs the connection entry no-op first');
    // listSort in the JSON (rokbot.4): recencyOf rewrite + bell label + tone + copper colour, all
    // verified on device; the titled groups ride along in listSort.groups (list-groups.test.mjs).
    assert.deepEqual(meta.listSort.edits.length, 4);
    assert.deepEqual(listSortEdits(paired.gatewayTemplateHbc).map(e => e.label), [
      'recencyOf: last message, else last activity', 'home bell: label sort -> sorted', 'home bell: no theme tone', 'home bell: icon colour -> copper',
    ]);
    assert.ok(meta.listSort.groups && meta.listSort.groups.edits.length === 3);
    const sorted = applyListSortEdits(paired.gatewayTemplateHbc, meta.listSort.edits);
    assert.ok(footerOk(sorted));
    const inEdit = i => i >= sorted.length - 20 || meta.listSort.edits.some(e => i >= e.offset && i < e.offset + e.original.length / 2);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== paired.gatewayTemplateHbc[i]) assert.ok(inEdit(i), `stray change at ${i}`);
    }
    const strAt = (buf, off) => buf.readUInt16LE(off + 2);
    for (const e of meta.listSort.edits.slice(1)) {
      assert.equal(sorted.subarray(e.offset, e.offset + 4).toString('hex'), e.patched);
      assert.equal(paired.gatewayTemplateHbc.subarray(e.offset, e.offset + 4).toString('hex'), e.original);
    }
    assert.ok(strAt(sorted, meta.listSort.edits[1].offset) !== strAt(paired.gatewayTemplateHbc, meta.listSort.edits[1].offset));

    // Runtime pairing (HermesPatcher.java equivalent) still synthesizes from the rebranded template.
    const runtime = synthesizeHermesBytecode(paired.gatewayTemplateHbc, meta, 'http://10.0.2.2:18080', 'tok');
    assert.ok(footerOk(runtime));
    assert.deepEqual([...runtime.subarray(30976710, 30976718)], [0x94, 0x0a, 0xaf, 0xb6, 0x02, 0x00, 0x00, 0x7e]);
  }
);

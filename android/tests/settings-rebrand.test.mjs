import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { patchHermesBundleSafely, synthesizeHermesBytecode } from '../patchers/hermes.mjs';
import { applySettingsRebrand, rebrandPinnedHermesResources } from '../patchers/hermes-settings.mjs';
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

    // Only the five in-place edits + footer SHA-1 differ from the plain recipe output.
    const footer = unpaired.buffer.length - 20;
    assert.deepEqual(diffRanges(plain.buffer, unpaired.buffer), [
      [1556812, 3], // string table entry '6YgCQb' -> "rokbot" bytes
      [21090221, 1], // AboutBlock title literal tag: ShortString x4 -> ShortString x3
      [21090228, 5], // ... + LongString(6YgCQb) for children
      [30976710, 8], // SettingsSheet +2993: LoadConstNull r10; JmpLong +694; AsyncBreakCheck
      [30977443, 1], // SettingsSheet +3724: JmpTrue r32 -> r31
      [30981672, 1], // AboutBlock +1194: JStrictEqual r43, r43
      [footer, 20],
    ]);
    assert.deepEqual([...unpaired.buffer.subarray(30976710, 30976718)], [0x94, 0x0a, 0xaf, 0xb6, 0x02, 0x00, 0x00, 0x7e]);
    assert.deepEqual([...unpaired.buffer.subarray(30977441, 30977444)], [0xb0, 0x5f, 0x1f]);
    assert.deepEqual([...unpaired.buffer.subarray(30981669, 30981673)], [0xd3, 0x47, 0x2b, 0x2b]);

    // The donor string now reads "rokbot" (6 latin1 bytes inside "grokbot://mcp/oauth/callback").
    const word = unpaired.buffer.readUInt32LE(1556812 - (1556812 % 4));
    assert.equal(word & 1, 0);
    assert.equal(word >>> 24, 6);

    // Re-applying is rejected because the anchors no longer match.
    assert.equal(applySettingsRebrand(unpaired.buffer).applied, false);

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
    // Runtime pairing (HermesPatcher.java equivalent) still synthesizes from the rebranded template.
    const runtime = synthesizeHermesBytecode(paired.gatewayTemplateHbc, meta, 'http://10.0.2.2:18080', 'tok');
    assert.ok(footerOk(runtime));
    assert.deepEqual([...runtime.subarray(30976710, 30976718)], [0x94, 0x0a, 0xaf, 0xb6, 0x02, 0x00, 0x00, 0x7e]);
  }
);

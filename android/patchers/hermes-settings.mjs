// In-place RokBot rebrand of the React Native settings sheet inside the pinned
// Hermes (HBC v98) bundle of the official Android 1.26.0 (3212) build.
//
// Every edit keeps the file layout byte-for-byte identical in size: no string,
// function or literal is added, so all absolute offsets used by the pinned
// gateway-template recipe (bodyOffset, bodyLengthOffset, tail-patched
// functions) stay valid. Each edit first verifies the exact original bytes and
// is skipped entirely (fail closed) when anything differs.
//
// Edits (offsets are relative to the start of each function's bytecode):
//   SettingsSheet +2993  LoadConstNull r10; JmpLong -> +3689; AsyncBreakCheck
//                        Skips the "Help Center / Privacy Policy / Terms of
//                        Service / Grok Bot Terms" link group and its
//                        "Teams, Enterprise or other plan" footer note; the
//                        group child becomes null.
//   SettingsSheet +3724  JmpTrue r32 -> JmpTrue r31
//                        r32 is the feedbackKillSwitch gate, r31 is i18n._
//                        (always a function), so "Send Feedback" is never built.
//   AboutBlock    +1194  JStrictEqual r43,r1 -> JStrictEqual r43,r43
//                        Never renders the Expo OTA "Update <id>" note (Expo
//                        updates are disabled by suppressExpoUpdates anyway),
//                        which frees that note's literal bytes.
//   literal value buffer  AboutBlock title {size:'title', weight:'regular',
//                        color:'primary', children:'Grok Bot'} is rewritten in
//                        place to children:<string #6YgCQb>, using the 6 freed
//                        bytes for the LongString encoding.
//   string table          '6YgCQb' (only referenced by the skipped footer note)
//                        is pointed at the existing "rokbot" bytes inside
//                        "grokbot://mcp/oauth/callback"; string storage is not
//                        modified.
// The Hermes footer SHA-1 is recomputed afterwards.
import crypto from 'node:crypto';

const HBC_MAGIC = 0x1f1903c103bc1fc6n;
const HBC_VERSION = 98;
const HEADER_SIZE = 128;

const OP = {
  LoadConstNull: 148,
  JmpLong: 175,
  JmpTrue: 176,
  JStrictEqual: 211,
  AsyncBreakCheck: 126,
  NewObjectWithBufferLong: 2,
};

const BRAND_NAME = 'rokbot';
const DONOR_STRING = '6YgCQb';

const align4 = n => (n + 3) & ~3;

function parseLayout(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE + 20) return null;
  if (buf.readBigUInt64LE(0) !== HBC_MAGIC || buf.readUInt32LE(8) !== HBC_VERSION) return null;
  const u32 = off => buf.readUInt32LE(off);
  const h = {
    fileLength: u32(32),
    functionCount: u32(40),
    stringKindCount: u32(44),
    identifierCount: u32(48),
    stringCount: u32(52),
    overflowStringCount: u32(56),
    stringStorageSize: u32(60),
    literalValueBufferSize: u32(80),
  };
  if (h.fileLength !== buf.length) return null;
  let p = HEADER_SIZE;
  const fhOff = p; p = align4(p + 12 * h.functionCount);
  const skOff = p; p = align4(p + 4 * h.stringKindCount);
  p = align4(p + 4 * h.identifierCount);
  const stOff = p; p = align4(p + 4 * h.stringCount);
  const ovOff = p; p = align4(p + 8 * h.overflowStringCount);
  const ssOff = p; p = align4(p + h.stringStorageSize);
  const lvOff = p;
  if (lvOff + h.literalValueBufferSize > buf.length) return null;
  return { ...h, fhOff, skOff, stOff, ovOff, ssOff, lvOff };
}

function stringEntry(buf, L, id) {
  const w = buf.readUInt32LE(L.stOff + 4 * id);
  let utf16 = w & 1;
  let offset = (w >>> 1) & 0x7fffff;
  let length = w >>> 24;
  if (length === 255) {
    const o = L.ovOff + 8 * offset;
    offset = buf.readUInt32LE(o);
    length = buf.readUInt32LE(o + 4);
  }
  return { utf16, offset, length };
}

function stringText(buf, L, id) {
  const e = stringEntry(buf, L, id);
  const start = L.ssOff + e.offset;
  return e.utf16
    ? buf.toString('utf16le', start, start + 2 * e.length)
    : buf.toString('latin1', start, start + e.length);
}

function findStringIds(buf, L, wanted) {
  const want = new Map([...wanted].map(s => [s, []]));
  const lengths = new Set([...wanted].map(s => s.length));
  for (let id = 0; id < L.stringCount; id++) {
    const e = stringEntry(buf, L, id);
    if (e.utf16 || !lengths.has(e.length)) continue;
    const text = stringText(buf, L, id);
    if (want.has(text)) want.get(text).push(id);
  }
  return want;
}

function stringIsPlain(buf, L, id) {
  // StringKind entries: bit 31 = Identifier, low 31 bits = run length.
  let base = 0;
  for (let i = 0; i < L.stringKindCount; i++) {
    const w = buf.readUInt32LE(L.skOff + 4 * i);
    const count = w & 0x7fffffff;
    if (id < base + count) return (w >>> 31) === 0;
    base += count;
  }
  return false;
}

function functionInfo(buf, L, index) {
  const a = L.fhOff + 12 * index;
  const w1 = buf.readUInt32LE(a);
  const w2 = buf.readUInt32LE(a + 4);
  const flags = buf[a + 11];
  if (flags & 0x20) {
    const large = ((w1 & 0xffffff) | (((w2 >>> 14) & 0xff) << 24)) >>> 0;
    return {
      offset: buf.readUInt32LE(large),
      size: buf.readUInt32LE(large + 12),
      name: buf.readUInt32LE(large + 16),
    };
  }
  return { offset: w1 & 0x1ffffff, size: w2 & 0x3fff, name: (w2 >>> 14) & 0xff };
}

function findFunctions(buf, L, nameIds) {
  const found = new Map();
  for (let i = 0; i < L.functionCount; i++) {
    const f = functionInfo(buf, L, i);
    if (nameIds.has(f.name)) {
      const key = nameIds.get(f.name);
      if (!found.has(key)) found.set(key, []);
      found.get(key).push({ index: i, ...f });
    }
  }
  return found;
}

const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex');

function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function i32le(n) { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; }

/**
 * Applies the settings-sheet rebrand to one HBC v98 buffer. Returns
 * { buffer, applied, reason, edits }. The input buffer is never mutated.
 */
export function applySettingsRebrand(hbcBuffer) {
  const skip = reason => ({ buffer: hbcBuffer, applied: false, reason, edits: [] });
  const L = parseLayout(hbcBuffer);
  if (!L) return skip('not a Hermes v98 bytecode file');
  const buf = Buffer.from(hbcBuffer);

  const wanted = new Set([
    'SettingsSheet', 'AboutBlock', 'title', 'regular', 'primary', 'Grok Bot', 'vXOMpL',
    DONOR_STRING, 'grokbot://mcp/oauth/callback',
  ]);
  const ids = findStringIds(buf, L, wanted);
  const one = name => (ids.get(name).length === 1 ? ids.get(name)[0] : null);
  const sid = Object.fromEntries([...wanted].map(n => [n, one(n)]));
  for (const [name, id] of Object.entries(sid)) {
    if (id === null) return skip(`string "${name}" not found exactly once`);
  }

  const fns = findFunctions(buf, L, new Map([[sid.SettingsSheet, 'SettingsSheet'], [sid.AboutBlock, 'AboutBlock']]));
  const settingsList = fns.get('SettingsSheet') || [];
  const aboutList = fns.get('AboutBlock') || [];
  if (settingsList.length !== 1 || aboutList.length !== 1) return skip('SettingsSheet/AboutBlock not found exactly once');
  const settings = settingsList[0];
  const about = aboutList[0];
  if (settings.size !== 4376 || about.size !== 1840) return skip('unexpected SettingsSheet/AboutBlock bytecode size');

  const expectAt = (abs, bytes) => buf.subarray(abs, abs + bytes.length).equals(bytes);
  const S = rel => settings.offset + rel;
  const A = rel => about.offset + rel;

  // --- SettingsSheet anchors -------------------------------------------------
  // +73   GetByIdShort r31, r5, 5, '_'      (r31 = i18n._, never reassigned before +3724)
  // +2993 GetByIndex r9, r7, 79 ; JStrictNotEqual +10, r9, r31   (footer note memo check)
  // +3686 Mov r10, r9                       (link group element -> r10)
  // +3689 GetByIndex r9, r7, 103            (feedback group memo check)
  // +3724 JmpTrue +95, r32                  (feedbackKillSwitch)
  // +4264 DefineOwnInDenseArray r20, r10, 12 (link group is sheet child #12)
  const settingsChecks = [
    [S(73), hex('44 1f 05 05 30')],
    [S(2993), hex('5e 09 07 4f d5 0a 09 1f')],
    [S(3686), hex('10 0a 09')],
    [S(3689), hex('5e 09 07 67')],
    [S(3724), hex('b0 5f 20')],
    [S(4264), hex('5a 14 0a 0c')],
  ];
  for (const [abs, bytes] of settingsChecks) {
    if (!expectAt(abs, bytes)) return skip(`SettingsSheet bytes differ at +${abs - settings.offset}`);
  }

  // --- AboutBlock anchors ----------------------------------------------------
  // +1011 NewObjectWithBufferLong r26, shape, valoff  -> SandText {size,weight,color,children:'Grok Bot'}
  // +1192 LoadConstNull r27 ; +1194 JStrictEqual +71, r43, r1 (skip OTA note when r43 === undefined)
  // +1226 NewObjectWithBufferLong r41, shape, valoff2 -> {id:'vXOMpL', values}
  if (buf[A(1011)] !== OP.NewObjectWithBufferLong || buf[A(1012)] !== 26) return skip('AboutBlock title literal not found');
  if (buf[A(1226)] !== OP.NewObjectWithBufferLong || buf[A(1227)] !== 41) return skip('AboutBlock OTA literal not found');
  if (!expectAt(A(1192), hex('94 1b d3 47 2b 01'))) return skip('AboutBlock OTA branch differs');
  const titleValOff = buf.readUInt32LE(A(1017));
  const otaValOff = buf.readUInt32LE(A(1232));
  if (otaValOff !== titleValOff + 9) return skip('AboutBlock literals are not adjacent');

  const titleOld = Buffer.concat([
    Buffer.from([0x54]), u16le(sid.title), u16le(sid.regular), u16le(sid.primary), u16le(sid['Grok Bot']),
  ]);
  const otaOldHead = Buffer.concat([Buffer.from([0x41]), u32le(sid.vXOMpL)]);
  if (!expectAt(L.lvOff + titleValOff, titleOld)) return skip('AboutBlock title literal content differs');
  if (!expectAt(L.lvOff + otaValOff, otaOldHead)) return skip('AboutBlock OTA literal content differs');

  // --- donor string -> existing "rokbot" bytes ---------------------------------
  const donor = sid[DONOR_STRING];
  if (!stringIsPlain(buf, L, donor)) return skip('donor string is an identifier');
  const donorWord = buf.readUInt32LE(L.stOff + 4 * donor);
  if ((donorWord >>> 24) === 255) return skip('donor string uses an overflow entry');
  const host = stringEntry(buf, L, sid['grokbot://mcp/oauth/callback']);
  const brandOffset = host.offset + 'grokbot://mcp/oauth/callback'.indexOf(BRAND_NAME);
  if (host.utf16 || brandOffset >= 1 << 23) return skip('brand bytes are not addressable');
  if (!expectAt(L.ssOff + brandOffset, Buffer.from(BRAND_NAME, 'latin1'))) return skip('brand bytes not found');

  // --- apply -------------------------------------------------------------------
  const edits = [];
  const write = (label, abs, bytes) => {
    bytes.copy(buf, abs);
    edits.push(label);
  };
  write('settings: skip Help/Privacy/Terms/Grok Bot Terms group and plan footer note', S(2993), Buffer.concat([
    Buffer.from([OP.LoadConstNull, 10, OP.JmpLong]), i32le(3689 - 2995), Buffer.from([OP.AsyncBreakCheck]),
  ]));
  write('settings: skip Send Feedback group', S(3724), Buffer.from([OP.JmpTrue, 0x5f, 31]));
  write('about: never render Expo OTA update note', A(1194), Buffer.from([OP.JStrictEqual, 0x47, 43, 43]));
  write('about: title literal children -> rokbot', L.lvOff + titleValOff, Buffer.concat([
    Buffer.from([0x53]), u16le(sid.title), u16le(sid.regular), u16le(sid.primary), Buffer.from([0x41]), u32le(donor),
  ]));
  write('strings: 6YgCQb -> rokbot', L.stOff + 4 * donor, u32le(((BRAND_NAME.length << 24) | (brandOffset << 1)) >>> 0));

  const sha1 = crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  sha1.copy(buf, buf.length - 20);
  return { buffer: buf, applied: true, reason: 'SettingsSheet/AboutBlock rebranded in place', edits };
}

/**
 * Rebrands the pinned recipe outputs (unpaired.hbc + gateway-template.hbc) and
 * keeps gateway-template.json's templateSha256 in sync so the on-device
 * HermesPatcher accepts the patched template.
 */
export function rebrandPinnedHermesResources(pinned) {
  const unpaired = applySettingsRebrand(pinned.unpairedHbc);
  const template = applySettingsRebrand(pinned.gatewayTemplateHbc);
  if (!unpaired.applied || !template.applied) {
    return {
      ...pinned,
      settingsRebrand: {
        applied: false,
        reason: unpaired.applied ? `gateway-template: ${template.reason}` : `unpaired: ${unpaired.reason}`,
        edits: [],
      },
    };
  }
  const oldSha = pinned.gatewayMeta.templateSha256;
  const newSha = crypto.createHash('sha256').update(template.buffer).digest('hex');
  const jsonText = pinned.gatewayTemplateJson.toString('utf8');
  if (!oldSha || jsonText.split(oldSha).length !== 2) {
    return { ...pinned, settingsRebrand: { applied: false, reason: 'templateSha256 not found in gateway-template.json', edits: [] } };
  }
  const gatewayTemplateJson = Buffer.from(jsonText.replace(oldSha, newSha), 'utf8');
  return {
    unpairedHbc: unpaired.buffer,
    gatewayTemplateHbc: template.buffer,
    gatewayTemplateJson,
    gatewayMeta: { ...pinned.gatewayMeta, templateSha256: newSha },
    settingsRebrand: { applied: true, reason: unpaired.reason, edits: unpaired.edits },
  };
}

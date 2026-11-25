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

// ---------------------------------------------------------------------------
// rokbot.3: "Connection & Diagnostics" settings row, no bug button, list sort.
//
// Applied on top of applySettingsRebrand() output (and therefore on top of the
// pinned recipe, which forced BuildChannel.showsDebugTools() to true and gave
// the header bug button the "连接服务端 / Connect to Host" label). Same rules:
// in place, size preserving, original bytes verified first, fail closed.
//
//   SettingsSheet +453  LoadConstTrue r14 x2 (recipe) -> LoadConstFalse r14 x2
//                       The header action array stays undefined: no bug button.
//   SettingsSheet +3724 JmpTrue r31 (rebrand) -> JmpTrue r19 (null from +3722)
//                       The former "Send Feedback" InsetGroup is built again;
//                       it now holds the Connection & Diagnostics nav row.
//   SettingsSheet +3773 NewObjectWithBufferLong/Call2 (i18n "Send Feedback")
//                       -> JmpLong into the link-group block that the rebrand
//                       already skips (+3001..+3688, never executed). There the
//                       label is built and control jumps back to +3788:
//                         t = i18n._({id:'exyUec'})   // "Connection" / "连接" / ...
//                         t.charCodeAt(0) is 连 or 連 -> String.fromCharCode(
//                           连,接,与) + String.fromCharCode(诊,断) = "连接与诊断"
//                         otherwise -> t + " " + "&" + " " + "Diagnostics"
//                       Scratch registers r0 (numbers only), r9, r19, r40 are
//                       rewritten before their next read; r41+ is the frame's
//                       outgoing-call area and is never used. Property caches
//                       reuse slots of unrelated module objects
//                       (a cache hit needs the same hidden class, so no
//                       cross-talk is possible). The native companion opens its
//                       connection page for these labels.
//   onPress (/settings/feedback) -> LoadConstUndefined r0; Ret r0 (no-op); the
//                       companion consumes the tap before RN would see it.
//   identifier            'feedbackKillSwitch' -> "lastMessageAt": its overflow
//                       entry is re-pointed at the first 13 bytes of
//                       "lastMessageAtMs" and its identifier hash updated
//                       (Jenkins, as hermesc writes it). Every use of that
//                       identifier (the flag's definition and its three readers)
//                       goes through the same string id, so the rename is
//                       semantics-preserving; it frees a property-name
//                       identifier spelling "lastMessageAt" for the list sort.
//                       (Property names must be identifiers: a re-pointed plain
//                       string does not resolve as a property key at runtime.)
//
// List sort ("sort by last message", applied on device when the user turns the
// bell on; see listSortEdits / HermesPatcher.applyListSortEdits):
//   recencyOf +10  JStrictEqual 'activity', mode -> always take the activity branch
//   recencyOf +131 GetByIdLong 'localActivityAt' -> 'lastMessageAt'
//   recencyOf +147 GetById 'lastActivityAt' -> LoadConstZero r3 x3
//   => recency = max(lastMessageAt ?? 0, 0, createdAt). Box roster rows keep the
//      Host's summary fields, and Host >= a33d5dc stamps lastMessageAt (newest
//      chat message) on listAgents and on agent events.

const CONNECTION_LABEL_ZH = '连接与诊断';
const CONNECTION_LABEL_EN_SUFFIX = ' & Diagnostics';
const LIST_SORT_FIELD = 'lastMessageAt';
const DONOR_TEXT = 'feedbackKillSwitch';

/** Hermes identifier hash (JenkinsHash.h updateJenkinsHash over UTF-16 units, no finalizer). */
export function hermesIdentifierHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h + text.charCodeAt(i)) >>> 0;
    h = (h + ((h << 10) >>> 0)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  return h;
}

function identifierHashOffset(buf, L, id) {
  // Identifier hashes follow the string kinds, one u32 per identifier in string id order.
  let base = 0, ordinal = 0;
  for (let i = 0; i < L.stringKindCount; i++) {
    const w = buf.readUInt32LE(L.skOff + 4 * i);
    const count = w & 0x7fffffff;
    const ident = (w >>> 31) === 1;
    if (id < base + count) return ident ? align4(L.skOff + 4 * L.stringKindCount) + 4 * (ordinal + (id - base)) : null;
    if (ident) ordinal += count;
    base += count;
  }
  return null;
}

const OPX = {
  ...OP,
  LoadConstTrue: 149,
  LoadConstFalse: 150,
  LoadConstUndefined: 147,
  LoadConstZero: 151,
  LoadConstInt: 140,
  LoadConstString: 144,
  LoadConstStringLongIndex: 145,
  GetGlobalObject: 61,
  GetByIdShort: 68,
  GetById: 69,
  GetByIdLong: 70,
  TryGetById: 72,
  Call2: 110,
  Call3: 111,
  Call4: 112,
  Add: 30,
  Ret: 118,
  Mov: 16,
};

function ins(op, ...parts) {
  return Buffer.concat([Buffer.from([op]), ...parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from([p])))]);
}

function findUniqueFunction(buf, L, name, size) {
  const ids = findStringIds(buf, L, new Set([name])).get(name);
  if (ids.length !== 1) return null;
  const list = findFunctions(buf, L, new Map([[ids[0], name]])).get(name) || [];
  if (list.length !== 1 || list[0].size !== size) return null;
  return list[0];
}

function overflowIndex(buf, L, id) {
  const w = buf.readUInt32LE(L.stOff + 4 * id);
  return (w >>> 24) === 255 ? (w >>> 1) & 0x7fffff : null;
}

/** Locates the anchors shared by applyConnectionEntry and listSortEdits. */
function connectionAnchors(buf, L, donorText = DONOR_TEXT) {
  const wanted = new Set([
    'SettingsSheet', 'onPress', '/settings/feedback', donorText, 'lastMessageAtMs', 'exyUec', 'charCodeAt', 'String',
    'fromCharCode', ' ', '&', 'Diagnostics', 'localActivityAt', 'lastActivityAt', 'activity',
  ]);
  const ids = findStringIds(buf, L, wanted);
  const sid = {};
  for (const name of wanted) {
    if (ids.get(name).length !== 1) return { error: `string "${name}" not found exactly once` };
    sid[name] = ids.get(name)[0];
  }
  sid.donor = sid[donorText];
  const settings = findUniqueFunction(buf, L, 'SettingsSheet', 4376);
  if (!settings) return { error: 'SettingsSheet not found exactly once' };
  const recency = findUniqueFunction(buf, L, 'recencyOf', 174);
  if (!recency) return { error: 'recencyOf not found exactly once' };
  return { sid, settings, recency };
}

/**
 * Turns the (rebranded) settings sheet's bug button into a regular
 * "Connection & Diagnostics" row. Input must be applySettingsRebrand() output.
 * Returns { buffer, applied, reason, edits }; the input is never mutated.
 */
export function applyConnectionEntry(hbcBuffer) {
  const skip = reason => ({ buffer: hbcBuffer, applied: false, reason, edits: [] });
  const L = parseLayout(hbcBuffer);
  if (!L) return skip('not a Hermes v98 bytecode file');
  const buf = Buffer.from(hbcBuffer);
  const anchors = connectionAnchors(buf, L);
  if (anchors.error) return skip(anchors.error);
  const { sid, settings } = anchors;
  const S = rel => settings.offset + rel;
  const expectAt = (abs, bytes) => buf.subarray(abs, abs + bytes.length).equals(bytes);

  // SettingsSheet anchors (after recipe + rebrand).
  const checks = [
    // +447 GetById r5, r14, 25, 'showsDebugTools'; +453 recipe: LoadConstTrue r14 x2; +457 LoadConstUndefined r5; +459 JmpFalse
    [453, hex('95 0e 95 0e 93 05 b2 55 0e')],
    // +2993 rebrand: LoadConstNull r10; JmpLong +694; AsyncBreakCheck -> link group block +3001..+3688 is dead
    [2993, hex('94 0a af b6 02 00 00 7e')],
    // +3722 LoadConstNull r19; +3724 rebrand JmpTrue +95, r31
    [3722, hex('94 13 b0 5f 1f')],
    // +3773 NewObjectWithBufferLong r39, 347, <Send Feedback>; +3783 Call2 r39, r31, r1, r39; +3788 PutOwnBySlotIdx r35, r39, 0
    [3773, hex('02 27 5b 01 00 00')],
    [3783, hex('6e 27 1f 01 27 52 23 27 00')],
    // +3792 CreateClosureLongIndex r38, r38, <onPress>
    [3792, hex('85 26 26')],
    // +4171 GetByIdShort r19, r18, 45, 'jsxs' | +3740 GetById r33, r35, 46, 'InsetGroup' | +3757 GetById r36, r35, 52, 'InsetGroupNavRow'
    [4171, hex('44 13 12 2d')],
    [3740, hex('45 21 23 2e')],
    [3757, hex('45 24 23 34')],
  ];
  for (const [rel, bytes] of checks) {
    if (!expectAt(S(rel), bytes)) return skip(`SettingsSheet bytes differ at +${rel}`);
  }
  // The row's onPress closure must be the one pushing '/settings/feedback'.
  const onPressIndex = buf.readUInt32LE(S(3795));
  const onPress = functionInfo(buf, L, onPressIndex);
  if (onPress.name !== sid.onPress || onPress.size !== 25) return skip('feedback onPress not found');
  // GetParentEnvironment r0,0; LoadFromEnvironment r2,r0,0; GetByIdShort r1,r2,0,'push';
  // LoadConstStringLongIndex r0,'/settings/feedback'; Call2 r0,r1,r2,r0; Ret r0
  const onPressBody = Buffer.concat([
    hex('34 00 00 3b 02 00 00 44 01 02 00 d6'),
    ins(OPX.LoadConstStringLongIndex, 0, u32le(sid['/settings/feedback'])),
    hex('6e 00 01 02 00 76 00'),
  ]);
  if (!expectAt(onPress.offset, onPressBody)) return skip('feedback onPress body differs');
  // {id:'exyUec'} literal (shape 347) used by the official "Connection" label.
  const EXY_LITERAL = 399145;
  if (!expectAt(L.lvOff + EXY_LITERAL, Buffer.concat([Buffer.from([0x41]), u32le(sid.exyUec)]))) {
    return skip('{id:exyUec} literal not found');
  }
  // Donor: identifier 'feedbackKillSwitch' (overflow entry) -> "lastMessageAt" + its hash.
  const donorIdx = overflowIndex(buf, L, sid.donor);
  const hostIdx = overflowIndex(buf, L, sid.lastMessageAtMs);
  if (donorIdx === null || hostIdx === null) return skip('donor strings are not overflow entries');
  if (stringIsPlain(buf, L, sid.donor)) return skip('donor string is not an identifier');
  const hashOff = identifierHashOffset(buf, L, sid.donor);
  if (hashOff === null || buf.readUInt32LE(hashOff) !== hermesIdentifierHash(DONOR_TEXT)) return skip('donor identifier hash differs');
  if (findStringIds(buf, L, new Set([LIST_SORT_FIELD])).get(LIST_SORT_FIELD).length !== 0) return skip('"lastMessageAt" already exists');
  const hostOff = buf.readUInt32LE(L.ovOff + 8 * hostIdx);
  if (!expectAt(L.ssOff + hostOff, Buffer.from('lastMessageAtMs', 'latin1'))) return skip('lastMessageAtMs bytes not found');
  if ((buf.readUInt32LE(L.stOff + 4 * sid.donor) & 1) !== 0) return skip('donor string is UTF-16');
  for (const name of [' ', '&', 'Diagnostics', 'fromCharCode']) {
    if (sid[name] >= 65536) return skip(`string "${name}" needs a long index`);
  }
  if (sid.charCodeAt >= 256 || sid.String >= 65536) return skip('charCodeAt/String ids out of range');

  // --- label builder placed in the dead link-group block ---------------------
  const D = 3001;
  const BACK = 3788;
  const code = [];
  let pos = D;
  const emit = b => { code.push(b); pos += b.length; };
  const jmpLongTo = target => ins(OPX.JmpLong, i32le(target - pos));
  // Registers: r39 = label (consumed at +3788). Scratch only r0 (number register; numbers
  // only), r9, r19 and r40, all overwritten before their next read after +3788. Registers
  // above r40 are SettingsSheet's outgoing-call area: Call* instructions write the callee
  // frame there, so nothing may be kept in them across a call.
  emit(ins(OPX.NewObjectWithBufferLong, 39, u32le(347), u32le(EXY_LITERAL)));
  emit(ins(OPX.Call2, 39, 31, 1, 39));                       // r39 = i18n._({id:'exyUec'})
  emit(ins(OPX.GetByIdShort, 40, 39, 45, sid.charCodeAt));
  emit(ins(OPX.LoadConstZero, 9));
  emit(ins(OPX.Call2, 0, 40, 39, 9));                         // r0 = r39.charCodeAt(0)
  const zhJumps = [];
  emit(ins(OPX.LoadConstInt, 9, i32le(0x8fde))); // 连
  zhJumps.push(pos); emit(ins(OP.JStrictEqual, 0, 0, 9));
  emit(ins(OPX.LoadConstInt, 9, i32le(0x9023))); // 連
  zhJumps.push(pos); emit(ins(OP.JStrictEqual, 0, 0, 9));
  emit(ins(OPX.LoadConstString, 9, u16le(sid[' '])));
  emit(ins(OPX.Add, 39, 39, 9));
  emit(ins(OPX.LoadConstString, 40, u16le(sid['&'])));
  emit(ins(OPX.Add, 39, 39, 40));
  emit(ins(OPX.Add, 39, 39, 9));
  emit(ins(OPX.LoadConstString, 40, u16le(sid.Diagnostics)));
  emit(ins(OPX.Add, 39, 39, 40));                            // "<Connection> & Diagnostics"
  emit(jmpLongTo(BACK));
  const zh = pos;
  emit(ins(OPX.GetGlobalObject, 19));
  emit(ins(OPX.TryGetById, 19, 19, 52, u16le(sid.String)));  // r19 = String
  emit(ins(OPX.GetById, 40, 19, 46, u16le(sid.fromCharCode))); // r40 = String.fromCharCode
  emit(ins(OPX.LoadConstInt, 9, i32le(0x8fde)));  // 连
  emit(ins(OPX.LoadConstInt, 0, i32le(0x63a5)));  // 接
  emit(ins(OPX.Call3, 39, 40, 19, 9, 0));
  emit(ins(OPX.LoadConstInt, 9, i32le(0x4e0e)));  // 与
  emit(ins(OPX.LoadConstInt, 0, i32le(0x8bca)));  // 诊
  emit(ins(OPX.Call3, 9, 40, 19, 9, 0));
  emit(ins(OPX.Add, 39, 39, 9));
  emit(ins(OPX.LoadConstInt, 9, i32le(0x65ad)));  // 断
  emit(ins(OPX.Call2, 9, 40, 19, 9));
  emit(ins(OPX.Add, 39, 39, 9));                             // "连接与诊断"
  emit(jmpLongTo(BACK));
  const block = Buffer.concat(code);
  for (const at of zhJumps) block[at - D + 1] = zh - at;
  if (D + block.length > 3689) return skip('label builder does not fit');

  // --- apply -------------------------------------------------------------------
  const edits = [];
  const write = (label, abs, bytes) => {
    bytes.copy(buf, abs);
    edits.push(label);
  };
  write('settings: no header bug button (showsDebugTools -> false)', S(453), hex('96 0e 96 0e'));
  write('settings: build the former feedback group again', S(3724), Buffer.from([OP.JmpTrue, 0x5f, 19]));
  // Pad the rest of the dead block with 1-byte AsyncBreakCheck so linear disassemblers stay in sync.
  write('settings: label builder in the dead link-group block', S(D), Buffer.concat([block, Buffer.alloc(3689 - D - block.length, OP.AsyncBreakCheck)]));
  write('settings: feedback label -> jump to the label builder', S(3773), Buffer.concat([
    ins(OPX.JmpLong, i32le(D - 3773)), hex('94 00 94 00 94 00 94 00 94 00'),
  ]));
  write('onPress: /settings/feedback push -> no-op', onPress.offset, Buffer.concat([
    Buffer.from([OPX.LoadConstUndefined, 0, OPX.Ret, 0]), Buffer.alloc(onPress.size - 4, OP.AsyncBreakCheck),
  ]));
  write('identifiers: feedbackKillSwitch -> lastMessageAt', L.ovOff + 8 * donorIdx, Buffer.concat([u32le(hostOff), u32le(LIST_SORT_FIELD.length)]));
  write('identifiers: lastMessageAt hash', hashOff, u32le(hermesIdentifierHash(LIST_SORT_FIELD)));

  const sha1 = crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  sha1.copy(buf, buf.length - 20);
  return { buffer: buf, applied: true, reason: 'Connection & Diagnostics row in place of the bug button', edits };
}

/**
 * Byte edits that switch the sidebar ordering to "last message first". They
 * are not applied at build time: the companion applies them while generating
 * the paired bundle when the user turns the list bell on. Input must already
 * carry applyConnectionEntry() (the donor string). Returns null if anything
 * differs.
 */
export function listSortEdits(hbcBuffer) {
  const L = parseLayout(hbcBuffer);
  if (!L) return null;
  const buf = hbcBuffer;
  // After applyConnectionEntry the donor entry reads "lastMessageAt" (exactly once).
  const anchors = connectionAnchors(buf, L, LIST_SORT_FIELD);
  if (anchors.error) return null;
  const { sid, recency } = anchors;
  const R = rel => recency.offset + rel;
  const donor = sid.donor;
  if (stringIsPlain(buf, L, donor)) return null;
  const hashOff = identifierHashOffset(buf, L, donor);
  if (hashOff === null || buf.readUInt32LE(hashOff) !== hermesIdentifierHash(LIST_SORT_FIELD)) return null;
  const edits = [
    { label: 'recencyOf: always use the activity branch', offset: R(10),
      original: Buffer.from([OP.JStrictEqual, 108, 3, 4]), patched: Buffer.from([OP.JStrictEqual, 108, 3, 3]) },
    { label: 'recencyOf: localActivityAt -> lastMessageAt', offset: R(131),
      original: ins(OPX.GetByIdLong, 4, 2, 6, u32le(sid.localActivityAt)), patched: ins(OPX.GetByIdLong, 4, 2, 6, u32le(donor)) },
    { label: 'recencyOf: drop lastActivityAt', offset: R(147),
      original: ins(OPX.GetById, 3, 2, 4, u16le(sid.lastActivityAt)), patched: hex('97 03 97 03 97 03') },
  ];
  // Sanity: +6 loads the 'activity' mode string compared at +10.
  if (!buf.subarray(R(6), R(10)).equals(ins(OPX.LoadConstString, 3, u16le(sid.activity)))) return null;
  for (const e of edits) {
    if (!buf.subarray(e.offset, e.offset + e.original.length).equals(e.original)) return null;
  }
  // rokbot.3b: the header bell shows the mode (label + copper tint) when applyHomeBarBell ran.
  const bell = homeBellSortEdits(buf, L);
  return bell ? [...edits, ...bell] : edits;
}

/** Applies (or verifies) list sort edits in place; mirrors HermesPatcher.applyListSortEdits. */
export function applyListSortEdits(buffer, edits) {
  const out = Buffer.from(buffer);
  for (const e of edits) {
    const original = Buffer.from(e.original, e.original instanceof Buffer ? undefined : 'hex');
    const patched = Buffer.from(e.patched, e.patched instanceof Buffer ? undefined : 'hex');
    if (!out.subarray(e.offset, e.offset + original.length).equals(original)) throw new Error(`list sort anchor differs at ${e.offset}`);
    patched.copy(out, e.offset);
  }
  const sha1 = crypto.createHash('sha1').update(out.subarray(0, out.length - 20)).digest();
  sha1.copy(out, out.length - 20);
  return out;
}

// ---------------------------------------------------------------------------
// rokbot.3b: the "sort by last message" bell as a real RN header button.
//
// On Android the Bot list header row is drawn by HomeScreen as JSX:
//   <>{showSearchInHeader ? <SearchButton onPress={onSearch}/> : null}<NewChatMenuButton/></>
// (useHomeBarButtons only feeds the iOS native navigation bar). SearchButton (fn
// "SearchButton", 263 bytes, used only there) renders a toolbar SandButton with a
// CursorIcon. The bell is added in that row as one more toolbar SandButton, so RN
// lays it out with the same metrics as Search and "+": it never floats over the
// list. In place, size preserving, every original byte checked first:
//
//   HomeScreen +7489..+7524  always renders SearchButton, with props
//         {isSelected: showSearchInHeader, onPress: onSearch} (object shape
//         {isSelected,onPress} already in the bundle) instead of rendering it
//         only when showSearchInHeader.
//   SearchButton (whole body)  returns <bell/> or [<bell/>, <search/>]:
//         bell   = <SandButton variant="toolbar" accessibilityLabel="sort"
//                   onPress={no-op} icon={<CursorIcon name="bell" size=20
//                   tone="primary" weight="medium" color={undefined}/>}/>
//         search = the original Search button (same literals and label).
//         The React-compiler memo cache (useMemoCache) is dropped; useLingui is
//         still called unconditionally, so the hook order never changes.
//         Only r1..r9 are used (r0 is the frame's number register), property
//         caches reuse SearchButton's own indices.
//
// The bell state is baked into the paired bundle: listSortEdits() adds two edits
// (label 'sort' -> 'sorted', icon tone 'primary' -> undefined and color undefined
// -> '#C27400' copper; the theme has no copper tone and a tone wins over color) that the companion applies together with the recencyOf edits.
// The tap is handled by the companion (RokBotBootstrap: label sort/sorted).

const HOME_BELL_LABEL_OFF = 'sort';
const HOME_BELL_LABEL_ON = 'sorted';
const HOME_BELL_TONE = 'primary';
const HOME_BELL_COLOR_ON = '#C27400';   // copper; CursorIcon's `color` wins over `tone`
const HOME_BELL_ICON = 'bell';
const SEARCH_ICON_LITERAL = 377125;   // shape 8894 {name:'magnifying-glass', size:20, tone:'primary', weight:'medium'}
const ICON_COLOR_LITERAL = 152593;    // shape 9325 {name, variant, size, tone, color, weight:'medium'} (SandBarItemPill)
const SEARCH_LABEL_LITERAL = 376446;  // shape 347 {id:'A1taO8'} ("Search")
const TOOLBAR_BUTTON_LITERAL = 4075;  // shape 9332 {variant:'toolbar', accessibilityLabel, onPress, icon}
const SHOW_SEARCH_SHAPE = 11732;      // {isSelected, onPress}
const ANY_TWO_VALUES = 64774;         // null, int: overwritten by the two PutOwnBySlotIdx
const HOME_HEADER_REL = 7489;         // HomeScreen
const HOME_HEADER_END = 7525;

// SearchButton as shipped (pinned recipe; untouched by the earlier rebrand steps).
const SEARCH_BUTTON_ORIGINAL = hex(
  '3403003b02030044020200038b000693016e0402010089020144060201cb3b02030144020202f86c02020144070203305e020400d50a02075e05' +
  '0401ae2102025b0100007ebe05006e020701029700610400078b0001610400021005025e0704023d02480902042e00440809059c9002d7276e02' +
  '080902d30a07025e090402ae2e3b02030444080206b63b020303440702070b0202be22000025c105006f02080107028b000261040002100902' +
  '5e020403d51202065e020404d50a02055e020405ae443b07030444080706b63b030302440703082501037424eb0f5203050152030602520309' +
  '036f03080107038b0003610400068b0004610400058b0005610400031002037602');
// HomeScreen +7489..+7524: LoadConstNull r87; JmpFalse r40 ->+7525; jsx; SearchButton; {onPress}; Call3 -> r87.
const HOME_HEADER_ORIGINAL = hex('9457b2222844585681b63b330c434554338abba70133300d06fd52334c006f5758045433');

const OPB = {
  NewObjectWithBuffer: 1, NewArray: 8, GetParentEnvironment: 52, LoadFromEnvironment: 59, GetByIdShort: 68,
  GetById: 69, PutOwnBySlotIdx: 82, DefineOwnInDenseArray: 90, Call1: 108, Call2: 110, Call3: 111, Ret: 118,
  CreateClosureLongIndex: 133, LoadParam: 137, LoadConstUInt8: 139, LoadConstString: 144, LoadConstUndefined: 147, JmpFalse: 178,
};

function homeBellAnchors(buf, L) {
  const wanted = new Set(['SearchButton', 'HomeScreen', HOME_BELL_ICON, HOME_BELL_LABEL_OFF, HOME_BELL_LABEL_ON,
    HOME_BELL_TONE, HOME_BELL_COLOR_ON, 'isSelected', 'onPress', 'useLingui', '_', 'jsx', 'CursorIcon', 'SandButton']);
  const ids = findStringIds(buf, L, wanted);
  const sid = {};
  for (const name of wanted) {
    if (ids.get(name).length !== 1) return { error: `string "${name}" not found exactly once` };
    sid[name] = ids.get(name)[0];
    if (sid[name] >= 65536) return { error: `string "${name}" needs a long index` };
  }
  for (const name of ['onPress', 'useLingui', '_', 'jsx', 'CursorIcon', 'SandButton']) {
    if (sid[name] >= 256) return { error: `string "${name}" needs GetById` };
  }
  const search = findUniqueFunction(buf, L, 'SearchButton', 263);
  if (!search) return { error: 'SearchButton not found exactly once' };
  const home = findUniqueFunction(buf, L, 'HomeScreen', 11585);
  if (!home) return { error: 'HomeScreen not found exactly once' };
  return { sid, search, home };
}

/** The bell + search body for SearchButton; `rel` gives the label/tone instruction offsets. */
function searchButtonBody(sid, noopIndex, { label = HOME_BELL_LABEL_OFF, color = null } = {}) {
  const parts = [];
  const rel = {};
  let pos = 0;
  const emit = (b, name) => { if (name) rel[name] = pos; parts.push(b); pos += b.length; };
  // r1 = undefined, r3 = env, r7 = i18n._, r8 = jsx, r9 = CursorIcon, r6 = no-op, r3 <- SandButton.
  emit(ins(OPB.GetParentEnvironment, 3, 0));
  emit(ins(OPB.LoadConstUndefined, 1));
  emit(ins(OPB.LoadFromEnvironment, 2, 3, 1));
  emit(ins(OPB.GetByIdShort, 2, 2, 2, sid.useLingui));
  emit(ins(OPB.Call1, 2, 2, 1));                                 // useLingui() (always: hook order is fixed)
  emit(ins(OPB.GetByIdShort, 7, 2, 3, sid._));
  emit(ins(OPB.LoadFromEnvironment, 2, 3, 4));
  emit(ins(OPB.GetByIdShort, 8, 2, 6, sid.jsx));
  emit(ins(OPB.LoadFromEnvironment, 2, 3, 3));
  emit(ins(OPB.GetByIdShort, 9, 2, 7, sid.CursorIcon));
  emit(ins(OPB.CreateClosureLongIndex, 6, 3, u32le(noopIndex)));
  emit(ins(OPB.LoadFromEnvironment, 2, 3, 2));
  emit(ins(OPB.GetByIdShort, 3, 2, 8, sid.SandButton));
  // bell icon + button -> r5
  emit(ins(OP.NewObjectWithBufferLong, 2, u32le(9325), u32le(ICON_COLOR_LITERAL)));
  emit(ins(OPB.LoadConstString, 4, u16le(sid[HOME_BELL_ICON])));
  emit(ins(OPB.PutOwnBySlotIdx, 2, 4, 0));                       // name = 'bell'
  emit(ins(OPB.LoadConstUndefined, 4));
  emit(ins(OPB.PutOwnBySlotIdx, 2, 4, 1));                       // variant = undefined (the literal has null)
  emit(ins(OPB.LoadConstUInt8, 4, 20));
  emit(ins(OPB.PutOwnBySlotIdx, 2, 4, 2));                       // size = 20 (as the Search icon)
  emit(color ? Buffer.from([OPB.LoadConstUndefined, 4, OP.AsyncBreakCheck, OP.AsyncBreakCheck])
    : ins(OPB.LoadConstString, 4, u16le(sid[HOME_BELL_TONE])), 'tone');
  emit(ins(OPB.PutOwnBySlotIdx, 2, 4, 3));                       // tone: 'primary' (off) / undefined (on: tone wins over color)
  emit(color ? ins(OPB.LoadConstString, 4, u16le(sid[color]))
    : Buffer.from([OPB.LoadConstUndefined, 4, OP.AsyncBreakCheck, OP.AsyncBreakCheck]), 'color');
  emit(ins(OPB.PutOwnBySlotIdx, 2, 4, 4));                       // color: undefined (off) / copper (on)
  emit(ins(OPB.Call3, 2, 8, 1, 9, 2));                           // <CursorIcon .../>
  emit(ins(OPB.NewObjectWithBuffer, 4, u16le(9332), u16le(TOOLBAR_BUTTON_LITERAL)));
  emit(ins(OPB.LoadConstString, 5, u16le(sid[label])), 'label');
  emit(ins(OPB.PutOwnBySlotIdx, 4, 5, 1));                       // accessibilityLabel
  emit(ins(OPB.PutOwnBySlotIdx, 4, 6, 2));                       // onPress = no-op
  emit(ins(OPB.PutOwnBySlotIdx, 4, 2, 3));                       // icon
  emit(ins(OPB.Call3, 5, 8, 1, 3, 4));                           // r5 = <SandButton .../>
  // search (only when the layout shows Search in the header)
  emit(ins(OPB.LoadParam, 2, 1));
  emit(ins(OPB.GetById, 4, 2, 0, u16le(sid.isSelected)));
  const jf = pos;
  emit(Buffer.from([OPB.JmpFalse, 0, 4]));
  emit(ins(OPB.GetByIdShort, 6, 2, 1, sid.onPress));
  emit(ins(OP.NewObjectWithBufferLong, 2, u32le(347), u32le(SEARCH_LABEL_LITERAL)));
  emit(ins(OPB.Call2, 2, 7, 1, 2));                              // i18n._({id:'A1taO8'})
  emit(ins(OPB.NewObjectWithBuffer, 4, u16le(9332), u16le(TOOLBAR_BUTTON_LITERAL)));
  emit(ins(OPB.PutOwnBySlotIdx, 4, 2, 1));
  emit(ins(OPB.PutOwnBySlotIdx, 4, 6, 2));
  emit(ins(OP.NewObjectWithBufferLong, 2, u32le(8894), u32le(SEARCH_ICON_LITERAL)));
  emit(ins(OPB.Call3, 2, 8, 1, 9, 2));
  emit(ins(OPB.PutOwnBySlotIdx, 4, 2, 3));
  emit(ins(OPB.Call3, 2, 8, 1, 3, 4));                           // r2 = original Search button
  emit(ins(OPB.NewArray, 4, u16le(2)));
  emit(ins(OPB.DefineOwnInDenseArray, 4, 5, 0));
  emit(ins(OPB.DefineOwnInDenseArray, 4, 2, 1));
  emit(ins(OPB.Ret, 4));                                         // [bell, search]
  const only = pos;
  emit(ins(OPB.Ret, 5));                                         // bell
  const body = Buffer.concat(parts);
  body[jf + 1] = only - jf;
  return { body, rel };
}

/**
 * Adds the list-sort bell to the Bot list header (see above). Input must be
 * applyConnectionEntry() output (its no-op onPress is reused). Returns
 * { buffer, applied, reason, edits }; the input is never mutated.
 */
export function applyHomeBarBell(hbcBuffer) {
  const skip = reason => ({ buffer: hbcBuffer, applied: false, reason, edits: [] });
  const L = parseLayout(hbcBuffer);
  if (!L) return skip('not a Hermes v98 bytecode file');
  const buf = Buffer.from(hbcBuffer);
  const a = homeBellAnchors(buf, L);
  if (a.error) return skip(a.error);
  const { sid, search, home } = a;
  const expectAt = (abs, bytes) => buf.subarray(abs, abs + bytes.length).equals(bytes);

  if (!expectAt(search.offset, SEARCH_BUTTON_ORIGINAL)) return skip('SearchButton bytes differ');
  if (!expectAt(home.offset + HOME_HEADER_REL, HOME_HEADER_ORIGINAL)) return skip('HomeScreen header bytes differ');
  // The literals the new code reuses, as SearchButton itself uses them.
  if (!expectAt(search.offset + 62, Buffer.concat([Buffer.from([OP.NewObjectWithBufferLong, 2]), u32le(347), u32le(SEARCH_LABEL_LITERAL)]))) return skip('search label literal moved');
  if (!expectAt(search.offset + 147, Buffer.concat([Buffer.from([OP.NewObjectWithBufferLong, 2]), u32le(8894), u32le(SEARCH_ICON_LITERAL)]))) return skip('search icon literal moved');
  if (!expectAt(search.offset + 213, Buffer.concat([Buffer.from([OPB.NewObjectWithBuffer, 3]), u16le(9332), u16le(TOOLBAR_BUTTON_LITERAL)]))) return skip('toolbar button literal moved');
  // {name,variant,size,tone,color,weight} values: null x5, 'medium' (SandBarItemPill +346 uses it the same way).
  const medium = findStringIds(buf, L, new Set(['medium'])).get('medium');
  if (medium.length !== 1 || medium[0] >= 65536 || !expectAt(L.lvOff + ICON_COLOR_LITERAL, Buffer.concat([hex('05 51'), u16le(medium[0])]))) {
    return skip('icon colour literal differs');
  }
  // The no-op onPress left by applyConnectionEntry (LoadConstUndefined r0; Ret r0; AsyncBreakCheck...).
  const settings = findUniqueFunction(buf, L, 'SettingsSheet', 4376);
  if (!settings) return skip('SettingsSheet not found exactly once');
  const noopIndex = buf.readUInt32LE(settings.offset + 3795);
  const noop = functionInfo(buf, L, noopIndex);
  if (!expectAt(noop.offset, Buffer.concat([hex('93 00 76 00'), Buffer.alloc(noop.size - 4, OP.AsyncBreakCheck)]))) {
    return skip('no-op onPress not found (applyConnectionEntry first)');
  }

  const { body } = searchButtonBody(sid, noopIndex);
  if (body.length > search.size) return skip('bell body does not fit');
  const header = Buffer.concat([
    ins(OPB.GetByIdShort, 88, 86, 129, sid.jsx),                 // as at +7494
    hex('3b 33 0c 43'),                                          // LoadFromEnvironment r51, r12, 67
    hex('45 54 33 8a bb a7'),                                    // GetById r84, r51, 138, 'SearchButton'
    ins(OPB.NewObjectWithBuffer, 51, u16le(SHOW_SEARCH_SHAPE), u16le(ANY_TWO_VALUES)),
    ins(OPB.PutOwnBySlotIdx, 51, 40, 0),                         // isSelected = showSearchInHeader
    ins(OPB.PutOwnBySlotIdx, 51, 76, 1),                         // onPress = onSearch
    hex('6f 57 58 04 54 33'),                                    // Call3 r87, r88, r4, r84, r51
  ]);
  if (header.length > HOME_HEADER_END - HOME_HEADER_REL) return skip('header block does not fit');

  const edits = [];
  const write = (label, abs, bytes) => { bytes.copy(buf, abs); edits.push(label); };
  write('HomeScreen: always render SearchButton {isSelected: search in header, onPress}', home.offset + HOME_HEADER_REL,
    Buffer.concat([header, Buffer.alloc(HOME_HEADER_END - HOME_HEADER_REL - header.length, OP.AsyncBreakCheck)]));
  write('SearchButton: bell toolbar button (+ the original Search button)', search.offset,
    Buffer.concat([body, Buffer.alloc(search.size - body.length, OP.AsyncBreakCheck)]));

  const sha1 = crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  sha1.copy(buf, buf.length - 20);
  return { buffer: buf, applied: true, reason: 'list sort bell in the Bot list header', edits };
}

/** On-state edits for the header bell (label + amber tone); null when the bell is not in this bundle. */
function homeBellSortEdits(buf, L) {
  const a = homeBellAnchors(buf, L);
  if (a.error) return null;
  const { sid, search } = a;
  const settings = findUniqueFunction(buf, L, 'SettingsSheet', 4376);
  if (!settings) return null;
  const noopIndex = buf.readUInt32LE(settings.offset + 3795);
  const off = searchButtonBody(sid, noopIndex);
  if (!buf.subarray(search.offset, search.offset + off.body.length).equals(off.body)) return null;
  const on = searchButtonBody(sid, noopIndex, { label: HOME_BELL_LABEL_ON, color: HOME_BELL_COLOR_ON });
  const edit = (label, rel) => ({ label, offset: search.offset + rel,
    original: off.body.subarray(rel, rel + 4), patched: on.body.subarray(rel, rel + 4) });
  return [edit('home bell: label sort -> sorted', off.rel.label), edit('home bell: no theme tone', off.rel.tone),
    edit('home bell: icon colour -> copper', off.rel.color)];
}

export const HOME_BELL = { labelOff: HOME_BELL_LABEL_OFF, labelOn: HOME_BELL_LABEL_ON, colorOn: HOME_BELL_COLOR_ON };

export const CONNECTION_ENTRY_LABELS = { zh: CONNECTION_LABEL_ZH, enSuffix: CONNECTION_LABEL_EN_SUFFIX };

/**
 * Rebrands the pinned recipe outputs (unpaired.hbc + gateway-template.hbc) and
 * keeps gateway-template.json's templateSha256 in sync so the on-device
 * HermesPatcher accepts the patched template. Also adds the rokbot.3
 * Connection & Diagnostics row and publishes the list sort edits in the JSON.
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
  const unpairedConn = applyConnectionEntry(unpaired.buffer);
  const templateConn = applyConnectionEntry(template.buffer);
  const connApplied = unpairedConn.applied && templateConn.applied;
  const unpairedOut = connApplied ? unpairedConn.buffer : unpaired.buffer;
  // The header bell only matters in the paired bundle (generated from the template).
  const templateBell = connApplied ? applyHomeBarBell(templateConn.buffer) : { applied: false, reason: 'connection entry not applied', edits: [] };
  const templateOut = connApplied ? (templateBell.applied ? templateBell.buffer : templateConn.buffer) : template.buffer;
  const sortEdits = connApplied ? listSortEdits(templateOut) : null;

  const oldSha = pinned.gatewayMeta.templateSha256;
  const newSha = crypto.createHash('sha256').update(templateOut).digest('hex');
  const jsonText = pinned.gatewayTemplateJson.toString('utf8');
  if (!oldSha || jsonText.split(oldSha).length !== 2) {
    return { ...pinned, settingsRebrand: { applied: false, reason: 'templateSha256 not found in gateway-template.json', edits: [] } };
  }
  let gatewayTemplateJson = Buffer.from(jsonText.replace(oldSha, newSha), 'utf8');
  if (sortEdits) {
    const meta = JSON.parse(gatewayTemplateJson.toString('utf8'));
    meta.listSort = {
      field: LIST_SORT_FIELD,
      edits: sortEdits.map(e => ({ offset: e.offset, original: e.original.toString('hex'), patched: e.patched.toString('hex') })),
    };
    gatewayTemplateJson = Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }
  return {
    unpairedHbc: unpairedOut,
    gatewayTemplateHbc: templateOut,
    gatewayTemplateJson,
    gatewayMeta: { ...pinned.gatewayMeta, templateSha256: newSha },
    settingsRebrand: {
      applied: true,
      reason: unpaired.reason,
      edits: unpaired.edits,
      connectionEntry: {
        applied: connApplied,
        reason: connApplied ? unpairedConn.reason : (unpairedConn.applied ? `gateway-template: ${templateConn.reason}` : `unpaired: ${unpairedConn.reason}`),
        edits: connApplied ? unpairedConn.edits : [],
      },
      homeBell: { applied: templateBell.applied, reason: templateBell.reason, edits: templateBell.edits },
      listSort: { available: Boolean(sortEdits), edits: sortEdits ? sortEdits.length : 0 },
    },
  };
}

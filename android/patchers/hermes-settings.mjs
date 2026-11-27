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
//   rokbot.4 replaces these three edits by one rewrite of recencyOf and adds the
//   three titled groups (see listGroupEdits below).

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

// ---------------------------------------------------------------------------
// rokbot.6: one rokbot section right under the account card.
//
// rokbot.3 gave the former "Send Feedback" InsetGroup one row, "Connection & Diagnostics";
// rokbot.5 turned it into a titled section (+ model settings, software update) near the bottom of
// the sheet. rokbot.6 rebuilds that section as the first group after the account card and moves
// the official rows RokBot cares about into it, so nothing is listed twice:
//
//   [account card]                     (official AccountRow; the official Usage row moved out)
//   rokbot                             <- InsetGroup header (the rebrand's "rokbot" string)
//     Bot 图标样式 / Bot Icon Style     native AvatarStyleActivity
//     外观 / Appearance  <value>        official row element (memo slot 60), moved here
//     语言 / Language    <value>        official row element (memo slot 71), moved here
//     用量 / Usage                      official UsageGroup element (memo slot 19), moved here
//     模型配置 / Model Settings         native ModelsActivity
//     连接与诊断 / <Connection> & Diagnostics   native PairingActivity (rokbot.3 label)
//     应用更新 / App Updates            native UpdateActivity
//   [official groups: Connect apps, Bot, Notifications + Haptics, ..., Sign out, About]
//
// Edits (SettingsSheet, size preserving, every original byte checked first, fail closed):
//   +1254  account group: NewArray r27, 5 -> 4; children [AccountRow, Manage, Passkeys, Vault]
//          (the official Usage element is no longer listed there; the 4th write is repeated).
//   +2857  settings group: NewArray r35, 6 -> 4; [Notifications, Sound, Haptics, DataSharing]
//          (Appearance and Language are no longer listed there).
//   +3001..+3688 (the dead link-group block; rokbot.3 label builder + rokbot.5 rows) one program:
//          A (+3001, from +3773): r39 = i18n._({id:'exyUec'}); zh when it starts with 连/連:
//            r39 = 连接与诊断 or "<Connection> & Diagnostics"; r34 = [avatar, models, update]
//            labels (String.fromCharCode pairs + existing strings), then JmpLong +3788 where
//            rokbot.3 builds the connection row (r35) with the no-op onPress (r38).
//          B (from +3809): r40 = 7 rows (the native rows reuse the rokbot.3 {label, onPress}
//            shape, InsetGroupNavRow and the no-op onPress, like the connection row; the official
//            ones are read from the memo cache r7, filled earlier in this same render);
//            r19 = jsxs(InsetGroup, {header: 'rokbot', children: r40}); JmpLong +3819.
//   +3689  memo check of the group -> Jmp +3722: the section is rebuilt on every render, so
//          the moved official rows always show their current value.
//   +3809  JmpLong -> B.
//   +4224..+4264  sheet children: the rokbot section becomes child #3 (right after the account
//          group, before Intune / migration cards / update row / Connect apps / ...).
// Scratch registers: r0 (numbers), r9, r19, r32, r34, r35, r39, r40 (all written before their
// next read after +3819; r19 is the group, as before). r41+ is the call area. Labels are
// String.fromCharCode chunks (+ words that already are strings of the bundle); see emitLabel for
// why a 3-code call may only run while r40 is free.
const MENU_BLOCK = 3001;
const MENU_BLOCK_END = 3689;
export const MENU_LABELS = {
  zh: { avatar: 'Bot 图标样式', models: '模型配置', update: '应用更新' },
  en: { avatar: 'Bot Icon Style', models: 'Model Settings', update: 'App Updates' },
};
// English labels reuse words that are already strings of the bundle (cheaper than char codes).
const MENU_EN_PIECES = {
  avatar: ['Bot ', { s: 'Icon' }, ' ', { s: 'Style' }],
  models: ['Model ', { s: 'Settings' }],
  update: [{ s: 'App' }, ' Updates'],
};
export const MENU_ORDER = ['avatar', 'appearance', 'language', 'usage', 'models', 'connection', 'update'];
// Memo cache slots of the official row elements (SettingsSheet stores them before +2993).
const MEMO_SLOTS = { usage: 19, appearance: 60, language: 71 };
export const SHEET_CHILD_INDEX = 3;

function literalStrings(buf, L, base, off, n) {
  const out = [];
  let p = base + off;
  while (out.length < n) {
    const t = buf[p++];
    let cnt = t & 0x0f;
    if (t & 0x80) cnt = (cnt << 8) | buf[p++];
    const type = (t >> 4) & 7;
    for (let i = 0; i < cnt; i++) {
      if (type === 4) { out.push(stringText(buf, L, buf.readUInt32LE(p))); p += 4; }
      else if (type === 5) { out.push(stringText(buf, L, buf.readUInt16LE(p))); p += 2; }
      else if (type === 6) { out.push(stringText(buf, L, buf[p])); p += 1; }
      else return null;
    }
  }
  return out;
}

/** Keys of object shape `index` (null if they are not all strings). */
function shapeKeys(buf, L, index) {
  const keyOff = align4(L.lvOff + L.literalValueBufferSize);
  const keySize = buf.readUInt32LE(84);
  const shapeCount = buf.readUInt32LE(88);
  if (index >= shapeCount) return null;
  const tableOff = align4(keyOff + keySize);
  const at = tableOff + 8 * index;
  if (at + 8 > buf.length) return null;
  return literalStrings(buf, L, keyOff, buf.readUInt32LE(at), buf.readUInt32LE(at + 4));
}

/**
 * Emits `dst = <label>`; pieces are char runs or { id } existing strings. Char runs are
 * String.fromCharCode(...) of 2 codes (r9 / r0) per call, or 3 (r9 / r0 / r19) where allowed:
 * SettingsSheet's frame reserves outgoing-call room for Call3 only, so a Call4 also writes r40.
 * `call4` is 'all' when r40 holds nothing live (any chunk), 'first' when dst is r40 (only the
 * first chunk, whose result then lands in r40), or 'none'. this = r1 (undefined; fromCharCode
 * ignores it), r32 = fromCharCode. dst must not be r9, r0 or r19.
 */
function emitLabel(emit, dst, pieces, call4 = 'none') {
  const loadNum = (reg, code) => (code < 256 ? ins(139 /* LoadConstUInt8 */, reg, code) : ins(OPX.LoadConstInt, reg, i32le(code)));
  const loadStr = (reg, id) => (id < 65536 ? ins(OPX.LoadConstString, reg, u16le(id)) : ins(OPX.LoadConstStringLongIndex, reg, u32le(id)));
  const ARGS = [9, 0, 19];
  let first = true;
  const put = () => {
    if (first) { first = false; return dst; }
    return 9;
  };
  for (const piece of pieces) {
    if (typeof piece !== 'string') {
      const target = put();
      emit(loadStr(target, piece.id));
      if (target !== dst) emit(ins(OPX.Add, dst, dst, 9));
      continue;
    }
    for (let i = 0; i < piece.length;) {
      const wide = call4 === 'all' || (call4 === 'first' && first);
      const chunk = piece.slice(i, i + (wide ? 3 : 2));
      i += chunk.length;
      const target = put();
      [...chunk].forEach((ch, j) => emit(loadNum(ARGS[j], ch.charCodeAt(0))));
      emit(ins([OPX.Call2, OPX.Call3, OPX.Call4][chunk.length - 1], target, 32, 1, ...ARGS.slice(0, chunk.length)));
      if (target !== dst) emit(ins(OPX.Add, dst, dst, 9));
    }
  }
}

/** Expected / new bytes of a run of DefineOwnInDenseArray arr, reg, i. */
const denseWrites = (arr, list) => Buffer.concat(list.map(([reg, i]) => ins(90, arr, reg, i)));

/**
 * Rebuilds the rokbot section (see above). Input must be applyConnectionEntry() output.
 * Returns { buffer, applied, reason, edits, size }; the input is never mutated.
 */
export function applySettingsMenu(hbcBuffer) {
  const skip = reason => ({ buffer: hbcBuffer, applied: false, reason, edits: [] });
  const L = parseLayout(hbcBuffer);
  if (!L) return skip('not a Hermes v98 bytecode file');
  const buf = Buffer.from(hbcBuffer);
  const settings = findUniqueFunction(buf, L, 'SettingsSheet', 4376);
  if (!settings) return skip('SettingsSheet not found exactly once');
  const S = rel => settings.offset + rel;
  const expectAt = (abs, bytes) => buf.subarray(abs, abs + bytes.length).equals(bytes);

  const words = ['Icon', 'Style', 'Settings', 'App'];
  const wanted = new Set([BRAND_NAME, 'jsxs', 'charCodeAt', 'String', 'fromCharCode', ' ', '&', 'Diagnostics', ...words]);
  const ids = findStringIds(buf, L, wanted);
  const sid = {};
  for (const name of wanted) {
    if (ids.get(name).length !== 1) return skip(`string "${name}" not found exactly once`);
    sid[name] = ids.get(name)[0];
  }
  if (sid.jsxs >= 256 || sid.charCodeAt >= 256 || sid.String >= 65536 || sid.fromCharCode >= 65536) {
    return skip('string ids out of range');
  }
  for (const name of [' ', '&', 'Diagnostics']) if (sid[name] >= 65536) return skip(`string "${name}" needs a long index`);

  const EXY_LITERAL = 399145;
  const checks = [
    // +1254 NewArray r27, 5 ; account group children [AccountRow, Usage, Manage, Passkeys, Vault] ; +1278 PutOwnBySlotIdx r9, r27, 0
    [1254, Buffer.concat([ins(8, 27, u16le(5)), denseWrites(27, [[14, 0], [36, 1], [35, 2], [34, 3], [28, 4]]), hex('52 09 1b 00')])],
    // +1175 the Usage element (r9) is stored in memo slot 19 ; +1212 Mov r36, r9
    [1175, hex('8b 00 13 61 07 00 09')],
    [1212, hex('10 24 09')],
    // +2429 the Appearance row element (r9) -> memo slot 60 ; +2436 Mov r19, r9
    [2429, hex('8b 00 3c 61 07 00 09 10 13 09')],
    // +2688 the Language row element (r9) -> memo slot 71 ; +2695 Mov r10, r9
    [2688, hex('8b 00 47 61 07 00 09 10 0a 09')],
    // +2857 NewArray r35, 6 ; [Notifications, Sound, Appearance, Language, Haptics, DataSharing] ; +2885 PutOwnBySlotIdx r9, r35, 0
    [2857, Buffer.concat([ins(8, 35, u16le(6)), denseWrites(35, [[39, 0], [23, 1], [19, 2], [10, 3], [37, 4], [36, 5]]), hex('52 09 23 00')])],
    // rokbot.3 label builder at +3001: r39 = i18n._({id:'exyUec'})
    [3001, Buffer.concat([ins(OPX.NewObjectWithBufferLong, 39, u32le(347), u32le(EXY_LITERAL)), ins(OPX.Call2, 39, 31, 1, 39)])],
    // +3689 GetByIndex r9, r7, 103 (memo check of the group) ; +3722 LoadConstNull r19 ; +3724 JmpTrue +95, r19
    [3689, hex('5e 09 07 67')],
    [3722, hex('94 13 b0 5f 13 3b 24 06 2a')],
    // +3763 NewObjectWithBufferLong r35, 11202, 114747 ({label, onPress}) ; +3773 JmpLong -> +3001
    [3763, ins(OPX.NewObjectWithBufferLong, 35, u32le(11202), u32le(114747))],
    [3773, ins(OPX.JmpLong, i32le(3001 - 3773))],
    // +3788 PutOwnBySlotIdx r35, r39, 0 ; +3792 CreateClosureLongIndex r38, ...
    [3788, hex('52 23 27 00 85 26 26')],
    // +3803 Call3 r35, r37, r1, r36, r35 ; +3809 PutOwnBySlotIdx r32, r35, 0 ; Call3 r19, r34, r1, r33, r32
    [3803, hex('6f 23 25 01 24 23 52 20 23 00 6f 13 22 01 21 20')],
    // +3819 LoadConstUInt8 r0, 103 (memo store of the group) ; +3847 Mov r9, r19
    [3819, hex('8b 00 67')],
    [3847, hex('10 09 13')],
    // +4212 NewArray r20, 17 ; sheet children
    [4212, Buffer.concat([ins(8, 20, u16le(17)), denseWrites(20, [[30, 0], [29, 1], [15, 2], [28, 3], [27, 4], [14, 5], [12, 6],
      [26, 7], [25, 8], [24, 9], [11, 10], [23, 11], [10, 12], [9, 13], [8, 14], [22, 15], [21, 16]])])],
  ];
  for (const [rel, bytes] of checks) {
    if (!expectAt(S(rel), bytes)) return skip(`SettingsSheet bytes differ at +${rel}`);
  }
  // rokbot.3 label builder ends with a JmpLong to +3788 and is followed by free padding.
  let free = MENU_BLOCK_END;
  while (free > MENU_BLOCK && buf[S(free - 1)] === OP.AsyncBreakCheck) free--;
  if (free > 3160 || !expectAt(S(free - 5), ins(OPX.JmpLong, i32le(3788 - (free - 5))))) return skip('rokbot.3 label builder not found');
  // Shapes: 11202 {label, onPress}; 10320 {header, children}; both with the two-null values at 114747.
  const rowKeys = shapeKeys(buf, L, 11202);
  const groupKeys = shapeKeys(buf, L, 10320);
  if (!rowKeys || rowKeys.join() !== 'label,onPress') return skip('row shape differs');
  if (!groupKeys || groupKeys.join() !== 'header,children') return skip('group shape differs');
  if (buf[L.lvOff + 114747] !== 0x02) return skip('two-null literal differs');

  const resolve = pieces => pieces.map(p => (typeof p === 'string' ? p : { id: sid[p.s] }));

  // --- one program over the dead block -----------------------------------------
  const code = [];
  let pos = MENU_BLOCK;
  const emit = b => { code.push(b); pos += b.length; };
  const fix = [];                                                  // [at, operandOffset, label]
  const labels = {};
  const jumpLong = (op, label, ...regs) => { fix.push([pos, 1, label]); emit(ins(op, i32le(0), ...regs)); };
  const here = name => { labels[name] = pos; };

  // A: labels (entered from +3773 with r35 = {label, onPress} object; r35 kept).
  emit(ins(OPX.NewObjectWithBufferLong, 39, u32le(347), u32le(EXY_LITERAL)));
  emit(ins(OPX.Call2, 39, 31, 1, 39));                            // r39 = i18n._({id:'exyUec'})
  emit(ins(OPX.GetByIdShort, 40, 39, 45, sid.charCodeAt));
  emit(ins(OPX.LoadConstZero, 9));
  emit(ins(OPX.Call2, 0, 40, 39, 9));                             // r0 = r39.charCodeAt(0)
  emit(ins(OPX.GetGlobalObject, 19));
  emit(ins(OPX.TryGetById, 19, 19, 52, u16le(sid.String)));       // r19 = String
  emit(ins(OPX.GetById, 32, 19, 46, u16le(sid.fromCharCode)));    // r32 = String.fromCharCode
  emit(ins(8 /* NewArray */, 34, u16le(3)));                       // r34 = [avatar, models, update] labels
  emit(ins(OPX.LoadConstInt, 9, i32le(0x8fde)));                  // 连
  jumpLong(212 /* JStrictEqualLong */, 'zh', 0, 9);
  emit(ins(OPX.LoadConstInt, 9, i32le(0x9023)));                  // 連
  jumpLong(212, 'zh', 0, 9);
  emit(ins(OPX.LoadConstString, 9, u16le(sid[' '])));
  emit(ins(OPX.Add, 39, 39, 9));
  emit(ins(OPX.LoadConstString, 40, u16le(sid['&'])));
  emit(ins(OPX.Add, 39, 39, 40));
  emit(ins(OPX.Add, 39, 39, 9));
  emit(ins(OPX.LoadConstString, 40, u16le(sid.Diagnostics)));
  emit(ins(OPX.Add, 39, 39, 40));                                 // "<Connection> & Diagnostics"
  ['avatar', 'models', 'update'].forEach((key, i) => {
    emitLabel(emit, 40, resolve(MENU_EN_PIECES[key]), 'first');
    emit(ins(90, 34, 40, i));
  });
  jumpLong(OPX.JmpLong, 'back');
  here('zh');
  emitLabel(emit, 39, ['连接与诊断'], 'all');                       // r40 is free here
  ['avatar', 'models', 'update'].forEach((key, i) => {
    emitLabel(emit, 40, [MENU_LABELS.zh[key]], 'first');
    emit(ins(90, 34, 40, i));
  });
  jumpLong(OPX.JmpLong, 'back');

  // B: rows (entered from +3809 with r35 = connection row element, r34 = labels).
  here('rows');
  emit(ins(8, 40, u16le(MENU_ORDER.length)));
  emit(ins(90, 40, 35, MENU_ORDER.indexOf('connection')));
  ['avatar', 'models', 'update'].forEach((key, i) => {
    emit(ins(94 /* GetByIndex */, 39, 34, i));
    emit(ins(OPX.NewObjectWithBufferLong, 35, u32le(11202), u32le(114747)));
    emit(ins(82 /* PutOwnBySlotIdx */, 35, 39, 0));
    emit(ins(82, 35, 38, 1));                                     // onPress: rokbot.3 no-op
    emit(ins(OPX.Call3, 35, 37, 1, 36, 35));                      // jsx(InsetGroupNavRow, props)
    emit(ins(90, 40, 35, MENU_ORDER.indexOf(key)));
  });
  for (const key of ['appearance', 'language', 'usage']) {
    emit(ins(94, 9, 7, MEMO_SLOTS[key]));                         // the official element of this render
    emit(ins(90, 40, 9, MENU_ORDER.indexOf(key)));
  }
  emit(ins(OPX.NewObjectWithBufferLong, 32, u32le(10320), u32le(114747)));
  emit(sid[BRAND_NAME] < 65536
    ? ins(OPX.LoadConstString, 39, u16le(sid[BRAND_NAME]))
    : ins(OPX.LoadConstStringLongIndex, 39, u32le(sid[BRAND_NAME])));
  emit(ins(82, 32, 39, 0));                                       // header: 'rokbot'
  emit(ins(82, 32, 40, 1));                                       // children
  emit(ins(59 /* LoadFromEnvironment */, 34, 6, 42));
  emit(ins(OPX.GetByIdShort, 34, 34, 45, sid.jsxs));
  emit(ins(OPX.Call3, 19, 34, 1, 33, 32));                        // r19 = jsxs(InsetGroup, props)
  labels.back = 3788;
  labels.memo = 3819;
  jumpLong(OPX.JmpLong, 'memo');
  const block = Buffer.concat(code);
  for (const [at, off, label] of fix) block.writeInt32LE(labels[label] - at, at - MENU_BLOCK + off);
  if (MENU_BLOCK + block.length > MENU_BLOCK_END) return skip(`menu block does not fit (${block.length} bytes)`);

  const edits = [];
  const write = (label, abs, bytes) => { bytes.copy(buf, abs); edits.push(label); };
  write('settings: account group without the Usage row', S(1254), Buffer.concat([
    ins(8, 27, u16le(4)), denseWrites(27, [[14, 0], [35, 1], [34, 2], [28, 3], [28, 3]]),
  ]));
  write('settings: preferences group without Appearance and Language', S(2857), Buffer.concat([
    ins(8, 35, u16le(4)), denseWrites(35, [[39, 0], [23, 1], [37, 2], [36, 3], [36, 3], [36, 3]]),
  ]));
  write('settings: rokbot section program in the dead link-group block', S(MENU_BLOCK), Buffer.concat([
    block, Buffer.alloc(MENU_BLOCK_END - MENU_BLOCK - block.length, OP.AsyncBreakCheck),
  ]));
  write('settings: rokbot section rebuilt on every render', S(3689), Buffer.from([174 /* Jmp */, 3722 - 3689, OP.AsyncBreakCheck, OP.AsyncBreakCheck]));
  write('settings: feedback group -> rokbot section', S(3809), Buffer.concat([
    ins(OPX.JmpLong, i32le(labels.rows - 3809)), Buffer.alloc(5, OP.AsyncBreakCheck),
  ]));
  write('settings: rokbot section right after the account group', S(4224), denseWrites(20, [
    [15, 2], [9, SHEET_CHILD_INDEX], [28, 4], [27, 5], [14, 6], [12, 7], [26, 8], [25, 9], [24, 10], [11, 11], [23, 12], [10, 13],
  ]));
  const sha1 = crypto.createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  sha1.copy(buf, buf.length - 20);
  return { buffer: buf, applied: true, reason: 'rokbot section right under the account card', edits, size: block.length };
}

// ---------------------------------------------------------------------------
// rokbot.5b: the list arrangement switches in place, and its groups fold.
//
// rokbot.3/4 baked the mode into the paired bundle: the bell regenerated the bundle and reloaded
// React Native. Now the paired bundle always carries both arrangements and the mode lives in the
// official collapsed-sections state (AgentsService: query cache + device mirror), as the id
// 'sorted': the bell toggles it like a section fold, React re-renders the list in place and the
// choice survives cold starts. global.sorted mirrors it for recencyOf (the sort runs before the
// sections are resolved). Edits (size preserving, every original byte checked first):
//
//   recencyOf (whole body)       global.sorted ? lastMessageAt ?? lastActivityAt ?? 0 (never before
//                                createdAt) : the official 'activity' / 'row-updated' recency.
//   SidebarSectionsView.resolve  +18..+47  sections <- FeedbackSheet.call(params).
//   toggleSectionCollapsed +43   folds any id, not only the user's own sections (the generated
//                                groups and the 'sorted' mode flag); the choice is remembered by the
//                                official device mirror.
//   SearchButton (whole body)    returns FeedbackSheet(props, 1).
//   FeedbackSheet (whole body)   unreachable since applyConnectionEntry; three entry points:
//     (A) this = resolve params, no argument: the mode is collapsedSectionIds.includes('sorted');
//         off -> params.sections; on -> [{id, name, agentIds}] for the non-empty groups
//         Needs attention (pendingAction / awaitingUserResponse) -> In progress (isRunning /
//         isComposingMessage) -> Unread (hasUnread / unreadThreadCount) -> Read, rows kept in
//         the sorted order. The official section filter and fold logic do the rest.
//     (B) (props, 1) from SearchButton: the bell (label 'sort' / 'sorted', copper when on) and
//         the original Search button; hooks: useLingui, useCollapsedSectionIdsQuery (the bell
//         re-renders with the mode) and useSessionService(AgentsService.token), reached through
//         metro's __r with the module ids checked at build time.
//     (C) (pressEvent) the bell's onPress (closure over the AgentsService instance): flips
//         global.sorted and toggles 'sorted'. Nothing throws if the service is missing.
//   Titles are String.fromCharCode(...) of the Web wording; zh and en bodies are published, the
//   companion applies one (HermesPatcher). Registers follow each frame's number / non-pointer /
//   pointer split.
//
// Property caches: every GetById / TryGetById / PutById of a new body gets a real cache index, one
// per property name and kind (read / write), as the Hermes compiler allocates them, and the
// function header's ReadCacheSize / WriteCacheSize is raised (a verified header edit) when the
// body needs more entries than the official function had. Hermes v98 has no "caching disabled"
// index for these opcodes: the interpreter indexes CodeBlock's trailing cache arrays with the
// operand directly (the bound is only an assert), so the 255 used before read and wrote heap
// memory far past the cache and crashed the JS thread (SIGSEGV in libhermesvm) on cold starts.

export const LIST_MODE_ID = 'sorted';
export const LIST_GROUP_IDS = ['pending', 'running', 'unread', 'read'];
export const LIST_GROUP_TITLES = {
  zh: ['待处理', '进行中', '未读', '已读'],
  en: ['Needs attention', 'In progress', 'Unread', 'Read'],
};
const OPG = {
  NewObjectWithBufferLong: 2, NewObjectWithBuffer: 1, NewArray: 8, Mov: 16, Not: 19, StrictEq: 23, Add: 30,
  GetParentEnvironment: 52, StoreToEnvironment: 55, LoadFromEnvironment: 59, GetGlobalObject: 61,
  CreateFunctionEnvironment: 64, GetByIdShort: 68, GetById: 69, GetByIdLong: 70, TryGetById: 72, PutByIdLoose: 74,
  PutOwnBySlotIdx: 82, DefineOwnInDenseArray: 90, GetByVal: 93, Call1: 108, Call2: 110, Call3: 111, Call4: 112,
  Ret: 118, AsyncBreakCheck: 126, CreateClosure: 132, LoadParam: 137, LoadConstUInt8: 139, LoadConstInt: 140,
  LoadConstString: 144, LoadConstStringLongIndex: 145, LoadConstUndefined: 147, LoadConstNull: 148,
  LoadConstTrue: 149, LoadConstFalse: 150, LoadConstZero: 151,
  Jmp: 174, JmpTrue: 176, JmpFalse: 178, JmpUndefined: 180, JNotLess: 185, JGreater: 199, JNotEqual: 209,
  JStrictEqual: 211,
};
const JUMP_OPS = new Set([OPG.Jmp, OPG.JmpTrue, OPG.JmpFalse, OPG.JmpUndefined, OPG.JNotLess, OPG.JGreater, OPG.JNotEqual, OPG.JStrictEqual]);

/**
 * Tiny assembler. Jumps are relative to the jump instruction's first byte; `jump` emits the
 * Addr8 form, `far` the Addr32 form (opcode + 1).
 */
function assembler() {
  const parts = [];
  const labels = {};
  const fixups = [];
  const readCache = new Map();
  const writeCache = new Map();
  const cacheIndex = (map, id) => {
    if (!map.has(id)) map.set(id, map.size);
    if (map.size > 255) throw new Error('more than 255 property cache entries');
    return map.get(id);
  };
  let pos = 0;
  const a = {
    /** Read cache index for property name `id` (one per name, as the Hermes compiler assigns them). */
    rc(id) { return cacheIndex(readCache, id); },
    /** Write cache index for property name `id`. */
    wc(id) { return cacheIndex(writeCache, id); },
    get readCacheSize() { return readCache.size; },
    get writeCacheSize() { return writeCache.size; },
    emit(b) { parts.push(b); pos += b.length; return a; },
    jump(op, label, ...regs) {
      if (!JUMP_OPS.has(op)) throw new Error(`not a jump: ${op}`);
      fixups.push({ at: pos, label, long: false });
      return a.emit(Buffer.from([op, 0, ...regs]));
    },
    far(op, label, ...regs) {
      if (!JUMP_OPS.has(op)) throw new Error(`not a jump: ${op}`);
      fixups.push({ at: pos, label, long: true });
      return a.emit(Buffer.from([op + 1, 0, 0, 0, 0, ...regs]));
    },
    label(name) { if (name in labels) throw new Error(`label ${name} twice`); labels[name] = pos; return a; },
    get pos() { return pos; },
    build() {
      const body = Buffer.concat(parts);
      for (const f of fixups) {
        if (!(f.label in labels)) throw new Error(`label ${f.label} missing`);
        const d = labels[f.label] - f.at;
        if (f.long) body.writeInt32LE(d, f.at + 1);
        else {
          if (d < -128 || d > 127) throw new Error(`jump to ${f.label} out of range`);
          body.writeInt8(d, f.at + 1);
        }
      }
      body.readCacheSize = readCache.size;
      body.writeCacheSize = writeCache.size;
      return body;
    },
  };
  return a;
}

function loadString(a, reg, id) {
  return id < 65536 ? a.emit(ins(OPG.LoadConstString, reg, u16le(id))) : a.emit(ins(OPG.LoadConstStringLongIndex, reg, u32le(id)));
}

function getById(a, dst, obj, id) {
  if (id < 256) return a.emit(ins(OPG.GetByIdShort, dst, obj, a.rc(id), id));
  if (id < 65536) return a.emit(ins(OPG.GetById, dst, obj, a.rc(id), u16le(id)));
  return a.emit(ins(OPG.GetByIdLong, dst, obj, a.rc(id), u32le(id)));
}

function tryGetById(a, dst, obj, id) {
  if (id >= 65536) throw new Error('TryGetById needs a 16-bit string id');
  return a.emit(ins(OPG.TryGetById, dst, obj, a.rc(id), u16le(id)));
}

function putByIdLoose(a, obj, value, id) {
  if (id >= 65536) throw new Error('PutByIdLoose needs a 16-bit string id');
  return a.emit(ins(OPG.PutByIdLoose, obj, value, a.wc(id), u16le(id)));
}

// Strings the new bodies use. Property names (GetById / PutById / TryGetById) must be identifiers;
// 'pending' + 'Action' is read with GetByVal: "pendingAction" is not a string of this bundle.
const LIVE_PROPS = ['awaitingUserResponse', 'isRunning', 'isComposingMessage', 'hasUnread', 'unreadThreadCount',
  'lastActivityAt', 'updatedAt', 'createdAt', 'localActivityAt', 'isTeammateSharedBot', 'Math', 'max', 'id', 'push', 'length',
  'String', 'fromCharCode', 'Array', 'isArray', 'includes', 'agents', 'sections', 'collapsedSectionIds', '__r',
  'useCollapsedSectionIdsQuery', 'data', 'useSessionService', 'AgentsService', 'token', 'currentCollapsedSections',
  'toggleSectionCollapsed', 'isSelected', 'onPress', 'useLingui', '_', 'jsx', 'CursorIcon', 'SandButton', LIST_MODE_ID,
  LIST_SORT_FIELD];
const LIVE_TEXTS = ['pending', 'Action', 'running', 'unread', 'read', 'activity', 'row-updated', 'bell', 'sort', 'primary',
  '#C27400'];

function liveStrings(buf, L) {
  const names = new Set([...LIVE_PROPS, ...LIVE_TEXTS]);
  const ids = findStringIds(buf, L, names);
  const g = {};
  for (const name of names) {
    if (ids.get(name).length !== 1) return null;
    g[name] = ids.get(name)[0];
  }
  for (const name of LIVE_PROPS) if (stringIsPlain(buf, L, g[name])) return null;
  return g;
}

// Metro module ids (fn0 __d(factory, id, deps)) of the modules the bell reaches with __r, and
// the export each one must define.
const LIVE_MODULES = [
  { key: 'queries', factorySize: 2591, export: 'useCollapsedSectionIdsQuery' },
  { key: 'session', factorySize: null, export: 'useSessionService' },
  { key: 'agents', factorySize: 3471, export: 'AgentsService' },
];

/** factory function index -> metro module id, from the global function's __d(...) calls. */
function metroModuleIds(buf, L, g) {
  const fn0 = functionInfo(buf, L, 0);
  const sidD = findStringIds(buf, L, new Set(['__d'])).get('__d');
  if (sidD.length !== 1) return null;
  const out = new Map();
  const end = fn0.offset + fn0.size;
  // TryGetById rA, rG, c, '__d' ; LoadConstUInt8|LoadConstInt|LoadConstZero rId ; NewArray* ; CreateClosure rF, rE, fn
  const tryD = Buffer.concat([Buffer.from([OPG.TryGetById]), Buffer.alloc(3), u16le(sidD[0])]);
  for (let p = fn0.offset; p < end - 8; p++) {
    if (buf[p] !== OPG.TryGetById || buf.readUInt16LE(p + 4) !== sidD[0]) continue;
    let q = p + tryD.length, id;
    if (buf[q] === OPG.LoadConstUInt8) { id = buf[q + 2]; q += 3; }
    else if (buf[q] === OPG.LoadConstInt) { id = buf.readInt32LE(q + 2); q += 6; }
    else if (buf[q] === OPG.LoadConstZero) { id = 0; q += 2; }
    else continue;
    // NewArrayWithBuffer (8 bytes) / NewArrayWithBufferLong (10) / NewArray (4)
    if (buf[q] === 6) q += 8; else if (buf[q] === 7) q += 10; else if (buf[q] === OPG.NewArray) q += 4; else continue;
    if (buf[q] === OPG.CreateClosure) out.set(buf.readUInt16LE(q + 3), id);
    else if (buf[q] === 133) out.set(buf.readUInt32LE(q + 3), id);
  }
  return out;
}

/** The metro module id whose factory exports `name` (PutById exports.name or defineProperty(exports, 'name')). */
function moduleExporting(buf, L, modules, name, nameId) {
  const hits = [];
  for (const [index, id] of modules) {
    const f = functionInfo(buf, L, index);
    const body = buf.subarray(f.offset, f.offset + f.size);
    for (let p = 0; p + 6 <= body.length; p++) {
      const op = body[p];
      if ((op === 75 || op === 74) && body.readUInt16LE(p + 4) === nameId) { hits.push(id); break; }   // PutByIdStrict/Loose exports.name
      if (op === OPG.LoadConstString && body.readUInt16LE(p + 2) === nameId && body[p + 4] === OPG.Call4) { hits.push(id); break; }
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/** recencyOf: global.sorted ? last message : the official recency. r0 number, r1 non-pointer. */
function recencyLiveBody(g) {
  const a = assembler();
  a.emit(ins(OPG.LoadParam, 2, 1));                        // row
  a.emit(ins(OPG.LoadParam, 4, 2));                        // mode
  a.emit(ins(OPG.GetGlobalObject, 3));
  tryGetById(a, 7, 3, g.Math);
  getById(a, 6, 7, g.max);
  a.emit(ins(OPG.LoadConstNull, 1));
  getById(a, 5, 3, g[LIST_MODE_ID]);                      // global.sorted (undefined when never set)
  a.jump(OPG.JmpTrue, 'ours', 5);
  loadString(a, 5, g.activity);
  a.jump(OPG.JStrictEqual, 'act', 5, 4);
  loadString(a, 5, g['row-updated']);
  a.jump(OPG.JStrictEqual, 'row', 5, 4);
  a.emit(ins(OPG.LoadConstUndefined, 5));
  a.emit(ins(OPG.Ret, 5));
  a.label('row');                                          // official 'row-updated'
  a.emit(ins(OPG.GetParentEnvironment, 5, 0));
  a.emit(ins(OPG.LoadFromEnvironment, 8, 5, 1));
  getById(a, 5, 8, g.isTeammateSharedBot);
  a.emit(ins(OPG.Call2, 5, 5, 8, 2));
  a.jump(OPG.JmpTrue, 'shared', 5);
  getById(a, 4, 2, g.lastActivityAt);
  a.jump(OPG.JNotEqual, 'upd', 4, 1);
  a.emit(ins(OPG.LoadConstZero, 4));
  a.label('upd');
  getById(a, 3, 2, g.updatedAt);
  a.jump(OPG.Jmp, 'max2');                                 // max(lastActivityAt ?? 0, updatedAt)
  a.label('ours');
  getById(a, 4, 2, g[LIST_SORT_FIELD]);
  a.jump(OPG.JNotEqual, 'created', 4, 1);                  // lastMessageAt ?? ...
  a.label('shared');
  getById(a, 4, 2, g.lastActivityAt);
  a.jump(OPG.JNotEqual, 'created', 4, 1);
  a.emit(ins(OPG.LoadConstZero, 4));
  a.label('created');
  getById(a, 3, 2, g.createdAt);
  a.label('max2');
  a.emit(ins(OPG.Call3, 3, 6, 7, 4, 3));
  a.emit(ins(OPG.Ret, 3));
  a.label('act');                                          // official 'activity'
  getById(a, 4, 2, g.localActivityAt);
  a.jump(OPG.JNotEqual, 'la', 4, 1);
  a.emit(ins(OPG.LoadConstZero, 4));
  a.label('la');
  getById(a, 5, 2, g.lastActivityAt);
  a.jump(OPG.JNotEqual, 'ca', 5, 1);
  a.emit(ins(OPG.LoadConstZero, 5));
  a.label('ca');
  getById(a, 3, 2, g.createdAt);
  a.emit(ins(OPG.Call4, 3, 6, 7, 4, 5, 3));
  a.emit(ins(OPG.Ret, 3));
  return a.build();
}

/** r2 (non-pointer) = Array.isArray(list) && list.includes('sorted'); scratch r10..r13 (pointers). */
function emitModeOf(a, g, list, tag) {
  a.emit(ins(OPG.LoadConstFalse, 2));
  a.emit(ins(OPG.GetGlobalObject, 10));
  tryGetById(a, 11, 10, g.Array);
  getById(a, 12, 11, g.isArray);
  a.emit(ins(OPG.Call2, 12, 12, 11, list));
  a.far(OPG.JmpFalse, `${tag}:off`, 12);
  getById(a, 12, list, g.includes);
  loadString(a, 13, g[LIST_MODE_ID]);
  a.emit(ins(OPG.Call2, 12, 12, list, 13));
  a.far(OPG.JmpFalse, `${tag}:off`, 12);
  a.emit(ins(OPG.LoadConstTrue, 2));
  a.label(`${tag}:off`);
}

function emitTitle(a, dst, title, { str, fcc, tmp, codesBase }) {
  const codes = [...title].map(ch => ch.codePointAt(0));
  if (codes.some(c => c > 0xffff)) throw new Error('title outside the BMP');
  for (let k = 0; k < codes.length; k += 3) {
    const chunk = codes.slice(k, k + 3);
    chunk.forEach((c, j) => a.emit(ins(OPG.LoadConstInt, codesBase + j, i32le(c))));
    const out = k === 0 ? dst : tmp;
    a.emit(ins([OPG.Call2, OPG.Call3, OPG.Call4][chunk.length - 1], out, fcc, str, ...chunk.map((_, j) => codesBase + j)));
    if (k > 0) a.emit(ins(OPG.Add, dst, dst, tmp));
  }
}

/**
 * FeedbackSheet's new body (see above): (props, 1) -> B, no receiver -> C, else A. Frame: r0-r1 number, r2-r5 non-pointer, r6.. pointer.
 * `ctx`: { g, selfIndex, modules: {queries, session, agents}, titles }.
 */
function feedbackSheetLiveBody({ g, selfIndex, modules, titles }) {
  const a = assembler();
  const PROP = (dst, obj, name) => getById(a, dst, obj, g[name]);
  // (props, 1) -> B; this == null -> C (an event handler is called without a receiver); else A.
  a.emit(ins(OPG.LoadParam, 6, 1));
  a.emit(ins(OPG.LoadParam, 7, 2));
  a.far(OPG.JmpUndefined, 'notB', 7);
  a.far(OPG.Jmp, 'B');
  a.label('notB');
  a.emit(ins(OPG.LoadParam, 8, 0));
  a.emit(ins(OPG.LoadConstNull, 3));
  a.far(OPG.JNotEqual, 'A', 8, 3);
  a.far(OPG.Jmp, 'C');

  a.label('B');

  // (B) the bell + Search, rendered for SearchButton (props in r6).
  a.emit(ins(OPG.GetParentEnvironment, 8, 0));             // SearchButton's module scope
  a.emit(ins(OPG.LoadConstUndefined, 4));
  a.emit(ins(OPG.LoadFromEnvironment, 9, 8, 1));
  PROP(9, 9, 'useLingui');
  a.emit(ins(OPG.Call1, 9, 9, 4));                         // useLingui() (as SearchButton did)
  PROP(14, 9, '_');                                        // i18n._
  a.emit(ins(OPG.LoadFromEnvironment, 15, 8, 4));
  PROP(15, 15, 'jsx');
  a.emit(ins(OPG.LoadFromEnvironment, 16, 8, 3));
  PROP(16, 16, 'CursorIcon');
  a.emit(ins(OPG.LoadFromEnvironment, 17, 8, 2));
  PROP(17, 17, 'SandButton');
  a.emit(ins(OPG.GetGlobalObject, 18));
  tryGetById(a, 19, 18, g.__r);
  a.emit(ins(OPG.LoadConstInt, 20, i32le(modules.queries)));
  a.emit(ins(OPG.Call2, 20, 19, 4, 20));
  PROP(20, 20, 'useCollapsedSectionIdsQuery');
  a.emit(ins(OPG.Call1, 20, 20, 4));                       // hook: re-renders the bell with the mode
  PROP(21, 20, 'data');
  emitModeOf(a, g, 21, 'B');                               // r2 = mode
  putByIdLoose(a, 18, 2, g[LIST_MODE_ID]);
  a.emit(ins(OPG.LoadConstInt, 22, i32le(modules.session)));
  a.emit(ins(OPG.Call2, 22, 19, 4, 22));
  PROP(22, 22, 'useSessionService');
  a.emit(ins(OPG.LoadConstInt, 23, i32le(modules.agents)));
  a.emit(ins(OPG.Call2, 23, 19, 4, 23));
  PROP(23, 23, 'AgentsService');
  PROP(23, 23, 'token');
  a.emit(ins(OPG.Call2, 22, 22, 4, 23));                   // hook: the AgentsService instance
  a.emit(ins(OPG.CreateFunctionEnvironment, 24, 1));
  a.emit(ins(OPG.StoreToEnvironment, 24, 0, 22));
  a.emit(ins(OPG.CreateClosure, 25, 24, u16le(selfIndex)));    // onPress -> (C)
  // bell icon {name:'bell', variant, size:20, tone, color, weight:'medium'}
  a.emit(ins(OPG.NewObjectWithBufferLong, 26, u32le(9325), u32le(ICON_COLOR_LITERAL)));
  loadString(a, 27, g.bell);
  a.emit(ins(OPG.PutOwnBySlotIdx, 26, 27, 0));
  a.emit(ins(OPG.PutOwnBySlotIdx, 26, 4, 1));               // variant: undefined (the literal has null)
  a.emit(ins(OPG.LoadConstUInt8, 27, 20));
  a.emit(ins(OPG.PutOwnBySlotIdx, 26, 27, 2));
  a.jump(OPG.JmpTrue, 'Bon', 2);
  loadString(a, 27, g.primary);
  a.emit(ins(OPG.PutOwnBySlotIdx, 26, 27, 3));              // tone 'primary'
  a.emit(ins(OPG.PutOwnBySlotIdx, 26, 4, 4));               // color undefined
  loadString(a, 28, g.sort);
  a.jump(OPG.Jmp, 'Bicon');
  a.label('Bon');
  a.emit(ins(OPG.PutOwnBySlotIdx, 26, 4, 3));               // no tone (a tone wins over color)
  loadString(a, 27, g['#C27400']);
  a.emit(ins(OPG.PutOwnBySlotIdx, 26, 27, 4));              // copper
  loadString(a, 28, g[LIST_MODE_ID]);                      // label 'sorted'
  a.label('Bicon');
  a.emit(ins(OPG.Call3, 26, 15, 4, 16, 26));               // <CursorIcon/>
  a.emit(ins(OPG.NewObjectWithBuffer, 27, u16le(9332), u16le(TOOLBAR_BUTTON_LITERAL)));
  a.emit(ins(OPG.PutOwnBySlotIdx, 27, 28, 1));              // accessibilityLabel
  a.emit(ins(OPG.PutOwnBySlotIdx, 27, 25, 2));              // onPress
  a.emit(ins(OPG.PutOwnBySlotIdx, 27, 26, 3));              // icon
  a.emit(ins(OPG.Call3, 29, 15, 4, 17, 27));               // r29 = bell <SandButton/>
  PROP(30, 6, 'isSelected');
  a.jump(OPG.JmpFalse, 'Bonly', 30);
  PROP(31, 6, 'onPress');
  a.emit(ins(OPG.NewObjectWithBufferLong, 32, u32le(347), u32le(SEARCH_LABEL_LITERAL)));
  a.emit(ins(OPG.Call2, 32, 14, 4, 32));                   // i18n._({id:'A1taO8'}) "Search"
  a.emit(ins(OPG.NewObjectWithBuffer, 33, u16le(9332), u16le(TOOLBAR_BUTTON_LITERAL)));
  a.emit(ins(OPG.PutOwnBySlotIdx, 33, 32, 1));
  a.emit(ins(OPG.PutOwnBySlotIdx, 33, 31, 2));
  a.emit(ins(OPG.NewObjectWithBufferLong, 34, u32le(8894), u32le(SEARCH_ICON_LITERAL)));
  a.emit(ins(OPG.Call3, 34, 15, 4, 16, 34));
  a.emit(ins(OPG.PutOwnBySlotIdx, 33, 34, 3));
  a.emit(ins(OPG.Call3, 34, 15, 4, 17, 33));               // the original Search button
  a.emit(ins(OPG.NewArray, 35, u16le(2)));
  a.emit(ins(OPG.DefineOwnInDenseArray, 35, 29, 0));
  a.emit(ins(OPG.DefineOwnInDenseArray, 35, 34, 1));
  a.emit(ins(OPG.Ret, 35));
  a.label('Bonly');
  a.emit(ins(OPG.Ret, 29));

  // (C) bell onPress: flip the mode (closure env slot 0 = AgentsService instance).
  a.label('C');
  a.emit(ins(OPG.LoadConstUndefined, 4));
  a.emit(ins(OPG.GetParentEnvironment, 8, 0));
  a.emit(ins(OPG.LoadFromEnvironment, 9, 8, 0));
  a.emit(ins(OPG.LoadConstNull, 3));
  a.far(OPG.JNotEqual, 'Csvc', 9, 3);
  a.emit(ins(OPG.Ret, 4));
  a.label('Csvc');
  PROP(14, 9, 'toggleSectionCollapsed');
  a.far(OPG.JmpUndefined, 'Cdone', 14);
  PROP(15, 9, 'currentCollapsedSections');
  a.far(OPG.JmpUndefined, 'Cdone', 15);
  a.emit(ins(OPG.Call1, 15, 15, 9));
  emitModeOf(a, g, 15, 'C');
  a.emit(ins(OPG.Not, 3, 2));
  a.emit(ins(OPG.GetGlobalObject, 16));
  putByIdLoose(a, 16, 3, g[LIST_MODE_ID]);   // before the re-render sorts
  loadString(a, 17, g[LIST_MODE_ID]);
  a.emit(ins(OPG.Call2, 14, 14, 9, 17));                   // toggleSectionCollapsed('sorted')
  a.label('Cdone');
  a.emit(ins(OPG.Ret, 4));

  // (A) sections for SidebarSectionsView.resolve (this = its params).
  a.label('A');
  PROP(9, 8, 'collapsedSectionIds');                       // r8 = this
  emitModeOf(a, g, 9, 'A');
  putByIdLoose(a, 10, 2, g[LIST_MODE_ID]);   // r10 = global (emitModeOf)
  a.far(OPG.JmpTrue, 'Agroups', 2);
  PROP(6, 8, 'sections');
  a.emit(ins(OPG.Ret, 6));                                 // official: the user's sections
  a.label('Agroups');
  PROP(9, 8, 'agents');
  const arrays = [14, 15, 16, 17];                         // pending, running, unread, read
  for (const r of arrays) a.emit(ins(OPG.NewArray, r, u16le(0)));
  PROP(18, 9, 'length');
  a.emit(ins(OPG.LoadConstZero, 19));                      // i (a number in a pointer register)
  a.emit(ins(OPG.LoadConstUInt8, 26, 1));
  a.label('Aloop');
  a.far(OPG.JNotLess, 'Adone', 19, 18);
  a.emit(ins(OPG.GetByVal, 20, 9, 19));                    // row
  a.emit(ins(OPG.LoadConstNull, 3));
  loadString(a, 22, g.pending);
  loadString(a, 23, g.Action);
  a.emit(ins(OPG.Add, 23, 22, 23));
  a.emit(ins(OPG.GetByVal, 23, 20, 23));
  a.far(OPG.JNotEqual, 'AP', 23, 3);                       // row.pendingAction != null
  PROP(23, 20, 'awaitingUserResponse');
  a.far(OPG.JNotEqual, 'AP', 23, 3);
  a.emit(ins(OPG.LoadConstTrue, 5));
  PROP(23, 20, 'isRunning');
  a.far(OPG.JStrictEqual, 'AR', 23, 5);
  PROP(23, 20, 'isComposingMessage');
  a.far(OPG.JStrictEqual, 'AR', 23, 5);
  PROP(23, 20, 'hasUnread');
  a.far(OPG.JmpTrue, 'AU', 23);
  PROP(23, 20, 'unreadThreadCount');
  a.emit(ins(OPG.LoadConstZero, 3));
  a.far(OPG.JGreater, 'AU', 23, 3);
  a.emit(ins(OPG.Mov, 21, 17));
  a.far(OPG.Jmp, 'Apush');
  a.label('AP');
  a.emit(ins(OPG.Mov, 21, 14));
  a.far(OPG.Jmp, 'Apush');
  a.label('AR');
  a.emit(ins(OPG.Mov, 21, 15));
  a.far(OPG.Jmp, 'Apush');
  a.label('AU');
  a.emit(ins(OPG.Mov, 21, 16));
  a.label('Apush');
  PROP(24, 21, 'push');
  PROP(25, 20, 'id');
  a.emit(ins(OPG.Call2, 24, 24, 21, 25));
  a.emit(ins(OPG.Add, 19, 19, 26));
  a.far(OPG.Jmp, 'Aloop');
  a.label('Adone');
  tryGetById(a, 10, 10, g.String);
  PROP(11, 10, 'fromCharCode');
  a.emit(ins(OPG.NewArray, 7, u16le(0)));
  LIST_GROUP_IDS.forEach((id, i) => {
    PROP(24, arrays[i], 'length');
    a.emit(ins(OPG.LoadConstZero, 3));
    a.far(OPG.JStrictEqual, `Askip${i}`, 24, 3);            // empty groups are left out
    a.emit(ins(OPG.NewObjectWithBufferLong, 8, u32le(SECTION_SHAPE), u32le(SECTION_VALUES)));
    loadString(a, 9, g[id]);
    a.emit(ins(OPG.PutOwnBySlotIdx, 8, 9, 0));              // id
    emitTitle(a, 9, titles[i], { str: 10, fcc: 11, tmp: 28, codesBase: 29 });
    a.emit(ins(OPG.PutOwnBySlotIdx, 8, 9, 1));              // name
    a.emit(ins(OPG.PutOwnBySlotIdx, 8, arrays[i], 2));      // agentIds
    PROP(24, 7, 'push');
    a.emit(ins(OPG.Call2, 24, 24, 7, 8));
    a.label(`Askip${i}`);
  });
  a.emit(ins(OPG.Ret, 7));
  return a.build();
}

/** SearchButton: return FeedbackSheet(props, 1) in SearchButton's scope. r0 number, r1 non-pointer. */
function searchButtonLiveBody(selfIndex) {
  return Buffer.concat([
    ins(OPG.GetParentEnvironment, 3, 0),
    ins(OPG.CreateClosure, 2, 3, u16le(selfIndex)),
    ins(OPG.LoadConstUndefined, 1),
    ins(OPG.LoadParam, 4, 1),
    ins(OPG.LoadConstUInt8, 5, 1),
    ins(OPG.Call3, 2, 2, 1, 4, 5),
    ins(OPG.Ret, 2),
  ]);
}

const SECTION_SHAPE = 378;      // {id, name, agentIds}
const SECTION_VALUES = 114815;  // as SidebarSectionsView.normalize builds sections
// SidebarSectionsView.resolve as shipped, +18..+47 (sections param, collapsedSectionIds, env inits).
// GetById r4, r3, 2, 'sections' ; GetById r8, r3, 3, 'collapsedSectionIds' ; LoadConstUndefined r1 ;
// StoreNPToEnvironment r2, 0..3, r1
const RESOLVE_PROLOGUE_ORIGINAL = hex('45 04 03 02 fa de 45 08 03 03 ee 66 93 01 39 02 00 01 39 02 01 01 39 02 02 01 39 02 03 01');
// toggleSectionCollapsed +43: JmpTrue @50, r2 (the id is one of sections.current()).
const TOGGLE_CHECK_ORIGINAL = hex('b0 07 02');

/**
 * The live list arrangement for the paired bundle: { edits, titles: { zh, en } } (all applied
 * together, one titles set), or null when any anchor differs. Input is the paired template after
 * applyConnectionEntry (FeedbackSheet unreachable, donor 'lastMessageAt') and applyHomeBarBell.
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
  // recencyOf as shipped: +6 'activity', +10 the activity branch, +131 localActivityAt, +147 lastActivityAt.
  const at = (abs, bytes) => buf.subarray(abs, abs + bytes.length).equals(bytes);
  if (!at(R(6), ins(OPX.LoadConstString, 3, u16le(sid.activity)))) return null;
  if (!at(R(10), Buffer.from([OP.JStrictEqual, 108, 3, 4]))) return null;
  if (!at(R(131), ins(OPX.GetByIdLong, 4, 2, 6, u32le(sid.localActivityAt)))) return null;
  if (!at(R(147), ins(OPX.GetById, 3, 2, 4, u16le(sid.lastActivityAt)))) return null;
  const g = liveStrings(buf, L);
  if (!g) return null;

  const names = new Set(['SidebarSectionsView', 'normalize', 'resolve', 'FeedbackSheet', 'toggleSectionCollapsed']);
  const fsid = findStringIds(buf, L, names);
  for (const name of names) if (fsid.get(name).length !== 1) return null;
  const one = name => fsid.get(name)[0];
  const byName = (name, size) => findFunctions(buf, L, new Map([[one(name), name]])).get(name)?.filter(f => f.size === size) || [];
  const normalizeFns = byName('normalize', 451);
  const resolveFns = byName('resolve', 199);
  const feedback = byName('FeedbackSheet', 2698);
  const toggleFns = byName('toggleSectionCollapsed', 126);
  if (normalizeFns.length !== 1 || resolveFns.length !== 1 || feedback.length !== 1 || toggleFns.length !== 1) return null;
  const normalize = normalizeFns[0], resolve = resolveFns[0], fs = feedback[0], toggle = toggleFns[0];
  if (fs.index >= 65536) return null;
  // FeedbackSheet's frame: 49 registers, r0-r1 number, r2-r5 non-pointer (the body relies on it).
  const fsHeader = functionHeader(buf, L, fs.index);
  if (!fsHeader || fsHeader.frame < 40 || fsHeader.numRegs !== 2 || fsHeader.nonPtrRegs !== 4) return null;
  const searchHeader = homeBellAnchors(buf, L);
  if (searchHeader.error) return null;
  const search = searchHeader.search;
  const sHeader = functionHeader(buf, L, search.index);
  if (!sHeader || sHeader.frame < 6 || sHeader.numRegs !== 1 || sHeader.nonPtrRegs !== 1) return null;
  const rHeader = functionHeader(buf, L, recency.index);
  if (!rHeader || rHeader.frame < 9 || rHeader.numRegs !== 1 || rHeader.nonPtrRegs !== 1) return null;

  // normalize +268 builds {id, name, agentIds} from the same literal.
  if (!at(normalize.offset + 268, Buffer.concat([Buffer.from([OP.NewObjectWithBufferLong, 14]), u32le(SECTION_SHAPE), u32le(SECTION_VALUES)]))) return null;
  // resolve: +3 LoadParam r3,1; +18.. as above; +48 GetByIdShort r3, r4, 4, 'length'.
  if (!at(resolve.offset + 3, hex('89 03 01')) || !at(resolve.offset + 18, RESOLVE_PROLOGUE_ORIGINAL) || !at(resolve.offset + 48, hex('44 03 04 04'))) return null;
  if (buf.readUInt16LE(resolve.offset + 22) !== g.sections) return null;
  // toggleSectionCollapsed: +13 GetById r3, r4, 0, 'sections'; +43 JmpTrue @50; +50 currentCollapsedSections.
  if (!at(toggle.offset + 43, TOGGLE_CHECK_ORIGINAL) || buf.readUInt16LE(toggle.offset + 17) !== g.sections
    || buf.readUInt16LE(toggle.offset + 54) !== g.currentCollapsedSections) return null;
  // The bell (applyHomeBarBell) is in place.
  const settings = findUniqueFunction(buf, L, 'SettingsSheet', 4376);
  if (!settings) return null;
  const noopIndex = buf.readUInt32LE(settings.offset + 3795);
  const bell = searchButtonBody(searchHeader.sid, noopIndex);
  if (!at(search.offset, bell.body)) return null;
  // The literals (B) reuses, as the bell uses them.
  const medium = findStringIds(buf, L, new Set(['medium'])).get('medium');
  if (medium.length !== 1 || medium[0] >= 65536 || !at(L.lvOff + ICON_COLOR_LITERAL, Buffer.concat([hex('05 51'), u16le(medium[0])]))) return null;

  // Metro modules reached through __r.
  const factories = metroModuleIds(buf, L, g);
  if (!factories || factories.size < 1000) return null;
  const modules = {};
  for (const m of LIVE_MODULES) {
    const id = moduleExporting(buf, L, factories, m.export, g[m.export]);
    if (id === null) return null;
    modules[m.key] = id;
  }

  // A whole new body plus, when it needs more property cache entries than the official function
  // had, the header edit that sizes the caches for it (see "Property caches" above).
  const whole = (label, fn, body) => {
    if (body.length > fn.size) throw new Error(`${label}: ${body.length} > ${fn.size}`);
    const header = cacheSizeEdit(buf, L, fn.index, body, label);
    return [{ label, offset: fn.offset, original: Buffer.from(buf.subarray(fn.offset, fn.offset + fn.size)),
      patched: Buffer.concat([body, Buffer.alloc(fn.size - body.length, OP.AsyncBreakCheck)]) }, ...(header ? [header] : [])];
  };
  const prologue = Buffer.concat([
    ins(OPG.CreateClosure, 4, 2, u16le(fs.index)),
    ins(OPG.Call1, 4, 4, 3),                               // FeedbackSheet.call(params)
    RESOLVE_PROLOGUE_ORIGINAL.subarray(6, 14),              // collapsedSectionIds; r1 = undefined
  ]);
  let edits, titles;
  try {
    edits = [
      ...whole('recencyOf: global.sorted ? last message : official recency', recency, recencyLiveBody(g)),
      { label: 'SidebarSectionsView.resolve: sections <- FeedbackSheet.call(params)', offset: resolve.offset + 18,
        original: Buffer.from(RESOLVE_PROLOGUE_ORIGINAL),
        patched: Buffer.concat([prologue, Buffer.alloc(RESOLVE_PROLOGUE_ORIGINAL.length - prologue.length, OP.AsyncBreakCheck)]) },
      { label: 'toggleSectionCollapsed: fold any id', offset: toggle.offset + 43,
        original: Buffer.from(TOGGLE_CHECK_ORIGINAL), patched: hex('ae 07 7e') },
      ...whole('SearchButton: FeedbackSheet(props, 1)', search, searchButtonLiveBody(fs.index)),
    ];
    titles = {};
    for (const [lang, list] of Object.entries(LIST_GROUP_TITLES)) {
      titles[lang] = whole(`FeedbackSheet -> ${lang} list arrangement`, fs,
        feedbackSheetLiveBody({ g, selfIndex: fs.index, modules, titles: list }));
    }
  } catch {
    return null;
  }
  return { edits, titles, modules };
}

/** Function header fields (large headers only, as every function used here has one). */
function functionHeader(buf, L, index) {
  const a = L.fhOff + 12 * index;
  const w1 = buf.readUInt32LE(a), w2 = buf.readUInt32LE(a + 4), flags = buf[a + 11];
  if (flags & 0x20) {
    const large = ((w1 & 0xffffff) | (((w2 >>> 14) & 0xff) << 24)) >>> 0;
    const u = o => buf.readUInt32LE(large + o);
    // LargeFunctionHeader: one uint32 per field up to FrameSize, then uint8 ReadCacheSize,
    // WriteCacheSize, NumCacheNewObject, PrivateNameCacheSize and the flags.
    return { params: u(4), size: u(12), numRegs: u(20), nonPtrRegs: u(24), frame: u(28),
      readCache: buf[large + 32], writeCache: buf[large + 33], cacheAt: large + 32, large: true };
  }
  // Small header third word: FrameSize:8, ReadCacheSize:8, WriteCacheSize:6 (+2 flag bits), flags.
  return { params: (w1 >>> 25) & 31, size: w2 & 0x3fff, numRegs: (w2 >>> 22) & 31, nonPtrRegs: (w2 >>> 27) & 31, frame: buf[a + 8],
    readCache: buf[a + 9], writeCache: buf[a + 10] & 0x3f, cacheAt: a + 9, large: false };
}

/**
 * Header edit raising function `index`'s ReadCacheSize / WriteCacheSize to at least what a new
 * body uses (`body.readCacheSize` / `body.writeCacheSize` from assembler()), or null when the
 * official sizes already cover it. Hermes sizes CodeBlock's property caches from these fields.
 */
export function cacheSizeEdit(buf, L, index, body, label) {
  const h = functionHeader(buf, L, index);
  const needRead = body.readCacheSize || 0, needWrite = body.writeCacheSize || 0;
  if (needRead <= h.readCache && needWrite <= h.writeCache) return null;
  if (needRead > 255 || needWrite > (h.large ? 255 : 63)) throw new Error(`${label}: property cache too large`);
  const original = Buffer.from(buf.subarray(h.cacheAt, h.cacheAt + 2));
  const patched = Buffer.from(original);
  patched[0] = Math.max(h.readCache, needRead);
  patched[1] = h.large ? Math.max(h.writeCache, needWrite) : (original[1] & 0xc0) | Math.max(h.writeCache, needWrite);
  return { label: `${label}: property cache sizes`, offset: h.cacheAt, original, patched };
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
  // rokbot.5: the rokbot section (both bundles or neither, so paired and unpaired sheets match).
  const unpairedMenu = connApplied ? applySettingsMenu(unpairedConn.buffer) : { applied: false, reason: 'connection entry not applied', edits: [] };
  const templateMenu = connApplied ? applySettingsMenu(templateConn.buffer) : { applied: false, reason: 'connection entry not applied', edits: [] };
  const menuApplied = unpairedMenu.applied && templateMenu.applied;
  const unpairedOut = connApplied ? (menuApplied ? unpairedMenu.buffer : unpairedConn.buffer) : unpaired.buffer;
  const templateBase = menuApplied ? templateMenu.buffer : templateConn.buffer;
  // The header bell only matters in the paired bundle (generated from the template).
  const templateBell = connApplied ? applyHomeBarBell(templateBase) : { applied: false, reason: 'connection entry not applied', edits: [] };
  const templateOut = connApplied ? (templateBell.applied ? templateBell.buffer : templateBase) : template.buffer;
  const live = connApplied && templateBell.applied ? listSortEdits(templateOut) : null;

  const oldSha = pinned.gatewayMeta.templateSha256;
  const newSha = crypto.createHash('sha256').update(templateOut).digest('hex');
  const jsonText = pinned.gatewayTemplateJson.toString('utf8');
  if (!oldSha || jsonText.split(oldSha).length !== 2) {
    return { ...pinned, settingsRebrand: { applied: false, reason: 'templateSha256 not found in gateway-template.json', edits: [] } };
  }
  let gatewayTemplateJson = Buffer.from(jsonText.replace(oldSha, newSha), 'utf8');
  if (live) {
    const meta = JSON.parse(gatewayTemplateJson.toString('utf8'));
    const wire = list => list.map(e => ({ offset: e.offset, original: e.original.toString('hex'), patched: e.patched.toString('hex') }));
    // rokbot.5b: always applied to the paired bundle (`edits` plus one titles set); the mode is
    // switched at run time by the bell (see listSortEdits).
    meta.listSort = {
      field: LIST_SORT_FIELD,
      live: 1,
      mode: LIST_MODE_ID,
      groups: LIST_GROUP_IDS,
      edits: wire(live.edits),
      titles: Object.fromEntries(Object.entries(live.titles).map(([k, v]) => [k, wire(v)])),
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
      settingsMenu: {
        applied: menuApplied,
        reason: menuApplied ? unpairedMenu.reason : (unpairedMenu.applied ? `gateway-template: ${templateMenu.reason}` : `unpaired: ${unpairedMenu.reason}`),
        edits: menuApplied ? unpairedMenu.edits : [],
      },
      homeBell: { applied: templateBell.applied, reason: templateBell.reason, edits: templateBell.edits },
      listSort: { available: Boolean(live), live: Boolean(live), edits: live ? live.edits.length : 0, modules: live ? live.modules : null },
    },
  };
}

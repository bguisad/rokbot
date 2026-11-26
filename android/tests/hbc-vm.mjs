// A small HBC v98 interpreter for tests: runs selected functions of the pinned bundle (the
// rokbot rewritten bodies, and a few official ones they rely on) against JS mocks. It knows only
// the opcodes those bodies use and fails loudly on anything else. It also enforces the frame's
// register classes (number / non-pointer / pointer): a string or object in a number or
// non-pointer register would be invisible to the Hermes GC.

const HEADER_SIZE = 128;
const align4 = n => (n + 3) & ~3;

export function parseHbc(buf) {
  const u32 = o => buf.readUInt32LE(o);
  const h = {
    functionCount: u32(40), stringKindCount: u32(44), identifierCount: u32(48), stringCount: u32(52),
    overflowStringCount: u32(56), stringStorageSize: u32(60), literalValueBufferSize: u32(80), objKeyBufferSize: u32(84),
    objShapeTableCount: u32(88),
  };
  let p = HEADER_SIZE;
  h.fhOff = p; p = align4(p + 12 * h.functionCount);
  h.skOff = p; p = align4(p + 4 * h.stringKindCount);
  p = align4(p + 4 * h.identifierCount);
  h.stOff = p; p = align4(p + 4 * h.stringCount);
  h.ovOff = p; p = align4(p + 8 * h.overflowStringCount);
  h.ssOff = p; p = align4(p + h.stringStorageSize);
  h.lvOff = p; p = align4(p + h.literalValueBufferSize);
  h.okOff = p; p = align4(p + h.objKeyBufferSize);
  h.shOff = p;
  return h;
}

export function stringAt(buf, h, id) {
  const w = buf.readUInt32LE(h.stOff + 4 * id);
  const utf16 = w & 1;
  let off = (w >>> 1) & 0x7fffff, len = w >>> 24;
  if (len === 255) { const o = h.ovOff + 8 * off; off = buf.readUInt32LE(o); len = buf.readUInt32LE(o + 4); }
  const s = h.ssOff + off;
  return utf16 ? buf.toString('utf16le', s, s + 2 * len) : buf.toString('latin1', s, s + len);
}

export function functionAt(buf, h, index) {
  const a = h.fhOff + 12 * index;
  const w1 = buf.readUInt32LE(a), w2 = buf.readUInt32LE(a + 4), flags = buf[a + 11];
  if (!(flags & 0x20)) {
    return { index, offset: w1 & 0x1ffffff, size: w2 & 0x3fff, name: stringAt(buf, h, (w2 >>> 14) & 0xff),
      numRegs: (w2 >>> 22) & 31, nonPtrRegs: (w2 >>> 27) & 31, frame: buf[a + 8] };
  }
  const large = ((w1 & 0xffffff) | (((w2 >>> 14) & 0xff) << 24)) >>> 0;
  const u = o => buf.readUInt32LE(large + o);
  return { index, offset: u(0), size: u(12), name: stringAt(buf, h, u(16)), numRegs: u(20), nonPtrRegs: u(24), frame: u(28) };
}

function decodeLiterals(buf, base, off, n, h) {
  let p = base + off;
  const out = [];
  while (out.length < n) {
    const t = buf[p++];
    let cnt;
    if (t & 0x80) { cnt = ((t & 0x0f) << 8) | buf[p++]; } else cnt = t & 0x0f;
    const typ = (t >> 4) & 7;
    for (let i = 0; i < cnt; i++) {
      if (typ === 0) out.push(null);
      else if (typ === 1) out.push(true);
      else if (typ === 2) out.push(false);
      else if (typ === 3) { out.push(buf.readDoubleLE(p)); p += 8; }
      else if (typ === 4) { out.push(stringAt(buf, h, buf.readUInt32LE(p))); p += 4; }
      else if (typ === 5) { out.push(stringAt(buf, h, buf.readUInt16LE(p))); p += 2; }
      else if (typ === 6) { out.push(stringAt(buf, h, buf[p])); p += 1; }
      else if (typ === 7) { out.push(buf.readInt32LE(p)); p += 4; }
    }
  }
  return out;
}

export function objectFromBuffer(buf, h, shape, valueOff) {
  const keyOff = buf.readUInt32LE(h.shOff + 8 * shape), n = buf.readUInt32LE(h.shOff + 8 * shape + 4);
  const keys = decodeLiterals(buf, h.okOff, keyOff, n, h);
  const vals = decodeLiterals(buf, h.lvOff, valueOff, n, h);
  const o = {};
  keys.forEach((k, i) => { o[k] = vals[i]; });
  return o;
}

/** A Hermes closure: callable from JS (mocks get a plain function). */
export class Closure {
  constructor(vm, index, env) { this.vm = vm; this.index = index; this.env = env; }
}

export class Env {
  constructor(parent, size) { this.parent = parent; this.slots = new Array(size).fill(undefined); }
}

const isPointer = v => v !== null && (typeof v === 'object' || typeof v === 'function' || typeof v === 'string' || typeof v === 'symbol' || typeof v === 'bigint');

export class HbcVm {
  /** `global`: the global object (plain JS object). */
  constructor(buf, { global = {}, maxSteps = 200000 } = {}) {
    this.buf = buf;
    this.h = parseHbc(buf);
    this.global = global;
    this.maxSteps = maxSteps;
    this.trace = [];
  }

  fn(index) { return functionAt(this.buf, this.h, index); }
  str(id) { return stringAt(this.buf, this.h, id); }

  /** Calls a value (Closure or JS function) with `thisArg` and args. */
  call(callee, thisArg, args) {
    if (callee instanceof Closure) return this.run(callee.index, callee.env, thisArg, args);
    if (typeof callee === 'function') return callee.apply(thisArg, args);
    throw new TypeError(`not callable: ${typeof callee}`);
  }

  run(index, env, thisArg, args) {
    const f = this.fn(index);
    const b = this.buf;
    const r = new Array(f.frame).fill(undefined);
    const set = (reg, v) => {
      if (reg >= f.frame) throw new Error(`fn${index} +${pc}: r${reg} outside the frame (${f.frame})`);
      if (reg < f.numRegs && typeof v !== 'number') throw new Error(`fn${index} +${pc}: non-number in number register r${reg}`);
      if (reg < f.numRegs + f.nonPtrRegs && isPointer(v)) throw new Error(`fn${index} +${pc}: pointer in non-pointer register r${reg}`);
      r[reg] = v;
    };
    const get = reg => r[reg];
    const prop = (obj, key) => {
      if (obj === undefined || obj === null) throw new TypeError(`fn${index} +${pc}: read '${key}' of ${obj}`);
      return obj[key];
    };
    let pc = 0;
    let steps = 0;
    const u8 = k => b[f.offset + pc + k];
    const u16 = k => b.readUInt16LE(f.offset + pc + k);
    const u32 = k => b.readUInt32LE(f.offset + pc + k);
    const i8 = k => b.readInt8(f.offset + pc + k);
    const i32 = k => b.readInt32LE(f.offset + pc + k);
    for (;;) {
      if (++steps > this.maxSteps) throw new Error('runaway');
      if (pc < 0 || pc >= f.size) throw new Error(`fn${index}: pc +${pc} out of the body`);
      const op = u8(0);
      let next;
      const jump = (cond, long) => { next = cond ? pc + (long ? i32(1) : i8(1)) : pc + (long ? 5 : 2); };
      const jump1 = (cond, long) => { next = cond ? pc + (long ? i32(1) : i8(1)) : pc + (long ? 6 : 3); };
      const jump2 = (cond, long) => { next = cond ? pc + (long ? i32(1) : i8(1)) : pc + (long ? 7 : 4); };
      const ra = long => get(u8(long ? 5 : 2)), rb = long => get(u8(long ? 6 : 3));
      switch (op) {
        case 126: next = pc + 1; break;                                         // AsyncBreakCheck
        case 118: return get(u8(1));                                            // Ret
        case 137: set(u8(1), u8(2) === 0 ? thisArg : args[u8(2) - 1]); next = pc + 3; break;   // LoadParam
        case 147: set(u8(1), undefined); next = pc + 2; break;
        case 148: set(u8(1), null); next = pc + 2; break;
        case 149: set(u8(1), true); next = pc + 2; break;
        case 150: set(u8(1), false); next = pc + 2; break;
        case 151: set(u8(1), 0); next = pc + 2; break;
        case 139: set(u8(1), u8(2)); next = pc + 3; break;                      // LoadConstUInt8
        case 140: set(u8(1), i32(2)); next = pc + 6; break;                     // LoadConstInt
        case 144: set(u8(1), this.str(u16(2))); next = pc + 4; break;
        case 145: set(u8(1), this.str(u32(2))); next = pc + 6; break;
        case 16: set(u8(1), get(u8(2))); next = pc + 3; break;                  // Mov
        case 19: set(u8(1), !get(u8(2))); next = pc + 3; break;                 // Not
        case 23: set(u8(1), get(u8(2)) === get(u8(3))); next = pc + 4; break;   // StrictEq
        case 25: set(u8(1), get(u8(2)) !== get(u8(3))); next = pc + 4; break;   // StrictNeq
        case 30: set(u8(1), get(u8(2)) + get(u8(3))); next = pc + 4; break;     // Add
        case 61: set(u8(1), this.global); next = pc + 2; break;                 // GetGlobalObject
        case 52: {                                                              // GetParentEnvironment
          let e = env;
          for (let k = 0; k < u8(2); k++) e = e.parent;
          set(u8(1), e); next = pc + 3; break;
        }
        case 59: set(u8(1), get(u8(2)).slots[u8(3)]); next = pc + 4; break;    // LoadFromEnvironment
        case 55: get(u8(1)).slots[u8(2)] = get(u8(3)); next = pc + 4; break;    // StoreToEnvironment
        case 64: set(u8(1), new Env(env, u8(2))); next = pc + 3; break;         // CreateFunctionEnvironment
        case 132: set(u8(1), new Closure(this, u16(3), get(u8(2)))); next = pc + 5; break;   // CreateClosure
        case 133: set(u8(1), new Closure(this, u32(3), get(u8(2)))); next = pc + 7; break;
        case 68: set(u8(1), prop(get(u8(2)), this.str(u8(4)))); next = pc + 5; break;      // GetByIdShort
        case 69: set(u8(1), prop(get(u8(2)), this.str(u16(4)))); next = pc + 6; break;     // GetById
        case 70: set(u8(1), prop(get(u8(2)), this.str(u32(4)))); next = pc + 8; break;     // GetByIdLong
        case 72: {                                                              // TryGetById
          const key = this.str(u16(4));
          if (!(key in get(u8(2)))) throw new ReferenceError(`${key} is not defined`);
          set(u8(1), get(u8(2))[key]); next = pc + 6; break;
        }
        case 74: case 75: get(u8(1))[this.str(u16(4))] = get(u8(2)); next = pc + 6; break;  // PutById
        case 93: set(u8(1), prop(get(u8(2)), get(u8(3)))); next = pc + 4; break;          // GetByVal
        case 8: set(u8(1), []); next = pc + 4; break;                           // NewArray
        case 90: get(u8(1))[u8(3)] = get(u8(2)); next = pc + 4; break;          // DefineOwnInDenseArray
        case 1: set(u8(1), objectFromBuffer(b, this.h, u16(2), u16(4))); next = pc + 6; break;   // NewObjectWithBuffer
        case 2: set(u8(1), objectFromBuffer(b, this.h, u32(2), u32(6))); next = pc + 10; break;  // ...Long
        case 82: {                                                              // PutOwnBySlotIdx
          const o = get(u8(1));
          o[Object.keys(o)[u8(3)]] = get(u8(2)); next = pc + 4; break;
        }
        case 108: case 110: case 111: case 112: {                               // Call1..Call4
          const n = op === 108 ? 0 : op - 109;
          const args2 = []; for (let k = 0; k < n; k++) args2.push(get(u8(4 + k)));
          set(u8(1), this.call(get(u8(2)), get(u8(3)), args2));
          next = pc + 4 + n; break;
        }
        case 174: jump(true, false); break;            case 175: jump(true, true); break;
        case 176: jump1(Boolean(get(u8(2))), false); break;  case 177: jump1(Boolean(get(u8(5))), true); break;
        case 178: jump1(!get(u8(2)), false); break;          case 179: jump1(!get(u8(5)), true); break;
        case 180: jump1(get(u8(2)) === undefined, false); break; case 181: jump1(get(u8(5)) === undefined, true); break;
        case 185: jump2(!(ra(false) < rb(false)), false); break; case 186: jump2(!(ra(true) < rb(true)), true); break;
        case 199: jump2(ra(false) > rb(false), false); break;   case 200: jump2(ra(true) > rb(true), true); break;
        case 209: jump2(ra(false) != rb(false), false); break;  case 210: jump2(ra(true) != rb(true), true); break;   // eslint-disable-line eqeqeq
        case 211: jump2(ra(false) === rb(false), false); break; case 212: jump2(ra(true) === rb(true), true); break;
        case 213: jump2(ra(false) !== rb(false), false); break; case 214: jump2(ra(true) !== rb(true), true); break;
        default: throw new Error(`fn${index} +${pc}: opcode ${op} not supported by the test VM`);
      }
      pc = next;
    }
  }
}

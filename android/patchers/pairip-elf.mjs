// Neutralizes Google Play Pairip native ELF hooks (`DT_NEEDED libpairipcore.so`, `DT_INIT` ExecuteProgram trampoline, `ExecuteProgram` relocations, and pinned Pairip-encrypted `.data` sections).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { entryBytes, createEntry } from './signing.mjs';

const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_PLTRELSZ = 2;
const DT_STRTAB = 5;
const DT_SYMTAB = 6;
const DT_RELA = 7;
const DT_RELASZ = 8;
const DT_STRSZ = 10;
const DT_INIT = 12;
const DT_JMPREL = 23;

const PT_LOAD = 1;
const PT_DYNAMIC = 2;

function readCString(buf, off, limit) {
  if (off < 0 || off >= buf.length) return '';
  const end = buf.indexOf(0, off);
  const stop = end >= 0 ? Math.min(end, limit ?? buf.length) : Math.min(off + 256, buf.length);
  return buf.slice(off, stop).toString('utf8');
}

function loadPairipElfRecipe(recipesDir, versionCode) {
  if (!recipesDir) return null;
  const candidates = [];
  if (versionCode) candidates.push(path.join(recipesDir, `pairip-elf-${versionCode}.json.gz`));
  candidates.push(path.join(recipesDir, 'pairip-elf-1075.json.gz'));
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    }
  }
  return null;
}

export function neutralizePairipElf(elfBuf, dataPatches = null) {
  if (!Buffer.isBuffer(elfBuf) || elfBuf.length < 64) {
    return { buffer: elfBuf, patched: false, removedNeeded: false, initNopped: false, relocsCleared: 0, dataPatchesApplied: 0 };
  }
  // Check ELF64 LE magic
  if (
    elfBuf[0] !== 0x7f ||
    elfBuf[1] !== 0x45 ||
    elfBuf[2] !== 0x4c ||
    elfBuf[3] !== 0x46 ||
    elfBuf[4] !== 2 ||
    elfBuf[5] !== 1
  ) {
    return { buffer: elfBuf, patched: false, removedNeeded: false, initNopped: false, relocsCleared: 0, dataPatchesApplied: 0 };
  }

  const ePhoff = Number(elfBuf.readBigUInt64LE(32));
  const ePhentsize = elfBuf.readUInt16LE(54);
  const ePhnum = elfBuf.readUInt16LE(56);
  if (ePhoff <= 0 || ePhoff + ePhentsize * ePhnum > elfBuf.length) {
    return { buffer: elfBuf, patched: false, removedNeeded: false, initNopped: false, relocsCleared: 0, dataPatchesApplied: 0 };
  }

  const loads = [];
  let dynOff = -1;
  let dynSize = 0;
  for (let i = 0; i < ePhnum; i++) {
    const p = ePhoff + i * ePhentsize;
    const pType = elfBuf.readUInt32LE(p);
    const pOffset = Number(elfBuf.readBigUInt64LE(p + 8));
    const pVaddr = Number(elfBuf.readBigUInt64LE(p + 16));
    const pFilesz = Number(elfBuf.readBigUInt64LE(p + 32));
    if (pType === PT_LOAD) {
      loads.push({ pOffset, pVaddr, pFilesz });
    } else if (pType === PT_DYNAMIC) {
      dynOff = pOffset;
      dynSize = pFilesz;
    }
  }
  if (dynOff < 0 || dynOff + dynSize > elfBuf.length) {
    return { buffer: elfBuf, patched: false, removedNeeded: false, initNopped: false, relocsCleared: 0, dataPatchesApplied: 0 };
  }

  const vaToOff = va => {
    for (const seg of loads) {
      if (va >= seg.pVaddr && va < seg.pVaddr + seg.pFilesz) {
        return seg.pOffset + (va - seg.pVaddr);
      }
    }
    return -1;
  };

  let strtabVa = -1;
  let strsz = 0;
  let symtabVa = -1;
  let initVa = -1;
  let jmprelVa = -1;
  let pltrelsz = 0;
  let relaVa = -1;
  let relasz = 0;
  const dynEntries = [];

  for (let off = dynOff; off + 16 <= dynOff + dynSize; off += 16) {
    const dTag = Number(elfBuf.readBigInt64LE(off));
    const dVal = Number(elfBuf.readBigUInt64LE(off + 8));
    dynEntries.push({ off, dTag, dVal });
    if (dTag === DT_NULL) break;
    if (dTag === DT_STRTAB) strtabVa = dVal;
    else if (dTag === DT_STRSZ) strsz = dVal;
    else if (dTag === DT_SYMTAB) symtabVa = dVal;
    else if (dTag === DT_INIT) initVa = dVal;
    else if (dTag === DT_JMPREL) jmprelVa = dVal;
    else if (dTag === DT_PLTRELSZ) pltrelsz = dVal;
    else if (dTag === DT_RELA) relaVa = dVal;
    else if (dTag === DT_RELASZ) relasz = dVal;
  }

  const strtabOff = strtabVa >= 0 ? vaToOff(strtabVa) : -1;
  if (strtabOff < 0) {
    return { buffer: elfBuf, patched: false, removedNeeded: false, initNopped: false, relocsCleared: 0, dataPatchesApplied: 0 };
  }
  const strLimit = strsz > 0 ? strtabOff + strsz : elfBuf.length;

  const hasPairipNeeded = dynEntries.some(
    e => e.dTag === DT_NEEDED && readCString(elfBuf, strtabOff + e.dVal, strLimit) === 'libpairipcore.so'
  );
  if (!hasPairipNeeded) {
    return { buffer: elfBuf, patched: false, removedNeeded: false, initNopped: false, relocsCleared: 0, dataPatchesApplied: 0 };
  }

  const out = Buffer.from(elfBuf);

  // 1. Remove `DT_NEEDED libpairipcore.so` from `.dynamic` (preserving array size with trailing DT_NULL).
  const kept = dynEntries.filter(
    e => e.dTag !== DT_NULL && !(e.dTag === DT_NEEDED && readCString(out, strtabOff + e.dVal, strLimit) === 'libpairipcore.so')
  );
  let writeCursor = dynOff;
  for (const e of kept) {
    out.writeBigInt64LE(BigInt(e.dTag), writeCursor);
    out.writeBigUInt64LE(BigInt(e.dVal), writeCursor + 8);
    writeCursor += 16;
  }
  while (writeCursor + 16 <= dynOff + dynSize) {
    out.fill(0, writeCursor, writeCursor + 16);
    writeCursor += 16;
  }

  // 2. Neutralize Pairip's injected `DT_INIT` trampoline (`bti c` + `ExecuteProgram(...)`) -> `bti c; ret`.
  let initNopped = false;
  if (initVa >= 0) {
    const initOff = vaToOff(initVa);
    if (initOff >= 0 && initOff + 64 <= out.length) {
      const stubSlice = out.slice(initOff, initOff + 64);
      const hasBtiC = stubSlice.readUInt32LE(0) === 0xd503245f;
      let hasBlrX17 = false;
      for (let i = 0; i + 4 <= stubSlice.length; i += 4) {
        if (stubSlice.readUInt32LE(i) === 0xd63f0220) {
          hasBlrX17 = true;
          break;
        }
      }
      if (hasBtiC && hasBlrX17) {
        out.writeUInt32LE(0xd503245f, initOff);
        out.writeUInt32LE(0xd65f03c0, initOff + 4);
        initNopped = true;
      }
    }
  }

  // 3. Weaken and clear `ExecuteProgram` relocations (`R_AARCH64_NONE`) so linker never looks for `ExecuteProgram`.
  let relocsCleared = 0;
  const symtabOff = symtabVa >= 0 ? vaToOff(symtabVa) : -1;
  const clearRelaTable = (va, sz) => {
    if (va < 0 || sz <= 0 || symtabOff < 0) return;
    const off = vaToOff(va);
    if (off < 0 || off + sz > out.length) return;
    for (let p = off; p + 24 <= off + sz; p += 24) {
      const rInfo = out.readBigUInt64LE(p + 8);
      const symIdx = Number(rInfo >> 32n);
      if (symIdx <= 0) continue;
      const symOff = symtabOff + symIdx * 24;
      if (symOff + 24 > out.length) continue;
      const stName = out.readUInt32LE(symOff);
      const stShndx = out.readUInt16LE(symOff + 6);
      if (stShndx === 0 && readCString(out, strtabOff + stName, strLimit) === 'ExecuteProgram') {
        const stInfo = out[symOff + 4];
        out[symOff + 4] = (stInfo & 0x0f) | 0x20; // STB_WEAK
        out.writeBigUInt64LE(0n, p + 8); // R_AARCH64_NONE
        relocsCleared++;
      }
    }
  };
  clearRelaTable(jmprelVa, pltrelsz);
  clearRelaTable(relaVa, relasz);

  // 4. Restore Pairip-encrypted `.data` regions when pinned bytes match this binary.
  let dataPatchesApplied = 0;
  if (Array.isArray(dataPatches)) {
    for (const patch of dataPatches) {
      const bytes = Buffer.from(patch.dataB64, 'base64');
      if (patch.offset >= 0 && patch.offset + bytes.length <= out.length) {
        bytes.copy(out, patch.offset);
        dataPatchesApplied++;
      }
    }
  }

  return {
    buffer: out,
    patched: true,
    removedNeeded: true,
    initNopped,
    relocsCleared,
    dataPatchesApplied,
  };
}

export function neutralizePairipElfs(entries, { recipesDir = null, versionCode = null } = {}) {
  const recipe = loadPairipElfRecipe(recipesDir, versionCode);
  let elfFilesPatched = 0;
  let elfDataPatched = 0;
  const patchedNames = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.name.endsWith('.so')) continue;
    const raw = entryBytes(entry);
    let dataPatches = null;
    const libSpec = recipe?.libs?.[entry.name];
    if (libSpec && Array.isArray(libSpec.patches)) {
      const rawSha = crypto.createHash('sha256').update(raw).digest('hex');
      if (rawSha === libSpec.sha256) {
        dataPatches = libSpec.patches;
      }
    }
    const res = neutralizePairipElf(raw, dataPatches);
    if (res.patched) {
      elfFilesPatched++;
      if (res.dataPatchesApplied > 0) elfDataPatched++;
      patchedNames.push(entry.name);
      entries[i] = createEntry(entry.name, res.buffer, { store: entry.method === 0 });
    }
  }
  return { elfFilesPatched, elfDataPatched, patchedNames };
}

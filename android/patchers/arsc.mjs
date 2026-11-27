// Pure Node.js Android resources.arsc (ResTable) merger for merging split config APKs (density/locale)
// into a standalone universal APK.

const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

const NO_ENTRY = 0xffffffff;
const FLAG_COMPLEX = 0x0001;
const FLAG_COMPACT = 0x0008;
const FLAG_SPARSE = 0x01;
const FLAG_OFFSET16 = 0x02;
const VALUE_TYPE_STRING = 0x03;

function readLen8(buf, pos) {
  let len = buf[pos++];
  if (len & 0x80) {
    len = ((len & 0x7f) << 8) | buf[pos++];
  }
  return [len, pos];
}

function readLen16(buf, pos) {
  let len = buf.readUInt16LE(pos);
  pos += 2;
  if (len & 0x8000) {
    len = ((len & 0x7fff) << 16) | buf.readUInt16LE(pos);
    pos += 2;
  }
  return [len, pos];
}

function encodeLen8(val) {
  if (val < 0x80) return Buffer.from([val]);
  return Buffer.from([0x80 | ((val >> 8) & 0x7f), val & 0xff]);
}

function encodeLen16(val) {
  if (val < 0x8000) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(val, 0);
    return b;
  }
  const b = Buffer.alloc(4);
  b.writeUInt16LE(0x8000 | ((val >> 16) & 0x7fff), 0);
  b.writeUInt16LE(val & 0xffff, 2);
  return b;
}

export function parseResStringPool(buf, offset = 0) {
  const type = buf.readUInt16LE(offset);
  const headerSize = buf.readUInt16LE(offset + 2);
  const size = buf.readUInt32LE(offset + 4);
  if (type !== RES_STRING_POOL_TYPE) {
    throw new Error(`Expected ResStringPool (0x0001), got 0x${type.toString(16)}`);
  }
  const stringCount = buf.readUInt32LE(offset + 8);
  const styleCount = buf.readUInt32LE(offset + 12);
  const flags = buf.readUInt32LE(offset + 16);
  const stringsStart = buf.readUInt32LE(offset + 20);
  const stylesStart = buf.readUInt32LE(offset + 24);
  const isUtf8 = (flags & 0x0100) !== 0;

  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    const strOff = buf.readUInt32LE(offset + headerSize + i * 4);
    let pos = offset + stringsStart + strOff;
    if (isUtf8) {
      const [, p1] = readLen8(buf, pos);
      const [byteLen, p2] = readLen8(buf, p1);
      strings.push(buf.toString('utf8', p2, p2 + byteLen));
    } else {
      const [charLen, p1] = readLen16(buf, pos);
      strings.push(buf.toString('utf16le', p1, p1 + charLen * 2));
    }
  }

  const stylesTail = styleCount > 0 && stylesStart > 0
    ? buf.subarray(offset + stylesStart, offset + size)
    : Buffer.alloc(0);

  return {
    headerSize,
    size,
    stringCount,
    styleCount,
    flags,
    isUtf8,
    strings,
    stylesOffsetArray: styleCount > 0
      ? Buffer.from(buf.subarray(offset + headerSize + stringCount * 4, offset + headerSize + (stringCount + styleCount) * 4))
      : Buffer.alloc(0),
    stylesTail,
  };
}

export function serializeResStringPool(pool) {
  const headerSize = 28;
  const isUtf8 = Boolean(pool.isUtf8);
  const flags = isUtf8 ? (pool.flags | 0x0100) : (pool.flags & ~0x0100);
  const offsets = Buffer.alloc(pool.strings.length * 4);
  const encodedParts = [];
  let dataLen = 0;

  for (let i = 0; i < pool.strings.length; i++) {
    offsets.writeUInt32LE(dataLen, i * 4);
    const s = pool.strings[i];
    if (isUtf8) {
      const utf8Bytes = Buffer.from(s, 'utf8');
      const u16Len = encodeLen8(s.length);
      const u8Len = encodeLen8(utf8Bytes.length);
      const item = Buffer.concat([u16Len, u8Len, utf8Bytes, Buffer.from([0])]);
      encodedParts.push(item);
      dataLen += item.length;
    } else {
      const u16Bytes = Buffer.from(s, 'utf16le');
      const lenBuf = encodeLen16(s.length);
      const item = Buffer.concat([lenBuf, u16Bytes, Buffer.from([0, 0])]);
      encodedParts.push(item);
      dataLen += item.length;
    }
  }

  const dataBuf = Buffer.concat(encodedParts, dataLen);
  const padLen = (4 - (dataBuf.length % 4)) % 4;
  const paddedData = padLen ? Buffer.concat([dataBuf, Buffer.alloc(padLen)]) : dataBuf;

  const stringsStart = headerSize + offsets.length + pool.stylesOffsetArray.length;
  const hasStyles = pool.styleCount > 0 && pool.stylesTail.length > 0;
  const stylesStart = hasStyles ? stringsStart + paddedData.length : 0;
  const totalUnpadded = stringsStart + paddedData.length + (hasStyles ? pool.stylesTail.length : 0);
  const tailPad = (4 - (totalUnpadded % 4)) % 4;
  const totalSize = totalUnpadded + tailPad;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(totalSize, 4);
  header.writeUInt32LE(pool.strings.length, 8);
  header.writeUInt32LE(pool.styleCount, 12);
  header.writeUInt32LE(flags >>> 0, 16);
  header.writeUInt32LE(stringsStart, 20);
  header.writeUInt32LE(stylesStart, 24);

  return Buffer.concat([
    header,
    offsets,
    pool.stylesOffsetArray,
    paddedData,
    hasStyles ? pool.stylesTail : Buffer.alloc(0),
    tailPad ? Buffer.alloc(tailPad) : Buffer.alloc(0),
  ]);
}

function parseArsc(arscBuf) {
  const type = arscBuf.readUInt16LE(0);
  const headerSize = arscBuf.readUInt16LE(2);
  const size = arscBuf.readUInt32LE(4);
  if (type !== RES_TABLE_TYPE || size !== arscBuf.length) {
    throw new Error('Invalid resources.arsc ResTable header');
  }
  const packageCount = arscBuf.readUInt32LE(8);
  let pos = headerSize;
  let globalStringPool = null;
  const packages = [];
  const trailingChunks = [];

  while (pos < arscBuf.length) {
    const ct = arscBuf.readUInt16LE(pos);
    const chsz = arscBuf.readUInt16LE(pos + 2);
    const csz = arscBuf.readUInt32LE(pos + 4);
    if (ct === RES_STRING_POOL_TYPE && !globalStringPool) {
      globalStringPool = parseResStringPool(arscBuf, pos);
    } else if (ct === RES_TABLE_PACKAGE_TYPE) {
      packages.push(parsePackage(arscBuf.subarray(pos, pos + csz)));
    } else {
      trailingChunks.push(Buffer.from(arscBuf.subarray(pos, pos + csz)));
    }
    pos += csz;
  }

  return { headerSize, packageCount, globalStringPool, packages, trailingChunks };
}

function parsePackage(pkgBuf) {
  const headerSize = pkgBuf.readUInt16LE(2);
  const pkgId = pkgBuf.readUInt32LE(8);
  const headerBytes = Buffer.from(pkgBuf.subarray(0, headerSize));
  const typeStringsRel = pkgBuf.readUInt32LE(268);
  const keyStringsRel = pkgBuf.readUInt32LE(276);

  const typeStrings = parseResStringPool(pkgBuf, typeStringsRel);
  const keyStrings = parseResStringPool(pkgBuf, keyStringsRel);

  const chunks = [];
  let pos = headerSize;
  while (pos < pkgBuf.length) {
    const ct = pkgBuf.readUInt16LE(pos);
    const csz = pkgBuf.readUInt32LE(pos + 4);
    if (pos !== typeStringsRel && pos !== keyStringsRel) {
      const tid = (ct === RES_TABLE_TYPE_TYPE || ct === RES_TABLE_TYPE_SPEC_TYPE) ? pkgBuf[pos + 8] : -1;
      chunks.push({ type: ct, tid, raw: Buffer.from(pkgBuf.subarray(pos, pos + csz)) });
    }
    pos += csz;
  }

  return { pkgId, headerBytes, typeStrings, keyStrings, chunks };
}

function remapTypeChunk(rawChunk, splitPkg, basePkg, splitGlobalPool, baseGlobalPool, baseStrMap, baseKeyMap) {
  const buf = Buffer.from(rawChunk);
  const chunkHeaderSize = buf.readUInt16LE(2);
  const tid = buf[8];
  const flags = buf[9];
  const entryCount = buf.readUInt32LE(12);
  const entriesStart = buf.readUInt32LE(16);

  // Check tid matches base package type name
  const splitTypeName = splitPkg.typeStrings.strings[tid - 1];
  if (splitTypeName) {
    const baseTypeIdx = basePkg.typeStrings.strings.indexOf(splitTypeName);
    if (baseTypeIdx >= 0) {
      buf[8] = baseTypeIdx + 1;
    }
  }

  const remapGlobalStr = idx => {
    const str = splitGlobalPool.strings[idx];
    if (str === undefined) return idx;
    let mapped = baseStrMap.get(str);
    if (mapped === undefined) {
      mapped = baseGlobalPool.strings.length;
      baseGlobalPool.strings.push(str);
      baseStrMap.set(str, mapped);
    }
    return mapped;
  };

  const remapKeyStr = idx => {
    const key = splitPkg.keyStrings.strings[idx];
    if (key === undefined) return idx;
    let mapped = baseKeyMap.get(key);
    if (mapped === undefined) {
      mapped = basePkg.keyStrings.strings.length;
      basePkg.keyStrings.strings.push(key);
      baseKeyMap.set(key, mapped);
    }
    return mapped;
  };

  const remapValueAt = valPos => {
    const valType = buf[valPos + 3];
    if (valType === VALUE_TYPE_STRING) {
      const oldIdx = buf.readUInt32LE(valPos + 4);
      buf.writeUInt32LE(remapGlobalStr(oldIdx) >>> 0, valPos + 4);
    }
  };

  const offsetsPos = chunkHeaderSize;
  const isSparse = (flags & FLAG_SPARSE) !== 0;
  const isOffset16 = (flags & FLAG_OFFSET16) !== 0;

  for (let i = 0; i < entryCount; i++) {
    let relOff;
    if (isSparse) {
      relOff = buf.readUInt16LE(offsetsPos + i * 4 + 2) * 4;
    } else if (isOffset16) {
      const o16 = buf.readUInt16LE(offsetsPos + i * 2);
      if (o16 === 0xffff) continue;
      relOff = o16 * 4;
    } else {
      relOff = buf.readUInt32LE(offsetsPos + i * 4);
      if (relOff === NO_ENTRY) continue;
    }

    const entryPos = entriesStart + relOff;
    const entrySizeOrKey = buf.readUInt16LE(entryPos);
    const entryFlags = buf.readUInt16LE(entryPos + 2);

    if ((entryFlags & FLAG_COMPACT) !== 0) {
      // Compact entry: flags(2) + key(2), value follows at +4? Actually compact encodes value in 4/8 bytes.
      const compactKey = entrySizeOrKey;
      buf.writeUInt16LE(remapKeyStr(compactKey) & 0xffff, entryPos);
      const valType = buf[entryPos + 3];
      if ((entryFlags >> 8) === VALUE_TYPE_STRING || valType === VALUE_TYPE_STRING) {
        const oldIdx = buf.readUInt32LE(entryPos + 4);
        buf.writeUInt32LE(remapGlobalStr(oldIdx) >>> 0, entryPos + 4);
      }
      continue;
    }

    const oldKey = buf.readUInt32LE(entryPos + 4);
    buf.writeUInt32LE(remapKeyStr(oldKey) >>> 0, entryPos + 4);

    if ((entryFlags & FLAG_COMPLEX) !== 0) {
      const mapCount = buf.readUInt32LE(entryPos + entrySizeOrKey + 4);
      let mapPos = entryPos + entrySizeOrKey + 8;
      for (let m = 0; m < mapCount; m++) {
        remapValueAt(mapPos + 4);
        mapPos += 12;
      }
    } else {
      remapValueAt(entryPos + entrySizeOrKey);
    }
  }

  return { tid: buf[8], raw: buf };
}

function serializePackage(pkg) {
  const typeStringsBuf = serializeResStringPool(pkg.typeStrings);
  const keyStringsBuf = serializeResStringPool(pkg.keyStrings);
  const typeStringsRel = pkg.headerBytes.length;
  const keyStringsRel = typeStringsRel + typeStringsBuf.length;

  const bodyParts = pkg.chunks.map(c => c.raw);
  const totalSize = keyStringsRel + keyStringsBuf.length + bodyParts.reduce((a, b) => a + b.length, 0);

  const header = Buffer.from(pkg.headerBytes);
  header.writeUInt32LE(totalSize, 4);
  header.writeUInt32LE(typeStringsRel, 268);
  header.writeUInt32LE(pkg.typeStrings.strings.length, 272);
  header.writeUInt32LE(keyStringsRel, 276);
  header.writeUInt32LE(pkg.keyStrings.strings.length, 280);

  return Buffer.concat([header, typeStringsBuf, keyStringsBuf, ...bodyParts], totalSize);
}

/**
 * Merges one or more split config `resources.arsc` buffers (density/locale) into base `resources.arsc`.
 */
export function mergeResourcesArsc(baseArscBuf, splitArscBuffers = []) {
  if (!splitArscBuffers || splitArscBuffers.length === 0) return baseArscBuf;
  const base = parseArsc(baseArscBuf);
  if (!base.globalStringPool || base.packages.length === 0) {
    throw new Error('Base resources.arsc missing string pool or package');
  }

  const basePkg = base.packages[0];
  const baseStrMap = new Map();
  base.globalStringPool.strings.forEach((s, idx) => {
    if (!baseStrMap.has(s)) baseStrMap.set(s, idx);
  });
  const baseKeyMap = new Map();
  basePkg.keyStrings.strings.forEach((s, idx) => {
    if (!baseKeyMap.has(s)) baseKeyMap.set(s, idx);
  });

  for (const splitBuf of splitArscBuffers) {
    const split = parseArsc(splitBuf);
    if (!split.globalStringPool || split.packages.length === 0) continue;
    const splitPkg = split.packages.find(p => p.pkgId === basePkg.pkgId) || split.packages[0];

    for (const chunk of splitPkg.chunks) {
      if (chunk.type !== RES_TABLE_TYPE_TYPE) continue;
      const remapped = remapTypeChunk(
        chunk.raw,
        splitPkg,
        basePkg,
        split.globalStringPool,
        base.globalStringPool,
        baseStrMap,
        baseKeyMap
      );
      // Insert right after the last chunk of the same type id (or append)
      let insertAt = -1;
      for (let i = basePkg.chunks.length - 1; i >= 0; i--) {
        if (basePkg.chunks[i].tid === remapped.tid) {
          insertAt = i + 1;
          break;
        }
      }
      const newChunk = { type: RES_TABLE_TYPE_TYPE, tid: remapped.tid, raw: remapped.raw };
      if (insertAt >= 0) {
        basePkg.chunks.splice(insertAt, 0, newChunk);
      } else {
        basePkg.chunks.push(newChunk);
      }
    }
  }

  const globalPoolBuf = serializeResStringPool(base.globalStringPool);
  const pkgBuffers = base.packages.map(serializePackage);
  const totalSize = base.headerSize + globalPoolBuf.length +
    pkgBuffers.reduce((a, b) => a + b.length, 0) +
    base.trailingChunks.reduce((a, b) => a + b.length, 0);

  const tableHeader = Buffer.alloc(base.headerSize);
  tableHeader.writeUInt16LE(RES_TABLE_TYPE, 0);
  tableHeader.writeUInt16LE(base.headerSize, 2);
  tableHeader.writeUInt32LE(totalSize, 4);
  tableHeader.writeUInt32LE(base.packages.length, 8);

  return Buffer.concat([tableHeader, globalPoolBuf, ...pkgBuffers, ...base.trailingChunks], totalSize);
}

/**
 * Look up a resource ID (e.g. 0x7f100001) for a given type (e.g. 'mipmap') and entry name
 * (e.g. 'ic_launcher_foreground') in a resources.arsc buffer. Returns null if not found.
 */
export function findResourceId(arscBuf, typeName, entryName) {
  if (!Buffer.isBuffer(arscBuf) || arscBuf.length < 12 || !typeName || !entryName) {
    return null;
  }
  try {
    const parsed = parseArsc(arscBuf);
    for (const pkg of parsed.packages) {
      const typeIdx = pkg.typeStrings.strings.indexOf(typeName);
      if (typeIdx < 0) continue;
      const targetTid = typeIdx + 1;
      for (const chunk of pkg.chunks) {
        if (chunk.type !== RES_TABLE_TYPE_TYPE || chunk.tid !== targetTid) continue;
        const buf = chunk.raw;
        if (buf.length < 20) continue;
        const chunkHeaderSize = buf.readUInt16LE(2);
        const flags = buf[9];
        const entryCount = buf.readUInt32LE(12);
        const entriesStart = buf.readUInt32LE(16);
        const offsetsPos = chunkHeaderSize;
        const isSparse = (flags & FLAG_SPARSE) !== 0;
        const isOffset16 = (flags & FLAG_OFFSET16) !== 0;

        for (let i = 0; i < entryCount; i++) {
          let entryIdx = i;
          let relOff;
          if (isSparse) {
            if (offsetsPos + i * 4 + 4 > buf.length) break;
            entryIdx = buf.readUInt16LE(offsetsPos + i * 4);
            relOff = buf.readUInt16LE(offsetsPos + i * 4 + 2) * 4;
          } else if (isOffset16) {
            if (offsetsPos + i * 2 + 2 > buf.length) break;
            const o16 = buf.readUInt16LE(offsetsPos + i * 2);
            if (o16 === 0xffff) continue;
            relOff = o16 * 4;
          } else {
            if (offsetsPos + i * 4 + 4 > buf.length) break;
            relOff = buf.readUInt32LE(offsetsPos + i * 4);
            if (relOff === NO_ENTRY) continue;
          }

          const entryPos = entriesStart + relOff;
          if (entryPos + 8 > buf.length) continue;
          const entrySizeOrKey = buf.readUInt16LE(entryPos);
          const entryFlags = buf.readUInt16LE(entryPos + 2);
          const keyIdx = (entryFlags & FLAG_COMPACT) !== 0
            ? entrySizeOrKey
            : buf.readUInt32LE(entryPos + 4);
          if (pkg.keyStrings.strings[keyIdx] === entryName) {
            return (((pkg.pkgId & 0xff) << 24) | ((targetTid & 0xff) << 16) | (entryIdx & 0xffff)) >>> 0;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function findMipmapResourceId(arscBuf, entryName) {
  return findResourceId(arscBuf, 'mipmap', entryName);
}

/**
 * Rewrites every configuration of the color resource `entryName` (e.g. 'iconBackground') in place
 * to the ARGB value `argb`. Only simple TYPE_INT_COLOR_* values are touched; the table layout and
 * size are unchanged. Returns { buffer, patched } where buffer is a patched copy (or the input when
 * nothing matched).
 */
export function setColorResourceValue(arscBuf, entryName, argb) {
  if (!Buffer.isBuffer(arscBuf) || arscBuf.length < 12 || !entryName) return { buffer: arscBuf, patched: 0 };
  const out = Buffer.from(arscBuf);
  let patched = 0;
  try {
    if (out.readUInt16LE(0) !== RES_TABLE_TYPE) return { buffer: arscBuf, patched: 0 };
    let pos = out.readUInt16LE(2);
    while (pos + 8 <= out.length) {
      const ct = out.readUInt16LE(pos);
      const csz = out.readUInt32LE(pos + 4);
      if (csz < 8) break;
      if (ct === RES_TABLE_PACKAGE_TYPE) {
        const pkgBuf = out.subarray(pos, pos + csz);
        const typeStrings = parseResStringPool(pkgBuf, pkgBuf.readUInt32LE(268));
        const keyStrings = parseResStringPool(pkgBuf, pkgBuf.readUInt32LE(276));
        const colorTid = typeStrings.strings.indexOf('color') + 1;
        const keyIdx = keyStrings.strings.indexOf(entryName);
        if (colorTid > 0 && keyIdx >= 0) {
          let p = pkgBuf.readUInt16LE(2);
          while (p + 8 <= pkgBuf.length) {
            const t = pkgBuf.readUInt16LE(p);
            const sz = pkgBuf.readUInt32LE(p + 4);
            if (sz < 8) break;
            if (t === RES_TABLE_TYPE_TYPE && pkgBuf[p + 8] === colorTid) {
              patched += patchColorEntries(pkgBuf.subarray(p, p + sz), keyIdx, argb);
            }
            p += sz;
          }
        }
      }
      pos += csz;
    }
  } catch {
    return { buffer: arscBuf, patched: 0 };
  }
  return patched > 0 ? { buffer: out, patched } : { buffer: arscBuf, patched: 0 };
}

function patchColorEntries(buf, keyIdx, argb) {
  const chunkHeaderSize = buf.readUInt16LE(2);
  const flags = buf[9];
  const entryCount = buf.readUInt32LE(12);
  const entriesStart = buf.readUInt32LE(16);
  const isSparse = (flags & FLAG_SPARSE) !== 0;
  const isOffset16 = (flags & FLAG_OFFSET16) !== 0;
  let patched = 0;
  for (let i = 0; i < entryCount; i++) {
    let relOff;
    if (isSparse) {
      relOff = buf.readUInt16LE(chunkHeaderSize + i * 4 + 2) * 4;
    } else if (isOffset16) {
      const o16 = buf.readUInt16LE(chunkHeaderSize + i * 2);
      if (o16 === 0xffff) continue;
      relOff = o16 * 4;
    } else {
      relOff = buf.readUInt32LE(chunkHeaderSize + i * 4);
      if (relOff === NO_ENTRY) continue;
    }
    const entryPos = entriesStart + relOff;
    if (entryPos + 8 > buf.length) continue;
    const sizeOrKey = buf.readUInt16LE(entryPos);
    const entryFlags = buf.readUInt16LE(entryPos + 2);
    if ((entryFlags & FLAG_COMPLEX) !== 0) continue;
    let typePos;
    let dataPos;
    if ((entryFlags & FLAG_COMPACT) !== 0) {
      // Compact entry: key in the size field, dataType in the high flag byte, data inline.
      if (sizeOrKey !== keyIdx) continue;
      typePos = entryPos + 3;
      dataPos = entryPos + 4;
    } else {
      if (buf.readUInt32LE(entryPos + 4) !== keyIdx) continue;
      const valuePos = entryPos + sizeOrKey; // Res_value follows the entry header
      if (valuePos + 8 > buf.length) continue;
      typePos = valuePos + 3;
      dataPos = valuePos + 4;
    }
    const dataType = buf[typePos];
    if (dataType < 0x1c || dataType > 0x1f) continue; // TYPE_INT_COLOR_ARGB8 .. RGB4
    buf[typePos] = 0x1c;
    buf.writeUInt32LE(argb >>> 0, dataPos);
    patched++;
  }
  return patched;
}

const CONFIG_DENSITY_OFFSET = 14; // ResTable_config.density (after size, imsi, locale, orientation, touchscreen)
const TYPE_HEADER_CONFIG_OFFSET = 20; // ResTable_type: chunk header (8), id, flags, reserved (4), entryCount, entriesStart
const SPEC_CONFIG_DENSITY = 0x0100; // ResTable_config::CONFIG_DENSITY in ResTable_typeSpec entry flags

function typeChunkEntries(buf) {
  const chunkHeaderSize = buf.readUInt16LE(2);
  const flags = buf[9];
  const entryCount = buf.readUInt32LE(12);
  const entriesStart = buf.readUInt32LE(16);
  const isSparse = (flags & FLAG_SPARSE) !== 0;
  const isOffset16 = (flags & FLAG_OFFSET16) !== 0;
  const out = [];
  for (let i = 0; i < entryCount; i++) {
    let entryIdx = i;
    let relOff;
    if (isSparse) {
      entryIdx = buf.readUInt16LE(chunkHeaderSize + i * 4);
      relOff = buf.readUInt16LE(chunkHeaderSize + i * 4 + 2) * 4;
    } else if (isOffset16) {
      const o16 = buf.readUInt16LE(chunkHeaderSize + i * 2);
      if (o16 === 0xffff) continue;
      relOff = o16 * 4;
    } else {
      relOff = buf.readUInt32LE(chunkHeaderSize + i * 4);
      if (relOff === NO_ENTRY) continue;
    }
    const entryPos = entriesStart + relOff;
    if (entryPos + 8 > buf.length) continue;
    const sizeOrKey = buf.readUInt16LE(entryPos);
    const entryFlags = buf.readUInt16LE(entryPos + 2);
    if ((entryFlags & FLAG_COMPLEX) !== 0) continue;
    if ((entryFlags & FLAG_COMPACT) !== 0) {
      out.push({ entryIdx, key: sizeOrKey, dataType: entryFlags >> 8, data: buf.readUInt32LE(entryPos + 4), dataAt: entryPos + 4 });
    } else {
      const valuePos = entryPos + sizeOrKey;
      if (valuePos + 8 > buf.length) continue;
      out.push({ entryIdx, key: buf.readUInt32LE(entryPos + 4), dataType: buf[valuePos + 3], data: buf.readUInt32LE(valuePos + 4), dataAt: valuePos + 4 });
    }
  }
  return out;
}

/**
 * Adds a `density` configuration (e.g. 640 = xxxhdpi) of the file resource `typeName/entryName` next
 * to every configuration it already has with `fromDensity` (e.g. 160 = mdpi; the night-mdpi one gets
 * a night-xxxhdpi twin). Each new configuration points at the original file path with the density
 * qualifier swapped (`-mdpi` -> `-xxxhdpi`); the caller must add those files to the APK. The resource
 * id is unchanged, so every reference (themes, layouts) keeps working, and Android now picks the
 * denser file on any screen above `fromDensity` and scales it down instead of up.
 * `extension` (e.g. '.webp') also gives the new paths and the `fromDensity` ones that file extension
 * (the caller ships the source configuration's file under its new name: `renamed`).
 * Returns { buffer, added: [{ from, path }], renamed: [{ from, path }] } (the input buffer when nothing changed).
 */
export function addFileResourceDensity(arscBuf, typeName, entryName, { fromDensity = 160, density = 640, fromQualifier = 'mdpi', qualifier = 'xxxhdpi', extension = null } = {}) {
  const parsed = parseArsc(arscBuf);
  const pool = parsed.globalStringPool;
  const added = [];
  const renamed = [];
  const withExtension = file => (extension ? file.replace(/\.[^./]+$/, extension) : file);
  const internString = str => {
    let idx = pool.strings.indexOf(str);
    if (idx < 0) {
      idx = pool.strings.length;
      pool.strings.push(str);
    }
    return idx;
  };
  for (const pkg of parsed.packages) {
    const tid = pkg.typeStrings.strings.indexOf(typeName) + 1;
    const keyIdx = pkg.keyStrings.strings.indexOf(entryName);
    if (tid <= 0 || keyIdx < 0) continue;
    const spec = pkg.chunks.find(c => c.type === RES_TABLE_TYPE_SPEC_TYPE && c.tid === tid);
    if (!spec) continue;
    const specEntryCount = spec.raw.readUInt32LE(12);
    const typeChunks = pkg.chunks.filter(c => c.type === RES_TABLE_TYPE_TYPE && c.tid === tid);
    const configOf = c => c.raw.subarray(TYPE_HEADER_CONFIG_OFFSET, c.raw.readUInt16LE(2));
    const newChunks = [];
    for (const chunk of typeChunks) {
      const config = configOf(chunk);
      if (config.length < CONFIG_DENSITY_OFFSET + 2 || config.readUInt16LE(CONFIG_DENSITY_OFFSET) !== fromDensity) continue;
      const entry = typeChunkEntries(chunk.raw).find(e => e.key === keyIdx);
      if (!entry || entry.dataType !== VALUE_TYPE_STRING) continue;
      const from = pool.strings[entry.data];
      const qualifierRe = new RegExp(`-${fromQualifier}(?=-v\\d+/|/)`);
      if (typeof from !== 'string' || !qualifierRe.test(from)) continue;
      const target = Buffer.from(config);
      target.writeUInt16LE(density, CONFIG_DENSITY_OFFSET);
      // Already there (patched twice, or the input had the density): leave it alone.
      if (typeChunks.some(c => configOf(c).equals(target) && typeChunkEntries(c.raw).some(e => e.key === keyIdx))) continue;
      if (withExtension(from) !== from) {
        chunk.raw.writeUInt32LE(internString(withExtension(from)), entry.dataAt);
        renamed.push({ from, path: withExtension(from) });
      }
      const path = withExtension(from.replace(qualifierRe, `-${qualifier}`));
      const strIdx = internString(path);
      // Dense ResTable_type with one entry: offsets for every id of the type, NO_ENTRY but ours.
      const headerSize = chunk.raw.readUInt16LE(2);
      const entriesStart = headerSize + 4 * specEntryCount;
      const raw = Buffer.alloc(entriesStart + 16);
      chunk.raw.copy(raw, 0, 0, headerSize);
      raw.writeUInt32LE(raw.length, 4);
      raw[9] = 0; // dense, 32-bit offsets
      raw.writeUInt32LE(specEntryCount, 12);
      raw.writeUInt32LE(entriesStart, 16);
      target.copy(raw, TYPE_HEADER_CONFIG_OFFSET);
      for (let i = 0; i < specEntryCount; i++) raw.writeUInt32LE(i === entry.entryIdx ? 0 : NO_ENTRY, headerSize + 4 * i);
      raw.writeUInt16LE(8, entriesStart);          // ResTable_entry.size
      raw.writeUInt16LE(0, entriesStart + 2);      // flags
      raw.writeUInt32LE(keyIdx, entriesStart + 4); // key
      raw.writeUInt16LE(8, entriesStart + 8);      // Res_value.size
      raw[entriesStart + 10] = 0;
      raw[entriesStart + 11] = VALUE_TYPE_STRING;
      raw.writeUInt32LE(strIdx, entriesStart + 12);
      newChunks.push({ type: RES_TABLE_TYPE_TYPE, tid, raw });
      added.push({ from, path });
      // The resource now varies by density.
      const specFlagsAt = spec.raw.readUInt16LE(2) + 4 * entry.entryIdx;
      spec.raw.writeUInt32LE((spec.raw.readUInt32LE(specFlagsAt) | SPEC_CONFIG_DENSITY) >>> 0, specFlagsAt);
    }
    if (newChunks.length) {
      const last = pkg.chunks.lastIndexOf(typeChunks[typeChunks.length - 1]);
      pkg.chunks.splice(last + 1, 0, ...newChunks);
    }
  }
  if (!added.length) return { buffer: arscBuf, added, renamed };

  const globalPoolBuf = serializeResStringPool(pool);
  const pkgBuffers = parsed.packages.map(serializePackage);
  const totalSize = parsed.headerSize + globalPoolBuf.length + pkgBuffers.reduce((a, b) => a + b.length, 0)
    + parsed.trailingChunks.reduce((a, b) => a + b.length, 0);
  const tableHeader = Buffer.alloc(parsed.headerSize);
  tableHeader.writeUInt16LE(RES_TABLE_TYPE, 0);
  tableHeader.writeUInt16LE(parsed.headerSize, 2);
  tableHeader.writeUInt32LE(totalSize, 4);
  tableHeader.writeUInt32LE(parsed.packages.length, 8);
  return { buffer: Buffer.concat([tableHeader, globalPoolBuf, ...pkgBuffers, ...parsed.trailingChunks], totalSize), added, renamed };
}

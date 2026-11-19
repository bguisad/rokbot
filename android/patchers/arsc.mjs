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

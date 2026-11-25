import { crc32, deflateSync } from 'node:zlib';
// Minimal PE helpers for the original Windows executable: read the application icon,
// update Electron's embedded ASAR integrity value and remove the Authenticode
// signature that no longer matches once the executable has been modified.

const RT_ICON = 3, RT_GROUP_ICON = 14, RT_VERSION = 16;
const LANG_ENGLISH_US = 0x0409;
const align = (value, boundary) => Math.ceil(value / boundary) * boundary;
const align4 = value => (value + 3) & ~3;

function headers(buffer) {
  if (buffer.toString('latin1', 0, 2) !== 'MZ') throw new Error('Not a PE executable');
  const pe = buffer.readUInt32LE(0x3c);
  if (buffer.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid PE signature');
  const sectionCount = buffer.readUInt16LE(pe + 6), optionalSize = buffer.readUInt16LE(pe + 20);
  const optional = pe + 24, magic = buffer.readUInt16LE(optional);
  if (magic !== 0x20b) throw new Error('Only 64-bit PE executables are supported');
  const directories = optional + 112;
  const sections = [];
  for (let index = 0, at = optional + optionalSize; index < sectionCount; index++, at += 40)
    sections.push({
      headerOffset: at,
      name: buffer.toString('ascii', at, at + 8).replace(/\0.*$/, ''),
      virtualAddress: buffer.readUInt32LE(at + 12),
      virtualSize: buffer.readUInt32LE(at + 8),
      rawOffset: buffer.readUInt32LE(at + 20),
      rawSize: buffer.readUInt32LE(at + 16),
    });
  return {
    pe,
    optional,
    directories,
    sectionAlignment: buffer.readUInt32LE(optional + 32),
    fileAlignment: buffer.readUInt32LE(optional + 36),
    sections,
  };
}

function offsetOf(sections, rva) {
  const section = sections.find(item => rva >= item.virtualAddress && rva < item.virtualAddress + Math.max(item.virtualSize, item.rawSize));
  if (!section) throw new Error('Resource address outside the image');
  return section.rawOffset + rva - section.virtualAddress;
}

/** Map of resource type -> id -> data buffer (first language). */
function resources(buffer) {
  const { directories, sections } = headers(buffer);
  const rva = buffer.readUInt32LE(directories + 2 * 8);
  if (!rva) return new Map();
  const root = offsetOf(sections, rva);
  const entries = at => {
    const count = buffer.readUInt16LE(at + 12) + buffer.readUInt16LE(at + 14);
    return Array.from({ length: count }, (_, index) => {
      const entry = at + 16 + index * 8, name = buffer.readUInt32LE(entry), target = buffer.readUInt32LE(entry + 4);
      return { id: name & 0x80000000 ? null : name, directory: Boolean(target & 0x80000000), offset: root + (target & 0x7fffffff) };
    });
  };
  const result = new Map();
  for (const type of entries(root)) {
    if (!type.directory || type.id === null) continue;
    const items = new Map();
    for (const item of entries(type.offset)) {
      if (!item.directory) continue;
      const language = entries(item.offset).find(value => !value.directory);
      if (!language) continue;
      const dataRva = buffer.readUInt32LE(language.offset), size = buffer.readUInt32LE(language.offset + 4);
      const start = offsetOf(sections, dataRva);
      items.set(item.id ?? items.size, buffer.subarray(start, start + size));
    }
    result.set(type.id, items);
  }
  return result;
}

/** The first icon group as an .ico file and its largest PNG image. */
export function applicationIcon(buffer) {
  const all = resources(buffer), groups = all.get(RT_GROUP_ICON), icons = all.get(RT_ICON);
  if (!groups?.size || !icons) throw new Error('Executable has no application icon');
  const group = [...groups.values()][0], count = group.readUInt16LE(4);
  const images = Array.from({ length: count }, (_, index) => {
    const at = 6 + index * 14, id = group.readUInt16LE(at + 12);
    const data = icons.get(id);
    if (!data) throw new Error('Icon image is missing');
    return { header: group.subarray(at, at + 12), width: group[at] || 256, data };
  });
  const directory = Buffer.alloc(6 + count * 16);
  group.copy(directory, 0, 0, 6);
  let offset = directory.length;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    image.header.copy(directory, at, 0, 8);
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });
  const largest = [...images].sort((a, b) => b.width - a.width)[0];
  return { ico: Buffer.concat([directory, ...images.map(image => image.data)]),
    png: isPng(largest.data) ? largest.data : dibToPng(largest.data) };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const isPng = data => data.subarray(0, 8).equals(PNG_SIGNATURE);

/** Convert a 32-bit BGRA icon bitmap (bottom-up, XOR mask followed by AND mask) to PNG. */
function dibToPng(dib) {
  const headerSize = dib.readUInt32LE(0), width = dib.readInt32LE(4), height = dib.readInt32LE(8) / 2;
  const bits = dib.readUInt16LE(14), compression = dib.readUInt32LE(16);
  if (bits !== 32 || compression !== 0 || width <= 0 || height <= 0) throw new Error('Unsupported icon bitmap');
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const source = headerSize + (height - 1 - y) * stride, target = y * (stride + 1) + 1;
    for (let x = 0; x < width; x++) {
      const at = source + x * 4, to = target + x * 4;
      raw[to] = dib[at + 2]; raw[to + 1] = dib[at + 1]; raw[to + 2] = dib[at]; raw[to + 3] = dib[at + 3];
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const INTEGRITY = /\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-f]{64})"\}\]/g;

/** Replace Electron's embedded app.asar header hash (same length, in place). */
export function replaceAsarIntegrity(buffer, expected, replacement) {
  const text = buffer.toString('latin1');
  const matches = [...text.matchAll(INTEGRITY)];
  if (matches.length !== 1) throw new Error('Embedded ASAR integrity record not found');
  if (matches[0][1] !== expected) throw new Error('Embedded ASAR integrity does not match the original');
  if (!/^[0-9a-f]{64}$/.test(replacement)) throw new Error('Invalid ASAR header hash');
  const at = matches[0].index + matches[0][0].indexOf(expected);
  const output = Buffer.from(buffer);
  output.write(replacement, at, 'latin1');
  return output;
}

/** Remove the Authenticode certificate table; the checksum is cleared as it is not enforced for applications. */
export function stripAuthenticode(buffer) {
  const { optional, directories } = headers(buffer);
  const entry = directories + 4 * 8;
  const offset = buffer.readUInt32LE(entry), size = buffer.readUInt32LE(entry + 4);
  const output = Buffer.from(buffer);
  if (!offset || !size) return output;
  if (offset + size !== buffer.length) throw new Error('Certificate table is not at the end of the executable');
  output.writeUInt32LE(0, entry);
  output.writeUInt32LE(0, entry + 4);
  output.writeUInt32LE(0, optional + 64);
  // The table is 8-byte aligned after the image; any padding before it belongs to the image.
  return output.subarray(0, offset);
}

export function hasAuthenticode(buffer) {
  const { directories } = headers(buffer);
  return buffer.readUInt32LE(directories + 4 * 8 + 4) > 0;
}

function readResourceName(buffer, root, nameField) {
  if (!(nameField & 0x80000000)) return { id: nameField >>> 0, name: null };
  const at = root + (nameField & 0x7fffffff);
  const length = buffer.readUInt16LE(at);
  return { id: null, name: buffer.subarray(at + 2, at + 2 + length * 2).toString('utf16le') };
}

function readDirEntries(buffer, root, at) {
  const namedCount = buffer.readUInt16LE(at + 12);
  const idCount = buffer.readUInt16LE(at + 14);
  const result = [];
  for (let i = 0; i < namedCount + idCount; i++) {
    const entry = at + 16 + i * 8;
    const key = readResourceName(buffer, root, buffer.readUInt32LE(entry));
    const target = buffer.readUInt32LE(entry + 4);
    result.push({ ...key, directory: Boolean(target & 0x80000000), offset: root + (target & 0x7fffffff) });
  }
  return result;
}

/** Parse the full 3-level PE .rsrc tree into an array of { type, name, lang, codePage, reserved, data }. */
function parseResourceTree(buffer) {
  const { directories, sections } = headers(buffer);
  const rva = buffer.readUInt32LE(directories + 2 * 8);
  if (!rva) return [];
  const root = offsetOf(sections, rva);
  const items = [];
  for (const typeEntry of readDirEntries(buffer, root, root)) {
    if (!typeEntry.directory) continue;
    const typeKey = typeEntry.name ?? typeEntry.id;
    for (const nameEntry of readDirEntries(buffer, root, typeEntry.offset)) {
      if (!nameEntry.directory) continue;
      const nameKey = nameEntry.name ?? nameEntry.id;
      for (const langEntry of readDirEntries(buffer, root, nameEntry.offset)) {
        if (langEntry.directory || langEntry.id === null) continue;
        const dataRva = buffer.readUInt32LE(langEntry.offset);
        const size = buffer.readUInt32LE(langEntry.offset + 4);
        const codePage = buffer.readUInt32LE(langEntry.offset + 8);
        const reserved = buffer.readUInt32LE(langEntry.offset + 12);
        const start = offsetOf(sections, dataRva);
        items.push({
          type: typeKey,
          name: nameKey,
          lang: langEntry.id,
          codePage,
          reserved,
          data: Buffer.from(buffer.subarray(start, start + size)),
        });
      }
    }
  }
  return items;
}

function compareResourceKeys(a, b) {
  const aNamed = typeof a === 'string', bNamed = typeof b === 'string';
  if (aNamed !== bNamed) return aNamed ? -1 : 1;
  if (aNamed) return a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0;
  return a - b;
}

/** Build a complete .rsrc section buffer anchored at rsrcVirtualAddress. */
function buildResourceSection(items, rsrcVirtualAddress) {
  const types = new Map();
  for (const item of items) {
    if (!types.has(item.type)) types.set(item.type, new Map());
    const byName = types.get(item.type);
    if (!byName.has(item.name)) byName.set(item.name, []);
    byName.get(item.name).push(item);
  }

  const sortedTypes = [...types.keys()].sort(compareResourceKeys);
  const stringOffsets = new Map();
  const strings = [];
  let stringBytes = 0;
  const registerString = str => {
    if (typeof str !== 'string' || stringOffsets.has(str)) return;
    const encoded = Buffer.from(str, 'utf16le');
    const record = Buffer.alloc(align4(2 + encoded.length));
    record.writeUInt16LE(str.length, 0);
    encoded.copy(record, 2);
    stringOffsets.set(str, stringBytes);
    strings.push(record);
    stringBytes += record.length;
  };

  let dirBytes = 16 + sortedTypes.length * 8;
  let leafCount = 0;
  const typeMeta = sortedTypes.map(type => {
    registerString(type);
    const byName = types.get(type);
    const sortedNames = [...byName.keys()].sort(compareResourceKeys);
    const nameDirAt = dirBytes;
    dirBytes += 16 + sortedNames.length * 8;
    const nameMeta = sortedNames.map(name => {
      registerString(name);
      const langs = [...byName.get(name)].sort((a, b) => a.lang - b.lang);
      const langDirAt = dirBytes;
      dirBytes += 16 + langs.length * 8;
      leafCount += langs.length;
      return { name, langDirAt, langs };
    });
    return { type, nameDirAt, nameMeta };
  });

  const stringsAt = dirBytes;
  const dataEntriesAt = align4(stringsAt + stringBytes);
  let payloadCursor = align4(dataEntriesAt + leafCount * 16);
  const leafMeta = [];
  for (const t of typeMeta) {
    for (const n of t.nameMeta) {
      for (const item of n.langs) {
        leafMeta.push({ item, dataAt: payloadCursor });
        payloadCursor = align4(payloadCursor + item.data.length);
      }
    }
  }

  const rsrc = Buffer.alloc(payloadCursor);
  const writeDir = (at, keys, getTarget, isSubdir) => {
    const namedCount = keys.filter(k => typeof k === 'string').length;
    rsrc.writeUInt16LE(namedCount, at + 12);
    rsrc.writeUInt16LE(keys.length - namedCount, at + 14);
    keys.forEach((key, idx) => {
      const entry = at + 16 + idx * 8;
      const nameField = typeof key === 'string' ? (0x80000000 | (stringsAt + stringOffsets.get(key))) >>> 0 : key >>> 0;
      const target = getTarget(idx);
      rsrc.writeUInt32LE(nameField, entry);
      rsrc.writeUInt32LE((target | (isSubdir ? 0x80000000 : 0)) >>> 0, entry + 4);
    });
  };

  writeDir(0, sortedTypes, i => typeMeta[i].nameDirAt, true);
  let leafIndex = 0;
  for (const t of typeMeta) {
    writeDir(t.nameDirAt, t.nameMeta.map(n => n.name), i => t.nameMeta[i].langDirAt, true);
    for (const n of t.nameMeta) {
      writeDir(n.langDirAt, n.langs.map(l => l.lang), i => dataEntriesAt + (leafIndex + i) * 16, false);
      for (let i = 0; i < n.langs.length; i++, leafIndex++) {
        const { item, dataAt } = leafMeta[leafIndex];
        const entryAt = dataEntriesAt + leafIndex * 16;
        rsrc.writeUInt32LE(rsrcVirtualAddress + dataAt, entryAt);
        rsrc.writeUInt32LE(item.data.length, entryAt + 4);
        rsrc.writeUInt32LE(item.codePage ?? 0, entryAt + 8);
        rsrc.writeUInt32LE(item.reserved ?? 0, entryAt + 12);
        item.data.copy(rsrc, dataAt);
      }
    }
  }

  let strCursor = stringsAt;
  for (const rec of strings) {
    rec.copy(rsrc, strCursor);
    strCursor += rec.length;
  }
  return rsrc;
}

/** Parse a .ico file into RT_ICON payloads and an RT_GROUP_ICON directory buffer. */
function icoToResourceEntries(icoBuffer, groupId = 1, lang = LANG_ENGLISH_US) {
  const ico = Buffer.isBuffer(icoBuffer) ? icoBuffer : Buffer.from(icoBuffer);
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('Invalid .ico header');
  }
  const count = ico.readUInt16LE(4);
  if (count <= 0 || ico.length < 6 + count * 16) {
    throw new Error('Invalid .ico image directory');
  }
  const groupData = Buffer.alloc(6 + count * 14);
  ico.copy(groupData, 0, 0, 6);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const entryOffset = 6 + i * 16;
    const size = ico.readUInt32LE(entryOffset + 8);
    const offset = ico.readUInt32LE(entryOffset + 12);
    if (!size || offset + size > ico.length) throw new Error(`Invalid .ico entry ${i}`);
    const iconId = i + 1;
    ico.copy(groupData, 6 + i * 14, entryOffset, entryOffset + 12);
    groupData.writeUInt16LE(iconId, 6 + i * 14 + 12);
    entries.push({ type: RT_ICON, name: iconId, lang, codePage: 0, reserved: 0, data: Buffer.from(ico.subarray(offset, offset + size)) });
  }
  entries.push({ type: RT_GROUP_ICON, name: groupId, lang, codePage: 0, reserved: 0, data: groupData });
  return entries;
}

function parseVersionNode(buffer, start = 0) {
  const length = buffer.readUInt16LE(start);
  const valueLength = buffer.readUInt16LE(start + 2);
  const type = buffer.readUInt16LE(start + 4);
  const end = start + length;
  let cursor = start + 6;
  while (cursor + 1 < end && buffer.readUInt16LE(cursor) !== 0) cursor += 2;
  const key = buffer.subarray(start + 6, cursor).toString('utf16le');
  cursor = align4(cursor + 2);
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  const value = valueBytes > 0 ? Buffer.from(buffer.subarray(cursor, Math.min(end, cursor + valueBytes))) : Buffer.alloc(0);
  cursor = align4(cursor + valueBytes);
  const children = [];
  while (cursor < end) {
    const child = parseVersionNode(buffer, cursor);
    children.push(child);
    cursor = align4(cursor + child.rawLength);
  }
  return { key, type, value, children, rawLength: length };
}

function serializeVersionNode(node) {
  const keyBuf = Buffer.from(`${node.key}\0`, 'utf16le');
  const headerLen = align4(6 + keyBuf.length);
  const valueLen = node.value?.length ?? 0;
  const valueWords = node.type === 1 ? (valueLen / 2) : valueLen;
  const parts = [Buffer.alloc(headerLen)];
  keyBuf.copy(parts[0], 6);
  if (valueLen > 0) parts.push(node.value);
  let cursor = headerLen + valueLen;
  if (node.children?.length) {
    const pad = align4(cursor) - cursor;
    if (pad) { parts.push(Buffer.alloc(pad)); cursor += pad; }
    node.children.forEach((child, index) => {
      if (index > 0) {
        const siblingPad = align4(cursor) - cursor;
        if (siblingPad) { parts.push(Buffer.alloc(siblingPad)); cursor += siblingPad; }
      }
      const childBuf = serializeVersionNode(child);
      parts.push(childBuf);
      cursor += childBuf.length;
    });
  }
  const out = Buffer.concat(parts);
  out.writeUInt16LE(out.length, 0);
  out.writeUInt16LE(valueWords, 2);
  out.writeUInt16LE(node.type, 4);
  return out;
}

function updateVersionResource(versionBuffer, versionStrings) {
  const root = parseVersionNode(versionBuffer, 0);
  const stringFileInfo = root.children.find(child => child.key === 'StringFileInfo');
  if (stringFileInfo) {
    for (const table of stringFileInfo.children) {
      const byKey = new Map(table.children.map(entry => [entry.key, entry]));
      for (const [key, val] of Object.entries(versionStrings)) {
        const value = Buffer.from(`${val}\0`, 'utf16le');
        if (byKey.has(key)) {
          byKey.get(key).type = 1;
          byKey.get(key).value = value;
        } else {
          table.children.push({ key, type: 1, value, children: [] });
        }
      }
    }
  }
  return serializeVersionNode(root);
}

/** Read StringFileInfo entries from the first RT_VERSION resource, or null if absent. */
export function versionInfo(buffer) {
  const ver = resources(buffer).get(RT_VERSION);
  if (!ver?.size) return null;
  const root = parseVersionNode([...ver.values()][0], 0);
  const stringFileInfo = root.children.find(child => child.key === 'StringFileInfo');
  if (!stringFileInfo?.children?.length) return {};
  const result = {};
  for (const entry of stringFileInfo.children[0].children) {
    result[entry.key] = entry.value.toString('utf16le').replace(/\0+$/, '');
  }
  return result;
}

/**
 * Replace RT_ICON / RT_GROUP_ICON and/or RT_VERSION strings in a 64-bit PE executable.
 * Strips Authenticode if present, preserves all other resources, and updates PE section
 * sizes and DataDirectory[2] cleanly.
 */
export function replaceResources(buffer, { ico = null, versionStrings = null } = {}) {
  let peBuffer = hasAuthenticode(buffer) ? stripAuthenticode(buffer) : Buffer.from(buffer);
  const { optional, directories, sectionAlignment, fileAlignment, sections } = headers(peBuffer);
  const rsrcSectionIndex = sections.findIndex(s => s.name === '.rsrc');
  const resDirRva = peBuffer.readUInt32LE(directories + 2 * 8);
  const targetSectionIndex = rsrcSectionIndex >= 0
    ? rsrcSectionIndex
    : sections.findIndex(s => resDirRva >= s.virtualAddress && resDirRva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize));
  if (targetSectionIndex < 0) throw new Error('Executable has no .rsrc resource section');

  const existing = parseResourceTree(peBuffer);
  const firstGroup = existing.find(item => item.type === RT_GROUP_ICON);
  const groupId = typeof firstGroup?.name === 'number' ? firstGroup.name : 1;
  const groupLang = firstGroup?.lang ?? LANG_ENGLISH_US;

  let nextItems = existing;
  if (ico) {
    nextItems = nextItems.filter(item => item.type !== RT_ICON && item.type !== RT_GROUP_ICON);
    nextItems.push(...icoToResourceEntries(ico, groupId, groupLang));
  }
  if (versionStrings) {
    nextItems = nextItems.map(item => (
      item.type === RT_VERSION
        ? { ...item, data: updateVersionResource(item.data, versionStrings) }
        : item
    ));
  }

  const rsrcSection = sections[targetSectionIndex];
  const newRsrc = buildResourceSection(nextItems, rsrcSection.virtualAddress);
  const trailingSections = sections.slice(targetSectionIndex + 1);
  const nextSection = trailingSections[0];
  const fitsInPlace = newRsrc.length <= rsrcSection.rawSize &&
    (!nextSection || rsrcSection.virtualAddress + newRsrc.length <= nextSection.virtualAddress);

  let output;
  if (fitsInPlace) {
    output = Buffer.from(peBuffer);
    output.fill(0, rsrcSection.rawOffset, rsrcSection.rawOffset + rsrcSection.rawSize);
    newRsrc.copy(output, rsrcSection.rawOffset);
    output.writeUInt32LE(newRsrc.length, rsrcSection.headerOffset + 8);
    output.writeUInt32LE(rsrcSection.virtualAddress, directories + 2 * 8);
    output.writeUInt32LE(newRsrc.length, directories + 2 * 8 + 4);
    output.writeUInt32LE(0, optional + 64);
    return output;
  }

  const newRawSize = align(newRsrc.length, fileAlignment);
  if (trailingSections.length === 0) {
    const newLength = rsrcSection.rawOffset + newRawSize;
    output = Buffer.alloc(newLength);
    peBuffer.copy(output, 0, 0, Math.min(peBuffer.length, rsrcSection.rawOffset));
    newRsrc.copy(output, rsrcSection.rawOffset);
    output.writeUInt32LE(newRsrc.length, rsrcSection.headerOffset + 8);
    output.writeUInt32LE(newRawSize, rsrcSection.headerOffset + 16);
    const newImageSize = align(rsrcSection.virtualAddress + newRsrc.length, sectionAlignment);
    output.writeUInt32LE(newImageSize, optional + 56);
    const prevInitData = output.readUInt32LE(optional + 8);
    output.writeUInt32LE(Math.max(0, prevInitData - rsrcSection.rawSize + newRawSize), optional + 8);
    output.writeUInt32LE(rsrcSection.virtualAddress, directories + 2 * 8);
    output.writeUInt32LE(newRsrc.length, directories + 2 * 8 + 4);
    output.writeUInt32LE(0, optional + 64);
    return output;
  }

  if (trailingSections.length === 1 && trailingSections[0].name === '.reloc') {
    const reloc = trailingSections[0];
    const newRelocVa = align(rsrcSection.virtualAddress + newRsrc.length, sectionAlignment);
    const newRelocRaw = rsrcSection.rawOffset + newRawSize;
    const totalLength = newRelocRaw + reloc.rawSize;
    output = Buffer.alloc(totalLength);
    peBuffer.copy(output, 0, 0, rsrcSection.rawOffset);
    newRsrc.copy(output, rsrcSection.rawOffset);
    peBuffer.copy(output, newRelocRaw, reloc.rawOffset, reloc.rawOffset + reloc.rawSize);
    output.writeUInt32LE(newRsrc.length, rsrcSection.headerOffset + 8);
    output.writeUInt32LE(newRawSize, rsrcSection.headerOffset + 16);
    output.writeUInt32LE(newRelocVa, reloc.headerOffset + 12);
    output.writeUInt32LE(newRelocRaw, reloc.headerOffset + 20);
    if (output.readUInt32LE(directories + 5 * 8) === reloc.virtualAddress) {
      output.writeUInt32LE(newRelocVa, directories + 5 * 8);
    }
    const newImageSize = align(newRelocVa + Math.max(reloc.virtualSize, reloc.rawSize), sectionAlignment);
    output.writeUInt32LE(newImageSize, optional + 56);
    const prevInitData = output.readUInt32LE(optional + 8);
    output.writeUInt32LE(Math.max(0, prevInitData - rsrcSection.rawSize + newRawSize), optional + 8);
    output.writeUInt32LE(rsrcSection.virtualAddress, directories + 2 * 8);
    output.writeUInt32LE(newRsrc.length, directories + 2 * 8 + 4);
    output.writeUInt32LE(0, optional + 64);
    return output;
  }

  throw new Error('Cannot expand .rsrc section when non-reloc sections follow it');
}

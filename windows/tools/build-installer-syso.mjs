#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const LANG_ENGLISH_US = 0x0409;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_REL_AMD64_ADDR32NB = 0x0003;
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040;
const IMAGE_SCN_MEM_READ = 0x40000000;
const IMAGE_SYM_CLASS_STATIC = 3;

const align4 = value => (value + 3) & ~3;

/**
 * Parse a Windows .ico file and produce a deterministic amd64 COFF .syso resource
 * object containing RT_ICON (1..N) and RT_GROUP_ICON (1) with zero timestamps.
 */
export function buildWindowsResourceSyso(icoBuffer) {
  const ico = Buffer.isBuffer(icoBuffer) ? icoBuffer : Buffer.from(icoBuffer);
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('Invalid .ico header');
  }
  const count = ico.readUInt16LE(4);
  if (count <= 0 || ico.length < 6 + count * 16) {
    throw new Error('Invalid .ico image directory');
  }

  const icons = [];
  const groupData = Buffer.alloc(6 + count * 14);
  groupData.writeUInt16LE(0, 0);
  groupData.writeUInt16LE(1, 2);
  groupData.writeUInt16LE(count, 4);

  for (let i = 0; i < count; i++) {
    const entryOffset = 6 + i * 16;
    const size = ico.readUInt32LE(entryOffset + 8);
    const offset = ico.readUInt32LE(entryOffset + 12);
    if (!size || offset + size > ico.length) {
      throw new Error(`Invalid .ico entry ${i}`);
    }
    const id = i + 1;
    icons.push({ id, data: ico.subarray(offset, offset + size) });
    ico.copy(groupData, 6 + i * 14, entryOffset, entryOffset + 12);
    groupData.writeUInt16LE(id, 6 + i * 14 + 12);
  }

  const items = [
    ...icons.map(item => ({ type: RT_ICON, id: item.id, data: item.data })),
    { type: RT_GROUP_ICON, id: 1, data: groupData },
  ];

  // Directory layout:
  // root (16 + 2*8) -> type RT_ICON (16 + count*8) -> type RT_GROUP_ICON (16 + 1*8)
  // -> lang dirs ((count+1)*(16 + 8)) -> data entries ((count+1)*16) -> aligned payloads
  const rootDirOffset = 0;
  const rootDirSize = 16 + 2 * 8;
  const iconTypeDirOffset = rootDirOffset + rootDirSize;
  const iconTypeDirSize = 16 + icons.length * 8;
  const groupTypeDirOffset = iconTypeDirOffset + iconTypeDirSize;
  const groupTypeDirSize = 16 + 8;
  const langDirsOffset = groupTypeDirOffset + groupTypeDirSize;
  const langDirStride = 16 + 8;
  const dataEntriesOffset = langDirsOffset + items.length * langDirStride;
  const dataEntryStride = 16;
  let payloadCursor = align4(dataEntriesOffset + items.length * dataEntryStride);

  const payloadOffsets = items.map(item => {
    const at = payloadCursor;
    payloadCursor = align4(payloadCursor + item.data.length);
    return at;
  });
  const rsrc = Buffer.alloc(payloadCursor);

  const writeDirHeader = (offset, idEntryCount) => {
    rsrc.writeUInt16LE(0, offset + 12); // NumberOfNamedEntries
    rsrc.writeUInt16LE(idEntryCount, offset + 14); // NumberOfIdEntries
  };
  const writeDirEntry = (offset, id, target, isSubdir) => {
    rsrc.writeUInt32LE(id >>> 0, offset);
    rsrc.writeUInt32LE((target | (isSubdir ? 0x80000000 : 0)) >>> 0, offset + 4);
  };

  // Root directory (sorted by ID ascending: RT_ICON=3, RT_GROUP_ICON=14)
  writeDirHeader(rootDirOffset, 2);
  writeDirEntry(rootDirOffset + 16, RT_ICON, iconTypeDirOffset, true);
  writeDirEntry(rootDirOffset + 24, RT_GROUP_ICON, groupTypeDirOffset, true);

  // RT_ICON directory (IDs 1..N)
  writeDirHeader(iconTypeDirOffset, icons.length);
  for (let i = 0; i < icons.length; i++) {
    writeDirEntry(iconTypeDirOffset + 16 + i * 8, icons[i].id, langDirsOffset + i * langDirStride, true);
  }

  // RT_GROUP_ICON directory (ID 1)
  writeDirHeader(groupTypeDirOffset, 1);
  writeDirEntry(groupTypeDirOffset + 16, 1, langDirsOffset + icons.length * langDirStride, true);

  // Language directories, IMAGE_RESOURCE_DATA_ENTRY records, payloads, and relocations
  const relocations = Buffer.alloc(items.length * 10);
  for (let i = 0; i < items.length; i++) {
    const langOffset = langDirsOffset + i * langDirStride;
    const entryOffset = dataEntriesOffset + i * dataEntryStride;
    const dataOffset = payloadOffsets[i];

    writeDirHeader(langOffset, 1);
    writeDirEntry(langOffset + 16, LANG_ENGLISH_US, entryOffset, false);

    rsrc.writeUInt32LE(dataOffset, entryOffset);
    rsrc.writeUInt32LE(items[i].data.length, entryOffset + 4);
    items[i].data.copy(rsrc, dataOffset);

    const relocAt = i * 10;
    relocations.writeUInt32LE(entryOffset, relocAt); // VirtualAddress within .rsrc
    relocations.writeUInt32LE(0, relocAt + 4); // SymbolTableIndex (.rsrc)
    relocations.writeUInt16LE(IMAGE_REL_AMD64_ADDR32NB, relocAt + 8);
  }

  const coffHeaderSize = 20;
  const sectionHeaderSize = 40;
  const rawDataOffset = coffHeaderSize + sectionHeaderSize;
  const relocsOffset = rawDataOffset + rsrc.length;
  const symTableOffset = relocsOffset + relocations.length;

  const header = Buffer.alloc(coffHeaderSize);
  header.writeUInt16LE(IMAGE_FILE_MACHINE_AMD64, 0);
  header.writeUInt16LE(1, 2); // NumberOfSections
  header.writeUInt32LE(0, 4); // TimeDateStamp (deterministic)
  header.writeUInt32LE(symTableOffset, 8);
  header.writeUInt32LE(1, 12); // NumberOfSymbols
  header.writeUInt16LE(0, 16); // SizeOfOptionalHeader
  header.writeUInt16LE(0, 18); // Characteristics

  const sectionHeader = Buffer.alloc(sectionHeaderSize);
  sectionHeader.write('.rsrc\0\0\0', 0, 'ascii');
  sectionHeader.writeUInt32LE(rsrc.length, 16); // SizeOfRawData
  sectionHeader.writeUInt32LE(rawDataOffset, 20); // PointerToRawData
  sectionHeader.writeUInt32LE(relocsOffset, 24); // PointerToRelocations
  sectionHeader.writeUInt16LE(items.length, 32); // NumberOfRelocations
  sectionHeader.writeUInt32LE((IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ) >>> 0, 36);

  const symbol = Buffer.alloc(18);
  symbol.write('.rsrc\0\0\0', 0, 'ascii');
  symbol.writeUInt32LE(0, 8); // Value
  symbol.writeInt16LE(1, 12); // SectionNumber (1-based)
  symbol.writeUInt16LE(0, 14); // Type
  symbol.writeUInt8(IMAGE_SYM_CLASS_STATIC, 16);
  symbol.writeUInt8(0, 17); // NumberOfAuxSymbols

  const stringTable = Buffer.alloc(4);
  stringTable.writeUInt32LE(4, 0);

  return Buffer.concat([header, sectionHeader, rsrc, relocations, symbol, stringTable]);
}

export async function writeInstallerSyso({
  icoPath,
  outPath,
} = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const windowsRoot = path.resolve(here, '..');
  const repoRoot = path.resolve(windowsRoot, '..');
  const resolvedIco = icoPath ?? path.join(repoRoot, 'assets/logo/rokbot.ico');
  const resolvedOut = outPath ?? path.join(windowsRoot, 'installer/rsrc_windows_amd64.syso');
  const syso = buildWindowsResourceSyso(await readFile(resolvedIco));
  await writeFile(resolvedOut, syso);
  return { icoPath: resolvedIco, outPath: resolvedOut, bytes: syso.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  writeInstallerSyso({ icoPath: arg('--ico'), outPath: arg('--out') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

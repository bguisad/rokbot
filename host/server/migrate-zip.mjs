// Random-access ZIP reader for migration uploads. A packed Grok Bot data folder can be large
// (caches, workspace files), so the archive is never loaded whole: only the central directory and
// the few entries the importer asks for are read from disk. Nothing is ever extracted to a path.
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { check } from './security.mjs';

const EOCD = 0x06054b50, EOCD64 = 0x06064b50, LOCATOR64 = 0x07064b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const MAX_ENTRIES = 500_000;

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  check(done === length, 400, 'ZIP 文件不完整');
  return buffer;
}

export async function isZipFile(filename) {
  const handle = await open(filename, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) return false;
    const head = await readAt(handle, 0, 4);
    return head.readUInt32LE(0) === LOCAL || head.readUInt32LE(0) === EOCD;
  } finally { await handle.close(); }
}

/** Opens an archive and returns its entry list plus a reader. Call close() when finished. */
export async function openZip(filename) {
  const handle = await open(filename, 'r');
  try {
    const { size } = await handle.stat();
    check(size >= 22, 400, '不是有效的 ZIP 文件');
    const tailLength = Math.min(size, 22 + 0xffff + 20);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at--) if (tail.readUInt32LE(at) === EOCD) { end = at; break; }
    check(end >= 0, 400, '不是有效的 ZIP 文件');
    let count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      check(end >= 20 && tail.readUInt32LE(end - 20) === LOCATOR64, 400, 'ZIP64 目录缺失');
      const record = await readAt(handle, Number(tail.readBigUInt64LE(end - 12)), 56);
      check(record.readUInt32LE(0) === EOCD64, 400, 'ZIP64 目录无效');
      count = Number(record.readBigUInt64LE(32)); directorySize = Number(record.readBigUInt64LE(40)); directoryOffset = Number(record.readBigUInt64LE(48));
    }
    check(count <= MAX_ENTRIES && directoryOffset + directorySize <= size, 400, 'ZIP 目录无效');
    const directory = await readAt(handle, directoryOffset, directorySize);
    const entries = [];
    for (let at = 0, index = 0; index < count; index++) {
      check(at + 46 <= directory.length && directory.readUInt32LE(at) === CENTRAL, 400, 'ZIP 目录损坏');
      const flags = directory.readUInt16LE(at + 8), method = directory.readUInt16LE(at + 10);
      let compressedSize = directory.readUInt32LE(at + 20), uncompressedSize = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32);
      let offset = directory.readUInt32LE(at + 42);
      const rawName = directory.subarray(at + 46, at + 46 + nameLength);
      const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      for (let x = 0; x + 4 <= extra.length;) {
        const id = extra.readUInt16LE(x), length = extra.readUInt16LE(x + 2);
        if (id === 1) {
          let y = x + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(extra.readBigUInt64LE(y)); y += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(y)); y += 8; }
          if (offset === 0xffffffff) { offset = Number(extra.readBigUInt64LE(y)); }
        }
        x += 4 + length;
      }
      // Bit 11 marks UTF-8 names. Archives made by macOS Finder and most tools use UTF-8 anyway.
      const name = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('utf8')).replace(/\\/g, '/');
      entries.push({ name, method, flags, compressedSize, size: uncompressedSize, offset, directory: name.endsWith('/') });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return {
      entries,
      async read(entry, { maxBytes = 512 * 1024 * 1024 } = {}) {
        check(!(entry.flags & 1), 400, `ZIP 中的加密文件无法读取：${entry.name}`);
        check([0, 8].includes(entry.method), 400, `不支持的压缩方式：${entry.name}`);
        check(entry.size <= maxBytes, 413, `文件过大，无法在迁移中读取：${entry.name}`);
        const header = await readAt(handle, entry.offset, 30);
        check(header.readUInt32LE(0) === LOCAL, 400, 'ZIP 文件头损坏');
        const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
        const compressed = await readAt(handle, start, entry.compressedSize);
        const bytes = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
        check(bytes.length === entry.size, 400, `ZIP 文件内容长度不符：${entry.name}`);
        return bytes;
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

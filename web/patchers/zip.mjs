// Pure Node.js ZIP assembly for the web client bundle (no APK signing or 0xd935 alignment padding).
import { crc32, deflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;
// 1981-01-01 00:00 reproducible timestamp.
const DOS_DATE = ((1981 - 1980) << 9) | (1 << 5) | 1;

const u16 = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(value); return bytes; };
const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return bytes; };

/** A new entry; compressed unless that does not help or the file must stay stored. */
export function createEntry(name, content, { store = false } = {}) {
  const bytes = Buffer.from(content);
  let method = 0, data = bytes;
  if (!store && bytes.length > 0) {
    const deflated = deflateRawSync(bytes, { level: 9 });
    if (deflated.length < bytes.length) { method = 8; data = deflated; }
  }
  return { name, flags: 0, method, time: 0, date: DOS_DATE, crc: crc32(bytes) >>> 0,
    compressedSize: data.length, size: bytes.length, externalAttributes: 0, data };
}

/** Writes ZIP entries in order without extra-field alignment padding. */
export function writeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const flags = /[^\x00-\x7f]/.test(entry.name) ? 0x800 : 0;
    const version = entry.method === 8 ? 20 : 10;
    const fields = Buffer.concat([u16(version), u16(flags), u16(entry.method), u16(entry.time), u16(entry.date),
      u32(entry.crc), u32(entry.data.length), u32(entry.size), u16(name.length)]);
    parts.push(u32(LOCAL), fields, u16(0), name, entry.data);
    central.push(Buffer.concat([u32(CENTRAL), u16(version), fields, u16(0), u16(0), u16(0), u16(0),
      u32(entry.externalAttributes ?? 0), u32(offset), name]));
    offset += 30 + name.length + entry.data.length;
  }
  const directory = Buffer.concat(central);
  if (entries.length > 0xffff || offset + directory.length > 0xffffffff) throw new Error('Web bundle too large');
  const end = Buffer.concat([u32(END), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.length), u32(offset), u16(0)]);
  return Buffer.concat([...parts, directory, end]);
}

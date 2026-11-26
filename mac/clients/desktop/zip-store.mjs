// Minimal, zero-dependency ZIP (STORE, method 0) archive builder with UTF-8 filenames.
// Shared by Desktop (Node.js) and Web (browser) clients for batch attachment/image download.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Sanitize a single filename (strip paths/control chars) and deduplicate case-insensitively. */
export function uniqueEntryName(rawName, takenNames, fallback = 'file') {
  const base = String(rawName || '')
    .split(/[/\\]/)
    .filter(Boolean)
    .pop() || fallback;
  const clean = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 180) || fallback;
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  let candidate = clean;
  for (let n = 1; takenNames.has(candidate.toLowerCase()); n++) {
    candidate = `${stem} (${n})${ext}`;
  }
  takenNames.add(candidate.toLowerCase());
  return candidate;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Build a ZIP archive Uint8Array from `[{ name, data }]` where `data` is a Uint8Array.
 * Uses STORE (compression method 0), which is ideal for already-compressed images/media.
 */
export function buildZipStore(entries, now = new Date()) {
  const encoder = new TextEncoder();
  const { dosTime, dosDate } = dosDateTime(now);
  const taken = new Set();
  const prepared = [];
  let localTotal = 0;
  let centralTotal = 0;

  for (const entry of entries) {
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const name = uniqueEntryName(entry.name, taken);
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const offset = localTotal;
    localTotal += 30 + nameBytes.length + data.length;
    centralTotal += 46 + nameBytes.length;
    prepared.push({ nameBytes, data, crc, offset });
  }

  const out = new Uint8Array(localTotal + centralTotal + 22);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let pos = 0;

  for (const item of prepared) {
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 0x0800, true);
    view.setUint16(pos + 8, 0, true);
    view.setUint16(pos + 10, dosTime, true);
    view.setUint16(pos + 12, dosDate, true);
    view.setUint32(pos + 14, item.crc, true);
    view.setUint32(pos + 18, item.data.length, true);
    view.setUint32(pos + 22, item.data.length, true);
    view.setUint16(pos + 26, item.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true);
    out.set(item.nameBytes, pos + 30);
    pos += 30 + item.nameBytes.length;
    out.set(item.data, pos);
    pos += item.data.length;
  }

  const centralOffset = pos;
  for (const item of prepared) {
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 8, 0x0800, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, dosTime, true);
    view.setUint16(pos + 14, dosDate, true);
    view.setUint32(pos + 16, item.crc, true);
    view.setUint32(pos + 20, item.data.length, true);
    view.setUint32(pos + 24, item.data.length, true);
    view.setUint16(pos + 28, item.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true);
    view.setUint16(pos + 32, 0, true);
    view.setUint16(pos + 34, 0, true);
    view.setUint16(pos + 36, 0, true);
    view.setUint32(pos + 38, 0, true);
    view.setUint32(pos + 42, item.offset, true);
    out.set(item.nameBytes, pos + 46);
    pos += 46 + item.nameBytes.length;
  }

  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, centralTotal, true);
  view.setUint32(pos + 16, centralOffset, true);
  view.setUint16(pos + 20, 0, true);

  return out;
}

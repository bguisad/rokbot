import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import nodePath from 'node:path';
import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import { check, equal, HttpError } from './security.mjs';
import { JsonStore, readJson, syncRenamedDirectory, writePrivate } from './storage.mjs';

export const MANIFEST_KEY_SCHEMA = 'rokbot-release-manifest-key/v1';
export const ANDROID_UPDATE_SCHEMA = 'rokbot-android-native-update/v1';
export const DESKTOP_UPDATE_SCHEMA = 'rokbot-desktop-update/v1';
export const DESKTOP_DELTAS_SCHEMA = 'rokbot-desktop-deltas/v1';
export const ANDROID_DELTAS_SCHEMA = 'rokbot-android-deltas/v1';
export const IOS_UPDATE_SCHEMA = 'rokbot-ios-update/v1';

const LEGACY_MANIFEST_KEY_SCHEMA = 'grokbot-release-manifest-key/v1';
const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_DELTA_BYTES = 512 * 1024 * 1024;

const CANONICAL_PLATFORMS = ['android', 'ios', 'macos', 'windows'];
const TRACKS = new Set(['stable', 'nightly', 'dogfood']);
const ALLOWED_EXTENSIONS = new Set(['.apk', '.ipa', '.dmg', '.zip', '.exe', '.asar', '.rbdelta', '.gbdelta']);
const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,180}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

const MIME_TYPES = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.apk', 'application/vnd.android.package-archive'],
  ['.ipa', 'application/octet-stream'],
  ['.dmg', 'application/x-apple-diskimage'],
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.zip', 'application/zip'],
  ['.asar', 'application/octet-stream'],
  ['.rbdelta', 'application/octet-stream'],
  ['.gbdelta', 'application/octet-stream'],
  ['.plist', 'application/xml; charset=utf-8'],
]);

const PLATFORM_MAP = new Map([
  ['android', { platform: 'android', defaultTarget: 'android' }],
  ['ios', { platform: 'ios', defaultTarget: 'ios' }],
  ['macos', { platform: 'macos', defaultTarget: 'darwin-arm64' }],
  ['darwin-arm64', { platform: 'macos', defaultTarget: 'darwin-arm64' }],
  ['darwin-x64', { platform: 'macos', defaultTarget: 'darwin-x64' }],
  ['windows', { platform: 'windows', defaultTarget: 'win32-x64' }],
  ['win32-x64', { platform: 'windows', defaultTarget: 'win32-x64' }],
]);

const OP_END = 0x00;
const OP_COPY = 0x01;
const OP_ADD = 0x02;
const RBD1_MAGIC = Buffer.from('RBD1', 'ascii');
const RBDELTA1_MAGIC = Buffer.from('RBDELTA1', 'ascii');
const BLOCK_SIZE = 4096;
const MIN_MATCH = 64;
const MAX_OP_LEN = 0x7fffffff;

function resolvePlatformInfo(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  const info = PLATFORM_MAP.get(key);
  check(info, 400, '不支持的平台类型');
  return info;
}

function resolveTrack(raw) {
  const track = String(raw ?? 'stable').trim().toLowerCase() || 'stable';
  check(TRACKS.has(track), 400, '不支持的发布通道');
  return track;
}

function safeFilename(raw, { requireAllowedExt = false } = {}) {
  let decoded = String(raw ?? '');
  try { decoded = decodeURIComponent(decoded); } catch { throw new HttpError(400, '文件名无效'); }
  check(
    SAFE_NAME_RE.test(decoded) &&
      !decoded.startsWith('.') &&
      !decoded.includes('..') &&
      !decoded.includes('/') &&
      !decoded.includes('\\'),
    400,
    '文件名无效',
  );
  if (requireAllowedExt) {
    const ext = nodePath.extname(decoded).toLowerCase();
    check(ALLOWED_EXTENSIONS.has(ext), 400, '不支持的安装包文件格式');
  }
  return decoded;
}

function containedPath(baseDir, ...segments) {
  const base = nodePath.resolve(baseDir);
  const target = nodePath.resolve(base, ...segments);
  check(target.startsWith(`${base}${nodePath.sep}`), 400, '文件路径无效');
  return target;
}

const INVALID_XML_CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

async function assertSafeDirectory(dirPath, rootDir) {
  let info;
  try {
    info = await lstat(dirPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') {
      throw new HttpError(403, '文件路径无效');
    }
    throw error;
  }
  check(!info.isSymbolicLink() && info.isDirectory(), 403, '文件路径无效');
  let realRoot;
  let realDir;
  try {
    [realRoot, realDir] = await Promise.all([realpath(rootDir), realpath(dirPath)]);
  } catch {
    throw new HttpError(403, '文件路径无效');
  }
  check(realDir === realRoot || realDir.startsWith(`${realRoot}${nodePath.sep}`), 403, '文件路径无效');
  return realDir;
}

async function assertNoSymlinkFile(
  targetPath,
  expectedBaseDir,
  rootDir,
  { missingStatus = 404, missingMessage = '更新文件不存在' } = {},
) {
  const realBase = await assertSafeDirectory(expectedBaseDir, rootDir);
  let info;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(missingStatus, missingMessage);
    if (error.code === 'ENOTDIR' || error.code === 'ELOOP') throw new HttpError(403, '文件路径无效');
    throw error;
  }
  check(!info.isSymbolicLink(), 403, '文件路径无效');
  check(info.isFile(), missingStatus, missingMessage);
  let realTarget;
  try {
    realTarget = await realpath(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(missingStatus, missingMessage);
    throw new HttpError(403, '文件路径无效');
  }
  check(realTarget.startsWith(`${realBase}${nodePath.sep}`), 403, '文件路径无效');
  return { info, realTarget };
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export function normalizeEcPublicKey(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('Update public key cannot be empty');
  const key = trimmed.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(trimmed)
    : createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Update public key must be ECDSA P-256 (prime256v1) SPKI key');
  }
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

export async function loadOrCreateManifestSigningKey(filename) {
  const existing = await readJson(filename, null);
  if (existing) {
    if (![MANIFEST_KEY_SCHEMA, LEGACY_MANIFEST_KEY_SCHEMA].includes(existing.schema) ||
        !existing.privateKey || !existing.publicKeySpkiBase64) {
      throw new Error(`Invalid manifest signing key file: ${filename}`);
    }
    const privateKey = createPrivateKey(existing.privateKey);
    const publicKeySpkiBase64 = normalizeEcPublicKey(existing.publicKeySpkiBase64);
    const publicKey = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' });
    const fingerprintSha256 = sha256Hex(Buffer.from(publicKeySpkiBase64, 'base64'));
    await chmod(filename, 0o600).catch(() => {});
    return { created: false, privateKey, publicKey, publicKeySpkiBase64, publicKeyPem, fingerprintSha256 };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' });
  const fingerprintSha256 = sha256Hex(Buffer.from(publicKeySpkiBase64, 'base64'));
  const payload = {
    schema: MANIFEST_KEY_SCHEMA,
    createdAt: new Date().toISOString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeySpkiBase64,
  };
  await writePrivate(filename, `${JSON.stringify(payload, null, 2)}\n`);
  return { created: true, privateKey, publicKey, publicKeySpkiBase64, publicKeyPem, fingerprintSha256 };
}

export function canonicalDesktopManifestPayload(record) {
  return [
    record.schema,
    record.platform,
    record.track,
    record.version,
    String(record.sha256).toLowerCase(),
    String(record.size),
    record.url,
    record.publishedAt,
  ].join('\n');
}

export function canonicalDesktopDeltasPayload(manifest) {
  const deltas = Array.isArray(manifest?.deltas) ? manifest.deltas : [];
  const asarDeltas = Array.isArray(manifest?.asarDeltas) ? manifest.asarDeltas : [];
  const header = [
    DESKTOP_DELTAS_SCHEMA,
    manifest.platform,
    manifest.track,
    manifest.version,
    String(manifest.sha256).toLowerCase(),
    String(manifest.size),
  ];
  const installerLines = deltas.map(d => [
    'installer',
    String(d.baseSha256).toLowerCase(),
    String(d.baseSize),
    String(d.sha256).toLowerCase(),
    String(d.size),
    d.url,
  ].join('|'));
  const asarLines = asarDeltas.map(a => [
    'asar',
    String(a.baseSha256).toLowerCase(),
    String(a.baseSize),
    String(a.targetSha256).toLowerCase(),
    String(a.targetSize),
    String(a.targetHeaderSha256).toLowerCase(),
    String(a.sha256).toLowerCase(),
    String(a.size),
    a.url,
  ].join('|'));
  return [...header, ...installerLines, ...asarLines].join('\n');
}

export function canonicalAndroidManifestPayload(record) {
  return [
    record.schema,
    record.track,
    record.packageName,
    record.versionName,
    String(record.versionCode),
    String(record.sha256).toLowerCase(),
    String(record.size),
    String(record.certificateSha256).toLowerCase(),
    record.url,
    record.publishedAt,
  ].join('\n');
}

export function canonicalAndroidDeltasPayload(manifest) {
  const deltas = Array.isArray(manifest?.deltas) ? manifest.deltas : [];
  const header = [
    ANDROID_DELTAS_SCHEMA,
    manifest.track,
    manifest.packageName,
    manifest.versionName,
    String(manifest.versionCode),
    String(manifest.sha256).toLowerCase(),
    String(manifest.size),
    String(manifest.certificateSha256).toLowerCase(),
  ];
  const lines = deltas.map(d => [
    String(d.baseSha256).toLowerCase(),
    String(d.baseSize),
    String(d.sha256).toLowerCase(),
    String(d.size),
    d.url,
  ].join('|'));
  return [...header, ...lines].join('\n');
}

// --- Self-contained Desktop RBD1 delta builder + ASAR header inspector ---

function encodeUleb128(value) {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) throw new RangeError('ULEB128 value must be non-negative');
  const bytes = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0n);
  return Buffer.from(bytes);
}

function hashWindow32(buf, pos) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 32; i += 4) {
    const word = buf[pos + i] | (buf[pos + i + 1] << 8) | (buf[pos + i + 2] << 16) | (buf[pos + i + 3] << 24);
    h = Math.imul(h ^ word, 0x01000193) >>> 0;
  }
  return h;
}

function buildRbd1Index(source) {
  const width = 32;
  if (source.length < width) return null;
  const stride = source.length > 64 * 1024 * 1024 ? 32 : 16;
  const count = Math.floor((source.length - width) / stride) + 1;
  const tableSize = 1 << 21;
  const mask = tableSize - 1;
  const head = new Int32Array(tableSize).fill(-1);
  const prev = new Int32Array(count).fill(-1);
  for (let slot = 0; slot < count; slot++) {
    const pos = slot * stride;
    const bucket = hashWindow32(source, pos) & mask;
    prev[slot] = head[bucket];
    head[bucket] = slot;
  }
  return { width, stride, mask, head, prev };
}

function matchLength64(source, sPos, target, tPos, limit) {
  let len = 0;
  while (len + 8 <= limit && source.readBigUInt64LE(sPos + len) === target.readBigUInt64LE(tPos + len)) {
    len += 8;
  }
  while (len < limit && source[sPos + len] === target[tPos + len]) len += 1;
  return len;
}

export function createRbd1DeltaBuffer(source, target) {
  const sourceShaRaw = createHash('sha256').update(source).digest();
  const targetShaRaw = createHash('sha256').update(target).digest();
  const ops = [];
  const index = buildRbd1Index(source);
  let cursor = 0;
  let pending = 0;

  while (cursor < target.length) {
    let bestStart = 0;
    let bestLen = 0;
    if (index && cursor + index.width <= target.length) {
      const bucket = hashWindow32(target, cursor) & index.mask;
      let slot = index.head[bucket];
      let probes = 0;
      while (slot >= 0 && probes < 4) {
        probes += 1;
        const offset = slot * index.stride;
        if (source.compare(target, cursor, cursor + index.width, offset, offset + index.width) === 0) {
          const limit = Math.min(source.length - offset, target.length - cursor);
          const len = index.width + matchLength64(source, offset + index.width, target, cursor + index.width, limit - index.width);
          if (len > bestLen) {
            bestStart = offset;
            bestLen = len;
            if (len >= 65536) break;
          }
        }
        slot = index.prev[slot];
      }
    }
    if (bestLen === 0) { cursor += 1; continue; }
    while (cursor > pending && bestStart > 0 && source[bestStart - 1] === target[cursor - 1]) {
      cursor -= 1; bestStart -= 1; bestLen += 1;
    }
    if (pending < cursor) {
      const addSlice = target.subarray(pending, cursor);
      const last = ops[ops.length - 1];
      if (last && last.type === OP_ADD) { last.chunks.push(addSlice); last.length += addSlice.length; }
      else ops.push({ type: OP_ADD, chunks: [addSlice], length: addSlice.length });
    }
    const last = ops[ops.length - 1];
    if (last && last.type === OP_COPY && last.offset + last.length === bestStart) last.length += bestLen;
    else ops.push({ type: OP_COPY, offset: bestStart, length: bestLen });
    cursor += bestLen;
    pending = cursor;
  }
  if (pending < target.length) {
    const tail = target.subarray(pending);
    const last = ops[ops.length - 1];
    if (last && last.type === OP_ADD) { last.chunks.push(tail); last.length += tail.length; }
    else ops.push({ type: OP_ADD, chunks: [tail], length: tail.length });
  }
  const parts = [RBD1_MAGIC, sourceShaRaw, encodeUleb128(source.length), targetShaRaw, encodeUleb128(target.length)];
  for (const op of ops) {
    if (op.type === OP_COPY) parts.push(Buffer.from([OP_COPY]), encodeUleb128(op.offset), encodeUleb128(op.length));
    else parts.push(Buffer.from([OP_ADD]), encodeUleb128(op.length), ...op.chunks);
  }
  parts.push(Buffer.from([OP_END]));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export async function readAsarHeaderInfo(asarPath) {
  const handle = await open(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    if (bytesRead < 16) throw new Error('Truncated ASAR header');
    const sizeSize = head.readUInt32LE(0);
    const headerSize = head.readUInt32LE(4);
    const stringLen = head.readInt32LE(12);
    if (sizeSize !== 4 || headerSize <= 8 || stringLen <= 0 || stringLen > 64 * 1024 * 1024 || stringLen > headerSize) {
      throw new Error('Invalid ASAR header structure');
    }
    const headerBytes = Buffer.allocUnsafe(stringLen);
    const bodyRead = await handle.read(headerBytes, 0, stringLen, 16);
    if (bodyRead.bytesRead !== stringLen) throw new Error('Truncated ASAR header JSON');
    JSON.parse(headerBytes.toString('utf8'));
    return { headerSha256: sha256Hex(headerBytes), headerSize: headerSize + 8 };
  } finally {
    await handle.close();
  }
}

// --- Self-contained Android RBDELTA1 delta builder ---

function hashSlice32(buf, off, len) {
  let h = 0x811c9dc5;
  const end = off + len;
  for (let i = off; i < end; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function indexZipEntries(buf) {
  const map = new Map();
  const limit = buf.length - 30;
  let i = 0;
  while (i < limit) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const compSize = buf.readUInt32LE(i + 18);
      const fpLen = Math.min(64, 30 + nameLen, buf.length - i);
      if (fpLen >= 30) {
        const key = hashSlice32(buf, i, fpLen);
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        if (arr.length < 4) arr.push(i);
      }
      const next = i + 30 + nameLen + extraLen + compSize;
      if (next > i && next <= buf.length) { i = next; continue; }
    }
    i++;
  }
  return map;
}

function indexBlocks(buf) {
  const map = new Map();
  const limit = buf.length - BLOCK_SIZE;
  for (let off = 0; off <= limit; off += BLOCK_SIZE) {
    const key = hashSlice32(buf, off, 64);
    if (!map.has(key)) map.set(key, off);
  }
  return map;
}

function matchLengthChunked(baseBuf, baseOff, targetBuf, targetOff) {
  const maxLen = Math.min(baseBuf.length - baseOff, targetBuf.length - targetOff, MAX_OP_LEN);
  let matched = 0;
  const CHUNK = 65536;
  while (matched + CHUNK <= maxLen) {
    if (baseBuf.compare(targetBuf, targetOff + matched, targetOff + matched + CHUNK, baseOff + matched, baseOff + matched + CHUNK) === 0) {
      matched += CHUNK;
    } else break;
  }
  while (matched < maxLen && baseBuf[baseOff + matched] === targetBuf[targetOff + matched]) matched++;
  return matched;
}

export function createRbdelta1Buffer(baseBuf, targetBuf) {
  const zipIndex = indexZipEntries(baseBuf);
  const blockIndex = indexBlocks(baseBuf);
  const ops = [];
  let pendingInsertStart = -1;
  let pendingInsertEnd = -1;

  const flushInsert = () => {
    if (pendingInsertStart >= 0 && pendingInsertEnd > pendingInsertStart) {
      ops.push({ type: OP_ADD, start: pendingInsertStart, len: pendingInsertEnd - pendingInsertStart });
    }
    pendingInsertStart = -1;
    pendingInsertEnd = -1;
  };
  const pushCopy = (baseOff, len) => {
    flushInsert();
    const prev = ops[ops.length - 1];
    if (prev && prev.type === OP_COPY && prev.baseOff + prev.len === baseOff && prev.len + len <= MAX_OP_LEN) prev.len += len;
    else ops.push({ type: OP_COPY, baseOff, len });
  };

  let tPos = 0;
  let expectedBasePos = 0;
  const tLen = targetBuf.length;
  while (tPos < tLen) {
    let bestBaseOff = -1;
    let bestLen = 0;
    if (expectedBasePos >= 0 && expectedBasePos + MIN_MATCH <= baseBuf.length && tPos + MIN_MATCH <= tLen) {
      if (baseBuf[expectedBasePos] === targetBuf[tPos] &&
          baseBuf[expectedBasePos + 31] === targetBuf[tPos + 31] &&
          baseBuf[expectedBasePos + 63] === targetBuf[tPos + 63]) {
        const m = matchLengthChunked(baseBuf, expectedBasePos, targetBuf, tPos);
        if (m >= MIN_MATCH) { bestBaseOff = expectedBasePos; bestLen = m; }
      }
    }
    if (bestLen < MIN_MATCH && tPos + 30 <= tLen &&
        targetBuf[tPos] === 0x50 && targetBuf[tPos + 1] === 0x4b &&
        targetBuf[tPos + 2] === 0x03 && targetBuf[tPos + 3] === 0x04) {
      const nameLen = targetBuf.readUInt16LE(tPos + 26);
      const fpLen = Math.min(64, 30 + nameLen, tLen - tPos);
      if (fpLen >= 30) {
        const candidates = zipIndex.get(hashSlice32(targetBuf, tPos, fpLen));
        if (candidates) {
          for (const candOff of candidates) {
            const m = matchLengthChunked(baseBuf, candOff, targetBuf, tPos);
            if (m > bestLen && m >= MIN_MATCH) { bestLen = m; bestBaseOff = candOff; }
          }
        }
      }
    }
    if (bestLen < MIN_MATCH && tPos + 64 <= tLen && (tPos & 63) === 0) {
      const candOff = blockIndex.get(hashSlice32(targetBuf, tPos, 64));
      if (candOff !== undefined) {
        const m = matchLengthChunked(baseBuf, candOff, targetBuf, tPos);
        if (m >= MIN_MATCH) { bestBaseOff = candOff; bestLen = m; }
      }
    }
    if (bestLen >= MIN_MATCH) {
      pushCopy(bestBaseOff, bestLen);
      tPos += bestLen;
      expectedBasePos = bestBaseOff + bestLen;
    } else {
      if (pendingInsertStart < 0) pendingInsertStart = tPos;
      const nextAlign = Math.min(tLen, (tPos & ~63) + 64);
      let step = Math.max(1, nextAlign - tPos);
      const pkIdx = targetBuf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), tPos + 1);
      if (pkIdx > tPos && pkIdx < tPos + step) step = pkIdx - tPos;
      tPos += step;
      pendingInsertEnd = tPos;
    }
  }
  flushInsert();

  let rawLen = 44 + 1;
  for (const op of ops) rawLen += op.type === OP_COPY ? 13 : (5 + op.len);
  const raw = Buffer.allocUnsafe(rawLen);
  let p = 0;
  RBDELTA1_MAGIC.copy(raw, p); p += 8;
  raw.writeBigUInt64BE(BigInt(baseBuf.length), p); p += 8;
  raw.writeBigUInt64BE(BigInt(targetBuf.length), p); p += 8;
  raw.writeUInt32BE(ops.length >>> 0, p); p += 4;
  raw.fill(0, p, p + 16); p += 16;
  for (const op of ops) {
    if (op.type === OP_COPY) {
      raw[p++] = OP_COPY;
      raw.writeBigUInt64BE(BigInt(op.baseOff), p); p += 8;
      raw.writeUInt32BE(op.len >>> 0, p); p += 4;
    } else {
      raw[p++] = OP_ADD;
      raw.writeUInt32BE(op.len >>> 0, p); p += 4;
      targetBuf.copy(raw, p, op.start, op.start + op.len);
      p += op.len;
    }
  }
  raw[p++] = OP_END;
  return gzipSync(raw, { level: 6 });
}

// --- Pure-Node APK metadata & v2/v3 signing certificate inspector ---

function parseAxmlManifestAttrs(buffer) {
  if (buffer.length < 8 || buffer.readUInt16LE(0) !== 0x0003) return {};
  const docHeaderSize = buffer.readUInt16LE(2);
  const docSize = buffer.readUInt32LE(4);
  if (docSize !== buffer.length) return {};
  let at = docHeaderSize;
  let strings = [];
  let resMap = [];
  while (at + 8 <= buffer.length) {
    const chunkType = buffer.readUInt16LE(at);
    const chunkHeaderSize = buffer.readUInt16LE(at + 2);
    const chunkSize = buffer.readUInt32LE(at + 4);
    if (chunkSize < 8 || at + chunkSize > buffer.length) break;
    const chunk = buffer.subarray(at, at + chunkSize);
    if (chunkType === 0x0001) {
      const stringCount = chunk.readUInt32LE(8);
      const flags = chunk.readUInt32LE(16);
      const isUtf8 = (flags & 0x0100) !== 0;
      const stringsStart = chunk.readUInt32LE(20);
      strings = [];
      for (let i = 0; i < stringCount; i++) {
        let pos = stringsStart + chunk.readUInt32LE(chunkHeaderSize + i * 4);
        if (isUtf8) {
          let charLen = chunk[pos++];
          if (charLen & 0x80) pos++;
          let byteLen = chunk[pos++];
          if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | chunk[pos++];
          strings.push(chunk.toString('utf8', pos, pos + byteLen));
        } else {
          const charLen = chunk.readUInt16LE(pos);
          strings.push(chunk.toString('utf16le', pos + 2, pos + 2 + charLen * 2));
        }
      }
    } else if (chunkType === 0x0180) {
      const count = (chunkSize - chunkHeaderSize) / 4;
      resMap = [];
      for (let i = 0; i < count; i++) resMap.push(chunk.readUInt32LE(chunkHeaderSize + i * 4));
    } else if (chunkType === 0x0102) {
      const name = strings[chunk.readUInt32LE(20)];
      if (name === 'manifest') {
        const attrStart = chunk.readUInt16LE(24);
        const attrSize = chunk.readUInt16LE(26);
        const attrCount = chunk.readUInt16LE(28);
        const out = {};
        for (let i = 0; i < attrCount; i++) {
          const off = chunkHeaderSize + attrStart + i * attrSize;
          const aNsIdx = chunk.readUInt32LE(off);
          const aNameIdx = chunk.readUInt32LE(off + 4);
          const aRawIdx = chunk.readUInt32LE(off + 8);
          const aType = chunk[off + 15];
          const aData = chunk.readUInt32LE(off + 16);
          const aName = strings[aNameIdx];
          const resId = aNameIdx < resMap.length ? resMap[aNameIdx] : null;
          const val = aType === 0x03 ? (strings[aData] ?? (aRawIdx !== 0xffffffff ? strings[aRawIdx] : '')) : aData;
          if (aName === 'package' && aNsIdx === 0xffffffff && typeof val === 'string') out.packageName = val;
          else if ((resId === 0x0101021b || aName === 'versionCode') && typeof val === 'number') out.versionCode = val;
          else if ((resId === 0x0101021c || aName === 'versionName') && typeof val === 'string') out.versionName = val;
        }
        return out;
      }
    }
    at += chunkSize;
  }
  return {};
}

function extractApkCertSha256(apk, centralOffset) {
  const BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1');
  if (centralOffset < 32 || !apk.subarray(centralOffset - 16, centralOffset).equals(BLOCK_MAGIC)) return null;
  const size = Number(apk.readBigUInt64LE(centralOffset - 24));
  const blockStart = centralOffset - size - 8;
  if (blockStart < 0 || Number(apk.readBigUInt64LE(blockStart)) !== size) return null;
  let v2 = null, v3 = null;
  for (let at = blockStart + 8; at < centralOffset - 24;) {
    const length = Number(apk.readBigUInt64LE(at));
    if (length < 4 || at + 8 + length > centralOffset - 24) break;
    const id = apk.readUInt32LE(at + 8);
    if (id === 0x7109871a) v2 = apk.subarray(at + 12, at + 8 + length);
    if (id === 0xf05368c0) v3 = apk.subarray(at + 12, at + 8 + length);
    at += 8 + length;
  }
  const block = v3 ?? v2;
  if (!block) return null;
  const readLP = (buf, at) => {
    const len = buf.readUInt32LE(at);
    return [buf.subarray(at + 4, at + 4 + len), at + 4 + len];
  };
  const [signers] = readLP(block, 0);
  const [signer] = readLP(signers, 0);
  const [signedData] = readLP(signer, 0);
  let cursor = 0;
  let certificates;
  [, cursor] = readLP(signedData, cursor);
  [certificates] = readLP(signedData, cursor);
  const [certDer] = readLP(certificates, 0);
  return sha256Hex(certDer).toLowerCase();
}

export function inspectApkBuffer(buffer) {
  try {
    const lowest = Math.max(0, buffer.length - 0xffff - 22);
    let end = -1;
    for (let at = buffer.length - 22; at >= lowest; at--) {
      if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) {
        end = at; break;
      }
    }
    if (end < 0) return {};
    const count = buffer.readUInt16LE(end + 10);
    const centralOffset = buffer.readUInt32LE(end + 16);
    const info = {};
    const certSha256 = extractApkCertSha256(buffer, centralOffset);
    if (certSha256) info.certificateSha256 = certSha256;
    for (let at = centralOffset, i = 0; i < count; i++) {
      if (buffer.readUInt32LE(at) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(at + 10);
      const compSize = buffer.readUInt32LE(at + 20);
      const nameLen = buffer.readUInt16LE(at + 28);
      const extraLen = buffer.readUInt16LE(at + 30);
      const commentLen = buffer.readUInt16LE(at + 32);
      const localOffset = buffer.readUInt32LE(at + 42);
      const name = buffer.toString('utf8', at + 46, at + 46 + nameLen);
      if (name === 'AndroidManifest.xml' && buffer.readUInt32LE(localOffset) === 0x04034b50) {
        const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        const compressed = buffer.subarray(dataStart, dataStart + compSize);
        const raw = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
        if (raw) Object.assign(info, parseAxmlManifestAttrs(raw));
        break;
      }
      at += 46 + nameLen + extraLen + commentLen;
    }
    return info;
  } catch {
    return {};
  }
}

function parseSingleByteRange(header, totalSize) {
  if (!header) return null;
  const trimmed = String(header).trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { invalid: true };
  if (totalSize === 0) return { invalid: true };
  let start, end;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : totalSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) {
      return { invalid: true };
    }
    end = Math.min(end, totalSize - 1);
  }
  return { start, end };
}

async function serveDiskFile(request, response, filePath, knownSha256 = null, expectedBaseDir = null, rootDir = null) {
  check(['GET', 'HEAD'].includes(request.method), 405, '不支持的请求方法');
  let info;
  let safeFilePath = filePath;
  if (expectedBaseDir && rootDir) {
    const resolved = await assertNoSymlinkFile(filePath, expectedBaseDir, rootDir, {
      missingStatus: 404,
      missingMessage: '更新文件不存在',
    });
    info = resolved.info;
    safeFilePath = resolved.realTarget;
  } else {
    info = await lstat(filePath).catch(error => {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ENOTDIR' || error.code === 'ELOOP') throw new HttpError(403, '文件路径无效');
      throw error;
    });
    if (info) check(!info.isSymbolicLink(), 403, '文件路径无效');
    check(info?.isFile(), 404, '更新文件不存在');
  }

  const sha = knownSha256 && SHA256_RE.test(knownSha256) ? knownSha256.toLowerCase() : null;
  const etag = sha ? `"sha256:${sha}"` : `"${info.size}-${Math.trunc(info.mtimeMs)}"`;
  const ext = nodePath.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES.get(ext) ?? 'application/octet-stream';

  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string') {
    const tags = ifNoneMatch.split(',').map(v => v.trim());
    if (tags.includes('*') || tags.includes(etag)) {
      response.writeHead(304, {
        etag,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        ...(sha ? { 'x-content-sha256': sha } : {}),
      });
      return response.end();
    }
  }

  const range = parseSingleByteRange(request.headers.range, info.size);
  if (range?.invalid) {
    response.writeHead(416, {
      'content-range': `bytes */${info.size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    return response.end();
  }

  const headers = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'no-store',
    ...(sha ? { 'x-content-sha256': sha } : {}),
  };

  if (range) {
    const length = range.end - range.start + 1;
    response.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
      'content-length': String(length),
    });
    if (request.method === 'HEAD') return response.end();
    const stream = createReadStream(safeFilePath, { start: range.start, end: range.end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
    return;
  }

  response.writeHead(200, {
    ...headers,
    'content-length': String(info.size),
  });
  if (request.method === 'HEAD') return response.end();
  const stream = createReadStream(safeFilePath);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

export class UpdatesManager {
  constructor(
    dataDir,
    {
      updateDir = undefined,
      maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
      maxDeltaBytes = DEFAULT_MAX_DELTA_BYTES,
    } = {},
  ) {
    const resolvedUpdateDir =
      (typeof updateDir === 'string' && updateDir.trim()) ||
      process.env.ROKBOT_UPDATE_DIR?.trim() ||
      process.env.GROKBOT_UPDATE_DIR?.trim() ||
      nodePath.join(dataDir, 'updates');
    this.root = nodePath.resolve(resolvedUpdateDir);
    this.artifactsDir = nodePath.join(this.root, 'artifacts');
    this.deltasDir = nodePath.join(this.root, 'deltas');
    this.keyFile = nodePath.join(this.root, 'manifest-signing-key.json');
    this.maxUploadBytes = maxUploadBytes;
    this.maxDeltaBytes = maxDeltaBytes;
    this.store = new JsonStore(nodePath.join(this.root, 'updates.json'), {
      version: 1,
      publicIosFeed: false,
      releases: [],
    });
    this.signingKey = null;
  }

  async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.artifactsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.deltasDir, { recursive: true, mode: 0o700 });
    for (const p of CANONICAL_PLATFORMS) {
      await mkdir(nodePath.join(this.artifactsDir, p), { recursive: true, mode: 0o700 });
    }
    await this.store.load();
    this.signingKey = await loadOrCreateManifestSigningKey(this.keyFile);
    return this;
  }

  signingKeySummary() {
    return {
      algorithm: 'ecdsa-p256-sha256',
      publicKeyPem: this.signingKey.publicKeyPem,
      publicKeySpkiBase64: this.signingKey.publicKeySpkiBase64,
      fingerprintSha256: this.signingKey.fingerprintSha256,
    };
  }

  async setSettings(input = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '更新设置无效');
    if (Object.prototype.hasOwnProperty.call(input, 'publicIosFeed')) {
      check(typeof input.publicIosFeed === 'boolean', 400, 'iOS 公开订阅开关无效');
    }
    await this.store.mutate(state => {
      if (Object.prototype.hasOwnProperty.call(input, 'publicIosFeed')) {
        state.publicIosFeed = input.publicIosFeed;
      }
    });
    return { publicIosFeed: this.store.value.publicIosFeed === true };
  }

  iosInstallMethods(release, origin) {
    const token = release.iosToken || 'public';
    const manifestPlistUrl = `${origin}/updates/ios/${encodeURIComponent(token)}/manifest.plist`;
    const altStoreSourceUrl = `${origin}/updates/ios/${encodeURIComponent(token)}/altstore.json`;
    const ipaDownloadUrl = `${origin}/updates/ios/${encodeURIComponent(token)}/${encodeURIComponent(release.filename)}`;
    const itmsServicesUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestPlistUrl)}`;
    return { itmsServicesUrl, manifestPlistUrl, altStoreSourceUrl, ipaDownloadUrl };
  }

  publicRelease(release, origin) {
    const out = { ...release };
    if (release.platform === 'ios' && origin) {
      out.installMethods = this.iosInstallMethods(release, origin);
    }
    return out;
  }

  adminOverview(origin) {
    const releases = this.store.value.releases.map(r => this.publicRelease(r, origin));
    return {
      ok: true,
      updateDir: this.root,
      publicIosFeed: this.store.value.publicIosFeed === true,
      signingKey: this.signingKeySummary(),
      releases,
    };
  }

  async handleUpload(request, url) {
    const rawPlatform = url?.searchParams.get('platform') ?? request.headers['x-update-platform'];
    const rawFilename = url?.searchParams.get('filename') ?? request.headers['x-update-filename'];
    const { platform } = resolvePlatformInfo(rawPlatform);
    const filename = safeFilename(rawFilename, { requireAllowedExt: true });

    const lowerFilename = filename.toLowerCase();
    const isReferenced = () => this.store.value.releases.some(
      r => r.platform === platform && (
        String(r.filename ?? '').toLowerCase() === lowerFilename ||
        String(r.asarFilename ?? '').toLowerCase() === lowerFilename
      ),
    );
    check(!isReferenced(), 409, '该文件名已被已发布版本引用，请使用新文件名或先删除旧版本');

    const declaredLength = request.headers['content-length'];
    if (declaredLength !== undefined) {
      const parsed = Number(declaredLength);
      check(Number.isSafeInteger(parsed) && parsed >= 0, 400, '文件大小头无效');
      check(parsed <= this.maxUploadBytes, 413, '安装包文件过大');
    }

    const platformDir = nodePath.join(this.artifactsDir, platform);
    await assertSafeDirectory(this.root, this.root);
    await assertSafeDirectory(this.artifactsDir, this.root);
    const existingPlatformDir = await lstat(platformDir).catch(error => {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ENOTDIR' || error.code === 'ELOOP') throw new HttpError(403, '文件路径无效');
      throw error;
    });
    if (existingPlatformDir) {
      check(!existingPlatformDir.isSymbolicLink() && existingPlatformDir.isDirectory(), 403, '文件路径无效');
      await assertSafeDirectory(platformDir, this.root);
    } else {
      await mkdir(platformDir, { recursive: true, mode: 0o700 });
      await assertSafeDirectory(platformDir, this.root);
    }
    const destPath = containedPath(platformDir, filename);
    const existingDest = await lstat(destPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ENOTDIR' || error.code === 'ELOOP') throw new HttpError(403, '文件路径无效');
      throw error;
    });
    if (existingDest) check(!existingDest.isSymbolicLink(), 403, '文件路径无效');
    const tmpPath = containedPath(platformDir, `.tmp-${randomBytes(8).toString('hex')}-${filename}`);

    let handle;
    let size = 0;
    const hash = createHash('sha256');
    let aborted = false;
    const onAbort = () => { aborted = true; };
    request.once('aborted', onAbort);

    try {
      handle = await open(tmpPath, 'wx', 0o600);
      for await (const chunk of request) {
        if (aborted) throw new HttpError(400, '上传已中断');
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        check(size <= this.maxUploadBytes, 413, '安装包文件过大');
        hash.update(buf);
        let offset = 0;
        while (offset < buf.length) {
          const { bytesWritten } = await handle.write(buf, offset, buf.length - offset);
          if (bytesWritten <= 0) throw new Error('Short write during upload');
          offset += bytesWritten;
        }
      }
      if (aborted) throw new HttpError(400, '上传已中断');
      check(size > 0, 400, '上传文件不能为空');
      await handle.sync();
      await handle.close();
      handle = null;
      check(!isReferenced(), 409, '该文件名已被已发布版本引用，请使用新文件名或先删除旧版本');
      await rename(tmpPath, destPath);
      await syncRenamedDirectory(platformDir);
    } finally {
      request.off('aborted', onAbort);
      await handle?.close().catch(() => {});
      await rm(tmpPath, { force: true }).catch(() => {});
    }

    const { realTarget } = await assertNoSymlinkFile(destPath, platformDir, this.root);
    const sha256 = hash.digest('hex');
    const ext = nodePath.extname(filename).toLowerCase();
    let asarHeaderSha256;
    if (ext === '.asar') {
      try {
        asarHeaderSha256 = (await readAsarHeaderInfo(realTarget)).headerSha256;
      } catch { /* optional for non-standard test fixtures */ }
    }
    let apkInfo;
    if (ext === '.apk') {
      const parsed = inspectApkBuffer(await readFile(realTarget));
      if (Object.keys(parsed).length > 0) apkInfo = parsed;
    }
    return {
      ok: true,
      platform,
      filename,
      sha256,
      size,
      ...(asarHeaderSha256 ? { asarHeaderSha256 } : {}),
      ...(apkInfo ? { apkInfo } : {}),
    };
  }

  async publish(input = {}, origin = '') {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '发布参数无效');
    const { platform, defaultTarget } = resolvePlatformInfo(input.platform);
    const track = resolveTrack(input.track ?? input.channel);
    const filename = safeFilename(input.filename, { requireAllowedExt: true });
    const platformDir = nodePath.join(this.artifactsDir, platform);
    const artifactPath = containedPath(platformDir, filename);
    const { info: artifactStat, realTarget: realArtifactPath } = await assertNoSymlinkFile(
      artifactPath,
      platformDir,
      this.root,
      { missingStatus: 404, missingMessage: '请先上传该安装包文件' },
    );
    const sha256 = await sha256File(realArtifactPath);
    const size = artifactStat.size;
    const releaseNotes = typeof (input.releaseNotes ?? input.notes) === 'string'
      ? String(input.releaseNotes ?? input.notes).trim().slice(0, 8192)
      : '';
    check(!INVALID_XML_CTRL_RE.test(releaseNotes), 400, '发布参数无效');

    const releaseId = randomUUID();
    const publishedAt = new Date().toISOString();
    let record;

    if (platform === 'android') {
      let apkInfo = {};
      if (nodePath.extname(filename).toLowerCase() === '.apk') {
        apkInfo = inspectApkBuffer(await readFile(realArtifactPath));
      }
      const versionName = String(input.versionName ?? input.version ?? apkInfo.versionName ?? '').trim();
      check(versionName.length > 0 && versionName.length <= 64 && !CONTROL_CHAR_RE.test(versionName), 400, '请填写版本号');
      const rawVc = input.versionCode ?? input.build ?? apkInfo.versionCode;
      const versionCode = Number(rawVc);
      check(Number.isSafeInteger(versionCode) && versionCode > 0, 400, '请填写有效的数字版本代码 (versionCode)');
      const packageName = String(input.packageName ?? apkInfo.packageName ?? 'dev.rokbot.nativeapp').trim();
      check(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName), 400, 'Android 包名格式无效');
      const certificateSha256 = String(input.certificateSha256 ?? apkInfo.certificateSha256 ?? '')
        .trim().replaceAll(':', '').toLowerCase();
      if (certificateSha256) check(SHA256_RE.test(certificateSha256), 400, '签名证书 SHA-256 格式无效');

      record = {
        id: releaseId,
        platform,
        targetPlatform: 'android',
        track,
        filename,
        sha256,
        size,
        packageName,
        versionName,
        version: versionName,
        versionCode,
        certificateSha256,
        releaseNotes,
        publishedAt,
        deltas: [],
      };
    } else if (platform === 'ios') {
      const version = String(input.version ?? input.versionName ?? '').trim();
      check(version.length > 0 && version.length <= 64 && !CONTROL_CHAR_RE.test(version), 400, '请填写版本号');
      const build = String(input.build ?? input.versionCode ?? '1').trim() || '1';
      check(build.length <= 64 && !CONTROL_CHAR_RE.test(build), 400, '发布参数无效');
      const bundleId = String(input.bundleId ?? 'dev.rokbot.local').trim() || 'dev.rokbot.local';
      check(bundleId.length <= 128 && !CONTROL_CHAR_RE.test(bundleId), 400, '发布参数无效');
      record = {
        id: releaseId,
        platform,
        targetPlatform: 'ios',
        track,
        filename,
        sha256,
        size,
        version,
        build,
        bundleId,
        releaseNotes,
        publishedAt,
        iosToken: randomBytes(24).toString('base64url'),
      };
    } else {
      const version = String(input.version ?? '').trim();
      check(version.length > 0 && version.length <= 64 && !CONTROL_CHAR_RE.test(version), 400, '请填写版本号');
      let targetPlatform = defaultTarget;
      if (platform === 'macos') {
        if (input.targetPlatform) {
          check(['darwin-arm64', 'darwin-x64'].includes(input.targetPlatform), 400, 'macOS 架构目标无效');
          targetPlatform = input.targetPlatform;
        } else if (/-x64\.(?:dmg|zip)$/i.test(filename)) {
          targetPlatform = 'darwin-x64';
        }
      }
      let asarFilename = null;
      let asarSha256 = null;
      let asarHeaderSha256 = null;
      let asarSize = null;
      if (input.asarFilename) {
        asarFilename = safeFilename(input.asarFilename, { requireAllowedExt: true });
        const asarPath = containedPath(platformDir, asarFilename);
        const { info: asarStat, realTarget: realAsarPath } = await assertNoSymlinkFile(
          asarPath,
          platformDir,
          this.root,
          { missingStatus: 404, missingMessage: '指定的 ASAR 文件不存在' },
        );
        asarSize = asarStat.size;
        asarSha256 = await sha256File(realAsarPath);
        if (input.asarSha256) check(String(input.asarSha256).toLowerCase() === asarSha256, 400, 'ASAR SHA-256 不匹配');
        const info = await readAsarHeaderInfo(realAsarPath).catch(() => {
          throw new HttpError(400, 'ASAR 文件头无效');
        });
        asarHeaderSha256 = input.asarHeaderSha256
          ? String(input.asarHeaderSha256).toLowerCase()
          : info.headerSha256;
        check(SHA256_RE.test(asarHeaderSha256), 400, 'ASAR Header SHA-256 格式无效');
      } else {
        if (input.asarSha256) {
          asarSha256 = String(input.asarSha256).toLowerCase();
          check(SHA256_RE.test(asarSha256), 400, 'ASAR SHA-256 格式无效');
        }
        if (input.asarHeaderSha256) {
          asarHeaderSha256 = String(input.asarHeaderSha256).toLowerCase();
          check(SHA256_RE.test(asarHeaderSha256), 400, 'ASAR Header SHA-256 格式无效');
        }
      }

      record = {
        id: releaseId,
        platform,
        targetPlatform,
        track,
        filename,
        sha256,
        size,
        version,
        ...(asarFilename ? { asarFilename, asarSize } : {}),
        ...(asarSha256 ? { asarSha256 } : {}),
        ...(asarHeaderSha256 ? { asarHeaderSha256 } : {}),
        releaseNotes,
        publishedAt,
        deltas: [],
        asarDeltas: [],
      };
    }

    const deltaRefs = Array.isArray(input.generateDeltaFrom)
      ? input.generateDeltaFrom
      : (input.generateDeltaFrom ? [input.generateDeltaFrom] : []);

    if (deltaRefs.length > 0 && platform !== 'ios') {
      await this.attachGeneratedDeltas(record, realArtifactPath, deltaRefs);
    }

    await this.store.mutate(state => {
      state.releases.unshift(record);
    });

    return {
      ok: true,
      release: this.publicRelease(record, origin),
      manifest: this.buildManifest(record, origin, record.targetPlatform),
    };
  }

  async attachGeneratedDeltas(record, targetPath, deltaRefs) {
    const platform = record.platform;
    const platformDir = nodePath.join(this.artifactsDir, platform);
    await assertSafeDirectory(this.deltasDir, this.root);
    const { realTarget: realTargetPath } = await assertNoSymlinkFile(targetPath, platformDir, this.root);
    check(record.size <= this.maxDeltaBytes, 400, '目标文件过大，无法生成增量补丁');
    const targetBuf = await readFile(realTargetPath);
    let targetAsarBuf = null;
    if (record.asarFilename) {
      const targetAsarPath = containedPath(platformDir, record.asarFilename);
      const { info: asarStat, realTarget: realTargetAsarPath } = await assertNoSymlinkFile(
        targetAsarPath,
        platformDir,
        this.root,
        { missingStatus: 404, missingMessage: '指定的 ASAR 文件不存在' },
      );
      check(asarStat.size <= this.maxDeltaBytes, 400, 'ASAR 文件过大，无法生成增量补丁');
      targetAsarBuf = await readFile(realTargetAsarPath);
    }

    const seenBaseSha = new Set();
    const seenAsarBaseSha = new Set();

    for (const ref of deltaRefs) {
      const key = String(ref ?? '').trim();
      if (!key) continue;
      const prior = this.store.value.releases.find(
        r => r.platform === platform && (r.id === key || r.filename === key),
      );
      const baseFilename = prior?.filename ?? safeFilename(key);
      const basePath = containedPath(platformDir, baseFilename);
      const { info: baseStat, realTarget: realBasePath } = await assertNoSymlinkFile(
        basePath,
        platformDir,
        this.root,
        { missingStatus: 404, missingMessage: '未找到用于生成增量补丁的基础版本文件' },
      );
      check(baseStat.size <= this.maxDeltaBytes, 400, '基础版本文件过大，无法生成增量补丁');
      const baseBuf = await readFile(realBasePath);
      const baseSha = sha256Hex(baseBuf);

      if (baseSha !== record.sha256 && !seenBaseSha.has(baseSha)) {
        seenBaseSha.add(baseSha);
        const deltaBuf = platform === 'android'
          ? createRbdelta1Buffer(baseBuf, targetBuf)
          : createRbd1DeltaBuffer(baseBuf, targetBuf);
        if (deltaBuf.length < targetBuf.length) {
          const deltaName = `${platform}-${baseSha.slice(0, 12)}-to-${record.sha256.slice(0, 12)}.rbdelta`;
          await writePrivate(containedPath(this.deltasDir, deltaName), deltaBuf);
          const deltaSha = sha256Hex(deltaBuf);
          if (platform === 'android') {
            record.deltas.push({
              fromReleaseId: prior?.id ?? null,
              fromSha256: baseSha,
              fromApkSha256: baseSha,
              baseSha256: baseSha,
              baseSize: baseBuf.length,
              ...(prior?.versionCode ? { fromVersionCode: prior.versionCode } : {}),
              format: 'RBDELTA1',
              filename: deltaName,
              sha256: deltaSha,
              size: deltaBuf.length,
            });
          } else {
            record.deltas.push({
              fromReleaseId: prior?.id ?? null,
              baseSha256: baseSha,
              baseSize: baseBuf.length,
              format: 'RBD1',
              filename: deltaName,
              sha256: deltaSha,
              size: deltaBuf.length,
            });
          }
        }
      }

      if (targetAsarBuf && prior?.asarFilename) {
        const baseAsarPath = containedPath(platformDir, prior.asarFilename);
        const baseAsarResolved = await assertNoSymlinkFile(baseAsarPath, platformDir, this.root).catch(() => null);
        if (baseAsarResolved && baseAsarResolved.info.size <= this.maxDeltaBytes) {
          const baseAsarBuf = await readFile(baseAsarResolved.realTarget);
          const baseAsarSha = sha256Hex(baseAsarBuf);
          if (baseAsarSha !== record.asarSha256 && !seenAsarBaseSha.has(baseAsarSha)) {
            seenAsarBaseSha.add(baseAsarSha);
            const deltaBuf = createRbd1DeltaBuffer(baseAsarBuf, targetAsarBuf);
            if (deltaBuf.length < targetAsarBuf.length) {
              const baseHeader = await readAsarHeaderInfo(baseAsarResolved.realTarget);
              const deltaName = `${record.targetPlatform}-asar-${baseAsarSha.slice(0, 12)}-to-${record.asarSha256.slice(0, 12)}.rbdelta`;
              await writePrivate(containedPath(this.deltasDir, deltaName), deltaBuf);
              record.asarDeltas.push({
                fromReleaseId: prior.id,
                baseSha256: baseAsarSha,
                baseSize: baseAsarBuf.length,
                baseHeaderSha256: baseHeader.headerSha256,
                targetSha256: record.asarSha256,
                targetSize: targetAsarBuf.length,
                targetHeaderSha256: record.asarHeaderSha256,
                format: 'RBD1',
                filename: deltaName,
                sha256: sha256Hex(deltaBuf),
                size: deltaBuf.length,
              });
            }
          }
        }
      }
    }
  }

  async remove(platformRaw, releaseId) {
    const { platform } = resolvePlatformInfo(platformRaw);
    check(typeof releaseId === 'string' && releaseId.trim().length > 0, 400, '发布 ID 无效');

    const platformDir = nodePath.join(this.artifactsDir, platform);
    await assertSafeDirectory(this.root, this.root);
    await assertSafeDirectory(this.artifactsDir, this.root);
    await assertSafeDirectory(platformDir, this.root);
    await assertSafeDirectory(this.deltasDir, this.root);

    let removed = null;
    const filesToDelete = [];

    await this.store.mutate(state => {
      const index = state.releases.findIndex(item => item.platform === platform && item.id === releaseId);
      check(index >= 0, 404, '未找到对应的更新发布记录');
      removed = state.releases[index];
      state.releases.splice(index, 1);

      const usedArtifacts = new Set();
      const usedDeltas = new Set();
      for (const rel of state.releases) {
        usedArtifacts.add(`${rel.platform}/${String(rel.filename ?? '').toLowerCase()}`);
        if (rel.asarFilename) usedArtifacts.add(`${rel.platform}/${String(rel.asarFilename).toLowerCase()}`);
        for (const d of rel.deltas ?? []) if (d.filename) usedDeltas.add(String(d.filename).toLowerCase());
        for (const a of rel.asarDeltas ?? []) if (a.filename) usedDeltas.add(String(a.filename).toLowerCase());
      }

      if (!usedArtifacts.has(`${removed.platform}/${String(removed.filename ?? '').toLowerCase()}`)) {
        filesToDelete.push({
          filePath: containedPath(platformDir, removed.filename),
          parentDir: platformDir,
        });
      }
      if (removed.asarFilename && !usedArtifacts.has(`${removed.platform}/${String(removed.asarFilename).toLowerCase()}`)) {
        filesToDelete.push({
          filePath: containedPath(platformDir, removed.asarFilename),
          parentDir: platformDir,
        });
      }
      for (const d of removed.deltas ?? []) {
        if (d.filename && !usedDeltas.has(String(d.filename).toLowerCase())) {
          filesToDelete.push({
            filePath: containedPath(this.deltasDir, d.filename),
            parentDir: this.deltasDir,
          });
        }
      }
      for (const a of removed.asarDeltas ?? []) {
        if (a.filename && !usedDeltas.has(String(a.filename).toLowerCase())) {
          filesToDelete.push({
            filePath: containedPath(this.deltasDir, a.filename),
            parentDir: this.deltasDir,
          });
        }
      }
    });

    const cleanedFiles = [];
    for (const { filePath, parentDir } of filesToDelete) {
      await assertSafeDirectory(this.root, this.root);
      await assertSafeDirectory(parentDir, this.root);
      try {
        const { realTarget } = await assertNoSymlinkFile(filePath, parentDir, this.root);
        await rm(realTarget, { force: true }).catch(() => {});
        cleanedFiles.push(nodePath.basename(filePath));
      } catch (error) {
        if (error instanceof HttpError && (error.status === 404 || error.status === 403)) {
          continue;
        }
        throw error;
      }
    }
    return { ok: true, deletedId: removed.id, cleanedFiles };
  }

  latestReleaseFor(feedPlatform, track) {
    const { platform } = resolvePlatformInfo(feedPlatform);
    const matching = this.store.value.releases.filter(r => r.platform === platform && r.track === track);
    if (!matching.length) return null;
    if (feedPlatform === 'darwin-arm64' || feedPlatform === 'darwin-x64' || feedPlatform === 'win32-x64') {
      return matching.find(r => r.targetPlatform === feedPlatform) ?? null;
    }
    return matching[0];
  }

  buildManifest(release, origin, requestedFeedPlatform = null) {
    if (release.platform === 'android') {
      const apkUrl = `${origin}/local/updates/files/android/${encodeURIComponent(release.filename)}`;
      const deltas = (release.deltas ?? []).map(d => ({
        fromSha256: d.fromSha256,
        fromApkSha256: d.fromApkSha256 ?? d.fromSha256,
        baseSha256: d.baseSha256,
        baseSize: d.baseSize,
        ...(d.fromVersionCode ? { fromVersionCode: d.fromVersionCode } : {}),
        format: d.format || 'RBDELTA1',
        url: `${origin}/local/updates/files/android/${encodeURIComponent(d.filename)}`,
        sha256: d.sha256,
        size: d.size,
      }));
      const base = {
        schema: ANDROID_UPDATE_SCHEMA,
        track: release.track,
        packageName: release.packageName,
        versionName: release.versionName,
        versionCode: release.versionCode,
        buildId: release.sha256.slice(0, 12),
        sha256: release.sha256,
        size: release.size,
        certificateSha256: release.certificateSha256 || '',
        url: apkUrl,
        fullUrl: apkUrl,
        publishedAt: release.publishedAt,
        notes: release.releaseNotes || '',
        releaseNotes: release.releaseNotes || '',
        deltas,
      };
      return {
        ...base,
        latest: {
          versionName: release.versionName,
          versionCode: release.versionCode,
          packageName: release.packageName,
          certificateSha256: release.certificateSha256 || '',
          apkUrl,
          apkSha256: release.sha256,
          apkSize: release.size,
          releaseNotes: release.releaseNotes || '',
          publishedAt: release.publishedAt,
          deltas,
        },
      };
    }

    if (release.platform === 'ios') {
      const installMethods = this.iosInstallMethods(release, origin);
      return {
        schema: IOS_UPDATE_SCHEMA,
        track: release.track,
        publishedAt: release.publishedAt,
        latest: {
          version: release.version,
          build: release.build,
          bundleId: release.bundleId,
          sha256: release.sha256,
          size: release.size,
          releaseNotes: release.releaseNotes || '',
          publishedAt: release.publishedAt,
          installMethods,
        },
      };
    }

    const platformId = requestedFeedPlatform && ['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(requestedFeedPlatform)
      ? requestedFeedPlatform
      : (release.targetPlatform || (release.platform === 'macos' ? 'darwin-arm64' : 'win32-x64'));
    const fileUrl = `${origin}/local/updates/files/${platformId}/${encodeURIComponent(release.filename)}`;
    const deltas = (release.deltas ?? []).map(d => ({
      baseSha256: d.baseSha256,
      baseSize: d.baseSize,
      sha256: d.sha256,
      size: d.size,
      format: d.format || 'RBD1',
      url: `${origin}/local/updates/files/${platformId}/${encodeURIComponent(d.filename)}`,
    }));
    const asarDeltas = (release.asarDeltas ?? []).map(a => ({
      baseSha256: a.baseSha256,
      baseSize: a.baseSize,
      baseHeaderSha256: a.baseHeaderSha256,
      targetSha256: a.targetSha256,
      targetSize: a.targetSize,
      targetHeaderSha256: a.targetHeaderSha256,
      sha256: a.sha256,
      size: a.size,
      format: a.format || 'RBD1',
      url: `${origin}/local/updates/files/${platformId}/${encodeURIComponent(a.filename)}`,
    }));

    const manifest = {
      schema: DESKTOP_UPDATE_SCHEMA,
      platform: platformId,
      track: release.track,
      version: release.version,
      sha256: release.sha256,
      size: release.size,
      url: fileUrl,
      publishedAt: release.publishedAt,
      releaseNotes: release.releaseNotes || '',
      ...(release.asarSha256 ? { asarSha256: release.asarSha256 } : {}),
      ...(release.asarHeaderSha256 ? { asarHeaderSha256: release.asarHeaderSha256 } : {}),
      signatureAlgorithm: 'ecdsa-p256-sha256',
      publicKeyPem: this.signingKey.publicKeyPem,
      publicKeySpkiBase64: this.signingKey.publicKeySpkiBase64,
      deltas,
      asarDeltas,
    };
    const signature = sign('sha256', Buffer.from(canonicalDesktopManifestPayload(manifest), 'utf8'), this.signingKey.privateKey).toString('base64');
    const deltasSignature = sign('sha256', Buffer.from(canonicalDesktopDeltasPayload(manifest), 'utf8'), this.signingKey.privateKey).toString('base64');
    return {
      ...manifest,
      signature,
      deltasSignature,
      latest: {
        version: manifest.version,
        url: manifest.url,
        sha256: manifest.sha256,
        size: manifest.size,
        ...(manifest.asarSha256 ? { asarSha256: manifest.asarSha256 } : {}),
        ...(manifest.asarHeaderSha256 ? { asarHeaderSha256: manifest.asarHeaderSha256 } : {}),
        releaseNotes: manifest.releaseNotes,
        publishedAt: manifest.publishedAt,
        deltas,
        asarDeltas,
      },
    };
  }

  manifestFor(feedName, origin) {
    const match = /^(android|ios|macos|windows|darwin-arm64|darwin-x64|win32-x64)(?:-(stable|nightly|dogfood))?\.json$/i.exec(feedName);
    check(match, 404, '更新清单不存在');
    const feedPlatform = match[1].toLowerCase();
    const track = (match[2] ?? 'stable').toLowerCase();
    const release = this.latestReleaseFor(feedPlatform, track);
    check(release, 404, '暂无该平台的已发布更新');
    return this.buildManifest(release, origin, feedPlatform);
  }

  async serveFile(request, response, platformRaw, filenameRaw) {
    const { platform } = resolvePlatformInfo(platformRaw);
    const filename = safeFilename(filenameRaw, { requireAllowedExt: true });
    const platformDir = nodePath.join(this.artifactsDir, platform);
    const artifactPath = containedPath(platformDir, filename);
    const ext = nodePath.extname(filename).toLowerCase();

    let filePath = artifactPath;
    let baseDir = platformDir;
    let knownSha = null;
    const artifactStat = await lstat(artifactPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ENOTDIR' || error.code === 'ELOOP') throw new HttpError(403, '文件路径无效');
      throw error;
    });
    if (artifactStat) check(!artifactStat.isSymbolicLink(), 403, '文件路径无效');
    if (artifactStat?.isFile()) {
      for (const rel of this.store.value.releases) {
        if (rel.platform === platform && rel.filename === filename) { knownSha = rel.sha256; break; }
        if (rel.platform === platform && rel.asarFilename === filename) { knownSha = rel.asarSha256; break; }
      }
    } else if (ext === '.rbdelta' || ext === '.gbdelta') {
      filePath = containedPath(this.deltasDir, filename);
      baseDir = this.deltasDir;
      for (const rel of this.store.value.releases) {
        if (rel.platform !== platform) continue;
        const match = (rel.deltas ?? []).find(d => d.filename === filename)
          ?? (rel.asarDeltas ?? []).find(a => a.filename === filename);
        if (match) { knownSha = match.sha256; break; }
      }
    }
    return serveDiskFile(request, response, filePath, knownSha, baseDir, this.root);
  }

  resolveIosReleaseByToken(rawToken, requestedFilename = null) {
    const token = String(rawToken ?? '').trim();
    check(token.length > 0 && token.length <= 128, 403, '更新链接无效或已过期');
    const iosReleases = this.store.value.releases.filter(r => r.platform === 'ios');
    check(iosReleases.length > 0, 404, '暂无 iOS 已发布更新');
    if (this.store.value.publicIosFeed === true && token === 'public') {
      if (requestedFilename !== null) {
        const byFile = iosReleases.find(r => r.filename === requestedFilename);
        check(byFile, 404, '更新文件不存在');
        return byFile;
      }
      return iosReleases[0];
    }
    const matched = iosReleases.find(r => typeof r.iosToken === 'string' && equal(token, r.iosToken));
    check(matched, 403, '更新链接无效或已过期');
    return matched;
  }

  serveIosManifestPlist(request, response, token, origin) {
    check(['GET', 'HEAD'].includes(request.method), 405, '不支持的请求方法');
    const normalizedToken = String(token ?? '').trim();
    const release = this.resolveIosReleaseByToken(normalizedToken);
    const ipaUrl = `${origin}/updates/ios/${encodeURIComponent(normalizedToken)}/${encodeURIComponent(release.filename)}`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${xmlEscape(ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${xmlEscape(release.bundleId || 'dev.rokbot.local')}</string>
        <key>bundle-version</key>
        <string>${xmlEscape(release.version)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>RokBot</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
    const bytes = Buffer.from(plist, 'utf8');
    response.writeHead(200, {
      'content-type': 'application/xml; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    });
    return response.end(request.method === 'HEAD' ? undefined : bytes);
  }

  serveIosAltStoreJson(request, response, token, origin) {
    check(['GET', 'HEAD'].includes(request.method), 405, '不支持的请求方法');
    const normalizedToken = String(token ?? '').trim();
    const release = this.resolveIosReleaseByToken(normalizedToken);
    const iosReleases = normalizedToken === 'public'
      ? this.store.value.releases.filter(r => r.platform === 'ios')
      : [release];
    const bundleId = release.bundleId || 'dev.rokbot.local';
    const body = JSON.stringify({
      name: 'RokBot Self-Hosted',
      identifier: bundleId,
      sourceURL: `${origin}/updates/ios/${encodeURIComponent(normalizedToken)}/altstore.json`,
      apps: [
        {
          name: 'RokBot',
          bundleIdentifier: bundleId,
          developerName: 'RokBot Self-Hosted',
          subtitle: 'Self-hosted AI Assistant',
          localizedDescription: release.releaseNotes || 'RokBot iOS release hosted on your RokBot Host.',
          tintColor: '111827',
          versions: iosReleases.map(item => ({
            version: item.version,
            buildVersion: String(item.build || '1'),
            date: item.publishedAt,
            localizedDescription: item.releaseNotes || '',
            downloadURL: `${origin}/updates/ios/${encodeURIComponent(normalizedToken)}/${encodeURIComponent(item.filename)}`,
            size: item.size,
          })),
        },
      ],
    }, null, 2);
    const bytes = Buffer.from(body, 'utf8');
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    });
    return response.end(request.method === 'HEAD' ? undefined : bytes);
  }

  async serveIosTokenArtifact(request, response, token, filenameRaw) {
    const filename = safeFilename(filenameRaw, { requireAllowedExt: true });
    const release = this.resolveIosReleaseByToken(token, filename);
    check(filename === release.filename, 404, '更新文件不存在');
    const iosDir = nodePath.join(this.artifactsDir, 'ios');
    const filePath = containedPath(iosDir, release.filename);
    return serveDiskFile(request, response, filePath, release.sha256, iosDir, this.root);
  }
}

// Re-export verify helper for unit tests if needed
export function verifySignature(canonical, signatureBase64, publicKeySpkiBase64) {
  const key = createPublicKey({ key: Buffer.from(normalizeEcPublicKey(publicKeySpkiBase64), 'base64'), format: 'der', type: 'spki' });
  return verify('sha256', Buffer.from(canonical, 'utf8'), key, Buffer.from(String(signatureBase64 || ''), 'base64'));
}

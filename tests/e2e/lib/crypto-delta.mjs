import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';

export const RBDELTA_MAGIC = Buffer.from('RBDELTA1', 'ascii');
export const LEGACY_RBDELTA_MAGIC = Buffer.from('GBDELTA1', 'ascii');
export const RBD1_MAGIC = Buffer.from('RBD1', 'ascii');
export const LEGACY_RBD1_MAGIC = Buffer.from('GBD1', 'ascii');

export const DESKTOP_UPDATE_SCHEMA = 'rokbot-desktop-update/v1';
export const LEGACY_DESKTOP_UPDATE_SCHEMA = 'grokbot-desktop-update/v1';
export const DESKTOP_DELTAS_SCHEMA = 'rokbot-desktop-deltas/v1';
export const ANDROID_NATIVE_UPDATE_SCHEMA = 'rokbot-android-native-update/v1';
export const ANDROID_UPDATE_SCHEMA = 'rokbot-android-update/v1';
export const LEGACY_ANDROID_UPDATE_SCHEMA = 'grokbot-android-update/v1';
export const ANDROID_DELTAS_SCHEMA = 'rokbot-android-deltas/v1';
export const IOS_UPDATE_SCHEMA = 'rokbot-ios-update/v1';

export const MAX_DELTA_TARGET_BYTES = 512 * 1024 * 1024;
const MAX_OP_LEN = 0x7fffffff;

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

export function sha256Raw(input) {
  return createHash('sha256').update(input).digest();
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// ECDSA P-256 (prime256v1) key management & canonical manifest signing
// ---------------------------------------------------------------------------

export function generateSigningKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const publicKeySpkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return {
    privateKey,
    publicKey,
    privateKeyPem,
    publicKeyPem,
    publicKeySpkiBase64,
  };
}

export function normalizeEcPublicKey(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('Update public key cannot be empty');
  const key = trimmed.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(trimmed)
    : createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Update public key must be ECDSA P-256 (prime256v1)');
  }
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

function resolvePrivateKey(privateKeyInput) {
  if (typeof privateKeyInput === 'string' || Buffer.isBuffer(privateKeyInput)) {
    return createPrivateKey(privateKeyInput);
  }
  return privateKeyInput;
}

function resolvePublicKey(publicKeyInput) {
  if (publicKeyInput && typeof publicKeyInput === 'object' && publicKeyInput.type === 'public') {
    if (publicKeyInput.asymmetricKeyType !== 'ec' || publicKeyInput.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Update public key must be ECDSA P-256 (prime256v1)');
    }
    return publicKeyInput;
  }
  const spkiB64 = normalizeEcPublicKey(publicKeyInput);
  return createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
}

export function signCanonical(canonicalStr, privateKeyInput) {
  const key = resolvePrivateKey(privateKeyInput);
  return sign('sha256', Buffer.from(canonicalStr, 'utf8'), key).toString('base64');
}

export function verifyCanonical(canonicalStr, signatureBase64, publicKeyInput) {
  if (typeof signatureBase64 !== 'string' || !signatureBase64.trim()) return false;
  const key = resolvePublicKey(publicKeyInput);
  return verify('sha256', Buffer.from(canonicalStr, 'utf8'), key, Buffer.from(signatureBase64, 'base64'));
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function deepCanonicalEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepCanonicalEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined).sort();
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      const k = keysA[i];
      if (k !== keysB[i]) return false;
      if (!deepCanonicalEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function compareHexOptional(topVal, latestVal, fieldName, kind) {
  if (latestVal === undefined) return;
  if (topVal === undefined) {
    if (latestVal !== null) {
      throw new Error(`${kind} manifest dual-shape mismatch on field "${fieldName}"`);
    }
    return;
  }
  if (topVal === null || latestVal === null) {
    if (topVal !== latestVal) {
      throw new Error(`${kind} manifest dual-shape mismatch on field "${fieldName}"`);
    }
    return;
  }
  if (typeof topVal !== 'string' || typeof latestVal !== 'string' || topVal.toLowerCase() !== latestVal.toLowerCase()) {
    throw new Error(`${kind} manifest dual-shape mismatch on field "${fieldName}"`);
  }
}

function validateDesktopDualShapeConsistency(manifest) {
  if (manifest.latest === undefined || manifest.latest === null) return;
  if (!isPlainObject(manifest.latest)) {
    throw new Error('Malformed desktop manifest: latest must be an object');
  }
  const latest = manifest.latest;
  const topLevelKeys = [
    'platform', 'track', 'channel', 'version', 'sha256', 'size', 'url',
    'publishedAt', 'deltas', 'asarDeltas', 'asarSha256', 'asarHeaderSha256',
    'releaseNotes', 'notes',
  ];
  const hasTopLevel = topLevelKeys.some((k) => manifest[k] !== undefined);
  if (!hasTopLevel) return;

  if (latest.schema !== undefined && manifest.schema !== undefined && latest.schema !== manifest.schema) {
    throw new Error('Desktop manifest dual-shape mismatch on field "schema"');
  }
  for (const field of ['platform', 'track', 'version', 'url', 'publishedAt', 'size', 'deltasSignature']) {
    if (latest[field] !== undefined && manifest[field] !== latest[field]) {
      throw new Error(`Desktop manifest dual-shape mismatch on field "${field}"`);
    }
  }
  if (latest.fullUrl !== undefined && latest.fullUrl !== manifest.url) {
    throw new Error('Desktop manifest dual-shape mismatch on field "fullUrl"');
  }
  if (latest.channel !== undefined) {
    const topChannel = manifest.channel !== undefined ? manifest.channel : manifest.track;
    if (topChannel !== latest.channel) {
      throw new Error('Desktop manifest dual-shape mismatch on field "channel"');
    }
  }
  compareHexOptional(manifest.sha256, latest.sha256, 'sha256', 'Desktop');
  compareHexOptional(manifest.asarSha256, latest.asarSha256, 'asarSha256', 'Desktop');
  compareHexOptional(manifest.asarHeaderSha256, latest.asarHeaderSha256, 'asarHeaderSha256', 'Desktop');

  if (latest.releaseNotes !== undefined) {
    const topNotes = manifest.releaseNotes !== undefined ? manifest.releaseNotes : manifest.notes;
    if (topNotes !== undefined) {
      if (topNotes !== latest.releaseNotes) {
        throw new Error('Desktop manifest dual-shape mismatch on field "releaseNotes"');
      }
    } else if (latest.releaseNotes !== null && latest.releaseNotes !== '') {
      throw new Error('Desktop manifest dual-shape mismatch on field "releaseNotes"');
    }
  }
  if (latest.notes !== undefined) {
    const topNotes = manifest.notes !== undefined ? manifest.notes : manifest.releaseNotes;
    if (topNotes !== undefined) {
      if (topNotes !== latest.notes) {
        throw new Error('Desktop manifest dual-shape mismatch on field "notes"');
      }
    } else if (latest.notes !== null && latest.notes !== '') {
      throw new Error('Desktop manifest dual-shape mismatch on field "notes"');
    }
  }

  for (const arrayField of ['deltas', 'asarDeltas']) {
    if (latest[arrayField] !== undefined) {
      if (!Array.isArray(latest[arrayField])) {
        throw new Error(`Desktop manifest dual-shape mismatch: latest.${arrayField} must be an array`);
      }
      const topArr = manifest[arrayField] !== undefined ? manifest[arrayField] : [];
      if (!Array.isArray(topArr) || !deepCanonicalEqual(topArr, latest[arrayField])) {
        throw new Error(`Desktop manifest dual-shape mismatch on field "${arrayField}"`);
      }
    }
  }
}

function validateAndroidDualShapeConsistency(manifest) {
  if (!manifest || typeof manifest !== 'object') return;
  if (manifest.fullUrl !== undefined && manifest.url !== undefined && manifest.fullUrl !== manifest.url) {
    throw new Error('Android manifest dual-shape mismatch on field "fullUrl"');
  }
  if (manifest.latest === undefined || manifest.latest === null) return;
  if (!isPlainObject(manifest.latest)) {
    throw new Error('Malformed Android manifest: latest must be an object');
  }
  const latest = manifest.latest;
  if (latest.apkUrl !== undefined && latest.url !== undefined && latest.apkUrl !== latest.url) {
    throw new Error('Android manifest dual-shape mismatch on field "url"');
  }
  if (latest.fullUrl !== undefined && (latest.apkUrl ?? latest.url) !== undefined && latest.fullUrl !== (latest.apkUrl ?? latest.url)) {
    throw new Error('Android manifest dual-shape mismatch on field "fullUrl"');
  }
  const topLevelKeys = [
    'track', 'channel', 'packageName', 'versionName', 'versionCode', 'sha256',
    'size', 'certificateSha256', 'url', 'fullUrl', 'publishedAt', 'deltas',
    'releaseNotes', 'notes',
  ];
  const hasTopLevel = topLevelKeys.some((k) => manifest[k] !== undefined);
  if (!hasTopLevel) return;

  if (latest.schema !== undefined && manifest.schema !== undefined && latest.schema !== manifest.schema) {
    throw new Error('Android manifest dual-shape mismatch on field "schema"');
  }
  for (const field of ['track', 'packageName', 'versionName', 'versionCode', 'publishedAt', 'deltasSignature']) {
    if (latest[field] !== undefined && manifest[field] !== latest[field]) {
      throw new Error(`Android manifest dual-shape mismatch on field "${field}"`);
    }
  }
  if (latest.channel !== undefined) {
    const topChannel = manifest.channel !== undefined ? manifest.channel : manifest.track;
    if (topChannel !== latest.channel) {
      throw new Error('Android manifest dual-shape mismatch on field "channel"');
    }
  }
  const topUrl = manifest.url ?? manifest.fullUrl;
  if (manifest.fullUrl !== undefined && (manifest.url !== undefined || latest.apkUrl !== undefined || latest.url !== undefined)) {
    const expectedUrl = manifest.url ?? latest.apkUrl ?? latest.url;
    if (manifest.fullUrl !== expectedUrl) {
      throw new Error('Android manifest dual-shape mismatch on field "fullUrl"');
    }
  }
  if (latest.url !== undefined && latest.url !== topUrl) {
    throw new Error('Android manifest dual-shape mismatch on field "url"');
  }
  if (latest.apkUrl !== undefined && latest.apkUrl !== topUrl) {
    throw new Error('Android manifest dual-shape mismatch on field "apkUrl"');
  }
  if (latest.fullUrl !== undefined && latest.fullUrl !== (manifest.fullUrl ?? manifest.url)) {
    throw new Error('Android manifest dual-shape mismatch on field "fullUrl"');
  }
  compareHexOptional(manifest.sha256, latest.sha256, 'sha256', 'Android');
  compareHexOptional(manifest.sha256, latest.apkSha256, 'apkSha256', 'Android');
  compareHexOptional(manifest.certificateSha256, latest.certificateSha256, 'certificateSha256', 'Android');

  if (latest.size !== undefined && manifest.size !== latest.size) {
    throw new Error('Android manifest dual-shape mismatch on field "size"');
  }
  if (latest.apkSize !== undefined && manifest.size !== latest.apkSize) {
    throw new Error('Android manifest dual-shape mismatch on field "apkSize"');
  }
  if (latest.releaseNotes !== undefined) {
    const topNotes = manifest.releaseNotes !== undefined ? manifest.releaseNotes : manifest.notes;
    if (topNotes !== undefined) {
      if (topNotes !== latest.releaseNotes) {
        throw new Error('Android manifest dual-shape mismatch on field "releaseNotes"');
      }
    } else if (latest.releaseNotes !== null && latest.releaseNotes !== '') {
      throw new Error('Android manifest dual-shape mismatch on field "releaseNotes"');
    }
  }
  if (latest.notes !== undefined) {
    const topNotes = manifest.notes !== undefined ? manifest.notes : manifest.releaseNotes;
    if (topNotes !== undefined) {
      if (topNotes !== latest.notes) {
        throw new Error('Android manifest dual-shape mismatch on field "notes"');
      }
    } else if (latest.notes !== null && latest.notes !== '') {
      throw new Error('Android manifest dual-shape mismatch on field "notes"');
    }
  }
  if (latest.deltas !== undefined) {
    if (!Array.isArray(latest.deltas)) {
      throw new Error('Android manifest dual-shape mismatch: latest.deltas must be an array');
    }
    const topArr = manifest.deltas !== undefined ? manifest.deltas : [];
    if (!Array.isArray(topArr) || !deepCanonicalEqual(topArr, latest.deltas)) {
      throw new Error('Android manifest dual-shape mismatch on field "deltas"');
    }
  }
}

export function normalizeDesktopManifestRecord(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Malformed desktop manifest');
  }
  validateDesktopDualShapeConsistency(manifest);
  const latest = manifest.latest && typeof manifest.latest === 'object' ? manifest.latest : null;
  return {
    schema: manifest.schema ?? DESKTOP_UPDATE_SCHEMA,
    platform: manifest.platform ?? latest?.platform ?? '',
    track: manifest.track ?? latest?.track ?? 'stable',
    version: manifest.version ?? latest?.version ?? '',
    sha256: manifest.sha256 ?? latest?.sha256 ?? '',
    size: manifest.size ?? latest?.size ?? '',
    url: manifest.url ?? latest?.url ?? '',
    publishedAt: manifest.publishedAt ?? latest?.publishedAt ?? '',
    deltas: manifest.deltas ?? latest?.deltas ?? [],
    asarDeltas: manifest.asarDeltas ?? latest?.asarDeltas ?? [],
    signature: manifest.signature,
    deltasSignature: manifest.deltasSignature ?? latest?.deltasSignature,
  };
}

export function canonicalDesktopPayload(record) {
  const normalized = normalizeDesktopManifestRecord(record);
  return [
    normalized.schema,
    normalized.platform,
    normalized.track,
    normalized.version,
    String(normalized.sha256).toLowerCase(),
    String(normalized.size),
    normalized.url,
    normalized.publishedAt,
  ].join('\n');
}

export function canonicalDesktopDeltasPayload(manifest) {
  const normalized = normalizeDesktopManifestRecord(manifest);
  const deltas = Array.isArray(normalized.deltas) ? normalized.deltas : [];
  const asarDeltas = Array.isArray(normalized.asarDeltas) ? normalized.asarDeltas : [];
  const header = [
    DESKTOP_DELTAS_SCHEMA,
    normalized.platform,
    normalized.track,
    normalized.version,
    String(normalized.sha256).toLowerCase(),
    String(normalized.size),
  ];
  const installerLines = deltas.map((d) => [
    'installer',
    String(d.baseSha256).toLowerCase(),
    String(d.baseSize),
    String(d.sha256).toLowerCase(),
    String(d.size),
    d.url,
  ].join('|'));
  const asarLines = asarDeltas.map((a) => [
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
  if (!record || typeof record !== 'object') {
    throw new Error('Malformed Android manifest');
  }
  validateAndroidDualShapeConsistency(record);
  const latest = isPlainObject(record.latest) ? record.latest : null;
  return [
    record.schema,
    record.track ?? latest?.track,
    record.packageName ?? latest?.packageName,
    record.versionName ?? latest?.versionName,
    String(record.versionCode ?? latest?.versionCode),
    String(record.sha256 ?? latest?.apkSha256 ?? latest?.sha256).toLowerCase(),
    String(record.size ?? latest?.apkSize ?? latest?.size),
    String(record.certificateSha256 ?? latest?.certificateSha256).toLowerCase(),
    record.url ?? record.fullUrl ?? latest?.apkUrl ?? latest?.url,
    record.publishedAt ?? latest?.publishedAt,
  ].join('\n');
}

export function canonicalAndroidDeltasPayload(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Malformed Android manifest');
  }
  validateAndroidDualShapeConsistency(manifest);
  const latest = isPlainObject(manifest.latest) ? manifest.latest : null;
  const rawDeltas = manifest.deltas ?? latest?.deltas;
  const deltas = Array.isArray(rawDeltas) ? rawDeltas : [];
  const header = [
    ANDROID_DELTAS_SCHEMA,
    manifest.track ?? latest?.track,
    manifest.packageName ?? latest?.packageName,
    manifest.versionName ?? latest?.versionName,
    String(manifest.versionCode ?? latest?.versionCode),
    String(manifest.sha256 ?? latest?.apkSha256 ?? latest?.sha256).toLowerCase(),
    String(manifest.size ?? latest?.apkSize ?? latest?.size),
    String(manifest.certificateSha256 ?? latest?.certificateSha256).toLowerCase(),
  ];
  const lines = deltas.map((d) => [
    String(d.baseSha256).toLowerCase(),
    String(d.baseSize),
    String(d.sha256).toLowerCase(),
    String(d.size),
    d.url,
  ].join('|'));
  return [...header, ...lines].join('\n');
}

export function signDesktopManifest(entry, privateKeyInput) {
  const record = { ...entry, schema: entry?.schema ?? DESKTOP_UPDATE_SCHEMA };
  const signature = signCanonical(canonicalDesktopPayload(record), privateKeyInput);
  return { ...record, signature };
}

export function verifyDesktopManifest(manifest, publicKeyInput) {
  const normalized = normalizeDesktopManifestRecord(manifest);
  if (![DESKTOP_UPDATE_SCHEMA, LEGACY_DESKTOP_UPDATE_SCHEMA].includes(normalized.schema)) {
    throw new Error(`Invalid desktop update manifest schema: ${normalized.schema}`);
  }
  const ok = verifyCanonical(canonicalDesktopPayload(normalized), normalized.signature, publicKeyInput);
  if (!ok) {
    throw new Error('Invalid desktop manifest signature');
  }
  return manifest;
}

export function signDesktopDeltas(manifest, privateKeyInput) {
  const deltasSignature = signCanonical(canonicalDesktopDeltasPayload(manifest), privateKeyInput);
  return { ...manifest, deltasSignature };
}

export function verifyDesktopDeltas(manifest, publicKeyInput) {
  verifyDesktopManifest(manifest, publicKeyInput);
  const normalized = normalizeDesktopManifestRecord(manifest);
  if (typeof normalized.deltasSignature !== 'string' || !normalized.deltasSignature) {
    throw new Error('Missing desktop delta signature');
  }
  const ok = verifyCanonical(canonicalDesktopDeltasPayload(normalized), normalized.deltasSignature, publicKeyInput);
  if (!ok) {
    throw new Error('Invalid desktop delta signature');
  }
  return true;
}

export function signAndroidManifest(entry, privateKeyInput) {
  const record = { ...entry, schema: entry?.schema ?? ANDROID_UPDATE_SCHEMA };
  const signature = signCanonical(canonicalAndroidManifestPayload(record), privateKeyInput);
  return { ...record, signature };
}

export function verifyAndroidManifest(manifest, publicKeyInput) {
  if (!manifest || ![ANDROID_UPDATE_SCHEMA, LEGACY_ANDROID_UPDATE_SCHEMA, ANDROID_NATIVE_UPDATE_SCHEMA].includes(manifest.schema)) {
    throw new Error(`Invalid Android update manifest schema: ${manifest?.schema}`);
  }
  const ok = verifyCanonical(canonicalAndroidManifestPayload(manifest), manifest.signature, publicKeyInput);
  if (!ok) {
    throw new Error('Invalid Android manifest signature');
  }
  return manifest;
}

export function signAndroidDeltas(manifest, privateKeyInput) {
  const deltasSignature = signCanonical(canonicalAndroidDeltasPayload(manifest), privateKeyInput);
  return { ...manifest, deltasSignature };
}

export function verifyAndroidDeltas(manifest, publicKeyInput) {
  if (typeof manifest?.deltasSignature !== 'string' || !manifest.deltasSignature) {
    throw new Error('Missing Android delta signature');
  }
  const ok = verifyCanonical(canonicalAndroidDeltasPayload(manifest), manifest.deltasSignature, publicKeyInput);
  if (!ok) {
    throw new Error('Invalid Android delta signature');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Synthetic ASAR & ZIP builders / readers
// ---------------------------------------------------------------------------

export function buildSyntheticAsar(headerObj = { files: {} }, payloadBufOrText = Buffer.alloc(0)) {
  const jsonBytes = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const stringLen = jsonBytes.length;
  const paddedStringLen = (stringLen + 3) & ~3;
  const pickleSize = 4 + paddedStringLen;
  const headerSize = 4 + pickleSize;
  const pickle = Buffer.alloc(16 + paddedStringLen, 0);
  pickle.writeUInt32LE(4, 0);
  pickle.writeUInt32LE(headerSize, 4);
  pickle.writeUInt32LE(pickleSize, 8);
  pickle.writeInt32LE(stringLen, 12);
  jsonBytes.copy(pickle, 16);

  const payload = Buffer.isBuffer(payloadBufOrText)
    ? payloadBufOrText
    : Buffer.from(String(payloadBufOrText), 'utf8');
  const bytes = Buffer.concat([pickle, payload]);
  return {
    bytes,
    headerSha256: sha256Hex(jsonBytes),
    headerSize: headerSize + 8,
    sha256: sha256Hex(bytes),
  };
}

export async function readAsarHeaderInfo(input) {
  const buf = Buffer.isBuffer(input) ? input : await readFile(String(input));
  if (buf.length < 16) throw new Error('Truncated ASAR header');
  const sizeSize = buf.readUInt32LE(0);
  const headerSize = buf.readUInt32LE(4);
  const stringLen = buf.readInt32LE(12);
  if (sizeSize !== 4 || headerSize <= 8 || stringLen <= 0 || stringLen > 64 * 1024 * 1024 || stringLen > headerSize) {
    throw new Error('Invalid ASAR header structure');
  }
  if (16 + stringLen > buf.length) {
    throw new Error('Truncated ASAR header JSON');
  }
  const headerBytes = buf.subarray(16, 16 + stringLen);
  const headerJson = JSON.parse(headerBytes.toString('utf8'));
  return {
    headerSha256: sha256Hex(headerBytes),
    headerSize: headerSize + 8,
    headerJson,
    sha256: sha256Hex(buf),
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildSyntheticZip(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name), 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const extraBuf = Buffer.isBuffer(entry.extra) ? entry.extra : Buffer.alloc(0);
    const sum = crc32(dataBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method: store
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5421, 12); // mod date
    localHeader.writeUInt32LE(sum, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(extraBuf.length, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method: store
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x5421, 14); // mod date
    centralHeader.writeUInt32LE(sum, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    localParts.push(localHeader, nameBuf, extraBuf, dataBuf);
    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + extraBuf.length + dataBuf.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ---------------------------------------------------------------------------
// RBDELTA1 / GBDELTA1 codec (Android APK ZIP-entry delta)
// 100% byte-compatible with android/release/delta-update.mjs & DeltaPatcher.java
// ---------------------------------------------------------------------------

const RB_OP_EOF = 0x00;
const RB_OP_COPY = 0x01;
const RB_OP_INSERT = 0x02;
const RB_BLOCK_SIZE = 4096;
const RB_MIN_MATCH = 64;

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
        if (!arr) {
          arr = [];
          map.set(key, arr);
        }
        if (arr.length < 4) arr.push(i);
      }
      const next = i + 30 + nameLen + extraLen + compSize;
      if (next > i && next <= buf.length) {
        i = next;
        continue;
      }
    }
    i++;
  }
  return map;
}

function indexBlocks(buf) {
  const map = new Map();
  const limit = buf.length - RB_BLOCK_SIZE;
  for (let off = 0; off <= limit; off += RB_BLOCK_SIZE) {
    const key = hashSlice32(buf, off, 64);
    if (!map.has(key)) {
      map.set(key, off);
    }
  }
  return map;
}

function rbMatchLength(baseBuf, baseOff, targetBuf, targetOff) {
  const maxLen = Math.min(baseBuf.length - baseOff, targetBuf.length - targetOff, MAX_OP_LEN);
  let matched = 0;
  const CHUNK = 65536;
  while (matched + CHUNK <= maxLen) {
    if (baseBuf.compare(targetBuf, targetOff + matched, targetOff + matched + CHUNK, baseOff + matched, baseOff + matched + CHUNK) === 0) {
      matched += CHUNK;
    } else {
      break;
    }
  }
  while (matched < maxLen && baseBuf[baseOff + matched] === targetBuf[targetOff + matched]) {
    matched++;
  }
  return matched;
}

export function generateRbDelta(baseBuf, targetBuf, { magic = RBDELTA_MAGIC } = {}) {
  if (!Buffer.isBuffer(baseBuf) || !Buffer.isBuffer(targetBuf)) {
    throw new TypeError('baseBuf and targetBuf must be Buffers');
  }
  const magicBuf = typeof magic === 'string' ? Buffer.from(magic, 'ascii') : magic;
  if (!Buffer.isBuffer(magicBuf) || magicBuf.length !== 8) {
    throw new Error('RBDELTA magic must be 8 ASCII bytes');
  }

  const zipIndex = indexZipEntries(baseBuf);
  const blockIndex = indexBlocks(baseBuf);

  const ops = [];
  let pendingInsertStart = -1;
  let pendingInsertEnd = -1;

  const flushInsert = () => {
    if (pendingInsertStart >= 0 && pendingInsertEnd > pendingInsertStart) {
      ops.push({ type: RB_OP_INSERT, start: pendingInsertStart, len: pendingInsertEnd - pendingInsertStart });
    }
    pendingInsertStart = -1;
    pendingInsertEnd = -1;
  };

  const pushCopy = (baseOff, len) => {
    flushInsert();
    const prev = ops[ops.length - 1];
    if (prev && prev.type === RB_OP_COPY && prev.baseOff + prev.len === baseOff && prev.len + len <= MAX_OP_LEN) {
      prev.len += len;
    } else {
      ops.push({ type: RB_OP_COPY, baseOff, len });
    }
  };

  let tPos = 0;
  let expectedBasePos = 0;
  const tLen = targetBuf.length;

  while (tPos < tLen) {
    let bestBaseOff = -1;
    let bestLen = 0;

    if (expectedBasePos >= 0 && expectedBasePos + RB_MIN_MATCH <= baseBuf.length && tPos + RB_MIN_MATCH <= tLen) {
      if (
        baseBuf[expectedBasePos] === targetBuf[tPos] &&
        baseBuf[expectedBasePos + 31] === targetBuf[tPos + 31] &&
        baseBuf[expectedBasePos + 63] === targetBuf[tPos + 63]
      ) {
        const m = rbMatchLength(baseBuf, expectedBasePos, targetBuf, tPos);
        if (m >= RB_MIN_MATCH) {
          bestBaseOff = expectedBasePos;
          bestLen = m;
        }
      }
    }

    if (
      bestLen < RB_MIN_MATCH &&
      tPos + 30 <= tLen &&
      targetBuf[tPos] === 0x50 &&
      targetBuf[tPos + 1] === 0x4b &&
      targetBuf[tPos + 2] === 0x03 &&
      targetBuf[tPos + 3] === 0x04
    ) {
      const nameLen = targetBuf.readUInt16LE(tPos + 26);
      const fpLen = Math.min(64, 30 + nameLen, tLen - tPos);
      if (fpLen >= 30) {
        const candidates = zipIndex.get(hashSlice32(targetBuf, tPos, fpLen));
        if (candidates) {
          for (const candOff of candidates) {
            const m = rbMatchLength(baseBuf, candOff, targetBuf, tPos);
            if (m > bestLen && m >= RB_MIN_MATCH) {
              bestLen = m;
              bestBaseOff = candOff;
            }
          }
        }
      }
    }

    if (bestLen < RB_MIN_MATCH && tPos + 64 <= tLen && (tPos & 63) === 0) {
      const candOff = blockIndex.get(hashSlice32(targetBuf, tPos, 64));
      if (candOff !== undefined) {
        const m = rbMatchLength(baseBuf, candOff, targetBuf, tPos);
        if (m >= RB_MIN_MATCH) {
          bestBaseOff = candOff;
          bestLen = m;
        }
      }
    }

    if (bestLen >= RB_MIN_MATCH) {
      pushCopy(bestBaseOff, bestLen);
      tPos += bestLen;
      expectedBasePos = bestBaseOff + bestLen;
    } else {
      if (pendingInsertStart < 0) pendingInsertStart = tPos;
      const nextAlign = Math.min(tLen, (tPos & ~63) + 64);
      let step = Math.max(1, nextAlign - tPos);
      const pkIdx = targetBuf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), tPos + 1);
      if (pkIdx > tPos && pkIdx < tPos + step) {
        step = pkIdx - tPos;
      }
      tPos += step;
      pendingInsertEnd = tPos;
    }
  }
  flushInsert();

  let rawLen = 44 + 1;
  for (const op of ops) {
    if (op.type === RB_OP_COPY) rawLen += 1 + 8 + 4;
    else rawLen += 1 + 4 + op.len;
  }

  const raw = Buffer.allocUnsafe(rawLen);
  let p = 0;
  magicBuf.copy(raw, p); p += 8;
  raw.writeBigUInt64BE(BigInt(baseBuf.length), p); p += 8;
  raw.writeBigUInt64BE(BigInt(targetBuf.length), p); p += 8;
  raw.writeUInt32BE(ops.length >>> 0, p); p += 4;
  raw.fill(0, p, p + 16); p += 16;

  for (const op of ops) {
    if (op.type === RB_OP_COPY) {
      raw[p++] = RB_OP_COPY;
      raw.writeBigUInt64BE(BigInt(op.baseOff), p); p += 8;
      raw.writeUInt32BE(op.len >>> 0, p); p += 4;
    } else {
      raw[p++] = RB_OP_INSERT;
      raw.writeUInt32BE(op.len >>> 0, p); p += 4;
      targetBuf.copy(raw, p, op.start, op.start + op.len);
      p += op.len;
    }
  }
  raw[p++] = RB_OP_EOF;

  return gzipSync(raw, { level: 6 });
}

export function inspectRbDeltaHeader(deltaGzipBuf) {
  if (!Buffer.isBuffer(deltaGzipBuf)) throw new TypeError('deltaGzipBuf must be a Buffer');
  const raw = gunzipSync(deltaGzipBuf);
  if (raw.length < 45) throw new Error('RBDELTA stream truncated');
  const magicBuf = raw.subarray(0, 8);
  if (!magicBuf.equals(RBDELTA_MAGIC) && !magicBuf.equals(LEGACY_RBDELTA_MAGIC)) {
    throw new Error(`Invalid RBDELTA magic header: ${magicBuf.toString('ascii')}`);
  }
  const baseSize = Number(raw.readBigUInt64BE(8));
  const targetSize = Number(raw.readBigUInt64BE(16));
  const opCount = raw.readUInt32BE(24);
  return {
    magic: magicBuf.toString('ascii'),
    baseSize,
    targetSize,
    opCount,
    rawLength: raw.length,
  };
}

export function applyRbDelta(baseBuf, deltaGzipBuf) {
  if (!Buffer.isBuffer(baseBuf) || !Buffer.isBuffer(deltaGzipBuf)) {
    throw new TypeError('baseBuf and deltaGzipBuf must be Buffers');
  }
  const raw = gunzipSync(deltaGzipBuf);
  if (raw.length < 45) {
    throw new Error('Delta stream truncated');
  }
  const magic = raw.subarray(0, 8);
  if (!magic.equals(RBDELTA_MAGIC) && !magic.equals(LEGACY_RBDELTA_MAGIC)) {
    throw new Error('Invalid delta magic header');
  }
  const baseSize = Number(raw.readBigUInt64BE(8));
  const targetSize = Number(raw.readBigUInt64BE(16));
  if (baseSize !== baseBuf.length) {
    throw new Error(`Base size mismatch: expected ${baseSize}, got ${baseBuf.length}`);
  }
  if (targetSize < 0 || targetSize > MAX_DELTA_TARGET_BYTES) {
    throw new Error(`Invalid target size: ${targetSize}`);
  }

  const out = Buffer.allocUnsafe(targetSize);
  let inPos = 44;
  let outPos = 0;
  let sawEof = false;

  while (inPos < raw.length) {
    const op = raw[inPos++];
    if (op === RB_OP_EOF) {
      sawEof = true;
      break;
    }
    if (op === RB_OP_COPY) {
      if (inPos + 12 > raw.length) throw new Error('Truncated OP_COPY');
      const baseOff = Number(raw.readBigUInt64BE(inPos)); inPos += 8;
      const len = raw.readUInt32BE(inPos); inPos += 4;
      if (baseOff < 0 || baseOff + len > baseBuf.length) {
        throw new Error(`OP_COPY out of base bounds: off=${baseOff} len=${len}`);
      }
      if (outPos + len > targetSize) {
        throw new Error(`OP_COPY exceeds target size: outPos=${outPos} len=${len}`);
      }
      baseBuf.copy(out, outPos, baseOff, baseOff + len);
      outPos += len;
    } else if (op === RB_OP_INSERT) {
      if (inPos + 4 > raw.length) throw new Error('Truncated OP_INSERT header');
      const len = raw.readUInt32BE(inPos); inPos += 4;
      if (inPos + len > raw.length) throw new Error('Truncated OP_INSERT payload');
      if (outPos + len > targetSize) {
        throw new Error(`OP_INSERT exceeds target size: outPos=${outPos} len=${len}`);
      }
      raw.copy(out, outPos, inPos, inPos + len);
      inPos += len;
      outPos += len;
    } else {
      throw new Error(`Unknown delta opcode: 0x${op.toString(16)}`);
    }
  }

  if (!sawEof) throw new Error('Delta stream missing OP_EOF');
  if (outPos !== targetSize) {
    throw new Error(`Reconstructed size mismatch: expected ${targetSize}, got ${outPos}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// RBD1 / GBD1 codec (Desktop ASAR / installer binary delta)
// 100% byte-compatible with mac/clients/shared/delta.mjs
// ---------------------------------------------------------------------------

const RBD1_OP_END = 0x00;
const RBD1_OP_COPY = 0x01;
const RBD1_OP_ADD = 0x02;

export function encodeUleb128(value) {
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

export function decodeUleb128(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('ULEB128 exceeds safe integer range');
      }
      return { value: Number(result), nextOffset: pos };
    }
    shift += 7n;
    if (shift > 56n) throw new Error('ULEB128 overflow');
  }
  return null;
}

function hashWindow32(buf, pos) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 32; i += 4) {
    const word = buf[pos + i] | (buf[pos + i + 1] << 8) | (buf[pos + i + 2] << 16) | (buf[pos + i + 3] << 24);
    h = Math.imul(h ^ word, 0x01000193) >>> 0;
  }
  return h;
}

function buildSourceIndex(source) {
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

function rbd1MatchLength(source, sPos, target, tPos, limit) {
  let len = 0;
  while (len + 8 <= limit && source.readBigUInt64LE(sPos + len) === target.readBigUInt64LE(tPos + len)) {
    len += 8;
  }
  while (len < limit && source[sPos + len] === target[tPos + len]) {
    len += 1;
  }
  return len;
}

export function generateRbd1Delta(source, target, { magic = RBD1_MAGIC } = {}) {
  if (!Buffer.isBuffer(source) || !Buffer.isBuffer(target)) {
    throw new TypeError('source and target must be Buffers');
  }
  const magicBuf = typeof magic === 'string' ? Buffer.from(magic, 'ascii') : magic;
  if (!Buffer.isBuffer(magicBuf) || magicBuf.length !== 4) {
    throw new Error('RBD1 magic must be 4 ASCII bytes');
  }

  const sourceShaRaw = sha256Raw(source);
  const targetShaRaw = sha256Raw(target);

  const ops = [];
  const index = buildSourceIndex(source);
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
          const len = index.width + rbd1MatchLength(source, offset + index.width, target, cursor + index.width, limit - index.width);
          if (len > bestLen) {
            bestStart = offset;
            bestLen = len;
            if (len >= 65536) break;
          }
        }
        slot = index.prev[slot];
      }
    }

    if (bestLen === 0) {
      cursor += 1;
      continue;
    }

    while (cursor > pending && bestStart > 0 && source[bestStart - 1] === target[cursor - 1]) {
      cursor -= 1;
      bestStart -= 1;
      bestLen += 1;
    }

    if (pending < cursor) {
      const addSlice = target.subarray(pending, cursor);
      const last = ops[ops.length - 1];
      if (last && last.type === RBD1_OP_ADD) {
        last.chunks.push(addSlice);
        last.length += addSlice.length;
      } else {
        ops.push({ type: RBD1_OP_ADD, chunks: [addSlice], length: addSlice.length });
      }
    }

    const last = ops[ops.length - 1];
    if (last && last.type === RBD1_OP_COPY && last.offset + last.length === bestStart) {
      last.length += bestLen;
    } else {
      ops.push({ type: RBD1_OP_COPY, offset: bestStart, length: bestLen });
    }
    cursor += bestLen;
    pending = cursor;
  }

  if (pending < target.length) {
    const tail = target.subarray(pending);
    const last = ops[ops.length - 1];
    if (last && last.type === RBD1_OP_ADD) {
      last.chunks.push(tail);
      last.length += tail.length;
    } else {
      ops.push({ type: RBD1_OP_ADD, chunks: [tail], length: tail.length });
    }
  }

  const parts = [
    magicBuf,
    sourceShaRaw,
    encodeUleb128(source.length),
    targetShaRaw,
    encodeUleb128(target.length),
  ];
  for (const op of ops) {
    if (op.type === RBD1_OP_COPY) {
      parts.push(Buffer.from([RBD1_OP_COPY]), encodeUleb128(op.offset), encodeUleb128(op.length));
    } else {
      parts.push(Buffer.from([RBD1_OP_ADD]), encodeUleb128(op.length), ...op.chunks);
    }
  }
  parts.push(Buffer.from([RBD1_OP_END]));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export function inspectRbd1Header(compressedDelta) {
  if (!Buffer.isBuffer(compressedDelta)) throw new TypeError('compressedDelta must be a Buffer');
  const raw = gunzipSync(compressedDelta);
  if (raw.length < 4 + 32 + 1 + 32 + 1 + 1) {
    throw new Error('RBD1 delta stream truncated');
  }
  const magicBuf = raw.subarray(0, 4);
  if (!magicBuf.equals(RBD1_MAGIC) && !magicBuf.equals(LEGACY_RBD1_MAGIC)) {
    throw new Error(`Invalid RBD1 magic header: ${magicBuf.toString('ascii')}`);
  }
  let pos = 4;
  const sourceSha256 = raw.subarray(pos, pos + 32).toString('hex');
  pos += 32;
  const sDec = decodeUleb128(raw, pos);
  if (!sDec) throw new Error('Truncated RBD1 sourceSize');
  pos = sDec.nextOffset;
  if (raw.length - pos < 33) throw new Error('Truncated RBD1 target header');
  const targetSha256 = raw.subarray(pos, pos + 32).toString('hex');
  pos += 32;
  const tDec = decodeUleb128(raw, pos);
  if (!tDec) throw new Error('Truncated RBD1 targetSize');
  return {
    magic: magicBuf.toString('ascii'),
    sourceSha256,
    sourceSize: sDec.value,
    targetSha256,
    targetSize: tDec.value,
    headerBytes: tDec.nextOffset,
  };
}

export function applyRbd1Delta(source, compressedDelta) {
  if (!Buffer.isBuffer(source) || !Buffer.isBuffer(compressedDelta)) {
    throw new TypeError('source and compressedDelta must be Buffers');
  }
  const raw = gunzipSync(compressedDelta);
  let pos = 0;
  if (raw.length < 4 + 32 + 1 + 32 + 1 + 1) {
    throw new Error('Invalid delta header');
  }
  const magic = raw.subarray(0, 4);
  if (!magic.equals(RBD1_MAGIC) && !magic.equals(LEGACY_RBD1_MAGIC)) {
    throw new Error('Invalid delta header magic');
  }
  pos += 4;
  const sourceShaHex = raw.subarray(pos, pos + 32).toString('hex');
  pos += 32;
  const sSizeDec = decodeUleb128(raw, pos);
  if (!sSizeDec) throw new Error('Truncated delta sourceSize');
  pos = sSizeDec.nextOffset;
  if (raw.length - pos < 33) throw new Error('Truncated delta target header');
  const targetShaHex = raw.subarray(pos, pos + 32).toString('hex');
  pos += 32;
  const tSizeDec = decodeUleb128(raw, pos);
  if (!tSizeDec) throw new Error('Truncated delta targetSize');
  pos = tSizeDec.nextOffset;

  const actualSourceSha = sha256Hex(source);
  if (source.length !== sSizeDec.value || actualSourceSha !== sourceShaHex) {
    throw new Error('Delta source checksum or size mismatch');
  }
  if (tSizeDec.value < 0 || tSizeDec.value > MAX_DELTA_TARGET_BYTES) {
    throw new Error(`Delta target size out of range: ${tSizeDec.value}`);
  }

  const out = Buffer.allocUnsafe(tSizeDec.value);
  let written = 0;
  let ended = false;
  while (pos < raw.length) {
    const op = raw[pos++];
    if (op === RBD1_OP_END) {
      ended = true;
      break;
    }
    if (op === RBD1_OP_COPY) {
      const offDec = decodeUleb128(raw, pos);
      if (!offDec) throw new Error('Truncated COPY offset');
      const lenDec = decodeUleb128(raw, offDec.nextOffset);
      if (!lenDec) throw new Error('Truncated COPY length');
      pos = lenDec.nextOffset;
      const offset = offDec.value;
      const length = lenDec.value;
      if (length <= 0 || offset + length > source.length || written + length > out.length) {
        throw new Error('Invalid COPY bounds');
      }
      source.copy(out, written, offset, offset + length);
      written += length;
    } else if (op === RBD1_OP_ADD) {
      const lenDec = decodeUleb128(raw, pos);
      if (!lenDec) throw new Error('Truncated ADD length');
      pos = lenDec.nextOffset;
      const length = lenDec.value;
      if (length <= 0 || pos + length > raw.length || written + length > out.length) {
        throw new Error('Invalid ADD bounds');
      }
      raw.copy(out, written, pos, pos + length);
      pos += length;
      written += length;
    } else {
      throw new Error(`Unknown delta opcode: ${op}`);
    }
  }
  if (!ended || pos !== raw.length || written !== out.length) {
    throw new Error('Incomplete or malformed delta stream');
  }
  if (sha256Hex(out) !== targetShaHex) {
    throw new Error('Delta output SHA-256 verification failed');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apple itms-services manifest.plist & AltStore / SideStore altstore.json
// ---------------------------------------------------------------------------

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str) {
  return String(str ?? '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function buildIosManifestPlist({
  ipaUrl,
  bundleId = 'dev.rokbot.local',
  bundleVersion = '1.16.0',
  title = 'RokBot',
  displayImageUrl,
  fullSizeImageUrl,
}) {
  if (!ipaUrl) throw new Error('ipaUrl is required');
  const assets = [
    { kind: 'software-package', url: ipaUrl },
    ...(displayImageUrl ? [{ kind: 'display-image', url: displayImageUrl }] : []),
    ...(fullSizeImageUrl ? [{ kind: 'full-size-image', url: fullSizeImageUrl }] : []),
  ];
  const assetXml = assets
    .map((asset) => [
      '        <dict>',
      '          <key>kind</key>',
      `          <string>${escapeXml(asset.kind)}</string>`,
      '          <key>url</key>',
      `          <string>${escapeXml(asset.url)}</string>`,
      '        </dict>',
    ].join('\n'))
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>items</key>',
    '  <array>',
    '    <dict>',
    '      <key>assets</key>',
    '      <array>',
    assetXml,
    '      </array>',
    '      <key>metadata</key>',
    '      <dict>',
    '        <key>bundle-identifier</key>',
    `        <string>${escapeXml(bundleId)}</string>`,
    '        <key>bundle-version</key>',
    `        <string>${escapeXml(bundleVersion)}</string>`,
    '        <key>kind</key>',
    '        <string>software</string>',
    '        <key>title</key>',
    `        <string>${escapeXml(title)}</string>`,
    '      </dict>',
    '    </dict>',
    '  </array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function extractPlistKeyStringMap(xmlBlock) {
  const map = {};
  const re = /<key>\s*([^<]+?)\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/g;
  let m;
  while ((m = re.exec(xmlBlock)) !== null) {
    map[unescapeXml(m[1].trim())] = unescapeXml(m[2].trim());
  }
  return map;
}

export function validateIosManifestPlist(xmlText, expected = {}) {
  const text = String(xmlText ?? '');
  const errors = [];
  if (!text.includes('<?xml')) errors.push('Missing XML declaration');
  if (!/<plist\b[^>]*version=["']1\.0["'][^>]*>/.test(text) || !text.includes('</plist>')) {
    errors.push('Missing <plist version="1.0"> root element');
  }
  if (!/<key>\s*items\s*<\/key>/.test(text)) {
    errors.push('Missing items key');
  }

  const assetsMatch = /<key>\s*assets\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  const assets = [];
  if (!assetsMatch) {
    errors.push('Missing assets array');
  } else {
    const dictRe = /<dict>([\s\S]*?)<\/dict>/g;
    let dm;
    while ((dm = dictRe.exec(assetsMatch[1])) !== null) {
      assets.push(extractPlistKeyStringMap(dm[1]));
    }
  }

  const softwarePkg = assets.find((a) => a.kind === 'software-package');
  if (!softwarePkg || !softwarePkg.url) {
    errors.push('Missing software-package asset url');
  } else {
    let parsedUrl = null;
    try {
      parsedUrl = new URL(softwarePkg.url);
    } catch {
      errors.push(`Invalid software-package URL: ${softwarePkg.url}`);
    }
    if (parsedUrl) {
      const allowLocalHttp = expected.allowHttpLocalhost !== false && (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost');
      if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && allowLocalHttp)) {
        errors.push(`Invalid software-package URL protocol: ${parsedUrl.protocol}`);
      }
    }
  }

  const metadataMatch = /<key>\s*metadata\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
  const metadata = metadataMatch ? extractPlistKeyStringMap(metadataMatch[1]) : {};
  if (!metadata['bundle-identifier']) errors.push('Missing metadata bundle-identifier');
  if (!metadata['bundle-version']) errors.push('Missing metadata bundle-version');
  if (metadata.kind !== 'software') errors.push(`Expected metadata kind=software, got ${metadata.kind}`);
  if (!metadata.title) errors.push('Missing metadata title');

  if (expected.bundleId && metadata['bundle-identifier'] !== expected.bundleId) {
    errors.push(`Expected bundle-identifier ${expected.bundleId}, got ${metadata['bundle-identifier']}`);
  }
  if (expected.bundleVersion && metadata['bundle-version'] !== expected.bundleVersion) {
    errors.push(`Expected bundle-version ${expected.bundleVersion}, got ${metadata['bundle-version']}`);
  }
  if (expected.ipaUrl && softwarePkg?.url !== expected.ipaUrl) {
    errors.push(`Expected ipaUrl ${expected.ipaUrl}, got ${softwarePkg?.url}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    parsed: { assets, metadata },
  };
}

export function buildAltStoreSource({
  name = 'RokBot Self-Hosted',
  identifier = 'dev.rokbot.local.source',
  subtitle = 'RokBot self-hosted iOS OTA updates',
  description = 'Self-hosted RokBot iOS release feed',
  sourceURL,
  apps = [],
}) {
  return {
    name,
    identifier,
    subtitle,
    description,
    ...(sourceURL ? { sourceURL } : {}),
    apps,
  };
}

export function validateAltStoreJson(jsonObj, expected = {}) {
  const errors = [];
  if (!jsonObj || typeof jsonObj !== 'object' || Array.isArray(jsonObj)) {
    return { ok: false, errors: ['AltStore source must be a JSON object'] };
  }
  if (typeof jsonObj.name !== 'string' || !jsonObj.name.trim()) {
    errors.push('AltStore source missing non-empty name');
  }
  if (!Array.isArray(jsonObj.apps) || jsonObj.apps.length === 0) {
    errors.push('AltStore source must contain at least one app');
  } else {
    for (const [idx, app] of jsonObj.apps.entries()) {
      if (!app || typeof app !== 'object') {
        errors.push(`apps[${idx}] must be an object`);
        continue;
      }
      if (typeof app.name !== 'string' || !app.name.trim()) errors.push(`apps[${idx}].name missing`);
      if (typeof app.bundleIdentifier !== 'string' || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app.bundleIdentifier)) {
        errors.push(`apps[${idx}].bundleIdentifier invalid: ${app.bundleIdentifier}`);
      }
      if (typeof app.developerName !== 'string' || !app.developerName.trim()) errors.push(`apps[${idx}].developerName missing`);
      if (typeof app.localizedDescription !== 'string' || !app.localizedDescription.trim()) {
        errors.push(`apps[${idx}].localizedDescription missing`);
      }
      if (!Array.isArray(app.versions) || app.versions.length === 0) {
        errors.push(`apps[${idx}].versions must be a non-empty array`);
      } else {
        for (const [vIdx, ver] of app.versions.entries()) {
          if (!ver || typeof ver !== 'object') {
            errors.push(`apps[${idx}].versions[${vIdx}] must be an object`);
            continue;
          }
          if (typeof ver.version !== 'string' || !ver.version.trim()) errors.push(`apps[${idx}].versions[${vIdx}].version missing`);
          if (typeof ver.date !== 'string' || Number.isNaN(Date.parse(ver.date))) {
            errors.push(`apps[${idx}].versions[${vIdx}].date must be ISO-8601`);
          }
          if (typeof ver.downloadURL !== 'string' || !ver.downloadURL.trim()) {
            errors.push(`apps[${idx}].versions[${vIdx}].downloadURL missing`);
          } else {
            try {
              const u = new URL(ver.downloadURL);
              const allowLocal = expected.allowHttpLocalhost !== false && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
              if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowLocal)) {
                errors.push(`apps[${idx}].versions[${vIdx}].downloadURL invalid protocol: ${u.protocol}`);
              }
            } catch {
              errors.push(`apps[${idx}].versions[${vIdx}].downloadURL invalid URL`);
            }
          }
          if (!Number.isFinite(ver.size) || ver.size <= 0) {
            errors.push(`apps[${idx}].versions[${vIdx}].size must be > 0`);
          }
          if (ver.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(String(ver.sha256))) {
            errors.push(`apps[${idx}].versions[${vIdx}].sha256 invalid`);
          }
        }
      }
      if (expected.bundleId && app.bundleIdentifier !== expected.bundleId) {
        errors.push(`Expected bundleIdentifier ${expected.bundleId}, got ${app.bundleIdentifier}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

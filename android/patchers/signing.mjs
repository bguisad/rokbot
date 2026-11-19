// Pure Node.js ZIP aligner (16KB page alignment for .so, 4B data alignment),
// RSA/EC key generation, and APK Signature Scheme v2 & v3 signer.
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  X509Certificate
} from 'node:crypto';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const BLOCK_MAGIC = Buffer.from('APK Sig Block 42', 'latin1');
const V2_BLOCK_ID = 0x7109871a;
const V3_BLOCK_ID = 0xf05368c0;
const CHUNK = 1024 * 1024;
// 1981-01-01 00:00 reproducible timestamp
const DOS_DATE = ((1981 - 1980) << 9) | (1 << 5) | 1;

export const u16 = value => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
};

export const u32 = value => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
};

export const u64 = value => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};

export const prefixed = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length), body]);
};

export function findEnd(buffer) {
  const lowest = Math.max(0, buffer.length - 0xffff - 22);
  for (let at = buffer.length - 22; at >= lowest; at--) {
    if (buffer.readUInt32LE(at) === END && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) {
      return at;
    }
  }
  throw new Error('Not a ZIP archive');
}

export function readZip(buffer) {
  const end = findEnd(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let at = centralOffset, index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== CENTRAL) throw new Error('Corrupt ZIP central directory');
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    if (buffer.readUInt32LE(localOffset) !== LOCAL) throw new Error('Corrupt ZIP local header');
    const compressedSize = buffer.readUInt32LE(at + 20);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    entries.push({
      name: buffer.toString('utf8', at + 46, at + 46 + nameLength),
      flags: buffer.readUInt16LE(at + 8),
      method: buffer.readUInt16LE(at + 10),
      time: buffer.readUInt16LE(at + 12),
      date: buffer.readUInt16LE(at + 14),
      crc: buffer.readUInt32LE(at + 16),
      compressedSize,
      size: buffer.readUInt32LE(at + 24),
      externalAttributes: buffer.readUInt32LE(at + 38),
      localOffset,
      dataStart,
      data: buffer.subarray(dataStart, dataStart + compressedSize),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, centralOffset, end };
}

export function entryBytes(entry) {
  if (entry.method === 0) return Buffer.from(entry.data);
  if (entry.method === 8) return inflateRawSync(entry.data);
  throw new Error(`Unsupported ZIP compression in ${entry.name}`);
}

export function createEntry(name, content, { store = false } = {}) {
  const bytes = Buffer.from(content);
  let method = 0, data = bytes;
  if (!store && bytes.length > 0) {
    const deflated = deflateRawSync(bytes, { level: 9 });
    if (deflated.length < bytes.length) {
      method = 8;
      data = deflated;
    }
  }
  return {
    name,
    flags: 0,
    method,
    time: 0,
    date: DOS_DATE,
    crc: crc32(bytes) >>> 0,
    compressedSize: data.length,
    size: bytes.length,
    externalAttributes: 0,
    data
  };
}

/**
 * Writes entries in order with 16 KiB alignment for uncompressed .so files
 * and 4-byte alignment for uncompressed data files via 0xd935 extra field.
 */
export function writeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const flags = /[^\x00-\x7f]/.test(entry.name) ? 0x800 : 0;
    let extra = Buffer.alloc(0);
    if (entry.method === 0) {
      const alignment = entry.name.endsWith('.so') ? 16384 : 4;
      const padding = (alignment - ((offset + 30 + name.length + 6) % alignment)) % alignment;
      extra = Buffer.concat([u16(0xd935), u16(2 + padding), u16(alignment), Buffer.alloc(padding)]);
    }
    const version = entry.method === 8 ? 20 : 10;
    const fields = Buffer.concat([
      u16(version), u16(flags), u16(entry.method), u16(entry.time), u16(entry.date),
      u32(entry.crc), u32(entry.data.length), u32(entry.size), u16(name.length)
    ]);
    parts.push(u32(LOCAL), fields, u16(extra.length), name, extra, entry.data);
    central.push(Buffer.concat([
      u32(CENTRAL), u16(version), fields, u16(0), u16(0), u16(0), u16(0),
      u32(entry.externalAttributes ?? 0), u32(offset), name
    ]));
    offset += 30 + name.length + extra.length + entry.data.length;
  }
  const directory = Buffer.concat(central);
  if (entries.length > 0xffff || offset + directory.length > 0xffffffff) {
    throw new Error('APK exceeds ZIP size limits');
  }
  const end = Buffer.concat([
    u32(END), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.length), u32(offset), u16(0)
  ]);
  return Buffer.concat([...parts, directory, end]);
}

export function chunkedDigest(sections) {
  const digests = [];
  for (const section of sections) {
    for (let at = 0; at < section.length; at += CHUNK) {
      const chunk = section.subarray(at, Math.min(section.length, at + CHUNK));
      digests.push(
        createHash('sha256')
          .update(Buffer.from([0xa5]))
          .update(u32(chunk.length))
          .update(chunk)
          .digest()
      );
    }
  }
  return createHash('sha256')
    .update(Buffer.from([0x5a]))
    .update(u32(digests.length))
    .update(Buffer.concat(digests))
    .digest();
}

export const algorithmFor = key => {
  if (key.asymmetricKeyType === 'ec') return 0x0201; // ECDSA with SHA2-256
  if (key.asymmetricKeyType === 'rsa') return 0x0103; // RSASSA-PKCS1-v1_5 with SHA2-256
  throw new Error('Signing key must be EC P-256 or RSA');
};

// DER encoding helpers for X.509 self-signed certificates
function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const der = (tag, ...content) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const sequence = (...content) => der(0x30, ...content);
const set = (...content) => der(0x31, ...content);
function objectId(text) {
  const parts = text.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    for (let value = part >>> 7; value > 0; value >>>= 7) encoded.unshift((value & 0x7f) | 0x80);
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}
function integer(bytes) {
  let value = Buffer.from(bytes);
  while (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return der(0x02, value);
}
function time(date) {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(text.slice(2))) : der(0x18, Buffer.from(text));
}
const certName = (common, organization) => sequence(
  set(sequence(objectId('2.5.4.10'), der(0x0c, Buffer.from(organization)))),
  set(sequence(objectId('2.5.4.3'), der(0x0c, Buffer.from(common))))
);

/**
 * Creates self-signed signing identity (RSA 2048/4096 or EC P-256)
 */
export function createSigningIdentity({
  type = 'rsa',
  modulusLength = 2048,
  commonName = 'RokBot Native Signer',
  organization = 'RokBot Project',
  now = new Date()
} = {}) {
  let keyPair;
  let algorithm;

  if (type === 'ec') {
    keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    algorithm = sequence(objectId('1.2.840.10045.4.3.2')); // ecdsaWithSHA256
  } else {
    keyPair = generateKeyPairSync('rsa', { modulusLength: modulusLength || 2048 });
    // sha256WithRSAEncryption: 1.2.840.113549.1.1.11 with NULL parameter
    algorithm = sequence(objectId('1.2.840.113549.1.1.11'), der(0x05));
  }

  const { privateKey, publicKey } = keyPair;
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(Date.UTC(now.getUTCFullYear() + 30, now.getUTCMonth(), now.getUTCDate()));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;

  const tbs = sequence(
    der(0xa0, integer([2])),
    integer(serial),
    algorithm,
    certName(commonName, organization),
    sequence(time(notBefore), time(notAfter)),
    certName(commonName, organization),
    publicKey.export({ type: 'spki', format: 'der' })
  );

  const sigBytes = sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, algorithm, der(0x03, Buffer.from([0]), sigBytes));

  return { privateKey, certificate, type };
}

/**
 * Signs an aligned APK using APK Signature Scheme v2 and/or v3.
 */
export function signApk(unsigned, identity, { schemes = ['v2', 'v3'], minSdk = 24, maxSdk = 0x7fffffff } = {}) {
  const end = findEnd(unsigned);
  const centralOffset = unsigned.readUInt32LE(end + 16);
  const contents = unsigned.subarray(0, centralOffset);
  const directory = unsigned.subarray(centralOffset, end);
  const tail = unsigned.subarray(end);

  if (contents.subarray(-16).equals(BLOCK_MAGIC)) {
    throw new Error('APK is already signed');
  }

  const { privateKey, certificate } = identity;
  const algorithm = algorithmFor(privateKey);
  const digest = chunkedDigest([contents, directory, tail]);
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

  const pairs = [];

  // V2 Scheme Block
  if (schemes.includes('v2')) {
    const signedDataV2 = Buffer.concat([
      prefixed(prefixed(u32(algorithm), prefixed(digest))),
      prefixed(prefixed(certificate)),
      prefixed(),
    ]);
    const sigV2 = sign('sha256', signedDataV2, privateKey);
    const signerV2 = Buffer.concat([
      prefixed(signedDataV2),
      prefixed(prefixed(u32(algorithm), prefixed(sigV2))),
      prefixed(publicKey)
    ]);
    const valueV2 = prefixed(prefixed(signerV2));
    pairs.push(Buffer.concat([u64(4 + valueV2.length), u32(V2_BLOCK_ID), valueV2]));
  }

  // V3 Scheme Block
  if (schemes.includes('v3')) {
    const signedDataV3 = Buffer.concat([
      prefixed(prefixed(u32(algorithm), prefixed(digest))),
      prefixed(prefixed(certificate)),
      u32(minSdk),
      u32(maxSdk),
      prefixed(),
    ]);
    const sigV3 = sign('sha256', signedDataV3, privateKey);
    const signerV3 = Buffer.concat([
      prefixed(signedDataV3),
      u32(minSdk),
      u32(maxSdk),
      prefixed(prefixed(u32(algorithm), prefixed(sigV3))),
      prefixed(publicKey)
    ]);
    const valueV3 = prefixed(prefixed(signerV3));
    pairs.push(Buffer.concat([u64(4 + valueV3.length), u32(V3_BLOCK_ID), valueV3]));
  }

  const allPairs = Buffer.concat(pairs);
  const size = allPairs.length + 8 + BLOCK_MAGIC.length;
  const block = Buffer.concat([u64(size), allPairs, u64(size), BLOCK_MAGIC]);

  const signedTail = Buffer.from(tail);
  signedTail.writeUInt32LE(centralOffset + block.length, 16);

  return Buffer.concat([contents, block, directory, signedTail]);
}

/**
 * Verifies APK signature scheme v2/v3 signatures against APK contents.
 */
export function verifyApk(apk) {
  const end = findEnd(apk);
  const centralOffset = apk.readUInt32LE(end + 16);
  if (!apk.subarray(centralOffset - 16, centralOffset).equals(BLOCK_MAGIC)) {
    throw new Error('No APK Signing Block');
  }

  const size = Number(apk.readBigUInt64LE(centralOffset - 24));
  const blockStart = centralOffset - size - 8;
  if (blockStart < 0 || Number(apk.readBigUInt64LE(blockStart)) !== size) {
    throw new Error('Corrupt APK Signing Block');
  }

  let v2 = null, v3 = null;
  for (let at = blockStart + 8; at < centralOffset - 24;) {
    if (at + 12 > centralOffset - 24) {
      throw new Error('Corrupt APK Signing Block entry header');
    }
    const length = Number(apk.readBigUInt64LE(at));
    if (length < 4 || at + 8 + length > centralOffset - 24) {
      throw new Error('Corrupt APK Signing Block entry length');
    }
    const id = apk.readUInt32LE(at + 8);
    if (id === V2_BLOCK_ID) v2 = apk.subarray(at + 12, at + 8 + length);
    if (id === V3_BLOCK_ID) v3 = apk.subarray(at + 12, at + 8 + length);
    at += 8 + length;
  }

  const blocksToVerify = [];
  if (v2) blocksToVerify.push({ scheme: 'v2', block: v2, isV3: false });
  if (v3) blocksToVerify.push({ scheme: 'v3', block: v3, isV3: true });

  if (blocksToVerify.length === 0) {
    throw new Error('No supported APK signature block found');
  }

  const read = (buf, at) => {
    const len = buf.readUInt32LE(at);
    return [buf.subarray(at + 4, at + 4 + len), at + 4 + len];
  };

  const tail = Buffer.from(apk.subarray(end));
  tail.writeUInt32LE(blockStart, 16);
  const expected = chunkedDigest([apk.subarray(0, blockStart), apk.subarray(centralOffset, end), tail]);

  let verifiedCert = null;

  for (const { scheme, block, isV3 } of blocksToVerify) {
    const [signers] = read(block, 0);
    const [signer] = read(signers, 0);
    let at = 0, signedData, signatures, publicKeyDer;
    [signedData, at] = read(signer, at);
    if (isV3) {
      // minSdk and maxSdk in v3 signer block
      at += 8;
    }
    [signatures, at] = read(signer, at);
    [publicKeyDer] = read(signer, at);

    const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
    const [sigRec] = read(signatures, 0);
    const algorithm = sigRec.readUInt32LE(0);
    const [sig] = read(sigRec, 4);

    if (!verify('sha256', signedData, publicKey, sig)) {
      throw new Error(`APK signature does not verify (${scheme})`);
    }

    let cursor = 0, digests, certificates;
    [digests, cursor] = read(signedData, cursor);
    [certificates] = read(signedData, cursor);
    const [digestRec] = read(digests, 0);
    if (digestRec.readUInt32LE(0) !== algorithm) {
      throw new Error(`Digest algorithm mismatch in ${scheme}`);
    }
    const [digest] = read(digestRec, 4);

    if (!digest.equals(expected)) {
      throw new Error('APK contents do not match the signature');
    }

    const [certDer] = read(certificates, 0);
    const x509 = new X509Certificate(certDer);
    if (!verifiedCert || isV3) {
      verifiedCert = x509;
    }
  }

  return {
    verified: true,
    certificate: verifiedCert,
    hasV2: v2 !== null,
    hasV3: v3 !== null,
  };
}

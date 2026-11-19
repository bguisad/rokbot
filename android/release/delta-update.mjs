#!/usr/bin/env node
/**
 * GrokBot Android Native Incremental Delta Update Generator & Applier (GBDELTA1).
 *
 * Format (inside a GZIP stream):
 *   Header (44 bytes, big-endian):
 *     [0..7]   ASCII magic "GBDELTA1"
 *     [8..15]  uint64 baseSize
 *     [16..23] uint64 targetSize
 *     [24..27] uint32 opCount (informational; stream terminates with OP_EOF)
 *     [28..43] 16 reserved zero bytes
 *   Ops:
 *     0x01 OP_COPY:   uint64 baseOffset, uint32 length
 *     0x02 OP_INSERT: uint32 length, byte[length] payload
 *     0x00 OP_EOF:    end of stream
 *
 * Optimized for Android APKs (ZIP archives): indexes both ZIP Local File Headers
 * (matching shifted unchanged entries with a single OP_COPY regardless of alignment)
 * and 4KB blocks for non-ZIP / intra-entry reuse.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

export const DELTA_MAGIC = Buffer.from('GBDELTA1', 'ascii');
export const OP_EOF = 0x00;
export const OP_COPY = 0x01;
export const OP_INSERT = 0x02;
const BLOCK_SIZE = 4096;
const MIN_MATCH = 64;
const MAX_OP_LEN = 0x7fffffff;

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
  // Map header fingerprint -> array of offsets in buf for every PK\x03\x04 local file header
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
  const limit = buf.length - BLOCK_SIZE;
  for (let off = 0; off <= limit; off += BLOCK_SIZE) {
    const key = hashSlice32(buf, off, 64);
    if (!map.has(key)) {
      map.set(key, off);
    }
  }
  return map;
}

function matchLength(baseBuf, baseOff, targetBuf, targetOff) {
  const maxLen = Math.min(baseBuf.length - baseOff, targetBuf.length - targetOff, MAX_OP_LEN);
  let matched = 0;
  // Compare in 64KB chunks using Buffer.compare for V8/native speed
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

/**
 * Generates a GZIP-compressed GBDELTA1 binary delta from baseBuf -> targetBuf.
 */
export function generateDelta(baseBuf, targetBuf) {
  if (!Buffer.isBuffer(baseBuf) || !Buffer.isBuffer(targetBuf)) {
    throw new TypeError('baseBuf and targetBuf must be Buffers');
  }

  const zipIndex = indexZipEntries(baseBuf);
  const blockIndex = indexBlocks(baseBuf);

  const ops = [];
  let pendingInsertStart = -1;
  let pendingInsertEnd = -1;

  const flushInsert = () => {
    if (pendingInsertStart >= 0 && pendingInsertEnd > pendingInsertStart) {
      ops.push({ type: OP_INSERT, start: pendingInsertStart, len: pendingInsertEnd - pendingInsertStart });
    }
    pendingInsertStart = -1;
    pendingInsertEnd = -1;
  };

  const pushCopy = (baseOff, len) => {
    flushInsert();
    const prev = ops[ops.length - 1];
    if (prev && prev.type === OP_COPY && prev.baseOff + prev.len === baseOff && prev.len + len <= MAX_OP_LEN) {
      prev.len += len;
    } else {
      ops.push({ type: OP_COPY, baseOff, len });
    }
  };

  let tPos = 0;
  let expectedBasePos = 0;
  const tLen = targetBuf.length;

  while (tPos < tLen) {
    let bestBaseOff = -1;
    let bestLen = 0;

    // 1. Fast path: check continuation at expectedBasePos
    if (expectedBasePos >= 0 && expectedBasePos + MIN_MATCH <= baseBuf.length && tPos + MIN_MATCH <= tLen) {
      if (baseBuf[expectedBasePos] === targetBuf[tPos]
          && baseBuf[expectedBasePos + 31] === targetBuf[tPos + 31]
          && baseBuf[expectedBasePos + 63] === targetBuf[tPos + 63]) {
        const m = matchLength(baseBuf, expectedBasePos, targetBuf, tPos);
        if (m >= MIN_MATCH) {
          bestBaseOff = expectedBasePos;
          bestLen = m;
        }
      }
    }

    // 2. ZIP Local File Header alignment check (handles arbitrary byte shifts in APKs)
    if (bestLen < MIN_MATCH && tPos + 30 <= tLen
        && targetBuf[tPos] === 0x50 && targetBuf[tPos + 1] === 0x4b
        && targetBuf[tPos + 2] === 0x03 && targetBuf[tPos + 3] === 0x04) {
      const nameLen = targetBuf.readUInt16LE(tPos + 26);
      const fpLen = Math.min(64, 30 + nameLen, tLen - tPos);
      if (fpLen >= 30) {
        const candidates = zipIndex.get(hashSlice32(targetBuf, tPos, fpLen));
        if (candidates) {
          for (const candOff of candidates) {
            const m = matchLength(baseBuf, candOff, targetBuf, tPos);
            if (m > bestLen && m >= MIN_MATCH) {
              bestLen = m;
              bestBaseOff = candOff;
            }
          }
        }
      }
    }

    // 3. Block hash check (every 64 bytes when scanning literals to keep generation fast)
    if (bestLen < MIN_MATCH && tPos + 64 <= tLen && (tPos & 63) === 0) {
      const candOff = blockIndex.get(hashSlice32(targetBuf, tPos, 64));
      if (candOff !== undefined) {
        const m = matchLength(baseBuf, candOff, targetBuf, tPos);
        if (m >= MIN_MATCH) {
          bestBaseOff = candOff;
          bestLen = m;
        }
      }
    }

    if (bestLen >= MIN_MATCH) {
      pushCopy(bestBaseOff, bestLen);
      tPos += bestLen;
      expectedBasePos = bestBaseOff + bestLen;
    } else {
      if (pendingInsertStart < 0) pendingInsertStart = tPos;
      // Advance to next PK\x03\x04 or 64-byte boundary (whichever is closer)
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

  // Serialize binary stream
  let rawLen = 44 + 1; // header + OP_EOF
  for (const op of ops) {
    if (op.type === OP_COPY) rawLen += 1 + 8 + 4;
    else rawLen += 1 + 4 + op.len;
  }

  const raw = Buffer.allocUnsafe(rawLen);
  let p = 0;
  DELTA_MAGIC.copy(raw, p); p += 8;
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
      raw[p++] = OP_INSERT;
      raw.writeUInt32BE(op.len >>> 0, p); p += 4;
      targetBuf.copy(raw, p, op.start, op.start + op.len);
      p += op.len;
    }
  }
  raw[p++] = OP_EOF;

  return zlib.gzipSync(raw, { level: 6 });
}

/**
 * Applies a GZIP-compressed GBDELTA1 delta buffer onto baseBuf and returns the reconstructed Buffer.
 */
export function applyDelta(baseBuf, deltaGzipBuf) {
  if (!Buffer.isBuffer(baseBuf) || !Buffer.isBuffer(deltaGzipBuf)) {
    throw new TypeError('baseBuf and deltaGzipBuf must be Buffers');
  }
  const raw = zlib.gunzipSync(deltaGzipBuf);
  if (raw.length < 45) {
    throw new Error('Delta stream truncated');
  }
  if (!raw.subarray(0, 8).equals(DELTA_MAGIC)) {
    throw new Error('Invalid delta magic header');
  }
  const baseSize = Number(raw.readBigUInt64BE(8));
  const targetSize = Number(raw.readBigUInt64BE(16));
  if (baseSize !== baseBuf.length) {
    throw new Error(`Base size mismatch: expected ${baseSize}, got ${baseBuf.length}`);
  }
  if (targetSize < 0 || targetSize > 512 * 1024 * 1024) {
    throw new Error(`Invalid target size: ${targetSize}`);
  }

  const out = Buffer.allocUnsafe(targetSize);
  let inPos = 44;
  let outPos = 0;
  let sawEof = false;

  while (inPos < raw.length) {
    const op = raw[inPos++];
    if (op === OP_EOF) {
      sawEof = true;
      break;
    } else if (op === OP_COPY) {
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
    } else if (op === OP_INSERT) {
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

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function findAndroidTool(toolName) {
  const roots = [
    process.env.ANDROID_HOME,
    '/Volumes/ORICO/android/sdk',
    path.join(process.env.HOME || '', 'Library/Android/sdk'),
  ].filter(Boolean);
  for (const root of roots) {
    const btDir = path.join(root, 'build-tools');
    if (!fs.existsSync(btDir)) continue;
    const versions = fs.readdirSync(btDir).sort().reverse();
    for (const v of versions) {
      const cand = path.join(btDir, v, toolName);
      if (fs.existsSync(cand)) return cand;
    }
  }
  return toolName;
}

export function inspectApkMetadata(apkPath) {
  const buf = fs.readFileSync(apkPath);
  const sha256 = sha256Hex(buf);
  const size = buf.length;
  let packageName = 'ai.x.grok.bot';
  let versionCode = 1;
  let versionName = '1.0.0';
  let certificateSha256 = '';

  try {
    const aapt2 = findAndroidTool('aapt2');
    const badging = execFileSync(aapt2, ['dump', 'badging', apkPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const m = /package:\s+name='([^']+)'\s+versionCode='(\d+)'\s+versionName='([^']+)'/.exec(badging);
    if (m) {
      packageName = m[1];
      versionCode = Number(m[2]);
      versionName = m[3];
    }
  } catch { /* optional fallback */ }

  try {
    const apksigner = findAndroidTool('apksigner');
    const out = execFileSync(apksigner, ['verify', '--print-certs', apkPath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const cm = /certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/i.exec(out);
    if (cm) certificateSha256 = cm[1].toLowerCase();
  } catch { /* optional fallback */ }

  return { packageName, versionCode, versionName, sha256, size, certificateSha256 };
}

export function buildUpdateManifest({
  apkPath,
  fullUrl,
  deltas = [],
  notes = '',
  buildId = null,
}) {
  const meta = inspectApkMetadata(apkPath);
  return {
    schema: 'grokbot-android-native-update/v1',
    packageName: meta.packageName,
    versionName: meta.versionName,
    versionCode: meta.versionCode,
    buildId: buildId || meta.sha256.slice(0, 12),
    sha256: meta.sha256,
    size: meta.size,
    certificateSha256: meta.certificateSha256,
    fullUrl,
    publishedAt: new Date().toISOString(),
    notes,
    deltas,
  };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };

  if (cmd === 'generate-delta') {
    const fromPath = getArg('--from');
    const toPath = getArg('--to');
    const outPath = getArg('--out');
    if (!fromPath || !toPath || !outPath) {
      console.error('Usage: delta-update.mjs generate-delta --from old.apk --to new.apk --out patch.gbdelta');
      process.exit(1);
    }
    const baseBuf = fs.readFileSync(fromPath);
    const targetBuf = fs.readFileSync(toPath);
    const t0 = Date.now();
    const delta = generateDelta(baseBuf, targetBuf);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, delta);
    const ratio = ((1 - delta.length / targetBuf.length) * 100).toFixed(2);
    console.log(JSON.stringify({
      ok: true,
      fromSha256: sha256Hex(baseBuf),
      toSha256: sha256Hex(targetBuf),
      deltaSha256: sha256Hex(delta),
      baseSize: baseBuf.length,
      targetSize: targetBuf.length,
      deltaSize: delta.length,
      savingsPercent: Number(ratio),
      elapsedMs: Date.now() - t0,
      outPath,
    }, null, 2));
  } else if (cmd === 'apply-delta') {
    const fromPath = getArg('--from');
    const deltaPath = getArg('--delta');
    const outPath = getArg('--out');
    if (!fromPath || !deltaPath || !outPath) {
      console.error('Usage: delta-update.mjs apply-delta --from old.apk --delta patch.gbdelta --out reconstructed.apk');
      process.exit(1);
    }
    const baseBuf = fs.readFileSync(fromPath);
    const deltaBuf = fs.readFileSync(deltaPath);
    const out = applyDelta(baseBuf, deltaBuf);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, out);
    console.log(JSON.stringify({ ok: true, size: out.length, sha256: sha256Hex(out), outPath }, null, 2));
  } else if (cmd === 'generate-manifest') {
    const apkPath = getArg('--apk');
    const fullUrl = getArg('--full-url');
    const outPath = getArg('--out');
    const fromPath = getArg('--from');
    const deltaPath = getArg('--delta');
    const deltaUrl = getArg('--delta-url');
    const notes = getArg('--notes') || '';
    if (!apkPath || !fullUrl || !outPath) {
      console.error('Usage: delta-update.mjs generate-manifest --apk new.apk --full-url <url> --out update.json [--from old.apk --delta patch.gbdelta --delta-url <url>]');
      process.exit(1);
    }
    const deltas = [];
    if (fromPath && deltaPath && deltaUrl) {
      const fromBuf = fs.readFileSync(fromPath);
      const deltaBuf = fs.readFileSync(deltaPath);
      deltas.push({
        fromSha256: sha256Hex(fromBuf),
        url: deltaUrl,
        sha256: sha256Hex(deltaBuf),
        size: deltaBuf.length,
      });
    }
    const manifest = buildUpdateManifest({ apkPath, fullUrl, deltas, notes });
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.error('Unknown command. Use: generate-delta | apply-delta | generate-manifest');
    process.exit(1);
  }
}

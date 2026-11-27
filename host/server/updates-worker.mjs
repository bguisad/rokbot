import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { createRbd1DeltaBuffer, createRbdelta1Buffer, inspectApkBuffer } from './updates.mjs';

/**
 * Return a Uint8Array backed by an unshared ArrayBuffer safe for postMessage transferList.
 */
function toOwnedUint8Array(buf) {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return new Uint8Array(buf.buffer);
  }
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy;
}

async function runTask(data) {
  if (data.op === 'inspect-apk') {
    const buf = await readFile(data.filePath);
    return { msg: { ok: true, apkInfo: inspectApkBuffer(buf) } };
  }
  if (data.op === 'generate-delta') {
    const [baseBuf, targetBuf] = await Promise.all([
      readFile(data.basePath),
      readFile(data.targetPath),
    ]);
    if (baseBuf.length > data.maxDeltaBytes || targetBuf.length > data.maxDeltaBytes) {
      throw new Error('Delta input exceeds maximum allowed size');
    }
    const deltaBuf = data.format === 'rbdelta1'
      ? createRbdelta1Buffer(baseBuf, targetBuf)
      : createRbd1DeltaBuffer(baseBuf, targetBuf);
    if (deltaBuf.length >= targetBuf.length) {
      return {
        msg: {
          ok: true,
          skipped: true,
          baseSize: baseBuf.length,
          targetSize: targetBuf.length,
        },
      };
    }
    const deltaSha = createHash('sha256').update(deltaBuf).digest('hex');
    const deltaBytes = toOwnedUint8Array(deltaBuf);
    return {
      msg: {
        ok: true,
        skipped: false,
        baseSize: baseBuf.length,
        targetSize: targetBuf.length,
        deltaSha,
        deltaSize: deltaBuf.length,
        deltaBytes,
      },
      transferList: [deltaBytes.buffer],
    };
  }
  throw new Error(`Unknown update worker op: ${String(data?.op)}`);
}

(async () => {
  try {
    const { msg, transferList } = await runTask(workerData);
    parentPort.postMessage(msg, transferList);
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error?.message ?? String(error),
    });
  }
})();

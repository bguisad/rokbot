import http from 'node:http';
import https from 'node:https';
import { posix } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import {
  DEFAULT_TRANSFER_CHUNK_BYTES,
  minByteLimit,
  resolveMaxTransferBytes,
} from './file-transfer.mjs';

const CHUNK_BYTES = 12 * 1024;
const PARALLEL_READS = 8;
const PART_CLEANUP_TIMEOUT_MS = 5_000;
const TRANSFER_TOOL_CALL_ID = 'sand-box-file-transfer';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

const reader = `import os,sys,json,base64,stat
p=sys.argv[1];offset=int(sys.argv[2]);limit=int(sys.argv[3])
with open(p,'rb') as f:
 s=os.fstat(f.fileno())
 if not stat.S_ISREG(s.st_mode): raise ValueError('not a regular file')
 if limit>=0 and s.st_size>limit: raise ValueError('file exceeds download limit')
 f.seek(offset);chunk=f.read(${CHUNK_BYTES})
 print(json.dumps({'identity':[s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns],'data':base64.b64encode(chunk).decode()}))`;

const appendChunkScript = `import os,sys,shutil
part=sys.argv[1];chunk=sys.argv[2];expected=int(sys.argv[3])
cur=os.path.getsize(part) if os.path.exists(part) else 0
if cur!=expected:
 raise ValueError(f'offset mismatch: {cur} != {expected}')
if expected==0 and not os.path.exists(part):
 os.replace(chunk,part)
else:
 with open(chunk,'rb') as src, open(part,'ab') as dst:
  shutil.copyfileobj(src,dst,1024*1024)
 os.unlink(chunk)`;

const verifyCommitScript = `import os,sys,hashlib
part=sys.argv[1];target=sys.argv[2];expected_bytes=int(sys.argv[3]);expected_sha=sys.argv[4]
if expected_bytes==0 and not os.path.exists(part):
 open(part,'wb').close()
h=hashlib.sha256();total=0
with open(part,'rb') as f:
 while True:
  b=f.read(1024*1024)
  if not b: break
  total+=len(b);h.update(b)
actual_sha=h.hexdigest()
if total!=expected_bytes or actual_sha!=expected_sha:
 try: os.unlink(part)
 except OSError: pass
 raise ValueError(f'integrity mismatch: bytes={total}/{expected_bytes} sha256={actual_sha}/{expected_sha}')
os.replace(part,target)`;

function encodeVarint(value) {
  let n = BigInt(value);
  const bytes = [];
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset: pos };
    shift += 7n;
    if (shift > 64n) throw new Error('Invalid protobuf varint');
  }
  throw new Error('Truncated protobuf varint');
}

function encodeStringField(fieldNumber, text) {
  const bytes = Buffer.from(String(text), 'utf8');
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(bytes.length), bytes]);
}

function parseExportFileResponse(payload) {
  let offset = 0;
  let contentChunk;
  let totalBytes;
  while (offset < payload.length) {
    const tag = decodeVarint(payload, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === 2) {
      const len = decodeVarint(payload, offset);
      offset = len.offset;
      const end = offset + Number(len.value);
      if (end > payload.length) throw new Error('Truncated protobuf length-delimited field');
      const slice = payload.subarray(offset, end);
      offset = end;
      if (fieldNumber === 1) {
        contentChunk = Buffer.from(slice);
      } else if (fieldNumber === 2) {
        let mOff = 0;
        while (mOff < slice.length) {
          const mTag = decodeVarint(slice, mOff);
          mOff = mTag.offset;
          const mField = Number(mTag.value >> 3n);
          const mWire = Number(mTag.value & 7n);
          if (mWire === 0) {
            const val = decodeVarint(slice, mOff);
            mOff = val.offset;
            if (mField === 1) totalBytes = Number(val.value);
          } else if (mWire === 2) {
            const mLen = decodeVarint(slice, mOff);
            mOff = mLen.offset + Number(mLen.value);
          } else if (mWire === 1) {
            mOff += 8;
          } else if (mWire === 5) {
            mOff += 4;
          } else {
            throw new Error(`Unsupported protobuf wire type ${mWire}`);
          }
        }
      }
    } else if (wireType === 0) {
      offset = decodeVarint(payload, offset).offset;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
  return { contentChunk, totalBytes };
}

/**
 * Stream a file from exec-daemon via its native Connect server-streaming RPC
 * `agent.v1.ControlService/ExportFile` (64 KiB binary chunks, O(1) memory).
 */
export async function openExportFileViaConnect({
  url,
  token,
  headers = {},
  filePath,
  workspaceRootPath = '/workspace',
  maxBytes = Infinity,
  signal,
}) {
  signal?.throwIfAborted();
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === 'https:' ? https : http;
  const protoBody = Buffer.concat([
    encodeStringField(1, filePath),
    encodeStringField(2, workspaceRootPath),
  ]);
  const envelope = Buffer.allocUnsafe(5 + protoBody.length);
  envelope[0] = 0;
  envelope.writeUInt32BE(protoBody.length, 1);
  protoBody.copy(envelope, 5);

  const response = await new Promise((resolveResponse, rejectResponse) => {
    const req = transport.request(parsedUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/connect+proto',
        'connect-protocol-version': '1',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
        'content-length': String(envelope.length),
      },
    }, (res) => {
      cleanupAbort();
      resolveResponse({ req, res });
    });
    const headerTimer = setTimeout(() => {
      const err = new Error('ExportFile response headers timed out');
      req.destroy(err);
      rejectResponse(err);
    }, 10_000);
    headerTimer.unref?.();
    const onAbort = () => {
      const err = signal.reason ?? new Error('ExportFile aborted');
      req.destroy(err);
      rejectResponse(err);
    };
    const cleanupAbort = () => {
      clearTimeout(headerTimer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    req.on('error', (err) => {
      cleanupAbort();
      rejectResponse(err);
    });
    req.end(envelope);
  });

  const { req, res } = response;
  const closeStream = async () => {
    res.destroy();
    req.destroy();
  };

  if (res.statusCode !== 200) {
    const errChunks = [];
    for await (const c of res) {
      if (errChunks.length < 16) errChunks.push(Buffer.from(c));
    }
    const err = new Error(`ExportFile HTTP ${res.statusCode}: ${Buffer.concat(errChunks).toString('utf8').slice(0, 300)}`);
    err.httpStatus = res.statusCode;
    throw err;
  }

  const rawIterator = res[Symbol.asyncIterator]();
  const onAbortStream = () => {
    res.destroy(signal?.reason ?? new Error('ExportFile aborted'));
    req.destroy();
  };
  signal?.addEventListener?.('abort', onAbortStream, { once: true });

  let acc = Buffer.alloc(0);
  let eof = false;

  async function nextEnvelope() {
    while (true) {
      signal?.throwIfAborted();
      if (acc.length >= 5) {
        const flags = acc[0];
        const len = acc.readUInt32BE(1);
        if (acc.length >= 5 + len) {
          const payload = Buffer.from(acc.subarray(5, 5 + len));
          acc = acc.subarray(5 + len);
          return { flags, payload };
        }
      }
      if (eof) {
        if (acc.length > 0) throw new Error('Truncated Connect envelope in ExportFile');
        return null;
      }
      const next = await rawIterator.next();
      if (next.done) {
        eof = true;
      } else {
        const part = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        acc = acc.length === 0 ? part : Buffer.concat([acc, part]);
      }
    }
  }

  const handleEndStream = (payload) => {
    let parsed;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      parsed = {};
    }
    if (parsed.error) {
      const err = new Error(parsed.error.message || `ExportFile error (${parsed.error.code || 'unknown'})`);
      err.connectCode = parsed.error.code;
      throw err;
    }
  };

  let totalBytes;
  let pendingFirstChunk = null;
  let ended = false;
  try {
    const first = await nextEnvelope();
    if (!first) throw new Error('ExportFile stream ended before metadata');
    if (first.flags & 0x02) {
      handleEndStream(first.payload);
      ended = true;
      totalBytes = 0;
    } else if (first.flags !== 0) {
      throw new Error(`Unsupported Connect envelope flags: ${first.flags}`);
    } else {
      const parsed = parseExportFileResponse(first.payload);
      if (parsed.totalBytes !== undefined) {
        totalBytes = parsed.totalBytes;
      }
      if (parsed.contentChunk !== undefined) {
        pendingFirstChunk = parsed.contentChunk;
      }
    }
    if (totalBytes !== undefined && totalBytes > maxBytes) {
      throw new Error(`File exceeds transfer size limit (${totalBytes} > ${maxBytes})`);
    }
  } catch (error) {
    signal?.removeEventListener?.('abort', onAbortStream);
    await closeStream();
    throw error;
  }

  return {
    totalBytes,
    close: async () => {
      signal?.removeEventListener?.('abort', onAbortStream);
      await closeStream();
    },
    async *chunks() {
      let received = 0;
      try {
        if (pendingFirstChunk && pendingFirstChunk.length > 0) {
          received += pendingFirstChunk.length;
          if (received > maxBytes) throw new Error(`File exceeds transfer size limit (${received} > ${maxBytes})`);
          yield pendingFirstChunk;
          pendingFirstChunk = null;
        }
        if (ended) return;
        while (true) {
          const env = await nextEnvelope();
          if (!env) break;
          if (env.flags & 0x02) {
            handleEndStream(env.payload);
            break;
          }
          if (env.flags !== 0) throw new Error(`Unsupported Connect envelope flags: ${env.flags}`);
          const parsed = parseExportFileResponse(env.payload);
          if (parsed.totalBytes !== undefined && totalBytes === undefined) {
            totalBytes = parsed.totalBytes;
            if (totalBytes > maxBytes) throw new Error(`File exceeds transfer size limit (${totalBytes} > ${maxBytes})`);
          }
          if (parsed.contentChunk && parsed.contentChunk.length > 0) {
            received += parsed.contentChunk.length;
            if (received > maxBytes) throw new Error(`File exceeds transfer size limit (${received} > ${maxBytes})`);
            yield parsed.contentChunk;
          }
        }
        if (totalBytes !== undefined && received !== totalBytes) {
          throw new Error(`ExportFile truncated (${received} != ${totalBytes})`);
        }
      } finally {
        signal?.removeEventListener?.('abort', onAbortStream);
        await closeStream();
      }
    },
  };
}

function resolveExecExportUrl(box, env) {
  const execUrl = (env?.ROKBOT_EXECUTION_URL ?? env?.GROKBOT_EXECUTION_URL)?.trim();
  if (execUrl) {
    return {
      url: `${execUrl.replace(/\/+$/, '')}/exec/agent.v1.ControlService/ExportFile`,
      token: env?.ROKBOT_BOX_TOKEN || env?.GROKBOT_BOX_TOKEN || box?.options?.authToken || 'local',
      headers: {},
    };
  }
  if (typeof box?.primaryEndpoint === 'function') {
    const ep = box.primaryEndpoint();
    if (ep?.host && ep?.port) {
      return {
        url: `http://${ep.host}:${ep.port}/agent.v1.ControlService/ExportFile`,
        token: ep.authToken ?? box?.options?.authToken ?? 'local',
        headers: ep.headers ?? {},
      };
    }
    return null;
  }
  const host = (box?.options?.host ?? env?.ROKBOT_BOX_HOST ?? env?.GROKBOT_BOX_HOST)?.trim();
  if (host) {
    const port = Number(env?.ROKBOT_BOX_EXEC_PORT || box?.options?.execPort || 1337);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return {
        url: `http://${host}:${port}/agent.v1.ControlService/ExportFile`,
        token: box?.options?.authToken || env?.ROKBOT_BOX_TOKEN || env?.GROKBOT_BOX_TOKEN || 'local',
        headers: {},
      };
    }
  }
  return null;
}

async function runBoxShellScript(ctx, shell, buildHostShellArgs, command, name = 'bash') {
  const result = await shell.execute(ctx, buildHostShellArgs({
    command,
    name,
    workingDirectory: '/workspace',
    toolCallId: `${TRANSFER_TOOL_CALL_ID}-${randomUUID()}`,
  }));
  if (result.result?.case === 'success' && result.result.value.exitCode === 0) {
    return result.result.value;
  }
  const detail = result.result?.case === 'success'
    ? `exit ${result.result.value.exitCode}: ${result.result.value.stderr || result.result.value.stdout}`
    : result.result?.case ?? 'unknown';
  throw new Error(`Box transfer shell command failed (${detail})`);
}

async function uploadStreamViaExecDaemon({
  ctx,
  box,
  agentId,
  boxPath,
  chunkIterable,
  buildHostShellArgs,
  shellExecutorResource,
  writeExecutorResource,
  WriteArgs,
  expectedBytes,
  getExpectedDigest,
  chunkBytes = DEFAULT_TRANSFER_CHUNK_BYTES,
  maxBytes = Infinity,
}) {
  const resolved = posix.resolve('/workspace', boxPath);
  if (expectedBytes !== undefined && expectedBytes > maxBytes) {
    throw new Error(`File exceeds transfer size limit (${expectedBytes} > ${maxBytes})`);
  }
  const { remoteAccessor } = await box.ensureReady(ctx, agentId);
  const shell = remoteAccessor.get(shellExecutorResource);
  const writer = writeExecutorResource ? remoteAccessor.get(writeExecutorResource) : null;
  if (!shell || !writer || !WriteArgs) {
    // Fallback if test mock doesn't expose writeExecutorResource / WriteArgs.
    const parts = [];
    let total = 0;
    for await (const raw of chunkIterable) {
      ctx?.signal?.throwIfAborted();
      if (!raw || raw.byteLength === 0) continue;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      total += buf.length;
      if (total > maxBytes) throw new Error(`File exceeds transfer size limit (${total} > ${maxBytes})`);
      parts.push(buf);
    }
    await box.uploadFile(ctx, agentId, boxPath, Buffer.concat(parts, total));
    return;
  }

  const parent = posix.dirname(resolved);
  await runBoxShellScript(ctx, shell, buildHostShellArgs, `mkdir -p -- ${quote(parent)}`, 'bash');
  const suffix = randomBytes(8).toString('hex');
  const partPath = `${resolved}.sand-${suffix}.part`;
  const chunkPath = `${partPath}.chunk`;
  const step = Math.max(64 * 1024, Math.floor(chunkBytes));
  const hash = createHash('sha256');
  let offset = 0;

  try {
    for await (const raw of chunkIterable) {
      ctx?.signal?.throwIfAborted();
      if (!raw || raw.byteLength === 0) continue;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let pos = 0; pos < buf.length; pos += step) {
        ctx?.signal?.throwIfAborted();
        const slice = buf.subarray(pos, Math.min(buf.length, pos + step));
        if (offset + slice.length > maxBytes) {
          throw new Error(`File exceeds transfer size limit (${offset + slice.length} > ${maxBytes})`);
        }
        const writeResult = await writer.execute(ctx, new WriteArgs({
          path: chunkPath,
          fileBytes: Uint8Array.from(slice),
          toolCallId: TRANSFER_TOOL_CALL_ID,
        }));
        if (writeResult.result?.case !== 'success') {
          const reason = writeResult.result?.value?.error ?? writeResult.result?.value?.reason ?? writeResult.result?.case ?? 'unknown';
          throw new Error(`Upload chunk to box ${resolved} failed: ${reason}`);
        }
        await runBoxShellScript(
          ctx,
          shell,
          buildHostShellArgs,
          `python3 -c ${quote(appendChunkScript)} ${quote(partPath)} ${quote(chunkPath)} ${offset}`,
          'python3',
        );
        hash.update(slice);
        offset += slice.length;
      }
    }

    ctx?.signal?.throwIfAborted();
    const actualSha256 = hash.digest('hex');
    const expectedSummary = getExpectedDigest?.();
    if (expectedSummary?.sha256 && expectedSummary.sha256 !== actualSha256) {
      throw new Error(`Box upload SHA-256 mismatch before commit (${actualSha256} != ${expectedSummary.sha256})`);
    }
    if (expectedBytes !== undefined && offset !== expectedBytes) {
      throw new Error(`Box upload byte count mismatch (${offset} != ${expectedBytes})`);
    }

    await runBoxShellScript(
      ctx,
      shell,
      buildHostShellArgs,
      `python3 -c ${quote(verifyCommitScript)} ${quote(partPath)} ${quote(resolved)} ${offset} ${quote(actualSha256)}`,
      'python3',
    );
  } catch (error) {
    const cleanupCtx = typeof ctx?.withDetached === 'function'
      ? ctx.withDetached().withTimeout(PART_CLEANUP_TIMEOUT_MS)
      : {};
    await runBoxShellScript(
      cleanupCtx,
      shell,
      buildHostShellArgs,
      `rm -f -- ${quote(partPath)} ${quote(chunkPath)}`,
      'bash',
    ).catch(() => {});
    throw error;
  }
}

async function openShellDownloadStream({
  ctx,
  box,
  agentId,
  resolved,
  buildHostShellArgs,
  shellExecutorResource,
  BoxFileUnreadableError,
  maxBytes,
}) {
  const { remoteAccessor } = await box.ensureReady(ctx, agentId);
  const shell = remoteAccessor.get(shellExecutorResource);
  const limitArg = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : -1;

  const readAt = async (offset) => {
    ctx?.signal?.throwIfAborted();
    const result = await shell.execute(ctx, buildHostShellArgs({
      command: `python3 -c ${quote(reader)} ${quote(resolved)} ${offset} ${limitArg}`,
      name: 'python3',
      workingDirectory: '/workspace',
      toolCallId: `remote-file-${randomUUID()}`,
    }));
    if (result.result?.case !== 'success' || result.result.value.exitCode !== 0) {
      throw new BoxFileUnreadableError(`Remote file could not be read: ${resolved}`);
    }
    let part;
    try {
      part = JSON.parse(result.result.value.stdout);
    } catch {
      throw new Error('Remote file response was truncated or invalid');
    }
    const length = part.identity?.[2];
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes || typeof part.data !== 'string') {
      throw new Error('Invalid remote file metadata');
    }
    return { identity: JSON.stringify(part.identity), length, chunk: Buffer.from(part.data, 'base64') };
  };

  const first = await readAt(0);
  const { identity, length } = first;
  const totalChunks = Math.ceil(length / CHUNK_BYTES);
  if (length > 0 && first.chunk.length !== Math.min(CHUNK_BYTES, length)) {
    throw new Error('Invalid remote file chunk');
  }

  return {
    totalBytes: length,
    identity,
    async *chunks() {
      if (length === 0) return;
      yield first.chunk;
      if (totalChunks <= 1) return;

      // Sliding window of PARALLEL_READS in-flight reads so memory stays O(PARALLEL_READS * CHUNK_BYTES)
      // regardless of file size while keeping parallel throughput.
      const ready = new Map();
      let nextIssue = 1;
      let nextYield = 1;
      let inFlight = 0;
      let failure = null;
      let wakeConsumer = null;
      let wakeWorkers = [];

      const notifyConsumer = () => {
        const fn = wakeConsumer;
        wakeConsumer = null;
        fn?.();
      };
      const notifyWorkers = () => {
        const list = wakeWorkers;
        wakeWorkers = [];
        for (const fn of list) fn();
      };

      const maxWindow = PARALLEL_READS * 2;
      const worker = async () => {
        while (!failure) {
          if (ctx?.signal?.aborted) {
            failure = ctx.signal.reason ?? new Error('Remote download aborted');
            notifyConsumer();
            return;
          }
          if (ready.size + inFlight >= maxWindow && nextIssue - nextYield >= maxWindow) {
            await new Promise((resolveWait) => { wakeWorkers.push(resolveWait); });
            continue;
          }
          if (nextIssue >= totalChunks) return;
          const index = nextIssue++;
          inFlight += 1;
          try {
            const part = await readAt(index * CHUNK_BYTES);
            if (part.identity !== identity) {
              throw new Error('Remote file changed during download');
            }
            const expectedLen = Math.min(CHUNK_BYTES, length - index * CHUNK_BYTES);
            if (part.chunk.length !== expectedLen) {
              throw new Error('Invalid remote file chunk');
            }
            ready.set(index, part.chunk);
            notifyConsumer();
          } catch (error) {
            if (!failure) failure = error;
            notifyConsumer();
            notifyWorkers();
            return;
          } finally {
            inFlight -= 1;
          }
        }
      };

      const workerCount = Math.min(PARALLEL_READS, totalChunks - 1);
      const workers = Promise.all(Array.from({ length: workerCount }, worker));
      try {
        while (nextYield < totalChunks) {
          while (ready.has(nextYield)) {
            const chunk = ready.get(nextYield);
            ready.delete(nextYield);
            nextYield += 1;
            notifyWorkers();
            yield chunk;
          }
          if (failure) throw failure;
          if (nextYield >= totalChunks) break;
          await new Promise((resolveWait) => { wakeConsumer = resolveWait; });
        }
        await workers;
        if (failure) throw failure;
      } finally {
        if (!failure) failure = new Error('Download stream closed');
        notifyWorkers();
        await workers.catch(() => {});
      }
    },
  };
}

async function openLocalFsDownloadStream({
  ctx,
  box,
  boxPath,
  BoxFileUnreadableError,
  chunkBytes = DEFAULT_TRANSFER_CHUNK_BYTES,
  maxBytes = Infinity,
}) {
  const resolved = posix.resolve('/workspace', boxPath);
  await box.assertFileReadAllowed(resolved);
  let probe;
  try {
    probe = await open(resolved, 'r');
  } catch (error) {
    if (BoxFileUnreadableError && error?.code === 'ENOENT') {
      const wrapped = new BoxFileUnreadableError(`File could not be read: ${resolved}`);
      wrapped.code = 'ENOENT';
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
  let st;
  try {
    st = await probe.stat();
    if (!st.isFile()) {
      throw new (BoxFileUnreadableError ?? Error)(`Not a regular file: ${resolved}`);
    }
    if (st.size > maxBytes) {
      throw new Error(`File exceeds transfer size limit (${st.size} > ${maxBytes})`);
    }
  } finally {
    await probe.close();
  }
  const totalBytes = st.size;
  const identity = JSON.stringify([st.dev, st.ino, st.size, st.mtimeMs]);
  const step = Math.max(64 * 1024, Math.floor(chunkBytes));
  return {
    totalBytes,
    identity,
    async *chunks() {
      if (totalBytes === 0) return;
      const handle = await open(resolved, 'r');
      try {
        const live = await handle.stat();
        if (JSON.stringify([live.dev, live.ino, live.size, live.mtimeMs]) !== identity) {
          throw new Error('Box file changed during transfer');
        }
        const buffer = Buffer.allocUnsafe(Math.min(step, totalBytes));
        let offset = 0;
        while (offset < totalBytes) {
          ctx?.signal?.throwIfAborted();
          const want = Math.min(buffer.length, totalBytes - offset);
          const { bytesRead } = await handle.read(buffer, 0, want, offset);
          if (bytesRead === 0) throw new Error('Box file ended before its declared size');
          offset += bytesRead;
          yield Buffer.from(buffer.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    },
  };
}

/** Keep the original Exec/window protocol; replace assumptions about shared local files. */
export function installRemoteBoxAdapter(bindings, original, env = process.env) {
  const { LoopbackSandBox, buildHostShellArgs } = bindings;
  const { shellExecutorResource, writeExecutorResource, WriteArgs, BoxFileUnreadableError } = original;
  const host = (env.ROKBOT_BOX_HOST ?? env.GROKBOT_BOX_HOST)?.trim();
  const maxDownloadBytes = resolveMaxTransferBytes(env);

  if (!host) {
    if (LoopbackSandBox && typeof LoopbackSandBox.prototype === 'object') {
      LoopbackSandBox.prototype.openDownloadStream = async function openDownloadStream(ctx, _agentId, boxPath, options = {}) {
        const limit = minByteLimit(options.maxBytes, resolveMaxTransferBytes(env));
        return await openLocalFsDownloadStream({
          ctx,
          box: this,
          boxPath,
          BoxFileUnreadableError,
          chunkBytes: options.chunkBytes,
          maxBytes: limit,
        });
      };
      LoopbackSandBox.prototype.uploadFileStream = async function uploadFileStream(ctx, agentId, boxPath, chunkIterable, options = {}) {
        const limit = minByteLimit(options.maxBytes, resolveMaxTransferBytes(env));
        await uploadStreamViaExecDaemon({
          ctx,
          box: this,
          agentId,
          boxPath,
          chunkIterable,
          buildHostShellArgs,
          shellExecutorResource,
          writeExecutorResource,
          WriteArgs,
          expectedBytes: options.expectedBytes,
          getExpectedDigest: options.getExpectedDigest,
          chunkBytes: options.chunkBytes,
          maxBytes: limit,
        });
      };
    }
    return { mode: 'in-container', maxDownloadBytes };
  }

  if (!/^[A-Za-z0-9.-]+$/.test(host) && !/^\[[0-9a-f:]+\]$/i.test(host)) {
    throw new Error('ROKBOT_BOX_HOST must be a hostname or IP address');
  }
  const token = env.ROKBOT_BOX_TOKEN || env.GROKBOT_BOX_TOKEN || 'local';
  if (!LoopbackSandBox || !buildHostShellArgs || !shellExecutorResource) {
    throw new Error('Remote Box dependencies are missing');
  }

  class RemoteBox extends LoopbackSandBox {
    describe() { return { backend: 'remote-exec', host }; }

    async openDownloadStream(ctx, agentId, boxPath, options = {}) {
      const resolved = posix.resolve('/workspace', boxPath);
      await this.assertFileReadAllowed(resolved);
      const limit = minByteLimit(options.maxBytes, resolveMaxTransferBytes(env));

      const exportEndpoint = (resolved === '/workspace' || resolved.startsWith('/workspace/'))
        ? resolveExecExportUrl(this, env)
        : null;
      if (exportEndpoint) {
        try {
          await this.ensureReady(ctx, agentId);
          return await openExportFileViaConnect({
            url: exportEndpoint.url,
            token: exportEndpoint.token,
            headers: exportEndpoint.headers,
            filePath: resolved,
            workspaceRootPath: '/workspace',
            maxBytes: limit,
            signal: ctx?.signal,
          });
        } catch (error) {
          if (ctx?.signal?.aborted) throw error;
          if (error?.connectCode === 'not_found') {
            const missing = new BoxFileUnreadableError(`Remote file could not be read: ${resolved}`);
            missing.code = 'ENOENT';
            missing.cause = error;
            throw missing;
          }
          if (/exceeds transfer size limit/i.test(error?.message ?? '')) throw error;
          // Symlinks, non-workspace paths, or mocks without ExportFile fall back cleanly to shell chunks.
        }
      }

      return await openShellDownloadStream({
        ctx,
        box: this,
        agentId,
        resolved,
        buildHostShellArgs,
        shellExecutorResource,
        BoxFileUnreadableError,
        maxBytes: limit,
      });
    }

    async uploadFileStream(ctx, agentId, boxPath, chunkIterable, options = {}) {
      const limit = minByteLimit(options.maxBytes, resolveMaxTransferBytes(env));
      await uploadStreamViaExecDaemon({
        ctx,
        box: this,
        agentId,
        boxPath,
        chunkIterable,
        buildHostShellArgs,
        shellExecutorResource,
        writeExecutorResource,
        WriteArgs,
        expectedBytes: options.expectedBytes,
        getExpectedDigest: options.getExpectedDigest,
        chunkBytes: options.chunkBytes,
        maxBytes: limit,
      });
    }

    async downloadFile(ctx, agentId, boxPath, options = {}) {
      const stream = await this.openDownloadStream(ctx, agentId, boxPath, options);
      const parts = [];
      let total = 0;
      try {
        for await (const chunk of stream.chunks()) {
          parts.push(chunk);
          total += chunk.length;
        }
      } finally {
        await stream.close?.().catch(() => {});
      }
      return Buffer.concat(parts, total);
    }
  }

  bindings.createSandBox = options => new RemoteBox({ ...options, host, authToken: token, homeDir: '/home/box' });
  bindings.formatSandBoxStartupSummary = () => `[sand-host] remote execution desktop: ${host}`;
  return { mode: 'remote-exec', host, maxDownloadBytes };
}

import { createHash } from 'node:crypto';

export const DEFAULT_TRANSFER_CHUNK_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TRANSFER_TIMEOUT_MS = 30 * 60_000;
export const ROKBOT_CHUNKED_VARIANT_TOKEN = 'rokbot-chunked-v1';

const STREAM_TRANSFER_SYMBOL = Symbol('rokbot.streamTransfer');

/**
 * Parse ROKBOT_MAX_TRANSFER_BYTES (default: unlimited / Infinity).
 * Accepts unset, empty, 0, "unlimited", "none", "infinity", "false" as unlimited,
 * or a positive integer byte limit.
 */
export function resolveMaxTransferBytes(env = process.env) {
  const raw = env?.ROKBOT_MAX_TRANSFER_BYTES;
  if (raw === undefined || raw === null) return Infinity;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed || trimmed === '0' || trimmed === 'unlimited' || trimmed === 'none' || trimmed === 'infinity' || trimmed === 'false') {
    return Infinity;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return Infinity;
  if (parsed === 0) return Infinity;
  return Math.floor(parsed);
}

export function resolveTransferTimeoutMs(env = process.env) {
  const raw = env?.ROKBOT_TRANSFER_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TRANSFER_TIMEOUT_MS;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TRANSFER_TIMEOUT_MS;
  return Math.floor(parsed);
}

export function minByteLimit(...limits) {
  let result = Infinity;
  for (const limit of limits) {
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && limit < result) {
      result = limit;
    }
  }
  return result;
}

export function formatByteLimit(bytes) {
  if (!Number.isFinite(bytes)) return 'unlimited';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * Coalesce/split an arbitrary async iterable of Uint8Array/Buffer chunks into bounded
 * chunks of at most `chunkBytes` bytes, while incrementally computing SHA-256 and enforcing
 * `maxBytes` with O(chunkBytes) memory.
 */
export async function* rechunkAndHashStream(chunks, {
  chunkBytes = DEFAULT_TRANSFER_CHUNK_BYTES,
  maxBytes = Infinity,
  signal,
  onComplete,
} = {}) {
  const targetChunkSize = Math.max(64 * 1024, Math.floor(chunkBytes));
  const hash = createHash('sha256');
  let totalBytes = 0;
  let pending = Buffer.allocUnsafe(targetChunkSize);
  let pendingLen = 0;

  for await (const raw of chunks) {
    signal?.throwIfAborted();
    if (!raw || raw.byteLength === 0) continue;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new Error(`File exceeds transfer size limit (${totalBytes} > ${maxBytes})`);
    }
    hash.update(buf);

    let offset = 0;
    while (offset < buf.length) {
      const space = targetChunkSize - pendingLen;
      const take = Math.min(space, buf.length - offset);
      buf.copy(pending, pendingLen, offset, offset + take);
      pendingLen += take;
      offset += take;
      if (pendingLen === targetChunkSize) {
        yield Buffer.from(pending.subarray(0, pendingLen));
        pendingLen = 0;
      }
    }
  }

  signal?.throwIfAborted();
  if (pendingLen > 0) {
    yield Buffer.from(pending.subarray(0, pendingLen));
    pendingLen = 0;
  }

  const digest = hash.digest('hex');
  onComplete?.({ bytes: totalBytes, sha256: digest });
}

/**
 * Stream a file from `source` to `dest` with bounded memory and end-to-end SHA-256 verification.
 * Uses chunked streaming when both sides support it, and falls back cleanly otherwise.
 */
export async function streamTransferBetweenBoxes(ctx, {
  sourceBox,
  sourceAgentId,
  sourcePath,
  destBox,
  destAgentId,
  destPath,
  preopenedSource,
  chunkBytes = DEFAULT_TRANSFER_CHUNK_BYTES,
  maxBytes = resolveMaxTransferBytes(),
} = {}) {
  const effectiveMaxBytes = minByteLimit(maxBytes, resolveMaxTransferBytes());
  const sourceStream = preopenedSource ?? (
    typeof sourceBox.openDownloadStream === 'function'
      ? await sourceBox.openDownloadStream(ctx, sourceAgentId, sourcePath, { chunkBytes, maxBytes: effectiveMaxBytes })
      : null
  );

  if (!sourceStream) {
    // Legacy source box without streaming support.
    const data = await sourceBox.downloadFile(ctx, sourceAgentId, sourcePath);
    if (data.byteLength > effectiveMaxBytes) {
      throw new Error(`File exceeds transfer size limit (${data.byteLength} > ${effectiveMaxBytes})`);
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (typeof destBox.uploadFileStream === 'function') {
      async function* singleChunk() {
        for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
          yield data.subarray(offset, Math.min(data.byteLength, offset + chunkBytes));
        }
      }
      await destBox.uploadFileStream(ctx, destAgentId, destPath, singleChunk(), {
        expectedBytes: data.byteLength,
        getExpectedDigest: () => ({ bytes: data.byteLength, sha256 }),
        chunkBytes,
        maxBytes: effectiveMaxBytes,
      });
    } else {
      await destBox.uploadFile(ctx, destAgentId, destPath, data);
    }
    return { bytes: data.byteLength, sha256 };
  }

  if (sourceStream.totalBytes !== undefined && sourceStream.totalBytes > effectiveMaxBytes) {
    await sourceStream.close?.().catch(() => {});
    throw new Error(`File exceeds transfer size limit (${sourceStream.totalBytes} > ${effectiveMaxBytes})`);
  }

  let completed = null;
  const rechunked = rechunkAndHashStream(sourceStream.chunks(), {
    chunkBytes,
    maxBytes: effectiveMaxBytes,
    signal: ctx?.signal,
    onComplete: (summary) => { completed = summary; },
  });

  try {
    if (typeof destBox.uploadFileStream === 'function') {
      await destBox.uploadFileStream(ctx, destAgentId, destPath, rechunked, {
        expectedBytes: sourceStream.totalBytes,
        getExpectedDigest: () => completed,
        chunkBytes,
        maxBytes: effectiveMaxBytes,
      });
      const finalSummary = completed ?? { bytes: 0, sha256: createHash('sha256').digest('hex') };
      if (sourceStream.totalBytes !== undefined && finalSummary.bytes !== sourceStream.totalBytes) {
        throw new Error(`Transferred byte count mismatch (${finalSummary.bytes} != ${sourceStream.totalBytes})`);
      }
      return finalSummary;
    }

    // Destination does not support streaming (e.g. legacy unpatched mock/box).
    const parts = [];
    for await (const piece of rechunked) {
      parts.push(piece);
    }
    const finalSummary = completed ?? { bytes: 0, sha256: createHash('sha256').digest('hex') };
    const full = Buffer.concat(parts, finalSummary.bytes);
    await destBox.uploadFile(ctx, destAgentId, destPath, full);
    return finalSummary;
  } finally {
    await sourceStream.close?.().catch(() => {});
  }
}

function createStreamTransferToken(payload) {
  const token = new Uint8Array(0);
  token[STREAM_TRANSFER_SYMBOL] = payload;
  let transferredBytes = 0;
  Object.defineProperty(token, 'byteLength', {
    configurable: true,
    enumerable: true,
    get() {
      return transferredBytes;
    },
  });
  Object.defineProperty(token, 'length', {
    configurable: true,
    enumerable: true,
    get() {
      return transferredBytes;
    },
  });
  payload.setTransferredBytes = (bytes) => {
    transferredBytes = bytes;
  };
  return token;
}

/**
 * Wrap a box used inside CopyToBox / CopyFromBox so upstream transferFileBetweenBoxes
 * never buffers the file in RAM and never trips the 256 MiB DEFAULT_BOX_TRANSFER_MAX_BYTES cap,
 * while preserving 100% of upstream error classification, auditing, aliases, and UI reporting.
 */
export function wrapBoxForFileTransferTool(box, env = process.env) {
  if (!box || typeof box !== 'object') return box;
  return new Proxy(box, {
    get(target, prop, receiver) {
      if (prop === 'downloadFile') {
        return async (ctx, agentId, filePath, options) => {
          const maxBytes = resolveMaxTransferBytes(env);
          if (typeof target.openDownloadStream !== 'function') {
            return await target.downloadFile(ctx, agentId, filePath, options ? { ...options, maxBytes } : { maxBytes });
          }
          const stream = await target.openDownloadStream(ctx, agentId, filePath, {
            chunkBytes: DEFAULT_TRANSFER_CHUNK_BYTES,
            maxBytes,
          });
          let consumed = false;
          const onAbort = () => {
            if (!consumed) void stream.close?.().catch(() => {});
          };
          ctx?.signal?.addEventListener?.('abort', onAbort, { once: true });
          return createStreamTransferToken({
            sourceBox: target,
            sourceAgentId: agentId,
            sourcePath: filePath,
            preopenedSource: stream,
            maxBytes,
            markConsumed: () => {
              consumed = true;
              ctx?.signal?.removeEventListener?.('abort', onAbort);
            },
          });
        };
      }
      if (prop === 'uploadFile') {
        return async (ctx, agentId, destPath, data, options) => {
          const payload = data?.[STREAM_TRANSFER_SYMBOL];
          if (!payload) {
            return await target.uploadFile(ctx, agentId, destPath, data, options);
          }
          payload.markConsumed?.();
          const result = await streamTransferBetweenBoxes(ctx, {
            sourceBox: payload.sourceBox,
            sourceAgentId: payload.sourceAgentId,
            sourcePath: payload.sourcePath,
            preopenedSource: payload.preopenedSource,
            destBox: target,
            destAgentId: agentId,
            destPath,
            maxBytes: minByteLimit(payload.maxBytes, resolveMaxTransferBytes(env)),
          });
          payload.setTransferredBytes(result.bytes);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrapUserComputersForFileTransferTool(userComputers, env) {
  if (!userComputers || typeof userComputers.resolve !== 'function') return userComputers;
  return new Proxy(userComputers, {
    get(target, prop, receiver) {
      if (prop === 'resolve') {
        return (...args) => {
          const resolved = target.resolve(...args);
          if (!resolved || !resolved.box) return resolved;
          return {
            ...resolved,
            box: wrapBoxForFileTransferTool(resolved.box, env),
          };
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function rewriteSizeLimitDescription(text, maxBytes) {
  if (typeof text !== 'string') return text;
  const replacement = Number.isFinite(maxBytes) ? `up to ${formatByteLimit(maxBytes)}` : 'of any size';
  return text.replace(/up to \d+(?:\.\d+)?\s*MiB/gi, replacement);
}

function wrapTransferToolDescription(tool, env) {
  if (!tool || (tool.name !== 'CopyToBox' && tool.name !== 'CopyFromBox')) return tool;
  const maxBytes = resolveMaxTransferBytes(env);
  const patched = { ...tool };
  if (typeof tool.descriptionGenerator === 'function') {
    const origGen = tool.descriptionGenerator;
    patched.descriptionGenerator = (...args) => rewriteSizeLimitDescription(origGen(...args), maxBytes);
  }
  if (typeof tool.description === 'string') {
    patched.description = rewriteSizeLimitDescription(tool.description, maxBytes);
  }
  return patched;
}

function wrapFileTransferBuilder(builder, env) {
  if (!builder || typeof builder.build !== 'function' || !Array.isArray(builder.names)) return builder;
  if (!builder.names.includes('CopyToBox') && !builder.names.includes('CopyFromBox')) return builder;
  return {
    ...builder,
    build(context) {
      const controller = context?.machines?.fileTransferController;
      if (!controller) return builder.build(context);
      const wrappedController = {
        ...controller,
        agentBox: wrapBoxForFileTransferTool(controller.agentBox, env),
        userComputers: wrapUserComputersForFileTransferTool(controller.userComputers, env),
      };
      const wrappedContext = {
        ...context,
        machines: {
          ...context.machines,
          fileTransferController: wrappedController,
        },
      };
      const tools = builder.build(wrappedContext);
      return Array.isArray(tools) ? tools.map((tool) => wrapTransferToolDescription(tool, env)) : tools;
    },
  };
}

export function wrapSandToolCallExecutionTimeoutMs(origTimeout, env = process.env) {
  if (typeof origTimeout !== 'function') return origTimeout;
  return (toolName, ...rest) => {
    if (toolName === 'CopyToBox' || toolName === 'CopyFromBox') {
      return Math.max(origTimeout(toolName, ...rest) ?? 0, resolveTransferTimeoutMs(env));
    }
    return origTimeout(toolName, ...rest);
  };
}

/**
 * Decorate Prompt/tools recovery bindings so CopyToBox and CopyFromBox stream files in
 * bounded chunks with SHA-256 verification and generous transfer timeouts.
 */
export function wrapFileTransferPromptTools(bindings, env = process.env) {
  if (!bindings || typeof bindings !== 'object') return bindings;
  const wrappedByOriginal = new Map();
  const wrapList = (list) => {
    if (!Array.isArray(list)) return list;
    return list.map((builder) => {
      if (wrappedByOriginal.has(builder)) return wrappedByOriginal.get(builder);
      const next = wrapFileTransferBuilder(builder, env);
      wrappedByOriginal.set(builder, next);
      return next;
    });
  };
  const next = { ...bindings };
  if (Array.isArray(bindings.TURN_TOOL_BUILDERS)) {
    next.TURN_TOOL_BUILDERS = wrapList(bindings.TURN_TOOL_BUILDERS);
  }
  if (Array.isArray(bindings.TURN_TOOL_BUILDERS_BY_VOLATILITY)) {
    next.TURN_TOOL_BUILDERS_BY_VOLATILITY = wrapList(bindings.TURN_TOOL_BUILDERS_BY_VOLATILITY);
  }
  if (typeof bindings.sandToolCallExecutionTimeoutMs === 'function') {
    next.sandToolCallExecutionTimeoutMs = wrapSandToolCallExecutionTimeoutMs(bindings.sandToolCallExecutionTimeoutMs, env);
  }
  return next;
}

/**
 * Overrides for constructRecoveredModules() so recovered exports (in particular
 * sandToolCallExecutionTimeoutMs, which is exported by a recovered prompt-tools module
 * rather than passed via getPromptToolsRecoveryBindings()) receive the transfer timeout.
 */
export function fileTransferPromptToolOverrides(env = process.env) {
  return {
    sandToolCallExecutionTimeoutMs: (origTimeout) => wrapSandToolCallExecutionTimeoutMs(origTimeout, env),
  };
}

import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_TRANSFER_CHUNK_BYTES,
  ROKBOT_CHUNKED_VARIANT_TOKEN,
  minByteLimit,
  resolveMaxTransferBytes,
} from './file-transfer.mjs';

const DEFAULT_SAND_COMPUTER_ID = 'this-computer';
const SAND_LOCAL_EXEC_LIVENESS_WINDOW_MS = 90_000;
const FALLBACK_TERMINALS_FOLDER = 'terminals';
const DEFAULT_MAX_LOCAL_EXEC_FILE_BYTES = Infinity;
const SAND_MACHINE_ID_REQUIRED_MESSAGE = 'More than one user machine is registered. Call ListMachines and retry with machineId so the action is not sent to the wrong machine.';
const SAND_NO_LOCAL_MACHINE_MESSAGE = 'No local machine is connected.';

function computerKindFor(id, provider) {
  if (provider?.kind) return provider.kind;
  if (id.startsWith('ios-')) return 'ios';
  if (id.startsWith('android-')) return 'android';
  return 'desktop';
}

function localExecProviderRank(provider) {
  let rank = 0;
  if (provider.hadHello) rank += 4;
  if (provider.supervised === true) rank += 2;
  if (!provider.hasHeartbeat) rank += 1;
  return rank;
}

export class FrameQueue {
  buffer = [];
  wake;
  closed = false;

  push(frame) {
    if (this.closed) return;
    this.buffer.push(frame);
    this.wake?.();
    this.wake = undefined;
  }

  close() {
    this.closed = true;
    this.wake?.();
    this.wake = undefined;
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift();
        continue;
      }
      if (this.closed) return;
      await new Promise((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export class SandLocalExecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandLocalExecError';
  }
}

export class GatewayLocalExecManager {
  constructor(bridge, gate, defaultComputerId, getTerminalsFolder, reportFailure, library) {
    this.bridge = bridge;
    this.gate = gate;
    this.defaultComputerId = defaultComputerId;
    this.getTerminalsFolder = getTerminalsFolder;
    this.reportFailure = reportFailure;
    this.library = library;
  }

  nextId = 0;

  async *createExecInstance(ctx, argsSerializer) {
    const serverMessage = argsSerializer(this.nextId++);
    const computerId = serverMessage.machineId ?? this.defaultComputerId;
    const resolvedComputerId = this.bridge.assertComputerAvailable(
      computerId,
      { site: 'exec', agentId: ctx?.get?.(this.library?.sandLocalToolScopeKey)?.agentId },
      false,
    );
    const frames = this.bridge.request(
      ctx,
      { kind: 'exec', serverMessage: typeof serverMessage.toJson === 'function' ? serverMessage.toJson() : serverMessage },
      resolvedComputerId,
      { watchResponse: true, permissionMachineId: resolvedComputerId },
    );
    for await (const frame of frames) {
      if (frame.kind === 'client') {
        yield this.library.ExecClientMessage.fromJson(frame.message, { ignoreUnknownFields: true });
      } else if (frame.kind === 'control') {
        const control = this.library.ExecClientControlMessage.fromJson(frame.message, { ignoreUnknownFields: true });
        if (control.message.case === 'throw') {
          const thrown = control.message.value;
          this.reportFailure?.({ site: 'exec', error: thrown.error });
          const error = new Error(thrown.error);
          if (thrown.stackTrace) error.stack = thrown.stackTrace;
          throw error;
        }
        if (control.message.case === 'streamClose') return;
      }
    }
  }
}

export class GatewayLocalExecSandBox {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.gate = options.gate;
    this.computerId = options.computerId;
    this.env = options.env;
    this.configuredMaxFileBytes = options.maxFileBytes;
    this.maxFileBytes = options.maxFileBytes ?? resolveMaxTransferBytes(options.env ?? process.env);
    this.reportFailure = options.reportFailure;
    this.library = options.library;
  }

  effectiveMaxFileBytes(override) {
    const base = this.configuredMaxFileBytes ?? resolveMaxTransferBytes(this.env ?? process.env);
    return minByteLimit(base, this.maxFileBytes, override);
  }

  supportsChunkedTransfer(computerId = this.computerId) {
    return this.bridge.getProviderInfo(computerId)?.chunkedTransfer === true;
  }

  getTerminalsFolder(computerId = this.computerId) {
    return this.bridge.getProviderInfo(computerId)?.terminalsFolder ?? FALLBACK_TERMINALS_FOLDER;
  }

  requireUsableComputer(ctx, site) {
    const scope = ctx?.get?.(this.library?.sandLocalToolScopeKey);
    const computerId = this.bridge.assertComputerAvailable(
      this.computerId,
      { site, agentId: scope?.agentId },
      false,
    );
    return { computerId, permissionMachineId: computerId };
  }

  async ensureReady() {
    const { RemoteResourceAccessor } = this.library;
    return {
      remoteAccessor: new RemoteResourceAccessor(
        new GatewayLocalExecManager(
          this.bridge,
          this.gate,
          this.computerId,
          (computerId) => this.getTerminalsFolder(computerId),
          this.reportFailure,
          this.library,
        ),
      ),
      vncUrl: '',
      terminalsFolder: this.getTerminalsFolder(),
    };
  }

  async hibernate() {}

  async runState() {
    return this.bridge.hasProvider() ? 'running' : 'absent';
  }

  async listBoxes() {
    return [];
  }

  async sendFileTransferFrame(ctx, frame, site, { computerId, permissionMachineId }) {
    for await (const response of this.bridge.request(
      ctx,
      frame,
      computerId,
      { permissionMachineId },
    )) {
      if (response.kind === 'client' && response.message?.rokbotFileTransfer === true) {
        if (response.message.error) {
          const error = new SandLocalExecError(response.message.error);
          if (typeof response.message.code === 'string') error.code = response.message.code;
          throw error;
        }
        return response.message;
      }
      if (response.kind === 'file-error') {
        throw new SandLocalExecError(response.error);
      }
    }
    throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE);
  }

  async openDownloadStream(ctx, _agentId, boxPath, { chunkBytes = DEFAULT_TRANSFER_CHUNK_BYTES, maxBytes } = {}) {
    const { computerId, permissionMachineId } = this.requireUsableComputer(ctx, 'download');
    const limit = this.effectiveMaxFileBytes(maxBytes);
    if (!this.supportsChunkedTransfer(computerId)) {
      // Legacy unpatched desktop client: fall back to single-frame download.
      const whole = await this.downloadFile(ctx, _agentId, boxPath);
      if (whole.byteLength > limit) {
        throw new SandLocalExecError(`File exceeds local-exec size limit (${whole.byteLength} > ${limit})`);
      }
      return {
        totalBytes: whole.byteLength,
        async *chunks() {
          for (let offset = 0; offset < whole.byteLength; offset += chunkBytes) {
            ctx?.signal?.throwIfAborted();
            yield whole.subarray(offset, Math.min(whole.byteLength, offset + chunkBytes));
          }
        },
      };
    }

    const step = Math.max(64 * 1024, Math.floor(chunkBytes));
    const transferId = randomUUID();
    const first = await this.sendFileTransferFrame(
      ctx,
      { kind: 'file-read-chunk', transferId, path: boxPath, offset: 0, length: step },
      'download',
      { computerId, permissionMachineId },
    );
    const totalBytes = first.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
      throw new SandLocalExecError('Invalid local-exec file metadata');
    }
    if (totalBytes > limit) {
      throw new SandLocalExecError(`File exceeds local-exec size limit (${totalBytes} > ${limit})`);
    }
    const identity = first.identity;
    const firstChunk = first.bytesBase64 ? Buffer.from(first.bytesBase64, 'base64') : Buffer.alloc(0);
    if (firstChunk.length > step || (totalBytes > 0 && firstChunk.length === 0)) {
      throw new SandLocalExecError('Invalid local-exec file chunk');
    }
    const self = this;
    return {
      totalBytes,
      identity,
      async *chunks() {
        let offset = 0;
        if (firstChunk.length > 0) {
          offset += firstChunk.length;
          yield firstChunk;
        }
        while (offset < totalBytes) {
          ctx?.signal?.throwIfAborted();
          const want = Math.min(step, totalBytes - offset);
          const part = await self.sendFileTransferFrame(
            ctx,
            { kind: 'file-read-chunk', transferId, path: boxPath, offset, length: want },
            'download',
            { computerId, permissionMachineId },
          );
          if (part.identity !== identity || part.size !== totalBytes) {
            throw new SandLocalExecError('Local file changed during transfer');
          }
          const chunk = part.bytesBase64 ? Buffer.from(part.bytesBase64, 'base64') : Buffer.alloc(0);
          if (chunk.length === 0 || chunk.length > want) {
            throw new SandLocalExecError('Incomplete or invalid local-exec file chunk');
          }
          offset += chunk.length;
          yield chunk;
        }
      },
    };
  }

  async uploadFileStream(ctx, _agentId, boxPath, chunkIterable, {
    expectedBytes,
    getExpectedDigest,
    chunkBytes = DEFAULT_TRANSFER_CHUNK_BYTES,
    maxBytes,
  } = {}) {
    const { computerId, permissionMachineId } = this.requireUsableComputer(ctx, 'upload');
    const limit = this.effectiveMaxFileBytes(maxBytes);
    if (expectedBytes !== undefined && expectedBytes > limit) {
      throw new SandLocalExecError(`File exceeds local-exec size limit (${expectedBytes} > ${limit})`);
    }
    if (!this.supportsChunkedTransfer(computerId)) {
      // Legacy unpatched desktop client: coalesce and send single upload frame.
      const parts = [];
      let total = 0;
      for await (const raw of chunkIterable) {
        ctx?.signal?.throwIfAborted();
        if (!raw || raw.byteLength === 0) continue;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        total += buf.length;
        if (total > limit) {
          throw new SandLocalExecError(`File exceeds local-exec size limit (${total} > ${limit})`);
        }
        parts.push(buf);
      }
      await this.uploadFile(ctx, _agentId, boxPath, Buffer.concat(parts, total));
      return;
    }

    const transferId = randomUUID();
    const step = Math.max(64 * 1024, Math.floor(chunkBytes));
    await this.sendFileTransferFrame(
      ctx,
      {
        kind: 'file-write-begin',
        transferId,
        path: boxPath,
        ...(expectedBytes !== undefined ? { totalSize: expectedBytes } : {}),
      },
      'upload',
      { computerId, permissionMachineId },
    );

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
          if (offset + slice.length > limit) {
            throw new SandLocalExecError(`File exceeds local-exec size limit (${offset + slice.length} > ${limit})`);
          }
          hash.update(slice);
          await this.sendFileTransferFrame(
            ctx,
            {
              kind: 'file-write-chunk',
              transferId,
              offset,
              bytesBase64: slice.toString('base64'),
            },
            'upload',
            { computerId, permissionMachineId },
          );
          offset += slice.length;
        }
      }
      ctx?.signal?.throwIfAborted();
      const actualSha256 = hash.digest('hex');
      const expectedSummary = getExpectedDigest?.();
      if (expectedSummary?.sha256 && expectedSummary.sha256 !== actualSha256) {
        throw new SandLocalExecError(`Transfer SHA-256 mismatch before commit (${actualSha256} != ${expectedSummary.sha256})`);
      }
      if (expectedBytes !== undefined && offset !== expectedBytes) {
        throw new SandLocalExecError(`Transfer byte count mismatch (${offset} != ${expectedBytes})`);
      }
      await this.sendFileTransferFrame(
        ctx,
        {
          kind: 'file-write-commit',
          transferId,
          expectedSha256: actualSha256,
          expectedBytes: offset,
        },
        'upload',
        { computerId, permissionMachineId },
      );
    } catch (error) {
      await this.sendFileTransferFrame(
        {},
        { kind: 'file-write-abort', transferId },
        'upload',
        { computerId, permissionMachineId },
      ).catch(() => {});
      throw error;
    }
  }

  async uploadFile(ctx, _agentId, boxPath, data) {
    const limit = this.effectiveMaxFileBytes();
    if (data.length > limit) {
      throw new SandLocalExecError(`File exceeds local-exec size limit (${data.length} > ${limit})`);
    }
    const { computerId, permissionMachineId } = this.requireUsableComputer(ctx, 'upload');
    if (this.supportsChunkedTransfer(computerId) && data.length > DEFAULT_TRANSFER_CHUNK_BYTES) {
      async function* chunks() {
        for (let offset = 0; offset < data.length; offset += DEFAULT_TRANSFER_CHUNK_BYTES) {
          yield data.subarray(offset, Math.min(data.length, offset + DEFAULT_TRANSFER_CHUNK_BYTES));
        }
      }
      await this.uploadFileStream(ctx, _agentId, boxPath, chunks(), { expectedBytes: data.length });
      return;
    }
    for await (const frame of this.bridge.request(
      ctx,
      { kind: 'upload', path: boxPath, bytesBase64: Buffer.from(data).toString('base64') },
      computerId,
      { permissionMachineId },
    )) {
      if (frame.kind === 'file') return;
      if (frame.kind === 'file-error') throw new SandLocalExecError(frame.error);
    }
    throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE);
  }

  async downloadFile(ctx, _agentId, boxPath) {
    const { computerId, permissionMachineId } = this.requireUsableComputer(ctx, 'download');
    if (this.supportsChunkedTransfer(computerId)) {
      const stream = await this.openDownloadStream(ctx, _agentId, boxPath);
      const parts = [];
      let total = 0;
      for await (const chunk of stream.chunks()) {
        parts.push(chunk);
        total += chunk.length;
      }
      return new Uint8Array(Buffer.concat(parts, total));
    }
    for await (const frame of this.bridge.request(
      ctx,
      { kind: 'download', path: boxPath },
      computerId,
      { permissionMachineId },
    )) {
      if (frame.kind === 'file') {
        const bytes = new Uint8Array(Buffer.from(frame.bytesBase64 ?? '', 'base64'));
        const limit = this.effectiveMaxFileBytes();
        if (bytes.byteLength > limit) {
          throw new SandLocalExecError(`File exceeds local-exec size limit (${bytes.byteLength} > ${limit})`);
        }
        return bytes;
      }
      if (frame.kind === 'file-error') throw new SandLocalExecError(frame.error);
    }
    throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE);
  }
}

export function createBridgeUserComputers(bridge, gate, reportFailure, library) {
  return {
    list: () => bridge.listComputers().map((computer) => ({
      id: computer.id,
      label: computer.label,
      kind: computer.kind,
      connected: computer.connected,
    })),
    resolve: (id) => {
      const match = id === undefined
        ? bridge.activeComputer()
        : bridge.listComputers().find((computer) => computer.id === id);
      if (match === undefined) return undefined;
      const box = new GatewayLocalExecSandBox(bridge, {
        gate,
        computerId: match.id,
        reportFailure,
        library,
      });
      return {
        id: match.id,
        label: match.label,
        box,
        terminalsFolder: () => box.getTerminalsFolder(),
      };
    },
  };
}

export function createLocalExecBridge({ clock = Date, gate, logs, onComputerAttached, library } = {}) {
  const providers = new Set();
  const byId = new Map();
  const pendingRequests = new Map();
  let everRegistered = false;
  let emptySince = clock.now();

  const bridge = {
    providers,
    byId,
    registerProvider(send) {
      const now = clock.now();
      const provider = {
        id: randomUUID(),
        registeredAt: now,
        hadHello: false,
        computerIdPresent: false,
        computerId: undefined,
        label: undefined,
        terminalsFolder: undefined,
        messagesOp: false,
        lastSeenAt: now,
        hasHeartbeat: false,
        supervised: undefined,
        variant: undefined,
        send,
        requests: new Set(),
      };
      providers.add(provider);
      byId.set(provider.id, provider);
      everRegistered = true;
      logs?.reportLocalExecProvider?.({
        phase: 'registered',
        providerId: provider.id,
        providerCount: providers.size,
      });
      try {
        send({ kind: 'welcome', providerId: provider.id });
      } catch {}
      onComputerAttached?.();
      return () => {
        if (!providers.delete(provider)) return;
        byId.delete(provider.id);
        for (const reqId of provider.requests) {
          const entry = pendingRequests.get(reqId);
          if (entry) {
            entry.queue.close();
            pendingRequests.delete(reqId);
          }
        }
        const detachedAt = clock.now();
        if (providers.size === 0) emptySince = detachedAt;
        logs?.reportLocalExecProvider?.({
          phase: 'detached',
          providerId: provider.id,
          providerCount: providers.size,
          ageMs: detachedAt - provider.registeredAt,
          hadHello: provider.hadHello,
          hasHeartbeat: provider.hasHeartbeat,
          wasLive: bridge.isLive(provider, detachedAt),
          emptied: providers.size === 0,
        });
      };
    },

    submitResponses(batch) {
      const provider = bridge.providerForBatch(batch?.providerId);
      if (provider === undefined) return;
      for (const frame of batch?.frames ?? []) {
        if (frame.kind === 'hello') {
          const rehello = provider.hadHello;
          provider.hadHello = true;
          if (frame.computerId !== undefined && frame.computerId.length > 0) {
            provider.computerIdPresent = true;
            provider.computerId = frame.computerId;
          }
          if (frame.label !== undefined && frame.label.length > 0) {
            provider.label = frame.label;
          }
          if (frame.terminalsFolder !== undefined && frame.terminalsFolder.length > 0) {
            provider.terminalsFolder = frame.terminalsFolder;
          }
          if (frame.capabilities?.messagesOp !== undefined) {
            provider.messagesOp = frame.capabilities.messagesOp === true;
          }
          if (frame.supervised !== undefined) provider.supervised = frame.supervised;
          if (frame.variant !== undefined && frame.variant.length > 0) {
            provider.variant = frame.variant;
          }
          provider.lastSeenAt = clock.now();
          logs?.reportLocalExecProvider?.({
            phase: 'hello',
            providerId: provider.id,
            providerCount: providers.size,
            helloDelayMs: provider.lastSeenAt - provider.registeredAt,
            computerIdPresent: provider.computerIdPresent,
            rehello,
          });
        } else if (frame.kind === 'ping') {
          provider.hasHeartbeat = true;
          provider.lastSeenAt = clock.now();
          if (frame.supervised !== undefined) provider.supervised = frame.supervised;
        } else if (frame.requestId) {
          provider.lastSeenAt = clock.now();
          const pending = pendingRequests.get(frame.requestId);
          if (pending) {
            pending.queue.push(frame);
            if (
              frame.kind === 'file' ||
              frame.kind === 'file-error' ||
              frame.kind === 'messages-result' ||
              frame.kind === 'messages-error' ||
              (frame.kind === 'client' && frame.message?.rokbotFileTransfer === true)
            ) {
              pending.queue.close();
              pendingRequests.delete(frame.requestId);
              provider.requests.delete(frame.requestId);
            }
          }
        }
      }
    },

    providerForBatch(providerId) {
      if (providerId !== undefined) {
        const exact = byId.get(providerId);
        if (exact !== undefined) return exact;
      }
      return [...providers].at(-1);
    },

    hasProvider() {
      return providers.size > 0;
    },

    providerComputerId(provider) {
      return provider.computerId ?? DEFAULT_SAND_COMPUTER_ID;
    },

    isLive(provider, now = clock.now()) {
      if (!provider.hasHeartbeat) return true;
      return now - provider.lastSeenAt <= SAND_LOCAL_EXEC_LIVENESS_WINDOW_MS;
    },

    liveProviders() {
      const now = clock.now();
      return [...providers].filter((provider) => bridge.isLive(provider, now));
    },

    best(candidates) {
      let best;
      for (const provider of candidates) {
        if (best === undefined) {
          best = provider;
          continue;
        }
        const rank = localExecProviderRank(provider);
        const bestRank = localExecProviderRank(best);
        if (rank > bestRank || (rank === bestRank && provider.lastSeenAt >= best.lastSeenAt)) {
          best = provider;
        }
      }
      return best;
    },

    resolveProvider(computerId, live = bridge.liveProviders()) {
      const matching = computerId === undefined
        ? live
        : live.filter((provider) => bridge.providerComputerId(provider) === computerId);
      return bridge.best(matching);
    },

    isComputerLive(computerId) {
      return bridge.resolveProvider(computerId) !== undefined;
    },

    requireProvider(computerId, reqGate = { site: 'exec' }, allowImplicitSelection = false) {
      if (computerId === undefined && !allowImplicitSelection && bridge.listComputers().length > 1) {
        bridge.reportRefused('computer_ambiguous', reqGate);
        throw new SandLocalExecError(SAND_MACHINE_ID_REQUIRED_MESSAGE);
      }
      const live = reqGate.site === 'messages-op'
        ? bridge.liveProviders().filter((provider) => provider.messagesOp === true)
        : bridge.liveProviders();
      const provider = bridge.resolveProvider(computerId, live);
      if (provider !== undefined) return provider;
      if (providers.size === 0) {
        bridge.reportRefused('no_providers', reqGate);
        throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE);
      }
      if (computerId !== undefined && !bridge.hasComputerId(computerId)) {
        bridge.reportRefused('computer_unknown', reqGate);
        throw new SandLocalExecError(SAND_NO_LOCAL_MACHINE_MESSAGE);
      }
      bridge.reportRefused('stale_heartbeat', reqGate);
      throw new SandLocalExecError(`${bridge.routeLabel(computerId) ?? 'The local computer'} is currently unavailable.`);
    },

    assertComputerAvailable(computerId, reqGate = { site: 'exec' }, allowImplicitSelection = false) {
      return bridge.providerComputerId(bridge.requireProvider(computerId, reqGate, allowImplicitSelection));
    },

    checkLiveComputerForAsk(agentId) {
      if (bridge.resolveProvider(undefined) !== undefined) return true;
      bridge.reportRefused(providers.size === 0 ? 'no_providers' : 'stale_heartbeat', {
        site: 'ask_gate',
        agentId,
      });
      return false;
    },

    reportRefused(cause, reqGate) {
      logs?.reportLocalExecRefused?.({
        cause,
        site: reqGate?.site,
        ...(reqGate?.agentId !== undefined ? { conversationId: reqGate.agentId } : {}),
        providerCount: providers.size,
        liveProviderCount: bridge.liveProviders().length,
        everRegistered,
        ...(cause === 'no_providers' ? { emptyForMs: clock.now() - emptySince } : {}),
      });
    },

    listComputers() {
      const now = clock.now();
      const byComputerId = new Map();
      for (const provider of providers) {
        const id = bridge.providerComputerId(provider);
        const existing = byComputerId.get(id);
        if (existing === undefined || provider.lastSeenAt >= existing.lastSeenAt) {
          byComputerId.set(id, provider);
        }
      }
      return [...byComputerId.entries()].map(([id, provider]) => ({
        id,
        label: provider.label ?? 'this computer',
        kind: computerKindFor(id, provider),
        connected: bridge.isLive(provider, now),
      }));
    },

    activeComputer() {
      if (bridge.listComputers().length !== 1) return undefined;
      const provider = bridge.resolveProvider(undefined);
      if (provider === undefined) return undefined;
      const id = bridge.providerComputerId(provider);
      return {
        id,
        label: provider.label ?? 'this computer',
        kind: computerKindFor(id, provider),
        connected: true,
      };
    },

    hasComputerId(computerId) {
      for (const provider of providers) {
        if (bridge.providerComputerId(provider) === computerId) return true;
      }
      return false;
    },

    routeLabel(computerId) {
      if (computerId !== undefined) {
        for (const provider of providers) {
          if (bridge.providerComputerId(provider) === computerId) return provider.label ?? computerId;
        }
        return computerId;
      }
      return bridge.activeComputer()?.label;
    },

    getProviderInfo(computerId) {
      const provider = bridge.resolveProvider(computerId);
      if (provider === undefined) return undefined;
      return {
        computerId: bridge.providerComputerId(provider),
        label: provider.label ?? 'this computer',
        terminalsFolder: provider.terminalsFolder ?? FALLBACK_TERMINALS_FOLDER,
        variant: provider.variant,
        chunkedTransfer: typeof provider.variant === 'string' && provider.variant.includes(ROKBOT_CHUNKED_VARIANT_TOKEN),
      };
    },

    async *request(ctx, frame, computerId) {
      const provider = bridge.requireProvider(computerId, { site: frame.kind }, false);
      const requestId = randomUUID();
      const queue = new FrameQueue();
      pendingRequests.set(requestId, { queue, provider });
      provider.requests.add(requestId);
      const onAbort = () => {
        try { provider.send({ kind: 'cancel', requestId }); } catch {}
        queue.close();
      };
      ctx?.signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        if (ctx?.signal?.aborted) {
          queue.close();
          ctx.signal.throwIfAborted();
        }
        provider.send({ ...frame, requestId });
        for await (const responseFrame of queue) {
          yield responseFrame;
        }
      } finally {
        ctx?.signal?.removeEventListener?.('abort', onAbort);
        queue.close();
        pendingRequests.delete(requestId);
        provider.requests.delete(requestId);
      }
    },
  };

  bridge.userComputers = createBridgeUserComputers(bridge, gate, undefined, library);
  bridge.box = new GatewayLocalExecSandBox(bridge, {
    gate,
    library,
  });
  return bridge;
}

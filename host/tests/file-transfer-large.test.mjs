import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';

import {
  DEFAULT_TRANSFER_CHUNK_BYTES,
  DEFAULT_TRANSFER_TIMEOUT_MS,
  ROKBOT_CHUNKED_VARIANT_TOKEN,
  fileTransferPromptToolOverrides,
  resolveMaxTransferBytes,
  streamTransferBetweenBoxes,
  wrapBoxForFileTransferTool,
  wrapFileTransferPromptTools,
} from '../runtime/file-transfer.mjs';
import { createLocalExecBridge } from '../runtime/local-exec-bridge.mjs';
import { installRemoteBoxAdapter } from '../runtime/remote-box.mjs';

const run = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, '../..');
const EXTENSION_PATH = join(REPO_ROOT, 'windows/tools/desktop-recipes/extensions/local-exec-transfer.js');

async function loadDesktopTransferEnhancer() {
  const code = await readFile(EXTENSION_PATH, 'utf8');
  const req = createRequire(import.meta.url);
  const sandbox = {
    require: req,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(`${code}\nthis.__enhancer = rokbotEnhanceLocalExecProvider;`, sandbox);
  return sandbox.__enhancer;
}

function encodeVarint(value) {
  let n = BigInt(value);
  const out = [];
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function decodeExportFileRequest(buf) {
  let offset = 0;
  let filePath = '';
  let workspaceRootPath = '';
  while (offset < buf.length) {
    const tag = buf[offset++];
    const field = tag >> 3;
    let len = 0;
    let shift = 0;
    while (offset < buf.length) {
      const b = buf[offset++];
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const str = buf.subarray(offset, offset + len).toString('utf8');
    offset += len;
    if (field === 1) filePath = str;
    if (field === 2) workspaceRootPath = str;
  }
  return { filePath, workspaceRootPath };
}

function connectEnvelope(flags, payload) {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out[0] = flags;
  out.writeUInt32BE(payload.length, 1);
  payload.copy(out, 5);
  return out;
}

/** Minimal Connect ExportFile server backed by real disk files (64 KiB streaming chunks). */
async function startExportFileServer({ rootDir, token = 'test-box-token', corruptAtByte = -1 }) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/agent.v1.ControlService/ExportFile')) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const bodyChunks = [];
    for await (const c of req) bodyChunks.push(Buffer.from(c));
    const body = Buffer.concat(bodyChunks);
    const len = body.readUInt32BE(1);
    const { filePath } = decodeExportFileRequest(body.subarray(5, 5 + len));
    const diskPath = filePath.startsWith('/workspace/')
      ? join(rootDir, filePath.slice('/workspace/'.length))
      : filePath;

    let handle;
    try {
      handle = await open(diskPath, 'r');
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      const endPayload = Buffer.from(JSON.stringify({
        error: { code: err.code === 'ENOENT' ? 'not_found' : 'internal', message: err.message },
      }));
      res.end(connectEnvelope(0x02, endPayload));
      return;
    }

    try {
      const st = await handle.stat();
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      // Metadata message: field 2 (0x12) -> embedded field 1 (0x08) varint total_bytes
      const metaInner = Buffer.concat([Buffer.from([0x08]), encodeVarint(st.size)]);
      const metaMsg = Buffer.concat([Buffer.from([0x12]), encodeVarint(metaInner.length), metaInner]);
      res.write(connectEnvelope(0x00, metaMsg));

      const buf = Buffer.allocUnsafe(64 * 1024);
      let sent = 0;
      while (sent < st.size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, st.size - sent), sent);
        if (bytesRead === 0) break;
        const slice = Buffer.from(buf.subarray(0, bytesRead));
        if (corruptAtByte >= sent && corruptAtByte < sent + bytesRead) {
          slice[corruptAtByte - sent] ^= 0xff;
        }
        const chunkMsg = Buffer.concat([Buffer.from([0x0a]), encodeVarint(slice.length), slice]);
        if (!res.write(connectEnvelope(0x00, chunkMsg))) {
          await new Promise((r) => res.once('drain', r));
        }
        sent += bytesRead;
      }
      res.end(connectEnvelope(0x02, Buffer.from('{}')));
    } finally {
      await handle.close();
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return {
    port: server.address().port,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** Write a deterministic file of `totalBytes` with distinct per-block data and return its SHA-256. */
async function createTestFile(filePath, totalBytes) {
  const blockSize = 4 * 1024 * 1024;
  const seed = randomBytes(blockSize);
  const hash = createHash('sha256');
  const out = createWriteStream(filePath);
  let remaining = totalBytes;
  let blockIndex = 0;
  while (remaining > 0) {
    const take = Math.min(blockSize, remaining);
    const chunk = Buffer.from(seed.subarray(0, take));
    if (take >= 8) chunk.writeUInt32LE(blockIndex, 0);
    hash.update(chunk);
    if (!out.write(chunk)) {
      await new Promise((r) => out.once('drain', r));
    }
    remaining -= take;
    blockIndex += 1;
  }
  await new Promise((resolveEnd, rejectEnd) => {
    out.once('error', rejectEnd);
    out.end(resolveEnd);
  });
  return hash.digest('hex');
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** Build a real enhanced Desktop Provider wired to createLocalExecBridge(). */
async function createWiredDesktopBridge({ rootDir, isLocalUseBlocked, maxFileBytes, env }) {
  const enhance = await loadDesktopTransferEnhancer();
  const bridge = createLocalExecBridge();

  // Mirrors upstream dist/local-exec-daemon/main.cjs Provider + nm executor shape.
  class MockUpstreamProvider {
    constructor(options) {
      this.options = options;
      const defaultCap = 100 * 1024 * 1024;
      const cap = options.maxFileBytes ?? defaultCap;
      this.executor = {
        root: options.root,
        terminalsFolder: join(options.root, 'terminals'),
        maxFileBytes: cap,
        maxUploadFrameBytes: Math.ceil(cap * 4 / 3) + 64 * 1024,
        options,
        execManager: { readMaxFileBytes: cap },
      };
      this.dispatchedFallback = [];
    }
    enqueue(frame) {
      this.postBatch([frame]);
    }
    postBatch(frames) {
      bridge.submitResponses({ providerId: this.providerId, frames });
    }
    dispatchEventBlock(block) {
      this.dispatchedFallback.push(block);
    }
    close() {
      this.closed = true;
    }
  }

  const EnhancedProvider = enhance(MockUpstreamProvider);
  const provider = new EnhancedProvider({
    root: rootDir,
    computerId: 'mac-test-1',
    computerLabel: 'Test Mac',
    ...(maxFileBytes !== undefined ? { maxFileBytes } : {}),
    ...(isLocalUseBlocked ? { isLocalUseBlocked } : {}),
  });

  const detach = bridge.registerProvider((frame) => {
    if (frame.kind === 'welcome') {
      provider.providerId = frame.providerId;
      provider.postBatch([{
        kind: 'hello',
        localRoot: rootDir,
        terminalsFolder: join(rootDir, 'terminals'),
        computerId: 'mac-test-1',
        label: 'Test Mac',
      }]);
      return;
    }
    queueMicrotask(() => {
      provider.dispatchEventBlock(`data: ${JSON.stringify(frame)}`);
    });
  });

  const resolved = bridge.userComputers.resolve('mac-test-1');
  if (env) resolved.box.env = env;
  return { bridge, provider, desktopBox: resolved.box, detach };
}

/** Build a real RemoteBox wired to disk via WriteArgs + python3 shell + ExportFile HTTP server. */
function createWiredRemoteBox({ workspaceDir, exportPort, token = 'test-box-token', env = {}, corruptWrite = false }) {
  const shellExecutorResource = Symbol('shell');
  const writeExecutorResource = Symbol('write');
  const mapWorkspacePath = (p) => (p === '/workspace'
    ? workspaceDir
    : p.startsWith('/workspace/')
      ? join(workspaceDir, p.slice('/workspace/'.length))
      : p);

  class WriteArgs {
    constructor(init) { Object.assign(this, init); }
  }
  class BoxFileUnreadableError extends Error {}

  let writeCalls = 0;
  class LoopbackSandBox {
    constructor(options) { this.options = options; }
    async assertFileReadAllowed() {}
    primaryEndpoint() {
      return exportPort ? { host: '127.0.0.1', port: exportPort, authToken: token, headers: {} } : null;
    }
    async ensureReady() {
      return {
        remoteAccessor: {
          get: (resource) => {
            if (resource === writeExecutorResource) {
              return {
                execute: async (_ctx, args) => {
                  writeCalls += 1;
                  const target = mapWorkspacePath(args.path);
                  const buf = Buffer.from(args.fileBytes);
                  if (corruptWrite && writeCalls === 1 && buf.length > 0) {
                    buf[0] ^= 0xff;
                  }
                  await writeFile(target, buf);
                  return { result: { case: 'success', value: {} } };
                },
              };
            }
            if (resource === shellExecutorResource) {
              return {
                execute: async (_ctx, args) => {
                  // Translate /workspace paths in commands to temp workspaceDir on host disk.
                  const translated = args.command.replaceAll("'/workspace", `'${workspaceDir}`);
                  try {
                    const { stdout, stderr } = await run('sh', ['-c', translated], { maxBuffer: 4 * 1024 * 1024 });
                    return { result: { case: 'success', value: { exitCode: 0, stdout, stderr } } };
                  } catch (error) {
                    if (error.code === undefined) throw error;
                    return { result: { case: 'success', value: { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } } };
                  }
                },
              };
            }
            return null;
          },
        },
      };
    }
  }

  const bindings = { LoopbackSandBox, buildHostShellArgs: (args) => args };
  const status = installRemoteBoxAdapter(
    bindings,
    { shellExecutorResource, writeExecutorResource, WriteArgs, BoxFileUnreadableError },
    { ROKBOT_BOX_HOST: '127.0.0.1', ROKBOT_BOX_TOKEN: token, ...env },
  );
  return { box: bindings.createSandBox({}), status, BoxFileUnreadableError, mapWorkspacePath };
}

test('300 MiB round-trip CopyToBox and CopyFromBox stream in bounded memory with SHA-256 verification', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'rokbot-300m-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const desktopRoot = join(workDir, 'desktop');
  const boxWorkspace = join(workDir, 'box-workspace');
  await writeFile(join(workDir, '.keep'), '');
  await run('mkdir', ['-p', desktopRoot, join(boxWorkspace, 'uploads')]);

  const FILE_BYTES = 300 * 1024 * 1024;
  const sourceLocalPath = join(desktopRoot, 'large-300m.bin');
  const returnedLocalPath = join(desktopRoot, 'roundtrip-300m.bin');
  const boxPath = '/workspace/uploads/large-300m.bin';

  const expectedSha256 = await createTestFile(sourceLocalPath, FILE_BYTES);

  const exportServer = await startExportFileServer({ rootDir: boxWorkspace });
  t.after(() => exportServer.close());

  const { bridge, provider, desktopBox, detach } = await createWiredDesktopBridge({ rootDir: desktopRoot });
  t.after(() => { detach(); provider.close(); });

  // Verify hello advertised chunked transfer capability and Read cap stayed at 100 MiB.
  assert.equal(desktopBox.supportsChunkedTransfer(), true);
  assert.ok(bridge.getProviderInfo('mac-test-1').variant.includes(ROKBOT_CHUNKED_VARIANT_TOKEN));
  assert.equal(provider.executor.execManager.readMaxFileBytes, 100 * 1024 * 1024);
  assert.equal(provider.executor.maxFileBytes, Infinity);

  const { box: remoteBox, mapWorkspacePath } = createWiredRemoteBox({
    workspaceDir: boxWorkspace,
    exportPort: exportServer.port,
  });

  // Simulate upstream CopyToBox / CopyFromBox tool builder + transferFileBetweenBoxes with its 256 MiB cap intact.
  const UPSTREAM_DEFAULT_BOX_TRANSFER_MAX_BYTES = 256 * 1024 * 1024;
  async function upstreamTransferFileBetweenBoxes(ctx, { source, dest }) {
    const data = await source.box.downloadFile(ctx, source.agentId, source.path);
    if (data.byteLength > UPSTREAM_DEFAULT_BOX_TRANSFER_MAX_BYTES) {
      throw new Error(`too_large: ${data.byteLength} > ${UPSTREAM_DEFAULT_BOX_TRANSFER_MAX_BYTES}`);
    }
    await dest.box.uploadFile(ctx, dest.agentId, dest.path, data);
    return data.byteLength;
  }

  let capturedController;
  const fakeBuilder = {
    names: ['CopyToBox', 'CopyFromBox'],
    build(context) {
      capturedController = context.machines.fileTransferController;
      return [
        { name: 'CopyToBox', descriptionGenerator: () => 'Copy a file up to 100 MiB' },
        { name: 'CopyFromBox', descriptionGenerator: () => 'Copy a file up to 100 MiB' },
      ];
    },
  };
  const wrappedBindings = wrapFileTransferPromptTools({
    TURN_TOOL_BUILDERS: [fakeBuilder],
    TURN_TOOL_BUILDERS_BY_VOLATILITY: [fakeBuilder],
    sandToolCallExecutionTimeoutMs: () => 120_000,
  });

  // Timeout extended for file transfer tools, untouched for others.
  assert.equal(wrappedBindings.sandToolCallExecutionTimeoutMs('CopyToBox'), DEFAULT_TRANSFER_TIMEOUT_MS);
  assert.equal(wrappedBindings.sandToolCallExecutionTimeoutMs('CopyFromBox'), DEFAULT_TRANSFER_TIMEOUT_MS);
  assert.equal(wrappedBindings.sandToolCallExecutionTimeoutMs('Read'), 120_000);

  const tools = wrappedBindings.TURN_TOOL_BUILDERS[0].build({
    machines: {
      fileTransferController: {
        agentBox: remoteBox,
        userComputers: bridge.userComputers,
      },
    },
  });
  assert.equal(tools[0].descriptionGenerator(), 'Copy a file of any size');
  assert.equal(tools[1].descriptionGenerator(), 'Copy a file of any size');

  const wrappedDesktopBox = capturedController.userComputers.resolve('mac-test-1').box;
  const wrappedRemoteBox = capturedController.agentBox;

  const heapBefore = process.memoryUsage().heapUsed;
  let peakHeapDelta = 0;
  const sampler = setInterval(() => {
    const delta = process.memoryUsage().heapUsed - heapBefore;
    if (delta > peakHeapDelta) peakHeapDelta = delta;
  }, 50);

  try {
    // 1. CopyToBox: 300 MiB Desktop -> Box
    const copiedToBoxBytes = await upstreamTransferFileBetweenBoxes({}, {
      source: { box: wrappedDesktopBox, agentId: 'a1', path: sourceLocalPath },
      dest: { box: wrappedRemoteBox, agentId: 'b1', path: boxPath },
    });
    assert.equal(copiedToBoxBytes, FILE_BYTES);

    const boxDigest = await sha256File(mapWorkspacePath(boxPath));
    assert.equal(boxDigest.bytes, FILE_BYTES);
    assert.equal(boxDigest.sha256, expectedSha256);

    // Ensure no leftover .part or .chunk staging files on box.
    const uploadEntries = await readdir(join(boxWorkspace, 'uploads'));
    assert.deepEqual(uploadEntries, ['large-300m.bin']);

    // 2. CopyFromBox: 300 MiB Box (Connect ExportFile streaming) -> Desktop
    const copiedFromBoxBytes = await upstreamTransferFileBetweenBoxes({}, {
      source: { box: wrappedRemoteBox, agentId: 'b1', path: boxPath },
      dest: { box: wrappedDesktopBox, agentId: 'a1', path: returnedLocalPath },
    });
    assert.equal(copiedFromBoxBytes, FILE_BYTES);

    const returnedDigest = await sha256File(returnedLocalPath);
    assert.equal(returnedDigest.bytes, FILE_BYTES);
    assert.equal(returnedDigest.sha256, expectedSha256);

    // Ensure no leftover .part files on desktop.
    const desktopEntries = (await readdir(desktopRoot)).sort();
    assert.deepEqual(desktopEntries, ['large-300m.bin', 'roundtrip-300m.bin']);
  } finally {
    clearInterval(sampler);
  }

  // Peak JS heap growth must remain well below the 300 MiB file size (bounded streaming).
  assert.ok(
    peakHeapDelta < 128 * 1024 * 1024,
    `Expected bounded heap growth < 128 MiB for 300 MiB round-trip, got ${(peakHeapDelta / (1024 * 1024)).toFixed(1)} MiB`,
  );
});

test('SHA-256 verification rejects corrupted transfers and removes partial files in both directions', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'rokbot-corrupt-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const desktopRoot = join(workDir, 'desktop');
  const boxWorkspace = join(workDir, 'box-workspace');
  await run('mkdir', ['-p', desktopRoot, join(boxWorkspace, 'uploads')]);

  const samplePath = join(desktopRoot, 'sample.bin');
  const sampleBytes = 5 * 1024 * 1024;
  await createTestFile(samplePath, sampleBytes);

  const { provider, desktopBox, detach } = await createWiredDesktopBridge({ rootDir: desktopRoot });
  t.after(() => { detach(); provider.close(); });

  // Case 1: Box write corrupted -> CopyToBox rejects and leaves no target or .part/.chunk files.
  const { box: corruptBox } = createWiredRemoteBox({ workspaceDir: boxWorkspace, corruptWrite: true });
  await assert.rejects(
    streamTransferBetweenBoxes({}, {
      sourceBox: desktopBox,
      sourceAgentId: 'a1',
      sourcePath: samplePath,
      destBox: corruptBox,
      destAgentId: 'b1',
      destPath: '/workspace/uploads/corrupted.bin',
    }),
    /integrity mismatch|failed/i,
  );
  assert.deepEqual(await readdir(join(boxWorkspace, 'uploads')), []);

  // Case 2: Desktop commit receives wrong expectedSha256 -> rejects and removes .part file.
  const boxSource = join(boxWorkspace, 'uploads/good.bin');
  await createTestFile(boxSource, sampleBytes);
  const exportServer = await startExportFileServer({ rootDir: boxWorkspace });
  t.after(() => exportServer.close());
  const { box: goodBox } = createWiredRemoteBox({ workspaceDir: boxWorkspace, exportPort: exportServer.port });

  const destCorruptDesktop = join(desktopRoot, 'bad-commit.bin');
  const stream = await goodBox.openDownloadStream({}, 'b1', '/workspace/uploads/good.bin');
  await assert.rejects(
    desktopBox.uploadFileStream({}, 'a1', destCorruptDesktop, stream.chunks(), {
      expectedBytes: sampleBytes,
      getExpectedDigest: () => ({ bytes: sampleBytes, sha256: '0'.repeat(64) }),
    }),
    /SHA-256 mismatch/i,
  );
  assert.deepEqual((await readdir(desktopRoot)).sort(), ['sample.bin']);
});

test('ROKBOT_MAX_TRANSFER_BYTES defaults to unlimited and enforces opt-in limit when set', async (t) => {
  assert.equal(resolveMaxTransferBytes({}), Infinity);
  assert.equal(resolveMaxTransferBytes({ ROKBOT_MAX_TRANSFER_BYTES: '' }), Infinity);
  assert.equal(resolveMaxTransferBytes({ ROKBOT_MAX_TRANSFER_BYTES: '0' }), Infinity);
  assert.equal(resolveMaxTransferBytes({ ROKBOT_MAX_TRANSFER_BYTES: 'unlimited' }), Infinity);
  assert.equal(resolveMaxTransferBytes({ ROKBOT_MAX_TRANSFER_BYTES: '1048576' }), 1048576);

  const workDir = await mkdtemp(join(tmpdir(), 'rokbot-limit-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const desktopRoot = join(workDir, 'desktop');
  const boxWorkspace = join(workDir, 'box-workspace');
  await run('mkdir', ['-p', desktopRoot, join(boxWorkspace, 'uploads')]);

  const bigFile = join(desktopRoot, 'over-limit.bin');
  const smallFile = join(desktopRoot, 'under-limit.bin');
  await createTestFile(bigFile, 1536 * 1024); // 1.5 MiB
  const smallSha = await createTestFile(smallFile, 512 * 1024); // 512 KiB

  const limitEnv = { ROKBOT_MAX_TRANSFER_BYTES: String(1024 * 1024) }; // 1 MiB
  const prevEnv = process.env.ROKBOT_MAX_TRANSFER_BYTES;
  process.env.ROKBOT_MAX_TRANSFER_BYTES = limitEnv.ROKBOT_MAX_TRANSFER_BYTES;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.ROKBOT_MAX_TRANSFER_BYTES;
    else process.env.ROKBOT_MAX_TRANSFER_BYTES = prevEnv;
  });

  const { provider, desktopBox, detach } = await createWiredDesktopBridge({ rootDir: desktopRoot, env: limitEnv });
  t.after(() => { detach(); provider.close(); });
  const { box: remoteBox, mapWorkspacePath } = createWiredRemoteBox({ workspaceDir: boxWorkspace, env: limitEnv });

  await assert.rejects(
    streamTransferBetweenBoxes({}, {
      sourceBox: desktopBox,
      sourceAgentId: 'a1',
      sourcePath: bigFile,
      destBox: remoteBox,
      destAgentId: 'b1',
      destPath: '/workspace/uploads/over-limit.bin',
      maxBytes: resolveMaxTransferBytes(limitEnv),
    }),
    /exceeds.*size limit/i,
  );

  const ok = await streamTransferBetweenBoxes({}, {
    sourceBox: desktopBox,
    sourceAgentId: 'a1',
    sourcePath: smallFile,
    destBox: remoteBox,
    destAgentId: 'b1',
    destPath: '/workspace/uploads/under-limit.bin',
    maxBytes: resolveMaxTransferBytes(limitEnv),
  });
  assert.equal(ok.bytes, 512 * 1024);
  assert.equal(ok.sha256, smallSha);
  assert.equal((await sha256File(mapWorkspacePath('/workspace/uploads/under-limit.bin'))).sha256, smallSha);
});

test('in-container LoopbackSandBox supports bounded openDownloadStream without ROKBOT_BOX_HOST', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'rokbot-incontainer-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const file = join(workDir, 'data.bin');
  const expectedSha = await createTestFile(file, 5 * 1024 * 1024 + 123);

  class LoopbackSandBox {
    async assertFileReadAllowed() {}
  }
  const bindings = { LoopbackSandBox, buildHostShellArgs: (a) => a };
  const result = installRemoteBoxAdapter(bindings, { BoxFileUnreadableError: Error }, {});
  assert.equal(result.mode, 'in-container');
  assert.equal(result.maxDownloadBytes, Infinity);

  const box = new LoopbackSandBox();
  const stream = await box.openDownloadStream({}, 'a1', file, { chunkBytes: DEFAULT_TRANSFER_CHUNK_BYTES });
  assert.equal(stream.totalBytes, 5 * 1024 * 1024 + 123);
  const hash = createHash('sha256');
  let count = 0;
  let chunks = 0;
  for await (const chunk of stream.chunks()) {
    hash.update(chunk);
    count += chunk.length;
    chunks += 1;
  }
  assert.equal(count, 5 * 1024 * 1024 + 123);
  assert.equal(hash.digest('hex'), expectedSha);
  assert.equal(chunks, 3);
});

test('all 1.3.0 and retained 1.2.3/0.71.2 desktop local-exec recipes carry local-exec-transfer.js verbatim', async () => {
  const extensionBytes = await readFile(EXTENSION_PATH);
  const recipeDirs = [
    'mac/patchers/desktop/recipes',
    'mac/patchers/desktop/1.2.3/recipes',
    'windows/patchers/desktop/recipes',
    'windows/patchers/desktop/1.2.3/recipes',
    'windows/patchers/desktop/0.71.2/recipes',
    'linux/patchers/desktop/x64/recipes',
    'linux/patchers/desktop/arm64/recipes',
  ];
  for (const relDir of recipeDirs) {
    const dir = join(REPO_ROOT, relDir);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const entry = manifest.files.find((f) => f.path === 'dist/local-exec-daemon/main.cjs');
    assert.ok(entry, `${relDir} must include dist/local-exec-daemon/main.cjs`);
    const gz = await readFile(join(dir, entry.recipe));
    assert.equal(gz[9], 0x03, `${relDir}/${entry.recipe} must normalize gzip OS byte`);
    assert.equal(createHash('sha256').update(gz).digest('hex'), entry.sha256);
    const recipe = JSON.parse(gunzipSync(gz).toString('utf8'));
    const added = Buffer.concat(recipe.ops.filter((op) => op[0] === 'add').map((op) => Buffer.from(op[1], 'base64')));
    assert.ok(added.includes(extensionBytes), `${relDir}/${entry.recipe} must carry local-exec-transfer.js verbatim`);
    assert.match(added.toString('utf8'), /Provider:rokbotEnhanceLocalExecProvider\([A-Za-z0-9_$]+\)/);
  }
});

test('multi-chunk CopyToBox consumes a one-time approval only once and keeps maxUploadFrameBytes floor', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'rokbot-approve-once-'));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const desktopRoot = join(workDir, 'desktop');
  const boxWorkspace = join(workDir, 'box-workspace');
  await run('mkdir', ['-p', desktopRoot, join(boxWorkspace, 'uploads')]);

  const samplePath = join(desktopRoot, 'multi-chunk.bin');
  const sampleBytes = 5 * 1024 * 1024 + 77;
  const expectedSha = await createTestFile(samplePath, sampleBytes);

  let authCalls = 0;
  const isLocalUseBlocked = async () => {
    authCalls += 1;
    // Simulate a one-time allow-once approval that rejects any 2nd check.
    return authCalls === 1 ? undefined : 'One-time approval already used';
  };

  const prevEnv = process.env.ROKBOT_MAX_TRANSFER_BYTES;
  process.env.ROKBOT_MAX_TRANSFER_BYTES = String(10 * 1024 * 1024); // 10 MiB opt-in limit
  t.after(() => {
    if (prevEnv === undefined) delete process.env.ROKBOT_MAX_TRANSFER_BYTES;
    else process.env.ROKBOT_MAX_TRANSFER_BYTES = prevEnv;
  });

  const { provider, desktopBox, detach } = await createWiredDesktopBridge({ rootDir: desktopRoot, isLocalUseBlocked });
  t.after(() => { detach(); provider.close(); });
  // Small opt-in ROKBOT_MAX_TRANSFER_BYTES must not shrink maxUploadFrameBytes below upstream's ~133 MiB floor.
  assert.ok(provider.executor.maxUploadFrameBytes >= 100 * 1024 * 1024);

  const { box: remoteBox, mapWorkspacePath } = createWiredRemoteBox({ workspaceDir: boxWorkspace });
  const result = await streamTransferBetweenBoxes({}, {
    sourceBox: desktopBox,
    sourceAgentId: 'a1',
    sourcePath: samplePath,
    destBox: remoteBox,
    destAgentId: 'b1',
    destPath: '/workspace/uploads/multi-chunk.bin',
  });
  assert.equal(result.bytes, sampleBytes);
  assert.equal(result.sha256, expectedSha);
  assert.equal(authCalls, 1, 'one-time read approval must be checked once per chunked transfer');
  assert.equal((await sha256File(mapWorkspacePath('/workspace/uploads/multi-chunk.bin'))).sha256, expectedSha);
});

test('fileTransferPromptToolOverrides wraps recovered sandToolCallExecutionTimeoutMs and ignores upstream maxBytes cap', async (t) => {
  const overrides = fileTransferPromptToolOverrides({});
  const wrappedTimeout = overrides.sandToolCallExecutionTimeoutMs(() => 120_000);
  assert.equal(wrappedTimeout('CopyToBox'), DEFAULT_TRANSFER_TIMEOUT_MS);
  assert.equal(wrappedTimeout('CopyFromBox'), DEFAULT_TRANSFER_TIMEOUT_MS);
  assert.equal(wrappedTimeout('Shell'), 120_000);

  let seenMaxBytes;
  const fakeBox = {
    async openDownloadStream(_ctx, _agentId, _path, opts) {
      seenMaxBytes = opts.maxBytes;
      return {
        totalBytes: 4,
        async *chunks() { yield Buffer.from('test'); },
      };
    },
    async uploadFileStream(_ctx, _agentId, _path, chunks) {
      for await (const _ of chunks) {}
    },
  };
  const wrapped = wrapBoxForFileTransferTool(fakeBox, {});
  // Even if upstream passes a hardcoded 100 MiB options.maxBytes, default unlimited transfer is preserved.
  const token = await wrapped.downloadFile({}, 'a1', '/tmp/big.bin', { maxBytes: 100 * 1024 * 1024 });
  assert.equal(seenMaxBytes, Infinity);
  await wrapped.uploadFile({}, 'b1', '/workspace/big.bin', token, { maxBytes: 100 * 1024 * 1024 });
  assert.equal(token.byteLength, 4);
});

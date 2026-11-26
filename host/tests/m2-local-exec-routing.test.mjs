import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { createLocalExecBridge, SandLocalExecError } from '../runtime/local-exec-bridge.mjs';
import { installDefaultMachineRouting } from '../runtime/host-computers.mjs';
import { installLocalHarnessBridge } from '../runtime/local-harness-bridge.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';
import { defaultPolicy } from '../runtime/model-policy.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');

function makeFakeLibrary() {
  const resources = new Map();
  class FakeRemoteResourceAccessor {
    constructor(execManager) {
      this.execManager = execManager;
    }
    get(resource) {
      return resource.remoteImplementation(this.execManager);
    }
  }
  const fakeShellResource = {
    name: 'shell-stream-executor',
    symbol: Symbol.for('@anysphere/agent-exec/resource/shell-stream-executor'),
    remoteImplementation(execManager) {
      return {
        async *execute(ctx, args, options) {
          for await (const msg of execManager.createExecInstance(ctx, (id) => ({
            id,
            shellStreamArgs: args,
            machineId: options?.machineId,
            toJson() {
              return {
                id,
                shellStreamArgs: args,
                ...(options?.machineId !== undefined ? { machineId: options.machineId } : {}),
              };
            },
          }))) {
            yield msg;
          }
        },
      };
    },
  };
  resources.set('shell', fakeShellResource);

  return {
    RemoteResourceAccessor: FakeRemoteResourceAccessor,
    sandLocalToolScopeKey: { symbol: Symbol('scope'), defaultValue: undefined },
    ExecClientMessage: {
      fromJson(json) {
        return json;
      },
    },
    ExecClientControlMessage: {
      fromJson(json) {
        const [k, v] = Object.entries(json ?? {})[0] ?? [];
        return { message: { case: k, value: v } };
      },
    },
    fakeShellResource,
  };
}

function registerFakeMac(bridge, { computerId, label, terminalsFolder }) {
  const framesSent = [];
  const unregister = bridge.registerProvider((frame) => {
    framesSent.push(frame);
  });
  const welcome = framesSent.find((f) => f.kind === 'welcome');
  assert.ok(welcome?.providerId, 'expected welcome frame with providerId');
  bridge.submitResponses({
    providerId: welcome.providerId,
    frames: [{
      kind: 'hello',
      computerId,
      label,
      terminalsFolder: terminalsFolder ?? `/tmp/${computerId}/terminals`,
      localRoot: '/tmp',
    }],
  });
  return {
    providerId: welcome.providerId,
    framesSent,
    respondExec(requestId, stdoutText) {
      bridge.submitResponses({
        providerId: welcome.providerId,
        frames: [
          { kind: 'client', requestId, message: { id: 0, shellStream: { stdout: { data: stdoutText } } } },
          { kind: 'client', requestId, message: { id: 0, shellStream: { exit: { code: 0 } } } },
          { kind: 'control', requestId, message: { streamClose: {} } },
        ],
      });
    },
    respondFile(requestId, data) {
      bridge.submitResponses({
        providerId: welcome.providerId,
        frames: [
          {
            kind: 'file',
            requestId,
            ...(data !== undefined ? { bytesBase64: Buffer.from(data).toString('base64') } : {}),
          },
        ],
      });
    },
    unregister,
  };
}

test('installLocalHarnessBridge wires box=localExec.box and remoteBox=foreverBox.box (never falling back)', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rokbot-routing-bridge-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const capturedRunnerOpts = [];
  class MockSendPipeline {}
  class MockTurnExecutionRegistry {}
  class MockSessionRuntime { constructor() { this.tm = {}; } }
  class MockTranscriptManager {
    constructor() {
      this.sessions = new MockSessionRuntime();
      this.roster = { emit: () => {}, emitAgentUpdate: async () => {} };
    }
  }
  const fakeLibrary = {
    ...makeFakeLibrary(),
    getHostFlowRecoveryBindings: () => ({ SendPipeline: MockSendPipeline, TurnExecutionRegistry: MockTurnExecutionRegistry }),
    getHostExecutionRecoveryBindings: () => ({ TranscriptManager: MockTranscriptManager }),
    getHostSessionRecoveryBindings: () => ({ SessionRuntime: MockSessionRuntime }),
    getHostKernelRecoveryBindings: () => ({}),
    getPromptToolsRecoveryBindings: () => ({ defaultSandRunnerGates: () => ({}) }),
    ConversationStateStructure: class ConversationStateStructure {},
    MemoryFolderView: class MemoryFolderView {},
    SandAgentRunner: class FakeRunner {
      constructor(opts) {
        capturedRunnerOpts.push(opts);
      }
    },
  };

  const sandboxBox = { kind: 'docker-sandbox' };
  const localExecBridge = createLocalExecBridge({ library: fakeLibrary });

  installLocalHarnessBridge(fakeLibrary, {
    extensions: (id) => {
      if (id === 'forever-box') return { box: sandboxBox };
      if (id === 'local-exec') return localExecBridge;
      return undefined;
    },
  });

  const tm = new MockTranscriptManager();
  tm.sessionStore = { getAgentDir: () => dataDir };
  const registry = tm.ensureRunnerRegistry({
    extensions: (id) => {
      if (id === 'forever-box') return { box: sandboxBox };
      if (id === 'local-exec') return localExecBridge;
      return undefined;
    },
  });

  registry.getRunner({ id: 'agent-1', db: { isOpen: true }, agentStore: {} });
  assert.equal(capturedRunnerOpts.length, 1);
  assert.equal(capturedRunnerOpts[0].box, localExecBridge.box, 'host.box must be localExec.box');
  assert.notEqual(capturedRunnerOpts[0].box, sandboxBox, 'host.box must NEVER be forever-box sandbox');
  assert.equal(capturedRunnerOpts[0].remoteBox, sandboxBox, 'remoteBox must be forever-box sandbox');
  assert.equal(capturedRunnerOpts[0].userComputers, localExecBridge.userComputers);
  assert.equal(capturedRunnerOpts[0].rejectUnknownMachineIds, true);

  // Fail closed if local-exec extension is present without .box
  const brokenRegistry = new MockTranscriptManager().ensureRunnerRegistry({
    extensions: (id) => {
      if (id === 'forever-box') return { box: sandboxBox };
      if (id === 'local-exec') return { userComputers: localExecBridge.userComputers };
      return undefined;
    },
  });
  assert.throws(
    () => brokenRegistry.getRunner({ id: 'agent-2', db: { isOpen: true }, agentStore: {} }),
    /refusing to fall back/i,
  );
});

test('multi-machine local-exec routing dispatches explicit machineId independently, honors ROKBOT_DEFAULT_MACHINE_ID, and rejects ambiguous/unknown', async () => {
  const fakeLibrary = makeFakeLibrary();
  const bridge = createLocalExecBridge({ library: fakeLibrary });
  assert.ok(bridge.box, 'createLocalExecBridge must expose bridge.box');

  const macMbpId = 'mac-47702c44-65a2-4ad4-9bdf-e27de9dc0b45';
  const macMiniId = 'mac-90e72c8d-7b50-4365-9273-9999efe705f1';
  const mbp = registerFakeMac(bridge, { computerId: macMbpId, label: 'MacBook Pro' });
  const mini = registerFakeMac(bridge, { computerId: macMiniId, label: 'Mac mini' });

  // userComputers.list() includes kind: 'desktop' so CopyToBox/CopyFromBox don't treat Macs as phones
  const listed = bridge.userComputers.list();
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((m) => m.kind), ['desktop', 'desktop']);

  const { remoteAccessor } = await bridge.box.ensureReady({}, 'agent-1');
  const shellExec = remoteAccessor.get(fakeLibrary.fakeShellResource);

  async function runShell(machineId, responder) {
    const out = [];
    const iter = shellExec.execute({}, { command: 'hostname' }, machineId !== undefined ? { machineId } : undefined);
    const nextPromise = (async () => {
      for await (const frame of iter) out.push(frame);
    })();
    if (responder) {
      await new Promise((r) => setTimeout(r, 5));
      responder();
    }
    await nextPromise;
    return out;
  }

  // 1. Without ROKBOT_DEFAULT_MACHINE_ID: implicit (no machineId) must reject ambiguously
  await assert.rejects(() => runShell(undefined), (err) => err instanceof SandLocalExecError && /More than one user machine/i.test(err.message));

  // 2. Explicit machineId routes ONLY to that Mac even without default
  const mbpPromise = runShell(macMbpId, () => {
    const req = mbp.framesSent.find((f) => f.kind === 'exec');
    assert.ok(req, 'MacBook Pro must receive the exec request');
    assert.equal(mini.framesSent.some((f) => f.kind === 'exec'), false, 'Mac mini must NOT receive MacBook Pro exec');
    mbp.respondExec(req.requestId, 'mbp.local\n');
  });
  const mbpFrames = await mbpPromise;
  assert.equal(mbpFrames[0].shellStream.stdout.data, 'mbp.local\n');

  const miniFrames = await runShell(macMiniId, () => {
    const req = mini.framesSent.find((f) => f.kind === 'exec');
    assert.ok(req, 'Mac mini must receive the exec request');
    mini.respondExec(req.requestId, 'mini.local\n');
  });
  assert.equal(miniFrames[0].shellStream.stdout.data, 'mini.local\n');

  // 3. Unknown machineId never falls back to any connected machine
  await assert.rejects(() => runShell('mac-does-not-exist'), (err) => err instanceof SandLocalExecError);

  // 4. With ROKBOT_DEFAULT_MACHINE_ID pinned to Mac mini:
  //    - implicit (undefined) goes to Mac mini
  //    - explicit macMbpId STILL goes to MacBook Pro (default never overrides explicit machineId)
  installDefaultMachineRouting(bridge, macMiniId);
  const mbpCountBefore = mbp.framesSent.filter((f) => f.kind === 'exec').length;
  const miniCountBefore = mini.framesSent.filter((f) => f.kind === 'exec').length;

  await runShell(undefined, () => {
    const execReqs = mini.framesSent.filter((f) => f.kind === 'exec');
    assert.equal(execReqs.length, miniCountBefore + 1);
    assert.equal(mbp.framesSent.filter((f) => f.kind === 'exec').length, mbpCountBefore);
    mini.respondExec(execReqs.at(-1).requestId, 'default-mini.local\n');
  });

  await runShell(macMbpId, () => {
    const execReqs = mbp.framesSent.filter((f) => f.kind === 'exec');
    assert.equal(execReqs.length, mbpCountBefore + 1);
    mbp.respondExec(execReqs.at(-1).requestId, 'explicit-mbp.local\n');
  });

  // 5. File transfer boxes from userComputers.resolve(id) route independently to each Mac
  const mbpComputer = bridge.userComputers.resolve(macMbpId);
  const miniComputer = bridge.userComputers.resolve(macMiniId);
  const dlMbp = mbpComputer.box.downloadFile({}, 'agent-1', '/Users/test/a.txt');
  await new Promise((r) => setTimeout(r, 5));
  const dlReqMbp = mbp.framesSent.find((f) => f.kind === 'download');
  assert.ok(dlReqMbp);
  assert.equal(mini.framesSent.some((f) => f.kind === 'download'), false);
  mbp.respondFile(dlReqMbp.requestId, 'from-mbp');
  assert.equal(Buffer.from(await dlMbp).toString('utf8'), 'from-mbp');

  const ulMini = miniComputer.box.uploadFile({}, 'agent-1', '/Users/test/b.txt', Buffer.from('to-mini'));
  await new Promise((r) => setTimeout(r, 5));
  const ulReqMini = mini.framesSent.find((f) => f.kind === 'upload');
  assert.ok(ulReqMini);
  assert.equal(mbp.framesSent.some((f) => f.kind === 'upload'), false);
  mini.respondFile(ulReqMini.requestId);
  await ulMini;

  // 6. If default machine disconnects while 2 other machines remain online, implicit must reject ambiguously (never random pick)
  mini.unregister();
  registerFakeMac(bridge, { computerId: 'mac-third', label: 'iMac' });
  await assert.rejects(() => runShell(undefined), (err) => err instanceof SandLocalExecError && /More than one user machine/i.test(err.message));

  mbp.unregister();
});

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;
const configuredArchive = process.env.ROKBOT_TEST_HOST_ARCHIVE || process.env.PROKBOT_TEST_HOST_ARCHIVE;

if (configuredSeed || configuredArchive) {
  test('real 2bb5e41 SandAgentRunner routes Shell(machineId) to target Mac and Shell() to sandbox remoteBox', async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-routing-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));

    let seedDir = configuredSeed;
    if (!seedDir && configuredArchive) {
      const matOut = join(stateDir, 'materialized');
      const res = spawnSync(
        process.platform === 'win32' ? 'python' : 'python3',
        [join(HOST_DIR, 'release/patch-host.py'), '--archive', configuredArchive, '--output', matOut],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.ifError(res.error);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      seedDir = join(matOut, 'seed');
    }

    const workSeed = join(stateDir, 'seed');
    await cp(seedDir, workSeed, { recursive: true });
    const reliableDir = join(workSeed, 'reliable-core', 'v1');
    await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
    await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
    await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));

    const tokenFile = join(stateDir, 'internal-host-token');
    await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

    const macMbpId = 'mac-47702c44-65a2-4ad4-9bdf-e27de9dc0b45';
    const macMiniId = 'mac-90e72c8d-7b50-4365-9273-9999efe705f1';
    const sandboxCalls = [];
    let capturedToolResults = [];

    let treeSitterAvailable = false;
    try {
      const reqTest = createRequire(import.meta.url);
      reqTest('tree-sitter');
      treeSitterAvailable = true;
    } catch {}

    const mockOpenAiServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const msgs = body.messages ?? [];
        const toolResults = msgs.filter((m) => m?.role === 'tool');
        if (toolResults.length > capturedToolResults.length) {
          capturedToolResults = toolResults.map((r) => r.content);
        }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const emitToolCall = (id, name, argsObj) => {
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl-${id}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(argsObj) } }] }, finish_reason: null }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl-${id}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        };

        const steps = [
          ['tc_list', 'ListMachines', {}],
          ['tc_read_mbp', 'Read', { path: '/Users/mbp/host.txt', machineId: macMbpId }],
          ['tc_read_mini', 'Read', { path: '/Users/mini/host.txt', machineId: macMiniId }],
          ['tc_read_box', 'Read', { path: '/workspace/box.txt' }],
          ['tc_read_unknown', 'Read', { path: '/Users/x/y.txt', machineId: 'mac-unknown-id' }],
          ...(treeSitterAvailable ? [
            ['tc_shell_mbp', 'Shell', { command: 'hostname', machineId: macMbpId }],
            ['tc_shell_mini', 'Shell', { command: 'hostname', machineId: macMiniId }],
            ['tc_shell_box', 'Shell', { command: 'hostname' }],
          ] : []),
        ];
        if (toolResults.length < steps.length) {
          const [id, name, argsObj] = steps[toolResults.length];
          emitToolCall(id, name, argsObj);
          return;
        }
        if (toolResults.length === steps.length) {
          emitToolCall('tc_send', 'SendToUser', { type: 'text', content: 'routing checks finished' });
          return;
        }
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-done', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-done', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (req.url === '/internal/connectors/runtime') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ revision: 0, config: { mcpServers: {} }, display: { servers: [] } }));
        return;
      }
      if (req.url?.startsWith('/internal/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('null');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const mockOpenAiBase = await new Promise((resListen) => {
      mockOpenAiServer.listen(0, '127.0.0.1', () => resListen(`http://127.0.0.1:${mockOpenAiServer.address().port}`));
    });
    t.after(() => new Promise((resClose) => { mockOpenAiServer.closeAllConnections?.(); mockOpenAiServer.close(resClose); }));

    const require = createRequire(import.meta.url);
    const library = require(join(workSeed, 'host-library-reliable.cjs'));

    const mockExecServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      if (req.url?.includes('ExecService/Exec') && ct.includes('application/connect+proto')) {
        const rawText = raw.toString('utf8');
        if (rawText.includes('/workspace/box.txt') || rawText.includes('hostname')) {
          sandboxCalls.push(rawText);
        }
        const msg = rawText.includes('/workspace/box.txt')
          ? library.ExecClientMessage.fromJson({
              id: 0,
              readResult: {
                success: {
                  path: '/workspace/box.txt',
                  content: 'docker-sandbox-1126fa2ce615\n',
                  totalLines: 1,
                  fileSize: 28,
                },
              },
            }).toBinary()
          : library.ExecClientMessage.fromJson({ id: 0, shellStream: { stdout: { data: 'docker-sandbox-1126fa2ce615\n' } } }).toBinary();
        const frames = [msg];
        if (!rawText.includes('/workspace/box.txt')) {
          frames.push(library.ExecClientMessage.fromJson({ id: 0, shellStream: { exit: { code: 0 } } }).toBinary());
        }
        const wrapExecElement = (clientMsgBytes) => {
          const lenBytes = [];
          let len = clientMsgBytes.length;
          while (len >= 0x80) {
            lenBytes.push((len & 0x7f) | 0x80);
            len >>>= 7;
          }
          lenBytes.push(len);
          return Buffer.concat([Buffer.from([0x0a, ...lenBytes]), clientMsgBytes]);
        };
        const frame = (flags, buf) => {
          const hdr = Buffer.alloc(5);
          hdr.writeUInt8(flags, 0);
          hdr.writeUInt32BE(buf.length, 1);
          return Buffer.concat([hdr, buf]);
        };
        res.writeHead(200, { 'content-type': 'application/connect+proto' });
        res.end(Buffer.concat([...frames.map((f) => frame(0, wrapExecElement(f))), frame(2, Buffer.from('{}'))]));
        return;
      }
      if (ct.includes('application/connect+proto')) {
        res.writeHead(200, { 'content-type': 'application/connect+proto' });
        res.end(Buffer.from([0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0x7b, 0x7d]));
      } else if (ct.includes('application/json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } else {
        res.writeHead(200, { 'content-type': 'application/proto' });
        res.end();
      }
    });
    const mockExecBase = await new Promise((resListen) => {
      mockExecServer.listen(0, '127.0.0.1', () => resListen(`http://127.0.0.1:${mockExecServer.address().port}`));
    });
    t.after(() => new Promise((resClose) => { mockExecServer.closeAllConnections?.(); mockExecServer.close(resClose); }));

    const prevEnv = new Map();
    const envOverrides = {
      ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'),
      ROKBOT_STATE_DIR: stateDir,
      ROKBOT_DATA_DIR: stateDir,
      ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile,
      ROKBOT_NOTIFICATION_URL: mockOpenAiBase,
      ROKBOT_CONNECTORS_URL: `${mockOpenAiBase}/internal/connectors`,
      ROKBOT_SHARING_URL: `${mockOpenAiBase}/internal/sharing`,
      ROKBOT_EXECUTION_URL: mockExecBase,
      ROKBOT_BOX_TOKEN: 'test-box-token',
      ROKBOT_DEFAULT_MACHINE_ID: macMiniId,
      SAND_DATA_ROOT: join(stateDir, 'host-data'),
      SAND_BACKEND_URL: 'http://127.0.0.1:9',
      SAND_DISABLE_TELEMETRY: '1',
      SAND_DISABLE_ANALYTICS: '1',
      SAND_HOST_IN_BOX: '1',
      SAND_PACKAGED: '1',
      SAND_BOX_MAX_WINDOWS: '1',
    };
    for (const [k, v] of Object.entries(envOverrides)) {
      prevEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    t.after(() => {
      for (const [k, v] of prevEnv.entries()) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    await loadRecoveredHostCore(library, reliableDir);
    const modelConfig = {
      apiFormat: 'openai',
      baseUrl: `${mockOpenAiBase}/v1`,
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      policy: defaultPolicy('gpt-4o-mini'),
      usageDirectory: join(stateDir, 'usage'),
      routingDirectory: join(stateDir, 'routing'),
    };
    const host = new library.SandHost({
      environment: library.readSandHostEnvironment(process.env),
      startExtensions: createExtensionStarter(library, modelConfig),
    });

    try {
      await host.start();
      // Routing only: the Auto-review switch (on by default) would send each Shell call to review.
      await host.getApi().setHostSettings({ autoReviewInstructions: { isEnabled: false, allowInstructions: [], blockInstructions: [] } });
      const execBridge = host.getLocalExecBridge();
      installDefaultMachineRouting(execBridge, macMiniId);

      // Attach auto-responding fake MacBook Pro and Mac mini providers
      const attachAutoMac = (computerId, label, stdoutText) => {
        const sent = [];
        const unreg = execBridge.registerProvider((frame) => {
          sent.push(frame);
          if (frame.kind === 'exec') {
            const p = sent.find((f) => f.kind === 'welcome').providerId;
            const isRead = Boolean(frame.serverMessage?.readArgs);
            setImmediate(() => {
              execBridge.submitResponses({
                providerId: p,
                frames: isRead
                  ? [
                      {
                        kind: 'client',
                        requestId: frame.requestId,
                        message: {
                          id: frame.serverMessage?.id ?? 0,
                          readResult: {
                            success: {
                              path: frame.serverMessage?.readArgs?.path ?? '/Users/mac/host.txt',
                              content: stdoutText,
                              totalLines: 1,
                              fileSize: stdoutText.length,
                            },
                          },
                        },
                      },
                      { kind: 'control', requestId: frame.requestId, message: { streamClose: {} } },
                    ]
                  : [
                      { kind: 'client', requestId: frame.requestId, message: { id: frame.serverMessage?.id ?? 0, shellStream: { stdout: { data: stdoutText } } } },
                      { kind: 'client', requestId: frame.requestId, message: { id: frame.serverMessage?.id ?? 0, shellStream: { exit: { code: 0 } } } },
                      { kind: 'control', requestId: frame.requestId, message: { streamClose: {} } },
                    ],
              });
            });
          }
        });
        const pid = sent.find((f) => f.kind === 'welcome').providerId;
        execBridge.submitResponses({
          providerId: pid,
          frames: [{ kind: 'hello', computerId, label, localRoot: '/tmp', terminalsFolder: `/tmp/${computerId}/terminals` }],
        });
        return { sent, unreg };
      };

      const mbp = attachAutoMac(macMbpId, 'MacBook Pro', 'MacBook-Pro.local\n');
      const mini = attachAutoMac(macMiniId, 'Mac mini', 'Mac-mini.local\n');

      const api = host.getApi();
      const created = await api.createAgent({ name: 'Routing Bot', description: 'Verify multi-machine routing' });
      const agentId = created.agent.id;
      await api.openAgent({ id: agentId });
      await api.setHostSettings({ localToolPermission: 'always' });

      await api.sendPrompt({ agentId, prompt: 'Run routing check', clientNonce: 'route-check-1' });
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);

      const transcript = await api.getAgentTranscript({ id: agentId });
      assert.equal(transcript.some((e) => e.kind === 'send-message' && e.message?.content === 'routing checks finished'), true);

      const listJson = capturedToolResults[0].replace(/<\/?cursor_untrusted_data_[^>]*>/g, '').trim();
      const machinesList = JSON.parse(listJson);
      assert.deepEqual(
        machinesList.machines.map((m) => ({ machineId: m.machineId, kind: m.kind, connected: m.connected })),
        [
          { machineId: macMbpId, kind: 'desktop', connected: true },
          { machineId: macMiniId, kind: 'desktop', connected: true },
        ],
      );
      assert.match(capturedToolResults[1], /MacBook-Pro\.local/);
      assert.match(capturedToolResults[2], /Mac-mini\.local/);
      assert.match(capturedToolResults[3], /docker-sandbox-1126fa2ce615/);
      assert.match(capturedToolResults[4], /Unknown machineId/i);

      const expectedExecCount = treeSitterAvailable ? 2 : 1;
      assert.equal(mbp.sent.filter((f) => f.kind === 'exec').length, expectedExecCount, 'MBP must receive only MBP-targeted calls');
      assert.equal(mini.sent.filter((f) => f.kind === 'exec').length, expectedExecCount, 'Mac mini must receive only Mac-mini-targeted calls');
      assert.equal(sandboxCalls.length, expectedExecCount, 'Docker sandbox must receive ONLY un-targeted box calls');
      if (treeSitterAvailable) {
        assert.match(capturedToolResults[5], /MacBook-Pro\.local/);
        assert.match(capturedToolResults[6], /Mac-mini\.local/);
        assert.match(capturedToolResults[7], /docker-sandbox-1126fa2ce615/);
      }

      mbp.unreg();
      mini.unreg();
    } finally {
      await host.dispose();
    }
  });
}

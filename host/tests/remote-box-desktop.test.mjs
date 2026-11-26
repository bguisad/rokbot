// Regression: since the 2bb5e41 upgrade the bridge passed `remoteBox` to SandAgentRunner but not
// `remoteBoxHasDesktop` / `getRemoteBoxAvailable`. Upstream defaults `remoteBoxHasDesktop ?? false`,
// which silently removed the computerUse subagent, Screenshot/Computer, the browser tool surface and
// RequestUserForm from every bot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { installLocalHarnessBridge, remoteBoxDesktopOptions } from '../runtime/local-harness-bridge.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';
import { defaultPolicy } from '../runtime/model-policy.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');

test('remoteBoxDesktopOptions enables the desktop only with a remote box and honors ROKBOT_REMOTE_BOX_DESKTOP', () => {
  const box = { kind: 'forever-box' };
  const on = remoteBoxDesktopOptions(box, {});
  assert.equal(on.remoteBoxHasDesktop, true);
  assert.equal(on.getRemoteBoxAvailable(), true);

  const none = remoteBoxDesktopOptions(undefined, {});
  assert.equal(none.remoteBoxHasDesktop, false);
  assert.equal(none.getRemoteBoxAvailable(), false);

  for (const value of ['0', 'false', 'OFF', 'no']) {
    const off = remoteBoxDesktopOptions(box, { ROKBOT_REMOTE_BOX_DESKTOP: value });
    assert.equal(off.remoteBoxHasDesktop, false, `ROKBOT_REMOTE_BOX_DESKTOP=${value}`);
    assert.equal(off.getRemoteBoxAvailable(), true, 'box tools stay available when only the desktop is disabled');
  }
  assert.equal(remoteBoxDesktopOptions(box, { ROKBOT_REMOTE_BOX_DESKTOP: '1' }).remoteBoxHasDesktop, true);
});

test('createRunnerForSession passes remoteBoxHasDesktop/getRemoteBoxAvailable to SandAgentRunner', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rokbot-remote-box-desktop-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const captured = [];
  class MockSessionRuntime { constructor() { this.tm = {}; } }
  class MockTranscriptManager {
    constructor() {
      this.sessions = new MockSessionRuntime();
      this.roster = { emit: () => {}, emitAgentUpdate: async () => {} };
      this.sessionStore = { getAgentDir: () => dataDir };
    }
  }
  const fakeLibrary = {
    getHostFlowRecoveryBindings: () => ({ SendPipeline: class {}, TurnExecutionRegistry: class {} }),
    getHostExecutionRecoveryBindings: () => ({ TranscriptManager: MockTranscriptManager }),
    getHostSessionRecoveryBindings: () => ({ SessionRuntime: MockSessionRuntime }),
    getHostKernelRecoveryBindings: () => ({}),
    getPromptToolsRecoveryBindings: () => ({ defaultSandRunnerGates: () => ({}) }),
    ConversationStateStructure: class {},
    MemoryFolderView: class {},
    SandAgentRunner: class FakeRunner { constructor(opts) { captured.push(opts); } },
  };
  installLocalHarnessBridge(fakeLibrary, { extensions: () => undefined });

  const sandboxBox = { kind: 'docker-sandbox' };
  new MockTranscriptManager()
    .ensureRunnerRegistry({ extensions: (id) => (id === 'forever-box' ? { box: sandboxBox } : undefined) })
    .getRunner({ id: 'agent-with-box', db: { isOpen: true }, agentStore: {} });
  new MockTranscriptManager()
    .ensureRunnerRegistry({ extensions: () => undefined })
    .getRunner({ id: 'agent-without-box', db: { isOpen: true }, agentStore: {} });

  assert.equal(captured.length, 2);
  assert.equal(captured[0].remoteBox, sandboxBox);
  assert.equal(captured[0].remoteBoxHasDesktop, true);
  assert.equal(typeof captured[0].getRemoteBoxAvailable, 'function');
  assert.equal(captured[0].getRemoteBoxAvailable(), true);

  assert.equal(captured[1].remoteBox, undefined);
  assert.equal(captured[1].remoteBoxHasDesktop, false);
  assert.equal(captured[1].getRemoteBoxAvailable(), false);
});

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;
const configuredArchive = process.env.ROKBOT_TEST_HOST_ARCHIVE || process.env.PROKBOT_TEST_HOST_ARCHIVE;

async function materializeSeed(stateDir) {
  let seedDir = configuredSeed;
  if (!seedDir) {
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
  return { workSeed, reliableDir };
}

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)));
}

function closeServer(server) {
  return new Promise((done) => { server.closeAllConnections?.(); server.close(done); });
}

/** Boot the real 2bb5e41 host, send one prompt, and return the tool surface of the first model request. */
async function captureFirstTurnTools(t, { desktopEnv }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'rokbot-remote-box-desktop-real-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { workSeed, reliableDir } = await materializeSeed(stateDir);
  const tokenFile = join(stateDir, 'internal-host-token');
  await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

  const requests = [];
  const modelServer = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
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
  const modelBase = await listen(modelServer);
  t.after(() => closeServer(modelServer));

  // Box exec daemon stand-in: answers every Connect call with an empty end-of-stream.
  const execServer = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/connect+proto')) {
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.end(Buffer.from([2, 0, 0, 0, 2, 0x7b, 0x7d]));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  const execBase = await listen(execServer);
  t.after(() => closeServer(execServer));

  const envOverrides = {
    ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'),
    ROKBOT_STATE_DIR: stateDir,
    ROKBOT_DATA_DIR: stateDir,
    ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile,
    ROKBOT_NOTIFICATION_URL: modelBase,
    ROKBOT_CONNECTORS_URL: `${modelBase}/internal/connectors`,
    ROKBOT_SHARING_URL: `${modelBase}/internal/sharing`,
    ROKBOT_EXECUTION_URL: execBase,
    ROKBOT_BOX_TOKEN: 'test-box-token',
    ROKBOT_REMOTE_BOX_DESKTOP: desktopEnv,
    SAND_DATA_ROOT: join(stateDir, 'host-data'),
    SAND_BACKEND_URL: 'http://127.0.0.1:9',
    SAND_DISABLE_TELEMETRY: '1',
    SAND_DISABLE_ANALYTICS: '1',
    SAND_HOST_IN_BOX: '1',
    SAND_PACKAGED: '1',
    SAND_BOX_MAX_WINDOWS: '1',
  };
  const prevEnv = new Map();
  for (const [k, v] of Object.entries(envOverrides)) {
    prevEnv.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restoreEnv = () => {
    for (const [k, v] of prevEnv.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  const require = createRequire(import.meta.url);
  const library = require(join(workSeed, 'host-library-reliable.cjs'));
  let host;
  try {
    await loadRecoveredHostCore(library, reliableDir);
    const modelConfig = {
      apiFormat: 'openai',
      baseUrl: `${modelBase}/v1`,
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      policy: defaultPolicy('gpt-4o-mini'),
      usageDirectory: join(stateDir, 'usage'),
      routingDirectory: join(stateDir, 'routing'),
    };
    host = new library.SandHost({
      environment: library.readSandHostEnvironment(process.env),
      startExtensions: createExtensionStarter(library, modelConfig),
    });
    await host.start();
    const api = host.getApi();
    const created = await api.createAgent({ name: 'Desktop Bot', description: 'Desktop tool surface' });
    const agentId = created.agent.id;
    await api.openAgent({ id: agentId });
    await api.sendPrompt({ agentId, prompt: 'hello', clientNonce: `desktop-${desktopEnv ?? 'default'}` });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
  } finally {
    await host?.dispose();
    restoreEnv();
  }

  assert.ok(requests.length > 0, 'the runner must call the model');
  return toolSurfaceOf(requests[0]);
}

/**
 * The 2bb5e41 runner sends only a few tools natively; first-party tools such as Task and Screenshot
 * are listed in the `cursor` dynamic namespace, and Task's subagent types in <available_subagent_types>.
 */
function toolSurfaceOf(body) {
  const nativeTools = (body.tools ?? []).map((tool) => (tool.function ?? tool).name);
  const text = (body.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const namespace = text.match(/<namespace name="cursor" tools="([^"]*)"/);
  const cursorTools = namespace ? namespace[1].split(',').map((name) => name.trim()).filter(Boolean) : [];
  const subagentBlock = text.match(/<available_subagent_types>([\s\S]*?)<\/available_subagent_types>/)?.[1] ?? '';
  const subagentTypes = [...subagentBlock.matchAll(/^- (\w+):/gm)].map((m) => m[1]);
  const computerUseEntry = subagentBlock.split(/^(?=- \w+:)/m).find((entry) => entry.startsWith('- computerUse:')) ?? '';
  return { tools: [...nativeTools, ...cursorTools], subagentTypes, computerUseEntry, hasSubagentBlock: subagentBlock !== '' };
}

if (configuredSeed || configuredArchive) {
  test('real 2bb5e41 runner exposes computerUse subagent and desktop tools with the forever-box', async (t) => {
    const surface = await captureFirstTurnTools(t, { desktopEnv: undefined });
    assert.ok(surface.tools.includes('Task'), `Task tool missing: ${surface.tools.join(', ')}`);
    assert.ok(surface.subagentTypes.includes('computerUse'), `Task subagent list must include computerUse: ${surface.subagentTypes.join(', ')}`);
    assert.ok(surface.tools.includes('Screenshot'), `Screenshot must be enabled with a remote box: ${surface.tools.join(', ')}`);
    // Computer is the computerUse subagent's own tool; the subagent inherits remoteBoxHasDesktop from the parent.
    assert.match(surface.computerUseEntry, /\bComputer\b/, 'computerUse subagent must advertise the Computer tool');
  });

  test('real 2bb5e41 runner hides computerUse/desktop tools when ROKBOT_REMOTE_BOX_DESKTOP=0', async (t) => {
    const surface = await captureFirstTurnTools(t, { desktopEnv: '0' });
    assert.ok(surface.tools.includes('Task'), `Task tool missing: ${surface.tools.join(', ')}`);
    assert.ok(surface.hasSubagentBlock, 'Task subagent list must still be rendered');
    assert.ok(!surface.subagentTypes.includes('computerUse'), `computerUse must be hidden: ${surface.subagentTypes.join(', ')}`);
    assert.ok(!surface.tools.includes('Screenshot'), 'Screenshot must be disabled without a desktop');
    assert.ok(!surface.tools.includes('Computer'), 'Computer must be disabled without a desktop');
  });
}

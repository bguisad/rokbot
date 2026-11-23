import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { syncTurnAttachments } from '../runtime/host-attachments.mjs';
import { installLocalHarnessBridge, prepareTurnAttachments } from '../runtime/local-harness-bridge.mjs';
import { createModelSession } from '../runtime/model-session.mjs';
import { defaultPolicy } from '../runtime/model-policy.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');

function withEnv(overrides) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function listenHttp(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function closeHttp(server) {
  server.closeAllConnections?.();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

// 1x1 valid PNG bytes
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
// Minimal valid JPEG SOI..EOI bytes
const TINY_JPG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x03, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x02, 0x02, 0x02, 0x03,
  0x03, 0x03, 0x03, 0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x06,
  0x06, 0x05, 0x06, 0x09, 0x08, 0x0a, 0x0a, 0x09, 0x08, 0x09, 0x09, 0x0a,
  0x0c, 0x0f, 0x0c, 0x0a, 0x0b, 0x0e, 0x0b, 0x09, 0x09, 0x0d, 0x11, 0x0d,
  0x0e, 0x0f, 0x10, 0x10, 0x11, 0x10, 0x0a, 0x0c, 0x12, 0x13, 0x12, 0x10,
  0x13, 0x0f, 0x10, 0x10, 0x10, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x03, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x37, 0xff, 0xd9,
]);

test('prepareTurnAttachments and SendPipeline deliver image+text, image-only, multi-image, and non-image files', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rokbot-img-bridge-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const img1Path = join(dataDir, 'photo1.jpg');
  const img2Path = join(dataDir, 'photo2.png');
  const pdfPath = join(dataDir, 'notes.pdf');
  await writeFile(img1Path, TINY_JPG);
  await writeFile(img2Path, TINY_PNG);
  await writeFile(pdfPath, '%PDF-1.4\n');

  const direct = await prepareTurnAttachments(
    [img1Path, pathToFileURL(img2Path).href, pdfPath],
    {
      attachmentsExt: {
        readImage: async ({ path }) => {
          if (path === img1Path) {
            return { dataUrl: `data:image/jpg;base64,${TINY_JPG.toString('base64')}`, width: 1, height: 1 };
          }
          if (path === img2Path) {
            return { dataUrl: `data:image/png;base64,${TINY_PNG.toString('base64')}`, width: 1, height: 1 };
          }
          return null;
        },
      },
      hasRemoteBox: false,
    },
  );
  assert.equal(direct.selectedImages.length, 2);
  assert.equal(direct.selectedImages[0].mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(direct.selectedImages[0].data), TINY_JPG);
  assert.equal(direct.selectedImages[1].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(direct.selectedImages[1].data), TINY_PNG);
  assert.deepEqual(direct.attachedFilePaths, [pdfPath]);
  assert.equal(direct.attachedFileSizes.get(img1Path), TINY_JPG.length);
  assert.equal(direct.attachedFileSizes.get(pdfPath), 9);
  assert.equal(direct.attachedFilesInStore.has(img1Path), true);
  assert.equal(direct.attachedFilesInStore.has(pdfPath), true);

  class MockSendPipeline {}
  class MockTranscriptManager {
    constructor() {
      this.sessions = {
        ensureActionTarget: async () => {},
        isAgentGone: () => false,
        isServerHostedAgent: () => false,
        resolveBackgroundSession: async (id) => ({ id, db, agentStore: {} }),
      };
      this.sessionStore = { getAgentDir: () => dataDir, markSessionActivity() {} };
      this.roster = { emit() {}, emitAgentUpdate: async () => {} };
    }
  }
  const runnerCalls = [];
  const fakeLibrary = {
    getHostFlowRecoveryBindings: () => ({ SendPipeline: MockSendPipeline }),
    getHostExecutionRecoveryBindings: () => ({ TranscriptManager: MockTranscriptManager }),
    getHostSessionRecoveryBindings: () => ({ SessionRuntime: class {} }),
    getHostKernelRecoveryBindings: () => ({}),
    getPromptToolsRecoveryBindings: () => ({ defaultSandRunnerGates: () => ({}) }),
    resolveSandStreamTuning: () => ({}),
    ConversationStateStructure: class {},
    MemoryFolderView: class {},
    SandAgentRunner: class {
      constructor(opts) { this.opts = opts; }
      run(prompt, options, scope) {
        runnerCalls.push({ prompt, options, scope });
        this.opts.transport?.onUpdate({
          type: 'send-message',
          message: { type: 'text', content: `saw ${options.selectedImages?.length ?? 0} images` },
          timestampMs: Date.now(),
        });
        return { aborted: false, sentMessageCount: 1, text: '' };
      }
      interrupt() { return false; }
    },
    SandAgentDb: class {
      constructor() { this.entries = []; }
      getTranscriptEntries() { return [...this.entries]; }
      getTranscriptEntryIds() { return new Set(this.entries.map(e => e.id)); }
      appendTranscriptEntry(e) { this.entries.push(e); }
      updateTranscriptEntry(id, fn) { this.entries = this.entries.map(e => (e.id === id ? fn(e) : e)); }
      writeKv() {}
    },
  };
  const db = new fakeLibrary.SandAgentDb();
  const attachmentsExt = {
    readImage: async ({ path }) => {
      if (path.endsWith('.jpg')) return { dataUrl: `data:image/jpeg;base64,${TINY_JPG.toString('base64')}`, width: 1, height: 1 };
      if (path.endsWith('.png')) return { dataUrl: `data:image/png;base64,${TINY_PNG.toString('base64')}`, width: 1, height: 1 };
      return null;
    },
    readImageDimensions: async () => ({ width: 1, height: 1 }),
  };

  installLocalHarnessBridge(fakeLibrary, {
    extensions: (id) => (id === 'attachments' ? attachmentsExt : undefined),
  });

  const sp = new MockSendPipeline();
  sp.tm = new MockTranscriptManager();
  sp.nextTurnEpoch = () => 1;

  // 1) Image + text
  await sp.sendPrompt('Check this prescription', {
    agentId: 'bot-1',
    attachmentPaths: [img1Path],
    attachmentNames: ['rx.jpg'],
  });
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].prompt, 'Check this prescription');
  assert.equal(runnerCalls[0].options.selectedImages.length, 1);
  assert.equal(runnerCalls[0].options.selectedImages[0].mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(runnerCalls[0].options.selectedImages[0].data), TINY_JPG);
  assert.equal(db.entries.some(e => e.kind === 'user-attachment' && e.file_name === 'rx.jpg'), true);

  // 2) Pure image-only (empty prompt) with multiple images
  await sp.sendPrompt('', {
    agentId: 'bot-1',
    attachmentPaths: [img1Path, img2Path],
  });
  assert.equal(runnerCalls.length, 2);
  assert.equal(runnerCalls[1].prompt, '');
  assert.equal(runnerCalls[1].options.selectedImages.length, 2);
  assert.equal(db.entries.some(e => e.kind === 'send-message' && e.message?.content === 'saw 2 images'), true);
});

test('syncTurnAttachments handles missing remoteBox, upload failures, symlinks, and macOS realpath roots safely', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rokbot-sync-att-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const agentId = '1979689f-665f-42e1-ad74-b130fca853ad';
  const attDir = join(root, 'agents', agentId, 'attachments');
  await mkdir(attDir, { recursive: true });
  const attPath = join(attDir, 'photo.jpg');
  await writeFile(attPath, TINY_JPG);

  const fakeLib = { createContext: () => ({ withCancel: () => [{}, () => {}] }) };

  // Missing remoteBox is a safe no-op
  await syncTurnAttachments(
    { getAgentId: () => agentId },
    { selectedImages: [{ path: attPath }] },
    fakeLib,
    root,
  );

  // Valid upload works even under symlinked /var -> /private/var tmpdir on macOS
  const uploads = [];
  await syncTurnAttachments(
    {
      getAgentId: () => agentId,
      remoteBox: {
        uploadFile: async (_ctx, id, path, bytes) => {
          uploads.push({ id, path, size: bytes.length });
        },
      },
    },
    { selectedImages: [{ path: attPath }] },
    fakeLib,
    root,
  );
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].id, agentId);
  assert.equal(uploads[0].size, TINY_JPG.length);

  // Box upload failure logs a warning without aborting inline image turns
  await syncTurnAttachments(
    {
      getAgentId: () => agentId,
      remoteBox: {
        uploadFile: async () => { throw new Error('box temporarily unreachable'); },
      },
    },
    { selectedImages: [{ path: attPath }] },
    fakeLib,
    root,
  );

  // Symlink attachment is still rejected
  const outside = join(root, 'secret.txt');
  await writeFile(outside, 'secret');
  const linkPath = join(attDir, 'link.jpg');
  await symlink(outside, linkPath);
  await assert.rejects(
    () => syncTurnAttachments(
      { getAgentId: () => agentId, remoteBox: { uploadFile: async () => {} } },
      { selectedImages: [{ path: linkPath }] },
      fakeLib,
      root,
    ),
    /Invalid managed attachment path/,
  );
});

test('model formats (OpenAI Chat, OpenAI Responses, Anthropic Messages) deliver Uint8Array images with and without text', async () => {
  const sseJson = (lines) => new Response(lines.map(l => `data: ${JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const checkFormat = async (apiFormat, sseEvents, extractImages) => {
    const requests = [];
    const session = createModelSession({
      apiFormat,
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: apiFormat === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o',
      fetchImpl: async (_url, opts) => {
        requests.push(JSON.parse(opts.body));
        return sseJson(sseEvents);
      },
    });
    const stream = session.getExecutor([
      {
        role: 'user',
        content: [
          { type: 'image', image: new Uint8Array(TINY_JPG), mimeType: 'image/jpg' },
          { type: 'text', text: '' },
        ],
      },
    ]).stream({}, 'inv-1', []);
    for await (const _part of stream.fullStream) {}
    await stream.response;
    assert.equal(requests.length, 1);
    const images = extractImages(requests[0]);
    assert.equal(images.length, 1);
    assert.ok(images[0].includes(TINY_JPG.toString('base64')), `${apiFormat} payload must include base64 image`);
  };

  await checkFormat(
    'openai',
    [
      { id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ],
    (body) => {
      assert.equal(body.messages[0].content.some(p => p.type === 'text' && p.text === ''), false);
      return body.messages[0].content.filter(p => p.type === 'image_url').map(p => p.image_url.url);
    },
  );

  await checkFormat(
    'openai-responses',
    [
      { type: 'response.created', response: { id: 'resp_1', model: 'gpt-4o' } },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] } },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
    ],
    (body) => body.input[0].content.filter(p => p.type === 'input_image').map(p => p.image_url),
  );

  await checkFormat(
    'anthropic',
    [
      { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ],
    (body) => body.messages[0].content.filter(b => b.type === 'image').map(b => `${b.source.media_type}:${b.source.data}`),
  );
});

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;
const configuredArchive = process.env.ROKBOT_TEST_HOST_ARCHIVE || process.env.PROKBOT_TEST_HOST_ARCHIVE;

if (configuredSeed || configuredArchive) {
  test('real 2bb5e41 SandAgentRunner delivers base64 images to LLM HTTP request for both image+text and image-only turns', async t => {
    const rawStateDir = await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-img-'));
    t.after(() => rm(rawStateDir, { recursive: true, force: true }));
    const stateDir = await realpath(rawStateDir);

    let seedDir = configuredSeed;
    if (!seedDir && configuredArchive) {
      const { spawnSync } = await import('node:child_process');
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

    const llmRequests = [];
    const mockOpenAiServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const sys = msgs.filter(m => m?.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (sys.includes('GROK_BOT_MEMORY_EXTRACTION')) {
          res.end(`data: ${JSON.stringify({ id: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        llmRequests.push(body);
        const lastUser = [...msgs].reverse().find(m => m?.role === 'user');
        const imgCount = Array.isArray(lastUser?.content)
          ? lastUser.content.filter(p => p?.type === 'image_url' && /^data:image\/.+;base64,[A-Za-z0-9+/=]+$/.test(p.image_url?.url ?? '')).length
          : 0;
        const textPart = Array.isArray(lastUser?.content)
          ? lastUser.content.filter(p => p?.type === 'text').map(p => p.text).join('\n')
          : String(lastUser?.content ?? '');
        const hasToolResult = msgs.slice(msgs.lastIndexOf(lastUser) + 1).some(m => m?.role === 'tool');
        if (!hasToolResult) {
          const toolArgs = JSON.stringify({ type: 'text', content: `Images=${imgCount};HasRx=${textPart.includes('RX_TEXT')}` });
          res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'SendToUser', arguments: toolArgs } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ id: 'c2', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
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
    const mockOpenAiBase = await listenHttp(mockOpenAiServer);
    t.after(() => closeHttp(mockOpenAiServer));

    const mockExecServer = createServer((req, res) => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/connect+proto')) {
        res.writeHead(200, { 'content-type': 'application/connect+proto' });
        res.end(Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), Buffer.from([2, 0, 0, 0, 2, 0x7b, 0x7d])]));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
    const mockExecBase = await listenHttp(mockExecServer);
    t.after(() => closeHttp(mockExecServer));

    const tokenFile = join(stateDir, 'internal-host-token');
    await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

    const restoreEnv = withEnv({
      ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'),
      ROKBOT_STATE_DIR: stateDir,
      ROKBOT_DATA_DIR: stateDir,
      ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile,
      ROKBOT_INTERNAL_HOST_URL: mockOpenAiBase,
      ROKBOT_NOTIFICATION_URL: mockOpenAiBase,
      ROKBOT_CONNECTORS_URL: `${mockOpenAiBase}/internal/connectors`,
      ROKBOT_SHARING_URL: `${mockOpenAiBase}/internal/sharing`,
      ROKBOT_EXECUTION_URL: mockExecBase,
      ROKBOT_BOX_TOKEN: 'test-box-token',
      SAND_DATA_ROOT: join(stateDir, 'host-data'),
      SAND_BACKEND_URL: 'http://127.0.0.1:9',
      SAND_DISABLE_TELEMETRY: '1',
      SAND_DISABLE_ANALYTICS: '1',
      SAND_HOST_IN_BOX: '1',
      SAND_PACKAGED: '1',
      SAND_BOX_MAX_WINDOWS: '1',
    });
    t.after(restoreEnv);

    const require = createRequire(import.meta.url);
    const library = require(join(workSeed, 'host-library-reliable.cjs'));
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
      const api = host.getApi();
      const created = await api.createAgent({ name: 'Image Test Bot', description: 'Image delivery check' });
      const agentId = created.agent.id;
      await api.openAgent({ id: agentId });

      const attExt = host.requireHostExtensions().api('attachments');
      const upJpg = await attExt.upload({ agentId, filename: 'rx.jpg', bytesBase64: TINY_JPG.toString('base64') });
      const upPng = await attExt.upload({ agentId, filename: 'rx2.png', bytesBase64: TINY_PNG.toString('base64') });
      assert.ok(upJpg.path && upPng.path);

      // 1) Image + text turn
      const reqsBefore1 = llmRequests.length;
      await api.sendPrompt({ agentId, prompt: 'RX_TEXT', attachmentPaths: [upJpg.path], clientNonce: 'img-text-1' });
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
      const req1 = llmRequests[reqsBefore1];
      assert.ok(req1, 'image+text turn must send LLM request');
      const user1 = req1.messages.findLast(m => m.role === 'user');
      assert.ok(Array.isArray(user1?.content), 'image+text user content must be multimodal array');
      const imgParts1 = user1.content.filter(p => p.type === 'image_url');
      assert.equal(imgParts1.length, 1);
      assert.ok(imgParts1[0].image_url.url.startsWith('data:image/jpeg;base64,'));
      assert.ok(imgParts1[0].image_url.url.includes(TINY_JPG.toString('base64')));

      // 2) Pure image-only turn (empty text) with TWO images
      const reqsBefore2 = llmRequests.length;
      await api.sendPrompt({ agentId, prompt: '', attachmentPaths: [upJpg.path, upPng.path], clientNonce: 'img-only-2' });
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
      const req2 = llmRequests[reqsBefore2];
      assert.ok(req2, 'image-only turn must trigger LLM request');
      const user2 = req2.messages.findLast(m => m.role === 'user');
      assert.ok(Array.isArray(user2?.content), 'image-only user content must be multimodal array');
      const imgParts2 = user2.content.filter(p => p.type === 'image_url');
      assert.equal(imgParts2.length, 2);
      assert.ok(imgParts2.some(p => p.image_url.url.includes(TINY_JPG.toString('base64'))));
      assert.ok(imgParts2.some(p => p.image_url.url.includes(TINY_PNG.toString('base64'))));

      // 3) Follow-up text turn after image-only turn
      const reqsBefore3 = llmRequests.length;
      await api.sendPrompt({ agentId, prompt: 'FOLLOW_UP', clientNonce: 'follow-up-3' });
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
      assert.ok(llmRequests.length > reqsBefore3, 'follow-up turn must execute cleanly');

      const transcript = await api.getAgentTranscript({ id: agentId });
      assert.equal(transcript.some(e => e.kind === 'send-message' && e.message?.content === 'Images=1;HasRx=true'), true);
      assert.equal(transcript.some(e => e.kind === 'send-message' && e.message?.content === 'Images=2;HasRx=false'), true);
    } finally {
      await host.dispose();
    }
  });
}

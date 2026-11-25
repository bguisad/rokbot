import test from 'node:test';
import assert from 'node:assert/strict';

import { createAttachmentIngest } from '../runtime/local-harness-bridge.mjs';

const AGENT = '487ddb8b-a062-4bc0-b9b6-814f301db95f';
const AGENT_DIR = `/data/runtime/host-data/agents/${AGENT}`;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');

function fakeLibrary() {
  const contexts = [];
  return {
    contexts,
    createContext: () => ({
      withCancel: () => {
        const ctx = { cancelled: false };
        contexts.push(ctx);
        return [ctx, () => { ctx.cancelled = true; }];
      },
    }),
  };
}

function fakeAttachments() {
  const calls = { ingest: [], upload: [] };
  return {
    calls,
    // Same signature as the 2bb5e41 attachments extension: (agentDir, sourcePath).
    ingest: async (agentDir, sourcePath) => {
      calls.ingest.push([agentDir, sourcePath]);
      if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) throw new Error('Attachment file path is empty.');
      return { absolutePath: `${agentDir}/attachments/preserved.png`, hash: 'preserved', bytes: 1 };
    },
    upload: async (args) => {
      calls.upload.push(args);
      return { path: `${AGENT_DIR}/attachments/${'a'.repeat(64)}.png` };
    },
  };
}

// The box is a separate container: only it can read /workspace.
function fakeRemoteBox(files) {
  const calls = [];
  return {
    calls,
    downloadFile: async (ctx, agentId, boxPath) => {
      calls.push({ ctx, agentId, boxPath });
      const bytes = files.get(boxPath);
      if (!bytes) throw new Error(`Remote file could not be read: ${boxPath}`);
      return new Uint8Array(bytes);
    },
  };
}

test('runner ingestAttachment takes one box path and copies the box file into the agent attachments', async () => {
  const library = fakeLibrary();
  const attachmentsExt = fakeAttachments();
  const remoteBox = fakeRemoteBox(new Map([['/workspace/shots/01-desktop-arranged.png', PNG]]));
  const ingest = createAttachmentIngest({ library, attachmentsExt, remoteBox, agentId: AGENT, agentDir: AGENT_DIR });

  // SendToUser calls ingest(sourcePath) with the posix path of the file:// URL.
  const saved = await ingest('/workspace/shots/01-desktop-arranged.png');
  assert.equal(saved, `${AGENT_DIR}/attachments/${'a'.repeat(64)}.png`);
  assert.equal(remoteBox.calls.length, 1);
  assert.equal(remoteBox.calls[0].agentId, AGENT);
  assert.equal(remoteBox.calls[0].boxPath, '/workspace/shots/01-desktop-arranged.png');
  assert.equal(library.contexts[0].cancelled, true, 'the download context is released');
  assert.deepEqual(attachmentsExt.calls.upload, [{
    agentId: AGENT, filename: '01-desktop-arranged.png', bytesBase64: PNG.toString('base64'),
  }]);
  assert.equal(attachmentsExt.calls.ingest.length, 0);

  assert.equal(typeof await ingest('file:///workspace/shots/01-desktop-arranged.png'), 'string');
});

test('runner ingestAttachment keeps Host files of the agent on the Host ingest path with the agent dir bound', async () => {
  const attachmentsExt = fakeAttachments();
  const remoteBox = fakeRemoteBox(new Map());
  const ingest = createAttachmentIngest({ library: fakeLibrary(), attachmentsExt, remoteBox, agentId: AGENT, agentDir: AGENT_DIR });

  const generated = `${AGENT_DIR}/assets/generated-1.png`;
  assert.equal(await ingest(generated), `${AGENT_DIR}/attachments/preserved.png`);
  assert.deepEqual(attachmentsExt.calls.ingest, [[AGENT_DIR, generated]]);
  assert.equal(remoteBox.calls.length, 0);

  // Without a box the Host ingest still gets (agentDir, sourcePath), never (sourcePath).
  const hostOnly = createAttachmentIngest({ library: fakeLibrary(), attachmentsExt, agentId: AGENT, agentDir: AGENT_DIR });
  await hostOnly('/workspace/out/x.png');
  assert.deepEqual(attachmentsExt.calls.ingest.at(-1), [AGENT_DIR, '/workspace/out/x.png']);
});

test('runner ingestAttachment names the missing box file instead of an empty path', async () => {
  const attachmentsExt = fakeAttachments();
  const ingest = createAttachmentIngest({
    library: fakeLibrary(), attachmentsExt, remoteBox: fakeRemoteBox(new Map()), agentId: AGENT, agentDir: AGENT_DIR,
  });
  await assert.rejects(ingest('/workspace/shots/pwreset-login.png'), (error) => {
    assert.match(error.message, /\/workspace\/shots\/pwreset-login\.png on the box/);
    assert.doesNotMatch(error.message, /path is empty/);
    return true;
  });
  assert.equal(attachmentsExt.calls.upload.length, 0);
  assert.equal(createAttachmentIngest({ library: fakeLibrary(), attachmentsExt: {} }), undefined);
});

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;

if (configuredSeed) {
  test('real 2bb5e41 Host saves SendToUser file:// box images and attachments as agent attachments', async t => {
    const { createServer } = await import('node:http');
    const { createRequire } = await import('node:module');
    const { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const { createExtensionStarter } = await import('../runtime/host-extensions.mjs');
    const { defaultPolicy } = await import('../runtime/model-policy.mjs');
    const { loadRecoveredHostCore } = await import('../runtime/recovered-host-core.mjs');
    const HOST_DIR = resolve(import.meta.dirname, '..');

    const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-send-att-')));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const workSeed = join(stateDir, 'seed');
    await cp(configuredSeed, workSeed, { recursive: true });
    const reliableDir = join(workSeed, 'reliable-core', 'v1');
    await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
    await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
    await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));

    // Box files live outside the Host data root, like /workspace on the box container.
    const boxRoot = join(stateDir, 'box-workspace');
    const shot = join(boxRoot, 'shots', '01-desktop-arranged.png');
    const out = join(boxRoot, 'out', '01-desktop-arranged.png');
    await mkdir(join(boxRoot, 'shots'), { recursive: true });
    await mkdir(join(boxRoot, 'out'), { recursive: true });
    await writeFile(shot, PNG, { mode: 0o644 });
    await writeFile(out, PNG, { mode: 0o644 });
    const missing = join(boxRoot, 'shots', 'gone.png');

    const calls = {
      IMG_TEXT: { name: 'SendToUser', arguments: JSON.stringify({ type: 'text', content: 'shot', images: [{ url: pathToFileURL(shot).href, alt: 'desktop' }] }) },
      IMG_ATTACH: { name: 'SendToUser', arguments: JSON.stringify({ type: 'attachment', url: pathToFileURL(out).href }) },
      IMG_MISSING: { name: 'SendToUser', arguments: JSON.stringify({ type: 'attachment', url: pathToFileURL(missing).href }) },
    };
    const toolResults = [];
    const textOf = message => (Array.isArray(message?.content)
      ? message.content.filter(p => p?.type === 'text').map(p => p.text).join('\n')
      : String(message?.content ?? ''));
    const sse = (res, delta, finish) => res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const llm = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(req.url?.startsWith('/internal/') ? 200 : 404, { 'content-type': 'application/json' });
        res.end('null');
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const messages = Array.isArray(body.messages) ? body.messages : [];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const system = messages.filter(m => m?.role === 'system').map(textOf).join('\n');
      const lastUser = [...messages].reverse().find(m => m?.role === 'user');
      const tools = messages.slice(messages.lastIndexOf(lastUser) + 1).filter(m => m?.role === 'tool');
      if (system.includes('GROK_BOT_MEMORY_EXTRACTION') || tools.length > 0) {
        if (tools.length > 0) toolResults.push(textOf(tools.at(-1)));
        sse(res, { role: 'assistant', content: 'Done.' }, 'stop');
        res.end('data: [DONE]\n\n');
        return;
      }
      const userText = textOf(lastUser);
      const call = Object.entries(calls).find(([key]) => userText.includes(key))?.[1];
      sse(res, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${toolResults.length}`, type: 'function', function: call }] }, null);
      sse(res, {}, 'tool_calls');
      res.end('data: [DONE]\n\n');
    });
    await new Promise(r => llm.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => { llm.closeAllConnections?.(); llm.close(r); }));
    const base = `http://127.0.0.1:${llm.address().port}`;
    const exec = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise(r => exec.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => { exec.closeAllConnections?.(); exec.close(r); }));
    const tokenFile = join(stateDir, 'internal-host-token');
    await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

    const env = {
      ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'), ROKBOT_STATE_DIR: stateDir, ROKBOT_DATA_DIR: stateDir,
      ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile, ROKBOT_INTERNAL_HOST_URL: base, ROKBOT_NOTIFICATION_URL: base,
      ROKBOT_CONNECTORS_URL: `${base}/internal/connectors`, ROKBOT_SHARING_URL: `${base}/internal/sharing`,
      ROKBOT_EXECUTION_URL: `http://127.0.0.1:${exec.address().port}`, ROKBOT_BOX_TOKEN: 'test-box-token',
      SAND_DATA_ROOT: join(stateDir, 'host-data'), SAND_BACKEND_URL: 'http://127.0.0.1:9',
      SAND_DISABLE_TELEMETRY: '1', SAND_DISABLE_ANALYTICS: '1', SAND_HOST_IN_BOX: '1', SAND_PACKAGED: '1', SAND_BOX_MAX_WINDOWS: '1',
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });

    const library = createRequire(import.meta.url)(join(workSeed, 'host-library-reliable.cjs'));
    await loadRecoveredHostCore(library, reliableDir);
    const host = new library.SandHost({
      environment: library.readSandHostEnvironment(process.env),
      startExtensions: createExtensionStarter(library, {
        apiFormat: 'openai', baseUrl: `${base}/v1`, apiKey: 'test-key', model: 'gpt-4o-mini',
        policy: defaultPolicy('gpt-4o-mini'), usageDirectory: join(stateDir, 'usage'), routingDirectory: join(stateDir, 'routing'),
      }),
    });
    try {
      await host.start();
      const api = host.getApi();
      const agentId = (await api.createAgent({ name: 'rokbot', description: 'box attachments' })).agent.id;
      await api.openAgent({ id: agentId });
      const attachmentsDir = join(stateDir, 'host-data', 'agents', agentId, 'attachments');
      const savedFile = async (url) => {
        assert.match(url, /^file:\/\//);
        const path = fileURLToPath(url);
        assert.ok(path.startsWith(`${attachmentsDir}/`), `${path} must be saved under the agent attachments`);
        assert.deepEqual(await readFile(path), PNG);
      };

      for (const [i, prompt] of ['IMG_TEXT', 'IMG_ATTACH', 'IMG_MISSING'].entries()) {
        await api.sendPrompt({ agentId, prompt, clientNonce: `send-att-${i}` });
        await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
      }
      assert.equal(toolResults.length, 3, toolResults.join('\n'));
      for (const result of toolResults) assert.doesNotMatch(result, /path is empty/);
      assert.doesNotMatch(toolResults[0], /Failed to send/);
      assert.doesNotMatch(toolResults[1], /Failed to send/);
      assert.match(toolResults[2], /Failed to send[\s\S]*gone\.png/);

      const sends = (await api.getAgentTranscript({ id: agentId })).filter(e => e.kind === 'send-message');
      const text = sends.find(e => e.message?.type === 'text' && e.message.content === 'shot');
      assert.ok(text, 'the text message with the box image must be sent');
      assert.equal(text.message.images.length, 1);
      await savedFile(text.message.images[0].url);
      const attachment = sends.find(e => e.message?.type === 'attachment');
      assert.ok(attachment, 'the box attachment must be sent');
      await savedFile(attachment.message.url);
      assert.equal(sends.filter(e => e.message?.type === 'attachment').length, 1, 'the missing file sends nothing');
    } finally {
      await host.dispose();
    }
  });
}

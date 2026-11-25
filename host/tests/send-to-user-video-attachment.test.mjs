import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// SendToUser of a box video, end to end: the 2bb5e41 Host saves it as an agent attachment, its gateway
// serves it through readAttachmentChunk, and the desktop and Web/Android resolvers turn it into the
// playable media URL the original renderer's video element needs (before, they only knew images).
const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;

test('real 2bb5e41 Host delivers a SendToUser box video that the desktop and Web clients can play', { skip: !configuredSeed && 'set ROKBOT_TEST_HOST_SEED' }, async t => {
  const { createServer } = await import('node:http');
  const { resolveObjectURL } = await import('node:buffer');
  const { createRequire } = await import('node:module');
  const { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { createExtensionStarter } = await import('../runtime/host-extensions.mjs');
  const { defaultPolicy } = await import('../runtime/model-policy.mjs');
  const { loadRecoveredHostCore } = await import('../runtime/recovered-host-core.mjs');
  const HOST_DIR = resolve(import.meta.dirname, '..');

  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-send-video-')));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const workSeed = join(stateDir, 'seed');
  await cp(configuredSeed, workSeed, { recursive: true });
  const reliableDir = join(workSeed, 'reliable-core', 'v1');
  await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
  await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
  await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));

  // The box file lives outside the Host data root, like /workspace on the box container.
  const boxRoot = join(stateDir, 'box-workspace');
  const clip = join(boxRoot, 'hist-atlas-promo-landscape-720p.mp4');
  await mkdir(boxRoot, { recursive: true });
  // An ISO BMFF header and more than one 4 MiB client chunk.
  const VIDEO = Buffer.concat([Buffer.from('0000002066747970' + '69736f6d00000200' + '69736f6d69736f32' + '617663316d703431', 'hex'),
    randomBytes(4 * 1024 * 1024 + 4321)]);
  await writeFile(clip, VIDEO, { mode: 0o644 });

  const calls = {
    VIDEO_ATTACH: { name: 'SendToUser', arguments: JSON.stringify({ type: 'attachment', url: pathToFileURL(clip).href, alt: 'promo' }) },
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
    const agentId = (await api.createAgent({ name: 'rokbot', description: 'box video' })).agent.id;
    await api.openAgent({ id: agentId });
    await api.sendPrompt({ agentId, prompt: 'VIDEO_ATTACH', clientNonce: 'send-video-0' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);
    assert.equal(toolResults.length, 1, toolResults.join('\n'));
    assert.doesNotMatch(toolResults[0], /Failed to send/);

    const sends = (await api.getAgentTranscript({ id: agentId })).filter(e => e.kind === 'send-message');
    const attachment = sends.find(e => e.message?.type === 'attachment');
    assert.ok(attachment, 'the box video must be sent');
    const { url } = attachment.message;
    const saved = fileURLToPath(url);
    assert.ok(saved.startsWith(join(stateDir, 'host-data', 'agents', agentId, 'attachments') + '/'), saved);
    assert.match(saved, /\.mp4$/, 'the saved copy keeps the video extension');
    assert.deepEqual(await readFile(saved), VIDEO, 'the saved copy is byte-identical to the box file');

    // What the clients ask the Host for (they send the path of the file URL). The image reader cannot serve a video (the old gray box).
    const command = async (method, args) => await api[method](args);
    const probe = await command('readAttachmentChunk', { path: saved, offset: 0, length: 0, videoPlayback: true });
    assert.equal(probe.mime, 'video/mp4');
    assert.equal(probe.totalSize, VIDEO.length);
    const image = await command('readAttachmentImage', { path: saved, rendition: 'preview' }).catch(error => error);
    assert.doesNotMatch(String(image?.dataUrl ?? ''), /^data:image\//);

    const { createAttachmentMediaResolver } = await import('../../mac/clients/desktop/attachments.mjs');
    const mediaDir = join(stateDir, 'client-media');
    const desktop = await createAttachmentMediaResolver({ command, withStaged: async () => null, nativeImage: {}, mediaDir })({ source: url });
    assert.equal(desktop.kind, 'video');
    assert.match(desktop.src, /^file:\/\/.*\.mp4$/);
    assert.deepEqual(await readFile(fileURLToPath(desktop.src)), VIDEO);

    const webStage = join(stateDir, 'web');
    await cp(join(HOST_DIR, '../web/client'), join(webStage, 'client'), { recursive: true });
    await cp(join(HOST_DIR, '../mac/clients/desktop'), join(webStage, 'client/desktop'), { recursive: true });
    const { createAttachments, createStaging } = await import(pathToFileURL(join(webStage, 'client/services.js')).href);
    const web = await createAttachments({ command, staging: createStaging(), onProgress: () => {} }).resolveAttachmentMedia({ source: url });
    assert.equal(web.kind, 'video');
    const blob = resolveObjectURL(web.src);
    assert.equal(blob.type, 'video/mp4');
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), VIDEO);
  } finally {
    await host.dispose();
  }
});

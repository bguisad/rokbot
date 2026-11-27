// Drives a real 2bb5e41 Host (materialized from the pinned archive or a seed directory) with a
// scripted model that calls WriteCanvas and then EditCanvas. Used by local-canvas.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';
import { defaultPolicy } from '../runtime/model-policy.mjs';
import { CanvasStore } from '../server/canvas-store.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');

async function materializeSeed(stateDir, { seed, archive }) {
  let seedDir = seed;
  if (!seedDir) {
    const out = join(stateDir, 'materialized');
    const res = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
      [join(HOST_DIR, 'release/patch-host.py'), '--archive', archive, '--output', out], { encoding: 'utf8', timeout: 120_000 });
    assert.ifError(res.error);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    seedDir = join(out, 'seed');
  }
  const workSeed = join(stateDir, 'seed');
  await cp(seedDir, workSeed, { recursive: true });
  const reliableDir = join(workSeed, 'reliable-core', 'v1');
  await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
  await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
  await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));
  return { workSeed, reliableDir };
}

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)));
const closeServer = (server) => new Promise((done) => { server.closeAllConnections?.(); server.close(done); });

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
function toolCalls(res, calls) {
  sse(res, [
    ...calls.map((tc, index) => ({ id: `tc-${index}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}),
      tool_calls: [{ index, id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] }, finish_reason: null }] })),
    { id: 'tc-end', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
}
function text(res, content) {
  sse(res, [
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]);
}

function offeredTools(body) {
  const native = (body.tools ?? []).map((tool) => (tool.function ?? tool).name);
  const all = (body.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const ns = all.match(/<namespace name="cursor" tools="([^"]*)"/);
  return [...new Set([...native, ...(ns ? ns[1].split(',').map((n) => n.trim()) : [])])];
}

const toolMessage = (request, id) => {
  const msg = (request.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id);
  assert.ok(msg, `Missing tool result message for ${id}`);
  return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
};

/** Invoke a tool natively when offered natively, otherwise through the cursor namespace. */
function call(offered, nativeNames, id, name, args) {
  return nativeNames.includes(name)
    ? { id, name, arguments: args }
    : { id, name: 'CallDynamicTool', arguments: { namespace: 'cursor', toolName: name, arguments: args } };
}

export async function runHostCanvasScenario(t, { seed, archive, source, publicUrl = 'https://rokbot.example' }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'rokbot-canvas-e2e-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { workSeed, reliableDir } = await materializeSeed(stateDir, { seed, archive });
  const tokenFile = join(stateDir, 'internal-host-token');
  await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

  const requests = [];
  let step = 0, canvasId;
  const modelServer = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (JSON.stringify(body.messages ?? []).includes('Auto-review security classifier')) {
        const fn = body.tools?.[0]?.function ?? {};
        const args = { decision: 'ALLOW', blocked_effect: 'none', reason: 'allowed in test' };
        for (const key of fn.parameters?.required ?? []) if (!(key in args)) args[key] = fn.parameters.properties?.[key]?.enum?.[0] ?? 'none';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'r', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant',
          tool_calls: [{ id: 'rc', type: 'function', function: { name: fn.name ?? 'classify_sand_auto_review_action', arguments: JSON.stringify(args) } }] } }] }));
        return;
      }
      requests.push(body);
      const offered = offeredTools(requests[0]);
      const nativeNames = (requests[0].tools ?? []).map((tool) => (tool.function ?? tool).name);
      step += 1;
      if (step === 1) {
        return toolCalls(res, [call(offered, nativeNames, 'call-write', 'WriteCanvas', { title: 'E2E 画布', contents: source })]);
      }
      if (step === 2) {
        canvasId = /canvas_id: ([0-9a-f-]{36})/.exec(toolMessage(body, 'call-write'))?.[1];
        return toolCalls(res, [call(offered, nativeNames, 'call-edit', 'EditCanvas', {
          canvas_id: canvasId, old_string: '数据来源：示例数据', new_string: '数据来源：E2E 已更新',
        })]);
      }
      if (step === 3) {
        return toolCalls(res, [{ id: 'call-send', name: 'SendToUser', arguments: { type: 'text', content: '画布已生成。', end_turn: true } }]);
      }
      return text(res, 'done');
    }
    if (req.url === '/internal/connectors/runtime') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revision: 0, config: { mcpServers: {} }, display: { servers: [] } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('null');
  });
  const modelBase = await listen(modelServer);
  t.after(() => closeServer(modelServer));
  const execServer = createServer(async (req, res) => {
    for await (const _ of req) {}
    if ((req.headers['content-type'] || '').includes('application/connect+proto')) {
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.end(Buffer.from([2, 0, 0, 0, 2, 0x7b, 0x7d]));
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }
  });
  const execBase = await listen(execServer);
  t.after(() => closeServer(execServer));

  const env = {
    ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'), ROKBOT_STATE_DIR: stateDir, ROKBOT_DATA_DIR: stateDir,
    ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile, ROKBOT_NOTIFICATION_URL: modelBase,
    ROKBOT_CONNECTORS_URL: `${modelBase}/internal/connectors`, ROKBOT_SHARING_URL: `${modelBase}/internal/sharing`,
    ROKBOT_EXECUTION_URL: execBase, ROKBOT_BOX_TOKEN: 'test-box-token', ROKBOT_PUBLIC_URL: publicUrl,
    SAND_DATA_ROOT: join(stateDir, 'host-data'), SAND_BACKEND_URL: 'http://127.0.0.1:9', SAND_DISABLE_TELEMETRY: '1',
    SAND_DISABLE_ANALYTICS: '1', SAND_HOST_IN_BOX: '1', SAND_PACKAGED: '1', SAND_BOX_MAX_WINDOWS: '1',
  };
  const previous = new Map();
  for (const [k, v] of Object.entries(env)) { previous.set(k, process.env[k]); process.env[k] = v; }
  const restore = () => { for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

  const library = createRequire(import.meta.url)(join(workSeed, 'host-library-reliable.cjs'));
  let host;
  try {
    await loadRecoveredHostCore(library, reliableDir);
    const modelConfig = { apiFormat: 'openai', baseUrl: `${modelBase}/v1`, apiKey: 'test-key', model: 'gpt-4o-mini',
      policy: defaultPolicy('gpt-4o-mini'), usageDirectory: join(stateDir, 'usage'), routingDirectory: join(stateDir, 'routing') };
    host = new library.SandHost({ environment: library.readSandHostEnvironment(process.env), startExtensions: createExtensionStarter(library, modelConfig) });
    await host.start();
    const api = host.getApi();
    const created = await api.createAgent({ name: 'Canvas Bot', description: 'Local canvas e2e' });
    const agentId = created.agent.id;
    await api.openAgent({ id: agentId });
    await api.sendPrompt({ agentId, prompt: '做一个订单看板画布', clientNonce: 'canvas-e2e-1' });
    await host.transcript.runLifecycle.drainExclusiveRuns(agentId);

    assert.ok(requests.length >= 3, `expected the canvas tool round-trips, got ${requests.length} model requests`);
    const store = new CanvasStore(stateDir);
    const canvases = await store.list({ agentId });
    return {
      offered: offeredTools(requests[0]),
      toolDescriptions: JSON.stringify(requests[0].tools ?? []),
      writeResult: toolMessage(requests[1], 'call-write'),
      editResult: toolMessage(requests[2], 'call-edit'),
      canvases,
      canvasDir: canvases[0] ? store.dir(canvases[0].id) : null,
      source: canvases[0] ? await readFile(join(store.dir(canvases[0].id), 'source.canvas.tsx'), 'utf8') : '',
    };
  } finally {
    try { await host?.dispose(); } catch {}
    restore();
  }
}

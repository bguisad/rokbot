// Regression: Host startup stalled at "[sand-host] starting extension mcp" while the
// remote execution box was still booting. The original Exec client waits up to 90s
// per call for box:1337, and the local MCP extension awaited that before returning,
// which blocked the whole extension graph, the Host gateway and model reloads.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalHostMcp } from '../runtime/host-mcp.mjs';

async function pollUntil(fn, { timeoutMs = 5_000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Minimal stand-in for the original Host library around the box Exec client. */
function fakeLibrary(box) {
  const calls = { listTools: 0, loadServers: [], restarts: 0, disposed: 0 };
  const library = {
    createBoxSandMcpExec: () => ({
      listTools: async () => { calls.listTools++; return box.listTools(); },
      loadServers: async value => { calls.loadServers.push(JSON.parse(value)); return {}; },
      executeTool: async () => { throw new Error('not used'); },
    }),
    createHostMcp: () => ({
      management: { restart: async () => { calls.restarts++; } },
      plugins: { listServers: async () => ({ servers: [] }) },
      mcp: { getCustomInstructions: async () => new Map() },
      listBoxServers: async () => [],
      noteAuthCompletedElsewhere() {},
      dispose: async () => { calls.disposed++; },
    }),
    createContext: () => ({}),
  };
  return { library, calls };
}

async function harness(t, box, files = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'rokbot-mcp-startup-'));
  const tokenFile = join(stateDir, 'internal-token');
  await writeFile(tokenFile, 'x'.repeat(43));
  for (const [name, value] of Object.entries(files)) await writeFile(join(stateDir, name), value);
  const saved = {};
  const env = {
    ROKBOT_STATE_DIR: stateDir,
    ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile,
    ROKBOT_SHARING_URL: 'http://127.0.0.1:9/sharing',
    ROKBOT_CONNECTORS_URL: undefined, GROKBOT_CONNECTORS_URL: undefined,
    ROKBOT_NATIVE_DESKTOP_URL: undefined, GROKBOT_NATIVE_DESKTOP_URL: undefined,
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const stops = [], logs = [];
  const context = {
    host: { log: message => logs.push(message) },
    deps: { 'forever-box': { box: {} }, settings: {}, 'local-tool-permission': null },
    onStop: fn => stops.push(fn),
  };
  const { library, calls } = fakeLibrary(box);
  const stop = async () => { for (const fn of stops.splice(0)) await fn(); };
  t.after(async () => {
    await stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(stateDir, { recursive: true, force: true });
  });
  const status = async () => JSON.parse(await readFile(join(stateDir, 'mcp-status.json'), 'utf8').catch(() => 'null'));
  return { stateDir, context, library, calls, logs, stop, status };
}

test('local MCP extension starts without waiting for an unreachable execution box', async t => {
  const box = deferred();
  const h = await harness(t, { listTools: () => box.promise });
  const started = Date.now();
  const api = await Promise.race([
    startLocalHostMcp(h.context, h.library, { applyRetryMs: 20, applyRetryMaxMs: 40 }),
    delay(2_000).then(() => { throw new Error('startLocalHostMcp blocked on the execution box'); }),
  ]);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(typeof api.mcp, 'object');
  assert.equal(typeof api.management.restart, 'function');
  const pending = await h.status();
  assert.equal(pending.ready, false);
  assert.equal(pending.pending, true);
  assert.equal(pending.pid, process.pid);
  assert.equal(h.calls.loadServers.length, 0, 'registry must not be pushed before Exec answers');

  // Box finishes booting: the queued configuration is applied in the background.
  box.resolve([]);
  const applied = await pollUntil(async () => { const s = await h.status(); return s?.ready ? s : null; },
    { label: 'background MCP configuration apply' });
  assert.equal(applied.revision, 1);
  assert.deepEqual(h.calls.loadServers.at(-1), { mcpServers: {} });
  assert.ok(h.logs.some(line => line.includes('configuration applied: revision=1')));
});

test('failed MCP applies are retried with backoff until the box answers', async t => {
  let attempts = 0;
  const h = await harness(t, {
    listTools: async () => {
      attempts++;
      if (attempts < 3) throw new Error('loopback sand box exec-daemon at box:1337 not ready within 90000ms');
      return [];
    },
  }, { 'mcp.json': JSON.stringify({ mcpServers: { files: { command: 'node', args: ['server.mjs'] } } }) });
  await startLocalHostMcp(h.context, h.library, { applyRetryMs: 10, applyRetryMaxMs: 40 });
  const applied = await pollUntil(async () => { const s = await h.status(); return s?.ready ? s : null; },
    { label: 'MCP retry success' });
  assert.equal(attempts, 3);
  assert.equal(applied.revision, 1);
  assert.deepEqual(h.calls.loadServers.at(-1), { mcpServers: { files: { command: 'node', args: ['server.mjs'] } } });
  assert.equal(h.logs.filter(line => line.includes('configuration rejected')).length, 2);
  assert.deepEqual(JSON.parse(await readFile(join(h.stateDir, 'mcp-last-good.json'), 'utf8')),
    { mcpServers: { files: { command: 'node', args: ['server.mjs'] } } });
});

test('an invalid mcp.json still reports rejection after the retained config applies', async t => {
  const h = await harness(t, { listTools: async () => [] }, {
    'mcp.json': '{not json',
    'mcp-last-good.json': JSON.stringify({ mcpServers: { kept: { command: 'node' } } }),
  });
  await startLocalHostMcp(h.context, h.library, { applyRetryMs: 10 });
  const rejected = await pollUntil(async () => { const s = await h.status(); return s && s.ready === false && s.error ? s : null; },
    { label: 'startup config rejection' });
  assert.equal(rejected.error, 'Local MCP JSON is invalid');
  assert.deepEqual(rejected.retainedServers, ['kept']);
  assert.deepEqual(h.calls.loadServers.at(-1), { mcpServers: { kept: { command: 'node', args: [] } } });
});

test('stopping Host is not held hostage by an apply blocked on the box', async t => {
  const h = await harness(t, { listTools: () => new Promise(() => {}) });
  await startLocalHostMcp(h.context, h.library, { stopDrainMs: 50 });
  await delay(20);
  const started = Date.now();
  await h.stop();
  assert.ok(Date.now() - started < 1_500, `stop took ${Date.now() - started}ms`);
  assert.equal(h.calls.disposed, 1);
});

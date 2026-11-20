import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HostSupervisor } from '../deploy/host-supervisor.mjs';

const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));

async function reservePort() {
  const probe = createNetServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function pollUntil(fn, { timeoutMs = 10_000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last.done) return last.value;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function modelPayload(model) {
  return {
    version: 1,
    providers: [
      {
        id: 'primary',
        name: 'Primary Provider',
        apiFormat: 'openai',
        baseUrl: 'http://127.0.0.1:18999/v1',
        apiKey: 'test-key-reconcile-001',
      },
    ],
    profiles: [
      {
        id: 'fast',
        name: 'Fast Profile',
        providerId: 'primary',
        model,
        efforts: ['low', 'medium'],
        contextWindowTokens: 64000,
        summaryThresholdTokens: 48000,
      },
    ],
    defaultRoute: { profileId: 'fast', effort: 'low', fallbacks: [] },
    botRoutes: {},
  };
}

test('HostSupervisor.wake() interrupts long poll sleep immediately (including mid-tick)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-wake-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let ticks = 0;
  let releaseFirstTick;
  const firstTickInside = new Promise(resolve => { releaseFirstTick = resolve; });
  let continueFirstTick;
  const firstTickGate = new Promise(resolve => { continueFirstTick = resolve; });

  const supervisor = new HostSupervisor({
    dataDir: dir,
    hostUrl: 'http://127.0.0.1:1',
    internalToken: 'tok',
    entry: 'unused.mjs',
    env: {},
    isConfigured: async () => false,
    pollMs: 60_000,
    log: () => {},
  });
  supervisor.tick = async () => {
    ticks++;
    if (ticks === 1) {
      releaseFirstTick();
      await firstTickGate;
    }
  };

  const startedAt = Date.now();
  supervisor.start();
  await firstTickInside;
  // Call wake() mid-tick while sleepController is null: loop must immediately run tick 2 without waiting 60s.
  supervisor.wake();
  continueFirstTick();
  await pollUntil(() => ({ done: ticks >= 2, value: ticks }), { timeoutMs: 2000, intervalMs: 10, label: 'mid-tick wake' });

  // Wait briefly so loop enters delay(60_000), then wake() again.
  await delay(30);
  supervisor.wake();
  await pollUntil(() => ({ done: ticks >= 3, value: ticks }), { timeoutMs: 2000, intervalMs: 10, label: 'sleep wake' });
  assert.ok(Date.now() - startedAt < 5000);
  await supervisor.stop();
});

test('HostSupervisor + createSelfHostServer PUT /local/model live reload lifecycle', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-reconcile-'));
  const childPort = await reservePort();
  const hostUrl = `http://127.0.0.1:${childPort}`;
  const internalToken = 'c'.repeat(40);
  const childEntry = join(dir, 'mock-host-child.mjs');
  const bootLog = join(dir, 'child-boots.jsonl');
  const modelEnvPath = join(dir, 'model.env');

  await writeFile(childEntry, `
import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

const envText = readFileSync(process.env.ROKBOT_MODEL_ENV, 'utf8');
const values = Object.fromEntries(
  envText.split(/\\r?\\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
    const idx = l.indexOf('=');
    return [l.slice(0, idx), l.slice(idx + 1)];
  }),
);
const model = values.OPENAI_MODEL || '';
appendFileSync(process.env.TEST_BOOT_LOG, JSON.stringify({ pid: process.pid, model }) + '\\n');
if (model === 'crash-on-boot') {
  process.exit(2);
}
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + process.env.TEST_INTERNAL_TOKEN) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid, isBusy: false }));
    return;
  }
  if (req.method === 'POST' && req.url === '/prepare-upgrade') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ quiescing: true, runningTurns: 0 }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(Number(process.env.TEST_CHILD_PORT), '127.0.0.1');
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 250).unref();
  });
}
`);

  let supervisor;
  const host = await createSelfHostServer({
    dataDir: dir,
    modelFile: modelEnvPath,
    hostUrl,
    vncUrl: hostUrl,
    forkVncUrl: hostUrl,
    internalToken,
    computers: () => supervisor?.getComputers() ?? { available: false, computers: [] },
    onModelSaved: () => supervisor?.wake(),
  });
  await host.start(0, '127.0.0.1');
  supervisor = new HostSupervisor({
    dataDir: dir,
    hostUrl,
    internalToken,
    entry: childEntry,
    env: {
      ...process.env,
      ROKBOT_MODEL_ENV: modelEnvPath,
      TEST_CHILD_PORT: String(childPort),
      TEST_BOOT_LOG: bootLog,
      TEST_INTERNAL_TOKEN: internalToken,
    },
    isConfigured: async () => {
      const m = await host.models.currentOrEmpty();
      return Boolean(m.baseUrl && m.apiKey && m.model);
    },
    pollMs: 120,
    retryMs: 30_000,
    stopMs: 2000,
    startupMs: 5000,
    log: () => {},
  }).start();

  t.after(async () => {
    await supervisor.stop();
    await host.close();
    await rm(dir, { recursive: true, force: true });
  });

  await host.auth.setup(host.auth.setupKey, 'AdminPass1234');
  const { token } = await host.auth.pair({
    password: 'AdminPass1234',
    deviceName: 'Reconcile Device',
    platform: 'desktop',
  });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const call = (path, { method = 'GET', body } = {}) => fetch(origin + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // 1. First PUT /local/model triggers HostSupervisor start -> waiting -> applied
  const put1Res = await call('/local/model', { method: 'PUT', body: modelPayload('model-v1') });
  assert.equal(put1Res.status, 200);
  const put1 = await put1Res.json();
  assert.equal(put1.reload.status, 'waiting');
  const rev1 = put1.reload.revision;
  assert.ok(rev1);

  const applied1 = await pollUntil(async () => {
    const body = await (await call('/local/model')).json();
    return { done: body.reload.status === 'applied' && body.reload.revision === rev1, value: body };
  }, { label: 'first reload applied' });
  assert.equal(applied1.reload.error, null);

  // 2. Second PUT /local/model triggers /prepare-upgrade, stops & restarts child with updated ROKBOT_MODEL_ENV
  const put2Res = await call('/local/model', { method: 'PUT', body: modelPayload('model-v2') });
  assert.equal(put2Res.status, 200);
  const put2 = await put2Res.json();
  const rev2 = put2.reload.revision;
  assert.notEqual(rev2, rev1);
  assert.equal(put2.reload.status, 'waiting');

  const applied2 = await pollUntil(async () => {
    const body = await (await call('/local/model')).json();
    return { done: body.reload.status === 'applied' && body.reload.revision === rev2, value: body };
  }, { label: 'second reload applied' });
  assert.equal(applied2.reload.error, null);

  const boots = (await readFile(bootLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(boots.length, 2);
  assert.equal(boots[0].model, 'model-v1');
  assert.equal(boots[1].model, 'model-v2');
  assert.notEqual(boots[0].pid, boots[1].pid);

  // 3. Corrupt model-reload-request.json and empty revision do not crash HostSupervisor.tick()
  await supervisor.stop();
  await writeFile(join(dir, 'model-reload-request.json'), '{not-json');
  await assert.doesNotReject(() => supervisor.tick());
  await writeFile(join(dir, 'model-reload-request.json'), JSON.stringify({ revision: '' }));
  await assert.doesNotReject(() => supervisor.tick());

  // 4. Corrupt model.env degrades cleanly via currentOrEmpty()
  await writeFile(modelEnvPath, 'ROKBOT_MODEL_ROUTING={broken\n');
  assert.equal(await supervisor.isConfigured(), false);

  // 5. Child non-zero exit produces reload.status === 'error' with non-empty error matching revision
  const sup2 = new HostSupervisor({
    dataDir: dir,
    hostUrl,
    internalToken,
    entry: childEntry,
    env: {
      ...process.env,
      ROKBOT_MODEL_ENV: modelEnvPath,
      TEST_CHILD_PORT: String(childPort),
      TEST_BOOT_LOG: bootLog,
      TEST_INTERNAL_TOKEN: internalToken,
    },
    isConfigured: async () => {
      const m = await host.models.currentOrEmpty();
      return Boolean(m.baseUrl && m.apiKey && m.model);
    },
    pollMs: 120,
    retryMs: 30_000,
    stopMs: 2000,
    startupMs: 5000,
    log: () => {},
  });
  supervisor = sup2.start();
  t.after(() => sup2.stop());

  const putCrash = await (await call('/local/model', { method: 'PUT', body: modelPayload('crash-on-boot') })).json();
  const crashRev = putCrash.reload.revision;
  const errored = await pollUntil(async () => {
    const body = await (await call('/local/model')).json();
    return { done: body.reload.status === 'error' && body.reload.revision === crashRev, value: body };
  }, { label: 'child crash error status' });
  assert.equal(typeof errored.reload.error, 'string');
  assert.ok(errored.reload.error.length > 0);
});

test('/admin/ trailing slash and HEAD static page/asset routes return 200 with root-relative assets', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-admin-slash-'));
  const host = await createSelfHostServer({
    dataDir: dir,
    hostUrl: 'http://127.0.0.1:1',
    vncUrl: 'http://127.0.0.1:1',
    forkVncUrl: 'http://127.0.0.1:1',
    internalToken: 'd'.repeat(40),
  });
  await host.start(0, '127.0.0.1');
  t.after(async () => {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  for (const path of ['/admin', '/admin/', '/']) {
    const getRes = await fetch(`${origin}${path}`);
    assert.equal(getRes.status, 200, `GET ${path}`);
    assert.match(getRes.headers.get('content-type') ?? '', /text\/html/);
    const html = await getRes.text();
    assert.match(html, /src="\/app\.js"/);
    assert.match(html, /href="\/rokbot-icon\.png"/);

    const headRes = await fetch(`${origin}${path}`, { method: 'HEAD' });
    assert.equal(headRes.status, 200, `HEAD ${path}`);
    assert.ok(Number(headRes.headers.get('content-length')) > 0);
    assert.equal(await headRes.text(), '');
  }
  const headJs = await fetch(`${origin}/updates.js`, { method: 'HEAD' });
  assert.equal(headJs.status, 200);
  assert.match(headJs.headers.get('content-type') ?? '', /text\/javascript/);
});

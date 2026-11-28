import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ResilientSearchIndexService,
  SAND_SEARCH_INDEX_FILE_NAME,
  findAgentContentMatches,
  openSearchIndexDb,
  startLocalContentSearch,
  wrapPublishTranscriptMutation,
} from '../runtime/content-search.mjs';
import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';
import { defaultPolicy } from '../runtime/model-policy.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');

function writeReconcileDoneMeta(indexDbPath) {
  const db = new DatabaseSync(indexDbPath);
  try {
    db.exec("INSERT INTO meta (key, value) VALUES ('reconcile_done', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
  } finally {
    db.close();
  }
}

function createFakePorts({
  onJob,
  onQuery,
  indexDbPath,
} = {}) {
  const jobCalls = [];
  const queryCalls = [];
  const createJobPort = (config) => ({
    async post(job) {
      jobCalls.push(job);
      if (onJob) return onJob(job, config, jobCalls.length);
      if (job.kind === 'reconcile' && indexDbPath) {
        writeReconcileDoneMeta(indexDbPath);
      }
      return { ok: true };
    },
    async terminate() {},
  });
  const createQueryPort = (config) => ({
    async searchMessages(query, limit) {
      queryCalls.push({ kind: 'messages', query, limit });
      if (onQuery) return onQuery({ kind: 'messages', query, limit }, config, queryCalls.length);
      return { ok: true, answer: [] };
    },
    async searchMedia(query, limit) {
      queryCalls.push({ kind: 'media', query, limit });
      if (onQuery) return onQuery({ kind: 'media', query, limit }, config, queryCalls.length);
      return { ok: true, answer: [{ agentId: 'a1', entryId: 'e1', fileName: 'report.pdf', ext: '.pdf', mime: 'application/pdf', kind: 'pdf', timestampMs: 1000, width: null, height: null }] };
    },
    async searchConversation(query) {
      queryCalls.push({ kind: 'conversation', ...query });
      if (onQuery) return onQuery({ kind: 'conversation', ...query }, config, queryCalls.length);
      return { ok: true, answer: { matches: [], isComplete: true } };
    },
    async terminate() {},
  });
  return { createJobPort, createQueryPort, jobCalls, queryCalls };
}

test('empty or corrupt search-index.db automatically recovers to searchable state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-search-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agentsDir = join(dir, 'agents');
  await mkdir(agentsDir, { recursive: true });

  // 1. Empty (non-existent) DB -> reconciles and becomes ready
  const emptyDbPath = join(dir, 'empty-search-index.db');
  const emptyEvents = [];
  const emptyPorts = createFakePorts({ indexDbPath: emptyDbPath });
  const emptySvc = new ResilientSearchIndexService({
    indexDbPath: emptyDbPath,
    agentsRootDir: agentsDir,
    createJobPort: emptyPorts.createJobPort,
    createQueryPort: emptyPorts.createQueryPort,
    report: (ev) => emptyEvents.push(ev),
  });
  t.after(() => emptySvc.dispose());

  emptySvc.start();
  await emptySvc.whenIdle();

  assert.equal(emptySvc.isSearchReady, true);
  assert.equal(emptySvc.getHealth().ready, true);
  assert.equal(emptySvc.getHealth().reconcileDone, true);
  const media = await emptySvc.searchMedia('report', 10);
  assert.equal(Array.isArray(media), true);
  assert.equal(media.length, 1);
  assert.equal(emptyEvents.some((e) => e.kind === 'ready'), true);

  // 2. Corrupt DB file on disk -> recreates fresh schema, notifies invalidation, reconciles, becomes searchable
  const corruptDbPath = join(dir, 'corrupt-search-index.db');
  await writeFile(corruptDbPath, Buffer.from('THIS IS NOT A VALID SQLITE DATABASE FILE!!!'));
  const invalidations = [];
  const corruptEvents = [];
  const corruptPorts = createFakePorts({ indexDbPath: corruptDbPath });
  const corruptSvc = new ResilientSearchIndexService({
    indexDbPath: corruptDbPath,
    agentsRootDir: agentsDir,
    createJobPort: corruptPorts.createJobPort,
    createQueryPort: corruptPorts.createQueryPort,
    report: (ev) => corruptEvents.push(ev),
  });
  t.after(() => corruptSvc.dispose());
  corruptSvc.serverTranscripts.subscribeInvalidated((scope) => invalidations.push(scope));

  corruptSvc.start();
  await corruptSvc.whenIdle();

  assert.equal(corruptSvc.isSearchReady, true);
  assert.deepEqual(invalidations, ['all']);
  assert.equal(corruptEvents.some((e) => e.kind === 'stage_failed' && e.stage === 'open'), true);
  assert.equal(corruptEvents.some((e) => e.kind === 'ready'), true);
  const conv = await corruptSvc.searchConversation({ agentId: 'a1', query: 'hello', limit: 10 });
  assert.deepEqual(conv, { matches: [], isComplete: true });
});

test('runtime index-unreadable query triggers rebuild + reconcile and recovers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-search-rebuild-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexDbPath = join(dir, SAND_SEARCH_INDEX_FILE_NAME);
  const events = [];
  let queryAttempts = 0;

  const ports = createFakePorts({
    indexDbPath,
    onQuery: async (q) => {
      queryAttempts += 1;
      if (queryAttempts === 1) {
        return { ok: false, reason: 'index-unreadable', message: 'database disk image is malformed' };
      }
      return { ok: true, answer: [{ agentId: 'a1', entryId: 'e1', fileName: 'recovered.png', ext: '.png', mime: 'image/png', kind: 'image', timestampMs: 2000, width: 10, height: 10 }] };
    },
  });

  const svc = new ResilientSearchIndexService({
    indexDbPath,
    agentsRootDir: join(dir, 'agents'),
    createJobPort: ports.createJobPort,
    createQueryPort: ports.createQueryPort,
    report: (ev) => events.push(ev),
  });
  t.after(() => svc.dispose());

  svc.start();
  await svc.whenIdle();
  assert.equal(svc.isSearchReady, true);

  // First query reports index-unreadable -> schedules rebuild + reconcile
  const first = await svc.searchMedia('recovered', 10);
  assert.equal(first, null);
  await svc.whenIdle();

  assert.equal(events.some((e) => e.kind === 'corrupt_rebuild'), true);
  assert.equal(svc.isSearchReady, true);
  const second = await svc.searchMedia('recovered', 10);
  assert.equal(second?.length, 1);
  assert.equal(second[0].fileName, 'recovered.png');
});

test('start() openAndMigrate transient failure retries with backoff and recovers without wiping healthy DB', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-search-open-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexDbPath = join(dir, SAND_SEARCH_INDEX_FILE_NAME);
  const events = [];
  let openAttempts = 0;

  // Pre-seed a healthy DB with reconcile_done=1
  const seedSvc = new ResilientSearchIndexService({
    indexDbPath,
    agentsRootDir: join(dir, 'agents'),
    ...createFakePorts({ indexDbPath }),
  });
  seedSvc.start();
  await seedSvc.whenIdle();
  await seedSvc.dispose();

  const ports = createFakePorts({ indexDbPath });
  const svc = new ResilientSearchIndexService({
    indexDbPath,
    agentsRootDir: join(dir, 'agents'),
    createJobPort: ports.createJobPort,
    createQueryPort: ports.createQueryPort,
    openRetryDelaysMs: [15, 25, 40],
    openDb: (dbPath) => {
      openAttempts += 1;
      if (openAttempts <= 2) {
        const err = new Error('database is locked');
        err.code = 'SQLITE_BUSY';
        err.errcode = 5;
        throw err;
      }
      return openSearchIndexDb(dbPath);
    },
    report: (ev) => events.push(ev),
  });
  t.after(() => svc.dispose());

  svc.start();
  assert.equal(svc.isSearchReady, false);
  assert.equal(svc.getHealth().openRetryCount, 1);

  // Wait for backoff retries to succeed
  const deadline = Date.now() + 2000;
  while (!svc.isSearchReady && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  await svc.whenIdle();

  assert.equal(openAttempts, 3);
  assert.equal(svc.isSearchReady, true);
  assert.equal(svc.getHealth().unavailable, false);
  assert.equal(events.filter((e) => e.kind === 'open_retry').length, 2);
  assert.deepEqual(
    events.filter((e) => e.kind === 'open_retry').map((e) => e.delayMs),
    [15, 25],
  );
  const media = await svc.searchMedia('report', 10);
  assert.equal(media?.length, 1);
});

test('reconcile failing once (job failure or worker lost) retries and sets isSearchReady=true', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-search-reconcile-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Case A: transient non-corrupt failure on 1st reconcile, success on 2nd
  const dbPathA = join(dir, 'a.db');
  const eventsA = [];
  let reconcileAttemptsA = 0;
  const portsA = createFakePorts({
    indexDbPath: dbPathA,
    onJob: async (job) => {
      if (job.kind === 'reconcile') {
        reconcileAttemptsA += 1;
        if (reconcileAttemptsA === 1) {
          return { ok: false, message: 'SQLITE_BUSY on agent store', isIndexCorrupt: false, isWorkerUnavailable: false };
        }
        // Note: intentionally do NOT write meta.reconcile_done to verify dispatchJob still marks isReconcileDone=true
        return { ok: true };
      }
      return { ok: true };
    },
  });
  const svcA = new ResilientSearchIndexService({
    indexDbPath: dbPathA,
    agentsRootDir: join(dir, 'agents'),
    createJobPort: portsA.createJobPort,
    createQueryPort: portsA.createQueryPort,
    report: (ev) => eventsA.push(ev),
  });
  t.after(() => svcA.dispose());

  svcA.start();
  await svcA.whenIdle();

  assert.equal(reconcileAttemptsA, 2);
  assert.equal(svcA.isSearchReady, true);
  assert.equal(svcA.getHealth().reconcileDone, true);
  assert.equal(eventsA.some((e) => e.kind === 'job_reconcile'), true);
  assert.equal(eventsA.some((e) => e.kind === 'ready'), true);

  // Case B: worker lost on 1st reconcile, respawned and succeeds on 2nd
  const dbPathB = join(dir, 'b.db');
  const eventsB = [];
  let reconcileAttemptsB = 0;
  const portsB = createFakePorts({
    indexDbPath: dbPathB,
    onJob: async (job) => {
      if (job.kind === 'reconcile') {
        reconcileAttemptsB += 1;
        if (reconcileAttemptsB === 1) {
          return { ok: false, message: 'worker exited (1)', isIndexCorrupt: false, isWorkerUnavailable: true };
        }
        writeReconcileDoneMeta(dbPathB);
        return { ok: true };
      }
      return { ok: true };
    },
  });
  const svcB = new ResilientSearchIndexService({
    indexDbPath: dbPathB,
    agentsRootDir: join(dir, 'agents'),
    createJobPort: portsB.createJobPort,
    createQueryPort: portsB.createQueryPort,
    report: (ev) => eventsB.push(ev),
  });
  t.after(() => svcB.dispose());

  svcB.start();
  await svcB.whenIdle();

  assert.equal(reconcileAttemptsB, 2);
  assert.equal(svcB.isSearchReady, true);
  assert.equal(eventsB.some((e) => e.kind === 'worker_respawn'), true);
});

test('markUnavailable self-heals on next request (on-demand) and via periodic recovery timer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-search-selfheal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Case A: On-demand recovery when next request arrives after markUnavailable
  const dbPathA = join(dir, 'ondemand.db');
  const eventsA = [];
  let nowMs = 100_000;
  let failWorker = true;
  const portsA = createFakePorts({
    indexDbPath: dbPathA,
    onJob: async (job) => {
      if (failWorker) {
        return { ok: false, message: 'startup contention', isIndexCorrupt: false, isWorkerUnavailable: true };
      }
      if (job.kind === 'reconcile') writeReconcileDoneMeta(dbPathA);
      return { ok: true };
    },
  });
  const svcA = new ResilientSearchIndexService({
    indexDbPath: dbPathA,
    agentsRootDir: join(dir, 'agents'),
    createJobPort: portsA.createJobPort,
    createQueryPort: portsA.createQueryPort,
    recoveryDelaysMs: [60_000], // long periodic timer so we specifically test on-demand trigger
    onDemandRecoveryCooldownMs: 1000,
    now: () => nowMs,
    report: (ev) => eventsA.push(ev),
  });
  t.after(() => svcA.dispose());

  svcA.start();
  await svcA.whenIdle();

  assert.equal(svcA.getHealth().unavailable, true);
  assert.equal(eventsA.some((e) => e.kind === 'unavailable'), true);

  // Contention clears; advance clock past cooldown and simulate incoming /api/searchMedia check
  failWorker = false;
  nowMs += 5000;
  // First check triggers on-demand reopen + reconcile
  svcA.isSearchReady;
  await svcA.whenIdle();

  assert.equal(svcA.getHealth().unavailable, false);
  assert.equal(svcA.isSearchReady, true);
  assert.equal(eventsA.some((e) => e.kind === 'recovery_started' && e.stage === 'on-demand'), true);
  assert.equal(eventsA.some((e) => e.kind === 'recovered'), true);
  const resultsA = await svcA.searchMedia('report', 10);
  assert.equal(resultsA?.length, 1);

  // Case A2: If reconcile_done=1 is ALREADY on disk when markUnavailable happens (production scenario!),
  // on-demand recovery makes isSearchReady=true IMMEDIATELY on the very request!
  failWorker = true;
  svcA.markUnavailable('worker-respawn', new Error('transient crash'));
  assert.equal(svcA.getHealth().unavailable, true);

  failWorker = false;
  nowMs += 5000;
  assert.equal(svcA.isSearchReady, true, 'existing reconcile_done=1 DB should become ready immediately on demand');
  const immediateMedia = await svcA.searchMedia('report', 10);
  assert.equal(immediateMedia?.length, 1);
  await svcA.whenIdle();

  // Case B: Periodic timer recovery after markUnavailable
  const dbPathB = join(dir, 'periodic.db');
  const eventsB = [];
  let failOpenB = true;
  const portsB = createFakePorts({ indexDbPath: dbPathB });
  const svcB = new ResilientSearchIndexService({
    indexDbPath: dbPathB,
    agentsRootDir: join(dir, 'agents'),
    createJobPort: portsB.createJobPort,
    createQueryPort: portsB.createQueryPort,
    openRetryDelaysMs: [10],
    maxOpenRetries: 1,
    recoveryDelaysMs: [20, 30],
    openDb: (p) => {
      if (failOpenB) {
        const err = new Error('temporarily locked');
        err.code = 'SQLITE_BUSY';
        err.errcode = 5;
        throw err;
      }
      return openSearchIndexDb(p);
    },
    report: (ev) => eventsB.push(ev),
  });
  t.after(() => svcB.dispose());

  svcB.start();
  const waitUnavailableDeadline = Date.now() + 2000;
  while (!svcB.getHealth().unavailable && Date.now() < waitUnavailableDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(svcB.getHealth().unavailable, true);

  // Clear open failure; periodic timer should recover without any request arriving
  failOpenB = false;
  const waitRecoveredDeadline = Date.now() + 2000;
  while (!svcB.getHealth().ready && Date.now() < waitRecoveredDeadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  await svcB.whenIdle();

  assert.equal(svcB.getHealth().unavailable, false);
  assert.equal(svcB.getHealth().ready, true);
  assert.equal(eventsB.some((e) => e.kind === 'recovery_started' && e.stage === 'periodic'), true);
  assert.equal(eventsB.some((e) => e.kind === 'recovered'), true);
});

test('pendingReindexCount never leaks across retries, failures, or markUnavailable recovery', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-search-pending-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexDbPath = join(dir, SAND_SEARCH_INDEX_FILE_NAME);
  let reindexAttempts = 0;

  const ports = createFakePorts({
    indexDbPath,
    onJob: async (job) => {
      if (job.kind === 'reconcile') {
        writeReconcileDoneMeta(indexDbPath);
        return { ok: true };
      }
      if (job.kind === 'reindex-agents') {
        reindexAttempts += 1;
        if (reindexAttempts === 1) {
          return { ok: false, message: 'transient reindex failure', isIndexCorrupt: false, isWorkerUnavailable: false };
        }
        return { ok: true };
      }
      return { ok: true };
    },
  });

  const svc = new ResilientSearchIndexService({
    indexDbPath,
    agentsRootDir: join(dir, 'agents'),
    createJobPort: ports.createJobPort,
    createQueryPort: ports.createQueryPort,
    onDemandRecoveryCooldownMs: 0,
  });
  t.after(() => svc.dispose());

  svc.start();
  await svc.whenIdle();
  assert.equal(svc.isSearchReady, true);
  assert.equal(svc.pendingReindexCount, 0);

  // Trigger reindex that fails once then retries and succeeds
  svc.agentNeedsReindex('agent-1');
  assert.equal(svc.pendingReindexCount, 1);
  await svc.whenIdle();
  assert.equal(reindexAttempts, 2);
  assert.equal(svc.pendingReindexCount, 0);
  assert.equal(svc.isSearchReady, true);

  // Trigger markUnavailable while a reindex is pending -> count must reset to 0 and stay 0 after recovery
  svc.agentNeedsReindex('agent-2');
  svc.markUnavailable('test-fault', new Error('forced fault'));
  assert.equal(svc.pendingReindexCount, 0);
  assert.equal(svc.recoverNow(), true);
  await svc.whenIdle();
  assert.equal(svc.pendingReindexCount, 0);
  assert.equal(svc.isSearchReady, true);
});

test('startLocalContentSearch wires transcript mutations, health logging, and findTranscriptMatches', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-search-ext-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexDbPath = join(dir, SAND_SEARCH_INDEX_FILE_NAME);
  const logs = [];
  const telemetryReports = [];
  const stopCallbacks = [];
  const ports = createFakePorts({ indexDbPath });

  const ext = startLocalContentSearch(
    {
      host: { log: (line, level) => logs.push({ line, level }) },
      deps: {
        telemetry: {
          logs: {
            reportSearchIndexHealth: (report) => telemetryReports.push(report),
          },
        },
      },
      onStop: (fn) => stopCallbacks.push(fn),
    },
    {
      getSandRootDir: () => dir,
      getSandAgentsRootDir: () => join(dir, 'agents'),
    },
    {
      serviceOptions: {
        createJobPort: ports.createJobPort,
        createQueryPort: ports.createQueryPort,
      },
    },
  );
  t.after(async () => {
    for (const fn of stopCallbacks) await fn();
  });

  await ext.whenIdle();
  assert.equal(ext.isSearchReady, true);
  assert.equal(ext.getHealth().ready, true);
  assert.equal(logs.some((entry) => entry.line.includes('sand.search_index.health') && entry.line.includes('"ready"')), true);

  // Verify wrapped publishTranscriptMutation delivers mutations to both original and local content-search
  const originalReceived = [];
  const wrappedPublish = wrapPublishTranscriptMutation((m) => originalReceived.push(m));
  wrappedPublish({
    kind: 'entries-upserted',
    agentId: 'bot-1',
    entries: [{ kind: 'message', id: 'm1', role: 'user', content: 'hello search', timestampMs: 1234 }],
  });
  await ext.whenIdle();

  assert.equal(originalReceived.length, 1);
  assert.equal(ports.jobCalls.some((j) => j.kind === 'upsert-entries' && j.agentId === 'bot-1'), true);

  // Verify findTranscriptMatches skips hidden outbound peer messages
  const matches = ext.findTranscriptMatches(
    [
      { kind: 'message', id: 'hidden', role: 'assistant', content: 'secret needle', toAgent: { kind: 'subagent' }, timestampMs: 10 },
      { kind: 'message', id: 'visible', role: 'user', content: 'found the **needle** here', timestampMs: 20 },
    ],
    'needle',
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].entryId, 'visible');
  assert.match(matches[0].snippet, /needle/);
});

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;
const configuredArchive = process.env.ROKBOT_TEST_HOST_ARCHIVE || process.env.PROKBOT_TEST_HOST_ARCHIVE;

if (configuredSeed || configuredArchive) {
  test('real 2bb5e41 Host boots with resilient content-search, serves searchMedia/searchConversation, and self-heals', async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-search-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));

    let seedDir = configuredSeed;
    let originalDir = process.env.ROKBOT_ORIGINAL_HOST;
    if (configuredArchive) {
      const matOut = join(stateDir, 'materialized');
      const res = spawnSync(
        process.platform === 'win32' ? 'python' : 'python3',
        [join(HOST_DIR, 'release/patch-host.py'), '--archive', configuredArchive, '--output', matOut],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.ifError(res.error);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      seedDir = join(matOut, 'seed');
      originalDir = join(matOut, 'original');
    }

    const workSeed = join(stateDir, 'seed');
    await cp(seedDir, workSeed, { recursive: true });
    const reliableDir = join(workSeed, 'reliable-core', 'v1');
    await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
    await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));

    const tokenFile = join(stateDir, 'internal-host-token');
    await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

    const prevEnv = {};
    const overrides = {
      ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'),
      ROKBOT_DATA_DIR: stateDir,
      ROKBOT_STATE_DIR: stateDir,
      ROKBOT_ORIGINAL_HOST: originalDir,
      ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile,
      ROKBOT_SHARING_URL: 'http://127.0.0.1:9/internal/sharing',
      ROKBOT_CONNECTORS_URL: 'http://127.0.0.1:9/internal/connectors',
      SAND_DATA_ROOT: join(stateDir, 'host-data'),
      SAND_BACKEND_URL: 'http://127.0.0.1:9',
      SAND_DISABLE_TELEMETRY: '1',
      SAND_DISABLE_ANALYTICS: '1',
      SAND_HOST_IN_BOX: '1',
      SAND_PACKAGED: '1',
    };
    for (const [k, v] of Object.entries(overrides)) {
      prevEnv[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    t.after(() => {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const require = createRequire(import.meta.url);
    const library = require(join(workSeed, 'host-library-reliable.cjs'));
    await loadRecoveredHostCore(library, reliableDir);

    const modelConfig = {
      apiFormat: 'openai',
      baseUrl: 'http://127.0.0.1:9/v1',
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
      const exts = host.requireHostExtensions();
      const contentSearch = exts.api('content-search');
      await contentSearch.whenIdle();

      assert.equal(contentSearch.isSearchReady, true);
      assert.equal(contentSearch.getHealth().ready, true);

      const api = host.getApi();
      const created = await api.createAgent({ name: 'Search Bot', description: 'Search index integration' });
      const agentId = created.agent.id;

      // Both searchMedia and searchConversation must succeed (not throw SandSearchUnavailableError / 409)
      const mediaResult = await api.searchMedia({ query: '', limit: 10 });
      assert.equal(Array.isArray(mediaResult), true);

      const convResult = await api.searchConversation({ agentId, query: 'hello', limit: 10 });
      assert.equal(Array.isArray(convResult.matches), true);
      assert.equal(typeof convResult.isComplete, 'boolean');
    } finally {
      await host.dispose().catch(() => {});
    }
  });
}

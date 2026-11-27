import { existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

export const SEARCH_INDEX_SCHEMA_VERSION = 4;
export const SAND_SEARCH_INDEX_FILE_NAME = 'search-index.db';
export const AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT = 5;
export const AGENT_CONTENT_SEARCH_MAX_RESULTS = 50;

export const DEFAULT_OPEN_RETRY_DELAYS_MS = [1000, 5000, 30_000];
export const DEFAULT_RECOVERY_DELAYS_MS = [5000, 15_000, 30_000, 60_000];
export const DEFAULT_ON_DEMAND_RECOVERY_COOLDOWN_MS = 2000;

const META_RECONCILE_DONE = 'reconcile_done';
const SQLITE_DB_SIDECAR_SUFFIXES = ['', '-wal', '-shm', '-journal'];
const DB_BUSY_TIMEOUT_MS = 5000;
const MAX_INDEX_REBUILDS = 3;
const MAX_WORKER_RESPAWNS = 3;
const MAX_FAILED_JOB_RECONCILES = 3;
const SEARCH_INDEX_DISPOSE_TIMEOUT_MS = 2000;

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const SQLITE_PRIMARY_CODES = new Map([
  ['SQLITE_BUSY', 5],
  ['SQLITE_LOCKED', 6],
  ['SQLITE_IOERR', 10],
  ['SQLITE_CORRUPT', SQLITE_CORRUPT],
  ['SQLITE_CANTOPEN', 14],
  ['SQLITE_NOTADB', SQLITE_NOTADB],
]);

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  timestamp_ms INTEGER NOT NULL,
  body TEXT NOT NULL,
  seq INTEGER,
  in_main_chat INTEGER NOT NULL CHECK (in_main_chat IN (0, 1)),
  UNIQUE(agent_id, entry_id)
) STRICT;
CREATE INDEX IF NOT EXISTS messages_agent_recency
  ON messages(agent_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS messages_agent_seq ON messages(agent_id, seq);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  ext TEXT NOT NULL,
  mime TEXT,
  kind TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  seq INTEGER,
  UNIQUE(agent_id, entry_id)
) STRICT;
CREATE INDEX IF NOT EXISTS media_recency ON media(timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS media_agent_seq ON media(agent_id, seq);
CREATE TABLE IF NOT EXISTS server_cursors (
  agent_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  topped_through_seq INTEGER NOT NULL,
  backfilled_from_seq INTEGER NOT NULL
) STRICT;
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  content='messages',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body)
    VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body)
    VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
  file_name,
  content='media',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3'
);
CREATE TRIGGER IF NOT EXISTS media_fts_insert AFTER INSERT ON media BEGIN
  INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name);
END;
CREATE TRIGGER IF NOT EXISTS media_fts_delete AFTER DELETE ON media BEGIN
  INSERT INTO media_fts(media_fts, rowid, file_name)
    VALUES ('delete', old.id, old.file_name);
END;
CREATE TRIGGER IF NOT EXISTS media_fts_update AFTER UPDATE ON media BEGIN
  INSERT INTO media_fts(media_fts, rowid, file_name)
    VALUES ('delete', old.id, old.file_name);
  INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name);
END;
`;

const TELEMETRY_REPORT_KINDS = new Set([
  'unavailable',
  'corrupt_rebuild',
  'worker_respawn',
  'stage_failed',
  'dispatch_failed',
  'dispose_drain_cut',
  'worker_terminate_failed',
  'job_retry',
  'job_reconcile',
]);

const WARN_LOG_KINDS = new Set([
  'corrupt_rebuild',
  'worker_respawn',
  'dispose_drain_cut',
  'worker_terminate_failed',
  'job_retry',
  'job_reconcile',
  'open_retry',
  'recovery_started',
  'recovery_failed',
  'stage_failed',
]);

const INFO_LOG_KINDS = new Set([
  'ready',
  'recovered',
]);

const transcriptMutationSubscribers = new Set();

export function subscribeLocalTranscriptMutations(listener, log) {
  const subscriber = { listener, log };
  transcriptMutationSubscribers.add(subscriber);
  return () => {
    transcriptMutationSubscribers.delete(subscriber);
  };
}

export function emitLocalTranscriptMutation(mutation) {
  for (const { listener, log } of transcriptMutationSubscribers) {
    try {
      listener(mutation);
    } catch (error) {
      log?.(`[content-search] mutation listener failed kind=${mutation?.kind} agent=${mutation?.agentId} error=${errorLogTag(error)}`);
    }
  }
}

export function wrapPublishTranscriptMutation(publish) {
  if (typeof publish !== 'function') return publish;
  return (mutation) => {
    try {
      return publish(mutation);
    } finally {
      emitLocalTranscriptMutation(mutation);
    }
  };
}

function errorLogTag(error) {
  if (!(error instanceof Error)) return typeof error;
  const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined;
  return code !== undefined ? `${error.name} (${code})` : error.name;
}

function sqlitePrimaryCode(error) {
  if (!(error instanceof Error)) return undefined;
  if ('errcode' in error && typeof error.errcode === 'number' && Number.isInteger(error.errcode)) {
    return error.errcode & 255;
  }
  if ('code' in error && typeof error.code === 'string') {
    return SQLITE_PRIMARY_CODES.get(error.code.split('_', 2).join('_'));
  }
  return undefined;
}

export function isSqliteCorruptError(error) {
  const code = sqlitePrimaryCode(error);
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return true;
  if (error instanceof Error && typeof error.message === 'string') {
    return /file is not a database|database disk image is malformed/i.test(error.message);
  }
  return false;
}

function refuseDatabaseSymlinksSync(dbPath) {
  for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
    const candidate = `${dbPath}${suffix}`;
    const stat = lstatSync(candidate, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      const err = new Error(`Refusing symlink for search index database: ${candidate}`);
      err.code = 'ELOOP';
      throw err;
    }
  }
}

export function isFts5Available() {
  let db;
  try {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE fts5_probe USING fts5(x)');
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

export function openSearchIndexDb(dbPath) {
  refuseDatabaseSymlinksSync(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
    throw error;
  }
}

function ensureSearchIndexSchema(db, isFtsEnabled) {
  db.exec(CORE_SCHEMA);
  if (isFtsEnabled) db.exec(FTS_SCHEMA);
}

function readSearchIndexFileMode(db) {
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('meta', 'messages_fts')")
      .all()
      .map((row) => row.name),
  );
  if (!names.has('meta')) return 'fresh';
  return names.has('messages_fts') ? 'fts' : 'plain';
}

function readSearchIndexSchemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

function stampSearchIndexSchemaVersion(db) {
  db.exec(`PRAGMA user_version = ${SEARCH_INDEX_SCHEMA_VERSION}`);
}

function readReconcileDone(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_RECONCILE_DONE);
  return row?.value === '1';
}

function readServerCursor(db, agentId) {
  const row = db.prepare(
    `SELECT generation, topped_through_seq AS toppedThroughSeq,
        backfilled_from_seq AS backfilledFromSeq
      FROM server_cursors WHERE agent_id = ?`,
  ).get(agentId);
  if (
    typeof row?.generation !== 'number' ||
    typeof row.toppedThroughSeq !== 'number' ||
    typeof row.backfilledFromSeq !== 'number'
  ) {
    return null;
  }
  return {
    generation: row.generation,
    toppedThroughSeq: row.toppedThroughSeq,
    backfilledFromSeq: row.backfilledFromSeq,
  };
}

function removeFileIfPresentSync(filePath) {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const SNIPPET_LEAD = 30;
const SNIPPET_TRAIL = 60;
const SEARCH_SOURCE_MAX_CHARS = 40_000;
const PREVIEW_TRANSFORMS = [
  [/`+/g, ''],
  [/!\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\[([^\]]+)\]\([^)]*\)/g, '$1'],
  [/\\\$/g, '$'],
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/^\s{0,3}>\s?/gm, ''],
  [/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, ''],
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  [/~~([^~]+)~~/g, '$1'],
  [/\*([^*\n]+)\*/g, '$1'],
  [/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1'],
  [/\|/g, ' '],
];

function isHiddenOutboundAgentPeerMessageEntry(entry) {
  return (
    entry?.kind === 'message' &&
    entry.role === 'assistant' &&
    entry.toAgent != null &&
    entry.toAgent.kind !== 'agent' &&
    entry.toAgent.kind !== 'cloud-agent'
  );
}

function entrySearchText(entry) {
  let markdown = '';
  if (entry.kind === 'message') markdown = typeof entry.content === 'string' ? entry.content : '';
  else if (entry.kind === 'send-message') markdown = entry.message?.type === 'text' && typeof entry.message.content === 'string' ? entry.message.content : '';
  else if (entry.kind === 'notice') markdown = typeof entry.text === 'string' ? entry.text : '';
  if (markdown.length === 0) return '';
  const bounded = markdown.length <= SEARCH_SOURCE_MAX_CHARS ? markdown : markdown.slice(0, SEARCH_SOURCE_MAX_CHARS);
  const flattened = PREVIEW_TRANSFORMS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    bounded,
  );
  return flattened.replace(/\s+/g, ' ').trim();
}

function buildContentSnippet(text, normalizedQuery) {
  if (normalizedQuery.length === 0) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  const index = flat.toLowerCase().indexOf(normalizedQuery);
  if (index < 0) return null;
  const start = Math.max(0, index - SNIPPET_LEAD);
  const end = Math.min(flat.length, index + normalizedQuery.length + SNIPPET_TRAIL);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  return `${prefix}${flat.slice(start, end)}${suffix}`;
}

export function findAgentContentMatches(entries, normalizedQuery, limit = AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT) {
  if (!Array.isArray(entries) || typeof normalizedQuery !== 'string' || normalizedQuery.length === 0) return [];
  const matches = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (matches.length >= limit) break;
    const entry = entries[i];
    if (entry == null || isHiddenOutboundAgentPeerMessageEntry(entry)) continue;
    const snippet = buildContentSnippet(entrySearchText(entry), normalizedQuery);
    if (snippet == null) continue;
    matches.push({
      entryId: entry.id,
      role: entry.kind === 'message' ? entry.role : 'assistant',
      timestampMs: entry.timestampMs ?? 0,
      snippet,
    });
  }
  return matches;
}

export function resolveSearchIndexWorkerPath({ workerEntryPath, originalDir, stateDir, sandRootDir } = {}) {
  const candidates = [];
  if (typeof workerEntryPath === 'string' && workerEntryPath.trim().length > 0) {
    candidates.push(resolve(workerEntryPath));
  }
  const orig = originalDir ?? process.env.ROKBOT_ORIGINAL_HOST ?? process.env.GROKBOT_ORIGINAL_HOST;
  if (typeof orig === 'string' && orig.trim().length > 0) {
    candidates.push(join(resolve(orig), 'extensions', 'content-search', 'search-index-worker.cjs'));
  }
  const state = stateDir ?? process.env.ROKBOT_STATE_DIR ?? process.env.GROKBOT_STATE_DIR;
  if (typeof state === 'string' && state.trim().length > 0) {
    candidates.push(join(resolve(state), 'extensions', 'content-search', 'search-index-worker.cjs'));
  }
  if (typeof sandRootDir === 'string' && sandRootDir.trim().length > 0) {
    candidates.push(join(dirname(resolve(sandRootDir)), 'extensions', 'content-search', 'search-index-worker.cjs'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? join(process.cwd(), 'extensions', 'content-search', 'search-index-worker.cjs');
}

class SearchIndexWorkerChannel {
  constructor(entryPath, workerData) {
    this.pending = new Map();
    this.nextRequestId = 1;
    this.isLost = false;
    this.worker = new Worker(entryPath, { workerData });
    this.worker.on('message', (response) => {
      const settle = this.pending.get(response?.requestId);
      if (settle == null) return;
      this.pending.delete(response.requestId);
      settle({ kind: 'response', response });
    });
    this.worker.on('error', (error) => this.lose(error?.message ?? String(error)));
    this.worker.on('exit', (code) => this.lose(`search-index worker exited (${code})`));
  }

  lose(message) {
    if (this.isLost) return;
    this.isLost = true;
    for (const settle of this.pending.values()) {
      settle({ kind: 'lost', message });
    }
    this.pending.clear();
  }

  request(build) {
    if (this.isLost) {
      return Promise.resolve({ kind: 'lost', message: 'search-index worker is no longer running' });
    }
    const requestId = this.nextRequestId++;
    return new Promise((resolvePromise) => {
      this.pending.set(requestId, resolvePromise);
      try {
        this.worker.postMessage(build(requestId));
      } catch (error) {
        this.pending.delete(requestId);
        resolvePromise({ kind: 'lost', message: error?.message ?? String(error) });
      }
    });
  }

  async terminate() {
    this.lose('search-index worker terminated');
    await this.worker.terminate();
  }
}

class WorkerSearchIndexJobPort {
  constructor(entryPath, config) {
    this.channel = new SearchIndexWorkerChannel(entryPath, { role: 'writer', ...config });
  }

  async post(job) {
    const reply = await this.channel.request((requestId) => ({ requestId, job }));
    if (reply.kind === 'lost') {
      return {
        ok: false,
        message: reply.message,
        isIndexCorrupt: false,
        isWorkerUnavailable: true,
      };
    }
    const { response } = reply;
    if (!response?.ok) {
      return {
        ok: false,
        message: response?.message ?? 'search index job failed',
        isIndexCorrupt: response?.isIndexCorrupt === true,
        isWorkerUnavailable: false,
      };
    }
    return response.outcome === undefined ? { ok: true } : { ok: true, outcome: response.outcome };
  }

  terminate() {
    return this.channel.terminate();
  }
}

class WorkerSearchIndexQueryPort {
  constructor(entryPath, config) {
    this.channel = new SearchIndexWorkerChannel(entryPath, { role: 'reader', ...config });
  }

  async run(query) {
    const reply = await this.channel.request((requestId) => ({ requestId, query }));
    if (reply.kind === 'lost') {
      return { ok: false, reason: 'reader-lost', message: reply.message };
    }
    const { response } = reply;
    if (response?.ok) return response;
    return response?.isIndexUnreadable
      ? { ok: false, reason: 'index-unreadable', message: response.message }
      : { ok: false, reason: 'query-failed', errorClass: response?.errorClass ?? 'Error' };
  }

  async searchMessages(query, limit) {
    const result = await this.run({ kind: 'messages', query, limit });
    if (!result.ok) return result;
    if (result.kind !== 'messages') {
      return { ok: false, reason: 'query-failed', errorClass: 'InvalidWorkerReply' };
    }
    return { ok: true, answer: result.matches };
  }

  async searchMedia(query, limit) {
    const result = await this.run({ kind: 'media', query, limit });
    if (!result.ok) return result;
    if (result.kind !== 'media') {
      return { ok: false, reason: 'query-failed', errorClass: 'InvalidWorkerReply' };
    }
    return { ok: true, answer: result.matches };
  }

  async searchConversation(query) {
    const result = await this.run({ kind: 'conversation', ...query });
    if (!result.ok) return result;
    if (result.kind !== 'conversation') {
      return { ok: false, reason: 'query-failed', errorClass: 'InvalidWorkerReply' };
    }
    return { ok: true, answer: { matches: result.matches, isComplete: result.isComplete } };
  }

  terminate() {
    return this.channel.terminate();
  }
}

function createFallbackDisposeDeadline(timeoutMs = SEARCH_INDEX_DISPOSE_TIMEOUT_MS) {
  return {
    run(fn) {
      let timer;
      return Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('search-index dispose deadline exceeded')), timeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => {
        if (timer != null) clearTimeout(timer);
      });
    },
  };
}

export class ResilientSearchIndexService {
  constructor(options) {
    this.indexDbPath = options.indexDbPath;
    this.agentsRootDir = options.agentsRootDir;
    this.disposeDeadline = options.disposeDeadline ?? createFallbackDisposeDeadline();
    this.report = options.report ?? (() => {});
    this.isFtsEnabled = options.isFtsAvailable ?? isFts5Available();
    this.openDb = options.openDb ?? openSearchIndexDb;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

    this.openRetryDelaysMs = Array.isArray(options.openRetryDelaysMs) && options.openRetryDelaysMs.length > 0
      ? [...options.openRetryDelaysMs]
      : [...DEFAULT_OPEN_RETRY_DELAYS_MS];
    this.maxOpenRetries = options.maxOpenRetries ?? this.openRetryDelaysMs.length;
    this.recoveryDelaysMs = Array.isArray(options.recoveryDelaysMs) && options.recoveryDelaysMs.length > 0
      ? [...options.recoveryDelaysMs]
      : [...DEFAULT_RECOVERY_DELAYS_MS];
    this.onDemandRecoveryCooldownMs = options.onDemandRecoveryCooldownMs ?? DEFAULT_ON_DEMAND_RECOVERY_COOLDOWN_MS;

    const entryPath = options.workerEntryPath ?? resolveSearchIndexWorkerPath({
      sandRootDir: dirname(this.indexDbPath),
    });
    this.workerEntryPath = entryPath;
    this.createJobPort = options.createJobPort ?? ((config) => new WorkerSearchIndexJobPort(entryPath, config));
    this.createQueryPort = options.createQueryPort ?? ((config) => new WorkerSearchIndexQueryPort(entryPath, config));

    this.db = undefined;
    this.port = undefined;
    this.queryPort = undefined;
    this.isUnavailable = false;
    this.isDisposed = false;
    this.isReconcileDone = false;
    this.isRebuildPending = false;
    this.isRecovering = false;
    this.pendingReindexTokens = new Set();
    this.rebuildCount = 0;
    this.workerRespawnCount = 0;
    this.readerRespawnCount = 0;
    this.failedJobReconcileCount = 0;
    this.openRetryCount = 0;
    this.recoveryAttemptCount = 0;
    this.retryTimer = null;
    this.lastRecoveryAttemptMs = -Infinity;
    this.lastError = null;
    this.lastReadyAtMs = null;
    this.unavailableSinceMs = null;
    this.hadReportedReady = false;
    this.wasUnavailableBeforeRecovery = false;
    this.jobTail = Promise.resolve();
    this.invalidationListeners = new Set();

    this.serverTranscripts = {
      cursor: async (agentId) => this.serverCursor(agentId),
      applyRange: (range) => this.enqueue({ kind: 'apply-server-range', range }),
      subscribeInvalidated: (listener) => {
        this.invalidationListeners.add(listener);
        return () => {
          this.invalidationListeners.delete(listener);
        };
      },
    };
  }

  get pendingReindexCount() {
    return this.pendingReindexTokens.size;
  }

  start() {
    if (this.isDisposed) return;
    if (this.db != null && !this.isUnavailable) {
      this.enqueue({ kind: 'reconcile' });
      return;
    }
    this.tryOpenAndStart('open');
  }

  tryOpenAndStart(stage) {
    if (this.isDisposed) return false;
    this.clearRetryTimer();
    try {
      this.db = this.openAndMigrate();
    } catch (error) {
      this.lastError = errorLogTag(error);
      this.openRetryCount += 1;
      if (this.openRetryCount <= this.maxOpenRetries) {
        const delayMs = this.openRetryDelaysMs[Math.min(this.openRetryCount - 1, this.openRetryDelaysMs.length - 1)];
        this.report({
          kind: 'open_retry',
          stage,
          errorClass: this.lastError,
          count: this.openRetryCount,
          delayMs,
        });
        this.retryTimer = this.setTimer(() => {
          this.retryTimer = null;
          this.tryOpenAndStart('open-retry');
        }, delayMs);
        return false;
      }
      this.markUnavailable('open', error);
      return false;
    }
    this.isUnavailable = false;
    this.unavailableSinceMs = null;
    this.openRetryCount = 0;
    this.lastError = null;
    this.pendingReindexTokens.clear();
    this.isReconcileDone = this.safeReadReconcileDone();
    if (this.isReconcileDone) {
      this.noteReady(stage === 'open-retry' ? 'recovered' : 'open');
    }
    this.enqueue({ kind: 'reconcile' });
    return true;
  }

  noteReady(stage) {
    const now = this.now();
    this.lastReadyAtMs = now;
    const kind = this.wasUnavailableBeforeRecovery || stage === 'recovered' ? 'recovered' : 'ready';
    this.wasUnavailableBeforeRecovery = false;
    if (!this.hadReportedReady || kind === 'recovered') {
      this.hadReportedReady = true;
      this.report({ kind, stage });
    }
  }

  clearRetryTimer() {
    if (this.retryTimer != null) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }

  scheduleRecoveryTimer() {
    if (this.isDisposed || !this.isUnavailable || this.retryTimer != null) return;
    const delayMs = this.recoveryDelaysMs[Math.min(this.recoveryAttemptCount, this.recoveryDelaysMs.length - 1)];
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.attemptRecovery('periodic');
    }, delayMs);
  }

  attemptRecovery(reason = 'on-demand') {
    if (this.isDisposed || this.isRecovering || this.isRebuildPending) return false;
    if (!this.isUnavailable && this.db != null) return true;
    this.isRecovering = true;
    this.lastRecoveryAttemptMs = this.now();
    this.recoveryAttemptCount += 1;
    this.clearRetryTimer();
    try {
      const db = this.openAndMigrate();
      const wasUnavailable = this.isUnavailable;
      this.db = db;
      this.isUnavailable = false;
      this.unavailableSinceMs = null;
      this.workerRespawnCount = 0;
      this.readerRespawnCount = 0;
      this.failedJobReconcileCount = 0;
      this.rebuildCount = 0;
      this.openRetryCount = 0;
      this.pendingReindexTokens.clear();
      this.lastError = null;
      this.wasUnavailableBeforeRecovery = this.wasUnavailableBeforeRecovery || wasUnavailable;
      this.isReconcileDone = this.safeReadReconcileDone();
      this.isRecovering = false;
      this.report({ kind: 'recovery_started', stage: reason, count: this.recoveryAttemptCount });
      if (this.isReconcileDone) {
        this.noteReady('recovered');
      }
      this.enqueue({ kind: 'reconcile' });
      return true;
    } catch (error) {
      this.lastError = errorLogTag(error);
      this.isUnavailable = true;
      this.isRecovering = false;
      this.report({
        kind: 'recovery_failed',
        stage: reason,
        errorClass: this.lastError,
        count: this.recoveryAttemptCount,
      });
      this.scheduleRecoveryTimer();
      return false;
    }
  }

  recoverNow() {
    return this.attemptRecovery('manual');
  }

  maybeRecoverOnDemand() {
    if (this.isDisposed || this.isRecovering || this.isRebuildPending) return;
    if (!this.isUnavailable) return;
    if (this.now() - this.lastRecoveryAttemptMs < this.onDemandRecoveryCooldownMs) return;
    this.attemptRecovery('on-demand');
  }

  get isSearchReady() {
    if (this.isDisposed || this.isRebuildPending) return false;
    if (this.isUnavailable) {
      this.maybeRecoverOnDemand();
    }
    if (this.db == null || this.isUnavailable) return false;
    if (!this.isReconcileDone && this.safeReadReconcileDone()) {
      this.isReconcileDone = true;
      this.noteReady('meta');
    }
    return this.isReconcileDone && this.pendingReindexTokens.size === 0;
  }

  getHealth() {
    const ready = (
      this.db != null &&
      !this.isUnavailable &&
      !this.isDisposed &&
      !this.isRebuildPending &&
      this.isReconcileDone &&
      this.pendingReindexTokens.size === 0
    );
    return {
      ready,
      unavailable: this.isUnavailable,
      reconcileDone: this.isReconcileDone,
      rebuildPending: this.isRebuildPending,
      pendingReindexCount: this.pendingReindexTokens.size,
      ftsEnabled: this.isFtsEnabled,
      openRetryCount: this.openRetryCount,
      recoveryAttemptCount: this.recoveryAttemptCount,
      lastError: this.lastError,
      lastReadyAtMs: this.lastReadyAtMs,
      unavailableSinceMs: this.unavailableSinceMs,
    };
  }

  searchMessages(query, limit) {
    return this.runQuery('search-messages', (port) => port.searchMessages(query, limit));
  }

  searchMedia(query, limit) {
    return this.runQuery('search-media', (port) => port.searchMedia(query, limit));
  }

  searchConversation(query) {
    return this.runQuery('search-conversation', (port) => port.searchConversation(query));
  }

  async runQuery(stage, run) {
    if (this.isDisposed || this.isRebuildPending) return null;
    if (this.isUnavailable) {
      this.maybeRecoverOnDemand();
    }
    if (this.db == null || this.isDisposed || this.isUnavailable || this.isRebuildPending) {
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.db == null || this.isDisposed || this.isUnavailable || this.isRebuildPending) {
        return null;
      }
      try {
        const port = this.getQueryPort();
        const result = await run(port);
        if (port !== this.queryPort) return null;
        if (result.ok) {
          this.readerRespawnCount = 0;
          return result.answer;
        }
        this.handleQueryFailure(stage, result);
        if (result.reason === 'reader-lost' && !this.isUnavailable && !this.isDisposed && attempt === 0) {
          continue;
        }
      } catch (error) {
        this.handleQueryFailure(stage, { reason: 'query-failed', errorClass: errorLogTag(error) });
      }
      return null;
    }
    return null;
  }

  applyMutation(mutation) {
    if (!mutation || typeof mutation !== 'object') return;
    switch (mutation.kind) {
      case 'entries-upserted':
        this.entriesUpserted(mutation.agentId, mutation.entries);
        return;
      case 'entry-deleted':
        this.entryDeleted(mutation.agentId, mutation.entryId);
        return;
      case 'conversation-cleared':
        this.conversationCleared(mutation.agentId);
        return;
      case 'agent-removed':
        this.agentRemoved(mutation.agentId);
        return;
      case 'agent-needs-reindex':
        this.agentNeedsReindex(mutation.agentId);
        return;
      default:
        return;
    }
  }

  entriesUpserted(agentId, entries) {
    if (!Array.isArray(entries)) return;
    const indexable = entries.filter((entry) => entry?.kind !== 'spend-initiation');
    if (indexable.length === 0) return;
    this.enqueue({ kind: 'upsert-entries', agentId, entries: indexable });
  }

  entryDeleted(agentId, entryId) {
    this.enqueue({ kind: 'delete-entry', agentId, entryId });
  }

  conversationCleared(agentId) {
    this.enqueue({ kind: 'clear-agent', agentId });
  }

  agentRemoved(agentId) {
    this.enqueue({ kind: 'remove-agent', agentId });
  }

  agentNeedsReindex(agentId) {
    if (this.isDisposed || this.isUnavailable || this.db == null) return;
    const token = Symbol('reindex');
    this.pendingReindexTokens.add(token);
    this.enqueue({ kind: 'reindex-agents', agentIds: [agentId], _token: token });
  }

  async whenIdle() {
    while (true) {
      const tail = this.jobTail;
      await tail;
      if (this.jobTail === tail) return;
    }
  }

  async dispose() {
    this.isDisposed = true;
    this.clearRetryTimer();
    this.pendingReindexTokens.clear();
    await this.disposeDeadline.run(async () => await this.jobTail).catch((error) => {
      this.report({ kind: 'dispose_drain_cut', errorClass: errorLogTag(error) });
    });
    await this.terminateWorker(this.port, 'dispose');
    this.port = undefined;
    await this.terminateWorker(this.queryPort, 'dispose');
    this.queryPort = undefined;
    try {
      this.db?.close();
    } catch {
      // ignore close errors
    }
    this.db = undefined;
  }

  async terminateWorker(port, stage) {
    await port?.terminate().catch((error) => {
      this.report({ kind: 'worker_terminate_failed', stage, errorClass: errorLogTag(error) });
    });
  }

  markUnavailable(stage, error) {
    this.isUnavailable = true;
    this.isReconcileDone = false;
    this.hadReportedReady = false;
    this.wasUnavailableBeforeRecovery = true;
    this.lastError = errorLogTag(error);
    this.unavailableSinceMs ??= this.now();
    this.pendingReindexTokens.clear();
    const port = this.port;
    this.port = undefined;
    void this.terminateWorker(port, 'unavailable teardown');
    const queryPort = this.queryPort;
    this.queryPort = undefined;
    void this.terminateWorker(queryPort, 'unavailable teardown');
    try {
      this.db?.close();
    } catch {
      // ignore close errors
    }
    this.db = undefined;
    const detail = error instanceof Error ? error.message : String(error ?? '');
    this.report({
      kind: 'unavailable',
      stage,
      errorClass: this.lastError,
      ...(detail ? { detail } : {}),
    });
    this.scheduleRecoveryTimer();
  }

  serverCursor(agentId) {
    const db = this.db;
    if (db == null || this.isDisposed || this.isUnavailable || this.isRebuildPending) {
      return 'unavailable';
    }
    try {
      return readServerCursor(db, agentId);
    } catch (error) {
      this.report({ kind: 'stage_failed', stage: 'server-cursor', errorClass: errorLogTag(error) });
      return 'unavailable';
    }
  }

  safeReadReconcileDone() {
    const db = this.db;
    if (db == null) return false;
    try {
      return readReconcileDone(db);
    } catch {
      return false;
    }
  }

  openAndMigrate() {
    mkdirSync(dirname(this.indexDbPath), { recursive: true });
    let db;
    try {
      db = this.openDb(this.indexDbPath);
      const fileMode = readSearchIndexFileMode(db);
      if (
        fileMode !== 'fresh' &&
        ((fileMode === 'fts') !== this.isFtsEnabled || readSearchIndexSchemaVersion(db) !== SEARCH_INDEX_SCHEMA_VERSION)
      ) {
        db.close();
        db = undefined;
        return this.recreateIndexFile();
      }
      ensureSearchIndexSchema(db, this.isFtsEnabled);
      if (fileMode === 'fresh') stampSearchIndexSchemaVersion(db);
      return db;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // ignore close errors
      }
      this.report({ kind: 'stage_failed', stage: 'open', errorClass: errorLogTag(error) });
      if (isSqliteCorruptError(error)) {
        return this.recreateIndexFile();
      }
      throw error;
    }
  }

  recreateIndexFile() {
    this.removeIndexFiles();
    const db = this.openDb(this.indexDbPath);
    try {
      ensureSearchIndexSchema(db, this.isFtsEnabled);
      stampSearchIndexSchemaVersion(db);
    } catch (error) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
      throw error;
    }
    for (const listener of this.invalidationListeners) {
      try {
        listener('all');
      } catch {
        // ignore listener failure
      }
    }
    return db;
  }

  removeIndexFiles() {
    for (const suffix of SQLITE_DB_SIDECAR_SUFFIXES) {
      removeFileIfPresentSync(`${this.indexDbPath}${suffix}`);
    }
  }

  handleQueryFailure(stage, failure) {
    if (this.isDisposed || this.isUnavailable) return;
    switch (failure.reason) {
      case 'index-unreadable':
        this.scheduleRebuild(stage, new Error(failure.message));
        return;
      case 'reader-lost': {
        const oldQueryPort = this.queryPort;
        this.queryPort = undefined;
        void this.terminateWorker(oldQueryPort, 'reader-lost');
        this.readerRespawnCount += 1;
        if (this.readerRespawnCount > MAX_WORKER_RESPAWNS) {
          this.markUnavailable('worker-respawn', new Error(failure.message));
          return;
        }
        this.report({ kind: 'worker_respawn', count: this.readerRespawnCount });
        return;
      }
      case 'query-failed':
        this.report({ kind: 'stage_failed', stage, errorClass: failure.errorClass });
        return;
      default:
        return;
    }
  }

  scheduleRebuild(stage, error) {
    if (this.isDisposed || this.isUnavailable || this.isRebuildPending) return;
    this.rebuildCount += 1;
    if (this.rebuildCount > MAX_INDEX_REBUILDS) {
      this.markUnavailable(stage, error);
      return;
    }
    this.report({ kind: 'corrupt_rebuild', stage, count: this.rebuildCount });
    this.isReconcileDone = false;
    this.isRebuildPending = true;
    this.pendingReindexTokens.clear();
    const port = this.port;
    this.port = undefined;
    const queryPort = this.queryPort;
    this.queryPort = undefined;
    const rebuildStep = this.jobTail.then(async () => {
      await this.terminateWorker(port, 'rebuild');
      await this.terminateWorker(queryPort, 'rebuild');
      try {
        this.db?.close();
      } catch {
        // ignore close errors
      }
      this.db = undefined;
      if (this.isDisposed) return false;
      this.db = this.recreateIndexFile();
      return true;
    }).catch((rebuildError) => {
      this.markUnavailable('rebuild', rebuildError);
      return false;
    }).finally(() => {
      this.isRebuildPending = false;
    });
    this.jobTail = rebuildStep.then(async (rebuilt) => {
      if (rebuilt && !this.isDisposed && !this.isUnavailable && this.db != null) {
        await this.runJob({ kind: 'reconcile' });
      }
    }).catch((err) => {
      this.report({ kind: 'dispatch_failed', errorClass: errorLogTag(err) });
    });
  }

  getPort() {
    if (this.port == null) {
      this.port = this.createJobPort({
        indexDbPath: this.indexDbPath,
        agentsRootDir: this.agentsRootDir,
      });
    }
    return this.port;
  }

  getQueryPort() {
    if (this.queryPort == null) {
      this.queryPort = this.createQueryPort({
        indexDbPath: this.indexDbPath,
        isFtsEnabled: this.isFtsEnabled,
      });
    }
    return this.queryPort;
  }

  enqueue(job) {
    if (this.isDisposed || this.isUnavailable || this.db == null) {
      if (job?._token) this.pendingReindexTokens.delete(job._token);
      return Promise.resolve('unavailable');
    }
    const settled = this.jobTail.then(() => this.runJob(job)).catch((error) => {
      if (job?._token) this.pendingReindexTokens.delete(job._token);
      this.report({ kind: 'dispatch_failed', errorClass: errorLogTag(error) });
      return 'unavailable';
    });
    this.jobTail = settled.then(() => undefined);
    return settled;
  }

  async runJob(job) {
    let handedOffToRetry = false;
    try {
      const outcome = await this.dispatchJob(job, () => {
        handedOffToRetry = true;
      });
      return outcome;
    } finally {
      if (!handedOffToRetry && job?._token) {
        this.pendingReindexTokens.delete(job._token);
      }
    }
  }

  async dispatchJob(job, onRetryHandoff) {
    if (this.isDisposed || this.isUnavailable || this.db == null) return 'unavailable';
    const { _token, ...workerJob } = job;
    const result = await this.getPort().post(workerJob);
    if (result.ok) {
      if (job.kind === 'reconcile') {
        this.isReconcileDone = true;
        this.workerRespawnCount = 0;
        this.failedJobReconcileCount = 0;
        this.rebuildCount = 0;
        this.recoveryAttemptCount = 0;
        this.lastError = null;
        this.noteReady('reconcile');
      } else if (job.kind === 'reindex-agents') {
        this.failedJobReconcileCount = 0;
      }
      return result.outcome ?? 'unavailable';
    }
    if (result.isIndexCorrupt) {
      this.scheduleRebuild(`job-${job.kind}`, new Error(result.message));
      return 'unavailable';
    }
    if (result.isWorkerUnavailable) {
      const oldPort = this.port;
      this.port = undefined;
      void this.terminateWorker(oldPort, 'worker-lost');
      this.workerRespawnCount += 1;
      if (this.workerRespawnCount > MAX_WORKER_RESPAWNS) {
        this.markUnavailable('worker-respawn', new Error(result.message));
        return 'unavailable';
      }
      this.report({
        kind: 'worker_respawn',
        count: this.workerRespawnCount,
        ...(result.message ? { detail: result.message } : {}),
      });
      this.isReconcileDone = false;
      this.enqueue({ kind: 'reconcile' });
      return 'unavailable';
    }
    this.failedJobReconcileCount += 1;
    if (this.failedJobReconcileCount > MAX_FAILED_JOB_RECONCILES) {
      this.markUnavailable(`job-${job.kind}`, new Error(result.message));
      return 'unavailable';
    }
    if (job.kind === 'reindex-agents') {
      this.report({ kind: 'job_retry', stage: job.kind, count: this.failedJobReconcileCount });
      if (!this.isDisposed && !this.isUnavailable && this.db != null) {
        onRetryHandoff?.();
        this.enqueue(job);
      }
      return 'unavailable';
    }
    this.report({ kind: 'job_reconcile', stage: job.kind, count: this.failedJobReconcileCount });
    this.isReconcileDone = false;
    this.enqueue({ kind: 'reconcile' });
    return 'unavailable';
  }
}

export function startLocalContentSearch(context, library, options = {}) {
  const sandRootDir = options.sandRootDir ?? library.getSandRootDir();
  const agentsRootDir = options.agentsRootDir ?? library.getSandAgentsRootDir();
  const indexDbPath = options.indexDbPath ?? join(sandRootDir, SAND_SEARCH_INDEX_FILE_NAME);
  const workerEntryPath = resolveSearchIndexWorkerPath({
    workerEntryPath: options.workerEntryPath,
    originalDir: options.originalDir,
    stateDir: options.stateDir,
    sandRootDir,
  });

  const disposeDeadline = options.disposeDeadline ?? (
    typeof library.createDeadlinePolicy === 'function'
      ? library.createDeadlinePolicy({
        name: 'sand-content-search-dispose',
        timeoutMs: SEARCH_INDEX_DISPOSE_TIMEOUT_MS,
      })
      : createFallbackDisposeDeadline(SEARCH_INDEX_DISPOSE_TIMEOUT_MS)
  );

  const hostLog = (line, level = 'info') => {
    if (typeof context?.host?.log === 'function') {
      context.host.log(line, level);
    } else if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.info(line);
    }
  };

  const report = (event) => {
    if (TELEMETRY_REPORT_KINDS.has(event?.kind)) {
      try {
        const { detail: _detail, ...telemetryEvent } = event;
        context?.deps?.telemetry?.logs?.reportSearchIndexHealth?.(telemetryEvent);
      } catch {
        // ignore telemetry errors
      }
    }
    const level = INFO_LOG_KINDS.has(event?.kind)
      ? 'info'
      : WARN_LOG_KINDS.has(event?.kind)
        ? 'warn'
        : 'error';
    hostLog(`[content-search] sand.search_index.health ${JSON.stringify(event)}`, level);
    options.onReport?.(event);
  };

  const index = new ResilientSearchIndexService({
    indexDbPath,
    agentsRootDir,
    workerEntryPath,
    disposeDeadline,
    report,
    ...(options.serviceOptions ?? {}),
  });

  context?.onStop?.(() => index.dispose());
  context?.onStop?.(
    subscribeLocalTranscriptMutations(
      (mutation) => index.applyMutation(mutation),
      (line) => hostLog(line, 'warn'),
    ),
  );

  index.start();

  return {
    get isSearchReady() {
      return index.isSearchReady;
    },
    maxMatchesPerAgent: AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT,
    maxResults: AGENT_CONTENT_SEARCH_MAX_RESULTS,
    searchMessages: ({ query, limit }) => index.searchMessages(query, limit),
    searchMedia: ({ query, limit }) => index.searchMedia(query, limit),
    searchConversation: (input) => index.searchConversation(input),
    findTranscriptMatches: (entries, query, limit) => findAgentContentMatches(entries, query, limit),
    serverTranscripts: index.serverTranscripts,
    getHealth: () => index.getHealth(),
    whenIdle: () => index.whenIdle(),
    recoverNow: () => index.recoverNow(),
  };
}

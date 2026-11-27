import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageExport, usageReport, UsageReportError } from '../../host/runtime/usage-report.mjs';
import { DEMO_NAMES, writeDemoLedger } from '../../host/tests/fixtures/usage-demo.mjs';

/**
 * Lightweight RFC 6455 WebSocket helper for node:http server upgrade
 */
class MockWebSocket extends EventEmitter {
  constructor(socket, protocol) {
    super();
    this.socket = socket;
    this.protocol = protocol;
    this.readyState = 1; // OPEN
    this._buffer = Buffer.alloc(0);

    this.socket.on('data', chunk => this._handleData(chunk));
    this.socket.on('close', () => {
      this.readyState = 3; // CLOSED
      this.emit('close');
    });
    this.socket.on('error', err => this.emit('error', err));
  }

  _handleData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 2) {
      const byte0 = this._buffer[0];
      const byte1 = this._buffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const isMasked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        payloadLen = Number(this._buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLength = isMasked ? 4 : 0;
      if (this._buffer.length < offset + maskLength + payloadLen) {
        return; // Wait for full frame
      }

      let payload = this._buffer.subarray(offset + maskLength, offset + maskLength + payloadLen);
      if (isMasked) {
        const mask = this._buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ mask[i % 4];
        }
        payload = unmasked;
      }

      this._buffer = this._buffer.subarray(offset + maskLength + payloadLen);

      if (opcode === 0x8) { // Close
        this.close();
        return;
      } else if (opcode === 0x9) { // Ping
        this._sendFrame(0xA, payload); // Pong
      } else if (opcode === 0x1) { // Text
        this.emit('message', payload.toString('utf-8'));
      } else if (opcode === 0x2) { // Binary
        this.emit('binary', payload);
      }
    }
  }

  send(data) {
    if (this.readyState !== 1) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
    this._sendFrame(0x1, buf);
  }

  _sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len <= 125) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = len;
    } else if (len <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 2; // CLOSING
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(code, 0);
    this._sendFrame(0x8, buf);
    this.readyState = 3;
    this.socket.end();
  }
}

/**
 * MockHostServer emulating all Host contracts
 */
export class MockHostServer {
  constructor(options = {}) {
    this.options = options;
    this.realHostProtocol = Boolean(options.realHostProtocol);
    // Optional X-RokBot-Route on /health ('relay' | 'direct'), as a relay in front of a Host may add it.
    this.routeHeader = options.routeHeader || null;
    this.publicUrl = options.publicUrl ? String(options.publicUrl).replace(/\/+$/, '') : null;
    this.port = options.port || 0;
    this.validPairingKey = (options.pairingKey || 'ABCDEF').toUpperCase();
    this.adminPassword = options.adminPassword || 'AdminPass123!';
    this.maxDevices = options.maxDevices || 100;

    // In-memory databases
    this.devices = new Map(); // token -> device
    this.devicesById = new Map(); // deviceId -> device
    this.nonces = new Map(); // clientNonce -> response
    this.voiceTickets = new Map(); // tokenHash -> ticket
    this.activeVoiceSessions = new Map(); // deviceId -> session
    this.attachmentUploads = new Map(); // uploadId -> { agentId, filename, totalSize, chunks: [] }
    this.committedAttachments = new Map(); // path -> { buffer, mime, filename }
    this.libraryFiles = new Map(); // agentId -> Map(fileName -> { name, path, sizeBytes, contentType, updatedAtMs, etag, buffer })
    this.transcripts = new Map(); // agentId -> Array of transcript entries
    this.trays = [];
    this.asyncTasks = [];
    this.notificationHistory = [];
    this.notificationSettings = { frequency: 'every-reply' };
    this.suggestionsSettings = {
      enabled: true,
      aiEnabled: true,
      completionEnabled: true,
      quickPhrases: [],
      updatedAt: null,
    };
    // Optional artificial latency (ms) of /local/suggestions and /local/suggestions/complete, e.g. to
    // capture the loading shimmer on an emulator.
    this.suggestionsDelayMs = Number(options.suggestionsDelayMs) || 0;
    this.completionDelayMs = Number(options.completionDelayMs) || 0;
    this.completionRequests = [];
    this.profile = {
      displayName: 'Local Test User',
      avatarDataUrl: null,
      updatedAtMs: Date.now(),
    };
    this.usage = {
      total: 41350,
      input: 12450,
      output: 28900,
      period: '30d',
    };
    // GET /local/usage/report: the real report code over the demo ledger (host/tests/fixtures/usage-demo.mjs).
    // usageReportEnabled = false answers 404, as a Host older than the report does.
    this.usageReportEnabled = options.usageReport !== false;
    this.usageNow = options.usageNow ? new Date(options.usageNow) : null;
    this.usageLedgerDir = null;
    this.computers = [
      {
        id: 'comp-main',
        label: 'rokbot-box-1',
        connected: true,
        platform: 'linux-arm64',
        updatedAtMs: Date.now(),
      },
    ];
    this.hostSettings = this._defaultHostSettings();
    this.connectors = this._defaultConnectors();
    this.workflows = [
      {
        id: 'wf-demo-skill',
        name: 'Demo Skill',
        publishedByCurrentUser: false,
      },
    ];
    this.needsModel = Boolean(options.needsModel);
    this.routingMigrated = Boolean(options.routingMigrated);
    this.configuredOverride = options.configured !== undefined ? options.configured : undefined;
    this.canConfigureModel = options.canConfigureModel !== false;
    this.requireStepUpPassword = Boolean(options.requireStepUpPassword);
    this.modelConfig = this._defaultModelConfig();
    this.modelReload = {
      revision: 'rev-init-1',
      status: 'applied',
      error: null,
      updatedAt: new Date().toISOString(),
    };
    this.androidUpdateManifest = options.androidUpdateManifest || null;
    this.androidUpdateArtifacts = new Map();

    // SSE client sets
    this.eventsClients = new Set(); // { res, deviceId, lastEventId, subscribedChannels, slimAvatars }
    this.notificationClients = new Set(); // { res, deviceId, isForeground, lastEventId }
    this.foregroundDevices = new Set(); // deviceIds

    // Rate limiting tracking
    this.rateLimits = new Map(); // ip -> { count, resetAt }

    // Request logs for testing assertions
    this.requestLogs = [];
    this.openedAgentIds = [];

    // Pre-populate default bots
    this.agents = this._defaultAgents();

    this.server = http.createServer((req, res) => this._handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
  }

  _defaultHostSettings() {
    return {
      notifications: { isEnabled: false },
      mcpCustomInstructions: {},
      mcpCustomInstructionsByServerId: {},
      mcpDisabledToolsByServerId: {},
      mcpHeldAccountScopes: [],
      mcpBoxServers: [],
      autoReviewInstructions: {
        isEnabled: this.realHostProtocol ? true : false,
        allowInstructions: [],
        blockInstructions: [],
      },
      localToolPermission: 'ask',
      webauthnProxyEnabled: true,
      pinnedAgentIds: [],
      sidebarSections: [],
    };
  }

  _makeAgentSummary(overrides = {}) {
    const now = Date.now();
    const createdAt = overrides.createdAt ?? overrides.createdAtMs ?? now;
    const updatedAt = overrides.updatedAt ?? overrides.updatedAtMs ?? createdAt;
    const base = {
      id: 'agent-' + crypto.randomUUID().slice(0, 8),
      name: 'New Bot',
      title: '',
      description: '',
      role: 'assistant',
      avatarDataUrl: null,
      avatarVersion: this.realHostProtocol ? null : 1,
      avatarShape: 'circle',
      avatarColor: 'purple',
      createdAt,
      updatedAt,
      createdAtMs: createdAt,
      updatedAtMs: updatedAt,
      isActive: false,
      isRunning: false,
      isComposingMessage: false,
      lastEntry: null,
      lastMessageId: null,
      lastMessagePreview: null,
      lastMessagePreviewSource: null,
      lastMessageAuthorId: null,
      pushMessageContent: null,
      newestEntryId: null,
      hasUnread: false,
      unreadCount: 0,
      lastViewedAt: 0,
      lastActivityAt: 0,
      awaitingUserResponse: null,
      notificationsEnabled: false,
      notifyOnUpdatesEnabled: true,
      isHiddenFromSidebar: false,
      origin: 'user',
      isGroup: false,
      memberIds: [],
    };
    return { ...base, ...overrides };
  }

  _defaultAgents() {
    return [
      this._makeAgentSummary({
        id: 'agent-default',
        name: 'Grok Assistant',
        title: 'Default Bot',
        description: 'General assistant bot',
        avatarShape: 'circle',
        avatarColor: 'blue',
        ...(this.realHostProtocol ? {} : { avatarUrl: 'https://host.example.com/avatars/default.png' }),
        avatarVersion: this.realHostProtocol ? null : 1,
        createdAt: 1731760000000,
        updatedAt: 1731765000000,
        createdAtMs: 1731760000000,
        updatedAtMs: 1731765000000,
        isActive: true,
        isRunning: false,
      }),
      this._makeAgentSummary({
        id: 'agent-coding',
        name: 'Code Companion',
        title: 'Programming Specialist',
        description: 'Coding and terminal assistant',
        avatarShape: 'square',
        avatarColor: 'green',
        avatarVersion: this.realHostProtocol ? null : 1,
        createdAt: 1731761000000,
        updatedAt: 1731766000000,
        createdAtMs: 1731761000000,
        updatedAtMs: 1731766000000,
        isActive: false,
        isRunning: true,
      }),
    ];
  }

  _defaultConnectors() {
    const items = [
      {
        id: 'conn-demo',
        name: 'Demo Workspace MCP',
        displayName: 'Demo Workspace MCP',
        description: 'Sample Host-managed MCP connector',
        installed: false,
        enabled: true,
        auth: { type: 'bearer' },
        credential: null,
        url: 'http://127.0.0.1:9999/mcp',
        disabledTools: [],
        toolPolicy: { tools: {} },
        tools: [
          {
            name: 'echo',
            description: 'Echo text back',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'write_note',
            description: 'Write a workspace note',
            inputSchema: { type: 'object', properties: { body: { type: 'string' } } },
            annotations: { destructiveHint: true },
          },
        ],
        updatedAtMs: Date.now(),
      },
    ];
    return items.map((c, i) => ({ ...c, numericId: 1001 + i }));
  }

  _wantsSlimAvatars(req) {
    const hdr = req?.headers?.['x-sand-slim-avatars'];
    const val = Array.isArray(hdr) ? hdr[0] : hdr;
    return val === '1' || this.realHostProtocol;
  }

  _serializeAgent(agent, slimAvatars = false) {
    if (!agent || typeof agent !== 'object') return agent;
    const copy = { ...agent };
    if (slimAvatars || this.realHostProtocol) {
      copy.avatarDataUrl = null;
    }
    return copy;
  }

  _getOrSeedTranscript(agentId) {
    if (!this.transcripts.has(agentId)) {
      const now = Date.now();
      this.transcripts.set(agentId, [
        {
          kind: 'message',
          id: 'entry-1',
          seq: 1,
          role: 'user',
          content: 'Hello',
          isStreaming: false,
          timestampMs: now - 5000,
        },
        {
          kind: 'send-message',
          id: 'entry-2',
          seq: 2,
          message: { type: 'text', content: 'Hi there!' },
          timestampMs: now - 4000,
          streaming: false,
        },
      ]);
    }
    return this.transcripts.get(agentId);
  }

  _classifyAttachmentKind(fileName, urlOrPath) {
    const classifyOne = raw => {
      const target = String(raw || '').trim().toLowerCase();
      if (!target) return null;
      if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|svg|avif)(?:$|[?#])/.test(target)) return 'image';
      if (/\.(mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|ogv)(?:$|[?#])/.test(target)) return 'video';
      if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)(?:$|[?#])/.test(target)) return 'audio';
      if (/\.pdf(?:$|[?#])/.test(target)) return 'pdf';
      if (/\.(md|markdown)(?:$|[?#])/.test(target)) return 'markdown';
      if (/\.(csv|tsv|xlsx|xls)(?:$|[?#])/.test(target)) return 'table';
      if (/\.json(?:$|[?#])/.test(target)) return 'json';
      if (/\.(txt|html?|log)(?:$|[?#])/.test(target)) return 'text';
      if (/\.docx?(?:$|[?#])/.test(target)) return 'document';
      if (/\.(zip|tar|gz|tgz|7z|rar)(?:$|[?#])/.test(target)) return 'archive';
      return null;
    };
    return classifyOne(fileName) || classifyOne(urlOrPath) || 'file';
  }

  _buildAttachmentLastEntry(paths, names) {
    const counts = new Map();
    for (let i = 0; i < paths.length; i++) {
      const kind = this._classifyAttachmentKind(names[i], paths[i]);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return {
      kind: 'attachment',
      count: paths.length,
      kinds: [...counts].map(([kind, count]) => ({ kind, count })),
    };
  }

  _getPushMessageContent(entries) {
    if (!Array.isArray(entries)) return null;
    let last;
    let predecessorId;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry || entry.kind !== 'send-message') continue;
      if (last === undefined) {
        last = entry;
        continue;
      }
      predecessorId = entry.id;
      break;
    }
    if (!last || !predecessorId) return null;
    const author = last.author && last.author.id && last.author.name
      ? {
          id: last.author.id,
          name: last.author.name,
          ...(last.author.kind !== undefined ? { kind: last.author.kind } : {}),
        }
      : undefined;
    return {
      v: 1,
      predecessorMessageId: predecessorId,
      message: {
        kind: 'send-message',
        id: last.id,
        message: structuredClone(last.message),
        ...(author !== undefined ? { author } : {}),
        ...(last.replyTo !== undefined && last.replyTo !== '' ? { replyTo: last.replyTo } : {}),
        ...(last.batchId !== undefined && last.batchId !== '' ? { batchId: last.batchId } : {}),
        ...(typeof last.timestampMs === 'number' && Number.isFinite(last.timestampMs)
          ? { timestampMs: last.timestampMs }
          : {}),
      },
    };
  }

  _isValidIanaTimeZone(tz) {
    if (typeof tz !== 'string' || tz.length === 0) return false;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch (_) {
      return false;
    }
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server.address();
        this.actualPort = addr.port;
        this.origin = `http://127.0.0.1:${this.actualPort}`;
        this.canonical = this.publicUrl || this.origin;
        resolve(this);
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    // Terminate all SSE connections
    for (const client of this.eventsClients) {
      if (client.hb) clearInterval(client.hb);
      try { client.res.end(); } catch (_) {}
    }
    this.eventsClients.clear();

    for (const client of this.notificationClients) {
      if (client.hb) clearInterval(client.hb);
      try { client.res.end(); } catch (_) {}
    }
    this.notificationClients.clear();

    // Terminate all voice sessions
    for (const [, ws] of this.activeVoiceSessions) {
      try { ws.close(); } catch (_) {}
    }
    this.activeVoiceSessions.clear();

    if (this.usageLedgerDir) {
      try { fs.rmSync(this.usageLedgerDir, { recursive: true, force: true }); } catch (_) {}
      this.usageLedgerDir = null;
    }

    return new Promise(resolve => {
      this.server.close(() => resolve());
    });
  }

  reset() {
    this.devices.clear();
    this.devicesById.clear();
    this.nonces.clear();
    this.voiceTickets.clear();
    this.activeVoiceSessions.clear();
    this.attachmentUploads.clear();
    this.committedAttachments.clear();
    this.libraryFiles.clear();
    this.transcripts.clear();
    this.trays = [];
    this.asyncTasks = [];
    this.notificationHistory = [];
    this.foregroundDevices.clear();
    this.rateLimits.clear();
    this.requestLogs = [];
    this.openedAgentIds = [];
    this.hostSettings = this._defaultHostSettings();
    this.agents = this._defaultAgents();
    this.connectors = this._defaultConnectors();
    this.needsModel = Boolean(this.options.needsModel);
    this.routingMigrated = Boolean(this.options.routingMigrated);
    this.configuredOverride = this.options.configured !== undefined ? this.options.configured : undefined;
    this.canConfigureModel = this.options.canConfigureModel !== false;
    this.requireStepUpPassword = Boolean(this.options.requireStepUpPassword);
    this.modelConfig = this._defaultModelConfig();
    this.modelReload = {
      revision: 'rev-init-1',
      status: 'applied',
      error: null,
      updatedAt: new Date().toISOString(),
    };
    this.androidUpdateManifest = this.options.androidUpdateManifest || null;
    this.androidUpdateArtifacts.clear();
  }

  _defaultModelConfig() {
    if (this.options.needsModel) {
      return { version: 1, providers: [], profiles: [], defaultRoute: null, botRoutes: {} };
    }
    return {
      version: 1,
      providers: [
        {
          id: 'default',
          name: 'OpenAI',
          apiFormat: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-mock-secret-key',
        },
      ],
      profiles: [
        {
          id: 'default',
          name: 'GPT-5',
          providerId: 'default',
          model: 'gpt-5',
          efforts: ['minimal', 'low', 'medium', 'high'],
          contextWindowTokens: 400000,
          summaryThresholdTokens: 160000,
        },
      ],
      defaultRoute: { profileId: 'default', effort: 'default', fallbacks: [] },
      botRoutes: {},
      scenarioRoutes: {},
    };
  }

  _publicModelConfig() {
    const providers = (this.modelConfig.providers || []).map(({ apiKey, ...rest }) => ({
      ...rest,
      hasApiKey: Boolean(apiKey),
    }));
    return {
      version: 1,
      providers,
      profiles: structuredClone(this.modelConfig.profiles || []),
      defaultRoute: this.modelConfig.defaultRoute ? structuredClone(this.modelConfig.defaultRoute) : null,
      botRoutes: structuredClone(this.modelConfig.botRoutes || {}),
      scenarioRoutes: structuredClone(this.modelConfig.scenarioRoutes || {}),
    };
  }

  _isModelConfigConfigured() {
    if (this.configuredOverride !== undefined) return Boolean(this.configuredOverride);
    const providers = this.modelConfig.providers || [];
    const profiles = this.modelConfig.profiles || [];
    return providers.length > 0 && providers.every(p => Boolean(p.apiKey)) && profiles.length > 0 && Boolean(this.modelConfig.defaultRoute);
  }

  _isModelConfigAuthorized(req) {
    const stepUp = req.headers['x-rokbot-admin-password'];
    if (stepUp === this.adminPassword) return true;
    return this.canConfigureModel && !this.requireStepUpPassword;
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf);
      });
      req.on('error', reject);
    });
  }

  _json(res, status, data) {
    const body = Buffer.from(JSON.stringify(data === undefined ? null : data), 'utf-8');
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': body.length
    });
    res.end(body);
  }

  _checkRateLimit(ip) {
    if (this.options.rateLimit === false) return true;
    const limit = typeof this.options.rateLimit === 'number' ? this.options.rateLimit : 10000;
    const now = Date.now();
    let entry = this.rateLimits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 1, resetAt: now + 60000 };
      this.rateLimits.set(ip, entry);
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  }

  _authenticate(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return null;
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authHeader);
    if (!match) return null;
    const token = match[1];
    const device = this.devices.get(token);
    if (!device) return null;
    device.lastSeenAt = Date.now();
    return device;
  }

  async _handleRequest(req, res) {
    const url = new URL(req.url, this.origin);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();
    const ip = req.socket.remoteAddress || '127.0.0.1';

    this.requestLogs.push({ method, pathname, headers: req.headers, query: Object.fromEntries(url.searchParams) });

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-rokbot-foreground, x-rokbot-client, x-rokbot-admin-password, x-sand-slim-avatars, Last-Event-ID');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // Healthcheck endpoints
    if (pathname === '/health' || pathname === '/healthz') {
      if (this.routeHeader) res.setHeader('X-RokBot-Route', this.routeHeader);
      return this._json(res, 200, { ok: true, initialized: true });
    }

    // Testing Control APIs
    if (pathname === '/__mock/reset' && method === 'POST') {
      this.reset();
      return this._json(res, 200, { ok: true });
    }
    if (pathname === '/__mock/stats' && method === 'GET') {
      return this._json(res, 200, {
        devices: this.devices.size,
        activeVoiceSessions: this.activeVoiceSessions.size,
        foregroundDevices: [...this.foregroundDevices],
        requestLogsCount: this.requestLogs.length
      });
    }
    if (pathname === '/__mock/injectEvent' && method === 'POST') {
      const raw = await this._readBody(req);
      const { channel, payload, eventId = crypto.randomUUID() } = JSON.parse(raw.toString('utf-8'));
      const broadcastCount = this._broadcastEvent(channel, payload, eventId);
      return this._json(res, 200, { ok: true, broadcastCount });
    }

    // Pairing endpoint: POST /connect/pair
    if (pathname === '/connect/pair' && method === 'POST') {
      if (!this._checkRateLimit(ip)) {
        return this._json(res, 429, { error: 'Rate limit exceeded' });
      }

      const raw = await this._readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch (err) {
        return this._json(res, 400, { error: 'Invalid JSON payload' });
      }

      const { deviceName, platform, clientKind, pairingKey, password, clientDeviceId, bundleId } = body;

      // Exactly one of pairingKey or password must be provided
      const hasKey = typeof pairingKey === 'string' && pairingKey.trim().length > 0;
      const hasPass = typeof password === 'string' && password.trim().length > 0;
      if ((hasKey && hasPass) || (!hasKey && !hasPass)) {
        return this._json(res, 400, { error: '请只提供配对码或管理员密码之一' });
      }

      // deviceName validation
      if (typeof deviceName !== 'string' || deviceName.trim().length === 0 || deviceName.length > 80) {
        return this._json(res, 400, { error: 'Invalid deviceName' });
      }

      const normalizedClientId = (typeof clientDeviceId === 'string' && clientDeviceId.trim()) ? clientDeviceId.trim() : null;
      const resolvedPlatform = (platform === 'desktop' && clientKind === 'android') ? 'android' : platform;

      let existingDevice = null;
      if (normalizedClientId) {
        for (const d of this.devicesById.values()) {
          if (d.platform === resolvedPlatform && d.clientDeviceId === normalizedClientId) {
            existingDevice = d;
            break;
          }
        }
      }

      // Max device limit check (skip when reusing existing deviceId)
      if (!existingDevice && this.devices.size >= this.maxDevices) {
        return this._json(res, 409, { error: '设备数量已达上限，请先撤销不用的设备' });
      }

      // Auth validation
      if (hasKey) {
        const normalized = pairingKey.trim().toUpperCase().replace(/[\s-]/g, '');
        // Pairing code must be 6 alphanumeric characters excluding I/O/1/0
        const validFormat = /^[A-HJ-NP-Z2-9]{6}$/.test(normalized);
        if (!validFormat || normalized !== this.validPairingKey) {
          return this._json(res, 401, { error: '配对码无效或已过期' });
        }
      } else {
        if (password !== this.adminPassword) {
          return this._json(res, 401, { error: '管理员密码错误' });
        }
      }

      // Generate credentials: 32 random bytes base64url encoded
      const token = crypto.randomBytes(32).toString('base64url');
      let deviceId;
      let device;
      if (existingDevice) {
        this.devices.delete(existingDevice.token);
        deviceId = existingDevice.deviceId;
        existingDevice.token = token;
        existingDevice.deviceName = deviceName.trim();
        existingDevice.clientKind = clientKind || existingDevice.clientKind || null;
        if (bundleId) existingDevice.bundleId = bundleId;
        existingDevice.lastSeenAt = Date.now();
        device = existingDevice;
      } else {
        deviceId = crypto.randomUUID();
        device = {
          deviceId,
          token,
          deviceName: deviceName.trim(),
          platform: resolvedPlatform,
          clientKind: clientKind || null,
          clientDeviceId: normalizedClientId,
          bundleId: (typeof bundleId === 'string' && bundleId.trim()) ? bundleId.trim() : null,
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
          push: null
        };
        this.devicesById.set(deviceId, device);
      }

      this.devices.set(token, device);

      return this._json(res, 201, {
        deviceId,
        token,
        gatewayUrl: this.canonical,
        notificationUrl: `${this.canonical}/notifications/events`
      });
    }

    // All subsequent endpoints require Bearer auth (except when explicitly public)
    const device = this._authenticate(req);
    if (!device) {
      return this._json(res, 401, { error: '设备凭证无效，请重新配对' });
    }

    // Status: GET /connect/status
    if (pathname === '/connect/status' && method === 'GET') {
      return this._json(res, 200, {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        platform: device.platform,
        connected: true,
        needsModel: this.needsModel,
        brand: 'RokBot',
        lastSeenAt: device.lastSeenAt
      });
    }

    // Local Status: GET /local/status
    if (pathname === '/local/status' && method === 'GET') {
      return this._json(res, 200, {
        ok: true,
        initialized: true,
        needsModel: this.needsModel,
        canConfigureModel: this._isModelConfigAuthorized(req),
        hostVersion: '2bb5e41',
        defaultMachineId: '',
      });
    }

    // Local Model Config: GET/PUT /local/model
    if (pathname === '/local/model' && (method === 'GET' || method === 'PUT')) {
      if (!this._isModelConfigAuthorized(req)) {
        return this._json(res, 403, { error: '当前设备未授权修改模型配置，请提供管理员密码' });
      }
      if (method === 'GET') {
        const configured = this._isModelConfigConfigured();
        return this._json(res, 200, {
          ok: true,
          config: this._publicModelConfig(),
          configured,
          needsModel: !configured || this.needsModel,
          routingMigrated: this.routingMigrated,
          reload: this.modelReload,
          canConfigureModel: true,
        });
      }
      const raw = await this._readBody(req);
      let body;
      try { body = JSON.parse(raw.toString('utf-8')); } catch { return this._json(res, 400, { error: 'Invalid JSON' }); }
      if (!body || body.version !== 1 || !Array.isArray(body.providers) || !body.providers.length
          || !Array.isArray(body.profiles) || !body.profiles.length || !body.defaultRoute?.profileId) {
        return this._json(res, 400, { error: '模型配置无效：需要至少一个服务商、模型档案和默认路由' });
      }
      if (this.routingMigrated && body.migrateLegacyRouting !== true) {
        return this._json(res, 409, { error: '检测到旧版模型配置。请在模型页确认迁移后再保存。' });
      }
      const prevMap = new Map((this.modelConfig.providers || []).map(p => [p.id, p]));
      const nextProviders = [];
      for (const p of body.providers) {
        const supplied = typeof p.apiKey === 'string' && p.apiKey.trim() ? p.apiKey.trim() : '';
        const mergedKey = supplied || prevMap.get(p.id)?.apiKey || '';
        if (!mergedKey) {
          return this._json(res, 400, { error: `API Key is required for ${p.id}` });
        }
        nextProviders.push({
          id: p.id,
          name: p.name,
          apiFormat: p.apiFormat || 'openai',
          baseUrl: p.baseUrl,
          apiKey: mergedKey,
        });
      }
      const provIds = new Set(nextProviders.map(p => p.id));
      for (const pf of body.profiles) {
        if (!provIds.has(pf.providerId)) {
          return this._json(res, 400, { error: `Unknown provider: ${pf.providerId}` });
        }
      }
      const profMap = new Map(body.profiles.map(pf => [pf.id, pf]));
      const defPf = profMap.get(body.defaultRoute.profileId);
      if (!defPf) {
        return this._json(res, 400, { error: `Unknown profile: ${body.defaultRoute.profileId}` });
      }
      const defEffort = body.defaultRoute.effort || 'default';
      if (defEffort !== 'default' && Array.isArray(defPf.efforts) && !defPf.efforts.includes(defEffort)) {
        return this._json(res, 400, { error: `模型配置无效：Unsupported effort for ${defPf.id}` });
      }
      this.modelConfig = {
        version: 1,
        providers: nextProviders,
        profiles: body.profiles,
        defaultRoute: body.defaultRoute,
        botRoutes: body.botRoutes && typeof body.botRoutes === 'object' ? body.botRoutes : {},
        scenarioRoutes: body.scenarioRoutes && typeof body.scenarioRoutes === 'object' ? body.scenarioRoutes : {},
      };
      this.needsModel = false;
      this.routingMigrated = false;
      this.configuredOverride = undefined;
      this.modelReload = {
        revision: crypto.randomUUID(),
        status: 'applied',
        error: null,
        updatedAt: new Date().toISOString(),
      };
      const configured = this._isModelConfigConfigured();
      return this._json(res, 200, {
        ok: true,
        config: this._publicModelConfig(),
        configured,
        needsModel: !configured,
        reload: this.modelReload,
        canConfigureModel: true,
      });
    }

    // Local Suggestions settings & quick phrases CRUD
    if (pathname === '/local/suggestions/settings' && method === 'GET') {
      return this._json(res, 200, this.suggestionsSettings);
    }
    if (pathname === '/local/suggestions/settings' && method === 'PUT') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) { return this._json(res, 400, { error: 'Invalid JSON' }); }
      if (typeof body.enabled === 'boolean') this.suggestionsSettings.enabled = body.enabled;
      if (typeof body.aiEnabled === 'boolean') this.suggestionsSettings.aiEnabled = body.aiEnabled;
      if (typeof body.completionEnabled === 'boolean') this.suggestionsSettings.completionEnabled = body.completionEnabled;
      if (Array.isArray(body.quickPhrases)) {
        this.suggestionsSettings.quickPhrases = body.quickPhrases
          .map((item, i) => ({
            id: typeof item === 'object' && item?.id ? String(item.id) : `p_mock_${i + 1}`,
            text: String(typeof item === 'string' ? item : item?.text || '').trim(),
          }))
          .filter(item => item.text);
      }
      this.suggestionsSettings.updatedAt = new Date().toISOString();
      return this._json(res, 200, this.suggestionsSettings);
    }
    if (pathname === '/local/suggestions/phrases' && method === 'GET') {
      return this._json(res, 200, { quickPhrases: this.suggestionsSettings.quickPhrases, updatedAt: this.suggestionsSettings.updatedAt });
    }
    if (pathname === '/local/suggestions/phrases' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) { return this._json(res, 400, { error: 'Invalid JSON' }); }
      const text = String(body.text || '').replace(/\s+/g, ' ').trim();
      if (!text) return this._json(res, 400, { error: '常用语不能为空' });
      if (this.suggestionsSettings.quickPhrases.some(p => p.text.toLowerCase() === text.toLowerCase())) {
        return this._json(res, 400, { error: '该常用语已存在' });
      }
      const phrase = { id: `p_${crypto.randomBytes(4).toString('hex')}`, text };
      this.suggestionsSettings.quickPhrases.push(phrase);
      this.suggestionsSettings.updatedAt = new Date().toISOString();
      return this._json(res, 201, { phrase, quickPhrases: this.suggestionsSettings.quickPhrases, updatedAt: this.suggestionsSettings.updatedAt });
    }
    if (pathname === '/local/suggestions/phrases/reorder' && (method === 'PUT' || method === 'POST')) {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) { return this._json(res, 400, { error: 'Invalid JSON' }); }
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const map = new Map(this.suggestionsSettings.quickPhrases.map(p => [p.id, p]));
      if (ids.length !== map.size || ids.some(id => !map.has(id))) {
        return this._json(res, 400, { error: '排序 ID 列表无效' });
      }
      this.suggestionsSettings.quickPhrases = ids.map(id => map.get(id));
      this.suggestionsSettings.updatedAt = new Date().toISOString();
      return this._json(res, 200, { quickPhrases: this.suggestionsSettings.quickPhrases, updatedAt: this.suggestionsSettings.updatedAt });
    }
    const phraseMatch = /^\/local\/suggestions\/phrases\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
    if (phraseMatch && (method === 'PUT' || method === 'PATCH')) {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) { return this._json(res, 400, { error: 'Invalid JSON' }); }
      const text = String(body.text || '').replace(/\s+/g, ' ').trim();
      if (!text) return this._json(res, 400, { error: '常用语不能为空' });
      const idx = this.suggestionsSettings.quickPhrases.findIndex(p => p.id === phraseMatch[1]);
      if (idx < 0) return this._json(res, 404, { error: '常用语不存在' });
      const phrase = { id: phraseMatch[1], text };
      this.suggestionsSettings.quickPhrases[idx] = phrase;
      this.suggestionsSettings.updatedAt = new Date().toISOString();
      return this._json(res, 200, { phrase, quickPhrases: this.suggestionsSettings.quickPhrases, updatedAt: this.suggestionsSettings.updatedAt });
    }
    if (phraseMatch && method === 'DELETE') {
      const before = this.suggestionsSettings.quickPhrases.length;
      this.suggestionsSettings.quickPhrases = this.suggestionsSettings.quickPhrases.filter(p => p.id !== phraseMatch[1]);
      if (this.suggestionsSettings.quickPhrases.length === before) return this._json(res, 404, { error: '常用语不存在' });
      this.suggestionsSettings.updatedAt = new Date().toISOString();
      return this._json(res, 200, { ok: true, quickPhrases: this.suggestionsSettings.quickPhrases, updatedAt: this.suggestionsSettings.updatedAt });
    }

    // Inline completion (ghost text): POST /local/suggestions/complete. Deterministic fake model:
    // the rest of a known sentence when the draft is a prefix of it, otherwise a fixed tail.
    if (pathname === '/local/suggestions/complete' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {}
      const text = String(body.text ?? '');
      const draft = text.trim();
      const agentId = String(body.agentId || '').trim();
      this.completionRequests.push({ agentId, text, locale: body.locale || null });
      const zh = /[\u4e00-\u9fff]/.test(draft) || (!/[A-Za-z]/.test(draft) && /^zh/i.test(String(body.locale || '')));
      const reply = (completion, source, extra = {}) => this._json(res, 200, {
        enabled: this.suggestionsSettings.completionEnabled !== false, text, completion, source, cached: false, ...extra,
      });
      if (this.suggestionsSettings.completionEnabled === false) return reply('', 'disabled');
      if (draft.length < 2) return reply('', 'too-short');
      const transcript = agentId ? (this.transcripts.get(agentId) || []) : [];
      const hasHistory = transcript.length > 0 || (Array.isArray(body.recentMessages) && body.recentMessages.length > 0);
      if (!hasHistory) return reply('', 'empty');
      if (this.completionDelayMs > 0) {
        const aborted = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), this.completionDelayMs);
          res.once('close', () => { if (!res.writableEnded) { clearTimeout(timer); resolve(true); } });
        });
        if (aborted || res.destroyed) return undefined;
      }
      const sentences = zh
        ? ['帮我总结一下今天的进展和下一步计划', '请检查最新的运行日志并找出报错原因', '把关键结论整理成清单']
        : ['Can you summarize the latest changes and next steps', 'Please check the build logs for errors', 'List the key takeaways'];
      const hit = sentences.find(sentence => sentence.startsWith(text) && sentence.length > text.length);
      const completion = hit ? hit.slice(text.length) : (zh ? '，并给出下一步建议' : ' and suggest the next steps');
      return reply(completion, 'model', { lang: zh ? 'zh' : 'en' });
    }

    // Local Suggestions: POST /local/suggestions
    if (pathname === '/local/suggestions' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {}
      if (this.suggestionsDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.suggestionsDelayMs));
      const zh = /^zh/i.test(String(body.locale || ''));
      const lang = zh ? 'zh' : 'en';
      if (!this.suggestionsSettings.enabled) {
        return this._json(res, 200, {
          enabled: false,
          aiEnabled: this.suggestionsSettings.aiEnabled,
          quickPhrases: [],
          aiSuggestions: [],
          suggestions: [],
          items: [],
          source: 'disabled',
          cached: false,
          lang,
        });
      }
      const quickPhrases = this.suggestionsSettings.quickPhrases.map(p => ({ id: p.id, text: p.text }));
      const agentId = String(body.agentId || '').trim();
      const transcript = agentId ? (this.transcripts.get(agentId) || []) : [];
      const hasHistory = transcript.length > 0 || (Array.isArray(body.recentMessages) && body.recentMessages.length > 0);
      const aiSuggestions = (this.suggestionsSettings.aiEnabled && hasHistory)
        ? (zh ? ['查看最新运行日志', '把关键结论整理成清单', '下一步怎么验证？']
              : ['Check the latest logs', 'List the key takeaways', 'How should we verify next?'])
        : [];
      const source = !this.suggestionsSettings.aiEnabled ? 'phrases-only' : (hasHistory ? 'model' : 'empty');
      const items = [
        ...quickPhrases.map(p => ({ type: 'phrase', id: p.id, text: p.text })),
        ...aiSuggestions.map(text => ({ type: 'ai', text })),
      ];
      return this._json(res, 200, {
        enabled: true,
        aiEnabled: this.suggestionsSettings.aiEnabled,
        quickPhrases,
        aiSuggestions,
        suggestions: items.map(i => i.text),
        items,
        source,
        cached: false,
        lang,
      });
    }

    // Local Model Catalog: POST /local/model/catalog
    if (pathname === '/local/model/catalog' && method === 'POST') {
      if (!this._isModelConfigAuthorized(req)) {
        return this._json(res, 403, { error: '当前设备未授权访问模型目录' });
      }
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch { return this._json(res, 400, { error: 'Invalid JSON' }); }
      const prevMap = new Map((this.modelConfig.providers || []).map(p => [p.id, p]));
      const prov = body.provider || prevMap.get(body.providerId) || this.modelConfig.providers?.[0];
      if (!prov) {
        return this._json(res, 400, { error: 'Provider required' });
      }
      const effectiveKey = (typeof prov.apiKey === 'string' && prov.apiKey.trim())
        ? prov.apiKey.trim()
        : (prevMap.get(prov.id)?.apiKey || '');
      if (!effectiveKey) {
        return this._json(res, 400, { error: `API Key is required for ${prov.id}` });
      }
      return this._json(res, 200, {
        ok: true,
        models: [
          {
            id: 'gpt-5',
            efforts: ['minimal', 'low', 'medium', 'high'],
            source: 'provider',
            contextWindowTokens: 400000,
            summaryThresholdTokens: 160000,
          },
          {
            id: 'claude-sonnet-4-5',
            efforts: ['low', 'medium', 'high'],
            source: 'reference',
            contextWindowTokens: 200000,
            summaryThresholdTokens: 120000,
          },
        ],
      });
    }

    // Local Model Test: POST /local/model/test
    if (pathname === '/local/model/test' && method === 'POST') {
      if (!this._isModelConfigAuthorized(req)) {
        return this._json(res, 403, { error: '当前设备未授权测试模型' });
      }
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch { return this._json(res, 400, { error: 'Invalid JSON' }); }
      const hasConfig = Array.isArray(body.providers) || Boolean(body.defaultRoute) || body.version === 1;
      if (hasConfig && this.routingMigrated && body.migrateLegacyRouting !== true) {
        return this._json(res, 409, { error: '检测到旧版模型配置。请在模型页确认迁移后再保存。' });
      }
      const profiles = Array.isArray(body.profiles) ? body.profiles : (this.modelConfig.profiles || []);
      const targetId = body.profileId || body.defaultRoute?.profileId || this.modelConfig.defaultRoute?.profileId;
      const profile = profiles.find(p => p.id === targetId) || profiles[0];
      if (!profile) {
        return this._json(res, 400, { error: 'No model profile to test' });
      }
      const testEffort = body.defaultRoute?.effort || 'default';
      if (hasConfig && targetId === body.defaultRoute?.profileId && testEffort !== 'default'
          && Array.isArray(profile.efforts) && !profile.efforts.includes(testEffort)) {
        return this._json(res, 400, { error: `模型配置无效：Unsupported effort for ${profile.id}` });
      }
      return this._json(res, 200, {
        ok: true,
        profileId: profile.id,
        model: profile.model,
        reply: 'OK',
        latencyMs: 28,
        message: '模型接口已完成真实请求',
      });
    }

    // Host Android Update Proxy: GET /local/updates/fetch?url=...
    if (pathname === '/local/updates/fetch' && method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target || (!target.startsWith('http://') && !target.startsWith('https://'))) {
        return this._json(res, 400, { error: 'Invalid update URL' });
      }
      try {
        const proxied = await fetch(target);
        const buf = Buffer.from(await proxied.arrayBuffer());
        res.writeHead(proxied.status, {
          'Content-Type': proxied.headers.get('content-type') || 'application/octet-stream',
          'Content-Length': buf.length,
        });
        return res.end(buf);
      } catch (err) {
        return this._json(res, 502, { error: err?.message || 'Proxy fetch failed' });
      }
    }

    // Host Android Update Manifest & Artifacts: GET /local/updates/android.json & /local/updates/files/android/:filename
    if (pathname === '/local/updates/android.json' && method === 'GET') {
      if (!this.androidUpdateManifest) {
        return this._json(res, 404, { error: 'No Android update published' });
      }
      return this._json(res, 200, this.androidUpdateManifest);
    }
    if (pathname.startsWith('/local/updates/files/android/') && method === 'GET') {
      const filename = decodeURIComponent(pathname.slice('/local/updates/files/android/'.length));
      const buf = this.androidUpdateArtifacts.get(filename);
      if (!buf) {
        return this._json(res, 404, { error: 'Artifact not found' });
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length,
        'Accept-Ranges': 'bytes',
      });
      return res.end(buf);
    }

    // Bot List: POST /api/listAgents
    if (pathname === '/api/listAgents' && method === 'POST') {
      const slim = this._wantsSlimAvatars(req);
      return this._json(res, 200, this.agents.map(a => this._serializeAgent(a, slim)));
    }

    // Send Prompt: POST /api/sendPrompt
    if (pathname === '/api/sendPrompt' && method === 'POST') {
      const raw = await this._readBody(req);
      if (raw.length > 256 * 1024) {
        return this._json(res, 413, { error: 'Prompt exceeds 256 KB limit' });
      }

      let body;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch (err) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }

      const { agentId, clientNonce, prompt, attachmentPaths, attachmentNames } = body;
      const hasNonce = typeof clientNonce === 'string' && clientNonce.length > 0;
      if (!this.realHostProtocol && (!agentId || !hasNonce)) {
        return this._json(res, 400, { error: 'agentId and clientNonce are required' });
      }

      const effectiveAgentId = (typeof agentId === 'string' && agentId.length > 0)
        ? agentId
        : (this.agents[0]?.id || 'agent-default');

      // Deduplication / Idempotency check
      if (hasNonce && this.nonces.has(clientNonce)) {
        return this._json(res, 200, this.nonces.get(clientNonce));
      }

      const messageId = crypto.randomUUID();
      const responsePayload = this.realHostProtocol
        ? { accepted: true }
        : { accepted: true, nonce: clientNonce, messageId };
      if (hasNonce) {
        this.nonces.set(clientNonce, responsePayload);
      }

      const paths = Array.isArray(attachmentPaths) ? attachmentPaths : [];
      if (this.realHostProtocol && String(prompt || '').trim().length === 0 && paths.length === 0) {
        return this._json(res, 200, responsePayload);
      }

      const list = this._getOrSeedTranscript(effectiveAgentId);
      const replyText = `Echo response to "${prompt || ''}"`;
      const now = Date.now();

      if (this.realHostProtocol) {
        const batchId = crypto.randomUUID();
        const appendedEntries = [];
        const names = Array.isArray(attachmentNames) ? attachmentNames : [];
        for (let i = 0; i < paths.length; i++) {
          const p = paths[i];
          const nm = names[i] || String(p).split('/').pop() || 'attachment.bin';
          const attEntry = {
            kind: 'user-attachment',
            id: `att-${messageId}-${i}`,
            seq: list.length + 1,
            file_path: p,
            file_name: nm,
            batchId,
            ...(hasNonce ? { clientNonce } : {}),
            timestampMs: now + i
          };
          list.push(attEntry);
          appendedEntries.push(attEntry);
        }

        const userEntry = {
          kind: 'message',
          id: `user-${messageId}`,
          seq: list.length + 1,
          role: 'user',
          content: prompt || '',
          isStreaming: false,
          batchId,
          ...(hasNonce ? { clientNonce } : {}),
          timestampMs: now + paths.length
        };
        list.push(userEntry);
        appendedEntries.push(userEntry);

        const targetAgent = this.agents.find(a => a.id === effectiveAgentId) || this._makeAgentSummary({
          id: effectiveAgentId,
          name: effectiveAgentId,
        });
        targetAgent.isRunning = true;
        if (userEntry.content.length > 0) {
          targetAgent.lastEntry = { kind: 'text', text: userEntry.content };
        } else if (paths.length > 0) {
          targetAgent.lastEntry = this._buildAttachmentLastEntry(paths, names);
        }
        targetAgent.newestEntryId = userEntry.id;
        targetAgent.updatedAt = now;
        targetAgent.updatedAtMs = now;
        targetAgent.lastActivityAt = now;

        this._broadcastEvent('agent-upserted', {
          activeAgentId: effectiveAgentId,
          agent: this._serializeAgent(targetAgent, false),
        });

        for (const entry of appendedEntries) {
          this._broadcastEvent('transcript', {
            type: 'appended',
            agentId: effectiveAgentId,
            entry,
          });
        }

        const replyId = `reply-${messageId}`;
        const replySeq = list.length + 1;
        const replyTs = now + paths.length + 10;
        const partialText = replyText.slice(0, Math.max(1, Math.ceil(replyText.length / 2)));

        const streamingStartEntry = {
          kind: 'send-message',
          id: replyId,
          seq: replySeq,
          streaming: true,
          message: { type: 'text', content: partialText },
          requestId: messageId,
          timestampMs: replyTs,
        };
        this._broadcastEvent('transcript', {
          type: 'appended',
          agentId: effectiveAgentId,
          entry: streamingStartEntry,
        });

        const streamingMidEntry = {
          ...streamingStartEntry,
          streaming: true,
          message: { type: 'text', content: replyText },
        };
        this._broadcastEvent('transcript', {
          type: 'updated',
          agentId: effectiveAgentId,
          entry: streamingMidEntry,
        });

        const replyEntry = {
          ...streamingStartEntry,
          streaming: false,
          message: { type: 'text', content: replyText },
        };
        list.push(replyEntry);
        this._broadcastEvent('transcript', {
          type: 'updated',
          agentId: effectiveAgentId,
          entry: replyEntry,
        });

        targetAgent.isRunning = false;
        // Match host-main.cjs (getLastEntryFromTranscript / getLastMessageFromTranscript):
        // - lastEntry for text send-message is { kind: 'text', text } (never kind: 'send-message')
        // - lastMessagePreviewSource is null for message_text (isLocalizableSessionPreview('message_text') === false)
        // - lastMessageAuthorId is entry.author?.id ?? null (null for bot replies)
        // - pushMessageContent is { v: 1, predecessorMessageId, message } when >=2 send-message entries exist, else null
        targetAgent.lastEntry = { kind: 'text', text: replyText };
        targetAgent.lastMessageId = replyId;
        targetAgent.lastMessagePreview = replyText;
        targetAgent.lastMessagePreviewSource = null;
        targetAgent.lastMessageAuthorId = null;
        targetAgent.pushMessageContent = this._getPushMessageContent(list);
        targetAgent.newestEntryId = replyId;
        targetAgent.lastActivityAt = replyTs;
        targetAgent.updatedAt = replyTs;
        targetAgent.updatedAtMs = replyTs;

        this._broadcastEvent('agent-upserted', {
          activeAgentId: effectiveAgentId,
          agent: this._serializeAgent(targetAgent, false),
        });
      } else {
        const userSeq = list.length + 1;
        const replySeq = list.length + 2;
        list.push({
          id: `user-${messageId}`,
          seq: userSeq,
          role: 'user',
          kind: 'send-message',
          content: prompt || '',
          message: { type: 'text', content: prompt || '' },
          attachmentPaths: attachmentPaths || [],
          attachmentNames: attachmentNames || [],
          timestampMs: now
        });
        list.push({
          id: `reply-${messageId}`,
          seq: replySeq,
          role: 'assistant',
          message: { type: 'text', content: replyText },
          timestampMs: now + 10
        });

        // Broadcast simulated SSE events to connected /events streams
        const runId = crypto.randomUUID();
        this._broadcastEvent('agent-run', {
          agentId,
          runId,
          status: 'running',
          prompt,
          attachmentPaths: attachmentPaths || []
        });

        this._broadcastEvent('agent-transcript', {
          agentId,
          runId,
          messageId,
          role: 'assistant',
          delta: replyText,
          done: true
        });
      }

      return this._json(res, 200, responsePayload);
    }

    // Prompt acceptance query: POST /api/promptAcceptanceStatus
    if (pathname === '/api/promptAcceptanceStatus' && method === 'POST') {
      const raw = await this._readBody(req);
      const { clientNonce } = JSON.parse(raw.toString('utf-8'));
      if (this.nonces.has(clientNonce)) {
        return this._json(res, 200, this.nonces.get(clientNonce));
      }
      return this._json(res, 404, { error: 'Nonce not found' });
    }

    // Interrupt: POST /api/interruptAgentRun
    if (pathname === '/api/interruptAgentRun' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try {
        body = JSON.parse(raw.toString('utf-8') || '{}');
      } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      const { id } = body;
      if (this.realHostProtocol) {
        const now = Date.now();
        const existing = this.agents.find(a => a.id === id);
        const target = existing || this._makeAgentSummary({
          id: id || 'agent-default',
          name: id || 'agent-default',
        });
        target.isRunning = false;
        target.updatedAt = now;
        target.updatedAtMs = now;
        this._broadcastEvent('agent-upserted', {
          activeAgentId: target.id,
          agent: this._serializeAgent(target, false),
        });
      } else {
        this._broadcastEvent('agent-state', { agentId: id, status: 'interrupted' });
      }
      return this._json(res, 200, { accepted: true });
    }

    // Transcripts: POST /api/getAgentTranscriptTail, POST /api/getAgentTranscript
    if ((pathname === '/api/getAgentTranscriptTail' || pathname === '/api/getAgentTranscript') && method === 'POST') {
      const raw = await this._readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString('utf-8') || '{}');
      } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      if (body.beforeSeq !== undefined && (typeof body.beforeSeq !== 'number' || Number.isNaN(body.beforeSeq))) {
        return this._json(res, 400, {
          error: `getAgentTranscriptTail: args.beforeSeq: must be number, got ${body.beforeSeq === null ? 'null' : typeof body.beforeSeq}`
        });
      }
      const agentId = body.id || 'agent-default';
      const list = this._getOrSeedTranscript(agentId);
      if (this.realHostProtocol && pathname === '/api/getAgentTranscriptTail') {
        const beforeSeq = typeof body.beforeSeq === 'number' && Number.isFinite(body.beforeSeq) ? body.beforeSeq : null;
        const filtered = beforeSeq !== null ? list.filter(e => (e.seq || 0) < beforeSeq) : list;
        const limit = Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 5000) : 500;
        const hasMore = filtered.length > limit;
        const slice = limit > 0 ? filtered.slice(-limit) : [];
        return this._json(res, 200, {
          entries: slice,
          ...(hasMore && slice.length > 0 && typeof slice[0].seq === 'number' ? { nextBeforeSeq: slice[0].seq } : {}),
        });
      }
      return this._json(res, 200, {
        entries: list,
        nextBeforeSeq: null,
        cloudAgentPeerIds: []
      });
    }

    // Windowed Transcript APIs: POST /api/openAgentWindowed, /api/getAgentTranscriptWindow
    if ((pathname === '/api/openAgentWindowed' || pathname === '/api/getAgentTranscriptWindow') && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try {
        body = JSON.parse(raw.toString('utf-8') || '{}');
      } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      const agentId = body.id || body.agentId || 'agent-default';
      if (pathname === '/api/openAgentWindowed') {
        this.openedAgentIds.push(agentId);
      }
      const list = this._getOrSeedTranscript(agentId);
      const beforeSeq = typeof body.beforeSeq === 'number' && Number.isFinite(body.beforeSeq) ? body.beforeSeq : null;
      const filtered = beforeSeq !== null ? list.filter(e => (e.seq || 0) < beforeSeq) : list;
      const limit = Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 5000) : 500;
      const hasMore = filtered.length > limit;
      const slice = limit > 0 ? filtered.slice(-limit) : [];
      return this._json(res, 200, {
        entries: slice,
        ...(hasMore && slice.length > 0 && typeof slice[0].seq === 'number' ? { nextBeforeSeq: slice[0].seq } : {}),
        threadCounts: {},
      });
    }

    // Host capabilities / trays / window focus / async tasks (1.16.0 official client)
    if ((pathname === '/api/getHostStatus' || pathname === '/api/getHostCapabilities') && method === 'POST') {
      if (this.realHostProtocol) {
        return this._json(res, 200, {
          hostVersion: 'mock-1.0.0',
          latestHostVersion: 'mock-1.0.0',
          hostUpdateAvailable: false,
          isBusy: this.agents.some(a => a.isRunning),
          capabilities: ['orderedReplicasV1', 'sendAcceptanceV1'],
        });
      }
      return this._json(res, 200, {
        ok: true,
        status: 'connected',
        capabilities: ['windowedTranscript']
      });
    }
    if (pathname === '/api/getTrays' && method === 'POST') {
      return this._json(res, 200, this.trays ?? []);
    }
    if (pathname === '/api/dismissTray' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {}
      if (body && typeof body.id === 'string') {
        this.trays = (this.trays ?? []).filter(t => t.id !== body.id);
      }
      return this._json(res, 200, this.realHostProtocol ? null : { ok: true });
    }
    if (pathname === '/api/clearTrays' && method === 'POST') {
      this.trays = [];
      return this._json(res, 200, this.realHostProtocol ? null : { ok: true });
    }
    if (pathname === '/api/setWindowFocused' && method === 'POST') {
      return this._json(res, 200, this.realHostProtocol ? null : { ok: true });
    }
    if (pathname === '/api/getAsyncTasks' && method === 'POST') {
      return this._json(res, 200, this.asyncTasks ?? []);
    }

    // Core SSE Events: GET /events
    if (pathname === '/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive'
      });
      res.flushHeaders();

      const rawChannels = url.searchParams.get('channels');
      const channelList = rawChannels === null
        ? []
        : rawChannels.split(',').map(c => c.trim()).filter(Boolean);
      const subscribedChannels = channelList.length > 0 ? new Set(channelList) : null;
      const slimHdr = req.headers['x-sand-slim-avatars'];
      const slimAvatars = (Array.isArray(slimHdr) ? slimHdr[0] : slimHdr) === '1';

      const client = {
        res,
        deviceId: device.deviceId,
        lastEventId: req.headers['last-event-id'],
        subscribedChannels,
        slimAvatars,
      };
      this.eventsClients.add(client);

      if (this.realHostProtocol) {
        // Real 1.16.0 Host sends retry directive, initial box-disk-pressure if subscribed, and :ping keepalives
        res.write('retry: 1000\n\n');
        if (!subscribedChannels || subscribedChannels.has('box-disk-pressure')) {
          res.write(`id: ${crypto.randomUUID()}\ndata: ${JSON.stringify({ channel: 'box-disk-pressure', payload: null })}\n\n`);
        }
      } else {
        // Legacy mock transport packets asserted by unit tests
        res.write(`id: ${crypto.randomUUID()}\ndata: ${JSON.stringify({ channel: 'coordinator-transport-state', payload: { state: 'connected' } })}\n\n`);
        res.write(`id: ${crypto.randomUUID()}\ndata: ${JSON.stringify({ channel: 'transport-connected', payload: { generation: 1 } })}\n\n`);
      }

      // Heartbeat
      const hbChunk = this.realHostProtocol ? ':ping\n\n' : ': heartbeat\n\n';
      const hb = setInterval(() => {
        try { res.write(hbChunk); } catch (_) { clearInterval(hb); }
      }, 15000);
      hb.unref();
      client.hb = hb;

      req.on('close', () => {
        clearInterval(hb);
        this.eventsClients.delete(client);
      });
      return;
    }

    // Push device registration: PUT /local/device, GET /local/device
    if (pathname === '/local/device') {
      if (method === 'PUT') {
        const raw = await this._readBody(req);
        let body;
        try {
          body = JSON.parse(raw.toString('utf-8'));
        } catch (_) {
          return this._json(res, 400, { error: 'Invalid JSON' });
        }

        const validProviders = ['apns', 'bark', 'ntfy', 'unifiedpush', 'webhook', 'fcm', 'none'];
        if (body.push && body.push.provider && !validProviders.includes(body.push.provider)) {
          return this._json(res, 400, { error: 'Invalid push provider' });
        }

        // Validate provider specifics
        if (body.push && body.push.provider === 'bark' && !body.push.barkUrl) {
          return this._json(res, 400, { error: 'barkUrl is required for bark provider' });
        }
        if (body.push && body.push.provider === 'fcm' && !body.push.fcmToken) {
          return this._json(res, 400, { error: 'fcmToken is required for fcm provider' });
        }
        if (body.push && body.push.provider === 'ntfy' && !body.push.ntfyUrl) {
          return this._json(res, 400, { error: 'ntfyUrl is required for ntfy provider' });
        }
        if (body.push && body.push.provider === 'unifiedpush' && !body.push.endpoint) {
          return this._json(res, 400, { error: 'endpoint is required for unifiedpush provider' });
        }
        if (body.push && body.push.provider === 'webhook' && !body.push.webhookUrl) {
          return this._json(res, 400, { error: 'webhookUrl is required for webhook provider' });
        }

        Object.assign(device, {
          name: body.name || device.deviceName,
          kind: body.kind || device.platform,
          bundleId: body.bundleId,
          appVersion: body.appVersion,
          pushCapable: body.pushCapable ?? true,
          push: body.push || null
        });

        return this._json(res, 200, {
          deviceId: device.deviceId,
          name: device.name,
          kind: device.kind,
          pushCapable: device.pushCapable,
          push: device.push
        });
      } else if (method === 'GET') {
        return this._json(res, 200, {
          deviceId: device.deviceId,
          name: device.deviceName,
          kind: device.platform,
          pushCapable: device.pushCapable ?? true,
          push: device.push
        });
      }
    }

    // Push test: POST /local/device/push/test
    if (pathname === '/local/device/push/test' && method === 'POST') {
      const notificationId = crypto.randomUUID();
      const notificationItem = {
        id: notificationId,
        type: 'test',
        agentId: 'agent-default',
        title: 'Push Test',
        body: 'Push delivery test from RokBot Host',
        createdAt: new Date().toISOString(),
        deepLink: 'rokbot-local://agent/agent-default'
      };

      this.notificationHistory.push(notificationItem);

      // Check foreground suppression: if active foreground SSE stream exists
      const isForeground = this.foregroundDevices.has(device.deviceId);
      if (isForeground) {
        // Suppress background push; send only over notification SSE stream
        this._broadcastNotification(notificationItem, device.deviceId);
        return this._json(res, 200, {
          ok: true,
          delivered: true,
          suppressed: true,
          reason: '应用正在前台接收通知',
          notificationId
        });
      }

      // Background push delivery simulation
      return this._json(res, 200, {
        ok: true,
        delivered: true,
        suppressed: false,
        provider: device.push?.provider || 'none',
        notificationId
      });
    }

    // Notifications Event Stream: GET /notifications/events
    if (pathname === '/notifications/events' && method === 'GET') {
      const isForeground = req.headers['x-rokbot-foreground'] === '1';
      if (isForeground) {
        this.foregroundDevices.add(device.deviceId);
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive'
      });
      res.flushHeaders();

      const client = { res, deviceId: device.deviceId, isForeground };
      this.notificationClients.add(client);

      const hb = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(hb); }
      }, 15000);
      hb.unref();
      client.hb = hb;

      req.on('close', () => {
        clearInterval(hb);
        this.notificationClients.delete(client);
        if (isForeground) {
          // Check if device has other foreground connections
          let stillForeground = false;
          for (const c of this.notificationClients) {
            if (c.deviceId === device.deviceId && c.isForeground) stillForeground = true;
          }
          if (!stillForeground) this.foregroundDevices.delete(device.deviceId);
        }
      });
      return;
    }

    // Notifications history: GET /notifications
    if (pathname === '/notifications' && method === 'GET') {
      return this._json(res, 200, this.notificationHistory);
    }

    // Voice Session: POST /local/voice/session
    if (pathname === '/local/voice/session' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      if (raw.length > 0) {
        try { body = JSON.parse(raw.toString('utf-8')); } catch (_) {}
      }

      const { agentId = 'agent-default', audioProcessing } = body;

      // Clean expired tickets
      const now = Date.now();
      for (const [k, ticket] of this.voiceTickets) {
        if (ticket.expiresAt <= now || ticket.deviceId === device.deviceId) {
          this.voiceTickets.delete(k);
        }
      }

      if (this.voiceTickets.size >= 64) {
        return this._json(res, 429, { error: 'Too many pending voice sessions' });
      }

      // Client secret: 32 random bytes -> 43 base64url chars
      const clientSecret = crypto.randomBytes(32).toString('base64url');
      const expiresAt = now + 60000;
      const secretHash = crypto.createHash('sha256').update(clientSecret).digest('hex');

      const ticket = {
        deviceId: device.deviceId,
        agentId,
        audioProcessing: audioProcessing || 'native-aec-v1',
        clientSecret,
        expiresAt,
        callId: crypto.randomUUID()
      };

      this.voiceTickets.set(secretHash, ticket);

      const canonUrl = new URL(this.canonical);
      const wsProtocol = canonUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${canonUrl.host}/local/voice/realtime`;

      return this._json(res, 200, {
        clientSecret,
        websocketUrl: wsUrl,
        model: 'host-configured',
        expiresAtUnixSeconds: Math.floor(expiresAt / 1000)
      });
    }

    // Voice Status: GET /local/voice/status
    if (pathname === '/local/voice/status' && method === 'GET') {
      return this._json(res, 200, {
        enabled: true,
        configured: true,
        activeSessions: this.activeVoiceSessions.size
      });
    }

    // Multimodal Chunked Upload: POST /api/uploadAttachmentChunk
    if (pathname === '/api/uploadAttachmentChunk' && method === 'POST') {
      const raw = await this._readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }

      const { agentId, uploadId, filename, offset, totalSize, bytesBase64 } = body;
      if (!agentId || !uploadId || !filename || offset === undefined || totalSize === undefined || !bytesBase64) {
        return this._json(res, 400, { error: 'Missing required chunk fields' });
      }

      // Check standard 25MB vs video 200MB limits
      const isVideo = /\.(mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|ogv)$/i.test(filename);
      const limit = isVideo ? 200 * 1024 * 1024 : 25 * 1024 * 1024;
      if (totalSize > limit) {
        return this._json(res, 413, { error: `File size exceeds ${isVideo ? '200 MB' : '25 MB'} limit` });
      }

      const chunkBuffer = Buffer.from(bytesBase64, 'base64');
      if (offset + chunkBuffer.length > totalSize) {
        return this._json(res, 400, { error: 'Chunk bounds exceed declared totalSize' });
      }

      let upload = this.attachmentUploads.get(uploadId);
      if (!upload) {
        upload = { agentId, filename, totalSize, received: 0, chunks: [] };
        this.attachmentUploads.set(uploadId, upload);
      }

      upload.chunks.push({ offset, buffer: chunkBuffer });
      upload.received += chunkBuffer.length;

      // Completion check
      if (offset + chunkBuffer.length === totalSize) {
        // Assemble final buffer
        upload.chunks.sort((a, b) => a.offset - b.offset);
        const finalBuffer = Buffer.concat(upload.chunks.map(c => c.buffer));
        const committedPath = this.realHostProtocol
          ? `/data/runtime/host-data/agents/${agentId}/attachments/${filename}`
          : `file:///data/agents/${agentId}/attachments/${filename}`;
        const storeKey = committedPath.startsWith('file://') ? committedPath : `file://${committedPath}`;

        let mime = 'application/octet-stream';
        if (/\.png$/i.test(filename)) mime = 'image/png';
        else if (/\.(jpe?g)$/i.test(filename)) mime = 'image/jpeg';
        else if (/\.webp$/i.test(filename)) mime = 'image/webp';
        else if (/\.gif$/i.test(filename)) mime = 'image/gif';
        else if (/\.mp4$/i.test(filename)) mime = 'video/mp4';

        this.committedAttachments.set(storeKey, { buffer: finalBuffer, mime, filename });
        this.attachmentUploads.delete(uploadId);

        return this._json(res, 200, { committedPath });
      }

      return this._json(res, 200, {});
    }

    // Attachment readback: POST /connect/attachment
    if (pathname === '/connect/attachment' && method === 'POST') {
      const raw = await this._readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }

      const { url: attachmentUrl } = body;
      if (!attachmentUrl || typeof attachmentUrl !== 'string') {
        return this._json(res, 400, { error: 'url parameter required' });
      }

      if (!attachmentUrl.startsWith('file://')) {
        return this._json(res, 400, { error: 'Attachment URL must start with file://' });
      }

      // Traversal protection
      if (
        attachmentUrl.includes('..') ||
        (!attachmentUrl.startsWith('file:///data/agents/') &&
         !attachmentUrl.startsWith('file:///data/runtime/host-data/agents/'))
      ) {
        return this._json(res, 403, { error: 'Directory traversal forbidden' });
      }

      // Supported formats check: png, webp, jpg, jpeg, gif
      if (!/\.(png|webp|jpe?g|gif)$/i.test(attachmentUrl)) {
        return this._json(res, 415, { error: 'Unsupported media type' });
      }

      const item = this.committedAttachments.get(attachmentUrl);
      if (!item) {
        // Fallback: return mock data for valid path
        const mockBase64 = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;').toString('base64');
        return this._json(res, 200, {
          dataUrl: `data:image/gif;base64,${mockBase64}`
        });
      }

      if (item.buffer.length > 32 * 1024 * 1024) {
        return this._json(res, 413, { error: 'Attachment exceeds 32 MB limit' });
      }

      return this._json(res, 200, {
        dataUrl: `data:${item.mime};base64,${item.buffer.toString('base64')}`
      });
    }

    // Bot Library Files: GET, POST, DELETE /local/files
    if (pathname === '/local/files') {
      const agentId = url.searchParams.get('agentId') || 'agent-default';
      let agentLib = this.libraryFiles.get(agentId);
      if (!agentLib) {
        agentLib = new Map();
        this.libraryFiles.set(agentId, agentLib);
      }

      if (method === 'GET') {
        let totalBytes = 0;
        const files = [];
        for (const f of agentLib.values()) {
          totalBytes += f.sizeBytes;
          files.push({
            name: f.name,
            path: f.path,
            sizeBytes: f.sizeBytes,
            contentType: f.contentType,
            updatedAtMs: f.updatedAtMs,
            etag: f.etag
          });
        }
        return this._json(res, 200, { files, totalBytes, canEdit: true });
      }

      if (method === 'POST') {
        const raw = await this._readBody(req);
        let body;
        try {
          body = JSON.parse(raw.toString('utf-8'));
        } catch (_) {
          return this._json(res, 400, { error: 'Invalid JSON' });
        }

        const { agentId: targetAgent = agentId, fileName, contentType, base64 } = body;
        if (!fileName || !base64) {
          return this._json(res, 400, { error: 'fileName and base64 required' });
        }

        const buffer = Buffer.from(base64, 'base64');
        // Max 20 MiB per file
        if (buffer.length > 20 * 1024 * 1024) {
          return this._json(res, 413, { error: '单个文件最大为 20 MiB' });
        }

        let targetLib = this.libraryFiles.get(targetAgent);
        if (!targetLib) {
          targetLib = new Map();
          this.libraryFiles.set(targetAgent, targetLib);
        }

        let currentTotal = 0;
        for (const f of targetLib.values()) {
          if (f.name !== fileName) currentTotal += f.sizeBytes;
        }

        // Max 100 MiB total per Bot
        if (currentTotal + buffer.length > 100 * 1024 * 1024) {
          return this._json(res, 413, { error: 'Bot Library quota exceeded (max 100 MiB)' });
        }

        // Max 100 files
        if (targetLib.size >= 100 && !targetLib.has(fileName)) {
          return this._json(res, 413, { error: 'Bot Library file count exceeded (max 100 files)' });
        }

        const fileRecord = {
          name: fileName,
          path: `/data/library/${targetAgent}/${fileName}`,
          sizeBytes: buffer.length,
          contentType: contentType || 'application/octet-stream',
          updatedAtMs: Date.now(),
          etag: `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`,
          buffer
        };

        targetLib.set(fileName, fileRecord);
        return this._json(res, 200, { ok: true, file: fileRecord });
      }

      if (method === 'DELETE') {
        const raw = await this._readBody(req);
        let body;
        try {
          body = JSON.parse(raw.toString('utf-8'));
        } catch (_) {
          return this._json(res, 400, { error: 'Invalid JSON' });
        }

        const { agentId: targetAgent = agentId, name, fileName } = body;
        const targetName = name || fileName;
        const targetLib = this.libraryFiles.get(targetAgent);
        if (targetLib && targetName) {
          targetLib.delete(targetName);
        }
        return this._json(res, 200, { ok: true });
      }
    }

    // Bot Library content download: GET /local/files/content
    if (pathname === '/local/files/content' && method === 'GET') {
      const agentId = url.searchParams.get('agentId') || 'agent-default';
      const name = url.searchParams.get('name');
      const targetLib = this.libraryFiles.get(agentId);
      const file = targetLib ? targetLib.get(name) : null;
      if (!file) {
        return this._json(res, 404, { error: 'File not found' });
      }

      res.writeHead(200, {
        'Content-Type': file.contentType,
        'Content-Length': file.buffer.length,
        'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox"
      });
      return res.end(file.buffer);
    }

    // Audio Speech-to-Text: POST /local/audio/transcriptions
    if (pathname === '/local/audio/transcriptions' && method === 'POST') {
      const raw = await this._readBody(req);
      if (raw.length === 0) {
        return this._json(res, 400, { error: 'Empty audio request' });
      }

      let parsed = {};
      let text = 'Transcribed audio speech text';
      try {
        parsed = JSON.parse(raw.toString('utf-8'));
        if (parsed.language === 'zh') text = '语音转录识别文本内容';
      } catch (_) {}

      if (this.realHostProtocol && (typeof parsed.audioBase64 !== 'string' || !parsed.audioBase64)) {
        return this._json(res, 400, { error: 'audioBase64 string is required' });
      }

      return this._json(res, 200, {
        text,
        duration: 2.4,
        language: 'en'
      });
    }

    // Notification settings: GET, PUT /local/notification-settings
    if (pathname === '/local/notification-settings') {
      if (method === 'PUT') {
        const raw = await this._readBody(req);
        const body = JSON.parse(raw.toString('utf-8'));
        if (!['every-reply', 'task-complete'].includes(body.frequency)) {
          return this._json(res, 400, { error: 'Invalid notification frequency' });
        }
        this.notificationSettings.frequency = body.frequency;
        return this._json(res, 200, this.notificationSettings);
      } else if (method === 'GET') {
        return this._json(res, 200, this.notificationSettings);
      }
    }

    // Profile: GET, PUT /local/profile
    if (pathname === '/local/profile') {
      if (method === 'GET') {
        return this._json(res, 200, this.profile);
      } else if (method === 'PUT') {
        const raw = await this._readBody(req);
        let body;
        try {
          body = JSON.parse(raw.toString('utf-8'));
        } catch (_) {
          return this._json(res, 400, { error: 'Invalid JSON' });
        }
        if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'avatarDataUrl')) {
          return this._json(res, 400, { error: 'avatarDataUrl is required (data URL or null)' });
        }
        const av = body.avatarDataUrl;
        if (av !== null && (typeof av !== 'string' || !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(av))) {
          return this._json(res, 400, { error: 'Invalid avatarDataUrl format' });
        }
        if (typeof body.displayName === 'string') {
          this.profile.displayName = body.displayName;
        }
        this.profile.avatarDataUrl = av;
        this.profile.updatedAtMs = Date.now();
        return this._json(res, 200, this.profile);
      }
    }

    // Usage report: GET /local/usage/report (docs/usage-report.md), export=csv included.
    if (pathname === '/local/usage/report' && method === 'GET') {
      if (!this.usageReportEnabled) return this._json(res, 404, { error: 'Not found' });
      const query = url.searchParams;
      const timeZone = query.get('timeZone') || 'UTC';
      try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { return this._json(res, 400, { error: 'Invalid time zone' }); }
      const now = this.usageNow ?? new Date();
      if (!this.usageLedgerDir) {
        this.usageLedgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-mock-usage-'));
        await writeDemoLedger(this.usageLedgerDir, { now });
      }
      const filters = Object.fromEntries(['model', 'provider', 'profile', 'kind', 'agent', 'status']
        .map(key => [key, query.get(key) || undefined]).filter(([, value]) => value));
      const options = { timeZone, now, range: query.get('range') || '7d', from: query.get('from') || undefined, to: query.get('to') || undefined,
        filters, offset: Number(query.get('offset') ?? 0), limit: Number(query.get('limit') ?? 50), names: DEMO_NAMES };
      try {
        const body = query.get('export') === 'csv' ? await usageExport(this.usageLedgerDir, options) : await usageReport(this.usageLedgerDir, options);
        return this._json(res, 200, body);
      } catch (error) {
        if (error instanceof UsageReportError) return this._json(res, 400, { error: error.message });
        throw error;
      }
    }

    // Usage: GET /local/usage
    if (pathname === '/local/usage' && method === 'GET') {
      return this._json(res, 200, {
        ...this.usage,
        timeZone: url.searchParams.get('timeZone') || 'UTC',
      });
    }

    // Computers: GET /local/computers
    if (pathname === '/local/computers' && method === 'GET') {
      return this._json(res, 200, {
        available: true,
        computers: this.computers,
      });
    }

    // Create Bot: POST /api/createAgent
    if (pathname === '/api/createAgent' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return this._json(res, 400, { error: 'args.name: must be string, got ' + typeof body.name });
      }
      const now = Date.now();
      const agent = this._makeAgentSummary({
        id: 'agent-' + crypto.randomUUID().slice(0, 8),
        name: body.name.trim(),
        title: typeof body.title === 'string' ? body.title.trim() : '',
        description: typeof body.description === 'string' ? body.description.trim() : '',
        avatarShape: 'circle',
        avatarColor: 'purple',
        createdAt: now,
        updatedAt: now,
        createdAtMs: now,
        updatedAtMs: now,
        isRunning: false,
      });
      this.agents.unshift(agent);
      this.transcripts.set(agent.id, []);
      const slim = this._wantsSlimAvatars(req);
      const serialized = this._serializeAgent(agent, slim);
      this._broadcastEvent('agent-upserted', { activeAgentId: agent.id, agent: this._serializeAgent(agent, false) });
      return this._json(res, 200, { agent: serialized, transcript: [] });
    }

    // Create Group: POST /api/createGroup
    if (pathname === '/api/createGroup' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      const memberIds = Array.isArray(body.memberAgentIds)
        ? [...new Set(body.memberAgentIds.filter(id => typeof id === 'string' && this.agents.some(a => a.id === id && !a.isGroup)))]
        : [];
      if (memberIds.length === 0) {
        return this._json(res, 400, { error: 'A group must have at least one existing member agent' });
      }
      const memberNames = memberIds.map(id => this.agents.find(a => a.id === id)?.name || id);
      const name = typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : memberNames.join(', ');
      const now = Date.now();
      const group = this._makeAgentSummary({
        id: 'group-' + crypto.randomUUID().slice(0, 8),
        name,
        description: typeof body.description === 'string' ? body.description.trim() : '',
        isGroup: true,
        memberIds,
        avatarShape: 'circle',
        avatarColor: 'purple',
        createdAt: now,
        updatedAt: now,
        createdAtMs: now,
        updatedAtMs: now,
        isRunning: false,
      });
      this.agents.unshift(group);
      this.transcripts.set(group.id, []);
      const slim = this._wantsSlimAvatars(req);
      const serialized = this._serializeAgent(group, slim);
      this._broadcastEvent('agent-upserted', { activeAgentId: group.id, agent: this._serializeAgent(group, false) });
      return this._json(res, 200, { agent: serialized, transcript: [] });
    }

    // Set Group Members: POST /api/setGroupMembers
    if (pathname === '/api/setGroupMembers' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      const group = this.agents.find(a => a.id === body.id && a.isGroup);
      if (!group) return this._json(res, 404, { error: 'Group not found' });
      const memberIds = Array.isArray(body.memberAgentIds)
        ? [...new Set(body.memberAgentIds.filter(id => typeof id === 'string' && this.agents.some(a => a.id === id && !a.isGroup)))]
        : [];
      if (memberIds.length === 0) {
        return this._json(res, 400, { error: 'A group must have at least one existing member agent' });
      }
      group.memberIds = memberIds;
      const now = Date.now();
      group.updatedAt = now;
      group.updatedAtMs = now;
      const slim = this._wantsSlimAvatars(req);
      const serialized = this._serializeAgent(group, slim);
      this._broadcastEvent('agent-upserted', { activeAgentId: group.id, agent: this._serializeAgent(group, false) });
      return this._json(res, 200, { agent: serialized });
    }

    // Update Bot: POST /api/updateAgent
    if (pathname === '/api/updateAgent' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      const agent = this.agents.find(a => a.id === body.id);
      if (!agent) return this._json(res, 404, { error: 'Agent not found' });
      if (body.profile && typeof body.profile === 'object') {
        if (typeof body.profile.name === 'string') agent.name = body.profile.name.trim();
        if (typeof body.profile.title === 'string') agent.title = body.profile.title.trim();
        if (typeof body.profile.description === 'string') agent.description = body.profile.description.trim();
      }
      const now = Date.now();
      agent.updatedAt = now;
      agent.updatedAtMs = now;
      const slim = this._wantsSlimAvatars(req);
      const serialized = this._serializeAgent(agent, slim);
      this._broadcastEvent('agent-upserted', { activeAgentId: agent.id, agent: this._serializeAgent(agent, false) });
      return this._json(res, 200, serialized);
    }

    // Delete Bots: POST /api/deleteAgents
    if (pathname === '/api/deleteAgents' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      const ids = Array.isArray(body.ids) ? new Set(body.ids) : new Set();
      this.agents = this.agents.filter(a => !ids.has(a.id));
      for (const id of ids) {
        this.transcripts.delete(id);
        this._broadcastEvent('agent-deleted', { id });
      }
      return this._json(res, 200, { ok: true, deletedIds: Array.from(ids) });
    }

    // Host settings: POST /api/getHostSettings, /api/setHostSettings
    if (pathname === '/api/getHostSettings' && method === 'POST') {
      return this._json(res, 200, this.hostSettings);
    }
    if (pathname === '/api/setHostSettings' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return this._json(res, 400, { error: 'Invalid JSON object' });
      }

      const announcedSet = new Set();
      if (body.notifications && typeof body.notifications === 'object' && !Array.isArray(body.notifications)) {
        this.hostSettings.notifications = {
          ...(this.hostSettings.notifications || { isEnabled: false }),
          ...(typeof body.notifications.isEnabled === 'boolean' ? { isEnabled: body.notifications.isEnabled } : {}),
        };
        announcedSet.add('notifications');
      }
      if (body.mcpCustomInstructionsAccountScope === null) {
        delete this.hostSettings.mcpCustomInstructionsAccountScope;
        announcedSet.add('mcpCustomInstructionsAccountScope');
      } else if (typeof body.mcpCustomInstructionsAccountScope === 'string' && body.mcpCustomInstructionsAccountScope.length > 0) {
        this.hostSettings.mcpCustomInstructionsAccountScope = body.mcpCustomInstructionsAccountScope;
        announcedSet.add('mcpCustomInstructionsAccountScope');
      }
      const prevTeamId = this.hostSettings.selectedTeamId;
      if (body.selectedTeam === null) {
        delete this.hostSettings.selectedTeamId;
        if (prevTeamId !== undefined) announcedSet.add('selectedTeamId');
      } else if (
        body.selectedTeam &&
        typeof body.selectedTeam === 'object' &&
        Number.isSafeInteger(body.selectedTeam.teamId) &&
        body.selectedTeam.teamId > 0 &&
        typeof body.selectedTeam.accountScope === 'string' &&
        body.selectedTeam.accountScope.length > 0
      ) {
        this.hostSettings.selectedTeamId = body.selectedTeam.teamId;
        if (prevTeamId !== body.selectedTeam.teamId) announcedSet.add('selectedTeamId');
      }
      if (body.mcpCustomInstructions && typeof body.mcpCustomInstructions === 'object' && !Array.isArray(body.mcpCustomInstructions)) {
        this.hostSettings.mcpCustomInstructions = { ...body.mcpCustomInstructions };
        announcedSet.add('mcpCustomInstructions');
      }
      if (body.mcpCustomInstructionsByServerId && typeof body.mcpCustomInstructionsByServerId === 'object' && !Array.isArray(body.mcpCustomInstructionsByServerId)) {
        this.hostSettings.mcpCustomInstructionsByServerId = { ...body.mcpCustomInstructionsByServerId };
        announcedSet.add('mcpCustomInstructionsByServerId');
      }
      if (body.mcpDisabledToolsByServerId && typeof body.mcpDisabledToolsByServerId === 'object' && !Array.isArray(body.mcpDisabledToolsByServerId)) {
        this.hostSettings.mcpDisabledToolsByServerId = { ...body.mcpDisabledToolsByServerId };
        announcedSet.add('mcpDisabledToolsByServerId');
      }
      if (Array.isArray(body.mcpBoxServers)) {
        this.hostSettings.mcpBoxServers = [...new Set(body.mcpBoxServers.map(String))];
        announcedSet.add('mcpBoxServers');
      }
      if (body.userTimeZone !== undefined && (body.userTimeZone === '' || this._isValidIanaTimeZone(body.userTimeZone))) {
        if (body.userTimeZone === '') {
          delete this.hostSettings.userTimeZone;
        } else {
          this.hostSettings.userTimeZone = body.userTimeZone;
        }
        announcedSet.add('userTimeZone');
      }
      if (typeof body.osLocale === 'string') {
        const osLocale = body.osLocale.trim();
        if (osLocale === '') {
          delete this.hostSettings.osLocale;
        } else {
          this.hostSettings.osLocale = osLocale;
        }
        announcedSet.add('osLocale');
      }
      if (body.userTimeZoneOverride !== undefined && (body.userTimeZoneOverride === '' || this._isValidIanaTimeZone(body.userTimeZoneOverride))) {
        if (body.userTimeZoneOverride === '') {
          delete this.hostSettings.userTimeZoneOverride;
        } else {
          this.hostSettings.userTimeZoneOverride = body.userTimeZoneOverride;
        }
        announcedSet.add('userTimeZoneOverride');
      }
      if (body.agentDefaultModel === null) {
        delete this.hostSettings.agentDefaultModel;
        announcedSet.add('agentDefaultModel');
      } else if (body.agentDefaultModel && typeof body.agentDefaultModel === 'object' && !Array.isArray(body.agentDefaultModel)) {
        this.hostSettings.agentDefaultModel = { ...body.agentDefaultModel };
        announcedSet.add('agentDefaultModel');
      }
      if (body.computerUseModel === null) {
        delete this.hostSettings.computerUseModel;
        announcedSet.add('computerUseModel');
      } else if (body.computerUseModel && typeof body.computerUseModel === 'object' && !Array.isArray(body.computerUseModel)) {
        this.hostSettings.computerUseModel = { ...body.computerUseModel };
        announcedSet.add('computerUseModel');
      }
      if (body.autoReviewInstructions && typeof body.autoReviewInstructions === 'object' && !Array.isArray(body.autoReviewInstructions)) {
        this.hostSettings.autoReviewInstructions = {
          isEnabled: body.autoReviewInstructions.isEnabled !== false,
          allowInstructions: Array.isArray(body.autoReviewInstructions.allowInstructions) ? body.autoReviewInstructions.allowInstructions.map(String) : [],
          blockInstructions: Array.isArray(body.autoReviewInstructions.blockInstructions) ? body.autoReviewInstructions.blockInstructions.map(String) : [],
        };
        announcedSet.add('autoReviewInstructions');
      }
      if (typeof body.localToolPermission === 'string' && ['always', 'ask', 'never'].includes(body.localToolPermission)) {
        this.hostSettings.localToolPermission = body.localToolPermission;
        announcedSet.add('localToolPermission');
      }
      if (typeof body.webauthnProxyEnabled === 'boolean') {
        this.hostSettings.webauthnProxyEnabled = body.webauthnProxyEnabled;
        announcedSet.add('webauthnProxyEnabled');
      }
      if (Array.isArray(body.pinnedAgentIds)) {
        this.hostSettings.pinnedAgentIds = [...new Set(body.pinnedAgentIds.map(String).filter(Boolean))];
        announcedSet.add('pinnedAgentIds');
      }
      if (Array.isArray(body.sidebarSections)) {
        this.hostSettings.sidebarSections = body.sidebarSections;
        announcedSet.add('sidebarSections');
      }
      if (typeof body.hasSeenOnboarding === 'boolean') {
        this.hostSettings.hasSeenOnboarding = body.hasSeenOnboarding;
        announcedSet.add('hasSeenOnboarding');
      }

      if (this.realHostProtocol) {
        const announcedFields = [...announcedSet];
        if (announcedFields.length > 0) {
          this._broadcastEvent('host-settings', { fields: announcedFields });
        }
      } else {
        this._broadcastEvent('host-settings', this.hostSettings);
      }
      return this._json(res, 200, this.hostSettings);
    }

    // Non-image / chunked attachment readback: POST /api/readAttachmentChunk
    if (pathname === '/api/readAttachmentChunk' && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {
        return this._json(res, 400, { error: 'Invalid JSON' });
      }
      const rawPath = String(body.path || '');
      const key = rawPath.startsWith('file://') ? rawPath : `file://${rawPath}`;
      if (rawPath.includes('..')) {
        return this._json(res, 403, { error: 'Directory traversal forbidden' });
      }
      const item = this.committedAttachments.get(key);
      if (!item) return this._json(res, 404, { error: 'Attachment not found' });
      const offset = Math.max(0, Number(body.offset || 0));
      const length = Math.min(4 * 1024 * 1024, Math.max(1, Number(body.length || 65536)));
      const slice = item.buffer.subarray(offset, offset + length);
      return this._json(res, 200, {
        bytesBase64: slice.toString('base64'),
        totalSize: item.buffer.length,
        mime: item.mime,
      });
    }

    // ForeverBox VNC Desktop: POST /api/getForeverBoxStatus, /api/ensureForeverBox
    if ((pathname === '/api/getForeverBoxStatus' || pathname === '/api/ensureForeverBox') && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {}
      const id = body.id || 'agent-default';
      const vncUrl = `${this.canonical}/vnc/desktop/vnc.html?path=vnc/desktop/websockify%3Fticket%3Dmockticket&autoconnect=1&resize=remote`;
      return this._json(res, 200, {
        agentId: id,
        state: 'running',
        vncUrl,
        windows: [{ windowIndex: 0, vncUrl }],
        imageUpdateAvailable: false,
        hostVersion: 'mock-1.0.0',
        hostUpdateAvailable: false,
        handoff: null,
      });
    }

    // Connectors / Mobile RPC: POST /local/mobile-rpc/:method
    if (pathname.startsWith('/local/mobile-rpc/') && method === 'POST') {
      const rpcMethod = pathname.slice('/local/mobile-rpc/'.length);
      const raw = await this._readBody(req);
      let args = {};
      try { args = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {}
      const connId = (c, idx) => c.numericId ?? (1001 + idx);
      const findConn = (rawId) => {
        const key = String(rawId ?? '');
        return this.connectors.find((c, idx) =>
          c.id === key || `host-${c.id}` === key || String(connId(c, idx)) === key
        );
      };
      const normalizePerm = (rawPerm) => String(rawPerm ?? '')
        .trim()
        .toUpperCase()
        .replace(/^GROK_BOT_TOOL_PERMISSION_/, '');
      const formatPolicy = (tp) => {
        const stored = tp ?? {};
        const tools = {};
        for (const [k, v] of Object.entries(stored.tools ?? {})) {
          if (v === 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW' || v === 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL') {
            tools[k] = v;
          }
        }
        return {
          tools,
          ...(stored.reads ? { reads: stored.reads } : {}),
          ...(stored.writes ? { writes: stored.writes } : {}),
        };
      };

      if (rpcMethod === 'ListMarketplaces') return this._json(res, 200, { marketplaces: [] });
      if (rpcMethod === 'ListPublicGrokBotMarketplaceListings') {
        return this._json(res, 200, { featuredListings: [], listings: [], allCategoriesOrder: [], nextPageToken: '' });
      }
      if (rpcMethod === 'GetTeamPluginPopularity') return this._json(res, 200, { counts: [] });
      if (rpcMethod === 'ListPrivateMarketplacePlugins') return this._json(res, 200, { plugins: [], hasMore: false });
      if (rpcMethod === 'GetPluginDetails') {
        const c = findConn(args.pluginId) ?? this.connectors[0];
        const idx = Math.max(0, this.connectors.indexOf(c));
        return this._json(res, 200, {
          plugin: {
            id: connId(c, idx),
            fullRef: c.id,
            name: c.name,
            displayName: c.displayName,
            description: c.description,
            variables: { type: 'object', properties: { secret: { type: 'string', title: 'Bearer Token', writeOnly: true } }, required: [] },
          },
        });
      }
      if (rpcMethod === 'ListMarketplacePlugins') {
        return this._json(res, 200, {
          plugins: this.connectors.map((c, idx) => ({
            id: connId(c, idx),
            fullRef: c.id,
            name: c.name,
            displayName: c.displayName,
            description: c.description,
            variables: { type: 'object', properties: { secret: { type: 'string', title: 'Bearer Token', writeOnly: true } }, required: [] },
          })),
          hasMore: false,
        });
      }
      if (rpcMethod === 'GetEffectiveUserPlugins') {
        return this._json(res, 200, {
          plugins: this.connectors
            .map((c, idx) => (!c.installed ? null : {
              plugin: { id: connId(c, idx), fullRef: c.id, name: c.name, displayName: c.displayName, description: c.description },
              isEnabled: true,
              isTeamRequired: false,
              installMode: 'EFFECTIVE_PLUGIN_INSTALL_MODE_USER',
              hasTeamConfiguredVariables: false,
              configuredVariableKeys: c.credential ? ['secret'] : [],
            }))
            .filter(Boolean),
          marketplaces: [],
        });
      }
      if (
        rpcMethod === 'InstallUserPlugin' ||
        rpcMethod === 'UpdateUserPlugin' ||
        rpcMethod === 'UpdateUserPluginVariables' ||
        rpcMethod === 'UpdateUserPluginInstall'
      ) {
        const c = findConn(args.pluginId);
        if (c) {
          c.installed = true;
          c.credential = args.variables?.secret || c.credential || 'configured';
        }
        return this._json(res, 200, {});
      }
      if (rpcMethod === 'UninstallUserPlugin' || rpcMethod === 'DeleteMcpOAuthAccount') {
        const c = findConn(args.pluginId ?? args.serverId);
        if (c) { c.installed = false; c.credential = null; }
        return this._json(res, 200, {});
      }
      if (rpcMethod === 'GetAvailableMcpServers') {
        return this._json(res, 200, {
          servers: this.connectors
            .map((c, idx) => {
              if (!c.installed) return null;
              const isNoneAuth = !c.auth || c.auth.type === 'none';
              const hasToken = isNoneAuth || Boolean(c.credential);
              const hasStatic = isNoneAuth || (['bearer', 'api-key'].includes(c.auth.type) && Boolean(c.credential));
              return {
                id: connId(c, idx),
                pluginId: connId(c, idx),
                name: c.name,
                enabled: true,
                isTeamServer: false,
                type: c.transport === 'sse' ? 'sse' : 'http',
                url: c.url,
                hasStaticCredentialHeaders: hasStatic,
                args: [],
                servedBy: 'MCP_SERVED_BY_USER',
                serverIdentifier: `host-${c.id}`,
                userHasAccessToken: hasToken,
                isUnseen: false,
                isRequired: false,
                managedByTeamPluginPolicy: false,
                disabledByTeamAdminPolicy: false,
                accounts: [{ accountKey: 'default', serverIdentifier: `host-${c.id}`, userHasAccessToken: hasToken }],
              };
            })
            .filter(Boolean),
        });
      }
      if (rpcMethod === 'ListSandMcpTools') {
        const filterIds = Array.isArray(args.serverIdentifiers) && args.serverIdentifiers.length
          ? new Set(args.serverIdentifiers.map(String))
          : null;
        const matched = this.connectors.filter(c => c.installed && (!filterIds || filterIds.has(`host-${c.id}`) || filterIds.has(c.id)));
        return this._json(res, 200, {
          servers: matched.map(c => ({
            serverIdentifier: `host-${c.id}`,
            rowServerIdentifier: `host-${c.id}`,
            accountLabel: 'default',
            status: c.auth?.type === 'none' || Boolean(c.credential) ? 'connected' : 'needsAuth',
            tools: (c.tools ?? []).map(t => ({
              name: `host-${c.id}-${t.name}`,
              toolName: t.name,
              providerIdentifier: `host-${c.id}`,
              clientKey: `host-${c.id}`,
              description: t.description ?? '',
              inputSchema: t.inputSchema ?? { type: 'object' },
              ...(t.annotations ? { annotationsJson: JSON.stringify(t.annotations) } : {}),
            })),
          })),
        });
      }
      if (rpcMethod === 'GetGrokBotMcpToolPermissions') {
        return this._json(res, 200, {
          servers: this.connectors
            .map((c, idx) => (!c.installed ? null : {
              serverId: String(connId(c, idx)),
              disabledTools: [...(c.disabledTools ?? [])],
              policy: formatPolicy(c.toolPolicy),
            }))
            .filter(Boolean),
        });
      }
      if (rpcMethod === 'SetGrokBotMcpToolPermissions') {
        const c = findConn(args.serverId);
        if (!c || c.enabled === false) return this._json(res, 404, { error: 'Connector not found' });
        const idx = this.connectors.indexOf(c);
        const disabled = new Set(c.disabledTools ?? []);
        const nextPolicy = formatPolicy(c.toolPolicy);
        const VALID = new Set(['UNSPECIFIED', 'BLOCKED', 'ALWAYS_ALLOW', 'NEEDS_APPROVAL']);
        if (args.tools && typeof args.tools === 'object') {
          for (const [name, rawPerm] of Object.entries(args.tools)) {
            const p = normalizePerm(rawPerm);
            if (!VALID.has(p)) return this._json(res, 400, { error: 'Invalid tool permission' });
            delete nextPolicy.tools[name];
            if (p === 'BLOCKED') {
              disabled.add(name);
            } else if (p === 'UNSPECIFIED') {
              disabled.delete(name);
            } else {
              disabled.delete(name);
              nextPolicy.tools[name] = `GROK_BOT_TOOL_PERMISSION_${p}`;
            }
          }
        }
        if (args.reads !== undefined) {
          const p = normalizePerm(args.reads);
          if (!VALID.has(p)) return this._json(res, 400, { error: 'Invalid tool permission' });
          if (p === 'UNSPECIFIED') delete nextPolicy.reads;
          else nextPolicy.reads = `GROK_BOT_TOOL_PERMISSION_${p}`;
        }
        if (args.writes !== undefined) {
          const p = normalizePerm(args.writes);
          if (!VALID.has(p)) return this._json(res, 400, { error: 'Invalid tool permission' });
          if (p === 'UNSPECIFIED') delete nextPolicy.writes;
          else nextPolicy.writes = `GROK_BOT_TOOL_PERMISSION_${p}`;
        }
        c.disabledTools = [...disabled];
        c.toolPolicy = nextPolicy;
        return this._json(res, 200, {
          server: {
            serverId: String(connId(c, idx)),
            disabledTools: [...c.disabledTools],
            policy: formatPolicy(c.toolPolicy),
          },
        });
      }
      if (rpcMethod === 'ValidateMcpOAuthTokens') {
        const targets = args.targets ?? (args.serverUrls ?? []).map(serverUrl => ({ serverUrl, accountKey: 'default' }));
        return this._json(res, 200, {
          results: targets.map(target => ({
            serverUrl: target.serverUrl,
            accountKey: target.accountKey ?? 'default',
            hasValidToken: this.connectors.some(c => c.installed && c.url === target.serverUrl && (c.auth?.type === 'none' || Boolean(c.credential))),
          })),
        });
      }
      if (rpcMethod === 'CheckHttpMcpStatus') {
        const statuses = (args.serverIds ?? []).map(id => {
          const c = findConn(id) ?? this.connectors[0];
          const idx = Math.max(0, this.connectors.indexOf(c));
          return {
            id: connId(c, idx),
            isAvailable: true,
            requiresAuth: c.auth?.type !== 'none',
            hasValidToken: c.auth?.type === 'none' || Boolean(c.credential),
          };
        });
        return this._json(res, 200, {
          statuses: statuses.length ? statuses : [{ id: 1001, isAvailable: true, requiresAuth: true, hasValidToken: true }],
        });
      }
      if (rpcMethod === 'CompleteMcpOAuth') return this._json(res, 200, {});
      return this._json(res, 404, { error: 'Unknown mobile-rpc method' });
    }

    // App Intents RPC: POST /local/app-intents/:method
    if (pathname.startsWith('/local/app-intents/') && method === 'POST') {
      const intentMethod = pathname.slice('/local/app-intents/'.length);
      if (intentMethod === 'ListGrokBotAgents') {
        return this._json(res, 200, { agents: this.agents.map(a => ({ id: a.id, name: a.name })) });
      }
      if (intentMethod === 'SendGrokBotUserMessage') {
        return this._json(res, 200, { accepted: true, sendId: crypto.randomUUID() });
      }
      if (intentMethod === 'GetGrokBotSendStatus') {
        return this._json(res, 200, { status: 'completed' });
      }
      return this._json(res, 404, { error: 'Unknown app-intents method' });
    }

    // Skill publication workflows: /api/getAgentWorkflows, publishSkill, resyncPublishedSkill, unpublishSkill
    if (pathname === '/api/getAgentWorkflows' && method === 'POST') {
      return this._json(res, 200, this.workflows);
    }
    if ((pathname === '/api/publishSkill' || pathname === '/api/resyncPublishedSkill' || pathname === '/api/unpublishSkill') && method === 'POST') {
      const raw = await this._readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf-8') || '{}'); } catch (_) {}
      const wf = this.workflows.find(w => w.id === body.workflowId);
      if (wf) wf.publishedByCurrentUser = pathname !== '/api/unpublishSkill';
      return this._json(res, 200, { ok: true });
    }

    // Default 404
    return this._json(res, 404, { error: 'Not found' });
  }

  _stripEventInlineAvatars(channel, payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (channel === 'agents' && Array.isArray(payload.agents)) {
      let changed = false;
      const agents = payload.agents.map(a => {
        if (a && typeof a === 'object' && a.avatarDataUrl != null) {
          changed = true;
          return { ...a, avatarDataUrl: null };
        }
        return a;
      });
      return changed ? { ...payload, agents } : payload;
    }
    if (channel === 'agent-upserted' && payload.agent && typeof payload.agent === 'object') {
      if (payload.agent.avatarDataUrl != null) {
        return { ...payload, agent: { ...payload.agent, avatarDataUrl: null } };
      }
    }
    return payload;
  }

  _broadcastEvent(channel, payload, eventId = crypto.randomUUID()) {
    let broadcastCount = 0;
    for (const client of this.eventsClients) {
      if (this.realHostProtocol && client.subscribedChannels && !client.subscribedChannels.has(channel)) {
        continue;
      }
      const outPayload = (client.slimAvatars || this.realHostProtocol)
        ? this._stripEventInlineAvatars(channel, payload)
        : payload;
      const chunk = `id: ${eventId}\ndata: ${JSON.stringify({ channel, payload: outPayload })}\n\n`;
      try {
        client.res.write(chunk);
        broadcastCount++;
      } catch (_) {}
    }
    return broadcastCount;
  }

  _broadcastNotification(item, targetDeviceId) {
    const chunk = `id: ${item.id}\nevent: notification\ndata: ${JSON.stringify(item)}\n\n`;
    for (const client of this.notificationClients) {
      if (!targetDeviceId || client.deviceId === targetDeviceId) {
        try { client.res.write(chunk); } catch (_) {}
      }
    }
  }

  _handleUpgrade(req, socket, head) {
    const url = new URL(req.url, this.origin);
    if (url.pathname !== '/local/voice/realtime') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const secProtocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    const credentials = secProtocols.filter(p => /^xai-client-secret\.[A-Za-z0-9_-]{43}$/.test(p));

    if (credentials.length !== 1) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nVoice credential is required');
      socket.destroy();
      return;
    }

    const chosenProtocol = credentials[0];
    const secret = chosenProtocol.slice('xai-client-secret.'.length);
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

    const ticket = this.voiceTickets.get(secretHash);
    if (!ticket || ticket.expiresAt <= Date.now()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nVoice credential expired');
      socket.destroy();
      return;
    }

    if (this.activeVoiceSessions.has(ticket.deviceId)) {
      socket.write('HTTP/1.1 409 Conflict\r\nContent-Type: text/plain\r\n\r\nA voice call is already active');
      socket.destroy();
      return;
    }

    // Burn ticket
    this.voiceTickets.delete(secretHash);

    // Complete RFC 6455 Handshake
    const secKey = req.headers['sec-websocket-key'];
    const secAccept = crypto.createHash('sha1').update(secKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${secAccept}\r\n` +
      `Sec-WebSocket-Protocol: ${chosenProtocol}\r\n` +
      '\r\n'
    );

    const ws = new MockWebSocket(socket, chosenProtocol);
    this.activeVoiceSessions.set(ticket.deviceId, ws);

    ws.on('close', () => {
      this.activeVoiceSessions.delete(ticket.deviceId);
    });

    // Send session.created & conversation.created frames
    ws.send(JSON.stringify({
      event_id: crypto.randomUUID(),
      type: 'session.created',
      session: {
        id: crypto.randomUUID(),
        object: 'realtime.session',
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 } },
          output: { format: { type: 'audio/pcm', rate: 24000 } }
        },
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 }
      }
    }));

    ws.send(JSON.stringify({
      event_id: crypto.randomUUID(),
      type: 'conversation.created',
      conversation: {
        id: ticket.callId,
        object: 'realtime.conversation'
      }
    }));

    // Handle client message frames
    ws.on('message', text => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (_) {
        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'error',
          error: { type: 'invalid_request_error', code: '400', message: 'Expected realtime JSON' }
        }));
        return;
      }

      const { type } = msg;

      if (type === 'session.update') {
        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'session.updated',
          session: msg.session
        }));
      } else if (type === 'input_audio_buffer.append') {
        // Echo speech detection
        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'input_audio_buffer.speech_started',
          item_id: crypto.randomUUID(),
          audio_start_ms: 120
        }));
        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'input_audio_buffer.speech_stopped',
          item_id: crypto.randomUUID(),
          audio_end_ms: 840
        }));
      } else if (type === 'input_audio_buffer.commit') {
        const itemId = crypto.randomUUID();
        const responseId = crypto.randomUUID();

        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: itemId,
          content_index: 0,
          transcript: 'Hello Grok Voice'
        }));

        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'response.created',
          response: { id: responseId, object: 'realtime.response', status: 'in_progress' }
        }));

        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'response.output_item.added',
          response_id: responseId,
          output_index: 0,
          item: { id: crypto.randomUUID(), type: 'message', role: 'assistant' }
        }));

        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'response.audio_transcript.delta',
          response_id: responseId,
          item_id: itemId,
          delta: 'Hello! I hear you clearly.'
        }));

        // Send simulated 24kHz PCM audio delta
        const dummyPcm = Buffer.alloc(480); // 10ms of silence in 24kHz 16-bit mono
        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'response.audio.delta',
          response_id: responseId,
          item_id: itemId,
          delta: dummyPcm.toString('base64')
        }));

        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'response.audio.done',
          response_id: responseId,
          item_id: itemId
        }));

        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'response.done',
          response: { id: responseId, status: 'completed' }
        }));
      } else if (type === 'response.cancel') {
        ws.send(JSON.stringify({
          event_id: crypto.randomUUID(),
          type: 'response.cancelled',
          response: { id: crypto.randomUUID(), status: 'cancelled' }
        }));
      } else if (type === 'session.close') {
        ws.close();
      }
    });

    ws.on('binary', () => {
      ws.send(JSON.stringify({
        event_id: crypto.randomUUID(),
        type: 'error',
        error: { type: 'invalid_request_error', code: '400', message: 'Binary frames not supported' }
      }));
      ws.close();
    });
  }
}

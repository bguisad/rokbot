import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { BlockList, isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  ANDROID_NATIVE_UPDATE_SCHEMA,
  DESKTOP_UPDATE_SCHEMA,
  IOS_UPDATE_SCHEMA,
  buildAltStoreSource,
  buildIosManifestPlist,
  generateRbDelta,
  generateRbd1Delta,
  generateSigningKeyPair,
  sha256Hex,
  signAndroidDeltas,
  signAndroidManifest,
  signDesktopDeltas,
  signDesktopManifest,
} from './crypto-delta.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ADMIN_COOKIE = 'rokbot_admin';
const WEB_COOKIE = 'rokbot_web';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_DEVICES = 100;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function check(cond, status, message) {
  if (!cond) throw new HttpError(status, message);
}

// ---------------------------------------------------------------------------
// Minimal deterministic 512x512 RGBA PNG fallback (RokBot dark-slate + cyan)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function pngCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

let cachedIconBytes = null;
function getRokBotIconPng() {
  if (cachedIconBytes) return cachedIconBytes;
  const repoIconPath = path.join(REPO_ROOT, 'host', 'server', 'public', 'rokbot-icon.png');
  if (existsSync(repoIconPath)) {
    cachedIconBytes = readFileSync(repoIconPath);
    return cachedIconBytes;
  }
  const width = 512;
  const height = 512;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride, 0);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4;
      const inBox = x >= 48 && x < 464 && y >= 48 && y < 464;
      if (inBox) {
        const isAccent = (x - 384) ** 2 + (y - 96) ** 2 <= 22 ** 2;
        if (isAccent) {
          raw[p] = 0x38; raw[p + 1] = 0xbd; raw[p + 2] = 0xf8; raw[p + 3] = 0xff;
        } else {
          raw[p] = 0x1e; raw[p + 1] = 0x24; raw[p + 2] = 0x30; raw[p + 3] = 0xff;
        }
      }
    }
  }
  const idat = deflateSync(raw, { level: 6 });
  cachedIconBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return cachedIconBytes;
}

// ---------------------------------------------------------------------------
// Security & Parsing Helpers
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPasswordHash(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const actual = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function mintToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function mintPairingCode() {
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return out;
}

function normalizePairingCode(raw) {
  return String(raw ?? '').replace(/[\s-]+/g, '').toUpperCase();
}

function parseCookies(headerValue) {
  const cookies = {};
  if (!headerValue) return cookies;
  for (const part of String(headerValue).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try {
      cookies[k] = decodeURIComponent(v);
    } catch {
      cookies[k] = v;
    }
  }
  return cookies;
}

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) blockedIpv4.addSubnet(address, prefix, 'ipv4');

const blockedIpv6 = new BlockList();
for (const [address, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28],
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blockedIpv6.addSubnet(address, prefix, 'ipv6');

function isPrivateOrLoopbackHost(hostname) {
  const h = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h || h.includes('%')) return true;
  const family = isIP(h);
  if (family === 4) return blockedIpv4.check(h, 'ipv4');
  if (family === 6) return blockedIpv6.check(h, 'ipv6');
  if (!h.includes('.')) return true;
  if (
    h === 'localhost'
    || h === 'metadata.goog'
    || h.endsWith('.metadata.goog')
    || h.endsWith('.localhost')
    || h.endsWith('.local')
    || h.endsWith('.localdomain')
    || h.endsWith('.internal')
    || h.endsWith('.arpa')
  ) {
    return true;
  }
  return false;
}

function isPublicPushUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return false;
  }
  if (!['https:', 'http:'].includes(u.protocol)) return false;
  if (u.username || u.password) return false;
  return !isPrivateOrLoopbackHost(u.hostname);
}

async function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'JSON object required');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function parseMultipartFormData(bodyBuf, contentTypeHeader) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentTypeHeader || '');
  if (!m) throw new HttpError(400, 'Missing multipart boundary');
  const boundary = m[1] || m[2];
  const delim = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let start = bodyBuf.indexOf(delim);
  while (start >= 0) {
    start += delim.length;
    if (bodyBuf[start] === 0x2d && bodyBuf[start + 1] === 0x2d) break; // --
    if (bodyBuf[start] === 0x0d && bodyBuf[start + 1] === 0x0a) start += 2;
    else if (bodyBuf[start] === 0x0a) start += 1;

    const nextDelim = bodyBuf.indexOf(delim, start);
    if (nextDelim < 0) break;

    let partEnd = nextDelim;
    if (bodyBuf[partEnd - 2] === 0x0d && bodyBuf[partEnd - 1] === 0x0a) partEnd -= 2;
    else if (bodyBuf[partEnd - 1] === 0x0a) partEnd -= 1;

    const part = bodyBuf.subarray(start, partEnd);
    let headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    let sepLen = 4;
    if (headerEnd < 0) {
      headerEnd = part.indexOf(Buffer.from('\n\n'));
      sepLen = 2;
    }
    if (headerEnd < 0) {
      start = nextDelim;
      continue;
    }

    const headerText = part.subarray(0, headerEnd).toString('utf8');
    const content = part.subarray(headerEnd + sepLen);
    const dispMatch = /content-disposition:\s*form-data;\s*([^\r\n]+)/i.exec(headerText);
    const nameMatch = dispMatch && /\bname="([^"]+)"/i.exec(dispMatch[1]);
    const fileMatch = dispMatch && /\bfilename="([^"]+)"/i.exec(dispMatch[1]);
    const fieldName = nameMatch ? nameMatch[1] : '';

    if (fileMatch) {
      files.push({
        fieldName,
        filename: path.basename(fileMatch[1]),
        data: Buffer.from(content),
      });
    } else if (fieldName) {
      fields[fieldName] = content.toString('utf8');
    }

    start = nextDelim;
  }

  return { fields, files };
}

// ---------------------------------------------------------------------------
// Reference Host Implementation
// ---------------------------------------------------------------------------

export async function createHarnessServer(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-e2e-host-'));
  const hostDataDir = path.join(dataDir, 'host-data');
  const updatesArtifactsDir = path.join(dataDir, 'updates', 'artifacts');
  await mkdir(hostDataDir, { recursive: true });
  await mkdir(updatesArtifactsDir, { recursive: true });

  const signingKeys = generateSigningKeyPair();
  const initialAdminPassword = options.adminPassword || 'RokBotAdmin!2026';
  const sseKeepaliveMs = options.sseKeepaliveMs ?? 20_000;
  const initialAllowEnv = options.allowEnv ?? options.allowDeviceModelConfigEnv ?? true;

  const activeSockets = new Set();
  const eventsStreams = new Set(); // { res, deviceId, keepalive }
  const notifStreams = new Set(); // { res, deviceId, platform, foreground, keepalive }

  // Mutable state reset by harness.resetState()
  const state = {
    initialized: true,
    adminPassword: initialAdminPassword,
    adminPasswordHash: hashPassword(initialAdminPassword),
    setupKey: mintToken(24),
    adminSessions: new Map(), // tokenHash -> { createdAt }
    pairingKeys: [], // { id, hash, expiresAt }
    devices: [], // { id, name, platform, clientDeviceId, bundleId, hash, pairedWithAdminPassword, createdAt, revokedAt, lastSeenAt, push }
    rateLimits: new Map(), // key -> number[] timestamps
    auditLog: [],
    federationRole: 'primary',
    defaultMachineId: options.defaultMachineId ?? 'machine-local-1',
    computers: [
      { id: 'machine-local-1', label: 'Local Desktop', connected: true, platform: 'darwin', capabilities: ['exec', 'gui'] },
    ],
    webClientAvailable: true,
    webRendererVersion: '1.2.3',
    needsModel: Boolean(options.needsModel),
    modelAuthPolicy: {
      allowEnv: initialAllowEnv,
      allowDeviceModelConfig: true,
      allowGuestModelConfig: false,
    },
    modelReloadBehavior: {
      mode: 'immediate', // 'immediate' | 'waiting-then-applied' | 'error'
      delayMs: 40,
    },
    modelReload: {
      revision: 0,
      status: 'none',
      error: null,
      updatedAt: null,
    },
    modelConfig: null, // stored config WITH secret apiKeys
    upstreamCatalog: [
      { id: 'gpt-4o', name: 'gpt-4o', provider: 'openai' },
      { id: 'claude-3-7-sonnet', name: 'claude-3-7-sonnet', provider: 'anthropic' },
    ],
    upstreamCatalogFault: null,
    modelTestFault: null,
    agents: new Map(), // agentId -> { id, name, createdAt }
    files: new Map(), // `${agentId}/${name}` -> { agentId, name, contentType, bytes, updatedAtMs, etag }
    notifications: [],
    nextNotifId: 1,
    pushSink: null,
    pushHistory: { sent: [], suppressed: [] },
    connectors: [
      { id: 'github', name: 'GitHub', enabled: true, connected: false },
    ],
    voiceEnabled: true,
    artifacts: new Map(), // id -> { id, platform, filename, filePath, sha256, size, uploadedAt }
    releases: {
      android: [],
      ios: [],
      macos: [],
      windows: [],
    },
    iosOtaToken: mintToken(24),
  };

  function seedDefaultAgentAndModel() {
    const defaultAgentId = '11111111-1111-4111-8111-111111111111';
    state.agents.set(defaultAgentId, {
      id: defaultAgentId,
      name: 'RokBot Default',
      createdAt: new Date().toISOString(),
    });
    if (!state.needsModel) {
      state.modelConfig = {
        version: 1,
        providers: [
          {
            id: 'default',
            name: 'Default Provider',
            apiFormat: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-harness-default-key-0000',
          },
        ],
        profiles: [
          {
            id: 'default',
            name: 'Default Model',
            providerId: 'default',
            model: 'gpt-4o',
            contextWindowTokens: 128000,
          },
        ],
        defaultRoute: { profileId: 'default', effort: 'medium', fallbacks: [] },
        botRoutes: {},
      };
    } else {
      state.modelConfig = null;
    }
  }
  seedDefaultAgentAndModel();

  function recordAudit(method, reqPath, actorKind, actorId, status, detail = '') {
    state.auditLog.push({
      ts: new Date().toISOString(),
      method,
      path: reqPath,
      actorKind,
      actorId: actorId || null,
      status,
      detail: String(detail).slice(0, 120),
    });
  }

  function checkRateLimit(key, limit, windowMs = 60_000) {
    const now = Date.now();
    const list = (state.rateLimits.get(key) ?? []).filter((ts) => now - ts < windowMs);
    if (list.length >= limit) {
      state.rateLimits.set(key, list);
      throw new HttpError(429, 'Too many requests');
    }
    list.push(now);
    state.rateLimits.set(key, list);
  }

  function isAdminAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[ADMIN_COOKIE];
    if (!token) return false;
    return state.adminSessions.has(hashToken(token));
  }

  function requireAdmin(req) {
    check(isAdminAuthenticated(req), 401, '请登录管理页面');
  }

  function checkAdminCsrf(req, origin) {
    check(req.headers['x-rokbot-csrf'] === '1', 403, '请从管理页面执行此操作');
    check(!req.headers.origin || req.headers.origin === origin, 403, '请求来源不匹配');
  }

  function authenticateDevice(req, origin, { optional = false } = {}) {
    const authHeader = req.headers.authorization;
    const cookies = parseCookies(req.headers.cookie);
    const webToken = cookies[WEB_COOKIE];

    if (authHeader !== undefined) {
      const m = /^Bearer ([A-Za-z0-9._~+/-]{16,256})$/.exec(authHeader);
      check(m, 401, '设备凭证无效，请重新配对');
      check(state.federationRole === 'primary', 403, 'Connect to the primary Host');
      const h = hashToken(m[1]);
      const found = state.devices.find((d) => !d.revokedAt && d.hash === h);
      check(found, 401, '设备凭证无效，请重新配对');
      found.lastSeenAt = new Date().toISOString();
      return found;
    }

    if (webToken !== undefined) {
      check(state.webClientAvailable, 403, '网页版未启用');
      check(req.headers['x-rokbot-web'] === '1', 403, '请从网页版发起请求');
      check(!req.headers.origin || req.headers.origin === origin, 403, '请求来源不匹配');
      check(state.federationRole === 'primary', 403, 'Connect to the primary Host');
      const h = hashToken(webToken);
      const found = state.devices.find((d) => !d.revokedAt && d.platform === 'web' && d.hash === h);
      check(found, 401, '设备凭证无效，请重新配对');
      found.lastSeenAt = new Date().toISOString();
      return found;
    }

    if (optional) return null;
    throw new HttpError(401, '设备凭证无效，请重新配对');
  }

  function canDeviceConfigureModel(device, req) {
    if (!state.modelAuthPolicy.allowEnv) return false;
    if (!state.modelAuthPolicy.allowDeviceModelConfig) return false;
    if (device.pairedWithAdminPassword || state.modelAuthPolicy.allowGuestModelConfig) {
      return true;
    }
    const stepUp = req?.headers?.['x-rokbot-admin-password'];
    if (typeof stepUp === 'string' && stepUp.length > 0 && state.initialized) {
      return verifyPasswordHash(stepUp, state.adminPasswordHash);
    }
    return false;
  }

  function publicModelRouting(cfg) {
    if (!cfg) {
      return {
        version: 1,
        configured: false,
        hasApiKey: false,
        providers: [],
        profiles: [],
        defaultRoute: null,
        botRoutes: {},
      };
    }
    const providers = (cfg.providers ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      apiFormat: p.apiFormat,
      baseUrl: p.baseUrl,
      hasApiKey: Boolean(p.apiKey),
    }));
    const profiles = (cfg.profiles ?? []).map((pr) => ({ ...pr }));
    const defProf = profiles.find((pr) => pr.id === cfg.defaultRoute?.profileId) ?? profiles[0];
    const defProv = providers.find((p) => p.id === defProf?.providerId) ?? providers[0];
    return {
      version: 1,
      configured: providers.length > 0 && profiles.length > 0,
      hasApiKey: providers.some((p) => p.hasApiKey),
      apiFormat: defProv?.apiFormat,
      baseUrl: defProv?.baseUrl,
      model: defProf?.model,
      contextWindowTokens: defProf?.contextWindowTokens,
      providers,
      profiles,
      defaultRoute: cfg.defaultRoute,
      botRoutes: cfg.botRoutes ?? {},
    };
  }

  function validateBaseUrl(raw) {
    check(typeof raw === 'string' && raw.trim().length > 0 && !/[\r\n\0]/.test(raw), 400, 'Base URL 不能为空');
    let u;
    try {
      u = new URL(raw.trim());
    } catch {
      throw new HttpError(400, 'Base URL 格式不正确');
    }
    check(['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash,
      400, 'Base URL 需要 HTTP(S) 地址，不能包含凭证或查询参数');
    return u.href.replace(/\/$/, '');
  }

  async function writeModelEnvFile(cfg) {
    const defProf = cfg.profiles[0];
    const defProv = cfg.providers.find((p) => p.id === defProf?.providerId) ?? cfg.providers[0];
    const lines = [
      `MODEL_API_FORMAT=${defProv?.apiFormat || 'openai'}`,
      `OPENAI_BASE_URL=${defProv?.baseUrl || ''}`,
      `OPENAI_MODEL=${defProf?.model || ''}`,
      `OPENAI_API_KEY=${defProv?.apiKey || ''}`,
      `ROKBOT_MODEL_ROUTING=${JSON.stringify(cfg)}`,
    ];
    await writeFile(path.join(dataDir, 'model.env'), lines.join('\n') + '\n', { mode: 0o600 });
  }

  function pairDevice({
    pairingKey,
    password,
    deviceName,
    platform,
    clientKind,
    clientDeviceId,
    bundleId,
    web = false,
  }) {
    check(typeof deviceName === 'string' && deviceName.trim().length >= 1 && deviceName.trim().length <= 80,
      400, '设备名称应为 1-80 个字符');
    const trimmedName = deviceName.trim();

    let normClientId = null;
    if (clientDeviceId !== undefined && clientDeviceId !== null && clientDeviceId !== '') {
      check(typeof clientDeviceId === 'string' && clientDeviceId.length <= 128 && /^[A-Za-z0-9._:@-]+$/.test(clientDeviceId),
        400, 'clientDeviceId 格式无效');
      normClientId = clientDeviceId;
    }
    let normBundleId = null;
    if (bundleId !== undefined && bundleId !== null && bundleId !== '') {
      check(typeof bundleId === 'string' && bundleId.length <= 128 && /^[A-Za-z0-9._-]+$/.test(bundleId),
        400, 'bundleId 格式无效');
      normBundleId = bundleId;
    }

    if (!web) {
      check(['desktop', 'ios'].includes(platform), 400, '设备类型应为 desktop 或 ios');
    }
    const hasKey = pairingKey !== undefined && pairingKey !== null;
    const hasPassword = password !== undefined && password !== null;
    check(!(hasKey && hasPassword), 400, '请只提供配对码或管理员密码之一');
    check(hasKey || hasPassword, 400, '请提供配对码或管理员密码');

    if (hasPassword) {
      check(typeof password === 'string' && password.length > 0, 400, '请输入管理员密码');
      check(state.initialized, 409, '请先设置管理员');
      check(verifyPasswordHash(password, state.adminPasswordHash), 401, '管理员密码不正确');
    } else {
      const codeHash = hashToken(normalizePairingCode(pairingKey));
      const idx = state.pairingKeys.findIndex((k) => k.hash === codeHash && k.expiresAt > Date.now());
      check(idx >= 0, 401, '配对码无效、已使用或已过期');
      state.pairingKeys.splice(idx, 1);
    }

    const kind = web ? 'web' : (platform === 'desktop' && clientKind === 'android' ? 'android' : platform);
    const token = mintToken(32);
    const now = new Date().toISOString();

    let matches = [];
    if (normClientId) {
      matches = state.devices.filter((d) => !d.revokedAt && d.platform === kind && d.clientDeviceId === normClientId);
    } else if (normBundleId) {
      const lower = trimmedName.toLowerCase();
      matches = state.devices.filter(
        (d) => !d.revokedAt && d.platform === kind && !d.clientDeviceId && d.bundleId === normBundleId && d.name.toLowerCase() === lower,
      );
    }

    if (matches.length > 0) {
      const primary = matches[0];
      primary.name = trimmedName;
      primary.hash = hashToken(token);
      primary.clientDeviceId = normClientId;
      if (normBundleId) primary.bundleId = normBundleId;
      primary.lastSeenAt = now;
      if (hasPassword) primary.pairedWithAdminPassword = true;
      for (const dup of matches.slice(1)) {
        dup.revokedAt = now;
      }
      return { deviceId: primary.id, token, reused: true, platform: kind };
    }

    const activeCount = state.devices.filter((d) => !d.revokedAt).length;
    check(activeCount < MAX_DEVICES, 409, '设备数量已达上限，请先撤销不用的设备');

    const deviceId = randomUUID();
    state.devices.push({
      id: deviceId,
      name: trimmedName,
      platform: kind,
      clientDeviceId: normClientId,
      bundleId: normBundleId,
      hash: hashToken(token),
      pairedWithAdminPassword: Boolean(hasPassword),
      createdAt: now,
      revokedAt: null,
      lastSeenAt: now,
      push: {
        provider: 'none',
        capable: false,
        authorization: 'notDetermined',
        environment: 'production',
        foreground: false,
        enabled: false,
        configured: false,
      },
    });
    return { deviceId, token, reused: false, platform: kind };
  }

  function publicDeviceView(d) {
    const isFg = Array.from(notifStreams).some((s) => s.deviceId === d.id && s.foreground);
    return {
      id: d.id,
      deviceId: d.id,
      name: d.name,
      platform: d.platform,
      clientDeviceId: d.clientDeviceId,
      bundleId: d.bundleId,
      pairedWithAdminPassword: d.pairedWithAdminPassword,
      createdAt: d.createdAt,
      revokedAt: d.revokedAt,
      lastSeenAt: d.lastSeenAt,
      push: {
        ...d.push,
        foreground: isFg || Boolean(d.push?.foreground),
      },
    };
  }

  function dispatchPush(device, payload, { bypassForeground = false } = {}) {
    const hasFgStream = ['ios', 'android'].includes(device.platform)
      && Array.from(notifStreams).some((s) => s.deviceId === device.id && s.foreground);
    if (hasFgStream && !bypassForeground) {
      const entry = { ts: new Date().toISOString(), deviceId: device.id, reason: 'foreground', payload };
      state.pushHistory.suppressed.push(entry);
      return { ok: true, status: 'skipped', reason: 'foreground' };
    }
    const delivery = { ts: new Date().toISOString(), deviceId: device.id, platform: device.platform, payload };
    state.pushHistory.sent.push(delivery);
    if (typeof state.pushSink === 'function') {
      state.pushSink(delivery);
    }
    return { ok: true, status: 'sent' };
  }

  function publishNotificationItem(input) {
    const item = {
      id: String(state.nextNotifId++),
      type: input?.type || 'agent_reply',
      agentId: input?.agentId || '11111111-1111-4111-8111-111111111111',
      title: input?.title || 'RokBot',
      body: input?.body || 'New reply',
      createdAt: new Date().toISOString(),
      deepLink: `rokbot-local://agent/${input?.agentId || '11111111-1111-4111-8111-111111111111'}`,
    };
    state.notifications.push(item);
    const frame = `id: ${item.id}\nevent: notification\ndata: ${JSON.stringify(item)}\n\n`;
    for (const s of notifStreams) {
      if (!s.res.destroyed) s.res.write(frame);
    }
    if (input?.deviceId) {
      const target = state.devices.find((d) => d.id === input.deviceId && !d.revokedAt);
      if (target) dispatchPush(target, item, { bypassForeground: Boolean(input.bypassForeground) });
    } else {
      for (const d of state.devices) {
        if (!d.revokedAt && d.push?.enabled) {
          dispatchPush(d, item, { bypassForeground: Boolean(input.bypassForeground) });
        }
      }
    }
    return item;
  }

  function emitSseEvent(channel, payload) {
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const s of eventsStreams) {
      if (!s.res.destroyed) s.res.write(frame);
    }
  }

  function resolveUpdateArtifact(platform, filename, artifactIdParam = null) {
    if (artifactIdParam) {
      const exact = state.artifacts.get(String(artifactIdParam));
      if (exact && exact.platform === platform && exact.filename === filename) {
        return exact;
      }
      return null;
    }
    const rels = state.releases[platform] || [];
    for (let i = rels.length - 1; i >= 0; i--) {
      const rel = rels[i];
      if (rel.filename === filename && rel.artifactId) {
        const art = state.artifacts.get(rel.artifactId);
        if (art && art.platform === platform && art.filename === filename) return art;
      }
      if (Array.isArray(rel.deltaArtifactIds)) {
        for (let j = rel.deltaArtifactIds.length - 1; j >= 0; j--) {
          const dArt = state.artifacts.get(rel.deltaArtifactIds[j]);
          if (dArt && dArt.platform === platform && dArt.filename === filename) return dArt;
        }
      }
    }
    const all = Array.from(state.artifacts.values());
    for (let i = all.length - 1; i >= 0; i--) {
      const a = all[i];
      if (a.platform === platform && a.filename === filename) return a;
    }
    return null;
  }

  function buildPlatformManifest(platform, origin) {
    const list = state.releases[platform];
    if (!list || list.length === 0) return null;
    const latestRel = list[list.length - 1];

    if (platform === 'android') {
      const track = latestRel.channel || 'stable';
      const mappedDeltas = latestRel.deltas.map((d) => ({
        fromVersionCode: d.fromVersionCode,
        fromSha256: d.fromSha256,
        fromApkSha256: d.fromSha256,
        baseSha256: d.baseSha256 ?? d.fromSha256,
        baseSize: d.baseSize,
        url: d.url,
        sha256: d.sha256,
        size: d.size,
        format: 'RBDELTA1',
      }));
      const baseRecord = {
        schema: ANDROID_NATIVE_UPDATE_SCHEMA,
        track,
        packageName: latestRel.packageName || 'dev.rokbot.nativeapp',
        versionName: latestRel.version,
        versionCode: latestRel.versionCode,
        buildId: String(latestRel.versionCode),
        sha256: latestRel.sha256,
        size: latestRel.size,
        certificateSha256: latestRel.certificateSha256 || '',
        fullUrl: latestRel.fileUrl,
        url: latestRel.fileUrl,
        publishedAt: latestRel.publishedAt,
        releaseNotes: latestRel.releaseNotes || '',
        notes: latestRel.releaseNotes || '',
        deltas: mappedDeltas,
      };
      let signed = signAndroidManifest(baseRecord, signingKeys.privateKey);
      signed = signAndroidDeltas(signed, signingKeys.privateKey);
      return {
        ...signed,
        channel: track,
        signatureAlgorithm: 'ecdsa-p256-sha256',
        publicKeyPem: signingKeys.publicKeyPem,
        latest: {
          versionName: latestRel.version,
          versionCode: latestRel.versionCode,
          packageName: latestRel.packageName || 'dev.rokbot.nativeapp',
          certificateSha256: latestRel.certificateSha256 || '',
          apkUrl: latestRel.fileUrl,
          apkSha256: latestRel.sha256,
          apkSize: latestRel.size,
          releaseNotes: latestRel.releaseNotes || '',
          deltas: mappedDeltas.map((d) => ({ ...d })),
        },
      };
    }

    if (platform === 'ios') {
      const tokenBase = `${origin}/updates/ios/${state.iosOtaToken}`;
      const manifestPlistUrl = `${tokenBase}/manifest.plist`;
      const altStoreSourceUrl = `${tokenBase}/altstore.json`;
      const ipaDownloadUrl = `${tokenBase}/${encodeURIComponent(latestRel.filename)}`;
      return {
        schema: IOS_UPDATE_SCHEMA,
        latest: {
          version: latestRel.version,
          build: String(latestRel.build ?? latestRel.versionCode ?? 1),
          bundleId: latestRel.bundleId || 'dev.rokbot.local',
          sha256: latestRel.sha256,
          size: latestRel.size,
          releaseNotes: latestRel.releaseNotes || '',
          publishedAt: latestRel.publishedAt,
          installMethods: {
            itmsServicesUrl: manifestPlistUrl,
            itmsServicesHref: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestPlistUrl)}`,
            altStoreSourceUrl,
            ipaDownloadUrl,
          },
        },
      };
    }

    // Desktop: macos or windows
    const baseRecord = {
      schema: DESKTOP_UPDATE_SCHEMA,
      platform,
      track: latestRel.channel || 'stable',
      version: latestRel.version,
      sha256: latestRel.sha256,
      size: latestRel.size,
      url: latestRel.fileUrl,
      publishedAt: latestRel.publishedAt,
      deltas: latestRel.deltas,
      asarDeltas: latestRel.asarDeltas,
    };
    let signed = signDesktopManifest(baseRecord, signingKeys.privateKey);
    signed = signDesktopDeltas(signed, signingKeys.privateKey);
    return {
      ...signed,
      channel: latestRel.channel || 'stable',
      releaseNotes: latestRel.releaseNotes || '',
      asarSha256: latestRel.asarSha256 || null,
      asarHeaderSha256: latestRel.asarHeaderSha256 || null,
      signatureAlgorithm: 'ecdsa-p256-sha256',
      publicKeyPem: signingKeys.publicKeyPem,
      latest: {
        version: latestRel.version,
        url: latestRel.fileUrl,
        sha256: latestRel.sha256,
        size: latestRel.size,
        asarSha256: latestRel.asarSha256 || null,
        asarHeaderSha256: latestRel.asarHeaderSha256 || null,
        asarDeltas: latestRel.asarDeltas,
        deltas: latestRel.deltas,
      },
    };
  }

  function sendJson(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      ...extraHeaders,
    });
    res.end(payload);
  }

  function serveBytesWithRange(req, res, bytes, contentType, etag) {
    const total = bytes.length;
    const baseHeaders = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
      etag: `"${etag}"`,
    };
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
      if (!m || (m[1] === '' && m[2] === '') || total === 0) {
        res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${total}` });
        return res.end();
      }
      let start;
      let end;
      if (m[1] === '') {
        const suffixLen = Number(m[2]);
        if (!Number.isSafeInteger(suffixLen) || suffixLen <= 0) {
          res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${total}` });
          return res.end();
        }
        start = Math.max(0, total - suffixLen);
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? total - 1 : Math.min(total - 1, Number(m[2]));
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) {
        res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${total}` });
        return res.end();
      }
      const slice = bytes.subarray(start, end + 1);
      res.writeHead(206, {
        ...baseHeaders,
        'content-length': slice.length,
        'content-range': `bytes ${start}-${end}/${total}`,
      });
      return res.end(req.method === 'HEAD' ? undefined : slice);
    }

    res.writeHead(200, {
      ...baseHeaders,
      'content-length': total,
    });
    return res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  const server = http.createServer(async (req, res) => {
    // Always enforce RokBot security headers
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('cache-control', 'no-store');

    const ip = req.socket.remoteAddress || '127.0.0.1';
    let actorKind = 'anon';
    let actorId = null;
    let reqPath = String(req.url || '/');

    try {
      const hostHeader = req.headers.host || '127.0.0.1';
      if (Array.isArray(hostHeader) || /[\r\n\0]/.test(String(hostHeader))) {
        throw new HttpError(400, 'Invalid request URL');
      }
      const origin = `http://${hostHeader}`;
      let url;
      try {
        url = new URL(req.url || '/', origin);
      } catch {
        throw new HttpError(400, 'Invalid request URL');
      }
      reqPath = url.pathname;
      // 1. Health & Public Icon
      if (req.method === 'GET' && (reqPath === '/health' || reqPath === '/healthz')) {
        return sendJson(res, 200, { ok: true, initialized: state.initialized, brand: 'RokBot' });
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && reqPath === '/rokbot-icon.png') {
        const iconBytes = getRokBotIconPng();
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': iconBytes.length,
          'cache-control': 'public, max-age=86400',
        });
        return res.end(req.method === 'HEAD' ? undefined : iconBytes);
      }

      // 2. Public / Authenticated /connect/status
      if (req.method === 'GET' && reqPath === '/connect/status') {
        const dev = authenticateDevice(req, origin, { optional: true });
        if (dev) {
          actorKind = 'device';
          actorId = dev.id;
          return sendJson(res, 200, {
            ok: true,
            initialized: state.initialized,
            needsModel: state.needsModel,
            brand: 'RokBot',
            deviceId: dev.id,
            deviceName: dev.name,
            platform: dev.platform,
            connected: true,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          initialized: state.initialized,
          needsModel: state.needsModel,
          brand: 'RokBot',
        });
      }

      // 3. Pairing
      if (req.method === 'POST' && reqPath === '/connect/pair') {
        check(state.federationRole === 'primary', 403, 'Connect to the primary Host');
        checkRateLimit(`pair:${ip}`, 6);
        checkRateLimit('pair:global', 60);
        const body = await readJsonBody(req);
        if (body.password !== undefined && body.password !== null) {
          checkRateLimit(`pair-password:${ip}`, 5);
          checkRateLimit('pair-password:global', 20);
        }
        const paired = pairDevice(body);
        actorKind = 'device';
        actorId = paired.deviceId;
        recordAudit(req.method, reqPath, actorKind, actorId, 201, `platform=${paired.platform}`);
        return sendJson(res, 201, {
          deviceId: paired.deviceId,
          token: paired.token,
          reused: paired.reused,
          gatewayUrl: origin,
          notificationUrl: `${origin}/notifications/events`,
        });
      }

      // 4. Tokenized iOS External OTA endpoints (no Bearer required; validated by token)
      const iosOtaMatch = /^\/updates\/ios\/([^/]+)\/([^/]+)$/.exec(reqPath);
      if (iosOtaMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const [, tok, item] = iosOtaMatch;
        check(tok === state.iosOtaToken, 403, 'Invalid or expired iOS OTA token');
        const list = state.releases.ios;
        check(list.length > 0, 404, 'No iOS release published');
        const latestRel = list[list.length - 1];
        const tokenBase = `${origin}/updates/ios/${state.iosOtaToken}`;

        if (item === 'manifest.plist') {
          const xml = buildIosManifestPlist({
            ipaUrl: `${tokenBase}/${encodeURIComponent(latestRel.filename)}`,
            bundleId: latestRel.bundleId || 'dev.rokbot.local',
            bundleVersion: latestRel.version,
            title: 'RokBot',
            displayImageUrl: `${origin}/rokbot-icon.png`,
            fullSizeImageUrl: `${origin}/rokbot-icon.png`,
          });
          res.writeHead(200, {
            'content-type': 'application/xml; charset=utf-8',
            'content-length': Buffer.byteLength(xml),
          });
          return res.end(req.method === 'HEAD' ? undefined : xml);
        }
        if (item === 'altstore.json') {
          const source = buildAltStoreSource({
            name: 'RokBot Self-Hosted',
            identifier: `${latestRel.bundleId || 'dev.rokbot.local'}.source`,
            sourceURL: `${tokenBase}/altstore.json`,
            apps: [
              {
                name: 'RokBot',
                bundleIdentifier: latestRel.bundleId || 'dev.rokbot.local',
                developerName: 'RokBot Self-Hosted',
                localizedDescription: latestRel.releaseNotes || 'RokBot iOS App',
                versions: [
                  {
                    version: latestRel.version,
                    date: latestRel.publishedAt,
                    downloadURL: `${tokenBase}/${encodeURIComponent(latestRel.filename)}`,
                    size: latestRel.size,
                    sha256: latestRel.sha256,
                  },
                ],
              },
            ],
          });
          return sendJson(res, 200, source);
        }

        let decodedFilename;
        try {
          decodedFilename = decodeURIComponent(item);
        } catch {
          throw new HttpError(400, 'Malformed URI encoding');
        }
        const artifact = resolveUpdateArtifact('ios', path.basename(decodedFilename), url.searchParams.get('artifactId'));
        check(artifact, 404, 'iOS artifact not found');
        const bytes = await readFile(artifact.diskPath || artifact.filePath);
        return serveBytesWithRange(req, res, bytes, 'application/octet-stream', artifact.sha256);
      }

      // 5. Web client routes
      if (reqPath === '/web/manifest.webmanifest' && req.method === 'GET') {
        check(state.webClientAvailable, 404, '网页版未启用');
        const manifest = {
          name: 'RokBot',
          short_name: 'RokBot',
          start_url: '/web/',
          scope: '/web/',
          display: 'standalone',
          background_color: '#111111',
          theme_color: '#111111',
          icons: [{ src: '/rokbot-icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
        };
        res.writeHead(200, {
          'content-type': 'application/manifest+json; charset=utf-8',
          'content-length': Buffer.byteLength(JSON.stringify(manifest)),
        });
        return res.end(JSON.stringify(manifest));
      }

      if (reqPath === '/web/api/session' && req.method === 'GET') {
        const cookies = parseCookies(req.headers.cookie);
        const webTok = cookies[WEB_COOKIE];
        const signedIn = webTok
          ? state.devices.find((d) => !d.revokedAt && d.platform === 'web' && d.hash === hashToken(webTok))
          : null;
        return sendJson(res, 200, {
          available: state.webClientAvailable,
          rendererVersion: state.webRendererVersion,
          paired: Boolean(signedIn),
          deviceName: signedIn?.name ?? null,
          secure: false,
        });
      }

      if (reqPath === '/web/api/pair' && req.method === 'POST') {
        check(state.federationRole === 'primary', 403, 'Connect to the primary Host');
        check(req.headers['x-rokbot-web'] === '1', 403, '请从网页版登录页操作');
        check(!req.headers.origin || req.headers.origin === origin, 403, '请从网页版登录页操作');
        check(state.webClientAvailable, 404, '网页版未启用');
        checkRateLimit(`pair:${ip}`, 6);
        checkRateLimit('pair:global', 60);
        const body = await readJsonBody(req);
        const paired = pairDevice({ ...body, web: true });
        res.setHeader(
          'set-cookie',
          `${WEB_COOKIE}=${paired.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${400 * 24 * 60 * 60}`,
        );
        return sendJson(res, 201, { ok: true, deviceId: paired.deviceId });
      }

      if (reqPath === '/web/api/logout' && req.method === 'POST') {
        check(req.headers['x-rokbot-web'] === '1', 403, '请从网页版登录页操作');
        check(!req.headers.origin || req.headers.origin === origin, 403, '请从网页版登录页操作');
        const cookies = parseCookies(req.headers.cookie);
        const webTok = cookies[WEB_COOKIE];
        if (webTok) {
          const found = state.devices.find((d) => !d.revokedAt && d.platform === 'web' && d.hash === hashToken(webTok));
          if (found) found.revokedAt = new Date().toISOString();
        }
        res.setHeader('set-cookie', `${WEB_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        return sendJson(res, 200, { ok: true });
      }

      // 6. Admin API (/admin/api/*)
      if (reqPath.startsWith('/admin/api/')) {
        if (req.method !== 'GET') {
          checkAdminCsrf(req, origin);
        }

        if (req.method === 'GET' && reqPath === '/admin/api/session') {
          return sendJson(res, 200, {
            initialized: state.initialized,
            authenticated: isAdminAuthenticated(req),
            publicUrl: origin,
          });
        }

        if (req.method === 'POST' && (reqPath === '/admin/api/setup' || reqPath === '/admin/api/login')) {
          checkRateLimit(`admin:${ip}`, 5);
          const body = await readJsonBody(req);
          if (reqPath.endsWith('/setup')) {
            check(!state.initialized, 409, '管理员已初始化');
            check(typeof body.setupKey === 'string' && body.setupKey === state.setupKey, 401, 'Setup Key 无效');
            check(typeof body.password === 'string' && body.password.length >= 8 && body.password.length <= 128,
              400, '管理员密码长度需在 8 到 128 之间');
            state.adminPassword = body.password;
            state.adminPasswordHash = hashPassword(body.password);
            state.initialized = true;
          } else {
            check(state.initialized, 409, '请先设置管理员');
            check(verifyPasswordHash(body.password, state.adminPasswordHash), 401, '管理员密码不正确');
          }
          const sessToken = mintToken(32);
          state.adminSessions.set(hashToken(sessToken), { createdAt: Date.now() });
          res.setHeader(
            'set-cookie',
            `${ADMIN_COOKIE}=${sessToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
          );
          actorKind = 'admin';
          recordAudit(req.method, reqPath, actorKind, null, 200);
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === 'POST' && reqPath === '/admin/api/logout') {
          const cookies = parseCookies(req.headers.cookie);
          if (cookies[ADMIN_COOKIE]) state.adminSessions.delete(hashToken(cookies[ADMIN_COOKIE]));
          res.setHeader('set-cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
          return sendJson(res, 200, { ok: true });
        }

        requireAdmin(req);
        actorKind = 'admin';

        if (req.method === 'GET' && reqPath === '/admin/api/status') {
          return sendJson(res, 200, {
            ok: true,
            initialized: state.initialized,
            needsModel: state.needsModel,
            federationRole: state.federationRole,
            deviceCount: state.devices.filter((d) => !d.revokedAt).length,
            devices: state.devices.map(publicDeviceView),
            pairingKeys: state.pairingKeys
              .filter((k) => k.expiresAt > Date.now())
              .map(({ id, expiresAt }) => ({ id, expiresAt })),
            model: {
              ...publicModelRouting(state.modelConfig),
              devicePolicy: {
                envAllowed: state.modelAuthPolicy.allowEnv,
                allowDeviceModelConfig: state.modelAuthPolicy.allowDeviceModelConfig,
                allowGuestModelConfig: state.modelAuthPolicy.allowGuestModelConfig,
              },
            },
            brand: 'RokBot',
          });
        }

        if (req.method === 'POST' && reqPath === '/admin/api/pairing-keys') {
          const code = mintPairingCode();
          const entry = {
            id: randomUUID(),
            hash: hashToken(code),
            expiresAt: Date.now() + 5 * 60_000,
          };
          state.pairingKeys.push(entry);
          recordAudit(req.method, reqPath, 'admin', null, 201, 'pairing-key-created');
          return sendJson(res, 201, {
            id: entry.id,
            pairingKey: code,
            expiresAt: new Date(entry.expiresAt).toISOString(),
          });
        }

        if (req.method === 'GET' && reqPath === '/admin/api/devices') {
          return sendJson(res, 200, {
            devices: state.devices.map(publicDeviceView),
          });
        }

        const revokeMatch = /^\/admin\/api\/devices\/([^/]+)\/revoke$/.exec(reqPath);
        if (req.method === 'POST' && revokeMatch) {
          const target = state.devices.find((d) => d.id === revokeMatch[1]);
          check(target, 404, '设备不存在');
          target.revokedAt = new Date().toISOString();
          for (const s of [...eventsStreams]) {
            if (s.deviceId === target.id) {
              clearInterval(s.keepalive);
              eventsStreams.delete(s);
              s.res.destroy();
            }
          }
          for (const s of [...notifStreams]) {
            if (s.deviceId === target.id) {
              clearInterval(s.keepalive);
              notifStreams.delete(s);
              s.res.destroy();
            }
          }
          recordAudit(req.method, reqPath, 'admin', target.id, 200, 'device-revoked');
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === 'GET' && reqPath === '/admin/api/updates') {
          return sendJson(res, 200, {
            ok: true,
            signatureAlgorithm: 'ecdsa-p256-sha256',
            publicKeyPem: signingKeys.publicKeyPem,
            publicKeySpkiBase64: signingKeys.publicKeySpkiBase64,
            releases: state.releases,
            artifacts: Array.from(state.artifacts.values()).map((a) => ({
              id: a.id,
              platform: a.platform,
              filename: a.filename,
              sha256: a.sha256,
              size: a.size,
              uploadedAt: a.uploadedAt,
            })),
          });
        }

        if (req.method === 'POST' && reqPath === '/admin/api/updates/upload') {
          const ctype = String(req.headers['content-type'] || '');
          let platform = url.searchParams.get('platform') || req.headers['x-rokbot-platform'] || '';
          let filename = url.searchParams.get('filename') || req.headers['x-rokbot-filename'] || '';
          let fileBytes;

          if (ctype.includes('multipart/form-data')) {
            const raw = await readRawBody(req);
            const parsed = parseMultipartFormData(raw, ctype);
            platform = platform || parsed.fields.platform || '';
            const firstFile = parsed.files[0];
            check(firstFile, 400, 'Missing multipart file');
            filename = filename || parsed.fields.filename || firstFile.filename;
            fileBytes = firstFile.data;
          } else {
            fileBytes = await readRawBody(req);
          }

          platform = String(platform).trim().toLowerCase();
          check(['android', 'ios', 'macos', 'windows'].includes(platform), 400, 'Invalid update platform');
          filename = path.basename(String(filename || '').trim());
          check(filename && filename !== '.' && filename !== '..' && /^[A-Za-z0-9._-]+$/.test(filename), 400, 'Invalid artifact filename');
          check(fileBytes && fileBytes.length > 0, 400, 'Empty artifact payload');

          const platDir = path.join(updatesArtifactsDir, platform);
          await mkdir(platDir, { recursive: true });
          const artifactId = randomUUID();
          const fileNameOnDisk = `${artifactId}-${filename}`;
          const destPath = path.join(platDir, fileNameOnDisk);
          await writeFile(destPath, fileBytes);

          const artifact = {
            id: artifactId,
            platform,
            filename,
            fileNameOnDisk,
            diskPath: destPath,
            filePath: destPath,
            sha256: sha256Hex(fileBytes),
            size: fileBytes.length,
            uploadedAt: new Date().toISOString(),
          };
          state.artifacts.set(artifact.id, artifact);
          recordAudit(req.method, reqPath, 'admin', artifact.id, 201, `${platform}:${filename}`);
          return sendJson(res, 201, {
            ok: true,
            artifact: {
              id: artifact.id,
              platform: artifact.platform,
              filename: artifact.filename,
              sha256: artifact.sha256,
              size: artifact.size,
            },
          });
        }

        if (req.method === 'POST' && reqPath === '/admin/api/updates/publish') {
          const body = await readJsonBody(req);
          const platform = String(body.platform || '').trim().toLowerCase();
          check(['android', 'ios', 'macos', 'windows'].includes(platform), 400, 'Invalid update platform');
          check(typeof body.version === 'string' && body.version.trim().length > 0, 400, 'Missing release version');

          let artifact = null;
          if (body.artifactId) {
            artifact = state.artifacts.get(body.artifactId);
          } else if (body.filename) {
            const targetName = path.basename(body.filename);
            const allArts = Array.from(state.artifacts.values());
            for (let i = allArts.length - 1; i >= 0; i--) {
              if (allArts[i].platform === platform && allArts[i].filename === targetName) {
                artifact = allArts[i];
                break;
              }
            }
          }
          check(artifact && artifact.platform === platform, 404, 'Release artifact not found');

          const deltas = [];
          const asarDeltas = [];
          const deltaArtifactIds = [];
          if (body.generateDeltaFrom) {
            const baseRef = String(body.generateDeltaFrom);
            let baseArtifact = state.artifacts.get(baseRef);
            let baseVersionCode = 1;
            if (!baseArtifact) {
              const rels = state.releases[platform];
              for (let i = rels.length - 1; i >= 0; i--) {
                const rel = rels[i];
                const candidate = state.artifacts.get(rel.artifactId);
                if (!candidate) continue;
                if (rel.id === baseRef || rel.version === baseRef || (rel.filename === baseRef && candidate.id !== artifact.id)) {
                  baseArtifact = candidate;
                  baseVersionCode = rel.versionCode ?? 1;
                  break;
                }
              }
            }
            if (!baseArtifact) {
              const allArts = Array.from(state.artifacts.values());
              for (let i = allArts.length - 1; i >= 0; i--) {
                const a = allArts[i];
                if (a.platform === platform && a.filename === baseRef && a.id !== artifact.id) {
                  baseArtifact = a;
                  break;
                }
              }
            }
            if (baseArtifact) {
              const rels = state.releases[platform];
              for (let i = rels.length - 1; i >= 0; i--) {
                if (rels[i].artifactId === baseArtifact.id) {
                  baseVersionCode = rels[i].versionCode ?? 1;
                  break;
                }
              }
            }
            check(baseArtifact && baseArtifact.platform === platform, 404, 'Base artifact for generateDeltaFrom not found');

            const [baseBytes, targetBytes] = await Promise.all([
              readFile(baseArtifact.diskPath || baseArtifact.filePath),
              readFile(artifact.diskPath || artifact.filePath),
            ]);

            if (platform === 'android') {
              const deltaBuf = generateRbDelta(baseBytes, targetBytes);
              const deltaId = randomUUID();
              const deltaFilename = `${artifact.filename}.from-${baseVersionCode}.rbdelta`;
              const deltaFileNameOnDisk = `${deltaId}-${deltaFilename}`;
              const deltaPath = path.join(updatesArtifactsDir, platform, deltaFileNameOnDisk);
              await writeFile(deltaPath, deltaBuf);
              const deltaSha = sha256Hex(deltaBuf);
              const deltaArt = {
                id: deltaId,
                platform,
                filename: deltaFilename,
                fileNameOnDisk: deltaFileNameOnDisk,
                diskPath: deltaPath,
                filePath: deltaPath,
                sha256: deltaSha,
                size: deltaBuf.length,
                uploadedAt: new Date().toISOString(),
              };
              state.artifacts.set(deltaArt.id, deltaArt);
              deltaArtifactIds.push(deltaArt.id);
              deltas.push({
                fromVersionCode: baseVersionCode,
                fromSha256: baseArtifact.sha256,
                baseSha256: baseArtifact.sha256,
                baseSize: baseArtifact.size,
                sha256: deltaSha,
                size: deltaBuf.length,
                url: `${origin}/local/updates/files/${platform}/${encodeURIComponent(deltaFilename)}?artifactId=${encodeURIComponent(deltaArt.id)}`,
              });
            } else if (platform === 'macos' || platform === 'windows') {
              const deltaBuf = generateRbd1Delta(baseBytes, targetBytes);
              const deltaId = randomUUID();
              const deltaFilename = `${artifact.filename}.from-${baseArtifact.sha256.slice(0, 8)}.rbd1`;
              const deltaFileNameOnDisk = `${deltaId}-${deltaFilename}`;
              const deltaPath = path.join(updatesArtifactsDir, platform, deltaFileNameOnDisk);
              await writeFile(deltaPath, deltaBuf);
              const deltaSha = sha256Hex(deltaBuf);
              const deltaArt = {
                id: deltaId,
                platform,
                filename: deltaFilename,
                fileNameOnDisk: deltaFileNameOnDisk,
                diskPath: deltaPath,
                filePath: deltaPath,
                sha256: deltaSha,
                size: deltaBuf.length,
                uploadedAt: new Date().toISOString(),
              };
              state.artifacts.set(deltaArt.id, deltaArt);
              deltaArtifactIds.push(deltaArt.id);
              const rec = {
                baseSha256: baseArtifact.sha256,
                baseSize: baseArtifact.size,
                sha256: deltaSha,
                size: deltaBuf.length,
                url: `${origin}/local/updates/files/${platform}/${encodeURIComponent(deltaFilename)}?artifactId=${encodeURIComponent(deltaArt.id)}`,
                format: 'RBD1',
              };
              if (body.asarHeaderSha256 || artifact.filename.endsWith('.asar')) {
                asarDeltas.push({
                  ...rec,
                  targetSha256: artifact.sha256,
                  targetSize: artifact.size,
                  targetHeaderSha256: body.asarHeaderSha256 || artifact.sha256,
                });
              } else {
                deltas.push(rec);
              }
            }
          }

          const release = {
            id: randomUUID(),
            platform,
            version: body.version.trim(),
            versionCode: Number(body.versionCode ?? body.build ?? 1),
            build: String(body.build ?? body.versionCode ?? '1'),
            channel: body.channel || body.track || 'stable',
            releaseNotes: body.releaseNotes || '',
            packageName: body.packageName || 'dev.rokbot.nativeapp',
            bundleId: body.bundleId || 'dev.rokbot.local',
            certificateSha256: body.certificateSha256 || '',
            asarSha256: body.asarSha256 || null,
            asarHeaderSha256: body.asarHeaderSha256 || null,
            artifactId: artifact.id,
            deltaArtifactIds,
            filename: artifact.filename,
            sha256: artifact.sha256,
            size: artifact.size,
            fileUrl: `${origin}/local/updates/files/${platform}/${encodeURIComponent(artifact.filename)}`,
            publishedAt: new Date().toISOString(),
            deltas,
            asarDeltas,
          };

          state.releases[platform].push(release);
          if (platform === 'ios') {
            state.iosOtaToken = mintToken(24);
          }

          const manifest = buildPlatformManifest(platform, origin);
          recordAudit(req.method, reqPath, 'admin', release.id, 201, `${platform}:${release.version}`);
          return sendJson(res, 201, { ok: true, release, manifest });
        }

        const delUpdateMatch = /^\/admin\/api\/updates\/([^/]+)\/([^/]+)$/.exec(reqPath);
        if (req.method === 'DELETE' && delUpdateMatch) {
          const [, platform, releaseId] = delUpdateMatch;
          check(['android', 'ios', 'macos', 'windows'].includes(platform), 404, 'Unknown platform');
          const list = state.releases[platform];
          const idx = list.findIndex((r) => r.id === releaseId);
          check(idx >= 0, 404, 'Release not found');
          const [removed] = list.splice(idx, 1);
          const candidateArtifactIds = [
            removed.artifactId,
            ...(Array.isArray(removed.deltaArtifactIds) ? removed.deltaArtifactIds : []),
          ].filter(Boolean);
          const remainingReleases = Object.values(state.releases).flat();
          for (const artId of candidateArtifactIds) {
            const stillReferenced = remainingReleases.some(
              (r) => r.artifactId === artId || (Array.isArray(r.deltaArtifactIds) && r.deltaArtifactIds.includes(artId)),
            );
            if (!stillReferenced) {
              const art = state.artifacts.get(artId);
              if (art) {
                await rm(art.diskPath || art.filePath, { force: true }).catch(() => {});
                state.artifacts.delete(art.id);
              }
            }
          }
          recordAudit(req.method, reqPath, 'admin', releaseId, 200, 'release-deleted');
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === 'POST' && reqPath === '/admin/api/web-client/open') {
          check(state.webClientAvailable, 404, '网页版未启用');
          const body = await readJsonBody(req);
          const dev = pairDevice({
            deviceName: body.deviceName || 'Web Browser',
            clientDeviceId: body.clientDeviceId,
            web: true,
            password: state.adminPassword,
          });
          res.setHeader(
            'set-cookie',
            `${WEB_COOKIE}=${dev.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${400 * 24 * 60 * 60}`,
          );
          return sendJson(res, 200, { ok: true, deviceId: dev.deviceId });
        }

        throw new HttpError(404, 'Admin endpoint not found');
      }

      // 7. Device-authenticated routes
      if (reqPath === '/local/status' && req.method === 'GET') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        return sendJson(res, 200, {
          ok: true,
          initialized: state.initialized,
          needsModel: state.needsModel,
          canConfigureModel: canDeviceConfigureModel(dev, req),
          hostVersion: '2bb5e41',
          defaultMachineId: state.defaultMachineId,
          brand: 'RokBot',
          federationRole: state.federationRole,
        });
      }

      if (reqPath === '/local/model' && (req.method === 'GET' || req.method === 'PUT')) {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        check(canDeviceConfigureModel(dev, req), 403, '该设备无权修改模型配置');

        if (req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            config: publicModelRouting(state.modelConfig),
            reload: { ...state.modelReload },
            canConfigureModel: true,
          });
        }

        const body = await readJsonBody(req);
        const prevProviders = new Map((state.modelConfig?.providers ?? []).map((p) => [p.id, p]));

        let nextConfig;
        if (Array.isArray(body.providers) && Array.isArray(body.profiles)) {
          check(body.providers.length > 0, 400, '至少需要一个模型服务商');
          check(body.profiles.length > 0, 400, '至少需要一个模型配置');
          const providers = body.providers.map((p) => {
            check(p && typeof p.id === 'string' && p.id.trim(), 400, 'Provider ID 不能为空');
            const apiFormat = p.apiFormat || 'openai';
            check(['openai', 'anthropic'].includes(apiFormat), 400, '接口格式无效');
            const baseUrl = validateBaseUrl(p.baseUrl);
            const existing = prevProviders.get(p.id);
            const suppliedKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
            const apiKey = suppliedKey || existing?.apiKey || '';
            check(apiKey.length > 0, 400, 'API Key 不能为空');
            return {
              id: p.id.trim(),
              name: String(p.name || p.id).trim(),
              apiFormat,
              baseUrl,
              apiKey,
            };
          });
          const provIds = new Set(providers.map((p) => p.id));
          const profiles = body.profiles.map((pr) => {
            check(pr && typeof pr.id === 'string' && pr.id.trim(), 400, 'Profile ID 不能为空');
            check(provIds.has(pr.providerId), 400, `Unknown providerId: ${pr.providerId}`);
            check(typeof pr.model === 'string' && pr.model.trim().length > 0, 400, '模型名称不能为空');
            return {
              id: pr.id.trim(),
              name: String(pr.name || pr.model).trim(),
              providerId: pr.providerId,
              model: pr.model.trim(),
              contextWindowTokens: Number(pr.contextWindowTokens ?? 128000),
            };
          });
          nextConfig = {
            version: 1,
            providers,
            profiles,
            defaultRoute: body.defaultRoute || { profileId: profiles[0].id, effort: 'medium', fallbacks: [] },
            botRoutes: body.botRoutes ?? {},
          };
        } else {
          // Legacy single-provider shape
          const apiFormat = body.apiFormat || state.modelConfig?.providers?.[0]?.apiFormat || 'openai';
          check(['openai', 'anthropic'].includes(apiFormat), 400, '接口格式无效');
          const baseUrl = validateBaseUrl(body.baseUrl ?? state.modelConfig?.providers?.[0]?.baseUrl);
          const model = String(body.model ?? state.modelConfig?.profiles?.[0]?.model ?? '').trim();
          check(model.length > 0, 400, '模型名称不能为空');
          const existingKey = state.modelConfig?.providers?.[0]?.apiKey || '';
          const suppliedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
          const apiKey = suppliedKey || existingKey;
          check(apiKey.length > 0, 400, 'API Key 不能为空');
          nextConfig = {
            version: 1,
            providers: [{ id: 'default', name: 'Default Provider', apiFormat, baseUrl, apiKey }],
            profiles: [{
              id: 'default',
              name: 'Default Model',
              providerId: 'default',
              model,
              contextWindowTokens: Number(body.contextWindowTokens ?? 128000),
            }],
            defaultRoute: { profileId: 'default', effort: 'medium', fallbacks: [] },
            botRoutes: state.modelConfig?.botRoutes ?? {},
          };
        }

        state.modelConfig = nextConfig;
        state.needsModel = false;
        await writeModelEnvFile(nextConfig);

        const rev = state.modelReload.revision + 1;
        const now = new Date().toISOString();
        if (state.modelReloadBehavior.mode === 'waiting-then-applied') {
          state.modelReload = { revision: rev, status: 'waiting', error: null, updatedAt: now };
          const timer = setTimeout(() => {
            if (state.modelReload.revision === rev) {
              state.modelReload = {
                revision: rev,
                status: 'applied',
                error: null,
                updatedAt: new Date().toISOString(),
              };
            }
          }, state.modelReloadBehavior.delayMs ?? 40);
          timer.unref?.();
        } else if (state.modelReloadBehavior.mode === 'error') {
          state.modelReload = { revision: rev, status: 'error', error: 'Simulated reload failure', updatedAt: now };
        } else {
          state.modelReload = { revision: rev, status: 'applied', error: null, updatedAt: now };
        }

        recordAudit(req.method, reqPath, 'device', dev.id, 200, 'model-config-updated');
        return sendJson(res, 200, {
          ok: true,
          config: publicModelRouting(state.modelConfig),
          reload: { ...state.modelReload },
        });
      }

      if (reqPath === '/local/model/catalog' && req.method === 'POST') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        check(canDeviceConfigureModel(dev, req), 403, '该设备无权探测模型目录');
        const body = await readJsonBody(req);
        if (body.baseUrl) validateBaseUrl(body.baseUrl);
        const suppliedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        const savedKey = state.modelConfig?.providers?.[0]?.apiKey || '';
        check(suppliedKey || savedKey, 400, 'API Key 不能为空');
        if (state.upstreamCatalogFault) {
          throw new HttpError(state.upstreamCatalogFault.status || 502, state.upstreamCatalogFault.message || 'Upstream catalog error');
        }
        return sendJson(res, 200, { ok: true, models: state.upstreamCatalog });
      }

      if (reqPath === '/local/model/test' && req.method === 'POST') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        check(canDeviceConfigureModel(dev, req), 403, '该设备无权测试模型');
        const body = await readJsonBody(req);
        if (body.baseUrl) validateBaseUrl(body.baseUrl);
        const suppliedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
        const savedKey = state.modelConfig?.providers?.[0]?.apiKey || '';
        check(suppliedKey || savedKey, 400, 'API Key 不能为空');
        const model = String(body.model || state.modelConfig?.profiles?.[0]?.model || '').trim();
        check(model.length > 0, 400, '模型名称不能为空');
        if (state.modelTestFault) {
          throw new HttpError(state.modelTestFault.status || 502, state.modelTestFault.message || 'Model test failed');
        }
        return sendJson(res, 200, {
          ok: true,
          latencyMs: 12,
          reply: 'OK',
          model,
        });
      }

      // Auto-update device manifests & file downloads
      const manifestMatch = /^\/local\/updates\/(android|ios|macos|windows)\.json$/.exec(reqPath);
      if (manifestMatch && req.method === 'GET') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        const manifest = buildPlatformManifest(manifestMatch[1], origin);
        check(manifest, 404, `No published update for ${manifestMatch[1]}`);
        return sendJson(res, 200, manifest);
      }

      const fileDownloadMatch = /^\/local\/updates\/files\/(android|ios|macos|windows)\/([^/]+)$/.exec(reqPath);
      if (fileDownloadMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        const [, platform, rawName] = fileDownloadMatch;
        let decodedName;
        try {
          decodedName = decodeURIComponent(rawName);
        } catch {
          throw new HttpError(400, 'Malformed URI encoding');
        }
        const filename = path.basename(decodedName);
        const artifact = resolveUpdateArtifact(platform, filename, url.searchParams.get('artifactId'));
        check(artifact, 404, 'Update artifact not found');
        const bytes = await readFile(artifact.diskPath || artifact.filePath);
        return serveBytesWithRange(req, res, bytes, 'application/octet-stream', artifact.sha256);
      }

      if (reqPath === '/local/updates/fetch' && (req.method === 'GET' || req.method === 'HEAD')) {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        const targetRaw = url.searchParams.get('url');
        check(targetRaw, 400, 'Missing url parameter');
        let targetUrl;
        try {
          targetUrl = new URL(targetRaw);
        } catch {
          throw new HttpError(400, 'Invalid update fetch URL');
        }
        check(targetUrl.protocol === 'https:', 400, 'Only HTTPS URLs are permitted');
        check(!targetUrl.username && !targetUrl.password, 400, 'URL credentials are not permitted');
        check(!isPrivateOrLoopbackHost(targetUrl.hostname), 403, 'Blocked private or loopback update target');
        return sendJson(res, 200, { ok: true, proxiedUrl: targetUrl.href });
      }

      // Computers / ExternalShell routing
      if (reqPath === '/local/computers' && req.method === 'GET') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        return sendJson(res, 200, {
          available: state.computers.length > 0,
          defaultMachineId: state.defaultMachineId,
          computers: state.computers,
        });
      }

      // Library files & attachments
      if (reqPath === '/local/files' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        const body = req.method === 'GET'
          ? { agentId: url.searchParams.get('agentId') }
          : await readJsonBody(req, 29 * 1024 * 1024);
        const agentId = body.agentId;
        check(typeof agentId === 'string' && /^[a-f0-9-]{1,128}$/i.test(agentId), 400, 'Invalid agentId');
        check(state.agents.has(agentId), 404, 'Bot 不存在');

        if (req.method === 'GET') {
          const items = [];
          let totalBytes = 0;
          for (const f of state.files.values()) {
            if (f.agentId === agentId) {
              totalBytes += f.bytes.length;
              items.push({
                name: f.name,
                path: f.name,
                sizeBytes: f.bytes.length,
                contentType: f.contentType,
                updatedAtMs: f.updatedAtMs,
                etag: f.etag,
              });
            }
          }
          return sendJson(res, 200, { files: items, totalBytes, canEdit: true });
        }

        if (req.method === 'POST') {
          const name = String(body.fileName || '');
          check(name && !name.includes('..') && !name.includes('/') && !name.includes('\\'), 400, 'Invalid fileName');
          const bytes = Buffer.from(String(body.base64 || ''), 'base64');
          check(bytes.length <= 20 * 1024 * 1024, 413, 'File exceeds 20 MiB limit');
          const rec = {
            agentId,
            name,
            contentType: body.contentType || 'application/octet-stream',
            bytes,
            updatedAtMs: Date.now(),
            etag: sha256Hex(bytes),
          };
          state.files.set(`${agentId}/${name}`, rec);
          return sendJson(res, 200, {
            name: rec.name,
            path: rec.name,
            sizeBytes: rec.bytes.length,
            contentType: rec.contentType,
            updatedAtMs: rec.updatedAtMs,
            etag: rec.etag,
          });
        }

        const delName = String(body.name || '');
        check(delName && !delName.includes('..'), 400, 'Invalid name');
        state.files.delete(`${agentId}/${delName}`);
        return sendJson(res, 200, { ok: true });
      }

      if (reqPath === '/local/files/content' && req.method === 'GET') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        const agentId = url.searchParams.get('agentId') || '';
        const name = url.searchParams.get('name') || '';
        check(state.agents.has(agentId), 404, 'Bot 不存在');
        const rec = state.files.get(`${agentId}/${name}`);
        check(rec, 404, 'File not found');
        const encodedName = encodeURIComponent(rec.name);
        res.writeHead(200, {
          'content-type': rec.contentType,
          'content-length': rec.bytes.length,
          'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodedName}`,
          'content-security-policy': "default-src 'none'; sandbox",
        });
        return res.end(rec.bytes);
      }

      if (reqPath === '/connect/attachment' && req.method === 'POST') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        const body = await readJsonBody(req);
        check(typeof body.url === 'string' && body.url.startsWith('file://'), 400, 'Invalid attachment file URL');
        let filePath;
        try {
          filePath = fileURLToPath(body.url);
        } catch {
          throw new HttpError(400, 'Malformed file URL');
        }
        const resolved = path.resolve(filePath);
        const agentsRoot = path.resolve(hostDataDir, 'agents');
        check(resolved.startsWith(`${agentsRoot}${path.sep}`), 403, 'Attachment outside allowed directory');
        const ext = path.extname(resolved).toLowerCase();
        const mimeMap = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
        };
        check(mimeMap[ext], 415, 'Unsupported attachment media type');
        check(existsSync(resolved), 404, 'Attachment not found');
        const bytes = await readFile(resolved);
        return sendJson(res, 200, {
          dataUrl: `data:${mimeMap[ext]};base64,${bytes.toString('base64')}`,
        });
      }

      // Notifications & Push
      if (reqPath === '/notifications' && req.method === 'GET') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        const after = Number(url.searchParams.get('after') || 0);
        const items = after > 0 ? state.notifications.filter((n) => Number(n.id) > after) : [...state.notifications];
        return sendJson(res, 200, { items });
      }

      if (reqPath === '/notifications/events' && req.method === 'GET') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        const foreground = ['ios', 'android'].includes(dev.platform) && req.headers['x-rokbot-foreground'] === '1';

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');

        const lastEventId = Number(req.headers['last-event-id'] || 0);
        if (lastEventId > 0) {
          for (const item of state.notifications) {
            if (Number(item.id) > lastEventId) {
              res.write(`id: ${item.id}\nevent: notification\ndata: ${JSON.stringify(item)}\n\n`);
            }
          }
        }

        const keepalive = setInterval(() => {
          if (!res.destroyed) res.write(': heartbeat\n\n');
        }, sseKeepaliveMs);
        keepalive.unref?.();

        const sub = { res, deviceId: dev.id, platform: dev.platform, foreground, keepalive };
        notifStreams.add(sub);
        req.on('close', () => {
          clearInterval(keepalive);
          notifStreams.delete(sub);
        });
        return;
      }

      if (reqPath === '/local/device' && (req.method === 'GET' || req.method === 'PUT')) {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        if (req.method === 'GET') {
          return sendJson(res, 200, publicDeviceView(dev));
        }
        const body = await readJsonBody(req);
        if (typeof body.name === 'string' && body.name.trim()) dev.name = body.name.trim();
        if (typeof body.bundleId === 'string') dev.bundleId = body.bundleId;
        if (typeof body.foreground === 'boolean') dev.push.foreground = body.foreground;
        if (typeof body.authorization === 'string') dev.push.authorization = body.authorization;
        if (typeof body.pushCapable === 'boolean') dev.push.capable = body.pushCapable;
        if (body.push && typeof body.push === 'object') {
          const p = body.push;
          const provider = p.provider || 'none';
          check(['apns', 'bark', 'ntfy', 'unifiedpush', 'webhook', 'fcm', 'none'].includes(provider), 400, 'Invalid push provider');
          const urlCandidate = p.webhookUrl || p.barkUrl || p.ntfyUrl || p.unifiedPushEndpoint;
          if (urlCandidate) {
            check(isPublicPushUrl(urlCandidate), 400, 'Push endpoint must be a public HTTP(S) URL');
          }
          dev.push = {
            ...dev.push,
            provider,
            enabled: provider !== 'none',
            configured: provider !== 'none',
            capable: true,
          };
        }
        return sendJson(res, 200, publicDeviceView(dev));
      }

      if (reqPath === '/local/device/push/test' && req.method === 'POST') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        checkRateLimit(`local-push-test:${dev.id}`, 10);
        const body = await readJsonBody(req);
        const result = dispatchPush(dev, {
          type: 'test',
          agentId: body.agentId || 'rokbot-test',
          title: 'RokBot Test Push',
          body: 'Test notification',
        }, { bypassForeground: body.bypassForeground !== false });
        return sendJson(res, 200, result);
      }

      // Voice & Connectors
      if (reqPath === '/local/voice/status' && req.method === 'GET') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        return sendJson(res, 200, { enabled: state.voiceEnabled });
      }

      if (reqPath === '/local/connectors' && (req.method === 'GET' || req.method === 'POST')) {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        check(req.method === 'GET', 403, 'Administrator operation');
        return sendJson(res, 200, {
          connectors: state.connectors.filter((c) => c.enabled),
          redirectUri: `${origin}/connectors/oauth/callback`,
        });
      }

      // Core Bot RPC & /events SSE
      if (reqPath === '/events' && req.method === 'GET') {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');
        const keepalive = setInterval(() => {
          if (!res.destroyed) res.write(': heartbeat\n\n');
        }, sseKeepaliveMs);
        keepalive.unref?.();
        const sub = { res, deviceId: dev.id, keepalive };
        eventsStreams.add(sub);
        req.on('close', () => {
          clearInterval(keepalive);
          eventsStreams.delete(sub);
        });
        return;
      }

      if (req.method === 'POST' && /^\/api\/[a-zA-Z][a-zA-Z0-9]*$/.test(reqPath)) {
        const dev = authenticateDevice(req, origin);
        actorKind = 'device';
        actorId = dev.id;
        const method = reqPath.slice('/api/'.length);
        check(!['importLocalSharedBot', 'localApplicationRpc'].includes(method), 403, 'Administrator operation');
        const body = await readJsonBody(req);

        if (method === 'listAgents') {
          return sendJson(res, 200, Array.from(state.agents.values()));
        }
        if (method === 'createAgent') {
          const id = body.id && /^[a-f0-9-]{1,128}$/i.test(body.id) ? body.id : randomUUID();
          const agent = { id, name: String(body.name || 'New Bot'), createdAt: new Date().toISOString() };
          state.agents.set(id, agent);
          return sendJson(res, 200, agent);
        }
        if (method === 'deleteAgents') {
          for (const id of body.ids ?? []) {
            state.agents.delete(id);
            for (const key of [...state.files.keys()]) {
              if (key.startsWith(`${id}/`)) state.files.delete(key);
            }
          }
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'sendPrompt') {
          const agentId = body.agentId || Array.from(state.agents.keys())[0];
          check(!state.needsModel && state.modelConfig, 409, 'Model is not configured yet');
          const runId = randomUUID();
          const activeModel = state.modelConfig.profiles[0]?.model || 'gpt-4o';
          const text = typeof body.prompt === 'string' ? body.prompt : 'Hello';
          queueMicrotask(() => {
            emitSseEvent('agent-chunk', { agentId, runId, model: activeModel, delta: 'OK: ' });
            emitSseEvent('agent-chunk', { agentId, runId, model: activeModel, delta: text });
            emitSseEvent('agent-done', { agentId, runId, model: activeModel, reply: `OK: ${text}` });
          });
          return sendJson(res, 200, { ok: true, runId, agentId, model: activeModel });
        }
        if (method === 'localExec') {
          let targetMachine = body.computerId;
          if (!targetMachine) {
            if (state.defaultMachineId) {
              targetMachine = state.defaultMachineId;
            } else if (state.computers.length === 1) {
              targetMachine = state.computers[0].id;
            } else {
              throw new HttpError(409, 'Multiple machines connected without ROKBOT_DEFAULT_MACHINE_ID');
            }
          }
          const computer = state.computers.find((c) => c.id === targetMachine && c.connected);
          check(computer, 404, `Execution machine not available: ${targetMachine}`);
          return sendJson(res, 200, {
            ok: true,
            machineId: computer.id,
            command: body.command || 'echo ok',
            exitCode: 0,
            stdout: `executed on ${computer.id}\n`,
          });
        }
        if (method === 'getHostSettings') {
          return sendJson(res, 200, {
            brand: 'RokBot',
            hostVersion: '2bb5e41',
            defaultMachineId: state.defaultMachineId,
            needsModel: state.needsModel,
          });
        }
        return sendJson(res, 200, { ok: true, method });
      }

      throw new HttpError(404, '页面不存在');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : (err?.message || 'Internal Server Error');
      recordAudit(req.method, reqPath, actorKind, actorId, status, message);
      if (!res.headersSent) {
        return sendJson(res, status, { error: message });
      }
      if (!res.destroyed) res.destroy();
    }
  });

  server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const harness = {
    async resetState(opts = {}) {
      for (const s of eventsStreams) { clearInterval(s.keepalive); s.res.destroy(); }
      eventsStreams.clear();
      for (const s of notifStreams) { clearInterval(s.keepalive); s.res.destroy(); }
      notifStreams.clear();

      state.initialized = opts.initialized ?? true;
      state.adminPassword = opts.adminPassword || initialAdminPassword;
      state.adminPasswordHash = hashPassword(state.adminPassword);
      state.setupKey = mintToken(24);
      state.adminSessions.clear();
      state.pairingKeys = [];
      state.devices = [];
      state.rateLimits.clear();
      state.auditLog = [];
      state.federationRole = 'primary';
      state.defaultMachineId = opts.defaultMachineId ?? (options.defaultMachineId ?? 'machine-local-1');
      state.computers = [
        { id: 'machine-local-1', label: 'Local Desktop', connected: true, platform: 'darwin', capabilities: ['exec', 'gui'] },
      ];
      state.webClientAvailable = true;
      state.needsModel = Boolean(opts.needsModel);
      state.modelAuthPolicy = {
        allowEnv: opts.allowEnv ?? opts.allowDeviceModelConfigEnv ?? initialAllowEnv,
        allowDeviceModelConfig: true,
        allowGuestModelConfig: false,
      };
      state.modelReloadBehavior = { mode: 'immediate', delayMs: 40 };
      state.modelReload = { revision: 0, status: 'none', error: null, updatedAt: null };
      state.upstreamCatalog = [
        { id: 'gpt-4o', name: 'gpt-4o', provider: 'openai' },
        { id: 'claude-3-7-sonnet', name: 'claude-3-7-sonnet', provider: 'anthropic' },
      ];
      state.upstreamCatalogFault = null;
      state.modelTestFault = null;
      state.agents.clear();
      state.files.clear();
      state.notifications = [];
      state.nextNotifId = 1;
      state.pushSink = null;
      state.pushHistory = { sent: [], suppressed: [] };
      state.artifacts.clear();
      state.releases = { android: [], ios: [], macos: [], windows: [] };
      state.iosOtaToken = mintToken(24);
      seedDefaultAgentAndModel();
    },
    setNeedsModel(flag) {
      state.needsModel = Boolean(flag);
      if (state.needsModel) {
        state.modelConfig = null;
      } else if (!state.modelConfig) {
        seedDefaultAgentAndModel();
      }
    },
    getAuditLog() {
      return state.auditLog.map((e) => ({ ...e }));
    },
    seedUpstreamCatalog(models, fault = null) {
      if (Array.isArray(models)) state.upstreamCatalog = models;
      state.upstreamCatalogFault = fault;
    },
    setModelTestFault(fault) {
      state.modelTestFault = fault;
    },
    setPushSink(fn) {
      state.pushSink = fn;
    },
    getPushHistory() {
      return {
        sent: [...state.pushHistory.sent],
        suppressed: [...state.pushHistory.suppressed],
      };
    },
    setModelAuthPolicy(policy) {
      Object.assign(state.modelAuthPolicy, policy);
    },
    setModelReloadBehavior(behavior) {
      Object.assign(state.modelReloadBehavior, behavior);
    },
    setFederationRole(role) {
      state.federationRole = role;
    },
    setDefaultMachineId(id) {
      state.defaultMachineId = id;
    },
    setComputers(list) {
      state.computers = Array.isArray(list) ? list : [];
    },
    emitEvent(channel, payload) {
      emitSseEvent(channel, payload);
    },
    publishNotification(input) {
      return publishNotificationItem(input);
    },
    async seedAttachment(agentId, filename, bytes) {
      const attDir = path.join(hostDataDir, 'agents', agentId, 'attachments');
      await mkdir(attDir, { recursive: true });
      const target = path.join(attDir, path.basename(filename));
      await writeFile(target, bytes);
      return `file://${target}`;
    },
    resetRateLimits() {
      state.rateLimits.clear();
    },
    setWebClientAvailable(available, rendererVersion = '1.2.3') {
      state.webClientAvailable = Boolean(available);
      state.webRendererVersion = rendererVersion;
    },
    getSetupKey() {
      return state.setupKey;
    },
    getPublicKeyInfo() {
      return {
        publicKeyPem: signingKeys.publicKeyPem,
        publicKeySpkiBase64: signingKeys.publicKeySpkiBase64,
      };
    },
    getIosOtaToken() {
      return state.iosOtaToken;
    },
  };

  async function close() {
    for (const s of eventsStreams) { clearInterval(s.keepalive); s.res.destroy(); }
    eventsStreams.clear();
    for (const s of notifStreams) { clearInterval(s.keepalive); s.res.destroy(); }
    notifStreams.clear();
    for (const sock of activeSockets) {
      sock.destroy();
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    server,
    baseUrl,
    adminPassword: initialAdminPassword,
    setupKey: state.setupKey,
    dataDir,
    publicKeyPem: signingKeys.publicKeyPem,
    publicKeySpkiBase64: signingKeys.publicKeySpkiBase64,
    harness,
    close,
    stop: close,
  };
}

export const startReferenceHost = createHarnessServer;

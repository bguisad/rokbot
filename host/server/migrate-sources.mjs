// Readers that turn a Grok Bot data folder, a packed copy of it, or prompt-export JSON files into a
// rokbot.migrate v1 document. Every result goes through normalizeBundle, so a physical migration
// and a prompt export share one validation path.
//
// The Grok Bot desktop client keeps a local cache of the account's Bot roster, sidebar sections and
// recent conversation replicas in `sand-client-persistence/<base32 key>.blob` (older RokBot desktop
// builds use one `local-client-persistence.json` map with the same keys). Memories, skills, routine
// prompts and library files live on the Grok Bot service, so they can only arrive through the
// prompt export. Only the allowlisted cache files below are ever opened: credential stores,
// cookies, webhook keys and browser storage are recognised by name and never read.
import { open, readdir, readFile, stat, lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { check } from './security.mjs';
import { MIGRATE_SCHEMA, MIGRATE_VERSION, normalizeBundle, mergeBundles } from './migrate-schema.mjs';
import { openZip } from './migrate-zip.mjs';

const BLOB = /(?:^|\/)sand-client-persistence\/([a-z2-7]+)\.blob$/;
const LEGACY = /(?:^|\/)local-client-persistence\.json$/;
const NEVER_READ = /(?:^|\/)(?:sand-secrets\.json|connection\.json|Cookies(?:-journal)?|Login Data(?:-journal)?|Web Data(?:-journal)?|box-secrets[^/]*|automation-webhook-keys\/[^/]*|(?:Local|Session) Storage\/.*|IndexedDB\/.*|Trust Tokens(?:-journal)?|[^/]*\.(?:key|pem|p8|p12|keychain))$/i;
const WEBHOOK_KEY = /(?:^|\/)automation-webhook-keys\/[^/]+\.bin$/;
const SECRETS_FILE = /(?:^|\/)sand-secrets\.json$/;
const BUNDLE_JSON = /\.json$/i;
const IGNORED_JSON = /(?:^|\/)(?:Preferences|Local State|gateway-descriptor\.json|desktop-status\.json|window-state\.json|sand-statsig-bootstrap\.json|settings\.json|updater-prefs\.json|box-secrets-push-state\.v1\.json|package(?:-lock)?\.json|node_modules\/.*|link-[a-z-]+-cache\/.*|sentry\/.*|plugin-logo-cache\/.*)$/i;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export function decodeBlobKey(name) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0; const bytes = [];
  for (const char of name) {
    const index = alphabet.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return null; }
}

const SLICE = /^sand\.client\.slice\.account\.([^.]+)\.(.+)$/;
function unwrap(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && 'value' in value ? value.value : null;
}
const string = value => typeof value === 'string' ? value : '';

/** Collects account slices keyed by `<slice name>` from blob files or a legacy persistence map. */
async function readSlices(paths, readPath, warnings) {
  const slices = [];
  for (const path of paths) {
    const blob = BLOB.exec(path);
    if (blob) {
      const key = decodeBlobKey(blob[1]);
      if (!key) continue;
      const match = SLICE.exec(key);
      if (!match || !/^(roster\.last-roster|sidebar\.last-sections|transcript\.replicas\.[0-9a-f-]{36}|mcp\.connect-logos)$/.test(match[2])) continue;
      try { slices.push({ account: match[1], slice: match[2], value: unwrap((await readPath(path, MAX_CACHE_BYTES)).toString('utf8')) }); }
      catch (error) { warnings.push(`无法读取缓存文件（${match[2].split('.')[0]}）：${error.message}`); }
    } else if (LEGACY.test(path)) {
      let map;
      try { map = JSON.parse((await readPath(path, MAX_CACHE_BYTES)).toString('utf8')); }
      catch (error) { warnings.push(`无法读取 local-client-persistence.json：${error.message}`); continue; }
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      for (const [key, raw] of Object.entries(map)) {
        const match = SLICE.exec(key);
        if (match && /^(roster\.last-roster|sidebar\.last-sections|transcript\.replicas\.[0-9a-f-]{36}|mcp\.connect-logos)$/.test(match[2]))
          slices.push({ account: match[1], slice: match[2], value: unwrap(raw) });
      }
    }
  }
  return slices;
}

function chatFromReplica(entries, botName) {
  const chat = [];
  for (const entry of Array.isArray(entries) ? [...entries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) : []) {
    if (!entry || typeof entry !== 'object') continue;
    const at = Number.isFinite(entry.timestampMs) ? entry.timestampMs : undefined;
    if (entry.kind === 'message' && typeof entry.content === 'string' && entry.content.trim()) {
      const fromAgent = entry.fromAgent?.name, toAgent = entry.toAgent?.name;
      if (entry.role === 'user') chat.push({ role: 'user', text: entry.content, at, author: fromAgent ? string(fromAgent) : '我' });
      else chat.push({ role: 'assistant', text: toAgent ? `（发给 ${string(toAgent)}）${entry.content}` : entry.content, at, author: botName });
    } else if (entry.kind === 'send-message' && entry.message?.type === 'text' && typeof entry.message.content === 'string' && entry.message.content.trim()) {
      chat.push({ role: 'assistant', text: entry.message.content, at, author: botName });
    } else if (entry.kind === 'user-attachment' && typeof entry.file_name === 'string') {
      chat.push({ role: 'user', text: `（附件：${entry.file_name}）`, at, author: '我' });
    }
  }
  return chat;
}

function routinesFromReplica(entries) {
  const byId = new Map();
  for (const entry of Array.isArray(entries) ? [...entries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) : []) {
    const event = entry?.event;
    if (entry?.kind !== 'event' || event?.type !== 'automation-changed' || typeof event.automationId !== 'string') continue;
    if (event.action === 'deleted') byId.delete(event.automationId);
    else if (typeof event.automationName === 'string' && event.automationName.trim()) byId.set(event.automationId, event.automationName);
  }
  return [...new Set(byId.values())];
}

function secretsFromReplica(entries) {
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const request = entry?.message?.type === 'secret-request' ? entry.message.secretRequest : null;
    // Only the label and target name of a requested credential are kept, never a value.
    if (request && typeof request.label === 'string')
      result.push({ name: request.label, ...(typeof request.target === 'string' ? { description: `用于 ${request.target}` } : {}) });
  }
  return result;
}

/** Builds a rokbot.migrate v1 document from the cache slices of a Grok Bot data folder. */
export function documentFromSlices(slices, { webhookKeys = 0, hasAccountSecrets = false } = {}) {
  const bots = new Map(), replicas = new Map(), sections = [], apps = new Set();
  for (const { slice, value } of slices) {
    if (!value) continue;
    if (slice === 'roster.last-roster') {
      for (const row of Array.isArray(value.rows) ? value.rows : []) {
        if (!row || typeof row.id !== 'string' || typeof row.name !== 'string' || !row.name.trim() || row.isGroup) continue;
        const previous = bots.get(row.id);
        if (!previous || (row.updatedAt ?? 0) >= (previous.updatedAt ?? 0)) bots.set(row.id, row);
      }
    } else if (slice.startsWith('transcript.replicas.')) {
      const id = slice.slice('transcript.replicas.'.length);
      const entries = Array.isArray(value.entries) ? value.entries : [];
      const previous = replicas.get(id);
      if (!previous || entries.length > previous.length) replicas.set(id, entries);
    } else if (slice === 'sidebar.last-sections') {
      for (const section of Array.isArray(value.sections) ? value.sections : [])
        if (section && typeof section.name === 'string' && Array.isArray(section.agentIds)) sections.push(section);
    } else if (slice === 'mcp.connect-logos') {
      for (const logo of Array.isArray(value.logos) ? value.logos : []) if (typeof logo?.name === 'string') apps.add(logo.name);
    }
  }
  const secrets = [...apps].sort().map(name => ({ name: `应用连接：${name}`, description: '在 RokBot「应用」中重新连接并授权' }));
  if (webhookKeys) secrets.push({ name: `例程 Webhook 密钥（${webhookKeys} 个）`, description: '迁移后例程使用 RokBot 新生成的 Webhook 地址和密钥' });
  if (hasAccountSecrets) secrets.push({ name: 'Grok Bot 账号登录状态', description: '账号令牌不迁移；RokBot 使用自己的配对设备凭据' });
  const groups = new Map();
  for (const section of sections) {
    const members = section.agentIds.map(id => bots.get(id)?.name).filter(Boolean);
    if (members.length && !groups.has(section.name)) groups.set(section.name, members);
  }
  return {
    schema: MIGRATE_SCHEMA, version: MIGRATE_VERSION,
    source: { product: 'Grok Bot', exportedAt: Date.now(), exportedBy: '本机数据目录' },
    bots: [...bots.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).map(row => {
      const entries = replicas.get(row.id) ?? [];
      return {
        sourceId: row.id, name: row.name, title: string(row.title), description: string(row.description),
        avatar: { ...(row.avatarShape ? { shape: row.avatarShape } : {}), ...(row.avatarColor ? { color: row.avatarColor } : {}) },
        settings: {
          ...(typeof row.notificationsEnabled === 'boolean' ? { notificationsEnabled: row.notificationsEnabled } : {}),
          ...(typeof row.notifyOnUpdatesEnabled === 'boolean' ? { notifyOnUpdates: row.notifyOnUpdatesEnabled } : {}),
          ...(typeof row.isHiddenFromSidebar === 'boolean' ? { hiddenFromSidebar: row.isHiddenFromSidebar || row.isRemovedFromSidebar === true } : {}),
          ...(typeof row.voiceId === 'string' && row.voiceId ? { voiceId: row.voiceId } : {}),
          ...(typeof row.voiceSpeed === 'number' ? { voiceSpeed: row.voiceSpeed } : {}),
          ...(typeof row.voiceLanguage === 'string' && row.voiceLanguage ? { voiceLanguage: row.voiceLanguage } : {}),
        },
        chat: chatFromReplica(entries, row.name), detectedRoutines: routinesFromReplica(entries), secrets: secretsFromReplica(entries),
      };
    }),
    secrets, groups: [...groups].map(([name, members]) => ({ name, bots: members })),
  };
}

/**
 * Reads a file listing (a directory or ZIP) and returns the normalized bundle. `readPath` reads
 * one allowlisted entry; it is never called for credential stores.
 */
export async function bundleFromListing(paths, readPath, { label = '数据目录' } = {}) {
  const warnings = [], bundles = [];
  const safe = paths.filter(path => !NEVER_READ.test(path));
  const cachePaths = safe.filter(path => BLOB.test(path) || LEGACY.test(path));
  if (cachePaths.length) {
    const slices = await readSlices(cachePaths, readPath, warnings);
    const document = documentFromSlices(slices, {
      webhookKeys: paths.filter(path => WEBHOOK_KEY.test(path)).length,
      hasAccountSecrets: paths.some(path => SECRETS_FILE.test(path)),
    });
    if (document.bots.length) bundles.push(normalizeBundle(document, { origin: 'grokbot-data' }));
  }
  for (const path of safe.filter(path => BUNDLE_JSON.test(path) && !IGNORED_JSON.test(path) && !LEGACY.test(path) && path.split('/').length <= 4)) {
    let head;
    try { head = await readPath(path, MAX_BUNDLE_BYTES); } catch (error) { warnings.push(`无法读取 ${path}：${error.message}`); continue; }
    if (!head.subarray(0, 4096).toString('utf8').includes(MIGRATE_SCHEMA)) continue;
    let value;
    try { value = JSON.parse(head.toString('utf8')); } catch { warnings.push(`${path} 不是有效的 JSON，已跳过`); continue; }
    bundles.push(normalizeBundle(value, { origin: 'prompt-export' }));
  }
  check(bundles.length, 400, `${label}中没有找到 Grok Bot 数据或 RokBot 迁移文件`);
  const bundle = mergeBundles(bundles);
  return { ...bundle, warnings: [...new Set([...warnings, ...bundle.warnings])] };
}

/** Lists a directory without following symbolic links, skipping caches the importer never needs. */
export async function listDirectory(root, { maxEntries = 200_000 } = {}) {
  const paths = [], skip = /^(?:Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|Crashpad|blob_storage|Shared Dictionary|SharedStorage|VideoDecodeStats|shared_proto_db|v8-code-cache|computer-helper|notification-sounds|local-exec|Partitions|node_modules|\.git)$/;
  async function walk(directory, depth) {
    if (depth > 4 || paths.length >= maxEntries) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { if (!skip.test(entry.name)) await walk(full, depth + 1); }
      else if (entry.isFile()) paths.push(relative(root, full).split(sep).join('/'));
    }
  }
  await walk(root, 0);
  return paths;
}

export async function bundleFromDirectory(root) {
  const info = await lstat(root);
  check(info.isDirectory(), 400, '请选择 Grok Bot 数据目录');
  const paths = await listDirectory(root);
  return bundleFromListing(paths, async (path, maxBytes) => {
    check(!NEVER_READ.test(path), 403, '该文件不会被读取');
    const full = join(root, ...path.split('/'));
    const current = await lstat(full);
    check(current.isFile() && current.size <= maxBytes, 413, '文件过大');
    return readFile(full);
  }, { label: '所选目录' });
}

export async function bundleFromZip(filename) {
  const zip = await openZip(filename);
  try {
    const files = new Map();
    for (const entry of zip.entries) if (!entry.directory && !entry.name.split('/').some(part => part === '..' || part === '__MACOSX')) files.set(entry.name, entry);
    return await bundleFromListing([...files.keys()], (path, maxBytes) => {
      check(!NEVER_READ.test(path), 403, '该文件不会被读取');
      return zip.read(files.get(path), { maxBytes });
    }, { label: '迁移包' });
  } finally { await zip.close(); }
}

/** A single uploaded file: ZIP (data folder or several exports) or one JSON export. */
export async function bundleFromUpload(filename) {
  const info = await stat(filename);
  check(info.size > 0, 400, '上传的文件是空的');
  const head = Buffer.alloc(4);
  const file = await open(filename, 'r');
  try { await file.read(head, 0, 4, 0); } finally { await file.close(); }
  if (head.readUInt32LE(0) === 0x04034b50 || head.readUInt32LE(0) === 0x06054b50) return bundleFromZip(filename);
  check(info.size <= MAX_BUNDLE_BYTES, 413, '迁移 JSON 文件超过 512 MiB，请改为按 Bot 分开导出');
  let value;
  try { value = JSON.parse((await readFile(filename, 'utf8')).replace(/^﻿/, '')); }
  catch { check(false, 400, '上传的文件既不是 ZIP，也不是有效的 JSON'); }
  return normalizeBundle(value, { origin: 'prompt-export' });
}

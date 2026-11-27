// RokBot migration bundle schema (rokbot.migrate v1).
//
// Everything that arrives through a migration is untrusted data: a Grok Bot data folder, a ZIP the
// user uploaded, or a JSON file that a Bot wrote after reading the migration prompt. This module is
// the only place that turns such input into the internal bundle. It keeps an explicit allowlist of
// fields, bounds every list and string, rejects prototype keys and unsafe file names, redacts
// credential-looking text, and never interprets any field as an instruction. Routines always leave
// here paused.
import { createHash } from 'node:crypto';
import { check } from './security.mjs';

export const MIGRATE_SCHEMA = 'rokbot.migrate';
export const MIGRATE_VERSION = 1;

export const LIMITS = Object.freeze({
  bots: 500, memory: 5000, memoryText: 20_000, skills: 300, skillText: 200_000, routines: 300, routinePrompt: 30_000,
  files: 100, fileBytes: 20 * 1024 * 1024, chat: 50_000, chatText: 50_000, userMemory: 5000, globalSkills: 1000,
  secrets: 500, groups: 200, depth: 14, name: 100, title: 200, description: 30_000,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TOP_KEYS = new Set(['schema', 'version', 'source', 'bots', 'userMemory', 'skills', 'secrets', 'groups', 'notes']);
const BOT_KEYS = new Set(['sourceId', 'name', 'title', 'description', 'instructions', 'avatar', 'settings', 'memory', 'skills',
  'routines', 'files', 'chat', 'detectedRoutines', 'secrets']);
const SETTING_KEYS = ['notificationsEnabled', 'notifyOnUpdates', 'hiddenFromSidebar', 'voiceId', 'voiceSpeed', 'voiceLanguage', 'model'];
const ROUTINE_KEYS = new Set(['name', 'prompt', 'content', 'description', 'schedule', 'trigger', 'timezone', 'timeZone', 'enabled', 'isEnabled']);
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|xai|rk|pk)-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bapikey_[a-f0-9_]{40,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{24,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{24,}=*/g,
];
export const REDACTED = '[已移除疑似密钥]';

export const sha = value => createHash('sha256').update(value).digest('hex');

/** Throws on prototype keys or excessive nesting before any field is read. */
export function assertSafeTree(value, path = '$', depth = 0) {
  check(depth <= LIMITS.depth, 400, `迁移数据嵌套过深：${path}`);
  if (Array.isArray(value)) { value.forEach((item, index) => assertSafeTree(item, `${path}[${index}]`, depth + 1)); return; }
  if (!value || typeof value !== 'object') return;
  for (const key of Reflect.ownKeys(value)) {
    check(typeof key === 'string' && !FORBIDDEN_KEYS.has(key), 400, `迁移数据包含不允许的字段：${path}.${String(key)}`);
    assertSafeTree(value[key], `${path}.${key}`, depth + 1);
  }
}

/** Replaces credential-looking substrings; returns the cleaned text and how many were removed. */
export function redactSecrets(text) {
  let count = 0, result = text;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, () => { count++; return REDACTED; });
  return { text: result, count };
}

class Context {
  constructor() { this.warnings = []; this.redactions = 0; this.ignored = new Set(); }
  warn(message) { if (this.warnings.length < 200 && !this.warnings.includes(message)) this.warnings.push(message); }
  ignore(path, keys, allowed) { for (const key of keys) if (!allowed.has(key)) this.ignored.add(`${path}.${key}`); }
}

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
function clean(value) {
  // Control characters (other than tab and newlines) and lone surrogates never reach stored state.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').toWellFormed().trim();
}
function text(ctx, value, max, label, { required = false, oneLine = false } = {}) {
  if (value == null || value === '') { check(!required, 400, `缺少${label}`); return ''; }
  if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
  check(typeof value === 'string', 400, `${label}格式无效`);
  let result = clean(value);
  if (oneLine) result = result.replace(/[\r\n\t]+/g, ' ');
  if (result.length > max) { ctx.warn(`${label}超过 ${max} 字，已截断`); result = result.slice(0, max); }
  const redacted = redactSecrets(result);
  if (redacted.count) { ctx.redactions += redacted.count; result = redacted.text; }
  check(!required || result, 400, `缺少${label}`);
  return result;
}
function list(ctx, value, max, label) {
  if (value == null) return [];
  check(Array.isArray(value), 400, `${label}需要是数组`);
  if (value.length > max) { ctx.warn(`${label}超过 ${max} 项，只保留前 ${max} 项`); return value.slice(0, max); }
  return value;
}
function day(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = new Date(value).toISOString();
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match && Number.isFinite(Date.parse(`${match[1]}T00:00:00Z`)) ? match[1] : undefined;
}
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value < 1e12 ? value * 1000 : value);
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return undefined;
}

/** A name a file can safely be stored under in a Bot library: no paths, no control characters. */
export function safeFileName(value) {
  check(typeof value === 'string', 400, '文件名称无效');
  const name = value.normalize('NFC').trim();
  check(name && Buffer.byteLength(name) <= 200 && !/[\\/\u0000-\u001f\u007f]/.test(name) && !['.', '..'].includes(name) &&
    !/^\.+$/.test(name) && !/\.[a-f0-9]{16}\.tmp$/.test(name), 400, `文件名称不安全：${name.slice(0, 80)}`);
  return name;
}

const CRON_FIELD = /^(?:\*|\?|[0-9A-Za-z]+(?:-[0-9A-Za-z]+)?(?:\/\d+)?|\*\/\d+)(?:,(?:\*|[0-9A-Za-z]+(?:-[0-9A-Za-z]+)?(?:\/\d+)?|\*\/\d+))*$/;
export function validCron(value) {
  if (typeof value !== 'string') return false;
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && value.length <= 120 && fields.every(field => CRON_FIELD.test(field));
}

function memoryItem(ctx, item, label) {
  if (typeof item === 'string') item = { content: item };
  check(isObject(item), 400, `${label}格式无效`);
  ctx.ignore(label, Object.keys(item), new Set(['kind', 'tier', 'content', 'text', 'createdAt', 'date']));
  const content = text(ctx, item.content ?? item.text, LIMITS.memoryText, label);
  if (!content) return null;
  const kind = ['profile', 'core'].includes(item.kind ?? item.tier) ? 'profile' : 'log';
  const createdAt = day(item.createdAt ?? item.date);
  return { kind, content, ...(createdAt ? { createdAt } : {}) };
}
function skillItem(ctx, item, label) {
  check(isObject(item), 400, `${label}格式无效`);
  ctx.ignore(label, Object.keys(item), new Set(['name', 'description', 'content', 'body', 'markdown', 'triggers']));
  const name = text(ctx, item.name, LIMITS.name, `${label}名称`, { required: true, oneLine: true });
  const content = text(ctx, item.content ?? item.body ?? item.markdown, LIMITS.skillText, `${label}内容`);
  if (!content) { ctx.warn(`技能「${name}」没有内容，已跳过`); return null; }
  const description = text(ctx, item.description, 2000, `${label}说明`, { oneLine: true }) || name;
  return { name, description, content };
}
function routineItem(ctx, item, label) {
  check(isObject(item), 400, `${label}格式无效`);
  ctx.ignore(label, Object.keys(item), ROUTINE_KEYS);
  const name = text(ctx, item.name, LIMITS.name, `${label}名称`, { required: true, oneLine: true });
  const prompt = text(ctx, item.prompt ?? item.content, LIMITS.routinePrompt, `${label}内容`);
  if (!prompt) { ctx.warn(`例程「${name}」没有 prompt，已跳过`); return null; }
  const trigger = isObject(item.trigger) ? item.trigger : {};
  if (isObject(item.trigger)) ctx.ignore(`${label}.trigger`, Object.keys(trigger), new Set(['type', 'schedule', 'cron', 'description']));
  const rawSchedule = typeof (trigger.schedule ?? trigger.cron ?? item.schedule) === 'string' ? (trigger.schedule ?? trigger.cron ?? item.schedule).trim() : '';
  const declared = ['cron', 'schedule', 'webhook', 'manual'].includes(trigger.type) ? trigger.type : rawSchedule ? 'cron' : 'manual';
  let type = declared === 'schedule' ? 'cron' : declared, schedule;
  const notes = [];
  if (type === 'cron') {
    if (validCron(rawSchedule)) schedule = rawSchedule;
    else { type = 'manual'; if (rawSchedule) notes.push(`原触发时间：${text(ctx, rawSchedule, 200, '触发时间', { oneLine: true })}`); }
  }
  const timeZone = typeof (item.timeZone ?? item.timezone) === 'string' && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(item.timeZone ?? item.timezone)
    ? (item.timeZone ?? item.timezone) : undefined;
  const description = [text(ctx, item.description, 2000, `${label}说明`, { oneLine: true }), ...notes].filter(Boolean).join(' · ');
  if (item.enabled === true || item.isEnabled === true) ctx.warn('导入的例程一律暂停，需要在 RokBot 中手动启用');
  return { name, prompt, trigger: type, ...(schedule ? { schedule } : {}), ...(timeZone ? { timeZone } : {}),
    ...(description ? { description } : {}), enabled: false };
}
const IMAGE_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff] };
export function imageType(bytes) {
  for (const [type, magic] of Object.entries(IMAGE_TYPES)) if (magic.every((byte, index) => bytes[index] === byte)) return type;
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
function base64Bytes(value, max, label) {
  check(typeof value === 'string', 400, `${label}需要 Base64`);
  const compact = value.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
  check(compact.length <= Math.ceil(max / 3) * 4 + 4, 413, `${label}超过 ${Math.round(max / 1024 / 1024)} MiB`);
  check(/^[A-Za-z0-9+/]*={0,2}$/.test(compact) && compact.length % 4 === 0, 400, `${label}不是有效的 Base64`);
  return Buffer.from(compact, 'base64');
}
function avatarItem(ctx, value, label) {
  if (!isObject(value)) return undefined;
  ctx.ignore(label, Object.keys(value), new Set(['shape', 'color', 'image', 'imageBase64', 'mimeType']));
  const avatar = {};
  for (const key of ['shape', 'color']) if (typeof value[key] === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value[key])) avatar[key] = value[key];
  const image = value.imageBase64 ?? value.image;
  if (typeof image === 'string' && image) {
    try {
      const bytes = base64Bytes(image, 5 * 1024 * 1024, '头像');
      const type = imageType(bytes);
      if (type) avatar.image = { contentType: type, base64: bytes.toString('base64') };
      else ctx.warn('头像不是 PNG、JPEG 或 WebP 图片，已忽略');
    } catch (error) { ctx.warn(`头像已忽略：${error.message}`); }
  }
  return Object.keys(avatar).length ? avatar : undefined;
}
function fileItem(ctx, item, label) {
  check(isObject(item), 400, `${label}格式无效`);
  ctx.ignore(label, Object.keys(item), new Set(['name', 'contentType', 'mimeType', 'text', 'content', 'base64', 'encoding']));
  const name = safeFileName(item.name);
  let bytes, contentType = typeof (item.contentType ?? item.mimeType) === 'string' ? (item.contentType ?? item.mimeType).trim().toLowerCase() : '';
  if (typeof item.base64 === 'string' || item.encoding === 'base64') {
    // A broken attachment is skipped on its own; it does not discard the rest of the export.
    try { bytes = base64Bytes(item.base64 ?? item.content, LIMITS.fileBytes, `文件「${name}」`); }
    catch (error) { ctx.warn(`${error.message}，已跳过`); return null; }
  }
  else {
    const body = item.text ?? item.content;
    check(typeof body === 'string', 400, `文件「${name}」没有内容`);
    const cleaned = redactSecrets(body.toWellFormed());
    if (cleaned.count) ctx.redactions += cleaned.count;
    bytes = Buffer.from(cleaned.text, 'utf8');
    check(bytes.length <= LIMITS.fileBytes, 413, `文件「${name}」超过 20 MiB`);
    if (!contentType) contentType = name.endsWith('.md') ? 'text/markdown' : name.endsWith('.json') ? 'application/json' : 'text/plain';
  }
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) contentType = imageType(bytes) ?? 'application/octet-stream';
  // Executable payloads never become library files, whatever name or type they claim.
  check(!/\.(?:exe|dll|so|dylib|bat|cmd|com|scr|msi|ps1|sh|app|jar|apk)$/i.test(name), 400, `不允许导入可执行文件：${name}`);
  return { name, contentType, base64: bytes.toString('base64'), sizeBytes: bytes.length, sha256: sha(bytes) };
}
function chatItem(ctx, item, label) {
  if (!isObject(item)) return null;
  const role = ['user', 'assistant', 'bot', 'system', 'agent'].includes(item.role) ? (item.role === 'user' ? 'user' : 'assistant') : null;
  if (!role) return null;
  const body = text(ctx, item.text ?? item.content, LIMITS.chatText, label);
  if (!body) return null;
  const at = timestamp(item.at ?? item.timestamp ?? item.createdAt);
  const author = text(ctx, item.author, LIMITS.name, `${label}作者`, { oneLine: true });
  return { role, text: body, ...(at ? { at } : {}), ...(author ? { author } : {}) };
}
function secretItem(ctx, item, label) {
  if (typeof item === 'string') item = { name: item };
  if (!isObject(item)) return null;
  // Only the label of a credential is ever kept. Any value field is dropped, never stored.
  if (['value', 'secret', 'token', 'apiKey', 'password', 'key'].some(key => key in item)) ctx.warn('密钥项中的值已丢弃，RokBot 只保存需要重新填写的名称');
  const name = text(ctx, item.name, 200, `${label}名称`, { oneLine: true });
  if (!name) return null;
  const description = text(ctx, item.description, 1000, `${label}说明`, { oneLine: true });
  const usedBy = text(ctx, item.usedBy, 200, `${label}用途`, { oneLine: true });
  return { name, ...(description ? { description } : {}), ...(usedBy ? { usedBy } : {}) };
}
const compact = values => values.filter(Boolean);
function dedupe(values, key) {
  const seen = new Set();
  return values.filter(value => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; });
}

function botItem(ctx, item, index) {
  const label = `bots[${index}]`;
  check(isObject(item), 400, `${label}格式无效`);
  ctx.ignore(label, Object.keys(item), BOT_KEYS);
  const name = text(ctx, item.name, LIMITS.name, `Bot 名称（${label}）`, { required: true, oneLine: true });
  const sourceId = typeof item.sourceId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(item.sourceId) ? item.sourceId : undefined;
  const settings = {};
  if (isObject(item.settings)) {
    ctx.ignore(`${label}.settings`, Object.keys(item.settings), new Set(SETTING_KEYS));
    for (const key of ['notificationsEnabled', 'notifyOnUpdates', 'hiddenFromSidebar'])
      if (typeof item.settings[key] === 'boolean') settings[key] = item.settings[key];
    if (typeof item.settings.voiceSpeed === 'number' && item.settings.voiceSpeed > 0 && item.settings.voiceSpeed <= 4) settings.voiceSpeed = item.settings.voiceSpeed;
    for (const key of ['voiceId', 'voiceLanguage', 'model']) {
      const value = text(ctx, item.settings[key], 120, `${label}.settings.${key}`, { oneLine: true });
      if (value) settings[key] = value;
    }
  }
  const memory = dedupe(compact(list(ctx, item.memory, LIMITS.memory, `${label}.memory`).map((entry, at) => memoryItem(ctx, entry, `${label}.memory[${at}]`))), entry => entry.content);
  const skills = dedupe(compact(list(ctx, item.skills, LIMITS.skills, `${label}.skills`).map((entry, at) => skillItem(ctx, entry, `${label}.skills[${at}]`))), entry => entry.name);
  const routines = dedupe(compact(list(ctx, item.routines, LIMITS.routines, `${label}.routines`).map((entry, at) => routineItem(ctx, entry, `${label}.routines[${at}]`))), entry => `${entry.name}\n${entry.prompt}`);
  const files = dedupe(compact(list(ctx, item.files, LIMITS.files, `${label}.files`).map((entry, at) => fileItem(ctx, entry, `${label}.files[${at}]`))), entry => entry.name);
  const chat = compact(list(ctx, item.chat, LIMITS.chat, `${label}.chat`).map((entry, at) => chatItem(ctx, entry, `${label}.chat[${at}]`)));
  const detectedRoutines = dedupe(compact(list(ctx, item.detectedRoutines, LIMITS.routines, `${label}.detectedRoutines`)
    .map(entry => text(ctx, typeof entry === 'string' ? entry : entry?.name, LIMITS.name, '例程名称', { oneLine: true }))), entry => entry);
  const secrets = compact(list(ctx, item.secrets, LIMITS.secrets, `${label}.secrets`).map((entry, at) => secretItem(ctx, entry, `${label}.secrets[${at}]`)));
  const avatar = avatarItem(ctx, item.avatar, `${label}.avatar`);
  return {
    key: sourceId ? `id:${sourceId}` : `name:${name.toLowerCase()}`, ...(sourceId ? { sourceId } : {}), name,
    title: text(ctx, item.title, LIMITS.title, `${label}.title`, { oneLine: true }),
    description: text(ctx, item.description ?? item.instructions, LIMITS.description, `${label}.description`),
    ...(avatar ? { avatar } : {}), settings, memory, skills, routines, files, chat, detectedRoutines, secrets,
  };
}

/**
 * Validates a rokbot.migrate v1 document and returns the internal bundle plus warnings.
 * Structural problems throw a 400; unknown fields are dropped and reported, credential-looking
 * text is redacted.
 */
export function normalizeBundle(input, { origin = 'bundle' } = {}) {
  check(isObject(input), 400, '迁移文件需要是 JSON 对象');
  assertSafeTree(input);
  check(input.schema === MIGRATE_SCHEMA, 400, `不是 RokBot 迁移文件（schema 应为 ${MIGRATE_SCHEMA}）`);
  check(input.version === MIGRATE_VERSION, 400, `不支持的迁移文件版本：${String(input.version).slice(0, 20)}（当前支持 ${MIGRATE_VERSION}）`);
  const ctx = new Context();
  ctx.ignore('$', Object.keys(input), TOP_KEYS);
  const source = isObject(input.source) ? input.source : {};
  const bots = list(ctx, input.bots, LIMITS.bots, 'bots').map((item, index) => botItem(ctx, item, index));
  // Two entries for one Bot (for example one export per Bot) merge into one.
  const merged = mergeBots(bots);
  const userMemory = dedupe(compact(list(ctx, input.userMemory, LIMITS.userMemory, 'userMemory').map((entry, at) => memoryItem(ctx, entry, `userMemory[${at}]`))), entry => entry.content);
  const skills = dedupe(compact(list(ctx, input.skills, LIMITS.globalSkills, 'skills').map((entry, at) => skillItem(ctx, entry, `skills[${at}]`))), entry => entry.name);
  const secrets = dedupe(compact(list(ctx, input.secrets, LIMITS.secrets, 'secrets').map((entry, at) => secretItem(ctx, entry, `secrets[${at}]`))), entry => entry.name);
  const groups = compact(list(ctx, input.groups, LIMITS.groups, 'groups').map((entry, at) => {
    if (!isObject(entry)) return null;
    const name = text(ctx, entry.name, LIMITS.name, `groups[${at}].name`, { oneLine: true });
    const members = list(ctx, entry.bots ?? entry.members, 50, `groups[${at}].bots`).filter(value => typeof value === 'string').map(value => clean(value).slice(0, LIMITS.name));
    return name ? { name, bots: members } : null;
  }));
  if (ctx.ignored.size) ctx.warn(`已忽略 ${ctx.ignored.size} 个未定义字段：${[...ctx.ignored].slice(0, 8).join('、')}${ctx.ignored.size > 8 ? ' 等' : ''}`);
  if (ctx.redactions) ctx.warn(`已移除 ${ctx.redactions} 处疑似密钥或令牌`);
  return {
    schema: MIGRATE_SCHEMA, version: MIGRATE_VERSION,
    source: { origin, product: text(ctx, source.product, 80, 'source.product', { oneLine: true }) || 'Grok Bot',
      exportedAt: timestamp(source.exportedAt) ?? null, exportedBy: text(ctx, source.exportedBy, LIMITS.name, 'source.exportedBy', { oneLine: true }) },
    bots: merged, userMemory, skills, secrets, groups, warnings: ctx.warnings,
  };
}

export function mergeBots(bots) {
  const byKey = new Map();
  for (const bot of bots) {
    const previous = byKey.get(bot.key);
    if (!previous) { byKey.set(bot.key, bot); continue; }
    const union = (a, b, key) => dedupe([...a, ...b], key);
    byKey.set(bot.key, { ...previous, ...Object.fromEntries(Object.entries(bot).filter(([, value]) => value !== '' && value !== undefined)),
      settings: { ...previous.settings, ...bot.settings },
      memory: union(previous.memory, bot.memory, entry => entry.content),
      skills: union(previous.skills, bot.skills, entry => entry.name),
      routines: union(previous.routines, bot.routines, entry => `${entry.name}\n${entry.prompt}`),
      files: union(previous.files, bot.files, entry => entry.name),
      chat: previous.chat.length >= bot.chat.length ? previous.chat : bot.chat,
      detectedRoutines: union(previous.detectedRoutines, bot.detectedRoutines, entry => entry),
      secrets: union(previous.secrets, bot.secrets, entry => entry.name) });
  }
  return [...byKey.values()];
}

/** Combines bundles from several files (one per Bot, or a data folder plus prompt exports). */
export function mergeBundles(bundles) {
  check(bundles.length > 0, 400, '没有找到可迁移的数据');
  if (bundles.length === 1) return bundles[0];
  const unique = (values, key) => dedupe(values, key);
  return {
    schema: MIGRATE_SCHEMA, version: MIGRATE_VERSION,
    source: { ...bundles[0].source, origin: [...new Set(bundles.map(bundle => bundle.source.origin))].join('+') },
    bots: mergeBots(bundles.flatMap(bundle => bundle.bots)),
    userMemory: unique(bundles.flatMap(bundle => bundle.userMemory), entry => entry.content),
    skills: unique(bundles.flatMap(bundle => bundle.skills), entry => entry.name),
    secrets: unique(bundles.flatMap(bundle => bundle.secrets), entry => entry.name),
    groups: unique(bundles.flatMap(bundle => bundle.groups), entry => entry.name),
    warnings: [...new Set(bundles.flatMap(bundle => bundle.warnings))].slice(0, 200),
  };
}

/** Counts shown in previews and reports. Never includes content. */
export function bundleCounts(bundle) {
  const sum = key => bundle.bots.reduce((total, bot) => total + bot[key].length, 0);
  return { bots: bundle.bots.length, memory: sum('memory'), skills: sum('skills') + bundle.skills.length, botSkills: sum('skills'), globalSkills: bundle.skills.length,
    routines: sum('routines'), detectedRoutines: sum('detectedRoutines'), files: sum('files'), chatMessages: sum('chat'),
    chatBots: bundle.bots.filter(bot => bot.chat.length).length, userMemory: bundle.userMemory.length,
    secrets: bundle.secrets.length + sum('secrets'), groups: bundle.groups.length,
    avatars: bundle.bots.filter(bot => bot.avatar).length };
}

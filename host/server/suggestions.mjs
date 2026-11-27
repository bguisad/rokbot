// Lazy, cached, low-latency input-box suggestions and synced settings/quick-phrases store
// for Web, Desktop, and Android clients.
// Routes through scenarioRoutes.suggestions (or falls back to defaultRoute with low-latency
// effort clamping). Never falls back to hardcoded static preset phrases.
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createModelSession } from '../runtime/model-session.mjs';
import { isConfiguredModelRouting, modelRouteForScenario } from '../runtime/model-routing.mjs';
import { reasoningOptions } from '../runtime/model-policy.mjs';
import { recordUsage } from '../runtime/usage-ledger.mjs';
import { JsonStore } from './storage.mjs';
import { check } from './security.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_CACHE = 200;
const MAX_SUGGESTIONS = 4;
const MAX_ITEM_CHARS = 72;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 500;
const MAX_QUICK_PHRASES = 50;
const MAX_PHRASE_CHARS = 120;
const PHRASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function normalizePhraseText(value) {
  check(typeof value === 'string', 400, '常用语内容无效');
  check(!value.includes('\0'), 400, '常用语内容无效');
  const cleaned = value.replace(/\s+/g, ' ').trim();
  check(cleaned.length >= 1, 400, '常用语不能为空');
  check([...cleaned].length <= MAX_PHRASE_CHARS, 400, `常用语最多 ${MAX_PHRASE_CHARS} 个字符`);
  return cleaned;
}

function generatePhraseId() {
  return `p_${randomBytes(6).toString('hex')}`;
}

function normalizeQuickPhrases(list) {
  check(Array.isArray(list), 400, '常用语列表格式无效');
  check(list.length <= MAX_QUICK_PHRASES, 400, `最多保存 ${MAX_QUICK_PHRASES} 条常用语`);
  const seenIds = new Set();
  const seenTexts = new Set();
  const result = [];
  for (const raw of list) {
    const rawText = typeof raw === 'string' ? raw : raw?.text;
    const text = normalizePhraseText(rawText);
    const textKey = text.toLowerCase();
    check(!seenTexts.has(textKey), 400, '常用语不能重复');
    seenTexts.add(textKey);

    let id = typeof raw === 'object' && raw !== null && typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || !PHRASE_ID_RE.test(id) || seenIds.has(id)) {
      do { id = generatePhraseId(); } while (seenIds.has(id));
    }
    seenIds.add(id);
    result.push({ id, text });
  }
  return result;
}

function sanitizeStoredState(raw) {
  const enabled = raw?.enabled !== false;
  const aiEnabled = raw?.aiEnabled !== false;
  const quickPhrases = [];
  const seenIds = new Set();
  const seenTexts = new Set();
  if (Array.isArray(raw?.quickPhrases)) {
    for (const item of raw.quickPhrases) {
      if (quickPhrases.length >= MAX_QUICK_PHRASES) break;
      const rawText = typeof item === 'string' ? item : item?.text;
      if (typeof rawText !== 'string' || rawText.includes('\0')) continue;
      const text = rawText.replace(/\s+/g, ' ').trim();
      if (!text || [...text].length > MAX_PHRASE_CHARS) continue;
      const key = text.toLowerCase();
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      let id = typeof item === 'object' && item !== null && typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || !PHRASE_ID_RE.test(id) || seenIds.has(id)) {
        do { id = generatePhraseId(); } while (seenIds.has(id));
      }
      seenIds.add(id);
      quickPhrases.push({ id, text });
    }
  }
  const updatedAt = typeof raw?.updatedAt === 'string' ? raw.updatedAt : null;
  return { version: 1, enabled, aiEnabled, quickPhrases, updatedAt };
}

export class SuggestionsSettings {
  constructor(directory) {
    this.store = new JsonStore(join(directory, 'suggestions-settings.json'), {
      version: 1,
      enabled: true,
      aiEnabled: true,
      quickPhrases: [],
      updatedAt: null,
    });
  }

  async load() {
    await this.store.load();
    const clean = sanitizeStoredState(this.store.value);
    Object.assign(this.store.value, clean);
    return this;
  }

  current() {
    const clean = sanitizeStoredState(this.store.value);
    return {
      enabled: clean.enabled,
      aiEnabled: clean.aiEnabled,
      quickPhrases: clean.quickPhrases.map(item => ({ id: item.id, text: item.text })),
      updatedAt: clean.updatedAt,
    };
  }

  listPhrases() {
    const cur = this.current();
    return { quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }

  async updateSettings(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '输入建议配置格式无效');
    const next = {};
    if (Object.hasOwn(input, 'enabled')) {
      check(typeof input.enabled === 'boolean', 400, 'enabled 必须为布尔值');
      next.enabled = input.enabled;
    }
    if (Object.hasOwn(input, 'aiEnabled')) {
      check(typeof input.aiEnabled === 'boolean', 400, 'aiEnabled 必须为布尔值');
      next.aiEnabled = input.aiEnabled;
    }
    if (Object.hasOwn(input, 'quickPhrases')) {
      next.quickPhrases = normalizeQuickPhrases(input.quickPhrases);
    }
    await this.store.mutate(state => {
      Object.assign(state, sanitizeStoredState(state), next, { updatedAt: new Date().toISOString() });
    });
    return this.current();
  }

  async addPhrase(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '常用语请求格式无效');
    const text = normalizePhraseText(input.text);
    let created = null;
    await this.store.mutate(state => {
      const clean = sanitizeStoredState(state);
      check(clean.quickPhrases.length < MAX_QUICK_PHRASES, 400, `最多保存 ${MAX_QUICK_PHRASES} 条常用语`);
      const lower = text.toLowerCase();
      check(!clean.quickPhrases.some(item => item.text.toLowerCase() === lower), 400, '该常用语已存在');
      const used = new Set(clean.quickPhrases.map(item => item.id));
      let id;
      do { id = generatePhraseId(); } while (used.has(id));
      created = { id, text };
      clean.quickPhrases.push(created);
      clean.updatedAt = new Date().toISOString();
      Object.assign(state, clean);
    });
    const cur = this.current();
    return { phrase: created, quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }

  async updatePhrase(id, input) {
    check(typeof id === 'string' && PHRASE_ID_RE.test(id), 400, '常用语 ID 无效');
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '常用语请求格式无效');
    const text = normalizePhraseText(input.text);
    let updated = null;
    await this.store.mutate(state => {
      const clean = sanitizeStoredState(state);
      const index = clean.quickPhrases.findIndex(item => item.id === id);
      check(index >= 0, 404, '常用语不存在');
      const lower = text.toLowerCase();
      check(
        !clean.quickPhrases.some((item, i) => i !== index && item.text.toLowerCase() === lower),
        400,
        '该常用语已存在',
      );
      updated = { id, text };
      clean.quickPhrases[index] = updated;
      clean.updatedAt = new Date().toISOString();
      Object.assign(state, clean);
    });
    const cur = this.current();
    return { phrase: updated, quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }

  async deletePhrase(id) {
    check(typeof id === 'string' && PHRASE_ID_RE.test(id), 400, '常用语 ID 无效');
    await this.store.mutate(state => {
      const clean = sanitizeStoredState(state);
      const next = clean.quickPhrases.filter(item => item.id !== id);
      check(next.length !== clean.quickPhrases.length, 404, '常用语不存在');
      clean.quickPhrases = next;
      clean.updatedAt = new Date().toISOString();
      Object.assign(state, clean);
    });
    const cur = this.current();
    return { ok: true, quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }

  async reorderPhrases(input) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '排序参数无效');
    check(Array.isArray(input.ids), 400, '排序 ID 列表无效');
    await this.store.mutate(state => {
      const clean = sanitizeStoredState(state);
      const byId = new Map(clean.quickPhrases.map(item => [item.id, item]));
      check(input.ids.length === clean.quickPhrases.length, 400, '排序 ID 列表与现有常用语数量不匹配');
      const seen = new Set();
      const reordered = [];
      for (const rawId of input.ids) {
        check(typeof rawId === 'string' && byId.has(rawId) && !seen.has(rawId), 400, '排序 ID 列表包含无效或重复项');
        seen.add(rawId);
        reordered.push(byId.get(rawId));
      }
      clean.quickPhrases = reordered;
      clean.updatedAt = new Date().toISOString();
      Object.assign(state, clean);
    });
    const cur = this.current();
    return { quickPhrases: cur.quickPhrases, updatedAt: cur.updatedAt };
  }
}

export function detectSuggestionLanguage(locale = '', messages = []) {
  const sample = messages
    .slice(-3)
    .map(item => item?.text ?? '')
    .join(' ');
  const cjkCount = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinCount = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (cjkCount >= 2 && cjkCount * 3 >= latinCount) return 'zh';
  if (latinCount >= 8 && cjkCount === 0) return 'en';
  if (typeof locale === 'string' && /^zh\b/i.test(locale.trim())) return 'zh';
  if (typeof locale === 'string' && locale.trim()) return 'en';
  return cjkCount > 0 ? 'zh' : 'en';
}

function extractText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.prompt === 'string') return value.prompt.trim();
    if (typeof value.body === 'string') return value.body.trim();
    if (value.content !== undefined) return extractText(value.content);
    if (value.message !== undefined) return extractText(value.message);
  }
  return '';
}

function normalizeRole(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.role === 'user' || entry.role === 'assistant') return entry.role;
  const kind = String(entry.kind ?? entry.type ?? '').toLowerCase();
  if (kind === 'user' || kind === 'user-message' || kind === 'prompt' || kind === 'user_message') return 'user';
  if (kind === 'assistant' || kind === 'assistant-message' || kind === 'send-message' || kind === 'agent-message' || kind === 'bot-message') {
    return 'assistant';
  }
  return null;
}

export function extractRecentMessages(entries, limit = MAX_CONTEXT_MESSAGES) {
  if (!Array.isArray(entries)) return [];
  const normalized = [];
  for (const entry of entries) {
    const role = normalizeRole(entry);
    if (!role) continue;
    const rawText = extractText(entry.text ?? entry.message ?? entry.content ?? entry.prompt);
    const text = rawText.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    normalized.push({
      id: typeof entry.id === 'string' ? entry.id : '',
      role,
      text: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}...` : text,
    });
  }
  return normalized.slice(-limit);
}

export function parseSuggestionResponse(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  let text = rawText.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1].trim();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }

  let items = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.suggestions)) {
    items = parsed.suggestions;
  } else {
    items = text
      .split(/\r?\n/)
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
      .filter(Boolean);
  }

  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const cleaned = item
      .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 2 || cleaned.length > MAX_ITEM_CHARS) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= MAX_SUGGESTIONS) break;
  }
  return result;
}

function buildSuggestionMessages(recentMessages, lang) {
  const isZh = lang === 'zh';
  const systemPrompt = isZh
    ? '你是聊天输入建议助手。根据最近的对话内容，生成3到4条用户下一步最可能想发出的简短回复或追问。' +
      '要求：1) 必须是用户视角（第一人称或直接提问/指令）；2) 每条尽量简短自然（6到22个字，不超过32个字）；' +
      '3) 互相有区分度，贴合当前话题；4) 仅输出一个 JSON 字符串数组，不要包含任何解释、序号、Markdown 代码块或表情符号。'
    : 'You generate quick reply suggestions for a chat composer. Based on the recent conversation, suggest 3 to 4 short, natural next messages the user might send. ' +
      'Requirements: 1) Written from the user perspective; 2) Concise (under 10 words, max 60 chars); ' +
      '3) Distinct and directly relevant to the latest assistant reply; 4) Output ONLY a valid JSON array of strings with no explanation, numbering, markdown, or emojis.';

  const transcript = recentMessages
    .map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`)
    .join('\n');
  const userPrompt = isZh
    ? `最近对话：\n${transcript}\n\n请只返回 JSON 字符串数组：`
    : `Recent conversation:\n${transcript}\n\nReturn only the JSON array of strings:`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

function historySignature(recentMessages, explicitLastEntryId) {
  if (typeof explicitLastEntryId === 'string' && explicitLastEntryId.trim()) {
    return explicitLastEntryId.trim().slice(0, 128);
  }
  const last = recentMessages.at(-1);
  if (!last) return 'empty';
  if (last.id) return last.id;
  return createHash('sha256')
    .update(`${last.role}:${last.text}`)
    .digest('hex')
    .slice(0, 16);
}

function optimizeRouteForLatency(route) {
  if (!route || route.routeSource === 'scenario') return route;
  if (route.effort && route.effort !== 'default') return route;
  const supported = Array.isArray(route.efforts) ? route.efforts : [];
  for (const preferred of ['none', 'minimal', 'low']) {
    if (supported.includes(preferred)) {
      return { ...route, effort: preferred };
    }
  }
  return route;
}

function buildPayload({ enabled, aiEnabled, quickPhrases, aiSuggestions, source, cached, lang }) {
  const phrases = quickPhrases.map(item => ({ id: item.id, text: item.text }));
  const phraseSet = new Set(phrases.map(item => item.text.toLowerCase()));
  const filteredAi = [];
  const seenAi = new Set();
  for (const text of aiSuggestions) {
    if (typeof text !== 'string') continue;
    const cleaned = text.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (phraseSet.has(key) || seenAi.has(key)) continue;
    seenAi.add(key);
    filteredAi.push(cleaned);
  }
  const items = [
    ...phrases.map(item => ({ type: 'phrase', id: item.id, text: item.text })),
    ...filteredAi.map(text => ({ type: 'ai', text })),
  ];
  return {
    enabled,
    aiEnabled,
    quickPhrases: phrases,
    aiSuggestions: filteredAi,
    suggestions: items.map(item => item.text),
    items,
    source,
    cached,
    lang,
  };
}

export class SuggestionsService {
  constructor({
    models,
    settings,
    hostCall,
    dataDir,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ttlMs = DEFAULT_TTL_MS,
    maxCache = DEFAULT_MAX_CACHE,
    now = () => Date.now(),
  } = {}) {
    this.models = models;
    this.settings = settings;
    this.hostCall = hostCall;
    this.usageDirectory = dataDir ? join(dataDir, 'usage') : undefined;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.maxCache = maxCache;
    this.now = now;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  #getCached(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (this.now() - entry.at >= this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  #setCached(key, value) {
    this.cache.delete(key);
    this.cache.set(key, { ...value, at: this.now() });
    while (this.cache.size > this.maxCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  async #loadRecentMessages(agentId, providedMessages) {
    if (agentId && typeof this.hostCall === 'function') {
      try {
        const tail = await this.hostCall('getAgentTranscriptTail', { id: agentId, limit: 12 });
        const entries = Array.isArray(tail?.entries) ? tail.entries
          : Array.isArray(tail?.transcript?.entries) ? tail.transcript.entries
          : Array.isArray(tail) ? tail : [];
        const fromHost = extractRecentMessages(entries);
        if (fromHost.length > 0) return fromHost;
      } catch (error) {
        if (!Array.isArray(providedMessages) || providedMessages.length === 0) {
          console.warn(`[suggestions] getAgentTranscriptTail failed for ${agentId}: ${error?.message ?? error}`);
        }
      }
    }
    if (Array.isArray(providedMessages) && providedMessages.length > 0) {
      return extractRecentMessages(providedMessages);
    }
    return [];
  }

  async generate({ agentId = '', lastEntryId = '', locale = '', recentMessages, force = false } = {}) {
    const cfg = this.settings?.current?.() ?? { enabled: true, aiEnabled: true, quickPhrases: [] };
    const initialLang = detectSuggestionLanguage(locale, []);

    // Master switch off: return empty immediately without touching transcript or model.
    if (!cfg.enabled) {
      return buildPayload({
        enabled: false,
        aiEnabled: cfg.aiEnabled,
        quickPhrases: [],
        aiSuggestions: [],
        source: 'disabled',
        cached: false,
        lang: initialLang,
      });
    }

    // AI suggestions switch off: return custom quick phrases only.
    if (!cfg.aiEnabled) {
      return buildPayload({
        enabled: true,
        aiEnabled: false,
        quickPhrases: cfg.quickPhrases,
        aiSuggestions: [],
        source: 'phrases-only',
        cached: false,
        lang: initialLang,
      });
    }

    const history = await this.#loadRecentMessages(agentId, recentMessages);
    const hasHistory = history.length > 0;
    const lang = detectSuggestionLanguage(locale, history);

    // Empty chat: no LLM call and no hardcoded presets — custom quick phrases only.
    if (!hasHistory) {
      return buildPayload({
        enabled: true,
        aiEnabled: true,
        quickPhrases: cfg.quickPhrases,
        aiSuggestions: [],
        source: 'empty',
        cached: false,
        lang,
      });
    }

    let routing = null;
    try {
      const current = await this.models?.currentOrEmpty?.();
      routing = current?.routing ?? null;
    } catch {
      routing = null;
    }
    if (!routing || !isConfiguredModelRouting(routing)) {
      return buildPayload({
        enabled: true,
        aiEnabled: true,
        quickPhrases: cfg.quickPhrases,
        aiSuggestions: [],
        source: 'model-unavailable',
        cached: false,
        lang,
      });
    }

    let route;
    try {
      route = optimizeRouteForLatency(modelRouteForScenario(routing, 'suggestions', { direct: true }));
    } catch {
      return buildPayload({
        enabled: true,
        aiEnabled: true,
        quickPhrases: cfg.quickPhrases,
        aiSuggestions: [],
        source: 'model-unavailable',
        cached: false,
        lang,
      });
    }

    const sig = historySignature(history, lastEntryId);
    const cacheKey = `${agentId || '_'}:${sig}:${lang}:${route.profileId}:${route.model}:${route.effort}`;
    if (!force) {
      const hit = this.#getCached(cacheKey);
      if (hit) {
        return buildPayload({
          enabled: true,
          aiEnabled: true,
          quickPhrases: cfg.quickPhrases,
          aiSuggestions: hit.aiSuggestions,
          source: hit.source,
          cached: true,
          lang,
        });
      }
      const existing = this.inFlight.get(cacheKey);
      if (existing) {
        const result = await existing;
        return buildPayload({
          enabled: true,
          aiEnabled: true,
          quickPhrases: cfg.quickPhrases,
          aiSuggestions: result.aiSuggestions,
          source: result.source,
          cached: true,
          lang: result.lang,
        });
      }
    }

    const task = this.#generateFromModel(route, history, lang, cacheKey);
    this.inFlight.set(cacheKey, task);
    try {
      const outcome = await task;
      return buildPayload({
        enabled: true,
        aiEnabled: true,
        quickPhrases: cfg.quickPhrases,
        aiSuggestions: outcome.aiSuggestions,
        source: outcome.source,
        cached: false,
        lang: outcome.lang,
      });
    } finally {
      if (this.inFlight.get(cacheKey) === task) this.inFlight.delete(cacheKey);
    }
  }

  async #generateFromModel(route, history, lang, cacheKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Suggestions request timed out')), this.timeoutMs);
    timer.unref?.();
    try {
      const session = createModelSession({
        ...route,
        fetchImpl: this.fetchImpl ?? globalThis.fetch,
        selectRequest: async ({ signal } = {}) => {
          signal?.throwIfAborted();
          return { ...route, requestOptions: reasoningOptions(route.model, route.effort), fallbacks: [] };
        },
        onUsage: async ({ raw, model, requestId }) => {
          if (!this.usageDirectory) return;
          await recordUsage(this.usageDirectory, { raw, model, kind: 'suggestions', requestId }).catch(() => {});
        },
      });
      const messages = buildSuggestionMessages(history, lang);
      const stream = session
        .getExecutor(messages)
        .stream({ signal: controller.signal }, 'composer-suggestions', [], { maxTokens: 256 });
      let output = '';
      for await (const part of stream.fullStream) {
        if (part?.type === 'text-delta') {
          const chunk = part.textDelta ?? part.text ?? part.delta ?? '';
          if (typeof chunk === 'string') output += chunk;
        }
      }
      await stream.response.catch(() => {});
      const parsed = parseSuggestionResponse(output);
      if (parsed.length === 0) {
        console.warn(`[suggestions] empty or unparseable model response (${route.model})`);
        return { aiSuggestions: [], source: 'model-error', lang };
      }
      const entry = { aiSuggestions: parsed, source: 'model', lang };
      this.#setCached(cacheKey, entry);
      return entry;
    } catch (error) {
      console.warn(`[suggestions] model call failed (${route.model}): ${error?.message ?? error}`);
      return { aiSuggestions: [], source: 'model-error', lang };
    } finally {
      clearTimeout(timer);
    }
  }
}

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

// A suggestion answer is keyed by Bot + the last transcript entry, so it never goes stale while
// that entry is the last one: keep it for a day in memory and a week on disk (one per Bot).
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_PERSIST_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_CACHE = 200;
const MAX_PERSISTED_AGENTS = 200;
const MAX_SUGGESTIONS = 3;
// Short prompt, short answer: 3 items of at most ~22 characters fit in well under 120 tokens.
const SUGGESTION_MAX_TOKENS = 120;
const PROMPT_CONTEXT_MESSAGES = 4;
const PROMPT_LAST_MESSAGE_CHARS = 360;
const PROMPT_EARLIER_MESSAGE_CHARS = 140;
// A Bot's reply notification arrives as the turn ends; give the transcript a moment to settle.
const REPLY_PREFETCH_DELAY_MS = 800;
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ITEM_CHARS = 72;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 500;
const MAX_QUICK_PHRASES = 50;
const MAX_PHRASE_CHARS = 120;
const PHRASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Inline completion (ghost text) limits: short, fast, single line.
const DEFAULT_COMPLETION_TIMEOUT_MS = 8_000;
const COMPLETION_MAX_TOKENS = 48;
const COMPLETION_MIN_CHARS = 2;
const COMPLETION_MAX_INPUT_CHARS = 2_000;
const COMPLETION_PROMPT_CHARS = 600;
const MAX_COMPLETION_CHARS = 80;

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
  const completionEnabled = raw?.completionEnabled !== false;
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
  return { version: 1, enabled, aiEnabled, completionEnabled, quickPhrases, updatedAt };
}

export class SuggestionsSettings {
  constructor(directory) {
    this.store = new JsonStore(join(directory, 'suggestions-settings.json'), {
      version: 1,
      enabled: true,
      aiEnabled: true,
      completionEnabled: true,
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
      completionEnabled: clean.completionEnabled,
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
    if (Object.hasOwn(input, 'completionEnabled')) {
      check(typeof input.completionEnabled === 'boolean', 400, 'completionEnabled 必须为布尔值');
      next.completionEnabled = input.completionEnabled;
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

function clipMiddle(text, max) {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (max - head)).join('')}`;
}

/** The prompt only needs the gist: the last few messages, the latest one kept longest. */
export function compactSuggestionHistory(recentMessages) {
  const recent = recentMessages.slice(-PROMPT_CONTEXT_MESSAGES);
  return recent.map((item, index) => ({
    ...item,
    text: clipMiddle(item.text, index === recent.length - 1 ? PROMPT_LAST_MESSAGE_CHARS : PROMPT_EARLIER_MESSAGE_CHARS),
  }));
}

function buildSuggestionMessages(recentMessages, lang) {
  const isZh = lang === 'zh';
  const systemPrompt = isZh
    ? '你是聊天输入建议助手。根据最近的对话，给出3条用户下一步最可能发出的简短回复或追问。' +
      '要求：用户视角；每条6到20个字；互相有区分度并紧扣最后一条回复；只输出一个 JSON 字符串数组，不要解释、序号、Markdown 或表情符号。'
    : 'Suggest 3 short next messages the user might send in this chat. ' +
      'Rules: user perspective; under 8 words each; distinct and tied to the latest assistant reply; output ONLY a JSON array of strings, no explanation, numbering, markdown, or emojis.';

  const transcript = compactSuggestionHistory(recentMessages)
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

// Suggestions need no reasoning: unless an effort was chosen explicitly (for the scenario or the
// default route), use the lowest one the model supports.
function optimizeRouteForLatency(route) {
  if (!route) return route;
  if (route.effort && route.effort !== 'default' && route.effort !== 'auto') return route;
  const supported = Array.isArray(route.efforts) ? route.efforts : [];
  for (const preferred of ['none', 'minimal', 'low']) {
    if (supported.includes(preferred)) {
      return { ...route, effort: preferred };
    }
  }
  return route;
}

function buildPayload({ enabled, aiEnabled, quickPhrases, aiSuggestions, source, cached, lang, agentId = '', historyId = '' }) {
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
    if (filteredAi.length >= MAX_SUGGESTIONS) break;
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
    // Which conversation the answer belongs to: clients drop an answer for another Bot.
    agentId,
    historyId,
  };
}

export function countChars(text) {
  return [...String(text ?? '')].length;
}

function buildCompletionMessages(recentMessages, draft, lang) {
  const isZh = lang === 'zh';
  const systemPrompt = isZh
    ? '你是聊天输入框的行内补全助手。用户正在输入一条消息，请根据最近对话与用户已输入的内容，预测这句话最可能的后半句。'
      + '要求：1) 只输出紧接在已输入内容之后的续写部分，不要重复已输入的内容；2) 只写一句、不换行，尽量简短（不超过 20 个字）；'
      + '3) 不要加引号、解释、Markdown 或表情符号；4) 没有把握时输出空内容。'
    : 'You are an inline autocomplete for a chat composer. The user is typing a message. Using the recent conversation and the partial text, '
      + 'predict the most likely rest of the sentence. Rules: 1) Output ONLY the continuation that comes right after the partial text; never repeat it. '
      + '2) One short line (at most 8 words), no line breaks. 3) No quotes, explanations, markdown, or emojis. '
      + '4) Start with a space when the continuation begins a new word. 5) If unsure, output nothing.';
  const transcript = recentMessages
    .map(item => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`)
    .join('\n');
  const userPrompt = isZh
    ? `最近对话：\n${transcript}\n\n用户已输入：${draft}\n\n只输出续写部分：`
    : `Recent conversation:\n${transcript}\n\nPartial message: ${draft}\n\nContinuation only:`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * Turns raw model output into the suffix shown after the caret: first line only, without quotes,
 * without a repeated copy of the draft, capped in length. Returns '' when nothing usable remains.
 */
export function parseCompletionResponse(rawText, draft = '') {
  if (typeof rawText !== 'string') return '';
  let text = rawText.replace(/\r/g, '');
  const fenced = /```(?:\w+)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1];
  text = text.replace(/^\s*\n+/, '').split('\n')[0] ?? '';
  let leadingSpace = /^[ \t]/.test(text);
  text = text.trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const typed = String(draft ?? '');
  const typedTrim = typed.trim();
  // The model sometimes repeats the whole draft (or its tail) before the continuation.
  if (typedTrim && text.toLowerCase().startsWith(typedTrim.toLowerCase())) {
    text = text.slice(typedTrim.length);
  } else {
    const tail = typedTrim.slice(-24);
    for (let k = Math.min(tail.length, text.length); k >= 4; k--) {
      if (text.toLowerCase().startsWith(tail.slice(-k).toLowerCase())) { text = text.slice(k); break; }
    }
  }
  if (/^\s/.test(text)) leadingSpace = true;
  const startsWord = /^[A-Za-z0-9]/.test(text.trimStart());
  text = text.trim();
  if (!text) return '';
  if ([...text].length > MAX_COMPLETION_CHARS) text = [...text].slice(0, MAX_COMPLETION_CHARS).join('').trimEnd();
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) return '';
  // Latin continuations of a finished word need a separating space; CJK never does.
  const endsWithSpace = /\s$/.test(typed);
  const endsLatin = /[A-Za-z0-9,.;:!?]$/.test(typed);
  if (!endsWithSpace && endsLatin && startsWord && (leadingSpace || /[,.;:!?]$/.test(typed))) text = ` ${text}`;
  return text;
}

export class SuggestionsService {
  constructor({
    models,
    settings,
    hostCall,
    dataDir,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    completionTimeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
    ttlMs = DEFAULT_TTL_MS,
    persistTtlMs = DEFAULT_PERSIST_TTL_MS,
    maxCache = DEFAULT_MAX_CACHE,
    replyPrefetchDelayMs = REPLY_PREFETCH_DELAY_MS,
    now = () => Date.now(),
  } = {}) {
    this.models = models;
    this.settings = settings;
    this.hostCall = hostCall;
    this.usageDirectory = dataDir ? join(dataDir, 'usage') : undefined;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.completionTimeoutMs = completionTimeoutMs;
    this.ttlMs = ttlMs;
    this.persistTtlMs = persistTtlMs;
    this.maxCache = maxCache;
    this.replyPrefetchDelayMs = replyPrefetchDelayMs;
    this.now = now;
    this.cache = new Map();
    this.inFlight = new Map();
    this.prefetching = new Map();
    this.prefetchTimers = new Map();
    this.completionCache = new Map();
    this.completionInFlight = new Map();
    // The latest answer per Bot survives a Host restart: reopening a chat shows it at once.
    this.persisted = dataDir ? new JsonStore(join(dataDir, 'suggestions-cache.json'), { version: 1, agents: {} }) : null;
  }

  async load() {
    if (!this.persisted) return this;
    try {
      await this.persisted.load();
      if (!this.persisted.value.agents || typeof this.persisted.value.agents !== 'object') this.persisted.value.agents = {};
    } catch (error) {
      console.warn(`[suggestions] cache file ignored: ${error?.message ?? error}`);
      this.persisted.value = { version: 1, agents: {} };
    }
    return this;
  }

  close() {
    for (const timer of this.prefetchTimers.values()) clearTimeout(timer);
    this.prefetchTimers.clear();
  }

  #getCached(key, agentId) {
    const entry = this.cache.get(key);
    if (entry) {
      if (this.now() - entry.at >= this.ttlMs) {
        this.cache.delete(key);
      } else {
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry;
      }
    }
    const stored = agentId ? this.persisted?.value?.agents?.[agentId] : null;
    if (stored && stored.key === key && Array.isArray(stored.aiSuggestions) && this.now() - stored.at < this.persistTtlMs) {
      const warm = { aiSuggestions: stored.aiSuggestions.filter(item => typeof item === 'string').slice(0, MAX_SUGGESTIONS),
        source: 'model', lang: stored.lang, at: stored.at };
      this.cache.set(key, warm);
      return warm;
    }
    return null;
  }

  #setCached(key, value, agentId) {
    this.cache.delete(key);
    this.cache.set(key, { ...value, at: this.now() });
    while (this.cache.size > this.maxCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    if (!agentId || !this.persisted?.value) return;
    const at = this.now();
    this.persisted.mutate(state => {
      state.agents ??= {};
      delete state.agents[agentId];
      state.agents[agentId] = { key, aiSuggestions: value.aiSuggestions, lang: value.lang, at };
      const ids = Object.keys(state.agents);
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PERSISTED_AGENTS))) delete state.agents[id];
    }).catch(error => console.warn(`[suggestions] cache write failed: ${error?.message ?? error}`));
  }

  /**
   * Recent messages of the conversation. With a Bot ID only the Host's own transcript of that
   * Bot is used: messages a client scraped from its screen may still belong to the previous Bot
   * right after a switch. Returns null when that transcript cannot be read.
   */
  async #loadRecentMessages(agentId, providedMessages) {
    if (agentId && typeof this.hostCall === 'function') {
      try {
        const tail = await this.hostCall('getAgentTranscriptTail', { id: agentId, limit: 12 });
        const entries = Array.isArray(tail?.entries) ? tail.entries
          : Array.isArray(tail?.transcript?.entries) ? tail.transcript.entries
          : Array.isArray(tail) ? tail : [];
        return extractRecentMessages(entries);
      } catch (error) {
        console.warn(`[suggestions] getAgentTranscriptTail failed for ${agentId}: ${error?.message ?? error}`);
        return null;
      }
    }
    if (!agentId && Array.isArray(providedMessages) && providedMessages.length > 0) {
      return extractRecentMessages(providedMessages);
    }
    return [];
  }

  /**
   * Starts generating in the background (entering a chat, a Bot's new reply) so the next
   * request is answered from the cache. Concurrent prefetches of one Bot share one run.
   */
  prefetch({ agentId = '', locale = '' } = {}) {
    if (!agentId || !AGENT_ID_RE.test(agentId)) return false;
    const cfg = this.settings?.current?.() ?? { enabled: true, aiEnabled: true };
    if (!cfg.enabled || !cfg.aiEnabled) return false;
    if (this.prefetching.has(agentId)) return true;
    const task = this.generate({ agentId, locale })
      .catch(error => console.warn(`[suggestions] prefetch failed for ${agentId}: ${error?.message ?? error}`))
      .finally(() => { if (this.prefetching.get(agentId) === task) this.prefetching.delete(agentId); });
    this.prefetching.set(agentId, task);
    return true;
  }

  /** A Bot finished a turn (Host notification 'message' / 'completed'): prepare its suggestions. */
  onAgentNotification(item) {
    if (!item || !['message', 'completed'].includes(item.type)) return false;
    const agentId = typeof item.agentId === 'string' ? item.agentId : '';
    if (!AGENT_ID_RE.test(agentId)) return false;
    clearTimeout(this.prefetchTimers.get(agentId));
    const timer = setTimeout(() => {
      this.prefetchTimers.delete(agentId);
      this.prefetch({ agentId });
    }, this.replyPrefetchDelayMs);
    timer.unref?.();
    this.prefetchTimers.set(agentId, timer);
    return true;
  }

  async generate({ agentId = '', lastEntryId = '', locale = '', recentMessages, force = false } = {}) {
    const cfg = this.settings?.current?.() ?? { enabled: true, aiEnabled: true, quickPhrases: [] };
    const initialLang = detectSuggestionLanguage(locale, []);
    const payload = fields => buildPayload({ enabled: true, aiEnabled: true, quickPhrases: cfg.quickPhrases, cached: false, agentId, ...fields });

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
        agentId,
      });
    }

    // AI suggestions switch off: return custom quick phrases only.
    if (!cfg.aiEnabled) {
      return payload({ aiEnabled: false, aiSuggestions: [], source: 'phrases-only', lang: initialLang });
    }

    const history = await this.#loadRecentMessages(agentId, recentMessages);
    if (history === null) return payload({ aiSuggestions: [], source: 'model-error', lang: initialLang });
    const lang = detectSuggestionLanguage(locale, history);

    // Empty chat: no LLM call and no hardcoded presets — custom quick phrases only.
    if (history.length === 0) return payload({ aiSuggestions: [], source: 'empty', lang });

    const route = await this.#resolveRoute();
    if (!route) return payload({ aiSuggestions: [], source: 'model-unavailable', lang });

    // The Host's own transcript decides which message the answer belongs to; a client's
    // lastEntryId only matters when there is no Bot ID to read it from.
    const historyId = historySignature(history, agentId ? '' : lastEntryId);
    const cacheKey = `${agentId || '_'}:${historyId}:${lang}:${route.profileId}:${route.model}:${route.effort}`;
    if (!force) {
      const hit = this.#getCached(cacheKey, agentId);
      if (hit) return payload({ aiSuggestions: hit.aiSuggestions, source: hit.source, cached: true, lang, historyId });
      const existing = this.inFlight.get(cacheKey);
      if (existing) {
        const result = await existing;
        return payload({ aiSuggestions: result.aiSuggestions, source: result.source, cached: true, lang: result.lang, historyId });
      }
    }

    const task = this.#generateFromModel(route, history, lang, cacheKey, agentId);
    this.inFlight.set(cacheKey, task);
    try {
      const outcome = await task;
      return payload({ aiSuggestions: outcome.aiSuggestions, source: outcome.source, lang: outcome.lang, historyId });
    } finally {
      if (this.inFlight.get(cacheKey) === task) this.inFlight.delete(cacheKey);
    }
  }

  async #resolveRoute() {
    let routing = null;
    try {
      const current = await this.models?.currentOrEmpty?.();
      routing = current?.routing ?? null;
    } catch {
      routing = null;
    }
    if (!routing || !isConfiguredModelRouting(routing)) return null;
    try {
      return optimizeRouteForLatency(modelRouteForScenario(routing, 'suggestions', { direct: true }));
    } catch {
      return null;
    }
  }

  /** Streams one short model answer; aborts after timeoutMs or when `signal` aborts. */
  async #streamText(route, messages, { timeoutMs, maxTokens, kind, label, signal, agentId }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label} request timed out`)), timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(signal.reason ?? new Error(`${label} request cancelled`));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const session = createModelSession({
        ...route,
        fetchImpl: this.fetchImpl ?? globalThis.fetch,
        selectRequest: async ({ signal: inner } = {}) => {
          inner?.throwIfAborted();
          return { ...route, requestOptions: reasoningOptions(route.model, route.effort), fallbacks: [] };
        },
        onUsage: async usage => {
          if (!this.usageDirectory) return;
          await recordUsage(this.usageDirectory, { ...usage, kind, ...(agentId ? { agentId } : {}) }).catch(() => {});
        },
      });
      const stream = session
        .getExecutor(messages)
        .stream({ signal: controller.signal }, label, [], { maxTokens });
      let output = '';
      for await (const part of stream.fullStream) {
        if (part?.type === 'text-delta') {
          const chunk = part.textDelta ?? part.text ?? part.delta ?? '';
          if (typeof chunk === 'string') output += chunk;
        }
      }
      await stream.response.catch(() => {});
      controller.signal.throwIfAborted();
      return output;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async #generateFromModel(route, history, lang, cacheKey, agentId) {
    try {
      const output = await this.#streamText(route, buildSuggestionMessages(history, lang), {
        timeoutMs: this.timeoutMs, maxTokens: SUGGESTION_MAX_TOKENS, kind: 'suggestions', label: 'composer-suggestions', agentId,
      });
      const parsed = parseSuggestionResponse(output);
      if (parsed.length === 0) {
        console.warn(`[suggestions] empty or unparseable model response (${route.model})`);
        return { aiSuggestions: [], source: 'model-error', lang };
      }
      const entry = { aiSuggestions: parsed, source: 'model', lang };
      this.#setCached(cacheKey, entry, agentId);
      return entry;
    } catch (error) {
      console.warn(`[suggestions] model call failed (${route.model}): ${error?.message ?? error}`);
      return { aiSuggestions: [], source: 'model-error', lang };
    }
  }

  #completionCached(key) {
    const entry = this.completionCache.get(key);
    if (!entry) return null;
    if (this.now() - entry.at >= this.ttlMs) {
      this.completionCache.delete(key);
      return null;
    }
    this.completionCache.delete(key);
    this.completionCache.set(key, entry);
    return entry;
  }

  #setCompletionCached(key, completion) {
    this.completionCache.delete(key);
    this.completionCache.set(key, { completion, at: this.now() });
    while (this.completionCache.size > this.maxCache) {
      const oldest = this.completionCache.keys().next().value;
      if (oldest === undefined) break;
      this.completionCache.delete(oldest);
    }
  }

  /**
   * Inline completion for the composer: the predicted rest of `text` (suffix only).
   * Never calls the model when completion is off, the draft is shorter than 2 characters,
   * or the chat has no history. Failures are silent ({ completion: '' }) and never cached.
   * `signal` cancels the model call (the client went away or sent a newer request).
   */
  async complete({ agentId = '', lastEntryId = '', locale = '', text = '', recentMessages, signal } = {}) {
    const cfg = this.settings?.current?.() ?? { completionEnabled: true };
    const draft = typeof text === 'string' ? text.slice(-COMPLETION_MAX_INPUT_CHARS) : '';
    const result = (completion, source, extra = {}) => ({
      enabled: cfg.completionEnabled !== false,
      text: draft,
      completion,
      source,
      cached: false,
      ...extra,
    });
    if (cfg.completionEnabled === false) return result('', 'disabled');
    if (countChars(draft.trim()) < COMPLETION_MIN_CHARS) return result('', 'too-short');

    const history = await this.#loadRecentMessages(agentId, recentMessages);
    if (history === null) return result('', 'model-error');
    if (history.length === 0) return result('', 'empty');
    signal?.throwIfAborted?.();
    const lang = detectSuggestionLanguage(locale, [...history, { text: draft }]);
    const route = await this.#resolveRoute();
    if (!route) return result('', 'model-unavailable');

    const sig = historySignature(history, agentId ? '' : lastEntryId);
    const draftHash = createHash('sha256').update(draft).digest('hex').slice(0, 24);
    const cacheKey = `${agentId || '_'}:${sig}:${lang}:${route.profileId}:${route.model}:${route.effort}:${draftHash}`;
    const hit = this.#completionCached(cacheKey);
    if (hit) return result(hit.completion, 'model', { cached: true, lang });

    let task = this.completionInFlight.get(cacheKey);
    const shared = Boolean(task);
    if (!task) {
      task = (async () => {
        const output = await this.#streamText(route, buildCompletionMessages(history, draft.slice(-COMPLETION_PROMPT_CHARS), lang), {
          timeoutMs: this.completionTimeoutMs,
          maxTokens: COMPLETION_MAX_TOKENS,
          kind: 'suggestions',
          label: 'composer-completion',
          signal,
          agentId,
        });
        const completion = parseCompletionResponse(output, draft);
        this.#setCompletionCached(cacheKey, completion);
        return completion;
      })();
      this.completionInFlight.set(cacheKey, task);
      task.finally(() => {
        if (this.completionInFlight.get(cacheKey) === task) this.completionInFlight.delete(cacheKey);
      }).catch(() => {});
    }
    try {
      const completion = await task;
      return result(completion, 'model', { cached: shared, lang });
    } catch (error) {
      if (signal?.aborted) return result('', 'cancelled', { lang });
      console.warn(`[suggestions] completion failed (${route.model}): ${error?.message ?? error}`);
      return result('', 'model-error', { lang });
    }
  }
}

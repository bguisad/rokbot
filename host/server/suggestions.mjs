// Lazy, cached, low-latency input-box suggestions for Web and Android composers.
// Routes through scenarioRoutes.suggestions (or falls back to defaultRoute), with
// localized static presets whenever no model is configured or the model call fails.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createModelSession } from '../runtime/model-session.mjs';
import { isConfiguredModelRouting, modelRouteForScenario } from '../runtime/model-routing.mjs';
import { reasoningOptions } from '../runtime/model-policy.mjs';
import { recordUsage } from '../runtime/usage-ledger.mjs';

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_CACHE = 200;
const MAX_SUGGESTIONS = 4;
const MAX_ITEM_CHARS = 72;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 500;

export const STATIC_SUGGESTIONS = Object.freeze({
  zh: Object.freeze({
    empty: Object.freeze([
      '帮我梳理今天的重点事项',
      '帮我润色一段消息回复',
      '给我几个可行的思路和建议',
      '帮我拆解一下接下来的行动步骤',
    ]),
    ongoing: Object.freeze([
      '继续展开说说',
      '总结一下核心要点',
      '给我一个具体例子',
      '下一步应该怎么推进？',
    ]),
  }),
  en: Object.freeze({
    empty: Object.freeze([
      'Help me prioritize my tasks today',
      'Draft a concise reply for me',
      'Brainstorm a few practical ideas',
      'Break this down into clear next steps',
    ]),
    ongoing: Object.freeze([
      'Tell me more about that',
      'Summarize the key points',
      'Give me a concrete example',
      'What should I do next?',
    ]),
  }),
});

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

export function staticSuggestions(lang = 'en', { hasHistory = false } = {}) {
  const bucket = lang === 'zh' ? STATIC_SUGGESTIONS.zh : STATIC_SUGGESTIONS.en;
  return [...(hasHistory ? bucket.ongoing : bucket.empty)];
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

export class SuggestionsService {
  constructor({
    models,
    hostCall,
    dataDir,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ttlMs = DEFAULT_TTL_MS,
    maxCache = DEFAULT_MAX_CACHE,
    now = () => Date.now(),
  } = {}) {
    this.models = models;
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
    if (Array.isArray(providedMessages) && providedMessages.length > 0) {
      return extractRecentMessages(providedMessages);
    }
    if (!agentId || typeof this.hostCall !== 'function') return [];
    try {
      const tail = await this.hostCall('getAgentTranscriptTail', { id: agentId, limit: 12 });
      const entries = Array.isArray(tail?.entries) ? tail.entries
        : Array.isArray(tail?.transcript?.entries) ? tail.transcript.entries
        : Array.isArray(tail) ? tail : [];
      return extractRecentMessages(entries);
    } catch {
      return [];
    }
  }

  async generate({ agentId = '', lastEntryId = '', locale = '', recentMessages, force = false } = {}) {
    const history = await this.#loadRecentMessages(agentId, recentMessages);
    const hasHistory = history.length > 0;
    const lang = detectSuggestionLanguage(locale, history);
    const fallback = () => ({
      suggestions: staticSuggestions(lang, { hasHistory }),
      source: 'fallback',
      cached: false,
      lang,
    });

    // Empty chat needs no LLM call — instant localized starter presets.
    if (!hasHistory) return fallback();

    let routing = null;
    try {
      const current = await this.models?.currentOrEmpty?.();
      routing = current?.routing ?? null;
    } catch {
      routing = null;
    }
    if (!routing || !isConfiguredModelRouting(routing)) return fallback();

    let route;
    try {
      route = modelRouteForScenario(routing, 'suggestions', { direct: true });
    } catch {
      return fallback();
    }

    const sig = historySignature(history, lastEntryId);
    const cacheKey = `${agentId || '_'}:${sig}:${lang}:${route.profileId}:${route.model}:${route.effort}`;
    if (!force) {
      const hit = this.#getCached(cacheKey);
      if (hit) {
        return { suggestions: [...hit.suggestions], source: hit.source, cached: true, lang };
      }
      const existing = this.inFlight.get(cacheKey);
      if (existing) {
        const result = await existing;
        return { ...result, suggestions: [...result.suggestions], cached: true };
      }
    }

    const task = this.#generateFromModel(route, history, lang, cacheKey, fallback);
    this.inFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(cacheKey) === task) this.inFlight.delete(cacheKey);
    }
  }

  async #generateFromModel(route, history, lang, cacheKey, fallback) {
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
      const stream = session.getExecutor(messages).stream({ signal: controller.signal }, 'composer-suggestions', []);
      let output = '';
      for await (const part of stream.fullStream) {
        if (part?.type === 'text-delta') {
          const chunk = part.textDelta ?? part.text ?? part.delta ?? '';
          if (typeof chunk === 'string') output += chunk;
        }
      }
      await stream.response.catch(() => {});
      const parsed = parseSuggestionResponse(output);
      if (parsed.length < 2) return fallback();
      const entry = { suggestions: parsed, source: 'model', lang };
      this.#setCached(cacheKey, entry);
      return { ...entry, suggestions: [...parsed], cached: false };
    } catch {
      return fallback();
    } finally {
      clearTimeout(timer);
    }
  }
}

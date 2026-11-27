// Per-Bot habit profile for the composer suggestions, built on the Host from the user's own
// messages to that Bot (paged transcript reads) and from how the user reacted to suggestions.
// Everything stays in <dataDir>/suggestions-habits.json; nothing leaves the Host.
//
//   profile:  frequent messages (normalized counts, recency), language, typical length, recurring
//             commands / openers, the latest user messages (never suggested again verbatim).
//   feedback: per suggestion text: shown / taps / ignores. A tap comes from the client
//             (/local/suggestions/feedback); an ignore is inferred here: the user's next message
//             after a served answer matched none of its items. What the user typed instead is
//             already counted as one of their own messages.
import { join } from 'node:path';
import { JsonStore } from './storage.mjs';

const MAX_AGENTS = 100;
const MAX_FREQUENT = 200;
const MAX_FEEDBACK = 120;
const MAX_RECENT = 12;
const MAX_TEXT_CHARS = 120;
const PAGE_LIMIT = 200;
const FIRST_SCAN_PAGES = 5;
const REFRESH_MIN_INTERVAL_MS = 15_000;
const HALF_LIFE_MS = 21 * 24 * 60 * 60_000;
export const MAX_SUGGESTION_CHARS_ZH = 18;
export const MAX_SUGGESTION_CHARS_EN = 48;

const countChars = text => [...String(text ?? '')].length;

/** Key for counting "the same message": case, spacing and trailing punctuation do not matter. */
export function normalizeMessageKey(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`。．.!！?？,，、;；:：~～…]+$/g, '')
    .trim();
}

function bigrams(key) {
  const chars = [...key.replace(/\s+/g, '')];
  if (chars.length < 2) return new Set(chars);
  const out = new Set();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** Dice coefficient of character bigrams (0..1). */
export function similarity(a, b) {
  const ka = normalizeMessageKey(a);
  const kb = normalizeMessageKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const A = bigrams(ka);
  const B = bigrams(kb);
  let both = 0;
  for (const g of A) if (B.has(g)) both++;
  return (2 * both) / (A.size + B.size || 1);
}

// Filler that fits every chat and therefore helps in none: "continue", "summarize progress",
// "check the deployment status", politeness. The model is told not to produce these; anything
// that still matches is dropped unless the user really sends it to this Bot (their habit).
const GENERIC_PATTERNS = [
  /^(请|麻烦)?(你)?(继续|接着)(吧|执行|下一步|做|干|进行|推进)?(下一步|下去|吧)?$/,
  /^(请)?(执行|进行|开始)?下一步(吧|操作|计划)?$/,
  /^(帮我|请)?(总结|汇总|概括|回顾)(一下)?(当前|目前|现在)?(的)?(进展|进度|情况|内容|工作|结果|对话)?$/,
  /^(帮我|请)?(检查|查看|看看|确认)(一下)?(线上|当前|目前|现在)?(的)?(部署|运行|服务|系统|任务|整体)?(状态|情况|进度)$/,
  /^(还有)?(什么|其他|别的)?(问题|建议|想法)(吗|呢)?[？?]?$/,
  /^(好的|好|行|可以|没问题|收到|明白了?|知道了|谢谢|多谢|感谢|辛苦了?)(你|啦|了)?$/,
  /^(详细|具体)?(说说|讲讲|解释一下|展开说说|再详细一点|详细一点)$/,
  /^(接下来|然后|之后)(做|干)?(什么|啥)[？?]?$/,
  /^(帮我)?(优化|改进)一下$/,
  /^(continue|go on|keep going|next step|proceed|do the next step)$/,
  /^(please )?(summari[sz]e|recap)( the)?( current)?( progress| status| work| conversation)?$/,
  /^(check|show)( the)?( current| deployment| deploy| system| service| production)* (status|progress)$/,
  /^(ok|okay|thanks|thank you|got it|sounds good|great|nice|cool)$/,
  /^(tell me more|explain more|more details|what's next|what next|any (other )?(suggestions|ideas|questions))$/,
];

export function isGenericSuggestion(text) {
  const key = normalizeMessageKey(text).replace(/[？?]$/, '');
  if (!key) return true;
  const generic = part => GENERIC_PATTERNS.some(re => re.test(part));
  if (generic(key)) return true;
  // "好的，谢谢" / "ok, thanks": every clause is filler.
  const parts = key.split(/[，,、；;。.!！]\s*/).map(part => part.trim().replace(/[？?]$/, '')).filter(Boolean);
  return parts.length > 1 && parts.every(generic);
}

function decay(at, now) {
  if (!at) return 0.5;
  return Math.pow(0.5, Math.max(0, now - at) / HALF_LIFE_MS);
}

/** Commands and recurring openers ("/deploy", "跑一下测试 …"): the first word or two characters. */
function opener(text) {
  const t = text.trim();
  if (/^[/!#]/.test(t)) return t.split(/\s+/)[0].slice(0, 32);
  const cjk = /^[\u3400-\u9fff]/.test(t);
  if (cjk) return [...t].slice(0, 2).join('');
  const word = t.split(/\s+/)[0]?.toLowerCase() ?? '';
  return word.length >= 3 ? word.slice(0, 24) : '';
}

/** Folds user messages (oldest first) into a profile; `prev` is extended, never mutated. */
export function buildHabitProfile(userMessages, prev = null, now = Date.now()) {
  const frequent = new Map((prev?.frequent ?? []).map(item => [item.key, { ...item }]));
  const openers = new Map(Object.entries(prev?.openers ?? {}));
  let total = prev?.total ?? 0;
  let chars = prev?.chars ?? 0;
  let cjk = prev?.cjk ?? 0;
  const recent = [...(prev?.recent ?? [])];
  for (const message of userMessages) {
    const text = String(message?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const at = Number(message.at) || now;
    total += 1;
    chars += Math.min(countChars(text), 400);
    if (/[\u3400-\u9fff]/.test(text)) cjk += 1;
    recent.push(text.length > MAX_TEXT_CHARS * 2 ? `${text.slice(0, MAX_TEXT_CHARS * 2)}…` : text);
    const op = opener(text);
    if (op) openers.set(op, (openers.get(op) ?? 0) + 1);
    if (countChars(text) > MAX_TEXT_CHARS) continue;            // long, one-off instructions are not habits
    const key = normalizeMessageKey(text);
    if (!key) continue;
    const item = frequent.get(key) ?? { key, text, count: 0, at: 0 };
    item.count += 1;
    item.text = text;                                            // the latest wording
    item.at = Math.max(item.at, at);
    frequent.set(key, item);
  }
  const scored = [...frequent.values()]
    .map(item => ({ ...item, score: item.count * (0.35 + decay(item.at, now)) }))
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, MAX_FREQUENT)
    .map(({ score, ...item }) => item);
  const topOpeners = Object.fromEntries([...openers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40));
  return {
    total,
    chars,
    cjk,
    avgChars: total ? Math.round(chars / total) : 0,
    lang: total === 0 ? '' : cjk / total >= 0.3 ? 'zh' : 'en',
    frequent: scored,
    openers: topOpeners,
    recent: recent.slice(-MAX_RECENT),
    updatedAt: now,
  };
}

/** Messages the user sent at least twice (most habitual first). */
export function frequentMessages(profile, { min = 2, limit = 50 } = {}) {
  return (profile?.frequent ?? []).filter(item => item.count >= min).slice(0, limit);
}

/** Compact profile text for the prompt (a few hundred characters at most). */
export function profilePromptSummary(profile, lang) {
  if (!profile || !profile.total) return '';
  const zh = lang === 'zh';
  const often = frequentMessages(profile, { limit: 6 }).map(item => `「${item.text.slice(0, 40)}」×${item.count}`);
  const ops = Object.entries(profile.openers ?? {}).filter(([, n]) => n >= 3).slice(0, 6).map(([op]) => op);
  const lines = [];
  if (zh) {
    lines.push(`用户给这个 Bot 发过 ${profile.total} 条消息，平均每条约 ${profile.avgChars} 字，主要用${profile.lang === 'zh' ? '中文' : '英文'}。`);
    if (often.length) lines.push(`常发：${often.join('、')}`);
    if (ops.length) lines.push(`常用开头/命令：${ops.join('、')}`);
  } else {
    lines.push(`The user sent this Bot ${profile.total} messages, about ${profile.avgChars} characters each, mostly in ${profile.lang === 'zh' ? 'Chinese' : 'English'}.`);
    if (often.length) lines.push(`Often sends: ${often.join(', ')}`);
    if (ops.length) lines.push(`Common openers/commands: ${ops.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Model items -> what is shown: within the length limit, not generic filler (unless the user
 * really sends it here), not a repeat of a recent user message, not near-duplicates of each other,
 * ranked by the user's reactions. Returns at most `max` strings; may be empty.
 */
export function filterAndRankSuggestions(items, { lang = 'zh', profile = null, feedback = {}, recentUserTexts = [], max = 3 } = {}) {
  const limit = lang === 'zh' ? MAX_SUGGESTION_CHARS_ZH : MAX_SUGGESTION_CHARS_EN;
  const habitual = new Set(frequentMessages(profile, { min: 2, limit: MAX_FREQUENT }).map(item => item.key));
  const recent = recentUserTexts.slice(-6);
  const kept = [];
  (Array.isArray(items) ? items : []).forEach((raw, index) => {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const cjkText = /[\u3400-\u9fff]/.test(text);
    if (countChars(text) > (cjkText ? MAX_SUGGESTION_CHARS_ZH + 4 : limit + 12)) return;
    const key = normalizeMessageKey(text);
    if (isGenericSuggestion(text) && !habitual.has(key)) return;
    if (recent.some(prev => similarity(prev, text) >= 0.85)) return;
    if (kept.some(other => similarity(other.text, text) >= 0.7)) return;
    const fb = feedback[key];
    const ignores = fb?.ignores ?? 0;
    const taps = fb?.taps ?? 0;
    if (ignores >= 3 && taps === 0) return;                      // shown again and again, never used
    const score = (1 - index * 0.15) + taps * 1.5 - Math.min(ignores, 4) * 0.6 + (habitual.has(key) ? 1 : 0);
    kept.push({ text, score, index });
  });
  return kept.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, max).map(item => item.text);
}

/** The user's habitual messages for the strip (no model signal): most used first, minus exclusions. */
export function habitSuggestions(profile, feedback = {}, { exclude = [], max = 3 } = {}) {
  const skip = new Set(exclude.map(normalizeMessageKey));
  const out = [];
  for (const item of frequentMessages(profile, { min: 2 })) {
    if (skip.has(item.key) || countChars(item.text) > 40) continue;
    const fb = feedback[item.key];
    if ((fb?.ignores ?? 0) >= 4 && !(fb?.taps > 0)) continue;
    out.push(item.text);
    skip.add(item.key);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Local completion candidates for a draft (also implemented by the clients, which match while
 * typing without a request): prefix first, then word/substring, then in-order (fuzzy) matches.
 */
export function matchCompletions(draft, candidates, max = 3) {
  const q = normalizeMessageKey(draft);
  if ([...q].length < 1) return [];
  const scored = [];
  candidates.forEach((raw, index) => {
    const text = String(raw?.text ?? raw ?? '').trim();
    const key = normalizeMessageKey(text);
    if (!key || key === q || key.length <= q.length) return;
    let rank = -1;
    if (key.startsWith(q)) rank = 0;
    else if (key.includes(q)) rank = 1;
    else if ([...q].length >= 2) {
      let i = 0;
      for (const ch of key) if (ch === q[i]) i++;
      if (i >= q.length) rank = 2;
    }
    if (rank >= 0) scored.push({ text, rank, index });
  });
  const seen = new Set();
  return scored.sort((a, b) => a.rank - b.rank || a.index - b.index)
    .filter(item => { const k = normalizeMessageKey(item.text); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, max).map(item => item.text);
}

function entryRole(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.role === 'user' || entry.role === 'assistant') return entry.role;
  const kind = String(entry.kind ?? entry.type ?? '').toLowerCase();
  if (['user', 'user-message', 'prompt', 'user_message'].includes(kind)) return 'user';
  return null;
}

function entryText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(entryText).filter(Boolean).join(' ').trim();
  if (value && typeof value === 'object') {
    for (const k of ['text', 'prompt', 'body']) if (typeof value[k] === 'string') return value[k].trim();
    if (value.content !== undefined) return entryText(value.content);
    if (value.message !== undefined) return entryText(value.message);
  }
  return '';
}

function entryKey(entry, text) {
  if (typeof entry?.id === 'string' && entry.id) return entry.id;
  return `${Number(entry?.timestampMs ?? entry?.createdAtMs ?? 0) || 0}:${normalizeMessageKey(text).slice(0, 40)}`;
}

export class SuggestionHabits {
  constructor({ dataDir, hostCall, now = () => Date.now(), firstScanPages = FIRST_SCAN_PAGES, refreshIntervalMs = REFRESH_MIN_INTERVAL_MS } = {}) {
    this.hostCall = hostCall;
    this.now = now;
    this.firstScanPages = firstScanPages;
    this.refreshIntervalMs = refreshIntervalMs;
    this.store = dataDir ? new JsonStore(join(dataDir, 'suggestions-habits.json'), { version: 1, agents: {} }) : null;
    this.memory = { version: 1, agents: {} };
    this.refreshing = new Map();
  }

  async load() {
    if (this.store) {
      try {
        await this.store.load();
      } catch (error) {
        console.warn(`[suggestions] habits store unreadable, starting over: ${error?.message ?? error}`);
        this.store.value = { version: 1, agents: {} };
      }
      if (!this.store.value.agents || typeof this.store.value.agents !== 'object') this.store.value.agents = {};
    }
    return this;
  }

  get state() { return this.store?.value ?? this.memory; }

  #mutate(update) {
    if (this.store) {
      return this.store.mutate(update).catch(error => console.warn(`[suggestions] habits write failed: ${error?.message ?? error}`));
    }
    update(this.memory);
    return Promise.resolve();
  }

  agent(agentId) {
    return this.state.agents?.[agentId] ?? null;
  }

  feedbackOf(agentId) {
    return this.agent(agentId)?.feedback ?? {};
  }

  /**
   * The profile of `agentId`, refreshed incrementally (only entries newer than the last scan are
   * read; the first build reads up to firstScanPages pages). A failed read keeps the old profile.
   */
  async profile(agentId, { force = false } = {}) {
    if (!agentId) return null;
    const cur = this.agent(agentId);
    if (!force && cur?.profile && this.now() - (cur.checkedAt ?? 0) < this.refreshIntervalMs) return cur.profile;
    if (this.refreshing.has(agentId)) return this.refreshing.get(agentId);
    const task = this.#refresh(agentId)
      .catch(error => {
        console.warn(`[suggestions] habit profile refresh failed for ${agentId}: ${error?.message ?? error}`);
        return this.agent(agentId)?.profile ?? null;
      })
      .finally(() => this.refreshing.delete(agentId));
    this.refreshing.set(agentId, task);
    return task;
  }

  async #refresh(agentId) {
    if (typeof this.hostCall !== 'function') return this.agent(agentId)?.profile ?? null;
    const cur = this.agent(agentId);
    const lastKey = cur?.lastKey ?? '';
    const fresh = [];                                              // newest first
    let beforeSeq;
    let reached = false;
    const pages = cur?.profile ? 20 : this.firstScanPages;
    for (let page = 0; page < pages && !reached; page++) {
      const res = await this.hostCall('getAgentTranscriptWindow', { id: agentId, limit: PAGE_LIMIT, ...(beforeSeq !== undefined ? { beforeSeq } : {}) });
      const entries = Array.isArray(res?.entries) ? res.entries : [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entryRole(entry) !== 'user') continue;
        const text = entryText(entry.text ?? entry.message ?? entry.content ?? entry.prompt).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const key = entryKey(entry, text);
        if (lastKey && key === lastKey) { reached = true; break; }
        fresh.push({ text, key, at: Number(entry.timestampMs ?? entry.createdAtMs ?? 0) || this.now() });
      }
      const next = typeof res?.nextBeforeSeq === 'number' && Number.isFinite(res.nextBeforeSeq) ? res.nextBeforeSeq : undefined;
      if (next === undefined || next === beforeSeq || entries.length === 0) break;
      beforeSeq = next;
    }
    const oldestFirst = fresh.reverse();
    // A Bot whose transcript was reset (last seen entry gone after a full scan): rebuild.
    const rebuild = Boolean(lastKey) && !reached && cur?.profile;
    const base = rebuild ? null : cur?.profile ?? null;
    const now = this.now();
    if (oldestFirst.length === 0 && cur?.profile) {
      await this.#mutate(state => { if (state.agents[agentId]) state.agents[agentId].checkedAt = now; });
      return cur.profile;
    }
    const profile = buildHabitProfile(oldestFirst, base, now);
    await this.#mutate(state => {
      state.agents ??= {};
      const prev = state.agents[agentId] ?? {};
      const next = { ...prev, profile, lastKey: oldestFirst.at(-1)?.key ?? prev.lastKey ?? '', checkedAt: now };
      // The user's next message after a served answer: a hit (used one of them) or an ignore.
      if (prev.pending && oldestFirst.length) {
        const after = oldestFirst.find(m => m.at >= (prev.pending.at ?? 0) - 1000) ?? oldestFirst[0];
        next.feedback = applyOutcome(prev.feedback ?? {}, prev.pending.items, after.text, now);
        next.typedAfter = [...(prev.typedAfter ?? []), after.text.slice(0, MAX_TEXT_CHARS)].slice(-10);
        delete next.pending;
      }
      delete state.agents[agentId];
      state.agents[agentId] = next;
      const ids = Object.keys(state.agents);
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_AGENTS))) delete state.agents[id];
    });
    return profile;
  }

  /** A foreground answer was shown: its outcome is resolved with the user's next message. */
  noteShown(agentId, items) {
    const list = (items ?? []).filter(text => typeof text === 'string' && text.trim()).slice(0, 6);
    if (!agentId || list.length === 0) return Promise.resolve();
    const at = this.now();
    return this.#mutate(state => {
      state.agents ??= {};
      const cur = state.agents[agentId] ?? {};
      const feedback = { ...(cur.feedback ?? {}) };
      for (const text of list) {
        const key = normalizeMessageKey(text);
        const fb = feedback[key] ?? { text, shown: 0, taps: 0, ignores: 0, at };
        // Showing the same answer twice in a row (refocus) is one impression.
        if (!cur.pending?.items?.includes(text)) fb.shown += 1;
        fb.at = at;
        feedback[key] = fb;
      }
      state.agents[agentId] = { ...cur, feedback: trimFeedback(feedback), pending: { items: list, at } };
    });
  }

  /** Client feedback: the user tapped a suggestion (`action: 'tap'`) or dismissed the strip. */
  record(agentId, { action, text = '', shown = [] } = {}) {
    if (!agentId) return Promise.resolve();
    const at = this.now();
    return this.#mutate(state => {
      state.agents ??= {};
      const cur = state.agents[agentId] ?? {};
      let feedback = { ...(cur.feedback ?? {}) };
      if (action === 'tap' && text) {
        feedback = applyOutcome(feedback, shown.length ? shown : [text], text, at);
      } else if (action === 'dismiss') {
        feedback = applyOutcome(feedback, shown, '', at);
      }
      const next = { ...cur, feedback: trimFeedback(feedback) };
      delete next.pending;                                         // resolved by the client
      state.agents[agentId] = next;
    });
  }

  /** 清空学习记录: profiles, feedback and pending outcomes of every Bot. */
  clear() {
    this.refreshing.clear();
    return this.#mutate(state => { state.agents = {}; });
  }

  summary() {
    const agents = Object.values(this.state.agents ?? {});
    return {
      agents: agents.length,
      messages: agents.reduce((n, a) => n + (a.profile?.total ?? 0), 0),
      feedback: agents.reduce((n, a) => n + Object.keys(a.feedback ?? {}).length, 0),
    };
  }
}

function applyOutcome(feedback, items, sentText, at) {
  const out = { ...feedback };
  const sent = normalizeMessageKey(sentText);
  let hit = false;
  for (const text of items ?? []) {
    const key = normalizeMessageKey(text);
    if (!key) continue;
    const fb = { ...(out[key] ?? { text, shown: 1, taps: 0, ignores: 0 }) };
    if (sent && (key === sent || similarity(key, sent) >= 0.85) && !hit) { fb.taps += 1; hit = true; }
    else fb.ignores += 1;
    fb.at = at;
    out[key] = fb;
  }
  return out;
}

function trimFeedback(feedback) {
  const entries = Object.entries(feedback);
  if (entries.length <= MAX_FEEDBACK) return feedback;
  return Object.fromEntries(entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, MAX_FEEDBACK));
}

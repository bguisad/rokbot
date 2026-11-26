// Lazy, cached input-box suggestions above the chat composer for the Web client.
// Fetches contextual replies from POST /local/suggestions (routed via scenarioRoutes.suggestions)
// with instant localized static presets when unconfigured or unavailable.

const SPARKLE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 3l1.9 5.3L19 10.2l-5.1 1.9L12 17.5l-1.9-5.4L5 10.2l5.1-1.9L12 3z"/>'
  + '<path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"/></svg>';

const CLOSE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const MAX_CLIENT_CACHE = 60;
const DEBOUNCE_MS = 450;

export const FALLBACK_PRESETS = Object.freeze({
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

export function isZhLocale(lang = globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '') {
  return String(lang).toLowerCase().startsWith('zh');
}

export function staticPresets(zh = isZhLocale(), hasHistory = false) {
  const bucket = zh ? FALLBACK_PRESETS.zh : FALLBACK_PRESETS.en;
  return [...(hasHistory ? bucket.ongoing : bucket.empty)];
}

export function extractComposerText(input) {
  if (!input) return '';
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    return String(input.value ?? '').replace(/\u200B/g, '').trim();
  }
  return String(input.textContent ?? '').replace(/\u200B/g, '').trim();
}

export function insertSuggestionText(input, text, doc = globalThis.document) {
  if (!input || typeof text !== 'string' || !text) return false;
  try { input.focus?.(); } catch {}
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const proto = input.tagName === 'TEXTAREA'
      ? globalThis.HTMLTextAreaElement?.prototype
      : globalThis.HTMLInputElement?.prototype;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
    if (setter) setter.call(input, text);
    else input.value = text;
    input.dispatchEvent?.(new Event('input', { bubbles: true }));
    return true;
  }
  // Lexical / contenteditable composer: execCommand('insertText') fires native beforeinput/input hooks.
  try {
    const selection = doc?.getSelection?.();
    if (selection && typeof doc?.createRange === 'function') {
      const range = doc.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (typeof doc?.execCommand === 'function' && doc.execCommand('insertText', false, text)) {
      return true;
    }
  } catch {}
  try {
    if (typeof InputEvent === 'function') {
      input.dispatchEvent?.(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      }));
    }
  } catch {}
  if (extractComposerText(input) !== text) {
    input.textContent = text;
  }
  input.dispatchEvent?.(new Event('input', { bubbles: true }));
  return true;
}

function findComposerInput(form) {
  return form?.querySelector('[contenteditable="true"], textarea, input[type="text"]') ?? null;
}

function currentAgentId(doc = document) {
  return doc.querySelector('.sand-agents-sidebar .sand-agent-item[aria-current="page"]')?.dataset?.agentId ?? '';
}

function inspectTranscript(doc = document) {
  const transcript = doc.querySelector('.sand-virtual-transcript');
  if (!transcript) return { hasHistory: false, signature: 'empty', streaming: false };
  const items = [...transcript.querySelectorAll('[data-entry-id], [data-message-id], .sand-transcript-row, article, [role="article"]')];
  if (items.length === 0) {
    const raw = (transcript.textContent || '').trim();
    if (!raw) return { hasHistory: false, signature: 'empty', streaming: false };
    return { hasHistory: true, signature: `txt:${raw.length}:${raw.slice(-48)}`, streaming: false };
  }
  const last = items[items.length - 1];
  const entryId = last.getAttribute('data-entry-id') || last.getAttribute('data-message-id') || '';
  const tailText = (last.textContent || '').replace(/\s+/g, ' ').trim().slice(-64);
  const stopBtn = doc.querySelector('.sand-prompt-form button[aria-label*="Stop" i], .sand-prompt-form button[aria-label*="停止"]');
  return {
    hasHistory: true,
    signature: `${items.length}:${entryId || tailText}`,
    lastEntryId: entryId,
    streaming: Boolean(stopBtn),
  };
}

export function installComposerSuggestions({ request, locale = '', timeoutMs = 7000 } = {}) {
  if (typeof document === 'undefined' || typeof request !== 'function') return () => {};

  const cache = new Map();
  let bar = null;
  let currentKey = '';
  let dismissedKey = '';
  let activeSuggestions = [];
  let debounceTimer = 0;
  let requestSeq = 0;
  let observedInput = null;

  const setCached = (key, items) => {
    cache.delete(key);
    cache.set(key, items);
    while (cache.size > MAX_CLIENT_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const ensureBar = () => {
    if (bar) return bar;
    const zh = isZhLocale(locale);
    bar = document.createElement('div');
    bar.className = 'rokbot-suggestions';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', zh ? '输入建议' : 'Suggested replies');
    bar.hidden = true;
    return bar;
  };

  const renderBar = () => {
    const form = document.querySelector('.sand-prompt-form');
    if (!form || !form.parentElement) {
      if (bar) bar.hidden = true;
      return;
    }
    const el = ensureBar();
    if (el.parentElement !== form.parentElement || el.nextElementSibling !== form) {
      form.parentElement.insertBefore(el, form);
    }
    const input = findComposerInput(form);
    if (input && input !== observedInput) {
      observedInput = input;
      input.addEventListener('input', renderBar);
      input.addEventListener('keyup', renderBar);
    }
    const hasDraft = extractComposerText(input).length > 0;
    if (hasDraft || dismissedKey === currentKey || activeSuggestions.length === 0) {
      el.hidden = true;
      return;
    }

    const zh = isZhLocale(locale);
    el.hidden = false;
    el.textContent = '';

    const icon = document.createElement('span');
    icon.className = 'rokbot-suggestions__icon';
    icon.innerHTML = SPARKLE_ICON;
    el.appendChild(icon);

    const scroller = document.createElement('div');
    scroller.className = 'rokbot-suggestions__list';
    for (const text of activeSuggestions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'rokbot-suggestions__chip';
      chip.textContent = text;
      chip.addEventListener('click', () => {
        const target = findComposerInput(document.querySelector('.sand-prompt-form'));
        insertSuggestionText(target, text, document);
        renderBar();
      });
      scroller.appendChild(chip);
    }
    el.appendChild(scroller);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'rokbot-suggestions__dismiss';
    dismiss.setAttribute('aria-label', zh ? '隐藏建议' : 'Dismiss suggestions');
    dismiss.innerHTML = CLOSE_ICON;
    dismiss.addEventListener('click', () => {
      dismissedKey = currentKey;
      renderBar();
    });
    el.appendChild(dismiss);
  };

  const fetchSuggestions = async (agentId, state, key) => {
    const zh = isZhLocale(locale);
    const seq = ++requestSeq;
    const cached = cache.get(key);
    if (cached) {
      activeSuggestions = cached;
      renderBar();
      return;
    }
    if (!state.hasHistory) {
      const presets = staticPresets(zh, false);
      setCached(key, presets);
      activeSuggestions = presets;
      renderBar();
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await request('/local/suggestions', {
        agentId,
        lastEntryId: state.lastEntryId || '',
        locale: document.documentElement.lang || locale || navigator.language || '',
      }, controller.signal, 'POST');
      if (seq !== requestSeq) return;
      const items = Array.isArray(res?.suggestions)
        ? res.suggestions.filter(s => typeof s === 'string' && s.trim()).slice(0, 4)
        : [];
      const resolved = items.length > 0 ? items : staticPresets(zh, true);
      setCached(key, resolved);
      activeSuggestions = resolved;
      renderBar();
    } catch {
      if (seq !== requestSeq) return;
      const fallback = staticPresets(zh, state.hasHistory);
      activeSuggestions = fallback;
      renderBar();
    } finally {
      clearTimeout(timer);
    }
  };

  const refresh = () => {
    const form = document.querySelector('.sand-prompt-form');
    if (!form) {
      if (bar) bar.hidden = true;
      return;
    }
    const agentId = currentAgentId(document);
    const state = inspectTranscript(document);
    const langKey = isZhLocale(locale) ? 'zh' : 'en';
    const nextKey = `${agentId}:${state.signature}:${langKey}`;

    if (nextKey === currentKey) {
      renderBar();
      return;
    }
    if (state.streaming) {
      renderBar();
      return;
    }
    currentKey = nextKey;
    clearTimeout(debounceTimer);
    if (cache.has(nextKey)) {
      activeSuggestions = cache.get(nextKey);
      renderBar();
      return;
    }
    debounceTimer = setTimeout(() => {
      void fetchSuggestions(agentId, state, nextKey);
    }, state.hasHistory ? DEBOUNCE_MS : 120);
    renderBar();
  };

  const observer = new MutationObserver(mutations => {
    if (mutations.every(m => m.target instanceof Element && m.target.closest('.rokbot-suggestions'))) return;
    refresh();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-current'],
  });
  refresh();

  return () => {
    clearTimeout(debounceTimer);
    observer.disconnect();
    bar?.remove();
  };
}

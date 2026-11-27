// Composer assist for the Web client and the desktop apps (macOS, Windows, Linux).
// One implementation, two loaders:
//   - desktop: `require('./composer-assist.cjs')` from the preload (suggestions-composer.cjs),
//     with an IPC-backed `request`;
//   - Web: packaged as client/desktop/composer-assist.js and imported for its side effect by
//     bridge.js (it then lives on globalThis.RokBotComposerAssist), with the gateway's `request`.
// It provides:
//   - the suggestion strip above the composer (quick phrases first, AI replies after, click to send,
//     only while the composer is focused) with a shimmer skeleton while AI replies are generated;
//   - inline completion: the predicted rest of the draft as ghost text after the caret
//     (Tab or ArrowRight at the end accepts), debounced, cancellable and cached;
//   - the first-level "Input suggestions" settings entry (toggles + quick phrases).
// The state logic (createLoadingMachine, createCompletionController) has no DOM dependency.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.RokBotComposerAssist = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const svg = (body, { size = 13, width = 2 } = {}) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICONS = {
    phrase: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>'),
    sparkle: svg('<path d="M12 3l1.9 5.3L19 10.2l-5.1 1.9L12 17.5l-1.9-5.4L5 10.2l5.1-1.9L12 3z"/>'
      + '<path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"/>', { width: 1.9 }),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    up: svg('<path d="M18 15l-6-6-6 6"/>'),
    down: svg('<path d="M6 9l6 6 6-6"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
    check: svg('<path d="M20 6L9 17l-5-5"/>', { width: 2.2 }),
    plus: svg('<path d="M12 5v14M5 12h14"/>', { size: 14, width: 2.2 }),
    // First-level settings entry: a chat bubble with a spark, drawn like the official 15px nav icons.
    nav: svg('<path d="M20 12.5a7.5 7.5 0 0 1-11.06 6.6L4 20.5l1.4-4.5A7.5 7.5 0 1 1 20 12.5z"/>'
      + '<path d="M12.5 8.6l.75 1.95 1.95.75-1.95.75-.75 1.95-.75-1.95-1.95-.75 1.95-.75z"/>', { size: 15, width: 1.7 }),
  };

  const MAX_CLIENT_CACHE = 60;
  const FOCUS_FETCH_DEBOUNCE_MS = 100;
  const DEFAULT_TIMEOUT_MS = 18_000;
  const COMPLETION_TIMEOUT_MS = 9_000;
  const COMPLETION_DEBOUNCE_MS = 350;
  const COMPLETION_MIN_CHARS = 2;
  const SETTINGS_SYNC_TTL_MS = 15_000;
  const SKELETON_WIDTHS = [86, 118, 72];

  // ---- small helpers ------------------------------------------------------------------------

  function isZhLocale(lang) {
    const value = lang ?? (globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '');
    return String(value).toLowerCase().startsWith('zh');
  }
  const t = (zh, zhText, enText) => (zh ? zhText : enText);
  const countChars = text => [...String(text ?? '')].length;

  function normalizeSettings(raw) {
    return {
      enabled: raw?.enabled !== false,
      aiEnabled: raw?.aiEnabled !== false,
      completionEnabled: raw?.completionEnabled !== false,
      quickPhrases: Array.isArray(raw?.quickPhrases)
        ? raw.quickPhrases
          .map(item => ({ id: String(item?.id ?? ''), text: String(item?.text ?? '').trim() }))
          .filter(item => item.text.length > 0)
        : [],
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    };
  }

  function mergeSuggestionItems(quickPhrases = [], aiSuggestions = []) {
    const items = [];
    const seen = new Set();
    for (const raw of Array.isArray(quickPhrases) ? quickPhrases : []) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw?.text ?? '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ type: 'phrase', id: typeof raw === 'object' && raw?.id ? String(raw.id) : '', text });
    }
    for (const raw of Array.isArray(aiSuggestions) ? aiSuggestions : []) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw?.text ?? '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ type: 'ai', text });
    }
    return items;
  }

  function prefersReducedMotion(win = globalThis.window) {
    try { return Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
  }

  // ---- loading state machine ----------------------------------------------------------------
  // idle -> loading -> ready | failed. Every begin() returns a token; results carrying an older
  // token are ignored, so a slow answer for a previous conversation never replaces a newer one.
  function createLoadingMachine({ onChange } = {}) {
    let phase = 'idle';
    let token = 0;
    let items = [];
    const emit = () => { try { onChange?.({ phase, token, items }); } catch {} };
    return {
      get phase() { return phase; },
      get token() { return token; },
      get items() { return items; },
      begin() {
        token += 1;
        phase = 'loading';
        items = [];
        emit();
        return token;
      },
      succeed(forToken, nextItems) {
        if (forToken !== token || phase !== 'loading') return false;
        items = Array.isArray(nextItems) ? nextItems.slice() : [];
        phase = 'ready';
        emit();
        return true;
      },
      fail(forToken) {
        if (forToken !== token || phase !== 'loading') return false;
        items = [];
        phase = 'failed';
        emit();
        return true;
      },
      /** Drops whatever is in flight (new conversation, blur, setting off). */
      reset() {
        token += 1;
        items = [];
        if (phase !== 'idle') {
          phase = 'idle';
          emit();
        }
      },
      isCurrent(forToken) { return forToken === token; },
    };
  }

  // ---- inline completion controller -----------------------------------------------------------
  // update() is called on every input change with the draft and the composer's state; the
  // controller decides whether to keep, drop, or (debounced) fetch a completion. `request`
  // receives ({ text, ...payload }, signal) and resolves to the /local/suggestions/complete body.
  function createCompletionController({
    request,
    debounceMs = COMPLETION_DEBOUNCE_MS,
    minChars = COMPLETION_MIN_CHARS,
    maxCache = 64,
    timeoutMs = COMPLETION_TIMEOUT_MS,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancelSchedule = id => clearTimeout(id),
    onChange,
    onSettings,
  } = {}) {
    const cache = new Map();
    let ghost = '';
    let active = null;           // { context, base, full }
    let timer = null;
    let inflight = null;         // { seq, controller, timer }
    let seq = 0;
    let latest = null;           // the last update() input
    let acceptedFull = null;     // the draft right after accept(): no immediate re-request
    let dismissedText = null;    // Escape: no completion again until the draft changes
    const stats = { requests: 0, cancelled: 0, cacheHits: 0 };

    const setGhost = next => {
      const value = typeof next === 'string' ? next : '';
      if (value === ghost) return;
      ghost = value;
      try { onChange?.(ghost); } catch {}
    };
    const cacheKey = (context, text) => `${context}\u0000${text}`;
    const remember = (key, completion) => {
      cache.delete(key);
      cache.set(key, completion);
      while (cache.size > maxCache) cache.delete(cache.keys().next().value);
    };
    const abortInflight = () => {
      if (!inflight) return;
      try { inflight.controller?.abort(); } catch {}
      if (inflight.timer) clearTimeout(inflight.timer);
      inflight = null;
      stats.cancelled += 1;
    };
    const cancelPending = () => {
      if (timer !== null) { cancelSchedule(timer); timer = null; }
      abortInflight();
    };

    async function fire(input) {
      const mySeq = ++seq;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const killer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs) : null;
      inflight = { seq: mySeq, controller, timer: killer, text: input.text, context: input.context };
      stats.requests += 1;
      let res = null;
      try {
        res = await request({ ...(input.payload ?? {}), text: input.text }, controller?.signal);
      } catch {
        res = null;
      } finally {
        if (killer) clearTimeout(killer);
        if (inflight?.seq === mySeq) inflight = null;
      }
      if (mySeq !== seq) return;              // a newer request replaced this one
      if (res && typeof res.enabled === 'boolean' && !res.enabled) {
        try { onSettings?.({ completionEnabled: false }); } catch {}
      }
      const completion = typeof res?.completion === 'string' ? res.completion.replace(/[\r\n]+/g, ' ') : '';
      if (res?.source === 'model') remember(cacheKey(input.context, input.text), completion);
      // The draft moved on while waiting: only show the answer if it still applies.
      if (!latest || latest.context !== input.context || latest.text !== input.text) return;
      if (!completion) { setGhost(''); return; }
      active = { context: input.context, base: input.text, full: input.text + completion };
      setGhost(completion);
    }

    function update(input = {}) {
      const text = typeof input.text === 'string' ? input.text : '';
      const context = String(input.context ?? '');
      const previous = latest;
      latest = { text, context, payload: input.payload };
      const gated = !input.enabled || input.composing || !input.hasHistory || input.caretAtEnd === false
        || countChars(text.trim()) < minChars;
      if (gated) {
        cancelPending();
        // Keep the prediction across a composition so it can come back if the user keeps typing it.
        if (!input.composing) active = null;
        setGhost('');
        return ghost;
      }
      if (dismissedText !== null) {
        if (text === dismissedText) { cancelPending(); setGhost(''); return ghost; }
        dismissedText = null;
      }
      // Same draft again (keyup after input, caret moves): let the pending request finish.
      if (previous && previous.text === text && previous.context === context
          && (timer !== null || (inflight && inflight.text === text && inflight.context === context))) {
        return ghost;
      }
      if (acceptedFull !== null) {
        if (text === acceptedFull) { cancelPending(); setGhost(''); return ghost; }
        acceptedFull = null;
      }
      // Typing along the prediction: keep the rest of it without asking again.
      if (active && active.context === context && text.length >= active.base.length
          && text.length < active.full.length && active.full.startsWith(text)) {
        cancelPending();
        setGhost(active.full.slice(text.length));
        return ghost;
      }
      active = null;
      setGhost('');
      const key = cacheKey(context, text);
      if (cache.has(key)) {
        cancelPending();
        stats.cacheHits += 1;
        const completion = cache.get(key);
        cache.delete(key);
        cache.set(key, completion);
        if (completion) {
          active = { context, base: text, full: text + completion };
          setGhost(completion);
        }
        return ghost;
      }
      cancelPending();
      const snapshot = { text, context, payload: input.payload };
      timer = schedule(() => { timer = null; void fire(snapshot); }, debounceMs);
      return ghost;
    }

    return {
      update,
      get ghost() { return ghost; },
      get stats() { return { ...stats, cacheSize: cache.size, pending: timer !== null, inflight: Boolean(inflight) }; },
      /** Returns the suffix to insert (or '') and forgets it. */
      accept() {
        const suffix = ghost;
        if (!suffix || !active) return '';
        acceptedFull = active.full;
        active = null;
        cancelPending();
        setGhost('');
        return suffix;
      },
      clear() {
        cancelPending();
        active = null;
        latest = null;
        setGhost('');
      },
      /** Escape: hide the completion and do not offer one again for this exact draft. */
      dismiss() {
        dismissedText = latest ? latest.text : null;
        cancelPending();
        active = null;
        setGhost('');
      },
      dispose() {
        cancelPending();
        cache.clear();
        active = null;
        latest = null;
        ghost = '';
      },
    };
  }

  // ---- composer DOM helpers ------------------------------------------------------------------

  function extractComposerText(input) {
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      return String(input.value ?? '').replace(/​/g, '').trim();
    }
    return String(input.textContent ?? '').replace(/​/g, '').trim();
  }

  /** The draft as typed (not trimmed at the end, so "word " still predicts the next word). */
  function composerDraft(input) {
    if (!input) return '';
    let raw;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') raw = String(input.value ?? '');
    else raw = String((typeof input.innerText === 'string' ? input.innerText : input.textContent) ?? '');
    return raw.replace(/​/g, '').replace(/ /g, ' ').replace(/\n+$/, '').replace(/^\s+/, '');
  }

  function insertSuggestionText(input, text, doc = globalThis.document) {
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
        input.dispatchEvent?.(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      }
    } catch {}
    if (extractComposerText(input) !== text) input.textContent = text;
    input.dispatchEvent?.(new Event('input', { bubbles: true }));
    return true;
  }

  /** Inserts `suffix` at the end of the draft (the caret is there when a completion shows). */
  function appendComposerText(input, suffix, doc = globalThis.document) {
    if (!input || typeof suffix !== 'string' || !suffix) return false;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const next = String(input.value ?? '') + suffix;
      const proto = input.tagName === 'TEXTAREA' ? globalThis.HTMLTextAreaElement?.prototype : globalThis.HTMLInputElement?.prototype;
      const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
      if (setter) setter.call(input, next); else input.value = next;
      try { input.setSelectionRange?.(next.length, next.length); } catch {}
      input.dispatchEvent?.(new Event('input', { bubbles: true }));
      return true;
    }
    try { input.focus?.(); } catch {}
    try {
      const selection = doc?.getSelection?.();
      if (selection && typeof doc?.createRange === 'function') {
        const range = doc.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (typeof doc?.execCommand === 'function' && doc.execCommand('insertText', false, suffix)) return true;
    } catch {}
    try {
      if (typeof InputEvent === 'function') {
        const ev = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: suffix });
        input.dispatchEvent?.(ev);
        if (ev.defaultPrevented) return true;
      }
    } catch {}
    input.textContent = `${input.textContent ?? ''}${suffix}`;
    input.dispatchEvent?.(new Event('input', { bubbles: true }));
    return true;
  }

  function findSendButton(form) {
    if (!form || typeof form.querySelectorAll !== 'function') return null;
    for (const btn of form.querySelectorAll('button.sand-prompt-send, button[type="submit"], button[aria-label]')) {
      if (btn.disabled || btn.getAttribute?.('aria-disabled') === 'true') continue;
      const label = String(btn.getAttribute?.('aria-label') ?? '').toLowerCase();
      const isSendLabel = label.includes('send') || label.includes('发送') || label.includes('傳送');
      const isSubmit = btn.type === 'submit' || btn.getAttribute?.('type') === 'submit';
      if (isSendLabel || isSubmit) {
        if (label.includes('stop') || label.includes('停止') || label.includes('voice') || label.includes('语音') || label.includes('mic')) continue;
        return btn;
      }
    }
    return null;
  }

  function sendSuggestionText(form, input, text, doc = globalThis.document, { schedule = fn => setTimeout(fn, 24) } = {}) {
    if (!insertSuggestionText(input, text, doc)) return false;
    const trySubmit = (attempt = 0) => {
      const btn = findSendButton(form);
      if (btn) { btn.click(); return true; }
      if (attempt < 4 && typeof schedule === 'function') { schedule(() => trySubmit(attempt + 1)); return false; }
      try { if (typeof form?.requestSubmit === 'function') { form.requestSubmit(); return true; } } catch {}
      try {
        if (typeof KeyboardEvent === 'function') {
          input.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          return true;
        }
      } catch {}
      return false;
    };
    if (typeof schedule === 'function') schedule(() => trySubmit(0));
    else trySubmit(0);
    return true;
  }

  const findComposerInput = form => form?.querySelector('[contenteditable="true"], textarea, input[type="text"]') ?? null;

  function currentAgentId(doc, getViewingAgentId) {
    for (const sel of [
      '.sand-agents-sidebar .sand-agent-item[aria-current="page"]',
      '.sand-agents-sidebar .sand-agent-item[data-active="true"]',
      '.sand-agents-sidebar .sand-agent-item[aria-selected="true"]',
      '.sand-agents-sidebar .sand-agent-item[aria-pressed="true"]',
    ]) {
      const id = doc.querySelector(sel)?.dataset?.agentId;
      if (id) return id;
    }
    const tracked = typeof getViewingAgentId === 'function' ? getViewingAgentId() : '';
    return typeof tracked === 'string' ? tracked : '';
  }

  function extractVisibleMessages(doc) {
    const transcript = doc.querySelector('.sand-virtual-transcript');
    if (!transcript) return [];
    const anchors = [...transcript.querySelectorAll('.sand-message-action-anchor[data-role], [data-role="user"], [data-role="assistant"]')];
    const out = [];
    for (const el of anchors.slice(-6)) {
      const rawRole = String(el.getAttribute('data-role') || '').toLowerCase();
      const role = rawRole === 'user' ? 'user' : (['assistant', 'agent', 'bot'].includes(rawRole) ? 'assistant' : '');
      if (!role) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({ id: el.getAttribute('data-entry-id') || el.getAttribute('data-message-id') || '', role, text: text.slice(0, 500) });
    }
    return out;
  }

  function inspectTranscript(doc) {
    const transcript = doc.querySelector('.sand-virtual-transcript');
    const stopBtn = doc.querySelector('.sand-prompt-form button[aria-label*="Stop" i], .sand-prompt-form button[aria-label*="停止"]');
    const streaming = Boolean(stopBtn);
    if (!transcript) return { hasHistory: false, signature: 'empty', lastEntryId: '', streaming, recentMessages: [] };
    const items = [...transcript.querySelectorAll('[data-entry-id], [data-message-id], .sand-transcript-row, article, [role="article"]')];
    if (items.length === 0) {
      const raw = (transcript.textContent || '').trim();
      if (!raw) return { hasHistory: false, signature: 'empty', lastEntryId: '', streaming, recentMessages: [] };
      return { hasHistory: true, signature: `txt:${raw.length}:${raw.slice(-48)}`, lastEntryId: '', streaming, recentMessages: extractVisibleMessages(doc) };
    }
    const last = items[items.length - 1];
    const entryId = last.getAttribute('data-entry-id') || last.getAttribute('data-message-id') || '';
    const tailText = (last.textContent || '').replace(/\s+/g, ' ').trim().slice(-64);
    return { hasHistory: true, signature: `${items.length}:${entryId || tailText}`, lastEntryId: entryId, streaming, recentMessages: extractVisibleMessages(doc) };
  }

  function isInputFocused(input, doc) {
    const active = doc?.activeElement;
    return Boolean(input && active && (active === input || (typeof input.contains === 'function' && input.contains(active))));
  }

  /** Collapsed selection at the very end of the composer's text. */
  function caretAtEnd(input, doc) {
    if (!input) return false;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const len = String(input.value ?? '').length;
      return input.selectionStart === len && input.selectionEnd === len;
    }
    try {
      const sel = doc.getSelection?.();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
      const range = sel.getRangeAt(0);
      if (!input.contains(range.endContainer)) return false;
      const tail = doc.createRange();
      tail.selectNodeContents(input);
      tail.setStart(range.endContainer, range.endOffset);
      return tail.toString().replace(/[​\s]/g, '') === '';
    } catch {
      return false;
    }
  }

  /** Viewport rectangle of the caret (falls back to the end of the input's content box). */
  function caretRect(input, doc) {
    try {
      const sel = doc.getSelection?.();
      if (sel && sel.rangeCount > 0 && input.contains(sel.getRangeAt(0).endContainer)) {
        const range = sel.getRangeAt(0).cloneRange();
        range.collapse(false);
        let rect = range.getClientRects?.()[0] || range.getBoundingClientRect?.();
        if (!rect || (rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0)) {
          const node = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
          const box = node?.getBoundingClientRect?.();
          if (box) rect = { left: box.left, top: box.top, height: box.height, right: box.left };
        }
        if (rect) return { left: rect.left, top: rect.top, height: rect.height || 18 };
      }
    } catch {}
    return null;
  }

  // A mention/command menu of the editor owns Tab and the arrows while it is open.
  function editorMenuOpen(doc) {
    const nodes = doc.querySelectorAll('[role="listbox"], [role="menu"], .sand-prompt-menu, [data-floating-ui-portal] [role="option"]');
    for (const node of nodes) {
      if (node.closest?.('.rokbot-suggestions')) continue;
      if (node.getClientRects?.().length) return true;
    }
    return false;
  }

  // ---- composer strip + ghost text ------------------------------------------------------------

  function installComposerSuggestions({
    request,
    locale = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    getViewingAgentId,
    installSettings = true,
    document: doc = globalThis.document,
    window: win = globalThis.window,
  } = {}) {
    if (!doc || typeof request !== 'function') return () => {};
    const zhNow = () => isZhLocale(doc.documentElement.lang || locale);
    const motion = () => !prefersReducedMotion(win);

    const aiCache = new Map();
    let settingsState = normalizeSettings({});
    let settingsSyncedAt = 0;
    let settingsInFlight = null;
    let bar = null;
    let currentKey = '';
    let dismissedKey = '';
    let failedKey = '';          // a failed request is not retried until the conversation changes
    let activeAiSuggestions = [];
    let debounceTimer = 0;
    let observedInput = null;
    let observedForm = null;
    let composerFocused = false;
    let suppressUntilRefocus = false;
    let composing = false;
    let settingsUi = null;
    let revealOnNextRender = false;
    let leavingTimer = 0;

    const loading = createLoadingMachine({
      onChange: ({ phase }) => {
        if (phase === 'ready') revealOnNextRender = true;
        if (phase === 'failed') fadeOutSkeleton();
        else renderBar();
      },
    });

    const setCachedAi = (key, items) => {
      aiCache.delete(key);
      aiCache.set(key, items);
      while (aiCache.size > MAX_CLIENT_CACHE) aiCache.delete(aiCache.keys().next().value);
    };

    const syncSettings = async (force = false) => {
      if (!force && settingsSyncedAt && Date.now() - settingsSyncedAt < SETTINGS_SYNC_TTL_MS) return settingsState;
      if (settingsInFlight) return settingsInFlight;
      settingsInFlight = (async () => {
        try {
          settingsState = normalizeSettings(await request('/local/suggestions/settings', null, undefined, 'GET'));
          settingsSyncedAt = Date.now();
          settingsUi?.updateState(settingsState);
        } catch {}
        return settingsState;
      })().finally(() => { settingsInFlight = null; });
      return settingsInFlight;
    };

    const ensureBar = () => {
      if (bar) return bar;
      bar = doc.createElement('div');
      bar.className = 'rokbot-suggestions';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', t(zhNow(), '输入建议', 'Suggested replies'));
      bar.hidden = true;
      // Keep the composer focused when a pill or the close button is pressed.
      bar.addEventListener('mousedown', ev => { ev.preventDefault(); });
      return bar;
    };

    const computeVisibleItems = () => {
      if (!settingsState.enabled) return [];
      return mergeSuggestionItems(settingsState.quickPhrases, settingsState.aiEnabled ? activeAiSuggestions : []);
    };

    function skeletonList(count = 3) {
      const wrap = doc.createDocumentFragment();
      for (let i = 0; i < count; i++) {
        const pill = doc.createElement('span');
        pill.className = 'rokbot-suggestions__skeleton';
        pill.style.width = `${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}px`;
        pill.style.setProperty('--rokbot-skeleton-delay', `${i * 120}ms`);
        pill.setAttribute('aria-hidden', 'true');
        wrap.appendChild(pill);
      }
      return wrap;
    }

    function fadeOutSkeleton() {
      if (!bar) { renderBar(); return; }
      const pills = [...bar.querySelectorAll('.rokbot-suggestions__skeleton')];
      if (!pills.length || !motion()) { renderBar(); return; }
      for (const pill of pills) pill.classList.add('rokbot-suggestions__skeleton--leaving');
      clearTimeout(leavingTimer);
      leavingTimer = setTimeout(() => renderBar(), 200);
    }

    function renderBar() {
      const form = doc.querySelector('.sand-prompt-form');
      if (!form || !form.parentElement) { if (bar) bar.hidden = true; return; }
      const el = ensureBar();
      if (el.parentElement !== form.parentElement || el.nextElementSibling !== form) form.parentElement.insertBefore(el, form);
      const input = findComposerInput(form);
      attachComposerListeners(form, input);

      const focusedNow = !suppressUntilRefocus && (composerFocused || isInputFocused(input, doc));
      const hasDraft = extractComposerText(input).length > 0;
      const items = computeVisibleItems();
      const showSkeleton = loading.phase === 'loading' && settingsState.enabled && settingsState.aiEnabled;
      if (!focusedNow || !settingsState.enabled || hasDraft || dismissedKey === currentKey || (items.length === 0 && !showSkeleton)) {
        el.hidden = true;
        el.removeAttribute('aria-busy');
        return;
      }
      const zh = zhNow();
      el.setAttribute('aria-label', t(zh, '输入建议', 'Suggested replies'));
      if (showSkeleton) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy');
      el.hidden = false;
      el.textContent = '';
      clearTimeout(leavingTimer);

      const scroller = doc.createElement('div');
      scroller.className = 'rokbot-suggestions__list';
      const reveal = revealOnNextRender && motion();
      revealOnNextRender = false;
      let aiIndex = 0;
      for (const item of items) {
        const chip = doc.createElement('button');
        chip.type = 'button';
        chip.className = `rokbot-suggestions__chip rokbot-suggestions__chip--${item.type}`;
        chip.dataset.suggestionType = item.type;
        if (reveal && item.type === 'ai') {
          chip.classList.add('rokbot-suggestions__chip--enter');
          chip.style.setProperty('--rokbot-enter-delay', `${aiIndex++ * 45}ms`);
        }
        const iconSpan = doc.createElement('span');
        iconSpan.className = 'rokbot-suggestions__chip-icon';
        iconSpan.innerHTML = item.type === 'phrase' ? ICONS.phrase : ICONS.sparkle;
        const labelSpan = doc.createElement('span');
        labelSpan.className = 'rokbot-suggestions__chip-text';
        labelSpan.textContent = item.text;
        chip.append(iconSpan, labelSpan);
        chip.addEventListener('click', () => {
          const liveForm = doc.querySelector('.sand-prompt-form');
          composerFocused = false;
          suppressUntilRefocus = true;
          el.hidden = true;
          completion.clear();
          sendSuggestionText(liveForm, findComposerInput(liveForm), item.text, doc);
        });
        scroller.appendChild(chip);
      }
      if (showSkeleton) {
        const status = doc.createElement('span');
        status.className = 'rokbot-suggestions__status';
        status.setAttribute('role', 'status');
        status.textContent = t(zh, '正在生成建议', 'Generating suggestions');
        scroller.append(skeletonList(3), status);
      }
      el.appendChild(scroller);

      const dismiss = doc.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'rokbot-suggestions__dismiss';
      dismiss.setAttribute('aria-label', t(zh, '隐藏建议', 'Dismiss suggestions'));
      dismiss.innerHTML = ICONS.close;
      dismiss.addEventListener('click', () => { dismissedKey = currentKey; loading.reset(); renderBar(); });
      el.appendChild(dismiss);
    }

    async function fetchSuggestions(agentId, state, key) {
      const cfg = await syncSettings(false);
      if (!composerFocused || key !== currentKey) return;
      if (!cfg.enabled || !cfg.aiEnabled || !state.hasHistory) { activeAiSuggestions = []; loading.reset(); renderBar(); return; }
      const cached = aiCache.get(key);
      if (cached) { activeAiSuggestions = cached; loading.reset(); renderBar(); return; }
      if (loading.phase === 'loading') return;
      const token = loading.begin();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const res = await request('/local/suggestions', {
          agentId,
          lastEntryId: state.lastEntryId || '',
          locale: doc.documentElement.lang || locale || globalThis.navigator?.language || '',
          ...(state.recentMessages?.length ? { recentMessages: state.recentMessages } : {}),
        }, controller?.signal, 'POST');
        if (!loading.isCurrent(token)) return;
        if (res && typeof res.enabled === 'boolean') {
          settingsState = normalizeSettings({
            ...settingsState,
            enabled: res.enabled,
            aiEnabled: res.aiEnabled,
            quickPhrases: res.quickPhrases ?? settingsState.quickPhrases,
          });
          settingsSyncedAt = Date.now();
          settingsUi?.updateState(settingsState);
        }
        const aiItems = Array.isArray(res?.aiSuggestions)
          ? res.aiSuggestions.filter(s => typeof s === 'string' && s.trim()).slice(0, 4)
          : [];
        if (res?.source === 'model' && aiItems.length > 0) {
          setCachedAi(key, aiItems);
          activeAiSuggestions = aiItems;
          loading.succeed(token, aiItems);
        } else {
          // Nothing usable: the placeholders fade away silently; quick phrases stay.
          activeAiSuggestions = [];
          failedKey = key;
          loading.fail(token);
        }
      } catch {
        if (!loading.isCurrent(token)) return;
        activeAiSuggestions = [];
        failedKey = key;
        loading.fail(token);
      } finally {
        clearTimeout(timer);
      }
    }

    function triggerIfFocused() {
      const form = doc.querySelector('.sand-prompt-form');
      if (!form) { if (bar) bar.hidden = true; hideGhost(); return; }
      const input = findComposerInput(form);
      attachComposerListeners(form, input);
      const agentId = currentAgentId(doc, getViewingAgentId);
      const state = inspectTranscript(doc);
      const nextKey = `${agentId}:${state.signature}:${zhNow() ? 'zh' : 'en'}`;
      if (nextKey !== currentKey) {
        currentKey = nextKey;
        activeAiSuggestions = aiCache.get(nextKey) ?? [];
        loading.reset();
      }
      const focusedNow = !suppressUntilRefocus && (composerFocused || isInputFocused(input, doc));
      if (!focusedNow || extractComposerText(input).length > 0 || dismissedKey === currentKey) { renderBar(); return; }
      renderBar();
      if (state.streaming) return;
      clearTimeout(debounceTimer);
      const wanted = () => settingsState.enabled && settingsState.aiEnabled && state.hasHistory && !aiCache.has(currentKey)
        && failedKey !== currentKey && loading.phase !== 'loading';
      if (!settingsSyncedAt) {
        void syncSettings(true).then(() => {
          if (!composerFocused) return;
          renderBar();
          if (wanted()) void fetchSuggestions(agentId, state, currentKey);
        });
        return;
      }
      if (!wanted()) return;
      debounceTimer = setTimeout(() => { if (composerFocused) void fetchSuggestions(agentId, state, currentKey); }, FOCUS_FETCH_DEBOUNCE_MS);
    }

    // -- ghost text -------------------------------------------------------------------------------
    let ghostEl = null;
    let ghostClickArmed = false;
    const completion = createCompletionController({
      request: (payload, signal) => request('/local/suggestions/complete', payload, signal, 'POST'),
      onChange: () => positionGhost(),
      onSettings: patch => { settingsState = normalizeSettings({ ...settingsState, ...patch }); settingsUi?.updateState(settingsState); },
    });

    function ensureGhost() {
      if (ghostEl && ghostEl.isConnected) return ghostEl;
      ghostEl = doc.createElement('span');
      ghostEl.className = 'rokbot-ghost';
      ghostEl.setAttribute('aria-hidden', 'true');
      ghostEl.hidden = true;
      const hint = doc.createElement('span');
      hint.className = 'rokbot-ghost__text';
      const key = doc.createElement('kbd');
      key.className = 'rokbot-ghost__key';
      key.textContent = 'Tab';
      ghostEl.append(hint, key);
      // Clicking the ghost text accepts it; mousedown must not move the caret first.
      ghostEl.addEventListener('mousedown', ev => { ev.preventDefault(); ghostClickArmed = true; });
      ghostEl.addEventListener('click', ev => { ev.preventDefault(); if (ghostClickArmed) acceptGhost(); ghostClickArmed = false; });
      (doc.body || doc.documentElement).appendChild(ghostEl);
      return ghostEl;
    }

    function hideGhost() {
      if (ghostEl) ghostEl.hidden = true;
      observedInput?.removeAttribute?.('data-rokbot-ghost');
    }

    function positionGhost() {
      const suffix = completion.ghost;
      const form = doc.querySelector('.sand-prompt-form');
      const input = findComposerInput(form);
      if (!suffix || !input || composing || !isInputFocused(input, doc) || !caretAtEnd(input, doc)) { hideGhost(); return; }
      const rect = caretRect(input, doc);
      const box = input.getBoundingClientRect?.();
      if (!rect || !box) { hideGhost(); return; }
      const el = ensureGhost();
      const style = win?.getComputedStyle?.(input);
      if (style) {
        el.style.fontFamily = style.fontFamily;
        el.style.fontSize = style.fontSize;
        el.style.fontWeight = style.fontWeight;
        el.style.letterSpacing = style.letterSpacing;
      }
      el.firstChild.textContent = suffix;
      const lineHeight = Math.max(rect.height, 16);
      el.style.left = `${Math.round(rect.left + 1)}px`;
      el.style.top = `${Math.round(rect.top)}px`;
      el.style.height = `${Math.round(lineHeight)}px`;
      el.style.lineHeight = `${Math.round(lineHeight)}px`;
      el.style.maxWidth = `${Math.max(40, Math.round(box.right - rect.left - 8))}px`;
      el.hidden = false;
      input.setAttribute('data-rokbot-ghost', '1');
    }

    function acceptGhost() {
      const form = doc.querySelector('.sand-prompt-form');
      const input = findComposerInput(form);
      const suffix = completion.accept();
      hideGhost();
      if (!suffix || !input) return false;
      appendComposerText(input, suffix, doc);
      return true;
    }

    function updateCompletion() {
      const form = doc.querySelector('.sand-prompt-form');
      const input = findComposerInput(form);
      if (!input) { completion.clear(); hideGhost(); return; }
      const focused = isInputFocused(input, doc);
      const state = inspectTranscript(doc);
      const agentId = currentAgentId(doc, getViewingAgentId);
      completion.update({
        text: composerDraft(input),
        caretAtEnd: caretAtEnd(input, doc),
        composing,
        enabled: focused && settingsState.completionEnabled && !state.streaming,
        hasHistory: state.hasHistory,
        context: `${agentId}:${state.signature}`,
        payload: {
          agentId,
          lastEntryId: state.lastEntryId || '',
          locale: doc.documentElement.lang || locale || globalThis.navigator?.language || '',
          ...(state.recentMessages?.length ? { recentMessages: state.recentMessages } : {}),
        },
      });
      positionGhost();
    }

    const onKeyDown = ev => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (!completion.ghost || !ghostEl || ghostEl.hidden) return;
      const input = observedInput;
      if (ev.key === 'Escape') { completion.dismiss(); hideGhost(); return; }
      const plain = !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey;
      const accepts = plain && (ev.key === 'Tab' || (ev.key === 'ArrowRight' && caretAtEnd(input, doc)));
      if (!accepts || editorMenuOpen(doc)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      acceptGhost();
    };
    const onCompositionStart = () => { composing = true; updateCompletion(); };
    const onCompositionEnd = () => { composing = false; setTimeout(updateCompletion, 0); };
    const onSelectionChange = () => { if (completion.ghost) positionGhost(); };

    const onInputFocus = ev => {
      if (suppressUntilRefocus && ev?.isTrusted === false) return;
      suppressUntilRefocus = false;
      composerFocused = true;
      triggerIfFocused();
      updateCompletion();
    };
    const onInputPointerDown = () => {
      if (!suppressUntilRefocus) return;
      suppressUntilRefocus = false;
      composerFocused = true;
      triggerIfFocused();
    };
    const onInputBlur = ev => {
      const nextTarget = ev?.relatedTarget;
      if (nextTarget && bar && bar.contains(nextTarget)) return;
      composerFocused = false;
      suppressUntilRefocus = false;
      clearTimeout(debounceTimer);
      completion.clear();
      hideGhost();
      renderBar();
    };
    const onInputChange = ev => {
      if (ev?.type === 'input' && typeof ev.isComposing === 'boolean') composing = ev.isComposing;
      renderBar();
      const form = doc.querySelector('.sand-prompt-form');
      const input = findComposerInput(form);
      if (!suppressUntilRefocus && composerFocused && extractComposerText(input).length === 0) triggerIfFocused();
      updateCompletion();
    };

    function attachComposerListeners(form, input) {
      if (form && form !== observedForm) {
        observedForm = form;
        form.addEventListener('focusin', onInputFocus);
        form.addEventListener('focusout', onInputBlur);
      }
      if (input && input !== observedInput) {
        observedInput = input;
        composing = false;
        input.addEventListener('focus', onInputFocus);
        input.addEventListener('blur', onInputBlur);
        input.addEventListener('pointerdown', onInputPointerDown);
        input.addEventListener('input', onInputChange);
        input.addEventListener('keyup', ev => { if (!['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(ev.key)) onInputChange(ev); });
        input.addEventListener('keydown', onKeyDown, true);
        input.addEventListener('compositionstart', onCompositionStart);
        input.addEventListener('compositionend', onCompositionEnd);
      }
    }

    doc.addEventListener('selectionchange', onSelectionChange);
    win?.addEventListener?.('resize', onSelectionChange);
    win?.addEventListener?.('scroll', onSelectionChange, true);

    if (installSettings) {
      settingsUi = installSuggestionsSettingsPage({
        request,
        locale,
        document: doc,
        getState: () => settingsState,
        onStateChange: next => {
          settingsState = normalizeSettings(next);
          settingsSyncedAt = Date.now();
          if (!settingsState.enabled || !settingsState.aiEnabled) { activeAiSuggestions = []; loading.reset(); }
          if (!settingsState.completionEnabled) { completion.clear(); hideGhost(); }
          renderBar();
          if (composerFocused && settingsState.enabled && settingsState.aiEnabled) triggerIfFocused();
        },
      });
    }

    // Prime settings (a tiny GET, no model call) so phrases show immediately on first focus.
    void syncSettings(true);

    const observer = new MutationObserver(mutations => {
      if (mutations.every(m => m.target instanceof Element && (m.target.closest('.rokbot-suggestions') || m.target.closest('.rokbot-ghost') || m.target.closest('[data-rokbot-suggestions-page]') || m.target.closest('[data-rokbot-suggestions-nav]')))) return;
      triggerIfFocused();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current', 'data-active', 'aria-selected'] });
    triggerIfFocused();

    return () => {
      clearTimeout(debounceTimer);
      clearTimeout(leavingTimer);
      observer.disconnect();
      completion.dispose();
      doc.removeEventListener('selectionchange', onSelectionChange);
      win?.removeEventListener?.('resize', onSelectionChange);
      win?.removeEventListener?.('scroll', onSelectionChange, true);
      settingsUi?.destroy();
      bar?.remove();
      ghostEl?.remove();
    };
  }

  // ---- first-level settings entry ---------------------------------------------------------------
  // The official settings dialog: .sand-settings-layout > nav.sand-settings-nav > button.sand-settings-nav__item
  // (aria-current="page" + data-active on the selected one) and section.sand-settings-panel
  // (close button, pane header, .sand-settings-panel__body). The entry is one more nav button with the
  // official classes; while it is selected the official header and body are hidden and the page shows.

  function installSuggestionsSettingsPage({ request, locale = '', getState, onStateChange, document: doc = globalThis.document } = {}) {
    if (!doc || typeof request !== 'function') return { updateState() {}, destroy() {} };
    let state = normalizeSettings(getState?.() ?? {});
    let loadingSettings = false;
    let loadedOnce = false;
    let editingId = null;
    let editingValue = '';
    let statusError = '';
    let open = false;
    let page = null;
    let navButton = null;
    let swapped = null;        // { el, className, ariaCurrent, dataActive, iconClass } of the official selected item
    let look = {};             // class names of the official pane, section, section title row and card
    const zh = () => isZhLocale(doc.documentElement.lang || locale);

    const applyState = next => {
      state = normalizeSettings(next);
      onStateChange?.(state);
      renderPage();
    };

    const syncFromHost = async () => {
      if (loadingSettings) return;
      loadingSettings = true;
      try {
        const res = await request('/local/suggestions/settings', null, undefined, 'GET');
        loadedOnce = true;
        statusError = '';
        applyState(res);
      } catch (err) {
        statusError = err?.message || t(zh(), '无法读取输入建议设置', 'Could not load suggestion settings');
        renderPage();
      } finally {
        loadingSettings = false;
      }
    };

    const save = async (patch, fallback) => {
      statusError = '';
      try { applyState(await request('/local/suggestions/settings', patch, undefined, 'PUT')); }
      catch (err) { statusError = err?.message || fallback; renderPage(); }
    };

    const phraseCall = async (path, body, method, fallback) => {
      statusError = '';
      try {
        const res = await request(path, body, undefined, method);
        applyState({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
        return true;
      } catch (err) {
        statusError = err?.message || fallback;
        renderPage();
        return false;
      }
    };

    function switchRow(id, labelText, descText, checked, disabled, onToggle) {
      const row = doc.createElement('div');
      row.className = 'rokbot-sug-settings__row';
      if (disabled) row.classList.add('rokbot-sug-settings__row--disabled');
      const copy = doc.createElement('div');
      copy.className = 'rokbot-sug-settings__copy';
      const title = doc.createElement('div');
      title.className = 'rokbot-sug-settings__label';
      title.textContent = labelText;
      const desc = doc.createElement('div');
      desc.className = 'rokbot-sug-settings__desc';
      desc.textContent = descText;
      copy.append(title, desc);
      const sw = doc.createElement('button');
      sw.type = 'button';
      sw.id = id;
      sw.className = 'rokbot-sug-settings__switch';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', labelText);
      sw.setAttribute('aria-checked', String(Boolean(checked)));
      sw.disabled = Boolean(disabled);
      const thumb = doc.createElement('span');
      thumb.className = 'rokbot-sug-settings__switch-thumb';
      sw.appendChild(thumb);
      sw.addEventListener('click', () => { if (!disabled) void onToggle(); });
      row.append(copy, sw);
      return row;
    }

    function iconButton(className, label, icon, onClick, disabled = false) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `rokbot-sug-settings__icon-btn${className ? ` ${className}` : ''}`;
      btn.disabled = disabled;
      btn.setAttribute('aria-label', label);
      btn.innerHTML = icon;
      if (onClick) btn.addEventListener('click', onClick);
      return btn;
    }

    function phraseList(isZh) {
      const list = doc.createElement('ul');
      list.className = 'rokbot-sug-settings__list';
      if (state.quickPhrases.length === 0) {
        const empty = doc.createElement('li');
        empty.className = 'rokbot-sug-settings__empty';
        empty.textContent = t(isZh, '暂未添加常用语', 'No quick phrases yet');
        list.appendChild(empty);
        return list;
      }
      state.quickPhrases.forEach((phrase, idx) => {
        const li = doc.createElement('li');
        li.className = 'rokbot-sug-settings__item';
        li.dataset.phraseId = phrase.id;
        if (editingId === phrase.id) {
          const form = doc.createElement('form');
          form.className = 'rokbot-sug-settings__edit-form';
          const input = doc.createElement('input');
          input.type = 'text';
          input.className = 'rokbot-sug-settings__input';
          input.maxLength = 120;
          input.value = editingValue;
          input.setAttribute('aria-label', t(isZh, '编辑常用语', 'Edit quick phrase'));
          input.addEventListener('input', () => { editingValue = input.value; });
          const saveBtn = doc.createElement('button');
          saveBtn.type = 'submit';
          saveBtn.className = 'rokbot-sug-settings__icon-btn rokbot-sug-settings__icon-btn--primary';
          saveBtn.setAttribute('aria-label', t(isZh, '保存', 'Save'));
          saveBtn.innerHTML = ICONS.check;
          const cancelBtn = iconButton('', t(isZh, '取消', 'Cancel'), ICONS.close, () => { editingId = null; editingValue = ''; renderPage(); });
          form.append(input, saveBtn, cancelBtn);
          form.addEventListener('submit', async ev => {
            ev.preventDefault();
            const text = input.value.replace(/\s+/g, ' ').trim();
            if (!text) return;
            if (await phraseCall(`/local/suggestions/phrases/${encodeURIComponent(phrase.id)}`, { text }, 'PUT', t(isZh, '保存失败', 'Could not update phrase'))) {
              editingId = null;
              editingValue = '';
              renderPage();
            }
          });
          li.appendChild(form);
          setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 0);
        } else {
          const iconSpan = doc.createElement('span');
          iconSpan.className = 'rokbot-sug-settings__item-icon';
          iconSpan.innerHTML = ICONS.phrase;
          const textSpan = doc.createElement('span');
          textSpan.className = 'rokbot-sug-settings__item-text';
          textSpan.textContent = phrase.text;
          const actions = doc.createElement('div');
          actions.className = 'rokbot-sug-settings__item-actions';
          const move = delta => {
            const target = idx + delta;
            if (target < 0 || target >= state.quickPhrases.length) return;
            const ids = state.quickPhrases.map(item => item.id);
            [ids[idx], ids[target]] = [ids[target], ids[idx]];
            void phraseCall('/local/suggestions/phrases/reorder', { ids }, 'PUT', t(isZh, '排序失败', 'Could not reorder phrases'));
          };
          actions.append(
            iconButton('', t(isZh, '上移', 'Move up'), ICONS.up, () => move(-1), idx === 0),
            iconButton('', t(isZh, '下移', 'Move down'), ICONS.down, () => move(1), idx === state.quickPhrases.length - 1),
            iconButton('', t(isZh, '编辑', 'Edit'), ICONS.edit, () => { editingId = phrase.id; editingValue = phrase.text; renderPage(); }),
            iconButton('rokbot-sug-settings__icon-btn--danger', t(isZh, '删除', 'Delete'), ICONS.trash, () => {
              void phraseCall(`/local/suggestions/phrases/${encodeURIComponent(phrase.id)}`, null, 'DELETE', t(isZh, '删除失败', 'Could not delete phrase'));
            }),
          );
          li.append(iconSpan, textSpan, actions);
        }
        list.appendChild(li);
      });
      return list;
    }

    function renderPage() {
      if (!page || !page.isConnected) return;
      const isZh = zh();
      const body = page.querySelector('[data-rokbot-suggestions-body]');
      const heading = page.querySelector('[data-rokbot-suggestions-title]');
      if (heading) heading.textContent = t(isZh, '输入建议', 'Input suggestions');
      if (!body) return;
      body.textContent = '';

      const section = (title, ...children) => {
        const wrap = doc.createElement('section');
        wrap.className = `${look.section ?? ''} rokbot-sug-settings__section`.trim();
        let h;
        if (look.title) {
          // The official section title row, with our text in its text element.
          h = look.title.cloneNode(true);
          h.querySelectorAll('button, input, select, a, svg').forEach(el => el.remove());
          const leaves = [...h.querySelectorAll('*')].filter(el => el.children.length === 0 && el.textContent.trim());
          if (leaves.length) {
            leaves[0].textContent = title;
            leaves.slice(1).forEach(el => el.remove());
          } else {
            h.textContent = title;
          }
          h.classList.add('rokbot-sug-settings__title-row');
        } else {
          h = doc.createElement('h3');
          h.className = 'rokbot-sug-settings__heading';
          h.textContent = title;
        }
        const card = doc.createElement('div');
        card.className = 'rokbot-sug-settings__card';
        if (look.card) card.classList.add('rokbot-sug-settings__card--official', ...look.card.split(/\s+/).filter(Boolean));
        card.append(...children);
        wrap.append(h, card);
        return wrap;
      };

      body.appendChild(section(
        t(isZh, '建议与补全', 'Suggestions and completion'),
        switchRow('rokbot-setting-suggestions-enabled', t(isZh, '输入建议', 'Input suggestions'),
          t(isZh, '输入框聚焦时显示常用语与快捷建议，点击直接发送', 'Show quick phrases and smart replies on focus; click to send'),
          state.enabled, false, () => save({ enabled: !state.enabled }, t(isZh, '保存失败', 'Could not save setting'))),
        switchRow('rokbot-setting-suggestions-ai-enabled', t(isZh, 'AI 生成建议', 'AI-generated suggestions'),
          t(isZh, '根据当前对话上下文由模型自动生成回复建议', 'Generate contextual reply suggestions from conversation history'),
          state.aiEnabled, !state.enabled, () => save({ aiEnabled: !state.aiEnabled }, t(isZh, '保存失败', 'Could not save setting'))),
        switchRow('rokbot-setting-completion-enabled', t(isZh, '输入补全', 'Inline completion'),
          t(isZh, '打字时以灰色文字预测后半句，按 Tab 或右方向键接受', 'Predict the rest of your sentence as gray text; press Tab or Right Arrow to accept'),
          state.completionEnabled, false, () => save({ completionEnabled: !state.completionEnabled }, t(isZh, '保存失败', 'Could not save setting'))),
      ));

      const phrases = doc.createElement('div');
      phrases.className = 'rokbot-sug-settings__phrases';
      const head = doc.createElement('div');
      head.className = 'rokbot-sug-settings__desc';
      head.textContent = t(isZh, '常用语显示在 AI 建议之前，在所有设备间同步。空会话仅显示常用语。',
        'Shown before AI suggestions and synced across devices. Empty chats only show quick phrases.');
      const addForm = doc.createElement('form');
      addForm.className = 'rokbot-sug-settings__add';
      const addInput = doc.createElement('input');
      addInput.type = 'text';
      addInput.className = 'rokbot-sug-settings__input';
      addInput.maxLength = 120;
      addInput.setAttribute('aria-label', t(isZh, '新增常用语', 'New quick phrase'));
      addInput.placeholder = t(isZh, '添加常用语，例如：继续、总结一下', 'Add a quick phrase, e.g. Continue, Summarize');
      const addBtn = doc.createElement('button');
      addBtn.type = 'submit';
      addBtn.className = 'rokbot-sug-settings__add-btn';
      addBtn.innerHTML = `${ICONS.plus}<span>${t(isZh, '添加', 'Add')}</span>`;
      addForm.append(addInput, addBtn);
      addForm.addEventListener('submit', async ev => {
        ev.preventDefault();
        const text = addInput.value.replace(/\s+/g, ' ').trim();
        if (!text) return;
        addBtn.disabled = true;
        try {
          if (await phraseCall('/local/suggestions/phrases', { text }, 'POST', t(isZh, '添加失败', 'Could not add phrase'))) addInput.value = '';
        } finally { addBtn.disabled = false; }
      });
      phrases.append(head, addForm);
      if (statusError) {
        const errEl = doc.createElement('p');
        errEl.className = 'rokbot-sug-settings__error';
        errEl.setAttribute('role', 'alert');
        errEl.textContent = statusError;
        phrases.appendChild(errEl);
      }
      phrases.appendChild(phraseList(isZh));
      body.appendChild(section(t(isZh, '自定义常用语', 'Quick phrases'), phrases));
    }

    const navItems = nav => [...nav.querySelectorAll(':scope > .sand-settings-nav__item')].filter(el => el !== navButton);
    const isOfficialActive = el => el.getAttribute('aria-current') === 'page' || el.getAttribute('data-active') === 'true';

    function buildNavButton(nav) {
      const items = navItems(nav);
      const template = items.find(el => !isOfficialActive(el)) ?? items[0];
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = template?.className || 'sand-settings-nav__item';
      btn.setAttribute('data-rokbot-suggestions-nav', '1');
      const icon = doc.createElement('span');
      icon.className = 'rokbot-sug-nav__icon';
      icon.innerHTML = ICONS.nav;
      const templateIcon = template?.querySelector('svg');
      if (templateIcon?.getAttribute('class')) icon.firstChild.setAttribute('class', templateIcon.getAttribute('class'));
      const label = doc.createElement('span');
      label.textContent = t(zh(), '输入建议', 'Input suggestions');
      btn.append(icon.firstChild, label);
      btn.addEventListener('click', () => openPage());
      return btn;
    }

    function placeNavButton(nav) {
      const items = navItems(nav);
      if (!items.length) return;
      // Right after General (the first entry), like the other app-wide preferences.
      const general = items.find(el => /^(general|通用|常规)$/i.test((el.textContent || '').trim())) ?? items[0];
      if (navButton.previousElementSibling !== general) general.after(navButton);
    }

    function openPage() {
      const layout = navButton?.closest('.sand-settings-layout');
      const panel = layout?.querySelector('.sand-settings-panel');
      if (!layout || !panel) return;
      open = true;
      const nav = navButton.parentElement;
      const official = navItems(nav).find(isOfficialActive);
      if (official && !swapped) {
        swapped = {
          el: official,
          className: official.className,
          ariaCurrent: official.getAttribute('aria-current'),
          dataActive: official.getAttribute('data-active'),
        };
        const inactive = navItems(nav).find(el => el !== official && !isOfficialActive(el));
        navButton.className = official.className;
        if (inactive) official.className = inactive.className;
        official.removeAttribute('aria-current');
        official.removeAttribute('data-active');
        const activeIcon = official.querySelector('svg')?.getAttribute('class');
        const inactiveIcon = inactive?.querySelector('svg')?.getAttribute('class');
        const ownIcon = navButton.querySelector('svg');
        if (ownIcon && activeIcon) ownIcon.setAttribute('class', activeIcon);
        if (inactiveIcon) official.querySelector('svg')?.setAttribute('class', inactiveIcon);
        swapped.activeIcon = activeIcon;
      }
      navButton.setAttribute('aria-current', 'page');
      navButton.setAttribute('data-active', 'true');
      mountPage(panel);
      if (!loadedOnce) void syncFromHost();
    }

    function closePage() {
      if (!open) return;
      open = false;
      if (swapped?.el?.isConnected) {
        const nav = navButton?.parentElement;
        const inactive = nav ? navItems(nav).find(el => el !== swapped.el && !isOfficialActive(el)) : null;
        swapped.el.className = swapped.className;
        if (swapped.ariaCurrent !== null) swapped.el.setAttribute('aria-current', swapped.ariaCurrent);
        if (swapped.dataActive !== null) swapped.el.setAttribute('data-active', swapped.dataActive);
        if (swapped.activeIcon) swapped.el.querySelector('svg')?.setAttribute('class', swapped.activeIcon);
        if (navButton && inactive) {
          navButton.className = inactive.className;
          const inactiveIcon = inactive.querySelector('svg')?.getAttribute('class');
          if (inactiveIcon) navButton.querySelector('svg')?.setAttribute('class', inactiveIcon);
        }
      }
      swapped = null;
      navButton?.removeAttribute('aria-current');
      navButton?.removeAttribute('data-active');
      page?.closest('.sand-settings-panel')?.classList.remove('rokbot-sug-page-open');
      page?.remove();
      page = null;
    }

    function mountPage(panel) {
      panel.classList.add('rokbot-sug-page-open');
      if (page && page.isConnected && page.parentElement === panel) { renderPage(); return; }
      page?.remove();
      page = doc.createElement('div');
      page.className = 'rokbot-sug-page';
      page.setAttribute('data-rokbot-suggestions-page', '1');
      page.setAttribute('role', 'region');
      // Reuse the official header and body containers so spacing and type match the other panes.
      const officialHeader = panel.querySelector(':scope > .sand-settings-pane-header, :scope > header, :scope > div:has(> h2)');
      const officialBody = panel.querySelector(':scope > .sand-settings-panel__body');
      const officialPane = officialBody?.querySelector('.sand-settings-pane');
      const officialSection = officialPane?.querySelector('section');
      look = {
        pane: officialPane?.getAttribute('class') ?? '',
        section: officialSection?.getAttribute('class') ?? '',
        title: officialSection?.children.length >= 2 ? officialSection.children[0] : null,
        card: officialSection?.children.length >= 2 ? officialSection.children[1].getAttribute('class') : '',
      };
      let header;
      if (officialHeader) {
        header = officialHeader.cloneNode(true);
        header.querySelectorAll('button, input, select, a').forEach(el => el.remove());
        header.removeAttribute('id');
        const h2 = header.querySelector('h2') ?? header;
        h2.removeAttribute('id');
        h2.setAttribute('data-rokbot-suggestions-title', '1');
        h2.textContent = '';
      } else {
        header = doc.createElement('div');
        header.className = 'rokbot-sug-page__header';
        const h2 = doc.createElement('h2');
        h2.setAttribute('data-rokbot-suggestions-title', '1');
        header.appendChild(h2);
      }
      header.classList.add('rokbot-sug-page__header');
      const body = doc.createElement('div');
      body.className = officialBody?.className || 'sand-settings-panel__body';
      body.classList.add('rokbot-sug-page__body');
      const pane = doc.createElement('div');
      pane.className = `${look.pane || 'sand-settings-pane'} rokbot-sug-settings`;
      pane.setAttribute('data-rokbot-suggestions-body', '1');
      body.appendChild(pane);
      page.append(header, body);
      const close = panel.firstElementChild;
      if (close && close.tagName === 'BUTTON') close.after(page); else panel.prepend(page);
      page.setAttribute('aria-label', t(zh(), '输入建议', 'Input suggestions'));
      renderPage();
    }

    function ensureMounted() {
      const nav = doc.querySelector('.sand-settings-layout .sand-settings-nav');
      if (!nav) {
        open = false;
        swapped = null;
        page = null;
        navButton = null;
        return;
      }
      if (!navButton || !navButton.isConnected || navButton.parentElement !== nav) {
        navButton?.remove();
        navButton = buildNavButton(nav);
      }
      placeNavButton(nav);
      if (open) {
        const panel = nav.closest('.sand-settings-layout')?.querySelector('.sand-settings-panel');
        if (panel && (!page || !page.isConnected)) mountPage(panel);
        // React re-rendered the official selected item: keep it looking unselected while the page is open.
        if (swapped?.el?.isConnected && isOfficialActive(swapped.el)) {
          swapped.el.removeAttribute('aria-current');
          swapped.el.removeAttribute('data-active');
        }
      }
    }

    // Any official entry closes the page (capture: before React handles the click).
    const onNavClick = ev => {
      const item = ev.target?.closest?.('.sand-settings-nav__item');
      if (!item || item === navButton || item.closest('[data-rokbot-suggestions-nav]')) return;
      closePage();
    };
    doc.addEventListener('click', onNavClick, true);

    const observer = new MutationObserver(mutations => {
      if (mutations.every(m => m.target instanceof Element && (m.target.closest('[data-rokbot-suggestions-page]') || m.target.closest('[data-rokbot-suggestions-nav]')))) return;
      ensureMounted();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    ensureMounted();

    return {
      updateState(next) { state = normalizeSettings(next); renderPage(); },
      open: openPage,
      close: closePage,
      get isOpen() { return open; },
      destroy() {
        observer.disconnect();
        doc.removeEventListener('click', onNavClick, true);
        closePage();
        navButton?.remove();
      },
    };
  }

  return {
    ICONS,
    COMPLETION_DEBOUNCE_MS,
    COMPLETION_MIN_CHARS,
    isZhLocale,
    countChars,
    normalizeSettings,
    mergeSuggestionItems,
    prefersReducedMotion,
    createLoadingMachine,
    createCompletionController,
    extractComposerText,
    composerDraft,
    insertSuggestionText,
    appendComposerText,
    sendSuggestionText,
    caretAtEnd,
    inspectTranscript,
    installComposerSuggestions,
    installSuggestionsSettingsPage,
  };
});

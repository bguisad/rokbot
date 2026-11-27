// Focus-activated, cached input-box suggestions and synced settings/quick-phrases UI
// for the Web client. Fetches contextual AI replies from POST /local/suggestions and
// syncs toggles & custom quick phrases with Host (/local/suggestions/settings & /phrases).
// Never displays hardcoded static preset suggestions.

const PHRASE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>';

const SPARKLE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 3l1.9 5.3L19 10.2l-5.1 1.9L12 17.5l-1.9-5.4L5 10.2l5.1-1.9L12 3z"/>'
  + '<path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"/></svg>';

const CLOSE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const UP_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"/></svg>';

const DOWN_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

const EDIT_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

const TRASH_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';

const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';

const PLUS_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
  + 'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

const MAX_CLIENT_CACHE = 60;
const FOCUS_FETCH_DEBOUNCE_MS = 100;
const DEFAULT_TIMEOUT_MS = 18_000;
const SETTINGS_SYNC_TTL_MS = 15_000;

export function isZhLocale(lang = globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '') {
  return String(lang).toLowerCase().startsWith('zh');
}

function t(zh, zhText, enText) {
  return zh ? zhText : enText;
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

function findSendButton(form) {
  if (!form || typeof form.querySelectorAll !== 'function') return null;
  const candidates = [
    ...form.querySelectorAll('button.sand-prompt-send, button[type="submit"], button[aria-label]'),
  ];
  for (const btn of candidates) {
    if (btn.disabled || btn.getAttribute?.('aria-disabled') === 'true') continue;
    const label = String(btn.getAttribute?.('aria-label') ?? '').toLowerCase();
    const isSendLabel = label.includes('send') || label.includes('发送') || label.includes('傳送');
    const isSubmit = btn.type === 'submit' || btn.getAttribute?.('type') === 'submit';
    if (isSendLabel || (btn.classList?.contains('sand-prompt-send') && isSubmit) || isSubmit) {
      if (label.includes('stop') || label.includes('停止') || label.includes('voice') || label.includes('语音') || label.includes('mic')) {
        continue;
      }
      return btn;
    }
  }
  return null;
}

export function sendSuggestionText(form, input, text, doc = globalThis.document, { schedule = fn => setTimeout(fn, 24) } = {}) {
  if (!insertSuggestionText(input, text, doc)) return false;

  const trySubmit = (attempt = 0) => {
    const btn = findSendButton(form);
    if (btn) {
      btn.click();
      return true;
    }
    if (attempt < 4 && typeof schedule === 'function') {
      schedule(() => trySubmit(attempt + 1));
      return false;
    }
    try {
      if (typeof form?.requestSubmit === 'function') {
        form.requestSubmit();
        return true;
      }
    } catch {}
    try {
      if (typeof KeyboardEvent === 'function') {
        input.dispatchEvent?.(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }));
        return true;
      }
    } catch {}
    return false;
  };

  if (typeof schedule === 'function') {
    schedule(() => trySubmit(0));
  } else {
    trySubmit(0);
  }
  return true;
}

export function mergeSuggestionItems(quickPhrases = [], aiSuggestions = []) {
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

function findComposerInput(form) {
  return form?.querySelector('[contenteditable="true"], textarea, input[type="text"]') ?? null;
}

function currentAgentId(doc = document, getViewingAgentId) {
  const selectors = [
    '.sand-agents-sidebar .sand-agent-item[aria-current="page"]',
    '.sand-agents-sidebar .sand-agent-item[data-active="true"]',
    '.sand-agents-sidebar .sand-agent-item[aria-selected="true"]',
    '.sand-agents-sidebar .sand-agent-item[aria-pressed="true"]',
  ];
  for (const sel of selectors) {
    const id = doc.querySelector(sel)?.dataset?.agentId;
    if (id) return id;
  }
  const tracked = typeof getViewingAgentId === 'function' ? getViewingAgentId() : '';
  return typeof tracked === 'string' ? tracked : '';
}

function extractVisibleMessages(doc = document) {
  const transcript = doc.querySelector('.sand-virtual-transcript');
  if (!transcript) return [];
  const anchors = [...transcript.querySelectorAll('.sand-message-action-anchor[data-role], [data-role="user"], [data-role="assistant"]')];
  const out = [];
  for (const el of anchors.slice(-6)) {
    const rawRole = String(el.getAttribute('data-role') || '').toLowerCase();
    const role = rawRole === 'user' ? 'user' : (rawRole === 'assistant' || rawRole === 'agent' || rawRole === 'bot' ? 'assistant' : '');
    if (!role) continue;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const id = el.getAttribute('data-entry-id') || el.getAttribute('data-message-id') || '';
    out.push({ id, role, text: text.slice(0, 500) });
  }
  return out;
}

function inspectTranscript(doc = document) {
  const transcript = doc.querySelector('.sand-virtual-transcript');
  if (!transcript) return { hasHistory: false, signature: 'empty', lastEntryId: '', streaming: false, recentMessages: [] };
  const items = [...transcript.querySelectorAll('[data-entry-id], [data-message-id], .sand-transcript-row, article, [role="article"]')];
  const stopBtn = doc.querySelector('.sand-prompt-form button[aria-label*="Stop" i], .sand-prompt-form button[aria-label*="停止"]');
  const streaming = Boolean(stopBtn);
  if (items.length === 0) {
    const raw = (transcript.textContent || '').trim();
    if (!raw) return { hasHistory: false, signature: 'empty', lastEntryId: '', streaming, recentMessages: [] };
    return {
      hasHistory: true,
      signature: `txt:${raw.length}:${raw.slice(-48)}`,
      lastEntryId: '',
      streaming,
      recentMessages: extractVisibleMessages(doc),
    };
  }
  const last = items[items.length - 1];
  const entryId = last.getAttribute('data-entry-id') || last.getAttribute('data-message-id') || '';
  const tailText = (last.textContent || '').replace(/\s+/g, ' ').trim().slice(-64);
  return {
    hasHistory: true,
    signature: `${items.length}:${entryId || tailText}`,
    lastEntryId: entryId,
    streaming,
    recentMessages: extractVisibleMessages(doc),
  };
}

function normalizeSettings(raw) {
  return {
    enabled: raw?.enabled !== false,
    aiEnabled: raw?.aiEnabled !== false,
    quickPhrases: Array.isArray(raw?.quickPhrases)
      ? raw.quickPhrases
        .map(item => ({ id: String(item?.id ?? ''), text: String(item?.text ?? '').trim() }))
        .filter(item => item.text.length > 0)
      : [],
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function isInputFocused(input, doc = document) {
  if (!input || !doc) return false;
  const active = doc.activeElement;
  if (!active) return false;
  return active === input || (typeof input.contains === 'function' && input.contains(active));
}

function isGeneralSettingsPane(panel) {
  if (!panel) return false;
  const layout = panel.closest('.sand-settings-layout');
  if (layout) {
    const activeNav = layout.querySelector(
      '.sand-settings-nav__item[aria-selected="true"], .sand-settings-nav__item[aria-current="page"], .sand-settings-nav__item[data-active="true"]',
    );
    if (activeNav) {
      const label = (activeNav.textContent || '').trim().toLowerCase();
      if (label && !label.includes('general') && !label.includes('通用') && !label.includes('常规')) {
        return false;
      }
    }
  }
  // Confirm we are on the General pane (theme / language / voice controls live here).
  if (panel.querySelector('#sand-setting-theme, #sand-setting-language, [data-rokbot-suggestions-settings]')) return true;
  const heading = panel.querySelector('.sand-settings-pane-header h2, h2');
  const title = (heading?.textContent || '').trim().toLowerCase();
  return title === 'general' || title === '通用' || title === '常规' || title === '';
}

export function installSuggestionsSettingsUI({ request, locale = '', getState, onStateChange } = {}) {
  if (typeof document === 'undefined' || typeof request !== 'function') return () => {};

  let state = normalizeSettings(getState?.() ?? {});
  let loading = false;
  let loadedOnce = false;
  let editingId = null;
  let editingValue = '';
  let statusError = '';
  let container = null;

  const zh = () => isZhLocale(document.documentElement.lang || locale);

  const applyState = next => {
    state = normalizeSettings(next);
    onStateChange?.(state);
    renderSection();
  };

  const syncFromHost = async () => {
    if (loading) return;
    loading = true;
    try {
      const res = await request('/local/suggestions/settings', null, undefined, 'GET');
      loadedOnce = true;
      statusError = '';
      applyState(res);
    } catch (err) {
      statusError = err?.message || t(zh(), '无法读取输入建议设置', 'Could not load suggestion settings');
      renderSection();
    } finally {
      loading = false;
    }
  };

  const renderSection = () => {
    if (!container || !container.isConnected) return;
    const isZh = zh();
    container.textContent = '';

    const heading = document.createElement('h3');
    heading.className = 'rokbot-sug-settings__heading';
    heading.textContent = t(isZh, '输入建议', 'Input suggestions');
    container.appendChild(heading);

    const card = document.createElement('div');
    card.className = 'rokbot-sug-settings__card';

    const makeSwitchRow = (id, labelText, descText, checked, disabled, onToggle) => {
      const row = document.createElement('div');
      row.className = 'rokbot-sug-settings__row';
      if (disabled) row.classList.add('rokbot-sug-settings__row--disabled');

      const copy = document.createElement('div');
      copy.className = 'rokbot-sug-settings__copy';
      const title = document.createElement('div');
      title.className = 'rokbot-sug-settings__label';
      title.textContent = labelText;
      const desc = document.createElement('div');
      desc.className = 'rokbot-sug-settings__desc';
      desc.textContent = descText;
      copy.append(title, desc);

      const sw = document.createElement('button');
      sw.type = 'button';
      sw.id = id;
      sw.className = 'rokbot-sug-settings__switch';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', labelText);
      sw.setAttribute('aria-checked', String(Boolean(checked)));
      sw.disabled = Boolean(disabled);
      const thumb = document.createElement('span');
      thumb.className = 'rokbot-sug-settings__switch-thumb';
      sw.appendChild(thumb);
      sw.addEventListener('click', () => { if (!disabled) void onToggle(); });

      row.append(copy, sw);
      return row;
    };

    card.appendChild(makeSwitchRow(
      'rokbot-setting-suggestions-enabled',
      t(isZh, '输入建议', 'Input suggestions'),
      t(isZh, '输入框聚焦时显示常用语与快捷建议，点击直接发送', 'Show quick phrases and smart replies on focus; click to send'),
      state.enabled,
      false,
      async () => {
        statusError = '';
        try {
          const updated = await request('/local/suggestions/settings', { enabled: !state.enabled }, undefined, 'PUT');
          applyState(updated);
        } catch (err) {
          statusError = err?.message || t(isZh, '保存失败', 'Could not save setting');
          renderSection();
        }
      },
    ));

    card.appendChild(makeSwitchRow(
      'rokbot-setting-suggestions-ai-enabled',
      t(isZh, 'AI 生成建议', 'AI-generated suggestions'),
      t(isZh, '根据当前对话上下文由模型自动生成回复建议', 'Generate contextual reply suggestions from conversation history'),
      state.aiEnabled,
      !state.enabled,
      async () => {
        statusError = '';
        try {
          const updated = await request('/local/suggestions/settings', { aiEnabled: !state.aiEnabled }, undefined, 'PUT');
          applyState(updated);
        } catch (err) {
          statusError = err?.message || t(isZh, '保存失败', 'Could not save setting');
          renderSection();
        }
      },
    ));

    // Quick Phrases management block
    const phrasesWrap = document.createElement('div');
    phrasesWrap.className = 'rokbot-sug-settings__phrases';

    const phrasesHead = document.createElement('div');
    phrasesHead.className = 'rokbot-sug-settings__phrases-head';
    const phrasesTitle = document.createElement('div');
    phrasesTitle.className = 'rokbot-sug-settings__label';
    phrasesTitle.textContent = t(isZh, '自定义常用语', 'Quick phrases');
    const phrasesDesc = document.createElement('div');
    phrasesDesc.className = 'rokbot-sug-settings__desc';
    phrasesDesc.textContent = t(
      isZh,
      '常用语显示在 AI 建议之前，在所有设备间同步。空会话仅显示常用语。',
      'Shown before AI suggestions and synced across devices. Empty chats only show quick phrases.',
    );
    phrasesHead.append(phrasesTitle, phrasesDesc);
    phrasesWrap.appendChild(phrasesHead);

    const addForm = document.createElement('form');
    addForm.className = 'rokbot-sug-settings__add';
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.className = 'rokbot-sug-settings__input';
    addInput.maxLength = 120;
    addInput.setAttribute('aria-label', t(isZh, '新增常用语', 'New quick phrase'));
    addInput.placeholder = t(isZh, '添加常用语，例如：继续、总结一下', 'Add a quick phrase, e.g. Continue, Summarize');

    const addBtn = document.createElement('button');
    addBtn.type = 'submit';
    addBtn.className = 'rokbot-sug-settings__add-btn';
    addBtn.innerHTML = `${PLUS_ICON}<span>${t(isZh, '添加', 'Add')}</span>`;

    addForm.append(addInput, addBtn);
    addForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const text = addInput.value.replace(/\s+/g, ' ').trim();
      if (!text) return;
      statusError = '';
      addBtn.disabled = true;
      try {
        const res = await request('/local/suggestions/phrases', { text }, undefined, 'POST');
        addInput.value = '';
        applyState({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
      } catch (err) {
        statusError = err?.message || t(isZh, '添加失败', 'Could not add phrase');
        renderSection();
      } finally {
        addBtn.disabled = false;
      }
    });
    phrasesWrap.appendChild(addForm);

    if (statusError) {
      const errEl = document.createElement('p');
      errEl.className = 'rokbot-sug-settings__error';
      errEl.setAttribute('role', 'alert');
      errEl.textContent = statusError;
      phrasesWrap.appendChild(errEl);
    }

    const list = document.createElement('ul');
    list.className = 'rokbot-sug-settings__list';

    if (state.quickPhrases.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'rokbot-sug-settings__empty';
      empty.textContent = t(isZh, '暂未添加常用语', 'No quick phrases yet');
      list.appendChild(empty);
    } else {
      state.quickPhrases.forEach((phrase, idx) => {
        const li = document.createElement('li');
        li.className = 'rokbot-sug-settings__item';
        li.dataset.phraseId = phrase.id;

        if (editingId === phrase.id) {
          const editForm = document.createElement('form');
          editForm.className = 'rokbot-sug-settings__edit-form';
          const editInput = document.createElement('input');
          editInput.type = 'text';
          editInput.className = 'rokbot-sug-settings__input';
          editInput.maxLength = 120;
          editInput.value = editingValue;
          editInput.setAttribute('aria-label', t(isZh, '编辑常用语', 'Edit quick phrase'));
          editInput.addEventListener('input', () => { editingValue = editInput.value; });

          const saveBtn = document.createElement('button');
          saveBtn.type = 'submit';
          saveBtn.className = 'rokbot-sug-settings__icon-btn rokbot-sug-settings__icon-btn--primary';
          saveBtn.setAttribute('aria-label', t(isZh, '保存', 'Save'));
          saveBtn.innerHTML = CHECK_ICON;

          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'rokbot-sug-settings__icon-btn';
          cancelBtn.setAttribute('aria-label', t(isZh, '取消', 'Cancel'));
          cancelBtn.innerHTML = CLOSE_ICON;
          cancelBtn.addEventListener('click', () => {
            editingId = null;
            editingValue = '';
            renderSection();
          });

          editForm.append(editInput, saveBtn, cancelBtn);
          editForm.addEventListener('submit', async ev => {
            ev.preventDefault();
            const text = editInput.value.replace(/\s+/g, ' ').trim();
            if (!text) return;
            statusError = '';
            try {
              const res = await request(`/local/suggestions/phrases/${encodeURIComponent(phrase.id)}`, { text }, undefined, 'PUT');
              editingId = null;
              editingValue = '';
              applyState({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
            } catch (err) {
              statusError = err?.message || t(isZh, '保存失败', 'Could not update phrase');
              renderSection();
            }
          });
          li.appendChild(editForm);
          setTimeout(() => { try { editInput.focus(); editInput.select(); } catch {} }, 0);
        } else {
          const iconSpan = document.createElement('span');
          iconSpan.className = 'rokbot-sug-settings__item-icon';
          iconSpan.innerHTML = PHRASE_ICON;

          const textSpan = document.createElement('span');
          textSpan.className = 'rokbot-sug-settings__item-text';
          textSpan.textContent = phrase.text;

          const actions = document.createElement('div');
          actions.className = 'rokbot-sug-settings__item-actions';

          const move = async delta => {
            const targetIdx = idx + delta;
            if (targetIdx < 0 || targetIdx >= state.quickPhrases.length) return;
            const ids = state.quickPhrases.map(item => item.id);
            [ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]];
            statusError = '';
            try {
              const res = await request('/local/suggestions/phrases/reorder', { ids }, undefined, 'PUT');
              applyState({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
            } catch (err) {
              statusError = err?.message || t(isZh, '排序失败', 'Could not reorder phrases');
              renderSection();
            }
          };

          const upBtn = document.createElement('button');
          upBtn.type = 'button';
          upBtn.className = 'rokbot-sug-settings__icon-btn';
          upBtn.disabled = idx === 0;
          upBtn.setAttribute('aria-label', t(isZh, '上移', 'Move up'));
          upBtn.innerHTML = UP_ICON;
          upBtn.addEventListener('click', () => { void move(-1); });

          const downBtn = document.createElement('button');
          downBtn.type = 'button';
          downBtn.className = 'rokbot-sug-settings__icon-btn';
          downBtn.disabled = idx === state.quickPhrases.length - 1;
          downBtn.setAttribute('aria-label', t(isZh, '下移', 'Move down'));
          downBtn.innerHTML = DOWN_ICON;
          downBtn.addEventListener('click', () => { void move(1); });

          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'rokbot-sug-settings__icon-btn';
          editBtn.setAttribute('aria-label', t(isZh, '编辑', 'Edit'));
          editBtn.innerHTML = EDIT_ICON;
          editBtn.addEventListener('click', () => {
            editingId = phrase.id;
            editingValue = phrase.text;
            renderSection();
          });

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'rokbot-sug-settings__icon-btn rokbot-sug-settings__icon-btn--danger';
          delBtn.setAttribute('aria-label', t(isZh, '删除', 'Delete'));
          delBtn.innerHTML = TRASH_ICON;
          delBtn.addEventListener('click', async () => {
            statusError = '';
            try {
              const res = await request(`/local/suggestions/phrases/${encodeURIComponent(phrase.id)}`, null, undefined, 'DELETE');
              applyState({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
            } catch (err) {
              statusError = err?.message || t(isZh, '删除失败', 'Could not delete phrase');
              renderSection();
            }
          });

          actions.append(upBtn, downBtn, editBtn, delBtn);
          li.append(iconSpan, textSpan, actions);
        }
        list.appendChild(li);
      });
    }

    phrasesWrap.appendChild(list);
    card.appendChild(phrasesWrap);
    container.appendChild(card);
  };

  const ensureMounted = () => {
    const panel = document.querySelector('.sand-settings-panel');
    if (!panel || !isGeneralSettingsPane(panel)) {
      if (container && container.isConnected) container.remove();
      return;
    }
    const existing = panel.querySelector('[data-rokbot-suggestions-settings]');
    if (existing) {
      container = existing;
      if (!loadedOnce && !loading) void syncFromHost();
      return;
    }
    const pane = panel.querySelector('.sand-settings-pane') || panel.querySelector('.sand-settings-panel__body') || panel;
    container = document.createElement('section');
    container.className = 'rokbot-sug-settings';
    container.setAttribute('data-rokbot-suggestions-settings', '1');
    pane.appendChild(container);
    renderSection();
    void syncFromHost();
  };

  const observer = new MutationObserver(mutations => {
    if (mutations.every(m => m.target instanceof Element && m.target.closest('[data-rokbot-suggestions-settings]'))) return;
    ensureMounted();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'aria-current', 'data-active'],
  });
  ensureMounted();

  return {
    updateState(next) {
      state = normalizeSettings(next);
      renderSection();
    },
    destroy() {
      observer.disconnect();
      container?.remove();
    },
  };
}

export function installComposerSuggestions({
  request,
  locale = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  getViewingAgentId,
  installSettings = true,
} = {}) {
  if (typeof document === 'undefined' || typeof request !== 'function') return () => {};

  const aiCache = new Map();
  let settingsState = normalizeSettings({ enabled: true, aiEnabled: true, quickPhrases: [] });
  let settingsSyncedAt = 0;
  let settingsInFlight = null;

  let bar = null;
  let currentKey = '';
  let dismissedKey = '';
  let activeAiSuggestions = [];
  let debounceTimer = 0;
  let requestSeq = 0;
  let observedInput = null;
  let observedForm = null;
  let composerFocused = false;
  let suppressUntilRefocus = false;
  let settingsUi = null;

  const setCachedAi = (key, items) => {
    aiCache.delete(key);
    aiCache.set(key, items);
    while (aiCache.size > MAX_CLIENT_CACHE) {
      const oldest = aiCache.keys().next().value;
      if (oldest === undefined) break;
      aiCache.delete(oldest);
    }
  };

  const syncSettings = async (force = false) => {
    const now = Date.now();
    if (!force && settingsSyncedAt && now - settingsSyncedAt < SETTINGS_SYNC_TTL_MS) {
      return settingsState;
    }
    if (settingsInFlight) return settingsInFlight;
    settingsInFlight = (async () => {
      try {
        const res = await request('/local/suggestions/settings', null, undefined, 'GET');
        settingsState = normalizeSettings(res);
        settingsSyncedAt = Date.now();
        settingsUi?.updateState(settingsState);
      } catch {}
      return settingsState;
    })().finally(() => { settingsInFlight = null; });
    return settingsInFlight;
  };

  const ensureBar = () => {
    if (bar) return bar;
    const zh = isZhLocale(document.documentElement.lang || locale);
    bar = document.createElement('div');
    bar.className = 'rokbot-suggestions';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', t(zh, '输入建议', 'Suggested replies'));
    bar.hidden = true;
    // Prevent mousedown on pills or close button from blurring the composer before click fires.
    bar.addEventListener('mousedown', ev => { ev.preventDefault(); });
    return bar;
  };

  const computeVisibleItems = () => {
    if (!settingsState.enabled) return [];
    const ai = settingsState.aiEnabled ? activeAiSuggestions : [];
    return mergeSuggestionItems(settingsState.quickPhrases, ai);
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
    attachComposerListeners(form, input);

    const focusedNow = !suppressUntilRefocus && (composerFocused || isInputFocused(input, document));
    const hasDraft = extractComposerText(input).length > 0;
    const items = computeVisibleItems();

    if (!focusedNow || !settingsState.enabled || hasDraft || dismissedKey === currentKey || items.length === 0) {
      el.hidden = true;
      return;
    }

    const zh = isZhLocale(document.documentElement.lang || locale);
    el.setAttribute('aria-label', t(zh, '输入建议', 'Suggested replies'));
    el.hidden = false;
    el.textContent = '';

    const scroller = document.createElement('div');
    scroller.className = 'rokbot-suggestions__list';

    for (const item of items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `rokbot-suggestions__chip rokbot-suggestions__chip--${item.type}`;
      chip.dataset.suggestionType = item.type;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'rokbot-suggestions__chip-icon';
      iconSpan.innerHTML = item.type === 'phrase' ? PHRASE_ICON : SPARKLE_ICON;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'rokbot-suggestions__chip-text';
      labelSpan.textContent = item.text;

      chip.append(iconSpan, labelSpan);
      chip.addEventListener('click', () => {
        const liveForm = document.querySelector('.sand-prompt-form');
        const target = findComposerInput(liveForm);
        composerFocused = false;
        suppressUntilRefocus = true;
        el.hidden = true;
        sendSuggestionText(liveForm, target, item.text, document);
      });
      scroller.appendChild(chip);
    }
    el.appendChild(scroller);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'rokbot-suggestions__dismiss';
    dismiss.setAttribute('aria-label', t(zh, '隐藏建议', 'Dismiss suggestions'));
    dismiss.innerHTML = CLOSE_ICON;
    dismiss.addEventListener('click', () => {
      dismissedKey = currentKey;
      renderBar();
    });
    el.appendChild(dismiss);
  };

  const fetchSuggestions = async (agentId, state, key) => {
    const seq = ++requestSeq;
    const cfg = await syncSettings(false);
    if (seq !== requestSeq || !composerFocused) return;
    if (!cfg.enabled) {
      activeAiSuggestions = [];
      renderBar();
      return;
    }
    if (!cfg.aiEnabled || !state.hasHistory) {
      activeAiSuggestions = [];
      renderBar();
      return;
    }
    const cached = aiCache.get(key);
    if (cached) {
      activeAiSuggestions = cached;
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
        ...(state.recentMessages?.length ? { recentMessages: state.recentMessages } : {}),
      }, controller.signal, 'POST');
      if (seq !== requestSeq) return;
      if (res && typeof res.enabled === 'boolean') {
        settingsState = normalizeSettings({
          enabled: res.enabled,
          aiEnabled: res.aiEnabled,
          quickPhrases: res.quickPhrases ?? settingsState.quickPhrases,
          updatedAt: settingsState.updatedAt,
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
      } else {
        activeAiSuggestions = [];
      }
      renderBar();
    } catch {
      if (seq !== requestSeq) return;
      // Silent failure: never fall back to static presets; custom quick phrases remain visible.
      activeAiSuggestions = [];
      renderBar();
    } finally {
      clearTimeout(timer);
    }
  };

  const triggerIfFocused = () => {
    const form = document.querySelector('.sand-prompt-form');
    if (!form) {
      if (bar) bar.hidden = true;
      return;
    }
    const input = findComposerInput(form);
    attachComposerListeners(form, input);

    const agentId = currentAgentId(document, getViewingAgentId);
    const state = inspectTranscript(document);
    const langKey = isZhLocale(document.documentElement.lang || locale) ? 'zh' : 'en';
    const nextKey = `${agentId}:${state.signature}:${langKey}`;

    if (nextKey !== currentKey) {
      currentKey = nextKey;
      activeAiSuggestions = aiCache.get(nextKey) ?? [];
    }

    const focusedNow = !suppressUntilRefocus && (composerFocused || isInputFocused(input, document));
    if (!focusedNow || extractComposerText(input).length > 0 || dismissedKey === currentKey) {
      renderBar();
      return;
    }

    // Show immediately with any quick phrases or cached AI items while fetching fresh AI suggestions.
    renderBar();

    if (state.streaming) return;

    clearTimeout(debounceTimer);
    if (!settingsSyncedAt) {
      void syncSettings(true).then(() => {
        if (!composerFocused) return;
        renderBar();
        if (settingsState.enabled && settingsState.aiEnabled && state.hasHistory && !aiCache.has(currentKey)) {
          void fetchSuggestions(agentId, state, currentKey);
        }
      });
      return;
    }

    if (!settingsState.enabled || !settingsState.aiEnabled || !state.hasHistory || aiCache.has(currentKey)) {
      return;
    }

    debounceTimer = setTimeout(() => {
      if (composerFocused) {
        void fetchSuggestions(agentId, state, currentKey);
      }
    }, FOCUS_FETCH_DEBOUNCE_MS);
  };

  const onInputFocus = ev => {
    if (suppressUntilRefocus && ev?.isTrusted === false) return;
    suppressUntilRefocus = false;
    composerFocused = true;
    triggerIfFocused();
  };

  const onInputPointerDown = () => {
    if (suppressUntilRefocus) {
      suppressUntilRefocus = false;
      composerFocused = true;
      triggerIfFocused();
    }
  };

  const onInputBlur = ev => {
    const nextTarget = ev?.relatedTarget;
    if (nextTarget && bar && bar.contains(nextTarget)) return;
    composerFocused = false;
    suppressUntilRefocus = false;
    clearTimeout(debounceTimer);
    renderBar();
  };

  const onInputChange = () => {
    renderBar();
    const form = document.querySelector('.sand-prompt-form');
    const input = findComposerInput(form);
    if (!suppressUntilRefocus && composerFocused && extractComposerText(input).length === 0) {
      triggerIfFocused();
    }
  };

  function attachComposerListeners(form, input) {
    if (form && form !== observedForm) {
      observedForm = form;
      form.addEventListener('focusin', onInputFocus);
      form.addEventListener('focusout', onInputBlur);
    }
    if (input && input !== observedInput) {
      observedInput = input;
      input.addEventListener('focus', onInputFocus);
      input.addEventListener('blur', onInputBlur);
      input.addEventListener('pointerdown', onInputPointerDown);
      input.addEventListener('input', onInputChange);
      input.addEventListener('keyup', onInputChange);
    }
  }

  if (installSettings) {
    settingsUi = installSuggestionsSettingsUI({
      request,
      locale,
      getState: () => settingsState,
      onStateChange: next => {
        settingsState = normalizeSettings(next);
        settingsSyncedAt = Date.now();
        if (!settingsState.enabled || !settingsState.aiEnabled) {
          activeAiSuggestions = [];
        }
        renderBar();
        if (composerFocused && settingsState.enabled && settingsState.aiEnabled) {
          triggerIfFocused();
        }
      },
    });
  }

  // Prime settings quietly on startup (tiny GET, no LLM call) so phrases appear instantaneously on first focus.
  void syncSettings(true);

  const observer = new MutationObserver(mutations => {
    if (mutations.every(m => m.target instanceof Element && (m.target.closest('.rokbot-suggestions') || m.target.closest('[data-rokbot-suggestions-settings]')))) {
      return;
    }
    triggerIfFocused();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-current', 'data-active', 'aria-selected'],
  });
  triggerIfFocused();

  return () => {
    clearTimeout(debounceTimer);
    observer.disconnect();
    settingsUi?.destroy();
    bar?.remove();
  };
}

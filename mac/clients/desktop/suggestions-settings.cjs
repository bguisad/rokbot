// Loaded by the desktop preload (macOS, Windows, Linux). Injects the synced
// Input Suggestions settings section (master toggle, AI toggle, and Quick Phrases
// CRUD + reorder) into the General settings panel, matching existing settings styling.
(() => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (typeof window === 'undefined' || window !== window.top) return;
  let ipcRenderer;
  try { ({ ipcRenderer } = require('electron')); } catch { return; }
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return;

  const PHRASE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>';
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
  const CLOSE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const PLUS_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
    + 'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

  const isZh = () => {
    let lang = '';
    try { lang = document.documentElement?.lang || ipcRenderer.sendSync('rokbot-local:locale') || navigator.language || ''; } catch {}
    return String(lang).toLowerCase().startsWith('zh');
  };
  const tr = (zhText, enText) => (isZh() ? zhText : enText);

  const normalize = raw => ({
    enabled: raw?.enabled !== false,
    aiEnabled: raw?.aiEnabled !== false,
    quickPhrases: Array.isArray(raw?.quickPhrases)
      ? raw.quickPhrases
        .map(item => ({ id: String(item?.id ?? ''), text: String(item?.text ?? '').trim() }))
        .filter(item => item.text.length > 0)
      : [],
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
  });

  function isGeneralPane(panel) {
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
    if (panel.querySelector('#sand-setting-theme, #sand-setting-language, [data-rokbot-suggestions-settings]')) return true;
    const heading = panel.querySelector('.sand-settings-pane-header h2, h2');
    const title = (heading?.textContent || '').trim().toLowerCase();
    return title === 'general' || title === '通用' || title === '常规' || title === '';
  }

  let state = normalize({});
  let loading = false;
  let loadedOnce = false;
  let editingId = null;
  let editingValue = '';
  let statusError = '';
  let container = null;

  async function syncFromHost() {
    if (loading) return;
    loading = true;
    try {
      const res = await ipcRenderer.invoke('rokbot-local:suggestions-settings-get');
      loadedOnce = true;
      statusError = '';
      state = normalize(res);
      render();
    } catch (err) {
      statusError = err?.message || tr('无法读取输入建议设置', 'Could not load suggestion settings');
      render();
    } finally {
      loading = false;
    }
  }

  function render() {
    if (!container || !container.isConnected) return;
    container.textContent = '';

    const heading = document.createElement('h3');
    heading.className = 'rokbot-sug-settings__heading';
    heading.textContent = tr('输入建议', 'Input suggestions');
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
      tr('输入建议', 'Input suggestions'),
      tr('各端同步的输入建议总开关', 'Master toggle for input suggestions synced across devices'),
      state.enabled,
      false,
      async () => {
        statusError = '';
        try {
          state = normalize(await ipcRenderer.invoke('rokbot-local:suggestions-settings-put', { enabled: !state.enabled }));
          render();
        } catch (err) {
          statusError = err?.message || tr('保存失败', 'Could not save setting');
          render();
        }
      },
    ));

    card.appendChild(makeSwitchRow(
      'rokbot-setting-suggestions-ai-enabled',
      tr('AI 生成建议', 'AI-generated suggestions'),
      tr('根据当前对话上下文由模型自动生成回复建议', 'Generate contextual reply suggestions from conversation history'),
      state.aiEnabled,
      !state.enabled,
      async () => {
        statusError = '';
        try {
          state = normalize(await ipcRenderer.invoke('rokbot-local:suggestions-settings-put', { aiEnabled: !state.aiEnabled }));
          render();
        } catch (err) {
          statusError = err?.message || tr('保存失败', 'Could not save setting');
          render();
        }
      },
    ));

    const phrasesWrap = document.createElement('div');
    phrasesWrap.className = 'rokbot-sug-settings__phrases';

    const phrasesHead = document.createElement('div');
    phrasesHead.className = 'rokbot-sug-settings__phrases-head';
    const phrasesTitle = document.createElement('div');
    phrasesTitle.className = 'rokbot-sug-settings__label';
    phrasesTitle.textContent = tr('自定义常用语', 'Quick phrases');
    const phrasesDesc = document.createElement('div');
    phrasesDesc.className = 'rokbot-sug-settings__desc';
    phrasesDesc.textContent = tr(
      '在所有设备间同步。常用语显示在 AI 建议之前，空会话仅显示常用语。',
      'Synced across devices. Shown before AI suggestions; empty chats only show quick phrases.',
    );
    phrasesHead.append(phrasesTitle, phrasesDesc);
    phrasesWrap.appendChild(phrasesHead);

    const addForm = document.createElement('form');
    addForm.className = 'rokbot-sug-settings__add';
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.className = 'rokbot-sug-settings__input';
    addInput.maxLength = 120;
    addInput.setAttribute('aria-label', tr('新增常用语', 'New quick phrase'));
    addInput.placeholder = tr('添加常用语，例如：继续、总结一下', 'Add a quick phrase, e.g. Continue, Summarize');

    const addBtn = document.createElement('button');
    addBtn.type = 'submit';
    addBtn.className = 'rokbot-sug-settings__add-btn';
    addBtn.innerHTML = `${PLUS_ICON}<span>${tr('添加', 'Add')}</span>`;
    addForm.append(addInput, addBtn);
    addForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const text = addInput.value.replace(/\s+/g, ' ').trim();
      if (!text) return;
      statusError = '';
      addBtn.disabled = true;
      try {
        const res = await ipcRenderer.invoke('rokbot-local:suggestions-phrase-add', { text });
        addInput.value = '';
        state = normalize({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
        render();
      } catch (err) {
        statusError = err?.message || tr('添加失败', 'Could not add phrase');
        render();
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
      empty.textContent = tr('暂未添加常用语', 'No quick phrases yet');
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
          editInput.addEventListener('input', () => { editingValue = editInput.value; });

          const saveBtn = document.createElement('button');
          saveBtn.type = 'submit';
          saveBtn.className = 'rokbot-sug-settings__icon-btn rokbot-sug-settings__icon-btn--primary';
          saveBtn.setAttribute('aria-label', tr('保存', 'Save'));
          saveBtn.innerHTML = CHECK_ICON;

          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'rokbot-sug-settings__icon-btn';
          cancelBtn.setAttribute('aria-label', tr('取消', 'Cancel'));
          cancelBtn.innerHTML = CLOSE_ICON;
          cancelBtn.addEventListener('click', () => { editingId = null; editingValue = ''; render(); });

          editForm.append(editInput, saveBtn, cancelBtn);
          editForm.addEventListener('submit', async ev => {
            ev.preventDefault();
            const text = editInput.value.replace(/\s+/g, ' ').trim();
            if (!text) return;
            statusError = '';
            try {
              const res = await ipcRenderer.invoke('rokbot-local:suggestions-phrase-update', { id: phrase.id, text });
              editingId = null;
              editingValue = '';
              state = normalize({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
              render();
            } catch (err) {
              statusError = err?.message || tr('保存失败', 'Could not update phrase');
              render();
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
              const res = await ipcRenderer.invoke('rokbot-local:suggestions-phrase-reorder', { ids });
              state = normalize({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
              render();
            } catch (err) {
              statusError = err?.message || tr('排序失败', 'Could not reorder phrases');
              render();
            }
          };

          const upBtn = document.createElement('button');
          upBtn.type = 'button';
          upBtn.className = 'rokbot-sug-settings__icon-btn';
          upBtn.disabled = idx === 0;
          upBtn.setAttribute('aria-label', tr('上移', 'Move up'));
          upBtn.innerHTML = UP_ICON;
          upBtn.addEventListener('click', () => { void move(-1); });

          const downBtn = document.createElement('button');
          downBtn.type = 'button';
          downBtn.className = 'rokbot-sug-settings__icon-btn';
          downBtn.disabled = idx === state.quickPhrases.length - 1;
          downBtn.setAttribute('aria-label', tr('下移', 'Move down'));
          downBtn.innerHTML = DOWN_ICON;
          downBtn.addEventListener('click', () => { void move(1); });

          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'rokbot-sug-settings__icon-btn';
          editBtn.setAttribute('aria-label', tr('编辑', 'Edit'));
          editBtn.innerHTML = EDIT_ICON;
          editBtn.addEventListener('click', () => { editingId = phrase.id; editingValue = phrase.text; render(); });

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'rokbot-sug-settings__icon-btn rokbot-sug-settings__icon-btn--danger';
          delBtn.setAttribute('aria-label', tr('删除', 'Delete'));
          delBtn.innerHTML = TRASH_ICON;
          delBtn.addEventListener('click', async () => {
            statusError = '';
            try {
              const res = await ipcRenderer.invoke('rokbot-local:suggestions-phrase-delete', { id: phrase.id });
              state = normalize({ ...state, quickPhrases: res.quickPhrases, updatedAt: res.updatedAt });
              render();
            } catch (err) {
              statusError = err?.message || tr('删除失败', 'Could not delete phrase');
              render();
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
  }

  function ensureMounted() {
    const panel = document.querySelector('.sand-settings-panel');
    if (!panel || !isGeneralPane(panel)) {
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
    render();
    void syncFromHost();
  }

  function start() {
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
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

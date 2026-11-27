// Group chat creation dialog for the Web client and desktop apps (macOS, Windows, Linux).
// One implementation, two loaders:
//   - desktop: `require('./group-create.cjs')` from preload (group-create-loader.cjs),
//     talking to the Host through the main process (rokbot-local:group-* / open-agent IPC);
//   - Web: packaged as client/desktop/group-create.js and imported by bridge.js
//     (globalThis.RokBotGroupCreate), talking to the Host through gateway.command().
// Pure helpers have no DOM dependency and are exported for unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.RokBotGroupCreate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_GROUP_BOTS = 6;
  const MAX_GROUP_NAME_LENGTH = 72;

  const STYLE_ATTR = 'data-rokbot-group-create-style';
  const BTN_ATTR = 'data-rokbot-group-create';
  const NEW_BOT_SELECTOR = 'button[aria-label="New Bot"], button[aria-label="新建 Bot"], button[aria-label="新建Bot"]';
  const SKIP_CONTAINER_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .rokbot-group-create__backdrop';

  const ICON_GROUP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>'
    + '<circle cx="9" cy="7" r="4"/>'
    + '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'
    + '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
    + '</svg>';

  const ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M6 6l12 12M18 6L6 18"/>'
    + '</svg>';

  const ICON_SEARCH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="11" cy="11" r="7"/>'
    + '<path d="M20 20l-3.5-3.5"/>'
    + '</svg>';

  const AVATAR_PALETTE = {
    blue: '#3b82f6',
    green: '#10b981',
    purple: '#8b5cf6',
    violet: '#8b5cf6',
    indigo: '#6366f1',
    pink: '#ec4899',
    rose: '#f43f5e',
    red: '#ef4444',
    orange: '#f97316',
    amber: '#f59e0b',
    yellow: '#eab308',
    teal: '#14b8a6',
    cyan: '#06b6d4',
    slate: '#64748b',
    gray: '#6b7280',
  };
  const FALLBACK_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f97316', '#ec4899', '#14b8a6', '#6366f1', '#f43f5e'];

  // ---- pure helpers (no DOM) ----------------------------------------------------------------

  function isZhLocale(lang) {
    const value = lang ?? (globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '');
    return String(value).toLowerCase().startsWith('zh');
  }

  function t(zh, zhText, enText) {
    return zh ? zhText : enText;
  }

  function normalizeGroupName(raw) {
    if (typeof raw !== 'string') return '';
    const collapsed = raw.trim().replace(/\s+/g, ' ');
    if (collapsed.length <= MAX_GROUP_NAME_LENGTH) return collapsed;
    return collapsed.slice(0, MAX_GROUP_NAME_LENGTH).trim();
  }

  function eligibleBots(agents) {
    const list = Array.isArray(agents)
      ? agents
      : (agents && typeof agents === 'object' && Array.isArray(agents.agents) ? agents.agents : []);
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.isGroup || raw.isHiddenFromSidebar) continue;
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const rawName = typeof raw.name === 'string' ? raw.name.trim() : '';
      out.push({
        id,
        name: rawName || id,
        title: typeof raw.title === 'string' ? raw.title.trim() : '',
        description: typeof raw.description === 'string' ? raw.description.trim() : '',
        avatarDataUrl: typeof raw.avatarDataUrl === 'string' ? raw.avatarDataUrl.trim() : '',
        avatarColor: typeof raw.avatarColor === 'string' ? raw.avatarColor.trim() : '',
        avatarShape: typeof raw.avatarShape === 'string' ? raw.avatarShape.trim() : '',
        isGroup: false,
        isHiddenFromSidebar: false,
      });
    }
    return out;
  }

  function filterBots(bots, query) {
    const list = Array.isArray(bots) ? bots : [];
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!q) return list.slice();
    const tokens = q.split(/\s+/).filter(Boolean);
    return list.filter(bot => {
      if (!bot || typeof bot !== 'object') return false;
      const haystack = `${bot.name ?? ''} ${bot.title ?? ''} ${bot.description ?? ''}`.toLowerCase();
      return tokens.every(tok => haystack.includes(tok));
    });
  }

  function formatList(names, zh) {
    const clean = [];
    for (const item of Array.isArray(names) ? names : []) {
      const text = typeof item === 'string' ? item.trim() : '';
      if (text) clean.push(text);
    }
    const n = clean.length;
    if (n === 0) return '';
    if (n === 1) return clean[0];
    if (n === 2) return zh ? `${clean[0]}和${clean[1]}` : `${clean[0]} and ${clean[1]}`;
    if (zh) return `${clean.slice(0, -1).join('、')}和${clean[n - 1]}`;
    return `${clean.slice(0, -1).join(', ')}, and ${clean[n - 1]}`;
  }

  function autoGroupName(selectedBots, zh) {
    const names = [];
    for (const bot of Array.isArray(selectedBots) ? selectedBots : []) {
      if (typeof bot === 'string') {
        if (bot.trim()) names.push(bot.trim());
      } else if (bot && typeof bot === 'object') {
        const label = (typeof bot.name === 'string' && bot.name.trim())
          ? bot.name.trim()
          : (typeof bot.id === 'string' ? bot.id.trim() : '');
        if (label) names.push(label);
      }
    }
    return normalizeGroupName(formatList(names, Boolean(zh)));
  }

  function canSubmit(selected, submitting) {
    if (submitting) return false;
    const count = Array.isArray(selected)
      ? selected.length
      : (selected && typeof selected.size === 'number' ? selected.size : 0);
    return count >= 1 && count <= MAX_GROUP_BOTS;
  }

  function createGroupBody(name, memberIds) {
    const seen = new Set();
    const memberAgentIds = [];
    for (const raw of Array.isArray(memberIds) ? memberIds : []) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      memberAgentIds.push(id);
    }
    return {
      name: normalizeGroupName(name),
      description: '',
      memberAgentIds,
    };
  }

  function groupIdFromReply(reply) {
    if (!reply || typeof reply !== 'object') return '';
    const nested = reply.agent && typeof reply.agent === 'object' ? reply.agent.id : undefined;
    const raw = (typeof nested === 'string' && nested.trim()) ? nested : reply.id;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  }

  function isSafeAvatarUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    return /^(?:data:image\/[a-z0-9.+-]+;base64,|https?:\/\/|blob:|\/)/i.test(url);
  }

  function avatarFillColor(bot) {
    const raw = String(bot?.avatarColor ?? '').trim();
    if (/^#[0-9a-f]{3,8}$/i.test(raw)) return raw;
    const mapped = AVATAR_PALETTE[raw.toLowerCase()];
    if (mapped) return mapped;
    const seed = String(bot?.id || bot?.name || 'B');
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
  }

  function avatarInitial(name) {
    const text = String(name ?? '').trim();
    if (!text) return 'B';
    const first = [...text][0] || 'B';
    return first.toUpperCase();
  }

  // ---- styles -------------------------------------------------------------------------------

  const CSS = `
.rokbot-group-create__backdrop {
  --rgc-bg: var(--sand-bg-elevated, #ffffff);
  --rgc-surface: var(--sand-bg-secondary, rgba(24, 24, 27, 0.04));
  --rgc-hover: var(--sand-bg-hover, rgba(24, 24, 27, 0.06));
  --rgc-selected: rgba(24, 24, 27, 0.08);
  --rgc-border: var(--sand-border-secondary-translucent, rgba(24, 24, 27, 0.12));
  --rgc-border-strong: rgba(24, 24, 27, 0.24);
  --rgc-text: var(--sand-text-primary, var(--rokbot-label, #18181b));
  --rgc-text-muted: var(--sand-text-secondary, var(--rokbot-label-2, #71717a));
  --rgc-primary-bg: #18181b;
  --rgc-primary-fg: #ffffff;
  --rgc-primary-hover: #27272a;
  --rgc-danger-bg: rgba(220, 38, 38, 0.08);
  --rgc-danger-border: rgba(220, 38, 38, 0.28);
  --rgc-danger-text: #dc2626;
  --rgc-shadow: 0 20px 48px rgba(0, 0, 0, 0.18), 0 4px 12px rgba(0, 0, 0, 0.08);

  position: fixed;
  inset: 0;
  z-index: 2147483050;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(2px);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: var(--rgc-text);
}

@media (prefers-color-scheme: dark) {
  .rokbot-group-create__backdrop {
    --rgc-bg: var(--sand-bg-elevated, #1c1c1f);
    --rgc-surface: var(--sand-bg-secondary, rgba(255, 255, 255, 0.06));
    --rgc-hover: var(--sand-bg-hover, rgba(255, 255, 255, 0.08));
    --rgc-selected: rgba(255, 255, 255, 0.11);
    --rgc-border: var(--sand-border-secondary-translucent, rgba(255, 255, 255, 0.12));
    --rgc-border-strong: rgba(255, 255, 255, 0.26);
    --rgc-text: var(--sand-text-primary, var(--rokbot-label, #f4f4f5));
    --rgc-text-muted: var(--sand-text-secondary, var(--rokbot-label-2, #a1a1aa));
    --rgc-primary-bg: #f4f4f5;
    --rgc-primary-fg: #18181b;
    --rgc-primary-hover: #e4e4e7;
    --rgc-danger-bg: rgba(248, 113, 113, 0.14);
    --rgc-danger-border: rgba(248, 113, 113, 0.34);
    --rgc-danger-text: #fca5a5;
    --rgc-shadow: 0 24px 56px rgba(0, 0, 0, 0.56), 0 4px 16px rgba(0, 0, 0, 0.32);
  }
}

html.light .rokbot-group-create__backdrop,
html[data-theme="light"] .rokbot-group-create__backdrop,
html[data-theme*="light"] .rokbot-group-create__backdrop {
  --rgc-bg: var(--sand-bg-elevated, #ffffff);
  --rgc-surface: var(--sand-bg-secondary, rgba(24, 24, 27, 0.04));
  --rgc-hover: var(--sand-bg-hover, rgba(24, 24, 27, 0.06));
  --rgc-selected: rgba(24, 24, 27, 0.08);
  --rgc-border: var(--sand-border-secondary-translucent, rgba(24, 24, 27, 0.12));
  --rgc-border-strong: rgba(24, 24, 27, 0.24);
  --rgc-text: var(--sand-text-primary, var(--rokbot-label, #18181b));
  --rgc-text-muted: var(--sand-text-secondary, var(--rokbot-label-2, #71717a));
  --rgc-primary-bg: #18181b;
  --rgc-primary-fg: #ffffff;
  --rgc-primary-hover: #27272a;
  --rgc-danger-bg: rgba(220, 38, 38, 0.08);
  --rgc-danger-border: rgba(220, 38, 38, 0.28);
  --rgc-danger-text: #dc2626;
  --rgc-shadow: 0 20px 48px rgba(0, 0, 0, 0.18), 0 4px 12px rgba(0, 0, 0, 0.08);
}

html.dark .rokbot-group-create__backdrop,
html[data-theme="dark"] .rokbot-group-create__backdrop,
html[data-theme*="dark"] .rokbot-group-create__backdrop,
.cursor-dark .rokbot-group-create__backdrop,
[data-theme="dark"] .rokbot-group-create__backdrop {
  --rgc-bg: var(--sand-bg-elevated, #1c1c1f);
  --rgc-surface: var(--sand-bg-secondary, rgba(255, 255, 255, 0.06));
  --rgc-hover: var(--sand-bg-hover, rgba(255, 255, 255, 0.08));
  --rgc-selected: rgba(255, 255, 255, 0.11);
  --rgc-border: var(--sand-border-secondary-translucent, rgba(255, 255, 255, 0.12));
  --rgc-border-strong: rgba(255, 255, 255, 0.26);
  --rgc-text: var(--sand-text-primary, var(--rokbot-label, #f4f4f5));
  --rgc-text-muted: var(--sand-text-secondary, var(--rokbot-label-2, #a1a1aa));
  --rgc-primary-bg: #f4f4f5;
  --rgc-primary-fg: #18181b;
  --rgc-primary-hover: #e4e4e7;
  --rgc-danger-bg: rgba(248, 113, 113, 0.14);
  --rgc-danger-border: rgba(248, 113, 113, 0.34);
  --rgc-danger-text: #fca5a5;
  --rgc-shadow: 0 24px 56px rgba(0, 0, 0, 0.56), 0 4px 16px rgba(0, 0, 0, 0.32);
}

.rokbot-group-create__dialog {
  width: min(440px, calc(100vw - 32px));
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid var(--rgc-border);
  background: var(--rgc-bg);
  color: var(--rgc-text);
  box-shadow: var(--rgc-shadow);
  overflow: hidden;
  box-sizing: border-box;
}

.rokbot-group-create__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--rgc-border);
  flex: none;
}

.rokbot-group-create__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--rgc-text);
}

.rokbot-group-create__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--rgc-text-muted);
  cursor: pointer;
}
.rokbot-group-create__close:hover:not(:disabled) {
  background: var(--rgc-hover);
  color: var(--rgc-text);
}
.rokbot-group-create__close:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.rokbot-group-create__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.rokbot-group-create__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: none;
}

.rokbot-group-create__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--rgc-text-muted);
}

.rokbot-group-create__input {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px solid var(--rgc-border);
  background: var(--rgc-surface);
  color: var(--rgc-text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color 140ms ease;
}
.rokbot-group-create__input:focus {
  border-color: var(--rgc-border-strong);
}
.rokbot-group-create__input::placeholder {
  color: var(--rgc-text-muted);
  opacity: 0.85;
}

.rokbot-group-create__search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: none;
}

.rokbot-group-create__search-icon {
  position: absolute;
  left: 10px;
  display: inline-flex;
  align-items: center;
  color: var(--rgc-text-muted);
  pointer-events: none;
}

.rokbot-group-create__search {
  padding-left: 30px;
}

.rokbot-group-create__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 18px;
  flex: none;
  font-size: 12px;
  color: var(--rgc-text-muted);
}

.rokbot-group-create__counter {
  font-weight: 500;
}

.rokbot-group-create__hint {
  color: var(--rgc-text-muted);
}

.rokbot-group-create__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--rgc-danger-border);
  background: var(--rgc-danger-bg);
  color: var(--rgc-danger-text);
  font-size: 12.5px;
  flex: none;
}

.rokbot-group-create__error[hidden] {
  display: none;
}

.rokbot-group-create__error-text {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

.rokbot-group-create__retry {
  flex: none;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--rgc-danger-border);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.rokbot-group-create__retry:hover:not(:disabled) {
  background: var(--rgc-hover);
}

.rokbot-group-create__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 120px;
  max-height: 300px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 9px;
  border: 1px solid var(--rgc-border);
  background: var(--rgc-surface);
  flex: 1 1 auto;
}

.rokbot-group-create__state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 112px;
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--rgc-text-muted);
}

.rokbot-group-create__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  transition: background-color 120ms ease, opacity 120ms ease;
}
.rokbot-group-create__row:hover:not(.rokbot-group-create__row--disabled) {
  background: var(--rgc-hover);
}
.rokbot-group-create__row--selected {
  background: var(--rgc-selected);
}
.rokbot-group-create__row--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.rokbot-group-create__checkbox {
  flex: none;
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--rgc-primary-bg);
  cursor: inherit;
}

.rokbot-group-create__avatar {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
}

.rokbot-group-create__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.rokbot-group-create__info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.rokbot-group-create__name {
  font-size: 13px;
  font-weight: 500;
  color: var(--rgc-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rokbot-group-create__subtitle {
  font-size: 11.5px;
  color: var(--rgc-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rokbot-group-create__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--rgc-border);
  flex: none;
}

.rokbot-group-create__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--rgc-border);
  background: transparent;
  color: var(--rgc-text);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 120ms ease, opacity 120ms ease;
}
.rokbot-group-create__btn:hover:not(:disabled) {
  background: var(--rgc-hover);
}
.rokbot-group-create__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.rokbot-group-create__btn--primary {
  border-color: transparent;
  background: var(--rgc-primary-bg);
  color: var(--rgc-primary-fg);
}
.rokbot-group-create__btn--primary:hover:not(:disabled) {
  background: var(--rgc-primary-hover);
}
`;

  function ensureStyle(doc) {
    if (!doc || typeof doc.createElement !== 'function') return;
    if (doc.querySelector?.(`style[${STYLE_ATTR}]`)) return;
    const style = doc.createElement('style');
    style.setAttribute(STYLE_ATTR, '1');
    style.textContent = CSS;
    (doc.head || doc.documentElement)?.appendChild?.(style);
  }

  // ---- DOM installer ------------------------------------------------------------------------

  function installGroupCreate({
    document: doc = globalThis.document,
    window: win = globalThis.window,
    locale = '',
    listAgents,
    createGroup,
    openAgent,
  } = {}) {
    if (!doc || typeof listAgents !== 'function' || typeof createGroup !== 'function') {
      return { open() {}, close() {}, destroy() {} };
    }

    const zhNow = () => isZhLocale(doc.documentElement?.lang || locale);
    let destroyed = false;
    let backdrop = null;
    let sessionToken = 0;

    // Dialog state
    let bots = [];
    let selectedIds = [];
    let searchQuery = '';
    let groupNameInput = '';
    let loading = false;
    let submitting = false;
    let loadError = '';
    let submitError = '';

    // Active dialog element refs
    let els = null;

    function selectedBotsList() {
      const byId = new Map(bots.map(b => [b.id, b]));
      const out = [];
      for (const id of selectedIds) {
        const b = byId.get(id);
        if (b) out.push(b);
      }
      return out;
    }

    function onKeyDown(ev) {
      if (ev.key !== 'Escape' || !backdrop || submitting) return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }

    function updateControls() {
      if (!els) return;
      const zh = zhNow();
      const selectedBots = selectedBotsList();
      const autoName = autoGroupName(selectedBots, zh);
      els.nameInput.placeholder = autoName || t(zh, '选择 Bot 后自动生成名称', 'Auto-named from selected Bots');
      els.nameInput.disabled = submitting;
      els.searchInput.disabled = submitting;

      const count = selectedBots.length;
      els.counter.textContent = t(zh, `已选 ${count}/${MAX_GROUP_BOTS}`, `${count}/${MAX_GROUP_BOTS} selected`);
      els.hint.textContent = count >= MAX_GROUP_BOTS
        ? t(zh, `一个群组最多 ${MAX_GROUP_BOTS} 个 Bot`, `A group can have up to ${MAX_GROUP_BOTS} Bots`)
        : '';

      const errMsg = submitError || loadError;
      if (errMsg) {
        els.errorBox.hidden = false;
        els.errorText.textContent = errMsg;
        els.retryBtn.hidden = !loadError;
        els.retryBtn.disabled = loading || submitting;
      } else {
        els.errorBox.hidden = true;
        els.errorText.textContent = '';
      }

      els.cancelBtn.disabled = submitting;
      els.closeBtn.disabled = submitting;
      els.submitBtn.disabled = !canSubmit(selectedBots, submitting);
      els.submitBtn.textContent = submitting
        ? t(zh, '正在创建…', 'Creating…')
        : t(zh, '创建', 'Create');
    }

    function renderList() {
      if (!els) return;
      const zh = zhNow();
      const container = els.list;
      container.textContent = '';

      if (loading) {
        const msg = doc.createElement('div');
        msg.className = 'rokbot-group-create__state';
        msg.textContent = t(zh, '正在加载 Bot…', 'Loading Bots…');
        container.appendChild(msg);
        return;
      }

      if (bots.length === 0) {
        const msg = doc.createElement('div');
        msg.className = 'rokbot-group-create__state';
        msg.textContent = t(zh, '没有可加入群组的 Bot', 'No Bots available');
        container.appendChild(msg);
        return;
      }

      const visible = filterBots(bots, searchQuery);
      if (visible.length === 0) {
        const msg = doc.createElement('div');
        msg.className = 'rokbot-group-create__state';
        msg.textContent = t(zh, '没有匹配的 Bot', 'No matching Bots');
        container.appendChild(msg);
        return;
      }

      const selectedSet = new Set(selectedIds);
      const atLimit = selectedIds.length >= MAX_GROUP_BOTS;

      for (const bot of visible) {
        const isSelected = selectedSet.has(bot.id);
        const isDisabled = submitting || (!isSelected && atLimit);

        const row = doc.createElement('label');
        row.className = 'rokbot-group-create__row';
        if (isSelected) row.classList.add('rokbot-group-create__row--selected');
        if (isDisabled) row.classList.add('rokbot-group-create__row--disabled');
        row.setAttribute('data-bot-id', bot.id);

        const checkbox = doc.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'rokbot-group-create__checkbox';
        checkbox.checked = isSelected;
        checkbox.disabled = isDisabled;
        checkbox.addEventListener('change', () => {
          if (submitting) return;
          toggleBot(bot.id);
        });

        const avatar = doc.createElement('span');
        avatar.className = 'rokbot-group-create__avatar';
        if (isSafeAvatarUrl(bot.avatarDataUrl)) {
          const img = doc.createElement('img');
          img.src = bot.avatarDataUrl;
          img.alt = '';
          avatar.appendChild(img);
        } else {
          avatar.style.backgroundColor = avatarFillColor(bot);
          avatar.textContent = avatarInitial(bot.name);
        }

        const info = doc.createElement('span');
        info.className = 'rokbot-group-create__info';
        const nameEl = doc.createElement('span');
        nameEl.className = 'rokbot-group-create__name';
        nameEl.textContent = bot.name;
        info.appendChild(nameEl);

        const subtitle = bot.title || bot.description;
        if (subtitle) {
          const subEl = doc.createElement('span');
          subEl.className = 'rokbot-group-create__subtitle';
          subEl.textContent = subtitle;
          info.appendChild(subEl);
        }

        row.append(checkbox, avatar, info);
        container.appendChild(row);
      }
    }

    function toggleBot(id) {
      const idx = selectedIds.indexOf(id);
      if (idx >= 0) {
        selectedIds.splice(idx, 1);
      } else if (selectedIds.length < MAX_GROUP_BOTS) {
        selectedIds.push(id);
      }
      submitError = '';
      renderList();
      updateControls();
    }

    async function loadBots(token) {
      loading = true;
      loadError = '';
      renderList();
      updateControls();
      try {
        const reply = await listAgents();
        if (destroyed || token !== sessionToken) return;
        bots = eligibleBots(reply);
        const validIds = new Set(bots.map(b => b.id));
        selectedIds = selectedIds.filter(id => validIds.has(id));
      } catch (err) {
        if (destroyed || token !== sessionToken) return;
        const zh = zhNow();
        const detail = err?.message ? String(err.message) : t(zh, '请稍后重试', 'Please try again');
        loadError = t(zh, `加载 Bot 列表失败：${detail}`, `Failed to load Bots: ${detail}`);
      } finally {
        if (!destroyed && token === sessionToken) {
          loading = false;
          renderList();
          updateControls();
        }
      }
    }

    async function handleSubmit() {
      const selectedBots = selectedBotsList();
      if (!canSubmit(selectedBots, submitting)) return;
      const zh = zhNow();
      const token = sessionToken;
      submitting = true;
      submitError = '';
      renderList();
      updateControls();
      try {
        const finalName = normalizeGroupName(groupNameInput) || autoGroupName(selectedBots, zh);
        const body = createGroupBody(finalName, selectedBots.map(b => b.id));
        const reply = await createGroup(body);
        if (destroyed || token !== sessionToken) return;
        const groupId = groupIdFromReply(reply);
        submitting = false;
        close();
        if (groupId && typeof openAgent === 'function') openAgent(groupId);
      } catch (err) {
        if (destroyed || token !== sessionToken) return;
        submitting = false;
        const detail = err?.message ? String(err.message) : t(zh, '请稍后重试', 'Please try again');
        submitError = t(zh, `无法创建群组：${detail}`, `Couldn't create the group: ${detail}`);
        renderList();
        updateControls();
      }
    }

    function open() {
      if (destroyed) return;
      ensureStyle(doc);
      close();
      const token = ++sessionToken;
      const zh = zhNow();
      bots = [];
      selectedIds = [];
      searchQuery = '';
      groupNameInput = '';
      loading = true;
      submitting = false;
      loadError = '';
      submitError = '';

      backdrop = doc.createElement('div');
      backdrop.className = 'rokbot-group-create__backdrop';
      backdrop.addEventListener('mousedown', ev => {
        if (ev.target === backdrop && !submitting) close();
      });

      const dialog = doc.createElement('div');
      dialog.className = 'rokbot-group-create__dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'rokbot-group-create-title');

      // Header
      const header = doc.createElement('div');
      header.className = 'rokbot-group-create__header';
      const title = doc.createElement('h2');
      title.id = 'rokbot-group-create-title';
      title.className = 'rokbot-group-create__title';
      title.textContent = t(zh, '新建群组', 'New group');
      const closeBtn = doc.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'rokbot-group-create__close';
      closeBtn.setAttribute('aria-label', t(zh, '关闭', 'Close'));
      closeBtn.innerHTML = ICON_CLOSE;
      closeBtn.addEventListener('click', () => { if (!submitting) close(); });
      header.append(title, closeBtn);

      // Body
      const body = doc.createElement('div');
      body.className = 'rokbot-group-create__body';

      const nameField = doc.createElement('div');
      nameField.className = 'rokbot-group-create__field';
      const nameLabel = doc.createElement('label');
      nameLabel.className = 'rokbot-group-create__label';
      nameLabel.setAttribute('for', 'rokbot-group-create-name');
      nameLabel.textContent = t(zh, '群组名称', 'Group name');
      const nameInput = doc.createElement('input');
      nameInput.id = 'rokbot-group-create-name';
      nameInput.type = 'text';
      nameInput.className = 'rokbot-group-create__input';
      nameInput.maxLength = MAX_GROUP_NAME_LENGTH;
      nameInput.autocomplete = 'off';
      nameInput.addEventListener('input', () => {
        groupNameInput = nameInput.value;
      });
      nameInput.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.isComposing && canSubmit(selectedBotsList(), submitting)) {
          ev.preventDefault();
          void handleSubmit();
        }
      });
      nameField.append(nameLabel, nameInput);

      const searchWrap = doc.createElement('div');
      searchWrap.className = 'rokbot-group-create__search-wrap';
      const searchIcon = doc.createElement('span');
      searchIcon.className = 'rokbot-group-create__search-icon';
      searchIcon.innerHTML = ICON_SEARCH;
      const searchInput = doc.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'rokbot-group-create__input rokbot-group-create__search';
      searchInput.placeholder = t(zh, '搜索 Bot', 'Search Bots');
      searchInput.setAttribute('aria-label', t(zh, '搜索 Bot', 'Search Bots'));
      searchInput.autocomplete = 'off';
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        renderList();
      });
      searchWrap.append(searchIcon, searchInput);

      const meta = doc.createElement('div');
      meta.className = 'rokbot-group-create__meta';
      const counter = doc.createElement('span');
      counter.className = 'rokbot-group-create__counter';
      const hint = doc.createElement('span');
      hint.className = 'rokbot-group-create__hint';
      meta.append(counter, hint);

      const errorBox = doc.createElement('div');
      errorBox.className = 'rokbot-group-create__error';
      errorBox.setAttribute('role', 'alert');
      errorBox.hidden = true;
      const errorText = doc.createElement('span');
      errorText.className = 'rokbot-group-create__error-text';
      const retryBtn = doc.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'rokbot-group-create__retry';
      retryBtn.textContent = t(zh, '重试', 'Retry');
      retryBtn.addEventListener('click', () => {
        if (!loading && !submitting) void loadBots(sessionToken);
      });
      errorBox.append(errorText, retryBtn);

      const list = doc.createElement('div');
      list.className = 'rokbot-group-create__list';

      body.append(nameField, searchWrap, meta, errorBox, list);

      // Footer
      const footer = doc.createElement('div');
      footer.className = 'rokbot-group-create__footer';
      const cancelBtn = doc.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'rokbot-group-create__btn';
      cancelBtn.textContent = t(zh, '取消', 'Cancel');
      cancelBtn.addEventListener('click', () => { if (!submitting) close(); });
      const submitBtn = doc.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'rokbot-group-create__btn rokbot-group-create__btn--primary';
      submitBtn.textContent = t(zh, '创建', 'Create');
      submitBtn.addEventListener('click', () => { void handleSubmit(); });
      footer.append(cancelBtn, submitBtn);

      dialog.append(header, body, footer);
      backdrop.appendChild(dialog);
      (doc.body || doc.documentElement)?.appendChild?.(backdrop);

      els = {
        dialog,
        closeBtn,
        nameInput,
        searchInput,
        counter,
        hint,
        errorBox,
        errorText,
        retryBtn,
        list,
        cancelBtn,
        submitBtn,
      };

      doc.addEventListener?.('keydown', onKeyDown, true);
      updateControls();
      renderList();
      setTimeout(() => { try { nameInput.focus?.(); } catch {} }, 0);
      void loadBots(token);
    }

    function close() {
      sessionToken += 1;
      submitting = false;
      doc.removeEventListener?.('keydown', onKeyDown, true);
      backdrop?.remove?.();
      backdrop = null;
      els = null;
    }

    function createEntryButton(templateBtn) {
      const zh = zhNow();
      const label = t(zh, '新建群组', 'New group');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = templateBtn.className || '';
      btn.setAttribute(BTN_ATTR, '1');
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.innerHTML = ICON_GROUP;
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        open();
      });
      return btn;
    }

    function syncEntryButtons() {
      if (destroyed || typeof doc.querySelectorAll !== 'function') return;
      // React may drop or re-render the official button; an entry left without it goes too.
      for (const ours of doc.querySelectorAll(`button[${BTN_ATTR}]`)) {
        const prev = ours.previousElementSibling;
        if (!prev || typeof prev.matches !== 'function' || !prev.matches(NEW_BOT_SELECTOR)) ours.remove?.();
      }
      const targets = doc.querySelectorAll(NEW_BOT_SELECTOR);
      for (const officialBtn of targets) {
        if (!officialBtn || officialBtn.getAttribute?.(BTN_ATTR) === '1') continue;
        if (officialBtn.closest?.(SKIP_CONTAINER_SELECTOR)) continue;
        const next = officialBtn.nextElementSibling;
        if (next && next.getAttribute?.(BTN_ATTR) === '1') {
          const label = t(zhNow(), '新建群组', 'New group');
          if (next.getAttribute('aria-label') !== label) {
            next.setAttribute('aria-label', label);
            next.setAttribute('title', label);
          }
          continue;
        }
        const parent = officialBtn.parentElement;
        if (!parent || typeof parent.insertBefore !== 'function') continue;
        parent.insertBefore(createEntryButton(officialBtn), officialBtn.nextSibling || null);
      }
    }

    let observer = null;
    if (typeof win?.MutationObserver === 'function' || typeof globalThis.MutationObserver === 'function') {
      const MO = win?.MutationObserver || globalThis.MutationObserver;
      observer = new MO(mutations => {
        if (Array.isArray(mutations) && mutations.length > 0 && mutations.every(m => {
          const target = m.target;
          return target && typeof target.closest === 'function'
            && (target.closest('.rokbot-group-create__backdrop') || target.closest(`[${BTN_ATTR}]`));
        })) return;
        syncEntryButtons();
      });
      if (doc.documentElement) {
        observer.observe(doc.documentElement, { childList: true, subtree: true });
      }
    }
    syncEntryButtons();

    function destroy() {
      destroyed = true;
      close();
      observer?.disconnect?.();
      observer = null;
      if (typeof doc.querySelectorAll === 'function') {
        for (const el of doc.querySelectorAll(`[${BTN_ATTR}]`)) el.remove?.();
      }
    }

    return { open, close, destroy };
  }

  return {
    MAX_GROUP_BOTS,
    MAX_GROUP_NAME_LENGTH,
    isZhLocale,
    normalizeGroupName,
    eligibleBots,
    filterBots,
    formatList,
    autoGroupName,
    canSubmit,
    createGroupBody,
    groupIdFromReply,
    installGroupCreate,
  };
});

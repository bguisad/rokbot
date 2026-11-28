// Settings dialog grouping for the Web client and the desktop apps.
//
// The official settings dialog lists its top-level entries in a flat `nav.sand-settings-nav`
// (and in newer releases packs Account, Appearance, Notifications, Models, Usage, Voice, System
// and Migration together inside one long General pane). This module keeps every official nav
// button and settings panel mounted (React keeps all state and handlers intact), hides the flat
// nav buttons, and renders a grouped functional navigation following the Android settings menu:
//   - 通用与外观 (General & appearance): 常规/账户/外观/语言/系统 + 输入建议
//   - 通知 (Notifications): 通知声音与通知偏好
//   - 模型与用量 (Models & usage): 模型配置、用量
//   - 电脑与连接 (Computers): 电脑、消息、已连接应用
//   - 数据与迁移 (Data & migration): 数据迁移、数据共享、保险库、权限
//   - 关于 (About): 更新、关于
//
// In both layouts (flat multi-tab nav OR consolidated General pane with <section> blocks),
// clicking any group or item activates the real official tab and displays its real settings
// content directly in `.sand-settings-panel` without deleting or altering any setting.
// Pure helpers (catalog, groupOf, classifyGeneralSection, overflows) have no DOM dependency.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.RokBotSettingsNav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Upstream compound section keys; matched by the suffix after the brand prefix.
  const LEGACY_SUFFIXES = ['bot-usage', 'bot-updates'];
  function officialKey(key) {
    for (const suffix of LEGACY_SUFFIXES) if (key.endsWith(`-${suffix}`)) return suffix;
    return key;
  }

  // Pages outside the official nav list (输入建议 added by composer-assist.cjs).
  const PAGE_KEYS = [
    [/^(输入建议|輸入建議|input suggestions)$/i, 'input-suggestions'],
  ];
  const PAGE_LABELS = { 'input-suggestions': { zh: '输入建议', en: 'Input suggestions' } };

  const GROUP_ORDER = ['general', 'notifications', 'models', 'computer', 'data', 'about'];
  const GROUP_LABELS = {
    general: { zh: '通用与外观', en: 'General & appearance' },
    notifications: { zh: '通知', en: 'Notifications' },
    models: { zh: '模型与用量', en: 'Models & usage' },
    computer: { zh: '电脑与连接', en: 'Computers' },
    data: { zh: '数据与迁移', en: 'Data & migration' },
    about: { zh: '关于', en: 'About' },
  };
  const GROUP_ICONS = {
    general: 'sliders', notifications: 'bell', models: 'cpu', computer: 'monitor', data: 'database', about: 'info',
  };
  const VIRTUAL_SECTION_GROUPS = ['general', 'notifications', 'models', 'data'];

  // Preferred order inside a group.
  const SECTION_ORDER = [
    'general', 'account', 'appearance', 'theme', 'accent', 'bot', 'bot-color', 'language', 'timezone', 'spell-check',
    'microphone', 'network-debugger', 'hardware-acceleration', 'security', 'passkeys', 'security-keys',
    'selfie', 'input-suggestions',
    'notifications', 'notification-sound-enabled', 'notification-sound',
    'model', 'usage-and-billing', 'usage', 'plan', 'manage-plan', 'personal-usage', 'usage-limits', 'on-demand',
    'billing', 'usage-breakdown', 'bot-usage', 'cancel-trial', 'usage-resets', 'additional-usage', 'my-plan',
    'computer', 'your-computer', 'computers', 'manage-devices', 'computer-use', 'bot-computer', 'computer-status',
    'local-execution', 'egress', 'integrations', 'connected-apps', 'messages', 'messages-send',
    'messages-send-without-asking', 'messages-allowed-recipients', 'update-computer', 'reset-computer',
    'migrate', 'data-sharing', 'import-memory', 'vault', 'permissions', 'threads', 'linked-numbers', 'contacts',
    'reference-photos', 'auto-review', 'auto-review-rules', 'team-bot-link-previews', 'always-ask-rules',
    'allow-without-asking-rules',
    'update-status', 'updates', 'update-channel', 'automatic-updates', 'bot-updates', 'system', 'about',
  ];

  const GROUP_KEYS = {
    general: [
      'general', 'account', 'appearance', 'theme', 'accent', 'bot', 'bot-color', 'language', 'timezone', 'spell-check',
      'microphone', 'network-debugger', 'hardware-acceleration', 'hardware-acceleration-restart', 'security',
      'passkeys', 'security-keys', 'selfie',
    ],
    notifications: ['notifications', 'notification-sound-enabled', 'notification-sound'],
    models: [
      'model', 'usage-and-billing', 'usage', 'plan', 'manage-plan', 'personal-usage', 'usage-limits',
      'additional-usage', 'my-plan', 'on-demand', 'billing', 'usage-breakdown', 'bot-usage',
      'cancel-trial', 'usage-resets',
    ],
    computer: [
      'computer', 'your-computer', 'computers', 'manage-devices', 'computer-use', 'bot-computer',
      'computer-status', 'local-execution', 'egress', 'integrations', 'connected-apps', 'messages',
      'messages-send', 'messages-send-without-asking', 'messages-allowed-recipients', 'update-computer',
      'reset-computer',
    ],
    data: [
      'migrate', 'vault', 'permissions', 'data-sharing', 'import-memory', 'threads', 'linked-numbers', 'contacts',
      'reference-photos', 'auto-review', 'auto-review-rules', 'team-bot-link-previews', 'always-ask-rules',
      'allow-without-asking-rules', 'team-bot-connector-preferences', 'team-bot-connector-shared-space-allowlist',
    ],
    about: [
      'update-status', 'updates', 'update-channel', 'automatic-updates', 'bot-updates', 'system', 'about',
    ],
  };

  const GROUP_LABEL_PATTERNS = [
    ['general', /^(常规|常規|通用|一般|general)$/i],
    ['general', /^(账户|帳戶|账号|帳號|account)$/i],
    ['general', /^(外观|外觀|appearance|theme)$/i],
    ['general', /^(语言|語言|language)$/i],
    ['general', /^(机器人|機器人|bot)$/i],
    ['general', /^(系统|系統|system)$/i],
    ['notifications', /^(通知|通知声音|通知聲音|notifications?)$/i],
    ['models', /^(模型|模型配置|model|models|model settings?)$/i],
    ['models', /^(使用情况|使用情況|使用情况和账单|用量|用量与账单|usage|usage and billing|usage & billing)$/i],
    ['computer', /^(电脑|電腦|computer|computers)$/i],
    ['computer', /^(消息|集成|已连接应用|已連接應用|integrations?|messaging|connected apps?)$/i],
    ['computer', /^(本地执行|本地執行|local execution)$/i],
    ['data', /^(数据|資料|data|data sharing|数据共享)$/i],
    ['data', /^(迁移|数据迁移|資料移轉|migration|data migration|migrate)$/i],
    ['data', /^(保险库|保險庫|vault)$/i],
    ['data', /^(权限|權限|permissions?)$/i],
    ['about', /^(关于|關於|about)$/i],
    ['about', /^(更新|应用更新|检查更新|updates?|app updates?|check for updates)$/i],
  ];

  // Icons in the style of the official nav glyphs (15px, stroke follows currentColor).
  const ICON = body => '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  const GROUP_ICON_SVG = {
    general: ICON('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
    notifications: ICON('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    models: ICON('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
    computer: ICON('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
    data: ICON('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
    about: ICON('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'),
    'input-suggestions': ICON('<path d="M20 12.5a7.5 7.5 0 0 1-11.06 6.6L4 20.5l1.4-4.5A7.5 7.5 0 1 1 20 12.5z"/><path d="M12.5 8.6l.75 1.95 1.95.75-1.95.75-.75 1.95-.75-1.95-1.95-.75 1.95-.75z"/>'),
  };

  function isZh(lang) {
    return /^zh\b/i.test(String(lang || ''));
  }

  function labelOf(group, lang) {
    const entry = GROUP_LABELS[group] || PAGE_LABELS[group];
    return entry ? (isZh(lang) ? entry.zh : entry.en) : group;
  }

  function composedText(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Stable key for an official nav button.
   * Official React 1.3.x only sets `aria-controls="sand-settings-panel-<key>"` on the currently
   * active tab, so once resolved we normalize known labels to canonical keys where possible and
   * fall back to `label:<text>`.
   */
  const LABEL_TO_KEY = [
    [/^(常规|常規|通用|一般|general)$/i, 'general'],
    [/^(电脑|電腦|computer|computers)$/i, 'computer'],
    [/^(更新|应用更新|检查更新|updates?|app updates?)$/i, 'updates'],
    [/^(使用情况|使用情況|使用情况和账单|用量|用量与账单|usage|usage and billing|usage & billing)$/i, 'usage'],
    [/^(保险库|保險庫|vault)$/i, 'vault'],
    [/^(权限|權限|permissions?)$/i, 'permissions'],
    [/^(消息|集成|integrations?|messaging)$/i, 'integrations'],
    [/^(已连接应用|已連接應用|connected apps?)$/i, 'connected-apps'],
    [/^(通知|notifications?)$/i, 'notifications'],
    [/^(模型|模型配置|model|models|model settings?)$/i, 'model'],
  ];

  function sectionKey(el) {
    if (!el) return '';
    if (el.getAttribute?.('data-rokbot-suggestions-nav') === '1') return 'input-suggestions';
    const controls = el.getAttribute?.('aria-controls') || '';
    const match = /^sand-settings-panel-(.+)$/.exec(controls);
    if (match) return match[1];
    const text = composedText(el).toLowerCase().replace(/\s*[:：]$/, '');
    if (!text) return '';
    for (const [pattern, pageGroup] of PAGE_KEYS) if (pattern.test(text)) return `label:${text}`;
    for (const [pattern, key] of LABEL_TO_KEY) if (pattern.test(text)) return key;
    return `label:${text}`;
  }

  /** The functional group an official section key belongs to (never drops an unknown key). */
  function groupOf(rawKey) {
    const key = officialKey(String(rawKey || '').toLowerCase());
    if (!key) return 'general';
    if (key === 'input-suggestions') return 'input-suggestions';
    for (const group of GROUP_ORDER) if ((GROUP_KEYS[group] || []).includes(key)) return group;
    if (key.startsWith('label:')) {
      const text = key.slice(6);
      for (const [group, pattern] of GROUP_LABEL_PATTERNS) if (pattern.test(text)) return group;
      return 'general';
    }
    if (/^usage|^plan$|^personal-usage|^bot-usage$|^billing/.test(key)) return 'models';
    if (/^update|updates$|^bot-updates$/.test(key)) return 'about';
    if (/^notification/.test(key)) return 'notifications';
    if (/^(computer|computers|messages|your-computer|local-execution|egress|integrations|connected-apps)/.test(key)) return 'computer';
    if (/^(migrate|vault|permissions|data|import-memory|threads|contacts|linked-numbers|auto-review|always-ask|allow-without)/.test(key)) return 'data';
    if (/^model/.test(key)) return 'models';
    return 'general';
  }

  /** The group of a standalone injected page (e.g. 输入建议), or null. */
  function pageGroupOf(key) {
    const raw = String(key || '');
    if (raw === 'input-suggestions') return 'input-suggestions';
    const text = raw.startsWith('label:') ? raw.slice(6) : '';
    for (const [pattern, group] of PAGE_KEYS) if (pattern.test(text)) return group;
    return null;
  }

  /**
   * Classifies a `<section>` inside the consolidated General settings pane (`.sand-settings-general`
   * or `.sand-settings-pane`) into its functional group. Unknown sections default to `'general'`
   * so no setting is ever hidden or lost.
   */
  function classifyGeneralSection(input) {
    if (!input) return 'general';
    // Accept either a DOM Element or a plain descriptor `{ heading, id, isMigrate, anchors }` for unit tests.
    const isMigrate = Boolean(
      input.isMigrate
      || input.getAttribute?.('data-rokbot-migrate-settings') === '1'
      || input.querySelector?.('[data-rokbot-migrate-settings]'),
    );
    if (isMigrate) return 'data';

    const anchors = Array.isArray(input.anchors) ? input.anchors : [];
    const ids = [];
    if (typeof input.id === 'string' && input.id) ids.push(input.id);
    if (typeof input.getAttribute === 'function') {
      const elId = input.getAttribute('id');
      if (elId) ids.push(elId);
      for (const node of input.querySelectorAll?.('[id^="sand-setting-"], [data-setting-anchor]') ?? []) {
        const nid = node.getAttribute?.('id');
        const anchor = node.getAttribute?.('data-setting-anchor');
        if (nid) ids.push(nid.replace(/^sand-setting-/, ''));
        if (anchor) ids.push(anchor);
      }
    }
    const allIds = [...anchors, ...ids].map(v => String(v || '').toLowerCase());
    for (const id of allIds) {
      if (/^notification/.test(id)) return 'notifications';
      if (/^(model|usage|plan|billing)/.test(id)) return 'models';
      if (/^(data-sharing|import-memory|migrate|vault|auto-review|permissions)/.test(id)) return 'data';
    }

    let heading = typeof input.heading === 'string' ? input.heading : '';
    if (!heading && typeof input.querySelector === 'function') {
      const h = input.querySelector('h3, h2, .rokbot-sug-settings__heading');
      heading = composedText(h);
    }
    const text = heading.trim();
    if (/^(通知|通知声音|通知聲音|notifications?)/i.test(text)) return 'notifications';
    if (/^(模型|模型配置|用量|使用情况|使用情況|models?|model settings?|usage)/i.test(text)) return 'models';
    if (/^(迁移|数据迁移|資料移轉|数据共享|导入记忆|導入記憶|数据|資料|migration|data migration|data sharing|import memory|privacy|data)/i.test(text)) return 'data';
    return 'general';
  }

  function rankOf(rawKey) {
    const index = SECTION_ORDER.indexOf(officialKey(String(rawKey || '')));
    return index < 0 ? SECTION_ORDER.length : index;
  }

  // Non-section header labels that should not become nav rows (note: 常规/通用/general IS a real tab!).
  const FOREIGN = /^(设置|設定|settings?|options?|选项|選項|分区|分區|sections?)$/i;

  /**
   * Groups official nav rows by function.
   * `items`: [{ key, text }] in official order.
   * Returns [{ group, label, rows: [key...] }] in GROUP_ORDER (with standalone pages first); empty groups omitted.
   */
  function catalog(items = [], { label = false } = {}) {
    const buckets = new Map();
    const rank = new Map();
    items.forEach((item, index) => {
      const key = item && item.key ? String(item.key) : '';
      const text = (item && item.text ? String(item.text) : '').trim().toLowerCase();
      if (FOREIGN.test(text)) return;
      if (key.startsWith('label:') && FOREIGN.test(key.slice(6))) return;
      const group = pageGroupOf(key) || groupOf(key);
      if (!buckets.has(group)) { buckets.set(group, []); rank.set(group, []); }
      buckets.get(group).push(key);
      rank.get(group).push([rankOf(key), index]);
    });
    const ordered = [...Object.keys(PAGE_LABELS).filter(group => buckets.has(group)), ...GROUP_ORDER];
    return ordered.filter(group => buckets.has(group)).map(group => {
      const keys = buckets.get(group);
      const order = rank.get(group);
      const sorted = keys
        .map((key, i) => ({ key, rank: order[i] }))
        .sort((a, b) => (a.rank[0] - b.rank[0]) || (a.rank[1] - b.rank[1]))
        .map(entry => entry.key);
      return { group, label: labelOf(group, label), rows: sorted };
    });
  }

  /** Floating-point-safe vertical overflow check: true when content exceeds its scroll viewport. */
  function overflows(metrics) {
    if (!metrics) return false;
    const { clientHeight = 0, scrollHeight = 0 } = metrics;
    return scrollHeight - clientHeight > 1;
  }

  // ---- DOM ------------------------------------------------------------------------------------

  const STYLE_ID = 'rokbot-settings-nav-style';
  const STYLE = `
/* Keep the official settings panel and all its controls visible; only replace the flat left
   navigation with the grouped list while keeping official nav buttons mounted for React. */
.rokbot-settings-grouped .sand-settings-nav {
  overflow-y: auto !important;
  overscroll-behavior: contain;
}
.rokbot-settings-nav-host {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
}
.rokbot-settings-nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 2px 0 12px;
}
.rokbot-settings-nav-list__section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 10px;
}
.rokbot-settings-nav-list__section:first-child {
  margin-top: 0;
}
.rokbot-settings-nav-list__group {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 28px;
  padding: 4px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
  opacity: 0.65;
  text-align: left;
  cursor: pointer;
}
.rokbot-settings-nav-list__group:hover {
  opacity: 0.9;
  background: color-mix(in srgb, currentColor 5%, transparent);
}
.rokbot-settings-nav-list__group[aria-current="page"] {
  opacity: 1;
}
.rokbot-settings-nav-list__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 15px;
  height: 15px;
}
.rokbot-settings-nav-list__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}
.rokbot-settings-nav-list__count {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.55;
  flex: none;
}
.rokbot-settings-nav-list__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 5px 10px 5px 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.rokbot-settings-nav-list__row:hover {
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.rokbot-settings-nav-list__row[aria-current="page"],
.rokbot-settings-nav-list__row[data-active="true"] {
  background: color-mix(in srgb, currentColor 10%, transparent);
  font-weight: 500;
}
.rokbot-settings-nav-list__row--direct {
  padding-left: 10px;
}
.rokbot-settings-nav-list__row-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}
.rokbot-settings-nav-list__row-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 15px;
  height: 15px;
  opacity: 0.78;
}
/* General-pane section filtering when a functional group (通知 / 模型与用量 / 数据与迁移 / 通用与外观) is chosen. */
[data-rokbot-section-hidden="1"] {
  display: none !important;
}
@media (max-width: 700px) {
  html.rokbot-android .rokbot-settings-nav-host,
  html.rokbot-android .rokbot-settings-nav-list,
  html.rokbot-android .rokbot-settings-nav-list__section {
    flex-direction: row !important;
    align-items: center !important;
    width: auto !important;
    margin-top: 0 !important;
    padding: 0 !important;
    gap: 4px !important;
  }
  html.rokbot-android .rokbot-settings-nav-list__group {
    display: none !important;
  }
  html.rokbot-android .rokbot-settings-nav-list__row {
    width: auto !important;
    padding: 0 12px !important;
    min-height: 36px !important;
    white-space: nowrap !important;
  }
}
`;

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function navItems(nav) {
    return [...nav.children].filter(el => el.classList && el.classList.contains('sand-settings-nav__item'));
  }

  function isActive(el) {
    return el.getAttribute?.('aria-current') === 'page' || el.getAttribute?.('data-active') === 'true';
  }

  function setActive(el, active) {
    if (!el) return;
    if (active) {
      el.setAttribute('aria-current', 'page');
      el.setAttribute('data-active', 'true');
    } else {
      el.removeAttribute('aria-current');
      el.removeAttribute('data-active');
    }
  }

  /**
   * Collects the `<section>` blocks inside the consolidated General settings pane (if open),
   * including sibling `<section data-rokbot-migrate-settings="1">` mounted by migrate-settings.cjs.
   */
  function generalSectionsOf(panel) {
    if (!panel) return [];
    const generalRoot = panel.querySelector('.sand-settings-general');
    const pane = panel.querySelector('.sand-settings-pane');
    const out = [];
    const seen = new Set();
    const push = el => {
      if (!el || seen.has(el)) return;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'STYLE' || tag === 'SCRIPT') return;
      seen.add(el);
      out.push(el);
    };
    if (generalRoot) {
      for (const child of generalRoot.children || []) push(child);
    }
    if (pane) {
      for (const child of pane.children || []) {
        if (child === generalRoot) continue;
        if (child.getAttribute?.('data-rokbot-migrate-settings') === '1'
          || String(child.tagName || '').toUpperCase() === 'SECTION') {
          push(child);
        }
      }
    }
    return out;
  }

  /**
   * Mounts the grouped navigation into the official settings dialog.
   * @param {object} options
   * @param {Document} options.document
   * @param {string} [options.locale]
   * @param {(status: {view: string, group: string|null, hidden: boolean}) => void} [options.onChange]
   */
  function installSettingsNav({ document: doc = globalThis.document, locale: initialLocale = '', onChange, wasHidden } = {}) {
    if (!doc) {
      return {
        sync() {}, showGroup() {}, showAll() {}, setLocale() {},
        get hidden() { return false; }, get view() { return 'closed'; }, get groups() { return []; }, destroy() {},
      };
    }
    if (typeof initialLocale === 'function') initialLocale = '';
    let locale = initialLocale;
    let destroyed = false;
    ensureStyle(doc);

    let status = { view: 'closed', group: null, hidden: false };
    let rows = new Map();        // official nav button -> { official, row, group, key }
    let virtualRows = new Map(); // virtual general-section group -> { row, group, official }
    let groups = [];             // [{ group, button, count, label, cells, virtual }]
    let detectedVirtualGroups = new Set(); // remembered across tab switches within one open dialog
    let activeVirtualGroup = null;         // 'general' | 'notifications' | 'models' | 'data' | null
    let generalOfficialBtn = null;
    const isHidden = wasHidden || (el => el.hidden === true || el.hasAttribute?.('hidden') || el.style.display === 'none');

    const report = () => { try { onChange?.(status); } catch {} };

    function layoutOf() {
      return doc.querySelector('.sand-settings-layout');
    }

    function officialNavOf(layout) {
      return [...(layout?.children || [])].find(el => el.classList && el.classList.contains('sand-settings-nav')) || null;
    }

    function panelOf(layout) {
      return [...(layout?.children || [])].find(el => el.classList && el.classList.contains('sand-settings-panel')) || null;
    }

    function hostOf(nav) {
      const existing = [...nav.children].find(el => el.classList && el.classList.contains('rokbot-settings-nav-host'));
      if (existing) return existing;
      const host = doc.createElement('div');
      host.className = 'rokbot-settings-nav-host';
      nav.appendChild(host);
      return host;
    }

    function stableKey(el) {
      if (el.dataset?.rokbotNavKey) return el.dataset.rokbotNavKey;
      const key = sectionKey(el);
      if (key && el.dataset) el.dataset.rokbotNavKey = key;
      return key;
    }

    function click(el) {
      if (!el) return;
      const hiddenByUs = el.style.display === 'none';
      if (hiddenByUs) el.style.display = '';
      try { el.click(); } finally {
        if (hiddenByUs) {
          el.style.display = 'none';
          Promise.resolve().then(() => { try { sync(); } catch {} });
        }
      }
    }

    function scrollPaneToTop(panel) {
      if (!panel) return;
      const scroller = panel.querySelector?.('.sand-settings-scroll, .ui-scroll-area__viewport, .sand-settings-panel__body');
      if (scroller && typeof scroller.scrollTop === 'number') scroller.scrollTop = 0;
    }

    function clearSectionFilter(panel) {
      if (!panel) return;
      for (const el of panel.querySelectorAll?.('[data-rokbot-section-hidden]') ?? []) {
        el.removeAttribute('data-rokbot-section-hidden');
      }
    }

    function applySectionFilter(panel) {
      if (!panel) return;
      const sections = generalSectionsOf(panel);
      if (!sections.length) return;
      if (!activeVirtualGroup || panel.classList?.contains('rokbot-sug-page-open')) {
        clearSectionFilter(panel);
        return;
      }
      // Only filter when the general pane actually contains sections for multiple groups.
      const present = new Set(sections.map(el => classifyGeneralSection(el)));
      if (present.size <= 1 || !present.has(activeVirtualGroup)) {
        clearSectionFilter(panel);
        return;
      }
      for (const el of sections) {
        const group = classifyGeneralSection(el);
        if (group === activeVirtualGroup) el.removeAttribute('data-rokbot-section-hidden');
        else el.setAttribute('data-rokbot-section-hidden', '1');
      }
    }

    function scanVirtualGroups(panel, officialKeys) {
      if (!panel || !generalOfficialBtn) return;
      const sections = generalSectionsOf(panel);
      if (!sections.length) return;
      const buckets = new Set(sections.map(el => classifyGeneralSection(el)));
      if (buckets.size <= 1) return;
      for (const group of VIRTUAL_SECTION_GROUPS) {
        if (group === 'general') continue;
        if (!buckets.has(group)) continue;
        // Only synthesize a virtual group entry when no official top-level button already owns that group.
        const hasDedicatedOfficial = officialKeys.some(key => key !== 'general' && groupOf(key) === group);
        if (!hasDedicatedOfficial) detectedVirtualGroups.add(group);
      }
    }

    function activateVirtualGroup(group) {
      const layout = layoutOf();
      const panel = panelOf(layout);
      activeVirtualGroup = group;
      if (generalOfficialBtn) {
        if (!isActive(generalOfficialBtn) || panel?.classList?.contains('rokbot-sug-page-open')) {
          click(generalOfficialBtn);
        }
      }
      applySectionFilter(panel);
      scrollPaneToTop(panel);
      syncActive();
      status = { view: 'group', group, hidden: false };
      report();
    }

    function activateOfficial(official, group) {
      const layout = layoutOf();
      const panel = panelOf(layout);
      if (official === generalOfficialBtn && detectedVirtualGroups.size > 0) {
        activeVirtualGroup = 'general';
      } else {
        activeVirtualGroup = null;
        clearSectionFilter(panel);
      }
      click(official);
      applySectionFilter(panel);
      scrollPaneToTop(panel);
      syncActive();
      status = { view: 'group', group, hidden: false };
      report();
    }

    function render(nav, items) {
      const list = catalog(items.map(item => ({ key: item.key, text: composedText(item.el) })), { label: locale });
      // Fold virtual groups discovered from the consolidated General pane into GROUP_ORDER.
      const byGroup = new Map(list.map(entry => [entry.group, entry]));
      for (const vGroup of VIRTUAL_SECTION_GROUPS) {
        if (vGroup === 'general' || !detectedVirtualGroups.has(vGroup) || byGroup.has(vGroup)) continue;
        byGroup.set(vGroup, { group: vGroup, label: labelOf(vGroup, locale), rows: [], virtual: true });
      }
      const orderedGroups = [
        ...Object.keys(PAGE_LABELS).filter(g => byGroup.has(g)),
        ...GROUP_ORDER.filter(g => byGroup.has(g)),
      ].map(g => byGroup.get(g));

      const host = hostOf(nav);
      host.textContent = '';
      const rootEl = doc.createElement('div');
      rootEl.className = 'rokbot-settings-nav-list';
      rootEl.setAttribute('role', 'list');

      rows = new Map();
      virtualRows = new Map();
      groups = [];

      for (const entry of orderedGroups) {
        const sectionEl = doc.createElement('div');
        sectionEl.className = 'rokbot-settings-nav-list__section';
        sectionEl.setAttribute('data-rokbot-settings-section', entry.group);

        const groupBtn = doc.createElement('button');
        groupBtn.type = 'button';
        groupBtn.className = 'rokbot-settings-nav-list__group';
        groupBtn.setAttribute('data-rokbot-settings-group', entry.group);
        const icon = doc.createElement('span');
        icon.className = 'rokbot-settings-nav-list__icon';
        icon.innerHTML = GROUP_ICON_SVG[entry.group] || '';
        const text = doc.createElement('span');
        text.className = 'rokbot-settings-nav-list__label';
        text.textContent = entry.label;
        const count = doc.createElement('span');
        count.className = 'rokbot-settings-nav-list__count';
        groupBtn.append(icon, text, count);

        // Standalone injected page (e.g. 输入建议): render as a direct single row without redundant group chrome.
        if (PAGE_LABELS[entry.group]) {
          const official = items.find(item => entry.rows.includes(item.key))?.el || null;
          if (!official) continue;
          const row = doc.createElement('button');
          row.type = 'button';
          row.className = 'rokbot-settings-nav-list__row rokbot-settings-nav-list__row--direct';
          row.setAttribute('data-rokbot-settings-row', entry.rows[0]);
          row.setAttribute('data-rokbot-settings-page', entry.group);
          const rIcon = doc.createElement('span');
          rIcon.className = 'rokbot-settings-nav-list__row-icon';
          rIcon.innerHTML = GROUP_ICON_SVG[entry.group] || '';
          const rLabel = doc.createElement('span');
          rLabel.className = 'rokbot-settings-nav-list__row-text';
          rLabel.textContent = composedText(official) || entry.label;
          row.append(rIcon, rLabel);
          row.addEventListener('click', () => activateOfficial(official, entry.group));
          sectionEl.appendChild(row);
          rootEl.appendChild(sectionEl);
          const cell = { official, row, group: entry.group, key: entry.rows[0] };
          rows.set(official, cell);
          groups.push({ group: entry.group, button: row, count, label: entry.label, cells: [cell], page: true });
          continue;
        }

        sectionEl.appendChild(groupBtn);

        if (entry.virtual && generalOfficialBtn) {
          const row = doc.createElement('button');
          row.type = 'button';
          row.className = 'rokbot-settings-nav-list__row';
          row.setAttribute('data-rokbot-settings-row', `virtual:${entry.group}`);
          const rLabel = doc.createElement('span');
          rLabel.className = 'rokbot-settings-nav-list__row-text';
          rLabel.textContent = entry.label;
          row.appendChild(rLabel);
          const onPick = () => activateVirtualGroup(entry.group);
          row.addEventListener('click', onPick);
          groupBtn.addEventListener('click', onPick);
          sectionEl.appendChild(row);
          rootEl.appendChild(sectionEl);
          virtualRows.set(entry.group, { row, group: entry.group, official: generalOfficialBtn });
          groups.push({
            group: entry.group,
            button: groupBtn,
            count,
            label: entry.label,
            cells: [{ official: generalOfficialBtn, row, group: entry.group, key: `virtual:${entry.group}`, virtual: true }],
            virtual: true,
          });
          continue;
        }

        const groupCells = [];
        for (const key of entry.rows) {
          const official = items.find(item => item.key === key)?.el;
          if (!official) continue;
          const row = doc.createElement('button');
          row.type = 'button';
          row.className = 'rokbot-settings-nav-list__row';
          row.setAttribute('data-rokbot-settings-row', key);
          const label = doc.createElement('span');
          label.className = 'rokbot-settings-nav-list__row-text';
          label.textContent = composedText(official);
          row.appendChild(label);
          row.addEventListener('click', () => activateOfficial(official, entry.group));
          sectionEl.appendChild(row);
          const cell = { official, row, group: entry.group, key };
          rows.set(official, cell);
          groupCells.push(cell);
        }
        if (groupCells.length === 0) continue;

        groupBtn.addEventListener('click', () => activateOfficial(groupCells[0].official, entry.group));
        count.textContent = groupCells.length > 1 ? String(groupCells.length) : '';
        rootEl.appendChild(sectionEl);
        groups.push({ group: entry.group, button: groupBtn, count, label: entry.label, cells: groupCells });
      }

      host.appendChild(rootEl);

      // Hide the flat official buttons while keeping them mounted inside nav so React & composer-assist keep working.
      for (const item of items) {
        item.el.hidden = true;
        item.el.setAttribute('data-rokbot-hidden', '1');
        if (item.el.style.display !== 'none') {
          item.el.dataset.rokbotPrevDisplay = item.el.style.display || '';
          item.el.style.display = 'none';
        }
      }
      for (const group of groups) {
        if (group.virtual || group.page) continue;
        const visible = group.cells.filter(cell => !isHidden(cell.official));
        if (visible.length === 0 && !group.cells.some(c => c.official.getAttribute?.('data-rokbot-hidden') === '1')) {
          group.button.hidden = true;
        }
      }
    }

    function syncActive() {
      const layout = layoutOf();
      const nav = layout && officialNavOf(layout);
      const panel = layout && panelOf(layout);
      if (!nav) return;
      const sugOpen = Boolean(panel?.classList?.contains('rokbot-sug-page-open'));
      const activeOfficial = navItems(nav).find(el => !el.closest('.rokbot-settings-nav-host') && isActive(el)) || null;
      const entry = activeOfficial ? rows.get(activeOfficial) : null;

      // Determine the active functional group (respecting virtual section filter when on the General tab).
      let activeGroup = null;
      if (sugOpen) activeGroup = 'input-suggestions';
      else if (activeOfficial === generalOfficialBtn && activeVirtualGroup) activeGroup = activeVirtualGroup;
      else if (entry) activeGroup = entry.group;

      for (const group of groups) {
        setActive(group.button, Boolean(activeGroup) && group.group === activeGroup);
      }
      for (const cell of rows.values()) {
        const match = sugOpen
          ? cell.group === 'input-suggestions'
          : (cell.official === activeOfficial && !(cell.official === generalOfficialBtn && activeVirtualGroup && activeVirtualGroup !== 'general'));
        setActive(cell.row, match);
      }
      for (const [vGroup, vCell] of virtualRows.entries()) {
        const match = !sugOpen && activeOfficial === generalOfficialBtn && activeVirtualGroup === vGroup;
        setActive(vCell.row, match);
      }
    }

    function showGroup(group) {
      const entry = groups.find(item => item.group === group);
      if (!entry) return;
      if (entry.virtual) {
        activateVirtualGroup(group);
        return;
      }
      const first = entry.cells[0]?.official;
      if (first) activateOfficial(first, group);
    }

    function showAll() {
      const layout = layoutOf();
      if (!layout) return;
      activeVirtualGroup = null;
      clearSectionFilter(panelOf(layout));
      syncActive();
      status = { view: 'all', group: null, hidden: false };
      report();
    }

    function sync() {
      if (destroyed) return;
      const layout = layoutOf();
      if (!layout) {
        const was = status.view;
        status = { view: 'closed', group: null, hidden: false };
        activeVirtualGroup = null;
        detectedVirtualGroups = new Set();
        generalOfficialBtn = null;
        for (const official of rows.keys()) {
          official.hidden = false;
          official.removeAttribute('data-rokbot-hidden');
          if (official.dataset?.rokbotPrevDisplay !== undefined) {
            official.style.display = official.dataset.rokbotPrevDisplay;
            delete official.dataset.rokbotPrevDisplay;
          }
        }
        rows = new Map();
        virtualRows = new Map();
        groups = [];
        doc.documentElement.classList.remove('rokbot-settings-grouped');
        if (was !== 'closed') report();
        return;
      }

      doc.documentElement.classList.add('rokbot-settings-grouped');
      const nav = officialNavOf(layout);
      const panel = panelOf(layout);
      if (!nav) return;

      const items = navItems(nav)
        .filter(el => !el.closest('[data-rokbot-settings-group]') && !el.closest('.rokbot-settings-nav-host'))
        .map(el => ({ el, key: stableKey(el) }));

      generalOfficialBtn = items.find(item => item.key === 'general')?.el || null;

      // Discover virtual sub-groups inside the General pane (e.g. 通知, 模型与用量, 数据与迁移).
      scanVirtualGroups(panel, items.map(item => item.key));

      const signature = items.map(item => item.key).join('|') + '::' + [...detectedVirtualGroups].sort().join(',');
      if (items.length !== rows.size
        || [...rows.keys()].some(el => !items.some(item => item.el === el))
        || nav.dataset.rokbotSettingsSignature !== signature) {
        nav.dataset.rokbotSettingsSignature = signature;
        render(nav, items);
      } else {
        for (const item of items) {
          const cell = rows.get(item.el);
          const labelNode = cell?.row?.querySelector?.('.rokbot-settings-nav-list__row-text');
          const nextText = composedText(item.el);
          if (labelNode && nextText && labelNode.textContent !== nextText) labelNode.textContent = nextText;
        }
      }

      // If we just opened on a consolidated General pane with virtual groups, default filter to 'general'.
      if (status.view === 'closed') {
        if (detectedVirtualGroups.size > 0 && generalOfficialBtn && isActive(generalOfficialBtn)) {
          activeVirtualGroup = 'general';
        }
        status = { view: 'all', group: activeVirtualGroup, hidden: false };
      }

      applySectionFilter(panel);
      syncActive();
    }

    return {
      sync,
      showGroup,
      showAll,
      setLocale(next) {
        if (typeof next !== 'string' || next === locale) return;
        locale = next;
        for (const group of groups) {
          group.label = labelOf(group.group, locale);
          const labelNode = group.button.querySelector?.('.rokbot-settings-nav-list__label')
            || group.button.querySelector?.('.rokbot-settings-nav-list__row-text');
          if (labelNode) labelNode.textContent = group.label;
          if (group.virtual) {
            const vRow = virtualRows.get(group.group)?.row;
            const vLabel = vRow?.querySelector?.('.rokbot-settings-nav-list__row-text');
            if (vLabel) vLabel.textContent = group.label;
          }
        }
      },
      get hidden() { return false; },
      get view() { return status.view; },
      get activeGroup() { return activeVirtualGroup; },
      get groups() {
        return groups.map(group => ({
          group: group.group,
          label: group.label,
          virtual: Boolean(group.virtual),
          rows: group.cells.map(cell => ({ key: cell.key, text: cell.virtual ? group.label : composedText(cell.official) })),
        }));
      },
      destroy() {
        destroyed = true;
        doc.documentElement.classList.remove('rokbot-settings-grouped');
        const layout = layoutOf();
        clearSectionFilter(panelOf(layout));
        const groupNav = layout && officialNavOf(layout);
        if (groupNav) {
          for (const el of navItems(groupNav)) {
            el.hidden = false;
            el.removeAttribute('data-rokbot-hidden');
            if (el.dataset?.rokbotPrevDisplay !== undefined) {
              el.style.display = el.dataset.rokbotPrevDisplay;
              delete el.dataset.rokbotPrevDisplay;
            }
          }
          delete groupNav.dataset.rokbotSettingsSignature;
          groupNav.querySelector('.rokbot-settings-nav-host')?.remove();
        }
        doc.getElementById(STYLE_ID)?.remove();
        rows = new Map();
        virtualRows = new Map();
        groups = [];
        detectedVirtualGroups = new Set();
        activeVirtualGroup = null;
        status = { view: 'closed', group: null, hidden: false };
      },
    };
  }

  return {
    GROUP_ORDER,
    GROUP_LABELS,
    GROUP_ICONS,
    GROUP_KEYS,
    SECTION_ORDER,
    catalog,
    groupOf,
    classifyGeneralSection,
    sectionKey,
    labelOf,
    overflows,
    installSettingsNav,
  };
});

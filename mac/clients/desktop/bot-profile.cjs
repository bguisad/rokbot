// Bot details page for the Web client and the desktop apps (macOS, Windows, Linux).
//
// On a phone the conversation header opens the Bot details hub (web/client/layout.js, shown as
// `.rokbot-bot-profile` inside `.sand-info-pane`). On a desktop, clicking the Bot name in the
// conversation header (`.sand-chat-header__identity`) opens this matching Bot details page inside
// `.sand-info-pane__inner`, presenting the Android Bot profile fields from existing interfaces:
//   - avatar, name, intro (getAgent / DOM header)
//   - model route & effort (GET /local/model -> botRoutes + defaultRoute)
//   - connection & pairing status (connectionStatus / HostProfile)
//   - usage summary (GET /local/usage -> today / 7d tokens & requests)
//   - quick actions (Routines, Library, Computer, Notifications toggle, Bot Settings, Edit)
//
// Clicking a quick action steps aside so the official subpage inside `.sand-info-pane` is shown
// with full native behaviour; clicking Back returns to the Bot details page or closes the pane.
// Pure helpers (modelSummary, usageSummary, connectionSummary, formatCount) have no DOM dependency.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.RokBotBotProfile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BODY_ATTR = 'data-rokbot-bot-details';
  const ROOT_CLASS = 'rokbot-bot-details';
  const OPEN_CLASS = 'rokbot-bot-details-open';
  const STYLE_ID = 'rokbot-bot-details-style';
  const PHONE_SPLIT_QUERY = '(min-width: 600px)';

  const SVG = (body, { size = 18, width = 1.8 } = {}) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
    + `stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    back: SVG('<path d="M15 5l-7 7 7 7"/>', { size: 20, width: 2 }),
    edit: SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>', { size: 15 }),
    routines: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    library: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    computer: SVG('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
    notify: SVG('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    model: SVG('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
    connection: SVG('<path d="M9 3H5a2 2 0 0 0-2 2v4"/><path d="M15 3h4a2 2 0 0 1 2 2v4"/><path d="M9 21H5a2 2 0 0 1-2-2v-4"/><path d="M15 21h4a2 2 0 0 0 2-2v-4"/>'),
    usage: SVG('<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l4-4 3 3 5-6"/>'),
    settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    chevron: SVG('<path d="M9 6l6 6-6 6"/>', { size: 16, width: 2 }),
  };

  const STRINGS = {
    zh: {
      back: '返回', details: 'Bot 详情', edit: '编辑', intro: '简介', model: '模型', connection: '连接与配对',
      usage: '用量', today: '今日', week: '近 7 天', month: '近 30 天', requests: n => `${n} 次请求`,
      tokens: n => `${formatCount(n)} tokens`, idle: '空闲', actions: '快捷操作', routines: '定时任务',
      library: '资料库', computer: '电脑', notify: '通知', settings: 'Bot 设置', share: '分享 Bot',
      noIntro: '还没有简介，点编辑补充这个 Bot 的用途。', notRouted: '跟随默认模型',
      notRoutedWith: name => `跟随默认模型（${name}）`, noConnection: '未连接',
      connected: '已连接', connecting: '正在连接', paired: '已配对', unpaired: '未配对',
      direct: '直连', relay: '中继', statusTitle: '模型与状态',
      noUsage: '暂无用量记录', loading: '加载中…', activeCount: n => `${n} 已开启`,
      notifyCaption: 'Bot 完成任务或需要你处理时通知你',
    },
    en: {
      back: 'Back', details: 'Bot details', edit: 'Edit', intro: 'About', model: 'Model', connection: 'Connection & pairing',
      usage: 'Usage', today: 'Today', week: '7 days', month: '30 days', requests: n => `${n} requests`,
      tokens: n => `${formatCount(n)} tokens`, idle: 'Idle', actions: 'Quick actions', routines: 'Routines',
      library: 'Library', computer: 'Computer', notify: 'Notifications', settings: 'Bot settings', share: 'Share Bot',
      noIntro: 'No description yet. Use Edit to describe what this Bot is for.', notRouted: 'Follows default model',
      notRoutedWith: name => `Follows default (${name})`, noConnection: 'Disconnected',
      connected: 'Connected', connecting: 'Connecting', paired: 'Paired', unpaired: 'Not paired',
      direct: 'Direct', relay: 'Relay', statusTitle: 'Model & status',
      noUsage: 'No usage recorded yet', loading: 'Loading…', activeCount: n => `${n} active`,
      notifyCaption: 'Notify when this Bot finishes a task or needs your input',
    },
  };

  function strings(lang) { return /^zh\b/i.test(String(lang || '')) ? STRINGS.zh : STRINGS.en; }

  function formatCount(n) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '0';
    if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
    return String(Math.round(value));
  }

  /** "Claude Opus · high": the profile's name (its model id when unnamed) and effort for a routed Bot. */
  function modelSummary(config, botId) {
    const fallback = { routed: false, name: '', effort: '', text: '' };
    if (!config || typeof config !== 'object') return fallback;
    const route = botId && config.botRoutes && typeof config.botRoutes === 'object' ? config.botRoutes[botId] : null;
    if (!route || typeof route !== 'object') return fallback;
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const profile = profiles.find(item => item && item.id === route.profileId) || null;
    const name = profile ? (profile.name || profile.model || route.profileId || '') : (route.profileId || '');
    const effort = typeof route.effort === 'string' && route.effort && route.effort !== 'default' ? route.effort : '';
    return { routed: true, name: String(name || ''), effort, text: [name, effort].filter(Boolean).join(' · ') };
  }

  function defaultModelName(config) {
    if (!config || typeof config !== 'object') return '';
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const defRoute = config.defaultRoute && typeof config.defaultRoute === 'object' ? config.defaultRoute : null;
    if (defRoute?.profileId) {
      const profile = profiles.find(item => item && item.id === defRoute.profileId) || null;
      return String(profile?.name || profile?.model || defRoute.profileId || '').trim();
    }
    if (typeof config.model === 'string' && config.model.trim()) return config.model.trim();
    return '';
  }

  /** The Host's GET /local/usage answer, reduced to what the page shows. */
  function usageSummary(usage) {
    const empty = { ok: false, today: null, requests: null, text: '' };
    if (!usage || usage.ok !== true) return empty;
    const periods = Array.isArray(usage.periods) ? usage.periods : [];
    const today = periods.find(period => period && period.id === 'today') || null;
    const todayTotal = Number.isFinite(today?.total) ? today.total : Number.isFinite(usage.total) ? usage.total : null;
    const requests = Number.isFinite(today?.requests) ? today.requests
      : Number.isFinite(usage.requests) ? usage.requests : null;
    return { ok: true, today: todayTotal, requests, text: '' };
  }

  function weekUsageTotal(usage) {
    if (!usage || usage.ok !== true || !Array.isArray(usage.periods)) return null;
    const week = usage.periods.find(period => period && period.id === '7d') || null;
    return Number.isFinite(week?.total) ? week.total : null;
  }

  /** A connection record (`connectionStatus()` or boot data) reduced to status fields. */
  function connectionSummary(status) {
    const info = status && typeof status === 'object'
      ? (status.connection && typeof status.connection === 'object' ? status.connection : status)
      : {};
    const connected = info.connected === true || info.ok === true || info.state === 'online';
    const paired = typeof info.paired === 'boolean' ? info.paired : null;
    const transport = typeof info.transportPath === 'string' && info.transportPath
      ? (info.tailcat === true ? `tailcat:${info.transportPath}` : info.transportPath)
      : info.tailcat === true ? 'tailcat' : '';
    const hostName = typeof info.profile?.hostName === 'string' && info.profile.hostName.trim()
      ? info.profile.hostName.trim()
      : '';
    return {
      connected,
      paired,
      transport: info.tailcat === true && !info.transportPath ? 'tailcat'
        : typeof info.transportPath === 'string' ? info.transportPath
          : transport,
      host: hostName || (typeof info.server === 'string' ? info.server : ''),
      version: typeof info.version === 'string' ? info.version
        : typeof status?.localVersion === 'string' ? status.localVersion : '',
      error: typeof info.error === 'string' ? info.error : '',
    };
  }

  function formatTransport(conn, s) {
    if (!conn) return '';
    const raw = String(conn.transport || '').toLowerCase();
    if (raw === 'direct') return s.direct;
    if (raw === 'relay') return s.relay;
    if (raw === 'tailcat') return 'Tailcat';
    return conn.transport || '';
  }

  function installBotProfile({
    document: doc = globalThis.document,
    window: win = globalThis.window,
    locale: initialLocale = '',
    getViewingAgentId,
    getAgent,
    getAutomations,
    setNotify,
    usage,
    modelConfig,
    connection,
  } = {}) {
    if (!doc || !win) return { open() { return false; }, close() {}, setLocale() {}, get isOpen() { return false; }, get botId() { return ''; }, destroy() {} };

    let locale = initialLocale;
    const usageOf = () => (usage || globalThis.RokBotBotProfileDeps?.usage)?.() ?? Promise.resolve(null);
    const modelOf = () => (modelConfig || globalThis.RokBotBotProfileDeps?.modelConfig)?.() ?? Promise.resolve(null);
    const connectionOf = () => {
      const read = connection || globalThis.RokBotBotProfileDeps?.connection
        || (win.localBot?.connectionStatus ? () => win.localBot.connectionStatus() : null);
      return read ? read() : Promise.resolve(null);
    };
    const agentOf = id => {
      const fn = getAgent || (win.__rokbotProfile ?? globalThis.__rokbotProfile)?.getAgent;
      return fn ? fn(id) : Promise.resolve(null);
    };
    const automationsOf = id => {
      const fn = getAutomations || (win.__rokbotProfile ?? globalThis.__rokbotProfile)?.getAutomations;
      return fn ? fn(id) : Promise.resolve(null);
    };
    const notifySet = (id, next) => {
      const fn = setNotify || (win.__rokbotProfile ?? globalThis.__rokbotProfile)?.setNotify;
      return fn ? fn(id, next) : Promise.resolve(null);
    };

    let state = null;
    let root = null;
    let subpageActive = false;
    let observer = null;
    let loadSeq = 0;

    const t = () => strings(locale || doc.documentElement?.lang);
    const query = () => win.matchMedia?.(PHONE_SPLIT_QUERY);
    const isWide = () => Boolean(query()?.matches);
    const identity = () => doc.querySelector('.sand-chat-header__identity');

    function botId() {
      const tracked = typeof getViewingAgentId === 'function' ? getViewingAgentId() : '';
      if (typeof tracked === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(tracked)) return tracked;
      const selected = doc.querySelector('.sand-agents-sidebar .sand-agent-item[aria-current="page"]');
      if (selected?.dataset?.agentId) return selected.dataset.agentId;
      const currentId = selected?.getAttribute?.('data-agent-id');
      if (currentId) return currentId;
      for (const el of doc.querySelectorAll('[data-agent-id]')) {
        const value = el.getAttribute('data-agent-id');
        if (value && !el.closest('.sand-agents-sidebar [role="menu"]')) return value;
      }
      return '';
    }

    function botName(id) {
      const selected = doc.querySelector('.sand-agents-sidebar .sand-agent-item[aria-current="page"]');
      const fromSidebar = selected?.querySelector('[class*="name"], [class*="title"]')?.textContent?.trim();
      const fromHeader = doc.querySelector('.sand-chat-header__title, .sand-chat-header__name, .sand-chat-header__identity [class*="name"]')?.textContent?.trim();
      const fromAttr = identity()?.getAttribute('aria-label')?.replace(/^(打开|查看|Open|View)\s*/i, '').trim();
      return fromHeader || fromSidebar || fromAttr || (id ? id : 'Bot');
    }

    function introOf(agent) {
      const value = agent?.description ?? agent?.intro ?? agent?.about ?? '';
      return typeof value === 'string' ? value.trim() : '';
    }

    async function load() {
      const id = state?.botId;
      const seq = ++loadSeq;
      const [agentRes, automationRes, usageRes, modelRes, connectionRes] = await Promise.allSettled([
        id ? agentOf(id) : Promise.resolve(null),
        id ? automationsOf(id) : Promise.resolve(null),
        usageOf(),
        modelOf(),
        connectionOf(),
      ]);
      if (!state || seq !== loadSeq || state.botId !== id) return;
      const agent = agentRes.status === 'fulfilled' ? (agentRes.value?.agent ?? agentRes.value) : null;
      if (agent && typeof agent === 'object') {
        if (typeof agent.name === 'string' && agent.name.trim()) state.name = agent.name.trim();
        const desc = introOf(agent);
        const title = typeof agent.title === 'string' ? agent.title.trim() : '';
        state.intro = desc || title || state.intro;
        if (typeof agent.notifyOnUpdatesEnabled === 'boolean') state.notify = agent.notifyOnUpdatesEnabled;
        if (typeof agent.createdAt === 'string') state.createdAt = agent.createdAt;
      }
      const automations = automationRes.status === 'fulfilled' ? automationRes.value : null;
      const list = Array.isArray(automations?.automations) ? automations.automations
        : Array.isArray(automations) ? automations : null;
      if (list) state.routines = list.filter(item => item && item.isEnabled !== false && item.enabled !== false && item.paused !== true).length;
      if (usageRes.status === 'fulfilled') {
        state.usage = usageSummary(usageRes.value);
        state.weekUsage = weekUsageTotal(usageRes.value);
      }
      if (modelRes.status === 'fulfilled') {
        const cfg = modelRes.value?.config ?? modelRes.value;
        state.model = modelSummary(cfg, id);
        state.defaultModel = defaultModelName(cfg);
      }
      if (connectionRes.status === 'fulfilled' && connectionRes.value) {
        state.connection = connectionSummary(connectionRes.value);
        state.connectionState = typeof connectionRes.value?.state === 'string' ? connectionRes.value.state : '';
        state.connectionTailcat = connectionRes.value?.tailcat === true;
      }
      state.loaded = true;
      render();
    }

    function setOverlayVisible(visible) {
      if (root) root.hidden = !visible;
      doc.documentElement.classList.toggle(OPEN_CLASS, Boolean(visible && state));
    }

    function mount() {
      const pane = doc.querySelector('.sand-info-pane[data-open="true"]');
      const inner = pane?.querySelector('.sand-info-pane__inner');
      if (!inner) return false;
      ensureStyle(doc);
      if (root && root.parentElement === inner) {
        setOverlayVisible(true);
        return true;
      }
      root?.remove();
      root = doc.createElement('div');
      root.className = ROOT_CLASS;
      root.setAttribute(BODY_ATTR, '1');
      root.innerHTML = template();
      inner.appendChild(root);
      root.querySelector('.rokbot-bot-details__back')?.addEventListener('click', close);
      for (const button of root.querySelectorAll('[data-bot-action]')) {
        button?.addEventListener('click', () => run(button.getAttribute('data-bot-action')));
      }
      const toggle = root.querySelector('[data-bot-toggle="notify"]');
      toggle?.addEventListener('click', () => {
        const next = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(next));
        if (state) state.notify = next;
        const id = state?.botId;
        if (id) {
          Promise.resolve(notifySet(id, next)).catch(() => {
            if (state && state.botId === id) {
              state.notify = !next;
              toggle.setAttribute('aria-checked', String(!next));
            }
          });
        }
      });
      setOverlayVisible(true);
      return true;
    }

    function open() {
      if (!isWide() || !identity()) return false;
      subpageActive = false;
      const currentId = botId();
      if (state && state.botId === currentId && doc.querySelector(`.${ROOT_CLASS}`)) {
        setOverlayVisible(true);
        render();
        void load();
        return true;
      }
      state = {
        botId: currentId,
        name: '',
        intro: '',
        model: null,
        defaultModel: '',
        usage: null,
        weekUsage: null,
        connection: null,
        connectionState: '',
        connectionTailcat: false,
        routines: null,
        notify: true,
        loaded: false,
      };
      const mounted = mount();
      if (!mounted) {
        state = null;
        return false;
      }
      render();
      void load();
      return true;
    }

    function unmount() {
      loadSeq += 1;
      subpageActive = false;
      root?.remove();
      root = null;
      state = null;
      doc.documentElement.classList.remove(OPEN_CLASS);
    }

    function close() {
      const pane = doc.querySelector('.sand-info-pane[data-open="true"]');
      if (pane) {
        const back = pane.querySelector('.sand-info-pane__back button');
        if (back) back.click();
        else [...pane.querySelectorAll('.sand-info-pane__actions button')].pop()?.click();
      }
      unmount();
    }

    function template() {
      const s = t();
      return `
        <div class="rokbot-bot-details__topbar">
          <button type="button" class="rokbot-bot-details__icon-btn rokbot-bot-details__back" aria-label="${s.back}">${ICON.back}</button>
          <span class="rokbot-bot-details__topbar-title">${s.details}</span>
        </div>
        <div class="rokbot-bot-details__scroll">
          <div class="rokbot-bot-details__hero">
            <div class="rokbot-bot-details__avatar"></div>
            <h2 class="rokbot-bot-details__name"></h2>
            <button type="button" class="rokbot-bot-details__edit" data-bot-action="edit">${ICON.edit}<span>${s.edit}</span></button>
          </div>
          <div class="rokbot-bot-details__section">
            <h3 class="rokbot-bot-details__heading">${s.intro}</h3>
            <p class="rokbot-bot-details__intro"></p>
          </div>
          <div class="rokbot-bot-details__section">
            <h3 class="rokbot-bot-details__heading">${s.statusTitle}</h3>
            <div class="rokbot-bot-details__facts">
              <div class="rokbot-bot-details__fact" data-bot-fact="model">
                <span class="rokbot-bot-details__fact-icon">${ICON.model}</span>
                <span class="rokbot-bot-details__fact-body"><span class="rokbot-bot-details__fact-label">${s.model}</span><span class="rokbot-bot-details__fact-value"></span></span>
              </div>
              <div class="rokbot-bot-details__fact" data-bot-fact="connection">
                <span class="rokbot-bot-details__fact-icon">${ICON.connection}</span>
                <span class="rokbot-bot-details__fact-body"><span class="rokbot-bot-details__fact-label">${s.connection}</span><span class="rokbot-bot-details__fact-value"></span></span>
              </div>
              <div class="rokbot-bot-details__fact" data-bot-fact="usage">
                <span class="rokbot-bot-details__fact-icon">${ICON.usage}</span>
                <span class="rokbot-bot-details__fact-body"><span class="rokbot-bot-details__fact-label">${s.usage}</span><span class="rokbot-bot-details__fact-value"></span></span>
              </div>
            </div>
          </div>
          <div class="rokbot-bot-details__section">
            <h3 class="rokbot-bot-details__heading">${s.actions}</h3>
            <div class="rokbot-bot-details__card">
              <button type="button" class="rokbot-bot-details__row" data-bot-action="routines">
                <span class="rokbot-bot-details__row-icon">${ICON.routines}</span>
                <span class="rokbot-bot-details__row-label">${s.routines}</span>
                <span class="rokbot-bot-details__row-meta" data-bot-meta="routines"></span>${ICON.chevron}
              </button>
              <button type="button" class="rokbot-bot-details__row" data-bot-action="library">
                <span class="rokbot-bot-details__row-icon">${ICON.library}</span>
                <span class="rokbot-bot-details__row-label">${s.library}</span>${ICON.chevron}
              </button>
              <button type="button" class="rokbot-bot-details__row" data-bot-action="computer">
                <span class="rokbot-bot-details__row-icon">${ICON.computer}</span>
                <span class="rokbot-bot-details__row-label">${s.computer}</span>
                <span class="rokbot-bot-details__row-meta" data-bot-meta="computer"></span>${ICON.chevron}
              </button>
              <div class="rokbot-bot-details__row" role="group">
                <span class="rokbot-bot-details__row-icon">${ICON.notify}</span>
                <span class="rokbot-bot-details__row-label">${s.notify}</span>
                <button type="button" role="switch" aria-checked="true" class="rokbot-bot-details__switch" data-bot-toggle="notify"><span></span></button>
              </div>
            </div>
            <p class="rokbot-bot-details__caption">${s.notifyCaption}</p>
            <div class="rokbot-bot-details__card">
              <button type="button" class="rokbot-bot-details__row" data-bot-action="settings">
                <span class="rokbot-bot-details__row-icon">${ICON.settings}</span>
                <span class="rokbot-bot-details__row-label">${s.settings}</span>${ICON.chevron}
              </button>
            </div>
          </div>
        </div>`;
    }

    function setText(selector, text) {
      const el = root?.querySelector(selector);
      if (!el) return;
      if (el.textContent !== text) el.textContent = text;
    }

    function render() {
      if (!root || !state) return;
      const s = t();
      const avatarSlot = root.querySelector('.rokbot-bot-details__avatar');
      const headerAvatar = doc.querySelector('.sand-chat-header__avatar > *, .sand-chat-header__avatar, .sand-chat-header__identity > span:first-child');
      if (avatarSlot && headerAvatar) {
        const key = (headerAvatar.outerHTML || headerAvatar.textContent || '').slice(0, 120);
        if (avatarSlot.dataset.key !== key) {
          avatarSlot.dataset.key = key;
          const clone = headerAvatar.cloneNode ? headerAvatar.cloneNode(true) : null;
          if (clone) {
            clone.removeAttribute?.('style');
            for (const el of clone.querySelectorAll?.('[style]') ?? []) el.removeAttribute('style');
            avatarSlot.replaceChildren(clone);
          }
        }
      }
      setText('.rokbot-bot-details__name', state.name || botName(state.botId));

      const intro = state.intro || '';
      const introEl = root.querySelector('.rokbot-bot-details__intro');
      if (introEl) {
        introEl.textContent = intro || s.noIntro;
        introEl.dataset.empty = intro ? 'false' : 'true';
      }

      const model = state.model;
      const modelText = !state.loaded
        ? s.loading
        : model?.routed
          ? model.text
          : state.defaultModel ? s.notRoutedWith(state.defaultModel) : s.notRouted;
      setText('[data-bot-fact="model"] .rokbot-bot-details__fact-value', modelText);

      const conn = state.connection;
      let connectionText = s.loading;
      if (state.loaded) {
        if (!conn) {
          connectionText = s.noConnection;
        } else {
          const stateText = conn.connected ? s.connected : (state.connectionState === 'connecting' ? s.connecting : s.noConnection);
          const pairText = conn.paired === true ? s.paired : conn.paired === false ? s.unpaired : '';
          const via = state.connectionTailcat
            ? (conn.transport && conn.transport !== 'tailcat' ? `Tailcat · ${formatTransport(conn, s)}` : 'Tailcat')
            : formatTransport(conn, s);
          connectionText = [stateText, pairText, via, conn.host].filter(Boolean).join(' · ');
        }
      }
      setText('[data-bot-fact="connection"] .rokbot-bot-details__fact-value', connectionText);

      const usageVal = state.usage;
      let usageText = s.loading;
      if (state.loaded) {
        if (usageVal?.ok && usageVal.today !== null) {
          const parts = [`${s.today} ${s.tokens(usageVal.today)}`];
          if (usageVal.requests !== null) parts.push(s.requests(usageVal.requests));
          if (state.weekUsage !== null && state.weekUsage > usageVal.today) parts.push(`${s.week} ${s.tokens(state.weekUsage)}`);
          usageText = parts.join(' · ');
        } else {
          usageText = s.noUsage;
        }
      }
      setText('[data-bot-fact="usage"] .rokbot-bot-details__fact-value', usageText);

      setText('[data-bot-meta="routines"]', typeof state.routines === 'number' ? s.activeCount(state.routines) : '');
      const computerStatus = doc.querySelector('.sand-computer-card__status')?.textContent?.trim() || s.idle;
      setText('[data-bot-meta="computer"]', computerStatus);
      root.querySelector('[data-bot-toggle="notify"]')?.setAttribute('aria-checked', String(state.notify !== false));
      root.dataset.botId = state.botId || '';
    }

    function run(action) {
      const pane = doc.querySelector('.sand-info-pane[data-open="true"]');
      if (!pane) return;
      const clickByText = pattern => [...pane.querySelectorAll('button, [role="button"]')]
        .find(btn => !btn.closest(`.${ROOT_CLASS}`) && pattern.test(btn.textContent || ''));

      // Step aside so the official subpage inside `.sand-info-pane` is visible and interactive.
      subpageActive = true;
      setOverlayVisible(false);

      if (action === 'settings' || action === 'edit') {
        const row = pane.querySelector('[data-info-row="settings"]');
        if (row) row.click();
        else clickByText(/settings|设置|設定/i)?.click();
        if (action === 'edit') {
          const input = () => pane.querySelector('.sand-info-pane__section-content input');
          const started = win.performance?.now?.() ?? 0;
          const step = () => {
            const field = input();
            if (field) { field.focus?.(); field.select?.(); return; }
            if ((win.performance?.now?.() ?? 0) - started < 1200) win.requestAnimationFrame?.(step);
          };
          win.requestAnimationFrame?.(step);
        }
        return;
      }
      if (action === 'library') {
        const direct = clickByText(/library files|shared files|资料库/i);
        if (direct) { direct.click(); return; }
        const row = pane.querySelector('[data-info-row="settings"]');
        if (row) {
          row.click();
          const started = win.performance?.now?.() ?? 0;
          const step = () => {
            const btn = clickByText(/library files|shared files|资料库/i);
            if (btn) { btn.click(); return; }
            if ((win.performance?.now?.() ?? 0) - started < 1200) win.requestAnimationFrame?.(step);
          };
          win.requestAnimationFrame?.(step);
        }
        return;
      }
      if (action === 'routines' || action === 'computer') {
        const back = pane.querySelector('.sand-info-pane__back button');
        if (back) back.click();
      }
    }

    // Header click: let React open `.sand-info-pane` (or toggle it closed), then mount Bot details.
    const onHeaderClick = event => {
      if (!event.target || typeof event.target.closest !== 'function') return;
      // Returning from an official subpage via `.sand-info-pane__back` restores Bot details.
      if (subpageActive && state && event.target.closest('.sand-info-pane__back button')) {
        win.requestAnimationFrame?.(() => {
          if (state && doc.querySelector('.sand-info-pane[data-open="true"]')) {
            subpageActive = false;
            setOverlayVisible(true);
            render();
          }
        });
        return;
      }
      if (!event.target.closest('.sand-chat-header__identity')) return;
      if (!isWide()) return;
      const wasOpen = Boolean(state && !subpageActive && doc.querySelector('.sand-info-pane[data-open="true"]'));
      let attempts = 0;
      const tryMount = () => {
        const pane = doc.querySelector('.sand-info-pane[data-open="true"]');
        if (wasOpen && !pane) { unmount(); return; }
        if (pane?.querySelector('.sand-info-pane__inner')) { open(); return; }
        if (++attempts < 24) win.requestAnimationFrame?.(tryMount);
      };
      win.requestAnimationFrame?.(tryMount);
    };
    doc.addEventListener('click', onHeaderClick, true);

    const onKeyDown = event => {
      if (event.key === 'Escape' && state) close();
    };
    win.addEventListener('keydown', onKeyDown);

    // Keep state in sync if React closes `.sand-info-pane` externally or switches Bots.
    if (typeof win.MutationObserver === 'function' || typeof globalThis.MutationObserver === 'function') {
      const MO = win.MutationObserver || globalThis.MutationObserver;
      observer = new MO(() => {
        if (!state) return;
        const pane = doc.querySelector('.sand-info-pane[data-open="true"]');
        if (!pane) { unmount(); return; }
        const currentId = botId();
        if (currentId && state.botId && currentId !== state.botId) {
          state.botId = currentId;
          state.name = '';
          state.intro = '';
          state.loaded = false;
          render();
          void load();
        }
      });
      if (doc.documentElement) {
        try { observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-open', 'aria-current'] }); } catch {}
      }
    }

    return {
      open,
      close,
      setLocale(next) {
        if (typeof next !== 'string' || next === locale) return;
        locale = next;
        if (root && state) {
          root.innerHTML = template();
          root.querySelector('.rokbot-bot-details__back')?.addEventListener('click', close);
          for (const button of root.querySelectorAll('[data-bot-action]')) {
            button?.addEventListener('click', () => run(button.getAttribute('data-bot-action')));
          }
          render();
        }
      },
      get isOpen() { return Boolean(state); },
      get botId() { return state?.botId || ''; },
      destroy() {
        observer?.disconnect();
        observer = null;
        doc.removeEventListener('click', onHeaderClick, true);
        win.removeEventListener('keydown', onKeyDown);
        unmount();
      },
    };
  }

  const STYLE = `
html.${OPEN_CLASS} .sand-info-pane[data-open="true"] > .sand-info-pane__inner {
  position: relative !important;
}
html.${OPEN_CLASS} .sand-info-pane[data-open="true"] > .sand-info-pane__inner > :not(.${ROOT_CLASS}) {
  visibility: hidden !important;
  pointer-events: none !important;
}
.${ROOT_CLASS} {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--cursor-bg-elevated, var(--sand-bg-primary, #1c1c1e));
  color: var(--cursor-text-primary, var(--sand-text-primary, inherit));
}
html[data-theme*="light"] .${ROOT_CLASS},
html.light .${ROOT_CLASS} {
  background: var(--cursor-bg-elevated, var(--sand-bg-primary, #ffffff));
}
.${ROOT_CLASS}[hidden] {
  display: none !important;
}
.${ROOT_CLASS}__topbar { display: flex; align-items: center; gap: 8px; flex: none; padding: 10px 14px 6px; }
.${ROOT_CLASS}__topbar-title { font-size: 13px; font-weight: 500; opacity: 0.7; }
.${ROOT_CLASS}__icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
.${ROOT_CLASS}__icon-btn:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.${ROOT_CLASS}__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 16px 28px; }
.${ROOT_CLASS}__hero { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px 0 18px; text-align: center; }
.${ROOT_CLASS}__avatar { display: flex; align-items: center; justify-content: center; width: 72px; height: 72px; border-radius: 20px; overflow: hidden; background: color-mix(in srgb, currentColor 8%, transparent); }
.${ROOT_CLASS}__avatar > * { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
.${ROOT_CLASS}__name { margin: 0; font-size: 20px; line-height: 26px; font-weight: 600; }
.${ROOT_CLASS}__edit { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 15px; background: transparent; color: inherit; font-family: inherit; font-size: 13px; cursor: pointer; }
.${ROOT_CLASS}__edit:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.${ROOT_CLASS}__section { display: flex; flex-direction: column; gap: 8px; padding-top: 14px; }
.${ROOT_CLASS}__heading { margin: 0; padding: 0 4px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; opacity: 0.6; }
.${ROOT_CLASS}__intro { margin: 0; padding: 12px 14px; font-size: 13px; line-height: 20px; border-radius: 12px; background: color-mix(in srgb, currentColor 4%, transparent); white-space: pre-wrap; }
.${ROOT_CLASS}__intro[data-empty="true"] { opacity: 0.6; }
.${ROOT_CLASS}__facts { display: flex; flex-direction: column; border-radius: 12px; background: color-mix(in srgb, currentColor 4%, transparent); overflow: hidden; }
.${ROOT_CLASS}__fact { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 14px; }
.${ROOT_CLASS}__fact + .${ROOT_CLASS}__fact { border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
.${ROOT_CLASS}__fact-icon, .${ROOT_CLASS}__row-icon { display: inline-flex; flex: none; opacity: 0.7; }
.${ROOT_CLASS}__fact-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.${ROOT_CLASS}__fact-label { font-size: 11px; opacity: 0.6; }
.${ROOT_CLASS}__fact-value { font-size: 13px; overflow-wrap: anywhere; }
.${ROOT_CLASS}__card { display: flex; flex-direction: column; border-radius: 12px; background: color-mix(in srgb, currentColor 4%, transparent); overflow: hidden; }
.${ROOT_CLASS}__row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 8px 14px; border: 0; background: transparent; color: inherit; font-family: inherit; font-size: 14px; text-align: left; }
button.${ROOT_CLASS}__row { cursor: pointer; }
button.${ROOT_CLASS}__row:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.${ROOT_CLASS}__row + .${ROOT_CLASS}__row { border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
.${ROOT_CLASS}__row-label { flex: 1 1 auto; min-width: 0; }
.${ROOT_CLASS}__row-meta { flex: none; font-size: 12px; opacity: 0.6; }
.${ROOT_CLASS}__caption { margin: 0 4px 2px; font-size: 12px; line-height: 17px; opacity: 0.55; }
.${ROOT_CLASS}__switch { position: relative; flex: none; width: 40px; height: 24px; margin-left: auto; border: 0; border-radius: 12px; background: color-mix(in srgb, currentColor 20%, transparent); cursor: pointer; transition: background 120ms ease; }
.${ROOT_CLASS}__switch > span { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 0.3); transition: transform 120ms ease; }
.${ROOT_CLASS}__switch[aria-checked="true"] { background: #2f7cf6; }
.${ROOT_CLASS}__switch[aria-checked="true"] > span { transform: translateX(16px); }
@media (prefers-reduced-motion: reduce) {
  .${ROOT_CLASS}__switch, .${ROOT_CLASS}__switch > span { transition: none; }
}
`;

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(style);
  }

  return {
    STRINGS,
    PHONE_SPLIT_QUERY,
    modelSummary,
    usageSummary,
    connectionSummary,
    formatCount,
    installBotProfile,
  };
});

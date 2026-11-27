// The admin console's page registry and router. Pure data and functions (no DOM, no i18n), so
// host/tests can import it directly. Labels and descriptions are Chinese source strings; the shell
// translates them with t() when it renders (English lives in locales-en.js).
//
// How a page is put together:
//   modules  one entry per page module: id -> [file, exported factory, options?]. app.js creates
//            every module at start-up (they share the 5 s status poll), except those registered with
//            { lazy: true }: those are imported and created on the first visit to a page using them.
//   pages    the left navigation, in order. A page has a title, a one-line description, an icon
//            (icons.js) and one or more tabs; every tab has its own URL: #/<page>/<tab>.
//   blocks   what a tab shows: module panels, in order. `only` keeps just the panel parts that match
//            (or contain a match for) one of the selectors; `except` hides matching parts. The page
//            header of a module (its action buttons) shows unless `actions: false`, or `only` is
//            given without `actions: true`. Dialogs are never hidden.
//
// Adding a page (for example a migration upload page):
//   1. write public/<name>.js exporting a factory that fills [data-panel=<id>] and returns { load }
//   2. register it here: modules[<id>] = ['<name>.js', 'createX', { lazy: true }] (drop the options
//      if it needs the status poll from start-up), then add a tab to a page, or a page to `pages`:
//        { id: 'migrate', label: '迁移', blocks: [{ view: 'migrate' }] }
//   3. add English strings for the new labels to locales-en.js.
// Old `?view=` links and `#anchors` keep working through `legacyViews` and `legacyAnchors`.

export const modules = {
  overview: ['overview.js', 'createOverview'],
  general: ['general.js', 'createGeneral'],
  model: ['model.js', 'createModelPage'],
  speech: ['speech.js', 'createSpeechPage'],
  media: ['media.js', 'createMediaEditor'],
  'web-services': ['media-web.js', 'createWebServicesEditor'],
  harness: ['harness.js', 'createHarnessEditor'],
  skills: ['skills.js', 'createSkillsEditor'],
  apps: ['apps.js', 'createApps'],
  prompts: ['prompts.js', 'createPromptEditor'],
  devices: ['devices.js', 'createDevices'],
  'web-client': ['web-client.js', 'createWebClientPage'],
  updates: ['updates.js', 'createUpdatesPage'],
  network: ['network.js', 'createNetworkEditor'],
  execution: ['execution.js', 'createExecutionEditor'],
  federation: ['federation.js', 'createFederationEditor'],
  webhooks: ['webhooks.js', 'createWebhookEditor'],
  sharing: ['sharing.js', 'createSharingEditor'],
  usage: ['usage.js', 'createUsagePage'],
  system: ['system.js', 'createSystemPage'],
};

// The model form keeps one save bar for all of its sections; both model tabs show it.
const modelSave = ['#legacy-routing-notice', '#model-error', '#model-form > .actions'];

export const pages = [
  { id: 'overview', label: '概览', icon: 'overview', layout: 'overview',
    description: '运行状态、今日用量和需要处理的事项。',
    tabs: [{ id: 'home', label: '概览', blocks: [{ view: 'overview' }] }] },
  { id: 'models', label: '模型', icon: 'model',
    description: '接入模型服务，配置模型档案、默认路由、备用模型和场景模型，以及语音、图片与联网工具。',
    tabs: [
      { id: 'providers', label: '服务与档案', summary: 'model',
        blocks: [{ view: 'model', only: ['section:has(#model-providers)', 'section:has(#sync-model-contexts)', ...modelSave] }] },
      { id: 'routing', label: '路由与备用', summary: 'routes',
        blocks: [{ view: 'model', only: ['section:has(#model-default-route)', '#model-scenario-section', 'section:has(#model-bot-routes)',
          '#model-adaptive-section', ...modelSave] }] },
      { id: 'speech', label: '语音', summary: 'speech', blocks: [{ view: 'speech' }] },
      { id: 'media', label: '图片与视频', summary: 'media', blocks: [{ view: 'media' }] },
      { id: 'web', label: '联网工具', summary: 'web-services', blocks: [{ view: 'web-services' }] },
    ] },
  { id: 'usage', label: '用量统计', icon: 'chart', layout: 'wide',
    description: '按时间、模型、服务商和 Bot 查看 Token、请求次数与花费，可导出 CSV。',
    tabs: [{ id: 'report', label: '用量统计', blocks: [{ view: 'usage' }] }] },
  { id: 'clients', label: '客户端与发布', icon: 'package',
    description: '网页版、桌面端、安卓和 iOS 客户端的安装包、更新通道与签名。',
    tabs: [
      { id: 'web', label: '网页版', summary: 'web-client', blocks: [{ view: 'web-client' }] },
      { id: 'updates', label: '客户端更新', blocks: [{ view: 'updates', except: ['section:has(#updates-key-spki)'] }] },
      { id: 'signing', label: '签名公钥', blocks: [{ view: 'updates', only: ['section:has(#updates-key-spki)'] }] },
    ] },
  { id: 'devices', label: '设备与连接', icon: 'devices',
    description: '配对和管理设备，设置通知与推送，以及远程访问、执行电脑和 Host 协作。',
    tabs: [
      { id: 'list', label: '设备与配对', summary: 'devices',
        blocks: [{ view: 'devices', actions: true, only: ['#pairing-panel', 'section:has(#device-list)'] }] },
      { id: 'notify', label: '通知与推送',
        blocks: [{ view: 'devices', only: ['section:has(#notification-frequency)', 'section:has(#device-test-agent)', '#push-form'] }] },
      { id: 'network', label: '远程访问', summary: 'network', blocks: [{ view: 'network' }] },
      { id: 'execution', label: '执行环境', summary: 'execution', blocks: [{ view: 'execution' }] },
      { id: 'federation', label: 'Host 协作', summary: 'federation', blocks: [{ view: 'federation' }] },
    ] },
  { id: 'bots', label: 'Bot 与数据', icon: 'toggles',
    description: 'Bot 的内置能力、技能、应用、提示词、自动化 Webhook 和分享。',
    tabs: [
      { id: 'harness', label: '内置能力', summary: 'harness', blocks: [{ view: 'harness' }] },
      { id: 'skills', label: '技能', summary: 'skills', blocks: [{ view: 'skills' }] },
      { id: 'apps', label: '应用', summary: 'apps', blocks: [{ view: 'apps' }] },
      { id: 'prompts', label: '提示词', layout: 'wide', blocks: [{ view: 'prompts' }] },
      { id: 'webhooks', label: 'Webhook', summary: 'webhooks', blocks: [{ view: 'webhooks', except: ['section:has(#hook-events)'] }] },
      { id: 'sharing', label: '分享', summary: 'sharing', blocks: [{ view: 'sharing' }] },
    ] },
  { id: 'account', label: '安全与账号', icon: 'shield',
    description: '管理员资料、登录状态，以及客户端修改模型配置的权限。',
    tabs: [{ id: 'admin', label: '安全与账号', blocks: [
      { view: 'general', only: ['#profile-form', 'section:has(#logout)'] },
      { view: 'model', only: ['#model-device-policy'] },
    ] }] },
  { id: 'system', label: '系统设置与日志', icon: 'settings',
    description: 'Host 运行信息、界面外观，以及模型路由、通知和 Webhook 的记录。',
    tabs: [
      { id: 'settings', label: '设置', blocks: [{ view: 'system' }, { view: 'general', only: ['section:has([data-theme-picker])'] }] },
      { id: 'logs', label: '日志', blocks: [
        { view: 'model', only: ['section:has(#routing-log)'] },
        { view: 'devices', only: ['section:has(#notification-list)'] },
        { view: 'webhooks', only: ['section:has(#hook-events)'] },
      ] },
    ] },
];

// Former ?view=<id> values (and their old aliases) -> the page/tab that holds that content now.
export const legacyViews = {
  overview: 'overview/home', general: 'account/admin', profile: 'account/admin',
  model: 'models/providers', speech: 'models/speech', media: 'models/media', 'web-services': 'models/web',
  harness: 'bots/harness', skills: 'bots/skills', apps: 'bots/apps', plugins: 'bots/apps', connectors: 'bots/apps',
  prompts: 'bots/prompts', webhooks: 'bots/webhooks', sharing: 'bots/sharing',
  devices: 'devices/list', notifications: 'devices/notify', network: 'devices/network', execution: 'devices/execution',
  federation: 'devices/federation', 'web-client': 'clients/web', updates: 'clients/updates',
};

// Former in-page anchors (#id) -> [route, element to scroll to once the page shows].
export const legacyAnchors = {
  usage: ['usage/report'], 'usage-view': ['usage/report'], 'usage-title': ['usage/report'],
  attention: ['overview/home', 'attention'], 'overview-groups': ['overview/home', 'overview-groups'], hero: ['overview/home'],
  'model-form': ['models/providers'], 'model-providers': ['models/providers'],
  'model-default-route': ['models/routing', 'model-default-route'], 'model-scenario-section': ['models/routing', 'model-scenario-section'],
  'model-scenario-routes': ['models/routing', 'model-scenario-section'], 'model-bot-routes': ['models/routing', 'model-bot-routes'],
  'model-adaptive-section': ['models/routing', 'model-adaptive-section'], 'model-device-policy': ['account/admin', 'model-device-policy'],
  'routing-log': ['system/logs', 'routing-log'], 'profile-form': ['account/admin', 'profile-form'],
  'pairing-panel': ['devices/list'], 'device-list': ['devices/list', 'device-list'], 'push-form': ['devices/notify', 'push-form'],
  'notification-list': ['system/logs', 'notification-list'], 'hook-events': ['system/logs', 'hook-events'],
  'updates-ios-section': ['clients/updates', 'updates-ios-section'], 'updates-releases': ['clients/updates', 'updates-releases'],
  'updates-key-spki': ['clients/signing'],
};

const byId = new Map(pages.map(page => [page.id, page]));

export function findPage(id) { return byId.get(id) ?? null; }

/** Normalizes 'page' or 'page/tab' to { page, tab } with existing ids, or null. */
export function lookup(path) {
  const [pageId, tabId] = String(path ?? '').replace(/^\/+|\/+$/g, '').split('/');
  const page = byId.get(pageId);
  if (!page) return null;
  const tab = page.tabs.find(item => item.id === tabId) ?? (tabId ? null : page.tabs[0]);
  return tab ? { page, tab } : null;
}

export const routeHash = (page, tab) => {
  const entry = typeof page === 'string' ? lookup(tab ? `${page}/${tab}` : page) : { page, tab: tab ?? page.tabs[0] };
  if (!entry) return '#/overview';
  return entry.page.tabs.length > 1 || entry.tab !== entry.page.tabs[0] ? `#/${entry.page.id}/${entry.tab.id}` : `#/${entry.page.id}`;
};

/**
 * Resolves the address bar to a route. `hash` is location.hash, `search` is location.search.
 * Returns { page, tab, hash, scrollTo, redirected }: `hash` is the canonical #/page/tab to show,
 * `redirected` is true when the URL used an old form (?view=, #anchor, alias or unknown page).
 */
export function resolve(hash = '', search = '') {
  const raw = decodeURIComponent(String(hash).replace(/^#/, ''));
  const view = new URLSearchParams(search).get('view');
  let path = null, scrollTo = null, redirected = false;
  if (raw.startsWith('/')) {
    const [pagePart, tabPart] = raw.slice(1).split('/');
    if (lookup(raw)) path = raw.slice(1);
    else if (legacyViews[pagePart]) { path = legacyViews[pagePart]; redirected = true; }
    else if (lookup(pagePart)) { path = pagePart; redirected = true; }
    else redirected = Boolean(raw.slice(1) || tabPart);
  } else if (raw) {
    redirected = true;
    if (legacyAnchors[raw]) [path, scrollTo = null] = legacyAnchors[raw];
    else if (legacyViews[raw]) path = legacyViews[raw];
    else if (lookup(raw)) path = raw;
  }
  // An explicit ?view= wins over an empty or unknown hash (that is how links were shared before).
  if (view && (!path || !raw.startsWith('/'))) {
    const fromView = legacyViews[view] ?? (lookup(view) ? view : null);
    if (fromView && !legacyAnchors[raw]) path = fromView;
    redirected = true;
  }
  const entry = lookup(path) ?? lookup('overview');
  return { page: entry.page, tab: entry.tab, hash: routeHash(entry.page, entry.tab), scrollTo, redirected };
}

/** The module ids a tab shows, in order. */
export const viewsOf = tab => [...new Set(tab.blocks.map(block => block.view))];

/** Every module a route may need, used by tests and by the lazy loader. */
export const allViews = () => [...new Set(pages.flatMap(page => page.tabs.flatMap(viewsOf)))];

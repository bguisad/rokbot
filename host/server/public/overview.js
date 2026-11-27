import { t, html, locale } from './i18n.js';
import { $, node, status } from './ui.js';
import { icon } from './icons.js';
import { pages, routeHash } from './admin-routes.js';
import { blink, createGaze } from './face.js';
import { createCrew } from './crew.js';
import { formatCount, formatExactCount, withRequestUnit } from './usage-format.js';

// Each summary reads its page's endpoint and returns [text, on] for the overview row.
const enabled = value => [value ? t('{0} 项已启用', value) : t('未配置'), value > 0];
const count = (value, template) => [value ? t(template, value) : t('无'), value > 0];
const summaries = {
  'web-client': [null, (_, state) => [state.webClient?.installed ? state.webClient.rendererVersion || t('已安装') : t('未安装'), Boolean(state.webClient?.installed)]],
  model: [null, (_, state) => [state.model.model || t('尚未配置'), state.model.configured]],
  routes: [null, (_, state) => {
    const fallbacks = state.model.defaultRoute?.fallbacks?.length ?? 0;
    return state.model.defaultRoute ? [fallbacks ? t('{0} 个备用模型', fallbacks) : t('无备用模型'), true] : [t('尚未配置'), false];
  }],
  speech: [['/admin/api/speech', '/admin/api/voice'], ([speech, voice]) =>
    [`${t('识别')} ${t(speech.enabled ? '已启用' : '已停用')}，${t('通话')} ${t(voice.enabled ? '已启用' : '已停用')}`, speech.enabled || voice.enabled]],
  media: [['/admin/api/media'], ([media]) => enabled(Object.values(media.defaults).filter(Boolean).length)],
  'web-services': [['/admin/api/web-services'], ([web]) => enabled(['search', 'fetch'].filter(kind => web.defaults[kind]).length)],
  harness: [['/admin/api/harness'], ([harness]) => {
    const on = Object.values(harness).filter(Boolean).length;
    return [t('{0}/{1} 已开启', on, Object.keys(harness).length), on > 0];
  }],
  skills: [['/admin/api/skills'], ([items]) => count(items.filter(item => item.enabled).length, '{0} 个')],
  apps: [['/admin/api/apps'], ([value]) => count(value.apps.length, '{0} 个')],
  devices: [null, (_, state) => count(state.devices.filter(device => !device.revokedAt).length, '{0} 台')],
  network: [['/admin/api/network'], ([network]) => [network.enabled
    ? t({ ready: '已就绪', connecting: '正在连接', reconnecting: '正在重新连接' }[network.state] ?? network.state) : t('未启用'), network.state === 'ready']],
  execution: [['/admin/api/execution'], ([computer]) => [computer.enabled ? computer.name : t('未启用'), computer.enabled]],
  federation: [['/admin/api/federation'], ([value]) => count(value.peers.filter(peer => peer.enabled).length, '{0} 个 Host')],
  webhooks: [['/admin/api/webhooks'], ([items]) => count(items.filter(item => item.enabled).length, '{0} 个')],
  sharing: [['/admin/api/sharing'], ([items]) => count(items.length, '{0} 个')],
};

// The headline is set as two lines of display type.
function headline(state, bots) {
  const running = bots.filter(bot => bot.isRunning).length;
  if (!state.model.configured) return [t('配置对话模型'), t('后启动 Host')];
  if (state.host.waitingForExecutionNode) return [t('配置执行节点'), t('后启动 Host')];
  if (!state.host.connected) return [t('等待 Host'), t('启动')];
  if (running) return [t('{0} 个 Bot', running), t('正在工作')];
  return bots.length ? [t('Host 就绪'), t('{0} 个 Bot 待命', bots.length)] : [t('Host 就绪'), ''];
}

export function createOverview({ api, status: current }) {
  const panel = $('[data-panel=overview]');
  panel.innerHTML = html(`<section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <h2 id="hero-title" class="hero-title"></h2>
        <p id="hero-status-error" class="hero-usage" role="status" hidden></p>
        <p id="hero-usage" class="hero-usage"></p>
      </div>
      <div id="hero-host" class="hero-host"></div>
      <div id="bot-crew" class="crew"></div>
    </section>
    <section id="attention" class="section" hidden><div class="section-head"><h2 class="section-title">待处理</h2></div><div id="attention-list" class="card"></div></section>
    <section id="overview-health" class="section" aria-labelledby="overview-health-title">
      <div class="section-head"><h2 id="overview-health-title" class="section-title">运行状态</h2><div class="section-actions"><a class="btn btn-sm btn-ghost" href="#/system/settings">系统信息</a></div></div>
      <div id="overview-stats" class="stat-grid"></div>
    </section>
    <div id="overview-groups" class="overview-grid"></div>`);
  const values = new Map(), crew = createCrew($('#bot-crew'), $('#hero-host'));
  // One card per page of the console (admin-routes.js); each row opens a tab of that page.
  for (const page of pages.filter(page => page.id !== 'overview')) {
    const section = node('section', 'section'), head = node('div', 'section-head'), card = node('div', 'card');
    const title = node('a', 'section-title section-link', t(page.label)); title.href = routeHash(page);
    head.append(title);
    const tabs = page.tabs.length > 1 ? page.tabs : [{ ...page.tabs[0], label: page.label }];
    for (const tab of tabs) {
      const row = node('a', 'row link'); row.href = routeHash(page, page.tabs.find(item => item.id === tab.id));
      const label = node('span', 'row-title', t(tab.label)), copyNode = node('span', 'row-copy');
      const control = node('span', 'row-control auto'), chevron = node('span', 'chevron'); chevron.innerHTML = icon('chevron');
      const key = tab.summary;
      if (key && summaries[key]) { const value = status('—'); values.set(key, value); control.append(value); }
      copyNode.append(label); control.append(chevron); row.append(copyNode, control); card.append(row);
    }
    if (page.tabs.length === 1) {
      card.firstChild.querySelector('.row-copy').append(node('span', 'row-hint', t(page.description)));
    }
    const glyph = node('span', 'section-icon'); glyph.innerHTML = icon(page.icon); head.prepend(glyph);
    section.append(head, card); $('#overview-groups').append(section);
  }
  blink(crew.faces);
  createGaze(crew.faces, { active: () => !panel.hidden });

  function show(view, [text, on]) {
    const value = values.get(view);
    if (!value) return;
    value.textContent = text; value.dataset.tone = on ? 'success' : '';
  }
  // Compact facts with a link to the page that has the details.
  const stats = new Map();
  function stat(key, label, value, hint = '', href = '', tone = '') {
    let cell = stats.get(key);
    if (!cell) {
      cell = node(href ? 'a' : 'div', 'stat'); if (href) cell.href = href;
      cell.append(node('span', 'stat-label'), node('span', 'stat-value'), node('span', 'stat-hint'));
      stats.set(key, cell); $('#overview-stats').append(cell);
      const order = ['host', 'bots', 'devices', 'usage'];
      $('#overview-stats').replaceChildren(...order.map(name => stats.get(name)).filter(Boolean));
    }
    const [labelNode, valueNode, hintNode] = cell.children;
    labelNode.textContent = label; valueNode.textContent = value; hintNode.textContent = hint;
    if (tone) valueNode.dataset.tone = tone; else delete valueNode.dataset.tone;
  }
  function renderStats(state) {
    const bots = state.host.agents.filter(agent => !agent.isGroup), running = bots.filter(bot => bot.isRunning).length;
    const [hostText, tone] = state.host.connected ? state.host.busy ? [t('任务运行中'), 'accent'] : [t('Host 就绪'), 'success']
      : state.host.waitingForExecutionNode ? [t('需要执行节点'), 'warn'] : state.model.configured ? [t('等待 Host'), 'warn'] : [t('等待配置'), 'warn'];
    const started = new Date(state.startedAt);
    stat('host', t('Host 状态'), hostText, Number.isNaN(started.getTime()) ? '' :
      t('启动于 {0}', started.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })), '#/system/settings', tone);
    stat('bots', t('Bot'), String(bots.length), running ? t('{0} 个正在工作', running) : t('全部待命'), '#/models/routing');
    const devices = state.devices.filter(device => !device.revokedAt);
    stat('devices', t('已配对设备'), String(devices.length),
      t('{0} 个在线客户端', state.notifications?.onlineSubscribers ?? 0), '#/devices/list');
  }
  function renderAttention(state) {
    const items = [];
    if (!state.model.configured) items.push(['还没有对话模型', '配置 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 接口后，Host 才会启动。', '配置模型', 'model']);
    if (state.host.waitingForExecutionNode) items.push(['需要执行节点', '分机部署需要连接独立的执行电脑，Bot 才能开始聊天。', '配置节点', 'execution']);
    if (!state.devices.some(device => !device.revokedAt)) items.push(['还没有配对设备', '用配对码连接电脑或手机客户端。', '配对设备', 'devices']);
    $('#attention').hidden = !items.length;
    $('#attention-list').replaceChildren(...items.map(([title, hint, action, view]) => {
      const row = node('div', 'row'), copyNode = node('span', 'row-copy'), button = node('button', 'btn btn-sm', t(action));
      copyNode.append(node('span', 'row-title', t(title)), node('span', 'row-hint', t(hint)));
      button.type = 'button'; button.dataset.view = view;
      row.append(copyNode, button);
      return row;
    }));
  }
  function render(state) {
    const bots = state.host.agents.filter(agent => !agent.isGroup);
    $('#hero-status-error').hidden = true;
    $('#hero-host').hidden = $('#bot-crew').hidden = $('#hero-usage').hidden = $('#overview-health').hidden = false;
    $('#hero-title').replaceChildren(...headline(state, bots).filter(Boolean).map(line => node('span', '', line)));
    crew.render(state, bots);
    renderAttention(state);
    renderStats(state);
    for (const [view, [paths, summarize]] of Object.entries(summaries)) if (!paths) show(view, summarize(null, state));
  }
  function statusUnavailable(title, detail = '') {
    $('#hero-title').textContent = title;
    $('#hero-status-error').textContent = detail;
    $('#hero-status-error').hidden = !detail;
    $('#hero-host').hidden = $('#bot-crew').hidden = $('#hero-usage').hidden = $('#attention').hidden = $('#overview-health').hidden = true;
    for (const [view, [paths]] of Object.entries(summaries)) if (!paths) show(view, ['—', false]);
  }
  // Short counts everywhere; the exact number on hover (title) and on a long press.
  function count(value, wrap = text => text) {
    const text = wrap(formatCount(value, locale)), exact = wrap(formatExactCount(value, locale));
    const element = node('span', 'usage-count', text);
    element.title = formatExactCount(value, locale); element.dataset.exact = element.title; element.tabIndex = 0;
    let timer = null;
    const flip = () => { element.textContent = element.textContent === exact ? text : exact; };
    element.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse') timer = setTimeout(() => { timer = null; flip(); }, 450);
    });
    for (const name of ['pointerup', 'pointerleave', 'pointercancel']) element.addEventListener(name, () => clearTimeout(timer));
    element.addEventListener('contextmenu', event => { if (event.pointerType !== 'mouse') event.preventDefault(); });
    element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); } });
    return element;
  }
  // Today's totals only; the full report lives on the usage page (usage.js).
  async function loadUsage() {
    const usage = await api(`/admin/api/usage?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    const hero = $('#hero-usage');
    if (usage.requests) {
      const [before, middle, after] = t('今天 {0} Token，{1} 次请求', '\u0000', '\u0001').split(/\u0000|\u0001/);
      hero.replaceChildren(before, count(usage.total), middle, count(usage.requests), after);
    } else hero.textContent = t('今天还没有模型请求');
    stat('usage', t('今日请求'), usage.requests ? formatCount(usage.requests, locale) : '0',
      usage.total ? t('{0} Token', formatCount(usage.total, locale)) : t('暂无 Token 用量'), '#/usage');
  }
  async function load() {
    const state = current(); if (state) render(state);
    await Promise.all([loadUsage().catch(() => { $('#hero-usage').textContent = ''; }),
      ...Object.entries(summaries).filter(([, [paths]]) => paths).map(async ([view, [paths, summarize]]) => {
        try { show(view, summarize(await Promise.all(paths.map(path => api(path))), state)); }
        catch { show(view, ['—', false]); }
      })]);
  }
  return { load, status: render, statusUnavailable };
}

import { t, html, locale } from './i18n.js';
import { $, node, status } from './ui.js';
import { icon } from './icons.js';
import { groups } from './navigation.js';
import { blink, createGaze } from './face.js';
import { createCrew } from './crew.js';
import { formatCount, formatExactCount, formatTokens, withRequestUnit } from './usage-format.js';

// Each summary reads its page's endpoint and returns [text, on] for the overview row.
const enabled = value => [value ? t('{0} 项已启用', value) : t('未配置'), value > 0];
const count = (value, template) => [value ? t(template, value) : t('无'), value > 0];
const summaries = {
  model: [null, (_, state) => [state.model.model || t('尚未配置'), state.model.configured]],
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
        <h1 id="hero-title" class="hero-title"></h1>
        <p id="hero-status-error" class="hero-usage" role="status" hidden></p>
        <p id="hero-usage" class="hero-usage"></p>
      </div>
      <div id="hero-host" class="hero-host"></div>
      <div id="bot-crew" class="crew"></div>
    </section>
    <section id="attention" class="section" hidden><div class="section-head"><h2 class="section-title">待处理</h2></div><div id="attention-list" class="card"></div></section>
    <section id="usage" class="section usage" aria-labelledby="usage-title" hidden>
      <div class="section-head"><h2 id="usage-title" class="section-title">按模型用量</h2>
        <div id="usage-periods" class="chips" role="radiogroup" aria-label="时间段"></div></div>
      <div id="usage-card" class="card"></div>
    </section>
    <div id="overview-groups" class="overview-grid"></div>`);
  const values = new Map(), crew = createCrew($('#bot-crew'), $('#hero-host'));
  for (const group of groups.filter(group => group.title)) {
    const section = node('section', 'section'), head = node('div', 'section-head'), card = node('div', 'card');
    head.append(node('h2', 'section-title', t(group.title)));
    for (const [view, label, glyph] of group.items.filter(([view]) => summaries[view])) {
      const row = node('button', 'row link'); row.type = 'button'; row.dataset.view = view;
      const title = node('span', 'row-title row-icon-title'); title.innerHTML = icon(glyph); title.append(t(label));
      const value = status('—'); values.set(view, value);
      const chevron = node('span', 'chevron'); chevron.innerHTML = icon('chevron');
      const control = node('span', 'row-control auto'), copyNode = node('span', 'row-copy');
      copyNode.append(title); control.append(value, chevron); row.append(copyNode, control); card.append(row);
    }
    section.append(head, card); $('#overview-groups').append(section);
  }
  blink(crew.faces);
  createGaze(crew.faces, { active: () => !panel.hidden });

  function show(view, [text, on]) {
    const value = values.get(view);
    value.textContent = text; value.dataset.tone = on ? 'success' : '';
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
    $('#hero-host').hidden = $('#bot-crew').hidden = $('#hero-usage').hidden = false;
    $('#hero-title').replaceChildren(...headline(state, bots).filter(Boolean).map(line => node('span', '', line)));
    crew.render(state, bots);
    renderAttention(state);
    for (const [view, [paths, summarize]] of Object.entries(summaries)) if (!paths) show(view, summarize(null, state));
  }
  function statusUnavailable(title, detail = '') {
    $('#hero-title').textContent = title;
    $('#hero-status-error').textContent = detail;
    $('#hero-status-error').hidden = !detail;
    $('#hero-host').hidden = $('#bot-crew').hidden = $('#hero-usage').hidden = $('#attention').hidden = true;
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
  const PERIODS = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' };
  let usageData = null, usagePeriod = 'today';
  function breakdown(item) {
    const parts = [[t('输入'), item.input], [t('输出'), item.output], [t('缓存命中'), item.cached]];
    if (item.cacheWrite) parts.push([t('缓存写入'), item.cacheWrite]);
    const hint = node('span', 'row-hint usage-breakdown');
    for (const [label, value] of parts) hint.append(node('span', '', `${label} `), count(value), node('span', 'usage-sep', ' · '));
    hint.append(count(item.requests, text => withRequestUnit(text, item.requests, locale)));
    return hint;
  }
  function renderUsage() {
    const periods = usageData?.periods ?? [];
    const period = periods.find(item => item.id === usagePeriod) ?? periods[0];
    $('#usage').hidden = !period;
    if (!period) return;
    $('#usage-periods').replaceChildren(...periods.map(item => {
      const label = node('label', 'chip'), input = node('input'), text = node('span', '', t(PERIODS[item.id] ?? item.id));
      input.type = 'radio'; input.name = 'usage-period'; input.value = item.id; input.checked = item.id === period.id;
      input.addEventListener('change', () => { usagePeriod = item.id; renderUsage(); });
      label.append(input, text); return label;
    }));
    const total = node('div', 'row usage-total'), copy = node('span', 'row-copy');
    const figure = node('span', 'usage-figure'); figure.append(count(period.total), node('span', 'usage-unit', usageUnit(period.total)));
    copy.append(figure, breakdown(period));
    total.append(copy);
    const rows = period.models.map(item => {
      const row = node('div', 'row usage-model'), copyNode = node('span', 'row-copy'), value = node('span', 'row-value usage-model-total');
      copyNode.append(node('span', 'row-title usage-model-name', item.model === 'unknown' ? t('未知模型') : item.model), breakdown(item));
      value.append(count(item.total), node('span', 'usage-unit', usageUnit(item.total)));
      row.append(copyNode, value); return row;
    });
    if (!rows.length) rows.push(node('div', 'row usage-empty', t('这段时间还没有模型请求')));
    $('#usage-card').replaceChildren(total, ...rows);
  }
  const usageUnit = value => formatTokens(value, locale).slice(formatCount(value, locale).length);
  async function loadUsage() {
    const usage = await api(`/admin/api/usage?timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    const hero = $('#hero-usage');
    if (usage.requests) {
      const [before, middle, after] = t('今天 {0} Token，{1} 次请求', '\u0000', '\u0001').split(/\u0000|\u0001/);
      hero.replaceChildren(before, count(usage.total), middle, count(usage.requests), after);
    } else hero.textContent = t('今天还没有模型请求');
    usageData = usage; renderUsage();
  }
  async function load() {
    const state = current(); if (state) render(state);
    await Promise.all([loadUsage().catch(() => { $('#hero-usage').textContent = ''; $('#usage').hidden = true; }),
      ...Object.entries(summaries).filter(([, [paths]]) => paths).map(async ([view, [paths, summarize]]) => {
        try { show(view, summarize(await Promise.all(paths.map(path => api(path))), state)); }
        catch { show(view, ['—', false]); }
      })]);
  }
  return { load, status: render, statusUnavailable };
}

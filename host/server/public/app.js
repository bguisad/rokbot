import { t, localize } from './i18n.js';
import { $, all, busy, copyText, node } from './ui.js';
import { icon } from './icons.js';
import { renderNavigation, markNavigation, renderPageHead, pageTitle } from './navigation.js';
import { modules, resolve, viewsOf } from './admin-routes.js';
import { setupPrivacy } from './privacy.js';
import { createLoginStage } from './login.js';

const sessionPaths = new Set(['/admin/api/session', '/admin/api/login', '/admin/api/setup']);
const expiredSession = () => new Error(t('会话已过期，请重新登录。'));
let initialized = false, state = null, route = null, poll = null, toastTimer;
let consoleSession = null, statusPending = null;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, 5000);
}

async function api(path, { method = 'GET', body, signal = consoleSession?.signal, binary = false } = {}) {
  const session = consoleSession;
  const publicPath = sessionPaths.has(path);
  if (!publicPath && !session) throw expiredSession();
  if (body === undefined && !['GET', 'HEAD'].includes(method)) body = {};
  let response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', signal,
      headers: { 'content-type': 'application/json', 'x-rokbot-csrf': '1' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(t('无法连接管理服务。'));
  }
  if (response.status === 401 && !publicPath) {
    const error = expiredSession();
    if (session === consoleSession) showAuth(error.message);
    throw error;
  }
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new Error(typeof value?.error === 'string' && value.error.trim() ? t(value.error) : t('请求失败 ({0})', response.status));
  }
  if (binary) return response.blob();
  if (response.status === 204) return {};
  try { return await response.json(); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(t('管理服务返回了无效响应 (HTTP {0})。', response.status));
  }
}

const act = (control, work) => busy(control, async () => {
  try { return await work(); } catch (error) { toast(error.message, true); }
});
async function copy(value) {
  try { await copyText(value); toast(t('已复制')); }
  catch { toast(t('浏览器未允许复制，请选择文字后复制'), true); }
}

const context = { api, toast, busy, act, copy, refresh: () => refresh(), navigate: target => navigate(target), status: () => state };
renderNavigation($('#nav'));
// Every module gets its own panel inside the page body; a route shows the panels its tab lists.
const views = {}, loading = {};
const panelFor = id => {
  let panel = $(`[data-panel="${id}"]`);
  if (!panel) {
    panel = node('section', 'module'); panel.dataset.panel = id; panel.hidden = true;
    $('#page-body').append(panel);
  }
  return panel;
};
async function createView(id) {
  if (views[id]) return views[id];
  const [file, factory] = modules[id];
  panelFor(id);
  return loading[id] ??= import(`./${file}`).then(module => {
    views[id] = module[factory](context);
    localize($(`[data-panel="${id}"]`));
    if (state) views[id].status?.(state, isActive(id));
    document.dispatchEvent(new Event('rokbot:pages-ready'));
    return views[id];
  });
}
for (const id of Object.keys(modules)) panelFor(id);
await Promise.all(Object.entries(modules).filter(([, [, , options]]) => !options?.lazy).map(([id]) => createView(id)));
setupPrivacy();
const loginStage = createLoginStage();
localize(document.body);
$('#nav-toggle').innerHTML = icon('menu');

function showAuth(message = '') {
  consoleSession?.abort(); consoleSession = null;
  statusPending?.abort(); statusPending = null;
  clearInterval(poll); poll = null; state = null;
  $('#console').hidden = true; $('#loading').hidden = true; $('#auth-screen').hidden = false;
  $('#auth-title').textContent = initialized ? t('登录 Host') : t('设置 Host');
  $('#setup-key-label').hidden = initialized;
  $('#setup-key').required = !initialized;
  $('#setup-key').placeholder = t('初始化密钥，见数据目录中的 setup-key 文件');
  $('#auth-password').autocomplete = initialized ? 'current-password' : 'new-password';
  $('#auth-password').placeholder = initialized ? t('管理员密码') : t('新的管理员密码，至少 12 个字符');
  $('#auth-submit').setAttribute('aria-label', initialized ? t('登录') : t('创建管理员'));
  $('#auth-password').value = '';
  for (const view of Object.values(views)) view.reset?.();
  for (const dialog of all('dialog[open]')) dialog.close();
  loginStage.show(message);
  if (message) $('#auth-password').focus();
}

async function showConsole() {
  const session = consoleSession = new AbortController();
  loginStage.hide();
  $('#auth-screen').hidden = true; $('#loading').hidden = true; $('#console').hidden = false;
  $('#auth-form').reset();
  const checking = t('正在检查');
  setHealth(checking, '');
  for (const view of Object.values(views)) view.statusUnavailable?.(checking);
  await refresh(true);
  if (session !== consoleSession) return;
  showRoute();
  clearInterval(poll);
  poll = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}

const isActive = id => Boolean(route && viewsOf(route.tab).includes(id));

// Shows or hides the parts of a module panel for one block of the current tab (see admin-routes.js).
function applyBlock(panel, block) {
  const parts = [...panel.children].flatMap(child => child.matches('form.sections, .sections') ? [child, ...child.children] : [child]);
  const keep = part => block.only.some(selector => part.matches(selector) || part.querySelector(selector));
  for (const part of parts) {
    let hide = false;
    if (part.matches('dialog') || part.querySelector(':scope > dialog')) hide = false;
    else if (part.matches('.page-header')) hide = block.actions === false || (block.only && !block.actions) || !part.querySelector('.page-actions');
    else if (block.only) hide = !part.matches('form.sections, .sections') && !keep(part);
    else if (block.except) hide = block.except.some(selector => part.matches(selector));
    part.toggleAttribute('data-route-hidden', hide);
  }
  // A section group with nothing left to show goes too (it would otherwise keep its spacing).
  for (const group of panel.querySelectorAll(':scope > form.sections, :scope > .sections')) {
    const children = [...group.children];
    group.toggleAttribute('data-route-hidden', children.length > 0 && children.every(child => child.hasAttribute('data-route-hidden')));
  }
}

function showRoute(scrollTo = null) {
  const next = resolve(location.hash, location.search);
  if (next.hash !== location.hash || new URLSearchParams(location.search).has('view')) {
    const params = new URLSearchParams(location.search); params.delete('view');
    const search = params.size ? `?${params}` : '';
    history.replaceState(history.state, '', `${location.pathname}${search}${next.hash}`);
  }
  const changed = route?.page !== next.page || route?.tab !== next.tab;
  route = next;
  if (!consoleSession) return;
  const { page, tab } = route;
  markNavigation($('#sidebar'), page);
  renderPageHead($('#page-head'), page, tab);
  const shown = viewsOf(tab);
  $('#page').className = `page ${tab.layout ?? page.layout ?? ''}`.trim();
  $('#page').dataset.route = `${page.id}/${tab.id}`;
  for (const panel of all('#page-body > [data-panel]')) {
    const index = shown.indexOf(panel.dataset.panel);
    panel.hidden = index < 0; panel.style.order = index < 0 ? '' : String(index);
  }
  for (const block of tab.blocks) applyBlock(panelFor(block.view), block);
  document.title = `${pageTitle(page, tab)} · RokBot Host`;
  closeMenu();
  if (changed) window.scrollTo(0, 0);
  for (const id of shown) {
    createView(id).then(view => {
      if (route !== next) return;
      for (const block of tab.blocks.filter(block => block.view === id)) applyBlock(panelFor(id), block);
      return view.load?.();
    }).catch(error => toast(error.message, true));
  }
  const target = scrollTo ?? next.scrollTo;
  if (target) requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: 'start' }));
}

// `target` is a page/tab path ('devices/notify'), a canonical hash, or a former view id ('model').
function navigate(target) {
  const next = resolve(String(target).startsWith('#') ? target : `#/${target}`);
  if (location.hash === next.hash) showRoute(next.scrollTo); else location.hash = next.hash;
}

function closeMenu() { $('#sidebar').classList.remove('open'); $('#nav-toggle').setAttribute('aria-expanded', 'false'); }

function hostTitle() {
  if (state.host.connected) return state.host.busy ? [t('任务运行中'), 'accent'] : [t('Host 就绪'), 'success'];
  if (state.model.configured && state.host.waitingForExecutionNode) return [t('需要执行节点'), 'warn'];
  return state.model.configured ? [t('等待 Host'), 'warn'] : [t('等待配置'), 'warn'];
}

function setHealth(title, tone) {
  $('#header-health').textContent = title;
  $('#header-health').dataset.tone = tone;
}

function statusUnavailable(detail) {
  state = null;
  const title = t('状态不可用');
  setHealth(title, 'warn');
  for (const view of Object.values(views)) view.statusUnavailable?.(title, detail);
}

async function refresh(showError = false) {
  if (!consoleSession || statusPending) return;
  // Only the current probe may update health, even if an old one finishes after re-login.
  const request = statusPending = new AbortController();
  const timeout = setTimeout(() => request.abort(new Error(t('读取 Host 状态超时。'))), 12_000);
  try {
    const next = await api('/admin/api/status', { signal: request.signal });
    if (request !== statusPending) return;
    state = next;
    setHealth(...hostTitle());
    for (const [id, view] of Object.entries(views)) view.status?.(state, isActive(id));
  } catch (error) {
    if (request !== statusPending) return;
    statusUnavailable(error.message);
    if (showError) toast(error.message, true);
  } finally {
    clearTimeout(timeout);
    if (statusPending === request) statusPending = null;
  }
}

addEventListener('offline', () => {
  if (!consoleSession) return;
  statusPending?.abort(); statusPending = null;
  statusUnavailable(t('无法连接管理服务。'));
});
addEventListener('online', () => { if (!document.hidden) refresh(); });

$('#auth-form').addEventListener('submit', event => {
  event.preventDefault();
  busy($('#auth-submit'), async () => {
    loginStage.thinking();
    try {
      await api(`/admin/api/${initialized ? 'login' : 'setup'}`, { method: 'POST',
        body: { setupKey: $('#setup-key').value, password: $('#auth-password').value } });
      initialized = true;
      await loginStage.success();
      await showConsole();
    } catch (error) {
      loginStage.error(error.message);
    }
  });
});
// Former in-page buttons still carry data-view="<old view id>"; they open the page that holds it now.
document.addEventListener('click', event => {
  const target = event.target.closest('[data-view]');
  if (!target || !$('#console').contains(target)) return;
  event.preventDefault();
  navigate(target.dataset.view);
});
addEventListener('hashchange', () => showRoute());
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('#sidebar').classList.contains('open')) closeMenu(); });
$('#nav-toggle').addEventListener('click', () => {
  const open = $('#sidebar').classList.toggle('open');
  $('#nav-toggle').setAttribute('aria-expanded', String(open));
});
document.addEventListener('rokbot:logout', () => showAuth());

try {
  const session = await api('/admin/api/session');
  initialized = session.initialized;
  const params = new URLSearchParams(location.search);
  showRoute();
  if (params.has('authorization')) {
    const success = params.get('authorization') === 'success';
    toast(success ? t('应用授权已完成') : t('应用授权未完成，请在应用详情查看状态'), !success);
    params.delete('authorization');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  }
  if (session.authenticated) await showConsole(); else showAuth();
} catch (error) {
  $('#loading').textContent = t('连接失败：{0}。刷新页面重试。', error.message);
}

// The usage dashboard: the Host's usage report (GET /local/usage/report, host/runtime/usage-report.mjs)
// as one interactive view for the admin overview and the desktop / web settings (Usage section).
// Plain DOM and SVG, no dependencies: mountUsageDashboard(root, { load, exportCsv }) owns `root`.
// Range switch (today / 7 / 30 days / all / custom dates), filters, summary cards compared with the
// previous range, the trend per hour or day (by model, by token type, requests), breakdowns per
// model / provider / profile / scene / bot with a ring chart and sortable tables, and the requests
// a page at a time with CSV export. Styles: usage-dashboard.css. The desktop gets this file as
// rok-usage-dashboard.js and the CSS as ROK_USAGE_DASHBOARD_CSS (windows/tools/desktop-recipes/spec.mjs).
import { formatCount, formatExactCount, usageLanguage } from './usage-format.js';
import { usageTicks } from './usage-charts.js';

export const NONE = '(none)';
export const USAGE_RANGE_IDS = Object.freeze(['today', '7d', '30d', 'all', 'custom']);
export const USAGE_DIMENSION_IDS = Object.freeze(['model', 'provider', 'profile', 'kind', 'agent']);
const SERIES = 7, PAGE = 20;

const TEXT = {
  zh: {
    title: '用量统计', ranges: { today: '今天', '7d': '7 天', '30d': '30 天', all: '全部', custom: '自定义' },
    rangeLabel: '时间范围', compare: '对比 {0}', noCompare: '全部记录，无对比', zone: '时区 {0}',
    refresh: '刷新', export: '导出 CSV', exporting: '正在导出…', exported: '已导出 {0} 条', exportFailed: '导出失败',
    filter: '筛选', clear: '清除筛选', filterBy: '按{0}筛选', remove: '移除筛选 {0}',
    dims: { model: '模型', provider: '服务商', profile: '配置', kind: '场景', agent: 'Bot', status: '状态' },
    cost: '总花费', costUnset: '未配置单价', costPartial: '{0} / {1} 次请求有单价', total: '总 Token', requests: '请求次数',
    latency: '平均耗时', failure: '失败率', hitRate: '缓存命中率', failedCount: '失败 {0} 次', cancelledCount: '取消 {0} 次',
    recordedOf: '{0} / {1} 次请求有记录', notRecorded: '未记录', vsPrevious: '上一周期 {0}', newSince: '上一周期为 0',
    exact: '精确值 {0}', tokenParts: 'Token 构成', uncached: '未命中输入', cached: '缓存命中', cacheWrite: '缓存写入',
    output: '输出', reasoning: '推理', outputPlain: '输出（不含推理）', input: '输入',
    trend: '趋势', perHour: '按小时', perDay: '按天', perMonth: '按月', byModel: '按模型', byType: '按类型', byRequests: '请求',
    other: '其他模型', unknownModel: '未记录模型', tipTotal: '合计', okRequests: '成功', failedRequests: '失败',
    breakdown: '用量拆分', share: '占比', avgLatency: '平均耗时', failRate: '失败率', name: '名称', sortBy: '按{0}排序',
    clickToFilter: '点一行即按它筛选', otherItems: '其他 {0} 项',
    list: '请求明细', time: '时间', scene: '场景', bot: 'Bot', model: '模型', tokens: 'Token', duration: '耗时', state: '状态',
    page: '第 {0}–{1} 条，共 {2} 条', prev: '上一页', next: '下一页', emptyList: '没有符合条件的请求',
    status: { ok: '成功', error: '失败', cancelled: '已取消' },
    empty: '这段时间还没有模型请求', emptyFiltered: '没有符合筛选条件的请求', loadFailed: '无法读取用量', retry: '重试',
    legacy: '旧版本 Host 不支持详细用量，升级 Host 后可查看', apply: '应用', cancel: '取消', pickStart: '选择开始日期', pickEnd: '选择结束日期',
    prevMonth: '上个月', nextMonth: '下个月', weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    ms: '{0} 毫秒', sec: '{0} 秒', min: '{0} 分 {1} 秒', tokensUnit: 'Token', requestsUnit: '{0} 次请求',
  },
  en: {
    title: 'Usage', ranges: { today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All', custom: 'Custom' },
    rangeLabel: 'Range', compare: 'vs {0}', noCompare: 'All records, no comparison', zone: 'Time zone {0}',
    refresh: 'Refresh', export: 'Export CSV', exporting: 'Exporting…', exported: 'Exported {0} rows', exportFailed: 'Export failed',
    filter: 'Filter', clear: 'Clear filters', filterBy: 'Filter by {0}', remove: 'Remove filter {0}',
    dims: { model: 'Model', provider: 'Provider', profile: 'Profile', kind: 'Scene', agent: 'Bot', status: 'Status' },
    cost: 'Total cost', costUnset: 'No prices set', costPartial: '{0} of {1} requests priced', total: 'Total tokens', requests: 'Requests',
    latency: 'Avg. latency', failure: 'Failure rate', hitRate: 'Cache hit rate', failedCount: '{0} failed', cancelledCount: '{0} cancelled',
    recordedOf: 'Recorded for {0} of {1} requests', notRecorded: 'Not recorded', vsPrevious: 'Previous {0}', newSince: 'Previous was 0',
    exact: 'Exact {0}', tokenParts: 'Token mix', uncached: 'Uncached input', cached: 'Cache read', cacheWrite: 'Cache write',
    output: 'Output', reasoning: 'Reasoning', outputPlain: 'Output (no reasoning)', input: 'Input',
    trend: 'Trend', perHour: 'Per hour', perDay: 'Per day', perMonth: 'Per month', byModel: 'By model', byType: 'By type', byRequests: 'Requests',
    other: 'Other models', unknownModel: 'Model not recorded', tipTotal: 'Total', okRequests: 'Succeeded', failedRequests: 'Failed',
    breakdown: 'Breakdown', share: 'Share', avgLatency: 'Avg. latency', failRate: 'Failure', name: 'Name', sortBy: 'Sort by {0}',
    clickToFilter: 'Click a row to filter by it', otherItems: '{0} more',
    list: 'Requests', time: 'Time', scene: 'Scene', bot: 'Bot', model: 'Model', tokens: 'Tokens', duration: 'Latency', state: 'Status',
    page: '{0}–{1} of {2}', prev: 'Previous', next: 'Next', emptyList: 'No matching requests',
    status: { ok: 'OK', error: 'Failed', cancelled: 'Cancelled' },
    empty: 'No model requests in this range', emptyFiltered: 'No requests match the filters', loadFailed: 'Could not load usage', retry: 'Retry',
    legacy: 'This Host is too old for detailed usage; update it to see more', apply: 'Apply', cancel: 'Cancel', pickStart: 'Pick a start date', pickEnd: 'Pick an end date',
    prevMonth: 'Previous month', nextMonth: 'Next month', weekdays: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
    ms: '{0} ms', sec: '{0} s', min: '{0}m {1}s', tokensUnit: 'tokens', requestsUnit: '{0} requests',
  },
};
const KINDS = {
  chat: ['对话', 'Chat'], suggestions: ['输入建议', 'Suggestions'], completion: ['输入补全', 'Completion'], autocomplete: ['输入补全', 'Completion'],
  title: ['标题', 'Titles'], test: ['测试', 'Tests'], summary: ['摘要', 'Summaries'], memory: ['记忆', 'Memory'], subagent: ['子任务', 'Subagents'],
  automation: ['自动化', 'Automations'], classifier: ['路由判断', 'Routing'], review: ['自动审查', 'Auto review'],
};
const fill = (template, ...values) => template.replace(/\{(\d)\}/g, (_, index) => values[index]);
const textFor = locale => TEXT[usageLanguage(locale)];
const numberLocale = locale => usageLanguage(locale) === 'zh' ? 'zh-CN' : 'en-US';

// ------------------------------------------------------------------------------ pure helpers

/** The scene name of a usage kind: "对话", "输入建议" …; unknown kinds as they are. */
export function kindLabel(kind, locale) {
  if (!kind || kind === NONE) return textFor(locale).notRecorded;
  const names = KINDS[kind];
  return names ? names[usageLanguage(locale) === 'zh' ? 0 : 1] : kind;
}

/** The display name of a breakdown row or filter option of `dimension`. */
export function dimensionLabel(dimension, item, locale) {
  if (!item || item.key === NONE) return textFor(locale).notRecorded;
  if (dimension === 'kind') return kindLabel(item.key, locale);
  if (dimension === 'status') return textFor(locale).status[item.key] ?? item.key;
  return item.label ?? item.key;
}

/** "850 毫秒", "4.2 秒", "12 秒", "1 分 05 秒"; null when not recorded. */
export function formatDuration(ms, locale) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const text = textFor(locale), number = (value, digits) => value.toLocaleString(numberLocale(locale), { maximumFractionDigits: digits });
  if (ms < 1000) return fill(text.ms, number(Math.round(ms), 0));
  if (ms < 60000) return fill(text.sec, number(ms < 10000 ? Math.round(ms / 100) / 10 : Math.round(ms / 1000), 1));
  const seconds = Math.round(ms / 1000);
  return fill(text.min, Math.floor(seconds / 60), String(seconds % 60).padStart(usageLanguage(locale) === 'zh' ? 2 : 1, '0'));
}

/** A ratio as a percentage: "3.4%", "62%", "<0.1%", "0%"; null stays null. */
export function formatPercent(ratio, locale) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  const value = ratio * 100;
  if (value === 0) return '0%';
  if (value > 0 && value < 0.1) return '<0.1%';
  return `${value.toLocaleString(numberLocale(locale), { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 })}%`;
}

/** The change against the previous range: { text: "+12.3%", direction: up | down | flat } or null. */
export function formatChange(ratio, locale) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
  if (Math.abs(ratio) < 0.0005) return { text: '0%', direction: 'flat' };
  const value = Math.abs(ratio * 100);
  const shown = value >= 1000 ? '999+' : value.toLocaleString(numberLocale(locale), { maximumFractionDigits: value < 10 ? 1 : 0 });
  return { text: `${ratio > 0 ? '+' : '−'}${shown}%`, direction: ratio > 0 ? 'up' : 'down' };
}

/** Whether a change is good, bad or neutral: more latency or failures is bad, less is good. */
export function changeTone(key, direction) {
  if (!direction || direction === 'flat') return 'neutral';
  if (key === 'avgDurationMs' || key === 'failureRate') return direction === 'up' ? 'bad' : 'good';
  return 'neutral';
}

/** A cost: "¥12.35" / "$0.0042" with the currency, or a plain number without one. */
export function formatCost(value, currency, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const digits = value !== 0 && Math.abs(value) < 1 ? 4 : 2;
  if (typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)) {
    try { return value.toLocaleString(numberLocale(locale), { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: digits }); }
    catch { /* An unknown currency code falls back to the plain number. */ }
  }
  return value.toLocaleString(numberLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

/** Breakdown rows sorted by `key` (a number field or "name"); rows without the value go last. */
export function sortUsageRows(rows, key = 'total', direction = 'desc', label = row => row.label ?? '') {
  const sign = direction === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (key === 'name') {
      if ((a.key === NONE) !== (b.key === NONE)) return a.key === NONE ? 1 : -1;
      return sign * String(label(a)).localeCompare(String(label(b)));
    }
    const x = a[key], y = b[key], missingX = typeof x !== 'number', missingY = typeof y !== 'number';
    if (missingX || missingY) return missingX === missingY ? 0 : missingX ? 1 : -1;
    return sign * (x - y) || b.total - a.total;
  });
}

/** The query string of a report request: range, custom dates, filters and the page. */
export function usageQuery({ timeZone, range = '7d', from, to, filters = {}, offset = 0, limit = PAGE, exportCsv = false } = {}) {
  const query = new URLSearchParams();
  if (timeZone) query.set('timeZone', timeZone);
  query.set('range', range);
  if (range === 'custom') { query.set('from', from); query.set('to', to); }
  for (const key of [...USAGE_DIMENSION_IDS, 'status']) if (filters[key]) query.set(key, filters[key]);
  if (exportCsv) query.set('export', 'csv');
  else { query.set('offset', String(offset)); query.set('limit', String(limit)); }
  return query.toString();
}

const dateParts = date => date.split('-').map(Number);
/** "11月21日" / "Nov 21", with the year when it is not `thisYear`. */
export function formatDay(date, locale, thisYear) {
  const [year, month, day] = dateParts(date), withYear = thisYear && year !== Number(thisYear);
  if (usageLanguage(locale) === 'zh') return `${withYear ? `${year}年` : ''}${month}月${day}日`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}
/** "11月21日 – 11月27日", or one day. */
export function formatSpan(from, to, locale, thisYear) {
  return from === to ? formatDay(from, locale, thisYear) : `${formatDay(from, locale, thisYear)} – ${formatDay(to, locale, thisYear)}`;
}

/** Axis and tooltip labels of a trend bucket: "13:00", "11/25", "2026/11". */
export function bucketLabel(start, unit, locale) {
  const zh = usageLanguage(locale) === 'zh';
  if (unit === 'hour') {
    const hour = Number(start.slice(11, 13));
    return { axis: `${hour}:00`, title: `${formatDay(start.slice(0, 10), locale)} ${hour}:00–${hour + 1}:00` };
  }
  if (unit === 'month') {
    const [year, month] = dateParts(start);
    return { axis: zh ? `${month}月` : new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1))),
      title: zh ? `${year}年${month}月` : new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1))) };
  }
  const [, month, day] = dateParts(start);
  return { axis: `${month}/${day}`, title: formatDay(start, locale) };
}

/** Uncached input, cache read, output without reasoning and reasoning; each with its share of all tokens. */
export function tokenParts(totals) {
  const input = totals?.input ?? 0, cached = Math.min(input, totals?.cached ?? 0), output = totals?.output ?? 0;
  const reasoning = Math.min(output, totals?.reasoning ?? 0), sum = input + output;
  return [
    { key: 'uncached', value: input - cached }, { key: 'cached', value: cached },
    { key: 'output', value: output - reasoning }, { key: 'reasoning', value: reasoning },
  ].map(part => ({ ...part, share: sum ? part.value / sum : 0 }));
}

/** The weeks of a month for the date picker, Monday first: rows of 7 "YYYY-MM-DD" or null. */
export function calendarWeeks(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1)), days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7, cells = [];
  for (let index = 0; index < lead; index++) cells.push(null);
  for (let day = 1; day <= days; day++) cells.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/** Series per model from the report: 1 … 7 for `series`, 0 (other models) for the rest. */
export function seriesOf(report) {
  const map = new Map((report?.series ?? []).slice(0, SERIES).map((model, index) => [model, index + 1]));
  return model => map.get(model) ?? 0;
}

// ------------------------------------------------------------------------------------- DOM

const SVG = 'http://www.w3.org/2000/svg';
function el(document, tag, attrs = {}, ...children) {
  const svg = attrs?.svg ?? ['svg', 'g', 'path', 'rect', 'line', 'text', 'circle', 'clipPath', 'defs', 'linearGradient', 'stop', 'polyline'].includes(tag);
  const element = svg ? document.createElementNS(SVG, tag) : document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (name === 'svg' || value === undefined || value === null || value === false) continue;
    if (name === 'class') element.setAttribute('class', value);
    else if (name === 'style' && typeof value === 'object') for (const [property, rule] of Object.entries(value)) element.style.setProperty(property, rule);
    else if (name.startsWith('on') && typeof value === 'function') element.addEventListener(name.slice(2), value);
    else if (name === 'text') element.textContent = value;
    else element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return element;
}

const ICONS = {
  refresh: 'M13.6 8a5.6 5.6 0 1 1-1.64-3.96M13.6 2.4v3.2h-3.2',
  download: 'M8 2.5v8m0 0L4.8 7.3M8 10.5l3.2-3.2M3 13.5h10',
  filter: 'M2.5 3.5h11L9.2 8.6v4.2l-2.4-1.2V8.6z',
  close: 'M4.5 4.5l7 7m0-7l-7 7',
  chevronLeft: 'M10 3.5L5.5 8l4.5 4.5', chevronRight: 'M6 3.5L10.5 8 6 12.5', chevronDown: 'M4 6l4 4 4-4',
  calendar: 'M3 4.5h10v8.5H3zM3 7h10M5.5 3v3M10.5 3v3',
  check: 'M3.5 8.5l3 3 6-7',
};
const icon = (document, name) => el(document, 'svg', { class: 'rud-icon', viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', fill: 'none' },
  el(document, 'path', { d: ICONS[name], stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

/** A short count: the exact number on hover (title) and on click, Enter or a long press. */
function countNode(document, value, locale, className = 'rud-count', { interactive = true } = {}) {
  const short = formatCount(value, locale), exact = formatExactCount(value, locale);
  const node = el(document, 'span', { class: className, title: exact, 'data-exact': exact }, short);
  // Inside a clickable row a count only shows the exact number on hover.
  if (short === exact || !interactive) return node;
  node.tabIndex = 0; node.setAttribute('role', 'button');
  const flip = () => { node.textContent = node.textContent === exact ? short : exact; };
  let timer = null;
  node.addEventListener('click', event => { event.stopPropagation(); flip(); });
  node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); flip(); } });
  node.addEventListener('pointerdown', event => { if (event.pointerType !== 'mouse') timer = setTimeout(() => { timer = null; flip(); }, 450); });
  for (const name of ['pointerup', 'pointerleave', 'pointercancel']) node.addEventListener(name, () => clearTimeout(timer));
  return node;
}

// A popover menu in the page's own style (not a native select): `items` are { label, hint,
// selected, onSelect } or { heading }. Anchored below (or above) `anchor`; Escape, Tab, a click
// outside, scrolling or resizing close it. Arrow keys move, Enter chooses.
function openMenu(document, anchor, items, { label, className = '' } = {}) {
  const window = document.defaultView;
  const menu = el(document, 'div', { class: `rud-menu ${className}`, role: 'menu', 'aria-label': label, tabindex: -1 });
  const entries = [];
  for (const item of items) {
    if (item.heading) { menu.append(el(document, 'div', { class: 'rud-menu-heading', role: 'presentation' }, item.heading)); continue; }
    const entry = el(document, 'button', { type: 'button', class: 'rud-menu-item', role: 'menuitemradio', 'aria-checked': item.selected ? 'true' : 'false' },
      el(document, 'span', { class: 'rud-menu-check', 'aria-hidden': 'true' }, item.selected ? icon(document, 'check') : null),
      el(document, 'span', { class: 'rud-menu-label', title: item.label }, item.label),
      item.hint !== undefined ? el(document, 'span', { class: 'rud-menu-hint' }, item.hint) : null);
    entry.addEventListener('click', () => { close(); item.onSelect?.(); });
    entries.push(entry); menu.append(entry);
  }
  const close = () => {
    if (!menu.isConnected) return;
    menu.remove(); anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', close); window.removeEventListener('scroll', onScroll, true);
  };
  const outside = event => { if (!menu.contains(event.target) && !anchor.contains(event.target)) close(); };
  const onScroll = event => { if (!menu.contains(event.target)) close(); };
  menu.addEventListener('keydown', event => {
    const at = entries.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      entries[(at + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus();
    } else if (event.key === 'Home') { event.preventDefault(); entries[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); entries.at(-1)?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); anchor.focus(); }
    else if (event.key === 'Tab') close();
  });
  document.body.append(menu);
  anchor.setAttribute('aria-expanded', 'true');
  place(window, anchor, menu);
  document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', close); window.addEventListener('scroll', onScroll, true);
  (entries.find(entry => entry.getAttribute('aria-checked') === 'true') ?? entries[0])?.focus({ preventScroll: true });
  return close;
}
// Below the anchor, or above it when there is more room there; kept inside the window.
function place(window, anchor, panel) {
  const box = anchor.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight;
  const below = window.innerHeight - box.bottom - 8, above = box.top - 8, up = below < Math.min(height, 240) && above > below;
  panel.style.maxHeight = `${Math.max(160, Math.min(420, up ? above : below) - 4)}px`;
  panel.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`;
  panel.style.top = up ? `${Math.max(8, box.top - 6 - Math.min(height, Number.parseFloat(panel.style.maxHeight)))}px` : `${box.bottom + 6}px`;
}

// The custom range picker: one month, a click picks the start and a second click the end
// (either order), days after `today` are disabled. Calls onApply(from, to).
function openRangePicker(document, anchor, { from, to, today, locale, onApply }) {
  const window = document.defaultView, text = textFor(locale), zh = usageLanguage(locale) === 'zh';
  let start = from ?? null, end = to ?? null, hover = null;
  let [year, month] = dateParts(end ?? today);
  const panel = el(document, 'div', { class: 'rud-menu rud-picker', role: 'dialog', 'aria-label': text.ranges.custom, tabindex: -1 });
  const title = el(document, 'div', { class: 'rud-picker-title', 'aria-live': 'polite' });
  const grid = el(document, 'div', { class: 'rud-picker-grid', role: 'grid' });
  const status = el(document, 'div', { class: 'rud-picker-status' });
  const apply = el(document, 'button', { type: 'button', class: 'rud-button rud-button-primary' }, text.apply);
  const shift = delta => { month += delta; if (month < 1) { month = 12; year--; } if (month > 12) { month = 1; year++; } draw(); };
  const next = el(document, 'button', { type: 'button', class: 'rud-icon-button', 'aria-label': text.nextMonth, onclick: () => shift(1) }, icon(document, 'chevronRight'));
  panel.append(
    el(document, 'div', { class: 'rud-picker-head' },
      el(document, 'button', { type: 'button', class: 'rud-icon-button', 'aria-label': text.prevMonth, onclick: () => shift(-1) }, icon(document, 'chevronLeft')),
      title, next),
    el(document, 'div', { class: 'rud-picker-weekdays', 'aria-hidden': 'true' }, text.weekdays.map(day => el(document, 'span', {}, day))),
    grid, status,
    el(document, 'div', { class: 'rud-picker-actions' },
      el(document, 'button', { type: 'button', class: 'rud-button', onclick: () => close() }, text.cancel), apply));
  // draw() builds the month; paint() only marks the range, so hovering never replaces a button.
  function draw() {
    title.textContent = zh ? `${year}年${month}月` : new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
    next.disabled = `${year}-${String(month).padStart(2, '0')}` >= today.slice(0, 7);
    grid.replaceChildren(...calendarWeeks(year, month).map(week => el(document, 'div', { class: 'rud-picker-week', role: 'row' }, week.map(day => {
      if (!day) return el(document, 'span', { class: 'rud-picker-day rud-picker-blank', role: 'gridcell' });
      return el(document, 'button', { type: 'button', role: 'gridcell', class: `rud-picker-day${day === today ? ' rud-today' : ''}`,
        disabled: day > today, 'aria-label': formatDay(day, locale, '0'), 'data-day': day,
        onclick: () => { if (!start || end) { start = day; end = null; } else { end = day; if (end < start) [start, end] = [end, start]; } hover = null; paint(); },
        onpointerenter: () => { if (start && !end) { hover = day; paint(); } } }, String(Number(day.slice(8))));
    }))));
    paint();
  }
  function paint() {
    const other = end ?? hover, low = start && other ? (start < other ? start : other) : start, high = start && other ? (start < other ? other : start) : start;
    for (const button of grid.querySelectorAll('button[data-day]')) {
      const day = button.dataset.day, inRange = Boolean(low && high && day >= low && day <= high);
      button.classList.toggle('rud-in-range', inRange);
      button.classList.toggle('rud-edge', day === low || day === high);
      button.setAttribute('aria-selected', inRange ? 'true' : 'false');
    }
    status.textContent = !start ? text.pickStart : !end ? `${formatDay(start, locale)} – ${text.pickEnd}` : formatSpan(start, end, locale);
    apply.disabled = !start || !end;
  }
  apply.addEventListener('click', () => { if (start && end) { close(); onApply(start, end); } });
  const close = () => {
    if (!panel.isConnected) return;
    panel.remove(); anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', close);
  };
  const outside = event => { if (!panel.contains(event.target) && !anchor.contains(event.target)) close(); };
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); anchor.focus(); } });
  draw();
  document.body.append(panel);
  anchor.setAttribute('aria-expanded', 'true');
  place(window, anchor, panel);
  document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', close);
  panel.focus({ preventScroll: true });
  return close;
}

// ------------------------------------------------------------------------------- charts

const round = value => Math.round(value * 100) / 100;
const textWidth = value => [...value].reduce((width, char) => width + (/[　-鿿]/.test(char) ? 11 : 6.4), 0);
function columnPath(x, top, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height)), bottom = top + height;
  if (!r) return `M${round(x)} ${round(bottom)}V${round(top)}H${round(x + width)}V${round(bottom)}Z`;
  return `M${round(x)} ${round(bottom)}V${round(top + r)}Q${round(x)} ${round(top)} ${round(x + r)} ${round(top)}H${round(x + width - r)}Q${round(x + width)} ${round(top)} ${round(x + width)} ${round(top + r)}V${round(bottom)}Z`;
}

/**
 * The trend chart of `report` in `mode` (model | type | requests) at `width` px: an SVG element
 * and tips per bucket ({ title, rows: [{ series | tone, name, value }], total }).
 */
function trendChart(document, report, mode, width, locale) {
  const text = textFor(locale), buckets = report.buckets ?? [], unit = report.range?.unit ?? 'day', series = seriesOf(report);
  const layers = bucket => {
    if (mode === 'requests') return [{ key: 'ok', cls: 'rud-fill-ok', value: bucket.requests - bucket.failed, name: text.okRequests },
      { key: 'failed', cls: 'rud-fill-failed', value: bucket.failed, name: text.failedRequests }];
    if (mode === 'type') {
      const parts = tokenParts(bucket);
      return [{ key: 'cached', cls: 'rud-fill-cached', value: parts[1].value, name: text.cached },
        { key: 'uncached', cls: 'rud-fill-uncached', value: parts[0].value, name: text.uncached },
        { key: 'output', cls: 'rud-fill-output', value: parts[2].value + parts[3].value, name: text.output }];
    }
    const stacks = new Map();
    for (const item of bucket.models ?? []) stacks.set(series(item.model), (stacks.get(series(item.model)) ?? 0) + item.total);
    return [...stacks].sort((a, b) => (a[0] || 99) - (b[0] || 99)).map(([index, value]) => ({ key: `s${index}`, cls: `rud-s${index}`, value,
      name: index ? (report.series[index - 1] === NONE ? text.unknownModel : report.series[index - 1]) : text.other }));
  };
  const stacked = buckets.map(bucket => ({ bucket, layers: layers(bucket) }));
  const max = Math.max(0, ...stacked.map(item => item.layers.reduce((sum, layer) => sum + layer.value, 0)));
  const ticks = usageTicks(max), top = ticks.at(-1) || 1, plotTop = 10, plotHeight = width < 420 ? 150 : 190, axis = 26;
  const labels = ticks.map(value => formatCount(value, locale));
  const left = Math.ceil(Math.max(...labels.map(textWidth))) + 12, right = 6, height = plotTop + plotHeight + axis;
  const plotWidth = Math.max(40, width - left - right), step = plotWidth / Math.max(1, buckets.length);
  const y = value => plotTop + plotHeight - value / top * plotHeight;
  const svg = el(document, 'svg', { class: `rud-chart-svg rud-mode-${mode}`, width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: 0,
    'aria-label': `${mode === 'requests' ? text.byRequests : text.tokensUnit} · ${formatSpan(report.range.from, report.range.to, locale)}` });
  ticks.forEach((value, index) => {
    const at = Math.round(y(value)) + 0.5;
    svg.append(el(document, 'line', { class: index ? 'rud-grid' : 'rud-axis', x1: left, x2: width - right, y1: at, y2: at }),
      el(document, 'text', { class: 'rud-tick rud-tick-y', x: left - 8, y: at + 4 }, labels[index]));
  });
  const every = unit === 'hour' ? [1, 2, 3, 4, 6, 12].find(value => value * step >= 38) ?? 12 : Math.max(1, Math.ceil(46 / step));
  buckets.forEach((bucket, index) => {
    const show = unit === 'hour' ? index % every === 0 : (buckets.length - 1 - index) % every === 0;
    if (show) svg.append(el(document, 'text', { class: 'rud-tick rud-tick-x', x: round(left + step * (index + 0.5)), y: plotTop + plotHeight + 18 }, bucketLabel(bucket.start, unit, locale).axis));
  });
  const marks = el(document, 'g', { class: 'rud-marks' });
  if (mode === 'type' && buckets.length > 1) {
    // Stacked areas through the bucket centres, each layer on top of the ones before it.
    const keys = ['cached', 'uncached', 'output'], base = new Array(buckets.length).fill(0);
    const centre = index => round(left + step * (index + 0.5));
    for (const key of keys) {
      const lows = base.slice(), highs = stacked.map((item, index) => (base[index] += item.layers.find(layer => layer.key === key).value));
      const upper = highs.map((value, index) => `${centre(index)} ${round(y(value))}`), lower = lows.map((value, index) => `${centre(index)} ${round(y(value))}`).reverse();
      const cls = stacked[0].layers.find(layer => layer.key === key).cls;
      marks.append(el(document, 'path', { class: `rud-area ${cls}`, d: `M${upper.join('L')}L${lower.join('L')}Z` }),
        el(document, 'path', { class: `rud-area-line ${cls}`, d: `M${upper.join('L')}` }));
    }
  } else {
    const barWidth = Math.max(2, Math.min(28, step * 0.64));
    stacked.forEach((item, index) => {
      const x = left + step * (index + 0.5) - barWidth / 2;
      let sum = 0;
      const parts = item.layers.map((layer, at) => {
        const low = y(sum) - (at && sum ? 1.5 : 0); sum += layer.value;
        return { ...layer, low, high: y(sum) };
      }).filter(part => part.value > 0 && part.low - part.high >= 0.75);
      const column = el(document, 'g', { class: 'rud-column', style: { '--rud-i': String(index) } });
      parts.forEach((part, at) => column.append(el(document, 'path', { class: `rud-bar ${part.cls}`,
        d: columnPath(x, part.high, barWidth, part.low - part.high, at === parts.length - 1 ? Math.min(4, barWidth / 3) : 0) })));
      marks.append(column);
    });
  }
  svg.append(marks);
  // Hit areas and the hover guide.
  const guide = el(document, 'line', { class: 'rud-guide', x1: 0, x2: 0, y1: plotTop, y2: plotTop + plotHeight, visibility: 'hidden' });
  svg.append(guide);
  const tips = stacked.map((item, index) => {
    const label = bucketLabel(item.bucket.start, unit, locale);
    const rows = item.layers.filter(layer => layer.value > 0).slice().reverse();
    return { title: label.title, center: left + step * (index + 0.5), total: item.layers.reduce((sum, layer) => sum + layer.value, 0),
      requests: item.bucket.requests, rows, mode };
  });
  buckets.forEach((_, index) => svg.append(el(document, 'rect', { class: 'rud-hit', 'data-index': index, x: round(left + step * index), y: 0, width: round(step), height: plotTop + plotHeight })));
  return { svg, tips, guide };
}

// The ring chart: the largest `limit` rows and the rest as one part.
function ringChart(document, rows, total, { size = 148, limit = 6, colorOf, centerValue, centerLabel }) {
  const stroke = 16, radius = (size - stroke) / 2, length = 2 * Math.PI * radius;
  const svg = el(document, 'svg', { class: 'rud-ring', width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' });
  svg.append(el(document, 'circle', { class: 'rud-ring-track', cx: size / 2, cy: size / 2, r: radius, 'stroke-width': stroke }));
  const shown = rows.filter(row => row.total > 0).slice(0, limit), rest = rows.filter(row => row.total > 0).slice(limit).reduce((sum, row) => sum + row.total, 0);
  const parts = [...shown.map((row, index) => ({ key: row.key, value: row.total, cls: colorOf(row, index) })), ...(rest ? [{ key: '', value: rest, cls: 'rud-s0' }] : [])];
  let offset = 0;
  const gap = parts.length > 1 ? 2 : 0;
  parts.forEach((part, index) => {
    const span = total ? part.value / total * length : 0;
    if (span <= 0) return;
    const visible = Math.max(0.5, span - gap);
    svg.append(el(document, 'circle', { class: `rud-ring-part ${part.cls}`, cx: size / 2, cy: size / 2, r: radius, 'stroke-width': stroke, 'data-key': part.key,
      'stroke-dasharray': `${round(visible)} ${round(length - visible)}`, 'stroke-dashoffset': round(-offset), transform: `rotate(-90 ${size / 2} ${size / 2})`,
      style: { '--rud-i': String(index), '--rud-len': `${round(visible)}` } }));
    offset += span;
  });
  return el(document, 'div', { class: 'rud-ring-wrap', style: { width: `${size}px`, height: `${size}px` } }, svg,
    el(document, 'div', { class: 'rud-ring-center' }, centerValue, el(document, 'span', {}, centerLabel)));
}

// ------------------------------------------------------------------------------ dashboard

/**
 * Mount the dashboard in `root`. `load(query)` returns the report for { range, from, to, filters,
 * offset, limit } and may reject with { status: 404 } for an older Host (then `onUnsupported` is
 * called). `exportCsv(query)` returns { filename, csv } or is missing (no export button).
 * Returns { refresh, destroy }.
 */
export function mountUsageDashboard(root, { load, exportCsv, locale, range = '7d', onUnsupported, now = () => new Date() } = {}) {
  const document = root.ownerDocument, window = document.defaultView, text = textFor(locale);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const state = { range, from: null, to: null, filters: {}, offset: 0, trend: 'model', dimension: 'model', sort: { key: 'total', direction: 'desc' },
    report: null, loading: false, error: null, generation: 0, width: 0, exporting: false, notice: null };
  let closeMenu = null, tipNode = null, destroyed = false;
  const view = el(document, 'div', { class: 'rok-usage-view rud', 'data-state': 'loading' });
  root.replaceChildren(view);

  const query = (extra = {}) => ({ timeZone, range: state.range, from: state.from, to: state.to, filters: { ...state.filters }, offset: state.offset, limit: PAGE, ...extra });
  async function fetchReport({ page = false } = {}) {
    const generation = ++state.generation;
    state.loading = true; state.error = null;
    if (!page) view.dataset.state = state.report ? 'refreshing' : 'loading';
    renderBusy(page);
    try {
      const report = await load(query());
      if (destroyed || generation !== state.generation) return;
      if (!report || report.version !== 2) throw Object.assign(new Error('unsupported'), { status: 404 });
      state.report = report; state.loading = false;
      if (report.range?.id === 'custom') { state.from = report.range.from; state.to = report.range.to; }
      render(page ? 'page' : 'all');
    } catch (error) {
      if (destroyed || generation !== state.generation) return;
      state.loading = false;
      if (error?.status === 404 && onUnsupported) { onUnsupported(); return; }
      state.error = error?.message || String(error);
      render('all');
    }
  }
  function renderBusy(page) {
    if (!state.report) { renderSkeleton(); return; }
    view.querySelector(page ? '.rud-list' : '.rud-body')?.setAttribute('aria-busy', 'true');
  }

  // ---- toolbar
  function toolbar() {
    const segmented = el(document, 'div', { class: 'rud-segmented', role: 'radiogroup', 'aria-label': text.rangeLabel });
    for (const id of USAGE_RANGE_IDS) {
      const selected = state.range === id;
      const button = el(document, 'button', { type: 'button', role: 'radio', class: 'rud-segment', 'aria-checked': selected ? 'true' : 'false', 'data-range': id,
        ...(id === 'custom' ? { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } : {}) },
      id === 'custom' ? icon(document, 'calendar') : null, el(document, 'span', {}, id === 'custom' && state.range === 'custom' && state.from
        ? formatSpan(state.from, state.to, locale, (state.report?.today ?? '').slice(0, 4)) : text.ranges[id]));
      button.addEventListener('click', () => {
        if (id === 'custom') {
          closeMenu?.();
          const today = state.report?.today ?? isoToday();
          closeMenu = openRangePicker(document, button, { from: state.from, to: state.to, today, locale,
            onApply: (from, to) => { state.range = 'custom'; state.from = from; state.to = to; state.offset = 0; void fetchReport(); } });
          return;
        }
        if (state.range === id) return;
        state.range = id; state.offset = 0; void fetchReport();
      });
      segmented.append(button);
    }
    segmented.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const buttons = [...segmented.querySelectorAll('button')], at = buttons.indexOf(document.activeElement);
      if (at < 0) return;
      event.preventDefault(); buttons[(at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus();
    });
    const filter = el(document, 'button', { type: 'button', class: 'rud-button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon(document, 'filter'), el(document, 'span', {}, text.filter));
    filter.addEventListener('click', () => openFilterMenu(filter));
    const actions = [filter];
    if (exportCsv) {
      const button = el(document, 'button', { type: 'button', class: 'rud-button', disabled: state.exporting || !state.report?.requests?.total },
        icon(document, 'download'), el(document, 'span', {}, state.exporting ? text.exporting : text.export));
      button.addEventListener('click', () => void exportRows());
      actions.push(button);
    }
    const refresh = el(document, 'button', { type: 'button', class: 'rud-icon-button', 'aria-label': text.refresh, title: text.refresh }, icon(document, 'refresh'));
    refresh.addEventListener('click', () => void fetchReport());
    actions.push(refresh);
    return el(document, 'div', { class: 'rud-toolbar' }, segmented, el(document, 'div', { class: 'rud-actions' }, actions));
  }
  const isoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());

  function openFilterMenu(anchor) {
    closeMenu?.();
    const options = state.report?.options ?? {};
    const order = ['agent', 'kind', 'model', 'provider', 'profile', 'status'];
    const items = [];
    for (const dimension of order) {
      const values = options[dimension] ?? [];
      if (!values.length) continue;
      items.push({ heading: text.dims[dimension] });
      for (const option of values.slice(0, 40)) items.push({ label: dimensionLabel(dimension, option, locale), hint: formatCount(option.requests, locale),
        selected: state.filters[dimension] === option.key, onSelect: () => setFilter(dimension, state.filters[dimension] === option.key ? null : option.key) });
    }
    if (!items.length) items.push({ heading: text.emptyList });
    closeMenu = openMenu(document, anchor, items, { label: text.filter, className: 'rud-filter-menu' });
  }
  function setFilter(dimension, key) {
    if (key) state.filters[dimension] = key; else delete state.filters[dimension];
    state.offset = 0; void fetchReport();
  }
  function filterChips() {
    const entries = Object.entries(state.filters);
    if (!entries.length) return null;
    const option = (dimension, key) => (state.report?.options?.[dimension] ?? []).find(item => item.key === key) ?? { key, label: key };
    return el(document, 'div', { class: 'rud-chips' }, entries.map(([dimension, key]) => {
      const name = `${text.dims[dimension]}：${dimensionLabel(dimension, option(dimension, key), locale)}`;
      return el(document, 'span', { class: 'rud-chip' }, el(document, 'span', { class: 'rud-chip-label', title: name }, name),
        el(document, 'button', { type: 'button', class: 'rud-chip-remove', 'aria-label': fill(text.remove, name), onclick: () => setFilter(dimension, null) }, icon(document, 'close')));
    }), entries.length > 1 ? el(document, 'button', { type: 'button', class: 'rud-link', onclick: () => { state.filters = {}; state.offset = 0; void fetchReport(); } }, text.clear) : null);
  }

  // ---- summary cards
  function change(key) {
    const report = state.report, ratio = report.changes?.[key];
    const value = formatChange(ratio, locale);
    if (!value) return null;
    const before = report.previousTotals?.[key];
    const previous = key === 'avgDurationMs' ? formatDuration(before, locale) : key === 'failureRate' ? formatPercent(before, locale)
      : key === 'cost' ? formatCost(before, report.currency, locale) : formatExactCount(before, locale);
    return el(document, 'span', { class: `rud-change rud-${changeTone(key, value.direction)} rud-${value.direction}`, title: fill(text.vsPrevious, previous ?? '—') },
      value.direction === 'flat' ? null : el(document, 'svg', { class: 'rud-change-arrow', viewBox: '0 0 10 10', width: 10, height: 10, 'aria-hidden': 'true' },
        el(document, 'path', { d: value.direction === 'up' ? 'M5 1.5L9 7H1z' : 'M5 8.5L1 3h8z', fill: 'currentColor' })), value.text);
  }
  function card(key, label, value, { sub, changeKey = key, muted = false, wide = false } = {}) {
    return el(document, 'div', { class: `rud-card${muted ? ' rud-muted' : ''}${wide ? ' rud-wide' : ''}`, 'data-card': key },
      el(document, 'div', { class: 'rud-card-label' }, label),
      el(document, 'div', { class: 'rud-card-value' }, value),
      el(document, 'div', { class: 'rud-card-foot' }, changeKey ? change(changeKey) : null, sub ? el(document, 'span', { class: 'rud-card-sub' }, sub) : null));
  }
  function cards() {
    const report = state.report, totals = report.totals, recorded = report.recorded ?? {};
    const partial = (count, all) => count && count < all ? fill(text.recordedOf, formatExactCount(count, locale), formatExactCount(all, locale)) : null;
    const costValue = report.priced ? formatCost(totals.cost ?? 0, report.currency, locale) : null;
    const latency = formatDuration(totals.avgDurationMs, locale), failure = formatPercent(totals.failureRate, locale);
    const list = [
      card('cost', text.cost, costValue ?? text.costUnset, { muted: !costValue, changeKey: costValue ? 'cost' : null,
        sub: costValue && totals.costRecorded < totals.requests ? fill(text.costPartial, formatExactCount(totals.costRecorded, locale), formatExactCount(totals.requests, locale)) : null }),
      card('total', text.total, countNode(document, totals.total, locale), { sub: totals.total >= 10000 ? `${formatExactCount(totals.total, locale)} ${text.tokensUnit}` : null }),
      card('requests', text.requests, countNode(document, totals.requests, locale), {
        sub: totals.cancelled ? fill(text.cancelledCount, formatExactCount(totals.cancelled, locale)) : null }),
      card('latency', text.latency, latency ?? text.notRecorded, { changeKey: 'avgDurationMs', muted: !latency, sub: partial(totals.durationRecorded, totals.requests) }),
      card('failure', text.failure, failure ?? text.notRecorded, { changeKey: 'failureRate', muted: !failure,
        sub: failure ? [fill(text.failedCount, formatExactCount(totals.failed, locale)), partial(totals.statusRecorded, totals.requests)].filter(Boolean).join(' · ') : null }),
      card('hit', text.hitRate, formatPercent(totals.cacheHitRate, locale) ?? '—', { changeKey: null,
        sub: `${text.cached} ${formatCount(totals.cached, locale)} / ${text.input} ${formatCount(totals.input, locale)}` }),
    ];
    void recorded;
    return el(document, 'div', { class: 'rud-cards' }, list);
  }
  function mix() {
    const totals = state.report.totals, parts = tokenParts(totals), sum = totals.input + totals.output;
    const names = { uncached: text.uncached, cached: text.cached, output: text.outputPlain, reasoning: text.reasoning };
    const bar = el(document, 'div', { class: 'rud-mix-bar', role: 'img', 'aria-label': parts.map(part => `${names[part.key]} ${formatPercent(part.share, locale)}`).join('，') },
      parts.filter(part => part.value > 0).map(part => el(document, 'span', { class: `rud-mix-part rud-fill-${part.key}`, style: { 'flex-grow': String(part.value) }, title: `${names[part.key]} ${formatExactCount(part.value, locale)}` })));
    const legend = el(document, 'div', { class: 'rud-mix-legend' }, parts.map(part => el(document, 'div', { class: 'rud-mix-item' },
      el(document, 'i', { class: `rud-key rud-fill-${part.key}`, 'aria-hidden': 'true' }),
      el(document, 'span', { class: 'rud-mix-name' }, names[part.key]),
      el(document, 'strong', {}, countNode(document, part.value, locale)),
      el(document, 'span', { class: 'rud-mix-share' }, formatPercent(part.share, locale) ?? '0%'))),
    totals.cacheWrite ? el(document, 'div', { class: 'rud-mix-item rud-mix-note' }, el(document, 'i', { class: 'rud-key', 'aria-hidden': 'true' }),
      el(document, 'span', { class: 'rud-mix-name' }, text.cacheWrite), el(document, 'strong', {}, countNode(document, totals.cacheWrite, locale)),
      el(document, 'span', { class: 'rud-mix-share' }, `${formatPercent(totals.input ? totals.cacheWrite / totals.input : 0, locale)} · ${text.input}`)) : null);
    return section(text.tokenParts, null, sum ? [bar, legend] : el(document, 'p', { class: 'rud-note' }, text.empty), 'rud-mix');
  }
  function section(title, accessory, body, className = '') {
    return el(document, 'section', { class: `rud-block ${className}` },
      el(document, 'div', { class: 'rud-block-head' }, el(document, 'h4', { class: 'rud-block-title' }, title), accessory),
      body);
  }

  // ---- trend
  function trend() {
    const report = state.report, unit = report.range.unit;
    const modes = el(document, 'div', { class: 'rud-segmented rud-small', role: 'radiogroup', 'aria-label': text.trend },
      [['model', text.byModel], ['type', text.byType], ['requests', text.byRequests]].map(([id, label]) => el(document, 'button', { type: 'button', role: 'radio',
        class: 'rud-segment', 'aria-checked': state.trend === id ? 'true' : 'false', onclick: () => { if (state.trend !== id) { state.trend = id; renderTrend(); } } }, label)));
    const holder = el(document, 'div', { class: 'rud-chart' });
    const legend = el(document, 'div', { class: 'rud-legend' });
    const block = section(`${text.trend} · ${unit === 'hour' ? text.perHour : unit === 'month' ? text.perMonth : text.perDay}`, modes, [holder, legend], 'rud-trend');
    block.dataset.trend = state.trend;
    return block;
  }
  function renderTrend() {
    const block = view.querySelector('.rud-trend');
    if (!block || !state.report) return;
    for (const button of block.querySelectorAll('.rud-block-head .rud-segment')) button.setAttribute('aria-checked', String(button.textContent === ({ model: text.byModel, type: text.byType, requests: text.byRequests })[state.trend]));
    const holder = block.querySelector('.rud-chart'), legend = block.querySelector('.rud-legend');
    const width = Math.max(240, Math.floor(holder.clientWidth || state.width - 40 || 560));
    const chart = trendChart(document, state.report, state.trend, width, locale);
    holder.replaceChildren(chart.svg);
    holder.dataset.mode = state.trend;
    attachTips(holder, chart);
    // Legend: what the colours are.
    const series = state.report.series ?? [];
    const items = state.trend === 'requests' ? [['rud-fill-ok', text.okRequests], ['rud-fill-failed', text.failedRequests]]
      : state.trend === 'type' ? [['rud-fill-cached', text.cached], ['rud-fill-uncached', text.uncached], ['rud-fill-output', text.output]]
        : [...series.map((model, index) => [`rud-s${index + 1}`, model === NONE ? text.unknownModel : model]),
          ...((state.report.dimensions?.model ?? []).filter(row => row.total > 0).length > series.length ? [['rud-s0', text.other]] : [])];
    legend.replaceChildren(...items.map(([cls, label]) => el(document, 'span', { class: 'rud-legend-item' }, el(document, 'i', { class: `rud-key ${cls}` }), el(document, 'span', { title: label }, label))));
  }
  function attachTips(holder, chart) {
    let active = -1;
    const hide = () => { active = -1; tipNode?.remove(); tipNode = null; chart.guide.setAttribute('visibility', 'hidden'); holder.removeAttribute('data-active');
      for (const node of holder.querySelectorAll('.rud-column[data-active]')) node.removeAttribute('data-active'); };
    const show = index => {
      const tip = chart.tips[index];
      if (!tip) return hide();
      if (index === active && tipNode?.isConnected) return;
      hide(); active = index;
      holder.setAttribute('data-active', 'true');
      holder.querySelectorAll('.rud-column')[index]?.setAttribute('data-active', 'true');
      chart.guide.setAttribute('x1', tip.center); chart.guide.setAttribute('x2', tip.center); chart.guide.setAttribute('visibility', 'visible');
      const unitText = tip.mode === 'requests' ? '' : ` ${text.tokensUnit}`;
      tipNode = el(document, 'div', { class: 'rud-tip', role: 'status' },
        el(document, 'div', { class: 'rud-tip-title' }, tip.title),
        el(document, 'div', { class: 'rud-tip-total' }, el(document, 'strong', {}, formatExactCount(tip.total, locale) + unitText),
          tip.mode === 'requests' ? null : el(document, 'span', {}, fill(text.requestsUnit, formatExactCount(tip.requests, locale)))),
        tip.rows.map(row => el(document, 'div', { class: 'rud-tip-row' }, el(document, 'i', { class: `rud-key ${row.cls}` }),
          el(document, 'span', { class: 'rud-tip-name' }, row.name), el(document, 'strong', {}, formatExactCount(row.value, locale)))));
      holder.append(tipNode);
      const space = holder.clientWidth, width = tipNode.offsetWidth;
      tipNode.style.left = `${Math.max(0, tip.center + 14 + width > space ? tip.center - 14 - width : tip.center + 14)}px`;
    };
    const svg = chart.svg;
    svg.addEventListener('pointermove', event => { const hit = event.target.closest?.('.rud-hit'); if (hit) show(Number(hit.dataset.index)); });
    svg.addEventListener('pointerdown', event => { const hit = event.target.closest?.('.rud-hit'); if (hit) show(Number(hit.dataset.index)); });
    svg.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') hide(); });
    svg.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const count = chart.tips.length;
        show(active < 0 ? (event.key === 'ArrowRight' ? 0 : count - 1) : (active + (event.key === 'ArrowRight' ? 1 : -1) + count) % count);
      } else if (event.key === 'Escape') hide();
    });
    svg.addEventListener('blur', hide);
  }

  // ---- breakdown
  function breakdown() {
    const report = state.report, dimension = state.dimension, rows = report.dimensions?.[dimension] ?? [];
    const tabs = el(document, 'div', { class: 'rud-tabs', role: 'tablist', 'aria-label': text.breakdown },
      USAGE_DIMENSION_IDS.map(id => el(document, 'button', { type: 'button', role: 'tab', class: 'rud-tab', 'aria-selected': id === dimension ? 'true' : 'false',
        onclick: () => { if (state.dimension !== id) { state.dimension = id; state.sort = { key: 'total', direction: 'desc' }; replace('.rud-breakdown', breakdown()); } } },
      text.dims[id], el(document, 'span', { class: 'rud-tab-count' }, String((report.dimensions?.[id] ?? []).length)))));
    const label = row => dimensionLabel(dimension, row, locale);
    const sorted = sortUsageRows(rows, state.sort.key, state.sort.direction, label);
    const series = seriesOf(report);
    // Colours: models keep their trend colour; other dimensions colour by rank.
    const rank = new Map(rows.filter(row => row.total > 0).map((row, index) => [row.key, index < 6 ? index + 1 : 0]));
    const colorOf = row => dimension === 'model' ? `rud-s${series(row.key)}` : `rud-s${rank.get(row.key) ?? 0}`;
    const ring = ringChart(document, rows, report.totals.total, { colorOf: row => colorOf(row), centerValue: countNode(document, report.totals.total, locale, 'rud-count rud-ring-value'),
      centerLabel: text.tokensUnit, size: state.width && state.width < 520 ? 128 : 148 });
    const columns = [['name', text.name], ['share', text.share], ['total', text.tokens], ['requests', text.requests], ['avgDurationMs', text.avgLatency],
      ['failureRate', text.failRate], ...(report.priced ? [['cost', text.cost]] : [])];
    const head = el(document, 'div', { class: 'rud-table-head', role: 'row' }, columns.map(([key, name]) => {
      const sorted = state.sort.key === key;
      const button = el(document, 'button', { type: 'button', class: 'rud-sort', 'aria-label': fill(text.sortBy, name),
        'data-sorted': sorted ? state.sort.direction : null }, name, el(document, 'span', { class: 'rud-sort-mark', 'aria-hidden': 'true' }, sorted ? (state.sort.direction === 'asc' ? '↑' : '↓') : ''));
      button.addEventListener('click', () => {
        const target = key === 'share' ? 'total' : key;
        state.sort = state.sort.key === target ? { key: target, direction: state.sort.direction === 'asc' ? 'desc' : 'asc' } : { key: target, direction: key === 'name' ? 'asc' : 'desc' };
        replace('.rud-breakdown', breakdown());
      });
      return el(document, 'div', { class: `rud-cell rud-col-${key}`, role: 'columnheader', 'aria-sort': sorted ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none' }, button);
    }));
    const largest = Math.max(1, ...rows.map(row => row.total));
    const body = sorted.map((row, index) => {
      const active = state.filters[dimension] === row.key;
      const meta = [fill(text.requestsUnit, formatExactCount(row.requests, locale)), `${text.avgLatency} ${formatDuration(row.avgDurationMs, locale) ?? text.notRecorded}`,
        `${text.failRate} ${formatPercent(row.failureRate, locale) ?? text.notRecorded}`, report.priced ? formatCost(row.cost, report.currency, locale) : null].filter(Boolean).join(' · ');
      const item = el(document, 'div', { class: `rud-table-row${active ? ' rud-active' : ''}`, role: 'row', tabindex: 0, 'data-key': row.key, 'data-meta': meta,
        title: fill(text.filterBy, `${text.dims[dimension]}：${label(row)}`), style: { '--rud-i': String(index) } },
      el(document, 'div', { class: 'rud-cell rud-col-name', role: 'cell' }, el(document, 'i', { class: `rud-swatch ${colorOf(row)}`, 'aria-hidden': 'true' }),
        el(document, 'span', { class: `rud-name${dimension === 'model' && row.key !== NONE ? ' rud-mono' : ''}${row.key === NONE ? ' rud-missing' : ''}`, title: label(row) }, label(row))),
      el(document, 'div', { class: 'rud-cell rud-col-share', role: 'cell' },
        el(document, 'span', { class: 'rud-share-bar', 'aria-hidden': 'true' }, el(document, 'i', { class: colorOf(row), style: { width: `${Math.max(0.6, row.total / largest * 100).toFixed(2)}%` } })),
        el(document, 'span', { class: 'rud-share-text' }, formatPercent(row.share, locale) ?? '0%')),
      el(document, 'div', { class: 'rud-cell rud-col-total', role: 'cell' }, countNode(document, row.total, locale, 'rud-count', { interactive: false })),
      el(document, 'div', { class: 'rud-cell rud-col-requests', role: 'cell' }, countNode(document, row.requests, locale, 'rud-count', { interactive: false })),
      el(document, 'div', { class: `rud-cell rud-col-avgDurationMs${row.avgDurationMs === null ? ' rud-missing' : ''}`, role: 'cell' }, formatDuration(row.avgDurationMs, locale) ?? text.notRecorded),
      el(document, 'div', { class: `rud-cell rud-col-failureRate${row.failureRate === null ? ' rud-missing' : row.failureRate >= 0.05 ? ' rud-warn' : ''}`, role: 'cell' }, formatPercent(row.failureRate, locale) ?? text.notRecorded),
      report.priced ? el(document, 'div', { class: `rud-cell rud-col-cost${row.cost === null ? ' rud-missing' : ''}`, role: 'cell' }, formatCost(row.cost, report.currency, locale) ?? text.notRecorded) : null);
      const choose = () => setFilter(dimension, active ? null : row.key);
      item.addEventListener('click', choose);
      item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
      item.addEventListener('pointerenter', () => view.querySelector(`.rud-ring-part[data-key="${CSS.escape(row.key)}"]`)?.classList.add('rud-hover'));
      item.addEventListener('pointerleave', () => view.querySelector('.rud-ring-part.rud-hover')?.classList.remove('rud-hover'));
      return item;
    });
    const table = el(document, 'div', { class: `rud-table${report.priced ? ' rud-priced' : ''}`, role: 'table', 'aria-label': `${text.breakdown} · ${text.dims[dimension]}` },
      head, rows.length ? body : el(document, 'p', { class: 'rud-note' }, text.emptyList));
    return el(document, 'section', { class: 'rud-block rud-breakdown' },
      el(document, 'div', { class: 'rud-block-head' }, el(document, 'h4', { class: 'rud-block-title' }, text.breakdown), el(document, 'span', { class: 'rud-hint' }, text.clickToFilter)),
      tabs, el(document, 'div', { class: 'rud-breakdown-body' }, ring, table));
  }

  // ---- requests
  function requestTime(iso) {
    const date = new Date(iso);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).map(part => [part.type, part.value]));
    const day = `${new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)}`;
    return { short: day === state.report.today ? `${parts.hour}:${parts.minute}:${parts.second}` : `${Number(parts.month)}/${Number(parts.day)} ${parts.hour}:${parts.minute}`,
      full: `${day} ${parts.hour}:${parts.minute}:${parts.second}` };
  }
  function list() {
    const report = state.report, page = report.requests, items = page.items ?? [];
    const missing = value => el(document, 'span', { class: 'rud-missing' }, text.notRecorded);
    const rows = items.map((item, index) => {
      const time = requestTime(item.at), status = item.status;
      const badge = status ? el(document, 'span', { class: `rud-status rud-status-${status}`, title: item.error ?? text.status[status] ?? status },
        el(document, 'i', { 'aria-hidden': 'true' }), text.status[status] ?? status, status === 'error' && item.error ? el(document, 'span', { class: 'rud-status-code' }, item.error) : null) : missing();
      const tokens = el(document, 'span', { class: 'rud-req-tokens', title: `${text.input} ${formatExactCount(item.input, locale)}（${text.cached} ${formatExactCount(item.cached, locale)}）· ${text.output} ${formatExactCount(item.output, locale)}${item.reasoning ? `（${text.reasoning} ${formatExactCount(item.reasoning, locale)}）` : ''}` },
        el(document, 'strong', {}, formatCount(item.total, locale)),
        el(document, 'span', { class: 'rud-req-io' }, `${formatCount(item.input, locale)} / ${formatCount(item.output, locale)}`));
      const meta = [time.short, item.agent ?? text.notRecorded, item.kind ? kindLabel(item.kind, locale) : null, formatDuration(item.durationMs, locale)].filter(Boolean).join(' · ');
      return el(document, 'div', { class: `rud-req${status === 'error' ? ' rud-req-error' : ''}`, role: 'row', 'data-meta': meta, style: { '--rud-i': String(index) } },
        el(document, 'div', { class: 'rud-cell rud-req-time', role: 'cell', title: time.full }, time.short),
        el(document, 'div', { class: 'rud-cell rud-req-bot', role: 'cell' }, item.agent ? el(document, 'span', { title: item.agent }, item.agent) : missing()),
        el(document, 'div', { class: 'rud-cell rud-req-kind', role: 'cell' }, item.kind ? el(document, 'span', { class: 'rud-tag' }, kindLabel(item.kind, locale)) : missing()),
        el(document, 'div', { class: 'rud-cell rud-req-model', role: 'cell' }, item.model ? el(document, 'span', { class: 'rud-mono', title: [item.model, item.profile, item.provider].filter(Boolean).join(' · ') }, item.model) : missing()),
        el(document, 'div', { class: 'rud-cell rud-req-total', role: 'cell' }, tokens),
        el(document, 'div', { class: 'rud-cell rud-req-duration', role: 'cell' }, formatDuration(item.durationMs, locale) ?? missing()),
        el(document, 'div', { class: 'rud-cell rud-req-status', role: 'cell' }, badge));
    });
    const head = el(document, 'div', { class: 'rud-req rud-req-head', role: 'row' },
      [text.time, text.bot, text.scene, text.model, text.tokens, text.duration, text.state].map((name, index) =>
        el(document, 'div', { class: `rud-cell ${['rud-req-time', 'rud-req-bot', 'rud-req-kind', 'rud-req-model', 'rud-req-total', 'rud-req-duration', 'rud-req-status'][index]}`, role: 'columnheader' }, name)));
    const first = page.total ? page.offset + 1 : 0, last = Math.min(page.total, page.offset + items.length);
    const pager = el(document, 'div', { class: 'rud-pager' },
      el(document, 'span', { class: 'rud-pager-text' }, fill(text.page, formatExactCount(first, locale), formatExactCount(last, locale), formatExactCount(page.total, locale))),
      el(document, 'div', { class: 'rud-pager-buttons' },
        el(document, 'button', { type: 'button', class: 'rud-button', disabled: page.offset <= 0, onclick: () => goPage(-1) }, icon(document, 'chevronLeft'), el(document, 'span', {}, text.prev)),
        el(document, 'button', { type: 'button', class: 'rud-button', disabled: last >= page.total, onclick: () => goPage(1) }, el(document, 'span', {}, text.next), icon(document, 'chevronRight'))));
    return el(document, 'section', { class: 'rud-block rud-list' },
      el(document, 'div', { class: 'rud-block-head' }, el(document, 'h4', { class: 'rud-block-title' }, text.list)),
      items.length ? el(document, 'div', { class: 'rud-req-table', role: 'table', 'aria-label': text.list }, head, rows) : el(document, 'p', { class: 'rud-note' }, text.emptyList),
      page.total > PAGE || page.offset ? pager : (items.length ? el(document, 'div', { class: 'rud-pager' }, el(document, 'span', { class: 'rud-pager-text' }, fill(text.page, formatExactCount(first, locale), formatExactCount(last, locale), formatExactCount(page.total, locale)))) : null));
  }
  function goPage(delta) {
    state.offset = Math.max(0, state.offset + delta * PAGE);
    void fetchReport({ page: true }).then(() => view.querySelector('.rud-list')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
  }

  async function exportRows() {
    if (!exportCsv || state.exporting) return;
    state.exporting = true; replace('.rud-toolbar', toolbar());
    try {
      const result = await exportCsv(query({ exportCsv: true, offset: 0 }));
      if (!result?.csv) throw new Error(text.exportFailed);
      const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
      const link = el(document, 'a', { href: url, download: result.filename || 'rokbot-usage.csv', style: { display: 'none' } });
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      notice(fill(text.exported, formatExactCount(result.count ?? 0, locale)));
    } catch (error) {
      notice(`${text.exportFailed}${error?.message && error.message !== text.exportFailed ? `：${error.message}` : ''}`, true);
    } finally {
      state.exporting = false; if (!destroyed) replace('.rud-toolbar', toolbar());
    }
  }
  function notice(message, bad = false) {
    view.querySelector('.rud-notice')?.remove();
    const node = el(document, 'div', { class: `rud-notice${bad ? ' rud-bad' : ''}`, role: 'status' }, message);
    view.append(node);
    setTimeout(() => node.remove(), 3200);
  }

  // ---- whole view
  function replace(selector, node) {
    const current = view.querySelector(selector);
    if (current) current.replaceWith(node);
    if (selector === '.rud-trend') renderTrend();
  }
  function rangeLine() {
    const report = state.report, year = report.today.slice(0, 4);
    const parts = [formatSpan(report.range.from, report.range.to, locale, year),
      report.previous ? fill(text.compare, formatSpan(report.previous.from, report.previous.to, locale, year)) : text.noCompare, report.timeZone];
    return el(document, 'div', { class: 'rud-range' }, parts.map((part, index) => el(document, 'span', { class: index ? 'rud-range-extra' : 'rud-range-main' }, part)));
  }
  function renderSkeleton() {
    view.dataset.state = 'loading';
    const bone = (cls = '') => el(document, 'span', { class: `rud-bone ${cls}` });
    view.replaceChildren(toolbar(), el(document, 'div', { class: 'rud-body', 'aria-busy': 'true', 'aria-label': text.title },
      el(document, 'div', { class: 'rud-cards' }, Array.from({ length: 6 }, () => el(document, 'div', { class: 'rud-card rud-skeleton' }, bone('rud-bone-s'), bone('rud-bone-l'), bone('rud-bone-s')))),
      el(document, 'div', { class: 'rud-block rud-skeleton' }, bone('rud-bone-s'), el(document, 'div', { class: 'rud-bone-bars' },
        Array.from({ length: 18 }, (_, index) => el(document, 'span', { class: 'rud-bone', style: { height: `${30 + ((index * 37) % 60)}%` } })))),
      el(document, 'div', { class: 'rud-block rud-skeleton' }, bone('rud-bone-s'), bone('rud-bone-row'), bone('rud-bone-row'), bone('rud-bone-row'))));
  }
  function render(scope = 'all') {
    if (destroyed) return;
    closeMenu?.(); tipNode?.remove(); tipNode = null;
    if (state.error && !state.report) {
      view.dataset.state = 'error';
      view.replaceChildren(toolbar(), el(document, 'div', { class: 'rud-state' }, el(document, 'strong', {}, text.loadFailed),
        el(document, 'span', {}, state.error), el(document, 'button', { type: 'button', class: 'rud-button rud-button-primary', onclick: () => void fetchReport() }, text.retry)));
      return;
    }
    if (!state.report) return renderSkeleton();
    if (scope === 'page') { replace('.rud-list', list()); view.querySelector('.rud-list')?.classList.add('rud-enter'); return; }
    const report = state.report;
    view.dataset.state = 'ready';
    const empty = !report.totals.requests;
    const body = el(document, 'div', { class: 'rud-body rud-enter' }, rangeLine(), filterChips(), cards(),
      empty ? el(document, 'div', { class: 'rud-state rud-empty' }, el(document, 'svg', { class: 'rud-empty-art', viewBox: '0 0 64 40', width: 64, height: 40, 'aria-hidden': 'true' },
        [8, 20, 32, 44].map((x, index) => el(document, 'rect', { x, y: 30 - index * 5, width: 8, height: 8 + index * 5, rx: 2 }))),
      el(document, 'strong', {}, Object.keys(state.filters).length ? text.emptyFiltered : text.empty)) : [mix(), trend(), breakdown(), list()]);
    view.replaceChildren(toolbar(), body);
    if (state.error) notice(`${text.loadFailed}：${state.error}`, true);
    if (!empty) renderTrend();
  }

  const resize = new (window.ResizeObserver ?? class { observe() {} disconnect() {} })(() => {
    const width = view.clientWidth;
    if (Math.abs(width - state.width) < 2) return;
    state.width = width;
    view.classList.toggle('rud-narrow', width < 640);
    if (state.report && view.querySelector('.rud-trend')) renderTrend();
  });
  resize.observe(view);
  state.width = view.clientWidth;
  view.classList.toggle('rud-narrow', state.width > 0 && state.width < 640);
  renderSkeleton();
  void fetchReport();
  return {
    refresh: () => fetchReport(),
    destroy: () => { destroyed = true; closeMenu?.(); resize.disconnect(); root.replaceChildren(); },
  };
}

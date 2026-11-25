// Usage charts for the admin overview and the desktop / web settings (Usage section).
// No dependencies: the charts are plain SVG and HTML described as a tree of
// { tag, attrs, children } nodes, which each page turns into its own elements:
// renderUsageTree() for the DOM here, a few lines of JSX in the desktop general pane.
// `{ count, unit }` nodes are token / request counts; each page shows them with its own
// count element (short text, the exact number on hover, long press or Enter).
// Styles: usage-charts.css. The desktop gets this file as rok-usage-charts.js and the CSS as
// ROK_USAGE_CHART_CSS (windows/tools/desktop-recipes/spec.mjs). Keep both dependency free.
import { formatCount, formatExactCount, usageLanguage, withRequestUnit } from './usage-format.js';

// Seven series colours (usage-charts.css, --rok-usage-c1 … c7) in a fixed order; series 0 is
// "other models". Colours follow the model, ranked by the longest period, so switching the
// period never repaints a model.
export const USAGE_SERIES = 7;

const TEXT = {
  zh: { total: '总 Token', requests: '请求数', input: '输入', output: '输出', hitRate: '缓存命中率', cached: '缓存命中', cacheWrite: '缓存写入',
    byHour: '每小时 Token', byDay: '每日 Token', share: '模型占比', details: '明细', model: '模型', sum: '合计', other: '其他模型',
    tipTotal: '合计 Token', unknown: '未知模型', empty: '这段时间还没有模型请求', token: 'Token', chart: '{0}，{1}，合计 {2} Token' },
  en: { total: 'Total tokens', requests: 'Requests', input: 'Input', output: 'Output', hitRate: 'Cache hit rate', cached: 'Cache read', cacheWrite: 'Cache write',
    byHour: 'Tokens per hour', byDay: 'Tokens per day', share: 'Share by model', details: 'Details', model: 'Model', sum: 'Total', other: 'Other models',
    tipTotal: 'tokens in total', unknown: 'Unknown model', empty: 'No model requests in this period', token: 'tokens', chart: '{0}, {1}, {2} tokens in total' },
};
const fill = (template, ...values) => template.replace(/\{(\d)\}/g, (_, index) => values[index]);
const h = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat().filter(child => child !== null && child !== undefined && child !== false) });
const count = (value, unit = null) => ({ count: value, unit });

/** Series per model: 1 … USAGE_SERIES for the largest models of the longest period, 0 for the rest. */
export function usageSeries(usage) {
  const periods = usage?.periods ?? [];
  const longest = periods.reduce((best, period) => (period.days ?? 0) > (best?.days ?? -1) ? period : best, null);
  const series = new Map();
  for (const item of longest?.models ?? []) if (item.total > 0 && series.size < USAGE_SERIES) series.set(item.model, series.size + 1);
  return model => series.get(model) ?? 0;
}

/** The share of `part` in `whole` as text: "45.3%", "<0.1%", "0%". */
export function formatShare(part, whole, locale) {
  if (!whole || !part) return '0%';
  const share = part / whole * 100;
  if (share < 0.1) return '<0.1%';
  return `${share.toLocaleString(usageLanguage(locale) === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: share < 10 ? 1 : 0 })}%`;
}

/** Up to five round ticks from 0 that reach `max`: 0, 2.5 亿, 5 亿 … */
export function usageTicks(max, wanted = 4) {
  if (!(max > 0)) return [0];
  const rough = max / wanted, power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * power).find(value => value >= rough);
  const ticks = [];
  for (let value = 0; value < max + step; value += step) ticks.push(Math.round(value * 1e6) / 1e6);
  return ticks.length > 1 && ticks[ticks.length - 2] >= max ? ticks.slice(0, -1) : ticks;
}

// "2026-11-25" → "11/25" on the axis, "11月25日" / "Nov 25" in the tooltip; "2026-11-25T13" → "13:00".
function bucketLabels(start, unit, locale) {
  const language = usageLanguage(locale);
  if (unit === 'hour') {
    const hour = Number(start.slice(11, 13));
    return { axis: `${hour}:00`, title: `${hour}:00–${hour + 1}:00` };
  }
  const [, month, day] = start.split('-').map(Number);
  const title = language === 'zh' ? `${month}月${day}日` : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, month - 1, day)));
  return { axis: `${month}/${day}`, title };
}
// About how wide a short label is at 11px: CJK characters are wider than digits.
const textWidth = text => [...text].reduce((width, char) => width + (/[　-鿿]/.test(char) ? 11 : 6.4), 0);
const modelName = (model, text) => model === 'unknown' ? text.unknown : model;

// A column segment: square at the bottom, the top corners rounded by `radius`.
function segmentPath(x, top, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height)), bottom = top + height, n = value => Math.round(value * 100) / 100;
  if (!r) return `M${n(x)} ${n(bottom)}V${n(top)}H${n(x + width)}V${n(bottom)}Z`;
  return `M${n(x)} ${n(bottom)}V${n(top + r)}Q${n(x)} ${n(top)} ${n(x + r)} ${n(top)}H${n(x + width - r)}Q${n(x + width)} ${n(top)} ${n(x + width)} ${n(top + r)}V${n(bottom)}Z`;
}

function columnChart(period, seriesOf, { locale, width, text }) {
  const buckets = period.buckets ?? [], unit = period.unit === 'hour' ? 'hour' : 'day';
  const max = Math.max(0, ...buckets.map(bucket => bucket.total)), ticks = usageTicks(max);
  const top = ticks[ticks.length - 1] || 1, plotTop = 8, plotHeight = 168, axisHeight = 24, height = plotTop + plotHeight + axisHeight;
  const tickLabels = ticks.map(value => formatCount(value, locale));
  const left = Math.ceil(Math.max(...tickLabels.map(textWidth))) + 10, right = 4;
  const plotWidth = Math.max(40, width - left - right), step = plotWidth / Math.max(1, buckets.length);
  const barWidth = Math.max(2, Math.min(24, step * 0.62)), y = value => plotTop + plotHeight - value / top * plotHeight;
  const children = [];
  ticks.forEach((value, index) => {
    const at = Math.round(y(value)) + 0.5;
    children.push(h('line', { class: index ? 'rok-usage-grid' : 'rok-usage-axis', x1: left, x2: width - right, y1: at, y2: at }));
    children.push(h('text', { class: 'rok-usage-tick rok-usage-tick-y', x: left - 6, y: at + 4 }, tickLabels[index]));
  });
  // Label every bucket that fits (about 44px a label), counting back from the last one.
  const every = unit === 'hour' ? [1, 2, 3, 6, 12].find(value => value * step >= 40) ?? 12 : Math.max(1, Math.ceil(44 / step));
  const tips = [];
  buckets.forEach((bucket, index) => {
    const labels = bucketLabels(bucket.start, unit, locale), center = left + step * (index + 0.5), x = center - barWidth / 2;
    const show = unit === 'hour' ? index % every === 0 : (buckets.length - 1 - index) % every === 0;
    if (show) children.push(h('text', { class: 'rok-usage-tick rok-usage-tick-x', x: Math.round(center * 10) / 10, y: plotTop + plotHeight + 17 }, labels.axis));
    // Stack the series in their fixed order from the baseline, other models on top.
    const stacks = new Map();
    for (const item of bucket.models ?? []) {
      const series = seriesOf(item.model);
      stacks.set(series, (stacks.get(series) ?? 0) + item.total);
    }
    const order = [...stacks.keys()].sort((a, b) => (a || 99) - (b || 99));
    const marks = [];
    let sum = 0;
    // A 2px gap of the surface between segments; a segment too thin to see stays in the tooltip.
    const drawn = order.map((series, at) => {
      const low = y(sum) - (at ? 2 : 0); sum += stacks.get(series);
      return { series, low, high: y(sum) };
    }).filter(part => part.low - part.high >= 0.75);
    drawn.forEach((part, at) => {
      marks.push(h('path', { class: `rok-usage-seg rok-usage-s${part.series}`,
        d: segmentPath(x, part.high, barWidth, part.low - part.high, at === drawn.length - 1 ? 4 : 0) }));
    });
    tips.push({ title: labels.title, total: bucket.total, requests: bucket.requests, center,
      rows: (bucket.models ?? []).filter(item => item.total > 0).map(item => ({ series: seriesOf(item.model), name: modelName(item.model, text), total: item.total })) });
    children.push(h('g', { class: 'rok-usage-col', 'data-tip': index,
      'aria-label': `${labels.title}: ${formatExactCount(bucket.total, locale)} ${text.token}` },
    h('rect', { class: 'rok-usage-hit', x: Math.round((left + step * index) * 100) / 100, y: 0, width: Math.round(step * 100) / 100, height: plotTop + plotHeight }), ...marks));
  });
  const title = unit === 'hour' ? text.byHour : text.byDay;
  const svg = h('svg', { class: 'rok-usage-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: 0,
    'aria-label': fill(text.chart, title, `${period.from} – ${period.to}`, formatExactCount(period.total, locale)) }, ...children);
  return { node: h('div', { class: 'rok-usage-chart', 'data-unit': unit }, svg), tips };
}

function shareList(period, seriesOf, { locale, text }) {
  const parts = new Map();
  for (const item of period.models) {
    const series = seriesOf(item.model), key = series ? item.model : '';
    const part = parts.get(key) ?? { series, name: series ? modelName(item.model, text) : text.other, total: 0, models: 0 };
    part.total += item.total; part.models++; parts.set(key, part);
  }
  const rows = [...parts.values()].filter(part => part.total > 0).sort((a, b) => (!a.series) - (!b.series) || b.total - a.total);
  const largest = Math.max(1, ...rows.map(part => part.total));
  return h('ul', { class: 'rok-usage-share' }, rows.map(part => h('li', { class: 'rok-usage-share-row' },
    h('span', { class: 'rok-usage-share-name' }, h('i', { class: `rok-usage-swatch rok-usage-s${part.series}`, 'aria-hidden': 'true' }),
      h('span', { title: part.name }, part.series ? part.name : `${part.name} (${part.models})`)),
    h('span', { class: 'rok-usage-share-bar', 'aria-hidden': 'true' },
      h('i', { class: `rok-usage-s${part.series}`, style: { width: `${Math.max(0.5, part.total / largest * 100).toFixed(2)}%` } })),
    h('span', { class: 'rok-usage-share-value' }, h('strong', {}, formatShare(part.total, period.total, locale)), ' ', count(part.total)))));
}

function cards(period, { locale, text }) {
  const rate = period.input ? formatShare(period.cached, period.input, locale) : '—';
  const card = (label, ...value) => h('div', { class: 'rok-usage-card' }, h('span', { class: 'rok-usage-card-label' }, label), h('span', { class: 'rok-usage-card-value' }, ...value));
  return h('div', { class: 'rok-usage-cards' },
    card(text.total, count(period.total)),
    card(text.requests, count(period.requests)),
    card(text.input, count(period.input)),
    card(text.output, count(period.output)),
    card(text.hitRate, h('span', { class: 'rok-usage-rate', tabindex: 0,
      title: `${text.cached} ${formatExactCount(period.cached, locale)} / ${text.input} ${formatExactCount(period.input, locale)}` }, rate)));
}

function table(period, seriesOf, { text }) {
  const write = period.cacheWrite > 0;
  const heads = [text.model, text.total, text.input, text.output, text.cached, ...(write ? [text.cacheWrite] : []), text.requests];
  const cells = item => [item.total, item.input, item.output, item.cached, ...(write ? [item.cacheWrite] : []), item.requests].map(value => h('td', {}, count(value)));
  return h('div', { class: 'rok-usage-table-wrap' }, h('table', { class: 'rok-usage-table' },
    h('thead', {}, h('tr', {}, heads.map((head, index) => h('th', { scope: 'col', class: index ? '' : 'rok-usage-table-model' }, head)))),
    h('tbody', {}, period.models.map(item => h('tr', {},
      h('th', { scope: 'row', class: 'rok-usage-table-model' }, h('span', { class: 'rok-usage-table-name' },
        h('i', { class: `rok-usage-swatch rok-usage-s${seriesOf(item.model)}`, 'aria-hidden': 'true' }),
        h('span', { title: modelName(item.model, text) }, modelName(item.model, text)))), ...cells(item)))),
    period.models.length > 1 ? h('tfoot', {}, h('tr', {}, h('th', { scope: 'row', class: 'rok-usage-table-model' }, text.sum), ...cells(period))) : null));
}

/**
 * The charts for one period of a usage response: summary cards, tokens per hour (today) or per
 * day stacked by model, the share per model and the table. `width` is the view's width in px.
 * Returns { tree, tips }; tips[i] describes column i for attachUsageTooltip().
 */
export function usageView(usage, periodId, { locale, width = 560 } = {}) {
  const text = TEXT[usageLanguage(locale)], periods = usage?.periods ?? [];
  const period = periods.find(item => item.id === periodId) ?? periods[0];
  if (!period) return { tree: null, tips: [] };
  // The chart's block has 16px padding on each side, 12px in a narrow view (usage-charts.css).
  const seriesOf = usageSeries(usage), options = { locale, width: Math.max(200, Math.floor(width - (width <= 520 ? 24 : 32))), text };
  if (!period.requests) return { tree: h('div', { class: 'rok-usage-view' }, cards(period, options), h('p', { class: 'rok-usage-empty' }, text.empty)), tips: [] };
  const chart = columnChart(period, seriesOf, options);
  const block = (title, ...body) => h('section', { class: 'rok-usage-block' }, h('h4', { class: 'rok-usage-block-title' }, title), ...body);
  return {
    tips: chart.tips,
    tree: h('div', { class: 'rok-usage-view' }, cards(period, options),
      block(period.unit === 'hour' ? text.byHour : text.byDay, chart.node),
      block(text.share, shareList(period, seriesOf, options)),
      block(text.details, table(period, seriesOf, options))),
  };
}

const SVG = 'http://www.w3.org/2000/svg';
/** The tree as DOM elements; `countElement(value, unit)` makes each count. Text is never parsed as HTML. */
export function renderUsageTree(node, countElement, document = globalThis.document, svg = false) {
  if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node));
  if ('count' in node) return countElement(node.count, node.unit);
  const inSvg = svg || node.tag === 'svg', element = inSvg ? document.createElementNS(SVG, node.tag) : document.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (name === 'style') for (const [property, rule] of Object.entries(value)) element.style[property] = rule;
    else element.setAttribute(name, String(value));
  }
  for (const child of node.children) element.append(renderUsageTree(child, countElement, document, inSvg));
  return element;
}

/**
 * Hover, touch and keyboard readouts for the column chart inside `root`: the column under the
 * pointer (or chosen with ← →) shows its time, total and every model with exact counts.
 * `tips()` returns the current usageView() tips. Returns a function that removes the listeners.
 */
export function attachUsageTooltip(root, tips, locale) {
  const document = root.ownerDocument, text = TEXT[usageLanguage(locale)];
  let tip = null, active = -1;
  const chart = () => root.querySelector('.rok-usage-chart');
  const hide = () => {
    active = -1; tip?.remove(); tip = null;
    chart()?.removeAttribute('data-active');
    for (const column of root.querySelectorAll('.rok-usage-col[data-active]')) column.removeAttribute('data-active');
  };
  const line = (className, series, label, value) => {
    const row = document.createElement('div'); row.className = className;
    if (series !== null) { const key = document.createElement('i'); key.className = `rok-usage-key rok-usage-s${series}`; row.append(key); }
    const strong = document.createElement('strong'); strong.textContent = value;
    const name = document.createElement('span'); name.textContent = label;
    row.append(strong, name); return row;
  };
  const show = index => {
    const item = tips()[index], host = chart();
    if (!item || !host) return hide();
    hide(); active = index;
    host.setAttribute('data-active', 'true');
    host.querySelector(`.rok-usage-col[data-tip="${index}"]`)?.setAttribute('data-active', 'true');
    tip = document.createElement('div'); tip.className = 'rok-usage-tip'; tip.setAttribute('role', 'status');
    const title = document.createElement('div'); title.className = 'rok-usage-tip-title'; title.textContent = item.title;
    const requests = withRequestUnit(formatExactCount(item.requests, locale), item.requests, locale);
    tip.append(title, line('rok-usage-tip-total', null, `${text.tipTotal} · ${requests}`, formatExactCount(item.total, locale)));
    for (const row of item.rows) tip.append(line('rok-usage-tip-row', row.series, row.name, formatExactCount(row.total, locale)));
    host.append(tip);
    // Beside the column, flipped to the left near the right edge.
    const space = host.clientWidth, width = tip.offsetWidth;
    tip.style.left = `${Math.max(0, item.center + 12 + width > space ? item.center - 12 - width : item.center + 12)}px`;
  };
  const over = event => {
    const column = event.target?.closest?.('.rok-usage-col');
    // After a re-render the readout belongs to the old chart: show it again.
    if (column) { const index = Number(column.getAttribute('data-tip')); if (index !== active || tip?.parentNode !== chart()) show(index); }
    else if (active >= 0 && (event.type === 'pointerdown' || event.pointerType === 'mouse')) hide();
  };
  const leave = event => { if (event.pointerType === 'mouse' || !event.pointerType) hide(); };
  const key = event => {
    if (!event.target?.classList?.contains('rok-usage-svg')) return;
    const count = tips().length;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      show(active < 0 ? (event.key === 'ArrowRight' ? 0 : count - 1) : (active + (event.key === 'ArrowRight' ? 1 : -1) + count) % count);
    } else if (event.key === 'Escape') hide();
  };
  const blur = event => { if (event.target?.classList?.contains('rok-usage-svg')) hide(); };
  root.addEventListener('pointermove', over);
  root.addEventListener('pointerdown', over);
  root.addEventListener('pointerleave', leave);
  root.addEventListener('keydown', key);
  root.addEventListener('focusout', blur);
  return () => {
    hide();
    root.removeEventListener('pointermove', over); root.removeEventListener('pointerdown', over);
    root.removeEventListener('pointerleave', leave); root.removeEventListener('keydown', key); root.removeEventListener('focusout', blur);
  };
}

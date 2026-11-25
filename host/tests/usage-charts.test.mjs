import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { attachUsageTooltip, formatShare, renderUsageTree, USAGE_SERIES, usageSeries, usageTicks, usageView } from '../server/public/usage-charts.js';

const FIELDS = ['input', 'output', 'total', 'cached', 'cacheWrite', 'reasoning', 'requests'];
const item = (model, total, extra = {}) => ({ model, input: total - 10 > 0 ? total - 10 : total, output: Math.min(10, total), total, cached: 0, cacheWrite: 0, reasoning: 0, requests: 1, ...extra });
const sum = models => Object.fromEntries(FIELDS.map(key => [key, models.reduce((value, entry) => value + entry[key], 0)]));
const bucket = (start, models) => ({ start, ...sum(models), models: [...models].sort((a, b) => b.total - a.total) });
function fixture() {
  const days = ['2026-11-23', '2026-11-24', '2026-11-25'];
  const daily = [
    bucket(days[0], [item('gpt-5', 300000000, { cached: 200000000, requests: 2 }), item('claude-opus', 12345, { cacheWrite: 120 })]),
    bucket(days[1], []),
    bucket(days[2], [item('claude-opus', 50000), item('tiny', 1)]),
  ];
  const hours = Array.from({ length: 24 }, (_, hour) => bucket(`2026-11-25T${String(hour).padStart(2, '0')}`,
    hour === 9 ? [item('claude-opus', 50000)] : hour === 13 ? [item('tiny', 1)] : []));
  const period = (id, days, buckets, unit) => {
    const totals = new Map();
    for (const entry of buckets.flatMap(value => value.models)) {
      const current = totals.get(entry.model) ?? { model: entry.model, ...Object.fromEntries(FIELDS.map(key => [key, 0])) };
      for (const key of FIELDS) current[key] += entry[key];
      totals.set(entry.model, current);
    }
    const models = [...totals.values()].sort((a, b) => b.total - a.total);
    return { id, days, from: buckets[0].start.slice(0, 10), to: '2026-11-25', ...sum(models), models, unit, buckets };
  };
  const today = period('today', 1, hours, 'hour'), month = period('30d', 30, daily, 'day');
  return { date: '2026-11-25', timeZone: 'Asia/Shanghai', ...sum(today.models), models: today.models, periods: [today, { ...month, id: '7d', days: 7 }, month] };
}
// Every node of a usageView() tree, depth first.
const nodes = tree => [tree, ...(tree?.children ?? []).flatMap(child => typeof child === 'object' ? nodes(child) : [])];
const byClass = (tree, name) => nodes(tree).filter(node => node.attrs && String(node.attrs.class ?? '').split(' ').includes(name));
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : tree && 'count' in tree ? `#${tree.count}` : (tree?.children ?? []).map(text).join('');

test('usageSeries colours each model by its rank in the longest period, the same in every period', () => {
  const usage = fixture(), seriesOf = usageSeries(usage);
  assert.deepEqual(['gpt-5', 'claude-opus', 'tiny', 'none'].map(seriesOf), [1, 2, 3, 0]);
  // Today has claude-opus first, but it keeps its colour from the last 30 days.
  const today = usageView(usage, 'today', { locale: 'en' }).tree;
  assert.ok(byClass(today, 'rok-usage-share-row').every(row => !text(row).includes('gpt-5')));
  assert.match(byClass(today, 'rok-usage-swatch')[0].attrs.class, /rok-usage-s2/);
  // Past USAGE_SERIES models the rest are "other models", series 0.
  const many = Array.from({ length: USAGE_SERIES + 2 }, (_, index) => item(`m${index}`, 1000 - index));
  const crowded = { periods: [{ id: '30d', days: 30, ...sum(many), models: many, unit: 'day', buckets: [bucket('2026-11-25', many)] }] };
  const crowdedSeries = usageSeries(crowded);
  assert.deepEqual(many.map(entry => crowdedSeries(entry.model)), [1, 2, 3, 4, 5, 6, 7, 0, 0]);
  const share = byClass(usageView(crowded, '30d', { locale: 'zh-CN' }).tree, 'rok-usage-share-row');
  assert.equal(share.length, USAGE_SERIES + 1);
  assert.match(text(share.at(-1)), /^其他模型 \(2\)/);
});

test('formatShare and usageTicks give readable shares and round axis steps', () => {
  assert.equal(formatShare(0, 100, 'en'), '0%');
  assert.equal(formatShare(5, 0, 'en'), '0%');
  assert.equal(formatShare(1, 10000, 'en'), '<0.1%');
  assert.equal(formatShare(453, 1000, 'zh-CN'), '45%');
  assert.equal(formatShare(97, 1000, 'en'), '9.7%');
  assert.equal(formatShare(1, 1, 'en'), '100%');
  assert.deepEqual(usageTicks(0), [0]);
  assert.deepEqual(usageTicks(860000000), [0, 250000000, 500000000, 750000000, 1000000000]);
  assert.deepEqual(usageTicks(40000000), [0, 10000000, 20000000, 30000000, 40000000]);
  assert.deepEqual(usageTicks(7), [0, 2, 4, 6, 8]);
  assert.deepEqual(usageTicks(1), [0, 0.25, 0.5, 0.75, 1]);
});

test('usageView: summary cards, stacked columns per day or hour, share per model and the table', () => {
  const usage = fixture();
  for (const [locale, labels] of [['zh-CN', ['总 Token', '请求数', '输入', '输出', '缓存命中率']], ['en', ['Total tokens', 'Requests', 'Input', 'Output', 'Cache hit rate']]]) {
    const { tree, tips } = usageView(usage, '30d', { locale, width: 600 });
    const cards = byClass(tree, 'rok-usage-card');
    assert.deepEqual(cards.map(card => text(byClass(card, 'rok-usage-card-label')[0])), labels);
    const month = usage.periods[2];
    assert.deepEqual(cards.slice(0, 4).map(card => text(byClass(card, 'rok-usage-card-value')[0])), [month.total, month.requests, month.input, month.output].map(value => `#${value}`));
    // 200,000,000 of 300,062,316 input tokens were cache reads.
    assert.equal(month.input, 300062316);
    const rate = byClass(tree, 'rok-usage-rate')[0];
    assert.equal(text(rate), '67%');
    assert.equal(rate.attrs.title, locale === 'en' ? 'Cache read 200,000,000 / Input 300,062,316' : '缓存命中 200,000,000 / 输入 300,062,316');
    assert.equal(tips.length, 3);
    assert.equal(tips[0].title, locale === 'en' ? 'Nov 23' : '11月23日');
  }
  const { tree, tips } = usageView(usage, '30d', { locale: 'en', width: 600 });
  const svg = nodes(tree).find(node => node.tag === 'svg');
  // The view is 600px wide, the chart block has 16px padding on each side.
  assert.equal(svg.attrs.width, 568);
  assert.equal(svg.attrs.viewBox, `0 0 568 ${svg.attrs.height}`);
  assert.equal(svg.attrs.tabindex, 0);
  assert.match(svg.attrs['aria-label'], /^Tokens per day, 2026-11-23 – 2026-11-25, 300,062,346 tokens in total$/);
  const columns = byClass(tree, 'rok-usage-col');
  assert.equal(columns.length, 3);
  // Day 1: gpt-5 at the bottom (series 1), claude-opus above it, its top corners rounded.
  const first = byClass(columns[0], 'rok-usage-seg');
  assert.deepEqual(first.map(node => node.attrs.class), ['rok-usage-seg rok-usage-s1']);
  // claude-opus is 12,345 of 300 million tokens: too thin to draw, still in the tooltip.
  assert.deepEqual(tips[0].rows.map(row => [row.series, row.name, row.total]), [[1, 'gpt-5', 300000000], [2, 'claude-opus', 12345]]);
  assert.match(first[0].attrs.d, /Q/);
  assert.equal(byClass(columns[1], 'rok-usage-seg').length, 0);
  assert.deepEqual(tips[1], { title: 'Nov 24', total: 0, requests: 0, center: tips[1].center, rows: [] });
  // Every column has a hit area across its whole slot and the full height.
  const hits = columns.map(column => byClass(column, 'rok-usage-hit')[0].attrs);
  assert.ok(hits.every(hit => hit.height === hits[0].height && Math.abs(hit.width - hits[0].width) < 0.02));
  assert.ok(Math.abs(hits[1].x - (hits[0].x + hits[0].width)) < 0.02);
  assert.deepEqual(byClass(tree, 'rok-usage-tick-x').map(text), ['11/23', '11/24', '11/25']);
  assert.deepEqual(byClass(tree, 'rok-usage-tick-y').map(text), ['0', '100M', '200M', '300M', '400M']);
  // Share: largest first, with its share and short total; the table lists every model and a total row.
  assert.deepEqual(byClass(tree, 'rok-usage-share-row').map(text), ['gpt-5100%#300000000', 'claude-opus<0.1%#62345', 'tiny<0.1%#1'].map(value => value.replace(/(%)/, '$1 ')));
  const table = nodes(tree).find(node => node.tag === 'table');
  assert.deepEqual(nodes(table).filter(node => node.tag === 'th' && node.attrs.scope === 'col').map(text), ['Model', 'Total tokens', 'Input', 'Output', 'Cache read', 'Cache write', 'Requests']);
  assert.deepEqual(nodes(nodes(table).find(node => node.tag === 'tfoot')).filter(node => node.tag === 'td').map(text),
    ['#300062346', '#300062316', '#31', '#200000000', '#120', '#5']);
});

test('usageView: today per hour, segments with a 2px gap, labels that fit and an empty period', () => {
  const usage = fixture();
  const { tree, tips } = usageView(usage, 'today', { locale: 'zh-CN', width: 400 });
  assert.equal(byClass(tree, 'rok-usage-col').length, 24);
  assert.equal(tips[9].title, '9:00–10:00');
  assert.equal(tips[23].title, '23:00–24:00');
  assert.equal(nodes(tree).find(node => node.tag === 'h4').children[0], '每小时 Token');
  // A narrow view (≤ 520px) has 12px padding; hour labels every few hours so they do not touch.
  assert.equal(nodes(tree).find(node => node.tag === 'svg').attrs.width, 376);
  const hours = byClass(tree, 'rok-usage-tick-x').map(text);
  assert.deepEqual(hours, ['0:00', '3:00', '6:00', '9:00', '12:00', '15:00', '18:00', '21:00']);
  assert.equal(hours[0], '0:00');
  // Two models in one column: the lower segment ends 2px below the upper one.
  const stacked = { periods: [{ id: '30d', days: 30, unit: 'day', ...sum([item('a', 600), item('b', 400)]), models: [item('a', 600), item('b', 400)],
    buckets: [bucket('2026-11-25', [item('a', 600), item('b', 400)])] }] };
  const parts = byClass(usageView(stacked, '30d', { locale: 'en', width: 600 }).tree, 'rok-usage-seg')
    .map(node => node.attrs.d.match(/-?\d+(?:\.\d+)?/g).map(Number));
  assert.equal(parts.length, 2);
  const [lowerBottom, lowerTop] = [parts[0][1], parts[0][2]], upperBottom = parts[1][1];
  assert.ok(lowerBottom > lowerTop);
  assert.equal(Math.round((lowerTop - upperBottom) * 100) / 100, 2);
  // Nothing in the period: the cards and a note, no chart.
  const empty = usageView({ periods: [{ id: 'today', days: 1, unit: 'hour', ...sum([]), models: [], buckets: [] }] }, 'today', { locale: 'en' });
  assert.equal(nodes(empty.tree).some(node => node.tag === 'svg'), false);
  assert.ok(text(empty.tree).includes('No model requests in this period'));
  assert.equal(usageView(null, 'today').tree, null);
  assert.equal(usageView({ periods: [] }, 'today').tree, null);
});

// A small DOM: enough for renderUsageTree() and attachUsageTooltip().
class FakeNode {
  constructor(document, tag, namespace = null) {
    Object.assign(this, { ownerDocument: document, tagName: tag, namespaceURI: namespace, childNodes: [], parentNode: null, attributes: new Map(), style: {}, listeners: new Map(), textValue: '' });
  }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get classList() { return { contains: name => this.className.split(' ').includes(name) }; }
  get textContent() { return this.textValue + this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.childNodes = []; this.textValue = String(value); }
  get clientWidth() { return 600; }
  get offsetWidth() { return 180; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  append(...children) { for (const child of children) { child.parentNode = this; this.childNodes.push(child); } }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(child => child !== this); this.parentNode = null; }
  matches(selector) {
    return selector.split(',').some(part => {
      const match = part.trim().match(/^\.([\w-]+)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
      return match && this.classList.contains(match[1]) && (!match[2] || (match[3] === undefined ? this.hasAttribute(match[2]) : this.getAttribute(match[2]) === match[3]));
    });
  }
  closest(selector) { for (let node = this; node instanceof FakeNode; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.childNodes.flatMap(child => child instanceof FakeNode ? [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)] : []); }
  querySelector(selector) {
    const [outer, inner] = selector.split(' ');
    const found = this.querySelectorAll(outer);
    return inner ? found.map(node => node.querySelector(inner)).find(Boolean) ?? null : found[0] ?? null;
  }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry !== listener)); }
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (let node = this; node; node = node.parentNode) for (const listener of node.listeners?.get(type) ?? []) listener(event);
    return event;
  }
}
class FakeText { constructor(value) { this.textContent = value; } }
function fakeDocument() {
  const document = { createElement: tag => new FakeNode(document, tag), createElementNS: (namespace, tag) => new FakeNode(document, tag, namespace), createTextNode: value => new FakeText(value) };
  return document;
}

test('renderUsageTree builds SVG and HTML without innerHTML; the tooltip follows pointer, touch and arrow keys', () => {
  const document = fakeDocument(), usage = fixture();
  const view = usageView(usage, '30d', { locale: 'en', width: 600 });
  const counts = [];
  const root = new FakeNode(document, 'div');
  root.append(renderUsageTree(view.tree, (value, unit) => { counts.push(value); const node = document.createElement('span'); node.textContent = `#${value}`; return node; }, document));
  const svg = root.querySelector('.rok-usage-svg');
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.querySelector('.rok-usage-col').namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(root.querySelector('.rok-usage-cards').namespaceURI, null);
  assert.equal(root.querySelector('.rok-usage-share-bar').childNodes[0].style.width, '100.00%');
  assert.ok(counts.includes(300062346));
  // Model names are text nodes, never markup.
  const hostile = { periods: [{ ...usage.periods[2], models: [item('<img src=x onerror=alert(1)>', 10)], buckets: [bucket('2026-11-25', [item('<img src=x onerror=alert(1)>', 10)])] }] };
  const safe = new FakeNode(document, 'div');
  safe.append(renderUsageTree(usageView(hostile, '30d', { locale: 'en' }).tree, value => document.createTextNode(String(value)), document));
  assert.equal(safe.querySelectorAll('.rok-usage-share-row').length, 1);
  assert.ok(safe.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(safe.querySelectorAll('.rok-usage-share-row')[0].querySelectorAll('.x').length, 0);

  let tips = view.tips;
  const detach = attachUsageTooltip(root, () => tips, 'en');
  const chart = root.querySelector('.rok-usage-chart'), columns = root.querySelectorAll('.rok-usage-col');
  columns[0].querySelector('.rok-usage-hit').dispatch('pointermove', { pointerType: 'mouse' });
  const tip = () => chart.querySelector('.rok-usage-tip');
  assert.equal(chart.getAttribute('data-active'), 'true');
  assert.equal(columns[0].getAttribute('data-active'), 'true');
  assert.deepEqual(tip().childNodes.map(node => node.textContent), ['Nov 23', '300,012,345tokens in total · 3 requests', '300,000,000gpt-5', '12,345claude-opus']);
  assert.equal(tip().querySelectorAll('.rok-usage-key')[0].className, 'rok-usage-key rok-usage-s1');
  // Beside the column; flipped to its left when it would leave the chart.
  assert.equal(tip().style.left, `${tips[0].center + 12}px`);
  columns[2].dispatch('pointermove', { pointerType: 'mouse' });
  assert.equal(chart.querySelectorAll('.rok-usage-tip').length, 1);
  assert.equal(columns[0].getAttribute('data-active'), null);
  assert.equal(tip().style.left, `${Math.max(0, tips[2].center - 12 - 180)}px`);
  // The mouse leaving the columns hides it; a tap elsewhere hides it on touch screens.
  root.querySelector('.rok-usage-share').dispatch('pointermove', { pointerType: 'mouse' });
  assert.equal(tip(), null);
  assert.equal(chart.getAttribute('data-active'), null);
  columns[1].dispatch('pointerdown', { pointerType: 'touch' });
  assert.equal(tip().childNodes[0].textContent, 'Nov 24');
  root.querySelector('.rok-usage-share').dispatch('pointermove', { pointerType: 'touch' });
  assert.ok(tip(), 'a touch move off the chart keeps the readout');
  root.querySelector('.rok-usage-share').dispatch('pointerdown', { pointerType: 'touch' });
  assert.equal(tip(), null);
  // Keyboard: arrows on the focused chart step through the columns, wrapping; Escape hides.
  const right = svg.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(right.defaultPrevented, true);
  assert.equal(tip().childNodes[0].textContent, 'Nov 23');
  svg.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(tip().childNodes[0].textContent, 'Nov 25');
  svg.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(tip().childNodes[0].textContent, 'Nov 23');
  svg.dispatch('keydown', { key: 'Escape' });
  assert.equal(tip(), null);
  svg.dispatch('keydown', { key: 'ArrowLeft' });
  svg.dispatch('focusout');
  assert.equal(tip(), null);
  // New tips after a re-render are read on the next move; detaching removes the readout and listeners.
  tips = tips.map(entry => ({ ...entry, title: `${entry.title}!` }));
  columns[1].dispatch('pointermove', { pointerType: 'mouse' });
  assert.equal(tip().childNodes[0].textContent, 'Nov 24!');
  // The page re-renders the view (another period, a new width): the same column shows again.
  root.childNodes = [];
  root.append(renderUsageTree(view.tree, value => document.createTextNode(String(value)), document));
  const redrawn = root.querySelectorAll('.rok-usage-col');
  redrawn[1].dispatch('pointermove', { pointerType: 'mouse' });
  assert.equal(root.querySelector('.rok-usage-chart').querySelector('.rok-usage-tip').childNodes[0].textContent, 'Nov 24!');
  assert.equal(redrawn[1].getAttribute('data-active'), 'true');
  detach();
  assert.equal(root.querySelector('.rok-usage-chart').querySelector('.rok-usage-tip'), null);
  assert.equal(tip(), null);
  columns[1].dispatch('pointermove', { pointerType: 'mouse' });
  assert.equal(tip(), null);
});

test('usage-charts.css has light and dark series colours for the admin page and the desktop renderer', async () => {
  const css = await readFile(new URL('../server/public/usage-charts.css', import.meta.url), 'utf8');
  const block = selector => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
  const colours = body => [...body.matchAll(/--rok-usage-c(\d): (#[0-9a-f]{6})/g)].map(match => [Number(match[1]), match[2]]);
  const light = colours(block('.rok-usage-view {')), dark = colours(block(':root[data-theme="dark"] .rok-usage-view'));
  assert.equal(light.length, USAGE_SERIES + 1);
  assert.equal(dark.length, USAGE_SERIES + 1);
  assert.notDeepEqual(light, dark);
  assert.match(css, /:root\[data-theme="cursor-dark"\] \.rok-usage-view/);
  for (let series = 0; series <= USAGE_SERIES; series++) assert.match(css, new RegExp(`\\.rok-usage-s${series} \\{ fill: var\\(--rok-usage-c${series}\\); background: var\\(--rok-usage-c${series}\\); \\}`));
  // Nothing loaded from elsewhere: no url(), @import or remote fonts.
  assert.doesNotMatch(css, /url\(|@import|https?:/);
  const js = await readFile(new URL('../server/public/usage-charts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /innerHTML|https?:\/\/(?!www\.w3\.org\/2000\/svg)|eval\(|new Function/);
  assert.deepEqual([...js.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]), ['./usage-format.js']);
});

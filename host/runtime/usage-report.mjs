// The usage report (GET /local/usage/report, /admin/api/usage/report): one time range of the
// usage ledger (usage-ledger.mjs) with totals, the same totals for the range before it, a trend
// per hour or day, breakdowns per model / provider / profile / scene (kind) / bot and the
// requests themselves, newest first, a page at a time or as CSV.
//
// Only what the ledger recorded is reported. Rows written before a field was recorded (agentId,
// durationMs, status) count as "not recorded": averages and rates use the rows that have the
// field, `recorded` says how many did, and a breakdown keeps them under the key NONE.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ledgerRows, localHours, shiftDate, USAGE_FIELDS } from './usage-ledger.mjs';

export const USAGE_RANGES = Object.freeze(['today', '7d', '30d', 'all', 'custom']);
export const USAGE_DIMENSIONS = Object.freeze(['model', 'provider', 'profile', 'kind', 'agent']);
/** The breakdown key (and filter value) of rows without the field. */
export const NONE = '(none)';
const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30 };
const MAX_CUSTOM_DAYS = 400, MAX_PAGE = 200, MAX_EXPORT = 100000, SERIES = 7;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;

export class UsageReportError extends Error {}
const fail = message => { throw new UsageReportError(message); };
const validDate = value => DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

/** The local date "YYYY-MM-DD" of `now` in `zone`. */
export function localDate(now, zone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * The range `id` ending today in local days, and the range of the same length just before it
 * (none for "all"). `first` is the oldest ledger date, used by "all". Hours for a single day,
 * days up to 92 days, months beyond.
 */
export function resolveRange(id = '7d', { today, from, to, first } = {}) {
  if (!USAGE_RANGES.includes(id)) fail('Invalid range');
  let start, end = today;
  if (RANGE_DAYS[id]) start = shiftDate(today, 1 - RANGE_DAYS[id]);
  else if (id === 'all') start = first && first < today ? first : today;
  else {
    if (!validDate(from ?? '') || !validDate(to ?? '')) fail('Invalid custom range');
    if (from > to) fail('The range starts after it ends');
    if (daysBetween(from, to) > MAX_CUSTOM_DAYS) fail(`The range is longer than ${MAX_CUSTOM_DAYS} days`);
    start = from; end = to;
  }
  const days = daysBetween(start, end);
  const unit = days === 1 ? 'hour' : days <= 92 ? 'day' : 'month';
  const previous = id === 'all' ? null : { from: shiftDate(start, -days), to: shiftDate(start, -1) };
  return { id, from: start, to: end, days, unit, previous };
}

// Every bucket key of a range: "2026-11-25T13" per hour, "2026-11-25" per day, "2026-11" per month.
function bucketKeys(range) {
  const keys = [];
  if (range.unit === 'hour') for (let hour = 0; hour < 24; hour++) keys.push(`${range.from}T${String(hour).padStart(2, '0')}`);
  else if (range.unit === 'day') for (let day = range.from; day <= range.to; day = shiftDate(day, 1)) keys.push(day);
  else {
    let [year, month] = range.from.split('-').map(Number);
    const last = range.to.slice(0, 7);
    for (let key = range.from.slice(0, 7); key <= last; key = `${year}-${String(month).padStart(2, '0')}`) {
      keys.push(key);
      if (++month > 12) { month = 1; year++; }
    }
  }
  return keys;
}
const bucketOf = (item, unit) => unit === 'hour' ? item.stamp : unit === 'day' ? item.date : item.date.slice(0, 7);

/** The ledger rows of local dates [from, to] in `zone`, each { row, date, stamp }, oldest first. */
export async function rangeRows(directory, zone, from, to) {
  const seen = new Set(), rows = [];
  // Every UTC day that can hold a row of a local day in [from, to], whatever the offset.
  for (let day = shiftDate(from, -1); day <= shiftDate(to, 1); day = shiftDate(day, 1)) {
    const entry = await ledgerRows(join(directory, day + '.jsonl'));
    if (!entry) continue;
    const stamps = localHours(entry, zone);
    entry.rows.forEach((row, index) => {
      const stamp = stamps[index], date = stamp.slice(0, 10);
      if (date < from || date > to || seen.has(row.id)) return;
      seen.add(row.id); rows.push({ row, date, stamp });
    });
  }
  return rows.sort((a, b) => a.row.atMs - b.row.atMs);
}

/** The oldest ledger file's UTC date, or null. */
export async function firstLedgerDate(directory) {
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const dates = names.map(name => name.slice(0, -6)).filter((name, index) => names[index].endsWith('.jsonl') && validDate(name)).sort();
  return dates[0] ?? null;
}

const counted = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const text = value => typeof value === 'string' && value ? value : undefined;
/** The value of a row for a dimension or filter; NONE when the row did not record it. */
export function dimensionKey(row, dimension) {
  const value = { model: row.model, provider: row.providerId, profile: row.profileId, kind: row.kind, agent: row.agentId }[dimension];
  return text(value) ?? NONE;
}

/**
 * Cost per row from `prices`: { [model]: { input, output, cached?, cacheWrite? } } in currency
 * units per million tokens (input without the cached part). null when the model has no price.
 */
export function rowCost(row, prices) {
  const price = prices?.[row.model];
  if (!price || !Number.isFinite(price.input) || !Number.isFinite(price.output)) return null;
  const cached = counted(row.cached), write = counted(row.cacheWrite), input = Math.max(0, counted(row.input) - cached - write);
  return (input * price.input + counted(row.output) * price.output + cached * (Number.isFinite(price.cached) ? price.cached : price.input)
    + write * (Number.isFinite(price.cacheWrite) ? price.cacheWrite : price.input)) / 1e6;
}

function emptyTotals() {
  return { requests: 0, ...Object.fromEntries(USAGE_FIELDS.map(key => [key, 0])), failed: 0, cancelled: 0,
    statusRecorded: 0, durationRecorded: 0, durationMs: 0, cost: 0, costRecorded: 0 };
}
function addRow(sum, row, prices) {
  sum.requests++;
  for (const key of USAGE_FIELDS) sum[key] += counted(row[key]);
  if (row.status) {
    sum.statusRecorded++;
    if (row.status === 'error') sum.failed++;
    else if (row.status === 'cancelled') sum.cancelled++;
  }
  if (Number.isFinite(row.durationMs)) { sum.durationRecorded++; sum.durationMs += row.durationMs; }
  const cost = prices ? rowCost(row, prices) : null;
  if (cost !== null) { sum.cost += cost; sum.costRecorded++; }
  return sum;
}
// Totals with the derived values: null whenever nothing in the range recorded them.
function finish(sum, priced) {
  const { durationMs, cost, costRecorded, ...rest } = sum;
  return { ...rest,
    avgDurationMs: sum.durationRecorded ? Math.round(durationMs / sum.durationRecorded) : null,
    failureRate: sum.statusRecorded ? sum.failed / sum.statusRecorded : null,
    cacheHitRate: sum.input ? sum.cached / sum.input : null,
    cost: priced && costRecorded ? Math.round(cost * 1e6) / 1e6 : null, costRecorded: priced ? costRecorded : 0 };
}
export function totalsOf(rows, prices) {
  const sum = emptyTotals();
  for (const row of rows) addRow(sum, row, prices);
  return finish(sum, Boolean(prices));
}

const CHANGE_KEYS = ['requests', 'total', 'input', 'output', 'cached', 'reasoning', 'cost', 'avgDurationMs', 'failureRate'];
/**
 * The change from `previous` to `current` per key: (current - previous) / previous, or null when
 * either side did not record the value or the previous one was 0.
 */
export function usageChanges(current, previous) {
  if (!previous) return null;
  return Object.fromEntries(CHANGE_KEYS.map(key => {
    const now = current[key], before = previous[key];
    return [key, typeof now === 'number' && typeof before === 'number' && before > 0 ? (now - before) / before : null];
  }));
}

/** The breakdown per dimension, largest total first; `share` is the part of all tokens. */
export function breakdown(rows, dimension, { prices, labels } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = dimensionKey(row, dimension);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const all = rows.reduce((sum, row) => sum + counted(row.total), 0);
  return [...groups].map(([key, items]) => {
    const totals = totalsOf(items, prices), label = key === NONE ? null : labels?.(key) ?? key;
    return { key, label, ...totals, share: all ? totals.total / all : 0 };
  }).sort((a, b) => b.total - a.total || b.requests - a.requests || String(a.label ?? '￿').localeCompare(String(b.label ?? '￿')));
}

function normalizeFilters(filters = {}) {
  const kept = {};
  for (const key of [...USAGE_DIMENSIONS, 'status']) {
    const value = filters[key];
    if (typeof value === 'string' && value) kept[key] = value.slice(0, 300);
  }
  return kept;
}
function matches(row, filters) {
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'status') { if ((row.status ?? NONE) !== value) return false; }
    else if (dimensionKey(row, key) !== value) return false;
  }
  return true;
}

function labelsFrom(names = {}) {
  const get = (map, key) => map instanceof Map ? map.get(key) : map?.[key];
  const name = value => typeof value === 'string' ? value : value?.name;
  return {
    model: key => key,
    provider: key => name(get(names.providers, key)) ?? key,
    profile: key => name(get(names.profiles, key)) ?? key,
    kind: key => key,
    agent: key => name(get(names.agents, key)) ?? key,
  };
}

/** One request of the details list. Missing fields are null ("not recorded"). */
function requestItem(row, labels, prices) {
  const value = (dimension, key) => key ? labels[dimension](key) : null;
  return { id: row.id, at: new Date(row.atMs).toISOString(), kind: row.kind ?? null, model: text(row.model) ?? null,
    agentId: row.agentId ?? null, agent: value('agent', row.agentId),
    profileId: row.profileId ?? null, profile: value('profile', row.profileId),
    providerId: row.providerId ?? null, provider: value('provider', row.providerId), effort: row.effort ?? null,
    ...Object.fromEntries(USAGE_FIELDS.map(key => [key, counted(row[key])])),
    durationMs: Number.isFinite(row.durationMs) ? row.durationMs : null, status: row.status ?? null, error: row.error ?? null,
    cost: prices ? rowCost(row, prices) : null, requestId: row.requestId ?? null };
}

/**
 * The report. `range`: today | 7d | 30d | all | custom (with `from` and `to`, local dates).
 * `filters` ({ model, provider, profile, kind, agent, status }, NONE for "not recorded") apply
 * to everything but `options`, which lists every value of the unfiltered range.
 * `names`: { agents, profiles, providers } as Maps or objects of id → name (or { name }).
 * `prices`: see rowCost(); without prices every cost is null.
 */
async function collect(directory, { timeZone = 'UTC', now = new Date(), range: id = '7d', from, to, filters, names, prices } = {}) {
  const zone = new Intl.DateTimeFormat('en-CA', { timeZone }).resolvedOptions().timeZone;
  const today = localDate(now, zone);
  const first = id === 'all' ? await firstLedgerDate(directory) : null;
  const range = resolveRange(id, { today, from, to, first });
  const applied = normalizeFilters(filters), labels = labelsFrom(names), priced = prices && Object.keys(prices).length ? prices : null;
  const all = await rangeRows(directory, zone, range.from, range.to);
  const items = all.filter(item => matches(item.row, applied));
  return { zone, today, range, applied, labels, priced, all, items, rows: items.map(item => item.row) };
}

export async function usageReport(directory, request = {}) {
  const { now = new Date(), offset = 0, limit = 50 } = request;
  const { zone, today, range, applied, labels, priced, all, items, rows } = await collect(directory, request);
  const totals = totalsOf(rows, priced);
  let previousTotals = null;
  if (range.previous) {
    const before = (await rangeRows(directory, zone, range.previous.from, range.previous.to)).map(item => item.row).filter(row => matches(row, applied));
    previousTotals = totalsOf(before, priced);
  }
  // Trend: every bucket of the range, also the empty ones, with tokens per model for the stacks.
  const byModel = breakdown(rows, 'model', { prices: priced, labels: labels.model });
  const series = byModel.filter(item => item.total > 0).slice(0, SERIES).map(item => item.key);
  const groups = new Map(bucketKeys(range).map(key => [key, []]));
  for (const item of items) groups.get(bucketOf(item, range.unit))?.push(item.row);
  const buckets = [...groups].map(([start, list]) => {
    const sum = totalsOf(list, priced), models = new Map();
    for (const row of list) {
      const key = dimensionKey(row, 'model');
      models.set(key, (models.get(key) ?? 0) + counted(row.total));
    }
    return { start, requests: sum.requests, total: sum.total, input: sum.input, output: sum.output, cached: sum.cached,
      cacheWrite: sum.cacheWrite, reasoning: sum.reasoning, failed: sum.failed, avgDurationMs: sum.avgDurationMs, cost: sum.cost,
      models: [...models].map(([model, total]) => ({ model, total })).sort((a, b) => b.total - a.total) };
  });
  const dimensions = Object.fromEntries(USAGE_DIMENSIONS.map(dimension => [dimension,
    dimension === 'model' ? byModel : breakdown(rows, dimension, { prices: priced, labels: labels[dimension] })]));
  // Filter choices come from the whole range, so a filter never hides its own alternatives.
  const allRows = all.map(item => item.row);
  const options = Object.fromEntries(USAGE_DIMENSIONS.map(dimension => [dimension,
    breakdown(allRows, dimension, { labels: labels[dimension] }).map(item => ({ key: item.key, label: item.label, requests: item.requests }))]));
  const statuses = new Map();
  for (const row of allRows) statuses.set(row.status ?? NONE, (statuses.get(row.status ?? NONE) ?? 0) + 1);
  options.status = [...statuses].map(([key, requests]) => ({ key, label: key === NONE ? null : key, requests })).sort((a, b) => b.requests - a.requests);
  const recorded = { rows: allRows.length, agent: 0, duration: 0, status: 0, profile: 0 };
  for (const row of allRows) {
    if (row.agentId) recorded.agent++;
    if (Number.isFinite(row.durationMs)) recorded.duration++;
    if (row.status) recorded.status++;
    if (row.profileId) recorded.profile++;
  }
  const size = Math.max(1, Math.min(MAX_PAGE, Number.isSafeInteger(Number(limit)) ? Number(limit) : 50));
  const start = Math.max(0, Number.isSafeInteger(Number(offset)) ? Number(offset) : 0);
  const newest = rows.slice().reverse();
  return {
    version: 2, timeZone: zone, generatedAt: now.toISOString(), today,
    range: { id: range.id, from: range.from, to: range.to, days: range.days, unit: range.unit },
    previous: range.previous, filters: applied, priced: Boolean(priced),
    currency: priced && typeof priced.currency === 'string' && /^[A-Z]{3}$/.test(priced.currency) ? priced.currency : null,
    totals, previousTotals, changes: usageChanges(totals, previousTotals),
    series, buckets, dimensions, options, recorded,
    requests: { total: newest.length, offset: start, limit: size, items: newest.slice(start, start + size).map(row => requestItem(row, labels, priced)) },
  };
}

// ---------------------------------------------------------------------------------------- CSV

const KIND_LABELS = { chat: '对话', suggestions: '输入建议', completion: '输入补全', autocomplete: '输入补全', test: '测试', title: '标题',
  summary: '摘要', memory: '记忆', subagent: '子任务', automation: '自动化', classifier: '路由判断', review: '自动审查' };
const STATUS_LABELS = { ok: '成功', error: '失败', cancelled: '已取消' };
const MISSING = '未记录';
/** One CSV cell: quoted when needed; text that a spreadsheet would run as a formula is prefixed with '. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let cell = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
const localStamp = (iso, zone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

/** The requests as CSV (UTF-8 with BOM for spreadsheets), local times in `zone`. */
export function usageCsv(items, zone = 'UTC', { priced = false } = {}) {
  const heads = ['时间', 'Bot', '场景', '模型', '服务商', '配置', '输入 Token', '缓存命中 Token', '缓存写入 Token', '输出 Token', '推理 Token',
    '合计 Token', ...(priced ? ['花费'] : []), '耗时（毫秒）', '状态', '错误', '请求 ID'];
  const lines = [heads.map(csvCell).join(',')];
  for (const item of items) {
    lines.push([localStamp(item.at, zone), item.agent ?? MISSING, item.kind ? KIND_LABELS[item.kind] ?? item.kind : MISSING,
      item.model ?? MISSING, item.provider ?? MISSING, item.profile ?? MISSING, item.input, item.cached, item.cacheWrite, item.output,
      item.reasoning, item.total, ...(priced ? [item.cost === null ? MISSING : Number(item.cost.toFixed(6))] : []),
      item.durationMs ?? MISSING, item.status ? STATUS_LABELS[item.status] ?? item.status : MISSING, item.error ?? '', item.requestId ?? '']
      .map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Every filtered request of the range (newest first, at most 100,000) as { filename, csv, count }. */
export async function usageExport(directory, options = {}) {
  const { zone, range, labels, priced, rows } = await collect(directory, options);
  const items = rows.slice(-MAX_EXPORT).reverse().map(row => requestItem(row, labels, priced));
  return { filename: `rokbot-usage-${range.from}${range.from === range.to ? '' : `_${range.to}`}.csv`, count: items.length,
    csv: usageCsv(items, zone, { priced: Boolean(priced) }) };
}

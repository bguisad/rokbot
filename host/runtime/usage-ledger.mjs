import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function usageCounts(raw = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const cached = count(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens);
  const cacheCreationBreakdown = count(raw.cache_creation?.ephemeral_5m_input_tokens)
    + count(raw.cache_creation?.ephemeral_1h_input_tokens);
  const cacheWrite = Math.max(
    count(raw.cache_creation_input_tokens ?? raw.prompt_tokens_details?.cache_creation_tokens
      ?? raw.prompt_tokens_details?.cache_write_tokens ?? raw.input_tokens_details?.cache_write_tokens),
    cacheCreationBreakdown,
  );
  const rawAnthropicInput = raw.prompt_tokens === undefined && raw.input_tokens !== undefined
    && (raw.cache_read_input_tokens !== undefined || raw.cache_creation_input_tokens !== undefined || raw.cache_creation !== undefined);
  const input = rawAnthropicInput ? count(raw.input_tokens) + cached + cacheWrite : count(raw.prompt_tokens ?? raw.input_tokens);
  const output = count(raw.completion_tokens ?? raw.output_tokens);
  return { input, output, total: count(raw.total_tokens ?? input + output),
    cached, cacheWrite,
    reasoning: count(raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.thinking_tokens) };
}
// Optional request details (every field may be missing in older rows, shown as "not recorded"):
// agentId (the bot), durationMs (request start to the end of the response), status ("ok",
// "error" or "cancelled") and error (a short code such as "HTTP 429", never a message).
export const USAGE_STATUSES = Object.freeze(['ok', 'error', 'cancelled']);
const shortText = (value, limit = 200) => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;
export async function recordUsage(directory, { raw, model, kind = 'chat', effort, requestId, profileId, providerId, agentId,
  durationMs, status, error, at = new Date() }) {
  const known = USAGE_STATUSES.includes(status) ? status : undefined;
  // A failed or cancelled request is kept without token counts; a finished one needs them.
  if (!directory || ((!raw || !Object.keys(raw).length) && (!known || known === 'ok'))) return;
  const timestamp = at.toISOString();
  const agent = shortText(agentId), code = known === 'error' ? shortText(error, 80) : undefined;
  const entry = { id: randomUUID(), at: timestamp, model, kind, effort, requestId,
    ...(profileId ? { profileId } : {}), ...(providerId ? { providerId } : {}), ...(agent ? { agentId: agent } : {}),
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs: Math.round(durationMs) } : {}),
    ...(known ? { status: known } : {}), ...(code ? { error: code } : {}), ...usageCounts(raw ?? {}) };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Each process appends one short JSON line; no read/modify/write race with the admin server.
  await appendFile(join(directory, timestamp.slice(0, 10) + '.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

// Summed per row. `cached` is the part of `input` read from the provider's prompt cache and
// `cacheWrite` the part written to it; both are already inside `input` and `total`.
export const USAGE_FIELDS = Object.freeze(['input', 'output', 'total', 'cached', 'cacheWrite', 'reasoning']);
// Periods end today in the requested time zone and count whole local days.
export const USAGE_PERIODS = Object.freeze([
  Object.freeze({ id: 'today', days: 1 }), Object.freeze({ id: '7d', days: 7 }), Object.freeze({ id: '30d', days: 30 }),
]);
const DAY = 86400000;

// Ledger files are one UTC day each. Past days no longer change, so a file is parsed again only
// when its size or modification time does; the local date of each row is kept per time zone.
const files = new Map();
// Text fields kept per row for the report (usage-report.mjs) besides the counts.
const DETAIL_FIELDS = ['kind', 'effort', 'requestId', 'profileId', 'providerId', 'agentId', 'status', 'error'];
export async function ledgerRows(path) {
  const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) { files.delete(path); return null; }
  const key = `${info.size}:${info.mtimeMs}`, cached = files.get(path);
  if (cached?.key === key) return cached;
  const rows = [];
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row?.at);
    if (!row?.id || !Number.isFinite(at)) continue;
    const kept = { id: row.id, model: row.model, atMs: at };
    for (const field of USAGE_FIELDS) kept[field] = row[field];
    for (const field of DETAIL_FIELDS) if (typeof row[field] === 'string' && row[field]) kept[field] = row[field];
    if (Number.isFinite(row.durationMs) && row.durationMs >= 0) kept.durationMs = row.durationMs;
    rows.push(kept);
  }
  const entry = { key, rows, dates: new Map() };
  files.set(path, entry);
  return entry;
}
/** Forget the parsed files of `directory` older than the UTC day `oldest`. */
export function forgetLedgerBefore(directory, oldest) {
  for (const path of files.keys()) {
    const name = path.slice(-16, -6);
    if (path.startsWith(join(directory, '/')) && name < oldest) files.delete(path);
  }
}
// The local date and hour of each row, "2026-11-25T13", per time zone.
export function localHours(entry, zone) {
  let stamps = entry.dates.get(zone);
  if (!stamps) {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    // Every zone offset is a multiple of 15 minutes: format each quarter hour once, not each row.
    const quarters = new Map();
    stamps = entry.rows.map(row => {
      const quarter = Math.floor(row.atMs / 900000);
      if (!quarters.has(quarter)) {
        const parts = Object.fromEntries(format.formatToParts(new Date(quarter * 900000)).map(part => [part.type, part.value]));
        quarters.set(quarter, `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}`);
      }
      return quarters.get(quarter);
    });
    entry.dates.set(zone, stamps);
  }
  return stamps;
}
export const shiftDate = (date, days) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
const empty = () => Object.fromEntries([...USAGE_FIELDS, 'requests'].map(key => [key, 0]));
function add(sum, row) {
  for (const key of USAGE_FIELDS) sum[key] += Number.isSafeInteger(row[key]) && row[key] > 0 ? row[key] : 0;
  sum.requests++;
  return sum;
}
function summarize(rows) {
  const all = empty(), models = new Map();
  for (const row of rows) {
    add(all, row);
    const model = typeof row.model === 'string' && row.model ? row.model : 'unknown';
    add(models.get(model) ?? models.set(model, { model, ...empty() }).get(model), row);
  }
  return { ...all, models: [...models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model)) };
}

// Each period is split into buckets for a chart: hours for today, local days otherwise.
// Every bucket is listed, also the empty ones, with the same totals and models as a period.
function buckets(items, period, today) {
  const hourly = period.days === 1, keys = [];
  if (hourly) for (let hour = 0; hour < 24; hour++) keys.push(`${today}T${String(hour).padStart(2, '0')}`);
  else for (let day = 1 - period.days; day <= 0; day++) keys.push(shiftDate(today, day));
  const groups = new Map(keys.map(key => [key, []]));
  for (const item of items) groups.get(hourly ? item.stamp : item.date)?.push(item.row);
  return { unit: hourly ? 'hour' : 'day', buckets: keys.map(start => ({ start, ...summarize(groups.get(start)) })) };
}

/**
 * Today's totals in `timeZone` (the original response fields) plus `periods`: today, the last 7
 * and the last 30 local days, each with the same totals, a per-model breakdown and `buckets`
 * (per hour for today, per day otherwise). `period` keeps only that period in `periods`.
 */
export async function usageSummary(directory, timeZone = 'UTC', now = new Date(), { period: only } = {}) {
  const zone = new Intl.DateTimeFormat('en-CA', { timeZone }).resolvedOptions().timeZone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const longest = Math.max(...USAGE_PERIODS.map(period => period.days));
  const first = shiftDate(today, 1 - longest), seen = new Set(), rows = [];
  // Every UTC day that can hold a row of a local day in [first, today], whatever the offset.
  for (let day = shiftDate(first, -1); day <= shiftDate(today, 1); day = shiftDate(day, 1)) {
    const entry = await ledgerRows(join(directory, day + '.jsonl'));
    if (!entry) continue;
    const stamps = localHours(entry, zone);
    entry.rows.forEach((row, index) => {
      const stamp = stamps[index], date = stamp.slice(0, 10);
      if (date < first || date > today || seen.has(row.id)) return;
      seen.add(row.id); rows.push({ row, date, stamp });
    });
  }
  // Drop cached files that have aged out of every period.
  forgetLedgerBefore(directory, shiftDate(first, -1));
  const periods = USAGE_PERIODS.map(period => {
    const from = shiftDate(today, 1 - period.days), items = rows.filter(item => item.date >= from);
    return { id: period.id, days: period.days, from, to: today, ...summarize(items.map(item => item.row)), ...buckets(items, period, today) };
  });
  const { id, days, from, to, unit, buckets: _, ...current } = periods[0];
  return { date: today, timeZone, ...current, periods: only ? periods.filter(period => period.id === only) : periods };
}

/** The original name: today's usage, now with `periods` as well. */
export const todayUsage = usageSummary;

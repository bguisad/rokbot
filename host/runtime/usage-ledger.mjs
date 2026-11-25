import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function usageCounts(raw = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const input = count(raw.prompt_tokens ?? raw.input_tokens);
  const output = count(raw.completion_tokens ?? raw.output_tokens);
  return { input, output, total: count(raw.total_tokens ?? input + output),
    cached: count(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens),
    cacheWrite: count(raw.cache_creation_input_tokens),
    reasoning: count(raw.completion_tokens_details?.reasoning_tokens) };
}
export async function recordUsage(directory, { raw, model, kind = 'chat', effort, requestId, profileId, providerId, at = new Date() }) {
  if (!directory || !raw || !Object.keys(raw).length) return;
  const timestamp = at.toISOString();
  const entry = { id: randomUUID(), at: timestamp, model, kind, effort, requestId,
    ...(profileId ? { profileId } : {}), ...(providerId ? { providerId } : {}), ...usageCounts(raw) };
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
async function ledgerRows(path) {
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
    rows.push(kept);
  }
  const entry = { key, rows, dates: new Map() };
  files.set(path, entry);
  return entry;
}
function localDates(entry, format) {
  const zone = format.resolvedOptions().timeZone;
  let dates = entry.dates.get(zone);
  if (!dates) {
    // Rows of one file share at most two local dates; format each hour once, not each row.
    const hours = new Map();
    dates = entry.rows.map(row => {
      const hour = Math.floor(row.atMs / 900000); // 15 minutes: every zone offset is a multiple
      if (!hours.has(hour)) hours.set(hour, format.format(new Date(hour * 900000)));
      return hours.get(hour);
    });
    entry.dates.set(zone, dates);
  }
  return dates;
}
const shiftDate = (date, days) => {
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

/**
 * Today's totals in `timeZone` (the original response fields) plus `periods`: today, the last 7
 * and the last 30 local days, each with the same totals and a per-model breakdown.
 */
export async function usageSummary(directory, timeZone = 'UTC', now = new Date()) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = format.format(now), longest = Math.max(...USAGE_PERIODS.map(period => period.days));
  const first = shiftDate(today, 1 - longest), seen = new Set(), rows = [];
  // Every UTC day that can hold a row of a local day in [first, today], whatever the offset.
  for (let day = shiftDate(first, -1); day <= shiftDate(today, 1); day = shiftDate(day, 1)) {
    const entry = await ledgerRows(join(directory, day + '.jsonl'));
    if (!entry) continue;
    const dates = localDates(entry, format);
    entry.rows.forEach((row, index) => {
      const date = dates[index];
      if (date < first || date > today || seen.has(row.id)) return;
      seen.add(row.id); rows.push({ row, date });
    });
  }
  // Drop cached files that have aged out of every period.
  for (const path of files.keys()) {
    const name = path.slice(-16, -6);
    if (path.startsWith(join(directory, '/')) && name < shiftDate(first, -1)) files.delete(path);
  }
  const periods = USAGE_PERIODS.map(({ id, days }) => {
    const from = shiftDate(today, 1 - days);
    return { id, days, from, to: today, ...summarize(rows.filter(item => item.date >= from).map(item => item.row)) };
  });
  const { id, days, from, to, ...current } = periods[0];
  return { date: today, timeZone, ...current, periods };
}

/** The original name: today's usage, now with `periods` as well. */
export const todayUsage = usageSummary;

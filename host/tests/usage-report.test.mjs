import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordUsage } from '../runtime/usage-ledger.mjs';
import { breakdown, csvCell, NONE, resolveRange, rowCost, usageChanges, usageCsv, usageExport, usageReport } from '../runtime/usage-report.mjs';

const row = (id, at, extra = {}) => {
  const input = extra.input ?? 100, output = extra.output ?? 10;
  return JSON.stringify({ id, at, model: 'm1', kind: 'chat', input, output, total: input + output, cached: 0, cacheWrite: 0, reasoning: 0, ...extra }) + '\n';
};
async function ledger(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'rokbot-usage-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [day, lines] of Object.entries(files)) await writeFile(join(directory, `${day}.jsonl`), lines.join(''));
  return directory;
}
const NOW = new Date('2026-11-25T08:00:00Z'); // 16:00 in Shanghai

test('resolveRange: fixed ranges end today, custom ranges are validated, the previous range has the same length', () => {
  assert.deepEqual(resolveRange('today', { today: '2026-11-25' }),
    { id: 'today', from: '2026-11-25', to: '2026-11-25', days: 1, unit: 'hour', previous: { from: '2026-11-24', to: '2026-11-24' } });
  assert.deepEqual(resolveRange('7d', { today: '2026-11-25' }),
    { id: '7d', from: '2026-11-19', to: '2026-11-25', days: 7, unit: 'day', previous: { from: '2026-11-12', to: '2026-11-18' } });
  assert.equal(resolveRange('30d', { today: '2026-03-01' }).from, '2026-01-31');
  assert.deepEqual(resolveRange('all', { today: '2026-11-25', first: '2026-01-01' }),
    { id: 'all', from: '2026-01-01', to: '2026-11-25', days: 329, unit: 'month', previous: null });
  assert.equal(resolveRange('all', { today: '2026-11-25', first: null }).from, '2026-11-25');
  assert.deepEqual(resolveRange('custom', { today: '2026-11-25', from: '2026-02-27', to: '2026-03-02' }),
    { id: 'custom', from: '2026-02-27', to: '2026-03-02', days: 4, unit: 'day', previous: { from: '2026-02-23', to: '2026-02-26' } });
  assert.equal(resolveRange('custom', { today: '2026-11-25', from: '2026-11-01', to: '2026-11-01' }).unit, 'hour');
  for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-03-02', '2026-03-01'], ['2024-01-01', '2026-01-01'], ['x', '2026-01-01']])
    assert.throws(() => resolveRange('custom', { today: '2026-11-25', from, to }), /range/i);
  assert.throws(() => resolveRange('90d', { today: '2026-11-25' }), /Invalid range/);
});

test('usageReport: totals, the previous range and changes; latency and failures only from rows that recorded them', async t => {
  const directory = await ledger(t, {
    '2026-11-25': [
      row('a', '2026-11-25T01:00:00Z', { agentId: 'bot-1', durationMs: 1000, status: 'ok', cached: 40, reasoning: 4, profileId: 'p1', providerId: 'v1' }),
      row('b', '2026-11-25T02:00:00Z', { agentId: 'bot-2', durationMs: 3000, status: 'error', error: 'HTTP 429', input: 0, output: 0, model: 'm2', kind: 'suggestions' }),
      // An old row: no agent, duration or status.
      row('c', '2026-11-25T03:00:00Z', { input: 200, output: 20 }),
    ],
    '2026-11-24': [row('d', '2026-11-24T05:00:00Z', { durationMs: 500, status: 'ok' })],
    '2026-11-18': [row('e', '2026-11-18T05:00:00Z', { input: 1000, output: 100, status: 'ok', durationMs: 4000 })],
  });
  const report = await usageReport(directory, { timeZone: 'Asia/Shanghai', now: NOW, range: '7d',
    names: { agents: new Map([['bot-1', '写作助手']]), profiles: { p1: { name: '日常' } }, providers: { v1: 'DeepSeek' } } });
  assert.deepEqual(report.range, { id: '7d', from: '2026-11-19', to: '2026-11-25', days: 7, unit: 'day' });
  assert.deepEqual(report.previous, { from: '2026-11-12', to: '2026-11-18' });
  const { totals } = report;
  assert.deepEqual({ requests: totals.requests, total: totals.total, failed: totals.failed, statusRecorded: totals.statusRecorded, durationRecorded: totals.durationRecorded },
    { requests: 4, total: 440, failed: 1, statusRecorded: 3, durationRecorded: 3 });
  assert.equal(totals.avgDurationMs, 1500);
  assert.equal(totals.failureRate, 1 / 3);
  assert.equal(totals.cacheHitRate, 40 / 400);
  assert.equal(totals.cost, null);
  assert.equal(report.previousTotals.total, 1100);
  assert.equal(report.changes.total, (440 - 1100) / 1100);
  assert.equal(report.changes.avgDurationMs, (1500 - 4000) / 4000);
  assert.equal(report.changes.cost, null);
  assert.deepEqual(report.recorded, { rows: 4, agent: 2, duration: 3, status: 3, profile: 1 });
  // Seven daily buckets, empty days included.
  assert.deepEqual(report.buckets.map(bucket => [bucket.start, bucket.total]),
    [['2026-11-19', 0], ['2026-11-20', 0], ['2026-11-21', 0], ['2026-11-22', 0], ['2026-11-23', 0], ['2026-11-24', 110], ['2026-11-25', 330]]);
  assert.deepEqual(report.buckets.at(-1).models, [{ model: 'm1', total: 330 }, { model: 'm2', total: 0 }]);
  // Breakdowns: names from `names`, rows without the field under NONE with no label.
  assert.deepEqual(report.dimensions.agent.map(item => [item.key, item.label, item.requests]), [[NONE, null, 2], ['bot-1', '写作助手', 1], ['bot-2', 'bot-2', 1]]);
  assert.deepEqual(report.dimensions.profile.map(item => [item.key, item.label]), [[NONE, null], ['p1', '日常']]);
  assert.deepEqual(report.dimensions.provider.map(item => [item.key, item.label]), [[NONE, null], ['v1', 'DeepSeek']]);
  assert.deepEqual(report.dimensions.kind.map(item => item.key), ['chat', 'suggestions']);
  assert.equal(report.dimensions.model[0].share, 1);
  assert.deepEqual(report.options.status.map(item => item.key).sort(), [NONE, 'error', 'ok'].sort());
  // Requests: newest first, missing fields are null.
  assert.deepEqual(report.requests.items.map(item => item.id), ['c', 'b', 'a', 'd']);
  assert.deepEqual({ agent: report.requests.items[0].agent, durationMs: report.requests.items[0].durationMs, status: report.requests.items[0].status },
    { agent: null, durationMs: null, status: null });
  assert.equal(report.requests.items[1].error, 'HTTP 429');
});

test('usageReport: filters apply to everything but the options; pages; hours for today', async t => {
  const lines = [];
  for (let index = 0; index < 30; index++) lines.push(row(`r${index}`, `2026-11-25T0${index % 8}:0${index % 6}:00Z`, { agentId: index % 3 ? 'bot-1' : 'bot-2', status: 'ok' }));
  const directory = await ledger(t, { '2026-11-25': lines });
  const report = await usageReport(directory, { timeZone: 'UTC', now: NOW, range: 'today', filters: { agent: 'bot-2', bogus: 'x' }, offset: 4, limit: 3 });
  assert.deepEqual(report.filters, { agent: 'bot-2' });
  assert.equal(report.totals.requests, 10);
  assert.equal(report.buckets.length, 24);
  assert.equal(report.buckets[0].start, '2026-11-25T00');
  assert.deepEqual(report.dimensions.agent.map(item => item.key), ['bot-2']);
  assert.deepEqual(report.options.agent.map(item => [item.key, item.requests]), [['bot-1', 20], ['bot-2', 10]]);
  assert.deepEqual({ total: report.requests.total, offset: report.requests.offset, count: report.requests.items.length }, { total: 10, offset: 4, count: 3 });
  const missing = await usageReport(directory, { timeZone: 'UTC', now: NOW, range: 'today', filters: { status: NONE } });
  assert.equal(missing.totals.requests, 0);
  const capped = await usageReport(directory, { timeZone: 'UTC', now: NOW, range: 'today', limit: 10000 });
  assert.equal(capped.requests.limit, 200);
});

test('usageReport: "all" starts at the oldest ledger file and has no comparison; custom ranges read their own days', async t => {
  const directory = await ledger(t, {
    '2026-01-15': [row('old', '2026-01-15T12:00:00Z')], '2026-11-25': [row('new', '2026-11-25T01:00:00Z')], 'notes.txt': ['x'],
  });
  const all = await usageReport(directory, { timeZone: 'UTC', now: NOW, range: 'all' });
  assert.deepEqual([all.range.from, all.range.unit, all.previous, all.changes, all.totals.requests], ['2026-01-15', 'month', null, null, 2]);
  assert.equal(all.buckets.length, 11);
  assert.equal(all.buckets[0].start, '2026-01');
  const custom = await usageReport(directory, { timeZone: 'UTC', now: NOW, range: 'custom', from: '2026-01-10', to: '2026-01-20' });
  assert.deepEqual([custom.totals.requests, custom.buckets.length, custom.previous], [1, 11, { from: '2025-12-30', to: '2026-01-09' }]);
  const empty = await usageReport(join(directory, 'missing'), { timeZone: 'UTC', now: NOW, range: 'all' });
  assert.equal(empty.totals.requests, 0);
});

test('costs come from prices per million tokens; changes are null without a previous value', () => {
  const prices = { m1: { input: 2, output: 8, cached: 0.5, cacheWrite: 2.5 } };
  assert.equal(rowCost({ model: 'm1', input: 1_000_000, cached: 400_000, cacheWrite: 100_000, output: 500_000 }, prices), 1 + 0.2 + 0.25 + 4);
  assert.equal(rowCost({ model: 'other', input: 1 }, prices), null);
  const items = breakdown([{ model: 'm1', input: 1_000_000, output: 0, total: 1_000_000 }, { model: 'x', input: 5, output: 0, total: 5 }], 'model', { prices });
  assert.deepEqual(items.map(item => [item.key, item.cost, item.costRecorded]), [['m1', 2, 1], ['x', null, 0]]);
  assert.deepEqual(usageChanges({ total: 5, requests: 2, avgDurationMs: null }, { total: 0, requests: 1, avgDurationMs: 10 }),
    { requests: 1, total: null, input: null, output: null, cached: null, reasoning: null, cost: null, avgDurationMs: null, failureRate: null });
  assert.equal(usageChanges({}, null), null);
});

test('CSV: Chinese headers, local times, "未记录" for missing fields, quoting and no formulas', async t => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(null), '');
  const csv = usageCsv([{ at: '2026-11-25T01:02:03Z', agent: '写作,助手', kind: 'suggestions', model: 'm1', provider: null, profile: null,
    input: 10, cached: 2, cacheWrite: 0, output: 3, reasoning: 0, total: 13, durationMs: null, status: 'error', error: 'HTTP 429', requestId: 'r1' }], 'Asia/Shanghai');
  const [head, line] = csv.slice(1).trim().split('\r\n');
  assert.ok(csv.startsWith('﻿'));
  assert.equal(head, '时间,Bot,场景,模型,服务商,配置,输入 Token,缓存命中 Token,缓存写入 Token,输出 Token,推理 Token,合计 Token,耗时（毫秒）,状态,错误,请求 ID');
  assert.equal(line, '2026-11-25 09:02:03,"写作,助手",输入建议,m1,未记录,未记录,10,2,0,3,0,13,未记录,失败,HTTP 429,r1');

  const directory = await ledger(t, { '2026-11-25': [row('a', '2026-11-25T01:00:00Z', { agentId: 'bot-1' }), row('b', '2026-11-25T02:00:00Z')] });
  const result = await usageExport(directory, { timeZone: 'UTC', now: NOW, range: 'today', filters: { agent: 'bot-1' }, names: { agents: { 'bot-1': '写作助手' } } });
  assert.equal(result.filename, 'rokbot-usage-2026-11-25.csv');
  assert.equal(result.count, 1);
  assert.match(result.csv, /写作助手/);
  const week = await usageExport(directory, { timeZone: 'UTC', now: NOW, range: '7d', prices: { m1: { input: 1, output: 1 } } });
  assert.equal(week.filename, 'rokbot-usage-2026-11-19_2026-11-25.csv');
  assert.match(week.csv.split('\r\n')[0], /,花费,/);
});

test('recordUsage keeps the bot, duration, status and a short error; failed requests without tokens are kept', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rokbot-usage-record-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const at = new Date('2026-11-25T01:00:00Z');
  await recordUsage(directory, { raw: { prompt_tokens: 5, completion_tokens: 1 }, model: 'm1', agentId: 'bot-1', durationMs: 1234.6, status: 'ok', error: 'ignored', at });
  await recordUsage(directory, { raw: {}, model: 'm1', status: 'error', error: 'HTTP 503', durationMs: 20, at });
  await recordUsage(directory, { raw: {}, model: 'm1', status: 'ok', at }); // nothing to count
  await recordUsage(directory, { raw: undefined, model: 'm1', status: 'bogus', at });
  const rows = (await readFile(join(directory, '2026-11-25.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.deepEqual({ agentId: rows[0].agentId, durationMs: rows[0].durationMs, status: rows[0].status, error: rows[0].error, total: rows[0].total },
    { agentId: 'bot-1', durationMs: 1235, status: 'ok', error: undefined, total: 6 });
  assert.deepEqual({ status: rows[1].status, error: rows[1].error, total: rows[1].total }, { status: 'error', error: 'HTTP 503', total: 0 });
});

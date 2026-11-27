import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bucketLabel, calendarWeeks, changeTone, dimensionLabel, formatChange, formatCost, formatDuration, formatPercent, formatSpan,
  kindLabel, NONE, seriesOf, sortUsageRows, tokenParts, usageQuery,
} from '../server/public/usage-dashboard.js';

test('durations, percentages, changes and costs', () => {
  assert.equal(formatDuration(null, 'zh-CN'), null);
  assert.equal(formatDuration(850, 'zh-CN'), '850 毫秒');
  assert.equal(formatDuration(4249, 'zh-CN'), '4.2 秒');
  assert.equal(formatDuration(12_400, 'zh-CN'), '12 秒');
  assert.equal(formatDuration(65_000, 'zh-CN'), '1 分 05 秒');
  assert.equal(formatDuration(65_000, 'en'), '1m 5s');
  assert.equal(formatPercent(0.0342, 'zh-CN'), '3.4%');
  assert.equal(formatPercent(0.62, 'zh-CN'), '62%');
  assert.equal(formatPercent(0.0000001, 'zh-CN'), '<0.1%');
  assert.equal(formatPercent(null, 'zh-CN'), null);
  assert.deepEqual(formatChange(0.123, 'zh-CN'), { text: '+12%', direction: 'up' });
  assert.deepEqual(formatChange(-0.047, 'zh-CN'), { text: '−4.7%', direction: 'down' });
  assert.deepEqual(formatChange(0.0001, 'zh-CN'), { text: '0%', direction: 'flat' });
  assert.deepEqual(formatChange(25, 'zh-CN'), { text: '+999+%', direction: 'up' });
  assert.equal(formatChange(null), null);
  assert.equal(changeTone('avgDurationMs', 'up'), 'bad');
  assert.equal(changeTone('failureRate', 'down'), 'good');
  assert.equal(changeTone('total', 'up'), 'neutral');
  assert.equal(formatCost(12.345, 'CNY', 'zh-CN'), '¥12.35');
  assert.equal(formatCost(0.00421, 'USD', 'en'), '$0.0042');
  assert.equal(formatCost(3, null, 'en'), '3.00');
  assert.equal(formatCost(null, 'USD', 'en'), null);
});

test('names: scenes, missing values and statuses', () => {
  assert.equal(kindLabel('suggestions', 'zh-CN'), '输入建议');
  assert.equal(kindLabel('completion', 'zh-CN'), '输入补全');
  assert.equal(kindLabel('title', 'en'), 'Titles');
  assert.equal(kindLabel('custom-kind', 'zh-CN'), 'custom-kind');
  assert.equal(kindLabel(null, 'zh-CN'), '未记录');
  assert.equal(dimensionLabel('agent', { key: NONE, label: null }, 'zh-CN'), '未记录');
  assert.equal(dimensionLabel('agent', { key: 'a', label: '写作助手' }, 'zh-CN'), '写作助手');
  assert.equal(dimensionLabel('kind', { key: 'chat', label: 'chat' }, 'zh-CN'), '对话');
  assert.equal(dimensionLabel('status', { key: 'error' }, 'zh-CN'), '失败');
});

test('sorting keeps rows without a value last in either direction', () => {
  const rows = [{ key: 'a', label: 'b', total: 5, avgDurationMs: null }, { key: 'b', label: 'a', total: 9, avgDurationMs: 300 },
    { key: NONE, label: null, total: 7, avgDurationMs: 100 }];
  assert.deepEqual(sortUsageRows(rows).map(row => row.key), ['b', NONE, 'a']);
  assert.deepEqual(sortUsageRows(rows, 'avgDurationMs', 'asc').map(row => row.key), [NONE, 'b', 'a']);
  assert.deepEqual(sortUsageRows(rows, 'avgDurationMs', 'desc').map(row => row.key), ['b', NONE, 'a']);
  assert.deepEqual(sortUsageRows(rows, 'name', 'asc').map(row => row.key), ['b', 'a', NONE]);
});

test('query strings, labels, token parts, series and the calendar', () => {
  assert.equal(usageQuery({ timeZone: 'Asia/Shanghai', range: 'custom', from: '2026-11-01', to: '2026-11-07', filters: { agent: 'a b', model: '' }, offset: 20 }),
    'timeZone=Asia%2FShanghai&range=custom&from=2026-11-01&to=2026-11-07&agent=a+b&offset=20&limit=20');
  assert.equal(usageQuery({ range: '7d', exportCsv: true }), 'range=7d&export=csv');
  assert.deepEqual(bucketLabel('2026-11-25T13', 'hour', 'zh-CN'), { axis: '13:00', title: '11月25日 13:00–14:00' });
  assert.deepEqual(bucketLabel('2026-11-25', 'day', 'zh-CN'), { axis: '11/25', title: '11月25日' });
  assert.deepEqual(bucketLabel('2026-03', 'month', 'zh-CN'), { axis: '3月', title: '2026年3月' });
  assert.equal(formatSpan('2025-12-30', '2026-01-02', 'zh-CN', '2026'), '2025年12月30日 – 1月2日');
  assert.equal(formatSpan('2026-11-25', '2026-11-25', 'en', '2026'), 'Nov 25');
  assert.deepEqual(tokenParts({ input: 100, cached: 60, output: 50, reasoning: 20 }).map(part => [part.key, part.value, part.share]),
    [['uncached', 40, 40 / 150], ['cached', 60, 60 / 150], ['output', 30, 30 / 150], ['reasoning', 20, 20 / 150]]);
  const series = seriesOf({ series: ['m1', 'm2'] });
  assert.deepEqual([series('m1'), series('m2'), series('m3')], [1, 2, 0]);
  const weeks = calendarWeeks(2026, 11); // 1 November 2026 is a Sunday
  assert.deepEqual(weeks[0], [null, null, null, null, null, null, '2026-11-01']);
  assert.equal(weeks.at(-1)[0], '2026-11-30');
  assert.ok(weeks.every(week => week.length === 7));
});

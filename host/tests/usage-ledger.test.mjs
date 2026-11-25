import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { anthropicUsage } from '../runtime/anthropic-messages.mjs';
import { recordUsage, todayUsage, usageCounts, usageSummary, USAGE_PERIODS } from '../runtime/usage-ledger.mjs';

const row = (id, at, model, input, output, extra = {}) =>
  JSON.stringify({ id, at, model, kind: 'chat', input, output, total: input + output, cached: 0, reasoning: 0, ...extra }) + '\n';

async function ledger(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'rokbot-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [day, lines] of Object.entries(files)) await writeFile(join(directory, `${day}.jsonl`), lines.join(''));
  return directory;
}

test('usageCounts keeps the cache write tokens that the Anthropic and Responses adapters report', () => {
  assert.deepEqual(usageCounts(anthropicUsage({ input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 5 })),
    { input: 1000, output: 5, total: 1005, cached: 900, cacheWrite: 90, reasoning: 0 });
  assert.deepEqual(usageCounts({ prompt_tokens: 7, completion_tokens: 3 }), { input: 7, output: 3, total: 10, cached: 0, cacheWrite: 0, reasoning: 0 });
});

test('usageSummary sums today, the last 7 and the last 30 local days in total and per model', async t => {
  const directory = await ledger(t, {
    // 16:30 UTC on 24 November is already 25 November in Shanghai.
    '2026-11-24': [row('a', '2026-11-24T16:30:00Z', 'claude-opus', 1000, 200, { cached: 800, cacheWrite: 100 }),
      row('b', '2026-11-24T10:00:00Z', 'deepseek-flash', 50000, 1000)],
    '2026-11-25': [row('c', '2026-11-25T01:00:00Z', 'claude-opus', 3000, 300, { cached: 2500, reasoning: 40 }),
      row('d', '2026-11-25T02:00:00Z', 'deepseek-flash', 10, 5),
      // A row seen twice (for example copied into the next day's file) counts once.
      row('c', '2026-11-25T01:00:00Z', 'claude-opus', 3000, 300, { cached: 2500, reasoning: 40 }),
      'not json\n', JSON.stringify({ id: 'x', at: 'never' }) + '\n'],
    '2026-11-19': [row('e', '2026-11-19T00:00:00Z', 'gpt-5', 7, 3)],
    '2026-11-18': [row('f', '2026-11-18T15:59:59Z', 'gpt-5', 100, 1)], // 18 Nov 23:59 Shanghai: outside 7 days
    '2026-10-26': [row('g', '2026-10-26T20:00:00Z', 'gpt-5', 1, 1)], // 27 Oct 04:00 Shanghai: the 30th day
    '2026-10-25': [row('h', '2026-10-25T12:00:00Z', 'gpt-5', 1, 1)], // too old for any period
  });
  const now = new Date('2026-11-25T08:00:00Z');
  const usage = await usageSummary(directory, 'Asia/Shanghai', now);
  assert.deepEqual(usage.periods.map(({ id, days, from, to }) => ({ id, days, from, to })), [
    { id: 'today', days: 1, from: '2026-11-25', to: '2026-11-25' },
    { id: '7d', days: 7, from: '2026-11-19', to: '2026-11-25' },
    { id: '30d', days: 30, from: '2026-10-27', to: '2026-11-25' },
  ]);
  assert.deepEqual(USAGE_PERIODS.map(period => period.id), ['today', '7d', '30d']);
  const [today, week, month] = usage.periods;
  // The original response: today's totals at the top level, with `models` per model.
  assert.equal(usage.date, '2026-11-25');
  assert.equal(usage.timeZone, 'Asia/Shanghai');
  for (const key of ['input', 'output', 'total', 'cached', 'cacheWrite', 'reasoning', 'requests']) assert.equal(usage[key], today[key], key);
  assert.deepEqual(usage.models, today.models);
  assert.deepEqual({ ...today, models: undefined }, { id: 'today', days: 1, from: '2026-11-25', to: '2026-11-25',
    input: 4010, output: 505, total: 4515, cached: 3300, cacheWrite: 100, reasoning: 40, requests: 3, models: undefined });
  // Models are ordered by their total, largest first.
  assert.deepEqual(today.models, [
    { model: 'claude-opus', input: 4000, output: 500, total: 4500, cached: 3300, cacheWrite: 100, reasoning: 40, requests: 2 },
    { model: 'deepseek-flash', input: 10, output: 5, total: 15, cached: 0, cacheWrite: 0, reasoning: 0, requests: 1 },
  ]);
  assert.deepEqual(week.models.map(item => [item.model, item.total, item.requests]), [['deepseek-flash', 51015, 2], ['claude-opus', 4500, 2], ['gpt-5', 10, 1]]);
  assert.deepEqual(month.models.map(item => [item.model, item.total, item.requests]), [['deepseek-flash', 51015, 2], ['claude-opus', 4500, 2], ['gpt-5', 113, 3]]);
  assert.equal(month.total, 51015 + 4500 + 113);
  // The same rows in UTC: row a is a 24 November row.
  const utc = await usageSummary(directory, 'UTC', now);
  assert.equal(utc.date, '2026-11-25');
  assert.deepEqual(utc.models.map(item => [item.model, item.total]), [['claude-opus', 3300], ['deepseek-flash', 15]]);
  assert.equal(todayUsage, usageSummary);
});

test('usageSummary reads appended rows, skips missing days and names rows without a model', async t => {
  const directory = await ledger(t, {});
  const now = new Date('2026-11-25T08:00:00Z');
  const empty = await usageSummary(directory, 'UTC', now);
  assert.deepEqual(empty.periods.map(period => [period.id, period.total, period.requests, period.models.length]), [['today', 0, 0, 0], ['7d', 0, 0, 0], ['30d', 0, 0, 0]]);
  assert.equal(empty.requests, 0);
  await recordUsage(directory, { raw: { prompt_tokens: 12000, completion_tokens: 345, prompt_tokens_details: { cached_tokens: 11000 } }, model: 'gpt-5', at: new Date('2026-11-25T07:00:00Z') });
  assert.deepEqual((await usageSummary(directory, 'UTC', now)).models.map(item => [item.model, item.input, item.output, item.cached, item.total]), [['gpt-5', 12000, 345, 11000, 12345]]);
  // A row appended after the first read is counted on the next one.
  await appendFile(join(directory, '2026-11-25.jsonl'), row('later', '2026-11-25T07:30:00Z', undefined, 5, 5));
  const later = await usageSummary(directory, 'UTC', now);
  assert.deepEqual(later.models.map(item => [item.model, item.total]), [['gpt-5', 12345], ['unknown', 10]]);
  assert.equal(later.requests, 2);
  const lines = (await readFile(join(directory, '2026-11-25.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].cacheWrite, 0);
});

// The routes run the whole Host service, which needs its dependencies: npm ci --prefix host/server.
const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));
test('GET /local/usage and /admin/api/usage return the periods per model and keep the original fields', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-usage-routes-'));
  const core = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('null'); });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl, internalToken: 'a'.repeat(40) });
  await host.start(0, '127.0.0.1');
  t.after(async () => { await host.close(); await new Promise(resolve => core.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const at = new Date(Date.now() - 60000).toISOString();
  await mkdir(join(dir, 'usage'), { recursive: true });
  await writeFile(join(dir, 'usage', at.slice(0, 10) + '.jsonl'), row('r1', at, 'gpt-5', 320000000, 0) + row('r2', at, 'claude-opus', 12000, 345, { cached: 9000 }));

  const adminToken = await host.auth.setup(host.auth.setupKey, 'demo-admin-password');
  const desktop = await host.auth.pair({ pairingKey: (await host.auth.createPairing()).pairingKey, deviceName: 'Demo Mac', platform: 'desktop' });
  const device = path => fetch(origin + path, { headers: { authorization: `Bearer ${desktop.token}` } });
  assert.equal((await fetch(origin + '/local/usage?timeZone=UTC')).status, 401);
  assert.equal((await device('/local/usage?timeZone=Not/AZone')).status, 400);
  const local = await (await device('/local/usage?timeZone=UTC')).json();
  const admin = await (await fetch(origin + '/admin/api/usage?timeZone=UTC', { headers: { cookie: `rokbot_admin=${adminToken}` } })).json();
  assert.deepEqual(admin, local);
  assert.equal(local.timeZone, 'UTC');
  assert.equal(local.total, 320012345);
  assert.equal(local.requests, 2);
  assert.deepEqual(local.models.map(item => [item.model, item.input, item.output, item.cached, item.total, item.requests]),
    [['gpt-5', 320000000, 0, 0, 320000000, 1], ['claude-opus', 12000, 345, 9000, 12345, 1]]);
  assert.deepEqual(local.periods.map(period => [period.id, period.total, period.models.length]), [['today', 320012345, 2], ['7d', 320012345, 2], ['30d', 320012345, 2]]);
});

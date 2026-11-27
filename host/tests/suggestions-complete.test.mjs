// POST /local/suggestions/complete: inline completion (ghost text) for the composer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SuggestionsService, SuggestionsSettings, parseCompletionResponse } from '../server/suggestions.mjs';
import { Models } from '../server/models.mjs';
import { createSelfHostServer } from '../server/index.mjs';

const sse = text => new Response(
  `data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-suggest', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

function modelFixture(scenarioRoutes = {}) {
  return {
    version: 1,
    providers: [
      { id: 'primary', name: 'Primary', apiFormat: 'openai', baseUrl: 'https://primary.example/v1', apiKey: 'key-primary' },
      { id: 'cheap', name: 'Cheap', apiFormat: 'openai', baseUrl: 'https://cheap.example/v1', apiKey: 'key-cheap' },
    ],
    profiles: [
      { id: 'main', name: 'Main', providerId: 'primary', model: 'gpt-main', efforts: ['none', 'low', 'medium'], contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 },
      { id: 'mini', name: 'Mini', providerId: 'cheap', model: 'gpt-suggest', efforts: ['none', 'low'], contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 },
    ],
    defaultRoute: { profileId: 'main', effort: 'default', fallbacks: [] },
    botRoutes: {},
    scenarioRoutes,
    migrateLegacyRouting: true,
  };
}

const HISTORY = [
  { id: 'u1', kind: 'user-message', text: 'Check the build please' },
  { id: 'a1', kind: 'send-message', text: 'The build passed and all 42 tests are green.' },
];

test('parseCompletionResponse keeps only a short suffix', () => {
  assert.equal(parseCompletionResponse(' the tests', 'Please run'), ' the tests');
  assert.equal(parseCompletionResponse('Please run the tests', 'Please run'), ' the tests', 'a repeated draft is removed');
  assert.equal(parseCompletionResponse('跑一下测试', '帮我'), '跑一下测试');
  assert.equal(parseCompletionResponse('"一下测试"\n解释：……', '帮我跑'), '一下测试', 'first line, no quotes');
  assert.equal(parseCompletionResponse('```\nnow\n```', 'Ship it'), 'now', 'fenced output; no space was given, so none is added');
  assert.equal(parseCompletionResponse('now', 'Ship it,'), ' now', 'after punctuation a word gets a space');
  assert.equal(parseCompletionResponse('   ', 'abc'), '');
  assert.equal(parseCompletionResponse('done \u{1F680}', 'abc'), '', 'emoji output is dropped');
  assert.ok([...parseCompletionResponse('x'.repeat(300), 'ab')].length <= 80);
});

test('SuggestionsService.complete: gating, scenario route, max tokens, cache, in-flight sharing and cancellation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-complete-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = new Models(dir);
  const settings = await new SuggestionsSettings(dir).load();
  const requests = [];
  let reply = ' the tests';
  let gate = null;
  const service = new SuggestionsService({
    models,
    settings,
    dataDir: dir,
    hostCall: async (_method, { id }) => ({ entries: id === 'empty' ? [] : HISTORY }),
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), body: JSON.parse(options.body), signal: options.signal });
      if (gate) await gate;
      options.signal?.throwIfAborted();
      return sse(reply);
    },
  });

  // No model configured: nothing, silently.
  assert.equal((await service.complete({ agentId: 'bot', text: 'Please run' })).source, 'model-unavailable');
  await models.save(modelFixture({ suggestions: { profileId: 'mini', effort: 'none' } }));

  // Too short, empty chat, switch off: no model call.
  assert.equal((await service.complete({ agentId: 'bot', text: ' P ' })).source, 'too-short');
  assert.equal((await service.complete({ agentId: 'empty', text: 'Please run' })).source, 'empty');
  await settings.updateSettings({ completionEnabled: false });
  const off = await service.complete({ agentId: 'bot', text: 'Please run' });
  assert.deepEqual([off.enabled, off.source, off.completion], [false, 'disabled', '']);
  assert.equal(requests.length, 0);
  // The completion switch is independent of the suggestions switches.
  await settings.updateSettings({ completionEnabled: true, enabled: false, aiEnabled: false });
  assert.equal(settings.current().completionEnabled, true);

  const first = await service.complete({ agentId: 'bot', text: 'Please run', locale: 'en-US' });
  assert.deepEqual([first.enabled, first.source, first.completion, first.cached], [true, 'model', ' the tests', false]);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /cheap\.example/, 'uses the "suggestions" scenario model');
  assert.equal(requests[0].body.model, 'gpt-suggest');
  assert.ok(requests[0].body.max_tokens <= 64 || requests[0].body.max_completion_tokens <= 64, 'max tokens is limited');
  assert.match(JSON.stringify(requests[0].body.messages), /Please run/);
  assert.match(JSON.stringify(requests[0].body.messages), /42 tests are green/, 'conversation context is sent');

  // Same draft: cached.
  const again = await service.complete({ agentId: 'bot', text: 'Please run' });
  assert.deepEqual([again.completion, again.cached], [' the tests', true]);
  assert.equal(requests.length, 1);

  // Concurrent identical requests share one model call.
  reply = ' all checks';
  const [a, b] = await Promise.all([
    service.complete({ agentId: 'bot', text: 'Please run' + ' now' }),
    service.complete({ agentId: 'bot', text: 'Please run' + ' now' }),
  ]);
  assert.equal(requests.length, 2);
  assert.equal(a.completion, ' all checks');
  assert.equal(b.cached, true);

  // Cancelling (the client went away) aborts the model call and is not cached.
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = service.complete({ agentId: 'bot', text: 'Deploy to', signal: controller.signal });
  while (requests.length < 3) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(requests[2].signal.aborted, true, 'the model request is aborted');
  release();
  gate = null;
  const cancelled = await pending;
  assert.deepEqual([cancelled.source, cancelled.completion], ['cancelled', '']);
  reply = ' staging';
  const retried = await service.complete({ agentId: 'bot', text: 'Deploy to' });
  assert.deepEqual([retried.source, retried.completion, retried.cached], ['model', ' staging', false]);
  assert.equal(requests.length, 4);
});

test('SuggestionsService.complete times out silently', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-complete-timeout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = new Models(dir);
  await models.save(modelFixture({ suggestions: { profileId: 'mini', effort: 'none' } }));
  const settings = await new SuggestionsSettings(dir).load();
  const service = new SuggestionsService({
    models,
    settings,
    completionTimeoutMs: 40,
    hostCall: async () => ({ entries: HISTORY }),
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason ?? new Error('aborted')), { once: true });
    }),
  });
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  const started = Date.now();
  const res = await service.complete({ agentId: 'bot', text: 'Please run' });
  assert.deepEqual([res.source, res.completion], ['model-error', '']);
  assert.ok(Date.now() - started < 2000);
});

test('HTTP /local/suggestions/complete: device auth, setting, gating and model call', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-complete-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let modelCalls = 0;
  const app = await createSelfHostServer({
    dataDir: dir,
    hostUrl: 'http://127.0.0.1:19999',
    modelAutoSync: false,
    suggestionsFetch: async () => { modelCalls += 1; return sse('跑一下测试'); },
  });
  await app.start(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (headers, body) => fetch(`${base}/local/suggestions/complete`, { method: 'POST', headers, body: JSON.stringify(body) });

  const unauth = await post({ 'content-type': 'application/json' }, { text: '帮我' });
  assert.equal(unauth.status, 401);
  const forged = await post({ 'content-type': 'application/json', authorization: 'Bearer nope' }, { text: '帮我' });
  assert.equal(forged.status, 401);

  await app.auth.setup(app.auth.setupKey, 'secret-admin-pass-123');
  const pairKey = await app.auth.createPairing();
  const device = await app.auth.pair({ pairingKey: pairKey.pairingKey, deviceName: 'Test Mac', platform: 'desktop' });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${device.token}` };
  await app.models.save(modelFixture({ suggestions: { profileId: 'mini', effort: 'none' } }));
  const recentMessages = [{ id: 'm1', role: 'assistant', text: '代码已经改好了。' }];

  const settings = await (await fetch(`${base}/local/suggestions/settings`, { headers })).json();
  assert.equal(settings.completionEnabled, true, 'on by default');

  const bad = await post(headers, { agentId: '../x', text: '帮我' });
  assert.equal(bad.status, 400);
  const short = await (await post(headers, { text: '帮', recentMessages })).json();
  assert.equal(short.source, 'too-short');
  const empty = await (await post(headers, { text: '帮我' })).json();
  assert.equal(empty.source, 'empty');
  assert.equal(modelCalls, 0);

  const ok = await (await post(headers, { agentId: 'bot_1', text: '帮我', locale: 'zh-CN', recentMessages })).json();
  assert.deepEqual([ok.enabled, ok.source, ok.text, ok.completion], [true, 'model', '帮我', '跑一下测试']);
  assert.equal(modelCalls, 1);
  const cached = await (await post(headers, { agentId: 'bot_1', text: '帮我', locale: 'zh-CN', recentMessages })).json();
  assert.equal(cached.cached, true);
  assert.equal(modelCalls, 1);

  const put = await fetch(`${base}/local/suggestions/settings`, { method: 'PUT', headers, body: JSON.stringify({ completionEnabled: false }) });
  const saved = await put.json();
  assert.deepEqual([saved.completionEnabled, saved.enabled, saved.aiEnabled], [false, true, true]);
  const off = await (await post(headers, { agentId: 'bot_1', text: '帮我写', recentMessages })).json();
  assert.deepEqual([off.enabled, off.source, off.completion], [false, 'disabled', '']);
  assert.equal(modelCalls, 1);
  const invalid = await fetch(`${base}/local/suggestions/settings`, { method: 'PUT', headers, body: JSON.stringify({ completionEnabled: 'yes' }) });
  assert.equal(invalid.status, 400);
});

test('the Web client listener routes /local/suggestions* to the device API (401 without a session, not 404)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-complete-web-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = await createSelfHostServer({ dataDir: dir, hostUrl: 'http://127.0.0.1:19999', modelAutoSync: false });
  await app.start(0, '127.0.0.1');
  t.after(() => app.close());
  const web = `http://127.0.0.1:${app.webServer.address().port}`;
  for (const [method, path] of [
    ['GET', '/local/suggestions/settings'], ['PUT', '/local/suggestions/settings'], ['POST', '/local/suggestions'],
    ['POST', '/local/suggestions/complete'], ['GET', '/local/suggestions/phrases'], ['POST', '/local/suggestions/phrases'],
    ['PUT', '/local/suggestions/phrases/reorder'], ['DELETE', '/local/suggestions/phrases/p_abc123'],
  ]) {
    const res = await fetch(`${web}${path}`, { method, headers: { 'content-type': 'application/json', origin: web }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  const unknown = await fetch(`${web}/local/suggestions/other`, { headers: { origin: web } });
  assert.equal(unknown.status, 404);
});

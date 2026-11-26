import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SuggestionsService,
  detectSuggestionLanguage,
  extractRecentMessages,
  parseSuggestionResponse,
  staticSuggestions,
} from '../server/suggestions.mjs';
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
      { id: 'main', name: 'Main', providerId: 'primary', model: 'gpt-main', efforts: ['low', 'medium'], contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 },
      { id: 'mini', name: 'Mini', providerId: 'cheap', model: 'gpt-suggest', efforts: ['none', 'low'], contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 },
    ],
    defaultRoute: { profileId: 'main', effort: 'medium', fallbacks: [] },
    botRoutes: {},
    scenarioRoutes,
    migrateLegacyRouting: true,
  };
}

test('helper parsers detect language, normalize transcript entries, and parse fenced/plain suggestions', () => {
  assert.equal(detectSuggestionLanguage('zh-CN', []), 'zh');
  assert.equal(detectSuggestionLanguage('en-US', []), 'en');
  assert.equal(detectSuggestionLanguage('en-US', [{ role: 'assistant', text: '这是中文回复，请查看下一步计划。' }]), 'zh');
  assert.equal(detectSuggestionLanguage('zh-CN', [{ role: 'assistant', text: 'Here is a detailed deployment summary for your server.' }]), 'en');

  const extracted = extractRecentMessages([
    { id: 'e1', kind: 'user-message', text: '你好' },
    { id: 'e2', kind: 'tool-call', text: 'ignored' },
    { id: 'e3', kind: 'send-message', message: { text: '已经完成部署' } },
  ]);
  assert.deepEqual(extracted, [
    { id: 'e1', role: 'user', text: '你好' },
    { id: 'e3', role: 'assistant', text: '已经完成部署' },
  ]);

  assert.deepEqual(
    parseSuggestionResponse('```json\n["查看日志", "运行健康检查", "查看日志", "回滚到上一版本"]\n```'),
    ['查看日志', '运行健康检查', '回滚到上一版本'],
  );
  assert.deepEqual(
    parseSuggestionResponse('1. Check logs\n2. Run tests\n3. Deploy now'),
    ['Check logs', 'Run tests', 'Deploy now'],
  );
});

test('SuggestionsService routes through scenarioRoutes.suggestions, caches results, deduplicates in-flight calls, and falls back gracefully', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-suggestions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = new Models(dir);

  // 1. Unconfigured model returns localized static presets without calling fetch.
  let fetchCalls = 0;
  const serviceUnconfigured = new SuggestionsService({
    models,
    dataDir: dir,
    hostCall: async () => ({ entries: [{ id: 'm1', kind: 'send-message', text: '部署已经完成。' }] }),
    fetchImpl: async () => { fetchCalls += 1; throw new Error('should not call model'); },
  });
  const unconfiguredRes = await serviceUnconfigured.generate({ agentId: 'bot-1', locale: 'zh-CN' });
  assert.equal(unconfiguredRes.source, 'fallback');
  assert.equal(unconfiguredRes.lang, 'zh');
  assert.deepEqual(unconfiguredRes.suggestions, staticSuggestions('zh', { hasHistory: true }));
  assert.equal(fetchCalls, 0);

  // 2. Empty conversation skips LLM call and returns starter presets immediately.
  await models.save(modelFixture({ suggestions: { profileId: 'mini', effort: 'none' } }));
  const requests = [];
  const serviceEmpty = new SuggestionsService({
    models,
    dataDir: dir,
    hostCall: async () => ({ entries: [] }),
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return sse('["a","b"]');
    },
  });
  const emptyRes = await serviceEmpty.generate({ agentId: 'bot-empty', locale: 'en-US' });
  assert.equal(emptyRes.source, 'fallback');
  assert.equal(requests.length, 0);
  assert.deepEqual(emptyRes.suggestions, staticSuggestions('en', { hasHistory: false }));

  // 3. Configured scenarioRoutes.suggestions uses the cheap model, deduplicates concurrent calls, and caches.
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  let startedFetch;
  const fetchStarted = new Promise(resolve => { startedFetch = resolve; });
  const service = new SuggestionsService({
    models,
    dataDir: dir,
    hostCall: async () => ({
      entries: [
        { id: 'u1', kind: 'user-message', text: '帮我检查构建状态' },
        { id: 'a1', kind: 'send-message', text: '构建已通过，全部 42 个测试都绿了。' },
      ],
    }),
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      startedFetch();
      await gate;
      return sse(JSON.stringify(['查看测试覆盖率', '帮我准备发布说明', '检查还有没有未提交改动']));
    },
  });

  const p1 = service.generate({ agentId: 'bot-1', locale: 'zh-CN' });
  await fetchStarted;
  const p2 = service.generate({ agentId: 'bot-1', locale: 'zh-CN' });
  releaseGate();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://cheap.example/v1/chat/completions');
  assert.equal(requests[0].body.model, 'gpt-suggest');
  assert.equal(requests[0].body.reasoning_effort, 'none');
  assert.equal(r1.source, 'model');
  assert.equal(r1.cached, false);
  assert.equal(r2.cached, true);
  assert.deepEqual(r1.suggestions, ['查看测试覆盖率', '帮我准备发布说明', '检查还有没有未提交改动']);

  // Subsequent call hits LRU cache without another model request.
  const r3 = await service.generate({ agentId: 'bot-1', locale: 'zh-CN' });
  assert.equal(r3.cached, true);
  assert.equal(requests.length, 1);

  // 4. Timeout / error falls back cleanly without throwing.
  const failingService = new SuggestionsService({
    models,
    dataDir: dir,
    timeoutMs: 30,
    hostCall: async () => ({ entries: [{ id: 'a2', kind: 'send-message', text: 'Done deploying.' }] }),
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  });
  const timedOut = await failingService.generate({ agentId: 'bot-2', locale: 'en-US' });
  assert.equal(timedOut.source, 'fallback');
  assert.equal(timedOut.lang, 'en');
  assert.ok(timedOut.suggestions.length >= 3);
});

test('POST /local/suggestions requires device auth, validates agentId, and returns suggestions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-suggestions-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = await createSelfHostServer({
    dataDir: dir,
    hostUrl: 'http://127.0.0.1:19999',
    modelAutoSync: false,
    suggestionsFetch: async () => sse(JSON.stringify(['继续优化性能', '补充单元测试', '查看变更摘要'])),
  });
  await app.start(0, '127.0.0.1');
  t.after(() => app.close());

  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;

  // Unauthenticated request rejected.
  const unauth = await fetch(`${base}/local/suggestions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);

  // Pair a device.
  await app.auth.setup(app.auth.setupKey, 'secret-admin-pass-123');
  const pairKey = await app.auth.createPairing();
  const device = await app.auth.pair({ pairingKey: pairKey.pairingKey, deviceName: 'Test Phone', platform: 'desktop' });

  // Invalid agentId rejected with 400.
  const badAgent = await fetch(`${base}/local/suggestions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${device.token}` },
    body: JSON.stringify({ agentId: '../bad' }),
  });
  assert.equal(badAgent.status, 400);

  // Configure model and send recentMessages.
  await app.models.save(modelFixture({ suggestions: { profileId: 'mini', effort: 'none' } }));
  const okRes = await fetch(`${base}/local/suggestions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${device.token}` },
    body: JSON.stringify({
      agentId: 'bot_123',
      locale: 'zh-CN',
      recentMessages: [{ id: 'm1', role: 'assistant', text: '功能已经实现完毕。' }],
    }),
  });
  assert.equal(okRes.status, 200);
  const body = await okRes.json();
  assert.equal(body.source, 'model');
  assert.deepEqual(body.suggestions, ['继续优化性能', '补充单元测试', '查看变更摘要']);
});

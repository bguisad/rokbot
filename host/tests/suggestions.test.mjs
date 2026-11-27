import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as suggestionsMod from '../server/suggestions.mjs';
import {
  SuggestionsService,
  SuggestionsSettings,
  detectSuggestionLanguage,
  extractRecentMessages,
  parseSuggestionResponse,
} from '../server/suggestions.mjs';
import { Models } from '../server/models.mjs';
import { createSelfHostServer } from '../server/index.mjs';

const sse = text => new Response(
  `data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-suggest', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

function modelFixture(scenarioRoutes = {}, defaultEffort = 'default') {
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
    defaultRoute: { profileId: 'main', effort: defaultEffort, fallbacks: [] },
    botRoutes: {},
    scenarioRoutes,
    migrateLegacyRouting: true,
  };
}

test('static preset exports are completely removed and helper parsers work properly', () => {
  assert.equal('STATIC_SUGGESTIONS' in suggestionsMod, false);
  assert.equal('staticSuggestions' in suggestionsMod, false);

  assert.equal(detectSuggestionLanguage('zh-CN', []), 'zh');
  assert.equal(detectSuggestionLanguage('en-US', []), 'en');
  assert.equal(detectSuggestionLanguage('en-US', [{ role: 'assistant', text: '这是中文回复，请查看下一步计划。' }]), 'zh');
  assert.equal(detectSuggestionLanguage('zh-CN', [{ role: 'assistant', text: 'Here is a detailed deployment summary for your server.' }]), 'en');

  const extracted = extractRecentMessages([
    { id: 'e1', kind: 'user-message', text: '你好' },
    { id: 'e2', kind: 'tool-call', text: 'ignored' },
    { id: 'e3', kind: 'send-message', message: { type: 'text', content: '已经完成部署' } },
    { id: 'e4', kind: 'message', role: 'user', content: '看看日志' },
  ]);
  assert.deepEqual(extracted, [
    { id: 'e1', role: 'user', text: '你好' },
    { id: 'e3', role: 'assistant', text: '已经完成部署' },
    { id: 'e4', role: 'user', text: '看看日志' },
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

test('SuggestionsSettings supports defaults, toggle updates, and quick phrases CRUD + reorder with persistence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-sug-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = await new SuggestionsSettings(dir).load();
  assert.deepEqual(store.current(), { enabled: true, aiEnabled: true, quickPhrases: [], updatedAt: null });

  const added1 = await store.addPhrase({ text: '  继续  ' });
  const added2 = await store.addPhrase({ text: '好的，开始吧' });
  const added3 = await store.addPhrase({ text: '总结一下' });
  assert.equal(added1.phrase.text, '继续');
  assert.deepEqual(added3.quickPhrases.map(p => p.text), ['继续', '好的，开始吧', '总结一下']);

  // Duplicate rejected
  await assert.rejects(() => store.addPhrase({ text: '继续' }), /已存在/);
  await assert.rejects(() => store.addPhrase({ text: '   ' }), /不能为空/);

  // Edit
  const edited = await store.updatePhrase(added2.phrase.id, { text: '好的，请开始' });
  assert.equal(edited.phrase.text, '好的，请开始');
  assert.deepEqual(edited.quickPhrases.map(p => p.text), ['继续', '好的，请开始', '总结一下']);

  // Reorder
  const reordered = await store.reorderPhrases({ ids: [added3.phrase.id, added1.phrase.id, added2.phrase.id] });
  assert.deepEqual(reordered.quickPhrases.map(p => p.text), ['总结一下', '继续', '好的，请开始']);

  // Invalid reorder rejected
  await assert.rejects(() => store.reorderPhrases({ ids: [added3.phrase.id] }), /数量不匹配/);

  // Delete
  const deleted = await store.deletePhrase(added1.phrase.id);
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.quickPhrases.map(p => p.text), ['总结一下', '好的，请开始']);

  // Toggle update & persistence across reload
  await store.updateSettings({ enabled: true, aiEnabled: false });
  const reloaded = await new SuggestionsSettings(dir).load();
  assert.equal(reloaded.current().enabled, true);
  assert.equal(reloaded.current().aiEnabled, false);
  assert.deepEqual(reloaded.current().quickPhrases.map(p => p.text), ['总结一下', '好的，请开始']);
});

test('SuggestionsService honors toggles, never falls back to static presets, optimizes default route latency, and merges phrases before AI', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-suggestions-v2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = new Models(dir);
  const settings = await new SuggestionsSettings(dir).load();

  // 1. Unconfigured model returns empty AI suggestions (zero static preset fallback!)
  let fetchCalls = 0;
  const serviceUnconfigured = new SuggestionsService({
    models,
    settings,
    dataDir: dir,
    hostCall: async () => ({ entries: [{ id: 'm1', kind: 'send-message', text: '部署已经完成。' }] }),
    fetchImpl: async () => { fetchCalls += 1; throw new Error('should not call model'); },
  });
  const unconfiguredRes = await serviceUnconfigured.generate({ agentId: 'bot-1', locale: 'zh-CN' });
  assert.equal(unconfiguredRes.source, 'model-unavailable');
  assert.deepEqual(unconfiguredRes.suggestions, []);
  assert.deepEqual(unconfiguredRes.aiSuggestions, []);
  assert.deepEqual(unconfiguredRes.items, []);
  assert.equal(fetchCalls, 0);

  // 2. Empty conversation skips LLM call and returns NO presets when quick phrases are empty
  await models.save(modelFixture({ suggestions: { profileId: 'mini', effort: 'none' } }));
  const requests = [];
  const serviceEmpty = new SuggestionsService({
    models,
    settings,
    dataDir: dir,
    hostCall: async () => ({ entries: [] }),
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return sse('["a","b"]');
    },
  });
  const emptyNone = await serviceEmpty.generate({ agentId: 'bot-empty', locale: 'zh-CN' });
  assert.equal(emptyNone.source, 'empty');
  assert.deepEqual(emptyNone.suggestions, []);
  assert.deepEqual(emptyNone.items, []);
  assert.equal(requests.length, 0);

  // Empty conversation WITH custom quick phrases returns ONLY custom phrases
  await settings.addPhrase({ text: '继续' });
  await settings.addPhrase({ text: '总结一下' });
  const emptyWithPhrases = await serviceEmpty.generate({ agentId: 'bot-empty', locale: 'zh-CN' });
  assert.equal(emptyWithPhrases.source, 'empty');
  assert.deepEqual(emptyWithPhrases.suggestions, ['继续', '总结一下']);
  assert.deepEqual(emptyWithPhrases.items.map(i => i.type), ['phrase', 'phrase']);
  assert.equal(requests.length, 0);

  // 3. History + AI enabled routes through scenario model, caches, deduplicates in-flight, and puts phrases BEFORE AI
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  let startedFetch;
  const fetchStarted = new Promise(resolve => { startedFetch = resolve; });
  const service = new SuggestionsService({
    models,
    settings,
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
      return sse(JSON.stringify(['查看测试覆盖率', '继续', '准备发布说明']));
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
  assert.equal(requests[0].body.max_tokens, 256);
  assert.equal(r1.source, 'model');
  assert.equal(r1.cached, false);
  assert.equal(r2.cached, true);
  // '继续' is deduplicated out of AI suggestions since it's already a quick phrase!
  assert.deepEqual(r1.aiSuggestions, ['查看测试覆盖率', '准备发布说明']);
  assert.deepEqual(r1.suggestions, ['继续', '总结一下', '查看测试覆盖率', '准备发布说明']);
  assert.deepEqual(r1.items.map(i => i.type), ['phrase', 'phrase', 'ai', 'ai']);

  // Cached hit reflects live quick phrase additions without calling the model again
  await settings.addPhrase({ text: '好的，开始吧' });
  const r3 = await service.generate({ agentId: 'bot-1', locale: 'zh-CN' });
  assert.equal(r3.cached, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(r3.suggestions, ['继续', '总结一下', '好的，开始吧', '查看测试覆盖率', '准备发布说明']);

  // 4. AI switch OFF returns only quick phrases with ZERO LLM calls
  await settings.updateSettings({ aiEnabled: false });
  const aiOff = await service.generate({ agentId: 'bot-new', locale: 'zh-CN' });
  assert.equal(aiOff.source, 'phrases-only');
  assert.deepEqual(aiOff.aiSuggestions, []);
  assert.deepEqual(aiOff.suggestions, ['继续', '总结一下', '好的，开始吧']);
  assert.equal(requests.length, 1);

  // 5. Master switch OFF returns empty list (no phrases, no AI, no LLM calls)
  await settings.updateSettings({ enabled: false, aiEnabled: true });
  const masterOff = await service.generate({ agentId: 'bot-new', locale: 'zh-CN' });
  assert.equal(masterOff.source, 'disabled');
  assert.equal(masterOff.enabled, false);
  assert.deepEqual(masterOff.suggestions, []);
  assert.deepEqual(masterOff.items, []);
  assert.equal(requests.length, 1);

  // 6. Default route fallback (when scenarioRoutes.suggestions is unset) clamps default effort to lowest latency ('none')
  await settings.updateSettings({ enabled: true, aiEnabled: true });
  await models.save(modelFixture({}, 'default'));
  const defaultReqs = [];
  const defaultSvc = new SuggestionsService({
    models,
    settings,
    dataDir: dir,
    hostCall: async () => ({ entries: [{ id: 'a9', kind: 'send-message', text: 'Done deploying.' }] }),
    fetchImpl: async (url, options) => {
      defaultReqs.push({ url, body: JSON.parse(options.body) });
      return sse(JSON.stringify(['Check logs', 'Run smoke test']));
    },
  });
  const defRes = await defaultSvc.generate({ agentId: 'bot-def', locale: 'en-US' });
  assert.equal(defRes.source, 'model');
  assert.equal(defaultReqs[0].body.model, 'gpt-main');
  assert.equal(defaultReqs[0].body.reasoning_effort, 'none');

  // 7. Timeout / error returns ONLY quick phrases (zero static fallback!) and does NOT cache the failure
  const failingService = new SuggestionsService({
    models,
    settings,
    dataDir: dir,
    timeoutMs: 30,
    hostCall: async () => ({ entries: [{ id: 'a2', kind: 'send-message', text: 'Done deploying.' }] }),
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  });
  const timedOut = await failingService.generate({ agentId: 'bot-2', locale: 'en-US' });
  assert.equal(timedOut.source, 'model-error');
  assert.deepEqual(timedOut.aiSuggestions, []);
  assert.deepEqual(timedOut.suggestions, ['继续', '总结一下', '好的，开始吧']);
  assert.equal(failingService.cache.size, 0);
});

test('HTTP endpoints /local/suggestions/settings, /local/suggestions/phrases, and /local/suggestions work end-to-end', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-suggestions-http-v2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let modelCalls = 0;
  const app = await createSelfHostServer({
    dataDir: dir,
    hostUrl: 'http://127.0.0.1:19999',
    modelAutoSync: false,
    suggestionsFetch: async () => {
      modelCalls += 1;
      return sse(JSON.stringify(['继续优化性能', '补充单元测试', '查看变更摘要']));
    },
  });
  await app.start(0, '127.0.0.1');
  t.after(() => app.close());

  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;

  // Unauthenticated rejected
  const unauth = await fetch(`${base}/local/suggestions/settings`);
  assert.equal(unauth.status, 401);

  await app.auth.setup(app.auth.setupKey, 'secret-admin-pass-123');
  const pairKey = await app.auth.createPairing();
  const device = await app.auth.pair({ pairingKey: pairKey.pairingKey, deviceName: 'Test Phone', platform: 'desktop' });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${device.token}` };

  // Default settings
  const def = await (await fetch(`${base}/local/suggestions/settings`, { headers })).json();
  assert.equal(def.enabled, true);
  assert.equal(def.aiEnabled, true);
  assert.deepEqual(def.quickPhrases, []);

  // Add, edit, reorder, delete phrases via HTTP
  const p1Res = await fetch(`${base}/local/suggestions/phrases`, { method: 'POST', headers, body: JSON.stringify({ text: '继续' }) });
  assert.equal(p1Res.status, 201);
  const p1 = (await p1Res.json()).phrase;

  const p2Res = await fetch(`${base}/local/suggestions/phrases`, { method: 'POST', headers, body: JSON.stringify({ text: '总结一下' }) });
  assert.equal(p2Res.status, 201);
  const p2 = (await p2Res.json()).phrase;

  const editRes = await fetch(`${base}/local/suggestions/phrases/${p1.id}`, { method: 'PUT', headers, body: JSON.stringify({ text: '请继续' }) });
  assert.equal(editRes.status, 200);
  assert.equal((await editRes.json()).phrase.text, '请继续');

  const reorderRes = await fetch(`${base}/local/suggestions/phrases/reorder`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ids: [p2.id, p1.id] }),
  });
  assert.equal(reorderRes.status, 200);
  assert.deepEqual((await reorderRes.json()).quickPhrases.map(p => p.text), ['总结一下', '请继续']);

  // Configure model and call POST /local/suggestions with history
  await app.models.save(modelFixture({ suggestions: { profileId: 'mini', effort: 'none' } }));
  const okRes = await fetch(`${base}/local/suggestions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: 'bot_123',
      locale: 'zh-CN',
      recentMessages: [{ id: 'm1', role: 'assistant', text: '功能已经实现完毕。' }],
    }),
  });
  assert.equal(okRes.status, 200);
  const body = await okRes.json();
  assert.equal(body.source, 'model');
  assert.deepEqual(body.suggestions, ['总结一下', '请继续', '继续优化性能', '补充单元测试', '查看变更摘要']);
  assert.deepEqual(body.items.map(i => i.type), ['phrase', 'phrase', 'ai', 'ai', 'ai']);
  assert.equal(modelCalls, 1);

  // Toggle master switch OFF -> POST /local/suggestions returns empty without calling model
  await fetch(`${base}/local/suggestions/settings`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
  const offRes = await (await fetch(`${base}/local/suggestions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: 'bot_456',
      locale: 'zh-CN',
      recentMessages: [{ id: 'm2', role: 'assistant', text: '新的回复。' }],
    }),
  })).json();
  assert.equal(offRes.source, 'disabled');
  assert.deepEqual(offRes.suggestions, []);
  assert.equal(modelCalls, 1);

  // Delete phrase
  const delRes = await fetch(`${base}/local/suggestions/phrases/${p1.id}`, { method: 'DELETE', headers });
  assert.equal(delRes.status, 200);
  assert.deepEqual((await delRes.json()).quickPhrases.map(p => p.text), ['总结一下']);
});

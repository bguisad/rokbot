import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelSession } from '../runtime/model-session.mjs';
import { convertAnthropicMessages } from '../runtime/anthropic-messages.mjs';
import { convertChatMessages } from '../runtime/openai-chat.mjs';
import { readSse, reasoningProviderOptions } from '../runtime/model-common.mjs';
import { loadModelConfig } from '../runtime/config.mjs';
import { contextPolicyFor } from '../runtime/context-policy.mjs';
import { installHostNetworkBoundary } from '../runtime/host-network.mjs';
import { createInference } from '../runtime/host-extensions.mjs';
import { catalogContextPolicy, defaultPolicy } from '../runtime/model-policy.mjs';
import { legacyModelRouting, modelRouteForAdaptiveTier, modelRouteForAgent, parseModelRouting, publicModelRouting, validateModelRouting } from '../runtime/model-routing.mjs';
import { Models } from '../server/models.mjs';

const primary = { profileId: 'fast', providerId: 'primary', providerName: 'Primary', apiFormat: 'openai',
  baseUrl: 'https://primary.example/v1', apiKey: 'test-primary-key', model: 'gpt-fast', efforts: ['none', 'low'], effort: 'low',
  contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 };
const fallback = { profileId: 'careful', providerId: 'backup', providerName: 'Backup', apiFormat: 'openai',
  baseUrl: 'https://backup.example/v1', apiKey: 'test-backup-key', model: 'gpt-careful', efforts: ['medium', 'high'], effort: 'high',
  contextWindowTokens: 32_000, summaryThresholdTokens: 24_000 };

const fixture = () => ({
  version: 1,
  providers: [
    { id: 'primary', name: 'Primary', apiFormat: 'openai', baseUrl: primary.baseUrl, apiKey: primary.apiKey },
    { id: 'backup', name: 'Backup', apiFormat: 'openai-responses', baseUrl: fallback.baseUrl, apiKey: fallback.apiKey },
  ],
  profiles: [
    { id: 'fast', name: 'Fast', providerId: 'primary', model: 'gpt-fast', efforts: ['none', 'low'], contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 },
    { id: 'careful', name: 'Careful', providerId: 'backup', model: 'gpt-careful', efforts: ['medium', 'high'], contextWindowTokens: 32_000, summaryThresholdTokens: 24_000 },
  ],
  defaultRoute: { profileId: 'fast', effort: 'low', fallbacks: [{ profileId: 'careful', effort: 'high' }] },
  botRoutes: { bot_alpha: { profileId: 'careful', effort: 'medium', fallbacks: [{ profileId: 'fast', effort: 'none' }] } },
});

const sse = text => new Response(`data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-careful', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, {
  status: 200, headers: { 'content-type': 'text/event-stream' },
});
const responsesSse = text => new Response([
  { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', delta: text },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1',
    status: 'completed', content: [{ type: 'output_text', text }] } },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-careful', status: 'completed',
    output: [{ type: 'message', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text }] }] } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
  status: 200, headers: { 'content-type': 'text/event-stream' },
});
const failure = status => new Response(JSON.stringify({ error: { message: `HTTP ${status}` } }), { status,
  headers: { 'content-type': 'application/json' } });

async function streamWithFallback(replies, { candidates = [primary, fallback], signal, messages = [{ role: 'user', content: 'Hello' }] } = {}) {
  const requests = [], fallbacks = [];
  const session = createModelSession({ ...primary, fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const reply = replies.shift();
    return typeof reply === 'function' ? reply() : reply;
  }, selectRequest: async () => ({ ...candidates[0], fallbacks: candidates.slice(1) }),
  onFallback: event => fallbacks.push(event) });
  const result = session.getExecutor(messages).stream({ signal }, 'routing-test', []);
  const parts = [];
  for await (const part of result.fullStream) parts.push(part);
  return { parts, requests, fallbacks, response: await result.response };
}

test('routes choose per-Bot providers, efforts and ordered backups without exposing keys', () => {
  const config = validateModelRouting(fixture());
  const defaultRoute = modelRouteForAgent(config);
  const botRoute = modelRouteForAgent(config, 'bot_alpha');
  assert.deepEqual([defaultRoute.providerId, defaultRoute.model, defaultRoute.effort], ['primary', 'gpt-fast', 'low']);
  assert.deepEqual(defaultRoute.fallbacks.map(item => [item.providerId, item.model, item.effort]), [['backup', 'gpt-careful', 'high']]);
  assert.equal(defaultRoute.contextWindowTokens, 32_000);
  assert.deepEqual([botRoute.providerId, botRoute.model, botRoute.effort], ['backup', 'gpt-careful', 'medium']);
  assert.deepEqual(botRoute.fallbacks.map(item => [item.providerId, item.model, item.effort]), [['primary', 'gpt-fast', 'none']]);
  const publicConfig = publicModelRouting(config);
  assert.equal(JSON.stringify(publicConfig).includes('test-primary-key'), false);
  assert.equal(publicConfig.providers[0].hasApiKey, true);
});

test('Host inference selects a Bot route at the real HTTP request boundary', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'host-inference-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const routing = validateModelRouting(fixture());
  const config = {
    ...primary,
    modelRouting: routing,
    policy: defaultPolicy(primary.model),
    usageDirectory: join(directory, 'usage'),
    routingDirectory: join(directory, 'routing'),
    modelBaseUrls: routing.providers.map(provider => provider.baseUrl),
  };
  const requests = [];
  class HarnessError extends Error {}
  const library = {
    PrivacyMode: { NO_STORAGE: 'no-storage' },
    ConnectError: HarnessError,
    ActionRequiredError: HarnessError,
    NonRetriableError: HarnessError,
    Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 },
  };
  const inference = createInference(config, library, {}, {
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return JSON.parse(options.body).model === 'gpt-careful' ? responsesSse('OK') : sse('OK');
    },
  });

  const run = async options => {
    const session = inference.port.createSession(() => {}, options);
    const result = session.getExecutor([{ role: 'user', content: 'Hello' }]).stream({}, 'routing-entry', []);
    await Array.fromAsync(result.fullStream);
    await result.response;
  };
  await run({ agentId: 'bot_alpha' });
  await run({ getAgentId: () => 'bot_alpha' });
  await run({});

  assert.deepEqual(requests.map(request => [request.url, request.body.model,
    request.body.reasoning_effort ?? request.body.reasoning?.effort]), [
    ['https://backup.example/v1/responses', 'gpt-careful', 'medium'],
    ['https://backup.example/v1/responses', 'gpt-careful', 'medium'],
    ['https://primary.example/v1/chat/completions', 'gpt-fast', 'low'],
  ]);
});

test('legacy single-provider configuration remains editable as a direct default route', () => {
  const legacy = { apiFormat: 'openai', baseUrl: 'https://legacy.example/v1', apiKey: 'test-legacy-key', model: 'legacy-model',
    contextWindowTokens: 16_000, policy: { effort: 'high', models: [{ id: 'legacy-model', efforts: ['low', 'high'] }] } };
  const { config, migrated } = parseModelRouting(undefined, legacy);
  assert.equal(migrated, true);
  assert.deepEqual(modelRouteForAgent(config).model, 'legacy-model');
  assert.equal(legacyModelRouting({}).providers.length, 0);
});

test('catalog context policies use provider metadata and never assume capacity for an unknown model', () => {
  assert.deepEqual(catalogContextPolicy('provider-model', 128_000), {
    contextWindowTokens: 128_000, summaryThresholdTokens: 96_000, contextSource: 'provider',
  });
  assert.deepEqual(catalogContextPolicy('gpt-5.6-terra'), {
    contextWindowTokens: 0, summaryThresholdTokens: 0, contextSource: 'unknown',
  });
  assert.deepEqual(catalogContextPolicy('unpublished-model'), {
    contextWindowTokens: 0, summaryThresholdTokens: 0, contextSource: 'unknown',
  });
});

test('new profiles do not assume a compaction policy without provider metadata', () => {
  const input = fixture();
  input.profiles = [{ id: 'new', name: 'New', providerId: 'primary', model: 'new-model', efforts: [] },
    { id: 'disabled', name: 'Disabled', providerId: 'primary', model: 'disabled-model', efforts: [],
      contextWindowTokens: 0, summaryThresholdTokens: 0 }];
  input.defaultRoute = { profileId: 'new', effort: 'default', fallbacks: [] };
  input.botRoutes = {};
  const profiles = new Map(validateModelRouting(input).profiles.map(profile => [profile.id, profile]));
  assert.deepEqual(profiles.get('new').contextWindowTokens, 0);
  assert.deepEqual(profiles.get('new').summaryThresholdTokens, 0);
  assert.deepEqual(profiles.get('disabled').contextWindowTokens, 0);
  assert.deepEqual(profiles.get('disabled').summaryThresholdTokens, 0);
});

test('SSE parser accepts adjacent data frames from compatible gateways', async () => {
  const first = JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] });
  const second = JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] });
  const wire = `data: ${first}data: ${second}data: [DONE]`;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(wire.slice(0, 17)));
      controller.enqueue(encoder.encode(wire.slice(17, 71)));
      controller.enqueue(encoder.encode(wire.slice(71)));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readSse(body)) events.push(event);
  assert.deepEqual(events, [first, second, '[DONE]']);
});

test('loadModelConfig retains every provider base URL for the Host network boundary', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'model.env'), `ROKBOT_MODEL_ROUTING=${JSON.stringify(fixture())}\n`);
  const config = await loadModelConfig({ env: { ROKBOT_MODEL_ENV: join(directory, 'model.env'), ROKBOT_DATA_DIR: directory } });
  assert.deepEqual(config.modelBaseUrls, ['https://primary.example/v1', 'https://backup.example/v1']);
});

test('loadModelConfig and Models support GROKBOT_* migration fallbacks with ROKBOT_* precedence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-routing-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = defaultPolicy('legacy-grokbot-model');
  policy.models = [{ id: 'legacy-grokbot-model', efforts: ['low'], contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 }];
  const legacyEnvFile = join(directory, 'legacy-model.env');
  await writeFile(legacyEnvFile, [
    'MODEL_API_FORMAT=openai',
    'OPENAI_BASE_URL=https://legacy.example/v1',
    'OPENAI_API_KEY=test-legacy-key',
    'OPENAI_MODEL=legacy-grokbot-model',
    `GROKBOT_MODEL_POLICY=${JSON.stringify(policy)}`,
    '',
  ].join('\n'));
  const loadedLegacy = await loadModelConfig({ env: { GROKBOT_MODEL_ENV: legacyEnvFile, GROKBOT_DATA_DIR: directory, GROKBOT_MODEL: 'override-legacy' } });
  assert.equal(loadedLegacy.model, 'override-legacy');
  assert.equal(loadedLegacy.usageDirectory, join(directory, 'usage'));

  const rokbotEnvFile = join(directory, 'rokbot-model.env');
  await writeFile(rokbotEnvFile, `GROKBOT_MODEL_ROUTING=${JSON.stringify(fixture())}\n`);
  const loadedPrecedence = await loadModelConfig({
    env: {
      ROKBOT_MODEL_ENV: rokbotEnvFile,
      GROKBOT_MODEL_ENV: legacyEnvFile,
      ROKBOT_DATA_DIR: directory,
      ROKBOT_MODEL: 'rokbot-wins',
      GROKBOT_MODEL: 'grokbot-loses',
    },
  });
  assert.deepEqual(loadedPrecedence.modelBaseUrls, ['https://primary.example/v1', 'https://backup.example/v1']);
  const models = new Models(directory, { filename: rokbotEnvFile });
  const publicCfg = await models.publicConfig();
  assert.equal(publicCfg.providers.length, 2);
});

test('model administration keeps saved provider keys private and preserves them on an unchanged provider', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-routing-admin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = new Models(directory);
  await models.save({ ...fixture(), migrateLegacyRouting: true });
  const publicConfig = await models.publicConfig();
  assert.equal(JSON.stringify(publicConfig).includes('test-primary-key'), false);
  assert.equal(JSON.stringify(publicConfig).includes('test-backup-key'), false);
  const unchanged = fixture();
  unchanged.providers = unchanged.providers.map(({ apiKey, ...provider }) => provider);
  await models.save(unchanged);
  const current = await models.current();
  assert.equal(current.routing.providers.find(provider => provider.id === 'primary').apiKey, 'test-primary-key');
  assert.equal(current.routing.providers.find(provider => provider.id === 'backup').apiKey, 'test-backup-key');
});

test('legacy Jev configuration remains in the legacy format until an administrator migrates it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-routing-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = defaultPolicy('legacy-model');
  policy.mode = 'adaptive';
  const models = new Models(directory);
  await models.save({ apiFormat: 'openai', baseUrl: 'https://legacy.example/v1', apiKey: 'test-legacy-key', model: 'legacy-model',
    contextWindowTokens: 16_000, policy, jevApiKey: 'test-jev-key' });
  const source = await readFile(join(directory, 'model.env'), 'utf8');
  assert.doesNotMatch(source, /^(ROKBOT|GROKBOT)_MODEL_ROUTING=/m);
  const loaded = await loadModelConfig({ env: { ROKBOT_MODEL_ENV: join(directory, 'model.env'), ROKBOT_DATA_DIR: directory } });
  assert.equal(loaded.policy.mode, 'adaptive');
  assert.equal(loaded.jevApiKey, 'test-jev-key');
  assert.equal((await models.publicConfig()).legacyAdaptiveRouting, true);
  await assert.rejects(models.save(fixture()), { status: 409, message: /旧版模型配置/ });
  assert.equal(await readFile(join(directory, 'model.env'), 'utf8'), source);
  const migrated = await models.save({ ...fixture(), migrateLegacyRouting: true });
  assert.equal(migrated.routingMigrated, false);
  assert.equal(migrated.legacyAdaptiveRouting, false);
  assert.match(await readFile(join(directory, 'model.env'), 'utf8'), /^ROKBOT_MODEL_ROUTING=/m);
});

test('a legacy single-model configuration is not reported as task-difficulty routing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-routing-legacy-single-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = new Models(directory);
  await models.save({ apiFormat: 'openai', baseUrl: 'https://legacy.example/v1', apiKey: 'test-legacy-key', model: 'legacy-model',
    contextWindowTokens: 16_000, policy: defaultPolicy('legacy-model') });
  const publicConfig = await models.publicConfig();
  assert.equal(publicConfig.routingMigrated, true);
  assert.equal(publicConfig.legacyAdaptiveRouting, false);
});

test('transient failures before output move to the next configured model', async () => {
  for (const retryable of [() => failure(503), () => failure(429), () => { throw new TypeError('socket closed'); },
    () => { const error = new DOMException('timed out', 'TimeoutError'); throw error; }]) {
    const { requests, fallbacks, response } = await streamWithFallback([retryable, sse('OK')]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://primary.example/v1/chat/completions');
    assert.equal(requests[1].url, 'https://backup.example/v1/chat/completions');
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].from.profileId, 'fast');
    assert.equal(fallbacks[0].to.profileId, 'careful');
    assert.equal(response.modelId, 'gpt-careful');
  }
});

test('configuration errors and cancellation do not start a backup model', async () => {
  await assert.rejects(streamWithFallback([() => failure(400), sse('unexpected')]), /HTTP 400/);
  const cancellation = new AbortController();
  cancellation.abort(new DOMException('Canceled', 'AbortError'));
  await assert.rejects(streamWithFallback([sse('unexpected')], { signal: cancellation.signal }), /Canceled/);
});

test('a model that has emitted visible text is never retried on another provider', async () => {
  const encoder = new TextEncoder();
  const broken = () => {
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial answer' } }] })}\n\n`));
          return;
        }
        controller.error(new TypeError('connection reset'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const requests = [], events = [];
  const session = createModelSession({ ...primary, fetchImpl: async (url, options) => { requests.push({ url, options }); return broken(); },
    selectRequest: async () => ({ ...primary, fallbacks: [fallback] }), onFallback: event => events.push(event) });
  const result = session.getExecutor([{ role: 'user', content: 'Hello' }]).stream({}, 'no-retry-after-output', []);
  const parts = [];
  await assert.rejects(async () => { for await (const part of result.fullStream) parts.push(part); }, /connection reset/);
  assert.equal(requests.length, 1);
  assert.equal(events.length, 0);
  assert.equal(parts.length, 1);
});

test('a model that has emitted only reasoning may use its configured backup', async () => {
  const encoder = new TextEncoder();
  const broken = () => {
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'partial reasoning' } }] })}\n\n`));
          return;
        }
        controller.error(new TypeError('connection reset'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { requests, fallbacks, response } = await streamWithFallback([broken, sse('OK')]);
  assert.equal(requests.length, 2);
  assert.equal(fallbacks.length, 1);
  assert.equal(response.modelId, 'gpt-careful');
});

test('legacy model.env context and summary thresholds enable compaction through the real config path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-routing-compaction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = defaultPolicy('legacy-compaction-model');
  policy.models = [{ id: 'legacy-compaction-model', efforts: ['low'],
    contextWindowTokens: 128_000, summaryThresholdTokens: 96_000 }];
  await writeFile(join(directory, 'model.env'), [
    'MODEL_API_FORMAT=openai',
    'OPENAI_BASE_URL=https://legacy.example/v1',
    'OPENAI_API_KEY=test-legacy-key',
    'OPENAI_MODEL=legacy-compaction-model',
    'OPENAI_CONTEXT_WINDOW_TOKENS=128000',
    `ROKBOT_MODEL_POLICY=${JSON.stringify(policy)}`,
    '',
  ].join('\n'));
  const config = await loadModelConfig({ env: { ROKBOT_MODEL_ENV: join(directory, 'model.env'), ROKBOT_DATA_DIR: directory } });
  const context = contextPolicyFor(config, config.model);
  assert.deepEqual(context, { contextWindowTokens: 128_000, summaryThresholdTokens: 96_000 });
  const session = createModelSession({ ...config, ...context, fetchImpl: async () => sse('OK'),
    selectRequest: async () => ({ model: config.model, ...context, fallbacks: [] }) });
  const result = session.getExecutor([{ role: 'user', content: 'Hello' }]).stream({}, 'legacy-compaction', []);
  await Array.fromAsync(result.fullStream);
  const response = await result.response;
  assert.equal(response.supportsSelfSummary, true);
  assert.equal(response.earlyCompactionContextTokenThreshold, 96_000);
});

test('configured summary thresholds are advertised to the Harness after a successful model response', async () => {
  const session = createModelSession({ ...primary, contextWindowTokens: 258_000, summaryThresholdTokens: 192_000,
    fetchImpl: async () => sse('OK'), selectRequest: async () => ({ ...primary,
      contextWindowTokens: 258_000, summaryThresholdTokens: 192_000, fallbacks: [] }) });
  const result = session.getExecutor([{ role: 'user', content: 'Hello' }]).stream({}, 'compaction-capability', []);
  for await (const _part of result.fullStream) { /* consume the response */ }
  const response = await result.response;
  assert.equal(response.supportsSelfSummary, true);
  assert.equal(response.earlyCompactionContextTokenThreshold, 192_000);
  assert.deepEqual(session.getEarlyCompaction(), { threshold: 192_000, inputTokens: 0 });
});

test('reasoning replay is isolated by provider and API format, not by a provider-rewritten model ID', () => {
  const history = [{ role: 'user', content: 'Start' }, { role: 'assistant', content: [{ type: 'reasoning', text: 'Private chain',
    ...{ providerOptions: reasoningProviderOptions({ format: 'openai', model: 'same-model', providerId: 'one' }) } }] }];
  assert.equal(convertChatMessages(history, { model: 'same-model', providerId: 'one' })[1].reasoning_content, 'Private chain');
  assert.equal(convertChatMessages(history, { model: 'same-model', providerId: 'two' })[1].reasoning_content, undefined);
  const anthropicHistory = [{ role: 'user', content: 'Start' }, { role: 'assistant', content: [{ type: 'reasoning', text: 'Signed chain', signature: 'sig',
    ...{ providerOptions: reasoningProviderOptions({ format: 'anthropic', model: 'claude-one', providerId: 'one' }) } }, { type: 'text', text: 'Done' }] }];
  assert.equal(convertAnthropicMessages(anthropicHistory, { model: 'claude-one', providerId: 'one' }).messages[1].content[0].type, 'thinking');
  assert.equal(convertAnthropicMessages(anthropicHistory, { model: 'claude-one-2026-01-01', providerId: 'one' }).messages[1].content[0].type, 'thinking');
  assert.equal(convertAnthropicMessages(anthropicHistory, { model: 'claude-one', providerId: 'two' }).messages[1].content[0].type, 'text');
});

test('the Host network boundary accepts every configured model provider', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('ok');
  installHostNetworkBoundary(['https://primary.example/v1', 'https://backup.example/v1']);
  assert.equal((await globalThis.fetch('https://backup.example/v1/models')).status, 200);
  await assert.rejects(globalThis.fetch('https://blocked.example/v1/models'), /Host network capability unavailable/);
  globalThis.fetch = originalFetch;
});

function adaptiveFixture() {
  return {
    version: 1,
    providers: [
      { id: 'primary', name: 'Primary', apiFormat: 'openai', baseUrl: 'https://primary.example/v1', apiKey: 'test-primary-key' },
      { id: 'backup', name: 'Backup', apiFormat: 'openai-responses', baseUrl: 'https://backup.example/v1', apiKey: 'test-backup-key' },
      { id: 'claude', name: 'Claude', apiFormat: 'anthropic', baseUrl: 'https://claude.example', apiKey: 'test-claude-key' },
    ],
    profiles: [
      { id: 'fast', name: 'Fast', providerId: 'primary', model: 'gpt-fast', efforts: ['none', 'low'], contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 },
      { id: 'careful', name: 'Careful', providerId: 'backup', model: 'gpt-careful', efforts: ['medium', 'high'], contextWindowTokens: 128_000, summaryThresholdTokens: 96_000 },
      { id: 'expert', name: 'Expert', providerId: 'claude', model: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high', 'max'], contextWindowTokens: 200_000, summaryThresholdTokens: 150_000 },
    ],
    defaultRoute: { profileId: 'fast', effort: 'low', fallbacks: [{ profileId: 'careful', effort: 'high' }] },
    botRoutes: { bot_alpha: { profileId: 'careful', effort: 'medium', fallbacks: [] } },
    adaptiveRouting: {
      enabled: true,
      classifierModel: 'jev-latest',
      tiers: {
        simple: { profileId: 'fast', effort: 'none' },
        medium: { profileId: 'careful', effort: 'medium' },
        complex: { profileId: 'expert', effort: 'auto' },
      },
    },
  };
}

const anthropicSse = text => new Response([
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_ant_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('v1 adaptiveRouting validates tiers, classifierModel, efforts, and legacy Jev migration', async t => {
  const valid = validateModelRouting(adaptiveFixture());
  assert.equal(valid.adaptiveRouting.enabled, true);
  assert.equal(valid.adaptiveRouting.classifierModel, 'jev-latest');
  assert.deepEqual(valid.adaptiveRouting.tiers.complex, { profileId: 'expert', effort: 'auto' });

  // Omitting adaptiveRouting keeps enabled=false in publicModelRouting and omits it on persisted config
  const plain = validateModelRouting(fixture());
  assert.equal(plain.adaptiveRouting, undefined);
  assert.equal(publicModelRouting(plain).adaptiveRouting.enabled, false);

  // Invalid classifierModel / missing tier / unknown profile / unsupported effort fail
  const badClassifier = adaptiveFixture();
  badClassifier.adaptiveRouting.classifierModel = 'gpt-4o';
  assert.throws(() => validateModelRouting(badClassifier), /Invalid classifier model/);

  const missingTier = adaptiveFixture();
  delete missingTier.adaptiveRouting.tiers.complex;
  assert.throws(() => validateModelRouting(missingTier), /Missing adaptive routing tier: complex/);

  const badProfile = adaptiveFixture();
  badProfile.adaptiveRouting.tiers.simple.profileId = 'nope';
  assert.throws(() => validateModelRouting(badProfile), /Unknown profile: nope/);

  const badEffort = adaptiveFixture();
  badEffort.adaptiveRouting.tiers.simple.effort = 'max';
  assert.throws(() => validateModelRouting(badEffort), /Unsupported effort for fast/);

  // Legacy adaptive policy migrates cleanly with adaptiveRouting preserved
  const legacyPolicy = defaultPolicy('legacy-model');
  legacyPolicy.mode = 'adaptive';
  legacyPolicy.routes = {
    routine: { model: 'legacy-model', effort: 'default' },
    reasoning: { model: 'legacy-model', effort: 'auto' },
    expert: { model: 'legacy-model', effort: 'auto' },
  };
  const migrated = legacyModelRouting({
    apiFormat: 'openai', baseUrl: 'https://legacy.example/v1', apiKey: 'test-legacy-key',
    model: 'legacy-model', policy: legacyPolicy,
  });
  assert.equal(migrated.adaptiveRouting.enabled, true);
  assert.equal(migrated.adaptiveRouting.tiers.simple.profileId, 'default');
  assert.equal(migrated.adaptiveRouting.tiers.complex.effort, 'auto');

  // Models persistence, redaction, whitespace preservation & explicit clear
  const directory = await mkdtemp(join(tmpdir(), 'model-adaptive-persist-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = new Models(directory);
  await assert.rejects(models.save(adaptiveFixture()), { status: 400, message: /Jev API Key/ });
  const saved = await models.save({ ...adaptiveFixture(), jevApiKey: 'jev-secret-key-01' });
  assert.equal(saved.hasJevApiKey, true);
  assert.equal(saved.adaptiveRouting.enabled, true);
  assert.equal(JSON.stringify(saved).includes('jev-secret-key-01'), false);

  const envText = await readFile(join(directory, 'model.env'), 'utf8');
  assert.match(envText, /JEV_API_KEY=jev-secret-key-01/);
  const loaded = await loadModelConfig({ env: { ROKBOT_MODEL_ENV: join(directory, 'model.env'), ROKBOT_DATA_DIR: directory } });
  assert.equal(loaded.jevApiKey, 'jev-secret-key-01');
  assert.equal(loaded.modelRouting.adaptiveRouting.enabled, true);

  // Omitting or whitespace jevApiKey retains stored key
  const kept = await models.save({ ...adaptiveFixture(), jevApiKey: '   ' });
  assert.equal(kept.hasJevApiKey, true);
  assert.equal((await models.current()).jevApiKey, 'jev-secret-key-01');

  // Disabling + clearJevApiKey removes JEV_API_KEY
  const disabled = adaptiveFixture();
  disabled.adaptiveRouting.enabled = false;
  const cleared = await models.save({ ...disabled, clearJevApiKey: true });
  assert.equal(cleared.hasJevApiKey, false);
  assert.equal((await models.current()).jevApiKey, '');
});

test('Host inference routes v1 adaptiveRouting across simple/medium/complex tiers, Bot overrides, and JEV error fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'host-adaptive-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const routing = validateModelRouting(adaptiveFixture());
  const defaultRoute = modelRouteForAgent(routing);
  const config = {
    ...defaultRoute,
    modelRouting: routing,
    jevApiKey: 'jev-test-token-123',
    policy: defaultPolicy(defaultRoute.model),
    usageDirectory: join(directory, 'usage'),
    routingDirectory: join(directory, 'routing'),
    modelBaseUrls: routing.providers.map(provider => provider.baseUrl),
  };

  let jevOutcome = { difficulty: 'routine', efforts: {} };
  const requests = [];
  class HarnessError extends Error {}
  const library = {
    PrivacyMode: { NO_STORAGE: 'no-storage' },
    ConnectError: HarnessError,
    ActionRequiredError: HarnessError,
    NonRetriableError: HarnessError,
    Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 },
  };
  const inference = createInference(config, library, {}, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, auth: options.headers instanceof Headers ? options.headers.get('authorization') : options.headers?.authorization, body });
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        if (jevOutcome instanceof Error) throw jevOutcome;
        if (typeof jevOutcome === 'number') return new Response('err', { status: jevOutcome });
        return new Response(JSON.stringify({
          model: 'jev-latest',
          answers: {
            difficulty: { choice: jevOutcome.difficulty, confidence: 0.91 },
            ...(jevOutcome.effort_0 ? { effort_0: { choice: jevOutcome.effort_0 } } : {}),
          },
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://claude.example/')) return anthropicSse('Expert OK');
      if (url.startsWith('https://backup.example/')) return responsesSse('Medium OK');
      return sse('Simple OK');
    },
  });

  const run = async (prompt, options = {}) => {
    const session = inference.port.createSession(() => {}, options);
    const result = session.getExecutor([{ role: 'user', content: prompt }]).stream({}, 'adaptive-test', []);
    await Array.fromAsync(result.fullStream);
    return result.response;
  };

  // 1. routine -> simple tier (primary / gpt-fast / none)
  jevOutcome = { difficulty: 'routine', effort_0: 'high' };
  await run('Hi there');
  assert.equal(requests.at(-2).url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(requests.at(-2).auth, 'Bearer jev-test-token-123');
  assert.equal(requests.at(-1).url, 'https://primary.example/v1/chat/completions');
  assert.equal(requests.at(-1).body.model, 'gpt-fast');
  assert.equal(requests.at(-1).body.reasoning_effort, 'none');

  // 2. expert -> complex tier (claude / claude-sonnet-4-6 / auto -> JEV chose 'max')
  jevOutcome = { difficulty: 'expert', effort_0: 'max' };
  await run('Design a distributed consensus protocol');
  assert.equal(requests.at(-1).url, 'https://claude.example/v1/messages');
  assert.equal(requests.at(-1).body.model, 'claude-sonnet-4-6');
  assert.equal(requests.at(-1).body.output_config?.effort, 'max');

  // 3. Explicit Bot override bypasses JEV classifier completely
  const countBeforeBot = requests.length;
  await run('Hi bot alpha', { agentId: 'bot_alpha' });
  assert.equal(requests.length - countBeforeBot, 1);
  assert.equal(requests.at(-1).url, 'https://backup.example/v1/responses');
  assert.equal(requests.at(-1).body.model, 'gpt-careful');
  assert.equal(requests.at(-1).body.reasoning?.effort, 'medium');

  // 4. Summarization session bypasses JEV classifier
  const countBeforeSummary = requests.length;
  await run('Summarize this conversation', { isSummarizationSession: true });
  assert.equal(requests.length - countBeforeSummary, 1);
  assert.equal(requests.at(-1).url, 'https://primary.example/v1/chat/completions');

  // 5. JEV failure falls back gracefully to medium tier without crashing
  jevOutcome = 503;
  await run('What happens on JEV outage?');
  assert.equal(requests.at(-1).url, 'https://backup.example/v1/responses');
  assert.equal(requests.at(-1).body.model, 'gpt-careful');

  // 6. Tier inherits fallback chain from defaultRoute
  const simpleRoute = modelRouteForAdaptiveTier(routing, 'simple');
  assert.deepEqual(simpleRoute.fallbacks.map(item => item.profileId), ['careful']);
});

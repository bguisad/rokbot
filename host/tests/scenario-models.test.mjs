import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCENARIO_KEYS,
  modelRouteForAgent,
  modelRouteForScenario,
  publicModelRouting,
  validateModelRouting,
} from '../runtime/model-routing.mjs';
import { createInference, scenarioForSessionOptions } from '../runtime/host-extensions.mjs';
import { createLocalClassifier, resolveAutoReviewConfig } from '../runtime/host-auto-review.mjs';
import { defaultPolicy } from '../runtime/model-policy.mjs';
import { loadModelConfig } from '../runtime/config.mjs';
import { Models } from '../server/models.mjs';

function scenarioFixture(scenarioRoutes) {
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
      { id: 'claude-mini', name: 'Claude Mini', providerId: 'claude', model: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high'], contextWindowTokens: 200_000, summaryThresholdTokens: 150_000 },
    ],
    defaultRoute: { profileId: 'fast', effort: 'low', fallbacks: [{ profileId: 'careful', effort: 'high' }] },
    botRoutes: { bot_alpha: { profileId: 'careful', effort: 'medium', fallbacks: [] } },
    ...(scenarioRoutes !== undefined ? { scenarioRoutes } : {}),
  };
}

const sse = text => new Response(
  `data: ${JSON.stringify({ id: 'chat_1', model: 'gpt-fast', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const responsesSse = text => new Response([
  { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', delta: text },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text }] } },
  { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-careful', status: 'completed',
    output: [{ type: 'message', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text }] }] } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
  status: 200, headers: { 'content-type': 'text/event-stream' },
});
const anthropicSse = text => new Response([
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_ant_1', model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('scenarioRoutes validates backward-compatibly, rejects bad entries, and round-trips through Models', async t => {
  assert.deepEqual([...SCENARIO_KEYS], ['suggestions', 'summarization', 'memoryExtraction', 'autoReview', 'subagent', 'automation']);

  // Absent scenarioRoutes loads cleanly and omits the empty field from persisted config.
  const withoutScenarios = validateModelRouting(scenarioFixture());
  assert.equal(withoutScenarios.scenarioRoutes, undefined);
  assert.deepEqual(publicModelRouting(withoutScenarios).scenarioRoutes, {});

  // Empty object or null values are treated as "follow default".
  const emptyScenarios = validateModelRouting(scenarioFixture({ suggestions: null, summarization: {} }));
  assert.equal(emptyScenarios.scenarioRoutes, undefined);

  // Valid scenario routes for all supported scenarios.
  const configured = validateModelRouting(scenarioFixture({
    suggestions: { profileId: 'fast', effort: 'none' },
    summarization: { profileId: 'claude-mini', effort: 'low' },
    memoryExtraction: { profileId: 'careful', effort: 'medium' },
    autoReview: { profileId: 'claude-mini', effort: 'high' },
    subagent: { profileId: 'careful', effort: 'high' },
    automation: { profileId: 'fast', effort: 'low' },
  }));
  assert.deepEqual(configured.scenarioRoutes, {
    suggestions: { profileId: 'fast', effort: 'none' },
    summarization: { profileId: 'claude-mini', effort: 'low' },
    memoryExtraction: { profileId: 'careful', effort: 'medium' },
    autoReview: { profileId: 'claude-mini', effort: 'high' },
    subagent: { profileId: 'careful', effort: 'high' },
    automation: { profileId: 'fast', effort: 'low' },
  });
  assert.deepEqual(publicModelRouting(configured).scenarioRoutes, configured.scenarioRoutes);

  // Validation errors.
  assert.throws(() => validateModelRouting(scenarioFixture({ unknownKey: { profileId: 'fast', effort: 'low' } })), /Unknown scenario: unknownKey/);
  assert.throws(() => validateModelRouting(scenarioFixture({ suggestions: { profileId: 'missing', effort: 'low' } })), /Unknown profile: missing/);
  assert.throws(() => validateModelRouting(scenarioFixture({ suggestions: { profileId: 'fast', effort: 'max' } })), /Unsupported effort for fast/);

  // Persistence round-trip via Models + loadModelConfig.
  const directory = await mkdtemp(join(tmpdir(), 'scenario-models-persist-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = new Models(directory);
  const saved = await models.save({ ...scenarioFixture(configured.scenarioRoutes), migrateLegacyRouting: true });
  assert.deepEqual(saved.scenarioRoutes, configured.scenarioRoutes);
  const envText = await readFile(join(directory, 'model.env'), 'utf8');
  assert.match(envText, /scenarioRoutes/);
  const loaded = await loadModelConfig({ env: { ROKBOT_MODEL_ENV: join(directory, 'model.env'), ROKBOT_DATA_DIR: directory } });
  assert.deepEqual(loaded.modelRouting.scenarioRoutes, configured.scenarioRoutes);
});

test('modelRouteForScenario resolves explicit routes, direct mode, and default/bot fallbacks', () => {
  const configured = validateModelRouting(scenarioFixture({
    suggestions: { profileId: 'claude-mini', effort: 'low' },
  }));
  const explicit = modelRouteForScenario(configured, 'suggestions');
  assert.equal(explicit.profileId, 'claude-mini');
  assert.equal(explicit.model, 'claude-sonnet-4-6');
  assert.equal(explicit.effort, 'low');
  assert.equal(explicit.scenario, 'suggestions');
  assert.ok(explicit.fallbacks.length >= 1);

  const direct = modelRouteForScenario(configured, 'suggestions', { direct: true });
  assert.equal(direct.profileId, 'claude-mini');
  assert.deepEqual(direct.fallbacks, []);

  // Unconfigured scenario falls back to Bot route if agentId matches, otherwise default route.
  const botFallback = modelRouteForScenario(configured, 'summarization', { agentId: 'bot_alpha' });
  assert.equal(botFallback.profileId, 'careful');
  const defaultFallback = modelRouteForScenario(configured, 'summarization');
  assert.equal(defaultFallback.profileId, 'fast');
});

test('Host inference routes summarization, memoryExtraction, subagent, and automation through scenarioRoutes', async t => {
  assert.equal(scenarioForSessionOptions({ isSummarizationSession: true }), 'summarization');
  assert.equal(scenarioForSessionOptions({ modelId: 'sand-memory-extraction' }), 'memoryExtraction');
  assert.equal(scenarioForSessionOptions({ isSubagent: true }), 'subagent');
  assert.equal(scenarioForSessionOptions({ inAutomationRun: true }), 'automation');
  assert.equal(scenarioForSessionOptions({ agentId: 'bot_alpha' }), null);

  const directory = await mkdtemp(join(tmpdir(), 'host-scenario-inference-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const routing = validateModelRouting({
    ...scenarioFixture({
      summarization: { profileId: 'claude-mini', effort: 'low' },
      memoryExtraction: { profileId: 'careful', effort: 'medium' },
      subagent: { profileId: 'claude-mini', effort: 'high' },
      automation: { profileId: 'careful', effort: 'high' },
    }),
    adaptiveRouting: {
      enabled: true,
      classifierModel: 'jev-latest',
      tiers: {
        simple: { profileId: 'fast', effort: 'none' },
        medium: { profileId: 'fast', effort: 'low' },
        complex: { profileId: 'careful', effort: 'high' },
      },
    },
  });
  const defaultRoute = modelRouteForAgent(routing);
  const config = {
    ...defaultRoute,
    modelRouting: routing,
    jevApiKey: 'jev-test-key',
    policy: defaultPolicy(defaultRoute.model),
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
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        throw new Error('JEV classifier must not be called for explicit scenario routes');
      }
      if (url.startsWith('https://claude.example/')) return anthropicSse('Claude OK');
      if (url.startsWith('https://backup.example/')) return responsesSse('Backup OK');
      return sse('Primary OK');
    },
  });

  // externalSummarizationModelId reports the configured summarization model so the harness uses it.
  assert.equal(inference.port.externalSummarizationModelId(), 'claude-sonnet-4-6');

  const run = async options => {
    const session = inference.port.createSession(() => {}, options);
    const result = session.getExecutor([{ role: 'user', content: 'Run scenario' }]).stream({}, 'scenario-entry', []);
    await Array.fromAsync(result.fullStream);
    await result.response;
  };

  await run({ isSummarizationSession: true });
  await run({ modelId: 'sand-memory-extraction' });
  await run({ isSubagent: true });
  await run({ inAutomationRun: true });

  assert.deepEqual(requests.map(req => [
    req.url,
    req.body.model,
    req.body.reasoning_effort ?? req.body.reasoning?.effort ?? req.body.output_config?.effort,
  ]), [
    ['https://claude.example/v1/messages', 'claude-sonnet-4-6', 'low'],
    ['https://backup.example/v1/responses', 'gpt-careful', 'medium'],
    ['https://claude.example/v1/messages', 'claude-sonnet-4-6', 'high'],
    ['https://backup.example/v1/responses', 'gpt-careful', 'high'],
  ]);

  // When summarization scenario is absent, externalSummarizationModelId returns undefined.
  const noScenarioRouting = validateModelRouting(scenarioFixture());
  const noScenarioInf = createInference({ ...config, modelRouting: noScenarioRouting }, library, {}, { fetchImpl: async () => sse('OK') });
  assert.equal(noScenarioInf.port.externalSummarizationModelId(), undefined);
});

test('auto-review classifier uses scenarioRoutes.autoReview when configured and falls back to default otherwise', async t => {
  const usageDirectory = await mkdtemp(join(tmpdir(), 'auto-review-scenario-'));
  t.after(() => rm(usageDirectory, { recursive: true, force: true }));

  const routing = validateModelRouting(scenarioFixture({
    autoReview: { profileId: 'claude-mini', effort: 'high' },
  }));
  const defaultRoute = modelRouteForAgent(routing);
  const effective = resolveAutoReviewConfig({ ...defaultRoute, modelRouting: routing, usageDirectory });
  assert.equal(effective.apiFormat, 'anthropic');
  assert.equal(effective.baseUrl, 'https://claude.example');
  assert.equal(effective.model, 'claude-sonnet-4-6');
  assert.equal(effective.effort, 'high');

  const tool = {
    type: 'function',
    function: {
      name: 'classify',
      description: 'Classify',
      parameters: {
        type: 'object',
        required: ['decision', 'reason', 'blocked_effect'],
        properties: {
          decision: { type: 'string', enum: ['ALLOW', 'BLOCK'] },
          reason: { type: 'string' },
          blocked_effect: { type: 'string', enum: ['none'] },
        },
      },
    },
  };
  const library = {
    CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL: tool,
    SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT: 'Review.',
    SmartModeClassifierResult: class { constructor(value) { Object.assign(this, value); } },
  };
  const seen = [];
  const classifier = createLocalClassifier({ ...defaultRoute, modelRouting: routing, usageDirectory }, library, {
    log() {},
    fetchImpl: async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        id: 'msg_1',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 't1', name: 'classify', input: { decision: 'ALLOW', reason: 'Safe', blocked_effect: 'none' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const res = await classifier.execute(undefined, { target: { action: 'run', arguments: { command: 'ls' } }, conversationContext: [] });
  assert.equal(res.result.value.decision, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://claude.example/v1/messages');
  assert.equal(seen[0].body.model, 'claude-sonnet-4-6');
  assert.equal(seen[0].body.output_config?.effort, 'high');
});

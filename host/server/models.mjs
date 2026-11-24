import { catalogContextPolicy, defaultPolicy, effortLevels, parseModelPolicy, validatePolicy, EFFORTS, MAX_CATALOG_MODELS } from '../runtime/model-policy.mjs';
import { createModelRouter } from '../runtime/model-router.mjs';
import { anthropicEndpoint, anthropicHeaders } from '../runtime/anthropic-messages.mjs';
import { createModelSession } from '../runtime/model-session.mjs';
import { API_FORMATS, MODEL_ROUTING_ENV, defaultAdaptiveRouting, emptyModelRouting, isConfiguredModelRouting, modelRouteForAgent, modelRouteForProfile,
  parseModelRouting, publicModelRouting, validateModelProvider, validateModelRouting } from '../runtime/model-routing.mjs';
import { recordUsage } from '../runtime/usage-ledger.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check } from './security.mjs';
import { JsonStore, readJson, writePrivate } from './storage.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const clean = (value, label, maximum = 2048) => {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value), 400,
    `${label}不能为空，也不能包含换行`);
  return value.trim();
};

function redactSecrets(message, secrets = []) {
  let out = String(message ?? '');
  const unique = [...new Set(secrets.filter(item => typeof item === 'string' && item.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const secret of unique) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

async function safeReadJsonObject(filePath) {
  try {
    const value = await readJson(filePath, null);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function valuesFrom(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}

function legacyConfig(values) {
  return {
    apiFormat: API_FORMATS.includes(values.MODEL_API_FORMAT) ? values.MODEL_API_FORMAT : 'openai',
    baseUrl: values.OPENAI_BASE_URL ?? '', model: values.OPENAI_MODEL ?? '', apiKey: values.OPENAI_API_KEY ?? '',
    contextWindowTokens: Number(values.OPENAI_CONTEXT_WINDOW_TOKENS ?? 0),
    policy: parseModelPolicy(values.ROKBOT_MODEL_POLICY ?? values.GROKBOT_MODEL_POLICY, values.OPENAI_MODEL || undefined),
    jevApiKey: values.JEV_API_KEY || '',
  };
}

function context(value) {
  const parsed = Number(value ?? 0);
  check(Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 100_000_000, 400,
    '上下文长度应为 0–100000000 的整数');
  return parsed;
}

function serviceUrl(value) {
  const baseUrl = clean(value, 'Base URL');
  let url;
  try { url = new URL(baseUrl); }
  catch { check(false, 400, 'Base URL 格式不正确'); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    400, 'Base URL 需要 HTTP(S) 地址，不能包含凭证或查询参数');
  return url.href.replace(/\/$/, '');
}

function publicError(error) {
  return `模型配置无效：${String(error?.message ?? error).slice(0, 240)}`;
}

function compatibilityPolicy(route) {
  const policy = defaultPolicy(route.model);
  policy.effort = route.effort;
  policy.models = [{ id: route.model, efforts: route.efforts,
    contextWindowTokens: route.contextWindowTokens, summaryThresholdTokens: route.summaryThresholdTokens }];
  return policy;
}

export class DeviceModelSettings {
  constructor(dataDir) {
    this.store = new JsonStore(join(dataDir, 'model-settings.json'), {
      version: 1,
      allowDeviceModelConfig: true,
      allowGuestModelConfig: false,
    });
  }
  async load() {
    await this.store.load();
    return this;
  }
  envAllowed() {
    return (process.env.ROKBOT_ALLOW_DEVICE_MODEL_CONFIG ?? process.env.GROKBOT_ALLOW_DEVICE_MODEL_CONFIG) !== '0';
  }
  current() {
    const envAllowed = this.envAllowed();
    return {
      allowDeviceModelConfig: this.store.value.allowDeviceModelConfig !== false,
      allowGuestModelConfig: this.store.value.allowGuestModelConfig === true,
      envAllowed,
      envDisabled: !envAllowed,
    };
  }
  async save(input = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '客户端模型配置策略无效');
    if (own(input, 'allowDeviceModelConfig')) {
      check(typeof input.allowDeviceModelConfig === 'boolean', 400, '允许客户端配置模型开关无效');
    }
    if (own(input, 'allowGuestModelConfig')) {
      check(typeof input.allowGuestModelConfig === 'boolean', 400, '允许配对码设备配置模型开关无效');
    }
    await this.store.mutate(state => {
      if (own(input, 'allowDeviceModelConfig')) state.allowDeviceModelConfig = input.allowDeviceModelConfig;
      if (own(input, 'allowGuestModelConfig')) state.allowGuestModelConfig = input.allowGuestModelConfig;
    });
    return this.current();
  }
}

export class Models {
  constructor(dataDir, { filename = join(dataDir, 'model.env'), onModelSaved = null, getReloadStatus = null } = {}) {
    this.filename = filename;
    this.dataDir = dataDir;
    this.onModelSaved = onModelSaved;
    this.getReloadStatus = getReloadStatus;
    this.tail = Promise.resolve();
  }
  async current() {
    const source = await readFile(this.filename, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const values = valuesFrom(source), legacy = legacyConfig(values);
    const parsed = parseModelRouting(values[MODEL_ROUTING_ENV] ?? values.GROKBOT_MODEL_ROUTING, legacy);
    let primary;
    try { primary = modelRouteForAgent(parsed.config); }
    catch { primary = undefined; }
    return { ...legacy, routing: parsed.config, routingMigrated: parsed.migrated,
      legacyAdaptiveRouting: parsed.migrated && legacy.policy?.mode === 'adaptive',
      ...(primary ? { baseUrl: primary.baseUrl, apiKey: primary.apiKey, apiFormat: primary.apiFormat,
        model: primary.model, contextWindowTokens: primary.contextWindowTokens, policy: compatibilityPolicy(primary) } : {}) };
  }
  emptyCurrent({ corruptConfig = false } = {}) {
    return {
      apiFormat: 'openai',
      baseUrl: '',
      model: '',
      apiKey: '',
      contextWindowTokens: 0,
      policy: defaultPolicy(),
      jevApiKey: '',
      routing: emptyModelRouting(),
      routingMigrated: false,
      legacyAdaptiveRouting: false,
      ...(corruptConfig ? { corruptConfig: true } : {}),
    };
  }
  async currentOrEmpty() {
    try {
      return await this.current();
    } catch {
      return this.emptyCurrent({ corruptConfig: true });
    }
  }
  async publicConfig() {
    const current = await this.currentOrEmpty();
    const { apiKey, jevApiKey, routing, ...summary } = current;
    return {
      ...publicModelRouting(routing),
      ...summary,
      hasApiKey: Boolean(apiKey), hasJevApiKey: Boolean(jevApiKey),
      configured: isConfiguredModelRouting(routing),
      reload: await this.reloadStatus(),
    };
  }
  async statusSummary() {
    try {
      const current = await this.current();
      const configured = isConfiguredModelRouting(current.routing);
      return { configured, needsModel: !configured };
    } catch {
      return { configured: false, needsModel: true };
    }
  }
  async localReloadStatus() {
    const raw = this.getReloadStatus ? await this.getReloadStatus() : await this.reloadStatus();
    const rawStatus = raw?.status ?? 'none';
    const status = rawStatus === 'pending'
      ? 'waiting'
      : (['none', 'waiting', 'applied', 'error'].includes(rawStatus) ? rawStatus : 'waiting');
    return {
      revision: raw?.revision ?? null,
      status,
      error: status === 'error' ? (raw?.error ?? raw?.message ?? 'Host 未能应用配置，请检查服务日志') : null,
      updatedAt: raw?.updatedAt ?? null,
    };
  }
  async reloadStatus() {
    const request = await safeReadJsonObject(join(this.dataDir, 'model-reload-request.json'));
    const status = await safeReadJsonObject(join(this.dataDir, 'model-reload-status.json'));
    const sanitizeMessage = value => {
      if (typeof value !== 'string') return undefined;
      const cleaned = value.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 300);
      return cleaned || undefined;
    };
    const allowed = ['applied', 'waiting', 'error', 'pending'];
    const requestRevision = typeof request?.revision === 'string' && request.revision.length > 0
      ? request.revision
      : null;
    if (!requestRevision) {
      if (!status) return { status: 'none' };
      const normalizedStatus = allowed.includes(status.status) ? status.status : 'none';
      if (normalizedStatus === 'none') return { status: 'none' };
      const msg = sanitizeMessage(status.error ?? status.message);
      return {
        ...(typeof status.revision === 'string' ? { revision: status.revision } : {}),
        status: normalizedStatus,
        ...(typeof status.updatedAt === 'string' ? { updatedAt: status.updatedAt } : {}),
        ...(normalizedStatus === 'error' ? { message: msg ?? 'Host 未能应用配置，请检查服务日志' } : (msg ? { message: msg } : {})),
      };
    }
    if (status && typeof status.revision === 'string' && status.revision === requestRevision) {
      const normalizedStatus = allowed.includes(status.status) ? status.status : 'pending';
      const msg = sanitizeMessage(status.error ?? status.message);
      return {
        revision: status.revision,
        status: normalizedStatus,
        ...(typeof status.updatedAt === 'string' ? { updatedAt: status.updatedAt } : {}),
        ...(normalizedStatus === 'error' ? { message: msg ?? 'Host 未能应用配置，请检查服务日志' } : (msg ? { message: msg } : {})),
      };
    }
    return {
      revision: requestRevision,
      status: 'pending',
      ...(typeof request.requestedAt === 'string' ? { updatedAt: request.requestedAt } : {}),
    };
  }
  legacyRouting(input, previous) {
    const apiFormat = input.apiFormat ?? previous.apiFormat;
    check(API_FORMATS.includes(apiFormat), 400, '接口格式无效');
    const baseUrl = serviceUrl(input.baseUrl ?? previous.baseUrl);
    const model = clean(input.model ?? previous.model, '模型名称', 256);
    const active = (() => { try { return modelRouteForAgent(previous.routing); } catch { return undefined; } })();
    const suppliedKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : '';
    const apiKey = clean(suppliedKey || active?.apiKey || previous.apiKey, 'API Key', 8192);
    const contextWindowTokens = context(input.contextWindowTokens ?? active?.contextWindowTokens ?? previous.contextWindowTokens);
    let policy;
    try {
      policy = validatePolicy(input.policy ?? (previous.model === model ? previous.policy : defaultPolicy(model)), model);
    } catch (error) { check(false, 400, error.message); }
    const hasJevKey = typeof input.jevApiKey === 'string' && input.jevApiKey.trim().length > 0;
    check(policy.mode !== 'adaptive' || (hasJevKey || previous.jevApiKey), 400, '请填写 Jev API Key');
    const providerId = active?.providerId ?? 'default', profileId = active?.profileId ?? 'default';
    const capability = policy.models.find(item => item.id === model) ?? { efforts: effortLevels(model) };
    const providers = (previous.routing.providers ?? []).filter(item => item.id !== providerId);
    providers.push({ id: providerId, name: active?.providerName ?? '默认服务', apiFormat, baseUrl, apiKey });
    const profiles = (previous.routing.profiles ?? []).filter(item => item.id !== profileId);
    profiles.push({ id: profileId, name: active?.profileName ?? '默认模型', providerId, model,
      efforts: capability.efforts, contextWindowTokens: capability.contextWindowTokens ?? contextWindowTokens,
      summaryThresholdTokens: capability.summaryThresholdTokens ?? 0 });
    let routing;
    try {
      routing = validateModelRouting({ version: 1, providers, profiles,
        defaultRoute: { profileId, effort: policy.effort, fallbacks: previous.routing.defaultRoute?.fallbacks ?? [] },
        botRoutes: previous.routing.botRoutes ?? {} }, { previous: previous.routing });
    } catch (error) { check(false, 400, publicError(error)); }
    return { routing, jevApiKey: hasJevKey ? clean(input.jevApiKey, 'Jev API Key', 8192) : previous.jevApiKey,
      ...(previous.routingMigrated ? { legacy: { apiFormat, baseUrl, apiKey, model, contextWindowTokens, policy } } : {}) };
  }
  async validated(input = {}, { requireJevKey = true } = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '模型配置无效');
    const previous = await this.currentOrEmpty();
    const multiProvider = Array.isArray(input.providers) || own(input, 'defaultRoute') || input.version === 1;
    if (!multiProvider) return this.legacyRouting(input, previous);
    const hasLegacyConfig = previous.routingMigrated && (
      previous.routing.providers.length > 0 ||
      Boolean(previous.baseUrl || previous.apiKey || previous.model || previous.jevApiKey)
    );
    check(!hasLegacyConfig || input.migrateLegacyRouting === true, 409,
      '检测到旧版模型配置。请在模型页确认迁移后再保存。');
    let routing;
    try { routing = validateModelRouting(input, { previous: previous.routing }); }
    catch (error) { check(false, 400, publicError(error)); }
    const hasJevKey = typeof input.jevApiKey === 'string' && input.jevApiKey.trim().length > 0;
    const clearJevKey = input.clearJevApiKey === true && !hasJevKey;
    const jevApiKey = clearJevKey ? '' : (hasJevKey ? clean(input.jevApiKey, 'Jev API Key', 8192) : previous.jevApiKey);
    check(!requireJevKey || !routing.adaptiveRouting?.enabled || Boolean(jevApiKey), 400, '请填写 Jev API Key');
    return { routing, jevApiKey };
  }
  async write(config) {
    if (config.legacy) {
      const { apiFormat, baseUrl, apiKey, model, contextWindowTokens, policy } = config.legacy;
      await writePrivate(this.filename, [
        `MODEL_API_FORMAT=${apiFormat}`,
        `OPENAI_BASE_URL=${baseUrl}`,
        `OPENAI_API_KEY=${apiKey}`,
        `OPENAI_MODEL=${model}`,
        `OPENAI_CONTEXT_WINDOW_TOKENS=${contextWindowTokens}`,
        `ROKBOT_MODEL_POLICY=${JSON.stringify(policy)}`,
        `JEV_API_KEY=${config.jevApiKey}`,
        '',
      ].join('\n'));
      return;
    }
    const primary = modelRouteForAgent(config.routing);
    const policy = compatibilityPolicy(primary);
    await writePrivate(this.filename, [
      `${MODEL_ROUTING_ENV}=${JSON.stringify(config.routing)}`,
      `MODEL_API_FORMAT=${primary.apiFormat}`,
      `OPENAI_BASE_URL=${primary.baseUrl}`,
      `OPENAI_API_KEY=${primary.apiKey}`,
      `OPENAI_MODEL=${primary.model}`,
      `OPENAI_CONTEXT_WINDOW_TOKENS=${primary.contextWindowTokens}`,
      `ROKBOT_MODEL_POLICY=${JSON.stringify(policy)}`,
      `JEV_API_KEY=${config.jevApiKey}`,
      '',
    ].join('\n'));
  }
  save(input) {
    const pending = this.tail.then(async () => {
      const config = await this.validated(input);
      await this.write(config);
      const request = { revision: randomUUID(), requestedAt: new Date().toISOString() };
      await writePrivate(join(this.dataDir, 'model-reload-request.json'), `${JSON.stringify(request)}\n`);
      if (this.onModelSaved) await this.onModelSaved({ revision: request.revision, requestedAt: request.requestedAt, config });
      return this.publicConfig();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
  async routeFor(input = {}, { profileId, direct = false } = {}) {
    const hasConfig = Array.isArray(input.providers) || own(input, 'defaultRoute') || input.version === 1 || own(input, 'baseUrl') || own(input, 'model') || own(input, 'apiKey');
    const current = hasConfig ? null : await this.currentOrEmpty();
    const config = hasConfig
      ? await this.validated(input, { requireJevKey: false })
      : { routing: current.routing, jevApiKey: current.jevApiKey };
    try {
      if (profileId) return { config, route: modelRouteForProfile(config.routing, profileId) };
      const route = modelRouteForAgent(config.routing);
      return { config, route: direct ? { ...route, fallbacks: [] } : route };
    } catch (error) {
      check(false, 400, publicError(error));
    }
  }
  async catalog(input = {}) {
    const previous = await this.currentOrEmpty();
    let provider;
    if (input.provider) {
      try { provider = validateModelProvider(input.provider, { previous: previous.routing }); }
      catch (error) { check(false, 400, publicError(error)); }
    } else if (input.providerId && !Array.isArray(input.providers) && !own(input, 'baseUrl')) {
      provider = previous.routing.providers.find(item => item.id === input.providerId);
      check(provider, 404, '模型服务不存在');
    } else {
      const { route } = await this.routeFor(input, { profileId: input.profileId, direct: true });
      provider = route;
    }
    let response;
    const anthropic = provider.apiFormat === 'anthropic';
    try {
      response = await fetch(anthropic ? anthropicEndpoint(provider.baseUrl, 'models') : `${provider.baseUrl}/models`, {
        redirect: 'error', headers: anthropic ? anthropicHeaders(provider.apiKey) : { authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch { check(false, 502, '无法读取模型列表'); }
    check(response.ok, 502, `Model catalog HTTP ${response.status}`);
    const body = await response.json().catch(() => null);
    check(Array.isArray(body?.data), 502, '模型列表格式不兼容');
    const seen = new Set();
    const entries = [];
    for (const item of body.data) {
      if (typeof item?.id !== 'string') continue;
      const id = item.id.trim();
      if (!id || id.length > 256 || /[\r\n\0]/.test(id) || seen.has(id)) continue;
      seen.add(id);
      entries.push({ item, id });
      if (entries.length >= MAX_CATALOG_MODELS) break;
    }
    return { models: entries.map(({ item, id }) => {
      const supplied = item.supported_reasoning_efforts ?? item.supported_efforts ?? item.reasoning_effort?.values ?? item.capabilities?.reasoning_efforts;
      const levels = Array.isArray(supplied) ? EFFORTS.filter(level => supplied.includes(level)) : null;
      // Context capacity as reported by OpenAI-style and Anthropic catalogs.
      const capacity = [item.context_window, item.max_input_tokens, item.context_length]
        .find(value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000);
      return { id, efforts: levels ?? effortLevels(id), source: levels ? 'provider' : effortLevels(id).length ? 'reference' : 'manual',
        ...catalogContextPolicy(id, capacity) };
    }) };
  }
  async classify(input = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '模型配置无效');
    const task = clean(input.task, '任务', 10000);
    const current = await this.currentOrEmpty();
    const hasV1Payload = Array.isArray(input.providers) || own(input, 'defaultRoute') || input.version === 1;
    let routing = current.routing;
    let jevApiKey = current.jevApiKey;
    if (hasV1Payload) {
      const hasSuppliedJev = typeof input.jevApiKey === 'string' && input.jevApiKey.trim().length > 0;
      const candidateJev = hasSuppliedJev ? clean(input.jevApiKey, 'Jev API Key', 8192) : current.jevApiKey;
      check(candidateJev, 400, '请填写 Jev API Key');
      const validated = await this.validated({
        ...input,
        adaptiveRouting: { ...(input.adaptiveRouting ?? {}), enabled: true },
        jevApiKey: candidateJev,
      });
      routing = validated.routing;
      jevApiKey = validated.jevApiKey;
    } else if (current.routingMigrated && (own(input, 'baseUrl') || own(input, 'model') || own(input, 'policy'))) {
      const base = { ...current, ...input };
      const config = await this.legacyRouting(base, current);
      routing = config.routing;
      jevApiKey = config.jevApiKey;
    } else if (own(input, 'adaptiveRouting') || own(input, 'jevApiKey')) {
      const hasSuppliedJev = typeof input.jevApiKey === 'string' && input.jevApiKey.trim().length > 0;
      jevApiKey = hasSuppliedJev ? clean(input.jevApiKey, 'Jev API Key', 8192) : current.jevApiKey;
      if (own(input, 'adaptiveRouting')) {
        try {
          routing = validateModelRouting({ ...current.routing, adaptiveRouting: { ...input.adaptiveRouting, enabled: true } }, { previous: current.routing });
        } catch (error) { check(false, 400, publicError(error)); }
      }
    }
    check(jevApiKey, 400, '请填写 Jev API Key');
    if (routing?.providers?.length && routing?.profiles?.length && routing?.defaultRoute) {
      const adaptive = routing.adaptiveRouting?.tiers
        ? { ...routing.adaptiveRouting, enabled: true }
        : defaultAdaptiveRouting(routing, { enabled: true });
      const testRouting = { ...routing, adaptiveRouting: adaptive };
      const route = modelRouteForAgent(testRouting);
      const router = createModelRouter({ ...route, modelRouting: testRouting, jevApiKey,
        usageDirectory: join(this.dataDir, 'usage'), routingDirectory: join(this.dataDir, 'routing'), routingSource: 'test' });
      const decision = await router({ messages: [{ role: 'user', content: task }] });
      const { requestOptions, apiKey, baseUrl, fallbacks, ...result } = decision;
      return result;
    }
    const base = { ...current, ...input };
    const config = await this.legacyRouting(base, current);
    const route = modelRouteForAgent(config.routing);
    const policy = { ...compatibilityPolicy(route), mode: 'adaptive' };
    const router = createModelRouter({ ...route, policy, jevApiKey: config.jevApiKey,
      usageDirectory: join(this.dataDir, 'usage'), routingDirectory: join(this.dataDir, 'routing'), routingSource: 'test' });
    const decision = await router({ messages: [{ role: 'user', content: task }] });
    const { requestOptions, apiKey, baseUrl, fallbacks, ...result } = decision;
    return result;
  }
  async test(input = {}) {
    const { config, route } = await this.routeFor(input, { profileId: input.profileId, direct: true });
    let usage;
    const session = createModelSession({ ...route, policy: compatibilityPolicy(route),
      onUsage: async value => { usage = value; }, selectRequest: async () => ({ ...route, fallbacks: [] }) });
    const startedAt = Date.now();
    const result = session.getExecutor([{ role: 'user', content: 'Reply with OK.' }])
      .stream({ signal: AbortSignal.timeout(120_000) }, 'model-test', []);
    let text = '';
    try {
      for await (const part of result.fullStream) if (part.type === 'text-delta') text += part.textDelta;
      await result.response;
    } catch (error) {
      const secrets = [
        route.apiKey,
        ...(route.fallbacks ?? []).map(item => item?.apiKey),
        ...(config?.routing?.providers ?? []).map(item => item?.apiKey),
        config?.jevApiKey,
      ];
      const safeMessage = redactSecrets(error?.message ?? error, secrets).slice(0, 300);
      check(false, 502, error.name === 'TimeoutError' || error.name === 'AbortError' ? '模型服务连接超时，请检查地址与网络'
        : error.status ? `模型服务返回 HTTP ${error.status}：${safeMessage}`
          : `模型请求失败：${safeMessage}`);
    } finally {
      if (usage) await recordUsage(join(this.dataDir, 'usage'), { ...usage, kind: 'test' }).catch(() => {});
    }
    check(text.trim(), 502, '模型没有返回文字内容');
    return {
      ok: true,
      profileId: route.profileId,
      model: route.model,
      reply: text.trim(),
      latencyMs: Math.max(0, Date.now() - startedAt),
      message: '模型接口已完成真实请求',
    };
  }
}

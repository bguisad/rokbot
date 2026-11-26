import { randomUUID } from 'node:crypto';
import { recordUsage } from './usage-ledger.mjs';
import { anthropicEndpoint, anthropicHeaders, anthropicOptions, anthropicUsage } from './anthropic-messages.mjs';
import { chatEndpoint, chatReasoning, maxTokensParameter } from './openai-chat.mjs';
import { reasons, responsesEndpoint, responsesUsage } from './openai-responses.mjs';
import { postWithFallback } from './model-common.mjs';
import { modelRouteForScenario } from './model-routing.mjs';

const OUTPUT_LIMIT = 16_000;
// Classification needs little reasoning; use an explicit scenario effort if set, otherwise the lowest offered level.
function reviewEffort(config) {
  if (config.effort && config.effort !== 'default') return config.effort;
  const efforts = config.efforts ?? config.policy?.models?.find(entry => entry.id === config.model)?.efforts ?? [];
  return ['low', 'minimal', 'medium'].find(level => efforts.includes(level));
}

export function resolveAutoReviewConfig(config) {
  if (!config?.modelRouting) return config;
  const route = modelRouteForScenario(config.modelRouting, 'autoReview', { direct: true });
  return {
    ...config,
    ...route,
    policy: {
      ...(config.policy ?? {}),
      models: [{
        id: route.model,
        efforts: route.efforts,
        contextWindowTokens: route.contextWindowTokens,
        summaryThresholdTokens: route.summaryThresholdTokens,
      }],
    },
  };
}
/** The model answered, but not with one valid classification; worth one more attempt. */
class ReviewOutputError extends Error {}
const forcedChoiceRejected = error => error.status === 400 && /tool_choice|tool choice/i.test(error.message);
const onlyTool = name => `\n\nRespond only by calling the ${name} tool exactly once.`;

function single(calls, name, truncated) {
  if (truncated || calls.length !== 1 || calls[0].name !== name) throw new ReviewOutputError('Auto-review model did not return one complete classification');
  if (typeof calls[0].arguments !== 'string') return calls[0].arguments;
  try { return JSON.parse(calls[0].arguments); }
  catch { throw new ReviewOutputError('Auto-review model returned invalid JSON'); }
}

async function classifyWithChat(config, library, tool, content, signal, fetchImpl, state) {
  let forced = !state.autoToolChoice;
  const { http } = await postWithFallback({ fetchImpl, url: chatEndpoint(config.baseUrl), apiKey: config.apiKey, signal, state,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    optional: ['reasoning_effort', 'thinking', 'parallel_tool_calls', 'max_tokens', 'max_completion_tokens'],
    fallbacks: [{ name: 'automatic tool choice', applies: error => forced && forcedChoiceRejected(error), apply: () => { forced = false; state.autoToolChoice = true; } }],
    build: () => {
      const limit = maxTokensParameter(config.model, state.dropped);
      return { model: config.model, stream: false, ...chatReasoning(config.model, reviewEffort(config)), ...(limit ? { [limit]: OUTPUT_LIMIT } : {}),
        messages: [{ role: 'system', content: library.SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT + (forced ? '' : onlyTool(tool.function.name)) },
          { role: 'user', content }], tools: [tool], parallel_tool_calls: false,
        tool_choice: forced ? { type: 'function', function: { name: tool.function.name } } : 'auto' };
    } });
  const reply = await http.json();
  await recordUsage(config.usageDirectory, { raw: reply.usage, model: reply.model ?? config.model, kind: 'review', requestId: reply.id });
  const calls = (reply.choices?.[0]?.message?.tool_calls ?? []).map(call => ({ name: call.function?.name, arguments: call.function?.arguments }));
  return { id: reply.id, decision: single(calls, tool.function.name, reply.choices?.[0]?.finish_reason === 'length') };
}

async function classifyWithResponses(config, library, tool, content, signal, fetchImpl, state) {
  let forced = !state.autoToolChoice;
  const efforts = config.policy?.models?.find(entry => entry.id === config.model)?.efforts, effort = reviewEffort(config);
  const { http } = await postWithFallback({ fetchImpl, url: responsesEndpoint(config.baseUrl), apiKey: config.apiKey, signal, state,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    optional: ['reasoning.effort', 'reasoning', 'parallel_tool_calls', 'store', 'max_output_tokens'],
    fallbacks: [{ name: 'automatic tool choice', applies: error => forced && forcedChoiceRejected(error), apply: () => { forced = false; state.autoToolChoice = true; } }],
    build: () => ({ model: config.model, store: false, max_output_tokens: OUTPUT_LIMIT,
      ...(reasons(efforts) && effort ? { reasoning: { effort } } : {}),
      instructions: library.SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT + (forced ? '' : onlyTool(tool.function.name)),
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: content }] }],
      tools: [{ type: 'function', name: tool.function.name, description: tool.function.description ?? '', parameters: tool.function.parameters, strict: false }],
      parallel_tool_calls: false, tool_choice: forced ? { type: 'function', name: tool.function.name } : 'auto' }) });
  const reply = await http.json();
  await recordUsage(config.usageDirectory, { raw: responsesUsage(reply.usage), model: reply.model ?? config.model, kind: 'review', requestId: reply.id });
  const calls = (reply.output ?? []).filter(item => item.type === 'function_call');
  return { id: reply.id, decision: single(calls, tool.function.name, reply.status === 'incomplete') };
}

/** Messages API classification. Forced tool choice is unavailable on current Claude models. */
async function classifyWithAnthropic(config, library, tool, content, signal, fetchImpl, state) {
  const { http } = await postWithFallback({ fetchImpl, url: anthropicEndpoint(config.baseUrl), apiKey: config.apiKey, signal, state,
    headers: body => anthropicHeaders(config.apiKey, { body }), optional: ['fallbacks', 'thinking.display', 'output_config'],
    build: () => ({ model: config.model, ...anthropicOptions(config.model, { effort: reviewEffort(config) ?? 'low', maxTokens: OUTPUT_LIMIT }),
      system: library.SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT + onlyTool(tool.function.name),
      messages: [{ role: 'user', content }], tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      tools: [{ name: tool.function.name, description: tool.function.description ?? '', input_schema: tool.function.parameters }] }) });
  const reply = await http.json();
  await recordUsage(config.usageDirectory, { raw: anthropicUsage(reply.usage), model: reply.model ?? config.model, kind: 'review', requestId: reply.id });
  const calls = (reply.content ?? []).filter(block => block.type === 'tool_use').map(block => ({ name: block.name, arguments: block.input }));
  return { id: reply.id, decision: single(calls, tool.function.name, reply.stop_reason === 'max_tokens') };
}

const CLASSIFIERS = { openai: classifyWithChat, 'openai-responses': classifyWithResponses, anthropic: classifyWithAnthropic };

function validate(decision, schema) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new ReviewOutputError('Invalid auto-review classification');
  for (const name of schema.required) {
    if (typeof decision[name] !== 'string' || !decision[name].trim() ||
      (schema.properties[name].enum && !schema.properties[name].enum.includes(decision[name])))
      throw new ReviewOutputError(`Invalid auto-review classification field: ${name}`);
  }
  if (decision.decision === 'BLOCK' && decision.blocked_effect === 'none')
    throw new ReviewOutputError('Auto-review returned an inconsistent decision');
  const outbound = ['outbound_or_binding_external_effect', 'data_or_credential_exfiltration'].includes(decision.blocked_effect);
  if (decision.decision === 'BLOCK' && outbound &&
    (decision.outbound_authorization !== 'unauthorized_destination' || !decision.who_sees_it?.trim()))
    throw new ReviewOutputError('Auto-review returned an incomplete outbound decision');
  if (decision.proposed_allow_rule !== undefined && typeof decision.proposed_allow_rule !== 'string')
    throw new ReviewOutputError('Invalid auto-review proposed rule');
}

/** Use the shipped classifier policy/schema and approval state machine with the configured model. */
export function createLocalClassifier(config, library, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const effective = resolveAutoReviewConfig(config);
  const tool = library.CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL;
  const schema = tool.function.parameters;
  // Parameters a compatible service rejected stay dropped for later reviews.
  const state = { dropped: new Set(), autoToolChoice: false };
  return {
    async execute(ctx, args) {
      const target = args.target?.toJson ? args.target.toJson() : args.target;
      if (!target || typeof target.action !== 'string') throw new Error('Auto-review target is missing');
      const messages = args.conversationContext ?? [];
      const input = {
        trusted_user_instructions: messages.filter(item => item.role === 'user').map(item => item.content),
        untrusted_agent_narration_and_prior_actions: messages.filter(item => item.role !== 'user')
          .map(item => ({ role: item.role, content: item.content })),
        proposed_tool_call: target,
        trusted_auto_run_policy_instructions: target.arguments?.project_permissions?.auto_run ?? {},
      };
      const content = JSON.stringify(input);
      if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Auto-review context exceeds the supported size');
      const signal = ctx?.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
      const classify = CLASSIFIERS[effective.apiFormat] ?? classifyWithChat;
      let replyId, decision;
      // A malformed answer is retried once; service errors and cancellation are not.
      for (let attempt = 1; ; attempt++) {
        try {
          ({ id: replyId, decision } = await classify(effective, library, tool, content, signal, fetchImpl, state));
          validate(decision, schema);
          break;
        } catch (error) {
          const retry = error instanceof ReviewOutputError && attempt < 2 && !signal.aborted;
          log(`Local auto-review ${retry ? 'retrying after' : 'failed'}: ${error.message}; model=${effective.model}`);
          if (!retry) throw error;
        }
      }
      const proposedRule = decision.proposed_allow_rule;
      log(`Local auto-review ${decision.decision}; model=${effective.model}; request=${String(replyId ?? 'unavailable').slice(0, 128)}`);
      return new library.SmartModeClassifierResult({ result: { case: 'success', value: {
        decision: decision.decision === 'ALLOW' ? 1 : 2,
        ...(decision.decision === 'BLOCK' ? { blockReason: decision.reason.slice(0, 500) } : {}),
        ...(decision.decision === 'BLOCK' && proposedRule ? { proposedAllowRule: proposedRule.slice(0, 500) } : {}),
      } } });
    },
  };
}

export function startLocalAutoReview(context, library, config, deps = {}) {
  const auth = deps.auth ?? context.deps?.auth;
  const settings = deps.settings ?? context.deps?.settings;
  const telemetry = deps.telemetry ?? context.deps?.telemetry;
  const transcript = deps.transcript ?? context.deps?.transcript;
  const createClassifierExecutor = () =>
    createLocalClassifier(config, library, { log: message => context.host.log(message) });
  const hostGeneration = randomUUID();
  const service = new library.AutoReviewService({
    auth,
    experiments: { checkFeatureGate: () => true },
    settings,
    telemetry: telemetry?.logs,
    awaitingSink: transcript.createAwaitingStateSink(),
    transcript,
    hostGeneration, localMode: 'enforce',
    createClassifierExecutor,
  });
  if (typeof service.createClassifierExecutor !== 'function') {
    service.createClassifierExecutor = createClassifierExecutor;
  }
  // Live cards are answered here; anything else falls through to the original stale-card path.
  const approvals = createApprovalRegistry();
  const resolveStale = typeof service.resolveApproval === 'function'
    ? service.resolveApproval.bind(service)
    : async () => { throw Object.assign(new Error('auto-review/stale'), { failureCode: 'auto-review/stale' }); };
  service.approvals = approvals;
  service.resolveApproval = async args => {
    if (approvals.resolve(args ?? {})) return;
    return resolveStale(args);
  };
  const ttlMs = Number(process.env.ROKBOT_AUTO_REVIEW_APPROVAL_TTL_MS) > 0
    ? Number(process.env.ROKBOT_AUTO_REVIEW_APPROVAL_TTL_MS) : AUTO_REVIEW_APPROVAL_TTL_MS;
  service.createController = options => createAutoReviewController({
    hostGeneration, ttlMs, log: message => context.host.log(message), ...options, registry: approvals,
  });
  if (typeof service.stop === 'function') {
    context.onStop(() => service.stop());
  }
  const startedAt = Date.now();
  const sweep = () => service.sweepStaleAwaitingBadges(() => transcript.listAgentIds(), startedAt);
  void transcript.expireAllPendingAutoReviewApprovalCards().then(sweep, sweep);
  return service;
}

// ---------------------------------------------------------------------------------------------
// Approval cards. 2bb5e41's AutoReviewService only settles stale cards; the controller the
// runner asks for an approval (requestApproval / cardReasonFor / getPendingApprovals /
// expireSurfaces / beginUserMessageEpoch ...) is not shipped, so a BLOCK could never become a
// card. This is that controller: one per runner (Bot), with the card ids kept in a registry on
// the auto-review extension so `resolveAutoReviewApproval` from any client finds them.

/** Surfaces the 2bb5e41 runner reviews (SAND_AUTO_REVIEW_MODES_OFF keys). */
export const AUTO_REVIEW_SURFACES = ['hostShell', 'boxShell', 'mcp', 'computer', 'automationWrite', 'cloudAgent', 'subagentLaunch'];
const modesOf = mode => Object.freeze(Object.fromEntries(AUTO_REVIEW_SURFACES.map(surface => [surface, mode])));
export const AUTO_REVIEW_MODES_OFF = modesOf('off');
export const AUTO_REVIEW_MODES_ENFORCE = modesOf('enforce');
/** The Auto-review switch: on enforces every surface, off reviews nothing. */
export const autoReviewModesFor = instructions =>
  (instructions?.isEnabled === true ? AUTO_REVIEW_MODES_ENFORCE : AUTO_REVIEW_MODES_OFF);

export const AUTO_REVIEW_AWAITING_TAB_ID = 'auto-review';
export const AUTO_REVIEW_APPROVAL_TTL_MS = 30 * 60 * 1000;
// Model-facing texts of the original harness (sand-auto-review.ts).
const USER_DECLINED_REASON = 'The user declined this action on its approval card, so nothing ran. Do not retry it; ask the user what they want to do instead.';
const PENDING_APPROVAL_REASON = "Another action is waiting for Auto-review approval; no new side effect may start yet. This call did not run and has no approval card of its own. Don't retry it or start any other action while another action's approval card is still waiting for the user. If that card is still unanswered, end your turn now and ask the user to approve or deny it. Once it has been answered, retry this call if it is still needed.";
// sandAutoReviewUnansweredEndingOf: why an unanswered card ended.
const UNANSWERED_ENDINGS = { ttl: 'expired', user_redirect: 'interrupted', cancelled: 'interrupted' };
const unansweredReason = cause => `This action did not run: its approval card ${UNANSWERED_ENDINGS[cause] === 'interrupted' ? 'was interrupted' : 'expired'} before anyone answered it.`;
// Runner surface names (createAutoReviewGate.currentModes) -> card surface.
const CARD_FIELDS = ['surface', 'summary', 'summaryCopy', 'reason', 'command', 'fullRequest', 'actionDescription', 'cautionNote',
  'cardReason', 'classifierErrorKind', 'blockedEffect', 'proposedRule', 'proposedRuleReplaces', 'appliedRules', 'toolSetting',
  'connector', 'mcpToolName', 'toolCallId'];

// The 2bb5e41 runner and classifier word their card texts for the official app ("Click Save on
// Grok Bot's computer", "Grok Bot will connect to it ..."). People see these on the card, its list
// badge and push, so name the product RokBot. Quoted user content (\u201C...\u201D, the runner's
// quoting of URLs and typed text), the command and the full request stay as they are: they say
// what will run.
const CARD_TEXT_FIELDS = ['summary', 'reason', 'cardReason', 'actionDescription', 'cautionNote', 'blockedEffect'];
const QUOTED = /(\u201C[^\u201D]*\u201D)/;
export function rokbotCardText(text) {
  if (typeof text !== 'string' || !text.includes('Grok Bot')) return text;
  return text.split(QUOTED).map((part, i) => (i % 2 ? part : part.replace(/\bGrok Bot\b/g, 'RokBot'))).join('');
}

function cardApprovalOf(request, requestId, now, ttlMs) {
  const approval = { requestId, status: 'pending' };
  for (const field of CARD_FIELDS) {
    const value = request[field];
    if (value === undefined || value === null || typeof value === 'function') continue;
    try { approval[field] = JSON.parse(JSON.stringify(value)); } catch { /* not plain data: leave it out */ }
  }
  for (const field of CARD_TEXT_FIELDS) approval[field] = rokbotCardText(approval[field]);
  approval.summary = String(approval.summary ?? approval.command ?? 'Approve this action').slice(0, 500);
  approval.reason = String(approval.reason ?? 'Auto-review blocked this action.').slice(0, 2000);
  approval.createdAtMs = now;
  approval.expiresAtMs = now + ttlMs;
  return approval;
}

/** requestId -> live card, shared by every Bot's controller. */
export function createApprovalRegistry() {
  const cards = new Map();
  return {
    add(requestId, card) { cards.set(requestId, card); },
    delete(requestId) { cards.delete(requestId); },
    get: requestId => cards.get(requestId),
    /** Settle a live card; false when no live card has this id (it is stale). */
    resolve({ requestId, agentId, entryId, resolution }) {
      const card = cards.get(requestId);
      if (!card) return false;
      if (agentId !== undefined && card.agentId !== agentId) return false;
      if (entryId !== undefined && card.entryId !== undefined && card.entryId !== entryId) return false;
      return card.settle(resolution);
    },
    pending: () => [...cards.values()],
  };
}

/**
 * The runner's `autoReviewController`. `postCard(message)` appends the send-message card and
 * resolves its entry id; `settleCard({ entryId, requestId, status })` rewrites its status;
 * `setAwaiting(state | null)` raises the Bot's "needs you" state (list badge, push).
 */
export function createAutoReviewController({ agentId, registry, postCard, settleCard, setAwaiting = () => {},
  log = () => {}, hostGeneration = randomUUID(), ttlMs = AUTO_REVIEW_APPROVAL_TTL_MS, now = Date.now }) {
  const pending = new Map(); // requestId -> card
  const shown = new Map(); // toolCallId -> { reason, fingerprint, approved, cause }
  const remember = (toolCallId, record) => {
    if (!toolCallId) return;
    shown.set(toolCallId, { ...shown.get(toolCallId), ...record });
    if (shown.size > 500) shown.delete(shown.keys().next().value);
  };
  const refreshAwaiting = () => {
    const newest = [...pending.values()].at(-1);
    try {
      setAwaiting(newest ? { tabId: AUTO_REVIEW_AWAITING_TAB_ID, reason: newest.approval.summary, since: newest.approval.createdAtMs } : null);
    } catch (error) { log(`Local auto-review could not update the awaiting state: ${error.message}`); }
  };

  function finish(card, { status, decision, cause }) {
    if (card.done) return false;
    card.done = true;
    clearTimeout(card.timer);
    card.unsubscribe?.();
    pending.delete(card.requestId);
    registry?.delete(card.requestId);
    remember(card.toolCallId, { approved: decision.approved, ...(cause ? { cause } : {}),
      ...(decision.approved ? { approvedFingerprint: card.fingerprint } : {}) });
    refreshAwaiting();
    log(`Local auto-review card ${status}; agent=${agentId}; request=${card.requestId}`);
    card.resolve(decision);
    void card.posted.then(entryId => entryId && settleCard({ entryId, requestId: card.requestId, status }))
      .catch(error => log(`Local auto-review could not update its card: ${error.message}`));
    return true;
  }
  const expireCard = (card, cause) => finish(card, { status: 'expired', cause,
    decision: { approved: false, reason: unansweredReason(cause) } });
  const expireWhere = (cause, keep = () => false) => {
    for (const card of [...pending.values()]) if (!keep(card)) expireCard(card, cause);
  };

  const controller = {
    hostGeneration,
    queuesApprovals: false,
    canPublishShares: false,
    waitsForOwner: false,
    async requestApproval(request) {
      if (request.signal?.aborted) return { approved: false, reason: unansweredReason('cancelled') };
      const others = [...pending.values()].filter(card => card.toolCallId !== request.toolCallId);
      if (others.length > 0) return { approved: false, reason: PENDING_APPROVAL_REASON };
      const requestId = randomUUID();
      const approval = cardApprovalOf(request, requestId, now(), ttlMs);
      let resolve;
      const decided = new Promise(r => { resolve = r; });
      const card = { requestId, agentId, toolCallId: request.toolCallId, fingerprint: request.fingerprint,
        surface: request.surface, approval, resolve, done: false };
      card.settle = resolution => finish(card, resolution === 'denied'
        ? { status: 'denied', decision: { approved: false, reason: USER_DECLINED_REASON } }
        : { status: resolution === 'always' ? 'always' : 'approved', decision: { approved: true } });
      pending.set(requestId, card);
      registry?.add(requestId, card);
      remember(request.toolCallId, { reason: approval.reason, fingerprint: request.fingerprint, approved: undefined });
      card.posted = Promise.resolve().then(() => postCard({ type: 'auto-review-approval', approval }));
      card.posted.then(entryId => { card.entryId = entryId; }, error => {
        log(`Local auto-review could not post its card: ${error.message}`);
        finish(card, { status: 'expired', cause: 'cancelled', decision: { approved: false, reason: unansweredReason('cancelled') } });
      });
      card.timer = setTimeout(() => expireCard(card, 'ttl'), ttlMs);
      card.timer.unref?.();
      if (request.signal) {
        const onAbort = () => expireCard(card, 'cancelled');
        request.signal.addEventListener('abort', onAbort, { once: true });
        card.unsubscribe = () => request.signal.removeEventListener('abort', onAbort);
      }
      refreshAwaiting();
      log(`Local auto-review approval card shown; agent=${agentId}; surface=${request.surface}; request=${requestId}`);
      return decided;
    },
    /** Runner.resolveAutoReviewApproval(requestId, resolution), or the RPC arguments object. */
    resolveApproval(requestId, resolution) {
      const args = typeof requestId === 'object' && requestId !== null ? requestId : { requestId, resolution };
      const card = pending.get(args.requestId);
      return card && card.settle(args.resolution) ? true : undefined;
    },
    cardReasonFor({ toolCallId } = {}) {
      return toolCallId ? shown.get(toolCallId)?.reason : undefined;
    },
    approvedFingerprintFor: toolCallId => shown.get(toolCallId)?.approvedFingerprint,
    retiredCauseFor: toolCallId => shown.get(toolCallId)?.cause,
    getPendingApprovals: () => [...pending.values()].map(card => ({ requestId: card.requestId, toolCallId: card.toolCallId,
      surface: card.surface, agentId, entryId: card.entryId })),
    /** Surfaces whose review was turned off: their cards cannot be answered any more. */
    expireSurfaces(retired) {
      if (!retired?.size) return;
      expireWhere('settings_change', card => !retired.has(card.surface));
    },
    /** A new user message redirects the Bot; cards of the previous turn end unanswered. */
    beginUserMessageEpoch() { expireWhere('user_redirect'); },
    expire(cause = 'session_end') { expireWhere(cause); },
    expireForHostPause() { expireWhere('quiesce'); },
    cancelHostPause() {},
    withdraw(toolCallId) { expireWhere('cancelled', card => card.toolCallId !== toolCallId); },
    waitForOwnerWith() {},
    ownerWaitDone() {},
    reportDisplayRecheckFailed() {},
    async queueApproval() { return undefined; },
  };
  return controller;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTO_REVIEW_MODES_ENFORCE, AUTO_REVIEW_MODES_OFF, autoReviewModesFor, createApprovalRegistry,
  createAutoReviewController, createLocalClassifier, rokbotCardText, startLocalAutoReview } from '../runtime/host-auto-review.mjs';
import { localAutoReviewOptions } from '../runtime/local-harness-bridge.mjs';

// Mirrors the shipped schema: action_description is required, and the model is told to answer an
// ALLOW with an empty string and a BLOCK with one sentence.
const tool = { type: 'function', function: { name: 'classify', description: 'Classify the action',
  parameters: { type: 'object', required: ['decision', 'reason', 'blocked_effect', 'action_description'], properties: {
    decision: { type: 'string', enum: ['ALLOW', 'BLOCK'] }, reason: { type: 'string' },
    action_description: { type: 'string' },
    blocked_effect: { type: 'string', enum: ['none', 'destructive_local_change', 'outbound_or_binding_external_effect'] } } } } };
const library = { CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL: tool, SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT: 'Review.',
  SmartModeClassifierResult: class { constructor(value) { Object.assign(this, value); } } };
const reply = content => new Response(JSON.stringify({ id: 'msg_1', model: 'm', stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 }, content }), { status: 200, headers: { 'content-type': 'application/json' } });
const textOnly = () => reply([{ type: 'text', text: 'Looks fine to me.' }]);
const valid = () => reply([{ type: 'tool_use', id: 't1', name: 'classify',
  input: { decision: 'ALLOW', reason: 'Read-only command', blocked_effect: 'none', action_description: '' } }]);
const blockReply = () => reply([{ type: 'tool_use', id: 't1', name: 'classify',
  input: { decision: 'BLOCK', reason: 'Deletes files', blocked_effect: 'destructive_local_change', action_description: '' } }]);

async function classifier(t, replies) {
  const usageDirectory = await mkdtemp(join(tmpdir(), 'review-test-'));
  t.after(() => rm(usageDirectory, { recursive: true, force: true }));
  const logs = [], requests = [];
  const instance = createLocalClassifier({ apiFormat: 'anthropic', baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', usageDirectory },
    library, { log: message => logs.push(message), fetchImpl: async (url, options) => { requests.push(url); return replies.shift()(); } });
  return { instance, logs, requests };
}
const args = { target: { action: 'run', arguments: { command: 'ver' } }, conversationContext: [{ role: 'user', content: 'Check the version' }] };

test('a malformed classification is retried once and then succeeds', async t => {
  const { instance, logs, requests } = await classifier(t, [textOnly, valid]);
  const result = await instance.execute(undefined, args);
  assert.equal(result.result.value.decision, 1);
  assert.equal(requests.length, 2);
  assert.match(logs[0], /retrying after: Auto-review model did not return one complete classification/);
  assert.match(logs[1], /Local auto-review ALLOW/);
});

test('a second malformed classification fails and is logged', async t => {
  const { instance, logs, requests } = await classifier(t, [textOnly, textOnly]);
  await assert.rejects(instance.execute(undefined, args), /did not return one complete classification/);
  assert.equal(requests.length, 2);
  assert.match(logs.at(-1), /Local auto-review failed/);
});

test('the configured Host model is asked and a BLOCK carries its reason and proposed rule', async t => {
  const block = () => reply([{ type: 'tool_use', id: 't1', name: 'classify', input: { decision: 'BLOCK',
    reason: 'Recursively deletes a directory', blocked_effect: 'destructive_local_change', proposed_allow_rule: 'Allow rm -rf in /tmp',
    action_description: 'Deletes the /tmp/x directory and everything in it' } }]);
  const { instance, logs, requests } = await classifier(t, [block]);
  const result = await instance.execute(undefined, { ...args, target: { action: 'run', arguments: { command: 'rm -rf /tmp/x' } } });
  assert.equal(requests[0], 'https://api.example.com/v1/messages');
  assert.equal(result.result.value.decision, 2);
  assert.equal(result.result.value.blockReason, 'Recursively deletes a directory');
  assert.equal(result.result.value.proposedAllowRule, 'Allow rm -rf in /tmp');
  assert.match(logs.at(-1), /^Local auto-review BLOCK; model=m;/);
});

test('service errors are not retried', async t => {
  const { instance, logs, requests } = await classifier(t, [() => new Response('{"error":{"message":"overloaded"}}', { status: 529 })]);
  await assert.rejects(instance.execute(undefined, args));
  assert.equal(requests.length, 1);
  assert.match(logs.at(-1), /Local auto-review failed/);
});

// --- Approval cards -------------------------------------------------------------------------

function cardHarness({ ttlMs = 60_000 } = {}) {
  const registry = createApprovalRegistry();
  const posted = [], settled = [], awaiting = [];
  const controller = createAutoReviewController({ agentId: 'bot-1', registry, ttlMs,
    postCard: message => { posted.push(message); return `send-${posted.length}`; },
    settleCard: change => settled.push(change), setAwaiting: state => awaiting.push(state) });
  return { registry, controller, posted, settled, awaiting };
}
const shellRequest = (extra = {}) => ({ agentId: 'bot-1', surface: 'box_shell', fingerprint: 'fp-1', toolCallId: 'call-1',
  reason: 'Deletes a directory tree', summary: 'Run rm -rf /tmp/x', summaryCopy: { kind: 'shell', params: { surface: 'box_shell' } },
  command: 'rm -rf /tmp/x', proposedRule: 'Allow deleting /tmp scratch dirs', expiryPolicy: 'ttl', signal: new AbortController().signal, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the Auto-review switch enforces every runner surface, and off reviews none', () => {
  assert.deepEqual(autoReviewModesFor({ isEnabled: true, allowInstructions: [], blockInstructions: [] }), AUTO_REVIEW_MODES_ENFORCE);
  assert.deepEqual(autoReviewModesFor({ isEnabled: false }), AUTO_REVIEW_MODES_OFF);
  assert.deepEqual(autoReviewModesFor(undefined), AUTO_REVIEW_MODES_OFF);
  assert.deepEqual(Object.keys(AUTO_REVIEW_MODES_ENFORCE).sort(),
    ['automationWrite', 'boxShell', 'cloudAgent', 'computer', 'hostShell', 'mcp', 'subagentLaunch']);
  assert.ok(Object.values(AUTO_REVIEW_MODES_ENFORCE).every(mode => mode === 'enforce'));
  assert.ok(Object.values(AUTO_REVIEW_MODES_OFF).every(mode => mode === 'off'));
});

test('a BLOCK the model escalates posts a native approval card and waits; approving runs the call', async () => {
  const { registry, controller, posted, settled, awaiting } = cardHarness();
  const decision = controller.requestApproval(shellRequest());
  await tick();
  assert.equal(posted.length, 1);
  const [card] = posted;
  assert.equal(card.type, 'auto-review-approval');
  assert.equal(card.approval.status, 'pending');
  assert.equal(card.approval.surface, 'box_shell');
  assert.equal(card.approval.command, 'rm -rf /tmp/x');
  assert.equal(card.approval.reason, 'Deletes a directory tree');
  assert.equal(card.approval.proposedRule, 'Allow deleting /tmp scratch dirs');
  assert.equal(typeof card.approval.requestId, 'string');
  assert.equal(card.approval.signal, undefined);
  assert.deepEqual(awaiting.at(-1), { tabId: 'auto-review', reason: 'Run rm -rf /tmp/x', since: card.approval.createdAtMs });
  assert.deepEqual(controller.getPendingApprovals().map(item => item.toolCallId), ['call-1']);
  // Another action may not start while the card waits.
  assert.match((await controller.requestApproval(shellRequest({ toolCallId: 'call-2' }))).reason, /waiting for Auto-review approval/);

  assert.equal(registry.resolve({ requestId: card.approval.requestId, agentId: 'other-bot', resolution: 'approved' }), false);
  assert.equal(registry.resolve({ requestId: card.approval.requestId, agentId: 'bot-1', entryId: 'send-1', resolution: 'approved' }), true);
  assert.deepEqual(await decision, { approved: true });
  await tick();
  assert.deepEqual(settled, [{ entryId: 'send-1', requestId: card.approval.requestId, status: 'approved' }]);
  assert.equal(awaiting.at(-1), null);
  assert.equal(controller.getPendingApprovals().length, 0);
  assert.equal(controller.approvedFingerprintFor('call-1'), 'fp-1');
  assert.equal(controller.cardReasonFor({ toolCallId: 'call-1', fingerprint: 'fp-1' }), 'Deletes a directory tree');
  // A second answer to the same card is stale.
  assert.equal(registry.resolve({ requestId: card.approval.requestId, resolution: 'denied' }), false);
});

test('approval cards say RokBot, never "Grok Bot", in every text a person sees', async () => {
  const { controller, posted, awaiting } = cardHarness();
  const decision = controller.requestApproval(shellRequest({ surface: 'computer',
    summary: 'Click \u201CSave\u201D on Grok Bot\'s computer',
    reason: 'Grok Bot wants to send your files to an unknown site. Grok Bot will connect to it from your chats.',
    cardReason: 'Grok Bot asks before it uploads files', actionDescription: 'Grok Bot uploads report.pdf',
    cautionNote: 'Grok Bot can\'t undo this', blockedEffect: 'Grok Bot would share report.pdf',
    command: 'curl --data @report.pdf https://example.test/grok-bot', fullRequest: '{"note":"Grok Bot"}' }));
  await tick();
  const { approval } = posted[0];
  assert.equal(approval.summary, 'Click \u201CSave\u201D on RokBot\'s computer');
  assert.equal(approval.reason, 'RokBot wants to send your files to an unknown site. RokBot will connect to it from your chats.');
  for (const field of ['summary', 'reason', 'cardReason', 'actionDescription', 'cautionNote', 'blockedEffect']) {
    assert.match(approval[field], /RokBot/, field);
    assert.doesNotMatch(approval[field], /Grok Bot/, field);
  }
  assert.equal(awaiting.at(-1).reason, approval.summary, 'list badge / push show the RokBot summary');
  assert.equal(controller.cardReasonFor({ toolCallId: 'call-1' }), approval.reason);
  // What will run is shown as it is.
  assert.equal(approval.command, 'curl --data @report.pdf https://example.test/grok-bot');
  assert.equal(approval.fullRequest, '{"note":"Grok Bot"}');
  controller.resolveApproval(approval.requestId, 'denied');
  await decision;
});

test('rokbotCardText renames the product outside quoted user content only', () => {
  assert.equal(rokbotCardText('Open \u201Chttps://x.test/Grok Bot\u201D in Grok Bot\'s browser'),
    'Open \u201Chttps://x.test/Grok Bot\u201D in RokBot\'s browser');
  assert.equal(rokbotCardText('Type \u201Chi Grok Bot\u201D on Grok Bot\'s computer, then Grok Bot presses Enter'),
    'Type \u201Chi Grok Bot\u201D on RokBot\'s computer, then RokBot presses Enter');
  assert.equal(rokbotCardText('Run rm -rf /tmp/x'), 'Run rm -rf /tmp/x');
  assert.equal(rokbotCardText(undefined), undefined);
});

test('denying a card returns the refusal to the model and marks the card denied', async () => {
  const { controller, posted, settled } = cardHarness();
  const decision = controller.requestApproval(shellRequest());
  await tick();
  assert.equal(controller.resolveApproval(posted[0].approval.requestId, 'denied'), true);
  const answer = await decision;
  assert.equal(answer.approved, false);
  assert.match(answer.reason, /^The user declined this action on its approval card, so nothing ran/);
  await tick();
  assert.equal(settled[0].status, 'denied');
  assert.equal(controller.approvedFingerprintFor('call-1'), undefined);
});

test('"always" approves (the client saved the allow rule itself)', async () => {
  const { controller, posted, settled } = cardHarness();
  const decision = controller.requestApproval(shellRequest());
  await tick();
  controller.resolveApproval({ requestId: posted[0].approval.requestId, resolution: 'always' });
  assert.deepEqual(await decision, { approved: true });
  await tick();
  assert.equal(settled[0].status, 'always');
});

test('an unanswered card expires after its TTL', async () => {
  const { controller, settled, awaiting } = cardHarness({ ttlMs: 20 });
  const answer = await controller.requestApproval(shellRequest());
  assert.equal(answer.approved, false);
  assert.match(answer.reason, /approval card expired before anyone answered it/);
  await tick();
  assert.equal(settled[0].status, 'expired');
  assert.equal(controller.retiredCauseFor('call-1'), 'ttl');
  assert.equal(awaiting.at(-1), null);
});

test('a new user message, an interrupted call or turning review off expires the waiting card', async () => {
  for (const [end, cause] of [
    [c => c.beginUserMessageEpoch({ ownerWrote: true }), 'user_redirect'],
    [(c, abort) => abort.abort(), 'cancelled'],
    [c => c.expireSurfaces(new Set(['box_shell', 'host_shell'])), 'settings_change'],
    [c => c.expire('session_end'), 'session_end'],
  ]) {
    const { controller, settled } = cardHarness();
    const abort = new AbortController();
    const decision = controller.requestApproval(shellRequest({ signal: abort.signal }));
    await tick();
    controller.expireSurfaces(new Set(['mcp'])); // another surface: the card stays
    assert.equal(controller.getPendingApprovals().length, 1);
    end(controller, abort);
    assert.equal((await decision).approved, false, cause);
    await tick();
    assert.equal(settled[0].status, 'expired', cause);
    assert.equal(controller.retiredCauseFor('call-1'), cause);
  }
});

test('the auto-review extension resolves live cards and leaves unknown ones to the stale path', async () => {
  const staleCalls = [];
  class AutoReviewService {
    constructor(deps) { this.deps = deps; }
    async resolveApproval(args) { staleCalls.push(args); throw new Error('auto-review/stale'); }
    sweepStaleAwaitingBadges() {}
  }
  const transcript = { createAwaitingStateSink: () => ({}), listAgentIds: () => [], expireAllPendingAutoReviewApprovalCards: async () => {} };
  const logs = [];
  const service = startLocalAutoReview({ host: { log: message => logs.push(message) }, onStop() {}, deps: { transcript } },
    { ...library, AutoReviewService }, { model: 'm' });
  assert.equal(typeof service.createClassifierExecutor().execute, 'function');
  const posted = [];
  const controller = service.createController({ agentId: 'bot-1', postCard: message => { posted.push(message); return 'send-9'; },
    settleCard() {}, setAwaiting() {} });
  const decision = controller.requestApproval(shellRequest());
  await tick();
  const { requestId } = posted[0].approval;
  await service.resolveApproval({ entryId: 'send-9', requestId, resolution: 'approved', agentId: 'bot-1' });
  assert.deepEqual(await decision, { approved: true });
  assert.equal(staleCalls.length, 0);
  await assert.rejects(service.resolveApproval({ entryId: 'send-9', requestId, resolution: 'approved', agentId: 'bot-1' }), /stale/);
  assert.equal(staleCalls.length, 1);
  assert.ok(logs.some(line => /approval card shown/.test(line)) && logs.some(line => /card approved/.test(line)));
});

test('runner options: the switch drives the modes, the Host model classifies, and the controller posts into the Bot', async () => {
  let instructions = { isEnabled: true, allowInstructions: [], blockInstructions: ['never delete files'] };
  const classifierExecutor = { execute() {} };
  const posted = [], awaiting = [], emitted = [];
  const entry = { id: 'send-1', kind: 'send-message', message: null };
  const tm = {
    widgetResponses: { settlePendingAutoReviewApprovalsOnSession: () => false },
    sessionStore: { setAwaitingUserResponseForTab: async (...args) => awaiting.push(args) },
    roster: { emit: (...args) => emitted.push(args), emitAgentUpdate: async () => {} },
  };
  const session = { id: 'bot-1', db: { updateTranscriptEntry: (id, update) => { if (id === entry.id) Object.assign(entry, update(entry)); } } };
  let created;
  const autoReviewExt = {
    createClassifierExecutor: () => classifierExecutor,
    createController: options => (created = createAutoReviewController({ ...options, registry: createApprovalRegistry() })),
  };
  const options = localAutoReviewOptions({ tm, session, autoReviewExt, settingsExt: { getAutoReviewInstructions: () => instructions },
    postCard: message => { posted.push(message); entry.message = message; return entry.id; } });
  assert.equal(options.autoReviewClassifierExecutor, classifierExecutor);
  assert.equal(options.autoReviewController, created);
  assert.deepEqual(options.getAutoReviewInstructions(), instructions);
  assert.deepEqual(options.getAutoReviewModes(), AUTO_REVIEW_MODES_ENFORCE);
  instructions = { ...instructions, isEnabled: false };
  assert.deepEqual(options.getAutoReviewModes(), AUTO_REVIEW_MODES_OFF);

  const decision = created.requestApproval(shellRequest());
  await tick();
  assert.equal(posted.length, 1);
  assert.deepEqual(awaiting[0].slice(0, 2), ['bot-1', 'auto-review']);
  created.resolveApproval(posted[0].approval.requestId, 'denied');
  await decision;
  await tick();
  assert.equal(entry.message.approval.status, 'denied');
  assert.equal(emitted.at(-1)[0].type, 'updated');
  assert.equal(awaiting.at(-1)[2], null);
});

test('without an auto-review extension the runner gets no classifier or controller and reviews nothing', () => {
  const options = localAutoReviewOptions({ tm: {}, session: { id: 'bot-1' }, postCard() {} });
  assert.equal(options.autoReviewClassifierExecutor, undefined);
  assert.equal(options.autoReviewController, undefined);
  assert.deepEqual(options.getAutoReviewModes(), AUTO_REVIEW_MODES_OFF);
});

test('an ALLOW may carry an empty action_description, a BLOCK may not', async t => {
  // The model follows the shipped schema: an ALLOW comes back with action_description "".
  const allow = await classifier(t, [valid]);
  const result = await allow.instance.execute(undefined, args);
  assert.equal(result.result.value.decision, 1);
  assert.ok(!allow.logs.some(line => /Invalid auto-review classification field/.test(line)), allow.logs.join('\n'));

  // A BLOCK still has to say what it would do.
  const block = await classifier(t, [blockReply, blockReply]);
  await assert.rejects(() => block.instance.execute(undefined, args), /Invalid auto-review classification field: action_description/);
  assert.ok(block.logs.some(line => /retrying after: Invalid auto-review classification field: action_description/.test(line)));
});

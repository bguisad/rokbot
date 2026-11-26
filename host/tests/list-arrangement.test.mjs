import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lastMessageAtOf, pendingActionOf, createListArrangement, withListArrangement, subscribeWithListArrangement, transcriptTailReader,
  QUESTION_SUPERSEDED_MS, isCardEntry, rosterRefresher,
} from '../runtime/list-arrangement.mjs';

const user = (id, timestampMs, extra = {}) => ({ kind: 'message', id, role: 'user', content: 'hi', timestampMs, ...extra });
const bot = (id, timestampMs, message = { type: 'text', content: 'ok' }, extra = {}) => ({ kind: 'send-message', id, message, timestampMs, ...extra });
const widget = (id, timestampMs, extra = {}) => bot(id, timestampMs, { type: 'widget', widget: { prompt: 'Which one?', options: [{ label: 'A' }] } }, extra);

test('lastMessageAt is the newest chat message from either side', () => {
  assert.equal(lastMessageAtOf([bot('a', 100), user('b', 200)]), 200);
  assert.equal(lastMessageAtOf([user('a', 100), bot('b', 300)]), 300);
  assert.equal(lastMessageAtOf([user('a', 100), { kind: 'tool-call', id: 't', timestampMs: 900 }, { kind: 'notice', id: 'n', timestampMs: 950 }]), 100);
  assert.equal(lastMessageAtOf([]), null);
  assert.equal(lastMessageAtOf(undefined), null);
});

test('lastMessageAt skips thread replies, voice calls, meetings and hidden Bot-to-Bot messages', () => {
  const entries = [
    user('a', 100),
    user('thread', 500, { branched: true, replyTo: 'a' }),
    user('voice', 600, { channel: 'voice:call-1' }),
    bot('meeting', 700, { type: 'text', content: 'x', channel: 'meeting:m1' }),
    { kind: 'message', id: 'peer-in', role: 'user', content: 'x', fromAgent: { id: 'b2' }, timestampMs: 800 },
    { kind: 'message', id: 'peer-hidden', role: 'assistant', content: 'x', toAgent: { kind: 'channel' }, timestampMs: 900 },
  ];
  assert.equal(lastMessageAtOf(entries), 100);
  entries.push({ kind: 'message', id: 'peer-shown', role: 'assistant', content: 'x', toAgent: { kind: 'agent', name: 'B' }, timestampMs: 950 });
  assert.equal(lastMessageAtOf(entries), 950);
  entries.push({ kind: 'user-attachment', id: 'file', timestampMs: 990 });
  assert.equal(lastMessageAtOf(entries), 990);
});

test('an open question widget or form is pending until answered, dismissed or followed by the user', () => {
  assert.deepEqual(pendingActionOf([user('a', 100), widget('w', 200)]), { kind: 'question', since: 200, entryId: 'w' });
  assert.equal(pendingActionOf([widget('w', 200, { respondedValue: 'A' })]), null);
  assert.equal(pendingActionOf([widget('w', 200, { widgetDismissed: true })]), null);
  assert.equal(pendingActionOf([widget('w', 200), user('b', 300)]), null);
  const form = bot('f', 400, { type: 'user-form', formRequest: { title: 'Address' } });
  assert.deepEqual(pendingActionOf([form]), { kind: 'question', since: 400, entryId: 'f' });
  assert.equal(pendingActionOf([{ ...form, formResolution: { kind: 'submitted' } }]), null);
});

test('an approval card stays pending while its status is pending, even after the user wrote', () => {
  const card = bot('c', 200, { type: 'auto-review-approval', approval: { status: 'pending', requestId: 'r', summary: 'Delete files' } });
  assert.deepEqual(pendingActionOf([card, user('b', 300)]), { kind: 'approval', since: 200, entryId: 'c' });
  assert.equal(pendingActionOf([{ ...card, message: { ...card.message, approval: { status: 'approved' } } }]), null);
  const ask = bot('p', 250, { type: 'local-tool-permission', ask: { status: 'pending', requestId: 'x', action: 'click', target: 'Finder' } });
  assert.deepEqual(pendingActionOf([ask]), { kind: 'approval', since: 250, entryId: 'p' });
  assert.equal(pendingActionOf([bot('e', 260, { type: 'virtual-card-approval', approval: { status: 'expired' } })]), null);
  assert.equal(pendingActionOf([bot('t', 270)]), null);
});

test('the newest pending card wins', () => {
  const card = bot('c', 200, { type: 'cookie-origin-approval', approval: { status: 'pending', items: [] } });
  assert.equal(pendingActionOf([card, widget('w', 300)]).entryId, 'w');
  assert.equal(pendingActionOf([widget('w', 100), card]).entryId, 'c');
});

function arrangementWith(tails, clock = { now: 1000 }) {
  const reads = [];
  const arrangement = createListArrangement({ now: () => clock.now, readTail: (agentId, limit) => {
    reads.push([agentId, limit]);
    if (!(agentId in tails)) throw new Error('gone');
    return tails[agentId];
  } });
  return { arrangement, reads, clock };
}

test('listAgents and summary answers carry the arrangement fields', async () => {
  const tails = { a: { entries: [user('1', 100), widget('2', 200)] }, b: [bot('3', 300)] };
  const { arrangement } = arrangementWith(tails);
  const api = {
    listAgents: async () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'gone', name: 'G' }],
    updateAgent: async args => ({ id: args.id, name: 'renamed' }),
    createAgent: async () => ({ agent: { id: 'b', name: 'B' }, created: true }),
    other: () => 'untouched',
  };
  const wrapped = withListArrangement(api, arrangement);
  const rows = await wrapped.listAgents();
  assert.deepEqual(rows[0], { id: 'a', name: 'A', lastMessageAt: 200, pendingAction: { kind: 'question', since: 200, entryId: '2' } });
  assert.deepEqual(rows[1], { id: 'b', name: 'B', lastMessageAt: 300, pendingAction: null });
  assert.deepEqual(rows[2], { id: 'gone', name: 'G' }, 'a Bot whose transcript cannot be read stays as it was');
  assert.equal((await wrapped.updateAgent({ id: 'a' })).lastMessageAt, 200);
  const created = await wrapped.createAgent({});
  assert.equal(created.created, true);
  assert.equal(created.agent.lastMessageAt, 300);
  assert.equal(wrapped.other(), 'untouched');
  assert.equal(withListArrangement(null, arrangement), null);
});

test('roster events are decorated synchronously and in order; other events pass through', () => {
  const tails = { a: [user('1', 100)], b: [bot('2', 200, { type: 'auto-review-approval', approval: { status: 'pending' } })] };
  const { arrangement } = arrangementWith(tails);
  let handler;
  const seen = [];
  const subscribe = subscribeWithListArrangement(listener => { handler = listener; return () => {}; }, arrangement);
  subscribe(event => seen.push(event));
  const transcript = { channel: 'transcript', payload: { entries: [] } };
  handler({ channel: 'agents', payload: { agents: [{ id: 'a' }, { id: 'b' }], activeAgentId: 'a' } });
  handler(transcript);
  handler({ channel: 'agent-upserted', payload: { agent: { id: 'b' }, ordered: 1 } });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0].payload.agents.map(agent => agent.lastMessageAt), [100, 200]);
  assert.equal(seen[0].payload.activeAgentId, 'a');
  assert.equal(seen[1], transcript);
  assert.deepEqual(seen[2].payload, { agent: { id: 'b', lastMessageAt: 200, pendingAction: { kind: 'approval', since: 200, entryId: '2' } }, ordered: 1 });
});

test('a summary that did not change reuses the transcript read for a moment, then reads again', async () => {
  const tails = { a: [user('1', 100)] };
  const { arrangement, reads, clock } = arrangementWith(tails);
  const agent = { id: 'a', newestEntryId: '1', updatedAt: 5 };
  await arrangement.decorate(agent);
  arrangement.decorateNow(agent);
  assert.equal(reads.length, 1);
  arrangement.decorateNow({ ...agent, newestEntryId: '2' });
  assert.equal(reads.length, 2, 'a new entry reads the transcript again');
  clock.now += 5000;
  tails.a = [user('1', 100), widget('2', 900)];
  assert.equal(arrangement.decorateNow({ ...agent, newestEntryId: '2' }).pendingAction.kind, 'question', 'an expired cache reads again');
});

test('an asynchronous transcript reader fills the cache for the next event', async () => {
  const arrangement = createListArrangement({ readTail: async () => [user('1', 100)] });
  const first = arrangement.decorateNow({ id: 'a' });
  assert.equal('lastMessageAt' in first, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(arrangement.decorateNow({ id: 'a' }).lastMessageAt, 100);
});

test('transcriptTailReader reads through the original transcript manager', () => {
  const calls = [];
  const read = transcriptTailReader({ transcript: { getAgentTranscriptTail: (...args) => { calls.push(args); return { entries: [] }; } } });
  assert.deepEqual(read('a', 48), { entries: [] });
  assert.deepEqual(calls, [['a', { limit: 48 }]]);
});

test('rokbot.5b: a question the Bot has moved past, or that cannot be rendered, is not pending', () => {
  const min = 60 * 1000;
  // A reply in the same turn keeps the question at the end of the chat.
  assert.equal(pendingActionOf([widget('w', 10 * min), bot('t', 10 * min + 20 * 1000)]).entryId, 'w');
  // A Bot message well after it (a later turn, a routine) buries it: the user cannot find it.
  assert.equal(pendingActionOf([widget('w', 10 * min), bot('t', 10 * min + 20 * 1000), bot('later', 30 * min)]), null);
  assert.ok(QUESTION_SUPERSEDED_MS >= 60 * 1000 && QUESTION_SUPERSEDED_MS <= 10 * 60 * 1000);
  // A newer question replaces the older one; an answered newer widget settles the older ones.
  assert.equal(pendingActionOf([widget('w1', 100), widget('w2', 200)]).entryId, 'w2');
  assert.equal(pendingActionOf([widget('w1', 100), widget('w2', 200, { respondedValue: 'A' })]), null);
  // The official clients only render a widget with a prompt.
  assert.equal(pendingActionOf([bot('x', 100, { type: 'widget', widget: { options: [] } })]), null);
  assert.equal(pendingActionOf([bot('x', 100, { type: 'widget' })]), null);
});

test('rokbot.5b: approvals count for the official card kinds and until their deadline', () => {
  const now = 1_000_000;
  const card = (id, message) => bot(id, 100, message);
  assert.equal(pendingActionOf([card('s', { type: 'secret-request', secretRequest: { status: 'pending' } })], { now }), null,
    'a payload the conversation does not render as an approval card');
  assert.equal(pendingActionOf([card('u', { type: 'text', approval: { status: 'pending' } })], { now }), null);
  assert.equal(pendingActionOf([card('g', { type: 'connector-grant', ask: { status: 'pending' } })], { now }).entryId, 'g');
  assert.equal(pendingActionOf([card('m', { type: 'x-money-challenge', challenge: { status: 'pending' } })], { now }).entryId, 'm');
  assert.equal(pendingActionOf([card('d', { type: 'publish-approval', approval: { status: 'pending', expiresAtMs: now - 1 } })], { now }), null,
    'past its deadline');
  assert.equal(pendingActionOf([card('d', { type: 'publish-approval', approval: { status: 'pending', expiresAtMs: now + 1 } })], { now }).entryId, 'd');
  const cred = card('c', { type: 'credential-request', credentialRequest: { expiresAtMs: now + 5 } });
  assert.equal(pendingActionOf([cred], { now }).kind, 'approval');
  assert.equal(pendingActionOf([{ ...cred, credentialResolution: 'stored' }], { now }), null);
  assert.equal(pendingActionOf([cred], { now: now + 10 }), null);
});

test('rokbot.5b: a card updated in place re-announces its Bot once, with fresh fields', async () => {
  const tails = { a: [user('1', 100), widget('w', 200)] };
  const { arrangement, reads } = arrangementWith(tails);
  const agent = { id: 'a', newestEntryId: 'w' };
  assert.equal(arrangement.decorateNow(agent).pendingAction.entryId, 'w');
  const refreshed = [];
  let handler;
  const seen = [];
  subscribeWithListArrangement(listener => { handler = listener; return () => {}; }, arrangement, id => refreshed.push(id))(e => seen.push(e));
  tails.a = [user('1', 100), widget('w', 200, { widgetDismissed: true })];
  const updated = { channel: 'transcript', payload: { type: 'updated', agentId: 'a', entry: tails.a[1] } };
  handler(updated);
  handler(updated);
  handler({ channel: 'transcript', payload: { type: 'updated', agentId: 'a', entry: user('1', 100) } });
  handler({ channel: 'transcript', payload: { type: 'appended', agentId: 'a', entry: tails.a[1] } });
  assert.equal(seen.length, 4, 'events still reach the client unchanged');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(refreshed, ['a'], 'one refresh for the card update');
  const before = reads.length;
  assert.equal(arrangement.decorateNow(agent).pendingAction, null, 'the cached card is forgotten');
  assert.equal(reads.length, before + 1);
  assert.equal(isCardEntry(bot('t', 1)), false);
  assert.equal(isCardEntry(bot('p', 1, { type: 'local-tool-permission', ask: {} })), true);
});

test('rosterRefresher asks the original roster for a fresh summary', () => {
  const calls = [];
  rosterRefresher({ transcript: { roster: { emitAgentUpdate: id => calls.push(id) } } })('a');
  rosterRefresher({})('b');
  assert.deepEqual(calls, ['a']);
});

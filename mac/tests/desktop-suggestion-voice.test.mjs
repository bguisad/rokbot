// Desktop composer (shared composer-assist.cjs): suggestions stay in the USER's voice. Assistant
// offers (「要不要我一起查一下这个问题」) never appear in the strip, local completion or ghost text,
// and only self-sent messages count as the user's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const assist = require('../clients/desktop/composer-assist.cjs');
const OFFER = '要不要我一起查一下这个问题';
const USER = '帮我查一下这个问题';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('desktop voice filter: offers dropped, the user phrase kept', () => {
  assert.equal(assist.isAssistantOfferPhrase(OFFER), true);
  assert.equal(assist.isAssistantOfferPhrase('Would you like me to rerun it?'), true);
  assert.equal(assist.isAssistantOfferPhrase('…让我来'), true);
  assert.equal(assist.isAssistantOfferPhrase(USER), false);
  assert.equal(assist.isAssistantOfferPhrase('Let me know when done'), false);
  const items = assist.mergeSuggestionItems([], [OFFER, USER], ['需要我重跑吗', '看下日志']);
  assert.deepEqual(items.map(item => item.text), [USER, '看下日志']);
  assert.deepEqual(assist.matchCompletions('帮', [OFFER, USER]), [USER]);
  assert.deepEqual(assist.matchCompletions('要', [OFFER]), []);
});

test('desktop role filter: assistant / other-Bot messages are not the user', () => {
  assert.equal(assist.isSelfUserEntry({ role: 'user', text: USER }), true);
  assert.equal(assist.isSelfUserEntry({ role: 'assistant', text: OFFER }), false);
  assert.equal(assist.isSelfUserEntry({ kind: 'send-message', text: OFFER }), false);
  assert.equal(assist.isSelfUserEntry({ role: 'user', fromAgent: { id: 'bot2' }, text: OFFER }), false);
  assert.equal(assist.isSelfUserEntry({ role: 'user', source: 'automation', text: OFFER }), false);
});

test('desktop inline completion: a ghost that turns the draft into an offer is not shown', async () => {
  const tasks = [];
  const ghosts = [];
  const controller = assist.createCompletionController({
    schedule: fn => { tasks.push(fn); return tasks.length; },
    cancelSchedule: () => {},
    onChange: value => ghosts.push(value),
    request: payload => Promise.resolve({ enabled: true, source: 'model',
      completion: payload.text === '要不要' ? '我一起查一下这个问题' : '查一下这个问题' }),
  });
  const base = { enabled: true, composing: false, hasHistory: true, caretAtEnd: true, context: 'bot:1', payload: { agentId: 'bot' } };
  controller.update({ ...base, text: '要不要' });
  tasks.splice(0).forEach(fn => fn());
  await flush();
  assert.equal(controller.ghost, '');
  controller.update({ ...base, text: '帮我' });
  tasks.splice(0).forEach(fn => fn());
  await flush();
  assert.equal(controller.ghost, '查一下这个问题');
});

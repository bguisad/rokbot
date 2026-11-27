// Web composer: the shared composer assist keeps suggestions in the USER's voice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('../../mac/clients/desktop/composer-assist.cjs');
const web = await import('../client/suggestions.js');
const OFFER = '要不要我一起查一下这个问题';
const USER = '帮我查一下这个问题';

test('web: assistant offers are filtered from the strip and local completion; user phrases kept', () => {
  assert.equal(web.isAssistantOfferPhrase(OFFER), true);
  assert.equal(web.isAssistantOfferPhrase('Shall I deploy it?'), true);
  assert.equal(web.isAssistantOfferPhrase(USER), false);
  assert.deepEqual(web.mergeSuggestionItems([], [OFFER, USER], [OFFER]).map(item => item.text), [USER]);
  assert.deepEqual(web.matchCompletions('帮我', [OFFER, USER]), [USER]);
  assert.equal(web.voiceSafeCompletion('要不要', '我一起查一下这个问题'), '');
  assert.equal(web.voiceSafeCompletion('帮我', '查一下这个问题'), '查一下这个问题');
});

test('web: assistant messages are never treated as the user\'s', () => {
  assert.equal(web.isSelfUserEntry({ role: 'user', text: USER }), true);
  assert.equal(web.isSelfUserEntry({ role: 'assistant', text: OFFER }), false);
  assert.equal(web.isSelfUserEntry({ role: 'user', sender: { kind: 'agent', id: 'b2' }, text: OFFER }), false);
});

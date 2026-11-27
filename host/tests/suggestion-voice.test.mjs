// Composer suggestions speak in the USER's voice: habits are learned only from what the user
// themself sent, and anything reading as the Bot offering help ("要不要我一起查一下这个问题") is
// dropped from learned habits, local completion candidates and model output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_OFFER_PREFIXES, isAssistantOfferPhrase, isSelfUserEntry,
} from '../server/suggestion-voice.mjs';
import {
  SuggestionHabits, buildHabitProfile, filterAndRankSuggestions, frequentMessages, habitSuggestions, matchCompletions,
} from '../server/suggestion-habits.mjs';
import {
  buildSuggestionMessages, extractRecentMessages, parseSuggestionResponse, voiceSafeCompletion,
} from '../server/suggestions.mjs';

const OFFER = '要不要我一起查一下这个问题';
const USER = '帮我查一下这个问题';

test('voice filter: assistant offers are detected, the user asking the Bot is kept', () => {
  for (const text of [OFFER, '  「要不要我先修 upload？', '需要我把日志贴出来吗', '需不需要我重跑', '我可以帮你看看', '我来帮你改',
    '我帮你查', '让我来处理', '我可以为你整理', 'Would you like me to rerun it?', 'shall I deploy', 'Do you want me to fix it',
    'Let me check that', "I can help you with that", "I'll help you fix it", 'I’ll help you']) {
    assert.equal(isAssistantOfferPhrase(text), true, text);
  }
  for (const text of [USER, '要不要先回滚', '我想看下日志', '你帮我查', 'Let me know when it is done', 'let men in', 'Shallow copy?', '']) {
    assert.equal(isAssistantOfferPhrase(text), false, text);
  }
  assert.ok(ASSISTANT_OFFER_PREFIXES.includes('要不要我') && ASSISTANT_OFFER_PREFIXES.includes('would you like me'));
});

test('role filter: only entries the user themself sent count', () => {
  assert.equal(isSelfUserEntry({ kind: 'message', role: 'user', content: USER }), true);
  assert.equal(isSelfUserEntry({ kind: 'user', text: USER }), true);
  assert.equal(isSelfUserEntry({ role: 'user', author: '我', content: USER }), true);
  for (const entry of [
    { role: 'assistant', content: OFFER },
    { kind: 'send-message', text: OFFER },
    { role: 'system', content: OFFER },
    { role: 'tool', content: OFFER },
    { role: 'user', fromAgent: { id: 'bot2', name: 'Reviewer' }, content: OFFER },
    { role: 'user', fromAgentId: 'bot2', content: OFFER },
    { role: 'user', sender: { kind: 'agent', id: 'bot2' }, content: OFFER },
    { role: 'user', source: 'automation', content: OFFER },
    { role: 'user', synthetic: true, content: OFFER },
  ]) assert.equal(isSelfUserEntry(entry), false, JSON.stringify(entry));
});

test('habits: assistant/other-Bot messages are never learned; the user phrase is', async () => {
  const entries = [];
  for (let i = 0; i < 3; i++) {
    entries.push({ id: `u${i}`, kind: 'message', role: 'user', content: USER, timestampMs: 10 * i + 1 });
    entries.push({ id: `a${i}`, kind: 'send-message', text: OFFER, timestampMs: 10 * i + 2 });
    entries.push({ id: `r${i}`, role: 'assistant', content: OFFER, timestampMs: 10 * i + 3 });
    entries.push({ id: `g${i}`, kind: 'message', role: 'user', fromAgent: { id: 'bot2', name: 'Helper' }, content: '需要我把报告发你吗', timestampMs: 10 * i + 4 });
  }
  const hostCall = async (method) => (method === 'getAgentTranscriptWindow' ? { entries } : null);
  const habits = await new SuggestionHabits({ hostCall, refreshIntervalMs: 0 }).load();
  const profile = await habits.profile('bot1');
  assert.equal(profile.total, 3, 'only the user\'s own three messages');
  assert.deepEqual(frequentMessages(profile).map(item => item.text), [USER]);
  assert.deepEqual(habitSuggestions(profile), [USER]);
  assert.ok(!profile.recent.includes(OFFER));
  assert.deepEqual(matchCompletions('要', [OFFER, '要先回滚吗']), ['要先回滚吗']);
  assert.deepEqual(matchCompletions('帮我', [OFFER, USER]), [USER]);
});

test('habits: an offer the user happened to send (or an old stored profile) is never suggested back', () => {
  const profile = buildHabitProfile([{ text: OFFER }, { text: OFFER }, { text: USER }, { text: USER }]);
  assert.deepEqual(frequentMessages(profile).map(item => item.text), [USER]);
  const legacy = { total: 4, frequent: [{ key: 'x', text: OFFER, count: 9, at: 1 }, { key: 'y', text: USER, count: 2, at: 1 }] };
  assert.deepEqual(habitSuggestions(legacy), [USER]);
});

test('model output: offers dropped by the parser and the ranker; prompts state the user voice', () => {
  assert.deepEqual(parseSuggestionResponse(JSON.stringify([OFFER, USER, 'Would you like me to retry?'])), [USER]);
  assert.deepEqual(filterAndRankSuggestions([OFFER, USER], { lang: 'zh' }), [USER]);
  const [zh] = buildSuggestionMessages([{ role: 'assistant', text: '查到 2 个错误。' }], 'zh');
  assert.match(zh.content, /用户发给 Bot 的话/);
  assert.match(zh.content, /要不要我/);
  const [en] = buildSuggestionMessages([{ role: 'assistant', text: 'Found 2 errors.' }], 'en');
  assert.match(en.content, /USER sends to the assistant/);
  assert.match(en.content, /never phrase an item as the assistant offering help/);
});

test('model completion: a continuation that turns the draft into an offer is dropped', () => {
  assert.equal(voiceSafeCompletion('要不要', '我一起查一下这个问题'), '');
  assert.equal(voiceSafeCompletion('帮我', '查一下这个问题'), '查一下这个问题');
  assert.equal(voiceSafeCompletion('要不要我', '先停一下'), '先停一下', 'the user typed it themself');
  assert.equal(voiceSafeCompletion('Can you', ' let me know'), ' let me know');
});

test('prompt transcript: a "user" turn another Bot sent is shown as the other side', () => {
  const recent = extractRecentMessages([
    { id: '1', role: 'user', content: USER },
    { id: '2', role: 'user', fromAgent: { id: 'bot2' }, content: OFFER },
  ]);
  assert.deepEqual(recent.map(item => item.role), ['user', 'assistant']);
});

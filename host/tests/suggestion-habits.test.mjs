// Smart input suggestions: the per-Bot habit profile (built on the Host from the user's own
// messages), behaviour learning (taps / ignores), the anti-filler filter and the new prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SuggestionHabits, buildHabitProfile, filterAndRankSuggestions, frequentMessages, habitSuggestions, isGenericSuggestion,
  matchCompletions, normalizeMessageKey, profilePromptSummary, similarity,
} from '../server/suggestion-habits.mjs';
import { SuggestionsService, SuggestionsSettings, buildSuggestionMessages, isEmptySuggestionAnswer } from '../server/suggestions.mjs';
import { Models } from '../server/models.mjs';

const sse = text => new Response(
  `data: ${JSON.stringify({ id: 'c', model: 'gpt-suggest', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const modelFixture = () => ({
  version: 1,
  providers: [{ id: 'cheap', name: 'Cheap', apiFormat: 'openai', baseUrl: 'https://cheap.example/v1', apiKey: 'k' }],
  profiles: [{ id: 'mini', name: 'Mini', providerId: 'cheap', model: 'gpt-suggest', efforts: ['none'], contextWindowTokens: 64_000, summaryThresholdTokens: 48_000 }],
  defaultRoute: { profileId: 'mini', effort: 'none', fallbacks: [] },
  botRoutes: {}, scenarioRoutes: {}, migrateLegacyRouting: true,
});

test('generic filler is recognised, specific next steps are not', () => {
  for (const text of ['继续执行下一步', '总结一下当前进展', '检查线上部署状态', '继续', '下一步', '好的，谢谢', '还有什么建议吗？', '详细说说',
    'Continue', 'Summarize the current progress', 'check the deployment status', 'thanks']) {
    assert.equal(isGenericSuggestion(text), true, text);
  }
  for (const text of ['把 #248 合并到 main', '重跑 suggestions.test', '回滚到 v1.4.2', '日志里的 ECONNRESET 是哪来的', 'Retry the flaky upload test',
    '检查 nginx 的 502']) {
    assert.equal(isGenericSuggestion(text), false, text);
  }
  assert.equal(normalizeMessageKey('  好的，开始合并！ '), '好的,开始合并');
  assert.ok(similarity('跑一下全量测试', '跑一下全量测试吧') > 0.85);
  assert.ok(similarity('跑一下全量测试', '回滚到上一版') < 0.3);
});

test('profile builder: frequent messages, language, length, openers; incremental', () => {
  const t0 = Date.UTC(2026, 10, 1);
  const msgs = [
    { text: '跑一下 e2e', at: t0 }, { text: '提个 PR', at: t0 + 1 }, { text: '跑一下 e2e', at: t0 + 2 },
    { text: '/deploy staging', at: t0 + 3 }, { text: '跑一下 e2e！', at: t0 + 4 }, { text: '提个 PR', at: t0 + 5 },
    { text: 'x'.repeat(300), at: t0 + 6 },
  ];
  const p1 = buildHabitProfile(msgs.slice(0, 4), null, t0 + 10);
  const p = buildHabitProfile(msgs.slice(4), p1, t0 + 10);
  assert.equal(p.total, 7);
  assert.equal(p.lang, 'zh');
  const freq = frequentMessages(p);
  assert.deepEqual(freq.map(item => [item.text, item.count]), [['跑一下 e2e！', 3], ['提个 PR', 2]]);
  assert.ok(!p.frequent.some(item => item.text.startsWith('xxx')), 'long one-off instructions are not habits');
  assert.equal(p.openers['/deploy'], 1);
  assert.equal(p.openers['跑一'], 3);
  assert.equal(p.recent.at(-1).length <= 241, true);
  const summary = profilePromptSummary(p, 'zh');
  assert.match(summary, /发过 7 条消息/);
  assert.match(summary, /「跑一下 e2e！」×3/);
  assert.equal(profilePromptSummary(null, 'zh'), '');
});

test('ranking: generic dropped (unless habitual), recent repeats and near-duplicates removed, taps up, ignores down', () => {
  const profile = buildHabitProfile([{ text: '继续' }, { text: '继续' }, { text: '继续' }, { text: '合并吧' }], null);
  const ranked = filterAndRankSuggestions(
    ['总结一下当前进展', '继续', '合并 #248', '合并#248', '回滚 v1.4', '跑一下 e2e', '把这段话写得特别特别长长长长长长长长长长长长长长长'],
    {
      lang: 'zh', profile, recentUserTexts: ['跑一下 e2e'],
      feedback: { [normalizeMessageKey('回滚 v1.4')]: { taps: 2, ignores: 0 }, [normalizeMessageKey('继续')]: { taps: 0, ignores: 1 } },
    },
  );
  // 回滚 (tapped twice) first; 继续 is the user's own habit so it survives the filler filter.
  assert.deepEqual(ranked, ['回滚 v1.4', '继续', '合并 #248']);
  const ignored = filterAndRankSuggestions(['看下 CI 日志'], { lang: 'zh', feedback: { [normalizeMessageKey('看下 CI 日志')]: { taps: 0, ignores: 3 } } });
  assert.deepEqual(ignored, [], 'shown three times and never used: dropped');
  assert.deepEqual(filterAndRankSuggestions(['继续执行下一步', '检查线上部署状态'], { lang: 'zh' }), [], 'nothing specific: nothing');
  assert.deepEqual(habitSuggestions(profile, {}, { exclude: ['继续'] }), []);
  assert.deepEqual(habitSuggestions(profile, {}), ['继续']);
});

test('local completion matching: prefix, then substring, then in-order', () => {
  const pool = ['跑一下全量测试', '帮我跑一下 lint', '提个 PR 吧', '跑测试并截图'];
  assert.deepEqual(matchCompletions('跑一', pool), ['跑一下全量测试', '帮我跑一下 lint']);
  assert.deepEqual(matchCompletions('跑测', pool), ['跑测试并截图', '跑一下全量测试']);
  assert.deepEqual(matchCompletions('提个 PR 吧', pool), [], 'the exact text is not a completion');
  assert.deepEqual(matchCompletions('', pool), []);
});

test('the prompt forbids filler, carries the habits, the recent user messages and the length limit', () => {
  const [system, user] = buildSuggestionMessages(
    [{ role: 'user', text: '合并 #248' }, { role: 'assistant', text: '#248 已合并，要发 v0.3 吗？' }], 'zh',
    { profileSummary: '用户给这个 Bot 发过 30 条消息', recentUserTexts: ['合并 #248'] },
  );
  assert.match(system.content, /禁止空泛万能句/);
  assert.match(system.content, /继续执行下一步/);
  assert.match(system.content, /不超过18个汉字/);
  assert.match(system.content, /0到3条/);
  assert.match(user.content, /用户习惯：\n用户给这个 Bot 发过 30 条消息/);
  assert.match(user.content, /用户最近发过（不要重复）：\n- 合并 #248/);
  assert.match(user.content, /可以是 \[\]/);
  const [enSystem] = buildSuggestionMessages([{ role: 'assistant', text: 'Done.' }], 'en');
  assert.match(enSystem.content, /never generic filler/);
  assert.equal(isEmptySuggestionAnswer('[]'), true);
  assert.equal(isEmptySuggestionAnswer('```json\n[ ]\n```'), true);
  assert.equal(isEmptySuggestionAnswer('["a"]'), false);
});

function transcriptHost(pages) {
  const calls = [];
  const hostCall = async (method, args) => {
    calls.push([method, args]);
    const all = pages.entries;
    if (method === 'getAgentTranscriptTail') return { entries: all.slice(-12) };
    // Window: newest `limit` entries before beforeSeq (seq = index + 1).
    const end = typeof args.beforeSeq === 'number' ? args.beforeSeq - 1 : all.length;
    const start = Math.max(0, end - args.limit);
    return { entries: all.slice(start, end), nextBeforeSeq: start > 0 ? start + 1 : null };
  };
  return { hostCall, calls };
}

test('SuggestionHabits: paged first build, incremental refresh, ignore inferred from the next message, clear', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-habits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = [];
  for (let i = 0; i < 450; i++) {
    entries.push({ id: `u${i}`, kind: 'message', role: 'user', content: i % 3 === 0 ? '跑一下 e2e' : `第${i}条需求`, timestampMs: 1000 + i });
    entries.push({ id: `a${i}`, kind: 'send-message', text: `好的 ${i}`, timestampMs: 1000 + i });
  }
  const host = transcriptHost({ entries });
  let now = 10_000;
  const habits = await new SuggestionHabits({ dataDir: dir, hostCall: host.hostCall, now: () => now, refreshIntervalMs: 0 }).load();
  const p1 = await habits.profile('bot1');
  assert.equal(p1.total, 450);
  assert.equal(frequentMessages(p1)[0].text, '跑一下 e2e');
  assert.equal(frequentMessages(p1)[0].count, 150);
  const windowCalls = host.calls.filter(([m]) => m === 'getAgentTranscriptWindow').length;
  assert.equal(windowCalls, 5, 'first build: 5 pages of 200');

  // Suggestions were shown, then the user typed something else: ignored.
  await habits.noteShown('bot1', ['回滚 v1.4', '看下 CI']);
  entries.push({ id: 'u-new', kind: 'message', role: 'user', content: '先别动，等我看完', timestampMs: 99_999 });
  host.calls.length = 0;
  now += 1000;
  const p2 = await habits.profile('bot1');
  assert.equal(p2.total, 451);
  assert.equal(host.calls.length, 1, 'incremental: one page up to the last seen entry');
  const fb = habits.feedbackOf('bot1');
  assert.equal(fb[normalizeMessageKey('回滚 v1.4')].ignores, 1);
  assert.equal(habits.agent('bot1').typedAfter.at(-1), '先别动，等我看完');

  // A tap from the client.
  await habits.record('bot1', { action: 'tap', text: '看下 CI', shown: ['回滚 v1.4', '看下 CI'] });
  assert.equal(habits.feedbackOf('bot1')[normalizeMessageKey('看下 CI')].taps, 1);

  const stored = JSON.parse(await readFile(join(dir, 'suggestions-habits.json'), 'utf8'));
  assert.equal(stored.agents.bot1.profile.total, 451, 'kept on the Host data dir');
  await habits.clear();
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'suggestions-habits.json'), 'utf8')).agents, {});
});

test('SuggestionsService: habits in the prompt, filler filtered, frequent messages fill, learning off = old behaviour', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-habits-svc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = new Models(dir);
  await models.save(modelFixture());
  const settings = await new SuggestionsSettings(dir).load();
  await settings.addPhrase({ text: '提个 PR' });
  const entries = [
    { id: 'u1', kind: 'message', role: 'user', content: '跑一下 e2e', timestampMs: 1 },
    { id: 'a1', kind: 'send-message', text: 'e2e 全绿。', timestampMs: 2 },
    { id: 'u2', kind: 'message', role: 'user', content: '跑一下 e2e', timestampMs: 3 },
    { id: 'a2', kind: 'send-message', text: 'e2e 有 2 个失败：upload.spec 和 login.spec，要我先修 upload 吗？', timestampMs: 4 },
  ];
  const host = transcriptHost({ entries });
  const prompts = [];
  let answer = ['先修 upload.spec', '继续执行下一步', '总结一下当前进展', '两个一起修'];
  const service = await new SuggestionsService({
    models, settings, dataDir: dir, hostCall: host.hostCall,
    fetchImpl: async (_url, options) => { prompts.push(JSON.parse(options.body).messages); return sse(JSON.stringify(answer)); },
  }).load();

  const res = await service.generate({ agentId: 'bot1', locale: 'zh-CN' });
  assert.deepEqual(res.aiSuggestions, ['先修 upload.spec', '两个一起修'], 'generic filler removed');
  assert.deepEqual(res.frequentSuggestions, ['跑一下 e2e']);
  assert.deepEqual(res.items.map(item => item.type), ['phrase', 'ai', 'ai', 'frequent']);
  assert.ok(res.completionCandidates.includes('提个 PR') && res.completionCandidates.includes('跑一下 e2e'));
  assert.equal(res.learningEnabled, true);
  const userPrompt = prompts[0][1].content;
  assert.match(userPrompt, /用户习惯：/);
  assert.match(userPrompt, /「跑一下 e2e」×2/);
  assert.match(userPrompt, /upload\.spec/);

  // Feedback endpoint logic.
  assert.deepEqual(await service.feedback({ agentId: 'bot1', action: 'tap', text: '先修 upload.spec', shown: res.aiSuggestions }), { recorded: true });
  assert.deepEqual(await service.feedback({ agentId: 'bot1', action: 'bogus' }), { recorded: false });

  // Model answers only filler -> nothing generic; the strip keeps phrases + the user's own habits.
  answer = ['继续执行下一步', '检查线上部署状态'];
  entries.push({ id: 'a3', kind: 'send-message', text: '已修好 upload.spec。', timestampMs: 5 });
  const res2 = await service.generate({ agentId: 'bot1', locale: 'zh-CN' });
  assert.deepEqual(res2.aiSuggestions, []);
  assert.deepEqual(res2.suggestions, ['提个 PR', '跑一下 e2e']);

  // 清空学习记录 + learning off: no profile, no frequent items, prompt without habits.
  await service.clearHabits();
  await settings.updateSettings({ learningEnabled: false, localCompletionEnabled: false });
  answer = ['把 login.spec 也修了'];
  entries.push({ id: 'a4', kind: 'send-message', text: 'login.spec 还挂着。', timestampMs: 6 });
  const res3 = await service.generate({ agentId: 'bot1', locale: 'zh-CN' });
  assert.deepEqual(res3.frequentSuggestions, []);
  assert.deepEqual(res3.completionCandidates, []);
  assert.equal(res3.learningEnabled, false);
  assert.doesNotMatch(prompts.at(-1)[1].content, /用户习惯/);
  assert.deepEqual(await service.feedback({ agentId: 'bot1', action: 'tap', text: 'x' }), { recorded: false });
  assert.equal(service.habitsSummary().agents, 0);
});

test('settings: learningEnabled / localCompletionEnabled validated and persisted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-habits-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = await new SuggestionsSettings(dir).load();
  await assert.rejects(settings.updateSettings({ learningEnabled: 'no' }), /learningEnabled/);
  const next = await settings.updateSettings({ learningEnabled: false });
  assert.equal(next.learningEnabled, false);
  assert.equal(next.localCompletionEnabled, true);
  const again = await new SuggestionsSettings(dir).load();
  assert.equal(again.current().learningEnabled, false);
});

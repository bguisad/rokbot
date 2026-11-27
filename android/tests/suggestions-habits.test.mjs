// Smart suggestions on Android: the Host's habit items (frequent), local completion while typing
// (pure-Java SuggestionHabitMatcher on a JVM), tap / dismiss feedback, the bar's fade + rise
// motion, and the 根据习惯学习 / 本地补全 / 清空学习记录 settings.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MockHostServer } from './mock-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

function javac() {
  return ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
}

const HARNESS = String.raw`package dev.rokbot.nativeapp;

import java.util.Arrays;
import java.util.List;

public final class HabitMatcherHarness {
    static void eq(Object a, Object b, String what) {
        if (a == null ? b != null : !a.equals(b)) throw new AssertionError(what + ": expected <" + b + "> got <" + a + ">");
    }

    public static void main(String[] args) {
        List<String> pool = SuggestionHabitMatcher.pool(
                Arrays.asList("提个 PR", "跑一下全量测试"),
                Arrays.asList("跑一下全量测试", "帮我跑一下 lint", "跑测试并截图", "Deploy staging"));
        eq(pool, Arrays.asList("提个 PR", "跑一下全量测试", "帮我跑一下 lint", "跑测试并截图", "Deploy staging"), "pool dedupes, phrases first");
        eq(SuggestionHabitMatcher.match("跑一", pool, 3), Arrays.asList("跑一下全量测试", "帮我跑一下 lint"), "prefix then substring");
        eq(SuggestionHabitMatcher.match("跑测", pool, 3), Arrays.asList("跑测试并截图", "跑一下全量测试"), "then in-order");
        eq(SuggestionHabitMatcher.match("deploy", pool, 3), Arrays.asList("Deploy staging"), "case-insensitive");
        eq(SuggestionHabitMatcher.match("提个 PR", pool, 3).size(), 0, "the draft itself is not a completion");
        eq(SuggestionHabitMatcher.match("  ", pool, 3).size(), 0, "blank draft");
        eq(SuggestionHabitMatcher.match("跑", pool, 1).size(), 1, "max");
        eq(SuggestionHabitMatcher.match("跑", null, 3).size(), 0, "no pool");
        System.out.println("HABIT_MATCHER_OK");
    }
}
`;

test('SuggestionHabitMatcher (JVM): prefix > substring > in-order, dedupe, never the draft itself', () => {
  const javacBin = javac();
  assert.ok(javacBin, 'JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-habit-matcher-'));
  try {
    const dir = path.join(tmp, 'src/dev/rokbot/nativeapp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'HabitMatcherHarness.java'), HARNESS);
    const out = path.join(tmp, 'classes');
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-d', out,
      path.join(SRC, 'SuggestionHabitMatcher.java'), path.join(SRC, 'SuggestionVoice.java'), path.join(dir, 'HabitMatcherHarness.java')], { stdio: 'pipe' });
    const res = cp.execFileSync(javaBin, ['-cp', out, 'dev.rokbot.nativeapp.HabitMatcherHarness'], { encoding: 'utf8' });
    assert.match(res, /HABIT_MATCHER_OK/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.doesNotMatch(read('SuggestionHabitMatcher.java'), /import android\./, 'no Android types');
});

test('Overlay: frequent items, local matches fill (not send), feedback on tap / dismiss, fade + 3dp rise', () => {
  const src = read('ComposerSuggestionsOverlay.java');
  assert.ok(src.includes('res.optJSONArray("frequentSuggestions")') && src.includes('"completionCandidates"'));
  assert.ok(src.includes('new SuggestionItem("frequent", trimmed)'), 'habit items fill after the model items');
  assert.ok(src.includes('SuggestionHabitMatcher.match(draft, pool, SuggestionHabitMatcher.MAX_MATCHES)'));
  assert.ok(src.includes('new SuggestionItem("match", text)'));
  assert.ok(src.includes('pill.setOnClickListener(v -> fillDraft(item.text));'), 'a local match only fills the input');
  assert.ok(src.includes('sendFeedback(activity, "tap", item.text, boundItems);'));
  assert.ok(src.includes('sendFeedback(activity, "dismiss", "", boundItems);'));
  assert.ok(src.includes('HostApiClient.suggestionsFeedback(appCtx, agentId, action, text, shownTexts)'));
  assert.ok(src.includes('if (ctx == null || !sSettingsLearningEnabled) return;'), 'no feedback when learning is off');
  assert.ok(src.includes('res.has("learningEnabled")') && src.includes('res.has("localCompletionEnabled")'));
  assert.ok(/static final long BAR_FADE_MS = 1[5-9]\dL;/.test(src) || src.includes('BAR_FADE_MS = 200L;'), '150-200ms');
  assert.ok(src.includes('sBar.setTranslationY(UiChrome.dp(act, 3));'), 'rises 3dp on show');
  assert.ok(src.includes('bar.animate().alpha(0f).translationY(UiChrome.dp(bar.activity, 3))'), 'fades out on hide');
  assert.ok(src.includes('if (!animationsEnabled(bar.activity) || !bar.isAttachedToWindow())'), 'Remove animations: no motion');
  assert.doesNotMatch(src, /grok/i);

  const api = read('HostApiClient.java');
  assert.ok(api.includes('"/local/suggestions/feedback"') && api.includes('"/local/suggestions/habits"'));
  assert.ok(api.includes('req.put("learningEnabled", learningEnabled.booleanValue())'));
});

test('Settings page: 根据习惯学习 / 本地补全 switches and 清空学习记录 (confirmed)', () => {
  const page = read('SuggestionsSettingsActivity.java');
  assert.ok(page.includes('"根据习惯学习", "Learn From My Habits"') && page.includes('suggestions_learning_switch'));
  assert.ok(page.includes('"本地补全", "Local Completion"') && page.includes('suggestions_local_completion_switch'));
  assert.ok(page.includes('"清空学习记录", "Clear Learned Habits"') && page.includes('confirmClearHabits()'));
  assert.ok(page.includes('HostApiClient.clearSuggestionHabits(this)') && page.includes('ComposerSuggestionsOverlay.clearLearnedHabits()'));
  assert.ok(page.includes('mLearningEnabled = obj.optBoolean("learningEnabled", true)'), 'default on');
  assert.doesNotMatch(page, /grok/i);
});

test('MockHostServer: frequent items, completion candidates, feedback and clearing honor the switches', async t => {
  const host = new MockHostServer({ frequentByAgent: { bot1: ['跑一下 e2e', '提个 PR'] }, suggestionsByAgent: { bot1: ['先修 upload.spec'] } });
  await host.start();
  t.after(() => host.stop());
  host.transcripts.set('bot1', [{ id: 'e1', kind: 'send-message', text: 'e2e 挂了 2 个' }]);
  const pair = await (await fetch(`${host.canonical}/connect/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingKey: host.validPairingKey, deviceName: 'Test Android', platform: 'desktop' }),
  })).json();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${pair.token}` };
  const call = async (method, p, body) => {
    const res = await fetch(`${host.canonical}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };
  const r = await call('POST', '/local/suggestions', { agentId: 'bot1', locale: 'zh-CN' });
  assert.deepEqual(r.aiSuggestions, ['先修 upload.spec']);
  assert.deepEqual(r.frequentSuggestions, ['跑一下 e2e', '提个 PR']);
  assert.deepEqual(r.items.map(i => i.type), ['ai', 'frequent', 'frequent']);
  assert.deepEqual(r.completionCandidates, ['跑一下 e2e', '提个 PR']);
  assert.deepEqual(await call('POST', '/local/suggestions/feedback', { agentId: 'bot1', action: 'tap', text: '先修 upload.spec', shown: ['先修 upload.spec'] }), { recorded: true });
  assert.equal(host.suggestionFeedback.length, 1);
  await call('PUT', '/local/suggestions/settings', { learningEnabled: false });
  const off = await call('POST', '/local/suggestions', { agentId: 'bot1', locale: 'zh-CN' });
  assert.deepEqual(off.frequentSuggestions, []);
  assert.equal(off.learningEnabled, false);
  assert.deepEqual(await call('POST', '/local/suggestions/feedback', { agentId: 'bot1', action: 'tap', text: 'x' }), { recorded: false });
  assert.deepEqual(await call('DELETE', '/local/suggestions/habits'), { cleared: true });
  assert.equal(host.habitsCleared, 1);
});

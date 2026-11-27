// Android composer suggestions stay in the USER's voice (SuggestionVoice.java, same rule as the
// Host's suggestion-voice.mjs): only self-sent messages count, and assistant offers such as
// 「要不要我一起查一下这个问题」 are dropped from model items, habit items, local completion
// candidates/matches and the inline completion ghost.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

const HARNESS = String.raw`package dev.rokbot.nativeapp;

import java.util.Arrays;

public final class SuggestionVoiceHarness {
    static void check(boolean c, String m) { if (!c) throw new AssertionError(m); }
    public static void main(String[] a) {
        String offer = "要不要我一起查一下这个问题", user = "帮我查一下这个问题";
        check(SuggestionVoice.isAssistantOfferPhrase(offer), "offer");
        for (String s : new String[] { "「需要我重跑吗", "需不需要我", "我可以帮你看看", "我来帮你", "我帮你查", "让我来", "我可以为你整理",
                "Would you like me to retry?", "Shall I deploy", "Do you want me to fix it", "Let me check", "I can help you", "I'll help you", "I’ll help you" }) {
            check(SuggestionVoice.isAssistantOfferPhrase(s), "offer: " + s);
        }
        for (String s : new String[] { user, "要不要先回滚", "你帮我查", "Let me know when done", "let men in", "Shallow copy", "", null }) {
            check(!SuggestionVoice.isAssistantOfferPhrase(s), "user voice: " + s);
        }
        check(SuggestionVoice.isSelfUserMessage("user", "message", null, null, false), "self user");
        check(SuggestionVoice.isSelfUserMessage(null, "user", "我", null, false), "kind user, author 我");
        check(!SuggestionVoice.isSelfUserMessage("assistant", "message", null, null, false), "assistant not learned");
        check(!SuggestionVoice.isSelfUserMessage(null, "send-message", null, null, false), "bot send-message not learned");
        check(!SuggestionVoice.isSelfUserMessage("system", null, null, null, false), "system not learned");
        check(!SuggestionVoice.isSelfUserMessage("user", "message", null, null, true), "another Bot's user turn not learned");
        check(!SuggestionVoice.isSelfUserMessage("user", "message", "agent", null, false), "agent sender not learned");
        check(!SuggestionVoice.isSelfUserMessage("user", "message", null, "automation", false), "automation not learned");
        check(SuggestionVoice.userVoiceOnly(Arrays.asList(offer, user)).equals(Arrays.asList(user)), "list filter");
        check(SuggestionHabitMatcher.match("帮", Arrays.asList(offer, user), 3).equals(Arrays.asList(user)), "local match keeps user phrase");
        check(SuggestionHabitMatcher.match("要", Arrays.asList(offer), 3).isEmpty(), "local match drops offer");
        check("".equals(SuggestionVoice.voiceSafeCompletion("要不要", "我一起查一下这个问题")), "ghost offer dropped");
        check("查一下这个问题".equals(SuggestionVoice.voiceSafeCompletion("帮我", "查一下这个问题")), "ghost kept");
        check("先停一下".equals(SuggestionVoice.voiceSafeCompletion("要不要我", "先停一下")), "typed by the user");
        System.out.println("SUGGESTION_VOICE_OK");
    }
}
`;

test('SuggestionVoice (JVM): role filter + assistant-offer filter', () => {
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  assert.ok(javacBin, 'JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-suggest-voice-'));
  try {
    const dir = path.join(tmp, 'src/dev/rokbot/nativeapp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SuggestionVoiceHarness.java'), HARNESS);
    const out = path.join(tmp, 'classes');
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-d', out,
      path.join(SRC, 'SuggestionVoice.java'), path.join(SRC, 'SuggestionHabitMatcher.java'), path.join(dir, 'SuggestionVoiceHarness.java')], { stdio: 'pipe' });
    const res = cp.execFileSync(javaBin, ['-cp', out, 'dev.rokbot.nativeapp.SuggestionVoiceHarness'], { encoding: 'utf8' });
    assert.match(res, /SUGGESTION_VOICE_OK/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.doesNotMatch(read('SuggestionVoice.java'), /import android\./, 'no Android types');
});

test('Overlay wiring: model, habit and candidate lists and the ghost completion pass the voice filter', () => {
  const src = read('ComposerSuggestionsOverlay.java');
  assert.ok(src.includes('!SuggestionVoice.isAssistantOfferPhrase(s)) {\n                            aiItems.add(s);'), 'model items');
  assert.match(src, /static List<String> stringList[\s\S]*?!SuggestionVoice\.isAssistantOfferPhrase\(s\)\) out\.add\(s\);/, 'frequent + completionCandidates');
  assert.ok(src.includes('SuggestionVoice.voiceSafeCompletion(req.draft, res.optString("completion", ""))'), 'inline completion');
  assert.ok(read('SuggestionHabitMatcher.java').includes('SuggestionVoice.isAssistantOfferPhrase(text)'), 'local matches');
});

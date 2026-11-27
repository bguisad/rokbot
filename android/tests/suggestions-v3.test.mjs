// Input suggestions v3 (Android companion): loading shimmer state machine, inline completion
// (ghost text) gating / debounce / stale requests / continuation / LRU cache, the completion
// switch, and the mock Host's /local/suggestions/complete. The pure-Java logic
// (SuggestionLoadState, InlineCompletionEngine, ChatHistoryHints) runs on a JVM.
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
import java.util.Collections;

public final class SuggestionsV3Harness {
    static int checks = 0;

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) throw new AssertionError(what);
    }

    static void eq(Object a, Object b, String what) {
        checks++;
        if (a == null ? b != null : !a.equals(b)) throw new AssertionError(what + ": expected <" + b + "> got <" + a + ">");
    }

    public static void main(String[] args) {
        loadState();
        hints();
        gating();
        debounceAndStale();
        continuation();
        cache();
        acceptAndReset();
        System.out.println("SUGGESTIONS_V3_OK " + checks);
    }

    static void loadState() {
        SuggestionLoadState s = new SuggestionLoadState();
        eq(s.phase(), SuggestionLoadState.Phase.IDLE, "starts idle");
        int t1 = s.begin("a:1:zh", 1000);
        eq(s.phase(), SuggestionLoadState.Phase.LOADING, "loading");
        eq(s.placeholdersAt(1000), 0, "no placeholders inside the grace delay");
        eq(s.placeholdersAt(1000 + SuggestionLoadState.PLACEHOLDER_DELAY_MS), SuggestionLoadState.PLACEHOLDER_COUNT, "placeholders after the delay");
        check(s.placeholderDelayLeft(1050) > 0, "delay left");
        check(s.succeed(t1, Arrays.asList("Check the logs", " ", "Summarize")), "fresh result accepted");
        eq(s.phase(), SuggestionLoadState.Phase.READY, "ready");
        eq(s.items(), Arrays.asList("Check the logs", "Summarize"), "blank items dropped");
        eq(s.placeholdersAt(99999), 0, "no placeholders when ready");

        // Stale: a newer request wins; the older answer is ignored.
        int t2 = s.begin("a:2:zh", 2000);
        int t3 = s.begin("a:3:zh", 2100);
        check(!s.succeed(t2, Arrays.asList("old")), "stale success ignored");
        check(!s.fail(t2), "stale failure ignored");
        eq(s.phase(), SuggestionLoadState.Phase.LOADING, "still loading the newest");
        eq(s.key(), "a:3:zh", "newest key");

        // Failure: FAILED (fade-out) then IDLE; no items.
        check(s.fail(t3), "failure accepted");
        eq(s.phase(), SuggestionLoadState.Phase.FAILED, "failed");
        check(s.isFadingOut(), "fading out");
        eq(s.placeholdersAt(99999), 0, "no placeholders when failed");
        check(!s.succeed(t3, Arrays.asList("late")), "late success after failure ignored");
        check(s.settle(t3), "settles");
        eq(s.phase(), SuggestionLoadState.Phase.IDLE, "idle after fade-out");
        check(!s.settle(t3), "settle once");

        // Empty model answer behaves like a failure (placeholders fade out silently).
        int t4 = s.begin("b:1:en", 3000);
        check(s.succeed(t4, Collections.<String>emptyList()), "empty accepted");
        eq(s.phase(), SuggestionLoadState.Phase.FAILED, "empty -> failed");

        // Cancel makes in-flight results stale.
        int t5 = s.begin("c:1:en", 4000);
        s.cancel();
        eq(s.phase(), SuggestionLoadState.Phase.IDLE, "cancelled");
        check(!s.succeed(t5, Arrays.asList("x")), "result after cancel ignored");

        // Cached result: READY immediately, and it invalidates whatever was loading.
        int t6 = s.begin("d:1:en", 5000);
        s.ready("d:1:en", Arrays.asList("cached"));
        eq(s.phase(), SuggestionLoadState.Phase.READY, "cache ready");
        check(!s.succeed(t6, Arrays.asList("net")), "network answer after cache ignored");
        System.out.println("state|ok");
    }

    static void hints() {
        ChatHistoryHints h = new ChatHistoryHints();
        check(h.mayHaveHistory("agent-1"), "unknown chat: maybe");
        check(!h.mayHaveHistory(""), "no chat id: no history");
        h.record("agent-1", "empty");
        check(!h.mayHaveHistory("agent-1"), "empty chat");
        h.record("agent-1", "model-error");
        check(!h.mayHaveHistory("agent-1"), "errors say nothing");
        h.forget("agent-1");
        check(h.mayHaveHistory("agent-1"), "activity forgets the hint");
        h.record("agent-1", "model");
        eq(h.get("agent-1"), Boolean.TRUE, "model -> history");
        System.out.println("hints|ok");
    }

    static void gating() {
        check(!InlineCompletionEngine.eligible(false, "a", "hello", false, true, true), "switch off");
        check(!InlineCompletionEngine.eligible(true, "a", "h", false, true, true), "1 char");
        check(!InlineCompletionEngine.eligible(true, "a", " h ", false, true, true), "1 char after trim");
        check(InlineCompletionEngine.eligible(true, "a", "he", false, true, true), "2 chars");
        check(!InlineCompletionEngine.eligible(true, "a", "hello", true, true, true), "IME composing");
        check(!InlineCompletionEngine.eligible(true, "a", "hello", false, false, true), "cursor not at end");
        check(!InlineCompletionEngine.eligible(true, "a", "hello", false, true, false), "empty chat");
        check(!InlineCompletionEngine.eligible(true, "", "hello", false, true, true), "no chat");

        // Through the engine: none of these ever produce a request.
        ChatHistoryHints h = new ChatHistoryHints();
        InlineCompletionEngine e = new InlineCompletionEngine(h);
        e.setEnabled(false);
        eq(e.onDraftChanged("a", "hello", false, true, 0), "", "off: nothing shown");
        check(!e.hasPending() && e.poll(10000) == null, "off: no request");
        e.setEnabled(true);
        e.onDraftChanged("a", "h", false, true, 0);
        check(!e.hasPending() && e.poll(10000) == null, "<2 chars: no request");
        e.onDraftChanged("a", "ni hao", true, true, 0);
        check(!e.hasPending() && e.poll(10000) == null, "composition: no request");
        h.record("a", "empty");
        e.onDraftChanged("a", "hello there", false, true, 0);
        check(!e.hasPending() && e.poll(10000) == null, "empty chat: no request");
        eq(e.requestsIssued(), 0, "no request issued at all");
        System.out.println("gating|ok");
    }

    static void debounceAndStale() {
        InlineCompletionEngine e = new InlineCompletionEngine(new ChatHistoryHints());
        e.onDraftChanged("a", "he", false, true, 1000);
        check(e.hasPending(), "pending");
        eq(e.dueAt(), 1000 + InlineCompletionEngine.DEBOUNCE_MS, "due after the debounce");
        check(e.poll(1200) == null, "not before the debounce");
        e.onDraftChanged("a", "hel", false, true, 1200);
        eq(e.dueAt(), 1200 + InlineCompletionEngine.DEBOUNCE_MS, "typing restarts the debounce");
        e.onDraftChanged("a", "hel", false, true, 1300);
        eq(e.dueAt(), 1200 + InlineCompletionEngine.DEBOUNCE_MS, "same draft keeps the timer");
        check(e.poll(1500) == null, "still debouncing");
        InlineCompletionEngine.Request r1 = e.poll(1550);
        check(r1 != null && r1.draft.equals("hel") && r1.agentId.equals("a"), "one request for the last draft");
        eq(e.requestsIssued(), 1, "exactly one request");
        check(e.isCurrent(r1), "current");
        e.onDraftChanged("a", "hel", false, true, 1600);
        check(!e.hasPending(), "same draft while in flight: no second request");

        // New typing makes r1 stale; its answer is ignored.
        int seq = e.sequence();
        e.onDraftChanged("a", "help", false, true, 1700);
        check(e.sequence() != seq, "sequence bumped (overlay disconnects r1)");
        check(!e.isCurrent(r1), "r1 stale");
        eq(e.onResponse(r1, "lo world", "model", "help"), null, "stale response ignored");
        InlineCompletionEngine.Request r2 = e.poll(1700 + InlineCompletionEngine.DEBOUNCE_MS);
        check(r2 != null && r2.seq > r1.seq, "fresh request");
        eq(e.onResponse(r2, " me write a test", "model", "help"), " me write a test", "fresh response shown");
        eq(e.shownSuffix("help"), " me write a test", "shown");

        // Failure: nothing shown, nothing cached.
        InlineCompletionEngine f = new InlineCompletionEngine(new ChatHistoryHints());
        f.onDraftChanged("a", "abc", false, true, 0);
        InlineCompletionEngine.Request fr = f.poll(1000);
        f.onFailure(fr);
        eq(f.cacheSize(), 0, "failures are not cached");
        eq(f.onResponse(fr, "x", "model", "abc"), null, "late answer after failure ignored");
        // Errors from the Host are not cached either.
        f.onDraftChanged("a", "abcd", false, true, 2000);
        InlineCompletionEngine.Request fr2 = f.poll(3000);
        eq(f.onResponse(fr2, "", "model-error", "abcd"), "", "error: nothing shown");
        eq(f.cacheSize(), 0, "errors are not cached");

        // Focus lost: pending dropped.
        f.onDraftChanged("a", "abcde", false, true, 4000);
        check(f.hasPending(), "pending before reset");
        f.reset();
        check(!f.hasPending() && f.poll(99999) == null, "reset drops the pending request");
        System.out.println("debounce|ok");
    }

    static void continuation() {
        eq(InlineCompletionEngine.remainingSuffix("hel", "lo world", "hell"), "o world", "typing along");
        eq(InlineCompletionEngine.remainingSuffix("hel", "lo world", "hello world"), null, "typed it all");
        eq(InlineCompletionEngine.remainingSuffix("hel", "lo world", "helx"), null, "diverged");
        eq(InlineCompletionEngine.remainingSuffix("hel", "lo world", "he"), null, "deleted below the base");

        InlineCompletionEngine e = new InlineCompletionEngine(new ChatHistoryHints());
        e.onDraftChanged("a", "帮我", false, true, 0);
        InlineCompletionEngine.Request r = e.poll(1000);
        eq(e.onResponse(r, "总结一下今天的进展", "model", "帮我"), "总结一下今天的进展", "shown");
        eq(e.onDraftChanged("a", "帮我总", false, true, 1100), "结一下今天的进展", "prefix kept");
        eq(e.onDraftChanged("a", "帮我总结", false, true, 1200), "一下今天的进展", "prefix kept again");
        check(!e.hasPending(), "no new request while continuing");
        eq(e.requestsIssued(), 1, "still one request");
        eq(e.onDraftChanged("a", "帮我总结吧", false, true, 1300), "", "diverged: cleared");
        check(e.hasPending(), "diverged: re-requested (debounced)");
        eq(e.dueAt(), 1300 + InlineCompletionEngine.DEBOUNCE_MS, "debounced re-request");
        // Composition hides the ghost and cancels.
        e.onDraftChanged("a", "帮我总结吧z", true, true, 1400);
        check(!e.hasPending(), "composition cancels the pending request");
        System.out.println("continuation|ok");
    }

    static void cache() {
        InlineCompletionEngine e = new InlineCompletionEngine(new ChatHistoryHints());
        e.onDraftChanged("a", "hello", false, true, 0);
        InlineCompletionEngine.Request r = e.poll(1000);
        e.onResponse(r, " world", "model", "hello");
        e.onDraftChanged("a", "hellx", false, true, 1100);
        e.reset();
        eq(e.onDraftChanged("a", "hello", false, true, 2000), " world", "cache hit shows at once");
        check(!e.hasPending(), "cache hit: no request");
        eq(e.requestsIssued(), 1, "one request in total");
        // Keyed by chat too.
        e.reset();
        e.onDraftChanged("b", "hello", false, true, 3000);
        check(e.hasPending(), "other chat: request");
        // Bounded LRU.
        InlineCompletionEngine big = new InlineCompletionEngine(new ChatHistoryHints());
        for (int i = 0; i < InlineCompletionEngine.CACHE_SIZE + 10; i++) {
            big.onDraftChanged("a", "draft " + i, false, true, i * 1000L);
            InlineCompletionEngine.Request q = big.poll(i * 1000L + 500);
            big.onResponse(q, " more", "model", "draft " + i);
        }
        eq(big.cacheSize(), InlineCompletionEngine.CACHE_SIZE, "LRU bounded");
        System.out.println("cache|ok");
    }

    static void acceptAndReset() {
        InlineCompletionEngine e = new InlineCompletionEngine(new ChatHistoryHints());
        e.onDraftChanged("a", "Please check", false, true, 0);
        InlineCompletionEngine.Request r = e.poll(1000);
        e.onResponse(r, " the build logs", "model", "Please check");
        e.onDraftChanged("a", "Please check t", false, true, 1100);
        eq(e.accept("Please check t"), "Please check the build logs", "accept appends the rest");
        eq(e.shownSuffix("Please check the build logs"), "", "nothing shown after accepting");
        eq(e.onDraftChanged("a", "Please check the build logs", false, true, 1200), "", "accepted text");
        check(!e.hasPending(), "no request for the accepted text itself");
        eq(e.accept("Please check the build logs"), null, "nothing to accept");
        // Switching chats drops the prediction.
        InlineCompletionEngine s = new InlineCompletionEngine(new ChatHistoryHints());
        s.onDraftChanged("a", "hello", false, true, 0);
        InlineCompletionEngine.Request q = s.poll(1000);
        s.onResponse(q, " world", "model", "hello");
        s.clearCache();
        eq(s.onDraftChanged("b", "hello", false, true, 1100), "", "other chat: not shown");
        // Turning completion off clears everything.
        s.setEnabled(false);
        check(!s.hasPending(), "off: nothing pending");
        System.out.println("accept|ok");
    }
}
`;

test('Suggestions v3 logic (JVM): loading state machine, completion gating, debounce, stale requests, continuation, cache', () => {
  const javacBin = javac();
  assert.ok(javacBin, 'JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-suggestions-v3-'));
  try {
    const harnessDir = path.join(tmp, 'src/dev/rokbot/nativeapp');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(path.join(harnessDir, 'SuggestionsV3Harness.java'), HARNESS);
    const out = path.join(tmp, 'classes');
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-d', out,
      ...['SuggestionLoadState.java', 'InlineCompletionEngine.java', 'ChatHistoryHints.java'].map(f => path.join(SRC, f)),
      path.join(harnessDir, 'SuggestionsV3Harness.java')], { stdio: 'pipe' });
    const res = cp.execFileSync(javaBin, ['-cp', out, 'dev.rokbot.nativeapp.SuggestionsV3Harness'], { encoding: 'utf8' });
    assert.match(res, /SUGGESTIONS_V3_OK \d+/, res);
    for (const part of ['state', 'hints', 'gating', 'debounce', 'continuation', 'cache', 'accept']) {
      assert.ok(res.includes(`${part}|ok`), `${part} section ran`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Suggestions v3 logic classes stay free of Android types (unit-testable on a JVM)', () => {
  for (const file of ['SuggestionLoadState.java', 'InlineCompletionEngine.java', 'ChatHistoryHints.java']) {
    const src = read(file);
    assert.doesNotMatch(src, /^import android\./m, `${file} imports android`);
    assert.doesNotMatch(src, /grok/i);
  }
});

test('Composer overlay wires the shimmer, ghost text, Complete pill and completion gating', () => {
  const src = read('ComposerSuggestionsOverlay.java');
  // Loading animation: state machine, shimmer placeholders, cross-fade, reduced motion.
  assert.ok(src.includes('LOAD_STATE.begin(key, now)') && src.includes('LOAD_STATE.succeed(token, aiItems)') && src.includes('LOAD_STATE.fail(token)'));
  assert.ok(src.includes('class SkeletonPillView') && src.includes('LinearGradient'), 'shimmer placeholder pills');
  assert.ok(src.includes('ValueAnimator.areAnimatorsEnabled()') && src.includes('Settings.Global.ANIMATOR_DURATION_SCALE'), 'respects Remove animations');
  assert.ok(src.includes('chipsRow.getOverlay().add(sk)'), 'placeholders fade out in place while chips fade in');
  assert.ok(src.includes('HISTORY.mayHaveHistory(agentId)'), 'no placeholders for chats known to be empty');
  assert.ok(src.includes('UiChrome.palette(activity)'), 'dark + light palette');
  // Inline completion.
  assert.ok(src.includes('HostApiClient.complete(appCtx, req.agentId, req.draft, locale, handle)'));
  assert.ok(src.includes('BaseInputConnection.getComposingSpanStart(sp) != -1'), 'IME composition check');
  assert.ok(src.includes('composer.getLayout()') && src.includes('layout.getPrimaryHorizontal(sel)'), 'ghost text placed from the EditText Layout');
  assert.ok(src.includes('class GhostTextView') && src.includes('class CompletionPill'));
  assert.ok(src.includes('Localize.t(act, "补全", "Complete")'), 'Complete pill label');
  assert.ok(src.includes('target.setText(full);') && src.includes('target.setSelection(full.length());'), 'accept sets the text like click-to-send');
  assert.ok(src.includes('CANCEL_IO.execute(handle::cancel)'), 'stale requests are disconnected off the main thread');
  assert.ok(src.includes('res.has("completionEnabled")'), 'completionEnabled synced');
  // Existing rules still hold.
  assert.ok(src.includes('composer.hasFocus()'), 'focus only');
  assert.ok(src.includes('sendSuggestion(activity, item.text);'), 'tap sends immediately');
  assert.ok(!src.includes('SettingsSuggestionsOverlay'));
  assert.doesNotMatch(src, /grok/i);
  assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');

  const api = read('HostApiClient.java');
  assert.ok(api.includes('"/local/suggestions/complete"'));
  assert.ok(api.includes('COMPLETION_TIMEOUT_MS = 9000'), 'client timeout ~9 s (Host: 8 s)');
  assert.ok(api.includes('req.put("completionEnabled", completionEnabled.booleanValue())'));
  assert.ok(api.includes('if (cancel != null) cancel.attach(conn);'), 'cancellable connection');

  const page = read('SuggestionsSettingsActivity.java');
  assert.ok(page.includes('"输入补全", "Inline Completion"'), 'completion switch');
  assert.ok(page.includes('suggestions_completion_switch'));
  assert.ok(page.includes('saveToggles(null, null, isChecked)'), 'completion switch saved on its own');
  assert.ok(page.includes('mCompletionEnabled = obj.optBoolean("completionEnabled", true)'), 'default on');
  assert.doesNotMatch(page, /grok/i);
});

test('MockHostServer: /local/suggestions/complete honors the switch, min length and empty chats; completionEnabled persists', async t => {
  const host = new MockHostServer();
  await host.start();
  t.after(() => host.stop());
  const pair = await (await fetch(`${host.canonical}/connect/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingKey: host.validPairingKey, deviceName: 'Test Android', platform: 'desktop' }),
  })).json();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${pair.token}` };
  const complete = async body => (await fetch(`${host.canonical}/local/suggestions/complete`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })).json();
  const history = [{ id: 'm1', role: 'assistant', text: '构建完成。' }];

  const settings = await (await fetch(`${host.canonical}/local/suggestions/settings`, { headers })).json();
  assert.equal(settings.completionEnabled, true, 'default on');

  const hit = await complete({ agentId: 'agent-default', text: '帮我总结', locale: 'zh-CN', recentMessages: history });
  assert.deepEqual([hit.enabled, hit.source, hit.text, hit.completion], [true, 'model', '帮我总结', '一下今天的进展和下一步计划']);
  const en = await complete({ agentId: 'agent-default', text: 'Please check', locale: 'en', recentMessages: history });
  assert.equal(en.completion, ' the build logs for errors');
  const tail = await complete({ agentId: 'agent-default', text: 'Something else', recentMessages: history });
  assert.equal(tail.completion, ' and suggest the next steps');

  assert.deepEqual(await complete({ agentId: 'agent-default', text: ' a ', recentMessages: history }),
    { enabled: true, text: ' a ', completion: '', source: 'too-short', cached: false });
  const empty = await complete({ agentId: 'agent-brand-new', text: 'hello there' });
  assert.deepEqual([empty.completion, empty.source], ['', 'empty']);

  // completionEnabled alone, independent of enabled / aiEnabled.
  const put = await (await fetch(`${host.canonical}/local/suggestions/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ completionEnabled: false }),
  })).json();
  assert.deepEqual([put.enabled, put.aiEnabled, put.completionEnabled], [true, true, false]);
  const off = await complete({ agentId: 'agent-default', text: '帮我总结', recentMessages: history });
  assert.deepEqual([off.enabled, off.completion, off.source], [false, '', 'disabled']);
  await fetch(`${host.canonical}/local/suggestions/settings`, { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
  const again = await (await fetch(`${host.canonical}/local/suggestions/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ completionEnabled: true }),
  })).json();
  assert.deepEqual([again.enabled, again.completionEnabled], [false, true], 'suggestions off, completion on');
  const onAgain = await complete({ agentId: 'agent-default', text: '帮我总结', recentMessages: history });
  assert.equal(onAgain.source, 'model');

  // Device auth like the other /local/suggestions* routes.
  const anon = await fetch(`${host.canonical}/local/suggestions/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal(anon.status, 401);
});

test('MockHostServer: slow completions are aborted when the client disconnects', async t => {
  const host = new MockHostServer({ completionDelayMs: 2000, suggestionsDelayMs: 300 });
  await host.start();
  t.after(() => host.stop());
  const pair = await (await fetch(`${host.canonical}/connect/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingKey: host.validPairingKey, deviceName: 'Test Android', platform: 'desktop' }),
  })).json();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${pair.token}` };
  const ctl = new AbortController();
  const started = Date.now();
  const pending = fetch(`${host.canonical}/local/suggestions/complete`, {
    method: 'POST', headers, signal: ctl.signal,
    body: JSON.stringify({ agentId: 'agent-default', text: 'hello', recentMessages: [{ role: 'user', text: 'hi' }] }),
  });
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(pending);
  assert.ok(Date.now() - started < 1500, 'the client is not held');
  // Not aborted: the slow answer still arrives.
  const t1 = Date.now();
  const slow = await (await fetch(`${host.canonical}/local/suggestions/complete`, {
    method: 'POST', headers,
    body: JSON.stringify({ agentId: 'agent-default', text: 'Please check', recentMessages: [{ role: 'user', text: 'hi' }] }),
  })).json();
  assert.ok(Date.now() - t1 >= 1900, 'completionDelayMs applies');
  assert.equal(slow.completion, ' the build logs for errors');
  const t0 = Date.now();
  const sug = await (await fetch(`${host.canonical}/local/suggestions`, {
    method: 'POST', headers, body: JSON.stringify({ agentId: 'agent-default', recentMessages: [{ role: 'user', text: 'hi' }] }),
  })).json();
  assert.ok(Date.now() - t0 >= 280, 'suggestionsDelayMs slows /local/suggestions (shimmer capture)');
  assert.equal(sug.source, 'model');
});

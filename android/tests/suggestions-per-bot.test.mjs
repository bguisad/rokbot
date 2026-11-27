// Input suggestions per Bot (Android companion): the suggestions follow only navigation signals
// (openAgentWindowed / sendPrompt / markAgentViewed / deep links), never RN's background requests
// for other Bots; late or foreign answers are dropped; switching Bots clears what was shown;
// generations are per Bot; prefetch on entering a chat; compact bar. Regression for "a suggestion
// of the RokBot project Bot shown in the Xiaohongshu Bot's chat" (and the slowness that came with
// one global generation bumped by every Bot's activity).
// The pure-Java logic (SuggestionAgentTracker + SuggestionLoadState) runs on a JVM.
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

public final class SuggestionsPerBotHarness {
    static int checks = 0;

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) throw new AssertionError(what);
    }

    static void eq(Object a, Object b, String what) {
        checks++;
        if (a == null ? b != null : !a.equals(b)) throw new AssertionError(what + ": expected <" + b + "> got <" + a + ">");
    }

    static final String A = "agent-rokbot-project";
    static final String B = "agent-xiaohongshu";

    static SuggestionAgentTracker.Signal req(SuggestionAgentTracker t, String path, String id) {
        return t.onGatewayRequest("/api/" + path, id, null);
    }

    public static void main(String[] args) {
        backgroundRequestsDoNotSteal();
        lateAnswersDropped();
        switchClearsShown();
        perBotGenerations();
        failureAndDedupe();
        pauseResumeDeepLink();
        prefetchSignals();
        System.out.println("SUGGESTIONS_PER_BOT_OK " + checks);
    }

    /** The bug: B's chat is open, A works in the background, RN refreshes A for the list. */
    static void backgroundRequestsDoNotSteal() {
        SuggestionAgentTracker t = new SuggestionAgentTracker();
        eq(t.current(), "", "no Bot before any navigation signal");
        eq(req(t, "openAgentWindowed", B), SuggestionAgentTracker.Signal.OPENED, "entering B's chat");
        eq(t.current(), B, "B is current");
        String keyB = t.cacheKey(B, "zh");
        int genA = t.generation(A);
        for (String p : new String[] { "getAgent", "getAgentTranscriptTail", "getAgentTranscript", "getAgentTranscriptWindow",
                "markAgentRead", "getForeverBoxStatus", "getAgentAutomations", "getAgentWorkflows", "updateAgent",
                "setAgentNotifyOnUpdates" }) {
            boolean[] changed = { true };
            eq(t.onGatewayRequest("/api/" + p, A, changed), SuggestionAgentTracker.Signal.IGNORED, p + "(A) ignored");
            check(!changed[0], p + "(A) does not change the current Bot");
            eq(t.current(), B, p + "(A): B stays current");
        }
        eq(t.cacheKey(B, "zh"), keyB, "A's background activity never invalidates B's cache key");
        eq(t.generation(A), genA, "background requests do not bump A either");
        // Unknown paths / blank ids.
        eq(req(t, "listAgents", A), SuggestionAgentTracker.Signal.IGNORED, "other path");
        eq(t.onGatewayRequest(null, A, null), SuggestionAgentTracker.Signal.IGNORED, "no path (legacy observer)");
        eq(req(t, "openAgentWindowed", "  "), SuggestionAgentTracker.Signal.IGNORED, "blank id");
        eq(t.current(), B, "still B");
        check(SuggestionAgentTracker.isNavigationPath("/api/openAgentWindowed")
                && SuggestionAgentTracker.isNavigationPath("/api/sendPrompt")
                && SuggestionAgentTracker.isNavigationPath("/api/markAgentViewed"), "strong signals");
        check(!SuggestionAgentTracker.isNavigationPath("/api/getAgent")
                && !SuggestionAgentTracker.isNavigationPath("/api/markAgentRead")
                && !SuggestionAgentTracker.isNavigationPath("/api/getAgentTranscriptTail"), "background requests are not");
        System.out.println("steal|ok");
    }

    static void lateAnswersDropped() {
        SuggestionAgentTracker t = new SuggestionAgentTracker();
        req(t, "openAgentWindowed", A);
        SuggestionAgentTracker.Request ra = t.begin(A, t.cacheKey(A, "zh"), false, 0);
        check(ra != null, "request for A");
        check(ra.requestId.length() <= SuggestionAgentTracker.MAX_REQUEST_ID_LENGTH && ra.requestId.matches("[A-Za-z0-9_.:-]+"),
                "requestId fits the Host contract");
        check(t.begin(B, t.cacheKey(B, "zh"), false, 0) == null, "never a request for a Bot that is not current");
        req(t, "openAgentWindowed", B);
        check(!t.accept(ra, A, ra.requestId), "A's late answer is dropped in B's chat");
        check(!t.accept(ra, "", ""), "also without echo");

        SuggestionAgentTracker.Request rb1 = t.begin(B, t.cacheKey(B, "zh"), false, 0);
        req(t, "sendPrompt", B); // new turn: new key, new request
        SuggestionAgentTracker.Request rb2 = t.begin(B, t.cacheKey(B, "zh"), false, 0);
        check(rb2 != null && rb2.seq > rb1.seq, "newer sequence");
        check(!t.accept(rb1, B, rb1.requestId), "older sequence dropped");
        check(t.accept(rb2, B, rb2.requestId), "latest answer for the current Bot accepted");

        SuggestionAgentTracker.Request rb3 = t.begin(B, t.cacheKey(B, "en"), false, 0);
        check(!t.accept(rb3, A, ""), "Host echoed another Bot: dropped");
        SuggestionAgentTracker.Request rb4 = t.begin(B, t.cacheKey(B, "en"), false, 0);
        check(!t.accept(rb4, "", "s0-1"), "echoed requestId of another request: dropped");
        SuggestionAgentTracker.Request rb5 = t.begin(B, t.cacheKey(B, "en"), false, 0);
        check(t.accept(rb5, "", ""), "older Host without echo: treated as the requested Bot");
        System.out.println("late|ok");
    }

    /** What the overlay does on a switch: LOAD_STATE.cancel(), so A's loading never lands in B. */
    static void switchClearsShown() {
        SuggestionAgentTracker t = new SuggestionAgentTracker();
        SuggestionLoadState s = new SuggestionLoadState();
        req(t, "openAgentWindowed", A);
        String keyA = t.cacheKey(A, "zh");
        SuggestionAgentTracker.Request ra = t.begin(A, keyA, false, 0);
        ra.loadToken = s.begin(keyA, 0);
        s.ready(keyA, Arrays.asList("合并完#248后记得更新CHANGELOG"));
        eq(s.items(), Arrays.asList("合并完#248后记得更新CHANGELOG"), "A's suggestion shown in A's chat");
        boolean[] changed = new boolean[1];
        t.onGatewayRequest("/api/openAgentWindowed", B, changed);
        check(changed[0], "switch reported");
        if (changed[0]) s.cancel(); // onCurrentAgentChanged()
        eq(s.phase(), SuggestionLoadState.Phase.IDLE, "nothing shown right after the switch");
        check(s.items().isEmpty(), "A's items cleared");
        check(!s.succeed(ra.loadToken, Arrays.asList("late A")), "A's late answer cannot fill B's bar");
        check(!t.accept(ra, A, ra.requestId), "and is not cached either");
        check(!s.key().equals(t.cacheKey(B, "zh")), "B starts from scratch");
        // Re-entering the same chat is not a switch.
        t.onGatewayRequest("/api/openAgentWindowed", B, changed);
        check(!changed[0], "same Bot: no switch");
        t.onGatewayRequest("/api/markAgentViewed", B, changed);
        check(!changed[0], "markAgentViewed of the same Bot: no switch");
        eq(t.onGatewayRequest("/api/markAgentViewed", A, changed), SuggestionAgentTracker.Signal.OPENED, "markAgentViewed(A) moves");
        check(changed[0] && t.current().equals(A), "A current after markAgentViewed(A)");
        System.out.println("switch|ok");
    }

    static void perBotGenerations() {
        SuggestionAgentTracker t = new SuggestionAgentTracker();
        req(t, "openAgentWindowed", B);
        int a0 = t.generation(A), b0 = t.generation(B);
        String keyB = t.cacheKey(B, "zh");
        // A works in the background: its reply notification bumps only A.
        check(!t.onReply(A), "A's reply is not about the current Bot");
        eq(t.generation(A), a0 + 1, "A bumped");
        eq(t.generation(B), b0, "B untouched");
        eq(t.cacheKey(B, "zh"), keyB, "B's cache still hits");
        // B: the user sends, then B replies.
        eq(req(t, "sendPrompt", B), SuggestionAgentTracker.Signal.SENT, "send");
        eq(t.generation(B), b0 + 1, "send bumps B");
        check(t.onReply(B), "B's reply is about the current Bot");
        eq(t.generation(B), b0 + 2, "reply bumps B");
        eq(t.generation(A), a0 + 1, "A untouched by B");
        check(!t.cacheKey(B, "zh").equals(keyB), "B's key moved");
        check(t.cacheKey(B, "zh").startsWith(B + ":"), "key contains the Bot id");
        check(!t.cacheKey(A, "zh").equals(t.cacheKey(B, "zh")), "keys never shared between Bots");
        // sendPrompt from another Bot's chat (composer) is a navigation signal too.
        boolean[] changed = new boolean[1];
        t.onGatewayRequest("/api/sendPrompt", A, changed);
        check(changed[0] && t.current().equals(A), "sendPrompt(A) moves to A");
        eq(t.generation(A), a0 + 2, "and bumps A");
        System.out.println("generation|ok");
    }

    static void failureAndDedupe() {
        SuggestionAgentTracker t = new SuggestionAgentTracker();
        req(t, "openAgentWindowed", B);
        String key = t.cacheKey(B, "zh");
        SuggestionAgentTracker.Request r = t.begin(B, key, true, 0);
        check(r != null, "prefetch");
        check(t.inFlight(key) == r, "in flight");
        check(t.begin(B, key, false, 10) == null, "focus while the prefetch is in flight: no second request");
        check(!t.canRevalidate(key, B, true, 10), "no revalidation either");
        check(t.fail(r), "failure of the latest request");
        check(t.hasFailed(key) && !t.canFetch(key), "failed key is not retried automatically");
        check(t.begin(B, key, false, 20) == null, "no retry storm");
        req(t, "openAgentWindowed", A);
        req(t, "openAgentWindowed", B);
        check(t.canFetch(key), "chat changed: may retry");
        SuggestionAgentTracker.Request r2 = t.begin(B, key, false, 30);
        t.fail(r2);
        t.clearFailures();
        check(t.canFetch(key), "settings changed: may retry");
        System.out.println("failure|ok");
    }

    static void pauseResumeDeepLink() {
        SuggestionAgentTracker t = new SuggestionAgentTracker();
        req(t, "openAgentWindowed", B);
        SuggestionAgentTracker.Request r = t.begin(B, t.cacheKey(B, "zh"), false, 0);
        t.onPaused();
        eq(t.current(), "", "paused: no current Bot");
        check(!t.accept(r, B, r.requestId), "answer arriving while paused is dropped");
        check(t.begin(B, t.cacheKey(B, "zh"), true, 0) == null, "no prefetch while paused");
        check(t.onResumed(), "resumed: RN still shows B");
        eq(t.current(), B, "B again");
        // A deep link / notification tap while paused wins over the paused chat.
        t.onPaused();
        check(t.onDeepLink(A), "deep link to A");
        check(!t.onResumed(), "resume keeps the deep-linked Bot");
        eq(t.current(), A, "A current");
        check(!t.onDeepLink(A), "same deep link again: no switch");
        // Background transcript refreshes while paused do nothing.
        t.onPaused();
        eq(req(t, "getAgentTranscriptTail", B), SuggestionAgentTracker.Signal.IGNORED, "paused: transcript ignored");
        eq(t.current(), "", "still none");
        System.out.println("pause|ok");
    }

    static void prefetchSignals() {
        SuggestionAgentTracker t = new SuggestionAgentTracker();
        req(t, "openAgentWindowed", B);
        eq(req(t, "getAgentTranscriptTail", B), SuggestionAgentTracker.Signal.REPLY_HINT, "B's transcript: maybe a reply");
        eq(req(t, "getAgentTranscriptTail", A), SuggestionAgentTracker.Signal.IGNORED, "A's transcript: nothing");
        String key = t.cacheKey(B, "zh");
        SuggestionAgentTracker.Request r = t.begin(B, key, true, 1000);
        check(t.accept(r, B, r.requestId), "prefetch answer accepted");
        check(!t.canRevalidate(key, B, false, 1000 + SuggestionAgentTracker.REVALIDATE_MIN_INTERVAL_MS - 1), "rate limited");
        check(t.canRevalidate(key, B, false, 1000 + SuggestionAgentTracker.REVALIDATE_MIN_INTERVAL_MS), "after the interval");
        check(t.canRevalidate(key, B, true, 1001), "entering the chat forces it");
        System.out.println("prefetch|ok");
    }
}
`;

test('Suggestions per Bot (JVM): background requests never move the current Bot; late / foreign answers dropped; per-Bot generations', () => {
  const javacBin = javac();
  assert.ok(javacBin, 'JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-suggestions-per-bot-'));
  try {
    const harnessDir = path.join(tmp, 'src/dev/rokbot/nativeapp');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(path.join(harnessDir, 'SuggestionsPerBotHarness.java'), HARNESS);
    const out = path.join(tmp, 'classes');
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-d', out,
      ...['SuggestionAgentTracker.java', 'SuggestionLoadState.java'].map(f => path.join(SRC, f)),
      path.join(harnessDir, 'SuggestionsPerBotHarness.java')], { stdio: 'pipe' });
    const res = cp.execFileSync(javaBin, ['-cp', out, 'dev.rokbot.nativeapp.SuggestionsPerBotHarness'], { encoding: 'utf8' });
    assert.match(res, /SUGGESTIONS_PER_BOT_OK \d+/, res);
    for (const part of ['steal', 'late', 'switch', 'generation', 'failure', 'pause', 'prefetch']) {
      assert.ok(res.includes(`${part}|ok`), `${part} section ran`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SuggestionAgentTracker stays free of Android types (unit-testable on a JVM)', () => {
  const src = read('SuggestionAgentTracker.java');
  assert.doesNotMatch(src, /^import android\./m);
  assert.doesNotMatch(src, /grok/i);
});

test('Overlay: suggestions use the tracker only, validate answers before caching, clear on switch, prefetch', () => {
  const src = read('ComposerSuggestionsOverlay.java');
  const resolve = src.slice(src.indexOf('private static String resolveActiveAgentId()'));
  const resolveBody = resolve.slice(0, resolve.indexOf('}') + 1);
  assert.ok(resolveBody.includes('return AGENTS.current();'), 'current Bot from the tracker');
  assert.doesNotMatch(resolveBody, /getLastAgentId|getViewingAgentId/, 'no longer RN last / viewing agent');
  assert.ok(!src.includes('sTurnGeneration') && !src.includes('sObservedAgentId'), 'global generation removed');
  assert.ok(src.includes('AGENTS.cacheKey(agentId, zh ? "zh" : "en")'), 'cache key per Bot + generation');
  // Validation before anything is cached or shown.
  const onFetched = src.slice(src.indexOf('private static void onFetched('));
  const acceptAt = onFetched.indexOf('AGENTS.accept(req, echoedAgent, echoedRequest)');
  assert.ok(acceptAt > 0 && acceptAt < onFetched.indexOf('AI_CACHE.put('), 'accept() before AI_CACHE.put');
  assert.ok(onFetched.indexOf('AI_CACHE.put(') < onFetched.indexOf('LOAD_STATE.succeed(token, aiItems)'));
  assert.ok(src.includes('res.optString("agentId", "")') && src.includes('res.optString("requestId", "")'), 'echoes read');
  assert.ok(src.includes('HostApiClient.getSuggestions(appCtx, req.agentId, "", locale, req.requestId, false)'));
  assert.ok(src.includes('aiItems.size() < MAX_AI_ITEMS') && src.includes('static final int MAX_AI_ITEMS = 3;'), 'at most 3 AI items');
  // Switch clears at once.
  const changed = src.slice(src.indexOf('private static void onCurrentAgentChanged()'));
  const changedBody = changed.slice(0, changed.indexOf('\n    }\n'));
  for (const s of ['LOAD_STATE.cancel();', 'sBar.reset();', 'hideBar();', 'clearCompletion();', 'COMPLETION.clearCache();']) {
    assert.ok(changedBody.includes(s), `switch: ${s}`);
  }
  // Signals and prefetch.
  assert.ok(src.includes('static void onGatewayRequest(String path, String agentId)'));
  assert.ok(src.includes('case OPENED:') && src.includes('prefetchCurrent(true);'), 'prefetch on entering a chat');
  assert.ok(src.includes('MAIN.postDelayed(REVALIDATE, REPLY_HINT_DEBOUNCE_MS)'), 'debounced revalidation on transcript hints');
  assert.ok(src.includes('static void onAgentReplied(String agentId)') && src.includes('static void onDeepLinkAgent(String agentId)'));
  assert.ok(src.includes('AGENTS.onPaused();'), 'cleared on pause');
  assert.ok(src.includes('if (!req.agentId.equals(AGENTS.current()))'), 'queued requests for a previous Bot skip the network');
  // Compact bar.
  assert.ok(src.includes('static final int BAR_HEIGHT_DP = 32;') && src.includes('static final int CHIP_HEIGHT_DP = 26;'));
  assert.ok(src.includes('static final int CHIP_TEXT_SP = 12;') && src.includes('static final int BAR_GAP_DP = 2;'));
  assert.ok(src.includes('label.setTextSize(TypedValue.COMPLEX_UNIT_SP, CHIP_TEXT_SP);'));
  assert.ok(src.includes('HorizontalScrollView') && src.includes('label.setSingleLine(true);'), 'one horizontally scrolling line');
  assert.ok(src.includes('bar.setVisibility(View.GONE);'), 'takes no space when hidden');
  assert.doesNotMatch(src, /grok/i);
  assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');

  const router = read('GatewayEndpointRouter.java');
  assert.ok(router.includes('ComposerSuggestionsOverlay.onGatewayRequest(path, id);'), 'router passes the path');
  assert.ok(router.includes('setLastAgentId(id);'), 'last agent (notifications, voice) still follows every request');
  for (const f of ['NetworkInterceptor.java', 'R8OkHttpInterceptor.java', 'R8OkHttpInterceptor126.java']) {
    const s = read(f);
    assert.ok(s.includes('GatewayEndpointRouter.observeAgentIdFromJson(path, raw);'), `${f} passes the path`);
    // Direct / LAN Host mode: RN calls the paired Host itself (not a rewritten cloud endpoint);
    // only the suggestions follow those requests (found on an emulator: no Bot was ever observed).
    assert.match(s, /if \(!(GatewayEndpointRouter\.)?isTargetCloudEndpoint\(host\)\) observeSuggestionsAgent\(path, /, `${f} observes direct-Host requests`);
    assert.ok(s.includes('GatewayEndpointRouter.observeSuggestionsAgentFromJson(path, raw)'));
  }
  const dsrc = router.slice(router.indexOf('public static void observeSuggestionsAgentFromJson'));
  const dbody = dsrc.slice(0, dsrc.indexOf('\n    }\n'));
  assert.ok(dbody.includes('ComposerSuggestionsOverlay.onGatewayRequest(path, id)') && !dbody.includes('setLastAgentId'),
    'direct-Host observation feeds the suggestions only');
  assert.ok(router.includes('SuggestionAgentTracker.isNavigationPath(path) || SuggestionAgentTracker.isTranscriptPath(path)'));
  assert.ok(read('NotificationService.java').includes('ComposerSuggestionsOverlay.onAgentReplied(agentId);'), 'reply signal');
  const boot = read('RokBotBootstrap.java');
  assert.ok(boot.includes('ComposerSuggestionsOverlay.onDeepLinkAgent(agentId);'), 'deep links are navigation signals');
  assert.ok(boot.includes('EXTRA_SUGGESTIONS_NAV_SEEN'), 'once per intent');

  const api = read('HostApiClient.java');
  assert.ok(api.includes('SUGGESTIONS_TIMEOUT_MS = 9000'), 'client timeout 9 s (was 18 s)');
  assert.ok(api.includes('req.put("requestId"') && api.includes('req.put("prefetch", true)'));
  assert.ok(!api.includes('"/local/suggestions", req, 18000'));
});

test('MockHostServer /local/suggestions: echoes agentId / requestId / historyId, per-Bot answers, prefetch 202 then cache hit', async t => {
  const host = new MockHostServer({
    suggestionsByAgent: {
      'agent-rokbot': ['合并完#248后记得更新CHANGELOG', '跑一遍回归测试', '整理发布说明', '第四条不应出现'],
      'agent-xhs': ['再写三个标题备选', '配图换成竖版', '加几个话题标签'],
    },
  });
  await host.start();
  t.after(() => host.stop());
  const pair = await (await fetch(`${host.canonical}/connect/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingKey: host.validPairingKey, deviceName: 'Test Android', platform: 'desktop' }),
  })).json();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${pair.token}` };
  host.transcripts.set('agent-rokbot', [{ id: 'e-r1', role: 'assistant', text: 'PR #248 已提交' }]);
  host.transcripts.set('agent-xhs', [{ id: 'e-x1', role: 'assistant', text: '笔记草稿已生成' }]);
  const post = body => fetch(`${host.canonical}/local/suggestions`, { method: 'POST', headers, body: JSON.stringify(body) });

  const xhs = await (await post({ agentId: 'agent-xhs', locale: 'zh-CN', requestId: 's1-1' })).json();
  assert.deepEqual([xhs.agentId, xhs.requestId, xhs.historyId, xhs.source], ['agent-xhs', 's1-1', 'e-x1', 'model']);
  assert.deepEqual(xhs.aiSuggestions, ['再写三个标题备选', '配图换成竖版', '加几个话题标签']);
  assert.ok(!xhs.aiSuggestions.some(s => s.includes('CHANGELOG')), 'never another Bot\'s suggestion');
  const rok = await (await post({ agentId: 'agent-rokbot', locale: 'zh-CN', requestId: 's1-2' })).json();
  assert.equal(rok.aiSuggestions.length, 3, 'at most 3 AI suggestions');
  assert.equal(rok.agentId, 'agent-rokbot');

  // requestId outside the contract is not echoed.
  const bad = await (await post({ agentId: 'agent-xhs', requestId: 'x'.repeat(65) })).json();
  assert.equal(bad.requestId, '');

  // prefetch: 202 at once, then the normal request is served from the Host cache.
  const pre = await post({ agentId: 'agent-xhs', locale: 'en', requestId: 'p-1', prefetch: true });
  assert.equal(pre.status, 202);
  assert.deepEqual(await pre.json(), { accepted: true, agentId: 'agent-xhs', requestId: 'p-1' });
  await new Promise(resolve => setTimeout(resolve, 20));
  const hit = await (await post({ agentId: 'agent-xhs', locale: 'en', requestId: 's2-1' })).json();
  assert.equal(hit.cached, true, 'served from the prefetched cache');
  assert.equal(hit.requestId, 's2-1');
  const empty = await post({ agentId: 'agent-nobody', prefetch: true });
  assert.deepEqual((await empty.json()).accepted, false, 'nothing to prefetch for an empty chat');
  assert.deepEqual(host.suggestionRequests.map(r => r.prefetch), [false, false, false, true, false, true]);
});

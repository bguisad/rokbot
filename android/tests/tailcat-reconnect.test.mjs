// Unit and JVM integration tests for Tailcat reconnect state machine, localPort pinning,
// stale loopback port rewriting in OkHttp interceptors, and foreground/network recovery wiring.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

test('Tailcat reconnect wiring: network monitor, foreground hooks, pool eviction, and stale port rewrite', () => {
  const tm = read('TailcatManager.java');
  assert.match(tm, /onAvailable\(Network network\)/);
  assert.match(tm, /onCapabilitiesChanged\(Network network, NetworkCapabilities capabilities\)/);
  assert.match(tm, /onLinkPropertiesChanged\(Network network, LinkProperties linkProperties\)/);
  assert.match(tm, /onLost\(Network network\)/);
  assert.match(tm, /NET_CAPABILITY_INTERNET/);
  assert.match(tm, /NET_CAPABILITY_VALIDATED/);
  assert.match(tm, /config\.put\("localPort", localPort\)/);
  assert.match(tm, /probeHealth\(next, Math\.max\(timeoutMs, POST_RESTART_PROBE_TIMEOUT_MS\)\)/);

  const sm = read('TailcatReconnectStateMachine.java');
  assert.match(sm, /1_000L, 2_000L, 5_000L, 10_000L, 20_000L, 30_000L/);
  assert.doesNotMatch(sm, /grok/i, 'no legacy brand wording in reconnect state machine');
  assert.doesNotMatch(sm, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji in reconnect state machine');

  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /TailcatManager\.get\(\)\.setResetListener\(/);
  assert.match(boot, /TailcatManager\.get\(\)\.setRecoveryListener\(/);
  assert.match(boot, /R8OkHttpHook\.evictConnections\(\)/);
  assert.match(boot, /TailcatManager\.get\(\)\.onAppForeground\(ctx\)/);
  assert.match(boot, /TailcatManager\.get\(\)\.onAppBackground\(\)/);
  assert.match(boot, /TailcatManager\.get\(\)\.onForegroundActivityResumed\(activity\)/);
  assert.match(boot, /rememberPairedBundleMetaLoopbackPort\(metaFile\)/);

  for (const name of ['R8OkHttpInterceptor126.java', 'R8OkHttpInterceptor.java', 'NetworkInterceptor.java']) {
    const src = read(name);
    assert.match(src, /GatewayEndpointRouter\.rewriteStaleTailcatLoopbackUrl\(/, `${name} rewrites stale Tailcat ports`);
    assert.match(src, /TailcatManager\.get\(\)\.onRequestFailure\(mContext\)/, `${name} triggers recovery on I/O error`);
  }
});

function findJdkAndSdk() {
  const sdkRoot = [
    process.env.ANDROID_HOME,
    path.join(os.homedir(), 'Library/Android/sdk'),
    '/Users/lianqishi/Library/Android/sdk',
    '/Volumes/ORICO/android/sdk',
  ].find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javac = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  if (!sdkRoot || !javac) return null;
  const java = javac.endsWith('javac') ? javac.slice(0, -1) : 'java';
  return { androidJar: path.join(sdkRoot, 'platforms/android-36/android.jar'), javac, java };
}

test('TailcatReconnectStateMachine + GatewayEndpointRouter + TailcatManager port pinning & stale rewrite (JVM)', (t) => {
  const env = findJdkAndSdk();
  if (!env) return t.skip('Android SDK (android-36) and JDK required for JVM verification');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-tc-reconn-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const classesDir = path.join(tmp, 'classes');
  const overrideClassesDir = path.join(tmp, 'override-classes');
  fs.mkdirSync(classesDir, { recursive: true });
  fs.mkdirSync(overrideClassesDir, { recursive: true });

  // Collect companion sources EXCEPT TailcatBridge.java (replaced by a controllable mock for JVM tests)
  const sources = [];
  const walk = (dir, excludeSuffix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, excludeSuffix);
      else if (ent.name.endsWith('.java') && (!excludeSuffix || !full.endsWith(excludeSuffix))) {
        sources.push(full);
      }
    }
  };
  walk(path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java'));
  walk(path.join(NATIVE_ROOT, 'companion/src/main/java'), 'TailcatBridge.java');

  // Minimal controllable TailcatBridge mock for JVM
  const mockBridgeDir = path.join(tmp, 'src/dev/grokbot/local');
  fs.mkdirSync(mockBridgeDir, { recursive: true });
  const mockBridgeFile = path.join(mockBridgeDir, 'TailcatBridge.java');
  fs.writeFileSync(mockBridgeFile, `package dev.grokbot.local;

import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public final class TailcatBridge {
    public static volatile boolean available = true;
    public static volatile int nextHandle = 1;
    public static volatile int fallbackPort = 0;
    public static volatile boolean rejectRequestedLocalPort = false;
    public static volatile String mockStatusState = "ready";
    public static volatile String mockStatusError = "";
    public static volatile boolean mockListening = true;
    public static final List<String> startConfigs = new ArrayList<>();
    public static final List<Integer> stoppedHandles = new ArrayList<>();

    public static void reset() {
        available = true;
        nextHandle = 1;
        fallbackPort = 0;
        rejectRequestedLocalPort = false;
        mockStatusState = "ready";
        mockStatusError = "";
        mockListening = true;
        startConfigs.clear();
        stoppedHandles.clear();
    }

    public static boolean isAvailable() { return available; }
    public static String getLoadError() { return available ? null : "mock-disabled"; }
    public static String safeIdentity() { return "{\\"private\\":\\"mock-priv-key\\"}"; }

    public static String safeStart(String configJson) {
        startConfigs.add(configJson);
        if (!available) throw new IllegalStateException("unavailable");
        try {
            JSONObject cfg = new JSONObject(configJson);
            int requestedPort = cfg.optInt("localPort", 0);
            if (requestedPort > 0 && rejectRequestedLocalPort) {
                return "{\\"error\\":\\"cannot open local tunnel port\\"}";
            }
            int assignedPort = requestedPort > 0 ? requestedPort : fallbackPort;
            int handle = nextHandle++;
            JSONObject status = new JSONObject();
            status.put("listening", true);
            status.put("state", mockStatusState);
            status.put("path", "direct");
            status.put("localURL", "http://127.0.0.1:" + assignedPort);
            JSONObject reply = new JSONObject();
            reply.put("handle", handle);
            reply.put("status", status);
            return reply.toString();
        } catch (Exception e) {
            return "{\\"error\\":\\"mock-error\\"}";
        }
    }

    public static String safeStatus(int handle) {
        try {
            JSONObject s = new JSONObject();
            s.put("listening", mockListening);
            s.put("state", mockStatusState);
            s.put("error", mockStatusError);
            s.put("path", "direct");
            return s.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    public static void safeStop(int handle) {
        if (handle > 0) stoppedHandles.add(handle);
    }
}
`);
  sources.push(mockBridgeFile);

  const writeOverride = (relPath, content) => {
    const dest = path.join(tmp, 'overrides', relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    return dest;
  };

  const overrideFiles = [
    writeOverride('android/os/SystemClock.java', `package android.os;
public final class SystemClock {
    public static volatile long now = 1000L;
    public static long elapsedRealtime() { return now; }
    public static long uptimeMillis() { return now; }
}
`),
    writeOverride('android/util/Base64.java', `package android.util;
public final class Base64 {
    public static final int DEFAULT = 0;
    public static final int NO_WRAP = 2;
    public static String encodeToString(byte[] input, int flags) {
        return java.util.Base64.getEncoder().encodeToString(input);
    }
    public static byte[] decode(String str, int flags) {
        return java.util.Base64.getDecoder().decode(str);
    }
}
`),
    writeOverride('android/util/Log.java', `package android.util;
public final class Log {
    public static final int DEBUG = 3;
    public static boolean isLoggable(String tag, int level) { return false; }
    public static int d(String tag, String msg) { return 0; }
    public static int i(String tag, String msg) { return 0; }
    public static int w(String tag, String msg) { return 0; }
    public static int w(String tag, String msg, Throwable tr) { return 0; }
    public static int e(String tag, String msg) { return 0; }
}
`),
    writeOverride('org/json/JSONObject.java', `package org.json;
import java.util.*;
public class JSONObject {
    public static final Object NULL = new Object() {
        @Override public boolean equals(Object o) { return o == this || o == null; }
        @Override public String toString() { return "null"; }
    };
    final Map<String, Object> map = new LinkedHashMap<>();
    public JSONObject() {}
    public JSONObject(String json) {
        Object parsed = MiniJson.parse(json);
        if (!(parsed instanceof Map)) throw new RuntimeException("Not JSON object");
        @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) parsed;
        map.putAll(m);
    }
    JSONObject(Map<String, Object> m) { map.putAll(m); }
    public JSONObject put(String k, Object v) {
        if (v == null) map.remove(k); else map.put(k, v);
        return this;
    }
    public JSONObject put(String k, int v) { map.put(k, v); return this; }
    public JSONObject put(String k, long v) { map.put(k, v); return this; }
    public JSONObject put(String k, boolean v) { map.put(k, v); return this; }
    public boolean has(String k) { return map.containsKey(k); }
    public Object opt(String k) { return map.get(k); }
    public String optString(String k, String d) {
        Object v = map.get(k);
        return v == null ? d : String.valueOf(v);
    }
    public String optString(String k) { return optString(k, ""); }
    public int optInt(String k, int d) {
        Object v = map.get(k);
        return v instanceof Number ? ((Number) v).intValue() : d;
    }
    public boolean optBoolean(String k, boolean d) {
        Object v = map.get(k);
        return v instanceof Boolean ? (Boolean) v : d;
    }
    public JSONObject optJSONObject(String k) {
        Object v = map.get(k);
        if (v instanceof JSONObject) return (JSONObject) v;
        if (v instanceof Map) { @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) v; return new JSONObject(m); }
        return null;
    }
    @Override public String toString() { return MiniJson.stringify(map); }
}
`),
    writeOverride('org/json/JSONArray.java', `package org.json;
import java.util.*;
public class JSONArray {
    final List<Object> list = new ArrayList<>();
    public JSONArray() {}
    JSONArray(List<Object> l) { list.addAll(l); }
    public int length() { return list.size(); }
    public JSONArray put(Object v) { list.add(v); return this; }
    @Override public String toString() { return MiniJson.stringify(list); }
}
`),
    writeOverride('org/json/MiniJson.java', `package org.json;
import java.util.*;
final class MiniJson {
    static Object parse(String s) { return new Parser(s).parseVal(); }
    static String stringify(Object o) {
        if (o == null || o == JSONObject.NULL) return "null";
        if (o instanceof JSONObject) return o.toString();
        if (o instanceof JSONArray) return o.toString();
        if (o instanceof Boolean || o instanceof Number) return String.valueOf(o);
        if (o instanceof Map) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(quote(String.valueOf(e.getKey()))).append(':').append(stringify(e.getValue()));
            }
            return sb.append('}').toString();
        }
        if (o instanceof Collection) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object item : (Collection<?>) o) {
                if (!first) sb.append(',');
                first = false;
                sb.append(stringify(item));
            }
            return sb.append(']').toString();
        }
        return quote(String.valueOf(o));
    }
    static String quote(String s) {
        StringBuilder sb = new StringBuilder("\\\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\\\') sb.append('\\\\').append(c);
            else if (c == '\\n') sb.append("\\\\n");
            else if (c == '\\r') sb.append("\\\\r");
            else if (c == '\\t') sb.append("\\\\t");
            else sb.append(c);
        }
        return sb.append('"').toString();
    }
    static final class Parser {
        final String s; int i = 0;
        Parser(String s) { this.s = s != null ? s : ""; }
        void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        Object parseVal() {
            ws();
            if (i >= s.length()) throw new RuntimeException("EOF");
            char c = s.charAt(i);
            if (c == '{') return parseObj();
            if (c == '[') return parseArr();
            if (c == '"') return parseStr();
            if (c == 't') { i += 4; return Boolean.TRUE; }
            if (c == 'f') { i += 5; return Boolean.FALSE; }
            if (c == 'n') { i += 4; return JSONObject.NULL; }
            int start = i;
            while (i < s.length() && "0123456789.-+eE".indexOf(s.charAt(i)) >= 0) i++;
            String num = s.substring(start, i);
            if (num.contains(".") || num.contains("e") || num.contains("E")) return Double.parseDouble(num);
            return Long.parseLong(num);
        }
        Map<String, Object> parseObj() {
            i++; Map<String, Object> m = new LinkedHashMap<>(); ws();
            if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
            while (true) {
                ws(); String k = parseStr(); ws(); i++;
                m.put(k, parseVal()); ws();
                if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                if (i < s.length() && s.charAt(i) == '}') { i++; break; }
                throw new RuntimeException("Bad object at " + i);
            }
            return m;
        }
        List<Object> parseArr() {
            i++; List<Object> l = new ArrayList<>(); ws();
            if (i < s.length() && s.charAt(i) == ']') { i++; return l; }
            while (true) {
                l.add(parseVal()); ws();
                if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                if (i < s.length() && s.charAt(i) == ']') { i++; break; }
                throw new RuntimeException("Bad array at " + i);
            }
            return l;
        }
        String parseStr() {
            i++; StringBuilder sb = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c == '\\\\') {
                    char esc = s.charAt(i++);
                    if (esc == 'n') sb.append('\\n');
                    else if (esc == 'r') sb.append('\\r');
                    else if (esc == 't') sb.append('\\t');
                    else if (esc == 'u') { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                    else sb.append(esc);
                } else sb.append(c);
            }
            throw new RuntimeException("Unterminated string");
        }
    }
}
`),
  ];

  // Main JVM test harness
  const harnessDir = path.join(tmp, 'src/dev/rokbot/nativeapp');
  fs.mkdirSync(harnessDir, { recursive: true });
  const harnessFile = path.join(harnessDir, 'TailcatReconnectHarness.java');
  fs.writeFileSync(harnessFile, `package dev.rokbot.nativeapp;

import com.sun.net.httpserver.HttpServer;
import dev.grokbot.local.TailcatBridge;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public class TailcatReconnectHarness {
    static void check(boolean cond, String msg) {
        if (!cond) throw new AssertionError("FAIL: " + msg);
    }

    static final class VirtualScheduler implements TailcatReconnectStateMachine.Clock, TailcatReconnectStateMachine.Scheduler {
        static final class Task implements Comparable<Task>, TailcatReconnectStateMachine.Cancellable {
            final long runAt;
            final long seq;
            final Runnable runnable;
            boolean cancelled = false;
            Task(long runAt, long seq, Runnable r) { this.runAt = runAt; this.seq = seq; this.runnable = r; }
            @Override public int compareTo(Task o) {
                int c = Long.compare(this.runAt, o.runAt);
                return c != 0 ? c : Long.compare(this.seq, o.seq);
            }
            @Override public void cancel() { cancelled = true; }
        }

        long now = 10_000L;
        long seq = 0L;
        final PriorityQueue<Task> queue = new PriorityQueue<>();
        final List<Long> scheduledDelays = new ArrayList<>();

        @Override public long nowMs() { return now; }

        @Override public TailcatReconnectStateMachine.Cancellable schedule(long delayMs, Runnable task) {
            scheduledDelays.add(delayMs);
            Task t = new Task(now + Math.max(0L, delayMs), ++seq, task);
            queue.add(t);
            return t;
        }

        void runDue() {
            while (!queue.isEmpty() && queue.peek().runAt <= now) {
                Task t = queue.poll();
                if (!t.cancelled) t.runnable.run();
            }
        }

        void advanceBy(long deltaMs) {
            long target = now + deltaMs;
            while (!queue.isEmpty() && queue.peek().runAt <= target) {
                Task t = queue.poll();
                if (t.cancelled) continue;
                now = t.runAt;
                t.runnable.run();
            }
            now = target;
        }
    }

    static final class FakeActions implements TailcatReconnectStateMachine.Actions {
        boolean paired = true;
        boolean tailcat = true;
        boolean hasInternet = true;
        int probeCount = 0;
        int failFirstNProbes = 0;
        boolean nextRestarted = true;
        int recoveredCount = 0;
        int directRestoredCount = 0;
        final List<Boolean> netChanges = new ArrayList<>();
        Runnable onProbeHook = null;

        @Override public boolean isPaired() { return paired; }
        @Override public boolean isTailcatEnabled() { return tailcat; }
        @Override public boolean hasActiveInternet() { return hasInternet; }

        @Override public TailcatReconnectStateMachine.ProbeOutcome probeAndRecover() {
            probeCount++;
            if (onProbeHook != null) {
                Runnable h = onProbeHook;
                onProbeHook = null;
                h.run();
            }
            boolean ok = probeCount > failFirstNProbes;
            return new TailcatReconnectStateMachine.ProbeOutcome(ok, nextRestarted, "http://127.0.0.1:41000", false);
        }

        @Override public void onRecovered(boolean restarted, String localUrl, boolean portChanged) {
            recoveredCount++;
        }

        @Override public void onDirectNetworkRestored() {
            directRestoredCount++;
        }

        @Override public void onNetworkAvailabilityChanged(boolean internet) {
            netChanges.add(internet);
        }
    }

    static void testBackoffScheduleAndNeverStalls() {
        VirtualScheduler vs = new VirtualScheduler();
        FakeActions act = new FakeActions();
        act.failFirstNProbes = 7; // fail 7 times, succeed on 8th
        TailcatReconnectStateMachine sm = new TailcatReconnectStateMachine(vs, vs, act);
        sm.initNetworkSnapshot(new TailcatReconnectStateMachine.NetworkSnapshot(true, 100L, "W", true, true, "192.168.1.2"));

        // Network switches Wi-Fi -> 5G
        sm.onNetworkAvailable(new TailcatReconnectStateMachine.NetworkSnapshot(true, 200L, "C", true, false, "10.0.0.2"));
        vs.runDue();
        check(act.probeCount == 1, "Attempt 1 ran immediately");
        check(sm.getState() == TailcatReconnectStateMachine.State.BACKOFF_WAIT, "State enters BACKOFF_WAIT");

        long[] expectedDelays = new long[] { 1000L, 2000L, 5000L, 10000L, 20000L, 30000L, 30000L };
        for (int i = 0; i < expectedDelays.length; i++) {
            vs.advanceBy(expectedDelays[i] - 1L);
            check(act.probeCount == i + 1, "Should not fire early before backoff " + expectedDelays[i]);
            vs.advanceBy(1L);
            check(act.probeCount == i + 2, "Attempt " + (i + 2) + " fired after " + expectedDelays[i] + "ms");
        }
        check(sm.getState() == TailcatReconnectStateMachine.State.HEALTHY, "Recovered to HEALTHY on attempt 8");
        check(sm.getBackoffAttempt() == 0, "Backoff reset to 0 after recovery");
        check(act.recoveredCount == 1, "onRecovered fired once");
    }

    static void testCapabilitiesValidatedTransitionTriggersProbe() {
        VirtualScheduler vs = new VirtualScheduler();
        FakeActions act = new FakeActions();
        act.failFirstNProbes = 1; // unvalidated attempt fails, validated succeeds
        TailcatReconnectStateMachine sm = new TailcatReconnectStateMachine(vs, vs, act);

        // 1. onAvailable fires before NET_CAPABILITY_VALIDATED
        sm.onNetworkAvailable(new TailcatReconnectStateMachine.NetworkSnapshot(true, 300L, "C", true, false, "10.1.2.3"));
        vs.runDue();
        check(act.probeCount == 1, "Initial probe on onAvailable");
        check(sm.getState() == TailcatReconnectStateMachine.State.BACKOFF_WAIT, "Waiting in backoff");

        // 2. 300ms later, Android validates the SAME networkHandle & SAME transport
        vs.advanceBy(300L);
        sm.onNetworkCapabilitiesChanged(new TailcatReconnectStateMachine.NetworkSnapshot(true, 300L, "C", true, true, "10.1.2.3"));
        vs.runDue();
        check(act.probeCount == 2, "onCapabilitiesChanged(V=0->V=1) must trigger immediate probe even on same handle/transport");
        check(sm.getState() == TailcatReconnectStateMachine.State.HEALTHY, "Recovered immediately on validation");
        check(act.recoveredCount == 1, "onRecovered fired");
    }

    static void testOnLostThenSameHandleOnAvailableRecovers() {
        VirtualScheduler vs = new VirtualScheduler();
        FakeActions act = new FakeActions();
        TailcatReconnectStateMachine sm = new TailcatReconnectStateMachine(vs, vs, act);
        TailcatReconnectStateMachine.NetworkSnapshot wifi =
                new TailcatReconnectStateMachine.NetworkSnapshot(true, 100L, "W", true, true, "192.168.1.5");
        sm.initNetworkSnapshot(wifi);
        sm.onNetworkAvailable(wifi);
        vs.runDue();
        check(sm.getState() == TailcatReconnectStateMachine.State.HEALTHY, "Initially healthy");
        int probesBefore = act.probeCount;

        // Brief disconnect on same Wi-Fi network
        act.hasInternet = false;
        sm.onNetworkLost(100L, TailcatReconnectStateMachine.NetworkSnapshot.offline());
        check(sm.getState() == TailcatReconnectStateMachine.State.OFFLINE, "Transitions to OFFLINE");
        check("none".equals(sm.getLastSignature()), "onLost clears signature to none");
        check(act.netChanges.get(act.netChanges.size() - 1) == false, "Notified offline");

        // Reconnects on exact same handle + transport + IP
        vs.advanceBy(200L);
        act.hasInternet = true;
        sm.onNetworkAvailable(wifi);
        vs.runDue();
        check(act.probeCount == probesBefore + 1, "onAvailable after onLost MUST probe even with same handle/signature");
        check(sm.getState() == TailcatReconnectStateMachine.State.HEALTHY, "Back to HEALTHY");
        check(act.recoveredCount >= 1, "onRecovered called after brief disconnect");
    }

    static void testOnLostRacesWithActiveReplacementAndSafetyRecheck() {
        VirtualScheduler vs = new VirtualScheduler();
        FakeActions act = new FakeActions();
        TailcatReconnectStateMachine sm = new TailcatReconnectStateMachine(vs, vs, act);
        TailcatReconnectStateMachine.NetworkSnapshot wifi =
                new TailcatReconnectStateMachine.NetworkSnapshot(true, 100L, "W", true, true, "192.168.1.5");
        TailcatReconnectStateMachine.NetworkSnapshot cell =
                new TailcatReconnectStateMachine.NetworkSnapshot(true, 200L, "C", true, true, "10.0.0.5");
        sm.initNetworkSnapshot(wifi);

        // Case A: onLost(wifi) fires while active network is already cell
        sm.onNetworkLost(100L, cell);
        vs.runDue();
        check(act.probeCount == 1, "Immediate probe when active network already switched to cell");
        check(sm.getState() == TailcatReconnectStateMachine.State.HEALTHY, "Healthy on cell");

        // Case B: onLost(cell) goes offline, onAvailable is missed, but internet is back at 2s safety recheck
        act.hasInternet = false;
        sm.onNetworkLost(200L, TailcatReconnectStateMachine.NetworkSnapshot.offline());
        check(sm.getState() == TailcatReconnectStateMachine.State.OFFLINE, "Offline");
        vs.advanceBy(1500L);
        act.hasInternet = true;
        vs.advanceBy(500L); // 2000ms total
        check(act.probeCount == 2, "Safety recheck at 2000ms recovered missed onAvailable");
        check(sm.getState() == TailcatReconnectStateMachine.State.HEALTHY, "Healthy after safety recheck");
    }

    static void testLinkPropertiesIpChangeTriggersProbe() {
        VirtualScheduler vs = new VirtualScheduler();
        FakeActions act = new FakeActions();
        TailcatReconnectStateMachine sm = new TailcatReconnectStateMachine(vs, vs, act);
        sm.initNetworkSnapshot(new TailcatReconnectStateMachine.NetworkSnapshot(true, 100L, "W", true, true, "192.168.1.10"));
        sm.onNetworkLinkPropertiesChanged(new TailcatReconnectStateMachine.NetworkSnapshot(true, 100L, "W", true, true, "192.168.1.42"));
        vs.runDue();
        check(act.probeCount == 1, "IP change on same handle triggers probe");
        check(sm.getState() == TailcatReconnectStateMachine.State.HEALTHY, "Healthy after IP change");
    }

    static void testForegroundReturnAndWatchdogAndBackgroundStop() {
        VirtualScheduler vs = new VirtualScheduler();
        FakeActions act = new FakeActions();
        act.failFirstNProbes = 2; // first 2 fail, 3rd succeeds
        TailcatReconnectStateMachine sm = new TailcatReconnectStateMachine(vs, vs, act);

        // Enter backoff wait (after attempt 1 fails, waiting 1000ms, attempt 2 fails, waiting 2000ms)
        sm.onNetworkAvailable(new TailcatReconnectStateMachine.NetworkSnapshot(true, 10L, "W", true, true, ""));
        vs.runDue();
        vs.advanceBy(1000L);
        check(act.probeCount == 2, "2 failed attempts");
        check(sm.getState() == TailcatReconnectStateMachine.State.BACKOFF_WAIT, "Waiting 2000ms in backoff");

        // User brings app to foreground 200ms later -> must NOT wait remaining 1800ms!
        vs.advanceBy(200L);
        sm.onAppForeground();
        vs.runDue();
        check(act.probeCount == 3, "onAppForeground immediately resets backoff and probes");
        check(sm.getState() == TailcatReconnectStateMachine.State.HEALTHY, "Recovered immediately on foreground");

        // Foreground watchdog fires at +15s
        vs.advanceBy(TailcatReconnectStateMachine.FOREGROUND_WATCHDOG_MS);
        check(act.probeCount == 4, "Foreground watchdog probed after 15s");

        // Background stops foreground watchdog
        sm.onAppBackground();
        vs.advanceBy(TailcatReconnectStateMachine.FOREGROUND_WATCHDOG_MS * 3);
        check(act.probeCount == 4, "No foreground watchdog probes while backgrounded");
    }

    static void testRequestFailureAndInFlightCoalescing() {
        VirtualScheduler vs = new VirtualScheduler();
        FakeActions act = new FakeActions();
        TailcatReconnectStateMachine sm = new TailcatReconnectStateMachine(vs, vs, act);

        // Trigger probe #1, and DURING probe #1 simulate another network change + request failure
        act.onProbeHook = () -> {
            sm.onRequestFailure();
            sm.onNetworkAvailable(new TailcatReconnectStateMachine.NetworkSnapshot(true, 500L, "C", true, true, "10.9.9.9"));
        };
        sm.onRequestFailure();
        vs.runDue();
        check(act.probeCount == 2, "In-flight triggers coalesce into exactly one follow-up probe, got " + act.probeCount);
        check(sm.getState() == TailcatReconnectStateMachine.State.HEALTHY, "Healthy after coalesced probe");
    }

    static void testDirectModeNetworkRestored() {
        VirtualScheduler vs = new VirtualScheduler();
        FakeActions act = new FakeActions();
        act.tailcat = false;
        TailcatReconnectStateMachine sm = new TailcatReconnectStateMachine(vs, vs, act);
        sm.onNetworkLost(1L, TailcatReconnectStateMachine.NetworkSnapshot.offline());
        sm.onNetworkAvailable(new TailcatReconnectStateMachine.NetworkSnapshot(true, 2L, "C", true, true, ""));
        vs.runDue();
        check(act.probeCount == 0, "Direct mode does not run Tailcat probe");
        check(act.directRestoredCount == 1, "Direct mode fires onDirectNetworkRestored");
    }

    static void testGatewayStaleLoopbackRewrite() {
        Set<Integer> known = new HashSet<>(Arrays.asList(41234, 41235));
        GatewayEndpointRouter.PortPredicate pred = known::contains;

        // Rewrites stale Tailcat HTTP URL preserving path, query, spaces, fragment
        String r1 = GatewayEndpointRouter.rewriteStaleLoopbackUrlWithKnownPorts(
                "http://127.0.0.1:41234/api/sendPrompt?agentId=a1&q=hello world#top",
                "http://127.0.0.1:52987", pred);
        check("http://127.0.0.1:52987/api/sendPrompt?agentId=a1&q=hello world#top".equals(r1),
                "Expected HTTP rewrite, got: " + r1);

        // Rewrites stale Tailcat WebSocket URL
        String r2 = GatewayEndpointRouter.rewriteStaleLoopbackUrlWithKnownPorts(
                "ws://127.0.0.1:41234/local/voice/realtime?v=1",
                "http://127.0.0.1:52987", pred);
        check("ws://127.0.0.1:52987/local/voice/realtime?v=1".equals(r2),
                "Expected WS rewrite, got: " + r2);

        // Already matching port -> null
        String r3 = GatewayEndpointRouter.rewriteStaleLoopbackUrlWithKnownPorts(
                "http://127.0.0.1:52987/api/sendPrompt",
                "http://127.0.0.1:52987", pred);
        check(r3 == null, "Matching port must return null");

        // Unknown localhost port (e.g. ComputerViewerActivity VNC proxy) -> null
        String r4 = GatewayEndpointRouter.rewriteStaleLoopbackUrlWithKnownPorts(
                "http://127.0.0.1:61000/__gb_auth/",
                "http://127.0.0.1:52987", pred);
        check(r4 == null, "Unknown loopback port must NEVER be hijacked");

        // Non-loopback host -> null
        String r5 = GatewayEndpointRouter.rewriteStaleLoopbackUrlWithKnownPorts(
                "https://host.example:41234/api/sendPrompt",
                "http://127.0.0.1:52987", pred);
        check(r5 == null, "Non-loopback URL must return null");

        // Port extraction helper
        check(TailcatManager.extractLoopbackPort("http://127.0.0.1:41234/api/events?x=1") == 41234, "extractLoopbackPort http");
        check(TailcatManager.extractLoopbackPort("http://example.com:8000") == 0, "extractLoopbackPort non-loopback");
    }

    static final class FakeContext extends android.content.ContextWrapper {
        android.content.SharedPreferences prefs;
        FakeContext() { super(null); }
        @Override public android.content.Context getApplicationContext() { return this; }
        @Override public android.content.SharedPreferences getSharedPreferences(String name, int mode) { return prefs; }
    }

    @SuppressWarnings("unchecked")
    static <T> T alloc(Class<T> cls) throws Exception {
        Field f = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
        f.setAccessible(true);
        sun.misc.Unsafe u = (sun.misc.Unsafe) f.get(null);
        return (T) u.allocateInstance(cls);
    }

    static void installFakeAndroidKeyStore() throws Exception {
        final javax.crypto.SecretKey fixedKey = new javax.crypto.spec.SecretKeySpec(
                new byte[] { 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32 }, "AES");
        java.security.Provider prov = new java.security.Provider("AndroidKeyStore", "1.0", "test") {{
            putService(new java.security.Provider.Service(
                    this, "KeyStore", "AndroidKeyStore", FakeKsSpi.class.getName(), null, null) {
                @Override public Object newInstance(Object p) { return new FakeKsSpi(fixedKey); }
            });
        }};
        java.security.Security.insertProviderAt(prov, 1);
    }

    public static final class FakeKsSpi extends java.security.KeyStoreSpi {
        final javax.crypto.SecretKey key;
        FakeKsSpi(javax.crypto.SecretKey k) { this.key = k; }
        @Override public java.security.Key engineGetKey(String a, char[] p) { return key; }
        @Override public java.security.cert.Certificate[] engineGetCertificateChain(String a) { return null; }
        @Override public java.security.cert.Certificate engineGetCertificate(String a) { return null; }
        @Override public java.util.Date engineGetCreationDate(String a) { return new java.util.Date(); }
        @Override public void engineSetKeyEntry(String a, java.security.Key k, char[] p, java.security.cert.Certificate[] c) {}
        @Override public void engineSetKeyEntry(String a, byte[] k, java.security.cert.Certificate[] c) {}
        @Override public void engineSetCertificateEntry(String a, java.security.cert.Certificate c) {}
        @Override public void engineDeleteEntry(String a) {}
        @Override public java.util.Enumeration<String> engineAliases() { return Collections.enumeration(Collections.singletonList("rokbot-native-device-credential")); }
        @Override public boolean engineContainsAlias(String a) { return true; }
        @Override public int engineSize() { return 1; }
        @Override public boolean engineIsKeyEntry(String a) { return true; }
        @Override public boolean engineIsCertificateEntry(String a) { return false; }
        @Override public String engineGetCertificateAlias(java.security.cert.Certificate c) { return null; }
        @Override public void engineStore(java.io.OutputStream s, char[] p) {}
        @Override public void engineLoad(java.io.InputStream s, char[] p) {}
        @Override public java.security.KeyStore.Entry engineGetEntry(String a, java.security.KeyStore.ProtectionParameter pp) {
            return new java.security.KeyStore.SecretKeyEntry(key);
        }
    }

    static void testTailcatManagerPortPinningAndFallbackAndHealthVerify() throws Exception {
        installFakeAndroidKeyStore();
        // Real local HTTP servers acting as Port 1 (initial) and Port 2 (fallback)
        AtomicBoolean port1Healthy = new AtomicBoolean(true);
        AtomicBoolean port2Healthy = new AtomicBoolean(true);
        HttpServer srv1 = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        srv1.createContext("/health", ex -> {
            int code = port1Healthy.get() ? 200 : 503;
            byte[] b = (code == 200 ? "ok" : "err").getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(code, b.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(b); }
        });
        srv1.start();
        int port1 = srv1.getAddress().getPort();

        HttpServer srv2 = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        srv2.createContext("/health", ex -> {
            int code = port2Healthy.get() ? 200 : 503;
            byte[] b = (code == 200 ? "ok" : "err").getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(code, b.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(b); }
        });
        srv2.start();
        int port2 = srv2.getAddress().getPort();

        try {
            // Mock Context with in-memory SharedPreferences so Storage works on standard JVM
            final Map<String, Object> prefMap = new HashMap<>();
            prefMap.put("tailcatEnabled", Boolean.TRUE);
            prefMap.put("tailcatLink", "tailcat://connect/tcABCDEFGHIJKLMNOPQRSTUVWXYZ123456?port=8000");
            prefMap.put("gatewayUrl", "tailcat://connect/tcABCDEFGHIJKLMNOPQRSTUVWXYZ123456?port=8000");
            prefMap.put("token", "mock-cipher");
            Field cField = Storage.class.getDeclaredField("sCachedTokenCiphertext");
            cField.setAccessible(true);
            cField.set(null, "mock-cipher");
            Field pField = Storage.class.getDeclaredField("sCachedTokenPlaintext");
            pField.setAccessible(true);
            pField.set(null, "tok-secret-test");

            android.content.SharedPreferences fakePrefs = (android.content.SharedPreferences) java.lang.reflect.Proxy.newProxyInstance(
                    TailcatReconnectHarness.class.getClassLoader(),
                    new Class<?>[] { android.content.SharedPreferences.class },
                    (proxy, method, args) -> {
                        String n = method.getName();
                        if ("getString".equals(n)) {
                            Object v = prefMap.get(args[0]);
                            return v instanceof String ? v : args[1];
                        }
                        if ("getBoolean".equals(n)) {
                            Object v = prefMap.get(args[0]);
                            return v instanceof Boolean ? v : args[1];
                        }
                        if ("edit".equals(n)) {
                            return java.lang.reflect.Proxy.newProxyInstance(
                                    TailcatReconnectHarness.class.getClassLoader(),
                                    new Class<?>[] { android.content.SharedPreferences.Editor.class },
                                    (ep, em, ea) -> {
                                        if ("commit".equals(em.getName())) return Boolean.TRUE;
                                        return ep;
                                    });
                        }
                        return null;
                    });
            FakeContext fakeCtx = alloc(FakeContext.class);
            fakeCtx.prefs = fakePrefs;

            TailcatBridge.reset();
            TailcatManager.get().clear();
            TailcatBridge.fallbackPort = port1;
            AtomicInteger resetEvents = new AtomicInteger(0);
            TailcatManager.get().setResetListener(resetEvents::incrementAndGet);

            // 1. Initial resolve starts tunnel on port1
            String url1 = TailcatManager.get().resolveServerUrl(fakeCtx);
            check(("http://127.0.0.1:" + port1).equals(url1), "Initial tunnel bound to port1, got " + url1);
            check(TailcatManager.get().isKnownTailcatPort(port1), "port1 tracked in knownLoopbackPorts");

            // 2. Simulate /health failing on port1 -> probeAndRecover restarts tunnel requesting localPort=port1
            port1Healthy.set(false);
            TailcatManager.ProbeResult pr1 = TailcatManager.get().probeAndRecover(fakeCtx, 1000, true);
            check(pr1.restarted, "Must restart tunnel when /health fails");
            check(!pr1.reachable, "Must report reachable=false when post-restart /health still fails (not blind ok=true!)");
            check(!pr1.portChanged, "Port stayed pinned to port1");
            check(resetEvents.get() == 1, "ResetListener notified on restart");
            JSONObject secondCfg = new JSONObject(TailcatBridge.startConfigs.get(1));
            check(secondCfg.optInt("localPort", 0) == port1, "Restart config must pin localPort=" + port1 + ", got " + secondCfg);

            // 3. Now port1 becomes healthy -> next probe succeeds without restarting!
            port1Healthy.set(true);
            TailcatManager.ProbeResult pr2 = TailcatManager.get().probeAndRecover(fakeCtx, 1000, true);
            check(pr2.reachable && !pr2.restarted, "Healthy probe returns reachable=true, restarted=false");

            // 4. Simulate port1 busy during restart -> falls back to ephemeral port2, tracks BOTH ports, and R8OkHttpInterceptor126 rewrites P1 -> P2!
            port1Healthy.set(false);
            port2Healthy.set(true);
            TailcatBridge.rejectRequestedLocalPort = true;
            TailcatBridge.fallbackPort = port2;
            TailcatManager.ProbeResult pr3 = TailcatManager.get().probeAndRecover(fakeCtx, 1000, true);
            check(pr3.restarted && pr3.reachable, "Fallback restart to port2 succeeded and passed /health");
            check(pr3.portChanged, "portChanged must be true when falling back from port1 to port2");
            check(("http://127.0.0.1:" + port2).equals(pr3.localUrl), "Active localUrl is now port2");
            check(TailcatManager.get().isKnownTailcatPort(port1), "Old port1 still known for stale URL rewrite");
            check(TailcatManager.get().isKnownTailcatPort(port2), "New port2 known");

            // Verify GatewayEndpointRouter rewrites stale port1 request to port2 with real TailcatManager state
            String rewritten = GatewayEndpointRouter.rewriteStaleTailcatLoopbackUrl(
                    fakeCtx,
                    "http://127.0.0.1:" + port1 + "/api/sendPrompt?retry=1",
                    "http://127.0.0.1:" + port2);
            check(("http://127.0.0.1:" + port2 + "/api/sendPrompt?retry=1").equals(rewritten),
                    "Stale port1 URL rewritten to active port2, got " + rewritten);

            TailcatManager.get().clear();
        } finally {
            srv1.stop(0);
            srv2.stop(0);
        }
    }

    public static void main(String[] args) throws Exception {
        testBackoffScheduleAndNeverStalls();
        testCapabilitiesValidatedTransitionTriggersProbe();
        testOnLostThenSameHandleOnAvailableRecovers();
        testOnLostRacesWithActiveReplacementAndSafetyRecheck();
        testLinkPropertiesIpChangeTriggersProbe();
        testForegroundReturnAndWatchdogAndBackgroundStop();
        testRequestFailureAndInFlightCoalescing();
        testDirectModeNetworkRestored();
        testGatewayStaleLoopbackRewrite();
        testTailcatManagerPortPinningAndFallbackAndHealthVerify();
        System.out.println("TAILCAT_RECONNECT_HARNESS_OK");
    }
}
`);
  sources.push(harnessFile);

  const listFile = path.join(tmp, 'sources.txt');
  fs.writeFileSync(listFile, sources.join('\n'));
  const compile = cp.spawnSync(
    env.javac,
    ['--release', '17', '-encoding', 'UTF-8', '-cp', env.androidJar, '-d', classesDir, `@${listFile}`],
    { encoding: 'utf8' }
  );
  assert.equal(compile.status, 0, `javac failed:\n${compile.stderr}`);

  const compileOv = cp.spawnSync(
    env.javac,
    ['--release', '17', '-encoding', 'UTF-8', '-cp', `${classesDir}${path.delimiter}${env.androidJar}`, '-d', overrideClassesDir, ...overrideFiles],
    { encoding: 'utf8' }
  );
  assert.equal(compileOv.status, 0, `override javac failed:\n${compileOv.stderr}`);

  const run = cp.spawnSync(
    env.java,
    ['-cp', `${overrideClassesDir}${path.delimiter}${classesDir}${path.delimiter}${env.androidJar}`, 'dev.rokbot.nativeapp.TailcatReconnectHarness'],
    { encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(run.status, 0, `TailcatReconnectHarness failed:\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stdout, /TAILCAT_RECONNECT_HARNESS_OK/);
});

// rokbot.3b: the list-sort bell is an RN header button (hermes-settings.mjs applyHomeBarBell), not a
// floating native overlay, and the Connection & Diagnostics page tells relay from direct for plain
// HTTP(S) Hosts too (X-RokBot-Route header, else the address class).
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyHomeBarBell, HOME_BELL } from '../patchers/hermes-settings.mjs';
import { MockHostServer } from './mock-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

test('List sort bell: no floating overlay; the RN header button is recognised and toggles in place', () => {
  const la = read('ListArrangement.java');
  assert.doesNotMatch(la, /class BellView|addView\(|FrameLayout|bringToFront|setElevation/, 'no native view is drawn over the RN list');
  assert.match(la, /static final String RN_LABEL_OFF = "sort";/);
  assert.match(la, /static final String RN_LABEL_ON = "sorted";/);
  assert.equal(HOME_BELL.labelOff, 'sort');
  assert.equal(HOME_BELL.labelOn, 'sorted');
  assert.equal(HOME_BELL.colorOn, '#C27400');
  // Header-sized, top of the screen only: never a list row or a banner.
  assert.match(la, /effWdp > 72f \|\| effHdp > 72f/);
  assert.match(la, /return loc\[1\] < screenH \/ 4;/);
  assert.match(la, /setLastMessage\(activity, next, null\);/);
  assert.match(la, /RokBotBootstrap\.ensurePairedBundleFile\(app, true\);\s*RokBotBootstrap\.reloadReactHost\(app\);/);
  // TalkBack gets a readable label instead of the raw bundle string.
  assert.match(la, /bell\.setContentDescription\(spokenLabel\(activity, on\)\);/);
  assert.match(la, /private static synchronized Handler main\(\)/, 'no Looper use in static init (JVM-safe)');

  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /if \(ListArrangement\.isHeaderBellLabel\(activity, s\)\) \{[\s\S]{0,400}ListArrangement\.isHeaderBellGeometry\(activity, view, effW, effH\)[\s\S]{0,120}\? ListArrangement\.class : null;/);
  const launch = boot.slice(boot.indexOf('private static void launchNativeTarget(Activity activity, Class<?> target)'));
  assert.match(launch.slice(0, 600), /if \(target == ListArrangement\.class\) \{\s*\/\/[^\n]*\n\s*ListArrangement\.onHeaderBellTapped\(activity\);\s*return;\s*\}/, 'the bell never starts an Activity');

  const hp = read('HermesPatcher.java');
  assert.match(hp, /if \(ListArrangement\.isLastMessage\(context\)\) \{\s*if \(!applyListSortEdits\(bundle, meta\.optJSONObject\("listSort"\)\)\)/);
  assert.match(hp, /return ListArrangement\.isLastMessage\(context\) \? "\\nlistSort=" \+ ListArrangement\.MODE_LAST_MESSAGE : "";/);
});

test('List sort bell: applyHomeBarBell fails closed on anything but the pinned bundle', () => {
  const junk = Buffer.alloc(4096, 7);
  const r = applyHomeBarBell(junk);
  assert.equal(r.applied, false);
  assert.equal(r.buffer, junk);
  assert.deepEqual(r.edits, []);
});

test('Connection route: MockHostServer can announce X-RokBot-Route like a relay in front of a Host', async () => {
  const relay = new MockHostServer({ port: 0, routeHeader: 'relay' });
  const plain = new MockHostServer({ port: 0 });
  await relay.start();
  await plain.start();
  try {
    const a = await fetch(`${relay.origin}/health`);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('x-rokbot-route'), 'relay');
    const b = await fetch(`${plain.origin}/health`);
    assert.equal(b.headers.get('x-rokbot-route'), null);
  } finally {
    await relay.stop();
    await plain.stop();
  }
});

test('Connection route (JVM): header hint, LAN / public address classes, bell labels', () => {
  const sdkRoot = [process.env.ANDROID_HOME, path.join(os.homedir(), 'Library/Android/sdk'), '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
    .find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  assert.ok(sdkRoot && javacBin, 'Android SDK and JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-route-'));
  try {
    const out = path.join(tmp, 'classes');
    fs.mkdirSync(out, { recursive: true });
    const files = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.java')) files.push(full);
      }
    };
    walk(path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java'));
    walk(path.join(NATIVE_ROOT, 'companion/src/main/java'));
    const harnessDir = path.join(tmp, 'src/dev/rokbot/nativeapp');
    fs.mkdirSync(harnessDir, { recursive: true });
    const harness = path.join(harnessDir, 'RouteHarness.java');
    fs.writeFileSync(harness, `package dev.rokbot.nativeapp;

public class RouteHarness {
    static void eq(String got, String want, String m) { if (!want.equals(got)) throw new AssertionError(m + ": " + got + " != " + want); }
    static void check(boolean c, String m) { if (!c) throw new AssertionError(m); }
    public static void main(String[] a) {
        eq(ConnectionProbe.normalizeHeaderRoute(" Relay "), "relay", "header relay");
        eq(ConnectionProbe.normalizeHeaderRoute("direct"), "direct", "header direct");
        check(ConnectionProbe.normalizeHeaderRoute("maybe") == null, "unknown header ignored");
        check(ConnectionProbe.normalizeHeaderRoute(null) == null, "no header");
        eq(ConnectionProbe.classifyAddress("http://127.0.0.1:19191"), "direct", "loopback (adb reverse)");
        eq(ConnectionProbe.classifyAddress("http://192.168.31.20:18080"), "direct", "RFC 1918");
        eq(ConnectionProbe.classifyAddress("http://10.0.2.2:18080"), "direct", "emulator host");
        eq(ConnectionProbe.classifyAddress("http://100.101.102.103:18080"), "direct", "CGNAT / tailnet");
        eq(ConnectionProbe.classifyAddress("http://[fd12:3456::1]:18080"), "direct", "IPv6 ULA");
        eq(ConnectionProbe.classifyAddress("http://mac-mini.local:18080"), "direct", "mDNS");
        eq(ConnectionProbe.classifyAddress("http://118.178.254.45:18081"), "relay", "public IPv4 (frp entry)");
        eq(ConnectionProbe.classifyAddress("https://[2001:4860::8888]"), "relay", "public IPv6");
        eq(ConnectionProbe.classifyAddress("not a url"), "unknown", "garbage");
        check(ListArrangement.isHeaderBellLabel(null, "sort"), "off label");
        check(ListArrangement.isHeaderBellLabel(null, " sorted "), "on label");
        check(!ListArrangement.isHeaderBellLabel(null, "Sort"), "case sensitive (bundle strings)");
        check(!ListArrangement.isHeaderBellLabel(null, "New Bot"), "other header buttons");
        System.out.println("ROUTE_OK");
    }
}
`);
    files.push(harness);
    const stubsOut = path.join(tmp, 'stubs');
    const res = cp.spawnSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-nowarn', '-cp', androidJar, '-d', out, ...files], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    fs.mkdirSync(stubsOut, { recursive: true });
    const run = cp.spawnSync(javaBin, ['-cp', `${out}:${androidJar}`, 'dev.rokbot.nativeapp.RouteHarness'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /ROUTE_OK/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

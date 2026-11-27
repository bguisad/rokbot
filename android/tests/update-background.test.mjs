// Requirement B: Host Android release push, background pre-download (delta-first, Range resume,
// checksum/signature verification & discard, auto-download toggle), and pending-install state.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createSelfHostServer } from '../../host/server/index.mjs';
import { patchManifest } from '../patchers/manifest.mjs';
import { createEntry, writeZip } from '../patchers/signing.mjs';
import { generateDelta } from '../release/delta-update.mjs';

const execFileAsync = promisify(cp.execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');

function findJdkAndSdk() {
  const sdkRoot = [
    process.env.ANDROID_HOME,
    path.join(os.homedir(), 'Library/Android/sdk'),
    '/Users/lianqishi/Library/Android/sdk',
    '/Volumes/ORICO/android/sdk',
  ].find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javac = ['/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac', 'javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  if (!sdkRoot || !javac) return null;
  const java = javac.endsWith('javac') ? javac.slice(0, -1) : 'java';
  return { androidJar: path.join(sdkRoot, 'platforms/android-36/android.jar'), javac, java };
}

function makeSyntheticZip(entries) {
  return writeZip(entries.map(([name, content, store]) => createEntry(name, Buffer.from(content), { store })));
}

test('Host Android release publish pushes lightweight update notice to Android devices via existing push/SSE channel', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-host-push-upd-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const delivered = [];
  const host = await createSelfHostServer({
    dataDir,
    publicUrl: 'https://prokbot.cosfoc.com',
    webPublicUrl: 'https://web.prokbot.cosfoc.com',
    hostUrl: 'http://127.0.0.1:1340',
    modelAutoSync: false,
  });
  const addr = await host.start(0, '127.0.0.1');
  const hostPort = addr.port;
  t.after(() => host.close());

  // Spy on UnifiedPush transport delivery without external network.
  host.push.transports.unifiedpush = async (device, item) => {
    delivered.push({ deviceId: device.id, endpoint: device.unifiedpush?.endpoint, item });
    return { provider: 'unifiedpush', accepted: true };
  };

  const adminToken = await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const adminCookie = `rokbot_admin=${adminToken}`;

  const androidPair = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'PixelPhone',
    platform: 'desktop',
  });
  const desktopPair = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'MacBook',
    platform: 'desktop',
  });

  await host.push.register(androidPair.deviceId, {
    kind: 'desktop',
    clientKind: 'android',
    authorization: 'granted',
    push: { provider: 'unifiedpush', endpoint: 'https://ntfy.example.com/android-up' },
  });
  await host.push.register(desktopPair.deviceId, {
    kind: 'mac',
    authorization: 'granted',
    push: { provider: 'unifiedpush', endpoint: 'https://ntfy.example.com/mac-up' },
  });

  // Subscribe to SSE before publishing.
  const sseChunks = [];
  const sseAc = new AbortController();
  t.after(() => sseAc.abort());
  const ssePromise = fetch(`http://127.0.0.1:${hostPort}/notifications/events`, {
    headers: { authorization: `Bearer ${androidPair.token}` },
    signal: sseAc.signal,
  }).then(async res => {
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const txt = dec.decode(value);
      sseChunks.push(txt);
      if (txt.includes('"type":"update"')) break;
    }
  }).catch(() => {});

  // Wait for ": connected" flush
  await new Promise(r => setTimeout(r, 120));

  const apk = makeSyntheticZip([['AndroidManifest.xml', 'v2', false], ['classes.dex', Buffer.alloc(2048, 0x33), false]]);
  const upRes = await fetch(`http://127.0.0.1:${hostPort}/admin/api/updates/upload?platform=android&filename=RokBot-2.0.apk`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
    body: apk,
  });
  assert.equal(upRes.status, 201);
  const uploaded = await upRes.json();

  const pubRes = await fetch(`http://127.0.0.1:${hostPort}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'android',
      filename: uploaded.filename,
      versionName: '2.0.0',
      versionCode: 200,
    }),
  });
  assert.equal(pubRes.status, 201);

  await Promise.race([ssePromise, new Promise(r => setTimeout(r, 1500))]);
  const allSse = sseChunks.join('');
  assert.ok(allSse.includes('"type":"update"'), `SSE must deliver update notification: ${allSse}`);
  assert.ok(allSse.includes('"versionCode":200'), 'SSE notification carries lightweight versionCode metadata');
  assert.equal(allSse.length < 4096, true, 'Notification payload must be lightweight');

  // Verify UnifiedPush enqueued for Android only (never for mac).
  await new Promise(r => setTimeout(r, 150));
  await host.push.flush();
  assert.ok(
    delivered.some(d => d.endpoint === 'https://ntfy.example.com/android-up' && d.item.type === 'update' && d.item.versionCode === 200),
    `Push delivered to Android device; store=${JSON.stringify(host.push.store.value)}`,
  );
  assert.equal(delivered.some(d => d.endpoint === 'https://ntfy.example.com/mac-up'), false, 'Update push for android must skip non-android devices');
  assert.equal(host.push.store.value.jobs.filter(j => j.deviceId === androidPair.deviceId && j.status === 'sent').length, 1);
  assert.equal(host.push.store.value.jobs.filter(j => j.deviceId === desktopPair.deviceId).length, 0);
});

test('Manifest registers UpdateDownloadService as foreground dataSync service', () => {
  const manifestSrc = fs.readFileSync(path.join(NATIVE_ROOT, 'patchers/manifest.mjs'), 'utf8');
  assert.match(manifestSrc, /dev\.rokbot\.nativeapp\.UpdateDownloadService/);
  assert.match(manifestSrc, /foregroundServiceType',\s*0x00000001/);
  assert.equal(typeof patchManifest, 'function');
});

test('Android background updater contract: delta-first by fromVersionCode, verification discard, auto-download switch, and Restart UI', () => {
  const ua = fs.readFileSync(path.join(SRC, 'UpdateActivity.java'), 'utf8');
  const au = fs.readFileSync(path.join(SRC, 'AppUpdater.java'), 'utf8');
  const um = fs.readFileSync(path.join(SRC, 'UpdateManager.java'), 'utf8');
  const ns = fs.readFileSync(path.join(SRC, 'NotificationService.java'), 'utf8');
  const svc = fs.readFileSync(path.join(SRC, 'UpdateDownloadService.java'), 'utf8');

  assert.match(ns, /AppUpdater\.onUpdatePushReceived\(/);
  assert.match(ua, /auto_download_updates_toggle/);
  assert.match(ua, /已下载，重启即可更新/);
  assert.match(ua, /重启更新/);
  assert.match(ua, /finishAffinity\(\)/);
  assert.match(au, /isAutoDownloadUpdatesEnabled/);
  assert.match(au, /UpdateDownloadService\.enqueue/);
  assert.match(au, /restorePendingUpdate/);
  assert.match(um, /conn\.setRequestProperty\("Range", "bytes=" \+ resumeFrom \+ "-"\)/);
  assert.match(svc, /startForeground\(/);
});

test('UpdateManager & AppUpdater (JVM): fromVersionCode delta priority, Range resume, checksum failure discard, and auto-download toggle off', async t => {
  const env = findJdkAndSdk();
  if (!env) return t.skip('Android SDK and JBR JDK required for JVM verification');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-upd-bg-jvm-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const big = Buffer.alloc(48 * 1024, 0x41);
  const baseApk = makeSyntheticZip([['AndroidManifest.xml', 'v100', false], ['lib/arm64-v8a/libb.so', big, true]]);
  const targetApk = makeSyntheticZip([['AndroidManifest.xml', 'v200', false], ['lib/arm64-v8a/libb.so', big, true]]);
  const deltaBuf = generateDelta(baseApk, targetApk);
  const wrongDeltaBuf = Buffer.from('NOT_A_VALID_DELTA_PAYLOAD_FOR_CORRUPTION_CHECK'.repeat(10));
  const baseSha = sha256Hex(baseApk);
  const targetSha = sha256Hex(targetApk);
  const deltaSha = sha256Hex(deltaBuf);
  const certBytes = Buffer.from('test-cert-der');
  const certSha = sha256Hex(certBytes);

  let mode = 'good';
  let rangeHeaderSeen = null;
  let cutFirstDeltaRequest = true;
  const requests = [];

  const srv = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ pathname, range: req.headers.range || null, auth: req.headers.authorization || null });
    if (pathname === '/local/updates/android.json') {
      const origin = `http://127.0.0.1:${srv.address().port}`;
      const body = JSON.stringify({
        schema: 'rokbot-android-native-update/v1',
        latest: {
          packageName: 'dev.rokbot.nativeapp',
          versionName: '2.0.0',
          versionCode: 200,
          certificateSha256: certSha,
          apkUrl: `${origin}/local/updates/files/android/full.apk`,
          apkSha256: mode === 'bad-full' ? '0'.repeat(64) : targetSha,
          apkSize: targetApk.length,
          deltas: [
            // First delta is for older versionCode 99 -> must NOT be chosen even if first.
            {
              fromVersionCode: 99,
              fromApkSha256: 'a'.repeat(64),
              format: 'RBDELTA1',
              url: `${origin}/local/updates/files/android/wrong-vc.rbdelta`,
              sha256: sha256Hex(wrongDeltaBuf),
              size: wrongDeltaBuf.length,
            },
            // Second delta matches installed versionCode 100 -> must be preferred!
            {
              fromVersionCode: 100,
              fromApkSha256: baseSha,
              format: 'RBDELTA1',
              url: `${origin}/local/updates/files/android/match-100.rbdelta`,
              sha256: deltaSha,
              size: deltaBuf.length,
            },
          ],
        },
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (pathname === '/local/updates/files/android/match-100.rbdelta') {
      // First attempt sends first half only to test HTTP Range resume on retry!
      if (cutFirstDeltaRequest && !req.headers.range) {
        cutFirstDeltaRequest = false;
        const half = Math.floor(deltaBuf.length / 2);
        res.writeHead(200, { 'content-length': deltaBuf.length });
        res.write(deltaBuf.subarray(0, half), () => res.destroy());
        return;
      }
      if (req.headers.range) {
        rangeHeaderSeen = req.headers.range;
        const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range)?.[1] ?? 0);
        const slice = deltaBuf.subarray(start);
        res.writeHead(206, {
          'content-length': slice.length,
          'content-range': `bytes ${start}-${deltaBuf.length - 1}/${deltaBuf.length}`,
        });
        return res.end(slice);
      }
      res.writeHead(200, { 'content-length': deltaBuf.length });
      return res.end(deltaBuf);
    }
    if (pathname === '/local/updates/files/android/full.apk') {
      const payload = mode === 'bad-full' ? Buffer.from('corrupt-apk'.repeat(50)) : targetApk;
      res.writeHead(200, { 'content-length': payload.length });
      return res.end(payload);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => srv.close(r)));
  const origin = `http://127.0.0.1:${srv.address().port}`;

  const classesDir = path.join(tmp, 'classes');
  const overrideClassesDir = path.join(tmp, 'override-classes');
  const testClassesDir = path.join(tmp, 'test-classes');
  fs.mkdirSync(classesDir, { recursive: true });
  fs.mkdirSync(overrideClassesDir, { recursive: true });
  fs.mkdirSync(testClassesDir, { recursive: true });

  const sources = [];
  const walk = (dir, exclude) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, exclude);
      else if (ent.name.endsWith('.java') && (!exclude || !full.endsWith(exclude))) sources.push(full);
    }
  };
  walk(path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java'));
  walk(path.join(NATIVE_ROOT, 'companion/src/main/java'), 'TailcatBridge.java');

  const mockBridge = path.join(tmp, 'src/dev/grokbot/local/TailcatBridge.java');
  fs.mkdirSync(path.dirname(mockBridge), { recursive: true });
  fs.writeFileSync(mockBridge, `package dev.grokbot.local;
public final class TailcatBridge {
  public static boolean isAvailable() { return false; }
  public static String safeIdentity() { return "{}"; }
  public static String safeStart(String c) { return "{}"; }
  public static String safeStatus(int h) { return "{}"; }
  public static void safeStop(int h) {}
}
`);
  cp.execFileSync(env.javac, ['--release', '17', '-encoding', 'UTF-8', '-cp', env.androidJar, '-d', classesDir, ...sources, mockBridge], { stdio: 'pipe' });

  const ovSrc = path.join(tmp, 'ov');
  const writeOv = (rel, code) => {
    const f = path.join(ovSrc, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, code);
    return f;
  };
  const ovFiles = [
    writeOv('android/util/Log.java', 'package android.util; public final class Log { public static int i(String t,String m){return 0;} public static int w(String t,String m){return 0;} public static int w(String t,String m,Throwable tr){return 0;} public static int d(String t,String m){return 0;} public static int e(String t,String m){return 0;} }'),
    writeOv('android/util/Base64.java', 'package android.util; public class Base64 { public static final int NO_WRAP=2; public static final int DEFAULT=0; public static String encodeToString(byte[] i,int f){return java.util.Base64.getEncoder().encodeToString(i);} public static byte[] decode(String s,int f){return java.util.Base64.getDecoder().decode(s);} }'),
    writeOv('android/os/Build.java', 'package android.os; public class Build { public static class VERSION { public static final int SDK_INT=35; } }'),
    writeOv('android/os/SystemClock.java', 'package android.os; public class SystemClock { public static long elapsedRealtime(){return System.currentTimeMillis();} }'),
    writeOv('android/os/Looper.java', 'package android.os; public class Looper { private static final Looper M=new Looper(); public static Looper getMainLooper(){return M;} }'),
    writeOv('android/os/Handler.java', 'package android.os; public class Handler { public Handler(Looper l){} public boolean post(Runnable r){if(r!=null)r.run(); return true;} }'),
    writeOv('android/content/pm/Signature.java', 'package android.content.pm; public class Signature { private final byte[] b; public Signature(byte[] b){this.b=b;} public byte[] toByteArray(){return b;} }'),
    writeOv('android/content/pm/SigningInfo.java', 'package android.content.pm; public class SigningInfo { public Signature[] sigs; public boolean hasMultipleSigners(){return false;} public Signature[] getApkContentsSigners(){return sigs;} public Signature[] getSigningCertificateHistory(){return sigs;} }'),
    writeOv('android/content/pm/PackageInfo.java', 'package android.content.pm; public class PackageInfo { public String packageName; public String versionName; public int versionCode; public SigningInfo signingInfo; public Signature[] signatures; public long getLongVersionCode(){return versionCode;} }'),
    writeOv('android/content/pm/PackageManager.java', 'package android.content.pm; public class PackageManager { public static final int GET_SIGNATURES=64; public static final int GET_SIGNING_CERTIFICATES=0x08000000; public PackageInfo installedInfo; public PackageInfo archiveInfo; public PackageInfo getPackageInfo(String p,int f){return installedInfo;} public PackageInfo getPackageArchiveInfo(String a,int f){return archiveInfo != null ? archiveInfo : installedInfo;} public boolean canRequestPackageInstalls(){return true;} }'),
    writeOv('android/content/pm/ApplicationInfo.java', 'package android.content.pm; public class ApplicationInfo { public String sourceDir; }'),
    writeOv('android/os/LocaleList.java', 'package android.os; import java.util.Locale; public class LocaleList { public boolean isEmpty(){return false;} public Locale get(int i){return Locale.US;} }'),
    writeOv('android/content/res/Configuration.java', 'package android.content.res; import android.os.LocaleList; public class Configuration { public java.util.Locale locale = java.util.Locale.US; public LocaleList getLocales(){return new LocaleList();} }'),
    writeOv('android/content/res/Resources.java', 'package android.content.res; public class Resources { public Configuration getConfiguration(){return new Configuration();} }'),
    writeOv('org/json/JSONObject.java', String.raw`package org.json;
import java.util.*;
public class JSONObject {
  public static final Object NULL = new Object();
  final Map<String, Object> map = new LinkedHashMap<>();
  public JSONObject() {}
  @SuppressWarnings("unchecked") public JSONObject(String json) { map.putAll((Map<String, Object>) MiniJson.parse(json)); }
  JSONObject(Map<String, Object> m) { map.putAll(m); }
  public JSONObject put(String k, Object v) { if (v == null) map.remove(k); else map.put(k, v); return this; }
  public JSONObject put(String k, int v) { map.put(k, v); return this; }
  public JSONObject put(String k, long v) { map.put(k, v); return this; }
  public JSONObject put(String k, boolean v) { map.put(k, v); return this; }
  public boolean has(String k) { return map.containsKey(k); }
  public boolean isNull(String k) { return !map.containsKey(k) || map.get(k) == null || map.get(k) == NULL; }
  public String optString(String k, String d) { Object v = map.get(k); return v == null ? d : String.valueOf(v); }
  public String optString(String k) { return optString(k, ""); }
  public long optLong(String k, long d) { Object v = map.get(k); return v instanceof Number ? ((Number) v).longValue() : d; }
  public int optInt(String k, int d) { Object v = map.get(k); return v instanceof Number ? ((Number) v).intValue() : d; }
  public boolean optBoolean(String k, boolean d) { Object v = map.get(k); return v instanceof Boolean ? (Boolean) v : d; }
  @SuppressWarnings("unchecked") public JSONObject optJSONObject(String k) { Object v = map.get(k); return v instanceof JSONObject ? (JSONObject) v : (v instanceof Map ? new JSONObject((Map<String, Object>) v) : null); }
  @SuppressWarnings("unchecked") public JSONArray optJSONArray(String k) { Object v = map.get(k); return v instanceof JSONArray ? (JSONArray) v : (v instanceof List ? new JSONArray((List<Object>) v) : null); }
  @Override public String toString() { return MiniJson.stringify(map); }
}`),
    writeOv('org/json/JSONArray.java', String.raw`package org.json;
import java.util.*;
public class JSONArray {
  final List<Object> list = new ArrayList<>();
  public JSONArray() {}
  @SuppressWarnings("unchecked") public JSONArray(String json) { list.addAll((List<Object>) MiniJson.parse(json)); }
  JSONArray(List<Object> l) { list.addAll(l); }
  public int length() { return list.size(); }
  public JSONArray put(Object v) { list.add(v); return this; }
  @SuppressWarnings("unchecked") public JSONObject optJSONObject(int i) { Object v = (i >= 0 && i < list.size()) ? list.get(i) : null; return v instanceof JSONObject ? (JSONObject) v : (v instanceof Map ? new JSONObject((Map<String, Object>) v) : null); }
  public String optString(int i, String d) { return (i >= 0 && i < list.size() && list.get(i) != null) ? String.valueOf(list.get(i)) : d; }
  @Override public String toString() { return MiniJson.stringify(list); }
}`),
    writeOv('org/json/MiniJson.java', String.raw`package org.json;
import java.util.*;
final class MiniJson {
  static Object parse(String s) { return new Parser(s).val(); }
  static String stringify(Object o) {
    if (o == null || o == JSONObject.NULL) return "null";
    if (o instanceof JSONObject || o instanceof JSONArray || o instanceof Boolean || o instanceof Number) return String.valueOf(o);
    if (o instanceof Map) { StringBuilder sb = new StringBuilder("{"); boolean f = true; for (var e : ((Map<?, ?>) o).entrySet()) { if (!f) sb.append(','); f = false; sb.append(quote(String.valueOf(e.getKey()))).append(':').append(stringify(e.getValue())); } return sb.append('}').toString(); }
    if (o instanceof List) { StringBuilder sb = new StringBuilder("["); boolean f = true; for (var x : (List<?>) o) { if (!f) sb.append(','); f = false; sb.append(stringify(x)); } return sb.append(']').toString(); }
    return quote(String.valueOf(o));
  }
  static String quote(String s) { StringBuilder sb = new StringBuilder("\""); for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c == '"' || c == '\\') sb.append('\\').append(c); else if (c == '\n') sb.append("\\n"); else sb.append(c); } return sb.append('"').toString(); }
  static final class Parser {
    final String s; int i = 0; Parser(String s) { this.s = s; }
    void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
    Object val() { ws(); char c = s.charAt(i); if (c == '{') return obj(); if (c == '[') return arr(); if (c == '"') return str(); if (s.startsWith("true", i)) { i += 4; return true; } if (s.startsWith("false", i)) { i += 5; return false; } if (s.startsWith("null", i)) { i += 4; return null; } int st = i; while (i < s.length() && "-0123456789.eE+".indexOf(s.charAt(i)) >= 0) i++; String n = s.substring(st, i); return (n.contains(".") || n.contains("e")) ? Double.parseDouble(n) : Long.parseLong(n); }
    Map<String, Object> obj() { Map<String, Object> m = new LinkedHashMap<>(); i++; ws(); if (s.charAt(i) == '}') { i++; return m; } while (true) { ws(); String k = str(); ws(); i++; m.put(k, val()); ws(); if (s.charAt(i) == ',') { i++; continue; } i++; break; } return m; }
    List<Object> arr() { List<Object> l = new ArrayList<>(); i++; ws(); if (s.charAt(i) == ']') { i++; return l; } while (true) { l.add(val()); ws(); if (s.charAt(i) == ',') { i++; continue; } i++; break; } return l; }
    String str() { i++; StringBuilder sb = new StringBuilder(); while (i < s.length()) { char c = s.charAt(i++); if (c == '"') return sb.toString(); if (c == '\\') { char e = s.charAt(i++); if (e == 'n') sb.append('\n'); else sb.append(e); } else sb.append(c); } throw new RuntimeException("EOF"); }
  }
}`),
  ];
  cp.execFileSync(env.javac, ['--release', '17', '-encoding', 'UTF-8', '-cp', `${classesDir}:${env.androidJar}`, '-d', overrideClassesDir, ...ovFiles], { stdio: 'pipe' });

  const baseApkPath = path.join(tmp, 'base.apk');
  const filesDir = path.join(tmp, 'files');
  fs.writeFileSync(baseApkPath, baseApk);
  fs.mkdirSync(filesDir, { recursive: true });

  const harnessDir = path.join(tmp, 'src/dev/rokbot/nativeapp');
  fs.mkdirSync(harnessDir, { recursive: true });
  const harness = path.join(harnessDir, 'BgHarness.java');
  fs.writeFileSync(harness, `package dev.rokbot.nativeapp;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.*;
import android.content.res.Resources;
import dev.rokbot.nativeapp.*;
import java.io.*;
import java.security.*;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.json.*;
import sun.misc.Unsafe;

public class BgHarness {
  private static Unsafe unsafe;
  static { try { var f = Unsafe.class.getDeclaredField("theUnsafe"); f.setAccessible(true); unsafe = (Unsafe) f.get(null); } catch (Exception e) { throw new RuntimeException(e); } }
  @SuppressWarnings("unchecked") static <T> T alloc(Class<T> c) { try { return (T) unsafe.allocateInstance(c); } catch (Exception e) { throw new RuntimeException(e); } }
  public static final class FakeKeyStoreSpi extends KeyStoreSpi {
    private static final SecretKey KEY = new SecretKeySpec(new byte[32], "AES");
    @Override public KeyStore.Entry engineGetEntry(String a, KeyStore.ProtectionParameter p) { return new KeyStore.SecretKeyEntry(KEY); }
    @Override public Key engineGetKey(String a, char[] p) { return KEY; }
    @Override public Certificate[] engineGetCertificateChain(String a) { return null; }
    @Override public Certificate engineGetCertificate(String a) { return null; }
    @Override public Date engineGetCreationDate(String a) { return new Date(); }
    @Override public void engineSetKeyEntry(String a, Key k, char[] p, Certificate[] c) {}
    @Override public void engineSetKeyEntry(String a, byte[] k, Certificate[] c) {}
    @Override public void engineSetCertificateEntry(String a, Certificate c) {}
    @Override public void engineDeleteEntry(String a) {}
    @Override public Enumeration<String> engineAliases() { return Collections.enumeration(List.of("rokbot-native-device-credential")); }
    @Override public boolean engineContainsAlias(String a) { return true; }
    @Override public int engineSize() { return 1; }
    @Override public boolean engineIsKeyEntry(String a) { return true; }
    @Override public boolean engineIsCertificateEntry(String a) { return false; }
    @Override public String engineGetCertificateAlias(Certificate c) { return null; }
    @Override public void engineStore(OutputStream s, char[] p) {}
    @Override public void engineLoad(InputStream s, char[] p) {}
  }
  static class MemPrefs implements SharedPreferences {
    final Map<String, Object> data = new HashMap<>();
    @Override public Map<String, ?> getAll() { return data; }
    @Override public String getString(String k, String d) { Object v = data.get(k); return v instanceof String ? (String) v : d; }
    @Override public Set<String> getStringSet(String k, Set<String> d) { return d; }
    @Override public int getInt(String k, int d) { Object v = data.get(k); return v instanceof Integer ? (Integer) v : d; }
    @Override public long getLong(String k, long d) { Object v = data.get(k); return v instanceof Long ? (Long) v : d; }
    @Override public float getFloat(String k, float d) { Object v = data.get(k); return v instanceof Float ? (Float) v : d; }
    @Override public boolean getBoolean(String k, boolean d) { Object v = data.get(k); return v instanceof Boolean ? (Boolean) v : d; }
    @Override public boolean contains(String k) { return data.containsKey(k); }
    @Override public Editor edit() {
      return new Editor() {
        final Map<String, Object> p = new HashMap<>(); final Set<String> r = new HashSet<>(); boolean c = false;
        @Override public Editor putString(String k, String v) { p.put(k, v); return this; }
        @Override public Editor putStringSet(String k, Set<String> v) { return this; }
        @Override public Editor putInt(String k, int v) { p.put(k, v); return this; }
        @Override public Editor putLong(String k, long v) { p.put(k, v); return this; }
        @Override public Editor putFloat(String k, float v) { p.put(k, v); return this; }
        @Override public Editor putBoolean(String k, boolean v) { p.put(k, v); return this; }
        @Override public Editor remove(String k) { r.add(k); return this; }
        @Override public Editor clear() { c = true; return this; }
        @Override public boolean commit() { apply(); return true; }
        @Override public void apply() { if (c) data.clear(); for (String k : r) data.remove(k); data.putAll(p); }
      };
    }
    @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}
    @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener l) {}
  }
  static class FakeApp extends Application {
    MemPrefs prefs = new MemPrefs();
    PackageManager pm;
    ApplicationInfo appInfo;
    File filesDir;
    List<android.content.Intent> startedServices;
    @Override public Context getApplicationContext() { return this; }
    @Override public String getPackageName() { return "dev.rokbot.nativeapp"; }
    @Override public SharedPreferences getSharedPreferences(String n, int m) { return prefs; }
    @Override public PackageManager getPackageManager() { return pm; }
    @Override public ApplicationInfo getApplicationInfo() { return appInfo; }
    @Override public File getFilesDir() { return filesDir; }
    @Override public Resources getResources() { return new Resources(); }
    @Override public android.content.ComponentName startForegroundService(android.content.Intent service) {
      startedServices.add(service);
      throw new SecurityException("mock fgs denied so we can inspect enqueue gating");
    }
  }
  static void check(boolean c, String m) { if (!c) throw new AssertionError(m); }

  public static void main(String[] args) throws Exception {
    String origin = args[0], baseApkPath = args[1], filesDirPath = args[2], targetSha = args[3], certStr = "test-cert-der";
    Security.insertProviderAt(new Provider("AndroidKeyStore", "1.0", "test") {{ put("KeyStore.AndroidKeyStore", FakeKeyStoreSpi.class.getName()); }}, 1);

    FakeApp app = alloc(FakeApp.class);
    app.prefs = new MemPrefs();
    app.startedServices = new ArrayList<>();
    app.appInfo = new ApplicationInfo();
    app.appInfo.sourceDir = baseApkPath;
    app.filesDir = new File(filesDirPath);
    PackageManager pm = new PackageManager();
    PackageInfo pi = new PackageInfo();
    pi.packageName = "dev.rokbot.nativeapp";
    pi.versionName = "1.0.0";
    pi.versionCode = 100;
    pi.signingInfo = new SigningInfo();
    pi.signingInfo.sigs = new android.content.pm.Signature[] { new android.content.pm.Signature(certStr.getBytes("UTF-8")) };
    pi.signatures = pi.signingInfo.sigs;
    pm.installedInfo = pi;
    pm.archiveInfo = pi;
    app.pm = pm;

    Storage.init(app);
    Storage.saveCredentials(app, "dev-token-1234567890", origin, "dev1");

    // 1. Auto-download toggle OFF: maybeStartBackgroundDownload & UpdateDownloadService.enqueue skip download!
    Storage.setAutoDownloadUpdatesEnabled(app, false);
    check(!Storage.isAutoDownloadUpdatesEnabled(app), "toggle should be false");
    UpdateManager.UpdateManifestInfo dummy = new UpdateManager.UpdateManifestInfo(
        "1.0.0 (100)", 100, "", "", "2.0.0", 200, "2.0.0", "", targetSha,
        origin + "/local/updates/files/android/full.apk", 1024, false, "", "", -1, false, null, "", "");
    AppUpdater.maybeStartBackgroundDownload(app, dummy);
    UpdateDownloadService.enqueue(app, dummy);
    check(app.startedServices.isEmpty(), "UpdateDownloadService must NOT be enqueued when toggle is OFF");
    check(AppUpdater.state() == AppUpdater.STATE_IDLE, "State stays IDLE when auto-download OFF");

    // 2. selectPreferredDelta picks fromVersionCode=100 over 99 and rejects non-matching versionCodes!
    JSONArray deltas = new JSONArray()
        .put(new JSONObject().put("fromVersionCode", 99).put("fromApkSha256", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").put("url", "/d99").put("sha256", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").put("size", 10))
        .put(new JSONObject().put("fromVersionCode", 100).put("url", "/d100").put("sha256", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc").put("size", 20));
    JSONObject picked = UpdateManager.selectPreferredDelta(deltas, 100, "unused-sha");
    check(picked != null && "/d100".equals(picked.optString("url")), "Must prefer matching fromVersionCode delta");
    check(UpdateManager.selectPreferredDelta(deltas, 101, "unused-sha") == null, "Must return null when no fromVersionCode matches");

    // 3. Stage with delta + HTTP Range resume across simulated drop!
    Storage.setAutoDownloadUpdatesEnabled(app, true);
    CountDownLatch l1 = new CountDownLatch(1);
    AtomicReference<File> stagedRef = new AtomicReference<>();
    AtomicReference<String> errRef = new AtomicReference<>();
    UpdateManager.checkAndStageAsync(app, "", new UpdateManager.Callback() {
      @Override public void onStage(String m, int p) {}
      @Override public void onUpToDate(String c, String s) { errRef.set("uptodate"); l1.countDown(); }
      @Override public void onReady(File f, String v, boolean usedDelta, long db, long fb, String n) {
        if (!usedDelta) errRef.set("expected delta");
        stagedRef.set(f);
        l1.countDown();
      }
      @Override public void onError(String m) { errRef.set(m); l1.countDown(); }
    });
    check(l1.await(10, TimeUnit.SECONDS), "delta+range stage timed out");
    check(errRef.get() == null, "delta+range stage error: " + errRef.get());
    check(stagedRef.get() != null && stagedRef.get().isFile(), "staged APK missing");

    // 4. Signing cert mismatch discards corrupt staged package!
    File updatesDir = new File(filesDirPath, "updates");
    PackageInfo wrongCert = new PackageInfo();
    wrongCert.packageName = "dev.rokbot.nativeapp";
    wrongCert.versionCode = 200;
    wrongCert.signingInfo = new SigningInfo();
    wrongCert.signingInfo.sigs = new android.content.pm.Signature[] { new android.content.pm.Signature("tampered-cert".getBytes("UTF-8")) };
    wrongCert.signatures = wrongCert.signingInfo.sigs;
    pm.archiveInfo = wrongCert;

    stagedRef.get().delete();
    CountDownLatch l2 = new CountDownLatch(1);
    AtomicReference<String> badErr = new AtomicReference<>();
    UpdateManager.checkAndStageAsync(app, "", new UpdateManager.Callback() {
      @Override public void onStage(String m, int p) {}
      @Override public void onUpToDate(String c, String s) { l2.countDown(); }
      @Override public void onReady(File f, String v, boolean d, long db, long fb, String n) { l2.countDown(); }
      @Override public void onError(String m) { badErr.set(m); l2.countDown(); }
    });
    check(l2.await(10, TimeUnit.SECONDS), "tamper test timed out");
    check(badErr.get() != null && !badErr.get().isEmpty(), "Expected verification failure on cert mismatch");
    for (File f : updatesDir.listFiles()) {
      check(!f.getName().startsWith("ready-") && !f.getName().endsWith(".apk.tmp") && !f.getName().endsWith(".part"),
          "Unverified artifact was not discarded: " + f.getName());
    }

    System.out.println("BG_HARNESS_OK");
  }
}
`);
  cp.execFileSync(env.javac, ['--release', '17', '-encoding', 'UTF-8', '-cp', `${overrideClassesDir}:${classesDir}:${env.androidJar}`, '-d', testClassesDir, harness], { stdio: 'pipe' });

  const { stdout: out } = await execFileAsync(env.java, [
    '-cp', `${overrideClassesDir}:${testClassesDir}:${classesDir}:${env.androidJar}`,
    'dev.rokbot.nativeapp.BgHarness', origin, baseApkPath, filesDir, targetSha,
  ], { encoding: 'utf8' });
  assert.ok(out.includes('BG_HARNESS_OK'), out);
  assert.ok(rangeHeaderSeen && rangeHeaderSeen.startsWith('bytes='), `Expected HTTP Range resume request, saw ${rangeHeaderSeen}`);
  assert.equal(requests.some(r => r.pathname.includes('wrong-vc.rbdelta')), false, 'Must NOT fetch wrong fromVersionCode delta');
});

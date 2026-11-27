// Requirement A: Android update URL routing follows active Host connection (Tailcat / LAN / external fallback)
// and consistently sends Authorization: Bearer <token> + x-rokbot-client on every Host/fallback path.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(cp.execFile);

import { createSelfHostServer } from '../../host/server/index.mjs';
import { createEntry, writeZip } from '../patchers/signing.mjs';
import { generateDelta } from '../release/delta-update.mjs';

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

test('Host /local/updates/android.json follows direct LAN/loopback origin instead of forcing external publicUrl', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-host-upd-origin-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

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

  const adminToken = await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const adminCookie = `rokbot_admin=${adminToken}`;
  const pairRes = await host.auth.pair({
    password: 'AdminPass123',
    deviceName: 'AndroidTest',
    platform: 'desktop',
    clientKind: 'android',
  });
  const token = pairRes.token;

  const apk1 = makeSyntheticZip([['AndroidManifest.xml', 'v1', false], ['classes.dex', Buffer.alloc(4096, 0x11), false]]);
  const apk2 = makeSyntheticZip([['AndroidManifest.xml', 'v2', false], ['classes.dex', Buffer.alloc(4096, 0x22), false]]);
  for (const [name, buf] of [['RokBot-1.0.apk', apk1], ['RokBot-2.0.apk', apk2]]) {
    const up = await fetch(`http://127.0.0.1:${hostPort}/admin/api/updates/upload?platform=android&filename=${name}`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-rokbot-csrf': '1' },
      body: buf,
    });
    assert.equal(up.status, 201);
  }
  const pub1 = await (await fetch(`http://127.0.0.1:${hostPort}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'android', filename: 'RokBot-1.0.apk', versionName: '1.0.0', versionCode: 100 }),
  })).json();
  await fetch(`http://127.0.0.1:${hostPort}/admin/api/updates/publish`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'x-rokbot-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'android',
      filename: 'RokBot-2.0.apk',
      versionName: '2.0.0',
      versionCode: 200,
      generateDeltaFrom: pub1.release.id,
    }),
  });

  // 1) Direct LAN Host header (no x-forwarded-*) uses LAN origin instead of prokbot.cosfoc.com
  const lanManifest = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: hostPort,
      path: '/local/updates/android.json',
      headers: {
        host: `192.168.1.50:${hostPort}`,
        authorization: `Bearer ${token}`,
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(lanManifest.status, 200);
  assert.equal(lanManifest.body.latest.apkUrl, `http://192.168.1.50:${hostPort}/local/updates/files/android/RokBot-2.0.apk`);
  assert.ok(lanManifest.body.latest.deltas[0].url.startsWith(`http://192.168.1.50:${hostPort}/local/updates/files/android/`));

  // 2) Reverse-proxied external request (x-forwarded-proto: https) uses configured canonical publicUrl
  const extManifest = await (await fetch(`http://127.0.0.1:${hostPort}/local/updates/android.json`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-host': 'prokbot.cosfoc.com',
      'x-forwarded-proto': 'https',
    },
  })).json();
  assert.equal(extManifest.latest.apkUrl, 'https://prokbot.cosfoc.com/local/updates/files/android/RokBot-2.0.apk');
  assert.ok(extManifest.latest.deltas[0].url.startsWith('https://prokbot.cosfoc.com/local/updates/files/android/'));
});

test('UpdateManager contract: Host base precedes bundled external URL and Bearer + client headers are sent on all Host/fallback paths', () => {
  const um = fs.readFileSync(path.join(SRC, 'UpdateManager.java'), 'utf8');
  assert.match(um, /resolveDefaultFeedUrl[\s\S]*Storage\.isPaired\(context\)[\s\S]*resolvePairedHostBase\(context\)[\s\S]*resolveExternalFallbackFeedUrl\(context\)/);
  assert.match(um, /resolveManifestResourceUrl\([\s\S]*rewriteUrlToBase\(resolved, activeBase\)/);
  assert.match(um, /conn\.setRequestProperty\("x-rokbot-client",\s*"android-native\/1\.26\.0"\)/);
  assert.match(um, /conn\.setRequestProperty\("Authorization",\s*"Bearer "\s*\+\s*bearerToken\)/);
});

test('UpdateManager (JVM): Tailcat/LAN routing, apkUrl/delta URL rewriting, fallback order, and Bearer auth on all paths', async t => {
  const env = findJdkAndSdk();
  if (!env) return t.skip('Android SDK and JBR JDK required for JVM verification');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-upd-routing-jvm-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const big = Buffer.alloc(64 * 1024, 0x55);
  const baseApk = makeSyntheticZip([['AndroidManifest.xml', 'v1', false], ['lib/arm64-v8a/liba.so', big, true]]);
  const targetApk = makeSyntheticZip([['AndroidManifest.xml', 'v2-new', false], ['lib/arm64-v8a/liba.so', big, true]]);
  const deltaBuf = generateDelta(baseApk, targetApk);
  const baseSha = sha256Hex(baseApk);
  const targetSha = sha256Hex(targetApk);
  const deltaSha = sha256Hex(deltaBuf);
  const certBytes = Buffer.from('test-cert-der');
  const certSha = sha256Hex(certBytes);

  const mkManifest = (origin) => ({
    schema: 'rokbot-android-native-update/v1',
    latest: {
      packageName: 'dev.rokbot.nativeapp',
      versionName: '2.0.0',
      versionCode: 200,
      certificateSha256: certSha,
      // Intentionally stamp external canonical origin in manifest to verify client rewrites to active Host!
      apkUrl: `${origin}/local/updates/files/android/RokBot-2.0.0.apk`,
      apkSha256: targetSha,
      apkSize: targetApk.length,
      deltas: [{
        fromVersionCode: 100,
        fromApkSha256: baseSha,
        format: 'RBDELTA1',
        url: `${origin}/local/updates/files/android/patch.rbdelta`,
        sha256: deltaSha,
        size: deltaBuf.length,
      }],
    },
  });

  const makeMockServer = (name, logs, { requireAuth = true, manifestOriginFn } = {}) => {
    const srv = http.createServer((req, res) => {
      logs.push({
        server: name,
        url: req.url,
        auth: req.headers.authorization || null,
        client: req.headers['x-rokbot-client'] || null,
      });
      if (requireAuth && req.headers.authorization !== 'Bearer dev-token-1234567890') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"unauthorized"}');
      }
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname === '/local/updates/android.json') {
        const body = JSON.stringify(mkManifest(manifestOriginFn()));
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        return res.end(body);
      }
      if (pathname === '/local/updates/files/android/patch.rbdelta') {
        res.writeHead(200, { 'content-length': deltaBuf.length });
        return res.end(deltaBuf);
      }
      if (pathname === '/local/updates/files/android/RokBot-2.0.0.apk') {
        res.writeHead(200, { 'content-length': targetApk.length });
        return res.end(targetApk);
      }
      res.writeHead(404);
      res.end();
    });
    return srv;
  };

  const tcLogs = [];
  const lanLogs = [];
  const extLogs = [];
  let extOrigin = '';
  const tcSrv = makeMockServer('tailcat', tcLogs, { manifestOriginFn: () => extOrigin });
  const lanSrv = makeMockServer('lan', lanLogs, { manifestOriginFn: () => extOrigin });
  const extSrv = makeMockServer('external', extLogs, { manifestOriginFn: () => extOrigin });

  await Promise.all([
    new Promise(r => tcSrv.listen(0, '127.0.0.1', r)),
    new Promise(r => lanSrv.listen(0, '127.0.0.1', r)),
    new Promise(r => extSrv.listen(0, '127.0.0.1', r)),
  ]);
  t.after(() => Promise.all([
    new Promise(r => tcSrv.close(r)),
    new Promise(r => lanSrv.close(r)),
    new Promise(r => extSrv.close(r)),
  ]));

  const tcOrigin = `http://127.0.0.1:${tcSrv.address().port}`;
  const lanOrigin = `http://127.0.0.1:${lanSrv.address().port}`;
  extOrigin = `http://127.0.0.1:${extSrv.address().port}`;

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
import org.json.JSONObject;
public final class TailcatBridge {
  public static volatile boolean available = true;
  public static volatile String mockLocalUrl = "";
  public static boolean isAvailable() { return available; }
  public static String safeIdentity() { return "{\\"node\\":\\"test\\"}"; }
  public static String safeStart(String cfg) {
    if (!available || mockLocalUrl.isEmpty()) return "{}";
    try { return new JSONObject().put("handle", 1).put("status", new JSONObject().put("listening", true).put("localURL", mockLocalUrl).put("path", "direct")).toString(); }
    catch (Exception e) { return "{}"; }
  }
  public static String safeStatus(int h) {
    if (!available || mockLocalUrl.isEmpty()) return "{}";
    try { return new JSONObject().put("listening", true).put("localURL", mockLocalUrl).put("state", "ready").put("error", "").put("path", "direct").toString(); }
    catch (Exception e) { return "{}"; }
  }
  public static void safeStop(int h) {}
}
`);
  cp.execFileSync(env.javac, ['--release', '17', '-encoding', 'UTF-8', '-cp', env.androidJar, '-d', classesDir, ...sources, mockBridge], { stdio: 'pipe' });

  // Minimal runtime overrides (same pattern as delta-update.test.mjs)
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
    writeOv('android/content/pm/Signature.java', 'package android.content.pm; public class Signature { private final byte[] b; public Signature(byte[] b){this.b=b;} public byte[] toByteArray(){return b;} }'),
    writeOv('android/content/pm/SigningInfo.java', 'package android.content.pm; public class SigningInfo { public Signature[] sigs; public boolean hasMultipleSigners(){return false;} public Signature[] getApkContentsSigners(){return sigs;} public Signature[] getSigningCertificateHistory(){return sigs;} }'),
    writeOv('android/content/pm/PackageInfo.java', 'package android.content.pm; public class PackageInfo { public String packageName; public String versionName; public int versionCode; public SigningInfo signingInfo; public Signature[] signatures; public long getLongVersionCode(){return versionCode;} }'),
    writeOv('android/content/pm/PackageManager.java', 'package android.content.pm; public class PackageManager { public static final int GET_SIGNATURES=64; public static final int GET_SIGNING_CERTIFICATES=0x08000000; public PackageInfo installedInfo; public PackageInfo getPackageInfo(String p,int f){return installedInfo;} public PackageInfo getPackageArchiveInfo(String a,int f){return installedInfo;} public boolean canRequestPackageInstalls(){return true;} }'),
    writeOv('android/content/pm/ApplicationInfo.java', 'package android.content.pm; public class ApplicationInfo { public String sourceDir; }'),
    writeOv('android/content/res/AssetManager.java', `package android.content.res;
import java.io.*;
import java.nio.charset.StandardCharsets;
public class AssetManager {
  public String updateConfigJson = null;
  public InputStream open(String fileName) throws IOException {
    if ("recipes/update-config.json".equals(fileName) && updateConfigJson != null) {
      return new ByteArrayInputStream(updateConfigJson.getBytes(StandardCharsets.UTF_8));
    }
    throw new FileNotFoundException(fileName);
  }
}`),
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
  @SuppressWarnings("unchecked") public JSONObject optJSONObject(String k) {
    Object v = map.get(k);
    if (v instanceof JSONObject) return (JSONObject) v;
    return v instanceof Map ? new JSONObject((Map<String, Object>) v) : null;
  }
  @SuppressWarnings("unchecked") public JSONArray optJSONArray(String k) {
    Object v = map.get(k);
    if (v instanceof JSONArray) return (JSONArray) v;
    return v instanceof List ? new JSONArray((List<Object>) v) : null;
  }
  @Override public String toString() { return MiniJson.stringify(map); }
}`),
    writeOv('org/json/JSONArray.java', String.raw`package org.json;
import java.util.*;
public class JSONArray {
  final List<Object> list = new ArrayList<>();
  public JSONArray() {}
  @SuppressWarnings("unchecked") public JSONArray(String json) { list.addAll((List<Object>) MiniJson.parse(json)); }
  public JSONArray(Collection<?> c) { if (c != null) list.addAll(c); }
  JSONArray(List<Object> l) { list.addAll(l); }
  public int length() { return list.size(); }
  public JSONArray put(Object v) { list.add(v); return this; }
  @SuppressWarnings("unchecked") public JSONObject optJSONObject(int i) {
    if (i < 0 || i >= list.size()) return null;
    Object v = list.get(i);
    if (v instanceof JSONObject) return (JSONObject) v;
    return v instanceof Map ? new JSONObject((Map<String, Object>) v) : null;
  }
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
    if (o instanceof Map) {
      StringBuilder sb = new StringBuilder("{"); boolean f = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
        if (!f) sb.append(','); f = false;
        sb.append(quote(String.valueOf(e.getKey()))).append(':').append(stringify(e.getValue()));
      }
      return sb.append('}').toString();
    }
    if (o instanceof List) {
      StringBuilder sb = new StringBuilder("["); boolean f = true;
      for (Object x : (List<?>) o) { if (!f) sb.append(','); f = false; sb.append(stringify(x)); }
      return sb.append(']').toString();
    }
    return quote(String.valueOf(o));
  }
  static String quote(String s) {
    StringBuilder sb = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"' || c == '\\') sb.append('\\').append(c);
      else if (c == '\n') sb.append("\\n");
      else if (c == '\r') sb.append("\\r");
      else if (c == '\t') sb.append("\\t");
      else sb.append(c);
    }
    return sb.append('"').toString();
  }
  static final class Parser {
    final String s; int i = 0;
    Parser(String s) { this.s = s; }
    void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
    Object val() {
      ws(); char c = s.charAt(i);
      if (c == '{') return obj();
      if (c == '[') return arr();
      if (c == '"') return str();
      if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
      if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
      if (s.startsWith("null", i)) { i += 4; return null; }
      int st = i;
      while (i < s.length() && "-0123456789.eE+".indexOf(s.charAt(i)) >= 0) i++;
      String num = s.substring(st, i);
      return (num.contains(".") || num.contains("e") || num.contains("E")) ? Double.parseDouble(num) : Long.parseLong(num);
    }
    Map<String, Object> obj() {
      Map<String, Object> m = new LinkedHashMap<>(); i++; ws();
      if (s.charAt(i) == '}') { i++; return m; }
      while (true) { ws(); String k = str(); ws(); i++; m.put(k, val()); ws(); if (s.charAt(i) == ',') { i++; continue; } i++; break; }
      return m;
    }
    List<Object> arr() {
      List<Object> l = new ArrayList<>(); i++; ws();
      if (s.charAt(i) == ']') { i++; return l; }
      while (true) { l.add(val()); ws(); if (s.charAt(i) == ',') { i++; continue; } i++; break; }
      return l;
    }
    String str() {
      i++; StringBuilder sb = new StringBuilder();
      while (i < s.length()) {
        char c = s.charAt(i++);
        if (c == '"') return sb.toString();
        if (c == '\\') {
          char e = s.charAt(i++);
          if (e == 'n') sb.append('\n'); else if (e == 'r') sb.append('\r'); else if (e == 't') sb.append('\t');
          else if (e == 'u') { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
          else sb.append(e);
        } else sb.append(c);
      }
      throw new RuntimeException("Unterminated string");
    }
  }
}`),
  ];
  cp.execFileSync(env.javac, ['--release', '17', '-encoding', 'UTF-8', '-cp', `${classesDir}:${env.androidJar}`, '-d', overrideClassesDir, ...ovFiles], { stdio: 'pipe' });

  const baseApkPath = path.join(tmp, 'base.apk');
  const filesDir = path.join(tmp, 'files');
  fs.writeFileSync(baseApkPath, baseApk);
  fs.mkdirSync(filesDir, { recursive: true });

  const harness = path.join(tmp, 'RoutingHarness.java');
  fs.writeFileSync(harness, `
import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.*;
import android.content.res.AssetManager;
import android.content.res.Resources;
import dev.grokbot.local.TailcatBridge;
import dev.rokbot.nativeapp.*;
import java.io.*;
import java.security.*;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import sun.misc.Unsafe;

public class RoutingHarness {
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
        final Map<String, Object> pending = new HashMap<>();
        final Set<String> removals = new HashSet<>();
        boolean clearAll = false;
        @Override public Editor putString(String k, String v) { pending.put(k, v); return this; }
        @Override public Editor putStringSet(String k, Set<String> v) { return this; }
        @Override public Editor putInt(String k, int v) { pending.put(k, v); return this; }
        @Override public Editor putLong(String k, long v) { pending.put(k, v); return this; }
        @Override public Editor putFloat(String k, float v) { pending.put(k, v); return this; }
        @Override public Editor putBoolean(String k, boolean v) { pending.put(k, v); return this; }
        @Override public Editor remove(String k) { removals.add(k); return this; }
        @Override public Editor clear() { clearAll = true; return this; }
        @Override public boolean commit() { apply(); return true; }
        @Override public void apply() { if (clearAll) data.clear(); for (String r : removals) data.remove(r); data.putAll(pending); }
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
    AssetManager assets = new AssetManager();
    @Override public Context getApplicationContext() { return this; }
    @Override public String getPackageName() { return "dev.rokbot.nativeapp"; }
    @Override public SharedPreferences getSharedPreferences(String name, int mode) { return prefs; }
    @Override public PackageManager getPackageManager() { return pm; }
    @Override public ApplicationInfo getApplicationInfo() { return appInfo; }
    @Override public File getFilesDir() { return filesDir; }
    @Override public AssetManager getAssets() { return assets; }
    @Override public Resources getResources() { return alloc(Resources.class); }
  }

  static void check(boolean c, String m) { if (!c) throw new AssertionError(m); }

  static UpdateManager.UpdateManifestInfo checkManifestSync(Context app, String feedUrl) throws Exception {
    CountDownLatch latch = new CountDownLatch(1);
    AtomicReference<UpdateManager.UpdateManifestInfo> ref = new AtomicReference<>();
    AtomicReference<String> err = new AtomicReference<>();
    UpdateManager.checkManifestAsync(app, feedUrl, new UpdateManager.CheckCallback() {
      @Override public void onUpToDate(String c, String s) { err.set("uptodate"); latch.countDown(); }
      @Override public void onUpdateAvailable(UpdateManager.UpdateManifestInfo info) { ref.set(info); latch.countDown(); }
      @Override public void onError(String m) { err.set(m); latch.countDown(); }
    });
    check(latch.await(10, TimeUnit.SECONDS), "checkManifestAsync timed out");
    check(err.get() == null, "checkManifestAsync failed: " + err.get());
    return ref.get();
  }

  static void stageSync(Context app, UpdateManager.UpdateManifestInfo info) throws Exception {
    CountDownLatch latch = new CountDownLatch(1);
    AtomicReference<String> err = new AtomicReference<>();
    UpdateManager.stageFromInfoAsync(app, info, new UpdateManager.Callback() {
      @Override public void onStage(String m, int p) {}
      @Override public void onUpToDate(String c, String s) { err.set("uptodate"); latch.countDown(); }
      @Override public void onReady(File f, String v, boolean d, long db, long fb, String n) { latch.countDown(); }
      @Override public void onError(String m) { err.set(m); latch.countDown(); }
    });
    check(latch.await(10, TimeUnit.SECONDS), "stageFromInfoAsync timed out");
    check(err.get() == null, "stageFromInfoAsync failed: " + err.get());
  }

  public static void main(String[] args) throws Exception {
    String tcOrigin = args[0], lanOrigin = args[1], extOrigin = args[2], baseApkPath = args[3], filesDirPath = args[4];
    Security.insertProviderAt(new Provider("AndroidKeyStore", "1.0", "test") {{ put("KeyStore.AndroidKeyStore", FakeKeyStoreSpi.class.getName()); }}, 1);

    FakeApp app = alloc(FakeApp.class);
    app.prefs = new MemPrefs();
    app.assets = new AssetManager();
    app.assets.updateConfigJson = "{\\"updateFeedUrl\\":\\"" + extOrigin + "/local/updates/android.json\\"}";
    app.appInfo = new ApplicationInfo();
    app.appInfo.sourceDir = baseApkPath;
    app.filesDir = new File(filesDirPath);
    PackageManager pm = new PackageManager();
    PackageInfo pi = new PackageInfo();
    pi.packageName = "dev.rokbot.nativeapp";
    pi.versionName = "1.0.0";
    pi.versionCode = 100;
    pi.signingInfo = new SigningInfo();
    pi.signingInfo.sigs = new android.content.pm.Signature[] { new android.content.pm.Signature("test-cert-der".getBytes("UTF-8")) };
    pi.signatures = pi.signingInfo.sigs;
    pm.installedInfo = pi;
    app.pm = pm;

    Storage.init(app);
    String token = "dev-token-1234567890";

    // 1) Tailcat mode: ignores bundled external URL, uses Tailcat localURL for feed, apkUrl, and deltas[].url
    TailcatBridge.available = true;
    TailcatBridge.mockLocalUrl = tcOrigin;
    Storage.saveTailcatCredentials(app, token, "tailcat://connect/tcABCDEFGHIJKLMNOPQRSTUVWXYZ123456?port=8000", "dev1", "{}", extOrigin);
    Storage.setUpdateFeedUrl(app, extOrigin + "/local/updates/android.json");

    check((tcOrigin + "/local/updates/android.json").equals(UpdateManager.resolveDefaultFeedUrl(app)),
        "Tailcat resolveDefaultFeedUrl must use tcOrigin, got " + UpdateManager.resolveDefaultFeedUrl(app));
    UpdateManager.UpdateManifestInfo tcInfo = checkManifestSync(app, "");
    check(tcInfo.fullUrl.startsWith(tcOrigin + "/local/updates/files/android/"), "Tailcat apkUrl: " + tcInfo.fullUrl);
    check(tcInfo.deltaUrl.startsWith(tcOrigin + "/local/updates/files/android/"), "Tailcat deltaUrl: " + tcInfo.deltaUrl);
    stageSync(app, tcInfo);

    // Clear staged apk before testing LAN
    for (File f : new File(filesDirPath, "updates").listFiles()) f.delete();

    // 2) LAN mode: uses LAN IP directly for feed, apkUrl, and deltas[].url
    TailcatManager.get().clear();
    Storage.saveCredentials(app, token, lanOrigin, "dev1", extOrigin);
    check((lanOrigin + "/local/updates/android.json").equals(UpdateManager.resolveDefaultFeedUrl(app)),
        "LAN resolveDefaultFeedUrl must use lanOrigin, got " + UpdateManager.resolveDefaultFeedUrl(app));
    UpdateManager.UpdateManifestInfo lanInfo = checkManifestSync(app, "");
    check(lanInfo.fullUrl.startsWith(lanOrigin + "/local/updates/files/android/"), "LAN apkUrl: " + lanInfo.fullUrl);
    check(lanInfo.deltaUrl.startsWith(lanOrigin + "/local/updates/files/android/"), "LAN deltaUrl: " + lanInfo.deltaUrl);
    stageSync(app, lanInfo);

    for (File f : new File(filesDirPath, "updates").listFiles()) f.delete();

    // 3) Fallback when Tailcat unavailable: falls back to external domain WITH Bearer token
    TailcatBridge.available = false;
    TailcatBridge.mockLocalUrl = "";
    Storage.saveTailcatCredentials(app, token, "tailcat://connect/tcABCDEFGHIJKLMNOPQRSTUVWXYZ123456?port=8000", "dev1", "{}", extOrigin);
    check((extOrigin + "/local/updates/android.json").equals(UpdateManager.resolveDefaultFeedUrl(app)),
        "Tailcat-down fallback resolveDefaultFeedUrl must use extOrigin, got " + UpdateManager.resolveDefaultFeedUrl(app));
    UpdateManager.UpdateManifestInfo extInfo = checkManifestSync(app, "");
    stageSync(app, extInfo);

    System.out.println("ROUTING_HARNESS_OK");
  }
}
`);
  cp.execFileSync(env.javac, ['--release', '17', '-encoding', 'UTF-8', '-cp', `${overrideClassesDir}:${classesDir}:${env.androidJar}`, '-d', testClassesDir, harness], { stdio: 'pipe' });

  const { stdout: out } = await execFileAsync(env.java, [
    '-cp', `${overrideClassesDir}:${testClassesDir}:${classesDir}:${env.androidJar}`,
    'RoutingHarness', tcOrigin, lanOrigin, extOrigin, baseApkPath, filesDir,
  ], { encoding: 'utf8' });
  assert.ok(out.includes('ROUTING_HARNESS_OK'), out);

  // Verify every single server hit carried Bearer token + x-rokbot-client and never hit /local/updates/fetch
  assert.ok(tcLogs.some(l => l.url.startsWith('/local/updates/android.json')));
  assert.ok(tcLogs.some(l => l.url.startsWith('/local/updates/files/android/patch.rbdelta')));
  assert.ok(lanLogs.some(l => l.url.startsWith('/local/updates/android.json')));
  assert.ok(lanLogs.some(l => l.url.startsWith('/local/updates/files/android/patch.rbdelta')));
  assert.ok(extLogs.some(l => l.url.startsWith('/local/updates/android.json')));
  assert.ok(extLogs.some(l => l.url.startsWith('/local/updates/files/android/patch.rbdelta')));
  for (const log of [...tcLogs, ...lanLogs, ...extLogs]) {
    assert.equal(log.auth, 'Bearer dev-token-1234567890', `Missing Bearer token on ${log.server} ${log.url}`);
    assert.equal(log.client, 'android-native/1.26.0', `Missing x-rokbot-client on ${log.server} ${log.url}`);
    assert.equal(log.url.startsWith('/local/updates/fetch'), false, `Unexpected proxy wrap on ${log.server} ${log.url}`);
  }
});

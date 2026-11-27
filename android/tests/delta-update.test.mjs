import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { generateDelta, applyDelta, DELTA_MAGIC, LEGACY_DELTA_MAGIC, sha256Hex } from '../release/delta-update.mjs';
import { parseAxml, patchManifest } from '../patchers/manifest.mjs';
import { writeZip, createEntry } from '../patchers/signing.mjs';
import { MockHostServer } from './mock-host.mjs';

function makeSyntheticZip(entries) {
  return writeZip(entries.map(([name, content, store]) => createEntry(name, Buffer.from(content), { store })));
}

test('RBDELTA1: ZIP-entry-aware delta emits RBDELTA1 magic and handles shifted large payloads with high savings and exact reconstruction', () => {
  const bigLib = crypto.randomBytes(512 * 1024); // 512 KB incompressible native lib
  const bigAsset = crypto.randomBytes(256 * 1024); // 256 KB incompressible asset
  const baseApk = makeSyntheticZip([
    ['AndroidManifest.xml', 'manifest-v1', false],
    ['classes2.dex', Buffer.alloc(40000, 0x41), false],
    ['lib/arm64-v8a/libnative.so', bigLib, true],
    ['assets/index.android.bundle', bigAsset, true],
  ]);

  // Change classes2.dex length (shifts all subsequent ZIP entries by +1337 bytes!)
  const newDex = Buffer.alloc(41337, 0x42);
  const targetApk = makeSyntheticZip([
    ['AndroidManifest.xml', 'manifest-v2-updated', false],
    ['classes2.dex', newDex, false],
    ['lib/arm64-v8a/libnative.so', bigLib, true],
    ['assets/index.android.bundle', bigAsset, true],
  ]);

  const delta = generateDelta(baseApk, targetApk);
  assert.ok(delta.length < targetApk.length * 0.1, `Expected delta (${delta.length}) to be <10% of target (${targetApk.length})`);
  assert.ok(zlib.gunzipSync(delta).subarray(0, 8).equals(DELTA_MAGIC), 'generateDelta() must emit RBDELTA1 magic');

  const reconstructed = applyDelta(baseApk, delta);
  assert.equal(sha256Hex(reconstructed), sha256Hex(targetApk));
  assert.equal(reconstructed.length, targetApk.length);
});

test('RBDELTA1: rejects base size mismatch, bad magic, and truncated streams', () => {
  const base = crypto.randomBytes(16384);
  const target = Buffer.concat([base.subarray(0, 8192), crypto.randomBytes(4096), base.subarray(8192)]);
  const delta = generateDelta(base, target);

  assert.throws(() => applyDelta(base.subarray(0, 1000), delta), /Base size mismatch/);
  assert.throws(() => applyDelta(base, Buffer.from('not-gzip')), /.+/);
  const badMagicRaw = zlib.gunzipSync(delta);
  Buffer.from('XXDELTA1', 'ascii').copy(badMagicRaw, 0);
  assert.throws(() => applyDelta(base, zlib.gzipSync(badMagicRaw)), /Invalid delta magic header/);

  const valid = applyDelta(base, delta);
  assert.equal(sha256Hex(valid), sha256Hex(target));
});

test('RBDELTA1 cross-language & GBDELTA1 compat: Node.js applyDelta() and Android DeltaPatcher.java support both RBDELTA1 and legacy GBDELTA1', () => {
  const javac = fs.existsSync('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac')
    ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac'
    : 'javac';
  const java = fs.existsSync('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java')
    ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java'
    : 'java';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-delta-jvm-'));
  try {
    const bigPayload = crypto.randomBytes(196 * 1024);
    const baseApk = makeSyntheticZip([
      ['classes2.dex', crypto.randomBytes(8192), false],
      ['lib/arm64-v8a/libtest.so', bigPayload, true],
    ]);
    const targetApk = makeSyntheticZip([
      ['classes2.dex', crypto.randomBytes(9777), false],
      ['lib/arm64-v8a/libtest.so', bigPayload, true],
    ]);
    const delta = generateDelta(baseApk, targetApk);
    const legacyRaw = zlib.gunzipSync(delta);
    LEGACY_DELTA_MAGIC.copy(legacyRaw, 0);
    const legacyDelta = zlib.gzipSync(legacyRaw);

    // Node backward read-compat for legacy GBDELTA1
    const nodeLegacyOut = applyDelta(baseApk, legacyDelta);
    assert.equal(sha256Hex(nodeLegacyOut), sha256Hex(targetApk));

    const basePath = path.join(tmpDir, 'base.apk');
    const deltaPath = path.join(tmpDir, 'patch.rbdelta');
    const legacyDeltaPath = path.join(tmpDir, 'legacy.gbdelta');
    const badDeltaPath = path.join(tmpDir, 'bad.rbdelta');
    const outPath = path.join(tmpDir, 'reconstructed.apk');
    const legacyOutPath = path.join(tmpDir, 'reconstructed-legacy.apk');
    fs.writeFileSync(basePath, baseApk);
    fs.writeFileSync(deltaPath, delta);
    fs.writeFileSync(legacyDeltaPath, legacyDelta);
    const badRaw = zlib.gunzipSync(delta);
    Buffer.from('XXDELTA1', 'ascii').copy(badRaw, 0);
    fs.writeFileSync(badDeltaPath, zlib.gzipSync(badRaw));

    const deltaJavaSrc = path.resolve('android/companion/src/main/java/dev/rokbot/nativeapp/DeltaPatcher.java');
    const runnerSrc = path.join(tmpDir, 'RunDelta.java');
    fs.writeFileSync(runnerSrc, `
import dev.rokbot.nativeapp.DeltaPatcher;
import java.io.File;
import java.io.IOException;
public class RunDelta {
  public static void main(String[] args) throws Exception {
    DeltaPatcher.apply(new File(args[0]), new File(args[1]), new File(args[2]), null);
    DeltaPatcher.apply(new File(args[0]), new File(args[3]), new File(args[4]), null);
    try {
      DeltaPatcher.apply(new File(args[0]), new File(args[5]), new File(args[4] + ".bad"), null);
      throw new AssertionError("Expected IOException for bad magic");
    } catch (IOException expected) {}
  }
}
`);
    execFileSync(javac, ['--release', '17', '-d', tmpDir, deltaJavaSrc, runnerSrc], { stdio: 'pipe' });
    execFileSync(java, ['-cp', tmpDir, 'RunDelta', basePath, deltaPath, outPath, legacyDeltaPath, legacyOutPath, badDeltaPath], { stdio: 'pipe' });

    const reconstructed = fs.readFileSync(outPath);
    assert.equal(sha256Hex(reconstructed), sha256Hex(targetApk));
    assert.equal(reconstructed.length, targetApk.length);
    const reconstructedLegacy = fs.readFileSync(legacyOutPath);
    assert.equal(sha256Hex(reconstructedLegacy), sha256Hex(targetApk));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Manifest: patchManifest registers ApkUpdateProvider and REQUEST_INSTALL_PACKAGES', () => {
  const coexistApk = path.resolve('android/output/rokbot-native-coexist.apk');
  const baseApk = path.resolve('android/bin/rokbot-native-base.apk');
  const sampleApk = fs.existsSync(coexistApk) ? coexistApk : baseApk;
  assert.ok(fs.existsSync(sampleApk), 'Base APK fixture must exist for manifest test');
  const rawManifest = execFileSync('unzip', ['-p', sampleApk, 'AndroidManifest.xml'], { maxBuffer: 8 * 1024 * 1024 });
  const patched = patchManifest(rawManifest, { packageName: 'ai.x.grok.bot.local' });
  const ast = parseAxml(patched);
  const manifest = ast.rootNodes.find(n => n.name === 'manifest');
  const app = manifest.children.find(c => c.name === 'application');
  const updateProvider = app.children.find(
    c => c.name === 'provider' && c.attributes.some(a => a.name === 'name' && a.value === 'dev.rokbot.nativeapp.ApkUpdateProvider')
  );
  assert.ok(updateProvider, 'ApkUpdateProvider must be registered');
  assert.ok(
    updateProvider.attributes.some(a => a.name === 'authorities' && a.value === 'ai.x.grok.bot.local.rokbot.updateprovider'),
    'ApkUpdateProvider authority must use target packageName'
  );
  assert.ok(
    updateProvider.attributes.some(a => a.name === 'grantUriPermissions' && a.value === true),
    'ApkUpdateProvider must enable grantUriPermissions'
  );
  const hasReqInstall = manifest.children.some(
    c => c.name === 'uses-permission' && c.attributes.some(a => a.name === 'name' && a.value === 'android.permission.REQUEST_INSTALL_PACKAGES')
  );
  assert.ok(hasReqInstall, 'REQUEST_INSTALL_PACKAGES permission must be registered');
});

test('JVM Integration: UpdateManager & HostApiClient talk to paired MockHostServer /local/updates/android.json, /local/status, and /local/model*', async () => {
  const sdkRoot = [process.env.ANDROID_HOME, '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
    .find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javacBin = ['/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac', 'javac']
    .find(bin => {
      try {
        execFileSync(bin, ['-version'], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    });
  assert.ok(sdkRoot && javacBin, 'Android SDK and JDK required for UpdateManager/HostApiClient JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');

  const host = new MockHostServer({ pairingKey: 'ABCDEF', adminPassword: 'AdminPass123!', needsModel: true });
  await host.start();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-upd-jvm-'));
  try {
    // Build synthetic base and target APKs + RBDELTA1 patch
    const bigPayload = crypto.randomBytes(128 * 1024);
    const baseApkBytes = makeSyntheticZip([
      ['AndroidManifest.xml', 'v1-manifest', false],
      ['classes2.dex', Buffer.alloc(16384, 0x11), false],
      ['lib/arm64-v8a/libnative.so', bigPayload, true],
    ]);
    const targetApkBytes = makeSyntheticZip([
      ['AndroidManifest.xml', 'v2-manifest-updated', false],
      ['classes2.dex', Buffer.alloc(17000, 0x22), false],
      ['lib/arm64-v8a/libnative.so', bigPayload, true],
    ]);
    const deltaBytes = generateDelta(baseApkBytes, targetApkBytes);
    const baseSha = sha256Hex(baseApkBytes);
    const targetSha = sha256Hex(targetApkBytes);
    const deltaSha = sha256Hex(deltaBytes);
    const certRaw = Buffer.from('test-signing-cert-der-bytes');
    const certSha = crypto.createHash('sha256').update(certRaw).digest('hex');
    const certShaColons = certSha.toUpperCase().match(/.{2}/g).join(':');

    const baseApkPath = path.join(tmpDir, 'installed-base.apk');
    const filesDir = path.join(tmpDir, 'files');
    fs.writeFileSync(baseApkPath, baseApkBytes);
    fs.mkdirSync(filesDir, { recursive: true });

    host.androidUpdateArtifacts.set('RokBot-1.16.1.apk', targetApkBytes);
    host.androidUpdateArtifacts.set('patch-1075-to-1076.rbdelta', deltaBytes);
    host.androidUpdateManifest = {
      schema: 'rokbot-android-native-update/v1',
      latest: {
        versionName: '1.16.1',
        versionCode: 1076,
        packageName: 'dev.rokbot.nativeapp',
        certificateSha256: certShaColons,
        apkUrl: `${host.origin}/local/updates/files/android/RokBot-1.16.1.apk`,
        apkSha256: targetSha,
        apkSize: targetApkBytes.length,
        releaseNotes: 'In-app model config & adaptive icon update',
        deltas: [{
          fromVersionCode: 1075,
          fromApkSha256: baseSha,
          format: 'RBDELTA1',
          url: `${host.origin}/local/updates/files/android/patch-1075-to-1076.rbdelta`,
          sha256: deltaSha,
          size: deltaBytes.length,
        }],
      },
    };

    // Pair a device token via HTTP
    const pairRes = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName: 'JvmUpdaterTest',
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: 'ABCDEF',
      }),
    });
    assert.equal(pairRes.status, 201);
    const paired = await pairRes.json();

    // Compile companion Java classes against real android.jar + compile-stubs
    const outClasses = path.join(tmpDir, 'classes');
    const overrideSrc = path.join(tmpDir, 'overrideSrc');
    const overrideClasses = path.join(tmpDir, 'overrideClasses');
    const testSrc = path.join(tmpDir, 'testSrc');
    const testClasses = path.join(tmpDir, 'testClasses');
    fs.mkdirSync(outClasses, { recursive: true });
    fs.mkdirSync(overrideSrc, { recursive: true });
    fs.mkdirSync(overrideClasses, { recursive: true });
    fs.mkdirSync(testSrc, { recursive: true });
    fs.mkdirSync(testClasses, { recursive: true });

    const javaFiles = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.java')) javaFiles.push(full);
      }
    };
    walk(path.join('android/companion/compile-stubs/src/main/java'));
    walk(path.join('android/companion/src/main/java'));
    execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-cp', androidJar, '-d', outClasses, ...javaFiles], { stdio: 'pipe' });

    const writeOverride = (rel, code) => {
      const f = path.join(overrideSrc, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, code);
      return f;
    };
    const ovFiles = [
      writeOverride('android/util/Log.java', `package android.util;
public final class Log {
  public static int w(String t, String m) { return 0; }
  public static int w(String t, String m, Throwable tr) { return 0; }
  public static int d(String t, String m) { return 0; }
  public static int e(String t, String m) { return 0; }
}`),
      writeOverride('android/util/Base64.java', `package android.util;
public class Base64 {
  public static final int NO_WRAP = 2;
  public static final int DEFAULT = 0;
  public static String encodeToString(byte[] input, int flags) { return java.util.Base64.getEncoder().encodeToString(input); }
  public static byte[] decode(String str, int flags) { return java.util.Base64.getDecoder().decode(str); }
}`),
      writeOverride('android/os/Build.java', `package android.os;
public class Build {
  public static final String MANUFACTURER = "Google";
  public static final String MODEL = "Pixel";
  public static class VERSION { public static final int SDK_INT = 35; }
}`),
      writeOverride('android/os/SystemClock.java', `package android.os;
public class SystemClock {
  public static long elapsedRealtime() { return System.currentTimeMillis(); }
}`),
      writeOverride('android/provider/Settings.java', `package android.provider;
import android.content.ContentResolver;
public final class Settings {
  public static final class Global {
    public static final String DEVICE_NAME = "device_name";
    public static String getString(ContentResolver cr, String name) { return "TestDevice"; }
  }
  public static final class Secure {
    public static final String ANDROID_ID = "android_id";
    public static String getString(ContentResolver cr, String name) { return "1234567890abcdef"; }
  }
}`),
      writeOverride('android/content/pm/Signature.java', `package android.content.pm;
public class Signature {
  private final byte[] bytes;
  public Signature(byte[] bytes) { this.bytes = bytes; }
  public byte[] toByteArray() { return bytes; }
}`),
      writeOverride('android/content/pm/SigningInfo.java', `package android.content.pm;
public class SigningInfo {
  public Signature[] sigs;
  public boolean hasMultipleSigners() { return false; }
  public Signature[] getApkContentsSigners() { return sigs; }
  public Signature[] getSigningCertificateHistory() { return sigs; }
}`),
      writeOverride('android/content/pm/PackageInfo.java', `package android.content.pm;
public class PackageInfo {
  public String packageName;
  public String versionName;
  public int versionCode;
  public SigningInfo signingInfo;
  public Signature[] signatures;
  public long getLongVersionCode() { return versionCode; }
}`),
      writeOverride('android/content/pm/PackageManager.java', `package android.content.pm;
public class PackageManager {
  public static final int GET_SIGNATURES = 64;
  public static final int GET_SIGNING_CERTIFICATES = 0x08000000;
  public PackageInfo installedInfo;
  public PackageInfo archiveInfo;
  public PackageInfo getPackageInfo(String pkg, int flags) { return installedInfo; }
  public PackageInfo getPackageArchiveInfo(String archiveFilePath, int flags) { return archiveInfo; }
  public boolean canRequestPackageInstalls() { return true; }
}`),
      writeOverride('android/content/pm/ApplicationInfo.java', `package android.content.pm;
public class ApplicationInfo { public String sourceDir; }`),
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
  public int length() { return map.size(); }
  public boolean isNull(String k) { return !map.containsKey(k) || map.get(k) == null || map.get(k) == NULL; }
  public String optString(String k, String d) {
    Object v = map.get(k);
    return v == null ? d : String.valueOf(v);
  }
  public String optString(String k) { return optString(k, ""); }
  public String getString(String k) {
    if (!has(k) || isNull(k)) throw new RuntimeException("Missing " + k);
    return String.valueOf(map.get(k));
  }
  public long optLong(String k, long d) {
    Object v = map.get(k);
    if (v instanceof Number) return ((Number) v).longValue();
    return d;
  }
  public long getLong(String k) { return ((Number) map.get(k)).longValue(); }
  public int optInt(String k, int d) {
    Object v = map.get(k);
    return v instanceof Number ? ((Number) v).intValue() : d;
  }
  public boolean optBoolean(String k, boolean d) {
    Object v = map.get(k);
    return v instanceof Boolean ? (Boolean) v : d;
  }
  public boolean getBoolean(String k) {
    Object v = map.get(k);
    if (!(v instanceof Boolean)) throw new RuntimeException("Missing boolean " + k);
    return (Boolean) v;
  }
  public JSONObject optJSONObject(String k) {
    Object v = map.get(k);
    if (v instanceof JSONObject) return (JSONObject) v;
    if (v instanceof Map) { @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) v; return new JSONObject(m); }
    return null;
  }
  public JSONObject getJSONObject(String k) {
    JSONObject o = optJSONObject(k);
    if (o == null) throw new RuntimeException("Missing object " + k);
    return o;
  }
  public JSONArray optJSONArray(String k) {
    Object v = map.get(k);
    if (v instanceof JSONArray) return (JSONArray) v;
    if (v instanceof List) { @SuppressWarnings("unchecked") List<Object> l = (List<Object>) v; return new JSONArray(l); }
    return null;
  }
  public JSONArray getJSONArray(String k) {
    JSONArray a = optJSONArray(k);
    if (a == null) throw new RuntimeException("Missing array " + k);
    return a;
  }
  public JSONArray names() {
    JSONArray a = new JSONArray();
    for (String k : map.keySet()) a.put(k);
    return a.length() == 0 ? null : a;
  }
  @Override public String toString() { return MiniJson.stringify(map); }
}`),
      writeOverride('org/json/JSONArray.java', `package org.json;
import java.util.*;
public class JSONArray {
  final List<Object> list = new ArrayList<>();
  public JSONArray() {}
  public JSONArray(String json) {
    Object parsed = MiniJson.parse(json);
    if (!(parsed instanceof List)) throw new RuntimeException("Not JSON array");
    @SuppressWarnings("unchecked") List<Object> l = (List<Object>) parsed;
    list.addAll(l);
  }
  public JSONArray(Collection<?> c) { if (c != null) list.addAll(c); }
  JSONArray(List<Object> l) { list.addAll(l); }
  public int length() { return list.size(); }
  public JSONArray put(Object v) { list.add(v); return this; }
  public boolean isNull(int i) {
    if (i < 0 || i >= list.size()) return true;
    Object v = list.get(i);
    return v == null || v == JSONObject.NULL;
  }
  public JSONObject optJSONObject(int i) {
    if (i < 0 || i >= list.size()) return null;
    Object v = list.get(i);
    if (v instanceof JSONObject) return (JSONObject) v;
    if (v instanceof Map) { @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) v; return new JSONObject(m); }
    return null;
  }
  public String optString(int i, String d) {
    if (i < 0 || i >= list.size()) return d;
    Object v = list.get(i);
    return v == null ? d : String.valueOf(v);
  }
  public Object remove(int i) { return (i >= 0 && i < list.size()) ? list.remove(i) : null; }
  @Override public String toString() { return MiniJson.stringify(list); }
}`),
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
}`),
    ];
    execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-cp', `${outClasses}:${androidJar}`, '-d', overrideClasses, ...ovFiles], { stdio: 'pipe' });

    const harnessJava = path.join(testSrc, 'VerifyUpdateAndModelsHarness.java');
    fs.writeFileSync(harnessJava, `
import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.*;
import android.content.res.AssetManager;
import dev.rokbot.nativeapp.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.lang.reflect.Field;
import java.security.*;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import sun.misc.Unsafe;

public class VerifyUpdateAndModelsHarness {
  private static Unsafe unsafe;
  static {
    try {
      Field f = Unsafe.class.getDeclaredField("theUnsafe");
      f.setAccessible(true);
      unsafe = (Unsafe) f.get(null);
    } catch (Exception e) { throw new RuntimeException(e); }
  }
  @SuppressWarnings("unchecked")
  private static <T> T alloc(Class<T> c) {
    try { return (T) unsafe.allocateInstance(c); }
    catch (Exception e) { throw new RuntimeException(e); }
  }
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
    @Override public boolean engineContainsAlias(String a) { return "rokbot-native-device-credential".equals(a); }
    @Override public int engineSize() { return 1; }
    @Override public boolean engineIsKeyEntry(String a) { return true; }
    @Override public boolean engineIsCertificateEntry(String a) { return false; }
    @Override public String engineGetCertificateAlias(Certificate c) { return null; }
    @Override public void engineStore(java.io.OutputStream s, char[] p) {}
    @Override public void engineLoad(java.io.InputStream s, char[] p) {}
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
        @Override public void apply() {
          if (clearAll) data.clear();
          for (String r : removals) data.remove(r);
          data.putAll(pending);
        }
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
    @Override public Context getApplicationContext() { return this; }
    @Override public String getPackageName() { return "dev.rokbot.nativeapp"; }
    @Override public SharedPreferences getSharedPreferences(String name, int mode) { return prefs; }
    @Override public PackageManager getPackageManager() { return pm; }
    @Override public ApplicationInfo getApplicationInfo() { return appInfo; }
    @Override public File getFilesDir() { return filesDir; }
    @Override public AssetManager getAssets() { return null; }
  }

  private static void check(boolean cond, String msg) {
    if (!cond) throw new AssertionError(msg);
  }

  public static void main(String[] args) throws Exception {
    String origin = args[0];
    String token = args[1];
    String deviceId = args[2];
    String baseApkPath = args[3];
    String filesDirPath = args[4];
    String targetSha = args[5];
    String expectedVersionName = args.length > 6 ? args[6] : "1.16.1";
    byte[] certBytes = "test-signing-cert-der-bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    Security.insertProviderAt(new Provider("AndroidKeyStore", "1.0", "test") {{
      put("KeyStore.AndroidKeyStore", FakeKeyStoreSpi.class.getName());
    }}, 1);

    FakeApp app = alloc(FakeApp.class);
    app.prefs = new MemPrefs();
    app.appInfo = new ApplicationInfo();
    app.appInfo.sourceDir = baseApkPath;
    app.filesDir = new File(filesDirPath);
    PackageManager pm = new PackageManager();
    PackageInfo installed = new PackageInfo();
    installed.packageName = "dev.rokbot.nativeapp";
    installed.versionName = "1.16.0";
    installed.versionCode = 1075;
    installed.signingInfo = new SigningInfo();
    installed.signingInfo.sigs = new android.content.pm.Signature[] { new android.content.pm.Signature(certBytes) };
    installed.signatures = installed.signingInfo.sigs;
    pm.installedInfo = installed;
    pm.archiveInfo = installed;
    app.pm = pm;

    Storage.init(app);
    Storage.saveCredentials(app, token, origin, deviceId);

    // 1. Default feed URL & paired Host URL detection
    String defUrl = UpdateManager.resolveDefaultFeedUrl(app);
    check((origin + "/local/updates/android.json").equals(defUrl), "Unexpected default feed URL: " + defUrl);
    check(UpdateManager.isPairedHostUrl(app, defUrl), "Feed URL must be recognized as paired Host URL");
    check(!UpdateManager.isPairedHostUrl(app, "https://cdn.example.com/update.json"), "External CDN must NOT be treated as Host URL");

    // 2. Two-phase UpdateManager check + RBDELTA1 staging
    CountDownLatch checkLatch = new CountDownLatch(1);
    AtomicReference<UpdateManager.UpdateManifestInfo> availRef = new AtomicReference<>();
    AtomicReference<String> checkErr = new AtomicReference<>();
    UpdateManager.checkManifestAsync(app, defUrl, new UpdateManager.CheckCallback() {
      @Override public void onUpToDate(String cur, String sha) { checkErr.set("Unexpected up-to-date: " + cur); checkLatch.countDown(); }
      @Override public void onUpdateAvailable(UpdateManager.UpdateManifestInfo info) { availRef.set(info); checkLatch.countDown(); }
      @Override public void onError(String message) { checkErr.set(message); checkLatch.countDown(); }
    });
    check(checkLatch.await(10, TimeUnit.SECONDS), "checkManifestAsync timed out");
    check(checkErr.get() == null, "checkManifestAsync error: " + checkErr.get());
    UpdateManager.UpdateManifestInfo info = availRef.get();
    check(info != null && info.hasDelta && expectedVersionName.equals(info.availableVersionName), "Expected RBDELTA1 update " + expectedVersionName);

    CountDownLatch stageLatch = new CountDownLatch(1);
    AtomicReference<File> stagedFileRef = new AtomicReference<>();
    AtomicReference<String> stageErr = new AtomicReference<>();
    UpdateManager.stageFromInfoAsync(app, info, new UpdateManager.Callback() {
      @Override public void onStage(String m, int pct) {}
      @Override public void onUpToDate(String cur, String sha) { stageErr.set("Unexpected up-to-date"); stageLatch.countDown(); }
      @Override public void onReady(File f, String vl, boolean usedDelta, long dl, long full, String notes) {
        check(usedDelta, "Expected RBDELTA1 delta path");
        stagedFileRef.set(f);
        stageLatch.countDown();
      }
      @Override public void onError(String message) { stageErr.set(message); stageLatch.countDown(); }
    });
    check(stageLatch.await(10, TimeUnit.SECONDS), "stageFromInfoAsync timed out");
    check(stageErr.get() == null, "stageFromInfoAsync error: " + stageErr.get());
    File staged = stagedFileRef.get();
    check(staged != null && staged.isFile(), "Staged APK must exist");
    check(targetSha.equalsIgnoreCase(UpdateManager.sha256Hex(staged)), "Staged APK SHA-256 mismatch");

    // 3. HostApiClient /local/status & /local/model* + blank apiKey preservation
    JSONObject stBefore = HostApiClient.getHostStatus(app);
    check(stBefore.optBoolean("needsModel", false), "Expected needsModel=true before config save");

    JSONObject catalog = HostApiClient.fetchModelCatalog(app,
        new JSONObject().put("provider", new JSONObject()
            .put("id", "p_main")
            .put("name", "OpenAI")
            .put("apiFormat", "openai")
            .put("baseUrl", "https://api.openai.com/v1")
            .put("apiKey", "sk-new-secret")), null);
    check(catalog.getJSONArray("models").length() >= 1, "Expected catalog models");

    JSONObject savePayload = new JSONObject()
        .put("version", 1)
        .put("providers", new JSONArray().put(new JSONObject()
            .put("id", "p_main")
            .put("name", "OpenAI")
            .put("apiFormat", "openai")
            .put("baseUrl", "https://api.openai.com/v1")
            .put("apiKey", "sk-new-secret")))
        .put("profiles", new JSONArray().put(new JSONObject()
            .put("id", "prof_main")
            .put("name", "GPT-5")
            .put("providerId", "p_main")
            .put("model", "gpt-5")
            .put("efforts", new JSONArray().put("low").put("high"))))
        .put("defaultRoute", new JSONObject().put("profileId", "prof_main").put("effort", "high").put("fallbacks", new JSONArray()))
        .put("botRoutes", new JSONObject());
    JSONObject saved = HostApiClient.saveModelConfig(app, savePayload, null);
    check(saved.getBoolean("ok"), "saveModelConfig must return ok=true");

    JSONObject stAfter = HostApiClient.getHostStatus(app);
    check(!stAfter.optBoolean("needsModel", true), "Expected needsModel=false after saving model config");

    // Verify blank apiKey preserves stored key on edit
    savePayload.getJSONArray("providers").optJSONObject(0).put("apiKey", "");
    savePayload.getJSONArray("providers").optJSONObject(0).put("name", "OpenAI Edited");
    JSONObject savedBlankKey = HostApiClient.saveModelConfig(app, savePayload, null);
    check(savedBlankKey.getJSONObject("config").getJSONArray("providers").optJSONObject(0).optBoolean("hasApiKey", false),
        "Blank apiKey edit must preserve stored apiKey");

    JSONObject testRes = HostApiClient.testModelConfig(app, new JSONObject().put("profileId", "prof_main"), null);
    check("OK".equals(testRes.optString("reply", "")), "testModelConfig must return OK");

    System.out.println("UPDATE_AND_MODELS_JVM_OK");
  }
}
`);
    execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-cp', `${overrideClasses}:${outClasses}:${androidJar}`, '-d', testClasses, harnessJava], { stdio: 'pipe' });

    const reqCountBefore = host.requestLogs.length;
    const runOut = await new Promise((resolve, reject) => {
      const child = spawn(javaBin, [
        '-cp', `${overrideClasses}:${testClasses}:${outClasses}:${androidJar}`,
        'VerifyUpdateAndModelsHarness',
        host.origin,
        paired.token,
        paired.deviceId,
        baseApkPath,
        filesDir,
        targetSha,
        '1.16.1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`VerifyUpdateAndModelsHarness timed out: ${stderr || stdout}`));
      }, 15000);
      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf8'); });
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`VerifyUpdateAndModelsHarness exited ${code}: ${stderr}\n${stdout}`));
        else resolve(stdout);
      });
    });
    assert.ok(runOut.includes('UPDATE_AND_MODELS_JVM_OK'), `Unexpected harness output: ${runOut}`);

    // Verify Host URLs were fetched directly with Bearer auth and NOT wrapped in /local/updates/fetch
    const updateLogs = host.requestLogs.slice(reqCountBefore).filter(r => r.pathname.startsWith('/local/updates/'));
    assert.ok(updateLogs.some(r => r.pathname === '/local/updates/android.json'), 'Must fetch /local/updates/android.json');
    assert.ok(updateLogs.some(r => r.pathname === '/local/updates/files/android/patch-1075-to-1076.rbdelta'), 'Must fetch delta directly');
    assert.equal(updateLogs.some(r => r.pathname === '/local/updates/fetch'), false, 'Must NEVER wrap paired Host URLs in /local/updates/fetch');
    for (const log of updateLogs) {
      assert.equal(log.headers.authorization, `Bearer ${paired.token}`);
      assert.equal(log.headers['x-rokbot-client'], 'android-native/1.26.0');
    }

    // Verify downgrade rejection (1074 < 1075) and same-versionCode different-SHA acceptance (1075 == 1075)
    host.androidUpdateManifest.latest.versionCode = 1074;
    const downgradeOut = await new Promise((resolve, reject) => {
      const child = spawn(javaBin, [
        '-cp', `${overrideClasses}:${testClasses}:${outClasses}:${androidJar}`,
        'VerifyUpdateAndModelsHarness',
        host.origin,
        paired.token,
        paired.deviceId,
        baseApkPath,
        filesDir,
        targetSha,
        '1.16.1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d.toString('utf8'); });
      child.on('close', code => resolve({ code, stderr }));
    });
    assert.notEqual(downgradeOut.code, 0);
    assert.ok(downgradeOut.stderr.includes('Unexpected up-to-date'), `Downgrade versionCode < installedVersionCode must report up-to-date, got: ${downgradeOut.stderr}`);

    // Same versionCode (1075) with different targetSha must still be accepted as an update!
    host.androidUpdateManifest.latest.versionCode = 1075;
    host.androidUpdateManifest.latest.versionName = '1.16.0';
    host.needsModel = true;
    const sameVcOut = await new Promise((resolve, reject) => {
      const child = spawn(javaBin, [
        '-cp', `${overrideClasses}:${testClasses}:${outClasses}:${androidJar}`,
        'VerifyUpdateAndModelsHarness',
        host.origin,
        paired.token,
        paired.deviceId,
        baseApkPath,
        filesDir,
        targetSha,
        '1.16.0',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf8'); });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(sameVcOut.code, 0, `Same-versionCode different-SHA update failed: ${sameVcOut.stderr}`);
    assert.ok(sameVcOut.stdout.includes('UPDATE_AND_MODELS_JVM_OK'));
  } finally {
    await host.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('JVM Regression: ModelsActivity legacy migration, efforts:[], onboarding error gating, AOSP NULL, DeltaPatcher overflow, and UpdateManager external/Tailcat-down guards', async () => {
  const sdkRoot = [process.env.ANDROID_HOME, '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
    .find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javacBin = ['/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac', 'javac']
    .find(bin => {
      try {
        execFileSync(bin, ['-version'], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    });
  assert.ok(sdkRoot && javacBin, 'Android SDK and JDK required for regression JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');

  // External HTTP server colliding on /local/updates/android.json path + returning {"error": null, "message": "Real Error Msg"}
  const extLogs = [];
  const extServer = http.createServer((req, res) => {
    extLogs.push({ method: req.method, url: req.url, auth: req.headers.authorization || null });
    if (req.url?.startsWith('/local/updates/android.json')) {
      const body = Buffer.from(JSON.stringify({ schema: 'rokbot-android-native-update/v1', external: true }), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      return res.end(body);
    }
    if (req.url === '/null-error') {
      const body = Buffer.from(JSON.stringify({ error: null, message: 'Real Error Msg' }), 'utf-8');
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => extServer.listen(0, '127.0.0.1', resolve));
  const extOrigin = `http://127.0.0.1:${extServer.address().port}`;

  const host = new MockHostServer({
    pairingKey: 'ABCDEF',
    adminPassword: 'AdminPass123!',
    needsModel: false,
    routingMigrated: true,
    configured: false,
  });
  await host.start();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-reg-jvm-'));
  try {
    const bigPayload = crypto.randomBytes(64 * 1024);
    const baseApkBytes = makeSyntheticZip([
      ['AndroidManifest.xml', 'v1', false],
      ['lib/arm64-v8a/libnative.so', bigPayload, true],
    ]);
    const targetApkBytes = makeSyntheticZip([
      ['AndroidManifest.xml', 'v2-null-fmt', false],
      ['lib/arm64-v8a/libnative.so', bigPayload, true],
    ]);
    const deltaBytes = generateDelta(baseApkBytes, targetApkBytes);
    const baseApkPath = path.join(tmpDir, 'base.apk');
    const filesDir = path.join(tmpDir, 'files');
    fs.writeFileSync(baseApkPath, baseApkBytes);
    fs.mkdirSync(filesDir, { recursive: true });

    const certSha = crypto.createHash('sha256').update(Buffer.from('test-signing-cert-der-bytes')).digest('hex');
    host.androidUpdateArtifacts.set('RokBot-nullfmt.apk', targetApkBytes);
    host.androidUpdateArtifacts.set('patch-nullfmt.rbdelta', deltaBytes);
    host.androidUpdateManifest = {
      schema: 'rokbot-android-native-update/v1',
      latest: {
        versionName: '1.16.2',
        versionCode: 1077,
        packageName: 'dev.rokbot.nativeapp',
        certificateSha256: certSha,
        apkUrl: `${host.origin}/local/updates/files/android/RokBot-nullfmt.apk`,
        apkSha256: sha256Hex(targetApkBytes),
        apkSize: targetApkBytes.length,
        deltas: [{
          fromVersionCode: 1075,
          fromApkSha256: sha256Hex(baseApkBytes),
          format: null, // AOSP JSONObject.NULL -> must NOT become "null" string!
          url: `${host.origin}/local/updates/files/android/patch-nullfmt.rbdelta`,
          sha256: sha256Hex(deltaBytes),
          size: deltaBytes.length,
        }],
      },
    };

    const pairRes = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'RegTest', platform: 'desktop', clientKind: 'android', pairingKey: 'ABCDEF' }),
    });
    assert.equal(pairRes.status, 201);
    const paired = await pairRes.json();

    const outClasses = path.join(tmpDir, 'classes');
    const overrideSrc = path.join(tmpDir, 'overrideSrc');
    const overrideClasses = path.join(tmpDir, 'overrideClasses');
    const testSrc = path.join(tmpDir, 'testSrc');
    const testClasses = path.join(tmpDir, 'testClasses');
    for (const d of [outClasses, overrideSrc, overrideClasses, testSrc, testClasses]) fs.mkdirSync(d, { recursive: true });

    const javaFiles = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.java')) javaFiles.push(full);
      }
    };
    walk(path.join('android/companion/compile-stubs/src/main/java'));
    walk(path.join('android/companion/src/main/java'));
    execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-cp', androidJar, '-d', outClasses, ...javaFiles], { stdio: 'pipe' });

    const writeOverride = (rel, code) => {
      const f = path.join(overrideSrc, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, code);
      return f;
    };

    const ovFiles = [
      writeOverride('dev/grokbot/local/TailcatBridge.java', `package dev.grokbot.local;
public final class TailcatBridge {
  public static volatile boolean available = true;
  public static volatile String mockLocalUrl = "";
  public static boolean isAvailable() { return available; }
  public static String getLoadError() { return available ? null : "mock-down"; }
  public static String nativeIdentity() { return "{}"; }
  public static String nativeStart(String cfg) {
    return "{\\"handle\\":1,\\"status\\":{\\"listening\\":true,\\"state\\":\\"Running\\",\\"localURL\\":\\"" + mockLocalUrl + "\\",\\"path\\":\\"direct\\"}}";
  }
  public static String nativeStatus(int h) {
    return "{\\"listening\\":true,\\"state\\":\\"Running\\",\\"localURL\\":\\"" + mockLocalUrl + "\\",\\"path\\":\\"direct\\"}";
  }
  public static void nativeStop(int h) {}
  public static String safeIdentity() { if (!available) throw new IllegalStateException("down"); return "{}"; }
  public static String safeStart(String cfg) { if (!available) throw new IllegalStateException("down"); return nativeStart(cfg); }
  public static String safeStatus(int h) { return available ? nativeStatus(h) : "{}"; }
  public static void safeStop(int h) {}
}`),
      writeOverride('android/util/Log.java', `package android.util;
public final class Log {
  public static int w(String t, String m) { return 0; }
  public static int w(String t, String m, Throwable tr) { return 0; }
  public static int d(String t, String m) { return 0; }
  public static int e(String t, String m) { return 0; }
}`),
      writeOverride('android/util/Base64.java', `package android.util;
public class Base64 {
  public static final int NO_WRAP = 2;
  public static final int DEFAULT = 0;
  public static String encodeToString(byte[] input, int flags) { return java.util.Base64.getEncoder().encodeToString(input); }
  public static byte[] decode(String str, int flags) { return java.util.Base64.getDecoder().decode(str); }
}`),
      writeOverride('android/util/DisplayMetrics.java', `package android.util;
public class DisplayMetrics { public float density = 2.0f; }`),
      writeOverride('android/util/TypedValue.java', `package android.util;
public class TypedValue { public static final int COMPLEX_UNIT_SP = 2; }`),
      writeOverride('android/os/Build.java', `package android.os;
public class Build {
  public static final String MANUFACTURER = "Google";
  public static final String MODEL = "Pixel";
  public static class VERSION { public static final int SDK_INT = 35; }
}`),
      writeOverride('android/os/SystemClock.java', `package android.os;
public class SystemClock {
  public static long elapsedRealtime() { return System.currentTimeMillis(); }
}`),
      writeOverride('android/os/Looper.java', `package android.os;
public class Looper {
  private static final Looper MAIN = new Looper();
  public static Looper getMainLooper() { return MAIN; }
}`),
      writeOverride('android/os/Handler.java', `package android.os;
public class Handler {
  public Handler(Looper l) {}
  public boolean post(Runnable r) { if (r != null) r.run(); return true; }
  public boolean postDelayed(Runnable r, long ms) { return true; }
  public void removeCallbacksAndMessages(Object token) {}
}`),
      writeOverride('android/graphics/Typeface.java', `package android.graphics;
public class Typeface { public static final Typeface DEFAULT_BOLD = new Typeface(); }`),
      writeOverride('android/graphics/drawable/Drawable.java', `package android.graphics.drawable;
public class Drawable {}`),
      writeOverride('android/graphics/drawable/GradientDrawable.java', `package android.graphics.drawable;
public class GradientDrawable extends Drawable {
  public void setColor(int c) {}
  public void setCornerRadius(float r) {}
  public void setStroke(int w, int c) {}
}`),
      writeOverride('android/os/LocaleList.java', `package android.os;
import java.util.Locale;
public class LocaleList {
  public boolean isEmpty() { return false; }
  public Locale get(int i) { return Locale.US; }
}`),
      writeOverride('android/content/res/Configuration.java', `package android.content.res;
import android.os.LocaleList;
public class Configuration {
  public static final int UI_MODE_NIGHT_MASK = 0x30;
  public static final int UI_MODE_NIGHT_YES = 0x20;
  public int uiMode = 0;
  public java.util.Locale locale = java.util.Locale.US;
  public LocaleList getLocales() { return new LocaleList(); }
}`),
      writeOverride('android/content/res/Resources.java', `package android.content.res;
import android.util.DisplayMetrics;
public class Resources {
  private final DisplayMetrics dm = new DisplayMetrics();
  private final Configuration cfg = new Configuration();
  public DisplayMetrics getDisplayMetrics() { return dm; }
  public Configuration getConfiguration() { return cfg; }
}`),
      writeOverride('android/view/Gravity.java', `package android.view;
public class Gravity { public static final int CENTER = 17; public static final int CENTER_VERTICAL = 16; }`),
      writeOverride('android/view/View.java', `package android.view;
import android.graphics.drawable.Drawable;
public class View {
  public static final int VISIBLE = 0;
  public static final int GONE = 8;
  private int vis = VISIBLE;
  public interface OnClickListener { void onClick(View v); }
  public View(android.content.Context ctx) {}
  public void setVisibility(int v) { this.vis = v; }
  public int getVisibility() { return vis; }
  public void setLayoutParams(ViewGroup.LayoutParams lp) {}
  public void setBackground(Drawable d) {}
  public void setBackgroundColor(int c) {}
  public void setPadding(int l, int t, int r, int b) {}
  public void setOnClickListener(OnClickListener l) {}
  public void setContentDescription(CharSequence cs) {}
  public void setMinimumHeight(int h) {}
  public void setClickable(boolean c) {}
  public void setFocusable(boolean f) {}
}`),
      writeOverride('android/view/ViewGroup.java', `package android.view;
public class ViewGroup extends View {
  public static class LayoutParams {
    public static final int MATCH_PARENT = -1;
    public static final int WRAP_CONTENT = -2;
    public LayoutParams(int w, int h) {}
  }
  public ViewGroup(android.content.Context ctx) { super(ctx); }
  public void addView(View v) {}
  public void removeAllViews() {}
  public void addView(View v, LayoutParams lp) {}
}`),
      writeOverride('android/widget/LinearLayout.java', `package android.widget;
import android.view.*;
public class LinearLayout extends ViewGroup {
  public static final int HORIZONTAL = 0;
  public static final int VERTICAL = 1;
  public static class LayoutParams extends ViewGroup.LayoutParams {
    public int topMargin, bottomMargin, leftMargin, rightMargin;
    public LayoutParams(int w, int h) { super(w, h); }
    public LayoutParams(int w, int h, float weight) { super(w, h); }
  }
  public LinearLayout(android.content.Context ctx) { super(ctx); }
  public void setOrientation(int o) {}
  public void setGravity(int g) {}
}`),
      writeOverride('android/widget/TextView.java', `package android.widget;
import android.graphics.Typeface;
public class TextView extends android.view.View {
  private CharSequence text = "";
  public TextView(android.content.Context ctx) { super(ctx); }
  public void setText(CharSequence t) { this.text = t != null ? t : ""; }
  public CharSequence getText() { return text; }
  public void setTextColor(int c) {}
  public void setTextSize(int u, float s) {}
  public void setTypeface(Typeface tf) {}
  public void setGravity(int g) {}
  public void setSingleLine(boolean s) {}
  public void setEllipsize(android.text.TextUtils.TruncateAt w) {}
}`),
      writeOverride('android/widget/ProgressBar.java', `package android.widget;
public class ProgressBar extends android.view.View {
  public ProgressBar(android.content.Context ctx) { super(ctx); }
}`),
      writeOverride('android/widget/ArrayAdapter.java', `package android.widget;
import android.database.DataSetObserver;
import android.view.*;
import java.util.*;
public class ArrayAdapter<T> implements SpinnerAdapter {
  public final List<T> items;
  public ArrayAdapter(android.content.Context ctx, int res, List<T> items) { this.items = new ArrayList<>(items); }
  @Override public View getDropDownView(int pos, View cv, ViewGroup p) { return null; }
  @Override public void registerDataSetObserver(DataSetObserver o) {}
  @Override public void unregisterDataSetObserver(DataSetObserver o) {}
  @Override public int getCount() { return items.size(); }
  @Override public T getItem(int pos) { return items.get(pos); }
  @Override public long getItemId(int pos) { return pos; }
  @Override public boolean hasStableIds() { return false; }
  @Override public View getView(int pos, View cv, ViewGroup p) { return null; }
  @Override public int getItemViewType(int pos) { return 0; }
  @Override public int getViewTypeCount() { return 1; }
  @Override public boolean isEmpty() { return items.isEmpty(); }
}`),
      writeOverride('android/widget/Spinner.java', `package android.widget;
public class Spinner extends android.view.View {
  public SpinnerAdapter adapter;
  public int selection = 0;
  public Spinner(android.content.Context ctx) { super(ctx); }
  public void setAdapter(SpinnerAdapter a) { this.adapter = a; }
  public void setSelection(int pos, boolean animate) { this.selection = pos; }
}`),
      writeOverride('android/content/pm/Signature.java', `package android.content.pm;
public class Signature {
  private final byte[] bytes;
  public Signature(byte[] bytes) { this.bytes = bytes; }
  public byte[] toByteArray() { return bytes; }
}`),
      writeOverride('android/content/pm/SigningInfo.java', `package android.content.pm;
public class SigningInfo {
  public Signature[] sigs;
  public boolean hasMultipleSigners() { return false; }
  public Signature[] getApkContentsSigners() { return sigs; }
  public Signature[] getSigningCertificateHistory() { return sigs; }
}`),
      writeOverride('android/content/pm/PackageInfo.java', `package android.content.pm;
public class PackageInfo {
  public String packageName;
  public String versionName;
  public int versionCode;
  public SigningInfo signingInfo;
  public Signature[] signatures;
  public long getLongVersionCode() { return versionCode; }
}`),
      writeOverride('android/content/pm/PackageManager.java', `package android.content.pm;
public class PackageManager {
  public static final int GET_SIGNATURES = 64;
  public static final int GET_SIGNING_CERTIFICATES = 0x08000000;
  public PackageInfo installedInfo;
  public PackageInfo archiveInfo;
  public PackageInfo getPackageInfo(String pkg, int flags) { return installedInfo; }
  public PackageInfo getPackageArchiveInfo(String archiveFilePath, int flags) { return archiveInfo; }
  public boolean canRequestPackageInstalls() { return true; }
}`),
      writeOverride('android/content/pm/ApplicationInfo.java', `package android.content.pm;
public class ApplicationInfo { public String sourceDir; }`),
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
  public JSONObject put(String k, Object v) { if (v == null) map.remove(k); else map.put(k, v); return this; }
  public JSONObject put(String k, int v) { map.put(k, v); return this; }
  public JSONObject put(String k, long v) { map.put(k, v); return this; }
  public JSONObject put(String k, boolean v) { map.put(k, v); return this; }
  public boolean has(String k) { return map.containsKey(k); }
  public int length() { return map.size(); }
  public boolean isNull(String k) { return !map.containsKey(k) || map.get(k) == null || map.get(k) == NULL; }
  public String optString(String k, String d) { Object v = map.get(k); return v == null ? d : String.valueOf(v); }
  public String optString(String k) { return optString(k, ""); }
  public String getString(String k) { if (!has(k) || isNull(k)) throw new RuntimeException("Missing " + k); return String.valueOf(map.get(k)); }
  public long optLong(String k, long d) { Object v = map.get(k); return v instanceof Number ? ((Number) v).longValue() : d; }
  public long getLong(String k) { return ((Number) map.get(k)).longValue(); }
  public int optInt(String k, int d) { Object v = map.get(k); return v instanceof Number ? ((Number) v).intValue() : d; }
  public boolean optBoolean(String k, boolean d) { Object v = map.get(k); return v instanceof Boolean ? (Boolean) v : d; }
  public boolean getBoolean(String k) { Object v = map.get(k); if (!(v instanceof Boolean)) throw new RuntimeException("Missing boolean " + k); return (Boolean) v; }
  public JSONObject optJSONObject(String k) {
    Object v = map.get(k);
    if (v instanceof JSONObject) return (JSONObject) v;
    if (v instanceof Map) { @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) v; return new JSONObject(m); }
    return null;
  }
  public JSONObject getJSONObject(String k) { JSONObject o = optJSONObject(k); if (o == null) throw new RuntimeException("Missing " + k); return o; }
  public JSONArray optJSONArray(String k) {
    Object v = map.get(k);
    if (v instanceof JSONArray) return (JSONArray) v;
    if (v instanceof List) { @SuppressWarnings("unchecked") List<Object> l = (List<Object>) v; return new JSONArray(l); }
    return null;
  }
  public JSONArray getJSONArray(String k) { JSONArray a = optJSONArray(k); if (a == null) throw new RuntimeException("Missing " + k); return a; }
  public JSONArray names() { JSONArray a = new JSONArray(); for (String k : map.keySet()) a.put(k); return a.length() == 0 ? null : a; }
  @Override public String toString() { return MiniJson.stringify(map); }
}`),
      writeOverride('org/json/JSONArray.java', `package org.json;
import java.util.*;
public class JSONArray {
  final List<Object> list = new ArrayList<>();
  public JSONArray() {}
  public JSONArray(String json) {
    Object parsed = MiniJson.parse(json);
    if (!(parsed instanceof List)) throw new RuntimeException("Not JSON array");
    @SuppressWarnings("unchecked") List<Object> l = (List<Object>) parsed;
    list.addAll(l);
  }
  public JSONArray(Collection<?> c) { if (c != null) list.addAll(c); }
  JSONArray(List<Object> l) { list.addAll(l); }
  public int length() { return list.size(); }
  public JSONArray put(Object v) { list.add(v); return this; }
  public boolean isNull(int i) { if (i < 0 || i >= list.size()) return true; Object v = list.get(i); return v == null || v == JSONObject.NULL; }
  public JSONObject optJSONObject(int i) {
    if (i < 0 || i >= list.size()) return null;
    Object v = list.get(i);
    if (v instanceof JSONObject) return (JSONObject) v;
    if (v instanceof Map) { @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) v; return new JSONObject(m); }
    return null;
  }
  public String optString(int i, String d) { if (i < 0 || i >= list.size()) return d; Object v = list.get(i); return v == null ? d : String.valueOf(v); }
  public Object remove(int i) { return (i >= 0 && i < list.size()) ? list.remove(i) : null; }
  @Override public String toString() { return MiniJson.stringify(list); }
}`),
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
        if (!first) sb.append(','); first = false;
        sb.append(quote(String.valueOf(e.getKey()))).append(':').append(stringify(e.getValue()));
      }
      return sb.append('}').toString();
    }
    if (o instanceof Collection) {
      StringBuilder sb = new StringBuilder("[");
      boolean first = true;
      for (Object item : (Collection<?>) o) {
        if (!first) sb.append(','); first = false;
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
      ws(); char c = s.charAt(i);
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
}`),
    ];
    execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-cp', `${outClasses}:${androidJar}`, '-d', overrideClasses, ...ovFiles], { stdio: 'pipe' });

    const harnessJava = path.join(testSrc, 'RegressionHarness.java');
    fs.writeFileSync(harnessJava, `
import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.*;
import android.content.res.Resources;
import android.view.View;
import android.widget.*;
import dev.grokbot.local.TailcatBridge;
import dev.rokbot.nativeapp.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.security.*;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import sun.misc.Unsafe;

public class RegressionHarness {
  private static Unsafe unsafe;
  static {
    try { Field f = Unsafe.class.getDeclaredField("theUnsafe"); f.setAccessible(true); unsafe = (Unsafe) f.get(null); }
    catch (Exception e) { throw new RuntimeException(e); }
  }
  @SuppressWarnings("unchecked")
  private static <T> T alloc(Class<T> c) {
    try { return (T) unsafe.allocateInstance(c); } catch (Exception e) { throw new RuntimeException(e); }
  }
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
    @Override public boolean engineContainsAlias(String a) { return "rokbot-native-device-credential".equals(a); }
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
    Resources res = new Resources();
    @Override public Context getApplicationContext() { return this; }
    @Override public String getPackageName() { return "dev.rokbot.nativeapp"; }
    @Override public SharedPreferences getSharedPreferences(String name, int mode) { return prefs; }
    @Override public PackageManager getPackageManager() { return pm; }
    @Override public ApplicationInfo getApplicationInfo() { return appInfo; }
    @Override public File getFilesDir() { return filesDir; }
    @Override public Resources getResources() { return res; }
  }
  private static void check(boolean cond, String msg) { if (!cond) throw new AssertionError(msg); }
  private static Object getField(Object target, String name) throws Exception {
    Class<?> c = target.getClass();
    while (c != null) {
      try { Field f = c.getDeclaredField(name); f.setAccessible(true); return f.get(target); }
      catch (NoSuchFieldException ignored) { c = c.getSuperclass(); }
    }
    throw new NoSuchFieldException(name);
  }
  private static void setFieldSuper(Object target, String name, Object val) throws Exception {
    Class<?> c = target.getClass();
    while (c != null) {
      try { Field f = c.getDeclaredField(name); f.setAccessible(true); f.set(target, val); return; }
      catch (NoSuchFieldException ignored) { c = c.getSuperclass(); }
    }
    throw new NoSuchFieldException(name);
  }
  private static void setField(Object target, String name, Object val) throws Exception {
    setFieldSuper(target, name, val);
  }

  static class TestModelsActivity extends ModelsActivity {
    FakeApp baseApp;
    @Override public Context getApplicationContext() { return baseApp; }
    @Override public String getPackageName() { return baseApp.getPackageName(); }
    @Override public SharedPreferences getSharedPreferences(String name, int mode) { return baseApp.getSharedPreferences(name, mode); }
    @Override public PackageManager getPackageManager() { return baseApp.getPackageManager(); }
    @Override public ApplicationInfo getApplicationInfo() { return baseApp.getApplicationInfo(); }
    @Override public File getFilesDir() { return baseApp.getFilesDir(); }
    @Override public Resources getResources() { return baseApp.getResources(); }
  }

  public static void main(String[] args) throws Exception {
    String hostOrigin = args[0];
    String extOrigin = args[1];
    String token = args[2];
    String deviceId = args[3];
    String baseApkPath = args[4];
    String filesDirPath = args[5];
    String targetSha = args[6];
    byte[] certBytes = "test-signing-cert-der-bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    Security.insertProviderAt(new Provider("AndroidKeyStore", "1.0", "test") {{
      put("KeyStore.AndroidKeyStore", FakeKeyStoreSpi.class.getName());
    }}, 1);

    FakeApp app = alloc(FakeApp.class);
    app.prefs = new MemPrefs();
    app.res = new Resources();
    app.appInfo = new ApplicationInfo();
    app.appInfo.sourceDir = baseApkPath;
    app.filesDir = new File(filesDirPath);
    PackageManager pm = new PackageManager();
    PackageInfo installed = new PackageInfo();
    installed.packageName = "dev.rokbot.nativeapp";
    installed.versionName = "1.16.0";
    installed.versionCode = 1075;
    installed.signingInfo = new SigningInfo();
    installed.signingInfo.sigs = new android.content.pm.Signature[] { new android.content.pm.Signature(certBytes) };
    installed.signatures = installed.signingInfo.sigs;
    pm.installedInfo = installed;
    pm.archiveInfo = installed;
    app.pm = pm;

    Storage.init(app);
    Storage.setThemePreference(app, "light");
    Localize.setPreferredLanguage(app, Localize.LANG_EN);
    Storage.saveCredentials(app, token, hostOrigin, deviceId);

    // 1. AOSP JSONObject.NULL semantics + HostApiClient.extractErrorMessage
    JSONObject aospCheck = new JSONObject("{\\"error\\":null,\\"message\\":\\"Real Error Msg\\"}");
    check("null".equals(aospCheck.optString("error", "fallback")), "Shim must match AOSP optString returning literal null");
    HostApiClient.HttpResult errRes = HostApiClient.rawRequest(extOrigin + "/null-error", "GET", null, null, null, 5000, 5000, false);
    check(errRes.code == 400, "Expected 400 from /null-error");
    Method extractErr = HostApiClient.class.getDeclaredMethod("extractErrorMessage", int.class, byte[].class);
    extractErr.setAccessible(true);
    String extracted = (String) extractErr.invoke(null, errRes.code, errRes.body);
    check("Real Error Msg".equals(extracted), "extractErrorMessage must skip JSONObject.NULL and return message, got: " + extracted);

    // 2. ModelsActivity: top-level routingMigrated:true + configured:false + PUT /local/model migrateLegacyRouting:true
    TestModelsActivity ma = alloc(TestModelsActivity.class);
    ma.baseApp = app;
    setFieldSuper(ma, "mMain", new android.os.Handler(android.os.Looper.getMainLooper()));
    setFieldSuper(ma, "mPendingApiKeys", new HashMap<String, String>());
    setFieldSuper(ma, "mProfileIdsForChoice", new ArrayList<String>());
    setFieldSuper(ma, "mEffortOptionsForChoice", new ArrayList<String>());
    setFieldSuper(ma, "mOnboardingCard", new LinearLayout(app));
    setFieldSuper(ma, "mStepUpCard", new LinearLayout(app));
    setFieldSuper(ma, "mReloadBadge", new TextView(app));
    setFieldSuper(ma, "mStatusText", new TextView(app));
    setFieldSuper(ma, "mContinueBtn", new TextView(app));
    setFieldSuper(ma, "mDefaultProfileChoice", new ChoiceField(app));
    setFieldSuper(ma, "mDefaultEffortChoice", new ChoiceField(app));
    setFieldSuper(ma, "mProvidersContainer", new LinearLayout(app));
    setFieldSuper(ma, "mProfilesContainer", new LinearLayout(app));

    JSONObject getModelRes = HostApiClient.getModelConfig(app, null);
    Method applyServerResponse = ModelsActivity.class.getDeclaredMethod("applyServerResponse", JSONObject.class, boolean.class);
    applyServerResponse.setAccessible(true);
    applyServerResponse.invoke(ma, getModelRes, true);
    check(Boolean.TRUE.equals(getField(ma, "mRoutingMigrated")), "mRoutingMigrated must read top-level routingMigrated=true");
    check(Boolean.FALSE.equals(getField(ma, "mConfigured")), "mConfigured must read top-level configured=false");

    Method buildSavePayload = ModelsActivity.class.getDeclaredMethod("buildSavePayload");
    buildSavePayload.setAccessible(true);
    JSONObject migPayload = (JSONObject) buildSavePayload.invoke(ma);
    check(migPayload.optBoolean("migrateLegacyRouting", false), "buildSavePayload must include migrateLegacyRouting=true");
    JSONObject savedMig = HostApiClient.saveModelConfig(app, migPayload, null);
    check(savedMig.getBoolean("ok"), "saveModelConfig with migrateLegacyRouting=true must succeed (no 409)");

    // 3. efforts: [] (gpt-4o) + profile switch effort reset -> "default"
    JSONObject twoProfilesRes = new JSONObject()
        .put("ok", true)
        .put("configured", true)
        .put("routingMigrated", false)
        .put("config", new JSONObject()
            .put("version", 1)
            .put("providers", new JSONArray().put(new JSONObject()
                .put("id", "default").put("name", "OpenAI").put("apiFormat", "openai").put("baseUrl", "https://api.openai.com/v1").put("hasApiKey", true)))
            .put("profiles", new JSONArray()
                .put(new JSONObject().put("id", "pf_gpt5").put("name", "GPT-5").put("providerId", "default").put("model", "gpt-5").put("efforts", new JSONArray().put("low").put("high")))
                .put(new JSONObject().put("id", "pf_gpt4o").put("name", "GPT-4o").put("providerId", "default").put("model", "gpt-4o").put("efforts", new JSONArray())))
            .put("defaultRoute", new JSONObject().put("profileId", "pf_gpt5").put("effort", "high").put("fallbacks", new JSONArray()))
            .put("botRoutes", new JSONObject()))
        .put("reload", new JSONObject().put("status", "applied"));
    applyServerResponse.invoke(ma, twoProfilesRes, true);
    Method renderData = ModelsActivity.class.getDeclaredMethod("renderData");
    renderData.setAccessible(true);
    renderData.invoke(ma);

    // Switch default profile to pf_gpt4o (efforts: []) and call refreshEffortChoice
    JSONObject defRoute = (JSONObject) getField(ma, "mDefaultRoute");
    defRoute.put("profileId", "pf_gpt4o");
    Method refreshEffortChoice = ModelsActivity.class.getDeclaredMethod("refreshEffortChoice", String.class);
    refreshEffortChoice.setAccessible(true);
    refreshEffortChoice.invoke(ma, "pf_gpt4o");

    @SuppressWarnings("unchecked") List<String> effOpts = (List<String>) getField(ma, "mEffortOptionsForChoice");
    check(effOpts.size() == 1 && "default".equals(effOpts.get(0)), "efforts: [] must offer ONLY [default], got: " + effOpts);
    check("default".equals(defRoute.optString("effort", "")), "Switching to gpt-4o must reset mDefaultRoute.effort to default, got: " + defRoute.optString("effort", ""));
    JSONObject gpt4oPayload = (JSONObject) buildSavePayload.invoke(ma);
    JSONObject gpt4oSaved = HostApiClient.saveModelConfig(app, gpt4oPayload, null);
    check(gpt4oSaved.getBoolean("ok"), "Saving switched gpt-4o profile must succeed (no 400)");

    // 4. EXTRA_ONBOARDING mContinueBtn gating + profiles:[null] NPE guard + AOSP null effort
    setField(ma, "mOnboarding", true);
    twoProfilesRes.put("reload", new JSONObject().put("status", "waiting"));
    applyServerResponse.invoke(ma, twoProfilesRes, true);
    renderData.invoke(ma);
    TextView continueBtn = (TextView) getField(ma, "mContinueBtn");
    check(continueBtn.getVisibility() == View.GONE, "mContinueBtn must be GONE when reload.status == waiting");

    twoProfilesRes.put("reload", new JSONObject().put("status", "error").put("error", "Reload failed"));
    applyServerResponse.invoke(ma, twoProfilesRes, true);
    renderData.invoke(ma);
    check(continueBtn.getVisibility() == View.GONE, "mContinueBtn must be GONE when reload.status == error");

    twoProfilesRes.put("reload", new JSONObject().put("status", "applied"));
    twoProfilesRes.getJSONObject("config").getJSONObject("defaultRoute").put("effort", JSONObject.NULL);
    applyServerResponse.invoke(ma, twoProfilesRes, true);
    renderData.invoke(ma);
    check(continueBtn.getVisibility() == View.VISIBLE, "mContinueBtn must be VISIBLE when onboarding + configured + applied");
    check(((TextView) getField(ma, "mStatusText")).getText().toString().contains("effort=default"),
        "Null effort must display effort=default, got: " + ((TextView) getField(ma, "mStatusText")).getText());

    JSONObject nullProfRes = new JSONObject("{\\"ok\\":true,\\"config\\":{\\"version\\":1,\\"providers\\":[],\\"profiles\\":[null],\\"defaultRoute\\":null}}");
    applyServerResponse.invoke(ma, nullProfRes, true);
    boolean threwIllegalArg = false;
    try {
      buildSavePayload.invoke(ma);
    } catch (java.lang.reflect.InvocationTargetException ite) {
      check(ite.getCause() instanceof IllegalArgumentException,
          "profiles:[null] must throw IllegalArgumentException, NOT " + ite.getCause());
      threwIllegalArg = true;
    }
    check(threwIllegalArg, "Expected IllegalArgumentException for profiles:[null]");

    // 5. DeltaPatcher signed long overflow check
    File badOverflowDelta = new File(filesDirPath, "overflow.rbdelta");
    try (java.util.zip.GZIPOutputStream gz = new java.util.zip.GZIPOutputStream(new FileOutputStream(badOverflowDelta));
         DataOutputStream dos = new DataOutputStream(gz)) {
      dos.write("RBDELTA1".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
      dos.writeLong(new File(baseApkPath).length());
      dos.writeLong(100L);
      dos.writeInt(1);
      dos.write(new byte[16]);
      dos.writeByte(0x01); // OP_COPY
      dos.writeLong(Long.MAX_VALUE - 5L);
      dos.writeInt(100);
      dos.writeByte(0x00);
    }
    File overflowOut = new File(filesDirPath, "overflow-out.apk");
    boolean threwBounds = false;
    try {
      DeltaPatcher.apply(new File(baseApkPath), badOverflowDelta, overflowOut, null);
    } catch (IOException ioe) {
      check(ioe.getMessage() != null && ioe.getMessage().contains("OP_COPY out of base bounds"),
          "Expected explicit OP_COPY out of base bounds error, got: " + ioe.getMessage());
      threwBounds = true;
    }
    check(threwBounds && !overflowOut.exists(), "OP_COPY overflow must fail cleanly and delete outFile");

    // 6. UpdateManager: format:null delta + external /local/updates/android.json collision + Tailcat-down guard
    CountDownLatch fmtNullLatch = new CountDownLatch(1);
    AtomicReference<UpdateManager.UpdateManifestInfo> fmtNullInfo = new AtomicReference<>();
    AtomicReference<String> fmtNullErr = new AtomicReference<>();
    UpdateManager.checkManifestAsync(app, hostOrigin + "/local/updates/android.json", new UpdateManager.CheckCallback() {
      @Override public void onUpToDate(String c, String s) { fmtNullErr.set("unexpected uptodate"); fmtNullLatch.countDown(); }
      @Override public void onUpdateAvailable(UpdateManager.UpdateManifestInfo info) { fmtNullInfo.set(info); fmtNullLatch.countDown(); }
      @Override public void onError(String m) { fmtNullErr.set(m); fmtNullLatch.countDown(); }
    });
    check(fmtNullLatch.await(10, TimeUnit.SECONDS) && fmtNullErr.get() == null, "format:null manifest check failed: " + fmtNullErr.get());
    check(fmtNullInfo.get() != null && fmtNullInfo.get().hasDelta, "format:null delta must be accepted as RBDELTA1");

    // Switch Storage to Tailcat mode pointing to hostOrigin with reportedGatewayUrl = https://host.example
    TailcatBridge.available = true;
    TailcatBridge.mockLocalUrl = hostOrigin;
    Storage.saveTailcatCredentials(app, token, "tailcat://connect/tcABCDEFGHIJKLMNOPQRSTUVWXYZ123456?port=8000", deviceId, "{}", "https://host.example");

    String collidingExtUrl = extOrigin + "/local/updates/android.json";
    check(!UpdateManager.isPairedHostUrl(app, collidingExtUrl), "External URL colliding on /local/updates/android.json must NOT match paired Host");
    check(UpdateManager.isPairedHostUrl(app, "https://host.example/local/updates/android.json"), "reportedGatewayUrl origin must match paired Host");
    check(UpdateManager.isPairedHostUrl(app, "/local/updates/android.json"), "Relative /local/updates/android.json must match paired Host");

    // With Tailcat active, colliding external URL must route via Host /local/updates/fetch?url=... and never receive Bearer token
    CountDownLatch extLatch = new CountDownLatch(1);
    AtomicReference<String> extErr = new AtomicReference<>();
    UpdateManager.checkManifestAsync(app, collidingExtUrl, new UpdateManager.CheckCallback() {
      @Override public void onUpToDate(String c, String s) { extErr.set("unexpected uptodate"); extLatch.countDown(); }
      @Override public void onUpdateAvailable(UpdateManager.UpdateManifestInfo info) { extLatch.countDown(); }
      @Override public void onError(String m) { extErr.set(m); extLatch.countDown(); }
    });
    check(extLatch.await(10, TimeUnit.SECONDS), "colliding external check timed out");
    check(extErr.get() != null && extErr.get().contains("Malformed update manifest"),
        "External response must reach external server via proxy (and fail manifest validation), got: " + extErr.get());

    // With Tailcat DOWN, fetching paired reportedGatewayUrl must throw "Paired Host unavailable" and NEVER send Bearer token
    TailcatManager.get().clear();
    TailcatBridge.available = false;
    TailcatBridge.mockLocalUrl = "";
    CountDownLatch downLatch = new CountDownLatch(1);
    AtomicReference<String> downErr = new AtomicReference<>();
    UpdateManager.checkManifestAsync(app, "https://host.example/local/updates/android.json", new UpdateManager.CheckCallback() {
      @Override public void onUpToDate(String c, String s) { downErr.set("unexpected uptodate"); downLatch.countDown(); }
      @Override public void onUpdateAvailable(UpdateManager.UpdateManifestInfo info) { downErr.set("unexpected available"); downLatch.countDown(); }
      @Override public void onError(String m) { downErr.set(m); downLatch.countDown(); }
    });
    check(downLatch.await(10, TimeUnit.SECONDS), "Tailcat-down check timed out");
    check("Paired Host unavailable".equals(downErr.get()),
        "Tailcat-down paired Host fetch must throw Paired Host unavailable, got: " + downErr.get());

    System.out.println("REGRESSION_HARNESS_OK");
  }
}
`);
    execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-cp', `${overrideClasses}:${outClasses}:${androidJar}`, '-d', testClasses, harnessJava], { stdio: 'pipe' });

    const reqBefore = host.requestLogs.length;
    const runOut = await new Promise((resolve, reject) => {
      const child = spawn(javaBin, [
        '-cp', `${overrideClasses}:${testClasses}:${outClasses}:${androidJar}`,
        'RegressionHarness',
        host.origin,
        extOrigin,
        paired.token,
        paired.deviceId,
        baseApkPath,
        filesDir,
        sha256Hex(targetApkBytes),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`RegressionHarness timed out: ${stderr || stdout}`)); }, 15000);
      child.stdout.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf8'); });
      child.on('error', err => { clearTimeout(timer); reject(err); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`RegressionHarness exited ${code}: ${stderr}\n${stdout}`));
        else resolve(stdout);
      });
    });
    assert.ok(runOut.includes('REGRESSION_HARNESS_OK'), `Unexpected regression output: ${runOut}`);

    // Verify external server saw proxied request with NO Authorization header
    const extUpdateHit = extLogs.find(l => l.url?.startsWith('/local/updates/android.json'));
    assert.ok(extUpdateHit, 'External server must have been queried via Host proxy');
    assert.equal(extUpdateHit.auth, null, 'External server must NEVER receive paired Host Bearer token');
    const proxyHits = host.requestLogs.slice(reqBefore).filter(r => r.pathname === '/local/updates/fetch');
    assert.ok(proxyHits.length >= 1, 'Colliding external /local/updates/android.json must route through /local/updates/fetch');
  } finally {
    await host.stop();
    await new Promise(resolve => extServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

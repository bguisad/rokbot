// In-place upgrades must not keep running the previous build's RN bundle.
// files/RokBotPaired/index.android.bundle (generated from gateway-template at pairing) and
// files/RokBotUnpaired/unpaired.hbc survive `adb install -r` and the in-app updater, so they are
// keyed on the install (template SHA-256 + versionCode + lastUpdateTime), not just url + token.
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

test('Bundle refresh wiring: paired and unpaired bundles are keyed on the install, pairing is kept', () => {
  const boot = read('RokBotBootstrap.java');
  const body = boot.slice(boot.indexOf('public static synchronized File ensurePairedBundleFile(Context context, boolean force)'));
  const fn = body.slice(0, body.indexOf('\n    }\n') + 6);
  assert.match(fn, /String expectedMeta = HermesPatcher\.pairedBundleMeta\(url, token, HermesPatcher\.installStamp\(context\)\);/);
  assert.match(fn, /HermesPatcher\.isBundleCurrent\(pairedBundle, metaFile, expectedMeta\)/);
  assert.doesNotMatch(fn, /expectedMeta = url \+ "\\n" \+ token;/, 'legacy url+token-only meta is gone');
  assert.doesNotMatch(fn, /Storage\.(clear|set|remove)|clearPairedBundle/, 'a stale bundle never touches the pairing');

  const hp = read('HermesPatcher.java');
  assert.match(hp, /ensureUnpairedBundle\(outDir, installStamp\(context\), /);
  assert.match(hp, /optString\("templateSha256", ""\)/);
  assert.match(hp, /pi\.lastUpdateTime/);
  // Both onAppCreate and the ReactNativeHost wrapper go through the checked paths.
  assert.match(boot, /if \(Storage\.isPaired\(app\)\) \{\s*ensurePairedBundleFile\(app\);\s*\} else \{\s*ensureUnpairedBundleFile\(app\);/);
  const wrapper = fs.readFileSync(path.join(SRC, 'ReactHostWrapper.java'), 'utf8');
  assert.match(wrapper, /RokBotBootstrap\.ensurePairedBundleFile\(app\)/);
  assert.match(wrapper, /RokBotBootstrap\.ensureUnpairedBundleFile\(app\)/);
});

test('Bundle refresh (JVM): stale paired meta and unpaired copies from an older install are regenerated', () => {
  const sdkRoot = [process.env.ANDROID_HOME, '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
    .find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  assert.ok(sdkRoot && javacBin, 'Android SDK and JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-bundle-refresh-'));
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
    const harness = path.join(harnessDir, 'BundleRefreshHarness.java');
    fs.writeFileSync(harness, `package dev.rokbot.nativeapp;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class BundleRefreshHarness {
    static void check(boolean c, String m) { if (!c) throw new AssertionError(m); }
    static void write(File f, String s) throws Exception {
        f.getParentFile().mkdirs();
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(s.getBytes(StandardCharsets.UTF_8)); }
    }
    static String readStr(File f) throws Exception { return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }
    static int reads = 0;

    public static void main(String[] a) throws Exception {
        File root = new File(a[0]);
        String url = "http://127.0.0.1:19191", token = "tok_abc";
        String oldTpl = "AAAA", newTpl = "BBBB";

        String s1 = HermesPatcher.bundleStamp(oldTpl, 321201, 1000L);
        check(s1.equals(HermesPatcher.bundleStamp(" aaaa ", 321201, 1000L)), "template sha is normalised");
        check(!s1.equals(HermesPatcher.bundleStamp(newTpl, 321201, 1000L)), "template sha changes the stamp");
        check(!s1.equals(HermesPatcher.bundleStamp(oldTpl, 321202, 1000L)), "versionCode changes the stamp");
        check(!s1.equals(HermesPatcher.bundleStamp(oldTpl, 321201, 2000L)), "reinstall (lastUpdateTime) changes the stamp");

        // Paired: a bundle generated by an older build (meta = url + "\\\\n" + token) is stale.
        File paired = new File(root, "RokBotPaired");
        File bundle = new File(paired, "index.android.bundle");
        File meta = new File(paired, ".bundle-meta");
        write(bundle, "OLD-BUNDLE");
        write(meta, url + "\\n" + token);
        String expected = HermesPatcher.pairedBundleMeta(url, token, HermesPatcher.bundleStamp(newTpl, 321202, 2000L));
        check(!HermesPatcher.isBundleCurrent(bundle, meta, expected), "legacy url+token meta must be stale after upgrade");
        HermesPatcher.writeAtomically(meta, expected.getBytes(StandardCharsets.UTF_8));
        check(HermesPatcher.isBundleCurrent(bundle, meta, expected), "same install + pairing reuses the bundle");
        check(!new File(paired, ".bundle-meta.tmp").exists(), "atomic write leaves no tmp file");
        String upgraded = HermesPatcher.pairedBundleMeta(url, token, HermesPatcher.bundleStamp(newTpl, 321203, 3000L));
        check(!HermesPatcher.isBundleCurrent(bundle, meta, upgraded), "next upgrade invalidates again");
        check(!HermesPatcher.isBundleCurrent(bundle, meta, HermesPatcher.pairedBundleMeta(url, "tok_new", HermesPatcher.bundleStamp(newTpl, 321202, 2000L))), "re-pair still invalidates");
        write(bundle, "");
        check(!HermesPatcher.isBundleCurrent(bundle, meta, expected), "empty bundle is never current");
        check(!HermesPatcher.isBundleCurrent(new File(paired, "missing"), meta, expected), "missing bundle is never current");

        // Unpaired: the copy written by an older install (no stamp file) is replaced.
        File unpairedDir = new File(root, "RokBotUnpaired");
        File unpaired = new File(unpairedDir, "unpaired.hbc");
        write(unpaired, "OLD-UNPAIRED");
        String us1 = HermesPatcher.bundleStamp(newTpl, 321202, 2000L);
        File got = HermesPatcher.ensureUnpairedBundle(unpairedDir, us1, () -> { reads++; return "NEW-UNPAIRED".getBytes(StandardCharsets.UTF_8); });
        check(got.equals(unpaired) && readStr(unpaired).equals("NEW-UNPAIRED"), "legacy unpaired copy replaced");
        check(readStr(new File(unpairedDir, HermesPatcher.UNPAIRED_STAMP_FILE)).equals(us1), "stamp written");
        HermesPatcher.ensureUnpairedBundle(unpairedDir, us1, () -> { reads++; return "X".getBytes(StandardCharsets.UTF_8); });
        check(reads == 1 && readStr(unpaired).equals("NEW-UNPAIRED"), "same install does not re-copy");
        HermesPatcher.ensureUnpairedBundle(unpairedDir, HermesPatcher.bundleStamp(newTpl, 321203, 3000L), () -> { reads++; return "NEWER".getBytes(StandardCharsets.UTF_8); });
        check(reads == 2 && readStr(unpaired).equals("NEWER"), "upgrade re-copies");
        System.out.println("BUNDLE_REFRESH_OK");
    }
}
`);
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-cp', androidJar, '-d', out, ...files, harness], { stdio: 'pipe' });
    const res = cp.execFileSync(javaBin, ['-cp', `${out}:${androidJar}`, 'dev.rokbot.nativeapp.BundleRefreshHarness', path.join(tmp, 'files')], { encoding: 'utf8' });
    assert.ok(res.includes('BUNDLE_REFRESH_OK'), res);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

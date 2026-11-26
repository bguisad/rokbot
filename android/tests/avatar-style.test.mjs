// Bot avatar style: one persisted, synchronously cached source for every Bot icon, and no frame
// that draws the official mark while a RokBot style is picked (regression: OPPO rokbot.7 / 321207,
// the official fluid orb flashed back on cold start, new screens, list rows and running Bots).
// - RokBotAvatarStyle (plain JVM) is the single source: persistence, first read, "official" only
//   when picked, release / re-apply policy.
// - RokBotAvatarManager replaces marks before every frame (pre-draw), keeps overlays across a
//   missed scan and gates on stored credentials rather than a Keystore decrypt.
// - Every native entry (share sheet, notifications, style picker) reads the same source.
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
const body = (src, signature) => {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${signature}`);
};

const HARNESS = `package dev.rokbot.nativeapp;
import java.util.*;
public class AvatarStyleHarness {
  static final class MapStore implements RokBotAvatarStyle.Store {
    final Map<String, String> map = new HashMap<>();
    int reads, writes; boolean failNextRead;
    public String read(String key) { reads++; if (failNextRead) { failNextRead = false; throw new IllegalStateException("io"); } return map.get(key); }
    public void write(String key, String value) { writes++; map.put(key, value); }
  }
  static final List<String> out = new ArrayList<>();
  static void check(String name, boolean ok) { out.add((ok ? "ok " : "FAIL ") + name); }
  public static void main(String[] a) {
    // Persistence: a pick is written through and survives a new process.
    MapStore s = new MapStore();
    RokBotAvatarStyle.resetForTest();
    check("default before any pick is chassis", "chassis".equals(RokBotAvatarStyle.current(s)));
    check("select antenna", RokBotAvatarStyle.select(s, "antenna"));
    check("written to avatarStyle", "antenna".equals(s.map.get("avatarStyle")));
    check("in effect at once", "antenna".equals(RokBotAvatarStyle.current(s)));
    RokBotAvatarStyle.resetForTest();
    check("new process reads the pick", "antenna".equals(RokBotAvatarStyle.current(s)));

    // First frame: the very first read answers the stored style synchronously, then from memory.
    MapStore cold = new MapStore(); cold.map.put("avatarStyle", "visor");
    RokBotAvatarStyle.resetForTest();
    String first = RokBotAvatarStyle.current(cold);
    for (int i = 0; i < 1000; i++) RokBotAvatarStyle.current(cold);
    check("first read is the stored style", "visor".equals(first));
    check("one store read for 1001 frames", cold.reads == 1);

    // Never official unless picked.
    for (String raw : new String[] { null, "", "fluid", "OFFICIAL", " official" }) {
      MapStore bad = new MapStore(); if (raw != null) bad.map.put("avatarStyle", raw);
      RokBotAvatarStyle.resetForTest();
      check("stored [" + raw + "] -> chassis", "chassis".equals(RokBotAvatarStyle.current(bad)));
    }
    MapStore flaky = new MapStore(); flaky.map.put("avatarStyle", "pixel"); flaky.failNextRead = true;
    RokBotAvatarStyle.resetForTest();
    check("failed read -> default, not official", "chassis".equals(RokBotAvatarStyle.current(flaky)));
    check("failed read is not cached", "pixel".equals(RokBotAvatarStyle.current(flaky)));
    RokBotAvatarStyle.resetForTest();
    check("unknown pick rejected", !RokBotAvatarStyle.select(s, "bogus") && !RokBotAvatarStyle.select(s, null));
    check("rejected pick keeps the stored one", "antenna".equals(RokBotAvatarStyle.current(s)));
    check("official only after picking it", !RokBotAvatarStyle.isOfficial(RokBotAvatarStyle.current(s)));
    check("select official", RokBotAvatarStyle.select(s, "official"));
    check("official in effect", RokBotAvatarStyle.isOfficial(RokBotAvatarStyle.current(s)));
    RokBotAvatarStyle.resetForTest();
    check("official survives a new process", RokBotAvatarStyle.isOfficial(RokBotAvatarStyle.current(s)));

    // Release policy: one (or two) missed scans never give the official views back.
    check("miss 1 keeps overlay", !RokBotAvatarStyle.shouldRelease(false, true, 1));
    check("miss 2 keeps overlay", !RokBotAvatarStyle.shouldRelease(false, true, 2));
    check("miss 3 releases", RokBotAvatarStyle.shouldRelease(false, true, 3));
    check("views left the host -> release at once", RokBotAvatarStyle.shouldRelease(false, false, 1));
    check("official picked -> release at once", RokBotAvatarStyle.shouldRelease(true, true, 1));

    // Pre-draw: apply new / still-visible / resized marks, skip covered ones.
    check("new mark applied", RokBotAvatarStyle.needsApply(false, true, false));
    check("visible official view applied", RokBotAvatarStyle.needsApply(true, true, false));
    check("resized host re-applied", RokBotAvatarStyle.needsApply(true, false, true));
    check("covered mark skipped", !RokBotAvatarStyle.needsApply(true, false, false));
    for (String line : out) System.out.println(line);
  }
}
`;

test('avatar style (JVM): persisted, first read synchronous, official only when picked, release policy', () => {
  const src = read('RokBotAvatarStyle.java');
  assert.doesNotMatch(src, /^import android\./m, 'RokBotAvatarStyle stays JVM-only');
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  assert.ok(javacBin, 'JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-avatar-style-'));
  try {
    const harness = path.join(tmp, 'AvatarStyleHarness.java');
    fs.writeFileSync(harness, HARNESS);
    const outDir = path.join(tmp, 'out');
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-d', outDir,
      path.join(SRC, 'RokBotAvatarStyle.java'), harness], { stdio: 'pipe' });
    const res = cp.execFileSync(javaBin, ['-cp', outDir, 'dev.rokbot.nativeapp.AvatarStyleHarness'], { encoding: 'utf8' });
    const lines = res.trim().split('\n');
    assert.ok(lines.length >= 25, `harness ran (${lines.length} checks)`);
    const failed = lines.filter(l => !l.startsWith('ok '));
    assert.deepEqual(failed, [], 'every style check passes');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('avatar style: one source, preloaded at Application start, shared by every entry', () => {
  const style = read('RokBotAvatarStyle.java');
  const manager = read('RokBotAvatarManager.java');
  const renderer = read('RokBotAvatarRenderer.java');
  // The style ids are RokBotAvatarStyle's, in the picker's order.
  const ids = style.match(/static final String\[\] IDS = \{ ([^}]+) \};/)[1].split(',').map(s => s.trim());
  assert.deepEqual(ids, ['CHASSIS', 'ANTENNA', 'VISOR', 'PIXEL', 'ORB', 'OFFICIAL']);
  for (const id of ids) assert.match(renderer, new RegExp(`static final String STYLE_${id} = RokBotAvatarStyle\\.${id};`));
  const stylesArray = renderer.slice(renderer.indexOf('static final StyleInfo[] STYLES'), renderer.indexOf('};', renderer.indexOf('static final StyleInfo[] STYLES')));
  assert.deepEqual([...stylesArray.matchAll(/new StyleInfo\(STYLE_(\w+),/g)].map(m => m[1]), ids, 'picker lists every style once');
  assert.match(body(renderer, 'static boolean isValidStyle(String style)'), /return RokBotAvatarStyle\.isValid\(style\);/);
  assert.match(style, /static final String DEFAULT = CHASSIS;/, 'default is a RokBot style, never official');

  // Manager: get / set / preload all go through RokBotAvatarStyle.
  assert.match(body(manager, 'static String getStyle(Context context)'), /return RokBotAvatarStyle\.current\(/);
  assert.match(body(manager, 'static void setStyle(Context context, String styleId)'), /RokBotAvatarStyle\.select\(new PrefStore\(context\), styleId\)/);
  assert.match(body(manager, 'static void preload(Context context)'), /getStyle\(context\);/);
  const boot = read('RokBotBootstrap.java');
  const init = body(boot, 'public static synchronized void init(Application app)');
  const storageInit = init.indexOf('Storage.init(app);');
  const preload = init.indexOf('RokBotAvatarManager.preload(app);');
  assert.ok(storageInit >= 0 && preload > storageInit, 'style preloaded right after Storage.init');
  assert.ok(preload < init.indexOf('registerActivityLifecycleCallbacks'), 'before any Activity callback');

  // Only RokBotAvatarStyle knows the preference key; no entry reads it on its own.
  for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.java') && f !== 'RokBotAvatarStyle.java')) {
    const src = read(file);
    assert.doesNotMatch(src, /"avatarStyle"/, `${file} does not read the avatarStyle preference directly`);
    assert.doesNotMatch(src, /getStringPref\([^)]*RokBotAvatar\w*\.PREF_KEY/, `${file} does not bypass the cached style`);
  }
  assert.doesNotMatch(manager, /getStringPref\([^)]*PREF_KEY/, 'the manager reads the style only through RokBotAvatarStyle');
  // Native entries: share sheet (makeView), notification large icons (render), the style picker.
  const avatars = read('RokBotAvatars.java');
  assert.match(body(avatars, 'static Bitmap render(Context context, Look look, int sizePx)'), /RokBotAvatarManager\.getStyle\(context\)/);
  assert.match(body(avatars, 'static View makeView(Context context, Look look, int sizeDp, UiChrome.Palette p)'), /RokBotAvatarManager\.getStyle\(context\)/);
  const notif = read('NotificationService.java');
  assert.match(notif, /RokBotAvatars\.render\(context, look, size\)/, 'notification large icon uses the shared renderer');
  assert.match(read('ShareTargetActivity.java'), /RokBotAvatars\.makeView\(/, 'share sheet uses the shared view');
  // The picker lives on its own page since the settings layout change.
  const picker = read('AvatarStyleActivity.java');
  assert.match(picker, /RokBotAvatarManager\.getStyle\(this\)/, 'picker shows the style in effect');
  assert.match(picker, /RokBotAvatarManager\.setStyle\(this, info\.id\)|RokBotAvatarManager\.setStyle\(this, styleId\)/, 'picker writes through the manager');
});

test('avatar manager: official marks are replaced before the frame that would draw them', () => {
  const m = read('RokBotAvatarManager.java');
  // A pre-draw listener on every React window runs the per-frame pass and lets the frame proceed.
  const resumed = body(m, 'static void onReactResumed(Activity activity)');
  assert.match(resumed, /vto\.addOnPreDrawListener\(\(\) -> \{\s*applyBeforeFrame\(owner\.get\(\)\);\s*return true;\s*\}\);/);
  assert.ok(resumed.indexOf('addOnPreDrawListener') > resumed.indexOf('decor.getTag(TAG_HOOK_INSTALLED) == null'), 'installed once per decor');

  const pass = body(m, 'static void applyBeforeFrame(Activity activity)');
  assert.match(pass, /scanAppMarks\(activity, root, gen, 0, true\);/);
  assert.match(pass, /scanTree\(activity, root, style, isDark\(activity\), gen, 0, true\);/);
  assert.match(pass, /catch \(Throwable t\)/, 'a failing pass never breaks the frame');
  assert.doesNotMatch(pass, /release\(|\+\+sGeneration|it\.remove/, 'the per-frame pass never gives official views back');

  // Every kind of mark is applied by the pre-draw pass unless it is already covered.
  for (const sig of ['private static void applyStill(', 'private static void applyAnimated(', 'private static void applyShapeCell(']) {
    const fn = body(m, sig);
    assert.match(fn, /boolean fast\)/, `${sig} takes the fast flag`);
    assert.match(fn, /if \(fast && covered\(/, `${sig} skips covered marks in the pre-draw pass`);
    assert.match(fn, /entryFor\([a-z]+, gen, fast\)/);
    assert.match(fn, /hide\(e, /, `${sig} hides the official view in the same call`);
  }
  assert.match(body(m, 'private static boolean covered('), /RokBotAvatarStyle\.needsApply\(/);
  assert.match(body(m, 'private static Entry entryFor('), /if \(!fast\) e\.generation = gen;/, 'only full scans mark entries as found');
});

test('avatar manager: a missed scan or a failed Keystore read never restores the official marks', () => {
  const m = read('RokBotAvatarManager.java');
  const full = body(m, 'static void applyToActivity(Activity activity)');
  assert.match(full, /RokBotAvatarStyle\.shouldRelease\(!on, stillShown\(e\.getKey\(\), en\.hidden\), en\.misses\)/);
  assert.match(full, /RokBotAvatarStyle\.shouldRelease\(false, stillShown\(e\.getKey\(\), le\.hidden\), le\.misses\)/, 'app logos too');
  assert.match(full, /en\.misses = 0;/);
  assert.match(full, /en\.misses\+\+;/);
  assert.equal((full.match(/release\(e\.getKey\(\), en\)/g) || []).length, 1, 'release only behind the policy');
  // Pairing gate reads stored credentials; the token decrypt can fail transiently.
  assert.doesNotMatch(m, /Storage\.isPaired\(/);
  assert.match(body(m, 'private static boolean stylesOn(Context context, String style)'),
    /!RokBotAvatarStyle\.isOfficial\(style\) && Storage\.hasStoredCredentials\(context\)/);
  const storage = read('Storage.java');
  const creds = body(storage, 'public static boolean hasStoredCredentials(Context context)');
  assert.doesNotMatch(creds, /open\(|getToken\(|Cipher|KeyStore/, 'no decrypt in the per-frame gate');
  assert.match(creds, /getString\("token", null\)/);
  assert.match(creds, /getString\("gatewayUrl", null\)/);
  // A host that left the window releases at once (closed screen, recycled row).
  assert.match(body(m, 'private static boolean stillShown('), /host\.isAttachedToWindow\(\)/);
});

// The Android 12+ system splash icon (windowSplashScreenAnimatedIcon = @drawable/splashscreen_logo).
// The official 1.26.0 XAPK ships it only as a 108 px mdpi bitmap, which Android stretched to the
// 288 dp splash box: a blurry first logo, then React Native's sharp launch-mark (the RokBot 64 dp
// tile). The patched APK ships the same 64 dp tile at mdpi and xxxhdpi (light and night) as a
// two-frame animated WebP, so the system splash draws it live at full resolution and both stages
// are the same picture.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { addFileResourceDensity, findResourceId, mergeResourcesArsc } from '../patchers/arsc.mjs';
import { entryBytes } from '../patchers/signing.mjs';
import { normalizeApkOrXapk } from '../patchers/xapk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SPLASH_DIR = path.join(ROOT, 'assets/logo/android/splash');

function resolveXapk() {
  if (process.env.ROKBOT_ANDROID_TEST_XAPK !== undefined) {
    const p = process.env.ROKBOT_ANDROID_TEST_XAPK.trim();
    return p && fs.existsSync(p) ? p : null;
  }
  return [
    path.join(ROOT, 'inputs/android/grok-bot-1.26.0.xapk'),
    '/Volumes/ORICO/grokbot/inputs/android/grok-bot-1.26.0.xapk',
    path.join(process.env.HOME || '', '.cache/rokbot-inputs/grok-bot-1.26.0.xapk'),
  ].find(p => fs.existsSync(p)) || null;
}
const XAPK = resolveXapk();
const skip = !XAPK && 'Official grok-bot-1.26.0.xapk not found; set ROKBOT_ANDROID_TEST_XAPK';

/** WebP RIFF chunk walk: { width, height, frames, animated, alpha }. */
function webpInfo(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  const out = { frames: 0, animated: false, alpha: false };
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'VP8X') {
      const flags = buf[p + 8];
      out.animated = Boolean(flags & 0x02);
      out.alpha = Boolean(flags & 0x10);
      out.width = 1 + buf.readUIntLE(p + 12, 3);
      out.height = 1 + buf.readUIntLE(p + 15, 3);
    }
    if (id === 'ANMF') out.frames++;
    p += 8 + size + (size & 1);
  }
  return out;
}

test('Splash assets: 288 dp box at mdpi and xxxhdpi, animated (two frames) with alpha', () => {
  for (const [density, side] of [['mdpi', 288], ['xxxhdpi', 1152]]) {
    const info = webpInfo(fs.readFileSync(path.join(SPLASH_DIR, `splashscreen_logo-${density}.webp`)));
    assert.deepEqual(info, { frames: 2, animated: true, alpha: true, width: side, height: side }, density);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/logo/manifest.json'), 'utf8'));
  const splash = manifest.androidSplash;
  assert.deepEqual(splash.map(e => [e.density, e.width, e.frames]), [['mdpi', 288, 2], ['xxxhdpi', 1152, 2]]);
  for (const e of splash) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, e.path))).digest('hex');
    assert.equal(sha, e.sha256, `${e.path} matches the manifest (regenerate with assets/logo/generate_icons.py)`);
  }
  const gen = fs.readFileSync(path.join(ROOT, 'assets/logo/generate_icons.py'), 'utf8');
  assert.match(gen, /ANDROID_SPLASH_BOX_DP = 288/);
  assert.match(gen, /ANDROID_SPLASH_TILE_DP = 64/, 'the launch-mark tile size React Native shows next');
});

test('Patched 1.26.0 APK: splashscreen_logo has sharp xxxhdpi configs (light and night), all .webp', { skip }, async () => {
  const { patchLauncherIcons } = await import('../release/patch-android.mjs');
  const { entries } = normalizeApkOrXapk(fs.readFileSync(XAPK));
  const before = entries.find(e => e.name === 'resources.arsc');
  const splashId = findResourceId(entryBytes(before), 'drawable', 'splashscreen_logo');
  assert.ok(splashId, 'official splash drawable');
  const official = entries.filter(e => /\/splashscreen_logo\.png$/.test(e.name)).map(e => e.name).sort();
  assert.deepEqual(official, ['res/drawable-mdpi-v4/splashscreen_logo.png', 'res/drawable-night-mdpi-v8/splashscreen_logo.png']);

  const res = patchLauncherIcons(entries, path.join(ROOT, 'assets/logo/android'));
  const names = res.entries.map(e => e.name);
  const splashFiles = names.filter(n => /\/splashscreen_logo\./.test(n)).sort();
  assert.deepEqual(splashFiles, [
    'res/drawable-mdpi-v4/splashscreen_logo.webp', 'res/drawable-night-mdpi-v8/splashscreen_logo.webp',
    'res/drawable-night-xxxhdpi-v8/splashscreen_logo.webp', 'res/drawable-xxxhdpi-v4/splashscreen_logo.webp',
  ]);
  assert.deepEqual(res.splashDensitiesAdded.sort(), ['res/drawable-night-xxxhdpi-v8/splashscreen_logo.webp', 'res/drawable-xxxhdpi-v4/splashscreen_logo.webp']);
  const byName = new Map(res.entries.map(e => [e.name, e]));
  for (const n of splashFiles) {
    const want = n.includes('xxxhdpi') ? 'xxxhdpi' : 'mdpi';
    assert.ok(entryBytes(byName.get(n)).equals(fs.readFileSync(path.join(SPLASH_DIR, `splashscreen_logo-${want}.webp`))), n);
  }
  const arsc = entryBytes(byName.get('resources.arsc'));
  assert.equal(findResourceId(arsc, 'drawable', 'splashscreen_logo'), splashId, 'same resource id (the theme keeps pointing at it)');
  assert.equal(findResourceId(arsc, 'drawable', 'test_level_drawable'), findResourceId(entryBytes(before), 'drawable', 'test_level_drawable'));
  // Every path the table names exists in the APK and nothing points at the old .png files.
  const tableText = arsc.toString('utf8');
  for (const n of splashFiles) assert.ok(tableText.includes(n), `table names ${n}`);

  // Idempotent: a second pass adds nothing.
  const again = addFileResourceDensity(arsc, 'drawable', 'splashscreen_logo', { extension: '.webp' });
  assert.equal(again.added.length, 0);
  assert.equal(again.buffer, arsc);

  // aapt2 (when installed) reads the same four configurations.
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const bt = sdk && fs.existsSync(path.join(sdk, 'build-tools'))
    ? fs.readdirSync(path.join(sdk, 'build-tools')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() : null;
  const aapt2 = bt && path.join(sdk, 'build-tools', bt, 'aapt2');
  if (aapt2 && fs.existsSync(aapt2)) {
    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-splash-'));
    try {
      const { writeZip } = await import('../patchers/signing.mjs');
      const apk = path.join(dir, 'res.apk');
      fs.writeFileSync(apk, writeZip(res.entries.filter(e => e.name === 'resources.arsc' || e.name === 'AndroidManifest.xml' || e.name.startsWith('res/'))));
      const dump = execFileSync(aapt2, ['dump', 'resources', apk], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      const block = dump.split('\n');
      const at = block.findIndex(l => /drawable\/splashscreen_logo$/.test(l.trim()));
      assert.ok(at >= 0, 'aapt2 lists drawable/splashscreen_logo');
      assert.deepEqual(block.slice(at + 1, at + 5).map(l => l.trim()), [
        '(mdpi) (file) res/drawable-mdpi-v4/splashscreen_logo.webp',
        '(night-mdpi) (file) res/drawable-night-mdpi-v8/splashscreen_logo.webp',
        '(xxxhdpi) (file) res/drawable-xxxhdpi-v4/splashscreen_logo.webp',
        '(night-xxxhdpi) (file) res/drawable-night-xxxhdpi-v8/splashscreen_logo.webp',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('addFileResourceDensity: no matching resource leaves the table untouched', { skip }, () => {
  const { entries } = normalizeApkOrXapk(fs.readFileSync(XAPK));
  const arsc = entryBytes(entries.find(e => e.name === 'resources.arsc'));
  const none = addFileResourceDensity(arsc, 'drawable', 'no_such_drawable_rokbot');
  assert.equal(none.buffer, arsc);
  assert.deepEqual(none.added, []);
  // mergeResourcesArsc still parses the grown table (same ResTable layout).
  const grown = addFileResourceDensity(arsc, 'drawable', 'splashscreen_logo').buffer;
  assert.ok(mergeResourcesArsc(grown, []).equals(grown));
});

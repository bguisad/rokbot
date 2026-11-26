// RokBot avatar styles on every Android Bot icon, and the RokBot logo on every app-logo spot.
// - RokBotAvatarManager finds the official marks by React Native's own test ids / labels (still marks,
//   animated marks, shape picker cells, app marks) and draws into the host view's overlay.
// - RokBotSvgVector reads the official silhouette as a vector Path; RokBotAvatarShapes carries the
//   13 official 1.26.0 silhouettes as path data for native-only places
//   (notification large icon, share sheet), RokBotLogo the master logo geometry.
// - BundleAssets copies React Native's packaged assets next to the file bundles; patch-android
//   replaces React Native's in-app app icon SVG with the RokBot mark.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createEntry, entryBytes } from '../patchers/signing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(NATIVE_ROOT, '..');
const SRC = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

test('avatar manager: finds official marks by test id / label and never inserts views into React Native', () => {
  const m = read('RokBotAvatarManager.java');
  assert.match(m, /TEST_ID_BODY = "still-avatar-body"/);
  assert.match(m, /TEST_ID_EYES = "still-avatar-eyes"/);
  assert.match(m, /SHAPE_CELL_SUFFIX = " character shape"/);
  for (const id of ['about-mark', 'launch-mark', 'signed-out-cover-mark', 'tour-mark', 'blocked-mark'])
    assert.ok(m.includes(`"${id}"`), `app mark ${id} becomes the RokBot logo`);
  assert.match(m, /getIdentifier\("react_test_id", "id", pkg\)/, 'testID is read from R.id.react_test_id');
  assert.match(m, /host\.getOverlay\(\)\.add\(e\.drawable\)/, 'Bot marks are drawn in the host overlay');
  assert.match(m, /v\.getOverlay\(\)\.add\(e\.drawable\)/, 'app marks are drawn in the host overlay');
  assert.doesNotMatch(m, /\.addView\(/, 'no child views are added to React Native view groups');
  assert.match(m, /setVisibility\(View\.INVISIBLE\)/, 'official marks are hidden, not removed');
  assert.match(m, /addOnDrawListener/, 'Fabric mounts without layout passes: scans follow drawn frames');
  assert.match(m, /MIN_SCAN_INTERVAL_MS = 250L/, 'scans are throttled');
  // SvgView is itself a ViewGroup: the animated-mark check must run before descending.
  const scan = m.slice(m.indexOf('private static int scanTree('));
  assert.ok(scan.indexOf('if (isSvg(v))') < scan.indexOf('if (v instanceof ViewGroup)'));
  assert.match(m, /cell\.isSelected\(\)/, 'selected picker cell keeps its outline ring');

  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /RokBotAvatarManager\.onReactResumed\(activity\);/);
  assert.match(boot, /RokBotAvatarManager\.onReactPaused\(activity\);/);
});

test('avatar renderer: pure vector paths at the target pixel size, no bitmap masks', () => {
  const r = read('RokBotAvatarRenderer.java');
  const d = read('RokBotAvatarDrawable.java');
  const v = read('RokBotAvatarView.java');
  for (const [name, src] of [['renderer', r], ['drawable', d], ['view', v]]) {
    assert.doesNotMatch(src, /\bBitmap\b|BitmapShader|createScaledBitmap|setFilterBitmap|SvgSample|sampleSvg/,
      `${name}: no bitmap masks, no scaled / filtered bitmaps`);
  }
  // Every style takes the Bot silhouette as a Path in the 0..100 design box.
  assert.match(r, /static void draw\(Canvas canvas, String styleId, Path shape, float size, double t, float blink,/);
  assert.match(r, /static void drawSelectionRing\(Canvas canvas, Path shape, float size, int ringColor\)/);
  assert.match(r, /static void drawOfficialStill\(Canvas canvas, Path shape, float s, int color\)/);
  assert.match(r, /p\.setFlags\(Paint\.ANTI_ALIAS_FLAG\);/, 'anti-aliased fills and strokes');
  // The rim is clipped to the inside of the outline: no translucent band outside the body edge.
  const body = r.slice(r.indexOf('private static void drawShapeBody('));
  assert.ok(body.indexOf('canvas.clipPath(shape)') > 0 && body.indexOf('canvas.clipPath(shape)') < body.indexOf('2.4f'));
  // Pixel style: LED grid on whole device pixels, filled without anti-aliasing (hard square edges).
  const pixel = r.slice(r.indexOf('private static void drawPixel('), r.indexOf('private static void drawOrb('));
  assert.match(pixel, /int cell = Math\.max\(2, Math\.round\(4\.55f \* sc\)\);/);
  assert.match(pixel, /crisp\(/);
  assert.match(r, /private static Paint crisp\(int color\) \{[^}]*p\.reset\(\);[^}]*\}/, 'crisp paint has no AA flag');
  assert.match(d, /canvas\.translate\(b\.left \+ Math\.round\(/, 'overlay draws from a whole-pixel origin');
  // Caches: palettes (with their gradient shader) per color, per-thread paints; no per-frame parsing.
  assert.match(r, /private static final Map<Long, Palette> PALETTES/);
  assert.match(r, /ThreadLocal<Paints> PAINTS/);
  assert.match(d, /final class RokBotAvatarDrawable extends Drawable/);
  assert.match(d, /FRAME_MS = 33L/);
});

test('official SVG to vector: react-native-svg paths are read live and mapped to the design box', () => {
  const sv = read('RokBotSvgVector.java');
  assert.match(sv, /"com\.horcrux\.svg\.RenderableView"/);
  assert.match(sv, /getDeclaredField\("mCTM"\)/, 'canvas matrix of each SVG node');
  assert.match(sv, /p\.transform\(n\.ctm\);\s*p\.transform\(toDesign\);/, 'node path -> SvgView px -> 0..100 box');
  assert.match(sv, /out\.op\(c, Path\.Op\.UNION\)/, 'eye cut-outs filled by a vector contour union');
  assert.match(sv, /if \(previous != null && previous\.key == key\) return previous;/, 'unchanged marks reuse the cached Path');
  assert.doesNotMatch(sv, /ReadableNativeArray\)|\.getArray\(|\.getDouble\(/, 'React Native brush arrays are never read off their thread');
  const m = read('RokBotAvatarManager.java');
  assert.doesNotMatch(m, /sampleSvg|SvgSample|sampleSize\(/);
  assert.equal((m.match(/RokBotSvgVector\.extract\(/g) || []).length, 4, 'still, animated, live outline and picker cell');
  assert.match(m, /e\.drawable\.setBeforeFrame\(e\.follow\)/, 'animated mark follows the live outline every frame');
  // Native-only bitmaps (notification icons) are drawn as vectors at the final pixel size.
  const notif = read('NotificationService.java');
  assert.match(notif, /getDimensionPixelSize\(android\.R\.dimen\.notification_large_icon_width\)/);
  assert.match(notif, /Math\.round\(24f \* context\.getResources\(\)\.getDisplayMetrics\(\)\.density\)/);
  const av = read('RokBotAvatars.java');
  assert.match(av, /Bitmap out = Bitmap\.createBitmap\(sizePx, sizePx, Bitmap\.Config\.ARGB_8888\);/);
  assert.match(av, /RokBotAvatarRenderer\.draw\(c, style, RokBotAvatarShapes\.path\(/);
});

/** Contours of absolute M / L / Z path data (what RokBotSvgVector.toPathData writes for the official shapes). */
function contours(d) {
  const out = [];
  let cur = null;
  for (const [, cmd, args] of d.matchAll(/([MLZ])([^MLZ]*)/g)) {
    if (cmd === 'Z') { cur = null; continue; }
    const nums = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === 'M') { cur = []; out.push(cur); }
    for (let i = 0; i + 1 < nums.length; i += 2) cur.push([nums[i], nums[i + 1]]);
  }
  return out;
}

function decodeShapes(src) {
  const block = src.slice(src.indexOf('private static final String[][] SHAPES = {'), src.indexOf('// END HARVESTED SHAPES'));
  return [...block.matchAll(/\{ "([a-z]+)",\s*((?:"[^"]*"\s*\+?\s*)+)\}/g)]
    .map(([, name, parts]) => ({ name, d: [...parts.matchAll(/"([^"]*)"/g)].map(m => m[1]).join('') }));
}

test('official shapes: the 13 Grok Bot 1.26.0 silhouettes are vector path data in the 0..100 box', () => {
  const src = read('RokBotAvatarShapes.java');
  const shapes = decodeShapes(src);
  assert.deepEqual(shapes.map(s => s.name),
    ['blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex']);
  const signatures = new Set();
  for (const { name, d } of shapes) {
    assert.match(d, /^M[-\d. MLZ]+$/, `${name}: absolute M/L/Z data`);
    let area = 0, cx = 0, cy = 0, pts = 0;
    for (const c of contours(d)) {
      let a = 0, x = 0, y = 0;
      for (let i = 0; i < c.length; i++) {
        const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % c.length];
        const k = x0 * y1 - x1 * y0;
        a += k; x += (x0 + x1) * k; y += (y0 + y1) * k;
        assert.ok(x0 >= -2 && x0 <= 102 && y0 >= -2 && y0 <= 102, `${name}: point in the design box`);
        pts++;
      }
      if (Math.abs(a) < 1e-6) continue;
      area += Math.abs(a / 2); cx += x / 6; cy += y / 6;
    }
    const fill = area / 10000;
    assert.ok(fill > 0.3 && fill < 0.95, `${name}: covers ${fill.toFixed(2)} of the box`);
    assert.ok(pts >= 12, `${name}: ${pts} points`);
    signatures.add(d);
  }
  assert.equal(signatures.size, shapes.length, 'every shape is different');
  assert.match(src, /private static final Map<String, Path> PATHS/, 'parsed once, cached');
  for (const color of ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'magenta', 'gray'])
    assert.match(src, new RegExp(`\\{ "${color}", 0xFF[0-9A-F]{6} \\}`), `swatch ${color}`);
});

test('native Bot icons: share sheet rows and notification large icons use the RokBot avatar', () => {
  const share = read('ShareTargetActivity.java');
  assert.match(share, /RokBotAvatars\.makeView\(this, RokBotAvatars\.lookOf\(bot\), 38, p\)/);
  assert.match(share, /RokBotAvatars\.remember\(this, list\);/);
  const notif = read('NotificationService.java');
  assert.match(notif, /applyBotLargeIcon\(context, builder, agentId\);/);
  assert.match(notif, /builder\.setLargeIcon\(Icon\.createWithBitmap\(bmp\)\)/);
  assert.match(notif, /Path head = RokBotLogo\.chassisPath\(\);/, 'small icon silhouette comes from the master logo');
  const avatars = read('RokBotAvatars.java');
  assert.match(avatars, /Looper\.myLooper\(\) != Looper\.getMainLooper\(\)/, 'roster refresh never on the main thread');
  assert.match(avatars, /UiChrome\.decodeCircleAvatar\(look\.name, look\.imageDataUrl, sizePx\)/, 'custom pictures stay pictures');
});

test('RokBot logo: native logo views draw assets/logo/rokbot-logo.svg geometry', () => {
  const svg = fs.readFileSync(path.join(REPO_ROOT, 'assets/logo/rokbot-logo.svg'), 'utf8');
  const logo = read('RokBotLogo.java');
  const d = svg.match(/\sd="(M[^"]+)"/)[1];
  const svgNums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const javaPath = logo.slice(logo.indexOf('static Path chassisPath()'), logo.indexOf('return head;'));
  const javaNums = [...javaPath.matchAll(/\(([^)]*)\)/g)].flatMap(m => m[1].split(',').map(v => parseFloat(v)).filter(v => !Number.isNaN(v)));
  assert.deepEqual(javaNums, svgNums, 'chassis path is the master path');
  for (const token of ['#242936', '#12141b', '#303747', '#f5f5f4', '#38bdf8']) {
    assert.ok(logo.toLowerCase().includes('0xff' + token.slice(1)), `colour ${token}`);
    assert.ok(svg.toLowerCase().includes(token), `master SVG colour ${token}`);
  }
  assert.match(logo, /rotate\(-26f, 376f, 564f\)/);
  assert.match(logo, /drawCircle\(768f, 144f, 42f, accent\)/);
  const ui = read('UiChrome.java');
  assert.match(ui, /new RokBotLogo\.LogoDrawable\(size\)/, 'makeRokLogoView draws the real logo');
});

test('bundle assets: React Native images / SVGs / sounds are copied next to the file bundles', () => {
  const src = read('BundleAssets.java');
  const raw = src.match(/Pattern\.compile\(\s*"((?:[^"\\]|\\.)*)"\);/)[1].replace(/\\\\/g, '\\');
  const re = new RegExp(raw);
  const map = name => { const m = re.exec(name); return m ? `${m[1]}/${m[2]}` : null; };
  assert.equal(map('res/raw/assets_appicon_assets_dark.svg'), 'raw/assets_appicon_assets_dark.svg');
  assert.equal(map('res/drawable-mdpi-v4/assets_brands_google.png'), 'drawable-mdpi/assets_brands_google.png');
  assert.equal(map('res/drawable-xxhdpi/_node_modules_pnpm_x_assets_back.png'), 'drawable-xxhdpi/_node_modules_pnpm_x_assets_back.png');
  assert.equal(map('res/drawable-mdpi-v4/abc_btn_check_to_on_mtrl_000.png'), null, 'Android resources stay in the APK');
  assert.equal(map('res/raw/keep.xml'), null);
  assert.equal(map('res/mipmap-xxhdpi/ic_launcher.png'), null);
  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /return withAssets\(context, HermesPatcher\.ensureUnpairedBundleFile\(context\)\);/);
  assert.match(boot, /return withAssets\(context, ensurePairedBundleFileOnly\(context, force\)\);/);
});

test('patch-android: React Native in-app app icon SVG becomes the RokBot mark', async () => {
  const { patchLauncherIcons } = await import('../release/patch-android.mjs');
  const logoDir = path.join(REPO_ROOT, 'assets/logo/android');
  const res = patchLauncherIcons([
    createEntry('res/raw/assets_appicon_assets_dark.svg', Buffer.from('<svg>grok</svg>')),
    createEntry('res/raw/assets_brands_slack.svg', Buffer.from('<svg>slack</svg>')),
  ], logoDir);
  const byName = new Map(res.entries.map(e => [e.name, e]));
  const icon = entryBytes(byName.get('res/raw/assets_appicon_assets_dark.svg')).toString('utf8');
  assert.equal(icon, fs.readFileSync(path.join(REPO_ROOT, 'assets/logo/rokbot-app-icon.svg'), 'utf8'));
  assert.match(icon, /M 340 148 C 408 148/, 'the master chassis path');
  assert.doesNotMatch(icon, /Gradient|url\(#/, 'solid fills only (expo-image renders and tints it)');
  assert.equal(entryBytes(byName.get('res/raw/assets_brands_slack.svg')).toString('utf8'), '<svg>slack</svg>');
  assert.equal(res.brandDrawablesReplaced, 1);
});

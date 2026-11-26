// RokBot avatar styles on every Android Bot icon, and the RokBot logo on every app-logo spot.
// - RokBotAvatarManager finds the official marks by React Native's own test ids / labels (still marks,
//   animated marks, shape picker cells, app marks) and draws into the host view's overlay.
// - RokBotAvatarShapes carries the 13 official 1.26.0 silhouettes for native-only places
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

test('avatar renderer: anti-aliased silhouettes with filled holes and a shape-following selection ring', () => {
  const r = read('RokBotAvatarRenderer.java');
  assert.match(r, /static SvgSample sampleSvg\(View svg, View box, float inset, int n, SvgSample previous\)/);
  assert.match(r, /Fill holes: everything not reachable from the border/);
  assert.match(r, /Only the outer silhouette keeps its anti-aliased edge/);
  assert.match(r, /static void drawSelectionRing\(Canvas canvas, Bitmap mask, float size, int ringColor\)/);
  assert.match(r, /static void drawOfficialStill\(Canvas canvas, Bitmap mask, float s, int color\)/);
  assert.doesNotMatch(r, /MASK_DIM = 64/, 'no fixed 64 px masks (pixelated large avatars)');
  const d = read('RokBotAvatarDrawable.java');
  assert.match(d, /final class RokBotAvatarDrawable extends Drawable/);
  assert.match(d, /FRAME_MS = 33L/);
});

function decodeShapes(src) {
  const block = src.slice(src.indexOf('private static final String[][] SHAPES = {'), src.indexOf('};'));
  return [...block.matchAll(/\{ "([a-z]+)", "([A-Za-z0-9+/=]+)" \}/g)].map(([, name, b64]) => ({ name, bits: Buffer.from(b64, 'base64') }));
}

test('official shapes: the 13 Grok Bot 1.26.0 silhouettes decode to plausible 128 px masks', () => {
  const shapes = decodeShapes(read('RokBotAvatarShapes.java'));
  assert.deepEqual(shapes.map(s => s.name),
    ['blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex']);
  const n = 128;
  const signatures = new Set();
  for (const { name, bits } of shapes) {
    assert.equal(bits.length, n * n / 8, `${name}: 128 x 128 bits`);
    let area = 0, sx = 0, sy = 0;
    for (let i = 0; i < n * n; i++) {
      if (bits[i >> 3] & (0x80 >> (i & 7))) { area++; sx += i % n; sy += Math.floor(i / n); }
    }
    const fill = area / (n * n);
    assert.ok(fill > 0.3 && fill < 0.9, `${name}: filled ${fill.toFixed(2)}`);
    assert.ok(Math.abs(sx / area - n / 2) < 16 && Math.abs(sy / area - n / 2) < 16, `${name}: centred`);
    signatures.add(bits.toString('base64'));
  }
  assert.equal(signatures.size, shapes.length, 'every shape is different');

  const src = read('RokBotAvatarShapes.java');
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
  for (const token of ['#242936', '#12141b', '#4a556b', '#f5f5f4', '#38bdf8'])
    assert.ok(logo.toLowerCase().includes('0xff' + token.slice(1)), `colour ${token}`);
  assert.match(logo, /rotate\(-26f, 376f, 564f\)/);
  assert.match(logo, /drawCircle\(768f, 144f, 42f, accent\)/);
  const ui = read('UiChrome.java');
  assert.match(ui, /RokBotLogo\.draw\(canvas, Math\.min\(w, h\)\);/, 'makeRokLogoView draws the real logo');
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

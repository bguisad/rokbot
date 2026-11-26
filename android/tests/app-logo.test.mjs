import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setColorResourceValue } from '../patchers/arsc.mjs';
import { createEntry, entryBytes, readZip, writeZip } from '../patchers/signing.mjs';
import { ANDROID_ICON_BACKGROUND_ARGB } from '../release/patch-android.mjs';

const ANDROID_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ANDROID_ROOT, '..');
const SRC = path.join(ANDROID_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');
const masterSvg = fs.readFileSync(path.join(REPO, 'assets/logo/rokbot-logo.svg'), 'utf8');

const numbers = text => (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

test('RokBotLogo draws the white-tile master SVG as vectors (tile, rim, edge, head transform)', () => {
  const java = read('RokBotLogo.java');
  // Head path: same cubic segments as the master SVG.
  const svgPath = /class="brand-face"\s+d="([^"]+)"/.exec(masterSvg)[1];
  const javaPath = [...java.matchAll(/head\.(?:moveTo|cubicTo)\(([^)]*)\)/g)].map(m => m[1]).join(' ');
  assert.deepEqual(numbers(javaPath), numbers(svgPath));
  // Tile and glyph placement.
  assert.match(masterSvg, /rx="308"/);
  assert.match(java, /TILE_RADIUS = 308f/);
  assert.match(java, /TILE_TOP = 0xFFF4FBFE/);
  assert.match(java, /TILE_BOTTOM = 0xFFC9EEF7/);
  assert.match(java, /new LinearGradient\(287\.55f, -104\.66f, 736\.45f, 1128\.66f/);
  assert.match(masterSvg, /x1="287\.55" y1="-104\.66" x2="736\.45" y2="1128\.66"/);
  assert.match(java, /new RectF\(12f, 12f, 1012f, 1012f\), 296f, 296f, rim\)/);
  assert.match(java, /GLYPH_SCALE = 0\.84f/);
  assert.match(java, /GLYPH_CENTER_Y = 506f/);
  assert.match(masterSvg, /translate\(512 512\) scale\(0\.84\) translate\(-512 -506\)/);
  // Head colors, eyes and accent node as in the master.
  for (const color of ['242936', '12141B', '303747', 'F5F5F4', '38BDF8']) {
    assert.match(java, new RegExp(`0xFF${color}`, 'i'));
    assert.match(masterSvg, new RegExp(`#${color}`, 'i'));
  }
  assert.match(java, /canvas\.rotate\(-26f, 376f, 564f\)/);
  assert.match(java, /canvas\.rotate\(-26f, 648f, 504f\)/);
  assert.match(java, /canvas\.drawCircle\(768f, 144f, 42f, accent\)/);
  assert.doesNotMatch(java, /Bitmap|BitmapFactory|decode/, 'drawn with vectors, never an upscaled bitmap');
});

test('native pages and the React Native Settings footer mark use the RokBot logo', () => {
  const ui = read('UiChrome.java');
  const makeLogo = ui.slice(ui.indexOf('public static ImageView makeRokLogoView'), ui.indexOf('public static TextView makeCircleButton'));
  assert.match(makeLogo, /new RokBotLogo\.LogoDrawable\(size\)/);

  const marks = read('RokBotAppMarks.java');
  for (const id of ['about-mark', 'launch-mark', 'signed-out-cover-mark', 'tour-mark', 'blocked-mark', 'bundle-override-mark']) {
    assert.match(marks, new RegExp(`"${id}"`));
  }
  assert.match(marks, /getIdentifier\("react_test_id", "id"/);
  assert.match(marks, /com\.horcrux\.svg\.SvgView/);
  assert.match(marks, /getOverlay\(\)\.add\(e\.drawable\)/);
  assert.match(marks, /setVisibility\(View\.INVISIBLE\)/);
  assert.match(marks, /addOnDrawListener/);
  assert.doesNotMatch(marks, /\.addView\(/, 'never adds children to React Native view groups');

  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /if \(isReactActivity\(activity\)\) RokBotAppMarks\.onReactResumed\(activity\);/);
  assert.match(boot, /RokBotAppMarks\.onReactPaused\(activity\);/);
});

test('adaptive icon background color matches the generated logo manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/logo/manifest.json'), 'utf8'));
  assert.equal(`#${ANDROID_ICON_BACKGROUND_ARGB.toString(16).toUpperCase().padStart(8, '0')}`, manifest.androidIconBackground);
});

const sdk = [process.env.ANDROID_HOME, path.join(os.homedir(), 'Library/Android/sdk')].find(d => d && fs.existsSync(d));
const buildTools = sdk && fs.existsSync(path.join(sdk, 'build-tools'))
  ? fs.readdirSync(path.join(sdk, 'build-tools')).sort().reverse().map(v => path.join(sdk, 'build-tools', v))
    .find(d => fs.existsSync(path.join(d, 'aapt2')))
  : null;
const androidJar = sdk && fs.existsSync(path.join(sdk, 'platforms'))
  ? fs.readdirSync(path.join(sdk, 'platforms')).sort().reverse().map(v => path.join(sdk, 'platforms', v, 'android.jar'))
    .find(f => fs.existsSync(f))
  : null;

test('setColorResourceValue rewrites only the named color, in place', { skip: !(buildTools && androidJar) && 'Android SDK aapt2 not found' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-arsc-color-'));
  try {
    const aapt2 = path.join(buildTools, 'aapt2');
    fs.mkdirSync(path.join(tmp, 'res/values'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'res/values/colors.xml'),
      '<resources><color name="iconBackground">#ff000000</color><color name="other">#ff123456</color></resources>');
    fs.mkdirSync(path.join(tmp, 'res/values-night'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'res/values-night/colors.xml'),
      '<resources><color name="iconBackground">#ff111111</color></resources>');
    fs.writeFileSync(path.join(tmp, 'AndroidManifest.xml'),
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.rokbot.arsctest"/>');
    cp.execFileSync(aapt2, ['compile', '--dir', path.join(tmp, 'res'), '-o', path.join(tmp, 'res.zip')], { stdio: 'pipe' });
    cp.execFileSync(aapt2, ['link', '-I', androidJar, '--manifest', path.join(tmp, 'AndroidManifest.xml'),
      '-o', path.join(tmp, 'out.apk'), path.join(tmp, 'res.zip')], { stdio: 'pipe' });
    const arsc = entryBytes(readZip(fs.readFileSync(path.join(tmp, 'out.apk'))).entries.find(e => e.name === 'resources.arsc'));

    const result = setColorResourceValue(arsc, 'iconBackground', 0xffdff4fa);
    assert.equal(result.patched, 2, 'default and night configurations');
    assert.equal(result.buffer.length, arsc.length);
    let changed = 0;
    for (let i = 0; i < arsc.length; i++) if (arsc[i] !== result.buffer[i]) changed++;
    assert.ok(changed > 0 && changed <= 8, `only the two color words change (${changed} bytes)`);
    assert.equal(setColorResourceValue(arsc, 'missingColor', 0xffffffff).patched, 0);

    const zip = readZip(fs.readFileSync(path.join(tmp, 'out.apk')));
    const entries = zip.entries.map(e => (e.name === 'resources.arsc' ? createEntry('resources.arsc', result.buffer, { store: true }) : e));
    fs.writeFileSync(path.join(tmp, 'patched.apk'), writeZip(entries));
    const dump = cp.execFileSync(aapt2, ['dump', 'resources', path.join(tmp, 'patched.apk')], { encoding: 'utf8' });
    const block = name => dump.slice(dump.indexOf(`color/${name}`)).split('\n').slice(1, 3).join('\n');
    assert.match(block('iconBackground'), /\(\) #ffdff4fa/);
    assert.match(block('iconBackground'), /\(night(?:-v8)?\) #ffdff4fa/);
    assert.match(block('other'), /#ff123456/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

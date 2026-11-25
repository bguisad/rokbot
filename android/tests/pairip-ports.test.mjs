// Pairip VM bridge regression guards: every Pairip-virtualized Activity lifecycle method of the
// pinned 1.26.0 (3212) build must run a real port (or cancel cleanly) instead of only super.X(),
// which left expo-video's FullscreenPlayerActivity half-built and crashed in onPostCreate.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { entryBytes, readZip } from '../patchers/signing.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPANION = path.join(PROJECT_ROOT, 'android/companion/src/main/java/dev/rokbot/nativeapp');

// VM id -> virtualized method in the official 1.26.0 (3212) dex (dexdump of VMRunner.invoke call sites).
const ACTIVITY_VM_IDS = {
  '0S9N6t3pFyc7VPPl': 'expo.modules.video.FullscreenPlayerActivity.onCreate',
  'I5hfm577V3jsppLY': 'expo.modules.video.FullscreenPlayerActivity.onDestroy',
  'v9LqZUpcQtcB3Nwo': 'expo.modules.video.FullscreenPlayerActivity.onPause',
  'RKuIoSarf15NBRcX': 'expo.modules.webbrowser.BrowserProxyActivity.onCreate',
  '5q5q5Yxdr81312tm': 'com.canhub.cropper.CropImageActivity.onCreate',
  'L9rRYkEWpLsSoOnW': 'com.google.android.play.core.common.PlayCoreDialogWrapperActivity.onCreate',
  'GU0LCjESbvj9UT2P': 'com.braze.ui.BrazeWebViewActivity.onCreate',
  'sAkN0RxZouDqCE6s': 'com.android.billingclient.api.ProxyBillingActivity.onCreate',
  'SoGry6x665HebzTB': 'com.android.billingclient.api.ProxyBillingActivityV2.onCreate',
  'uX2I4kjoqIXRjoXt': 'com.google.android.gms.auth.api.signin.internal.SignInHubActivity.onCreate',
  'wbaeflvl3wYdHcnN': 'ai.x.grok.bot.MainActivity.onCreate',
  'emzAGhE56MI9lYhl': 'com.android.billingclient.api.ProxyBillingActivity.onDestroy',
};

function bridgeSource() {
  return fs.readFileSync(path.join(COMPANION, 'PairipVmBridge.java'), 'utf8');
}

/** Returns the statements executed for `case "<id>":` (through the first return statement). */
function caseBody(src, id) {
  const at = src.indexOf(`case "${id}":`);
  assert.ok(at >= 0, `PairipVmBridge must handle VM id ${id} (${ACTIVITY_VM_IDS[id]})`);
  const rest = src.slice(at);
  // Skip the fall-through group of case labels and trailing comments.
  const body = rest.replace(/^(\s*case "[^"]+":\s*(\/\/[^\n]*)?\s*)+/, '');
  const ret = body.indexOf('return');
  return body.slice(0, body.indexOf(';', ret) + 1);
}

test('Pairip bridge routes every virtualized 1.26.0 Activity lifecycle method to a port, not super-only', () => {
  const src = bridgeSource();
  const expectations = {
    '0S9N6t3pFyc7VPPl': /portedOnCreate\(vmId, args, PairipActivityPorts\.FULLSCREEN_PLAYER\)/,
    'I5hfm577V3jsppLY': /fullscreenPlayerOnDestroy/,
    'v9LqZUpcQtcB3Nwo': /fullscreenPlayerOnPause/,
    'RKuIoSarf15NBRcX': /PairipActivityPorts\.BROWSER_PROXY/,
    '5q5q5Yxdr81312tm': /PairipActivityPorts\.CROP_IMAGE/,
    'L9rRYkEWpLsSoOnW': /PairipActivityPorts\.PLAY_CORE_DIALOG/,
    'GU0LCjESbvj9UT2P': /PairipActivityPorts\.BRAZE_WEBVIEW/,
    'sAkN0RxZouDqCE6s': /cancelUnsupportedOnCreate/,
    'SoGry6x665HebzTB': /cancelUnsupportedOnCreate/,
    'uX2I4kjoqIXRjoXt': /cancelUnsupportedOnCreate/,
    'wbaeflvl3wYdHcnN': /handleMainActivityOnCreate/,
    'emzAGhE56MI9lYhl': /onDestroy\$001/,
  };
  for (const [id, re] of Object.entries(expectations)) {
    const body = caseBody(src, id);
    assert.match(body, re, `${ACTIVITY_VM_IDS[id]} (${id}) routed to: ${body.trim().split('\n')[0]}`);
    if (id !== 'emzAGhE56MI9lYhl') {
      assert.doesNotMatch(body, /handleGenericActivityOnCreate\(args\);\s*$/, `${id} must not be super-only`);
    }
  }
});

test('Pairip ports replay upstream bodies through pinned trampolines and fail closed', () => {
  const ports = fs.readFileSync(path.join(COMPANION, 'PairipActivityPorts.java'), 'utf8');
  // expo-video sdk-57 FullscreenPlayerActivity.onCreate: intent extras, VideoManager lookup, layout,
  // lateinit fields read by onPostCreate (a=mContentView, d=playerView, e=videoView), player handoff.
  for (const needle of [
    '"player_uuid"', '"fullscreen_options"', '"f$007"', '"fullscreen_player_activity"', '"enclosing_layout"',
    '"player_view"', 'setField(act, fpa, "a", content)', 'setField(act, fpa, "d", playerView)',
    'setField(act, fpa, "e", videoView)', '"U", exo, oldPlayerView, playerView', '"o$019"', '"p$020"',
    // onPause / onDestroy bodies
    '"y3$001"', '"pause$006"', '"onPause$009"', '"exitFullscreen$004"', '"y$005"', '"x$006"',
    // expo-web-browser BrowserProxyActivity
    '"expo.modules.webbrowser.EXTRA_URL"', '"expo.modules.webbrowser.EXTRA_CUSTOM_TABS_INTENT_DATA"', '"a$012"',
    // CanHub cropper / Play Core
    '"CROP_IMAGE_EXTRA_BUNDLE"', '"setImageUriAsync$010"', '"confirmation_intent"', '"result_receiver"',
  ]) {
    assert.ok(ports.includes(needle), `PairipActivityPorts.java must contain ${needle}`);
  }
  // A failed port must finish the Activity instead of letting onStart/onPostCreate run half-built.
  assert.match(bridgeSource(), /onCreate port failed; finishing[\s\S]{0,200}act\.finish\(\)/);
  assert.match(ports, /finishQuietly\(act, "fullscreen setup failed", t\)/);

  const dex = fs.readFileSync(path.join(PROJECT_ROOT, 'android/bin/classes2.dex'));
  for (const s of ['Ldev/rokbot/nativeapp/PairipActivityPorts;', 'fullscreen_options']) {
    assert.ok(dex.includes(Buffer.from(s)), `android/bin/classes2.dex must be rebuilt with ${s}`);
  }
});

function resolveXapk() {
  if (process.env.ROKBOT_ANDROID_TEST_XAPK !== undefined) {
    const p = process.env.ROKBOT_ANDROID_TEST_XAPK.trim();
    return p && fs.existsSync(p) ? p : null;
  }
  return [
    path.join(PROJECT_ROOT, 'inputs/android/grok-bot-1.26.0.xapk'),
    '/Volumes/ORICO/grokbot/inputs/android/grok-bot-1.26.0.xapk',
  ].find(p => fs.existsSync(p)) || null;
}

function resolveDexdump() {
  const roots = [process.env.ANDROID_HOME, path.join(os.homedir(), 'Library/Android/sdk'),
    '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk'].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'build-tools/36.0.0/dexdump');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const XAPK = resolveXapk();
const DEXDUMP = resolveDexdump();

test(
  'Pairip bridge covers every VMRunner.invoke site of the official 1.26.0 dex that sits on an Activity lifecycle method',
  { skip: (!XAPK && 'Official grok-bot-1.26.0.xapk not found; set ROKBOT_ANDROID_TEST_XAPK') || (!DEXDUMP && 'dexdump not found') },
  () => {
    const xapk = readZip(fs.readFileSync(XAPK));
    const base = readZip(entryBytes(xapk.entries.find(e => e.name === 'ai.x.grok.bot.apk')));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-pairip-'));
    const sites = new Map();
    try {
      for (const e of base.entries.filter(x => /^classes\d*\.dex$/.test(x.name))) {
        const f = path.join(tmp, e.name);
        fs.writeFileSync(f, entryBytes(e));
        const out = cp.execFileSync(DEXDUMP, ['-d', f], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
        let cls = null; let pendingName = null; let method = null; let lastId = null;
        for (const line of out.split('\n')) {
          let m;
          if ((m = /^\s+Class descriptor\s+:\s+'L(.+);'/.exec(line))) { cls = m[1].replace(/\//g, '.'); continue; }
          if ((m = /^\s+name\s+:\s+'(.+)'/.exec(line))) { pendingName = m[1]; continue; }
          if (pendingName && /^\s+type\s+:/.test(line)) { method = pendingName; pendingName = null; continue; }
          if ((m = /const-string(?:\/jumbo)? v\d+, "([A-Za-z0-9]{16})"/.exec(line))) { lastId = m[1]; continue; }
          if (lastId && line.includes('Lcom/pairip/VMRunner;.invoke')) { sites.set(lastId, `${cls}.${method}`); lastId = null; }
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    assert.ok(sites.size >= 15, `expected the pinned build's Pairip VM sites, got ${sites.size}`);
    const src = bridgeSource();
    const lifecycle = [...sites].filter(([, where]) => /\.(onCreate|onDestroy|onPause|onResume|onStart|onStop)$/.test(where)
      && !/MainApplication\.onCreate$/.test(where));
    for (const [id, where] of lifecycle) {
      assert.equal(ACTIVITY_VM_IDS[id], where, `VM id ${id} (${where}) must be in the audited Activity table`);
      assert.ok(src.includes(`case "${id}":`), `PairipVmBridge must dispatch ${id} (${where})`);
    }
    assert.equal(lifecycle.length, Object.keys(ACTIVITY_VM_IDS).length, 'audited table must match the dex exactly');
  }
);

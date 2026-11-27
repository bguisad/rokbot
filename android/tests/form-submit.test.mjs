// Android 「完成」 / submit taps reach their own handler (Bug D):
//  - our native pages are never re-wired by the RN click hook (it replaced e.g. UpdateActivity's
//    primary button listener when its label matched a settings entry, so 立即更新 / 检查更新 reopened
//    the page instead of running), and a native page never launches itself;
//  - the RN touch takeover never falls through a clickable view on top (a sheet's 完成 / submit
//    button) to a matching settings row underneath, which cancelled the button's tap;
//  - native forms show progress and an error on failure.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

test('RN click hook never rewires companion pages; native pages never stack themselves', () => {
  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /if \(activityClassName\.startsWith\("dev\.rokbot\.nativeapp\."\)\) return false;/);
  assert.match(boot, /target != null && shouldWireNativeHook\(activity\.getClass\(\)\.getName\(\), target\)/);
  assert.match(boot, /if \(!shouldLaunchNativeTarget\(activity\.getClass\(\)\.getName\(\), dest\)\) return;/);
});

test('touch takeover: a clickable view on top owns the tap (no fall-through to rows underneath)', () => {
  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /if \(childHit != null\) return childHit;\s*\/\/[^\n]*\n[\s\S]{0,300}?if \(occludesTouch\(child, rawX, rawY\)\) return null;/);
  assert.match(boot, /private static boolean occludesTouch\(View child, float rawX, float rawY\) \{[\s\S]*?isClickable\(\) \|\| child\.hasOnClickListeners\(\)/);
});

test('native forms: submit wired, progress shown, failure reported', () => {
  const ua = read('UpdateActivity.java');
  assert.match(ua, /mPrimary = UiChrome\.makePillButton\(this, "", true, p, v -> onPrimary\(\)\);/);
  assert.match(ua, /"已是最新版本"/);
  const group = read('CreateGroupActivity.java');
  assert.match(group, /submitCreateGroup\(/);
  assert.match(group, /"创建中…"/, 'progress label while creating');
  assert.match(group, /"重试创建群组"/, 'failure offers a retry');
  const pairing = read('PairingActivity.java');
  assert.match(pairing, /v -> attemptPairing\(\)/);
});

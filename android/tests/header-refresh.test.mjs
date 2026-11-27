// The round refresh button of the shared native header (UiChrome.makeHeaderBar + makeVectorIconButton),
// used by UsageActivity, ComputersActivity, ComputerViewerActivity and ModelsActivity. It used to be
// a silent reload: no pressed state, no busy state, errors only in a status line (or nowhere when data
// was already on screen), so a tap looked inert. Now every header button has a ripple, and refresh
// spins + is disabled while its load runs, then fails loudly with a toast.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');
const between = (src, start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, start); return src.slice(i, src.indexOf(end, i + start.length)); };

test('UiChrome: header icon buttons show a press ripple; setIconButtonBusy spins, disables and restores', () => {
  const ui = read('UiChrome.java');
  const make = between(ui, 'public static ImageView makeVectorIconButton(', 'return btn;');
  assert.match(make, /btn\.setForeground\(new android\.graphics\.drawable\.RippleDrawable\(/, 'pressed feedback on every round header button');
  assert.match(make, /btn\.setClickable\(true\);\s*btn\.setOnClickListener\(onClick\);/);
  const busy = between(ui, 'public static void setIconButtonBusy(View btn, boolean busy)', '/** The white-tile RokBot logo');
  assert.match(busy, /if \(btn == null\) return;/);
  assert.match(busy, /btn\.setEnabled\(false\);\s*btn\.setAlpha\(0\.55f\);/, 'busy: disabled (ignores taps) and dimmed');
  assert.match(busy, /ObjectAnimator\.ofFloat\(btn, View\.ROTATION, 0f, 360f\)/, 'busy: rotates');
  assert.match(busy, /setRepeatCount\(android\.animation\.ValueAnimator\.INFINITE\)/);
  assert.match(busy, /btn\.setEnabled\(true\);\s*btn\.setAlpha\(1f\);/, 'done: enabled again');
  assert.match(busy, /animate\(\)\.rotation\(360f\)/, 'done: finishes the current turn, so a fast reload still shows a spin');
  assert.match(ui, /TAG_BUSY_ANIMATOR = 0x0e0c7a01;/, 'view tag id in the app-private 0x0e range used by the other native tags');
});

const PAGES = [
  { file: 'UsageActivity.java', field: 'mRefreshButton', desc: 'refresh_usage_button' },
  { file: 'ComputersActivity.java', field: 'mRefreshButton', desc: 'refresh_computers_button' },
  { file: 'ComputerViewerActivity.java', field: 'mRefreshButton', desc: 'refresh_computer_button' },
  { file: 'ModelsActivity.java', field: 'mRefreshButton', desc: 'refresh_models_button' },
];

test('every header refresh button is wired to a load that drives the busy state both ways', () => {
  for (const { file, field, desc } of PAGES) {
    const src = read(file);
    assert.ok(src.includes(`"refresh", "${desc}"`), `${file}: refresh button`);
    assert.match(src, new RegExp(`private View ${field};`), `${file}: keeps the button`);
    const on = (src.match(new RegExp(`UiChrome\\.setIconButtonBusy\\(${field}, true\\)`, 'g')) || []).length;
    const off = (src.match(new RegExp(`UiChrome\\.setIconButtonBusy\\(${field}, false\\)`, 'g')) || []).length;
    assert.ok(on >= 1, `${file}: spins while loading`);
    assert.ok(off >= 1, `${file}: stops when the load ends`);
    assert.match(src, /Toast\.makeText\(/, `${file}: a failed refresh is reported`);
  }
  const computers = read('ComputersActivity.java');
  const reload = between(computers, 'private void reload() {', '\n    private void addCard(');
  assert.match(reload, /if \(mLoading\) return;\s*mLoading = true;\s*UiChrome\.setIconButtonBusy\(mRefreshButton, true\);/, 'Computers: no overlapping reloads');
  assert.equal((reload.match(/UiChrome\.setIconButtonBusy\(mRefreshButton, false\)/g) || []).length, 2, 'Computers: success and failure both stop it');
  assert.match(reload, /Toast\.makeText\(this, error, Toast\.LENGTH_SHORT\)\.show\(\);/);
  const models = between(read('ModelsActivity.java'), 'private void loadModelConfig() {', '"ModelsLoad").start();');
  assert.equal((models.match(/UiChrome\.setIconButtonBusy\(mRefreshButton, false\)/g) || []).length, 3, 'Models: success, API error and failure all stop it');
  const viewer = read('ComputerViewerActivity.java');
  assert.match(between(viewer, 'private void refreshStatus() {', 'private void ensureDesktop()'), /UiChrome\.setIconButtonBusy\(mRefreshButton, true\)/);
  assert.match(between(viewer, 'private void applyBoxStatus(JSONObject st) {', 'private static boolean isAllowedVncPath'),
    /if \(mDestroyed\) return;\s*UiChrome\.setIconButtonBusy\(mRefreshButton, false\);/);
});

test('no page puts a refresh button in the header without a load behind it', () => {
  for (const name of fs.readdirSync(SRC).filter(n => n.endsWith('.java'))) {
    const src = fs.readFileSync(path.join(SRC, name), 'utf8');
    for (const m of src.matchAll(/makeVectorIconButton\(this, "refresh", "[^"]+", \w+, v -> ([^)]*)\(/g)) {
      assert.ok(PAGES.some(p => p.file === name), `${name}: header refresh (${m[1]}) must use setIconButtonBusy and be listed here`);
    }
  }
});

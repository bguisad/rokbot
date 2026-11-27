// Web ships the 1.3.0 desktop recipes (web/patchers/patch.mjs -> applyReleaseRecipes) and the Host
// migration wizard: their 「完成」 / submit paths never end in a silent no-op.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('web: connection / account dialogs submit on click even after an IME composition, and always show an error', () => {
  assert.match(read('web/patchers/patch.mjs'), /applyReleaseRecipes\(unpacked, recipes\)/, 'web uses the desktop recipes');
  const pane = read('windows/tools/desktop-recipes/extensions/general-pane.js');
  assert.doesNotMatch(pane, /if \(composing\.current \|\| submitting\.current/);
  assert.doesNotMatch(pane, /isComposing \|\| composing\.current/);
  assert.match(pane, /throw new Error\(result\.error \|\| grokText\('连接失败/);
  assert.match(pane, /setError\(failure\?\.message \|\| grokText\('操作失败，请重试。'/);
  assert.match(pane, /onClick: \(\) => setOpen\(false\), variant: 'primary', children: grokText\('完成', 'Done'\)/, '完成 closes the dialog');
});

test('web: the migration wizard shows the import report (and 完成) before refreshing the list', () => {
  const wizard = read('host/server/public/migrate-wizard.js');
  assert.equal(wizard, read('mac/clients/desktop/migrate-wizard.js'));
  const at = wizard.indexOf("const report = await adapter.import(preview.id, selection);");
  const report = wizard.indexOf("[button('完成', { primary: true, onClick: closeModal })]", at);
  const refresh = wizard.indexOf('try { await refresh(); } catch (error) { toast(', at);
  assert.ok(at > 0 && report > at && refresh > report, 'report first, refresh failure reported separately');
});

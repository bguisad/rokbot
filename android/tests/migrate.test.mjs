// Android "Migrate from Grok Bot": the prompt export entry, pending list and import confirmation.
// Physical migration of a data folder is desktop and web only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

test('android migration: first-level settings row opens the native migration page', () => {
  // rokbot.8: 数据迁移 / Data Migration is a row of the rokbot settings section (hermes-settings.mjs
  // MENU_LABELS.migrate), routed by RokBotBootstrap; the connection page no longer repeats it.
  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /matchesDataMigrationLabel\(s\)\) \{\s*return \(paired && isInteractiveTarget[^?]+\? MigrateActivity\.class/);
  assert.match(boot, /matchesDataMigrationLabel\(s\)\) \{\s*return MigrateActivity\.class/);
  const pairing = read('PairingActivity.java');
  assert.doesNotMatch(pairing, /MigrateActivity|open_migrate_row/);
  const manifest = fs.readFileSync(path.join(ROOT, 'patchers/manifest.mjs'), 'utf8');
  assert.match(manifest, /upsertAppChild\('activity', 'dev\.rokbot\.nativeapp\.MigrateActivity'/);
});

test('android migration: copy prompt, list and revoke upload URLs, review and confirm the import', () => {
  const page = read('MigrateActivity.java'), api = read('HostApiClient.java');
  for (const call of ['migrateOverview', 'migrateCreateToken', 'migratePrompt', 'migrateRevokeToken', 'migratePreview', 'migrateImport', 'migrateDiscard']) {
    assert.match(page, new RegExp(`HostApiClient\\.${call}\\(`), `page uses ${call}`);
    assert.match(api, new RegExp(`public static JSONObject ${call}\\(`), `client defines ${call}`);
  }
  for (const route of ['"/local/migrate"', '"/local/migrate/tokens"', '/local/migrate/prompt?scope=', '"/local/migrate/packages/"'])
    assert.ok(api.includes(route), route);
  assert.match(page, /ClipboardManager/);
  assert.match(page, /ChoiceField/, 'choices use the RokBot sheet');
  assert.doesNotMatch(page, /\bSpinner\b|AlertDialog\.Builder\(.*\)\.setItems/, 'no platform drop-downs or item dialogs');
  assert.doesNotMatch(page, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');
  assert.doesNotMatch(page.replace(/Grok Bot/g, ''), /Grok/, 'Grok only as the source product name');
  assert.match(page, /例程导入后全部暂停/);
});

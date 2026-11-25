import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { applyByteRecipe } from '../../mac/patchers/desktop/release-recipes.mjs';
import { buildRecipe, deterministicGzip, resolveTargets } from './desktop-recipes/build.mjs';
import { SPEC, TARGETS, specForTarget, targetMeta } from './desktop-recipes/spec.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const extensionsUrl = new URL('./desktop-recipes/extensions/', import.meta.url);
const addedBytes = recipe => Buffer.concat(recipe.ops.filter(op => op[0] === 'add').map(op => Buffer.from(op[1], 'base64')));

test('specForTarget and resolveTargets support both Windows and macOS 1.2.3 targets with SPEC backward compat', () => {
  assert.deepEqual(SPEC, specForTarget('windows'));
  assert.equal(targetMeta('windows').version, '1.2.3');
  assert.equal(targetMeta('mac').version, '1.2.3');
  assert.ok(TARGETS.windows.archive.url.includes('1.2.3'));
  assert.ok(TARGETS.mac.archive.url.includes('1.2.3'));
  assert.throws(() => targetMeta('linux'), /Unsupported recipe target/);

  assert.deepEqual(resolveTargets({}), ['windows']);
  assert.deepEqual(resolveTargets({ target: 'windows' }), ['windows']);
  assert.deepEqual(resolveTargets({ target: 'mac' }), ['mac']);
  assert.deepEqual(resolveTargets({ target: 'all' }), ['windows', 'mac']);
  assert.deepEqual(resolveTargets({ source: '/tmp/Grok_Bot_1.2.3.dmg' }), ['mac']);
  assert.deepEqual(resolveTargets({ source: '/Applications/Grok Bot.app/' }), ['mac']);
  assert.deepEqual(resolveTargets({ source: '/tmp/Grok_Bot_1.2.3_Setup.exe' }), ['windows']);
  assert.throws(() => resolveTargets({ target: 'all', source: '/tmp/foo.dmg' }), /cannot be combined/);
});

for (const target of ['windows', 'mac']) {
  test(`committed ${target} 1.2.3 recipes match specForTarget, normalize gzip OS byte, and carry all extensions verbatim`, async () => {
    const meta = targetMeta(target);
    const recipesDir = new URL(`../../${meta.recipesRelativeDir}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', recipesDir), 'utf8'));
    const sorted = [...specForTarget(target)].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

    assert.equal(manifest.schema, 'grokbot-desktop-recipes/v1');
    assert.deepEqual(manifest.files.map(e => [e.path, e.source]), sorted.map(e => [e.path, e.source]));

    const committed = await Promise.all(manifest.files.map(async (entry, index) => {
      const bytes = await readFile(new URL(entry.recipe, recipesDir));
      assert.equal(bytes[0], 0x1f);
      assert.equal(bytes[1], 0x8b);
      assert.equal(bytes[9], 0x03, `${target}/${entry.recipe} must normalize RFC 1952 gzip OS byte to 0x03`);
      assert.equal(entry.recipe, `${String(index).padStart(3, '0')}.gbp.gz`);
      assert.equal(entry.newFile, entry.source !== entry.path);
      assert.equal(sha(bytes), entry.sha256);
      const recipe = JSON.parse(gunzipSync(bytes).toString('utf8'));
      assert.equal(recipe.schema, 'grokbot-bytepatch/v1');
      assert.equal(recipe.targetBytes, entry.targetBytes);
      assert.equal(addedBytes(recipe).length, entry.addedBytes);
      return { entry, bytes, recipe };
    }));

    const diskNames = (await readdir(recipesDir)).sort();
    assert.deepEqual(diskNames, [...manifest.files.map(e => e.recipe), 'manifest.json'].sort());

    const extNames = (await readdir(extensionsUrl)).filter(name => name.endsWith('.js'));
    assert.ok(extNames.length >= 6);
    for (const name of extNames) {
      const source = await readFile(new URL(name, extensionsUrl));
      const carriers = committed.filter(({ recipe }) => addedBytes(recipe).includes(source));
      assert.equal(carriers.length, 1, `${target}: ${name} must be included verbatim in exactly one recipe`);
    }

    const updateEntry = committed.find(({ entry }) => entry.path.endsWith(meta.chunks.updateView));
    assert.ok(updateEntry);
    const updateAdded = addedBytes(updateEntry.recipe).toString('utf8');
    assert.match(updateAdded, /RokBot/);
    assert.match(updateAdded, /1\.2\.3/);
    assert.doesNotMatch(updateAdded, /'1\.1\.0'|'0\.71\.2'|alert\(|confirm\(/);

    const libraryEntry = committed.find(({ entry }) => entry.path.endsWith(meta.chunks.library));
    assert.ok(libraryEntry);
    const libraryAdded = addedBytes(libraryEntry.recipe).toString('utf8');
    assert.match(libraryAdded, /k\.useRef/);
    assert.match(libraryAdded, /export \{ de as GrokLibraryFiles \}/);

    const generalEntry = committed.find(({ entry }) => entry.path.endsWith(meta.chunks.generalPane));
    assert.ok(generalEntry);
    const generalAdded = addedBytes(generalEntry.recipe).toString('utf8');
    assert.match(generalAdded, /export \{ RokModelConfigModal, RokUsageSettings \}/);
    assert.match(generalAdded, /RokModelSettings/);
    // Settings > General lists the Host's usage per model right after the chat models.
    assert.ok(generalAdded.startsWith("import { grokText } from './grok-local-i18n.js';\nimport { formatCount as rokFormatCount, formatExactCount as rokFormatExactCount, formatTokens as rokFormatTokens, withRequestUnit as rokWithRequestUnit } from './rok-usage-format.js';\n"));
    assert.match(generalAdded, /\(0,\$\.jsx\)\(RokModelSettings,\{\}\),\(0,\$\.jsx\)\(RokUsageSettings,\{\}\),\(0,\$\.jsx\)\(GrokRealtimeVoiceSettings,\{\}\)/);
    // The settings format counts with the admin page's own file, unchanged.
    const formatEntry = committed.find(({ entry }) => entry.path === 'dist/renderer/assets/rok-usage-format.js');
    assert.ok(formatEntry);
    assert.equal(formatEntry.entry.source, null);
    assert.equal(formatEntry.entry.newFile, true);
    assert.deepEqual(addedBytes(formatEntry.recipe), await readFile(new URL('../../host/server/public/usage-format.js', import.meta.url)));

    const eagerEntry = committed.find(({ entry }) => entry.path.endsWith(meta.chunks.eagerApp));
    assert.ok(eagerEntry);
    const eagerAdded = addedBytes(eagerEntry.recipe).toString('utf8');
    assert.match(eagerAdded, /RokNeedsModelBanner/);
    assert.match(eagerAdded, /RokModelConfigHost/);
    assert.match(eagerAdded, /rokbot-local:model-config-request/);
  });
}

test('deterministicGzip normalizes gzip OS byte and buildRecipe replays accurately', () => {
  const gz = deterministicGzip(Buffer.from('{"hello":"world"}'));
  assert.equal(gz[9], 0x03);
  assert.equal(gunzipSync(gz).toString('utf8'), '{"hello":"world"}');

  const source = Buffer.from('function a(){return 1}export{a};');
  const { recipe, target } = buildRecipe({
    path: 'sample.js',
    edits: [{ replace: 'return 1', text: 'return 2' }, { append: '\nexport{a as b};' }],
  }, source);
  assert.equal(target.toString('utf8'), 'function a(){return 2}export{a};\nexport{a as b};');
  assert.equal(applyByteRecipe(source, recipe).equals(target), true);
});

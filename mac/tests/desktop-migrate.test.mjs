import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { candidateFolders, collectFolder, detectFolders, createMigration } from '../clients/desktop/migrate-desktop.mjs';
import { bundleFromUpload } from '../../host/server/migrate-sources.mjs';
import { writeGrokBotFolder } from '../../host/tests/migrate-fixtures.mjs';

const root = new URL('../clients/desktop/', import.meta.url);
const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'rokbot-desktop-migrate-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('desktop migration: data folder candidates on macOS, Windows and Linux', () => {
  assert.deepEqual(candidateFolders({ platform: 'darwin', home: '/Users/me' }).map(item => item.path),
    ['/Users/me/Library/Application Support/Grok Bot', '/Users/me/Library/Application Support/Grok Bot Local']);
  assert.deepEqual(candidateFolders({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }).map(item => item.path),
    ['C:\\Users\\me\\AppData\\Roaming\\Grok Bot', 'C:\\Users\\me\\AppData\\Roaming\\Grok Bot Local']);
  assert.deepEqual(candidateFolders({ platform: 'linux', home: '/home/me', env: {} }).map(item => item.path),
    ['/home/me/.config/Grok Bot', '/home/me/.config/Grok Bot Local']);
  assert.equal(candidateFolders({ platform: 'linux', home: '/home/me', env: { XDG_CONFIG_HOME: '/cfg' } })[0].path, '/cfg/Grok Bot');
});

test('desktop migration: packs only cache files, never credential contents, and leaves the folder untouched', async t => {
  const dir = await temp(t), folder = await writeGrokBotFolder(join(dir, 'Grok Bot'));
  const before = await Promise.all((await readdir(folder, { recursive: true })).map(async name => [name, (await stat(join(folder, name))).mtimeMs]));
  const found = await detectFolders({ platform: 'linux', home: dir, env: { XDG_CONFIG_HOME: dir } });
  assert.equal(found.length, 1);
  assert.equal(found[0].cacheFiles, 5);
  const { zip, files } = await collectFolder(folder);
  assert.equal(files, 5);
  assert.ok(!zip.includes(Buffer.from('SECRET')), 'no credential bytes are packed');
  await writeFile(join(dir, 'packed.zip'), zip);
  const bundle = await bundleFromUpload(join(dir, 'packed.zip'));
  assert.deepEqual(bundle.bots.map(bot => bot.name), ['写作助手', 'Research']);
  assert.ok(bundle.secrets.some(secret => secret.name.startsWith('例程 Webhook 密钥（1 个）')));
  assert.ok(bundle.secrets.some(secret => secret.name === 'Grok Bot 账号登录状态'));
  const after = await Promise.all((await readdir(folder, { recursive: true })).map(async name => [name, (await stat(join(folder, name))).mtimeMs]));
  assert.deepEqual(after, before, 'the Grok Bot folder is only read');
  await assert.rejects(collectFolder(dir), /没有找到 Grok Bot 数据/);
});

test('desktop migration: uploads stream to the device API with the device credential', async t => {
  const dir = await temp(t), folder = await writeGrokBotFolder(join(dir, 'Grok Bot')), calls = [];
  const migration = createMigration({ getConfig: () => ({ server: 'https://host.example', token: 'device-token' }),
    request: async (endpoint, body, signal, method) => { calls.push([method, endpoint, body]); return { ok: true }; },
    clipboard: { writeText: text => calls.push(['copy', text]) }, dialog: {}, getWindow: () => null,
    fetchImpl: async (url, init) => {
      const chunks = []; for await (const chunk of init.body instanceof ReadableStream ? init.body : [init.body]) chunks.push(Buffer.from(chunk));
      calls.push(['upload', url, init.headers.authorization, Buffer.concat(chunks).length]);
      return new Response(JSON.stringify({ id: 'p'.repeat(16), counts: { bots: 2 } }), { status: 201 });
    } });
  const progress = [];
  assert.equal((await migration.uploadFolder(folder, value => progress.push(value))).counts.bots, 2);
  await writeFile(join(dir, 'export.json'), '{"schema":"rokbot.migrate","version":1}');
  await migration.uploadFile(join(dir, 'export.json'));
  await migration.import('p'.repeat(16), { conflict: 'skip' });
  await migration.revokeToken('abc');
  migration.copy('prompt');
  const uploads = calls.filter(call => call[0] === 'upload');
  assert.match(uploads[0][1], /^https:\/\/host\.example\/local\/migrate\/packages\?name=/);
  assert.equal(uploads[0][2], 'Bearer device-token');
  assert.equal(uploads[1][3], 39);
  assert.deepEqual(calls.find(call => call[1]?.endsWith('/import')), ['POST', `/local/migrate/packages/${'p'.repeat(16)}/import`, { conflict: 'skip' }]);
  assert.deepEqual(calls.find(call => call[0] === 'DELETE'), ['DELETE', '/local/migrate/tokens/abc', null]);
  assert.ok(progress.at(-1) === 1);
});

test('desktop migration: shared wizard copy, settings entry and window wiring', async () => {
  for (const name of ['migrate-wizard.js', 'migrate-wizard.css'])
    assert.equal(await readFile(new URL(name, root), 'utf8'), await readFile(new URL(`../../../host/server/public/${name}`, root), 'utf8'), `${name} matches the Host copy`);
  const ui = (await Promise.all(['migrate-wizard.js', 'migrate.js', 'migrate.html', 'migrate-settings.cjs'].map(name => readFile(new URL(name, root), 'utf8')))).join('\n');
  assert.doesNotMatch(ui, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji');
  assert.doesNotMatch(ui, /<select|createElement\('select'\)/, 'choices use the RokBot segmented control, not native drop-downs');
  assert.doesNotMatch(ui.replace(/Grok Bot/g, ''), /Grok/, 'Grok only appears as the migration source "Grok Bot"');
  const main = await readFile(new URL('main.mjs', root), 'utf8'), preload = await readFile(new URL('preload.cjs', root), 'utf8');
  assert.match(preload, /require\('\.\/migrate-settings\.cjs'\)/);
  assert.match(main, /if \(!trusted\(event, migrateWindow\)\) throw new Error\('Unexpected renderer'\)/);
  assert.match(main, /migrate-preload\.cjs'\), sandbox: true/);
  assert.match(await readFile(new URL('migrate.html', root), 'utf8'), /Content-Security-Policy" content="default-src 'none'; script-src 'self'/);
});

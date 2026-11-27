import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCommandArgs, splitCommand, parsePort } from '../lib/args.mjs';
import {
  DEFAULT_IMAGES, maskEnv, parseEnv, renderImageEnv, renderSourceEnvPreview, resolveHostSettings, localAdminOrigin,
} from '../lib/config.mjs';
import {
  applyAdminReset, generatePassword, hashAdminPassword, RESET_SCRIPT, validatePassword, verifyAdminPassword,
} from '../lib/admin.mjs';
import { checkAndroidSigning, checkCertificate, checkDisk, checkNode, RELEASE_PIN_PREFIX } from '../lib/doctor.mjs';
import { identifyDesktopInput, identifyAndroidInput, missingInputMessage, patcherCommand, PLATFORMS } from '../lib/pack.mjs';
import { rewriteImages } from '../lib/ops.mjs';
import { COMMAND_HELP, MAIN_HELP } from '../lib/help.mjs';
import { createSigningIdentity } from '../../../android/patchers/signing.mjs';
import { computeCertificateSha256, RELEASE_CERTIFICATE_SHA256 } from '../../../android/release/signing-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const bin = path.join(repo, 'bin', 'rokbot.mjs');

function cli(args, { env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8', input, timeout: 120_000,
    env: { ...process.env, ROKBOT_HOME: path.join(os.tmpdir(), 'rokbot-cli-test-none'), ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function tempDir(t, prefix = 'rokbot-cli-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function writeKeystore(filename, identity) {
  return writeFile(filename, JSON.stringify({
    schema: 'rokbot-android-signing/v1',
    privateKey: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certificate: identity.certificate.toString('base64'),
  }), { mode: 0o600 });
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

// ---------- argument parsing ----------

test('args: options, positionals, -- passthrough and errors', () => {
  const parsed = parseCommandArgs(['android', '--input', 'a.xapk', '--force', '--', '--app-version', '1.0.0'],
    { input: { type: 'string' }, force: { type: 'boolean' } }, { positionals: 1 });
  assert.deepEqual(parsed.positionals, ['android']);
  assert.equal(parsed.values.input, 'a.xapk');
  assert.equal(parsed.values.force, true);
  assert.deepEqual(parsed.rest, ['--app-version', '1.0.0']);
  assert.equal(parseCommandArgs(['--input=x'], { input: { type: 'string' } }).values.input, 'x');
  assert.throws(() => parseCommandArgs(['--nope'], {}), /未知选项 --nope/);
  assert.throws(() => parseCommandArgs(['--input', 'a', '--input', 'b'], { input: { type: 'string' } }), /不能重复指定/);
  assert.throws(() => parseCommandArgs(['--input'], { input: { type: 'string' } }), /需要参数/);
  assert.throws(() => parseCommandArgs(['a', 'b'], {}, { positionals: 1 }), /多余的参数/);
  assert.throws(() => parseCommandArgs(['--input', ' '], { input: { type: 'string' } }), /非空参数/);
});

test('args: secrets are refused as command-line values', () => {
  for (const flag of ['--password', '--password=hunter2hunter2', '--setup-key', '--api-key', '--token'])
    assert.throws(() => parseCommandArgs([flag, 'x'], {}), error => error.exitCode === 2 && /shell 历史/.test(error.message));
  const result = cli(['admin', '--password', 'hunter2hunter2']);
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.stderr + result.stdout, /hunter2/);
});

test('args: splitCommand keeps leading --home and parsePort bounds', () => {
  assert.deepEqual(splitCommand(['--home', '/x', 'status', '--json']), { command: 'status', args: ['--home', '/x', '--json'] });
  assert.deepEqual(splitCommand(['--help']), { command: null, args: ['--help'] });
  assert.equal(parsePort('18080', 'p'), 18080);
  assert.equal(parsePort(undefined, 'p'), undefined);
  for (const bad of ['0', '65536', 'abc', '-1', '1.5']) assert.throws(() => parsePort(bad, '--port'), /1–65535/);
});

// ---------- configuration ----------

test('config: defaults follow deploy.py and the image compose file', () => {
  const settings = resolveHostSettings({});
  assert.equal(settings.mode, 'image');
  assert.equal(settings.port, 18080);
  assert.equal(settings.webPort, 18081);
  assert.equal(settings.listen, '127.0.0.1');
  assert.equal(settings.adminUrl, 'http://127.0.0.1:18080/admin');
  assert.equal(settings.webUrl, 'http://127.0.0.1:18081/web/');
  assert.equal(settings.hostImage, DEFAULT_IMAGES.host);
  const compose = readFileSync(path.join(repo, 'host/release/docker-compose.images.yml'), 'utf8');
  assert.ok(compose.includes(`\${ROKBOT_HOST_IMAGE:-${DEFAULT_IMAGES.host}}`));
  assert.ok(compose.includes(`\${ROKBOT_BOX_IMAGE:-${DEFAULT_IMAGES.box}}`));
});

test('config: validation rules', () => {
  assert.throws(() => resolveHostSettings({ listen: '192.168.1.10' }), /--public-url/);
  assert.throws(() => resolveHostSettings({ port: 18080, webPort: 18080 }), /不能与 --port 相同/);
  assert.throws(() => resolveHostSettings({ publicUrl: 'https://bot.example.com/sub' }), /源地址/);
  assert.throws(() => resolveHostSettings({ publicUrl: 'https://user:pw@bot.example.com' }), /源地址/);
  assert.throws(() => resolveHostSettings({ publicUrl: 'ftp://bot.example.com' }), /源地址/);
  assert.throws(() => resolveHostSettings({ listen: 'not-an-ip' }), /IP 地址/);
  assert.throws(() => resolveHostSettings({ project: 'Bad Name' }), /--project/);
  assert.throws(() => resolveHostSettings({ mode: 'other' }), /--mode/);
  assert.throws(() => resolveHostSettings({ hostOnly: true }), /源码模式/);
  assert.throws(() => resolveHostSettings({ publicUrl: 'https://bot.example.com', webPublicUrl: 'https://bot.example.com/' }), /网页版地址必须与管理页地址不同/);
  const lan = resolveHostSettings({ listen: '192.168.1.10', publicUrl: 'http://192.168.1.10:18080/' });
  assert.equal(lan.publicUrl, 'http://192.168.1.10:18080');
  assert.equal(lan.webUrl, 'http://192.168.1.10:18081/web/');
});

test('config: image .env is rendered from .env.images.example', () => {
  const template = readFileSync(path.join(repo, 'host/release/.env.images.example'), 'utf8');
  const text = renderImageEnv(resolveHostSettings({ port: 28080, project: 'rokbot-two', tz: 'Asia/Shanghai', publicUrl: 'https://bot.example.com',
    hostImage: 'mirror.example.com/rokbot/host:1', boxImage: 'mirror.example.com/rokbot/box:1' }));
  const env = parseEnv(text);
  assert.equal(env.ROKBOT_PUBLIC_PORT, '28080');
  assert.equal(env.ROKBOT_WEB_PUBLIC_PORT, '28081');
  assert.equal(env.ROKBOT_PUBLIC_URL, 'https://bot.example.com');
  assert.equal(env.COMPOSE_PROJECT_NAME, 'rokbot-two');
  assert.equal(env.TZ, 'Asia/Shanghai');
  assert.equal(env.ROKBOT_HOST_IMAGE, 'mirror.example.com/rokbot/host:1');
  assert.equal(env.ROKBOT_BOX_TOKEN, 'local');
  // Comments from the template stay; only one assignment per key.
  for (const line of template.split('\n').filter(line => line.startsWith('# ----'))) assert.ok(text.includes(line));
  assert.equal(text.match(/^ROKBOT_PUBLIC_PORT=/gm).length, 1);
  assert.doesNotMatch(text, /^ROKBOT_ADMIN_PASSWORD=/m);
  // Default project keeps the compose file's own `name: rokbot`.
  assert.equal(parseEnv(renderImageEnv(resolveHostSettings({}))).COMPOSE_PROJECT_NAME, undefined);
  assert.equal(maskEnv('ROKBOT_X_SECRET=abc\nROKBOT_PUBLIC_PORT=1'), 'ROKBOT_X_SECRET=********\nROKBOT_PUBLIC_PORT=1');
  assert.equal(localAdminOrigin({ ROKBOT_LISTEN_ADDRESS: '0.0.0.0', ROKBOT_PUBLIC_PORT: '28080' }), 'http://127.0.0.1:28080');
});

test('config: source-mode preview is byte-identical to host/deploy.py init', async t => {
  const python = spawnSync('python3', ['--version']);
  if (python.status !== 0) { t.skip('python3 not available'); return; }
  const home = await tempDir(t);
  const result = spawnSync('python3', [path.join(repo, 'host/deploy.py'), '--home', home, '--project', 'rokbot-preview', 'init',
    '--listen', '192.168.1.10', '--port', '28080', '--web-port', '28090', '--public-url', 'http://192.168.1.10:28080'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const settings = resolveHostSettings({ mode: 'source', project: 'rokbot-preview', listen: '192.168.1.10', port: 28080, webPort: 28090, publicUrl: 'http://192.168.1.10:28080' });
  assert.equal(renderSourceEnvPreview(settings), readFileSync(path.join(home, '.env'), 'utf8'));
  assert.equal(statSync(path.join(home, '.env')).mode & 0o777, 0o600);
});

test('init --dry-run writes nothing', async t => {
  const home = path.join(await tempDir(t), 'instance');
  const result = cli(['init', '--dry-run', '--home', home, '--port', '28080', '--project', 'rokbot-dryrun']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--dry-run，没有写入任何文件/);
  assert.match(result.stdout, /ROKBOT_PUBLIC_PORT=28080/);
  assert.equal(existsSync(home), false);
  const source = cli(['init', '--dry-run', '--yes', '--mode', 'source', '--home', home]);
  assert.equal(source.code, 0, source.stderr);
  assert.match(source.stdout, /git clone https:\/\/github\.com\/hongfaqiu\/rokbot\.git/);
  assert.match(source.stdout, /ROKBOT_MODE=local/);
  assert.equal(cli(['init', '--dry-run', '--home', home, '--listen', '10.0.0.2']).code, 2);
});

test('init (image mode) writes .env and state with mode 600 and refuses to overwrite', async t => {
  if (spawnSync('docker', ['compose', 'version']).status !== 0) { t.skip('docker compose not available'); return; }
  const home = path.join(await tempDir(t), 'instance');
  const project = `rokbot-clitest-${process.pid}`;
  const result = cli(['init', '--yes', '--no-pull', '--home', home, '--project', project, '--port', '38080']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  for (const name of ['.env', 'rokbot.json']) assert.equal(statSync(path.join(home, name)).mode & 0o777, 0o600, name);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  const env = parseEnv(readFileSync(path.join(home, '.env'), 'utf8'));
  assert.equal(env.COMPOSE_PROJECT_NAME, project);
  assert.equal(env.ROKBOT_PUBLIC_PORT, '38080');
  assert.ok(existsSync(path.join(home, 'docker-compose.images.yml')));
  const state = JSON.parse(readFileSync(path.join(home, 'rokbot.json'), 'utf8'));
  assert.equal(state.mode, 'image');
  assert.equal(state.project, project);
  const again = cli(['init', '--yes', '--no-pull', '--home', home, '--project', project]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /不会覆盖/);
});

// ---------- admin ----------

test('admin: generated passwords are strong and validated', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const password = generatePassword();
    assert.equal(password.length, 24);
    assert.match(password, /^[A-HJ-NP-Za-km-z2-9]+$/);
    seen.add(password);
  }
  assert.equal(seen.size, 50);
  assert.throws(() => validatePassword('short'), /12–128/);
  assert.throws(() => validatePassword('x'.repeat(129)), /12–128/);
  assert.throws(() => validatePassword('abcdefghijkl\n'), /控制字符/);
  assert.equal(validatePassword('correct horse battery'), 'correct horse battery');
});

test('admin: hash uses the Host scrypt record and verifies with the Host code', async () => {
  const record = await hashAdminPassword('correct horse battery');
  assert.match(record.salt, /^[0-9a-f]{32}$/);
  assert.match(record.hash, /^[0-9a-f]{128}$/);
  assert.equal(JSON.stringify(record).includes('correct horse'), false);
  const security = await import(path.join(repo, 'host/server/security.mjs'));
  assert.equal(await security.verifyPassword('correct horse battery', record), true);
  assert.equal(await verifyAdminPassword('wrong password!!', record), false);
});

test('admin: reset script rewrites auth.json atomically with mode 600', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'auth.json');
  const old = await hashAdminPassword('old password value');
  await writeFile(file, JSON.stringify({ version: 1, admin: old, sessions: [{ hash: 'a', expiresAt: Date.now() + 1e6 }],
    devices: [{ id: 'd1', name: 'phone' }], pairing: [] }), { mode: 0o644 });
  const admin = await hashAdminPassword('new password value');
  const run = input => spawnSync(process.execPath, ['--input-type=module', '-e', RESET_SCRIPT], { input, encoding: 'utf8', env: { ...process.env, ROKBOT_AUTH_FILE: file } });
  const result = run(JSON.stringify({ admin }));
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(state.admin, admin);
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.devices, [{ id: 'd1', name: 'phone' }]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await verifyAdminPassword('new password value', state.admin), true);
  assert.equal(await verifyAdminPassword('old password value', state.admin), false);
  // A malformed record is rejected and leaves the file untouched.
  const before = readFileSync(file, 'utf8');
  assert.notEqual(run(JSON.stringify({ admin: { salt: 'x', hash: 'y' } })).status, 0);
  assert.equal(readFileSync(file, 'utf8'), before);
  // Not initialized yet: exit code 3.
  const missing = spawnSync(process.execPath, ['--input-type=module', '-e', RESET_SCRIPT],
    { input: JSON.stringify({ admin }), encoding: 'utf8', env: { ...process.env, ROKBOT_AUTH_FILE: path.join(dir, 'none.json') } });
  assert.equal(missing.status, 3);
  assert.throws(() => applyAdminReset(JSON.stringify({ version: 2 }), admin), /Unsupported/);
});

test('admin: needs an instance', () => {
  const result = cli(['admin', '--status']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rokbot init/);
});

// ---------- pack ----------

test('pack: missing --input explains where the official package comes from, without a download', () => {
  for (const platform of Object.keys(PLATFORMS)) {
    const result = cli(['pack', platform]);
    assert.equal(result.code, 2, platform);
    assert.match(result.stderr, /缺少 --input/);
    assert.match(result.stderr, /官方渠道/);
    assert.match(result.stderr, /不提供/);
    assert.doesNotMatch(result.stderr, /https?:\/\//);
    assert.equal(missingInputMessage(platform).includes('http'), false);
  }
  assert.equal(cli(['pack']).code, 2);
  assert.match(cli(['pack', 'symbian', '--input', 'x']).stderr, /不支持的平台/);
  assert.match(cli(['pack', 'linux', '--input', '/nonexistent/file.deb']).stderr, /找不到/);
  assert.match(cli(['pack', 'linux', '--input', 'x.deb', '--', '--source', 'y']).stderr, /不能再指定输入/);
});

test('pack: inputs are matched by size and SHA-256 against the repository pins', async t => {
  const dir = await tempDir(t);
  const fake = path.join(dir, 'fake.deb');
  await writeFile(fake, 'not an installer');
  const pins = [{ version: '9.9.9', files: [{ bytes: 16, sha256: 'a'.repeat(64) }], asar: 'b'.repeat(64), asarPath: 'resources/app.asar' }];
  await assert.rejects(identifyDesktopInput('linux', fake, pins), /不是受支持的/);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update('not an installer').digest('hex');
  const hit = await identifyDesktopInput('linux', fake, [{ ...pins[0], files: [{ bytes: 16, sha256: digest }] }]);
  assert.equal(hit.version, '9.9.9');
  const result = cli(['pack', 'linux', '--input', fake]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /大小或 SHA-256 与固定摘要不符/);
  await assert.rejects(identifyAndroidInput(fake), /\.xapk/);
});

test('pack: patcher commands always pass the local input and never rely on a download', () => {
  const values = { force: true };
  for (const platform of Object.keys(PLATFORMS)) {
    const plan = patcherCommand(platform, { input: '/in/file', outputDir: '/out/x', values, rest: [], temporary: '/tmp/t' });
    const flag = { android: '--input-apk', ios: '--input' }[platform] ?? '--source';
    assert.equal(plan.args[plan.args.indexOf(flag) + 1], '/in/file', platform);
    assert.ok(plan.args.some(arg => arg.startsWith('/out/x')), platform);
    assert.ok(existsSync(plan.args[0]), `${platform} patcher ${plan.args[0]}`);
  }
});

test('pack: the official Android input is recognised (ROKBOT_ANDROID_TEST_XAPK)', async t => {
  const xapk = process.env.ROKBOT_ANDROID_TEST_XAPK;
  if (!xapk || !existsSync(xapk)) { t.skip('ROKBOT_ANDROID_TEST_XAPK not set'); return; }
  const identified = await identifyAndroidInput(xapk);
  assert.match(identified.version, /^1\.26\.0 \(3212\)$/);
  const result = cli(['pack', 'android', '--input', xapk, '--dry-run', '--dev-signing', '--output', path.join(os.tmpdir(), 'rokbot-cli-test-dist')]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /patch-android\.mjs --input-apk/);
});

// ---------- doctor ----------

test('doctor: the pinned release certificate starts with 46214d3d', () => {
  assert.ok(RELEASE_CERTIFICATE_SHA256.startsWith(RELEASE_PIN_PREFIX));
  const pin = JSON.parse(readFileSync(path.join(repo, 'android/release/signing-pin.json'), 'utf8'));
  assert.ok(pin.releaseCertificateSha256.startsWith('46214d3d'));
});

test('doctor: Android signing key missing or wrong fails unless dev signing is explicit', async t => {
  const dir = await tempDir(t);
  const env = { HOME: dir };
  const missing = await checkAndroidSigning({ env });
  assert.equal(missing.status, 'fail');
  assert.match(missing.message, /找不到正式签名密钥/);
  assert.match(missing.message, /--dev-signing/);

  const identity = createSigningIdentity({ type: 'rsa', modulusLength: 2048 });
  const keystore = path.join(dir, 'other.json');
  await writeKeystore(keystore, identity);
  const wrong = await checkAndroidSigning({ keystore, env });
  assert.equal(wrong.status, 'fail');
  assert.match(wrong.message, /不是正式证书/);
  assert.match(wrong.message, /46214d3d/);

  const devFlag = await checkAndroidSigning({ keystore, env, devSigning: true });
  assert.equal(devFlag.status, 'warn');
  assert.match(devFlag.message, /临时开发签名/);
  const devEnv = await checkAndroidSigning({ env: { ...env, ROKBOT_ANDROID_DEV_SIGNING: '1' } });
  assert.equal(devEnv.status, 'warn');

  await writeFile(path.join(dir, 'broken.json'), '{"schema":"x"}');
  assert.equal((await checkAndroidSigning({ keystore: path.join(dir, 'broken.json'), env })).status, 'fail');

  const sha = computeCertificateSha256(identity.certificate);
  const matching = await checkAndroidSigning({ keystore, env, pinSha256: sha });
  assert.equal(matching.status, 'ok');
});

test('doctor: node, disk and certificate checks', async () => {
  assert.equal(checkNode('24.1.0').status, 'ok');
  assert.equal(checkNode('18.20.0').status, 'fail');
  const disk = free => checkDisk('/', { statfs: () => ({ bavail: free / 4096, bsize: 4096 }) });
  assert.equal(disk(100 * 1024 ** 3).status, 'ok');
  assert.equal(disk(10 * 1024 ** 3).status, 'warn');
  assert.equal(disk(1024 ** 3).status, 'fail');
  assert.equal((await checkCertificate(null)).status, 'ok');
  assert.equal((await checkCertificate('http://127.0.0.1:18080')).status, 'ok');
  assert.equal((await checkCertificate('http://192.168.1.10:18080')).status, 'warn');
});

test('doctor --json reports the signing check', () => {
  const home = path.join(os.tmpdir(), 'rokbot-cli-test-none');
  const result = cli(['doctor', '--json', '--skip-network', '--home', home], { env: { HOME: path.join(os.tmpdir(), 'rokbot-cli-test-nohome') } });
  const report = JSON.parse(result.stdout);
  const signing = report.results.find(item => item.name === '安卓签名密钥');
  assert.equal(signing.status, 'fail');
  assert.equal(result.code, 1);
  assert.equal(report.ok, false);
});

// ---------- help, output rules, install ----------

test('help: Chinese, no emoji, product name only where pack describes its input', () => {
  const main = cli(['--help']);
  assert.equal(main.code, 0);
  assert.match(main.stdout, /用法：rokbot <命令>/);
  for (const command of Object.keys(COMMAND_HELP)) {
    const result = cli([command, '--help']);
    assert.equal(result.code, 0, command);
    assert.equal(result.stdout.trim(), COMMAND_HELP[command]);
    assert.equal(cli(['help', command]).stdout.trim(), COMMAND_HELP[command]);
  }
  for (const text of [MAIN_HELP, ...Object.values(COMMAND_HELP)]) assert.doesNotMatch(text, PICTOGRAPHIC);
  for (const [command, text] of Object.entries({ main: MAIN_HELP, ...COMMAND_HELP })) {
    if (command === 'pack') assert.match(text, /Grok Bot 官方原版安装包/);
    else assert.doesNotMatch(text, /grok/i, command);
  }
  assert.equal(cli(['frobnicate']).code, 2);
  assert.match(cli(['--version']).stdout, /^\d+\.\d+\.\d+/);
});

test('ops: rollback rewrites only the image lines of .env', () => {
  const before = '# c\nROKBOT_HOST_IMAGE=a\nROKBOT_PUBLIC_PORT=1\n';
  const after = rewriteImages(before, { host: 'rokbot-rollback/p-host:1', box: 'rokbot-rollback/p-box:1' });
  assert.equal(after, '# c\nROKBOT_HOST_IMAGE=rokbot-rollback/p-host:1\nROKBOT_PUBLIC_PORT=1\nROKBOT_BOX_IMAGE=rokbot-rollback/p-box:1\n');
});

test('install-cli.sh links bin/rokbot.mjs into the bin directory', async t => {
  const dir = await tempDir(t);
  const result = spawnSync('bash', [path.join(repo, 'scripts/install-cli.sh')], { encoding: 'utf8', env: { ...process.env, ROKBOT_BIN_DIR: dir } });
  assert.equal(result.status, 0, result.stderr);
  const link = path.join(dir, 'rokbot');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), path.join(repo, 'bin/rokbot.mjs'));
  const help = spawnSync(link, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /rokbot：RokBot/);
});

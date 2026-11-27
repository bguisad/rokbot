// The published npm package: `npm pack` the repository root, unpack the tarball into a temporary
// directory (no .git, no patchers) and run the CLI from there, as `npx rokbot` / `npm i -g rokbot` would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let work;
let packed;
let packageDir;

test.before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'rokbot-npm-test-'));
  const result = spawnSync(npm, ['pack', '--json', '--pack-destination', work], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  packed = JSON.parse(result.stdout)[0];
  const extract = path.join(work, 'extract');
  await mkdir(extract);
  const untar = spawnSync('tar', ['-xzf', path.join(work, packed.filename), '-C', extract], { encoding: 'utf8' });
  assert.equal(untar.status, 0, untar.stderr);
  packageDir = path.join(extract, 'package');
  await mkdir(path.join(work, 'home'));
});

test.after(() => rm(work, { recursive: true, force: true }));

function cli(args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [path.join(packageDir, 'bin', 'rokbot.mjs'), ...args], {
    cwd: work, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, HOME: path.join(work, 'home'), ROKBOT_HOME: path.join(work, 'instance'), ROKBOT_CLI_DEBUG: '', ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const STACK = /\n\s+at .+:\d+:\d+/;

test('npm package: small, CLI-only file list without secrets, keys, binaries or installers', () => {
  const files = packed.files.map(file => file.path);
  assert.ok(packed.size < 1024 * 1024, `packed size ${packed.size}`);
  assert.equal(packed.name, 'rokbot');
  for (const required of ['bin/rokbot.mjs', 'scripts/cli/main.mjs', 'scripts/cli/lib/pack.mjs', 'host/release/docker-compose.images.yml',
    'host/release/.env.images.example', 'host/release/install-images.sh', 'host/release/backup.py', 'host/server/security.mjs',
    'android/release/signing-guard.mjs', 'android/release/signing-pin.json', 'android/patchers/signing.mjs',
    'LICENSE', 'NOTICE', 'README.md', 'docs/cli.md', 'package.json'])
    assert.ok(files.includes(required), `missing ${required}`);
  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(node_modules|tests?|\.git)\//, file);
    assert.doesNotMatch(file, /(^|\/)\.env$|android-signing\.json$|\.(jks|keystore|p8|p12|pem|key|mobileprovision)$/i, file);
    assert.doesNotMatch(file, /\.(apk|xapk|apks|aab|ipa|dmg|exe|7z|deb|asar|rbdelta|gbdelta)$/i, file);
    assert.doesNotMatch(file, /tailcat/i, file);
    assert.doesNotMatch(file, /patchers\/(desktop|patch)|patch-android|patch-ios|recipes\//, file);
  }
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.bin.rokbot, 'bin/rokbot.mjs');
});

test('npm package: --help and --version', () => {
  const help = cli(['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /rokbot <命令>/);
  const version = cli(['--version']);
  assert.equal(version.stdout.trim(), JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
  assert.equal(cli(['pack', '--help']).code, 0);
});

test('npm package: doctor runs every check and explains that packing needs the source', () => {
  const result = cli(['doctor', '--json', '--skip-network']);
  assert.ok(result.code === 0 || result.code === 1, result.stderr);
  assert.doesNotMatch(result.stderr, STACK);
  const report = JSON.parse(result.stdout);
  const byName = Object.fromEntries(report.results.map(item => [item.name, item]));
  assert.equal(byName['安卓签名密钥'].status, 'fail'); // the temporary HOME has no release key
  assert.match(byName['安卓签名密钥'].message, /找不到正式签名密钥/);
  assert.equal(byName['桌面打包依赖'].status, 'warn');
  assert.match(byName['桌面打包依赖'].message, /rokbot init --mode source/);
  const text = cli(['doctor', '--skip-network']);
  assert.match(text.stdout, /RokBot 环境检查/);
});

test('npm package: init --dry-run --yes (image and source mode) writes nothing', () => {
  const image = cli(['init', '--dry-run', '--yes']);
  assert.equal(image.code, 0, image.stderr);
  assert.match(image.stdout, /镜像模式/);
  assert.match(image.stdout, /ROKBOT_HOST_IMAGE=/);
  const source = cli(['init', '--dry-run', '--yes', '--mode', 'source']);
  assert.equal(source.code, 0, source.stderr);
  assert.match(source.stdout, /git clone https:\/\/github\.com\/hongfaqiu\/rokbot\.git/);
  assert.equal(existsSync(path.join(work, 'instance')), false);
});

test('npm package: pack explains how to get the source instead of crashing', async () => {
  const input = path.join(work, 'input.xapk');
  await writeFile(input, 'not an installer');
  for (const platform of ['android', 'linux', 'web', 'ios']) {
    const result = cli(['pack', platform, '--input', input]);
    assert.equal(result.code, 1, `${platform}: ${result.stderr}`);
    assert.match(result.stderr, /rokbot init --mode source/);
    assert.match(result.stderr, /--src/);
    assert.doesNotMatch(result.stderr, STACK);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|ENOENT/);
  }
  const missingSrc = cli(['pack', 'linux', '--input', input, '--src', path.join(work, 'nowhere')]);
  assert.equal(missingSrc.code, 1);
  assert.match(missingSrc.stderr, /不是完整的 RokBot 源码目录/);
  // Missing --input is still explained first.
  assert.match(cli(['pack', 'android']).stderr, /缺少 --input/);
});

test('npm package: pack uses --src or the source directory recorded by init --mode source', async () => {
  const fake = path.join(work, 'fake.deb');
  await writeFile(fake, Buffer.alloc(1024));
  const explicit = cli(['pack', 'linux', '--input', fake, '--src', repo]);
  assert.equal(explicit.code, 2, explicit.stderr);
  assert.match(explicit.stdout, /使用源码目录/);
  assert.match(explicit.stderr, /不是受支持的/);

  const home = path.join(work, 'instance-source');
  await mkdir(home);
  await writeFile(path.join(home, 'rokbot.json'), JSON.stringify({ schema: 'rokbot-cli/v1', mode: 'source', project: 'rokbot-npm-test', source: repo }));
  const recorded = cli(['pack', 'linux', '--input', fake, '--home', home]);
  assert.equal(recorded.code, 2, recorded.stderr);
  assert.match(recorded.stdout, new RegExp(`使用源码目录：${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(recorded.stderr, /不是受支持的/);
});

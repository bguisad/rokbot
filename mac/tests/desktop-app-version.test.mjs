import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { appVersionArg, resolveAppVersion, windowsFixedVersion } from '../patchers/desktop/app-version.mjs';
import { applyRokBotInfoPlist } from '../patchers/desktop/brand-assets.mjs';
import { compareVersions } from '../clients/desktop/updater.mjs';
import { buildDebianControl } from '../../linux/patchers/desktop/brand-assets.mjs';

const execFileAsync = promisify(execFile);
const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = {
  mac: path.join(repo, 'mac/patchers/desktop/patch.mjs'),
  windows: path.join(repo, 'windows/patchers/desktop/patch.mjs'),
  linux: path.join(repo, 'linux/patchers/desktop/patch.mjs'),
  web: path.join(repo, 'web/patchers/patch.mjs'),
};

test('resolveAppVersion defaults to the official version and accepts only x.y.z not below it', () => {
  assert.equal(resolveAppVersion(null, '1.3.0'), '1.3.0');
  assert.equal(resolveAppVersion(undefined, '1.3.0'), '1.3.0');
  assert.equal(resolveAppVersion('1.3.1', '1.3.0'), '1.3.1');
  assert.equal(resolveAppVersion(' 1.3.1 ', '1.3.0'), '1.3.1');
  assert.equal(resolveAppVersion('1.3.0', '1.3.0'), '1.3.0');
  assert.equal(resolveAppVersion('2.0.0', '1.3.0'), '2.0.0');
  for (const bad of ['1.3', '1.3.1-beta', 'v1.3.1', '1.3.1.0', '01.3.1', '', 'latest']) {
    assert.throws(() => resolveAppVersion(bad, '1.3.0'), /x\.y\.z/, bad);
  }
  assert.throws(() => resolveAppVersion('1.2.9', '1.3.0'), /不能低于官方输入版本 1\.3\.0/);
});

test('an overridden 1.3.1 build is newer than 1.3.0 for the desktop updater', () => {
  const version = resolveAppVersion('1.3.1', '1.3.0');
  assert.equal(compareVersions(version, '1.3.0'), 1);
  assert.equal(compareVersions('1.3.0', version), -1);
  // Without the override the rebuilt client looks identical to what users already run.
  assert.equal(compareVersions(resolveAppVersion(null, '1.3.0'), '1.3.0'), 0);
});

test('appVersionArg reads the flag and rejects a missing value', () => {
  assert.equal(appVersionArg(['--source', 'x']), null);
  assert.equal(appVersionArg(['--app-version', '1.3.1', '--force']), '1.3.1');
  assert.throws(() => appVersionArg(['--app-version']), /需要一个版本号/);
  assert.throws(() => appVersionArg(['--app-version', '--force']), /需要一个版本号/);
});

test('windowsFixedVersion pads to four 16-bit parts', () => {
  assert.deepEqual(windowsFixedVersion('1.3.1'), [1, 3, 1, 0]);
  assert.throws(() => windowsFixedVersion('1.3.70000'), /Windows 版本资源/);
});

test('applyRokBotInfoPlist writes the outward version into Info.plist', () => {
  const mirrored = applyRokBotInfoPlist({ CFBundleShortVersionString: '1.3.0', CFBundleVersion: '1.3.0' }, { version: '1.3.1' });
  assert.equal(mirrored.CFBundleShortVersionString, '1.3.1');
  assert.equal(mirrored.CFBundleVersion, '1.3.1');
  const buildNumber = applyRokBotInfoPlist({ CFBundleShortVersionString: '1.3.0', CFBundleVersion: '4821' }, { version: '1.3.1' });
  assert.equal(buildNumber.CFBundleShortVersionString, '1.3.1');
  assert.equal(buildNumber.CFBundleVersion, '4821');
  const untouched = applyRokBotInfoPlist({ CFBundleShortVersionString: '1.3.0', CFBundleVersion: '1.3.0' });
  assert.equal(untouched.CFBundleShortVersionString, '1.3.0');
});

test('Debian control carries the outward version', async () => {
  const control = await buildDebianControl({ version: '1.3.1', debianArchitecture: 'amd64' });
  assert.match(control, /^Version: 1\.3\.1$/m);
});

test('desktop and web patch CLIs document --app-version', async () => {
  for (const [name, file] of Object.entries(cli)) {
    if (name === 'mac' && process.platform !== 'darwin') continue;
    const { stdout } = await execFileAsync(process.execPath, [file, '--help'], { cwd: repo });
    assert.match(stdout, /--app-version <x\.y\.z>/, name);
  }
});

test('Windows, Linux and web patch CLIs reject an --app-version below the official input before any download', async () => {
  const runs = [
    ['windows', [cli.windows, '--verify-only', '--app-version', '1.2.0']],
    ['linux', [cli.linux, '--verify-only', '--arch', 'x64', '--app-version', '1.2.0']],
    ['web', [cli.web, '--verify-only', '--app-version', '1.2.0']],
    ['windows-missing', [cli.windows, '--verify-only', '--app-version']],
    ['linux-bad', [cli.linux, '--verify-only', '--arch', 'x64', '--app-version', '1.3.1-beta']],
  ];
  for (const [name, argv] of runs) {
    await assert.rejects(execFileAsync(process.execPath, argv, { cwd: repo, timeout: 60_000 }),
      err => err.code === 1 && /--app-version/.test(err.stderr), name);
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REPO_ROOT, SUMS_NAME, buildReleaseBody, chineseNumber, extractReleaseNotes, ghCommands, hasForbiddenExtension,
  isAllowedAsset, parseChineseNumber, parseTag, prepareRelease, releaseTitle, sanitizeManifest, scanArtifacts,
  selectSourceFiles, sourceArchiveName,
} from './gh-release.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gh-release.mjs');
const FORBIDDEN = /\.(apk|xapk|apks|aab|ipa|dmg|pkg|exe|msi|deb|rpm|appimage|asar)$/i;

const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const write = (file, content = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const listTar = (file) => {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
};

const SAMPLE = `# RokBot 2026-12-01 更新说明

首版导语。

## 新功能

- 功能 A

\`\`\`md
## 代码块里的（第二版）不是小节
\`\`\`

## 支持版本一览

| 平台 | 版本 |
| --- | --- |

## 晚些时候的更新（第二版）

第二版导语。

### 修复

- 修复 B

## 第三版：版本号

- 改动 C

## 第10版

- 改动 D
`;

test('解析标签与中文版次', () => {
  assert.deepEqual(parseTag('v2026.11.27'), { tag: 'v2026.11.27', date: '2026-11-27', index: 1 });
  assert.deepEqual(parseTag('v2026.11.27.3'), { tag: 'v2026.11.27.3', date: '2026-11-27', index: 3 });
  for (const bad of ['2026.11.27', 'v2026.11.27.0', 'v2026-11-27', 'v26.11.27', 'v2026.11.27.2-rc']) assert.throws(() => parseTag(bad));
  assert.deepEqual([1, 2, 3, 10, 11, 20, 23].map(chineseNumber), ['一', '二', '三', '十', '十一', '二十', '二十三']);
  for (const n of [1, 2, 9, 10, 15, 20, 99]) assert.equal(parseChineseNumber(chineseNumber(n)), n);
  assert.equal(parseChineseNumber('12'), 12);
});

test('更新说明按版次分节', () => {
  const first = extractReleaseNotes(SAMPLE, 1);
  assert.equal(first.docTitle, 'RokBot 2026-12-01 更新说明');
  assert.match(first.body, /^首版导语。/);
  assert.match(first.body, /功能 A/);
  assert.match(first.body, /代码块里的（第二版）不是小节/, '代码块里的标题不应当作分节');
  assert.match(first.body, /支持版本一览/);
  assert.doesNotMatch(first.body, /第二版导语|修复 B|改动 C/);
  assert.doesNotMatch(first.body, /^# /m, '不应包含文档一级标题');

  const second = extractReleaseNotes(SAMPLE, 2);
  assert.match(second.body, /^第二版导语。/);
  assert.match(second.body, /### 修复\n\n- 修复 B/);
  assert.doesNotMatch(second.body, /功能 A|改动 C|晚些时候的更新/);

  assert.equal(extractReleaseNotes(SAMPLE, 3).body, '- 改动 C');
  assert.equal(extractReleaseNotes(SAMPLE, 10).body, '- 改动 D');
  assert.throws(() => extractReleaseNotes(SAMPLE, 4), /第四版/);

  assert.equal(releaseTitle(first.docTitle, parseTag('v2026.12.01')), 'RokBot 2026-12-01 更新说明');
  assert.equal(releaseTitle(first.docTitle, parseTag('v2026.12.01.2')), 'RokBot 2026-12-01 更新说明（第二版）');
});

test('仓库内 2026-11-27 更新说明三个版次都能取到中文正文', () => {
  const md = fs.readFileSync(path.join(REPO_ROOT, 'docs/releases/2026-11-27.md'), 'utf8');
  const [v1, v2, v3] = [1, 2, 3].map((i) => extractReleaseNotes(md, i).body);
  assert.match(v1, /新增 Linux 桌面端/);
  assert.doesNotMatch(v1, /第二版/);
  assert.match(v2, /输入建议更好用/);
  assert.doesNotMatch(v2, /新增 Linux 桌面端|1\.3\.1/);
  assert.match(v3, /1\.3\.1/);
  for (const body of [v1, v2, v3]) assert.match(body, /[\u4e00-\u9fff]/);
});

test('附件白名单拒绝完整安装包与 APK', () => {
  const tag = 'v2026.11.27.2';
  for (const ok of [sourceArchiveName(tag), SUMS_NAME, 'windows-RokBotLocal-1.3.1-x64.patch.json', 'mac-RokBot.app.patch.json',
    'android-patch-report.patch.json']) assert.ok(isAllowedAsset(ok, tag), ok);
  for (const bad of ['RokBot-1.26.0-rokbot.10.apk', 'RokBot.dmg', 'RokBotLocal-1.3.1-x64-Setup.exe', 'RokBotLocal-1.3.1-linux-x64.deb',
    'RokBotLocal-1.3.1-linux-x64.tar.gz', 'RokBotLocal-1.3.1-x64-portable.zip', 'RokBotLocal-web-1.3.1.zip', 'app.asar',
    'evil.patch.json.exe', 'x.apk.patch.json/..', '../x.patch.json', sourceArchiveName('v2026.11.27'), 'RokBot.app.zip']) {
    assert.equal(isAllowedAsset(bad, tag), false, bad);
  }
  for (const ext of ['apk', 'dmg', 'exe', 'deb', 'APK', 'Exe']) assert.ok(hasForbiddenExtension(`a.${ext}`), ext);
});

test('源码筛选只留补丁器与配方，排除安装包和预编译二进制', () => {
  const files = ['LICENSE', 'mac/patchers/desktop/patch.mjs', 'android/recipes/manifest.json', 'android/bin/rokbot-native-base.apk',
    'android/bin/classes2.dex', 'windows/dist/installer/rokbot-setup-stub.exe', 'windows/patchers/desktop/stub.exe',
    'ios/clients/lib/libfoo.a', 'ios/bin/RokBotLocal.dylib', 'linux/patchers/desktop/x.so.1', 'host/server/index.mjs',
    'linux/patchers/desktop/output/x.mjs', 'web/patchers/patch.mjs', 'mac/patchers/desktop/RokBot.dmg', 'host/recipes/host/a.gbp.gz'];
  assert.deepEqual(selectSourceFiles(files), ['LICENSE', 'android/recipes/manifest.json', 'host/recipes/host/a.gbp.gz',
    'mac/patchers/desktop/patch.mjs', 'web/patchers/patch.mjs']);
});

test('清单去除构建机绝对路径', () => {
  const out = sanitizeManifest({
    source: '/Users/someone/work/mac/.cache/Grok_Bot_1.3.0.dmg', win: 'C:\\Users\\a\\out\\RokBot Local',
    runner: '/home/runner/work/rokbot/rokbot/linux/output/RokBotLocal-1.3.1-linux-x64.deb', nested: [{ p: '/tmp/x/y.apk' }],
    profile: '~/Library/Application Support/RokBot Local', appdata: '%APPDATA%\\RokBot Local', entry: 'local-client/main.mjs',
    install: '/opt/RokBot/rokbot', n: 3,
  });
  assert.deepEqual(out, {
    source: 'Grok_Bot_1.3.0.dmg', win: 'RokBot Local', runner: 'RokBotLocal-1.3.1-linux-x64.deb', nested: [{ p: 'y.apk' }],
    profile: '~/Library/Application Support/RokBot Local', appdata: '%APPDATA%\\RokBot Local', entry: 'local-client/main.mjs',
    install: '/opt/RokBot/rokbot', n: 3,
  });
});

function fakeOutputs(root) {
  write(path.join(root, 'windows/output/RokBotLocal-1.3.1-x64.patch.json'), JSON.stringify({ output: '/Users/me/x/RokBot Local' }));
  write(path.join(root, 'windows/output/RokBotLocal-1.3.1-x64-Setup.exe'), 'setup');
  write(path.join(root, 'windows/output/RokBotLocal-1.3.1-x64-portable.zip'), 'zip');
  write(path.join(root, 'windows/output/RokBot Local/Grok Bot.exe'), 'unpacked');
  write(path.join(root, 'mac/output.noindex/RokBot.app.patch.json'), JSON.stringify({ version: '1.3.1' }));
  write(path.join(root, 'mac/output.noindex/RokBot.dmg'), 'dmg');
  write(path.join(root, 'linux/output/RokBotLocal-1.3.1-linux-x64.patch.json'), '{}');
  write(path.join(root, 'linux/output/RokBotLocal-1.3.1-linux-x64.deb'), 'deb');
  write(path.join(root, 'linux/output/RokBotLocal-1.3.1-linux-x64.tar.gz'), 'tgz');
  write(path.join(root, 'linux/output/RokBotLocal-1.3.1-linux-x64/rokbot'), 'elf');
  write(path.join(root, 'android/output/patch-report.json'), JSON.stringify({ keystorePath: '/Users/me/.rokbot-local/k.json' }));
  write(path.join(root, 'android/output/RokBot-1.26.0-rokbot.10.apk'), 'apk');
  write(path.join(root, 'web/output/RokBotLocal-web-1.3.1.zip'), 'web');
}

test('扫描产物目录：清单作附件，安装包只取校验值', (t) => {
  const root = tmp(t, 'ghr-scan-');
  fakeOutputs(root);
  const { manifests, installers } = scanArtifacts(root, 'v2026.12.01');
  assert.deepEqual(manifests.map((m) => m.name), ['android-patch-report.patch.json', 'linux-RokBotLocal-1.3.1-linux-x64.patch.json',
    'mac-RokBot.app.patch.json', 'windows-RokBotLocal-1.3.1-x64.patch.json']);
  assert.deepEqual(installers.map((i) => i.name).sort(), ['RokBot-1.26.0-rokbot.10.apk', 'RokBot.dmg', 'RokBotLocal-1.3.1-linux-x64.deb',
    'RokBotLocal-1.3.1-linux-x64.tar.gz', 'RokBotLocal-1.3.1-x64-Setup.exe', 'RokBotLocal-1.3.1-x64-portable.zip', 'RokBotLocal-web-1.3.1.zip']);
  assert.ok(!installers.some((i) => i.name === 'Grok Bot.exe'), '不应深入解包后的应用目录');
  // 平铺目录（CI 下载的清单）也能识别平台。
  const flat = tmp(t, 'ghr-flat-');
  write(path.join(flat, 'RokBotLocal-1.3.1-linux-arm64.patch.json'), '{}');
  write(path.join(flat, 'RokBotLocal-1.3.1-x64.patch.json'), '{}');
  write(path.join(flat, 'RokBot.app.patch.json'), '{}');
  assert.deepEqual(scanArtifacts(flat, 'v2026.12.01').manifests.map((m) => m.name),
    ['linux-RokBotLocal-1.3.1-linux-arm64.patch.json', 'mac-RokBot.app.patch.json', 'windows-RokBotLocal-1.3.1-x64.patch.json']);
});

function fixtureRepo(t) {
  const repo = tmp(t, 'ghr-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, 'LICENSE'), 'RokBot Noncommercial License 1.0\n');
  write(path.join(repo, 'docs/releases/2026-12-01.md'), SAMPLE);
  write(path.join(repo, 'mac/patchers/desktop/patch.mjs'), 'export {};\n');
  write(path.join(repo, 'windows/patchers/desktop/recipes/manifest.json'), '{}\n');
  write(path.join(repo, 'windows/patchers/desktop/stub.exe'), 'MZ');
  write(path.join(repo, 'windows/dist/installer/rokbot-setup-stub.exe'), 'MZ');
  write(path.join(repo, 'android/release/patch-android.mjs'), 'export {};\n');
  write(path.join(repo, 'android/recipes/base.apk'), 'PK');
  write(path.join(repo, 'android/bin/rokbot-native-base.apk'), 'PK');
  write(path.join(repo, 'ios/clients/lib/libx.a'), '!<arch>');
  write(path.join(repo, 'linux/patchers/desktop/package.deb'), '!<arch>');
  write(path.join(repo, 'mac/patchers/desktop/RokBot.dmg'), 'dmg');
  write(path.join(repo, 'host/server/index.mjs'), '// not a patcher\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  git(repo, 'tag', '-a', 'v2026.12.01.2', '-m', 'second');
  return repo;
}

test('生成附件清单：只有源码包、补丁清单与 SHA256SUMS', (t) => {
  const repo = fixtureRepo(t);
  const artifacts = tmp(t, 'ghr-art-');
  fakeOutputs(artifacts);
  const out = tmp(t, 'ghr-out-');
  const tag = 'v2026.12.01.2';
  const plan = prepareRelease({ tag, repoDir: repo, artifactsDir: artifacts, outDir: out });

  assert.deepEqual(plan.assets.map((a) => a.name), [sourceArchiveName(tag), 'android-patch-report.patch.json',
    'linux-RokBotLocal-1.3.1-linux-x64.patch.json', 'mac-RokBot.app.patch.json', 'windows-RokBotLocal-1.3.1-x64.patch.json', SUMS_NAME]);
  for (const a of plan.assets) {
    assert.ok(isAllowedAsset(a.name, tag), a.name);
    assert.doesNotMatch(a.name, FORBIDDEN);
    assert.equal(path.dirname(a.path), out, '附件必须来自暂存目录，而不是产物目录');
  }
  assert.equal(plan.title, 'RokBot 2026-12-01 更新说明（第二版）');

  // 源码包：不含任何安装包或二进制。
  const entries = listTar(plan.assets[0].path);
  const prefix = `rokbot-patches-${tag}/`;
  assert.ok(entries.every((e) => e.startsWith(prefix)));
  const files = entries.filter((e) => !e.endsWith('/')).map((e) => e.slice(prefix.length)).sort();
  assert.deepEqual(files, ['LICENSE', 'android/release/patch-android.mjs', 'docs/releases/2026-12-01.md', 'mac/patchers/desktop/patch.mjs',
    'windows/patchers/desktop/recipes/manifest.json']);
  for (const f of files) assert.doesNotMatch(f, /\.(apk|dmg|exe|deb|a)$/i);

  // SHA256SUMS 覆盖除自身以外的全部附件。
  const sums = fs.readFileSync(path.join(out, SUMS_NAME), 'utf8').trim().split('\n');
  assert.deepEqual(sums.map((l) => l.split('  ')[1]), plan.assets.slice(0, -1).map((a) => a.name));
  for (const [line, a] of sums.map((l, i) => [l, plan.assets[i]])) assert.equal(line.split('  ')[0], a.sha256);

  // 清单已去除本地路径。
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'windows-RokBotLocal-1.3.1-x64.patch.json'), 'utf8')), { output: 'RokBot Local' });
  assert.doesNotMatch(fs.readFileSync(path.join(out, 'android-patch-report.patch.json'), 'utf8'), /\/Users\//);

  // 暂存目录里也不能出现安装包。
  for (const f of fs.readdirSync(out)) assert.doesNotMatch(f, FORBIDDEN);

  // 正文：中文、写明安装包 SHA-256 与 Host 更新通道，但不作为附件。
  assert.match(plan.body, /^第二版导语。/);
  assert.match(plan.body, /自建 Host 的「更新」通道/);
  assert.match(plan.body, /RokBot Noncommercial License 1\.0/);
  const setup = plan.installers.find((i) => i.name === 'RokBotLocal-1.3.1-x64-Setup.exe');
  assert.match(plan.body, new RegExp(`RokBotLocal-1\\.3\\.1-x64-Setup\\.exe\` \\| \`${setup.sha256}`));
  assert.match(plan.body, /RokBot-1\.26\.0-rokbot\.10\.apk/);

  // --manifests-only：不写安装包校验值。
  const plain = prepareRelease({ tag, repoDir: repo, artifactsDir: artifacts, outDir: tmp(t, 'ghr-out2-'), manifestsOnly: true });
  assert.equal(plain.installers.length, 0);
  assert.doesNotMatch(plain.body, /Setup\.exe/);
  // 源码包可复现。
  assert.equal(plain.assets[0].sha256, plan.assets[0].sha256);
});

test('没有产物目录时只放源码包与校验文件', (t) => {
  const repo = fixtureRepo(t);
  git(repo, 'tag', '-a', 'v2026.12.01', '-m', 'first');
  const plan = prepareRelease({ tag: 'v2026.12.01', repoDir: repo, outDir: tmp(t, 'ghr-out-') });
  assert.deepEqual(plan.assets.map((a) => a.name), ['rokbot-patches-v2026.12.01.tar.gz', SUMS_NAME]);
  assert.match(plan.body, /^首版导语。/);
  assert.match(plan.body, /校验值以 Host 更新通道中显示的为准/);
  assert.throws(() => prepareRelease({ tag: 'v2026.12.01.4', repoDir: repo, outDir: tmp(t, 'ghr-out-') }));
});

test('gh 命令：新建用 create，已存在用 edit + upload --clobber', () => {
  const assets = [{ path: '/s/a.tar.gz' }, { path: '/s/SHA256SUMS.txt' }];
  const base = { tag: 'v2026.12.01', repo: 'o/r', title: 'T', notesPath: '/s/notes.md', assets };
  assert.deepEqual(ghCommands({ ...base, exists: false }), [['release', 'create', 'v2026.12.01', '--repo', 'o/r', '--verify-tag',
    '--title', 'T', '--notes-file', '/s/notes.md', '/s/a.tar.gz', '/s/SHA256SUMS.txt']]);
  assert.deepEqual(ghCommands({ ...base, exists: true }), [
    ['release', 'edit', 'v2026.12.01', '--repo', 'o/r', '--title', 'T', '--notes-file', '/s/notes.md'],
    ['release', 'upload', 'v2026.12.01', '--repo', 'o/r', '--clobber', '/s/a.tar.gz', '/s/SHA256SUMS.txt'],
  ]);
});

test('--dry-run 不调用 gh', (t) => {
  const repo = fixtureRepo(t);
  const bin = tmp(t, 'ghr-bin-');
  const marker = path.join(bin, 'called');
  write(path.join(bin, 'gh'), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const out = tmp(t, 'ghr-out-');
  const r = spawnSync(process.execPath, [SCRIPT, 'v2026.12.01.2', '--dry-run', '--out', out, '--repo-dir', repo, '--repo', 'o/r'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\] 不存在时：gh release create v2026\.12\.01\.2 --repo o\/r/);
  assert.match(r.stdout, /\[dry-run\] 已存在时：gh release upload v2026\.12\.01\.2 --repo o\/r --clobber/);
  assert.match(r.stdout, /第二版导语/);
  assert.equal(fs.existsSync(marker), false, 'dry-run 不应调用 gh');
});

test('buildReleaseBody 在没有安装包时提示 Host 更新通道', () => {
  const body = buildReleaseBody({ tag: 'v2026.12.01', commit: 'abc', notes: '正文', index: 1, date: '2026-12-01',
    assets: [{ name: 'rokbot-patches-v2026.12.01.tar.gz', description: '源码' }], installers: [] });
  assert.match(body, /^正文/);
  assert.match(body, /自建 Host 的「更新」通道获取/);
  assert.doesNotMatch(body, /第一版/);
});

test('release 工作流：v20* 标签触发，只上传 patch.json 并调用发布脚本', () => {
  const yml = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
  assert.match(yml, /tags:\n\s+- 'v20\*'/);
  assert.match(yml, /node scripts\/release\/gh-release\.mjs "\$GITHUB_REF_NAME"/);
  assert.match(yml, /--manifests-only/);
  const uploads = [...yml.matchAll(/upload-artifact@[\s\S]*?path: (.+)/g)].map((m) => m[1].trim());
  assert.deepEqual(uploads, ['${{ runner.temp }}/manifests/*.patch.json']);
  assert.doesNotMatch(yml, /gh release upload|softprops|action-gh-release/);
});

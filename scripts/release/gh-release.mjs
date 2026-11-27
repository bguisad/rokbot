#!/usr/bin/env node
// Publish (or refresh) the GitHub Release for a vYYYY.MM.DD(.N) tag.
//
//   node scripts/release/gh-release.mjs <tag> [产物目录] [--dry-run] [--repo owner/name]
//        [--notes-file docs/releases/YYYY-MM-DD.md] [--out <暂存目录>] [--repo-dir <仓库>] [--manifests-only]
//
// Release 只附带 RokBot 自己的补丁内容：补丁器与配方源码包、各平台 *.patch.json 清单和
// SHA256SUMS.txt。打完补丁的完整安装包 / APK 含上游 Grok Bot 闭源二进制，绝不上传，只在正文里
// 列出 SHA-256，并说明到自建 Host 的「更新」通道获取。
//
// 可重复执行：Release 不存在时 gh release create，已存在时 gh release edit + upload --clobber。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const LICENSE_NAME = 'ProkBot Noncommercial License 1.0';
export const SUMS_NAME = 'SHA256SUMS.txt';
export const PLATFORMS = ['windows', 'mac', 'linux', 'web', 'android', 'ios', 'host'];

// 补丁器、配方与被注入的 RokBot 客户端源码。某个标签里不存在的目录会被自动跳过。
export const SOURCE_ROOTS = [
  'LICENSE', 'NOTICE', 'README.md', 'README.en.md',
  'docs/PATCHING_WORKFLOW.md', 'docs/PATCHING_WORKFLOW.en.md', 'docs/releases',
  'windows/patchers', 'mac/patchers', 'mac/clients', 'linux/patchers', 'web/patchers', 'web/client',
  'android/patchers', 'android/recipes', 'android/release', 'android/companion',
  'ios/patchers', 'ios/recipes', 'ios/release', 'ios/clients',
  'host/recipes', 'host/release', 'host/clients',
];

// 安装包 / 可分发应用：任何时候都不能作为附件，也不能出现在源码包里。
export const FORBIDDEN_EXTENSIONS = ['.apk', '.xapk', '.apks', '.aab', '.ipa', '.dmg', '.pkg', '.exe', '.msi', '.msix',
  '.appx', '.deb', '.rpm', '.appimage', '.snap', '.asar', '.7z'];
// 源码包里额外排除的预编译二进制（同样可能来自上游或无法审阅）。
export const BINARY_EXTENSIONS = ['.dll', '.so', '.dylib', '.dex', '.a', '.lib', '.node', '.jar', '.o'];

const ZH_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function chineseNumber(n) {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`不支持的版次：${n}`);
  if (n < 10) return ZH_DIGITS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${tens === 1 ? '' : ZH_DIGITS[tens]}十${ones ? ZH_DIGITS[ones] : ''}`;
}

export function parseChineseNumber(text) {
  if (/^\d+$/.test(text)) return Number(text);
  const digit = (c) => ZH_DIGITS.indexOf(c);
  if (/^[一二三四五六七八九]$/.test(text)) return digit(text);
  const m = /^([二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(text);
  if (m) return (m[1] ? digit(m[1]) : 1) * 10 + (m[2] ? digit(m[2]) : 0);
  return null;
}

export function parseTag(tag) {
  const m = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/.exec(tag ?? '');
  if (!m) throw new Error(`标签必须是 vYYYY.MM.DD 或 vYYYY.MM.DD.N 格式：${tag}`);
  const index = m[4] === undefined ? 1 : Number(m[4]);
  if (index < 1) throw new Error(`版次必须从 1 开始：${tag}`);
  return { tag, date: `${m[1]}-${m[2]}-${m[3]}`, index };
}

const VERSION_MARK = /第\s*([0-9一二三四五六七八九十]+)\s*版/;

// 从当天的更新说明里取出第 index 版的内容。
// 第一版 = 第一个「第N版」标题之前的全部内容（或显式的「第一版」小节）；
// 第 N 版 = 标题含「第N版」的小节，直到下一个同级或更高级的标题。
export function extractReleaseNotes(markdown, index) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let docTitle = null;
  const headings = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) return;
    const level = h[1].length;
    if (level === 1 && docTitle === null) { docTitle = h[2]; headings.push({ i, level, text: h[2], title: true }); return; }
    const mark = VERSION_MARK.exec(h[2]);
    headings.push({ i, level, text: h[2], version: mark ? parseChineseNumber(mark[1]) : null });
  });
  const markers = headings.filter((h) => h.version);
  const start = lines.findIndex((_, i) => i > (headings.find((h) => h.title)?.i ?? -1));
  const bodyStart = start === -1 ? lines.length : start;
  let slice;
  const marker = markers.find((h) => h.version === index);
  if (marker) {
    const end = headings.find((h) => h.i > marker.i && h.level <= marker.level);
    slice = lines.slice(marker.i + 1, end ? end.i : lines.length);
  } else if (index === 1) {
    const first = markers[0];
    slice = lines.slice(bodyStart, first ? first.i : lines.length);
  } else {
    throw new Error(`更新说明里找不到「第${chineseNumber(index)}版」小节`);
  }
  const body = slice.join('\n').trim();
  if (!body) throw new Error(`「第${chineseNumber(index)}版」小节内容为空`);
  return { docTitle, heading: marker?.text ?? null, body };
}

export function releaseTitle(docTitle, { date, index }) {
  const base = (docTitle || `RokBot ${date} 更新说明`).trim();
  return index === 1 ? base : `${base}（第${chineseNumber(index)}版）`;
}

function extname(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  return path.extname(lower);
}

export function hasForbiddenExtension(name) {
  return FORBIDDEN_EXTENSIONS.includes(extname(path.basename(name)));
}

// 附件白名单：源码包、*.patch.json 清单与校验文件，其余一律拒绝。
export function isAllowedAsset(name, tag) {
  const base = path.basename(name);
  if (base !== name || hasForbiddenExtension(base)) return false;
  if (base === SUMS_NAME) return true;
  if (base === sourceArchiveName(tag)) return true;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.patch\.json$/.test(base);
}

export function sourceArchiveName(tag) { return `rokbot-patches-${tag}.tar.gz`; }

export function isSourceFileAllowed(file) {
  const base = path.basename(file).toLowerCase();
  const ext = extname(base);
  if (FORBIDDEN_EXTENSIONS.includes(ext) || BINARY_EXTENSIONS.includes(ext)) return false;
  if (/\.so(\.\d+)+$/.test(base)) return false;
  return !file.split('/').some((part) => part === 'output' || part.startsWith('output.') || part === '.cache' || part.startsWith('backup'));
}

export function selectSourceFiles(files) {
  const inRoots = (f) => SOURCE_ROOTS.some((r) => f === r || f.startsWith(`${r}/`));
  return files.filter((f) => inRoots(f) && isSourceFileAllowed(f)).sort();
}

// ---- 产物目录扫描 ----

const INSTALLER_PATTERNS = [
  /\.(exe|msi|dmg|pkg|deb|rpm|apk|aab|ipa|appimage)$/i,
  /-portable\.zip$/i,
  /^RokBot.*\.(zip|tar\.gz)$/i,
];

function isInstaller(name, tag) {
  if (name === sourceArchiveName(tag)) return false;
  return INSTALLER_PATTERNS.some((re) => re.test(name));
}

function platformOf(file, root) {
  const rel = path.relative(root, file).split(path.sep);
  for (const part of rel.slice(0, -1)) if (PLATFORMS.includes(part.toLowerCase())) return part.toLowerCase();
  const name = path.basename(file).toLowerCase();
  if (name.includes('linux')) return 'linux';
  if (name.includes('web')) return 'web';
  if (name.endsWith('.app.patch.json') || name.includes('mac') || name.includes('darwin')) return 'mac';
  if (name.includes('android') || name.includes('patch-report')) return 'android';
  if (name.includes('ios')) return 'ios';
  if (/x64|win|setup/.test(name)) return 'windows';
  return null;
}

// 只看产物目录本身、其下的 output* 目录和 <平台>/output* 目录里的文件，不深入解包后的应用目录。
export function scanArtifacts(dir, tag) {
  const result = { manifests: [], installers: [] };
  if (!dir) return result;
  const root = path.resolve(dir);
  if (!fs.statSync(root).isDirectory()) throw new Error(`产物目录不存在：${dir}`);
  const dirs = [root];
  const isOutput = (n) => /^output/i.test(n);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    if (isOutput(entry.name) || PLATFORMS.includes(entry.name)) dirs.push(child);
    if (!PLATFORMS.includes(entry.name)) continue;
    for (const sub of fs.readdirSync(child, { withFileTypes: true })) {
      if (sub.isDirectory() && isOutput(sub.name)) dirs.push(path.join(child, sub.name));
    }
  }
  for (const d of dirs) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(d, entry.name);
      if (entry.name.endsWith('.patch.json') || entry.name === 'patch-report.json') {
        const platform = platformOf(file, root);
        result.manifests.push({ path: file, platform, name: manifestAssetName(entry.name, platform) });
      } else if (isInstaller(entry.name, tag)) {
        result.installers.push({ path: file, name: entry.name, platform: platformOf(file, root) });
      }
    }
  }
  const sortByName = (a, b) => a.name.localeCompare(b.name);
  result.manifests.sort(sortByName);
  result.installers.sort(sortByName);
  return result;
}

export function manifestAssetName(fileName, platform) {
  let name = fileName === 'patch-report.json' ? 'patch-report.patch.json' : fileName;
  name = name.replace(/\s+/g, '-');
  if (platform && !name.toLowerCase().startsWith(`${platform}-`)) name = `${platform}-${name}`;
  return name;
}

// 去掉构建机上的绝对路径（含用户名等），只保留文件名。
const LOCAL_PATH = /^(\/(Users|home|root|tmp|private|var\/folders|Volumes|mnt|workspace|github|__w)\/|[A-Za-z]:[\\/]|\\\\)/;
export function sanitizeManifest(value) {
  const visit = (v) => {
    if (typeof v === 'string') return LOCAL_PATH.test(v) ? v.split(/[\\/]/).filter(Boolean).pop() : v;
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  return visit(value);
}

export function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

// ---- 正文 ----

const PLATFORM_LABELS = { windows: 'Windows', mac: 'macOS', linux: 'Linux', web: '网页版', android: 'Android', ios: 'iOS', host: 'Host' };

export function buildReleaseBody({ tag, commit, notes, index, date, assets, installers }) {
  const out = [];
  out.push(notes.trim(), '', '---', '');
  if (index > 1) out.push(`> 本版为 ${date} 当日第${chineseNumber(index)}版，当日完整说明见仓库 \`docs/releases/${date}.md\`。`, '');
  out.push('## 附件说明', '');
  out.push('本 Release 只附带 RokBot 自己的补丁内容：', '');
  for (const a of assets) out.push(`- \`${a.name}\`：${a.description}`);
  out.push('');
  out.push(`不附带打完补丁的完整官方安装包或 APK：其中包含上游 Grok Bot 的闭源二进制，公开分发存在版权风险。本仓库按 ${LICENSE_NAME} 授权。`, '');
  out.push('## 完整安装包', '');
  if (installers.length) {
    out.push('完整安装包请通过自建 Host 的「更新」通道获取。下载后可对照下表核对 SHA-256：', '');
    out.push('| 平台 | 文件 | SHA-256 |', '| --- | --- | --- |');
    for (const i of installers) out.push(`| ${PLATFORM_LABELS[i.platform] ?? '—'} | \`${i.name}\` | \`${i.sha256}\` |`);
  } else {
    out.push('完整安装包请通过自建 Host 的「更新」通道获取，校验值以 Host 更新通道中显示的为准。');
  }
  out.push('', `源码标签：\`${tag}\`${commit ? `（提交 \`${commit.slice(0, 12)}\`）` : ''}`);
  return `${out.join('\n')}\n`;
}

// ---- 附件生成 ----

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFailure) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} 失败：${(r.stderr || '').trim()}`);
  return r;
}

export function resolveCommit(repoDir, tag) {
  return run('git', ['-C', repoDir, 'rev-parse', '--verify', `${tag}^{commit}`]).stdout.trim();
}

export function listTagEntries(repoDir, commit) {
  return run('git', ['-C', repoDir, 'ls-tree', '-r', '-z', commit]).stdout.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
}

export function createSourceArchive({ repoDir, tag, commit, outDir }) {
  const entries = listTagEntries(repoDir, commit).filter((e) => e.type === 'blob');
  const keep = new Set(selectSourceFiles(entries.map((e) => e.path)));
  const selected = entries.filter((e) => keep.has(e.path));
  if (!selected.length) throw new Error(`标签 ${tag} 中没有补丁器或配方源码`);
  const name = sourceArchiveName(tag);
  const dest = path.join(outDir, name);
  // 用临时索引只收录筛选后的文件，写成一棵树再归档；归档时间固定为提交时间，便于复现。
  const indexFile = path.join(outDir, '.source-index');
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    run('git', ['-C', repoDir, 'update-index', '--add', '-z', '--index-info'], {
      env, input: selected.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join(''),
    });
    const tree = run('git', ['-C', repoDir, 'write-tree'], { env }).stdout.trim();
    const mtime = run('git', ['-C', repoDir, 'log', '-1', '--format=%ct', commit]).stdout.trim();
    run('git', ['-C', repoDir, 'archive', '--format=tar.gz', `--prefix=rokbot-patches-${tag}/`, `--mtime=@${mtime}`,
      `--output=${dest}`, tree]);
  } finally { fs.rmSync(indexFile, { force: true }); }
  return { name, path: dest, files: selected.map((e) => e.path) };
}

export function writeSums(outDir, assets) {
  const lines = assets.map((a) => `${a.sha256}  ${a.name}`);
  const file = path.join(outDir, SUMS_NAME);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// 生成全部附件，返回附件清单（顺序即上传顺序）与完整安装包的校验值。
export function prepareRelease({ tag, repoDir = REPO_ROOT, artifactsDir, outDir, notesFile, manifestsOnly = false }) {
  const info = parseTag(tag);
  const commit = resolveCommit(repoDir, tag);
  const notesPath = notesFile ?? path.join(repoDir, 'docs/releases', `${info.date}.md`);
  if (!fs.existsSync(notesPath)) throw new Error(`找不到更新说明：${notesPath}`);
  const notes = extractReleaseNotes(fs.readFileSync(notesPath, 'utf8'), info.index);
  fs.mkdirSync(outDir, { recursive: true });

  const assets = [];
  const archive = createSourceArchive({ repoDir, tag, commit, outDir });
  assets.push({ name: archive.name, path: archive.path, description: `各平台补丁器、配方与注入的 RokBot 客户端源码（共 ${archive.files.length} 个文件，取自标签 \`${tag}\`）` });

  const scanned = scanArtifacts(artifactsDir, tag);
  const seen = new Set();
  for (const m of scanned.manifests) {
    if (seen.has(m.name)) throw new Error(`补丁清单重名：${m.name}`);
    seen.add(m.name);
    const dest = path.join(outDir, m.name);
    const json = sanitizeManifest(JSON.parse(fs.readFileSync(m.path, 'utf8')));
    fs.writeFileSync(dest, `${JSON.stringify(json, null, 2)}\n`);
    assets.push({ name: m.name, path: dest, description: `${PLATFORM_LABELS[m.platform] ?? ''} 补丁清单（已去除构建机本地路径）`.trim() });
  }
  for (const a of assets) a.sha256 = sha256File(a.path);
  const sums = writeSums(outDir, assets);
  assets.push({ name: SUMS_NAME, path: sums, description: '以上附件的 SHA-256 校验值', sha256: sha256File(sums) });

  for (const a of assets) {
    if (!isAllowedAsset(a.name, tag)) throw new Error(`拒绝上传不在白名单内的附件：${a.name}`);
  }
  const installers = manifestsOnly ? [] : scanned.installers.map((i) => ({ ...i, sha256: sha256File(i.path) }));
  const body = buildReleaseBody({ tag, commit, notes: notes.body, index: info.index, date: info.date, assets, installers });
  return { ...info, commit, title: releaseTitle(notes.docTitle, info), body, assets, installers };
}

// ---- gh ----

export function ghCommands({ tag, repo, title, notesPath, assets, exists }) {
  const repoArgs = repo ? ['--repo', repo] : [];
  const files = assets.map((a) => a.path);
  if (!exists) return [['release', 'create', tag, ...repoArgs, '--verify-tag', '--title', title, '--notes-file', notesPath, ...files]];
  return [
    ['release', 'edit', tag, ...repoArgs, '--title', title, '--notes-file', notesPath],
    ['release', 'upload', tag, ...repoArgs, '--clobber', ...files],
  ];
}

function releaseExists(tag, repo) {
  const r = run('gh', ['release', 'view', tag, ...(repo ? ['--repo', repo] : []), '--json', 'tagName'], { allowFailure: true });
  if (r.status === 0) return true;
  if (/release not found|not found/i.test(r.stderr)) return false;
  throw new Error(`gh release view 失败：${r.stderr.trim()}`);
}

function releaseUrl(tag, repo) {
  const r = run('gh', ['release', 'view', tag, ...(repo ? ['--repo', repo] : []), '--json', 'url', '--jq', '.url'], { allowFailure: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function parseArgs(argv) {
  const opts = { positional: [], dryRun: false, manifestsOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} 需要参数`); return argv[++i]; };
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--manifests-only') opts.manifestsOnly = true;
    else if (a === '--repo') opts.repo = value();
    else if (a === '--notes-file') opts.notesFile = path.resolve(value());
    else if (a === '--out') opts.outDir = path.resolve(value());
    else if (a === '--repo-dir') opts.repoDir = path.resolve(value());
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`未知参数：${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

const USAGE = `用法：node scripts/release/gh-release.mjs <vYYYY.MM.DD[.N]> [产物目录] [--dry-run] [--repo owner/name]
        [--notes-file <更新说明.md>] [--out <暂存目录>] [--repo-dir <仓库目录>] [--manifests-only]
更新说明默认取 <仓库目录>/docs/releases/<日期>.md（工作区里的版本，不是标签里的版本）。
产物目录可以是含 *.patch.json 与完整安装包的目录，或含 <平台>/output* 的仓库目录。
--manifests-only 只取补丁清单，不在正文里写完整安装包的 SHA-256（CI 自建的安装包与 Host 更新通道里的不同）。`;

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help || opts.positional.length < 1 || opts.positional.length > 2) { console.log(USAGE); return opts.help ? 0 : 2; }
  const [tag, artifactsDir] = opts.positional;
  const repo = opts.repo ?? process.env.GITHUB_REPOSITORY ?? null;
  const outDir = opts.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `rokbot-release-${tag}-`));
  const plan = prepareRelease({ tag, repoDir: opts.repoDir ?? REPO_ROOT, artifactsDir, outDir, notesFile: opts.notesFile,
    manifestsOnly: opts.manifestsOnly });
  const notesPath = path.join(outDir, 'release-notes.md');
  fs.writeFileSync(notesPath, plan.body);

  console.log(`标签：${tag}（${plan.commit}）\n标题：${plan.title}\n暂存目录：${outDir}\n附件：`);
  for (const a of plan.assets) console.log(`  ${a.sha256}  ${a.name}  (${fs.statSync(a.path).size} 字节)`);
  if (plan.installers.length) {
    console.log('完整安装包（仅写入正文，不上传）：');
    for (const i of plan.installers) console.log(`  ${i.sha256}  ${i.name}`);
  }

  if (opts.dryRun) {
    console.log(`\n--- 正文 ---\n${plan.body}--- 正文结束 ---\n`);
    for (const cmd of ghCommands({ tag, repo, title: plan.title, notesPath, assets: plan.assets, exists: false })) console.log(`[dry-run] 不存在时：gh ${cmd.join(' ')}`);
    for (const cmd of ghCommands({ tag, repo, title: plan.title, notesPath, assets: plan.assets, exists: true })) console.log(`[dry-run] 已存在时：gh ${cmd.join(' ')}`);
    return 0;
  }
  const exists = releaseExists(tag, repo);
  for (const cmd of ghCommands({ tag, repo, title: plan.title, notesPath, assets: plan.assets, exists })) {
    run('gh', cmd, { stdio: ['ignore', 'inherit', 'inherit'] });
  }
  console.log(`${exists ? '已更新' : '已创建'} Release：${releaseUrl(tag, repo) ?? tag}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(`错误：${err.message}`); process.exitCode = 1; });
}

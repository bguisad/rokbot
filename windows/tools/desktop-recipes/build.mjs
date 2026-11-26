#!/usr/bin/env node
// Maintainer tool: regenerate the Windows, macOS, and Linux desktop recipes from the official
// 1.3.0 packages and the anchored edits in spec.mjs. Every anchor must occur exactly
// once in its source; unchanged original bytes become copy ranges, so a recipe adds
// only this project's code.
//
//   node windows/tools/desktop-recipes/build.mjs [--target windows|mac|linux-x64|linux-arm64|all] [--source <Setup.exe|app-64.7z|.dmg|.app|.deb|dir>] [--check]
//
// Without --source the pinned official 1.3.0 installer/DMG/.deb is downloaded and verified.
// --check rebuilds in memory and fails unless the committed recipes are byte-identical.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, gzipSync } from 'node:zlib';
import { acquireDesktopSource } from '../../../mac/patchers/desktop/download-original.mjs';
import { applyByteRecipe } from '../../../mac/patchers/desktop/release-recipes.mjs';
import { unpackOriginal as unpackWindowsOriginal } from '../../patchers/desktop/original.mjs';
import { TARGETS, specForTarget, targetMeta } from './spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const windowsRoot = path.resolve(here, '../..');
const repo = path.resolve(windowsRoot, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function unique(source, anchor, label) {
  const needle = Buffer.from(anchor, 'utf8');
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`${label}: anchor not found: ${anchor.slice(0, 120)}`);
  if (source.indexOf(needle, at + 1) >= 0) throw new Error(`${label}: anchor not unique: ${anchor.slice(0, 120)}`);
  return { at, end: at + needle.length };
}

// A replacement keeps the original bytes it shares with the anchor at either end.
function trimmed(source, at, end, text) {
  const before = source.subarray(at, end), after = Buffer.from(text, 'utf8');
  let head = 0, tail = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  while (tail < before.length - head && tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return [at + head, end - tail, after.subarray(head, after.length - tail)];
}

/** Deterministic RFC 1952 gzip compression (OS byte normalized to 0x03 across platforms). */
export function deterministicGzip(bytes) {
  const compressed = gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION });
  if (compressed.length >= 10) compressed[9] = 0x03;
  return compressed;
}

/** Turn one spec entry into a grokbot-bytepatch/v1 recipe over its pinned source. */
export function buildRecipe(entry, source) {
  const label = entry.path, changes = [];
  for (const edit of entry.edits) {
    if ('replaceAll' in edit) changes.push([0, source.length, Buffer.from(edit.replaceAll)]);
    else if ('prepend' in edit) changes.push([0, 0, Buffer.from(edit.prepend)]);
    else if ('append' in edit) changes.push([source.length, source.length, Buffer.from(edit.append)]);
    else if ('cutFrom' in edit) { const { at } = unique(source, edit.cutFrom, label); changes.push([at, source.length, Buffer.from(edit.text ?? '')]); }
    else if ('insertAfter' in edit) { const { end } = unique(source, edit.insertAfter, label); changes.push([end, end, Buffer.from(edit.text)]); }
    else if ('insertBefore' in edit) { const { at } = unique(source, edit.insertBefore, label); changes.push([at, at, Buffer.from(edit.text)]); }
    else if ('replace' in edit) { const { at, end } = unique(source, edit.replace, label); changes.push(trimmed(source, at, end, edit.text)); }
    else if ('removeThrough' in edit) {
      const from = unique(source, edit.removeThrough[0], label), to = unique(source, edit.removeThrough[1], label);
      changes.push([from.at, to.end, Buffer.from(edit.text ?? '')]);
    } else throw new Error(`${label}: unknown edit`);
  }
  // Edits at one offset keep their spec order (for example two insertions at the start).
  changes.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  for (let i = 1; i < changes.length; i++) if (changes[i][0] < changes[i - 1][1]) throw new Error(`${label}: overlapping edits`);
  const ops = []; let cursor = 0, added = 0;
  const copy = (from, to) => {
    if (to <= from) return;
    const last = ops.at(-1);
    if (last?.[0] === 'copy' && last[1] + last[2] === from) last[2] += to - from; else ops.push(['copy', from, to - from]);
  };
  const add = bytes => {
    if (!bytes.length) return;
    added += bytes.length;
    const last = ops.at(-1);
    if (last?.[0] === 'add') last[1] = Buffer.concat([Buffer.from(last[1], 'base64'), bytes]).toString('base64');
    else ops.push(['add', bytes.toString('base64')]);
  };
  for (const [start, end, bytes] of changes) { copy(cursor, start); add(bytes); cursor = Math.max(cursor, end); }
  copy(cursor, source.length);
  const target = Buffer.concat(ops.map(op => op[0] === 'copy' ? source.subarray(op[1], op[1] + op[2]) : Buffer.from(op[1], 'base64')));
  const recipe = { schema: 'grokbot-bytepatch/v1', sourceBytes: source.length, sourceSha256: sha(source),
    targetBytes: target.length, targetSha256: sha(target), ops };
  if (!applyByteRecipe(source, recipe).equals(target)) throw new Error(`${label}: recipe does not replay`);
  return { recipe, target, added };
}

/** Build every recipe file and the manifest from an extracted original app.asar. */
export async function buildRecipes(unpacked, target = 'windows') {
  const files = new Map(), entries = [];
  const sorted = [...specForTarget(target)].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const [index, entry] of sorted.entries()) {
    const source = entry.source === null ? Buffer.alloc(0) : await readFile(path.join(unpacked, entry.source));
    const { recipe, target: builtTarget, added } = buildRecipe(entry, source);
    const name = `${String(index).padStart(3, '0')}.gbp.gz`;
    const compressed = deterministicGzip(JSON.stringify(recipe));
    files.set(name, compressed);
    entries.push({ path: entry.path, source: entry.source, newFile: entry.source !== entry.path, recipe: name,
      sha256: sha(compressed), targetBytes: builtTarget.length, addedBytes: added });
  }
  files.set('manifest.json', Buffer.from(JSON.stringify({ schema: 'grokbot-desktop-recipes/v1', files: entries }, null, 2) + '\n'));
  return files;
}

/** Resolve target list from CLI --target and --source. */
export function resolveTargets({ target, source }) {
  if (target === 'all') {
    if (source) throw new Error('--source cannot be combined with --target all');
    return Object.keys(TARGETS);
  }
  if (target) {
    targetMeta(target);
    return [target];
  }
  if (source) {
    const clean = source.replace(/[/\\]+$/, '').toLowerCase();
    if (clean.endsWith('.dmg') || clean.endsWith('.app')) return ['mac'];
    if (clean.endsWith('_arm64.deb') || clean.endsWith('arm64.deb')) return ['linux-arm64'];
    if (clean.endsWith('.deb')) return ['linux-x64'];
  }
  return ['windows'];
}

async function unpackMacSource(source, temporary, supported) {
  const trimmedSource = source.replace(/[/\\]+$/, '');
  const lower = trimmedSource.toLowerCase();
  if (lower.endsWith('.dmg')) {
    if (process.platform !== 'darwin') {
      throw new Error('Unpacking a macOS .dmg requires macOS (hdiutil). Pass an unpacked .app directory or run on macOS.');
    }
    const mount = path.join(temporary, 'mount');
    await mkdir(mount, { recursive: true });
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, source], { stdio: ['ignore', 'pipe', 'pipe'] });
    const app = path.join(mount, 'Grok Bot.app');
    return { app, unmount: () => { try { execFileSync('hdiutil', ['detach', mount], { stdio: 'ignore' }); } catch {} } };
  }
  if (lower.endsWith('.app')) {
    return { app: trimmedSource, unmount: () => {} };
  }
  if ((await stat(source)).isDirectory()) {
    return { app: source, isExtractedAsarDir: true, unmount: () => {} };
  }
  throw new Error(`Unsupported macOS source: ${source} (expected .dmg, .app, or extracted directory)`);
}

async function unpackLinuxDebSource(source, temporary) {
  if ((await stat(source)).isDirectory()) {
    return { dir: source, isExtractedAsarDir: true };
  }
  const debDir = path.join(temporary, 'deb');
  const dataDir = path.join(temporary, 'data');
  await mkdir(debDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const tarCmd = process.platform === 'darwin' ? '/usr/bin/bsdtar' : 'bsdtar';
  try {
    execFileSync(tarCmd, ['-xf', source, '-C', debDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    execFileSync('ar', ['x', source], { cwd: debDir, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const members = await readdir(debDir);
  const dataTar = members.find(name => name.startsWith('data.tar'));
  if (!dataTar) throw new Error(`Invalid .deb package (missing data.tar*): ${source}`);
  try {
    execFileSync(tarCmd, ['-xf', path.join(debDir, dataTar), '-C', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    execFileSync('tar', ['-xf', path.join(debDir, dataTar), '-C', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return { dir: path.join(dataDir, 'opt/Grok Bot'), isExtractedAsarDir: false };
}

async function buildForTarget(target, { sourceArg, check }) {
  const supported = targetMeta(target);
  const recipesDir = path.join(repo, supported.recipesRelativeDir);
  const cacheDir = path.join(repo, supported.cacheRelativeDir);
  const temporary = await mkdtemp(path.join(os.tmpdir(), `rokbot-desktop-recipes-${target}-`));
  let unmount = () => {};
  try {
    const source = await acquireDesktopSource({
      source: sourceArg,
      cacheDirectory: cacheDir,
      supported,
      onDownload: ({ version }) => console.error(`正在下载 Grok Bot ${version} (${supported.label})…`),
    });
    const asar = createRequire(path.join(repo, 'mac/patchers/desktop/package.json'))('@electron/asar');
    let unpacked;
    if (target === 'mac') {
      const macUnpack = await unpackMacSource(source, temporary, supported);
      unmount = macUnpack.unmount;
      if (macUnpack.isExtractedAsarDir) {
        unpacked = macUnpack.app;
      } else {
        const asarFile = path.join(macUnpack.app, 'Contents/Resources/app.asar');
        const frameworkFile = path.join(macUnpack.app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
        if (sha(await readFile(asarFile)) !== supported.asarSha256 ||
            sha(await readFile(frameworkFile)) !== supported.frameworkSha256) {
          throw new Error(`Not the pinned Grok Bot ${supported.version} (${supported.label}) app.asar`);
        }
        unpacked = path.join(temporary, 'app');
        asar.extractAll(asarFile, unpacked);
      }
    } else if (target.startsWith('linux-')) {
      const linuxUnpack = await unpackLinuxDebSource(source, temporary);
      if (linuxUnpack.isExtractedAsarDir) {
        unpacked = linuxUnpack.dir;
      } else {
        const asarFile = path.join(linuxUnpack.dir, 'resources/app.asar');
        if (sha(await readFile(asarFile)) !== supported.asarSha256) {
          throw new Error(`Not the pinned Grok Bot ${supported.version} (${supported.label}) app.asar`);
        }
        unpacked = path.join(temporary, 'app');
        asar.extractAll(asarFile, unpacked);
      }
    } else {
      const app = await unpackWindowsOriginal(source, temporary, supported);
      const asarFile = path.join(app, 'resources/app.asar');
      if (sha(await readFile(asarFile)) !== supported.asarSha256) {
        throw new Error(`Not the pinned Grok Bot ${supported.version} (${supported.label}) app.asar`);
      }
      unpacked = path.join(temporary, 'app');
      asar.extractAll(asarFile, unpacked);
    }

    const files = await buildRecipes(unpacked, target);
    if (check) {
      const committed = (await readdir(recipesDir)).sort();
      const stale = [...files.keys()].filter(name => !committed.includes(name)).concat(committed.filter(name => !files.has(name)));
      for (const [name, bytes] of files) {
        if (committed.includes(name) && !bytes.equals(await readFile(path.join(recipesDir, name)))) stale.push(name);
      }
      if (stale.length) throw new Error(`Committed ${target} recipes differ from spec.mjs: ${stale.join(', ')}`);
    } else {
      await mkdir(recipesDir, { recursive: true });
      for (const name of await readdir(recipesDir)) {
        if (/^\d{3}\.gbp\.gz$|^manifest\.json$/.test(name)) await rm(path.join(recipesDir, name));
      }
      for (const [name, bytes] of files) await writeFile(path.join(recipesDir, name), bytes);
    }
    return { target, version: supported.version, recipes: files.size - 1, checked: check };
  } finally {
    try { unmount(); } catch {}
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node windows/tools/desktop-recipes/build.mjs [--target windows|mac|linux-x64|linux-arm64|all] [--source <Setup.exe|app-64.7z|.dmg|.app|.deb|dir>] [--check]');
    return;
  }
  const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const targetArg = arg('--target');
  const sourceArg = arg('--source');
  const check = args.includes('--check');
  const targets = resolveTargets({ target: targetArg, source: sourceArg });
  const results = [];
  for (const target of targets) {
    results.push(await buildForTarget(target, { sourceArg, check }));
  }
  console.log(JSON.stringify(results.length === 1 ? results[0] : { results }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

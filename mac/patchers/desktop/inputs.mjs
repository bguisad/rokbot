import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url));
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
const VERSION = /^\d+\.\d+\.\d+$/;
const newestFirst = (a, b) => b.supported.version.localeCompare(a.supported.version, 'en', { numeric: true });

// supported.json and recipes/ beside this file follow the recommended macOS release. Older
// releases that still build (the fallback) keep their pins and recipes in a directory named
// after their version.
export async function macInputs(version, root = desktop) {
  if (!VERSION.test(version)) throw new Error(`Invalid macOS version: ${version}`);
  const current = await readJson(path.join(root, 'supported.json'));
  const directory = current.version === version ? root : path.join(root, version);
  const supported = directory === root ? current : await readJson(path.join(directory, 'supported.json')).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`No macOS ${version} inputs under mac/patchers/desktop.`);
    throw error;
  });
  if (supported.version !== version) throw new Error(`macOS inputs in ${directory} are for ${supported.version}, not ${version}.`);
  return { directory, supported };
}

/** Every macOS release with pins and recipes, the recommended one first. */
export async function macReleases(root = desktop) {
  const current = await macInputs((await readJson(path.join(root, 'supported.json'))).version, root);
  const older = [];
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory() && VERSION.test(entry.name)) older.push(await macInputs(entry.name, root));
  return [current, ...older.sort(newestFirst)];
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The release an explicit source belongs to: a whole official DMG or an unpacked .app bundle,
 * recognised only by pinned size/SHA-256. Anything else gets the recommended candidate, whose
 * own verification then rejects it.
 */
export async function macReleaseFor(source, candidates) {
  if (!candidates.length) throw new Error('No macOS releases to choose from.');
  if (!source) return candidates[0];
  const info = await stat(source).catch(() => null);
  if (!info) return candidates[0];
  if (info.isDirectory()) {
    const asar = path.join(source, 'Contents/Resources/app.asar');
    const digest = await sha256(asar).catch(() => null);
    return candidates.find(({ supported }) => supported.asarSha256 === digest) ?? candidates[0];
  }
  const sizeMatches = candidates.filter(({ supported }) => supported.archive?.bytes === info.size);
  if (!sizeMatches.length) return candidates[0];
  const digest = await sha256(source);
  return sizeMatches.find(({ supported }) => supported.archive?.sha256 === digest) ?? candidates[0];
}

/** Picks the release for --version, or for the given source, among the macOS releases. */
export async function selectMacRelease({ source, version, accepted } = {}, root = desktop) {
  const releases = (await macReleases(root)).filter(({ supported }) => !accepted || accepted.includes(supported.version));
  if (version) {
    const release = releases.find(({ supported }) => supported.version === version);
    if (!release) throw new Error(`不支持 Grok Bot ${version}。可用版本：${releases.map(({ supported }) => supported.version).join('、')}。`);
    return release;
  }
  return macReleaseFor(source && path.resolve(source), releases);
}

// Release inputs for Linux desktop architectures (x64, arm64) and optional fallback versions.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.dirname(fileURLToPath(import.meta.url));
export const LINUX_ARCHITECTURES = ['x64', 'arm64'];
const VERSION = /^\d+\.\d+\.\d+$/;
const ARCH_ALIASES = new Map([
  ['x64', 'x64'],
  ['amd64', 'x64'],
  ['x86_64', 'x64'],
  ['arm64', 'arm64'],
  ['aarch64', 'arm64'],
]);

export function normalizeLinuxArch(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') {
    if (fallback) return normalizeLinuxArch(fallback);
    return process.arch === 'arm64' ? 'arm64' : 'x64';
  }
  const normalized = ARCH_ALIASES.get(String(raw).trim().toLowerCase());
  if (!normalized) {
    throw new Error(`不支持的 Linux 架构：${raw}。可用架构：${LINUX_ARCHITECTURES.join('、')}。`);
  }
  return normalized;
}

const compareVersion = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i] - left[i];
  return 0;
};

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function linuxReleasesForArch(arch, root = defaultRoot) {
  const normalizedArch = normalizeLinuxArch(arch);
  const archDir = path.join(root, normalizedArch);
  const recommended = JSON.parse(await readFile(path.join(archDir, 'supported.json'), 'utf8'));
  const older = [];
  for (const entry of await readdir(archDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !VERSION.test(entry.name)) continue;
    const directory = path.join(archDir, entry.name);
    const supported = JSON.parse(await readFile(path.join(directory, 'supported.json'), 'utf8'));
    if (supported.version !== entry.name) {
      throw new Error(`Linux ${normalizedArch} ${entry.name} inputs are for ${supported.version}, not ${entry.name}`);
    }
    older.push({ directory, supported, arch: normalizedArch });
  }
  older.sort((a, b) => compareVersion(a.supported.version, b.supported.version));
  return [{ directory: archDir, supported: recommended, arch: normalizedArch }, ...older];
}

export async function allLinuxReleases(root = defaultRoot) {
  const lists = await Promise.all(LINUX_ARCHITECTURES.map(arch => linuxReleasesForArch(arch, root)));
  return lists.flat();
}

export async function selectLinuxRelease({ source, arch, version, root = defaultRoot } = {}) {
  if (arch) {
    const releases = await linuxReleasesForArch(arch, root);
    if (version) {
      const hit = releases.find(({ supported }) => supported.version === version);
      if (!hit) {
        const available = releases.map(({ supported }) => supported.version).join('、');
        throw new Error(`不支持 Grok Bot ${version} (Linux ${normalizeLinuxArch(arch)})。可用版本：${available}。`);
      }
      return hit;
    }
    if (source) {
      const matched = await matchSource(source, releases);
      if (matched) return matched;
    }
    return releases[0];
  }

  const all = await allLinuxReleases(root);
  if (source) {
    const matched = await matchSource(source, all);
    if (matched) {
      if (version && matched.supported.version !== version) {
        throw new Error(`指定的源文件版本为 ${matched.supported.version}，与 --version ${version} 不一致。`);
      }
      return matched;
    }
  }
  const defaultArch = normalizeLinuxArch(null);
  const releases = all.filter(item => item.arch === defaultArch);
  if (version) {
    const hit = releases.find(({ supported }) => supported.version === version);
    if (!hit) {
      const available = releases.map(({ supported }) => supported.version).join('、');
      throw new Error(`不支持 Grok Bot ${version} (Linux ${defaultArch})。可用版本：${available}。`);
    }
    return hit;
  }
  return releases[0];
}

async function matchSource(source, releases) {
  const info = await stat(source).catch(() => null);
  if (!info) return null;
  if (info.isFile()) {
    const candidates = releases.filter(({ supported }) => info.size === supported.archive?.bytes);
    if (!candidates.length) return null;
    const digest = await sha256File(source);
    return candidates.find(({ supported }) => supported.archive?.sha256 === digest) ?? null;
  }
  if (info.isDirectory()) {
    for (const rel of ['resources/app.asar', 'opt/Grok Bot/resources/app.asar']) {
      const asarFile = path.join(source, rel);
      const asarStat = await stat(asarFile).catch(() => null);
      if (!asarStat?.isFile()) continue;
      const digest = await sha256File(asarFile);
      const hit = releases.find(({ supported }) => supported.asarSha256 === digest);
      if (hit) return hit;
    }
  }
  return null;
}

// Cross-platform .deb unpacker and pure-Node GNU `ar` .deb builder (works on Linux and macOS without dpkg-deb).
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const AR_MAGIC = Buffer.from('!<arch>\n', 'ascii');
const AR_END = Buffer.from('`\n', 'ascii');

function padField(value, width) {
  const text = String(value);
  if (text.length > width) throw new Error(`ar header field exceeds ${width} bytes: ${text}`);
  return text.padEnd(width, ' ');
}

/** Encode a standard GNU/Debian `ar` archive buffer from `[{ name, data, mtime?, mode? }]`. */
export function buildArArchive(members) {
  const parts = [AR_MAGIC];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const member of members) {
    const data = Buffer.isBuffer(member.data) ? member.data : Buffer.from(member.data);
    const name = String(member.name);
    if (name.length > 16) throw new Error(`ar member name too long: ${name}`);
    const header = Buffer.from(
      padField(name, 16) +
      padField(member.mtime ?? nowSec, 12) +
      padField(0, 6) +
      padField(0, 6) +
      padField((member.mode ?? 0o100644).toString(8), 8) +
      padField(data.length, 10),
      'ascii',
    );
    parts.push(header, AR_END, data);
    if (data.length % 2 === 1) parts.push(Buffer.from('\n', 'ascii'));
  }
  return Buffer.concat(parts);
}

/** Parse a standard GNU/Debian `ar` archive buffer into `[{ name, size, data }]`. */
export function parseArArchive(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(AR_MAGIC)) {
    throw new Error('Invalid .deb archive: missing ar magic');
  }
  const members = [];
  let offset = 8;
  while (offset < buf.length) {
    if (offset + 60 > buf.length) throw new Error('Truncated ar header');
    if (!buf.subarray(offset + 58, offset + 60).equals(AR_END)) {
      throw new Error('Malformed ar member header trailer');
    }
    const rawName = buf.subarray(offset, offset + 16).toString('ascii').trim();
    const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
    const size = Number.parseInt(buf.subarray(offset + 48, offset + 58).toString('ascii').trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 60 + size > buf.length) {
      throw new Error(`Invalid ar member size for ${name}`);
    }
    const data = buf.subarray(offset + 60, offset + 60 + size);
    members.push({ name, size, data });
    offset += 60 + size + (size % 2);
  }
  return members;
}

async function runTar(args, { cwd } = {}) {
  const env = { ...process.env, COPYFILE_DISABLE: '1', COPY_EXTENDED_ATTRIBUTES_DISABLE: '1' };
  const candidates = process.platform === 'darwin' ? ['/usr/bin/bsdtar', '/usr/bin/tar', 'tar'] : ['tar', 'bsdtar'];
  let lastError;
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
      return;
    } catch (error) {
      if (error.code === 'ENOENT') { lastError = error; continue; }
      throw error;
    }
  }
  throw lastError ?? new Error('未找到 tar / bsdtar 工具。');
}

/**
 * Unpack a Debian `.deb` archive into `{ controlDir, dataDir, appDir }`.
 * Parses the outer `ar` container directly in Node.js (avoiding macOS BSD `ar` quirks)
 * and extracts `control.tar.*` and `data.tar.*` via `tar`/`bsdtar`.
 */
export async function unpackDeb(debPath, workDir) {
  const debBytes = await readFile(debPath);
  const members = parseArArchive(debBytes);
  const controlMember = members.find(m => /^control\.tar(\.(gz|xz|zst|bz2))?$/.test(m.name));
  const dataMember = members.find(m => /^data\.tar(\.(gz|xz|zst|bz2))?$/.test(m.name));
  if (!controlMember || !dataMember) {
    throw new Error('无效的 .deb 包：缺少 control.tar 或 data.tar。');
  }
  const stageDir = path.join(workDir, 'deb-stage');
  const controlDir = path.join(workDir, 'deb-control');
  const dataDir = path.join(workDir, 'deb-data');
  await Promise.all([
    mkdir(stageDir, { recursive: true }),
    mkdir(controlDir, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);
  const controlTar = path.join(stageDir, controlMember.name);
  const dataTar = path.join(stageDir, dataMember.name);
  await Promise.all([writeFile(controlTar, controlMember.data), writeFile(dataTar, dataMember.data)]);
  await runTar(['-xf', controlTar, '-C', controlDir]);
  await runTar(['-xf', dataTar, '-C', dataDir]);
  const appDir = path.join(dataDir, 'opt/Grok Bot');
  const info = await stat(appDir).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error('无效的 Grok Bot .deb 包：未找到 /opt/Grok Bot 目录。');
  }
  return { controlDir, dataDir, appDir };
}

/**
 * Create a clean, portable `.tar.gz` archive of `sourceDir` contents.
 */
export async function createTarGz(sourceDir, outputPath, entries = ['.']) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const isMac = process.platform === 'darwin';
  const args = isMac
    ? ['--no-xattrs', '--no-mac-metadata', '--uid', '0', '--gid', '0', '-czf', outputPath, '-C', sourceDir, ...entries]
    : ['--numeric-owner', '--owner=0', '--group=0', '-czf', outputPath, '-C', sourceDir, ...entries];
  try {
    await runTar(args);
  } catch (error) {
    // Fallback for GNU tar or older bsdtar without --no-mac-metadata
    await runTar(['-czf', outputPath, '-C', sourceDir, ...entries]);
  }
}

/**
 * Build a Debian `.deb` package from `controlDir` and `dataDir` without requiring `dpkg-deb`.
 * Uses `debian-binary` (2.0), `control.tar.gz`, and `data.tar.gz` inside a standard GNU `ar` archive.
 */
export async function buildDeb({ controlDir, dataDir, outputPath }) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'rokbot-deb-build-'));
  try {
    const controlTar = path.join(temp, 'control.tar.gz');
    const dataTar = path.join(temp, 'data.tar.gz');
    await createTarGz(controlDir, controlTar, ['.']);
    await createTarGz(dataDir, dataTar, ['.']);
    const [controlData, dataData] = await Promise.all([readFile(controlTar), readFile(dataTar)]);
    const deb = buildArArchive([
      { name: 'debian-binary', data: Buffer.from('2.0\n', 'ascii') },
      { name: 'control.tar.gz', data: controlData },
      { name: 'data.tar.gz', data: dataData },
    ]);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, deb);
    return deb;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

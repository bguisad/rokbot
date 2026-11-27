// "Migrate from Grok Bot" on the desktop (macOS, Windows, Linux).
// Finds the local Grok Bot data folders, packs only the allowlisted cache files into a ZIP in
// memory and uploads it to the connected Host, which parses it and lists it as pending. The Grok
// Bot folder is only read: nothing in it is modified, moved or deleted, and credential stores,
// cookies and webhook keys are never opened (their presence is reported by name only).
import { readdir, readFile, lstat, stat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from './zip-store.mjs';

const CACHE_FILE = /^[a-z2-7]+\.blob$/;
const MAX_FILE = 64 * 1024 * 1024;

/** Candidate data folders: Electron keeps userData at <appData>/<product name>. */
export function candidateFolders({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const roots = platform === 'darwin' ? [path.join(home, 'Library', 'Application Support')]
    : platform === 'win32' ? [env.APPDATA || path.join(home, 'AppData', 'Roaming'), env.LOCALAPPDATA].filter(Boolean)
      : [env.XDG_CONFIG_HOME || path.join(home, '.config')];
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return roots.flatMap(root => [
    { path: join(root, 'Grok Bot'), title: 'Grok Bot', kind: 'official' },
    { path: join(root, 'Grok Bot Local'), title: 'Grok Bot Local（旧版本地客户端）', kind: 'legacy' },
  ]);
}

/** Reports which candidates exist and what they hold, by counting file names only. */
export async function detectFolders(options) {
  const found = [];
  for (const candidate of candidateFolders(options)) {
    const info = await lstat(candidate.path).catch(() => null);
    if (!info?.isDirectory()) continue;
    const summary = await summarize(candidate.path);
    if (summary.cacheFiles || summary.legacy) found.push({ ...candidate, ...summary });
  }
  return found;
}

async function summarize(root) {
  const cache = await readdir(path.join(root, 'sand-client-persistence')).catch(() => []);
  const legacy = Boolean(await stat(path.join(root, 'local-client-persistence.json')).catch(() => null));
  return { cacheFiles: cache.filter(name => CACHE_FILE.test(name)).length, legacy };
}

/**
 * Collects the files the Host importer reads. Marker entries (empty files) stand for credential
 * stores whose existence matters for the report; their contents are never read.
 */
export async function collectFolder(root) {
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error('请选择 Grok Bot 数据目录');
  const entries = [];
  const add = async (relative, full) => {
    const file = await lstat(full).catch(() => null);
    if (!file?.isFile() || file.size > MAX_FILE) return;
    entries.push({ name: relative, data: await readFile(full) });
  };
  for (const name of await readdir(path.join(root, 'sand-client-persistence')).catch(() => []))
    if (CACHE_FILE.test(name)) await add(`sand-client-persistence/${name}`, path.join(root, 'sand-client-persistence', name));
  await add('local-client-persistence.json', path.join(root, 'local-client-persistence.json'));
  for (const name of await readdir(root).catch(() => []))
    if (/^rokbot-migrate.*\.json$/i.test(name)) await add(name, path.join(root, name));
  const keys = (await readdir(path.join(root, 'automation-webhook-keys')).catch(() => [])).filter(name => name.endsWith('.bin'));
  keys.forEach((_, index) => entries.push({ name: `automation-webhook-keys/${index + 1}.bin`, data: new Uint8Array() }));
  if (await lstat(path.join(root, 'sand-secrets.json')).catch(() => null)) entries.push({ name: 'sand-secrets.json', data: new Uint8Array() });
  if (!entries.some(entry => entry.name.startsWith('sand-client-persistence/') || entry.name === 'local-client-persistence.json' || entry.name.endsWith('.json') && entry.data.length))
    throw new Error('这个目录里没有找到 Grok Bot 数据');
  return { zip: storeZip(entries), files: entries.filter(entry => entry.data.length).length };
}

/** STORE ZIP that keeps relative paths (the Host reads `sand-client-persistence/<key>.blob`). */
export function storeZip(entries) {
  const encoder = new TextEncoder(), local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name), data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(record, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/**
 * Main-process handlers for the migration window. `getConfig` returns the paired Host
 * ({ server, token }); `request` is the gateway's JSON request.
 */
export function createMigration({ getConfig, request, dialog, getWindow, clipboard, fetchImpl = fetch, platform = process.platform }) {
  const json = (endpoint, body, method = 'POST') => request(endpoint, body, AbortSignal.timeout(method === 'POST' && endpoint.endsWith('/import') ? 600000 : 30000), method);
  async function upload(body, name, contentType, onProgress) {
    const config = getConfig();
    if (!config) throw new Error('尚未连接 Host');
    const response = await fetchImpl(`${config.server}/local/migrate/packages?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': contentType }, body, duplex: 'half', redirect: 'error',
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.error || `上传失败（HTTP ${response.status}）`);
    onProgress?.(1);
    return value;
  }
  async function uploadFile(file, onProgress) {
    const info = await stat(file);
    const handle = await open(file, 'r');
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        const buffer = Buffer.alloc(1024 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, sent);
        if (!bytesRead) { await handle.close(); controller.close(); return; }
        sent += bytesRead; onProgress?.(info.size ? sent / info.size * 0.95 : 0);
        controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
      },
      async cancel() { await handle.close(); },
    });
    return upload(body, path.basename(file), /\.json$/i.test(file) ? 'application/json' : 'application/zip', onProgress);
  }
  async function uploadFolder(folder, onProgress) {
    onProgress?.(0.1);
    const { zip } = await collectFolder(folder);
    onProgress?.(0.4);
    return upload(zip, `本机 Grok Bot 数据目录（${path.basename(folder)}）`, 'application/zip', onProgress);
  }
  return {
    detect: () => detectFolders({ platform }),
    uploadFolder, uploadFile,
    async chooseFolder(onProgress) {
      const result = await dialog.showOpenDialog(getWindow(), { title: '选择 Grok Bot 数据目录', properties: ['openDirectory', 'showHiddenFiles'],
        defaultPath: candidateFolders({ platform })[0].path });
      return result.canceled || !result.filePaths[0] ? null : uploadFolder(result.filePaths[0], onProgress);
    },
    async chooseFile(onProgress) {
      const result = await dialog.showOpenDialog(getWindow(), { title: '选择迁移包', properties: ['openFile'], filters: [{ name: '迁移包', extensions: ['zip', 'json'] }] });
      return result.canceled || !result.filePaths[0] ? null : uploadFile(result.filePaths[0], onProgress);
    },
    list: () => json('/local/migrate', null, 'GET'),
    createToken: body => json('/local/migrate/tokens', body ?? {}),
    revokeToken: id => json(`/local/migrate/tokens/${encodeURIComponent(id)}`, null, 'DELETE'),
    prompt: ({ tokenId, scope } = {}) => json(`/local/migrate/prompt?${new URLSearchParams({ ...(tokenId ? { tokenId } : {}), ...(scope ? { scope } : {}) })}`, null, 'GET'),
    preview: id => json(`/local/migrate/packages/${encodeURIComponent(id)}`, null, 'GET'),
    import: (id, selection) => json(`/local/migrate/packages/${encodeURIComponent(id)}/import`, selection ?? {}),
    discard: id => json(`/local/migrate/packages/${encodeURIComponent(id)}`, null, 'DELETE'),
    copy: text => { clipboard.writeText(String(text ?? '')); return true; },
  };
}

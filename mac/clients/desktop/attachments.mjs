import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rokText } from './i18n.mjs';
import { buildZipStore, uniqueEntryName } from './zip-store.mjs';

const CHUNK_BYTES = 4 * 1024 * 1024;
const PREVIEW_BYTES = 25 * 1024 * 1024;
const TEXT_HEAD_BYTES = 6 * 1024 * 1024;
// The Host's own playback limit for video attachments.
const MEDIA_BYTES = 200 * 1024 * 1024;
const MEDIA_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Same extensions as the Host's video/audio MIME tables (readAttachmentChunk returns their MIME).
const VIDEO_EXTENSION = /\.(?:mp4|m4v|mov|webm|ogv)$/i;
const AUDIO_EXTENSION = /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/i;

/** 'video' or 'audio' when the original renderer plays this attachment in a media element. */
export function playableMediaKind(name) {
  if (typeof name !== 'string') return null;
  return VIDEO_EXTENSION.test(name) ? 'video' : AUDIO_EXTENSION.test(name) ? 'audio' : null;
}

// These are remote Host paths, never files to open on the client's filesystem.
// The Host runs on Linux, so file URLs use POSIX rules even when this client runs on Windows.
export function remoteAttachmentPath(source) {
  if (typeof source !== 'string' || !source || source.includes('\0')) return null;
  if (/^file:/i.test(source)) {
    try { return fileURLToPath(source, { windows: false }); } catch { return null; }
  }
  return /^[a-z][a-z\d+.-]*:/i.test(source) ? null : source;
}

function totalSize(chunk) {
  if (!Number.isSafeInteger(chunk?.totalSize) || chunk.totalSize < 0)
    throw new Error(rokText('附件大小无效。', 'Invalid attachment size.'));
  return chunk.totalSize;
}

const MEDIA_EXTENSION_BY_MIME = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv',
  'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg',
  'audio/wav': '.wav', 'audio/webm': '.weba', 'audio/flac': '.flac' };
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const defaultMediaDir = () => path.join(tmpdir(), `rokbot-attachment-media${uid === null ? '' : `-${uid}`}`);

/**
 * The original renderer plays video and audio in a media element. Its CSP (`media-src 'self' blob:`)
 * and the main-process request filter only let it load local files, so copy the Host file through the
 * gateway chunk read into a per-user cache and hand back a seekable file URL.
 */
function createMediaCache({ command, mediaDir }) {
  const pending = new Map();
  let ready;
  async function prepare() {
    await mkdir(mediaDir, { recursive: true, mode: 0o700 });
    const info = await stat(mediaDir);
    if (!info.isDirectory() || (uid !== null && info.uid !== uid)) throw new Error('Invalid media cache directory');
    const now = Date.now();
    for (const name of await readdir(mediaDir)) {
      const file = path.join(mediaDir, name);
      const entry = await stat(file).catch(() => null);
      if (entry && now - entry.mtimeMs > MEDIA_CACHE_MAX_AGE_MS) await rm(file, { force: true }).catch(() => {});
    }
  }
  async function copy(remote, kind) {
    const read = (offset, length) => command('readAttachmentChunk', { path: remote, offset, length,
      ...(kind === 'video' ? { videoPlayback: true } : {}) }, AbortSignal.timeout(30000));
    const info = await read(0, 0);
    if (info === null) throw new Error('Attachment not found');
    const size = totalSize(info);
    if (size === 0 || size > MEDIA_BYTES) throw new Error(rokText('附件为空或过大，无法播放。', 'Attachment is empty or too large to play.'));
    ready ??= prepare().catch(error => { ready = undefined; throw error; });
    await ready;
    const extension = MEDIA_EXTENSION_BY_MIME[info.mime] ?? path.posix.extname(remote).toLowerCase();
    const target = path.join(mediaDir, `${createHash('sha256').update(`${kind}\0${remote}\0${size}`).digest('hex')}${extension}`);
    const cached = await stat(target).catch(() => null);
    if (cached?.isFile() && cached.size === size) return target;
    const temporary = path.join(mediaDir, `.${randomUUID()}.part`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        for (let offset = 0; offset < size;) {
          const length = Math.min(CHUNK_BYTES, size - offset);
          const chunk = await read(offset, length);
          if (chunk === null) throw new Error('Attachment not found');
          if (totalSize(chunk) !== size || typeof chunk.bytesBase64 !== 'string')
            throw new Error(rokText('附件已改变，请重试。', 'The attachment changed. Try again.'));
          const bytes = Buffer.from(chunk.bytesBase64, 'base64');
          if (bytes.length === 0 || bytes.length > length)
            throw new Error(rokText('附件读取不完整，请重试。', 'Incomplete attachment. Try again.'));
          await file.write(bytes, 0, bytes.length, offset);
          offset += bytes.length;
        }
      } finally { await file.close(); }
      await rename(temporary, target);
      return target;
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return async (remote, kind) => {
    const key = `${kind}\0${remote}`;
    let task = pending.get(key);
    if (!task) {
      task = copy(remote, kind).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    const src = pathToFileURL(await task).href;
    return kind === 'video' ? { kind, src, width: null, height: null } : { kind, src };
  };
}

export function createAttachmentMediaResolver({ command, withStaged, nativeImage, mediaDir = defaultMediaDir() }) {
  const media = createMediaCache({ command, mediaDir });
  return async ({ source, rendition }) => {
    const remoteMedia = remoteAttachmentPath(source);
    const mediaKind = playableMediaKind(remoteMedia);
    if (mediaKind && await withStaged(source, async () => true) === null) return await media(remoteMedia, mediaKind);
    const staged = await withStaged(source, async (file, size) => {
      if (size > PREVIEW_BYTES) throw new Error(rokText('附件过大，无法预览。', 'Attachment is too large to preview.'));
      return nativeImage.createFromBuffer(await localChunk(file, 0, size));
    });
    const remote = remoteAttachmentPath(source);
    if (!staged && remote === null) throw new Error('Invalid attachment path');
    const result = staged ? { dataUrl: staged.toDataURL() }
      : await command('readAttachmentImage', { path: remote,
        rendition: rendition === 'original' ? 'original' : 'preview' }, AbortSignal.timeout(30000));
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(result?.dataUrl)) throw new Error('Unsupported attachment');
    const image = staged ?? nativeImage.createFromDataURL(result.dataUrl);
    if (image.isEmpty()) {
      if (/^data:image\/(webp|gif);base64,/.test(result.dataUrl)) {
        const width = Number.isFinite(result?.width) ? result.width : 0;
        const height = Number.isFinite(result?.height) ? result.height : 0;
        return { kind: 'image', src: result.dataUrl, width, height };
      }
      throw new Error('Invalid image attachment');
    }
    const size = image.getSize();
    const width = Number(/^tile-(\d+)$/.exec(rendition ?? '')?.[1]);
    return { kind: 'image', src: width && size.width > width ? image.resize({ width }).toDataURL() : result.dataUrl, ...size };
  };
}

async function localChunk(file, offset, length) {
  const bytes = Buffer.alloc(length);
  for (let done = 0; done < length;) {
    const { bytesRead } = await file.read(bytes, done, length - done, offset + done);
    if (!bytesRead) throw new Error('Staged attachment changed');
    done += bytesRead;
  }
  return bytes;
}

export function createAttachmentHandlers({ command, chooseDestination, chooseDirectory, showDownloadError, withStaged = async () => null }) {
  const request = (method, args) => command(method, args, AbortSignal.timeout(30000));
  const scope = ({ path: source, agentId }) => {
    const value = remoteAttachmentPath(source);
    return value === null ? null : { path: value, ...(agentId ? { agentId } : {}) };
  };
  async function readChunk(args, offset, length, expectedSize) {
    const chunk = await request('readAttachmentChunk', { ...args, offset, length });
    if (chunk === null) return null;
    if (totalSize(chunk) !== expectedSize || typeof chunk.bytesBase64 !== 'string')
      throw new Error(rokText('附件已改变，请重试。', 'The attachment changed. Try again.'));
    const bytes = Buffer.from(chunk.bytesBase64, 'base64');
    if (bytes.length === 0 || bytes.length > length)
      throw new Error(rokText('附件读取不完整，请重试。', 'Incomplete attachment. Try again.'));
    return bytes;
  }
  async function writeAtomic(destination, size, read) {
    const temporary = path.join(path.dirname(destination), `.rokbot-download-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        for (let offset = 0; offset < size;) {
          const bytes = await read(offset, Math.min(CHUNK_BYTES, size - offset));
          if (bytes === null) throw new Error('Attachment not found');
          await file.writeFile(bytes);
          offset += bytes.length;
        }
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, destination);
      return true;
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function saveDownload(size, name, read) {
    const destination = await chooseDestination(path.basename(name));
    if (!destination) return false;
    return await writeAtomic(destination, size, read);
  }
  async function prepareRemoteItem(item) {
    const args = scope(item);
    if (args === null) throw new Error('Invalid attachment path');
    const info = await request('readAttachmentChunk', { ...args, offset: 0, length: 0 });
    if (info === null) throw new Error('Attachment not found');
    const size = totalSize(info);
    return {
      args,
      size,
      name: item.suggestedName || info.resolvedName || args.path,
    };
  }
  async function readAllBytes(item) {
    const staged = await withStaged(item.path, async (file, size) => ({
      name: item.suggestedName || path.basename(item.path),
      data: await localChunk(file, 0, size),
    }));
    if (staged !== null) return staged;
    const prepared = await prepareRemoteItem(item);
    const out = Buffer.alloc(prepared.size);
    for (let offset = 0; offset < prepared.size;) {
      const chunk = await readChunk(prepared.args, offset, Math.min(CHUNK_BYTES, prepared.size - offset), prepared.size);
      if (chunk === null) throw new Error('Attachment not found');
      chunk.copy(out, offset);
      offset += chunk.length;
    }
    return { name: prepared.name, data: out };
  }
  return {
    async readAttachmentText(input) {
      const staged = await withStaged(input.path, async (file, size) => ({ kind: 'text',
        text: (await localChunk(file, 0, Math.min(size, TEXT_HEAD_BYTES))).toString('utf8'),
        bytes: size, truncated: size > TEXT_HEAD_BYTES }));
      if (staged !== null) return staged;
      const args = scope(input);
      return args === null ? null : request('readAttachmentText', args);
    },
    async readAttachmentBytes(input) {
      const maxBytes = Number.isFinite(input.maxBytes) && input.maxBytes > 0
        ? Math.min(Math.floor(input.maxBytes), PREVIEW_BYTES) : PREVIEW_BYTES;
      const staged = await withStaged(input.path, async (file, size) => {
        if (size > maxBytes) return { kind: 'too-large', size };
        const text = /\.(?:md|markdown|txt|text)$/i.test(input.path);
        const bytes = await localChunk(file, 0, text ? Math.min(size, TEXT_HEAD_BYTES) : size);
        return { kind: 'bytes', bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), size };
      });
      if (staged !== null) return staged;
      const args = scope(input);
      if (args === null) return null;
      const info = await request('readAttachmentChunk', { ...args, offset: 0, length: 0 });
      if (info === null) return null;
      const size = totalSize(info);
      const name = info.resolvedName ? { resolvedName: info.resolvedName } : {};
      if (size > maxBytes) return { kind: 'too-large', size, ...name };
      const text = /\.(?:md|markdown|txt|text)$/i.test(info.resolvedName ?? args.path);
      const bytes = new Uint8Array(Math.min(size, text ? TEXT_HEAD_BYTES : maxBytes));
      for (let offset = 0; offset < bytes.length;) {
        const chunk = await readChunk(args, offset, Math.min(CHUNK_BYTES, bytes.length - offset), size);
        if (chunk === null) return null;
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { kind: 'bytes', bytes, size, ...name };
    },
    async downloadAttachment(input) {
      try {
        const local = await withStaged(input.path, (file, size) => saveDownload(size, input.suggestedName || input.path,
          (offset, length) => localChunk(file, offset, length)));
        if (local !== null) return local;
        const args = scope(input);
        if (args === null) throw new Error('Invalid attachment path');
        const info = await request('readAttachmentChunk', { ...args, offset: 0, length: 0 });
        if (info === null) throw new Error('Attachment not found');
        const size = totalSize(info);
        return await saveDownload(size, input.suggestedName || info.resolvedName || args.path,
          (offset, length) => readChunk(args, offset, length, size));
      } catch (error) {
        console.error('[attachment-download]', error.message);
        await showDownloadError();
        return false;
      }
    },
    async downloadAttachments(input) {
      const downloads = Array.isArray(input?.downloads) ? input.downloads : [];
      if (downloads.length === 0) return false;
      if (downloads.length === 1) return await this.downloadAttachment(downloads[0]);
      if (typeof chooseDirectory !== 'function') return await this.downloadAttachmentsZip(input);
      try {
        const folder = await chooseDirectory();
        if (!folder) return false;
        const existing = new Set((await readdir(folder).catch(() => [])).map(name => name.toLowerCase()));
        let failures = 0;
        for (const item of downloads) {
          try {
            const localSaved = await withStaged(item.path, async (file, size) => {
              const filename = uniqueEntryName(item.suggestedName || item.path, existing, 'attachment');
              return await writeAtomic(path.join(folder, filename), size, (offset, length) => localChunk(file, offset, length));
            });
            if (localSaved !== null) continue;
            const prepared = await prepareRemoteItem(item);
            const filename = uniqueEntryName(prepared.name, existing, 'attachment');
            await writeAtomic(path.join(folder, filename), prepared.size, (offset, length) => readChunk(prepared.args, offset, length, prepared.size));
          } catch (error) {
            failures += 1;
            console.error('[attachment-download-batch]', error.message);
          }
        }
        if (failures > 0) {
          await showDownloadError();
          return false;
        }
        return true;
      } catch (error) {
        console.error('[attachment-download-batch]', error.message);
        await showDownloadError();
        return false;
      }
    },
    async downloadAttachmentsZip(input) {
      const downloads = Array.isArray(input?.downloads) ? input.downloads : [];
      if (downloads.length === 0) return false;
      try {
        const suggested = input?.suggestedName || `rokbot-images-${new Date().toISOString().slice(0, 10)}.zip`;
        const destination = await chooseDestination(path.basename(suggested));
        if (!destination) return false;
        const entries = [];
        for (const item of downloads) {
          entries.push(await readAllBytes(item));
        }
        const zipBytes = Buffer.from(buildZipStore(entries));
        return await writeAtomic(destination, zipBytes.length, async (offset, length) => zipBytes.subarray(offset, offset + length));
      } catch (error) {
        console.error('[attachment-download-zip]', error.message);
        await showDownloadError();
        return false;
      }
    },
  };
}

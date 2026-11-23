import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileKind } from './model-common.mjs';

export const OMITTED_IMAGE_NOTE =
  '[Earlier image omitted from context to reduce request size; ask or re-read the file if needed.]';

const DEFAULT_KEEP_MIN = 4;
const DEFAULT_PRUNE_BATCH = 4;
const DEFAULT_MAX_DIM = 1024;
const DEFAULT_JPEG_QUALITY = 80;
const MIN_COMPRESS_BYTES = 80 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 512 * 1024;
const MAX_CACHE_ENTRIES = 256;

const require = createRequire(import.meta.url);
const imageCache = new Map();
let cachedCanvasModule;

function envValue(suffix) {
  return process.env[`ROKBOT_${suffix}`] ?? process.env[`GROKBOT_${suffix}`];
}

function positiveInt(value, fallback, maximum = 1_000_000) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function clampQuality(value, fallback = DEFAULT_JPEG_QUALITY) {
  const parsed = positiveInt(value, fallback, 100);
  return Math.min(100, Math.max(1, parsed));
}

function loadCanvas() {
  if (cachedCanvasModule !== undefined) return cachedCanvasModule;
  try {
    cachedCanvasModule = require('@napi-rs/canvas');
  } catch {
    cachedCanvasModule = null;
  }
  return cachedCanvasModule;
}

function cacheGet(key) {
  if (!imageCache.has(key)) return undefined;
  const value = imageCache.get(key);
  imageCache.delete(key);
  imageCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (imageCache.has(key)) imageCache.delete(key);
  else if (imageCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
  imageCache.set(key, value);
}

export function resetImageCache() {
  imageCache.clear();
}

function collectImageLocations(messages) {
  const locations = [];
  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const message = messages[msgIndex];
    if (!message || !Array.isArray(message.content)) continue;
    if (message.role === 'user') {
      for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
        const part = message.content[partIndex];
        if (part?.type === 'image' || (part?.type === 'file' && fileKind(part) === 'image')) {
          locations.push({ msgIndex, partIndex, expIndex: -1 });
        }
      }
    } else if (message.role === 'tool') {
      for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
        const part = message.content[partIndex];
        if (part?.type === 'tool-result' && Array.isArray(part.experimental_content)) {
          for (let expIndex = 0; expIndex < part.experimental_content.length; expIndex++) {
            if (part.experimental_content[expIndex]?.type === 'image') {
              locations.push({ msgIndex, partIndex, expIndex });
            }
          }
        }
      }
    }
  }
  return locations;
}

function cloneWithOmittedImages(messages, evictedLocations) {
  const byMessage = new Map();
  for (const location of evictedLocations) {
    let entries = byMessage.get(location.msgIndex);
    if (!entries) {
      entries = [];
      byMessage.set(location.msgIndex, entries);
    }
    entries.push(location);
  }
  return messages.map((message, msgIndex) => {
    const entries = byMessage.get(msgIndex);
    if (!entries) return message;
    const content = [...message.content];
    const expByPart = new Map();
    for (const entry of entries) {
      if (entry.expIndex === -1) {
        content[entry.partIndex] = { type: 'text', text: OMITTED_IMAGE_NOTE };
      } else {
        let indices = expByPart.get(entry.partIndex);
        if (!indices) {
          indices = [];
          expByPart.set(entry.partIndex, indices);
        }
        indices.push(entry.expIndex);
      }
    }
    for (const [partIndex, indices] of expByPart) {
      const part = content[partIndex];
      const experimentalContent = [...part.experimental_content];
      for (const expIndex of indices) {
        experimentalContent[expIndex] = { type: 'text', text: OMITTED_IMAGE_NOTE };
      }
      content[partIndex] = { ...part, experimental_content: experimentalContent };
    }
    return { ...message, content };
  });
}

/**
 * Evict older images in fixed batches so prompt prefixes stay identical across
 * non-image turns and most new-image turns, preserving KV prompt caching.
 */
export function pruneHistoricalImages(messages, options = {}) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const minKeep = positiveInt(options.minKeep, DEFAULT_KEEP_MIN);
  const batchSize = positiveInt(options.batchSize, DEFAULT_PRUNE_BATCH);
  const locations = collectImageLocations(messages);
  const total = locations.length;
  if (total <= minKeep + batchSize) return messages;

  const rawEvict = Math.floor((total - minKeep) / batchSize) * batchSize;
  if (rawEvict <= 0) return messages;

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }
  let protectedCount = 0;
  for (const location of locations) {
    if (location.msgIndex > lastAssistantIndex) protectedCount++;
  }
  const evictCount = Math.min(rawEvict, total - protectedCount);
  if (evictCount <= 0) return messages;

  return cloneWithOmittedImages(messages, locations.slice(0, evictCount));
}

function extractImagePayload(part) {
  if (!part || typeof part !== 'object') return null;
  const key = part.image !== undefined ? 'image' : part.data !== undefined ? 'data' : part.url !== undefined ? 'url' : null;
  if (!key) return null;
  const value = part[key];
  const rawMime = typeof part.mimeType === 'string' && part.mimeType.trim() ? part.mimeType.trim().toLowerCase() : 'image/png';
  const fallbackMime = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;

  if (value instanceof URL) return null;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return null;
    const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is.exec(value);
    if (match) {
      const bytes = Buffer.from(match[2], 'base64');
      return bytes.length ? { key, isDataUrl: true, mimeType: (match[1] || fallbackMime).toLowerCase(), bytes } : null;
    }
    if (/^[a-z][\w+.-]*:/i.test(value)) return null;
    if (!value.trim()) return null;
    const bytes = Buffer.from(value, 'base64');
    return bytes.length ? { key, isDataUrl: false, mimeType: fallbackMime, bytes } : null;
  }
  if (value instanceof ArrayBuffer) {
    const bytes = Buffer.from(value);
    return bytes.length ? { key, isDataUrl: false, mimeType: fallbackMime, bytes } : null;
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return bytes.length ? { key, isDataUrl: false, mimeType: fallbackMime, bytes } : null;
  }
  return null;
}

function applyCompressedPayload(part, payload, compressed) {
  const encoded = payload.isDataUrl || payload.key === 'url'
    ? `data:${compressed.mimeType};base64,${compressed.base64}`
    : compressed.base64;
  return { ...part, [payload.key]: encoded, mimeType: compressed.mimeType };
}

async function encodeJpegWithCanvas(bytes, { maxDimension, jpegQuality, maxImageBytes }) {
  const canvas = loadCanvas();
  if (!canvas) return null;
  const img = await canvas.loadImage(bytes);
  if (!img?.width || !img?.height) return null;

  const render = async (dim, quality) => {
    const scale = Math.min(1, dim / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const surface = canvas.createCanvas(width, height);
    const ctx = surface.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const buffer = typeof surface.encode === 'function'
      ? await surface.encode('jpeg', quality)
      : surface.toBuffer('image/jpeg', quality);
    return { buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), width, height };
  };

  let out = await render(maxDimension, jpegQuality);
  if (out.buffer.length > maxImageBytes && maxDimension > 768) {
    out = await render(768, Math.min(jpegQuality, 72));
  }
  return {
    bytes: out.buffer,
    mimeType: 'image/jpeg',
    origWidth: img.width,
    origHeight: img.height,
    width: out.width,
    height: out.height,
  };
}

async function compressCached(payload, { maxDimension, jpegQuality, maxImageBytes, minCompressBytes, compressImage }) {
  if (payload.bytes.length <= minCompressBytes) return null;
  const digest = createHash('sha256').update(payload.bytes).digest('hex');
  const key = `${digest}:${payload.mimeType}:${maxDimension}:${jpegQuality}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  try {
    const result = await compressImage(payload.bytes, {
      mimeType: payload.mimeType,
      maxDimension,
      jpegQuality,
      maxImageBytes,
    });
    const outBytes = result?.bytes
      ? (Buffer.isBuffer(result.bytes) ? result.bytes : Buffer.from(result.bytes))
      : null;
    if (!outBytes || outBytes.length === 0 || outBytes.length >= payload.bytes.length) {
      cacheSet(key, null);
      return null;
    }
    const entry = {
      base64: outBytes.toString('base64'),
      mimeType: result.mimeType || 'image/jpeg',
      bytes: outBytes.length,
    };
    cacheSet(key, entry);
    const dims = result.origWidth && result.width
      ? `, ${result.origWidth}x${result.origHeight}->${result.width}x${result.height}`
      : '';
    console.info(
      `[image-context] compressed ${Math.round(payload.bytes.length / 1024)}KB->${Math.round(outBytes.length / 1024)}KB (${payload.mimeType}->${entry.mimeType}${dims})`
    );
    return entry;
  } catch {
    cacheSet(key, null);
    return null;
  }
}

/**
 * Bound historical images in context and downscale/re-encode oversized inline images.
 */
export async function optimizeMessageImages(messages, options = {}) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const disabled = options.enabled === false || (options.enabled !== true && envValue('IMAGE_OPTIMIZE') === '0');
  if (disabled) return messages;

  const minKeep = positiveInt(options.minKeep ?? envValue('IMAGE_KEEP_MIN'), DEFAULT_KEEP_MIN);
  const batchSize = positiveInt(options.batchSize ?? envValue('IMAGE_PRUNE_BATCH'), DEFAULT_PRUNE_BATCH);
  const maxDimension = positiveInt(options.maxDimension ?? envValue('IMAGE_MAX_DIM'), DEFAULT_MAX_DIM, 16384);
  const jpegQuality = clampQuality(options.jpegQuality ?? envValue('IMAGE_JPEG_QUALITY'), DEFAULT_JPEG_QUALITY);
  const minCompressBytes = positiveInt(options.minCompressBytes, MIN_COMPRESS_BYTES, 100_000_000);
  const maxImageBytes = positiveInt(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES, 100_000_000);
  const compressImage = options.compressImage ?? encodeJpegWithCanvas;
  const signal = options.signal;

  const pruned = pruneHistoricalImages(messages, { minKeep, batchSize });
  const compressOptions = { maxDimension, jpegQuality, maxImageBytes, minCompressBytes, compressImage };

  let anyMessageChanged = false;
  const output = new Array(pruned.length);
  for (let i = 0; i < pruned.length; i++) {
    const message = pruned[i];
    if (!message || !Array.isArray(message.content) || (message.role !== 'user' && message.role !== 'tool')) {
      output[i] = message;
      continue;
    }

    let contentChanged = false;
    const nextContent = [...message.content];

    if (message.role === 'user') {
      for (let j = 0; j < nextContent.length; j++) {
        const part = nextContent[j];
        if (!(part?.type === 'image' || (part?.type === 'file' && fileKind(part) === 'image'))) continue;
        const payload = extractImagePayload(part);
        if (!payload || payload.bytes.length <= minCompressBytes) continue;
        signal?.throwIfAborted();
        const compressed = await compressCached(payload, compressOptions);
        if (compressed) {
          nextContent[j] = applyCompressedPayload(part, payload, compressed);
          contentChanged = true;
        }
      }
    } else {
      for (let j = 0; j < nextContent.length; j++) {
        const part = nextContent[j];
        if (part?.type !== 'tool-result' || !Array.isArray(part.experimental_content)) continue;
        let expChanged = false;
        const nextExp = [...part.experimental_content];
        for (let k = 0; k < nextExp.length; k++) {
          const item = nextExp[k];
          if (item?.type !== 'image') continue;
          const payload = extractImagePayload(item);
          if (!payload || payload.bytes.length <= minCompressBytes) continue;
          signal?.throwIfAborted();
          const compressed = await compressCached(payload, compressOptions);
          if (compressed) {
            nextExp[k] = applyCompressedPayload(item, payload, compressed);
            expChanged = true;
          }
        }
        if (expChanged) {
          nextContent[j] = { ...part, experimental_content: nextExp };
          contentChanged = true;
        }
      }
    }

    if (contentChanged) {
      output[i] = { ...message, content: nextContent };
      anyMessageChanged = true;
    } else {
      output[i] = message;
    }
  }

  return anyMessageChanged ? output : pruned;
}

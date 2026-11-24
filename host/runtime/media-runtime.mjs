import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '../server/security.mjs';
import { MediaServices } from './media-services.mjs';
import { WebServices } from './web-services.mjs';
import { createVideoAnalysisSession } from './media-video-session.mjs';
import { mediaDefaults, mediaModels, describeMediaModels } from '../server/media-settings.mjs';
import { webDefaults, webRoute } from '../server/web-settings.mjs';
import { internalMediaClient, remoteMediaServices, remoteWebServices } from './media-client.mjs';

const WEBP_DATA_URL_PREFIX = 'data:image/webp;base64,';
const MAX_WEBP_JPEG_CACHE = 64;
const webpJpegCache = new Map();

/** Convert a WebP data URL to JPEG so Electron nativeImage clients (Windows/macOS) can decode previews. */
export async function transcodeWebpDataUrlToJpeg(dataUrl, { ffmpegPath = 'ffmpeg', timeoutMs = 10_000 } = {}) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(WEBP_DATA_URL_PREFIX)) return null;
  const cacheKey = createHash('sha256').update(dataUrl).digest('hex');
  const cached = webpJpegCache.get(cacheKey);
  if (cached) {
    webpJpegCache.delete(cacheKey);
    webpJpegCache.set(cacheKey, cached);
    return cached;
  }
  const input = Buffer.from(dataUrl.slice(WEBP_DATA_URL_PREFIX.length), 'base64');
  if (input.length === 0) return null;
  const jpeg = await new Promise((resolve) => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(ffmpegPath, [
        '-v', 'error', '-nostdin',
        '-f', 'webp_pipe', '-i', 'pipe:0',
        '-frames:v', '1', '-q:v', '3',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, timeoutMs);
    const chunks = [];
    let total = 0;
    child.stdout.on('data', chunk => {
      total += chunk.length;
      if (total <= 16 * 1024 * 1024) chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || total === 0 || total > 16 * 1024 * 1024) return finish(null);
      const out = Buffer.concat(chunks, total);
      if (out.length < 3 || out[0] !== 0xff || out[1] !== 0xd8) return finish(null);
      finish(`data:image/jpeg;base64,${out.toString('base64')}`);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  if (jpeg) {
    if (webpJpegCache.size >= MAX_WEBP_JPEG_CACHE) {
      const oldest = webpJpegCache.keys().next().value;
      if (oldest !== undefined) webpJpegCache.delete(oldest);
    }
    webpJpegCache.set(cacheKey, jpeg);
  }
  return jpeg;
}

const snapshot = (directory, filename, fallback) => {
  try { return JSON.parse(readFileSync(join(directory, filename), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};

/** Decorate the original attachment store; preserve uploads, previews, image cards and source accessors. */
export async function createLocalServiceRuntime(directory, { call, local = false } = {}) {
  call ??= local ? null : await internalMediaClient();
  const media = call ? remoteMediaServices(call) : await new MediaServices(directory).load();
  const web = call ? remoteWebServices(call) : new WebServices(directory);
  const mediaConfig = () => snapshot(directory, 'media.json', mediaDefaults);
  const models = kind => mediaModels(mediaConfig(), kind);
  const enabled = kind => models(kind).some(item => item.id === mediaConfig().defaults[kind]);
  const describe = kind => describeMediaModels(models(kind));
  const webService = (kind, options) => {
    const service = kind === 'search' ? web.createWebSearch(options) : web.createWebFetch(options);
    service.available = modelId => {
      const current = modelId ?? options?.modelId;
      return Boolean(webRoute(snapshot(directory, 'web-services.json', webDefaults), kind, typeof current === 'function' ? current() : current));
    };
    service.forModel = modelId => webService(kind, { ...options, modelId });
    return service;
  };
  return {
    media, web,
    createWebSearch: options => webService('search', options),
    createWebFetch: options => webService('fetch', options),
    videoAnalysisEnabled: kind => enabled(kind),
    createVideoSession: (kind, onRequestId) => createVideoAnalysisSession(media, kind, onRequestId),
    decorateAttachments(original) {
      return { ...original,
        async readImage(args) {
          const result = await original.readImage(args);
          if (typeof result?.dataUrl === 'string' && result.dataUrl.startsWith(WEBP_DATA_URL_PREFIX)) {
            const jpegDataUrl = await transcodeWebpDataUrlToJpeg(result.dataUrl);
            if (jpegDataUrl) return { ...result, dataUrl: jpegDataUrl };
            if (args?.rendition && args.rendition !== 'original') {
              try {
                const orig = await original.readImage({ ...args, rendition: 'original' });
                if (typeof orig?.dataUrl === 'string' && !orig.dataUrl.startsWith(WEBP_DATA_URL_PREFIX)) {
                  return orig;
                }
              } catch {}
            }
          }
          return result;
        },
        createGenerateImageService(options) {
          const service = media.createGenerateImageService(options);
          service.available = () => enabled('image'); service.describeModels = () => describe('image');
          service.additionalTools = ({ host, defineCommunicateTool, z }) => {
            if (!enabled('video')) return [];
            return [defineCommunicateTool({}, {
              id: 'PLATFORM_ACTION', name: 'GenerateVideo',
              description: `Generate a video with a configured Host model. The saved path can be attached with SendToUser.\n${describe('video')}`,
              parameters: z.object({ description: z.string().min(1), model: z.string().optional(),
                aspect_ratio: z.string().optional(), parameters: z.record(z.unknown()).optional(),
                reference_image_paths: z.array(z.string()).max(10).optional(),
                job_id: z.string().optional().describe('Resume a previously submitted job with the same arguments.') }),
              describeActivity: args => ({ detail: args.description.slice(0, 120) }),
              execute: async (ctx, args, deps) => {
                const references = [];
                for (const path of args.reference_image_paths ?? []) {
                  const image = await original.readImage({ path });
                  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(image?.dataUrl ?? '');
                  check(match, 400, 'Reference must be an image attachment on this Host');
                  references.push({ mimeType: match[1], data: match[2] });
                }
                const result = await media.generate('video', { prompt: args.description, model: args.model,
                  aspectRatio: args.aspect_ratio, parameters: args.parameters, references },
                  { requestId: deps.toolCallId, jobId: args.job_id, signal: ctx.signal });
                const files = [];
                for (const output of result.outputs) {
                  const extension = output.mimeType === 'video/webm' ? 'webm' : 'mp4';
                  const stored = await original.ingestBytes(host.getAgentDirImpl(), `video-${result.jobId}.${extension}`, new Uint8Array(output.bytes));
                  files.push(stored.absolutePath);
                }
                return JSON.stringify({ jobId: result.jobId, model: result.modelId, files,
                  instruction: 'Attach the generated video files with SendToUser.' });
              },
            })];
          };
          return service;
        },
        async generateAvatarImage(description) {
          const result = await media.generate('image', { prompt: description });
          return { imageBase64: result.outputs[0].bytes.toString('base64'), mimeType: result.outputs[0].mimeType };
        },
      };
    },
  };
}

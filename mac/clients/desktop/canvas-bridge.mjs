// Canvases in the desktop client. The renderer (extensions/canvas.js of the desktop recipes) opens a
// RokBot canvas link (`<host>/canvas/app/<id>`) inside the app and manages sharing; this module is
// its main-process side:
// - `sand-canvas://rokbot/<id>?theme=` (a scheme the renderer's CSP already admits in frames) is
//   answered with the Host's `/canvas/app/<id>/frame`, fetched with this device's credential, so a
//   private canvas never needs a public link and the token never reaches the renderer;
// - list / read / visibility / new link / delete go to the Host's /local/canvases API.
// The frame keeps the Host's sandbox CSP (opaque origin, no network); only `frame-ancestors`,
// which names the Host's own origin, is dropped so the renderer page may embed it.
export const CANVAS_SCHEME = 'sand-canvas';
export const CANVAS_FRAME_HOST = 'rokbot';
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const CANVAS_APP_PATH_RE = new RegExp(`^/canvas/app/(${ID})/?$`, 'i');
const ID_RE = new RegExp(`^${ID}$`, 'i');

/** The canvas id of an in-app canvas link on any Host address, or null. */
export function canvasAppId(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return CANVAS_APP_PATH_RE.exec(url.pathname)?.[1].toLowerCase() ?? null;
}

export function canvasFrameUrl(id, theme) {
  if (!ID_RE.test(String(id))) throw new Error('Invalid canvas id');
  return `${CANVAS_SCHEME}://${CANVAS_FRAME_HOST}/${String(id).toLowerCase()}?theme=${theme === 'dark' ? 'dark' : 'light'}`;
}

/** `{ id, theme }` of a frame URL this module issued, or null. */
export function parseCanvasFrameUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== `${CANVAS_SCHEME}:` || url.hostname !== CANVAS_FRAME_HOST) return null;
  const id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (!id || !ID_RE.test(id)) return null;
  return { id: id.toLowerCase(), theme: url.searchParams.get('theme') === 'dark' ? 'dark' : 'light' };
}

/** The Host's frame CSP without frame-ancestors (the embedding page is the app, not the Host). */
export function embeddableCsp(value) {
  return String(value ?? '').split(';').map(part => part.trim()).filter(part => part && !/^frame-ancestors\b/i.test(part)).join('; ');
}

const notFound = text => new Response(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui,sans-serif;padding:32px;color:#666">${text}</body>`,
  { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'cache-control': 'no-store' } });

export function createCanvasBridge({ getConfig, request, openExternal, fetchImpl = (...args) => fetch(...args) }) {
  const id = value => {
    if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error('画布不存在');
    return value.toLowerCase();
  };
  return {
    /** protocol.handle(`sand-canvas`) */
    async frame(url) {
      const target = parseCanvasFrameUrl(url), config = getConfig();
      if (!target || !config?.server || !config?.token) return notFound('画布不存在或未连接 Host。');
      let response;
      try {
        response = await fetchImpl(`${config.server}/canvas/app/${target.id}/frame?theme=${target.theme}`, {
          headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(20000),
        });
      } catch { return notFound('无法连接 Host，请稍后重试。'); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return notFound('画布不存在或已被删除。'); }
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
      const csp = embeddableCsp(response.headers.get('content-security-policy'));
      // The Host always sends the sandbox CSP; a frame without it is refused rather than shown unsandboxed.
      if (!/^sandbox\b/i.test(csp)) { void response.body?.cancel().catch(() => {}); return notFound('画布内容无效。'); }
      headers['content-security-policy'] = csp;
      return new Response(await response.arrayBuffer(), { status: 200, headers });
    },
    async handle({ action, ...args } = {}) {
      switch (action) {
        case 'list': {
          if (typeof args.agentId !== 'string' || !/^[a-f0-9-]{1,128}$/i.test(args.agentId)) throw new Error('Bot ID 无效');
          return await request(`/local/canvases?agentId=${encodeURIComponent(args.agentId)}`, null, AbortSignal.timeout(15000), 'GET');
        }
        case 'get': return await request(`/local/canvases/${id(args.id)}`, null, AbortSignal.timeout(15000), 'GET');
        case 'visibility': {
          if (!['private', 'public'].includes(args.visibility)) throw new Error('可见性无效');
          return await request(`/local/canvases/${id(args.id)}/visibility`, { visibility: args.visibility }, AbortSignal.timeout(15000), 'POST');
        }
        case 'link': return await request(`/local/canvases/${id(args.id)}/link`, {}, AbortSignal.timeout(15000), 'POST');
        case 'delete': return await request(`/local/canvases/${id(args.id)}`, null, AbortSignal.timeout(15000), 'DELETE');
        case 'open-external': {
          // Only the public link of a canvas leaves the app (share popover "在浏览器中打开").
          const url = new URL(String(args.url ?? ''));
          if (!['http:', 'https:'].includes(url.protocol) || !/^\/canvas\/[A-Za-z0-9_-]{43}\/?$/.test(url.pathname)) throw new Error('链接地址无效。');
          await openExternal(url.href);
          return null;
        }
        default: throw new Error('Unknown canvas action');
      }
    },
  };
}

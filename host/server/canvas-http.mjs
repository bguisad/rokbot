// HTTP access to local canvases.
//
//   GET /canvas/<token>         RokBot page: title bar + the canvas in a sandboxed iframe.
//   GET /canvas/<token>/frame   The canvas itself. Served with `Content-Security-Policy: sandbox
//                               allow-scripts ...`, so even when opened directly it runs in an
//                               opaque origin: no cookies, no storage of this origin, no
//                               fetch/XHR/WebSocket (connect-src 'none'), no forms, no popups.
//
// The 256-bit token in the path is the read grant (links are shared like the official
// cursor.com/canvas links); everything else under /canvas/ is 404. The canvas code never runs on
// the Host's own origin, so it cannot reach /admin/api, /local or the web client's cookies.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CANVAS_TOKEN_RE } from "./canvas-store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_RE = /^\/canvas\/([A-Za-z0-9_-]{43})(\/frame)?\/?$/;

export const CANVAS_FRAME_SANDBOX = "allow-scripts allow-modals allow-downloads";

export function canvasFrameCsp(nonce) {
  return [
    `sandbox ${CANVAS_FRAME_SANDBOX}`,
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export function canvasPageCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "frame-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors *",
  ].join("; ");
}

let tokensCss;
function themeTokens() {
  tokensCss ??= readFileSync(join(here, "public", "tokens.css"), "utf8");
  return tokensCss;
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// A bundle is inlined into a <script>; `</script` and `<!--` inside string literals must not end it.
const inlineScript = (code) => String(code).replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

// Follows the system theme, or `?theme=dark|light` when a client passes its own.
const THEME_SCRIPT = `(function(){var q=/[?&]theme=(dark|light)\\b/.exec(location.search);var d=q?q[1]==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=d?'dark':'light';if(!q)matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(e){document.documentElement.dataset.theme=e.matches?'dark':'light'})})();`;

const BASE_CSS = `
html,body{margin:0;padding:0;background:var(--sand-bg-pane);color:var(--sand-text-primary);font:var(--text-body1);-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
`;

export function renderCanvasPage(meta, { nonce, theme } = {}) {
  const title = escapeHtml(meta.title || "未命名画布");
  const frameSrc = `/canvas/${meta.token}/frame${theme ? `?theme=${theme}` : ""}`;
  const updated = new Date(meta.updatedAtMs).toISOString();
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} - RokBot 画布</title>
<style>${themeTokens()}${BASE_CSS}
html,body{height:100%}
body{display:flex;flex-direction:column;background:var(--sand-bg-chrome)}
.rk-bar{display:flex;align-items:center;gap:12px;height:48px;padding:0 16px;border-bottom:var(--hairline) solid var(--sand-border-secondary-translucent);background:var(--sand-bg-chrome);flex:none}
.rk-mark{width:22px;height:22px;border-radius:var(--radius-sm);background:var(--sand-bg-primary);color:var(--sand-text-inverted);display:grid;place-items:center;font:600 12px/1 var(--font-sans);flex:none}
.rk-title{font:var(--text-body1);font-weight:var(--weight-semibold);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rk-meta{font:var(--text-label);color:var(--sand-text-tertiary);white-space:nowrap}
.rk-spacer{flex:1}
.rk-btn{appearance:none;border:var(--hairline) solid var(--sand-border-secondary-translucent);background:var(--sand-bg-secondary);color:var(--sand-text-primary);font:var(--text-label);font-weight:var(--weight-medium);height:28px;padding:0 12px;border-radius:var(--radius-md);cursor:pointer}
.rk-btn:hover{background:var(--sand-bg-secondary-hover)}
.rk-btn:focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:1px}
iframe{flex:1;width:100%;border:0;background:var(--sand-bg-pane)}
@media (max-width:520px){.rk-meta{display:none}}
</style>
<script nonce="${nonce}">${THEME_SCRIPT}</script>
</head><body>
<header class="rk-bar"><div class="rk-mark" aria-hidden="true">R</div><div class="rk-title" title="${title}">${title}</div><span class="rk-meta">RokBot 画布 · 第 ${Number(meta.version) || 1} 版 · <time datetime="${updated}" data-updated="${updated}"></time></span><span class="rk-spacer"></span><button class="rk-btn" type="button" id="rk-reload">刷新</button></header>
<iframe id="rk-canvas" title="${title}" src="${escapeHtml(frameSrc)}" sandbox="${CANVAS_FRAME_SANDBOX}" referrerpolicy="no-referrer" loading="eager"></iframe>
<script nonce="${nonce}">(function(){var t=document.querySelector('time[data-updated]');if(t){var d=new Date(t.dataset.updated);t.textContent='更新于 '+d.toLocaleString('zh-CN',{hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}document.getElementById('rk-reload').addEventListener('click',function(){location.reload()})})();</script>
</body></html>`;
}

export function renderCanvasFrame(meta, bundle, { nonce }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(meta.title || "未命名画布")}</title>
<style>${themeTokens()}${BASE_CSS}
body{min-height:100vh}
#rk-canvas-error{margin:24px;padding:16px;border-radius:var(--radius-lg);background:var(--sand-bg-danger-secondary);color:var(--sand-text-danger-primary);font:var(--text-body2);white-space:pre-wrap}
</style>
<script nonce="${nonce}">${THEME_SCRIPT}</script>
</head><body><div id="root"></div>
<script nonce="${nonce}">${inlineScript(bundle)}</script>
</body></html>`;
}

function send(response, status, headers, body, method) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  response.end(method === "HEAD" ? undefined : body);
}

const NOT_FOUND = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>画布不存在</title></head><body style="font:14px/20px system-ui,sans-serif;padding:32px">画布不存在或链接已失效。</body></html>`;

/**
 * Route handler. Returns true when the request was a canvas request (handled), false otherwise.
 * `store` is a CanvasStore.
 */
export async function routeCanvas(request, response, path, url, { store }) {
  if (path !== "/canvas" && !path.startsWith("/canvas/")) return false;
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=(), clipboard-read=()",
    "x-robots-tag": "noindex, nofollow",
  };
  const method = request.method;
  const match = PAGE_RE.exec(path);
  if (!["GET", "HEAD"].includes(method) || !match || !CANVAS_TOKEN_RE.test(match[1])) {
    send(response, 404, { ...headers, "content-security-policy": "default-src 'none'" }, NOT_FOUND, method);
    return true;
  }
  const meta = await store.byToken(match[1]);
  if (!meta) {
    send(response, 404, { ...headers, "content-security-policy": "default-src 'none'" }, NOT_FOUND, method);
    return true;
  }
  const nonce = randomBytes(18).toString("base64");
  const theme = ["dark", "light"].includes(url.searchParams.get("theme")) ? url.searchParams.get("theme") : undefined;
  if (match[2]) {
    let bundle;
    try { bundle = await store.readBundle(meta.id); } catch { bundle = "document.getElementById('root').textContent='画布内容缺失。'"; }
    // The frame may only be embedded by its own page on this origin.
    send(response, 200, { ...headers, "x-frame-options": "SAMEORIGIN", "content-security-policy": canvasFrameCsp(nonce) },
      renderCanvasFrame(meta, bundle, { nonce }), method);
    return true;
  }
  // The page holds no secrets and runs no canvas code, so clients may embed it.
  response.removeHeader("x-frame-options");
  send(response, 200, { ...headers, "content-security-policy": canvasPageCsp(nonce) }, renderCanvasPage(meta, { nonce, theme }), method);
  return true;
}

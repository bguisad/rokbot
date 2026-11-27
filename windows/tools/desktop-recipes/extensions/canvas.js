// RokBot canvases in the desktop and web renderer (appended to the original 1.3.0 app module;
// X, Z, BS and eN are its React, JSX runtime, ReactDOM and Bot-details section component).
//
// Modeled on the official Pages UI of 1.3.0, which only serves cloud canvases:
// - a canvas link in chat (`<host>/canvas/app/<id>`, what WriteCanvas hands the model) renders as a
//   card: live thumbnail on top, a footer with the page glyph, the title and "画布 · 私有/公开";
// - clicking it opens the canvas inside the app in a full-window stage (official `GX`, a dialog
//   with back-to-chat, title, share) to which RokBot adds refresh and close;
// - the share popover ("分享“标题”" / "谁可以访问") switches between "仅你可见" and "知道链接的任何人"
//   (official CanvasVisibility PRIVATE / PUBLIC) with a switch, then shows the public link to copy
//   or open in the browser, and can replace it so the old link stops working;
// - Bot details get a "画布" section like the official Library "页面" rows: title, update time
//   (Beijing time), a public mark, and a menu with open, share and delete (confirmed).
// Content loads with the device's own credential (window.localBot.canvas*): the desktop main
// process proxies `sand-canvas://rokbot/<id>`, the web client uses its session cookie.
const ROK_CANVAS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROK_CANVAS_APP_PATH = /^\/canvas\/app\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The canvas id of a RokBot in-app canvas link (any Host address), or null. */
function rokCanvasLinkId(href) {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2048) return null;
  let url;
  try { url = new URL(href, globalThis.location?.href ?? 'http://localhost/'); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const match = ROK_CANVAS_APP_PATH.exec(url.pathname);
  return match ? match[1].toLowerCase() : null;
}

const rokCanvasText = (zh, en) => (typeof grokText === 'function' ? grokText(zh, en) : zh);

function rokCanvasApi() {
  const bot = globalThis.window?.localBot;
  if (!bot || typeof bot.canvasGet !== 'function') throw new Error(rokCanvasText('当前客户端不支持画布。', 'This client does not support canvases.'));
  return bot;
}

function rokCanvasTheme() {
  const root = globalThis.document?.documentElement;
  const theme = root?.dataset?.theme ?? '';
  if (/dark/.test(theme) || root?.classList?.contains('cursor-dark') || globalThis.document?.body?.classList?.contains('cursor-dark')) return 'dark';
  if (/light/.test(theme)) return 'light';
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function rokCanvasFrameUrl(id, version) {
  const bot = globalThis.window?.localBot;
  const base = typeof bot?.canvasFrameUrl === 'function'
    ? bot.canvasFrameUrl({ id, theme: rokCanvasTheme() })
    : `/canvas/app/${id}/frame?theme=${rokCanvasTheme()}`;
  return version ? `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}` : base;
}

// Beijing time, as RokBot shows times of the Host.
function rokCanvasParts(ms) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type)?.value ?? '';
  return { y: get('year'), M: get('month'), d: get('day'), H: get('hour'), m: get('minute') };
}
function rokCanvasTime(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const at = rokCanvasParts(ms), today = rokCanvasParts(now);
  const time = `${at.H}:${at.m}`;
  if (at.y === today.y && at.M === today.M && at.d === today.d) return rokCanvasText(`今天 ${time}`, `Today ${time}`);
  if (at.y === today.y) return rokCanvasText(`${at.M}月${at.d}日 ${time}`, `${at.M}/${at.d} ${time}`);
  return rokCanvasText(`${at.y}年${at.M}月${at.d}日`, `${at.y}/${at.M}/${at.d}`);
}
function rokCanvasFullTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const at = rokCanvasParts(ms);
  return rokCanvasText(`${at.y}年${at.M}月${at.d}日 ${at.H}:${at.m}（北京时间）`, `${at.y}-${at.M}-${at.d} ${at.H}:${at.m} (Beijing time)`);
}

// --- Data: one cache entry per canvas, one list per Bot ------------------------------------------

function rokCanvasStore() {
  if (globalThis.__rokCanvasStore) return globalThis.__rokCanvasStore;
  const items = new Map(), lists = new Map(), listeners = new Set();
  let version = 0;
  const emit = () => { version += 1; for (const listener of [...listeners]) listener(); };
  const store = {
    version: () => version,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    item: id => items.get(id) ?? null,
    list: agentId => lists.get(agentId) ?? null,
    put(canvas) {
      if (!canvas?.id) return;
      items.set(canvas.id, { status: 'ready', canvas });
      for (const [agentId, entry] of lists) {
        if (entry.status !== 'ready') continue;
        const known = entry.canvases.some(item => item.id === canvas.id);
        if (known) lists.set(agentId, { ...entry, canvases: entry.canvases.map(item => item.id === canvas.id ? canvas : item) });
      }
      emit();
    },
    removed(id) {
      const previous = items.get(id)?.canvas ?? null;
      items.set(id, { status: 'missing', canvas: previous });
      for (const [agentId, entry] of lists) {
        if (entry.status === 'ready') lists.set(agentId, { ...entry, canvases: entry.canvases.filter(item => item.id !== id) });
      }
      emit();
    },
    async load(id, { force = false } = {}) {
      const current = items.get(id);
      if (!force && current && (current.status === 'ready' || current.status === 'loading' || current.status === 'missing')) return current;
      if (!current || current.status !== 'ready') { items.set(id, { status: 'loading', canvas: current?.canvas ?? null }); emit(); }
      try {
        const { canvas } = await rokCanvasApi().canvasGet({ id });
        store.put(canvas);
      } catch (error) {
        const missing = error?.httpStatus === 404 || /404|不存在/.test(String(error?.message ?? ''));
        items.set(id, { status: missing ? 'missing' : 'failed', canvas: items.get(id)?.canvas ?? null, error: String(error?.message ?? error) });
        emit();
      }
      return items.get(id);
    },
    async loadList(agentId) {
      const current = lists.get(agentId);
      if (!current || current.status !== 'ready') { lists.set(agentId, { status: 'loading', canvases: current?.canvases ?? [] }); emit(); }
      try {
        const { canvases } = await rokCanvasApi().canvasList({ agentId });
        for (const canvas of canvases) items.set(canvas.id, { status: 'ready', canvas });
        lists.set(agentId, { status: 'ready', canvases, loadedAt: Date.now() });
      } catch (error) {
        lists.set(agentId, { status: 'failed', canvases: lists.get(agentId)?.canvases ?? [], error: String(error?.message ?? error) });
      }
      emit();
    },
    async setVisibility(id, visibility) {
      const { canvas } = await rokCanvasApi().canvasSetVisibility({ id, visibility });
      store.put(canvas);
      return canvas;
    },
    async regenerateLink(id) {
      const { canvas } = await rokCanvasApi().canvasRegenerateLink({ id });
      store.put(canvas);
      return canvas;
    },
    async remove(id) {
      await rokCanvasApi().canvasDelete({ id });
      store.removed(id);
    },
  };
  globalThis.__rokCanvasStore = store;
  return store;
}

function rokUseCanvasStore() {
  const store = rokCanvasStore();
  X.useSyncExternalStore(store.subscribe, store.version, store.version);
  return store;
}

// The stage (open canvas) is one per window.
function rokCanvasStage() {
  if (globalThis.__rokCanvasStage) return globalThis.__rokCanvasStage;
  const listeners = new Set();
  let state = null;
  const stage = {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    open(id, { title, returnFocusTo } = {}) {
      if (!ROK_CANVAS_ID.test(String(id))) return false;
      state = { id: String(id).toLowerCase(), title: title || null, returnFocusTo: returnFocusTo ?? globalThis.document?.activeElement ?? null, openedAt: Date.now() };
      for (const listener of [...listeners]) listener();
      return true;
    },
    close() {
      const focus = state?.returnFocusTo;
      state = null;
      for (const listener of [...listeners]) listener();
      try { focus?.focus?.(); } catch {}
    },
  };
  globalThis.__rokCanvasStage = stage;
  return stage;
}

// Any canvas link the renderer draws (link cards, previews, plain anchors) opens in the app.
(function rokInstallCanvasLinkHandler() {
  const doc = globalThis.document;
  if (!doc || globalThis.__rokCanvasLinksInstalled) return;
  globalThis.__rokCanvasLinksInstalled = true;
  const handle = event => {
    if (event.defaultPrevented && event.type === 'click') return;
    if (event.type === 'auxclick' && event.button !== 1) return;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || anchor.closest('[data-rok-canvas-allow-external]')) return;
    const id = rokCanvasLinkId(anchor.getAttribute('href'));
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    rokCanvasStage().open(id, { title: anchor.textContent?.trim() || null, returnFocusTo: anchor });
  };
  doc.addEventListener('click', handle, true);
  doc.addEventListener('auxclick', handle, true);
  // The web client's link opener asks here before it opens a canvas link in a new tab.
  globalThis.addEventListener?.('rokbot-local:open-canvas', event => {
    const id = rokCanvasLinkId(event.detail?.url) ?? (ROK_CANVAS_ID.test(String(event.detail?.id ?? '')) ? event.detail.id : null);
    if (id && rokCanvasStage().open(id, { title: event.detail?.title ?? null })) event.preventDefault();
  });
  globalThis.__rokOpenCanvas = (id, title) => rokCanvasStage().open(id, { title });
  // The desktop main process hands over canvas links that reached its browser opener.
  try { globalThis.window?.localBot?.onOpenCanvas?.(id => rokCanvasStage().open(id)); } catch {}
})();

// --- Look ----------------------------------------------------------------------------------------

const ROK_CANVAS_CSS = `
.rok-cv-card,.rok-cv-stage,.rok-cv-pop,.rok-cv-menu,.rok-cv-dialog,.rok-cv-section{--rok-cv-ink:var(--sand-text-primary,#1c1c1c);--rok-cv-ink2:var(--sand-text-secondary,#1c1c1cad);--rok-cv-ink3:var(--sand-text-tertiary,#1c1c1c8f);--rok-cv-line:var(--sand-border-secondary-translucent,#1c1c1c1f);--rok-cv-line2:var(--sand-border-tertiary-translucent,#1c1c1c14);--rok-cv-surface:var(--sand-bg-elevated,#fff);--rok-cv-pane:var(--sand-bg-pane,#fff);--rok-cv-chip:var(--sand-bg-secondary,#1c1c1c0f);--rok-cv-chip-hover:var(--sand-bg-secondary-hover,#1c1c1c1a);--rok-cv-hover:var(--sand-bg-hover,#1c1c1c0f);--rok-cv-primary:var(--sand-bg-primary,#1c1c1c);--rok-cv-on-primary:var(--sand-text-inverted,#fcfcfc);--rok-cv-danger:var(--sand-bg-danger-primary,#e72e3b);--rok-cv-danger-ink:var(--sand-text-danger-primary,#d1242f);--rok-cv-focus:var(--sand-border-focus-primary,#1e86fc);--rok-cv-shadow:0 12px 32px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.06);--rok-cv-ok:#1a8f5b;font-family:inherit;color:var(--rok-cv-ink)}
:root[data-theme="cursor-dark"] .rok-cv-card,:root[data-theme="cursor-dark"] .rok-cv-stage,:root[data-theme="cursor-dark"] .rok-cv-pop,:root[data-theme="cursor-dark"] .rok-cv-menu,:root[data-theme="cursor-dark"] .rok-cv-dialog,:root[data-theme="cursor-dark"] .rok-cv-section,.cursor-dark .rok-cv-card,.cursor-dark .rok-cv-stage,.cursor-dark .rok-cv-pop,.cursor-dark .rok-cv-menu,.cursor-dark .rok-cv-dialog,.cursor-dark .rok-cv-section{--rok-cv-shadow:0 12px 32px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3);--rok-cv-ok:#3dd68c}
.rok-cv-card *,.rok-cv-stage *,.rok-cv-pop *,.rok-cv-menu *,.rok-cv-dialog *,.rok-cv-section *{box-sizing:border-box}
.rok-cv-icon{flex:none;display:block}
.rok-cv-card{display:block;width:min(100%,440px);margin:6px 0;border:1px solid var(--rok-cv-line);border-radius:14px;background:var(--rok-cv-surface);overflow:hidden;cursor:pointer;text-align:left;outline:none;transition:border-color 120ms ease,box-shadow 120ms ease,transform 120ms ease;user-select:none;-webkit-user-select:none}
.rok-cv-card:hover{border-color:var(--sand-border-primary-translucent,#1c1c1c3d);box-shadow:0 4px 14px rgba(0,0,0,.06)}
.rok-cv-card:active{transform:scale(.995)}
.rok-cv-card:focus-visible{box-shadow:0 0 0 2px var(--rok-cv-focus)}
.rok-cv-card__thumb{display:block;position:relative;height:168px;overflow:hidden;background:var(--rok-cv-pane);border-bottom:1px solid var(--rok-cv-line2)}
.rok-cv-card__thumb iframe{position:absolute;left:0;top:0;width:200%;height:200%;border:0;transform:scale(.5);transform-origin:0 0;pointer-events:none;background:var(--rok-cv-pane)}
.rok-cv-card__shade{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 60%,color-mix(in srgb,var(--rok-cv-pane) 70%,transparent))}
.rok-cv-card__foot{display:flex;align-items:center;gap:10px;padding:10px 12px}
.rok-cv-glyph{flex:none;display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--rok-cv-chip);color:var(--rok-cv-ink2)}
.rok-cv-card__text{display:flex;flex-direction:column;min-width:0;flex:1}
.rok-cv-card__title{font-size:14px;line-height:20px;font-weight:500;color:var(--rok-cv-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rok-cv-card__sub{display:flex;align-items:center;gap:4px;font-size:12px;line-height:16px;color:var(--rok-cv-ink3);white-space:nowrap}
.rok-cv-card--deleted{cursor:default}
.rok-cv-card--deleted .rok-cv-card__title{text-decoration:line-through;color:var(--rok-cv-ink3)}
.rok-cv-skel{display:flex;flex-direction:column;gap:10px;padding:18px 18px 0}
.rok-cv-skel i{display:block;height:10px;border-radius:5px;background:var(--rok-cv-chip);animation:rok-cv-shimmer 1.4s ease-in-out infinite}
.rok-cv-skel i:nth-child(1){width:46%;height:14px}.rok-cv-skel i:nth-child(2){width:88%}.rok-cv-skel i:nth-child(3){width:72%}.rok-cv-skel i:nth-child(4){width:58%;height:28px;border-radius:8px}
@keyframes rok-cv-shimmer{0%,100%{opacity:.55}50%{opacity:1}}
.rok-cv-stage{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:var(--rok-cv-pane);animation:rok-cv-in 160ms cubic-bezier(.2,.8,.2,1)}
@keyframes rok-cv-in{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}
.rok-cv-stage__bar{flex:none;display:flex;align-items:center;gap:8px;height:52px;padding:0 12px;border-bottom:1px solid var(--rok-cv-line);background:var(--sand-bg-chrome,var(--rok-cv-pane));-webkit-app-region:no-drag}
.rok-cv-stage__title{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.rok-cv-stage__name{font-size:14px;line-height:20px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rok-cv-stage__meta{font-size:12px;color:var(--rok-cv-ink3);white-space:nowrap}
.rok-cv-stage__body{position:relative;flex:1;min-height:0;background:var(--rok-cv-pane)}
.rok-cv-stage__body iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--rok-cv-pane)}
.rok-cv-stage__empty{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:32px;color:var(--rok-cv-ink2);font-size:14px;line-height:22px}
.rok-cv-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--rok-cv-ink);font:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;transition:background-color 120ms ease,border-color 120ms ease,opacity 120ms ease}
.rok-cv-btn:hover:not(:disabled){background:var(--rok-cv-hover)}
.rok-cv-btn:focus-visible{outline:2px solid var(--rok-cv-focus);outline-offset:1px}
.rok-cv-btn:disabled{opacity:.5;cursor:default}
.rok-cv-btn--icon{width:32px;padding:0}
.rok-cv-btn--outline{border-color:var(--rok-cv-line);background:var(--rok-cv-surface)}
.rok-cv-btn--outline:hover:not(:disabled){background:var(--rok-cv-chip)}
.rok-cv-btn--primary{background:var(--rok-cv-primary);color:var(--rok-cv-on-primary)}
.rok-cv-btn--primary:hover:not(:disabled){background:var(--sand-bg-primary-hover,#363636)}
.rok-cv-btn--danger{background:var(--rok-cv-danger);color:#fff}
.rok-cv-btn--danger:hover:not(:disabled){background:var(--sand-bg-danger-primary-hover,#c82532)}
.rok-cv-btn--sm{height:28px;padding:0 10px;font-size:12px}
.rok-cv-pill{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;background:var(--rok-cv-chip);color:var(--rok-cv-ink2);font-size:12px;line-height:1;white-space:nowrap;flex:none}
.rok-cv-pill--public{color:var(--rok-cv-ok);background:color-mix(in srgb,var(--rok-cv-ok) 12%,transparent)}
.rok-cv-pop{position:fixed;z-index:2147483100;width:352px;max-width:calc(100vw - 24px);padding:16px;border-radius:16px;border:1px solid var(--rok-cv-line);background:var(--rok-cv-surface);box-shadow:var(--rok-cv-shadow);animation:rok-cv-pop 140ms cubic-bezier(.2,.8,.2,1)}
@keyframes rok-cv-pop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.rok-cv-pop__title{margin:0 0 12px;font-size:15px;line-height:22px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rok-cv-pop__label{margin:0 0 6px;font-size:12px;line-height:16px;font-weight:500;color:var(--rok-cv-ink3)}
.rok-cv-access{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;background:var(--rok-cv-chip)}
.rok-cv-access__icon{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:999px;background:var(--rok-cv-surface);color:var(--rok-cv-ink2)}
.rok-cv-access--public .rok-cv-access__icon{color:var(--rok-cv-ok)}
.rok-cv-access__text{display:flex;flex-direction:column;min-width:0;flex:1}
.rok-cv-access__name{font-size:13px;line-height:18px;font-weight:600}
.rok-cv-access__desc{font-size:12px;line-height:16px;color:var(--rok-cv-ink3)}
.rok-cv-switch{appearance:none;position:relative;flex:none;width:40px;height:24px;padding:0;border:0;border-radius:999px;background:var(--sand-border-primary-translucent,#1c1c1c3d);cursor:pointer;transition:background-color 160ms ease}
.rok-cv-switch::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform 160ms cubic-bezier(.2,.8,.2,1)}
.rok-cv-switch[aria-checked="true"]{background:var(--rok-cv-ok)}
.rok-cv-switch[aria-checked="true"]::after{transform:translateX(16px)}
.rok-cv-switch:focus-visible{outline:2px solid var(--rok-cv-focus);outline-offset:2px}
.rok-cv-switch:disabled{opacity:.55;cursor:default}
.rok-cv-note{margin:10px 2px 0;font-size:12px;line-height:18px;color:var(--rok-cv-ink3)}
.rok-cv-note--error{color:var(--rok-cv-danger-ink)}
.rok-cv-link{display:flex;align-items:center;gap:8px;margin-top:12px;padding:8px 10px;border:1px solid var(--rok-cv-line);border-radius:10px;background:var(--rok-cv-pane);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:16px;color:var(--rok-cv-ink2)}
.rok-cv-link span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:all;-webkit-user-select:all}
.rok-cv-pop__actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.rok-cv-confirm{margin-top:12px;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--rok-cv-danger) 8%,transparent);font-size:12px;line-height:18px;color:var(--rok-cv-ink2)}
.rok-cv-confirm div{display:flex;gap:8px;margin-top:8px}
.rok-cv-section__list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.rok-cv-row{position:relative;display:flex;align-items:center;gap:10px;min-height:52px;padding:6px 6px 6px 8px;border-radius:12px;cursor:pointer;outline:none;transition:background-color 120ms ease}
.rok-cv-row:hover,.rok-cv-row:focus-within{background:var(--rok-cv-hover)}
.rok-cv-row:focus-visible{box-shadow:inset 0 0 0 2px var(--rok-cv-focus)}
.rok-cv-row__text{display:flex;flex-direction:column;min-width:0;flex:1}
.rok-cv-row__title{font-size:13px;line-height:18px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rok-cv-row__meta{display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--rok-cv-ink3);white-space:nowrap;overflow:hidden}
.rok-cv-row__mark{display:inline-flex;align-items:center;gap:3px}
.rok-cv-row__mark--public{color:var(--rok-cv-ok)}
.rok-cv-row .rok-cv-btn--icon{width:28px;height:28px;opacity:.0}
.rok-cv-row:hover .rok-cv-btn--icon,.rok-cv-row:focus-within .rok-cv-btn--icon,.rok-cv-row .rok-cv-btn--icon[aria-expanded="true"]{opacity:1}
@media (hover:none){.rok-cv-row .rok-cv-btn--icon{opacity:1}}
.rok-cv-section__empty{margin:0;padding:4px 8px;font-size:13px;line-height:20px;color:var(--rok-cv-ink3)}
.rok-cv-section__more{align-self:flex-start;margin:2px 0 0 4px}
.rok-cv-menu{position:fixed;z-index:2147483100;min-width:168px;padding:4px;border-radius:12px;border:1px solid var(--rok-cv-line);background:var(--rok-cv-surface);box-shadow:var(--rok-cv-shadow);animation:rok-cv-pop 120ms ease}
.rok-cv-menu button{appearance:none;display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--rok-cv-ink);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.rok-cv-menu button:hover,.rok-cv-menu button:focus-visible{background:var(--rok-cv-hover);outline:none}
.rok-cv-menu button[data-danger]{color:var(--rok-cv-danger-ink)}
.rok-cv-menu hr{margin:4px 6px;border:0;border-top:1px solid var(--rok-cv-line2)}
.rok-cv-scrim{position:fixed;inset:0;z-index:2147483200;display:grid;place-items:center;padding:24px;background:var(--sand-bg-scrim,#00000080);animation:rok-cv-fade 140ms ease}
@keyframes rok-cv-fade{from{opacity:0}to{opacity:1}}
.rok-cv-dialog{width:400px;max-width:100%;padding:20px;border-radius:18px;background:var(--rok-cv-surface);box-shadow:var(--rok-cv-shadow)}
.rok-cv-dialog h2{margin:0 0 8px;font-size:16px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
.rok-cv-dialog p{margin:0;font-size:13px;line-height:20px;color:var(--rok-cv-ink2)}
.rok-cv-dialog__actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
@media (max-width:560px){.rok-cv-stage__meta{display:none}.rok-cv-stage__bar .rok-cv-btn__label{display:none}.rok-cv-stage__bar .rok-cv-btn--outline{width:32px;padding:0}}
@media (prefers-reduced-motion:reduce){.rok-cv-stage,.rok-cv-pop,.rok-cv-menu,.rok-cv-scrim,.rok-cv-skel i{animation:none}.rok-cv-switch,.rok-cv-switch::after{transition:none}}
`;

function rokCanvasInstallCss() {
  const doc = globalThis.document;
  if (!doc || doc.getElementById('rok-canvas-css')) return;
  const style = doc.createElement('style');
  style.id = 'rok-canvas-css';
  style.textContent = ROK_CANVAS_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const ROK_CANVAS_ICONS = {
  page: 'M4.5 2.5h5l3 3v8a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z M9.5 2.5v3h3 M5.75 8.5h4.5 M5.75 11h3',
  lock: 'M4.5 7.5h7a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1Z M5.75 7.5V5.25a2.25 2.25 0 0 1 4.5 0V7.5',
  globe: 'M8 14.25a6.25 6.25 0 1 0 0-12.5 6.25 6.25 0 0 0 0 12.5Z M1.75 8h12.5 M8 1.75c1.7 1.7 2.5 3.8 2.5 6.25S9.7 12.55 8 14.25C6.3 12.55 5.5 10.45 5.5 8S6.3 3.45 8 1.75Z',
  refresh: 'M13.25 8a5.25 5.25 0 1 1-1.54-3.71 M13.25 2.75v3h-3',
  share: 'M8 10V2.25 M5.25 5 8 2.25 10.75 5 M3.75 8.5v4.25a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1V8.5',
  close: 'M4 4l8 8 M12 4l-8 8',
  back: 'M10 3.5 5.5 8l4.5 4.5',
  more: 'M3.5 8h.01 M8 8h.01 M12.5 8h.01',
  trash: 'M3 4.5h10 M6.25 4.5V3.25a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75V4.5 M4.5 4.5l.6 8.4a1 1 0 0 0 1 .93h3.8a1 1 0 0 0 1-.93l.6-8.4',
  copy: 'M5.5 5.5V3.75a1 1 0 0 1 1-1h5.75a1 1 0 0 1 1 1V9.5a1 1 0 0 1-1 1H10.5 M3.75 5.5h5.75a1 1 0 0 1 1 1v5.75a1 1 0 0 1-1 1H3.75a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z',
  external: 'M9.5 2.75h3.75V6.5 M13.25 2.75 7.5 8.5 M11.5 9.5v2.75a1 1 0 0 1-1 1h-6.75a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1H6.5',
  open: 'M9.75 2.75h3.5v3.5 M13.25 2.75 9 7 M6.25 13.25h-3.5v-3.5 M2.75 13.25 7 9',
  check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  rotate: 'M2.75 8a5.25 5.25 0 0 1 9.16-3.5 M13.25 2.75v3h-3 M13.25 8a5.25 5.25 0 0 1-9.16 3.5 M2.75 13.25v-3h3',
};

function RokCanvasIcon({ name, size = 16, strokeWidth = 1.4 }) {
  const dots = name === 'more';
  return Z.jsx('svg', {
    className: 'rok-cv-icon', width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
    children: Z.jsx('path', { d: ROK_CANVAS_ICONS[name] ?? ROK_CANVAS_ICONS.page, stroke: 'currentColor', strokeWidth: dots ? 2.4 : strokeWidth,
      strokeLinecap: 'round', strokeLinejoin: 'round' }),
  });
}

function rokCanvasVisibilityLabel(visibility) {
  return visibility === 'public' ? rokCanvasText('公开', 'Public') : rokCanvasText('私有', 'Private');
}

function rokCanvasPortal(node) {
  const container = globalThis.document?.body ?? null;
  return container && typeof BS?.createPortal === 'function' ? BS.createPortal(node, container) : node;
}

// --- Chat card -----------------------------------------------------------------------------------

function RokCanvasLinkCard(props) {
  rokCanvasInstallCss();
  const id = rokCanvasLinkId(props.href);
  const store = rokUseCanvasStore();
  X.useEffect(() => { if (id) void store.load(id); }, [id]);
  const entry = id ? store.item(id) : null;
  const canvas = entry?.canvas ?? null;
  const label = typeof props.children === 'string' ? props.children : Array.isArray(props.children) ? props.children.filter(c => typeof c === 'string').join('') : '';
  const title = canvas?.title || label || rokCanvasText('画布', 'Canvas');
  const deleted = entry?.status === 'missing';
  const loading = !entry || entry.status === 'loading';
  const open = event => {
    event.preventDefault();
    event.stopPropagation();
    if (!deleted) rokCanvasStage().open(id, { title, returnFocusTo: event.currentTarget });
  };
  const sub = deleted
    ? rokCanvasText('画布已删除', 'Canvas deleted')
    : canvas ? `${rokCanvasText('画布', 'Canvas')} · ${rokCanvasVisibilityLabel(canvas.visibility)}` : rokCanvasText('画布', 'Canvas');
  return Z.jsxs('span', {
    className: `rok-cv-card${deleted ? ' rok-cv-card--deleted' : ''}`,
    role: deleted ? undefined : 'button',
    tabIndex: deleted ? undefined : 0,
    'data-rok-canvas-card': id,
    'aria-label': deleted ? `${title}，${sub}` : rokCanvasText(`打开画布：${title}`, `Open canvas: ${title}`),
    onClick: open,
    onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') open(event); },
    children: [
      Z.jsx('span', { className: 'rok-cv-card__thumb', 'aria-hidden': 'true', children:
        canvas && !deleted
          ? Z.jsxs(Z.Fragment, { children: [
            Z.jsx('iframe', { src: rokCanvasFrameUrl(id, canvas.version), title: title, tabIndex: -1, loading: 'lazy', sandbox: 'allow-scripts', scrolling: 'no', referrerPolicy: 'no-referrer' }),
            Z.jsx('span', { className: 'rok-cv-card__shade' }),
          ] })
          : Z.jsxs('span', { className: 'rok-cv-skel', 'aria-label': loading ? rokCanvasText('正在加载画布…', 'Loading canvas…') : undefined,
            children: [Z.jsx('i', {}), Z.jsx('i', {}), Z.jsx('i', {}), Z.jsx('i', {})] }) }),
      Z.jsxs('span', { className: 'rok-cv-card__foot', children: [
        Z.jsx('span', { className: 'rok-cv-glyph', children: Z.jsx(RokCanvasIcon, { name: 'page' }) }),
        Z.jsxs('span', { className: 'rok-cv-card__text', children: [
          Z.jsx('span', { className: 'rok-cv-card__title', children: title }),
          Z.jsxs('span', { className: 'rok-cv-card__sub', children: [
            canvas && !deleted ? Z.jsx(RokCanvasIcon, { name: canvas.visibility === 'public' ? 'globe' : 'lock', size: 12 }) : null,
            sub,
          ] }),
        ] }),
      ] }),
    ],
  });
}

// --- Stage: the canvas inside the app ------------------------------------------------------------

function RokCanvasStageHost() {
  rokCanvasInstallCss();
  const stage = rokCanvasStage();
  const state = X.useSyncExternalStore(stage.subscribe, stage.get, stage.get);
  if (!state) return null;
  return rokCanvasPortal(Z.jsx(RokCanvasStage, { state }, `${state.id}:${state.openedAt}`));
}

function RokCanvasStage({ state }) {
  const store = rokUseCanvasStore();
  const [reload, setReload] = X.useState(0);
  const [sharing, setSharing] = X.useState(false);
  const shareButton = X.useRef(null);
  const backButton = X.useRef(null);
  X.useEffect(() => { void store.load(state.id, { force: true }); backButton.current?.focus(); }, [state.id]);
  const entry = store.item(state.id);
  const canvas = entry?.canvas ?? null;
  const title = canvas?.title || state.title || rokCanvasText('画布', 'Canvas');
  X.useEffect(() => {
    const onKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (globalThis.document?.querySelector('.rok-cv-scrim')) return;
      event.preventDefault();
      if (sharing) setSharing(false); else rokCanvasStage().close();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [sharing]);
  const refresh = () => { setReload(n => n + 1); void store.load(state.id, { force: true }); };
  const missing = entry?.status === 'missing';
  const failed = entry?.status === 'failed' && !canvas;
  return Z.jsxs('div', {
    className: 'rok-cv-stage', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'data-rok-canvas-stage': state.id,
    children: [
      Z.jsxs('header', { className: 'rok-cv-stage__bar', children: [
        Z.jsxs('button', { ref: backButton, type: 'button', className: 'rok-cv-btn', onClick: () => rokCanvasStage().close(),
          'aria-label': rokCanvasText('返回聊天', 'Back to chat'),
          children: [Z.jsx(RokCanvasIcon, { name: 'back' }), Z.jsx('span', { className: 'rok-cv-btn__label', children: rokCanvasText('返回聊天', 'Back to chat') })] }),
        Z.jsxs('div', { className: 'rok-cv-stage__title', children: [
          Z.jsx('span', { className: 'rok-cv-glyph', children: Z.jsx(RokCanvasIcon, { name: 'page' }) }),
          Z.jsx('span', { className: 'rok-cv-stage__name', title, children: title }),
          canvas ? Z.jsxs('span', { className: `rok-cv-pill${canvas.visibility === 'public' ? ' rok-cv-pill--public' : ''}`, children: [
            Z.jsx(RokCanvasIcon, { name: canvas.visibility === 'public' ? 'globe' : 'lock', size: 12 }), rokCanvasVisibilityLabel(canvas.visibility)] }) : null,
          canvas ? Z.jsx('span', { className: 'rok-cv-stage__meta', title: rokCanvasFullTime(canvas.updatedAtMs),
            children: rokCanvasText(`第 ${canvas.version} 版 · 更新于 ${rokCanvasTime(canvas.updatedAtMs)}`, `Version ${canvas.version} · Updated ${rokCanvasTime(canvas.updatedAtMs)}`) }) : null,
        ] }),
        Z.jsx('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--icon', onClick: refresh, disabled: missing,
          'aria-label': rokCanvasText('刷新', 'Refresh'), title: rokCanvasText('刷新', 'Refresh'), children: Z.jsx(RokCanvasIcon, { name: 'refresh' }) }),
        Z.jsxs('button', { ref: shareButton, type: 'button', className: 'rok-cv-btn rok-cv-btn--outline', disabled: !canvas || missing,
          'aria-haspopup': 'dialog', 'aria-expanded': sharing ? 'true' : 'false', onClick: () => setSharing(open => !open),
          'aria-label': rokCanvasText('分享', 'Share'),
          children: [Z.jsx(RokCanvasIcon, { name: 'share' }), Z.jsx('span', { className: 'rok-cv-btn__label', children: rokCanvasText('分享', 'Share') })] }),
        Z.jsx('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--icon', onClick: () => rokCanvasStage().close(),
          'aria-label': rokCanvasText('关闭', 'Close'), title: rokCanvasText('关闭', 'Close'), children: Z.jsx(RokCanvasIcon, { name: 'close' }) }),
      ] }),
      Z.jsx('div', { className: 'rok-cv-stage__body', children:
        missing ? Z.jsx('div', { className: 'rok-cv-stage__empty', children: rokCanvasText('这个画布已被删除，或者不在当前连接的 Host 上。', 'This canvas was deleted or is not on the connected Host.') })
        : failed ? Z.jsx('div', { className: 'rok-cv-stage__empty', children: Z.jsxs('div', { children: [
          Z.jsx('p', { style: { margin: '0 0 12px' }, children: rokCanvasText('无法打开画布。', 'Could not open the canvas.') }),
          Z.jsx('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--outline', onClick: refresh, children: rokCanvasText('重试', 'Retry') })] }) })
        : Z.jsx('iframe', { key: reload, src: rokCanvasFrameUrl(state.id, `${canvas?.version ?? 0}.${reload}`), title,
          sandbox: 'allow-scripts allow-modals allow-downloads', referrerPolicy: 'no-referrer', allow: '' }) }),
      sharing && canvas ? Z.jsx(RokCanvasSharePopover, { canvas, anchor: shareButton, onClose: () => setSharing(false) }) : null,
    ],
  });
}

// --- Share popover -------------------------------------------------------------------------------

function rokCanvasPlace(anchor, width, { align = 'end' } = {}) {
  const rect = anchor?.current?.getBoundingClientRect?.() ?? anchor?.getBoundingClientRect?.();
  const viewW = globalThis.innerWidth ?? 1024, viewH = globalThis.innerHeight ?? 768;
  if (!rect) return { top: 64, right: 12 };
  const top = Math.min(rect.bottom + 8, viewH - 80);
  let left = align === 'end' ? rect.right - width : rect.left;
  left = Math.max(12, Math.min(left, viewW - width - 12));
  return { top, left };
}

async function rokCanvasCopy(text) {
  try { await globalThis.navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const doc = globalThis.document, area = doc.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    doc.body.appendChild(area); area.select();
    const ok = doc.execCommand('copy');
    area.remove();
    return ok;
  } catch { return false; }
}

function rokCanvasOpenExternal(url) {
  const bot = globalThis.window?.localBot;
  if (typeof bot?.canvasOpenExternal === 'function') return void Promise.resolve(bot.canvasOpenExternal(url)).catch(() => {});
  const anchor = globalThis.document.createElement('a');
  anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
  const wrap = globalThis.document.createElement('span');
  wrap.setAttribute('data-rok-canvas-allow-external', '');
  wrap.appendChild(anchor); globalThis.document.body.appendChild(wrap);
  anchor.click(); wrap.remove();
}

function RokCanvasSharePopover({ canvas, anchor, onClose }) {
  const store = rokCanvasStore();
  const ref = X.useRef(null);
  const [pending, setPending] = X.useState(null);
  const [error, setError] = X.useState(null);
  const [copied, setCopied] = X.useState(null);
  const [confirmRegenerate, setConfirmRegenerate] = X.useState(false);
  const [place, setPlace] = X.useState(() => rokCanvasPlace(anchor, 352));
  X.useLayoutEffect(() => {
    const update = () => setPlace(rokCanvasPlace(anchor, 352));
    globalThis.addEventListener('resize', update);
    return () => globalThis.removeEventListener('resize', update);
  }, [anchor]);
  X.useEffect(() => {
    const onDown = event => {
      if (ref.current?.contains(event.target)) return;
      const button = anchor?.current ?? anchor;
      if (button?.contains?.(event.target)) return;
      onClose();
    };
    globalThis.document.addEventListener('pointerdown', onDown, true);
    return () => globalThis.document.removeEventListener('pointerdown', onDown, true);
  }, [anchor, onClose]);
  X.useEffect(() => { ref.current?.querySelector('[role="switch"]')?.focus(); }, []);
  const isPublic = canvas.visibility === 'public';
  const run = async (kind, task) => {
    setPending(kind); setError(null);
    try { await task(); } catch (failure) {
      setError(kind === 'link' ? rokCanvasText('无法重新生成链接，请稍后再试。', 'Could not regenerate the link. Try again later.')
        : rokCanvasText('无法更新访问权限，请稍后再试。', 'Couldn’t update access. Try again later.'));
      void failure;
    } finally { setPending(null); }
  };
  const toggle = () => run('visibility', () => store.setVisibility(canvas.id, isPublic ? 'private' : 'public'));
  const regenerate = () => run('link', async () => { await store.regenerateLink(canvas.id); setConfirmRegenerate(false); setCopied(null); });
  const copy = async () => {
    const ok = await rokCanvasCopy(canvas.publicUrl);
    setCopied(ok ? 'ok' : 'failed');
    setTimeout(() => setCopied(null), 1800);
  };
  return Z.jsxs('div', {
    ref, className: 'rok-cv-pop', role: 'dialog', 'aria-label': rokCanvasText('分享画布', 'Share canvas'), 'data-rok-canvas-share': canvas.id,
    style: place,
    onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); (anchor?.current ?? anchor)?.focus?.(); } },
    children: [
      Z.jsx('h2', { className: 'rok-cv-pop__title', title: canvas.title, children: rokCanvasText(`分享“${canvas.title}”`, `Share “${canvas.title}”`) }),
      Z.jsx('p', { className: 'rok-cv-pop__label', children: rokCanvasText('谁可以访问', 'Who can access') }),
      Z.jsxs('div', { className: `rok-cv-access${isPublic ? ' rok-cv-access--public' : ''}`, children: [
        Z.jsx('span', { className: 'rok-cv-access__icon', children: Z.jsx(RokCanvasIcon, { name: isPublic ? 'globe' : 'lock', size: 18 }) }),
        Z.jsxs('span', { className: 'rok-cv-access__text', children: [
          Z.jsx('span', { className: 'rok-cv-access__name', id: `rok-cv-access-${canvas.id}`, children: rokCanvasText('公开访问', 'Public access') }),
          Z.jsx('span', { className: 'rok-cv-access__desc', children: pending === 'visibility'
            ? rokCanvasText('正在更新…', 'Updating…')
            : isPublic ? rokCanvasText('知道链接的任何人 · 无需登录', 'Anyone with the link · No sign-in needed')
              : rokCanvasText('仅你可见 · 只能在已登录的 RokBot 中打开', 'Private to you · Opens only in signed-in RokBot apps') }),
        ] }),
        Z.jsx('button', { type: 'button', role: 'switch', className: 'rok-cv-switch', 'aria-checked': isPublic ? 'true' : 'false',
          'aria-labelledby': `rok-cv-access-${canvas.id}`, disabled: pending !== null, onClick: toggle }),
      ] }),
      isPublic && canvas.publicUrl ? Z.jsxs(Z.Fragment, { children: [
        Z.jsxs('div', { className: 'rok-cv-link', title: canvas.publicUrl, children: [Z.jsx(RokCanvasIcon, { name: 'globe', size: 14 }), Z.jsx('span', { children: canvas.publicUrl })] }),
        Z.jsxs('div', { className: 'rok-cv-pop__actions', children: [
          Z.jsxs('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--primary rok-cv-btn--sm', onClick: copy, disabled: pending !== null,
            children: [Z.jsx(RokCanvasIcon, { name: copied === 'ok' ? 'check' : 'copy', size: 14 }),
              copied === 'ok' ? rokCanvasText('已复制', 'Copied') : copied === 'failed' ? rokCanvasText('复制失败', 'Failed to copy link') : rokCanvasText('复制链接', 'Copy link')] }),
          Z.jsxs('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--outline rok-cv-btn--sm', onClick: () => rokCanvasOpenExternal(canvas.publicUrl), disabled: pending !== null,
            children: [Z.jsx(RokCanvasIcon, { name: 'external', size: 14 }), rokCanvasText('在浏览器中打开', 'Open in browser')] }),
          Z.jsxs('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--outline rok-cv-btn--sm', onClick: () => setConfirmRegenerate(true), disabled: pending !== null || confirmRegenerate,
            children: [Z.jsx(RokCanvasIcon, { name: 'rotate', size: 14 }), rokCanvasText('重新生成链接', 'Regenerate link')] }),
        ] }),
        confirmRegenerate ? Z.jsxs('div', { className: 'rok-cv-confirm', role: 'alert', children: [
          rokCanvasText('生成新链接后，旧链接会立即失效，已经发出去的旧链接将无法再打开。', 'The old link stops working right away; anyone holding it can no longer open the canvas.'),
          Z.jsxs('div', { children: [
            Z.jsx('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--danger rok-cv-btn--sm', onClick: regenerate, disabled: pending !== null,
              children: pending === 'link' ? rokCanvasText('正在生成…', 'Regenerating…') : rokCanvasText('生成新链接', 'Regenerate') }),
            Z.jsx('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--outline rok-cv-btn--sm', onClick: () => setConfirmRegenerate(false), disabled: pending !== null,
              children: rokCanvasText('取消', 'Cancel') }),
          ] }),
        ] }) : null,
      ] }) : Z.jsx('p', { className: 'rok-cv-note', children: rokCanvasText('开启后会生成一个公开链接，拿到链接的人无需登录即可查看。关闭后该链接立即失效。',
        'Turning this on creates a public link anyone can open without signing in. Turning it off disables the link right away.') }),
      error ? Z.jsx('p', { className: 'rok-cv-note rok-cv-note--error', role: 'alert', children: error }) : null,
    ],
  });
}

// --- Bot details: the Bot's canvases -------------------------------------------------------------

const ROK_CANVAS_SECTION_PAGE = 5;

function RokBotCanvasSection({ agentId, headingId }) {
  rokCanvasInstallCss();
  const store = rokUseCanvasStore();
  const [expanded, setExpanded] = X.useState(false);
  const [menu, setMenu] = X.useState(null);
  const [sharing, setSharing] = X.useState(null);
  const [deleting, setDeleting] = X.useState(null);
  X.useEffect(() => {
    if (!agentId) return undefined;
    void store.loadList(agentId);
    const again = () => { if (globalThis.document?.visibilityState !== 'hidden') void store.loadList(agentId); };
    const timer = setInterval(again, 30000);
    globalThis.addEventListener('focus', again);
    globalThis.addEventListener('rokbot-local:canvases-changed', again);
    return () => { clearInterval(timer); globalThis.removeEventListener('focus', again); globalThis.removeEventListener('rokbot-local:canvases-changed', again); };
  }, [agentId]);
  if (!agentId || typeof globalThis.window?.localBot?.canvasList !== 'function') return null;
  const list = store.list(agentId);
  const canvases = list?.canvases ?? [];
  const shown = expanded ? canvases : canvases.slice(0, ROK_CANVAS_SECTION_PAGE);
  const Section = typeof eN === 'function' ? eN : ({ heading, headingId: id, children }) => Z.jsxs('section', { children: [Z.jsx('div', { id, children: heading }), children] });
  let body;
  if (!list || (list.status === 'loading' && canvases.length === 0)) body = Z.jsx('p', { className: 'rok-cv-section__empty', children: rokCanvasText('正在加载…', 'Loading…') });
  else if (list.status === 'failed' && canvases.length === 0) body = Z.jsxs('p', { className: 'rok-cv-section__empty', children: [rokCanvasText('无法加载画布。', 'Couldn’t load canvases. '),
    Z.jsx('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--sm', onClick: () => store.loadList(agentId), children: rokCanvasText('重试', 'Retry') })] });
  else if (canvases.length === 0) body = Z.jsx('p', { className: 'rok-cv-section__empty', children: rokCanvasText('这个 Bot 创建的画布会显示在这里。', 'Canvases this Bot makes show up here.') });
  else body = Z.jsxs(Z.Fragment, { children: [
    Z.jsx('ul', { className: 'rok-cv-section__list', 'aria-labelledby': headingId, children: shown.map(canvas => Z.jsx(RokBotCanvasRow, {
      canvas, menuOpen: menu?.id === canvas.id,
      onMenu: button => setMenu(current => current?.id === canvas.id ? null : { id: canvas.id, button }),
    }, canvas.id)) }),
    canvases.length > ROK_CANVAS_SECTION_PAGE ? Z.jsx('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--sm rok-cv-section__more', onClick: () => setExpanded(v => !v),
      children: expanded ? rokCanvasText('收起', 'Show less') : rokCanvasText(`显示全部 ${canvases.length} 个`, `Show all ${canvases.length}`) }) : null,
  ] });
  const menuCanvas = menu ? canvases.find(item => item.id === menu.id) : null;
  const sharingCanvas = sharing ? (store.item(sharing.id)?.canvas ?? canvases.find(item => item.id === sharing.id)) : null;
  return Z.jsxs(Z.Fragment, { children: [
    Z.jsx(Section, { heading: rokCanvasText('画布', 'Canvases'), headingId, children: Z.jsx('div', { className: 'rok-cv-section', 'data-rok-bot-canvases': agentId, children: body }) }),
    menuCanvas ? rokCanvasPortal(Z.jsx(RokCanvasRowMenu, { canvas: menuCanvas, anchor: menu.button, onClose: () => setMenu(null),
      onOpen: () => { setMenu(null); rokCanvasStage().open(menuCanvas.id, { title: menuCanvas.title, returnFocusTo: menu.button }); },
      onShare: () => { setMenu(null); setSharing({ id: menuCanvas.id, button: menu.button }); },
      onDelete: () => { setMenu(null); setDeleting(menuCanvas); } })) : null,
    sharingCanvas ? rokCanvasPortal(Z.jsx('div', { className: 'rok-cv-section', children: Z.jsx(RokCanvasSharePopover, { canvas: sharingCanvas, anchor: sharing.button, onClose: () => setSharing(null) }) })) : null,
    deleting ? rokCanvasPortal(Z.jsx(RokCanvasDeleteDialog, { canvas: deleting, onClose: () => setDeleting(null) })) : null,
  ] });
}

function RokBotCanvasRow({ canvas, menuOpen, onMenu }) {
  const open = event => rokCanvasStage().open(canvas.id, { title: canvas.title, returnFocusTo: event.currentTarget });
  const isPublic = canvas.visibility === 'public';
  return Z.jsxs('li', {
    className: 'rok-cv-row', role: 'button', tabIndex: 0, 'data-rok-canvas-row': canvas.id,
    'aria-label': rokCanvasText(`打开画布：${canvas.title}`, `Open canvas: ${canvas.title}`),
    onClick: event => { if (!event.target.closest('[data-rok-canvas-more]')) open(event); },
    onKeyDown: event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); open(event); } },
    children: [
      Z.jsx('span', { className: 'rok-cv-glyph', children: Z.jsx(RokCanvasIcon, { name: 'page' }) }),
      Z.jsxs('span', { className: 'rok-cv-row__text', children: [
        Z.jsx('span', { className: 'rok-cv-row__title', title: canvas.title, children: canvas.title }),
        Z.jsxs('span', { className: 'rok-cv-row__meta', children: [
          Z.jsx('span', { title: rokCanvasFullTime(canvas.updatedAtMs), children: rokCanvasTime(canvas.updatedAtMs) }),
          Z.jsx('span', { 'aria-hidden': 'true', children: '·' }),
          Z.jsxs('span', { className: `rok-cv-row__mark${isPublic ? ' rok-cv-row__mark--public' : ''}`, 'data-rok-canvas-visibility': canvas.visibility, children: [
            Z.jsx(RokCanvasIcon, { name: isPublic ? 'globe' : 'lock', size: 12 }), rokCanvasVisibilityLabel(canvas.visibility)] }),
        ] }),
      ] }),
      Z.jsx('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--icon', 'data-rok-canvas-more': '', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen ? 'true' : 'false',
        'aria-label': rokCanvasText(`“${canvas.title}”的更多操作`, `More actions for ${canvas.title}`),
        onClick: event => { event.stopPropagation(); onMenu(event.currentTarget); }, children: Z.jsx(RokCanvasIcon, { name: 'more' }) }),
    ],
  });
}

function RokCanvasRowMenu({ canvas, anchor, onClose, onOpen, onShare, onDelete }) {
  const ref = X.useRef(null);
  const [place] = X.useState(() => rokCanvasPlace(anchor, 184));
  X.useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const onDown = event => { if (!ref.current?.contains(event.target) && !anchor?.contains?.(event.target)) onClose(); };
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); anchor?.focus?.(); } };
    globalThis.document.addEventListener('pointerdown', onDown, true);
    globalThis.document.addEventListener('keydown', onKey, true);
    return () => { globalThis.document.removeEventListener('pointerdown', onDown, true); globalThis.document.removeEventListener('keydown', onKey, true); };
  }, [anchor, onClose]);
  const item = (icon, label, onSelect, danger = false) => Z.jsxs('button', { type: 'button', role: 'menuitem', ...(danger ? { 'data-danger': '' } : {}), onClick: onSelect,
    children: [Z.jsx(RokCanvasIcon, { name: icon }), label] });
  return Z.jsxs('div', { ref, className: 'rok-cv-menu', role: 'menu', 'aria-label': rokCanvasText(`“${canvas.title}”的更多操作`, `More actions for ${canvas.title}`), style: place,
    children: [
      item('open', rokCanvasText('打开', 'Open'), onOpen),
      item('share', rokCanvasText('分享…', 'Share…'), onShare),
      Z.jsx('hr', {}),
      item('trash', rokCanvasText('删除…', 'Delete…'), onDelete, true),
    ] });
}

function RokCanvasDeleteDialog({ canvas, onClose }) {
  const store = rokCanvasStore();
  const [pending, setPending] = X.useState(false);
  const [error, setError] = X.useState(null);
  const cancel = X.useRef(null);
  X.useEffect(() => {
    cancel.current?.focus();
    const onKey = event => { if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); onClose(); } };
    globalThis.document.addEventListener('keydown', onKey, true);
    return () => globalThis.document.removeEventListener('keydown', onKey, true);
  }, [pending, onClose]);
  const remove = async () => {
    setPending(true); setError(null);
    try {
      await store.remove(canvas.id);
      if (rokCanvasStage().get()?.id === canvas.id) rokCanvasStage().close();
      onClose();
    } catch {
      setError(rokCanvasText('无法删除画布，请稍后再试。', 'Couldn’t delete the canvas. Try again later.'));
      setPending(false);
    }
  };
  return Z.jsx('div', { className: 'rok-cv-scrim', onPointerDown: event => { if (event.target === event.currentTarget && !pending) onClose(); },
    children: Z.jsxs('div', { className: 'rok-cv-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'rok-cv-delete-title', 'aria-describedby': 'rok-cv-delete-body', 'data-rok-canvas-delete': canvas.id,
      children: [
        Z.jsx('h2', { id: 'rok-cv-delete-title', children: rokCanvasText(`删除“${canvas.title}”`, `Delete “${canvas.title}”`) }),
        Z.jsx('p', { id: 'rok-cv-delete-body', children: rokCanvasText('这会永久删除这个画布。它的公开链接会立即失效，聊天里的画布卡片会显示为已删除。此操作无法撤销。',
          'This permanently deletes the canvas. Its public link stops working and chat cards show it as deleted. This can’t be undone.') }),
        error ? Z.jsx('p', { className: 'rok-cv-note rok-cv-note--error', role: 'alert', children: error }) : null,
        Z.jsxs('div', { className: 'rok-cv-dialog__actions', children: [
          Z.jsx('button', { ref: cancel, type: 'button', className: 'rok-cv-btn rok-cv-btn--outline', onClick: onClose, disabled: pending, children: rokCanvasText('取消', 'Cancel') }),
          Z.jsx('button', { type: 'button', className: 'rok-cv-btn rok-cv-btn--danger', onClick: remove, disabled: pending,
            children: pending ? rokCanvasText('正在删除…', 'Deleting…') : rokCanvasText('删除画布', 'Delete canvas') }),
        ] }),
      ] }) });
}

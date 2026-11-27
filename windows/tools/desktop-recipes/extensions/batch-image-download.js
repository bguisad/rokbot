// RokBot Multi-Select Batch Image Download (Desktop + Web).
// Tracks image attachments resolved in the active conversation and integrates into the Media Viewer
// so users can select multiple images (chat header button or Media Viewer) and download them to a folder (Desktop) or as a ZIP (Desktop/Web).

const ROK_BATCH_IMG_CSS = `
.rok-batch-mv-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 36px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(32, 32, 36, 0.78);
  color: #ffffff;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  backdrop-filter: blur(8px);
}
.rok-batch-mv-btn:hover { background: rgba(48, 48, 54, 0.92); }
.rok-batch-mv-btn--embedded {
  height: 28px;
  padding: 0 9px;
  font-size: 12px;
  background: transparent;
  color: inherit;
  border-color: rgba(128, 128, 128, 0.3);
}
.rok-batch-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2200;
  background: rgba(0, 0, 0, 0.56);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  backdrop-filter: blur(4px);
}
.rok-batch-dialog {
  width: min(820px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: #ffffff;
  color: #18181b;
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
  overflow: hidden;
}
.cursor-dark .rok-batch-dialog,
[data-theme="dark"] .rok-batch-dialog {
  background: #1c1c20;
  color: #f4f4f5;
  border-color: rgba(255, 255, 255, 0.12);
}
.rok-batch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.18);
}
.rok-batch-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.rok-batch-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.rok-batch-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(37, 99, 235, 0.12);
  color: #2563eb;
  font-weight: 600;
}
.cursor-dark .rok-batch-badge,
[data-theme="dark"] .rok-batch-badge {
  background: rgba(96, 165, 250, 0.18);
  color: #93c5fd;
}
.rok-batch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 18px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.14);
}
.rok-batch-toolbar-btns { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.rok-batch-hint { font-size: 12px; opacity: 0.65; }
.rok-batch-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.28);
  background: transparent;
  color: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}
.rok-batch-btn:hover:not(:disabled) { background: rgba(128, 128, 128, 0.12); }
.rok-batch-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.rok-batch-btn--primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #ffffff;
}
.rok-batch-btn--primary:hover:not(:disabled) { background: #1d4ed8; }
.rok-batch-btn--icon {
  width: 32px;
  padding: 0;
  border-radius: 999px;
}
.rok-batch-grid {
  flex: 1;
  min-height: 180px;
  overflow-y: auto;
  padding: 14px 18px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(136px, 1fr));
  gap: 12px;
  align-content: start;
}
.rok-batch-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  overflow: hidden;
  border: 2px solid rgba(128, 128, 128, 0.2);
  background: rgba(128, 128, 128, 0.06);
  cursor: pointer;
  padding: 0;
  text-align: left;
  color: inherit;
  transition: border-color 120ms ease, transform 100ms ease;
}
.rok-batch-card:hover { transform: translateY(-1px); }
.rok-batch-card--selected {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}
.rok-batch-thumb-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  background: rgba(128, 128, 128, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.rok-batch-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.rok-batch-check {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 1.5px solid rgba(255, 255, 255, 0.9);
  background: rgba(0, 0, 0, 0.45);
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rok-batch-card--selected .rok-batch-check {
  background: #2563eb;
  border-color: #2563eb;
}
.rok-batch-name {
  padding: 6px 8px;
  font-size: 11.5px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rok-batch-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid rgba(128, 128, 128, 0.18);
}
.rok-batch-status {
  font-size: 12.5px;
  opacity: 0.85;
  min-height: 18px;
}
.rok-batch-status--error { color: #ef4444; opacity: 1; }
.rok-batch-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
`;

function rokBatchBaseName(source, caption, index) {
  const raw = String(source || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  if (raw && /\.[a-z0-9]{2,5}$/i.test(raw)) return raw;
  const cleanCaption = String(caption || '').trim().replace(/[/\\:*?"<>|]/g, '_').slice(0, 60);
  if (cleanCaption) return `${cleanCaption}.png`;
  return `image-${index + 1}.png`;
}

function rokBatchIsImageSource(source) {
  if (typeof source !== 'string' || !source.trim()) return false;
  if (/\.(?:mp4|m4v|mov|webm|ogv|aac|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/i.test(source.split(/[?#]/)[0])) return false;
  return true;
}

function rokBatchImageStore() {
  if (globalThis.__rokBatchImageStore) return globalThis.__rokBatchImageStore;
  const byAgent = new Map();
  let activeAgentId = '__default__';
  let snapshot = { activeAgentId, items: [] };
  const listeners = new Set();

  const rebuild = () => {
    const map = byAgent.get(activeAgentId);
    snapshot = {
      activeAgentId,
      items: map ? [...map.values()] : [],
    };
    for (const fn of [...listeners]) {
      try { fn(); } catch {}
    }
  };

  const store = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot() {
      return snapshot;
    },
    setActiveAgent(agentId) {
      const next = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : '__default__';
      if (next === activeAgentId) return;
      activeAgentId = next;
      rebuild();
    },
    record({ source, src, width = 0, height = 0, suggestedName = '', agentId = null }) {
      if (!rokBatchIsImageSource(source)) return;
      const bucketKey = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : activeAgentId;
      let map = byAgent.get(bucketKey);
      if (!map) {
        map = new Map();
        byAgent.set(bucketKey, map);
      }
      const prev = map.get(source);
      const next = {
        source,
        src: src || prev?.src || '',
        width: width || prev?.width || 0,
        height: height || prev?.height || 0,
        suggestedName: suggestedName || prev?.suggestedName || rokBatchBaseName(source, '', map.size),
        seenAt: prev?.seenAt ?? Date.now(),
      };
      const changed = !prev || prev.src !== next.src || prev.suggestedName !== next.suggestedName;
      map.set(source, next);
      if (changed && bucketKey === activeAgentId) rebuild();
    },
    getCachedPreview(source) {
      for (const map of byAgent.values()) {
        const hit = map.get(source);
        if (hit?.src) return hit.src;
      }
      return '';
    },
    clearAgent(agentId) {
      const key = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : activeAgentId;
      if (byAgent.delete(key) && key === activeAgentId) rebuild();
    },
  };
  globalThis.__rokBatchImageStore = store;
  return store;
}

function rokSetActiveAgentId(agentId) {
  try { rokBatchImageStore().setActiveAgent(agentId); } catch {}
}

function rokTrackResolvedMedia(request, promise) {
  const source = request?.source;
  if (typeof source === 'string' && promise && typeof promise.then === 'function') {
    promise.then(media => {
      if (media?.kind === 'image' && typeof media.src === 'string') {
        rokBatchImageStore().record({
          source,
          src: media.src,
          width: media.width || 0,
          height: media.height || 0,
        });
      }
    }, () => {});
  }
  return promise;
}

function RokBatchIconImages({ size = 15 }) {
  return Z.jsxs('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    children: [
      Z.jsx('rect', { x: 1.5, y: 2.5, width: 9.5, height: 8, rx: 1.5 }),
      Z.jsx('path', { d: 'M11 5.5h2a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 12v-1.5' }),
      Z.jsx('path', { d: 'M3.5 8.5l2-2 1.8 1.8 1.2-1.2 1 1.4' }),
    ],
  });
}

function RokBatchIconDownload({ size = 14 }) {
  return Z.jsxs('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    children: [
      Z.jsx('path', { d: 'M8 2.5v7.5' }),
      Z.jsx('path', { d: 'M5 7.5L8 10.5l3-3' }),
      Z.jsx('path', { d: 'M2.5 12.5h11' }),
    ],
  });
}

function RokBatchIconCheck({ size = 13 }) {
  return Z.jsx('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    children: Z.jsx('path', { d: 'M3.2 8.4l3.1 3.1 6.5-6.8' }),
  });
}

function RokBatchIconClose({ size = 15 }) {
  return Z.jsxs('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    'aria-hidden': true,
    children: [
      Z.jsx('path', { d: 'M4 4l8 8' }),
      Z.jsx('path', { d: 'M12 4l-8 8' }),
    ],
  });
}

function rokOpenBatchImageModal(items) {
  const list = Array.isArray(items) ? items : [];
  if (globalThis.window) {
    globalThis.window.__rokBatchImagesPending = list;
    globalThis.window.dispatchEvent?.(new Event('rokbot-local:batch-images-open'));
  }
}

function RokMediaViewerBatchButton({ sources, captions, embedded }) {
  const imageItems = X.useMemo(() => {
    const arr = Array.isArray(sources) ? sources : [];
    const store = rokBatchImageStore();
    const out = [];
    const seen = new Set();
    for (let i = 0; i < arr.length; i++) {
      const source = arr[i];
      if (!rokBatchIsImageSource(source) || seen.has(source)) continue;
      seen.add(source);
      out.push({
        source,
        src: store.getCachedPreview(source),
        suggestedName: rokBatchBaseName(source, captions?.[i], out.length),
      });
    }
    return out;
  }, [sources, captions]);

  if (imageItems.length < 2) return null;
  const label = grokText(`批量下载 (${imageItems.length})`, `Batch (${imageItems.length})`);
  return Z.jsxs('button', {
    type: 'button',
    className: embedded ? 'rok-batch-mv-btn rok-batch-mv-btn--embedded' : 'rok-batch-mv-btn',
    'aria-label': grokText('批量下载图片', 'Batch download images'),
    'data-rokbot-batch-download': 'media-viewer',
    onClick: e => {
      e?.stopPropagation?.();
      rokOpenBatchImageModal(imageItems);
    },
    children: [
      Z.jsx(RokBatchIconImages, { size: 14 }),
      Z.jsx('span', { children: label }),
    ],
  });
}

function RokBatchImageModal({ items, onClose }) {
  const [selected, setSelected] = X.useState(() => new Set(items.map(item => item.source)));
  const [previews, setPreviews] = X.useState(() => {
    const init = {};
    const store = rokBatchImageStore();
    for (const item of items) {
      const src = item.src || store.getCachedPreview(item.source);
      if (src) init[item.source] = src;
    }
    return init;
  });
  const [busy, setBusy] = X.useState(false);
  const [status, setStatus] = X.useState({ text: '', error: false });
  const lastClickedRef = X.useRef(-1);

  X.useEffect(() => {
    let alive = true;
    const resolve = globalThis.window?.desktop?.main?.resolveAttachmentMedia;
    if (typeof resolve !== 'function') return undefined;
    (async () => {
      for (const item of items) {
        if (!alive) return;
        if (previews[item.source]) continue;
        try {
          const media = await resolve({ source: item.source, rendition: 'tile-256' });
          if (alive && media?.kind === 'image' && media.src) {
            setPreviews(prev => (prev[item.source] ? prev : { ...prev, [item.source]: media.src }));
          }
        } catch {}
      }
    })();
    return () => { alive = false; };
  }, [items]);

  X.useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    globalThis.window?.addEventListener?.('keydown', onKey);
    return () => globalThis.window?.removeEventListener?.('keydown', onKey);
  }, [busy, onClose]);

  const toggleIndex = (index, shiftKey) => {
    setSelected(prev => {
      const next = new Set(prev);
      const target = items[index];
      if (!target) return next;
      if (shiftKey && lastClickedRef.current >= 0 && lastClickedRef.current < items.length) {
        const start = Math.min(lastClickedRef.current, index);
        const end = Math.max(lastClickedRef.current, index);
        const shouldSelect = !prev.has(target.source);
        for (let i = start; i <= end; i++) {
          if (shouldSelect) next.add(items[i].source);
          else next.delete(items[i].source);
        }
      } else if (next.has(target.source)) {
        next.delete(target.source);
      } else {
        next.add(target.source);
      }
      lastClickedRef.current = index;
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(items.map(i => i.source)));
  const clearAll = () => setSelected(new Set());
  const invertSelection = () => setSelected(prev => new Set(items.filter(i => !prev.has(i.source)).map(i => i.source)));

  const chosen = items.filter(item => selected.has(item.source));
  const isWebClient = globalThis.window?.localBot?.platform === 'android' || globalThis.window?.__rokbotAndroidBoot?.client === 'web';
  const canSaveFolder = !isWebClient && typeof globalThis.window?.desktop?.main?.downloadAttachments === 'function';
  const canSaveZip = typeof globalThis.window?.localBot?.downloadAttachmentsZip === 'function'
    || typeof globalThis.window?.desktop?.main?.downloadAttachments === 'function';

  const runDownload = async mode => {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    setStatus({ text: grokText(`正在准备 ${chosen.length} 张图片…`, `Preparing ${chosen.length} images…`), error: false });
    try {
      const downloads = chosen.map((item, idx) => ({
        path: item.source,
        suggestedName: item.suggestedName || rokBatchBaseName(item.source, '', idx),
      }));
      let ok = false;
      if (mode === 'zip') {
        const zipName = `rokbot-images-${new Date().toISOString().slice(0, 10)}.zip`;
        if (typeof globalThis.window?.localBot?.downloadAttachmentsZip === 'function') {
          ok = await globalThis.window.localBot.downloadAttachmentsZip({ downloads, suggestedName: zipName });
        } else if (typeof globalThis.window?.desktop?.main?.downloadAttachments === 'function') {
          ok = await globalThis.window.desktop.main.downloadAttachments({ downloads, suggestedName: zipName });
        }
      } else if (downloads.length === 1 && typeof globalThis.window?.desktop?.main?.downloadAttachment === 'function') {
        ok = await globalThis.window.desktop.main.downloadAttachment(downloads[0]);
      } else if (typeof globalThis.window?.desktop?.main?.downloadAttachments === 'function') {
        ok = await globalThis.window.desktop.main.downloadAttachments({ downloads });
      }
      if (ok) {
        setStatus({
          text: grokText(`已保存 ${chosen.length} 张图片`, `Saved ${chosen.length} images`),
          error: false,
        });
      } else {
        setStatus({ text: grokText('已取消或未完成下载', 'Download canceled or incomplete'), error: false });
      }
    } catch (err) {
      setStatus({
        text: err?.message || grokText('批量下载失败，请重试', 'Batch download failed. Try again.'),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const modal = Z.jsx('div', {
    className: 'rok-batch-backdrop',
    onClick: e => { if (e.target === e.currentTarget && !busy) onClose(); },
    children: Z.jsxs('div', {
      className: 'rok-batch-dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': grokText('批量下载图片', 'Batch download images'),
      children: [
        Z.jsx('style', { children: ROK_BATCH_IMG_CSS }),
        Z.jsxs('div', {
          className: 'rok-batch-header',
          children: [
            Z.jsxs('div', {
              className: 'rok-batch-title-group',
              children: [
                Z.jsx(RokBatchIconImages, { size: 17 }),
                Z.jsx('h2', { className: 'rok-batch-title', children: grokText('批量下载图片', 'Batch download images') }),
                Z.jsx('span', {
                  className: 'rok-batch-badge',
                  children: grokText(`已选 ${chosen.length} / ${items.length} 张`, `${chosen.length} / ${items.length} selected`),
                }),
              ],
            }),
            Z.jsx('button', {
              type: 'button',
              className: 'rok-batch-btn rok-batch-btn--icon',
              'aria-label': grokText('关闭', 'Close'),
              disabled: busy,
              onClick: onClose,
              children: Z.jsx(RokBatchIconClose, { size: 15 }),
            }),
          ],
        }),
        Z.jsxs('div', {
          className: 'rok-batch-toolbar',
          children: [
            Z.jsxs('div', {
              className: 'rok-batch-toolbar-btns',
              children: [
                Z.jsx('button', { type: 'button', className: 'rok-batch-btn', disabled: busy, onClick: selectAll, children: grokText('全选', 'Select all') }),
                Z.jsx('button', { type: 'button', className: 'rok-batch-btn', disabled: busy, onClick: invertSelection, children: grokText('反选', 'Invert') }),
                Z.jsx('button', { type: 'button', className: 'rok-batch-btn', disabled: busy, onClick: clearAll, children: grokText('清空', 'Clear') }),
              ],
            }),
            Z.jsx('span', { className: 'rok-batch-hint', children: grokText('点击选择，支持 Shift 连选', 'Click to select, Shift-click for range') }),
          ],
        }),
        Z.jsx('div', {
          className: 'rok-batch-grid',
          children: items.map((item, idx) => {
            const isSelected = selected.has(item.source);
            const thumbSrc = previews[item.source] || item.src || '';
            const name = item.suggestedName || rokBatchBaseName(item.source, '', idx);
            return Z.jsxs('button', {
              key: item.source,
              type: 'button',
              className: isSelected ? 'rok-batch-card rok-batch-card--selected' : 'rok-batch-card',
              'aria-pressed': isSelected,
              'data-rok-batch-item': item.source,
              disabled: busy,
              onClick: e => toggleIndex(idx, Boolean(e?.shiftKey)),
              children: [
                Z.jsxs('div', {
                  className: 'rok-batch-thumb-wrap',
                  children: [
                    thumbSrc
                      ? Z.jsx('img', { className: 'rok-batch-thumb', src: thumbSrc, alt: name, loading: 'lazy' })
                      : Z.jsx(RokBatchIconImages, { size: 28 }),
                    Z.jsx('span', {
                      className: 'rok-batch-check',
                      children: isSelected ? Z.jsx(RokBatchIconCheck, { size: 13 }) : null,
                    }),
                  ],
                }),
                Z.jsx('span', { className: 'rok-batch-name', title: name, children: name }),
              ],
            });
          }),
        }),
        Z.jsxs('div', {
          className: 'rok-batch-footer',
          children: [
            Z.jsx('span', {
              className: status.error ? 'rok-batch-status rok-batch-status--error' : 'rok-batch-status',
              role: 'status',
              children: status.text,
            }),
            Z.jsxs('div', {
              className: 'rok-batch-actions',
              children: [
                canSaveZip && Z.jsxs('button', {
                  type: 'button',
                  className: canSaveFolder ? 'rok-batch-btn' : 'rok-batch-btn rok-batch-btn--primary',
                  disabled: busy || chosen.length === 0,
                  onClick: () => void runDownload('zip'),
                  children: [
                    Z.jsx(RokBatchIconDownload, { size: 14 }),
                    Z.jsx('span', {
                      children: grokText(`打包下载 ZIP (${chosen.length})`, `Download ZIP (${chosen.length})`),
                    }),
                  ],
                }),
                canSaveFolder && Z.jsxs('button', {
                  type: 'button',
                  className: 'rok-batch-btn rok-batch-btn--primary',
                  disabled: busy || chosen.length === 0,
                  onClick: () => void runDownload('folder'),
                  children: [
                    Z.jsx(RokBatchIconDownload, { size: 14 }),
                    Z.jsx('span', {
                      children: grokText(`保存到文件夹 (${chosen.length})`, `Save to folder (${chosen.length})`),
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  });

  const container = (typeof Yt === 'function' ? Yt() : null) ?? globalThis.document?.body ?? null;
  return container && typeof BS?.createPortal === 'function' ? BS.createPortal(modal, container) : modal;
}

function RokBatchImageHost() {
  const [modalItems, setModalItems] = X.useState(null);

  X.useEffect(() => {
    const onOpen = () => {
      const pending = globalThis.window?.__rokBatchImagesPending;
      if (globalThis.window) globalThis.window.__rokBatchImagesPending = null;
      if (Array.isArray(pending) && pending.length > 0) {
        setModalItems(pending);
      } else {
        const current = rokBatchImageStore().getSnapshot().items;
        if (current.length > 0) setModalItems(current);
      }
    };
    globalThis.window?.addEventListener?.('rokbot-local:batch-images-open', onOpen);
    return () => globalThis.window?.removeEventListener?.('rokbot-local:batch-images-open', onOpen);
  }, []);

  return modalItems ? Z.jsx(RokBatchImageModal, { items: modalItems, onClose: () => setModalItems(null) }) : null;
}

// Chat header entry (next to the official header controls): shown only while the open
// conversation has at least two images, instead of an always-visible floating button.
function rokBatchHeaderItems(snap, agentId) {
  if (!snap || !Array.isArray(snap.items)) return [];
  const active = snap.activeAgentId;
  if (typeof agentId === 'string' && agentId && active && active !== '__default__' && active !== agentId) return [];
  return snap.items;
}

function RokChatHeaderBatchButton({ agentId }) {
  const store = rokBatchImageStore();
  const snap = X.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const items = rokBatchHeaderItems(snap, agentId);
  if (items.length < 2) return null;
  const label = grokText(`批量下载图片（${items.length}）`, `Batch download images (${items.length})`);
  const button = Z.jsx(IC, {
    'aria-label': label,
    'data-rokbot-batch-download': 'chat-header',
    glyph: Z.jsx(RokBatchIconImages, { size: 16 }),
    iconSize: 'md',
    shape: 'circle',
    type: 'button',
    onClick: () => rokOpenBatchImageModal(items),
  });
  return Z.jsx(le, { content: label, children: button });
}

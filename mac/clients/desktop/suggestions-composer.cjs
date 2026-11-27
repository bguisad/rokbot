// Loaded by the desktop preload (macOS, Windows, Linux). Installs the shared composer assist
// (composer-assist.cjs: suggestion strip with the loading shimmer, inline completion ghost text,
// and the first-level "Input suggestions" settings entry) on the official renderer, with requests
// going to the Host through the main process (rokbot-local:suggestions-* IPC channels).
(() => {
  if (typeof document === 'undefined' || typeof window === 'undefined' || window !== window.top) return;
  let ipcRenderer;
  try { ({ ipcRenderer } = require('electron')); } catch { return; }
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return;
  const assist = require('./composer-assist.cjs');

  let locale = '';
  try { locale = ipcRenderer.sendSync('rokbot-local:locale') || ''; } catch {}
  let nextRequestId = 0;

  const PHRASE_RE = /^\/local\/suggestions\/phrases\/([A-Za-z0-9_-]{1,64})$/;
  // Same signature as the Web gateway: request(path, body, signal, method).
  function request(path, body, signal, method = 'POST') {
    if (path === '/local/suggestions/settings') {
      return method === 'GET'
        ? ipcRenderer.invoke('rokbot-local:suggestions-settings-get')
        : ipcRenderer.invoke('rokbot-local:suggestions-settings-put', body ?? {});
    }
    if (path === '/local/suggestions/phrases' && method === 'POST') return ipcRenderer.invoke('rokbot-local:suggestions-phrase-add', { text: body?.text ?? '' });
    if (path === '/local/suggestions/phrases/reorder') return ipcRenderer.invoke('rokbot-local:suggestions-phrase-reorder', { ids: body?.ids ?? [] });
    if (path === '/local/suggestions/feedback') return ipcRenderer.invoke('rokbot-local:suggestions-feedback', body ?? {});
    if (path === '/local/suggestions/habits' && method === 'DELETE') return ipcRenderer.invoke('rokbot-local:suggestions-habits-clear');
    const phrase = PHRASE_RE.exec(path);
    if (phrase && method === 'DELETE') return ipcRenderer.invoke('rokbot-local:suggestions-phrase-delete', { id: decodeURIComponent(phrase[1]) });
    if (phrase) return ipcRenderer.invoke('rokbot-local:suggestions-phrase-update', { id: decodeURIComponent(phrase[1]), text: body?.text ?? '' });
    if (path === '/local/suggestions' || path === '/local/suggestions/complete') {
      const channel = path === '/local/suggestions' ? 'rokbot-local:suggestions-generate' : 'rokbot-local:suggestions-complete';
      const requestId = `${Date.now().toString(36)}-${++nextRequestId}`;
      if (signal?.aborted) return Promise.reject(new Error('Cancelled'));
      // An aborted renderer request also cancels the Host call in the main process.
      const onAbort = () => ipcRenderer.send('rokbot-local:suggestions-cancel', requestId);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      return ipcRenderer.invoke(channel, { requestId, body: body ?? {} })
        .finally(() => signal?.removeEventListener?.('abort', onAbort));
    }
    return Promise.reject(new Error(`Unsupported suggestions request: ${method} ${path}`));
  }

  // The Bot on screen (setViewingAgent of the official renderer, deep links), pushed by main.
  let viewingAgentId = '';
  try { viewingAgentId = ipcRenderer.sendSync('rokbot-local:viewing-agent-get') || ''; } catch {}
  ipcRenderer.on?.('rokbot-local:viewing-agent', (_event, id) => { if (typeof id === 'string') viewingAgentId = id; });

  const start = () => assist.installComposerSuggestions({ request, locale, document, window, getViewingAgentId: () => viewingAgentId });
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

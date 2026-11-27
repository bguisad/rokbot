// Loaded by the desktop preload (macOS, Windows, Linux). Installs the shared group-chat
// creation button and dialog (group-create.cjs) on the official renderer, talking to the Host
// through the main process (rokbot-local:group-list-agents, group-create, open-agent).
(() => {
  if (typeof document === 'undefined' || typeof window === 'undefined' || window !== window.top) return;
  let ipcRenderer;
  try { ({ ipcRenderer } = require('electron')); } catch { return; }
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return;
  const groupCreate = require('./group-create.cjs');

  let locale = '';
  try { locale = ipcRenderer.sendSync('rokbot-local:locale') || ''; } catch {}

  const start = () => groupCreate.installGroupCreate({
    document,
    window,
    locale,
    listAgents: () => ipcRenderer.invoke('rokbot-local:group-list-agents'),
    createGroup: body => ipcRenderer.invoke('rokbot-local:group-create', body),
    openAgent: id => ipcRenderer.send('rokbot-local:open-agent', id),
  });

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

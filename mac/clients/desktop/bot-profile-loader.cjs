// Loaded by the desktop preload (macOS, Windows, Linux). Installs the Bot details page
// (bot-profile.cjs) on the official renderer: clicking the Bot name at the top of a conversation
// opens it, matching the mobile Bot details experience. Because contextIsolation is enabled on
// desktop, all Host/local data flows through existing main-process IPC channels.
(() => {
  if (typeof document === 'undefined' || typeof window === 'undefined' || window !== window.top) return;
  let ipcRenderer;
  try { ({ ipcRenderer } = require('electron')); } catch { return; }
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return;
  const profile = require('./bot-profile.cjs');

  let locale = '';
  try { locale = ipcRenderer.sendSync('rokbot-local:locale') || ''; } catch {}
  let viewingAgentId = '';
  try { viewingAgentId = ipcRenderer.sendSync('rokbot-local:viewing-agent-get') || ''; } catch {}
  ipcRenderer.on?.('rokbot-local:viewing-agent', (_event, id) => { if (typeof id === 'string') viewingAgentId = id; });

  const start = () => {
    const ui = profile.installBotProfile({
      document,
      window,
      locale,
      getViewingAgentId: () => viewingAgentId,
      getAgent: id => ipcRenderer.invoke('rokbot-local:bot-profile-get', { id }),
      getAutomations: id => ipcRenderer.invoke('rokbot-local:bot-automations-get', { id }),
      setNotify: (id, isEnabled) => ipcRenderer.invoke('rokbot-local:bot-notify-set', { id, isEnabled }),
      usage: () => ipcRenderer.invoke('rokbot-local:usage', {}),
      modelConfig: () => ipcRenderer.invoke('rokbot-local:model-get'),
      connection: () => ipcRenderer.invoke('rokbot-local:status'),
    });
    ipcRenderer.on?.('rokbot-local:locale', (_event, next) => { if (typeof next === 'string') ui?.setLocale?.(next); });
  };
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

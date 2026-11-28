// Loaded by the desktop preload (macOS, Windows, Linux). Installs the grouped settings navigation
// (settings-nav.cjs) on the official renderer. The groups are a pure DOM layout of the official
// settings dialog, so no Host requests are involved; only the UI language comes from main.
(() => {
  if (typeof document === 'undefined' || typeof window === 'undefined' || window !== window.top) return;
  let ipcRenderer;
  try { ({ ipcRenderer } = require('electron')); } catch { return; }
  const nav = require('./settings-nav.cjs');

  let locale = '';
  try { locale = ipcRenderer.sendSync('rokbot-local:locale') || ''; } catch {}

  const start = () => {
    const settingsNav = nav.installSettingsNav({ document, locale });

    // Any change of the dialog (a section opened by React, our own group list) is re-synced; our
    // own mutations are skipped so sync() cannot loop on itself.
    const observer = new MutationObserver(mutations => {
      if (mutations.every(m => m.target instanceof Element
        && (m.target.closest('.rokbot-settings-nav-host') || m.target.closest('[data-rokbot-settings-pane]')))) return;
      settingsNav.sync();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current', 'data-active', 'class'] });
    settingsNav.sync();

    // The official renderer can switch language without a reload.
    ipcRenderer.on?.('rokbot-local:locale', (_event, next) => { if (typeof next === 'string') settingsNav.setLocale(next); });
  };

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

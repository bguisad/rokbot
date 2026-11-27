// Loaded by the desktop preload (macOS, Windows, Linux). Adds a "Migrate from Grok Bot" entry
// to the General settings panel; the button opens the migration window in the main process.
// Styling reuses the input-suggestions settings classes so both sections look alike.
(() => {
  if (typeof document === 'undefined' || typeof window === 'undefined' || window !== window.top) return;
  let ipcRenderer;
  try { ({ ipcRenderer } = require('electron')); } catch { return; }
  if (!ipcRenderer || typeof ipcRenderer.send !== 'function') return;
  const isZh = () => {
    let lang = '';
    try { lang = document.documentElement?.lang || ipcRenderer.sendSync('rokbot-local:locale') || navigator.language || ''; } catch {}
    return String(lang).toLowerCase().startsWith('zh');
  };
  const tr = (zh, en) => (isZh() ? zh : en);

  function isGeneralPane(panel) {
    if (!panel) return false;
    const activeNav = panel.closest('.sand-settings-layout')?.querySelector(
      '.sand-settings-nav__item[aria-selected="true"], .sand-settings-nav__item[aria-current="page"], .sand-settings-nav__item[data-active="true"]');
    const label = (activeNav?.textContent || '').trim().toLowerCase();
    if (label && !label.includes('general') && !label.includes('通用') && !label.includes('常规')) return false;
    if (panel.querySelector('#sand-setting-theme, #sand-setting-language, [data-rokbot-suggestions-settings], [data-rokbot-migrate-settings]')) return true;
    const title = (panel.querySelector('.sand-settings-pane-header h2, h2')?.textContent || '').trim().toLowerCase();
    return title === 'general' || title === '通用' || title === '常规' || title === '';
  }

  function build() {
    const section = document.createElement('section');
    section.className = 'rokbot-sug-settings';
    section.setAttribute('data-rokbot-migrate-settings', '1');
    const heading = document.createElement('h3');
    heading.className = 'rokbot-sug-settings__heading';
    heading.textContent = tr('迁移', 'Migration');
    const card = document.createElement('div');
    card.className = 'rokbot-sug-settings__card';
    const row = document.createElement('div');
    row.className = 'rokbot-sug-settings__row';
    row.style.borderBottom = '0';
    const copy = document.createElement('div');
    copy.className = 'rokbot-sug-settings__copy';
    const title = document.createElement('div');
    title.className = 'rokbot-sug-settings__label';
    title.textContent = tr('从 Grok Bot 迁移', 'Migrate from Grok Bot');
    const desc = document.createElement('div');
    desc.className = 'rokbot-sug-settings__desc';
    desc.textContent = tr('一键读取本机 Grok Bot 数据，或复制迁移 prompt 让 Grok Bot 导出记忆、技能和例程。',
      'Read the local Grok Bot data, or copy a migration prompt so Grok Bot exports memories, skills and routines.');
    copy.append(title, desc);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'rokbot-sug-settings__add-btn';
    open.textContent = tr('打开迁移向导', 'Open');
    open.addEventListener('click', () => ipcRenderer.send('rokbot-local:migrate-open'));
    row.append(copy, open);
    card.append(row);
    section.append(heading, card);
    return section;
  }

  function ensureMounted() {
    const panel = document.querySelector('.sand-settings-panel');
    const existing = document.querySelector('[data-rokbot-migrate-settings]');
    if (!panel || !isGeneralPane(panel)) { existing?.remove(); return; }
    if (existing && panel.contains(existing)) return;
    const pane = panel.querySelector('.sand-settings-pane') || panel.querySelector('.sand-settings-panel__body') || panel;
    pane.appendChild(build());
  }
  function start() {
    new MutationObserver(mutations => {
      if (mutations.every(m => m.target instanceof Element && m.target.closest('[data-rokbot-migrate-settings]'))) return;
      ensureMounted();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current', 'data-active'] });
    ensureMounted();
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();

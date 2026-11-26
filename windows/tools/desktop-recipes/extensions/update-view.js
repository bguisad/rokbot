
// Appended to the original 1.3.0 Updates module; x, h, oe, te, t, re and c are its
// JSX runtime, section, row, button, text, type styles and update hook.
function rokUpdateSummary(status) {
  const state = status?.state ?? {};
  switch (state.type) {
    case 'checking':
      return { text: grokText('正在检查更新…', 'Checking for updates…'), action: null };
    case 'available':
      return { text: grokText(`发现新版本 ${state.version ?? ''}`, `Update available ${state.version ?? ''}`).trim(), action: 'check' };
    case 'downloading': {
      const scaled = state.progress >= 0 && state.progress <= 1 ? state.progress * 100 : state.progress;
      const pct = Number.isFinite(state.progress) ? ` ${Math.max(0, Math.min(100, Math.round(scaled)))}%` : '';
      return { text: grokText(`正在下载更新${pct}…`, `Downloading update${pct}…`), action: null };
    }
    case 'staging':
      return { text: grokText(`正在准备安装 ${state.version ?? ''}…`, `Preparing update ${state.version ?? ''}…`).trim(), action: null };
    case 'ready':
      return { text: grokText(`新版本 ${state.version ?? ''} 已就绪，可重启安装`, `Version ${state.version ?? ''} ready to install`).trim(), action: 'install', version: state.version };
    case 'idle':
      if (state.lastCheck?.result === 'error') {
        return { text: state.lastCheck.errorMessage || state.lastCheck.message || grokText('检查更新失败，请重试', 'Update check failed. Try again.'), action: 'check', error: true };
      }
      if (state.lastCheck?.result === 'up-to-date') {
        return { text: grokText('当前已是最新版本', 'You are up to date'), action: 'check' };
      }
      return { text: '', action: 'check' };
    default:
      return { text: '', action: null };
  }
}
function GrokLocalUpdateStatus({ status, onCheck, onInstall }) {
  const info = rokUpdateSummary(status);
  if (!info.text && !info.action) return null;
  const button = info.action === 'install'
    ? (0, x.jsx)(te, { onClick: () => onInstall?.(info.version), size: 'md', style: re.sm, type: 'button', variant: 'primary',
      children: grokText('立即安装并重启', 'Restart to update') })
    : info.action === 'check'
      ? (0, x.jsx)(te, { onClick: () => onCheck?.(), size: 'md', style: re.sm, type: 'button', variant: 'secondary',
        children: grokText('检查更新', 'Check for updates') })
      : null;
  return (0, x.jsxs)(oe, {
    anchorId: 'update-status',
    label: grokText('版本更新', 'Software updates'),
    description: info.text ? (0, x.jsx)(t, { as: 'span', color: info.error ? 'danger' : 'secondary', level: 'sm', role: 'status', children: info.text }) : null,
    variant: 'card',
    children: button,
  });
}
function GrokLocalVersion(props) {
  const inlineStatus = props?.status ?? null;
  return (0, x.jsxs)(h, { anchorId: 'rokbot-updates', children: [
    (0, x.jsxs)('div', { style: {
      display: 'flex', alignItems: 'center', gap: 16, padding: '22px 20px', minWidth: 0,
    }, children: [
      (0, x.jsx)('img', {
        src: new URL('../../../local-client/icon.png', import.meta.url).href,
        alt: '',
        onError: event => { event.currentTarget.style.display = 'none'; },
        style: { width: 48, height: 48, flexShrink: 0 },
      }),
      (0, x.jsxs)('div', { style: { display: 'grid', gap: 5, flex: 1, minWidth: 0 }, children: [
        (0, x.jsx)('strong', { style: { fontWeight: 550, fontSize: 16 }, children: 'RokBot' }),
        (0, x.jsx)('span', { style: { opacity: .55, fontSize: 13 }, children: '1.3.0' }),
      ] }),
      (0, x.jsx)('span', { style: { fontSize: 12, opacity: .55, whiteSpace: 'nowrap' }, children: grokText('本地版', 'Local') }),
    ] }),
    inlineStatus ? (0, x.jsx)(GrokLocalUpdateStatus, { status: inlineStatus, onCheck: props?.onCheck, onInstall: props?.onInstall }) : null,
  ] });
}

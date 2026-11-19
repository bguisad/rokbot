// Appended to the pinned original renderer; C/r/t4/zp are its existing
// React and form components. This file is not a separate preload script.
const RokLocalFilesDialog = C.lazy(() => import('./chunk-team-bot-overview-panel-zPiPhH7K.js')
  .then(module => ({ default: module.LocalFilesDialog })));
function RokLocalSettings({ agent }) {
  const [filesOpen, setFilesOpen] = C.useState(false);
  const [error, setError] = C.useState('');
  const [saving, setSaving] = C.useState(false);
  const save = async fields => {
    setSaving(true); setError('');
    try { await window.localBot.updateProfile(agent.id, fields); }
    catch (failure) { setError(failure.message || rokText('保存失败，请重试。', 'Could not save. Try again.')); }
    finally { setSaving(false); }
  };
  const label = text => r.jsx('div', { className: 'sand-1y1aw1k sand-jkvuk6 sand-mzvs34 sand-f159sx sand-1wm8ruf sand-spwq11 sand-1o0liin', children: text });
  return r.jsxs('div', { className: 'sand-agent-settings', style: { display: 'grid', gap: 12, marginTop: 20 }, children: [
    label(rokText('标题', 'Title')),
    r.jsx(t4, { ariaLabel: rokText('Bot 标题', 'Bot title'), initialValue: agent.title ?? '', placeholder: rokText('简短描述这个 Bot', 'Short description'), onCommit: title => save({ title }) }),
    label(rokText('指令', 'Instructions')),
    r.jsx(zp, { ariaLabel: rokText('Bot 指令', 'Bot instructions'), isEditable: true, kind: 'description', value: agent.description ?? '', placeholder: rokText('这个 Bot 应遵循的指令', 'Instructions for this Bot'), onCommit: description => save({ description }) }),
    r.jsx('button', { type: 'button', onClick: () => setFilesOpen(true), style: { border: '1px solid currentColor', borderRadius: 8, padding: '10px 12px', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' }, children: rokText('资料库文件', 'Library files') }),
    saving ? r.jsx('p', { role: 'status', children: rokText('正在保存…', 'Saving…') }) : null,
    error ? r.jsx('p', { role: 'alert', style: { color: '#f09b94' }, children: error }) : null,
    filesOpen ? r.jsx(C.Suspense, { fallback: r.jsx('p', { role: 'status', children: rokText('正在读取资料库…', 'Loading library…') }), children: r.jsx(RokLocalFilesDialog, { agent, onClose: () => setFilesOpen(false) }) }) : null,
  ] });
}
function Zq(props) {
  return r.jsxs(r.Fragment, { children: [r.jsx(GrokOriginalSettings, props), props.agent.isGroup ? null : r.jsx(RokLocalSettings, { agent: props.agent })] });
}

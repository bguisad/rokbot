// Appended to the original General module. The dialog uses the original modal,
// focus manager, close button, typography, inputs and action buttons.
import { S as RokDialogParts } from './index-wlkGG389.js';
function RokRealtimeVoiceSettings() {
  const [enabled, setEnabled] = Q.useState(false), [busy, setBusy] = Q.useState(true), [error, setError] = Q.useState('');
  Q.useEffect(() => {
    let alive = true;
    void window.localBot.getVoicePreference().then(value => { if (alive) { setEnabled(value === true); setBusy(false); } }).catch(() => { if (alive) setError(rokText('无法读取设置', 'Could not load setting')); });
    const release = window.localBot.onVoicePreferenceChanged(value => { if (alive) setEnabled(value === true); });
    return () => { alive = false; release(); };
  }, []);
  const toggle = async () => {
    setBusy(true); setError('');
    try { setEnabled(await window.localBot.setVoicePreference(!enabled)); }
    catch { setError(rokText('无法保存设置', 'Could not save setting')); }
    finally { setBusy(false); }
  };
  return l.jsx(ge, { title: rokText('语音', 'Voice'), children: l.jsx(ee, {
    anchorId: null, label: rokText('实时语音（实验性）', 'Realtime voice (Experimental)'), description: error || null, variant: 'card',
    children: l.jsx(Re, { isChecked: enabled, isDisabled: busy, label: rokText('实时语音（实验性）', 'Realtime voice (Experimental)'), onToggle: toggle, size: 'md' }),
  }) });
}
const rokInputClass = 'sand-9f619 sand-h8yej3 sand-dj266r sand-14z9mp sand-at24cr sand-1lziwak sand-1yrsyyn sand-2vl965 sand-10b6aqq sand-e2zdcy sand-mkeg23 sand-1y0btm7 sand-17tbahu sand-vk9egn sand-ur7f20 sand-10e981r sand-tyxrsu sand-jb2p0i sand-fc7y3v sand-1yxxptd sand-1t137rt sand-1h7ufjq';
const rokConnectionStyles = `
.rok-host-dialog{width:min(440px,calc(100vw - 32px))!important;max-width:calc(100vw - 32px)!important;height:auto!important;max-height:calc(100vh - 32px);overflow:auto}
.rok-host-dialog .rok-host-content{padding:30px;min-width:0;display:grid;gap:24px}
.rok-host-dialog header{display:grid;gap:10px;text-align:left}
.rok-host-dialog .rok-host-brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.rok-host-dialog .rok-host-brand img{display:block;width:44px;height:44px}
.rok-host-dialog .sand-dialog__title{font-size:24px;line-height:1.25;letter-spacing:-.45px;text-align:left}
.rok-host-dialog .sand-dialog__description{font-size:13px;line-height:1.5;text-align:left}
.rok-host-identity{display:flex;align-items:center;gap:16px;min-width:0;padding:2px 0 4px}
.rok-host-avatar{width:64px;height:64px;border-radius:50%;flex:0 0 64px;object-fit:cover;background:color-mix(in srgb,currentColor 7%,transparent)}
.rok-host-avatar-fallback{display:grid;place-items:center;font-size:25px;font-weight:500}
.rok-host-person{min-width:0;display:grid;gap:7px}
.rok-host-person strong{font-size:21px;line-height:1.25;letter-spacing:-.4px;font-weight:550;overflow-wrap:anywhere}
.rok-host-person span{font-size:12px;opacity:.5}
.rok-host-details{padding:16px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);border-radius:14px;display:grid;gap:14px;min-width:0}
.rok-host-detail{display:flex;align-items:baseline;justify-content:space-between;gap:18px;min-width:0;font-size:13px;line-height:1.5}
.rok-host-detail>span:first-child{opacity:.55;flex-shrink:0}
.rok-host-detail>span:last-child{text-align:right;overflow-wrap:anywhere;min-width:0}
.rok-host-status{display:inline-flex;align-items:center;gap:7px}
.rok-host-status:before{content:'';width:6px;height:6px;border-radius:50%;background:#b49a60;flex-shrink:0}
.rok-host-status[data-online=true]:before{background:#62ad87}
.rok-host-paired-actions{justify-content:space-between!important;margin-top:2px!important}
.rok-host-fields{display:grid;gap:20px;min-width:0}
.rok-host-fields label{display:grid;gap:8px;font-size:13px;min-width:0}
.rok-host-fields input{min-width:0;width:100%;height:44px;padding:10px 12px;font-size:14px}
.rok-host-error{color:var(--sand-text-error,#df6464);margin:0;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.rok-host-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:0}
@media(max-width:480px){.rok-host-dialog .rok-host-content{padding:26px 24px}.rok-host-dialog .sand-dialog__title{font-size:22px}}
`;
function RokHostConnection() {
  const [open, setOpen] = Q.useState(false), [server, setServer] = Q.useState(''), [key, setKey] = Q.useState('');
  const [editing, setEditing] = Q.useState(false), [tailcat, setTailcat] = Q.useState(false);
  const [busy, setBusy] = Q.useState(false), [error, setError] = Q.useState(''), [status, setStatus] = Q.useState(null);
  const input = Q.useRef(null), submitting = Q.useRef(false), composing = Q.useRef(false), editingRef = Q.useRef(false);
  editingRef.current = editing;
  const applyStatus = value => { setStatus(value); if (!editingRef.current && !submitting.current) { setTailcat(value.tailcat === true); if (value.server) setServer(value.server); } };
  const refresh = () => window.localBot.connectionStatus().then(applyStatus).catch(failure => setError(failure.message));
  const request = () => { window.__rokLocalConnectionRequested = false; window.__grokLocalConnectionRequested = false; setError(''); setKey(''); setEditing(false); setOpen(true); void refresh(); };
  Q.useEffect(() => {
    void refresh();
    return window.localBot.onConnectionChanged(applyStatus);
  }, []);
  Q.useEffect(() => {
    if (!open) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [open]);
  Q.useEffect(() => {
    // Opening both parent settings and the nested dialog in the same commit
    // makes the parent's focus manager hide the new dialog from accessibility.
    const pending = (window.__rokLocalConnectionRequested || window.__grokLocalConnectionRequested) ? setTimeout(request, 0) : null;
    window.addEventListener('rokbot-local:connect-request', request);
    window.addEventListener('grokbot-local:connect-request', request);
    return () => {
      clearTimeout(pending);
      window.removeEventListener('rokbot-local:connect-request', request);
      window.removeEventListener('grokbot-local:connect-request', request);
    };
  }, []);
  const connect = async event => {
    event.preventDefault();
    if (composing.current || submitting.current || !server.trim() || (!editing && !key.trim())) return;
    submitting.current = true; setBusy(true); setError('');
    try { const result = await window.localBot.pair({ server, key, tailcat, edit: editing }); if (!result.ok) throw new Error(result.error); setKey(''); setOpen(false); }
    catch (failure) { setError(failure.message); }
    finally { submitting.current = false; setBusy(false); }
  };
  const disconnect = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { await window.localBot.disconnect(); setStatus({ paired: false }); setKey(''); }
    catch (failure) { setError(failure.message); }
    finally { submitting.current = false; setBusy(false); }
  };
  Q.useEffect(() => { if (open && status && !status.paired) input.current?.focus(); }, [open, status?.paired]);
  const retainFocus = event => {
    if (event.key !== 'Tab') return;
    const fields = [...event.currentTarget.querySelectorAll('button:not([disabled]), input:not([disabled])')].filter(element => element.tabIndex >= 0 && element.getClientRects().length);
    if (!fields.length) return;
    event.preventDefault(); event.stopPropagation();
    const current = fields.indexOf(document.activeElement);
    fields[(current + (event.shiftKey ? -1 : 1) + fields.length) % fields.length].focus();
  };
  const field = (label, value, onChange, type, placeholder, ref) => l.jsxs('label', { children: [label,
    l.jsx('input', { className: rokInputClass, 'aria-label': label, type, value, placeholder, ref, required: true,
      autoComplete: 'off', spellCheck: false, disabled: busy,
      maxLength: type === 'text' ? 6 : undefined, pattern: type === 'text' ? '[A-Za-z0-9]{6}' : undefined, autoCapitalize: type === 'text' ? 'characters' : 'off', onChange: event => onChange(event.currentTarget.value),
      onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
      onKeyDown: event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current || event.keyCode === 229)) event.preventDefault(); } })] });
  const paired = Boolean(status?.paired), person = status?.profile;
  const title = paired ? rokText('连接设置', 'Connection settings') : rokText('连接你的 RokBot', 'Connect your RokBot');
  const stateLabel = status?.state === 'online' ? rokText('已连接', 'Connected') : status?.state === 'connecting' ? rokText('正在连接', 'Connecting') : rokText('正在重新连接', 'Reconnecting');
  return l.jsxs(l.Fragment, { children: [
    l.jsx(me, { onClick: request, size: 'md', style: ze.actionWeakBorder, variant: 'secondary', children: rokText('连接设置', 'Connection settings') }),
    open ? l.jsxs(RokDialogParts.Root, { 'aria-label': title, open: true, onOpenChange: setOpen,
      variant: 'rich', className: 'rok-host-dialog', initialFocus: input, onKeyDown: retainFocus, children: [
      l.jsx('style', { children: rokConnectionStyles }), l.jsx(RokDialogParts.CloseButton, {}),
      !status ? l.jsx('div', { className: 'rok-host-content', role: 'status', children: error || rokText('正在读取连接…', 'Loading connection…') }) : paired && !editing ?
      l.jsxs('section', { className: 'rok-host-content', children: [
        l.jsxs('header', { children: [l.jsx(RokDialogParts.Title, { children: title }),
          null] }),
        l.jsxs('div', { className: 'rok-host-identity', children: [
          person?.avatarDataUrl ? l.jsx('img', { className: 'rok-host-avatar', src: person.avatarDataUrl, alt: '' }) :
            l.jsx('span', { className: 'rok-host-avatar rok-host-avatar-fallback', 'aria-hidden': true, children: Array.from(person?.displayName || 'R')[0] }),
          l.jsxs('div', { className: 'rok-host-person', children: [
            l.jsx('strong', { children: person?.displayName || rokText('本地账户', 'Local account') }), l.jsx('span', { children: rokText('当前账户', 'Account') })] })] }),
        l.jsxs('div', { className: 'rok-host-details', children: [
          l.jsxs('div', { className: 'rok-host-detail', children: [l.jsx('span', { children: 'Host' }), l.jsx('span', { children: person?.hostName || 'RokBot Host' })] }),
          l.jsxs('div', { className: 'rok-host-detail', children: [l.jsx('span', { children: rokText('连接状态', 'Status') }),
            l.jsx('span', { className: 'rok-host-status', 'data-online': status.state === 'online', role: 'status', children: stateLabel })] }),
          l.jsxs('div', { className: 'rok-host-detail', children: [l.jsx('span', { children: rokText('连接方式', 'Connection') }),
            l.jsx('span', { children: status.tailcat ? 'Tailcat' + (status.transportPath === 'relay' ? ' · ' + rokText('中继', 'Relay') : status.transportPath === 'direct' ? ' · ' + rokText('直连', 'Direct') : '') : rokText('直接连接', 'Direct') })] })] }),
        error ? l.jsx('p', { className: 'rok-host-error', role: 'alert', children: error }) : null,
        l.jsxs('div', { className: 'rok-host-actions rok-host-paired-actions', children: [
          l.jsx(RokDialogParts.Action, { type: 'button', onClick: disconnect, disabled: busy, pending: busy, variant: 'secondary', children: busy ? rokText('正在退出…', 'Disconnecting…') : rokText('退出连接', 'Disconnect') }),
          l.jsx(RokDialogParts.Action, { type: 'button', onClick: () => setEditing(true), variant: 'secondary', children: rokText('编辑连接', 'Edit connection') }),
          l.jsx(RokDialogParts.Action, { type: 'button', onClick: () => setOpen(false), variant: 'primary', children: rokText('完成', 'Done') })] })] }) :
      l.jsxs('form', { className: 'rok-host-content', onSubmit: connect, children: [
        l.jsxs('header', { children: [
          l.jsxs('div', { className: 'rok-host-brand', children: [
            l.jsx('img', { src: new URL('../../../local-client/icon.png', import.meta.url).href, alt: 'RokBot' })] }),
          l.jsx(RokDialogParts.Title, { children: rokText('连接你的 RokBot', 'Connect your RokBot') }),
          null] }),
        l.jsxs('div', { className: 'rok-host-fields', children: [
          l.jsxs('div', { className: 'rok-host-detail', children: [l.jsx('span', { children: 'Tailcat' }), l.jsx(Re, { isChecked: tailcat, isDisabled: busy, label: 'Tailcat', onToggle: () => setTailcat(!tailcat), size: 'md' })] }),
          field(tailcat ? rokText('连接链接', 'Connection link') : rokText('Host 地址', 'Host address'), server, setServer, 'url', tailcat ? 'tailcat://connect/…' : 'https://bot.example.com', input),
          !editing && field(rokText('配对码', 'Pairing code'), key, value => setKey(value.toUpperCase()), 'text', rokText('输入新的配对码', 'Pairing code')),
          error ? l.jsx('p', { className: 'rok-host-error', role: 'alert', children: error }) : null] }),
        l.jsxs('div', { className: 'rok-host-actions', children: [
          l.jsx(RokDialogParts.Action, { type: 'button', onClick: () => setOpen(false), variant: 'secondary', children: rokText('取消', 'Cancel') }),
          l.jsx(RokDialogParts.Action, { type: 'submit', disabled: busy || !server.trim() || (!editing && !key.trim()), pending: busy,
            variant: 'primary', children: busy ? rokText('正在连接…', 'Connecting…') : editing ? rokText('保存', 'Save') : rokText('连接', 'Connect') })] })] })] }) : null,
  ] });
}


// Appended to the original 1.3.0 app module. X, Z, BS, Yt, DD, OD, yXr, MPt, IN
// and Pw are its React, JSX runtime, ReactDOM portal, portal container, banner,
// banner action button, banner style, single/multi-line Bot fields and dialog parts.
const __rokLibraryChunk = typeof ROK_LIBRARY_CHUNK === 'string'
  ? ROK_LIBRARY_CHUNK
  : './chunk-bot-store-files-library-Buv97Hok.js';
const __rokGeneralPaneChunk = typeof ROK_GENERAL_PANE_CHUNK === 'string'
  ? ROK_GENERAL_PANE_CHUNK
  : './chunk-general-pane-CZkpGQLQ.js';
const GrokLibraryFiles = X.lazy(() => import(__rokLibraryChunk)
  .then(module => ({ default: module.GrokLibraryFiles })));
const RokModelConfigModal = X.lazy(() => import(__rokGeneralPaneChunk)
  .then(module => ({ default: module.RokModelConfigModal })));

function RokNeedsModelBanner() {
  const [banner, setBanner] = X.useState({ needsModel: false, canConfigureModel: true, dismissed: false });
  const aliveRef = X.useRef(true);
  const prevNeedsRef = X.useRef(false);
  const refresh = X.useCallback(async () => {
    const getLocalStatus = globalThis.window?.localBot?.getLocalStatus;
    if (typeof getLocalStatus !== 'function') return;
    try {
      const res = await getLocalStatus();
      if (!aliveRef.current) return;
      if (!res || res.ok === false) {
        prevNeedsRef.current = false;
        setBanner(prev => prev.needsModel ? { ...prev, needsModel: false } : prev);
        return;
      }
      const nextNeeds = Boolean(res.needsModel);
      const nextCan = res.canConfigureModel !== false;
      const transitioned = nextNeeds && !prevNeedsRef.current;
      prevNeedsRef.current = nextNeeds;
      setBanner(prev => ({
        needsModel: nextNeeds,
        canConfigureModel: nextCan,
        dismissed: !nextNeeds ? false : transitioned ? false : prev.dismissed,
      }));
    } catch {
      if (aliveRef.current) {
        prevNeedsRef.current = false;
        setBanner(prev => prev.needsModel ? { ...prev, needsModel: false } : prev);
      }
    }
  }, []);
  X.useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const unsubConn = typeof globalThis.window?.localBot?.onConnectionChanged === 'function'
      ? globalThis.window.localBot.onConnectionChanged(() => void refresh())
      : () => {};
    const onUpdated = () => void refresh();
    globalThis.window?.addEventListener?.('rokbot-local:model-config-updated', onUpdated);
    globalThis.window?.addEventListener?.('focus', onUpdated);
    return () => {
      aliveRef.current = false;
      try { unsubConn?.(); } catch {}
      globalThis.window?.removeEventListener?.('rokbot-local:model-config-updated', onUpdated);
      globalThis.window?.removeEventListener?.('focus', onUpdated);
    };
  }, [refresh]);
  if (!banner.needsModel || banner.dismissed) return null;
  const openAction = () => {
    if (banner.canConfigureModel) {
      if (globalThis.window) globalThis.window.__rokLocalModelConfigRequested = true;
      globalThis.window?.dispatchEvent?.(new Event('rokbot-local:model-config-request'));
    } else {
      globalThis.window?.localBot?.openManagement?.();
    }
  };
  const content = Z.jsx('div', {
    className: 'sand-ixxii4 sand-oa08wk sand-1w1tb2m sand-cqcyey sand-78zum5 sand-l56j7k sand-1hr3lfm sand-1a733ie sand-47corl',
    'data-needs-model-banner': '',
    style: { position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, pointerEvents: 'none', maxWidth: 'calc(100vw - 32px)' },
    children: Z.jsx('div', {
      className: 'sand-euugli sand-ezivpi sand-193iq5w',
      style: { pointerEvents: 'auto' },
      children: Z.jsx(DD, {
        actions: Z.jsx(OD, {
          kind: 'primary',
          onClick: openAction,
          children: banner.canConfigureModel
            ? grokText('配置模型', 'Configure model')
            : grokText('打开管理后台', 'Open Host Admin'),
        }),
        body: banner.canConfigureModel
          ? grokText('请先配置至少一个模型服务和默认路由，Host 才能开始对话。', 'Configure a model provider and default route so the Host can start chatting.')
          : grokText('当前设备无权直接修改模型配置，请使用管理员密码配对或在 Host 管理后台配置。', 'This device cannot configure models directly. Pair with the admin password or configure it in Host Admin.'),
        dismiss: {
          kind: 'close',
          label: grokText('暂不提示', 'Dismiss'),
          onDismiss: () => setBanner(prev => ({ ...prev, dismissed: true })),
        },
        role: 'status',
        sentiment: 'warning',
        style: yXr?.passThrough,
        title: grokText('尚未配置对话模型', 'No chat model configured'),
      }),
    }),
  });
  const container = (typeof Yt === 'function' ? Yt() : null) ?? globalThis.document?.body ?? null;
  return container && typeof BS?.createPortal === 'function' ? BS.createPortal(content, container) : content;
}

function RokModelConfigHost() {
  const [open, setOpen] = X.useState(() => Boolean(globalThis.window?.__rokLocalModelConfigRequested));
  X.useEffect(() => {
    if (globalThis.window) globalThis.window.__rokModelModalHostMounted = true;
    const onRequest = () => {
      if (globalThis.window) globalThis.window.__rokLocalModelConfigRequested = false;
      setOpen(true);
    };
    if (globalThis.window?.__rokLocalModelConfigRequested) onRequest();
    globalThis.window?.addEventListener?.('rokbot-local:model-config-request', onRequest);
    return () => {
      if (globalThis.window) globalThis.window.__rokModelModalHostMounted = false;
      globalThis.window?.removeEventListener?.('rokbot-local:model-config-request', onRequest);
    };
  }, []);
  if (!open) return null;
  return Z.jsx(X.Suspense, {
    fallback: null,
    children: Z.jsx(RokModelConfigModal, {
      open: true,
      onOpenChange: next => {
        if (!next && globalThis.window) globalThis.window.__rokLocalModelConfigRequested = false;
        setOpen(Boolean(next));
      },
      onSaved: () => globalThis.window?.dispatchEvent?.(new Event('rokbot-local:model-config-updated')),
    }),
  });
}

function GrokLocalSettings({ agent }) {
  const [filesOpen, setFilesOpen] = X.useState(false);
  const [error, setError] = X.useState('');
  const [saving, setSaving] = X.useState(false);
  const save = async fields => {
    setSaving(true); setError('');
    try { await window.localBot.updateProfile(agent.id, fields); }
    catch (failure) { setError(failure.message || grokText('保存失败，请重试。', 'Could not save. Try again.')); }
    finally { setSaving(false); }
  };
  const label = text => Z.jsx('div', { className: 'sand-1y1aw1k sand-jkvuk6 sand-mzvs34 sand-f159sx sand-1wm8ruf sand-10jubzo sand-1o0liin', children: text });
  const filesLabel = grokText('资料库文件', 'Library files');
  return Z.jsxs('div', { className: 'sand-agent-settings', style: { display: 'grid', gap: 12, marginTop: 20 }, children: [
    label(grokText('标题', 'Title')),
    Z.jsx(MPt, { ariaLabel: grokText('Bot 标题', 'Bot title'), initialValue: agent.title ?? '', placeholder: grokText('简短描述这个 Bot', 'Short description'), onCommit: title => save({ title }) }),
    label(grokText('指令', 'Instructions')),
    Z.jsx(IN, { ariaLabel: grokText('Bot 指令', 'Bot instructions'), isEditable: true, kind: 'description', value: agent.description ?? '', placeholder: grokText('这个 Bot 应遵循的指令', 'Instructions for this Bot'), onCommit: description => save({ description }) }),
    Z.jsx('button', { type: 'button', onClick: () => setFilesOpen(true), style: { border: '1px solid currentColor', borderRadius: 8, padding: '10px 12px', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' }, children: filesLabel }),
    saving ? Z.jsx('p', { role: 'status', children: grokText('正在保存…', 'Saving…') }) : null,
    error ? Z.jsx('p', { role: 'alert', style: { color: '#f09b94' }, children: error }) : null,
    filesOpen ? Z.jsxs(Pw.Root, { open: true, onOpenChange: setFilesOpen, size: 'lg', 'aria-label': filesLabel, children: [
      Z.jsx(Pw.Header, { children: Z.jsx(Pw.Title, { children: filesLabel }) }),
      Z.jsx(Pw.CloseButton, {}),
      Z.jsx(Pw.Body, { children: Z.jsx(X.Suspense, {
        fallback: Z.jsx('p', { role: 'status', children: grokText('正在读取资料库…', 'Loading library…') }),
        children: Z.jsx(GrokLibraryFiles, { agent }) }) }),
    ] }) : null,
  ] });
}

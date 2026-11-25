
// Appended to the original 1.2.3 General settings module. $, Q, q, gn, Ft, gr,
// Vn and X are its JSX runtime, React, button, toggle, dialog parts, account
// card styles, section and row. The dialogs reuse the original modal parts.
function GrokAccountHost() {
  const [host, setHost] = Q.useState('RokBot Host');
  Q.useEffect(() => {
    const apply = status => setHost(status?.profile?.hostName || 'RokBot Host');
    void window.localBot.connectionStatus().then(apply).catch(() => {});
    return window.localBot.onConnectionChanged(apply);
  }, []);
  return host;
}
const grokInputClass = 'sand-9f619 sand-h8yej3 sand-dj266r sand-14z9mp sand-at24cr sand-1lziwak sand-1yrsyyn sand-2vl965 sand-10b6aqq sand-e2zdcy sand-mkeg23 sand-1y0btm7 sand-17tbahu sand-vk9egn sand-ur7f20 sand-10e981r sand-tyxrsu sand-jb2p0i sand-fc7y3v sand-1yxxptd sand-1t137rt sand-1h7ufjq';
const grokConnectionStyles = `
.grok-host-dialog{width:min(440px,calc(100vw - 32px))!important;max-width:calc(100vw - 32px)!important;height:auto!important;max-height:calc(100vh - 32px);overflow:auto}
.grok-host-dialog .grok-host-content{padding:30px;min-width:0;display:grid;gap:24px}
.grok-host-dialog header{display:grid;gap:10px;text-align:left}
.grok-host-dialog .grok-host-brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.grok-host-dialog .grok-host-brand img{display:block;width:44px;height:44px}
.grok-host-dialog .sand-dialog__title{font-size:24px;line-height:1.25;letter-spacing:-.45px;text-align:left}
.grok-host-identity{display:flex;align-items:center;gap:16px;min-width:0;padding:2px 0 4px}
.grok-host-avatar{width:64px;height:64px;border-radius:50%;flex:0 0 64px;object-fit:cover;background:color-mix(in srgb,currentColor 7%,transparent)}
.grok-host-avatar-fallback{display:grid;place-items:center;font-size:25px;font-weight:500}
.grok-host-person{min-width:0;display:grid;gap:7px}
.grok-host-person strong{font-size:21px;line-height:1.25;letter-spacing:-.4px;font-weight:550;overflow-wrap:anywhere}
.grok-host-person span{font-size:12px;opacity:.5}
.grok-host-details{padding:16px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);border-radius:14px;display:grid;gap:14px;min-width:0}
.grok-host-detail{display:flex;align-items:baseline;justify-content:space-between;gap:18px;min-width:0;font-size:13px;line-height:1.5}
.grok-host-detail>span:first-child{opacity:.55;flex-shrink:0}
.grok-host-detail>span:last-child{text-align:right;overflow-wrap:anywhere;min-width:0}
.grok-host-status{display:inline-flex;align-items:center;gap:7px}
.grok-host-status:before{content:'';width:6px;height:6px;border-radius:50%;background:#b49a60;flex-shrink:0}
.grok-host-status[data-online=true]:before{background:#62ad87}
.grok-host-paired-actions{justify-content:space-between!important;margin-top:2px!important}
.grok-host-fields{display:grid;gap:20px;min-width:0}
.grok-host-fields label{display:grid;gap:8px;font-size:13px;min-width:0}
.grok-host-fields input,.grok-host-fields select{min-width:0;width:100%;height:44px;padding:10px 12px;font-size:14px}
.grok-host-error{color:var(--sand-text-error,#df6464);margin:0;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.grok-host-success{color:#62ad87;margin:0;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.grok-host-hint{opacity:.7;margin:0;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.grok-host-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:0;flex-wrap:wrap}
.grok-account-name{display:inline-flex;align-items:center;gap:8px;max-width:100%;width:fit-content;border:0;padding:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.grok-account-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grok-account-name svg{width:14px;height:14px;flex:none;opacity:0;transition:opacity .12s}
.grok-account-name:hover svg,.grok-account-name:focus-visible svg{opacity:.5}
.grok-account-name:focus-visible{outline:2px solid currentColor;outline-offset:4px;border-radius:3px}
.rok-model-dialog{width:min(720px,calc(100vw - 32px))!important;max-width:calc(100vw - 32px)!important;height:auto!important;max-height:calc(100vh - 32px);overflow:auto}
.rok-model-dialog .grok-host-content{padding:26px;gap:18px}
.rok-model-section{padding:14px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);border-radius:12px;display:grid;gap:12px;min-width:0}
.rok-model-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.rok-model-section-head strong{font-size:14px;font-weight:600}
.rok-model-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,currentColor 4%,transparent);flex-wrap:wrap}
.rok-model-item-main{display:grid;gap:3px;min-width:0;flex:1}
.rok-model-item-main strong{font-size:13px;font-weight:550;overflow-wrap:anywhere}
.rok-model-item-main span{font-size:12px;opacity:.65;overflow-wrap:anywhere}
.rok-model-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rok-model-inline input,.rok-model-inline select{flex:1;min-width:140px;height:38px;padding:6px 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font-size:13px}
.rok-model-efforts{display:flex;flex-wrap:wrap;gap:8px}
.rok-model-efforts label{display:inline-flex!important;align-items:center;gap:5px;font-size:12px;cursor:pointer}
.rok-model-efforts input{width:auto!important;height:auto!important}
.rok-model-btn{border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;padding:6px 11px;background:transparent;color:inherit;font-size:12px;cursor:pointer}
.rok-model-btn:disabled{opacity:.45;cursor:not-allowed}
.rok-model-btn-primary{background:currentColor;color:#111}
@media(prefers-reduced-motion:reduce){.grok-account-name svg{transition:none}}
@media(max-width:480px){.grok-host-dialog .grok-host-content,.rok-model-dialog .grok-host-content{padding:22px 18px}.grok-host-dialog .sand-dialog__title{font-size:22px}}
`;
const grokBlockComposedEnter = composing => event => {
  if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current || event.keyCode === 229)) event.preventDefault();
};
function GrokAccountName({ className, name, onCommit }) {
  const [open, setOpen] = Q.useState(false), [value, setValue] = Q.useState(name);
  const [busy, setBusy] = Q.useState(false), [error, setError] = Q.useState('');
  const input = Q.useRef(null), composing = Q.useRef(false), submitting = Q.useRef(false);
  const edit = () => { setValue(name); setError(''); setOpen(true); };
  const save = async event => {
    event.preventDefault();
    if (composing.current || submitting.current || !value.trim()) return;
    submitting.current = true; setBusy(true); setError('');
    try { await onCommit(value.trim()); setOpen(false); }
    catch (failure) { setError(failure.message || grokText('保存失败，请重试。', 'Could not save. Try again.')); }
    finally { submitting.current = false; setBusy(false); }
  };
  return $.jsxs($.Fragment, { children: [
    $.jsx('style', { children: grokConnectionStyles }),
    $.jsxs('button', { type: 'button', className: `grok-account-name ${className}`, onClick: edit,
      'aria-label': grokText('修改账户名称', 'Edit account name'), children: [$.jsx('span', { children: name }),
        $.jsx('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true,
          children: $.jsx('path', { d: 'm16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5' }) })] }),
    open ? $.jsxs(Ft.Root, { open: true, onOpenChange: setOpen, size: 'sm',
      className: 'grok-host-dialog', 'aria-label': grokText('修改账户名称', 'Edit account name'), initialFocus: input, children: [
      $.jsx(Ft.CloseButton, {}),
      $.jsxs('form', { className: 'grok-host-content', onSubmit: save, children: [
        $.jsx('header', { children: $.jsx(Ft.Title, { children: grokText('修改账户名称', 'Edit account name') }) }),
        $.jsx('div', { className: 'grok-host-fields', children:
          $.jsxs('label', { children: [grokText('账户名称', 'Account name'), $.jsx('input', { ref: input, className: grokInputClass,
            value, maxLength: 80, required: true, disabled: busy, 'aria-label': grokText('账户名称', 'Account name'),
            onChange: event => setValue(event.currentTarget.value),
            onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
            onKeyDown: grokBlockComposedEnter(composing) })] }) }),
        error ? $.jsx('p', { className: 'grok-host-error', role: 'alert', children: error }) : null,
        $.jsxs('div', { className: 'grok-host-actions', children: [
          $.jsx(Ft.Action, { type: 'button', variant: 'secondary', onClick: () => setOpen(false), disabled: busy, children: grokText('取消', 'Cancel') }),
          $.jsx(Ft.Action, { type: 'submit', variant: 'primary', disabled: busy || !value.trim(), pending: busy, children: grokText('保存', 'Save') })] })] })] }) : null,
  ] });
}
function GrokRealtimeVoiceSettings() {
  const [enabled, setEnabled] = Q.useState(false), [busy, setBusy] = Q.useState(true), [error, setError] = Q.useState('');
  Q.useEffect(() => {
    let alive = true;
    void window.localBot.getVoicePreference().then(value => { if (alive) { setEnabled(value === true); setBusy(false); } })
      .catch(() => { if (alive) setError(grokText('无法读取设置', 'Could not load setting')); });
    const release = window.localBot.onVoicePreferenceChanged(value => { if (alive) setEnabled(value === true); });
    return () => { alive = false; release(); };
  }, []);
  const toggle = async () => {
    setBusy(true); setError('');
    try { setEnabled(await window.localBot.setVoicePreference(!enabled)); }
    catch { setError(grokText('无法保存设置', 'Could not save setting')); }
    finally { setBusy(false); }
  };
  const label = grokText('实时语音（实验性）', 'Realtime voice (Experimental)');
  return $.jsx(Vn, { anchorId: 'outside-settings', title: grokText('语音', 'Voice'), children: $.jsx(X, {
    anchorId: null, label, description: error || null, variant: 'card',
    children: $.jsx(gn, { isChecked: enabled, isDisabled: busy, label, onToggle: toggle, size: 'md' }),
  }) });
}

const ROK_MODEL_FORMATS = [
  ['openai', 'OpenAI Chat Completions'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic', 'Anthropic Messages'],
];
const ROK_DEFAULT_URLS = {
  openai: 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};
const ROK_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ROK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROK_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function rokEmptyRouting() {
  return { version: 1, providers: [], profiles: [], defaultRoute: null, botRoutes: {} };
}
function rokUid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
function rokParseTokenCount(value) {
  const source = String(value ?? '').trim();
  if (!source) return 0;
  const match = source.match(/^(\d+(?:\.\d*)?|\.\d+)\s*([km]?)$/i);
  if (!match) return NaN;
  const precision = { '': 0, k: 3, m: 6 }[match[2].toLowerCase()];
  const [whole, decimals = ''] = match[1].split('.');
  const fraction = decimals.replace(/0+$/, '');
  if (fraction.length > precision) return NaN;
  const number = Number((whole || '0') + fraction.padEnd(precision, '0'));
  return Number.isSafeInteger(number) && number <= 100_000_000 ? number : NaN;
}
function rokFormatTokenCount(value) {
  if (!value) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(6).replace(/\.?0+$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(3).replace(/\.?0+$/, '')}K`;
  return String(value);
}
function rokNormalizeApiError(resOrErr, fallback) {
  const status = resOrErr?.status ?? resOrErr?.httpStatus ?? null;
  const message = resOrErr?.error ?? resOrErr?.message ?? fallback;
  return { status, message: String(message || fallback) };
}
function rokEffortFor(profile, value) {
  return profile?.efforts?.includes(value) ? value : 'default';
}
function rokNormalizeRoute(route, profiles) {
  const byId = new Map(profiles.map(p => [p.id, p]));
  const primary = byId.get(route?.profileId) ?? profiles[0];
  if (!primary) return null;
  const seen = new Set([primary.id]);
  const fallbacks = [];
  for (const item of route?.fallbacks ?? []) {
    const p = byId.get(item?.profileId);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    fallbacks.push({ profileId: p.id, effort: rokEffortFor(p, item.effort) });
  }
  return { profileId: primary.id, effort: rokEffortFor(primary, route?.effort), fallbacks };
}
function rokUnwrapRouting(raw) {
  const cfg = raw?.config ?? raw ?? {};
  const providers = (cfg.providers ?? []).map(p => ({ ...p }));
  const profiles = (cfg.profiles ?? []).map(p => ({ ...p, efforts: [...(p.efforts ?? [])] }));
  const defaultRoute = cfg.defaultRoute ? rokNormalizeRoute(cfg.defaultRoute, profiles) : null;
  const botRoutes = {};
  for (const [agentId, route] of Object.entries(cfg.botRoutes ?? {})) {
    const normalized = rokNormalizeRoute(route, profiles);
    if (normalized) botRoutes[agentId] = normalized;
  }
  return { version: 1, providers, profiles, defaultRoute, botRoutes };
}
function rokReloadText(reload) {
  if (!reload?.status || reload.status === 'none') return '';
  if (reload.status === 'waiting' || reload.status === 'pending') {
    return grokText('已保存，正在等待 Host 应用配置…', 'Saved. Waiting for Host to apply configuration…');
  }
  if (reload.status === 'applied') {
    return grokText('配置已应用到 Host。', 'Configuration applied to Host.');
  }
  if (reload.status === 'error') {
    return reload.error || reload.message || grokText('Host 应用配置失败，请检查服务日志。', 'Host failed to apply configuration.');
  }
  return '';
}

function RokModelConfigModal({ open, onOpenChange, onSaved }) {
  const [loading, setLoading] = Q.useState(true);
  const [busy, setBusy] = Q.useState(false);
  const [config, setConfig] = Q.useState(rokEmptyRouting);
  const [pendingKeys, setPendingKeys] = Q.useState({});
  const [legacyRouting, setLegacyRouting] = Q.useState(false);
  const [canConfigure, setCanConfigure] = Q.useState(true);
  const [authStatus, setAuthStatus] = Q.useState(null);
  const [reload, setReload] = Q.useState(null);
  const [error, setError] = Q.useState('');
  const [notice, setNotice] = Q.useState('');
  const [providerForm, setProviderForm] = Q.useState(null);
  const [profileForm, setProfileForm] = Q.useState(null);
  const [botForm, setBotForm] = Q.useState(null);
  const [catalogBusy, setCatalogBusy] = Q.useState(false);
  const [testBusyId, setTestBusyId] = Q.useState('');
  const [testResult, setTestResult] = Q.useState(null);

  const aliveRef = Q.useRef(Boolean(open));
  const openRef = Q.useRef(Boolean(open));
  openRef.current = Boolean(open);
  const pollTokenRef = Q.useRef(0);
  const openSessionRef = Q.useRef(0);
  const pollTimerRef = Q.useRef(null);
  const onSavedRef = Q.useRef(onSaved);
  onSavedRef.current = onSaved;

  const stopPolling = Q.useCallback(() => {
    pollTokenRef.current += 1;
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const schedulePoll = Q.useCallback((attempt = 0) => {
    stopPolling();
    if (!aliveRef.current || !openRef.current || attempt >= 60) return;
    const myToken = pollTokenRef.current;
    pollTimerRef.current = setTimeout(async () => {
      pollTimerRef.current = null;
      if (!aliveRef.current || !openRef.current || pollTokenRef.current !== myToken) return;
      const getModelConfig = globalThis.window?.localBot?.getModelConfig;
      if (typeof getModelConfig !== 'function') return;
      try {
        const res = await getModelConfig();
        if (!aliveRef.current || !openRef.current || pollTokenRef.current !== myToken) return;
        if (!res || res.ok === false) {
          const err = rokNormalizeApiError(res, grokText('无法读取配置状态', 'Failed to refresh status'));
          setError(err.message);
          return;
        }
        const nextReload = res.reload ?? null;
        setReload(nextReload);
        if (nextReload?.status === 'applied') {
          setNotice(rokReloadText(nextReload));
          setError('');
          onSavedRef.current?.();
          globalThis.window?.dispatchEvent?.(new Event('rokbot-local:model-config-updated'));
        } else if (nextReload?.status === 'error') {
          setError(rokReloadText(nextReload));
          setNotice('');
        } else if (nextReload?.status === 'waiting' || nextReload?.status === 'pending') {
          setNotice(rokReloadText(nextReload));
          schedulePoll(attempt + 1);
        }
      } catch (failure) {
        if (!aliveRef.current || !openRef.current || pollTokenRef.current !== myToken) return;
        const err = rokNormalizeApiError(failure, grokText('轮询配置状态失败', 'Failed to poll reload status'));
        setError(err.message);
      }
    }, 2000);
  }, [stopPolling]);

  const load = Q.useCallback(async () => {
    stopPolling();
    const myToken = pollTokenRef.current;
    if (!aliveRef.current || !openRef.current) return;
    const api = globalThis.window?.localBot;
    if (!api?.getModelConfig) {
      setLoading(false);
      setCanConfigure(false);
      setError(grokText('当前客户端版本不支持 App 内模型配置。', 'In-app model configuration is unavailable in this client.'));
      return;
    }
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const statusRes = typeof api.getLocalStatus === 'function' ? await api.getLocalStatus().catch(() => null) : null;
      if (!aliveRef.current || !openRef.current || pollTokenRef.current !== myToken) return;
      if (statusRes && statusRes.ok !== false && statusRes.canConfigureModel === false) {
        setCanConfigure(false);
        setAuthStatus(403);
      }
      const res = await api.getModelConfig();
      if (!aliveRef.current || !openRef.current || pollTokenRef.current !== myToken) return;
      if (!res || res.ok === false) {
        const err = rokNormalizeApiError(res, grokText('读取模型配置失败', 'Could not load model configuration'));
        setAuthStatus(err.status);
        if (err.status === 401) {
          setCanConfigure(false);
          setError(grokText('设备凭证已失效，请重新配对后再试。', 'Device credentials expired. Please pair again.'));
        } else if (err.status === 403) {
          setCanConfigure(false);
          setError(err.message || grokText('当前设备无权修改模型配置，请使用管理员密码配对或在 Host 管理后台配置。', 'This device is not authorized to configure models. Pair with the admin password or use Host Admin.'));
        } else {
          setError(err.message);
        }
        setLoading(false);
        return;
      }
      const allowed = res.canConfigureModel !== false && statusRes?.canConfigureModel !== false;
      setCanConfigure(allowed);
      setAuthStatus(allowed ? null : 403);
      setLegacyRouting(res.routingMigrated === true);
      setConfig(rokUnwrapRouting(res));
      setPendingKeys({});
      const nextReload = res.reload ?? null;
      setReload(nextReload);
      if (nextReload?.status === 'waiting' || nextReload?.status === 'pending') {
        setLoading(false);
        setNotice(rokReloadText(nextReload));
        schedulePoll(0);
      } else if (nextReload?.status === 'error') {
        setError(rokReloadText(nextReload));
      }
    } catch (failure) {
      if (!aliveRef.current || !openRef.current || pollTokenRef.current !== myToken) return;
      const err = rokNormalizeApiError(failure, grokText('读取模型配置失败', 'Could not load model configuration'));
      setAuthStatus(err.status);
      if (err.status === 401) {
        setCanConfigure(false);
        setError(grokText('设备凭证已失效，请重新配对后再试。', 'Device credentials expired. Please pair again.'));
      } else if (err.status === 403) {
        setCanConfigure(false);
        setError(err.message || grokText('当前设备无权修改模型配置。', 'This device is not authorized to configure models.'));
      } else {
        setError(err.message);
      }
    } finally {
      if (aliveRef.current && openRef.current && pollTokenRef.current === myToken) setLoading(false);
    }
  }, [schedulePoll, stopPolling]);

  Q.useEffect(() => {
    openSessionRef.current += 1;
    aliveRef.current = Boolean(open);
    stopPolling();
    setBusy(false);
    setCatalogBusy(false);
    setTestBusyId('');
    if (open) {
      setProviderForm(null);
      setProfileForm(null);
      setBotForm(null);
      setTestResult(null);
      void load();
    }
    return () => {
      aliveRef.current = false;
      openSessionRef.current += 1;
      stopPolling();
    };
  }, [open, load, stopPolling]);

  if (!open) return null;

  const providerHasKey = provider => Boolean(pendingKeys[provider.id] || provider.hasApiKey);
  const serializedProvider = provider => ({
    id: provider.id,
    name: provider.name,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKey: pendingKeys[provider.id] ?? '',
  });
  const providerById = id => config.providers.find(p => p.id === id);
  const profileById = id => config.profiles.find(p => p.id === id);

  const buildPayload = ({ requireComplete = true, includeLegacy = legacyRouting, overrideProfile } = {}) => {
    const providers = config.providers;
    const profiles = overrideProfile
      ? [...config.profiles.filter(p => p.id !== overrideProfile.id), overrideProfile]
      : config.profiles;
    if (requireComplete) {
      if (!providers.length) throw new Error(grokText('请先添加至少一个模型服务。', 'Add at least one model provider first.'));
      if (!profiles.length) throw new Error(grokText('请先添加至少一个模型档案。', 'Add at least one model profile first.'));
      if (!config.defaultRoute) throw new Error(grokText('请设置默认路由。', 'Configure the default route.'));
    }
    for (const provider of providers) {
      if (!providerHasKey(provider)) {
        throw new Error(grokText(`请填写“${provider.name}”的 API Key。`, `API Key is required for ${provider.name}.`));
      }
    }
    const defaultRoute = rokNormalizeRoute(config.defaultRoute ?? (profiles[0] ? { profileId: profiles[0].id, effort: 'default', fallbacks: [] } : null), profiles);
    const botRoutes = {};
    for (const [agentId, route] of Object.entries(config.botRoutes)) {
      const normalized = rokNormalizeRoute(route, profiles);
      if (normalized) botRoutes[agentId] = normalized;
    }
    return {
      version: 1,
      ...(includeLegacy ? { migrateLegacyRouting: true } : {}),
      providers: providers.map(serializedProvider),
      profiles: profiles.map(profile => ({
        id: profile.id,
        name: profile.name,
        providerId: profile.providerId,
        model: profile.model,
        efforts: [...(profile.efforts ?? [])],
        contextWindowTokens: profile.contextWindowTokens ?? 0,
        summaryThresholdTokens: profile.summaryThresholdTokens ?? 0,
      })),
      defaultRoute,
      botRoutes,
    };
  };

  const openNewProvider = existing => {
    setError('');
    setProviderForm(existing ? {
      isNew: false,
      id: existing.id,
      name: existing.name,
      apiFormat: existing.apiFormat,
      baseUrl: existing.baseUrl,
      apiKey: pendingKeys[existing.id] ?? '',
      hasApiKey: Boolean(existing.hasApiKey),
    } : {
      isNew: true,
      id: rokUid('provider'),
      name: '',
      apiFormat: 'openai',
      baseUrl: ROK_DEFAULT_URLS.openai,
      apiKey: '',
      hasApiKey: false,
    });
  };

  const commitProviderForm = event => {
    event?.preventDefault?.();
    if (!providerForm) return;
    const id = providerForm.id.trim();
    const name = providerForm.name.trim();
    const baseUrl = providerForm.baseUrl.trim().replace(/\/$/, '');
    const apiKey = providerForm.apiKey.trim();
    if (!ROK_ID_RE.test(id)) { setError(grokText('服务 ID 无效。', 'Invalid provider ID.')); return; }
    if (!name) { setError(grokText('请填写服务名称。', 'Provider name is required.')); return; }
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('invalid');
      }
    } catch {
      setError(grokText('请填写有效的 http(s) Base URL。', 'Enter a valid http(s) Base URL.'));
      return;
    }
    const existingHasKey = Boolean(providerForm.hasApiKey || pendingKeys[id]);
    if (!apiKey && !existingHasKey) {
      setError(grokText('新建模型服务必须填写 API Key。', 'API Key is required for a new provider.'));
      return;
    }
    setError('');
    if (apiKey) setPendingKeys(prev => ({ ...prev, [id]: apiKey }));
    const nextProvider = {
      id,
      name,
      apiFormat: providerForm.apiFormat,
      baseUrl,
      hasApiKey: existingHasKey || Boolean(apiKey),
    };
    setConfig(prev => ({
      ...prev,
      providers: [...prev.providers.filter(p => p.id !== id), nextProvider],
    }));
    setProviderForm(null);
  };

  const deleteProvider = id => {
    if (config.profiles.some(p => p.providerId === id)) {
      setError(grokText('请先移除或修改引用此服务的模型档案。', 'Remove or reassign profiles using this provider first.'));
      return;
    }
    setError('');
    setPendingKeys(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setConfig(prev => ({ ...prev, providers: prev.providers.filter(p => p.id !== id) }));
  };

  const openNewProfile = existing => {
    if (!config.providers.length) {
      setError(grokText('请先添加至少一个模型服务。', 'Add a provider first.'));
      return;
    }
    setError('');
    setProfileForm(existing ? {
      isNew: false,
      id: existing.id,
      name: existing.name,
      providerId: existing.providerId,
      model: existing.model,
      efforts: [...(existing.efforts ?? [])],
      contextWindowTokensText: rokFormatTokenCount(existing.contextWindowTokens),
      summaryThresholdTokensText: rokFormatTokenCount(existing.summaryThresholdTokens),
      catalogModels: [],
      catalogMessage: '',
    } : {
      isNew: true,
      id: rokUid('profile'),
      name: '',
      providerId: config.providers[0].id,
      model: '',
      efforts: [],
      contextWindowTokensText: '',
      summaryThresholdTokensText: '',
      catalogModels: [],
      catalogMessage: '',
    });
  };

  const fetchCatalog = async () => {
    if (!profileForm || !aliveRef.current || !openRef.current) return;
    const provider = providerById(profileForm.providerId);
    if (!provider) { setError(grokText('请先选择模型服务。', 'Select a provider first.')); return; }
    const mySession = openSessionRef.current;
    setCatalogBusy(true);
    setError('');
    try {
      const res = await window.localBot.fetchModelCatalog({ provider: serializedProvider(provider) });
      if (!aliveRef.current || !openRef.current || openSessionRef.current !== mySession) return;
      if (!res || res.ok === false) {
        const err = rokNormalizeApiError(res, grokText('同步模型列表失败', 'Failed to fetch model catalog'));
        if (err.status === 401 || err.status === 403) setCanConfigure(false);
        setError(err.message);
        return;
      }
      const models = Array.isArray(res.models) ? res.models : [];
      setProfileForm(prev => {
        if (!prev) return prev;
        const matched = models.find(m => m.id === prev.model);
        return {
          ...prev,
          catalogModels: models,
          catalogMessage: grokText(`已同步 ${models.length} 个模型`, `Fetched ${models.length} models`),
          ...(matched?.efforts ? { efforts: [...matched.efforts] } : {}),
          ...(matched && !prev.contextWindowTokensText && matched.contextWindowTokens > 0
            ? { contextWindowTokensText: rokFormatTokenCount(matched.contextWindowTokens), summaryThresholdTokensText: rokFormatTokenCount(matched.summaryThresholdTokens ?? 0) }
            : {}),
        };
      });
    } catch (failure) {
      if (!aliveRef.current || !openRef.current || openSessionRef.current !== mySession) return;
      const err = rokNormalizeApiError(failure, grokText('同步模型列表失败', 'Failed to fetch model catalog'));
      if (err.status === 401 || err.status === 403) setCanConfigure(false);
      setError(err.message);
    } finally {
      if (aliveRef.current && openRef.current && openSessionRef.current === mySession) setCatalogBusy(false);
    }
  };

  const commitProfileForm = event => {
    event?.preventDefault?.();
    if (!profileForm) return;
    const name = profileForm.name.trim();
    const model = profileForm.model.trim();
    const contextWindowTokens = rokParseTokenCount(profileForm.contextWindowTokensText);
    const summaryThresholdTokens = rokParseTokenCount(profileForm.summaryThresholdTokensText);
    if (!name) { setError(grokText('请填写档案名称。', 'Profile name is required.')); return; }
    if (!model) { setError(grokText('请填写模型 ID。', 'Model ID is required.')); return; }
    if (!Number.isFinite(contextWindowTokens) || !Number.isFinite(summaryThresholdTokens)) {
      setError(grokText('请输入 0–100M 的整数 Token 数（如 1M、400K）。', 'Enter integer tokens 0–100M (e.g. 1M, 400K).'));
      return;
    }
    if (summaryThresholdTokens > 0 && (!contextWindowTokens || summaryThresholdTokens >= contextWindowTokens)) {
      setError(grokText('摘要阈值必须小于上下文容量。', 'Summary threshold must be less than context window.'));
      return;
    }
    setError('');
    const nextProfile = {
      id: profileForm.id,
      name,
      providerId: profileForm.providerId,
      model,
      efforts: ROK_EFFORTS.filter(level => profileForm.efforts.includes(level)),
      contextWindowTokens,
      summaryThresholdTokens,
    };
    setConfig(prev => {
      const profiles = [...prev.profiles.filter(p => p.id !== nextProfile.id), nextProfile];
      const defaultRoute = prev.defaultRoute
        ? rokNormalizeRoute(prev.defaultRoute, profiles)
        : { profileId: nextProfile.id, effort: 'default', fallbacks: [] };
      const botRoutes = {};
      for (const [agentId, route] of Object.entries(prev.botRoutes)) {
        const normalized = rokNormalizeRoute(route, profiles);
        if (normalized) botRoutes[agentId] = normalized;
      }
      return { ...prev, profiles, defaultRoute, botRoutes };
    });
    setProfileForm(null);
  };

  const deleteProfile = id => {
    const usedInDefault = config.defaultRoute?.profileId === id || config.defaultRoute?.fallbacks?.some(f => f.profileId === id);
    const usedBots = Object.entries(config.botRoutes)
      .filter(([, r]) => r.profileId === id || r.fallbacks?.some(f => f.profileId === id))
      .map(([agentId]) => agentId);
    if (usedInDefault || usedBots.length) {
      setError(grokText('请先从默认路由或 Bot 路由中移除此模型档案。', 'Remove this profile from default or bot routes first.'));
      return;
    }
    setError('');
    setConfig(prev => ({ ...prev, profiles: prev.profiles.filter(p => p.id !== id) }));
  };

  const runProfileTest = async (profile, { forceMigrate = false } = {}) => {
    if (!aliveRef.current || !openRef.current) return;
    const mySession = openSessionRef.current;
    setTestBusyId(profile.id);
    setTestResult(null);
    setError('');
    try {
      const payload = buildPayload({ requireComplete: false, includeLegacy: legacyRouting || forceMigrate, overrideProfile: profile });
      const res = await window.localBot.testModelConfig({ ...payload, profileId: profile.id });
      if (!aliveRef.current || !openRef.current || openSessionRef.current !== mySession) return;
      if (!res || res.ok === false) {
        const err = rokNormalizeApiError(res, grokText('模型测试失败', 'Model test failed'));
        if (err.status === 409 && !forceMigrate) {
          setLegacyRouting(true);
          await runProfileTest(profile, { forceMigrate: true });
          return;
        }
        if (err.status === 401 || err.status === 403) setCanConfigure(false);
        setTestResult({ ok: false, message: err.message });
        return;
      }
      const msg = res.message || grokText(
        `连接成功：${res.model ?? profile.model}（${res.latencyMs ?? 0} ms）— ${res.reply ?? 'OK'}`,
        `Connected: ${res.model ?? profile.model} (${res.latencyMs ?? 0} ms) — ${res.reply ?? 'OK'}`,
      );
      setTestResult({ ok: true, message: msg });
    } catch (failure) {
      if (!aliveRef.current || !openRef.current || openSessionRef.current !== mySession) return;
      const err = rokNormalizeApiError(failure, grokText('模型测试失败', 'Model test failed'));
      if (err.status === 409 && !forceMigrate) {
        setLegacyRouting(true);
        await runProfileTest(profile, { forceMigrate: true });
        return;
      }
      if (err.status === 401 || err.status === 403) setCanConfigure(false);
      setTestResult({ ok: false, message: err.message });
    } finally {
      if (aliveRef.current && openRef.current && openSessionRef.current === mySession) setTestBusyId('');
    }
  };

  const openBotRouteForm = existingAgentId => {
    if (!config.profiles.length) {
      setError(grokText('请先创建模型档案。', 'Create a model profile first.'));
      return;
    }
    setError('');
    const current = existingAgentId ? config.botRoutes[existingAgentId] : null;
    const base = rokNormalizeRoute(current ?? config.defaultRoute ?? { profileId: config.profiles[0].id, effort: 'default', fallbacks: [] }, config.profiles);
    setBotForm({
      isNew: !existingAgentId,
      agentId: existingAgentId ?? '',
      profileId: base?.profileId ?? config.profiles[0].id,
      effort: base?.effort ?? 'default',
      fallbacks: base?.fallbacks ?? [],
    });
  };

  const commitBotForm = event => {
    event?.preventDefault?.();
    if (!botForm) return;
    const agentId = botForm.agentId.trim();
    if (!ROK_AGENT_ID_RE.test(agentId)) {
      setError(grokText('Bot ID 格式无效。', 'Invalid Bot ID.'));
      return;
    }
    const route = rokNormalizeRoute({ profileId: botForm.profileId, effort: botForm.effort, fallbacks: botForm.fallbacks }, config.profiles);
    if (!route) return;
    setError('');
    setConfig(prev => ({
      ...prev,
      botRoutes: { ...prev.botRoutes, [agentId]: route },
    }));
    setBotForm(null);
  };

  const removeBotRoute = agentId => {
    setConfig(prev => {
      const next = { ...prev.botRoutes };
      delete next[agentId];
      return { ...prev, botRoutes: next };
    });
  };

  const saveAll = async ({ forceMigrate = false } = {}) => {
    if (!aliveRef.current || !openRef.current) return;
    stopPolling();
    const mySession = openSessionRef.current;
    setError('');
    setNotice('');
    let payload;
    try {
      payload = buildPayload({ requireComplete: true, includeLegacy: legacyRouting || forceMigrate });
    } catch (validationError) {
      setError(validationError.message);
      return;
    }
    setBusy(true);
    try {
      const res = await window.localBot.updateModelConfig(payload);
      if (!aliveRef.current || !openRef.current || openSessionRef.current !== mySession) return;
      if (!res || res.ok === false) {
        const err = rokNormalizeApiError(res, grokText('保存模型配置失败', 'Failed to save model configuration'));
        if (err.status === 409 && !forceMigrate) {
          setLegacyRouting(true);
          setBusy(false);
          await saveAll({ forceMigrate: true });
          return;
        }
        if (err.status === 401 || err.status === 403) setCanConfigure(false);
        setError(err.message);
        return;
      }
      setLegacyRouting(res.routingMigrated === true);
      setConfig(rokUnwrapRouting(res));
      setPendingKeys({});
      const nextReload = res.reload ?? { status: 'applied' };
      setReload(nextReload);
      if (nextReload.status === 'waiting' || nextReload.status === 'pending') {
        setNotice(rokReloadText(nextReload));
        schedulePoll(0);
      } else if (nextReload.status === 'error') {
        setError(rokReloadText(nextReload));
      } else {
        setNotice(rokReloadText(nextReload) || grokText('配置已保存并应用。', 'Configuration saved and applied.'));
        onSavedRef.current?.();
        globalThis.window?.dispatchEvent?.(new Event('rokbot-local:model-config-updated'));
      }
    } catch (failure) {
      if (!aliveRef.current || !openRef.current || openSessionRef.current !== mySession) return;
      const err = rokNormalizeApiError(failure, grokText('保存模型配置失败', 'Failed to save model configuration'));
      if (err.status === 409 && !forceMigrate) {
        setLegacyRouting(true);
        setBusy(false);
        await saveAll({ forceMigrate: true });
        return;
      }
      if (err.status === 401 || err.status === 403) setCanConfigure(false);
      setError(err.message);
    } finally {
      if (aliveRef.current && openRef.current && openSessionRef.current === mySession) setBusy(false);
    }
  };

  const defaultProfile = config.defaultRoute ? profileById(config.defaultRoute.profileId) : null;
  const availableDefaultFallbacks = config.defaultRoute
    ? config.profiles.filter(p => p.id !== config.defaultRoute.profileId && !config.defaultRoute.fallbacks.some(f => f.profileId === p.id))
    : [];

  return $.jsxs(Ft.Root, {
    open: true,
    onOpenChange: onOpenChange,
    size: 'lg',
    className: 'grok-host-dialog rok-model-dialog',
    'aria-label': grokText('模型配置', 'Model configuration'),
    children: [
      $.jsx('style', { children: grokConnectionStyles }),
      $.jsx(Ft.CloseButton, {}),
      $.jsxs('section', {
        className: 'grok-host-content',
        children: [
          $.jsxs('header', {
            children: [
              $.jsx(Ft.Title, { children: grokText('对话模型配置', 'Model configuration') }),
              legacyRouting ? $.jsx('p', {
                className: 'grok-host-hint',
                role: 'status',
                children: grokText('检测到旧版模型配置，保存后将迁移为多服务路由配置。', 'Legacy model config detected; saving will migrate it to multi-provider routing.'),
              }) : null,
            ],
          }),
          loading ? $.jsx('p', { role: 'status', children: grokText('正在读取模型配置…', 'Loading model configuration…') }) : $.jsxs($.Fragment, {
            children: [
              !canConfigure ? $.jsxs('div', {
                className: 'rok-model-section',
                children: [
                  $.jsx('p', {
                    className: 'grok-host-error',
                    role: 'alert',
                    children: error || (authStatus === 401
                      ? grokText('设备凭证已失效，请重新配对后再试。', 'Device credentials expired. Please pair again.')
                      : grokText('当前设备无权修改模型配置，请使用管理员密码配对或在 Host 管理后台配置。', 'This device cannot modify model settings. Pair with the admin password or open Host Admin.')),
                  }),
                  $.jsx('div', {
                    className: 'grok-host-actions',
                    children: $.jsx('button', {
                      type: 'button',
                      className: 'rok-model-btn',
                      onClick: () => globalThis.window?.localBot?.openManagement?.(),
                      children: grokText('打开管理后台', 'Open Host Admin'),
                    }),
                  }),
                ],
              }) : null,

              // Providers Section
              $.jsxs('div', {
                className: 'rok-model-section',
                children: [
                  $.jsxs('div', {
                    className: 'rok-model-section-head',
                    children: [
                      $.jsx('strong', { children: grokText('模型服务 (Providers)', 'Providers') }),
                      $.jsx('button', {
                        type: 'button',
                        className: 'rok-model-btn',
                        disabled: !canConfigure || busy,
                        onClick: () => openNewProvider(null),
                        children: grokText('添加服务', 'Add provider'),
                      }),
                    ],
                  }),
                  !config.providers.length ? $.jsx('p', {
                    className: 'grok-host-hint',
                    children: grokText('尚未添加模型服务。', 'No providers configured yet.'),
                  }) : config.providers.map(provider => $.jsxs('div', {
                    className: 'rok-model-item',
                    children: [
                      $.jsxs('div', {
                        className: 'rok-model-item-main',
                        children: [
                          $.jsx('strong', { children: provider.name }),
                          $.jsx('span', {
                            children: `${provider.apiFormat} · ${provider.baseUrl} · ${providerHasKey(provider) ? grokText('已配置 Key', 'Key saved') : grokText('缺少 Key', 'Key required')}`,
                          }),
                        ],
                      }),
                      $.jsxs('div', {
                        className: 'rok-model-inline',
                        children: [
                          $.jsx('button', {
                            type: 'button',
                            className: 'rok-model-btn',
                            disabled: !canConfigure || busy,
                            onClick: () => openNewProvider(provider),
                            children: grokText('编辑', 'Edit'),
                          }),
                          $.jsx('button', {
                            type: 'button',
                            className: 'rok-model-btn',
                            disabled: !canConfigure || busy,
                            onClick: () => deleteProvider(provider.id),
                            children: grokText('删除', 'Delete'),
                          }),
                        ],
                      }),
                    ],
                  }, provider.id)),
                  providerForm ? $.jsxs('form', {
                    className: 'grok-host-fields',
                    onSubmit: commitProviderForm,
                    children: [
                      $.jsxs('label', {
                        children: [
                          grokText('服务名称', 'Provider name'),
                          $.jsx('input', {
                            className: grokInputClass,
                            value: providerForm.name,
                            required: true,
                            placeholder: 'OpenAI / Anthropic / DeepSeek',
                            onChange: e => setProviderForm(prev => prev && ({ ...prev, name: e.currentTarget.value })),
                          }),
                        ],
                      }),
                      $.jsxs('label', {
                        children: [
                          grokText('接口格式', 'API format'),
                          $.jsx('select', {
                            className: grokInputClass,
                            value: providerForm.apiFormat,
                            onChange: e => {
                              const nextFmt = e.currentTarget.value;
                              setProviderForm(prev => {
                                if (!prev) return prev;
                                const prevDefault = ROK_DEFAULT_URLS[prev.apiFormat];
                                const nextUrl = (!prev.baseUrl || prev.baseUrl === prevDefault) ? (ROK_DEFAULT_URLS[nextFmt] ?? '') : prev.baseUrl;
                                return { ...prev, apiFormat: nextFmt, baseUrl: nextUrl };
                              });
                            },
                            children: ROK_MODEL_FORMATS.map(([val, label]) => $.jsx('option', { value: val, children: label }, val)),
                          }),
                        ],
                      }),
                      $.jsxs('label', {
                        children: [
                          'Base URL',
                          $.jsx('input', {
                            className: grokInputClass,
                            type: 'url',
                            value: providerForm.baseUrl,
                            required: true,
                            onChange: e => setProviderForm(prev => prev && ({ ...prev, baseUrl: e.currentTarget.value })),
                          }),
                        ],
                      }),
                      $.jsxs('label', {
                        children: [
                          'API Key',
                          $.jsx('input', {
                            className: grokInputClass,
                            type: 'password',
                            value: providerForm.apiKey,
                            placeholder: providerForm.hasApiKey
                              ? grokText('已保存，留空保留', 'Saved — leave blank to keep')
                              : grokText('输入 API Key', 'Enter API Key'),
                            onChange: e => setProviderForm(prev => prev && ({ ...prev, apiKey: e.currentTarget.value })),
                          }),
                        ],
                      }),
                      $.jsxs('div', {
                        className: 'grok-host-actions',
                        children: [
                          $.jsx('button', { type: 'button', className: 'rok-model-btn', onClick: () => setProviderForm(null), children: grokText('取消', 'Cancel') }),
                          $.jsx('button', { type: 'submit', className: 'rok-model-btn rok-model-btn-primary', children: grokText('确认服务', 'Apply provider') }),
                        ],
                      }),
                    ],
                  }) : null,
                ],
              }),

              // Profiles Section
              $.jsxs('div', {
                className: 'rok-model-section',
                children: [
                  $.jsxs('div', {
                    className: 'rok-model-section-head',
                    children: [
                      $.jsx('strong', { children: grokText('模型档案 (Profiles)', 'Model profiles') }),
                      $.jsx('button', {
                        type: 'button',
                        className: 'rok-model-btn',
                        disabled: !canConfigure || busy || !config.providers.length,
                        onClick: () => openNewProfile(null),
                        children: grokText('添加档案', 'Add profile'),
                      }),
                    ],
                  }),
                  !config.profiles.length ? $.jsx('p', {
                    className: 'grok-host-hint',
                    children: grokText('尚未添加模型档案。', 'No model profiles configured yet.'),
                  }) : config.profiles.map(profile => {
                    const provider = providerById(profile.providerId);
                    return $.jsxs('div', {
                      className: 'rok-model-item',
                      children: [
                        $.jsxs('div', {
                          className: 'rok-model-item-main',
                          children: [
                            $.jsx('strong', { children: `${profile.name} · ${profile.model}` }),
                            $.jsx('span', {
                              children: `${provider?.name ?? profile.providerId}${profile.efforts?.length ? ` · ${profile.efforts.join('/')}` : ''}${profile.contextWindowTokens ? ` · ${rokFormatTokenCount(profile.contextWindowTokens)}` : ''}`,
                            }),
                          ],
                        }),
                        $.jsxs('div', {
                          className: 'rok-model-inline',
                          children: [
                            $.jsx('button', {
                              type: 'button',
                              className: 'rok-model-btn',
                              disabled: !canConfigure || busy || Boolean(testBusyId),
                              onClick: () => void runProfileTest(profile),
                              children: testBusyId === profile.id ? grokText('测试中…', 'Testing…') : grokText('测试连接', 'Test'),
                            }),
                            $.jsx('button', {
                              type: 'button',
                              className: 'rok-model-btn',
                              disabled: !canConfigure || busy,
                              onClick: () => openNewProfile(profile),
                              children: grokText('编辑', 'Edit'),
                            }),
                            $.jsx('button', {
                              type: 'button',
                              className: 'rok-model-btn',
                              disabled: !canConfigure || busy,
                              onClick: () => deleteProfile(profile.id),
                              children: grokText('删除', 'Delete'),
                            }),
                          ],
                        }),
                      ],
                    }, profile.id);
                  }),
                  testResult ? $.jsx('p', {
                    className: testResult.ok ? 'grok-host-success' : 'grok-host-error',
                    role: testResult.ok ? 'status' : 'alert',
                    children: testResult.message,
                  }) : null,
                  profileForm ? $.jsxs('form', {
                    className: 'grok-host-fields',
                    onSubmit: commitProfileForm,
                    children: [
                      $.jsxs('label', {
                        children: [
                          grokText('档案名称', 'Profile name'),
                          $.jsx('input', {
                            className: grokInputClass,
                            value: profileForm.name,
                            required: true,
                            placeholder: 'GPT-5 / Claude Sonnet',
                            onChange: e => setProfileForm(prev => prev && ({ ...prev, name: e.currentTarget.value })),
                          }),
                        ],
                      }),
                      $.jsxs('label', {
                        children: [
                          grokText('模型服务', 'Provider'),
                          $.jsx('select', {
                            className: grokInputClass,
                            value: profileForm.providerId,
                            onChange: e => setProfileForm(prev => prev && ({ ...prev, providerId: e.currentTarget.value, catalogModels: [], catalogMessage: '' })),
                            children: config.providers.map(p => $.jsx('option', { value: p.id, children: p.name }, p.id)),
                          }),
                        ],
                      }),
                      $.jsxs('label', {
                        children: [
                          grokText('模型 ID', 'Model ID'),
                          $.jsxs('div', {
                            className: 'rok-model-inline',
                            children: [
                              $.jsx('input', {
                                value: profileForm.model,
                                required: true,
                                placeholder: 'gpt-4o / claude-sonnet-4-5',
                                onChange: e => setProfileForm(prev => prev && ({ ...prev, model: e.currentTarget.value })),
                              }),
                              $.jsx('button', {
                                type: 'button',
                                className: 'rok-model-btn',
                                disabled: catalogBusy || !canConfigure,
                                onClick: () => void fetchCatalog(),
                                children: catalogBusy ? grokText('同步中…', 'Fetching…') : grokText('同步模型', 'Fetch catalog'),
                              }),
                            ],
                          }),
                        ],
                      }),
                      profileForm.catalogModels.length > 0 ? $.jsxs('label', {
                        children: [
                          grokText('从同步列表选择', 'Select from catalog'),
                          $.jsxs('select', {
                            className: grokInputClass,
                            value: profileForm.catalogModels.some(m => m.id === profileForm.model) ? profileForm.model : '',
                            onChange: e => {
                              const modelId = e.currentTarget.value;
                              if (!modelId) return;
                              const entry = profileForm.catalogModels.find(m => m.id === modelId);
                              setProfileForm(prev => prev && ({
                                ...prev,
                                model: modelId,
                                ...(entry?.efforts ? { efforts: [...entry.efforts] } : {}),
                                ...(entry?.contextWindowTokens > 0
                                  ? { contextWindowTokensText: rokFormatTokenCount(entry.contextWindowTokens), summaryThresholdTokensText: rokFormatTokenCount(entry.summaryThresholdTokens ?? 0) }
                                  : {}),
                              }));
                            },
                            children: [
                              $.jsx('option', { value: '', children: grokText('选择模型…', 'Choose model…') }),
                              profileForm.catalogModels.map(m => $.jsx('option', { value: m.id, children: m.id }, m.id)),
                            ],
                          }),
                        ],
                      }) : null,
                      profileForm.catalogMessage ? $.jsx('p', { className: 'grok-host-hint', role: 'status', children: profileForm.catalogMessage }) : null,
                      $.jsxs('div', {
                        className: 'rok-model-efforts',
                        children: ROK_EFFORTS.map(level => $.jsxs('label', {
                          children: [
                            $.jsx('input', {
                              type: 'checkbox',
                              checked: profileForm.efforts.includes(level),
                              onChange: e => {
                                const checked = e.currentTarget.checked;
                                setProfileForm(prev => {
                                  if (!prev) return prev;
                                  const next = checked
                                    ? ROK_EFFORTS.filter(l => l === level || prev.efforts.includes(l))
                                    : prev.efforts.filter(l => l !== level);
                                  return { ...prev, efforts: next };
                                });
                              },
                            }),
                            level,
                          ],
                        }, level)),
                      }),
                      $.jsxs('div', {
                        className: 'rok-model-inline',
                        children: [
                          $.jsx('input', {
                            placeholder: grokText('上下文容量 (如 1M, 200K)', 'Context window (e.g. 1M)'),
                            value: profileForm.contextWindowTokensText,
                            onChange: e => setProfileForm(prev => prev && ({ ...prev, contextWindowTokensText: e.currentTarget.value })),
                          }),
                          $.jsx('input', {
                            placeholder: grokText('摘要阈值 (如 400K)', 'Summary threshold (e.g. 400K)'),
                            value: profileForm.summaryThresholdTokensText,
                            onChange: e => setProfileForm(prev => prev && ({ ...prev, summaryThresholdTokensText: e.currentTarget.value })),
                          }),
                        ],
                      }),
                      $.jsxs('div', {
                        className: 'grok-host-actions',
                        children: [
                          $.jsx('button', { type: 'button', className: 'rok-model-btn', onClick: () => setProfileForm(null), children: grokText('取消', 'Cancel') }),
                          $.jsx('button', { type: 'submit', className: 'rok-model-btn rok-model-btn-primary', children: grokText('确认档案', 'Apply profile') }),
                        ],
                      }),
                    ],
                  }) : null,
                ],
              }),

              // Default Route Section
              $.jsxs('div', {
                className: 'rok-model-section',
                children: [
                  $.jsx('div', { className: 'rok-model-section-head', children: $.jsx('strong', { children: grokText('默认路由 (Default route)', 'Default route') }) }),
                  !config.profiles.length || !config.defaultRoute ? $.jsx('p', {
                    className: 'grok-host-hint',
                    children: grokText('请先添加模型档案后设置默认路由。', 'Add a profile to configure the default route.'),
                  }) : $.jsxs($.Fragment, {
                    children: [
                      $.jsxs('div', {
                        className: 'rok-model-inline',
                        children: [
                          $.jsx('select', {
                            'aria-label': grokText('默认主模型', 'Default primary profile'),
                            disabled: !canConfigure || busy,
                            value: config.defaultRoute.profileId,
                            onChange: e => {
                              const nextProfileId = e.currentTarget.value;
                              const nextP = profileById(nextProfileId);
                              setConfig(prev => ({
                                ...prev,
                                defaultRoute: {
                                  profileId: nextProfileId,
                                  effort: rokEffortFor(nextP, prev.defaultRoute?.effort),
                                  fallbacks: (prev.defaultRoute?.fallbacks ?? []).filter(f => f.profileId !== nextProfileId),
                                },
                              }));
                            },
                            children: config.profiles.map(p => $.jsx('option', { value: p.id, children: `${p.name} (${p.model})` }, p.id)),
                          }),
                          $.jsxs('select', {
                            'aria-label': grokText('默认思考强度', 'Default effort'),
                            disabled: !canConfigure || busy,
                            value: config.defaultRoute.effort,
                            onChange: e => setConfig(prev => ({
                              ...prev,
                              defaultRoute: prev.defaultRoute ? { ...prev.defaultRoute, effort: e.currentTarget.value } : null,
                            })),
                            children: [
                              $.jsx('option', { value: 'default', children: grokText('模型默认', 'Default') }),
                              ...(defaultProfile?.efforts ?? []).map(level => $.jsx('option', { value: level, children: level }, level)),
                            ],
                          }),
                          $.jsx('button', {
                            type: 'button',
                            className: 'rok-model-btn',
                            disabled: !canConfigure || busy || !availableDefaultFallbacks.length,
                            onClick: () => {
                              const nextFb = availableDefaultFallbacks[0];
                              if (!nextFb) return;
                              setConfig(prev => ({
                                ...prev,
                                defaultRoute: prev.defaultRoute
                                  ? { ...prev.defaultRoute, fallbacks: [...prev.defaultRoute.fallbacks, { profileId: nextFb.id, effort: 'default' }] }
                                  : null,
                              }));
                            },
                            children: grokText('添加备用', 'Add fallback'),
                          }),
                        ],
                      }),
                      config.defaultRoute.fallbacks.map((fb, idx) => {
                        const fbProfile = profileById(fb.profileId);
                        return $.jsxs('div', {
                          className: 'rok-model-inline',
                          children: [
                            $.jsx('select', {
                              disabled: !canConfigure || busy,
                              value: fb.profileId,
                              onChange: e => {
                                const pid = e.currentTarget.value;
                                const nextP = profileById(pid);
                                setConfig(prev => {
                                  if (!prev.defaultRoute) return prev;
                                  const nextFallbacks = [...prev.defaultRoute.fallbacks];
                                  nextFallbacks[idx] = { profileId: pid, effort: rokEffortFor(nextP, fb.effort) };
                                  return { ...prev, defaultRoute: { ...prev.defaultRoute, fallbacks: nextFallbacks } };
                                });
                              },
                              children: config.profiles
                                .filter(p => p.id !== config.defaultRoute.profileId && (p.id === fb.profileId || !config.defaultRoute.fallbacks.some((other, oi) => oi !== idx && other.profileId === p.id)))
                                .map(p => $.jsx('option', { value: p.id, children: `${p.name} (${p.model})` }, p.id)),
                            }),
                            $.jsxs('select', {
                              disabled: !canConfigure || busy,
                              value: fb.effort,
                              onChange: e => setConfig(prev => {
                                if (!prev.defaultRoute) return prev;
                                const nextFallbacks = [...prev.defaultRoute.fallbacks];
                                nextFallbacks[idx] = { ...fb, effort: e.currentTarget.value };
                                return { ...prev, defaultRoute: { ...prev.defaultRoute, fallbacks: nextFallbacks } };
                              }),
                              children: [
                                $.jsx('option', { value: 'default', children: grokText('模型默认', 'Default') }),
                                ...(fbProfile?.efforts ?? []).map(level => $.jsx('option', { value: level, children: level }, level)),
                              ],
                            }),
                            $.jsx('button', {
                              type: 'button',
                              className: 'rok-model-btn',
                              disabled: !canConfigure || busy,
                              onClick: () => setConfig(prev => {
                                if (!prev.defaultRoute) return prev;
                                return { ...prev, defaultRoute: { ...prev.defaultRoute, fallbacks: prev.defaultRoute.fallbacks.filter((_, i) => i !== idx) } };
                              }),
                              children: grokText('移除', 'Remove'),
                            }),
                          ],
                        }, `${fb.profileId}-${idx}`);
                      }),
                    ],
                  }),
                ],
              }),

              // Bot Routes Section
              $.jsxs('div', {
                className: 'rok-model-section',
                children: [
                  $.jsxs('div', {
                    className: 'rok-model-section-head',
                    children: [
                      $.jsx('strong', { children: grokText('Bot 路由覆盖 (Bot routes)', 'Bot route overrides') }),
                      $.jsx('button', {
                        type: 'button',
                        className: 'rok-model-btn',
                        disabled: !canConfigure || busy || !config.profiles.length,
                        onClick: () => openBotRouteForm(null),
                        children: grokText('添加 Bot 路由', 'Add bot route'),
                      }),
                    ],
                  }),
                  Object.keys(config.botRoutes).length === 0 ? $.jsx('p', {
                    className: 'grok-host-hint',
                    children: grokText('所有 Bot 当前均使用默认路由。', 'All Bots currently use the default route.'),
                  }) : Object.entries(config.botRoutes).map(([agentId, route]) => {
                    const p = profileById(route.profileId);
                    return $.jsxs('div', {
                      className: 'rok-model-item',
                      children: [
                        $.jsxs('div', {
                          className: 'rok-model-item-main',
                          children: [
                            $.jsx('strong', { children: agentId }),
                            $.jsx('span', { children: `${p?.name ?? route.profileId} · ${route.effort}` }),
                          ],
                        }),
                        $.jsxs('div', {
                          className: 'rok-model-inline',
                          children: [
                            $.jsx('button', {
                              type: 'button',
                              className: 'rok-model-btn',
                              disabled: !canConfigure || busy,
                              onClick: () => openBotRouteForm(agentId),
                              children: grokText('编辑', 'Edit'),
                            }),
                            $.jsx('button', {
                              type: 'button',
                              className: 'rok-model-btn',
                              disabled: !canConfigure || busy,
                              onClick: () => removeBotRoute(agentId),
                              children: grokText('移除', 'Remove'),
                            }),
                          ],
                        }),
                      ],
                    }, agentId);
                  }),
                  botForm ? $.jsxs('form', {
                    className: 'grok-host-fields',
                    onSubmit: commitBotForm,
                    children: [
                      $.jsxs('label', {
                        children: [
                          'Bot ID',
                          $.jsx('input', {
                            className: grokInputClass,
                            value: botForm.agentId,
                            disabled: !botForm.isNew,
                            required: true,
                            placeholder: 'bot-alpha',
                            onChange: e => setBotForm(prev => prev && ({ ...prev, agentId: e.currentTarget.value })),
                          }),
                        ],
                      }),
                      $.jsxs('label', {
                        children: [
                          grokText('指定模型档案', 'Profile'),
                          $.jsx('select', {
                            className: grokInputClass,
                            value: botForm.profileId,
                            onChange: e => {
                              const pid = e.currentTarget.value;
                              const nextP = profileById(pid);
                              setBotForm(prev => prev && ({ ...prev, profileId: pid, effort: rokEffortFor(nextP, prev.effort) }));
                            },
                            children: config.profiles.map(p => $.jsx('option', { value: p.id, children: `${p.name} (${p.model})` }, p.id)),
                          }),
                        ],
                      }),
                      $.jsxs('label', {
                        children: [
                          grokText('思考强度', 'Effort'),
                          $.jsxs('select', {
                            className: grokInputClass,
                            value: botForm.effort,
                            onChange: e => setBotForm(prev => prev && ({ ...prev, effort: e.currentTarget.value })),
                            children: [
                              $.jsx('option', { value: 'default', children: grokText('模型默认', 'Default') }),
                              ...(profileById(botForm.profileId)?.efforts ?? []).map(level => $.jsx('option', { value: level, children: level }, level)),
                            ],
                          }),
                        ],
                      }),
                      $.jsxs('div', {
                        className: 'grok-host-actions',
                        children: [
                          $.jsx('button', { type: 'button', className: 'rok-model-btn', onClick: () => setBotForm(null), children: grokText('取消', 'Cancel') }),
                          $.jsx('button', { type: 'submit', className: 'rok-model-btn rok-model-btn-primary', children: grokText('确认路由', 'Apply route') }),
                        ],
                      }),
                    ],
                  }) : null,
                ],
              }),

              notice ? $.jsx('p', { className: 'grok-host-success', role: 'status', children: notice }) : null,
              error && canConfigure ? $.jsx('p', { className: 'grok-host-error', role: 'alert', children: error }) : null,
              reload?.status === 'waiting' || reload?.status === 'pending'
                ? $.jsx('p', { className: 'grok-host-hint', role: 'status', children: grokText('正在轮询 Host 重载状态…', 'Polling Host reload status…') })
                : null,

              $.jsxs('div', {
                className: 'grok-host-actions',
                children: [
                  $.jsx('button', {
                    type: 'button',
                    className: 'rok-model-btn',
                    onClick: () => onOpenChange(false),
                    children: grokText('关闭', 'Close'),
                  }),
                  $.jsx('button', {
                    type: 'button',
                    className: 'rok-model-btn rok-model-btn-primary',
                    disabled: !canConfigure || busy || !config.providers.length || !config.profiles.length,
                    onClick: () => void saveAll(),
                    children: busy ? grokText('保存中…', 'Saving…') : grokText('保存配置', 'Save configuration'),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function RokModelSettings() {
  const [summary, setSummary] = Q.useState({ loaded: false, needsModel: false, canConfigureModel: true, text: '', reloadStatus: 'none' });
  const [localOpen, setLocalOpen] = Q.useState(false);
  const aliveRef = Q.useRef(true);

  const refreshSummary = Q.useCallback(async () => {
    const api = globalThis.window?.localBot;
    if (!api?.getLocalStatus && !api?.getModelConfig) return;
    try {
      const [statusRes, modelRes] = await Promise.all([
        typeof api.getLocalStatus === 'function' ? api.getLocalStatus().catch(() => null) : Promise.resolve(null),
        typeof api.getModelConfig === 'function' ? api.getModelConfig().catch(() => null) : Promise.resolve(null),
      ]);
      if (!aliveRef.current) return;
      const canConfigureModel = statusRes?.canConfigureModel !== false && modelRes?.canConfigureModel !== false && modelRes?.status !== 403 && modelRes?.status !== 401;
      const cfg = modelRes?.ok ? rokUnwrapRouting(modelRes) : rokEmptyRouting();
      const defaultProfile = cfg.defaultRoute ? cfg.profiles.find(p => p.id === cfg.defaultRoute.profileId) : null;
      const defaultProvider = defaultProfile ? cfg.providers.find(p => p.id === defaultProfile.providerId) : null;
      const needsModel = statusRes?.ok ? Boolean(statusRes.needsModel) : (modelRes?.ok ? !defaultProfile : false);
      const reloadStatus = modelRes?.reload?.status ?? statusRes?.reload?.status ?? 'none';
      const text = defaultProfile
        ? `${defaultProfile.name} · ${defaultProfile.model}${defaultProvider ? ` · ${defaultProvider.name}` : ''}`
        : needsModel
          ? grokText('尚未配置对话模型', 'No chat model configured')
          : grokText('使用 Host 模型配置', 'Managed by Host');
      setSummary({ loaded: true, needsModel, canConfigureModel, text, reloadStatus });
    } catch {
      if (aliveRef.current) setSummary(prev => ({ ...prev, loaded: true }));
    }
  }, []);

  Q.useEffect(() => {
    aliveRef.current = true;
    void refreshSummary();
    const onUpdated = () => void refreshSummary();
    const onRequest = () => {
      if (!globalThis.window?.__rokModelModalHostMounted) setLocalOpen(true);
    };
    const unsubConn = typeof globalThis.window?.localBot?.onConnectionChanged === 'function'
      ? globalThis.window.localBot.onConnectionChanged(() => void refreshSummary())
      : () => {};
    globalThis.window?.addEventListener?.('rokbot-local:model-config-updated', onUpdated);
    globalThis.window?.addEventListener?.('rokbot-local:model-config-request', onRequest);
    return () => {
      aliveRef.current = false;
      try { unsubConn?.(); } catch {}
      globalThis.window?.removeEventListener?.('rokbot-local:model-config-updated', onUpdated);
      globalThis.window?.removeEventListener?.('rokbot-local:model-config-request', onRequest);
    };
  }, [refreshSummary]);

  const openModal = () => {
    if (globalThis.window?.__rokModelModalHostMounted) {
      globalThis.window.__rokLocalModelConfigRequested = true;
      globalThis.window.dispatchEvent(new Event('rokbot-local:model-config-request'));
    } else {
      setLocalOpen(true);
    }
  };

  const statusHint = summary.reloadStatus === 'waiting' || summary.reloadStatus === 'pending'
    ? grokText('正在等待 Host 应用配置…', 'Waiting for Host reload…')
    : !summary.canConfigureModel
      ? grokText('当前设备无权直接修改，可在 Host 管理后台查看或使用管理员密码配对。', 'Read-only on this device. Pair with admin password or use Host Admin.')
      : summary.text;

  return $.jsxs($.Fragment, {
    children: [
      $.jsx(Vn, {
        anchorId: 'model',
        title: grokText('对话模型', 'Chat models'),
        children: $.jsx(X, {
          anchorId: null,
          label: summary.loaded ? (summary.text || grokText('模型配置', 'Model configuration')) : grokText('正在读取…', 'Loading…'),
          description: statusHint || null,
          variant: 'card',
          children: $.jsx(q, {
            onClick: openModal,
            size: 'md',
            style: gr.actionWeakBorder,
            variant: 'secondary',
            children: summary.canConfigureModel
              ? grokText('配置模型', 'Configure model')
              : grokText('查看配置', 'View config'),
          }),
        }),
      }),
      localOpen ? $.jsx(RokModelConfigModal, {
        open: true,
        onOpenChange: setLocalOpen,
        onSaved: () => void refreshSummary(),
      }) : null,
    ],
  });
}

// Settings > General > Usage: the Host's token counts (GET /local/usage) for today, the last 7
// and the last 30 days, in total and per model. Counts are short (rok-usage-format.js); the
// exact number shows on hover and on a long press (or Enter) on touch screens.
const rokUsageStyles = `
.rok-usage-periods{display:inline-flex;gap:4px;padding:2px;border-radius:999px;background:color-mix(in srgb,currentColor 6%,transparent)}
.rok-usage-periods button{border:0;background:none;color:inherit;font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:999px;cursor:pointer;opacity:.65}
.rok-usage-periods button[aria-checked=true]{background:var(--sand-bg-elevated,#fff);opacity:1;box-shadow:0 1px 2px #0000001f}
.rok-usage-periods button:focus-visible{outline:2px solid currentColor;outline-offset:1px}
.rok-usage-count{font-variant-numeric:tabular-nums;cursor:help;-webkit-touch-callout:none;user-select:none;border-radius:3px}
.rok-usage-count:focus-visible{outline:2px solid currentColor;outline-offset:1px}
.rok-usage-total{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap;font-variant-numeric:tabular-nums}
.rok-usage-total strong{font-size:15px;font-weight:600}
.rok-usage-total[data-big=true] strong{font-size:22px;letter-spacing:-.3px}
.rok-usage-total span{font-size:12px;opacity:.6}
.rok-usage-model{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;overflow-wrap:anywhere}
.rok-usage-line{display:inline;font-variant-numeric:tabular-nums}
.rok-usage-line i{font-style:normal;opacity:.5}
`;
function RokUsageCount({ value, wrap }) {
  const locale = grokText('zh-CN', 'en'), [exact, setExact] = Q.useState(false), timer = Q.useRef(null);
  const short = rokFormatCount(value, locale), full = rokFormatExactCount(value, locale);
  const shown = exact ? full : short;
  const flip = () => setExact(current => !current);
  const stop = () => { clearTimeout(timer.current); timer.current = null; };
  Q.useEffect(() => stop, []);
  return $.jsx('span', {
    className: 'rok-usage-count', title: full, 'data-exact': full, tabIndex: 0,
    onPointerDown: event => { if (event.pointerType !== 'mouse') { stop(); timer.current = setTimeout(() => { timer.current = null; flip(); }, 450); } },
    onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop,
    onContextMenu: event => { if (event.nativeEvent?.pointerType !== 'mouse') event.preventDefault(); },
    onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); } },
    children: wrap ? wrap(shown) : shown,
  });
}
function RokUsageLine({ item }) {
  const parts = [[grokText('输入', 'Input'), item.input], [grokText('输出', 'Output'), item.output], [grokText('缓存命中', 'Cache read'), item.cached]];
  if (item.cacheWrite) parts.push([grokText('缓存写入', 'Cache write'), item.cacheWrite]);
  const children = [];
  parts.forEach(([label, value], index) => {
    children.push(`${label} `, $.jsx(RokUsageCount, { value }, `v${index}`), $.jsx('i', { children: ' · ' }, `s${index}`));
  });
  children.push($.jsx(RokUsageCount, { value: item.requests, wrap: text => rokWithRequestUnit(text, item.requests, grokText('zh-CN', 'en')) }, 'requests'));
  return $.jsx('span', { className: 'rok-usage-line', children });
}
function RokUsageTotal({ value, big }) {
  const locale = grokText('zh-CN', 'en'), unit = rokFormatTokens(value, locale).slice(rokFormatCount(value, locale).length).trim();
  return $.jsxs('span', { className: 'rok-usage-total', 'data-big': big ? 'true' : 'false',
    children: [$.jsx('strong', { children: $.jsx(RokUsageCount, { value }) }), $.jsx('span', { children: unit })] });
}
const ROK_USAGE_PERIODS = [['today', '今天', 'Today'], ['7d', '近 7 天', '7 days'], ['30d', '近 30 天', '30 days']];
function RokUsageSettings() {
  const [usage, setUsage] = Q.useState(null), [failed, setFailed] = Q.useState(false), [period, setPeriod] = Q.useState('today');
  const api = globalThis.window?.localBot;
  Q.useEffect(() => {
    if (typeof api?.getUsage !== 'function') return undefined;
    let alive = true;
    const load = () => api.getUsage({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      .then(value => { if (!alive) return; if (value?.ok === false || !Array.isArray(value?.periods)) setFailed(true); else { setUsage(value); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    void load();
    const release = typeof api.onConnectionChanged === 'function' ? api.onConnectionChanged(() => void load()) : () => {};
    return () => { alive = false; try { release?.(); } catch {} };
  }, []);
  if (typeof api?.getUsage !== 'function') return null;
  const current = usage?.periods?.find(item => item.id === period) ?? usage?.periods?.[0] ?? null;
  const tabs = $.jsx('div', { className: 'rok-usage-periods', role: 'radiogroup', 'aria-label': grokText('时间段', 'Period'),
    children: ROK_USAGE_PERIODS.filter(([id]) => !usage || usage.periods.some(item => item.id === id)).map(([id, zh, en]) => $.jsx('button', {
      type: 'button', role: 'radio', 'aria-checked': (current?.id ?? period) === id ? 'true' : 'false', onClick: () => setPeriod(id), children: grokText(zh, en),
    }, id)) });
  const rows = [];
  if (!current) {
    rows.push($.jsx(X, { anchorId: null, variant: 'card', label: failed ? grokText('无法读取用量', 'Could not load usage') : grokText('正在读取…', 'Loading…'), description: null }, 'state'));
  } else {
    rows.push($.jsx(X, { anchorId: null, variant: 'card', label: grokText('合计', 'Total'),
      description: $.jsx(RokUsageLine, { item: current }), children: $.jsx(RokUsageTotal, { value: current.total, big: true }) }, 'total'));
    if (!current.models.length) rows.push($.jsx(X, { anchorId: null, variant: 'card', label: grokText('这段时间还没有模型请求', 'No model requests in this period'), description: null }, 'empty'));
    for (const item of current.models) {
      rows.push($.jsx(X, { anchorId: null, variant: 'card',
        label: $.jsx('span', { className: 'rok-usage-model', children: item.model === 'unknown' ? grokText('未知模型', 'Unknown model') : item.model }),
        description: $.jsx(RokUsageLine, { item }), children: $.jsx(RokUsageTotal, { value: item.total }) }, `model:${item.model}`));
    }
  }
  return $.jsxs($.Fragment, { children: [
    $.jsx('style', { children: rokUsageStyles }),
    $.jsx(Vn, { anchorId: 'outside-settings', title: grokText('用量', 'Usage'), titleAccessory: tabs, children: rows }),
  ] });
}

function GrokHostConnection() {
  const [open, setOpen] = Q.useState(false), [server, setServer] = Q.useState(''), [key, setKey] = Q.useState('');
  const [editing, setEditing] = Q.useState(false), [tailcat, setTailcat] = Q.useState(false);
  const [busy, setBusy] = Q.useState(false), [error, setError] = Q.useState(''), [status, setStatus] = Q.useState(null);
  const input = Q.useRef(null), submitting = Q.useRef(false), composing = Q.useRef(false), editingRef = Q.useRef(false);
  editingRef.current = editing;
  const applyStatus = value => { setStatus(value); if (!editingRef.current && !submitting.current) { setTailcat(value.tailcat === true); if (value.server) setServer(value.server); } };
  const refresh = () => window.localBot.connectionStatus().then(applyStatus).catch(failure => setError(failure.message));
  const request = () => { window.__grokLocalConnectionRequested = false; setError(''); setKey(''); setEditing(false); setOpen(true); void refresh(); };
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
    // Opening the settings and the nested dialog in one commit hides the dialog from accessibility.
    const pending = window.__grokLocalConnectionRequested ? setTimeout(request, 0) : null;
    window.addEventListener('grokbot-local:connect-request', request);
    return () => { clearTimeout(pending); window.removeEventListener('grokbot-local:connect-request', request); };
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
    const fields = [...event.currentTarget.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])')].filter(element => element.tabIndex >= 0 && element.getClientRects().length);
    if (!fields.length) return;
    event.preventDefault(); event.stopPropagation();
    const current = fields.indexOf(document.activeElement);
    fields[(current + (event.shiftKey ? -1 : 1) + fields.length) % fields.length].focus();
  };
  const field = (label, value, onChange, type, placeholder, ref) => $.jsxs('label', { children: [label,
    $.jsx('input', { className: grokInputClass, 'aria-label': label, type, value, placeholder, ref, required: true,
      autoComplete: 'off', spellCheck: false, disabled: busy,
      maxLength: type === 'text' ? 6 : undefined, pattern: type === 'text' ? '[A-Za-z0-9]{6}' : undefined, autoCapitalize: type === 'text' ? 'characters' : 'off', onChange: event => onChange(event.currentTarget.value),
      onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
      onKeyDown: grokBlockComposedEnter(composing) })] });
  const paired = Boolean(status?.paired), person = status?.profile;
  const title = paired ? grokText('连接设置', 'Connection settings') : grokText('连接你的 RokBot', 'Connect your RokBot');
  const stateLabel = status?.state === 'online' ? grokText('已连接', 'Connected') : status?.state === 'connecting' ? grokText('正在连接', 'Connecting') : grokText('正在重新连接', 'Reconnecting');
  return $.jsxs($.Fragment, { children: [
    $.jsx(q, { onClick: request, size: 'md', style: gr.actionWeakBorder, variant: 'secondary', children: grokText('连接设置', 'Connection settings') }),
    open ? $.jsxs(Ft.Root, { 'aria-label': title, open: true, onOpenChange: setOpen, size: 'sm',
      className: 'grok-host-dialog', initialFocus: input, onKeyDown: retainFocus, children: [
      $.jsx('style', { children: grokConnectionStyles }), $.jsx(Ft.CloseButton, {}),
      !status ? $.jsx('div', { className: 'grok-host-content', role: 'status', children: error || grokText('正在读取连接…', 'Loading connection…') }) : paired && !editing ?
      $.jsxs('section', { className: 'grok-host-content', children: [
        $.jsx('header', { children: $.jsx(Ft.Title, { children: title }) }),
        $.jsxs('div', { className: 'grok-host-identity', children: [
          person?.avatarDataUrl ? $.jsx('img', { className: 'grok-host-avatar', src: person.avatarDataUrl, alt: '' }) :
            $.jsx('span', { className: 'grok-host-avatar grok-host-avatar-fallback', 'aria-hidden': true, children: Array.from(person?.displayName || 'R')[0] }),
          $.jsxs('div', { className: 'grok-host-person', children: [
            $.jsx('strong', { children: person?.displayName || grokText('本地账户', 'Local account') }), $.jsx('span', { children: grokText('当前账户', 'Account') })] })] }),
        $.jsxs('div', { className: 'grok-host-details', children: [
          $.jsxs('div', { className: 'grok-host-detail', children: [$.jsx('span', { children: 'Host' }), $.jsx('span', { children: person?.hostName || 'RokBot Host' })] }),
          $.jsxs('div', { className: 'grok-host-detail', children: [$.jsx('span', { children: grokText('连接状态', 'Status') }),
            $.jsx('span', { className: 'grok-host-status', 'data-online': status.state === 'online', role: 'status', children: stateLabel })] }),
          $.jsxs('div', { className: 'grok-host-detail', children: [$.jsx('span', { children: grokText('连接方式', 'Connection') }),
            $.jsx('span', { children: status.tailcat ? 'Tailcat' + (status.transportPath === 'relay' ? ' · ' + grokText('中继', 'Relay') : status.transportPath === 'direct' ? ' · ' + grokText('直连', 'Direct') : '') : grokText('直接连接', 'Direct') })] })] }),
        error ? $.jsx('p', { className: 'grok-host-error', role: 'alert', children: error }) : null,
        $.jsxs('div', { className: 'grok-host-actions grok-host-paired-actions', children: [
          $.jsx(Ft.Action, { type: 'button', onClick: disconnect, disabled: busy, pending: busy, variant: 'secondary', children: busy ? grokText('正在退出…', 'Disconnecting…') : grokText('退出连接', 'Disconnect') }),
          $.jsx(Ft.Action, { type: 'button', onClick: () => setEditing(true), variant: 'secondary', children: grokText('编辑连接', 'Edit connection') }),
          $.jsx(Ft.Action, { type: 'button', onClick: () => setOpen(false), variant: 'primary', children: grokText('完成', 'Done') })] })] }) :
      $.jsxs('form', { className: 'grok-host-content', onSubmit: connect, children: [
        $.jsxs('header', { children: [
          $.jsx('div', { className: 'grok-host-brand', children: $.jsx('img', {
            src: new URL('../../../local-client/icon.png', import.meta.url).href,
            alt: 'RokBot',
            onError: event => { event.currentTarget.style.display = 'none'; },
          }) }),
          $.jsx(Ft.Title, { children: grokText('连接你的 RokBot', 'Connect your RokBot') })] }),
        $.jsxs('div', { className: 'grok-host-fields', children: [
          $.jsxs('div', { className: 'grok-host-detail', children: [$.jsx('span', { children: 'Tailcat' }), $.jsx(gn, { isChecked: tailcat, isDisabled: busy, label: 'Tailcat', onToggle: () => setTailcat(!tailcat), size: 'md' })] }),
          field(tailcat ? grokText('连接链接', 'Connection link') : grokText('Host 地址', 'Host address'), server, setServer, 'url', tailcat ? 'tailcat://connect/…' : 'https://bot.example.com', input),
          !editing && field(grokText('配对码', 'Pairing code'), key, value => setKey(value.toUpperCase()), 'text', grokText('输入新的配对码', 'Pairing code')),
          error ? $.jsx('p', { className: 'grok-host-error', role: 'alert', children: error }) : null] }),
        $.jsxs('div', { className: 'grok-host-actions', children: [
          $.jsx(Ft.Action, { type: 'button', onClick: () => setOpen(false), variant: 'secondary', children: grokText('取消', 'Cancel') }),
          $.jsx(Ft.Action, { type: 'submit', disabled: busy || !server.trim() || (!editing && !key.trim()), pending: busy,
            variant: 'primary', children: busy ? grokText('正在连接…', 'Connecting…') : editing ? grokText('保存', 'Save') : grokText('连接', 'Connect') })] })] })] }) : null,
  ] });
}
export { RokModelConfigModal, RokUsageSettings };

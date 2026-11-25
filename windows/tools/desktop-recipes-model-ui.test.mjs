import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';
import { publicModelRouting, validateModelRouting } from '../../host/runtime/model-routing.mjs';
import { usageCharts } from './desktop-recipes/spec.mjs';

const extDir = new URL('./desktop-recipes/extensions/', import.meta.url);

/** Minimal authentic React + hooks + JSX + portal runtime for executing extension modules in node:vm. */
function createReactTestHarness({ onSetState } = {}) {
  const Fragment = Symbol('Fragment');
  const listeners = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  const scheduledEffects = [];

  function createElement(type, props = {}, ...children) {
    const flat = children.length ? children : props?.children;
    return { type, props: { ...props, children: flat } };
  }

  let currentInstance = null;
  let hookIndex = 0;

  function renderTree(vnode, parentPath = 'root') {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null;
    if (typeof vnode === 'string' || typeof vnode === 'number') return String(vnode);
    if (Array.isArray(vnode)) return vnode.map((c, i) => renderTree(c, `${parentPath}[${i}]`));
    if (typeof vnode.type === 'function') {
      const compName = vnode.type.name || 'Anonymous';
      const key = `${parentPath}/${compName}`;
      let inst = instances.get(key);
      if (!inst || inst.type !== vnode.type) {
        inst = { type: vnode.type, hooks: [], effects: [], path: key };
        instances.set(key, inst);
      }
      const prevInst = currentInstance;
      const prevIdx = hookIndex;
      currentInstance = inst;
      hookIndex = 0;
      let output;
      try {
        output = vnode.type(vnode.props ?? {});
      } finally {
        currentInstance = prevInst;
        hookIndex = prevIdx;
      }
      return { component: compName, props: vnode.props ?? {}, rendered: renderTree(output, key) };
    }
    if (vnode.type === Fragment) {
      return { fragment: true, children: renderTree(vnode.props?.children, `${parentPath}/F`) };
    }
    if (vnode.type && typeof vnode.type === 'object' && vnode.type.$$portal) {
      return { portal: true, target: vnode.type.target, rendered: renderTree(vnode.props?.children, `${parentPath}/Portal`) };
    }
    if (vnode.type && typeof vnode.type === 'object' && vnode.type.$$lazy) {
      const loaded = vnode.type.resolved;
      if (!loaded) return null;
      return renderTree({ type: loaded, props: vnode.props }, `${parentPath}/Lazy`);
    }
    const children = renderTree(vnode.props?.children, `${parentPath}/${String(vnode.type)}`);
    return { tag: String(vnode.type), props: vnode.props ?? {}, children };
  }

  const instances = new Map();
  let rootVnode = null;
  let lastTree = null;

  function flushEffects() {
    while (scheduledEffects.length) {
      const { inst, idx, fn } = scheduledEffects.shift();
      if (typeof inst.effects[idx]?.cleanup === 'function') {
        try { inst.effects[idx].cleanup(); } catch {}
      }
      const cleanup = fn();
      inst.effects[idx] = { ...inst.effects[idx], cleanup };
    }
  }

  function rerender() {
    if (!rootVnode) return null;
    lastTree = renderTree(rootVnode, 'root');
    flushEffects();
    lastTree = renderTree(rootVnode, 'root');
    flushEffects();
    return lastTree;
  }

  function mount(vnode) {
    rootVnode = vnode;
    return rerender();
  }

  function unmount() {
    for (const inst of instances.values()) {
      for (const eff of inst.effects) {
        if (typeof eff?.cleanup === 'function') eff.cleanup();
      }
    }
    instances.clear();
    rootVnode = null;
    lastTree = null;
  }

  const React = {
    useState(init) {
      const inst = currentInstance;
      const idx = hookIndex++;
      if (!(idx in inst.hooks)) {
        inst.hooks[idx] = typeof init === 'function' ? init() : init;
      }
      const setter = next => {
        onSetState?.(inst, idx);
        const value = typeof next === 'function' ? next(inst.hooks[idx]) : next;
        if (!Object.is(inst.hooks[idx], value)) {
          inst.hooks[idx] = value;
        }
      };
      return [inst.hooks[idx], setter];
    },
    useRef(init) {
      const inst = currentInstance;
      const idx = hookIndex++;
      if (!(idx in inst.hooks)) inst.hooks[idx] = { current: init };
      return inst.hooks[idx];
    },
    useCallback(fn, deps) {
      const inst = currentInstance;
      const idx = hookIndex++;
      const prev = inst.hooks[idx];
      if (!prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps[i]))) {
        inst.hooks[idx] = { fn, deps };
      }
      return inst.hooks[idx].fn;
    },
    useEffect(fn, deps) {
      const inst = currentInstance;
      const idx = hookIndex++;
      const prev = inst.effects[idx];
      const changed = !prev || !deps || !prev.deps || deps.some((d, i) => !Object.is(d, prev.deps[i]));
      if (changed) {
        inst.effects[idx] = { deps, cleanup: prev?.cleanup };
        scheduledEffects.push({ inst, idx, fn });
      }
    },
    lazy(loader) {
      const box = { $$lazy: true, resolved: null };
      void Promise.resolve().then(loader).then(mod => {
        box.resolved = mod.default;
      });
      return box;
    },
    Suspense({ children }) { return children; },
  };

  const JSX = {
    Fragment,
    jsx(type, props) { return createElement(type, props); },
    jsxs(type, props) { return createElement(type, props); },
  };

  const ReactDOM = {
    createPortal(children, target) {
      return { type: { $$portal: true, target }, props: { children } };
    },
  };

  const win = {
    navigator: { language: 'en-US' },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
      return true;
    },
  };

  const setTimeoutTracked = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { fn, ms, interval: false });
    return id;
  };
  const clearTimeoutTracked = id => { timers.delete(id); };
  const setIntervalTracked = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { fn, ms, interval: true });
    return id;
  };
  const clearIntervalTracked = id => { timers.delete(id); };

  async function flushMicrotasks(rounds = 8) {
    for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
    rerender();
  }

  async function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      rerender();
      const hit = predicate(lastTree);
      if (hit) return hit;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    rerender();
    return predicate(lastTree);
  }

  async function runNextTimer() {
    const first = timers.entries().next().value;
    if (!first) return false;
    const [id, entry] = first;
    if (!entry.interval) timers.delete(id);
    await entry.fn();
    await flushMicrotasks();
    return true;
  }

  return {
    React, JSX, ReactDOM, window: win, timers,
    mount, rerender, unmount, flushMicrotasks, waitFor, runNextTimer,
    getTree: () => lastTree,
    setTimeout: setTimeoutTracked,
    clearTimeout: clearTimeoutTracked,
    setInterval: setIntervalTracked,
    clearInterval: clearIntervalTracked,
  };
}

function findNodes(tree, predicate, out = []) {
  if (!tree) return out;
  if (Array.isArray(tree)) { for (const item of tree) findNodes(item, predicate, out); return out; }
  if (typeof tree === 'object') {
    if (predicate(tree)) out.push(tree);
    if (tree.rendered) findNodes(tree.rendered, predicate, out);
    if (tree.children) findNodes(tree.children, predicate, out);
  }
  return out;
}

function collectText(tree) {
  if (!tree) return '';
  if (typeof tree === 'string') return tree;
  if (Array.isArray(tree)) return tree.map(collectText).join(' ');
  if (typeof tree === 'object') {
    return [collectText(tree.rendered), collectText(tree.children), typeof tree.props?.title === 'string' ? tree.props.title : collectText(tree.props?.title), typeof tree.props?.body === 'string' ? tree.props.body : collectText(tree.props?.body), typeof tree.props?.label === 'string' ? tree.props.label : '', typeof tree.props?.description === 'string' ? tree.props.description : ''].filter(Boolean).join(' ');
  }
  return '';
}

async function startModelTestServer() {
  let routing = { version: 1, providers: [], profiles: [], defaultRoute: null, botRoutes: {} };
  let configured = false;
  let needsModel = true;
  let canConfigureModel = true;
  let forceStatus = null; // null | 401 | 403
  let reload = { revision: null, status: 'none', error: null, updatedAt: null };
  let lastPutPayload = null;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : {};

    const send = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (forceStatus === 401) return send(401, { error: 'Unauthorized device' });
    if (req.url === '/local/status' && req.method === 'GET') {
      return send(200, {
        ok: true, brand: 'RokBot', initialized: true, configured, needsModel,
        canConfigureModel, hostVersion: '1.2.3', defaultMachineId: 'machine-1', reload,
      });
    }
    if (forceStatus === 403 || !canConfigureModel) {
      return send(403, { error: 'Device not authorized to configure models', canConfigureModel: false });
    }
    if (req.url === '/local/model' && req.method === 'GET') {
      return send(200, {
        ok: true, config: publicModelRouting(routing), configured, needsModel,
        routingMigrated: false, reload, canConfigureModel: true,
      });
    }
    if (req.url === '/local/model' && req.method === 'PUT') {
      lastPutPayload = body;
      try {
        routing = validateModelRouting(body, { previous: routing });
        configured = true;
        needsModel = false;
        reload = { revision: 'rev-1', status: 'waiting', error: null, updatedAt: new Date().toISOString() };
        return send(200, {
          ok: true, config: publicModelRouting(routing), configured, needsModel,
          routingMigrated: false, reload, canConfigureModel: true,
        });
      } catch (err) {
        return send(400, { error: err.message });
      }
    }
    if (req.url === '/local/model/catalog' && req.method === 'POST') {
      const provider = body.provider ?? routing.providers.find(p => p.id === body.providerId);
      if (!provider?.baseUrl) return send(400, { error: 'Missing provider' });
      return send(200, {
        ok: true,
        models: [
          { id: 'gpt-4o', efforts: ['low', 'medium', 'high'], source: 'provider', contextWindowTokens: 128000, summaryThresholdTokens: 96000, contextSource: 'provider' },
          { id: 'gpt-5', efforts: ['minimal', 'low', 'medium', 'high'], source: 'provider', contextWindowTokens: 400000, summaryThresholdTokens: 300000, contextSource: 'provider' },
        ],
      });
    }
    if (req.url === '/local/model/test' && req.method === 'POST') {
      try {
        const candidate = validateModelRouting(body, { previous: routing });
        const profile = candidate.profiles.find(p => p.id === body.profileId);
        if (!profile) return send(400, { error: 'Unknown profileId' });
        return send(200, { ok: true, profileId: profile.id, model: profile.model, reply: 'OK', latencyMs: 42, message: `Connected: ${profile.model} (42 ms) — OK` });
      } catch (err) {
        return send(400, { error: err.message });
      }
    }
    return send(404, { error: 'Not found' });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const httpLocalBot = {
    locale: 'en-US',
    openManagementCalls: 0,
    openManagement() { this.openManagementCalls++; },
    connectionStatus: async () => ({ paired: true, connected: true, server: baseUrl, state: 'online', profile: { hostName: 'Test Host' } }),
    onConnectionChanged: () => () => {},
    getVoicePreference: async () => false,
    setVoicePreference: async v => v,
    onVoicePreferenceChanged: () => () => {},
    async _req(path, method = 'GET', body) {
      const r = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, status: r.status, error: json.error || `HTTP ${r.status}`, ...json };
      return json;
    },
    getLocalStatus: () => httpLocalBot._req('/local/status'),
    getModelConfig: () => httpLocalBot._req('/local/model'),
    updateModelConfig: payload => httpLocalBot._req('/local/model', 'PUT', payload),
    fetchModelCatalog: payload => httpLocalBot._req('/local/model/catalog', 'POST', payload),
    testModelConfig: payload => httpLocalBot._req('/local/model/test', 'POST', payload),
  };

  return {
    httpLocalBot,
    getState: () => ({ routing, configured, needsModel, canConfigureModel, forceStatus, reload, lastPutPayload }),
    setState: patch => {
      if ('needsModel' in patch) needsModel = patch.needsModel;
      if ('canConfigureModel' in patch) canConfigureModel = patch.canConfigureModel;
      if ('forceStatus' in patch) forceStatus = patch.forceStatus;
      if ('reload' in patch) reload = patch.reload;
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function loadExtensionsInVm(harness, localBot) {
  const moduleUrlLiteral = JSON.stringify(new URL('./desktop-recipes/extensions/module.js', import.meta.url).href);
  const i18nSrc = (await readFile(new URL('grok-local-i18n.js', extDir), 'utf8')).replace(/export /g, '');
  const gpSrc = (await readFile(new URL('general-pane.js', extDir), 'utf8')).replace(/export \{[^}]+\};?/g, '').replaceAll('import.meta.url', moduleUrlLiteral);
  const eaSrc = (await readFile(new URL('eager-app.js', extDir), 'utf8')).replaceAll('import.meta.url', moduleUrlLiteral);
  const uvSrc = (await readFile(new URL('update-view.js', extDir), 'utf8')).replaceAll('import.meta.url', moduleUrlLiteral);
  const libSrc = (await readFile(new URL('library.js', extDir), 'utf8')).replace(/export \{[^}]+\};?/g, '');
  const compSrc = (await readFile(new URL('computer-view.js', extDir), 'utf8'));
  // rok-usage-format.js in the renderer is the admin page's formatter (spec.mjs), imported under rok* names.
  const usageFormatSrc = (await readFile(new URL('../../host/server/public/usage-format.js', import.meta.url), 'utf8')).replace(/^export /gm, '')
    + '\nvar rokFormatCount = formatCount, rokFormatExactCount = formatExactCount, rokWithRequestUnit = withRequestUnit;\n';
  // rok-usage-charts.js as spec.mjs ships it (usage-charts.js + the CSS), in its own scope.
  const chartsSrc = usageCharts().replace(/^import .*$/m, '').replace(/^export /gm, '');
  const usageChartsSrc = `var rokUsageCharts = (() => {\n${chartsSrc}\nreturn { usageView, attachUsageTooltip, ROK_USAGE_CHART_CSS };\n})();\n`
    + 'var rokUsageView = rokUsageCharts.usageView, rokAttachUsageTooltip = rokUsageCharts.attachUsageTooltip, ROK_USAGE_CHART_CSS = rokUsageCharts.ROK_USAGE_CHART_CSS;\n';

  const Dialog = {
    Root: ({ children, open }) => open ? harness.JSX.jsx('div', { role: 'dialog', children }) : null,
    CloseButton: () => harness.JSX.jsx('button', { type: 'button', 'aria-label': 'Close' }),
    Title: ({ children }) => harness.JSX.jsx('h2', { children }),
    Header: ({ children }) => harness.JSX.jsx('header', { children }),
    Body: ({ children }) => harness.JSX.jsx('div', { children }),
    Action: ({ children, ...p }) => harness.JSX.jsx('button', { ...p, children }),
  };
  const Section = ({ children, title, anchorId, titleAccessory }) => harness.JSX.jsxs('section', { 'data-anchor': anchorId, children: [title ? harness.JSX.jsx('h3', { children: title }) : null, titleAccessory ?? null, children] });
  const Row = ({ children, label, description }) => harness.JSX.jsxs('div', { 'data-row': label, children: [label, description, children] });
  const Button = ({ children, ...p }) => harness.JSX.jsx('button', { type: 'button', ...p, children });
  const Toggle = ({ isChecked, onToggle, label }) => harness.JSX.jsx('input', { type: 'checkbox', checked: isChecked, 'aria-label': label, onChange: onToggle });
  const Text = ({ children, ...p }) => harness.JSX.jsx('span', { ...p, children });
  const lD = ({ title, body, actions, sentiment, dismiss }) => harness.JSX.jsxs('div', {
    'data-sand-banner': sentiment,
    children: [title, body, actions, dismiss?.kind === 'close' ? harness.JSX.jsx('button', { type: 'button', onClick: dismiss.onDismiss, children: dismiss.label }) : null],
  });
  const uD = ({ children, onClick, kind }) => harness.JSX.jsx('button', { type: 'button', 'data-kind': kind, onClick, children });

  const win = Object.assign(harness.window, { localBot });
  const doc = { body: { nodeType: 1, tagName: 'BODY' } };
  const EventCtor = class Event { constructor(type) { this.type = type; } };

  const sharedGlobals = {
    window: win,
    document: doc,
    Event: EventCtor,
    URL,
    setTimeout: harness.setTimeout,
    clearTimeout: harness.clearTimeout,
    setInterval: harness.setInterval,
    clearInterval: harness.clearInterval,
  };
  const i18nCtx = vm.createContext({ ...sharedGlobals });
  i18nCtx.globalThis = i18nCtx;
  vm.runInContext(i18nSrc, i18nCtx);

  const gpExports = {};
  const gpCtx = vm.createContext({
    ...sharedGlobals,
    grokText: i18nCtx.grokText,
    $: harness.JSX, Q: harness.React, q: Button, gn: Toggle, Ft: Dialog,
    gr: { actionWeakBorder: {} }, Vn: Section, X: Row,
    __out: gpExports,
  });
  gpCtx.globalThis = gpCtx;
  vm.runInContext(`${usageFormatSrc}\n${usageChartsSrc}\n${gpSrc}\n__out.RokModelConfigModal = RokModelConfigModal;__out.RokModelSettings = RokModelSettings;__out.RokUsageSettings = RokUsageSettings;`, gpCtx);

  const eaExports = {};
  const eaReact = {
    ...harness.React,
    lazy(fn) {
      if (String(fn).includes('RokModelConfigModal')) {
        return harness.React.lazy(async () => ({ default: gpExports.RokModelConfigModal }));
      }
      return harness.React.lazy(async () => ({ default: () => null }));
    },
  };
  const eaCtx = vm.createContext({
    ...sharedGlobals,
    grokText: i18nCtx.grokText,
    X: eaReact, Z: harness.JSX, TS: harness.ReactDOM, Ft: () => doc.body,
    lD, uD, uDr: { passThrough: {} }, yEt: () => null, WM: () => null, Fw: Dialog,
    __out: eaExports,
  });
  eaCtx.globalThis = eaCtx;
  vm.runInContext(`${eaSrc}\n__out.RokNeedsModelBanner = RokNeedsModelBanner;__out.RokModelConfigHost = RokModelConfigHost;`, eaCtx);

  const uvExports = {};
  const uvCtx = vm.createContext({
    ...sharedGlobals,
    grokText: i18nCtx.grokText,
    x: harness.JSX, h: Section, oe: Row, re: Button, l: Text, d: { body2: {} },
    __out: uvExports,
  });
  uvCtx.globalThis = uvCtx;
  vm.runInContext(`${uvSrc}\n__out.GrokLocalVersion = GrokLocalVersion;__out.GrokLocalUpdateStatus = GrokLocalUpdateStatus;`, uvCtx);

  const libExports = {};
  const libCtx = vm.createContext({
    ...sharedGlobals,
    grokText: i18nCtx.grokText,
    k: harness.React, V: harness.JSX, GrokButton: Button, de: () => null,
    __out: libExports,
  });
  libCtx.globalThis = libCtx;
  vm.runInContext(`${libSrc}\n__out.GrokLibraryUpload = GrokLibraryUpload;`, libCtx);

  const compExports = {};
  const compCtx = vm.createContext({
    ...sharedGlobals,
    grokText: i18nCtx.grokText,
    Q: harness.JSX, $e: Section, Y: Row, Ue: Button, K: { body2: {} },
    __out: compExports,
  });
  compCtx.globalThis = compCtx;
  vm.runInContext(`${compSrc}\n__out.GrokRemoteDesktop = GrokRemoteDesktop;`, compCtx);

  return { ...gpExports, ...eaExports, ...uvExports, ...libExports, ...compExports, lD, uD, Dialog, win };
}

test('needsModel banner opens RokModelConfigModal directly without Settings, performs CRUD + catalog + test + key preservation + waiting->applied polling', async t => {
  const srv = await startModelTestServer();
  t.after(() => srv.close());
  const harness = createReactTestHarness();
  t.after(() => harness.unmount());
  const { RokNeedsModelBanner, RokModelConfigHost, RokModelConfigModal, uD, lD, Dialog, win } = await loadExtensionsInVm(harness, srv.httpLocalBot);

  function Shell() {
    return harness.JSX.jsxs(harness.JSX.Fragment, {
      children: [harness.JSX.jsx(RokNeedsModelBanner, {}), harness.JSX.jsx(RokModelConfigHost, {})],
    });
  }

  harness.mount(harness.JSX.jsx(Shell, {}));
  const banners = await harness.waitFor(t => {
    const hits = findNodes(t, n => n.component === 'lD');
    return hits.length ? hits : null;
  });

  assert.equal(win.__rokModelModalHostMounted, true);
  assert.equal(banners.length, 1, 'needsModel banner must render when Host needsModel=true');
  assert.equal(banners[0].props.sentiment, 'warning');
  assert.equal(banners[0].props.actions.type, uD, 'lD actions prop must be a React element (<uD>), not an object array');

  // Click banner button WITHOUT Settings ever having mounted!
  banners[0].props.actions.props.onClick();
  const addProviderBtn = await harness.waitFor(t => findNodes(t, n => n.tag === 'button' && n.props.children === 'Add provider')[0]);
  assert.ok(addProviderBtn, `Expected Add provider button in tree: ${collectText(harness.getTree())}`);

  const modals = findNodes(harness.getTree(), n => n.component === 'RokModelConfigModal');
  assert.equal(modals.length, 1, 'Clicking banner button must open RokModelConfigModal directly');
  const dialogs = findNodes(harness.getTree(), n => n.component === 'Root');
  assert.equal(dialogs.length, 1);

  // Add a provider via UI form
  addProviderBtn.props.onClick();
  harness.rerender();

  const pNameInput = findNodes(harness.getTree(), n => n.tag === 'input' && n.props.placeholder === 'OpenAI / Anthropic / DeepSeek')[0];
  pNameInput.props.onChange({ currentTarget: { value: 'OpenAI Main' } });
  harness.rerender();
  const pKeyInput = findNodes(harness.getTree(), n => n.tag === 'input' && n.props.type === 'password')[0];
  pKeyInput.props.onChange({ currentTarget: { value: 'sk-real-secret-key' } });
  harness.rerender();
  const pForm = findNodes(harness.getTree(), n => n.tag === 'form' && collectText(n).includes('Apply provider'))[0];
  pForm.props.onSubmit({ preventDefault() {} });
  harness.rerender();
  assert.match(collectText(harness.getTree()), /OpenAI Main/);

  // Add a profile, fetch catalog from real HTTP server, and pick model
  const addProfileBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Add profile')[0];
  addProfileBtn.props.onClick();
  harness.rerender();

  const profNameInput = findNodes(harness.getTree(), n => n.tag === 'input' && n.props.placeholder === 'GPT-5 / Claude Sonnet')[0];
  profNameInput.props.onChange({ currentTarget: { value: 'Primary GPT' } });
  harness.rerender();

  const fetchBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Fetch catalog')[0];
  fetchBtn.props.onClick();
  const catalogSelect = await harness.waitFor(t => findNodes(t, n => n.tag === 'select' && collectText(n).includes('gpt-4o'))[0]);
  assert.match(collectText(harness.getTree()), /Fetched 2 models/);

  catalogSelect.props.onChange({ currentTarget: { value: 'gpt-4o' } });
  harness.rerender();

  const profForm = findNodes(harness.getTree(), n => n.tag === 'form' && collectText(n).includes('Apply profile'))[0];
  profForm.props.onSubmit({ preventDefault() {} });
  harness.rerender();
  assert.match(collectText(harness.getTree()), /Primary GPT · gpt-4o/);

  // Test connection via real HTTP /local/model/test
  const testBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Test')[0];
  testBtn.props.onClick();
  await harness.waitFor(t => /Connected: gpt-4o/.test(collectText(t)));
  assert.match(collectText(harness.getTree()), /Connected: gpt-4o \(42 ms\) — OK/);

  // Add a Bot route override
  const addBotBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Add bot route')[0];
  addBotBtn.props.onClick();
  harness.rerender();
  const botInput = findNodes(harness.getTree(), n => n.tag === 'input' && n.props.placeholder === 'bot-alpha')[0];
  botInput.props.onChange({ currentTarget: { value: 'bot-alpha' } });
  harness.rerender();
  const botForm = findNodes(harness.getTree(), n => n.tag === 'form' && collectText(n).includes('Apply route'))[0];
  botForm.props.onSubmit({ preventDefault() {} });
  harness.rerender();
  assert.match(collectText(harness.getTree()), /bot-alpha/);

  // Save configuration -> server returns reload.status === 'waiting' -> starts 2s polling
  const saveBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Save configuration')[0];
  saveBtn.props.onClick();
  await harness.waitFor(t => /Waiting for Host to apply configuration/.test(collectText(t)));
  assert.match(collectText(harness.getTree()), /Waiting for Host to apply configuration/);
  assert.ok(harness.timers.size >= 1, 'must schedule polling timer while reload.status === waiting');

  // Server transitions to applied -> poll picks it up, clears banner!
  srv.setState({ reload: { revision: 'rev-1', status: 'applied', error: null, updatedAt: new Date().toISOString() } });
  await harness.runNextTimer();
  await harness.waitFor(t => /Configuration applied to Host/.test(collectText(t)) && findNodes(t, n => n.component === 'lD').length === 0);
  assert.match(collectText(harness.getTree()), /Configuration applied to Host/);
  assert.equal(findNodes(harness.getTree(), n => n.component === 'lD').length, 0, 'needsModel banner must hide once applied');

  // Re-open modal -> blank apiKey on provider edit preserves stored key on Host!
  const editProvBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Edit')[0];
  editProvBtn.props.onClick();
  harness.rerender();
  const editNameInput = findNodes(harness.getTree(), n => n.tag === 'input' && n.props.placeholder === 'OpenAI / Anthropic / DeepSeek')[0];
  editNameInput.props.onChange({ currentTarget: { value: 'OpenAI Renamed' } });
  harness.rerender();
  const editPForm = findNodes(harness.getTree(), n => n.tag === 'form' && collectText(n).includes('Apply provider'))[0];
  editPForm.props.onSubmit({ preventDefault() {} });
  harness.rerender();

  const saveAgainBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Save configuration')[0];
  saveAgainBtn.props.onClick();
  await harness.waitFor(() => srv.getState().lastPutPayload?.providers?.[0]?.name === 'OpenAI Renamed');
  assert.equal(srv.getState().lastPutPayload.providers[0].apiKey, '', 'UI must send blank apiKey when unchanged');
  assert.equal(srv.getState().routing.providers[0].apiKey, 'sk-real-secret-key', 'Host validateModelRouting must preserve stored apiKey');
  assert.equal(srv.getState().routing.providers[0].name, 'OpenAI Renamed');
});

test('handles reload error polling, timer cleanup on close, canConfigureModel=false, 403 and 401 cleanly', async t => {
  const srv = await startModelTestServer();
  t.after(() => srv.close());
  const harness = createReactTestHarness();
  t.after(() => harness.unmount());
  const { RokNeedsModelBanner, RokModelConfigHost, RokModelConfigModal, win } = await loadExtensionsInVm(harness, srv.httpLocalBot);

  // 1) canConfigureModel === false -> banner opens Host Admin, modal disables mutations
  srv.setState({ canConfigureModel: false, needsModel: true });
  harness.mount(harness.JSX.jsx(RokNeedsModelBanner, {}));
  const banners = await harness.waitFor(t => {
    const hits = findNodes(t, n => n.component === 'lD');
    return hits.length ? hits : null;
  });
  assert.equal(banners.length, 1);
  assert.equal(banners[0].props.actions.props.children, 'Open Host Admin');
  banners[0].props.actions.props.onClick();
  assert.equal(srv.httpLocalBot.openManagementCalls, 1);

  harness.unmount();

  // 2) Modal with 403 -> shows permission error and disables Save
  harness.mount(harness.JSX.jsx(RokModelConfigModal, { open: true, onOpenChange() {}, onSaved() {} }));
  await harness.waitFor(t => /not authorized|cannot modify/i.test(collectText(t)));
  assert.match(collectText(harness.getTree()), /not authorized|cannot modify/i);
  const saveDisabled = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Save configuration')[0];
  assert.equal(saveDisabled.props.disabled, true);
  harness.unmount();

  // 3) Modal with 401 -> shows re-pair error cleanly
  srv.setState({ forceStatus: 401, canConfigureModel: true });
  harness.mount(harness.JSX.jsx(RokModelConfigModal, { open: true, onOpenChange() {}, onSaved() {} }));
  await harness.waitFor(t => /Device credentials expired/.test(collectText(t)));
  assert.match(collectText(harness.getTree()), /Device credentials expired/);
  harness.unmount();

  // 4) Waiting -> error stops polling; unmount cancels active poll timer
  srv.setState({
    forceStatus: null,
    canConfigureModel: true,
    reload: { revision: 'r2', status: 'waiting', error: null },
  });
  harness.mount(harness.JSX.jsx(RokModelConfigModal, { open: true, onOpenChange() {}, onSaved() {} }));
  await harness.waitFor(() => harness.timers.size >= 1);
  assert.ok(harness.timers.size >= 1);
  srv.setState({ reload: { revision: 'r2', status: 'error', error: 'Invalid model env' } });
  await harness.runNextTimer();
  await harness.waitFor(t => /Invalid model env/.test(collectText(t)));
  assert.match(collectText(harness.getTree()), /Invalid model env/);
  assert.equal(harness.timers.size, 0, 'error status must stop polling');

  // Start waiting again and unmount -> timer must be cleared
  srv.setState({ reload: { revision: 'r3', status: 'waiting', error: null } });
  harness.unmount();
  harness.mount(harness.JSX.jsx(RokModelConfigModal, { open: true, onOpenChange() {}, onSaved() {} }));
  await harness.waitFor(() => harness.timers.size >= 1);
  assert.ok(harness.timers.size >= 1);
  harness.unmount();
  assert.equal(harness.timers.size, 0, 'unmount must clean up pending poll timer');
  assert.equal(Boolean(win.__rokModelModalHostMounted), false);
});

test('update-view.js renders RokBot 1.2.3 and non-blocking inline update states without alert/confirm', async () => {
  const harness = createReactTestHarness();
  let alertCalled = false;
  const origAlert = globalThis.alert;
  const origConfirm = globalThis.confirm;
  globalThis.alert = () => { alertCalled = true; };
  globalThis.confirm = () => { alertCalled = true; return false; };
  try {
    const { GrokLocalVersion } = await loadExtensionsInVm(harness, { locale: 'en-US' });
    let checked = 0, installed = '';
    const states = [
      { state: { type: 'checking' } },
      { state: { type: 'downloading', version: '1.2.4', progress: 0.5 } },
      { state: { type: 'downloading', version: '1.2.4', progress: 1 } },
      { state: { type: 'downloading', version: '1.2.4', progress: 75 } },
      { state: { type: 'downloading', version: '1.2.4', progress: Number.NaN } },
      { state: { type: 'downloading', version: '1.2.4', progress: Number.POSITIVE_INFINITY } },
      { state: { type: 'ready', version: '1.2.4' } },
      { state: { type: 'idle', lastCheck: { result: 'error', errorMessage: 'Signature mismatch', message: 'Fallback error' } } },
      { state: { type: 'idle', lastCheck: { result: 'error', message: 'Network timeout' } } },
    ];
    for (const status of states) {
      harness.mount(harness.JSX.jsx(GrokLocalVersion, {
        status,
        onCheck: () => { checked++; },
        onInstall: v => { installed = v; },
      }));
      const txt = collectText(harness.getTree());
      assert.match(txt, /RokBot/);
      assert.match(txt, /1\.2\.3/);
      if (status.state.type === 'downloading') {
        assert.doesNotMatch(txt, /NaN%|Infinity%/);
        if (status.state.progress === 0.5) assert.match(txt, /50%/);
        else if (status.state.progress === 1) assert.match(txt, /100%/);
        else if (status.state.progress === 75) assert.match(txt, /75%/);
        else assert.match(txt, /Downloading update…/);
      }
      if (status.state.type === 'ready') {
        const restartBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Restart to update')[0];
        restartBtn.props.onClick();
        assert.equal(installed, '1.2.4');
      }
      if (status.state.lastCheck?.result === 'error') {
        assert.match(txt, new RegExp(status.state.lastCheck.errorMessage ?? status.state.lastCheck.message));
        const retryBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Check for updates')[0];
        retryBtn.props.onClick();
      }
    }
    assert.equal(checked, 2);
    // Safe image onError hides broken image on Web without throwing
    const img = findNodes(harness.getTree(), n => n.tag === 'img')[0];
    const fakeImg = { currentTarget: { style: { display: '' } } };
    img.props.onError(fakeImg);
    assert.equal(fakeImg.currentTarget.style.display, 'none');
    assert.equal(alertCalled, false);
  } finally {
    globalThis.alert = origAlert;
    globalThis.confirm = origConfirm;
  }
});

test('RokModelSettings, library.js (GrokLibraryUpload) and computer-view.js (GrokRemoteDesktop) execute cleanly', async t => {
  const srv = await startModelTestServer();
  t.after(() => srv.close());
  const harness = createReactTestHarness();
  t.after(() => harness.unmount());
  const { RokModelSettings, GrokLibraryUpload, GrokRemoteDesktop, win } = await loadExtensionsInVm(harness, srv.httpLocalBot);

  // 1) RokModelSettings standalone fallback modal when host not mounted
  harness.mount(harness.JSX.jsx(RokModelSettings, {}));
  await harness.waitFor(t => /No chat model configured/.test(collectText(t)));
  const configBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Configure model')[0];
  configBtn.props.onClick();
  await harness.waitFor(t => findNodes(t, n => n.component === 'RokModelConfigModal').length === 1);
  assert.equal(findNodes(harness.getTree(), n => n.component === 'RokModelConfigModal').length, 1);

  // When host IS mounted, RokModelSettings dispatches event instead of opening duplicate modal
  harness.unmount();
  win.__rokModelModalHostMounted = true;
  let dispatched = 0;
  win.addEventListener('rokbot-local:model-config-request', () => { dispatched++; });
  harness.mount(harness.JSX.jsx(RokModelSettings, {}));
  await harness.waitFor(t => /No chat model configured/.test(collectText(t)));
  findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Configure model')[0].props.onClick();
  harness.rerender();
  assert.equal(dispatched, 1);
  assert.equal(findNodes(harness.getTree(), n => n.component === 'RokModelConfigModal').length, 0);
  harness.unmount();

  // 2) GrokLibraryUpload uses k.useRef + V.jsx and ingests selected files
  const ingested = [];
  harness.mount(harness.JSX.jsx(GrokLibraryUpload, { upload: { isUploading: false, ingest: files => ingested.push(...files) }, disabled: false }));
  const fileInput = findNodes(harness.getTree(), n => n.tag === 'input' && n.props.type === 'file')[0];
  const fakeEvent = { currentTarget: { files: [{ name: 'doc.pdf' }], value: 'C:\\fakepath\\doc.pdf' } };
  fileInput.props.onChange(fakeEvent);
  assert.equal(ingested.length, 1);
  assert.equal(fakeEvent.currentTarget.value, '');

  // 3) GrokRemoteDesktop calls window.localBot.openManagement()
  harness.mount(harness.JSX.jsx(GrokRemoteDesktop, {}));
  const manageBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Manage')[0];
  manageBtn.props.onClick();
  assert.equal(srv.httpLocalBot.openManagementCalls, 1);
});

test('controlled RokModelConfigModal open: true -> false without unmount cancels in-flight poll and prevents post-close setState or timer leak', async t => {
  let trackSetState = false;
  let postCloseSetStateCalls = 0;
  const harness = createReactTestHarness({
    onSetState(inst) {
      if (trackSetState && inst.type?.name === 'RokModelConfigModal') postCloseSetStateCalls++;
    },
  });
  t.after(() => harness.unmount());

  let resolvePendingPoll;
  let pollInFlight = false;
  let onSavedCalls = 0;
  const waitingPayload = () => ({
    ok: true,
    config: { version: 1, providers: [], profiles: [], defaultRoute: null, botRoutes: {} },
    configured: false,
    needsModel: true,
    routingMigrated: false,
    reload: { revision: 'rev-ctrl', status: 'waiting', error: null },
    canConfigureModel: true,
  });

  const localBot = {
    locale: 'en-US',
    getLocalStatus: async () => ({ ok: true, needsModel: true, canConfigureModel: true }),
    getModelConfig: async () => {
      if (pollInFlight) {
        return new Promise(resolve => { resolvePendingPoll = resolve; });
      }
      return waitingPayload();
    },
  };

  const { RokModelConfigModal } = await loadExtensionsInVm(harness, localBot);

  let isOpen = true;
  function ControlledHost() {
    return harness.JSX.jsx(RokModelConfigModal, {
      open: isOpen,
      onOpenChange: next => { isOpen = Boolean(next); },
      onSaved: () => { onSavedCalls++; },
    });
  }

  harness.mount(harness.JSX.jsx(ControlledHost, {}));
  await harness.waitFor(() => harness.timers.size === 1);
  assert.equal(harness.timers.size, 1);

  // Fire the scheduled poll timer so getModelConfig() is in flight and unresolved
  pollInFlight = true;
  const [timerId, entry] = harness.timers.entries().next().value;
  harness.timers.delete(timerId);
  const inFlightPromise = entry.fn();
  assert.equal(typeof resolvePendingPoll, 'function', 'poll getModelConfig() must be in flight');

  // Close the controlled modal via open=false WITHOUT unmounting
  isOpen = false;
  harness.rerender();
  assert.equal(findNodes(harness.getTree(), n => n.tag === 'div' && n.props.role === 'dialog').length, 0);

  // Resolve the stale in-flight poll promise after open=false
  trackSetState = true;
  resolvePendingPoll(waitingPayload());
  await inFlightPromise;
  await harness.flushMicrotasks();
  trackSetState = false;

  assert.equal(harness.timers.size, 0, 'controlled open: true -> false during in-flight poll must NOT leak a poll timer');
  assert.equal(postCloseSetStateCalls, 0, 'in-flight poll resolving after open=false must NOT call setState');
  assert.equal(onSavedCalls, 0);

  // Also test rapid open: true -> false -> true: stale session poll resolving with 'applied' must be ignored
  pollInFlight = false;
  isOpen = true;
  harness.rerender();
  await harness.waitFor(() => harness.timers.size === 1);

  pollInFlight = true;
  const [timerId2, entry2] = harness.timers.entries().next().value;
  harness.timers.delete(timerId2);
  const stalePromise = entry2.fn();
  const resolveStale = resolvePendingPoll;

  isOpen = false;
  harness.rerender();
  pollInFlight = false;
  isOpen = true;
  harness.rerender();
  await harness.waitFor(() => harness.timers.size === 1);

  // Stale 'applied' response from first session must NOT clear the active poll or trigger onSaved
  resolveStale({
    ...waitingPayload(),
    reload: { revision: 'rev-ctrl', status: 'applied', error: null },
  });
  await stalePromise;
  await harness.flushMicrotasks();

  assert.equal(onSavedCalls, 0, 'stale poll from prior open session must NOT trigger onSaved after reopen');
  assert.equal(harness.timers.size, 1, 'new open session poll timer must remain active');

  // Clean close
  isOpen = false;
  harness.rerender();
  assert.equal(harness.timers.size, 0);
});

test('controlled RokModelConfigModal open: true -> false -> true resets busy/testBusyId/catalogBusy locks and saveAll stops prior load poll', async t => {
  const harness = createReactTestHarness();
  t.after(() => harness.unmount());

  const baseConfig = {
    version: 1,
    providers: [{ id: 'p1', name: 'OpenAI', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', hasApiKey: true }],
    profiles: [{ id: 'prof1', name: 'Main GPT', providerId: 'p1', model: 'gpt-4o', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 }],
    defaultRoute: { profileId: 'prof1', effort: 'default', fallbacks: [] },
    botRoutes: {},
  };

  let loadReload = { revision: null, status: 'none', error: null };
  let deferSave = false;
  let resolveSave;
  let deferTest = false;
  let resolveTest;
  let deferCatalog = false;
  let resolveCatalog;
  let onSavedCalls = 0;

  const localBot = {
    locale: 'en-US',
    getLocalStatus: async () => ({ ok: true, needsModel: false, canConfigureModel: true }),
    getModelConfig: async () => ({
      ok: true,
      config: structuredClone(baseConfig),
      configured: true,
      needsModel: false,
      routingMigrated: false,
      reload: loadReload,
      canConfigureModel: true,
    }),
    updateModelConfig: async () => {
      if (deferSave) return new Promise(r => { resolveSave = r; });
      return {
        ok: true,
        config: structuredClone(baseConfig),
        configured: true,
        needsModel: false,
        routingMigrated: false,
        reload: { revision: 'r-save', status: 'applied', error: null },
        canConfigureModel: true,
      };
    },
    testModelConfig: async () => {
      if (deferTest) return new Promise(r => { resolveTest = r; });
      return { ok: true, model: 'gpt-4o', latencyMs: 12, reply: 'OK' };
    },
    fetchModelCatalog: async () => {
      if (deferCatalog) return new Promise(r => { resolveCatalog = r; });
      return { ok: true, models: [{ id: 'gpt-4o' }] };
    },
  };

  const { RokModelConfigModal } = await loadExtensionsInVm(harness, localBot);

  let isOpen = true;
  function ControlledHost() {
    return harness.JSX.jsx(RokModelConfigModal, {
      open: isOpen,
      onOpenChange: next => { isOpen = Boolean(next); },
      onSaved: () => { onSavedCalls++; },
    });
  }

  harness.mount(harness.JSX.jsx(ControlledHost, {}));
  await harness.waitFor(t => findNodes(t, n => n.tag === 'button' && n.props.children === 'Save configuration')[0]);

  // 1) saveAll() in-flight -> open: true -> false -> true -> resolve stale save
  deferSave = true;
  findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Save configuration')[0].props.onClick();
  harness.rerender();
  const savingBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Saving…')[0];
  assert.ok(savingBtn && savingBtn.props.disabled === true);
  assert.equal(typeof resolveSave, 'function');

  isOpen = false;
  harness.rerender();
  deferSave = false;
  isOpen = true;
  harness.rerender();
  const reopenedSaveBtn = await harness.waitFor(t => findNodes(t, n => n.tag === 'button' && n.props.children === 'Save configuration')[0]);
  assert.equal(reopenedSaveBtn.props.disabled, false, 'Save configuration must be enabled immediately on reopen');

  resolveSave({
    ok: true,
    config: structuredClone(baseConfig),
    configured: true,
    needsModel: false,
    reload: { revision: 'r-stale', status: 'applied', error: null },
  });
  await harness.flushMicrotasks();
  assert.equal(onSavedCalls, 0, 'stale save must not trigger onSaved after reopen');
  const saveAfterStale = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Save configuration')[0];
  assert.ok(saveAfterStale, 'Save configuration button must not be stuck at Saving…');
  assert.equal(saveAfterStale.props.disabled, false);

  // 2) runProfileTest() in-flight -> open: true -> false -> true -> resolve stale test
  deferTest = true;
  findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Test')[0].props.onClick();
  harness.rerender();
  const testingBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Testing…')[0];
  assert.ok(testingBtn && testingBtn.props.disabled === true);
  assert.equal(typeof resolveTest, 'function');

  isOpen = false;
  harness.rerender();
  deferTest = false;
  isOpen = true;
  harness.rerender();
  const reopenedTestBtn = await harness.waitFor(t => findNodes(t, n => n.tag === 'button' && n.props.children === 'Test')[0]);
  assert.equal(reopenedTestBtn.props.disabled, false, 'Test button must be enabled immediately on reopen');

  resolveTest({ ok: false, status: 401, error: 'Stale test 401' });
  await harness.flushMicrotasks();
  const testAfterStale = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Test')[0];
  assert.ok(testAfterStale, 'Test button must not be stuck at Testing…');
  assert.equal(testAfterStale.props.disabled, false);

  // 3) fetchCatalog() in-flight -> open: true -> false -> true -> resolve stale catalog
  findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Add profile')[0].props.onClick();
  harness.rerender();
  deferCatalog = true;
  findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Fetch catalog')[0].props.onClick();
  harness.rerender();
  const fetchingBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Fetching…')[0];
  assert.ok(fetchingBtn && fetchingBtn.props.disabled === true);
  assert.equal(typeof resolveCatalog, 'function');

  isOpen = false;
  harness.rerender();
  deferCatalog = false;
  isOpen = true;
  harness.rerender();
  const addProfReopened = await harness.waitFor(t => findNodes(t, n => n.tag === 'button' && n.props.children === 'Add profile')[0]);
  addProfReopened.props.onClick();
  harness.rerender();

  const reopenedFetchBtn = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Fetch catalog')[0];
  assert.ok(reopenedFetchBtn, 'Fetch catalog button must appear in reopened profile form');
  assert.equal(reopenedFetchBtn.props.disabled, false, 'Fetch catalog must be enabled immediately on reopen');

  resolveCatalog({ ok: false, status: 403, error: 'Stale catalog 403' });
  await harness.flushMicrotasks();
  const fetchAfterStale = findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Fetch catalog')[0];
  assert.ok(fetchAfterStale, 'Fetch catalog button must not be stuck at Fetching…');
  assert.equal(fetchAfterStale.props.disabled, false);

  // 4) saveAll() returning synchronous 'applied' must stop prior load() poll timer
  isOpen = false;
  harness.rerender();
  loadReload = { revision: 'r-load', status: 'waiting', error: null };
  isOpen = true;
  harness.rerender();
  await harness.waitFor(() => harness.timers.size === 1);
  assert.equal(harness.timers.size, 1);

  findNodes(harness.getTree(), n => n.tag === 'button' && n.props.children === 'Save configuration')[0].props.onClick();
  await harness.waitFor(t => /Configuration applied to Host/.test(collectText(t)));
  assert.equal(harness.timers.size, 0, 'saveAll() applied response must stop prior load() poll timer');
  assert.equal(onSavedCalls, 1);
});

const USAGE_FIXTURE = (() => {
  const gpt = { model: 'gpt-5', input: 320000000, output: 0, total: 320000000, cached: 0, cacheWrite: 0, reasoning: 0, requests: 1 };
  const claude = { model: 'claude-opus', input: 12000, output: 345, total: 12345, cached: 9000, cacheWrite: 120, reasoning: 0, requests: 2 };
  const sum = models => Object.fromEntries(['input', 'output', 'total', 'cached', 'cacheWrite', 'reasoning', 'requests']
    .map(key => [key, models.reduce((value, item) => value + item[key], 0)]));
  const day = (start, models) => ({ start, ...sum(models), models });
  const hours = Array.from({ length: 24 }, (_, hour) => day(`2026-11-25T${String(hour).padStart(2, '0')}`, hour === 9 ? [claude] : []));
  const today = { id: 'today', days: 1, from: '2026-11-25', to: '2026-11-25', ...sum([claude]), models: [claude], unit: 'hour', buckets: hours };
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 9, 27 + index)).toISOString().slice(0, 10);
    return day(date, date === '2026-11-24' ? [gpt] : date === '2026-11-25' ? [claude] : []);
  });
  const month = { id: '30d', days: 30, from: '2026-10-27', to: '2026-11-25', ...sum([gpt, claude]), models: [gpt, claude], unit: 'day', buckets: days };
  return { ok: true, date: '2026-11-25', timeZone: 'Asia/Shanghai', ...sum([claude]), models: [claude],
    periods: [today, { ...month, id: '7d', days: 7, from: '2026-11-19', buckets: days.slice(-7) }, month] };
})();

test('RokUsageSettings draws cards, columns, shares and a table per period, with exact counts on hover and long press', async t => {
  for (const [locale, expected] of [
    ['en-US', { title: 'Usage', cards: ['Total tokens', 'Requests', 'Input', 'Output', 'Cache hit rate'], today: ['12.3K', '9K', '75%', 'Tokens per hour'],
      month: ['320M', '12.3K', 'Tokens per day', '100%'], tabs: ['Today', '7 days', '30 days'] }],
    ['zh-CN', { title: '用量', cards: ['总 Token', '请求数', '输入', '输出', '缓存命中率'], today: ['1.23 万', '9,000', '75%', '每小时 Token', '1.2 万'],
      month: ['3.2 亿', '1.23 万', '每日 Token', '100%'], tabs: ['今天', '近 7 天', '近 30 天'] }],
  ]) {
    const harness = createReactTestHarness();
    t.after(() => harness.unmount());
    const calls = [];
    const localBot = { locale, onConnectionChanged: () => () => {}, getUsage: async payload => { calls.push(payload); return USAGE_FIXTURE; } };
    const { RokUsageSettings } = await loadExtensionsInVm(harness, localBot);
    harness.mount(harness.JSX.jsx(RokUsageSettings, {}));
    await harness.waitFor(tree => collectText(tree).includes(expected.cards[0]));
    assert.equal(typeof calls[0].timeZone, 'string');
    const tree = harness.getTree(), text = collectText(tree);
    assert.ok(text.includes(expected.title), locale);
    for (const part of [...expected.cards, ...expected.today]) assert.ok(text.includes(part), `${locale}: ${part} in ${text}`);
    assert.ok(text.includes('claude-opus') && !text.includes('gpt-5'), locale);
    // The chart CSS ships with the section; the tree's class names become className.
    const style = findNodes(tree, node => node.tag === 'style')[0];
    assert.ok(style.children.includes('.rok-usage-periods') && style.children.includes('.rok-usage-view {') && style.children.includes('cursor-dark'));
    const svg = findNodes(tree, node => node.tag === 'svg')[0];
    assert.equal(svg.props.className, 'rok-usage-svg');
    assert.equal(svg.props.tabIndex, 0);
    assert.equal(svg.props.width, 568);
    const columns = () => findNodes(harness.getTree(), node => node.tag === 'g' && node.props.className === 'rok-usage-col');
    assert.equal(columns().length, 24);
    assert.equal(findNodes(columns()[9], node => node.tag === 'path').length, 1);
    const tabs = findNodes(tree, node => node.tag === 'button' && node.props.role === 'radio');
    assert.deepEqual(tabs.map(node => node.props.children), expected.tabs);
    assert.deepEqual(tabs.map(node => node.props['aria-checked']), ['true', 'false', 'false']);
    // Every count carries its exact value for hover.
    const counts = () => findNodes(harness.getTree(), node => node.component === 'RokUsageCount');
    const totalCount = counts().find(node => node.props.value === 12345);
    assert.equal(totalCount.rendered.props.title, '12,345');
    // The last 30 days: one column a day, both models, the larger first.
    tabs[2].props.onClick();
    harness.rerender();
    const month = collectText(harness.getTree());
    for (const part of expected.month) assert.ok(month.includes(part), `${locale}: ${part} in ${month}`);
    assert.ok(month.indexOf('gpt-5') < month.indexOf('claude-opus'), locale);
    assert.equal(columns().length, 30);
    // gpt-5 keeps series 1 and claude-opus series 2 in every period.
    const swatches = findNodes(harness.getTree(), node => node.tag === 'i' && /rok-usage-swatch/.test(node.props.className ?? '')).map(node => node.props.className);
    assert.deepEqual(swatches.slice(0, 2), ['rok-usage-swatch rok-usage-s1', 'rok-usage-swatch rok-usage-s2']);
    // A long press on a touch screen shows the exact number; a mouse press does not.
    const big = () => counts().find(node => node.props.value === 320000000).rendered;
    big().props.onPointerDown({ pointerType: 'mouse' });
    assert.equal(harness.timers.size, 0);
    big().props.onPointerDown({ pointerType: 'touch' });
    await harness.runNextTimer();
    assert.equal(big().children, '320,000,000');
    assert.equal(big().props.title, '320,000,000');
    big().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    harness.rerender();
    assert.equal(big().children, expected.month[0]);
    harness.unmount();
  }
});

test('RokUsageSettings reports a failed read and stays hidden without the bridge method', async t => {
  const harness = createReactTestHarness();
  t.after(() => harness.unmount());
  const { RokUsageSettings } = await loadExtensionsInVm(harness, { locale: 'en-US', onConnectionChanged: () => () => {}, getUsage: async () => ({ ok: false, status: 503 }) });
  harness.mount(harness.JSX.jsx(RokUsageSettings, {}));
  assert.ok(await harness.waitFor(tree => collectText(tree).includes('Could not load usage')));
  harness.unmount();
  const older = createReactTestHarness();
  t.after(() => older.unmount());
  const { RokUsageSettings: WithoutBridge } = await loadExtensionsInVm(older, { locale: 'en-US', onConnectionChanged: () => () => {} });
  older.mount(older.JSX.jsx(WithoutBridge, {}));
  assert.equal(collectText(older.getTree()), '');
});

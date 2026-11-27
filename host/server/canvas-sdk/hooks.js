// RokBot canvas SDK: host hooks (theme, persisted state, actions).
import { useCallback, useState, useSyncExternalStore } from "react";
import { canvasRadius, canvasTypography, chartColorSequence, chartPalette, varPalette, varTokens } from "./theme.js";

// ---- theme ---------------------------------------------------------------------------------
function readKind() {
  if (typeof document === "undefined") return "dark";
  const t = document.documentElement.dataset.theme;
  if (t === "dark" || t === "light") return t;
  try { return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch { return "light"; }
}

const themeListeners = new Set();
let observer;
function subscribeTheme(fn) {
  themeListeners.add(fn);
  if (!observer && typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    observer = new MutationObserver(() => themeListeners.forEach((l) => l()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => themeListeners.forEach((l) => l())); } catch { /* ignore */ }
  }
  return () => themeListeners.delete(fn);
}

const themeCache = {};
function themeFor(kind) {
  return (themeCache[kind] ??= Object.freeze({
    ...varTokens,
    kind,
    brand: "cursor",
    tokens: varTokens,
    palette: varPalette,
    radius: canvasRadius,
    typography: canvasTypography,
    chart: { palette: chartPalette, sequence: chartColorSequence },
  }));
}

export function useHostTheme() {
  const kind = useSyncExternalStore(subscribeTheme, readKind, () => "dark");
  return themeFor(kind);
}

// ---- persisted state -------------------------------------------------------------------------
// The canvas frame runs in an opaque origin where Web Storage throws, so state lives in memory
// for the life of the page. Storage is still attempted (and ignored on failure) for hosts that
// allow it.
const store = new Map();
const stateListeners = new Map();
const storageKey = () => {
  try { return `rk-canvas-state:${location.pathname}`; } catch { return "rk-canvas-state"; }
};
let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) store.set(k, v);
  } catch { /* opaque origin */ }
}
function persist() {
  try { window.localStorage.setItem(storageKey(), JSON.stringify(Object.fromEntries(store))); } catch { /* opaque origin */ }
}
function subscribeKey(key, fn) {
  let set = stateListeners.get(key);
  if (!set) stateListeners.set(key, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

export function useCanvasState(key, defaultValue) {
  load();
  const k = String(key);
  // A stable copy of the default: callers usually pass a fresh literal on every render.
  const [initial] = useState(() => defaultValue);
  const subscribe = useCallback((fn) => subscribeKey(k, fn), [k]);
  const snapshot = () => (store.has(k) ? store.get(k) : initial);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setValue = useCallback((action) => {
    const prev = store.has(k) ? store.get(k) : initial;
    const next = typeof action === "function" ? action(prev) : action;
    if (Object.is(next, prev) && store.has(k)) return;
    store.set(k, next);
    persist();
    stateListeners.get(k)?.forEach((l) => l());
  }, [k, initial]);
  return [value, setValue];
}

// ---- actions -----------------------------------------------------------------------------------
const dispatch = (action) => {
  try { console.info("[canvas] 当前环境不支持宿主操作，已忽略：", action && action.type); } catch { /* ignore */ }
};
export function useCanvasAction() {
  return dispatch;
}

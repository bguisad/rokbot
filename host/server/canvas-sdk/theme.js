// RokBot canvas SDK: design tokens.
//
// The canvas frame already carries the RokBot Sand tokens (tokens.css) as CSS custom properties
// on :root, switched by `data-theme`. Everything the SDK draws refers to those variables (plus a
// few SDK-specific `--rk-*` variables injected below), so a theme switch repaints without a React
// render. The exported concrete palettes mirror the same values for callers that need hex.

const L = {
  pane: "#ffffff", chrome: "#fcfcfc", sidebar: "#f5f5f5", elevated: "#ffffff",
  t1: "#1c1c1c", t2: "#1c1c1cad", t3: "#1c1c1c8f", t4: "#1c1c1c66",
  f1: "#1c1c1c33", f2: "#1c1c1c24", f3: "#1c1c1c14", f4: "#1c1c1c0a",
  s1: "#1c1c1c3d", s2: "#1c1c1c1f", s3: "#1c1c1c14", focus: "#1e86fc",
  accent: "#1680f3", accentHover: "#126fd4", onAccent: "#ffffff", link: "#0b6dd3",
  addLine: "#14c16f1f", delLine: "#fb2b3e1a", addStrip: "#10ab61", delStrip: "#e72e3b",
};
const D = {
  pane: "#161616", chrome: "#121212", sidebar: "#0e0e0e", elevated: "#1f1f1f",
  t1: "#f5f5f5", t2: "#f5f5f5a8", t3: "#f5f5f58a", t4: "#f5f5f561",
  f1: "#f5f5f533", f2: "#f5f5f524", f3: "#f5f5f514", f4: "#f5f5f50a",
  s1: "#f5f5f538", s2: "#f5f5f51a", s3: "#f5f5f50f", focus: "#1884fc",
  accent: "#116dd2", accentHover: "#1784fb", onAccent: "#ffffff", link: "#4d9bff",
  addLine: "#14c3701f", delLine: "#fc2c3e1f", addStrip: "#0e9f5a", delStrip: "#cf2b35",
};

function paletteOf(c) {
  return Object.freeze({
    foreground: c.t1, foregroundSecondary: c.t2, foregroundTertiary: c.t3, foregroundQuaternary: c.t4,
    editor: c.pane, chrome: c.chrome, sidebar: c.sidebar, elevated: c.elevated,
    fillPrimary: c.f1, fillSecondary: c.f2, fillTertiary: c.f3, fillQuaternary: c.f4,
    strokePrimary: c.s1, strokeSecondary: c.s2, strokeTertiary: c.s3, strokeFocused: c.focus,
    accent: c.accent, buttonBackground: c.accent, buttonForeground: c.onAccent,
    buttonHoverBackground: c.accentHover, link: c.link,
    diffInsertedLine: c.addLine, diffRemovedLine: c.delLine, diffStripAdded: c.addStrip, diffStripRemoved: c.delStrip,
  });
}

export const canvasPaletteDark = paletteOf(D);
export const canvasPaletteLight = paletteOf(L);
// The cloud SDK ships a second brand; RokBot has one look, so both names point at it.
export const canvasPaletteGrokDark = canvasPaletteDark;
export const canvasPaletteGrokLight = canvasPaletteLight;

const COLORS = ["gray", "purple", "green", "yellow", "cyan", "pink", "blue", "orange", "red"];
export const categoryPaletteDark = Object.freeze({
  gray: "#f5f5f58a", purple: "#9d8cf0", green: "#2fbf7a", yellow: "#d9a43a", cyan: "#3fb5c9",
  pink: "#e070a6", blue: "#4d9bff", orange: "#e8834a", red: "#ff6463",
});
export const categoryPaletteLight = Object.freeze({
  gray: "#1c1c1c8f", purple: "#6a52d6", green: "#00854a", yellow: "#b57d00", cyan: "#0e879b",
  pink: "#c23f84", blue: "#0b6dd3", orange: "#c8571f", red: "#cd2834",
});
export const categoryPaletteGrokDark = categoryPaletteDark;
export const categoryPaletteGrokLight = categoryPaletteLight;
export const colorPalette = categoryPaletteDark;
export const usageColorSequence = Object.freeze(["gray", "purple", "green", "yellow", "pink", "blue", "orange", "cyan", "red"]);

// Categorical chart series (fixed order, stepped per theme).
const CHART_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const CHART_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#2f9e2f", "#9085e9", "#e66767"];
export const chartColorSequence = Object.freeze(CHART_DARK.map((_, i) => `var(--rk-chart-${i + 1})`));
export const chartPalette = Object.freeze({
  green: "#199e70", darkGreen: "#2f9e2f", lightGreen: "#3fbf8f", mintGreen: "#7dcab0",
  blue: "#3987e5", lightBlue: "#70b0e8", indigo: "#6a6fe0", lightIndigo: "#9aaadc",
  purple: "#9085e9", lightPurple: "#aa98d8", warmPink: "#d55181", lightPink: "#e87ba4",
  brightOrange: "#eb6834", deepOrange: "#d95926", goldenYellow: "#eda100", darkAmber: "#c98500",
  warmPeach: "#f0a088", vibrantTeal: "#1baf7a", muted: "#8a8a8a", neutralLine: "#8a8a8a",
});

function tokensOf(c, category) {
  return {
    bg: { editor: c.pane, chrome: c.chrome, elevated: c.elevated },
    text: { primary: c.t1, secondary: c.t2, tertiary: c.t3, quaternary: c.t4, link: c.link, onAccent: c.onAccent },
    stroke: { primary: c.s1, secondary: c.s2, tertiary: c.s3, focused: c.focus },
    fill: { primary: c.f1, secondary: c.f2, tertiary: c.f3, quaternary: c.f4 },
    accent: { primary: c.accent, control: c.accent, controlHover: c.accentHover },
    diff: { insertedLine: c.addLine, removedLine: c.delLine, stripAdded: c.addStrip, stripRemoved: c.delStrip },
    category,
  };
}
export const canvasTokens = tokensOf(D, categoryPaletteDark);
export const canvasTokensLight = tokensOf(L, categoryPaletteLight);

// Theme-following tokens: CSS variable references.
const V = {
  pane: "var(--sand-bg-pane)", chrome: "var(--sand-bg-chrome)", sidebar: "var(--sand-bg-sidebar)", elevated: "var(--sand-bg-elevated)",
  t1: "var(--sand-text-primary)", t2: "var(--sand-text-secondary)", t3: "var(--sand-text-tertiary)", t4: "var(--sand-text-quaternary)",
  f1: "var(--rk-fill-1)", f2: "var(--rk-fill-2)", f3: "var(--rk-fill-3)", f4: "var(--rk-fill-4)",
  s1: "var(--sand-border-primary-translucent)", s2: "var(--sand-border-secondary-translucent)", s3: "var(--sand-border-tertiary-translucent)",
  focus: "var(--sand-border-focus-primary)", accent: "var(--sand-bg-accent-primary)", accentHover: "var(--sand-bg-accent-primary-hover)",
  onAccent: "var(--rk-on-accent)", link: "var(--sand-text-accent-primary)",
  addLine: "var(--rk-diff-add)", delLine: "var(--rk-diff-del)", addStrip: "var(--rk-diff-add-strip)", delStrip: "var(--rk-diff-del-strip)",
};
export const categoryVars = Object.freeze(Object.fromEntries(COLORS.map((k) => [k, `var(--rk-cat-${k})`])));
export const varPalette = paletteOf(V);
export const varTokens = tokensOf(V, categoryVars);

// Semantic tones shared by Stat / Callout / charts / Table rowTone.
export const toneText = {
  success: "var(--sand-text-success-primary)", danger: "var(--sand-text-danger-primary)",
  warning: "var(--sand-text-warn-primary)", info: "var(--sand-text-accent-primary)", neutral: "var(--sand-text-secondary)",
};
export const toneMark = {
  success: "var(--rk-tone-success)", danger: "var(--rk-tone-danger)", warning: "var(--rk-tone-warning)",
  info: "var(--rk-tone-info)", neutral: "var(--sand-text-tertiary)",
};
export const toneBg = {
  success: "var(--sand-bg-success-secondary)", danger: "var(--sand-bg-danger-secondary)", warning: "var(--sand-bg-warn-secondary)",
  info: "var(--sand-bg-accent-secondary)", neutral: "var(--sand-bg-secondary)",
};

export const canvasTypography = {
  fontFamily: "inherit",
  h1: { fontSize: "24px", lineHeight: "30px", fontWeight: 600 },
  h2: { fontSize: "18px", lineHeight: "24px", fontWeight: 600 },
  h3: { fontSize: "15px", lineHeight: "22px", fontWeight: 600 },
  body: { fontSize: "14px", lineHeight: "20px", fontWeight: 400 },
  small: { fontSize: "12px", lineHeight: "16px", fontWeight: 400 },
};
export const canvasSpacing = { "0.5": 2, "1": 4, "1.5": 6, "2": 8, "2.5": 10, "3": 12, "3.5": 14, "4": 16, "4.5": 18, "5": 20, "6": 24, "7": 28, "8": 32, "9": 36, "10": 40 };
export const canvasRadius = { none: 0, xs: 2, sm: 4, md: 6, lg: 8, xl: 12, full: 9999 };

const FONT_MONO = "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)";
export const MONO = FONT_MONO;

function varBlock(c, cat, chart, tones) {
  return [
    `--rk-fill-1:${c.f1};--rk-fill-2:${c.f2};--rk-fill-3:${c.f3};--rk-fill-4:${c.f4};--rk-on-accent:${c.onAccent};`,
    `--rk-diff-add:${c.addLine};--rk-diff-del:${c.delLine};--rk-diff-add-strip:${c.addStrip};--rk-diff-del-strip:${c.delStrip};`,
    COLORS.map((k) => `--rk-cat-${k}:${cat[k]};`).join(""),
    chart.map((v, i) => `--rk-chart-${i + 1}:${v};`).join(""),
    `--rk-tone-success:${tones[0]};--rk-tone-danger:${tones[1]};--rk-tone-warning:${tones[2]};--rk-tone-info:${tones[3]};`,
  ].join("");
}

const CSS = `
:root{${varBlock(L, categoryPaletteLight, CHART_LIGHT, ["#10ab61", "#e34948", "#e09100", "#2a78d6"])}}
:root[data-theme="dark"]{${varBlock(D, categoryPaletteDark, CHART_DARK, ["#18a96a", "#e66767", "#d08a10", "#3987e5"])}}
body{font-family:var(--font-sans,system-ui,sans-serif)}
#root>:not(.rk-page):not(#rk-canvas-error){padding:24px}
.rk-btn,.rk-pill,.rk-ib,.rk-tog,.rk-row-btn,.rk-cs-head{transition:background-color var(--duration-fast,120ms),border-color var(--duration-fast,120ms),opacity var(--duration-fast,120ms)}
.rk-btn:focus-visible,.rk-pill:focus-visible,.rk-ib:focus-visible,.rk-tog:focus-visible,.rk-row-btn:focus-visible,.rk-cs-head:focus-visible,.rk-chk:focus-visible,.rk-link:focus-visible{outline:2px solid var(--sand-border-focus-primary);outline-offset:1px}
.rk-btn:disabled,.rk-pill:disabled,.rk-ib:disabled,.rk-tog:disabled,.rk-in:disabled,.rk-chk:disabled{opacity:.45;cursor:not-allowed}
.rk-btn-primary{background:var(--sand-bg-accent-primary);color:var(--rk-on-accent)}
.rk-btn-primary:not(:disabled):hover{background:var(--sand-bg-accent-primary-hover)}
.rk-btn-secondary{background:var(--sand-bg-secondary);color:var(--sand-text-primary);border-color:var(--sand-border-secondary-translucent)!important}
.rk-btn-secondary:not(:disabled):hover{background:var(--sand-bg-secondary-hover)}
.rk-btn-ghost{background:transparent;color:var(--sand-text-secondary)}
.rk-btn-ghost:not(:disabled):hover,.rk-ib:not(:disabled):hover,.rk-row-btn:hover,.rk-cs-head:hover{background:var(--sand-bg-hover);color:var(--sand-text-primary)}
.rk-pill{background:transparent;color:var(--sand-text-secondary)}
.rk-pill.rk-click:not(:disabled):hover{background:var(--sand-bg-hover);color:var(--sand-text-primary)}
.rk-pill.rk-on{background:var(--sand-bg-primary);color:var(--sand-text-inverted);border-color:transparent!important}
.rk-pill.rk-on.rk-click:not(:disabled):hover{background:var(--sand-bg-primary-hover);color:var(--sand-text-inverted)}
.rk-ib{background:transparent}
.rk-ib-circle{background:var(--sand-bg-secondary)}
.rk-ib-circle:not(:disabled):hover{background:var(--sand-bg-secondary-hover)}
.rk-in{appearance:none;-webkit-appearance:none;width:100%;margin:0;border:1px solid var(--sand-border-secondary-translucent);background:var(--sand-bg-elevated);color:var(--sand-text-primary);border-radius:var(--radius-sm,6px);font:inherit;font-size:13px;line-height:18px;outline:none}
.rk-in::placeholder{color:var(--sand-text-quaternary)}
.rk-in:not(:disabled):hover{border-color:var(--sand-border-primary-translucent)}
.rk-in:focus{border-color:var(--sand-border-focus-primary)}
select.rk-in{background-image:var(--sand-chevron);background-repeat:no-repeat;background-position:right 6px center;background-size:16px 16px;padding-right:26px;cursor:pointer}
select.rk-in option{background:var(--sand-bg-elevated);color:var(--sand-text-primary)}
.rk-chk{appearance:none;-webkit-appearance:none;flex:none;width:14px;height:14px;margin:0;border:1px solid var(--sand-border-primary-translucent);border-radius:4px;background:var(--sand-bg-elevated);cursor:pointer;display:inline-grid;place-content:center}
.rk-chk:checked{background:var(--sand-bg-accent-primary);border-color:var(--sand-bg-accent-primary)}
.rk-chk:checked::after{content:"";width:8px;height:4px;border:solid #fff;border-width:0 0 1.6px 1.6px;transform:translateY(-1px) rotate(-45deg)}
.rk-link{color:var(--sand-text-accent-primary);text-decoration:none}
.rk-link:hover{text-decoration:underline}
.rk-tr-hover:hover>td{background:var(--sand-bg-hover)}
`;

export function injectStyles() {
  if (typeof document === "undefined" || document.getElementById("rk-canvas-sdk-style")) return;
  try {
    const el = document.createElement("style");
    el.id = "rk-canvas-sdk-style";
    el.textContent = CSS;
    (document.head || document.documentElement).prepend(el);
  } catch { /* ignore */ }
}

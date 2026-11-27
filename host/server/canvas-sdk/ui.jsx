// RokBot canvas SDK: layout, typography, surfaces, actions and feedback primitives.
import { Children, createContext, useContext, useState } from "react";
import { MONO, toneBg, toneMark, toneText } from "./theme.js";

export function mergeStyle(base, override) {
  return { ...(base || {}), ...(override || {}) };
}

const ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", "space-between": "space-between" };
const T1 = "var(--sand-text-primary)";
const T2 = "var(--sand-text-secondary)";
const T3 = "var(--sand-text-tertiary)";
const S2 = "var(--sand-border-secondary-translucent)";
const S3 = "var(--sand-border-tertiary-translucent)";

// ---- layout ----------------------------------------------------------------------------------
export function Page({ title, subtitle, children, style }) {
  return (
    <div className="rk-page" style={mergeStyle({ maxWidth: 1100, margin: "0 auto", padding: "32px 28px 56px", display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }, style)}>
      {title != null || subtitle != null ? (
        <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {title != null ? <H1>{title}</H1> : null}
          {subtitle != null ? <Text tone="secondary">{subtitle}</Text> : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}

export function Stack({ children, gap = 12, style }) {
  return <div style={mergeStyle({ display: "flex", flexDirection: "column", gap, minWidth: 0 }, style)}>{children}</div>;
}

export function Row({ children, gap = 8, align = "center", justify = "start", wrap = false, style }) {
  return (
    <div style={mergeStyle({ display: "flex", flexDirection: "row", gap, alignItems: ALIGN[align] || align, justifyContent: ALIGN[justify] || justify, flexWrap: wrap ? "wrap" : "nowrap", minWidth: 0 }, style)}>
      {children}
    </div>
  );
}

export function Grid({ children, columns = 2, gap = 12, align = "stretch", style }) {
  const tpl = typeof columns === "number" ? `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` : columns;
  return <div style={mergeStyle({ display: "grid", gridTemplateColumns: tpl, gap, alignItems: ALIGN[align] || align, minWidth: 0 }, style)}>{children}</div>;
}

export function Divider({ style }) {
  return <hr style={mergeStyle({ border: 0, borderTop: `1px solid ${S3}`, margin: 0, width: "100%", flex: "none" }, style)} />;
}

export function Spacer() {
  return <div aria-hidden="true" style={{ flex: "1 1 auto", minWidth: 0 }} />;
}

// ---- typography ------------------------------------------------------------------------------
const InText = createContext(false);
const WEIGHT = { normal: 400, medium: 500, semibold: 600, bold: 700 };
const TONE = { primary: T1, secondary: T2, tertiary: T3, quaternary: "var(--sand-text-quaternary)" };

// Inline markdown inside string children: `code`, [label](url), **bold**.
const MD = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*/g;
function renderInline(node) {
  if (typeof node !== "string" || !/[`[*]/.test(node)) return node;
  const out = [];
  let last = 0;
  let m;
  MD.lastIndex = 0;
  while ((m = MD.exec(node))) {
    if (m.index > last) out.push(node.slice(last, m.index));
    if (m[1] != null) out.push(<Code key={m.index}>{m[1]}</Code>);
    else if (m[2] != null) out.push(<Link key={m.index} href={m[3]}>{m[2]}</Link>);
    else out.push(<strong key={m.index} style={{ fontWeight: 600 }}>{m[4]}</strong>);
    last = MD.lastIndex;
  }
  if (!out.length) return node;
  if (last < node.length) out.push(node.slice(last));
  return out;
}
const withInline = (children) => Children.map(children, renderInline);

export function Text({ children, tone = "primary", size = "body", as, weight = "normal", italic = false, truncate = false, style }) {
  const nested = useContext(InText);
  const Tag = as || (nested ? "span" : "p");
  const small = size === "small";
  const base = {
    margin: 0,
    color: nested && tone === "primary" && !style?.color ? undefined : TONE[tone] || T1,
    fontSize: nested ? undefined : small ? 12 : 14,
    lineHeight: nested ? undefined : small ? "16px" : "20px",
    fontWeight: WEIGHT[weight] || 400,
    fontStyle: italic ? "italic" : undefined,
  };
  if (nested && small) { base.fontSize = 12; }
  if (truncate) Object.assign(base, { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", display: Tag === "span" ? "inline-block" : "block", maxWidth: "100%", minWidth: 0 });
  if (truncate === "start") Object.assign(base, { direction: "rtl", textAlign: "left" });
  const content = truncate === "start" ? <bdi>{withInline(children)}</bdi> : withInline(children);
  return <InText.Provider value={true}><Tag style={mergeStyle(base, style)}>{content}</Tag></InText.Provider>;
}

function heading(Tag, size, line) {
  return function Heading({ children, style }) {
    return (
      <InText.Provider value={true}>
        <Tag style={mergeStyle({ margin: 0, color: T1, fontSize: size, lineHeight: line, fontWeight: 600, letterSpacing: size >= 18 ? "-0.01em" : undefined }, style)}>{withInline(children)}</Tag>
      </InText.Provider>
    );
  };
}
export const H1 = heading("h1", 24, "30px");
export const H2 = heading("h2", 18, "24px");
export const H3 = heading("h3", 15, "22px");

export function Code({ children, style }) {
  const text = Children.toArray(children).join("");
  const block = typeof text === "string" && text.includes("\n");
  if (block) {
    return (
      <pre style={mergeStyle({ margin: 0, padding: "10px 12px", fontFamily: MONO, fontSize: 12, lineHeight: "18px", color: T1, background: "var(--rk-fill-4)", border: `1px solid ${S3}`, borderRadius: 8, overflowX: "auto", whiteSpace: "pre", tabSize: 2 }, style)}>
        <code>{children}</code>
      </pre>
    );
  }
  return (
    <code style={mergeStyle({ fontFamily: MONO, fontSize: "0.92em", padding: "1px 5px", borderRadius: 4, background: "var(--rk-fill-3)", color: T1, overflowWrap: "anywhere" }, style)}>{children}</code>
  );
}

export function Link({ children, href, style }) {
  return <a className="rk-link" href={href} target="_blank" rel="noopener noreferrer" style={style}>{children ?? href}</a>;
}

// ---- surfaces --------------------------------------------------------------------------------
export function CanvasChevron({ expanded }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: "none", transition: "transform 120ms", transform: expanded ? "rotate(90deg)" : "none" }}>
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const CardCtx = createContext(null);

export function Card({ children, variant = "default", size = "base", stickyHeader = false, collapsible = false, defaultOpen = true, open: openProp, onOpenChange, style }) {
  const [inner, setInner] = useState(defaultOpen);
  const open = !collapsible || (openProp !== undefined ? openProp : inner);
  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setInner(next);
    onOpenChange?.(next);
  };
  const ctx = { size, stickyHeader, collapsible, open, toggle, borderless: variant === "borderless" };
  const border = variant === "borderless" ? "none" : `1px solid ${S2}`;
  return (
    <CardCtx.Provider value={ctx}>
      <section style={mergeStyle({ border, borderRadius: variant === "borderless" ? 0 : 12, background: variant === "borderless" ? "transparent" : "var(--sand-bg-elevated)", minWidth: 0, display: "flex", flexDirection: "column", overflow: stickyHeader ? "visible" : "hidden" }, style)}>
        {children}
      </section>
    </CardCtx.Provider>
  );
}

export function CardHeader({ children, trailing, style }) {
  const ctx = useContext(CardCtx) || {};
  const lg = ctx.size === "lg";
  const base = {
    display: "flex", alignItems: "center", gap: 8, minHeight: lg ? 40 : 34, padding: ctx.borderless ? "0 0 4px" : lg ? "6px 16px" : "4px 12px",
    fontSize: lg ? 13 : 12, lineHeight: "16px", fontWeight: 500, color: T2, width: "100%", boxSizing: "border-box", textAlign: "left",
    borderBottom: ctx.open && !ctx.borderless ? `1px solid ${S3}` : "none", background: ctx.stickyHeader ? "var(--sand-bg-elevated)" : "transparent",
    borderRadius: ctx.stickyHeader ? "12px 12px 0 0" : undefined,
    ...(ctx.stickyHeader ? { position: "sticky", top: 0, zIndex: 1 } : null),
  };
  const label = <span style={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{children}</span>;
  const tail = trailing != null ? <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 6, color: T3, fontWeight: 400 }}>{trailing}</span> : null;
  if (ctx.collapsible) {
    return (
      <div style={mergeStyle(base, mergeStyle({ padding: 0 }, style))}>
        <button type="button" className="rk-row-btn" aria-expanded={ctx.open} onClick={ctx.toggle}
          style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flex: "1 1 auto", minWidth: 0, alignSelf: "stretch", padding: lg ? "0 0 0 12px" : "0 0 0 8px", color: T2, borderRadius: 0 }}>
          <span style={{ color: T3, display: "inline-flex" }}><CanvasChevron expanded={ctx.open} /></span>
          <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{ctx.open ? "收起" : "展开"}</span>
          {label}
        </button>
        {tail ? <span style={{ padding: lg ? "0 16px 0 8px" : "0 12px 0 8px", display: "inline-flex" }}>{tail}</span> : null}
      </div>
    );
  }
  return <div style={mergeStyle(base, style)}>{label}{tail}</div>;
}

export function CardBody({ children, style }) {
  const ctx = useContext(CardCtx) || {};
  if (ctx.collapsible && !ctx.open) return null;
  const pad = ctx.borderless ? "4px 0 0" : ctx.size === "lg" ? 16 : "12px 14px";
  return <div style={mergeStyle({ padding: pad, fontSize: 13, lineHeight: "20px", color: T1, minWidth: 0 }, style)}>{withInline(children)}</div>;
}

// ---- table -----------------------------------------------------------------------------------
function columnLabel(c) {
  if (c && typeof c === "object" && !("$$typeof" in c)) return c.header ?? c.label ?? c.title ?? c.key;
  return c;
}

export function Table({ headers, columns, rows = [], columnAlign, rowTone, framed = true, striped = false, stickyHeader = false, style, emptyMessage }) {
  const cols = headers ?? (columns || []).map(columnLabel);
  const keys = (columns || []).map((c) => (c && typeof c === "object" && !("$$typeof" in c) ? c.key ?? c.id : undefined));
  const aligns = columnAlign ?? (columns || []).map((c) => (c && typeof c === "object" ? c.align : undefined));
  const n = cols.length || (rows[0] ? (Array.isArray(rows[0]) ? rows[0].length : Object.keys(rows[0]).length) : 1);
  const cellsOf = (row) => {
    if (Array.isArray(row)) return Array.from({ length: n }, (_, i) => row[i]);
    if (row && typeof row === "object") return Array.from({ length: n }, (_, i) => row[keys[i] ?? i]);
    return [row];
  };
  const th = (i) => ({
    textAlign: aligns?.[i] || "left", padding: "8px 12px", fontSize: 12, lineHeight: "16px", fontWeight: 500, color: T3, whiteSpace: "nowrap",
    borderBottom: `1px solid ${S2}`, background: framed || stickyHeader ? "var(--sand-bg-elevated)" : "transparent", ...(stickyHeader ? { position: "sticky", top: 0, zIndex: 1 } : null),
  });
  const td = (i, last) => ({
    textAlign: aligns?.[i] || "left", padding: "8px 12px", fontSize: 13, lineHeight: "18px", color: T1, verticalAlign: "top",
    borderBottom: last ? "none" : `1px solid ${S3}`, fontVariantNumeric: "tabular-nums",
  });
  const table = (
    <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
      {cols.length ? (
        <thead><tr>{cols.map((h, i) => <th key={i} scope="col" style={th(i)}>{h}</th>)}</tr></thead>
      ) : null}
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={n} style={{ padding: "20px 12px", textAlign: "center", color: T3, fontSize: 13 }}>{emptyMessage ?? "暂无数据"}</td></tr>
        ) : rows.map((row, r) => {
          const tone = rowTone?.[r];
          return (
            <tr key={r} style={striped && r % 2 === 1 ? { background: "var(--rk-fill-4)" } : undefined}>
              {cellsOf(row).map((cell, i) => (
                <td key={i} style={td(i, r === rows.length - 1)}>
                  {i === 0 && tone ? (
                    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
                      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 3, background: toneMark[tone] || toneMark.neutral, flex: "none", transform: "translateY(-1px)" }} />
                      <span>{renderInline(cell)}</span>
                    </span>
                  ) : renderInline(cell ?? "")}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  if (!framed) return <div style={mergeStyle({ overflowX: "auto", minWidth: 0 }, style)}>{table}</div>;
  return (
    <div style={mergeStyle({ border: `1px solid ${S2}`, borderRadius: 10, overflow: "auto", minWidth: 0, background: "var(--sand-bg-elevated)", ...(stickyHeader ? { maxHeight: 480 } : null) }, style)}>
      {table}
    </div>
  );
}

// ---- actions ---------------------------------------------------------------------------------
export function Button({ children, variant = "secondary", disabled = false, type = "button", style, onClick }) {
  const v = variant === "primary" || variant === "ghost" ? variant : "secondary";
  return (
    <button type={type} disabled={disabled} onClick={onClick ? () => onClick() : undefined} className={`rk-btn rk-btn-${v}`}
      style={mergeStyle({ appearance: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, height: 24, padding: "0 10px", border: "1px solid transparent", borderRadius: 6, font: "inherit", fontSize: 12, lineHeight: "16px", fontWeight: 500, whiteSpace: "nowrap", cursor: "pointer", flex: "none", alignSelf: "flex-start" }, style)}>
      {children}
    </button>
  );
}

export function Pill({ children, active = false, size = "md", leadingContent, keyboardHint, disabled = false, title, style, onClick }) {
  const sm = size === "sm";
  const Tag = onClick ? "button" : "span";
  return (
    <Tag type={onClick ? "button" : undefined} title={title} disabled={onClick ? disabled : undefined} onClick={onClick && !disabled ? () => onClick() : undefined}
      aria-pressed={onClick ? active : undefined}
      className={`rk-pill${active ? " rk-on" : ""}${onClick ? " rk-click" : ""}`}
      style={mergeStyle({
        appearance: "none", display: "inline-flex", alignItems: "center", gap: 5, height: sm ? 18 : 24, padding: sm ? "0 7px" : "0 10px",
        borderRadius: 9999, border: sm ? "1px solid transparent" : `1px solid ${S2}`, background: sm && !active ? "var(--sand-bg-secondary)" : undefined,
        font: "inherit", fontSize: sm ? 11 : 12, lineHeight: "16px", fontWeight: 500, whiteSpace: "nowrap", cursor: onClick ? "pointer" : "default", flex: "none",
        opacity: disabled && !onClick ? 0.45 : undefined, verticalAlign: "middle",
      }, style)}>
      {leadingContent != null ? <span style={{ display: "inline-flex", alignItems: "center" }}>{leadingContent}</span> : null}
      <span>{children}</span>
      {keyboardHint ? <span style={{ opacity: 0.6, fontWeight: 400 }}>{keyboardHint}</span> : null}
    </Tag>
  );
}

// ---- feedback --------------------------------------------------------------------------------
export function Stat({ value, label, tone, style }) {
  return (
    <div style={mergeStyle({ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }, style)}>
      <div style={{ fontSize: 22, lineHeight: "28px", fontWeight: 600, color: tone ? toneText[tone] : T1, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em", overflowWrap: "anywhere" }}>{value}</div>
      <div style={{ fontSize: 12, lineHeight: "16px", color: T3 }}>{label}</div>
    </div>
  );
}

export function ToneIcon({ tone, color }) {
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, style: { flex: "none", color } };
  const stroke = { stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" };
  if (tone === "warning") {
    return <svg {...common}><path d="M8 2.2 14.2 13H1.8z" {...stroke} /><path d="M8 6.5v3" {...stroke} /><circle cx="8" cy="11.3" r=".8" fill="currentColor" /></svg>;
  }
  if (tone === "success") {
    return <svg {...common}><circle cx="8" cy="8" r="6.2" {...stroke} /><path d="m5.3 8.2 1.8 1.8 3.6-3.8" {...stroke} /></svg>;
  }
  if (tone === "danger") {
    return <svg {...common}><circle cx="8" cy="8" r="6.2" {...stroke} /><path d="M8 4.8v3.6" {...stroke} /><circle cx="8" cy="10.9" r=".8" fill="currentColor" /></svg>;
  }
  return <svg {...common}><circle cx="8" cy="8" r="6.2" {...stroke} /><path d="M8 7.4v3.6" {...stroke} /><circle cx="8" cy="5.1" r=".8" fill="currentColor" /></svg>;
}

export function Callout({ children, tone = "info", title, icon, style }) {
  const t = toneBg[tone] ? tone : "info";
  return (
    <div role={t === "danger" || t === "warning" ? "alert" : "note"}
      style={mergeStyle({ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: toneBg[t], minWidth: 0 }, style)}>
      <span style={{ display: "inline-flex", paddingTop: 2, color: toneMark[t] }}>{icon ?? <ToneIcon tone={t} color={t === "neutral" ? T3 : toneMark[t]} />}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
        {title != null ? <div style={{ fontSize: 13, lineHeight: "20px", fontWeight: 600, color: t === "neutral" ? T1 : toneText[t] }}>{title}</div> : null}
        {children != null ? <div style={{ fontSize: 13, lineHeight: "20px", color: T1 }}>{withInline(children)}</div> : null}
      </div>
    </div>
  );
}

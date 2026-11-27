// RokBot canvas SDK: diff, todo list, usage bar, swatch, collapsible section.
import { useState } from "react";
import { categoryVars, MONO, usageColorSequence } from "./theme.js";
import { CanvasChevron, mergeStyle } from "./ui.jsx";

const T1 = "var(--sand-text-primary)";
const T3 = "var(--sand-text-tertiary)";
const S2 = "var(--sand-border-secondary-translucent)";
const S3 = "var(--sand-border-tertiary-translucent)";
const GREEN = "var(--sand-text-success-primary)";
const RED = "var(--sand-text-danger-primary)";

// ---- diff ------------------------------------------------------------------------------------
export function DiffStats({ additions = 0, deletions = 0, style }) {
  if (!additions && !deletions) return null;
  return (
    <span style={mergeStyle({ display: "inline-flex", gap: 6, fontFamily: MONO, fontSize: 12, lineHeight: "16px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }, style)}>
      {additions ? <span style={{ color: GREEN }}>+{additions}</span> : null}
      {deletions ? <span style={{ color: RED }}>-{deletions}</span> : null}
    </span>
  );
}

export function DiffView({ lines = [], showLineNumbers = true, coloredLineNumbers = true, showAccentStrip = true, style }) {
  const digits = Math.max(2, String(lines.reduce((m, l) => Math.max(m, l.lineNumber ?? 0), 0)).length);
  return (
    <div role="table" style={mergeStyle({ fontFamily: MONO, fontSize: 12, lineHeight: "20px", overflowX: "auto", color: T1, minWidth: 0 }, style)}>
      <div style={{ display: "inline-block", minWidth: "100%" }}>
        {lines.map((l, i) => {
          const add = l.type === "added";
          const del = l.type === "removed";
          return (
            <div key={i} role="row" style={{ display: "flex", background: add ? "var(--rk-diff-add)" : del ? "var(--rk-diff-del)" : "transparent" }}>
              {showAccentStrip ? <span aria-hidden="true" style={{ flex: "none", width: 3, background: add ? "var(--rk-diff-add-strip)" : del ? "var(--rk-diff-del-strip)" : "transparent" }} /> : null}
              {showLineNumbers ? (
                <span style={{ flex: "none", width: `${digits + 2}ch`, padding: "0 8px 0 4px", textAlign: "right", userSelect: "none", color: coloredLineNumbers && add ? GREEN : coloredLineNumbers && del ? RED : "var(--sand-text-quaternary)" }}>
                  {l.lineNumber ?? ""}
                </span>
              ) : null}
              <span style={{ whiteSpace: "pre", padding: "0 12px 0 8px", flex: "1 0 auto" }}>{l.content === "" ? " " : l.content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- todo list -------------------------------------------------------------------------------
function StatusIcon({ status }) {
  const p = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, style: { flex: "none", marginTop: 2 } };
  if (status === "completed") {
    return <svg {...p}><circle cx="8" cy="8" r="6.5" style={{ fill: "var(--rk-tone-success)" }} /><path d="m5.2 8.2 1.9 1.9 3.7-3.9" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (status === "in_progress") {
    return <svg {...p}><circle cx="8" cy="8" r="6" style={{ stroke: "var(--sand-bg-accent-primary)" }} strokeWidth="1.4" /><path d="M8 4a4 4 0 0 1 0 8z" style={{ fill: "var(--sand-bg-accent-primary)" }} /></svg>;
  }
  if (status === "cancelled") {
    return <svg {...p}><circle cx="8" cy="8" r="6" style={{ stroke: "var(--sand-text-quaternary)" }} strokeWidth="1.4" /><path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" style={{ stroke: "var(--sand-text-quaternary)" }} strokeWidth="1.4" strokeLinecap="round" /></svg>;
  }
  return <svg {...p}><circle cx="8" cy="8" r="6" style={{ stroke: "var(--sand-text-quaternary)" }} strokeWidth="1.4" /></svg>;
}

const STATUS_LABEL = { pending: "待处理", in_progress: "进行中", completed: "已完成", cancelled: "已取消" };

export function TodoList({ todos = [], dimmedTodoIds, onTodoClick, style }) {
  if (!todos.length) return null;
  return (
    <div role="list" style={mergeStyle({ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }, style)}>
      {todos.map((t) => {
        const done = t.status === "completed" || t.status === "cancelled";
        const dim = dimmedTodoIds?.has?.(t.id);
        return (
          <button key={t.id} type="button" role="listitem" className="rk-row-btn" title={STATUS_LABEL[t.status]} onClick={() => onTodoClick?.(t)}
            style={{ all: "unset", boxSizing: "border-box", display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 6px", borderRadius: 6, cursor: onTodoClick ? "pointer" : "default", opacity: dim ? 0.45 : 1 }}>
            <StatusIcon status={t.status} />
            <span style={{ fontSize: 13, lineHeight: "20px", color: done ? T3 : T1, textDecoration: done ? "line-through" : "none", overflowWrap: "anywhere", minWidth: 0 }}>{t.content}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TodoListCard({ todos = [], dimmedTodoIds, defaultExpanded = true, onTodoClick, style }) {
  const [open, setOpen] = useState(defaultExpanded);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <section style={mergeStyle({ border: `1px solid ${S2}`, borderRadius: 12, background: "var(--sand-bg-elevated)", overflow: "hidden" }, style)}>
      <button type="button" className="rk-row-btn" aria-expanded={open} onClick={() => setOpen(!open)}
        style={{ all: "unset", boxSizing: "border-box", width: "100%", display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 12px", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "var(--sand-text-secondary)", borderBottom: open ? `1px solid ${S3}` : "none" }}>
        <span style={{ color: T3, display: "inline-flex" }}><CanvasChevron expanded={open} /></span>
        <span>待办</span>
        <span style={{ color: T3, fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>{done} / {todos.length} 已完成</span>
      </button>
      {open ? <TodoList todos={todos} dimmedTodoIds={dimmedTodoIds} onTodoClick={onTodoClick} style={{ padding: 6 }} /> : null}
    </section>
  );
}

// ---- usage bar -------------------------------------------------------------------------------
export function UsageBar({ segments = [], total, topLeftLabel, topRightLabel, style }) {
  const vals = segments.map((s) => (Number.isFinite(s.value) && s.value > 0 ? s.value : 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  const tot = Math.max(Number.isFinite(total) ? total : 0, sum) || 1;
  const rest = Math.max(0, tot - sum);
  return (
    <div style={mergeStyle({ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }, style)}>
      {topLeftLabel != null || topRightLabel != null ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, lineHeight: "16px" }}>
          <span style={{ color: "var(--sand-text-secondary)" }}>{topLeftLabel}</span>
          <span style={{ color: T3, fontVariantNumeric: "tabular-nums" }}>{topRightLabel}</span>
        </div>
      ) : null}
      <div role="img" aria-label={`${Math.round((sum / tot) * 100)}%`} style={{ display: "flex", gap: 2, height: 8, width: "100%" }}>
        {segments.map((s, i) => vals[i] > 0 ? (
          <span key={s.id} title={String(s.id)} style={{ flex: `${vals[i]} 1 0`, minWidth: 2, borderRadius: 2, background: categoryVars[s.color] || categoryVars[usageColorSequence[i % usageColorSequence.length]] }} />
        ) : null)}
        {rest > 0 ? <span style={{ flex: `${rest} 1 0`, borderRadius: 2, background: "var(--rk-fill-3)" }} /> : null}
      </div>
    </div>
  );
}

// ---- swatch ----------------------------------------------------------------------------------
export function Swatch({ color = "gray", style }) {
  const c = categoryVars[color] || categoryVars.gray;
  return (
    <span aria-hidden="true" style={mergeStyle({ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: 24, height: 24, borderRadius: 6, overflow: "hidden" }, style)}>
      <span style={{ position: "absolute", inset: 0, background: c, opacity: 0.18 }} />
      <span style={{ position: "relative", width: 10, height: 10, borderRadius: 3, background: c }} />
    </span>
  );
}

// ---- collapsible section ---------------------------------------------------------------------
export function CollapsibleSection({ title, leading, count, trailing, children, defaultOpen = false, style }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={mergeStyle({ display: "flex", flexDirection: "column", minWidth: 0 }, style)}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <button type="button" className="rk-cs-head" aria-expanded={open} aria-label={`${open ? "收起" : "展开"}：${title}`} onClick={() => setOpen(!open)}
          style={{ all: "unset", boxSizing: "border-box", display: "flex", alignItems: "center", gap: 8, flex: "1 1 auto", minWidth: 0, minHeight: 32, padding: "4px 6px", borderRadius: 6, cursor: "pointer" }}>
          <span style={{ color: T3, display: "inline-flex" }}><CanvasChevron expanded={open} /></span>
          {leading != null ? <span style={{ display: "inline-flex", flex: "none" }}>{leading}</span> : null}
          <span style={{ fontSize: 13, lineHeight: "18px", fontWeight: 500, color: T1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{title}</span>
          {count != null ? <span style={{ fontSize: 12, color: T3, fontVariantNumeric: "tabular-nums", flex: "none" }}>{count}</span> : null}
        </button>
        {trailing != null ? <span style={{ flex: "none", color: T3, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6, paddingRight: 6 }}>{trailing}</span> : null}
      </div>
      {open ? <div style={{ padding: "4px 0 8px 26px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>{children}</div> : null}
    </div>
  );
}

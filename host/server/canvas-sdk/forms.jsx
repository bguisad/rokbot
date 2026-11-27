// RokBot canvas SDK: form controls. `onChange` receives the value, not the DOM event.
// Each control works controlled (`value`/`checked` set) or uncontrolled (internal state).
import { useLayoutEffect, useRef, useState } from "react";
import { mergeStyle } from "./ui.jsx";

function useControllable(prop, fallback, onChange) {
  const [inner, setInner] = useState(fallback);
  const controlled = prop !== undefined;
  const value = controlled ? prop : inner;
  const set = (next) => {
    if (!controlled) setInner(next);
    onChange?.(next);
  };
  return [value, set];
}

export function TextInput({ value, onChange, placeholder, disabled = false, type = "text", style }) {
  const [v, set] = useControllable(value, "", onChange);
  return (
    <input className="rk-in" type={type} value={v ?? ""} placeholder={placeholder} disabled={disabled}
      onChange={(e) => set(e.target.value)} style={mergeStyle({ height: 28, padding: "0 8px" }, style)} />
  );
}

export function TextArea({ value, onChange, placeholder, disabled = false, rows = 3, style }) {
  const [v, set] = useControllable(value, "", onChange);
  const ref = useRef(null);
  const fixed = style && style.height != null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || fixed) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [v, fixed]);
  return (
    <textarea ref={ref} className="rk-in" rows={rows} value={v ?? ""} placeholder={placeholder} disabled={disabled}
      onChange={(e) => set(e.target.value)} style={mergeStyle({ padding: "6px 8px", resize: fixed ? "vertical" : "none", overflow: fixed ? "auto" : "hidden", display: "block" }, style)} />
  );
}

export function Checkbox({ checked, onChange, disabled = false, label, style, title }) {
  const [v, set] = useControllable(checked, false, onChange);
  const box = <input type="checkbox" className="rk-chk" checked={!!v} disabled={disabled} title={title} onChange={(e) => set(e.target.checked)} />;
  if (label == null) return <span style={mergeStyle({ display: "inline-flex" }, style)}>{box}</span>;
  return (
    <label style={mergeStyle({ display: "inline-flex", alignItems: "center", gap: 8, cursor: disabled ? "not-allowed" : "pointer", fontSize: 13, lineHeight: "18px", color: "var(--sand-text-primary)", opacity: disabled ? 0.6 : 1 }, style)}>
      {box}
      <span>{label}</span>
    </label>
  );
}

export function Toggle({ checked, onChange, disabled = false, size = "sm", style, title }) {
  const [v, set] = useControllable(checked, false, onChange);
  const h = size === "md" ? 20 : 16;
  const w = size === "md" ? 34 : 28;
  const k = h - 4;
  return (
    <button type="button" role="switch" aria-checked={!!v} title={title} disabled={disabled} className="rk-tog" onClick={() => set(!v)}
      style={mergeStyle({ appearance: "none", position: "relative", flex: "none", width: w, height: h, padding: 0, border: 0, borderRadius: h, cursor: "pointer", background: v ? "var(--sand-bg-accent-primary)" : "var(--rk-fill-1)" }, style)}>
      <span aria-hidden="true" style={{ position: "absolute", top: 2, left: 2, width: k, height: k, borderRadius: k, background: "#fff", transition: "transform 120ms var(--ease-out, ease-out)", transform: v ? `translateX(${w - h}px)` : "none" }} />
    </button>
  );
}

export function Select({ value, onChange, options = [], placeholder, disabled = false, style }) {
  const [v, set] = useControllable(value, placeholder != null ? "" : options[0]?.value ?? "", onChange);
  const empty = v === "" || v == null;
  return (
    <select className="rk-in" value={v ?? ""} disabled={disabled} onChange={(e) => set(e.target.value)}
      style={mergeStyle({ height: 28, padding: "0 26px 0 8px", width: "auto", minWidth: 120, color: empty && placeholder != null ? "var(--sand-text-tertiary)" : undefined }, style)}>
      {placeholder != null ? <option value="" disabled>{placeholder}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  );
}

export function IconButton({ children, onClick, disabled = false, title, variant = "default", size = "md", style }) {
  const px = size === "sm" ? 16 : 20;
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick ? () => onClick() : undefined}
      className={`rk-ib${variant === "circle" ? " rk-ib-circle" : ""}`}
      style={mergeStyle({ appearance: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: px + 4, height: px + 4, padding: 0, border: 0, borderRadius: variant === "circle" ? 9999 : 5, color: "var(--sand-icon-secondary)", fontSize: size === "sm" ? 11 : 13, lineHeight: 1, cursor: "pointer" }, style)}>
      {children}
    </button>
  );
}

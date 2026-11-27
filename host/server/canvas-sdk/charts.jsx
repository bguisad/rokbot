// RokBot canvas SDK: SVG charts (bar, line, pie) with axes, legend and hover tooltip.
import { useLayoutEffect, useRef, useState } from "react";
import { chartColorSequence, toneMark } from "./theme.js";
import { mergeStyle } from "./ui.jsx";

const T1 = "var(--sand-text-primary)";
const T2 = "var(--sand-text-secondary)";
const T3 = "var(--sand-text-tertiary)";
const GRID = "var(--sand-border-tertiary-translucent)";
const AXIS = "var(--sand-border-secondary-translucent)";
const FONT = 11;

// ---- helpers ---------------------------------------------------------------------------------
function useWidth(initial = 640) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => { const v = Math.floor(el.getBoundingClientRect().width); if (v > 0) setW(v); };
    read();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const textWidth = (s, size = FONT) => {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 0x2e7f ? size : size * 0.6;
  return w;
};
function truncate(s, max, size = FONT) {
  s = String(s);
  if (textWidth(s, size) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (textWidth(`${out + ch}...`, size) > max) break;
    out += ch;
  }
  return out ? `${out}...` : "";
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
function fmt(v, prefix = "", suffix = "") {
  const n = num(v);
  const s = n.toLocaleString("zh-CN", { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
  return `${prefix}${s}${suffix}`;
}
// `step` (the tick spacing) sets the precision so close ticks such as 99.8 / 99.9 stay distinct.
function fmtTick(v, prefix = "", suffix = "", step) {
  const a = Math.abs(v);
  let s;
  if (a >= 1e9) s = `${+(v / 1e9).toFixed(1)}B`;
  else if (a >= 1e6) s = `${+(v / 1e6).toFixed(1)}M`;
  else if (a >= 1e4 && !(step && step < 100)) s = `${+(v / 1e3).toFixed(1)}k`;
  else {
    const d = step ? Math.max(0, Math.min(4, Math.ceil(-Math.log10(step) + 1e-9) + (step / 10 ** Math.floor(Math.log10(step)) === 2.5 ? 1 : 0)))
      : a < 1 && v !== 0 ? 2 : a < 10 ? 1 : 0;
    s = `${+v.toFixed(d)}`;
  }
  return `${prefix}${s}${suffix}`;
}

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const r = raw / mag;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
}
function scaleDomain(values, { beginAtZero = true, yMin, yMax, fixed } = {}, count = 5) {
  if (fixed) {
    const step = niceStep(fixed[1] - fixed[0], count);
    const ticks = [];
    for (let t = fixed[0]; t <= fixed[1] + step / 1e6; t += step) ticks.push(+t.toFixed(10));
    return { lo: fixed[0], hi: fixed[1], ticks };
  }
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (beginAtZero && yMin == null) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  else if (yMin == null && hi > lo) { const pad = (hi - lo) * 0.08; lo -= pad; hi += pad; }
  if (yMin != null) lo = yMin;
  if (yMax != null) hi = yMax;
  if (hi === lo) { hi = lo + (Math.abs(lo) || 1); if (!beginAtZero) lo -= Math.abs(lo) * 0.1 || 1; }
  const step = niceStep(hi - lo, count);
  const nlo = yMin != null ? lo : Math.floor(lo / step + 1e-9) * step;
  const nhi = yMax != null ? hi : Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let t = Math.ceil(nlo / step - 1e-9) * step; t <= nhi + step / 1e6; t += step) ticks.push(+t.toFixed(10));
  return { lo: nlo, hi: nhi, ticks };
}

const seriesColor = (s, i) => (s && s.tone && toneMark[s.tone]) || chartColorSequence[i % chartColorSequence.length];

// A bar rect with only the data end rounded. `dir`: "up" | "down" | "right" | "left".
function barPath(x, y, w, h, r, dir) {
  if (w <= 0 || h <= 0) return "";
  r = Math.max(0, Math.min(r, (dir === "up" || dir === "down" ? w : h) / 2, dir === "up" || dir === "down" ? h : w));
  if (dir === "up") return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  if (dir === "down") return `M${x},${y}H${x + w}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}Z`;
  if (dir === "right") return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  return `M${x + w},${y}V${y + h}H${x + r}Q${x},${y + h} ${x},${y + h - r}V${y + r}Q${x},${y} ${x + r},${y}Z`;
}

function Legend({ items }) {
  if (items.length < 2) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: 12, lineHeight: "16px", color: T2, marginBottom: 8 }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: it.color, flex: "none" }} />
          {it.name}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, width, title, rows, footer }) {
  const w = 200;
  const left = Math.max(0, x + 12 + 180 > width ? x - 12 - 180 : x + 12);
  return (
    <div role="status" style={{ position: "absolute", left, top: Math.max(0, y), pointerEvents: "none", zIndex: 5, minWidth: 120, maxWidth: w, padding: "6px 8px", borderRadius: 8, background: "var(--sand-bg-elevated)", border: "1px solid var(--sand-border-secondary-translucent)", fontSize: 12, lineHeight: "18px", color: T1 }}>
      {title != null ? <div style={{ color: T2, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div> : null}
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {r.color ? <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flex: "none" }} /> : null}
          <span style={{ color: T2, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500, paddingLeft: 8 }}>{r.value}</span>
        </div>
      ))}
      {footer ? <div style={{ color: T3, marginTop: 2 }}>{footer}</div> : null}
    </div>
  );
}

function RefLine({ line, horizontalChart, pos, x0, x1, y0, y1, prefix, suffix }) {
  const color = (line.tone && toneMark[line.tone]) || T3;
  const label = line.label ? `${line.label} ${fmt(line.value, prefix, suffix)}` : null;
  const lw = label ? textWidth(label, 10) + 10 : 0;
  if (horizontalChart) {
    return (
      <g>
        <line x1={pos} x2={pos} y1={y0} y2={y1} style={{ stroke: color }} strokeWidth="1.2" strokeDasharray="4 3" />
        {label ? <g transform={`translate(${Math.min(Math.max(pos - lw / 2, x0), x1 - lw)},${y0 - 18})`}>
          <rect width={lw} height="16" rx="4" style={{ fill: "var(--sand-bg-elevated)", stroke: color }} strokeWidth="1" />
          <text x={lw / 2} y="11.5" textAnchor="middle" fontSize="10" style={{ fill: color }}>{label}</text>
        </g> : null}
      </g>
    );
  }
  return (
    <g>
      <line x1={x0} x2={x1} y1={pos} y2={pos} style={{ stroke: color }} strokeWidth="1.2" strokeDasharray="4 3" />
      {label ? <g transform={`translate(${x1 - lw},${pos - 18})`}>
        <rect width={lw} height="16" rx="4" style={{ fill: "var(--sand-bg-elevated)", stroke: color }} strokeWidth="1" />
        <text x={lw / 2} y="11.5" textAnchor="middle" fontSize="10" style={{ fill: color }}>{label}</text>
      </g> : null}
    </g>
  );
}

// Which category labels fit along an axis of `slot` px per category.
function labelStep(labels, slot) {
  const widest = Math.max(0, ...labels.map((l) => textWidth(l)));
  return Math.max(1, Math.ceil((Math.min(widest, 120) + 8) / Math.max(1, slot)));
}

const svgStyle = { display: "block", overflow: "visible", fontFamily: "inherit", userSelect: "none" };

// ---- bar -------------------------------------------------------------------------------------
export function BarChart({ categories = [], series = [], height, stacked = false, horizontal = false, normalized = false, valueSuffix = "", valuePrefix = "", showValues, beginAtZero = true, yMin, yMax, referenceLines = [], style }) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState(-1);
  const stack = stacked || normalized;
  const nCat = Math.max(categories.length, ...series.map((s) => (s.data || []).length), 0);
  const cats = Array.from({ length: nCat }, (_, i) => categories[i] ?? String(i + 1));
  const single = series.length === 1;
  const color = (si, ci) => (single && !series[0].tone ? chartColorSequence[ci % chartColorSequence.length] : seriesColor(series[si], si));
  const raw = series.map((s) => cats.map((_, i) => num(s.data?.[i])));
  const totals = cats.map((_, i) => raw.reduce((a, d) => a + Math.max(0, d[i]), 0));
  const vals = normalized ? raw.map((d) => d.map((v, i) => (totals[i] ? (Math.max(0, v) / totals[i]) * 100 : 0))) : raw;
  const prefix = normalized ? "" : valuePrefix;
  const suffix = normalized ? "%" : valueSuffix;
  const labelsOn = !stack && (showValues ?? (single && nCat <= 8));

  let domainVals;
  if (stack) {
    domainVals = [0];
    cats.forEach((_, i) => {
      let pos = 0; let neg = 0;
      vals.forEach((d) => { if (d[i] >= 0) pos += d[i]; else neg += d[i]; });
      domainVals.push(pos, neg);
    });
  } else domainVals = vals.flat();
  if (!normalized) domainVals = domainVals.concat(referenceLines.map((r) => num(r.value)));
  if (!domainVals.length) domainVals = [0, 1];
  const dom = normalized ? scaleDomain([], { fixed: [0, 100] }, 4) : scaleDomain(domainVals, stack ? {} : { beginAtZero, yMin, yMax });
  const tickLabels = dom.ticks.map((t) => fmtTick(t, prefix, suffix, dom.ticks[1] - dom.ticks[0]));

  const legend = series.length > 1 ? series.map((s, i) => ({ name: s.name, color: seriesColor(s, i) })) : [];
  const H = height ?? (horizontal ? Math.max(120, nCat * (series.length > 1 && !stack ? 14 * series.length + 14 : 30) + 36) : 240);
  const tooltipFor = (ci) => ({
    title: cats[ci],
    rows: series.map((s, si) => ({ name: s.name, color: color(si, ci), value: normalized ? `${fmt(vals[si][ci])}%` : fmt(raw[si][ci], valuePrefix, valueSuffix) })),
    footer: stack && series.length > 1 && !normalized ? `合计 ${fmt(totals[ci], valuePrefix, valueSuffix)}` : null,
  });

  const marks = [];
  let plot;
  let tipPos = null;
  if (!horizontal) {
    const padL = Math.max(28, ...tickLabels.map((t) => textWidth(t))) + 10;
    const padR = 8;
    const padT = labelsOn ? 18 : 10;
    const padB = 24;
    const pw = Math.max(10, W - padL - padR);
    const ph = Math.max(10, H - padT - padB);
    const y = (v) => padT + ph - ((v - dom.lo) / (dom.hi - dom.lo || 1)) * ph;
    const base = y(Math.max(dom.lo, Math.min(dom.hi, 0)));
    const band = pw / Math.max(1, nCat);
    const groupW = Math.min(band * 0.72, stack || single ? 56 : 28 * series.length);
    const step = labelStep(cats, band);
    cats.forEach((c, ci) => {
      const gx = padL + ci * band + (band - groupW) / 2;
      if (stack) {
        let pos = 0; let neg = 0;
        const lastPos = vals.reduce((m, d, si) => (d[ci] > 0 ? si : m), -1);
        const lastNeg = vals.reduce((m, d, si) => (d[ci] < 0 ? si : m), -1);
        vals.forEach((d, si) => {
          const v = d[ci];
          if (!v) return;
          const from = v >= 0 ? pos : neg;
          const to = from + v;
          if (v >= 0) pos = to; else neg = to;
          const y1 = Math.min(y(from), y(to));
          const h = Math.abs(y(from) - y(to)) - 1;
          const end = v >= 0 ? si === lastPos : si === lastNeg;
          marks.push(<path key={`${ci}-${si}`} d={barPath(gx, v >= 0 ? y1 + 1 : y1, groupW, Math.max(0.5, h), end ? 3 : 0, v >= 0 ? "up" : "down")} style={{ fill: color(si, ci) }} opacity={hover < 0 || hover === ci ? 1 : 0.55} />);
        });
      } else {
        const n = series.length;
        const bw = (groupW - (n - 1) * 2) / Math.max(1, n);
        vals.forEach((d, si) => {
          const v = d[ci];
          const bx = gx + si * (bw + 2);
          const yv = y(Math.max(dom.lo, Math.min(dom.hi, v)));
          const top = Math.min(yv, base);
          const h = Math.abs(yv - base);
          marks.push(<path key={`${ci}-${si}`} d={barPath(bx, top, bw, Math.max(h, v ? 1 : 0), 3, v >= 0 ? "up" : "down")} style={{ fill: color(si, ci) }} opacity={hover < 0 || hover === ci ? 1 : 0.55} />);
          if (labelsOn && bw >= 14) {
            marks.push(<text key={`l${ci}-${si}`} x={bx + bw / 2} y={v >= 0 ? top - 5 : top + h + 12} textAnchor="middle" fontSize="10.5" style={{ fill: T2, fontVariantNumeric: "tabular-nums" }}>{truncate(fmt(v, prefix, suffix), Math.max(band, 30), 10.5)}</text>);
          }
        });
      }
      if (ci % step === 0) {
        marks.push(<text key={`x${ci}`} x={padL + ci * band + band / 2} y={padT + ph + 16} textAnchor="middle" fontSize={FONT} style={{ fill: T3 }}>{truncate(c, band * step - 6)}</text>);
      }
    });
    plot = (
      <svg width={W} height={H} style={svgStyle} onMouseLeave={() => setHover(-1)}>
        {dom.ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={padL + pw} y1={y(t)} y2={y(t)} style={{ stroke: t === 0 ? AXIS : GRID }} strokeWidth="1" />
            <text x={padL - 8} y={y(t) + 3.5} textAnchor="end" fontSize={FONT} style={{ fill: T3, fontVariantNumeric: "tabular-nums" }}>{tickLabels[i]}</text>
          </g>
        ))}
        {hover >= 0 ? <rect x={padL + hover * band} y={padT} width={band} height={ph} style={{ fill: "var(--sand-bg-hover)" }} /> : null}
        {marks}
        {!normalized && referenceLines.map((r, i) => <RefLine key={`r${i}`} line={r} pos={y(num(r.value))} x0={padL} x1={padL + pw} prefix={prefix} suffix={suffix} />)}
        {cats.map((_, ci) => <rect key={`h${ci}`} x={padL + ci * band} y={padT} width={band} height={ph} fill="transparent" onMouseEnter={() => setHover(ci)} />)}
      </svg>
    );
    tipPos = hover >= 0 ? { x: padL + hover * band + band / 2, y: padT } : null;
  } else {
    const padL = Math.min(W * 0.4, Math.max(24, ...cats.map((c) => textWidth(c))) + 12);
    const padR = labelsOn ? 44 : 14;
    const padT = referenceLines.some((r) => r.label) ? 22 : 6;
    const padB = 22;
    const pw = Math.max(10, W - padL - padR);
    const ph = Math.max(10, H - padT - padB);
    const x = (v) => padL + ((v - dom.lo) / (dom.hi - dom.lo || 1)) * pw;
    const base = x(Math.max(dom.lo, Math.min(dom.hi, 0)));
    const band = ph / Math.max(1, nCat);
    const groupH = Math.min(band * 0.7, stack || single ? 22 : 12 * series.length);
    const tickStep = Math.max(1, Math.ceil((Math.max(...tickLabels.map((t) => textWidth(t))) + 12) / (pw / Math.max(1, dom.ticks.length - 1))));
    cats.forEach((c, ci) => {
      const gy = padT + ci * band + (band - groupH) / 2;
      if (stack) {
        let pos = 0; let neg = 0;
        const lastPos = vals.reduce((m, d, si) => (d[ci] > 0 ? si : m), -1);
        const lastNeg = vals.reduce((m, d, si) => (d[ci] < 0 ? si : m), -1);
        vals.forEach((d, si) => {
          const v = d[ci];
          if (!v) return;
          const from = v >= 0 ? pos : neg;
          const to = from + v;
          if (v >= 0) pos = to; else neg = to;
          const x1 = Math.min(x(from), x(to));
          const w = Math.abs(x(from) - x(to)) - 1;
          const end = v >= 0 ? si === lastPos : si === lastNeg;
          marks.push(<path key={`${ci}-${si}`} d={barPath(v >= 0 ? x1 : x1 + 1, gy, Math.max(0.5, w), groupH, end ? 3 : 0, v >= 0 ? "right" : "left")} style={{ fill: color(si, ci) }} opacity={hover < 0 || hover === ci ? 1 : 0.55} />);
        });
      } else {
        const n = series.length;
        const bh = (groupH - (n - 1) * 2) / Math.max(1, n);
        vals.forEach((d, si) => {
          const v = d[ci];
          const by = gy + si * (bh + 2);
          const xv = x(Math.max(dom.lo, Math.min(dom.hi, v)));
          const left = Math.min(xv, base);
          const w = Math.abs(xv - base);
          marks.push(<path key={`${ci}-${si}`} d={barPath(left, by, Math.max(w, v ? 1 : 0), bh, 3, v >= 0 ? "right" : "left")} style={{ fill: color(si, ci) }} opacity={hover < 0 || hover === ci ? 1 : 0.55} />);
          if (labelsOn && bh >= 9) {
            marks.push(<text key={`l${ci}-${si}`} x={v >= 0 ? left + w + 5 : left - 5} y={by + bh / 2 + 3.5} textAnchor={v >= 0 ? "start" : "end"} fontSize="10.5" style={{ fill: T2, fontVariantNumeric: "tabular-nums" }}>{fmt(v, prefix, suffix)}</text>);
          }
        });
      }
      marks.push(<text key={`y${ci}`} x={padL - 8} y={padT + ci * band + band / 2 + 3.5} textAnchor="end" fontSize={FONT} style={{ fill: T2 }}>{truncate(c, padL - 12)}</text>);
    });
    plot = (
      <svg width={W} height={H} style={svgStyle} onMouseLeave={() => setHover(-1)}>
        {dom.ticks.map((t, i) => (
          <g key={i}>
            <line x1={x(t)} x2={x(t)} y1={padT} y2={padT + ph} style={{ stroke: t === 0 ? AXIS : GRID }} strokeWidth="1" />
            {i % tickStep === 0 ? <text x={x(t)} y={padT + ph + 15} textAnchor="middle" fontSize={FONT} style={{ fill: T3, fontVariantNumeric: "tabular-nums" }}>{tickLabels[i]}</text> : null}
          </g>
        ))}
        {hover >= 0 ? <rect x={padL} y={padT + hover * band} width={pw} height={band} style={{ fill: "var(--sand-bg-hover)" }} /> : null}
        {marks}
        {!normalized && referenceLines.map((r, i) => <RefLine key={`r${i}`} line={r} horizontalChart pos={x(num(r.value))} x0={padL} x1={padL + pw} y0={padT} y1={padT + ph} prefix={prefix} suffix={suffix} />)}
        {cats.map((_, ci) => <rect key={`h${ci}`} x={0} y={padT + ci * band} width={W} height={band} fill="transparent" onMouseEnter={() => setHover(ci)} />)}
      </svg>
    );
    tipPos = hover >= 0 ? { x: Math.min(W - 140, padL + pw * 0.5), y: padT + (hover + 1) * band } : null;
  }
  return (
    <div style={mergeStyle({ width: "100%", minWidth: 0 }, style)}>
      <Legend items={legend} />
      <div ref={ref} style={{ position: "relative", width: "100%" }}>
        {plot}
        {tipPos ? <Tooltip {...tipPos} width={W} {...tooltipFor(hover)} /> : null}
      </div>
    </div>
  );
}

// ---- line ------------------------------------------------------------------------------------
export function LineChart({ categories = [], series = [], height = 240, fill = false, valueSuffix = "", valuePrefix = "", showValues = false, showHoverGuide = true, beginAtZero = true, yMin, yMax, referenceLines = [], style }) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState(-1);
  const nCat = Math.max(categories.length, ...series.map((s) => (s.data || []).length), 0);
  const cats = Array.from({ length: nCat }, (_, i) => categories[i] ?? String(i + 1));
  const vals = series.map((s) => cats.map((_, i) => (s.data?.[i] == null ? null : num(s.data[i]))));
  let domainVals = vals.flat().filter((v) => v != null).concat(referenceLines.map((r) => num(r.value)));
  if (!domainVals.length) domainVals = [0, 1];
  const dom = scaleDomain(domainVals, { beginAtZero, yMin, yMax });
  const tickLabels = dom.ticks.map((t) => fmtTick(t, valuePrefix, valueSuffix, dom.ticks[1] - dom.ticks[0]));
  const padL = Math.max(28, ...tickLabels.map((t) => textWidth(t))) + 10;
  const lastLabel = textWidth(cats[nCat - 1] ?? "") / 2;
  const padR = Math.max(12, Math.min(40, lastLabel - 4));
  const padT = showValues ? 18 : 10;
  const padB = 24;
  const pw = Math.max(10, W - padL - padR);
  const ph = Math.max(10, height - padT - padB);
  const x = (i) => (nCat <= 1 ? padL + pw / 2 : padL + (i / (nCat - 1)) * pw);
  const y = (v) => padT + ph - ((v - dom.lo) / (dom.hi - dom.lo || 1)) * ph;
  const slot = nCat <= 1 ? pw : pw / (nCat - 1);
  const step = labelStep(cats, slot);
  const colors = series.map((s, i) => seriesColor(s, i));
  const baseY = y(Math.max(dom.lo, Math.min(dom.hi, beginAtZero ? 0 : dom.lo)));

  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - box.left;
    const i = nCat <= 1 ? 0 : Math.round(((mx - padL) / pw) * (nCat - 1));
    setHover(Math.max(0, Math.min(nCat - 1, i)));
  };
  const segments = (d) => {
    const out = [];
    let cur = [];
    d.forEach((v, i) => { if (v == null) { if (cur.length) out.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
    if (cur.length) out.push(cur);
    return out;
  };
  const showDots = nCat <= 40;
  return (
    <div style={mergeStyle({ width: "100%", minWidth: 0 }, style)}>
      <Legend items={series.map((s, i) => ({ name: s.name, color: colors[i] }))} />
      <div ref={ref} style={{ position: "relative", width: "100%" }}>
        <svg width={W} height={height} style={svgStyle} onMouseMove={nCat ? onMove : undefined} onMouseLeave={() => setHover(-1)}>
          {dom.ticks.map((t, i) => (
            <g key={i}>
              <line x1={padL} x2={padL + pw} y1={y(t)} y2={y(t)} style={{ stroke: t === 0 ? AXIS : GRID }} strokeWidth="1" />
              <text x={padL - 8} y={y(t) + 3.5} textAnchor="end" fontSize={FONT} style={{ fill: T3, fontVariantNumeric: "tabular-nums" }}>{tickLabels[i]}</text>
            </g>
          ))}
          {cats.map((c, i) => (i % step === 0 ? (
            <text key={i} x={x(i)} y={padT + ph + 16} textAnchor={nCat > 1 && i === 0 && padL < textWidth(c) / 2 ? "start" : "middle"} fontSize={FONT} style={{ fill: T3 }}>{truncate(c, slot * step - 6)}</text>
          ) : null))}
          {fill ? vals.map((d, si) => segments(d).map((pts, k) => (
            <path key={`a${si}-${k}`} d={`M${pts[0][0]},${baseY}${pts.map((p) => `L${p[0]},${p[1]}`).join("")}L${pts[pts.length - 1][0]},${baseY}Z`} style={{ fill: colors[si] }} opacity={series.length > 1 ? 0.08 : 0.12} />
          ))) : null}
          {referenceLines.map((r, i) => <RefLine key={`r${i}`} line={r} pos={y(num(r.value))} x0={padL} x1={padL + pw} prefix={valuePrefix} suffix={valueSuffix} />)}
          {showHoverGuide && hover >= 0 ? <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ph} style={{ stroke: "var(--sand-border-primary-translucent)" }} strokeWidth="1" /> : null}
          {vals.map((d, si) => segments(d).map((pts, k) => (
            <polyline key={`l${si}-${k}`} points={pts.map((p) => p.join(",")).join(" ")} fill="none" style={{ stroke: colors[si] }} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          )))}
          {vals.map((d, si) => d.map((v, i) => (v == null || (!showDots && hover !== i) ? null : (
            <circle key={`d${si}-${i}`} cx={x(i)} cy={y(v)} r={hover === i ? 4.5 : 3} style={{ fill: colors[si], stroke: "var(--sand-bg-pane)" }} strokeWidth="1.5" />
          ))))}
          {showValues && nCat <= 20 ? vals.map((d, si) => d.map((v, i) => (v == null ? null : (
            <text key={`v${si}-${i}`} x={x(i)} y={y(v) - 8} textAnchor="middle" fontSize="10.5" style={{ fill: T2, fontVariantNumeric: "tabular-nums" }}>{fmt(v, valuePrefix, valueSuffix)}</text>
          )))) : null}
        </svg>
        {hover >= 0 ? (
          <Tooltip x={x(hover)} y={padT} width={W} title={cats[hover]}
            rows={series.map((s, si) => ({ name: s.name, color: colors[si], value: vals[si][hover] == null ? "-" : fmt(vals[si][hover], valuePrefix, valueSuffix) }))} />
        ) : null}
      </div>
    </div>
  );
}

// ---- pie -------------------------------------------------------------------------------------
export function PieChart({ data = [], size = 200, donut = false, style }) {
  const [hover, setHover] = useState(-1);
  const items = data.map((d, i) => ({ ...d, value: Math.max(0, num(d.value)), color: (d.tone && toneMark[d.tone]) || chartColorSequence[i % chartColorSequence.length] }));
  const total = items.reduce((a, d) => a + d.value, 0);
  const R = size / 2 - 6;
  const r0 = donut ? R * 0.62 : 0;
  const c = size / 2;
  const gap = items.filter((d) => d.value > 0).length > 1 ? 0.012 : 0;
  let angle = -Math.PI / 2;
  const pt = (rad, a) => [c + rad * Math.cos(a), c + rad * Math.sin(a)];
  const slices = items.map((d, i) => {
    const sweep = total ? (d.value / total) * Math.PI * 2 : 0;
    const a0 = angle + gap;
    const a1 = angle + sweep - gap;
    const mid = angle + sweep / 2;
    angle += sweep;
    if (sweep <= 0) return null;
    let path;
    if (sweep >= Math.PI * 2 - 1e-6) {
      path = `M${c - R},${c}a${R},${R} 0 1,0 ${2 * R},0a${R},${R} 0 1,0 ${-2 * R},0Z${r0 ? `M${c - r0},${c}a${r0},${r0} 0 1,1 ${2 * r0},0a${r0},${r0} 0 1,1 ${-2 * r0},0Z` : ""}`;
    } else {
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const [x0, y0] = pt(R, a0);
      const [x1, y1] = pt(R, a1);
      if (r0) {
        const [x2, y2] = pt(r0, a1);
        const [x3, y3] = pt(r0, a0);
        path = `M${x0},${y0}A${R},${R} 0 ${large},1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${large},0 ${x3},${y3}Z`;
      } else path = `M${c},${c}L${x0},${y0}A${R},${R} 0 ${large},1 ${x1},${y1}Z`;
    }
    const off = hover === i ? 5 : 0;
    return (
      <path key={i} d={path} fillRule="evenodd" style={{ fill: d.color, transition: "transform 120ms, opacity 120ms" }} transform={`translate(${off * Math.cos(mid)},${off * Math.sin(mid)})`}
        opacity={hover < 0 || hover === i ? 1 : 0.4} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)} />
    );
  });
  const pct = (v) => (total ? `${((v / total) * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%` : "0%");
  const h = hover >= 0 ? items[hover] : null;
  return (
    <div style={mergeStyle({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 24, minWidth: 0 }, style)}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: "none" }}>
        <svg width={size} height={size} style={svgStyle} role="img">
          {slices}
          {donut ? (
            <g pointerEvents="none">
              <text x={c} y={c + (h ? -2 : 2)} textAnchor="middle" fontSize={Math.max(13, Math.min(20, size / 10))} fontWeight="600" style={{ fill: T1, fontVariantNumeric: "tabular-nums" }}>{fmtTick(h ? h.value : total)}</text>
              <text x={c} y={c + 16} textAnchor="middle" fontSize="11" style={{ fill: T3 }}>{h ? truncate(h.label, r0 * 1.6) : "合计"}</text>
            </g>
          ) : null}
        </svg>
        <div style={{ height: 18, fontSize: 12, lineHeight: "18px", color: T2, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {h ? `${h.label} · ${fmt(h.value)} · ${pct(h.value)}` : ""}
        </div>
      </div>
      <div role="list" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 140, maxWidth: 320, flex: "1 1 160px" }}>
        {items.map((d, i) => (
          <div key={i} role="listitem" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 6px", borderRadius: 6, fontSize: 12, lineHeight: "18px", background: hover === i ? "var(--sand-bg-hover)" : "transparent", opacity: hover < 0 || hover === i ? 1 : 0.6, cursor: "default" }}>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: d.color, flex: "none" }} />
            <span style={{ color: T1, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</span>
            <span style={{ color: T2, fontVariantNumeric: "tabular-nums" }}>{fmt(d.value)}</span>
            <span style={{ color: T3, fontVariantNumeric: "tabular-nums", width: 44, textAlign: "right" }}>{pct(d.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

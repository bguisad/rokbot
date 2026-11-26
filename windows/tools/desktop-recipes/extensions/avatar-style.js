// RokBot custom dynamic Bot avatar styles (desktop and Web).
// Every RokBot theme (chassis, antenna, visor, pixel, orb) renders each Bot's
// chosen official shape (blob, star, heart, cloud, hex, pumpkin, etc.) using the
// exact same silhouette math as pele's GrokBotMark/selection rings, while
// preserving 'official' as an in-app switchable option.
const ROK_AVATAR_STORAGE_KEY = 'rokbot.avatarStyle.v1';
const ROK_AVATAR_DEFAULT_STYLE = 'chassis';
const ROK_AVATAR_STYLES = [
  { id: 'chassis', zh: '机甲灵偶', en: 'RokBot Chassis', descZh: '全形状兼容 + 脉冲信号灯', descEn: 'Shape-aware + pulse beacon', defaultColor: 'cyan', previewShape: 'blob' },
  { id: 'antenna', zh: '双天线波波', en: 'Twin Antenna', descZh: '弹性双天线 + 玻璃面罩', descEn: 'Spring antennas + glass visor', defaultColor: 'violet', previewShape: 'cloud' },
  { id: 'visor', zh: '赛博护目镜', en: 'Cyber Visor', descZh: '极客切角框 + 扫描灯带', descEn: 'Cyber visor + scanner LED', defaultColor: 'orange', previewShape: 'hex' },
  { id: 'pixel', zh: '像素精灵', en: 'Pixel Sprite', descZh: '点阵 LED 屏 + 节奏灯条', descEn: 'LED matrix + status bar', defaultColor: 'green', previewShape: 'star' },
  { id: 'orb', zh: '流体光球', en: 'Fluid Orb', descZh: '呼吸微动 + 轨道卫星', descEn: 'Breathing shape + orbiting dot', defaultColor: 'magenta', previewShape: 'heart' },
  { id: 'official', zh: '官方原版', en: 'Official', descZh: '保留官方动态流体球', descEn: 'Original dynamic fluid orb', defaultColor: 'blue', previewShape: 'blob' },
];
const ROK_AVATAR_STYLE_IDS = ROK_AVATAR_STYLES.map(item => item.id);
const ROK_AVATAR_PRESETS = {
  cyan: { top: '#22d3ee', mid: '#06b6d4', bot: '#0e7490', accent: '#67e8f9', rim: '#0891b2' },
  blue: { top: '#60a5fa', mid: '#3b82f6', bot: '#1d4ed8', accent: '#93c5fd', rim: '#2563eb' },
  violet: { top: '#a78bfa', mid: '#8b5cf6', bot: '#5b21b6', accent: '#c4b5fd', rim: '#7c3aed' },
  magenta: { top: '#f472b6', mid: '#ec4899', bot: '#9d174d', accent: '#fbcfe8', rim: '#db2777' },
  red: { top: '#f87171', mid: '#ef4444', bot: '#b91c1c', accent: '#fecaca', rim: '#dc2626' },
  orange: { top: '#fb923c', mid: '#f97316', bot: '#c2410c', accent: '#fed7aa', rim: '#ea580c' },
  yellow: { top: '#facc15', mid: '#eab308', bot: '#a16207', accent: '#fef08a', rim: '#ca8a04' },
  green: { top: '#34d399', mid: '#10b981', bot: '#047857', accent: '#a7f3d0', rim: '#059669' },
  brown: { top: '#c08457', mid: '#9a5b32', bot: '#5c3317', accent: '#e7c3a6', rim: '#7c4722' },
  gray: { top: '#94a3b8', mid: '#64748b', bot: '#334155', accent: '#cbd5e1', rim: '#475569' },
  blackLight: { top: '#475569', mid: '#1e293b', bot: '#090d16', accent: '#38bdf8', rim: '#334155' },
  blackDark: { top: '#64748b', mid: '#334155', bot: '#0f172a', accent: '#38bdf8', rim: '#94a3b8' },
};

// Procedural 0..100 fallback silhouettes used only in headless tests or if official pele helpers are absent.
const ROK_FALLBACK_SHAPE_D = {
  blob: 'M 33 14 C 40 14 47 14 53 14 C 60 14 65 6 74 5.5 C 82 5 87 10 86 17 C 86 21 91 27 93 36 C 94 45 94 55 93 64 C 91 80 80 90 62 92 C 52 93 41 94 32 93 C 15 92 7 82 7 65 C 6 54 6 41 7 33 C 8 20 18 14 33 14 Z',
  cloud: 'M 28 74 C 16 74 8 66 8 55 C 8 46 14 39 22 37 C 24 25 35 16 48 16 C 60 16 70 23 73 34 C 83 35 92 43 92 54 C 92 65 83 74 71 74 Z',
  hex: 'M 50 8 L 86 29 L 86 71 L 50 92 L 14 71 L 14 29 Z',
  star: 'M 50 8 L 62 33 L 90 37 L 69 57 L 74 85 L 50 72 L 26 85 L 31 57 L 10 37 L 38 33 Z',
  heart: 'M 50 88 C 20 68 8 49 8 33 C 8 20 18 11 30 11 C 39 11 46 16 50 23 C 54 16 61 11 70 11 C 82 11 92 20 92 33 C 92 49 80 68 50 88 Z',
  square: 'M 14 14 L 86 14 L 86 86 L 14 86 Z',
  squircle: 'M 50 8 C 82 8 92 18 92 50 C 92 82 82 92 50 92 C 18 92 8 82 8 50 C 8 18 18 8 50 8 Z',
};

const rokShapePathCache = new Map();
const rokShapeDStringCache = new Map();

function rokNormalizeShapeName(shape) {
  return typeof shape === 'string' && shape.trim() ? shape.trim().toLowerCase() : 'blob';
}

function rokResolveShapePathD(rawShape) {
  const key = rokNormalizeShapeName(rawShape);
  if (rokShapeDStringCache.has(key)) return rokShapeDStringCache.get(key);
  let d = null;
  try {
    if (typeof kt === 'function' && typeof yi === 'function') {
      const fillVal = typeof Mi === 'number' ? Mi : undefined;
      const svgMarkup = kt(fillVal !== void 0 ? { body: yi(key), size: 100, fill: fillVal } : { body: yi(key), size: 100 });
      const m = typeof svgMarkup === 'string' ? svgMarkup.match(/\bd="([^"]+)"/) : null;
      if (m?.[1]) d = m[1];
    }
  } catch {}
  if (!d) d = ROK_FALLBACK_SHAPE_D[key] || ROK_FALLBACK_SHAPE_D.blob;
  rokShapeDStringCache.set(key, d);
  return d;
}

function rokGetShapePath(rawShape) {
  const key = rokNormalizeShapeName(rawShape);
  if (rokShapePathCache.has(key)) return rokShapePathCache.get(key);
  const d = rokResolveShapePathD(key);
  const path = typeof Path2D === 'function' ? new Path2D(d) : null;
  if (path) rokShapePathCache.set(key, path);
  return path;
}

function rokAvatarIsValidStyle(id) {
  return typeof id === 'string' && ROK_AVATAR_STYLE_IDS.includes(id);
}

function rokAvatarParse(raw) {
  if (typeof raw === 'string' && rokAvatarIsValidStyle(raw.trim())) {
    return { style: raw.trim() };
  }
  try {
    const parsed = JSON.parse(raw ?? 'null');
    const style = rokAvatarIsValidStyle(parsed?.style) ? parsed.style : ROK_AVATAR_DEFAULT_STYLE;
    return { style };
  } catch {
    return { style: ROK_AVATAR_DEFAULT_STYLE };
  }
}

function rokCreateAvatarStore(storage, events) {
  let state = rokAvatarParse(storage?.getItem?.(ROK_AVATAR_STORAGE_KEY));
  const listeners = new Set();
  const publish = next => {
    if (next.style === state.style) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const save = next => {
    try { storage?.setItem?.(ROK_AVATAR_STORAGE_KEY, JSON.stringify(next)); } catch {}
    publish(next);
  };
  events?.addEventListener?.('storage', event => {
    if (event?.key === ROK_AVATAR_STORAGE_KEY) publish(rokAvatarParse(event.newValue));
  });
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getStyle: () => state.style,
    setStyle(style) { if (rokAvatarIsValidStyle(style)) save({ style }); },
  };
}

function rokAvatarStyleStore() {
  const scope = globalThis;
  if (!scope.__rokAvatarStyle) {
    let storage = null;
    try { storage = scope.localStorage ?? null; } catch {}
    scope.__rokAvatarStyle = rokCreateAvatarStore(storage, scope.window ?? null);
  }
  return scope.__rokAvatarStyle;
}

function rokNormalizeAvatarState(rawState) {
  const s = typeof rawState === 'string' ? rawState.trim().toLowerCase() : 'idle';
  if (s === 'sleeping' || s === 'sleep' || s === 'asleep') return 'sleeping';
  if (s === 'happy' || s === 'excited' || s === 'laughing' || s === 'proud' || s === 'finished' || s === 'playful' || s === 'celebrating' || s === 'success') return 'happy';
  if (s === 'failed' || s === 'error') return 'error';
  if (s === 'waiting' || s === 'blocked' || s === 'attention' || s === 'alert' || s === 'needs-attention') return 'waiting';
  if (s === 'working' || s === 'coding' || s === 'running' || s === 'computing' || s === 'controlling' || s === 'streaming' || s === 'talking' || s === 'speaking' || s === 'active' || s === 'executing') return 'working';
  if (s === 'thinking' || s === 'searching' || s === 'reading' || s === 'listening' || s === 'curious' || s === 'waking' || s === 'loading' || s === 'connecting' || s === 'planning') return 'thinking';
  return 'idle';
}

function rokAvatarClampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rokAvatarParseCssColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3
      ? hex[1][0] + hex[1][0] + hex[1][1] + hex[1][1] + hex[1][2] + hex[1][2]
      : hex[1];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) {
    return [rokAvatarClampByte(Number(rgb[1])), rokAvatarClampByte(Number(rgb[2])), rokAvatarClampByte(Number(rgb[3]))];
  }
  return null;
}

function rokAvatarRgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => rokAvatarClampByte(v).toString(16).padStart(2, '0')).join('');
}

function rokAvatarMixRgb(rgb, target, amount) {
  return rokAvatarRgbToHex(
    rgb[0] + (target[0] - rgb[0]) * amount,
    rgb[1] + (target[1] - rgb[1]) * amount,
    rgb[2] + (target[2] - rgb[2]) * amount,
  );
}

function rokAvatarPalette(color, ink, isLight = false) {
  const key = typeof color === 'string' ? color.trim().toLowerCase() : '';
  if (key === 'black') return isLight ? ROK_AVATAR_PRESETS.blackLight : ROK_AVATAR_PRESETS.blackDark;
  if (key && Object.prototype.hasOwnProperty.call(ROK_AVATAR_PRESETS, key)) {
    return ROK_AVATAR_PRESETS[key];
  }
  const rgb = rokAvatarParseCssColor(ink);
  if (rgb) {
    return {
      top: rokAvatarMixRgb(rgb, [255, 255, 255], 0.24),
      mid: rokAvatarRgbToHex(rgb[0], rgb[1], rgb[2]),
      bot: rokAvatarMixRgb(rgb, [10, 15, 28], 0.34),
      accent: rokAvatarMixRgb(rgb, [255, 255, 255], 0.56),
      rim: rokAvatarMixRgb(rgb, [15, 23, 42], 0.2),
    };
  }
  return ROK_AVATAR_PRESETS.cyan;
}

function rokAvatarIsLightTheme() {
  try {
    const doc = globalThis.document;
    const root = doc?.documentElement;
    if (!root) return false;
    if (root.classList?.contains('light') || root.dataset?.theme === 'light' || root.getAttribute?.('data-theme') === 'light') return true;
    if (root.classList?.contains('dark') || root.dataset?.theme === 'dark' || root.getAttribute?.('data-theme') === 'dark') return false;
    const cs = globalThis.getComputedStyle?.(root);
    const scheme = cs?.colorScheme ?? '';
    if (scheme.includes('light') && !scheme.includes('dark')) return true;
    if (scheme.includes('dark') && !scheme.includes('light')) return false;
    const bg = rokAvatarParseCssColor(cs?.backgroundColor || '');
    if (bg) return (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) > 140;
  } catch {}
  return false;
}

function rokRoundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function rokMakeAvatarGrad(ctx, pal, y0, y1) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, pal.top);
  g.addColorStop(0.55, pal.mid);
  g.addColorStop(1, pal.bot);
  return g;
}

function rokSignalColor(state, pal) {
  if (state === 'error') return '#f87171';
  if (state === 'waiting') return '#fbbf24';
  if (state === 'happy') return '#4ade80';
  if (state === 'sleeping') return 'rgba(255,255,255,0.35)';
  if (state === 'working') return pal.accent || '#38bdf8';
  return pal.accent;
}

function rokFillShape(ctx, shapePath, pal, isLight, lineWidth = 2.4) {
  if (!shapePath) {
    ctx.beginPath();
    ctx.arc(50, 50, 40, 0, Math.PI * 2);
    ctx.fillStyle = rokMakeAvatarGrad(ctx, pal, 10, 90);
    ctx.fill();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.22)';
    ctx.stroke();
    return;
  }
  ctx.fillStyle = rokMakeAvatarGrad(ctx, pal, 8, 92);
  ctx.fill(shapePath);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.22)';
  ctx.stroke(shapePath);
}

function rokDrawChassis(ctx, shapePath, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  ctx.save();
  const sc = s / 100;
  const amp = emph ? 1.25 : 1;
  const breath = state === 'sleeping' ? 1 + Math.sin(t * 1.4) * 0.015 : 1 + Math.sin(t * 2.8) * 0.024 * amp;
  const bob = state === 'working' ? Math.sin(t * 7.5) * s * 0.025 * amp :
    state === 'happy' ? -Math.abs(Math.sin(t * 5.2)) * s * 0.04 * amp :
      state === 'thinking' ? Math.sin(t * 3.1) * s * 0.016 : Math.sin(t * 2.2) * s * 0.01;
  const tilt = state === 'thinking' ? Math.sin(t * 2.4) * 0.055 :
    state === 'working' ? Math.sin(t * 6) * 0.04 : 0;

  ctx.translate(s / 2 + gaze.x * s * 0.022, s / 2 + bob + gaze.y * s * 0.022);
  ctx.rotate(poke.angle + tilt);
  ctx.scale(breath * (1 + poke.bounce * 0.14), breath * (1 - poke.bounce * 0.1));
  ctx.translate(-s / 2, -s / 2);

  ctx.scale(sc, sc);
  rokFillShape(ctx, shapePath, pal, isLight, 2.4);

  // Upper-right pulse signal beacon
  const bx = 74, by = 22;
  const beaconColor = state === 'working' ? '#38bdf8' : rokSignalColor(state, pal);
  let beaconScale = 1 + Math.sin(t * 3) * 0.12;
  let halo = 0;
  if (state === 'thinking') {
    beaconScale = 0.85 + Math.abs(Math.sin(t * 7)) * 0.45;
    halo = (t * 1.4) % 1;
  } else if (state === 'working') {
    beaconScale = 1 + Math.abs(Math.sin(t * 10)) * 0.35;
    halo = (t * 2.2) % 1;
  } else if (state === 'waiting' || state === 'error') {
    beaconScale = 1.15 + Math.sin(t * 6) * 0.25;
    halo = (t * 1.6) % 1;
  } else if (state === 'happy') {
    beaconScale = 1.15;
  } else if (state === 'sleeping') {
    beaconScale = 0.78;
  }

  if (halo > 0) {
    ctx.beginPath();
    ctx.arc(bx, by, 4.2 + halo * 7.2, 0, Math.PI * 2);
    ctx.strokeStyle = beaconColor;
    ctx.globalAlpha = (1 - halo) * 0.65;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.arc(bx, by, 4.2 * beaconScale, 0, Math.PI * 2);
  ctx.fillStyle = beaconColor;
  ctx.fill();

  // Tilted capsule eyes tuned to fit every shape cleanly
  const gx = gaze.x * 4.2 + (state === 'thinking' ? Math.sin(t * 4) * 2.8 : 0);
  const gy = gaze.y * 3.8 + (state === 'thinking' ? -2.0 : 0);
  const eyeFill = eyeInk || '#ffffff';
  ctx.fillStyle = eyeFill;
  ctx.strokeStyle = eyeFill;
  ctx.lineCap = 'round';

  if (state === 'sleeping') {
    ctx.lineWidth = 3.8;
    ctx.beginPath(); ctx.arc(40, 54, 6.2, 0.2, Math.PI - 0.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(60, 50, 5.4, 0.2, Math.PI - 0.2); ctx.stroke();
  } else if (state === 'happy') {
    ctx.lineWidth = 4.2;
    ctx.beginPath(); ctx.arc(40 + gx * 0.4, 56 + gy * 0.4, 6.2, Math.PI + 0.35, -0.35); ctx.stroke();
    ctx.beginPath(); ctx.arc(60 + gx * 0.4, 52 + gy * 0.4, 5.4, Math.PI + 0.35, -0.35); ctx.stroke();
  } else {
    const eyeScaleY = Math.max(0.08, 1 - blink) * (state === 'waiting' || state === 'error' ? 1.12 : 1);
    const drawCapsule = (cx, cy, w, h) => {
      ctx.save();
      ctx.translate(cx + gx, cy + gy);
      ctx.rotate(-26 * Math.PI / 180);
      ctx.scale(1, eyeScaleY);
      rokRoundedRectPath(ctx, -w / 2, -h / 2, w, h, w / 2);
      ctx.fill();
      ctx.restore();
    };
    drawCapsule(40, 54, 10.2, 23.5);
    drawCapsule(60, 49, 10.2, 19.0);
  }
  ctx.restore();
}

function rokDrawAntenna(ctx, shapePath, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  ctx.save();
  const sc = s / 100;
  const amp = emph ? 1.25 : 1;
  const bob = state === 'working' ? Math.sin(t * 8) * s * 0.022 * amp :
    state === 'happy' ? -Math.abs(Math.sin(t * 5.2)) * s * 0.036 * amp : Math.sin(t * 2.4) * s * 0.01;
  const sway = Math.sin(t * (state === 'working' ? 8 : 2.6)) * 0.14 + poke.bounce * 0.4;

  ctx.translate(s / 2 + gaze.x * s * 0.02, s / 2 + bob + gaze.y * s * 0.02);
  ctx.rotate(poke.angle);
  ctx.scale(1 + poke.bounce * 0.12, 1 - poke.bounce * 0.09);
  ctx.translate(-s / 2, -s / 2);
  ctx.scale(sc, sc);

  // Twin springy antennas perched above the Bot silhouette
  const activeTip = state === 'sleeping' ? pal.rim : rokSignalColor(state, pal);
  for (const side of [-1, 1]) {
    const rootX = 50 + side * 14;
    const rootY = 27;
    const tipX = rootX + side * 6 + Math.sin(t * 3 + side) * 2.2 + sway * 7;
    const tipY = 8 + Math.abs(sway) * 2;
    ctx.beginPath();
    ctx.moveTo(rootX, rootY);
    ctx.quadraticCurveTo(rootX + side * 2, (rootY + tipY) / 2, tipX, tipY);
    ctx.strokeStyle = pal.mid;
    ctx.lineWidth = Math.max(3.6, 4.2);
    ctx.lineCap = 'round';
    ctx.stroke();

    if (state === 'thinking' || state === 'working' || state === 'waiting' || state === 'error') {
      const pulse = (t * 1.8 + (side > 0 ? 0.5 : 0)) % 1;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 3.8 + pulse * 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = activeTip;
      ctx.globalAlpha = (1 - pulse) * 0.6;
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(tipX, tipY, 4.4, 0, Math.PI * 2);
    ctx.fillStyle = activeTip;
    ctx.fill();
  }

  // Render the Bot's official shape slightly tucked under antennas
  ctx.save();
  ctx.translate(50, 57);
  ctx.scale(0.84, 0.84);
  ctx.translate(-50, -50);
  rokFillShape(ctx, shapePath, pal, isLight, 2.8);
  ctx.restore();

  // Centered glass visor pill inside the silhouette
  const vw = 44, vh = 24, vx = 50 - vw / 2, vy = 56 - vh / 2;
  rokRoundedRectPath(ctx, vx, vy, vw, vh, vh * 0.45);
  ctx.fillStyle = '#0f172a';
  ctx.fill();

  const gx = gaze.x * vw * 0.1 + (state === 'thinking' ? Math.sin(t * 4.5) * vw * 0.07 : 0);
  const gy = gaze.y * vh * 0.12 + (state === 'thinking' ? -vh * 0.06 : 0);
  const eyeFill = eyeInk || '#ffffff';
  ctx.strokeStyle = eyeFill;
  ctx.fillStyle = eyeFill;
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    const ex = vx + vw / 2 + side * vw * 0.21 + gx;
    const ey = vy + vh / 2 + gy;
    if (state === 'sleeping') {
      ctx.lineWidth = 2.8;
      ctx.beginPath(); ctx.arc(ex, ey, vw * 0.09, 0.2, Math.PI - 0.2); ctx.stroke();
    } else if (state === 'happy') {
      ctx.lineWidth = 3.0;
      ctx.beginPath(); ctx.arc(ex, ey + vh * 0.06, vw * 0.095, Math.PI + 0.35, -0.35); ctx.stroke();
    } else {
      const eh = vh * 0.48 * Math.max(0.1, 1 - blink) * (state === 'waiting' || state === 'error' ? 1.15 : 1);
      const ew = vw * 0.18;
      ctx.beginPath();
      ctx.ellipse(ex, ey, ew / 2, eh / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      if (eh > 5) {
        ctx.beginPath();
        ctx.arc(ex + gaze.x * ew * 0.18 - ew * 0.12, ey - eh * 0.16, ew * 0.16, 0, Math.PI * 2);
        ctx.fillStyle = pal.accent;
        ctx.fill();
        ctx.fillStyle = eyeFill;
      }
    }
  }
  ctx.restore();
}

function rokDrawVisor(ctx, shapePath, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  ctx.save();
  const sc = s / 100;
  const amp = emph ? 1.25 : 1;
  const bob = state === 'working' ? Math.sin(t * 7.5) * s * 0.022 * amp :
    state === 'happy' ? -Math.abs(Math.sin(t * 5)) * s * 0.036 * amp : Math.sin(t * 2) * s * 0.01;
  ctx.translate(s / 2 + gaze.x * s * 0.02, s / 2 + bob + gaze.y * s * 0.02);
  ctx.rotate(poke.angle);
  ctx.scale(1 + poke.bounce * 0.1, 1 - poke.bounce * 0.08);
  ctx.translate(-s / 2, -s / 2);
  ctx.scale(sc, sc);

  rokFillShape(ctx, shapePath, pal, isLight, 2.4);

  // Cyber visor band centered safely inside every official silhouette
  const vw = 50, vh = 22, vx = 50 - vw / 2, vy = 52 - vh / 2;
  rokRoundedRectPath(ctx, vx, vy, vw, vh, 6.5);
  ctx.fillStyle = '#090d16';
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.stroke();

  const led = eyeInk || rokSignalColor(state, pal);
  ctx.strokeStyle = led;
  ctx.fillStyle = led;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (state === 'thinking' || state === 'working') {
    const speed = state === 'working' ? 3.2 : 1.7;
    const pos = (Math.sin(t * speed) + 1) / 2;
    const beamX = vx + vw * 0.18 + pos * vw * 0.64;
    const beamW = vw * 0.24;
    const g = ctx.createLinearGradient(beamX - beamW, 0, beamX + beamW, 0);
    g.addColorStop(0, 'transparent');
    g.addColorStop(0.5, led);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    rokRoundedRectPath(ctx, vx + vw * 0.08, vy + vh * 0.32, vw * 0.84, vh * 0.36, vh * 0.18);
    ctx.fill();
  } else {
    const gx = gaze.x * vw * 0.08;
    const gy = gaze.y * vh * 0.1;
    for (const side of [-1, 1]) {
      const cx = vx + vw / 2 + side * vw * 0.21 + gx;
      const cy = vy + vh / 2 + gy;
      if (state === 'happy') {
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(cx - vw * 0.08, cy + vh * 0.12);
        ctx.lineTo(cx, cy - vh * 0.12);
        ctx.lineTo(cx + vw * 0.08, cy + vh * 0.12);
        ctx.stroke();
      } else if (state === 'sleeping') {
        ctx.fillRect(cx - vw * 0.08, cy - 1.2, vw * 0.16, 2.4);
      } else {
        const h = vh * 0.46 * Math.max(0.12, 1 - blink) * (state === 'waiting' || state === 'error' ? 1.2 : 1);
        rokRoundedRectPath(ctx, cx - vw * 0.07, cy - h / 2, vw * 0.14, h, 2.6);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function rokDrawPixel(ctx, shapePath, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  ctx.save();
  const sc = s / 100;
  const amp = emph ? 1.25 : 1;
  const bob = state === 'happy' ? -Math.abs(Math.sin(t * 5.2)) * s * 0.036 * amp :
    state === 'working' ? Math.sin(t * 8) * s * 0.018 * amp : 0;
  ctx.translate(s / 2, s / 2 + bob);
  ctx.rotate(poke.angle);
  ctx.scale(1 + poke.bounce * 0.1, 1 - poke.bounce * 0.08);
  ctx.translate(-s / 2, -s / 2);
  ctx.scale(sc, sc);

  rokFillShape(ctx, shapePath, pal, isLight, 2.4);

  // Inner matrix screen (8x6 grid) centered within any silhouette
  const mw = 42, mh = 31, mx = 50 - mw / 2, my = 55 - mh / 2;
  rokRoundedRectPath(ctx, mx, my, mw, mh, 6);
  ctx.fillStyle = '#0b101b';
  ctx.fill();

  const cols = 8, rows = 6;
  const cellW = mw / (cols + 1);
  const cellH = mh / (rows + 1);
  const px = cellW * 0.72;
  const py = cellH * 0.72;
  const dot = (c, r, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(mx + (c + 0.65) * cellW, my + (r + 0.65) * cellH, px, py);
  };

  const eyeCol = eyeInk || (state === 'error' ? '#f87171' : state === 'waiting' ? '#fbbf24' : state === 'happy' ? '#4ade80' : '#f8fafc');
  const stepX = Math.round(gaze.x * 0.8);
  const stepY = Math.round(gaze.y * 0.7);

  if (state === 'sleeping') {
    for (const c of [1, 2, 5, 6]) dot(c, 3, 'rgba(255,255,255,0.4)');
  } else if (state === 'happy') {
    for (const [c, r] of [[1, 3], [2, 2], [3, 3], [4, 3], [5, 2], [6, 3]]) dot(c, r, eyeCol);
  } else if (state === 'thinking') {
    const active = Math.floor(t * 4) % 3;
    for (let i = 0; i < 3; i++) {
      dot(2 + i * 2, 3, i === active ? pal.accent : 'rgba(255,255,255,0.28)');
    }
  } else if (state === 'working') {
    const phase = Math.floor(t * 8) % 4;
    const pts = [[2, 2], [5, 2], [5, 4], [2, 4]];
    pts.forEach(([c, r], idx) => {
      dot(c, r, idx === phase ? pal.accent : 'rgba(255,255,255,0.45)');
    });
    dot(3, 3, '#fff'); dot(4, 3, '#fff');
  } else {
    const closed = blink > 0.55;
    for (const baseC of [2, 5]) {
      const cc = Math.max(1, Math.min(6, baseC + stepX));
      if (closed) {
        dot(cc, 3, eyeCol);
      } else {
        const topR = Math.max(1, Math.min(3, 2 + stepY));
        dot(cc, topR, eyeCol);
        dot(cc, topR + 1, eyeCol);
      }
    }
  }

  // Top status bar LEDs
  const barPhase = Math.floor(t * 3) % 3;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = state === 'sleeping' ? 'rgba(255,255,255,0.25)' :
      (state === 'working' || state === 'thinking') && i === barPhase ? '#ffffff' : pal.accent;
    ctx.fillRect(50 - 11 + i * 8.2, my - 6.2, 5.6, 2.8);
  }
  ctx.restore();
}

function rokDrawOrb(ctx, shapePath, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  ctx.save();
  const sc = s / 100;
  const ampScale = emph ? 1.2 : 1;
  const speed = state === 'working' ? 4.2 : state === 'thinking' ? 2.8 : state === 'sleeping' ? 0.9 : 1.9;
  const wave = (state === 'sleeping' ? 0.02 : state === 'working' ? 0.065 : 0.04) * ampScale;
  const sx = 1 + wave * Math.sin(t * speed);
  const sy = 1 + wave * Math.cos(t * speed * 1.15);
  const cy = state === 'happy' ? -Math.abs(Math.sin(t * 5)) * s * 0.036 * ampScale : 0;

  ctx.translate(s / 2 + gaze.x * s * 0.028, s / 2 + cy + gaze.y * s * 0.028);
  ctx.rotate(poke.angle + Math.sin(t * speed * 0.7) * 0.035);
  ctx.scale(sx * (1 + poke.bounce * 0.14), sy * (1 - poke.bounce * 0.11));
  ctx.translate(-s / 2, -s / 2);
  ctx.scale(sc, sc);

  rokFillShape(ctx, shapePath, pal, isLight, 2.4);

  const gx = gaze.x * 4.5 + (state === 'thinking' ? Math.sin(t * 4) * 3.0 : 0);
  const gy = gaze.y * 4.0 + (state === 'thinking' ? -2.2 : 0);
  const eyeFill = eyeInk || '#ffffff';
  ctx.fillStyle = eyeFill;
  ctx.strokeStyle = eyeFill;
  ctx.lineCap = 'round';

  if (state === 'sleeping') {
    ctx.lineWidth = 3.6;
    ctx.beginPath(); ctx.arc(40.5, 52, 5.8, 0.2, Math.PI - 0.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(59.5, 49, 5.0, 0.2, Math.PI - 0.2); ctx.stroke();
  } else if (state === 'happy') {
    ctx.lineWidth = 4.0;
    ctx.beginPath(); ctx.arc(40.5 + gx * 0.4, 54 + gy * 0.4, 5.8, Math.PI + 0.35, -0.35); ctx.stroke();
    ctx.beginPath(); ctx.arc(59.5 + gx * 0.4, 50 + gy * 0.4, 5.2, Math.PI + 0.35, -0.35); ctx.stroke();
  } else {
    const eyeSy = Math.max(0.1, 1 - blink) * (state === 'waiting' || state === 'error' ? 1.14 : 1);
    for (const [ex, ey, h] of [[40.5, 52, 22], [59.5, 48, 18]]) {
      ctx.save();
      ctx.translate(ex + gx, ey + gy);
      ctx.rotate(-24 * Math.PI / 180);
      ctx.scale(1, eyeSy);
      rokRoundedRectPath(ctx, -4.6, -h / 2, 9.2, h, 4.6);
      ctx.fill();
      ctx.restore();
    }
  }

  // Orbiting signal satellite
  const satSpeed = state === 'working' ? 3.4 : state === 'thinking' ? 2.2 : state === 'sleeping' ? 0.4 : 1.1;
  const satA = t * satSpeed - 0.8;
  const satDist = 44;
  ctx.beginPath();
  ctx.arc(50 + Math.cos(satA) * satDist, 50 + Math.sin(satA) * satDist * 0.88, 4.6, 0, Math.PI * 2);
  ctx.fillStyle = rokSignalColor(state, pal);
  ctx.fill();
  ctx.restore();
}

const ROK_AVATAR_RENDERERS = {
  chassis: rokDrawChassis,
  antenna: rokDrawAntenna,
  visor: rokDrawVisor,
  pixel: rokDrawPixel,
  orb: rokDrawOrb,
};

function rokDrawAvatarStyle(ctx, styleId, shapeName, s, t, gaze, blink, poke, rawState, pal, isLight, eyeInk, isEmphasized) {
  const fn = ROK_AVATAR_RENDERERS[styleId] || rokDrawChassis;
  const state = rokNormalizeAvatarState(rawState);
  const shapePath = rokGetShapePath(shapeName);
  fn(ctx, shapePath, s, t, gaze || { x: 0, y: 0 }, blink || 0, poke || { angle: 0, bounce: 0 }, state, pal || ROK_AVATAR_PRESETS.cyan, Boolean(isLight), eyeInk || null, Boolean(isEmphasized));
}

// One shared animation ticker + pointer tracker for every mounted avatar canvas.
const rokAvatarSubscribers = new Set();
let rokAvatarRaf = 0;
let rokAvatarHiddenBound = false;
const rokAvatarPointer = { x: 0, y: 0, active: false, watchers: 0, bound: false };
const rokAvatarSources = new Map();

function rokOnPointerMove(event) {
  rokAvatarPointer.x = event.clientX;
  rokAvatarPointer.y = event.clientY;
  rokAvatarPointer.active = true;
}

function rokOnPointerLeave() {
  rokAvatarPointer.active = false;
}

function rokTrackGlobalPointer(enable) {
  const win = globalThis.window;
  if (!win?.addEventListener) return;
  if (enable) {
    rokAvatarPointer.watchers += 1;
    if (!rokAvatarPointer.bound) {
      win.addEventListener('pointermove', rokOnPointerMove, { passive: true });
      win.addEventListener('pointerleave', rokOnPointerLeave);
      rokAvatarPointer.bound = true;
    }
  } else if (rokAvatarPointer.watchers > 0) {
    rokAvatarPointer.watchers -= 1;
    if (rokAvatarPointer.watchers === 0 && rokAvatarPointer.bound) {
      win.removeEventListener('pointermove', rokOnPointerMove);
      win.removeEventListener('pointerleave', rokOnPointerLeave);
      rokAvatarPointer.bound = false;
      rokAvatarPointer.active = false;
    }
  }
}

function rokPrefersReducedMotion() {
  try { return Boolean(globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
}

function rokAvatarFrame(nowMs) {
  rokAvatarRaf = 0;
  if (globalThis.document?.hidden || rokAvatarSubscribers.size === 0) return;
  const t = nowMs / 1000;
  for (const fn of [...rokAvatarSubscribers]) {
    try { fn(t, nowMs); } catch {}
  }
  if (!rokPrefersReducedMotion() && rokAvatarSubscribers.size > 0 && !globalThis.document?.hidden) {
    rokAvatarRaf = globalThis.requestAnimationFrame?.(rokAvatarFrame) ?? 0;
  }
}

function rokEnsureTicker() {
  if (!rokAvatarHiddenBound && globalThis.document?.addEventListener) {
    rokAvatarHiddenBound = true;
    globalThis.document.addEventListener('visibilitychange', () => {
      if (!globalThis.document.hidden && rokAvatarSubscribers.size > 0 && !rokAvatarRaf) {
        rokAvatarRaf = globalThis.requestAnimationFrame?.(rokAvatarFrame) ?? 0;
      }
    });
  }
  if (!rokAvatarRaf && rokAvatarSubscribers.size > 0 && !globalThis.document?.hidden && !rokPrefersReducedMotion()) {
    rokAvatarRaf = globalThis.requestAnimationFrame?.(rokAvatarFrame) ?? 0;
  }
}

function rokSubscribeTicker(fn) {
  rokAvatarSubscribers.add(fn);
  rokEnsureTicker();
  return () => {
    rokAvatarSubscribers.delete(fn);
    if (rokAvatarSubscribers.size === 0 && rokAvatarRaf) {
      globalThis.cancelAnimationFrame?.(rokAvatarRaf);
      rokAvatarRaf = 0;
    }
  };
}

function rokUseIsomorphicLayoutEffect(effect, deps) {
  return (typeof X.useLayoutEffect === 'function' ? X.useLayoutEffect : X.useEffect)(effect, deps);
}

function RokAvatarCanvas({ styleId, shape, color, ink, eyeColor, state, sourceId, mirrorOf, isPaused, maxFrameRate, isEmphasized, isFollowingPointer, spinSignal, controllerRef }) {
  const canvasRef = X.useRef(null);
  const animRef = X.useRef({
    gaze: { x: 0, y: 0 },
    manualGaze: null,
    blinkAt: (globalThis.performance?.now?.() ?? 0) / 1000 + 1.1 + Math.random() * 2.4,
    pokeStart: -10,
    lastDrawMs: 0,
    lastSpin: spinSignal ?? 0,
    resolvedInk: null,
    resolvedEye: null,
  });
  const propsRef = X.useRef({});
  propsRef.current = { styleId, shape, color, ink, eyeColor, state, sourceId, mirrorOf, isPaused, maxFrameRate, isEmphasized, isFollowingPointer };

  const triggerPoke = () => {
    animRef.current.pokeStart = (globalThis.performance?.now?.() ?? 0) / 1000;
  };

  X.useEffect(() => {
    const nextSpin = spinSignal ?? 0;
    if (nextSpin !== animRef.current.lastSpin) {
      animRef.current.lastSpin = nextSpin;
      triggerPoke();
    }
  }, [spinSignal]);

  X.useEffect(() => {
    if (!controllerRef) return undefined;
    const handle = {
      poke(kind) { if (!kind || kind === 'spin') triggerPoke(); },
      setGaze(vec) {
        animRef.current.manualGaze = Array.isArray(vec) && vec.length >= 2
          ? { x: Number(vec[0]) || 0, y: Number(vec[1]) || 0 }
          : null;
      },
    };
    if (typeof controllerRef === 'function') controllerRef(handle);
    else controllerRef.current = handle;
    return () => {
      if (typeof controllerRef === 'function') controllerRef(null);
      else controllerRef.current = null;
    };
  }, [controllerRef]);

  X.useEffect(() => {
    if (!isFollowingPointer) return undefined;
    rokTrackGlobalPointer(true);
    return () => rokTrackGlobalPointer(false);
  }, [isFollowingPointer]);

  // Publish live state + shape into mirror source registry so RokGrokBotMarkMirror stays in sync.
  X.useEffect(() => {
    if (!sourceId || mirrorOf) return undefined;
    const entry = rokAvatarSources.get(sourceId) || {};
    entry.shape = shape;
    entry.color = color;
    entry.ink = ink;
    entry.eyeColor = eyeColor;
    entry.state = state;
    entry.anim = animRef.current;
    rokAvatarSources.set(sourceId, entry);
    return () => {
      const current = rokAvatarSources.get(sourceId);
      if (current?.anim === animRef.current) rokAvatarSources.delete(sourceId);
    };
  }, [sourceId, mirrorOf, shape, color, ink, eyeColor, state]);

  rokUseIsomorphicLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const refreshCssVars = () => {
      try {
        const parent = canvas.closest?.('.sand-grok-bot-mark') || canvas.parentElement;
        if (!parent || !globalThis.getComputedStyle) return;
        const cs = globalThis.getComputedStyle(parent);
        animRef.current.resolvedInk = cs.getPropertyValue('--grok-bot-ink')?.trim() || null;
        animRef.current.resolvedEye = cs.getPropertyValue('--grok-bot-eye')?.trim() || null;
      } catch {}
    };

    const drawOne = (t, nowMs) => {
      const p = propsRef.current;
      const a = animRef.current;
      const dpr = Math.min(globalThis.window?.devicePixelRatio || 1, 2);
      const rectW = canvas.clientWidth || canvas.parentElement?.clientWidth || 24;
      const rectH = canvas.clientHeight || canvas.parentElement?.clientHeight || rectW;
      const logical = Math.max(12, Math.min(rectW, rectH));
      const pxW = Math.round(rectW * dpr);
      const pxH = Math.round(rectH * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      const ctx = canvas.getContext?.('2d');
      if (!ctx) return;

      const mirrorEntry = p.mirrorOf ? rokAvatarSources.get(p.mirrorOf) : null;
      const effShape = p.shape ?? mirrorEntry?.shape ?? 'blob';
      const effColor = p.color ?? mirrorEntry?.color;
      const effInk = p.ink ?? mirrorEntry?.ink ?? a.resolvedInk;
      const effEye = p.eyeColor ?? mirrorEntry?.eyeColor ?? a.resolvedEye;
      const effState = p.state ?? mirrorEntry?.state ?? 'idle';
      const normState = rokNormalizeAvatarState(effState);

      let targetGx = 0, targetGy = 0;
      const manual = a.manualGaze ?? mirrorEntry?.anim?.manualGaze ?? null;
      if (manual && normState !== 'sleeping') {
        targetGx = Math.max(-1, Math.min(1, manual.x));
        targetGy = Math.max(-1, Math.min(1, manual.y));
      } else if (p.isFollowingPointer && rokAvatarPointer.active && normState !== 'sleeping') {
        const rect = canvas.getBoundingClientRect?.();
        if (rect && rect.width > 0) {
          const dx = rokAvatarPointer.x - (rect.left + rect.width / 2);
          const dy = rokAvatarPointer.y - (rect.top + rect.height / 2);
          const dist = Math.hypot(dx, dy) || 1;
          const clamp = Math.min(1, dist / 220);
          targetGx = (dx / dist) * clamp;
          targetGy = (dy / dist) * clamp;
        }
      }
      a.gaze.x += (targetGx - a.gaze.x) * 0.18;
      a.gaze.y += (targetGy - a.gaze.y) * 0.18;

      let blink = 0;
      if (!p.isPaused && t >= a.blinkAt) {
        const dt = t - a.blinkAt;
        if (dt < 0.16) blink = Math.sin((dt / 0.16) * Math.PI);
        else a.blinkAt = t + 2.6 + Math.random() * 2.4;
      }

      const pokeStart = Math.max(a.pokeStart, mirrorEntry?.anim?.pokeStart ?? -10);
      let pokeAngle = 0, pokeBounce = 0;
      const pokeDt = t - pokeStart;
      if (pokeDt >= 0 && pokeDt < 0.65) {
        const pr = pokeDt / 0.65;
        const ease = 1 - Math.pow(1 - pr, 3);
        pokeAngle = ease * Math.PI * 2;
        pokeBounce = Math.sin(pr * Math.PI) * (1 - pr);
      }

      const isLight = rokAvatarIsLightTheme();
      const pal = rokAvatarPalette(effColor, effInk, isLight);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rectW, rectH);
      ctx.translate((rectW - logical) / 2, (rectH - logical) / 2);
      rokDrawAvatarStyle(ctx, p.styleId, effShape, logical, t, a.gaze, blink, { angle: pokeAngle, bounce: pokeBounce }, normState, pal, isLight, effEye, p.isEmphasized);
      ctx.restore();
      a.lastDrawMs = nowMs;
    };

    refreshCssVars();
    const initNow = globalThis.performance?.now?.() ?? 0;
    drawOne(initNow / 1000, initNow);

    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => {
        const now = globalThis.performance?.now?.() ?? 0;
        drawOne(now / 1000, now);
      });
      ro.observe(canvas);
    }

    const unsub = rokSubscribeTicker((t, nowMs) => {
      const p = propsRef.current;
      if (p.isPaused) return;
      const maxFps = Number(p.maxFrameRate);
      if (maxFps > 0 && nowMs - animRef.current.lastDrawMs < 1000 / maxFps - 2) return;
      drawOne(t, nowMs);
    });

    return () => {
      unsub();
      ro?.disconnect?.();
    };
  }, [styleId, shape, color, ink, eyeColor, state, isPaused]);

  return Z.jsx('span', {
    style: { display: 'block', width: '100%', height: '100%', position: 'relative' },
    children: Z.jsx('canvas', {
      ref: canvasRef,
      style: { display: 'block', width: '100%', height: '100%' },
    }),
  });
}

function RokUseAvatarStyle() {
  const store = rokAvatarStyleStore();
  return X.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).style;
}

function RokGrokBotMark(e) {
  const activeStyle = RokUseAvatarStyle();
  const {
    color, sourceId, ink, shape, state, isPaused, maxFrameRate,
    isEmphasized, spinSignal, isFollowingPointer, eyeColor, className, style, children, ref,
  } = e;
  const resolvedShape = rokNormalizeShapeName(shape);
  const resolvedState = state === void 0 ? 'idle' : state;
  const pausedFlag = Boolean(isPaused);
  const rootMeta = Io(Ttt.root, style);
  const fullClass = NS('sand-grok-bot-mark', rootMeta.className, className);
  const safeColor = color === void 0 && ink === void 0 ? 'cyan' : color;
  const fullStyle = Ott(e, safeColor, ink, eyeColor, rootMeta.style);
  return Z.jsxs('span', {
    'aria-hidden': true,
    className: fullClass,
    'data-grok-state': resolvedState,
    'data-paused': pausedFlag || void 0,
    'data-rokbot-avatar-style': activeStyle,
    'data-rokbot-avatar-shape': resolvedShape,
    style: fullStyle,
    children: [
      Z.jsx(RokAvatarCanvas, {
        styleId: activeStyle,
        shape: resolvedShape,
        color,
        ink,
        eyeColor,
        state: resolvedState,
        sourceId,
        isPaused: pausedFlag,
        maxFrameRate,
        isEmphasized: Boolean(isEmphasized),
        isFollowingPointer: Boolean(isFollowingPointer),
        spinSignal: spinSignal === void 0 ? 0 : spinSignal,
        controllerRef: ref,
      }),
      children,
    ],
  });
}

function RokGrokBotMarkMirror(e) {
  const activeStyle = RokUseAvatarStyle();
  const { sourceId, color, shape, state, ink, eyeColor, className, style, children, ref } = e;
  const mirrorEntry = sourceId ? rokAvatarSources.get(sourceId) : null;
  const resolvedShape = rokNormalizeShapeName(shape ?? mirrorEntry?.shape);
  const resolvedState = state === void 0 ? (mirrorEntry?.state ?? 'idle') : state;
  const safeColor = color ?? mirrorEntry?.color ?? ((ink ?? mirrorEntry?.ink) === void 0 ? 'cyan' : void 0);
  const safeInk = ink ?? mirrorEntry?.ink;
  const safeEye = eyeColor ?? mirrorEntry?.eyeColor;
  const rootMeta = Io(Ttt.root, style);
  const fullClass = NS('sand-grok-bot-mark', 'sand-grok-bot-mark--mirror', rootMeta.className, className);
  const fullStyle = Ott(e, safeColor, safeInk, safeEye, rootMeta.style);
  return Z.jsxs('span', {
    'aria-hidden': true,
    className: fullClass,
    'data-grok-state': resolvedState,
    'data-rokbot-avatar-style': activeStyle,
    'data-rokbot-avatar-shape': resolvedShape,
    ref,
    style: fullStyle,
    children: [
      Z.jsx(RokAvatarCanvas, {
        styleId: activeStyle,
        shape: shape ?? mirrorEntry?.shape,
        color,
        ink,
        eyeColor,
        state: state,
        mirrorOf: sourceId,
        isPaused: false,
      }),
      children,
    ],
  });
}

try { rokAvatarStyleStore(); } catch {}
try {
  globalThis.__rokAvatarDraw = {
    draw: rokDrawAvatarStyle,
    palette: rokAvatarPalette,
    styles: ROK_AVATAR_STYLES,
    isLight: rokAvatarIsLightTheme,
    normalizeState: rokNormalizeAvatarState,
  };
} catch {}

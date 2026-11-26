// RokBot custom dynamic Bot avatar styles (desktop and Web).
// Default style is 'chassis' (RokBot Chassis / 机甲灵偶), replacing the official
// GrokBotMark fluid orb across every scene while preserving all 5 RokBot styles
// plus the 'official' style, selectable live in Settings > General.
const ROK_AVATAR_STORAGE_KEY = 'rokbot.avatarStyle.v1';
const ROK_AVATAR_DEFAULT_STYLE = 'chassis';
const ROK_AVATAR_STYLES = [
  { id: 'chassis', zh: '机甲灵偶', en: 'RokBot Chassis', descZh: '斜胶囊眼 + 脉冲信号灯', descEn: 'Tilted capsule eyes + beacon', defaultColor: 'cyan' },
  { id: 'antenna', zh: '双天线波波', en: 'Twin Antenna', descZh: '弹性双天线 + 玻璃面罩', descEn: 'Spring antennas + glass visor', defaultColor: 'violet' },
  { id: 'visor', zh: '赛博护目镜', en: 'Cyber Visor', descZh: '极客切角 + 扫描灯带', descEn: 'Chamfered shell + scanner LED', defaultColor: 'orange' },
  { id: 'pixel', zh: '像素精灵', en: 'Pixel Sprite', descZh: '点阵 LED 眼 + 节奏灯条', descEn: 'LED matrix eyes + status bar', defaultColor: 'green' },
  { id: 'orb', zh: '流体光球', en: 'Fluid Orb', descZh: '液体变形 + 轨道卫星', descEn: 'Morphing blob + orbiting dot', defaultColor: 'magenta' },
  { id: 'official', zh: '官方原版', en: 'Official', descZh: '保留官方动态流体球', descEn: 'Original dynamic fluid orb', defaultColor: 'blue' },
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
const ROK_AVATAR_CHASSIS_PATH_D = 'M 340 148 C 408 148 476 144 540 144 C 618 144 664 60 756 56 C 836 52 892 104 884 176 C 878 214 932 272 956 368 C 964 464 960 564 948 656 C 928 816 820 924 636 944 C 532 956 424 960 324 952 C 156 938 76 836 68 668 C 62 548 64 424 72 336 C 84 200 184 148 340 148 Z';

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

let rokChassisPathCache = null;
function rokGetChassisPath() {
  if (!rokChassisPathCache && typeof Path2D === 'function') {
    rokChassisPathCache = new Path2D(ROK_AVATAR_CHASSIS_PATH_D);
  }
  return rokChassisPathCache;
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

function rokDrawChassis(ctx, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  const path = rokGetChassisPath();
  if (!path) return rokDrawOrb(ctx, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph);
  ctx.save();
  const sc = s / 1024;
  const amp = emph ? 1.25 : 1;
  const breath = state === 'sleeping' ? 1 + Math.sin(t * 1.4) * 0.015 : 1 + Math.sin(t * 2.8) * 0.025 * amp;
  const bob = state === 'working' ? Math.sin(t * 7.5) * s * 0.028 * amp :
    state === 'happy' ? -Math.abs(Math.sin(t * 5.2)) * s * 0.045 * amp :
      state === 'thinking' ? Math.sin(t * 3.1) * s * 0.018 : Math.sin(t * 2.2) * s * 0.012;
  const tilt = state === 'thinking' ? Math.sin(t * 2.4) * 0.06 :
    state === 'working' ? Math.sin(t * 6) * 0.045 : 0;

  ctx.translate(s / 2 + gaze.x * s * 0.025, s / 2 + bob + gaze.y * s * 0.025);
  ctx.rotate(poke.angle + tilt);
  ctx.scale(breath * (1 + poke.bounce * 0.14), breath * (1 - poke.bounce * 0.1));
  ctx.translate(-s / 2, -s / 2);

  ctx.save();
  ctx.scale(sc, sc);
  ctx.fillStyle = rokMakeAvatarGrad(ctx, pal, 56, 960);
  ctx.fill(path);
  ctx.lineWidth = 26;
  ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.22)';
  ctx.stroke(path);

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
    ctx.arc(768, 144, 42 + halo * 74, 0, Math.PI * 2);
    ctx.strokeStyle = beaconColor;
    ctx.globalAlpha = (1 - halo) * 0.65;
    ctx.lineWidth = 18;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.arc(768, 144, 44 * beaconScale, 0, Math.PI * 2);
  ctx.fillStyle = beaconColor;
  ctx.fill();

  const gx = gaze.x * 48 + (state === 'thinking' ? Math.sin(t * 4) * 32 : 0);
  const gy = gaze.y * 42 + (state === 'thinking' ? -24 : 0);
  const eyeFill = eyeInk || '#ffffff';
  ctx.fillStyle = eyeFill;
  ctx.strokeStyle = eyeFill;
  ctx.lineCap = 'round';

  if (state === 'sleeping') {
    ctx.lineWidth = 42;
    ctx.beginPath(); ctx.arc(385, 575, 72, 0.2, Math.PI - 0.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(650, 520, 62, 0.2, Math.PI - 0.2); ctx.stroke();
  } else if (state === 'happy') {
    ctx.lineWidth = 48;
    ctx.beginPath(); ctx.arc(385 + gx * 0.4, 595 + gy * 0.4, 72, Math.PI + 0.35, -0.35); ctx.stroke();
    ctx.beginPath(); ctx.arc(650 + gx * 0.4, 540 + gy * 0.4, 62, Math.PI + 0.35, -0.35); ctx.stroke();
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
    drawCapsule(376, 564, 144, 332);
    drawCapsule(648, 504, 144, 268);
  }
  ctx.restore();
  ctx.restore();
}

function rokDrawAntenna(ctx, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  ctx.save();
  const bw = s * 0.76;
  const bh = s * 0.66;
  const bx = (s - bw) / 2;
  const by = s * 0.26;
  const amp = emph ? 1.25 : 1;
  const bob = state === 'working' ? Math.sin(t * 8) * s * 0.025 * amp :
    state === 'happy' ? -Math.abs(Math.sin(t * 5.2)) * s * 0.04 * amp : Math.sin(t * 2.4) * s * 0.012;
  const sway = Math.sin(t * (state === 'working' ? 8 : 2.6)) * 0.14 + poke.bounce * 0.4;

  ctx.translate(s / 2 + gaze.x * s * 0.02, s / 2 + bob + gaze.y * s * 0.02);
  ctx.rotate(poke.angle);
  ctx.scale(1 + poke.bounce * 0.12, 1 - poke.bounce * 0.09);
  ctx.translate(-s / 2, -s / 2);

  const activeTip = state === 'sleeping' ? pal.rim : rokSignalColor(state, pal);
  for (const side of [-1, 1]) {
    const rootX = s / 2 + side * s * 0.17;
    const rootY = by + s * 0.03;
    const tipX = rootX + side * s * 0.07 + Math.sin(t * 3 + side) * s * 0.025 + sway * s * 0.08;
    const tipY = s * 0.09 + Math.abs(sway) * s * 0.02;
    ctx.beginPath();
    ctx.moveTo(rootX, rootY);
    ctx.quadraticCurveTo(rootX + side * s * 0.02, (rootY + tipY) / 2, tipX, tipY);
    ctx.strokeStyle = pal.mid;
    ctx.lineWidth = Math.max(1.6, s * 0.045);
    ctx.lineCap = 'round';
    ctx.stroke();

    if (state === 'thinking' || state === 'working' || state === 'waiting' || state === 'error') {
      const pulse = (t * 1.8 + (side > 0 ? 0.5 : 0)) % 1;
      ctx.beginPath();
      ctx.arc(tipX, tipY, s * 0.04 + pulse * s * 0.07, 0, Math.PI * 2);
      ctx.strokeStyle = activeTip;
      ctx.globalAlpha = (1 - pulse) * 0.6;
      ctx.lineWidth = Math.max(1, s * 0.02);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(tipX, tipY, s * 0.048, 0, Math.PI * 2);
    ctx.fillStyle = activeTip;
    ctx.fill();
  }

  rokRoundedRectPath(ctx, bx, by, bw, bh, s * 0.24);
  ctx.fillStyle = rokMakeAvatarGrad(ctx, pal, by, by + bh);
  ctx.fill();
  ctx.lineWidth = Math.max(1.1, s * 0.025);
  ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.16)' : 'rgba(255,255,255,0.22)';
  ctx.stroke();

  const vx = bx + bw * 0.13;
  const vy = by + bh * 0.22;
  const vw = bw * 0.74;
  const vh = bh * 0.56;
  rokRoundedRectPath(ctx, vx, vy, vw, vh, vh * 0.42);
  ctx.fillStyle = '#0f172a';
  ctx.fill();

  const gx = gaze.x * vw * 0.1 + (state === 'thinking' ? Math.sin(t * 4.5) * vw * 0.07 : 0);
  const gy = gaze.y * vh * 0.12 + (state === 'thinking' ? -vh * 0.06 : 0);
  const eyeFill = eyeInk || '#ffffff';
  ctx.strokeStyle = eyeFill;
  ctx.fillStyle = eyeFill;
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    const ex = vx + vw / 2 + side * vw * 0.2 + gx;
    const ey = vy + vh / 2 + gy;
    if (state === 'sleeping') {
      ctx.lineWidth = Math.max(1.4, s * 0.04);
      ctx.beginPath(); ctx.arc(ex, ey, vw * 0.09, 0.2, Math.PI - 0.2); ctx.stroke();
    } else if (state === 'happy') {
      ctx.lineWidth = Math.max(1.5, s * 0.044);
      ctx.beginPath(); ctx.arc(ex, ey + vh * 0.06, vw * 0.095, Math.PI + 0.35, -0.35); ctx.stroke();
    } else {
      const eh = vh * 0.46 * Math.max(0.1, 1 - blink) * (state === 'waiting' || state === 'error' ? 1.15 : 1);
      const ew = vw * 0.18;
      ctx.beginPath();
      ctx.ellipse(ex, ey, ew / 2, eh / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      if (eh > s * 0.06) {
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

function rokDrawVisor(ctx, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  ctx.save();
  const amp = emph ? 1.25 : 1;
  const bob = state === 'working' ? Math.sin(t * 7.5) * s * 0.022 * amp :
    state === 'happy' ? -Math.abs(Math.sin(t * 5)) * s * 0.04 * amp : Math.sin(t * 2) * s * 0.01;
  ctx.translate(s / 2 + gaze.x * s * 0.02, s / 2 + bob + gaze.y * s * 0.02);
  ctx.rotate(poke.angle);
  ctx.scale(1 + poke.bounce * 0.1, 1 - poke.bounce * 0.08);
  ctx.translate(-s / 2, -s / 2);

  const p = s * 0.11;
  const c = s * 0.22;
  ctx.beginPath();
  ctx.moveTo(p + c, p * 1.15);
  ctx.lineTo(s - p - c, p * 1.15);
  ctx.lineTo(s - p, p * 1.15 + c);
  ctx.lineTo(s - p, s - p - c);
  ctx.lineTo(s - p - c, s - p);
  ctx.lineTo(p + c, s - p);
  ctx.lineTo(p, s - p - c);
  ctx.lineTo(p, p * 1.15 + c);
  ctx.closePath();
  ctx.fillStyle = rokMakeAvatarGrad(ctx, pal, p, s - p);
  ctx.fill();
  ctx.lineWidth = Math.max(1.1, s * 0.025);
  ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.24)';
  ctx.stroke();

  const vx = s * 0.13;
  const vy = s * 0.34;
  const vw = s * 0.74;
  const vh = s * 0.34;
  rokRoundedRectPath(ctx, vx, vy, vw, vh, s * 0.09);
  ctx.fillStyle = '#090d16';
  ctx.fill();
  ctx.lineWidth = Math.max(0.9, s * 0.02);
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
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
        ctx.lineWidth = Math.max(1.6, s * 0.045);
        ctx.beginPath();
        ctx.moveTo(cx - vw * 0.08, cy + vh * 0.08);
        ctx.lineTo(cx, cy - vh * 0.1);
        ctx.lineTo(cx + vw * 0.08, cy + vh * 0.08);
        ctx.stroke();
      } else if (state === 'sleeping') {
        ctx.fillRect(cx - vw * 0.08, cy - s * 0.015, vw * 0.16, Math.max(1.4, s * 0.03));
      } else {
        const h = vh * 0.44 * Math.max(0.12, 1 - blink) * (state === 'waiting' || state === 'error' ? 1.2 : 1);
        rokRoundedRectPath(ctx, cx - vw * 0.065, cy - h / 2, vw * 0.13, h, s * 0.03);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function rokDrawPixel(ctx, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  ctx.save();
  const amp = emph ? 1.25 : 1;
  const bob = state === 'happy' ? -Math.abs(Math.sin(t * 5.2)) * s * 0.04 * amp :
    state === 'working' ? Math.sin(t * 8) * s * 0.02 * amp : 0;
  ctx.translate(s / 2, s / 2 + bob);
  ctx.rotate(poke.angle);
  ctx.scale(1 + poke.bounce * 0.1, 1 - poke.bounce * 0.08);
  ctx.translate(-s / 2, -s / 2);

  const pad = s * 0.1;
  rokRoundedRectPath(ctx, pad, pad, s - pad * 2, s - pad * 2, s * 0.2);
  ctx.fillStyle = rokMakeAvatarGrad(ctx, pal, pad, s - pad);
  ctx.fill();
  ctx.lineWidth = Math.max(1.1, s * 0.025);
  ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.22)';
  ctx.stroke();

  const mx = s * 0.19;
  const my = s * 0.25;
  const mw = s * 0.62;
  const mh = s * 0.52;
  rokRoundedRectPath(ctx, mx, my, mw, mh, s * 0.09);
  ctx.fillStyle = '#0b101b';
  ctx.fill();

  const cols = 8, rows = 6;
  const cellW = mw / (cols + 1);
  const cellH = mh / (rows + 1);
  const px = Math.max(1.2, cellW * 0.72);
  const py = Math.max(1.2, cellH * 0.72);
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

  const barPhase = Math.floor(t * 3) % 3;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = state === 'sleeping' ? 'rgba(255,255,255,0.25)' :
      (state === 'working' || state === 'thinking') && i === barPhase ? '#ffffff' : rokSignalColor(state, pal);
    const bw = s * 0.08;
    ctx.fillRect(s / 2 - s * 0.15 + i * s * 0.11, s * 0.145, bw, Math.max(1.4, s * 0.04));
  }
  ctx.restore();
}

function rokDrawOrb(ctx, s, t, gaze, blink, poke, state, pal, isLight, eyeInk, emph) {
  ctx.save();
  const ampScale = emph ? 1.2 : 1;
  const cx = s / 2 + gaze.x * s * 0.03;
  const cy = s / 2 + gaze.y * s * 0.03 + (state === 'happy' ? -Math.abs(Math.sin(t * 5)) * s * 0.04 * ampScale : 0);

  ctx.translate(cx, cy);
  ctx.rotate(poke.angle);
  ctx.scale(1 + poke.bounce * 0.14, 1 - poke.bounce * 0.11);

  const pts = 32;
  const baseR = s * 0.37;
  const speed = state === 'working' ? 4.2 : state === 'thinking' ? 2.8 : state === 'sleeping' ? 0.9 : 1.9;
  const amp = (state === 'sleeping' ? 0.025 : state === 'working' ? 0.085 : 0.055) * ampScale;
  const coords = [];
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const r = baseR * (1 + amp * Math.sin(a * 3 + t * speed) + amp * 0.6 * Math.cos(a * 2 - t * speed * 1.3));
    coords.push([Math.cos(a) * r, Math.sin(a) * r]);
  }

  ctx.beginPath();
  for (let i = 0; i < pts; i++) {
    const p0 = coords[i];
    const p1 = coords[(i + 1) % pts];
    const mx = (p0[0] + p1[0]) / 2;
    const my = (p0[1] + p1[1]) / 2;
    if (i === 0) {
      const prev = coords[pts - 1];
      ctx.moveTo((prev[0] + p0[0]) / 2, (prev[1] + p0[1]) / 2);
    }
    ctx.quadraticCurveTo(p0[0], p0[1], mx, my);
  }
  ctx.closePath();
  ctx.fillStyle = rokMakeAvatarGrad(ctx, pal, -baseR, baseR);
  ctx.fill();
  ctx.lineWidth = Math.max(1.1, s * 0.024);
  ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.14)' : 'rgba(255,255,255,0.2)';
  ctx.stroke();

  const gx = gaze.x * s * 0.055 + (state === 'thinking' ? Math.sin(t * 4) * s * 0.035 : 0);
  const gy = gaze.y * s * 0.05 + (state === 'thinking' ? -s * 0.025 : 0);
  const eyeFill = eyeInk || '#ffffff';
  ctx.fillStyle = eyeFill;
  ctx.strokeStyle = eyeFill;
  ctx.lineCap = 'round';

  if (state === 'sleeping') {
    ctx.lineWidth = Math.max(1.4, s * 0.04);
    ctx.beginPath(); ctx.arc(-s * 0.11, s * 0.02, s * 0.065, 0.2, Math.PI - 0.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(s * 0.11, -s * 0.02, s * 0.055, 0.2, Math.PI - 0.2); ctx.stroke();
  } else if (state === 'happy') {
    ctx.lineWidth = Math.max(1.5, s * 0.044);
    ctx.beginPath(); ctx.arc(-s * 0.11 + gx * 0.4, s * 0.04 + gy * 0.4, s * 0.065, Math.PI + 0.35, -0.35); ctx.stroke();
    ctx.beginPath(); ctx.arc(s * 0.11 + gx * 0.4, gy * 0.4, s * 0.058, Math.PI + 0.35, -0.35); ctx.stroke();
  } else {
    const sy = Math.max(0.1, 1 - blink) * (state === 'waiting' || state === 'error' ? 1.14 : 1);
    for (const [ex, ey, h] of [[-s * 0.105, s * 0.015, s * 0.25], [s * 0.105, -s * 0.035, s * 0.2]]) {
      ctx.save();
      ctx.translate(ex + gx, ey + gy);
      ctx.rotate(-24 * Math.PI / 180);
      ctx.scale(1, sy);
      rokRoundedRectPath(ctx, -s * 0.052, -h / 2, s * 0.104, h, s * 0.052);
      ctx.fill();
      ctx.restore();
    }
  }

  const satSpeed = state === 'working' ? 3.4 : state === 'thinking' ? 2.2 : state === 'sleeping' ? 0.4 : 1.1;
  const satA = t * satSpeed - 0.8;
  const satDist = baseR + s * 0.075;
  ctx.beginPath();
  ctx.arc(Math.cos(satA) * satDist, Math.sin(satA) * satDist * 0.86, s * 0.05, 0, Math.PI * 2);
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

function rokDrawAvatarStyle(ctx, styleId, s, t, gaze, blink, poke, rawState, pal, isLight, eyeInk, isEmphasized) {
  const fn = ROK_AVATAR_RENDERERS[styleId] || rokDrawChassis;
  const state = rokNormalizeAvatarState(rawState);
  fn(ctx, s, t, gaze || { x: 0, y: 0 }, blink || 0, poke || { angle: 0, bounce: 0 }, state, pal || ROK_AVATAR_PRESETS.cyan, Boolean(isLight), eyeInk || null, Boolean(isEmphasized));
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

function RokAvatarCanvas({ styleId, color, ink, eyeColor, state, sourceId, mirrorOf, isPaused, maxFrameRate, isEmphasized, isFollowingPointer, spinSignal, controllerRef }) {
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
  propsRef.current = { styleId, color, ink, eyeColor, state, sourceId, mirrorOf, isPaused, maxFrameRate, isEmphasized, isFollowingPointer };

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

  // Publish live state into mirror source registry so RokGrokBotMarkMirror can stay in sync.
  X.useEffect(() => {
    if (!sourceId || mirrorOf) return undefined;
    const entry = rokAvatarSources.get(sourceId) || {};
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
  }, [sourceId, mirrorOf, color, ink, eyeColor, state]);

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
      rokDrawAvatarStyle(ctx, p.styleId, logical, t, a.gaze, blink, { angle: pokeAngle, bounce: pokeBounce }, normState, pal, isLight, effEye, p.isEmphasized);
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
  }, [styleId, color, ink, eyeColor, state, isPaused]);

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
    color, sourceId, ink, state, isPaused, maxFrameRate,
    isEmphasized, spinSignal, isFollowingPointer, eyeColor, className, style, children, ref,
  } = e;
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
    style: fullStyle,
    children: [
      Z.jsx(RokAvatarCanvas, {
        styleId: activeStyle,
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
  const { sourceId, color, state, ink, eyeColor, className, style, children, ref } = e;
  const mirrorEntry = sourceId ? rokAvatarSources.get(sourceId) : null;
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
    ref,
    style: fullStyle,
    children: [
      Z.jsx(RokAvatarCanvas, {
        styleId: activeStyle,
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

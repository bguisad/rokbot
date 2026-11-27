import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { Auth } from '../server/auth.mjs';
import { DEFAULT_BARK_ICON_URL } from '../server/push-config.mjs';
import { PushService } from '../server/push-service.mjs';
import { PushTransports } from '../server/push-transports.mjs';

const ROOT = new URL('../../', import.meta.url);
const readText = rel => readFileSync(new URL(rel, ROOT), 'utf8');
const readBytes = rel => readFileSync(new URL(rel, ROOT));

function memory(store) {
  store.value = structuredClone(store.initial);
  store.mutate = async update => update(store.value);
}

function parsePngIhdr(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'valid PNG signature');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25], // 2 = RGB (no alpha), 6 = RGBA
  };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  const ihdr = parsePngIhdr(buf);
  const idatChunks = [];
  let offset = 8;
  let compression = 0;
  let filter = 0;
  let interlace = 0;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= buf.length, `truncated PNG chunk ${type}`);
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      compression = data[10];
      filter = data[11];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  assert.equal(ihdr.bitDepth, 8, 'expected 8-bit PNG');
  assert.equal(compression, 0, 'expected zlib compression');
  assert.equal(filter, 0, 'expected standard PNG filtering');
  assert.equal(interlace, 0, 'expected non-interlaced PNG');
  assert.ok(ihdr.colorType === 2 || ihdr.colorType === 6, `unsupported PNG colorType ${ihdr.colorType}`);

  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const stride = ihdr.width * bpp;
  const raw = inflateSync(Buffer.concat(idatChunks));
  assert.equal(raw.length, ihdr.height * (1 + stride), 'expected exact decompressed scanline length');

  const pixels = new Uint8Array(ihdr.height * stride);
  for (let y = 0; y < ihdr.height; y++) {
    const rowStart = y * (1 + stride);
    const filterType = raw[rowStart];
    const outRow = y * stride;
    const prevRow = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[rowStart + 1 + i];
      const a = i >= bpp ? pixels[outRow + i - bpp] : 0;
      const b = y > 0 ? pixels[prevRow + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[prevRow + i - bpp] : 0;
      let val;
      if (filterType === 0) val = x;
      else if (filterType === 1) val = (x + a) & 0xff;
      else if (filterType === 2) val = (x + b) & 0xff;
      else if (filterType === 3) val = (x + ((a + b) >> 1)) & 0xff;
      else if (filterType === 4) val = (x + paethPredictor(a, b, c)) & 0xff;
      else assert.fail(`unknown PNG filter type ${filterType}`);
      pixels[outRow + i] = val;
    }
  }
  return { ...ihdr, bpp, pixels };
}

test('DEFAULT_BARK_ICON_URL is empty and PushService omits icon from Bark payloads when unconfigured', async () => {
  assert.equal(DEFAULT_BARK_ICON_URL, '');
  const calls = [];
  const auth = new Auth('.');
  memory(auth.store);
  const transports = new PushTransports({
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('{"code":200}', { status: 200 });
    },
  });
  const service = new PushService('.', auth, { transports });
  memory(service.store);
  memory(service.config.store);

  const { pairingKey } = await auth.createPairing();
  const { deviceId } = await auth.pair({ platform: 'ios', deviceName: 'iPhone', pairingKey });
  await service.register(deviceId, {
    kind: 'iphone',
    bundleId: 'dev.rokbot.local',
    appVersion: '1.16.0',
    authorization: 'granted',
    push: { provider: 'bark', barkUrl: 'https://api.day.app/testkey1234' },
  });
  await service.test(deviceId, 'bot-1');
  assert.equal(calls.length, 1);
  assert.equal('icon' in calls[0].body, false);
});

test('RokBot logo manifest, PNGs, ICO, ICNS, Android mipmaps, and iOS RGB AppIcons match disk assets', () => {
  const manifest = JSON.parse(readText('assets/logo/manifest.json'));
  assert.equal(manifest.schema, 'rokbot-logo-manifest/v1');

  const checkPng = (entry, expectedColorType) => {
    const buf = readBytes(entry.path);
    const ihdr = parsePngIhdr(buf);
    assert.equal(ihdr.width, entry.width, `${entry.path} width`);
    assert.equal(ihdr.height, entry.height, `${entry.path} height`);
    assert.equal(ihdr.colorType, expectedColorType, `${entry.path} PNG colorType`);
    assert.equal(createHash('sha256').update(buf).digest('hex'), entry.sha256, `${entry.path} sha256`);
  };

  checkPng(manifest.hostIcon, 6);
  assert.equal(manifest.hostIcon.path, 'host/server/public/rokbot-icon.png');
  assert.equal(manifest.png.length, 10);
  for (const item of manifest.png) checkPng(item, 6);

  assert.equal(manifest.android.length, 15);
  for (const item of manifest.android) checkPng(item, 6);

  assert.equal(manifest.ios.length, 5);
  for (const item of manifest.ios) {
    assert.equal(item.mode, 'RGB');
    assert.equal(item.hasAlpha, false);
    checkPng(item, 2);
  }

  const icoBuf = readBytes(manifest.ico.path);
  assert.equal(icoBuf.readUInt16LE(0), 0);
  assert.equal(icoBuf.readUInt16LE(2), 1);
  assert.equal(icoBuf.readUInt16LE(4), 7);
  const icoSizes = [];
  for (let i = 0; i < 7; i++) {
    const entryOff = 6 + i * 16;
    const w = icoBuf[entryOff] || 256;
    const h = icoBuf[entryOff + 1] || 256;
    const bytesInRes = icoBuf.readUInt32LE(entryOff + 8);
    const imageOffset = icoBuf.readUInt32LE(entryOff + 12);
    assert.equal(w, h, `ICO entry ${i} square`);
    const frameIhdr = parsePngIhdr(icoBuf.subarray(imageOffset, imageOffset + bytesInRes));
    assert.equal(frameIhdr.width, w, `ICO entry ${i} PNG width`);
    assert.equal(frameIhdr.height, h, `ICO entry ${i} PNG height`);
    icoSizes.push(w);
  }
  assert.deepEqual(icoSizes, [16, 24, 32, 48, 64, 128, 256]);
  assert.equal(createHash('sha256').update(icoBuf).digest('hex'), manifest.ico.sha256);

  const icnsBuf = readBytes(manifest.icns.path);
  assert.equal(icnsBuf.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(createHash('sha256').update(icnsBuf).digest('hex'), manifest.icns.sha256);
});

test('Android adaptive foreground stays within 66dp safe circle and round icon has zero circular mask ringing', () => {
  const manifest = JSON.parse(readText('assets/logo/manifest.json'));
  const foregroundEntries = manifest.android.filter(item => item.kind === 'ic_launcher_foreground');
  const roundEntries = manifest.android.filter(item => item.kind === 'ic_launcher_round');
  assert.equal(foregroundEntries.length, 5);
  assert.equal(roundEntries.length, 5);

  for (const entry of foregroundEntries) {
    const { width, height, pixels } = decodePng(readBytes(entry.path));
    assert.equal(width, entry.width);
    assert.equal(height, entry.height);
    let opaqueCount = 0;
    let maxRDp = 0;
    let safeViolations = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = pixels[(y * width + x) * 4 + 3];
        if (alpha > 0) {
          if (alpha === 255) opaqueCount++;
          const rDp = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) * 108.0 / width;
          if (rDp > maxRDp) maxRDp = rDp;
          if (rDp > 33.0) safeViolations++;
        }
      }
    }
    assert.ok(opaqueCount > 0, `${entry.path} has opaque foreground pixels`);
    assert.equal(
      safeViolations,
      0,
      `${entry.path} has ${safeViolations} alpha>0 pixels outside 33.0dp safe circle (max_r_dp=${maxRDp.toFixed(3)})`,
    );
  }

  for (const entry of roundEntries) {
    const { width, height, pixels } = decodePng(readBytes(entry.path));
    assert.equal(width, entry.width);
    assert.equal(height, entry.height);
    const radius = width / 2;
    let disjointNonZero = 0;
    let interiorUndershoot = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = pixels[(y * width + x) * 4 + 3];
        const cx = Math.min(Math.max(radius, x), x + 1);
        const cy = Math.min(Math.max(radius, y), y + 1);
        const dMin = Math.hypot(cx - radius, cy - radius);
        if (dMin > radius && alpha > 0) disjointNonZero++;
        const r = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
        if (r < radius - 1.5 && alpha < 255) interiorUndershoot++;
      }
    }
    assert.equal(disjointNonZero, 0, `${entry.path} leaks alpha>0 outside inscribed circle`);
    assert.equal(interiorUndershoot, 0, `${entry.path} has alpha<255 undershoot inside r < R-1.5`);
  }
});

test('Host UI brand marks, favicon, animated face exports, and /rokbot-icon.png route are wired cleanly', async () => {
  const masterSvg = readText('assets/logo/rokbot-logo.svg');
  const faviconSvg = readText('host/server/public/favicon.svg');
  const indexHtml = readText('host/server/public/index.html');
  const webLoginHtml = readText('host/server/public/web-login.html');
  const shellCss = readText('host/server/public/shell.css');
  const stageCss = readText('host/server/public/stage.css');
  const pushJs = readText('host/server/public/push.js');
  const indexMjs = readText('host/server/index.mjs');

  for (const svg of [masterSvg, faviconSvg, indexHtml, webLoginHtml]) {
    assert.match(svg, /brand-tile/);
    assert.match(svg, /brand-face/);
    assert.match(svg, /brand-eye/);
    assert.match(svg, /brand-accent/);
  }
  // The favicon is the master logo itself: fixed white tile in both color schemes.
  assert.equal(faviconSvg, masterSvg);
  assert.doesNotMatch(faviconSvg, /prefers-color-scheme/);
  // Inline brand marks: one gradient id per mark so a hidden copy never breaks a visible one.
  for (const html of [indexHtml, webLoginHtml]) {
    const marks = html.match(/<svg class="brand-mark"[\s\S]*?<\/svg>/g) || [];
    assert.ok(marks.length >= 1);
    const ids = [...html.matchAll(/\bid="(rokbot-[a-z-]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'brand-mark gradient ids must be unique per page');
    for (const mark of marks) {
      assert.match(mark, /rx="308"/);
      assert.match(mark, /stop-color="#f4fbfe"/);
      assert.match(mark, /stop-color="#c9eef7"/);
      assert.match(mark, /translate\(512 512\) scale\(0\.84\) translate\(-512 -506\)/);
    }
  }
  assert.match(shellCss, /\.brand-mark\s+\.brand-accent/);
  assert.match(shellCss, /\.brand-mark\s+\.brand-tile-edge\s*\{[^}]*vector-effect:\s*non-scaling-stroke/);
  assert.doesNotMatch(shellCss, /\.brand-mark\s+\.brand-face\s*\{[^}]*var\(--sand/, 'brand colors no longer follow the theme');
  assert.match(stageCss, /rotate\(-26deg\)/);
  assert.doesNotMatch(indexMjs, /grok-bot-icon\.png|mzstatic\.com|DEFAULT_BARK_ICON_URL/);
  assert.match(indexMjs, /path\s*===\s*["']\/rokbot-icon\.png["']/);
  assert.doesNotMatch(pushJs, /grok-bot-icon\.png|mzstatic\.com/);
  assert.match(pushJs, /https:\/\/example\.com\/rokbot-icon\.png/);
});

function pixelAt(png, x, y) {
  const i = (y * png.width + x) * png.bpp;
  return [...png.pixels.subarray(i, i + png.bpp)];
}

function extractIcnsPngs(buf) {
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'icns', 'valid ICNS magic');
  const pngs = new Map();
  let off = 8;
  while (off + 8 <= buf.length) {
    const type = buf.subarray(off, off + 4).toString('ascii');
    const len = buf.readUInt32BE(off + 4);
    assert.ok(len >= 8 && off + len <= buf.length, `valid ICNS chunk ${type}`);
    const data = buf.subarray(off + 8, off + len);
    if (data.length >= 8 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
      pngs.set(type, decodePng(data));
    }
    off += len;
  }
  return pngs;
}

function extractIcoPngs(buf) {
  assert.equal(buf.readUInt16LE(0), 0);
  assert.equal(buf.readUInt16LE(2), 1);
  const count = buf.readUInt16LE(4);
  const pngs = new Map();
  for (let i = 0; i < count; i++) {
    const entryOff = 6 + i * 16;
    const w = buf[entryOff] || 256;
    const bytesInRes = buf.readUInt32LE(entryOff + 8);
    const imageOffset = buf.readUInt32LE(entryOff + 12);
    pngs.set(w, decodePng(buf.subarray(imageOffset, imageOffset + bytesInRes)));
  }
  return pngs;
}

test('White-tile master SVG, generator parser and rendered icons agree', () => {
  const svg = readText('assets/logo/rokbot-logo.svg');
  const gen = readText('assets/logo/generate_icons.py');
  const manifest = JSON.parse(readText('assets/logo/manifest.json'));

  // Tile: rx 308 (~30%), 160deg #F4FBFE -> #C9EEF7, white rim, faint hairline edge.
  assert.match(svg, /<rect class="brand-tile" width="1024" height="1024" rx="308" fill="url\(#rokbot-tile\)"\/>/);
  assert.match(svg, /class="brand-tile-rim" x="12" y="12" width="1000" height="1000" rx="296"[^>]*stroke="#ffffff"/);
  assert.match(svg, /class="brand-tile-edge" x="2" y="2" width="1020" height="1020" rx="306"/);
  const grad = /<linearGradient id="rokbot-tile" x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/.exec(svg);
  assert.ok(grad);
  const [x1, y1, x2, y2] = grad.slice(1).map(Number);
  const angle = (Math.atan2(x2 - x1, -(y2 - y1)) * 180) / Math.PI;
  assert.ok(Math.abs(((angle + 360) % 360) - 160) < 0.05, `tile gradient angle ${angle}`);
  const halfLen = 1024 * (Math.abs(Math.sin((160 * Math.PI) / 180)) + Math.abs(Math.cos((160 * Math.PI) / 180))) / 2;
  assert.ok(Math.abs(Math.hypot(x2 - x1, y2 - y1) / 2 - halfLen) < 0.05, 'CSS gradient line length');
  assert.match(svg, /stop-color="#f4fbfe"[\s\S]*stop-color="#c9eef7"/);
  assert.match(svg, /<g class="brand-glyph" transform="translate\(512 512\) scale\(0\.84\) translate\(-512 -506\)">/);
  assert.doesNotMatch(svg, /<image|data:image/, 'master stays pure vector');

  // generate_icons.py loads geometry, palette, and tile spec directly from assets/logo/rokbot-logo.svg.
  assert.match(gen, /^MASTER_SVG_PATH = LOGO_DIR \/ "rokbot-logo\.svg"$/m);
  assert.match(gen, /^def load_master_svg_spec\(/m);
  assert.match(gen, /^MASTER_SPEC = load_master_svg_spec\(MASTER_SVG_PATH\)$/m);
  assert.equal(manifest.masterSvg, 'assets/logo/rokbot-logo.svg');
  assert.equal(manifest.masterSvgSha256, createHash('sha256').update(readBytes('assets/logo/rokbot-logo.svg')).digest('hex'));
  assert.deepEqual(manifest.tile, { radius: 308, gradientAngle: 160, gradientStops: ['#F4FBFE', '#C9EEF7'], glyphScale: 0.84 });

  const near = (actual, expected, tol, label) =>
    expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) <= tol, `${label}: ${actual} vs ${expected}`));

  // Transparent-corner tile PNGs: clear corner, light tile near the edge, dark head in the middle.
  const icon = decodePng(readBytes('assets/logo/rokbot-icon-1024.png'));
  assert.equal(pixelAt(icon, 4, 4)[3], 0, 'tile corner is transparent');
  near(pixelAt(icon, 512, 40), [0xe6, 0xf7, 0xfb, 255], 14, 'top of the tile is near-white');
  near(pixelAt(icon, 512, 990), [0xd2, 0xf0, 0xf8, 255], 14, 'bottom of the tile is light cyan');
  const head = pixelAt(icon, 512, 800);
  assert.ok(head[0] < 0x30 && head[1] < 0x30 && head[2] < 0x40 && head[3] === 255, `head is dark: ${head}`);

  // Opaque full-bleed variants for platforms that mask icons themselves.
  for (const rel of ['assets/logo/ios/AppIcon-1024.png', 'host/server/public/rokbot-icon.png']) {
    const png = decodePng(readBytes(rel));
    const last = png.width - 1;
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      const px = pixelAt(png, x, y);
      if (png.bpp === 4) assert.equal(px[3], 255, `${rel} corner opaque`);
      assert.ok(px[0] > 0xc0 && px[1] > 0xe0 && px[2] > 0xe8, `${rel} corner is the light tile: ${px}`);
    }
  }

  // Android adaptive foreground: the head alone, transparent around it.
  const fg = decodePng(readBytes('assets/logo/android/mipmap-xxxhdpi/ic_launcher_foreground.png'));
  assert.equal(pixelAt(fg, 2, 2)[3], 0);
  assert.equal(pixelAt(fg, fg.width / 2, fg.height / 2 + 40)[3], 255);
  assert.match(manifest.androidIconBackground, /^#FF[0-9A-F]{6}$/);
});

test('Desktop icons (macOS ICNS, Windows ICO, Linux PNGs) and mobile icons share the same white-tile RokBot design', () => {
  const icnsPngs = extractIcnsPngs(readBytes('assets/logo/rokbot.icns'));
  const icoPngs = extractIcoPngs(readBytes('assets/logo/rokbot.ico'));

  const mac1024 = icnsPngs.get('ic10');
  const mac512 = icnsPngs.get('ic09');
  assert.ok(mac1024 && mac1024.width === 1024 && mac1024.height === 1024, 'macOS ICNS contains 1024x1024 ic10 PNG');
  assert.ok(mac512 && mac512.width === 512 && mac512.height === 512, 'macOS ICNS contains 512x512 ic09 PNG');

  // macOS Big Sur+ spec: 824x824 rounded tile centered in 1024x1024 canvas (~100 px standard margin, never full-bleed).
  for (const [x, y] of [[0, 0], [16, 16], [512, 24], [24, 512], [1000, 512]]) {
    assert.equal(pixelAt(mac1024, x, y)[3], 0, `macOS ICNS outer margin (${x},${y}) must be transparent`);
  }
  let minX = 1024, minY = 1024, maxX = -1, maxY = -1;
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      if (pixelAt(mac1024, x, y)[3] >= 200) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const tileW = maxX - minX + 1;
  const tileH = maxY - minY + 1;
  assert.ok(tileW >= 816 && tileW <= 832, `macOS ICNS opaque tile width ${tileW} matches 824px Big Sur grid`);
  assert.ok(tileH >= 816 && tileH <= 832, `macOS ICNS opaque tile height ${tileH} matches 824px Big Sur grid`);
  assert.ok(Math.abs(minX - 100) <= 4 && Math.abs(minY - 100) <= 4, `macOS ICNS tile centered with ~100px margin (${minX},${minY})`);

  const win256 = icoPngs.get(256);
  assert.ok(win256 && win256.width === 256 && win256.height === 256, 'Windows ICO contains 256x256 PNG');
  const linux512 = decodePng(readBytes('assets/logo/rokbot-icon-512.png'));
  const android192 = decodePng(readBytes('assets/logo/android/mipmap-xxxhdpi/ic_launcher.png'));
  const ios1024 = decodePng(readBytes('assets/logo/ios/AppIcon-1024.png'));

  for (const [label, png] of [['Windows ICO', win256], ['Linux 512 PNG', linux512], ['Android ic_launcher', android192]]) {
    assert.equal(pixelAt(png, 2, 2)[3], 0, `${label} outer corner is transparent`);
  }

  // Canonical landmark points in 1024-tile coordinates:
  // tileTop, tileBottom, dark chassis head, left tilted eye, upper-right cyan crest beacon.
  const toGlyph = (x, y) => [512 + (x - 512) * 0.84, 512 + (y - 506) * 0.84];
  const landmarks = {
    tileTop: [512, 48],
    tileBottom: [512, 976],
    head: toGlyph(512, 760),
    leftEye: toGlyph(376, 564),
    beacon: toGlyph(768, 144),
  };

  const samplePlatform = (png, tileFrac) => {
    const side = png.width * tileFrac;
    const x0 = (png.width - side) / 2;
    const y0 = (png.height - side) / 2;
    return Object.fromEntries(
      Object.entries(landmarks).map(([name, [tx, ty]]) => {
        const px = Math.round(x0 + (tx / 1024) * side);
        const py = Math.round(y0 + (ty / 1024) * side);
        return [name, pixelAt(png, px, py)];
      }),
    );
  };

  const samples = {
    mac: samplePlatform(mac1024, 824 / 1024),
    windows: samplePlatform(win256, 1.0),
    linux: samplePlatform(linux512, 1.0),
    android: samplePlatform(android192, 44 / 48),
    ios: samplePlatform(ios1024, 1.0),
  };

  // Every desktop and mobile icon must render the same light-blue tile, dark head, off-white eyes, and cyan beacon.
  for (const [platform, s] of Object.entries(samples)) {
    const alphaOf = px => (px.length === 4 ? px[3] : 255);
    assert.equal(alphaOf(s.tileTop), 255, `${platform} tileTop opaque`);
    assert.ok(s.tileTop[0] > 220 && s.tileTop[1] > 240 && s.tileTop[2] > 245, `${platform} tileTop is light-blue/white: ${s.tileTop}`);
    assert.equal(alphaOf(s.tileBottom), 255, `${platform} tileBottom opaque`);
    assert.ok(s.tileBottom[0] > 190 && s.tileBottom[0] < 235 && s.tileBottom[1] > 230 && s.tileBottom[2] > 240, `${platform} tileBottom is light cyan: ${s.tileBottom}`);
    assert.ok(s.head[0] < 48 && s.head[1] < 48 && s.head[2] < 64 && alphaOf(s.head) === 255, `${platform} head is dark: ${s.head}`);
    assert.ok(s.leftEye[0] > 230 && s.leftEye[1] > 230 && s.leftEye[2] > 225 && alphaOf(s.leftEye) === 255, `${platform} leftEye is off-white: ${s.leftEye}`);
    assert.ok(s.beacon[0] < 90 && s.beacon[1] > 165 && s.beacon[2] > 220 && alphaOf(s.beacon) === 255, `${platform} beacon is cyan #38BDF8: ${s.beacon}`);
  }

  // Desktop icons (macOS, Windows, Linux) must match mobile (Android, iOS) within tight RGB tolerance at every landmark.
  for (const desktop of ['mac', 'windows', 'linux']) {
    for (const mobile of ['android', 'ios']) {
      for (const name of Object.keys(landmarks)) {
        const d = samples[desktop][name];
        const m = samples[mobile][name];
        for (let c = 0; c < 3; c++) {
          assert.ok(
            Math.abs(d[c] - m[c]) <= 16,
            `${desktop} vs ${mobile} mismatch at ${name}[ch=${c}]: ${d.slice(0, 3)} vs ${m.slice(0, 3)}`,
          );
        }
      }
    }
  }
});

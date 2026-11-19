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
    assert.match(svg, /brand-face/);
    assert.match(svg, /brand-eye/);
    assert.match(svg, /brand-accent/);
  }
  assert.match(faviconSvg, /prefers-color-scheme:\s*dark/);
  assert.match(shellCss, /\.brand-mark\s+\.brand-accent/);
  assert.match(stageCss, /rotate\(-26deg\)/);
  assert.doesNotMatch(indexMjs, /grok-bot-icon\.png|mzstatic\.com|DEFAULT_BARK_ICON_URL/);
  assert.match(indexMjs, /path\s*===\s*["']\/rokbot-icon\.png["']/);
  assert.doesNotMatch(pushJs, /grok-bot-icon\.png|mzstatic\.com/);
  assert.match(pushJs, /https:\/\/example\.com\/rokbot-icon\.png/);
});

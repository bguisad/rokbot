import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function readBytesInput(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return readFileSync(input);
  throw new TypeError('Expected Buffer, Uint8Array, or file path string');
}

// ---------------------------------------------------------------------------
// 1. Category-A vs Category-B Rebranding Scanner
// ---------------------------------------------------------------------------

export const CATEGORY_B_CONSTANTS = [
  /ai\.x\.grok\.bot/g,
  /co\.anysphere\.sand/g,
  /com\.anysphere\.sand/g,
  /Grok Bot\.app/g,
  /Grok Bot\.exe/g,
  /Grok Bot Computer Use(?:\.app)?/g,
  /CUGrokBotService/g,
  /https?:\/\/api\.x\.ai\b|api\.x\.ai/g,
  /api2\.cursor\.sh/g,
  /downloads\.cursor\.com/g,
  /\/aiserver\.v1\.GrokBotService\/[A-Za-z0-9_]+/g,
  /\/aiserver\.v1\.(?:DashboardService|AiService|AnalyticsService)\/[A-Za-z0-9_]+/g,
  /GetGrokBotMcpToolPermissions|SetGrokBotMcpToolPermissions|ListPublicGrokBotMarketplaceListings/g,
  /ListGrokBotAgents|SendGrokBotUserMessage|GetGrokBotSendStatus|MintSandVoiceCallSecret/g,
  /GROK_BOT_(?:TOOL_PERMISSION|SEND_STATUS|TEMPORAL_HARNESS_MODE_BOX|USER_MESSAGE_DELIVERY)_[A-Z0-9_]+/g,
  /sand-host/g,
  /\bSandHost\b/g,
  /\bSAND_[A-Z0-9_]+\b/g,
  /dune-rpc:(?:main|[a-z0-9-]+):[A-Za-z0-9_:*.-]*/g,
  /grokbot:\/\/app\/v1\/chat/g,
  /Grok_Bot_[\w.${}-]+_(?:Setup\.exe|\.dmg)/g,
  /GrokBotPresenceAppGroup|GrokBotActionURL|GrokBotLinks|sand-grok-bot-mark/g,
  /grok_bot_box_harness_turns_blocked|(?:list|upload|delete)GrokBot(?:AgentFiles?|UserStoreFiles?)|(?:get|mark)GrokBotTerms[A-Za-z]*/g,
  /apps\.apple\.com\/us\/app\/grok-bot\/id6794501026|x\.ai\/changelog\/bot|docs\.x\.ai\/grok-bot\/deployment/g,
  /sand-op-launcher|sand-webauthn-signer|sand-mobile|SandAppGroupIdentifier|SandKeychainAccessGroups|sand\.cursor-tokens/g,
];

export const CATEGORY_A_RE = new RegExp([
  '\\bGROKBOT_[A-Z0-9_]*',
  '\\bPROKBOT_[A-Z0-9_]*',
  '\\bx-grokbot-[a-z0-9-]*',
  '\\bgrokbot_admin\\b',
  '\\bgrokbot_web\\b',
  '\\bgrokbot_vnc(?:_[a-z0-9_${}]+)?',
  '\\bgrokbot_[a-z0-9_]+',
  'dev\\.grokbot\\.(?:nativeapp|local)\\b',
  'dev_grokbot_(?:nativeapp|local)',
  '\\blibgroktailcat(?:jni)?\\.so\\b',
  '\\bGBTailcat[A-Za-z0-9_]*',
  'grokbot-local://',
  '\\bgrokbot-local:',
  'grokbot-local-(?:update|patch)\\.json',
  'grokbot-(?:host|box|app|web-bundle|desktop-update|android-(?:native-)?update|ios-update|delta|bytepatch|volumes|native-base|android-shell|setup-stub|tailcat)\\b',
  '\\bGrokBotLocal\\b',
  '\\bGBDELTA1\\b',
  '\\bGBD1\\b',
  '\\.gbdelta\\b',
  'ferretgeek/prokbot-plus',
  'ahaduoduoduo/ProkBot',
  '~/grokbot\\b',
  '/opt/grokbot\\b',
  '\\.grokbot-local\\b',
  'providerOptions\\??\\.grokbot\\b',
  'grokbot\\.clientDeviceId\\b',
  '__grokbot[A-Za-z0-9_]*',
].join('|'), 'i');

const ABI_COMPAT_CONSTANTS = [
  /Java_dev_grokbot_local_TailcatBridge_[A-Za-z0-9_]+/g,
  /dev\.grokbot\.local\.TailcatBridge/g,
  /libgroktailcat(?:jni)?\.so/g,
  /GBTailcat(?:Identity|Free|Start|Status|Stop)/g,
];

const MIGRATION_BRIDGE_CONSTANTS = [
  /\$\{ROKBOT_[A-Z0-9_]+:-\$\{GROKBOT_[A-Z0-9_]+(?::-[^}]*)?\}\}/g,
  /\$\{PROKBOT_[A-Z0-9_]+/g,
  /GROKBOT_RUNTIME_DIR=\/opt\/rokbot\/runtime/g,
  /\/opt\/grokbot\b/g,
  /grokbot-bytepatch\/v1/g,
  /grokbot-volumes\/v1/g,
  /grokbot-desktop-update\/v1/g,
  /grokbot-android-(?:native-)?update\/v1/g,
  /\bGBDELTA1\b/g,
  /\bGBD1\b/g,
  /\*\.gbdelta\b/g,
  /\.gbdelta\b/g,
  /__grokbotPromptPolicy/g,
  /providerOptions\??\.grokbot\b/g,
  /grokbot\.clientDeviceId/g,
  /grokbot-local-(?:update|patch)\.json/g,
  /grokbot-local:/g,
];

const HISTORICAL_ATTRIBUTION_CONSTANTS = [
  /ferretgeek\/prokbot-plus/g,
  /ahaduoduoduo\/ProkBot/g,
];

export function maskCategoryB(line, extraWhitelist = []) {
  let masked = String(line ?? '');
  const matched = [];
  const patterns = [...CATEGORY_B_CONSTANTS, ...extraWhitelist];
  for (const rawRe of patterns) {
    const flags = rawRe.flags.includes('g') ? rawRe.flags : `${rawRe.flags}g`;
    const re = new RegExp(rawRe.source, flags);
    masked = masked.replace(re, (m) => {
      matched.push(m);
      return '_'.repeat(m.length);
    });
  }
  return { masked, matched };
}

export function scanTextForRebranding(text, opts = {}) {
  const {
    filePath = '<inline>',
    extraWhitelist = [],
    allowMigrationBridges = false,
    allowHistoricalAttribution = false,
    allowAbiCompat = false,
  } = opts;

  const extra = [...extraWhitelist];
  if (allowAbiCompat) extra.push(...ABI_COMPAT_CONSTANTS);
  if (allowMigrationBridges) extra.push(...MIGRATION_BRIDGE_CONSTANTS);
  if (allowHistoricalAttribution) extra.push(...HISTORICAL_ATTRIBUTION_CONSTANTS);

  const lines = String(text ?? '').split(/\r?\n/);
  const violations = [];
  const categoryBMatches = [];

  lines.forEach((line, idx) => {
    const { masked, matched } = maskCategoryB(line, extra);
    if (matched.length > 0) categoryBMatches.push(...matched);
    const match = CATEGORY_A_RE.exec(masked);
    if (match) {
      violations.push({
        filePath,
        line: idx + 1,
        column: match.index + 1,
        token: match[0],
        excerpt: line.trim().slice(0, 160),
      });
    }
  });

  return {
    ok: violations.length === 0,
    filePath,
    violations,
    categoryBMatches,
  };
}

export function checkOperationalRepoUrls(text, opts = {}) {
  const { allowHistoricalAttribution = false } = opts;
  const content = String(text ?? '');
  const errors = [];

  if (!allowHistoricalAttribution) {
    if (/ferretgeek\/prokbot-plus/i.test(content)) {
      errors.push('Operational text references ferretgeek/prokbot-plus instead of hongfaqiu/rokbot');
    }
    if (/ahaduoduoduo\/ProkBot/i.test(content)) {
      errors.push('Operational text references ahaduoduoduo/ProkBot instead of hongfaqiu/rokbot');
    }
  }

  const ghcrMatches = content.match(/ghcr\.io\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+/g) ?? [];
  for (const ref of ghcrMatches) {
    if (!ref.startsWith('ghcr.io/hongfaqiu/rokbot/')) {
      errors.push(`Operational GHCR image does not target ghcr.io/hongfaqiu/rokbot/: ${ref}`);
    }
  }

  const githubMatches = content.match(/https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/[A-Za-z0-9._-]+\/(?:rokbot|prokbot(?:-plus)?|grokbot)\b/gi) ?? [];
  for (const url of githubMatches) {
    const lower = url.toLowerCase();
    if (lower.includes('hongfaqiu/rokbot')) continue;
    if (allowHistoricalAttribution && (lower.includes('ferretgeek/prokbot-plus') || lower.includes('ahaduoduoduo/prokbot'))) {
      continue;
    }
    errors.push(`Operational GitHub URL does not target hongfaqiu/rokbot: ${url}`);
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

const DEFAULT_SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'output', 'build', '.gradle']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.ico', '.icns', '.so', '.dylib', '.exe', '.apk', '.xapk', '.ipa',
  '.dex', '.jar', '.gz', '.tgz', '.zip', '.jpg', '.jpeg', '.webp', '.gif',
  '.syso', '.asar', '.bin', '.woff', '.woff2', '.ttf', '.pdf', '.rbdelta', '.gbdelta',
]);

function hasBinarySignature(buf, length = buf.length) {
  if (length <= 0) return false;
  if (length >= 4) {
    // ELF magic: \x7fELF
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    // Mach-O 32/64-bit & Universal/Fat magics
    const magic = buf.readUInt32BE(0);
    if (
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe ||
      magic === 0xbebafeca
    ) {
      return true;
    }
  }
  // PE/MZ executable magic (require NUL byte so plain UTF-8 text starting with "MZ" is still scanned)
  if (length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a && buf.subarray(0, length).includes(0)) return true;
  // NUL byte check
  if (buf.subarray(0, length).includes(0)) return true;
  return false;
}

async function readTextFileIfNotBinary(filePath) {
  const fh = await open(filePath, 'r');
  try {
    const probe = Buffer.allocUnsafe(8192);
    const { bytesRead } = await fh.read(probe, 0, probe.length, 0);
    if (bytesRead === 0) return '';
    if (hasBinarySignature(probe, bytesRead)) return null;
  } finally {
    await fh.close();
  }
  const fullBuf = await readFile(filePath);
  if (hasBinarySignature(fullBuf, fullBuf.length)) return null;
  return fullBuf.toString('utf8');
}

function shouldTraverseDir(rel, includePaths, excludePaths) {
  if (rel === 'tests/e2e') return false;
  if (excludePaths.some((p) => rel === p || rel.startsWith(`${p}/`))) return false;
  if (Array.isArray(includePaths) && includePaths.length > 0) {
    return includePaths.some((p) => rel === p || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`));
  }
  return true;
}

async function walkRepoFiles(dir, relPrefix = '', skipDirs = DEFAULT_SKIP_DIRS, includePaths = null, excludePaths = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldTraverseDir(rel, includePaths, excludePaths)) continue;
      files.push(...await walkRepoFiles(full, rel, skipDirs, includePaths, excludePaths));
    } else if (entry.isFile()) {
      files.push({ rel, full });
    }
  }
  return files;
}

export async function scanRepoRebranding(repoRoot, opts = {}) {
  const {
    allowMigrationBridges = true,
    allowHistoricalAttribution = true,
    allowAbiCompat = true,
    includePaths = null,
    excludePaths = ['docs/REBRAND_COMPAT.md'],
  } = opts;

  const normIncludes = Array.isArray(includePaths)
    ? includePaths.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter(Boolean)
    : null;
  const normExcludes = Array.isArray(excludePaths)
    ? excludePaths.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter(Boolean)
    : [];

  const files = await walkRepoFiles(repoRoot, '', DEFAULT_SKIP_DIRS, normIncludes, normExcludes);
  const violations = [];
  let scannedFiles = 0;

  for (const { rel, full } of files) {
    if (normIncludes && normIncludes.length > 0) {
      if (!normIncludes.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
    }
    if (normExcludes.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    let text;
    try {
      text = await readTextFileIfNotBinary(full);
    } catch {
      continue;
    }
    if (text === null) continue;
    scannedFiles += 1;
    const res = scanTextForRebranding(text, {
      filePath: rel,
      allowMigrationBridges,
      allowHistoricalAttribution,
      allowAbiCompat,
    });
    if (!res.ok) {
      violations.push(...res.violations);
    }
  }

  return {
    ok: violations.length === 0,
    scannedFiles,
    violations,
  };
}

// ---------------------------------------------------------------------------
// 2. Binary & SVG Logo Inspectors
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function inspectPng(input) {
  const buf = readBytesInput(input);
  if (buf.length < 33) {
    throw new Error(`PNG too short (${buf.length} bytes)`);
  }
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('Invalid PNG signature');
  }
  const ihdrLen = buf.readUInt32BE(8);
  const ihdrType = buf.subarray(12, 16).toString('ascii');
  if (ihdrType !== 'IHDR' || ihdrLen !== 13) {
    throw new Error(`Invalid PNG IHDR chunk (${ihdrType}, len=${ihdrLen})`);
  }

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const compression = buf[26];
  const filter = buf[27];
  const interlace = buf[28];

  if (width === 0 || height === 0) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  }

  const chunks = [];
  let offset = 8;
  let hasIdat = false;
  let hasIend = false;
  while (offset < buf.length) {
    if (offset + 12 > buf.length) {
      throw new Error(`Truncated PNG chunk header at offset ${offset}`);
    }
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    if (offset + 12 + len > buf.length) {
      throw new Error(`Truncated PNG chunk ${type} at offset ${offset}`);
    }
    chunks.push({ type, length: len });
    if (type === 'IDAT') hasIdat = true;
    if (type === 'IEND') {
      hasIend = true;
      break;
    }
    offset += 12 + len;
  }

  if (!hasIdat) throw new Error('PNG missing IDAT chunk');
  if (!hasIend) throw new Error('PNG missing IEND chunk');

  return {
    format: 'png',
    width,
    height,
    bitDepth,
    colorType,
    compression,
    filter,
    interlace,
    hasAlpha: colorType === 6 || colorType === 4,
    sha256: sha256Hex(buf),
    chunks,
  };
}

export function inspectIco(input) {
  const buf = readBytesInput(input);
  if (buf.length < 6) {
    throw new Error(`ICO too short (${buf.length} bytes)`);
  }
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1 || count < 1) {
    throw new Error(`Invalid ICO header (reserved=${reserved}, type=${type}, count=${count})`);
  }
  const dirEnd = 6 + count * 16;
  if (dirEnd > buf.length) {
    throw new Error('ICO directory extends beyond EOF');
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const width = buf[off] || 256;
    const height = buf[off + 1] || 256;
    const colorCount = buf[off + 2];
    const planes = buf.readUInt16LE(off + 4);
    const bitCount = buf.readUInt16LE(off + 6);
    const bytesInRes = buf.readUInt32LE(off + 8);
    const imageOffset = buf.readUInt32LE(off + 12);

    if (imageOffset < dirEnd || imageOffset + bytesInRes > buf.length || bytesInRes === 0) {
      throw new Error(`ICO entry ${i} payload out of bounds`);
    }
    const payload = buf.subarray(imageOffset, imageOffset + bytesInRes);
    const isPng = payload.length >= 8 && payload.subarray(0, 8).equals(PNG_MAGIC);
    let pngInfo = null;
    if (isPng) {
      pngInfo = inspectPng(payload);
      if (pngInfo.width !== width || pngInfo.height !== height) {
        throw new Error(`ICO entry ${i} PNG size mismatch (${pngInfo.width}x${pngInfo.height} vs ${width}x${height})`);
      }
    }
    entries.push({
      width,
      height,
      colorCount,
      planes,
      bitCount,
      bytesInRes,
      imageOffset,
      isPng,
      pngColorType: pngInfo?.colorType ?? null,
    });
  }

  return {
    format: 'ico',
    count,
    sizes: entries.map((e) => e.width),
    entries,
    sha256: sha256Hex(buf),
  };
}

const ICNS_NOMINAL_SIZES = {
  ic04: 16, icp4: 16,
  ic05: 32, icp5: 32, ic11: 32,
  icp6: 64, ic12: 64,
  ic07: 128,
  ic08: 256, ic13: 256,
  ic09: 512, ic14: 512,
  ic10: 1024,
};

export function inspectIcns(input) {
  const buf = readBytesInput(input);
  if (buf.length < 8) {
    throw new Error(`ICNS too short (${buf.length} bytes)`);
  }
  const magic = buf.subarray(0, 4).toString('ascii');
  if (magic !== 'icns') {
    throw new Error(`Invalid ICNS magic: ${magic}`);
  }
  const totalLength = buf.readUInt32BE(4);
  if (totalLength !== buf.length) {
    throw new Error(`ICNS length header mismatch: ${totalLength} vs ${buf.length}`);
  }

  const chunks = [];
  let offset = 8;
  while (offset < totalLength) {
    if (offset + 8 > totalLength) {
      throw new Error(`Truncated ICNS chunk header at offset ${offset}`);
    }
    const type = buf.subarray(offset, offset + 4).toString('ascii');
    const length = buf.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > totalLength) {
      throw new Error(`Invalid ICNS chunk ${type} length ${length} at offset ${offset}`);
    }
    const payload = buf.subarray(offset + 8, offset + length);
    const isPng = payload.length >= 8 && payload.subarray(0, 8).equals(PNG_MAGIC);
    let pngInfo = null;
    if (isPng) {
      pngInfo = inspectPng(payload);
    }
    chunks.push({
      type,
      length,
      nominalSize: ICNS_NOMINAL_SIZES[type] ?? null,
      isPng,
      width: pngInfo?.width ?? null,
      height: pngInfo?.height ?? null,
    });
    offset += length;
  }

  if (chunks.length === 0) {
    throw new Error('ICNS contains zero chunks');
  }

  return {
    format: 'icns',
    totalLength,
    chunks,
    imageTypes: chunks.map((c) => c.type),
    sha256: sha256Hex(buf),
  };
}

export function inspectSvg(input) {
  let svgText;
  if (Buffer.isBuffer(input)) {
    svgText = input.toString('utf8');
  } else if (typeof input === 'string') {
    if (!input.includes('<svg') && existsSync(input)) {
      svgText = readFileSync(input, 'utf8');
    } else {
      svgText = input;
    }
  } else {
    throw new TypeError('inspectSvg expects SVG string, Buffer, or file path');
  }

  const openMatch = /<svg\b([^>]*)>/i.exec(svgText);
  if (!openMatch || !/<\/svg>/i.test(svgText)) {
    throw new Error('Invalid SVG: missing <svg> or </svg>');
  }
  const viewBoxMatch = /viewBox=["']\s*([^"']+)\s*["']/i.exec(openMatch[1]);
  const viewBox = viewBoxMatch ? viewBoxMatch[1].trim() : null;
  const viewBoxRect = viewBox ? viewBox.split(/[\s,]+/).map(Number) : null;

  const facePathMatch = /<path\b[^>]*class=["'][^"']*brand-face[^"']*["'][^>]*>/i.exec(svgText)
    || /<path\b[^>]*>/i.exec(svgText);
  const faceDMatch = facePathMatch ? /\bd=["']([^"']+)["']/i.exec(facePathMatch[0]) : null;
  const bezierSegmentCount = faceDMatch ? (faceDMatch[1].match(/\bC\b/g) ?? []).length : 0;
  const hasBrandFace = /brand-face/.test(svgText) && bezierSegmentCount >= 4;

  const eyeTags = svgText.match(/<rect\b[^>]*brand-eye[^>]*>/gi) ?? [];
  const eyeHeights = [];
  let hasTiltedEyes = false;
  for (const tag of eyeTags) {
    const hMatch = /\bheight=["']([0-9.]+)["']/i.exec(tag);
    if (hMatch) eyeHeights.push(Number(hMatch[1]));
    if (/rotate\(-26\b/.test(tag)) hasTiltedEyes = true;
  }
  const hasAsymmetricEyes = eyeHeights.length >= 2 && new Set(eyeHeights).size >= 2;
  const hasBrandAccent = /<circle\b[^>]*brand-accent[^>]*>/i.test(svgText);
  const rebrandRes = scanTextForRebranding(svgText, { filePath: '<svg>' });

  return {
    format: 'svg',
    viewBox,
    viewBoxRect,
    hasBrandFace,
    bezierSegmentCount,
    eyeCount: eyeTags.length,
    eyeHeights,
    hasTiltedEyes,
    hasAsymmetricEyes,
    hasBrandAccent,
    rebrandingOk: rebrandRes.ok,
    sha256: sha256Hex(Buffer.from(svgText, 'utf8')),
  };
}

export function verifyLogoSuite(repoRoot) {
  const errors = [];
  const manifestPath = path.join(repoRoot, 'assets', 'logo', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`Missing logo manifest: ${manifestPath}`], checkedCount: 0 };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'rokbot-logo-manifest/v1') {
    errors.push(`Unexpected logo manifest schema: ${manifest.schema}`);
  }

  let checkedCount = 0;

  // Master SVG
  const masterSvgPath = path.join(repoRoot, manifest.masterSvg || 'assets/logo/rokbot-logo.svg');
  try {
    const svgInfo = inspectSvg(masterSvgPath);
    checkedCount += 1;
    if (!svgInfo.hasBrandFace || svgInfo.eyeCount !== 2 || !svgInfo.hasTiltedEyes || !svgInfo.hasAsymmetricEyes || !svgInfo.hasBrandAccent || !svgInfo.rebrandingOk) {
      errors.push(`Master SVG failed RokBot deformed geometry checks: ${JSON.stringify(svgInfo)}`);
    }
  } catch (err) {
    errors.push(`Master SVG error: ${err.message}`);
  }

  // Host favicon.svg
  const faviconPath = path.join(repoRoot, 'host', 'server', 'public', 'favicon.svg');
  if (existsSync(faviconPath)) {
    const favText = readFileSync(faviconPath, 'utf8');
    checkedCount += 1;
    if (!/prefers-color-scheme:\s*dark/.test(favText) || !/brand-face/.test(favText) || !/brand-accent/.test(favText)) {
      errors.push('host/server/public/favicon.svg missing dark-mode or brand-face/brand-accent markers');
    }
  } else {
    errors.push(`Missing host favicon: ${faviconPath}`);
  }

  const checkPngEntry = (entry, expectedColorType) => {
    const full = path.join(repoRoot, entry.path);
    if (!existsSync(full)) {
      errors.push(`Missing PNG asset: ${entry.path}`);
      return;
    }
    try {
      const info = inspectPng(full);
      checkedCount += 1;
      if (info.width !== entry.width || info.height !== entry.height) {
        errors.push(`${entry.path} dimension mismatch: ${info.width}x${info.height} vs ${entry.width}x${entry.height}`);
      }
      if (info.colorType !== expectedColorType) {
        errors.push(`${entry.path} colorType mismatch: ${info.colorType} vs ${expectedColorType}`);
      }
      if (entry.sha256 && info.sha256 !== entry.sha256) {
        errors.push(`${entry.path} SHA-256 mismatch: ${info.sha256} vs ${entry.sha256}`);
      }
    } catch (err) {
      errors.push(`${entry.path} PNG inspect error: ${err.message}`);
    }
  };

  if (manifest.hostIcon) checkPngEntry(manifest.hostIcon, 6);
  for (const item of manifest.png ?? []) checkPngEntry(item, 6);
  for (const item of manifest.android ?? []) checkPngEntry(item, 6);
  for (const item of manifest.ios ?? []) {
    if (item.hasAlpha !== false) errors.push(`${item.path} must have hasAlpha=false`);
    checkPngEntry(item, 2);
  }

  if (manifest.ico?.path) {
    const icoFull = path.join(repoRoot, manifest.ico.path);
    try {
      const icoInfo = inspectIco(icoFull);
      checkedCount += 1;
      if (manifest.ico.sizes && JSON.stringify(icoInfo.sizes) !== JSON.stringify(manifest.ico.sizes)) {
        errors.push(`ICO sizes mismatch: ${icoInfo.sizes.join(',')} vs ${manifest.ico.sizes.join(',')}`);
      }
      if (manifest.ico.sha256 && icoInfo.sha256 !== manifest.ico.sha256) {
        errors.push(`ICO SHA-256 mismatch: ${icoInfo.sha256} vs ${manifest.ico.sha256}`);
      }
    } catch (err) {
      errors.push(`ICO inspect error: ${err.message}`);
    }
  }

  if (manifest.icns?.path) {
    const icnsFull = path.join(repoRoot, manifest.icns.path);
    try {
      const icnsInfo = inspectIcns(icnsFull);
      checkedCount += 1;
      for (const chunk of icnsInfo.chunks) {
        if (chunk.isPng && chunk.nominalSize != null) {
          if (chunk.width !== chunk.nominalSize || chunk.height !== chunk.nominalSize) {
            errors.push(`ICNS chunk ${chunk.type} dimension mismatch: ${chunk.width}x${chunk.height} vs nominalSize ${chunk.nominalSize}`);
          }
        }
      }
      if (manifest.icns.sha256 && icnsInfo.sha256 !== manifest.icns.sha256) {
        errors.push(`ICNS SHA-256 mismatch: ${icnsInfo.sha256} vs ${manifest.icns.sha256}`);
      }
    } catch (err) {
      errors.push(`ICNS inspect error: ${err.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    schema: manifest.schema,
    checkedCount,
    errors,
  };
}

// ---------------------------------------------------------------------------
// 3. One-Click Deploy Validation & Isolated Runner
// ---------------------------------------------------------------------------

export async function validateImageComposeBundle({
  composePath,
  envExamplePath,
  installScriptPath,
  composeText,
  envExampleText,
  installScriptText,
} = {}) {
  const errors = [];
  const compose = composeText ?? (composePath ? await readFile(composePath, 'utf8') : '');
  const envExample = envExampleText ?? (envExamplePath ? await readFile(envExamplePath, 'utf8') : '');
  const installScript = installScriptText ?? (installScriptPath ? await readFile(installScriptPath, 'utf8') : '');

  if (!compose) {
    errors.push('Missing docker-compose.images.yml content');
  } else {
    if (!/^name:\s*rokbot\b/m.test(compose)) {
      errors.push('docker-compose.images.yml must set `name: rokbot`');
    }
    if (!compose.includes('ghcr.io/hongfaqiu/rokbot/host')) {
      errors.push('docker-compose.images.yml missing ghcr.io/hongfaqiu/rokbot/host image reference');
    }
    if (!compose.includes('ghcr.io/hongfaqiu/rokbot/box')) {
      errors.push('docker-compose.images.yml missing ghcr.io/hongfaqiu/rokbot/box image reference');
    }
    if (!/:8000\b/.test(compose)) {
      errors.push('docker-compose.images.yml missing Host port 8000 mapping');
    }
    if (/ROKBOT_DEFAULT_MACHINE_ID:\s*["']?[0-9a-f]{8,}/i.test(compose)) {
      errors.push('docker-compose.images.yml must not hardcode ROKBOT_DEFAULT_MACHINE_ID');
    }
    if (!/healthcheck/i.test(compose)) {
      errors.push('docker-compose.images.yml missing healthcheck definition');
    }
    try {
      assertNoSecrets(compose, [], { label: 'docker-compose.images.yml' });
    } catch (err) {
      errors.push(err.message);
    }
    const rebrandRes = scanTextForRebranding(compose, {
      filePath: 'docker-compose.images.yml',
      allowMigrationBridges: true,
    });
    if (!rebrandRes.ok) {
      errors.push(`docker-compose.images.yml rebranding violation: ${rebrandRes.violations[0].token}`);
    }
    const urlRes = checkOperationalRepoUrls(compose);
    if (!urlRes.ok) errors.push(...urlRes.errors);
  }

  if (!envExample) {
    errors.push('Missing .env.images.example content');
  } else {
    try {
      assertNoSecrets(envExample, [], { label: '.env.images.example' });
    } catch (err) {
      errors.push(err.message);
    }
    const rebrandRes = scanTextForRebranding(envExample, {
      filePath: '.env.images.example',
      allowMigrationBridges: true,
    });
    if (!rebrandRes.ok) {
      errors.push(`.env.images.example rebranding violation: ${rebrandRes.violations[0].token}`);
    }
  }

  if (installScriptPath || installScriptText) {
    if (!installScript) {
      errors.push('Missing install-images.sh content');
    } else {
      if (!installScript.includes('--prepare-only')) {
        errors.push('install-images.sh must support --prepare-only');
      }
      if (!installScript.includes('ROKBOT_DOWNLOAD_BASE')) {
        errors.push('install-images.sh must support ROKBOT_DOWNLOAD_BASE');
      }
      if (!/umask\s+077|chmod\s+600/.test(installScript)) {
        errors.push('install-images.sh must protect generated .env with umask 077 / chmod 600');
      }
      const rebrandRes = scanTextForRebranding(installScript, {
        filePath: 'install-images.sh',
        allowMigrationBridges: true,
      });
      if (!rebrandRes.ok) {
        errors.push(`install-images.sh rebranding violation: ${rebrandRes.violations[0].token}`);
      }
      const urlRes = checkOperationalRepoUrls(installScript);
      if (!urlRes.ok) errors.push(...urlRes.errors);

      if (installScriptPath && existsSync(installScriptPath)) {
        const syntax = spawnSync('bash', ['-n', installScriptPath], { encoding: 'utf8' });
        if (syntax.status !== 0) {
          errors.push(`install-images.sh bash syntax error: ${syntax.stderr || syntax.stdout}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export async function runInstallImagesPrepareOnly({
  workDir,
  scriptPath,
  composePath,
  envExamplePath,
  args = ['--prepare-only', '--offline'],
  env = {},
  useFakeDocker = true,
  timeoutMs = 15000,
}) {
  assert.ok(workDir, 'workDir is required');
  await mkdir(workDir, { recursive: true });
  const targetScript = path.join(workDir, 'install-images.sh');
  const targetCompose = path.join(workDir, 'docker-compose.images.yml');
  const targetEnvExample = path.join(workDir, '.env.images.example');

  await copyFile(scriptPath, targetScript);
  await chmod(targetScript, 0o755);
  await copyFile(composePath, targetCompose);
  await copyFile(envExamplePath, targetEnvExample);

  let pathEnv = process.env.PATH || '/usr/bin:/bin';
  if (useFakeDocker) {
    const binDir = path.join(workDir, '_bin');
    await mkdir(binDir, { recursive: true });
    const fakeDockerPath = path.join(binDir, 'docker');
    const fakeDockerScript = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then',
      '  echo "Docker Compose version v5.1.3"',
      '  exit 0',
      'fi',
      'if [[ "${1:-}" == "compose" ]]; then',
      '  env_file=""',
      '  want_env=0',
      '  want_images=0',
      '  shift',
      '  while [[ $# -gt 0 ]]; do',
      '    case "$1" in',
      '      --env-file) env_file="${2:-}"; shift 2 ;;',
      '      --environment) want_env=1; shift ;;',
      '      --images) want_images=1; shift ;;',
      '      *) shift ;;',
      '    esac',
      '  done',
      '  if [[ "$want_env" == "1" && -n "$env_file" && -f "$env_file" ]]; then',
      '    grep -E "^[A-Za-z_][A-Za-z0-9_]*=" "$env_file" || true',
      '    exit 0',
      '  fi',
      '  if [[ "$want_images" == "1" ]]; then',
      '    echo "ghcr.io/hongfaqiu/rokbot/host:latest"',
      '    echo "ghcr.io/hongfaqiu/rokbot/box:latest"',
      '    exit 0',
      '  fi',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n');
    await writeFile(fakeDockerPath, fakeDockerScript, { mode: 0o755 });
    await chmod(fakeDockerPath, 0o755);
    pathEnv = `${binDir}:${pathEnv}`;
  }

  const cleanEnv = {
    HOME: workDir,
    PATH: pathEnv,
    TERM: 'dumb',
    ...env,
  };

  const res = spawnSync('bash', [targetScript, ...args], {
    cwd: workDir,
    env: cleanEnv,
    encoding: 'utf8',
    timeout: timeoutMs,
  });

  const envFilePath = path.join(workDir, '.env');
  let envMode = null;
  let parsedEnv = {};
  const secretValues = [];
  if (existsSync(envFilePath)) {
    const st = await stat(envFilePath);
    envMode = st.mode & 0o777;
    const envRaw = await readFile(envFilePath, 'utf8');
    parsedEnv = parseEnvFile(envRaw);
    for (const [k, v] of Object.entries(parsedEnv)) {
      if (/(PASSWORD|SECRET|TOKEN|KEY)/i.test(k) && typeof v === 'string' && v.length >= 12) {
        secretValues.push(v);
      }
    }
  }

  const combinedOutput = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  assertNoSecrets(combinedOutput, secretValues, { label: 'install-images.sh output' });

  return {
    exitCode: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    envFilePath,
    envMode,
    parsedEnv,
    generatedSecretsCount: secretValues.length,
  };
}

export async function checkOneClickDeploy(repoRoot, { repoCheck = false, tempDir, fixtureDir } = {}) {
  const releaseDir = path.join(repoRoot, 'host', 'release');
  const scriptPath = path.join(releaseDir, 'install-images.sh');
  const composePath = path.join(releaseDir, 'docker-compose.images.yml');
  const envExamplePath = path.join(releaseDir, '.env.images.example');

  const allExist = existsSync(scriptPath) && existsSync(composePath) && existsSync(envExamplePath);
  if (!allExist) {
    if (repoCheck) {
      assert.fail(`Missing M2 one-click deploy files in ${releaseDir}`);
    }
    if (fixtureDir) {
      const fScript = path.join(fixtureDir, 'install-images.sh');
      const fCompose = path.join(fixtureDir, 'docker-compose.images.yml');
      const fEnv = path.join(fixtureDir, '.env.images.example');
      const validation = await validateImageComposeBundle({
        composePath: fCompose,
        envExamplePath: fEnv,
        installScriptPath: fScript,
      });
      const runResult = tempDir
        ? await runInstallImagesPrepareOnly({
            workDir: tempDir,
            scriptPath: fScript,
            composePath: fCompose,
            envExamplePath: fEnv,
          })
        : null;
      return { available: true, source: 'fixture', validation, runResult };
    }
    return {
      available: false,
      reason: 'M2 one-click deploy files (install-images.sh, docker-compose.images.yml, .env.images.example) not yet present on disk',
    };
  }

  const validation = await validateImageComposeBundle({
    composePath,
    envExamplePath,
    installScriptPath: scriptPath,
  });
  const runResult = tempDir
    ? await runInstallImagesPrepareOnly({
        workDir: tempDir,
        scriptPath,
        composePath,
        envExamplePath,
      })
    : null;

  return {
    available: true,
    source: 'repo',
    validation,
    runResult,
  };
}

// ---------------------------------------------------------------------------
// 4. Secret-Leak Scanner (assertNoSecrets)
// ---------------------------------------------------------------------------

const PEM_PRIVATE_KEY_RE = /-----BEGIN (?:EC |RSA |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i;
const KNOWN_API_KEY_RE = /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/;
const ENV_SECRET_ASSIGN_RE = /^[ \t]*(?:ROKBOT_ADMIN_PASSWORD|GROKBOT_ADMIN_PASSWORD|OPENAI_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY|GEMINI_API_KEY|DEEPSEEK_API_KEY|ROKBOT_INTERNAL_HOST_TOKEN|ROKBOT_NODE_TOKEN|ADMIN_PASSWORD|COOKIE_SECRET|PRIVATE_KEY)[ \t]*=[ \t]*['"]?([^\s'"#]{4,})/gm;
const SESSION_COOKIE_RE = /\b(?:rokbot_admin|rokbot_web|grokbot_admin|grokbot_web)=[A-Za-z0-9._~+/=-]{8,}/;
const SENSITIVE_KEY_RE = /^(?:apiKey|jevApiKey|adminPassword|password|privateKey|privateKeyPem|secret|cookieSecret|setupKey)$/i;
const REDACTED_VAL_RE = /^(?:\*+|\[REDACTED\]|redacted)$/i;

function secretDigest(secretStr) {
  return createHash('sha256').update(String(secretStr)).digest('hex').slice(0, 8);
}

function inspectObjectKeysForSecrets(node, pathStack, findings, forbidTokenKey, visited = new WeakSet()) {
  if (!node || typeof node !== 'object') return;
  if (visited.has(node)) return;
  visited.add(node);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      inspectObjectKeysForSecrets(node[i], `${pathStack}[${i}]`, findings, forbidTokenKey, visited);
    }
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const keyPath = pathStack ? `${pathStack}.${key}` : key;
    const isForbiddenKey = SENSITIVE_KEY_RE.test(key) || (forbidTokenKey && /^token$/i.test(key));
    if (isForbiddenKey && typeof value === 'string' && value.trim().length > 0 && !REDACTED_VAL_RE.test(value.trim())) {
      findings.push(`Sensitive key "${keyPath}" exposed non-empty string value`);
    }
    if (value && typeof value === 'object') {
      inspectObjectKeysForSecrets(value, keyPath, findings, forbidTokenKey, visited);
    }
  }
}

export function assertNoSecrets(input, extraSecrets = [], options = {}) {
  let extras = extraSecrets;
  let opts = options;
  if (extraSecrets && !Array.isArray(extraSecrets) && typeof extraSecrets === 'object') {
    opts = extraSecrets;
    extras = opts.extraSecrets ?? [];
  }

  const label = opts.label ? ` in ${opts.label}` : '';
  const forbidTokenKey = Boolean(opts.forbidTokenKey);
  const findings = [];

  if (input === null || input === undefined) return;

  let text = '';
  if (Buffer.isBuffer(input)) {
    text = input.toString('utf8');
  } else if (typeof input === 'string') {
    text = input;
  } else if (typeof input === 'object') {
    inspectObjectKeysForSecrets(input, '', findings, forbidTokenKey);
    try {
      text = JSON.stringify(input);
    } catch {
      const seen = new WeakSet();
      try {
        text = JSON.stringify(input, (_k, v) => {
          if (v && typeof v === 'object') {
            if (seen.has(v)) return '[Circular]';
            seen.add(v);
          }
          return v;
        });
      } catch {
        text = String(input);
      }
    }
  } else {
    text = String(input);
  }

  for (const s of extras ?? []) {
    if (typeof s === 'string' && s.length >= 4 && text.includes(s)) {
      findings.push(`Leaked explicit secret (sha256:${secretDigest(s)}...)`);
    }
  }
  if (PEM_PRIVATE_KEY_RE.test(text)) {
    findings.push('Leaked PEM private key block');
  }
  if (BEARER_TOKEN_RE.test(text)) {
    findings.push('Leaked Bearer authorization token');
  }
  if (KNOWN_API_KEY_RE.test(text)) {
    findings.push('Leaked provider/cloud API key pattern');
  }
  ENV_SECRET_ASSIGN_RE.lastIndex = 0;
  let envMatch;
  while ((envMatch = ENV_SECRET_ASSIGN_RE.exec(text)) !== null) {
    const val = envMatch[1];
    if (val && !REDACTED_VAL_RE.test(val) && !val.startsWith('${')) {
      findings.push(`Leaked env secret assignment (sha256:${secretDigest(val)}...)`);
      break;
    }
  }
  if (SESSION_COOKIE_RE.test(text)) {
    findings.push('Leaked RokBot session cookie value');
  }

  if (findings.length > 0) {
    assert.fail(`Secret hygiene check failed${label}: ${findings.join('; ')}`);
  }
}

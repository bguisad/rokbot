import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

export const tier = 1;
export const name = 'tier1-repo-brand-deploy';

function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const { timeout, encoding = 'utf8', ...spawnOpts } = opts;
    const child = spawn(cmd, args, {
      ...spawnOpts,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const stdoutBuf = Buffer.concat(outChunks);
      const stderrBuf = Buffer.concat(errChunks);
      resolve({
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: encoding ? stdoutBuf.toString(encoding) : stdoutBuf,
        stderr: encoding ? stderrBuf.toString(encoding) : stderrBuf,
        error: result.error ?? null,
      });
    };

    child.stdout?.on('data', (chunk) => outChunks.push(chunk));
    child.stderr?.on('data', (chunk) => errChunks.push(chunk));
    child.on('error', (err) => finish({ status: null, signal: null, error: err }));
    child.on('close', (code, signal) => {
      const err = timedOut ? new Error(`Process timed out after ${timeout}ms`) : null;
      finish({ status: code, signal, error: err });
    });

    if (typeof timeout === 'number' && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 1000);
        killTimer.unref?.();
      }, timeout);
      timer.unref?.();
    }
  });
}

const LIVE_CACHE_SYM = Symbol.for('rokbot.e2e.s2.liveCache');

function getLiveCache(ctx) {
  if (ctx.harness) return null;
  let wm = globalThis[LIVE_CACHE_SYM];
  if (!wm) {
    wm = new WeakMap();
    globalThis[LIVE_CACHE_SYM] = wm;
  }
  let entry = wm.get(ctx);
  if (!entry) {
    entry = { adminCookie: null, deviceToken: ctx.deviceToken || null, deviceId: null, webCookie: null };
    wm.set(ctx, entry);
  }
  return entry;
}

async function ensureAdminSession(ctx, client) {
  const cache = getLiveCache(ctx);
  if (cache?.adminCookie) {
    client.cookies.set('rokbot_admin', cache.adminCookie);
    return { status: 200, ok: true, cached: true };
  }
  const login = await client.adminLogin(ctx.adminPassword);
  ctx.assert.assertStatus(login, 200);
  if (cache) {
    const cookieVal = client.cookies.get('rokbot_admin');
    if (cookieVal) cache.adminCookie = cookieVal;
  }
  return login;
}

function createClient(ctx, opts = {}) {
  const client = ctx.createClient(
    ctx.harness && opts.deviceToken === undefined ? { deviceToken: null, ...opts } : opts,
  );
  if (ctx.harness && opts.deviceToken === undefined) {
    client.setBearerToken(null, null);
  }
  return client;
}

async function resetHarnessState(ctx) {
  if (!ctx.harness) return;
  await ctx.harness.resetState();
  ctx.harness.setModelAuthPolicy({
    allowEnv: true,
    allowDeviceModelConfig: true,
    allowGuestModelConfig: false,
  });
}

async function ensureDeviceSession(ctx, client, pairOpts = {}) {
  if (!ctx.harness && ctx.deviceToken && !pairOpts.forceNew) {
    client.setBearerToken(ctx.deviceToken);
    return { token: ctx.deviceToken, deviceId: null, cached: true };
  }
  if (ctx.harness) {
    client.setBearerToken(null, null);
  }
  const cache = getLiveCache(ctx);
  if (cache?.deviceToken) {
    client.setBearerToken(cache.deviceToken, cache.deviceId);
    return { token: cache.deviceToken, deviceId: cache.deviceId, cached: true };
  }
  const body = !ctx.harness
    ? {
        password: ctx.adminPassword,
        deviceName: 'RokBot E2E Shared Live Device',
        platform: 'desktop',
        clientDeviceId: 'rokbot-e2e-shared-live-device',
      }
    : {
        password: ctx.adminPassword,
        deviceName: pairOpts.deviceName || 'RokBot E2E Shared Device',
        platform: pairOpts.platform || 'desktop',
        ...(pairOpts.clientKind !== undefined ? { clientKind: pairOpts.clientKind } : {}),
        ...(pairOpts.clientDeviceId !== undefined ? { clientDeviceId: pairOpts.clientDeviceId } : {}),
        ...(pairOpts.bundleId !== undefined ? { bundleId: pairOpts.bundleId } : {}),
      };
  const pairRes = await client.pairWithPassword(body);
  ctx.assert.assertStatus(pairRes, 201);
  if (cache) {
    cache.deviceToken = pairRes.json.token;
    cache.deviceId = pairRes.json.deviceId;
  }
  return pairRes.json;
}

async function ensureWebSession(ctx, client, t = null) {
  const cache = getLiveCache(ctx);
  if (cache?.webCookie) {
    client.cookies.set('rokbot_web', cache.webCookie);
    return { status: 200, ok: true, cached: true };
  }
  if (!ctx.harness) {
    const ws = await client.webSession();
    ctx.assert.assertStatus(ws, 200);
    if (ws.json?.available === false) {
      if (t) t.skip('Web client bundle is not installed on live Host');
      return { status: 409, ok: false, json: { available: false } };
    }
  }
  await ensureAdminSession(ctx, client);
  const openRes = await client.adminOpenWebClient({
    deviceName: 'RokBot E2E Shared Web',
    clientDeviceId: 'rokbot-e2e-shared-web',
  });
  if (!ctx.harness && openRes.status === 409) {
    if (t) t.skip('Web client bundle is not installed on live Host');
    return openRes;
  }
  ctx.assert.assertStatus(openRes, [200, 201]);
  if (cache) {
    const cookieVal = client.cookies.get('rokbot_web');
    if (cookieVal) cache.webCookie = cookieVal;
  }
  return openRes;
}

// ---------------------------------------------------------------------------
// Self-contained Synthetic Fixture Builders (PNG, ICO, ICNS, SVG, Deploy)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const PNG_CACHE = new Map();

function buildSyntheticPng(width, height, colorType = 6) {
  const key = `${width}x${height}:${colorType}`;
  if (PNG_CACHE.has(key)) return PNG_CACHE.get(key);

  const bpp = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = 1 + width * bpp;
  const raw = Buffer.alloc(rowStride * height, 0);
  if (colorType === 6 && width > 0 && height > 0) {
    // Non-zero sample pixel so RGBA data is non-trivial
    raw[1] = 0x1e;
    raw[2] = 0x24;
    raw[3] = 0x30;
    raw[4] = 0xff;
  } else if (colorType === 2 && width > 0 && height > 0) {
    raw[1] = 0x1e;
    raw[2] = 0x24;
    raw[3] = 0x30;
  }
  const compressed = deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  PNG_CACHE.set(key, png);
  return png;
}

function buildSyntheticIco(sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const count = sizes.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  const payloads = [];
  let offset = 6 + count * 16;

  for (const sz of sizes) {
    const png = buildSyntheticPng(sz, sz, 6);
    const entry = Buffer.alloc(16);
    entry[0] = sz >= 256 ? 0 : sz;
    entry[1] = sz >= 256 ? 0 : sz;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    payloads.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirEntries, ...payloads]);
}

function buildSyntheticIcns(specs = [
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
]) {
  const chunks = [];
  let totalLength = 8;
  for (const spec of specs) {
    const png = buildSyntheticPng(spec.size, spec.size, 6);
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write(spec.type, 0, 4, 'ascii');
    const len = 8 + png.length;
    chunkHeader.writeUInt32BE(len, 4);
    chunks.push(chunkHeader, png);
    totalLength += len;
  }
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(totalLength, 4);
  return Buffer.concat([fileHeader, ...chunks]);
}

function buildSyntheticRokBotSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
    '  <path class="brand-face" d="M 160 320 C 160 180 280 140 512 140 C 744 140 864 180 864 320 C 864 680 760 884 512 884 C 264 884 160 680 160 320 Z" fill="#1e2430"/>',
    '  <rect class="brand-eye" x="310" y="396" width="132" height="336" rx="66" transform="rotate(-26 376 564)" fill="#f8fafc"/>',
    '  <rect class="brand-eye" x="582" y="430" width="132" height="268" rx="66" transform="rotate(-26 648 564)" fill="#f8fafc"/>',
    '  <circle class="brand-accent" cx="760" cy="240" r="56" fill="#38bdf8"/>',
    '</svg>',
    '',
  ].join('\n');
}

function buildSyntheticFaviconSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
    '  <style>',
    '    .brand-face { fill: #1e2430; }',
    '    .brand-accent { fill: #38bdf8; }',
    '    @media (prefers-color-scheme: dark) { .brand-face { fill: #0f172a; } }',
    '  </style>',
    '  <path class="brand-face" d="M 160 320 C 160 180 280 140 512 140 C 744 140 864 180 864 320 C 864 680 760 884 512 884 C 264 884 160 680 160 320 Z"/>',
    '  <circle class="brand-accent" cx="760" cy="240" r="56"/>',
    '</svg>',
    '',
  ].join('\n');
}

async function buildSyntheticLogoSuite(rootDir, { sha256Hex }) {
  const logoDir = path.join(rootDir, 'assets', 'logo');
  const pubDir = path.join(rootDir, 'host', 'server', 'public');
  await mkdir(logoDir, { recursive: true });
  await mkdir(pubDir, { recursive: true });

  await writeFile(path.join(logoDir, 'rokbot-logo.svg'), buildSyntheticRokBotSvg(), 'utf8');
  await writeFile(path.join(pubDir, 'favicon.svg'), buildSyntheticFaviconSvg(), 'utf8');

  const hostPng = buildSyntheticPng(512, 512, 6);
  const hostIconRel = 'host/server/public/rokbot-icon.png';
  await writeFile(path.join(rootDir, hostIconRel), hostPng);

  const pngSizes = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
  const pngEntries = [];
  for (const sz of pngSizes) {
    const rel = `assets/logo/rokbot-icon-${sz}.png`;
    const buf = buildSyntheticPng(sz, sz, 6);
    await writeFile(path.join(rootDir, rel), buf);
    pngEntries.push({ path: rel, width: sz, height: sz, sha256: sha256Hex(buf) });
  }

  const androidDensities = [
    { name: 'mdpi', icon: 48, fg: 108 },
    { name: 'hdpi', icon: 72, fg: 162 },
    { name: 'xhdpi', icon: 96, fg: 216 },
    { name: 'xxhdpi', icon: 144, fg: 324 },
    { name: 'xxxhdpi', icon: 192, fg: 432 },
  ];
  const androidEntries = [];
  for (const d of androidDensities) {
    const dirRel = `assets/logo/android/mipmap-${d.name}`;
    await mkdir(path.join(rootDir, dirRel), { recursive: true });
    for (const kind of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
      const sz = kind === 'ic_launcher_foreground' ? d.fg : d.icon;
      const rel = `${dirRel}/${kind}.png`;
      const buf = buildSyntheticPng(sz, sz, 6);
      await writeFile(path.join(rootDir, rel), buf);
      androidEntries.push({ path: rel, width: sz, height: sz, sha256: sha256Hex(buf) });
    }
  }

  const iosSizes = [120, 152, 167, 180, 1024];
  const iosEntries = [];
  await mkdir(path.join(logoDir, 'ios'), { recursive: true });
  for (const sz of iosSizes) {
    const rel = `assets/logo/ios/AppIcon-${sz}.png`;
    const buf = buildSyntheticPng(sz, sz, 2); // opaque RGB, no alpha
    await writeFile(path.join(rootDir, rel), buf);
    iosEntries.push({ path: rel, width: sz, height: sz, hasAlpha: false, sha256: sha256Hex(buf) });
  }

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuf = buildSyntheticIco(icoSizes);
  await writeFile(path.join(logoDir, 'rokbot.ico'), icoBuf);

  const icnsBuf = buildSyntheticIcns();
  await writeFile(path.join(logoDir, 'rokbot.icns'), icnsBuf);

  const manifest = {
    schema: 'rokbot-logo-manifest/v1',
    masterSvg: 'assets/logo/rokbot-logo.svg',
    hostIcon: { path: hostIconRel, width: 512, height: 512, sha256: sha256Hex(hostPng) },
    png: pngEntries,
    android: androidEntries,
    ios: iosEntries,
    ico: { path: 'assets/logo/rokbot.ico', sizes: icoSizes, sha256: sha256Hex(icoBuf) },
    icns: { path: 'assets/logo/rokbot.icns', sha256: sha256Hex(icnsBuf) },
  };
  await writeFile(path.join(logoDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function buildCompliantComposeYaml() {
  return [
    'name: rokbot',
    'services:',
    '  host:',
    '    image: ${ROKBOT_HOST_IMAGE:-ghcr.io/hongfaqiu/rokbot/host:latest}',
    '    ports:',
    '      - "${ROKBOT_LISTEN_ADDRESS:-127.0.0.1}:${ROKBOT_PUBLIC_PORT:-18080}:8000"',
    '    environment:',
    '      ROKBOT_PORT: "8000"',
    '      ROKBOT_BIND: "0.0.0.0"',
    '      ROKBOT_BOX_TOKEN: ${ROKBOT_BOX_TOKEN:-local}',
    '      ROKBOT_DEFAULT_MACHINE_ID: ${ROKBOT_DEFAULT_MACHINE_ID:-}',
    '      ROKBOT_ALLOW_DEVICE_MODEL_CONFIG: ${ROKBOT_ALLOW_DEVICE_MODEL_CONFIG:-1}',
    '      ROKBOT_UPDATE_DIR: ${ROKBOT_UPDATE_DIR:-/data/updates}',
    '    healthcheck:',
    '      test: ["CMD", "/exec-daemon/node", "deploy/healthcheck.mjs"]',
    '      interval: 15s',
    '      timeout: 15s',
    '  box:',
    '    image: ${ROKBOT_BOX_IMAGE:-ghcr.io/hongfaqiu/rokbot/box:2bb5e41}',
    '    platform: linux/amd64',
    '',
  ].join('\n');
}

function buildCompliantEnvExample({ includeEmptySecret = false } = {}) {
  const lines = [
    'ROKBOT_LISTEN_ADDRESS=127.0.0.1',
    'ROKBOT_PUBLIC_PORT=18080',
    'ROKBOT_HOST_IMAGE=ghcr.io/hongfaqiu/rokbot/host:latest',
    'ROKBOT_BOX_IMAGE=ghcr.io/hongfaqiu/rokbot/box:2bb5e41',
    includeEmptySecret ? 'ROKBOT_BOX_TOKEN=' : 'ROKBOT_BOX_TOKEN=local',
    'ROKBOT_ALLOW_DEVICE_MODEL_CONFIG=1',
    'ROKBOT_UPDATE_DIR=/data/updates',
  ];
  if (includeEmptySecret) {
    lines.push('ROKBOT_INTERNAL_SECRET=');
  }
  return lines.join('\n') + '\n';
}

function buildCompliantInstallScript() {
  return `#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="docker-compose.images.yml"
OVERRIDE_FILE="docker-compose.override.yml"
ENV_EXAMPLE=".env.images.example"
ENV_FILE=".env"

prepare_only=false
skip_existing=false
pull_never=false
offline=false

for arg in "$@"; do
  case "$arg" in
    --prepare-only) prepare_only=true ;;
    --local) skip_existing=true ;;
    --pull-never) pull_never=true ;;
    --offline) skip_existing=true; pull_never=true; offline=true ;;
    -h|--help) echo "Usage: bash install-images.sh [OPTIONS]"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

DOWNLOAD_BASE="\${ROKBOT_DOWNLOAD_BASE:-https://raw.githubusercontent.com/hongfaqiu/rokbot/main/host/release}"
DOWNLOAD_BASE="\${DOWNLOAD_BASE%/}"
case "$DOWNLOAD_BASE" in
  https://*|file://*) ;;
  *) echo "RokBot setup failed: ROKBOT_DOWNLOAD_BASE must use https:// or file://." >&2; exit 1 ;;
esac

if [[ "$offline" == true ]]; then
  for f in "$COMPOSE_FILE" "$ENV_EXAMPLE"; do
    if [[ ! -f "$f" && ( "$SCRIPT_DIR" == "$PWD" || ! -f "\${SCRIPT_DIR}/\${f}" ) ]]; then
      echo "RokBot setup failed: --offline requires local \${f}" >&2
      exit 1
    fi
  done
fi

command -v docker >/dev/null 2>&1 || { echo "'docker' is required." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose plugin is required." >&2; exit 1; }

for f in "$COMPOSE_FILE" "$ENV_EXAMPLE"; do
  if [[ "$skip_existing" == true ]]; then
    if [[ ! -f "$f" && "$SCRIPT_DIR" != "$PWD" && -f "\${SCRIPT_DIR}/\${f}" ]]; then
      cp "\${SCRIPT_DIR}/\${f}" "$f"
    fi
  else
    curl -fsSL "\${DOWNLOAD_BASE}/\${f}" -o "$f"
  fi
done

if [[ ! -f "$ENV_FILE" ]]; then
  (umask 077; cp "$ENV_EXAMPLE" "$ENV_FILE")
fi
chmod 600 "$ENV_FILE"

tmp_env="\${ENV_FILE}.tmp.$$"
(umask 077; : > "$tmp_env")
while IFS= read -r line || [[ -n "$line" ]]; do
  line="\${line%$'\\r'}"
  if [[ "$line" =~ ^ROKBOT_BOX_TOKEN=[[:space:]]*$ ]]; then
    echo "ROKBOT_BOX_TOKEN=local" >> "$tmp_env"
  elif [[ "$line" =~ ^(ROKBOT_[A-Z0-9_]*_SECRET)=[[:space:]]*$ ]]; then
    secret_key="\${BASH_REMATCH[1]}"
    secret_val="$(openssl rand -hex 24)"
    echo "\${secret_key}=\${secret_val}" >> "$tmp_env"
  else
    echo "$line" >> "$tmp_env"
  fi
done < "$ENV_FILE"
mv "$tmp_env" "$ENV_FILE"
chmod 600 "$ENV_FILE"

strip_line() {
  local raw="$1" i c q="" out=""
  raw="\${raw%$'\\r'}"
  for ((i=0; i<\${#raw}; i++)); do
    c="\${raw:i:1}"
    if [[ -n "$q" ]]; then
      out+="$c"
      [[ "$c" == "$q" ]] && q=""
    elif [[ "$c" == "'" || "$c" == '"' ]]; then
      q="$c"; out+="$c"
    elif [[ "$c" == "#" ]]; then
      break
    else
      out+="$c"
    fi
  done
  printf '%s' "$out"
}

unquote_val() {
  local v="$1"
  v="\${v#"\${v%%[![:space:]]*}"}"
  v="\${v%"\${v##*[![:space:]]}"}"
  if (( \${#v} >= 2 )) && [[ ( "\${v:0:1}" == '"' && "\${v: -1}" == '"' ) || ( "\${v:0:1}" == "'" && "\${v: -1}" == "'" ) ]]; then
    v="\${v:1:\${#v}-2}"
  fi
  printf '%s' "$v"
}

while IFS= read -r line || [[ -n "$line" ]]; do
  clean="$(strip_line "$line")"
  if [[ "$clean" =~ ^[[:space:]]*(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    k="\${BASH_REMATCH[1]}"
    v="$(unquote_val "\${BASH_REMATCH[2]}")"
    case "$k" in
      HTTP_PROXY|http_proxy) export HTTP_PROXY="$v" http_proxy="$v" ;;
      HTTPS_PROXY|https_proxy) export HTTPS_PROXY="$v" https_proxy="$v" ;;
      NO_PROXY|no_proxy) export NO_PROXY="$v" no_proxy="$v" ;;
    esac
  fi
done < "$ENV_FILE"

compose_args=(--env-file "$ENV_FILE" -f "$COMPOSE_FILE")
if [[ -f "$OVERRIDE_FILE" ]]; then
  compose_args+=(-f "$OVERRIDE_FILE")
fi
docker compose "\${compose_args[@]}" config --quiet

if [[ "$prepare_only" == true ]]; then
  echo "RokBot files are ready (prepare-only)."
  exit 0
fi

docker compose "\${compose_args[@]}" up -d
echo "RokBot Admin: http://127.0.0.1:18080/admin"
echo "Setup key: cat /data/setup-key"
echo "Devices: http://127.0.0.1:18080/admin?view=devices"
echo "Model Config: http://127.0.0.1:18080/admin?view=model"
echo "Auto-Updates: http://127.0.0.1:18080/admin?view=updates"
`;
}

async function writeSyntheticDeployBundle(dir, { includeEmptySecret = false } = {}) {
  await mkdir(dir, { recursive: true });
  const composePath = path.join(dir, 'docker-compose.images.yml');
  const envExamplePath = path.join(dir, '.env.images.example');
  const scriptPath = path.join(dir, 'install-images.sh');
  await writeFile(composePath, buildCompliantComposeYaml(), 'utf8');
  await writeFile(envExamplePath, buildCompliantEnvExample({ includeEmptySecret }), 'utf8');
  await writeFile(scriptPath, buildCompliantInstallScript(), { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return { composePath, envExamplePath, scriptPath };
}

function parseSimpleEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier 1 Tests: F1, F2, F3, F7 (24 Tests)
// ---------------------------------------------------------------------------

export function registerTests(test, ctx) {
  // =========================================================================
  // Feature F1: Legacy Decoupling & Path Fixes (T1-F01-01 .. T1-F01-06)
  // =========================================================================

  test('T1-F01-01', 'Release signing and ECDSA P-256 manifest contract exports (release-sign semantics)', async (t) => {
    const kp = ctx.cryptoDelta.generateSigningKeyPair();
    const normSpki = ctx.cryptoDelta.normalizeEcPublicKey(kp.publicKeySpkiBase64);
    ctx.assert.equal(normSpki, kp.publicKeySpkiBase64);
    ctx.assert.equal(ctx.cryptoDelta.normalizeEcPublicKey(kp.publicKeyPem), kp.publicKeySpkiBase64);

    const androidPayload = ctx.cryptoDelta.signAndroidManifest({
      schema: ctx.cryptoDelta.ANDROID_UPDATE_SCHEMA,
      platform: 'android',
      version: '1.16.0',
      versionCode: 1075,
      packageName: 'dev.rokbot.nativeapp',
      certificateSha256: 'ab'.repeat(32),
      url: 'https://bot.example.com/local/updates/files/android/rokbot.apk',
      sha256: 'cd'.repeat(32),
      size: 123456,
    }, kp.privateKeyPem);
    const verifiedAndroid = ctx.cryptoDelta.verifyAndroidManifest(androidPayload, kp.publicKeyPem);
    ctx.assert.equal(verifiedAndroid.schema, 'rokbot-android-update/v1');

    const desktopPayload = ctx.cryptoDelta.signDesktopManifest({
      schema: ctx.cryptoDelta.DESKTOP_UPDATE_SCHEMA,
      platform: 'macos',
      version: '1.2.3',
      url: 'https://bot.example.com/local/updates/files/macos/RokBot-1.2.3.dmg',
      sha256: 'ef'.repeat(32),
      size: 654321,
    }, kp.privateKeyPem);
    const verifiedDesktop = ctx.cryptoDelta.verifyDesktopManifest(desktopPayload, kp.publicKeySpkiBase64);
    ctx.assert.equal(verifiedDesktop.schema, 'rokbot-desktop-update/v1');

    if (ctx.repoCheck) {
      const signFile = path.join(ctx.repoRoot, 'ci', 'release-sign.mjs');
      ctx.assert.equal(existsSync(signFile), true, 'ci/release-sign.mjs must exist');
      const chk = await spawnAsync('node', ['--check', signFile], { encoding: 'utf8' });
      ctx.assert.equal(chk.status, 0, chk.stderr);
      const signMod = await import(path.join(ctx.repoRoot, 'ci', 'release-sign.mjs'));
      for (const sym of [
        'ANDROID_UPDATE_SCHEMA',
        'DESKTOP_UPDATE_SCHEMA',
        'loadManifestSigningKey',
        'signAndroidUpdateManifest',
        'verifyAndroidUpdateManifest',
        'normalizeEcPublicKey',
      ]) {
        ctx.assert.ok(signMod[sym], `ci/release-sign.mjs must export ${sym}`);
      }
    }
  });

  test('T1-F01-02', 'Android recipes/manifest.json schema & decoupled ci/check-inputs contract', async (t) => {
    const tmp = await t.createTempDir('t1-f01-02-');
    const recipesDir = path.join(tmp, 'android', 'recipes');
    await mkdir(recipesDir, { recursive: true });
    await writeFile(path.join(recipesDir, 'unpaired.hbc.gbp.gz'), Buffer.from('gz-patch-1'));
    await writeFile(path.join(recipesDir, 'index.android.bundle.gbp.gz'), Buffer.from('gz-patch-2'));

    const manifest = {
      schema: 'rokbot-android-native/v1',
      packageName: 'dev.rokbot.nativeapp',
      version: '1.16.0',
      build: '23152',
      hbcSha256: 'aa'.repeat(32),
      baseApkSha256: 'bb'.repeat(32),
      companionDexSha256: 'cc'.repeat(32),
      resources: [
        { target: 'assets/unpaired.hbc', patch: 'unpaired.hbc.gbp.gz' },
        { target: 'assets/index.android.bundle', patch: 'index.android.bundle.gbp.gz' },
      ],
    };
    await writeFile(path.join(recipesDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const parsed = JSON.parse(await readFile(path.join(recipesDir, 'manifest.json'), 'utf8'));
    ctx.assert.equal(parsed.schema, 'rokbot-android-native/v1');
    const targets = parsed.resources.map((r) => r.target);
    ctx.assert.equal(new Set(targets).size, targets.length);
    for (const r of parsed.resources) {
      ctx.assert.ok(r.patch.endsWith('.gz'));
      ctx.assert.equal(existsSync(path.join(recipesDir, r.patch)), true);
    }

    if (ctx.repoCheck) {
      const checkInputsPath = path.join(ctx.repoRoot, 'ci', 'check-inputs.mjs');
      const checkInputsTxt = await readFile(checkInputsPath, 'utf8');
      ctx.assert.ok(checkInputsTxt.includes('android/recipes/manifest.json'));
      ctx.assert.equal(/android\/recipes\/supported\.json/.test(checkInputsTxt), false);

      const realManifestPath = path.join(ctx.repoRoot, 'android', 'recipes', 'manifest.json');
      const realManifest = JSON.parse(await readFile(realManifestPath, 'utf8'));
      ctx.assert.equal(realManifest.schema, 'rokbot-android-native/v1');
      for (const r of realManifest.resources ?? []) {
        ctx.assert.equal(existsSync(path.join(ctx.repoRoot, 'android', 'recipes', r.patch)), true, `Missing ${r.patch}`);
      }
    }
  });

  test('T1-F01-03', 'Empty ROKBOT_DEFAULT_MACHINE_ID in Compose & deterministic localExec routing', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const composeYaml = buildCompliantComposeYaml();
    ctx.assert.equal(/ROKBOT_DEFAULT_MACHINE_ID:\s*["']?[0-9a-f]{8,}/i.test(composeYaml), false);

    if (ctx.harness) {
      ctx.harness.setDefaultMachineId('');
      ctx.harness.setComputers([{ id: 'machine-solo-01', name: 'Solo Mac', connected: true, platform: 'macos' }]);
    }

    await ensureDeviceSession(ctx, client, { deviceName: 'Routing Probe' });

    const compRes = await client.getComputers();
    ctx.assert.assertStatus(compRes, 200);
    if (ctx.harness || (compRes.json?.available && Array.isArray(compRes.json?.computers) && compRes.json.computers.length >= 1)) {
      ctx.assert.equal(compRes.json.available, true);
      ctx.assert.ok(Array.isArray(compRes.json.computers) && compRes.json.computers.length >= 1);

      if (ctx.harness) {
        const implicitExec = await client.apiCall('localExec', { command: 'uname' });
        ctx.assert.assertStatus(implicitExec, 200);
        ctx.assert.equal(implicitExec.json.machineId, 'machine-solo-01');
      }
    }

    if (ctx.repoCheck) {
      for (const rel of ['host/release/compose.yaml', 'host/release/docker-compose.images.yml']) {
        const text = await readFile(path.join(ctx.repoRoot, rel), 'utf8');
        ctx.assert.equal(/ROKBOT_DEFAULT_MACHINE_ID:\s*["']?[0-9a-f]{8,}/i.test(text), false, `${rel} must not hardcode ROKBOT_DEFAULT_MACHINE_ID`);
      }
    }
  });

  test('T1-F01-04', 'Decoupled Web patcher & supported.json cross-module path integrity', async (t) => {
    const tmp = await t.createTempDir('t1-f01-04-');
    await mkdir(path.join(tmp, 'web', 'patchers'), { recursive: true });
    await mkdir(path.join(tmp, 'web', 'client'), { recursive: true });
    await mkdir(path.join(tmp, 'mac', 'clients', 'desktop'), { recursive: true });
    await mkdir(path.join(tmp, 'assets', 'logo'), { recursive: true });

    await writeFile(
      path.join(tmp, 'web', 'patchers', 'supported.json'),
      JSON.stringify({ schema: 'rokbot-web-build/v1', version: '1.2.3' }, null, 2),
      'utf8',
    );
    await writeFile(path.join(tmp, 'web', 'patchers', 'patch.mjs'), 'export const icon = "../../assets/logo/rokbot-icon-512.png";\n', 'utf8');
    await writeFile(path.join(tmp, 'mac', 'clients', 'desktop', 'workspace.css'), 'body { margin: 0; }\n', 'utf8');
    await writeFile(path.join(tmp, 'assets', 'logo', 'rokbot-icon-512.png'), buildSyntheticPng(512, 512, 6));

    const patchText = await readFile(path.join(tmp, 'web', 'patchers', 'patch.mjs'), 'utf8');
    ctx.assert.equal(/src\/android|android\/shell|android\/patchers\/patch\.mjs/.test(patchText), false);
    ctx.assert.equal(existsSync(path.join(tmp, 'web', 'patchers', 'supported.json')), true);

    if (ctx.repoCheck) {
      const realSupported = JSON.parse(await readFile(path.join(ctx.repoRoot, 'web', 'patchers', 'supported.json'), 'utf8'));
      ctx.assert.equal(realSupported.schema, 'rokbot-web-build/v1');
      const realPatch = await readFile(path.join(ctx.repoRoot, 'web', 'patchers', 'patch.mjs'), 'utf8');
      ctx.assert.equal(/src\/android|android\/shell|android\/patchers\/patch\.mjs/.test(realPatch), false);
      ctx.assert.equal(existsSync(path.join(ctx.repoRoot, 'mac', 'clients', 'desktop', 'workspace.css')), true);
      ctx.assert.equal(existsSync(path.join(ctx.repoRoot, 'assets', 'logo', 'rokbot-icon-512.png')), true);
    }
  });

  test('T1-F01-05', 'Cross-module desktop & mobile binary path integrity (rokbot-tailcat & RokBotLocal)', async (t) => {
    const tmp = await t.createTempDir('t1-f01-05-');
    const relPaths = [
      'host/bin/rokbot-tailcat',
      'mac/dist/network/rokbot-tailcat',
      'windows/dist/network/rokbot-tailcat.exe',
      'windows/dist/installer/rokbot-setup-stub.exe',
      'ios/bin/RokBotLocal.dylib',
    ];
    for (const rel of relPaths) {
      const full = path.join(tmp, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, Buffer.from(`stub:${rel}`));
      ctx.assert.equal(ctx.repoChecks.scanTextForRebranding(rel).ok, true);
      ctx.assert.equal(existsSync(full), true);
    }

    if (ctx.repoCheck) {
      for (const rel of relPaths) {
        ctx.assert.equal(existsSync(path.join(ctx.repoRoot, rel)), true, `Missing expected artifact: ${rel}`);
      }
      ctx.assert.equal(existsSync(path.join(ctx.repoRoot, 'ios', 'bin', 'GrokBotLocal.dylib')), false, 'Legacy GrokBotLocal.dylib must be removed');
    }
  });

  test('T1-F01-06', 'Host /local/status decoupled machine & version metadata + android/tests path cleanliness', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await ensureDeviceSession(ctx, client, { deviceName: 'Status Probe' });

    const st = await client.localStatus();
    ctx.assert.assertStatus(st, 200);
    ctx.assert.equal(st.json.ok, true);
    ctx.assert.equal(st.json.brand, 'RokBot');
    ctx.assert.equal(typeof st.json.hostVersion, 'string');
    ctx.assert.ok('defaultMachineId' in st.json);

    if (ctx.repoCheck) {
      for (const rel of ['android/tests/m2-m5-features.test.mjs', 'android/tests/runner.mjs']) {
        const text = await readFile(path.join(ctx.repoRoot, rel), 'utf8');
        ctx.assert.equal(/src\/android\/|android\/shell\//.test(text), false, `${rel} must not reference deleted src/android/ or android/shell/`);
      }
    }
  });

  // =========================================================================
  // Feature F2: Custom Deformed RokBot Logo (T1-F02-01 .. T1-F02-06)
  // =========================================================================

  test('T1-F02-01', 'Canonical deformed RokBot SVG geometry & rebrand validation', async (t) => {
    const tmp = await t.createTempDir('t1-f02-01-');
    const svgPath = path.join(tmp, 'rokbot-logo.svg');
    await writeFile(svgPath, buildSyntheticRokBotSvg(), 'utf8');

    const info = ctx.repoChecks.inspectSvg(svgPath);
    ctx.assert.equal(info.format, 'svg');
    ctx.assert.equal(info.hasBrandFace, true);
    ctx.assert.ok(info.bezierSegmentCount >= 4);
    ctx.assert.equal(info.eyeCount, 2);
    ctx.assert.equal(info.hasTiltedEyes, true);
    ctx.assert.equal(info.hasAsymmetricEyes, true);
    ctx.assert.equal(info.hasBrandAccent, true);
    ctx.assert.equal(info.rebrandingOk, true);

    if (ctx.repoCheck) {
      const realSvg = ctx.repoChecks.inspectSvg(path.join(ctx.repoRoot, 'assets', 'logo', 'rokbot-logo.svg'));
      ctx.assert.equal(realSvg.hasBrandFace, true);
      ctx.assert.ok(realSvg.bezierSegmentCount >= 4);
      ctx.assert.equal(realSvg.eyeCount, 2);
      ctx.assert.equal(realSvg.hasTiltedEyes, true);
      ctx.assert.equal(realSvg.hasAsymmetricEyes, true);
      ctx.assert.equal(realSvg.hasBrandAccent, true);
      ctx.assert.equal(realSvg.rebrandingOk, true);
    }
  });

  test('T1-F02-02', 'Full 35-asset RokBot Logo suite manifest & SHA-256 verification', async (t) => {
    const tmp = await t.createTempDir('t1-f02-02-');
    await buildSyntheticLogoSuite(tmp, { sha256Hex: ctx.cryptoDelta.sha256Hex });

    const res = ctx.repoChecks.verifyLogoSuite(tmp);
    ctx.assert.equal(res.ok, true, res.errors.join('; '));
    ctx.assert.equal(res.schema, 'rokbot-logo-manifest/v1');
    ctx.assert.equal(res.checkedCount, 35);

    if (ctx.repoCheck) {
      const realRes = ctx.repoChecks.verifyLogoSuite(ctx.repoRoot);
      ctx.assert.equal(realRes.ok, true, realRes.errors.join('; '));
      ctx.assert.equal(realRes.schema, 'rokbot-logo-manifest/v1');
      ctx.assert.equal(realRes.checkedCount, 35);
    }
  });

  test('T1-F02-03', 'Multi-resolution .ico (16..256) and .icns (ic07..ic10) binary inspection', async (t) => {
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const icoInfo = ctx.repoChecks.inspectIco(buildSyntheticIco(icoSizes));
    ctx.assert.deepEqual(icoInfo.sizes, icoSizes);
    ctx.assert.equal(icoInfo.entries.every((e) => e.isPng && e.pngColorType === 6), true);

    const icnsInfo = ctx.repoChecks.inspectIcns(buildSyntheticIcns());
    ctx.assert.equal(icnsInfo.format, 'icns');
    ctx.assert.ok(icnsInfo.chunks.length >= 4);
    for (const c of icnsInfo.chunks) {
      if (c.isPng && c.nominalSize != null) {
        ctx.assert.equal(c.width, c.nominalSize);
        ctx.assert.equal(c.height, c.nominalSize);
      }
    }

    if (ctx.repoCheck) {
      const realIco = ctx.repoChecks.inspectIco(path.join(ctx.repoRoot, 'assets', 'logo', 'rokbot.ico'));
      ctx.assert.deepEqual(realIco.sizes, icoSizes);
      const realIcns = ctx.repoChecks.inspectIcns(path.join(ctx.repoRoot, 'assets', 'logo', 'rokbot.icns'));
      ctx.assert.ok(realIcns.chunks.length >= 4);
      ctx.assert.equal(existsSync(path.join(ctx.repoRoot, 'mac', 'patchers', 'desktop', 'brand-assets.mjs')), true);
      ctx.assert.equal(existsSync(path.join(ctx.repoRoot, 'windows', 'patchers', 'desktop', 'brand-assets.mjs')), true);
    }
  });

  test('T1-F02-04', 'Android 15 mipmap RGBA & iOS 5 opaque RGB AppIcon color-type contract', async (t) => {
    const tmp = await t.createTempDir('t1-f02-04-');
    const manifest = await buildSyntheticLogoSuite(tmp, { sha256Hex: ctx.cryptoDelta.sha256Hex });

    ctx.assert.equal(manifest.android.length, 15);
    for (const item of manifest.android) {
      const info = ctx.repoChecks.inspectPng(path.join(tmp, item.path));
      ctx.assert.equal(info.colorType, 6);
      ctx.assert.equal(info.hasAlpha, true);
      ctx.assert.equal(info.width, item.width);
      ctx.assert.equal(info.height, item.height);
    }

    ctx.assert.equal(manifest.ios.length, 5);
    for (const item of manifest.ios) {
      const info = ctx.repoChecks.inspectPng(path.join(tmp, item.path));
      ctx.assert.equal(info.colorType, 2);
      ctx.assert.equal(info.hasAlpha, false);
      ctx.assert.equal(info.width, item.width);
      ctx.assert.equal(info.height, item.height);
    }

    if (ctx.repoCheck) {
      const realManifest = JSON.parse(await readFile(path.join(ctx.repoRoot, 'assets', 'logo', 'manifest.json'), 'utf8'));
      ctx.assert.equal(realManifest.android.length, 15);
      ctx.assert.equal(realManifest.ios.length, 5);
      for (const item of realManifest.ios) {
        const info = ctx.repoChecks.inspectPng(path.join(ctx.repoRoot, item.path));
        ctx.assert.equal(info.colorType, 2);
        ctx.assert.equal(info.hasAlpha, false);
      }
    }
  });

  test('T1-F02-05', 'Host /rokbot-icon.png GET & HEAD PNG magic, 512x512 RGBA & cache headers', async (t) => {
    const client = createClient(ctx);
    t.after(() => client.close());

    const getRes = await client.getIcon('GET');
    ctx.assert.assertStatus(getRes, 200);
    ctx.assert.ok((getRes.headers.get('content-type') || '').includes('image/png'));
    ctx.assert.ok((getRes.headers.get('cache-control') || '').includes('public'));
    ctx.assert.equal(Number(getRes.headers.get('content-length')), getRes.buffer.length);

    const pngInfo = ctx.repoChecks.inspectPng(getRes.buffer);
    ctx.assert.equal(pngInfo.width, 512);
    ctx.assert.equal(pngInfo.height, 512);
    ctx.assert.equal(pngInfo.colorType, 6);

    const headRes = await client.getIcon('HEAD');
    ctx.assert.assertStatus(headRes, 200);
    ctx.assert.equal(headRes.buffer.length, 0);
    ctx.assert.equal(Number(headRes.headers.get('content-length')), getRes.buffer.length);

    if (ctx.repoCheck) {
      const pubHash = await ctx.cryptoDelta.sha256File(path.join(ctx.repoRoot, 'host', 'server', 'public', 'rokbot-icon.png'));
      const assetHash = await ctx.cryptoDelta.sha256File(path.join(ctx.repoRoot, 'assets', 'logo', 'rokbot-icon-512.png'));
      ctx.assert.equal(pubHash, assetHash);
    }
  });

  test('T1-F02-06', 'Host /web/manifest.webmanifest & favicon.svg brand icon integration', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const directIcon = await client.getIcon('GET');
    ctx.assert.assertStatus(directIcon, 200);
    ctx.assert.equal(ctx.repoChecks.inspectPng(directIcon.buffer).width, 512);

    const manRes = await client.getWebManifest();
    if (!ctx.harness && manRes.status === 404) {
      const ws = await client.webSession();
      ctx.assert.assertStatus(ws, 200);
      ctx.assert.equal(ws.json?.available, false);
    } else {
      ctx.assert.assertStatus(manRes, 200);
      ctx.assert.equal(manRes.json?.name, 'RokBot');
      ctx.assert.equal(manRes.json?.short_name, 'RokBot');
      const allowedSrcs = ctx.harness
        ? ['/rokbot-icon.png']
        : ['/rokbot-icon.png', '/web/client/icon.png', '/web/client/icon-512.png'];
      const allowedSizes = ctx.harness ? ['512x512'] : ['512x512', '256x256'];
      const iconSrc = manRes.json?.icons?.[0]?.src;
      ctx.assert.ok(allowedSrcs.includes(iconSrc), `Unexpected manifest icon src: ${iconSrc}`);
      ctx.assert.ok(allowedSizes.includes(manRes.json?.icons?.[0]?.sizes), `Unexpected icon sizes: ${manRes.json?.icons?.[0]?.sizes}`);

      if (iconSrc.startsWith('/web/')) {
        const unauthIcon = await client.request('GET', iconSrc, { auth: false, cookies: false });
        ctx.assert.assertStatus(unauthIcon, 401);
        const webRes = await ensureWebSession(ctx, client);
        if (webRes.status !== 409) {
          const authIcon = await client.request('GET', iconSrc, { bearer: null });
          ctx.assert.assertStatus(authIcon, 200);
          const pngInfo = ctx.repoChecks.inspectPng(authIcon.buffer);
          ctx.assert.ok([256, 512].includes(pngInfo.width));
        }
      } else {
        const iconFetch = await client.request('GET', iconSrc, { auth: false });
        ctx.assert.assertStatus(iconFetch, 200);
        const pngInfo = ctx.repoChecks.inspectPng(iconFetch.buffer);
        ctx.assert.equal(pngInfo.width, 512);
      }
    }

    const favText = buildSyntheticFaviconSvg();
    ctx.assert.ok(/prefers-color-scheme:\s*dark/.test(favText));
    ctx.assert.ok(favText.includes('brand-face') && favText.includes('brand-accent'));

    if (ctx.repoCheck) {
      const realFav = await readFile(path.join(ctx.repoRoot, 'host', 'server', 'public', 'favicon.svg'), 'utf8');
      ctx.assert.ok(/prefers-color-scheme:\s*dark/.test(realFav));
      ctx.assert.ok(realFav.includes('brand-face') && realFav.includes('brand-accent'));
    }
  });

  // =========================================================================
  // Feature F3: Rebranding & hongfaqiu/rokbot Alignment (T1-F03-01 .. T1-F03-06)
  // =========================================================================

  test('T1-F03-01', 'Clean Category-A rokbot identifiers and operational hongfaqiu/rokbot URLs pass', async () => {
    const cleanSample = [
      'ROKBOT_PORT=8000',
      'ROKBOT_HOST_IMAGE=ghcr.io/hongfaqiu/rokbot/host:latest',
      'ROKBOT_BOX_IMAGE=ghcr.io/hongfaqiu/rokbot/box:2bb5e41',
      'const hdr = "x-rokbot-csrf";',
      'const cookies = ["rokbot_admin", "rokbot_web", "rokbot_vnc_0"];',
      'const ids = ["dev.rokbot.nativeapp", "dev.rokbot.local", "rokbot-local://open"];',
      'const magic = ["RBDELTA1", "RBD1"];',
      'const repo = "https://github.com/hongfaqiu/rokbot";',
    ].join('\n');

    const reb = ctx.repoChecks.scanTextForRebranding(cleanSample, { filePath: 'clean-sample.js' });
    ctx.assert.equal(reb.ok, true, JSON.stringify(reb.violations));
    const urlRes = ctx.repoChecks.checkOperationalRepoUrls(cleanSample);
    ctx.assert.equal(urlRes.ok, true, urlRes.errors.join('; '));

    if (ctx.repoCheck) {
      const repoScan = await ctx.repoChecks.scanRepoRebranding(ctx.repoRoot, {
        includePaths: ['assets', 'docs', 'mac/clients', 'mac/patchers', 'windows/patchers', 'windows/tools', 'web/client', 'web/patchers', 'android/patchers', 'android/release', 'ios/patchers', 'ios/release'],
        excludePaths: ['docs/REBRAND_COMPAT.md'],
      });
      ctx.assert.equal(repoScan.ok, true, JSON.stringify(repoScan.violations.slice(0, 5)));

      // Verify newly completed platform rebrand hooks remain wired
      const [
        webPatch,
        webShell,
        webCss,
        winPe,
        winBrand,
        winPatch,
        macCss,
        macPlatform,
        macBrand,
        androidNotif,
        androidVoice,
        androidPatch,
        androidHermes,
        iosExt,
        iosPatch,
      ] = await Promise.all([
        readFile(path.join(ctx.repoRoot, 'web', 'patchers', 'patch.mjs'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'web', 'client', 'web-shell.js'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'web', 'client', 'web.css'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'windows', 'patchers', 'desktop', 'pe.mjs'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'windows', 'patchers', 'desktop', 'brand-assets.mjs'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'windows', 'patchers', 'desktop', 'patch.mjs'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'mac', 'clients', 'desktop', 'workspace.css'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'mac', 'clients', 'desktop', 'platform.mjs'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'mac', 'patchers', 'desktop', 'brand-assets.mjs'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'android', 'companion', 'src', 'main', 'java', 'dev', 'rokbot', 'nativeapp', 'NotificationService.java'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'android', 'companion', 'src', 'main', 'java', 'dev', 'rokbot', 'nativeapp', 'VoiceCallService.java'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'android', 'release', 'patch-android.mjs'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'android', 'patchers', 'hermes.mjs'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'ios', 'patchers', 'ios', 'extensions.py'), 'utf8'),
        readFile(path.join(ctx.repoRoot, 'ios', 'patchers', 'ios', 'patch-app.py'), 'utf8'),
      ]);
      ctx.assert.ok(webPatch.includes('<title>RokBot</title>'), 'web/patchers/patch.mjs must set <title>RokBot</title>');
      ctx.assert.ok(webShell.includes("../client/icon.png"), 'web/client/web-shell.js Notification must set icon');
      ctx.assert.ok(webCss.includes('.sand-grok-bot-mark'), 'web/client/web.css must override .sand-grok-bot-mark');
      ctx.assert.ok(winPe.includes('replaceResources') && winBrand.includes('WINDOWS_PE_VERSION_STRINGS') && winPatch.includes('replaceResources'), 'Windows PE resource patching must be wired');
      ctx.assert.ok(macCss.includes('.sand-grok-bot-mark') && macPlatform.includes('normalizeDesktopWindowTitle') && macBrand.includes('applyRokBotHelperInfoPlist'), 'macOS/desktop title, mark, and helper plist rebrand hooks must exist');
      ctx.assert.ok(androidNotif.includes('applySmallIcon') && androidVoice.includes('applySmallIcon'), 'Android services must use NotificationService.applySmallIcon');
      ctx.assert.equal(/android\.R\.drawable\.(?:ic_dialog_info|ic_dialog_alert|ic_btn_speak_now)/.test(androidNotif + androidVoice), false, 'Android services must not use generic android.R.drawable notification icons');
      ctx.assert.ok(androidPatch.includes('brandDrawablesReplaced') && androidHermes.includes("'RokBot'"), 'Android patcher must rebrand splash/notification drawables and app.config name');
      ctx.assert.ok(iosExt.includes('rebrand_info_strings') && iosPatch.includes('rebrand_info_strings') && iosPatch.includes('CFBundleIcons~iphone'), 'iOS patcher must rebrand extension display names, InfoPlist.strings, and legacy icon/launch keys');
    }
  });

  test('T1-F03-02', 'All Category-B upstream-pinned constants allowed under strict defaults', async () => {
    const catBSample = [
      'ai.x.grok.bot',
      'co.anysphere.sand',
      'com.anysphere.sand',
      'Grok Bot.app',
      'Grok Bot.exe',
      'Grok Bot Computer Use.app',
      'CUGrokBotService',
      'https://api.x.ai/v1',
      'https://api2.cursor.sh',
      'https://downloads.cursor.com',
      '/aiserver.v1.GrokBotService/MintSandVoiceCallSecret',
      'GetGrokBotMcpToolPermissions',
      'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW',
      'sand-host',
      'SandHost',
      'SAND_DATA_ROOT',
      'dune-rpc:main:probe',
      'grokbot://app/v1/chat',
      'https://apps.apple.com/us/app/grok-bot/id6794501026',
    ].join('\n');

    const res = ctx.repoChecks.scanTextForRebranding(catBSample, { filePath: 'cat-b.js' });
    ctx.assert.equal(res.ok, true, JSON.stringify(res.violations));
    ctx.assert.ok(res.categoryBMatches.length >= 18);

    if (ctx.repoCheck) {
      const compatDoc = path.join(ctx.repoRoot, 'docs', 'REBRAND_COMPAT.md');
      ctx.assert.equal(existsSync(compatDoc), true, 'docs/REBRAND_COMPAT.md must exist');
      const docText = await readFile(compatDoc, 'utf8');
      ctx.assert.ok(docText.includes('Category'));
    }
  });

  test('T1-F03-03', 'Bounded allowAbiCompat and allowMigrationBridges masking preserve strict checks', async () => {
    const abiSample = [
      'Java_dev_grokbot_local_TailcatBridge_nativeStart',
      'dev.grokbot.local.TailcatBridge',
      'libgroktailcatjni.so',
      'GBTailcatStart',
    ].join('\n');
    const abiOk = ctx.repoChecks.scanTextForRebranding(abiSample, { filePath: 'jni.java', allowAbiCompat: true });
    ctx.assert.equal(abiOk.ok, true, JSON.stringify(abiOk.violations));

    const bridgeSample = [
      'PORT=${ROKBOT_PORT:-${GROKBOT_PORT:-8000}}',
      'const legacy = ["GBDELTA1", "GBD1", "*.gbdelta", "grokbot-desktop-update/v1", "grokbot-android-native-update/v1"];',
      'const state = ["__grokbotPromptPolicy", "providerOptions?.grokbot", "grokbot.clientDeviceId", "grokbot-local-update.json"];',
    ].join('\n');
    const bridgeOk = ctx.repoChecks.scanTextForRebranding(bridgeSample, { filePath: 'bridge.js', allowMigrationBridges: true });
    ctx.assert.equal(bridgeOk.ok, true, JSON.stringify(bridgeOk.violations));

    // Unrelated Category-A token on same line must still fail even with migration bridges enabled
    const mixedLine = 'const x = "GBD1"; const bad = "x-grokbot-csrf";';
    const mixedRes = ctx.repoChecks.scanTextForRebranding(mixedLine, { filePath: 'mixed.js', allowMigrationBridges: true });
    ctx.assert.equal(mixedRes.ok, false);
    ctx.assert.equal(mixedRes.violations[0].token, 'x-grokbot-csrf');

    if (ctx.repoCheck) {
      const docScan = await ctx.repoChecks.scanRepoRebranding(ctx.repoRoot, {
        includePaths: ['README.md', 'README.en.md', 'NOTICE', 'SECURITY.md'],
        allowHistoricalAttribution: true,
      });
      ctx.assert.equal(docScan.ok, true, JSON.stringify(docScan.violations));
    }
  });

  test('T1-F03-04', 'Plain UTF-8 file starting with "MZ" is scanned while real PE/ELF/Mach-O binaries are skipped', async (t) => {
    const tmp = await t.createTempDir('t1-f03-04-');
    await writeFile(path.join(tmp, 'mz-note.txt'), 'MZ clean rokbot notes\nROKBOT_PORT=8000\n', 'utf8');
    await writeFile(path.join(tmp, 'real-pe.bin'), Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.from('x-grokbot-csrf')]));
    await writeFile(path.join(tmp, 'real-elf.bin'), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]), Buffer.from('GROKBOT_PORT')]));
    await writeFile(path.join(tmp, 'real-macho.bin'), Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00]), Buffer.from('GROKBOT_PORT')]));

    const scan = await ctx.repoChecks.scanRepoRebranding(tmp);
    ctx.assert.equal(scan.ok, true, JSON.stringify(scan.violations));
    ctx.assert.equal(scan.scannedFiles, 1);
  });

  test('T1-F03-05', 'Live Host HTTP headers, cookies, and status JSON use rokbot branding with zero Category-A leaks', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);
    ctx.assert.equal(client.cookies.has('rokbot_admin'), true);
    ctx.assert.equal(client.cookies.has('grokbot_admin'), false);

    if (ctx.harness) {
      const key = await client.createPairingKey();
      ctx.assert.assertStatus(key, 201);
      const webPair = await client.webPair({ pairingKey: key.json.pairingKey, deviceName: 'Brand Web' });
      ctx.assert.assertStatus(webPair, 201);
      ctx.assert.equal(client.cookies.has('rokbot_web'), true);
      ctx.assert.equal(client.cookies.has('grokbot_web'), false);
    } else {
      const ws = await client.webSession();
      ctx.assert.assertStatus(ws, 200);
      if (ws.json?.available) {
        await ensureWebSession(ctx, client, t);
        ctx.assert.equal(client.cookies.has('rokbot_web'), true);
        ctx.assert.equal(client.cookies.has('grokbot_web'), false);
      } else {
        await ensureDeviceSession(ctx, client);
      }
    }

    const pubStatus = await client.connectStatus({ auth: false });
    const locStatus = await client.localStatus();
    ctx.assert.assertStatus(pubStatus, 200);
    ctx.assert.assertStatus(locStatus, 200);
    ctx.assert.equal(pubStatus.json.brand, 'RokBot');
    ctx.assert.equal(locStatus.json.brand, 'RokBot');

    const scanPub = ctx.repoChecks.scanTextForRebranding(pubStatus.text, { filePath: '/connect/status' });
    const scanLoc = ctx.repoChecks.scanTextForRebranding(locStatus.text, { filePath: '/local/status' });
    ctx.assert.equal(scanPub.ok, true);
    ctx.assert.equal(scanLoc.ok, true);
  });

  test('T1-F03-06', 'Historical attribution allowed when explicitly enabled while operational links target hongfaqiu/rokbot', async () => {
    const attrText = 'Based on upstream inspirations ferretgeek/prokbot-plus and ahaduoduoduo/ProkBot.\nClone: https://github.com/hongfaqiu/rokbot\n';
    const reb = ctx.repoChecks.scanTextForRebranding(attrText, { filePath: 'NOTICE', allowHistoricalAttribution: true });
    ctx.assert.equal(reb.ok, true, JSON.stringify(reb.violations));
    const urlRes = ctx.repoChecks.checkOperationalRepoUrls(attrText, { allowHistoricalAttribution: true });
    ctx.assert.equal(urlRes.ok, true, urlRes.errors.join('; '));

    if (ctx.repoCheck) {
      for (const docFile of ['NOTICE', 'README.md', 'README.en.md']) {
        const text = await readFile(path.join(ctx.repoRoot, docFile), 'utf8');
        const chk = ctx.repoChecks.checkOperationalRepoUrls(text, { allowHistoricalAttribution: true });
        ctx.assert.equal(chk.ok, true, `${docFile}: ${chk.errors.join('; ')}`);
      }
    }
  });

  // =========================================================================
  // Feature F7: Prebuilt Image Host & One-Click Deployment (T1-F07-01 .. T1-F07-06)
  // =========================================================================

  test('T1-F07-01', 'validateImageComposeBundle passes compliant Compose, .env.images.example & install-images.sh', async (t) => {
    const tmp = await t.createTempDir('t1-f07-01-');
    const bundle = await writeSyntheticDeployBundle(tmp);
    const val = await ctx.repoChecks.validateImageComposeBundle({
      composePath: bundle.composePath,
      envExamplePath: bundle.envExamplePath,
      installScriptPath: bundle.scriptPath,
    });
    ctx.assert.equal(val.ok, true, val.errors.join('; '));

    if (ctx.repoCheck) {
      const releaseDir = path.join(ctx.repoRoot, 'host', 'release');
      const realVal = await ctx.repoChecks.validateImageComposeBundle({
        composePath: path.join(releaseDir, 'docker-compose.images.yml'),
        envExamplePath: path.join(releaseDir, '.env.images.example'),
        installScriptPath: path.join(releaseDir, 'install-images.sh'),
      });
      ctx.assert.equal(realVal.ok, true, realVal.errors.join('; '));
    }
  });

  test('T1-F07-02', 'install-images.sh --prepare-only --offline creates 0600 .env & validates Compose cleanly', async (t) => {
    const tmp = await t.createTempDir('t1-f07-02-');
    const fixtureDir = path.join(tmp, 'fixture');
    const workDir = path.join(tmp, 'work');
    const bundle = await writeSyntheticDeployBundle(fixtureDir);

    const runRes = await ctx.repoChecks.runInstallImagesPrepareOnly({
      workDir,
      scriptPath: bundle.scriptPath,
      composePath: bundle.composePath,
      envExamplePath: bundle.envExamplePath,
      args: ['--prepare-only', '--offline'],
    });
    ctx.assert.equal(runRes.exitCode, 0, runRes.stderr);
    ctx.assert.equal(runRes.envMode, 0o600);
    ctx.assert.equal(runRes.parsedEnv.ROKBOT_BOX_TOKEN, 'local');
    ctx.assert.ok(runRes.stdout.includes('RokBot files are ready'));

    if (ctx.repoCheck) {
      const repoWorkDir = path.join(tmp, 'repo-work');
      const repoRes = await ctx.repoChecks.checkOneClickDeploy(ctx.repoRoot, {
        repoCheck: true,
        tempDir: repoWorkDir,
      });
      ctx.assert.equal(repoRes.available, true);
      ctx.assert.equal(repoRes.source, 'repo');
      ctx.assert.equal(repoRes.validation.ok, true, repoRes.validation.errors.join('; '));
      ctx.assert.equal(repoRes.runResult.exitCode, 0, repoRes.runResult.stderr);
      ctx.assert.equal(repoRes.runResult.envMode, 0o600);
    }
  });

  test('T1-F07-03', 'Auto-secret generation (ROKBOT_*_SECRET=) & secret-leak-free idempotent re-run', async (t) => {
    const tmp = await t.createTempDir('t1-f07-03-');
    const fixtureDir = path.join(tmp, 'fixture');
    const workDir = path.join(tmp, 'work');
    const bundle = await writeSyntheticDeployBundle(fixtureDir, { includeEmptySecret: true });

    const run1 = await ctx.repoChecks.runInstallImagesPrepareOnly({
      workDir,
      scriptPath: bundle.scriptPath,
      composePath: bundle.composePath,
      envExamplePath: bundle.envExamplePath,
      args: ['--prepare-only', '--offline'],
    });
    ctx.assert.equal(run1.exitCode, 0, run1.stderr);
    ctx.assert.equal(run1.envMode, 0o600);
    ctx.assert.equal(run1.parsedEnv.ROKBOT_BOX_TOKEN, 'local');
    ctx.assert.match(run1.parsedEnv.ROKBOT_INTERNAL_SECRET, /^[0-9a-f]{48}$/);
    ctx.assert.ok(run1.generatedSecretsCount >= 1);

    const run2 = await ctx.repoChecks.runInstallImagesPrepareOnly({
      workDir,
      scriptPath: bundle.scriptPath,
      composePath: bundle.composePath,
      envExamplePath: bundle.envExamplePath,
      args: ['--prepare-only', '--offline'],
    });
    ctx.assert.equal(run2.exitCode, 0, run2.stderr);
    ctx.assert.equal(run2.envMode, 0o600);
    ctx.assert.equal(run2.parsedEnv.ROKBOT_INTERNAL_SECRET, run1.parsedEnv.ROKBOT_INTERNAL_SECRET);

    if (ctx.repoCheck) {
      const realWorkDir = path.join(tmp, 'repo-work');
      const realFixtureEnv = path.join(tmp, 'repo-env-example');
      await writeFile(realFixtureEnv, buildCompliantEnvExample({ includeEmptySecret: true }), 'utf8');
      const releaseDir = path.join(ctx.repoRoot, 'host', 'release');
      const realRun1 = await ctx.repoChecks.runInstallImagesPrepareOnly({
        workDir: realWorkDir,
        scriptPath: path.join(releaseDir, 'install-images.sh'),
        composePath: path.join(releaseDir, 'docker-compose.images.yml'),
        envExamplePath: realFixtureEnv,
        args: ['--prepare-only', '--offline'],
      });
      ctx.assert.equal(realRun1.exitCode, 0, realRun1.stderr);
      ctx.assert.equal(realRun1.envMode, 0o600);
      ctx.assert.equal(realRun1.parsedEnv.ROKBOT_BOX_TOKEN, 'local');
      ctx.assert.match(realRun1.parsedEnv.ROKBOT_INTERNAL_SECRET, /^[0-9a-f]{48}$/);
      ctx.assert.ok(realRun1.generatedSecretsCount >= 1);

      const realRun2 = await ctx.repoChecks.runInstallImagesPrepareOnly({
        workDir: realWorkDir,
        scriptPath: path.join(releaseDir, 'install-images.sh'),
        composePath: path.join(releaseDir, 'docker-compose.images.yml'),
        envExamplePath: realFixtureEnv,
        args: ['--prepare-only', '--offline'],
      });
      ctx.assert.equal(realRun2.exitCode, 0, realRun2.stderr);
      ctx.assert.equal(realRun2.envMode, 0o600);
      ctx.assert.equal(realRun2.parsedEnv.ROKBOT_INTERNAL_SECRET, realRun1.parsedEnv.ROKBOT_INTERNAL_SECRET);
    }
  });

  test('T1-F07-04', 'ROKBOT_DOWNLOAD_BASE=file://... mirror fetch retrieves Compose & env example without --offline', async (t) => {
    const tmp = await t.createTempDir('t1-f07-04-');
    const mirrorDir = path.join(tmp, 'mirror');
    const workDir = path.join(tmp, 'work');
    await mkdir(mirrorDir, { recursive: true });
    await mkdir(workDir, { recursive: true });

    const mirrorCompose = buildCompliantComposeYaml() + '# mirror-marker-v1\n';
    const mirrorEnv = buildCompliantEnvExample() + '# mirror-env-v1\n';
    await writeFile(path.join(mirrorDir, 'docker-compose.images.yml'), mirrorCompose, 'utf8');
    await writeFile(path.join(mirrorDir, '.env.images.example'), mirrorEnv, 'utf8');

    const scriptSrc = ctx.repoCheck
      ? path.join(ctx.repoRoot, 'host', 'release', 'install-images.sh')
      : (await writeSyntheticDeployBundle(path.join(tmp, 'seed'))).scriptPath;

    const targetScript = path.join(workDir, 'install-images.sh');
    await copyFile(scriptSrc, targetScript);
    await chmod(targetScript, 0o755);

    const binDir = path.join(workDir, '_bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(binDir, 'docker'),
      '#!/usr/bin/env bash\nif [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then echo "Docker Compose v5"; exit 0; fi\nif [[ "${1:-}" == "compose" ]]; then\n  for a in "$@"; do\n    if [[ "$a" == "--environment" ]]; then grep -E "^[A-Za-z_][A-Za-z0-9_]*=" .env || true; exit 0; fi\n  done\n  exit 0\nfi\nexit 0\n',
      { mode: 0o755 },
    );
    await chmod(path.join(binDir, 'docker'), 0o755);

    const res = await spawnAsync('bash', [targetScript, '--prepare-only'], {
      cwd: workDir,
      env: {
        HOME: workDir,
        PATH: `${binDir}:${process.env.PATH || '/usr/bin:/bin'}`,
        TERM: 'dumb',
        ROKBOT_DOWNLOAD_BASE: `file://${mirrorDir}`,
      },
      encoding: 'utf8',
    });
    ctx.assert.equal(res.status, 0, res.stderr);
    ctx.assert.equal(
      await ctx.cryptoDelta.sha256File(path.join(workDir, 'docker-compose.images.yml')),
      ctx.cryptoDelta.sha256Hex(mirrorCompose),
    );
    ctx.assert.equal(
      await ctx.cryptoDelta.sha256File(path.join(workDir, '.env.images.example')),
      ctx.cryptoDelta.sha256Hex(mirrorEnv),
    );
  });

  test('T1-F07-05', '--local flag copies files from SCRIPT_DIR when PWD != SCRIPT_DIR and handles override file', async (t) => {
    const tmp = await t.createTempDir('t1-f07-05-');
    const srcDir = path.join(tmp, 'src');
    const runDir = path.join(tmp, 'run');
    await mkdir(srcDir, { recursive: true });
    await mkdir(runDir, { recursive: true });

    await writeSyntheticDeployBundle(srcDir);
    if (ctx.repoCheck) {
      const releaseDir = path.join(ctx.repoRoot, 'host', 'release');
      await copyFile(path.join(releaseDir, 'install-images.sh'), path.join(srcDir, 'install-images.sh'));
      await copyFile(path.join(releaseDir, 'docker-compose.images.yml'), path.join(srcDir, 'docker-compose.images.yml'));
      await copyFile(path.join(releaseDir, '.env.images.example'), path.join(srcDir, '.env.images.example'));
      await chmod(path.join(srcDir, 'install-images.sh'), 0o755);
    }

    await writeFile(path.join(runDir, 'docker-compose.override.yml'), 'services:\n  host:\n    environment:\n      TZ: UTC\n', 'utf8');

    const binDir = path.join(tmp, '_bin');
    await mkdir(binDir, { recursive: true });
    const dockerArgsLog = path.join(runDir, 'docker-args.log');
    await writeFile(
      path.join(binDir, 'docker'),
      `#!/usr/bin/env bash\necho "$*" >> "${dockerArgsLog}"\nif [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then echo "Docker Compose v5"; exit 0; fi\nfor a in "$@"; do\n  if [[ "$a" == "--environment" ]]; then grep -E "^[A-Za-z_][A-Za-z0-9_]*=" .env || true; exit 0; fi\ndone\nexit 0\n`,
      { mode: 0o755 },
    );
    await chmod(path.join(binDir, 'docker'), 0o755);

    const res = await spawnAsync('bash', [path.join(srcDir, 'install-images.sh'), '--prepare-only', '--local'], {
      cwd: runDir,
      env: {
        HOME: runDir,
        PATH: `${binDir}:${process.env.PATH || '/usr/bin:/bin'}`,
        TERM: 'dumb',
      },
      encoding: 'utf8',
    });
    ctx.assert.equal(res.status, 0, res.stderr);
    ctx.assert.equal(existsSync(path.join(runDir, 'docker-compose.images.yml')), true);
    ctx.assert.equal(existsSync(path.join(runDir, '.env.images.example')), true);
    ctx.assert.equal((await stat(path.join(runDir, '.env'))).mode & 0o777, 0o600);
    const argsLog = await readFile(dockerArgsLog, 'utf8');
    ctx.assert.ok(argsLog.includes('docker-compose.override.yml'));
  });

  test('T1-F07-06', 'Proxy env parsing (HTTP_PROXY -> http_proxy sync, quote/comment safe) & onboarding URLs', async (t) => {
    const tmp = await t.createTempDir('t1-f07-06-');
    const workDir = path.join(tmp, 'work');
    await mkdir(workDir, { recursive: true });
    const bundle = await writeSyntheticDeployBundle(path.join(tmp, 'seed'));
    const scriptSrc = ctx.repoCheck
      ? path.join(ctx.repoRoot, 'host', 'release', 'install-images.sh')
      : bundle.scriptPath;
    const composeSrc = ctx.repoCheck
      ? path.join(ctx.repoRoot, 'host', 'release', 'docker-compose.images.yml')
      : bundle.composePath;
    const envSrc = ctx.repoCheck
      ? path.join(ctx.repoRoot, 'host', 'release', '.env.images.example')
      : bundle.envExamplePath;

    await copyFile(scriptSrc, path.join(workDir, 'install-images.sh'));
    await chmod(path.join(workDir, 'install-images.sh'), 0o755);
    await copyFile(composeSrc, path.join(workDir, 'docker-compose.images.yml'));
    await copyFile(envSrc, path.join(workDir, '.env.images.example'));

    const preEnv = [
      buildCompliantEnvExample(),
      'HTTP_PROXY="http://127.0.0.1:7890" # inline comment',
      "NO_PROXY='localhost,127.0.0.1,box,host'",
    ].join('\n') + '\n';
    await writeFile(path.join(workDir, '.env'), preEnv, { mode: 0o600 });
    await chmod(path.join(workDir, '.env'), 0o600);

    const binDir = path.join(workDir, '_bin');
    await mkdir(binDir, { recursive: true });
    const proxySnapPath = path.join(workDir, 'proxy-snap.txt');
    await writeFile(
      path.join(binDir, 'docker'),
      `#!/usr/bin/env bash\nif [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then echo "Docker Compose v5"; exit 0; fi\nfor a in "$@"; do\n  if [[ "$a" == "--environment" ]]; then grep -E "^[A-Za-z_][A-Za-z0-9_]*=" .env || true; exit 0; fi\ndone\nprintf 'http_proxy=%s\\nno_proxy=%s\\n' "\${http_proxy:-}" "\${no_proxy:-}" > "${proxySnapPath}"\nexit 0\n`,
      { mode: 0o755 },
    );
    await chmod(path.join(binDir, 'docker'), 0o755);

    const res = await spawnAsync('bash', [path.join(workDir, 'install-images.sh'), '--offline'], {
      cwd: workDir,
      env: {
        HOME: workDir,
        PATH: `${binDir}:${process.env.PATH || '/usr/bin:/bin'}`,
        TERM: 'dumb',
      },
      encoding: 'utf8',
    });
    ctx.assert.equal(res.status, 0, res.stderr);
    const snap = parseSimpleEnv(await readFile(proxySnapPath, 'utf8'));
    ctx.assert.equal(snap.http_proxy, 'http://127.0.0.1:7890');
    ctx.assert.equal(snap.no_proxy, 'localhost,127.0.0.1,box,host');
    ctx.assert.ok(res.stdout.includes('/admin'));
    ctx.assert.ok(res.stdout.includes('view=devices'));
    ctx.assert.ok(res.stdout.includes('view=model'));
    ctx.assert.ok(res.stdout.includes('view=updates'));
    ctx.assert.assertNoSecrets(res.stdout + '\n' + res.stderr, [], { label: 'install-images.sh stdout' });
  });
}

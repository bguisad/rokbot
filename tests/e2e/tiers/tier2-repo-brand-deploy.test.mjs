import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

export const tier = 2;
export const name = 'tier2-repo-brand-deploy';

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

// ---------------------------------------------------------------------------
// Self-Contained Synthetic Fixture Builders (Zero External Dependencies)
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
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
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function buildSyntheticPng(width, height, colorType = 6) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType; // 6 = RGBA, 2 = RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const bpp = colorType === 6 ? 4 : 3;
  const rawScanlines = Buffer.alloc(height * (1 + width * bpp), 0x20);
  for (let y = 0; y < height; y++) {
    rawScanlines[y * (1 + width * bpp)] = 0; // filter None
  }
  const idat = deflateSync(rawScanlines);
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
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

  for (const s of sizes) {
    const png = buildSyntheticPng(s, s, 6);
    const entry = Buffer.alloc(16);
    entry[0] = s >= 256 ? 0 : s;
    entry[1] = s >= 256 ? 0 : s;
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

function buildSyntheticIcns(chunksSpec = [
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
]) {
  const chunks = [];
  let totalLength = 8;
  for (const spec of chunksSpec) {
    const payload = buildSyntheticPng(spec.size, spec.size, 6);
    const chunkLen = 8 + payload.length;
    const ch = Buffer.alloc(8);
    ch.write(spec.type, 0, 4, 'ascii');
    ch.writeUInt32BE(chunkLen, 4);
    chunks.push(ch, payload);
    totalLength += chunkLen;
  }
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(totalLength, 4);
  return Buffer.concat([head, ...chunks]);
}

function canonicalSvgText() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
    '  <path class="brand-face" d="M 200 300 C 220 180 340 160 512 160 C 684 160 804 180 824 300 C 844 500 760 820 512 840 C 264 820 180 500 200 300 Z" fill="#1e2430"/>',
    '  <rect class="brand-eye" x="340" y="420" width="90" height="336" rx="45" transform="rotate(-26 385 588)" fill="#f8fafc"/>',
    '  <rect class="brand-eye" x="590" y="440" width="90" height="268" rx="45" transform="rotate(-26 635 574)" fill="#f8fafc"/>',
    '  <circle class="brand-accent" cx="512" cy="230" r="36" fill="#38bdf8"/>',
    '</svg>',
    '',
  ].join('\n');
}

function faviconSvgText() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
    '  <style>@media (prefers-color-scheme: dark) { .brand-face { fill: #f8fafc; } }</style>',
    '  <path class="brand-face" d="M 200 300 C 220 180 340 160 512 160 C 684 160 804 180 824 300 C 844 500 760 820 512 840 C 264 820 180 500 200 300 Z"/>',
    '  <circle class="brand-accent" cx="512" cy="230" r="36"/>',
    '</svg>',
    '',
  ].join('\n');
}

async function buildSyntheticLogoSuite(rootDir, cryptoDelta) {
  const writeAsset = async (rel, buf) => {
    const full = path.join(rootDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buf);
    return cryptoDelta.sha256Hex(buf);
  };

  const masterSvg = canonicalSvgText();
  await writeAsset('assets/logo/rokbot-logo.svg', Buffer.from(masterSvg, 'utf8'));
  await writeAsset('host/server/public/favicon.svg', Buffer.from(faviconSvgText(), 'utf8'));

  const hostIconBuf = buildSyntheticPng(512, 512, 6);
  const hostIconSha = await writeAsset('host/server/public/rokbot-icon.png', hostIconBuf);

  const pngSizes = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
  const pngManifest = [];
  for (const s of pngSizes) {
    const rel = `assets/logo/rokbot-icon-${s}.png`;
    const buf = buildSyntheticPng(s, s, 6);
    const sha256 = await writeAsset(rel, buf);
    pngManifest.push({ path: rel, width: s, height: s, sha256 });
  }

  const androidDensities = [
    { density: 'mdpi', base: 48, fg: 108 },
    { density: 'hdpi', base: 72, fg: 162 },
    { density: 'xhdpi', base: 96, fg: 216 },
    { density: 'xxhdpi', base: 144, fg: 324 },
    { density: 'xxxhdpi', base: 192, fg: 432 },
  ];
  const androidManifest = [];
  for (const d of androidDensities) {
    for (const [kind, dim] of [
      ['ic_launcher.png', d.base],
      ['ic_launcher_round.png', d.base],
      ['ic_launcher_foreground.png', d.fg],
    ]) {
      const rel = `assets/logo/android/mipmap-${d.density}/${kind}`;
      const buf = buildSyntheticPng(dim, dim, 6);
      const sha256 = await writeAsset(rel, buf);
      androidManifest.push({ path: rel, width: dim, height: dim, sha256 });
    }
  }

  const iosSizes = [120, 152, 167, 180, 1024];
  const iosManifest = [];
  for (const s of iosSizes) {
    const rel = `assets/logo/ios/AppIcon-${s}.png`;
    const buf = buildSyntheticPng(s, s, 2);
    const sha256 = await writeAsset(rel, buf);
    iosManifest.push({ path: rel, width: s, height: s, hasAlpha: false, sha256 });
  }

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuf = buildSyntheticIco(icoSizes);
  const icoSha = await writeAsset('assets/logo/rokbot.ico', icoBuf);

  const icnsBuf = buildSyntheticIcns();
  const icnsSha = await writeAsset('assets/logo/rokbot.icns', icnsBuf);

  const manifest = {
    schema: 'rokbot-logo-manifest/v1',
    masterSvg: 'assets/logo/rokbot-logo.svg',
    hostIcon: { path: 'host/server/public/rokbot-icon.png', width: 512, height: 512, sha256: hostIconSha },
    png: pngManifest,
    android: androidManifest,
    ios: iosManifest,
    ico: { path: 'assets/logo/rokbot.ico', sizes: icoSizes, sha256: icoSha },
    icns: { path: 'assets/logo/rokbot.icns', sha256: icnsSha },
  };
  await writeAsset('assets/logo/manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  return manifest;
}

const VALID_COMPOSE_YML = [
  'name: rokbot',
  'services:',
  '  host:',
  '    image: ${ROKBOT_HOST_IMAGE:-ghcr.io/hongfaqiu/rokbot/host:latest}',
  '    ports:',
  '      - "127.0.0.1:${ROKBOT_PUBLIC_PORT:-18080}:8000"',
  '    environment:',
  '      ROKBOT_BOX_TOKEN: ${ROKBOT_BOX_TOKEN:-local}',
  '      ROKBOT_DEFAULT_MACHINE_ID: ${ROKBOT_DEFAULT_MACHINE_ID:-}',
  '    healthcheck:',
  '      test: ["CMD", "/exec-daemon/node", "deploy/healthcheck.mjs"]',
  '  box:',
  '    image: ${ROKBOT_BOX_IMAGE:-ghcr.io/hongfaqiu/rokbot/box:2bb5e41}',
  '',
].join('\n');

const VALID_ENV_EXAMPLE = [
  'ROKBOT_LISTEN_ADDRESS=127.0.0.1',
  'ROKBOT_PUBLIC_PORT=18080',
  'ROKBOT_HOST_IMAGE=ghcr.io/hongfaqiu/rokbot/host:latest',
  'ROKBOT_BOX_IMAGE=ghcr.io/hongfaqiu/rokbot/box:2bb5e41',
  'ROKBOT_BOX_TOKEN=local',
  '',
].join('\n');

const SYNTHETIC_INSTALL_SCRIPT = [
  '#!/usr/bin/env bash',
  'set -Eeuo pipefail',
  'SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
  'COMPOSE_FILE="docker-compose.images.yml"',
  'ENV_EXAMPLE=".env.images.example"',
  'ENV_FILE=".env"',
  'prepare_only=false; skip_existing=false; pull_never=false; offline=false',
  'for arg in "$@"; do',
  '  case "$arg" in',
  '    --prepare-only) prepare_only=true ;;',
  '    --local) skip_existing=true ;;',
  '    --pull-never) pull_never=true ;;',
  '    --offline) skip_existing=true; pull_never=true; offline=true ;;',
  '    -h|--help) echo "Usage: install-images.sh"; exit 0 ;;',
  '    *) echo "Unknown option: $arg" >&2; exit 2 ;;',
  '  esac',
  'done',
  'DOWNLOAD_BASE="${ROKBOT_DOWNLOAD_BASE:-https://raw.githubusercontent.com/hongfaqiu/rokbot/main/host/release}"',
  'case "$DOWNLOAD_BASE" in',
  '  https://*|file://*) ;;',
  '  *) echo "RokBot setup failed: ROKBOT_DOWNLOAD_BASE must use https:// or file://." >&2; exit 1 ;;',
  'esac',
  'fail() { echo "RokBot setup failed: $*" >&2; exit 1; }',
  'if [[ "$offline" == true ]]; then',
  '  for f in "$COMPOSE_FILE" "$ENV_EXAMPLE"; do',
  '    if [[ ! -f "$f" && ( "$SCRIPT_DIR" == "$PWD" || ! -f "${SCRIPT_DIR}/${f}" ) ]]; then',
  '      fail "--offline requires local ${f}; copy it into the working directory first."',
  '    fi',
  '  done',
  'fi',
  'command -v docker >/dev/null 2>&1 || fail "\'docker\' is required."',
  'docker compose version >/dev/null 2>&1 || fail "the Docker Compose plugin is required."',
  'strip_env() {',
  '  local raw="${1%$\'\\r\'}" i c quote="" out=""',
  '  for ((i=0; i<${#raw}; i++)); do',
  '    c="${raw:i:1}"',
  '    if [[ -n "$quote" ]]; then',
  '      out+="$c"; [[ "$c" == "$quote" ]] && quote=""',
  '    elif [[ "$c" == "\'" || "$c" == \'"\' ]]; then',
  '      quote="$c"; out+="$c"',
  '    elif [[ "$c" == "#" ]]; then',
  '      break',
  '    else',
  '      out+="$c"',
  '    fi',
  '  done',
  '  printf "%s" "$out"',
  '}',
  'unquote_env() {',
  '  local v="$1"',
  '  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"',
  '  if (( ${#v} >= 2 )) && [[ ( "${v:0:1}" == \'"\' && "${v: -1}" == \'"\' ) || ( "${v:0:1}" == "\'" && "${v: -1}" == "\'" ) ]]; then',
  '    v="${v:1:${#v}-2}"',
  '  fi',
  '  printf "%s" "$v"',
  '}',
  'if [[ -f "$ENV_FILE" ]]; then',
  '  while IFS= read -r line || [[ -n "$line" ]]; do',
  '    line=$(strip_env "$line")',
  '    if [[ "$line" =~ ^[[:space:]]*(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)[[:space:]]*=[[:space:]]*(.*)$ ]]; then',
  '      export "${BASH_REMATCH[1]}=$(unquote_env "${BASH_REMATCH[2]}")"',
  '    fi',
  '  done < "$ENV_FILE"',
  'fi',
  'for f in "$COMPOSE_FILE" "$ENV_EXAMPLE"; do',
  '  if [[ "$skip_existing" == true && -e "$f" ]]; then true',
  '  elif [[ "$skip_existing" == true && -f "${SCRIPT_DIR}/${f}" ]]; then cp -- "${SCRIPT_DIR}/${f}" "$f"',
  '  elif [[ "$offline" == true ]]; then fail "--offline cannot download ${f}"',
  '  else curl -fsSL "${DOWNLOAD_BASE}/${f}" -o "$f"; fi',
  'done',
  'if [[ ! -e "$ENV_FILE" ]]; then',
  '  umask 077',
  '  cp "$ENV_EXAMPLE" "$ENV_FILE"',
  '  chmod 600 "$ENV_FILE"',
  'fi',
  'if ! docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --environment | grep -Eq "^ROKBOT_BOX_TOKEN=.+$"; then',
  '  fail "set every required secret in .env to a non-empty value."',
  'fi',
  'if [[ "$prepare_only" == true ]]; then',
  '  echo "RokBot files are ready. Edit .env, then run: bash install-images.sh"',
  '  exit 0',
  'fi',
  '',
].join('\n');

async function resolveDeployScripts(ctx, tmpDir) {
  const realScript = path.join(ctx.repoRoot, 'host/release/install-images.sh');
  const realCompose = path.join(ctx.repoRoot, 'host/release/docker-compose.images.yml');
  const realEnv = path.join(ctx.repoRoot, 'host/release/.env.images.example');
  if (ctx.repoCheck && existsSync(realScript) && existsSync(realCompose) && existsSync(realEnv)) {
    return { scriptPath: realScript, composePath: realCompose, envExamplePath: realEnv };
  }
  const dir = path.join(tmpDir, 'deploy-src');
  await mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, 'install-images.sh');
  const composePath = path.join(dir, 'docker-compose.images.yml');
  const envExamplePath = path.join(dir, '.env.images.example');
  await writeFile(scriptPath, SYNTHETIC_INSTALL_SCRIPT, { mode: 0o755 });
  await writeFile(composePath, VALID_COMPOSE_YML, 'utf8');
  await writeFile(envExamplePath, VALID_ENV_EXAMPLE, 'utf8');
  return { scriptPath, composePath, envExamplePath };
}

async function createFakeDockerBin(binDir, { failComposeVersion = false, emptyBoxToken = false } = {}) {
  await mkdir(binDir, { recursive: true });
  const dockerPath = path.join(binDir, 'docker');
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then',
    failComposeVersion ? '  exit 1' : '  echo "Docker Compose version v5.1.3"; exit 0',
    'fi',
    'if [[ "${1:-}" == "compose" ]]; then',
    '  env_file=""; want_env=0; shift',
    '  while [[ $# -gt 0 ]]; do',
    '    case "$1" in',
    '      --env-file) env_file="${2:-}"; shift 2 ;;',
    '      --environment) want_env=1; shift ;;',
    '      *) shift ;;',
    '    esac',
    '  done',
    '  if [[ "$want_env" == "1" ]]; then',
    emptyBoxToken
      ? '    echo "ROKBOT_BOX_TOKEN="; exit 0'
      : '    if [[ -n "$env_file" && -f "$env_file" ]]; then grep -E "^[A-Za-z_][A-Za-z0-9_]*=" "$env_file" || true; fi; exit 0',
    '  fi',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ];
  await writeFile(dockerPath, lines.join('\n'), { mode: 0o755 });
  await chmod(dockerPath, 0o755);
  return binDir;
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

// ---------------------------------------------------------------------------
// Tier 2 Tests: F1, F2, F3, F7 (26 tests)
// ---------------------------------------------------------------------------

export function registerTests(test, ctx) {
  // =========================================================================
  // Feature F1 — Legacy Decoupling & Path Fixes (T2-F01-01 .. T2-F01-06)
  // =========================================================================

  test('T2-F01-01', 'Reject hardcoded hex ROKBOT_DEFAULT_MACHINE_ID in Compose bundle', async () => {
    const badCompose = VALID_COMPOSE_YML.replace(
      'ROKBOT_DEFAULT_MACHINE_ID: ${ROKBOT_DEFAULT_MACHINE_ID:-}',
      'ROKBOT_DEFAULT_MACHINE_ID: "a1b2c3d4e5f60718"',
    );
    const res = await ctx.repoChecks.validateImageComposeBundle({
      composeText: badCompose,
      envExampleText: VALID_ENV_EXAMPLE,
      installScriptText: SYNTHETIC_INSTALL_SCRIPT,
    });
    ctx.assert.equal(res.ok, false);
    ctx.assert.ok(
      res.errors.some((e) => e.includes('must not hardcode ROKBOT_DEFAULT_MACHINE_ID')),
      `Unexpected errors: ${res.errors.join('; ')}`,
    );
  });

  test('T2-F01-02', 'Reject implicit localExec when multiple computers exist without ROKBOT_DEFAULT_MACHINE_ID', async (t) => {
    if (!ctx.harness) t.skip('Requires harness fault injection');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await client.adminLogin(ctx.adminPassword);
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);
    const pair = await client.pairWithKey({ pairingKey: keyRes.json.pairingKey, deviceName: 'Exec Tester' });
    ctx.assert.assertStatus(pair, 201);

    ctx.harness.setDefaultMachineId('');
    ctx.harness.setComputers([
      { id: 'machine-a', label: 'Mac A', connected: true, platform: 'darwin', capabilities: ['exec'] },
      { id: 'machine-b', label: 'Win B', connected: true, platform: 'win32', capabilities: ['exec'] },
    ]);

    const res = await client.apiCall('localExec', { command: 'hostname' });
    ctx.assert.assertStatus(res, 409);
    ctx.assert.match(String(res.json?.error || ''), /ROKBOT_DEFAULT_MACHINE_ID|Multiple machines/i);
  });

  test('T2-F01-03', 'Detect deleted legacy android/shell, src/android & android/patchers/supported.json refs', async (t) => {
    const tmp = await t.createTempDir('f01-legacy-ref-');
    const badWebPatcher = path.join(tmp, 'web-patch.mjs');
    const badCiCheck = path.join(tmp, 'check-inputs.mjs');
    await writeFile(badWebPatcher, "import { buildWeb } from '../src/android/web.mjs';\nconst s = 'android/shell/index.html';\n");
    await writeFile(badCiCheck, "const manifestPath = 'android/patchers/supported.json';\n");

    const LEGACY_RE = /(?:src\/android\/|android\/shell\/|android\/patchers\/(?:supported\.json|patch\.mjs))/;
    for (const p of [badWebPatcher, badCiCheck]) {
      const content = await readFile(p, 'utf8');
      ctx.assert.ok(LEGACY_RE.test(content), `Expected legacy reference detection in ${path.basename(p)}`);
    }

    if (ctx.repoCheck) {
      for (const rel of ['web/patchers/patch.mjs', 'ci/check-inputs.mjs', 'android/tests/m2-m5-features.test.mjs']) {
        const full = path.join(ctx.repoRoot, rel);
        ctx.assert.ok(existsSync(full), `Missing expected file ${rel}`);
        const txt = await readFile(full, 'utf8');
        ctx.assert.equal(LEGACY_RE.test(txt), false, `${rel} must not reference deleted legacy android paths`);
      }
    }
  });

  test('T2-F01-04', 'Reject duplicate resource targets or non-.gz patch paths in android/recipes/manifest.json fixture', async (t) => {
    const tmp = await t.createTempDir('f01-recipe-');
    const validateAndroidRecipe = (manifest) => {
      const errors = [];
      if (manifest.schema !== 'rokbot-android-native/v1') errors.push('Unexpected schema');
      const seenTargets = new Set();
      for (const r of manifest.resources ?? []) {
        if (seenTargets.has(r.target)) errors.push(`Duplicate target: ${r.target}`);
        seenTargets.add(r.target);
        if (!String(r.patch || '').endsWith('.gz')) errors.push(`Invalid non-.gz patch: ${r.patch}`);
      }
      return { ok: errors.length === 0, errors };
    };

    const badManifest = {
      schema: 'rokbot-android-native/v1',
      version: '1.16.0',
      resources: [
        { target: 'assets/index.android.bundle', patch: 'patches/bundle.gbp.gz' },
        { target: 'assets/index.android.bundle', patch: 'patches/override.bin' },
      ],
    };
    const manifestPath = path.join(tmp, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(badManifest), 'utf8');
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    const res = validateAndroidRecipe(parsed);
    ctx.assert.equal(res.ok, false);
    ctx.assert.ok(res.errors.some((e) => e.includes('Duplicate target')));
    ctx.assert.ok(res.errors.some((e) => e.includes('Invalid non-.gz patch')));

    if (ctx.repoCheck) {
      const realPath = path.join(ctx.repoRoot, 'android/recipes/manifest.json');
      ctx.assert.ok(existsSync(realPath), 'android/recipes/manifest.json must exist');
      const realRes = validateAndroidRecipe(JSON.parse(await readFile(realPath, 'utf8')));
      ctx.assert.equal(realRes.ok, true, realRes.errors.join('; '));
    }
  });

  test('T2-F01-05', 'Reject RSA, non-P256 EC (P-384), empty & malformed public keys in ECDSA normalization', async () => {
    const rsaPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaSpkiPem = rsaPair.publicKey.export({ type: 'spki', format: 'pem' });
    const p384Pair = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const p384SpkiB64 = p384Pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    ctx.assert.throws(() => ctx.cryptoDelta.normalizeEcPublicKey(''), /cannot be empty/i);
    ctx.assert.throws(() => ctx.cryptoDelta.normalizeEcPublicKey('   '), /cannot be empty/i);
    ctx.assert.throws(() => ctx.cryptoDelta.normalizeEcPublicKey(rsaSpkiPem), /prime256v1/i);
    ctx.assert.throws(() => ctx.cryptoDelta.normalizeEcPublicKey(p384SpkiB64), /prime256v1/i);
    ctx.assert.throws(() => ctx.cryptoDelta.normalizeEcPublicKey('bm90LWEta2V5'));
  });

  test('T2-F01-06', 'Reject missing cross-module Web/Desktop asset paths in bundle completeness check', async (t) => {
    const tmp = await t.createTempDir('f01-assets-');
    await mkdir(path.join(tmp, 'assets/logo'), { recursive: true });
    await mkdir(path.join(tmp, 'mac/clients/desktop'), { recursive: true });
    await writeFile(path.join(tmp, 'assets/logo/rokbot-icon-256.png'), buildSyntheticPng(256, 256, 6));
    // Intentionally omit assets/logo/rokbot-icon-512.png and mac/clients/desktop/workspace.css

    const requiredAssets = [
      'assets/logo/rokbot-icon-256.png',
      'assets/logo/rokbot-icon-512.png',
      'mac/clients/desktop/workspace.css',
    ];
    const missing = requiredAssets.filter((rel) => !existsSync(path.join(tmp, rel)));
    ctx.assert.deepEqual(missing, [
      'assets/logo/rokbot-icon-512.png',
      'mac/clients/desktop/workspace.css',
    ]);

    if (ctx.repoCheck) {
      const repoMissing = requiredAssets.filter((rel) => !existsSync(path.join(ctx.repoRoot, rel)));
      ctx.assert.deepEqual(repoMissing, [], `Missing repo assets: ${repoMissing.join(', ')}`);
    }
  });

  // =========================================================================
  // Feature F2 — Custom Deformed RokBot Logo (T2-F02-01 .. T2-F02-06)
  // =========================================================================

  test('T2-F02-01', 'Reject SVG lacking deformed asymmetric tilted eyes or cubic Bezier brand-face', async (t) => {
    const symmetricEyesSvg = canonicalSvgText().replace('height="268"', 'height="336"');
    const symInfo = ctx.repoChecks.inspectSvg(symmetricEyesSvg);
    ctx.assert.equal(symInfo.hasAsymmetricEyes, false);

    const untiltedEyesSvg = canonicalSvgText().replace(/rotate\(-26/g, 'rotate(0');
    const untiltedInfo = ctx.repoChecks.inspectSvg(untiltedEyesSvg);
    ctx.assert.equal(untiltedInfo.hasTiltedEyes, false);

    const flatFaceSvg = canonicalSvgText().replace(
      /d="[^"]+"/,
      'd="M 200 200 C 300 200 700 200 800 200 L 800 800 L 200 800 Z"',
    );
    const flatInfo = ctx.repoChecks.inspectSvg(flatFaceSvg);
    ctx.assert.equal(flatInfo.hasBrandFace, false);
    ctx.assert.ok(flatInfo.bezierSegmentCount < 4);

    const tmp = await t.createTempDir('f02-badsvg-');
    await buildSyntheticLogoSuite(tmp, ctx.cryptoDelta);
    await writeFile(path.join(tmp, 'assets/logo/rokbot-logo.svg'), symmetricEyesSvg, 'utf8');
    const suiteRes = ctx.repoChecks.verifyLogoSuite(tmp);
    ctx.assert.equal(suiteRes.ok, false);
    ctx.assert.ok(suiteRes.errors.some((e) => e.includes('deformed geometry')));
  });

  test('T2-F02-02', 'Reject non-PNG magic, truncated PNG, 0x0 IHDR dimensions, and missing IEND chunk', async () => {
    ctx.assert.throws(() => ctx.repoChecks.inspectPng(Buffer.from('JFIF not a png '.repeat(4))), /Invalid PNG signature/);
    ctx.assert.throws(() => ctx.repoChecks.inspectPng(Buffer.alloc(20, 0x89)), /PNG too short/);

    const validPng = buildSyntheticPng(16, 16, 6);
    // Zero width in IHDR (offset 16..20)
    const zeroDim = Buffer.from(validPng);
    zeroDim.writeUInt32BE(0, 16);
    ctx.assert.throws(() => ctx.repoChecks.inspectPng(zeroDim), /Invalid PNG dimensions/);

    // Strip IEND chunk (last 12 bytes)
    const noIend = validPng.subarray(0, validPng.length - 12);
    ctx.assert.throws(() => ctx.repoChecks.inspectPng(noIend), /PNG missing IEND chunk/);
  });

  test('T2-F02-03', 'Reject missing Android mipmap asset or tampered PNG SHA-256 in verifyLogoSuite', async (t) => {
    const tmp = await t.createTempDir('f02-tamper-');
    await buildSyntheticLogoSuite(tmp, ctx.cryptoDelta);

    await rm(path.join(tmp, 'assets/logo/android/mipmap-xxhdpi/ic_launcher_foreground.png'));
    const p256 = path.join(tmp, 'assets/logo/rokbot-icon-256.png');
    const raw256 = await readFile(p256);
    // Append harmless trailing byte after IEND so PNG parses cleanly yet SHA-256 mismatches manifest
    await writeFile(p256, Buffer.concat([raw256, Buffer.from([0x00])]));

    const res = ctx.repoChecks.verifyLogoSuite(tmp);
    ctx.assert.equal(res.ok, false);
    ctx.assert.ok(res.errors.some((e) => e.includes('Missing PNG asset: assets/logo/android/mipmap-xxhdpi/ic_launcher_foreground.png')));
    ctx.assert.ok(res.errors.some((e) => e.includes('assets/logo/rokbot-icon-256.png SHA-256 mismatch')));
  });

  test('T2-F02-04', 'Reject iOS AppIcon PNG carrying alpha channel (colorType 6) or hasAlpha !== false', async (t) => {
    const tmp = await t.createTempDir('f02-ios-alpha-');
    await buildSyntheticLogoSuite(tmp, ctx.cryptoDelta);

    // Replace opaque RGB AppIcon-1024.png with RGBA (colorType 6) PNG
    const rgba1024 = buildSyntheticPng(1024, 1024, 6);
    await writeFile(path.join(tmp, 'assets/logo/ios/AppIcon-1024.png'), rgba1024);

    // Also set hasAlpha: true on another entry in manifest
    const manifestPath = path.join(tmp, 'assets/logo/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.ios[0].hasAlpha = true;
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const res = ctx.repoChecks.verifyLogoSuite(tmp);
    ctx.assert.equal(res.ok, false);
    ctx.assert.ok(res.errors.some((e) => e.includes('colorType mismatch: 6 vs 2')));
    ctx.assert.ok(res.errors.some((e) => e.includes('must have hasAlpha=false')));
  });

  test('T2-F02-05', 'Reject .ico with directory-vs-PNG dimension mismatch or out-of-bounds payload offset', async () => {
    const goodIco = buildSyntheticIco([16]);
    // Claim 32x32 in directory entry 0 while embedded PNG IHDR is 16x16
    const dimMismatch = Buffer.from(goodIco);
    dimMismatch[6] = 32;
    dimMismatch[7] = 32;
    ctx.assert.throws(() => ctx.repoChecks.inspectIco(dimMismatch), /PNG size mismatch/);

    // Point entry 0 offset past EOF
    const oobIco = Buffer.from(goodIco);
    oobIco.writeUInt32LE(oobIco.length + 100, 6 + 12);
    ctx.assert.throws(() => ctx.repoChecks.inspectIco(oobIco), /payload out of bounds/);
  });

  test('T2-F02-06', 'Reject .icns with bad magic, totalLength mismatch, or nominalSize dimension mismatch', async (t) => {
    const goodIcns = buildSyntheticIcns([{ type: 'ic08', size: 256 }]);
    const badMagic = Buffer.from(goodIcns);
    badMagic.write('fake', 0, 4, 'ascii');
    ctx.assert.throws(() => ctx.repoChecks.inspectIcns(badMagic), /Invalid ICNS magic/);

    const badLen = Buffer.from(goodIcns);
    badLen.writeUInt32BE(badLen.length + 16, 4);
    ctx.assert.throws(() => ctx.repoChecks.inspectIcns(badLen), /ICNS length header mismatch/);

    // ic08 nominalSize is 256, embed 128x128 PNG
    const tmp = await t.createTempDir('f02-icns-dim-');
    await buildSyntheticLogoSuite(tmp, ctx.cryptoDelta);
    const mismatchIcns = buildSyntheticIcns([{ type: 'ic08', size: 128 }]);
    await writeFile(path.join(tmp, 'assets/logo/rokbot.icns'), mismatchIcns);
    const res = ctx.repoChecks.verifyLogoSuite(tmp);
    ctx.assert.equal(res.ok, false);
    ctx.assert.ok(res.errors.some((e) => e.includes('ICNS chunk ic08 dimension mismatch: 128x128 vs nominalSize 256')));
  });

  // =========================================================================
  // Feature F3 — Full Rebranding & hongfaqiu/rokbot Alignment (T2-F03-01 .. 07)
  // =========================================================================

  test('T2-F03-01', 'Strict rejection of all Category-A legacy tokens with exact line/column/token', async () => {
    const samples = [
      'GROKBOT_PORT=8000',
      'PROKBOT_MODE=1',
      'headers["x-grokbot-csrf"] = "1"',
      'cookie: grokbot_admin=abc',
      'cookie: grokbot_web=xyz',
      'cookie: grokbot_vnc_0=1',
      'applicationId = "dev.grokbot.nativeapp"',
      'bundleId = "dev.grokbot.local"',
      'scheme = "grokbot-local://open"',
      'const cls = "GrokBotLocal";',
    ];
    for (const line of samples) {
      const res = ctx.repoChecks.scanTextForRebranding(line, { filePath: 'sample.txt' });
      ctx.assert.equal(res.ok, false, `Expected Category-A failure for: ${line}`);
      ctx.assert.equal(res.violations[0].line, 1);
      ctx.assert.ok(res.violations[0].column >= 1);
      ctx.assert.ok(res.violations[0].token.length > 0);
    }
  });

  test('T2-F03-02', 'allowAbiCompat: false strictly rejects all JNI/tailcat ABI tokens', async () => {
    const abiTokens = [
      'Java_dev_grokbot_local_TailcatBridge_nativeStart',
      'dev.grokbot.local.TailcatBridge',
      'libgroktailcat.so',
      'libgroktailcatjni.so',
      'GBTailcatIdentity',
    ];
    for (const tok of abiTokens) {
      const denied = ctx.repoChecks.scanTextForRebranding(tok, { allowAbiCompat: false });
      ctx.assert.equal(denied.ok, false, `Expected allowAbiCompat:false to reject ${tok}`);
      const allowed = ctx.repoChecks.scanTextForRebranding(tok, { allowAbiCompat: true });
      ctx.assert.equal(allowed.ok, true, `Expected allowAbiCompat:true to permit ${tok}`);
    }
  });

  test('T2-F03-03', 'allowMigrationBridges: false strictly rejects all 17 migration bridge patterns', async () => {
    const bridges = [
      '${ROKBOT_PORT:-${GROKBOT_PORT:-8000}}',
      '${PROKBOT_MODE:-0}',
      'GROKBOT_RUNTIME_DIR=/opt/rokbot/runtime',
      'cd /opt/grokbot',
      'schema: "grokbot-bytepatch/v1"',
      'schema: "grokbot-volumes/v1"',
      'schema: "grokbot-desktop-update/v1"',
      'schema: "grokbot-android-native-update/v1"',
      'const MAGIC = "GBDELTA1";',
      'const D_MAGIC = "GBD1";',
      '*.gbdelta',
      'file.gbdelta',
      'globalThis.__grokbotPromptPolicy = true',
      'opts.providerOptions?.grokbot',
      'grokbot.clientDeviceId',
      'grokbot-local-update.json',
      'grokbot-local:model-get',
    ];
    ctx.assert.equal(bridges.length, 17);
    for (const pattern of bridges) {
      const denied = ctx.repoChecks.scanTextForRebranding(pattern, { allowMigrationBridges: false });
      ctx.assert.equal(denied.ok, false, `Expected allowMigrationBridges:false to reject: ${pattern}`);
      const allowed = ctx.repoChecks.scanTextForRebranding(pattern, { allowMigrationBridges: true });
      ctx.assert.equal(allowed.ok, true, `Expected allowMigrationBridges:true to allow: ${pattern}`);
    }
  });

  test('T2-F03-04', 'Operational repo URL validator rejects non-hongfaqiu/rokbot GHCR & GitHub URLs', async () => {
    const badUrls = [
      'image: ghcr.io/ferretgeek/rokbot/host:latest',
      'image: ghcr.io/other/app/host:v1',
      'git clone https://github.com/ferretgeek/prokbot-plus',
      'curl https://raw.githubusercontent.com/someone/rokbot/main/install.sh',
      'see https://github.com/ahaduoduoduo/ProkBot',
    ];
    for (const sample of badUrls) {
      const res = ctx.repoChecks.checkOperationalRepoUrls(sample, { allowHistoricalAttribution: false });
      ctx.assert.equal(res.ok, false, `Expected checkOperationalRepoUrls to reject: ${sample}`);
      ctx.assert.ok(res.errors.length >= 1);
    }
  });

  test('T2-F03-05', 'Plain UTF-8 file starting with "MZ" containing a Category-A leak is NOT skipped as PE binary', async (t) => {
    const tmp = await t.createTempDir('f03-mz-leak-');
    await writeFile(path.join(tmp, 'mz-leak.txt'), 'MZ header text\nexport GROKBOT_TOKEN=bad\n', 'utf8');
    const res = await ctx.repoChecks.scanRepoRebranding(tmp);
    ctx.assert.equal(res.scannedFiles, 1);
    ctx.assert.equal(res.ok, false);
    ctx.assert.equal(res.violations.length, 1);
    ctx.assert.equal(res.violations[0].line, 2);
    ctx.assert.equal(res.violations[0].token, 'GROKBOT_TOKEN');
  });

  test('T2-F03-06', 'Category-B masking does not mask an adjacent Category-A token on the same line', async () => {
    const line = 'const a = "grokbot://app/v1/chat"; const b = "x-grokbot-csrf";';
    const res = ctx.repoChecks.scanTextForRebranding(line, { filePath: 'mixed.js' });
    ctx.assert.ok(res.categoryBMatches.includes('grokbot://app/v1/chat'));
    ctx.assert.equal(res.ok, false);
    ctx.assert.equal(res.violations.length, 1);
    ctx.assert.equal(res.violations[0].token, 'x-grokbot-csrf');
  });

  test('T2-F03-07', 'maskCategoryB preserves exact character length so following Category-A column index stays exact', async () => {
    const line = 'const url = "grokbot://app/v1/chat"; const hdr = "x-grokbot-csrf";';
    const { masked, matched } = ctx.repoChecks.maskCategoryB(line);
    ctx.assert.equal(masked.length, line.length);
    ctx.assert.deepEqual(matched, ['grokbot://app/v1/chat']);

    const res = ctx.repoChecks.scanTextForRebranding(line, { filePath: 'col.js' });
    ctx.assert.equal(res.ok, false);
    ctx.assert.equal(res.violations[0].column, line.indexOf('x-grokbot-csrf') + 1);
  });

  // =========================================================================
  // Feature F7 — Prebuilt Image Host & One-Click Deployment (T2-F07-01 .. 07)
  // =========================================================================

  test('T2-F07-01', 'Reject insecure http:// or invalid scheme in ROKBOT_DOWNLOAD_BASE', async (t) => {
    const tmp = await t.createTempDir('f07-scheme-');
    const { scriptPath, composePath, envExamplePath } = await resolveDeployScripts(ctx, tmp);
    const binDir = await createFakeDockerBin(path.join(tmp, '_bin'));

    for (const badBase of ['http://example.com/rokbot', 'ftp://example.com/rokbot']) {
      const workDir = path.join(tmp, badBase.startsWith('http') ? 'run-http' : 'run-ftp');
      const res = await ctx.repoChecks.runInstallImagesPrepareOnly({
        workDir,
        scriptPath,
        composePath,
        envExamplePath,
        args: ['--prepare-only'],
        useFakeDocker: false,
        env: {
          PATH: `${binDir}:${process.env.PATH || '/usr/bin:/bin'}`,
          ROKBOT_DOWNLOAD_BASE: badBase,
        },
      });
      ctx.assert.equal(res.exitCode, 1);
      ctx.assert.match(res.stderr, /must use https:\/\/ or file:\/\//);
    }
  });

  test('T2-F07-02', 'Reject --offline when required Compose or .env.images.example is missing locally', async (t) => {
    const tmp = await t.createTempDir('f07-offline-missing-');
    const { scriptPath } = await resolveDeployScripts(ctx, tmp);
    const workDir = path.join(tmp, 'empty-work');
    await mkdir(workDir, { recursive: true });
    const targetScript = path.join(workDir, 'install-images.sh');
    await writeFile(targetScript, await readFile(scriptPath, 'utf8'), { mode: 0o755 });
    const binDir = await createFakeDockerBin(path.join(tmp, '_bin'));

    const res = await spawnAsync('bash', [targetScript, '--prepare-only', '--offline'], {
      cwd: workDir,
      env: { HOME: workDir, PATH: `${binDir}:${process.env.PATH || '/usr/bin:/bin'}`, TERM: 'dumb' },
      encoding: 'utf8',
      timeout: 10000,
    });
    ctx.assert.equal(res.status, 1);
    ctx.assert.match(res.stderr, /--offline requires local/);
  });

  test('T2-F07-03', 'Reject missing docker binary or missing docker compose plugin', async (t) => {
    const tmp = await t.createTempDir('f07-nodocker-');
    const { scriptPath, composePath, envExamplePath } = await resolveDeployScripts(ctx, tmp);

    // (a) No docker in restricted PATH
    const emptyBin = path.join(tmp, 'empty-bin');
    await mkdir(emptyBin, { recursive: true });
    // Symlink essential POSIX utilities if needed? Better: test against /bin:/usr/bin only if docker isn't in /usr/bin,
    // or verify bad compose plugin deterministically, and skip no-docker only if /usr/bin itself holds docker.
    const noDockerWork = path.join(tmp, 'work-no-docker');
    const badPluginBin = await createFakeDockerBin(path.join(tmp, 'bad-plugin-bin'), { failComposeVersion: true });
    const badPluginRes = await ctx.repoChecks.runInstallImagesPrepareOnly({
      workDir: path.join(tmp, 'work-bad-plugin'),
      scriptPath,
      composePath,
      envExamplePath,
      useFakeDocker: false,
      env: { PATH: `${badPluginBin}:${process.env.PATH || '/usr/bin:/bin'}` },
    });
    ctx.assert.equal(badPluginRes.exitCode, 1);
    ctx.assert.match(badPluginRes.stderr, /Docker Compose plugin is required/i);

    if (!existsSync('/usr/bin/docker') && !existsSync('/bin/docker')) {
      const noDockerRes = await ctx.repoChecks.runInstallImagesPrepareOnly({
        workDir: noDockerWork,
        scriptPath,
        composePath,
        envExamplePath,
        useFakeDocker: false,
        env: { PATH: '/usr/bin:/bin' },
      });
      ctx.assert.equal(noDockerRes.exitCode, 1);
      ctx.assert.match(noDockerRes.stderr, /'docker' is required/);
    }
  });

  test('T2-F07-04', 'Reject unknown CLI flag (exit 2) and empty ROKBOT_BOX_TOKEN during compose validation (exit 1)', async (t) => {
    const tmp = await t.createTempDir('f07-flags-');
    const { scriptPath, composePath, envExamplePath } = await resolveDeployScripts(ctx, tmp);

    const bogusRes = await ctx.repoChecks.runInstallImagesPrepareOnly({
      workDir: path.join(tmp, 'work-bogus'),
      scriptPath,
      composePath,
      envExamplePath,
      args: ['--bogus-flag'],
    });
    ctx.assert.equal(bogusRes.exitCode, 2);

    const badEnvBin = await createFakeDockerBin(path.join(tmp, 'empty-tok-bin'), { emptyBoxToken: true });
    const emptyTokRes = await ctx.repoChecks.runInstallImagesPrepareOnly({
      workDir: path.join(tmp, 'work-empty-tok'),
      scriptPath,
      composePath,
      envExamplePath,
      useFakeDocker: false,
      env: { PATH: `${badEnvBin}:${process.env.PATH || '/usr/bin:/bin'}` },
    });
    ctx.assert.equal(emptyTokRes.exitCode, 1);
    ctx.assert.match(emptyTokRes.stderr, /set every required secret in \.env/i);
  });

  test('T2-F07-05', 'validateImageComposeBundle rejects wrong name, wrong GHCR owner, missing :8000, missing healthcheck & leaked secret', async () => {
    const cases = [
      {
        text: VALID_COMPOSE_YML.replace('name: rokbot', 'name: grokbot'),
        match: /name: rokbot/,
      },
      {
        text: VALID_COMPOSE_YML.replace('ghcr.io/hongfaqiu/rokbot/host', 'ghcr.io/other/host'),
        match: /ghcr\.io\/hongfaqiu\/rokbot/,
      },
      {
        text: VALID_COMPOSE_YML.replace(':8000', ':9000'),
        match: /port 8000/,
      },
      {
        text: VALID_COMPOSE_YML.replace(/    healthcheck:[\s\S]*?deploy\/healthcheck\.mjs"\]\n/, ''),
        match: /healthcheck/i,
      },
      {
        text: `${VALID_COMPOSE_YML}      ROKBOT_ADMIN_PASSWORD=Plaintext1234\n`,
        match: /Secret hygiene check failed/,
      },
    ];
    for (const c of cases) {
      const res = await ctx.repoChecks.validateImageComposeBundle({
        composeText: c.text,
        envExampleText: VALID_ENV_EXAMPLE,
        installScriptText: SYNTHETIC_INSTALL_SCRIPT,
      });
      ctx.assert.equal(res.ok, false);
      ctx.assert.ok(res.errors.some((e) => c.match.test(e)), `Expected ${c.match}, got: ${res.errors.join('; ')}`);
    }
  });

  test('T2-F07-06', 'validateImageComposeBundle rejects leaked API key in .env.images.example and bash -n syntax errors', async (t) => {
    const tmp = await t.createTempDir('f07-syntax-');
    const badScript = path.join(tmp, 'bad-install.sh');
    await writeFile(badScript, '#!/usr/bin/env bash\nif [[ -n "x" ]]; then\n  echo unclosed\n', 'utf8');

    const badEnvText = `${VALID_ENV_EXAMPLE}OPENAI_API_KEY=${['sk', '1234567890abcdef1234'].join('-')}\n`;
    const res = await ctx.repoChecks.validateImageComposeBundle({
      composeText: VALID_COMPOSE_YML,
      envExampleText: badEnvText,
      installScriptPath: badScript,
    });
    ctx.assert.equal(res.ok, false);
    ctx.assert.ok(res.errors.some((e) => e.includes('Secret hygiene check failed')));
    ctx.assert.ok(res.errors.some((e) => e.includes('bash syntax error')));
  });

  test('T2-F07-07', 'install-images.sh .env proxy parser resists shell command substitution $(...) and CRLF injection', async (t) => {
    const tmp = await t.createTempDir('f07-injection-');
    const { scriptPath, composePath, envExamplePath } = await resolveDeployScripts(ctx, tmp);
    const workDir = path.join(tmp, 'work');
    await mkdir(workDir, { recursive: true });
    const pwnedPath = path.join(workDir, 'pwned');
    const envLines = [
      'ROKBOT_BOX_TOKEN=local',
      `HTTP_PROXY="http://proxy.local:8080/#frag"`,
      `NO_PROXY="localhost,$(touch ${pwnedPath})" # trailing comment`,
      '',
    ].join('\r\n');
    await writeFile(path.join(workDir, '.env'), envLines, 'utf8');

    const res = await ctx.repoChecks.runInstallImagesPrepareOnly({
      workDir,
      scriptPath,
      composePath,
      envExamplePath,
      args: ['--prepare-only', '--offline'],
    });
    ctx.assert.equal(res.exitCode, 0, res.stderr);
    ctx.assert.equal(existsSync(pwnedPath), false, 'Command substitution inside .env MUST NOT execute');
  });
}

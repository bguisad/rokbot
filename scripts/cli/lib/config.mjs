// Instance configuration: validation that mirrors host/deploy.py `init`, the .env written for
// image deployments (rendered from host/release/.env.images.example), and the CLI state file.
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CliError, defaultHome, expandHome, REPO_ROOT, writePrivateFile } from './util.mjs';

export const STATE_FILE = 'rokbot.json';
export const STATE_SCHEMA = 'rokbot-cli/v1';
export const IMAGE_COMPOSE = 'docker-compose.images.yml';
export const RELEASE_DIR = path.join(REPO_ROOT, 'host', 'release');
export const ENV_TEMPLATE = path.join(RELEASE_DIR, '.env.images.example');
export const DEFAULT_PORT = 18080;
export const DEFAULT_TZ = 'Asia/Singapore';
export const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,60}$/;
// Image names published by this repository (host/release/docker-compose.images.yml).
export const DEFAULT_IMAGES = {
  host: 'ghcr.io/hongfaqiu/rokbot/host:latest',
  box: 'ghcr.io/hongfaqiu/rokbot/box:2bb5e41',
};

const bad = message => { throw new CliError(message, 2); };

/** An HTTP(S) origin without credentials, path, query or fragment (the deploy.py `endpoint` rule). */
export function normalizeOrigin(value, label = '--public-url') {
  let url;
  try { url = new URL(value); } catch { bad(`${label} 需要有效的 HTTP(S) 地址`); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      !['', '/'].includes(url.pathname) || url.search || url.hash || !/^https?:\/\/[a-zA-Z0-9.[\]:-]+\/?$/.test(value) || url.port === '0')
    bad(`${label} 只能是 HTTP(S) 源地址，不能带账号、路径、查询参数或片段`);
  return value.replace(/\/+$/, '');
}

function originKey(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
}

export function webClientUrl({ publicUrl, port, webPort, webPublicUrl }) {
  if (webPublicUrl) return `${webPublicUrl}/web/`;
  const main = new URL(publicUrl || `http://127.0.0.1:${port}`);
  return `${main.protocol}//${main.hostname.includes(':') && !main.hostname.startsWith('[') ? `[${main.hostname}]` : main.hostname}:${webPort}/web/`;
}

/**
 * Validates and completes Host settings. Same rules as `host/deploy.py init`:
 * ports 1–65535, web port defaults to port + 1, a non-loopback listen address needs a public URL,
 * and the web client must have an address different from the admin address.
 */
export function resolveHostSettings(input = {}) {
  const mode = input.mode ?? 'image';
  if (!['image', 'source'].includes(mode)) bad('--mode 只能是 image 或 source');
  const project = input.project ?? 'rokbot';
  if (!PROJECT_NAME.test(project)) bad('--project 只能包含小写字母、数字、- 和 _，并以字母或数字开头');
  const port = input.port ?? DEFAULT_PORT;
  const webPort = input.webPort ?? port + 1;
  for (const [value, label] of [[port, '--port'], [webPort, '--web-port']])
    if (!Number.isInteger(value) || value < 1 || value > 65535) bad(`${label} 需要 1–65535 的端口号`);
  const listen = input.listen ?? '127.0.0.1';
  if (!net.isIP(listen)) bad('--listen 需要一个 IP 地址，例如 127.0.0.1 或服务器专网 IP');
  const publicUrl = input.publicUrl ? normalizeOrigin(input.publicUrl) : null;
  if (!publicUrl && listen !== '127.0.0.1') bad('监听非本机地址时需要 --public-url（客户端实际输入的地址）');
  const webPublicUrl = input.webPublicUrl ? normalizeOrigin(input.webPublicUrl, '--web-public-url') : null;
  if (!webPublicUrl && port === webPort) bad('--web-port 不能与 --port 相同');
  const origin = publicUrl ?? `http://127.0.0.1:${port}`;
  const web = webClientUrl({ publicUrl: origin, port, webPort, webPublicUrl });
  if (originKey(origin) === originKey(web)) bad('网页版地址必须与管理页地址不同');
  const tz = input.tz ?? DEFAULT_TZ;
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) bad('--tz 需要时区名称，例如 Asia/Shanghai');
  const hostOnly = Boolean(input.hostOnly);
  if (hostOnly && mode !== 'source') bad('--host-only 只用于源码模式（分机部署由 host/deploy.py 管理）');
  for (const [key, label] of [['hostImage', '--host-image'], ['boxImage', '--box-image']])
    if (input[key] && !/^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,255}$/.test(input[key])) bad(`${label} 不是有效的镜像名`);
  return {
    mode, project, listen, port, webPort, publicUrl, webPublicUrl, tz, hostOnly,
    hostImage: input.hostImage ?? DEFAULT_IMAGES.host,
    boxImage: input.boxImage ?? DEFAULT_IMAGES.box,
    adminUrl: `${origin}/admin`,
    webUrl: web,
  };
}

/**
 * Renders the image-mode .env from host/release/.env.images.example, keeping its comments and
 * replacing (or uncommenting) the keys the CLI sets. install-images.sh later fills any *_SECRET.
 */
export function renderImageEnv(settings, template = readFileSync(ENV_TEMPLATE, 'utf8')) {
  const values = {
    ROKBOT_LISTEN_ADDRESS: settings.listen.includes(':') ? `[${settings.listen}]` : settings.listen,
    ROKBOT_PUBLIC_PORT: String(settings.port),
    ROKBOT_WEB_PUBLIC_PORT: String(settings.webPort),
    TZ: settings.tz,
    ROKBOT_HOST_IMAGE: settings.hostImage,
    ROKBOT_BOX_IMAGE: settings.boxImage,
    ROKBOT_BOX_TOKEN: 'local',
  };
  if (settings.publicUrl) values.ROKBOT_PUBLIC_URL = settings.publicUrl;
  if (settings.webPublicUrl) values.ROKBOT_WEB_PUBLIC_URL = settings.webPublicUrl;
  if (settings.project !== 'rokbot') values.COMPOSE_PROJECT_NAME = settings.project;
  const written = new Set();
  const lines = template.replace(/\r/g, '').split('\n').map(line => {
    const match = /^(#\s*)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !(match[2] in values)) return line;
    const key = match[2];
    if (written.has(key)) return line;
    written.add(key);
    return `${key}=${values[key]}`;
  });
  const missing = Object.keys(values).filter(key => !written.has(key));
  if (missing.length) lines.push('', '# Added by rokbot init', ...missing.map(key => `${key}=${values[key]}`));
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** What `host/deploy.py init` writes for the same settings (shown by `init --dry-run`). */
export function renderSourceEnvPreview(settings) {
  const listen = settings.listen.includes(':') ? `[${settings.listen}]` : settings.listen;
  return [
    `ROKBOT_LISTEN_ADDRESS=${listen}`,
    `ROKBOT_PUBLIC_PORT=${settings.port}`,
    `ROKBOT_PUBLIC_URL=${settings.publicUrl ?? `http://127.0.0.1:${settings.port}`}`,
    `ROKBOT_WEB_PUBLIC_PORT=${settings.webPort}`,
    ...(settings.webPublicUrl ? [`ROKBOT_WEB_PUBLIC_URL=${settings.webPublicUrl}`] : []),
    `ROKBOT_MODE=${settings.hostOnly ? 'remote' : 'local'}`,
    `ROKBOT_PROJECT=${settings.project}`,
    ...(settings.tz !== DEFAULT_TZ ? [`TZ=${settings.tz}`] : []),
  ].join('\n') + '\n';
}

/** Hides values of keys that look secret (for previews and status output). */
export function maskEnv(text) {
  return text.split('\n').map(line => {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match && /(SECRET|PASSWORD|API_KEY|SETUP_KEY)$/.test(match[1]) && match[2]) return `${match[1]}=********`;
    return line;
  }).join('\n');
}

/** Minimal .env reader: last assignment wins, matching outer quotes are removed. */
export function parseEnv(text) {
  const values = {};
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

export function readInstanceEnv(home) {
  const filename = path.join(home, '.env');
  return existsSync(filename) ? parseEnv(readFileSync(filename, 'utf8')) : {};
}

/** Local URL of the admin service, from the instance .env. */
export function localAdminOrigin(env) {
  let host = env.ROKBOT_LISTEN_ADDRESS || env.ROKBOT_BIND || '127.0.0.1';
  if (['0.0.0.0', '::', '[::]'].includes(host)) host = '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  return `http://${host}:${env.ROKBOT_PUBLIC_PORT || env.ROKBOT_PORT || DEFAULT_PORT}`;
}

export function readState(home) {
  const filename = path.join(home, STATE_FILE);
  if (!existsSync(filename)) return null;
  let state;
  try { state = JSON.parse(readFileSync(filename, 'utf8')); } catch { throw new CliError(`${filename} 不是有效的 JSON`); }
  if (state?.schema !== STATE_SCHEMA) throw new CliError(`${filename} 不是 rokbot CLI 的状态文件`);
  return state;
}

/** State for an instance; falls back to a deploy.py instance that was created without the CLI. */
export function requireState(home) {
  const state = readState(home);
  if (state) return state;
  const env = readInstanceEnv(home);
  if (env.ROKBOT_PROJECT || env.ROKBOT_MODE) {
    const source = path.join(home, 'src');
    return { schema: STATE_SCHEMA, mode: 'source', project: env.ROKBOT_PROJECT || 'rokbot', hostOnly: env.ROKBOT_MODE === 'remote',
      source: existsSync(path.join(source, 'host', 'deploy.py')) ? source : REPO_ROOT, adopted: true };
  }
  if (existsSync(path.join(home, IMAGE_COMPOSE)) && existsSync(path.join(home, '.env')))
    return { schema: STATE_SCHEMA, mode: 'image', project: env.COMPOSE_PROJECT_NAME || 'rokbot', adopted: true };
  throw new CliError(`${home} 里没有 RokBot 实例。先运行 rokbot init，或用 --home 指定实例目录。`);
}

export async function writeState(home, state) {
  await writePrivateFile(path.join(home, STATE_FILE), `${JSON.stringify({ schema: STATE_SCHEMA, ...state }, null, 2)}\n`);
}

/** The docker compose prefix for an instance; mirrors host/deploy.py `compose()` for source mode. */
export function composeCommand(home, state) {
  if (state.mode === 'image')
    return ['compose', '--env-file', path.join(home, '.env'), '-p', state.project, '-f', path.join(home, IMAGE_COMPOSE)];
  const release = path.join(state.source, 'host', 'release');
  return ['compose', '--env-file', path.join(home, '.env'), '-p', state.project,
    '-f', path.join(release, state.hostOnly ? 'compose.host.yaml' : 'compose.yaml')];
}

export function deployScript(state) {
  return path.join(state.source, 'host', 'deploy.py');
}

export function deployGlobalArgs(home, state) {
  return ['--home', home, '--project', state.project, ...(state.hostOnly ? ['--host-only'] : [])];
}

/**
 * Full RokBot checkouts the CLI may borrow repository files from (patchers, pins), in order:
 * --src, the CLI's own directory (a git checkout), the source directory recorded by
 * `rokbot init --mode source`, <home>/src, and ~/.rokbot/cli (scripts/install-cli.sh).
 * The npm package only ships what deploy/admin/doctor need, so `pack` resolves its patchers here.
 */
export function sourceCandidates({ home, src } = {}) {
  if (src) return [{ root: path.resolve(expandHome(src)), from: '--src' }];
  const instanceHome = home ? path.resolve(expandHome(home)) : defaultHome();
  const list = [{ root: REPO_ROOT, from: 'cli' }];
  try {
    const state = readState(instanceHome);
    if (state?.source) list.push({ root: path.resolve(state.source), from: 'instance' });
  } catch { /* unreadable state: ignore, other candidates still apply */ }
  list.push({ root: path.join(instanceHome, 'src'), from: 'instance' });
  list.push({ root: path.join(os.homedir(), '.rokbot', 'cli'), from: 'install-cli' });
  const seen = new Set();
  return list.filter(item => !seen.has(item.root) && seen.add(item.root));
}

/** The first candidate that contains every `relative` path, or null. */
export function findSourceRoot(relatives, options = {}) {
  const wanted = [relatives].flat();
  return sourceCandidates(options).find(({ root }) => wanted.every(relative => existsSync(path.join(root, relative)))) ?? null;
}

// `rokbot doctor`: environment checks. Android signing follows android/release/signing-guard.mjs:
// release builds need ~/.rokbot-local/android-signing.json whose certificate matches
// android/release/signing-pin.json; a temporary key is only acceptable with an explicit
// --dev-signing / ROKBOT_ANDROID_DEV_SIGNING=1.
import { existsSync, statfsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { parseCommandArgs } from './args.mjs';
import { DEFAULT_PORT, findSourceRoot, readInstanceEnv, readState, deployScript, deployGlobalArgs } from './config.mjs';
import { docker, serviceContainer } from './docker.mjs';
import { capture, commandExists, defaultHome, expandHome, out, REPO_ROOT, run } from './util.mjs';

// The pinned release certificate (android/release/signing-pin.json) starts with these bytes.
export const RELEASE_PIN_PREFIX = '46214d3d';
export const MIN_NODE_MAJOR = 20;
export const MIN_COMPOSE = [2, 26, 0];
const GB = 1024 ** 3;

const ok = (name, message, detail) => ({ name, status: 'ok', message, ...(detail ? { detail } : {}) });
const warn = (name, message, detail) => ({ name, status: 'warn', message, ...(detail ? { detail } : {}) });
const bad = (name, message, detail) => ({ name, status: 'fail', message, ...(detail ? { detail } : {}) });

let guardModule;
async function signingGuard(repo) {
  guardModule ??= await import(pathToFileURL(path.join(repo, 'android', 'release', 'signing-guard.mjs')).href);
  return guardModule;
}

/**
 * Checks the Android release signing key. Returns one result:
 * - fail: key missing / unreadable / fingerprint differs from the pin, without explicit dev signing
 * - warn: same problems, but dev signing was explicitly enabled (builds are not releasable)
 * - ok:   key matches the pinned release certificate
 */
export async function checkAndroidSigning({ keystore, devSigning, env = process.env, repo = REPO_ROOT, pinSha256 } = {}) {
  const name = '安卓签名密钥';
  if (!existsSync(path.join(repo, 'android', 'release', 'signing-guard.mjs')))
    return warn(name, `${repo} 中没有 android/release/signing-guard.mjs，无法检查签名密钥；在 RokBot 源码目录里运行 rokbot doctor 可检查`);
  const guard = await signingGuard(repo);
  const pin = pinSha256 ?? guard.RELEASE_CERTIFICATE_SHA256;
  if (!pinSha256 && !pin.startsWith(RELEASE_PIN_PREFIX))
    return bad(name, `signing-pin.json 的证书指纹 ${pin.slice(0, 8)}… 不是 ${RELEASE_PIN_PREFIX} 开头，签名配置被改动过`);
  const dev = guard.isDevSigningEnabled({ devSigning: devSigning ? true : undefined }, env);
  const keystorePath = keystore ? path.resolve(expandHome(keystore)) : guard.getDefaultKeystorePath(env);
  try {
    const result = guard.resolveReleaseSigningIdentity({ keystorePath, devSigning: false, expectedCertificateSha256: pin, env, warn: () => {} });
    return ok(name, `正式签名密钥匹配（证书 SHA-256 ${result.certificateSha256.slice(0, 8)}…）`, keystorePath);
  } catch (error) {
    const missing = !existsSync(keystorePath);
    const actual = /Actual certificate SHA-256\s*:\s*([0-9a-f]{64})/.exec(error.message)?.[1];
    const reason = missing ? `找不到正式签名密钥 ${keystorePath}`
      : actual ? `证书指纹 ${actual.slice(0, 8)}… 不是正式证书（应为 ${pin.slice(0, 8)}… 开头）`
        : `无法读取签名密钥 ${keystorePath}（${error.message.split('\n')[0]}）`;
    if (dev) return warn(name, `${reason}；已显式开启临时开发签名，生成的 APK 不能作为正式版发布，已安装的客户端也无法原地升级`);
    return bad(name, `${reason}。把正式密钥放到 ${guard.getDefaultKeystorePath(env)}，或用 --keystore 指定；仅测试时才可用 --dev-signing 或 ROKBOT_ANDROID_DEV_SIGNING=1 显式允许临时密钥`);
  }
}

function versionTuple(text) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}
const atLeast = (actual, minimum) => {
  for (let i = 0; i < 3; i++) { if (actual[i] !== minimum[i]) return actual[i] > minimum[i]; }
  return true;
};

export function checkNode(version = process.versions.node) {
  const major = Number(version.split('.')[0]);
  return major >= MIN_NODE_MAJOR ? ok('Node.js', `v${version}`) : bad('Node.js', `v${version} 过旧，需要 ${MIN_NODE_MAJOR} 或更新版本`);
}

function checkDocker() {
  const results = [];
  if (!commandExists('docker')) return [bad('Docker', '找不到 docker 命令，请先安装 Docker（含 Compose v2）')];
  const info = docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
  if (info.status !== 0) return [bad('Docker', '无法连接 Docker daemon：确认 Docker 正在运行，且当前用户有权限')];
  const engine = info.stdout.trim();
  const engineVersion = versionTuple(engine);
  results.push(engineVersion && atLeast(engineVersion, [26, 0, 0]) ? ok('Docker', `Engine ${engine}`)
    : warn('Docker', `Engine ${engine} 低于 26，Bot 在执行桌面读取记忆的功能会关闭`));
  const compose = docker(['compose', 'version', '--short']);
  const composeVersion = versionTuple(compose.stdout);
  if (compose.status !== 0 || !composeVersion) results.push(bad('Docker Compose', '找不到 Compose v2 插件（docker compose）'));
  else if (!atLeast(composeVersion, MIN_COMPOSE)) results.push(bad('Docker Compose', `${compose.stdout.trim()} 过旧，需要 ${MIN_COMPOSE.join('.')}+（支持 up --wait-timeout）`));
  else results.push(ok('Docker Compose', compose.stdout.trim()));
  return results;
}

export function checkDisk(directory, { statfs = statfsSync } = {}) {
  let target = directory;
  while (!existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
  try {
    const stats = statfs(target);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const text = `${target} 可用 ${(free / GB).toFixed(1)} GB`;
    if (free < 5 * GB) return bad('磁盘空间', `${text}，不足 5 GB`);
    if (free < 30 * GB) return warn('磁盘空间', `${text}；同机部署建议至少 30 GB（镜像、构建缓存和备份另占空间）`);
    return ok('磁盘空间', text);
  } catch (error) {
    return warn('磁盘空间', `无法读取 ${target} 的磁盘信息（${error.code ?? error.message}）`);
  }
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', error => resolve(error.code === 'EADDRINUSE' ? false : error.code === 'EACCES' ? 'denied' : 'unavailable'));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function checkPorts(env, project) {
  const listen = (env.ROKBOT_LISTEN_ADDRESS || '127.0.0.1').replace(/^\[|\]$/g, '');
  const port = Number(env.ROKBOT_PUBLIC_PORT || DEFAULT_PORT);
  const webPort = Number(env.ROKBOT_WEB_PUBLIC_PORT || port + 1);
  const host = serviceContainer(project, 'host');
  const running = host && docker(['inspect', '-f', '{{.State.Running}}', host]).stdout.trim() === 'true';
  const results = [];
  for (const [value, label] of [[port, '管理端口'], [webPort, '网页版端口']]) {
    const free = await portFree(value, net.isIP(listen) ? listen : '127.0.0.1');
    if (free === true) results.push(ok(label, `${listen}:${value} 可用`));
    else if (free === false && running) results.push(ok(label, `${listen}:${value} 已由本实例的 Host 使用`));
    else if (free === false) results.push(bad(label, `${listen}:${value} 已被其他程序占用，换一个端口（rokbot init --port）`));
    else results.push(warn(label, `无法在 ${listen}:${value} 上测试监听（${free}）`));
  }
  return results;
}

/** TLS certificate of an HTTPS public URL: trusted chain, host name and remaining validity. */
export function checkCertificate(publicUrl, { timeoutMs = 8_000, now = Date.now() } = {}) {
  const name = '证书';
  if (!publicUrl) return Promise.resolve(ok(name, '未设置对外 HTTPS 地址（仅本机访问），无需证书'));
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:') {
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    return Promise.resolve(loopback ? ok(name, '本机 HTTP 地址，无需证书')
      : warn(name, `${publicUrl} 使用明文 HTTP；只在可信专网中使用，公网请放在 HTTPS 反向代理后面`));
  }
  return new Promise(resolve => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      const reason = socket.authorizationError;
      socket.end();
      if (!authorized) { resolve(bad(name, `${url.hostname} 的证书不受信任（${reason}）`)); return; }
      const days = Math.floor((Date.parse(cert.valid_to) - now) / 86_400_000);
      if (days < 0) resolve(bad(name, `${url.hostname} 的证书已过期`));
      else if (days < 14) resolve(warn(name, `${url.hostname} 的证书 ${days} 天后过期，请尽快续期`));
      else resolve(ok(name, `${url.hostname} 证书有效，剩余 ${days} 天`));
    });
    socket.on('timeout', () => { socket.destroy(); resolve(warn(name, `连接 ${url.host} 超时，无法检查证书`)); });
    socket.on('error', error => resolve(warn(name, `无法连接 ${url.host} 检查证书（${error.code ?? error.message}）`)));
  });
}

/** Desktop/web packing needs @electron/asar in a full checkout; the npm package has no patchers. */
export function checkPackDependencies({ home } = {}) {
  const name = '桌面打包依赖';
  const source = findSourceRoot('mac/patchers/desktop/package.json', { home });
  if (!source) return warn(name, '当前安装不含打包补丁脚本（npm 安装版）；需要 rokbot pack 时先用 rokbot init --mode source 获取源码，或在源码目录里运行');
  const where = source.root === REPO_ROOT ? '' : `（源码目录 ${source.root}）`;
  return existsSync(path.join(source.root, 'mac/patchers/desktop/node_modules/@electron/asar/package.json'))
    ? ok(name, `@electron/asar 已安装${where}`)
    : warn(name, `缺少 @electron/asar${where}；桌面/网页版打包前在源码目录运行 npm install --prefix mac/patchers/desktop`);
}

function checkTools() {
  const results = [];
  results.push(commandExists('git') ? ok('Git', capture('git', ['--version']).stdout.trim()) : warn('Git', '找不到 git；源码模式和 update 需要它'));
  if (!commandExists('python3')) results.push(warn('Python', '找不到 python3；源码模式（host/deploy.py）、更新前备份和 iOS 打包需要它'));
  else {
    const version = capture('python3', ['--version']).stdout.trim() || capture('python3', ['--version']).stderr.trim();
    const tuple = versionTuple(version);
    results.push(tuple && atLeast(tuple, [3, 10, 0]) ? ok('Python', version) : warn('Python', `${version || 'python3'}；源码模式的 host/deploy.py 需要 3.10+`));
  }
  return results;
}

export const DOCTOR_OPTIONS = {
  json: { type: 'boolean' },
  keystore: { type: 'string' },
  'dev-signing': { type: 'boolean' },
  'skip-network': { type: 'boolean' },
  deep: { type: 'boolean' },
};

export async function runChecks(values) {
  const home = values.home ? path.resolve(expandHome(values.home)) : defaultHome();
  const env = readInstanceEnv(home);
  const state = readState(home);
  const project = state?.project ?? env.COMPOSE_PROJECT_NAME ?? env.ROKBOT_PROJECT ?? 'rokbot';
  const results = [checkNode(), ...checkDocker(), ...checkTools(), checkPackDependencies({ home }), checkDisk(home)];
  results.push(...await checkPorts(env, project));
  results.push(values['skip-network'] ? ok('证书', '已跳过（--skip-network）') : await checkCertificate(env.ROKBOT_PUBLIC_URL || null));
  results.push(await checkAndroidSigning({ keystore: values.keystore, devSigning: values['dev-signing'] }));
  return { home, state, results };
}

export function formatResults(results) {
  const label = { ok: '[通过]', warn: '[注意]', fail: '[失败]' };
  const width = text => [...text].reduce((total, char) => total + (/[⺀-￿]/.test(char) ? 2 : 1), 0);
  const column = Math.max(...results.map(result => width(result.name))) + 2;
  return results.map(result => `${label[result.status]} ${result.name}${' '.repeat(column - width(result.name))}${result.message}`);
}

export async function doctorCommand(argv) {
  const { values } = parseCommandArgs(argv, DOCTOR_OPTIONS);
  const { home, state, results } = await runChecks(values);
  const failed = results.filter(result => result.status === 'fail').length;
  const warned = results.filter(result => result.status === 'warn').length;
  if (values.json) {
    out(JSON.stringify({ ok: failed === 0, home, results }, null, 2));
  } else {
    out(`RokBot 环境检查（实例目录 ${home}）`, '', ...formatResults(results), '',
      failed ? `${failed} 项失败，${warned} 项需要注意。` : `全部通过${warned ? `，${warned} 项需要注意` : ''}。`);
  }
  if (values.deep && state?.mode === 'source') {
    out('', '运行 host/deploy.py doctor（架构、执行桌面兼容性探针）…');
    const code = await run('python3', [deployScript(state), ...deployGlobalArgs(home, state), 'doctor'], { input: '' });
    if (code !== 0) return 1;
  }
  return failed ? 1 : 0;
}

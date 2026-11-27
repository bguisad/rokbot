// `rokbot admin`: first-time administrator password setup and password reset.
//
// Setup goes through the Host's own setup API with the one-time key in /data/setup-key, using
// host/tools/host-admin.mjs inside the Host container (the same path as `host/deploy.py admin setup`).
// Reset has no HTTP API: the CLI hashes the new password with the Host's own scrypt parameters
// (host/server/security.mjs), stops the Host, and writes only the hash into /data/auth.json through a
// one-shot container on the Host image. The plaintext password never leaves this process except as
// an environment variable of `docker compose exec` during setup; it is never written to disk or logs.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCommandArgs } from './args.mjs';
import { composeCommand, deployGlobalArgs, deployScript, localAdminOrigin, readInstanceEnv, requireState } from './config.mjs';
import { docker, inspect, requireDocker, serviceContainer, waitHealthy } from './docker.mjs';
import {
  askHidden, choose, CliError, defaultHome, err, expandHome, fail, isInteractive, out, REPO_ROOT, run, writePrivateFile,
} from './util.mjs';

export const MIN_PASSWORD = 12; // host/tools/host-admin.mjs setup requires 12–128 characters.
export const MAX_PASSWORD = 128;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generatePassword(length = 24) {
  if (length < MIN_PASSWORD || length > MAX_PASSWORD) throw new RangeError('password length');
  let value = '';
  for (let i = 0; i < length; i++) value += ALPHABET[randomInt(ALPHABET.length)];
  return value;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)
    throw new CliError(`管理员密码需要 ${MIN_PASSWORD}–${MAX_PASSWORD} 个字符`, 2);
  if (/[\u0000-\u001f\u007f]/.test(password)) throw new CliError('管理员密码不能包含控制字符', 2);
  return password;
}

let security;
async function hostSecurity(repo = REPO_ROOT) {
  security ??= await import(pathToFileURL(path.join(repo, 'host', 'server', 'security.mjs')).href);
  return security;
}

/** The record the Host stores in auth.json `admin`: { salt, hash } from the Host's scrypt. */
export async function hashAdminPassword(password) {
  validatePassword(password);
  return (await hostSecurity()).passwordHash(password);
}

export async function verifyAdminPassword(password, record) {
  return (await hostSecurity()).verifyPassword(password, record);
}

/**
 * Replaces the administrator in a serialized auth.json and signs out every admin session.
 * Paired devices are kept. Pure function so it can be tested and shipped into the container.
 */
export function applyAdminReset(text, admin) {
  const state = JSON.parse(text);
  if (!state || state.version !== 1) throw new Error('Unsupported auth.json version');
  if (!admin || !/^[0-9a-f]{32}$/.test(admin.salt) || !/^[0-9a-f]{128}$/.test(admin.hash)) throw new Error('Invalid admin record');
  state.admin = { salt: admin.salt, hash: admin.hash };
  state.sessions = [];
  return `${JSON.stringify(state)}\n`;
}

/** Node script run inside the Host image: reads { admin } on stdin, updates $AUTH_FILE atomically (0600). */
export const RESET_SCRIPT = `
import { readFile, open, rename, rm, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const applyAdminReset = ${applyAdminReset.toString()};
const filename = process.env.ROKBOT_AUTH_FILE || '/data/auth.json';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { admin } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
let text;
try { text = await readFile(filename, 'utf8'); }
catch (error) { if (error.code === 'ENOENT') { console.error('NOT_INITIALIZED'); process.exit(3); } throw error; }
const next = applyAdminReset(text, admin);
const temporary = filename + '.' + randomBytes(8).toString('hex') + '.tmp';
try {
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
  await rename(temporary, filename);
  await chmod(filename, 0o600);
} finally { await rm(temporary, { force: true }); }
console.log('OK');
`;

export async function adminSession(origin) {
  try {
    const response = await fetch(`${origin}/admin/api/session`, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
    if (!response.ok) return { reachable: true, status: response.status };
    const body = await response.json();
    return { reachable: true, initialized: Boolean(body.initialized) };
  } catch (error) {
    return { reachable: false, error: error.cause?.code ?? error.name };
  }
}

async function passwordFromSources(values, { interactive }) {
  if (values['password-file']) {
    let text;
    try { text = readFileSync(expandHome(values['password-file']), 'utf8'); }
    catch (error) { fail(`无法读取 --password-file（${error.code}）`); }
    return { password: validatePassword(text.replace(/\r?\n$/, '')), generated: false };
  }
  if (process.env.ROKBOT_ADMIN_PASSWORD) return { password: validatePassword(process.env.ROKBOT_ADMIN_PASSWORD), generated: false };
  let manual = Boolean(values.prompt);
  if (!manual && !values.generate && !values.yes && interactive) {
    manual = (await choose('管理员密码：', [
      { value: 'generate', label: '生成强随机密码（推荐，只显示一次）' },
      { value: 'manual', label: '自己输入' },
    ], 'generate')) === 'manual';
  }
  if (manual) {
    const first = validatePassword(await askHidden(`输入管理员密码（${MIN_PASSWORD}–${MAX_PASSWORD} 位，输入时不显示）`));
    const second = await askHidden('再次输入');
    if (first !== second) fail('两次输入不一致', 2);
    return { password: first, generated: false };
  }
  return { password: generatePassword(), generated: true };
}

/** Shows a generated password exactly once, only on a terminal (or saves it to a new 0600 file). */
async function revealGenerated(password, saveTo) {
  if (saveTo) {
    const target = path.resolve(expandHome(saveTo));
    try { await writePrivateFile(target, `${password}\n`, { exclusive: true }); }
    catch (error) { fail(error.code === 'EEXIST' ? `${target} 已存在，不会覆盖` : `无法写入 ${target}（${error.code}）`); }
    out(`管理员密码已写入 ${target}（权限 600）。读取后请删除该文件。`);
    return;
  }
  process.stdout.write(`\n管理员密码（只显示这一次，请立即保存到密码管理器）：\n\n    ${password}\n\n`);
}

function checkRevealPossible(generated, values) {
  if (generated && !values['save-to'] && !process.stdout.isTTY)
    fail('输出不是终端，生成的密码不会打印到日志或管道。请在终端里运行，或用 --save-to <新文件> 保存，或用 --password-file 提供密码。', 2);
}

async function setupAdmin(home, state, password) {
  const env = { ...process.env, ROKBOT_ADMIN_PASSWORD: password };
  let code;
  if (state.mode === 'source') {
    code = await run('python3', [deployScript(state), ...deployGlobalArgs(home, state), 'admin', 'setup'], { env, input: '' });
  } else {
    code = await run('docker', [...composeCommand(home, state), 'exec', '-T', '-e', 'ROKBOT_ADMIN_PASSWORD', '-e', 'ROKBOT_URL=http://127.0.0.1:8000',
      'host', '/exec-daemon/node', 'tools/host-admin.mjs', 'setup', '--setup-key-file', '/data/setup-key'], { env, input: '' });
  }
  if (code !== 0) fail('设置管理员失败。确认 Host 正在运行（rokbot status），且尚未设置过管理员。');
}

async function resetAdmin(home, state, password) {
  requireDocker();
  const id = serviceContainer(state.project, 'host');
  if (!id) fail(`找不到项目 ${state.project} 的 Host 容器。先运行 rokbot up。`);
  const info = inspect(id);
  const volume = info?.Mounts?.find(mount => mount.Destination === '/data' && mount.Type === 'volume')?.Name;
  if (!volume) fail('Host 容器没有挂载 /data 数据卷，无法重置。');
  const admin = await hashAdminPassword(password);
  const wasRunning = Boolean(info.State?.Running);
  out('正在停止 Host 以写入新的管理员密码哈希…');
  if (wasRunning && docker(['stop', '-t', '25', id], { timeout: 120_000 }).status !== 0) fail('无法停止 Host 容器');
  let code;
  try {
    code = await run('docker', ['run', '--rm', '-i', '--pull=never', '--network', 'none', '--entrypoint', '/exec-daemon/node',
      '--mount', `type=volume,src=${volume},dst=/data`, info.Image, '--input-type=module', '-e', RESET_SCRIPT],
    { input: JSON.stringify({ admin }), stdio: ['pipe', 'ignore', 'pipe'] });
  } finally {
    if (wasRunning) {
      docker(['start', id], { timeout: 60_000 });
    }
  }
  if (code === 3) fail('Host 还没有设置管理员，请直接运行 rokbot admin 完成首次设置。');
  if (code !== 0) fail('写入新密码失败，原密码保持不变。');
  if (wasRunning) {
    out('Host 已重新启动，等待健康检查…');
    if (!await waitHealthy(id, { timeoutMs: 180_000 })) err('Host 尚未报告健康，稍后用 rokbot status 查看。');
  }
}

export const ADMIN_OPTIONS = {
  reset: { type: 'boolean' },
  status: { type: 'boolean' },
  'setup-key': { type: 'boolean' },
  'password-file': { type: 'string' },
  prompt: { type: 'boolean' },
  generate: { type: 'boolean' },
  'save-to': { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
};

export async function adminCommand(argv) {
  const { values } = parseCommandArgs(argv, ADMIN_OPTIONS);
  const home = values.home ? path.resolve(expandHome(values.home)) : defaultHome();
  const state = requireState(home);
  const origin = localAdminOrigin(readInstanceEnv(home));
  const session = await adminSession(origin);
  if (values.status) {
    if (!session.reachable) fail(`无法连接管理服务 ${origin}，用 rokbot status 查看容器状态。`);
    out(session.initialized ? '管理员：已设置' : '管理员：未设置（运行 rokbot admin 完成首次设置）');
    return;
  }
  if (values['setup-key']) {
    if (!process.stdout.isTTY) fail('一次性初始化码只显示在终端里，不输出到管道或日志。', 2);
    if (state.mode === 'source') {
      await run('python3', [deployScript(state), ...deployGlobalArgs(home, state), 'setup-key'], { input: '' });
    } else {
      await run('docker', [...composeCommand(home, state), 'exec', '-T', 'host', 'cat', '/data/setup-key'], { input: '' });
    }
    return;
  }
  const interactive = isInteractive() && !values.yes;
  if (values.reset) {
    const { password, generated } = await passwordFromSources(values, { interactive });
    checkRevealPossible(generated, values);
    await resetAdmin(home, state, password);
    out('管理员密码已重置，所有管理页登录会话已失效，已配对设备不受影响。');
    if (generated) await revealGenerated(password, values['save-to']);
    return;
  }
  if (!session.reachable) fail(`无法连接管理服务 ${origin}。先运行 rokbot up，等健康检查通过后再设置管理员。`);
  if (session.initialized) {
    out('管理员已经设置。忘记密码时用 rokbot admin --reset 重置。');
    return;
  }
  const { password, generated } = await passwordFromSources(values, { interactive });
  checkRevealPossible(generated, values);
  await setupAdmin(home, state, password);
  out(`管理员已设置。管理页：${origin}/admin`);
  if (generated) await revealGenerated(password, values['save-to']);
}

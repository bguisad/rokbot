// Shared helpers for the rokbot CLI: process execution, terminal output and prompts.
// Zero dependencies; secrets are only ever passed to children through the environment or stdin.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_REPO_URL = 'https://github.com/hongfaqiu/rokbot.git';

export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}
export const fail = (message, code = 1) => { throw new CliError(message, code); };

export function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function defaultHome(env = process.env) {
  return path.resolve(expandHome(env.ROKBOT_HOME || path.join(os.homedir(), 'rokbot')));
}

/** Writes a private (0600) file atomically. `exclusive` refuses to replace an existing file. */
export async function writePrivateFile(filename, text, { exclusive = false } = {}) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (exclusive) {
    const file = await open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await chmod(filename, 0o600);
    return;
  }
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, filename);
    await chmod(filename, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

/** Runs a command with inherited stdio. Never prints the command line (it may contain paths only). */
export function run(command, args, { cwd, env, input, stdio } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: env ?? process.env,
      stdio: stdio ?? [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    });
    if (input !== undefined) { child.stdin.end(input); }
    child.on('error', error => reject(new CliError(error.code === 'ENOENT' ? `找不到命令 ${command}` : error.message)));
    child.on('close', code => resolve(code ?? 1));
  });
}

export async function runChecked(command, args, options = {}, what = command) {
  const code = await run(command, args, options);
  if (code !== 0) fail(`${what} 失败（退出码 ${code}）`);
}

/** Captures stdout; returns { status, stdout, stderr }. */
export function capture(command, args, { cwd, env, input, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env: env ?? process.env, input, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) return { status: -1, stdout: '', stderr: String(result.error.code ?? result.error.message), error: result.error };
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function commandExists(command) {
  const probe = process.platform === 'win32' ? capture('where', [command]) : capture('sh', ['-c', `command -v "$1"`, 'sh', command]);
  return probe.status === 0;
}

export const out = (...lines) => { for (const line of lines) process.stdout.write(`${line}\n`); };
export const err = (...lines) => { for (const line of lines) process.stderr.write(`${line}\n`); };

export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// ---------- prompts ----------

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function ask(question, fallback = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    const suffix = fallback !== '' ? `（默认 ${fallback}）` : '';
    const answer = await new Promise(resolve => rl.question(`${question}${suffix}：`, resolve));
    return answer.trim() || fallback;
  } finally { rl.close(); }
}

export async function choose(question, options, fallback) {
  const labels = options.map((option, index) => `  ${index + 1}. ${option.label}`).join('\n');
  out(question, labels);
  const defaultIndex = Math.max(0, options.findIndex(option => option.value === fallback)) + 1;
  for (;;) {
    const answer = await ask('请输入序号', String(defaultIndex));
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].value;
    const byValue = options.find(option => option.value === answer);
    if (byValue) return byValue.value;
    err('输入无效，请重新选择。');
  }
}

export async function confirm(question, fallback = true) {
  const answer = (await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}]`, '')).toLowerCase();
  if (!answer) return fallback;
  return ['y', 'yes', '是', 'shi'].includes(answer);
}

/** Reads a line without echoing it. The value never reaches shell history or logs. */
export function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) { reject(new CliError('需要交互式终端才能输入密码；也可以用 --password-file 指定文件。')); return; }
    process.stdout.write(`${question}：`);
    let value = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const finish = (error) => {
      input.setRawMode(wasRaw);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(new CliError('已取消', 130));
        if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); continue; }
        if (char >= ' ') value += char;
      }
    };
    input.on('data', onData);
  });
}

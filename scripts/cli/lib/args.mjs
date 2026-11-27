// Argument parsing on top of node:util parseArgs, with Chinese errors and a few safety rules:
// secrets are never accepted as option values, and every option may be given once.
import { parseArgs as nodeParseArgs } from 'node:util';
import { CliError } from './util.mjs';

/** Options every subcommand understands. */
export const GLOBAL_OPTIONS = {
  home: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

// Never accept a plaintext secret on the command line: it would land in shell history and `ps`.
const SECRET_FLAGS = new Set(['password', 'admin-password', 'setup-key', 'api-key', 'token', 'secret']);

/**
 * Parses `argv` for one subcommand. `schema` maps option names to { type, short?, multiple? }.
 * Returns { values, positionals, rest } where `rest` holds everything after a bare `--`.
 */
export function parseCommandArgs(argv, schema = {}, { positionals: maxPositionals = 0 } = {}) {
  const terminator = argv.indexOf('--');
  const head = terminator >= 0 ? argv.slice(0, terminator) : argv;
  const rest = terminator >= 0 ? argv.slice(terminator + 1) : [];
  for (const arg of head) {
    const name = arg.startsWith('--') ? arg.slice(2).split('=')[0] : null;
    if (name && SECRET_FLAGS.has(name))
      throw new CliError(`不接受在命令行里直接传 --${name}：它会留在 shell 历史和进程列表里。请用 --password-file、环境变量或交互输入。`, 2);
  }
  const options = { ...GLOBAL_OPTIONS, ...schema };
  let parsed;
  try {
    parsed = nodeParseArgs({ args: head, options, allowPositionals: true, strict: true, tokens: true });
  } catch (error) {
    throw new CliError(translateParseError(error), 2);
  }
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name) && !options[token.name]?.multiple) throw new CliError(`--${token.name} 不能重复指定`, 2);
    seen.add(token.name);
    if (options[token.name]?.type === 'string' && typeof token.value === 'string' && !token.value.trim())
      throw new CliError(`--${token.name} 需要非空参数`, 2);
  }
  if (parsed.positionals.length > maxPositionals)
    throw new CliError(`多余的参数：${parsed.positionals.slice(maxPositionals).join(' ')}`, 2);
  return { values: parsed.values, positionals: parsed.positionals, rest };
}

function translateParseError(error) {
  const message = String(error.message ?? error);
  let match;
  if ((match = /Unknown option '([^']+)'/.exec(message))) return `未知选项 ${match[1]}（用 --help 查看可用选项）`;
  if ((match = /Option '([^']+?)(?: <value>)?' argument missing/.exec(message))) return `${match[1].split(',').pop().trim()} 需要参数`;
  if ((match = /Option '([^']+)' does not take an argument/.exec(message))) return `${match[1].split(',').pop().trim()} 不接受参数`;
  return `参数错误：${message}`;
}

/** Splits `rokbot [--home X] <command> ...` into the command and its arguments. */
export function splitCommand(argv) {
  const args = [...argv];
  const leading = [];
  while (args.length && args[0].startsWith('-')) {
    const flag = args.shift();
    leading.push(flag);
    if (flag === '--home' && args.length) leading.push(args.shift());
  }
  const command = args.shift() ?? null;
  return { command, args: [...leading, ...args] };
}

export function parsePort(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) throw new CliError(`${label} 需要 1–65535 的端口号`, 2);
  return Number(text);
}

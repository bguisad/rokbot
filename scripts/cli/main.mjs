// rokbot CLI dispatcher.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { splitCommand } from './lib/args.mjs';
import { adminCommand } from './lib/admin.mjs';
import { doctorCommand } from './lib/doctor.mjs';
import { COMMAND_HELP, helpFor, MAIN_HELP } from './lib/help.mjs';
import { initCommand } from './lib/init.mjs';
import { downCommand, logsCommand, rollbackCommand, statusCommand, upCommand, updateCommand } from './lib/ops.mjs';
import { packCommand } from './lib/pack.mjs';
import { CliError, err, out, REPO_ROOT } from './lib/util.mjs';

export const COMMANDS = {
  init: initCommand,
  up: upCommand,
  down: downCommand,
  status: statusCommand,
  logs: logsCommand,
  update: updateCommand,
  rollback: rollbackCommand,
  admin: adminCommand,
  doctor: doctorCommand,
  pack: packCommand,
};

export function cliVersion() {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

/** Runs the CLI and returns the process exit code. */
export async function main(argv = process.argv.slice(2)) {
  const { command, args } = splitCommand(argv);
  try {
    if (!command) {
      if (args.includes('--version')) { out(cliVersion()); return 0; }
      out(MAIN_HELP);
      return args.length && !args.some(arg => arg === '-h' || arg === '--help') ? 2 : 0;
    }
    if (command === 'help') {
      const topic = args.find(arg => !arg.startsWith('-'));
      if (!topic) { out(MAIN_HELP); return 0; }
      const text = helpFor(topic);
      if (!text) throw new CliError(`没有命令 ${topic}。可用命令：${Object.keys(COMMANDS).join('、')}`, 2);
      out(text);
      return 0;
    }
    if (command === 'version') { out(cliVersion()); return 0; }
    const handler = COMMANDS[command];
    if (!handler) throw new CliError(`未知命令 ${command}。可用命令：${Object.keys(COMMANDS).join('、')}（rokbot --help 查看说明）`, 2);
    if (args.includes('-h') || args.includes('--help')) {
      const terminator = args.indexOf('--');
      const helpIndex = args.findIndex(arg => arg === '-h' || arg === '--help');
      if (terminator < 0 || helpIndex < terminator) { out(COMMAND_HELP[command]); return 0; }
    }
    const result = await handler(args);
    return typeof result === 'number' ? result : 0;
  } catch (error) {
    if (error instanceof CliError) {
      err(`错误：${error.message}`);
      return error.exitCode;
    }
    err(`错误：${error?.message ?? error}`);
    if (process.env.ROKBOT_CLI_DEBUG) err(error?.stack ?? '');
    return 1;
  }
}

#!/usr/bin/env node
// Live regression check (emulator or device): no frame draws an official Bot mark while a RokBot
// avatar style is in effect. Not part of `node --test`; run against an installed, paired build:
//
//   ANDROID_SERIAL=emulator-5554 TARGET_PKG=dev.rokbot.local node android/tests/avatar-flash-e2e.mjs
//
// The companion's read-only audit (adb shell setprop log.tag.RokBotAvatarAudit DEBUG) logs, before
// each frame, how many official marks are still visible after the pre-draw pass. The scenarios are
// the ones from the field report: cold start, switching chats, background -> foreground, the
// Create New Bot page (animated mark), a configuration change (dark mode), Activity recreation
// ("Don't keep activities") and process death. Tap coordinates assume a 1080 x 2400 portrait screen
// with the Bot list on top (the + button at the top right). Set OUT_DIR to keep screenshots.
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PKG = process.env.TARGET_PKG || 'dev.rokbot.local';
const MAIN = `${PKG}/ai.x.grok.bot.MainActivity`;
const OUT_DIR = process.env.OUT_DIR || '';
const AUDIT = 'RokBotAvatarAudit';

const adb = (...args) => cp.execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const adbSafe = (...args) => { try { return adb(...args); } catch { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mark = name => adbSafe('shell', 'log', '-t', 'IconfixScenario', name);
const shot = name => {
  if (!OUT_DIR) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), cp.execFileSync('adb', ['-s', SERIAL, 'exec-out', 'screencap', '-p']));
};
const tap = (x, y) => adbSafe('shell', 'input', 'tap', String(x), String(y));
const key = code => adbSafe('shell', 'input', 'keyevent', String(code));
const start = () => adbSafe('shell', 'am', 'start', '-n', MAIN);
const coldStart = async () => { adbSafe('shell', 'am', 'force-stop', PKG); await sleep(1000); start(); await sleep(12000); };

const SCENARIOS = [
  ['cold-start', async () => { for (let i = 0; i < 3; i++) await coldStart(); shot('cold-start'); }],
  ['switch-chats', async () => {
    for (const y of [416, 598, 808, 1858, 416, 1018]) { tap(500, y); await sleep(3000); if (y === 598) shot('chat'); key(4); await sleep(2000); }
  }],
  ['background-foreground', async () => { for (let i = 0; i < 3; i++) { key(3); await sleep(3000); start(); await sleep(3000); } }],
  ['scroll', async () => {
    for (let i = 0; i < 3; i++) {
      adbSafe('shell', 'input', 'swipe', '540', '1800', '540', '600', '300'); await sleep(1500);
      adbSafe('shell', 'input', 'swipe', '540', '600', '540', '1800', '300'); await sleep(1500);
    }
  }],
  ['create-page-animated', async () => { for (let i = 0; i < 2; i++) { tap(976, 209); await sleep(5000); if (!i) shot('create'); key(4); await sleep(2000); } }],
  ['dark-mode-config-change', async () => {
    adbSafe('shell', 'cmd', 'uimode', 'night', 'yes'); await sleep(6000); shot('dark');
    adbSafe('shell', 'cmd', 'uimode', 'night', 'no'); await sleep(6000);
  }],
  ['dont-keep-activities', async () => {
    adbSafe('shell', 'settings', 'put', 'global', 'always_finish_activities', '1');
    try { for (let i = 0; i < 2; i++) { key(3); await sleep(3000); start(); await sleep(8000); } }
    finally { adbSafe('shell', 'settings', 'put', 'global', 'always_finish_activities', '0'); }
  }],
  ['process-death-restore', async () => { key(3); await sleep(2000); adbSafe('shell', 'am', 'kill', PKG); await sleep(2000); start(); await sleep(12000); }],
];

async function main() {
  adb('shell', 'setprop', `log.tag.${AUDIT}`, 'DEBUG');
  await coldStart();
  adbSafe('logcat', '-c');
  for (const [name, run] of SCENARIOS) { mark(name); await run(); }
  mark('end');
  const log = adbSafe('logcat', '-d', '-v', 'time', '-s', 'IconfixScenario:I', `${AUDIT}:D`);
  if (OUT_DIR) fs.writeFileSync(path.join(OUT_DIR, 'logcat.txt'), log);
  const frames = new Map(SCENARIOS.map(([n]) => [n, 0]));
  let current = 'setup';
  for (const line of log.split('\n')) {
    const m = line.match(/IconfixScenario.*?: (\S+)/);
    if (m) { current = m[1]; continue; }
    if (/official marks drawn this frame: \d+/.test(line)) frames.set(current, (frames.get(current) || 0) + 1);
  }
  let bad = 0;
  for (const [name, n] of frames) { console.log(`${n === 0 ? 'ok  ' : 'FAIL'} ${name}: ${n} frame(s) drew an official mark`); bad += n; }
  if (bad) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });

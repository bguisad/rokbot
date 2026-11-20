import { execFile, execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WIN_INTEGRITY_RE = /\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-f]{64})"\}\]/g;
const MAX_SYMLINK_HOPS = 40;
export const WINDOWS_INSTALLER_RECEIPTS = ['.rokbot-installation.json', '.grokbot-installation.json'];

function addCandidateDir(candidates, dir, isWin32) {
  if (typeof dir !== 'string' || !dir.trim()) return;
  const key = isWin32 ? dir.toLowerCase() : dir;
  if (!candidates.has(key)) {
    candidates.set(key, dir);
  }
}

async function resolveInitialRoot(rootStr, isWin32) {
  if (!rootStr) {
    try {
      return { cur: await realpath(process.cwd()), state: 'dir', failedClosed: false };
    } catch (err) {
      if (err?.code !== 'ENOENT') return { cur: '', state: 'dir', failedClosed: true };
      return { cur: path.resolve(process.cwd()), state: 'missing', failedClosed: false };
    }
  }
  if (!isWin32) {
    return { cur: '/', state: 'dir', failedClosed: false };
  }
  if (rootStr.startsWith('\\\\?\\') || rootStr.startsWith('\\\\.\\')) {
    const normalizedRoot = /[\\/]$/.test(rootStr) ? rootStr : `${rootStr}\\`;
    return { cur: normalizedRoot, state: 'dir', failedClosed: false };
  }
  const resolvedRoot = path.resolve(rootStr);
  try {
    return { cur: await realpath(resolvedRoot), state: 'dir', failedClosed: false };
  } catch (err) {
    if (err?.code !== 'ENOENT') return { cur: '', state: 'dir', failedClosed: true };
    return { cur: resolvedRoot, state: 'missing', failedClosed: false };
  }
}

function resolveSymlinkRoot(targetRoot, cur, isWin32) {
  if (!isWin32) return '/';
  if (targetRoot.startsWith('\\\\?\\') || targetRoot.startsWith('\\\\.\\')) {
    return /[\\/]$/.test(targetRoot) ? targetRoot : `${targetRoot}\\`;
  }
  if (targetRoot === '\\' || targetRoot === '/') {
    const curRoot = path.parse(cur).root;
    return curRoot || path.resolve(targetRoot);
  }
  return path.resolve(targetRoot);
}

async function collectPathCandidates(rawPath, candidates) {
  const isWin32 = process.platform === 'win32';
  const sepRe = isWin32 ? /[\\/]+/ : /\/+/;
  const trailingSepRe = isWin32 ? /[\\/]$/ : /\/$/;
  const trimmed = rawPath.trim();

  try {
    await lstat(trimmed);
  } catch (err) {
    if (err?.code !== 'ENOENT') return true;
  }

  const parsed = path.parse(trimmed);
  const rest = trimmed.slice(parsed.root.length);
  const origTrailingSep = rest.length > 0 && trailingSepRe.test(rest);
  const initialSegments = rest.split(sepRe).filter(Boolean);

  const rootInit = await resolveInitialRoot(parsed.root, isWin32);
  if (rootInit.failedClosed) return true;

  let cur = rootInit.cur;
  let curState = rootInit.state;
  let symlinkHops = 0;

  // Stack holds segments in reverse order so pop() yields the next segment left-to-right.
  const stack = [];
  if (origTrailingSep) stack.push('.');
  for (let i = initialSegments.length - 1; i >= 0; i -= 1) {
    stack.push(initialSegments[i]);
  }

  while (stack.length > 0) {
    const seg = stack.pop();
    if (curState === 'file') {
      return true;
    }

    if (seg === '.') {
      continue;
    }

    if (seg === '..') {
      addCandidateDir(candidates, cur, isWin32);
      cur = path.dirname(cur);
      addCandidateDir(candidates, cur, isWin32);
      continue;
    }

    if (curState === 'missing') {
      cur = path.join(cur, seg);
      continue;
    }

    const nextLex = path.join(cur, seg);
    let st;
    try {
      st = await lstat(nextLex);
    } catch (err) {
      if (err?.code !== 'ENOENT') return true;
      addCandidateDir(candidates, cur, isWin32);
      cur = nextLex;
      curState = 'missing';
      continue;
    }

    if (st.isSymbolicLink()) {
      addCandidateDir(candidates, cur, isWin32);
      symlinkHops += 1;
      if (symlinkHops > MAX_SYMLINK_HOPS) return true;

      let target;
      try {
        target = await readlink(nextLex);
      } catch {
        return true;
      }

      if (isWin32) {
        if (target.startsWith('\\??\\UNC\\')) {
          target = `\\\\${target.slice(8)}`;
        } else if (target.startsWith('\\??\\')) {
          target = target.slice(4);
        }
      }

      const targetParsed = path.parse(target);
      const targetRest = target.slice(targetParsed.root.length);
      const targetTrailingSep = targetRest.length > 0 && trailingSepRe.test(targetRest);
      const targetSegments = targetRest.split(sepRe).filter(Boolean);

      if (targetParsed.root) {
        cur = resolveSymlinkRoot(targetParsed.root, cur, isWin32);
        curState = 'dir';
      }

      if (targetTrailingSep) stack.push('.');
      for (let i = targetSegments.length - 1; i >= 0; i -= 1) {
        stack.push(targetSegments[i]);
      }
      continue;
    }

    cur = nextLex;
    curState = st.isDirectory() ? 'dir' : 'file';
  }

  if (curState === 'dir') {
    addCandidateDir(candidates, cur, isWin32);
  }
  addCandidateDir(candidates, path.dirname(cur), isWin32);
  addCandidateDir(candidates, path.dirname(path.resolve(trimmed)), isWin32);

  return false;
}

export async function isWindowsInstallerManaged(opts = {}) {
  if (!opts || typeof opts !== 'object') return false;
  const { resourcesDir, execPath } = opts;
  const candidates = new Map();

  for (const raw of [execPath, resourcesDir]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const failedClosed = await collectPathCandidates(raw, candidates);
    if (failedClosed) return true;
  }

  for (const dir of candidates.values()) {
    for (const receipt of WINDOWS_INSTALLER_RECEIPTS) {
      try {
        await lstat(path.join(dir, receipt));
        return true;
      } catch (err) {
        if (err?.code !== 'ENOENT') return true;
      }
    }
  }

  return false;
}

export function replaceWindowsAsarIntegrityHex(buffer, expected, replacement) {
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(replacement)) {
    throw new Error('Invalid ASAR header hash format');
  }
  const text = buffer.toString('latin1');
  const matches = [...text.matchAll(WIN_INTEGRITY_RE)];
  if (matches.length !== 1) throw new Error('Embedded Windows ASAR integrity record not found');
  if (matches[0][1] !== expected) throw new Error('Embedded Windows ASAR integrity mismatch');
  const out = Buffer.from(buffer);
  const at = matches[0].index + matches[0][0].indexOf(expected);
  out.write(replacement, at, 64, 'latin1');
  return out;
}

export async function canApplyAsarUpdate(opts = {}) {
  if (!opts || typeof opts !== 'object') return false;
  const { resourcesDir, execPath, platform = process.platform } = opts;
  if (typeof resourcesDir !== 'string' || !resourcesDir.trim() || typeof execPath !== 'string' || !execPath.trim()) {
    return false;
  }
  const trimmedResourcesDir = resourcesDir.trim();
  const trimmedExecPath = execPath.trim();

  try {
    await access(trimmedResourcesDir, constants.W_OK);
    if (!(await stat(trimmedResourcesDir)).isDirectory()) return false;
  } catch {
    return false;
  }

  if (platform === 'win32') {
    if (await isWindowsInstallerManaged({ resourcesDir: trimmedResourcesDir, execPath: trimmedExecPath })) {
      return false;
    }
    try {
      const realExecPath = await realpath(trimmedExecPath);
      if (!(await stat(realExecPath)).isFile()) return false;
      await access(path.dirname(realExecPath), constants.W_OK);
      const exe = await readFile(realExecPath);
      const matches = [...exe.toString('latin1').matchAll(WIN_INTEGRITY_RE)];
      return matches.length === 1;
    } catch {
      return false;
    }
  }

  if (platform === 'darwin') {
    let realResourcesDir;
    try {
      realResourcesDir = await realpath(trimmedResourcesDir);
    } catch {
      return false;
    }
    const appBundle = path.resolve(realResourcesDir, '../..');
    if (!appBundle.endsWith('.app') || appBundle.startsWith('/Volumes/') || appBundle.includes('/AppTranslocation/')) {
      return false;
    }
    try {
      await access(path.dirname(appBundle), constants.W_OK);
      await access('/usr/bin/codesign', constants.X_OK);
      await access('/usr/bin/plutil', constants.X_OK);
      const { stderr } = await execFileAsync('/usr/bin/codesign', ['-dv', appBundle], { encoding: 'utf8' });
      return /^Signature=adhoc$/m.test(stderr);
    } catch {
      return false;
    }
  }

  return false;
}

export async function applyAsarUpdateAndRestart(opts = {}) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('Invalid ASAR update options');
  }
  const {
    asarFile,
    headerSha256,
    baseHeaderSha256,
    version,
    resourcesDir,
    execPath,
    quitApp,
    platform = process.platform,
  } = opts;
  if (platform !== 'win32' && platform !== 'darwin') {
    throw new Error(`ASAR incremental swap is unsupported on ${platform}`);
  }
  if (typeof asarFile !== 'string' || !asarFile.trim()) {
    throw new Error('Missing asarFile for ASAR update');
  }
  const trimmedAsarFile = asarFile.trim();

  let trimmedResourcesDir = '';
  let trimmedExecPath = '';
  if (platform === 'win32') {
    if (typeof resourcesDir !== 'string' || !resourcesDir.trim() || typeof execPath !== 'string' || !execPath.trim()) {
      throw new Error('Missing resourcesDir or execPath for Windows ASAR update');
    }
    trimmedResourcesDir = resourcesDir.trim();
    trimmedExecPath = execPath.trim();
    if (await isWindowsInstallerManaged({ resourcesDir: trimmedResourcesDir, execPath: trimmedExecPath })) {
      throw new Error('In-place ASAR update is disabled for Windows installer-managed installations');
    }
  } else {
    if (typeof resourcesDir !== 'string' || !resourcesDir.trim()) {
      throw new Error('Missing resourcesDir for ASAR update');
    }
    trimmedResourcesDir = resourcesDir.trim();
  }

  const asarInfo = await stat(trimmedAsarFile);
  if (!asarInfo.isFile()) {
    throw new Error('Missing asarFile for ASAR update');
  }

  let resolvedResourcesDir;
  let resolvedExecPath;
  if (platform === 'win32') {
    const resInfo = await stat(trimmedResourcesDir);
    if (!resInfo.isDirectory()) {
      throw new Error('Invalid resourcesDir for Windows ASAR update');
    }
    const exeInfo = await stat(trimmedExecPath);
    if (!exeInfo.isFile()) {
      throw new Error('Invalid execPath for Windows ASAR update');
    }
    resolvedResourcesDir = await realpath(trimmedResourcesDir);
    resolvedExecPath = await realpath(trimmedExecPath);
  }

  const stageRoot = path.join(path.dirname(trimmedAsarFile), `apply-${version}-${process.pid}`);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  if (platform === 'win32') {
    try {
      const stagedExe = path.join(stageRoot, path.basename(resolvedExecPath));
      const stagedAsar = path.join(stageRoot, 'app.asar');
      const updatedExe = replaceWindowsAsarIntegrityHex(await readFile(resolvedExecPath), baseHeaderSha256, headerSha256);
      await writeFile(stagedExe, updatedExe);
      await copyFile(trimmedAsarFile, stagedAsar);

      const targetAsar = path.join(resolvedResourcesDir, 'app.asar');
      const cmdScript = path.join(stageRoot, 'apply-update.cmd');
      const esc = s => String(s).replace(/"/g, '');
      const bat = [
        '@echo off',
        'setlocal',
        `set "PID=${process.pid}"`,
        ':waitloop',
        'tasklist /FI "PID eq %PID%" 2>NUL | findstr /R /C:" %PID% " >NUL',
        'if not errorlevel 1 (',
        '  timeout /t 1 /nobreak >NUL',
        '  goto waitloop',
        ')',
        'timeout /t 1 /nobreak >NUL',
        `for /L %%i in (1,1,10) do (`,
        `  copy /Y "${esc(stagedAsar)}" "${esc(targetAsar)}" >NUL 2>&1 && copy /Y "${esc(stagedExe)}" "${esc(resolvedExecPath)}" >NUL 2>&1 && goto copied`,
        '  timeout /t 1 /nobreak >NUL',
        ')',
        ':copied',
        `start "" "${esc(resolvedExecPath)}"`,
        `rmdir /S /Q "${esc(stageRoot)}"`,
      ].join('\r\n');
      await writeFile(cmdScript, bat, 'utf8');
      const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmdScript}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      child.unref();
      quitApp();
      return;
    } catch (err) {
      await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  if (platform === 'darwin') {
    const swapScript = path.join(stageRoot, 'apply-update.sh');
    try {
      const realResourcesDir = await realpath(trimmedResourcesDir);
      const appBundle = path.resolve(realResourcesDir, '../..');
      const stagedApp = path.join(stageRoot, path.basename(appBundle));
      const entitlementsPath = path.join(stageRoot, 'entitlements.plist');
      execFileSync('/usr/bin/ditto', [appBundle, stagedApp], { stdio: 'ignore' });
      await copyFile(trimmedAsarFile, path.join(stagedApp, 'Contents/Resources/app.asar'));

      const infoPlistPath = path.join(stagedApp, 'Contents/Info.plist');
      const infoJson = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPlistPath], { encoding: 'utf8' }));
      infoJson.ElectronAsarIntegrity = {
        ...(infoJson.ElectronAsarIntegrity ?? {}),
        'Resources/app.asar': { algorithm: 'SHA256', hash: headerSha256 },
      };
      await writeFile(infoPlistPath, JSON.stringify(infoJson), 'utf8');
      execFileSync('/usr/bin/plutil', ['-convert', 'xml1', infoPlistPath], { stdio: 'ignore' });

      const entitlementsXml = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', appBundle], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      await writeFile(entitlementsPath, entitlementsXml, 'utf8');
      execFileSync('/usr/bin/codesign', [
        '--force', '--deep', '--sign', '-', '--options', 'runtime', '--timestamp=none',
        '--entitlements', entitlementsPath, stagedApp,
      ], { timeout: 120000, stdio: 'ignore' });
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp], { timeout: 60000, stdio: 'ignore' });

      const backupApp = `${appBundle}.backup-${process.pid}`;
      const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const sh = [
        '#!/bin/sh',
        `PID=${process.pid}`,
        'while kill -0 "$PID" 2>/dev/null; do sleep 0.1; done',
        `APP=${q(appBundle)}`,
        `STAGED=${q(stagedApp)}`,
        `BACKUP=${q(backupApp)}`,
        `ROOT=${q(stageRoot)}`,
        'rm -rf "$BACKUP"',
        'if mv "$APP" "$BACKUP"; then',
        '  if mv "$STAGED" "$APP"; then',
        '    rm -rf "$BACKUP" "$ROOT"',
        '    open -n "$APP"',
        '  else',
        '    mv "$BACKUP" "$APP" 2>/dev/null || true',
        '    rm -rf "$ROOT"',
        '  fi',
        'else',
        '  rm -rf "$ROOT"',
        'fi',
      ].join('\n');
      await writeFile(swapScript, sh, { mode: 0o755 });
    } catch (err) {
      await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const child = spawn('/bin/sh', [swapScript], { detached: true, stdio: 'ignore' });
    child.unref();
    quitApp();
    return;
  }

  await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  throw new Error(`ASAR incremental swap is unsupported on ${platform}`);
}

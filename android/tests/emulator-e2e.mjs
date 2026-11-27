#!/usr/bin/env node
// Live Android Emulator E2E verification harness against MockHostServer.
// Targets the official patched APK (`output/rokbot-android-patched.apk`, `dev.rokbot.local`).
// Uses `dumpsys activity top` + `screencap -p` for React Native Fabric `MainActivity`
// (avoiding `uiautomator dump` hangs on animated RN Fabric views).
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANDROID_NS, parseAxml } from '../patchers/manifest.mjs';
import { entryBytes, readZip } from '../patchers/signing.mjs';
import { MockHostServer } from './mock-host.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SDK_ROOT = process.env.ANDROID_HOME || '/Users/lianqishi/Library/Android/sdk';
const ADB = path.join(SDK_ROOT, 'platform-tools/adb');
const TARGET_PKG = process.env.TARGET_PKG || process.env.RN_TARGET_PKG || 'dev.rokbot.local';
const PATCHED_APK_PATH = process.env.PATCHED_APK || path.resolve(__dirname, '../output/rokbot-android-patched.apk');
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';

function adb(...args) {
  return cp.execFileSync(ADB, ['-s', SERIAL, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function adbSafe(...args) {
  try {
    return adb(...args);
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '');
  }
}

function adbAsync(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      ADB,
      ['-s', SERIAL, ...args],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

async function adbSafeAsync(args, timeoutMs = 15000) {
  try {
    return await adbAsync(args, timeoutMs);
  } catch (err) {
    return (err.stdout || '') + (err.stderr || '');
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function capturePng(localPath) {
  adb('shell', 'screencap', '-p', '/data/local/tmp/emu_cap.png');
  adb('pull', '/data/local/tmp/emu_cap.png', localPath);
  if (!fs.existsSync(localPath) || fs.statSync(localPath).size === 0) {
    throw new Error(`Screenshot capture failed or empty: ${localPath}`);
  }
}

function isImeShown() {
  const ime = adbSafe('shell', 'dumpsys', 'input_method');
  return /\bmInputShown=true\b/.test(ime);
}

function isTextInputFocused() {
  const ime = adbSafe('shell', 'dumpsys', 'input_method');
  if (/\bmInputShown=true\b/.test(ime)) return true;
  const imeList = adbSafe('shell', 'ime', 'list', '-s').trim();
  return imeList.length === 0 && /\bmServedView=.*(?:EditText|textinput)/i.test(ime);
}

function dismissImeIfShown() {
  if (isImeShown()) {
    adb('shell', 'input', 'keyevent', '4');
    return true;
  }
  return false;
}

export function resolveLauncherComponentFromApk(apkPath, targetPkg = null) {
  if (!apkPath || !fs.existsSync(apkPath)) return null;
  try {
    const zip = readZip(fs.readFileSync(apkPath));
    const mf = zip.entries.find(e => e.name === 'AndroidManifest.xml');
    if (!mf) return null;
    const ast = parseAxml(entryBytes(mf));
    const root = ast.rootNodes.find(n => n.name === 'manifest');
    if (!root) return null;
    const manifestPkg = (root.attributes || []).find(a => a.name === 'package' && !a.namespace)?.value;
    const pkg = targetPkg || (manifestPkg ? String(manifestPkg) : null);
    const app = (root.children || []).find(n => n.name === 'application');
    if (!app || !pkg) return null;

    const getAttr = (node, name) =>
      (node.attributes || []).find(a => a.name === name && (!a.namespace || a.namespace === ANDROID_NS))?.value;
    const hasMainLauncher = node =>
      (node.children || []).some(
        f =>
          f.name === 'intent-filter' &&
          (f.children || []).some(c => c.name === 'action' && getAttr(c, 'name') === 'android.intent.action.MAIN') &&
          (f.children || []).some(c => c.name === 'category' && getAttr(c, 'name') === 'android.intent.category.LAUNCHER')
      );

    let actName = null;
    const act = (app.children || []).find(c => c.name === 'activity' && hasMainLauncher(c));
    if (act) {
      actName = getAttr(act, 'name');
    } else {
      const alias = (app.children || []).find(c => c.name === 'activity-alias' && hasMainLauncher(c));
      if (alias) actName = getAttr(alias, 'targetActivity') || getAttr(alias, 'name');
    }
    if (!actName) return null;
    const rawName = String(actName);
    const basePkg = manifestPkg ? String(manifestPkg) : pkg;
    const fqcn = rawName.startsWith('.')
      ? `${basePkg}${rawName}`
      : (rawName.includes('.') ? rawName : `${basePkg}.${rawName}`);
    return `${pkg}/${fqcn}`;
  } catch {
    return null;
  }
}

function resolveLauncherComponent(pkg) {
  const out = adbSafe(
    'shell',
    'cmd',
    'package',
    'resolve-activity',
    '--brief',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
    '-p',
    pkg
  );
  const compLines = out
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^[^\s/]+\/[^\s/]+$/.test(l));
  const comp = compLines.find(l => l.startsWith(`${pkg}/`)) || compLines[0];
  return comp || resolveLauncherComponentFromApk(PATCHED_APK_PATH, pkg) || `${pkg}/ai.x.grok.bot.MainActivity`;
}

export function parseViewHierarchy(block) {
  const vhMatch = /^([ \t]*)View Hierarchy:\s*$/m.exec(String(block || ''));
  if (!vhMatch) return [];
  const vhIndent = vhMatch[1].length;
  const lines = String(block).slice(vhMatch.index + vhMatch[0].length).split(/\r?\n/);
  const stack = [];
  const views = [];
  const viewLineRe = /^(\s*)([^\s{]+)\{([0-9a-fA-F]+)\s+([^\s]+)\s+([^\s]+)\s+(-?\d+),(-?\d+)-(-?\d+),(-?\d+)([^}]*)\}/;

  for (const line of lines) {
    if (!line.trim()) continue;
    const indentMatch = /^(\s*)/.exec(line);
    const indent = indentMatch ? indentMatch[1].length : 0;
    if (indent <= vhIndent) break;

    const m = viewLineRe.exec(line);
    if (!m) continue;

    const className = m[2];
    const hash = m[3];
    const flags1 = m[4];
    const flags2 = m[5];
    const l = Number(m[6]);
    const t = Number(m[7]);
    const r = Number(m[8]);
    const b = Number(m[9]);
    const meta = m[10] || '';

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : { absX: 0, absY: 0, visible: true };
    const x1 = parent.absX + l;
    const y1 = parent.absY + t;
    const x2 = parent.absX + r;
    const y2 = parent.absY + b;
    const visible = parent.visible && flags1[0] === 'V';

    stack.push({ indent, absX: x1, absY: y1, visible });

    const idMatch = /#([0-9a-fA-F]+)(?:\s+(\S+))?/.exec(meta);
    views.push({
      className,
      hash,
      flags1,
      flags2,
      visible,
      focusable: flags1[1] === 'F',
      enabled: flags1[2] === 'E',
      clickable: flags1[6] === 'C',
      longClickable: flags1[7] === 'L',
      idHex: idMatch ? idMatch[1] : null,
      resId: idMatch && idMatch[2] && !idMatch[2].startsWith('aid=') ? idMatch[2] : null,
      rect: { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 },
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
    });
  }
  return views;
}

export function parseTopActivityOutput(raw) {
  const text = String(raw || '');
  const matches = [...text.matchAll(/^[ \t]+ACTIVITY\s+(\S+)\s+([0-9a-fA-F]+)(.*)$/gm)];
  if (matches.length === 0) {
    return { activity: '', packageName: '', className: '', resumed: false, views: [], raw: text };
  }

  const sections = matches.map((m, idx) => {
    const start = m.index;
    let end = idx + 1 < matches.length ? matches[idx + 1].index : text.length;
    const nextTaskOffset = text.slice(start + m[0].length, end).search(/^\s*TASK\s+/m);
    if (nextTaskOffset >= 0) {
      end = start + m[0].length + nextTaskOffset;
    }
    const block = text.slice(start, end);
    const comp = m[1];
    const slash = comp.indexOf('/');
    const packageName = slash >= 0 ? comp.slice(0, slash) : '';
    let className = slash >= 0 ? comp.slice(slash + 1) : comp;
    if (className.startsWith('.')) className = packageName + className;
    const resumed = /\bmResumed=true\b/.test(block);
    return { activity: comp, packageName, className, resumed, raw: block };
  });

  const chosen = sections.find(s => s.resumed) || sections[sections.length - 1];
  const views = parseViewHierarchy(chosen.raw);
  return { ...chosen, views };
}

async function dumpTopActivity() {
  return parseTopActivityOutput(await adbSafeAsync(['shell', 'dumpsys', 'activity', 'top'], 10000));
}

async function waitForTopActivity(predicate, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastTop = null;
  while (Date.now() < deadline) {
    lastTop = await dumpTopActivity();
    if (predicate(lastTop)) return lastTop;
    await sleep(350);
  }
  try {
    capturePng('/tmp/emu_e2e_top_timeout.png');
  } catch {}
  throw new Error(
    `Timed out waiting for top activity (${description}). Last top: activity=${lastTop?.activity} resumed=${lastTop?.resumed} views=${lastTop?.views?.length ?? 0}`
  );
}

async function dumpNativeXml() {
  const top = await dumpTopActivity();
  if (!top.className.startsWith('dev.rokbot.nativeapp.')) {
    // Guard: never invoke uiautomator dump when React Native Fabric views are active.
    return '';
  }
  for (let i = 0; i < 2; i++) {
    const out = await adbSafeAsync(
      [
        'shell',
        'rm -f /data/local/tmp/uidump.xml && timeout 4 uiautomator dump /data/local/tmp/uidump.xml >/dev/null 2>&1 && cat /data/local/tmp/uidump.xml',
      ],
      6000
    );
    const idx = out.indexOf('<?xml');
    if (idx !== -1) return out.slice(idx);
    await sleep(250);
  }
  return '';
}

function decodeXmlEntities(str) {
  const map = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    '#10': '\n',
    '#13': '\r',
    '#xa': '\n',
    '#xd': '\r',
  };
  return String(str).replace(/&(amp|quot|apos|lt|gt|#10|#13|#xA|#xD);/gi, (full, ent) => {
    const key = ent.toLowerCase();
    return map[key] !== undefined ? map[key] : full;
  });
}

export function parseNodes(xml) {
  const nodes = [];
  for (const m of String(xml || '').matchAll(/<node\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
      const rawVal = a[2] !== undefined ? a[2] : a[3];
      attrs[a[1]] = decodeXmlEntities(rawVal);
    }
    if (attrs.bounds) {
      const bm = attrs.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (bm) {
        const [, x1, y1, x2, y2] = bm.map(Number);
        attrs.cx = Math.round((x1 + x2) / 2);
        attrs.cy = Math.round((y1 + y2) / 2);
        attrs.rect = { x1, y1, x2, y2 };
      }
    }
    nodes.push(attrs);
  }
  return nodes;
}

export function extractActiveNotificationsText(dump) {
  const text = String(dump || '');
  // Exclude Notification History / Archive sections if appended after Notification List
  const historyIdx = text.search(/^\s*(?:Notification History|Historical notifications|Archived notifications|Event log)\b/im);
  return historyIdx >= 0 ? text.slice(0, historyIdx) : text;
}

async function waitForNode(predicate, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastNodes = [];
  let lastXml = '';
  while (Date.now() < deadline) {
    lastXml = await dumpNativeXml();
    lastNodes = parseNodes(lastXml);
    const hit = lastNodes.find(predicate);
    if (hit) return { node: hit, nodes: lastNodes, xml: lastXml };
    await sleep(350);
  }
  const top = await dumpTopActivity();
  try {
    capturePng('/tmp/emu_e2e_node_timeout.png');
  } catch {}
  const texts = lastNodes.map(n => n.text || n['content-desc']).filter(Boolean);
  throw new Error(
    `Timed out waiting for UI node (${description}) on ${top.activity}. Visible: ${JSON.stringify(texts.slice(0, 35))}\nXML: ${lastXml}`
  );
}

async function waitForCondition(predicate, description, timeoutMs = 8000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastVal = null;
  while (Date.now() < deadline) {
    lastVal = await predicate();
    if (lastVal) return lastVal;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for condition: ${description}`);
}

function tap(node) {
  adb('shell', 'input', 'tap', String(node.cx), String(node.cy));
}

async function tapNodeWithScroll(predicate, description, timeoutMs = 15000) {
  let res = await waitForNode(predicate, description, timeoutMs);
  const rootRect = res.nodes[0]?.rect || { x1: 0, y1: 0, x2: 1080, y2: 1920 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const { node } = res;
    const offscreenBottom = node.cy >= rootRect.y2 - 24 || (node['visible-to-user'] === 'false' && node.cy > rootRect.y2 * 0.65);
    const offscreenTop = node.cy <= rootRect.y1 + 24;
    if (!offscreenBottom && !offscreenTop) break;
    const sx = Math.round((rootRect.x1 + rootRect.x2) / 2);
    const yHigh = Math.round(rootRect.y1 + (rootRect.y2 - rootRect.y1) * 0.72);
    const yLow = Math.round(rootRect.y1 + (rootRect.y2 - rootRect.y1) * 0.28);
    if (offscreenBottom) {
      adb('shell', 'input', 'swipe', String(sx), String(yHigh), String(sx), String(yLow), '300');
    } else {
      adb('shell', 'input', 'swipe', String(sx), String(yLow), String(sx), String(yHigh), '300');
    }
    await sleep(350);
    res = await waitForNode(predicate, description, 5000);
  }
  tap(res.node);
  return res;
}

function typeText(text) {
  // Escape spaces as %s for `adb shell input text`
  const escaped = text.replace(/ /g, '%s').replace(/([()&|;<>$`"'\\])/g, '\\$1');
  adb('shell', 'input', 'text', escaped);
}

function isMainActivity(top) {
  return Boolean(top && top.resumed && top.packageName === TARGET_PKG && top.className.endsWith('.MainActivity'));
}

function isCompanionActivity(top, simpleName) {
  return Boolean(top && top.resumed && top.packageName === TARGET_PKG && top.className === `dev.rokbot.nativeapp.${simpleName}`);
}

export function findTopLeftCornerButton(views) {
  return (
    (views || [])
      .filter(
        v =>
          v.visible &&
          v.clickable &&
          v.rect &&
          v.rect.x1 < 150 &&
          v.rect.y1 < 350 &&
          v.rect.w >= 40 &&
          v.rect.w <= 200 &&
          v.rect.h >= 40 &&
          v.rect.h <= 200
      )
      .sort((a, b) => a.rect.x1 - b.rect.x1)[0] || null
  );
}

export function isBotsListReady(top) {
  if (!isMainActivity(top) || !Array.isArray(top.views)) return false;
  const avatarBtn = findTopLeftCornerButton(top.views);
  if (!avatarBtn) return false;
  const avatarCy = avatarBtn.cy ?? Math.round((avatarBtn.rect.y1 + avatarBtn.rect.y2) / 2);

  const hasBotsRow = top.views.some(
    v =>
      v.visible &&
      v.clickable &&
      v.rect &&
      v.rect.w >= 700 &&
      v.rect.h >= 120 &&
      v.rect.h <= 340 &&
      v.rect.y1 >= 200 &&
      v.rect.y1 <= 1400
  );
  if (!hasBotsRow) return false;

  const topRightBtns = top.views.filter(
    v =>
      v.visible &&
      v.clickable &&
      v.rect &&
      v.rect.x1 >= 700 &&
      v.rect.y1 < 350 &&
      v.rect.w >= 40 &&
      v.rect.w <= 240 &&
      v.rect.h >= 40 &&
      v.rect.h <= 240
  );
  const distinctTopRight = [];
  for (const btn of topRightBtns) {
    const cx = btn.cx ?? Math.round((btn.rect.x1 + btn.rect.x2) / 2);
    const cy = btn.cy ?? Math.round((btn.rect.y1 + btn.rect.y2) / 2);
    if (Math.abs(cy - avatarCy) > 45) continue;
    if (!distinctTopRight.some(p => Math.hypot(p.cx - cx, p.cy - cy) < 40)) {
      distinctTopRight.push({ cx, cy });
    }
  }
  return distinctTopRight.length >= 2;
}

export function findNotificationsHostSwitchCandidates(top, { maxY2 = 2260 } = {}) {
  const allViews = top?.views || [];
  const activeStart = allViews.reduce(
    (last, v, idx) => (v.className.startsWith('com.swmansion.rnscreens.') && v.rect.h >= 1500 ? idx : last),
    0
  );
  const views = allViews.slice(activeStart);
  return views
    .filter(v => v.visible && v.className.includes('HostView') && v.rect.x1 >= 600 && v.rect.y1 >= 300 && v.rect.y2 <= maxY2)
    .map(hv => {
      const labelCount = views.filter(
        tv => tv.visible && tv.className.includes('text') && Math.abs(tv.cy - hv.cy) < 110 && tv.rect.x1 < 300
      ).length;
      return { hv, labelCount };
    })
    .sort((a, b) => {
      // Flattened NotificationsRow has a single title label (labelCount === 1); toggles with subtitles have >= 2.
      if ((a.labelCount === 1) !== (b.labelCount === 1)) return a.labelCount === 1 ? -1 : 1;
      return b.hv.cy - a.hv.cy;
    });
}

async function run() {
  if (!fs.existsSync(PATCHED_APK_PATH)) {
    throw new Error(
      `Patched APK not found at ${PATCHED_APK_PATH}. Run patch-android.mjs --input-apk <official.xapk> --output-apk ${PATCHED_APK_PATH} first.`
    );
  }

  adbSafe('logcat', '-c');

  const host = new MockHostServer({
    port: Number(process.env.MOCK_HOST_PORT || 19191),
    pairingKey: 'ABCDEF',
    publicUrl: 'http://127.0.0.1:19999',
    realHostProtocol: true,
  });
  await host.start();
  const port = host.actualPort;
  const hostUrl = `http://127.0.0.1:${port}`;
  console.log(`[E2E] MockHostServer started on ${hostUrl} (target=${TARGET_PKG}, apk=${PATCHED_APK_PATH})`);

  try {
    adb('reverse', `tcp:${port}`, `tcp:${port}`);

    console.log('\n[E2E] Installing & testing official patched APK...');
    adbSafe('shell', 'am', 'force-stop', TARGET_PKG);
    adb('install', '-r', PATCHED_APK_PATH);
    adb('shell', 'pm', 'clear', TARGET_PKG);
    adbSafe('shell', 'pm', 'grant', TARGET_PKG, 'android.permission.POST_NOTIFICATIONS');
    adb('shell', 'pm', 'grant', TARGET_PKG, 'android.permission.RECORD_AUDIO');

    const launcherComponent = resolveLauncherComponent(TARGET_PKG);

    adbSafe('logcat', '-c');

    // 1. Cold launch MainActivity -> tap RN Onboarding "Connect to Host" CTA -> PairingActivity
    console.log(`[E2E] 1. Cold launch ${launcherComponent} -> Onboarding Connect to Host CTA -> PairingActivity...`);
    adb('shell', 'am', 'start', '-W', '-S', '-n', launcherComponent);

    const launchTop = await waitForTopActivity(
      t => (isMainActivity(t) || isCompanionActivity(t, 'PairingActivity')) && t.views.some(v => v.visible),
      'MainActivity or PairingActivity launch',
      15000
    );
    assert.ok(!launchTop.raw.includes('rokbot_native_pill'), 'Must NOT inject floating overlay toolbar over RN');
    capturePng('/tmp/emu_rn_main_launch.png');

    if (isMainActivity(launchTop)) {
      await sleep(1400);
      let openedPairing = false;
      const settled0 = await dumpTopActivity();
      const ctas0 = settled0.views
        .filter(v => v.visible && v.clickable && v.rect.w > 200 && v.rect.h >= 60 && v.rect.h <= 280 && v.rect.y1 > 600)
        .sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h));
      const maxAttempts = Math.min(4, Math.max(2, ctas0.length));
      for (let attempt = 0; attempt < maxAttempts && !openedPairing; attempt++) {
        const settled = attempt === 0 ? settled0 : await dumpTopActivity();
        const ctas = settled.views
          .filter(v => v.visible && v.clickable && v.rect.w > 200 && v.rect.h >= 60 && v.rect.h <= 280 && v.rect.y1 > 600)
          .sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h));
        const fallbackCta = settled.views.find(
          v => v.visible && v.clickable && v.rect.w > 40 && v.rect.h > 30 && v.rect.h < 350 && v.rect.y1 > 150
        );
        const cta = ctas[attempt] || ctas[0] || fallbackCta;
        if (cta) {
          tap(cta);
          try {
            await waitForTopActivity(t => isCompanionActivity(t, 'PairingActivity'), 'PairingActivity from Onboarding CTA', 6000);
            openedPairing = true;
            break;
          } catch {}
        }
        const cur = await dumpTopActivity();
        if (!isMainActivity(cur) && !isCompanionActivity(cur, 'PairingActivity')) {
          adbSafe('shell', 'am', 'start', '-W', '-n', launcherComponent);
          await waitForTopActivity(t => isMainActivity(t), 'Restore MainActivity after non-target Onboarding tap', 8000);
        }
      }
      assert.ok(openedPairing, 'Onboarding "Connect to Host" CTA must open PairingActivity directly');
    }

    await waitForTopActivity(t => isCompanionActivity(t, 'PairingActivity'), 'PairingActivity', 15000);
    await waitForNode(n => n['content-desc'] === 'host_url_input', 'PairingActivity host_url_input');
    capturePng('/tmp/emu_rn_pairing.png');

    // Verify auth segmented switcher exists
    await tapNodeWithScroll(n => n['content-desc'] === 'auth_mode_password_tab', 'Admin password tab');
    await waitForNode(n => n['content-desc'] === 'admin_password_input', 'admin_password_input');
    await tapNodeWithScroll(n => n['content-desc'] === 'auth_mode_code_tab', 'Pairing code tab');

    await tapNodeWithScroll(n => n['content-desc'] === 'host_url_input', 'host_url_input');
    await sleep(200);
    typeText(hostUrl);
    if (dismissImeIfShown()) await sleep(250);

    await tapNodeWithScroll(n => n['content-desc'] === 'pairing_code_input', 'pairing_code_input');
    await sleep(200);
    typeText('ABCDEF');
    if (dismissImeIfShown()) await sleep(250);

    await tapNodeWithScroll(n => n['content-desc'] === 'connect_pair_button', 'connect_pair_button');

    // 2. Returns straight to MainActivity with ZERO floating pill overlay
    const pairedTop = await waitForTopActivity(
      t => isMainActivity(t) && t.views.some(v => v.visible),
      'RN MainActivity after pairing',
      15000
    );
    assert.ok(!pairedTop.raw.includes('rokbot_native_pill'), 'Must NOT inject floating overlay toolbar over RN');
    assert.equal(host.devices.size, 1, 'Host must register 1 paired device');
    assert.ok(
      host.agents.every(a => typeof a.createdAt === 'number' && typeof a.updatedAt === 'number' && a.harness === undefined),
      'realHostProtocol agents must include createdAt/updatedAt and omit harness: temporal'
    );
    const pairedDevice = [...host.devicesById.values()][0];
    await waitForCondition(
      () => host.requestLogs.some(r => r.headers?.authorization === `Bearer ${pairedDevice.token}` && r.pathname === '/api/getHostStatus'),
      'RN MainActivity realHostProtocol bootstrap (/api/getHostStatus) after pairing',
      15000
    );
    await sleep(800);
    capturePng('/tmp/emu_rn_paired_main.png');
    console.log('[E2E] 2. Paired device:', pairedDevice.deviceId, 'returned cleanly to MainActivity without overlay pill.');

    // 3. Cold-restart test proves Android Keystore AES-256-GCM sealing + decryption persists across restarts
    const reqIdxBeforeRestart = host.requestLogs.length;
    adb('shell', 'am', 'force-stop', TARGET_PKG);
    await sleep(400);
    adb('shell', 'am', 'start', '-W', '-n', launcherComponent);
    const restartTop = await waitForTopActivity(
      t => isMainActivity(t) && t.views.some(v => v.visible),
      'MainActivity after cold restart',
      15000
    );
    assert.ok(!restartTop.raw.includes('rokbot_native_pill'), 'Must NOT inject floating overlay toolbar over RN');
    await waitForCondition(
      () => {
        const restartReqs = host.requestLogs.slice(reqIdxBeforeRestart);
        const hasAuth = p => restartReqs.some(r => r.headers?.authorization === `Bearer ${pairedDevice.token}` && r.pathname === p);
        return hasAuth('/api/listAgents') && hasAuth('/api/getHostSettings') && hasAuth('/api/getTrays') && hasAuth('/api/getHostStatus');
      },
      'authenticated realHostProtocol bootstrap RPCs (/api/listAgents, getHostSettings, getTrays, getHostStatus) after cold restart (Keystore unseal)',
      15000
    );
    await sleep(800);
    capturePng('/tmp/emu_rn_cold_restart.png');
    console.log('[E2E] 3. Cold restart Keystore credential unseal & Host bootstrap verified.');

    // 3b. Open Bot Chat ("Hello" / "Hi there!") & send via RN Composer -> POST /api/sendPrompt (signed-out fallback)
    console.log('[E2E] 3b. Opening Bot Chat & testing live RN Composer Send -> POST /api/sendPrompt...');
    const openCountBeforeChat = host.openedAgentIds.length;
    const reqIdxBeforeChat = host.requestLogs.length;
    const listTop = await waitForCondition(async () => {
      const t = await dumpTopActivity();
      const row = t.views.find(
        v => v.visible && v.clickable && v.rect.w >= 700 && v.rect.h >= 120 && v.rect.h <= 340 && v.rect.y1 >= 200 && v.rect.y2 <= 1400
      );
      return row ? { top: t, row } : null;
    }, 'RN Bots List row on MainActivity', 12000);
    tap(listTop.row);
    await waitForCondition(
      () => host.openedAgentIds.length > openCountBeforeChat &&
        host.requestLogs.slice(reqIdxBeforeChat).some(r => r.pathname === '/api/openAgentWindowed'),
      'Bot Chat opens and queries /api/openAgentWindowed (Hello / Hi there!)',
      12000
    );
    await sleep(900);
    capturePng('/tmp/emu_rn_chat.png');

    const chatTop = await dumpTopActivity();
    const inputCandidates = chatTop.views
      .filter(v =>
        v.visible &&
        v.rect.y1 >= 900 &&
        v.rect.w >= 250 &&
        v.rect.h >= 45 &&
        v.rect.h <= 450 &&
        (/EditText|textinput/i.test(v.className) || (v.focusable && v.clickable))
      )
      .sort((a, b) => {
        const aEdit = /EditText|textinput/i.test(a.className) ? 1 : 0;
        const bEdit = /EditText|textinput/i.test(b.className) ? 1 : 0;
        if (aEdit !== bEdit) return bEdit - aEdit;
        return b.cy - a.cy;
      });
    let imeFocused = false;
    for (const cand of inputCandidates.slice(0, 4)) {
      tap(cand);
      await sleep(500);
      if (isTextInputFocused()) {
        imeFocused = true;
        break;
      }
    }
    assert.ok(imeFocused, 'Composer TextInput must accept focus and open IME on Bot Chat screen');
    const reqIdxBeforeSend = host.requestLogs.length;
    typeText('E2E_LIVE_SEND_PROMPT');
    await sleep(350);
    if (dismissImeIfShown()) await sleep(500);

    const composerTop = await dumpTopActivity();
    const editNow = composerTop.views.find(
      v => v.visible && v.rect.y1 >= 900 && (/EditText|textinput/i.test(v.className) || (v.focusable && v.clickable))
    );
    const editAnchorY = editNow ? editNow.cy : (inputCandidates[0] ? inputCandidates[0].cy : null);
    const sendButtons = composerTop.views
      .filter(v =>
        v.visible &&
        v.clickable &&
        v.rect.x1 >= 650 &&
        v.rect.y1 >= 1200 &&
        v.rect.w <= 240 &&
        v.rect.h <= 240
      )
      .sort((a, b) => {
        if (editAnchorY != null) {
          const aNear = Math.abs(a.cy - editAnchorY) <= 180 ? 1 : 0;
          const bNear = Math.abs(b.cy - editAnchorY) <= 180 ? 1 : 0;
          if (aNear !== bNear) return bNear - aNear;
        }
        return b.cx - a.cx;
      });
    for (const btn of sendButtons.slice(0, 3)) {
      tap(btn);
      try {
        await waitForCondition(
          () => host.requestLogs.slice(reqIdxBeforeSend).some(r => r.pathname === '/api/sendPrompt'),
          'POST /api/sendPrompt after Send button tap',
          3500
        );
        break;
      } catch {}
    }
    const sendReq = await waitForCondition(
      () => host.requestLogs.slice(reqIdxBeforeSend).find(r => r.pathname === '/api/sendPrompt'),
      'Composer Send reaches POST /api/sendPrompt on MockHost',
      6000
    );
    assert.ok(sendReq, 'POST /api/sendPrompt must be received');
    await sleep(900);
    capturePng('/tmp/emu_rn_chat_sent.png');

    // Return from Chat Screen to Bots List
    const chatBeforeBack = await dumpTopActivity();
    if (!isBotsListReady(chatBeforeBack)) {
      const chatBackBtn = findTopLeftCornerButton(chatBeforeBack.views);
      if (chatBackBtn) {
        tap(chatBackBtn);
        try {
          await waitForCondition(async () => {
            const t = await dumpTopActivity();
            return isBotsListReady(t) ? t : null;
          }, 'Return to MainActivity Bots List after tapping Chat < Back button', 6000);
        } catch {
          const afterBackTap = await dumpTopActivity();
          if (isMainActivity(afterBackTap) && !isBotsListReady(afterBackTap)) {
            adb('shell', 'input', 'keyevent', '4');
          }
        }
      } else if (isMainActivity(chatBeforeBack)) {
        adb('shell', 'input', 'keyevent', '4');
      }
      await waitForCondition(async () => {
        const t = await dumpTopActivity();
        return isBotsListReady(t) ? t : null;
      }, 'Return to MainActivity Bots List with (D) avatar, bot rows, and header actions', 10000);
    }
    await sleep(350);

    // 4. RN SettingsSheet handoffs (AccountRow, Connect to Host toolbar, NotificationsRow) & all native surfaces
    console.log('[E2E] 4. Verifying RN SettingsSheet handoffs & iOS-parity native surfaces...');
    const botsTop = await dumpTopActivity();
    assert.ok(isBotsListReady(botsTop), 'MainActivity Bots List must be ready with (D), bot rows, and header actions');
    const avatarBtn = findTopLeftCornerButton(botsTop.views);
    assert.ok(avatarBtn, 'Top-left (D) avatar button must be visible on MainActivity Bots List');
    tap(avatarBtn);
    await waitForCondition(async () => {
      const t = await dumpTopActivity();
      return isMainActivity(t) && t.views.some(v => v.visible && v.className.includes('HostView'));
    }, 'RN SettingsSheet opens over MainActivity', 10000);
    await sleep(500);
    capturePng('/tmp/emu_rn_settings_sheet.png');

    // 4a. SettingsSheet AccountRow -> ProfileActivity
    const sheetTop1 = await dumpTopActivity();
    const activeScreenStart = sheetTop1.views.reduce(
      (last, v, idx) => (v.className.startsWith('com.swmansion.rnscreens.') && v.rect.h >= 1500 ? idx : last),
      0
    );
    const accountCard = sheetTop1.views
      .slice(activeScreenStart)
      .filter(v => v.visible && v.clickable && v.rect.w >= 850 && v.rect.h >= 130 && v.rect.h <= 260 && v.rect.y1 >= 250 && v.rect.y1 <= 650)
      .sort((a, b) => a.rect.y1 - b.rect.y1)[0];
    assert.ok(accountCard, 'SettingsSheet AccountRow card must be locatable');
    tap(accountCard);
    await waitForTopActivity(t => isCompanionActivity(t, 'ProfileActivity'), 'ProfileActivity via RN SettingsSheet AccountRow', 12000);
    await waitForNode(n => (n.text || '').includes('Local Test User'), 'ProfileActivity live displayName from GET /local/profile');
    assert.ok(host.requestLogs.some(r => r.method === 'GET' && r.pathname === '/local/profile'), 'ProfileActivity must query GET /local/profile');
    capturePng('/tmp/emu_rn_profile.png');
    adb('shell', 'input', 'keyevent', '4');
    await waitForTopActivity(t => isMainActivity(t), 'Return to RN SettingsSheet after ProfileActivity', 10000);

    // 4b. SettingsSheet toolbar "Connect to Host" -> Connected PairingActivity -> Library, Computers, Usage
    await sleep(400);
    const sheetTop2 = await dumpTopActivity();
    const toolbarConnectCandidates = sheetTop2.views
      .filter(v => v.visible && v.clickable && v.rect.x1 >= 550 && v.rect.y1 >= 120 && v.rect.y2 <= 420 && v.rect.w <= 460 && v.rect.h <= 200);
    // SettingsSheet renders after underlying MainActivity header in pre-order; pick the last (top-most) rightmost match.
    const toolbarConnectBtn = toolbarConnectCandidates
      .slice()
      .reverse()
      .sort((a, b) => (Math.abs(a.cx - b.cx) > 80 ? b.cx - a.cx : 0))[0];
    assert.ok(toolbarConnectBtn, 'SettingsSheet top-right "Connect to Host" toolbar button must be present');
    tap(toolbarConnectBtn);
    await waitForTopActivity(t => isCompanionActivity(t, 'PairingActivity'), 'Connected PairingActivity via SettingsSheet toolbar', 12000);
    await waitForNode(
      n =>
        (n.text || '').includes('Connected to Host') ||
        (n.text || '').includes('已连接到 Host') ||
        (n.text || '').includes('Tailcat Connected') ||
        (n.text || '').includes('Tailcat 已连接'),
      'Connected PairingActivity card'
    );
    capturePng('/tmp/emu_rn_connected.png');

    // LibraryActivity (+Text, Open, Del)
    await tapNodeWithScroll(n => n.text === 'Library' || n.text === '资料库', 'Library button');
    await waitForTopActivity(t => isCompanionActivity(t, 'LibraryActivity'), 'LibraryActivity');
    await tapNodeWithScroll(n => n['content-desc'] === 'library_add_text_button', 'library_add_text_button');
    const fnameEt = await waitForNode(n => n.hint === 'notes.txt' || n.text === 'notes.txt', 'Library filename input');
    tap(fnameEt.node);
    await sleep(200);
    typeText('emu-note.txt');
    const bodyEt = await waitForNode(
      n => n.hint === 'Text content...' || n.hint === '文本内容...' || n.text === 'Text content...' || n.text === '文本内容...',
      'Library content input'
    );
    tap(bodyEt.node);
    await sleep(200);
    typeText('Emulator Library Body');
    if (dismissImeIfShown()) await sleep(250);
    const uploadOk = await waitForNode(n => n.text === 'Upload' || n.text === 'UPLOAD' || n.text === '上传', 'AlertDialog Upload button');
    tap(uploadOk.node);
    await waitForNode(n => n.text === 'emu-note.txt', 'Uploaded emu-note.txt row', 15000);
    capturePng('/tmp/emu_rn_library.png');
    await tapNodeWithScroll(n => n.text === 'Open' || n.text === '打开', 'Library Open button');
    await waitForNode(n => (n.text || '').includes('Emulator Library Body'), 'Downloaded text preview modal', 15000);
    const closeDialog = await waitForNode(n => n.text === 'Close' || n.text === 'CLOSE' || n.text === '关闭', 'Close preview dialog');
    tap(closeDialog.node);
    await sleep(200);
    await tapNodeWithScroll(n => n.text === 'Del' || n.text === '删除', 'Library Del button');
    await waitForCondition(
      () => host.requestLogs.some(r => r.method === 'DELETE' && r.pathname === '/local/files'),
      'DELETE /local/files'
    );
    adb('shell', 'input', 'keyevent', '4');
    await waitForTopActivity(t => isCompanionActivity(t, 'PairingActivity'), 'PairingActivity after Library');

    // ComputersActivity
    await tapNodeWithScroll(n => n.text === 'Bot Computers' || n.text === 'Bot 电脑', 'Bot Computers button');
    await waitForTopActivity(t => isCompanionActivity(t, 'ComputersActivity'), 'ComputersActivity');
    await waitForNode(n => (n.text || '').includes('rokbot-box-1'), 'ComputersActivity live computer label from GET /local/computers');
    assert.ok(host.requestLogs.some(r => r.method === 'GET' && r.pathname === '/local/computers'), 'ComputersActivity must query GET /local/computers');
    capturePng('/tmp/emu_rn_computers.png');
    adb('shell', 'input', 'keyevent', '4');
    await waitForTopActivity(t => isCompanionActivity(t, 'PairingActivity'), 'PairingActivity after Computers');

    // UsageActivity: the usage report (GET /local/usage/report over the demo ledger).
    await tapNodeWithScroll(n => n.text === 'Usage' || n.text === '用量', 'Usage button');
    await waitForTopActivity(t => isCompanionActivity(t, 'UsageActivity'), 'UsageActivity');
    await waitForNode(n => n['content-desc'] === 'usage_card_total', 'UsageActivity summary cards from GET /local/usage/report', 20000);
    await waitForNode(n => n.text === '请求次数' || n.text === 'Requests', 'UsageActivity requests card');
    const reportReq = host.requestLogs.find(r => r.method === 'GET' && r.pathname === '/local/usage/report');
    assert.ok(reportReq, 'UsageActivity must query GET /local/usage/report');
    assert.equal(reportReq.query.range, '7d', 'the page opens on the last 7 days');
    assert.ok(reportReq.query.timeZone, 'device time zone is sent');
    capturePng('/tmp/emu_rn_usage.png');
    // Switch to today: a new report request with range=today.
    await tapNodeWithScroll(n => n['content-desc'] === 'usage_period_today', 'Usage range: today');
    await waitForCondition(() => host.requestLogs.some(r => r.pathname === '/local/usage/report' && r.query.range === 'today'), 'range=today requested');
    await waitForNode(n => n['content-desc'] === 'usage_card_total' || n['content-desc'] === 'usage_empty', 'UsageActivity today rendered', 20000);
    // Request details: the pager label 「第 a–b 条，共 n 条」.
    await waitForNode(n => n['content-desc'] === 'usage_page_label' || n['content-desc'] === 'usage_empty', 'Usage requests pager', 20000);
    capturePng('/tmp/emu_rn_usage_requests.png');
    adb('shell', 'input', 'keyevent', '4');
    await waitForTopActivity(t => isCompanionActivity(t, 'PairingActivity'), 'PairingActivity after Usage');

    // Close PairingActivity back to RN SettingsSheet
    adb('shell', 'input', 'keyevent', '4');
    await waitForTopActivity(t => isMainActivity(t), 'Return to RN SettingsSheet after PairingActivity', 10000);
    await sleep(500);

    // 4c. Scroll SettingsSheet -> flattened NotificationsRow (HostView switch) -> PushSettingsActivity
    const sheetBeforeScroll = await dumpTopActivity();
    let hostSwitches = findNotificationsHostSwitchCandidates(sheetBeforeScroll, { maxY2: 3200 });
    const notifCandidates = hostSwitches.filter(c => c.labelCount === 1);
    const targets = notifCandidates.length > 0 ? notifCandidates : hostSwitches;
    let openedPush = false;
    for (const cand of targets) {
      let tapY = cand.hv.cy;
      if (cand.hv.cy > 2100) {
        // dumpsys activity top does not subtract ScrollView mScrollY; use a slow no-fling drag so screen Y is deterministic.
        const scrollDelta = Math.max(400, Math.min(1150, cand.hv.cy - 1400));
        adb('shell', 'input', 'swipe', '300', '1650', '300', String(1650 - scrollDelta), '1800');
        await sleep(450);
        tapY = cand.hv.cy - Math.max(0, scrollDelta - 24);
      }
      for (const tapX of [cand.hv.cx, 360]) {
        adb('shell', 'input', 'tap', String(tapX), String(tapY));
        try {
          await waitForTopActivity(t => isCompanionActivity(t, 'PushSettingsActivity'), 'PushSettingsActivity via SettingsSheet NotificationsRow', 4000);
          openedPush = true;
          break;
        } catch {}
      }
      if (openedPush) break;
    }
    assert.ok(openedPush, 'SettingsSheet flattened NotificationsRow (including HostView switch area) must open PushSettingsActivity');
    await waitForNode(n => n['content-desc'] === 'send_test_push_button', 'PushSettingsActivity');
    capturePng('/tmp/emu_rn_push.png');
    await tapNodeWithScroll(n => n['content-desc'] === 'send_test_push_button', 'Send Test Push');
    await waitForCondition(
      () => host.requestLogs.some(r => r.pathname === '/local/device/push/test'),
      'POST /local/device/push/test'
    );
    adb('shell', 'input', 'keyevent', '4');
    await waitForTopActivity(t => isMainActivity(t), 'Return to RN SettingsSheet after PushSettingsActivity', 10000);

    const midLogcat = adbSafe('logcat', '-d');
    assert.ok(!midLogcat.includes('Not signed in.'), 'Must never emit signed-out error "Not signed in." during Chat Send');
    assert.ok(!midLogcat.includes("Can't reach your computer"), 'Must never emit "Can\'t reach your computer" toast');
    assert.ok(!midLogcat.includes('NotificationsRow: setEnabled failed'), 'Must never leak tap onto HostView Notifications toggle');
    assert.ok(!/^\S+\s+\S+\s+\d+\s+\d+\s+E\s+ReactNativeJS\b/m.test(midLogcat), 'Logcat must have 0 E ReactNativeJS errors');


    // 5. Background NotificationService + Deep Link routing back to MainActivity
    console.log('[E2E] 5. Verifying background NotificationService SSE & deep-link handling...');
    adb('shell', 'input', 'keyevent', '3'); // HOME
    await waitForCondition(async () => {
      const svcs = await adbSafeAsync(['shell', 'dumpsys', 'activity', 'services', TARGET_PKG], 8000);
      return svcs.includes('dev.rokbot.nativeapp.NotificationService');
    }, 'NotificationService running in background');

    // Wait for NotificationService to finish reconnecting in background mode (x-rokbot-foreground !== '1')
    await waitForCondition(
      () => [...host.notificationClients].some(c => c.deviceId === pairedDevice.deviceId && !c.isForeground),
      'NotificationService background SSE stream connected',
      12000
    );

    host._broadcastNotification(
      {
        id: 'emu-notif-001',
        notificationId: 'emu-notif-001',
        agentId: 'agent-coding',
        type: 'attention',
        title: 'Code Companion Alert',
        body: 'Emulator background SSE delivery test passed',
        deepLink: 'rokbot-local://agent/agent-coding',
      },
      pairedDevice.deviceId
    );

    await waitForCondition(async () => {
      const notifDump = await adbSafeAsync(['shell', 'dumpsys', 'notification', '--noredact'], 8000);
      return extractActiveNotificationsText(notifDump).includes('Code Companion Alert');
    }, 'OS NotificationManager holding background notification');

    // Launch rokbot-local://agent/agent-coding -> warm MainActivity onNewIntent cancels agent notification and routes RN to agent-coding
    const openCountBeforeDeepLink = host.openedAgentIds.length;
    adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', 'rokbot-local://agent/agent-coding', TARGET_PKG);
    const deepLinkTop = await waitForTopActivity(
      t => isMainActivity(t) && t.views.some(v => v.visible),
      'MainActivity opened by grokbot-local deep link',
      15000
    );
    assert.ok(!deepLinkTop.raw.includes('rokbot_native_pill'), 'Must NOT inject floating overlay toolbar over RN');
    const postTapNotifDump = await adbSafeAsync(['shell', 'dumpsys', 'notification', '--noredact'], 8000);
    assert.ok(
      !extractActiveNotificationsText(postTapNotifDump).includes('Code Companion Alert'),
      'Opening rokbot-local://agent/agent-coding must cancel agent notification via RokBotBootstrap.normalizeIncomingDeepLinkIntent'
    );
    await waitForCondition(
      () => host.openedAgentIds.slice(openCountBeforeDeepLink).includes('agent-coding'),
      'RN MainActivity opens agent-coding via flat /api/openAgentWindowed after rokbot-local:// onNewIntent normalization',
      15000
    );
    await sleep(500);
    capturePng('/tmp/emu_rn_deeplink.png');

    // Cold-start verify canonical normalized grokbot://app/v1/chat?id=agent-coding manifest intent-filter directly
    const openCountBeforeCanonical = host.openedAgentIds.length;
    adb('shell', 'am', 'force-stop', TARGET_PKG);
    await sleep(400);
    adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', "'grokbot://app/v1/chat?id=agent-coding'", TARGET_PKG);
    const canonicalTop = await waitForTopActivity(
      t => isMainActivity(t) && t.views.some(v => v.visible),
      'MainActivity opened by normalized grokbot://app deep link',
      15000
    );
    assert.ok(!canonicalTop.raw.includes('rokbot_native_pill'), 'Must NOT inject floating overlay toolbar over RN');
    const actDumpCanonical = adb('shell', 'dumpsys', 'activity', 'activities');
    assert.ok(
      actDumpCanonical.includes('grokbot://app/v1/chat?id=agent-coding'),
      'Manifest intent-filter must accept normalized URI grokbot://app/v1/chat?id=agent-coding'
    );
    await waitForCondition(
      () => host.openedAgentIds.slice(openCountBeforeCanonical).includes('agent-coding'),
      'Cold-launched grokbot://app/v1/chat?id=agent-coding opens agent-coding via /api/openAgentWindowed',
      15000
    );
    console.log('[E2E] ALL LIVE EMULATOR ACCEPTANCE CHECKS PASSED.');
  } finally {
    adbSafe('reverse', '--remove', `tcp:${port}`);
    await host.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  run().catch(err => {
    console.error('[E2E FAILURE]', err);
    process.exit(1);
  });
}

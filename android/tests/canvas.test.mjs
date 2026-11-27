// Android canvases: canvas links open in CanvasActivity (in-app stage with the share sheet), the
// Library lists the Bot's canvases, and the pure CanvasModel (links, Beijing time, meta CSP) runs
// on a plain JVM. The emulator walk-through is in the canvas report (chat link -> CanvasActivity).
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const NATIVE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

test('CanvasActivity is registered and canvas links are routed to it from both link paths', () => {
  const manifest = fs.readFileSync(path.join(NATIVE_ROOT, 'patchers/manifest.mjs'), 'utf8');
  assert.match(manifest, /upsertAppChild\('activity', 'dev\.rokbot\.nativeapp\.CanvasActivity', \[\n\s+makeAttrStr\('name', 'dev\.rokbot\.nativeapp\.CanvasActivity'\),\n\s+makeAttrBool\('exported', false\),/);
  const boot = read('RokBotBootstrap.java');
  assert.match(boot, /if \(Storage\.isPaired\(activity\) && CanvasLinks\.interceptBrowserProxy\(activity\)\) return;\n\s+if \(isReactActivity\(activity\)\) CanvasLinks\.install\(activity\);/);
  const links = read('CanvasLinks.java');
  // The Instrumentation wrapper is installed only when it can delegate to the original.
  assert.match(links, /if \(activity == null \|\| !resolve\(\)\) return;/);
  assert.match(links, /sExecStartActivity\.invoke\(base, who, contextThread, token, target, intent, requestCode, options\)/);
  assert.match(links, /if \(intent == null \|\| !Intent\.ACTION_VIEW\.equals\(intent\.getAction\(\)\) \|\| intent\.getComponent\(\) != null\) return null;/);
  assert.match(links, /if \(intent\.getBooleanExtra\(EXTRA_ALLOW_EXTERNAL, false\)\) return null;/);
  assert.match(links, /expo\.modules\.webbrowser\.EXTRA_URL/);
});

test('the canvas stage reads the frame with the device credential into an offline, bridge-less WebView', () => {
  const act = read('CanvasActivity.java');
  for (const line of ['ws.setBlockNetworkLoads(true);', 'ws.setAllowFileAccess(false);', 'ws.setAllowContentAccess(false);',
    'ws.setDomStorageEnabled(false);', 'ws.setJavaScriptCanOpenWindowsAutomatically(false);',
    'web.loadDataWithBaseURL("https://canvas.rokbot.invalid/", CanvasModel.withMetaCsp(html), "text/html", "utf-8", null);',
    'request.hasGesture() && request.isForMainFrame()'])
    assert.ok(act.includes(line), line);
  assert.ok(!act.includes('addJavascriptInterface'));
  for (const text of ['返回聊天', '刷新', '分享', '关闭', '正在打开画布…', '这个画布已被删除，或者不在当前连接的 Host 上。']) assert.ok(act.includes(text), text);
  const api = read('HostApiClient.java');
  for (const pattern of [/"\/local\/canvases\?agentId=" \+ encodeQuery\(agentId\)/, /"\/local\/canvases\/" \+ requireCanvasId\(canvasId\) \+ "\/visibility"/,
    /"\/local\/canvases\/" \+ requireCanvasId\(canvasId\) \+ "\/link"/, /authedRequest\(context, "DELETE", "\/local\/canvases\/" \+ requireCanvasId\(canvasId\)/,
    /"\/canvas\/app\/" \+ requireCanvasId\(canvasId\) \+ "\/frame\?theme="/])
    assert.match(api, pattern);
});

test('share sheet and Library section follow the official share and page rows, with a drawn switch', () => {
  const sheet = read('CanvasShareSheet.java');
  for (const text of ['分享“', '谁可以访问', '公开访问', '知道链接的任何人 · 无需登录', '仅你可见 · 只能在已登录的 RokBot 中打开', '复制链接', '在浏览器中打开',
    '重新生成链接', '旧链接会立即失效', 'new CanvasUi.Switch(act)', 'HostApiClient.setCanvasVisibility(act, id, value)', 'HostApiClient.regenerateCanvasLink(act, id)'])
    assert.ok(sheet.includes(text), text);
  assert.ok(!/android\.widget\.Switch|SwitchCompat|CheckBox|ToggleButton/.test(sheet), 'no platform switch widget');
  const ui = read('CanvasUi.java');
  assert.match(ui, /static final class Switch extends View/);
  const section = read('CanvasLibrarySection.java');
  for (const text of ['heading.setText(t("画布", "Canvases"))', 'CanvasModel.shortTime(c.optLong("updatedAtMs")', 'CanvasUi.visibilityMark(act, p, c.optString("visibility"), false)',
    't("打开", "Open")', 't("分享…", "Share…")', 't("删除…", "Delete…")', '删除“', '删除画布', 'HostApiClient.deleteCanvas(act, id)', '这个 Bot 创建的画布会显示在这里。'])
    assert.ok(section.includes(text), text);
  const library = read('LibraryActivity.java');
  assert.match(library, /mCanvases = new CanvasLibrarySection\(this, mAgentId\);\n\s+content\.addView\(mCanvases\.view\);/);
  assert.match(library, /protected void onResume\(\) \{\n\s+super\.onResume\(\);[\s\S]{0,160}mCanvases\.reload\(\);/);
  for (const name of ['CanvasActivity.java', 'CanvasShareSheet.java', 'CanvasLibrarySection.java', 'CanvasUi.java', 'CanvasModel.java', 'CanvasLinks.java']) {
    const src = read(name);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(src), `${name}: no emoji`);
    assert.ok(!/"[^"]*Grok[^"]*"/.test(src), `${name}: no upstream name in strings`);
  }
});

test('the built companion dex carries the canvas classes', () => {
  const dex = fs.readFileSync(path.join(NATIVE_ROOT, 'bin/classes2.dex'));
  for (const name of ['CanvasActivity', 'CanvasShareSheet', 'CanvasLibrarySection', 'CanvasLinks$Router', 'CanvasModel', 'CanvasUi$Switch'])
    assert.ok(dex.includes(Buffer.from(`Ldev/rokbot/nativeapp/${name};`)), name);
});

test('CanvasModel (JVM): canvas links, public links, Beijing time and the meta CSP', () => {
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  assert.ok(javacBin, 'JDK required');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-canvas-model-'));
  try {
    const pkg = path.join(tmp, 'src/dev/rokbot/nativeapp');
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(path.join(SRC, 'CanvasModel.java'), path.join(pkg, 'CanvasModel.java'));
    fs.writeFileSync(path.join(pkg, 'CanvasModelHarness.java'), `package dev.rokbot.nativeapp;
public class CanvasModelHarness {
  public static void main(String[] a) {
    String id = "044e3b41-0828-4466-9f6d-325569f828c6";
    String tok = "Abc_-0123456789abcdefghijABCDEFGHIJ01234567";
    long now = java.time.Instant.parse("2026-11-27T06:00:00Z").toEpochMilli();
    String[] out = {
      CanvasModel.appLinkId("http://127.0.0.1:8000/canvas/app/" + id),
      CanvasModel.appLinkId("https://bot.example/canvas/app/" + id.toUpperCase() + "/"),
      String.valueOf(CanvasModel.appLinkId("https://bot.example/canvas/" + tok)),
      String.valueOf(CanvasModel.appLinkId("https://u:p@bot.example/canvas/app/" + id)),
      String.valueOf(CanvasModel.appLinkId("https://bot.example/canvas/app/" + id + "/frame")),
      String.valueOf(CanvasModel.appLinkId("intent://canvas/app/" + id)),
      String.valueOf(CanvasModel.isPublicLink("https://bot.example/canvas/" + tok)),
      String.valueOf(CanvasModel.isPublicLink("https://bot.example/canvas/app/" + id)),
      CanvasModel.shortTime(java.time.Instant.parse("2026-11-27T05:05:00Z").toEpochMilli(), now, true),
      CanvasModel.shortTime(java.time.Instant.parse("2026-11-26T17:30:00Z").toEpochMilli(), now, true),
      CanvasModel.shortTime(java.time.Instant.parse("2026-11-26T03:30:00Z").toEpochMilli(), now, true),
      CanvasModel.shortTime(java.time.Instant.parse("2025-03-02T03:30:00Z").toEpochMilli(), now, true),
      CanvasModel.shortTime(java.time.Instant.parse("2026-11-26T03:30:00Z").toEpochMilli(), now, false),
      CanvasModel.visibilityLabel("public", true) + CanvasModel.visibilityLabel("private", true) + CanvasModel.visibilityLabel(null, false),
      CanvasModel.withMetaCsp("<html><head><title>x</title><script nonce=\\"AbC123+/=xyz\\">1</script></head></html>"),
    };
    System.out.print(String.join("\\n", out));
  }
}
`);
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-d', path.join(tmp, 'classes'),
      path.join(pkg, 'CanvasModel.java'), path.join(pkg, 'CanvasModelHarness.java')], { stdio: 'pipe' });
    const lines = cp.execFileSync(javaBin, ['-cp', path.join(tmp, 'classes'), 'dev.rokbot.nativeapp.CanvasModelHarness'], { encoding: 'utf8' }).split('\n');
    const id = '044e3b41-0828-4466-9f6d-325569f828c6';
    assert.deepEqual(lines.slice(0, 14), [id, id, 'null', 'null', 'null', 'null', 'true', 'false',
      '今天 13:05', '今天 01:30', '11月26日 11:30', '2025年3月2日', '11/26 11:30', '公开私有Private']);
    assert.match(lines[14], /^<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-AbC123\+\/=xyz';[^"]*connect-src 'none'[^"]*"><title>/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

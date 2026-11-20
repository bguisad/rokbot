import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { extractNotificationPolicy } from '../../mac/patchers/desktop/extract-policy.mjs';
import { selectWindowsRelease } from '../patchers/desktop/inputs.mjs';
import { unpackOriginal } from '../patchers/desktop/original.mjs';
import {
  patchDesktopUpdateSettingsUi,
  resolveDesktopUpdateConfig,
} from '../patchers/desktop/update-config.mjs';

const execFileAsync = promisify(execFile);
const winPatchCli = fileURLToPath(new URL('../patchers/desktop/patch.mjs', import.meta.url));
const winDesktopDir = fileURLToPath(new URL('../patchers/desktop', import.meta.url));
const win0712RecipesDir = fileURLToPath(new URL('../patchers/desktop/0.71.2/recipes', import.meta.url));
const cachedWin123 = fileURLToPath(new URL('../.cache/Grok_Bot_1.2.3_Setup.exe', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

test('Windows patch CLI documents update flags in --help and validates update flags before platform build checks', async () => {
  const { stdout } = await execFileAsync(process.execPath, [winPatchCli, '--help']);
  assert.match(stdout, /--update-url/);
  assert.match(stdout, /--update-public-key/);
  assert.match(stdout, /--update-public-key-file/);

  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ format: 'pem', type: 'spki' });
  const spkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  const resolvedPem = await resolveDesktopUpdateConfig([
    '--update-url', 'https://updates.example/desktop///',
    '--update-public-key', pem,
  ]);
  assert.deepEqual(resolvedPem, {
    updateUrl: 'https://updates.example/desktop',
    updatePublicKey: spkiBase64,
  });

  await assert.rejects(
    execFileAsync(process.execPath, [winPatchCli, '--update-url', 'https://updates.example/']),
    err => err.code === 1 && /--update-public-key/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [winPatchCli, '--update-url', 'http://insecure.example/feed', '--update-public-key', spkiBase64]),
    err => err.code === 1 && /HTTPS/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [winPatchCli, '--update-url', 'https://updates.example/feed?x=1', '--update-public-key', spkiBase64]),
    err => err.code === 1 && /查询参数/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [winPatchCli, '--update-url', 'https://updates.example/', '--update-public-key', 'bad-key']),
    err => err.code === 1 && /public key/i.test(err.stderr),
  );
  if (process.platform !== 'win32') {
    await assert.rejects(
      execFileAsync(process.execPath, [winPatchCli, '--update-url', 'https://updates.example/', '--update-public-key', pem]),
      err => err.code === 1 && /Windows 客户端需要在 Windows 上生成/.test(err.stderr),
    );
  }
});

test('Windows 0.71.2 recipe 009 preserves Android pinned target hash while patchDesktopUpdateSettingsUi supports 0.71.2, 1.1.0, and 1.2.3', async t => {
  const recipe = JSON.parse(gunzipSync(await readFile(path.join(win0712RecipesDir, '009.gbp.gz'))).toString('utf8'));
  assert.equal(recipe.targetSha256, 'a5423ee6ba0b931a43e8e1d59c36f669ddf8b787242e5080193ef46562cc44e5');

  const dir0712 = await mkdtemp(path.join(os.tmpdir(), 'rokbot-win-ui-0712-'));
  const dir110 = await mkdtemp(path.join(os.tmpdir(), 'rokbot-win-ui-110-'));
  const dir123 = await mkdtemp(path.join(os.tmpdir(), 'rokbot-win-ui-123-'));
  t.after(async () => {
    await Promise.all([
      rm(dir0712, { recursive: true, force: true }),
      rm(dir110, { recursive: true, force: true }),
      rm(dir123, { recursive: true, force: true }),
    ]);
  });

  const assets0712 = path.join(dir0712, 'dist/renderer/assets');
  await mkdir(assets0712, { recursive: true });
  const chunk0712 = path.join(assets0712, 'chunk-view-BZxQ9Ylk.js');
  await writeFile(chunk0712, [
    'function GrokOriginalUpdateSettings(){ie.d=1731;return o.jsx(Se,{title:"Updates",children:fe().row({value:Me})});}',
    'function re(){re.d=1588;const t=M.c(1);let e;return t[0]===Symbol.for("react.memo_cache_sentinel")?(e=o.jsx(ue,{children:o.jsx(ie,{})}),t[0]=e):e=t[0],e}',
    'function ie(){return o.jsx(Se,{children:"0.71.2"});}',
  ].join('\n'), 'utf8');
  const patched0712 = await patchDesktopUpdateSettingsUi(dir0712);
  assert.equal(patched0712.file, 'dist/renderer/assets/chunk-view-BZxQ9Ylk.js');
  const updated0712 = await readFile(chunk0712, 'utf8');
  assert.match(updated0712, /function GrokLocalUpdateSettings\(\)/);
  assert.match(updated0712, /t\?\.delivery==="in-app"\?o\.jsx\(GrokOriginalUpdateSettings,\{\}\):o\.jsx\(ie,\{\}\)/);

  const assets110 = path.join(dir110, 'dist/renderer/assets');
  await mkdir(assets110, { recursive: true });
  const chunk110 = path.join(assets110, 'chunk-view-D18ZK0A2.js');
  await writeFile(chunk110, [
    'function E(){E.d=3008;const t=d();return (0,S.jsx)(g,{children:t.row({value:D})});}',
    'function O(){O.d=2763;let e=(0,y.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,S.jsx)(v,{children:(0,S.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}',
    'function GrokLocalVersion(){return (0,S.jsx)(g,{children:"1.1.0"});}',
  ].join('\n'), 'utf8');
  const patched110 = await patchDesktopUpdateSettingsUi(dir110);
  assert.equal(patched110.file, 'dist/renderer/assets/chunk-view-D18ZK0A2.js');
  const updated110 = await readFile(chunk110, 'utf8');
  assert.match(updated110, /function GrokLocalUpdateSettings\(\)/);
  assert.match(updated110, /t\?\.delivery==="in-app"\?\(0,S\.jsx\)\(E,\{\}\):\(0,S\.jsx\)\(GrokLocalVersion,\{\}\)/);

  const assets123 = path.join(dir123, 'dist/renderer/assets');
  await mkdir(assets123, { recursive: true });
  const chunk123 = path.join(assets123, 'chunk-view-xV8CbwrQ.js');
  const source123 = [
    'function T(){T.d=3033;let e=(0,v.c)(4),t=u(),n;return(0,x.jsx)(_,{children:t.row({value:R})});}',
    'function D(){D.d=2788;let e=(0,v.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}',
    'function GrokLocalVersion(){return(0,x.jsx)(_,{children:"1.2.3"});}',
  ].join('\n');
  await writeFile(chunk123, source123, 'utf8');
  const patched123 = await patchDesktopUpdateSettingsUi(dir123);
  assert.equal(patched123.file, 'dist/renderer/assets/chunk-view-xV8CbwrQ.js');
  const updated123 = await readFile(chunk123, 'utf8');
  assert.match(updated123, /function GrokLocalUpdateSettings\(\)/);
  assert.match(updated123, /t\?\.delivery==="in-app"\?\(0,x\.jsx\)\(T,\{\}\):\(0,x\.jsx\)\(GrokLocalVersion,\{\}\)/);

  // Execute patched 1.2.3 D() and GrokLocalUpdateSettings() in a VM across delivery modes.
  let currentStatus = null;
  const ctx = vm.createContext({
    Symbol,
    R: 'row-value',
    _: ({ children }) => ({ tag: 'Scroll', children }),
    v: { c: n => new Array(n) },
    x: { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }) },
    u: () => ({
      row: opts => ({
        loading: opts.loading,
        empty: opts.empty,
        unavailable: opts.unavailable,
        rendered: opts.value(currentStatus),
      }),
    }),
  });
  vm.runInContext(updated123, ctx);
  const rootEl = ctx.D();
  assert.equal(rootEl.type, '_');
  assert.equal(rootEl.props.children.type, 'GrokLocalUpdateSettings');

  currentStatus = null;
  assert.equal(ctx.GrokLocalUpdateSettings().rendered.type, 'GrokLocalVersion');
  currentStatus = { delivery: 'package-manager' };
  assert.equal(ctx.GrokLocalUpdateSettings().rendered.type, 'GrokLocalVersion');
  currentStatus = { delivery: 'in-app' };
  assert.equal(ctx.GrokLocalUpdateSettings().rendered.type, 'T');

  // Fail-closed guards on 1.2.3: double-patching, missing symbol, missing anchor, duplicate anchor.
  await assert.rejects(patchDesktopUpdateSettingsUi(dir123), /更新设置模块已被修改/);

  await writeFile(chunk123, source123.replace('function T(){T.d=3033;', 'function Q(){Q.d=3033;'), 'utf8');
  await assert.rejects(patchDesktopUpdateSettingsUi(dir123), /更新设置模块缺少必需符号/);

  await writeFile(chunk123, source123.replace('D.d=2788;', 'D.d=9999;'), 'utf8');
  await assert.rejects(patchDesktopUpdateSettingsUi(dir123), /更新设置模块缺少预期锚点/);

  const anchorLine = 'function D(){D.d=2788;let e=(0,v.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}';
  await writeFile(chunk123, `${source123}\n${anchorLine}`, 'utf8');
  await assert.rejects(patchDesktopUpdateSettingsUi(dir123), /更新设置模块锚点不唯一/);
});

test('Windows 1.2.3 pins, notification-policy.json, and desktop local-client bundle contracts are aligned', async () => {
  const supported = JSON.parse(await readFile(path.join(winDesktopDir, 'supported.json'), 'utf8'));
  assert.equal(supported.version, '1.2.3');
  assert.equal(supported.architecture, 'x64');
  assert.equal(supported.archive.url, 'https://downloads.cursor.com/grokbot/stable/win32-x64/1.2.3/Grok_Bot_1.2.3_Setup.exe');
  assert.equal(supported.archive.bytes, 127618944);
  assert.equal(supported.archive.sha256, '85b9e8d10b9ede921b315bb5a1b52db7e0f3438d162aacedfc388c778217765b');
  assert.equal(supported.payload.name, 'app-64.7z');
  assert.equal(supported.payload.bytes, 126693944);
  assert.equal(supported.payload.sha256, '84d20f0f2b5a1eacc523015ed723f315c76395646d9d6c28295c8704b809c5df');
  assert.equal(supported.exeSha256, '5138d36bb1b6f9f716422aef42b62d33daba566cfea1ecdad87ca22464a9ae0a');
  assert.equal(supported.asarSha256, 'b1354ec5ae877e94115a643edd4b2e7487929f0a1dfb398411ab314b488ee0d2');
  assert.equal(supported.asarHeaderSha256, 'cfd92fb7d75ddc50c5214fcca3a561cd9b2d0a26dee763e5585182ee6ac63e80');
  assert.equal(supported.preloadSha256, '69558bc987aae4dd9567770229bfbec01fcbeb4f0065731ac7f6ec60f4ebcda2');
  assert.equal(supported.vncPreloadSha256, 'a2d9c610b7b11ae5cc99551f1e139c7b1e8632990793a7687fee40e88a6be24b');

  const policy = JSON.parse(await readFile(path.join(winDesktopDir, 'notification-policy.json'), 'utf8'));
  assert.deepEqual(policy, {
    source: 'dist/electron-main/main-app.cjs',
    sourceSha256: '1340e0a07215d225e530d0ec94322b4253f80e3c8c4550b2f8a1322be2768b38',
    sha256: 'a6ab52f9a87cff580df62736a6ed6b8fbdfe22cedebd7aa25a3966cca3081852',
    byteOffset: 2967236,
    byteLength: 4522,
    exportName: 'kP',
  });

  for (const rel of [
    'mac/clients/desktop/model-bridge.mjs',
    'mac/clients/desktop/updater.mjs',
    'mac/clients/desktop/local-exec.mjs',
    'mac/clients/desktop/local-services.mjs',
    'mac/clients/desktop/asar-install.mjs',
    'mac/clients/desktop/main.mjs',
    'mac/clients/desktop/preload.cjs',
    'mac/clients/shared/delta.mjs',
  ]) {
    assert.equal(existsSync(path.join(repoRoot, rel)), true, `Missing desktop client file: ${rel}`);
  }
  const preload = await readFile(path.join(repoRoot, 'mac/clients/desktop/preload.cjs'), 'utf8');
  for (const method of ['getLocalStatus', 'getModelConfig', 'updateModelConfig', 'fetchModelCatalog', 'testModelConfig']) {
    assert.match(preload, new RegExp(`\\b${method}\\b`), `preload.cjs missing window.localBot.${method}`);
  }
});

test('Windows patcher --verify-only verifies cached 1.2.3 installer recipes and update UI patch', { skip: !existsSync(cachedWin123) }, async () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = publicKey.export({ format: 'pem', type: 'spki' });
  const { stdout } = await execFileAsync(process.execPath, [
    winPatchCli,
    '--source', cachedWin123,
    '--update-url', 'https://updates.example.com/desktop',
    '--update-public-key', pem,
    '--verify-only',
  ]);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.verified, true);
  assert.equal(parsed.recipesVerified, true);
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.recommended, true);
  assert.equal(parsed.architecture, 'x64');
  assert.equal(parsed.asarSha256, 'b1354ec5ae877e94115a643edd4b2e7487929f0a1dfb398411ab314b488ee0d2');
});

test('Windows extracted 1.2.3 NotificationDecider executes constructor, gateTransitions verdicts, and decide without ReferenceError', { skip: !existsSync(cachedWin123) }, async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-win-policy-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const { supported } = await selectWindowsRelease({ source: cachedWin123 });
  const appDir = await unpackOriginal(cachedWin123, tempDir, supported);
  const asar = createRequire(path.join(repoRoot, 'mac/patchers/desktop/package.json'))('@electron/asar');
  const mainAppBuffer = asar.extractFile(path.join(appDir, 'resources/app.asar'), 'dist/electron-main/main-app.cjs');

  const unpacked = path.join(tempDir, 'unpacked');
  await mkdir(path.join(unpacked, 'dist/electron-main'), { recursive: true });
  await writeFile(path.join(unpacked, 'dist/electron-main/main-app.cjs'), mainAppBuffer);

  const policySource = await extractNotificationPolicy(unpacked, winDesktopDir);
  const policyFile = path.join(tempDir, 'notification-policy.mjs');
  await writeFile(policyFile, policySource);
  const { NotificationDecider } = await import(pathToFileURL(policyFile).href);

  // Default constructor relies on XDn (5000ms) and last-message dedupe.
  const defaultDecider = new NotificationDecider();
  assert.equal(defaultDecider.throttleWindowMs, 5000);
  assert.equal(defaultDecider.dedupe, 'last-message');

  // notifications.mjs instantiates new NotificationDecider(0, 'message-history').
  const zeroThrottleDecider = new NotificationDecider(0, 'message-history');
  zeroThrottleDecider.seedBaseline([{ id: 'a0', lastMessageId: 'm0' }]);
  const zeroDelivered = zeroThrottleDecider.gateTransitions([{
    agentId: 'a0',
    agentName: 'Agent 0',
    kind: 'agent-done',
    lastMessageId: 'm1',
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    readAtLatestActivity: false,
  }], { focus: { kind: 'unfocused' }, nowMs: 1000 });
  assert.equal(zeroDelivered[0].verdict, 'deliver');

  // gateTransitions relies on QDn, JDn, and pgt across all suppression verdicts.
  const decider = new NotificationDecider(5000, 'message-history');
  decider.seedBaseline([{ id: 'a1', lastMessageId: 'm1' }]);
  const baseTransition = (msgId, overrides = {}) => ({
    agentId: 'a1',
    agentName: 'Agent 1',
    kind: 'agent-done',
    lastMessageId: msgId,
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    readAtLatestActivity: false,
    ...overrides,
  });

  const delivered = decider.gateTransitions([baseTransition('m2')], { focus: { kind: 'unfocused' }, nowMs: 10_000 });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].verdict, 'deliver');

  const focused = decider.gateTransitions([baseTransition('m3')], { focus: { kind: 'whole_app' }, nowMs: 20_000 });
  assert.equal(focused[0].verdict, 'suppressed_focus');

  const pref = decider.gateTransitions([baseTransition('m4', { notifyEnabled: false })], { focus: { kind: 'unfocused' }, nowMs: 20_000 });
  assert.equal(pref[0].verdict, 'suppressed_pref');

  const read = decider.gateTransitions([baseTransition('m5', { readAtLatestActivity: true })], { focus: { kind: 'unfocused' }, nowMs: 20_000 });
  assert.equal(read[0].verdict, 'suppressed_read');

  const throttled = decider.gateTransitions([baseTransition('m6')], { focus: { kind: 'unfocused' }, nowMs: 12_000 });
  assert.equal(throttled[0].verdict, 'suppressed_throttle');

  // decide() relies on pde + gateTransitions.
  assert.deepEqual(
    defaultDecider.decide({
      agents: [{
        id: 'a2',
        name: 'Agent 2',
        isRunning: true,
        awaitingReason: null,
        notifyEnabled: true,
        isHiddenFromSidebar: false,
        lastMessageId: 'm10',
        readAtLatestActivity: false,
      }],
      focus: { kind: 'unfocused' },
      nowMs: 1000,
    }),
    [],
  );
  const decided = defaultDecider.decide({
    agents: [{
      id: 'a2',
      name: 'Agent 2',
      isRunning: false,
      awaitingReason: null,
      notifyEnabled: true,
      isHiddenFromSidebar: false,
      lastMessageId: 'm11',
      readAtLatestActivity: false,
    }],
    focus: { kind: 'unfocused' },
    nowMs: 2000,
  });
  assert.equal(decided.length, 1);
  assert.equal(decided[0].transition.kind, 'agent-done');
  assert.equal(decided[0].verdict, 'deliver');
});

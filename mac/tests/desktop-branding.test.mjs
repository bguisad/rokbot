import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyRokBotHelperInfoPlist,
  applyRokBotInfoPlist,
  installBundleIcon,
  resolveRokBotLogoPaths,
  resolveTailcatSource,
  stageLocalClientIcon,
  verifyRokBotIcons,
} from '../patchers/desktop/brand-assets.mjs';
import { grokText, rokText, setLocaleSource } from '../clients/desktop/i18n.mjs';
import {
  APP_USER_MODEL_ID,
  SHORTCUT_NAME,
  agentFromLink,
  initialLink,
  normalizeDesktopWindowTitle,
  resolveDesktopProfile,
} from '../clients/desktop/platform.mjs';

const macRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(macRoot, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('assets/logo RokBot macOS icons match manifest.json and carry valid icns/PNG headers', async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'assets/logo/manifest.json'), 'utf8'));
  const { icnsPath, iconPngPath } = resolveRokBotLogoPaths(repoRoot);
  const [icnsBytes, pngBytes] = await Promise.all([readFile(icnsPath), readFile(iconPngPath)]);

  assert.equal(icnsBytes.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(sha(icnsBytes), manifest.icns.sha256);

  assert.deepEqual([...pngBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(pngBytes.readUInt32BE(16), 512);
  assert.equal(pngBytes.readUInt32BE(20), 512);
  const manifest512 = manifest.png.find(item => item.width === 512);
  assert.ok(manifest512);
  assert.equal(sha(pngBytes), manifest512.sha256);
});

test('brand-assets applies Info.plist, wires RokBot icons into app.asar & bundle Resources, and fails closed on mismatch', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-branding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const asar = createRequire(path.join(macRoot, 'patchers/desktop/package.json'))('@electron/asar');
  const { icnsPath, iconPngPath } = resolveRokBotLogoPaths(repoRoot);

  const info = applyRokBotInfoPlist({
    CFBundleIdentifier: 'com.anysphere.sand',
    CFBundleName: 'Grok Bot',
    CFBundleDisplayName: 'Grok Bot',
    CFBundleIconName: 'AppIcon',
    SUFeedURL: 'https://downloads.cursor.com/appcast.xml',
    SUPublicEDKey: 'abc',
  });
  assert.equal(info.CFBundleIdentifier, 'dev.rokbot.local');
  assert.equal(info.CFBundleName, 'RokBot');
  assert.equal(info.CFBundleDisplayName, 'RokBot');
  assert.equal(info.CFBundleIconFile, 'icon.icns');
  assert.equal('CFBundleIconName' in info, false);
  assert.equal('SUFeedURL' in info, false);
  assert.equal(info.NSLocalNetworkUsageDescription, 'Connect to your RokBot Host on the local network.');
  assert.deepEqual(info.CFBundleURLTypes, [
    { CFBundleTypeRole: 'Viewer', CFBundleURLName: 'RokBot Local', CFBundleURLSchemes: ['rokbot-local'] },
  ]);

  const unpacked = path.join(dir, 'unpacked');
  const outResources = path.join(dir, 'RokBot.app/Contents/Resources');
  const outAsar = path.join(outResources, 'app.asar');
  await mkdir(path.join(unpacked, 'local-client'), { recursive: true });
  await mkdir(outResources, { recursive: true });
  await writeFile(path.join(unpacked, 'package.json'), JSON.stringify({ name: 'rokbot', main: 'local-client/main.mjs' }));
  await writeFile(path.join(outResources, 'Assets.car'), 'stale-1.2.3-asset-catalog');
  await writeFile(path.join(outResources, 'icon.icns'), 'stale-official-icns');

  await stageLocalClientIcon({ unpackedDir: unpacked, iconPngPath });
  await asar.createPackageWithOptions(unpacked, outAsar, {});
  await installBundleIcon({ outResources, icnsPath });

  await assert.rejects(readFile(path.join(outResources, 'Assets.car')), { code: 'ENOENT' });

  const verified = await verifyRokBotIcons({
    icnsPath,
    iconPngPath,
    outIconPath: path.join(outResources, 'icon.icns'),
    outAsarPath: outAsar,
    asarModule: asar,
  });
  assert.equal(verified.rokbotIconApplied, true);
  assert.equal(verified.iconSha256, sha(await readFile(icnsPath)));
  assert.equal(verified.localIconSha256, sha(await readFile(iconPngPath)));

  // Tampered bundle icon.icns must fail closed.
  await writeFile(path.join(outResources, 'icon.icns'), 'tampered');
  await assert.rejects(
    verifyRokBotIcons({
      icnsPath,
      iconPngPath,
      outIconPath: path.join(outResources, 'icon.icns'),
      outAsarPath: outAsar,
      asarModule: asar,
    }),
    /icon\.icns/,
  );

  // Leftover Assets.car must fail closed.
  await writeFile(path.join(outResources, 'Assets.car'), 'unexpected-asset-catalog');
  await assert.rejects(
    verifyRokBotIcons({
      icnsPath,
      iconPngPath,
      outIconPath: path.join(outResources, 'icon.icns'),
      outAsarPath: outAsar,
      asarModule: asar,
    }),
    /Assets\.car/,
  );
  await installBundleIcon({ outResources, icnsPath });

  // Restore bundle icon, then tamper ASAR local-client/icon.png -> must fail closed.
  await installBundleIcon({ outResources, icnsPath });
  const tamperedAsar = path.join(outResources, 'tampered.asar');
  await writeFile(path.join(unpacked, 'local-client/icon.png'), 'tampered-png');
  await asar.createPackageWithOptions(unpacked, tamperedAsar, {});
  await assert.rejects(
    verifyRokBotIcons({
      icnsPath,
      iconPngPath,
      outIconPath: path.join(outResources, 'icon.icns'),
      outAsarPath: tamperedAsar,
      asarModule: asar,
    }),
    /local-client\/icon\.png/,
  );

  assert.equal(path.basename(resolveTailcatSource(macRoot)), 'rokbot-tailcat');
  assert.equal(existsSync(resolveTailcatSource(macRoot)), true);
});

test('desktop branding constants, profile isolation, i18n alias, and deep links follow RokBot contracts', () => {
  assert.equal(APP_USER_MODEL_ID, 'dev.rokbot.local');
  assert.equal(SHORTCUT_NAME, 'RokBot Local.lnk');

  const appDataDir = path.join(os.tmpdir(), 'app-data-fixture');
  assert.deepEqual(resolveDesktopProfile({ env: {}, appDataDir }), {
    isolatedProfile: false,
    profile: path.join(appDataDir, 'RokBot Local'),
    debugPort: '',
  });
  assert.deepEqual(resolveDesktopProfile({
    env: { ROKBOT_LOCAL_DEBUG_PORT: '9222' },
    appDataDir,
  }), {
    isolatedProfile: false,
    profile: path.join(appDataDir, 'RokBot Local'),
    debugPort: '9222',
  });
  const testProfile = path.join(os.tmpdir(), 'isolated-rokbot-profile');
  assert.deepEqual(resolveDesktopProfile({
    env: { ROKBOT_LOCAL_DEBUG_PORT: '9222', ROKBOT_LOCAL_TEST_PROFILE: testProfile },
    appDataDir,
  }), {
    isolatedProfile: true,
    profile: path.resolve(testProfile),
    debugPort: '9222',
  });

  setLocaleSource(() => 'zh-CN');
  assert.equal(rokText('中文', 'English'), '中文');
  assert.equal(grokText('中文', 'English'), '中文');
  setLocaleSource(() => 'en-US');
  assert.equal(rokText('中文', 'English'), 'English');

  assert.equal(agentFromLink('rokbot-local://agent/agent_123'), 'agent_123');
  assert.equal(agentFromLink('rokbot-local://agent/agent_123?x=1'), null);
  assert.equal(agentFromLink('grokbot-local://agent/agent_123'), null);

  assert.equal(initialLink(['RokBot.exe', 'grokbot-local://agent/old', 'rokbot-local://agent/new']), 'rokbot-local://agent/new');
  assert.equal(initialLink(['Grok Bot.exe', '--flag', 'grokbot-local://agent/abc']), 'grokbot-local://agent/abc');
  assert.equal(initialLink(['RokBot.exe']), null);

  assert.equal(normalizeDesktopWindowTitle('Grok Bot'), 'RokBot');
  assert.equal(normalizeDesktopWindowTitle('Chat — Grok Bot'), 'Chat — RokBot');
  assert.equal(normalizeDesktopWindowTitle(''), 'RokBot');
  assert.equal(normalizeDesktopWindowTitle('RokBot'), 'RokBot');

  const helperInfo = {
    CFBundleIdentifier: 'com.anysphere.sand.helper.Renderer',
    CFBundleName: 'Grok Bot Helper (Renderer)',
    CFBundleDisplayName: 'Grok Bot Helper (Renderer)',
    CFBundleExecutable: 'Grok Bot Helper (Renderer)',
  };
  assert.equal(applyRokBotHelperInfoPlist(helperInfo, { originalBundleId: 'com.anysphere.sand' }), true);
  assert.equal(helperInfo.CFBundleIdentifier, 'dev.rokbot.local.helper.Renderer');
  assert.equal(helperInfo.CFBundleName, 'RokBot Helper (Renderer)');
  assert.equal(helperInfo.CFBundleDisplayName, 'RokBot Helper (Renderer)');
  assert.equal(helperInfo.CFBundleExecutable, 'Grok Bot Helper (Renderer)');
});

test('desktop workspace.css overrides .sand-grok-bot-mark with the RokBot logo mark', async () => {
  const css = await readFile(path.join(macRoot, 'clients/desktop/workspace.css'), 'utf8');
  assert.match(css, /\.sand-grok-bot-mark\s*\{[^}]*background-image:\s*url\("data:image\/svg\+xml,/);
  assert.match(css, /rokbot-chassis/);
  assert.match(css, /\.sand-grok-bot-mark\s*>\s*\*\s*\{[^}]*opacity:\s*0\s*!important/);
});

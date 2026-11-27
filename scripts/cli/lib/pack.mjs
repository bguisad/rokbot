// `rokbot pack <platform> --input <file>`: builds a client from an official installer the user
// downloaded themselves. The CLI never downloads anything: it verifies the local file against the
// pins the repository already keeps (supported.json / android recipes manifest / iOS patcher), then
// runs the existing patcher for that platform with an explicit source so it cannot fetch one.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCommandArgs } from './args.mjs';
import { checkAndroidSigning } from './doctor.mjs';
import { capture, CliError, err, expandHome, fail, out, REPO_ROOT, run, sha256File, stamp } from './util.mjs';

const OFFICIAL = 'Grok Bot 官方原版安装包';

const importRepo = relative => import(pathToFileURL(path.join(REPO_ROOT, relative)).href);

async function desktopPins(platform) {
  if (platform === 'mac') {
    const { macReleases } = await importRepo('mac/patchers/desktop/inputs.mjs');
    return (await macReleases()).map(({ supported }) => ({ version: supported.version, files: [supported.archive], asar: supported.asarSha256, asarPath: 'Contents/Resources/app.asar' }));
  }
  if (platform === 'linux') {
    const { allLinuxReleases } = await importRepo('linux/patchers/desktop/inputs.mjs');
    return (await allLinuxReleases()).map(({ supported, arch }) => ({ version: `${supported.version} (${arch})`, files: [supported.archive], asar: supported.asarSha256, asarPath: 'resources/app.asar' }));
  }
  const { windowsReleases } = await importRepo('windows/patchers/desktop/inputs.mjs');
  let releases = (await windowsReleases()).map(({ supported }) => ({ version: supported.version, files: [supported.archive, supported.payload], asar: supported.asarSha256, asarPath: 'resources/app.asar' }));
  if (platform === 'web') {
    const build = JSON.parse(readFileSync(path.join(REPO_ROOT, 'web/patchers/supported.json'), 'utf8'));
    const accepted = [build.desktopVersion, ...(build.fallback ?? []).map(item => item.desktopVersion)];
    releases = releases.filter(release => accepted.includes(release.version));
  }
  return releases;
}

/** Matches a local file or unpacked app directory against the pinned official releases. */
export async function identifyDesktopInput(platform, input, pins) {
  pins ??= await desktopPins(platform);
  const info = statSync(input);
  const supportedList = pins.map(pin => pin.version).join('、');
  if (info.isDirectory()) {
    for (const pin of pins) {
      const asar = path.join(input, pin.asarPath);
      if (existsSync(asar) && await sha256File(asar) === pin.asar) return { version: pin.version, kind: 'directory' };
    }
    fail(`${input} 不是受支持的 ${OFFICIAL}目录（app.asar 摘要不匹配）。支持的版本：${supportedList}`, 2);
  }
  const candidates = pins.flatMap(pin => pin.files.filter(file => file?.bytes === info.size).map(file => ({ pin, file })));
  const digest = candidates.length ? await sha256File(input) : null;
  const hit = candidates.find(({ file }) => file.sha256 === digest);
  if (!hit) fail(`${input} 不是受支持的 ${OFFICIAL}（大小或 SHA-256 与固定摘要不符，可能被修改过或版本不对）。支持的版本：${supportedList}`, 2);
  return { version: hit.pin.version, sha256: digest, bytes: info.size, kind: 'file' };
}

/** Android: the patcher's own --verify-only, checked against android/recipes/manifest.json. */
export async function identifyAndroidInput(input) {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'android/recipes/manifest.json'), 'utf8'));
  if (!/\.(xapk|apks|apk)$/i.test(input)) fail(`安卓需要 .xapk / .apks / .apk 格式的 ${OFFICIAL}`, 2);
  const result = capture(process.execPath, [path.join(REPO_ROOT, 'android/release/patch-android.mjs'), '--input-apk', input, '--verify-only'], { timeout: 300_000 });
  let report;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  if (result.status !== 0 || !report?.verified) fail(`无法读取 ${input}：${(result.stderr || result.stdout).trim().split('\n').pop() || '格式无效'}`, 2);
  const packages = manifest.supportedPackages ?? [manifest.packageName];
  if (!packages.includes(report.packageName) || report.hbcSha256 !== manifest.hbcSha256)
    fail(`${input} 不是受支持的 ${OFFICIAL}：需要 ${manifest.version}（build ${manifest.build}），包名或界面包摘要不匹配`, 2);
  return { version: `${manifest.version} (${manifest.build})`, sha256: report.inputSha256, kind: 'file' };
}

export async function identifyIosInput(input) {
  if (!/\.ipa$/i.test(input) || !statSync(input).isFile()) fail(`iOS 需要已解密的 .ipa 格式的 ${OFFICIAL}`, 2);
  const head = readFileSync(input).subarray(0, 4);
  if (head.toString('hex') !== '504b0304') fail(`${input} 不是有效的 IPA（ZIP）文件`, 2);
  // Version, build and digests are enforced by ios/release/patch-ios.py itself.
  return { version: '由 iOS 补丁脚本按 Info.plist 与固定摘要校验', sha256: await sha256File(input), kind: 'file' };
}

export const PLATFORMS = {
  android: { label: '安卓', expects: '.xapk / .apks / .apk（1.26.0，build 3212）' },
  mac: { label: 'macOS', expects: 'Apple Silicon .dmg 或解开的 .app', host: 'darwin' },
  windows: { label: 'Windows', expects: 'x64 安装程序 Setup.exe、其中的 app-64.7z 或安装目录', host: 'win32' },
  linux: { label: 'Linux', expects: '.deb（x64 或 arm64）' },
  web: { label: '网页版', expects: 'Windows x64 安装程序 Setup.exe（网页版界面取自其中）' },
  ios: { label: 'iOS', expects: '已解密的 .ipa（1.27.0 / 1.26.0 / 1.16.0）' },
};

export const PACK_OPTIONS = {
  input: { type: 'string', short: 'i' },
  output: { type: 'string', short: 'o' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  keystore: { type: 'string' },
  'dev-signing': { type: 'boolean' },
  'allow-cross-platform': { type: 'boolean' },
};

export function missingInputMessage(platform) {
  const spec = PLATFORMS[platform];
  return `缺少 --input。请指定你自己从官方渠道下载的 ${OFFICIAL}（${spec.label}：${spec.expects}）的本地路径。\n` +
    '本工具不提供原版安装包或打过补丁的成品下载；请自行从官方渠道获取原版后再运行。';
}

/** The patcher invocation for a platform (exported for tests and --dry-run). */
export function patcherCommand(platform, { input, outputDir, values = {}, rest = [], temporary }) {
  const node = process.execPath;
  switch (platform) {
    case 'android':
      return { command: node, cwd: REPO_ROOT, args: [path.join(REPO_ROOT, 'android/release/patch-android.mjs'), '--input-apk', input,
        '--output-apk', path.join(outputDir, 'RokBot.apk'), ...(values.force ? ['--force'] : []),
        ...(values.keystore ? ['--keystore', path.resolve(expandHome(values.keystore))] : []), ...(values['dev-signing'] ? ['--dev-signing'] : []), ...rest] };
    case 'mac':
      return { command: node, cwd: path.join(REPO_ROOT, 'mac'), args: [path.join(REPO_ROOT, 'mac/patchers/desktop/patch.mjs'), '--source', input,
        '--output', path.join(outputDir, 'RokBot.app'), '--backup', path.join(temporary, 'original.app'), ...rest] };
    case 'windows':
      return { command: node, cwd: REPO_ROOT, args: [path.join(REPO_ROOT, 'windows/patchers/desktop/patch.mjs'), '--source', input,
        '--output', outputDir, ...(values['allow-cross-platform'] ? ['--allow-cross-platform'] : []), ...rest] };
    case 'linux':
      return { command: node, cwd: REPO_ROOT, args: [path.join(REPO_ROOT, 'linux/patchers/desktop/patch.mjs'), '--source', input,
        '--output', outputDir, ...(values.force ? ['--force'] : []), ...rest] };
    case 'web':
      return { command: node, cwd: REPO_ROOT, args: [path.join(REPO_ROOT, 'web/patchers/patch.mjs'), '--source', input,
        '--output', outputDir, ...(values.force ? ['--force'] : []), ...rest] };
    case 'ios':
      return { command: 'python3', cwd: path.join(REPO_ROOT, 'ios'), args: [path.join(REPO_ROOT, 'ios/release/patch-ios.py'), '--input', input,
        '--output', path.join(outputDir, `RokBot-iOS-${stamp()}`), ...rest] };
    default:
      throw new CliError(`不支持的平台 ${platform}`, 2);
  }
}

export async function packCommand(argv) {
  const { values, positionals, rest } = parseCommandArgs(argv, PACK_OPTIONS, { positionals: 1 });
  const platform = positionals[0];
  if (!platform) fail(`请指定平台：${Object.keys(PLATFORMS).join(' / ')}。例：rokbot pack android --input ./原版.xapk`, 2);
  if (!PLATFORMS[platform]) fail(`不支持的平台 ${platform}；可用：${Object.keys(PLATFORMS).join('、')}`, 2);
  if (!values.input) fail(missingInputMessage(platform), 2);
  if (rest.some(arg => /^--(source|input|input-apk|apk|output|output-apk)(=|$)/.test(arg)))
    fail('-- 之后的参数不能再指定输入或输出，请用 --input / --output', 2);
  const input = path.resolve(expandHome(values.input));
  if (!existsSync(input)) fail(`找不到 --input 指定的文件：${input}`, 2);
  const spec = PLATFORMS[platform];
  if (spec.host && process.platform !== spec.host && !(platform === 'windows' && values['allow-cross-platform']))
    fail(platform === 'mac' ? 'macOS 客户端的构建与签名必须在 macOS 上进行' : 'Windows 客户端需要在 Windows 上生成（或加 --allow-cross-platform）', 2);

  out(`校验输入：${input}`);
  const identified = platform === 'android' ? await identifyAndroidInput(input)
    : platform === 'ios' ? await identifyIosInput(input)
      : await identifyDesktopInput(platform, input);
  out(`  已识别：${spec.label} ${identified.version}${identified.sha256 ? `，SHA-256 ${identified.sha256.slice(0, 16)}…` : ''}`);

  if (platform === 'android' && !rest.includes('--unsigned')) {
    const signing = await checkAndroidSigning({ keystore: values.keystore, devSigning: values['dev-signing'] });
    if (signing.status === 'fail') fail(signing.message);
    out(`  ${signing.status === 'ok' ? '签名' : '注意'}：${signing.message}`);
  }

  const outputDir = path.join(path.resolve(expandHome(values.output ?? 'dist')), platform);
  const temporary = values['dry-run'] ? path.join(os.tmpdir(), 'rokbot-pack-XXXXXX') : await mkdtemp(path.join(os.tmpdir(), 'rokbot-pack-'));
  const plan = patcherCommand(platform, { input, outputDir, values, rest, temporary });
  if (values['dry-run']) {
    out('', '将运行（--dry-run，不执行）：', `  cd ${plan.cwd}`, `  ${[plan.command, ...plan.args].map(quote).join(' ')}`);
    return;
  }
  try {
    await mkdir(outputDir, { recursive: true });
    out('', `调用仓库补丁脚本，输出到 ${outputDir}`);
    const code = await run(plan.command, plan.args, { cwd: plan.cwd, env: { ...process.env } });
    if (code !== 0) fail(`补丁脚本失败（退出码 ${code}），输出目录中可能只有部分文件`);
    await writeFile(path.join(outputDir, 'rokbot-pack.json'), `${JSON.stringify({
      schema: 'rokbot-pack/v1', platform, inputVersion: identified.version, inputSha256: identified.sha256 ?? null, builtAt: new Date().toISOString(),
    }, null, 2)}\n`);
    out('', `完成：${outputDir}`, '生成的客户端只装在自己的设备上，或由 Host 管理员在管理页「客户端更新」发布，不要公开分发。');
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => err(`无法清理临时目录 ${temporary}`));
  }
}

const quote = value => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`);

// `rokbot init`: choose source or image mode, write the Host configuration and Compose file.
// Image mode renders .env from host/release/.env.images.example and validates it with
// host/release/install-images.sh --prepare-only. Source mode clones/pulls the repository and
// delegates to `host/deploy.py init`, which owns the source-build .env format.
import { existsSync } from 'node:fs';
import { appendFile, copyFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseCommandArgs, parsePort } from './args.mjs';
import {
  DEFAULT_IMAGES, DEFAULT_PORT, DEFAULT_TZ, IMAGE_COMPOSE, maskEnv, RELEASE_DIR, renderImageEnv, renderSourceEnvPreview,
  resolveHostSettings, writeState,
} from './config.mjs';
import { projectInUse } from './docker.mjs';
import {
  ask, choose, commandExists, confirm, DEFAULT_REPO_URL, defaultHome, expandHome, fail, isInteractive, out, REPO_ROOT,
  run, runChecked, writePrivateFile,
} from './util.mjs';

export const INIT_OPTIONS = {
  mode: { type: 'string' },
  src: { type: 'string' },
  repo: { type: 'string' },
  ref: { type: 'string' },
  project: { type: 'string' },
  listen: { type: 'string' },
  port: { type: 'string' },
  'web-port': { type: 'string' },
  'public-url': { type: 'string' },
  'web-public-url': { type: 'string' },
  tz: { type: 'string' },
  'host-image': { type: 'string' },
  'box-image': { type: 'string' },
  'host-only': { type: 'boolean' },
  'no-pull': { type: 'boolean' },
  start: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
};

/** Turns parsed flags into the raw settings object accepted by resolveHostSettings. */
export function settingsFromFlags(values) {
  return {
    mode: values.mode,
    project: values.project,
    listen: values.listen,
    port: parsePort(values.port, '--port'),
    webPort: parsePort(values['web-port'], '--web-port'),
    publicUrl: values['public-url'],
    webPublicUrl: values['web-public-url'],
    tz: values.tz,
    hostOnly: values['host-only'],
    hostImage: values['host-image'],
    boxImage: values['box-image'],
  };
}

async function interview(raw, values) {
  out('RokBot 初始化向导（直接回车使用默认值，Ctrl+C 退出）', '');
  raw.mode ??= await choose('部署方式：', [
    { value: 'image', label: '镜像模式：拉取仓库发布的 Host / box 预构建镜像（推荐，需要能访问 ghcr.io）' },
    { value: 'source', label: '源码模式：git clone / pull 仓库，在本机构建镜像（host/deploy.py）' },
  ], 'image');
  if (raw.mode === 'source' && !values.src) values.src = await ask('源码目录', path.join(values.homeDir, 'src'));
  const access = await choose('客户端从哪里访问 Host：', [
    { value: 'local', label: '只在本机（http://127.0.0.1）' },
    { value: 'lan', label: '局域网 / 专网（监听专网 IP）' },
    { value: 'proxy', label: '已有 HTTPS 反向代理（填写域名）' },
  ], raw.publicUrl ? 'proxy' : 'local');
  raw.port ??= parsePort(await ask('管理端口', String(DEFAULT_PORT)), '端口');
  raw.webPort ??= parsePort(await ask('网页版端口', String(raw.port + 1)), '网页版端口');
  if (access === 'lan') {
    raw.listen ??= await ask('监听的专网 IP（例如 192.168.1.10）');
    raw.publicUrl ??= await ask('客户端输入的地址', `http://${raw.listen}:${raw.port}`);
  } else if (access === 'proxy') {
    raw.publicUrl ??= await ask('对外 HTTPS 地址（例如 https://bot.example.com）');
    raw.webPublicUrl ??= (await ask('网页版单独的 HTTPS 地址（可留空）', '')) || undefined;
  }
  raw.tz ??= await ask('时区', DEFAULT_TZ);
  raw.project ??= await ask('Compose 项目名', 'rokbot');
  return raw;
}

function describePlan(settings, home, src, values) {
  const steps = [];
  if (settings.mode === 'image') {
    steps.push(`复制 Compose 文件 host/release/${IMAGE_COMPOSE} 到 ${path.join(home, IMAGE_COMPOSE)}`);
    steps.push(`写入 ${path.join(home, '.env')}（权限 600，按 host/release/.env.images.example 格式）`);
    steps.push('用 host/release/install-images.sh --local --prepare-only 校验配置并补齐随机密钥');
    if (!values['no-pull']) steps.push(`拉取镜像 ${settings.hostImage}、${settings.boxImage}`);
  } else {
    steps.push(existsSync(path.join(src, '.git')) ? `更新源码：git -C ${src} pull --ff-only` : `获取源码：git clone ${values.repo ?? DEFAULT_REPO_URL} ${src}`);
    steps.push(`运行 host/deploy.py init 写入 ${path.join(home, '.env')}（权限 600）`);
  }
  steps.push(`记录 CLI 状态 ${path.join(home, 'rokbot.json')}（权限 600）`);
  if (values.start) steps.push(settings.mode === 'image' ? '启动 Host 和 box（install-images.sh）' : '构建并启动（host/deploy.py up）');
  return steps;
}

export async function initCommand(argv) {
  const { values } = parseCommandArgs(argv, INIT_OPTIONS);
  const home = values.home ? path.resolve(expandHome(values.home)) : defaultHome();
  values.homeDir = home;
  const dryRun = Boolean(values['dry-run']);
  if (existsSync(path.join(home, '.env')) && !dryRun)
    fail(`${home} 已有配置（.env），init 不会覆盖。查看状态用 rokbot status，升级用 rokbot update，或用 --home 换一个实例目录。`);
  let raw = settingsFromFlags(values);
  if (isInteractive() && !values.yes) raw = await interview(raw, values);
  const settings = resolveHostSettings(raw);
  const src = path.resolve(expandHome(values.src ?? path.join(home, 'src')));
  const steps = describePlan(settings, home, src, values);

  out('', `部署方式：${settings.mode === 'image' ? '镜像模式' : '源码模式'}`, `实例目录：${home}`,
    ...(settings.mode === 'source' ? [`源码目录：${src}`] : [`镜像：${settings.hostImage}`, `      ${settings.boxImage}`]),
    `管理页：  ${settings.adminUrl}`, `网页版：  ${settings.webUrl}`, `项目名：  ${settings.project}`, '', '步骤：',
    ...steps.map((step, index) => `  ${index + 1}. ${step}`));

  // Another instance (or deploy.py install) on this Docker daemon already owns this project name.
  const inUse = commandExists('docker') ? projectInUse(settings.project) : null;
  const inUseText = `Docker 上已有项目 ${settings.project} 的容器或数据卷（另一个实例）。换一个 --project，或用 --home 指向原实例目录后运行 rokbot status / update。`;
  if (inUse && !dryRun) fail(inUseText);

  const envText = settings.mode === 'image' ? renderImageEnv(settings) : renderSourceEnvPreview(settings);
  if (dryRun) {
    if (existsSync(path.join(home, '.env'))) out('', `注意：${home} 已有 .env，实际运行 init 会拒绝覆盖。`);
    if (inUse) out('', `注意：${inUseText}`);
    out('', `.env 预览（只列出生效的设置${settings.mode === 'source' ? '，由 host/deploy.py init 写入' : '，模板注释保留'}）：`,
      ...maskEnv(envText).split('\n').filter(line => line && !line.startsWith('#')).map(line => `  ${line}`),
      '', '这是 --dry-run，没有写入任何文件，也没有拉取代码或镜像。');
    return;
  }
  if (isInteractive() && !values.yes && !await confirm('按以上配置继续？', true)) fail('已取消', 130);

  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700).catch(() => {});
  if (settings.mode === 'image') {
    if (!commandExists('docker')) fail('镜像模式需要 Docker（含 Compose v2）。先安装 Docker，再运行 rokbot doctor 检查。');
    await copyFile(path.join(RELEASE_DIR, IMAGE_COMPOSE), path.join(home, IMAGE_COMPOSE));
    await writePrivateFile(path.join(home, '.env'), envText, { exclusive: true });
    await writeState(home, { mode: 'image', project: settings.project, repo: REPO_ROOT, createdAt: new Date().toISOString() });
    await runChecked('bash', [path.join(RELEASE_DIR, 'install-images.sh'), '--local', '--prepare-only'], { cwd: home, input: '' }, '配置校验');
    if (!values['no-pull']) {
      out('', '拉取镜像（私有镜像需先 docker login ghcr.io）…');
      await runChecked('docker', ['compose', '--env-file', path.join(home, '.env'), '-p', settings.project, '-f', path.join(home, IMAGE_COMPOSE), 'pull'], { input: '' }, '拉取镜像');
    }
    if (values.start) await runChecked('bash', [path.join(RELEASE_DIR, 'install-images.sh'), '--local', '--pull-never'], { cwd: home, input: '' }, '启动');
  } else {
    if (!commandExists('git')) fail('源码模式需要 git');
    if (!commandExists('python3')) fail('源码模式需要 python3（3.10+），用于 host/deploy.py');
    if (existsSync(path.join(src, '.git'))) {
      await runChecked('git', ['-C', src, 'pull', '--ff-only'], {}, '更新源码');
    } else if (existsSync(src) && existsSync(path.join(src, 'host', 'deploy.py'))) {
      out(`${src} 不是 git 仓库，直接使用其中的源码。`);
    } else {
      await runChecked('git', ['clone', ...(values.ref ? ['--branch', values.ref] : []), values.repo ?? DEFAULT_REPO_URL, src], {}, '获取源码');
    }
    const deploy = path.join(src, 'host', 'deploy.py');
    if (!existsSync(deploy)) fail(`${src} 中没有 host/deploy.py，不是 RokBot 仓库`);
    await runChecked('python3', [deploy, '--home', home, '--project', settings.project, ...(settings.hostOnly ? ['--host-only'] : []), 'init',
      '--listen', settings.listen, '--port', String(settings.port), '--web-port', String(settings.webPort),
      ...(settings.publicUrl ? ['--public-url', settings.publicUrl] : []), ...(settings.webPublicUrl ? ['--web-public-url', settings.webPublicUrl] : [])],
    { input: '' }, 'host/deploy.py init');
    if (settings.tz !== DEFAULT_TZ) await appendFile(path.join(home, '.env'), `TZ=${settings.tz}\n`);
    await chmod(path.join(home, '.env'), 0o600);
    await writeState(home, { mode: 'source', project: settings.project, source: src, hostOnly: settings.hostOnly, createdAt: new Date().toISOString() });
    if (values.start) await runChecked('python3', [deploy, '--home', home, 'up'], { input: '' }, 'host/deploy.py up');
  }
  out('', '初始化完成。接下来：',
    '  rokbot doctor    检查环境',
    ...(values.start ? [] : ['  rokbot up        启动 Host 和执行桌面']),
    '  rokbot admin     设置管理员密码（首次）',
    '  rokbot status    查看状态');
  if (settings.mode === 'image' && settings.hostImage === DEFAULT_IMAGES.host)
    out('', '提示：预构建镜像需要 GHCR 访问权限；拉取失败时先 docker login ghcr.io，或改用 --mode source 本地构建。');
}

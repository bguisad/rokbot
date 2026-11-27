// up / down / status / logs / update / rollback. Image mode drives host/release/install-images.sh
// and docker compose on the instance's docker-compose.images.yml; source mode delegates to
// host/deploy.py, which builds, backs up and switches on its own.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCommandArgs } from './args.mjs';
import { adminSession } from './admin.mjs';
import {
  composeCommand, deployGlobalArgs, deployScript, IMAGE_COMPOSE, localAdminOrigin, readInstanceEnv, RELEASE_DIR, requireState,
} from './config.mjs';
import { docker, imageExists, inspect, requireDocker, serviceContainer, waitHealthy } from './docker.mjs';
import {
  capture, defaultHome, err, expandHome, fail, out, run, runChecked, stamp, writePrivateFile,
} from './util.mjs';

function instance(values) {
  const home = values.home ? path.resolve(expandHome(values.home)) : defaultHome();
  return { home, state: requireState(home) };
}

const services = state => (state.mode === 'source' && state.hostOnly ? ['host'] : ['host', 'box']);

function configuredImages(home) {
  const env = readInstanceEnv(home);
  const compose = readFileSync(path.join(home, IMAGE_COMPOSE), 'utf8');
  const fallback = name => new RegExp(`\\$\\{ROKBOT_${name}_IMAGE:-([^}]+)\\}`).exec(compose)?.[1];
  return { host: env.ROKBOT_HOST_IMAGE || fallback('HOST'), box: env.ROKBOT_BOX_IMAGE || fallback('BOX') };
}

// ---------- up ----------
export const UP_OPTIONS = { pull: { type: 'boolean' }, 'no-wait': { type: 'boolean' } };

export async function upCommand(argv) {
  const { values, rest } = parseCommandArgs(argv, UP_OPTIONS);
  const { home, state } = instance(values);
  requireDocker();
  if (state.mode === 'image') {
    const images = configuredImages(home);
    const local = Object.values(images).every(ref => ref && imageExists(ref));
    const args = [path.join(RELEASE_DIR, 'install-images.sh'), '--local', ...(local && !values.pull ? ['--pull-never'] : [])];
    if (!local) out('本机缺少镜像，先拉取（私有镜像需先 docker login ghcr.io）…');
    return runChecked('bash', args, { cwd: home, input: '' }, '启动');
  }
  const host = serviceContainer(state.project, 'host');
  if (!host) {
    out('首次启动：由 host/deploy.py up 构建并启动（需要几分钟）…');
    return runChecked('python3', [deployScript(state), ...deployGlobalArgs(home, state), 'up', ...rest], { input: '' }, 'host/deploy.py up');
  }
  await runChecked('docker', [...composeCommand(home, state), 'start'], { input: '' }, '启动容器');
  if (!values['no-wait']) {
    out('等待 Host 健康检查…');
    if (!await waitHealthy(host)) fail('Host 在 5 分钟内没有变为健康，用 rokbot logs 查看日志');
  }
  out(`已启动。管理页：${localAdminOrigin(readInstanceEnv(home))}/admin`);
}

// ---------- down ----------
export const DOWN_OPTIONS = { remove: { type: 'boolean' } };

export async function downCommand(argv) {
  const { values } = parseCommandArgs(argv, DOWN_OPTIONS);
  const { home, state } = instance(values);
  requireDocker();
  if (values.remove && state.mode === 'source')
    fail('源码模式不移除容器：host/deploy.py 以现有容器判断安装状态。只停止服务请去掉 --remove。', 2);
  // Never `down -v`: volumes hold conversations, pairing and keys.
  await runChecked('docker', [...composeCommand(home, state), values.remove ? 'down' : 'stop'], { input: '' }, '停止');
  out(values.remove ? '已停止并移除容器，数据卷保留。' : '已停止，容器和数据卷保留。用 rokbot up 重新启动。');
}

// ---------- status ----------
export const STATUS_OPTIONS = { json: { type: 'boolean' } };

export async function statusCommand(argv) {
  const { values } = parseCommandArgs(argv, STATUS_OPTIONS);
  const { home, state } = instance(values);
  const env = readInstanceEnv(home);
  const origin = localAdminOrigin(env);
  const rows = services(state).map(service => {
    const id = serviceContainer(state.project, service);
    const info = id ? inspect(id) : null;
    return { service, state: info?.State?.Status ?? '未创建', health: info?.State?.Health?.Status ?? null, image: info?.Config?.Image ?? null };
  });
  const session = await adminSession(origin);
  const report = {
    home, mode: state.mode, project: state.project, adminUrl: `${env.ROKBOT_PUBLIC_URL || origin}/admin`, services: rows,
    admin: session.reachable ? (session.initialized === undefined ? `HTTP ${session.status}` : session.initialized ? 'initialized' : 'not-initialized') : 'unreachable',
  };
  if (values.json) { out(JSON.stringify(report, null, 2)); return; }
  out(`实例：${home}（${state.mode === 'image' ? '镜像模式' : '源码模式'}，项目 ${state.project}）`);
  for (const row of rows) out(`  ${row.service.padEnd(5)} ${row.state}${row.health ? ` / ${row.health}` : ''}${row.image ? `  ${row.image}` : ''}`);
  out(`管理页：${report.adminUrl}`,
    `管理员：${{ initialized: '已设置', 'not-initialized': '未设置（运行 rokbot admin）', unreachable: '管理服务不可达' }[report.admin] ?? report.admin}`);
}

// ---------- logs ----------
export const LOGS_OPTIONS = { follow: { type: 'boolean', short: 'f' }, tail: { type: 'string' } };

export async function logsCommand(argv) {
  const { values, positionals } = parseCommandArgs(argv, LOGS_OPTIONS, { positionals: 1 });
  const { home, state } = instance(values);
  const service = positionals[0];
  if (service && !services(state).includes(service)) fail(`服务只能是 ${services(state).join(' 或 ')}`, 2);
  const tail = values.tail ?? '100';
  if (!/^(\d{1,6}|all)$/.test(tail)) fail('--tail 需要行数或 all', 2);
  return run('docker', [...composeCommand(home, state), 'logs', '--tail', tail, ...(values.follow ? ['-f'] : []), ...(service ? [service] : [])]);
}

// ---------- update ----------
export const UPDATE_OPTIONS = { 'no-backup': { type: 'boolean' }, 'no-pull': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } };

/** Tags the images the running containers use, so the previous version can be started again. */
export function tagRollbackImages(project, serviceNames, label) {
  const tags = {};
  for (const service of serviceNames) {
    const id = serviceContainer(project, service);
    const image = id ? inspect(id)?.Image : null;
    if (!image) continue;
    const tag = `rokbot-rollback/${project}-${service}:${label}`;
    if (docker(['tag', image, tag]).status !== 0) fail(`无法为 ${service} 打回滚标签`);
    tags[service] = tag;
  }
  return tags;
}

export async function updateCommand(argv) {
  const { values, rest } = parseCommandArgs(argv, UPDATE_OPTIONS);
  const { home, state } = instance(values);
  requireDocker();
  const label = stamp();
  if (state.mode === 'source') {
    const src = state.source;
    if (existsSync(path.join(src, '.git'))) {
      const head = capture('git', ['-C', src, 'rev-parse', 'HEAD']).stdout.trim();
      if (head) {
        await runChecked('git', ['-C', src, 'tag', `rokbot-rollback-${label}`, head], {}, '打回滚标签');
        out(`源码回滚标签：rokbot-rollback-${label}（${head.slice(0, 12)}）`);
      }
      if (!values['no-pull']) await runChecked('git', ['-C', src, 'pull', '--ff-only'], {}, '拉取新代码');
    } else if (!values['no-pull']) {
      err(`${src} 不是 git 仓库，跳过拉取；请先把新版源码解到该目录。`);
    }
    // deploy.py update builds a candidate, stops the project, backs up every volume and switches.
    out('运行 host/deploy.py update（构建候选镜像、停止、备份数据卷、切换）…');
    await runChecked('python3', [deployScript(state), ...deployGlobalArgs(home, state), 'update', ...rest], { input: '' }, 'host/deploy.py update');
    out('', `更新完成。备份在 ${path.join(home, 'backups')}。`,
      `需要退回旧代码时：git -C ${src} checkout rokbot-rollback-${label} 后再运行 rokbot update --no-pull。`);
    return;
  }

  const tags = tagRollbackImages(state.project, ['host', 'box'], label);
  if (Object.keys(tags).length) out(`回滚标签：${Object.values(tags).join('、')}`);
  else out('没有正在使用的容器，跳过回滚标签。');
  let backupDir = null;
  if (!values['no-backup'] && tags.host) {
    backupDir = path.join(home, 'backups', `${state.project}-${label}`);
    out(`备份数据卷到 ${backupDir}（host/release/backup.py）…`);
    const hostImage = inspect(serviceContainer(state.project, 'host'))?.Image;
    await runChecked('python3', [path.join(RELEASE_DIR, 'backup.py'), 'backup', '--project', state.project, '--directory', backupDir, '--image', hostImage],
      { input: '' }, '备份');
    // The backup pauses the containers; let the health check settle before Compose waits on it.
    out('等待 Host 恢复健康…');
    await waitHealthy(serviceContainer(state.project, 'host'), { timeoutMs: 180_000 });
  }
  await writePrivateFile(path.join(home, 'rollback.json'), `${JSON.stringify({ label, tags, backup: backupDir, createdAt: new Date().toISOString() }, null, 2)}\n`);
  await runChecked('bash', [path.join(RELEASE_DIR, 'install-images.sh'), '--local', ...(values['no-pull'] ? ['--pull-never'] : [])], { cwd: home, input: '' }, '拉取并重启');
  out('', '更新完成。', ...(Object.keys(tags).length ? [`新版本有问题时：rokbot rollback（切回 ${label} 的镜像）`] : []));
}

// ---------- rollback (image mode) ----------
export const ROLLBACK_OPTIONS = { yes: { type: 'boolean', short: 'y' } };

/** Points ROKBOT_HOST_IMAGE / ROKBOT_BOX_IMAGE in .env at the rollback tags, keeping every other line. */
export function rewriteImages(envText, tags) {
  const keys = { host: 'ROKBOT_HOST_IMAGE', box: 'ROKBOT_BOX_IMAGE' };
  let text = envText;
  for (const [service, tag] of Object.entries(tags)) {
    const key = keys[service];
    if (!key) continue;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, `${key}=${tag}`) : `${text.replace(/\n?$/, '\n')}${key}=${tag}\n`;
  }
  return text;
}

export async function rollbackCommand(argv) {
  const { values } = parseCommandArgs(argv, ROLLBACK_OPTIONS);
  const { home, state } = instance(values);
  if (state.mode !== 'image') fail('源码模式请用 git 回滚标签：git checkout rokbot-rollback-<时间> 后运行 rokbot update --no-pull', 2);
  const file = path.join(home, 'rollback.json');
  if (!existsSync(file)) fail('没有回滚记录（rokbot update 会生成）。');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  requireDocker();
  for (const tag of Object.values(record.tags)) if (!imageExists(tag)) fail(`回滚镜像 ${tag} 不存在`);
  out(`切回 ${record.label} 的镜像：${Object.values(record.tags).join('、')}`,
    '注意：新版本若已迁移数据，旧镜像可能无法读取；最稳妥的办法是按 docs/AI-INSTALL.md 的卷恢复清单把备份恢复到新项目。',
    ...(record.backup ? [`本次更新前的备份：${record.backup}`] : []));
  const envFile = path.join(home, '.env');
  const before = readFileSync(envFile, 'utf8');
  await writePrivateFile(envFile, rewriteImages(before, record.tags));
  await runChecked('bash', [path.join(RELEASE_DIR, 'install-images.sh'), '--local', '--pull-never'], { cwd: home, input: '' }, '回滚启动');
  out('已回滚。之后要恢复跟随最新镜像，把 .env 中的 ROKBOT_HOST_IMAGE / ROKBOT_BOX_IMAGE 改回原值，再运行 rokbot update。');
}

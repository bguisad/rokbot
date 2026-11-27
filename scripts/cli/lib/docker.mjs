// Small Docker queries used by status, admin and update. Containers are found by Compose labels,
// so they work for both image-mode and source-mode (host/deploy.py) projects.
import { capture, CliError } from './util.mjs';

export function docker(args, options) {
  return capture('docker', args, options);
}

export function serviceContainer(project, service) {
  const result = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}']);
  if (result.status !== 0) return null;
  return result.stdout.trim().split('\n').filter(Boolean)[0] ?? null;
}

export function inspect(id) {
  const result = docker(['inspect', id]);
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout)[0] ?? null; } catch { return null; }
}

export function imageExists(ref) {
  return docker(['image', 'inspect', '--format', '{{.Id}}', ref]).status === 0;
}

export function requireDocker() {
  const result = docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
  if (result.status !== 0) throw new CliError('无法连接 Docker。请确认 Docker 已安装并正在运行，当前用户有权限访问。');
  return result.stdout.trim();
}

/** Waits until a container reports healthy (or running, when it has no health check). */
export async function waitHealthy(id, { timeoutMs = 300_000, intervalMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = inspect(id);
    const state = info?.State;
    if (state?.Health?.Status === 'healthy' || (state?.Running && !state?.Health)) return true;
    if (state && !state.Running && state.Status === 'exited') throw new CliError(`容器已退出（退出码 ${state.ExitCode}），用 rokbot logs 查看原因`);
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** Whether Docker already has containers or volumes for a Compose project (another instance). */
export function projectInUse(project) {
  const containers = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]);
  const volumes = docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
  const named = docker(['volume', 'ls', '-q', '--filter', `name=^${project}_host-data$`]);
  if ([containers, volumes, named].some(result => result.status !== 0)) return null;
  return Boolean(containers.stdout.trim() || volumes.stdout.trim() || named.stdout.trim());
}

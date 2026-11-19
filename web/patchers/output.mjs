import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function existingTarget(target, force) {
  let info;
  try { info = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!force) throw new Error(`输出已存在，不会覆盖（可加 --force）：${target}`);
  if (!info.isFile()) throw new Error(`输出不是普通文件，不会覆盖：${target}`);
  return true;
}

async function publishNew(source, target) {
  try { await link(source, target); } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL', 'EXDEV'].includes(error.code)) throw error;
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

// Stage artifacts on the destination volume. Never replace an unclaimed name, and
// keep prior files recoverable if the filesystem also refuses a rollback operation.
export async function writeBuildOutput(root, entries, force) {
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(path.join(root, '.rokbot-web-build-'));
  const backups = [], published = [];
  let keepStage = false;
  try {
    for (const [i, { bytes }] of entries.entries()) await writeFile(path.join(stage, `new-${i}`), bytes, { flag: 'wx' });
    for (const [i, { target }] of entries.entries()) {
      if (await existingTarget(target, force)) {
        const backup = path.join(stage, `previous-${i}`);
        await rename(target, backup);
        backups.push({ backup, target });
      }
      await publishNew(path.join(stage, `new-${i}`), target);
      published.push(target);
    }
  } catch (error) {
    const failures = [];
    for (const target of published.reverse()) {
      try { await unlink(target); } catch (cause) { failures.push(cause); }
    }
    for (const { backup, target } of backups.reverse()) {
      try { await publishNew(backup, target); } catch (cause) { failures.push(cause); }
    }
    if (failures.length) {
      keepStage = true;
      throw new AggregateError([error, ...failures], `发布失败，无法完成回滚；已保留暂存文件：${stage}`, { cause: error });
    }
    throw error;
  } finally {
    if (!keepStage) await rm(stage, { recursive: true, force: true });
  }
}

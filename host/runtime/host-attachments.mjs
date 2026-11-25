import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// compose.memory.yaml mounts this tree read-only on a same-machine Bot computer, at the path
// the Host itself uses.
const MOUNTED_AGENTS = '/data/runtime/host-data/agents';

/** True when the Bot computer already reads the Host's agents tree through the read-only mount. */
export function agentsMountedOnBox(agents, env = process.env) {
  const enabled = (env.ROKBOT_HOST_MEMORY_MOUNTS ?? env.GROKBOT_HOST_MEMORY_MOUNTS) === '1';
  return enabled && agents === MOUNTED_AGENTS;
}

// Host and execution nodes need not share a filesystem. The original prompt
// identifies managed attachments as already present on the Bot computer.
// With the read-only memory mounts they already are there, and writing a copy
// would fail with EROFS and end the turn.
export async function syncTurnAttachments(options, turn, library, root = process.env.SAND_DATA_ROOT, env = process.env) {
  const paths = [...turn.attachedFilePaths ?? [],
    ...(turn.selectedImages ?? []).map(image => image.path),
    ...(turn.selectedVideos ?? []).map(video => video.path)];
  if (!root || !paths.length) return;
  const resolvedRoot = resolve(root);
  const agents = join(resolvedRoot, 'agents');
  if (agentsMountedOnBox(agents, env)) return;
  if (typeof options?.remoteBox?.uploadFile !== 'function') return;
  const realRoot = await realpath(resolvedRoot);
  const realAgents = await realpath(agents);
  if (realAgents !== join(realRoot, 'agents')) {
    throw new Error('Invalid managed attachment path');
  }
  const agentId = options.getAgentId?.() ?? options.agentStore?.getId();
  const [context, cancel] = library.createContext().withCancel();
  const timer = setTimeout(() => cancel(new Error('Attachment transfer timed out')), 120_000);
  const transferred = new Set();
  try {
    for (const value of new Set(paths)) {
      if (typeof value !== 'string') continue;
      const path = value.startsWith('file:') ? fileURLToPath(value) : resolve(value);
      if (transferred.has(path)) continue;
      const rel = relative(agents, path);
      if (!/^[a-f0-9-]+\/attachments\/[^/]+$/i.test(rel)) continue;
      if (await realpath(path) !== join(realAgents, rel)) {
        throw new Error('Invalid managed attachment path');
      }
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 200 * 1024 * 1024) throw new Error('Invalid attachment size');
        const bytes = await file.readFile();
        if (bytes.length !== info.size) throw new Error('Attachment changed during transfer');
        try {
          await options.remoteBox.uploadFile(context, agentId, path, bytes);
          transferred.add(path);
        } catch (err) {
          console.warn(`[host-attachments] Failed to sync attachment to box: ${err?.message ?? err}`);
        }
      } finally { await file.close(); }
    }
  } finally { clearTimeout(timer); cancel(); }
}

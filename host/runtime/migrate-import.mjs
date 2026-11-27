import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writePrivate } from '../server/storage.mjs';
import { check } from '../server/security.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const AGENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];

/**
 * Host methods behind "Migrate from Grok Bot". The admin service has already validated the
 * bundle (migrate-schema.mjs); this layer re-checks shapes and makes every write idempotent: the
 * same request, or a later import of the same source, never adds a second copy of a memory,
 * skill or routine. Imported routines are always created paused.
 */
export function decorateLocalMigrationApi({ api, host, dataDir = process.env.ROKBOT_DATA_DIR ?? process.env.GROKBOT_DATA_DIR ?? process.env.ROKBOT_STATE_DIR ?? process.env.GROKBOT_STATE_DIR }) {
  const active = new Map();
  const statePath = id => join(dataDir, 'migrate-imports', `${id}.json`);
  async function loadState(id) {
    const state = await readJson(statePath(id), null);
    return state && typeof state === 'object' ? { memory: [], skills: [], routines: [], ...state } : { memory: [], skills: [], routines: [] };
  }
  const save = (id, state) => writePrivate(statePath(id), JSON.stringify(state));
  function memoryStore(agentId) {
    try {
      const memory = host.requireHostExtensions().api('memory');
      return { store: memory.createAgentStore(join(memory.options.agentsRootDir, agentId)), memory };
    } catch { return { store: null, memory: null }; }
  }

  async function importBot(args) {
    check(args && typeof args === 'object', 400, 'Invalid migration request');
    const agentId = args.agentId;
    check(typeof agentId === 'string' && AGENT_ID.test(agentId), 400, 'Invalid Bot ID');
    const manager = host.transcript, lifecycle = manager.agentLifecycle;
    const profile = {
      name: text(args.profile?.name, 100).trim(), title: text(args.profile?.title, 200), description: text(args.profile?.description, 30_000),
      ...(/^[a-zA-Z0-9_-]{1,80}$/.test(args.profile?.avatarShape ?? '') ? { avatarShape: args.profile.avatarShape } : {}),
      ...(/^[a-zA-Z0-9_-]{1,80}$/.test(args.profile?.avatarColor ?? '') ? { avatarColor: args.profile.avatarColor } : {}),
    };
    check(profile.name, 400, 'Bot name is required');
    const warnings = [], added = { memory: 0, skills: 0, routines: 0 }, kept = { memory: 0, skills: 0, routines: 0 };
    let existing = manager.listAgentsSync().find(agent => agent.id === agentId), created = false;
    if (!existing) {
      check(args.allowCreate !== false, 404, 'Target Bot no longer exists');
      const result = await manager.createAgent({ name: profile.name, title: profile.title || profile.name, description: profile.description,
        ...(profile.avatarShape ? { avatarShape: profile.avatarShape } : {}), ...(profile.avatarColor ? { avatarColor: profile.avatarColor } : {}) },
      'user', { agentId, isIntroductionSuppressed: true });
      existing = result?.agent ?? manager.listAgentsSync().find(agent => agent.id === agentId);
      check(existing, 500, 'Bot could not be created');
      created = true;
    } else if (args.updateProfile) {
      const patch = { name: profile.name, title: profile.title, description: profile.description,
        ...(profile.avatarShape ? { avatarShape: profile.avatarShape } : {}), ...(profile.avatarColor ? { avatarColor: profile.avatarColor } : {}) };
      if (typeof lifecycle?.updateAgent === 'function') await lifecycle.updateAgent(agentId, patch);
      else if (typeof api.updateAgent === 'function') await api.updateAgent({ id: agentId, profile: patch });
      else warnings.push('此 Host 不支持更新 Bot 资料，已保留原资料');
    }
    const state = await loadState(agentId);

    const avatar = args.avatarImage;
    if (avatar && typeof avatar.base64 === 'string' && avatar.base64.length <= 7 * 1024 * 1024) {
      const bytes = Buffer.from(avatar.base64, 'base64'), id = digest(bytes);
      if (state.avatar !== id) {
        if (typeof lifecycle?.setAgentAvatarBytes === 'function') { await lifecycle.setAgentAvatarBytes(agentId, new Uint8Array(bytes)); state.avatar = id; }
        else warnings.push('此 Host 不支持设置头像图片，已保留形状和颜色');
      }
    }
    const settings = args.settings && typeof args.settings === 'object' ? args.settings : {};
    if (typeof settings.hiddenFromSidebar === 'boolean' && typeof lifecycle?.setAgentHiddenFromSidebar === 'function')
      await lifecycle.setAgentHiddenFromSidebar(agentId, settings.hiddenFromSidebar);
    if (typeof settings.notifyOnUpdates === 'boolean' && typeof lifecycle?.setAgentNotifyOnUpdates === 'function')
      await lifecycle.setAgentNotifyOnUpdates(agentId, settings.notifyOnUpdates);

    for (const skill of list(args.skills, 300)) {
      const name = text(skill?.name, 100).trim(), description = text(skill?.description, 2000).trim() || name;
      // Imported frontmatter (triggers, live source references) is discarded; only the prose is kept.
      const body = text(skill?.content, 200_000).replace(/^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
      if (!name || !body) continue;
      const id = digest(`${name}\n${body}`);
      if (state.skills.includes(id)) { kept.skills++; continue; }
      const prior = await manager.getAgentWorkflows(agentId);
      if (!prior.some(item => item.name === name && item.body?.trim() === body)) {
        const markdown = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
        const result = await manager.importAgentSkillMarkdown(agentId, markdown, name);
        if (!(result?.result?.imported?.length > 0)) { warnings.push(`技能「${name}」未能导入`); continue; }
        added.skills++;
      } else kept.skills++;
      state.skills.push(id); await save(agentId, state);
    }

    for (const routine of list(args.routines, 300)) {
      const name = text(routine?.name, 100).trim(), prompt = text(routine?.prompt, 30_000).trim();
      if (!name || !prompt) continue;
      const id = digest(`${name}\n${prompt}`);
      const prior = await manager.getAgentAutomations(agentId);
      const found = prior.find(item => item.name === name && item.prompt === prompt);
      if (found) {
        if (found.isEnabled && !state.routines.includes(id)) await manager.setAgentAutomationEnabled(agentId, found.id, false);
        kept.routines++;
      } else if (state.routines.includes(id)) {
        kept.routines++; // Deleted by the user after an earlier import: do not bring it back.
        continue;
      } else {
        const trigger = routine.trigger === 'cron' && typeof routine.schedule === 'string' ? { type: 'cron', schedule: routine.schedule } : { type: 'webhook' };
        const result = await manager.createAgentAutomation(agentId, { name, prompt, trigger, isEnabled: false }, 'user');
        if (!(Array.isArray(result) && result.length > prior.length)) { warnings.push(`例程「${name}」未能导入`); continue; }
        // Belt and braces: whatever the store defaults to, a migrated routine starts paused.
        const createdRoutine = result.find(item => item.name === name && item.prompt === prompt);
        if (createdRoutine?.isEnabled) await manager.setAgentAutomationEnabled(agentId, createdRoutine.id, false);
        added.routines++;
      }
      if (!state.routines.includes(id)) { state.routines.push(id); await save(agentId, state); }
    }

    const memoryItems = list(args.memory, 5000);
    if (memoryItems.length) {
      const { store } = memoryStore(agentId);
      if (!store) warnings.push('记忆存储不可用，记忆未导入');
      else try {
        const present = new Set((typeof store.listMemories === 'function' ? store.listMemories(5000) ?? [] : []).map(item => item?.content).filter(Boolean));
        for (const item of memoryItems) {
          const content = text(item?.content, 20_000).trim();
          if (!content) continue;
          const id = digest(content);
          if (state.memory.includes(id) || present.has(content)) { kept.memory++; if (!state.memory.includes(id)) state.memory.push(id); continue; }
          const parsed = item.createdAt ? Date.parse(`${item.createdAt}T00:00:00Z`) : Date.now();
          store.addMemory(content, Number.isFinite(parsed) ? parsed : Date.now(), item.kind === 'profile' ? 'profile' : 'log');
          state.memory.push(id); added.memory++;
        }
        await save(agentId, state);
      } finally { store.setOnChange?.(undefined); }
    }
    await save(agentId, state);
    const agent = manager.listAgentsSync().find(item => item.id === agentId) ?? existing;
    return { agent: { id: agent.id, name: agent.name }, created, added, kept, warnings };
  }

  async function importUserMemory(args) {
    const items = list(args?.items, 5000);
    let userMemory = null;
    try { userMemory = host.requireHostExtensions().api('memory').userMemory ?? null; } catch {}
    check(userMemory && typeof userMemory.addMemory === 'function', 503, '共享用户记忆不可用');
    const state = await loadState('user-memory');
    const present = new Set((typeof userMemory.listMemories === 'function' ? userMemory.listMemories(5000) ?? [] : []).map(item => item?.content).filter(Boolean));
    let added = 0, kept = 0;
    for (const item of items) {
      const content = text(item?.content, 20_000).trim();
      if (!content) continue;
      const id = digest(content);
      if (state.memory.includes(id) || present.has(content)) { kept++; if (!state.memory.includes(id)) state.memory.push(id); continue; }
      const parsed = item.createdAt ? Date.parse(`${item.createdAt}T00:00:00Z`) : Date.now();
      userMemory.addMemory(content, Number.isFinite(parsed) ? parsed : Date.now(), item.kind === 'profile' ? 'profile' : 'log', 'user');
      state.memory.push(id); added++;
    }
    await save('user-memory', state);
    return { added, kept };
  }

  const serial = (key, work) => {
    const previous = active.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    active.set(key, next);
    return next.finally(() => { if (active.get(key) === next) active.delete(key); });
  };
  return { ...api,
    importLocalMigrationBot: args => serial(`bot:${args?.agentId}`, () => importBot(args)),
    importLocalMigrationUserMemory: args => serial('user-memory', () => importUserMemory(args)),
  };
}

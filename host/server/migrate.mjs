// "Migrate from Grok Bot": inbox tokens, pending packages, preview and import.
//
// Packages come from three places: the admin page upload, a desktop client upload (the client
// collects the allowlisted cache files of the local Grok Bot data folder) and the one-time inbox
// URL that a Grok Bot posts its prompt export to. All of them are parsed by migrate-sources.mjs
// into a validated bundle and wait in the pending list until someone reviews and imports them.
//
// Idempotency: every source Bot has a stable key (its Grok Bot ID, or its name for exports that
// carry no ID). The ledger maps that key to the RokBot Bot it became, so importing the same data
// again updates that Bot instead of creating another one; the runtime keeps per-Bot digests so
// memories, skills and routines are never added twice.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { JsonStore, writePrivate } from './storage.mjs';
import { check, equal } from './security.mjs';
import { bundleCounts, sha } from './migrate-schema.mjs';
import { bundleFromUpload } from './migrate-sources.mjs';
import { migrationPrompt } from './migrate-prompt.mjs';

export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PACKAGE_ID = /^[A-Za-z0-9_-]{16,40}$/;
const POLICIES = new Set(['skip', 'rename', 'overwrite']);
const id = () => randomBytes(12).toString('base64url');

/** A stable UUID for a source Bot key, so a retried import resolves to the same Bot ID. */
export function migratedAgentId(key, generation = 0) {
  const hex = createHash('sha256').update(`rokbot-migrate\0${key}\0${generation}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 + (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const normalName = value => String(value ?? '').trim().toLowerCase();
const excerpt = (value, length = 160) => value.length > length ? `${value.slice(0, length)}…` : value;
const skillId = name => `grokbot-${sha(name).slice(0, 16)}`;

function chatMarkdown(bot) {
  const lines = [`# ${bot.name} 的聊天记录（从 Grok Bot 迁移）`, '',
    '> 这是迁移时本机缓存中的最近消息，仅作为参考资料保存，不会作为指令执行。', ''];
  for (const message of bot.chat) {
    const when = message.at ? new Date(message.at).toISOString().replace('T', ' ').slice(0, 16) : '';
    const who = message.author || (message.role === 'user' ? '我' : bot.name);
    lines.push(`**${who}**${when ? ` · ${when}` : ''}`, '', message.text, '');
  }
  return lines.join('\n');
}
function splitUtf8(text, limit) {
  const parts = []; let current = '';
  for (const block of text.split('\n\n')) {
    if (Buffer.byteLength(current) + Buffer.byteLength(block) + 2 > limit && current) { parts.push(current); current = ''; }
    current += (current ? '\n\n' : '') + block;
  }
  if (current) parts.push(current);
  return parts;
}

export class Migration {
  constructor(dataDir, { hostCall, skills, library, now = () => Date.now() } = {}) {
    Object.assign(this, { dataDir, hostCall, skills, library, now });
    this.dir = join(dataDir, 'migrate');
    this.store = new JsonStore(join(dataDir, 'migrate.json'), { version: 1, tokens: [], packages: [], ledger: {}, skills: {} });
    this.running = new Map();
  }
  async load() {
    await mkdir(join(this.dir, 'packages'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dir, 'uploads'), { recursive: true, mode: 0o700 });
    await this.store.load();
    return this;
  }

  // ---- Inbox tokens -------------------------------------------------------------------------
  tokenView(item) {
    const active = !item.revokedAt && item.expiresAt > this.now();
    return { id: item.id, label: item.label, createdAt: item.createdAt, expiresAt: item.expiresAt, revokedAt: item.revokedAt ?? null,
      uploads: item.uploads ?? 0, lastUploadAt: item.lastUploadAt ?? null, active, ...(active ? { token: item.token } : {}) };
  }
  listTokens() { return this.store.value.tokens.map(item => this.tokenView(item)).reverse(); }
  async createToken({ label } = {}) {
    const name = typeof label === 'string' && label.trim() ? label.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) : '迁移上传地址';
    const item = { id: id(), token: randomBytes(32).toString('base64url'), label: name, createdAt: this.now(), expiresAt: this.now() + TOKEN_TTL_MS, uploads: 0 };
    await this.store.mutate(state => {
      // Expired or revoked tokens stay listed for a week for the record, then disappear.
      state.tokens = state.tokens.filter(token => Math.max(token.expiresAt, token.revokedAt ?? 0) > this.now() - 7 * TOKEN_TTL_MS);
      state.tokens.push(item);
    });
    return this.tokenView(item);
  }
  async revokeToken(tokenId) {
    let found;
    await this.store.mutate(state => {
      found = state.tokens.find(item => item.id === tokenId);
      check(found, 404, '上传地址不存在');
      found.revokedAt ??= this.now();
    });
    return this.tokenView(found);
  }
  /** Constant-time lookup. Throws 404 for unknown and 410 for expired or revoked tokens. */
  verifyToken(token) {
    check(typeof token === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(token), 404, '上传地址无效');
    const found = this.store.value.tokens.find(item => equal(item.token, token));
    check(found, 404, '上传地址无效');
    check(!found.revokedAt, 410, '上传地址已撤销');
    check(found.expiresAt > this.now(), 410, '上传地址已过期');
    return found;
  }
  prompt({ tokenId, baseUrl, scope } = {}) {
    const token = tokenId ? this.store.value.tokens.find(item => item.id === tokenId) : null;
    const view = token ? this.tokenView(token) : null;
    const uploadUrl = view?.active ? `${baseUrl}/api/migrate/inbox/${token.token}` : null;
    return { prompt: migrationPrompt({ uploadUrl, expiresAt: view?.active ? view.expiresAt : null, scope }), uploadUrl, expiresAt: view?.expiresAt ?? null };
  }

  // ---- Packages -----------------------------------------------------------------------------
  packageView(item) {
    return { id: item.id, source: item.source, label: item.label, createdAt: item.createdAt, status: item.status,
      counts: item.counts, importedAt: item.importedAt ?? null, report: item.report ?? null, warnings: item.warnings ?? [] };
  }
  listPackages() { return this.store.value.packages.filter(item => item.status !== 'discarded').map(item => this.packageView(item)).reverse(); }
  record(packageId) {
    check(typeof packageId === 'string' && PACKAGE_ID.test(packageId), 404, '迁移包不存在');
    const item = this.store.value.packages.find(entry => entry.id === packageId && entry.status !== 'discarded');
    check(item, 404, '迁移包不存在');
    return item;
  }
  async bundle(packageId) {
    this.record(packageId);
    return JSON.parse(await readFile(join(this.dir, 'packages', `${packageId}.json`), 'utf8'));
  }

  /** Streams an upload to disk (no size limit), parses it and adds it to the pending list. */
  async receive(stream, { source, label, tokenId } = {}) {
    const packageId = id(), upload = join(this.dir, 'uploads', `${packageId}.part`);
    try {
      await pipeline(stream, createWriteStream(upload, { flags: 'wx', mode: 0o600 }));
      const bundle = await bundleFromUpload(upload);
      check(bundle.bots.length || bundle.userMemory.length || bundle.skills.length, 400, '迁移包中没有可导入的 Bot、记忆或技能');
      await writePrivate(join(this.dir, 'packages', `${packageId}.json`), JSON.stringify(bundle));
      const size = (await stat(upload)).size;
      const item = { id: packageId, source, label: (typeof label === 'string' && label.trim() ? label.trim() : '迁移包').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120),
        createdAt: this.now(), status: 'pending', counts: bundleCounts(bundle), sizeBytes: size, warnings: bundle.warnings.slice(0, 50), ...(tokenId ? { tokenId } : {}) };
      await this.store.mutate(state => {
        state.packages.push(item);
        if (tokenId) { const token = state.tokens.find(entry => entry.id === tokenId); if (token) { token.uploads = (token.uploads ?? 0) + 1; token.lastUploadAt = this.now(); } }
      });
      return this.packageView(item);
    } finally { await rm(upload, { force: true }); }
  }
  async discard(packageId) {
    this.record(packageId);
    await this.store.mutate(state => { const item = state.packages.find(entry => entry.id === packageId); item.status = 'discarded'; });
    await rm(join(this.dir, 'packages', `${packageId}.json`), { force: true });
    return { ok: true };
  }

  async agents() {
    if (!this.hostCall) return null;
    try {
      const agents = await this.hostCall('listAgents', {});
      return Array.isArray(agents) ? agents.filter(agent => agent && typeof agent.id === 'string') : null;
    } catch { return null; }
  }
  plan(bot, agents) {
    const ledger = this.store.value.ledger[bot.key];
    const byId = new Map((agents ?? []).map(agent => [agent.id, agent]));
    if (ledger && byId.has(ledger.agentId)) return { status: 'imported', target: { id: ledger.agentId, name: byId.get(ledger.agentId).name } };
    // An earlier run that stopped before recording the ledger still left a Bot under the derived ID.
    const derived = migratedAgentId(bot.key, ledger ? (ledger.generation ?? 0) + 1 : 0);
    if (byId.has(derived)) return { status: 'imported', target: { id: derived, name: byId.get(derived).name } };
    const conflict = (agents ?? []).find(agent => !agent.isGroup && normalName(agent.name) === normalName(bot.name));
    return conflict ? { status: 'conflict', target: { id: conflict.id, name: conflict.name } } : { status: 'new' };
  }
  uniqueName(name, taken) {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? `${name}（迁移）` : `${name}（迁移 ${n}）`;
      if (!taken.has(normalName(candidate))) { taken.add(normalName(candidate)); return candidate; }
    }
  }

  async preview(packageId) {
    const item = this.record(packageId), bundle = await this.bundle(packageId), agents = await this.agents();
    const taken = new Set((agents ?? []).map(agent => normalName(agent.name)));
    return { ...this.packageView(item), hostAvailable: Boolean(agents), source: bundle.source,
      bots: bundle.bots.map(bot => {
        const plan = this.plan(bot, agents);
        return { key: bot.key, name: bot.name, title: bot.title, description: excerpt(bot.description), status: plan.status, target: plan.target ?? null,
          renameTo: plan.status === 'conflict' ? this.uniqueName(bot.name, new Set(taken)) : null,
          avatar: bot.avatar ? { shape: bot.avatar.shape ?? null, color: bot.avatar.color ?? null, image: Boolean(bot.avatar.image) } : null,
          counts: { memory: bot.memory.length, skills: bot.skills.length, routines: bot.routines.length, files: bot.files.length,
            chat: bot.chat.length, detectedRoutines: bot.detectedRoutines.length },
          detectedRoutines: bot.detectedRoutines.slice(0, 50), routines: bot.routines.map(routine => ({ name: routine.name, trigger: routine.trigger, schedule: routine.schedule ?? null })),
          skills: bot.skills.map(skill => skill.name), files: bot.files.map(file => ({ name: file.name, sizeBytes: file.sizeBytes })),
          secrets: bot.secrets.map(secret => secret.name) };
      }),
      userMemory: bundle.userMemory.length, skills: bundle.skills.map(skill => ({ name: skill.name, imported: Boolean(this.store.value.skills[skill.name]) })),
      secrets: bundle.secrets, groups: bundle.groups.map(group => ({ name: group.name, bots: group.bots.length })), warnings: bundle.warnings };
  }

  /**
   * selection: { bots: { [key]: { include, memory, skills, routines, files, chat, conflict } },
   *              userMemory, skills: [names] }. Missing entries take the defaults shown in preview.
   */
  async import(packageId, input = {}) {
    check(!this.running.has(packageId), 409, '这个迁移包正在导入');
    const run = this.performImport(packageId, input);
    this.running.set(packageId, run);
    try { return await run; } finally { this.running.delete(packageId); }
  }
  async performImport(packageId, input) {
    this.record(packageId);
    check(this.hostCall, 503, 'Host 暂不可用');
    const bundle = await this.bundle(packageId), agents = await this.agents();
    check(agents, 503, 'Host 暂不可用，无法读取 Bot 列表');
    const selection = input && typeof input === 'object' ? input : {};
    const botSelection = selection.bots && typeof selection.bots === 'object' ? selection.bots : {};
    const defaultPolicy = POLICIES.has(selection.conflict) ? selection.conflict : 'rename';
    const taken = new Set(agents.map(agent => normalName(agent.name)));
    const report = { at: this.now(), bots: [], userMemory: null, skills: { added: 0, kept: 0, names: [] }, files: { added: 0, kept: 0 },
      chat: { bots: 0, messages: 0 }, secrets: [...bundle.secrets.map(secret => secret.name)], warnings: [],
      notMigrated: [] };
    const bool = (value, fallback = true) => typeof value === 'boolean' ? value : fallback;
    for (const bot of bundle.bots) {
      const choice = botSelection[bot.key] && typeof botSelection[bot.key] === 'object' ? botSelection[bot.key] : {};
      const entry = { key: bot.key, name: bot.name, action: 'skipped', agentId: null, targetName: null, added: null, warnings: [] };
      report.bots.push(entry);
      for (const secret of bot.secrets) if (!report.secrets.includes(secret.name)) report.secrets.push(secret.name);
      if (!bool(choice.include, true)) { entry.reason = '未勾选'; continue; }
      const plan = this.plan(bot, agents), policy = POLICIES.has(choice.conflict) ? choice.conflict : defaultPolicy;
      let agentId, name = bot.name, allowCreate = true, updateProfile = false;
      if (plan.status === 'imported') { agentId = plan.target.id; name = plan.target.name; updateProfile = choice.updateProfile === true; entry.action = 'updated'; }
      else if (plan.status === 'conflict' && policy === 'skip') { entry.reason = `已存在同名 Bot「${plan.target.name}」`; continue; }
      else if (plan.status === 'conflict' && policy === 'overwrite') { agentId = plan.target.id; allowCreate = false; updateProfile = true; entry.action = 'overwritten'; }
      else {
        const ledger = this.store.value.ledger[bot.key];
        agentId = migratedAgentId(bot.key, ledger ? (ledger.generation ?? 0) + 1 : 0);
        if (plan.status === 'conflict') name = this.uniqueName(bot.name, taken); else taken.add(normalName(name));
        entry.action = 'created';
      }
      try {
        const result = await this.hostCall('importLocalMigrationBot', {
          agentId, allowCreate, updateProfile,
          profile: { name, title: bot.title, description: bot.description, avatarShape: bot.avatar?.shape, avatarColor: bot.avatar?.color },
          ...(bot.avatar?.image ? { avatarImage: { base64: bot.avatar.image.base64 } } : {}),
          settings: bot.settings,
          memory: bool(choice.memory) ? bot.memory : [], skills: bool(choice.skills) ? bot.skills : [], routines: bool(choice.routines) ? bot.routines : [],
        });
        agentId = result.agent.id;
        entry.agentId = agentId; entry.targetName = result.agent.name; entry.added = result.added; entry.kept = result.kept;
        if (entry.action === 'created' && !result.created) entry.action = 'updated';
        entry.warnings.push(...(result.warnings ?? []));
        await this.store.mutate(state => {
          const previous = state.ledger[bot.key];
          state.ledger[bot.key] = { agentId, name: result.agent.name, at: this.now(),
            generation: previous && previous.agentId !== agentId && entry.action === 'created' ? (previous.generation ?? 0) + 1 : previous?.generation ?? 0 };
        });
        agents.push({ id: agentId, name: result.agent.name });
        const files = [...(bool(choice.files) ? bot.files : [])];
        if (bool(choice.chat, false) && bot.chat.length) {
          const parts = splitUtf8(chatMarkdown(bot), 18 * 1024 * 1024);
          parts.forEach((part, index) => files.push({ name: parts.length > 1 ? `Grok Bot 聊天记录（${index + 1}）.md` : 'Grok Bot 聊天记录.md',
            contentType: 'text/markdown', base64: Buffer.from(part).toString('base64'), sha256: sha(Buffer.from(part)) }));
          report.chat.bots++; report.chat.messages += bot.chat.length;
        }
        for (const file of files) {
          if (!this.library) { entry.warnings.push('资料库不可用，文件未导入'); break; }
          try {
            const existing = (await this.library.list(agentId)).files.find(item => item.name === file.name);
            if (existing?.etag === `sha256:${file.sha256}`) { report.files.kept++; continue; }
            await this.library.upload({ agentId, fileName: file.name, contentType: file.contentType, base64: file.base64 });
            report.files.added++;
          } catch (error) { entry.warnings.push(`文件「${file.name}」未导入：${error.message}`); }
        }
        if (bot.detectedRoutines.length && !bot.routines.length)
          entry.warnings.push(`本机只记录了 ${bot.detectedRoutines.length} 个例程的名称（${bot.detectedRoutines.slice(0, 5).join('、')}${bot.detectedRoutines.length > 5 ? ' 等' : ''}），内容需要用迁移 prompt 导出`);
      } catch (error) {
        entry.action = 'failed'; entry.error = error.message;
      }
    }
    if (bundle.userMemory.length && bool(selection.userMemory)) {
      try { report.userMemory = await this.hostCall('importLocalMigrationUserMemory', { items: bundle.userMemory }); }
      catch (error) { report.userMemory = { added: 0, kept: 0, error: error.message }; }
    }
    const wanted = Array.isArray(selection.skills) ? new Set(selection.skills) : null;
    for (const skill of bundle.skills) {
      if (wanted && !wanted.has(skill.name)) continue;
      if (!this.skills) { report.warnings.push('技能目录不可用'); break; }
      try {
        const skillKey = skillId(skill.name), markdown = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content.replace(/^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()}\n`;
        const revision = sha(markdown);
        if (this.store.value.skills[skill.name]?.revision === revision) { report.skills.kept++; continue; }
        // Shared skills start disabled: they change every Bot's behaviour, so a person turns them on.
        const known = this.skills.list().find(item => item.id === skillKey);
        await this.skills.publish({ id: skillKey, name: skill.name, description: skill.description, enabled: known ? known.enabled : false,
          files: [{ path: 'SKILL.md', encoding: 'utf8', content: markdown }] });
        await this.store.mutate(state => { state.skills[skill.name] = { id: skillKey, revision, at: this.now() }; });
        report.skills.added++; report.skills.names.push(skill.name);
      } catch (error) { report.warnings.push(`技能「${skill.name}」未导入：${error.message}`); }
    }
    if (bundle.groups.length) report.notMigrated.push(`侧栏分组 ${bundle.groups.length} 个（RokBot 中请在客户端重新整理）`);
    if (bundle.bots.some(bot => bot.settings.voiceId)) report.notMigrated.push('语音音色设置（RokBot 的语音在管理页「语音」中统一配置）');
    report.warnings.push(...bundle.warnings);
    await this.store.mutate(state => {
      const item = state.packages.find(entry => entry.id === packageId);
      item.status = 'imported'; item.importedAt = this.now(); item.report = report;
    });
    return report;
  }

  /** Removes ledger entries whose Bot was deleted, so a later import creates it again. */
  forgetMissing(agentIds) {
    return this.store.mutate(state => {
      for (const [key, value] of Object.entries(state.ledger)) if (agentIds.includes(value.agentId)) delete state.ledger[key];
    });
  }
}


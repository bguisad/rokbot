// Shared fixtures for the Grok Bot migration tests: a synthetic Grok Bot data folder, a small
// deflate ZIP writer, and an in-memory stand-in for the original Host transcript manager.
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

export const BOT_A = '11111111-1111-4111-8111-111111111111';
export const BOT_B = '22222222-2222-4222-8222-222222222222';
export const GROUP = '33333333-3333-4333-8333-333333333333';
// Built at runtime so repository secret scanners never see a credential-shaped literal.
export const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');

export function blobName(key) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567', bytes = Buffer.from(key, 'utf8');
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return `${out}.blob`;
}
const slice = (account, name) => `sand.client.slice.account.${account}.${name}`;
const wrap = value => JSON.stringify({ schemaVersion: 1, value });

export function grokBotSlices(account = 'grok%7Cuser_TEST') {
  return {
    [slice(account, 'roster.last-roster')]: JSON.stringify({ schemaVersion: 4, value: { rows: [
      { id: BOT_A, name: '写作助手', title: '帮我写稿', description: '你是一位细致的中文写作助手。', avatarShape: 'blob', avatarColor: 'teal',
        createdAt: 1, updatedAt: 5, notificationsEnabled: true, notifyOnUpdatesEnabled: false, isHiddenFromSidebar: false, voiceId: 'v1', voiceSpeed: 1 },
      { id: BOT_B, name: 'Research', title: '', description: 'Find sources.', createdAt: 2, updatedAt: 3 },
      { id: GROUP, name: 'Team chat', isGroup: true, createdAt: 3 },
    ] } }),
    [slice(account, 'sidebar.last-sections')]: wrap({ sections: [{ id: 's1', name: '工作', agentIds: [BOT_A, BOT_B] }] }),
    [slice(account, `transcript.replicas.${BOT_A}`)]: wrap({ entries: [
      { kind: 'message', role: 'user', content: `帮我写一段开场白，密钥是 ${FAKE_KEY}`, seq: 1, timestampMs: 1000 },
      { kind: 'send-message', message: { type: 'text', content: '好的，这是开场白。' }, seq: 2, timestampMs: 2000 },
      { kind: 'event', event: { type: 'automation-changed', action: 'created', automationId: 'r1', automationName: '每日选题' }, seq: 3 },
      { kind: 'event', event: { type: 'automation-changed', action: 'created', automationId: 'r2', automationName: '旧例程' }, seq: 4 },
      { kind: 'event', event: { type: 'automation-changed', action: 'deleted', automationId: 'r2', automationName: '旧例程' }, seq: 5 },
      { kind: 'send-message', message: { type: 'secret-request', secretRequest: { label: 'NOTION_TOKEN', target: 'notion', description: 'Notion 集成' } }, seq: 6 },
    ] }),
    [slice(account, 'mcp.connect-logos')]: wrap({ logos: [{ key: 'gmail', name: 'Gmail', logo: 'data:...' }] }),
    [slice(account, 'selection.last-agent')]: wrap({ agentId: BOT_A }),
  };
}

/** Writes a folder shaped like ~/Library/Application Support/Grok Bot, including files the importer must never open. */
export async function writeGrokBotFolder(root, { legacy = false } = {}) {
  await mkdir(join(root, 'sand-client-persistence'), { recursive: true });
  await mkdir(join(root, 'automation-webhook-keys'), { recursive: true });
  const slices = grokBotSlices();
  if (legacy) await writeFile(join(root, 'local-client-persistence.json'), JSON.stringify(slices));
  else for (const [key, value] of Object.entries(slices)) await writeFile(join(root, 'sand-client-persistence', blobName(key)), value);
  await writeFile(join(root, 'sand-secrets.json'), JSON.stringify({ version: 1, 'cursor-accounts': 'SECRET-ACCOUNT-TOKEN-VALUE' }));
  await writeFile(join(root, 'connection.json'), JSON.stringify({ encryptedToken: 'SECRET-CONNECTION' }));
  await writeFile(join(root, 'Cookies'), 'SECRET-COOKIE');
  await writeFile(join(root, 'automation-webhook-keys', 'abc.bin'), 'SECRET-WEBHOOK');
  return root;
}

/** Minimal deflate ZIP writer for tests (the importer must read deflate and stored entries). */
export function zipFiles(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ c >>> 8; return (c ^ 0xffffffff) >>> 0; };
  const local = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value), packed = deflateRawSync(data), path = Buffer.from(name);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc(data), 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(path.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(8, 10); record.writeUInt32LE(crc(data), 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(path.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, path, packed); central.push(record, path); offset += 30 + path.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function folderZip(prefix = 'Grok Bot/') {
  const files = {};
  for (const [key, value] of Object.entries(grokBotSlices())) files[`${prefix}sand-client-persistence/${blobName(key)}`] = value;
  files[`${prefix}sand-secrets.json`] = '{"cursor-accounts":"SECRET"}';
  files[`${prefix}Cache/Cache_Data/data_1`] = Buffer.alloc(4096, 1);
  return zipFiles(files);
}

export function sampleBundle(overrides = {}) {
  return {
    schema: 'rokbot.migrate', version: 1, source: { product: 'Grok Bot', exportedBy: '写作助手' },
    bots: [{
      sourceId: BOT_A, name: '写作助手', title: '帮我写稿', description: '你是一位细致的中文写作助手。',
      avatar: { shape: 'blob', color: 'teal' },
      memory: [{ kind: 'profile', content: '用户喜欢简洁的标题', createdAt: '2026-10-01' }, { kind: 'log', content: '11 月完成了三篇稿件' }],
      skills: [{ name: '写标题', description: '写标题时使用', content: '---\nname: x\ntrigger: always\n---\n给出三个标题候选。' }],
      routines: [{ name: '每日选题', prompt: '整理今天的三个选题', trigger: { type: 'cron', schedule: '0 9 * * 1-5' }, timeZone: 'Asia/Shanghai', isEnabled: true }],
      files: [{ name: '风格指南.md', text: '# 风格\n短句。' }],
      chat: [{ role: 'user', text: '你好', at: '2026-11-01T00:00:00Z' }, { role: 'assistant', text: '你好，我在。' }],
      secrets: [{ name: 'NOTION_TOKEN', usedBy: '每日选题' }],
    }],
    userMemory: [{ kind: 'profile', content: '用户住在上海' }],
    skills: [{ name: '共享周报', description: '写周报', content: '按项目分组写周报。' }],
    secrets: [{ name: 'GITHUB_TOKEN', description: '代码同步' }],
    ...overrides,
  };
}

/** An in-memory transcript manager with the methods the migration runtime calls. */
export function fakeOriginalHost() {
  const agents = [], workflows = new Map(), automations = new Map(), memories = new Map(), userMemory = [], avatars = new Map(), calls = [];
  const memoryStore = list => ({
    listMemories: () => list.map(item => ({ ...item })),
    addMemory: (content, createdAt, kind) => { list.push({ content, createdAt, kind }); },
    setOnChange() {},
  });
  const transcript = {
    listAgentsSync: () => agents.map(agent => ({ ...agent })),
    async createAgent(profile, origin, { agentId } = {}) {
      calls.push(['createAgent', agentId]);
      const agent = { id: agentId ?? randomUUID(), ...profile }; agents.push(agent); return { agent: { ...agent } };
    },
    agentLifecycle: {
      async updateAgent(id, patch) { const agent = agents.find(item => item.id === id); Object.assign(agent, patch); return { ...agent }; },
      async setAgentAvatarBytes(id, bytes) { avatars.set(id, Buffer.from(bytes)); },
      async setAgentHiddenFromSidebar(id, value) { agents.find(item => item.id === id).isHiddenFromSidebar = value; },
      async setAgentNotifyOnUpdates(id, value) { agents.find(item => item.id === id).notifyOnUpdates = value; },
    },
    async getAgentWorkflows(id) { return (workflows.get(id) ?? []).map(item => ({ ...item })); },
    async importAgentSkillMarkdown(id, markdown, name) {
      const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      const list = workflows.get(id) ?? []; list.push({ id: `wf-${list.length}`, name, body }); workflows.set(id, list);
      return { result: { imported: [name] } };
    },
    async getAgentAutomations(id) { return (automations.get(id) ?? []).map(item => ({ ...item })); },
    async createAgentAutomation(id, spec) {
      const list = automations.get(id) ?? []; list.push({ id: `au-${list.length}`, ...spec }); automations.set(id, list);
      return list.map(item => ({ ...item }));
    },
    async setAgentAutomationEnabled(id, automationId, enabled) { automations.get(id).find(item => item.id === automationId).isEnabled = enabled; },
  };
  const host = {
    transcript,
    requireHostExtensions: () => ({ api: () => ({
      options: { agentsRootDir: '/agents' },
      createAgentStore: dir => { const id = basename(dir); if (!memories.has(id)) memories.set(id, []); return memoryStore(memories.get(id)); },
      userMemory: memoryStore(userMemory),
    }) }),
  };
  return { host, agents, workflows, automations, memories, userMemory, avatars, calls };
}

// Unit tests for the shared desktop/web group-chat creator (mac/clients/desktop/group-create.cjs),
// its desktop preload loader (group-create-loader.cjs), and main-process IPC registration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../clients/desktop');
const groupCreate = require(path.join(DESKTOP, 'group-create.cjs'));

test('group-create constants and normalizeGroupName trim, collapse whitespace, and truncate to 72 chars', () => {
  assert.equal(groupCreate.MAX_GROUP_BOTS, 6);
  assert.equal(groupCreate.MAX_GROUP_NAME_LENGTH, 72);

  assert.equal(groupCreate.normalizeGroupName(null), '');
  assert.equal(groupCreate.normalizeGroupName(undefined), '');
  assert.equal(groupCreate.normalizeGroupName('   '), '');
  assert.equal(groupCreate.normalizeGroupName('  Alpha   Beta\t\nGamma  '), 'Alpha Beta Gamma');

  const exact72 = 'A'.repeat(72);
  assert.equal(groupCreate.normalizeGroupName(exact72), exact72);

  const over72 = `${'A'.repeat(71)}   BBBB`;
  const normalized = groupCreate.normalizeGroupName(over72);
  assert.equal(normalized.length, 71);
  assert.equal(normalized, 'A'.repeat(71));

  const longWords = 'X'.repeat(90);
  assert.equal(groupCreate.normalizeGroupName(longWords).length, 72);
});

test('eligibleBots drops groups, sidebar-hidden Bots, missing ids, and duplicates', () => {
  const input = [
    null,
    { id: '', name: 'Blank Id' },
    { id: '   ', name: 'Whitespace Id' },
    { id: 'grp-1', name: 'Existing Group', isGroup: true },
    { id: 'hid-1', name: 'Hidden Bot', isHiddenFromSidebar: true },
    { id: 'bot-1', name: 'Alpha', title: 'Engineer', description: 'Builds things', avatarColor: 'blue' },
    { id: 'bot-1', name: 'Alpha Duplicate' },
    { id: 'bot-2', name: '  ', title: 'Writer', description: 'Docs', avatarDataUrl: 'data:image/png;base64,AA==' },
  ];

  const fromArray = groupCreate.eligibleBots(input);
  assert.equal(fromArray.length, 2);
  assert.deepEqual(fromArray.map(b => b.id), ['bot-1', 'bot-2']);
  assert.equal(fromArray[0].name, 'Alpha');
  assert.equal(fromArray[0].title, 'Engineer');
  assert.equal(fromArray[1].name, 'bot-2');
  assert.equal(fromArray[1].avatarDataUrl, 'data:image/png;base64,AA==');

  const fromWrapped = groupCreate.eligibleBots({ agents: input });
  assert.deepEqual(fromWrapped, fromArray);
  assert.deepEqual(groupCreate.eligibleBots(null), []);
});

test('filterBots matches name, title, and description case-insensitively', () => {
  const bots = [
    { id: 'a', name: 'Code Companion', title: 'Engineer', description: 'Terminal helper' },
    { id: 'b', name: 'Design Critic', title: 'UI Specialist', description: 'Reviews layouts' },
    { id: 'c', name: '产品助手', title: '需求分析', description: '撰写 PRD' },
  ];

  assert.equal(groupCreate.filterBots(bots, '').length, 3);
  assert.equal(groupCreate.filterBots(bots, '   ').length, 3);
  assert.deepEqual(groupCreate.filterBots(bots, 'companion').map(b => b.id), ['a']);
  assert.deepEqual(groupCreate.filterBots(bots, 'UI SPECIALIST').map(b => b.id), ['b']);
  assert.deepEqual(groupCreate.filterBots(bots, 'terminal').map(b => b.id), ['a']);
  assert.deepEqual(groupCreate.filterBots(bots, 'prd').map(b => b.id), ['c']);
  assert.deepEqual(groupCreate.filterBots(bots, 'code terminal').map(b => b.id), ['a']);
  assert.deepEqual(groupCreate.filterBots(bots, 'nonexistent'), []);
});

test('formatList and autoGroupName format zh and en lists for 1, 2, 3+ names and truncate at 72 chars', () => {
  assert.equal(groupCreate.formatList([], true), '');
  assert.equal(groupCreate.formatList(['A'], true), 'A');
  assert.equal(groupCreate.formatList(['A', 'B'], true), 'A和B');
  assert.equal(groupCreate.formatList(['A', 'B', 'C'], true), 'A、B和C');
  assert.equal(groupCreate.formatList(['A', 'B', 'C', 'D'], true), 'A、B、C和D');

  assert.equal(groupCreate.formatList([], false), '');
  assert.equal(groupCreate.formatList(['A'], false), 'A');
  assert.equal(groupCreate.formatList(['A', 'B'], false), 'A and B');
  assert.equal(groupCreate.formatList(['A', 'B', 'C'], false), 'A, B, and C');
  assert.equal(groupCreate.formatList(['A', 'B', 'C', 'D'], false), 'A, B, C, and D');

  const bots = [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }, { id: '3', name: 'Carol' }];
  assert.equal(groupCreate.autoGroupName(bots.slice(0, 1), true), 'Alice');
  assert.equal(groupCreate.autoGroupName(bots.slice(0, 2), true), 'Alice和Bob');
  assert.equal(groupCreate.autoGroupName(bots, true), 'Alice、Bob和Carol');
  assert.equal(groupCreate.autoGroupName(bots.slice(0, 1), false), 'Alice');
  assert.equal(groupCreate.autoGroupName(bots.slice(0, 2), false), 'Alice and Bob');
  assert.equal(groupCreate.autoGroupName(bots, false), 'Alice, Bob, and Carol');

  const longBots = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, name: `VeryLongBotName${i}_0123456789` }));
  assert.ok(groupCreate.autoGroupName(longBots, false).length <= 72);
  assert.ok(groupCreate.autoGroupName(longBots, true).length <= 72);
});

test('canSubmit enforces 1..6 Bots and submitting guard', () => {
  assert.equal(groupCreate.canSubmit([], false), false);
  assert.equal(groupCreate.canSubmit(['a'], false), true);
  assert.equal(groupCreate.canSubmit(['a', 'b', 'c', 'd', 'e', 'f'], false), true);
  assert.equal(groupCreate.canSubmit(['a', 'b', 'c', 'd', 'e', 'f', 'g'], false), false);
  assert.equal(groupCreate.canSubmit(['a'], true), false);
});

test('createGroupBody and groupIdFromReply match Host /api/createGroup contract', () => {
  assert.deepEqual(
    groupCreate.createGroupBody('  Design   Squad  ', ['bot-1', ' bot-2 ', 'bot-1', '']),
    { name: 'Design Squad', description: '', memberAgentIds: ['bot-1', 'bot-2'] },
  );

  assert.equal(groupCreate.groupIdFromReply({ agent: { id: 'group-123' } }), 'group-123');
  assert.equal(groupCreate.groupIdFromReply({ id: 'group-456' }), 'group-456');
  assert.equal(groupCreate.groupIdFromReply({ agent: { id: '' }, id: 'group-789' }), 'group-789');
  assert.equal(groupCreate.groupIdFromReply(null), '');
  assert.equal(groupCreate.groupIdFromReply({}), '');
});

function loadDesktopLoader() {
  const invoked = [];
  const sent = [];
  const ipcRenderer = {
    invoke: (channel, payload) => { invoked.push([channel, payload]); return Promise.resolve({ channel }); },
    send: (channel, payload) => { sent.push([channel, payload]); },
    sendSync: channel => (channel === 'rokbot-local:locale' ? 'zh-CN' : ''),
  };
  let installed = null;
  const loaderPath = require.resolve(path.join(DESKTOP, 'group-create-loader.cjs'));
  const originalLoad = Module._load;
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { readyState: 'complete' };
  globalThis.window = { addEventListener() {} };
  globalThis.window.top = globalThis.window;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcRenderer };
    if (request === './group-create.cjs') return { installGroupCreate: options => { installed = options; return { open() {}, close() {}, destroy() {} }; } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[loaderPath];
    require(loaderPath);
  } finally {
    Module._load = originalLoad;
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    delete require.cache[loaderPath];
  }
  return { invoked, sent, installed };
}

test('group-create-loader wires IPC channels and preload requires it', async () => {
  const { invoked, sent, installed } = loadDesktopLoader();
  assert.ok(installed, 'installGroupCreate was called');
  assert.equal(installed.locale, 'zh-CN');

  await installed.listAgents();
  assert.deepEqual(invoked[0], ['rokbot-local:group-list-agents', undefined]);

  const body = { name: 'Team', description: '', memberAgentIds: ['bot-1', 'bot-2'] };
  await installed.createGroup(body);
  assert.deepEqual(invoked[1], ['rokbot-local:group-create', body]);

  installed.openAgent('group-42');
  assert.deepEqual(sent, [['rokbot-local:open-agent', 'group-42']]);

  const preload = fs.readFileSync(path.join(DESKTOP, 'preload.cjs'), 'utf8');
  assert.match(preload, /require\('\.\/group-create-loader\.cjs'\)/);
});

test('desktop main.mjs registers group-create IPC channels with trusted() checks and gateway commands', () => {
  const main = fs.readFileSync(path.join(DESKTOP, 'main.mjs'), 'utf8');

  const listAt = main.indexOf("ipcMain.handle('rokbot-local:group-list-agents'");
  assert.ok(listAt > 0, 'rokbot-local:group-list-agents handler registered');
  const listBlock = main.slice(listAt, listAt + 400);
  assert.ok(listBlock.includes('trusted(event, mainWindow)'), 'group-list-agents checks trusted()');
  assert.ok(listBlock.includes("gateway.command('listAgents'"), 'group-list-agents calls listAgents');

  const createAt = main.indexOf("ipcMain.handle('rokbot-local:group-create'");
  assert.ok(createAt > 0, 'rokbot-local:group-create handler registered');
  const createBlock = main.slice(createAt, createAt + 1100);
  assert.ok(createBlock.includes('trusted(event, mainWindow)'), 'group-create checks trusted()');
  assert.ok(createBlock.includes("gateway.command('createGroup'"), 'group-create calls createGroup');

  const openAt = main.indexOf("ipcMain.on('rokbot-local:open-agent'");
  assert.ok(openAt > 0, 'rokbot-local:open-agent handler registered');
  const openBlock = main.slice(openAt, openAt + 300);
  assert.ok(openBlock.includes('trusted(event, mainWindow)'), 'open-agent checks trusted()');
  assert.ok(openBlock.includes('openAgent('), 'open-agent calls openAgent()');
});

test('group-create desktop files contain no emoji and no legacy brand strings', () => {
  const forbiddenBrand = new RegExp(['g', 'rok'].join(''), 'i');
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/u;
  for (const file of ['group-create.cjs', 'group-create-loader.cjs']) {
    const src = fs.readFileSync(path.join(DESKTOP, file), 'utf8');
    assert.doesNotMatch(src, forbiddenBrand, `${file} must not contain legacy brand`);
    assert.doesNotMatch(src, emojiRe, `${file} must not contain emoji`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createExtensionStarter } from '../runtime/host-extensions.mjs';
import { loadRecoveredHostCore } from '../runtime/recovered-host-core.mjs';
import { defaultPolicy } from '../runtime/model-policy.mjs';
import { decorateLocalHostAutomations } from '../runtime/host-automations.mjs';
import {
  applyLocalBotResourceRemoval,
  createLocalAgentStatePort,
  createLocalBotReferencePort,
  createLocalEffortToolPort,
  createLocalRunnerGates,
  createLocalTrackedTasksPort,
  sanitizeSelfHostedPromptText,
} from '../runtime/local-state-tools.mjs';

const HOST_DIR = resolve(import.meta.dirname, '..');

// Minimal valid 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

const EXPECTED_SELF_HOSTED_TOOLS = [
  // Core & boxWork
  'SendToUser',
  'ReactToMessage',
  'Shell',
  'Read',
  'AwaitShell',
  'Skill',
  // botState
  'UpdateMemory',
  'UpdateRoutine',
  'ListRoutineRuns',
  'UpdateSkill',
  'UpdateReference',
  'UpdateProfile',
  'UpdateAvatar',
  'ShowBotResources',
  'ListBotResources',
  'RemoveBotResource',
  'ListTrackedTasks',
  'CreateTrackedTasks',
  'UpdateTrackedTasks',
  'UpdateTrackedTaskTags',
  // botAdmin (local)
  'CreateAgent',
  'UpdateAgent',
  'SetPrimaryBot',
  'PostToGroupChat',
  'ReadGroupChat',
  'ListGroupBots',
  'RemoveGroupBot',
  'ListSections',
  // recall
  'RecallMemory',
  'ReadTranscript',
  'SearchTranscripts',
  'ReadAgentActivity',
  // talkToUser / actAsUser (local)
  'Screenshot',
  'RequestUserForm',
  'RemapUserFormTargets',
  'request_box_help',
  'DraftExternalMessage',
  'SendToAgent',
  // offBox
  'UploadFile',
  'DownloadFile',
  'CopyBotFile',
  'CopyToBox',
  'CopyFromBox',
  'ListMachines',
  // effort
  'SetEffort',
  // delegation
  'Task',
  'CheckSubagent',
  'MessageSubagent',
  'StopSubagent',
  'TodoWrite',
];

const EXPECTED_HIDDEN_CLOUD_TOOLS = [
  'DisconnectChannel',
  'CloudAgent',
  'SendEmail',
  'SendIMessage',
  'place_phone_call',
  'FlightSearch',
  'ProductSearch',
  'JoinMeeting',
  'UpdateMeeting',
  'OfferSlackConnect',
  'OfferEmailAddress',
];

test('createLocalAgentStatePort handles memory, routines (create/update/pause/delete), skills (workflow update/remove), profile, and avatar', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-state-port-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const memories = [];
  const userMemories = [];
  const automations = new Map();
  const skills = new Map();
  let profile = { name: 'Bot', description: 'Old' };
  let avatarBytes = null;
  let reconciled = 0;

  const session = {
    id: 'agent-1',
    automations: {
      upsert: (spec) => {
        const rec = { id: 'routine-1', ...spec, isEnabled: true };
        automations.set(rec.id, rec);
        return rec;
      },
      update: (id, spec) => {
        const prev = automations.get(id);
        if (!prev) return null;
        const next = { ...prev, ...spec };
        automations.set(id, next);
        return next;
      },
      setEnabled: (id, isEnabled) => {
        const prev = automations.get(id);
        if (!prev) return null;
        const next = { ...prev, isEnabled };
        automations.set(id, next);
        return next;
      },
      get: (id) => automations.get(id) ?? null,
      remove: (id) => automations.delete(id),
    },
    skills: {
      get: (id) => skills.get(id) ?? null,
      create: (spec) => {
        const rec = { id: 'my-skill', source: 'workflow', ...spec };
        skills.set(rec.id, rec);
        return rec;
      },
      update: (id, spec) => {
        const prev = skills.get(id);
        if (!prev) return null;
        const next = { ...prev, ...spec };
        skills.set(id, next);
        return next;
      },
      remove: (id) => skills.delete(id),
    },
  };
  const tm = {
    agentLifecycle: {
      updateAgent: async (_id, patch) => { profile = { ...profile, ...patch }; return profile; },
      setAgentAvatarBytes: async (_id, bytes) => { avatarBytes = bytes ? Buffer.from(bytes) : null; },
    },
    sessionStore: {
      getAgentAvatarPng: async () => avatarBytes,
    },
  };
  const memoryStore = {
    addMemory: (content, _ts, kind) => memories.push({ content, kind }),
    removeMemoryByContent: (content) => {
      const i = memories.findIndex((m) => m.content === content);
      if (i < 0) return false;
      memories.splice(i, 1);
      return true;
    },
  };
  const userMemory = {
    addMemory: (content, _ts, kind) => userMemories.push({ content, kind }),
    removeMemoryByContent: (content) => {
      const i = userMemories.findIndex((m) => m.content === content);
      if (i < 0) return false;
      userMemories.splice(i, 1);
      return true;
    },
  };

  const port = createLocalAgentStatePort({
    library: {},
    tm,
    session,
    agentId: 'agent-1',
    agentDir: dir,
    memoryStore,
    userMemory,
    automationsExt: { reconcileNow: async () => { reconciled += 1; } },
  });

  // Memory
  assert.equal((await port.writeMemory({ content: 'Prefers concise answers', tier: 'profile', scope: 'agent' })).ok, true);
  assert.equal((await port.writeMemory({ content: 'Lives in Singapore', tier: 'profile', scope: 'user' })).ok, true);
  assert.equal(memories.length, 1);
  assert.equal(userMemories.length, 1);
  assert.equal((await port.removeMemory({ content: 'Prefers concise answers', scope: 'agent' })).ok, true);
  assert.equal(memories.length, 0);

  // Routine lifecycle (uses FileAutomationStore.remove)
  assert.equal((await port.createAutomation({ spec: { name: 'Daily check', prompt: 'Check status' } })).ok, true);
  assert.equal((await port.updateAutomation({ id: 'routine-1', spec: { name: 'Daily check v2' } })).ok, true);
  assert.equal((await port.setAutomationEnabled({ id: 'routine-1', isEnabled: false })).ok, true);
  assert.equal(automations.get('routine-1').isEnabled, false);
  assert.equal((await port.deleteAutomation({ id: 'routine-1' })).ok, true);
  assert.equal(automations.size, 0);
  assert.equal(reconciled, 4);

  // Skill lifecycle (FileSkillStore uses source: 'workflow' and remove())
  const createdSkill = await port.writeSkill({ name: 'Release', description: 'How to release', body: 'Step 1' });
  assert.equal(createdSkill.ok, true);
  const updatedSkill = await port.writeSkill({ id: 'my-skill', name: 'Release v2', description: 'Updated', body: 'Step 1 & 2' });
  assert.equal(updatedSkill.ok, true);
  assert.equal(skills.size, 1);
  assert.equal(skills.get('my-skill').name, 'Release v2');
  assert.equal((await port.deleteSkill({ id: 'my-skill' })).ok, true);
  assert.equal(skills.size, 0);

  // Profile & Avatar
  assert.equal((await port.updateProfile({ name: 'Ops Bot', description: 'Handles ops' })).ok, true);
  assert.equal(profile.name, 'Ops Bot');
  const avatarSrc = join(dir, 'sample.png');
  writeFileSync(avatarSrc, TINY_PNG);
  assert.equal((await port.setAvatar({ path: avatarSrc })).ok, true);
  assert.equal(avatarBytes.length, TINY_PNG.length);
  const copied = await port.copyAvatar();
  assert.equal(copied.ok, true);
  assert.ok(existsSync(copied.path));
  assert.equal((await port.clearAvatar()).ok, true);
  assert.equal(avatarBytes, null);

  // applyLocalBotResourceRemoval uses remove()
  skills.set('rm-skill', { id: 'rm-skill', name: 'Disposable', source: 'workflow' });
  assert.equal(await applyLocalBotResourceRemoval({ dataDir: dir, session, tm, removal: { kind: 'bot-skill', id: 'rm-skill', name: 'Disposable' } }), true);
  assert.equal(skills.has('rm-skill'), false);
});

test('createLocalBotReferencePort persists links/docs and generates readable Reference skill', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-ref-port-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const port = createLocalBotReferencePort({ agentDir: dir, agentId: 'agent-1', library: {} });
  assert.equal(port.getReferenceSkill(), null);

  const linkRes = await port.addLink({
    link: { title: 'Runbook', url: 'https://example.com/runbook', oneLineNote: 'Incident steps' },
  });
  assert.equal(linkRes.kind, 'added');

  const docRes = await port.docs.add({
    doc: { title: 'Refund Policy', requestedFileName: 'refund-policy.md', source: { kind: 'text', text: '30 days' } },
  });
  assert.equal(docRes.kind, 'added');

  const refSkill = port.getReferenceSkill();
  assert.ok(refSkill);
  assert.equal(refSkill.id, 'reference');
  assert.match(refSkill.body, /https:\/\/example\.com\/runbook/);
  assert.match(refSkill.body, /refund-policy\.md/);
  assert.ok(existsSync(join(dir, 'reference', 'SKILL.md')));
  assert.equal(readFileSync(join(dir, 'reference-docs', 'refund-policy.md'), 'utf8'), '30 days');

  assert.equal((await port.remove({ url: 'https://example.com/runbook' })).kind, 'removed');
  assert.equal((await port.docs.remove({ fileName: 'refund-policy.md' })).kind, 'removed');
  assert.equal(port.getReferenceSkill(), null);
});

test('createLocalTrackedTasksPort and createLocalEffortToolPort persist locally', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-tasks-effort-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const tasksPort = createLocalTrackedTasksPort({ library: {}, agentDir: dir });
  assert.equal(tasksPort.tools.map((tool) => tool.name).join(','), 'ListTrackedTasks,CreateTrackedTasks,UpdateTrackedTasks,UpdateTrackedTaskTags');

  const runTool = async (name, args) => {
    const tool = tasksPort.tools.find((item) => item.name === name);
    const out = await tool.execute({}, null, (async function* () { yield JSON.stringify(args); })(), {});
    return (await tool.render({}, out)).content[0].text;
  };
  const createdText = await runTool('CreateTrackedTasks', { tasks: [{ title: 'Ship state tools', tags: ['host'] }] });
  assert.match(createdText, /T-1/);
  assert.match(await runTool('ListTrackedTasks', {}), /Ship state tools/);
  assert.match(await runTool('UpdateTrackedTasks', { updates: [{ key: 'T-1', status: 'done' }] }), /\[done\]/);
  assert.match(await runTool('UpdateTrackedTaskTags', { add: ['urgent'], remove: ['host'] }), /urgent/);
  assert.ok(existsSync(join(dir, 'tracked-tasks.json')));

  const kv = new Map();
  const effort = createLocalEffortToolPort({
    session: { db: { readKv: (k) => kv.get(k), writeKv: (k, v) => kv.set(k, v) } },
  });
  assert.equal(effort.level(), 'high');
  effort.choose('low');
  assert.equal(effort.level(), 'low');
  assert.equal(kv.get('rokbot.outputEffort'), 'low');
});

test('local Tracked Tasks tools emit McpToolResult payloads the harness renders as text', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-tasks-proto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Minimal stand-ins for the protobuf-es classes: unlike real messages they keep every
  // field, so the assertions below pin the exact message types and the field path that
  // the harness's renderMcpTool reads (result.case -> McpSuccess.content[].content.value.text).
  const proto = (typeName) => class { constructor(init = {}) { Object.assign(this, init); this.typeName = typeName; } };
  const tf = Object.fromEntries(['ToolCall', 'McpToolCall', 'McpArgs', 'McpToolResult', 'McpSuccess',
    'McpToolResultContentItem', 'McpTextContent', 'McpResult', 'McpToolError'].map((n) => [n, proto(n)]));
  const library = { getToolFrameworkRecoveryBindings: () => tf };
  const tasksPort = createLocalTrackedTasksPort({ library, agentDir: dir });

  const harnessText = (output) => {
    assert.equal(output.typeName, 'McpToolResult');
    assert.equal(output.result.case, 'success');
    assert.equal(output.result.value.typeName, 'McpSuccess');
    return output.result.value.content.map((item) => {
      assert.equal(item.typeName, 'McpToolResultContentItem');
      assert.equal(item.content.case, 'text');
      assert.equal(item.content.value.typeName, 'McpTextContent');
      return item.content.value.text;
    }).join('\n');
  };
  const runTool = async (name, args) => {
    const tool = tasksPort.tools.find((item) => item.name === name);
    const merged = [];
    const handler = {
      executeToolCall: async (_ctx, pending, callId, promiseFn, mergeFn) => {
        assert.equal(pending.tool.case, 'mcpToolCall');
        assert.equal(pending.tool.value.args.typeName, 'McpArgs');
        assert.equal(pending.tool.value.args.toolCallId, callId);
        const result = await promiseFn({});
        merged.push(mergeFn(result));
        return result;
      },
    };
    const out = await tool.execute({}, handler, (async function* () { yield JSON.stringify(args); })(), { toolCallId: `call-${name}` });
    const text = harnessText(out);
    assert.equal(merged[0].tool.value.result, out, 'client-visible McpToolCall.result must be the McpToolResult');
    const rendered = await tool.render({}, out);
    assert.equal(rendered.content[0].text, text);
    assert.ok(text.length > 0, `${name} returned an empty result`);
    return text;
  };

  assert.match(await runTool('CreateTrackedTasks', { tasks: [{ title: 'Proto check', tags: ['host'] }] }), /Created 1 task\(s\):\n- T-1 \(v1\) \[queued\] \[host\]: Proto check/);
  assert.match(await runTool('ListTrackedTasks', {}), /T-1 \(v1\) \[queued\] \[host\]: Proto check/);
  assert.match(await runTool('UpdateTrackedTasks', { updates: [{ key: 'T-1', status: 'done' }] }), /T-1 \(v2\) \[done\]/);
  assert.match(await runTool('UpdateTrackedTaskTags', { add: ['urgent'] }), /urgent/);
});

test('sanitizeSelfHostedPromptText removes unoffered cloud tools and missing managed skills', () => {
  const sample = [
    'Skills, profile and settings, picture, and channels have their own tools in the cursor namespace: UpdateSkill, UpdateProfile, UpdateAvatar, DisconnectChannel.',
    'Create a routine instead of doing it once, except joining a meeting or saving what to do in one (JoinMeeting or UpdateMeeting). Read the Cursor-managed `routines` skill before creating or changing one; it has the full recipe, including every trigger shape.',
    'Stops every running child, and cancels every cloud agent you launched.',
    'Spawn local and cloud subagents natively.',
    'At a sign-in, a one-time code, or a card field it stops and reports the exact current URL, and you continue with the `sign-in` skill, then dispatch it again.',
  ].join('\n');
  const cleaned = sanitizeSelfHostedPromptText(sample, {
    offeredTools: new Set(['UpdateMemory', 'UpdateRoutine']),
    installedSkillIds: new Set(),
  });
  assert.ok(!cleaned.includes('DisconnectChannel'), cleaned);
  assert.ok(!cleaned.includes('JoinMeeting'), cleaned);
  assert.ok(!cleaned.includes('UpdateMeeting'), cleaned);
  assert.ok(!cleaned.includes('Cursor-managed `routines` skill'), cleaned);
  assert.ok(!cleaned.includes('cancels every cloud agent'), cleaned);
  assert.ok(!cleaned.includes('`sign-in` skill'), cleaned);
  assert.ok(cleaned.includes('RequestUserForm or request_box_help'), cleaned);
  assert.equal(createLocalRunnerGates({}).botReference(), true);
  assert.equal(createLocalRunnerGates({}).tasks(), false);
});

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;
const configuredArchive = process.env.ROKBOT_TEST_HOST_ARCHIVE || process.env.PROKBOT_TEST_HOST_ARCHIVE;

async function materializeSeed(stateDir) {
  let seedDir = configuredSeed;
  if (!seedDir) {
    const matOut = join(stateDir, 'materialized');
    const res = spawnSync(
      process.platform === 'win32' ? 'python' : 'python3',
      [join(HOST_DIR, 'release/patch-host.py'), '--archive', configuredArchive, '--output', matOut],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.ifError(res.error);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    seedDir = join(matOut, 'seed');
  }
  const workSeed = join(stateDir, 'seed');
  await cp(seedDir, workSeed, { recursive: true });
  const reliableDir = join(workSeed, 'reliable-core', 'v1');
  await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
  await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
  await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));
  return { workSeed, reliableDir };
}

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)));
}

function closeServer(server) {
  return new Promise((done) => { server.closeAllConnections?.(); server.close(done); });
}

function writeSseToolCalls(res, toolCalls) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  toolCalls.forEach((tc, index) => {
    res.write(`data: ${JSON.stringify({
      id: `tc-${index}`,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta: {
          ...(index === 0 ? { role: 'assistant' } : {}),
          tool_calls: [{
            index,
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }],
        },
        finish_reason: null,
      }],
    })}\n\n`);
  });
  res.write(`data: ${JSON.stringify({ id: 'tc-end', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeSseText(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function extractToolSurface(body) {
  const nativeTools = (body.tools ?? []).map((tool) => (tool.function ?? tool).name);
  const allText = (body.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const ns = allText.match(/<namespace name="cursor" tools="([^"]*)"/);
  const cursorTools = ns ? ns[1].split(',').map((name) => name.trim()).filter(Boolean) : [];
  return {
    nativeTools,
    cursorTools,
    allTools: [...new Set([...nativeTools, ...cursorTools])],
    allText,
    toolDescriptions: JSON.stringify(body.tools ?? []),
  };
}

if (configuredSeed || configuredArchive) {
  test('real 2bb5e41 host exposes all self-hosted state/admin/recall/effort tools, persists writes, and fires a scheduled routine end-to-end', async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'rokbot-state-tools-e2e-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const { workSeed, reliableDir } = await materializeSeed(stateDir);

    const tokenFile = join(stateDir, 'internal-host-token');
    await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

    const avatarPath = join(stateDir, 'bot-avatar.png');
    await writeFile(avatarPath, TINY_PNG);

    const requests = [];
    let callStep = 0;
    let routineTriggeredPrompt = null;
    let resolveRoutineFired;
    const routineFired = new Promise((done) => { resolveRoutineFired = done; });

    const modelServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const joined = JSON.stringify(body.messages ?? []);
        if (joined.includes('Auto-review security classifier')) {
          const toolName = body.tools?.[0]?.function?.name ?? 'classify_sand_auto_review_action';
          const props = body.tools?.[0]?.function?.parameters?.properties ?? {};
          const required = body.tools?.[0]?.function?.parameters?.required ?? [];
          const args = { decision: 'ALLOW', blocked_effect: 'none', reason: 'allowed in test' };
          for (const key of required) {
            if (!(key in args)) {
              const def = props[key];
              args[key] = Array.isArray(def?.enum) ? def.enum[0] : 'none';
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'review-1',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                tool_calls: [{
                  id: 'review-call-1',
                  type: 'function',
                  function: { name: toolName, arguments: JSON.stringify(args) },
                }],
              },
            }],
          }));
          return;
        }
        requests.push(body);
        if (process.env.ROKBOT_TEST_DEBUG === '1') {
          console.error('[E2E REQ #' + requests.length + ']', JSON.stringify(body.messages.slice(-4)).slice(0, 1200));
        }

        if (joined.includes('[automation:') && joined.includes('PING_ROUTINE_E2E')) {
          routineTriggeredPrompt = joined;
          resolveRoutineFired(true);
          writeSseText(res, 'routine-ran-ok');
          return;
        }

        callStep += 1;
        if (callStep === 1) {
          // Exercise UpdateMemory (agent + shared), UpdateRoutine (create), UpdateSkill, UpdateProfile, UpdateAvatar, CreateTrackedTasks
          writeSseToolCalls(res, [
            {
              id: 'call-mem-agent',
              name: 'UpdateMemory',
              arguments: { action: 'write', type: 'profile', fact: 'User prefers metric units.' },
            },
            {
              id: 'call-mem-user',
              name: 'UpdateMemory',
              arguments: { action: 'write', type: 'shared_profile', fact: 'User lives in Singapore.' },
            },
            {
              id: 'call-routine-create',
              name: 'UpdateRoutine',
              arguments: {
                action: 'create',
                name: 'E2E Ping Routine',
                prompt: 'PING_ROUTINE_E2E report status',
                schedule: '*/5 * * * *',
              },
            },
            {
              id: 'call-task-create',
              name: 'CreateTrackedTasks',
              arguments: { tasks: [{ title: 'Verify state tools E2E', tags: ['e2e'] }] },
            },
            {
              id: 'call-skill-write',
              name: 'CallDynamicTool',
              arguments: {
                namespace: 'cursor',
                toolName: 'UpdateSkill',
                arguments: {
                  action: 'write',
                  name: 'E2E Deploy Guide',
                  description: 'Steps to run an E2E check',
                  body: '1. Verify tools.\n2. Verify routines.',
                },
              },
            },
            {
              id: 'call-profile-set',
              name: 'CallDynamicTool',
              arguments: {
                namespace: 'cursor',
                toolName: 'UpdateProfile',
                arguments: { name: 'StateTools Bot', description: 'Verified self-hosted bot' },
              },
            },
            {
              id: 'call-avatar-set',
              name: 'CallDynamicTool',
              arguments: {
                namespace: 'cursor',
                toolName: 'UpdateAvatar',
                arguments: { action: 'set', path: avatarPath },
              },
            },
            {
              id: 'call-ref-add',
              name: 'CallDynamicTool',
              arguments: {
                namespace: 'cursor',
                toolName: 'UpdateReference',
                arguments: { action: 'add', title: 'Status Page', url: 'https://status.example.com', one_line_note: 'Health dashboard' },
              },
            },
          ]);
          return;
        }
        if (callStep === 2) {
          // Exercise the remaining Tracked Tasks tools so their model-visible results can be asserted.
          writeSseToolCalls(res, [
            // These calls may run concurrently, so list closed tasks too and accept either version.
            { id: 'call-task-list', name: 'ListTrackedTasks', arguments: { include_closed: true } },
            {
              id: 'call-task-update',
              name: 'UpdateTrackedTasks',
              arguments: { updates: [{ key: 'T-1', status: 'done', notes: 'checked' }] },
            },
            {
              id: 'call-task-tags',
              name: 'CallDynamicTool',
              arguments: { namespace: 'cursor', toolName: 'UpdateTrackedTaskTags', arguments: { add: ['urgent'] } },
            },
          ]);
          return;
        }
        if (callStep === 3) {
          writeSseToolCalls(res, [
            {
              id: 'call-send',
              name: 'SendToUser',
              arguments: { type: 'text', content: 'All state tools updated.', end_turn: true },
            },
          ]);
          return;
        }
        writeSseText(res, 'done');
        return;
      }
      if (req.url === '/internal/connectors/runtime') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ revision: 0, config: { mcpServers: {} }, display: { servers: [] } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('null');
    });
    const modelBase = await listen(modelServer);
    t.after(() => closeServer(modelServer));

    const execServer = createServer(async (req, res) => {
      for await (const _ of req) {}
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/connect+proto')) {
        res.writeHead(200, { 'content-type': 'application/connect+proto' });
        res.end(Buffer.from([2, 0, 0, 0, 2, 0x7b, 0x7d]));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
    const execBase = await listen(execServer);
    t.after(() => closeServer(execServer));

    const envOverrides = {
      ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'),
      ROKBOT_STATE_DIR: stateDir,
      ROKBOT_DATA_DIR: stateDir,
      ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile,
      ROKBOT_NOTIFICATION_URL: modelBase,
      ROKBOT_CONNECTORS_URL: `${modelBase}/internal/connectors`,
      ROKBOT_SHARING_URL: `${modelBase}/internal/sharing`,
      ROKBOT_EXECUTION_URL: execBase,
      ROKBOT_BOX_TOKEN: 'test-box-token',
      SAND_DATA_ROOT: join(stateDir, 'host-data'),
      SAND_BACKEND_URL: 'http://127.0.0.1:9',
      SAND_DISABLE_TELEMETRY: '1',
      SAND_DISABLE_ANALYTICS: '1',
      SAND_HOST_IN_BOX: '1',
      SAND_PACKAGED: '1',
      SAND_BOX_MAX_WINDOWS: '1',
    };
    const prevEnv = new Map();
    for (const [k, v] of Object.entries(envOverrides)) {
      prevEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    const restoreEnv = () => {
      for (const [k, v] of prevEnv.entries()) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };

    const require = createRequire(import.meta.url);
    const library = require(join(workSeed, 'host-library-reliable.cjs'));
    let host;
    let schedulerCleanup;
    try {
      await loadRecoveredHostCore(library, reliableDir);
      const modelConfig = {
        apiFormat: 'openai',
        baseUrl: `${modelBase}/v1`,
        apiKey: 'test-key',
        model: 'gpt-4o-mini',
        policy: defaultPolicy('gpt-4o-mini'),
        usageDirectory: join(stateDir, 'usage'),
        routingDirectory: join(stateDir, 'routing'),
      };
      host = new library.SandHost({
        environment: library.readSandHostEnvironment(process.env),
        startExtensions: createExtensionStarter(library, modelConfig),
      });
      await host.start();
      const api = host.getApi();
      const created = await api.createAgent({ name: 'Initial Bot', description: 'Before state updates' });
      const agentId = created.agent.id;
      await api.openAgent({ id: agentId });
      await api.sendPrompt({ agentId, prompt: 'Run all state tool checks', clientNonce: 'state-e2e-1' });
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);

      // 1. Assert full tool surface and sanitized prompt/descriptions on first model request
      assert.ok(requests.length >= 2, `Expected tool execution round-trip, got ${requests.length} requests`);
      const surface = extractToolSurface(requests[0]);
      for (const toolName of EXPECTED_SELF_HOSTED_TOOLS) {
        assert.ok(surface.allTools.includes(toolName), `Expected tool ${toolName} to be offered; got: ${surface.allTools.join(', ')}`);
      }
      for (const hidden of EXPECTED_HIDDEN_CLOUD_TOOLS) {
        assert.ok(!surface.allTools.includes(hidden), `Cloud-only tool ${hidden} must stay hidden`);
      }
      const combinedPromptAndTools = `${surface.allText}\n${surface.toolDescriptions}`;
      for (const forbidden of ['DisconnectChannel', 'JoinMeeting', 'UpdateMeeting']) {
        assert.ok(!combinedPromptAndTools.includes(forbidden), `Unoffered tool ${forbidden} must not be advertised in prompt or tool descriptions`);
      }

      // 1b. Every local Tracked Tasks tool must hand its text result back to the model
      // (regression: the McpToolResult payload used to serialize to an empty body).
      assert.ok(requests.length >= 3, `Expected tracked-task round-trips, got ${requests.length} requests`);
      const toolMessage = (request, id) => {
        const msg = (request.messages ?? []).find((m) => m.role === 'tool' && m.tool_call_id === id);
        assert.ok(msg, `Missing tool result message for ${id}`);
        return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      };
      assert.match(toolMessage(requests[1], 'call-task-create'), /Created 1 task\(s\):\n- T-1 \(v1\) \[queued\] \[e2e\]: Verify state tools E2E/);
      assert.match(toolMessage(requests[1], 'call-mem-agent'), /Saved to memory/);
      assert.match(toolMessage(requests[2], 'call-task-list'), /T-1 \(v[12]\) \[(queued|done)\] \[e2e[^\]]*\]: Verify state tools E2E/);
      assert.match(toolMessage(requests[2], 'call-task-update'), /T-1 \(v2\) \[done\]/);
      assert.match(toolMessage(requests[2], 'call-task-tags'), /urgent/);

      // 2. Assert every state write persisted to the host data directory
      const sandRoot = join(stateDir, 'host-data');
      const agentDir = join(sandRoot, 'agents', agentId);
      const agentMemProfile = await readFile(join(agentDir, 'memory', 'profile.md'), 'utf8');
      assert.match(agentMemProfile, /User prefers metric units\./);
      const sharedMemProfile = await readFile(join(sandRoot, 'user-memory', 'profile.md'), 'utf8');
      assert.match(sharedMemProfile, /User lives in Singapore\./);

      const trackedTasks = JSON.parse(await readFile(join(agentDir, 'tracked-tasks.json'), 'utf8'));
      assert.equal(trackedTasks.tasks.length, 1);
      assert.equal(trackedTasks.tasks[0].title, 'Verify state tools E2E');
      assert.equal(trackedTasks.tasks[0].status, 'done');
      assert.ok(trackedTasks.tags.includes('urgent'));

      const refData = JSON.parse(await readFile(join(agentDir, 'reference.json'), 'utf8'));
      assert.equal(refData.links.length, 1);
      assert.equal(refData.links[0].url, 'https://status.example.com');
      assert.match(await readFile(join(agentDir, 'reference', 'SKILL.md'), 'utf8'), /status\.example\.com/);

      const agents = await api.listAgents();
      const updatedAgent = agents.find((a) => a.id === agentId);
      assert.equal(updatedAgent.name, 'StateTools Bot');
      assert.equal(updatedAgent.description, 'Verified self-hosted bot');
      const avatarPng = await host.transcript.sessionStore.getAgentAvatarPng(agentId);
      assert.ok(avatarPng && avatarPng.length > 0, 'Avatar bytes must be persisted in host storage');

      const session = host.transcript.sessions.activeSession;
      const savedSkills = session.skills.list().filter((s) => s.name === 'E2E Deploy Guide');
      assert.equal(savedSkills.length, 1, 'UpdateSkill must persist the new skill');
      assert.ok(existsSync(savedSkills[0].filePath), 'Saved skill SKILL.md must exist on disk');

      // 3. End-to-end routine scheduling & firing test via decorateLocalHostAutomations
      const automations = session.automations.list();
      assert.equal(automations.length, 1, 'UpdateRoutine must persist the routine');
      const routine = automations[0];
      assert.equal(routine.name, 'E2E Ping Routine');
      assert.ok(routine.filePath && existsSync(routine.filePath), `Routine config file must exist on disk: ${routine.filePath}`);

      // Drive the real local cron scheduler with a deterministic clock 6 minutes past creation
      // so the */5 * * * * routine becomes due immediately and fires a real background turn.
      const futureNow = routine.createdAt + 6 * 60 * 1000;
      const onStopFns = [];
      const schedulerStateDir = join(stateDir, 'scheduler-e2e');
      mkdirSync(schedulerStateDir, { recursive: true });
      const scheduler = await decorateLocalHostAutomations(
        {
          deps: {
            transcript: host.transcript,
            auth: { peekAccessToken: () => null },
            'turn-execution': { isRunReady: async () => true },
            settings: { getUserTimeZone: () => 'UTC' },
          },
          host: {
            log: (msg) => { if (process.env.ROKBOT_TEST_DEBUG === '1') console.error('[SCHED]', msg); },
            events: { on: () => () => {} },
          },
          onStop: (fn) => onStopFns.push(fn),
        },
        library,
        {
          suspendWakes: async () => {},
          resumeWakes: () => {},
          reconcileNow: async () => {},
        },
        {
          stateDirectory: schedulerStateDir,
          clock: {
            now: () => futureNow,
            setTimeout: () => 0,
            clearTimeout: () => {},
          },
        },
      );
      schedulerCleanup = () => { for (const fn of onStopFns) fn(); };
      await scheduler.reconcileNow();
      if (process.env.ROKBOT_TEST_DEBUG === '1') {
        console.error('[SCHED STATUS]', readFileSync(join(schedulerStateDir, 'local-automations-status.json'), 'utf8'));
        console.error('[SCHED CLAIMS]', existsSync(join(schedulerStateDir, 'local-automation-claims.json')) ? readFileSync(join(schedulerStateDir, 'local-automation-claims.json'), 'utf8') : 'none');
      }

      const fired = await Promise.race([
        routineFired,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for scheduled routine to fire')), 10_000)),
      ]);
      assert.equal(fired, true);
      assert.ok(routineTriggeredPrompt?.includes('PING_ROUTINE_E2E'), 'Scheduled routine must run its saved prompt');
      await host.transcript.runLifecycle.drainExclusiveRuns(agentId);

      const runs = session.automations.readRuns(routine.id);
      assert.ok(runs.length >= 1, 'Routine execution must be recorded in runs.json');
      assert.equal(runs[0].status, 'ok');

      // Verify deletion removes the routine cleanly from disk
      assert.equal(session.automations.remove(routine.id), true);
      assert.equal(session.automations.list().length, 0);
      assert.equal(existsSync(routine.filePath), false);
    } finally {
      schedulerCleanup?.();
      await host?.dispose();
      restoreEnv();
    }
  });
}

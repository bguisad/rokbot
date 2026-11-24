import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAgentMessageSender,
  createRunnerForSession,
  installLocalHarnessBridge,
  preserveGatewayReplyFields,
  resolveSendReplyContext,
} from '../runtime/local-harness-bridge.mjs';

const ROKBOT = '487ddb8b-a062-4bc0-b9b6-814f301db95f';
const IKUN = 'b530eb46-a456-4279-9504-5407fd0f3c8c';
const PEER = `peer:${'a'.repeat(64)}:remote-bot`;

class FakeDb {
  constructor(entries = []) { this.entries = [...entries]; }
  getTranscriptEntries() { return [...this.entries]; }
  getTranscriptEntryIds() { return new Set(this.entries.map(e => e.id)); }
  appendTranscriptEntry(e) { this.entries.push(e); }
  updateTranscriptEntry(id, fn) { this.entries = this.entries.map(e => (e.id === id ? fn(e) : e)); }
  writeKv() {}
}

function bridgeHarness(entries) {
  class MockSendPipeline {}
  const runnerCalls = [];
  const fakeLibrary = {
    getHostFlowRecoveryBindings: () => ({ SendPipeline: MockSendPipeline }),
    getHostExecutionRecoveryBindings: () => ({}),
    getHostSessionRecoveryBindings: () => ({}),
    getHostKernelRecoveryBindings: () => ({}),
    getPromptToolsRecoveryBindings: () => ({}),
  };
  installLocalHarnessBridge(fakeLibrary, {});
  const db = new FakeDb(entries);
  const runner = {
    run: async (prompt, options) => {
      runnerCalls.push({ prompt, options });
      return { aborted: false, sentMessageCount: 1, text: '' };
    },
  };
  const sp = new MockSendPipeline();
  sp.nextTurnEpoch = () => 1;
  sp.tm = {
    sessions: {
      ensureActionTarget: async () => {},
      isAgentGone: () => false,
      isServerHostedAgent: () => false,
      resolveBackgroundSession: async (id) => ({ id, db }),
    },
    sessionStore: { markSessionActivity() {} },
    roster: { emit() {}, emitAgentUpdate: async () => {} },
    ensureRunnerRegistry: () => ({ getRunner: () => runner }),
  };
  // Mirrors the deployed 2bb5e41 gateway: it forwards a whitelist that omits replyToId/replyQuote.
  const gateway = {
    sendPrompt: async (args) => {
      await sp.sendPrompt(args.prompt, {
        agentId: args.agentId,
        directAddressedAcceptance: args.directAddressedAcceptance,
        attachmentPaths: args.attachmentPaths ?? [],
        ...(args.richText === undefined ? {} : { richText: args.richText }),
        ...(args.clientNonce === undefined ? {} : { clientNonce: args.clientNonce }),
        awaitTurn: true,
      });
      return { accepted: true };
    },
    other: () => 'kept',
  };
  return { sp, db, runnerCalls, gateway };
}

test('replies sent through the gateway keep replyTo in the transcript and reach the agent as reply context', async () => {
  const { db, runnerCalls, gateway } = bridgeHarness([
    { kind: 'message', id: 't0u', role: 'user', content: 'hello', timestampMs: 1 },
    { kind: 'send-message', id: 't0s0', message: { type: 'text', content: '部署完成，版本 1.2.3' }, timestampMs: 2 },
  ]);
  const api = preserveGatewayReplyFields(gateway);
  assert.equal(api.other(), 'kept');

  // Mobile sends both the target id and the quoted text.
  await api.sendPrompt({ agentId: ROKBOT, prompt: '这个版本号对吗？', clientNonce: 'n-reply-1',
    replyToId: 't0s0', replyQuote: '部署完成，版本 1.2.3' });
  const first = db.entries.find(e => e.kind === 'message' && e.clientNonce === 'n-reply-1');
  assert.equal(first.replyTo, 't0s0', 'replyTo must survive a transcript resync');
  assert.equal(first.content, '这个版本号对吗？');
  assert.deepEqual(runnerCalls[0].options.replyContext, { targetId: 't0s0', quote: '部署完成，版本 1.2.3' });
  assert.equal(runnerCalls[0].prompt, '这个版本号对吗？');

  // Without replyQuote the quote is recovered from the replied-to transcript entry.
  await api.sendPrompt({ agentId: ROKBOT, prompt: '再说一遍', clientNonce: 'n-reply-2', replyToId: 't0u' });
  assert.equal(db.entries.find(e => e.clientNonce === 'n-reply-2').replyTo, 't0u');
  assert.deepEqual(runnerCalls[1].options.replyContext, { targetId: 't0u', quote: 'hello' });

  // Plain sends carry no reply fields.
  await api.sendPrompt({ agentId: ROKBOT, prompt: 'plain', clientNonce: 'n-plain' });
  assert.equal('replyTo' in db.entries.find(e => e.clientNonce === 'n-plain'), false);
  assert.equal(runnerCalls[2].options.replyContext, undefined);
});

test('gateway reply fields do not leak into a different send made inside the same call', async () => {
  const { sp, db, runnerCalls } = bridgeHarness([
    { kind: 'send-message', id: 't0s0', message: { type: 'text', content: 'quoted' }, timestampMs: 1 },
  ]);
  const api = preserveGatewayReplyFields({
    sendPrompt: async (args) => {
      await sp.sendPrompt(args.prompt, { agentId: args.agentId, clientNonce: args.clientNonce });
      await sp.sendPrompt('@skill', { agentId: args.agentId });
    },
  });
  await api.sendPrompt({ agentId: ROKBOT, prompt: 'answer', clientNonce: 'n-1', replyToId: 't0s0' });
  assert.equal(db.entries.find(e => e.content === 'answer').replyTo, 't0s0');
  assert.equal('replyTo' in db.entries.find(e => e.content === '@skill'), false);
  assert.equal(runnerCalls[1].options.replyContext, undefined);
});

test('resolveSendReplyContext validates ids and bounds quotes', () => {
  assert.deepEqual(resolveSendReplyContext({}), {});
  assert.deepEqual(resolveSendReplyContext({ replyToId: '   ' }), {});
  assert.deepEqual(resolveSendReplyContext({ replyToId: 'x'.repeat(257) }), {});
  assert.deepEqual(resolveSendReplyContext({ replyToId: 't9s9' }, []), { replyToId: 't9s9' });
  const long = resolveSendReplyContext({ replyToId: 't1s0', replyQuote: 'q'.repeat(5000) });
  assert.equal(long.replyContext.quote.length, 2000);
  assert.equal(long.replyContext.quote.endsWith('…'), true);
  assert.deepEqual(resolveSendReplyContext({ replyToId: ' t1s0 ', replyQuote: '  ' },
    [{ kind: 'send-message', id: 't1s0', message: { type: 'text', content: ' from entry ' } }]),
  { replyToId: 't1s0', replyContext: { targetId: 't1s0', quote: 'from entry' } });
});

function agentMessagingHarness() {
  const inbound = [], outbound = [], wakes = [], queued = [], remote = [];
  const tm = {
    roster: {
      listAgentsSync: () => [
        { id: ROKBOT, name: 'rokbot' },
        { id: IKUN, name: 'ikun 总管' },
        { id: 'group-1', name: 'room', isGroup: true },
      ],
    },
    sessions: { isAgentGone: () => false, isServerHostedAgent: () => false },
    backgroundWakes: {
      agentToAgent: {
        receiveFromPeer: async (args) => { inbound.push(args); return 'delivered'; },
        runAgentInboundWake: async (agentId, messages) => { wakes.push({ agentId, messages }); },
      },
      appendAgentOutboundEntry: (...args) => outbound.push(args),
    },
    runLifecycle: {
      enqueueExclusiveRun: async (agentId, task, opts) => { queued.push({ agentId, opts }); return task(); },
    },
  };
  const federation = {
    sendToRemoteAgent: async (args) => {
      remote.push(args);
      return { delivered: true, target: { id: args.toAgentId }, ack: 'Queued for remote-bot.' };
    },
  };
  return { tm, federation, inbound, outbound, wakes, queued, remote };
}

test('SendToAgent delivers to a local teammate instead of the federation service', async () => {
  const h = agentMessagingHarness();
  const send = createAgentMessageSender({ tm: h.tm, fromAgentId: ROKBOT, federation: h.federation });
  const ack = await send(IKUN, '把这个 bug 告诉 cc', undefined, false, { toolCallId: 'call-1' });
  await new Promise(resolve => setImmediate(resolve));

  assert.match(ack, /^Delivered to ikun 总管/);
  assert.doesNotMatch(ack, /Invalid remote Bot address|not accepted/);
  assert.equal(h.remote.length, 0, 'a local teammate must never be routed to federation');
  assert.equal(h.inbound.length, 1);
  assert.deepEqual(h.inbound[0].from, { id: ROKBOT, name: 'rokbot' });
  assert.equal(h.inbound[0].toAgentId, IKUN);
  assert.equal(h.inbound[0].text, '把这个 bug 告诉 cc');
  assert.equal(h.outbound.length, 1);
  assert.deepEqual(h.outbound[0].slice(0, 3), [ROKBOT, { id: IKUN, name: 'ikun 总管' }, '把这个 bug 告诉 cc']);
  assert.deepEqual(h.queued.map(q => [q.agentId, q.opts.lane]), [[IKUN, 'background']]);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0].agentId, IKUN);
  assert.equal(h.wakes[0].messages[0].text, '把这个 bug 告诉 cc');
});

test('SendToAgent sends peer addresses to federation with the expected argument object', async () => {
  const h = agentMessagingHarness();
  const send = createAgentMessageSender({ tm: h.tm, fromAgentId: ROKBOT, federation: h.federation });
  assert.equal(await send(PEER, 'hello remote', undefined, false), 'Queued for remote-bot.');
  assert.deepEqual(h.remote, [{ fromAgentId: ROKBOT, toAgentId: PEER, text: 'hello remote' }]);
  assert.equal(h.inbound.length, 0);

  const noFederation = createAgentMessageSender({ tm: h.tm, fromAgentId: ROKBOT });
  assert.match(await noFederation(PEER, 'hi'), /no remote Hosts are paired/);
});

test('SendToAgent rejects unknown, group, and server-hosted targets without touching federation', async () => {
  const h = agentMessagingHarness();
  const send = createAgentMessageSender({ tm: h.tm, fromAgentId: ROKBOT, federation: h.federation });
  assert.match(await send('00000000-0000-0000-0000-000000000000', 'hi'), /No teammate with id/);
  assert.match(await send('group-1', 'hi'), /No teammate with id/);
  h.tm.sessions.isServerHostedAgent = id => id === IKUN;
  assert.match(await send(IKUN, 'hi'), /hosted on the server/);
  assert.equal(h.remote.length + h.inbound.length, 0);
});

test('the runner gets a positional sendToAgent wired to local delivery', async () => {
  const h = agentMessagingHarness();
  let runnerOptions;
  const library = {
    SandAgentRunner: class { constructor(options) { runnerOptions = options; } },
    getPromptToolsRecoveryBindings: () => ({}),
    getHostFlowRecoveryBindings: () => ({}),
    ConversationStateStructure: class {},
  };
  const tm = { ...h.tm, sessionStore: { getAgentDir: () => '' } };
  createRunnerForSession(library, tm, { id: ROKBOT, db: new FakeDb() }, {
    extensions: id => ({
      'remote-agent-messaging': { ...h.federation, directory: () => [] },
      memory: { createAgentStore: () => ({}) },
    })[id],
  });
  assert.equal(typeof runnerOptions.sendToAgent, 'function');
  assert.deepEqual(runnerOptions.agentDirectory().map(agent => agent.id), [IKUN]);
  const ack = await runnerOptions.sendToAgent(IKUN, 'ping', undefined, false, { toolCallId: 'c' });
  assert.match(ack, /^Delivered to ikun 总管/);
  assert.equal(h.remote.length, 0);
});

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED || process.env.PROKBOT_TEST_HOST_SEED;

if (configuredSeed) {
  test('real 2bb5e41 Host threads replies into the model prompt and delivers SendToAgent to a local teammate', async t => {
    const { createServer } = await import('node:http');
    const { createRequire } = await import('node:module');
    const { cp, mkdtemp, realpath, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const { createExtensionStarter } = await import('../runtime/host-extensions.mjs');
    const { defaultPolicy } = await import('../runtime/model-policy.mjs');
    const { loadRecoveredHostCore } = await import('../runtime/recovered-host-core.mjs');
    const HOST_DIR = resolve(import.meta.dirname, '..');

    const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'rokbot-2bb5e41-reply-')));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    const workSeed = join(stateDir, 'seed');
    await cp(configuredSeed, workSeed, { recursive: true });
    const reliableDir = join(workSeed, 'reliable-core', 'v1');
    await cp(join(workSeed, 'release-reliability'), reliableDir, { recursive: true });
    await cp(join(workSeed, 'release-reliability/host-library-reliable.cjs'), join(workSeed, 'host-library-reliable.cjs'));
    await cp(join(workSeed, 'release-reliability/sand-eval-library-reliable.cjs'), join(workSeed, 'sand-eval-library-reliable.cjs'));

    let peerAgentId;
    const userTexts = [];
    const textOf = message => (Array.isArray(message?.content)
      ? message.content.filter(p => p?.type === 'text').map(p => p.text).join('\n')
      : String(message?.content ?? ''));
    const sse = (res, delta, finish) => res.write(`data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const llm = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(req.url?.startsWith('/internal/') ? 200 : 404, { 'content-type': 'application/json' });
        res.end('null');
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const messages = Array.isArray(body.messages) ? body.messages : [];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const system = messages.filter(m => m?.role === 'system').map(textOf).join('\n');
      const lastUser = [...messages].reverse().find(m => m?.role === 'user');
      const answered = messages.slice(messages.lastIndexOf(lastUser) + 1).some(m => m?.role === 'tool');
      if (system.includes('GROK_BOT_MEMORY_EXTRACTION') || answered) {
        sse(res, { role: 'assistant', content: 'Done.' }, 'stop');
        res.end('data: [DONE]\n\n');
        return;
      }
      const text = textOf(lastUser);
      userTexts.push(text);
      const call = text.includes('A2A_PING')
        ? { name: 'SendToAgent', arguments: JSON.stringify({ target_id: peerAgentId, message: 'hello teammate', priority: false }) }
        : { name: 'SendToUser', arguments: JSON.stringify({ type: 'text', content: `ack:${userTexts.length}` }) };
      sse(res, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${userTexts.length}`, type: 'function', function: call }] }, null);
      sse(res, {}, 'tool_calls');
      res.end('data: [DONE]\n\n');
    });
    await new Promise(r => llm.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => { llm.closeAllConnections?.(); llm.close(r); }));
    const base = `http://127.0.0.1:${llm.address().port}`;
    const exec = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise(r => exec.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => { exec.closeAllConnections?.(); exec.close(r); }));
    const tokenFile = join(stateDir, 'internal-host-token');
    await writeFile(tokenFile, '0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

    const env = {
      ROKBOT_RUNTIME_DIR: join(HOST_DIR, 'runtime'), ROKBOT_STATE_DIR: stateDir, ROKBOT_DATA_DIR: stateDir,
      ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile, ROKBOT_INTERNAL_HOST_URL: base, ROKBOT_NOTIFICATION_URL: base,
      ROKBOT_CONNECTORS_URL: `${base}/internal/connectors`, ROKBOT_SHARING_URL: `${base}/internal/sharing`,
      ROKBOT_EXECUTION_URL: `http://127.0.0.1:${exec.address().port}`, ROKBOT_BOX_TOKEN: 'test-box-token',
      SAND_DATA_ROOT: join(stateDir, 'host-data'), SAND_BACKEND_URL: 'http://127.0.0.1:9',
      SAND_DISABLE_TELEMETRY: '1', SAND_DISABLE_ANALYTICS: '1', SAND_HOST_IN_BOX: '1', SAND_PACKAGED: '1', SAND_BOX_MAX_WINDOWS: '1',
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });

    const library = createRequire(import.meta.url)(join(workSeed, 'host-library-reliable.cjs'));
    await loadRecoveredHostCore(library, reliableDir);
    const host = new library.SandHost({
      environment: library.readSandHostEnvironment(process.env),
      startExtensions: createExtensionStarter(library, {
        apiFormat: 'openai', baseUrl: `${base}/v1`, apiKey: 'test-key', model: 'gpt-4o-mini',
        policy: defaultPolicy('gpt-4o-mini'), usageDirectory: join(stateDir, 'usage'), routingDirectory: join(stateDir, 'routing'),
      }),
    });
    try {
      await host.start();
      const api = preserveGatewayReplyFields(host.getApi());
      const sender = (await api.createAgent({ name: 'rokbot', description: 'sender' })).agent.id;
      peerAgentId = (await api.createAgent({ name: 'ikun 总管', description: 'teammate' })).agent.id;
      await api.openAgent({ id: sender });

      await api.sendPrompt({ agentId: sender, prompt: 'first', clientNonce: 'first-1' });
      await host.transcript.runLifecycle.drainExclusiveRuns(sender);
      const quoted = (await api.getAgentTranscript({ id: sender })).find(e => e.kind === 'send-message' && e.message?.content === 'ack:1');
      assert.ok(quoted, 'the bot reply to quote must exist');

      await api.sendPrompt({ agentId: sender, prompt: 'REPLY_BODY', clientNonce: 'reply-2', replyToId: quoted.id, replyQuote: 'ack:1' });
      await host.transcript.runLifecycle.drainExclusiveRuns(sender);
      assert.match(userTexts.at(-1), new RegExp(`\\[In reply to ${quoted.id}: "ack:1"\\]`));
      const replyEntry = (await api.getAgentTranscript({ id: sender })).find(e => e.clientNonce === 'reply-2');
      assert.equal(replyEntry.replyTo, quoted.id);

      await api.sendPrompt({ agentId: sender, prompt: 'A2A_PING', clientNonce: 'a2a-3' });
      await host.transcript.runLifecycle.drainExclusiveRuns(sender);
      await host.transcript.runLifecycle.drainExclusiveRuns(peerAgentId);
      const wake = userTexts.find(text => text.includes('hello teammate'));
      assert.ok(wake, 'the teammate must be woken with the message');
      assert.match(wake, new RegExp(`Message from rokbot \\(id: ${sender}\\)`));
      const peerTranscript = await api.getAgentTranscript({ id: peerAgentId });
      assert.equal(peerTranscript.some(e => e.role === 'user' && e.fromAgent?.id === sender && e.content === 'hello teammate'), true);
    } finally {
      await host.dispose();
    }
  });
}

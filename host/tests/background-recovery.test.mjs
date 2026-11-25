import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BackgroundRecovery,
  parsePendingWakeFile,
  resolveBackgroundRecoveryConfig,
} from '../runtime/background-recovery.mjs';

const DREAM = 'ec049f1a-a2b3-43c1-a17b-fd9402fa73c8';
const PARENT = '487ddb8b-a062-4bc0-b9b6-814f301db95f';
// The record that sat unconsumed on the live Host since 2026-11-22 01:14 (+08), verbatim.
const LIVE_DREAM_FILE = '{"version":1,"pending":[{"agentId":"ec049f1a-a2b3-43c1-a17b-fd9402fa73c8","kind":"subagent","workId":"sand-subagent-118e7249-4aab-41b4-93d6-6d2a398fe5bd","markedAtMs":1795281273083,"title":"给「梦 app」论坛做两项「AI 问答首字体感」优化。两项都**先改代码 + 跑测试 + 出截图**，**不要上预览、不要碰生产**，等用户看截图点头后再上。…","subagentType":"executor"}]}';

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rokbot-wakes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'host-pending-wakes.json');
}

function readFile(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function clock(start = Date.parse('2026-11-25T03:00:00Z')) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    advance(ms) { now += ms; },
    setTimer(fn, ms) {
      const timer = { fn, at: now + ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    async runDue() {
      let ran = 0;
      for (;;) {
        const due = timers.filter((timer) => !timer.cleared && timer.at <= now);
        if (due.length === 0) break;
        for (const timer of due) {
          timer.cleared = true;
          ran++;
          timer.fn();
        }
        await settle();
      }
      return ran;
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Mirrors the 2bb5e41 SandAgentRunner surface the Host wires (harness-sand-agent-runner.mjs). */
function fakeRunner(parentAgentId) {
  const runs = new Map();
  const runner = {
    handlers: {},
    turnResult: { aborted: false, sentMessageCount: 0 },
    activity: [],
    toolCalls: 0,
    getConversationId: () => parentAgentId,
    setPendingWakeArmedHandler(handler) { this.handlers.armed = handler; },
    setPendingWakeDisarmedHandler(handler) { this.handlers.disarmed = handler; },
    setBackgroundSubagentHandler(handler) { this.handlers.subagent = handler; },
    setBackgroundShellHandler(handler) { this.handlers.shell = handler; },
    getRunningSubagent(id) {
      const run = runs.get(id);
      if (!run) return null;
      return { subagentId: id, subagentType: run.subagentType, title: run.title, elapsedMs: 1000, toolCallCount: run.toolCalls, recentActivity: [...run.activity], transcriptPath: null };
    },
    getActivitySnapshot() { return [...this.activity]; },
    getObservedToolCallCount() { return this.toolCalls; },
    async run(prompt) {
      this.lastPrompt = prompt;
      if (this.block) await this.block;
      return this.turnResult;
    },
    watched: [],
    watchBackgroundShell(id, options) {
      this.watched.push({ id, options });
      this.handlers.armed?.({ parentAgentId, kind: 'shell', workId: id, title: options?.title ?? id });
    },
    subagents: {
      held: [],
      isRunning: (id) => runs.has(id),
      heldSubagentIds() { return [...this.held]; },
      dispatchBackgroundSubagent(params) {
        runs.set(params.subagentAgentId, { subagentType: params.subagentType, title: params.title ?? params.prompt.slice(0, 40), toolCalls: 0, activity: [] });
        runner.handlers.armed?.({ parentAgentId, kind: 'subagent', workId: params.subagentAgentId, title: params.prompt.slice(0, 40), subagentType: params.subagentType });
        return Promise.resolve();
      },
    },
    runs,
    // test helpers
    progress(id, line) {
      const run = runs.get(id);
      run.toolCalls++;
      run.activity.push(line);
    },
    finish(id, status, result) {
      const run = runs.get(id);
      runs.delete(id);
      this.handlers.subagent?.({ parentAgentId, subagentAgentId: id, subagentType: run.subagentType, toolCallId: 't1', title: run.title, status, result, durationMs: 5 });
    },
    vanish(id) { runs.delete(id); },
  };
  return runner;
}

function recovery(t, overrides = {}) {
  const c = overrides.clock ?? clock();
  const delivered = [];
  const logs = [];
  const state = { ready: true, gone: new Set(), outcome: 'delivered', fail: 0 };
  const config = { ...resolveBackgroundRecoveryConfig({}), tickMs: 60_000, stallMs: 15 * 60_000, retryBaseMs: 1_000, ...overrides.config };
  const r = new BackgroundRecovery({
    filePath: overrides.filePath ?? tempFile(t),
    config,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    log: (line, level) => logs.push({ line, level }),
    isReady: () => state.ready,
    isAgentGone: (id) => state.gone.has(id),
    getRunner: overrides.getRunner,
    buildCompletionPrompt: overrides.buildCompletionPrompt,
    deliver: async (agentId, prompt, info) => {
      if (state.fail > 0) {
        state.fail--;
        throw new Error('model unavailable');
      }
      delivered.push({ agentId, prompt, source: info.source });
      return state.outcome;
    },
  });
  t.after(() => r.dispose());
  return { r, c, delivered, logs, state };
}

test('config reads the watchdog window and retention from the environment', () => {
  const defaults = resolveBackgroundRecoveryConfig({});
  assert.equal(defaults.stallMs, 15 * 60_000);
  assert.equal(defaults.staleMs, 48 * 60 * 60_000);
  const custom = resolveBackgroundRecoveryConfig({ ROKBOT_SUBAGENT_STALL_MS: '300000', ROKBOT_BACKGROUND_WATCHDOG_TICK_MS: '5000', ROKBOT_PENDING_WAKE_MAX_AGE_MS: 'bogus' });
  assert.equal(custom.stallMs, 300_000);
  assert.equal(custom.tickMs, 5_000);
  assert.equal(custom.staleMs, defaults.staleMs);
  assert.equal(resolveBackgroundRecoveryConfig({ ROKBOT_SUBAGENT_STALL_MS: '0' }).stallMs, 0);
});

test('a finished background subagent wakes the bot that dispatched it and the marker is consumed', async (t) => {
  const { r, delivered } = recovery(t, {
    buildCompletionPrompt: (completions) => `[A background task just completed] ${completions.map((c) => `${c.title}: ${c.result}`).join('\n')}`,
  });
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-a', subagentType: 'executor', prompt: 'Build the release and report the version', toolCallId: 't1' });
  const marker = readFile(r.store.filePath).pending[0];
  assert.equal(marker.agentId, PARENT);
  assert.equal(marker.workId, 'sand-subagent-a');
  assert.equal(marker.prompt, 'Build the release and report the version');
  assert.equal(marker.status, 'running');

  runner.finish('sand-subagent-a', 'completed', 'Release 1.2.3 built.');
  await settle();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].agentId, PARENT);
  assert.match(delivered[0].prompt, /Release 1\.2\.3 built\./);
  assert.match(delivered[0].prompt, /sand-subagent-a/);
  assert.equal(existsSync(r.store.filePath), false, 'the pending-wake file is removed once delivered');
});

test('a background subagent that fails wakes its bot with the failure', async (t) => {
  const { r, delivered } = recovery(t);
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-err', subagentType: 'executor', prompt: 'Deploy the preview' });
  runner.finish('sand-subagent-err', 'error', 'Shell exited with code 137 (killed)');
  await settle();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].prompt, /failed/);
  assert.match(delivered[0].prompt, /code 137/);
  assert.equal(r.store.list().length, 0);
});

test('automation subagents are left to the automation runtime unless they ask for a parent wake', async (t) => {
  const { r, delivered } = recovery(t);
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  runner.handlers.armed({ parentAgentId: PARENT, kind: 'subagent', workId: 'auto-1', title: 'daily', subagentType: 'executor', automationRunUuid: 'run-1' });
  runner.handlers.subagent({ parentAgentId: PARENT, subagentAgentId: 'auto-1', subagentType: 'executor', title: 'daily', status: 'completed', result: 'ok', automationRunUuid: 'run-1' });
  await settle();
  assert.equal(delivered.length, 0);
  assert.equal(r.store.list().length, 0);
});

test('a parent stopping its own subagent clears the marker without a wake', async (t) => {
  const { r, delivered } = recovery(t);
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-stop', subagentType: 'executor', prompt: 'x' });
  runner.handlers.disarmed({ parentAgentId: PARENT, kind: 'subagent', workId: 'sand-subagent-stop' });
  assert.equal(r.store.list().length, 0);
  assert.equal(delivered.length, 0);
});

test('after a restart the bot is told which subagent and turn were interrupted and where they stopped', async (t) => {
  const filePath = tempFile(t);
  const c = clock();
  const first = recovery(t, { filePath, clock: c });
  const runner = first.r.attachRunner(fakeRunner(PARENT), PARENT);
  first.r.start();
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-long', subagentType: 'executor', prompt: 'Migrate the forum DB, then run the test suite and screenshot /ai' });
  runner.progress('sand-subagent-long', '[running] Shell: bun test --unit');
  runner.block = new Promise(() => {}); // a user turn that never finishes before the restart
  void runner.run('please migrate the forum and tell me when done', { requestSource: 'turn' });
  c.advance(60_000);
  await c.runDue();
  first.r.beginShutdown('SIGTERM');
  const saved = readFile(filePath);
  assert.equal(saved.pending.length, 2);
  const sub = saved.pending.find((entry) => entry.kind === 'subagent');
  assert.equal(sub.lastActivity, '[running] Shell: bun test --unit');
  assert.equal(sub.toolCallCount, 1);
  assert.equal(sub.interruptedReason, 'SIGTERM');
  assert.ok(saved.pending.find((entry) => entry.kind === 'turn' && /migrate the forum/.test(entry.prompt)));

  c.advance(5 * 60_000);
  const second = recovery(t, { filePath, clock: c });
  second.r.start();
  await settle();
  assert.equal(second.delivered.length, 1, 'one wake for the bot with both interrupted items');
  const { prompt, agentId } = second.delivered[0];
  assert.equal(agentId, PARENT);
  assert.match(prompt, /sand-subagent-long/);
  assert.match(prompt, /interrupted by a Host restart/);
  assert.match(prompt, /Last action: \[running\] Shell: bun test --unit/);
  assert.match(prompt, /Migrate the forum DB, then run the test suite/);
  assert.match(prompt, /Do not re-run it blindly/);
  assert.match(prompt, /previous turn was cut off/);
  assert.equal(existsSync(filePath), false, 'pending wakes are consumed after delivery');
});

test('read-only media subagents are re-dispatched after a restart', async (t) => {
  const filePath = tempFile(t);
  writeFileSync(filePath, JSON.stringify({ version: 1, pending: [{
    agentId: PARENT, kind: 'subagent', workId: 'sand-subagent-video', markedAtMs: Date.parse('2026-11-25T02:50:00Z'),
    title: 'Watch the demo video', subagentType: 'watchVideo', prompt: 'Watch /workspace/demo.mp4 and list the bugs', hostBootId: 'old',
  }] }));
  const { r, delivered } = recovery(t, { filePath });
  r.start();
  await settle();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].prompt, /restart it now: dispatch a new background Task with the same subagent_type and prompt/);
  assert.match(delivered[0].prompt, /Watch \/workspace\/demo\.mp4/);
});

test('the stuck 梦 app record from the live Host is delivered once as a stale notice and then removed', async (t) => {
  const filePath = tempFile(t);
  writeFileSync(filePath, LIVE_DREAM_FILE);
  const { r, delivered } = recovery(t, { filePath, clock: clock(Date.parse('2026-11-25T04:00:00Z')) });
  r.start();
  await settle();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].agentId, DREAM);
  assert.match(delivered[0].prompt, /sand-subagent-118e7249-4aab-41b4-93d6-6d2a398fe5bd/);
  assert.match(delivered[0].prompt, /never reported back/);
  assert.match(delivered[0].prompt, /Do not re-run it automatically/);
  assert.match(delivered[0].prompt, /梦 app/);
  assert.equal(existsSync(filePath), false);
});

test('records of deleted bots are dropped instead of blocking the file', async (t) => {
  const filePath = tempFile(t);
  writeFileSync(filePath, LIVE_DREAM_FILE);
  const { r, delivered, state } = recovery(t, { filePath });
  state.gone.add(DREAM);
  r.start();
  await settle();
  assert.equal(delivered.length, 0);
  assert.equal(existsSync(filePath), false);
});

test('recovery waits until local work is allowed, then delivers', async (t) => {
  const filePath = tempFile(t);
  writeFileSync(filePath, LIVE_DREAM_FILE);
  const { r, c, delivered, state } = recovery(t, { filePath });
  state.ready = false;
  r.start();
  await settle();
  assert.equal(delivered.length, 0);
  assert.ok(existsSync(filePath));
  state.ready = true;
  c.advance(r.config.readyPollMs);
  await c.runDue();
  assert.equal(delivered.length, 1);
  assert.equal(existsSync(filePath), false);
});

test('failed wakes are retried with backoff and the record survives until delivered', async (t) => {
  const { r, c, delivered, state } = recovery(t);
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-r', subagentType: 'executor', prompt: 'x' });
  state.fail = 2;
  runner.finish('sand-subagent-r', 'completed', 'done');
  await settle();
  assert.equal(delivered.length, 0);
  assert.equal(readFile(r.store.filePath).pending[0].deliveryAttempts, 1);
  c.advance(1_000);
  await c.runDue();
  assert.equal(delivered.length, 0);
  assert.equal(readFile(r.store.filePath).pending[0].deliveryAttempts, 2);
  c.advance(2_000);
  await c.runDue();
  assert.equal(delivered.length, 1);
  assert.equal(existsSync(r.store.filePath), false);
});

test('a wake superseded by a user message is retried; after the attempt cap the record is cleared', async (t) => {
  const { r, c, delivered, state, logs } = recovery(t, { config: { maxDeliveryAttempts: 3 } });
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-s', subagentType: 'executor', prompt: 'x' });
  state.outcome = 'superseded';
  runner.finish('sand-subagent-s', 'completed', 'done');
  await settle();
  c.advance(60_000);
  await c.runDue();
  c.advance(60_000);
  await c.runDue();
  assert.equal(delivered.length, 3);
  assert.equal(existsSync(r.store.filePath), false, 'the record does not stay stuck forever');
  assert.ok(logs.some((entry) => /gave up waking/.test(entry.line)));
});

test('watchdog wakes the bot once when a subagent stalls, backs off, and resets on progress', async (t) => {
  const { r, c, delivered } = recovery(t, { config: { tickMs: 60_000, stallMs: 15 * 60_000, maxStallNotices: 2 } });
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  r.start();
  await settle();
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-w', subagentType: 'executor', prompt: 'Screenshot the /ai page' });
  runner.progress('sand-subagent-w', '[running] Shell: npx playwright test');
  for (let i = 0; i < 14; i++) {
    c.advance(60_000);
    await c.runDue();
  }
  assert.equal(delivered.length, 0, 'no notice before the stall window');
  for (let i = 0; i < 3; i++) {
    c.advance(60_000);
    await c.runDue();
  }
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].source, 'background-stall');
  assert.match(delivered[0].prompt, /sand-subagent-w/);
  assert.match(delivered[0].prompt, /no visible progress for 15 min/);
  assert.match(delivered[0].prompt, /Last action: \[running\] Shell: npx playwright test/);
  assert.equal(r.store.list().length, 1, 'the running subagent stays tracked after a stall notice');

  for (let i = 0; i < 20; i++) {
    c.advance(60_000);
    await c.runDue();
  }
  assert.equal(delivered.length, 1, 'no repeated notice inside the backoff window');

  runner.progress('sand-subagent-w', '[done] Shell: npx playwright test');
  c.advance(60_000);
  await c.runDue();
  for (let i = 0; i < 16; i++) {
    c.advance(60_000);
    await c.runDue();
  }
  assert.equal(delivered.length, 2, 'a new stall after progress is reported again');

  for (let i = 0; i < 30; i++) {
    c.advance(60_000);
    await c.runDue();
  }
  assert.equal(delivered.length, 3, 'the same stall is reminded once more after a doubled wait');
  for (let i = 0; i < 300; i++) {
    c.advance(60_000);
    await c.runDue();
  }
  assert.equal(delivered.length, 3, 'the notice cap per stall holds');
});

test('watchdog reports a subagent that disappeared without a result', async (t) => {
  const { r, c, delivered } = recovery(t, { config: { tickMs: 60_000, vanishGraceMs: 120_000 } });
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  r.start();
  await settle();
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-v', subagentType: 'executor', prompt: 'Run the migration' });
  runner.vanish('sand-subagent-v');
  for (let i = 0; i < 4; i++) {
    c.advance(60_000);
    await c.runDue();
  }
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].prompt, /stopped running without delivering a result/);
  assert.equal(r.store.list().length, 0);
});

test('held completions are not mistaken for vanished subagents', async (t) => {
  const { r, c, delivered } = recovery(t, { config: { tickMs: 60_000, vanishGraceMs: 60_000 } });
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  r.start();
  await settle();
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-h', subagentType: 'executor', prompt: 'x' });
  runner.vanish('sand-subagent-h');
  runner.subagents.held.push('sand-subagent-h');
  for (let i = 0; i < 5; i++) {
    c.advance(60_000);
    await c.runDue();
  }
  assert.equal(delivered.length, 0);
});

test('work aborted by the Host stopping stays recorded as interrupted instead of waking anyone', async (t) => {
  const { r, delivered } = recovery(t);
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-k', subagentType: 'executor', prompt: 'x' });
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-ok', subagentType: 'executor', prompt: 'y' });
  r.beginShutdown('SIGTERM');
  runner.finish('sand-subagent-k', 'error', 'The background task was interrupted before it finished.');
  runner.finish('sand-subagent-ok', 'completed', 'finished just before the stop');
  await settle();
  assert.equal(delivered.length, 0);
  const saved = parsePendingWakeFile(readFileSync(r.store.filePath, 'utf8'));
  assert.equal(saved.find((entry) => entry.workId === 'sand-subagent-k').status, 'running');
  assert.equal(saved.find((entry) => entry.workId === 'sand-subagent-k').interruptedReason, 'SIGTERM');
  assert.equal(saved.find((entry) => entry.workId === 'sand-subagent-ok').status, 'settled', 'a result that arrived is kept for the next start');
});

test('a settled result recorded before a restart is delivered after it', async (t) => {
  const filePath = tempFile(t);
  const first = recovery(t, { filePath });
  const runner = first.r.attachRunner(fakeRunner(PARENT), PARENT);
  await runner.subagents.dispatchBackgroundSubagent({ subagentAgentId: 'sand-subagent-d', subagentType: 'executor', prompt: 'x' });
  first.state.ready = false; // the Host is going down; the wake cannot run
  runner.finish('sand-subagent-d', 'completed', 'durable result');
  await settle();
  first.r.beginShutdown('SIGTERM');
  const second = recovery(t, { filePath });
  second.r.start();
  await settle();
  assert.equal(second.delivered.length, 1);
  assert.match(second.delivered[0].prompt, /durable result/);
  assert.equal(existsSync(filePath), false);
});

test('background shells wake the bot on completion and are re-watched after a restart', async (t) => {
  const filePath = tempFile(t);
  const first = recovery(t, { filePath });
  const runner = first.r.attachRunner(fakeRunner(PARENT), PARENT);
  runner.handlers.armed({ parentAgentId: PARENT, kind: 'shell', workId: 'shell-7', title: 'npm run build' });
  first.r.beginShutdown('SIGTERM');

  const next = fakeRunner(PARENT);
  const second = recovery(t, { filePath, getRunner: async () => next });
  second.r.start();
  await settle();
  assert.deepEqual(next.watched.map((w) => w.id), ['shell-7']);
  assert.equal(second.delivered.length, 0, 'a re-watched shell needs no notice');
  next.handlers.shell({ agentId: PARENT, shellId: 'shell-7', title: 'npm run build', status: 'success', outputPath: '/workspace/.terminals/7.txt' });
  await settle();
  assert.equal(second.delivered.length, 1);
  assert.match(second.delivered[0].prompt, /npm run build/);
  assert.match(second.delivered[0].prompt, /Full output: \/workspace\/\.terminals\/7\.txt/);
  assert.equal(existsSync(filePath), false);
});

test('turns finished normally or superseded leave no marker; the wake turns themselves are not tracked', async (t) => {
  const { r } = recovery(t);
  const runner = r.attachRunner(fakeRunner(PARENT), PARENT);
  await runner.run('hello', { requestSource: 'turn' });
  runner.turnResult = { aborted: true };
  await runner.run('superseded', { requestSource: 'turn' });
  await runner.run('cron', { requestSource: 'automation' });
  assert.equal(r.store.list().length, 0);
  await r.ownRun.run(true, () => {
    runner.block = new Promise(() => {});
    void runner.run('wake', {});
  });
  assert.equal(r.store.list().length, 0);
});

test('long-running background shells are re-watched however old they are, not reported as lost', async (t) => {
  const filePath = tempFile(t);
  writeFileSync(filePath, JSON.stringify({ version: 1, pending: [{
    agentId: PARENT, kind: 'shell', workId: 'shell-dev-server', markedAtMs: Date.parse('2026-11-20T00:00:00Z'), title: 'npm run dev',
  }] }));
  const next = fakeRunner(PARENT);
  const { r, delivered } = recovery(t, { filePath, getRunner: async () => next });
  r.start();
  await settle();
  assert.deepEqual(next.watched.map((w) => w.id), ['shell-dev-server']);
  assert.equal(delivered.length, 0);
  assert.equal(r.store.list()[0].markedAtMs, Date.parse('2026-11-20T00:00:00Z'), 'the original start time is kept');
});

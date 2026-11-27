// The shared composer assist (mac/clients/desktop/composer-assist.cjs, used by the Web client and the
// desktop apps): loading state machine, inline completion controller, and packaging/wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const assist = require('../../mac/clients/desktop/composer-assist.cjs');
const { createLoadingMachine, createCompletionController } = assist;

/** Manual timers: run() fires everything scheduled so far. */
function fakeTimers() {
  const tasks = new Map();
  let next = 1;
  return {
    schedule: (fn, ms) => { const id = next++; tasks.set(id, { fn, ms }); return id; },
    cancelSchedule: id => { tasks.delete(id); },
    get pending() { return [...tasks.values()]; },
    run() { const list = [...tasks.values()]; tasks.clear(); for (const task of list) task.fn(); },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ respond } = {}) {
  const timers = fakeTimers();
  const calls = [];
  const ghosts = [];
  const settings = [];
  const controller = createCompletionController({
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule,
    onChange: value => ghosts.push(value),
    onSettings: patch => settings.push(patch),
    request: (payload, signal) => {
      const call = { payload, signal };
      calls.push(call);
      return respond ? respond(payload, signal, call) : Promise.resolve({ enabled: true, completion: ' the tests', source: 'model' });
    },
  });
  const base = { enabled: true, composing: false, hasHistory: true, caretAtEnd: true, context: 'bot:1', payload: { agentId: 'bot' } };
  return { timers, calls, ghosts, settings, controller, type: (text, extra = {}) => controller.update({ ...base, ...extra, text }) };
}

test('loading machine: idle -> loading -> ready, failures and stale tokens', () => {
  const seen = [];
  const machine = createLoadingMachine({ onChange: ({ phase }) => seen.push(phase) });
  assert.equal(machine.phase, 'idle');
  const first = machine.begin();
  assert.equal(machine.phase, 'loading');
  assert.equal(machine.succeed(first, ['Run the tests', 'Show logs']), true);
  assert.equal(machine.phase, 'ready');
  assert.deepEqual(machine.items, ['Run the tests', 'Show logs']);

  const second = machine.begin();
  assert.equal(machine.fail(second), true);
  assert.equal(machine.phase, 'failed');
  assert.deepEqual(machine.items, []);

  // A newer request makes the older answer stale: it can neither complete nor fail the new one.
  const stale = machine.begin();
  const fresh = machine.begin();
  assert.equal(machine.succeed(stale, ['old']), false);
  assert.equal(machine.fail(stale), false);
  assert.equal(machine.phase, 'loading');
  assert.equal(machine.succeed(fresh, ['new']), true);
  assert.equal(machine.succeed(fresh, ['again']), false, 'only one outcome per request');

  // reset drops what is in flight (conversation switch, blur, setting turned off).
  const dropped = machine.begin();
  machine.reset();
  assert.equal(machine.phase, 'idle');
  assert.equal(machine.isCurrent(dropped), false);
  assert.equal(machine.succeed(dropped, ['late']), false);
  assert.deepEqual(seen, ['loading', 'ready', 'loading', 'failed', 'loading', 'loading', 'ready', 'loading', 'idle']);
});

test('completion: no request when off, composing, too short, empty chat, or caret not at the end', async () => {
  const h = harness();
  h.type('Please run', { enabled: false });
  h.type('Please run', { composing: true });
  h.type('P');
  h.type(' 好 ');
  h.type('Please run', { hasHistory: false });
  h.type('Please run', { caretAtEnd: false });
  assert.equal(h.timers.pending.length, 0);
  h.timers.run();
  await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.controller.ghost, '');
  // Two characters is enough.
  h.type('继续');
  assert.equal(h.timers.pending.length, 1);
});

test('completion: debounced, one request for a burst of keystrokes, with the context payload', async () => {
  const h = harness();
  for (const text of ['Pl', 'Ple', 'Plea', 'Pleas', 'Please', 'Please run']) h.type(text);
  assert.equal(h.timers.pending.length, 1, 'each keystroke replaces the pending timer');
  assert.equal(h.timers.pending[0].ms, assist.COMPLETION_DEBOUNCE_MS);
  assert.ok(assist.COMPLETION_DEBOUNCE_MS >= 300 && assist.COMPLETION_DEBOUNCE_MS <= 500);
  assert.equal(h.calls.length, 0);
  h.timers.run();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].payload, { agentId: 'bot', text: 'Please run' });
  assert.equal(h.controller.ghost, ' the tests');
  // keyup after input with the same draft does not restart or cancel anything
  h.type('Please run');
  assert.equal(h.timers.pending.length, 0);
  assert.equal(h.calls.length, 1);
});

test('completion: a newer draft cancels the request in flight and its late answer is ignored', async () => {
  const resolvers = [];
  const h = harness({ respond: () => new Promise(resolve => resolvers.push(resolve)) });
  h.type('Please run');
  h.timers.run();
  assert.equal(h.calls.length, 1);
  h.type('Please run all');
  assert.equal(h.calls[0].signal.aborted, true, 'the stale request is aborted');
  h.timers.run();
  assert.equal(h.calls.length, 2);
  resolvers[0]({ enabled: true, completion: ' the tests', source: 'model' });
  await flush();
  assert.equal(h.controller.ghost, '', 'stale answer ignored');
  resolvers[1]({ enabled: true, completion: ' checks', source: 'model' });
  await flush();
  assert.equal(h.controller.ghost, ' checks');
  assert.equal(h.controller.stats.cancelled, 1);
});

test('completion: kept while typing along the prediction, dropped and re-requested on a mismatch', async () => {
  const h = harness();
  h.type('Please run');
  h.timers.run();
  await flush();
  assert.equal(h.controller.ghost, ' the tests');
  h.type('Please run t');
  assert.equal(h.controller.ghost, 'he tests');
  h.type('Please run the te');
  assert.equal(h.controller.ghost, 'sts');
  assert.equal(h.timers.pending.length, 0, 'no new request while the prediction still matches');
  h.type('Please run the tx');
  assert.equal(h.controller.ghost, '', 'mismatch clears the ghost');
  assert.equal(h.timers.pending.length, 1, 'and asks again (debounced)');
  h.timers.run();
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].payload.text, 'Please run the tx');
});

test('completion: cached per conversation and draft; failures are silent and not cached', async () => {
  let fail = true;
  const h = harness({
    respond: payload => (fail
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ enabled: true, completion: payload.text === '帮我' ? '跑一下测试' : '', source: 'model' })),
  });
  h.type('帮我');
  h.timers.run();
  await flush();
  assert.equal(h.controller.ghost, '', 'failure shows nothing');
  fail = false;
  h.type('帮我看');
  h.type('帮我');
  h.timers.run();
  await flush();
  assert.equal(h.calls.length, 2, 'the failure was not cached');
  assert.equal(h.controller.ghost, '跑一下测试');
  h.type('帮我看');
  h.timers.run();
  await flush();
  assert.equal(h.calls.length, 3);
  // Back to a draft we already asked about: from the cache, no request.
  h.type('帮我');
  assert.equal(h.timers.pending.length, 0);
  assert.equal(h.controller.ghost, '跑一下测试');
  assert.equal(h.calls.length, 3);
  assert.ok(h.controller.stats.cacheHits >= 1);
  // Another conversation does not reuse it.
  h.type('帮我', { context: 'bot:2' });
  assert.equal(h.controller.ghost, '');
  assert.equal(h.timers.pending.length, 1);
});

test('completion: accept returns the suffix once; a disabled answer turns the setting off', async () => {
  const h = harness({ respond: () => Promise.resolve({ enabled: true, completion: ' now', source: 'model' }) });
  h.type('Ship it');
  h.timers.run();
  await flush();
  assert.equal(h.controller.accept(), ' now');
  assert.equal(h.controller.ghost, '');
  assert.equal(h.controller.accept(), '');
  h.type('Ship it now');
  assert.equal(h.timers.pending.length, 0, 'no immediate request for the accepted text');

  const off = harness({ respond: () => Promise.resolve({ enabled: false, completion: '', source: 'disabled' }) });
  off.type('Ship it');
  off.timers.run();
  await flush();
  assert.deepEqual(off.settings, [{ completionEnabled: false }]);
  assert.equal(off.controller.ghost, '');
});

test('completion: Escape dismisses until the draft changes', async () => {
  const h = harness();
  h.type('Please run');
  h.timers.run();
  await flush();
  assert.equal(h.controller.ghost, ' the tests');
  h.controller.dismiss();
  assert.equal(h.controller.ghost, '');
  h.type('Please run');
  assert.equal(h.controller.ghost, '', 'the Escape keyup does not bring it back from the cache');
  assert.equal(h.timers.pending.length, 0);
  h.type('Please run ');
  assert.equal(h.timers.pending.length, 1, 'a new draft asks again');
});

test('completion: composition hides the ghost and resumes the same prediction afterwards', async () => {
  const h = harness({ respond: () => Promise.resolve({ enabled: true, completion: '跑一下测试', source: 'model' }) });
  h.type('帮我');
  h.timers.run();
  await flush();
  assert.equal(h.controller.ghost, '跑一下测试');
  h.type('帮我pao', { composing: true });
  assert.equal(h.controller.ghost, '', 'nothing shows during IME composition');
  assert.equal(h.timers.pending.length, 0, 'and nothing is requested');
  h.type('帮我跑', { composing: false });
  assert.equal(h.controller.ghost, '一下测试');
  assert.equal(h.calls.length, 1);
});

test('composer assist is shared by the Web bundle and the desktop preload', () => {
  const bridge = fs.readFileSync(path.join(REPO, 'web/client/bridge.js'), 'utf8');
  assert.ok(bridge.indexOf("import './desktop/composer-assist.js'") >= 0);
  assert.ok(bridge.indexOf("import './desktop/composer-assist.js'") < bridge.indexOf("from './suggestions.js'"));
  const patch = fs.readFileSync(path.join(REPO, 'web/patchers/patch.mjs'), 'utf8');
  assert.match(patch, /sharedAssets = \[[^\]]*'composer-assist\.cjs'/);
  const preload = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/preload.cjs'), 'utf8');
  assert.match(preload, /require\('\.\/suggestions-composer\.cjs'\)/);
  assert.equal(fs.existsSync(path.join(REPO, 'mac/clients/desktop/suggestions-settings.cjs')), false, 'the old General-pane section is gone');
  const loader = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/suggestions-composer.cjs'), 'utf8');
  assert.match(loader, /require\('\.\/composer-assist\.cjs'\)/);
  assert.match(loader, /rokbot-local:suggestions-complete/);
  assert.match(loader, /rokbot-local:suggestions-cancel/);
  const main = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/main.mjs'), 'utf8');
  for (const channel of ['suggestions-generate', 'suggestions-complete', 'suggestions-cancel']) {
    assert.ok(main.includes(`'rokbot-local:${channel}'`), channel);
  }
  assert.match(main, /'\/local\/suggestions\/complete', 9000/);

  const css = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/workspace.css'), 'utf8');
  for (const selector of ['.rokbot-suggestions__skeleton', '.rokbot-ghost', '.rokbot-sug-page', '@keyframes rokbot-shimmer']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*rokbot-suggestions__skeleton::after[\s\S]*animation: none/);
  assert.match(css, /html\[data-theme\*="dark"\] \.rokbot-ghost/);
  assert.match(css, /html\[data-theme\*="light"\] \.rokbot-ghost/);
  const src = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/composer-assist.cjs'), 'utf8');
  assert.doesNotMatch(src, new RegExp(`g${'rok'}`, 'i'));
  assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  // Tab / ArrowRight accept, IME composition is respected, settings page lists all three controls.
  assert.match(src, /ev\.key === 'Tab'/);
  assert.match(src, /ev\.key === 'ArrowRight' && caretAtEnd/);
  assert.match(src, /compositionstart/);
  for (const id of ['rokbot-setting-suggestions-enabled', 'rokbot-setting-suggestions-ai-enabled', 'rokbot-setting-completion-enabled']) {
    assert.ok(src.includes(id), id);
  }
});

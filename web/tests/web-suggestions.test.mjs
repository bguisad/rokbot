import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as webSuggestions from '../client/suggestions.js';
import {
  extractComposerText,
  insertSuggestionText,
  isZhLocale,
  matchCompletions,
  mergeSuggestionItems,
  sendSuggestionText,
} from '../client/suggestions.js';

// bridge.js loads the shared module first in the browser; do the same here.
createRequire(import.meta.url)('../../mac/clients/desktop/composer-assist.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

test('web suggestions removes static presets, merges phrases before AI, and contains no emoji or legacy brand', () => {
  assert.equal('FALLBACK_PRESETS' in webSuggestions, false);
  assert.equal('staticPresets' in webSuggestions, false);

  assert.equal(isZhLocale('zh-CN'), true);
  assert.equal(isZhLocale('zh-Hans'), true);
  assert.equal(isZhLocale('en-US'), false);

  const merged = mergeSuggestionItems(
    [{ id: 'p1', text: '继续' }, { id: 'p2', text: '总结一下' }],
    ['继续', '查看日志', '运行测试'],
  );
  assert.deepEqual(merged, [
    { type: 'phrase', id: 'p1', text: '继续' },
    { type: 'phrase', id: 'p2', text: '总结一下' },
    { type: 'ai', text: '查看日志' },
    { type: 'ai', text: '运行测试' },
  ]);

  const forbiddenBrand = new RegExp(`g${'rok'}`, 'i');
  const src = fs.readFileSync(path.join(REPO, 'web/client/suggestions.js'), 'utf8');
  assert.doesNotMatch(src, forbiddenBrand, 'suggestions.js must not mention legacy brand');
  assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}]/u, 'suggestions.js must not contain emoji');

  for (const name of ['composer-assist.cjs', 'suggestions-composer.cjs']) {
    const desktopSrc = fs.readFileSync(path.join(REPO, 'mac/clients/desktop', name), 'utf8');
    assert.doesNotMatch(desktopSrc, forbiddenBrand, `desktop ${name} must not mention legacy brand`);
    assert.doesNotMatch(desktopSrc, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `desktop ${name} must not contain emoji`);
  }
});

test('extractComposerText, insertSuggestionText, and sendSuggestionText send immediately on click', () => {
  assert.equal(extractComposerText({ tagName: 'DIV', textContent: '\u200B  ' }), '');
  assert.equal(extractComposerText({ tagName: 'TEXTAREA', value: ' hello ' }), 'hello');

  const events = [];
  const textarea = {
    tagName: 'TEXTAREA',
    value: '',
    focused: false,
    focus() { this.focused = true; },
    dispatchEvent(ev) { events.push(ev.type); },
  };
  assert.equal(insertSuggestionText(textarea, 'Summarize the key points'), true);
  assert.equal(textarea.focused, true);
  assert.equal(textarea.value, 'Summarize the key points');
  assert.deepEqual(events, ['input']);

  // sendSuggestionText inserts and clicks the Send button immediately
  let clicked = 0;
  const sendBtn = {
    disabled: false,
    type: 'submit',
    classList: { contains: cls => cls === 'sand-prompt-send' },
    getAttribute: name => (name === 'aria-label' ? 'Send message' : null),
    click() { clicked += 1; },
  };
  const fakeForm = {
    querySelectorAll: () => [sendBtn],
  };
  const editable = {
    tagName: 'DIV',
    textContent: '',
    focused: false,
    focus() { this.focused = true; },
    dispatchEvent() {},
  };
  const fakeDoc = {
    execCommand(cmd, _ui, val) {
      if (cmd === 'insertText') {
        editable.textContent = val;
        return true;
      }
      return false;
    },
  };
  assert.equal(
    sendSuggestionText(fakeForm, editable, '继续展开说说', fakeDoc, { schedule: fn => fn() }),
    true,
  );
  assert.equal(editable.textContent, '继续展开说说');
  assert.equal(clicked, 1);

  // Fallback to form.requestSubmit when no send button is present
  let submitted = 0;
  const formOnly = {
    querySelectorAll: () => [],
    requestSubmit() { submitted += 1; },
  };
  assert.equal(
    sendSuggestionText(formOnly, textarea, 'Run tests', fakeDoc, { schedule: null }),
    true,
  );
  assert.equal(submitted, 1);
});

test('habits: frequent messages fill after the model items (max 3), local completion matching', () => {
  const merged = mergeSuggestionItems([{ id: 'p1', text: '提个 PR' }], ['先修 upload.spec', '两个一起修'], ['跑一下 e2e', '提个 PR', '看下 CI']);
  assert.deepEqual(merged.map(item => [item.type, item.text]), [
    ['phrase', '提个 PR'], ['ai', '先修 upload.spec'], ['ai', '两个一起修'], ['frequent', '跑一下 e2e'],
  ]);
  assert.deepEqual(mergeSuggestionItems([], [], ['a1', 'a2', 'a3', 'a4']).map(item => item.type), ['frequent', 'frequent', 'frequent']);

  const pool = ['跑一下全量测试', '帮我跑一下 lint', '提个 PR 吧', '跑测试并截图', 'Deploy staging'];
  assert.deepEqual(matchCompletions('跑一', pool), ['跑一下全量测试', '帮我跑一下 lint']);
  assert.deepEqual(matchCompletions('跑测', pool), ['跑测试并截图', '跑一下全量测试']);
  assert.deepEqual(matchCompletions('deploy', pool), ['Deploy staging']);
  assert.deepEqual(matchCompletions('提个 PR 吧', pool), []);
  assert.deepEqual(matchCompletions('', pool), []);
});

test('habits: settings defaults, strip motion, feedback / clear wiring', () => {
  const assist = globalThis.RokBotComposerAssist;
  const defaults = assist.normalizeSettings({});
  assert.equal(defaults.learningEnabled, true);
  assert.equal(defaults.localCompletionEnabled, true);
  assert.equal(assist.normalizeSettings({ learningEnabled: false }).learningEnabled, false);
  assert.ok(assist.BAR_FADE_MS >= 150 && assist.BAR_FADE_MS <= 200);

  const src = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/composer-assist.cjs'), 'utf8');
  assert.ok(src.includes("request('/local/suggestions/feedback', { agentId, action, text, shown }, undefined, 'POST')"));
  assert.ok(src.includes("if (!settingsState.learningEnabled) return;"), 'no feedback when learning is off');
  assert.ok(src.includes("sendFeedback('tap', item.text, items)") && src.includes("sendFeedback('dismiss', '', items)"));
  assert.ok(src.includes("request('/local/suggestions/habits', null, undefined, 'DELETE')"), '清空学习记录');
  assert.ok(src.includes("'根据习惯学习'") && src.includes("'本地补全'") && src.includes("'清空学习记录'"));
  assert.ok(src.includes('insertSuggestionText(findComposerInput(liveForm), item.text, doc);'), 'a local match fills, not sends');
  assert.ok(src.includes('res.frequentSuggestions') && src.includes('res.completionCandidates'));

  const css = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/workspace.css'), 'utf8');
  assert.match(css, /\.rokbot-suggestions--enter \{\s*animation: rokbot-bar-in 170ms/);
  assert.match(css, /\.rokbot-suggestions--leaving \{\s*animation: rokbot-bar-out 170ms/);
  assert.match(css, /@keyframes rokbot-bar-in \{\s*from \{ opacity: 0; transform: translateY\(3px\); \}/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('.rokbot-suggestions--enter') && reduced.includes('.rokbot-suggestions--leaving'), 'reduced motion: none');
});

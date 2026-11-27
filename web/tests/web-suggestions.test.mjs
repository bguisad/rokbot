import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as webSuggestions from '../client/suggestions.js';
import {
  extractComposerText,
  insertSuggestionText,
  isZhLocale,
  mergeSuggestionItems,
  sendSuggestionText,
} from '../client/suggestions.js';

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

  const desktopSrc = fs.readFileSync(path.join(REPO, 'mac/clients/desktop/suggestions-settings.cjs'), 'utf8');
  assert.doesNotMatch(desktopSrc, forbiddenBrand, 'desktop suggestions-settings.cjs must not mention legacy brand');
  assert.doesNotMatch(desktopSrc, /[\u{1F300}-\u{1FAFF}]/u, 'desktop suggestions-settings.cjs must not contain emoji');
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

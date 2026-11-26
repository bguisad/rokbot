import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractComposerText,
  insertSuggestionText,
  isZhLocale,
  staticPresets,
} from '../client/suggestions.js';

test('web suggestions localize static presets for empty and ongoing conversations', () => {
  assert.equal(isZhLocale('zh-CN'), true);
  assert.equal(isZhLocale('zh-Hans'), true);
  assert.equal(isZhLocale('en-US'), false);

  const zhEmpty = staticPresets(true, false);
  const zhOngoing = staticPresets(true, true);
  const enEmpty = staticPresets(false, false);
  const enOngoing = staticPresets(false, true);

  assert.equal(zhEmpty.length, 4);
  assert.equal(zhOngoing.length, 4);
  assert.equal(enEmpty.length, 4);
  assert.equal(enOngoing.length, 4);
  assert.notDeepEqual(zhEmpty, zhOngoing);
  assert.notDeepEqual(enEmpty, enOngoing);
  assert.ok(zhEmpty.every(s => /[\u4e00-\u9fff]/.test(s)));
  assert.ok(enEmpty.every(s => /^[A-Za-z0-9 ,?.''-]+$/.test(s)));
});

test('extractComposerText ignores zero-width spaces and insertSuggestionText updates inputs and contenteditable', () => {
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

  const editableEvents = [];
  const editable = {
    tagName: 'DIV',
    textContent: '',
    focused: false,
    focus() { this.focused = true; },
    dispatchEvent(ev) { editableEvents.push(ev.type); },
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
  assert.equal(insertSuggestionText(editable, '继续展开说说', fakeDoc), true);
  assert.equal(editable.focused, true);
  assert.equal(editable.textContent, '继续展开说说');
});

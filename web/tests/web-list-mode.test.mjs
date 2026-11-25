// Phone layout of the chat list header: the wind chime toggle (sort by last message, added by the
// desktop recipes) floats left of the Search field, and the bottom controls stay above the list.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../client/android.css', import.meta.url), 'utf8');
const rule = selector => {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `missing rule: ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};
const X4 = ':not(#\\#):not(#\\#):not(#\\#):not(#\\#)';

test('phones: the toggle sits between Connect apps and the Search field', () => {
  const toggle = rule(`html.rokbot-phone button.rokbot-list-mode-toggle${X4}`);
  assert.match(toggle, /position: fixed !important/);
  assert.match(toggle, /left: 64px !important/);
  assert.match(toggle, /bottom: 12px !important/);
  const search = rule(`html.rokbot-phone button.rokbot-list-mode-toggle ~ button.sand-agents-sidebar__search${X4}`);
  assert.match(search, /left: 116px !important/, 'Search moves right of the toggle (64 + 44 + 8)');
  // Without the toggle (the 0.71.2 interface) Search keeps its place next to Connect apps.
  assert.match(rule(`html.rokbot-phone button.sand-agents-sidebar__search${X4}`), /left: 64px !important/);
});

test('phones: the pressed toggle keeps the official selected tint', () => {
  const pressed = rule(`html.rokbot-phone button.rokbot-list-mode-toggle[aria-pressed="true"]${X4}`);
  assert.match(pressed, /--sand-bg-accent-secondary/);
  assert.match(pressed, /color: var\(--sand-text-accent-primary\) !important/);
});

test('phones: the bottom controls stay above the official list rows (z-index 10)', () => {
  for (const selector of [
    `html.rokbot-phone button.rokbot-list-mode-toggle${X4}`,
    `html.rokbot-phone button.sand-agents-sidebar__search${X4}`,
    `html.rokbot-phone .sand-agents-sidebar__footer button:not([aria-haspopup="menu"])${X4}`,
  ]) {
    const z = Number(/z-index: (\d+) !important/.exec(rule(selector))?.[1]);
    assert.ok(z > 10, `${selector}: z-index ${z}`);
  }
});

// Phone layout of the chat list header: the list order toggle (sort by last message, added by the
// desktop recipes) stays in the header beside New Bot as a round header button with a copper bell,
// and the bottom controls (Connect apps, Search) stay above the list.
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
const TOGGLE = 'html.rokbot-phone button.rokbot-list-mode-toggle';
const icon = name => decodeURIComponent(new RegExp(`--rokbot-${name}: url\\("data:image/svg\\+xml,([^"]+)"\\);`).exec(css)?.[1] ?? '');

test('phones: the toggle stays in the top-right header beside New Bot, the bottom row is as before', () => {
  // No phone rule takes the toggle out of the header (sand-agents-sidebar__new-actions), where the
  // official round header button style applies to it as to New Bot.
  for (const at of css.matchAll(/html\.rokbot-phone[^{}]*rokbot-list-mode-toggle[^{}]*\{([^}]*)\}/g)) {
    assert.doesNotMatch(at[1], /position|left:|right:|top:|bottom:/, at[0]);
  }
  assert.match(css, /html\.rokbot-phone :is\(\.rokbot-nav-back, \.sand-agents-sidebar__new-actions \.sand-kit-icon-button:not\(\.sand-agents-sidebar__search\)/);
  assert.doesNotMatch(css, /rokbot-list-mode-toggle ~/);
  assert.match(rule(`html.rokbot-phone button.sand-agents-sidebar__search${X4}`), /left: 64px !important/);
});

test('phones: the pressed toggle keeps the official selected tint', () => {
  const pressed = rule(`${TOGGLE}[aria-pressed="true"]${X4}`);
  assert.match(pressed, /--sand-bg-accent-secondary/);
  assert.match(pressed, /color: var\(--sand-text-accent-primary\) !important/);
});

test('phones: the wind chime is drawn as a copper bell in the theme colour, outlined off and filled on', () => {
  assert.match(rule(`${TOGGLE} [data-rokbot-icon] > svg`), /display: none !important/);
  const glyph = rule(`${TOGGLE} [data-rokbot-icon]::before`);
  assert.match(glyph, /background: currentColor/);
  assert.match(glyph, /width: 16px/);
  assert.match(glyph, /mask: var\(--rokbot-copper-bell-icon\) center \/ 16px no-repeat/);
  assert.match(rule(`${TOGGLE}[aria-pressed="true"] [data-rokbot-icon]::before`), /mask-image: var\(--rokbot-copper-bell-on-icon\)/);
  const off = icon('copper-bell-icon'), on = icon('copper-bell-on-icon');
  for (const svg of [off, on]) {
    // The official 16 px grid and ~1.3 px stroke; hanging loop, body with an arched lip, clapper.
    assert.match(svg, /viewBox='0 0 16 16'/);
    assert.match(svg, /stroke-width='1\.3'/);
    assert.match(svg, /<circle cx='8' cy='2\.1' r='1'\/>/, 'hanging loop');
    assert.match(svg, /Q8 9\.9 3\.1 11\.3/, 'arched lip');
    assert.match(svg, /M8 10\.7V12\.6/, 'clapper');
    assert.doesNotMatch(svg, /#[0-9a-f]{3,6}|rgb|copper|orange/i, 'no fixed colour: the mask takes the theme colour');
  }
  assert.doesNotMatch(off, /fill='black' mask/);
  assert.match(on, /fill='black' mask='url\(#b\)'/, 'the body fills in while on');
});

test('phones: the bottom controls stay above the official list rows (z-index 10)', () => {
  for (const selector of [
    `html.rokbot-phone button.sand-agents-sidebar__search${X4}`,
    `html.rokbot-phone .sand-agents-sidebar__footer button:not([aria-haspopup="menu"])${X4}`,
  ]) {
    const z = Number(/z-index: (\d+) !important/.exec(rule(selector))?.[1]);
    assert.ok(z > 10, `${selector}: z-index ${z}`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = rel => readFile(new URL(`../server/public/${rel}`, import.meta.url), 'utf8');
const emoji = /\p{Extended_Pictographic}/u;

test('model routing page builds Sand drop-downs instead of native <select> controls', async () => {
  const model = await read('model.js');
  assert.doesNotMatch(model, /createElement\(\s*['"]select['"]\s*\)/, 'model.js must not create native selects');
  assert.doesNotMatch(model, /<select\b/i, 'model.js must not render native select markup');
  assert.match(model, /import \{[^}]*\bdropdown\b[^}]*\} from '\.\/ui\.js'/);
  // Every former select site (provider format/provider, default + fallback route, adaptive tiers, scenarios, catalog).
  assert.ok((model.match(/\bdropdown\(/g) ?? []).length >= 10, 'all route, scenario, tier and dialog pickers use dropdown()');
  // The select-like surface the page relies on is kept, so callers did not have to change.
  for (const usage of ['profileSelect.dataset.scenario', 'profileSelect.dataset.adaptiveTier', 'catalogSelect.hidden = true', '.onchange = () =>', 'replaceChildren(...values.map(([value, label]) => new Option('])
    assert.ok(model.includes(usage), usage);
});

test('dropdown() keeps the <select> interface and follows the menu() popover pattern', async () => {
  const ui = await read('ui.js');
  assert.match(ui, /export function dropdown\(/);
  assert.match(ui, /customElements\.define\('sand-select', SandSelect\)/);
  assert.match(ui, /static formAssociated = true/);
  for (const member of ['get value()', 'set value(', 'get options()', 'get selectedIndex()', 'get disabled()', 'set disabled(', 'get name()', 'formResetCallback()'])
    assert.ok(ui.includes(member), member);
  assert.match(ui, /new Event\('change', \{ bubbles: true \}\)/);
  assert.match(ui, /list\.popover = 'auto'/);
  assert.match(ui, /setAttribute\('role', 'listbox'\)/);
  assert.match(ui, /setAttribute\('role', 'combobox'\)/);
  assert.match(ui, /aria-activedescendant/);
  assert.match(ui, /aria-selected/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Home', 'End']) assert.ok(ui.includes(`'${key}'`), key);
  assert.match(ui, /icon\('check'\)/, 'the chosen row shows a check mark');
  assert.match(ui, /OPTGROUP/, 'optgroup labels render as group headings');
  assert.match(await read('icons.js'), /\bcheck: '/);
  // Importing ui.js in a DOM-less runtime must stay safe.
  assert.match(ui, /class SandSelect extends \(globalThis\.HTMLElement \?\? class \{\}\)/);
});

test('Sand select styles use design tokens so light and dark themes both apply', async () => {
  const css = await read('components.css'), tokens = await read('tokens.css');
  const block = css.slice(css.indexOf('/* Sand select'));
  assert.ok(block.length > 100, 'components.css has the Sand select block');
  for (const selector of ['sand-select {', 'sand-select::part(label)', 'sand-select[disabled]', '.select-menu {', '.select-option', '.select-option.active', '.select-check', '.select-group-label'])
    assert.ok(block.includes(selector), selector);
  assert.match(block, /max-height: 320px;[\s\S]*overflow-y: auto/, 'long lists scroll');
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens, not literals');
  for (const variable of new Set(block.match(/--sand-[a-z0-9-]+/g)))
    for (const theme of [tokens.slice(0, tokens.indexOf('[data-theme="dark"]')), tokens.slice(tokens.indexOf('[data-theme="dark"]'))])
      assert.ok(theme.includes(`${variable}:`), `${variable} is defined for both themes`);
});

test('Sand select surfaces stay free of emoji and of the upstream product name', async () => {
  for (const file of ['ui.js', 'model.js', 'components.css']) {
    const source = await read(file);
    assert.doesNotMatch(source, emoji, `${file} has no emoji`);
    assert.doesNotMatch(source, /grok/i, `${file} has no upstream product name`);
  }
});

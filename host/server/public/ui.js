import { t, locale } from './i18n.js';
import { icon, isBuiltinIcon } from './icons.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const all = (selector, root = document) => [...root.querySelectorAll(selector)];

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch {}
  }
  const active = document.activeElement, field = document.createElement('textarea');
  field.value = value; field.className = 'sr-only';
  (document.querySelector('dialog[open]') ?? document.body).append(field);
  try {
    field.select();
    if (!document.execCommand('copy')) throw new Error(t('浏览器未允许复制，请选择文字后复制'));
  } finally { field.remove(); active?.focus({ preventScroll: true }); }
}

export const date = (value) => value
  ? new Date(value).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  : t('暂无记录');

export function errorText(selector, error) {
  const element = $(selector);
  element.textContent = error.message;
  element.hidden = false;
}

export async function fileText(input, limit = 32 * 1024) {
  const file = input.files[0];
  if (!file) return undefined;
  if (file.size > limit) throw new Error(t('凭证文件过大，请选择正确的 PEM 或 p8 文件'));
  return file.text();
}

/** Disables a control while async work runs and restores its label afterwards. */
export async function busy(control, work) {
  if (control.disabled) return;
  const label = control.tagName === 'BUTTON' ? control.innerHTML : null;
  control.disabled = true;
  if (label !== null && !control.classList.contains('icon-btn')) control.textContent = t('处理中…');
  try { return await work(); }
  finally { control.disabled = false; if (label !== null) control.innerHTML = label; }
}

export function button(label, { variant = '', size = '', iconName, onClick, type = 'button' } = {}) {
  const element = node('button', ['btn', variant && `btn-${variant}`, size && `btn-${size}`].filter(Boolean).join(' '));
  element.type = type;
  element.innerHTML = iconName ? icon(iconName) : '';
  element.append(label);
  if (onClick) element.onclick = onClick;
  return element;
}

export function iconButton(name, label, onClick) {
  const element = node('button', 'icon-btn');
  element.type = 'button'; element.innerHTML = icon(name);
  element.setAttribute('aria-label', label); element.title = label;
  if (onClick) element.onclick = onClick;
  return element;
}

export function empty(title, message = '') {
  const element = node('div', 'empty');
  element.append(node('strong', '', title));
  if (message) element.append(node('span', '', message));
  return element;
}

export function status(text, tone = '') {
  const element = node('span', 'status', text);
  if (tone) element.dataset.tone = tone;
  return element;
}

export function badge(text, tone = '') {
  const element = node('span', 'badge', text);
  if (tone) element.dataset.tone = tone;
  return element;
}

export function toggle(checked, label) {
  const input = document.createElement('input');
  input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = checked;
  input.setAttribute('aria-label', label);
  return input;
}

/** A list row: built-in icon name, image, title with badges, meta lines and trailing actions. */
export function item({ icon: iconName, tile, image, title, badges = [], meta = [], description, actions = [] }) {
  const row = node('div', 'item'), lead = node('span', 'item-icon'), copy = node('div', 'item-copy');
  if (image) { const img = document.createElement('img'); img.src = image; img.alt = ''; lead.append(img); }
  else if (isBuiltinIcon(iconName)) lead.innerHTML = icon(iconName);
  else lead.textContent = [...(tile || title || '·')][0].toUpperCase();
  const heading = node('div', 'item-title'); heading.append(node('span', '', title), ...badges);
  copy.append(heading);
  if (description) copy.append(node('p', 'item-desc', description));
  for (const line of meta.filter(Boolean)) copy.append(node('p', 'item-meta', line));
  const trailing = node('div', 'item-actions'); trailing.append(...actions);
  row.append(lead, copy, trailing);
  return row;
}

let confirmDialog;
/** Shared confirmation dialog for destructive or disruptive actions. Resolves true when accepted. */
export function confirmAction({ title, message = '', action, danger = true }) {
  if (!confirmDialog) {
    confirmDialog = node('dialog', 'dialog');
    confirmDialog.id = 'confirm-dialog';
    confirmDialog.innerHTML = `<form method="dialog"><div class="dialog-head"><h2></h2></div><div class="dialog-body"><p class="hint"></p></div>
      <div class="dialog-foot"><button class="btn" value="cancel"></button><button class="btn" id="confirm-accept" value="confirm"></button></div></form>`;
    document.body.append(confirmDialog);
  }
  $('h2', confirmDialog).textContent = title;
  $('.hint', confirmDialog).textContent = message;
  $('.dialog-body', confirmDialog).hidden = !message;
  $('[value=cancel]', confirmDialog).textContent = t('取消');
  const accept = $('#confirm-accept', confirmDialog);
  accept.textContent = action; accept.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
  return new Promise(resolve => confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirm'), { once: true }));
}

/** Wires a dialog's [data-close] buttons and returns it. */
export function dialog(element) {
  for (const control of all('[data-close]', element)) control.addEventListener('click', () => element.close());
  return element;
}

let openMenu;
/** Overflow menu for secondary row actions; entries are { label, run, danger, disabled }. */
export function menu(label, entries) {
  const trigger = iconButton('more', label);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.addEventListener('click', () => {
    openMenu?.remove();
    const list = node('div', 'menu');
    list.setAttribute('role', 'menu'); list.popover = 'auto';
    for (const entry of entries.filter(Boolean)) {
      const option = node('button', `menu-item${entry.danger ? ' danger' : ''}`, entry.label);
      option.type = 'button'; option.setAttribute('role', 'menuitem'); option.disabled = Boolean(entry.disabled);
      option.addEventListener('click', () => { list.hidePopover(); entry.run(trigger); });
      list.append(option);
    }
    list.addEventListener('toggle', event => { if (event.newState === 'closed') list.remove(); });
    (trigger.closest('dialog[open]') ?? document.body).append(list);
    list.showPopover();
    const anchor = trigger.getBoundingClientRect(), width = list.offsetWidth, height = list.offsetHeight;
    list.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
    list.style.top = `${anchor.bottom + 4 + height > innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : anchor.bottom + 4}px`;
    list.querySelector('button:not(:disabled)')?.focus();
    openMenu = list;
  });
  return trigger;
}

/** Replaces the browser's file control with a Sand button and the chosen file name. */
export function filePicker(input) {
  const wrap = node('span', 'file-picker'), choose = button(t('选择文件'), { size: 'sm' }), name = node('span', 'file-name');
  const update = () => { name.textContent = input.files?.[0]?.name ?? t('尚未选择文件'); };
  input.replaceWith(wrap); input.hidden = true; wrap.append(input, choose, name);
  choose.onclick = () => input.click();
  input.addEventListener('change', update);
  input.form?.addEventListener('reset', () => setTimeout(update));
  update();
  return update;
}

let selectSerial = 0;
/**
 * Sand drop-down that stands in for a native <select>: it keeps <option>/<optgroup> children and the
 * select surface (value, options, selectedIndex, name, disabled, change/input events) so callers can
 * keep treating it like one, while the open list is a Sand popover with a check on the chosen row.
 */
class SandSelect extends (globalThis.HTMLElement ?? class {}) {
  static formAssociated = true;
  #internals = this.attachInternals?.();
  #label; #list = null; #active = -1; #wasOpen = false; #typed = ''; #typedAt = 0; #onViewportChange = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    this.#label = document.createElement('span');
    this.#label.setAttribute('part', 'label');
    root.append(this.#label);
    new MutationObserver(() => { this.#sync(); if (this.#list) this.#renderList(); })
      .observe(this, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['label', 'disabled', 'selected'] });
    this.addEventListener('pointerdown', () => { this.#wasOpen = Boolean(this.#list); });
    this.addEventListener('click', () => {
      const wasOpen = this.#wasOpen; this.#wasOpen = false;
      if (this.disabled || wasOpen) return;
      this.#open();
    });
    this.addEventListener('keydown', event => this.#keydown(event));
    this.addEventListener('blur', () => this.close());
  }

  static get observedAttributes() { return ['disabled']; }
  attributeChangedCallback() { this.#syncState(); if (this.disabled) this.close(); }
  connectedCallback() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'combobox');
    this.setAttribute('aria-haspopup', 'listbox');
    if (!this.hasAttribute('aria-expanded')) this.setAttribute('aria-expanded', 'false');
    this.#syncState(); this.#sync();
  }
  disconnectedCallback() { this.close(); }
  formResetCallback() {
    const options = this.options, fallback = options.find(option => option.defaultSelected) ?? null;
    for (const option of options) option.selected = option === fallback;
    this.#sync();
  }

  get type() { return 'select-one'; }
  get form() { return this.#internals?.form ?? null; }
  get name() { return this.getAttribute('name') ?? ''; }
  set name(value) { this.setAttribute('name', value); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }
  get options() { return [...this.querySelectorAll('option')]; }
  get length() { return this.options.length; }
  get selectedOptions() { const option = this.#selected(); return option ? [option] : []; }
  get selectedIndex() { return this.options.indexOf(this.#selected()); }
  set selectedIndex(index) { this.options.forEach((option, at) => { option.selected = at === index; }); this.#sync(); }
  get value() { return this.#selected()?.value ?? ''; }
  set value(value) {
    const options = this.options, match = options.find(option => option.value === String(value)) ?? null;
    for (const option of options) option.selected = option === match;
    this.#sync();
  }
  add(option) { this.append(option); }
  close() {
    if (!this.#list) return;
    const list = this.#list; this.#list = null;
    if (list.matches(':popover-open')) list.hidePopover();
    list.remove();
    removeEventListener('resize', this.#onViewportChange); removeEventListener('scroll', this.#onViewportChange, true);
    this.setAttribute('aria-expanded', 'false'); this.removeAttribute('aria-activedescendant');
  }

  #selected() {
    const options = this.options;
    return options.find(option => option.selected) ?? options.find(option => !option.disabled) ?? null;
  }
  #syncState() {
    if (!this.isConnected) return;
    this.tabIndex = this.disabled ? -1 : 0;
    if (this.disabled) this.setAttribute('aria-disabled', 'true'); else this.removeAttribute('aria-disabled');
  }
  #sync() {
    const option = this.#selected();
    this.#label.textContent = option?.label || option?.textContent || '';
    this.title = this.#label.textContent;
    this.#internals?.setFormValue?.(this.name ? this.value : null);
  }
  #choose(option) {
    this.close();
    this.focus({ preventScroll: true });
    if (!option || option.disabled || option === this.#selected()) return;
    for (const entry of this.options) entry.selected = entry === option;
    this.#sync();
    this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
  #renderList() {
    const list = this.#list, chosen = this.#selected(), options = this.options;
    list.replaceChildren();
    const row = option => {
      const index = options.indexOf(option), entry = node('div', 'select-option');
      entry.id = `${list.id}-${index}`; entry.dataset.index = index; entry.setAttribute('role', 'option');
      entry.setAttribute('aria-selected', String(option === chosen));
      if (option.disabled || option.parentElement?.disabled) entry.setAttribute('aria-disabled', 'true');
      const check = node('span', 'select-check'); check.innerHTML = option === chosen ? icon('check') : '';
      entry.append(check, node('span', 'select-option-label', option.label || option.textContent));
      entry.addEventListener('pointermove', () => this.#setActive(index, false));
      entry.addEventListener('click', () => { if (entry.getAttribute('aria-disabled') !== 'true') this.#choose(option); });
      return entry;
    };
    for (const child of this.children) {
      if (child.tagName === 'OPTION') list.append(row(child));
      else if (child.tagName === 'OPTGROUP') {
        const group = node('div', 'select-group'), groupId = `${list.id}-g${list.children.length}`;
        group.setAttribute('role', 'group'); group.setAttribute('aria-labelledby', groupId);
        const heading = node('div', 'select-group-label', child.label); heading.id = groupId;
        group.append(heading, ...[...child.querySelectorAll('option')].map(row));
        list.append(group);
      }
    }
    this.#setActive(this.#active, false);
  }
  #enabled() {
    return this.options.map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.disabled && !option.parentElement?.disabled).map(({ index }) => index);
  }
  #setActive(index, scroll = true) {
    this.#active = index;
    if (!this.#list) return;
    for (const entry of this.#list.querySelectorAll('.select-option')) entry.classList.toggle('active', Number(entry.dataset.index) === index);
    const current = this.#list.querySelector(`[data-index="${index}"]`);
    if (current) { this.setAttribute('aria-activedescendant', current.id); if (scroll) current.scrollIntoView({ block: 'nearest' }); }
    else this.removeAttribute('aria-activedescendant');
  }
  #open() {
    if (this.#list || this.disabled) return;
    const list = node('div', 'select-menu');
    list.id = `sand-select-${++selectSerial}`; list.setAttribute('role', 'listbox'); list.popover = 'auto';
    const name = this.getAttribute('aria-label'); if (name) list.setAttribute('aria-label', name);
    list.addEventListener('pointerdown', event => event.preventDefault());
    list.addEventListener('toggle', event => { if (event.newState === 'closed' && this.#list === list) this.close(); });
    this.#list = list;
    this.#active = this.selectedIndex;
    this.#renderList();
    (this.closest('dialog[open]') ?? document.body).append(list);
    list.showPopover();
    this.setAttribute('aria-controls', list.id); this.setAttribute('aria-expanded', 'true');
    const anchor = this.getBoundingClientRect(), width = Math.max(anchor.width, list.offsetWidth);
    const below = innerHeight - anchor.bottom - 12, above = anchor.top - 12, up = below < Math.min(list.scrollHeight, 200) && above > below;
    list.style.minWidth = `${anchor.width}px`;
    list.style.maxHeight = `${Math.max(120, Math.min(320, up ? above : below))}px`;
    list.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
    list.style.top = up ? `${Math.max(8, anchor.top - 4 - list.offsetHeight)}px` : `${anchor.bottom + 4}px`;
    this.#setActive(this.#active);
    this.#onViewportChange = event => { if (event.type === 'resize' || !list.contains(event.target)) this.close(); };
    addEventListener('resize', this.#onViewportChange); addEventListener('scroll', this.#onViewportChange, true);
  }
  #keydown(event) {
    if (this.disabled || event.altKey && !['ArrowDown', 'ArrowUp'].includes(event.key) || event.ctrlKey || event.metaKey) return;
    const enabled = this.#enabled(), open = Boolean(this.#list);
    const move = to => { event.preventDefault(); if (!open) this.#open(); if (to !== undefined) this.#setActive(to); };
    const at = enabled.indexOf(this.#active);
    switch (event.key) {
      case 'ArrowDown': return open ? move(enabled[Math.min(enabled.length - 1, at + 1)] ?? enabled[0]) : move();
      case 'ArrowUp': return open ? move(enabled[Math.max(0, at - 1)] ?? enabled[0]) : move();
      case 'Home': return move(enabled[0]);
      case 'End': return move(enabled.at(-1));
      case 'PageDown': return move(enabled[Math.min(enabled.length - 1, Math.max(0, at) + 8)]);
      case 'PageUp': return move(enabled[Math.max(0, at - 8)]);
      case 'Enter': case ' ':
        if (event.key === ' ' && this.#typed && Date.now() - this.#typedAt < 600) break;
        event.preventDefault();
        if (open) this.#choose(this.options[this.#active]); else this.#open();
        return;
      case 'Escape': if (open) { event.preventDefault(); event.stopPropagation(); this.close(); } return;
      case 'Tab': if (open) this.close(); return;
    }
    if (event.key.length !== 1) return;
    const now = Date.now();
    this.#typed = now - this.#typedAt < 600 ? this.#typed + event.key.toLowerCase() : event.key.toLowerCase();
    this.#typedAt = now;
    const options = this.options, start = Math.max(0, at);
    const order = [...enabled.slice(start + (this.#typed.length === 1 ? 1 : 0)), ...enabled.slice(0, start + (this.#typed.length === 1 ? 1 : 0))];
    const found = order.find(index => (options[index].label || options[index].textContent).toLowerCase().startsWith(this.#typed));
    if (found !== undefined) move(found);
  }
}

/** Creates a Sand drop-down (see SandSelect) in place of document.createElement('select'). */
export function dropdown({ name, label, className } = {}) {
  if (!customElements.get('sand-select')) customElements.define('sand-select', SandSelect);
  const element = document.createElement('sand-select');
  if (name) element.name = name;
  if (label) element.setAttribute('aria-label', label);
  if (className) element.className = className;
  return element;
}

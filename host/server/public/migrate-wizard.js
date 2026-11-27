// "Migrate from Grok Bot" wizard, shared by the Host admin page and the desktop client window.
// A byte-identical copy lives at mac/clients/desktop/migrate-wizard.js (a test keeps them equal).
// It only talks to an adapter, so the admin page (cookie session) and the desktop client (IPC to
// the main process, device credential) drive the same screens:
//   adapter.list() -> { packages, tokens }
//   adapter.createToken({ label, scope }) -> token with prompt and uploadUrl
//   adapter.revokeToken(id), adapter.prompt({ tokenId, scope }) -> { prompt, uploadUrl }
//   adapter.preview(id), adapter.import(id, selection), adapter.discard(id)
//   adapter.copy(text)
//   adapter.sources: [{ id, title, description, actions: [{ label, primary, run(progress) }] }]
// Every string is Chinese, there are no emoji, and choices use the segmented control below rather
// than native drop-downs.

const SVG = {
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
};
const SOURCES = { admin: '网页上传', device: '桌面端', inbox: 'Bot 上传' };
const STATUS = { new: ['新建', 'mw-tone-accent'], imported: ['已迁移过，将补充新增内容', 'mw-tone-success'], conflict: ['同名冲突', 'mw-tone-warn'] };
const ACTIONS = { created: '已新建', updated: '已更新', overwritten: '已覆盖同名 Bot', skipped: '已跳过', failed: '失败' };
const POLICY = [['rename', '重命名'], ['skip', '跳过'], ['overwrite', '覆盖']];
const CONTENT = [
  ['memory', '记忆', '每个 Bot 的长期档案和日志记忆', true],
  ['skills', '技能', 'Bot 自己的技能和工作流', true],
  ['routines', '例程', '导入后全部暂停，检查后手动启用', true],
  ['files', '参考资料', '保存到对应 Bot 的资料库', true],
  ['chat', '聊天记录', '保存为资料库中的 Markdown 文件，仅供参考', false],
  ['userMemory', '共享用户记忆', '所有 Bot 共用的用户记忆', true],
  ['sharedSkills', '共享技能', '导入到 Host 技能目录，默认停用', true],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
function button(label, { primary = false, danger = false, small = false, onClick } = {}) {
  const node = el('button', ['mw-btn', primary && 'mw-btn-primary', danger && 'mw-btn-danger', small && 'mw-btn-sm'].filter(Boolean).join(' '), label);
  node.type = 'button';
  if (onClick) node.addEventListener('click', onClick);
  return node;
}
function badge(text, tone = '') { return el('span', `mw-badge ${tone}`.trim(), text); }
const when = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
function countsLine(counts) {
  if (!counts) return '';
  const parts = [[counts.bots, '个 Bot'], [counts.memory, '条记忆'], [counts.skills, '个技能'], [counts.routines, '个例程'],
    [counts.files, '个文件'], [counts.chatMessages, '条聊天记录'], [counts.userMemory, '条共享记忆']];
  const line = parts.filter(([value]) => value).map(([value, label]) => `${value} ${label}`);
  if (counts.detectedRoutines && !counts.routines) line.push(`识别到 ${counts.detectedRoutines} 个例程名称`);
  return line.join(' · ') || '没有可导入的内容';
}

/** Segmented single choice. Behaves like a radio group for keyboards and screen readers. */
export function segmented(options, value, onChange, label) {
  const group = el('div', 'mw-segmented');
  group.setAttribute('role', 'radiogroup');
  if (label) group.setAttribute('aria-label', label);
  const render = current => {
    group.replaceChildren(...options.map(([key, text]) => {
      const item = el('button', 'mw-segment', text);
      item.type = 'button'; item.setAttribute('role', 'radio');
      item.setAttribute('aria-checked', String(key === current)); item.tabIndex = key === current ? 0 : -1;
      item.addEventListener('click', () => { if (key !== current) { render(key); onChange(key); } });
      item.addEventListener('keydown', event => {
        const index = options.findIndex(([k]) => k === current);
        const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? options[(index + 1) % options.length]
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? options[(index + options.length - 1) % options.length] : null;
        if (next) { event.preventDefault(); render(next[0]); onChange(next[0]); group.querySelector('[aria-checked=true]')?.focus(); }
      });
      return item;
    }));
  };
  render(value);
  return group;
}
/** Checkbox row drawn with the wizard's own box. */
function checkRow(title, description, checked, onChange, { disabled = false } = {}) {
  const row = el('label', `mw-check${disabled ? ' mw-disabled' : ''}`), input = el('input');
  input.type = 'checkbox'; input.checked = checked; input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  const box = el('span', 'mw-box'); box.innerHTML = SVG.check; box.setAttribute('aria-hidden', 'true');
  const copy = el('span', 'mw-check-copy'); copy.append(el('span', 'mw-check-title', title));
  if (description) copy.append(el('span', 'mw-check-desc', description));
  row.append(input, box, copy);
  return row;
}

export function createMigrationWizard(root, adapter) {
  const toast = adapter.toast ?? (message => console.log(message));
  const state = { packages: [], tokens: [], scope: 'single', review: null };
  root.classList.add('mw');
  root.replaceChildren();
  const sources = el('section', 'mw-section'), prompt = el('section', 'mw-section'), pending = el('section', 'mw-section');
  const modal = el('div', 'mw-modal'); modal.hidden = true;
  root.append(sources, prompt, pending, modal);

  async function run(control, work) {
    if (control?.disabled) return;
    const label = control?.textContent;
    if (control) { control.disabled = true; control.textContent = '处理中…'; }
    try { return await work(); }
    catch (error) { toast(error?.message || '操作失败，请重试', true); }
    finally { if (control) { control.disabled = false; control.textContent = label; } }
  }
  const head = (section, title, description) => {
    const header = el('div', 'mw-section-head');
    header.append(el('h2', 'mw-title', title));
    section.replaceChildren(header);
    if (description) section.append(el('p', 'mw-desc', description));
    return header;
  };

  function renderSources() {
    head(sources, '方式一：一键物理迁移', '从本机 Grok Bot 的数据目录读取 Bot 列表、头像设置、侧栏分组、最近的聊天记录缓存和例程名称。只读取这些缓存文件，不修改原目录，也不读取登录凭据、Cookie 和密钥文件。记忆、技能和例程内容保存在 Grok Bot 云端，请配合方式二导出。');
    const list = el('div', 'mw-card');
    for (const source of adapter.sources ?? []) {
      const row = el('div', 'mw-row'), copy = el('div', 'mw-row-copy');
      copy.append(el('div', 'mw-row-title', source.title));
      if (source.description) copy.append(el('div', 'mw-row-meta', source.description));
      const progress = el('div', 'mw-progress'); progress.hidden = true;
      const bar = el('span'); progress.append(bar); copy.append(progress);
      const actions = el('div', 'mw-row-actions');
      for (const action of source.actions) {
        const control = button(action.label, { primary: action.primary, small: true });
        control.addEventListener('click', () => run(control, async () => {
          progress.hidden = false; bar.style.width = '0%';
          const result = await action.run(value => { bar.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`; });
          progress.hidden = true;
          if (result?.id) { toast(`已加入待导入：${countsLine(result.counts)}`); await refresh(); openReview(result.id); }
        }));
        actions.append(control);
      }
      row.append(copy, actions); list.append(row);
    }
    if (!(adapter.sources ?? []).length) list.append(el('div', 'mw-empty', '这里不能读取本机文件。请在桌面客户端中使用一键迁移，或上传打包好的数据目录。'));
    sources.append(list);
  }

  function renderPrompt() {
    head(prompt, '方式二：让 Grok Bot 导出', '把迁移 prompt 发给 Grok Bot 里的每个 Bot（或一个能看到所有 Bot 的总管 Bot）。它会按 RokBot 的格式整理档案、记忆、技能、例程和参考资料，上传到下面的一次性地址；上传地址 24 小时内有效，可多次上传，随时可以撤销。如果它访问不了这个地址，会把文件发给你，你再在上面手动上传。');
    const controls = el('div', 'mw-inline');
    controls.append(el('span', 'mw-label', '导出范围'), segmented([['single', '当前 Bot'], ['all', '所有 Bot']], state.scope, value => { state.scope = value; }, '导出范围'));
    const create = button('生成上传地址并复制 prompt', { primary: true });
    create.addEventListener('click', () => run(create, async () => {
      const token = await adapter.createToken({ label: state.scope === 'all' ? '所有 Bot' : '单个 Bot', scope: state.scope });
      await adapter.copy(token.prompt); toast('已复制迁移 prompt，发给 Grok Bot 即可'); await refresh();
    }));
    const offline = button('只复制 prompt（不带上传地址）');
    offline.addEventListener('click', () => run(offline, async () => { const value = await adapter.prompt({ scope: state.scope }); await adapter.copy(value.prompt); toast('已复制，Bot 会把文件发给你'); }));
    controls.append(create, offline);
    prompt.append(controls);
    const list = el('div', 'mw-card');
    const tokens = state.tokens.slice(0, 8);
    if (!tokens.length) list.append(el('div', 'mw-empty', '还没有上传地址。'));
    for (const token of tokens) {
      const row = el('div', `mw-row${token.active ? '' : ' mw-muted'}`), copy = el('div', 'mw-row-copy');
      const title = el('div', 'mw-row-title', token.label);
      title.append(token.active ? badge('有效', 'mw-tone-success') : badge(token.revokedAt ? '已撤销' : '已过期'));
      copy.append(title, el('div', 'mw-row-meta', `${token.active ? `有效期至 ${when(token.expiresAt)}` : `创建于 ${when(token.createdAt)}`} · 已上传 ${token.uploads} 次${token.lastUploadAt ? `，最近 ${when(token.lastUploadAt)}` : ''}`));
      const actions = el('div', 'mw-row-actions');
      if (token.active) {
        const copyPrompt = button('复制 prompt', { small: true }), copyUrl = button('复制地址', { small: true }), revoke = button('撤销', { small: true, danger: true });
        copyPrompt.addEventListener('click', () => run(copyPrompt, async () => { await adapter.copy((await adapter.prompt({ tokenId: token.id, scope: state.scope })).prompt); toast('已复制迁移 prompt'); }));
        copyUrl.addEventListener('click', () => run(copyUrl, async () => { await adapter.copy((await adapter.prompt({ tokenId: token.id })).uploadUrl); toast('已复制上传地址'); }));
        revoke.addEventListener('click', () => run(revoke, async () => { await adapter.revokeToken(token.id); toast('上传地址已撤销'); await refresh(); }));
        actions.append(copyPrompt, copyUrl, revoke);
      }
      row.append(copy, actions); list.append(row);
    }
    prompt.append(list);
  }

  function renderPending() {
    const header = head(pending, '待导入', '上传或 Bot 发来的迁移包会先放在这里。导入前可以预览、勾选内容并处理同名冲突；同一份数据重复导入不会产生重复的 Bot、记忆、技能或例程。');
    const reload = button('刷新', { small: true });
    reload.addEventListener('click', () => run(reload, refresh));
    header.append(reload);
    const list = el('div', 'mw-card');
    if (!state.packages.length) list.append(el('div', 'mw-empty', '暂无待导入的迁移包。'));
    for (const item of state.packages) {
      const row = el('div', 'mw-row'), copy = el('div', 'mw-row-copy'), title = el('div', 'mw-row-title', item.label);
      title.append(badge(SOURCES[item.source] ?? item.source), item.status === 'imported' ? badge('已导入', 'mw-tone-success') : badge('待导入', 'mw-tone-accent'));
      copy.append(title, el('div', 'mw-row-meta', `${when(item.createdAt)} · ${countsLine(item.counts)}`));
      const actions = el('div', 'mw-row-actions');
      const open = button(item.status === 'imported' ? '再次导入' : '预览并导入', { small: true, primary: item.status !== 'imported' });
      open.addEventListener('click', () => run(open, () => openReview(item.id)));
      actions.append(open);
      if (item.report) { const report = button('查看报告', { small: true }); report.addEventListener('click', () => showModal('导入结果', renderReport(item.report), [button('关闭', { primary: true, onClick: closeModal })])); actions.append(report); }
      const remove = button('删除', { small: true, danger: true });
      remove.addEventListener('click', () => run(remove, async () => { await adapter.discard(item.id); await refresh(); }));
      actions.append(remove);
      row.append(copy, actions); list.append(row);
    }
    pending.append(list);
  }

  // ---- Review modal ----------------------------------------------------------------------------
  function closeModal() { modal.hidden = true; modal.replaceChildren(); state.review = null; document.removeEventListener('keydown', escape); }
  function escape(event) { if (event.key === 'Escape' && !modal.hidden) closeModal(); }
  function showModal(title, body, footer, steps) {
    const panel = el('div', 'mw-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title);
    const top = el('div', 'mw-panel-head'); top.append(el('h2', 'mw-title', title));
    const close = el('button', 'mw-icon'); close.type = 'button'; close.innerHTML = SVG.close; close.setAttribute('aria-label', '关闭'); close.addEventListener('click', closeModal);
    top.append(close);
    panel.append(top);
    if (steps) {
      const bar = el('ol', 'mw-steps');
      steps.labels.forEach((label, index) => { const step = el('li', index === steps.current ? 'mw-step mw-step-on' : index < steps.current ? 'mw-step mw-step-done' : 'mw-step', `${index + 1}. ${label}`); bar.append(step); });
      panel.append(bar);
    }
    const content = el('div', 'mw-panel-body'); content.append(body); panel.append(content);
    const foot = el('div', 'mw-panel-foot'); foot.append(...footer); panel.append(foot);
    modal.replaceChildren(panel); modal.hidden = false;
    document.addEventListener('keydown', escape);
    panel.querySelector('.mw-panel-foot .mw-btn-primary, .mw-panel-foot .mw-btn')?.focus({ preventScroll: true });
  }

  async function openReview(packageId) {
    const preview = await adapter.preview(packageId);
    const options = Object.fromEntries(CONTENT.map(([key, , , on]) => [key, on]));
    const bots = Object.fromEntries(preview.bots.map(bot => [bot.key, { include: true, conflict: 'rename' }]));
    state.review = { preview, options, bots, policy: 'rename', step: 0 };
    renderStep();
  }
  const STEPS = ['选择内容', '处理冲突', '导入结果'];
  function renderStep() {
    const review = state.review;
    if (!review) return;
    if (review.step === 0) return stepSelect(review);
    if (review.step === 1) return stepConflicts(review);
  }
  function stepSelect(review) {
    const { preview } = review, body = el('div', 'mw-stack');
    body.append(el('p', 'mw-desc', `${preview.label} · ${countsLine(preview.counts)}`));
    if (!preview.hostAvailable) body.append(el('p', 'mw-alert', 'Host 暂不可用，无法检查同名 Bot。请稍后重试导入。'));
    const kinds = el('div', 'mw-grid');
    for (const [key, title, description] of CONTENT) {
      const available = key === 'userMemory' ? preview.userMemory > 0 : key === 'sharedSkills' ? preview.skills.length > 0
        : preview.bots.some(bot => bot.counts[key === 'chat' ? 'chat' : key] > 0);
      kinds.append(checkRow(title, available ? description : '这份数据中没有', available && review.options[key], value => { review.options[key] = value; }, { disabled: !available }));
    }
    body.append(el('h3', 'mw-subtitle', '迁移哪些内容'), kinds);
    const botHead = el('div', 'mw-section-head'); botHead.append(el('h3', 'mw-subtitle', `Bot（${preview.bots.length}）`));
    const toggles = el('div', 'mw-row-actions');
    const list = el('div', 'mw-card mw-scroll');
    const all = button('全选', { small: true, onClick: () => { for (const key in review.bots) review.bots[key].include = true; stepSelect(review); } });
    const none = button('全不选', { small: true, onClick: () => { for (const key in review.bots) review.bots[key].include = false; stepSelect(review); } });
    toggles.append(all, none); botHead.append(toggles);
    for (const bot of preview.bots) {
      const [label, tone] = STATUS[bot.status] ?? [bot.status, ''];
      const details = [bot.counts.memory && `${bot.counts.memory} 记忆`, bot.counts.skills && `${bot.counts.skills} 技能`, bot.counts.routines && `${bot.counts.routines} 例程`,
        bot.counts.files && `${bot.counts.files} 文件`, bot.counts.chat && `${bot.counts.chat} 条聊天`, !bot.counts.routines && bot.counts.detectedRoutines && `${bot.counts.detectedRoutines} 个例程名称`].filter(Boolean).join(' · ');
      const row = checkRow(bot.name, [bot.title || bot.description, details].filter(Boolean).join(' · '), review.bots[bot.key].include, value => { review.bots[bot.key].include = value; });
      row.querySelector('.mw-check-title').append(badge(label, tone));
      list.append(row);
    }
    if (!preview.bots.length) list.append(el('div', 'mw-empty', '这份数据中没有 Bot。'));
    body.append(botHead, list);
    if (preview.warnings?.length) {
      const notes = el('details', 'mw-details'); notes.append(el('summary', '', `解析提示（${preview.warnings.length}）`));
      const ul = el('ul', 'mw-list'); for (const warning of preview.warnings) ul.append(el('li', '', warning)); notes.append(ul); body.append(notes);
    }
    showModal('从 Grok Bot 迁移', body, [button('取消', { onClick: closeModal }), button('下一步', { primary: true, onClick: () => { review.step = 1; renderStep(); } })], { labels: STEPS, current: 0 });
  }
  function stepConflicts(review) {
    const { preview } = review, body = el('div', 'mw-stack');
    const selected = preview.bots.filter(bot => review.bots[bot.key].include);
    const conflicts = selected.filter(bot => bot.status === 'conflict');
    body.append(el('h3', 'mw-subtitle', '同名 Bot'));
    if (!conflicts.length) body.append(el('p', 'mw-desc', '没有同名冲突。'));
    else {
      const all = el('div', 'mw-inline');
      all.append(el('span', 'mw-label', '全部设为'), segmented(POLICY, review.policy, value => { review.policy = value; for (const bot of conflicts) review.bots[bot.key].conflict = value; stepConflicts(review); }, '冲突处理方式'));
      body.append(all);
      const list = el('div', 'mw-card mw-scroll');
      for (const bot of conflicts) {
        const row = el('div', 'mw-row'), copy = el('div', 'mw-row-copy'), choice = review.bots[bot.key].conflict;
        copy.append(el('div', 'mw-row-title', bot.name), el('div', 'mw-row-meta', choice === 'rename' ? `新建为「${bot.renameTo}」` : choice === 'skip' ? '保留现有 Bot，不导入这个' : `合并到现有的「${bot.target?.name}」并更新其资料`));
        row.append(copy, segmented(POLICY, choice, value => { review.bots[bot.key].conflict = value; stepConflicts(review); }, `${bot.name} 的处理方式`));
        list.append(row);
      }
      body.append(list);
    }
    const updates = selected.filter(bot => bot.status === 'imported');
    if (updates.length) body.append(el('p', 'mw-desc', `${updates.length} 个 Bot 之前迁移过，这次只补充新增的记忆、技能、例程和文件，不会重复创建。`));
    const secrets = [...new Set([...preview.secrets.map(secret => secret.name), ...selected.flatMap(bot => bot.secrets)])];
    body.append(el('h3', 'mw-subtitle', '需要你重新填写'));
    if (!secrets.length) body.append(el('p', 'mw-desc', '没有发现需要重新填写的密钥或授权。'));
    else { const ul = el('ul', 'mw-list'); for (const name of secrets) ul.append(el('li', '', name)); body.append(el('p', 'mw-desc', '密钥、令牌和登录状态不会迁移，导入后请在 RokBot 中重新填写或授权：'), ul); }
    body.append(el('p', 'mw-note', '导入的内容只作为数据保存，不会执行其中的任何指令；例程导入后全部暂停，需要你检查后手动启用。'));
    const start = button('开始导入', { primary: true });
    start.addEventListener('click', () => run(start, async () => {
      const selection = { conflict: review.policy, userMemory: review.options.userMemory, skills: review.options.sharedSkills ? preview.skills.map(skill => skill.name) : [], bots: {} };
      for (const bot of preview.bots) {
        const choice = review.bots[bot.key];
        selection.bots[bot.key] = { include: choice.include, conflict: choice.conflict, memory: review.options.memory, skills: review.options.skills,
          routines: review.options.routines, files: review.options.files, chat: review.options.chat };
      }
      const report = await adapter.import(preview.id, selection);
      await refresh();
      showModal('从 Grok Bot 迁移', renderReport(report), [button('完成', { primary: true, onClick: closeModal })], { labels: STEPS, current: 2 });
    }));
    showModal('从 Grok Bot 迁移', body, [button('上一步', { onClick: () => { review.step = 0; renderStep(); } }), start], { labels: STEPS, current: 1 });
  }

  function renderReport(report) {
    const body = el('div', 'mw-stack');
    const totals = { created: 0, updated: 0, overwritten: 0, skipped: 0, failed: 0 };
    for (const bot of report.bots) totals[bot.action] = (totals[bot.action] ?? 0) + 1;
    const sum = key => report.bots.reduce((total, bot) => total + (bot.added?.[key] ?? 0), 0);
    const stats = el('div', 'mw-stats');
    for (const [value, label] of [[totals.created, '新建 Bot'], [totals.updated + totals.overwritten, '更新 Bot'], [sum('memory'), '新增记忆'], [sum('skills') + (report.skills?.added ?? 0), '新增技能'],
      [sum('routines'), '新增例程（已暂停）'], [report.files?.added ?? 0, '新增文件'], [report.userMemory?.added ?? 0, '新增共享记忆']]) {
      const stat = el('div', 'mw-stat'); stat.append(el('strong', '', String(value)), el('span', '', label)); stats.append(stat);
    }
    body.append(stats);
    const list = el('div', 'mw-card mw-scroll');
    for (const bot of report.bots) {
      const row = el('div', 'mw-row'), copy = el('div', 'mw-row-copy'), title = el('div', 'mw-row-title', bot.targetName && bot.targetName !== bot.name ? `${bot.name} → ${bot.targetName}` : bot.name);
      title.append(badge(ACTIONS[bot.action] ?? bot.action, bot.action === 'failed' ? 'mw-tone-danger' : bot.action === 'skipped' ? '' : 'mw-tone-success'));
      const meta = bot.error ?? bot.reason ?? (bot.added ? `记忆 +${bot.added.memory} · 技能 +${bot.added.skills} · 例程 +${bot.added.routines}` : '');
      copy.append(title, el('div', 'mw-row-meta', meta));
      for (const warning of bot.warnings ?? []) copy.append(el('div', 'mw-row-meta mw-warn', warning));
      row.append(copy); list.append(row);
    }
    body.append(list);
    if (report.secrets?.length) { body.append(el('h3', 'mw-subtitle', '需要你重新填写')); const ul = el('ul', 'mw-list'); for (const name of report.secrets) ul.append(el('li', '', name)); body.append(ul); }
    if (report.notMigrated?.length) { body.append(el('h3', 'mw-subtitle', '没有迁移')); const ul = el('ul', 'mw-list'); for (const value of report.notMigrated) ul.append(el('li', '', value)); body.append(ul); }
    if (report.skills?.names?.length) body.append(el('p', 'mw-note', `共享技能已导入但处于停用状态：${report.skills.names.join('、')}。可在「技能」中启用。`));
    if (report.warnings?.length) {
      const notes = el('details', 'mw-details'); notes.append(el('summary', '', `提示（${report.warnings.length}）`));
      const ul = el('ul', 'mw-list'); for (const warning of report.warnings) ul.append(el('li', '', warning)); notes.append(ul); body.append(notes);
    }
    return body;
  }

  async function refresh() {
    const value = await adapter.list();
    state.packages = value.packages ?? []; state.tokens = value.tokens ?? [];
    renderPrompt(); renderPending();
  }
  renderSources(); renderPrompt(); renderPending();
  return { refresh, openReview, setSources(next) { adapter.sources = next; renderSources(); }, close: closeModal };
}

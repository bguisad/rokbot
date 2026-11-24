
// Session list arrangement, appended to the original 1.2.3 app module (desktop and Web).
// "default" keeps the official sidebar: pinned Bots, the user's sections, row recency.
// "activity" lists Bots and groups by their last chat message, newest first, in three
// groups: waiting on you (a question, form or approval card, a handoff, or a running turn),
// unread, read. The choice and folded groups are kept in this client's localStorage.
// Signals follow the official client: awaitingUserResponse is "Needs attention", isRunning /
// isComposingMessage is "working", hasUnread / unreadThreadCount is "Unread". The Host adds
// pendingAction (open cards) and lastMessageAt (host/runtime/list-arrangement.mjs).
const ROK_LIST_STORAGE_KEY = 'rokbot.listArrangement.v1';
const ROK_LIST_MODES = ['default', 'activity'];
const ROK_LIST_GROUPS = [
  { id: 'rokbot:pending', kind: 'pending', zh: '待处理', en: 'Waiting on you' },
  { id: 'rokbot:unread', kind: 'unread', zh: '未读', en: 'Unread' },
  { id: 'rokbot:read', kind: 'read', zh: '已读', en: 'Read' },
];

function rokListIsGroupId(id) {
  return typeof id === 'string' && ROK_LIST_GROUPS.some(group => group.id === id);
}

function rokListNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** 0: waits on the user, 1: working, null: nothing pending. */
function rokListPendingRank(agent) {
  if (agent?.awaitingUserResponse != null || agent?.pendingAction != null) return 0;
  if (agent?.isRunning === true || agent?.isComposingMessage === true) return 1;
  return null;
}

function rokListIsUnread(agent) {
  return agent?.hasUnread === true || rokListNumber(agent?.unreadThreadCount) > 0;
}

/** When the last chat message was written; a Bot without messages ranks on its creation. */
function rokListLastMessageAt(agent) {
  const at = Math.max(rokListNumber(agent?.lastMessageAt), rokListNumber(agent?.lastActivityAt));
  return at > 0 ? at : rokListNumber(agent?.createdAt);
}

function rokListGroupOf(agent) {
  if (rokListPendingRank(agent) !== null) return 'pending';
  return rokListIsUnread(agent) ? 'unread' : 'read';
}

/** The agents in list order and the non-empty groups that hold them. */
function rokArrangeAgents(agents) {
  const rows = (Array.isArray(agents) ? agents : []).filter(agent => agent != null && typeof agent.id === 'string');
  const groupIndex = kind => ROK_LIST_GROUPS.findIndex(group => group.kind === kind);
  const keyed = rows.map((agent, index) => ({ agent, index, group: groupIndex(rokListGroupOf(agent)),
    rank: rokListPendingRank(agent) ?? 0, at: rokListLastMessageAt(agent) }));
  keyed.sort((a, b) => a.group - b.group || a.rank - b.rank || b.at - a.at || a.index - b.index);
  const ordered = keyed.map(item => item.agent);
  const groups = ROK_LIST_GROUPS.map((group, index) => ({ id: group.id, kind: group.kind,
    agentIds: keyed.filter(item => item.group === index).map(item => item.agent.id) })).filter(group => group.agentIds.length > 0);
  return { agents: ordered, groups };
}

function rokListGroupName(id, text) {
  const group = ROK_LIST_GROUPS.find(item => item.id === id);
  if (!group) return '';
  return typeof text === 'function' ? text(group.zh, group.en) : group.en;
}

/** Sidebar sections for the groups, in the shape of the official sections store. */
function rokListSections(groups, collapsed, text) {
  return groups.map(group => ({ id: group.id, name: rokListGroupName(group.id, text), agentIds: group.agentIds,
    isCollapsed: collapsed.includes(group.id) }));
}

function rokListParse(raw) {
  try {
    const value = JSON.parse(raw ?? 'null');
    const mode = ROK_LIST_MODES.includes(value?.mode) ? value.mode : 'default';
    const collapsed = Array.isArray(value?.collapsed) ? value.collapsed.filter(rokListIsGroupId) : [];
    return { mode, collapsed: [...new Set(collapsed)] };
  } catch {
    return { mode: 'default', collapsed: [] };
  }
}

/** One store per page: the mode and folded groups, saved in localStorage and shared across tabs. */
function rokCreateListStore(storage, events) {
  let state = rokListParse(storage?.getItem?.(ROK_LIST_STORAGE_KEY));
  const listeners = new Set();
  const publish = next => {
    if (next.mode === state.mode && next.collapsed.join('\n') === state.collapsed.join('\n')) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const save = next => {
    try { storage?.setItem?.(ROK_LIST_STORAGE_KEY, JSON.stringify(next)); } catch {}
    publish(next);
  };
  events?.addEventListener?.('storage', event => {
    if (event?.key === ROK_LIST_STORAGE_KEY) publish(rokListParse(event.newValue));
  });
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getMode: () => state.mode,
    setMode(mode) { if (ROK_LIST_MODES.includes(mode)) save({ ...state, mode }); },
    toggle() { save({ ...state, mode: state.mode === 'activity' ? 'default' : 'activity' }); },
    isCollapsed: id => state.collapsed.includes(id),
    setCollapsed(id, collapsed) {
      if (!rokListIsGroupId(id) || state.collapsed.includes(id) === Boolean(collapsed)) return;
      save({ ...state, collapsed: collapsed ? [...state.collapsed, id] : state.collapsed.filter(item => item !== id) });
    },
  };
}

function rokListStore() {
  const scope = globalThis;
  if (!scope.__rokListArrangement) {
    let storage = null;
    try { storage = scope.localStorage ?? null; } catch {}
    scope.__rokListArrangement = rokCreateListStore(storage, scope.window ?? null);
  }
  return scope.__rokListArrangement;
}

/** Section edits never reach the Host for the generated groups (rename, delete, move, assign). */
function rokListGuardEdits(edit) {
  if (edit == null || typeof edit !== 'object') return edit;
  const touchesGroup = value => rokListIsGroupId(value) || (Array.isArray(value) && value.some(rokListIsGroupId));
  const guarded = {};
  for (const key of Object.keys(edit)) {
    const value = edit[key];
    guarded[key] = typeof value === 'function'
      ? (...args) => (args.some(touchesGroup) ? null : value.apply(edit, args))
      : value;
  }
  return guarded;
}

/** The sidebar inputs for the chosen arrangement; "default" leaves them untouched. */
function rokArrangeSidebar(input, state, text) {
  if (state?.mode !== 'activity') return input;
  const { agents, groups } = rokArrangeAgents(input.visibleAgents);
  const store = rokListStore();
  const setSectionCollapsed = input.setSectionCollapsed;
  return {
    visibleAgents: agents,
    sidebarSections: rokListSections(groups, state.collapsed, text),
    setSectionCollapsed: (id, collapsed) => (rokListIsGroupId(id) ? store.setCollapsed(id, collapsed) : setSectionCollapsed?.(id, collapsed)),
    editSections: rokListGuardEdits(input.editSections),
  };
}

// React glue for the app module (X is its React).
function RokUseListArrangement() {
  const store = rokListStore();
  return X.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function RokUseArrangedSidebar(input) {
  const state = RokUseListArrangement();
  const { visibleAgents, sidebarSections, setSectionCollapsed, editSections } = input;
  return X.useMemo(() => rokArrangeSidebar({ visibleAgents, sidebarSections, setSectionCollapsed, editSections }, state, grokText),
    [state, visibleAgents, sidebarSections, setSectionCollapsed, editSections]);
}

// Settings reads the same store before the sidebar first renders.
try { rokListStore(); } catch {}

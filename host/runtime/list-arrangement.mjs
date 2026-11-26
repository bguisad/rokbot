// Fields the session list needs beyond the original summary, added to every Bot and group
// the gateway hands out (listAgents and the "agents" / "agent-upserted" events):
//
//   lastMessageAt  time of the newest chat message in the main transcript (either side),
//                  so the list can rank on the last history message, as the official
//                  `sand_sidebar_activity_recency` ranking does with real chat activity.
//   pendingAction  { kind: 'question' | 'approval', since, entryId } while the conversation shows
//                  a card the user can still act on: an approval card of a kind the official
//                  clients render (still "pending", not past its deadline), or the open question
//                  widget / form the Bot is waiting on. The original Host only raises
//                  `awaitingUserResponse` for a box handoff and auto-review, so these cards would
//                  otherwise not count as pending.
//
// rokbot.5b: a card only counts while the user can find and operate it. A question is no longer
// pending once the Bot has moved on (a later Bot message well after it, so it is not at the end of
// the chat any more), once a later answer or user message settles it, or when the widget cannot be
// rendered; approval cards only count for the official card kinds and until their deadline. A card
// that changes without a roster event (dismissed widget, decided approval) refreshes the Bot's row.
//
// Both fields are additive; clients that do not know them ignore them.

export const TRANSCRIPT_TAIL_LIMIT = 48;
const CACHE_MS = 1500;

const CHAT_KINDS = new Set(['message', 'send-message', 'user-attachment']);
// Approval cards the official clients render and count as pending (SAND AttentionItems
// .isPendingApproval): message type -> the field whose status is "pending" until decided.
const APPROVAL_FIELDS = new Map([
  ['auto-review-approval', 'approval'], ['meeting-join-consent', 'approval'], ['virtual-card-approval', 'approval'],
  ['cookie-origin-approval', 'approval'], ['publish-approval', 'approval'], ['local-tool-permission', 'ask'],
  ['connector-grant', 'ask'], ['x-money-challenge', 'challenge'],
]);
const QUESTION_TYPES = new Set(['widget', 'user-form']);
// A later Bot message this long after a question means the Bot moved on: the question is no
// longer the end of the conversation (a reply written in the same turn stays close to it).
export const QUESTION_SUPERSEDED_MS = 2 * 60 * 1000;

function channelOf(entry) {
  if (entry.kind === 'message') return entry.channel;
  if (entry.kind === 'send-message') return entry.message?.channel;
  return undefined;
}

// Voice calls and meetings are kept beside the chat, not in it (official isOffChatChannelEntry).
function isOffChat(entry) {
  const channel = channelOf(entry);
  return typeof channel === 'string' && /^(voice:|meeting:|meeting-request:)\S/.test(channel.trim());
}

// Messages between Bots stay out of the chat unless they are shown as sent to another Bot.
function isHiddenPeerMessage(entry) {
  if (entry.kind !== 'message') return false;
  if (entry.fromAgent != null) return true;
  return entry.toAgent != null && entry.toAgent.kind !== 'agent' && entry.toAgent.kind !== 'cloud-agent';
}

function isChatEntry(entry) {
  return entry != null && typeof entry === 'object' && CHAT_KINDS.has(entry.kind) &&
    entry.branched !== true && !isOffChat(entry) && !isHiddenPeerMessage(entry);
}

const timestampOf = entry => (Number.isFinite(entry?.timestampMs) && entry.timestampMs > 0 ? entry.timestampMs : null);

function isUserTurn(entry) {
  return entry.kind === 'user-attachment' || (entry.kind === 'message' && entry.role === 'user');
}

/** Time of the newest chat message (user or Bot) in a transcript slice, or null. */
export function lastMessageAtOf(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isChatEntry(entry)) continue;
    const at = timestampOf(entry);
    if (at !== null) return at;
  }
  return null;
}

const deadlineOf = value => {
  const at = Number(value?.expiresAtMs ?? value?.expiresAt);
  return Number.isFinite(at) && at > 0 ? at : null;
};

/** An approval card (or credential request) that still waits on the user at `now`. */
function approvalIsPending(entry, now) {
  const message = entry.message;
  if (message.type === 'credential-request') {
    const deadline = deadlineOf(message.credentialRequest);
    return entry.credentialResolution == null && message.credentialRequest != null && (deadline === null || now < deadline);
  }
  const field = APPROVAL_FIELDS.get(message.type);
  const value = field ? message[field] : null;
  if (value == null || typeof value !== 'object' || value.status !== 'pending') return false;
  const deadline = deadlineOf(value);
  return deadline === null || now < deadline;
}

/** A question card the conversation renders with its options (official WidgetPresentation.prompt). */
function questionIsOpen(entry) {
  const message = entry.message;
  if (message.type === 'widget') {
    return entry.respondedValue == null && entry.widgetDismissed !== true
      && typeof message.widget?.prompt === 'string' && message.widget.prompt.trim().length > 0;
  }
  return entry.formResolution == null;
}

// Official isUserMoment: a user turn, or a widget the user answered or dismissed.
const settlesQuestions = entry => isUserTurn(entry) || (entry.kind === 'send-message' && entry.message?.type === 'widget'
  && (entry.respondedValue != null || entry.widgetDismissed === true));

/**
 * The newest card in a transcript slice that the user can still act on (see the header): an
 * approval card still "pending" and not past its deadline, or an open question widget / form
 * that nothing after it settled and that the Bot has not moved past.
 */
export function pendingActionOf(entries, { now = Date.now() } = {}) {
  if (!Array.isArray(entries)) return null;
  let settledAfter = false;
  let latestBotAt = null;   // the newest Bot chat message after the entry being looked at
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isChatEntry(entry)) continue;
    if (settlesQuestions(entry)) settledAfter = true;
    if (isUserTurn(entry)) continue;
    const since = timestampOf(entry) ?? 0;
    if (entry.kind === 'send-message' && entry.message != null) {
      if (approvalIsPending(entry, now)) return { kind: 'approval', since, entryId: entry.id ?? null };
      if (QUESTION_TYPES.has(entry.message.type)) {
        const superseded = latestBotAt !== null && latestBotAt - since > QUESTION_SUPERSEDED_MS;
        if (!settledAfter && !superseded && questionIsOpen(entry)) return { kind: 'question', since, entryId: entry.id ?? null };
      }
    }
    if (since > 0 && latestBotAt === null) latestBotAt = since;
  }
  return null;
}

/** Card kinds whose in-place update (answer, dismissal, decision) can change pendingAction. */
export function isCardEntry(entry) {
  const type = entry?.kind === 'send-message' ? entry.message?.type : null;
  return typeof type === 'string' && (QUESTION_TYPES.has(type) || APPROVAL_FIELDS.has(type) || type === 'credential-request');
}

function entriesOf(tail) {
  if (Array.isArray(tail)) return tail;
  return Array.isArray(tail?.entries) ? tail.entries : null;
}

const isThenable = value => value != null && typeof value.then === 'function';

/**
 * Adds lastMessageAt and pendingAction to agent summaries. `readTail(agentId, limit)` returns
 * the newest transcript entries (an array or `{ entries }`), synchronously or as a promise.
 */
export function createListArrangement({ readTail, now = Date.now, limit = TRANSCRIPT_TAIL_LIMIT }) {
  const cache = new Map();
  const keyOf = agent => JSON.stringify([agent.newestEntryId ?? null, agent.lastMessageId ?? null, agent.updatedAt ?? null,
    agent.stateUpdatedAt ?? null, agent.lastActivityAt ?? null, agent.isRunning === true, agent.awaitingUserResponse ?? null,
    agent.lastViewedAt ?? null]);
  const fieldsFrom = entries => ({ lastMessageAt: lastMessageAtOf(entries), pendingAction: pendingActionOf(entries, { now: now() }) });
  const remember = (agent, key, fields) => {
    cache.set(agent.id, { key, at: now(), fields });
    if (cache.size > 2048) cache.delete(cache.keys().next().value);
    return fields;
  };
  const cached = (agent, key) => {
    const hit = cache.get(agent.id);
    return hit && hit.key === key && now() - hit.at < CACHE_MS ? hit.fields : null;
  };
  const apply = (agent, fields) => (fields ? { ...agent, lastMessageAt: fields.lastMessageAt, pendingAction: fields.pendingAction } : agent);
  const isAgent = agent => agent != null && typeof agent === 'object' && typeof agent.id === 'string' && agent.id.length > 0;

  /** Decorate one summary; resolves after reading the transcript when needed. */
  async function decorate(agent) {
    if (!isAgent(agent)) return agent;
    const key = keyOf(agent), hit = cached(agent, key);
    if (hit) return apply(agent, hit);
    try {
      const entries = entriesOf(await readTail(agent.id, limit));
      return entries ? apply(agent, remember(agent, key, fieldsFrom(entries))) : agent;
    } catch {
      return agent;
    }
  }

  /** Decorate one summary without waiting; a transcript that is not at hand keeps the last known fields. */
  function decorateNow(agent) {
    if (!isAgent(agent)) return agent;
    const key = keyOf(agent), hit = cached(agent, key);
    if (hit) return apply(agent, hit);
    try {
      const tail = readTail(agent.id, limit);
      if (isThenable(tail)) {
        // The next event for this Bot finds the fields in the cache.
        tail.then(value => { const entries = entriesOf(value); if (entries) remember(agent, key, fieldsFrom(entries)); }, () => {});
        return apply(agent, cache.get(agent.id)?.fields);
      }
      const entries = entriesOf(tail);
      return entries ? apply(agent, remember(agent, key, fieldsFrom(entries))) : agent;
    } catch {
      return agent;
    }
  }

  const decorateAll = async agents => (Array.isArray(agents) ? Promise.all(agents.map(decorate)) : agents);

  /** Gateway events stay synchronous and in order; only roster events change. */
  function decorateEvent(event) {
    if (event?.channel === 'agents' && Array.isArray(event.payload?.agents))
      return { ...event, payload: { ...event.payload, agents: event.payload.agents.map(decorateNow) } };
    if (event?.channel === 'agent-upserted' && isAgent(event.payload?.agent))
      return { ...event, payload: { ...event.payload, agent: decorateNow(event.payload.agent) } };
    return event;
  }

  const forget = agentId => cache.delete(agentId);

  /**
   * A card updated in place (answered, dismissed, decided, expired) does not always come with a
   * roster event, so the Bot would stay in "Needs attention": forget the cached fields and ask
   * for a fresh summary (`refresh(agentId)`, e.g. roster.emitAgentUpdate), at most once per
   * Bot per tick.
   */
  const refreshing = new Set();
  function noteTranscriptEvent(event, refresh) {
    if (event?.channel !== 'transcript' || typeof refresh !== 'function') return false;
    const payload = event.payload;
    const agentId = payload?.agentId;
    if (payload?.type !== 'updated' || typeof agentId !== 'string' || !isCardEntry(payload.entry)) return false;
    forget(agentId);
    if (refreshing.has(agentId)) return true;
    refreshing.add(agentId);
    queueMicrotask(() => {
      refreshing.delete(agentId);
      try {
        const result = refresh(agentId);
        if (isThenable(result)) result.then(undefined, () => {});
      } catch {}
    });
    return true;
  }
  return { decorate, decorateNow, decorateAll, decorateEvent, forget, noteTranscriptEvent };
}

// Gateway methods that answer with summaries, by the shape of their answer.
const SUMMARY_METHODS = ['updateAgent', 'setGroupMembers', 'setAgentAvatarBytes'];
const AGENT_RESULT_METHODS = ['seedConversationName', 'createAgent', 'createAgentFromTemplate', 'createGroup', 'duplicateAgent'];

/** The gateway API with arranged summaries. */
export function withListArrangement(api, arrangement) {
  if (api == null || typeof api.listAgents !== 'function') return api;
  const wrapped = { ...api, listAgents: async (...args) => arrangement.decorateAll(await api.listAgents(...args)) };
  for (const name of SUMMARY_METHODS) {
    if (typeof api[name] !== 'function') continue;
    wrapped[name] = async (...args) => {
      const result = await api[name](...args);
      return result != null && typeof result === 'object' && typeof result.id === 'string' ? arrangement.decorate(result) : result;
    };
  }
  for (const name of AGENT_RESULT_METHODS) {
    if (typeof api[name] !== 'function') continue;
    wrapped[name] = async (...args) => {
      const result = await api[name](...args);
      if (result == null || typeof result !== 'object' || result.agent == null || typeof result.agent.id !== 'string') return result;
      return { ...result, agent: await arrangement.decorate(result.agent) };
    };
  }
  return wrapped;
}

/**
 * A gateway subscription whose roster events carry the arrangement fields. `refresh(agentId)`
 * re-announces a Bot whose card changed in place (see noteTranscriptEvent).
 */
export function subscribeWithListArrangement(subscribe, arrangement, refresh = null) {
  return listener => subscribe(event => {
    if (refresh) arrangement.noteTranscriptEvent?.(event, refresh);
    listener(arrangement.decorateEvent(event));
  });
}

/** Re-announces one Bot through the original roster (a fresh summary, decorated on the way out). */
export function rosterRefresher(host) {
  return agentId => host?.transcript?.roster?.emitAgentUpdate?.(agentId);
}

/** Reads the newest transcript entries through the original transcript manager. */
export function transcriptTailReader(host) {
  return (agentId, limit) => host.transcript.getAgentTranscriptTail(agentId, { limit });
}

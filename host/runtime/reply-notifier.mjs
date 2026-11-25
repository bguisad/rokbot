/** Emit complete replies through the original preference gate and push sender.
 * Foreground suppression belongs to each destination device, not the shared Bot.
 */
import { notificationTransition, DEFAULT_NOTIFICATION_FREQUENCY } from '../clients/shared/notification-frequency.mjs';

export function createReplyNotifier(library, notify, { getFrequency = () => DEFAULT_NOTIFICATION_FREQUENCY } = {}) {
  const notifier = new library.SandMobilePushNotifier({ notify });
  const decider = notifier.decider;
  decider.throttleWindowMs = 0;
  const snapshots = new Map(), seen = new Map(), pending = [];
  let seeded = false;
  const snapshot = agent => ({ ...agent,
    awaitingReason: agent.awaitingUserResponse?.reason ?? null,
    awaitingReasonCopy: agent.awaitingUserResponse?.reasonCopy ?? null,
    notifyEnabled: agent.notifyOnUpdatesEnabled === true,
    isHiddenFromSidebar: agent.isHiddenFromSidebar === true });
  function account(agent) {
    if (!agent.lastMessageId) return;
    const history = seen.get(agent.id) ?? new Set();
    history.add(agent.lastMessageId);
    if (history.size > 256) history.delete(history.values().next().value);
    seen.set(agent.id, history);
  }
  // The host fans out to every paired device, and each device suppresses what it is already showing,
  // so the shared gate always sees an unfocused window. 2bb5e41 reads `focus.kind`; older libraries
  // read `isWindowFocused`. Both are sent so either library gets the same "nobody is looking" input.
  const gateInput = () => ({ focus: { kind: 'unfocused' }, isWindowFocused: false, nowMs: Date.now() });
  // gateTransitions records the message as notified before it classifies it. When it throws, undo
  // that record too, or the next event would be deduplicated and the reply would still be lost.
  function gate(transition) {
    const { agentId, lastMessageId } = transition;
    const accounted = decider.accountedMessageId instanceof Map ? decider.accountedMessageId : null;
    const history = decider.messageHistory instanceof Map ? decider.messageHistory : null;
    const hadAccounted = accounted?.has(agentId) === true, previous = accounted?.get(agentId);
    const hadHistory = history?.has(agentId) === true, knewMessage = history?.get(agentId)?.has(lastMessageId) === true;
    try { return decider.gateTransitions([transition], gateInput()); }
    catch (error) {
      if (accounted) { if (hadAccounted) accounted.set(agentId, previous); else accounted.delete(agentId); }
      if (history && !knewMessage) { if (hadHistory) history.get(agentId)?.delete(lastMessageId); else history.delete(agentId); }
      throw error;
    }
  }
  function accept(agent) {
    const before = snapshots.get(agent.id), next = snapshot(agent);
    if (before?.snapshotEpoch === next.snapshotEpoch && Number.isFinite(next.snapshotSeq) &&
        Number.isFinite(before?.snapshotSeq) && next.snapshotSeq <= before.snapshotSeq) return;
    if (!before) { decider.seedBaseline([next]); snapshots.set(agent.id, next); account(next); return; }
    const transition = notificationTransition(before, next, getFrequency());
    const duplicate = transition?.kind === 'agent-done' &&
      (!next.lastMessageId || seen.get(next.id)?.has(next.lastMessageId));
    // Gate and fire first; only a reply that got through is recorded as handled. If anything throws,
    // the previous snapshot stays, so the next event for this agent produces the same transition again.
    if (transition && !duplicate)
      for (const decision of gate(transition))
        if (decision.verdict === 'deliver') notifier.fire(decision.transition);
    snapshots.set(agent.id, next);
    if (transition && !duplicate) account(next);
  }
  // One agent that fails must not drop the replies of the other agents in the same event.
  function acceptAll(agents) {
    const errors = [];
    for (const agent of agents) {
      try { accept(agent); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, `${errors.length} agents failed the notification gate`);
  }
  function ingest(agents) {
    if (!seeded) { pending.push(...agents); return; }
    acceptAll(agents);
  }
  return {
    seedBaseline(agents) {
      for (const agent of agents) if (!snapshots.has(agent.id)) {
        const value = snapshot(agent); snapshots.set(agent.id, value); account(value);
        decider.seedBaseline([value]);
      }
      seeded = true;
      acceptAll(pending.splice(0));
    },
    handleAgentsEvent: event => ingest(event.agents),
    handleAgentUpsertedEvent: event => ingest([event.agent]),
    forget(id) { snapshots.delete(id); seen.delete(id); decider.forget(id); },
  };
}

package dev.rokbot.nativeapp;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What the Host last said about a chat's history (pure Java, unit-tested on a JVM).
 * {@code /local/suggestions} answers source 'empty' (and {@code /local/suggestions/complete}
 * 'empty') for chats without messages; 'model' means there is history. Unknown chats are treated
 * as "maybe" so the Host decides. Any new activity in a chat forgets its hint.
 */
final class ChatHistoryHints {
    private static final int MAX = 64;

    private final Map<String, Boolean> mHints = new LinkedHashMap<String, Boolean>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
            return size() > MAX;
        }
    };

    private static String norm(String agentId) {
        return agentId != null ? agentId.trim() : "";
    }

    /** Records a Host answer; sources other than 'empty' / 'model' say nothing about history. */
    synchronized void record(String agentId, String source) {
        if ("empty".equals(source)) mHints.put(norm(agentId), Boolean.FALSE);
        else if ("model".equals(source)) mHints.put(norm(agentId), Boolean.TRUE);
    }

    /** A message was sent or received in the chat: its history is unknown again. */
    synchronized void forget(String agentId) {
        mHints.remove(norm(agentId));
    }

    synchronized void clear() {
        mHints.clear();
    }

    /** TRUE / FALSE when the Host told us, null when unknown. */
    synchronized Boolean get(String agentId) {
        return mHints.get(norm(agentId));
    }

    /** False only when the Host said the chat is empty (or there is no chat id at all). */
    synchronized boolean mayHaveHistory(String agentId) {
        if (norm(agentId).isEmpty()) return false;
        return !Boolean.FALSE.equals(mHints.get(norm(agentId)));
    }
}

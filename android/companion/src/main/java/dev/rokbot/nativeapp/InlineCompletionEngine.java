package dev.rokbot.nativeapp;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Inline completion (ghost text) logic of the composer, free of Android types so it runs on a JVM
 * in tests. The overlay feeds it every draft change and a clock; it answers what to show and when
 * to call {@code POST /local/suggestions/complete}.
 *
 * <ul>
 *   <li>Gating: no request while completion is off, the trimmed draft is shorter than
 *       {@link #MIN_CHARS}, the chat is known to be empty, the IME is composing, or the cursor is
 *       not at the end of the draft.</li>
 *   <li>Debounce: a request is due {@link #DEBOUNCE_MS} after the last change ({@link #poll}).</li>
 *   <li>Stale requests: every change bumps a sequence number; a response whose request carries an
 *       older one is ignored (the overlay also disconnects it).</li>
 *   <li>Continuation: while the new draft is still a strict prefix of draft + completion, the rest
 *       of the completion stays without a new request.</li>
 *   <li>LRU cache keyed by (chat, draft) of the model's answers (failures are never cached).</li>
 * </ul>
 */
final class InlineCompletionEngine {
    static final long DEBOUNCE_MS = 350L;
    static final int MIN_CHARS = 2;
    static final int CACHE_SIZE = 32;

    /** A request to send: the draft as typed (the Host gets the full draft as {@code text}). */
    static final class Request {
        final int seq;
        final String agentId;
        final String draft;

        Request(int seq, String agentId, String draft) {
            this.seq = seq;
            this.agentId = agentId;
            this.draft = draft;
        }
    }

    private final ChatHistoryHints mHints;
    private final Map<String, String> mCache = new LinkedHashMap<String, String>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
            return size() > CACHE_SIZE;
        }
    };

    private boolean mEnabled = true;
    private int mSeq = 0;
    private String mAgentId = "";
    // Shown completion: mBase + mCompletion is the predicted full text; mBase is what was typed.
    private String mBase = null;
    private String mCompletion = "";
    // Debounced request.
    private String mPendingDraft = null;
    private long mDueAt = -1L;
    private Request mInFlight = null;
    // The draft produced by accepting a completion: no new request for exactly that text.
    private String mSuppressDraft = null;
    private int mRequestsIssued = 0;

    InlineCompletionEngine(ChatHistoryHints hints) {
        mHints = hints != null ? hints : new ChatHistoryHints();
    }

    static String cacheKey(String agentId, String draft) {
        return (agentId != null ? agentId : "") + '\u0001' + (draft != null ? draft : "");
    }

    /** True when a request for this draft may be sent at all. */
    static boolean eligible(boolean enabled, String agentId, String draft, boolean composing, boolean cursorAtEnd,
                            boolean mayHaveHistory) {
        if (!enabled || composing || !cursorAtEnd || !mayHaveHistory) return false;
        if (agentId == null || agentId.trim().isEmpty()) return false;
        return draft != null && draft.trim().length() >= MIN_CHARS;
    }

    /**
     * The rest of {@code base + completion} after {@code draft}, or null when draft does not
     * continue the prediction (or has reached / passed its end).
     */
    static String remainingSuffix(String base, String completion, String draft) {
        if (base == null || completion == null || completion.isEmpty() || draft == null) return null;
        String full = base + completion;
        if (draft.length() < base.length() || draft.length() >= full.length()) return null;
        if (!full.startsWith(draft)) return null;
        return full.substring(draft.length());
    }

    synchronized void setEnabled(boolean enabled) {
        if (mEnabled == enabled) return;
        mEnabled = enabled;
        if (!enabled) reset();
    }

    synchronized boolean isEnabled() { return mEnabled; }

    /**
     * Every draft / selection / composition change. Returns the suffix to show right now
     * ("" = nothing). When a request becomes pending, {@link #dueAt()} tells when to poll.
     */
    synchronized String onDraftChanged(String agentId, String draft, boolean composing, boolean cursorAtEnd, long now) {
        String agent = agentId != null ? agentId.trim() : "";
        String text = draft != null ? draft : "";
        if (!agent.equals(mAgentId)) {
            reset();
            mAgentId = agent;
        }
        if (composing || !cursorAtEnd || !mEnabled) {
            dropShown();
            dropPending();
            return "";
        }
        // Typing along the prediction keeps the rest of it.
        String rest = remainingSuffix(mBase, mCompletion, text);
        if (rest != null && text.trim().length() >= MIN_CHARS) {
            dropPending();
            return rest;
        }
        dropShown();
        if (mSuppressDraft != null && mSuppressDraft.equals(text)) {
            dropPending();
            return "";
        }
        mSuppressDraft = null;
        if (!eligible(mEnabled, agent, text, false, true, mHints.mayHaveHistory(agent))) {
            dropPending();
            return "";
        }
        String hit = mCache.get(cacheKey(agent, text));
        if (hit != null) {
            dropPending();
            if (hit.isEmpty()) return "";
            mBase = text;
            mCompletion = hit;
            return hit;
        }
        if (text.equals(mPendingDraft)) return "";             // same draft: keep the running debounce
        if (mInFlight != null && text.equals(mInFlight.draft) && mPendingDraft == null) return "";
        mSeq++;
        mInFlight = null;
        mPendingDraft = text;
        mDueAt = now + DEBOUNCE_MS;
        return "";
    }

    /** The debounced request when it is due, else null. */
    synchronized Request poll(long now) {
        if (mPendingDraft == null || now < mDueAt) return null;
        Request r = new Request(mSeq, mAgentId, mPendingDraft);
        mPendingDraft = null;
        mDueAt = -1L;
        mInFlight = r;
        mRequestsIssued++;
        return r;
    }

    /** True while {@code r} is the newest request (its response may still be shown). */
    synchronized boolean isCurrent(Request r) {
        return r != null && r == mInFlight && r.seq == mSeq;
    }

    /**
     * Response of {@code r}. Returns the suffix to show for {@code currentDraft}, "" for nothing,
     * or null when the response is stale and must be ignored.
     */
    synchronized String onResponse(Request r, String completion, String source, String currentDraft) {
        mHints.record(r != null ? r.agentId : "", source);
        if (!isCurrent(r)) return null;
        mInFlight = null;
        String c = completion != null ? completion : "";
        if ("model".equals(source)) mCache.put(cacheKey(r.agentId, r.draft), c);
        if (c.isEmpty() || !mEnabled) return "";
        if (currentDraft == null || !currentDraft.equals(r.draft)) {
            // The user kept typing while waiting: still usable if it continues the prediction.
            String rest = remainingSuffix(r.draft, c, currentDraft);
            if (rest == null) return "";
            mBase = r.draft;
            mCompletion = c;
            return rest;
        }
        mBase = r.draft;
        mCompletion = c;
        return c;
    }

    /** Request {@code r} failed (timeout, network, cancelled): nothing is shown or cached. */
    synchronized void onFailure(Request r) {
        if (isCurrent(r)) mInFlight = null;
    }

    /**
     * Accepts the shown completion for {@code draft}: returns the full text to put into the
     * composer, or null when nothing is shown for it.
     */
    synchronized String accept(String draft) {
        String rest = remainingSuffix(mBase, mCompletion, draft);
        if (rest == null && mBase != null && mBase.equals(draft) && !mCompletion.isEmpty()) rest = mCompletion;
        if (rest == null) return null;
        String full = draft + rest;
        dropShown();
        dropPending();
        mSuppressDraft = full;
        return full;
    }

    /** Focus lost, chat switched, composer gone: drop everything that is shown or pending. */
    synchronized void reset() {
        dropShown();
        dropPending();
        mSuppressDraft = null;
    }

    /** Forgets cached answers (e.g. new messages make old predictions stale). */
    synchronized void clearCache() {
        mCache.clear();
    }

    synchronized String shownSuffix(String draft) {
        String rest = remainingSuffix(mBase, mCompletion, draft);
        if (rest != null) return rest;
        if (mBase != null && mBase.equals(draft)) return mCompletion;
        return "";
    }

    synchronized boolean hasPending() { return mPendingDraft != null; }

    synchronized long dueAt() { return mDueAt; }

    synchronized int sequence() { return mSeq; }

    synchronized int requestsIssued() { return mRequestsIssued; }

    synchronized int cacheSize() { return mCache.size(); }

    private void dropShown() {
        mBase = null;
        mCompletion = "";
    }

    private void dropPending() {
        if (mPendingDraft != null || mInFlight != null) mSeq++;
        mPendingDraft = null;
        mDueAt = -1L;
        mInFlight = null;
    }
}

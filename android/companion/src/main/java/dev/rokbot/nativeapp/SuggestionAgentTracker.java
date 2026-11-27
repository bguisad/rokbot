package dev.rokbot.nativeapp;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Which Bot the input suggestions belong to, kept apart from {@code RokBotBootstrap}'s
 * last / viewing agent (those follow every gateway request that carries an agentId, so a Bot
 * working in the background - RN refreshing its transcript for the list preview - would steal
 * the "current Bot" and its suggestions would show up in another chat).
 *
 * Only navigation-like signals move the current Bot: entering a chat (openAgentWindowed),
 * sending from the composer (sendPrompt), markAgentViewed, and deep links / notification taps.
 * Background requests (getAgent, transcript fetches, markAgentRead, getForeverBoxStatus,
 * automations, ...) never do.
 *
 * Also owns:
 * - per-Bot generations (only that Bot's sendPrompt / new-reply signal bumps it), so another Bot's
 *   activity never invalidates the current Bot's cached suggestions;
 * - request sequence numbers + response validation (latest sequence, same Bot as now, echoed
 *   agentId / requestId match), so late answers for another Bot are dropped;
 * - in-flight de-duplication and "failed once, no automatic retry until the chat changes".
 *
 * Pure Java (no Android types): unit-tested on a JVM.
 */
final class SuggestionAgentTracker {
    /** Result of a gateway request as far as suggestions are concerned. */
    enum Signal {
        /** Not about the current Bot (or not a suggestions signal at all). */
        IGNORED,
        /** The user entered a chat (or a deep link opened it): prefetch for it. */
        OPENED,
        /** The user sent a message to this Bot: its generation was bumped. */
        SENT,
        /** The current Bot's transcript was fetched: maybe a new reply, revalidate (debounced). */
        REPLY_HINT,
    }

    static final int MAX_REQUEST_ID_LENGTH = 64;
    /** Minimum gap between two hint-driven revalidations of the same Bot. */
    static final long REVALIDATE_MIN_INTERVAL_MS = 8_000L;

    /** One /local/suggestions request issued for {@link #agentId}. */
    static final class Request {
        final int seq;
        final String agentId;
        final String key;
        final String requestId;
        final boolean background;
        /** {@link SuggestionLoadState} token when the bar is waiting for this answer (0 = none). */
        volatile int loadToken;

        Request(int seq, String agentId, String key, String requestId, boolean background) {
            this.seq = seq;
            this.agentId = agentId;
            this.key = key;
            this.requestId = requestId;
            this.background = background;
        }
    }

    private String mCurrent = "";
    private String mPaused = "";
    private int mSession = 0;
    private int mSeq = 0;
    private final Map<String, Integer> mGenerations = new HashMap<>();
    private final Map<String, Request> mInFlight = new HashMap<>();
    private final Set<String> mFailed = new HashSet<>();
    private final Map<String, Long> mLastRevalidate = new HashMap<>();

    /** Gateway paths that are strong "the user is in this chat" signals. */
    static boolean isNavigationPath(String path) {
        return "/api/openAgentWindowed".equals(path)
                || "/api/sendPrompt".equals(path)
                || "/api/markAgentViewed".equals(path);
    }

    /** Transcript fetches: a hint that the Bot may have replied (never moves the current Bot). */
    static boolean isTranscriptPath(String path) {
        return "/api/getAgentTranscriptTail".equals(path)
                || "/api/getAgentTranscript".equals(path)
                || "/api/getAgentTranscriptWindow".equals(path);
    }

    static String clean(String agentId) {
        if (agentId == null) return "";
        String t = agentId.trim();
        return t.length() > 256 ? "" : t;
    }

    /**
     * Feeds a gateway request (path + its agentId). Returns what the overlay should do.
     * {@code changed[0]} (if given) tells whether the current Bot changed.
     */
    synchronized Signal onGatewayRequest(String path, String agentId, boolean[] changed) {
        String id = clean(agentId);
        if (changed != null && changed.length > 0) changed[0] = false;
        if (id.isEmpty() || path == null) return Signal.IGNORED;
        if ("/api/sendPrompt".equals(path)) {
            boolean c = setCurrentLocked(id);
            if (changed != null && changed.length > 0) changed[0] = c;
            bumpLocked(id);
            return Signal.SENT;
        }
        if ("/api/openAgentWindowed".equals(path) || "/api/markAgentViewed".equals(path)) {
            boolean c = setCurrentLocked(id);
            if (changed != null && changed.length > 0) changed[0] = c;
            return "/api/openAgentWindowed".equals(path) || c ? Signal.OPENED : Signal.IGNORED;
        }
        if (isTranscriptPath(path) && id.equals(mCurrent)) return Signal.REPLY_HINT;
        return Signal.IGNORED;
    }

    /** Deep link / notification tap opened this chat. Returns true when the current Bot changed. */
    synchronized boolean onDeepLink(String agentId) {
        String id = clean(agentId);
        if (id.isEmpty()) return false;
        return setCurrentLocked(id);
    }

    /** A new reply of this Bot (e.g. a reply notification): bumps only that Bot's generation. */
    synchronized boolean onReply(String agentId) {
        String id = clean(agentId);
        if (id.isEmpty()) return false;
        bumpLocked(id);
        return id.equals(mCurrent);
    }

    /** The RN page paused: no current Bot until it resumes; in-flight answers become stale. */
    synchronized void onPaused() {
        if (!mCurrent.isEmpty()) mPaused = mCurrent;
        setCurrentLocked("");
    }

    /**
     * The RN page resumed: RN still shows the chat it showed when it paused (a deep link or a new
     * navigation signal overrides it). Returns true when the current Bot changed.
     */
    synchronized boolean onResumed() {
        String restore = mPaused;
        mPaused = "";
        if (!mCurrent.isEmpty() || restore.isEmpty()) return false;
        return setCurrentLocked(restore);
    }

    synchronized String current() {
        return mCurrent;
    }

    synchronized int session() {
        return mSession;
    }

    synchronized int generation(String agentId) {
        Integer g = mGenerations.get(clean(agentId));
        return g != null ? g : 1;
    }

    /** Cache key: always includes the Bot and its own generation. */
    synchronized String cacheKey(String agentId, String lang) {
        String id = clean(agentId);
        return id + ":" + generation(id) + ":" + (lang != null ? lang : "");
    }

    /** True when a request for {@code key} may start now (not in flight, not failed in this chat). */
    synchronized boolean canFetch(String key) {
        return key != null && !mInFlight.containsKey(key) && !mFailed.contains(key);
    }

    synchronized Request inFlight(String key) {
        return mInFlight.get(key);
    }

    synchronized boolean hasFailed(String key) {
        return mFailed.contains(key);
    }

    /**
     * May a background revalidation of the current Bot's (cached) key start now? Rate limited per
     * Bot unless {@code force} (entering the chat).
     */
    synchronized boolean canRevalidate(String key, String agentId, boolean force, long now) {
        if (!canFetch(key)) return false;
        if (force) return true;
        Long last = mLastRevalidate.get(clean(agentId));
        return last == null || now - last >= REVALIDATE_MIN_INTERVAL_MS;
    }

    /**
     * Starts a request for the current Bot; returns null when there is no current Bot, the key is
     * not the current Bot's, or a request for the key is already in flight / failed.
     */
    synchronized Request begin(String agentId, String key, boolean background, long now) {
        String id = clean(agentId);
        if (id.isEmpty() || !id.equals(mCurrent) || !canFetch(key)) return null;
        mSeq++;
        String requestId = "s" + mSession + "-" + mSeq;
        if (requestId.length() > MAX_REQUEST_ID_LENGTH) requestId = requestId.substring(0, MAX_REQUEST_ID_LENGTH);
        Request r = new Request(mSeq, id, key, requestId, background);
        mInFlight.put(key, r);
        if (background) mLastRevalidate.put(id, now);
        return r;
    }

    /**
     * May this answer be shown / cached? Only if it is the latest request, it is still for the
     * current Bot, and the Host's echoed agentId / requestId (when present) match the request.
     * Older Hosts do not echo: a missing agentId counts as the requested one.
     */
    synchronized boolean accept(Request r, String echoedAgentId, String echoedRequestId) {
        if (r == null) return false;
        if (mInFlight.get(r.key) == r) mInFlight.remove(r.key);
        if (r.seq != mSeq) return false;
        if (!r.agentId.equals(mCurrent)) return false;
        String echoed = echoedAgentId != null ? echoedAgentId.trim() : "";
        if (!echoed.isEmpty() && !echoed.equals(r.agentId)) return false;
        String rid = echoedRequestId != null ? echoedRequestId.trim() : "";
        if (!rid.isEmpty() && !rid.equals(r.requestId)) return false;
        return r.key.equals(cacheKey(r.agentId, langOf(r.key)));
    }

    /** The request failed: no automatic retry of this key until the chat changes. */
    synchronized boolean fail(Request r) {
        if (r == null) return false;
        if (mInFlight.get(r.key) == r) mInFlight.remove(r.key);
        if (r.agentId.equals(mCurrent)) mFailed.add(r.key);
        return r.seq == mSeq && r.agentId.equals(mCurrent);
    }

    /** Settings changed: forget failures so the next focus asks again. */
    synchronized void clearFailures() {
        mFailed.clear();
    }

    private static String langOf(String key) {
        int i = key.lastIndexOf(':');
        return i >= 0 ? key.substring(i + 1) : "";
    }

    private void bumpLocked(String id) {
        Integer g = mGenerations.get(id);
        mGenerations.put(id, (g != null ? g : 1) + 1);
        if (mGenerations.size() > 256) {
            // Bounded: drop Bots other than the current one (their cache keys just restart).
            mGenerations.keySet().removeIf(k -> !k.equals(mCurrent) && !k.equals(id));
        }
    }

    private boolean setCurrentLocked(String id) {
        if (id.equals(mCurrent)) return false;
        mCurrent = id;
        mSession++;
        // New chat: everything in flight is stale, failures may be retried.
        mInFlight.clear();
        mFailed.clear();
        return true;
    }
}

package dev.rokbot.nativeapp;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Loading state of the AI suggestions of the composer bar (pure Java, unit-tested on a JVM).
 *
 * <pre>
 *   IDLE --begin--> LOADING --succeed(non-empty)--> READY
 *                      |  \--succeed(empty) / fail--> FAILED --settle--> IDLE
 *                      \--cancel--> IDLE
 * </pre>
 *
 * Every {@link #begin} hands out a new token; results carrying an older token are stale and
 * ignored, so a slow answer for a previous turn or chat never replaces the current one.
 * Placeholders (shimmer pills) are shown only after {@link #PLACEHOLDER_DELAY_MS} of loading, so a
 * fast answer (cache hit, empty chat) does not flash skeletons. FAILED is the short phase in which
 * the placeholders fade out silently; there is no error UI.
 */
final class SuggestionLoadState {
    enum Phase { IDLE, LOADING, READY, FAILED }

    static final long PLACEHOLDER_DELAY_MS = 140L;
    static final long FADE_OUT_MS = 180L;
    static final int PLACEHOLDER_COUNT = 3;

    private Phase mPhase = Phase.IDLE;
    private int mToken = 0;
    private String mKey = "";
    private long mStartedAt = 0L;
    private List<String> mItems = Collections.emptyList();

    /** Starts loading suggestions for {@code key}; returns the token the result must carry. */
    synchronized int begin(String key, long now) {
        mToken++;
        mKey = key != null ? key : "";
        mPhase = Phase.LOADING;
        mStartedAt = now;
        mItems = Collections.emptyList();
        return mToken;
    }

    /** Result of request {@code token}; false when stale (a newer request or a cancel happened). */
    synchronized boolean succeed(int token, List<String> items) {
        if (token != mToken || mPhase != Phase.LOADING) return false;
        List<String> clean = new ArrayList<>();
        if (items != null) {
            for (String s : items) {
                if (s != null && !s.trim().isEmpty()) clean.add(s.trim());
            }
        }
        if (clean.isEmpty()) {
            mPhase = Phase.FAILED;
            mItems = Collections.emptyList();
        } else {
            mPhase = Phase.READY;
            mItems = Collections.unmodifiableList(clean);
        }
        return true;
    }

    /** Request {@code token} failed or timed out; false when stale. */
    synchronized boolean fail(int token) {
        if (token != mToken || mPhase != Phase.LOADING) return false;
        mPhase = Phase.FAILED;
        mItems = Collections.emptyList();
        return true;
    }

    /** The fade-out of FAILED is over: back to IDLE. False if something else happened meanwhile. */
    synchronized boolean settle(int token) {
        if (token != mToken || mPhase != Phase.FAILED) return false;
        mPhase = Phase.IDLE;
        return true;
    }

    /** Drops whatever is loading or shown (settings change, chat switch); in-flight results become stale. */
    synchronized void cancel() {
        mToken++;
        mPhase = Phase.IDLE;
        mKey = "";
        mItems = Collections.emptyList();
    }

    /** Shows a cached result immediately (no loading phase). */
    synchronized void ready(String key, List<String> items) {
        mToken++;
        mKey = key != null ? key : "";
        mPhase = items != null && !items.isEmpty() ? Phase.READY : Phase.IDLE;
        mItems = items != null ? Collections.unmodifiableList(new ArrayList<>(items)) : Collections.emptyList();
    }

    synchronized Phase phase() { return mPhase; }

    synchronized int token() { return mToken; }

    synchronized String key() { return mKey; }

    synchronized List<String> items() { return mItems; }

    synchronized boolean isLoading() { return mPhase == Phase.LOADING; }

    synchronized boolean isFadingOut() { return mPhase == Phase.FAILED; }

    /** Number of shimmer placeholders to draw now (0 when not loading or still within the grace delay). */
    synchronized int placeholdersAt(long now) {
        if (mPhase != Phase.LOADING) return 0;
        return now - mStartedAt >= PLACEHOLDER_DELAY_MS ? PLACEHOLDER_COUNT : 0;
    }

    /** Milliseconds until placeholders become due (0 if due or not loading). */
    synchronized long placeholderDelayLeft(long now) {
        if (mPhase != Phase.LOADING) return 0L;
        return Math.max(0L, PLACEHOLDER_DELAY_MS - (now - mStartedAt));
    }
}

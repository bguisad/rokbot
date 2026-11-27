package dev.rokbot.nativeapp;

import java.util.Objects;

/**
 * Pure-Java reconnect state machine for Tailcat tunnel recovery.
 *
 * Handles Android network transitions (onAvailable / onCapabilitiesChanged / onLinkPropertiesChanged / onLost),
 * foreground returns, periodic foreground health watchdogs, request I/O failures, and capped exponential
 * backoff retries (1s -> 2s -> 5s -> 10s -> 20s -> 30s) without ever permanently stalling.
 */
final class TailcatReconnectStateMachine {
    static final long[] BACKOFF_DELAYS_MS = new long[] {
            1_000L, 2_000L, 5_000L, 10_000L, 20_000L, 30_000L
    };
    static final long FOREGROUND_WATCHDOG_MS = 15_000L;
    static final long FOREGROUND_RESUME_THROTTLE_MS = 10_000L;
    static final long NETWORK_LOST_RECHECK_MS = 2_000L;
    static final long DUPLICATE_AVAILABLE_GUARD_MS = 500L;
    static final long REQUEST_FAILURE_COOLDOWN_MS = 1_000L;

    enum State {
        IDLE,
        HEALTHY,
        PROBING,
        BACKOFF_WAIT,
        OFFLINE
    }

    static final class NetworkSnapshot {
        final boolean available;
        final long networkHandle;
        final String transports;
        final boolean hasInternet;
        final boolean validated;
        final String linkFingerprint;

        NetworkSnapshot(boolean available, long networkHandle, String transports,
                        boolean hasInternet, boolean validated, String linkFingerprint) {
            this.available = available;
            this.networkHandle = networkHandle;
            this.transports = transports != null ? transports : "";
            this.hasInternet = hasInternet;
            this.validated = validated;
            this.linkFingerprint = linkFingerprint != null ? linkFingerprint : "";
        }

        static NetworkSnapshot offline() {
            return new NetworkSnapshot(false, 0L, "", false, false, "");
        }

        String signature() {
            if (!available) return "none";
            StringBuilder sb = new StringBuilder();
            sb.append(networkHandle)
              .append(':')
              .append(transports)
              .append(":I=").append(hasInternet ? '1' : '0')
              .append(":V=").append(validated ? '1' : '0');
            if (!linkFingerprint.isEmpty()) {
                sb.append(":L=").append(linkFingerprint);
            }
            return sb.toString();
        }
    }

    static final class ProbeOutcome {
        final boolean reachable;
        final boolean restarted;
        final String localUrl;
        final boolean portChanged;

        ProbeOutcome(boolean reachable, boolean restarted, String localUrl, boolean portChanged) {
            this.reachable = reachable;
            this.restarted = restarted;
            this.localUrl = localUrl != null ? localUrl : "";
            this.portChanged = portChanged;
        }
    }

    interface Clock {
        long nowMs();
    }

    interface Cancellable {
        void cancel();
    }

    interface Scheduler {
        Cancellable schedule(long delayMs, Runnable task);
    }

    interface Actions {
        boolean isPaired();
        boolean isTailcatEnabled();
        boolean hasActiveInternet();
        ProbeOutcome probeAndRecover();
        void onRecovered(boolean restarted, String localUrl, boolean portChanged);
        void onDirectNetworkRestored();
        void onNetworkAvailabilityChanged(boolean hasInternet);
    }

    private final Clock mClock;
    private final Scheduler mScheduler;
    private final Actions mActions;
    private final Object mLock = new Object();

    private State mState = State.IDLE;
    private String mLastSignature = null;
    private boolean mForeground = false;
    private boolean mHadUnhealthyState = false;
    private int mBackoffAttempt = 0;
    private long mGeneration = 0L;
    private long mLastProbeSuccessMs = -1L;
    private long mLastAttemptCompletedMs = -1L;
    private boolean mProbing = false;
    private boolean mReprobeQueued = false;
    private boolean mResetBackoffOnReprobe = false;
    private Cancellable mPendingRetry;
    private Cancellable mForegroundWatchdog;
    private Cancellable mLostRecheck;

    TailcatReconnectStateMachine(Clock clock, Scheduler scheduler, Actions actions) {
        mClock = Objects.requireNonNull(clock, "clock");
        mScheduler = Objects.requireNonNull(scheduler, "scheduler");
        mActions = Objects.requireNonNull(actions, "actions");
    }

    static long backoffDelayMs(int attemptIndex) {
        if (attemptIndex <= 0) return BACKOFF_DELAYS_MS[0];
        int idx = Math.min(attemptIndex, BACKOFF_DELAYS_MS.length - 1);
        return BACKOFF_DELAYS_MS[idx];
    }

    State getState() {
        synchronized (mLock) {
            return mState;
        }
    }

    int getBackoffAttempt() {
        synchronized (mLock) {
            return mBackoffAttempt;
        }
    }

    String getLastSignature() {
        synchronized (mLock) {
            return mLastSignature;
        }
    }

    void initNetworkSnapshot(NetworkSnapshot snapshot) {
        synchronized (mLock) {
            mLastSignature = snapshot != null ? snapshot.signature() : "none";
            if (snapshot == null || !snapshot.available || !snapshot.hasInternet) {
                mState = State.OFFLINE;
                mHadUnhealthyState = true;
            }
        }
    }

    void onNetworkAvailable(NetworkSnapshot snapshot) {
        NetworkSnapshot snap = snapshot != null ? snapshot : NetworkSnapshot.offline();
        if (!snap.available || !snap.hasInternet) {
            return;
        }
        boolean notifyAvailable = false;
        boolean triggerProbe = false;
        synchronized (mLock) {
            long now = mClock.nowMs();
            String sig = snap.signature();
            boolean wasOffline = mState == State.OFFLINE || "none".equals(mLastSignature);
            boolean sigChanged = !sig.equals(mLastSignature);
            boolean recentlyHealthySame = mState == State.HEALTHY
                    && !sigChanged
                    && !wasOffline
                    && mLastProbeSuccessMs >= 0L
                    && (now - mLastProbeSuccessMs) < DUPLICATE_AVAILABLE_GUARD_MS;

            mLastSignature = sig;
            cancelLostRecheckLocked();
            if (wasOffline || sigChanged) {
                notifyAvailable = true;
            }
            if (!recentlyHealthySame) {
                if (wasOffline || sigChanged) {
                    mHadUnhealthyState = true;
                }
                mBackoffAttempt = 0;
                triggerProbe = true;
            }
        }
        if (notifyAvailable) {
            safeNotifyNetworkChanged(true);
        }
        if (triggerProbe) {
            triggerImmediateProbe(true);
        }
    }

    void onNetworkCapabilitiesChanged(NetworkSnapshot snapshot) {
        NetworkSnapshot snap = snapshot != null ? snapshot : NetworkSnapshot.offline();
        if (!snap.available || !snap.hasInternet) {
            handleOfflineTransition();
            return;
        }
        boolean notifyAvailable = false;
        boolean triggerProbe = false;
        synchronized (mLock) {
            String sig = snap.signature();
            boolean wasOffline = mState == State.OFFLINE || "none".equals(mLastSignature);
            boolean sigChanged = !sig.equals(mLastSignature);
            boolean shouldKickBackoff = mState == State.BACKOFF_WAIT && snap.validated;
            if (!wasOffline && !sigChanged && !shouldKickBackoff) {
                return;
            }
            mLastSignature = sig;
            cancelLostRecheckLocked();
            if (wasOffline || sigChanged) {
                notifyAvailable = true;
                mHadUnhealthyState = true;
            }
            mBackoffAttempt = 0;
            triggerProbe = true;
        }
        if (notifyAvailable) {
            safeNotifyNetworkChanged(true);
        }
        if (triggerProbe) {
            triggerImmediateProbe(true);
        }
    }

    void onNetworkLinkPropertiesChanged(NetworkSnapshot snapshot) {
        if (snapshot == null || !snapshot.available || !snapshot.hasInternet) {
            return;
        }
        boolean notifyAvailable = false;
        boolean triggerProbe = false;
        synchronized (mLock) {
            String sig = snapshot.signature();
            if (sig.equals(mLastSignature)) {
                return;
            }
            boolean wasOffline = mState == State.OFFLINE || "none".equals(mLastSignature);
            mLastSignature = sig;
            cancelLostRecheckLocked();
            mHadUnhealthyState = true;
            mBackoffAttempt = 0;
            notifyAvailable = wasOffline || true;
            triggerProbe = true;
        }
        if (notifyAvailable) {
            safeNotifyNetworkChanged(true);
        }
        if (triggerProbe) {
            triggerImmediateProbe(true);
        }
    }

    void onNetworkLost(long lostNetworkHandle, NetworkSnapshot activeAfterLoss) {
        if (activeAfterLoss != null
                && activeAfterLoss.available
                && activeAfterLoss.hasInternet
                && activeAfterLoss.networkHandle != 0L
                && activeAfterLoss.networkHandle != lostNetworkHandle) {
            onNetworkAvailable(activeAfterLoss);
            return;
        }
        handleOfflineTransition();
    }

    private void handleOfflineTransition() {
        boolean notifyOffline;
        final long gen;
        synchronized (mLock) {
            notifyOffline = mState != State.OFFLINE || !"none".equals(mLastSignature);
            mState = State.OFFLINE;
            mLastSignature = "none";
            mHadUnhealthyState = true;
            mBackoffAttempt = 0;
            cancelPendingRetryLocked();
            cancelLostRecheckLocked();
            gen = ++mGeneration;
            mLostRecheck = mScheduler.schedule(NETWORK_LOST_RECHECK_MS, () -> onLostRecheckFired(gen));
        }
        if (notifyOffline) {
            safeNotifyNetworkChanged(false);
        }
    }

    private void onLostRecheckFired(long expectedGen) {
        synchronized (mLock) {
            if (expectedGen != mGeneration || mState != State.OFFLINE) {
                return;
            }
            mLostRecheck = null;
        }
        if (safeHasActiveInternet()) {
            synchronized (mLock) {
                if (expectedGen != mGeneration || mState != State.OFFLINE) {
                    return;
                }
                mBackoffAttempt = 0;
            }
            safeNotifyNetworkChanged(true);
            triggerImmediateProbe(true);
        }
    }

    void onAppForeground() {
        synchronized (mLock) {
            mForeground = true;
            mBackoffAttempt = 0;
            scheduleForegroundWatchdogLocked();
        }
        triggerImmediateProbe(true);
    }

    void onForegroundResumed() {
        boolean shouldProbe;
        synchronized (mLock) {
            mForeground = true;
            if (mForegroundWatchdog == null) {
                scheduleForegroundWatchdogLocked();
            }
            long now = mClock.nowMs();
            shouldProbe = mState != State.HEALTHY
                    || mLastProbeSuccessMs < 0L
                    || (now - mLastProbeSuccessMs) >= FOREGROUND_RESUME_THROTTLE_MS;
            if (shouldProbe && mState == State.BACKOFF_WAIT) {
                mBackoffAttempt = 0;
            }
        }
        if (shouldProbe) {
            triggerImmediateProbe(false);
        }
    }

    void onAppBackground() {
        synchronized (mLock) {
            mForeground = false;
            cancelForegroundWatchdogLocked();
        }
    }

    void onRequestFailure() {
        boolean shouldTrigger = false;
        synchronized (mLock) {
            mHadUnhealthyState = true;
            if (mProbing) {
                mReprobeQueued = true;
                mResetBackoffOnReprobe = true;
                return;
            }
            long now = mClock.nowMs();
            if (mState == State.BACKOFF_WAIT
                    && mLastAttemptCompletedMs >= 0L
                    && (now - mLastAttemptCompletedMs) < REQUEST_FAILURE_COOLDOWN_MS) {
                return;
            }
            mBackoffAttempt = 0;
            shouldTrigger = true;
        }
        if (shouldTrigger) {
            triggerImmediateProbe(true);
        }
    }

    void onTunnelCommitted() {
        synchronized (mLock) {
            mBackoffAttempt = 0;
            mHadUnhealthyState = false;
            mLastProbeSuccessMs = mClock.nowMs();
            mState = State.HEALTHY;
            cancelPendingRetryLocked();
        }
    }

    void onClear() {
        synchronized (mLock) {
            mGeneration++;
            mState = State.IDLE;
            mBackoffAttempt = 0;
            mHadUnhealthyState = false;
            mProbing = false;
            mReprobeQueued = false;
            mResetBackoffOnReprobe = false;
            mLastProbeSuccessMs = -1L;
            mLastAttemptCompletedMs = -1L;
            cancelPendingRetryLocked();
            cancelForegroundWatchdogLocked();
            cancelLostRecheckLocked();
        }
    }

    private void triggerImmediateProbe(boolean resetBackoff) {
        final long gen;
        synchronized (mLock) {
            if (mProbing) {
                mReprobeQueued = true;
                if (resetBackoff) {
                    mResetBackoffOnReprobe = true;
                }
                return;
            }
            if (resetBackoff) {
                mBackoffAttempt = 0;
            }
            cancelPendingRetryLocked();
            gen = ++mGeneration;
            mState = State.PROBING;
            mProbing = true;
        }
        mScheduler.schedule(0L, () -> executeAttempt(gen));
    }

    private void scheduleBackoffRetryLocked() {
        cancelPendingRetryLocked();
        long delayMs = backoffDelayMs(mBackoffAttempt);
        mBackoffAttempt++;
        mState = State.BACKOFF_WAIT;
        final long gen = ++mGeneration;
        mPendingRetry = mScheduler.schedule(delayMs, () -> {
            synchronized (mLock) {
                if (gen != mGeneration || mProbing) {
                    return;
                }
                mPendingRetry = null;
                mState = State.PROBING;
                mProbing = true;
            }
            executeAttempt(gen);
        });
    }

    private void scheduleForegroundWatchdogLocked() {
        cancelForegroundWatchdogLocked();
        if (!mForeground) return;
        mForegroundWatchdog = mScheduler.schedule(FOREGROUND_WATCHDOG_MS, this::onForegroundWatchdogFired);
    }

    private void onForegroundWatchdogFired() {
        boolean shouldProbe = false;
        synchronized (mLock) {
            mForegroundWatchdog = null;
            if (!mForeground) {
                return;
            }
            scheduleForegroundWatchdogLocked();
            if (!mProbing && mState != State.BACKOFF_WAIT) {
                shouldProbe = true;
            }
        }
        if (shouldProbe) {
            triggerImmediateProbe(false);
        }
    }

    private void executeAttempt(long gen) {
        boolean paired;
        boolean tailcat;
        try {
            paired = mActions.isPaired();
            tailcat = paired && mActions.isTailcatEnabled();
        } catch (Throwable ignored) {
            paired = false;
            tailcat = false;
        }

        if (!paired) {
            synchronized (mLock) {
                mProbing = false;
                mReprobeQueued = false;
                mResetBackoffOnReprobe = false;
                if (gen == mGeneration) {
                    mState = State.IDLE;
                    mBackoffAttempt = 0;
                    mHadUnhealthyState = false;
                }
            }
            return;
        }

        if (!tailcat) {
            boolean notifyDirect = false;
            synchronized (mLock) {
                mProbing = false;
                mReprobeQueued = false;
                mResetBackoffOnReprobe = false;
                if (gen == mGeneration) {
                    notifyDirect = mHadUnhealthyState;
                    mHadUnhealthyState = false;
                    mState = State.HEALTHY;
                    mBackoffAttempt = 0;
                    mLastProbeSuccessMs = mClock.nowMs();
                    mLastAttemptCompletedMs = mLastProbeSuccessMs;
                }
            }
            if (notifyDirect) {
                try { mActions.onDirectNetworkRestored(); } catch (Throwable ignored) {}
            }
            return;
        }

        ProbeOutcome outcome;
        try {
            outcome = mActions.probeAndRecover();
        } catch (Throwable ignored) {
            outcome = new ProbeOutcome(false, false, "", false);
        }
        if (outcome == null) {
            outcome = new ProbeOutcome(false, false, "", false);
        }

        boolean fireRecovered = false;
        boolean runFollowUp = false;
        boolean resetOnFollowUp = false;
        synchronized (mLock) {
            mProbing = false;
            long now = mClock.nowMs();
            mLastAttemptCompletedMs = now;
            boolean staleGen = (gen != mGeneration);

            if (mReprobeQueued) {
                runFollowUp = true;
                resetOnFollowUp = mResetBackoffOnReprobe;
                mReprobeQueued = false;
                mResetBackoffOnReprobe = false;
            }

            if (outcome.reachable) {
                mLastProbeSuccessMs = now;
                if (!staleGen) {
                    mBackoffAttempt = 0;
                    mState = State.HEALTHY;
                    if (outcome.restarted || mHadUnhealthyState) {
                        mHadUnhealthyState = false;
                        fireRecovered = true;
                    }
                }
            } else {
                mHadUnhealthyState = true;
                if (!staleGen && !runFollowUp) {
                    if (!mForeground && !safeHasActiveInternet()) {
                        mState = State.OFFLINE;
                    } else {
                        scheduleBackoffRetryLocked();
                    }
                }
            }
        }

        if (fireRecovered) {
            try {
                mActions.onRecovered(outcome.restarted, outcome.localUrl, outcome.portChanged);
            } catch (Throwable ignored) {}
        }
        if (runFollowUp) {
            triggerImmediateProbe(resetOnFollowUp);
        }
    }

    private boolean safeHasActiveInternet() {
        try {
            return mActions.hasActiveInternet();
        } catch (Throwable ignored) {
            return true;
        }
    }

    private void safeNotifyNetworkChanged(boolean hasInternet) {
        try {
            mActions.onNetworkAvailabilityChanged(hasInternet);
        } catch (Throwable ignored) {}
    }

    private void cancelPendingRetryLocked() {
        if (mPendingRetry != null) {
            mPendingRetry.cancel();
            mPendingRetry = null;
        }
    }

    private void cancelForegroundWatchdogLocked() {
        if (mForegroundWatchdog != null) {
            mForegroundWatchdog.cancel();
            mForegroundWatchdog = null;
        }
    }

    private void cancelLostRecheckLocked() {
        if (mLostRecheck != null) {
            mLostRecheck.cancel();
            mLostRecheck = null;
        }
    }
}

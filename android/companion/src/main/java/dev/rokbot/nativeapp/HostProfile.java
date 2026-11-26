package dev.rokbot.nativeapp;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import org.json.JSONObject;

/**
 * The Host user profile ({@code GET /local/profile}: displayName, hostName, avatarDataUrl) shown in
 * place of the pinned bundle's synthetic {@code dev-gateway@localhost} identity. Android port of
 * iOS RBProfile.m: the last good profile is cached per pairing in {@link Storage#getProfileCache}
 * so a cold start paints it immediately, then it is refreshed when the Host connection comes up,
 * when RN resumes, and after ProfileActivity saves.
 */
final class HostProfile {
    private static final String TAG = "RokBotProfile";
    private static final long REFRESH_THROTTLE_MS = 5000L;

    private static final Object LOCK = new Object();
    private static String sScope;            // deviceId the in-memory profile belongs to
    private static JSONObject sProfile;      // null = nothing known yet
    private static volatile long sRevision;  // bumps on every change; overlays compare against it
    private static volatile long sLastFetchMs;
    private static volatile boolean sFetching;
    private static volatile Runnable sListener;

    private HostProfile() {}

    static void setListener(Runnable listener) {
        sListener = listener;
    }

    static long revision() {
        return sRevision;
    }

    private static String scopeOf(Context context) {
        try {
            String id = Storage.getDeviceId(context);
            return id != null ? id : "";
        } catch (Throwable t) {
            return "";
        }
    }

    /** Returns the profile for the current pairing, restoring it from the cache on first use. */
    private static JSONObject current(Context context) {
        if (context == null) return null;
        String scope = scopeOf(context);
        synchronized (LOCK) {
            if (scope.equals(sScope)) return sProfile;
            sScope = scope;
            sProfile = null;
            try {
                JSONObject cached = Storage.getProfileCache(context);
                if (isValid(cached)) sProfile = cached;
            } catch (Throwable ignored) {}
            sRevision++;
            return sProfile;
        }
    }

    private static boolean isValid(JSONObject p) {
        if (p == null) return false;
        Object name = p.opt("displayName");
        return name instanceof String && !((String) name).trim().isEmpty();
    }

    /** Host displayName, or null when no profile is known (callers keep their old fallback). */
    static String displayName(Context context) {
        JSONObject p = current(context);
        return p != null ? p.optString("displayName", "").trim() : null;
    }

    /** Host label for the second line of the account row (iOS RBProfileHostName). */
    static String hostName(Context context) {
        JSONObject p = current(context);
        if (p == null) return null;
        String v = p.optString("hostName", "").trim();
        return v.isEmpty() ? "RokBot Host" : rebrandHostName(v);
    }

    private static final java.util.regex.Pattern LEGACY_BRAND =
            java.util.regex.Pattern.compile("\\bgrok[\\s_-]?bot\\b", java.util.regex.Pattern.CASE_INSENSITIVE);

    /**
     * Display form of a Host-reported name: Hosts set up from Grok Bot data still call themselves
     * "Grok Bot Host". Only the shown text changes; the stored profile keeps the Host's value.
     */
    static String rebrandHostName(String name) {
        if (name == null || name.isEmpty()) return name;
        return LEGACY_BRAND.matcher(name).replaceAll("RokBot");
    }

    static String avatarDataUrl(Context context) {
        JSONObject p = current(context);
        if (p == null) return null;
        Object v = p.opt("avatarDataUrl");
        return v instanceof String && ((String) v).startsWith("data:") ? (String) v : null;
    }

    static boolean hasProfile(Context context) {
        return current(context) != null;
    }

    /** Circle avatar bitmap (image, or coloured initial when the profile has no avatar). */
    static Bitmap avatarBitmap(Context context, int sizePx) {
        String name = displayName(context);
        if (name == null) return null;
        return UiChrome.decodeCircleAvatar(name, avatarDataUrl(context), sizePx);
    }

    /** Accept a fresh profile (from GET or PUT /local/profile), persist it and notify the UI. */
    static void apply(Context context, JSONObject profile) {
        if (context == null || !isValid(profile)) return;
        String scope = scopeOf(context);
        boolean changed;
        synchronized (LOCK) {
            changed = !scope.equals(sScope) || sProfile == null || !sProfile.toString().equals(profile.toString());
            sScope = scope;
            sProfile = profile;
            if (changed) sRevision++;
        }
        try {
            Storage.setProfileCache(context, profile);
        } catch (Throwable ignored) {}
        try {
            ConnectionHistory.noteHostName(context, hostName(context));
        } catch (Throwable ignored) {}
        if (changed) notifyListener();
    }

    /** Forget the in-memory profile (pairing changed); the cache is cleared by Storage itself. */
    static void clear() {
        synchronized (LOCK) {
            sScope = null;
            sProfile = null;
            sRevision++;
        }
        sLastFetchMs = 0L;
        notifyListener();
    }

    /**
     * Re-fetch {@code /local/profile} in the background. {@code force=false} is throttled so the
     * per-Activity onResume hook does not hammer the Host.
     */
    static void refresh(Context context, boolean force) {
        if (context == null) return;
        final Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        if (!Storage.isPaired(app)) return;
        long now = System.currentTimeMillis();
        if (sFetching || (!force && now - sLastFetchMs < REFRESH_THROTTLE_MS)) return;
        sFetching = true;
        sLastFetchMs = now;
        final String scope = scopeOf(app);
        new Thread(() -> {
            try {
                JSONObject p = HostApiClient.getProfile(app);
                // Drop the answer if the device re-paired while the request was in flight.
                if (scope.equals(scopeOf(app))) apply(app, p);
            } catch (Throwable t) {
                Log.w(TAG, "profile refresh failed: " + t.getMessage());
            } finally {
                sFetching = false;
            }
        }, "RokBotProfileRefresh").start();
    }

    private static void notifyListener() {
        Runnable l = sListener;
        if (l == null) return;
        try {
            if (Looper.myLooper() == Looper.getMainLooper()) {
                l.run();
            } else {
                new Handler(Looper.getMainLooper()).post(l);
            }
        } catch (Throwable ignored) {}
    }
}

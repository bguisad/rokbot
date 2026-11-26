package dev.rokbot.nativeapp;

/**
 * The single source of truth for the user's Bot avatar style. Every place that draws a Bot (the
 * React Native overlays of {@link RokBotAvatarManager}, the share sheet, notification large icons,
 * the style picker) reads {@link #current}; only {@link #select} changes it.
 *
 * <p>The stored value is read once, synchronously, and kept in memory (the bootstrap preloads it at
 * Application start, before any Activity draws), so no frame ever falls back to a default while the
 * preference is still being read. Only an explicit "official" pick shows the official marks; a
 * missing, unreadable or unknown value is the RokBot default style.
 *
 * <p>No android imports: unit-tested on a plain JVM (android/tests/avatar-style.test.mjs).
 */
final class RokBotAvatarStyle {
    static final String CHASSIS = "chassis";
    static final String ANTENNA = "antenna";
    static final String VISOR = "visor";
    static final String PIXEL = "pixel";
    static final String ORB = "orb";
    static final String OFFICIAL = "official";
    static final String[] IDS = { CHASSIS, ANTENNA, VISOR, PIXEL, ORB, OFFICIAL };

    static final String PREF_KEY = "avatarStyle";
    static final String DEFAULT = CHASSIS;

    /**
     * An overlay whose mark a full scan missed gives the official views back only after this many
     * consecutive misses (or at once when its views left the host / the window, or the style is
     * "official"): one missed heuristic match must never flash the official mark.
     */
    static final int RELEASE_AFTER_MISSES = 3;

    /** Where the style is persisted (Storage's SharedPreferences on Android). */
    interface Store {
        String read(String key);
        void write(String key, String value);
    }

    private static final Object LOCK = new Object();
    private static volatile String sCurrent;

    private RokBotAvatarStyle() {}

    static boolean isValid(String id) {
        if (id == null) return false;
        for (String known : IDS) if (known.equals(id)) return true;
        return false;
    }

    /** A stored value as a style: unknown / missing values are the default style, never "official". */
    static String resolve(String stored) {
        return isValid(stored) ? stored : DEFAULT;
    }

    /**
     * The style in effect. The first call reads the store synchronously and caches the result; a
     * failed read answers the default style without caching it, so the next call reads again.
     */
    static String current(Store store) {
        String s = sCurrent;
        if (s != null) return s;
        synchronized (LOCK) {
            if (sCurrent != null) return sCurrent;
            if (store == null) return DEFAULT;
            String raw;
            try {
                raw = store.read(PREF_KEY);
            } catch (Throwable t) {
                return DEFAULT;
            }
            sCurrent = resolve(raw);
            return sCurrent;
        }
    }

    /** Persists the user's pick (synchronously) and makes it the style in effect. */
    static boolean select(Store store, String id) {
        if (store == null || !isValid(id)) return false;
        synchronized (LOCK) {
            store.write(PREF_KEY, id);
            sCurrent = id;
        }
        return true;
    }

    static boolean isOfficial(String style) {
        return OFFICIAL.equals(style);
    }

    /**
     * Whether an overlay entry that the latest full scan did not match may restore its official
     * views (make them VISIBLE again).
     *
     * @param styleOfficial the user picked "official" (or Bot styles are off: not paired)
     * @param viewsStillShown the hidden official views are still attached under the overlay host
     * @param misses consecutive full scans that missed this entry, this one included
     */
    static boolean shouldRelease(boolean styleOfficial, boolean viewsStillShown, int misses) {
        return styleOfficial || !viewsStillShown || misses >= RELEASE_AFTER_MISSES;
    }

    /**
     * Whether the per-frame (pre-draw) pass must (re)apply a mark it found: some official view of
     * the mark is still visible, it has no overlay yet, or its host changed size / selection.
     */
    static boolean needsApply(boolean hasEntry, boolean anyOfficialVisible, boolean geometryChanged) {
        return !hasEntry || anyOfficialVisible || geometryChanged;
    }

    /** Test hook: forget the cached value (a new process). */
    static void resetForTest() {
        synchronized (LOCK) {
            sCurrent = null;
        }
    }
}

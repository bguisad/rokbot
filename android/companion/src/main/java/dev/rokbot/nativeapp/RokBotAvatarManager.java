package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.ViewTreeObserver;
import java.lang.ref.WeakReference;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Manages the user's chosen dynamic Bot avatar style ({@code Storage.getStringPref("avatarStyle")})
 * and replaces official {@code com.horcrux.svg.SvgView} GrokBotMark instances across the React
 * Native view hierarchy while preserving every Bot's individual color and live interactions.
 */
final class RokBotAvatarManager {
    static final String PREF_KEY = "avatarStyle";
    static final String DEFAULT_STYLE = RokBotAvatarRenderer.STYLE_CHASSIS;

    private static final int TAG_HOOK_INSTALLED = 0x0e0a7a00;
    private static final int TAG_OVERLAY_VIEW = 0x0e0a7a01;
    private static final int TAG_COLOR_CACHE = 0x0e0a7a02;
    private static final int TAG_STYLE_CACHE = 0x0e0a7a03;

    private static final Set<Runnable> LISTENERS = Collections.newSetFromMap(new WeakHashMap<>());
    private static WeakReference<Activity> sReactActivity = new WeakReference<>(null);
    private static final android.os.Handler sMain = new android.os.Handler(android.os.Looper.getMainLooper());
    private static boolean sScanScheduled = false;

    private static final Runnable SCAN_RUNNABLE = () -> {
        sScanScheduled = false;
        Activity act = sReactActivity.get();
        if (act != null && !act.isFinishing() && !act.isDestroyed()) {
            applyToActivity(act);
        }
    };

    private RokBotAvatarManager() {}

    static String getStyle(Context context) {
        if (context == null) return DEFAULT_STYLE;
        String stored = Storage.getStringPref(context, PREF_KEY, DEFAULT_STYLE);
        return RokBotAvatarRenderer.isValidStyle(stored) ? stored : DEFAULT_STYLE;
    }

    static void setStyle(Context context, String styleId) {
        if (context == null || !RokBotAvatarRenderer.isValidStyle(styleId)) return;
        Storage.setStringPref(context, PREF_KEY, styleId);
        for (Runnable listener : LISTENERS.toArray(new Runnable[0])) {
            if (listener != null) {
                try { listener.run(); } catch (Throwable ignored) {}
            }
        }
        Activity act = sReactActivity.get();
        if (act != null && !act.isFinishing() && !act.isDestroyed()) {
            act.runOnUiThread(() -> applyToActivity(act));
        }
    }

    static void addListener(Runnable listener) {
        if (listener != null) LISTENERS.add(listener);
    }

    static void onReactResumed(Activity activity) {
        if (activity == null) return;
        sReactActivity = new WeakReference<>(activity);
        RokBotAvatarView.setAppForeground(true);
        ViewGroup content = activity.findViewById(android.R.id.content);
        if (content != null && content.getTag(TAG_HOOK_INSTALLED) == null) {
            content.setTag(TAG_HOOK_INSTALLED, Boolean.TRUE);
            ViewTreeObserver vto = content.getViewTreeObserver();
            vto.addOnGlobalLayoutListener(() -> scheduleScan(40L));
            vto.addOnScrollChangedListener(() -> scheduleScan(60L));
        }
        scheduleScan(0L);
    }

    static void onReactPaused(Activity activity) {
        sMain.removeCallbacks(SCAN_RUNNABLE);
        sScanScheduled = false;
        RokBotAvatarView.setAppForeground(false);
    }

    private static void scheduleScan(long delayMs) {
        if (sScanScheduled) return;
        sScanScheduled = true;
        sMain.postDelayed(SCAN_RUNNABLE, delayMs);
    }

    static void applyToActivity(Activity activity) {
        if (activity == null) return;
        ViewGroup content = activity.findViewById(android.R.id.content);
        if (content == null) return;
        String style = getStyle(activity);
        boolean official = RokBotAvatarRenderer.STYLE_OFFICIAL.equals(style);
        scanTree(activity, content, style, official, 0);
    }

    /**
     * Identifies official `pele` GrokBotMark `com.horcrux.svg.SvgView` nodes strictly by their
     * square geometry + negative halo bleed inside their wrapper container, leaving UI glyphs intact.
     */
    private static boolean isGrokBotMarkSvg(View v) {
        if (v == null) return false;
        if (!"com.horcrux.svg.SvgView".equals(v.getClass().getName())) return false;
        int w = v.getWidth();
        int h = v.getHeight();
        if (w < 24 || h < 24) return false;
        if (Math.abs(w - h) > Math.max(4, (int) (Math.max(w, h) * 0.14f))) return false;
        ViewParent parent = v.getParent();
        if (!(parent instanceof ViewGroup)) return false;
        ViewGroup pg = (ViewGroup) parent;
        int pw = pg.getWidth();
        int ph = pg.getHeight();
        if (pw <= 0 || ph <= 0) return false;
        int left = v.getLeft();
        int top = v.getTop();
        // Matches pele's negative halo padding (-26.6% margin on each side around the square avatar).
        return left < -1 && top < -1 && Math.abs(left - top) <= 5 && w > pw * 1.25f;
    }

    private static void scanTree(Context ctx, View v, String style, boolean official, int depth) {
        if (v == null || depth > 42 || v instanceof RokBotAvatarView) return;
        if (isGrokBotMarkSvg(v)) {
            ViewGroup parent = (ViewGroup) v.getParent();
            if (official) {
                if (v.getAlpha() < 0.99f) v.setAlpha(1f);
                Object existing = parent.getTag(TAG_OVERLAY_VIEW);
                if (existing instanceof RokBotAvatarView) {
                    RokBotAvatarView ov = (RokBotAvatarView) existing;
                    if (ov.getVisibility() != View.GONE) ov.setVisibility(View.GONE);
                }
            } else {
                Integer cachedColor = (v.getTag(TAG_COLOR_CACHE) instanceof Integer)
                        ? (Integer) v.getTag(TAG_COLOR_CACHE)
                        : null;
                if (cachedColor == null) {
                    int sampled = RokBotAvatarRenderer.extractDominantColor(v, 0xFF06B6D4);
                    v.setTag(TAG_COLOR_CACHE, sampled);
                    cachedColor = sampled;
                }
                if (v.getAlpha() > 0.01f) v.setAlpha(0f);

                RokBotAvatarView ov = parent.getTag(TAG_OVERLAY_VIEW) instanceof RokBotAvatarView
                        ? (RokBotAvatarView) parent.getTag(TAG_OVERLAY_VIEW)
                        : null;
                if (ov == null || ov.getParent() != parent) {
                    ov = new RokBotAvatarView(ctx);
                    parent.setTag(TAG_OVERLAY_VIEW, ov);
                    parent.addView(ov);
                }
                if (ov.getVisibility() != View.VISIBLE) ov.setVisibility(View.VISIBLE);
                int pw = parent.getWidth();
                int ph = parent.getHeight();
                if (ov.getLeft() != 0 || ov.getTop() != 0 || ov.getRight() != pw || ov.getBottom() != ph) {
                    ov.measure(
                            View.MeasureSpec.makeMeasureSpec(pw, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(ph, View.MeasureSpec.EXACTLY));
                    ov.layout(0, 0, pw, ph);
                }
                ov.setBaseColor(cachedColor);
                ov.setStyleId(style);
                v.setTag(TAG_STYLE_CACHE, style);
            }
            return;
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            int n = g.getChildCount();
            for (int i = 0; i < n; i++) {
                scanTree(ctx, g.getChildAt(i), style, official, depth + 1);
            }
        }
    }
}

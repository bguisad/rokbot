package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Replaces the official app mark (the black round Grok Bot face) that React Native draws with
 * react-native-svg in the Settings footer above "rokbot" and the version line ({@code about-mark}),
 * and on the launch / signed-out / tour / blocked / bundle-override screens, with the white-tile
 * RokBot logo ({@link RokBotLogo}, vectors at the mark's own size).
 *
 * <p>Marks are found by the app's own testIDs (view tag {@code R.id.react_test_id}). Nothing is
 * added to React Native view groups: the official SvgViews are only made INVISIBLE and the logo is
 * drawn in the mark view's ViewOverlay. Fabric mounts views without a layout pass, so scans follow
 * drawn frames (throttled to {@link #SCAN_INTERVAL_MS}) instead of global layout.
 */
final class RokBotAppMarks {
    static final Set<String> APP_MARK_TEST_IDS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "about-mark", "launch-mark", "signed-out-cover-mark", "tour-mark", "blocked-mark", "bundle-override-mark")));
    static final String SVG_VIEW_CLASS = "com.horcrux.svg.SvgView";
    static final long SCAN_INTERVAL_MS = 250L;

    private static final int TAG_HOOK_INSTALLED = 0x0e0a7b00;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Map<View, Entry> MARKS = new WeakHashMap<>();

    private static WeakReference<Activity> sActivity = new WeakReference<>(null);
    private static boolean sScheduled;
    private static long sLastScan;
    private static int sGeneration;
    private static int sTestIdKey = -1;

    private static final class Entry {
        final RokBotLogo.LogoDrawable drawable = new RokBotLogo.LogoDrawable();
        final List<WeakReference<View>> hidden = new ArrayList<>();
        int generation;
    }

    private static final Runnable SCAN = () -> {
        sScheduled = false;
        sLastScan = SystemClock.uptimeMillis();
        Activity act = sActivity.get();
        if (act != null && !act.isFinishing() && !act.isDestroyed()) {
            try { scan(act); } catch (Throwable ignored) {}
        }
    };

    private RokBotAppMarks() {}

    static void onReactResumed(Activity activity) {
        if (activity == null) return;
        sActivity = new WeakReference<>(activity);
        View content = activity.findViewById(android.R.id.content);
        if (content != null && content.getTag(TAG_HOOK_INSTALLED) == null) {
            content.setTag(TAG_HOOK_INSTALLED, Boolean.TRUE);
            ViewTreeObserver vto = content.getViewTreeObserver();
            vto.addOnDrawListener(RokBotAppMarks::schedule);
            vto.addOnGlobalLayoutListener(RokBotAppMarks::schedule);
        }
        schedule();
    }

    static void onReactPaused(Activity activity) {
        MAIN.removeCallbacks(SCAN);
        sScheduled = false;
    }

    private static void schedule() {
        if (sScheduled) return;
        sScheduled = true;
        long wait = Math.max(0L, sLastScan + SCAN_INTERVAL_MS - SystemClock.uptimeMillis());
        MAIN.postDelayed(SCAN, wait);
    }

    private static void scan(Activity act) {
        View content = act.findViewById(android.R.id.content);
        if (content == null) return;
        int gen = ++sGeneration;
        scanTree(act, content, gen, 0);
        // A mark view that no longer carries an app-mark id (recycled) gets its official look back.
        for (Map.Entry<View, Entry> e : new ArrayList<>(MARKS.entrySet())) {
            if (e.getValue().generation == gen) continue;
            release(e.getKey(), e.getValue());
            MARKS.remove(e.getKey());
        }
    }

    private static void release(View host, Entry entry) {
        try { host.getOverlay().remove(entry.drawable); } catch (Throwable ignored) {}
        for (WeakReference<View> ref : entry.hidden) {
            View v = ref.get();
            if (v != null && v.getVisibility() == View.INVISIBLE) v.setVisibility(View.VISIBLE);
        }
    }

    private static void scanTree(Context ctx, View v, int gen, int depth) {
        if (v == null || depth > 96 || v.getVisibility() == View.GONE || isSvg(v)) return;
        String id = testIdOf(ctx, v);
        if (id != null && APP_MARK_TEST_IDS.contains(id) && v instanceof ViewGroup && apply((ViewGroup) v, gen)) {
            return;
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) scanTree(ctx, g.getChildAt(i), gen, depth + 1);
        }
    }

    private static boolean apply(ViewGroup mark, int gen) {
        List<View> svgs = new ArrayList<>();
        collectSvgs(mark, svgs, 0);
        if (svgs.isEmpty()) return false;
        Entry e = MARKS.get(mark);
        if (e == null) {
            e = new Entry();
            MARKS.put(mark, e);
            mark.getOverlay().add(e.drawable);
        }
        e.generation = gen;
        View first = svgs.get(0);
        int[] off = offsetWithin(first, mark);
        e.drawable.setBounds(off[0], off[1], off[0] + first.getWidth(), off[1] + first.getHeight());
        for (View sv : svgs) {
            boolean known = false;
            for (WeakReference<View> ref : e.hidden) if (ref.get() == sv) { known = true; break; }
            if (!known) e.hidden.add(new WeakReference<>(sv));
            if (sv.getVisibility() == View.VISIBLE) sv.setVisibility(View.INVISIBLE);
        }
        return true;
    }

    private static void collectSvgs(View v, List<View> out, int depth) {
        if (v == null || depth > 8) return;
        if (isSvg(v)) { out.add(v); return; }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) collectSvgs(g.getChildAt(i), out, depth + 1);
        }
    }

    private static int[] offsetWithin(View v, View ancestor) {
        int x = 0, y = 0;
        View cur = v;
        while (cur != null && cur != ancestor) {
            x += cur.getLeft();
            y += cur.getTop();
            cur = cur.getParent() instanceof View ? (View) cur.getParent() : null;
        }
        return new int[] { x, y };
    }

    private static boolean isSvg(View v) {
        return v != null && SVG_VIEW_CLASS.equals(v.getClass().getName());
    }

    /** React Native keeps testID in the view tag R.id.react_test_id of the official package. */
    private static String testIdOf(Context ctx, View v) {
        if (sTestIdKey == -1) {
            int key = 0;
            for (String pkg : new String[] { ctx.getPackageName(), "ai.x.grok.bot", "co.anysphere.sand" }) {
                try {
                    key = ctx.getResources().getIdentifier("react_test_id", "id", pkg);
                } catch (Throwable ignored) {}
                if (key != 0) break;
            }
            sTestIdKey = key;
        }
        if (sTestIdKey == 0) return null;
        Object tag = v.getTag(sTestIdKey);
        return tag instanceof String ? (String) tag : null;
    }
}

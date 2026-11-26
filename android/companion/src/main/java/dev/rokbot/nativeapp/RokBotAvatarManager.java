package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.ViewTreeObserver;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Applies the user's RokBot avatar style ({@link RokBotAvatarStyle}) to every
 * official Bot mark React Native draws, wherever it is:
 *
 * <ul>
 *   <li>still marks (Bot list rows, chat title, Bot details, Edit Bot, avatar preview, search and
 *       switcher rows): the container holding the {@code still-avatar-body} and
 *       {@code still-avatar-eyes} test ids;</li>
 *   <li>the animated mark (running Bots, the Create New Bot preview): a square
 *       {@code com.horcrux.svg.SvgView} bleeding its halo outside its square parent;</li>
 *   <li>shape picker cells (Create New Bot, Edit Bot &gt; Avatar &gt; Shape): buttons labelled
 *       "&lt;shape&gt; character shape".</li>
 * </ul>
 *
 * The official views are made INVISIBLE (never removed) and a {@link RokBotAvatarDrawable} drawn in
 * the host view's {@link android.view.ViewGroupOverlay} takes their place, with the Bot's own color
 * and exact silhouette read from the official SVG as a vector path ({@link RokBotSvgVector}), drawn
 * at the overlay's pixel size. "official" restores everything.
 *
 * <p>No official mark is ever drawn while a RokBot style is in effect:
 * <ul>
 *   <li>the style comes from {@link RokBotAvatarStyle} (read once, synchronously, preloaded at
 *       Application start), shared with the share sheet and notification icons;</li>
 *   <li>before every frame of a React window ({@link ViewTreeObserver.OnPreDrawListener}) a light
 *       pass hides every official mark that is still visible and gives it its overlay, so a newly
 *       mounted mark (cold start, a new screen, a recycled list row, a Bot that starts running, a
 *       recreated Activity) is first drawn already replaced;</li>
 *   <li>the throttled full scan refreshes colors / bounds and gives official views back only when
 *       {@link RokBotAvatarStyle#shouldRelease} says so (they left the screen, several scans in a
 *       row missed them, or the user picked "official"), never after one missed match.</li>
 * </ul>
 */
final class RokBotAvatarManager {
    static final String PREF_KEY = RokBotAvatarStyle.PREF_KEY;
    static final String DEFAULT_STYLE = RokBotAvatarStyle.DEFAULT;
    private static final String TAG = "RokBotAvatar";
    private static final String HARVEST_TAG = "RokBotAvatarHarvest";

    static final String TEST_ID_BODY = "still-avatar-body";
    static final String TEST_ID_EYES = "still-avatar-eyes";
    static final String SHAPE_CELL_SUFFIX = " character shape";
    /** Official app marks (the black Grok Bot blob): replaced by the RokBot logo in every style. */
    static final Set<String> APP_MARK_TEST_IDS = new java.util.HashSet<>(java.util.Arrays.asList(
            "about-mark", "launch-mark", "signed-out-cover-mark", "tour-mark", "blocked-mark", "bundle-override-mark"));
    private static final String SVG_VIEW_CLASS = "com.horcrux.svg.SvgView";

    private static final int TAG_HOOK_INSTALLED = 0x0e0a7a00;

    private static final Set<Runnable> LISTENERS = Collections.newSetFromMap(new WeakHashMap<>());
    private static WeakReference<Activity> sReactActivity = new WeakReference<>(null);
    private static final android.os.Handler sMain = new android.os.Handler(android.os.Looper.getMainLooper());
    private static boolean sScanScheduled = false;
    private static int sTestIdKey = -1;
    private static int sGeneration = 0;
    private static final Map<View, Entry> ENTRIES = new WeakHashMap<>();
    private static final Map<View, LogoEntry> LOGOS = new WeakHashMap<>();

    private static final class LogoEntry {
        final RokBotLogo.LogoDrawable drawable = new RokBotLogo.LogoDrawable();
        final List<WeakReference<View>> hidden = new ArrayList<>();
        int generation;
        int misses;
    }
    private static final Set<String> HARVESTED = Collections.synchronizedSet(new java.util.HashSet<>());

    /** One host view carrying a RokBot overlay, plus the official views it hides. */
    private static final class Entry {
        final RokBotAvatarDrawable drawable = new RokBotAvatarDrawable();
        final List<WeakReference<View>> hidden = new ArrayList<>();
        RokBotSvgVector.Shape shape;
        /** Animated mark: per-frame outline refresh. */
        LiveOutline follow;
        int generation;
        /** Consecutive full scans that did not find this mark. */
        int misses;
        /** Host size and picker selection the overlay was laid out for. */
        int hostW = -1;
        int hostH = -1;
        boolean selected;
    }

    private static final Runnable SCAN_RUNNABLE = () -> {
        sScanScheduled = false;
        Activity act = sReactActivity.get();
        if (act != null && !act.isFinishing() && !act.isDestroyed()) {
            applyToActivity(act);
        }
    };

    private RokBotAvatarManager() {}

    /** {@link RokBotAvatarStyle} persisted in Storage's SharedPreferences. */
    private static final class PrefStore implements RokBotAvatarStyle.Store {
        private final Context context;

        PrefStore(Context context) {
            this.context = context;
        }

        @Override
        public String read(String key) {
            return Storage.getStringPref(context, key, null);
        }

        @Override
        public void write(String key, String value) {
            Storage.setStringPref(context, key, value);
        }
    }

    /** Application start: read the style before any Activity draws. */
    static void preload(Context context) {
        getStyle(context);
    }

    /** The style in effect (the one cached source for every Bot icon). */
    static String getStyle(Context context) {
        return RokBotAvatarStyle.current(context != null ? new PrefStore(context) : null);
    }

    static void setStyle(Context context, String styleId) {
        if (context == null || !RokBotAvatarStyle.select(new PrefStore(context), styleId)) return;
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
        boolean reduced = false;
        try {
            reduced = Settings.Global.getFloat(activity.getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f) <= 0f;
        } catch (Throwable ignored) {}
        RokBotAvatarView.setAppForeground(true);
        RokBotAvatarDrawable.setForeground(true, reduced);
        View decor = activity.getWindow() != null ? activity.getWindow().getDecorView() : null;
        if (decor != null && decor.getTag(TAG_HOOK_INSTALLED) == null) {
            decor.setTag(TAG_HOOK_INSTALLED, Boolean.TRUE);
            // Fabric mounts and moves React views without a layout traversal, so global-layout alone
            // misses most changes; every drawn frame asks for a (throttled) scan instead.
            ViewTreeObserver vto = decor.getViewTreeObserver();
            vto.addOnGlobalLayoutListener(() -> scheduleScan(40L));
            vto.addOnScrollChangedListener(() -> scheduleScan(60L));
            vto.addOnDrawListener(() -> scheduleScan(0L));
            // Before each frame: marks mounted since the last frame are replaced before they are drawn.
            final WeakReference<Activity> owner = new WeakReference<>(activity);
            vto.addOnPreDrawListener(() -> {
                applyBeforeFrame(owner.get());
                return true;
            });
        }
        scheduleScan(0L);
    }

    static void onReactPaused(Activity activity) {
        sMain.removeCallbacks(SCAN_RUNNABLE);
        sScanScheduled = false;
        RokBotAvatarView.setAppForeground(false);
        RokBotAvatarDrawable.setForeground(false, false);
    }

    private static final long MIN_SCAN_INTERVAL_MS = 250L;
    private static long sLastScanAt = 0L;

    private static void scheduleScan(long delayMs) {
        if (sScanScheduled) return;
        sScanScheduled = true;
        long sinceLast = SystemClock.uptimeMillis() - sLastScanAt;
        sMain.postDelayed(SCAN_RUNNABLE, Math.max(delayMs, MIN_SCAN_INTERVAL_MS - sinceLast));
    }

    /**
     * Bot avatar styles apply on the paired bundle unless the user picked "official". Pairing is
     * read from the stored credentials, not the decrypted token: one failed Keystore read must not
     * hand every mark back to the official look.
     */
    private static boolean stylesOn(Context context, String style) {
        return !RokBotAvatarStyle.isOfficial(style) && Storage.hasStoredCredentials(context);
    }

    private static boolean isDark(Activity activity) {
        return (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    private static long sPreDrawNanos = 0L;
    private static int sPreDrawCount = 0;

    /**
     * Pre-draw pass (every frame of a React window): hides every official mark still visible and
     * draws its RokBot overlay in this same frame. Marks already covered are skipped; nothing is
     * released here (that is the full scan's job).
     */
    static void applyBeforeFrame(Activity activity) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed() || activity.getWindow() == null) return;
        try {
            View root = activity.getWindow().getDecorView();
            if (root == null) return;
            long started = System.nanoTime();
            String style = getStyle(activity);
            int gen = sGeneration;
            scanAppMarks(activity, root, gen, 0, true);
            if (stylesOn(activity, style)) {
                scanTree(activity, root, style, isDark(activity), gen, 0, true);
            }
            sPreDrawNanos += System.nanoTime() - started;
            sPreDrawCount++;
            if (Log.isLoggable(AUDIT_TAG, Log.DEBUG) && stylesOn(activity, style)) {
                int shown = auditVisibleOfficial(activity, root, 0);
                if (shown > 0) Log.d(AUDIT_TAG, "official marks drawn this frame: " + shown);
            }
        } catch (Throwable t) {
            // Never break a frame of the host app.
            Log.w(TAG, "pre-draw pass: " + t);
        }
    }

    static void applyToActivity(Activity activity) {
        if (activity == null || activity.getWindow() == null) return;
        View root = activity.getWindow().getDecorView();
        if (root == null) return;
        long started = SystemClock.uptimeMillis();
        sLastScanAt = started;
        String style = getStyle(activity);
        boolean on = stylesOn(activity, style);
        int gen = ++sGeneration;
        int found = scanAppMarks(activity, root, gen, 0, false);
        // App marks become the RokBot logo everywhere; Bot avatar styles only on the paired bundle.
        if (on) {
            found = scanTree(activity, root, style, isDark(activity), gen, 0, false);
        }
        Iterator<Map.Entry<View, LogoEntry>> lt = LOGOS.entrySet().iterator();
        while (lt.hasNext()) {
            Map.Entry<View, LogoEntry> e = lt.next();
            LogoEntry le = e.getValue();
            if (le.generation == gen) {
                le.misses = 0;
                continue;
            }
            le.misses++;
            if (!RokBotAvatarStyle.shouldRelease(false, stillShown(e.getKey(), le.hidden), le.misses)) continue;
            try { e.getKey().getOverlay().remove(le.drawable); } catch (Throwable ignored) {}
            for (WeakReference<View> ref : le.hidden) {
                View hv = ref.get();
                if (hv != null && hv.getVisibility() == View.INVISIBLE) hv.setVisibility(View.VISIBLE);
            }
            lt.remove();
        }
        // Drop overlays whose host no longer shows a Bot mark (recycled rows, closed screens, "official").
        // A mark a scan merely missed keeps its overlay for a few scans: no flash of the official mark.
        Iterator<Map.Entry<View, Entry>> it = ENTRIES.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<View, Entry> e = it.next();
            Entry en = e.getValue();
            if (en.generation == gen) {
                en.misses = 0;
                continue;
            }
            en.misses++;
            if (RokBotAvatarStyle.shouldRelease(!on, stillShown(e.getKey(), en.hidden), en.misses)) {
                release(e.getKey(), en);
                it.remove();
            }
        }
        if (Log.isLoggable(TAG, Log.DEBUG)) {
            long avgUs = sPreDrawCount > 0 ? sPreDrawNanos / sPreDrawCount / 1000L : 0L;
            Log.d(TAG, "scan " + activity.getClass().getSimpleName() + " views=" + countViews(root) + " style=" + style
                    + " marks=" + found + " overlays=" + ENTRIES.size() + " in " + (SystemClock.uptimeMillis() - started)
                    + "ms preDraw=" + sPreDrawCount + "x" + avgUs + "us");
            sPreDrawNanos = 0L;
            sPreDrawCount = 0;
        }
    }

    /** Debug (adb shell setprop log.tag.RokBotAvatarAudit DEBUG): official marks about to be drawn. */
    private static final String AUDIT_TAG = "RokBotAvatarAudit";

    /** Bot marks whose official views are still VISIBLE (read-only; same matching as scanTree). */
    static int auditVisibleOfficial(Activity act, View v, int depth) {
        if (v == null || depth > 96 || v.getVisibility() != View.VISIBLE) return 0;
        if (isSvg(v)) return isAnimatedMarkSvg(v) ? 1 : 0;
        if (!(v instanceof ViewGroup)) return 0;
        ViewGroup g = (ViewGroup) v;
        CharSequence desc = g.getContentDescription();
        if (desc != null && desc.toString().endsWith(SHAPE_CELL_SUFFIX)) {
            View svg = singleSvgChild(g);
            if (svg != null) return isVisible(svg) ? 1 : 0;
        }
        int found = 0;
        for (int i = 0; i < g.getChildCount(); i++) {
            View child = g.getChildAt(i);
            if (TEST_ID_EYES.equals(testIdOf(act, child))) {
                View body = findStillBody(act, g, child);
                if (body != null) return found + (isVisible(body) || isVisible(child) ? 1 : 0);
            }
        }
        for (int i = 0; i < g.getChildCount(); i++) found += auditVisibleOfficial(act, g.getChildAt(i), depth + 1);
        return found;
    }

    /** The hidden official views are still on screen under their overlay host. */
    private static boolean stillShown(View host, List<WeakReference<View>> hidden) {
        if (host == null || !host.isAttachedToWindow()) return false;
        boolean any = false;
        for (WeakReference<View> ref : hidden) {
            View v = ref.get();
            if (v == null || !v.isAttachedToWindow()) continue;
            if (!isDescendant(v, host)) continue;
            any = true;
        }
        return any;
    }

    private static boolean isDescendant(View v, View ancestor) {
        ViewParent p = v.getParent();
        for (int depth = 0; p != null && depth < 32; depth++) {
            if (p == ancestor) return true;
            p = p.getParent();
        }
        return false;
    }

    private static boolean isVisible(View v) {
        return v != null && v.getVisibility() == View.VISIBLE;
    }

    private static int countViews(View v) {
        if (!(v instanceof ViewGroup)) return 1;
        int c = 1;
        ViewGroup g = (ViewGroup) v;
        for (int i = 0; i < g.getChildCount(); i++) c += countViews(g.getChildAt(i));
        return c;
    }

    private static void release(View host, Entry entry) {
        entry.drawable.detach();
        if (host != null) {
            try { host.getOverlay().remove(entry.drawable); } catch (Throwable ignored) {}
        }
        for (WeakReference<View> ref : entry.hidden) {
            View v = ref.get();
            if (v != null && v.getVisibility() == View.INVISIBLE) v.setVisibility(View.VISIBLE);
        }
    }

    private static int scanTree(Activity act, View v, String style, boolean dark, int gen, int depth, boolean fast) {
        if (v == null || depth > 96 || v.getVisibility() == View.GONE) return 0;
        if (isSvg(v)) {
            // SvgView is a ViewGroup of virtual SVG nodes: never descend into it.
            if (isAnimatedMarkSvg(v)) {
                applyAnimated((ViewGroup) v.getParent(), v, style, dark, gen, fast);
                return 1;
            }
            return 0;
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            CharSequence desc = g.getContentDescription();
            if (desc != null && desc.toString().endsWith(SHAPE_CELL_SUFFIX)) {
                View svg = singleSvgChild(g);
                if (svg != null) {
                    applyShapeCell(g, svg, desc.toString(), style, dark, gen, fast);
                    return 1;
                }
            }
            int n = g.getChildCount();
            int found = 0;
            for (int i = 0; i < n; i++) {
                View child = g.getChildAt(i);
                if (TEST_ID_EYES.equals(testIdOf(act, child))) {
                    View body = findStillBody(act, g, child);
                    if (body != null) {
                        applyStill(g, body, child, style, dark, gen, fast);
                        return found + 1;
                    }
                    // testID sitting on the eyes SvgView itself, inside its own wrapper.
                    if (n == 1 && g.getParent() instanceof ViewGroup) {
                        ViewGroup container = (ViewGroup) g.getParent();
                        body = findStillBody(act, container, g);
                        if (body != null) {
                            applyStill(container, body, g, style, dark, gen, fast);
                            return 1;
                        }
                    }
                }
            }
            for (int i = 0; i < n; i++) {
                found += scanTree(act, g.getChildAt(i), style, dark, gen, depth + 1, fast);
            }
            return found;
        }
        return 0;
    }

    /** Official app-logo marks (About footer, launch / signed-out / tour screens) become the RokBot logo. */
    private static int scanAppMarks(Activity act, View v, int gen, int depth, boolean fast) {
        if (v == null || depth > 96 || v.getVisibility() == View.GONE || isSvg(v)) return 0;
        String id = testIdOf(act, v);
        if (id != null && APP_MARK_TEST_IDS.contains(id) && v instanceof ViewGroup) {
            List<View> svgs = new ArrayList<>();
            collectSvgs(v, svgs, 0);
            if (!svgs.isEmpty()) {
                LogoEntry e = LOGOS.get(v);
                if (fast && e != null) {
                    boolean anyVisible = false;
                    for (View sv : svgs) anyVisible |= isVisible(sv);
                    if (!anyVisible) return 1;
                }
                if (e == null) {
                    e = new LogoEntry();
                    e.generation = gen;
                    LOGOS.put(v, e);
                    v.getOverlay().add(e.drawable);
                }
                if (!fast) e.generation = gen;
                View first = svgs.get(0);
                int[] off = offsetWithin(first, v);
                e.drawable.setBounds(off[0], off[1], off[0] + first.getWidth(), off[1] + first.getHeight());
                for (View sv : svgs) {
                    boolean known = false;
                    for (WeakReference<View> ref : e.hidden) if (ref.get() == sv) { known = true; break; }
                    if (!known) e.hidden.add(new WeakReference<>(sv));
                    if (sv.getVisibility() == View.VISIBLE) sv.setVisibility(View.INVISIBLE);
                }
                return 1;
            }
        }
        int found = 0;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) found += scanAppMarks(act, g.getChildAt(i), gen, depth + 1, fast);
        }
        return found;
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

    private static View singleSvgChild(ViewGroup g) {
        View only = null;
        for (int i = 0; i < g.getChildCount(); i++) {
            View c = g.getChildAt(i);
            if (isSvg(c)) {
                if (only != null) return null;
                only = c;
            }
        }
        return only;
    }

    /** The body SvgView next to the eyes view: a direct SvgView sibling or one wrapped alone in a view. */
    private static View findStillBody(Activity act, ViewGroup container, View eyes) {
        for (int i = 0; i < container.getChildCount(); i++) {
            View c = container.getChildAt(i);
            if (c == eyes) continue;
            View svg = null;
            if (isSvg(c)) svg = c;
            else if (c instanceof ViewGroup && ((ViewGroup) c).getChildCount() == 1 && isSvg(((ViewGroup) c).getChildAt(0))) {
                svg = ((ViewGroup) c).getChildAt(0);
            }
            if (svg != null && containsTestId(act, svg, TEST_ID_BODY, 0)) return svg;
        }
        return null;
    }

    private static boolean containsTestId(Activity act, View v, String id, int depth) {
        if (v == null || depth > 6) return false;
        if (id.equals(testIdOf(act, v))) return true;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                if (containsTestId(act, g.getChildAt(i), id, depth + 1)) return true;
            }
        }
        return false;
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

    /** Official animated mark: square SvgView whose halo bleeds outside its square parent. */
    private static boolean isAnimatedMarkSvg(View v) {
        if (!isSvg(v)) return false;
        int w = v.getWidth();
        int h = v.getHeight();
        if (w < 24 || h < 24) return false;
        if (Math.abs(w - h) > Math.max(4, (int) (Math.max(w, h) * 0.14f))) return false;
        ViewParent parent = v.getParent();
        if (!(parent instanceof ViewGroup)) return false;
        ViewGroup pg = (ViewGroup) parent;
        int pw = pg.getWidth();
        int ph = pg.getHeight();
        if (pw <= 0 || ph <= 0 || Math.abs(pw - ph) > Math.max(4, pw / 8)) return false;
        int left = v.getLeft();
        int top = v.getTop();
        return left < -1 && top < -1 && Math.abs(left - top) <= 5 && w > pw * 1.25f;
    }

    /**
     * The overlay entry of a host. The pre-draw pass ({@code fast}) creates entries but does not
     * mark existing ones as found: only full scans decide what is still a mark.
     */
    private static Entry entryFor(View host, int gen, boolean fast) {
        Entry e = ENTRIES.get(host);
        if (e == null) {
            e = new Entry();
            e.generation = gen;
            ENTRIES.put(host, e);
            host.getOverlay().add(e.drawable);
        }
        if (!fast) e.generation = gen;
        return e;
    }

    /** Pre-draw pass: nothing to do when the mark is covered and its host kept its size. */
    private static boolean covered(View host, boolean anyOfficialVisible, boolean selected) {
        Entry e = ENTRIES.get(host);
        boolean changed = e != null && (e.hostW != host.getWidth() || e.hostH != host.getHeight() || e.selected != selected);
        return !RokBotAvatarStyle.needsApply(e != null && e.shape != null, anyOfficialVisible, changed);
    }

    private static void hide(Entry e, View v) {
        if (v == null) return;
        boolean known = false;
        for (WeakReference<View> ref : e.hidden) if (ref.get() == v) { known = true; break; }
        if (!known) e.hidden.add(new WeakReference<>(v));
        if (v.getVisibility() == View.VISIBLE) v.setVisibility(View.INVISIBLE);
    }

    private static final float ANIMATED_MARGIN = 0.12f;
    private static void applyStill(ViewGroup container, View bodySvg, View eyes, String style, boolean dark, int gen, boolean fast) {
        if (fast && covered(container, isVisible(bodySvg) || isVisible(eyes), false)) return;
        Entry e = entryFor(container, gen, fast);
        probe(bodySvg, "still");
        RokBotSvgVector.Shape s = RokBotSvgVector.extract(bodySvg, container, 0f, e.shape);
        if (s != null) e.shape = s;
        if (e.shape == null) return;
        e.drawable.setBounds(0, 0, container.getWidth(), container.getHeight());
        e.hostW = container.getWidth();
        e.hostH = container.getHeight();
        e.drawable.update(style, e.shape.path, e.shape.color, false, false, 0, dark);
        hide(e, bodySvg);
        hide(e, eyes);
    }

    /**
     * The animated mark morphs (path and scale) every frame. Its RokBot stand-in follows the same
     * live vector outline: a scan sets it up (color sampled), then every animation tick re-reads the
     * official path before the frame is drawn, so the morph stays as smooth as the original.
     */
    private static void applyAnimated(ViewGroup parent, View svg, String style, boolean dark, int gen, boolean fast) {
        if (fast && covered(parent, isVisible(svg), false)) {
            Entry known = ENTRIES.get(parent);
            if (known.follow != null && known.follow.svg.get() == svg) return;
        }
        Entry e = entryFor(parent, gen, fast);
        probe(svg, "animated");
        // The animated mark wobbles, scales and rotates past its square container (React Native
        // does not clip it there), so the RokBot mark gets a margin around the container too.
        RokBotSvgVector.Shape s = RokBotSvgVector.extract(svg, parent, -ANIMATED_MARGIN, e.shape);
        if (s != null) e.shape = s;
        if (e.shape == null) return;
        int mx = Math.round(parent.getWidth() * ANIMATED_MARGIN);
        int my = Math.round(parent.getHeight() * ANIMATED_MARGIN);
        e.drawable.setBounds(-mx, -my, parent.getWidth() + mx, parent.getHeight() + my);
        e.hostW = parent.getWidth();
        e.hostH = parent.getHeight();
        e.drawable.update(style, e.shape.path, e.shape.color, true, false, 0, dark);
        if (e.follow == null || e.follow.svg.get() != svg) {
            e.follow = new LiveOutline(svg, parent, e);
            e.drawable.setBeforeFrame(e.follow);
        }
        hide(e, svg);
    }

    /** Per-frame refresh of an animated mark's outline (runs on the main thread before invalidation). */
    private static final class LiveOutline implements Runnable {
        final WeakReference<View> svg;
        final WeakReference<View> parent;
        final Entry entry;

        LiveOutline(View svg, View parent, Entry entry) {
            this.svg = new WeakReference<>(svg);
            this.parent = new WeakReference<>(parent);
            this.entry = entry;
        }

        @Override
        public void run() {
            View s = svg.get();
            View p = parent.get();
            if (s == null || p == null || s.getParent() != p || entry.shape == null) return;
            RokBotSvgVector.Shape next = RokBotSvgVector.extract(s, p, -ANIMATED_MARGIN, entry.shape, false);
            if (next != null && next != entry.shape) {
                entry.shape = next;
                entry.drawable.setShape(next.path);
            }
        }
    }

    private static void applyShapeCell(ViewGroup cell, View svg, String desc, String style, boolean dark, int gen, boolean fast) {
        boolean selected = cell.isSelected();
        if (fast && covered(cell, isVisible(svg), selected)) return;
        Entry e = entryFor(cell, gen, fast);
        probe(svg, selected ? "cell-selected " + desc : "cell " + desc);
        // The selected cell's SvgView is larger and also holds the outline ring (an unfilled stroke,
        // skipped by RokBotSvgVector); the shape sits in its inner SELECTED_INNER_SCALE box.
        float inset = selected ? (1f - RokBotAvatarRenderer.SELECTED_INNER_SCALE) / 2f : 0f;
        RokBotSvgVector.Shape s = RokBotSvgVector.extract(svg, svg, inset, e.shape);
        if (s != null) e.shape = s;
        if (e.shape == null) return;
        e.drawable.setBounds(svg.getLeft(), svg.getTop(), svg.getRight(), svg.getBottom());
        e.hostW = cell.getWidth();
        e.hostH = cell.getHeight();
        e.selected = selected;
        int ring = dark ? 0xFF5A5A5E : 0xFFC7C7CC;
        e.drawable.update(style, e.shape.path, e.shape.color, false, selected, ring, dark);
        hide(e, svg);
        if (!selected && Log.isLoggable(HARVEST_TAG, Log.DEBUG)) {
            harvest(e.shape, desc.substring(0, desc.length() - SHAPE_CELL_SUFFIX.length()).trim());
        }
    }

    private static final java.util.Map<View, Long> PROBED = new WeakHashMap<>();

    /** Debug (adb shell setprop log.tag.RokBotSvgVector DEBUG): the official SVG nodes of each mark. */
    private static void probe(View svg, String label) {
        if (!Log.isLoggable("RokBotSvgVector", Log.DEBUG)) return;
        Long last = PROBED.get(svg);
        long now = SystemClock.uptimeMillis();
        if (last != null && now - last < 1500) return;
        PROBED.put(svg, now);
        RokBotSvgVector.dump(svg, label);
    }

    /**
     * Development aid (adb shell setprop log.tag.RokBotAvatarHarvest DEBUG, Android 14+): logs each
     * official shape's vector path in the 0..100 picker-cell box, the source of RokBotAvatarShapes.
     */
    private static void harvest(RokBotSvgVector.Shape shape, String name) {
        if (!HARVESTED.add(name)) return;
        String d = RokBotSvgVector.toPathData(shape.path);
        if (d == null) { HARVESTED.remove(name); return; }
        Log.d(HARVEST_TAG, "shape=" + name + " color=" + Integer.toHexString(shape.color) + " d=" + d);
    }
}

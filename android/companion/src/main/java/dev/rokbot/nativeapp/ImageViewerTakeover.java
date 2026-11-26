package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.drawable.GradientDrawable;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * High-resolution chat image viewer. The official viewer (React Native route image-viewer, testIDs
 * image-viewer-cover / image-viewer-box) draws with expo-image, which decodes to the size of the view and zooms
 * the result at most about 4x: a 1100x10005 screenshot ends up 198 pixels wide and its text never becomes
 * readable. When that viewer shows an image clearly larger than the screen, a native {@link ZoomImageView}
 * covers it with the same image file at full resolution. Screen-sized images keep the official viewer.
 *
 * Nothing is inserted into the React tree: the cover is the top child of the activity's decor view. Closing it
 * sends Back to React Native, which closes the official viewer underneath; the "more" button hands the session back
 * to the official viewer and opens its own menu (Forward / Share / Save).
 */
final class ImageViewerTakeover {
    private static final String TAG = "RokBotImageViewer";
    private static final String TEST_ID_COVER = "image-viewer-cover";
    private static final String TEST_ID_BOX = "image-viewer-box";
    private static final String TEST_ID_PAGER = "image-viewer-home-clip";
    private static final String EXPO_IMAGE = "expo.modules.image.ExpoImageViewWrapper";
    private static final long MIN_SCAN_INTERVAL_MS = 120L;
    private static final int MAX_CACHED_FILES = 8;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> new Thread(r, "rokbot-image-prepare"));
    private static final WeakHashMap<View, Boolean> HOOKED = new WeakHashMap<>();
    /** Prepared files per source key (the cache trim on the IO thread removes entries too). */
    private static final Map<String, ZoomImageView.Source> PREPARED = new java.util.concurrent.ConcurrentHashMap<>();
    private static final Map<String, Boolean> FAILED = new java.util.HashMap<>();

    private static WeakReference<Activity> sActivity = new WeakReference<>(null);
    private static WeakReference<View> sSessionCover = new WeakReference<>(null);
    private static boolean sSessionHandedBack;
    private static long sSessionOpenedAt;
    private static String sPreparing;
    private static Overlay sOverlay;
    private static CircleButton sBatchFab;
    private static boolean sScanScheduled;
    private static long sLastScanAt;
    private static int sTestIdKey = -1;

    private static final Runnable SCAN = () -> {
        sScanScheduled = false;
        sLastScanAt = SystemClock.uptimeMillis();
        Activity act = sActivity.get();
        if (act != null) {
            try {
                scan(act);
            } catch (Throwable t) {
                Log.w(TAG, "scan failed: " + t);
            }
        }
    };

    private ImageViewerTakeover() {}

    static void onReactResumed(Activity activity) {
        if (activity == null || activity.getWindow() == null) return;
        sActivity = new WeakReference<>(activity);
        View decor = activity.getWindow().getDecorView();
        if (decor != null && !HOOKED.containsKey(decor)) {
            HOOKED.put(decor, Boolean.TRUE);
            ViewTreeObserver vto = decor.getViewTreeObserver();
            vto.addOnGlobalLayoutListener(() -> scheduleScan(0L));
            // Fabric mounts views without a layout pass; a drawn frame is the reliable signal.
            vto.addOnDrawListener(() -> scheduleScan(0L));
        }
        scheduleScan(0L);
    }

    static void onReactPaused(Activity activity) {
        MAIN.removeCallbacks(SCAN);
        sScanScheduled = false;
    }

    private static void scheduleScan(long delayMs) {
        if (sScanScheduled) return;
        sScanScheduled = true;
        long since = SystemClock.uptimeMillis() - sLastScanAt;
        MAIN.postDelayed(SCAN, Math.max(delayMs, MIN_SCAN_INTERVAL_MS - since));
    }

    // ---- React tree -------------------------------------------------------------------------------------------

    private static void scan(Activity act) {
        View root = act.getWindow().getDecorView();
        if (sOverlay != null && (sOverlay.activity != act || !sOverlay.isAttachedToWindow())) {
            // The activity was recreated under the cover (configuration change): start over.
            sOverlay.image.release();
            sOverlay = null;
        }
        View cover = findByTestId(act, root, TEST_ID_COVER);
        boolean open = cover != null && cover.isShown();
        if (!open) {
            if (sOverlay != null) dismissOverlay(false);
            dismissBatchFab();
            sSessionCover = new WeakReference<>(null);
            sSessionHandedBack = false;
            return;
        }
        if (sSessionCover.get() != cover) {
            sSessionCover = new WeakReference<>(cover);
            sSessionHandedBack = false;
            sSessionOpenedAt = SystemClock.uptimeMillis();
        }
        View viewer = cover.getParent() instanceof View ? (View) cover.getParent() : null;
        if (sOverlay == null) {
            List<String> openGallery = galleryUris(act, viewer);
            if (openGallery.size() >= 2) {
                ensureBatchFab(act, (ViewGroup) root, openGallery);
            } else {
                dismissBatchFab();
            }
        } else {
            dismissBatchFab();
        }
        if (sOverlay != null || sSessionHandedBack) return;

        View current = currentImage(act, viewer != null ? viewer : root);
        String uri = current == null ? null : sourceUri(current);
        if (uri == null) return;
        String key = ImageViewerMath.sourceKey(uri);
        if (FAILED.containsKey(key)) return;
        ZoomImageView.Source prepared = PREPARED.get(key);
        if (prepared == null) {
            if (key.equals(sPreparing)) return;
            sPreparing = key;
            final Context app = act.getApplicationContext();
            IO.execute(() -> {
                ZoomImageView.Source src = prepare(app, uri, key);
                MAIN.post(() -> {
                    sPreparing = null;
                    if (src == null) FAILED.put(key, Boolean.TRUE);
                    else PREPARED.put(key, src);
                    scheduleScan(0L);
                });
            });
            return;
        }
        int screenW = root.getWidth(), screenH = root.getHeight();
        if (!ImageViewerMath.needsTakeover(prepared.orientedWidth(), prepared.orientedHeight(), screenW, screenH)) return;

        List<String> gallery = galleryUris(act, viewer);
        int index = selectedIndex(act, viewer, gallery, uri);
        if (index < 0) {
            gallery = new ArrayList<>(Arrays.asList(uri));
            index = 0;
        }
        Log.i(TAG, "take over " + prepared.width + "x" + prepared.height + " (" + (index + 1) + "/" + gallery.size() + ") "
                + (SystemClock.uptimeMillis() - sSessionOpenedAt) + "ms after the viewer opened");
        showOverlay(act, (ViewGroup) root, gallery, index, prepared);
    }

    /** The page of the official pager that is on screen: the image-viewer-box nearest the window center. */
    private static View currentImage(Activity act, View scope) {
        List<View> boxes = new ArrayList<>();
        collectByTestId(act, scope, TEST_ID_BOX, boxes);
        View best = null;
        long bestDistance = Long.MAX_VALUE;
        int[] loc = new int[2];
        int cx = scope.getRootView().getWidth() / 2, cy = scope.getRootView().getHeight() / 2;
        for (View box : boxes) {
            if (!box.isShown()) continue;
            View image = firstOfClass(box, EXPO_IMAGE);
            if (image == null) continue;
            box.getLocationInWindow(loc);
            long dx = loc[0] + box.getWidth() / 2 - cx, dy = loc[1] + box.getHeight() / 2 - cy;
            long d = dx * dx + dy * dy;
            if (d < bestDistance) { bestDistance = d; best = image; }
        }
        return best;
    }

    /** All images of the viewer in strip order (the thumbnail strip), or empty when it is hidden. */
    private static List<String> galleryUris(Activity act, View viewer) {
        List<String> out = new ArrayList<>();
        if (viewer == null) return out;
        View pager = findByTestId(act, viewer, TEST_ID_PAGER);
        List<View> thumbs = new ArrayList<>();
        collectExpoImages(viewer, pager, thumbs);
        if (thumbs.size() < 2) return out;
        List<float[]> order = new ArrayList<>();
        for (int i = 0; i < thumbs.size(); i++) order.add(new float[] { stripOffset(thumbs.get(i)), i });
        order.sort((a, b) -> Float.compare(a[0], b[0]));
        for (float[] o : order) {
            String uri = sourceUri(thumbs.get((int) o[1]));
            if (uri == null) return new ArrayList<>();
            out.add(uri);
        }
        return out;
    }

    /**
     * Position of the shown image in the strip. The same image can sit in the strip twice (every image of the chat
     * is there), and the official strip keeps the selected thumbnail centered, so among the matches take the one
     * nearest the middle of the screen.
     */
    private static int selectedIndex(Activity act, View viewer, List<String> gallery, String uri) {
        List<View> thumbs = thumbnailButtons(act, viewer);
        int best = -1;
        float bestDistance = Float.MAX_VALUE;
        int[] loc = new int[2];
        float mid = viewer == null ? 0f : viewer.getRootView().getWidth() / 2f;
        for (int i = 0; i < gallery.size(); i++) {
            if (!gallery.get(i).equals(uri)) continue;
            float d = Float.MAX_VALUE / 2;
            if (thumbs.size() == gallery.size()) {
                thumbs.get(i).getLocationInWindow(loc);
                d = Math.abs(loc[0] + thumbs.get(i).getWidth() / 2f - mid);
            }
            if (best < 0 || d < bestDistance) { best = i; bestDistance = d; }
        }
        return best;
    }

    /** Thumbnail buttons of the official strip, in the same order as {@link #galleryUris}. */
    private static List<View> thumbnailButtons(Activity act, View viewer) {
        List<View> out = new ArrayList<>();
        if (viewer == null) return out;
        View pager = findByTestId(act, viewer, TEST_ID_PAGER);
        List<View> thumbs = new ArrayList<>();
        collectExpoImages(viewer, pager, thumbs);
        thumbs.sort((a, b) -> Float.compare(stripOffset(a), stripOffset(b)));
        for (View t : thumbs) {
            View clickable = t;
            while (clickable != null && !clickable.isClickable() && clickable != viewer) {
                clickable = clickable.getParent() instanceof View ? (View) clickable.getParent() : null;
            }
            out.add(clickable != null && clickable != viewer ? clickable : t);
        }
        return out;
    }

    /** Horizontal position inside the scrolling strip (independent of how far the strip is scrolled). */
    private static float stripOffset(View v) {
        float x = 0f;
        View cur = v;
        while (cur != null) {
            x += cur.getLeft();
            if (!(cur.getParent() instanceof View)) break;
            View parent = (View) cur.getParent();
            if (parent.getClass().getName().contains("HorizontalScrollView")) break;
            cur = parent;
        }
        return x;
    }

    private static void collectExpoImages(View v, View skip, List<View> out) {
        if (v == null || v == skip) return;
        if (EXPO_IMAGE.equals(v.getClass().getName())) {
            if (v.isShown()) out.add(v);
            return;
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) collectExpoImages(g.getChildAt(i), skip, out);
        }
    }

    /** Clickable views in the top fifth of the official viewer (its close and more buttons). */
    private static List<View> topButtons(Activity act, View viewer) {
        List<View> out = new ArrayList<>();
        if (viewer == null) return out;
        View pager = findByTestId(act, viewer, TEST_ID_PAGER);
        collectTopClickables(viewer, pager, viewer.getRootView().getHeight() / 5, out);
        return out;
    }

    private static void collectTopClickables(View v, View skip, int maxY, List<View> out) {
        if (v == null || v == skip || !v.isShown()) return;
        if (v.isClickable() && v.getWidth() > 0) {
            int[] loc = new int[2];
            v.getLocationInWindow(loc);
            if (loc[1] + v.getHeight() <= maxY) {
                out.add(v);
                return;
            }
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) collectTopClickables(g.getChildAt(i), skip, maxY, out);
        }
    }

    private static View firstOfClass(View v, String className) {
        if (v == null) return null;
        if (className.equals(v.getClass().getName())) return v;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                View hit = firstOfClass(g.getChildAt(i), className);
                if (hit != null) return hit;
            }
        }
        return null;
    }

    private static View findByTestId(Context ctx, View v, String id) {
        if (v == null) return null;
        if (id.equals(testIdOf(ctx, v))) return v;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                View hit = findByTestId(ctx, g.getChildAt(i), id);
                if (hit != null) return hit;
            }
        }
        return null;
    }

    private static void collectByTestId(Context ctx, View v, String id, List<View> out) {
        if (v == null) return;
        if (id.equals(testIdOf(ctx, v))) out.add(v);
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) collectByTestId(ctx, g.getChildAt(i), id, out);
        }
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

    /** The largest source URI of an expo-image view (its `sources` list of SourceMap records). */
    static String sourceUri(View expoImage) {
        try {
            Object list = field(expoImage.getClass(), "sources").get(expoImage);
            if (!(list instanceof List)) return null;
            String best = null;
            double bestPixels = -1;
            for (Object item : (List<?>) list) {
                if (item == null) continue;
                Object uri = field(item.getClass(), "uri").get(item);
                if (!(uri instanceof String) || ((String) uri).isEmpty()) continue;
                double px = 0;
                try {
                    px = ((Number) field(item.getClass(), "width").get(item)).doubleValue()
                            * ((Number) field(item.getClass(), "height").get(item)).doubleValue();
                } catch (Throwable ignored) {}
                if (best == null || px > bestPixels) { best = (String) uri; bestPixels = px; }
            }
            return best;
        } catch (Throwable t) {
            return null;
        }
    }

    private static Field field(Class<?> cls, String name) throws NoSuchFieldException {
        for (Class<?> c = cls; c != null && c != Object.class; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f;
            } catch (NoSuchFieldException ignored) {}
        }
        throw new NoSuchFieldException(name);
    }

    // ---- Image files ------------------------------------------------------------------------------------------

    /** Writes the image behind a data:/file:/content: URI to a cache file and reads its size. Off the main thread. */
    static ZoomImageView.Source prepare(Context app, String uri, String key) {
        try {
            File file;
            int payload = ImageViewerMath.base64PayloadStart(uri);
            if (payload >= 0) {
                File dir = new File(app.getCacheDir(), "rokbot-image-viewer");
                if (!dir.isDirectory() && !dir.mkdirs()) return null;
                file = new File(dir, key + ".img");
                if (!file.isFile() || file.length() == 0) {
                    File tmp = new File(dir, key + ".part");
                    try (OutputStream out = new FileOutputStream(tmp)) {
                        ImageViewerMath.decodeBase64(uri, payload, out);
                    }
                    if (!tmp.renameTo(file)) return null;
                    trimCache(dir);
                }
            } else if (uri.startsWith("file://") || uri.startsWith("/")) {
                file = new File(uri.startsWith("/") ? uri : Uri.parse(uri).getPath());
            } else if (uri.startsWith("content://")) {
                File dir = new File(app.getCacheDir(), "rokbot-image-viewer");
                if (!dir.isDirectory() && !dir.mkdirs()) return null;
                file = new File(dir, key + ".img");
                if (!file.isFile() || file.length() == 0) {
                    try (InputStream in = app.getContentResolver().openInputStream(Uri.parse(uri));
                         OutputStream out = new FileOutputStream(file)) {
                        if (in == null) return null;
                        byte[] buf = new byte[64 * 1024];
                        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                    }
                    trimCache(dir);
                }
            } else {
                return null; // Remote URLs: leave them to the official viewer.
            }
            if (!file.isFile()) return null;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(file.getAbsolutePath(), o);
            if (o.outWidth <= 0 || o.outHeight <= 0) return null;
            if ("image/gif".equals(o.outMimeType)) return null; // Keep animation in the official viewer.
            int rotation = 0;
            try {
                rotation = ImageViewerMath.rotationOf(new ExifInterface(file.getAbsolutePath())
                        .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL));
            } catch (Throwable ignored) {}
            return new ZoomImageView.Source(key, file.getAbsolutePath(), o.outWidth, o.outHeight, rotation);
        } catch (Throwable t) {
            Log.w(TAG, "prepare failed: " + t);
            return null;
        }
    }

    private static void trimCache(File dir) {
        File[] files = dir.listFiles((d, name) -> name.endsWith(".img"));
        if (files == null || files.length <= MAX_CACHED_FILES) return;
        Arrays.sort(files, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        for (int i = MAX_CACHED_FILES; i < files.length; i++) {
            String key = files[i].getName().replace(".img", "");
            PREPARED.remove(key);
            //noinspection ResultOfMethodCallIgnored
            files[i].delete();
        }
    }

    // ---- Overlay ----------------------------------------------------------------------------------------------

    private static void ensureBatchFab(Activity act, ViewGroup decor, List<String> gallery) {
        if (sBatchFab != null && sBatchFab.getParent() == decor) {
            final List<String> copy = new ArrayList<>(gallery);
            sBatchFab.setOnClickListener(v -> BatchImageSaver.showPicker(act, copy));
            return;
        }
        dismissBatchFab();
        CircleButton fab = new CircleButton(act, CircleButton.BATCH_DOWNLOAD);
        fab.setContentDescription(Localize.t(act, "批量保存到相册", "Batch save to gallery"));
        final List<String> copy = new ArrayList<>(gallery);
        fab.setOnClickListener(v -> BatchImageSaver.showPicker(act, copy));
        int size = Math.round(44 * act.getResources().getDisplayMetrics().density);
        int margin = Math.round(18 * act.getResources().getDisplayMetrics().density);
        int top = Overlay.topInset(act) + Math.round(12 * act.getResources().getDisplayMetrics().density);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(size, size, Gravity.END | Gravity.TOP);
        lp.rightMargin = margin + size + Math.round(10 * act.getResources().getDisplayMetrics().density);
        lp.topMargin = top;
        sBatchFab = fab;
        decor.addView(fab, lp);
    }

    private static void dismissBatchFab() {
        CircleButton fab = sBatchFab;
        sBatchFab = null;
        if (fab != null) removeFromParent(fab);
    }

    private static void showOverlay(Activity act, ViewGroup decor, List<String> gallery, int index, ZoomImageView.Source first) {
        dismissBatchFab();
        Overlay overlay = new Overlay(act, gallery, index);
        sOverlay = overlay;
        decor.addView(overlay, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        overlay.setAlpha(0f);
        overlay.animate().alpha(1f).setDuration(140).start();
        overlay.requestFocus();
        overlay.show(index, first);
    }

    private static void dismissOverlay(boolean animate) {
        final Overlay overlay = sOverlay;
        sOverlay = null;
        if (overlay == null) return;
        overlay.image.release();
        if (!animate) {
            removeFromParent(overlay);
            return;
        }
        overlay.animate().alpha(0f).setDuration(120).withEndAction(() -> removeFromParent(overlay)).start();
    }

    private static void removeFromParent(View v) {
        if (v.getParent() instanceof ViewGroup) ((ViewGroup) v.getParent()).removeView(v);
    }

    /** Close: drop the cover and let React Native close its viewer as on Back. */
    private static void close(Activity act) {
        sSessionHandedBack = true;
        dismissOverlay(true);
        try {
            act.onBackPressed();
        } catch (Throwable t) {
            Log.w(TAG, "back failed: " + t);
        }
    }

    /**
     * More: give this viewing session back to the official viewer, on the same image, and open its own menu
     * (Forward / Share / Save need React Native).
     */
    private static void handBack(Activity act, int index) {
        sSessionHandedBack = true;
        dismissOverlay(false);
        View cover = sSessionCover.get();
        final View viewer = cover != null && cover.getParent() instanceof View ? (View) cover.getParent() : null;
        if (viewer == null) return;
        Runnable openMenu = () -> {
            List<View> buttons = topButtons(act, viewer);
            View more = null;
            int bestX = -1;
            int[] loc = new int[2];
            for (View b : buttons) {
                b.getLocationInWindow(loc);
                if (loc[0] > bestX) { bestX = loc[0]; more = b; }
            }
            Log.i(TAG, "hand back: " + buttons.size() + " top buttons, more at x=" + bestX);
            if (more != null && buttons.size() >= 2) tap(act, more);
        };
        Runnable selectAndOpen = () -> {
            List<View> thumbs = thumbnailButtons(act, viewer);
            List<String> uris = galleryUris(act, viewer);
            if (thumbs.size() > index && thumbs.size() > 1 && uris.size() == thumbs.size()) {
                final String target = uris.get(index);
                View now = currentImage(act, viewer);
                if (now != null && target.equals(sourceUri(now))) {
                    openMenu.run();
                    return;
                }
                tap(act, thumbs.get(index));
                // Open the menu once the official pager shows that image (its menu acts on the current one).
                final long deadline = SystemClock.uptimeMillis() + 2000;
                MAIN.postDelayed(new Runnable() {
                    @Override public void run() {
                        View cur = currentImage(act, viewer);
                        if ((cur != null && target.equals(sourceUri(cur))) || SystemClock.uptimeMillis() > deadline) {
                            MAIN.postDelayed(openMenu, 250);
                        } else {
                            MAIN.postDelayed(this, 100);
                        }
                    }
                }, 150);
            } else {
                openMenu.run();
            }
        };
        if (topButtons(act, viewer).size() >= 2) {
            selectAndOpen.run();
        } else {
            // Its controls are hidden: a tap on the image shows them again.
            View root = act.getWindow().getDecorView();
            tapAt(act, root.getWidth() / 2f, root.getHeight() / 2f);
            MAIN.postDelayed(selectAndOpen, 350);
        }
    }

    private static void tap(Activity act, View v) {
        int[] loc = new int[2];
        v.getLocationInWindow(loc);
        tapAt(act, loc[0] + v.getWidth() / 2f, loc[1] + v.getHeight() / 2f);
    }

    /** A synthetic tap delivered straight to the React content view (window coordinates). */
    private static void tapAt(Activity act, float x, float y) {
        View content = act.findViewById(android.R.id.content);
        if (content == null) return;
        int[] loc = new int[2];
        content.getLocationInWindow(loc);
        float lx = x - loc[0], ly = y - loc[1];
        long now = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, lx, ly, 0);
        MotionEvent up = MotionEvent.obtain(now, now + 60, MotionEvent.ACTION_UP, lx, ly, 0);
        down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        content.dispatchTouchEvent(down);
        MAIN.postDelayed(() -> {
            content.dispatchTouchEvent(up);
            down.recycle();
            up.recycle();
        }, 60);
    }

    /** Full-screen black cover: the zoomable image and a close / counter / more bar like the official one. */
    private static final class Overlay extends FrameLayout implements ZoomImageView.LoadListener {
        final Activity activity;
        final List<String> gallery;
        final ZoomImageView image;
        final View chrome;
        final TextView counter;
        final ProgressBar spinner;
        final TextView error;
        int index;
        boolean chromeShown = true;

        Overlay(Activity act, List<String> gallery, int index) {
            super(act);
            this.activity = act;
            this.gallery = gallery;
            this.index = index;
            setBackgroundColor(Color.BLACK);
            setClickable(true);
            setFocusable(true);
            setFocusableInTouchMode(true);
            setTag("rokbot-image-viewer");

            image = new ZoomImageView(act);
            image.setListener(this);
            addView(image, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

            spinner = new ProgressBar(act);
            spinner.setIndeterminate(true);
            addView(spinner, new LayoutParams(dp(40), dp(40), Gravity.CENTER));

            error = new TextView(act);
            error.setTextColor(0xCCFFFFFF);
            error.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            error.setText(Localize.t(act, "图片无法加载", "Couldn't load this image"));
            error.setVisibility(GONE);
            addView(error, new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER));

            FrameLayout bar = new FrameLayout(act);
            int top = topInset(act) + dp(12);
            CircleButton close = new CircleButton(act, CircleButton.CLOSE);
            close.setContentDescription(Localize.t(act, "关闭", "Close"));
            close.setOnClickListener(v -> close(activity));
            LayoutParams cl = new LayoutParams(dp(44), dp(44), Gravity.START | Gravity.TOP);
            cl.leftMargin = dp(18);
            cl.topMargin = top;
            bar.addView(close, cl);

            CircleButton more = new CircleButton(act, CircleButton.MORE);
            more.setContentDescription(Localize.t(act, "更多", "More"));
            more.setOnClickListener(v -> handBack(activity, this.index));
            LayoutParams ml = new LayoutParams(dp(44), dp(44), Gravity.END | Gravity.TOP);
            ml.rightMargin = dp(18);
            ml.topMargin = top;
            bar.addView(more, ml);

            if (gallery.size() >= 1) {
                CircleButton batch = new CircleButton(act, CircleButton.BATCH_DOWNLOAD);
                batch.setContentDescription(Localize.t(act, "批量保存到相册", "Batch save to gallery"));
                batch.setOnClickListener(v -> BatchImageSaver.showPicker(activity, gallery));
                LayoutParams bl = new LayoutParams(dp(44), dp(44), Gravity.END | Gravity.TOP);
                bl.rightMargin = dp(18 + 44 + 10);
                bl.topMargin = top;
                bar.addView(batch, bl);
            }

            counter = new TextView(act);
            counter.setTextColor(Color.WHITE);
            counter.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            counter.setGravity(Gravity.CENTER);
            GradientDrawable pill = new GradientDrawable();
            pill.setColor(0x993A3A3C);
            pill.setCornerRadius(dp(16));
            counter.setBackground(pill);
            counter.setPadding(dp(12), dp(4), dp(12), dp(4));
            LayoutParams tl = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL | Gravity.TOP);
            tl.topMargin = top + dp(10);
            bar.addView(counter, tl);
            chrome = bar;
            addView(bar, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
            bar.setClickable(false);
        }

        void show(int i, ZoomImageView.Source prepared) {
            index = i;
            counter.setText((i + 1) + " / " + gallery.size());
            counter.setVisibility(gallery.size() > 1 ? VISIBLE : GONE);
            error.setVisibility(GONE);
            spinner.setVisibility(VISIBLE);
            if (prepared != null) {
                image.setSource(prepared);
                return;
            }
            image.setSource(null);
            final String uri = gallery.get(i);
            final String key = ImageViewerMath.sourceKey(uri);
            ZoomImageView.Source known = PREPARED.get(key);
            if (known != null) {
                image.setSource(known);
                return;
            }
            final Context app = activity.getApplicationContext();
            IO.execute(() -> {
                ZoomImageView.Source src = prepare(app, uri, key);
                MAIN.post(() -> {
                    if (src != null) PREPARED.put(key, src);
                    if (sOverlay != this || index != i) return;
                    if (src == null) onLoaded(false);
                    else image.setSource(src);
                });
            });
        }

        @Override public void onLoaded(boolean ok) {
            spinner.setVisibility(GONE);
            error.setVisibility(ok ? GONE : VISIBLE);
        }

        @Override public void onSingleTap() {
            chromeShown = !chromeShown;
            chrome.animate().alpha(chromeShown ? 1f : 0f).setDuration(150).start();
            for (int i = 0; i < ((ViewGroup) chrome).getChildCount(); i++) ((ViewGroup) chrome).getChildAt(i).setEnabled(chromeShown);
        }

        @Override public void onPage(int direction) {
            int next = index + direction;
            if (next < 0 || next >= gallery.size()) return;
            image.setTranslationX(direction * getWidth() * 0.25f);
            image.setAlpha(0f);
            image.animate().translationX(0f).alpha(1f).setDuration(180).start();
            show(next, null);
        }

        @Override public boolean dispatchKeyEvent(KeyEvent event) {
            if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                if (event.getAction() == KeyEvent.ACTION_UP) close(activity);
                return true;
            }
            return super.dispatchKeyEvent(event);
        }

        private int dp(float v) {
            return Math.round(v * getResources().getDisplayMetrics().density);
        }

        private static int topInset(Activity act) {
            try {
                WindowInsets insets = act.getWindow().getDecorView().getRootWindowInsets();
                if (insets != null) return insets.getSystemWindowInsetTop();
            } catch (Throwable ignored) {}
            return 0;
        }
    }

    /** The official viewer's round dark buttons, drawn (no resources needed). */
    private static final class CircleButton extends View {
        static final int CLOSE = 0;
        static final int MORE = 1;
        static final int BATCH_DOWNLOAD = 2;
        private final int kind;
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);

        CircleButton(Context ctx, int kind) {
            super(ctx);
            this.kind = kind;
            fill.setColor(0xE63A3A3C);
            stroke.setColor(Color.WHITE);
            stroke.setStrokeCap(Paint.Cap.ROUND);
            stroke.setStrokeJoin(Paint.Join.ROUND);
            stroke.setStrokeWidth(2.2f * ctx.getResources().getDisplayMetrics().density);
            setClickable(true);
            setFocusable(true);
        }

        @Override protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight(), r = Math.min(w, h) / 2f, cx = w / 2f, cy = h / 2f;
            c.drawCircle(cx, cy, r, fill);
            if (kind == CLOSE) {
                stroke.setStyle(Paint.Style.STROKE);
                float a = r * 0.36f;
                c.drawLine(cx - a, cy - a, cx + a, cy + a, stroke);
                c.drawLine(cx + a, cy - a, cx - a, cy + a, stroke);
            } else if (kind == BATCH_DOWNLOAD) {
                stroke.setStyle(Paint.Style.STROKE);
                float arrowTop = cy - r * 0.42f;
                float arrowMid = cy + r * 0.14f;
                float head = r * 0.24f;
                c.drawLine(cx, arrowTop, cx, arrowMid, stroke);
                c.drawLine(cx - head, arrowMid - head, cx, arrowMid, stroke);
                c.drawLine(cx + head, arrowMid - head, cx, arrowMid, stroke);
                float trayY = cy + r * 0.4f;
                c.drawLine(cx - r * 0.38f, trayY, cx + r * 0.38f, trayY, stroke);
            } else {
                float dot = r * 0.09f, gap = r * 0.34f;
                stroke.setStyle(Paint.Style.FILL);
                for (int i = -1; i <= 1; i++) c.drawCircle(cx + i * gap, cy, dot, stroke);
            }
        }

        @Override public void setPressed(boolean pressed) {
            super.setPressed(pressed);
            setAlpha(pressed ? 0.7f : 1f);
        }
    }
}

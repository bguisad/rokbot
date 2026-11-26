package dev.rokbot.nativeapp;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapRegionDecoder;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.LruCache;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.widget.OverScroller;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Zoomable image that never decodes more than the screen needs: a downsampled base layer for the whole image
 * plus {@link BitmapRegionDecoder} tiles at the sample size of the current zoom (the subsampling-scale-image-view
 * approach). Long screenshots open at the full width and scroll; text stays sharp at any zoom and no bitmap
 * comes near the GPU texture limit.
 */
final class ZoomImageView extends View {
    private static final String TAG = "RokBotImageViewer";

    interface Listener {
        void onSingleTap();
        /** A horizontal fling at the edge of the image: -1 previous, +1 next. */
        void onPage(int direction);
    }

    /** A prepared image file: its path, raw size and EXIF rotation. */
    static final class Source {
        final String key;
        final String path;
        final int width;
        final int height;
        final int rotation;

        Source(String key, String path, int width, int height, int rotation) {
            this.key = key;
            this.path = path;
            this.width = width;
            this.height = height;
            this.rotation = rotation;
        }

        int orientedWidth() { return rotation % 180 == 0 ? width : height; }
        int orientedHeight() { return rotation % 180 == 0 ? height : width; }
    }

    private static final ExecutorService DECODER = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "rokbot-image-tiles");
        t.setPriority(Thread.NORM_PRIORITY - 1);
        return t;
    });
    private static final LruCache<String, Bitmap> TILES = new LruCache<String, Bitmap>(
            (int) Math.min(96L * 1024 * 1024, Runtime.getRuntime().maxMemory() / 6)) {
        @Override protected int sizeOf(String key, Bitmap value) { return value.getByteCount(); }
    };

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.DITHER_FLAG);
    private final Matrix orient = new Matrix();
    private final Matrix inverse = new Matrix();
    private final ScaleGestureDetector scaleDetector;
    private final GestureDetector gestureDetector;
    private final OverScroller scroller;
    private final Set<String> pending = new HashSet<>();
    private final Object decoderLock = new Object();

    private Listener listener;
    private Source source;
    private BitmapRegionDecoder decoder;
    private Bitmap base;
    private int baseSample = 1;
    private int generation;
    private float scale = 1f;
    private float minScale = 1f;
    private float maxScale = 4f;
    private float initialScale = 1f;
    private float transX;
    private float transY;
    private boolean laidOut;
    private boolean edgeAtDownLeft;
    private boolean edgeAtDownRight;
    private ValueAnimator zoomAnimator;

    ZoomImageView(Context context) {
        super(context);
        scroller = new OverScroller(context);
        scaleDetector = new ScaleGestureDetector(context, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override public boolean onScale(ScaleGestureDetector d) {
                zoomTo(scale * d.getScaleFactor(), d.getFocusX(), d.getFocusY());
                return true;
            }
        });
        scaleDetector.setQuickScaleEnabled(true);
        gestureDetector = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent e) {
                scroller.forceFinished(true);
                edgeAtDownLeft = !canPan(-1);
                edgeAtDownRight = !canPan(1);
                return true;
            }

            @Override public boolean onScroll(MotionEvent e1, MotionEvent e2, float dx, float dy) {
                if (scaleDetector.isInProgress()) return false;
                transX -= dx;
                transY -= dy;
                clamp();
                invalidate();
                return true;
            }

            @Override public boolean onFling(MotionEvent e1, MotionEvent e2, float vx, float vy) {
                if (scaleDetector.isInProgress() || e2.getPointerCount() > 1) return false;
                if (Math.abs(vx) > 1.5f * Math.abs(vy) && Math.abs(vx) > 450f * getResources().getDisplayMetrics().density) {
                    if (vx < 0 && edgeAtDownRight && listener != null) { listener.onPage(1); return true; }
                    if (vx > 0 && edgeAtDownLeft && listener != null) { listener.onPage(-1); return true; }
                }
                fling(vx, vy);
                return true;
            }

            @Override public boolean onSingleTapConfirmed(MotionEvent e) {
                if (listener != null) listener.onSingleTap();
                return true;
            }

            @Override public boolean onDoubleTap(MotionEvent e) {
                animateZoom(ImageViewerMath.doubleTapTarget(scale, initialScale, maxScale), e.getX(), e.getY());
                return true;
            }
        });
    }

    void setListener(Listener listener) { this.listener = listener; }

    Source getSource() { return source; }

    float getScale() { return scale; }

    float getInitialScale() { return initialScale; }

    /** Shows a prepared source; the base layer decodes in the background and the view draws as soon as it lands. */
    void setSource(Source next) {
        release();
        source = next;
        laidOut = false;
        final int gen = ++generation;
        if (next == null) { invalidate(); return; }
        if (getWidth() > 0 && getHeight() > 0) resetLayout();
        final int viewW = Math.max(1, getWidth() > 0 ? getWidth() : getResources().getDisplayMetrics().widthPixels);
        final int viewH = Math.max(1, getHeight() > 0 ? getHeight() : getResources().getDisplayMetrics().heightPixels);
        DECODER.execute(() -> {
            BitmapRegionDecoder d = null;
            Bitmap b = null;
            int sample;
            float min = ImageViewerMath.minScale(next.orientedWidth(), next.orientedHeight(), viewW, viewH);
            sample = ImageViewerMath.baseSampleSize(next.width, next.height, min);
            try {
                try {
                    d = BitmapRegionDecoder.newInstance(next.path, false);
                } catch (Throwable unsupported) {
                    d = null; // GIF and other formats: base layer only.
                }
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inSampleSize = sample;
                o.inPreferredConfig = Bitmap.Config.ARGB_8888;
                b = BitmapFactory.decodeFile(next.path, o);
            } catch (Throwable t) {
                Log.w(TAG, "base decode failed: " + t);
            }
            final BitmapRegionDecoder fd = d;
            final Bitmap fb = b;
            final int fs = sample;
            main.post(() -> {
                if (gen != generation) {
                    if (fd != null) fd.recycle();
                    return;
                }
                synchronized (decoderLock) { decoder = fd; }
                base = fb;
                baseSample = fs;
                if (listener instanceof LoadListener) ((LoadListener) listener).onLoaded(fb != null);
                invalidate();
            });
        });
        invalidate();
    }

    interface LoadListener extends Listener {
        void onLoaded(boolean ok);
    }

    boolean isLoaded() { return base != null; }

    void release() {
        generation++;
        if (zoomAnimator != null) zoomAnimator.cancel();
        scroller.forceFinished(true);
        pending.clear();
        final BitmapRegionDecoder old;
        synchronized (decoderLock) { old = decoder; decoder = null; }
        if (old != null) DECODER.execute(old::recycle);
        if (source != null) evictTiles(source.key);
        base = null;
    }

    private static void evictTiles(String key) {
        for (String k : TILES.snapshot().keySet()) if (k.startsWith(key + "/")) TILES.remove(k);
    }

    @Override protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        release();
        source = null;
    }

    @Override protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        if (source != null && w > 0 && h > 0) resetLayout();
    }

    private void resetLayout() {
        int ow = source.orientedWidth(), oh = source.orientedHeight();
        int vw = getWidth(), vh = getHeight();
        initialScale = ImageViewerMath.initialScale(ow, oh, vw, vh);
        minScale = ImageViewerMath.minScale(ow, oh, vw, vh);
        maxScale = ImageViewerMath.maxScale(ow, oh, vw, vh);
        scale = initialScale;
        transX = (vw - ow * scale) / 2f;
        transY = 0f;
        clamp();
        orient.reset();
        switch (source.rotation) {
            case 90: orient.setRotate(90); orient.postTranslate(source.height, 0); break;
            case 180: orient.setRotate(180); orient.postTranslate(source.width, source.height); break;
            case 270: orient.setRotate(270); orient.postTranslate(0, source.width); break;
            default: break;
        }
        laidOut = true;
        invalidate();
    }

    private void clamp() {
        if (source == null) return;
        transX = ImageViewerMath.clampOffset(transX, source.orientedWidth() * scale, getWidth());
        transY = ImageViewerMath.clampOffset(transY, source.orientedHeight() * scale, getHeight());
    }

    /** Whether the image can still pan in that horizontal direction (-1 towards its left edge, +1 towards its right). */
    boolean canPan(int direction) {
        if (source == null) return false;
        float content = source.orientedWidth() * scale;
        if (content <= getWidth() + 1f) return false;
        return direction < 0 ? transX < -0.5f : transX > getWidth() - content + 0.5f;
    }

    private void zoomTo(float target, float fx, float fy) {
        if (source == null) return;
        float next = Math.max(minScale, Math.min(maxScale, target));
        float ratio = next / scale;
        transX = fx - (fx - transX) * ratio;
        transY = fy - (fy - transY) * ratio;
        scale = next;
        clamp();
        invalidate();
    }

    private void animateZoom(float target, float fx, float fy) {
        if (zoomAnimator != null) zoomAnimator.cancel();
        final float from = scale;
        zoomAnimator = ValueAnimator.ofFloat(0f, 1f);
        zoomAnimator.setDuration(220);
        zoomAnimator.setInterpolator(new DecelerateInterpolator());
        zoomAnimator.addUpdateListener(a -> zoomTo(from + (target - from) * (float) a.getAnimatedValue(), fx, fy));
        zoomAnimator.start();
    }

    private void fling(float vx, float vy) {
        if (source == null) return;
        int contentW = Math.round(source.orientedWidth() * scale), contentH = Math.round(source.orientedHeight() * scale);
        int minX = Math.min(0, getWidth() - contentW), minY = Math.min(0, getHeight() - contentH);
        scroller.fling(Math.round(transX), Math.round(transY), Math.round(vx), Math.round(vy), minX, 0, minY, 0);
        postInvalidateOnAnimation();
    }

    @Override public void computeScroll() {
        if (scroller.computeScrollOffset()) {
            transX = scroller.getCurrX();
            transY = scroller.getCurrY();
            clamp();
            postInvalidateOnAnimation();
        }
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        boolean handled = scaleDetector.onTouchEvent(event);
        handled |= gestureDetector.onTouchEvent(event);
        return handled || super.onTouchEvent(event);
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (source == null || !laidOut || base == null) return;
        canvas.save();
        canvas.translate(transX, transY);
        canvas.scale(scale, scale);
        canvas.concat(orient);
        RectF dst = new RectF(0, 0, source.width, source.height);
        canvas.drawBitmap(base, null, dst, paint);

        int sample = ImageViewerMath.sampleSize(scale);
        if (sample < baseSample && hasDecoder()) {
            // Visible part of the image in source pixels.
            Matrix full = new Matrix(orient);
            full.postScale(scale, scale);
            full.postTranslate(transX, transY);
            full.invert(inverse);
            RectF visible = new RectF(0, 0, getWidth(), getHeight());
            inverse.mapRect(visible);
            List<int[]> tiles = ImageViewerMath.tiles(visible.left, visible.top, visible.right, visible.bottom,
                    source.width, source.height, sample);
            for (int[] t : tiles) {
                String key = source.key + "/" + sample + "/" + t[0] + "/" + t[1];
                Bitmap tile = TILES.get(key);
                if (tile != null && !tile.isRecycled()) {
                    dst.set(t[2], t[3], t[4], t[5]);
                    canvas.drawBitmap(tile, null, dst, paint);
                } else {
                    requestTile(key, sample, new Rect(t[2], t[3], t[4], t[5]));
                }
            }
        }
        canvas.restore();
    }

    private boolean hasDecoder() {
        synchronized (decoderLock) { return decoder != null; }
    }

    private void requestTile(final String key, final int sample, final Rect region) {
        if (!pending.add(key)) return;
        final int gen = generation;
        DECODER.execute(() -> {
            Bitmap bitmap = null;
            if (gen == generation && stillWanted(sample)) {
                synchronized (decoderLock) {
                    if (decoder != null && !decoder.isRecycled()) {
                        try {
                            BitmapFactory.Options o = new BitmapFactory.Options();
                            o.inSampleSize = sample;
                            o.inPreferredConfig = Bitmap.Config.ARGB_8888;
                            bitmap = decoder.decodeRegion(region, o);
                        } catch (Throwable t) {
                            Log.w(TAG, "tile decode failed: " + t);
                        }
                    }
                }
            }
            final Bitmap result = bitmap;
            main.post(() -> {
                pending.remove(key);
                if (result == null) return;
                if (gen != generation) { result.recycle(); return; }
                TILES.put(key, result);
                invalidate();
            });
        });
    }

    /** Skip tiles of a zoom level the user already left (read without locking: a stale answer only costs a decode). */
    private boolean stillWanted(int sample) {
        return ImageViewerMath.sampleSize(scale) == sample;
    }
}

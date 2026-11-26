package dev.rokbot.nativeapp;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * One RokBot avatar drawn into a React Native view's {@link android.view.ViewGroupOverlay}. Overlay
 * drawables are not children, so React's own child bookkeeping (indices, clipping, recycling) never
 * sees them. Every visible drawable shares one 30 fps main-thread ticker.
 */
final class RokBotAvatarDrawable extends Drawable {
    private static final long FRAME_MS = 33L;
    private static final Set<RokBotAvatarDrawable> LIVE =
            Collections.synchronizedSet(Collections.newSetFromMap(new WeakHashMap<>()));
    private static final Handler TICK = new Handler(Looper.getMainLooper());
    private static boolean sTicking = false;
    private static boolean sForeground = true;
    private static boolean sReducedMotion = false;

    private static final Runnable TICK_RUNNABLE = new Runnable() {
        @Override
        public void run() {
            sTicking = false;
            if (!sForeground) return;
            RokBotAvatarDrawable[] snapshot;
            synchronized (LIVE) {
                snapshot = LIVE.toArray(new RokBotAvatarDrawable[0]);
            }
            boolean any = false;
            for (RokBotAvatarDrawable d : snapshot) {
                if (d != null && d.mVisible && d.getCallback() != null) {
                    d.invalidateSelf();
                    any = true;
                }
            }
            if (any && !sReducedMotion) {
                sTicking = true;
                TICK.postDelayed(this, FRAME_MS);
            }
        }
    };

    private String mStyle = RokBotAvatarRenderer.STYLE_CHASSIS;
    private Bitmap mMask;
    private int mColor = 0xFF1E86FC;
    private boolean mActive;
    private boolean mSelected;
    private int mRingColor = 0xFFC7C7CC;
    private boolean mDark;
    private boolean mVisible = true;
    private double mNextBlinkAt = SystemClock.uptimeMillis() / 1000.0 + 1.0 + Math.random() * 2.5;

    RokBotAvatarDrawable() {
        LIVE.add(this);
    }

    static void setForeground(boolean foreground, boolean reducedMotion) {
        sForeground = foreground;
        sReducedMotion = reducedMotion;
        if (foreground) ensureTicker();
        else {
            TICK.removeCallbacks(TICK_RUNNABLE);
            sTicking = false;
        }
    }

    static void ensureTicker() {
        if (!sForeground || sTicking || sReducedMotion) return;
        sTicking = true;
        TICK.postDelayed(TICK_RUNNABLE, FRAME_MS);
    }

    void update(String style, Bitmap mask, int color, boolean active, boolean selected, int ringColor, boolean dark) {
        boolean changed = !style.equals(mStyle) || mask != mMask || color != mColor || active != mActive
                || selected != mSelected || ringColor != mRingColor || dark != mDark;
        mStyle = style;
        mMask = mask;
        mColor = color;
        mActive = active;
        mSelected = selected;
        mRingColor = ringColor;
        mDark = dark;
        if (changed) invalidateSelf();
        ensureTicker();
    }

    String style() { return mStyle; }

    @Override
    public boolean setVisible(boolean visible, boolean restart) {
        mVisible = visible;
        if (visible) ensureTicker();
        return super.setVisible(visible, restart);
    }

    void detach() {
        mVisible = false;
        LIVE.remove(this);
    }

    @Override
    public void draw(Canvas canvas) {
        Rect b = getBounds();
        int w = b.width();
        int h = b.height();
        if (w <= 0 || h <= 0 || !mVisible) return;
        float size = Math.min(w, h);
        double t = SystemClock.uptimeMillis() / 1000.0;
        float blink = 0f;
        if (t >= mNextBlinkAt) {
            double dt = t - mNextBlinkAt;
            if (dt < 0.16) blink = (float) Math.sin((dt / 0.16) * Math.PI);
            else mNextBlinkAt = t + 2.6 + Math.random() * 2.4;
        }
        canvas.save();
        canvas.translate(b.left + (w - size) / 2f, b.top + (h - size) / 2f);
        if (mSelected) {
            RokBotAvatarRenderer.drawSelectionRing(canvas, mMask, size, mRingColor);
            // The official picker keeps the selected shape at the same size as the others inside its ring.
            float inner = size * RokBotAvatarRenderer.SELECTED_INNER_SCALE;
            canvas.translate((size - inner) / 2f, (size - inner) / 2f);
            size = inner;
        }
        RokBotAvatarRenderer.draw(canvas, mStyle, mMask, "blob", size, t, blink, mActive, mColor, mDark);
        canvas.restore();
    }

    @Override public void setAlpha(int alpha) {}
    @Override public void setColorFilter(ColorFilter colorFilter) {}
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}

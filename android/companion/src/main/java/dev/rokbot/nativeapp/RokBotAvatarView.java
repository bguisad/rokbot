package dev.rokbot.nativeapp;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.View;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Lightweight animated Canvas View rendering one RokBot custom avatar style. All attached visible
 * instances share a single 30 fps main-thread ticker to keep scrolling and battery usage smooth.
 */
final class RokBotAvatarView extends View {
    private static final long FRAME_MS = 33L;
    private static final Set<RokBotAvatarView> ACTIVE_VIEWS =
            Collections.synchronizedSet(Collections.newSetFromMap(new WeakHashMap<>()));
    private static final Handler TICK_HANDLER = new Handler(Looper.getMainLooper());
    private static boolean sTicking = false;
    private static boolean sResumed = true;

    private String mStyleId = RokBotAvatarRenderer.STYLE_CHASSIS;
    private String mPreviewShape = "blob";
    private Bitmap mShapeMask = null;
    private int mBaseColor = 0xFF06B6D4;
    private boolean mActive = false;
    private boolean mAttached = false;
    private double mNextBlinkAt = 0.0;

    private static final Runnable TICK_RUNNABLE = new Runnable() {
        @Override
        public void run() {
            sTicking = false;
            if (!sResumed) return;
            RokBotAvatarView[] snapshot;
            synchronized (ACTIVE_VIEWS) {
                if (ACTIVE_VIEWS.isEmpty()) return;
                snapshot = ACTIVE_VIEWS.toArray(new RokBotAvatarView[0]);
            }
            boolean anyDrawn = false;
            for (RokBotAvatarView view : snapshot) {
                if (view != null && view.isShown() && view.getWidth() > 0 && view.getHeight() > 0) {
                    view.invalidate();
                    anyDrawn = true;
                }
            }
            if (anyDrawn && !isReducedMotionEnabled(snapshot)) {
                sTicking = true;
                TICK_HANDLER.postDelayed(this, FRAME_MS);
            }
        }
    };

    RokBotAvatarView(Context context) {
        super(context);
        setClickable(false);
        setFocusable(false);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        mNextBlinkAt = SystemClock.uptimeMillis() / 1000.0 + 1.0 + Math.random() * 2.5;
    }

    static void setAppForeground(boolean foreground) {
        sResumed = foreground;
        if (foreground) {
            ensureTicker();
        } else {
            TICK_HANDLER.removeCallbacks(TICK_RUNNABLE);
            sTicking = false;
        }
    }

    private static boolean isReducedMotionEnabled(RokBotAvatarView[] snapshot) {
        for (RokBotAvatarView v : snapshot) {
            if (v != null) {
                try {
                    float scale = Settings.Global.getFloat(
                            v.getContext().getContentResolver(),
                            Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
                    return scale <= 0f;
                } catch (Throwable ignored) {
                    return false;
                }
            }
        }
        return false;
    }

    private static void ensureTicker() {
        if (!sResumed || sTicking) return;
        synchronized (ACTIVE_VIEWS) {
            if (ACTIVE_VIEWS.isEmpty()) return;
        }
        sTicking = true;
        TICK_HANDLER.postDelayed(TICK_RUNNABLE, FRAME_MS);
    }

    void setStyleId(String styleId) {
        String next = RokBotAvatarRenderer.isValidStyle(styleId) ? styleId : RokBotAvatarRenderer.STYLE_CHASSIS;
        if (!next.equals(mStyleId)) {
            mStyleId = next;
            invalidate();
        }
    }

    void setBaseColor(int color) {
        if (mBaseColor != color) {
            mBaseColor = color;
            invalidate();
        }
    }

    void setShapeMask(Bitmap mask) {
        if (mShapeMask != mask) {
            mShapeMask = mask;
            invalidate();
        }
    }

    void setPreviewShape(String shape) {
        String next = (shape != null && !shape.isEmpty()) ? shape : "blob";
        if (!next.equals(mPreviewShape)) {
            mPreviewShape = next;
            invalidate();
        }
    }

    void setActive(boolean active) {
        if (mActive != active) {
            mActive = active;
            invalidate();
        }
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        mAttached = true;
        ACTIVE_VIEWS.add(this);
        ensureTicker();
    }

    @Override
    protected void onDetachedFromWindow() {
        mAttached = false;
        ACTIVE_VIEWS.remove(this);
        super.onDetachedFromWindow();
    }

    @Override
    protected void onVisibilityChanged(View changedView, int visibility) {
        super.onVisibilityChanged(changedView, visibility);
        if (mAttached && visibility == VISIBLE) ensureTicker();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        int w = getWidth();
        int h = getHeight();
        if (w <= 0 || h <= 0) return;
        float size = Math.min(w, h);
        double t = SystemClock.uptimeMillis() / 1000.0;
        float blink = 0f;
        if (t >= mNextBlinkAt) {
            double dt = t - mNextBlinkAt;
            if (dt < 0.16) {
                blink = (float) Math.sin((dt / 0.16) * Math.PI);
            } else {
                mNextBlinkAt = t + 2.6 + Math.random() * 2.4;
            }
        }
        boolean isDark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        canvas.save();
        canvas.translate((w - size) / 2f, (h - size) / 2f);
        RokBotAvatarRenderer.draw(canvas, mStyleId, mShapeMask, mPreviewShape, size, t, blink, mActive, mBaseColor, isDark);
        canvas.restore();
    }
}

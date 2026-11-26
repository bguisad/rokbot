package dev.rokbot.nativeapp;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Insets;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.animation.AccelerateInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.PathInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;

/**
 * Polished native bottom sheet for the home top-bar "+" button.
 * Matches RokBot's monochrome light/dark visual language with rounded top corners,
 * drag handle, crisp vector icons, press ripples, smooth slide/fade animation,
 * and dismiss by outside tap, swipe-down, or back key.
 */
final class NewChatChooserSheet {
    interface Listener {
        void onNewBot();
        void onNewGroup();
    }

    private static WeakReference<SheetDialog> sActive = new WeakReference<>(null);

    private NewChatChooserSheet() {}

    static void show(Activity activity, Listener listener) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed() || listener == null) return;
        SheetDialog prev = sActive.get();
        if (prev != null && prev.isShowing()) {
            return;
        }
        SheetDialog dialog = new SheetDialog(activity, listener);
        sActive = new WeakReference<>(dialog);
        dialog.show();
    }

    private static final class SheetDialog extends Dialog {
        private final Activity mActivity;
        private final Listener mListener;
        private final UiChrome.Palette mPalette;
        private final View mScrim;
        private final LinearLayout mSheet;
        private final int mBaseBottomPad;
        private boolean mDismissing = false;
        private Runnable mPendingAction = null;

        // Swipe-to-dismiss state
        private float mDownY;
        private float mDownRawY;
        private boolean mDragging = false;
        private VelocityTracker mVelocityTracker;
        private final int mTouchSlop;

        SheetDialog(Activity activity, Listener listener) {
            super(activity, android.R.style.Theme_Translucent_NoTitleBar);
            mActivity = activity;
            mListener = listener;
            mPalette = UiChrome.palette(activity);
            mTouchSlop = ViewConfiguration.get(activity).getScaledTouchSlop();
            mBaseBottomPad = UiChrome.dp(activity, 18);

            Window w = getWindow();
            if (w != null) {
                w.requestFeature(Window.FEATURE_NO_TITLE);
                w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                w.setStatusBarColor(Color.TRANSPARENT);
                w.setNavigationBarColor(Color.TRANSPARENT);
                if (Build.VERSION.SDK_INT >= 30) {
                    w.setDecorFitsSystemWindows(false);
                }
                if (Build.VERSION.SDK_INT >= 29) {
                    w.setNavigationBarContrastEnforced(false);
                }
            }
            setCancelable(true);
            setCanceledOnTouchOutside(true);

            FrameLayout root = new FrameLayout(activity);
            root.setLayoutParams(new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            // Dimmed backdrop scrim (tap outside to dismiss)
            mScrim = new View(activity);
            mScrim.setContentDescription("create_chooser_scrim");
            mScrim.setBackgroundColor(mPalette.dark ? 0x8A000000 : 0x66000000);
            mScrim.setAlpha(0f);
            mScrim.setOnClickListener(v -> dismissAnimated(null));
            root.addView(mScrim, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            // Bottom sheet surface
            mSheet = new SheetContainer(activity);
            mSheet.setOrientation(LinearLayout.VERTICAL);
            mSheet.setContentDescription("create_chooser_sheet");
            mSheet.setBackground(makeSheetBackground(activity, mPalette));
            mSheet.setElevation(UiChrome.dp(activity, 16));
            mSheet.setClickable(true);
            mSheet.setPadding(0, UiChrome.dp(activity, 10), 0, mBaseBottomPad);

            // Drag handle
            View handle = new View(activity);
            handle.setContentDescription("create_chooser_handle");
            handle.setBackground(UiChrome.roundRect(
                    mPalette.dark ? 0xFF4B4B55 : 0xFFD4D4D8,
                    UiChrome.dp(activity, 2.5f), 0, 0));
            LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                    UiChrome.dp(activity, 38), UiChrome.dp(activity, 4.5f));
            hlp.gravity = Gravity.CENTER_HORIZONTAL;
            hlp.bottomMargin = UiChrome.dp(activity, 14);
            mSheet.addView(handle, hlp);

            // Title
            TextView title = new TextView(activity);
            title.setContentDescription("create_chooser_title");
            title.setText(Localize.t(activity, "新建", "Create"));
            title.setTextColor(mPalette.textPrimary);
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            title.setPadding(UiChrome.dp(activity, 20), 0, UiChrome.dp(activity, 20), UiChrome.dp(activity, 12));
            mSheet.addView(title);

            // Action rows inside subtle inset group matching companion cards
            LinearLayout listWrap = new LinearLayout(activity);
            listWrap.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams lwp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lwp.leftMargin = UiChrome.dp(activity, 14);
            lwp.rightMargin = UiChrome.dp(activity, 14);
            listWrap.setLayoutParams(lwp);
            listWrap.setBackground(UiChrome.roundRect(
                    mPalette.dark ? 0xFF25252B : 0xFFF7F7F9,
                    UiChrome.dp(activity, 18),
                    mPalette.border,
                    Math.max(1, UiChrome.dp(activity, 0.8f))));
            listWrap.setClipToOutline(true);

            listWrap.addView(makeActionRow(
                    activity,
                    "create_chooser_new_bot",
                    ICON_NEW_BOT,
                    Localize.t(activity, "新建 Bot", "New Bot"),
                    Localize.t(activity, "创建一个新的专属 AI 助手", "Create a dedicated AI assistant"),
                    () -> dismissAnimated(mListener::onNewBot)
            ));

            View divider = new View(activity);
            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, UiChrome.dp(activity, 0.7f)));
            dlp.leftMargin = UiChrome.dp(activity, 72);
            dlp.rightMargin = UiChrome.dp(activity, 16);
            divider.setLayoutParams(dlp);
            divider.setBackgroundColor(mPalette.border);
            listWrap.addView(divider);

            listWrap.addView(makeActionRow(
                    activity,
                    "create_chooser_new_group",
                    ICON_NEW_GROUP,
                    Localize.t(activity, "新建群组", "New Group"),
                    Localize.t(activity, "拉多个 Bot 在同一群聊中协作", "Bring multiple Bots into one chat"),
                    () -> dismissAnimated(mListener::onNewGroup)
            ));

            mSheet.addView(listWrap);

            FrameLayout.LayoutParams slp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            slp.gravity = Gravity.BOTTOM;
            root.addView(mSheet, slp);

            applyBottomInsets(root);
            setContentView(root);

            // Configure light/dark nav bar icons after window decor is ready
            if (w != null && Build.VERSION.SDK_INT >= 30) {
                try {
                    WindowInsetsController ctrl = w.getInsetsController();
                    if (ctrl != null) {
                        int lightNav = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                        ctrl.setSystemBarsAppearance(mPalette.dark ? 0 : lightNav, lightNav);
                    }
                } catch (Throwable ignored) {}
            }

            // Prepare slide-up animation on first layout
            mSheet.setVisibility(View.INVISIBLE);
            mSheet.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
                @Override
                public boolean onPreDraw() {
                    mSheet.getViewTreeObserver().removeOnPreDrawListener(this);
                    int h = mSheet.getHeight();
                    if (h <= 0) h = UiChrome.dp(activity, 260);
                    mSheet.setTranslationY(h);
                    mSheet.setVisibility(View.VISIBLE);

                    ObjectAnimator slideIn = ObjectAnimator.ofFloat(mSheet, View.TRANSLATION_Y, h, 0f);
                    slideIn.setDuration(250L);
                    slideIn.setInterpolator(new PathInterpolator(0.2f, 0.9f, 0.2f, 1.0f));

                    ObjectAnimator fadeIn = ObjectAnimator.ofFloat(mScrim, View.ALPHA, 0f, 1f);
                    fadeIn.setDuration(210L);
                    fadeIn.setInterpolator(new DecelerateInterpolator());

                    AnimatorSet set = new AnimatorSet();
                    set.playTogether(slideIn, fadeIn);
                    set.start();
                    return true;
                }
            });
        }

        private void applyBottomInsets(View root) {
            if (Build.VERSION.SDK_INT >= 30) {
                root.setOnApplyWindowInsetsListener((v, insets) -> {
                    Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    mSheet.setPadding(
                            bars.left,
                            UiChrome.dp(mActivity, 10),
                            bars.right,
                            mBaseBottomPad + bars.bottom
                    );
                    return WindowInsets.CONSUMED;
                });
                root.requestApplyInsets();
            } else {
                int resId = mActivity.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
                int navH = resId > 0 ? mActivity.getResources().getDimensionPixelSize(resId) : 0;
                mSheet.setPadding(0, UiChrome.dp(mActivity, 10), 0, mBaseBottomPad + navH);
            }
        }

        private View makeActionRow(Context ctx, String contentDesc, int iconKind,
                                   String titleText, String descText, Runnable onClick) {
            LinearLayout row = new LinearLayout(ctx);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setContentDescription(contentDesc);
            row.setMinimumHeight(UiChrome.dp(ctx, 72));
            row.setPadding(UiChrome.dp(ctx, 16), UiChrome.dp(ctx, 14), UiChrome.dp(ctx, 16), UiChrome.dp(ctx, 14));
            row.setClickable(true);
            row.setFocusable(true);
            row.setBackground(new RippleDrawable(
                    ColorStateList.valueOf((mPalette.textPrimary & 0x00FFFFFF) | 0x1A000000),
                    null,
                    new ColorDrawable(0xFFFFFFFF)));
            row.setOnClickListener(v -> onClick.run());

            // Crisp icon badge container
            int badgeSize = UiChrome.dp(ctx, 44);
            ImageView iconBadge = new ImageView(ctx);
            LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(badgeSize, badgeSize);
            ilp.rightMargin = UiChrome.dp(ctx, 14);
            iconBadge.setLayoutParams(ilp);
            iconBadge.setScaleType(ImageView.ScaleType.CENTER);
            iconBadge.setBackground(UiChrome.circle(
                    mPalette.dark ? 0xFF32323A : 0xFFFFFFFF,
                    mPalette.border,
                    Math.max(1, UiChrome.dp(ctx, 0.8f))));
            iconBadge.setImageDrawable(new SheetIconDrawable(
                    iconKind, mPalette.textPrimary, UiChrome.dp(ctx, 22), UiChrome.dp(ctx, 1.85f)));
            row.addView(iconBadge);

            // Title + 1-line secondary description
            LinearLayout textCol = new LinearLayout(ctx);
            textCol.setOrientation(LinearLayout.VERTICAL);
            textCol.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            TextView titleTv = new TextView(ctx);
            titleTv.setText(titleText);
            titleTv.setTextColor(mPalette.textPrimary);
            titleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
            titleTv.setTypeface(Typeface.DEFAULT_BOLD);
            titleTv.setSingleLine(true);
            titleTv.setEllipsize(TextUtils.TruncateAt.END);
            textCol.addView(titleTv);

            TextView descTv = new TextView(ctx);
            descTv.setText(descText);
            descTv.setTextColor(mPalette.textSecondary);
            descTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            descTv.setSingleLine(true);
            descTv.setEllipsize(TextUtils.TruncateAt.END);
            descTv.setPadding(0, UiChrome.dp(ctx, 2.5f), 0, 0);
            textCol.addView(descTv);
            row.addView(textCol);

            // Trailing chevron
            View chevron = new View(ctx);
            int chevSize = UiChrome.dp(ctx, 16);
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(chevSize, chevSize);
            clp.leftMargin = UiChrome.dp(ctx, 10);
            chevron.setLayoutParams(clp);
            chevron.setBackground(new SheetIconDrawable(
                    ICON_CHEVRON, mPalette.textMuted, chevSize, UiChrome.dp(ctx, 1.7f)));
            row.addView(chevron);

            return row;
        }

        private static GradientDrawable makeSheetBackground(Context ctx, UiChrome.Palette p) {
            float r = UiChrome.dp(ctx, 24);
            GradientDrawable d = new GradientDrawable();
            d.setColor(p.bgCard);
            d.setCornerRadii(new float[] { r, r, r, r, 0f, 0f, 0f, 0f });
            if (p.dark) {
                d.setStroke(Math.max(1, UiChrome.dp(ctx, 0.8f)), p.border);
            }
            return d;
        }

        @Override
        public void onBackPressed() {
            dismissAnimated(null);
        }

        @Override
        public void cancel() {
            dismissAnimated(null);
        }

        private void dismissAnimated(Runnable afterDismiss) {
            if (mDismissing) return;
            mDismissing = true;
            mPendingAction = afterDismiss;

            int h = mSheet.getHeight();
            if (h <= 0) h = UiChrome.dp(mActivity, 260);
            float startY = mSheet.getTranslationY();
            float remainFrac = Math.max(0.25f, 1f - (startY / Math.max(1f, h)));
            long dur = Math.round(180L * remainFrac);

            ObjectAnimator slideOut = ObjectAnimator.ofFloat(mSheet, View.TRANSLATION_Y, startY, h);
            slideOut.setDuration(dur);
            slideOut.setInterpolator(new AccelerateInterpolator(1.2f));

            ObjectAnimator fadeOut = ObjectAnimator.ofFloat(mScrim, View.ALPHA, mScrim.getAlpha(), 0f);
            fadeOut.setDuration(dur);

            AnimatorSet set = new AnimatorSet();
            set.playTogether(slideOut, fadeOut);
            set.addListener(new AnimatorListenerAdapter() {
                @Override
                public void onAnimationEnd(Animator animation) {
                    finishDismiss();
                }
            });
            set.start();
        }

        private void finishDismiss() {
            try {
                if (isShowing()) {
                    SheetDialog.super.dismiss();
                }
            } catch (Throwable ignored) {}
            if (sActive.get() == this) {
                sActive = new WeakReference<>(null);
            }
            Runnable action = mPendingAction;
            mPendingAction = null;
            if (action != null && !mActivity.isFinishing() && !mActivity.isDestroyed()) {
                action.run();
            }
        }

        private void recycleVelocity() {
            if (mVelocityTracker != null) {
                mVelocityTracker.recycle();
                mVelocityTracker = null;
            }
        }

        /** LinearLayout container supporting smooth swipe-down dismissal while preserving child taps. */
        private final class SheetContainer extends LinearLayout {
            SheetContainer(Context context) {
                super(context);
            }

            @Override
            public boolean onInterceptTouchEvent(MotionEvent ev) {
                if (mDismissing) return true;
                int action = ev.getActionMasked();
                if (action == MotionEvent.ACTION_DOWN) {
                    mDownRawY = ev.getRawY();
                    mDownY = mSheet.getTranslationY();
                    mDragging = false;
                    recycleVelocity();
                    mVelocityTracker = VelocityTracker.obtain();
                    mVelocityTracker.addMovement(ev);
                } else if (action == MotionEvent.ACTION_MOVE) {
                    if (mVelocityTracker != null) mVelocityTracker.addMovement(ev);
                    float dy = ev.getRawY() - mDownRawY;
                    if (dy > mTouchSlop) {
                        mDragging = true;
                        return true;
                    }
                } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                    recycleVelocity();
                    mDragging = false;
                }
                return false;
            }

            @Override
            public boolean onTouchEvent(MotionEvent ev) {
                if (mDismissing) return true;
                int action = ev.getActionMasked();
                if (mVelocityTracker != null) mVelocityTracker.addMovement(ev);
                if (action == MotionEvent.ACTION_DOWN) {
                    mDownRawY = ev.getRawY();
                    mDownY = mSheet.getTranslationY();
                    return true;
                } else if (action == MotionEvent.ACTION_MOVE) {
                    float dy = ev.getRawY() - mDownRawY;
                    if (!mDragging && dy > mTouchSlop) {
                        mDragging = true;
                    }
                    if (mDragging) {
                        float nextY = Math.max(0f, mDownY + dy);
                        mSheet.setTranslationY(nextY);
                        float h = Math.max(1f, mSheet.getHeight());
                        mScrim.setAlpha(Math.max(0f, 1f - (nextY / h) * 0.9f));
                    }
                    return true;
                } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                    if (mDragging) {
                        float vy = 0f;
                        if (mVelocityTracker != null) {
                            mVelocityTracker.computeCurrentVelocity(1000);
                            vy = mVelocityTracker.getYVelocity();
                        }
                        recycleVelocity();
                        mDragging = false;
                        float h = Math.max(1f, mSheet.getHeight());
                        float currentY = mSheet.getTranslationY();
                        float flingThreshold = UiChrome.dp(mActivity, 650);
                        if (currentY > h * 0.30f || vy > flingThreshold) {
                            dismissAnimated(null);
                        } else {
                            ObjectAnimator snap = ObjectAnimator.ofFloat(mSheet, View.TRANSLATION_Y, currentY, 0f);
                            snap.setDuration(200L);
                            snap.setInterpolator(new PathInterpolator(0.2f, 0.9f, 0.2f, 1.0f));
                            ObjectAnimator scrimBack = ObjectAnimator.ofFloat(mScrim, View.ALPHA, mScrim.getAlpha(), 1f);
                            scrimBack.setDuration(180L);
                            AnimatorSet set = new AnimatorSet();
                            set.playTogether(snap, scrimBack);
                            set.start();
                        }
                        return true;
                    }
                    recycleVelocity();
                    return true;
                }
                return super.onTouchEvent(ev);
            }
        }
    }

    private static final int ICON_NEW_BOT = 1;
    private static final int ICON_NEW_GROUP = 2;
    private static final int ICON_CHEVRON = 3;

    /** Crisp Lucide-style vector icons matching UiChrome's stroke weight and rounded caps. */
    private static final class SheetIconDrawable extends Drawable {
        private final int mKind;
        private final int mSizePx;
        private final Paint mStroke;
        private final Paint mFill;

        SheetIconDrawable(int kind, int color, int sizePx, float strokePx) {
            mKind = kind;
            mSizePx = sizePx;
            mStroke = new Paint(Paint.ANTI_ALIAS_FLAG);
            mStroke.setColor(color);
            mStroke.setStyle(Paint.Style.STROKE);
            mStroke.setStrokeWidth(strokePx);
            mStroke.setStrokeCap(Paint.Cap.ROUND);
            mStroke.setStrokeJoin(Paint.Join.ROUND);

            mFill = new Paint(Paint.ANTI_ALIAS_FLAG);
            mFill.setColor(color);
            mFill.setStyle(Paint.Style.FILL);
        }

        @Override
        public void draw(Canvas canvas) {
            android.graphics.Rect b = getBounds();
            float s = Math.min(b.width(), b.height());
            if (s <= 0f) return;
            float ox = b.left + (b.width() - s) * 0.5f;
            float oy = b.top + (b.height() - s) * 0.5f;
            canvas.save();
            canvas.translate(ox, oy);
            // Draw in 24x24 design space scaled cleanly to target size
            float scale = s / 24f;
            canvas.scale(scale, scale);
            float origStroke = mStroke.getStrokeWidth();
            mStroke.setStrokeWidth(origStroke / scale);

            if (mKind == ICON_NEW_BOT) {
                // Minimalist RokBot head with antenna and two crisp pill eyes + small plus accent
                // Antenna
                canvas.drawLine(12f, 3.2f, 12f, 6.8f, mStroke);
                canvas.drawCircle(12f, 2.7f, 1.0f, mFill);
                // Bot chassis body
                RectF head = new RectF(3.5f, 7f, 20.5f, 19.5f);
                canvas.drawRoundRect(head, 4.2f, 4.2f, mStroke);
                // Side ear nubs
                canvas.drawLine(1.8f, 11.8f, 3.3f, 11.8f, mStroke);
                canvas.drawLine(20.7f, 11.8f, 22.2f, 11.8f, mStroke);
                // Two subtle vertical pill eyes (RokBot signature)
                canvas.drawLine(9.2f, 12.0f, 9.2f, 14.4f, mStroke);
                canvas.drawLine(14.8f, 12.0f, 14.8f, 14.4f, mStroke);
            } else if (mKind == ICON_NEW_GROUP) {
                // Multi-person / group icon (Lucide "users")
                // Front-left person head & shoulders
                canvas.drawCircle(9.2f, 7.8f, 3.3f, mStroke);
                Path frontBody = new Path();
                frontBody.moveTo(2.8f, 19.8f);
                frontBody.cubicTo(2.8f, 15.8f, 5.4f, 14.2f, 9.2f, 14.2f);
                frontBody.cubicTo(13.0f, 14.2f, 15.6f, 15.8f, 15.6f, 19.8f);
                canvas.drawPath(frontBody, mStroke);

                // Back-right person head arc & shoulder arc
                Path backHead = new Path();
                RectF bhRect = new RectF(13.2f, 5.2f, 19.0f, 11.0f);
                backHead.addArc(bhRect, -65f, 145f);
                canvas.drawPath(backHead, mStroke);

                Path backBody = new Path();
                backBody.moveTo(16.8f, 14.6f);
                backBody.cubicTo(19.6f, 15.1f, 21.3f, 16.8f, 21.3f, 19.8f);
                canvas.drawPath(backBody, mStroke);
            } else if (mKind == ICON_CHEVRON) {
                Path p = new Path();
                p.moveTo(9.2f, 6.2f);
                p.lineTo(15.0f, 12.0f);
                p.lineTo(9.2f, 17.8f);
                canvas.drawPath(p, mStroke);
            }

            mStroke.setStrokeWidth(origStroke);
            canvas.restore();
        }

        @Override public void setAlpha(int alpha) { mStroke.setAlpha(alpha); mFill.setAlpha(alpha); }
        @Override public void setColorFilter(ColorFilter cf) { mStroke.setColorFilter(cf); mFill.setColorFilter(cf); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        @Override public int getIntrinsicWidth() { return mSizePx; }
        @Override public int getIntrinsicHeight() { return mSizePx; }
    }
}

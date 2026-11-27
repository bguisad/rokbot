package dev.rokbot.nativeapp;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Insets;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
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
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * RokBot-styled replacement for the platform drop-down: a rounded field row showing the chosen label and a
 * chevron. Tapping it opens a bottom sheet (rounded card list, vector check on the chosen row)
 * that follows UiChrome's light/dark palette. Keeps the small surface the screens use:
 * options, selection position and a change listener that only fires for user picks.
 */
public final class ChoiceField extends LinearLayout {
    public interface OnChoiceListener {
        void onChoice(int position);
    }

    private final TextView mValue;
    private final View mChevron;
    private final List<String> mOptions = new ArrayList<>();
    private int mSelection = -1;
    private String mTitle = "";
    private OnChoiceListener mListener;

    public ChoiceField(Context context) {
        super(context);
        UiChrome.Palette p = UiChrome.palette(context);
        setOrientation(HORIZONTAL);
        setGravity(Gravity.CENTER_VERTICAL);
        setMinimumHeight(UiChrome.dp(context, 46));
        setPadding(UiChrome.dp(context, 14), UiChrome.dp(context, 11), UiChrome.dp(context, 12), UiChrome.dp(context, 11));
        setBackground(UiChrome.roundRect(p.bgSurface2, UiChrome.dp(context, 14), p.border, UiChrome.dp(context, 1)));
        setClickable(true);
        setFocusable(true);

        mValue = new TextView(context);
        mValue.setTextColor(p.textPrimary);
        mValue.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        mValue.setSingleLine(true);
        mValue.setEllipsize(TextUtils.TruncateAt.END);
        addView(mValue, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        mChevron = new View(context);
        int chevron = UiChrome.dp(context, 16);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(chevron, chevron);
        clp.leftMargin = UiChrome.dp(context, 8);
        mChevron.setBackground(new GlyphDrawable(GlyphDrawable.CHEVRON_DOWN, p.textMuted, UiChrome.dp(context, 1.6f)));
        addView(mChevron, clp);

        setOnClickListener(v -> open());
    }

    public void setTitle(String title) {
        mTitle = title != null ? title : "";
    }

    public void setOptions(List<String> labels) {
        mOptions.clear();
        if (labels != null) mOptions.addAll(labels);
        if (mSelection >= mOptions.size()) mSelection = mOptions.isEmpty() ? -1 : 0;
        if (mSelection < 0 && !mOptions.isEmpty()) mSelection = 0;
        renderValue();
    }

    public void setOptions(String[] labels) {
        List<String> list = new ArrayList<>();
        if (labels != null) for (String label : labels) list.add(label);
        setOptions(list);
    }

    public List<String> getOptions() {
        return new ArrayList<>(mOptions);
    }

    public void setSelection(int position) {
        mSelection = position >= 0 && position < mOptions.size() ? position : (mOptions.isEmpty() ? -1 : 0);
        renderValue();
    }

    public int getSelectedItemPosition() {
        return mSelection;
    }

    public void setOnChoiceListener(OnChoiceListener listener) {
        mListener = listener;
    }

    @Override
    public void setEnabled(boolean enabled) {
        super.setEnabled(enabled);
        setAlpha(enabled ? 1f : 0.5f);
    }

    private void renderValue() {
        mValue.setText(mSelection >= 0 && mSelection < mOptions.size() ? mOptions.get(mSelection) : "");
    }

    private void open() {
        if (!isEnabled() || mOptions.isEmpty()) return;
        Activity activity = activityOf(getContext());
        if (activity == null) return;
        Sheet.show(activity, mTitle, mOptions, mSelection, position -> {
            if (position < 0 || position >= mOptions.size() || position == mSelection) return;
            mSelection = position;
            renderValue();
            if (mListener != null) mListener.onChoice(position);
        });
    }

    private static Activity activityOf(Context context) {
        while (context instanceof ContextWrapper) {
            if (context instanceof Activity) return (Activity) context;
            context = ((ContextWrapper) context).getBaseContext();
        }
        return null;
    }

    /** Shows a bottom-sheet list of labels with a check on the selected row instead of a platform pop-up list. */
    static void showSheet(Activity activity, String title, List<String> labels, int selected, OnChoiceListener listener) {
        Sheet.show(activity, title, labels, selected, listener);
    }

    private static final class Sheet extends Dialog {
        private static Sheet sActive;

        private final Activity mActivity;
        private final UiChrome.Palette mPalette;
        private final View mScrim;
        private final LinearLayout mSheet;
        private final int mBaseBottomPad;
        private boolean mDismissing = false;
        private Runnable mPendingAction;

        static void show(Activity activity, String title, List<String> labels, int selected, OnChoiceListener listener) {
            if (activity == null || activity.isFinishing() || activity.isDestroyed() || labels == null || labels.isEmpty()) return;
            if (sActive != null && sActive.isShowing()) return;
            sActive = new Sheet(activity, title, labels, selected, listener);
            sActive.show();
        }

        private Sheet(Activity activity, String title, List<String> labels, int selected, OnChoiceListener listener) {
            super(activity, android.R.style.Theme_Translucent_NoTitleBar);
            mActivity = activity;
            mPalette = UiChrome.palette(activity);
            mBaseBottomPad = UiChrome.dp(activity, 18);
            final UiChrome.Palette p = mPalette;

            Window w = getWindow();
            if (w != null) {
                w.requestFeature(Window.FEATURE_NO_TITLE);
                w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
                w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                w.setStatusBarColor(Color.TRANSPARENT);
                w.setNavigationBarColor(Color.TRANSPARENT);
                if (Build.VERSION.SDK_INT >= 30) w.setDecorFitsSystemWindows(false);
                if (Build.VERSION.SDK_INT >= 29) w.setNavigationBarContrastEnforced(false);
            }
            setCancelable(true);
            setCanceledOnTouchOutside(true);

            FrameLayout root = new FrameLayout(activity);
            mScrim = new View(activity);
            mScrim.setContentDescription("choice_sheet_scrim");
            mScrim.setBackgroundColor(p.dark ? 0x8A000000 : 0x66000000);
            mScrim.setAlpha(0f);
            mScrim.setOnClickListener(v -> dismissAnimated(null));
            root.addView(mScrim, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            mSheet = new LinearLayout(activity);
            mSheet.setOrientation(LinearLayout.VERTICAL);
            mSheet.setContentDescription("choice_sheet");
            mSheet.setBackground(sheetBackground(activity, p));
            mSheet.setElevation(UiChrome.dp(activity, 16));
            mSheet.setClickable(true);
            mSheet.setPadding(0, UiChrome.dp(activity, 10), 0, mBaseBottomPad);

            View handle = new View(activity);
            handle.setBackground(UiChrome.roundRect(p.dark ? 0xFF4B4B55 : 0xFFD4D4D8, UiChrome.dp(activity, 2.5f), 0, 0));
            LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(UiChrome.dp(activity, 38), UiChrome.dp(activity, 4.5f));
            hlp.gravity = Gravity.CENTER_HORIZONTAL;
            hlp.bottomMargin = UiChrome.dp(activity, 14);
            mSheet.addView(handle, hlp);

            if (title != null && !title.isEmpty()) {
                TextView titleView = new TextView(activity);
                titleView.setContentDescription("choice_sheet_title");
                titleView.setText(title);
                titleView.setTextColor(p.textPrimary);
                titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
                titleView.setTypeface(Typeface.DEFAULT_BOLD);
                titleView.setSingleLine(true);
                titleView.setEllipsize(TextUtils.TruncateAt.END);
                titleView.setPadding(UiChrome.dp(activity, 20), 0, UiChrome.dp(activity, 20), UiChrome.dp(activity, 12));
                mSheet.addView(titleView);
            }

            LinearLayout list = new LinearLayout(activity);
            list.setOrientation(LinearLayout.VERTICAL);
            list.setContentDescription("choice_sheet_list");
            list.setBackground(UiChrome.roundRect(p.dark ? 0xFF25252B : 0xFFF7F7F9, UiChrome.dp(activity, 18),
                    p.border, Math.max(1, UiChrome.dp(activity, 0.8f))));
            list.setClipToOutline(true);
            View selectedRow = null;
            for (int i = 0; i < labels.size(); i++) {
                if (i > 0) {
                    View divider = new View(activity);
                    divider.setBackgroundColor(p.border);
                    LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, UiChrome.dp(activity, 0.7f)));
                    dlp.leftMargin = UiChrome.dp(activity, 16);
                    list.addView(divider, dlp);
                }
                final int position = i;
                View row = optionRow(activity, labels.get(i), i == selected, () ->
                        dismissAnimated(listener != null ? () -> listener.onChoice(position) : null));
                row.setContentDescription("choice_option_" + i);
                list.addView(row);
                if (i == selected) selectedRow = row;
            }

            final int maxListHeight = Math.round(activity.getResources().getDisplayMetrics().heightPixels * 0.62f);
            ScrollView scroll = new ScrollView(activity) {
                @Override
                protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
                    super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(maxListHeight, View.MeasureSpec.AT_MOST));
                }
            };
            scroll.setVerticalScrollBarEnabled(false);
            scroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
            scroll.addView(list, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            slp.leftMargin = UiChrome.dp(activity, 14);
            slp.rightMargin = UiChrome.dp(activity, 14);
            mSheet.addView(scroll, slp);

            FrameLayout.LayoutParams sheetLp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            sheetLp.gravity = Gravity.BOTTOM;
            root.addView(mSheet, sheetLp);
            applyBottomInsets(root);
            setContentView(root);

            if (w != null && Build.VERSION.SDK_INT >= 30) {
                try {
                    WindowInsetsController ctrl = w.getInsetsController();
                    if (ctrl != null) {
                        int lightNav = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                        ctrl.setSystemBarsAppearance(p.dark ? 0 : lightNav, lightNav);
                    }
                } catch (Throwable ignored) {}
            }

            final View target = selectedRow;
            mSheet.setVisibility(View.INVISIBLE);
            mSheet.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
                @Override
                public boolean onPreDraw() {
                    mSheet.getViewTreeObserver().removeOnPreDrawListener(this);
                    if (target != null && target.getBottom() > scroll.getHeight()) {
                        scroll.scrollTo(0, Math.max(0, target.getTop() - scroll.getHeight() / 3));
                    }
                    int h = mSheet.getHeight() > 0 ? mSheet.getHeight() : UiChrome.dp(activity, 260);
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

        private View optionRow(Context ctx, String label, boolean chosen, Runnable onClick) {
            UiChrome.Palette p = mPalette;
            LinearLayout row = new LinearLayout(ctx);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setMinimumHeight(UiChrome.dp(ctx, 52));
            row.setPadding(UiChrome.dp(ctx, 16), UiChrome.dp(ctx, 12), UiChrome.dp(ctx, 16), UiChrome.dp(ctx, 12));
            row.setClickable(true);
            row.setFocusable(true);
            row.setSelected(chosen);
            row.setBackground(new RippleDrawable(
                    ColorStateList.valueOf((p.textPrimary & 0x00FFFFFF) | 0x1A000000), null, new ColorDrawable(0xFFFFFFFF)));
            row.setOnClickListener(v -> onClick.run());

            TextView text = new TextView(ctx);
            text.setText(label);
            text.setTextColor(p.textPrimary);
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            text.setTypeface(chosen ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            text.setMaxLines(2);
            text.setEllipsize(TextUtils.TruncateAt.END);
            row.addView(text, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            View check = new View(ctx);
            int size = UiChrome.dp(ctx, 20);
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(size, size);
            clp.leftMargin = UiChrome.dp(ctx, 12);
            if (chosen) {
                check.setContentDescription("choice_option_checked");
                check.setBackground(new GlyphDrawable(GlyphDrawable.CHECK, p.blueAccent, UiChrome.dp(ctx, 2f)));
            }
            row.addView(check, clp);
            return row;
        }

        private static GradientDrawable sheetBackground(Context ctx, UiChrome.Palette p) {
            float r = UiChrome.dp(ctx, 24);
            GradientDrawable d = new GradientDrawable();
            d.setColor(p.bgCard);
            d.setCornerRadii(new float[] { r, r, r, r, 0f, 0f, 0f, 0f });
            if (p.dark) d.setStroke(Math.max(1, UiChrome.dp(ctx, 0.8f)), p.border);
            return d;
        }

        private void applyBottomInsets(View root) {
            if (Build.VERSION.SDK_INT >= 30) {
                root.setOnApplyWindowInsetsListener((v, insets) -> {
                    Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    mSheet.setPadding(bars.left, UiChrome.dp(mActivity, 10), bars.right, mBaseBottomPad + bars.bottom);
                    return WindowInsets.CONSUMED;
                });
                root.requestApplyInsets();
            } else {
                int resId = mActivity.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
                int navH = resId > 0 ? mActivity.getResources().getDimensionPixelSize(resId) : 0;
                mSheet.setPadding(0, UiChrome.dp(mActivity, 10), 0, mBaseBottomPad + navH);
            }
        }

        @Override
        public void onBackPressed() {
            dismissAnimated(null);
        }

        @Override
        public void cancel() {
            dismissAnimated(null);
        }

        private void dismissAnimated(Runnable after) {
            if (mDismissing) return;
            mDismissing = true;
            mPendingAction = after;
            int h = mSheet.getHeight() > 0 ? mSheet.getHeight() : UiChrome.dp(mActivity, 260);
            ObjectAnimator slideOut = ObjectAnimator.ofFloat(mSheet, View.TRANSLATION_Y, mSheet.getTranslationY(), h);
            slideOut.setDuration(180L);
            slideOut.setInterpolator(new AccelerateInterpolator(1.2f));
            ObjectAnimator fadeOut = ObjectAnimator.ofFloat(mScrim, View.ALPHA, mScrim.getAlpha(), 0f);
            fadeOut.setDuration(180L);
            AnimatorSet set = new AnimatorSet();
            set.playTogether(slideOut, fadeOut);
            set.addListener(new AnimatorListenerAdapter() {
                @Override
                public void onAnimationEnd(Animator animation) {
                    try {
                        if (isShowing()) Sheet.super.dismiss();
                    } catch (Throwable ignored) {}
                    if (sActive == Sheet.this) sActive = null;
                    Runnable action = mPendingAction;
                    mPendingAction = null;
                    if (action != null && !mActivity.isFinishing() && !mActivity.isDestroyed()) action.run();
                }
            });
            set.start();
        }
    }

    /** Stroke glyphs on a 24px grid, matching the other native screens' rounded caps. */
    private static final class GlyphDrawable extends Drawable {
        static final int CHEVRON_DOWN = 1;
        static final int CHECK = 2;

        private final int mKind;
        private final int mColor;
        private final float mStrokePx;
        private Paint mPaint;

        GlyphDrawable(int kind, int color, float strokePx) {
            mKind = kind;
            mColor = color;
            mStrokePx = strokePx;
        }

        @Override
        public void draw(Canvas canvas) {
            android.graphics.Rect b = getBounds();
            float s = Math.min(b.width(), b.height());
            if (s <= 0f) return;
            if (mPaint == null) {
                mPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                mPaint.setColor(mColor);
                mPaint.setStyle(Paint.Style.STROKE);
                mPaint.setStrokeCap(Paint.Cap.ROUND);
                mPaint.setStrokeJoin(Paint.Join.ROUND);
            }
            float scale = s / 24f;
            mPaint.setStrokeWidth(mStrokePx / scale);
            canvas.save();
            canvas.translate(b.left + (b.width() - s) * 0.5f, b.top + (b.height() - s) * 0.5f);
            canvas.scale(scale, scale);
            Path path = new Path();
            if (mKind == CHECK) {
                path.moveTo(5f, 12.5f);
                path.lineTo(9.5f, 17f);
                path.lineTo(19f, 7.5f);
            } else {
                path.moveTo(6.5f, 9.5f);
                path.lineTo(12f, 15f);
                path.lineTo(17.5f, 9.5f);
            }
            canvas.drawPath(path, mPaint);
            canvas.restore();
        }

        @Override public void setAlpha(int alpha) { if (mPaint != null) mPaint.setAlpha(alpha); }
        @Override public void setColorFilter(ColorFilter cf) { if (mPaint != null) mPaint.setColorFilter(cf); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }
}

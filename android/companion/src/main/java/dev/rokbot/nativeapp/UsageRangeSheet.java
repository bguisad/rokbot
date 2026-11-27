package dev.rokbot.nativeapp;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.TextPaint;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
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
import android.widget.TextView;

/**
 * The custom range picker of the usage page: a RokBot-styled bottom sheet with a month calendar
 * drawn on a Canvas (Monday first). The first tap picks the start, the second the end; days after
 * today are disabled and the range is at most UsageReport.MAX_CUSTOM_DAYS days. No platform
 * date picker.
 */
final class UsageRangeSheet extends Dialog {
    interface Listener {
        void onRange(String from, String to);
    }

    private static UsageRangeSheet sActive;

    private final Activity mActivity;
    private final UiChrome.Palette mP;
    private final boolean mZh;
    private final String mToday;
    private final Listener mListener;
    private final View mScrim;
    private final LinearLayout mSheet;
    private final TextView mMonthTitle, mSummary;
    private final MonthGrid mGrid;
    private final int mBaseBottomPad;
    private int mYear, mMonth;
    private String mFrom, mTo;
    private boolean mDismissing;

    static void show(Activity activity, String today, String from, String to, Listener listener) {
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        if (sActive != null && sActive.isShowing()) return;
        sActive = new UsageRangeSheet(activity, today, from, to, listener);
        sActive.show();
    }

    private int dp(float v) { return UiChrome.dp(mActivity, v); }

    private String t(String zh, String en) { return mZh ? zh : en; }

    private UsageRangeSheet(Activity activity, String today, String from, String to, Listener listener) {
        super(activity, android.R.style.Theme_Translucent_NoTitleBar);
        mActivity = activity;
        mP = UiChrome.palette(activity);
        mZh = Localize.isChinese(activity);
        mToday = today;
        mListener = listener;
        mFrom = UsageReport.validDate(from) ? from : null;
        mTo = mFrom != null && UsageReport.validDate(to) ? to : null;
        String focus = mTo != null ? mTo : mFrom != null ? mFrom : today;
        mYear = Integer.parseInt(focus.substring(0, 4));
        mMonth = Integer.parseInt(focus.substring(5, 7));
        mBaseBottomPad = dp(18);

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
        mScrim.setContentDescription("usage_range_scrim");
        mScrim.setBackgroundColor(mP.dark ? 0x8A000000 : 0x66000000);
        mScrim.setAlpha(0f);
        mScrim.setOnClickListener(v -> dismissAnimated(null));
        root.addView(mScrim, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        mSheet = new LinearLayout(activity);
        mSheet.setOrientation(LinearLayout.VERTICAL);
        mSheet.setContentDescription("usage_range_sheet");
        float r = dp(24);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(mP.bgCard);
        bg.setCornerRadii(new float[] {r, r, r, r, 0f, 0f, 0f, 0f});
        if (mP.dark) bg.setStroke(Math.max(1, dp(0.8f)), mP.border);
        mSheet.setBackground(bg);
        mSheet.setElevation(dp(16));
        mSheet.setClickable(true);
        mSheet.setPadding(0, dp(10), 0, mBaseBottomPad);

        View handle = new View(activity);
        handle.setBackground(UiChrome.roundRect(mP.dark ? 0xFF4B4B55 : 0xFFD4D4D8, dp(2.5f), 0, 0));
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(dp(38), dp(4.5f));
        hlp.gravity = Gravity.CENTER_HORIZONTAL;
        hlp.bottomMargin = dp(14);
        mSheet.addView(handle, hlp);

        TextView title = text(mP.textPrimary, 18, true);
        title.setText(t("自定义范围", "Custom range"));
        title.setPadding(dp(20), 0, dp(20), dp(4));
        mSheet.addView(title);

        mSummary = text(mP.textSecondary, 13, false);
        mSummary.setContentDescription("usage_range_summary");
        mSummary.setPadding(dp(20), 0, dp(20), dp(10));
        mSheet.addView(mSummary);

        LinearLayout nav = new LinearLayout(activity);
        nav.setOrientation(LinearLayout.HORIZONTAL);
        nav.setGravity(Gravity.CENTER_VERTICAL);
        nav.setPadding(dp(14), 0, dp(14), 0);
        nav.addView(arrow(false));
        mMonthTitle = text(mP.textPrimary, 15, true);
        mMonthTitle.setGravity(Gravity.CENTER);
        mMonthTitle.setContentDescription("usage_range_month");
        nav.addView(mMonthTitle, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        nav.addView(arrow(true));
        mSheet.addView(nav);

        mGrid = new MonthGrid(activity);
        mGrid.setContentDescription("usage_range_calendar");
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(7 * 44 + 4));
        glp.leftMargin = dp(12);
        glp.rightMargin = dp(12);
        mSheet.addView(mGrid, glp);

        LinearLayout buttons = new LinearLayout(activity);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setPadding(dp(16), dp(12), dp(16), 0);
        TextView cancel = UiChrome.makePillButton(activity, t("取消", "Cancel"), false, mP, v -> dismissAnimated(null));
        cancel.setContentDescription("usage_range_cancel");
        TextView apply = UiChrome.makePillButton(activity, t("应用", "Apply"), true, mP, v -> apply());
        apply.setContentDescription("usage_range_apply");
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        buttons.addView(cancel, blp);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        alp.leftMargin = dp(10);
        buttons.addView(apply, alp);
        mSheet.addView(buttons);

        FrameLayout.LayoutParams slp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.gravity = Gravity.BOTTOM;
        root.addView(mSheet, slp);
        applyBottomInsets(root);
        setContentView(root);

        if (w != null && Build.VERSION.SDK_INT >= 30) {
            try {
                WindowInsetsController ctrl = w.getInsetsController();
                if (ctrl != null) {
                    int lightNav = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    ctrl.setSystemBarsAppearance(mP.dark ? 0 : lightNav, lightNav);
                }
            } catch (Throwable ignored) {}
        }
        refresh(null);

        mSheet.setVisibility(View.INVISIBLE);
        mSheet.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
            @Override
            public boolean onPreDraw() {
                mSheet.getViewTreeObserver().removeOnPreDrawListener(this);
                int h = mSheet.getHeight() > 0 ? mSheet.getHeight() : dp(480);
                mSheet.setTranslationY(h);
                mSheet.setVisibility(View.VISIBLE);
                ObjectAnimator slide = ObjectAnimator.ofFloat(mSheet, View.TRANSLATION_Y, h, 0f);
                slide.setDuration(260L);
                slide.setInterpolator(new PathInterpolator(0.2f, 0.9f, 0.2f, 1.0f));
                ObjectAnimator fade = ObjectAnimator.ofFloat(mScrim, View.ALPHA, 0f, 1f);
                fade.setDuration(210L);
                fade.setInterpolator(new DecelerateInterpolator());
                AnimatorSet set = new AnimatorSet();
                set.playTogether(slide, fade);
                set.start();
                return true;
            }
        });
    }

    private TextView text(int color, float sp, boolean bold) {
        TextView tv = new TextView(mActivity);
        tv.setTextColor(color);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (bold) tv.setTypeface(Typeface.DEFAULT_BOLD);
        return tv;
    }

    /** A round month arrow drawn as a chevron. */
    private View arrow(final boolean next) {
        View v = new View(mActivity) {
            private final Paint mPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            private final Path mPath = new Path();

            @Override
            protected void onDraw(Canvas canvas) {
                float cx = getWidth() / 2f, cy = getHeight() / 2f, s = dp(5);
                mPaint.setStyle(Paint.Style.STROKE);
                mPaint.setStrokeWidth(dp(2));
                mPaint.setStrokeCap(Paint.Cap.ROUND);
                mPaint.setStrokeJoin(Paint.Join.ROUND);
                mPaint.setColor(isEnabled() ? mP.textPrimary : mP.textMuted);
                mPath.reset();
                float d = next ? 1 : -1;
                mPath.moveTo(cx - d * s * 0.5f, cy - s);
                mPath.lineTo(cx + d * s * 0.5f, cy);
                mPath.lineTo(cx - d * s * 0.5f, cy + s);
                canvas.drawPath(mPath, mPaint);
            }
        };
        v.setBackground(UiChrome.circle(mP.bgSurface2, 0, 0));
        v.setContentDescription(next ? "usage_range_next_month" : "usage_range_prev_month");
        v.setClickable(true);
        v.setOnClickListener(x -> moveMonth(next ? 1 : -1));
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(36), dp(36)));
        if (next) nextArrow = v; else prevArrow = v;
        return v;
    }

    private View prevArrow, nextArrow;

    private void moveMonth(int delta) {
        int m = mMonth + delta, y = mYear;
        if (m < 1) { m = 12; y--; }
        if (m > 12) { m = 1; y++; }
        String first = UsageReport.date(y, m, 1);
        if (delta > 0 && mToday != null && first.compareTo(mToday) > 0) return;
        mYear = y;
        mMonth = m;
        refresh(null);
    }

    private void refresh(String error) {
        mMonthTitle.setText(UsageReport.monthTitle(mYear, mMonth, mZh));
        if (nextArrow != null) {
            int ny = mMonth == 12 ? mYear + 1 : mYear, nm = mMonth == 12 ? 1 : mMonth + 1;
            nextArrow.setEnabled(mToday == null || UsageReport.date(ny, nm, 1).compareTo(mToday) <= 0);
            nextArrow.setAlpha(nextArrow.isEnabled() ? 1f : 0.4f);
            nextArrow.invalidate();
        }
        if (error != null) {
            mSummary.setTextColor(mP.danger);
            mSummary.setText(error);
        } else {
            mSummary.setTextColor(mP.textSecondary);
            if (mFrom == null) mSummary.setText(t("点选开始日期", "Tap the first day"));
            else if (mTo == null) mSummary.setText(mFrom + t(" 起，点选结束日期", " – tap the last day"));
            else mSummary.setText(UsageReport.span(mFrom, mTo) + t(" · 共 ", " · ") + UsageReport.daysBetween(mFrom, mTo) + t(" 天", " days"));
        }
        mGrid.invalidate();
    }

    private void onDay(String day) {
        if (mToday != null && day.compareTo(mToday) > 0) return;
        String[] picked = UsageReport.pickDay(mFrom, mTo, day);
        mFrom = picked[0];
        mTo = picked[1];
        String error = mTo != null ? UsageReport.validateCustom(mFrom, mTo, mToday, mZh) : null;
        refresh(error);
    }

    private void apply() {
        String to = mTo != null ? mTo : mFrom;
        String error = UsageReport.validateCustom(mFrom, to, mToday, mZh);
        if (error != null) {
            refresh(error);
            return;
        }
        final String from = mFrom;
        dismissAnimated(() -> { if (mListener != null) mListener.onRange(from, to); });
    }

    private void applyBottomInsets(View root) {
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                mSheet.setPadding(bars.left, dp(10), bars.right, mBaseBottomPad + bars.bottom);
                return WindowInsets.CONSUMED;
            });
            root.requestApplyInsets();
        } else {
            int resId = mActivity.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
            int navH = resId > 0 ? mActivity.getResources().getDimensionPixelSize(resId) : 0;
            mSheet.setPadding(0, dp(10), 0, mBaseBottomPad + navH);
        }
    }

    @Override
    public void onBackPressed() { dismissAnimated(null); }

    @Override
    public void cancel() { dismissAnimated(null); }

    private void dismissAnimated(Runnable after) {
        if (mDismissing) return;
        mDismissing = true;
        int h = mSheet.getHeight() > 0 ? mSheet.getHeight() : dp(480);
        ObjectAnimator slide = ObjectAnimator.ofFloat(mSheet, View.TRANSLATION_Y, mSheet.getTranslationY(), h);
        slide.setDuration(180L);
        slide.setInterpolator(new AccelerateInterpolator(1.2f));
        ObjectAnimator fade = ObjectAnimator.ofFloat(mScrim, View.ALPHA, mScrim.getAlpha(), 0f);
        fade.setDuration(180L);
        AnimatorSet set = new AnimatorSet();
        set.playTogether(slide, fade);
        set.addListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(Animator animation) {
                try { if (isShowing()) UsageRangeSheet.super.dismiss(); } catch (Throwable ignored) {}
                if (sActive == UsageRangeSheet.this) sActive = null;
                if (after != null && !mActivity.isFinishing() && !mActivity.isDestroyed()) after.run();
            }
        });
        set.start();
    }

    /** Weekday header + six weeks of the shown month; the picked range as a band with round ends. */
    private final class MonthGrid extends View {
        private final TextPaint mDay = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private final TextPaint mHead = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private final Paint mFill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF mRect = new RectF();

        MonthGrid(Context context) {
            super(context);
            mDay.setTextAlign(Paint.Align.CENTER);
            mDay.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 14, context.getResources().getDisplayMetrics()));
            mHead.setTextAlign(Paint.Align.CENTER);
            mHead.setColor(mP.textMuted);
            mHead.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 12, context.getResources().getDisplayMetrics()));
            setClickable(true);
        }

        private float cellW() { return getWidth() / 7f; }

        private float cellH() { return (getHeight() - dp(4)) / 7f; }

        @Override
        protected void onDraw(Canvas canvas) {
            float cw = cellW(), ch = cellH();
            String[] heads = mZh ? new String[] {"一", "二", "三", "四", "五", "六", "日"} : new String[] {"Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"};
            for (int i = 0; i < 7; i++) canvas.drawText(heads[i], cw * (i + 0.5f), ch * 0.62f, mHead);
            int first = UsageReport.firstWeekday(mYear, mMonth), days = UsageReport.daysInMonth(mYear, mMonth);
            String end = mTo != null ? mTo : mFrom;
            int band = (mP.accent & 0x00FFFFFF) | ((mP.dark ? 0x2E : 0x1A) << 24);
            for (int d = 1; d <= days; d++) {
                int cell = first + d - 1, row = cell / 7 + 1, col = cell % 7;
                String date = UsageReport.date(mYear, mMonth, d);
                float cx = cw * (col + 0.5f), cy = ch * (row + 0.5f), radius = Math.min(cw, ch) * 0.42f;
                boolean inRange = mFrom != null && end != null && date.compareTo(mFrom) >= 0 && date.compareTo(end) <= 0;
                boolean edge = date.equals(mFrom) || date.equals(end);
                boolean future = mToday != null && date.compareTo(mToday) > 0;
                if (inRange && mTo != null && !mFrom.equals(mTo)) {
                    float l = date.equals(mFrom) ? cx : cw * col, r = date.equals(mTo) ? cx : cw * (col + 1);
                    mFill.setColor(band);
                    mRect.set(l, cy - radius, r, cy + radius);
                    canvas.drawRect(mRect, mFill);
                }
                if (edge) {
                    mFill.setColor(mP.accent);
                    canvas.drawCircle(cx, cy, radius, mFill);
                } else if (date.equals(mToday)) {
                    mFill.setColor(mP.border);
                    mFill.setStyle(Paint.Style.STROKE);
                    mFill.setStrokeWidth(dp(1.2f));
                    canvas.drawCircle(cx, cy, radius, mFill);
                    mFill.setStyle(Paint.Style.FILL);
                }
                mDay.setColor(edge ? mP.accentText : future ? mP.textMuted : mP.textPrimary);
                mDay.setAlpha(future ? 0x70 : 0xFF);
                mDay.setTypeface(edge || date.equals(mToday) ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
                canvas.drawText(String.valueOf(d), cx, cy + mDay.getTextSize() * 0.36f, mDay);
            }
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                float cw = cellW(), ch = cellH();
                int col = (int) (event.getX() / cw), row = (int) (event.getY() / ch) - 1;
                if (row >= 0 && col >= 0 && col < 7) {
                    int d = row * 7 + col - UsageReport.firstWeekday(mYear, mMonth) + 1;
                    if (d >= 1 && d <= UsageReport.daysInMonth(mYear, mMonth)) {
                        onDay(UsageReport.date(mYear, mMonth, d));
                        performClick();
                    }
                }
                return true;
            }
            return event.getActionMasked() == MotionEvent.ACTION_DOWN || super.onTouchEvent(event);
        }

        @Override
        public boolean performClick() { return super.performClick(); }
    }
}

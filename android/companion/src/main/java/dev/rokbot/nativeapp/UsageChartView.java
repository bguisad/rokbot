package dev.rokbot.nativeapp;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.text.TextPaint;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewParent;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Stacked column chart of one usage period, drawn with Canvas like the desktop's columnChart()
 * (host/server/public/usage-charts.js): one column per hour (today) or day, a segment per model
 * series from the baseline (other models on top), columns at most 24 dp wide with 4 dp rounded
 * top corners, a 2 dp gap between segments, round y ticks and thinned x labels.
 * Tapping a column (or dragging across the chart) shows a callout beside it with the bucket time,
 * the exact total, the requests and every model's exact tokens; tapping it again hides it.
 */
final class UsageChartView extends View {
    // Layout in dp, as in usage-charts.js.
    private static final float PLOT_TOP = 8f, PLOT_HEIGHT = 168f, AXIS_HEIGHT = 24f, RIGHT = 4f;
    private static final float MAX_BAR = 24f, RADIUS = 4f, GAP = 2f, MIN_VISIBLE = 0.75f;

    private final float mDensity;
    private final boolean mZh;
    private final UiChrome.Palette mPalette;
    private final Paint mFill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint mLine = new Paint();
    private final TextPaint mTick = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final TextPaint mTipText = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final TextPaint mTipBold = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final Path mPath = new Path();
    private final RectF mRect = new RectF();
    private final int mTouchSlop;

    private UsageModel.Period mPeriod;
    private Map<String, Integer> mSeries = Collections.emptyMap();
    private double[] mTicks = {0};
    private int mActive = -1;
    private float mDownX, mDownY;
    private boolean mScrubbing;
    private int mDownColumn = -1;
    private int mActiveAtDown = -1;

    UsageChartView(Context context, UiChrome.Palette palette, boolean zh) {
        super(context);
        mDensity = context.getResources().getDisplayMetrics().density;
        mPalette = palette;
        mZh = zh;
        mTouchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        float sp11 = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 11, context.getResources().getDisplayMetrics());
        float sp12 = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 12, context.getResources().getDisplayMetrics());
        mTick.setTextSize(sp11);
        mTick.setColor(palette.textMuted);
        mTipText.setTextSize(sp12);
        mTipText.setColor(palette.textSecondary);
        mTipBold.setTextSize(sp12);
        mTipBold.setColor(palette.textPrimary);
        mTipBold.setTypeface(Typeface.DEFAULT_BOLD);
        mLine.setStrokeWidth(Math.max(1f, mDensity * 0.75f));
        setClickable(true);
        setContentDescription("usage_chart");
    }

    void setData(UsageModel.Period period, Map<String, Integer> series) {
        mPeriod = period;
        mSeries = series != null ? series : Collections.<String, Integer>emptyMap();
        mTicks = UsageModel.ticks(UsageModel.maxBucket(period));
        mActive = -1;
        String title = period != null && period.hourly() ? (mZh ? "每小时 Token" : "Tokens per hour") : (mZh ? "每日 Token" : "Tokens per day");
        setContentDescription(period == null ? "usage_chart" : title + ", " + UsageModel.rangeLabel(period) + ", "
                + UsageModel.formatExact(period.total) + (mZh ? " Token" : " tokens"));
        requestLayout();
        invalidate();
    }

    private float dp(float v) { return v * mDensity; }

    private int count() { return mPeriod != null && mPeriod.buckets != null ? mPeriod.buckets.size() : 0; }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int w = MeasureSpec.getSize(widthMeasureSpec);
        int h = Math.round(dp(PLOT_TOP + PLOT_HEIGHT + AXIS_HEIGHT));
        setMeasuredDimension(w, h);
    }

    // Geometry: the left edge of the plot after the widest y label, the column pitch and bar width.
    private float plotLeft() {
        float widest = 0;
        for (double t : mTicks) widest = Math.max(widest, mTick.measureText(UsageModel.formatCount(t, mZh)));
        return (float) Math.ceil(widest) + dp(10);
    }

    private float step(float left) {
        float plotWidth = Math.max(dp(40), getWidth() - left - dp(RIGHT));
        return plotWidth / Math.max(1, count());
    }

    private float yFor(double value) {
        double top = mTicks[mTicks.length - 1] > 0 ? mTicks[mTicks.length - 1] : 1;
        return (float) (dp(PLOT_TOP) + dp(PLOT_HEIGHT) - value / top * dp(PLOT_HEIGHT));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        int n = count();
        if (n == 0) return;
        float width = getWidth(), left = plotLeft(), step = step(left);
        float barWidth = Math.max(dp(2), Math.min(dp(MAX_BAR), step * 0.62f));
        float plotBottom = dp(PLOT_TOP + PLOT_HEIGHT);
        boolean hourly = mPeriod.hourly();

        // Grid and y ticks.
        mTick.setTextAlign(Paint.Align.RIGHT);
        for (int i = 0; i < mTicks.length; i++) {
            float y = Math.round(yFor(mTicks[i])) + 0.5f;
            mLine.setColor(withAlpha(mPalette.textPrimary, i == 0 ? 0x1F : 0x12));
            canvas.drawLine(left, y, width - dp(RIGHT), y, mLine);
            canvas.drawText(UsageModel.formatCount(mTicks[i], mZh), left - dp(6), y + dp(4), mTick);
        }

        // Columns.
        int every = UsageModel.labelEvery(hourly, step / mDensity);
        mTick.setTextAlign(Paint.Align.CENTER);
        double top = mTicks[mTicks.length - 1];
        for (int i = 0; i < n; i++) {
            UsageModel.Bucket bucket = mPeriod.buckets.get(i);
            float center = left + step * (i + 0.5f), x = center - barWidth / 2f;
            if (UsageModel.showLabel(hourly, i, n, every)) {
                canvas.drawText(UsageModel.axisLabel(bucket.start, hourly), center, plotBottom + dp(17), mTick);
            }
            if (i == mActive) {
                mFill.setColor(withAlpha(mPalette.textPrimary, mPalette.dark ? 0x14 : 0x0A));
                canvas.drawRect(left + step * i, 0, left + step * (i + 1), plotBottom, mFill);
            }
            List<UsageModel.Segment> segs = UsageModel.segments(UsageModel.stacks(bucket, mSeries), top,
                    dp(PLOT_TOP), dp(PLOT_HEIGHT), dp(GAP), dp(MIN_VISIBLE));
            for (UsageModel.Segment seg : segs) {
                int color = UsageModel.seriesColor(seg.series, mPalette.dark);
                if (mActive >= 0 && i != mActive) color = withAlpha(color, 0x73);
                mFill.setColor(color);
                segmentPath(mPath, x, (float) seg.high, barWidth, (float) (seg.low - seg.high), seg.top ? dp(RADIUS) : 0);
                canvas.drawPath(mPath, mFill);
            }
        }

        if (mActive >= 0 && mActive < n) drawTip(canvas, mPeriod.buckets.get(mActive), left + step * (mActive + 0.5f));
    }

    /** Square at the bottom, the top corners rounded by `radius`. */
    private static void segmentPath(Path path, float x, float top, float width, float height, float radius) {
        float r = Math.max(0, Math.min(radius, Math.min(width / 2f, height)));
        float bottom = top + height;
        path.reset();
        path.moveTo(x, bottom);
        if (r <= 0) {
            path.lineTo(x, top);
            path.lineTo(x + width, top);
        } else {
            path.lineTo(x, top + r);
            path.quadTo(x, top, x + r, top);
            path.lineTo(x + width - r, top);
            path.quadTo(x + width, top, x + width, top + r);
        }
        path.lineTo(x + width, bottom);
        path.close();
    }

    private void drawTip(Canvas canvas, UsageModel.Bucket bucket, float center) {
        boolean hourly = mPeriod.hourly();
        String title = UsageModel.titleLabel(bucket.start, hourly, mZh);
        String total = UsageModel.formatExact(bucket.total);
        String totalLabel = UsageModel.tipTotalLabel(bucket, mZh);
        List<UsageModel.TipRow> rows = UsageModel.tipRows(bucket, mSeries, mZh);

        float padX = dp(10), padY = dp(8), lineH = dp(19), gap = dp(6), key = dp(10);
        float maxWidth = Math.min(dp(280), getWidth());
        float minWidth = Math.min(dp(150), maxWidth);
        // Rows that fit in the view; the rest are summarised in one "+N" line.
        int fit = (int) Math.floor((getHeight() - padY * 2 - lineH * 2 - dp(4)) / lineH);
        int shown = rows.size() <= fit ? rows.size() : Math.max(0, fit - 1);
        int hidden = rows.size() - shown;

        float content = Math.max(mTipText.measureText(title),
                mTipBold.measureText(total) + gap + mTipText.measureText(totalLabel));
        for (int i = 0; i < shown; i++) {
            UsageModel.TipRow r = rows.get(i);
            content = Math.max(content, key + gap + mTipBold.measureText(UsageModel.formatExact(r.total)) + gap + mTipText.measureText(r.name));
        }
        float w = Math.max(minWidth, Math.min(maxWidth, content + padX * 2));
        float h = padY * 2 + lineH * (2 + shown + (hidden > 0 ? 1 : 0)) + dp(4);
        float x = center + dp(12) + w > getWidth() ? center - dp(12) - w : center + dp(12);
        x = Math.max(0, x);
        float y = 0;

        mRect.set(x, y, x + w, y + h);
        mFill.setColor(mPalette.dark ? mPalette.bgSurface2 : mPalette.bgCard);
        canvas.drawRoundRect(mRect, dp(8), dp(8), mFill);
        mLine.setColor(withAlpha(mPalette.textPrimary, mPalette.dark ? 0x29 : 0x24));
        Paint.Style old = mLine.getStyle();
        mLine.setStyle(Paint.Style.STROKE);
        canvas.drawRoundRect(mRect, dp(8), dp(8), mLine);
        mLine.setStyle(old);

        float inner = w - padX * 2;
        float baseline = y + padY + lineH - dp(5);
        mTipText.setColor(mPalette.textSecondary);
        canvas.drawText(ellipsize(title, mTipText, inner), x + padX, baseline, mTipText);

        baseline += lineH;
        canvas.drawText(total, x + padX, baseline, mTipBold);
        float after = x + padX + mTipBold.measureText(total) + gap;
        canvas.drawText(ellipsize(totalLabel, mTipText, x + w - padX - after), after, baseline, mTipText);
        float divider = baseline + dp(6);
        mLine.setColor(withAlpha(mPalette.textPrimary, 0x1F));
        canvas.drawLine(x + padX, divider, x + w - padX, divider, mLine);
        baseline += dp(4);

        for (int i = 0; i < shown; i++) {
            UsageModel.TipRow r = rows.get(i);
            baseline += lineH;
            float cx = x + padX;
            mFill.setColor(UsageModel.seriesColor(r.series, mPalette.dark));
            mRect.set(cx, baseline - dp(5), cx + key, baseline - dp(3));
            canvas.drawRoundRect(mRect, dp(1), dp(1), mFill);
            cx += key + gap;
            String value = UsageModel.formatExact(r.total);
            canvas.drawText(value, cx, baseline, mTipBold);
            cx += mTipBold.measureText(value) + gap;
            canvas.drawText(ellipsize(r.name, mTipText, x + w - padX - cx), cx, baseline, mTipText);
        }
        if (hidden > 0) {
            baseline += lineH;
            String more = mZh ? "还有 " + hidden + " 个模型" : "+" + hidden + " more";
            canvas.drawText(more, x + padX, baseline, mTipText);
        }
    }

    private static String ellipsize(String text, TextPaint paint, float width) {
        if (width <= 0) return "";
        return TextUtils.ellipsize(text, paint, width, TextUtils.TruncateAt.END).toString();
    }

    private static int withAlpha(int color, int alpha) {
        return (color & 0x00FFFFFF) | ((alpha & 0xFF) << 24);
    }

    private int columnAt(float x) {
        int n = count();
        if (n == 0) return -1;
        float left = plotLeft(), step = step(left);
        if (x < left || x > left + step * n) return -1;
        return Math.min(n - 1, Math.max(0, (int) ((x - left) / step)));
    }

    /** Index of the column whose callout is shown, -1 for none. */
    int activeColumn() { return mActive; }

    void setActiveColumn(int index) {
        int next = index >= 0 && index < count() ? index : -1;
        if (next == mActive) return;
        mActive = next;
        // TalkBack reads the shown column with the chart.
        String state = null;
        if (next >= 0) {
            UsageModel.Bucket b = mPeriod.buckets.get(next);
            state = UsageModel.titleLabel(b.start, mPeriod.hourly(), mZh) + ", "
                    + UsageModel.formatExact(b.total) + (mZh ? " Token" : " tokens");
        }
        if (android.os.Build.VERSION.SDK_INT >= 30) setStateDescription(state);
        invalidate();
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (count() == 0) return super.onTouchEvent(event);
        ViewParent parent = getParent();
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                mDownX = event.getX();
                mDownY = event.getY();
                mScrubbing = false;
                mActiveAtDown = mActive;
                mDownColumn = columnAt(event.getX());
                return true;
            case MotionEvent.ACTION_MOVE: {
                float dx = Math.abs(event.getX() - mDownX), dy = Math.abs(event.getY() - mDownY);
                if (!mScrubbing && dx > mTouchSlop && dx > dy) {
                    mScrubbing = true;
                    if (parent != null) parent.requestDisallowInterceptTouchEvent(true);
                }
                if (mScrubbing) {
                    int col = columnAt(event.getX());
                    if (col >= 0) setActiveColumn(col);
                }
                return true;
            }
            case MotionEvent.ACTION_UP:
                if (!mScrubbing) {
                    int col = columnAt(event.getX());
                    // Tap a column: show it; tap the shown column again or beside the plot: hide.
                    setActiveColumn(col < 0 || (col == mActiveAtDown && col == mDownColumn) ? -1 : col);
                    performClick();
                }
                if (parent != null) parent.requestDisallowInterceptTouchEvent(false);
                mScrubbing = false;
                return true;
            case MotionEvent.ACTION_CANCEL:
                if (parent != null) parent.requestDisallowInterceptTouchEvent(false);
                mScrubbing = false;
                return true;
            default:
                return true;
        }
    }

    @Override
    public boolean performClick() {
        return super.performClick();
    }

    // ------------------------------------------------------------------ share bar

    /** A share bar of the model share list: a wash track and a fill in the series colour. */
    static final class ShareBar extends View {
        private final Paint mPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF mBar = new RectF();
        private final int mTrack, mColor;
        private final float mFraction;

        ShareBar(Context context, int track, int color, double fraction) {
            super(context);
            mTrack = track;
            mColor = color;
            mFraction = (float) Math.max(0, Math.min(1, fraction));
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float h = getHeight(), r = h / 2f;
            mPaint.setColor(mTrack);
            mBar.set(0, 0, getWidth(), h);
            canvas.drawRoundRect(mBar, r, r, mPaint);
            mPaint.setColor(mColor);
            mBar.set(0, 0, Math.max(h * 0.5f, getWidth() * mFraction), h);
            canvas.drawRoundRect(mBar, r, r, mPaint);
        }
    }

    /** A small rounded colour square (legend swatch). */
    static final class Swatch extends View {
        private final Paint mPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF mBox = new RectF();
        private final float mRadius;

        Swatch(Context context, int color, float radiusPx) {
            super(context);
            mPaint.setColor(color);
            mRadius = radiusPx;
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            mBox.set(0, 0, getWidth(), getHeight());
            canvas.drawRoundRect(mBox, mRadius, mRadius, mPaint);
        }
    }
}

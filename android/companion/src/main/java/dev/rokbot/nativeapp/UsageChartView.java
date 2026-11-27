package dev.rokbot.nativeapp;

import android.animation.ValueAnimator;
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
import android.view.animation.DecelerateInterpolator;

import java.util.ArrayList;
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
 *
 * With setReport() it draws the trend of a usage report (GET /local/usage/report) in one of three
 * modes: tokens stacked by model (columns), by type (stacked areas: cached input, uncached input,
 * output) or requests (columns, the failed part in the danger colour). The marks grow from the
 * baseline when the data changes.
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

    // Report mode (setReport): the trend of GET /local/usage/report.
    private UsageReport.Report mReport;
    private String mMode = UsageReport.MODE_MODEL;
    private float mProgress = 1f;
    private ValueAnimator mGrow;
    private final Path mArea = new Path();

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
        mReport = null;
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

    /** Report mode: the trend of `report` in `mode` (UsageReport.MODE_MODEL / MODE_TYPE / MODE_REQUESTS). */
    void setReport(UsageReport.Report report, String mode, boolean animate) {
        mReport = report;
        mPeriod = null;
        mMode = mode == null ? UsageReport.MODE_MODEL : mode;
        mTicks = UsageModel.ticks(report == null ? 0 : UsageReport.trendMax(report, mMode));
        mActive = -1;
        if (report != null) {
            String what = UsageReport.MODE_REQUESTS.equals(mMode) ? (mZh ? "请求数趋势" : "Requests trend") : (mZh ? "Token 趋势" : "Token trend");
            setContentDescription("usage_trend_chart, " + what + ", " + UsageReport.span(report.from, report.to));
        }
        if (mGrow != null) mGrow.cancel();
        if (animate) {
            mProgress = 0f;
            mGrow = ValueAnimator.ofFloat(0f, 1f);
            mGrow.setDuration(520L);
            mGrow.setInterpolator(new DecelerateInterpolator(1.6f));
            mGrow.addUpdateListener(a -> { mProgress = (float) a.getAnimatedValue(); invalidate(); });
            mGrow.start();
        } else {
            mProgress = 1f;
        }
        requestLayout();
        invalidate();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (mGrow != null) mGrow.cancel();
        mProgress = 1f;
        super.onDetachedFromWindow();
    }

    private float dp(float v) { return v * mDensity; }

    private int count() {
        if (mReport != null) return mReport.buckets.size();
        return mPeriod != null && mPeriod.buckets != null ? mPeriod.buckets.size() : 0;
    }

    private boolean reportHourly() { return mReport != null && "hour".equals(mReport.unit); }

    private String tickLabel(double t) {
        return UsageModel.formatCount(t, mZh);
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int w = MeasureSpec.getSize(widthMeasureSpec);
        int h = Math.round(dp(PLOT_TOP + PLOT_HEIGHT + AXIS_HEIGHT));
        setMeasuredDimension(w, h);
    }

    // Geometry: the left edge of the plot after the widest y label, the column pitch and bar width.
    private float plotLeft() {
        float widest = 0;
        for (double t : mTicks) widest = Math.max(widest, mTick.measureText(tickLabel(t)));
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
        if (mReport != null) {
            drawReport(canvas, n);
            return;
        }
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

    // ------------------------------------------------------------------ report mode

    private void drawGrid(Canvas canvas, float left, float width) {
        mTick.setTextAlign(Paint.Align.RIGHT);
        for (int i = 0; i < mTicks.length; i++) {
            float y = Math.round(yFor(mTicks[i])) + 0.5f;
            mLine.setColor(withAlpha(mPalette.textPrimary, i == 0 ? 0x1F : 0x12));
            canvas.drawLine(left, y, width - dp(RIGHT), y, mLine);
            canvas.drawText(tickLabel(mTicks[i]), left - dp(6), y + dp(4), mTick);
        }
    }

    /** The colours of the type mode layers (cached, uncached input, output) and of the requests mode. */
    int typeColor(int layer) {
        int series = layer == 0 ? 3 : layer == 1 ? 1 : 2;
        return UsageModel.seriesColor(series, mPalette.dark);
    }

    int requestColor(boolean failed) {
        return failed ? mPalette.danger : UsageModel.seriesColor(1, mPalette.dark);
    }

    private List<UsageModel.Stack> reportStacks(UsageReport.Bucket b) {
        if (UsageReport.MODE_REQUESTS.equals(mMode)) {
            long[] v = UsageReport.requestStack(b);
            List<UsageModel.Stack> out = new ArrayList<>();
            out.add(new UsageModel.Stack(-1, v[0]));
            out.add(new UsageModel.Stack(-2, v[1]));
            return out;
        }
        if (UsageReport.MODE_TYPE.equals(mMode)) {
            long[] v = UsageReport.typeStack(b);
            List<UsageModel.Stack> out = new ArrayList<>();
            for (int i = 0; i < v.length; i++) out.add(new UsageModel.Stack(-10 - i, v[i]));
            return out;
        }
        return UsageReport.modelStacks(mReport, b);
    }

    private int stackColor(int series) {
        if (series == -1) return requestColor(false);
        if (series == -2) return requestColor(true);
        if (series <= -10) return typeColor(-10 - series);
        return UsageModel.seriesColor(series, mPalette.dark);
    }

    private void drawReport(Canvas canvas, int n) {
        float width = getWidth(), left = plotLeft(), step = step(left);
        float barWidth = Math.max(dp(2), Math.min(dp(MAX_BAR), step * 0.62f));
        float plotBottom = dp(PLOT_TOP + PLOT_HEIGHT);
        boolean hourly = reportHourly();
        drawGrid(canvas, left, width);

        int every = UsageModel.labelEvery(hourly, step / mDensity);
        mTick.setTextAlign(Paint.Align.CENTER);
        double top = mTicks[mTicks.length - 1];
        float grownHeight = dp(PLOT_HEIGHT) * mProgress, grownTop = dp(PLOT_TOP) + dp(PLOT_HEIGHT) - grownHeight;
        boolean area = UsageReport.MODE_TYPE.equals(mMode) && n > 1;
        for (int i = 0; i < n; i++) {
            UsageReport.Bucket bucket = mReport.buckets.get(i);
            float center = left + step * (i + 0.5f), x = center - barWidth / 2f;
            if (UsageModel.showLabel(hourly, i, n, every)) {
                String label = UsageReport.axisLabel(bucket.start, mReport.unit, mZh);
                float half = mTick.measureText(label) / 2f;
                // Keep the last label (today) inside the view instead of cutting it off.
                float lx = Math.max(half, Math.min(center, width - half));
                canvas.drawText(label, lx, plotBottom + dp(17), mTick);
            }
            if (i == mActive) {
                mFill.setColor(withAlpha(mPalette.textPrimary, mPalette.dark ? 0x14 : 0x0A));
                canvas.drawRect(left + step * i, 0, left + step * (i + 1), plotBottom, mFill);
            }
            if (area) continue;
            List<UsageModel.Segment> segs = UsageModel.segments(reportStacks(bucket), top, grownTop, grownHeight, dp(GAP), dp(MIN_VISIBLE));
            for (UsageModel.Segment seg : segs) {
                int color = stackColor(seg.series);
                if (mActive >= 0 && i != mActive) color = withAlpha(color, 0x73);
                mFill.setColor(color);
                segmentPath(mPath, x, (float) seg.high, barWidth, (float) (seg.low - seg.high), seg.top ? dp(RADIUS) : 0);
                canvas.drawPath(mPath, mFill);
            }
        }
        if (area) drawAreas(canvas, n, left, step, top, grownTop, grownHeight);
        if (mActive >= 0 && mActive < n) drawReportTip(canvas, mReport.buckets.get(mActive), left + step * (mActive + 0.5f));
    }

    /** Stacked areas through the column centres, from the baseline: cached, uncached input, output. */
    private void drawAreas(Canvas canvas, int n, float left, float step, double top, float plotTop, float plotHeight) {
        double scale = top > 0 ? top : 1;
        double[][] cum = new double[3][n];
        for (int i = 0; i < n; i++) {
            long[] v = UsageReport.typeStack(mReport.buckets.get(i));
            double sum = 0;
            for (int k = 0; k < 3; k++) { sum += v[k]; cum[k][i] = sum; }
        }
        Paint.Style oldStyle = mLine.getStyle();
        float oldWidth = mLine.getStrokeWidth();
        for (int k = 2; k >= 0; k--) {
            mArea.reset();
            for (int i = 0; i < n; i++) {
                float x = left + step * (i + 0.5f);
                float y = (float) (plotTop + plotHeight - cum[k][i] / scale * plotHeight);
                if (i == 0) mArea.moveTo(x, y); else mArea.lineTo(x, y);
            }
            Path line = new Path(mArea);
            for (int i = n - 1; i >= 0; i--) {
                float x = left + step * (i + 0.5f);
                double low = k == 0 ? 0 : cum[k - 1][i];
                mArea.lineTo(x, (float) (plotTop + plotHeight - low / scale * plotHeight));
            }
            mArea.close();
            int color = typeColor(k);
            mFill.setColor(withAlpha(color, mPalette.dark ? 0x8C : 0x73));
            canvas.drawPath(mArea, mFill);
            mLine.setStyle(Paint.Style.STROKE);
            mLine.setStrokeWidth(dp(1.6f));
            mLine.setColor(color);
            mLine.setAntiAlias(true);
            canvas.drawPath(line, mLine);
        }
        mLine.setStyle(oldStyle);
        mLine.setStrokeWidth(oldWidth);
        mLine.setAntiAlias(false);
        if (mActive >= 0 && mActive < n) {
            float x = left + step * (mActive + 0.5f);
            for (int k = 0; k < 3; k++) {
                float y = (float) (plotTop + plotHeight - cum[k][mActive] / scale * plotHeight);
                mFill.setColor(mPalette.bgCard);
                canvas.drawCircle(x, y, dp(4.5f), mFill);
                mFill.setColor(typeColor(k));
                canvas.drawCircle(x, y, dp(3f), mFill);
            }
        }
    }

    /** A callout line: a colour key, a bold exact value and a name. */
    static final class TipLine {
        final int color;
        final String value, name;
        TipLine(int color, String value, String name) { this.color = color; this.value = value; this.name = name; }
    }

    private void drawReportTip(Canvas canvas, UsageReport.Bucket b, float center) {
        String title = UsageReport.titleLabel(b.start, mReport.unit, mZh);
        List<TipLine> lines = new ArrayList<>();
        String head, headLabel;
        if (UsageReport.MODE_REQUESTS.equals(mMode)) {
            head = UsageModel.formatExact(b.requests);
            headLabel = mZh ? "次请求" : (b.requests == 1 ? "request" : "requests");
            long[] v = UsageReport.requestStack(b);
            lines.add(new TipLine(requestColor(false), UsageModel.formatExact(v[0]), mZh ? "成功或未记录状态" : "Succeeded or not recorded"));
            lines.add(new TipLine(requestColor(true), UsageModel.formatExact(v[1]), mZh ? "失败" : "Failed"));
            lines.add(new TipLine(0, UsageReport.formatDuration(b.avgDurationMs, mZh), mZh ? "平均耗时" : "Average duration"));
        } else if (UsageReport.MODE_TYPE.equals(mMode)) {
            head = UsageModel.formatExact(b.total);
            headLabel = UsageModel.tipTotalLabel(asLegacy(b), mZh);
            long[] v = UsageReport.typeStack(b);
            String[] names = mZh ? new String[] {"缓存命中", "未命中输入", "输出"} : new String[] {"Cache read", "Uncached input", "Output"};
            for (int k = 2; k >= 0; k--) lines.add(new TipLine(typeColor(k), UsageModel.formatExact(v[k]), names[k]));
        } else {
            head = UsageModel.formatExact(b.total);
            headLabel = UsageModel.tipTotalLabel(asLegacy(b), mZh);
            for (UsageReport.ModelTotal m : b.models) {
                if (m.total <= 0) continue;
                String name = UsageReport.NONE.equals(m.model) ? UsageReport.missing(mZh) : m.model;
                lines.add(new TipLine(UsageModel.seriesColor(UsageReport.seriesOf(mReport, m.model), mPalette.dark), UsageModel.formatExact(m.total), name));
            }
        }
        drawCallout(canvas, center, title, head, headLabel, lines);
    }

    private static UsageModel.Bucket asLegacy(UsageReport.Bucket b) {
        UsageModel.Bucket out = new UsageModel.Bucket();
        out.requests = b.requests;
        out.total = b.total;
        return out;
    }

    /** The callout box beside `center`: title, a bold head value with its label, a divider and the lines. */
    private void drawCallout(Canvas canvas, float center, String title, String head, String headLabel, List<TipLine> rows) {
        float padX = dp(10), padY = dp(8), lineH = dp(19), gap = dp(6), key = dp(10);
        float maxWidth = Math.min(dp(280), getWidth());
        float minWidth = Math.min(dp(150), maxWidth);
        int fit = (int) Math.floor((getHeight() - padY * 2 - lineH * 2 - dp(4)) / lineH);
        int shown = rows.size() <= fit ? rows.size() : Math.max(0, fit - 1);
        int hidden = rows.size() - shown;

        float content = Math.max(mTipText.measureText(title), mTipBold.measureText(head) + gap + mTipText.measureText(headLabel));
        for (int i = 0; i < shown; i++) {
            TipLine r = rows.get(i);
            content = Math.max(content, (r.color != 0 ? key + gap : 0) + mTipBold.measureText(r.value) + gap + mTipText.measureText(r.name));
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
        canvas.drawText(head, x + padX, baseline, mTipBold);
        float after = x + padX + mTipBold.measureText(head) + gap;
        canvas.drawText(ellipsize(headLabel, mTipText, x + w - padX - after), after, baseline, mTipText);
        float divider = baseline + dp(6);
        mLine.setColor(withAlpha(mPalette.textPrimary, 0x1F));
        canvas.drawLine(x + padX, divider, x + w - padX, divider, mLine);
        baseline += dp(4);
        for (int i = 0; i < shown; i++) {
            TipLine r = rows.get(i);
            baseline += lineH;
            float cx = x + padX;
            if (r.color != 0) {
                mFill.setColor(r.color);
                mRect.set(cx, baseline - dp(5), cx + key, baseline - dp(3));
                canvas.drawRoundRect(mRect, dp(1), dp(1), mFill);
                cx += key + gap;
            }
            canvas.drawText(r.value, cx, baseline, mTipBold);
            cx += mTipBold.measureText(r.value) + gap;
            canvas.drawText(ellipsize(r.name, mTipText, x + w - padX - cx), cx, baseline, mTipText);
        }
        if (hidden > 0) {
            baseline += lineH;
            canvas.drawText(mZh ? "还有 " + hidden + " 项" : "+" + hidden + " more", x + padX, baseline, mTipText);
        }
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
        List<TipLine> lines = new ArrayList<>();
        for (UsageModel.TipRow r : UsageModel.tipRows(bucket, mSeries, mZh)) {
            lines.add(new TipLine(UsageModel.seriesColor(r.series, mPalette.dark), UsageModel.formatExact(r.total), r.name));
        }
        drawCallout(canvas, center, UsageModel.titleLabel(bucket.start, hourly, mZh), UsageModel.formatExact(bucket.total),
                UsageModel.tipTotalLabel(bucket, mZh), lines);
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
        if (next >= 0 && mReport != null) {
            UsageReport.Bucket b = mReport.buckets.get(next);
            state = UsageReport.titleLabel(b.start, mReport.unit, mZh) + ", " + (UsageReport.MODE_REQUESTS.equals(mMode)
                    ? UsageModel.formatExact(b.requests) + (mZh ? " 次请求" : " requests")
                    : UsageModel.formatExact(b.total) + (mZh ? " Token" : " tokens"));
        } else if (next >= 0) {
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

    // ------------------------------------------------------------------ donut

    /** Ring of shares (the breakdown): one arc per value with a small gap, the total in the middle; sweeps in. */
    static final class Donut extends View {
        private final Paint mPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final TextPaint mBig = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private final TextPaint mSmall = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private final RectF mOval = new RectF();
        private final int mTrack;
        private long[] mValues = new long[0];
        private int[] mColors = new int[0];
        private String mCenter = "", mCaption = "";
        private float mProgress = 1f;
        private ValueAnimator mAnim;

        Donut(Context context, UiChrome.Palette p) {
            super(context);
            float d = context.getResources().getDisplayMetrics().density;
            mTrack = withAlpha(p.textPrimary, p.dark ? 0x1A : 0x0D);
            mPaint.setStyle(Paint.Style.STROKE);
            mPaint.setStrokeCap(Paint.Cap.BUTT);
            mBig.setColor(p.textPrimary);
            mBig.setTypeface(Typeface.DEFAULT_BOLD);
            mBig.setTextAlign(Paint.Align.CENTER);
            mBig.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 16, context.getResources().getDisplayMetrics()));
            mSmall.setColor(p.textMuted);
            mSmall.setTextAlign(Paint.Align.CENTER);
            mSmall.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 11, context.getResources().getDisplayMetrics()));
            setMinimumHeight(Math.round(d * 120));
        }

        void setData(long[] values, int[] colors, String center, String caption, boolean animate) {
            mValues = values;
            mColors = colors;
            mCenter = center == null ? "" : center;
            mCaption = caption == null ? "" : caption;
            setContentDescription(mCaption + " " + mCenter);
            if (mAnim != null) mAnim.cancel();
            if (animate) {
                mProgress = 0f;
                mAnim = ValueAnimator.ofFloat(0f, 1f);
                mAnim.setDuration(600L);
                mAnim.setInterpolator(new DecelerateInterpolator(1.4f));
                mAnim.addUpdateListener(a -> { mProgress = (float) a.getAnimatedValue(); invalidate(); });
                mAnim.start();
            }
            invalidate();
        }

        @Override
        protected void onDetachedFromWindow() {
            if (mAnim != null) mAnim.cancel();
            mProgress = 1f;
            super.onDetachedFromWindow();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float size = Math.min(getWidth(), getHeight());
            float stroke = size * 0.15f;
            float inset = stroke / 2f + 1;
            mOval.set(inset, inset, size - inset, size - inset);
            mPaint.setStrokeWidth(stroke);
            mPaint.setColor(mTrack);
            canvas.drawArc(mOval, 0, 360, false, mPaint);
            long sum = 0;
            for (long v : mValues) sum += Math.max(0, v);
            if (sum > 0) {
                float gapDeg = mValues.length > 1 ? 1.6f : 0f;
                float start = -90f, total = 360f * mProgress;
                for (int i = 0; i < mValues.length; i++) {
                    float sweep = (float) (Math.max(0, mValues[i]) / (double) sum * total);
                    float drawn = sweep - gapDeg;
                    if (drawn > 0.3f) {
                        mPaint.setColor(mColors[i]);
                        canvas.drawArc(mOval, start, drawn, false, mPaint);
                    }
                    start += sweep;
                }
            }
            float cx = size / 2f, cy = size / 2f;
            float inner = size - stroke * 2 - size * 0.08f;
            String big = TextUtils.ellipsize(mCenter, mBig, inner, TextUtils.TruncateAt.END).toString();
            canvas.drawText(big, cx, cy + mBig.getTextSize() * 0.2f, mBig);
            String small = TextUtils.ellipsize(mCaption, mSmall, inner, TextUtils.TruncateAt.END).toString();
            canvas.drawText(small, cx, cy + mBig.getTextSize() * 0.2f + mSmall.getTextSize() * 1.35f, mSmall);
        }
    }

    // ------------------------------------------------------------------ stacked bar

    /** A horizontal stacked bar (the token composition): rounded ends, a 2 dp gap between parts. */
    static final class StackBar extends View {
        private final Paint mPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF mBar = new RectF();
        private final Path mClip = new Path();
        private final int mTrack;
        private final long[] mValues;
        private final int[] mColors;

        StackBar(Context context, int track, long[] values, int[] colors) {
            super(context);
            mTrack = track;
            mValues = values;
            mColors = colors;
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight(), r = h / 2f;
            mBar.set(0, 0, w, h);
            mPaint.setColor(mTrack);
            canvas.drawRoundRect(mBar, r, r, mPaint);
            long sum = 0;
            for (long v : mValues) sum += Math.max(0, v);
            if (sum <= 0) return;
            mClip.reset();
            mClip.addRoundRect(mBar, r, r, Path.Direction.CW);
            canvas.save();
            canvas.clipPath(mClip);
            float gap = getResources().getDisplayMetrics().density * 2, x = 0;
            int parts = 0;
            for (long v : mValues) if (v > 0) parts++;
            float usable = w - gap * Math.max(0, parts - 1);
            for (int i = 0; i < mValues.length; i++) {
                if (mValues[i] <= 0) continue;
                float part = (float) (mValues[i] / (double) sum * usable);
                mPaint.setColor(mColors[i]);
                canvas.drawRect(x, 0, x + Math.max(1, part), h, mPaint);
                x += part + gap;
            }
            canvas.restore();
        }
    }

    // ------------------------------------------------------------------ skeleton

    /** A grey rounded placeholder block that softly pulses while the report loads. */
    static final class Skeleton extends View {
        private final Paint mPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF mBox = new RectF();
        private final float mRadius;
        private ValueAnimator mPulse;

        Skeleton(Context context, UiChrome.Palette p, float radiusPx) {
            super(context);
            mPaint.setColor(withAlpha(p.textPrimary, p.dark ? 0x1F : 0x12));
            mRadius = radiusPx;
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        @Override
        protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            mPulse = ValueAnimator.ofFloat(1f, 0.45f);
            mPulse.setDuration(780L);
            mPulse.setRepeatMode(ValueAnimator.REVERSE);
            mPulse.setRepeatCount(ValueAnimator.INFINITE);
            mPulse.addUpdateListener(a -> setAlpha((float) a.getAnimatedValue()));
            mPulse.start();
        }

        @Override
        protected void onDetachedFromWindow() {
            if (mPulse != null) mPulse.cancel();
            super.onDetachedFromWindow();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            mBox.set(0, 0, getWidth(), getHeight());
            canvas.drawRoundRect(mBox, mRadius, mRadius, mPaint);
        }
    }
}

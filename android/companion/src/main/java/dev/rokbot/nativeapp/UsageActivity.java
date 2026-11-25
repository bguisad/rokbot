package dev.rokbot.nativeapp;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TableLayout;
import android.widget.TableRow;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Usage page: the paired Host's token usage (GET /local/usage) for today, the last 7 and the last
 * 30 days, like Settings > General > Usage on the desktop / web (host/server/public/usage-charts.js):
 * summary cards, tokens per hour (today) or per day stacked by model (UsageChartView, Canvas), the
 * share per model and a detail table. Model colours follow the 30-day ranking, so switching the
 * period never recolours a model. Counts are short (万 / 亿, K / M / B); a long press on any of
 * them flips it to the exact number. Pure logic lives in UsageModel.
 */
public class UsageActivity extends Activity {
    private static final String STATE_PERIOD = "usage_period";
    private static final String[][] PERIODS = {
        {"today", "今天", "Today"},
        {"7d", "7 天", "7 days"},
        {"30d", "30 天", "30 days"},
    };

    private final Handler mMain = new Handler(Looper.getMainLooper());
    private UiChrome.Palette mP;
    private boolean mZh;
    private LinearLayout mTabs;
    private TextView mRange;
    private LinearLayout mContent;

    private UsageModel.Usage mUsage;
    private Map<String, Integer> mSeries;
    private String mPeriodId = "today";
    private boolean mLoading;
    private String mError;
    private int mGeneration;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        mP = UiChrome.palette(this);
        mZh = Localize.isChinese(this);
        if (savedInstanceState != null) mPeriodId = savedInstanceState.getString(STATE_PERIOD, "today");
        buildUi();
        reload();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString(STATE_PERIOD, mPeriodId);
    }

    @Override
    protected void onDestroy() {
        mGeneration++;
        super.onDestroy();
    }

    private String t(String zh, String en) { return mZh ? zh : en; }

    private int dp(float v) { return UiChrome.dp(this, v); }

    // ------------------------------------------------------------------ layout

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(mP.bgPaper);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(12), dp(18), dp(24));
        scroll.addView(root);

        View refreshIcon = UiChrome.makeVectorIconButton(this, "refresh", "refresh_usage_button", mP, v -> reload());
        root.addView(UiChrome.makeHeaderBar(this, t("用量", "Usage"), mP, v -> finish(), refreshIcon));

        mTabs = new LinearLayout(this);
        mTabs.setOrientation(LinearLayout.HORIZONTAL);
        mTabs.setPadding(dp(3), dp(3), dp(3), dp(3));
        mTabs.setBackground(UiChrome.roundRect(mP.bgSurface2, dp(999), 0, 0));
        mTabs.setContentDescription("usage_period_switch");
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.topMargin = dp(6);
        mTabs.setLayoutParams(tlp);
        root.addView(mTabs);

        mRange = text(mP.textMuted, 12, false);
        mRange.setPadding(dp(4), dp(8), dp(4), 0);
        root.addView(mRange);

        mContent = new LinearLayout(this);
        mContent.setOrientation(LinearLayout.VERTICAL);
        root.addView(mContent, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
        render();
    }

    /** Segmented control: 今天 / 7 天 / 30 天; only the periods the Host answers (older Hosts: today). */
    private void renderTabs() {
        mTabs.removeAllViews();
        List<String[]> shown = new ArrayList<>();
        for (String[] period : PERIODS) if (mUsage == null || mUsage.has(period[0])) shown.add(period);
        mTabs.setVisibility(shown.size() > 1 ? View.VISIBLE : View.GONE);
        for (String[] period : shown) {
            final String id = period[0];
            boolean selected = id.equals(mPeriodId);
            TextView tab = new TextView(this);
            tab.setText(t(period[1], period[2]));
            tab.setGravity(Gravity.CENTER);
            tab.setSingleLine(true);
            tab.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            tab.setTextColor(selected ? mP.textPrimary : mP.textSecondary);
            tab.setTypeface(selected ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            tab.setPadding(dp(8), dp(7), dp(8), dp(7));
            tab.setBackground(selected ? UiChrome.roundRect(mP.dark ? 0xFF45454D : mP.bgCard, dp(999), 0, 0) : null);
            tab.setContentDescription("usage_period_" + id);
            tab.setSelected(selected);
            tab.setOnClickListener(v -> selectPeriod(id));
            mTabs.addView(tab, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        }
    }

    private void selectPeriod(String id) {
        if (id.equals(mPeriodId)) return;
        mPeriodId = id;
        render();
    }

    private void render() {
        if (mContent == null) return;
        renderTabs();
        mContent.removeAllViews();
        if (mUsage == null) {
            mRange.setVisibility(View.GONE);
            if (mError != null && !mLoading) {
                LinearLayout card = block(null);
                TextView msg = text(mP.textPrimary, 15, true);
                msg.setText(t("无法读取用量", "Could not load usage"));
                card.addView(msg);
                TextView detail = text(mP.textSecondary, 13, false);
                detail.setText(mError);
                detail.setPadding(0, dp(6), 0, dp(12));
                card.addView(detail);
                card.addView(UiChrome.makePillButton(this, t("重试", "Retry"), true, mP, v -> reload()));
                mContent.addView(card);
            } else {
                mContent.addView(stateCard(t("正在读取…", "Loading…")));
            }
            return;
        }

        UsageModel.Period period = mUsage.period(mPeriodId);
        if (period == null) {
            mContent.addView(stateCard(t("这段时间还没有模型请求", "No model requests in this period")));
            return;
        }
        mPeriodId = period.id;
        String range = UsageModel.rangeLabel(period);
        if (mUsage.timeZone != null && !mUsage.timeZone.isEmpty()) range = range.isEmpty() ? mUsage.timeZone : range + " · " + mUsage.timeZone;
        mRange.setText(range);
        mRange.setVisibility(range.isEmpty() ? View.GONE : View.VISIBLE);

        mContent.addView(cards(period));
        if (UsageModel.isEmpty(period)) {
            mContent.addView(stateCard(t("这段时间还没有模型请求", "No model requests in this period")));
            return;
        }
        if (period.buckets != null && !period.buckets.isEmpty()) {
            LinearLayout chartBlock = block(period.hourly() ? t("每小时 Token", "Tokens per hour") : t("每日 Token", "Tokens per day"));
            UsageChartView chart = new UsageChartView(this, mP, mZh);
            chart.setData(period, mSeries);
            chartBlock.addView(chart, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            TextView hint = text(mP.textMuted, 11, false);
            hint.setText(t("点按柱子查看明细，长按数字查看精确值", "Tap a column for details; long-press a number for the exact value"));
            hint.setPadding(0, dp(6), 0, 0);
            chartBlock.addView(hint);
            mContent.addView(chartBlock);
        } else {
            TextView note = text(mP.textMuted, 12, false);
            note.setText(mUsage.legacy
                    ? t("升级 Host 后可查看 7 天、30 天用量和图表", "Update the Host to see 7 and 30 days and the charts")
                    : t("升级 Host 后可查看图表", "Update the Host to see the chart"));
            note.setPadding(dp(4), dp(12), dp(4), 0);
            mContent.addView(note);
        }
        if (!period.models.isEmpty()) {
            mContent.addView(shareBlock(period));
            mContent.addView(tableBlock(period));
        }
    }

    // ------------------------------------------------------------------ pieces

    private TextView text(int color, float sp, boolean bold) {
        TextView tv = new TextView(this);
        tv.setTextColor(color);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (bold) tv.setTypeface(Typeface.DEFAULT_BOLD);
        return tv;
    }

    private LinearLayout surface() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(UiChrome.roundRect(mP.bgCard, dp(14), mP.border, Math.max(1, dp(0.5f))));
        return card;
    }

    /** A block with a small title (usage-charts.css .rok-usage-block). */
    private LinearLayout block(String title) {
        LinearLayout card = surface();
        card.setPadding(dp(14), dp(12), dp(14), dp(14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(12);
        card.setLayoutParams(lp);
        if (title != null) {
            TextView head = text(mP.textSecondary, 12, true);
            head.setText(title);
            head.setPadding(0, 0, 0, dp(10));
            card.addView(head);
        }
        return card;
    }

    private View stateCard(String message) {
        LinearLayout card = block(null);
        card.setPadding(dp(16), dp(24), dp(16), dp(24));
        TextView tv = text(mP.textMuted, 13, false);
        tv.setGravity(Gravity.CENTER);
        tv.setText(message);
        card.addView(tv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return card;
    }

    /**
     * A count shown short ("4.14 万", "41.4K"); a long press flips it to the exact grouped number
     * and back, as RokUsageCount does on desktop touch screens. TalkBack reads the exact number.
     */
    private TextView count(long value, boolean known, int color, float sp, boolean bold) {
        TextView tv = text(color, sp, bold);
        tv.setSingleLine(true);
        if (!known) {
            tv.setText("—");
            return tv;
        }
        bindExact(tv, UsageModel.formatCount(value, mZh), UsageModel.formatExact(value), sp);
        return tv;
    }

    private void bindExact(final TextView tv, final String shortText, final String exactText, final float sp) {
        tv.setText(shortText);
        tv.setContentDescription(exactText);
        if (shortText.equals(exactText)) return;
        tv.setOnLongClickListener(v -> {
            boolean exact = !Boolean.TRUE.equals(v.getTag());
            v.setTag(exact);
            tv.setText(exact ? exactText : shortText);
            // Long exact values in a card shrink instead of being cut off.
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, exact && sp > 16 && exactText.length() > 10 ? 15 : sp);
            v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            return true;
        });
    }

    private LinearLayout card(String label, View value, View extra) {
        LinearLayout card = surface();
        card.setPadding(dp(14), dp(12), dp(14), dp(12));
        TextView head = text(mP.textSecondary, 12, false);
        head.setSingleLine(true);
        head.setEllipsize(TextUtils.TruncateAt.END);
        head.setText(label);
        card.addView(head);
        LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        vlp.topMargin = dp(4);
        card.addView(value, vlp);
        if (extra != null) card.addView(extra);
        return card;
    }

    /** 总 Token (full width), 请求数, 输入, 输出, 缓存命中率 (cached / input). */
    private View cards(UsageModel.Period p) {
        TextView totalValue = count(p.total, true, mP.textPrimary, 22, true);
        TextView exactLine = null;
        String exactTotal = UsageModel.formatExact(p.total);
        if (!exactTotal.equals(UsageModel.formatCount(p.total, mZh))) {
            exactLine = text(mP.textMuted, 12, false);
            exactLine.setText(exactTotal + t(" Token", " tokens"));
        }
        View total = card(t("总 Token", "Total tokens"), totalValue, exactLine);
        View requests = card(t("请求数", "Requests"), count(p.requests, p.hasRequests, mP.textPrimary, 22, true), null);
        View input = card(t("输入", "Input"), count(p.input, true, mP.textPrimary, 22, true), null);
        View output = card(t("输出", "Output"), count(p.output, true, mP.textPrimary, 22, true), null);

        TextView rateValue = text(mP.textPrimary, 22, true);
        String rate = UsageModel.cacheHitRate(p);
        if (p.hasCached && p.input > 0) {
            bindExact(rateValue, rate, UsageModel.formatExact(p.cached) + " / " + UsageModel.formatExact(p.input), 22);
            rateValue.setContentDescription(t("缓存命中 ", "Cache read ") + UsageModel.formatExact(p.cached)
                    + " / " + t("输入 ", "Input ") + UsageModel.formatExact(p.input));
        } else {
            rateValue.setText(rate);
        }
        View hitRate = card(t("缓存命中率", "Cache hit rate"), rateValue, null);

        LinearLayout grid = new LinearLayout(this);
        grid.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        glp.topMargin = dp(12);
        grid.setLayoutParams(glp);
        if (getResources().getConfiguration().screenWidthDp >= 600) {
            grid.addView(row(total, requests, input, output, hitRate));
        } else {
            grid.addView(row(total));
            grid.addView(row(requests, input));
            grid.addView(row(output, hitRate));
        }
        return grid;
    }

    private LinearLayout row(View... cells) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.bottomMargin = dp(8);
        row.setLayoutParams(rlp);
        for (int i = 0; i < cells.length; i++) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f);
            if (i > 0) lp.leftMargin = dp(8);
            row.addView(cells[i], lp);
        }
        return row;
    }

    private int wash() {
        int c = mP.textPrimary;
        return (c & 0x00FFFFFF) | ((mP.dark ? 0x1A : 0x0D) << 24);
    }

    private int line(int alpha) {
        return (mP.textPrimary & 0x00FFFFFF) | (alpha << 24);
    }

    private View swatch(int series, int sizeDp, float radiusDp) {
        View sw = new UsageChartView.Swatch(this, UsageModel.seriesColor(series, mP.dark), dp(radiusDp));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp));
        lp.rightMargin = dp(8);
        lp.gravity = Gravity.CENTER_VERTICAL;
        sw.setLayoutParams(lp);
        return sw;
    }

    /** 模型占比: swatch + name, share and short total, and a bar (the legend of the columns). */
    private View shareBlock(UsageModel.Period p) {
        LinearLayout block = block(t("模型占比", "Share by model"));
        List<UsageModel.SharePart> parts = UsageModel.shares(p, mSeries, mZh);
        long largest = 1;
        for (UsageModel.SharePart part : parts) largest = Math.max(largest, part.total);
        for (int i = 0; i < parts.size(); i++) {
            UsageModel.SharePart part = parts.get(i);
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            if (i > 0) ilp.topMargin = dp(10);
            item.setLayoutParams(ilp);

            LinearLayout head = new LinearLayout(this);
            head.setOrientation(LinearLayout.HORIZONTAL);
            head.setGravity(Gravity.CENTER_VERTICAL);
            head.addView(swatch(part.series, 10, 3));
            TextView name = text(mP.textPrimary, 12, false);
            name.setTypeface(Typeface.MONOSPACE);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            name.setText(part.label());
            head.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            TextView share = text(mP.textPrimary, 13, true);
            share.setText(UsageModel.formatShare(part.total, p.total));
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            slp.leftMargin = dp(10);
            head.addView(share, slp);
            TextView value = count(part.total, true, mP.textSecondary, 13, false);
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            clp.leftMargin = dp(6);
            head.addView(value, clp);
            item.addView(head);

            View bar = new UsageChartView.ShareBar(this, wash(), UsageModel.seriesColor(part.series, mP.dark),
                    UsageModel.shareBarFraction(part.total, largest));
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(8));
            blp.topMargin = dp(5);
            item.addView(bar, blp);
            block.addView(item);
        }
        return block;
    }

    /** 明细: 模型 | 总 Token | 输入 | 输出 | 缓存命中 | (缓存写入) | 请求数, plus 合计; scrolls sideways. */
    private View tableBlock(UsageModel.Period p) {
        LinearLayout block = block(t("明细", "Details"));
        boolean write = p.cacheWrite > 0;
        TableLayout table = new TableLayout(this);
        table.setColumnStretchable(0, true);

        List<String> heads = new ArrayList<>();
        heads.add(t("模型", "Model"));
        heads.add(t("总 Token", "Total tokens"));
        heads.add(t("输入", "Input"));
        heads.add(t("输出", "Output"));
        heads.add(t("缓存命中", "Cache read"));
        if (write) heads.add(t("缓存写入", "Cache write"));
        heads.add(t("请求数", "Requests"));
        TableRow headRow = new TableRow(this);
        for (int i = 0; i < heads.size(); i++) {
            TextView h = text(mP.textMuted, 12, false);
            h.setText(heads.get(i));
            h.setSingleLine(true);
            h.setGravity(i == 0 ? Gravity.START : Gravity.END);
            h.setPadding(i == 0 ? 0 : dp(16), 0, 0, dp(8));
            headRow.addView(h);
        }
        table.addView(headRow);
        table.addView(divider(line(0x14)));

        for (int i = 0; i < p.models.size(); i++) {
            UsageModel.ModelRow m = p.models.get(i);
            TableRow row = new TableRow(this);
            LinearLayout name = new LinearLayout(this);
            name.setOrientation(LinearLayout.HORIZONTAL);
            name.setGravity(Gravity.CENTER_VERTICAL);
            name.setPadding(0, dp(8), 0, dp(8));
            name.addView(swatch(UsageModel.seriesOf(mSeries, m.model), 10, 3));
            TextView label = text(mP.textPrimary, 12, false);
            label.setTypeface(Typeface.MONOSPACE);
            label.setSingleLine(true);
            label.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            label.setMaxWidth(dp(150));
            label.setText(UsageModel.modelName(m.model, mZh));
            name.addView(label);
            row.addView(name);
            cells(row, m, write, false);
            table.addView(row);
            if (i < p.models.size() - 1) table.addView(divider(line(0x14)));
        }
        if (p.models.size() > 1) {
            table.addView(divider(line(0x24)));
            TableRow sum = new TableRow(this);
            TextView label = text(mP.textPrimary, 13, true);
            label.setText(t("合计", "Total"));
            label.setPadding(0, dp(8), 0, dp(8));
            sum.addView(label);
            cells(sum, p, write, true);
            table.addView(sum);
        }

        HorizontalScrollView scroller = new HorizontalScrollView(this);
        scroller.setFillViewport(true);
        scroller.setHorizontalScrollBarEnabled(false);
        scroller.addView(table, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        block.addView(scroller, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return block;
    }

    private void cells(TableRow row, UsageModel.Counts c, boolean write, boolean bold) {
        List<long[]> values = new ArrayList<>();
        values.add(new long[] {c.total, 1});
        values.add(new long[] {c.input, 1});
        values.add(new long[] {c.output, 1});
        values.add(new long[] {c.cached, c.hasCached ? 1 : 0});
        if (write) values.add(new long[] {c.cacheWrite, 1});
        values.add(new long[] {c.requests, c.hasRequests ? 1 : 0});
        for (long[] v : values) {
            TextView cell = count(v[0], v[1] == 1, mP.textPrimary, 13, bold);
            cell.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            cell.setPadding(dp(16), dp(8), 0, dp(8));
            row.addView(cell, new TableRow.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
    }

    private View divider(int color) {
        View v = new View(this);
        v.setBackgroundColor(color);
        v.setLayoutParams(new TableLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(0.5f))));
        return v;
    }

    // ------------------------------------------------------------------ data

    /** Every period at once (as the desktop does): the 30-day ranking fixes the colours and switching is instant. */
    private void reload() {
        final int generation = ++mGeneration;
        mLoading = true;
        if (mUsage == null) {
            mError = null;
            render();
        }
        new Thread(() -> {
            UsageModel.Usage usage = null;
            String error = null;
            try {
                JSONObject json = HostApiClient.getUsage(this, null);
                usage = UsageModel.parse(json);
            } catch (Throwable t) {
                error = t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
            }
            final UsageModel.Usage result = usage;
            final String failure = error;
            mMain.post(() -> {
                if (generation != mGeneration || isFinishing() || isDestroyed()) return;
                mLoading = false;
                if (result != null) {
                    mUsage = result;
                    mSeries = UsageModel.series(result);
                    mError = null;
                    render();
                } else if (mUsage == null) {
                    mError = failure;
                    render();
                } else {
                    Toast.makeText(this, t("读取失败: ", "Error: ") + failure, Toast.LENGTH_SHORT).show();
                }
            });
        }, "rokbot-usage").start();
    }
}

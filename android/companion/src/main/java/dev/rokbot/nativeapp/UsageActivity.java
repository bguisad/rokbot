package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
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
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Usage page: the paired Host's usage report (GET /local/usage/report, docs/usage-report.md), in
 * the same structure as the web admin page and the desktop settings: range switch (today / 7 /
 * 30 days / all / custom, with a RokBot-styled calendar sheet), the compared range, filters as
 * chips with a filter sheet (dimension, then value), summary cards with the change against the
 * previous range, the token composition, the trend (Canvas: by model, by type, requests), the
 * breakdown per model / provider / profile / scene / bot (ring + sortable rows; tapping a row
 * filters by it), the requests a page at a time and CSV export (ACTION_CREATE_DOCUMENT).
 * Hosts without the report (404) fall back to GET /local/usage with the older cards and chart.
 * Pure logic lives in UsageReport and UsageModel.
 */
public class UsageActivity extends Activity {
    private static final String STATE_RANGE = "usage_range", STATE_FROM = "usage_from", STATE_TO = "usage_to",
            STATE_MODE = "usage_mode", STATE_DIMENSION = "usage_dimension", STATE_FILTERS = "usage_filters";
    private static final int REQUEST_EXPORT = 7311;
    /** Optional intent extras: the range to open on (today / 7d / 30d / all / custom + from / to). */
    public static final String EXTRA_RANGE = "dev.rokbot.nativeapp.extra.USAGE_RANGE",
            EXTRA_FROM = "dev.rokbot.nativeapp.extra.USAGE_FROM", EXTRA_TO = "dev.rokbot.nativeapp.extra.USAGE_TO";
    private static final String[][] RANGES = {
        {"today", "今天", "Today"},
        {"7d", "7 天", "7 days"},
        {"30d", "30 天", "30 days"},
        {"all", "全部", "All"},
        {"custom", "自定义", "Custom"},
    };
    private static final String[][] MODES = {
        {UsageReport.MODE_MODEL, "按模型", "By model"},
        {UsageReport.MODE_TYPE, "按类型", "By type"},
        {UsageReport.MODE_REQUESTS, "请求", "Requests"},
    };

    private final Handler mMain = new Handler(Looper.getMainLooper());
    private UiChrome.Palette mP;
    private boolean mZh;
    private LinearLayout mTabs;
    private TextView mRangeLine;
    private LinearLayout mFilterBar;
    private LinearLayout mContent;
    private LinearLayout mRequestsHolder;
    private View mExportButton;
    private View mRefreshButton;
    private ScrollView mScroll;

    // What is asked for.
    private String mRangeId = UsageModel.DEFAULT_PERIOD;
    private String mFrom, mTo;
    private final Map<String, String> mFilters = new LinkedHashMap<>();
    private int mOffset;
    private String mMode = UsageReport.MODE_MODEL;
    private String mDimension = "model";
    private String mSort = UsageReport.SORT_TOTAL;
    private boolean mSortDesc = true;

    // What the Host answered.
    private UsageReport.Report mReport;
    /** An older Host without /local/usage/report: GET /local/usage. */
    private UsageModel.Usage mUsage;
    private Map<String, Integer> mSeries;
    private boolean mLoading, mSkeleton, mAnimateNext;
    private String mError;
    private int mGeneration;
    private JSONObject mPendingExport;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        mP = UiChrome.palette(this);
        mZh = Localize.isChinese(this);
        Intent opener = getIntent();
        String askedFrom = opener != null ? opener.getStringExtra(EXTRA_FROM) : null;
        String askedTo = opener != null ? opener.getStringExtra(EXTRA_TO) : null;
        mRangeId = UsageModel.initialPeriod(opener != null ? opener.getStringExtra(EXTRA_RANGE) : null, askedFrom, askedTo);
        if ("custom".equals(mRangeId)) { mFrom = askedFrom; mTo = askedTo; }
        if (savedInstanceState != null) {
            // Recreated (rotation, process death): keep what was on screen.
            mRangeId = savedInstanceState.getString(STATE_RANGE, mRangeId);
            mFrom = savedInstanceState.getString(STATE_FROM);
            mTo = savedInstanceState.getString(STATE_TO);
            mMode = savedInstanceState.getString(STATE_MODE, UsageReport.MODE_MODEL);
            mDimension = savedInstanceState.getString(STATE_DIMENSION, "model");
            Bundle filters = savedInstanceState.getBundle(STATE_FILTERS);
            if (filters != null) for (String key : UsageReport.FILTER_KEYS) {
                String v = filters.getString(key);
                if (v != null) mFilters.put(key, v);
            }
        }
        buildUi();
        reload(true);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString(STATE_RANGE, mRangeId);
        outState.putString(STATE_FROM, mFrom);
        outState.putString(STATE_TO, mTo);
        outState.putString(STATE_MODE, mMode);
        outState.putString(STATE_DIMENSION, mDimension);
        Bundle filters = new Bundle();
        for (Map.Entry<String, String> e : mFilters.entrySet()) filters.putString(e.getKey(), e.getValue());
        outState.putBundle(STATE_FILTERS, filters);
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
        mScroll = scroll;
        scroll.setBackgroundColor(mP.bgPaper);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(12), dp(18), dp(24));
        scroll.addView(root);

        // Refresh spins (and ignores taps) while a load runs; see load().
        mRefreshButton = UiChrome.makeVectorIconButton(this, "refresh", "refresh_usage_button", mP, v -> reload(false));
        mExportButton = UiChrome.makeVectorIconButton(this, "download", "export_usage_csv_button", mP, v -> exportCsv());
        root.addView(UiChrome.makeHeaderBar(this, t("用量", "Usage"), mP, v -> finish(), mRefreshButton, mExportButton));

        mTabs = new LinearLayout(this);
        mTabs.setOrientation(LinearLayout.HORIZONTAL);
        mTabs.setPadding(dp(3), dp(3), dp(3), dp(3));
        mTabs.setBackground(UiChrome.roundRect(mP.bgSurface2, dp(999), 0, 0));
        mTabs.setContentDescription("usage_period_switch");
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.topMargin = dp(6);
        mTabs.setLayoutParams(tlp);
        root.addView(mTabs);

        mRangeLine = text(mP.textMuted, 12, false);
        mRangeLine.setContentDescription("usage_range_line");
        mRangeLine.setPadding(dp(4), dp(8), dp(4), 0);
        root.addView(mRangeLine);

        mFilterBar = new LinearLayout(this);
        mFilterBar.setOrientation(LinearLayout.HORIZONTAL);
        mFilterBar.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        flp.topMargin = dp(10);
        root.addView(mFilterBar, flp);

        mContent = new LinearLayout(this);
        mContent.setOrientation(LinearLayout.VERTICAL);
        root.addView(mContent, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
        render();
    }

    /** Segmented control: 今天 / 7 天 / 30 天 / 全部 / 自定义 (older Hosts: the first three). */
    private void renderTabs() {
        mTabs.removeAllViews();
        for (String[] range : RANGES) {
            final String id = range[0];
            if (mUsage != null && !mUsage.has(id)) continue;
            boolean selected = id.equals(mRangeId);
            TextView tab = segment(t(range[1], range[2]), selected, 13);
            tab.setContentDescription("usage_period_" + id);
            tab.setOnClickListener(v -> selectRange(id));
            mTabs.addView(tab, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        }
        mTabs.setVisibility(mTabs.getChildCount() > 1 ? View.VISIBLE : View.GONE);
    }

    private TextView segment(String label, boolean selected, float sp) {
        TextView tab = new TextView(this);
        tab.setText(label);
        tab.setGravity(Gravity.CENTER);
        tab.setSingleLine(true);
        tab.setEllipsize(TextUtils.TruncateAt.END);
        tab.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        tab.setTextColor(selected ? mP.textPrimary : mP.textSecondary);
        tab.setTypeface(selected ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        tab.setPadding(dp(6), dp(7), dp(6), dp(7));
        tab.setBackground(selected ? UiChrome.roundRect(mP.dark ? 0xFF45454D : mP.bgCard, dp(999), 0, 0) : null);
        tab.setSelected(selected);
        return tab;
    }

    /** A small segmented control (trend mode, breakdown dimension). */
    private LinearLayout segmented(String[][] items, String selected, String descPrefix, final java.util.function.Consumer<String> onPick) {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(dp(3), dp(3), dp(3), dp(3));
        bar.setBackground(UiChrome.roundRect(mP.bgSurface2, dp(999), 0, 0));
        for (String[] item : items) {
            final String id = item[0];
            TextView tab = segment(t(item[1], item[2]), id.equals(selected), 12);
            tab.setContentDescription(descPrefix + id);
            tab.setOnClickListener(v -> { if (!id.equals(selected)) onPick.accept(id); });
            bar.addView(tab, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        }
        return bar;
    }

    private void selectRange(String id) {
        if ("custom".equals(id)) {
            String today = mReport != null && !mReport.today.isEmpty() ? mReport.today : localToday();
            String from = mFrom, to = mTo;
            if (from == null && mReport != null) { from = mReport.from; to = mReport.to; }
            UsageRangeSheet.show(this, today, from, to, (f, tt) -> {
                mFrom = f;
                mTo = tt;
                mRangeId = "custom";
                mOffset = 0;
                reload(true);
            });
            return;
        }
        if (id.equals(mRangeId)) return;
        mRangeId = id;
        mOffset = 0;
        if (mUsage != null) {
            render();
            fadeIn();
            return;
        }
        reload(true);
    }

    private static String localToday() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private void renderRangeLine() {
        String line = "";
        if (mReport != null) line = UsageReport.rangeLine(mReport, mZh);
        else if (mUsage != null) {
            UsageModel.Period period = mUsage.period(mRangeId);
            line = UsageModel.rangeLabel(period);
            if (mUsage.timeZone != null && !mUsage.timeZone.isEmpty()) line = line.isEmpty() ? mUsage.timeZone : line + " · " + mUsage.timeZone;
        }
        mRangeLine.setText(line);
        mRangeLine.setVisibility(line.isEmpty() ? View.GONE : View.VISIBLE);
        mRangeLine.setAlpha(mSkeleton ? 0.5f : 1f);
    }

    /** 「筛选」 and one 「维度：值 ×」 chip per filter. */
    private void renderFilters() {
        mFilterBar.removeAllViews();
        boolean show = mUsage == null && (mReport != null || !mFilters.isEmpty());
        mFilterBar.setVisibility(show ? View.VISIBLE : View.GONE);
        if (mExportButton != null) {
            mExportButton.setEnabled(mUsage == null);
            mExportButton.setAlpha(mUsage == null ? 1f : 0.4f);
        }
        if (!show) return;
        TextView button = chip(t("筛选", "Filter") + (mFilters.isEmpty() ? "" : " · " + mFilters.size()), false);
        button.setContentDescription("usage_filter_button");
        button.setOnClickListener(v -> openFilterMenu());
        mFilterBar.addView(button);

        LinearLayout chips = new LinearLayout(this);
        chips.setOrientation(LinearLayout.HORIZONTAL);
        for (final String key : UsageReport.FILTER_KEYS) {
            final String value = mFilters.get(key);
            if (value == null) continue;
            TextView c = chip(UsageReport.chipLabel(mReport, key, value, mZh) + "  ×", true);
            c.setContentDescription("usage_filter_chip_" + key);
            c.setOnClickListener(v -> {
                mFilters.remove(key);
                mOffset = 0;
                reload(true);
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = dp(6);
            chips.addView(c, lp);
        }
        if (mFilters.size() > 1) {
            TextView clear = chip(t("全部清除", "Clear all"), false);
            clear.setContentDescription("usage_filter_clear");
            clear.setOnClickListener(v -> {
                mFilters.clear();
                mOffset = 0;
                reload(true);
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = dp(6);
            chips.addView(clear, lp);
        }
        HorizontalScrollView scroller = new HorizontalScrollView(this);
        scroller.setHorizontalScrollBarEnabled(false);
        scroller.addView(chips);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        slp.leftMargin = dp(2);
        mFilterBar.addView(scroller, slp);
    }

    private TextView chip(String label, boolean active) {
        TextView c = text(active ? mP.textPrimary : mP.textSecondary, 12, active);
        c.setText(label);
        c.setSingleLine(true);
        c.setGravity(Gravity.CENTER_VERTICAL);
        c.setPadding(dp(12), dp(6), dp(12), dp(6));
        c.setBackground(UiChrome.roundRect(active ? wash(true) : mP.bgCard, dp(999), active ? 0 : mP.border, active ? 0 : Math.max(1, dp(0.8f))));
        return c;
    }

    /** Filter menu: the dimension first, then its values (with 「全部」 to drop the filter). */
    private void openFilterMenu() {
        if (mReport == null) return;
        final List<String> keys = new ArrayList<>();
        List<String> labels = new ArrayList<>();
        for (String key : UsageReport.FILTER_KEYS) {
            List<UsageReport.Option> options = mReport.options.get(key);
            if (options == null || options.isEmpty()) continue;
            keys.add(key);
            String value = mFilters.get(key);
            labels.add(UsageReport.dimensionTitle(key, mZh) + (value != null ? t("：", ": ") + UsageReport.filterLabel(mReport, key, value, mZh) : ""));
        }
        if (keys.isEmpty()) {
            Toast.makeText(this, t("这段时间没有可筛选的请求", "Nothing to filter in this range"), Toast.LENGTH_SHORT).show();
            return;
        }
        ChoiceField.showSheet(this, t("筛选", "Filter"), labels, -1, position -> openFilterValues(keys.get(position)));
    }

    private void openFilterValues(final String key) {
        final List<UsageReport.Option> options = mReport.options.get(key);
        if (options == null) return;
        List<String> labels = new ArrayList<>();
        labels.add(t("全部", "All"));
        int selected = 0;
        String current = mFilters.get(key);
        for (int i = 0; i < options.size(); i++) {
            UsageReport.Option o = options.get(i);
            labels.add(UsageReport.valueLabel(key, o.key, o.label, mZh) + "  ·  "
                    + UsageModel.withRequestUnit(UsageModel.formatExact(o.requests), o.requests, mZh));
            if (o.key.equals(current)) selected = i + 1;
        }
        ChoiceField.showSheet(this, UsageReport.dimensionTitle(key, mZh), labels, selected, position -> {
            if (position == 0) mFilters.remove(key);
            else mFilters.put(key, options.get(position - 1).key);
            mOffset = 0;
            reload(true);
        });
    }

    private void render() {
        if (mContent == null) return;
        renderTabs();
        renderRangeLine();
        renderFilters();
        mContent.removeAllViews();
        mRequestsHolder = null;
        if (mSkeleton || (mReport == null && mUsage == null && mError == null)) {
            mContent.addView(skeleton());
            return;
        }
        if (mReport == null && mUsage == null) {
            LinearLayout card = block(null);
            card.setContentDescription("usage_error");
            TextView msg = text(mP.textPrimary, 15, true);
            msg.setText(t("无法读取用量", "Could not load usage"));
            card.addView(msg);
            TextView detail = text(mP.textSecondary, 13, false);
            detail.setText(mError);
            detail.setPadding(0, dp(6), 0, dp(12));
            card.addView(detail);
            TextView retry = UiChrome.makePillButton(this, t("重试", "Retry"), true, mP, v -> reload(true));
            retry.setContentDescription("usage_retry");
            card.addView(retry, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            mContent.addView(card);
            return;
        }
        if (mUsage != null) {
            renderLegacy();
            return;
        }
        UsageReport.Report r = mReport;
        if (r.empty()) {
            LinearLayout card = block(null);
            card.setContentDescription("usage_empty");
            card.setPadding(dp(16), dp(28), dp(16), dp(28));
            card.setGravity(Gravity.CENTER_HORIZONTAL);
            TextView tv = text(mP.textPrimary, 15, true);
            tv.setGravity(Gravity.CENTER);
            tv.setText(t("这段时间还没有模型请求", "No model requests in this range"));
            card.addView(tv);
            TextView sub = text(mP.textMuted, 12, false);
            sub.setGravity(Gravity.CENTER);
            sub.setPadding(0, dp(6), 0, 0);
            sub.setText(mFilters.isEmpty() ? t("换个时间范围看看", "Try another range") : t("当前筛选条件下没有记录", "Nothing matches the filters"));
            card.addView(sub);
            if (!mFilters.isEmpty()) {
                TextView clear = UiChrome.makePillButton(this, t("清除筛选", "Clear filters"), false, mP, v -> {
                    mFilters.clear();
                    mOffset = 0;
                    reload(true);
                });
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.topMargin = dp(14);
                card.addView(clear, lp);
            }
            mContent.addView(card);
            return;
        }
        boolean animate = mAnimateNext;
        mAnimateNext = false;
        mContent.addView(summaryCards(r));
        mContent.addView(compositionBlock(r));
        mContent.addView(trendBlock(r, animate));
        mContent.addView(breakdownBlock(r, animate));
        mContent.addView(requestsBlock(r));
    }

    private void fadeIn() {
        mContent.setAlpha(0f);
        mContent.setTranslationY(dp(6));
        mContent.animate().alpha(1f).translationY(0).setDuration(240L).start();
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

    /** Loading placeholder: grey rounded blocks in the page's shape, softly pulsing. */
    private View skeleton() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setContentDescription("usage_loading");
        for (int r = 0; r < 3; r++) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            for (int c = 0; c < 2; c++) {
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(78), 1f);
                if (c > 0) lp.leftMargin = dp(8);
                row.addView(new UsageChartView.Skeleton(this, mP, dp(14)), lp);
            }
            LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rlp.topMargin = dp(r == 0 ? 12 : 8);
            box.addView(row, rlp);
        }
        int[] heights = {64, 232, 260};
        for (int h : heights) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(h));
            lp.topMargin = dp(12);
            box.addView(new UsageChartView.Skeleton(this, mP, dp(14)), lp);
        }
        return box;
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

    private LinearLayout grid(View... cells) {
        LinearLayout grid = new LinearLayout(this);
        grid.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        glp.topMargin = dp(12);
        grid.setLayoutParams(glp);
        int perRow = getResources().getConfiguration().screenWidthDp >= 600 ? 3 : 2;
        for (int i = 0; i < cells.length; i += perRow) {
            View[] part = new View[perRow];
            for (int j = 0; j < perRow; j++) {
                part[j] = i + j < cells.length ? cells[i + j] : new View(this);
            }
            grid.addView(row(part));
        }
        return grid;
    }

    private int wash() { return wash(false); }

    private int wash(boolean strong) {
        int c = mP.textPrimary;
        return (c & 0x00FFFFFF) | ((mP.dark ? (strong ? 0x24 : 0x1A) : (strong ? 0x12 : 0x0D)) << 24);
    }

    private int line(int alpha) {
        return (mP.textPrimary & 0x00FFFFFF) | (alpha << 24);
    }

    private View swatchColor(int color, int sizeDp, float radiusDp) {
        View sw = new UsageChartView.Swatch(this, color, dp(radiusDp));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp));
        lp.rightMargin = dp(8);
        lp.gravity = Gravity.CENTER_VERTICAL;
        sw.setLayoutParams(lp);
        return sw;
    }

    private View swatch(int series, int sizeDp, float radiusDp) {
        return swatchColor(UsageModel.seriesColor(series, mP.dark), sizeDp, radiusDp);
    }

    private View divider() {
        View v = new View(this);
        v.setBackgroundColor(line(0x14));
        v.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(0.5f))));
        return v;
    }

    // ------------------------------------------------------------------ report: summary

    /** 「+12.3% 较上一周期」 in the tone of the change (durations / failures rising = warning). */
    private TextView changeLine(UsageReport.Report r, String key) {
        if (r.previousFrom == null) return null;
        TextView tv = text(mP.textMuted, 11, false);
        tv.setSingleLine(true);
        tv.setEllipsize(TextUtils.TruncateAt.END);
        tv.setPadding(0, dp(3), 0, 0);
        Double change = UsageReport.change(r, key);
        String text = UsageReport.formatChange(change);
        if (text.isEmpty()) {
            tv.setText(t("上一周期无可比数据", "No earlier data to compare"));
            return tv;
        }
        int tone = UsageReport.changeTone(key, change);
        tv.setTextColor(tone == UsageReport.TONE_WARN ? mP.danger : tone == UsageReport.TONE_GOOD ? mP.success : mP.textSecondary);
        tv.setText(text + t(" 较上一周期", " vs previous"));
        tv.setContentDescription("usage_change_" + key);
        return tv;
    }

    private LinearLayout stack(View... views) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        for (View v : views) if (v != null) box.addView(v);
        return box;
    }

    private TextView note(String text) {
        if (text == null) return null;
        TextView tv = text(mP.textMuted, 11, false);
        tv.setSingleLine(true);
        tv.setEllipsize(TextUtils.TruncateAt.END);
        tv.setText(text);
        return tv;
    }

    private TextView value(String text) {
        TextView tv = text(mP.textPrimary, 21, true);
        tv.setSingleLine(true);
        tv.setEllipsize(TextUtils.TruncateAt.END);
        tv.setText(text);
        return tv;
    }

    /** 总花费, 总 Token, 请求次数, 平均耗时, 失败率, 缓存命中率, each with its change. */
    private View summaryCards(UsageReport.Report r) {
        UsageReport.Totals s = r.totals;
        TextView cost = value(UsageReport.formatCost(s.cost, r.priced, mZh));
        if (!r.priced) cost.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        View costCard = card(t("总花费", "Total cost"), cost, r.priced ? changeLine(r, "cost") : note(t("在 Host 配置单价后显示", "Set prices on the Host"))) ;
        costCard.setContentDescription("usage_card_cost");

        View tokens = card(t("总 Token", "Total tokens"), count(s.total, true, mP.textPrimary, 21, true), changeLine(r, "total"));
        tokens.setContentDescription("usage_card_total");
        View requests = card(t("请求次数", "Requests"), count(s.requests, true, mP.textPrimary, 21, true), changeLine(r, "requests"));
        requests.setContentDescription("usage_card_requests");

        TextView duration = value(UsageReport.formatDuration(s.avgDurationMs, mZh));
        if (s.avgDurationMs == null) duration.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        View durationCard = card(t("平均耗时", "Avg. duration"), duration,
                stack(changeLine(r, "avgDurationMs"), note(UsageReport.recordedNote(s.durationRecorded, s.requests, mZh))));
        durationCard.setContentDescription("usage_card_duration");

        TextView failure = value(UsageReport.formatRate(s.failureRate, UsageReport.missing(mZh)));
        if (s.failureRate == null) failure.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        View failureCard = card(t("失败率", "Failure rate"), failure,
                stack(changeLine(r, "failureRate"), note(UsageReport.recordedNote(s.statusRecorded, s.requests, mZh))));
        failureCard.setContentDescription("usage_card_failure");

        TextView hit = value(UsageReport.formatRate(s.cacheHitRate, "—"));
        if (s.input > 0) bindExact(hit, UsageReport.formatRate(s.cacheHitRate, "—"),
                UsageModel.formatExact(s.cached) + " / " + UsageModel.formatExact(s.input), 21);
        View hitCard = card(t("缓存命中率", "Cache hit rate"), hit,
                note(t("缓存命中 ", "Cache read ") + UsageModel.formatCount(s.cached, mZh) + " Token"));
        hitCard.setContentDescription("usage_card_cache");
        return grid(costCard, tokens, requests, durationCard, failureCard, hitCard);
    }

    /** Token 构成: uncached input / cache read / output / reasoning as one stacked bar and a legend. */
    private View compositionBlock(UsageReport.Report r) {
        LinearLayout block = block(t("Token 构成", "Token composition"));
        block.setContentDescription("usage_composition");
        long[] parts = UsageReport.composition(r.totals);
        int[] colors = {UsageModel.seriesColor(1, mP.dark), UsageModel.seriesColor(3, mP.dark), UsageModel.seriesColor(2, mP.dark), UsageModel.seriesColor(7, mP.dark)};
        String[] names = mZh ? new String[] {"未命中输入", "缓存命中", "输出", "推理"} : new String[] {"Uncached input", "Cache read", "Output", "Reasoning"};
        block.addView(new UsageChartView.StackBar(this, wash(), parts, colors),
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(12)));
        long sum = 0;
        for (long v : parts) sum += v;
        LinearLayout legend = new LinearLayout(this);
        legend.setOrientation(LinearLayout.VERTICAL);
        legend.setPadding(0, dp(10), 0, 0);
        for (int i = 0; i < parts.length; i += 2) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            for (int j = i; j < i + 2; j++) {
                LinearLayout item = new LinearLayout(this);
                item.setOrientation(LinearLayout.HORIZONTAL);
                item.setGravity(Gravity.CENTER_VERTICAL);
                item.setPadding(0, dp(4), 0, dp(4));
                item.addView(swatchColor(colors[j], 9, 3));
                TextView name = text(mP.textSecondary, 12, false);
                name.setText(names[j]);
                name.setSingleLine(true);
                item.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                TextView v = count(parts[j], true, mP.textPrimary, 12, true);
                item.addView(v);
                TextView share = text(mP.textMuted, 11, false);
                share.setText(" " + UsageModel.formatShare(parts[j], sum));
                share.setPadding(dp(4), 0, dp(10), 0);
                item.addView(share);
                row.addView(item, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            }
            legend.addView(row);
        }
        block.addView(legend);
        if (r.totals.cacheWrite > 0) {
            TextView w = note(t("另有缓存写入 ", "Cache write ") + UsageModel.formatCount(r.totals.cacheWrite, mZh) + t(" Token（计入输入）", " tokens (part of input)"));
            w.setPadding(0, dp(4), 0, 0);
            block.addView(w);
        }
        return block;
    }

    // ------------------------------------------------------------------ report: trend

    private View trendBlock(UsageReport.Report r, boolean animate) {
        String unit = "hour".equals(r.unit) ? t("每小时", "per hour") : "month".equals(r.unit) ? t("每月", "per month") : t("每天", "per day");
        LinearLayout block = block(t("趋势", "Trend") + " · " + unit);
        block.setContentDescription("usage_trend");
        block.addView(segmented(MODES, mMode, "usage_trend_mode_", id -> {
            mMode = id;
            mAnimateNext = true;
            render();
        }), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        UsageChartView chart = new UsageChartView(this, mP, mZh);
        chart.setReport(r, mMode, animate);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.topMargin = dp(12);
        block.addView(chart, clp);

        // Legend.
        LinearLayout legend = new LinearLayout(this);
        legend.setOrientation(LinearLayout.VERTICAL);
        legend.setPadding(0, dp(8), 0, 0);
        List<int[]> colors = new ArrayList<>();
        List<String> names = new ArrayList<>();
        if (UsageReport.MODE_TYPE.equals(mMode)) {
            String[] n = mZh ? new String[] {"缓存命中", "未命中输入", "输出"} : new String[] {"Cache read", "Uncached input", "Output"};
            for (int k = 0; k < 3; k++) { colors.add(new int[] {chart.typeColor(k)}); names.add(n[k]); }
        } else if (UsageReport.MODE_REQUESTS.equals(mMode)) {
            colors.add(new int[] {chart.requestColor(false)});
            names.add(t("成功或未记录状态", "Succeeded or not recorded"));
            colors.add(new int[] {chart.requestColor(true)});
            names.add(t("失败", "Failed"));
        } else {
            for (int i = 0; i < r.series.size(); i++) { colors.add(new int[] {UsageModel.seriesColor(i + 1, mP.dark)}); names.add(r.series.get(i)); }
            boolean other = false;
            for (UsageReport.Bucket b : r.buckets) for (UsageReport.ModelTotal m : b.models) if (m.total > 0 && UsageReport.seriesOf(r, m.model) == 0) other = true;
            if (other) { colors.add(new int[] {UsageModel.seriesColor(0, mP.dark)}); names.add(t("其他模型", "Other models")); }
        }
        LinearLayout row = null;
        for (int i = 0; i < names.size(); i++) {
            if (i % 2 == 0) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                legend.addView(row);
            }
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.HORIZONTAL);
            item.setGravity(Gravity.CENTER_VERTICAL);
            item.setPadding(0, dp(3), dp(8), dp(3));
            item.addView(swatchColor(colors.get(i)[0], 9, 3));
            TextView name = text(mP.textSecondary, 12, false);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            name.setText(names.get(i));
            item.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            row.addView(item, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        }
        if (row != null && names.size() % 2 == 1) row.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1f));
        block.addView(legend);
        TextView hint = text(mP.textMuted, 11, false);
        hint.setText(t("点按图表查看该时段明细，长按数字查看精确值", "Tap the chart for a time slot; long-press a number for the exact value"));
        hint.setPadding(0, dp(6), 0, 0);
        block.addView(hint);
        return block;
    }

    // ------------------------------------------------------------------ report: breakdown

    private static final String[][] DIMENSION_TABS = {
        {"model", "模型", "Model"},
        {"provider", "服务商", "Provider"},
        {"profile", "配置", "Profile"},
        {"kind", "场景", "Scene"},
        {"agent", "Bot", "Bot"},
    };

    private View breakdownBlock(UsageReport.Report r, boolean animate) {
        LinearLayout block = block(t("维度拆分", "Breakdown"));
        block.setContentDescription("usage_breakdown");
        block.addView(segmented(DIMENSION_TABS, mDimension, "usage_dimension_", id -> {
            mDimension = id;
            mAnimateNext = true;
            render();
        }), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        List<UsageReport.Row> rows = r.rows(mDimension);
        // Colours follow the Host order (largest first), whatever the list is sorted by.
        Map<String, Integer> colorOf = new LinkedHashMap<>();
        for (int i = 0; i < rows.size(); i++) colorOf.put(rows.get(i).key, UsageReport.rowSeries(r, mDimension, rows.get(i), i));

        // Ring: one arc per row in the Host order, the 8th and later merged into grey.
        int arcs = Math.min(rows.size(), UsageModel.SERIES + 1);
        long[] values = new long[arcs];
        int[] colors = new int[arcs];
        for (int i = 0; i < rows.size(); i++) {
            int at = Math.min(i, arcs - 1);
            values[at] += rows.get(i).total;
            colors[at] = i >= UsageModel.SERIES ? UsageModel.seriesColor(0, mP.dark) : UsageModel.seriesColor(colorOf.get(rows.get(i).key), mP.dark);
        }
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(0, dp(14), 0, dp(6));
        UsageChartView.Donut donut = new UsageChartView.Donut(this, mP);
        donut.setData(values, colors, UsageModel.formatCount(r.totals.total, mZh), "Token", animate);
        top.addView(donut, new LinearLayout.LayoutParams(dp(128), dp(128)));
        LinearLayout side = new LinearLayout(this);
        side.setOrientation(LinearLayout.VERTICAL);
        side.setPadding(dp(16), 0, 0, 0);
        for (int i = 0; i < Math.min(rows.size(), 4); i++) {
            UsageReport.Row row = rows.get(i);
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.HORIZONTAL);
            item.setGravity(Gravity.CENTER_VERTICAL);
            item.setPadding(0, dp(3), 0, dp(3));
            item.addView(swatch(colorOf.get(row.key), 9, 3));
            TextView name = text(mP.textSecondary, 12, false);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            name.setText(UsageReport.valueLabel(mDimension, row.key, row.label, mZh));
            item.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            TextView share = text(mP.textPrimary, 12, true);
            share.setText(UsageModel.formatShare(row.share, 1));
            share.setPadding(dp(6), 0, 0, 0);
            item.addView(share);
            side.addView(item);
        }
        if (rows.size() > 4) {
            TextView more = note(t("共 " + rows.size() + " 项", rows.size() + " in total"));
            more.setPadding(dp(17), dp(3), 0, 0);
            side.addView(more);
        }
        top.addView(side, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        block.addView(top);

        // Sort chips.
        List<String[]> sorts = new ArrayList<>();
        sorts.add(new String[] {UsageReport.SORT_TOTAL, "Token", "Tokens"});
        sorts.add(new String[] {UsageReport.SORT_REQUESTS, "请求", "Requests"});
        sorts.add(new String[] {UsageReport.SORT_DURATION, "耗时", "Duration"});
        sorts.add(new String[] {UsageReport.SORT_FAILURE, "失败率", "Failures"});
        if (r.priced) sorts.add(new String[] {UsageReport.SORT_COST, "花费", "Cost"});
        LinearLayout sortRow = new LinearLayout(this);
        sortRow.setOrientation(LinearLayout.HORIZONTAL);
        sortRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView sortLabel = text(mP.textMuted, 12, false);
        sortLabel.setText(t("排序", "Sort"));
        sortRow.addView(sortLabel);
        for (final String[] s : sorts) {
            boolean active = s[0].equals(mSort);
            TextView c = chip(t(s[1], s[2]) + (active ? (mSortDesc ? " ↓" : " ↑") : ""), active);
            c.setContentDescription("usage_sort_" + s[0]);
            c.setOnClickListener(v -> {
                if (s[0].equals(mSort)) mSortDesc = !mSortDesc;
                else { mSort = s[0]; mSortDesc = true; }
                render();
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = dp(6);
            sortRow.addView(c, lp);
        }
        HorizontalScrollView sortScroll = new HorizontalScrollView(this);
        sortScroll.setHorizontalScrollBarEnabled(false);
        sortScroll.addView(sortRow);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.topMargin = dp(6);
        slp.bottomMargin = dp(6);
        block.addView(sortScroll, slp);

        List<UsageReport.Row> sorted = UsageReport.sortRows(rows, mSort, mSortDesc, mDimension, mZh);
        String applied = mFilters.get(mDimension);
        for (int i = 0; i < sorted.size(); i++) {
            if (i > 0) block.addView(divider());
            block.addView(breakdownRow(r, sorted.get(i), colorOf.get(sorted.get(i).key), applied));
        }
        TextView hint = note(applied == null ? t("点按一行即按该项筛选", "Tap a row to filter by it") : t("再次点按可取消该筛选", "Tap again to remove the filter"));
        hint.setPadding(0, dp(8), 0, 0);
        block.addView(hint);
        return block;
    }

    private View breakdownRow(UsageReport.Report r, final UsageReport.Row row, int series, String applied) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setPadding(dp(4), dp(10), dp(4), dp(10));
        item.setClickable(true);
        item.setContentDescription("usage_breakdown_row_" + row.key);
        boolean active = row.key.equals(applied);
        if (active) item.setBackground(UiChrome.roundRect(wash(true), dp(10), 0, 0));
        final String dim = mDimension;
        item.setOnClickListener(v -> {
            if (row.key.equals(mFilters.get(dim))) mFilters.remove(dim);
            else mFilters.put(dim, row.key);
            mOffset = 0;
            reload(true);
        });

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.addView(swatch(series, 10, 3));
        TextView name = text(UsageReport.NONE.equals(row.key) ? mP.textMuted : mP.textPrimary, 13, false);
        if ("model".equals(mDimension)) name.setTypeface(Typeface.MONOSPACE);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        name.setText(UsageReport.valueLabel(mDimension, row.key, row.label, mZh));
        head.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView share = text(mP.textPrimary, 13, true);
        share.setText(UsageModel.formatShare(row.share, 1));
        share.setPadding(dp(10), 0, 0, 0);
        head.addView(share);
        item.addView(head);

        View bar = new UsageChartView.ShareBar(this, wash(), UsageModel.seriesColor(series, mP.dark), Math.max(0.005, row.share));
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(6));
        blp.topMargin = dp(6);
        item.addView(bar, blp);

        StringBuilder meta = new StringBuilder();
        meta.append(UsageModel.formatCount(row.total, mZh)).append(" Token · ")
            .append(UsageModel.withRequestUnit(UsageModel.formatCount(row.requests, mZh), row.requests, mZh))
            .append(" · ").append(t("平均 ", "avg ")).append(UsageReport.formatDuration(row.avgDurationMs, mZh))
            .append(" · ").append(t("失败 ", "failed ")).append(UsageReport.formatRate(row.failureRate, UsageReport.missing(mZh)));
        if (r.priced) meta.append(" · ").append(t("花费 ", "cost ")).append(UsageReport.formatCost(row.cost, true, mZh));
        TextView metaView = text(mP.textMuted, 11, false);
        metaView.setText(meta.toString());
        metaView.setPadding(dp(18), dp(5), 0, 0);
        item.addView(metaView);
        return item;
    }

    // ------------------------------------------------------------------ report: requests

    private View requestsBlock(UsageReport.Report r) {
        LinearLayout block = block(null);
        block.setContentDescription("usage_requests");
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(0, 0, 0, dp(6));
        TextView title = text(mP.textSecondary, 12, true);
        title.setText(t("请求明细", "Requests"));
        head.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView total = note(t("共 ", "") + UsageModel.formatExact(r.requestTotal) + t(" 条", " in total"));
        head.addView(total);
        block.addView(head);
        mRequestsHolder = new LinearLayout(this);
        mRequestsHolder.setOrientation(LinearLayout.VERTICAL);
        block.addView(mRequestsHolder);
        fillRequests(r);
        return block;
    }

    private void fillRequests(UsageReport.Report r) {
        if (mRequestsHolder == null) return;
        mRequestsHolder.removeAllViews();
        // A fast page may answer before the dimming animation ends: cancel it, then fade back in.
        mRequestsHolder.animate().cancel();
        mRequestsHolder.animate().alpha(1f).setDuration(160L).start();
        for (int i = 0; i < r.items.size(); i++) {
            View card = requestCard(r, r.items.get(i));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            if (i > 0) lp.topMargin = dp(8);
            mRequestsHolder.addView(card, lp);
        }

        LinearLayout pager = new LinearLayout(this);
        pager.setOrientation(LinearLayout.HORIZONTAL);
        pager.setGravity(Gravity.CENTER_VERTICAL);
        pager.setPadding(0, dp(12), 0, 0);
        TextView prev = UiChrome.makePillButton(this, t("上一页", "Previous"), false, mP, v -> page(-1));
        prev.setContentDescription("usage_page_prev");
        prev.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        prev.setPadding(dp(14), dp(8), dp(14), dp(8));
        boolean hasPrev = UsageReport.hasPrevPage(r), hasNext = UsageReport.hasNextPage(r);
        prev.setEnabled(hasPrev);
        prev.setAlpha(hasPrev ? 1f : 0.4f);
        pager.addView(prev);
        TextView label = text(mP.textSecondary, 12, false);
        label.setGravity(Gravity.CENTER);
        label.setContentDescription("usage_page_label");
        label.setText(UsageReport.pageLabel(r.offset, r.items.size(), r.requestTotal, mZh));
        pager.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView next = UiChrome.makePillButton(this, t("下一页", "Next"), false, mP, v -> page(1));
        next.setContentDescription("usage_page_next");
        next.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        next.setPadding(dp(14), dp(8), dp(14), dp(8));
        next.setEnabled(hasNext);
        next.setAlpha(hasNext ? 1f : 0.4f);
        pager.addView(next);
        mRequestsHolder.addView(pager);
    }

    private TextView statusBadge(String status) {
        int fg, bg;
        if ("ok".equals(status)) fg = mP.success;
        else if ("error".equals(status)) fg = mP.danger;
        else fg = mP.textMuted;
        bg = (fg & 0x00FFFFFF) | ((mP.dark ? 0x2E : 0x1A) << 24);
        TextView badge = text(fg, 11, true);
        badge.setText(UsageReport.statusLabel(status, mZh));
        badge.setPadding(dp(8), dp(2), dp(8), dp(2));
        badge.setBackground(UiChrome.roundRect(bg, dp(999), 0, 0));
        return badge;
    }

    /** One request: time and status, bot · scene · model, tokens and duration; missing fields = 「未记录」. */
    private View requestCard(UsageReport.Report r, UsageReport.Request q) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(12), dp(10), dp(12), dp(10));
        card.setBackground(UiChrome.roundRect(mP.dark ? 0xFF25252B : 0xFFF7F7F9, dp(12), 0, 0));
        card.setContentDescription("usage_request_" + (q.id == null ? "" : q.id));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView time = text(mP.textSecondary, 12, false);
        time.setText(UsageReport.requestTime(q.at, r.timeZone, r.today));
        top.addView(time, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(statusBadge(q.status));
        card.addView(top);

        String missing = UsageReport.missing(mZh);
        TextView who = text(mP.textPrimary, 14, true);
        who.setSingleLine(true);
        who.setEllipsize(TextUtils.TruncateAt.END);
        who.setText((q.agent != null ? q.agent : q.agentId != null ? q.agentId : "Bot " + missing) + " · " + UsageReport.kindLabel(q.kind, mZh));
        who.setPadding(0, dp(4), 0, 0);
        card.addView(who);

        TextView model = text(mP.textSecondary, 12, false);
        model.setTypeface(Typeface.MONOSPACE);
        model.setSingleLine(true);
        model.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        String profile = q.profile != null ? q.profile : q.profileId;
        model.setText((q.model != null ? q.model : missing) + (profile != null ? " · " + profile : ""));
        model.setPadding(0, dp(2), 0, 0);
        card.addView(model);

        LinearLayout nums = new LinearLayout(this);
        nums.setOrientation(LinearLayout.HORIZONTAL);
        nums.setGravity(Gravity.CENTER_VERTICAL);
        nums.setPadding(0, dp(6), 0, 0);
        TextView tokens = count(q.total, true, mP.textPrimary, 13, true);
        nums.addView(tokens);
        TextView unit = text(mP.textMuted, 12, false);
        unit.setText(" Token");
        nums.addView(unit);
        TextView parts = text(mP.textMuted, 11, false);
        parts.setSingleLine(true);
        parts.setEllipsize(TextUtils.TruncateAt.END);
        parts.setText("  " + t("输入 ", "in ") + UsageModel.formatCount(q.input, mZh) + t(" · 缓存 ", " · cached ") + UsageModel.formatCount(q.cached, mZh)
                + t(" · 输出 ", " · out ") + UsageModel.formatCount(q.output, mZh));
        nums.addView(parts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView duration = text(q.durationMs == null ? mP.textMuted : mP.textSecondary, 12, false);
        duration.setText(UsageReport.formatDuration(q.durationMs == null ? null : (double) q.durationMs, mZh));
        nums.addView(duration);
        card.addView(nums);

        if (r.priced) {
            TextView cost = note(t("花费 ", "Cost ") + UsageReport.formatCost(q.cost, true, mZh));
            cost.setPadding(0, dp(3), 0, 0);
            card.addView(cost);
        }
        if (q.error != null) {
            TextView error = text(mP.danger, 12, false);
            error.setText(q.error);
            error.setMaxLines(2);
            error.setEllipsize(TextUtils.TruncateAt.END);
            error.setPadding(0, dp(4), 0, 0);
            card.addView(error);
        }
        return card;
    }

    private void page(int delta) {
        if (mReport == null || mLoading) return;
        int size = UsageReport.PAGE_SIZE;
        int next = Math.max(0, mReport.offset + delta * size);
        if (delta > 0 && !UsageReport.hasNextPage(mReport)) return;
        if (delta < 0 && !UsageReport.hasPrevPage(mReport)) return;
        mOffset = next;
        if (mRequestsHolder != null) mRequestsHolder.animate().alpha(0.45f).setDuration(120L).start();
        load(false, true);
    }

    // ------------------------------------------------------------------ older Hosts

    /** GET /local/usage (no report): a notice, the summary cards, the chart and the share per model. */
    private void renderLegacy() {
        TextView notice = text(mP.textSecondary, 13, false);
        notice.setContentDescription("usage_legacy_notice");
        notice.setText(t("升级 Host 后可查看详细用量", "Update the Host to see the detailed usage report"));
        notice.setPadding(dp(14), dp(10), dp(14), dp(10));
        notice.setBackground(UiChrome.roundRect(wash(true), dp(12), 0, 0));
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nlp.topMargin = dp(12);
        mContent.addView(notice, nlp);

        UsageModel.Period period = mUsage.period(mRangeId);
        if (period == null) return;
        mRangeId = period.id;
        mContent.addView(legacyCards(period));
        if (UsageModel.isEmpty(period)) {
            LinearLayout card = block(null);
            TextView tv = text(mP.textMuted, 13, false);
            tv.setGravity(Gravity.CENTER);
            tv.setText(t("这段时间还没有模型请求", "No model requests in this period"));
            card.addView(tv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            mContent.addView(card);
            return;
        }
        if (period.buckets != null && !period.buckets.isEmpty()) {
            LinearLayout chartBlock = block(period.hourly() ? t("每小时 Token", "Tokens per hour") : t("每日 Token", "Tokens per day"));
            UsageChartView chart = new UsageChartView(this, mP, mZh);
            chart.setData(period, mSeries);
            chartBlock.addView(chart, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            mContent.addView(chartBlock);
        }
        if (!period.models.isEmpty()) mContent.addView(legacyShares(period));
    }

    /** 总 Token, 请求数, 输入, 输出, 缓存命中率 (cached / input). */
    private View legacyCards(UsageModel.Period p) {
        View total = card(t("总 Token", "Total tokens"), count(p.total, true, mP.textPrimary, 22, true), null);
        View requests = card(t("请求数", "Requests"), count(p.requests, p.hasRequests, mP.textPrimary, 22, true), null);
        View input = card(t("输入", "Input"), count(p.input, true, mP.textPrimary, 22, true), null);
        View output = card(t("输出", "Output"), count(p.output, true, mP.textPrimary, 22, true), null);
        TextView rateValue = text(mP.textPrimary, 22, true);
        rateValue.setText(UsageModel.cacheHitRate(p));
        View hitRate = card(t("缓存命中率", "Cache hit rate"), rateValue, null);
        return grid(total, requests, input, output, hitRate);
    }

    /** 模型占比: swatch + name, share and short total, and a bar. */
    private View legacyShares(UsageModel.Period p) {
        LinearLayout block = block(t("模型占比", "Share by model"));
        List<UsageModel.SharePart> parts = UsageModel.shares(p, mSeries, mZh);
        long largest = 1;
        for (UsageModel.SharePart part : parts) largest = Math.max(largest, part.total);
        for (int i = 0; i < parts.size(); i++) {
            UsageModel.SharePart part = parts.get(i);
            LinearLayout head = new LinearLayout(this);
            head.setOrientation(LinearLayout.HORIZONTAL);
            head.setGravity(Gravity.CENTER_VERTICAL);
            head.setPadding(0, i > 0 ? dp(10) : 0, 0, 0);
            head.addView(swatch(part.series, 10, 3));
            TextView name = text(mP.textPrimary, 12, false);
            name.setTypeface(Typeface.MONOSPACE);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            name.setText(part.label());
            head.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            TextView share = text(mP.textPrimary, 13, true);
            share.setText(UsageModel.formatShare(part.total, p.total));
            share.setPadding(dp(10), 0, dp(6), 0);
            head.addView(share);
            head.addView(count(part.total, true, mP.textSecondary, 13, false));
            block.addView(head);
            View bar = new UsageChartView.ShareBar(this, wash(), UsageModel.seriesColor(part.series, mP.dark),
                    UsageModel.shareBarFraction(part.total, largest));
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(8));
            blp.topMargin = dp(5);
            block.addView(bar, blp);
        }
        return block;
    }

    // ------------------------------------------------------------------ data

    /** `full`: range / filters changed (skeleton, then a fade); otherwise refresh in place. */
    private void reload(boolean full) {
        if (full) {
            mSkeleton = true;
            mAnimateNext = true;
            render();
        }
        load(full, false);
    }

    private void load(final boolean full, final boolean pageOnly) {
        final int generation = ++mGeneration;
        mLoading = true;
        UiChrome.setIconButtonBusy(mRefreshButton, true);
        final String range = mRangeId, from = mFrom, to = mTo;
        final Map<String, String> filters = new LinkedHashMap<>(mFilters);
        final int offset = mOffset;
        new Thread(() -> {
            UsageReport.Report report = null;
            UsageModel.Usage usage = null;
            String error = null;
            try {
                JSONObject json = HostApiClient.getUsageReport(this, range, from, to, filters, offset, UsageReport.PAGE_SIZE);
                report = UsageReport.parse(json);
            } catch (HostApiClient.ApiException e) {
                if (e.statusCode == 404) {
                    try {
                        usage = UsageModel.parse(HostApiClient.getUsage(this, null));
                    } catch (Throwable t) {
                        error = message(t);
                    }
                } else {
                    error = message(e);
                }
            } catch (Throwable t) {
                error = message(t);
            }
            final UsageReport.Report result = report;
            final UsageModel.Usage legacy = usage;
            final String failure = error;
            mMain.post(() -> {
                if (generation != mGeneration || isFinishing() || isDestroyed()) return;
                mLoading = false;
                UiChrome.setIconButtonBusy(mRefreshButton, false);
                boolean wasSkeleton = mSkeleton;
                mSkeleton = false;
                if (result != null) {
                    mReport = result;
                    mUsage = null;
                    mError = null;
                    if (pageOnly && mRequestsHolder != null) {
                        fillRequests(result);
                        // Back to the top of the request list, as the new page starts there.
                        View block = (View) mRequestsHolder.getParent();
                        if (block != null && mScroll != null && block.getParent() instanceof View) {
                            int top = block.getTop() + ((View) block.getParent()).getTop();
                            if (mScroll.getScrollY() > top) mScroll.smoothScrollTo(0, top);
                        }
                        return;
                    }
                    render();
                    if (full || wasSkeleton) fadeIn();
                } else if (legacy != null) {
                    mUsage = legacy;
                    mSeries = UsageModel.series(legacy);
                    mReport = null;
                    mError = null;
                    if (!"today".equals(mRangeId) && !"7d".equals(mRangeId) && !"30d".equals(mRangeId)) mRangeId = UsageModel.DEFAULT_PERIOD;
                    render();
                    fadeIn();
                } else if (mReport == null && mUsage == null) {
                    mError = failure;
                    render();
                } else {
                    if (wasSkeleton) render();
                    if (mRequestsHolder != null) {
                        mRequestsHolder.animate().cancel();
                        mRequestsHolder.setAlpha(1f);
                    }
                    Toast.makeText(this, t("读取失败：", "Error: ") + failure, Toast.LENGTH_SHORT).show();
                }
            });
        }, "rokbot-usage").start();
    }

    private static String message(Throwable t) {
        return t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
    }

    // ------------------------------------------------------------------ export

    /** Fetches the CSV of the current range and filters, then asks where to save it (no FileProvider). */
    private void exportCsv() {
        if (mUsage != null) {
            Toast.makeText(this, t("升级 Host 后可导出用量", "Update the Host to export usage"), Toast.LENGTH_SHORT).show();
            return;
        }
        if (mReport == null) return;
        Toast.makeText(this, t("正在准备 CSV…", "Preparing CSV…"), Toast.LENGTH_SHORT).show();
        final String range = mRangeId, from = mFrom, to = mTo;
        final Map<String, String> filters = new LinkedHashMap<>(mFilters);
        new Thread(() -> {
            JSONObject result = null;
            String error = null;
            try {
                result = HostApiClient.exportUsageCsv(this, range, from, to, filters);
            } catch (Throwable t) {
                error = message(t);
            }
            final JSONObject done = result;
            final String failure = error;
            mMain.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (done == null) {
                    Toast.makeText(this, t("导出失败：", "Export failed: ") + failure, Toast.LENGTH_LONG).show();
                    return;
                }
                mPendingExport = done;
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("text/csv");
                intent.putExtra(Intent.EXTRA_TITLE, UiChrome.jsonStr(done, "filename", "rokbot-usage.csv"));
                try {
                    startActivityForResult(intent, REQUEST_EXPORT);
                } catch (ActivityNotFoundException e) {
                    mPendingExport = null;
                    Toast.makeText(this, t("没有可用的文件保存应用", "No app can save files"), Toast.LENGTH_LONG).show();
                }
            });
        }, "rokbot-usage-export").start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_EXPORT) return;
        final JSONObject export = mPendingExport;
        mPendingExport = null;
        final Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        if (export == null || uri == null) return;
        new Thread(() -> {
            String error = null;
            try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new java.io.IOException("No output stream");
                out.write(export.optString("csv", "").getBytes(StandardCharsets.UTF_8));
            } catch (Throwable t) {
                error = message(t);
            }
            final String failure = error;
            final long count = export.optLong("count", 0);
            mMain.post(() -> {
                if (isFinishing() || isDestroyed()) return;
                Toast.makeText(this, failure == null
                        ? t("已导出 ", "Exported ") + UsageModel.formatExact(count) + t(" 条请求", count == 1 ? " request" : " requests")
                        : t("保存失败：", "Could not save: ") + failure, Toast.LENGTH_LONG).show();
            });
        }, "rokbot-usage-save").start();
    }
}

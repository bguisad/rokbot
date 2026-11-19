package dev.rokbot.nativeapp;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.text.NumberFormat;

public class UsageActivity extends Activity {
    private TextView mTotalTv;
    private TextView mDetailTv;
    private final Handler mMain = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        buildUi();
        reload();
    }

    private void buildUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(p.bgPaper);
        root.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 12), UiChrome.dp(this, 18), UiChrome.dp(this, 24));

        View refreshIcon = UiChrome.makeVectorIconButton(this, "refresh", "refresh_usage_button", p, v -> reload());
        root.addView(UiChrome.makeHeaderBar(this, Localize.t(this, "今日用量", "Today's Usage"), p, v -> finish(), refreshIcon));

        LinearLayout card = UiChrome.makeCard(this, p);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.topMargin = UiChrome.dp(this, 12);
        card.setLayoutParams(clp);
        card.setPadding(UiChrome.dp(this, 20), UiChrome.dp(this, 20), UiChrome.dp(this, 20), UiChrome.dp(this, 20));

        TextView subtitle = new TextView(this);
        subtitle.setText(Localize.t(this, "今日总消耗 Tokens", "Total Tokens Today"));
        subtitle.setTextColor(p.textSecondary);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        card.addView(subtitle);

        mTotalTv = new TextView(this);
        mTotalTv.setText(Localize.t(this, "正在统计…", "Loading…"));
        mTotalTv.setTextColor(p.textPrimary);
        mTotalTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        mTotalTv.setTypeface(Typeface.DEFAULT_BOLD);
        mTotalTv.setPadding(0, UiChrome.dp(this, 6), 0, 0);
        card.addView(mTotalTv);

        mDetailTv = new TextView(this);
        mDetailTv.setTextColor(p.textSecondary);
        mDetailTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mDetailTv.setLineSpacing(0f, 1.3f);
        mDetailTv.setPadding(0, UiChrome.dp(this, 12), 0, 0);
        card.addView(mDetailTv);

        root.addView(card);

        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, 14)));
        root.addView(spacer);

        root.addView(UiChrome.makePillButton(this, Localize.t(this, "刷新数据", "Refresh"), true, p, v -> reload()));

        setContentView(root);
        UiChrome.applyRootInsets(this, root);
    }

    private void reload() {
        new Thread(() -> {
            try {
                JSONObject u = HostApiClient.getUsage(this);
                long total = u.optLong("total", 0);
                long input = u.optLong("input", 0);
                long output = u.optLong("output", 0);
                NumberFormat nf = NumberFormat.getIntegerInstance();
                mMain.post(() -> {
                    mTotalTv.setText(nf.format(total) + " tokens");
                    mDetailTv.setText(
                            Localize.t(this, "输入 (Prompt): ", "Input: ") + nf.format(input) + "\n"
                            + Localize.t(this, "输出 (Completion): ", "Output: ") + nf.format(output)
                    );
                });
            } catch (Throwable t) {
                mMain.post(() -> mTotalTv.setText(Localize.t(this, "读取失败: ", "Error: ") + t.getMessage()));
            }
        }).start();
    }
}

package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

public class ComputersActivity extends Activity {
    private LinearLayout mContainer;
    private TextView mStatus;
    private View mRefreshButton;
    private boolean mLoading;
    private String mDefaultAgentId = "";
    private String mDefaultAgentName = "";
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
        root.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 10), UiChrome.dp(this, 16), UiChrome.dp(this, 16));

        mRefreshButton = UiChrome.makeVectorIconButton(this, "refresh", "refresh_computers_button", p, v -> reload());
        root.addView(UiChrome.makeHeaderBar(this, Localize.t(this, "Bot 电脑", "Bot Computers"), p, v -> finish(), mRefreshButton));

        mStatus = new TextView(this);
        mStatus.setText(Localize.t(this, "正在加载…", "Loading…"));
        mStatus.setTextColor(p.textSecondary);
        mStatus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mStatus.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 10));
        root.addView(mStatus);

        ScrollView scroll = new ScrollView(this);
        mContainer = new LinearLayout(this);
        mContainer.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(mContainer);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        UiChrome.applyRootInsets(this, root);
    }

    private void reload() {
        if (mLoading) return;
        mLoading = true;
        UiChrome.setIconButtonBusy(mRefreshButton, true);
        new Thread(() -> {
            try {
                JSONObject res = HostApiClient.getComputers(this);
                boolean available = res.optBoolean("available", false);
                JSONArray arr = res.optJSONArray("computers");
                try {
                    JSONArray agents = HostApiClient.listAgents(this);
                    RokBotAvatars.remember(this, agents);
                    if (agents.length() > 0) {
                        String preferredId = RokBotBootstrap.getViewingAgentId();
                        if (preferredId == null || preferredId.isEmpty()) {
                            preferredId = RokBotBootstrap.getLastAgentId();
                        }
                        JSONObject chosen = null;
                        if (preferredId != null && !preferredId.isEmpty()) {
                            for (int i = 0; i < agents.length(); i++) {
                                JSONObject candidate = agents.optJSONObject(i);
                                if (candidate != null && preferredId.equals(candidate.optString("id", ""))) {
                                    chosen = candidate;
                                    break;
                                }
                            }
                        }
                        if (chosen == null) {
                            chosen = agents.optJSONObject(0);
                        }
                        if (chosen != null) {
                            mDefaultAgentId = chosen.optString("id", "");
                            mDefaultAgentName = chosen.optString("name", mDefaultAgentId);
                        }
                    }
                } catch (Throwable ignored) {}

                mMain.post(() -> {
                    if (isDestroyed()) return;
                    mLoading = false;
                    UiChrome.setIconButtonBusy(mRefreshButton, false);
                    mContainer.removeAllViews();
                    mStatus.setText(available
                            ? Localize.t(this, "远程 Linux 桌面与已接入设备", "Remote Linux desktop & connected nodes")
                            : Localize.t(this, "Host 运行环境状态", "Host execution status"));

                    addCard(
                            Localize.t(this, "Linux 执行桌面", "Linux Execution Desktop"),
                            Localize.t(this, "由自建 Host 托管的隔离桌面 (noVNC)", "Managed by Host (Docker Box)"),
                            !mDefaultAgentId.isEmpty()
                    );
                    if (arr != null && arr.length() > 0) {
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject c = arr.optJSONObject(i);
                            if (c == null) continue;
                            String label = c.optString("label", "Computer");
                            boolean conn = c.optBoolean("connected", false);
                            String plat = c.optString("platform", "");
                            addCard(label,
                                    (conn ? Localize.t(this, "● 已连接", "● Connected")
                                          : Localize.t(this, "○ 未连接", "○ Disconnected"))
                                    + (plat.isEmpty() ? "" : " · " + plat),
                                    false);
                        }
                    } else {
                        addCard(
                                Localize.t(this, "我的电脑", "Your Computers"),
                                Localize.t(this, "当前未接入个人电脑节点", "No personal computers connected"),
                                false
                        );
                    }
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    if (isDestroyed()) return;
                    mLoading = false;
                    UiChrome.setIconButtonBusy(mRefreshButton, false);
                    String error = Localize.t(this, "读取失败：", "Error: ") + t.getMessage();
                    mStatus.setText(error);
                    Toast.makeText(this, error, Toast.LENGTH_SHORT).show();
                });
            }
        }).start();
    }

    private void addCard(String title, String sub, boolean showDesktopAction) {
        UiChrome.Palette p = UiChrome.palette(this);
        LinearLayout card = UiChrome.makeCard(this, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = UiChrome.dp(this, 10);
        card.setLayoutParams(lp);

        TextView t = new TextView(this);
        t.setText(title);
        t.setTextColor(p.textPrimary);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(t);

        TextView s = new TextView(this);
        s.setText(sub);
        s.setTextColor(p.textSecondary);
        s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        s.setPadding(0, UiChrome.dp(this, 4), 0, 0);
        card.addView(s);

        if (showDesktopAction) {
            TextView openBtn = UiChrome.makePillButton(this,
                    Localize.t(this, "打开交互式桌面 (VNC)", "Open Interactive Desktop"), true, p, v -> {
                        Intent i = new Intent(this, ComputerViewerActivity.class);
                        i.putExtra(ComputerViewerActivity.EXTRA_AGENT_ID, mDefaultAgentId);
                        i.putExtra(ComputerViewerActivity.EXTRA_AGENT_NAME, mDefaultAgentName);
                        startActivity(i);
                    });
            openBtn.setContentDescription("open_interactive_desktop_button");
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            blp.topMargin = UiChrome.dp(this, 12);
            openBtn.setLayoutParams(blp);
            card.addView(openBtn);
        }

        mContainer.addView(card);
    }
}

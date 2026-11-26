package dev.rokbot.nativeapp;

import android.app.Activity;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Native Create Group screen: lets the user pick member Bots and optionally set a name/description,
 * then calls POST /api/createGroup against the paired Host and opens the newly created group chat.
 */
public class CreateGroupActivity extends Activity {
    private static final String TITLE_ZH = "新建群组";
    private static final String TITLE_EN = "New Group";

    private final Handler mMain = new Handler(Looper.getMainLooper());
    private volatile boolean mDestroyed = false;

    private EditText mNameInput;
    private EditText mDescInput;
    private TextView mSelectedCountText;
    private LinearLayout mMembersContainer;
    private ProgressBar mProgress;
    private TextView mErrorText;
    private TextView mCreateBtn;

    private final List<JSONObject> mCandidateBots = new ArrayList<>();
    private final Set<String> mSelectedIds = new LinkedHashSet<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        Storage.init(this);
        buildUi();
        loadBots();
    }

    @Override
    protected void onDestroy() {
        mDestroyed = true;
        mMain.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void buildUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(p.bgPaper);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 12), UiChrome.dp(this, 18), UiChrome.dp(this, 24));
        scroll.addView(root);

        View refreshBtn = UiChrome.makeVectorIconButton(this, "refresh", "refresh_group_bots_button", p, v -> loadBots());
        root.addView(UiChrome.makeHeaderBar(this, Localize.t(this, TITLE_ZH, TITLE_EN), p, v -> finish(), refreshBtn));

        // Group details card
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "群组信息", "Group Details"), p));
        LinearLayout infoCard = UiChrome.makeCard(this, p);

        TextView nameLbl = new TextView(this);
        nameLbl.setText(Localize.t(this, "群组名称（可选）", "Group Name (Optional)"));
        nameLbl.setTextColor(p.textSecondary);
        nameLbl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        infoCard.addView(nameLbl);

        mNameInput = new EditText(this);
        mNameInput.setContentDescription("group_name_input");
        mNameInput.setHint(Localize.t(this, "留空则按成员自动命名", "Auto-named from members if blank"));
        mNameInput.setTextColor(p.textPrimary);
        mNameInput.setHintTextColor(p.textMuted);
        mNameInput.setSingleLine(true);
        infoCard.addView(mNameInput);

        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, 8)));
        infoCard.addView(spacer);

        TextView descLbl = new TextView(this);
        descLbl.setText(Localize.t(this, "群组说明（可选）", "Description (Optional)"));
        descLbl.setTextColor(p.textSecondary);
        descLbl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        infoCard.addView(descLbl);

        mDescInput = new EditText(this);
        mDescInput.setContentDescription("group_description_input");
        mDescInput.setHint(Localize.t(this, "描述群组协作目标或主题", "Describe what this group works on"));
        mDescInput.setTextColor(p.textPrimary);
        mDescInput.setHintTextColor(p.textMuted);
        mDescInput.setMaxLines(3);
        infoCard.addView(mDescInput);
        root.addView(infoCard);

        // Member selection header
        LinearLayout memHeader = new LinearLayout(this);
        memHeader.setOrientation(LinearLayout.HORIZONTAL);
        memHeader.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams mhLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mhLp.topMargin = UiChrome.dp(this, 16);
        mhLp.bottomMargin = UiChrome.dp(this, 6);
        memHeader.setLayoutParams(mhLp);

        TextView memSecTitle = new TextView(this);
        memSecTitle.setText(Localize.t(this, "选择成员 Bot", "Select Member Bots"));
        memSecTitle.setTextColor(p.textSecondary);
        memSecTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        memSecTitle.setTypeface(Typeface.DEFAULT_BOLD);
        memSecTitle.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        memHeader.addView(memSecTitle);

        mSelectedCountText = new TextView(this);
        mSelectedCountText.setContentDescription("group_selected_count");
        mSelectedCountText.setTextColor(p.blueAccent);
        mSelectedCountText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mSelectedCountText.setTypeface(Typeface.DEFAULT_BOLD);
        memHeader.addView(mSelectedCountText);
        root.addView(memHeader);

        mMembersContainer = new LinearLayout(this);
        mMembersContainer.setOrientation(LinearLayout.VERTICAL);
        root.addView(mMembersContainer);

        mProgress = new ProgressBar(this);
        mProgress.setVisibility(View.GONE);
        mProgress.setPadding(0, UiChrome.dp(this, 10), 0, 0);
        root.addView(mProgress);

        mErrorText = new TextView(this);
        mErrorText.setTextColor(p.danger);
        mErrorText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mErrorText.setPadding(0, UiChrome.dp(this, 8), 0, 0);
        mErrorText.setVisibility(View.GONE);
        root.addView(mErrorText);

        View btnSpacer = new View(this);
        btnSpacer.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, 16)));
        root.addView(btnSpacer);

        mCreateBtn = UiChrome.makePillButton(this, Localize.t(this, "创建群组", "Create Group"), true, p, v -> submitCreateGroup());
        mCreateBtn.setContentDescription("create_group_submit_button");
        root.addView(mCreateBtn);

        updateSelectionState();
        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
    }

    private void loadBots() {
        mProgress.setVisibility(View.VISIBLE);
        mErrorText.setVisibility(View.GONE);
        new Thread(() -> {
            try {
                JSONArray all = HostApiClient.listAgents(this);
                List<JSONObject> filtered = new ArrayList<>();
                if (all != null) {
                    for (int i = 0; i < all.length(); i++) {
                        JSONObject a = all.optJSONObject(i);
                        if (a == null) continue;
                        if (a.optBoolean("isGroup", false)) continue;
                        if (a.optBoolean("isHiddenFromSidebar", false)) continue;
                        String id = UiChrome.jsonStr(a, "id");
                        if (id.isEmpty()) continue;
                        filtered.add(a);
                    }
                }
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mProgress.setVisibility(View.GONE);
                    mCandidateBots.clear();
                    mCandidateBots.addAll(filtered);
                    // Drop any previously selected IDs no longer present.
                    Set<String> validIds = new LinkedHashSet<>();
                    for (JSONObject b : mCandidateBots) validIds.add(UiChrome.jsonStr(b, "id"));
                    mSelectedIds.retainAll(validIds);
                    renderMemberList();
                    updateSelectionState();
                });
            } catch (Throwable t) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mProgress.setVisibility(View.GONE);
                    mErrorText.setVisibility(View.VISIBLE);
                    mErrorText.setText(Localize.t(this, "加载 Bot 列表失败：", "Failed to load Bots: ") + t.getMessage());
                });
            }
        }, "CreateGroupLoadBots").start();
    }

    private void renderMemberList() {
        UiChrome.Palette p = UiChrome.palette(this);
        mMembersContainer.removeAllViews();
        if (mCandidateBots.isEmpty()) {
            LinearLayout empty = UiChrome.makeCard(this, p);
            TextView tv = new TextView(this);
            tv.setText(Localize.t(this, "暂无可选 Bot，请先创建至少一个 Bot。", "No Bots available. Create a Bot first."));
            tv.setTextColor(p.textMuted);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            empty.addView(tv);
            mMembersContainer.addView(empty);
            return;
        }
        for (JSONObject bot : mCandidateBots) {
            final String id = UiChrome.jsonStr(bot, "id");
            final String name = UiChrome.jsonStr(bot, "name", id);
            final String subtitle = !UiChrome.jsonStr(bot, "title").isEmpty()
                    ? UiChrome.jsonStr(bot, "title")
                    : UiChrome.jsonStr(bot, "description");

            LinearLayout card = UiChrome.makeCard(this, p);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = UiChrome.dp(this, 8);
            card.setLayoutParams(lp);
            card.setOrientation(LinearLayout.HORIZONTAL);
            card.setGravity(Gravity.CENTER_VERTICAL);
            card.setContentDescription("group_member_" + id);

            // Initial badge circle (vector-styled, no emoji)
            TextView avatar = new TextView(this);
            int sz = UiChrome.dp(this, 36);
            LinearLayout.LayoutParams avLp = new LinearLayout.LayoutParams(sz, sz);
            avLp.rightMargin = UiChrome.dp(this, 12);
            avatar.setLayoutParams(avLp);
            avatar.setGravity(Gravity.CENTER);
            avatar.setTextColor(p.accentText);
            avatar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            avatar.setTypeface(Typeface.DEFAULT_BOLD);
            avatar.setText(name.isEmpty() ? "B" : name.substring(0, 1).toUpperCase());
            GradientDrawable circle = new GradientDrawable();
            circle.setShape(GradientDrawable.OVAL);
            circle.setColor(p.accent);
            avatar.setBackground(circle);
            card.addView(avatar);

            LinearLayout textCol = new LinearLayout(this);
            textCol.setOrientation(LinearLayout.VERTICAL);
            textCol.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            TextView nameTv = new TextView(this);
            nameTv.setText(name);
            nameTv.setTextColor(p.textPrimary);
            nameTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            nameTv.setTypeface(Typeface.DEFAULT_BOLD);
            nameTv.setSingleLine(true);
            nameTv.setEllipsize(TextUtils.TruncateAt.END);
            textCol.addView(nameTv);

            if (!subtitle.isEmpty()) {
                TextView subTv = new TextView(this);
                subTv.setText(subtitle);
                subTv.setTextColor(p.textSecondary);
                subTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                subTv.setSingleLine(true);
                subTv.setEllipsize(TextUtils.TruncateAt.END);
                subTv.setPadding(0, UiChrome.dp(this, 2), 0, 0);
                textCol.addView(subTv);
            }
            card.addView(textCol);

            CheckBox cb = new CheckBox(this);
            cb.setChecked(mSelectedIds.contains(id));
            cb.setClickable(false);
            cb.setFocusable(false);
            card.addView(cb);

            card.setOnClickListener(v -> {
                if (mSelectedIds.contains(id)) {
                    mSelectedIds.remove(id);
                    cb.setChecked(false);
                } else {
                    mSelectedIds.add(id);
                    cb.setChecked(true);
                }
                updateSelectionState();
            });
            mMembersContainer.addView(card);
        }
    }

    private void updateSelectionState() {
        int count = mSelectedIds.size();
        mSelectedCountText.setText(Localize.t(this, "已选 " + count + " 个", count + " selected"));
        boolean ready = count > 0;
        mCreateBtn.setEnabled(ready);
        mCreateBtn.setAlpha(ready ? 1f : 0.45f);
    }

    private void submitCreateGroup() {
        if (mSelectedIds.isEmpty()) {
            Toast.makeText(this, Localize.t(this, "请至少选择一个成员 Bot", "Select at least one member Bot"), Toast.LENGTH_SHORT).show();
            return;
        }
        String name = mNameInput.getText() != null ? mNameInput.getText().toString().trim() : "";
        String desc = mDescInput.getText() != null ? mDescInput.getText().toString().trim() : "";
        List<String> members = new ArrayList<>(mSelectedIds);

        mCreateBtn.setEnabled(false);
        mProgress.setVisibility(View.VISIBLE);
        mErrorText.setVisibility(View.GONE);

        new Thread(() -> {
            try {
                JSONObject res = HostApiClient.createGroup(this, name, desc, members);
                JSONObject agent = res != null ? res.optJSONObject("agent") : null;
                String newId = agent != null ? UiChrome.jsonStr(agent, "id") : UiChrome.jsonStr(res, "id");
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mProgress.setVisibility(View.GONE);
                    Toast.makeText(this, Localize.t(this, "群组已创建", "Group created"), Toast.LENGTH_SHORT).show();
                    if (!newId.isEmpty()) {
                        RokBotBootstrap.openAgentFromDeepLink(this, Uri.parse("grokbot://app/v1/chat?id=" + newId));
                    }
                    finish();
                });
            } catch (Throwable t) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mProgress.setVisibility(View.GONE);
                    mCreateBtn.setEnabled(!mSelectedIds.isEmpty());
                    mErrorText.setVisibility(View.VISIBLE);
                    mErrorText.setText(Localize.t(this, "创建群组失败：", "Failed to create group: ") + t.getMessage());
                });
            }
        }, "CreateGroupSubmit").start();
    }
}

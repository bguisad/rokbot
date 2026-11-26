package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
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

    private UiChrome.Palette mPalette;
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
        mPalette = p;

        LinearLayout outer = new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setBackgroundColor(p.bgPaper);

        View refreshBtn = UiChrome.makeVectorIconButton(this, "refresh", "refresh_group_bots_button", p, v -> loadBots());
        LinearLayout header = UiChrome.makeHeaderBar(this, Localize.t(this, TITLE_ZH, TITLE_EN), p, v -> finish(), refreshBtn);
        header.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 10), UiChrome.dp(this, 18), UiChrome.dp(this, 10));
        outer.addView(header);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 4), UiChrome.dp(this, 18), UiChrome.dp(this, 20));
        scroll.addView(content);

        // Group details card
        TextView detailsSec = UiChrome.makeSectionLabel(this, Localize.t(this, "群组信息", "Group Details"), p);
        LinearLayout.LayoutParams dslp = (LinearLayout.LayoutParams) detailsSec.getLayoutParams();
        dslp.topMargin = UiChrome.dp(this, 8);
        detailsSec.setLayoutParams(dslp);
        content.addView(detailsSec);

        LinearLayout infoCard = UiChrome.makeCard(this, p);
        infoCard.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 16), UiChrome.dp(this, 16), UiChrome.dp(this, 16));

        TextView nameLbl = new TextView(this);
        nameLbl.setText(Localize.t(this, "群组名称（可选）", "Group Name (Optional)"));
        nameLbl.setTextColor(p.textSecondary);
        nameLbl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        nameLbl.setTypeface(Typeface.DEFAULT_BOLD);
        nameLbl.setPadding(UiChrome.dp(this, 2), 0, 0, UiChrome.dp(this, 6));
        infoCard.addView(nameLbl);

        mNameInput = new EditText(this);
        mNameInput.setContentDescription("group_name_input");
        mNameInput.setHint(Localize.t(this, "留空则按成员自动命名", "Auto-named from members if blank"));
        mNameInput.setSingleLine(true);
        UiChrome.styleEditText(mNameInput, p, this);
        infoCard.addView(mNameInput);

        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, 14)));
        infoCard.addView(spacer);

        TextView descLbl = new TextView(this);
        descLbl.setText(Localize.t(this, "群组说明（可选）", "Description (Optional)"));
        descLbl.setTextColor(p.textSecondary);
        descLbl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        descLbl.setTypeface(Typeface.DEFAULT_BOLD);
        descLbl.setPadding(UiChrome.dp(this, 2), 0, 0, UiChrome.dp(this, 6));
        infoCard.addView(descLbl);

        mDescInput = new EditText(this);
        mDescInput.setContentDescription("group_description_input");
        mDescInput.setHint(Localize.t(this, "描述群组协作目标或主题", "Describe what this group works on"));
        mDescInput.setMinLines(2);
        mDescInput.setMaxLines(4);
        mDescInput.setGravity(Gravity.TOP | Gravity.START);
        UiChrome.styleEditText(mDescInput, p, this);
        infoCard.addView(mDescInput);
        content.addView(infoCard);

        // Member selection header
        LinearLayout memHeader = new LinearLayout(this);
        memHeader.setOrientation(LinearLayout.HORIZONTAL);
        memHeader.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams mhLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mhLp.topMargin = UiChrome.dp(this, 18);
        mhLp.bottomMargin = UiChrome.dp(this, 8);
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
        mSelectedCountText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mSelectedCountText.setTypeface(Typeface.DEFAULT_BOLD);
        mSelectedCountText.setPadding(UiChrome.dp(this, 10), UiChrome.dp(this, 3), UiChrome.dp(this, 10), UiChrome.dp(this, 3));
        memHeader.addView(mSelectedCountText);
        content.addView(memHeader);

        mMembersContainer = new LinearLayout(this);
        mMembersContainer.setOrientation(LinearLayout.VERTICAL);
        content.addView(mMembersContainer);

        mProgress = new ProgressBar(this);
        mProgress.setVisibility(View.GONE);
        LinearLayout.LayoutParams progLp = new LinearLayout.LayoutParams(
                UiChrome.dp(this, 28), UiChrome.dp(this, 28));
        progLp.gravity = Gravity.CENTER_HORIZONTAL;
        progLp.topMargin = UiChrome.dp(this, 14);
        mProgress.setLayoutParams(progLp);
        content.addView(mProgress);

        mErrorText = new TextView(this);
        mErrorText.setTextColor(p.danger);
        mErrorText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mErrorText.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 10), UiChrome.dp(this, 4), 0);
        mErrorText.setVisibility(View.GONE);
        content.addView(mErrorText);

        outer.addView(scroll);

        // Pinned bottom primary action bar
        LinearLayout footer = new LinearLayout(this);
        footer.setOrientation(LinearLayout.VERTICAL);
        footer.setBackgroundColor(p.bgPaper);
        footer.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 10), UiChrome.dp(this, 18), UiChrome.dp(this, 16));

        mCreateBtn = makePrimaryButton(this, Localize.t(this, "创建群组", "Create Group"), p, v -> submitCreateGroup());
        mCreateBtn.setContentDescription("create_group_submit_button");
        footer.addView(mCreateBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        outer.addView(footer);

        updateSelectionState();
        setContentView(outer);
        UiChrome.applyRootInsets(this, outer);
    }

    private static TextView makePrimaryButton(Context ctx, String text, UiChrome.Palette p, View.OnClickListener onClick) {
        TextView btn = new TextView(ctx);
        btn.setText(text);
        btn.setTextColor(p.accentText);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setGravity(Gravity.CENTER);
        btn.setMinimumHeight(UiChrome.dp(ctx, 50));
        btn.setPadding(UiChrome.dp(ctx, 20), UiChrome.dp(ctx, 13), UiChrome.dp(ctx, 20), UiChrome.dp(ctx, 13));
        GradientDrawable fill = UiChrome.roundRect(p.accent, UiChrome.dp(ctx, 25), 0, 0);
        GradientDrawable mask = UiChrome.roundRect(0xFFFFFFFF, UiChrome.dp(ctx, 25), 0, 0);
        int rippleColor = (p.accentText & 0x00FFFFFF) | 0x26000000;
        btn.setBackground(new RippleDrawable(ColorStateList.valueOf(rippleColor), fill, mask));
        btn.setOnClickListener(onClick);
        return btn;
    }

    private void loadBots() {
        mProgress.setVisibility(View.VISIBLE);
        mErrorText.setVisibility(View.GONE);
        new Thread(() -> {
            try {
                JSONArray all = HostApiClient.listAgents(this);
                RokBotAvatars.remember(this, all);
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
        UiChrome.Palette p = mPalette != null ? mPalette : UiChrome.palette(this);
        mMembersContainer.removeAllViews();
        if (mCandidateBots.isEmpty()) {
            LinearLayout empty = UiChrome.makeCard(this, p);
            TextView tv = new TextView(this);
            tv.setText(Localize.t(this, "暂无可选 Bot，请先创建至少一个 Bot。", "No Bots available. Create a Bot first."));
            tv.setTextColor(p.textMuted);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
            empty.addView(tv);
            mMembersContainer.addView(empty);
            return;
        }

        LinearLayout group = UiChrome.makeRowGroup(this, p);
        for (int i = 0; i < mCandidateBots.size(); i++) {
            if (i > 0) {
                View divider = new View(this);
                LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, UiChrome.dp(this, 0.7f)));
                dlp.leftMargin = UiChrome.dp(this, 70);
                divider.setLayoutParams(dlp);
                divider.setBackgroundColor(p.border);
                group.addView(divider);
            }

            JSONObject bot = mCandidateBots.get(i);
            final String id = UiChrome.jsonStr(bot, "id");
            final String name = UiChrome.jsonStr(bot, "name", id);
            final String subtitle = !UiChrome.jsonStr(bot, "title").isEmpty()
                    ? UiChrome.jsonStr(bot, "title")
                    : UiChrome.jsonStr(bot, "description");

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setMinimumHeight(UiChrome.dp(this, 66));
            row.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 11), UiChrome.dp(this, 16), UiChrome.dp(this, 11));
            row.setContentDescription("group_member_" + id);
            row.setClickable(true);
            row.setFocusable(true);
            row.setBackground(new RippleDrawable(
                    ColorStateList.valueOf((p.textPrimary & 0x00FFFFFF) | 0x1A000000),
                    null,
                    new ColorDrawable(0xFFFFFFFF)));

            // Use the Bot's real RokBot avatar matching the home list and Share sheet
            View avatarView = RokBotAvatars.makeView(this, RokBotAvatars.lookOf(bot), 40, p);
            LinearLayout.LayoutParams avLp = new LinearLayout.LayoutParams(UiChrome.dp(this, 40), UiChrome.dp(this, 40));
            avLp.rightMargin = UiChrome.dp(this, 14);
            row.addView(avatarView, avLp);

            LinearLayout textCol = new LinearLayout(this);
            textCol.setOrientation(LinearLayout.VERTICAL);
            textCol.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            TextView nameTv = new TextView(this);
            nameTv.setText(name);
            nameTv.setTextColor(p.textPrimary);
            nameTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f);
            nameTv.setTypeface(Typeface.DEFAULT_BOLD);
            nameTv.setSingleLine(true);
            nameTv.setEllipsize(TextUtils.TruncateAt.END);
            textCol.addView(nameTv);

            if (!subtitle.isEmpty()) {
                TextView subTv = new TextView(this);
                subTv.setText(subtitle);
                subTv.setTextColor(p.textSecondary);
                subTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
                subTv.setSingleLine(true);
                subTv.setEllipsize(TextUtils.TruncateAt.END);
                subTv.setPadding(0, UiChrome.dp(this, 2), 0, 0);
                textCol.addView(subTv);
            }
            row.addView(textCol);

            // Crisp monochrome circular check badge (no system teal CheckBox)
            final CheckBadgeDrawable badge = new CheckBadgeDrawable(
                    p.accent, p.accentText, p.dark ? 0xFF4B4B55 : 0xFFC7C7CC, UiChrome.dp(this, 1.8f));
            badge.setChecked(mSelectedIds.contains(id));
            View checkView = new View(this);
            int cbSize = UiChrome.dp(this, 24);
            LinearLayout.LayoutParams cblp = new LinearLayout.LayoutParams(cbSize, cbSize);
            cblp.leftMargin = UiChrome.dp(this, 12);
            checkView.setLayoutParams(cblp);
            checkView.setBackground(badge);
            row.addView(checkView);

            row.setOnClickListener(v -> {
                boolean next = !mSelectedIds.contains(id);
                if (next) {
                    mSelectedIds.add(id);
                } else {
                    mSelectedIds.remove(id);
                }
                badge.setChecked(next);
                updateSelectionState();
            });
            group.addView(row);
        }
        mMembersContainer.addView(group);
    }

    private void updateSelectionState() {
        UiChrome.Palette p = mPalette != null ? mPalette : UiChrome.palette(this);
        int count = mSelectedIds.size();
        boolean ready = count > 0;
        mSelectedCountText.setText(Localize.t(this, "已选 " + count + " 个", count + " selected"));
        mSelectedCountText.setTextColor(ready ? p.textPrimary : p.textMuted);
        mSelectedCountText.setBackground(UiChrome.roundRect(
                p.bgSurface2, UiChrome.dp(this, 11), ready ? p.border : 0, ready ? Math.max(1, UiChrome.dp(this, 0.8f)) : 0));
        mCreateBtn.setEnabled(ready);
        mCreateBtn.setAlpha(ready ? 1f : 0.42f);
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
        mCreateBtn.setAlpha(0.6f);
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
                    final android.content.Context appCtx = getApplicationContext();
                    finish();
                    if (!newId.isEmpty()) {
                        new Handler(Looper.getMainLooper()).postDelayed(() ->
                                RokBotBootstrap.openAgentFromDeepLink(appCtx, Uri.parse("grokbot://app/v1/chat?id=" + newId)), 550L);
                    }
                });
            } catch (Throwable t) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mProgress.setVisibility(View.GONE);
                    updateSelectionState();
                    mErrorText.setVisibility(View.VISIBLE);
                    mErrorText.setText(Localize.t(this, "创建群组失败：", "Failed to create group: ") + t.getMessage());
                });
            }
        }, "CreateGroupSubmit").start();
    }

    /** Crisp monochrome circular checkbox drawn as vector paths (no default system CheckBox tint). */
    private static final class CheckBadgeDrawable extends Drawable {
        private final Paint mFillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint mRingPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint mCheckPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path mCheckPath = new Path();
        private boolean mChecked = false;

        CheckBadgeDrawable(int fillColor, int checkColor, int ringColor, float strokePx) {
            mFillPaint.setColor(fillColor);
            mFillPaint.setStyle(Paint.Style.FILL);

            mRingPaint.setColor(ringColor);
            mRingPaint.setStyle(Paint.Style.STROKE);
            mRingPaint.setStrokeWidth(strokePx);

            mCheckPaint.setColor(checkColor);
            mCheckPaint.setStyle(Paint.Style.STROKE);
            mCheckPaint.setStrokeWidth(strokePx * 1.15f);
            mCheckPaint.setStrokeCap(Paint.Cap.ROUND);
            mCheckPaint.setStrokeJoin(Paint.Join.ROUND);
        }

        void setChecked(boolean checked) {
            if (mChecked != checked) {
                mChecked = checked;
                invalidateSelf();
            }
        }

        @Override
        public void draw(Canvas canvas) {
            android.graphics.Rect b = getBounds();
            float w = b.width();
            float h = b.height();
            if (w <= 0f || h <= 0f) return;
            float cx = b.exactCenterX();
            float cy = b.exactCenterY();
            float r = Math.min(w, h) * 0.5f - mRingPaint.getStrokeWidth() * 0.6f;

            if (mChecked) {
                canvas.drawCircle(cx, cy, r + mRingPaint.getStrokeWidth() * 0.35f, mFillPaint);
                mCheckPath.reset();
                mCheckPath.moveTo(cx - r * 0.42f, cy + r * 0.02f);
                mCheckPath.lineTo(cx - r * 0.12f, cy + r * 0.34f);
                mCheckPath.lineTo(cx + r * 0.45f, cy - r * 0.28f);
                canvas.drawPath(mCheckPath, mCheckPaint);
            } else {
                canvas.drawCircle(cx, cy, r, mRingPaint);
            }
        }

        @Override public void setAlpha(int alpha) {
            mFillPaint.setAlpha(alpha);
            mRingPaint.setAlpha(alpha);
            mCheckPaint.setAlpha(alpha);
        }
        @Override public void setColorFilter(ColorFilter cf) {
            mFillPaint.setColorFilter(cf);
            mRingPaint.setColorFilter(cf);
            mCheckPaint.setColorFilter(cf);
        }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }
}

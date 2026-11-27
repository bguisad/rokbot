package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * "Migrate from Grok Bot" on Android: copy the migration prompt (with a one-time upload URL),
 * manage upload URLs, review pending packages and confirm the import. Physical migration of a
 * Grok Bot data folder is offered by the desktop clients and the Host web page only.
 * No emoji; choices use the RokBot ChoiceField sheet rather than platform drop-downs.
 */
public class MigrateActivity extends Activity {
    static final String TITLE_ZH = "从 Grok Bot 迁移";
    static final String TITLE_EN = "Migrate from Grok Bot";
    private static final String[] POLICY_KEYS = {"rename", "skip", "overwrite"};

    private final Handler mMain = new Handler(Looper.getMainLooper());
    private final ExecutorService mIo = Executors.newSingleThreadExecutor(r -> new Thread(r, "rokbot-migrate"));
    private volatile boolean mDestroyed = false;
    private UiChrome.Palette mPalette;
    private LinearLayout mTokens;
    private LinearLayout mPackages;
    private LinearLayout mReview;
    private TextView mStatus;
    private String mScope = "single";

    private interface Work { Object run() throws Exception; }
    private interface Done { void accept(Object value); }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        buildUi();
        refresh();
    }

    @Override
    protected void onDestroy() {
        mDestroyed = true;
        mMain.removeCallbacksAndMessages(null);
        mIo.shutdownNow();
        super.onDestroy();
    }

    private String t(String zh, String en) { return Localize.t(this, zh, en); }

    private void async(Work work, Done done) {
        mIo.execute(() -> {
            try {
                Object value = work.run();
                mMain.post(() -> { if (!mDestroyed) done.accept(value); });
            } catch (Exception error) {
                mMain.post(() -> {
                    if (mDestroyed) return;
                    String message = error.getMessage() != null ? error.getMessage() : t("操作失败，请重试", "Something went wrong. Try again.");
                    mStatus.setText(message);
                    mStatus.setVisibility(View.VISIBLE);
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setLineSpacing(0, 1.15f);
        return view;
    }

    private LinearLayout row() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        int pad = UiChrome.dp(this, 14);
        row.setPadding(UiChrome.dp(this, 16), pad, UiChrome.dp(this, 16), pad);
        return row;
    }

    private LinearLayout buttons() {
        LinearLayout line = new LinearLayout(this);
        line.setOrientation(LinearLayout.HORIZONTAL);
        line.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = UiChrome.dp(this, 10);
        line.setLayoutParams(lp);
        return line;
    }

    private TextView pill(String label, boolean primary, View.OnClickListener onClick) {
        TextView button = UiChrome.makePillButton(this, label, primary, mPalette, onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = UiChrome.dp(this, 8);
        button.setLayoutParams(lp);
        return button;
    }

    private void buildUi() {
        mPalette = UiChrome.palette(this);
        UiChrome.Palette p = mPalette;
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(p.bgPaper);
        scroll.setFillViewport(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 12), UiChrome.dp(this, 18), UiChrome.dp(this, 28));
        scroll.addView(root);

        View header = UiChrome.makeHeaderBar(this, t(TITLE_ZH, TITLE_EN), p, v -> finish());
        header.setContentDescription("migrate_title");
        root.addView(header);

        mStatus = text("", 12, p.danger, false);
        mStatus.setVisibility(View.GONE);
        root.addView(mStatus);

        TextView intro = text(t("把迁移 prompt 发给 Grok Bot 里的 Bot，它会把档案、记忆、技能、例程和参考资料整理成文件上传到你的 Host。"
                + "上传后在下方「待导入」中预览并确认导入。读取电脑上的 Grok Bot 数据目录请使用桌面客户端或 Host 网页。",
                "Send the migration prompt to your Grok Bot Bots. They upload their profile, memories, skills, routines and files to your Host; review and import them below. "
                + "To read a Grok Bot data folder on a computer, use the desktop client or the Host web page."), 13, p.textSecondary, false);
        intro.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 6), UiChrome.dp(this, 4), UiChrome.dp(this, 4));
        root.addView(intro);

        root.addView(UiChrome.makeSectionLabel(this, t("迁移 prompt", "Migration prompt"), p));
        LinearLayout promptCard = UiChrome.makeRowGroup(this, p);
        LinearLayout promptRow = row();
        promptRow.addView(text(t("导出范围", "Scope"), 13, p.textSecondary, false));
        ChoiceField scope = new ChoiceField(this);
        scope.setTitle(t("导出范围", "Scope"));
        scope.setOptions(new String[]{t("当前 Bot", "This Bot"), t("所有 Bot（发给总管 Bot）", "All Bots (for a coordinating Bot)")});
        scope.setSelection(0);
        scope.setOnChoiceListener(position -> mScope = position == 1 ? "all" : "single");
        scope.setContentDescription("migrate_scope_choice");
        promptRow.addView(scope);
        LinearLayout actions = buttons();
        TextView create = pill(t("生成上传地址并复制", "Create URL & copy"), true, v -> async(
                () -> HostApiClient.migrateCreateToken(this, mScope.equals("all") ? t("所有 Bot", "All Bots") : t("单个 Bot", "One Bot"), mScope),
                value -> { copy(((JSONObject) value).optString("prompt")); refresh(); }));
        create.setContentDescription("migrate_copy_prompt");
        actions.addView(create);
        actions.addView(pill(t("只复制 prompt", "Copy prompt only"), false, v -> async(
                () -> HostApiClient.migratePrompt(this, null, mScope), value -> copy(((JSONObject) value).optString("prompt")))));
        promptRow.addView(actions);
        TextView note = text(t("上传地址 24 小时内有效、可多次上传、可随时撤销。Bot 无法访问地址时，会把文件发给你，再到 Host 网页上传。",
                "Upload URLs last 24 hours, accept several uploads and can be revoked. If a Bot cannot reach the URL it sends you the file to upload on the Host web page."), 12, p.textMuted, false);
        note.setPadding(0, UiChrome.dp(this, 10), 0, 0);
        promptRow.addView(note);
        promptCard.addView(promptRow);
        root.addView(promptCard);

        root.addView(UiChrome.makeSectionLabel(this, t("上传地址", "Upload URLs"), p));
        mTokens = UiChrome.makeRowGroup(this, p);
        root.addView(mTokens);

        root.addView(UiChrome.makeSectionLabel(this, t("待导入", "Pending"), p));
        mPackages = UiChrome.makeRowGroup(this, p);
        mPackages.setContentDescription("migrate_pending_list");
        root.addView(mPackages);

        mReview = new LinearLayout(this);
        mReview.setOrientation(LinearLayout.VERTICAL);
        root.addView(mReview);

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
    }

    private void copy(String value) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText(t("迁移 prompt", "Migration prompt"), value));
        Toast.makeText(this, t("已复制迁移 prompt，发给 Grok Bot 即可", "Migration prompt copied"), Toast.LENGTH_SHORT).show();
    }

    private static String when(long ms) {
        return ms > 0 ? new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(new Date(ms)) : "";
    }

    private String counts(JSONObject counts) {
        if (counts == null) return "";
        List<String> parts = new ArrayList<>();
        String[][] keys = {{"bots", "个 Bot", " Bots"}, {"memory", "条记忆", " memories"}, {"skills", "个技能", " skills"},
                {"routines", "个例程", " routines"}, {"files", "个文件", " files"}, {"chatMessages", "条聊天记录", " messages"}};
        for (String[] key : keys) {
            int value = counts.optInt(key[0]);
            if (value > 0) parts.add(value + t(" " + key[1], key[2]));
        }
        return parts.isEmpty() ? t("没有可导入的内容", "Nothing to import") : String.join(" · ", parts);
    }

    private void refresh() {
        async(() -> HostApiClient.migrateOverview(this), value -> {
            mStatus.setVisibility(View.GONE);
            JSONObject overview = (JSONObject) value;
            renderTokens(overview.optJSONArray("tokens"));
            renderPackages(overview.optJSONArray("packages"));
        });
    }

    private void renderTokens(JSONArray tokens) {
        UiChrome.Palette p = mPalette;
        mTokens.removeAllViews();
        int shown = 0;
        for (int i = 0; tokens != null && i < tokens.length() && shown < 6; i++, shown++) {
            JSONObject token = tokens.optJSONObject(i);
            if (token == null) continue;
            if (shown > 0) mTokens.addView(UiChrome.makeRowDivider(this, p));
            boolean active = token.optBoolean("active");
            LinearLayout item = row();
            item.addView(text(token.optString("label") + "  ·  " + (active ? t("有效", "Active") : token.isNull("revokedAt") ? t("已过期", "Expired") : t("已撤销", "Revoked")), 15, active ? p.textPrimary : p.textMuted, true));
            item.addView(text((active ? t("有效期至 ", "Expires ") + when(token.optLong("expiresAt")) : t("创建于 ", "Created ") + when(token.optLong("createdAt")))
                    + t(" · 已上传 ", " · uploads: ") + token.optInt("uploads"), 12, p.textMuted, false));
            if (active) {
                String id = token.optString("id");
                LinearLayout line = buttons();
                line.addView(pill(t("复制 prompt", "Copy prompt"), false, v -> async(() -> HostApiClient.migratePrompt(this, id, mScope),
                        result -> copy(((JSONObject) result).optString("prompt")))));
                TextView revoke = pill(t("撤销", "Revoke"), false, v -> async(() -> HostApiClient.migrateRevokeToken(this, id), result -> refresh()));
                revoke.setTextColor(p.danger);
                line.addView(revoke);
                item.addView(line);
            }
            mTokens.addView(item);
        }
        if (shown == 0) {
            LinearLayout empty = row();
            empty.addView(text(t("还没有上传地址。", "No upload URLs yet."), 13, p.textMuted, false));
            mTokens.addView(empty);
        }
    }

    private void renderPackages(JSONArray packages) {
        UiChrome.Palette p = mPalette;
        mPackages.removeAllViews();
        int count = packages != null ? packages.length() : 0;
        for (int i = 0; i < count; i++) {
            JSONObject item = packages.optJSONObject(i);
            if (item == null) continue;
            if (i > 0) mPackages.addView(UiChrome.makeRowDivider(this, p));
            String source = item.optString("source");
            String sourceLabel = "inbox".equals(source) ? t("Bot 上传", "From a Bot") : "device".equals(source) ? t("桌面端", "Desktop") : t("网页上传", "Web upload");
            boolean imported = "imported".equals(item.optString("status"));
            LinearLayout rowView = row();
            rowView.addView(text(item.optString("label"), 15, p.textPrimary, true));
            rowView.addView(text(sourceLabel + " · " + (imported ? t("已导入", "Imported") : t("待导入", "Pending")) + " · " + when(item.optLong("createdAt")), 12, p.textMuted, false));
            rowView.addView(text(counts(item.optJSONObject("counts")), 12, p.textSecondary, false));
            String id = item.optString("id");
            LinearLayout line = buttons();
            TextView open = pill(imported ? t("再次导入", "Import again") : t("预览并导入", "Review"), !imported,
                    v -> async(() -> HostApiClient.migratePreview(this, id), value -> renderReview((JSONObject) value)));
            open.setContentDescription("migrate_review_" + i);
            line.addView(open);
            TextView remove = pill(t("删除", "Delete"), false, v -> async(() -> HostApiClient.migrateDiscard(this, id), value -> { mReview.removeAllViews(); refresh(); }));
            remove.setTextColor(p.danger);
            line.addView(remove);
            rowView.addView(line);
            mPackages.addView(rowView);
        }
        if (count == 0) {
            LinearLayout empty = row();
            empty.addView(text(t("暂无待导入的迁移包。", "Nothing waiting to be imported."), 13, p.textMuted, false));
            mPackages.addView(empty);
        }
    }

    private void renderReview(JSONObject preview) {
        UiChrome.Palette p = mPalette;
        mReview.removeAllViews();
        mReview.addView(UiChrome.makeSectionLabel(this, t("预览：", "Review: ") + preview.optString("label"), p));
        LinearLayout card = UiChrome.makeRowGroup(this, p);
        card.setContentDescription("migrate_review");
        Map<String, CheckBox> bots = new LinkedHashMap<>();
        Map<String, ChoiceField> policies = new LinkedHashMap<>();
        JSONArray list = preview.optJSONArray("bots");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject bot = list.optJSONObject(i);
            if (bot == null) continue;
            if (i > 0) card.addView(UiChrome.makeRowDivider(this, p));
            LinearLayout item = row();
            CheckBox check = new CheckBox(this);
            check.setChecked(true);
            check.setText(bot.optString("name"));
            check.setTextColor(p.textPrimary);
            check.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            check.setButtonTintList(android.content.res.ColorStateList.valueOf(p.accent));
            item.addView(check);
            String status = bot.optString("status");
            JSONObject c = bot.optJSONObject("counts");
            String detail = ("imported".equals(status) ? t("已迁移过，将补充新增内容", "Imported before; adds new items only")
                    : "conflict".equals(status) ? t("已有同名 Bot", "A Bot with this name exists") : t("新建", "New"))
                    + (c != null ? " · " + t("记忆 ", "memories ") + c.optInt("memory") + " · " + t("技能 ", "skills ") + c.optInt("skills")
                    + " · " + t("例程 ", "routines ") + c.optInt("routines") : "");
            item.addView(text(detail, 12, p.textMuted, false));
            if ("conflict".equals(status)) {
                ChoiceField policy = new ChoiceField(this);
                policy.setTitle(t("同名 Bot 的处理方式", "Same-name Bot"));
                policy.setOptions(new String[]{t("重命名为「", "Rename to \"") + bot.optString("renameTo") + t("」", "\""),
                        t("跳过", "Skip"), t("覆盖现有 Bot", "Merge into the existing Bot")});
                policy.setSelection(0);
                item.addView(policy);
                policies.put(bot.optString("key"), policy);
            }
            bots.put(bot.optString("key"), check);
            card.addView(item);
        }
        CheckBox chat = new CheckBox(this);
        chat.setText(t("同时导入聊天记录（保存为资料库文件）", "Also import chat history (as library files)"));
        chat.setTextColor(p.textPrimary);
        chat.setButtonTintList(android.content.res.ColorStateList.valueOf(p.accent));
        LinearLayout options = row();
        options.addView(chat);
        JSONArray secrets = preview.optJSONArray("secrets");
        List<String> names = new ArrayList<>();
        for (int i = 0; secrets != null && i < secrets.length(); i++) names.add(secrets.optJSONObject(i) != null ? secrets.optJSONObject(i).optString("name") : "");
        if (!names.isEmpty()) options.addView(text(t("需要重新填写：", "Re-enter after import: ") + String.join("、", names), 12, p.warning, false));
        options.addView(text(t("导入的内容只作为数据保存，不会执行其中的指令；例程导入后全部暂停，需要手动启用。",
                "Imported content is stored as data and never run; routines arrive paused."), 12, p.textMuted, false));
        LinearLayout line = buttons();
        TextView confirm = pill(t("确认导入", "Import"), true, v -> {
            try {
                JSONObject selection = new JSONObject();
                JSONObject chosen = new JSONObject();
                for (Map.Entry<String, CheckBox> entry : bots.entrySet()) {
                    JSONObject one = new JSONObject();
                    one.put("include", entry.getValue().isChecked());
                    one.put("chat", chat.isChecked());
                    ChoiceField policy = policies.get(entry.getKey());
                    one.put("conflict", POLICY_KEYS[policy != null ? Math.max(0, policy.getSelectedItemPosition()) : 0]);
                    chosen.put(entry.getKey(), one);
                }
                selection.put("bots", chosen);
                String id = preview.optString("id");
                async(() -> HostApiClient.migrateImport(this, id, selection), value -> { renderReport((JSONObject) value); refresh(); });
            } catch (Exception ignored) {
            }
        });
        confirm.setContentDescription("migrate_confirm_import");
        line.addView(confirm);
        line.addView(pill(t("取消", "Cancel"), false, v -> mReview.removeAllViews()));
        options.addView(line);
        card.addView(UiChrome.makeRowDivider(this, p));
        card.addView(options);
        mReview.addView(card);
    }

    private void renderReport(JSONObject report) {
        UiChrome.Palette p = mPalette;
        mReview.removeAllViews();
        mReview.addView(UiChrome.makeSectionLabel(this, t("导入结果", "Result"), p));
        LinearLayout card = UiChrome.makeRowGroup(this, p);
        card.setContentDescription("migrate_report");
        JSONArray list = report.optJSONArray("bots");
        Map<String, String> actions = new LinkedHashMap<>();
        actions.put("created", t("已新建", "Created"));
        actions.put("updated", t("已更新", "Updated"));
        actions.put("overwritten", t("已覆盖同名 Bot", "Merged"));
        actions.put("skipped", t("已跳过", "Skipped"));
        actions.put("failed", t("失败", "Failed"));
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject bot = list.optJSONObject(i);
            if (bot == null) continue;
            if (i > 0) card.addView(UiChrome.makeRowDivider(this, p));
            LinearLayout item = row();
            String target = bot.optString("targetName", "");
            item.addView(text(bot.optString("name") + (target.isEmpty() || target.equals(bot.optString("name")) ? "" : " -> " + target), 15, p.textPrimary, true));
            JSONObject added = bot.optJSONObject("added");
            String action = actions.containsKey(bot.optString("action")) ? actions.get(bot.optString("action")) : bot.optString("action");
            item.addView(text(action + (added != null ? " · " + t("记忆 +", "memories +") + added.optInt("memory") + " · " + t("技能 +", "skills +")
                    + added.optInt("skills") + " · " + t("例程 +", "routines +") + added.optInt("routines") : bot.optString("error", bot.optString("reason", ""))),
                    12, "failed".equals(bot.optString("action")) ? p.danger : p.textMuted, false));
            card.addView(item);
        }
        JSONArray secrets = report.optJSONArray("secrets");
        if (secrets != null && secrets.length() > 0) {
            List<String> names = new ArrayList<>();
            for (int i = 0; i < secrets.length(); i++) names.add(secrets.optString(i));
            LinearLayout item = row();
            item.addView(text(t("需要重新填写：", "Re-enter: ") + String.join("、", names), 12, p.warning, false));
            card.addView(UiChrome.makeRowDivider(this, p));
            card.addView(item);
        }
        mReview.addView(card);
        Toast.makeText(this, t("导入完成，例程已暂停", "Import finished; routines are paused"), Toast.LENGTH_LONG).show();
    }
}

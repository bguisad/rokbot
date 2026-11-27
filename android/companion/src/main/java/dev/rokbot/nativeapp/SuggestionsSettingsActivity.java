package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native settings screen for Input Suggestions ("输入建议 / Input Suggestions"), opened from the
 * first-level "输入建议 / Input Suggestions" row of the settings sheet (hermes-settings.mjs
 * applySettingsMenu, MENU_LABELS.suggestions). Provides Host-synced master, AI and inline
 * completion toggles plus full Quick Phrases management (add, edit, delete, reorder).
 * Zero emoji, crisp vector icons, full zh/en localization.
 */
public class SuggestionsSettingsActivity extends Activity {
    static final String TITLE_ZH = "输入建议";
    static final String TITLE_EN = "Input Suggestions";

    private static final class Phrase {
        final String id;
        final String text;

        Phrase(String id, String text) {
            this.id = id;
            this.text = text;
        }
    }

    private final Handler mMain = new Handler(Looper.getMainLooper());
    private final ExecutorService mIo = Executors.newSingleThreadExecutor(r -> new Thread(r, "rokbot-sug-settings"));
    private volatile boolean mDestroyed = false;

    private boolean mEnabled = true;
    private boolean mAiEnabled = true;
    private boolean mCompletionEnabled = true;
    private boolean mLearningEnabled = true;
    private boolean mLocalCompletionEnabled = true;
    private boolean mSuppressToggleEvents = false;
    private final List<Phrase> mPhrases = new ArrayList<>();

    private Switch mEnabledSwitch;
    private Switch mAiSwitch;
    private Switch mCompletionSwitch;
    private Switch mLearningSwitch;
    private Switch mLocalCompletionSwitch;
    private View mAiRow;
    private EditText mAddInput;
    private TextView mAddButton;
    private LinearLayout mPhrasesContainer;
    private TextView mStatusView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        buildUi();
        loadFromHost();
    }

    @Override
    protected void onDestroy() {
        mDestroyed = true;
        mMain.removeCallbacksAndMessages(null);
        mIo.shutdownNow();
        super.onDestroy();
    }

    private void buildUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(p.bgPaper);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 12), UiChrome.dp(this, 18), UiChrome.dp(this, 28));
        scroll.addView(root);

        View header = UiChrome.makeHeaderBar(this, Localize.t(this, TITLE_ZH, TITLE_EN), p, v -> finish());
        header.setContentDescription("suggestions_settings_title");
        root.addView(header);

        mStatusView = new TextView(this);
        mStatusView.setTextColor(p.textSecondary);
        mStatusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mStatusView.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 6));
        mStatusView.setVisibility(View.GONE);
        root.addView(mStatusView);

        // Section 1: Toggles
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "开关", "Switches"), p));
        LinearLayout switchesCard = UiChrome.makeRowGroup(this, p);

        mEnabledSwitch = new Switch(this);
        mEnabledSwitch.setContentDescription("suggestions_enabled_switch");
        mEnabledSwitch.setChecked(mEnabled);
        mEnabledSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (mSuppressToggleEvents) return;
            saveToggles(isChecked, null, null);
        });
        switchesCard.addView(makeSwitchRow(
                p,
                Localize.t(this, "输入建议", "Input Suggestions"),
                Localize.t(this, "输入框聚焦时显示常用语与快捷建议，点击直接发送", "Show quick phrases and smart replies on focus; tap to send"),
                mEnabledSwitch
        ));

        switchesCard.addView(UiChrome.makeRowDivider(this, p));

        mAiSwitch = new Switch(this);
        mAiSwitch.setContentDescription("suggestions_ai_switch");
        mAiSwitch.setChecked(mAiEnabled);
        mAiSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (mSuppressToggleEvents) return;
            saveToggles(null, isChecked, null);
        });
        mAiRow = makeSwitchRow(
                p,
                Localize.t(this, "AI 生成建议", "AI-Generated Suggestions"),
                Localize.t(this, "根据当前对话上下文由模型自动生成回复建议", "Generate contextual replies from conversation history"),
                mAiSwitch
        );
        switchesCard.addView(mAiRow);

        switchesCard.addView(UiChrome.makeRowDivider(this, p));

        // Independent of the suggestions switch: ghost-text completion while typing.
        mCompletionSwitch = new Switch(this);
        mCompletionSwitch.setContentDescription("suggestions_completion_switch");
        mCompletionSwitch.setChecked(mCompletionEnabled);
        mCompletionSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (mSuppressToggleEvents) return;
            saveToggles(null, null, isChecked);
        });
        switchesCard.addView(makeSwitchRow(
                p,
                Localize.t(this, "输入补全", "Inline Completion"),
                Localize.t(this, "输入时以灰色文字预测后续内容，点按补全即可采用", "Predict the rest of your message in gray while typing; tap to accept"),
                mCompletionSwitch
        ));
        root.addView(switchesCard);

        // Section: habits (learned on the Host from this user's own messages and reactions).
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "个性化", "Personalization"), p));
        LinearLayout habitsCard = UiChrome.makeRowGroup(this, p);
        mLearningSwitch = new Switch(this);
        mLearningSwitch.setContentDescription("suggestions_learning_switch");
        mLearningSwitch.setChecked(mLearningEnabled);
        mLearningSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (mSuppressToggleEvents) return;
            saveLearning(isChecked, null);
        });
        habitsCard.addView(makeSwitchRow(
                p,
                Localize.t(this, "根据习惯学习", "Learn From My Habits"),
                Localize.t(this, "参考你常发的话和点选记录，让建议更像你会说的话；仅保存在你的 Host 上",
                        "Use the messages you often send and the suggestions you pick; stored only on your Host"),
                mLearningSwitch
        ));
        habitsCard.addView(UiChrome.makeRowDivider(this, p));
        mLocalCompletionSwitch = new Switch(this);
        mLocalCompletionSwitch.setContentDescription("suggestions_local_completion_switch");
        mLocalCompletionSwitch.setChecked(mLocalCompletionEnabled);
        mLocalCompletionSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (mSuppressToggleEvents) return;
            saveLearning(null, isChecked);
        });
        habitsCard.addView(makeSwitchRow(
                p,
                Localize.t(this, "本地补全", "Local Completion"),
                Localize.t(this, "输入时匹配常用语和你常发的话，点按填入输入框",
                        "While typing, match quick phrases and your frequent messages; tap to fill the input"),
                mLocalCompletionSwitch
        ));
        root.addView(habitsCard);
        TextView clearHabits = UiChrome.makePillButton(this, Localize.t(this, "清空学习记录", "Clear Learned Habits"), false, p,
                v -> confirmClearHabits());
        clearHabits.setContentDescription("suggestions_clear_habits_button");
        LinearLayout.LayoutParams chLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        chLp.topMargin = UiChrome.dp(this, 10);
        chLp.bottomMargin = UiChrome.dp(this, 6);
        chLp.gravity = Gravity.START;
        root.addView(clearHabits, chLp);

        // Section 2: Quick Phrases
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "自定义常用语", "Quick Phrases"), p));

        TextView phrasesHint = new TextView(this);
        phrasesHint.setText(Localize.t(this,
                "常用语显示在 AI 建议之前，在所有设备间同步。空会话仅显示常用语。",
                "Shown before AI suggestions and synced across devices. Empty chats only show quick phrases."));
        phrasesHint.setTextColor(p.textSecondary);
        phrasesHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        phrasesHint.setPadding(UiChrome.dp(this, 4), 0, UiChrome.dp(this, 4), UiChrome.dp(this, 10));
        root.addView(phrasesHint);

        LinearLayout addRow = new LinearLayout(this);
        addRow.setOrientation(LinearLayout.HORIZONTAL);
        addRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams arLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        arLp.bottomMargin = UiChrome.dp(this, 12);
        addRow.setLayoutParams(arLp);

        mAddInput = new EditText(this);
        UiChrome.styleEditText(mAddInput, p, this);
        mAddInput.setSingleLine(true);
        mAddInput.setImeOptions(EditorInfo.IME_ACTION_DONE);
        mAddInput.setHint(Localize.t(this, "输入常用语，例如：继续、总结一下", "Add a quick phrase, e.g. Continue"));
        mAddInput.setContentDescription("quick_phrase_add_input");
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        inputLp.rightMargin = UiChrome.dp(this, 8);
        addRow.addView(mAddInput, inputLp);

        mAddButton = UiChrome.makePillButton(this, Localize.t(this, "添加", "Add"), true, p, v -> addPhrase());
        mAddButton.setContentDescription("quick_phrase_add_button");
        mAddButton.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 10), UiChrome.dp(this, 16), UiChrome.dp(this, 10));
        addRow.addView(mAddButton);
        mAddInput.setOnEditorActionListener((tv, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                addPhrase();
                return true;
            }
            return false;
        });
        root.addView(addRow);

        mPhrasesContainer = UiChrome.makeRowGroup(this, p);
        mPhrasesContainer.setContentDescription("quick_phrases_list");
        root.addView(mPhrasesContainer);

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
        renderPhrases(p);
    }

    private LinearLayout makeSwitchRow(UiChrome.Palette p, String title, String subtitle, Switch sw) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(UiChrome.dp(this, 14), UiChrome.dp(this, 12), UiChrome.dp(this, 14), UiChrome.dp(this, 12));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        clp.rightMargin = UiChrome.dp(this, 12);
        copy.setLayoutParams(clp);

        TextView t = new TextView(this);
        t.setText(title);
        t.setTextColor(p.textPrimary);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        copy.addView(t);

        TextView d = new TextView(this);
        d.setText(subtitle);
        d.setTextColor(p.textSecondary);
        d.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        d.setPadding(0, UiChrome.dp(this, 2), 0, 0);
        copy.addView(d);

        row.addView(copy);
        row.addView(sw);
        return row;
    }

    private void applyStateFromJson(JSONObject obj) {
        if (obj == null) return;
        if (obj.has("enabled")) mEnabled = obj.optBoolean("enabled", true);
        if (obj.has("aiEnabled")) mAiEnabled = obj.optBoolean("aiEnabled", true);
        if (obj.has("completionEnabled")) mCompletionEnabled = obj.optBoolean("completionEnabled", true);
        if (obj.has("learningEnabled")) mLearningEnabled = obj.optBoolean("learningEnabled", true);
        if (obj.has("localCompletionEnabled")) mLocalCompletionEnabled = obj.optBoolean("localCompletionEnabled", true);
        JSONArray arr = obj.optJSONArray("quickPhrases");
        if (arr != null) {
            mPhrases.clear();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item != null) {
                    String id = item.optString("id", "").trim();
                    String text = item.optString("text", "").trim();
                    if (!id.isEmpty() && !text.isEmpty()) {
                        mPhrases.add(new Phrase(id, text));
                    }
                }
            }
        }
    }

    private void refreshUi() {
        if (mDestroyed || isFinishing()) return;
        mSuppressToggleEvents = true;
        try {
            mEnabledSwitch.setChecked(mEnabled);
            mAiSwitch.setChecked(mAiEnabled);
            mCompletionSwitch.setChecked(mCompletionEnabled);
            mLearningSwitch.setChecked(mLearningEnabled);
            mLocalCompletionSwitch.setChecked(mLocalCompletionEnabled);
            mAiSwitch.setEnabled(mEnabled);
            mAiRow.setAlpha(mEnabled ? 1f : 0.45f);
        } finally {
            mSuppressToggleEvents = false;
        }
        renderPhrases(UiChrome.palette(this));
    }

    private void showStatus(String message, boolean error) {
        if (mDestroyed || mStatusView == null) return;
        if (message == null || message.isEmpty()) {
            mStatusView.setVisibility(View.GONE);
            return;
        }
        UiChrome.Palette p = UiChrome.palette(this);
        mStatusView.setTextColor(error ? p.danger : p.blueAccent);
        mStatusView.setText(message);
        mStatusView.setVisibility(View.VISIBLE);
    }

    private void loadFromHost() {
        showStatus(Localize.t(this, "正在同步设置…", "Syncing settings…"), false);
        mIo.execute(() -> {
            try {
                JSONObject res = HostApiClient.getSuggestionsSettings(this);
                mMain.post(() -> {
                    if (mDestroyed) return;
                    applyStateFromJson(res);
                    showStatus("", false);
                    refreshUi();
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    if (mDestroyed) return;
                    showStatus(Localize.t(this, "读取设置失败: ", "Failed to load settings: ") + t.getMessage(), true);
                });
            }
        });
    }

    private void saveToggles(Boolean enabled, Boolean aiEnabled, Boolean completionEnabled) {
        mIo.execute(() -> {
            try {
                JSONObject res = HostApiClient.updateSuggestionsSettings(this, enabled, aiEnabled, completionEnabled);
                ComposerSuggestionsOverlay.invalidateSettingsCache();
                mMain.post(() -> {
                    if (mDestroyed) return;
                    applyStateFromJson(res);
                    showStatus("", false);
                    refreshUi();
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    if (mDestroyed) return;
                    showStatus(Localize.t(this, "保存失败: ", "Save failed: ") + t.getMessage(), true);
                    refreshUi();
                });
            }
        });
    }

    private void saveLearning(Boolean learningEnabled, Boolean localCompletionEnabled) {
        mIo.execute(() -> {
            try {
                JSONObject res = HostApiClient.updateSuggestionsLearning(this, learningEnabled, localCompletionEnabled);
                ComposerSuggestionsOverlay.invalidateSettingsCache();
                mMain.post(() -> {
                    if (mDestroyed) return;
                    applyStateFromJson(res);
                    showStatus("", false);
                    refreshUi();
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    if (mDestroyed) return;
                    showStatus(Localize.t(this, "保存失败: ", "Save failed: ") + t.getMessage(), true);
                    refreshUi();
                });
            }
        });
    }

    private void confirmClearHabits() {
        new AlertDialog.Builder(this)
                .setTitle(Localize.t(this, "清空学习记录", "Clear Learned Habits"))
                .setMessage(Localize.t(this, "将删除 Host 上为每个 Bot 学到的常用说法和点选记录，常用语不受影响。",
                        "Deletes the habits and pick history learned for every Bot on your Host. Quick phrases are kept."))
                .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                .setPositiveButton(Localize.t(this, "清空", "Clear"), (d, w) -> clearHabits())
                .show();
    }

    private void clearHabits() {
        mIo.execute(() -> {
            try {
                HostApiClient.clearSuggestionHabits(this);
                ComposerSuggestionsOverlay.clearLearnedHabits();
                mMain.post(() -> {
                    if (mDestroyed) return;
                    showStatus(Localize.t(this, "已清空学习记录", "Learned habits cleared"), false);
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    if (mDestroyed) return;
                    showStatus(Localize.t(this, "清空失败: ", "Clear failed: ") + t.getMessage(), true);
                });
            }
        });
    }

    private void addPhrase() {
        String text = mAddInput.getText() != null ? mAddInput.getText().toString().replaceAll("\\s+", " ").trim() : "";
        if (text.isEmpty()) return;
        mAddButton.setEnabled(false);
        mIo.execute(() -> {
            try {
                JSONObject res = HostApiClient.addQuickPhrase(this, text);
                ComposerSuggestionsOverlay.invalidateSettingsCache();
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mAddButton.setEnabled(true);
                    mAddInput.setText("");
                    applyStateFromJson(res);
                    showStatus("", false);
                    refreshUi();
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mAddButton.setEnabled(true);
                    showStatus(Localize.t(this, "添加失败: ", "Add failed: ") + t.getMessage(), true);
                });
            }
        });
    }

    private void promptEditPhrase(Phrase phrase) {
        UiChrome.Palette p = UiChrome.palette(this);
        EditText input = new EditText(this);
        UiChrome.styleEditText(input, p, this);
        input.setSingleLine(true);
        input.setText(phrase.text);
        input.setSelection(phrase.text.length());

        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setPadding(UiChrome.dp(this, 20), UiChrome.dp(this, 12), UiChrome.dp(this, 20), UiChrome.dp(this, 4));
        wrap.addView(input);

        new AlertDialog.Builder(this)
                .setTitle(Localize.t(this, "编辑常用语", "Edit Quick Phrase"))
                .setView(wrap)
                .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                .setPositiveButton(Localize.t(this, "保存", "Save"), (dialog, which) -> {
                    String next = input.getText() != null ? input.getText().toString().replaceAll("\\s+", " ").trim() : "";
                    if (next.isEmpty() || next.equals(phrase.text)) return;
                    mIo.execute(() -> {
                        try {
                            JSONObject res = HostApiClient.updateQuickPhrase(this, phrase.id, next);
                            ComposerSuggestionsOverlay.invalidateSettingsCache();
                            mMain.post(() -> {
                                if (mDestroyed) return;
                                applyStateFromJson(res);
                                showStatus("", false);
                                refreshUi();
                            });
                        } catch (Throwable t) {
                            mMain.post(() -> {
                                if (mDestroyed) return;
                                showStatus(Localize.t(this, "更新失败: ", "Update failed: ") + t.getMessage(), true);
                            });
                        }
                    });
                })
                .show();
    }

    private void deletePhrase(Phrase phrase) {
        mIo.execute(() -> {
            try {
                JSONObject res = HostApiClient.deleteQuickPhrase(this, phrase.id);
                ComposerSuggestionsOverlay.invalidateSettingsCache();
                mMain.post(() -> {
                    if (mDestroyed) return;
                    applyStateFromJson(res);
                    showStatus("", false);
                    refreshUi();
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    if (mDestroyed) return;
                    showStatus(Localize.t(this, "删除失败: ", "Delete failed: ") + t.getMessage(), true);
                });
            }
        });
    }

    private void movePhrase(int index, int delta) {
        int target = index + delta;
        if (target < 0 || target >= mPhrases.size()) return;
        List<String> ids = new ArrayList<>();
        for (Phrase ph : mPhrases) ids.add(ph.id);
        String tmp = ids.get(index);
        ids.set(index, ids.get(target));
        ids.set(target, tmp);
        mIo.execute(() -> {
            try {
                JSONObject res = HostApiClient.reorderQuickPhrases(this, ids);
                ComposerSuggestionsOverlay.invalidateSettingsCache();
                mMain.post(() -> {
                    if (mDestroyed) return;
                    applyStateFromJson(res);
                    showStatus("", false);
                    refreshUi();
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    if (mDestroyed) return;
                    Toast.makeText(this, Localize.t(this, "排序失败: ", "Reorder failed: ") + t.getMessage(), Toast.LENGTH_SHORT).show();
                });
            }
        });
    }

    private void renderPhrases(UiChrome.Palette p) {
        mPhrasesContainer.removeAllViews();
        if (mPhrases.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(Localize.t(this, "暂未添加常用语", "No quick phrases yet"));
            empty.setTextColor(p.textMuted);
            empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 18), UiChrome.dp(this, 16), UiChrome.dp(this, 18));
            mPhrasesContainer.addView(empty);
            return;
        }

        for (int i = 0; i < mPhrases.size(); i++) {
            if (i > 0) mPhrasesContainer.addView(UiChrome.makeRowDivider(this, p));
            final int idx = i;
            final Phrase ph = mPhrases.get(i);

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 10), UiChrome.dp(this, 10), UiChrome.dp(this, 10));
            row.setContentDescription("quick_phrase_row_" + i);

            ComposerSuggestionsOverlay.PhraseIconView icon = new ComposerSuggestionsOverlay.PhraseIconView(this);
            icon.setStrokeColor(p.blueAccent);
            LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(UiChrome.dp(this, 16), UiChrome.dp(this, 16));
            ilp.rightMargin = UiChrome.dp(this, 8);
            row.addView(icon, ilp);

            TextView label = new TextView(this);
            label.setText(ph.text);
            label.setTextColor(p.textPrimary);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            label.setSingleLine(true);
            label.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            tlp.rightMargin = UiChrome.dp(this, 6);
            row.addView(label, tlp);

            row.addView(makeActionIconBtn(ActionIconView.KIND_UP, i == 0, p.textSecondary,
                    Localize.t(this, "上移", "Move up"), v -> movePhrase(idx, -1)));
            row.addView(makeActionIconBtn(ActionIconView.KIND_DOWN, i == mPhrases.size() - 1, p.textSecondary,
                    Localize.t(this, "下移", "Move down"), v -> movePhrase(idx, 1)));
            row.addView(makeActionIconBtn(ActionIconView.KIND_EDIT, false, p.textPrimary,
                    Localize.t(this, "编辑", "Edit"), v -> promptEditPhrase(ph)));
            row.addView(makeActionIconBtn(ActionIconView.KIND_DELETE, false, p.danger,
                    Localize.t(this, "删除", "Delete"), v -> deletePhrase(ph)));

            mPhrasesContainer.addView(row);
        }
    }

    private View makeActionIconBtn(int kind, boolean disabled, int color, String desc, View.OnClickListener listener) {
        ActionIconView btn = new ActionIconView(this, kind, color);
        btn.setContentDescription(desc);
        btn.setEnabled(!disabled);
        btn.setAlpha(disabled ? 0.28f : 1f);
        int sz = UiChrome.dp(this, 30);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(sz, sz);
        lp.leftMargin = UiChrome.dp(this, 2);
        btn.setLayoutParams(lp);
        if (!disabled) btn.setOnClickListener(listener);
        return btn;
    }

    /** Crisp vector action icons (up, down, edit, delete) with zero emoji. */
    private static final class ActionIconView extends View {
        static final int KIND_UP = 1;
        static final int KIND_DOWN = 2;
        static final int KIND_EDIT = 3;
        static final int KIND_DELETE = 4;

        private final int kind;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();

        ActionIconView(Context ctx, int kind, int color) {
            super(ctx);
            this.kind = kind;
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            paint.setStrokeWidth(UiChrome.dp(ctx, 1.6f));
            paint.setColor(color);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight();
            path.reset();
            if (kind == KIND_UP) {
                path.moveTo(w * 0.28f, h * 0.58f);
                path.lineTo(w * 0.50f, h * 0.36f);
                path.lineTo(w * 0.72f, h * 0.58f);
                canvas.drawPath(path, paint);
            } else if (kind == KIND_DOWN) {
                path.moveTo(w * 0.28f, h * 0.42f);
                path.lineTo(w * 0.50f, h * 0.64f);
                path.lineTo(w * 0.72f, h * 0.42f);
                canvas.drawPath(path, paint);
            } else if (kind == KIND_EDIT) {
                path.moveTo(w * 0.26f, h * 0.74f);
                path.lineTo(w * 0.30f, h * 0.58f);
                path.lineTo(w * 0.64f, h * 0.24f);
                path.lineTo(w * 0.76f, h * 0.36f);
                path.lineTo(w * 0.42f, h * 0.70f);
                path.close();
                canvas.drawPath(path, paint);
            } else if (kind == KIND_DELETE) {
                canvas.drawLine(w * 0.26f, h * 0.34f, w * 0.74f, h * 0.34f, paint);
                canvas.drawLine(w * 0.40f, h * 0.26f, w * 0.60f, h * 0.26f, paint);
                path.moveTo(w * 0.32f, h * 0.34f);
                path.lineTo(w * 0.36f, h * 0.76f);
                path.lineTo(w * 0.64f, h * 0.76f);
                path.lineTo(w * 0.68f, h * 0.34f);
                canvas.drawPath(path, paint);
            }
        }
    }
}

package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public class ModelsActivity extends Activity {
    public static final String EXTRA_ONBOARDING = "onboarding";
    public static final String EXTRA_AGENT_ID = "agent_id";
    public static final String EXTRA_AGENT_NAME = "agent_name";

    private static final class ScenarioDef {
        final String key;
        final String titleZh;
        final String titleEn;
        final String descZh;
        final String descEn;

        ScenarioDef(String key, String titleZh, String titleEn, String descZh, String descEn) {
            this.key = key;
            this.titleZh = titleZh;
            this.titleEn = titleEn;
            this.descZh = descZh;
            this.descEn = descEn;
        }
    }

    private static final ScenarioDef[] SCENARIOS = new ScenarioDef[] {
            new ScenarioDef("suggestions", "输入建议", "Input Suggestions",
                    "聊天输入框预制输入建议生成", "Chat composer quick reply suggestions"),
            new ScenarioDef("summarization", "上下文压缩与摘要", "Summarization & Compaction",
                    "长对话历史压缩与摘要生成", "Long conversation compaction and summaries"),
            new ScenarioDef("memoryExtraction", "记忆提取", "Memory Extraction",
                    "对话后自动提炼长期记忆", "Post-turn long-term memory extraction"),
            new ScenarioDef("autoReview", "自动审核分类器", "Auto-Review Classifier",
                    "敏感工具调用的风险自动判定", "Safety classification for risky tool calls"),
            new ScenarioDef("subagent", "子任务 Agent", "Subagents",
                    "后台子代理与并发任务执行", "Background subagent and helper runs"),
            new ScenarioDef("automation", "定时任务与自动化", "Automations & Routines",
                    "定时触发的自动运行任务", "Scheduled routine and automation runs"),
    };

    private static final String[] API_FORMATS = { "openai", "openai-responses", "anthropic" };
    private static final String[] ALL_EFFORTS = { "none", "minimal", "low", "medium", "high", "xhigh", "max" };
    private static final int MAX_RELOAD_POLL_ATTEMPTS = 40;
    private static final long RELOAD_POLL_INTERVAL_MS = 1500L;

    private final Handler mMain = new Handler(Looper.getMainLooper());
    private volatile boolean mDestroyed = false;
    private boolean mOnboarding = false;
    private String mTargetAgentId = "";
    private String mTargetAgentName = "";
    private boolean mInitialBotDialogOpened = false;

    private JSONArray mProviders = new JSONArray();
    private JSONArray mProfiles = new JSONArray();
    private JSONObject mDefaultRoute = null;
    private JSONObject mBotRoutes = new JSONObject();
    private JSONObject mScenarioRoutes = new JSONObject();
    private JSONArray mAgents = new JSONArray();
    private boolean mRoutingMigrated = false;
    private boolean mConfigured = false;
    private boolean mCanConfigureModel = true;
    private boolean mAuthBlocked = false;
    private String mReloadStatus = "none";
    private String mReloadRevision = "";
    private String mReloadError = "";
    private String mAdminPassword = "";
    private final Map<String, String> mPendingApiKeys = new HashMap<>();

    private TextView mStatusText;
    private TextView mReloadBadge;
    private LinearLayout mOnboardingCard;
    private LinearLayout mStepUpCard;
    private Spinner mDefaultProfileSpinner;
    private Spinner mDefaultEffortSpinner;
    private TextView mTestBtn;
    private TextView mSaveBtn;
    private TextView mContinueBtn;
    private ProgressBar mActionProgress;
    private TextView mActionResultText;
    private LinearLayout mScenariosContainer;
    private LinearLayout mBotRoutesContainer;
    private LinearLayout mProvidersContainer;
    private LinearLayout mProfilesContainer;

    private final List<String> mProfileIdsForSpinner = new ArrayList<>();
    private final List<String> mEffortOptionsForSpinner = new ArrayList<>();
    private boolean mBindingSpinners = false;
    private int mReloadPollToken = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        Storage.init(this);
        mOnboarding = getIntent() != null && getIntent().getBooleanExtra(EXTRA_ONBOARDING, false);
        if (getIntent() != null) {
            String extraAgent = getIntent().getStringExtra(EXTRA_AGENT_ID);
            String extraName = getIntent().getStringExtra(EXTRA_AGENT_NAME);
            mTargetAgentId = extraAgent != null ? extraAgent.trim() : "";
            mTargetAgentName = extraName != null ? extraName.trim() : "";
        }
        buildUi();
        loadModelConfig();
    }

    @Override
    protected void onDestroy() {
        mDestroyed = true;
        mReloadPollToken++;
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

        View refreshBtn = UiChrome.makeVectorIconButton(this, "refresh", "refresh_models_button", p, v -> loadModelConfig());
        root.addView(UiChrome.makeHeaderBar(this, Localize.t(this, "模型配置", "Model Settings"), p, v -> finish(), refreshBtn));

        // Beginner onboarding banner
        mOnboardingCard = UiChrome.makeCard(this, p);
        LinearLayout.LayoutParams obLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        obLp.topMargin = UiChrome.dp(this, 10);
        mOnboardingCard.setLayoutParams(obLp);
        TextView obTitle = new TextView(this);
        obTitle.setText(Localize.t(this, "欢迎使用 RokBot", "Welcome to RokBot"));
        obTitle.setTextColor(p.textPrimary);
        obTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        obTitle.setTypeface(Typeface.DEFAULT_BOLD);
        mOnboardingCard.addView(obTitle);
        TextView obBody = new TextView(this);
        obBody.setText(Localize.t(this,
                "配置一个对话模型即可开始使用 RokBot。添加模型服务（如 OpenAI 或 Anthropic）并选择一个模型档案后点击「保存并应用」。",
                "Configure a model provider to start chatting with RokBot. Add a provider and model profile, then tap Save & Apply."));
        obBody.setTextColor(p.textSecondary);
        obBody.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        obBody.setPadding(0, UiChrome.dp(this, 6), 0, 0);
        mOnboardingCard.addView(obBody);
        mOnboardingCard.setVisibility(mOnboarding ? View.VISIBLE : View.GONE);
        root.addView(mOnboardingCard);

        // Status & Reload Card
        addSpacing(root, 10);
        LinearLayout statusCard = UiChrome.makeCard(this, p);
        LinearLayout statusHeader = new LinearLayout(this);
        statusHeader.setOrientation(LinearLayout.HORIZONTAL);
        statusHeader.setGravity(Gravity.CENTER_VERTICAL);
        TextView statusTitle = new TextView(this);
        statusTitle.setText(Localize.t(this, "当前模型状态", "Model Status"));
        statusTitle.setTextColor(p.textPrimary);
        statusTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        statusTitle.setTypeface(Typeface.DEFAULT_BOLD);
        statusTitle.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        statusHeader.addView(statusTitle);

        mReloadBadge = new TextView(this);
        mReloadBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mReloadBadge.setTypeface(Typeface.DEFAULT_BOLD);
        statusHeader.addView(mReloadBadge);
        statusCard.addView(statusHeader);

        mStatusText = new TextView(this);
        mStatusText.setContentDescription("model_status_text");
        mStatusText.setText(Localize.t(this, "正在读取 Host 模型配置…", "Loading Host model configuration…"));
        mStatusText.setTextColor(p.textSecondary);
        mStatusText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mStatusText.setPadding(0, UiChrome.dp(this, 6), 0, 0);
        statusCard.addView(mStatusText);
        root.addView(statusCard);

        // Admin step-up card (shown on 403 or canConfigureModel == false)
        mStepUpCard = UiChrome.makeCard(this, p);
        LinearLayout.LayoutParams suLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        suLp.topMargin = UiChrome.dp(this, 10);
        mStepUpCard.setLayoutParams(suLp);
        TextView suMsg = new TextView(this);
        suMsg.setText(Localize.t(this,
                "当前设备需要管理员密码授权才能查看或修改 Host 模型配置。",
                "Host policy requires the admin password to view or modify model settings."));
        suMsg.setTextColor(p.warning);
        suMsg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        suMsg.setPadding(0, 0, 0, UiChrome.dp(this, 10));
        mStepUpCard.addView(suMsg);
        TextView suBtn = UiChrome.makePillButton(this,
                Localize.t(this, "输入管理员密码解锁", "Unlock with Admin Password"), true, p,
                v -> showAdminStepUpDialog());
        suBtn.setContentDescription("admin_stepup_button");
        mStepUpCard.addView(suBtn);
        mStepUpCard.setVisibility(View.GONE);
        root.addView(mStepUpCard);

        // Default Route Card
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "默认对话模型", "Default Model Route"), p));
        LinearLayout routeCard = UiChrome.makeCard(this, p);

        TextView profLbl = new TextView(this);
        profLbl.setText(Localize.t(this, "默认模型档案", "Active Profile"));
        profLbl.setTextColor(p.textSecondary);
        profLbl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        routeCard.addView(profLbl);

        mDefaultProfileSpinner = new Spinner(this);
        mDefaultProfileSpinner.setContentDescription("default_profile_spinner");
        mDefaultProfileSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int pos, long id) {
                if (mBindingSpinners || pos < 0 || pos >= mProfileIdsForSpinner.size()) return;
                String chosenId = mProfileIdsForSpinner.get(pos);
                ensureDefaultRouteObject();
                try {
                    mDefaultRoute.put("profileId", chosenId);
                } catch (Throwable ignored) {}
                dropFallbacksMatchingPrimary();
                refreshEffortSpinner(chosenId);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        routeCard.addView(mDefaultProfileSpinner);

        addSpacing(routeCard, 8);
        TextView effLbl = new TextView(this);
        effLbl.setText(Localize.t(this, "推理强度 (Effort)", "Reasoning Effort"));
        effLbl.setTextColor(p.textSecondary);
        effLbl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        routeCard.addView(effLbl);

        mDefaultEffortSpinner = new Spinner(this);
        mDefaultEffortSpinner.setContentDescription("default_effort_spinner");
        mDefaultEffortSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int pos, long id) {
                if (mBindingSpinners || pos < 0 || pos >= mEffortOptionsForSpinner.size()) return;
                ensureDefaultRouteObject();
                try {
                    mDefaultRoute.put("effort", mEffortOptionsForSpinner.get(pos));
                } catch (Throwable ignored) {}
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        routeCard.addView(mDefaultEffortSpinner);

        addSpacing(routeCard, 12);
        LinearLayout actionRow = new LinearLayout(this);
        actionRow.setOrientation(LinearLayout.HORIZONTAL);
        mTestBtn = UiChrome.makePillButton(this, Localize.t(this, "测试连接", "Test"), false, p,
                v -> runTestModel(getSelectedDefaultProfileId()));
        mTestBtn.setContentDescription("test_model_button");
        mTestBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        actionRow.addView(mTestBtn);

        View gap = new View(this);
        gap.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 8), 1));
        actionRow.addView(gap);

        mSaveBtn = UiChrome.makePillButton(this, Localize.t(this, "保存并应用", "Save & Apply"), true, p,
                v -> saveModelConfig());
        mSaveBtn.setContentDescription("save_model_button");
        mSaveBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        actionRow.addView(mSaveBtn);
        routeCard.addView(actionRow);

        mActionProgress = new ProgressBar(this);
        mActionProgress.setVisibility(View.GONE);
        mActionProgress.setPadding(0, UiChrome.dp(this, 8), 0, 0);
        routeCard.addView(mActionProgress);

        mActionResultText = new TextView(this);
        mActionResultText.setTextColor(p.textSecondary);
        mActionResultText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mActionResultText.setPadding(0, UiChrome.dp(this, 8), 0, 0);
        mActionResultText.setVisibility(View.GONE);
        routeCard.addView(mActionResultText);

        addSpacing(routeCard, 10);
        mContinueBtn = UiChrome.makePillButton(this,
                Localize.t(this, "开始使用 RokBot", "Continue to RokBot"), true, p,
                v -> continueToMainApp());
        mContinueBtn.setContentDescription("continue_to_app_button");
        mContinueBtn.setVisibility(View.GONE);
        routeCard.addView(mContinueBtn);

        root.addView(routeCard);

        // Scenario Models Section
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "场景模型 (Scenario Models)", "Scenario Models"), p));
        mScenariosContainer = new LinearLayout(this);
        mScenariosContainer.setOrientation(LinearLayout.VERTICAL);
        root.addView(mScenariosContainer);

        // Per-Bot Model Routes Section
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "Bot 独立模型 (Bot Routes)", "Per-Bot Model Routes"), p));
        mBotRoutesContainer = new LinearLayout(this);
        mBotRoutesContainer.setOrientation(LinearLayout.VERTICAL);
        root.addView(mBotRoutesContainer);

        // Providers Section
        LinearLayout provHeader = new LinearLayout(this);
        provHeader.setOrientation(LinearLayout.HORIZONTAL);
        provHeader.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams phLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        phLp.topMargin = UiChrome.dp(this, 16);
        phLp.bottomMargin = UiChrome.dp(this, 6);
        provHeader.setLayoutParams(phLp);

        TextView provSecTitle = new TextView(this);
        provSecTitle.setText(Localize.t(this, "模型服务商 (Providers)", "Model Providers"));
        provSecTitle.setTextColor(p.textSecondary);
        provSecTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        provSecTitle.setTypeface(Typeface.DEFAULT_BOLD);
        provSecTitle.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        provHeader.addView(provSecTitle);

        TextView addProvBtn = UiChrome.makePillButton(this,
                Localize.t(this, "+ 添加服务", "+ Add Provider"), false, p,
                v -> showProviderDialog(null));
        addProvBtn.setContentDescription("add_provider_button");
        addProvBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        addProvBtn.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 6), UiChrome.dp(this, 12), UiChrome.dp(this, 6));
        provHeader.addView(addProvBtn);
        root.addView(provHeader);

        mProvidersContainer = new LinearLayout(this);
        mProvidersContainer.setOrientation(LinearLayout.VERTICAL);
        root.addView(mProvidersContainer);

        // Profiles Section
        LinearLayout profHeader = new LinearLayout(this);
        profHeader.setOrientation(LinearLayout.HORIZONTAL);
        profHeader.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams prhLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        prhLp.topMargin = UiChrome.dp(this, 16);
        prhLp.bottomMargin = UiChrome.dp(this, 6);
        profHeader.setLayoutParams(prhLp);

        TextView profSecTitle = new TextView(this);
        profSecTitle.setText(Localize.t(this, "模型档案 (Profiles)", "Model Profiles"));
        profSecTitle.setTextColor(p.textSecondary);
        profSecTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        profSecTitle.setTypeface(Typeface.DEFAULT_BOLD);
        profSecTitle.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        profHeader.addView(profSecTitle);

        TextView addProfBtn = UiChrome.makePillButton(this,
                Localize.t(this, "+ 添加档案", "+ Add Profile"), false, p,
                v -> showProfileDialog(null));
        addProfBtn.setContentDescription("add_profile_button");
        addProfBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        addProfBtn.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 6), UiChrome.dp(this, 12), UiChrome.dp(this, 6));
        profHeader.addView(addProfBtn);
        root.addView(profHeader);

        mProfilesContainer = new LinearLayout(this);
        mProfilesContainer.setOrientation(LinearLayout.VERTICAL);
        root.addView(mProfilesContainer);

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
    }

    private void loadModelConfig() {
        mActionProgress.setVisibility(View.VISIBLE);
        new Thread(() -> {
            try {
                JSONObject res = HostApiClient.getModelConfig(this, mAdminPassword);
                JSONArray agents = null;
                try {
                    agents = HostApiClient.listAgents(this);
                } catch (Throwable ignored) {}
                final JSONArray loadedAgents = agents;
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mActionProgress.setVisibility(View.GONE);
                    mAuthBlocked = false;
                    if (loadedAgents != null) {
                        mAgents = loadedAgents;
                    }
                    applyServerResponse(res, true);
                    renderData();
                    maybeOpenInitialBotDialog();
                });
            } catch (HostApiClient.ApiException ae) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mActionProgress.setVisibility(View.GONE);
                    if (ae.statusCode == 403) {
                        mAuthBlocked = true;
                        mCanConfigureModel = false;
                        mStepUpCard.setVisibility(View.VISIBLE);
                        mStatusText.setText(ae.getMessage() != null && !ae.getMessage().isEmpty()
                                ? ae.getMessage()
                                : Localize.t(this, "需要管理员密码授权", "Admin password required"));
                        showAdminStepUpDialog();
                    } else {
                        mStatusText.setText(Localize.t(this, "加载模型配置失败：", "Failed to load model config: ") + ae.getMessage());
                    }
                });
            } catch (Throwable t) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mActionProgress.setVisibility(View.GONE);
                    mStatusText.setText(Localize.t(this, "加载模型配置失败：", "Failed to load model config: ") + t.getMessage());
                });
            }
        }, "ModelsLoad").start();
    }

    private JSONObject extractConfigObject(JSONObject res) {
        if (res == null) return new JSONObject();
        JSONObject nested = res.optJSONObject("config");
        if (nested != null) return nested;
        return res;
    }

    private void applyServerResponse(JSONObject res, boolean resetPendingKeys) {
        JSONObject cfg = extractConfigObject(res);
        mProviders = copyJsonArray(cfg.optJSONArray("providers"));
        mProfiles = copyJsonArray(cfg.optJSONArray("profiles"));
        JSONObject defRoute = cfg.optJSONObject("defaultRoute");
        mDefaultRoute = defRoute != null ? copyJsonObject(defRoute) : null;
        JSONObject botRoutes = cfg.optJSONObject("botRoutes");
        mBotRoutes = botRoutes != null ? copyJsonObject(botRoutes) : new JSONObject();
        JSONObject scenarioRoutes = cfg.optJSONObject("scenarioRoutes");
        mScenarioRoutes = scenarioRoutes != null ? copyJsonObject(scenarioRoutes) : new JSONObject();
        boolean fallbackConfigured = mProviders.length() > 0 && mProfiles.length() > 0 && mDefaultRoute != null;
        mRoutingMigrated = (res != null && res.has("routingMigrated") && !res.isNull("routingMigrated"))
                ? res.optBoolean("routingMigrated", false)
                : cfg.optBoolean("routingMigrated", false);
        mConfigured = (res != null && res.has("configured") && !res.isNull("configured"))
                ? res.optBoolean("configured", fallbackConfigured)
                : cfg.optBoolean("configured", fallbackConfigured);

        if (res != null && res.has("canConfigureModel") && !res.isNull("canConfigureModel")) {
            mCanConfigureModel = res.optBoolean("canConfigureModel", true);
        } else {
            mCanConfigureModel = true;
        }
        if (resetPendingKeys) {
            mPendingApiKeys.clear();
        }

        JSONObject reload = res != null ? res.optJSONObject("reload") : null;
        if (reload == null) reload = cfg.optJSONObject("reload");
        applyReloadObject(reload);
    }

    private void applyReloadObject(JSONObject reload) {
        if (reload == null) {
            mReloadStatus = "none";
            mReloadRevision = "";
            mReloadError = "";
            return;
        }
        mReloadStatus = UiChrome.jsonStr(reload, "status", "none");
        mReloadRevision = UiChrome.jsonStr(reload, "revision");
        String err = UiChrome.jsonStr(reload, "error");
        if (err.isEmpty()) {
            err = UiChrome.jsonStr(reload, "message");
        }
        mReloadError = err;
    }

    private void renderData() {
        UiChrome.Palette p = UiChrome.palette(this);
        mStepUpCard.setVisibility((mAuthBlocked || !mCanConfigureModel) ? View.VISIBLE : View.GONE);

        // Reload badge & status text
        String reloadLabel;
        int reloadColor;
        if ("applied".equals(mReloadStatus)) {
            reloadLabel = Localize.t(this, "● 已生效", "● Applied");
            reloadColor = p.success;
        } else if ("waiting".equals(mReloadStatus) || "pending".equals(mReloadStatus)) {
            reloadLabel = Localize.t(this, "● 重载中…", "● Reloading…");
            reloadColor = p.warning;
        } else if ("error".equals(mReloadStatus)) {
            reloadLabel = Localize.t(this, "● 重载失败", "● Reload Error");
            reloadColor = p.danger;
        } else {
            reloadLabel = mConfigured
                    ? Localize.t(this, "● 已配置", "● Configured")
                    : Localize.t(this, "● 未配置", "● Not Configured");
            reloadColor = mConfigured ? p.success : p.warning;
        }
        mReloadBadge.setText(reloadLabel);
        mReloadBadge.setTextColor(reloadColor);

        String defaultSummary = Localize.t(this, "尚未设置默认对话模型", "No default model configured yet");
        String defProfileId = getSelectedDefaultProfileId();
        JSONObject defProfile = findById(mProfiles, defProfileId);
        if (defProfile != null) {
            JSONObject prov = findById(mProviders, UiChrome.jsonStr(defProfile, "providerId"));
            String provName = prov != null ? UiChrome.jsonStr(prov, "name") : "";
            String eff = mDefaultRoute != null ? UiChrome.jsonStr(mDefaultRoute, "effort", "default") : "default";
            defaultSummary = Localize.t(this, "当前路由: ", "Active route: ")
                    + UiChrome.jsonStr(defProfile, "name", defProfileId)
                    + " · " + UiChrome.jsonStr(defProfile, "model")
                    + (provName.isEmpty() ? "" : (" (" + provName + ")"))
                    + " · effort=" + eff;
        }
        if ("error".equals(mReloadStatus) && !mReloadError.isEmpty()) {
            defaultSummary += "\n" + Localize.t(this, "重载错误: ", "Reload error: ") + mReloadError;
        } else if (mRoutingMigrated) {
            defaultSummary += "\n" + Localize.t(this, "检测到旧版环境变量配置，保存时将自动迁移至多服务路由。",
                    "Legacy config detected; saving will migrate to multi-provider routing.");
        }
        mStatusText.setText(defaultSummary);

        boolean canContinue = mOnboarding && mConfigured
                && !"waiting".equals(mReloadStatus)
                && !"pending".equals(mReloadStatus)
                && !"error".equals(mReloadStatus);
        if (mOnboarding) {
            mOnboardingCard.setVisibility(mConfigured ? View.GONE : View.VISIBLE);
            mContinueBtn.setVisibility(canContinue ? View.VISIBLE : View.GONE);
        } else {
            mOnboardingCard.setVisibility(View.GONE);
            mContinueBtn.setVisibility(View.GONE);
        }

        // Bind default profile spinner
        mBindingSpinners = true;
        try {
            mProfileIdsForSpinner.clear();
            List<String> labels = new ArrayList<>();
            int selectedIdx = 0;
            for (int i = 0; i < mProfiles.length(); i++) {
                JSONObject prof = mProfiles.optJSONObject(i);
                if (prof == null) continue;
                String id = UiChrome.jsonStr(prof, "id");
                if (id.isEmpty()) continue;
                String profProviderId = UiChrome.jsonStr(prof, "providerId");
                JSONObject prov = findById(mProviders, profProviderId);
                String provName = prov != null ? UiChrome.jsonStr(prov, "name", profProviderId) : profProviderId;
                mProfileIdsForSpinner.add(id);
                labels.add(UiChrome.jsonStr(prof, "name", id) + " · " + UiChrome.jsonStr(prof, "model") + " (" + provName + ")");
                if (id.equals(defProfileId)) {
                    selectedIdx = mProfileIdsForSpinner.size() - 1;
                }
            }
            if (labels.isEmpty()) {
                labels.add(Localize.t(this, "（请先添加模型档案）", "(Add a profile first)"));
            }
            mDefaultProfileSpinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, labels));
            if (selectedIdx < labels.size()) {
                mDefaultProfileSpinner.setSelection(selectedIdx, false);
            }
            refreshEffortSpinner(defProfileId);
        } finally {
            mBindingSpinners = false;
        }

        renderScenarioRoutesList(p);
        renderBotRoutesList(p);
        renderProvidersList(p);
        renderProfilesList(p);
    }

    private void maybeOpenInitialBotDialog() {
        if (mInitialBotDialogOpened || mTargetAgentId.isEmpty() || mProfiles.length() == 0) return;
        mInitialBotDialogOpened = true;
        String resolvedName = mTargetAgentName;
        if (resolvedName.isEmpty()) {
            resolvedName = findAgentName(mTargetAgentId);
        }
        showBotRouteDialog(mTargetAgentId, resolvedName, true);
    }

    private String findAgentName(String agentId) {
        if (mAgents != null) {
            for (int i = 0; i < mAgents.length(); i++) {
                JSONObject a = mAgents.optJSONObject(i);
                if (a != null && agentId.equals(UiChrome.jsonStr(a, "id"))) {
                    String n = UiChrome.jsonStr(a, "name");
                    if (!n.isEmpty()) return n;
                }
            }
        }
        return agentId;
    }

    private String describeRouteSummary(JSONObject route) {
        if (route == null) return Localize.t(this, "跟随默认", "Follow default");
        String pid = UiChrome.jsonStr(route, "profileId");
        if (pid.isEmpty()) return Localize.t(this, "跟随默认", "Follow default");
        JSONObject prof = findById(mProfiles, pid);
        String name = prof != null ? UiChrome.jsonStr(prof, "name", pid) : pid;
        String model = prof != null ? UiChrome.jsonStr(prof, "model") : "";
        String eff = UiChrome.jsonStr(route, "effort", "default");
        String base = model.isEmpty() ? name : (name + " · " + model);
        return "default".equals(eff) ? base : (base + " (" + eff + ")");
    }

    private void renderScenarioRoutesList(UiChrome.Palette p) {
        if (mScenariosContainer == null) return;
        mScenariosContainer.removeAllViews();
        LinearLayout card = UiChrome.makeCard(this, p);
        TextView hint = new TextView(this);
        hint.setText(Localize.t(this,
                "按调用场景单独指定模型与推理强度，未设置则跟随默认对话模型。",
                "Assign a model and effort per scenario. Leave unset to follow the default route."));
        hint.setTextColor(p.textSecondary);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hint.setPadding(0, 0, 0, UiChrome.dp(this, 8));
        card.addView(hint);

        for (int i = 0; i < SCENARIOS.length; i++) {
            final ScenarioDef def = SCENARIOS[i];
            if (i > 0) {
                View divider = new View(this);
                divider.setBackgroundColor(p.border);
                LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, UiChrome.dp(this, 0.5f)));
                dlp.topMargin = UiChrome.dp(this, 6);
                dlp.bottomMargin = UiChrome.dp(this, 6);
                divider.setLayoutParams(dlp);
                card.addView(divider);
            }
            JSONObject route = mScenarioRoutes != null ? mScenarioRoutes.optJSONObject(def.key) : null;
            boolean custom = route != null && !UiChrome.jsonStr(route, "profileId").isEmpty();

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, UiChrome.dp(this, 4), 0, UiChrome.dp(this, 4));
            row.setContentDescription("scenario_route_" + def.key);

            LinearLayout left = new LinearLayout(this);
            left.setOrientation(LinearLayout.VERTICAL);
            left.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            TextView titleTv = new TextView(this);
            titleTv.setText(Localize.t(this, def.titleZh, def.titleEn));
            titleTv.setTextColor(p.textPrimary);
            titleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            titleTv.setTypeface(Typeface.DEFAULT_BOLD);
            left.addView(titleTv);

            TextView descTv = new TextView(this);
            descTv.setText(Localize.t(this, def.descZh, def.descEn));
            descTv.setTextColor(p.textSecondary);
            descTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            left.addView(descTv);
            row.addView(left);

            TextView badge = new TextView(this);
            badge.setText(describeRouteSummary(route));
            badge.setTextColor(custom ? p.blueAccent : p.textMuted);
            badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            badge.setTypeface(custom ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            badge.setPadding(UiChrome.dp(this, 8), 0, 0, 0);
            badge.setMaxWidth(UiChrome.dp(this, 160));
            badge.setSingleLine(true);
            badge.setEllipsize(android.text.TextUtils.TruncateAt.END);
            row.addView(badge);

            row.setOnClickListener(v -> showRouteOverrideDialog(
                    Localize.t(this, def.titleZh, def.titleEn),
                    route,
                    false,
                    chosen -> {
                        try {
                            if (mScenarioRoutes == null) mScenarioRoutes = new JSONObject();
                            if (chosen == null) mScenarioRoutes.remove(def.key);
                            else mScenarioRoutes.put(def.key, chosen);
                        } catch (Throwable ignored) {}
                        renderData();
                    }
            ));
            card.addView(row);
        }
        mScenariosContainer.addView(card);
    }

    private void renderBotRoutesList(UiChrome.Palette p) {
        if (mBotRoutesContainer == null) return;
        mBotRoutesContainer.removeAllViews();
        LinearLayout card = UiChrome.makeCard(this, p);

        List<String[]> botEntries = new ArrayList<>();
        Set<String> seenIds = new HashSet<>();
        if (mAgents != null) {
            for (int i = 0; i < mAgents.length(); i++) {
                JSONObject a = mAgents.optJSONObject(i);
                if (a == null || a.optBoolean("isGroup", false) || a.optBoolean("isHiddenFromSidebar", false)) continue;
                String id = UiChrome.jsonStr(a, "id");
                if (id.isEmpty() || !seenIds.add(id)) continue;
                botEntries.add(new String[] { id, UiChrome.jsonStr(a, "name", id) });
            }
        }
        if (mBotRoutes != null) {
            JSONArray keys = mBotRoutes.names();
            if (keys != null) {
                for (int i = 0; i < keys.length(); i++) {
                    String id = jsonArrStr(keys, i);
                    if (!id.isEmpty() && seenIds.add(id)) {
                        botEntries.add(new String[] { id, id });
                    }
                }
            }
        }
        if (!mTargetAgentId.isEmpty() && seenIds.add(mTargetAgentId)) {
            botEntries.add(0, new String[] { mTargetAgentId, mTargetAgentName.isEmpty() ? mTargetAgentId : mTargetAgentName });
        }

        if (botEntries.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText(Localize.t(this, "暂无可配置的 Bot。", "No Bots available yet."));
            empty.setTextColor(p.textMuted);
            empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            card.addView(empty);
            mBotRoutesContainer.addView(card);
            return;
        }

        TextView hint = new TextView(this);
        hint.setText(Localize.t(this,
                "点击任意 Bot 单独指定对话模型与推理强度，保存后立即生效。",
                "Tap any Bot to assign its own model profile and effort, or follow default."));
        hint.setTextColor(p.textSecondary);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hint.setPadding(0, 0, 0, UiChrome.dp(this, 8));
        card.addView(hint);

        for (int i = 0; i < botEntries.size(); i++) {
            final String botId = botEntries.get(i)[0];
            final String botName = botEntries.get(i)[1];
            if (i > 0) {
                View divider = new View(this);
                divider.setBackgroundColor(p.border);
                LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, UiChrome.dp(this, 0.5f)));
                dlp.topMargin = UiChrome.dp(this, 6);
                dlp.bottomMargin = UiChrome.dp(this, 6);
                divider.setLayoutParams(dlp);
                card.addView(divider);
            }
            JSONObject route = mBotRoutes != null ? mBotRoutes.optJSONObject(botId) : null;
            boolean custom = route != null && !UiChrome.jsonStr(route, "profileId").isEmpty();

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, UiChrome.dp(this, 5), 0, UiChrome.dp(this, 5));
            row.setContentDescription("bot_route_" + botId);

            TextView nameTv = new TextView(this);
            nameTv.setText(botName);
            nameTv.setTextColor(p.textPrimary);
            nameTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            nameTv.setTypeface(Typeface.DEFAULT_BOLD);
            nameTv.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            nameTv.setSingleLine(true);
            nameTv.setEllipsize(android.text.TextUtils.TruncateAt.END);
            row.addView(nameTv);

            TextView badge = new TextView(this);
            badge.setText(describeRouteSummary(route));
            badge.setTextColor(custom ? p.blueAccent : p.textMuted);
            badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            badge.setTypeface(custom ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            badge.setPadding(UiChrome.dp(this, 8), 0, 0, 0);
            badge.setMaxWidth(UiChrome.dp(this, 175));
            badge.setSingleLine(true);
            badge.setEllipsize(android.text.TextUtils.TruncateAt.END);
            row.addView(badge);

            row.setOnClickListener(v -> showBotRouteDialog(botId, botName, false));
            card.addView(row);
        }
        mBotRoutesContainer.addView(card);
    }

    private interface RouteChoiceCallback {
        void onChosen(JSONObject routeOrNull);
    }

    private void showBotRouteDialog(String botId, String botName, boolean autoSave) {
        JSONObject existing = mBotRoutes != null ? mBotRoutes.optJSONObject(botId) : null;
        String title = Localize.t(this, "Bot 模型：" + botName, "Bot Model: " + botName);
        showRouteOverrideDialog(title, existing, autoSave, chosen -> {
            try {
                if (mBotRoutes == null) mBotRoutes = new JSONObject();
                if (chosen == null) {
                    mBotRoutes.remove(botId);
                } else {
                    if (!chosen.has("fallbacks")) chosen.put("fallbacks", new JSONArray());
                    mBotRoutes.put(botId, chosen);
                }
            } catch (Throwable ignored) {}
            renderData();
            if (autoSave) {
                saveModelConfig();
            }
        });
    }

    private void showRouteOverrideDialog(String title, JSONObject existing, boolean immediateSave, RouteChoiceCallback callback) {
        if (mProfiles == null || mProfiles.length() == 0) {
            Toast.makeText(this, Localize.t(this, "请先添加至少一个模型档案", "Add at least one model profile first"), Toast.LENGTH_SHORT).show();
            return;
        }
        UiChrome.Palette p = UiChrome.palette(this);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(UiChrome.dp(this, 20), UiChrome.dp(this, 14), UiChrome.dp(this, 20), UiChrome.dp(this, 6));

        final List<String> profileIds = new ArrayList<>();
        final List<String> profileLabels = new ArrayList<>();
        profileIds.add("");
        profileLabels.add(Localize.t(this, "跟随默认模型", "Follow default"));

        String currentProfileId = existing != null ? UiChrome.jsonStr(existing, "profileId") : "";
        String currentEffort = existing != null ? UiChrome.jsonStr(existing, "effort", "default") : "default";
        int initialProfilePos = 0;

        for (int i = 0; i < mProfiles.length(); i++) {
            JSONObject pf = mProfiles.optJSONObject(i);
            if (pf == null) continue;
            String id = UiChrome.jsonStr(pf, "id");
            if (id.isEmpty()) continue;
            JSONObject prov = findById(mProviders, UiChrome.jsonStr(pf, "providerId"));
            String provName = prov != null ? UiChrome.jsonStr(prov, "name") : "";
            profileIds.add(id);
            profileLabels.add(UiChrome.jsonStr(pf, "name", id) + " · " + UiChrome.jsonStr(pf, "model")
                    + (provName.isEmpty() ? "" : (" (" + provName + ")")));
            if (id.equals(currentProfileId)) {
                initialProfilePos = profileIds.size() - 1;
            }
        }

        TextView profLbl = new TextView(this);
        profLbl.setText(Localize.t(this, "模型档案", "Model Profile"));
        profLbl.setTextColor(p.textSecondary);
        profLbl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        form.addView(profLbl);

        Spinner profSpinner = new Spinner(this);
        profSpinner.setContentDescription("route_dialog_profile_spinner");
        profSpinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, profileLabels));
        profSpinner.setSelection(initialProfilePos, false);
        form.addView(profSpinner);

        TextView effLbl = new TextView(this);
        effLbl.setText(Localize.t(this, "推理强度 (Effort)", "Reasoning Effort"));
        effLbl.setTextColor(p.textSecondary);
        effLbl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        effLbl.setPadding(0, UiChrome.dp(this, 10), 0, 0);
        form.addView(effLbl);

        Spinner effSpinner = new Spinner(this);
        effSpinner.setContentDescription("route_dialog_effort_spinner");
        form.addView(effSpinner);

        final List<String> effOptions = new ArrayList<>();
        final Runnable bindEfforts = () -> {
            int pos = profSpinner.getSelectedItemPosition();
            String pid = (pos >= 0 && pos < profileIds.size()) ? profileIds.get(pos) : "";
            boolean isFollowDefault = pid.isEmpty();
            effLbl.setVisibility(isFollowDefault ? View.GONE : View.VISIBLE);
            effSpinner.setVisibility(isFollowDefault ? View.GONE : View.VISIBLE);
            effOptions.clear();
            effOptions.add("default");
            if (!isFollowDefault) {
                JSONObject pf = findById(mProfiles, pid);
                JSONArray efforts = pf != null ? pf.optJSONArray("efforts") : null;
                if (efforts != null) {
                    for (int i = 0; i < efforts.length(); i++) {
                        String e = jsonArrStr(efforts, i);
                        if (!e.isEmpty() && !effOptions.contains(e)) effOptions.add(e);
                    }
                } else {
                    for (String e : ALL_EFFORTS) effOptions.add(e);
                }
            }
            effSpinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, effOptions));
            int sel = effOptions.indexOf(currentEffort);
            effSpinner.setSelection(sel >= 0 ? sel : 0, false);
        };
        bindEfforts.run();
        profSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int pos, long id) { bindEfforts.run(); }
            @Override public void onNothingSelected(AdapterView<?> parent) {}
        });

        String posBtnLabel = immediateSave
                ? Localize.t(this, "保存并应用", "Save & Apply")
                : Localize.t(this, "确定", "Confirm");
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setView(form)
                .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                .setPositiveButton(posBtnLabel, (d, w) -> {
                    int pIdx = profSpinner.getSelectedItemPosition();
                    String chosenPid = (pIdx >= 0 && pIdx < profileIds.size()) ? profileIds.get(pIdx) : "";
                    if (chosenPid.isEmpty()) {
                        callback.onChosen(null);
                        return;
                    }
                    int eIdx = effSpinner.getSelectedItemPosition();
                    String chosenEff = (eIdx >= 0 && eIdx < effOptions.size()) ? effOptions.get(eIdx) : "default";
                    try {
                        JSONObject routeObj = new JSONObject();
                        routeObj.put("profileId", chosenPid);
                        routeObj.put("effort", chosenEff);
                        if (existing != null && existing.has("fallbacks")) {
                            routeObj.put("fallbacks", copyJsonArray(existing.optJSONArray("fallbacks")));
                        }
                        callback.onChosen(routeObj);
                    } catch (Throwable ignored) {}
                })
                .show();
    }

    private void refreshEffortSpinner(String profileId) {
        boolean prev = mBindingSpinners;
        mBindingSpinners = true;
        try {
            mEffortOptionsForSpinner.clear();
            mEffortOptionsForSpinner.add("default");
            JSONObject prof = findById(mProfiles, profileId);
            JSONArray efforts = prof != null ? prof.optJSONArray("efforts") : null;
            if (efforts != null) {
                for (int i = 0; i < efforts.length(); i++) {
                    String e = jsonArrStr(efforts, i);
                    if (!e.isEmpty() && !mEffortOptionsForSpinner.contains(e)) {
                        mEffortOptionsForSpinner.add(e);
                    }
                }
            } else {
                for (String e : ALL_EFFORTS) mEffortOptionsForSpinner.add(e);
            }
            String currentEffort = mDefaultRoute != null ? UiChrome.jsonStr(mDefaultRoute, "effort", "default") : "default";
            int sel = mEffortOptionsForSpinner.indexOf(currentEffort);
            if (sel < 0) {
                sel = 0;
                if (mDefaultRoute != null && !mEffortOptionsForSpinner.isEmpty()) {
                    try {
                        mDefaultRoute.put("effort", mEffortOptionsForSpinner.get(0));
                    } catch (Throwable ignored) {}
                }
            }
            mDefaultEffortSpinner.setAdapter(new ArrayAdapter<>(
                    this, android.R.layout.simple_spinner_dropdown_item, mEffortOptionsForSpinner));
            mDefaultEffortSpinner.setSelection(sel, false);
        } finally {
            mBindingSpinners = prev;
        }
    }

    private void renderProvidersList(UiChrome.Palette p) {
        mProvidersContainer.removeAllViews();
        if (mProviders.length() == 0) {
            LinearLayout empty = UiChrome.makeCard(this, p);
            TextView tv = new TextView(this);
            tv.setText(Localize.t(this, "暂无模型服务商，点击右上角「+ 添加服务」开始配置。",
                    "No model providers yet. Tap + Add Provider above."));
            tv.setTextColor(p.textMuted);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            empty.addView(tv);
            mProvidersContainer.addView(empty);
            return;
        }
        for (int i = 0; i < mProviders.length(); i++) {
            JSONObject prov = mProviders.optJSONObject(i);
            if (prov == null) continue;
            final int index = i;
            String id = UiChrome.jsonStr(prov, "id");
            String name = UiChrome.jsonStr(prov, "name", id);
            String apiFormat = UiChrome.jsonStr(prov, "apiFormat", "openai");
            String baseUrl = UiChrome.jsonStr(prov, "baseUrl");
            boolean hasKey = prov.optBoolean("hasApiKey", false) || mPendingApiKeys.containsKey(id);

            LinearLayout card = UiChrome.makeCard(this, p);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = UiChrome.dp(this, 8);
            card.setLayoutParams(lp);

            LinearLayout topRow = new LinearLayout(this);
            topRow.setOrientation(LinearLayout.HORIZONTAL);
            topRow.setGravity(Gravity.CENTER_VERTICAL);
            TextView title = new TextView(this);
            title.setText(name + " (" + apiFormat + ")");
            title.setTextColor(p.textPrimary);
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            title.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            topRow.addView(title);

            TextView keyBadge = new TextView(this);
            keyBadge.setText(hasKey ? Localize.t(this, "已保存密钥", "Key Saved") : Localize.t(this, "缺少密钥", "Key Required"));
            keyBadge.setTextColor(hasKey ? p.success : p.danger);
            keyBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            topRow.addView(keyBadge);
            card.addView(topRow);

            TextView urlTv = new TextView(this);
            urlTv.setText(baseUrl);
            urlTv.setTextColor(p.textSecondary);
            urlTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            urlTv.setPadding(0, UiChrome.dp(this, 4), 0, UiChrome.dp(this, 8));
            card.addView(urlTv);

            LinearLayout btnRow = new LinearLayout(this);
            btnRow.setOrientation(LinearLayout.HORIZONTAL);
            TextView editBtn = UiChrome.makePillButton(this, Localize.t(this, "编辑", "Edit"), false, p,
                    v -> showProviderDialog(prov));
            editBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            editBtn.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 6), UiChrome.dp(this, 12), UiChrome.dp(this, 6));
            btnRow.addView(editBtn);

            View gap = new View(this);
            gap.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 8), 1));
            btnRow.addView(gap);

            boolean inUse = isProviderReferenced(id);
            TextView delBtn = UiChrome.makePillButton(this, Localize.t(this, "删除", "Delete"), false, p, v -> {
                if (isProviderReferenced(id)) {
                    Toast.makeText(this, Localize.t(this, "有模型档案正在使用此服务商，请先删除对应档案",
                            "Provider is referenced by a profile; remove those profiles first"), Toast.LENGTH_SHORT).show();
                    return;
                }
                removeJsonArrayItem(mProviders, index);
                mPendingApiKeys.remove(id);
                renderData();
            });
            delBtn.setTextColor(inUse ? p.textMuted : p.danger);
            delBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            delBtn.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 6), UiChrome.dp(this, 12), UiChrome.dp(this, 6));
            btnRow.addView(delBtn);

            card.addView(btnRow);
            mProvidersContainer.addView(card);
        }
    }

    private void renderProfilesList(UiChrome.Palette p) {
        mProfilesContainer.removeAllViews();
        if (mProfiles.length() == 0) {
            LinearLayout empty = UiChrome.makeCard(this, p);
            TextView tv = new TextView(this);
            tv.setText(Localize.t(this, "暂无模型档案，点击右上角「+ 添加档案」创建模型。",
                    "No model profiles yet. Tap + Add Profile above."));
            tv.setTextColor(p.textMuted);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            empty.addView(tv);
            mProfilesContainer.addView(empty);
            return;
        }
        String defProfileId = getSelectedDefaultProfileId();
        for (int i = 0; i < mProfiles.length(); i++) {
            JSONObject prof = mProfiles.optJSONObject(i);
            if (prof == null) continue;
            final int index = i;
            String id = UiChrome.jsonStr(prof, "id");
            String name = UiChrome.jsonStr(prof, "name", id);
            String model = UiChrome.jsonStr(prof, "model");
            String providerId = UiChrome.jsonStr(prof, "providerId");
            JSONObject prov = findById(mProviders, providerId);
            String provName = prov != null ? UiChrome.jsonStr(prov, "name", providerId) : providerId;
            boolean isDefault = id.equals(defProfileId);

            LinearLayout card = UiChrome.makeCard(this, p);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = UiChrome.dp(this, 8);
            card.setLayoutParams(lp);

            LinearLayout topRow = new LinearLayout(this);
            topRow.setOrientation(LinearLayout.HORIZONTAL);
            topRow.setGravity(Gravity.CENTER_VERTICAL);
            TextView title = new TextView(this);
            title.setText(name + " · " + model);
            title.setTextColor(p.textPrimary);
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            title.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            topRow.addView(title);

            if (isDefault) {
                TextView defBadge = new TextView(this);
                defBadge.setText(Localize.t(this, "默认", "Default"));
                defBadge.setTextColor(p.success);
                defBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                defBadge.setTypeface(Typeface.DEFAULT_BOLD);
                topRow.addView(defBadge);
            }
            card.addView(topRow);

            int ctxWin = prof.optInt("contextWindowTokens", 0);
            TextView metaTv = new TextView(this);
            metaTv.setText(Localize.t(this, "服务商: ", "Provider: ") + provName
                    + (ctxWin > 0 ? (" · ctx " + ctxWin) : ""));
            metaTv.setTextColor(p.textSecondary);
            metaTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            metaTv.setPadding(0, UiChrome.dp(this, 4), 0, UiChrome.dp(this, 8));
            card.addView(metaTv);

            LinearLayout btnRow = new LinearLayout(this);
            btnRow.setOrientation(LinearLayout.HORIZONTAL);
            if (!isDefault) {
                TextView useBtn = UiChrome.makePillButton(this, Localize.t(this, "设为默认", "Use"), false, p, v -> {
                    ensureDefaultRouteObject();
                    try {
                        mDefaultRoute.put("profileId", id);
                        mDefaultRoute.put("effort", "default");
                    } catch (Throwable ignored) {}
                    dropFallbacksMatchingPrimary();
                    renderData();
                });
                useBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                useBtn.setPadding(UiChrome.dp(this, 10), UiChrome.dp(this, 6), UiChrome.dp(this, 10), UiChrome.dp(this, 6));
                btnRow.addView(useBtn);
                View g0 = new View(this);
                g0.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 6), 1));
                btnRow.addView(g0);
            }

            TextView testBtn = UiChrome.makePillButton(this, Localize.t(this, "测试", "Test"), false, p,
                    v -> runTestModel(id));
            testBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            testBtn.setPadding(UiChrome.dp(this, 10), UiChrome.dp(this, 6), UiChrome.dp(this, 10), UiChrome.dp(this, 6));
            btnRow.addView(testBtn);

            View g1 = new View(this);
            g1.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 6), 1));
            btnRow.addView(g1);

            TextView editBtn = UiChrome.makePillButton(this, Localize.t(this, "编辑", "Edit"), false, p,
                    v -> showProfileDialog(prof));
            editBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            editBtn.setPadding(UiChrome.dp(this, 10), UiChrome.dp(this, 6), UiChrome.dp(this, 10), UiChrome.dp(this, 6));
            btnRow.addView(editBtn);

            View g2 = new View(this);
            g2.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 6), 1));
            btnRow.addView(g2);

            boolean inUse = isProfileReferenced(id);
            TextView delBtn = UiChrome.makePillButton(this, Localize.t(this, "删除", "Delete"), false, p, v -> {
                if (isProfileReferenced(id)) {
                    Toast.makeText(this, Localize.t(this, "默认路由或 Bot 路由正在使用此档案",
                            "Profile is in use by default or bot routes"), Toast.LENGTH_SHORT).show();
                    return;
                }
                removeJsonArrayItem(mProfiles, index);
                renderData();
            });
            delBtn.setTextColor(inUse ? p.textMuted : p.danger);
            delBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            delBtn.setPadding(UiChrome.dp(this, 10), UiChrome.dp(this, 6), UiChrome.dp(this, 10), UiChrome.dp(this, 6));
            btnRow.addView(delBtn);

            card.addView(btnRow);
            mProfilesContainer.addView(card);
        }
    }

    private void showAdminStepUpDialog() {
        UiChrome.Palette p = UiChrome.palette(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 12), UiChrome.dp(this, 18), UiChrome.dp(this, 8));

        EditText passInput = new EditText(this);
        UiChrome.styleEditText(passInput, p, this);
        passInput.setContentDescription("admin_stepup_password_input");
        passInput.setSingleLine(true);
        passInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passInput.setHint(Localize.t(this, "Host 管理员密码", "Host admin password"));
        box.addView(passInput);

        new AlertDialog.Builder(this)
                .setTitle(Localize.t(this, "管理员密码授权", "Admin Password Verification"))
                .setMessage(Localize.t(this, "管理员密码仅保存在本次会话内存中，不会写入本地存储。",
                        "Held in memory for this session only and never persisted to storage."))
                .setView(box)
                .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                .setPositiveButton(Localize.t(this, "解锁", "Unlock"), (d, w) -> {
                    String entered = passInput.getText() != null ? passInput.getText().toString() : "";
                    if (entered.isEmpty()) {
                        Toast.makeText(this, Localize.t(this, "请输入管理员密码", "Enter admin password"), Toast.LENGTH_SHORT).show();
                        return;
                    }
                    mAdminPassword = entered;
                    loadModelConfig();
                })
                .show();
    }

    private void showProviderDialog(final JSONObject existing) {
        UiChrome.Palette p = UiChrome.palette(this);
        boolean isEdit = existing != null;
        String existingId = isEdit ? UiChrome.jsonStr(existing, "id") : ("provider_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8));
        boolean existingHasKey = isEdit && (existing.optBoolean("hasApiKey", false) || mPendingApiKeys.containsKey(existingId));

        ScrollView sv = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 10), UiChrome.dp(this, 18), UiChrome.dp(this, 10));
        sv.addView(box);

        box.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "服务名称", "Provider Name"), p));
        EditText nameInput = new EditText(this);
        UiChrome.styleEditText(nameInput, p, this);
        nameInput.setContentDescription("provider_name_input");
        nameInput.setSingleLine(true);
        nameInput.setHint("OpenAI / Anthropic");
        nameInput.setText(isEdit ? UiChrome.jsonStr(existing, "name") : "");
        box.addView(nameInput);

        box.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "接口格式", "API Format"), p));
        Spinner formatSpinner = new Spinner(this);
        formatSpinner.setContentDescription("provider_format_spinner");
        formatSpinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, API_FORMATS));
        String curFmt = isEdit ? UiChrome.jsonStr(existing, "apiFormat", "openai") : "openai";
        int fmtIdx = Arrays.asList(API_FORMATS).indexOf(curFmt);
        if (fmtIdx >= 0) formatSpinner.setSelection(fmtIdx, false);
        box.addView(formatSpinner);

        box.addView(UiChrome.makeSectionLabel(this, "Base URL", p));
        EditText urlInput = new EditText(this);
        UiChrome.styleEditText(urlInput, p, this);
        urlInput.setContentDescription("provider_base_url_input");
        urlInput.setSingleLine(true);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        String initUrl = isEdit ? UiChrome.jsonStr(existing, "baseUrl") : defaultBaseUrlForFormat(curFmt);
        urlInput.setText(initUrl);
        box.addView(urlInput);

        formatSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int pos, long id) {
                String fmt = API_FORMATS[pos];
                String cur = urlInput.getText() != null ? urlInput.getText().toString().trim() : "";
                if (cur.isEmpty() || "https://api.openai.com/v1".equals(cur) || "https://api.anthropic.com".equals(cur)) {
                    urlInput.setText(defaultBaseUrlForFormat(fmt));
                }
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });

        box.addView(UiChrome.makeSectionLabel(this, "API Key", p));
        EditText keyInput = new EditText(this);
        UiChrome.styleEditText(keyInput, p, this);
        keyInput.setContentDescription("provider_api_key_input");
        keyInput.setSingleLine(true);
        keyInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        keyInput.setHint(existingHasKey
                ? Localize.t(this, "留空保留已保存密钥", "Leave blank to keep existing key")
                : Localize.t(this, "输入 API Key", "Enter API Key"));
        box.addView(keyInput);

        AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle(isEdit ? Localize.t(this, "编辑模型服务商", "Edit Provider") : Localize.t(this, "添加模型服务商", "Add Provider"))
                .setView(sv)
                .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                .setPositiveButton(Localize.t(this, "确定", "Save"), null)
                .create();
        dlg.setOnShowListener(di -> dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String name = nameInput.getText() != null ? nameInput.getText().toString().trim() : "";
            String fmt = API_FORMATS[formatSpinner.getSelectedItemPosition()];
            String baseUrl = urlInput.getText() != null ? urlInput.getText().toString().trim() : "";
            String apiKey = keyInput.getText() != null ? keyInput.getText().toString().trim() : "";

            if (name.isEmpty()) {
                Toast.makeText(this, Localize.t(this, "请填写服务名称", "Provider name is required"), Toast.LENGTH_SHORT).show();
                return;
            }
            if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
                Toast.makeText(this, Localize.t(this, "请填写有效 HTTP(S) Base URL", "Valid HTTP(S) Base URL required"), Toast.LENGTH_SHORT).show();
                return;
            }
            if (!existingHasKey && apiKey.isEmpty()) {
                Toast.makeText(this, Localize.t(this, "新服务商必须填写 API Key", "API Key is required for new provider"), Toast.LENGTH_SHORT).show();
                return;
            }

            try {
                JSONObject item = isEdit ? existing : new JSONObject();
                item.put("id", existingId);
                item.put("name", name);
                item.put("apiFormat", fmt);
                item.put("baseUrl", baseUrl.replaceAll("/+$", ""));
                if (!apiKey.isEmpty()) {
                    mPendingApiKeys.put(existingId, apiKey);
                    item.put("hasApiKey", true);
                } else {
                    item.put("hasApiKey", existingHasKey);
                }
                if (!isEdit) {
                    mProviders.put(item);
                }
                dlg.dismiss();
                renderData();
            } catch (Throwable t) {
                Toast.makeText(this, "Error: " + t.getMessage(), Toast.LENGTH_SHORT).show();
            }
        }));
        dlg.show();
    }

    private void showProfileDialog(final JSONObject existing) {
        if (mProviders.length() == 0) {
            Toast.makeText(this, Localize.t(this, "请先添加一个模型服务商", "Add a model provider first"), Toast.LENGTH_SHORT).show();
            showProviderDialog(null);
            return;
        }
        UiChrome.Palette p = UiChrome.palette(this);
        boolean isEdit = existing != null;
        String existingId = isEdit ? UiChrome.jsonStr(existing, "id") : ("profile_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8));

        ScrollView sv = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 10), UiChrome.dp(this, 18), UiChrome.dp(this, 10));
        sv.addView(box);

        box.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "档案名称", "Profile Name"), p));
        EditText nameInput = new EditText(this);
        UiChrome.styleEditText(nameInput, p, this);
        nameInput.setContentDescription("profile_name_input");
        nameInput.setSingleLine(true);
        nameInput.setHint("GPT-5 / Claude Sonnet");
        nameInput.setText(isEdit ? UiChrome.jsonStr(existing, "name") : "");
        box.addView(nameInput);

        box.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "所属服务商", "Provider"), p));
        Spinner provSpinner = new Spinner(this);
        provSpinner.setContentDescription("profile_provider_spinner");
        final List<String> provIds = new ArrayList<>();
        final List<String> provLabels = new ArrayList<>();
        int selProv = 0;
        String curProvId = isEdit ? UiChrome.jsonStr(existing, "providerId") : "";
        for (int i = 0; i < mProviders.length(); i++) {
            JSONObject pr = mProviders.optJSONObject(i);
            if (pr == null) continue;
            String id = UiChrome.jsonStr(pr, "id");
            provIds.add(id);
            provLabels.add(UiChrome.jsonStr(pr, "name", id) + " (" + UiChrome.jsonStr(pr, "apiFormat") + ")");
            if (id.equals(curProvId)) selProv = provIds.size() - 1;
        }
        provSpinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, provLabels));
        if (selProv < provLabels.size()) provSpinner.setSelection(selProv, false);
        box.addView(provSpinner);

        box.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "模型 ID", "Model ID"), p));
        EditText modelInput = new EditText(this);
        UiChrome.styleEditText(modelInput, p, this);
        modelInput.setContentDescription("profile_model_input");
        modelInput.setSingleLine(true);
        modelInput.setHint("gpt-5 / claude-sonnet-4-5");
        modelInput.setText(isEdit ? UiChrome.jsonStr(existing, "model") : "");
        box.addView(modelInput);

        box.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "上下文长度 / 摘要阈值（0 表示默认）", "Context / Summary Threshold (0 = default)"), p));
        LinearLayout ctxRow = new LinearLayout(this);
        ctxRow.setOrientation(LinearLayout.HORIZONTAL);
        EditText ctxInput = new EditText(this);
        UiChrome.styleEditText(ctxInput, p, this);
        ctxInput.setSingleLine(true);
        ctxInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        ctxInput.setHint("Context");
        ctxInput.setText(isEdit ? String.valueOf(existing.optInt("contextWindowTokens", 0)) : "0");
        ctxInput.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        ctxRow.addView(ctxInput);

        View cgap = new View(this);
        cgap.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 8), 1));
        ctxRow.addView(cgap);

        EditText sumInput = new EditText(this);
        UiChrome.styleEditText(sumInput, p, this);
        sumInput.setSingleLine(true);
        sumInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        sumInput.setHint("Summary");
        sumInput.setText(isEdit ? String.valueOf(existing.optInt("summaryThresholdTokens", 0)) : "0");
        sumInput.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        ctxRow.addView(sumInput);
        box.addView(ctxRow);

        box.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "支持的推理强度", "Supported Efforts"), p));
        LinearLayout effortGrid = new LinearLayout(this);
        effortGrid.setOrientation(LinearLayout.VERTICAL);
        Set<String> selectedEfforts = new HashSet<>();
        if (isEdit && existing.optJSONArray("efforts") != null) {
            JSONArray ea = existing.optJSONArray("efforts");
            for (int i = 0; i < ea.length(); i++) {
                String e = jsonArrStr(ea, i);
                if (!e.isEmpty()) selectedEfforts.add(e);
            }
        } else {
            selectedEfforts.addAll(Arrays.asList("low", "medium", "high"));
        }
        final Map<String, CheckBox> effortChecks = new HashMap<>();
        for (String eff : ALL_EFFORTS) {
            CheckBox cb = new CheckBox(this);
            cb.setText(eff);
            cb.setTextColor(p.textPrimary);
            cb.setChecked(selectedEfforts.contains(eff));
            effortChecks.put(eff, cb);
            effortGrid.addView(cb);
        }
        box.addView(effortGrid);

        addSpacing(box, 10);
        TextView catalogStatus = new TextView(this);
        catalogStatus.setTextColor(p.textSecondary);
        catalogStatus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        catalogStatus.setVisibility(View.GONE);

        TextView fetchBtn = UiChrome.makePillButton(this,
                Localize.t(this, "拉取模型列表 (Fetch Catalog)", "Fetch Catalog"), false, p, v -> {
                    int pidx = provSpinner.getSelectedItemPosition();
                    if (pidx < 0 || pidx >= provIds.size()) return;
                    JSONObject prov = findById(mProviders, provIds.get(pidx));
                    if (prov == null) return;
                    catalogStatus.setVisibility(View.VISIBLE);
                    catalogStatus.setText(Localize.t(this, "正在拉取模型列表…", "Fetching catalog…"));
                    new Thread(() -> {
                        try {
                            JSONObject req = new JSONObject().put("provider", serializeProviderForWrite(prov));
                            JSONObject reply = HostApiClient.fetchModelCatalog(this, req, mAdminPassword);
                            JSONArray models = reply.optJSONArray("models");
                            if (mDestroyed) return;
                            mMain.post(() -> {
                                if (mDestroyed || isFinishing()) return;
                                if (models == null || models.length() == 0) {
                                    catalogStatus.setText(Localize.t(this, "未返回可用模型", "No models returned"));
                                    return;
                                }
                                catalogStatus.setText(Localize.t(this, "已获取 " + models.length() + " 个模型",
                                        "Loaded " + models.length() + " models"));
                                showCatalogPickerDialog(models, item -> {
                                    String mid = UiChrome.jsonStr(item, "id");
                                    modelInput.setText(mid);
                                    if (nameInput.getText() == null || nameInput.getText().toString().trim().isEmpty()) {
                                        nameInput.setText(mid);
                                    }
                                    if (item.has("contextWindowTokens")) {
                                        ctxInput.setText(String.valueOf(item.optInt("contextWindowTokens", 0)));
                                    }
                                    if (item.has("summaryThresholdTokens")) {
                                        sumInput.setText(String.valueOf(item.optInt("summaryThresholdTokens", 0)));
                                    }
                                    JSONArray me = item.optJSONArray("efforts");
                                    if (me != null) {
                                        Set<String> set = new HashSet<>();
                                        for (int k = 0; k < me.length(); k++) {
                                            String ek = jsonArrStr(me, k);
                                            if (!ek.isEmpty()) set.add(ek);
                                        }
                                        for (Map.Entry<String, CheckBox> entry : effortChecks.entrySet()) {
                                            entry.getValue().setChecked(set.contains(entry.getKey()));
                                        }
                                    }
                                });
                            });
                        } catch (Throwable t) {
                            if (mDestroyed) return;
                            mMain.post(() -> {
                                if (mDestroyed || isFinishing()) return;
                                catalogStatus.setText(Localize.t(this, "拉取失败: ", "Catalog error: ") + t.getMessage());
                            });
                        }
                    }, "ModelCatalog").start();
                });
        fetchBtn.setContentDescription("fetch_catalog_button");
        box.addView(fetchBtn);
        box.addView(catalogStatus);

        AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle(isEdit ? Localize.t(this, "编辑模型档案", "Edit Profile") : Localize.t(this, "添加模型档案", "Add Profile"))
                .setView(sv)
                .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                .setPositiveButton(Localize.t(this, "确定", "Save"), null)
                .create();
        dlg.setOnShowListener(di -> dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String name = nameInput.getText() != null ? nameInput.getText().toString().trim() : "";
            String model = modelInput.getText() != null ? modelInput.getText().toString().trim() : "";
            int pidx = provSpinner.getSelectedItemPosition();
            String provId = (pidx >= 0 && pidx < provIds.size()) ? provIds.get(pidx) : "";
            if (name.isEmpty()) name = model;
            if (name.isEmpty() || model.isEmpty() || provId.isEmpty()) {
                Toast.makeText(this, Localize.t(this, "请填写档案名称和模型 ID", "Profile name and model ID are required"), Toast.LENGTH_SHORT).show();
                return;
            }
            int ctxTokens = parseNonNegativeInt(ctxInput.getText() != null ? ctxInput.getText().toString() : "0");
            int sumTokens = parseNonNegativeInt(sumInput.getText() != null ? sumInput.getText().toString() : "0");
            if (sumTokens > 0 && (ctxTokens <= 0 || sumTokens >= ctxTokens)) {
                Toast.makeText(this, Localize.t(this, "摘要阈值必须小于上下文长度", "Summary threshold must be < context window"), Toast.LENGTH_SHORT).show();
                return;
            }
            JSONArray effortsArr = new JSONArray();
            for (String eff : ALL_EFFORTS) {
                CheckBox cb = effortChecks.get(eff);
                if (cb != null && cb.isChecked()) effortsArr.put(eff);
            }
            try {
                JSONObject item = isEdit ? existing : new JSONObject();
                item.put("id", existingId);
                item.put("name", name);
                item.put("providerId", provId);
                item.put("model", model);
                item.put("efforts", effortsArr);
                item.put("contextWindowTokens", ctxTokens);
                item.put("summaryThresholdTokens", sumTokens);
                if (!isEdit) {
                    mProfiles.put(item);
                }
                if (mDefaultRoute == null || UiChrome.jsonStr(mDefaultRoute, "profileId").isEmpty()) {
                    ensureDefaultRouteObject();
                    mDefaultRoute.put("profileId", existingId);
                    mDefaultRoute.put("effort", "default");
                }
                dlg.dismiss();
                renderData();
            } catch (Throwable t) {
                Toast.makeText(this, "Error: " + t.getMessage(), Toast.LENGTH_SHORT).show();
            }
        }));
        dlg.show();
    }

    private interface CatalogSelectListener {
        void onSelected(JSONObject item);
    }

    private void showCatalogPickerDialog(JSONArray models, CatalogSelectListener listener) {
        final String[] labels = new String[models.length()];
        for (int i = 0; i < models.length(); i++) {
            JSONObject m = models.optJSONObject(i);
            String id = m != null ? UiChrome.jsonStr(m, "id") : "";
            int ctx = m != null ? m.optInt("contextWindowTokens", 0) : 0;
            labels[i] = ctx > 0 ? (id + " (" + ctx + " ctx)") : id;
        }
        new AlertDialog.Builder(this)
                .setTitle(Localize.t(this, "选择模型", "Choose Model"))
                .setItems(labels, (d, which) -> {
                    JSONObject picked = models.optJSONObject(which);
                    if (picked != null && listener != null) {
                        listener.onSelected(picked);
                    }
                })
                .show();
    }

    private void runTestModel(String profileId) {
        if (mProviders.length() == 0 || mProfiles.length() == 0) {
            Toast.makeText(this, Localize.t(this, "请先添加服务商和模型档案", "Add a provider and profile first"), Toast.LENGTH_SHORT).show();
            return;
        }
        UiChrome.Palette p = UiChrome.palette(this);
        mTestBtn.setEnabled(false);
        mActionProgress.setVisibility(View.VISIBLE);
        mActionResultText.setVisibility(View.VISIBLE);
        mActionResultText.setTextColor(p.blueAccent);
        mActionResultText.setText(Localize.t(this, "正在发送真实对话测试请求…", "Testing model connection…"));

        JSONObject payload;
        try {
            payload = buildSavePayload();
            if (profileId != null && !profileId.isEmpty()) {
                payload.put("profileId", profileId);
            }
        } catch (Throwable t) {
            mTestBtn.setEnabled(true);
            mActionProgress.setVisibility(View.GONE);
            mActionResultText.setTextColor(p.danger);
            mActionResultText.setText(t.getMessage());
            return;
        }

        new Thread(() -> {
            try {
                JSONObject res = HostApiClient.testModelConfig(this, payload, mAdminPassword);
                if (mDestroyed) return;
                String reply = UiChrome.jsonStr(res, "reply", "OK");
                String model = UiChrome.jsonStr(res, "model");
                long latency = res.optLong("latencyMs", -1L);
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mTestBtn.setEnabled(true);
                    mActionProgress.setVisibility(View.GONE);
                    mActionResultText.setTextColor(p.success);
                    mActionResultText.setText(Localize.t(this, "测试通过", "Test passed")
                            + (model.isEmpty() ? "" : (" (" + model + ")"))
                            + (latency >= 0 ? (" · " + latency + "ms") : "")
                            + ": " + reply);
                });
            } catch (HostApiClient.ApiException ae) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mTestBtn.setEnabled(true);
                    mActionProgress.setVisibility(View.GONE);
                    mActionResultText.setTextColor(p.danger);
                    mActionResultText.setText(Localize.t(this, "测试失败: ", "Test failed: ") + ae.getMessage());
                    if (ae.statusCode == 403) {
                        mAuthBlocked = true;
                        mStepUpCard.setVisibility(View.VISIBLE);
                        showAdminStepUpDialog();
                    }
                });
            } catch (Throwable t) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mTestBtn.setEnabled(true);
                    mActionProgress.setVisibility(View.GONE);
                    mActionResultText.setTextColor(p.danger);
                    mActionResultText.setText(Localize.t(this, "测试失败: ", "Test failed: ") + t.getMessage());
                });
            }
        }, "ModelTest").start();
    }

    private void saveModelConfig() {
        if (mProviders.length() == 0 || mProfiles.length() == 0) {
            Toast.makeText(this, Localize.t(this, "请至少添加一个服务商和模型档案", "Add at least one provider and profile"), Toast.LENGTH_SHORT).show();
            return;
        }
        UiChrome.Palette p = UiChrome.palette(this);
        JSONObject payload;
        try {
            payload = buildSavePayload();
        } catch (Throwable t) {
            Toast.makeText(this, t.getMessage(), Toast.LENGTH_LONG).show();
            return;
        }

        mSaveBtn.setEnabled(false);
        mActionProgress.setVisibility(View.VISIBLE);
        mActionResultText.setVisibility(View.VISIBLE);
        mActionResultText.setTextColor(p.blueAccent);
        mActionResultText.setText(Localize.t(this, "正在保存并通知 Host 重载…", "Saving and reloading Host…"));
        final int myToken = ++mReloadPollToken;

        new Thread(() -> {
            try {
                JSONObject res = HostApiClient.saveModelConfig(this, payload, mAdminPassword);
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mSaveBtn.setEnabled(true);
                    mAuthBlocked = false;
                    applyServerResponse(res, true);
                    renderData();
                    if ("waiting".equals(mReloadStatus) || "pending".equals(mReloadStatus)) {
                        mActionResultText.setTextColor(p.warning);
                        mActionResultText.setText(Localize.t(this, "配置已保存，等待 Host 应用中…", "Saved. Waiting for Host reload…"));
                        scheduleReloadPoll(myToken, mReloadRevision, 0);
                    } else if ("error".equals(mReloadStatus)) {
                        mActionProgress.setVisibility(View.GONE);
                        mActionResultText.setTextColor(p.danger);
                        mActionResultText.setText(Localize.t(this, "保存后重载失败: ", "Reload failed: ") + mReloadError);
                    } else {
                        mActionProgress.setVisibility(View.GONE);
                        mActionResultText.setTextColor(p.success);
                        mActionResultText.setText(Localize.t(this, "模型配置已保存并生效", "Model configuration saved and applied"));
                        if (mOnboarding && mConfigured) mContinueBtn.setVisibility(View.VISIBLE);
                    }
                });
            } catch (HostApiClient.ApiException ae) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mSaveBtn.setEnabled(true);
                    mActionProgress.setVisibility(View.GONE);
                    mActionResultText.setTextColor(p.danger);
                    mActionResultText.setText(Localize.t(this, "保存失败: ", "Save failed: ") + ae.getMessage());
                    if (ae.statusCode == 403) {
                        mAuthBlocked = true;
                        mStepUpCard.setVisibility(View.VISIBLE);
                        showAdminStepUpDialog();
                    }
                });
            } catch (Throwable t) {
                if (mDestroyed) return;
                mMain.post(() -> {
                    if (mDestroyed) return;
                    mSaveBtn.setEnabled(true);
                    mActionProgress.setVisibility(View.GONE);
                    mActionResultText.setTextColor(p.danger);
                    mActionResultText.setText(Localize.t(this, "保存失败: ", "Save failed: ") + t.getMessage());
                });
            }
        }, "ModelSave").start();
    }

    private void scheduleReloadPoll(final int token, final String expectedRevision, final int attempt) {
        if (mDestroyed || token != mReloadPollToken) return;
        if (attempt >= MAX_RELOAD_POLL_ATTEMPTS) {
            UiChrome.Palette p = UiChrome.palette(this);
            mActionProgress.setVisibility(View.GONE);
            mActionResultText.setTextColor(p.warning);
            mActionResultText.setText(Localize.t(this, "配置已写入，Host 仍在后台重启中，可稍后刷新查看。",
                    "Saved. Host is still reloading; tap Refresh shortly."));
            if (mOnboarding && mConfigured) mContinueBtn.setVisibility(View.VISIBLE);
            return;
        }
        mMain.postDelayed(() -> {
            if (mDestroyed || token != mReloadPollToken) return;
            new Thread(() -> {
                try {
                    JSONObject res = HostApiClient.getModelConfig(this, mAdminPassword);
                    if (mDestroyed || token != mReloadPollToken) return;
                    mMain.post(() -> {
                        if (mDestroyed || token != mReloadPollToken) return;
                        UiChrome.Palette p = UiChrome.palette(this);
                        JSONObject cfg = extractConfigObject(res);
                        JSONObject reload = res != null ? res.optJSONObject("reload") : null;
                        if (reload == null) reload = cfg.optJSONObject("reload");
                        applyReloadObject(reload);
                        String rev = mReloadRevision;
                        if (!expectedRevision.isEmpty() && !rev.isEmpty() && !expectedRevision.equals(rev)) {
                            mActionProgress.setVisibility(View.GONE);
                            return;
                        }
                        if ("applied".equals(mReloadStatus)) {
                            mActionProgress.setVisibility(View.GONE);
                            mActionResultText.setTextColor(p.success);
                            mActionResultText.setText(Localize.t(this, "模型配置已保存并生效", "Model configuration saved and applied"));
                            renderData();
                            if (mOnboarding && mConfigured) mContinueBtn.setVisibility(View.VISIBLE);
                        } else if ("error".equals(mReloadStatus)) {
                            mActionProgress.setVisibility(View.GONE);
                            mActionResultText.setTextColor(p.danger);
                            mActionResultText.setText(Localize.t(this, "Host 应用配置失败: ", "Host reload failed: ") + mReloadError);
                            renderData();
                        } else {
                            renderData();
                            scheduleReloadPoll(token, expectedRevision, attempt + 1);
                        }
                    });
                } catch (Throwable ignored) {
                    if (!mDestroyed && token == mReloadPollToken) {
                        mMain.post(() -> scheduleReloadPoll(token, expectedRevision, attempt + 1));
                    }
                }
            }, "ModelReloadPoll").start();
        }, RELOAD_POLL_INTERVAL_MS);
    }

    private JSONObject buildSavePayload() throws Exception {
        ensureDefaultRouteObject();
        String profileId = UiChrome.jsonStr(mDefaultRoute, "profileId");
        if (profileId.isEmpty() && mProfiles != null) {
            for (int i = 0; i < mProfiles.length(); i++) {
                JSONObject pf = mProfiles.optJSONObject(i);
                if (pf == null) continue;
                String candidate = UiChrome.jsonStr(pf, "id");
                if (!candidate.isEmpty()) {
                    profileId = candidate;
                    mDefaultRoute.put("profileId", profileId);
                    break;
                }
            }
        }
        if (profileId.isEmpty()) {
            throw new IllegalArgumentException(Localize.t(this, "请选择默认模型档案", "Select a default model profile"));
        }
        JSONArray outProviders = new JSONArray();
        for (int i = 0; i < mProviders.length(); i++) {
            JSONObject pr = mProviders.optJSONObject(i);
            if (pr != null) outProviders.put(serializeProviderForWrite(pr));
        }
        JSONArray outProfiles = new JSONArray();
        for (int i = 0; i < mProfiles.length(); i++) {
            JSONObject pf = mProfiles.optJSONObject(i);
            if (pf != null) outProfiles.put(copyJsonObject(pf));
        }
        JSONObject payload = new JSONObject();
        payload.put("version", 1);
        if (mRoutingMigrated) {
            payload.put("migrateLegacyRouting", true);
        }
        payload.put("providers", outProviders);
        payload.put("profiles", outProfiles);
        dropFallbacksMatchingPrimary();
        payload.put("defaultRoute", copyJsonObject(mDefaultRoute));
        payload.put("botRoutes", mBotRoutes != null ? copyJsonObject(mBotRoutes) : new JSONObject());
        JSONObject outScenarios = new JSONObject();
        if (mScenarioRoutes != null) {
            JSONArray sKeys = mScenarioRoutes.names();
            if (sKeys != null) {
                for (int i = 0; i < sKeys.length(); i++) {
                    String sk = jsonArrStr(sKeys, i);
                    JSONObject sr = !sk.isEmpty() ? mScenarioRoutes.optJSONObject(sk) : null;
                    if (sr != null && !UiChrome.jsonStr(sr, "profileId").isEmpty()) {
                        JSONObject clean = new JSONObject();
                        clean.put("profileId", UiChrome.jsonStr(sr, "profileId"));
                        clean.put("effort", UiChrome.jsonStr(sr, "effort", "default"));
                        outScenarios.put(sk, clean);
                    }
                }
            }
        }
        if (outScenarios.length() > 0) {
            payload.put("scenarioRoutes", outScenarios);
        }
        return payload;
    }

    private JSONObject serializeProviderForWrite(JSONObject prov) throws Exception {
        JSONObject out = new JSONObject();
        String id = UiChrome.jsonStr(prov, "id");
        out.put("id", id);
        out.put("name", UiChrome.jsonStr(prov, "name", id));
        out.put("apiFormat", UiChrome.jsonStr(prov, "apiFormat", "openai"));
        out.put("baseUrl", UiChrome.jsonStr(prov, "baseUrl"));
        String pendingKey = mPendingApiKeys.get(id);
        out.put("apiKey", pendingKey != null ? pendingKey : "");
        return out;
    }

    private void continueToMainApp() {
        RokBotBootstrap.reloadReactHost(this);
        String reactCls = discoverOriginalReactActivity();
        if (reactCls != null) {
            try {
                Intent intent = new Intent();
                intent.setComponent(new ComponentName(getPackageName(), reactCls));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(intent);
                finish();
                return;
            } catch (Throwable ignored) {}
        }
        finish();
    }

    @SuppressWarnings("deprecation")
    private String discoverOriginalReactActivity() {
        try {
            PackageManager pm = getPackageManager();
            Class<?> reactAct = Class.forName("com.facebook.react.ReactActivity");
            PackageInfo pkgInfo = pm.getPackageInfo(getPackageName(), PackageManager.GET_ACTIVITIES);
            if (pkgInfo != null && pkgInfo.activities != null) {
                for (ActivityInfo info : pkgInfo.activities) {
                    if (info == null || info.name == null) continue;
                    if (info.name.startsWith("dev.rokbot.nativeapp.")) continue;
                    try {
                        Class<?> cls = Class.forName(info.name);
                        if (reactAct.isAssignableFrom(cls)) return info.name;
                    } catch (Throwable ignored) {}
                }
            }
            Intent main = new Intent(Intent.ACTION_MAIN);
            main.addCategory(Intent.CATEGORY_LAUNCHER);
            main.setPackage(getPackageName());
            List<ResolveInfo> resolved = pm.queryIntentActivities(main, 0);
            if (resolved != null) {
                for (ResolveInfo ri : resolved) {
                    if (ri.activityInfo == null || ri.activityInfo.name == null) continue;
                    String candidate = ri.activityInfo.name;
                    if (candidate.startsWith("dev.rokbot.nativeapp.")) continue;
                    try {
                        Class<?> cls = Class.forName(candidate);
                        if (reactAct.isAssignableFrom(cls)) return candidate;
                    } catch (Throwable ignored) {}
                }
            }
        } catch (Throwable ignored) {}
        return null;
    }

    private String getSelectedDefaultProfileId() {
        if (mDefaultRoute != null) {
            String pid = UiChrome.jsonStr(mDefaultRoute, "profileId");
            if (!pid.isEmpty()) return pid;
        }
        if (mProfiles != null) {
            for (int i = 0; i < mProfiles.length(); i++) {
                JSONObject pf = mProfiles.optJSONObject(i);
                if (pf != null) {
                    String candidate = UiChrome.jsonStr(pf, "id");
                    if (!candidate.isEmpty()) return candidate;
                }
            }
        }
        return "";
    }

    private void ensureDefaultRouteObject() {
        if (mDefaultRoute == null) {
            mDefaultRoute = new JSONObject();
            try {
                mDefaultRoute.put("profileId", getSelectedDefaultProfileId());
                mDefaultRoute.put("effort", "default");
                mDefaultRoute.put("fallbacks", new JSONArray());
            } catch (Throwable ignored) {}
        }
    }

    /** Keep the default route's fallback chain free of the primary profile and of repeats. */
    private void dropFallbacksMatchingPrimary() {
        if (mDefaultRoute == null) return;
        JSONArray fbs = mDefaultRoute.optJSONArray("fallbacks");
        if (fbs == null) return;
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        seen.add(UiChrome.jsonStr(mDefaultRoute, "profileId"));
        JSONArray kept = new JSONArray();
        for (int i = 0; i < fbs.length(); i++) {
            JSONObject fb = fbs.optJSONObject(i);
            if (fb == null) continue;
            if (seen.add(UiChrome.jsonStr(fb, "profileId"))) kept.put(fb);
        }
        try { mDefaultRoute.put("fallbacks", kept); } catch (Throwable ignored) {}
    }

    private boolean isProviderReferenced(String providerId) {
        for (int i = 0; i < mProfiles.length(); i++) {
            JSONObject pf = mProfiles.optJSONObject(i);
            if (pf != null && providerId.equals(UiChrome.jsonStr(pf, "providerId"))) return true;
        }
        return false;
    }

    private boolean isProfileReferenced(String profileId) {
        if (mDefaultRoute != null) {
            if (profileId.equals(UiChrome.jsonStr(mDefaultRoute, "profileId"))) return true;
            JSONArray fbs = mDefaultRoute.optJSONArray("fallbacks");
            if (fbs != null) {
                for (int i = 0; i < fbs.length(); i++) {
                    JSONObject fb = fbs.optJSONObject(i);
                    if (fb != null && profileId.equals(UiChrome.jsonStr(fb, "profileId"))) return true;
                }
            }
        }
        if (mBotRoutes != null) {
            JSONArray keys = mBotRoutes.names();
            if (keys != null) {
                for (int i = 0; i < keys.length(); i++) {
                    String key = jsonArrStr(keys, i);
                    JSONObject route = !key.isEmpty() ? mBotRoutes.optJSONObject(key) : null;
                    if (route != null) {
                        if (profileId.equals(UiChrome.jsonStr(route, "profileId"))) return true;
                        JSONArray fbs = route.optJSONArray("fallbacks");
                        if (fbs != null) {
                            for (int j = 0; j < fbs.length(); j++) {
                                JSONObject fb = fbs.optJSONObject(j);
                                if (fb != null && profileId.equals(UiChrome.jsonStr(fb, "profileId"))) return true;
                            }
                        }
                    }
                }
            }
        }
        if (mScenarioRoutes != null) {
            JSONArray keys = mScenarioRoutes.names();
            if (keys != null) {
                for (int i = 0; i < keys.length(); i++) {
                    String key = jsonArrStr(keys, i);
                    JSONObject route = !key.isEmpty() ? mScenarioRoutes.optJSONObject(key) : null;
                    if (route != null && profileId.equals(UiChrome.jsonStr(route, "profileId"))) return true;
                }
            }
        }
        return false;
    }

    private static JSONObject findById(JSONArray arr, String id) {
        if (arr == null || id == null || id.isEmpty()) return null;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o != null && id.equals(UiChrome.jsonStr(o, "id"))) return o;
        }
        return null;
    }

    private static String jsonArrStr(JSONArray arr, int index) {
        if (arr == null || index < 0 || index >= arr.length() || arr.isNull(index)) return "";
        String v = arr.optString(index, "");
        return "null".equals(v) ? "" : v.trim();
    }

    private static void removeJsonArrayItem(JSONArray arr, int idx) {
        if (arr == null || idx < 0 || idx >= arr.length()) return;
        arr.remove(idx);
    }

    private static JSONArray copyJsonArray(JSONArray src) {
        if (src == null) return new JSONArray();
        try {
            return new JSONArray(src.toString());
        } catch (Throwable t) {
            return new JSONArray();
        }
    }

    private static JSONObject copyJsonObject(JSONObject src) {
        if (src == null) return new JSONObject();
        try {
            return new JSONObject(src.toString());
        } catch (Throwable t) {
            return new JSONObject();
        }
    }

    private static String defaultBaseUrlForFormat(String apiFormat) {
        return "anthropic".equals(apiFormat) ? "https://api.anthropic.com" : "https://api.openai.com/v1";
    }

    private static int parseNonNegativeInt(String raw) {
        try {
            int v = Integer.parseInt(raw != null ? raw.trim() : "0");
            return Math.max(0, v);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    private void addSpacing(LinearLayout parent, int dp) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, dp)));
        parent.addView(v);
    }
}

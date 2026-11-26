package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

import dev.grokbot.local.TailcatBridge;

public class PairingActivity extends Activity {
    public static final String EXTRA_SHOW_SETTINGS = "showSettings";
    public static final String EXTRA_FROM_RN_MODAL = "fromRnModal";
    public static final String EXTRA_HOST = "host";
    public static final String EXTRA_CODE = "pairingCode";

    private EditText mHostInput;
    private EditText mCodeInput;
    private EditText mPasswordInput;
    private TextView mCodeLabel;
    private TextView mPassLabel;
    private TextView mCodeModeBtn;
    private TextView mPassModeBtn;
    private TextView mPairButton;
    private ProgressBar mProgress;
    private TextView mStatusText;
    private LinearLayout mScanResultsBox;
    private TextView mDirectTabBtn;
    private TextView mTailcatTabBtn;
    private View mScanRow;
    private boolean mTailcatMode = false;
    private boolean mUsePasswordMode = false;
    private boolean mEditingConnection = false;
    /** "添加新连接": full pairing while another connection stays saved in the history. */
    private boolean mAddingConnection = false;
    private boolean mFromRnModal = false;
    private String mDraftHost = null;
    private String mDraftCode = null;
    private final Handler mMainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean mDestroyed = false;

    private LinearLayout mNeedsModelBanner;
    private LinearLayout mUpdateBannerCard;
    private TextView mUpdateTitleText;
    private TextView mUpdateNotesText;
    private TextView mUpdateStatusText;
    private ProgressBar mUpdateProgressBar;
    private TextView mInstallUpdateBtn;
    private TextView mCheckUpdatesBtn;
    private UpdateManager.UpdateManifestInfo mAvailableUpdate = null;
    private File mStagedUpdateApk = null;
    private boolean mUpdateStaging = false;
    private boolean mPendingInstallAfterPerm = false;

    // Connection & Diagnostics (rokbot.3)
    public static final String EXTRA_ADD_CONNECTION = "addConnection";
    private ConnectionProbe mProbe;
    private ConnectionProbe.Status mLastStatus;
    private TextView mStatusLine;
    private TextView mStatusBadge;
    private TextView mCurrentRowStatus;
    private TextView mDiagPath;
    private TextView mDiagLatency;
    private android.app.AlertDialog mBusyDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        Storage.init(this);

        boolean showSettings = getIntent().getBooleanExtra(EXTRA_SHOW_SETTINGS, false);
        mFromRnModal = getIntent().getBooleanExtra(EXTRA_FROM_RN_MODAL, false);
        if (Storage.isPaired(this) && !showSettings) {
            String rnCls = discoverOriginalReactActivity();
            if (rnCls != null) {
                routePairedLaunchWithModelCheck();
                return;
            }
        }
        mTailcatMode = Storage.isTailcatEnabled(this);
        if (savedInstanceState != null) {
            mTailcatMode = savedInstanceState.getBoolean("state_tailcat", mTailcatMode);
            mUsePasswordMode = savedInstanceState.getBoolean("state_pwd_mode", false);
            mEditingConnection = savedInstanceState.getBoolean("state_editing", false);
            mDraftHost = savedInstanceState.getString("state_host");
            mDraftCode = savedInstanceState.getString("state_code");
            mAddingConnection = savedInstanceState.getBoolean("state_adding", false);
        } else if (getIntent() != null && getIntent().getBooleanExtra(EXTRA_ADD_CONNECTION, false)) {
            mAddingConnection = true;
        }
        renderScreen();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (mPendingInstallAfterPerm && mStagedUpdateApk != null && mStagedUpdateApk.isFile()) {
            if (Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls()) {
                mPendingInstallAfterPerm = false;
                try {
                    UpdateManager.launchInstaller(this, mStagedUpdateApk);
                } catch (Throwable t) {
                    Toast.makeText(this, Localize.t(this, "拉起安装器失败：", "Installer error: ") + t.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
        }
        if (Storage.isPaired(this) && !mEditingConnection && mNeedsModelBanner != null) {
            refreshNeedsModelBanner();
        }
        startProbeIfConnected();
    }

    @Override
    protected void onPause() {
        stopProbe();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        mDestroyed = true;
        stopProbe();
        if (mBusyDialog != null) {
            try { mBusyDialog.dismiss(); } catch (Throwable ignored) {}
            mBusyDialog = null;
        }
        mMainHandler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void routePairedLaunchWithModelCheck() {
        UiChrome.Palette p = UiChrome.palette(this);
        LinearLayout loading = new LinearLayout(this);
        loading.setGravity(Gravity.CENTER);
        loading.setBackgroundColor(p.bgPaper);
        loading.addView(new ProgressBar(this));
        setContentView(loading);
        UiChrome.applyRootInsets(this, loading);

        new Thread(() -> {
            boolean needsModel = false;
            try {
                JSONObject status = HostApiClient.getHostStatus(this);
                needsModel = status != null && status.optBoolean("needsModel", false);
            } catch (Throwable ignored) {}
            final boolean shouldOnboardModel = needsModel;
            if (mDestroyed) return;
            mMainHandler.post(() -> {
                if (mDestroyed || isFinishing()) return;
                if (shouldOnboardModel) {
                    Intent i = new Intent(this, ModelsActivity.class);
                    i.putExtra(ModelsActivity.EXTRA_ONBOARDING, true);
                    startActivity(i);
                    finish();
                } else {
                    returnToMainApp();
                }
            });
        }, "RokBotPairedLaunchCheck").start();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putBoolean("state_tailcat", mTailcatMode);
        outState.putBoolean("state_pwd_mode", mUsePasswordMode);
        outState.putBoolean("state_editing", mEditingConnection);
        outState.putBoolean("state_adding", mAddingConnection);
        if (mHostInput != null && mHostInput.getText() != null) {
            outState.putString("state_host", mHostInput.getText().toString());
        }
        if (mCodeInput != null && mCodeInput.getText() != null) {
            outState.putString("state_code", mCodeInput.getText().toString());
        }
    }

    private void renderScreen() {
        boolean connected = Storage.isPaired(this) && !mEditingConnection && !mAddingConnection;
        stopProbe();
        mStatusLine = null;
        mStatusBadge = null;
        mCurrentRowStatus = null;
        mDiagPath = null;
        mDiagLatency = null;
        if (connected) {
            buildConnectedUi();
            startProbeIfConnected();
        } else {
            buildPairingUi();
        }
    }

    private void returnToMainApp() {
        RokBotBootstrap.reloadReactHost(this);
        if (mFromRnModal) {
            setResult(RESULT_OK);
            finish();
            return;
        }
        String reactCls = discoverOriginalReactActivity();
        if (reactCls != null) {
            try {
                Intent intent = new Intent();
                intent.setComponent(new ComponentName(getPackageName(), reactCls));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                if (getIntent() != null && getIntent().getData() != null) {
                    intent.setData(RokBotBootstrap.normalizeDeepLink(getIntent().getData()));
                }
                startActivity(intent);
                finish();
                return;
            } catch (Throwable ignored) {}
        }
        renderScreen();
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
                        if (reactAct.isAssignableFrom(cls)) {
                            return info.name;
                        }
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
                        if (reactAct.isAssignableFrom(cls)) {
                            return candidate;
                        }
                    } catch (Throwable ignored) {}
                }
            }
        } catch (Throwable ignored) {}
        return null;
    }

    private View makeTopBarRow(UiChrome.Palette p, boolean showDismiss) {
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.bottomMargin = UiChrome.dp(this, 12);
        top.setLayoutParams(tlp);

        if (showDismiss) {
            View closeBtn = UiChrome.makeVectorIconButton(this, "close", "close_pairing_button", p, v -> finish());
            LinearLayout.LayoutParams clp = (LinearLayout.LayoutParams) closeBtn.getLayoutParams();
            clp.width = UiChrome.dp(this, 36);
            clp.height = UiChrome.dp(this, 36);
            clp.rightMargin = UiChrome.dp(this, 10);
            closeBtn.setLayoutParams(clp);
            top.addView(closeBtn);
        }

        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(0, 1, 1f));
        top.addView(spacer);

        String langPref = Localize.getPreferredLanguage(this);
        String langLabel = Localize.LANG_ZH.equals(langPref) ? "中文"
                : (Localize.LANG_EN.equals(langPref) ? "EN" : Localize.t(this, "中/EN", "EN/中"));
        TextView langBtn = UiChrome.makePillButton(this, langLabel, false, p, v -> {
            String cur = Localize.getPreferredLanguage(this);
            String next = Localize.LANG_AUTO.equals(cur) ? Localize.LANG_ZH
                    : (Localize.LANG_ZH.equals(cur) ? Localize.LANG_EN : Localize.LANG_AUTO);
            Localize.setPreferredLanguage(this, next);
            renderScreen();
        });
        langBtn.setContentDescription("language_switch_button");
        langBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        langBtn.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 6), UiChrome.dp(this, 12), UiChrome.dp(this, 6));
        top.addView(langBtn);

        View themeBtn = UiChrome.makeVectorIconButton(this, p.dark ? "moon" : "sun", "theme_switch_button", p, v -> {
            String cur = Storage.getThemePreference(this);
            String next = "auto".equals(cur) ? "light" : ("light".equals(cur) ? "dark" : "auto");
            Storage.setThemePreference(this, next);
            renderScreen();
        });
        LinearLayout.LayoutParams thLp = (LinearLayout.LayoutParams) themeBtn.getLayoutParams();
        thLp.leftMargin = UiChrome.dp(this, 8);
        thLp.width = UiChrome.dp(this, 36);
        thLp.height = UiChrome.dp(this, 36);
        themeBtn.setLayoutParams(thLp);
        top.addView(themeBtn);
        return top;
    }

    private void buildConnectedUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(p.bgPaper);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(UiChrome.dp(this, 22), UiChrome.dp(this, 14), UiChrome.dp(this, 22), UiChrome.dp(this, 28));
        scroll.addView(root);

        root.addView(makeTopBarRow(p, mFromRnModal || discoverOriginalReactActivity() != null));

        root.addView(UiChrome.makeRokLogoView(this, 52, p));
        addSpacing(root, 12);

        TextView heading = new TextView(this);
        heading.setText(Localize.t(this, "连接与诊断", "Connection & Diagnostics"));
        heading.setContentDescription("connection_diagnostics_title");
        heading.setTextColor(p.textPrimary);
        heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 25);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        heading.setPadding(0, 0, 0, UiChrome.dp(this, 14));
        root.addView(heading);

        root.addView(buildCurrentConnectionCard(p));

        // Non-blocking needsModel onboarding banner
        mNeedsModelBanner = UiChrome.makeCard(this, p);
        mNeedsModelBanner.setContentDescription("needs_model_banner");
        LinearLayout.LayoutParams nmbLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nmbLp.topMargin = UiChrome.dp(this, 10);
        mNeedsModelBanner.setLayoutParams(nmbLp);
        TextView nmbTitle = new TextView(this);
        nmbTitle.setText(Localize.t(this, "● 尚未配置对话模型", "● Model setup required"));
        nmbTitle.setTextColor(p.warning);
        nmbTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        nmbTitle.setTypeface(Typeface.DEFAULT_BOLD);
        mNeedsModelBanner.addView(nmbTitle);
        TextView nmbDesc = new TextView(this);
        nmbDesc.setText(Localize.t(this,
                "配置一个模型服务（如 OpenAI / Anthropic）即可开始对话。",
                "Configure a model provider (e.g. OpenAI or Anthropic) to start chatting."));
        nmbDesc.setTextColor(p.textSecondary);
        nmbDesc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        nmbDesc.setPadding(0, UiChrome.dp(this, 4), 0, UiChrome.dp(this, 10));
        mNeedsModelBanner.addView(nmbDesc);
        TextView nmbBtn = UiChrome.makePillButton(this,
                Localize.t(this, "立即配置模型", "Configure Model"), true, p,
                v -> {
                    Intent i = new Intent(this, ModelsActivity.class);
                    i.putExtra(ModelsActivity.EXTRA_ONBOARDING, true);
                    startActivity(i);
                });
        nmbBtn.setContentDescription("configure_model_banner_button");
        mNeedsModelBanner.addView(nmbBtn);
        mNeedsModelBanner.setVisibility(View.GONE);
        root.addView(mNeedsModelBanner);

        // Update banner card (shown when update available or checking manually)
        mUpdateBannerCard = UiChrome.makeCard(this, p);
        mUpdateBannerCard.setContentDescription("update_banner_card");
        LinearLayout.LayoutParams ubLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ubLp.topMargin = UiChrome.dp(this, 10);
        mUpdateBannerCard.setLayoutParams(ubLp);

        mUpdateTitleText = new TextView(this);
        mUpdateTitleText.setTextColor(p.textPrimary);
        mUpdateTitleText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mUpdateTitleText.setTypeface(Typeface.DEFAULT_BOLD);
        mUpdateBannerCard.addView(mUpdateTitleText);

        mUpdateNotesText = new TextView(this);
        mUpdateNotesText.setTextColor(p.textSecondary);
        mUpdateNotesText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mUpdateNotesText.setPadding(0, UiChrome.dp(this, 4), 0, 0);
        mUpdateNotesText.setVisibility(View.GONE);
        mUpdateBannerCard.addView(mUpdateNotesText);

        mUpdateStatusText = new TextView(this);
        mUpdateStatusText.setContentDescription("update_status_text");
        mUpdateStatusText.setTextColor(p.textSecondary);
        mUpdateStatusText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mUpdateStatusText.setPadding(0, UiChrome.dp(this, 6), 0, UiChrome.dp(this, 8));
        mUpdateBannerCard.addView(mUpdateStatusText);

        mUpdateProgressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        mUpdateProgressBar.setContentDescription("update_progress_bar");
        mUpdateProgressBar.setMax(100);
        LinearLayout.LayoutParams pbLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pbLp.bottomMargin = UiChrome.dp(this, 8);
        mUpdateProgressBar.setLayoutParams(pbLp);
        mUpdateProgressBar.setVisibility(View.GONE);
        mUpdateBannerCard.addView(mUpdateProgressBar);

        mInstallUpdateBtn = UiChrome.makePillButton(this,
                Localize.t(this, "下载并安装更新", "Download & Install"), true, p,
                v -> onInstallUpdateButtonClicked());
        mInstallUpdateBtn.setContentDescription("install_update_button");
        mInstallUpdateBtn.setVisibility(View.GONE);
        mUpdateBannerCard.addView(mInstallUpdateBtn);

        mUpdateBannerCard.setVisibility(View.GONE);
        root.addView(mUpdateBannerCard);

        String originalReact = discoverOriginalReactActivity();
        if (mFromRnModal || originalReact != null) {
            addSpacing(root, 18);
            TextView doneBtn = UiChrome.makePillButton(this,
                    Localize.t(this, "回到 RokBot", "Return to RokBot"), true, p,
                    v -> returnToMainApp());
            doneBtn.setContentDescription("return_to_app_button");
            root.addView(doneBtn);
        }

        addSpacing(root, 6);
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "连接历史", "Connection history"), p));
        root.addView(buildHistoryCard(p, true));

        if (ListArrangement.isAvailable(this)) {
            root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "会话列表", "Chat list"), p));
            root.addView(buildListSortCard(p));
        }

        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "Bot 动态图标", "Bot avatar style"), p));
        root.addView(buildAvatarStyleCard(p));

        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "诊断", "Diagnostics"), p));
        root.addView(buildDiagnosticsCard(p));

        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "更多", "More"), p));
        LinearLayout quickGrid1 = new LinearLayout(this);
        quickGrid1.setOrientation(LinearLayout.HORIZONTAL);
        TextView pushBtn = UiChrome.makePillButton(this, Localize.t(this, "通知设置", "Notifications"), false, p,
                v -> startActivity(new Intent(this, PushSettingsActivity.class)));
        pushBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        quickGrid1.addView(pushBtn);
        View sp1 = new View(this);
        sp1.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 8), 1));
        quickGrid1.addView(sp1);
        TextView profBtn = UiChrome.makePillButton(this, Localize.t(this, "个人资料", "Profile"), false, p,
                v -> startActivity(new Intent(this, ProfileActivity.class)));
        profBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        quickGrid1.addView(profBtn);
        root.addView(quickGrid1);

        addSpacing(root, 8);
        LinearLayout quickGrid2 = new LinearLayout(this);
        quickGrid2.setOrientation(LinearLayout.HORIZONTAL);
        TextView libBtn = UiChrome.makePillButton(this, Localize.t(this, "资料库", "Library"), false, p,
                v -> {
                    Intent i = new Intent(this, LibraryActivity.class);
                    String agentId = RokBotBootstrap.getLastAgentId();
                    if (agentId != null && !agentId.isEmpty()) i.putExtra(LibraryActivity.EXTRA_AGENT_ID, agentId);
                    startActivity(i);
                });
        libBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        quickGrid2.addView(libBtn);
        View sp2 = new View(this);
        sp2.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 8), 1));
        quickGrid2.addView(sp2);
        TextView compBtn = UiChrome.makePillButton(this, Localize.t(this, "Bot 电脑", "Bot Computers"), false, p,
                v -> startActivity(new Intent(this, ComputersActivity.class)));
        compBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        quickGrid2.addView(compBtn);
        root.addView(quickGrid2);

        addSpacing(root, 8);
        LinearLayout quickGrid3 = new LinearLayout(this);
        quickGrid3.setOrientation(LinearLayout.HORIZONTAL);
        TextView usageBtn = UiChrome.makePillButton(this, Localize.t(this, "用量", "Usage"), false, p,
                v -> startActivity(new Intent(this, UsageActivity.class)));
        usageBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        quickGrid3.addView(usageBtn);
        View sp3 = new View(this);
        sp3.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 8), 1));
        quickGrid3.addView(sp3);
        TextView modelsBtn = UiChrome.makePillButton(this, Localize.t(this, "模型设置", "Model Settings"), false, p,
                v -> startActivity(new Intent(this, ModelsActivity.class)));
        modelsBtn.setContentDescription("model_settings_button");
        modelsBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        quickGrid3.addView(modelsBtn);
        root.addView(quickGrid3);

        addSpacing(root, 8);
        LinearLayout quickGrid4 = new LinearLayout(this);
        quickGrid4.setOrientation(LinearLayout.HORIZONTAL);
        mCheckUpdatesBtn = UiChrome.makePillButton(this, Localize.t(this, "检查更新", "Check for Updates"), false, p,
                v -> startActivity(new Intent(this, UpdateActivity.class)));
        mCheckUpdatesBtn.setContentDescription("check_for_updates_button");
        mCheckUpdatesBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        quickGrid4.addView(mCheckUpdatesBtn);
        View sp4 = new View(this);
        sp4.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 8), 1));
        quickGrid4.addView(sp4);
        TextView editBtn = UiChrome.makePillButton(this, Localize.t(this, "修改连接", "Edit Connection"), false, p, v -> {
            mEditingConnection = true;
            renderScreen();
        });
        editBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        quickGrid4.addView(editBtn);
        root.addView(quickGrid4);

        addSpacing(root, 16);
        TextView unpairBtn = UiChrome.makePillButton(this,
                Localize.t(this, "断开并解除配对", "Disconnect & Unpair"), false, p, v -> {
                    ConnectionHistory.forgetCurrent(this);
                    TailcatManager.get().clear();
                    Storage.clearCredentials(this);
                    RokBotBootstrap.clearPairedBundle(this);
                    mAvailableUpdate = null;
                    mStagedUpdateApk = null;
                    mPendingInstallAfterPerm = false;
                    PushManager.getInstance(this).onForegroundChanged(false);
                    NotificationService.sync(this);
                    RokBotBootstrap.reloadReactHost(this);
                    Toast.makeText(this, Localize.t(this, "已解除配对", "Unpaired from Host"), Toast.LENGTH_SHORT).show();
                    renderScreen();
                });
        unpairBtn.setTextColor(p.danger);
        root.addView(unpairBtn);

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);

        refreshNeedsModelBanner();
        // Automatic checks, prompts and installs live in AppUpdater / UpdateActivity.
        if (mAvailableUpdate != null) {
            renderAvailableUpdateBanner(mAvailableUpdate);
        }
    }

    private void refreshNeedsModelBanner() {
        new Thread(() -> {
            boolean needsModel = false;
            try {
                JSONObject st = HostApiClient.getHostStatus(this);
                needsModel = st != null && st.optBoolean("needsModel", false);
            } catch (Throwable ignored) {}
            final boolean show = needsModel;
            if (mDestroyed) return;
            mMainHandler.post(() -> {
                if (mDestroyed || mNeedsModelBanner == null) return;
                mNeedsModelBanner.setVisibility(show ? View.VISIBLE : View.GONE);
            });
        }, "RokBotConnectedModelCheck").start();
    }

    private void runUpdateCheck(final boolean userInitiated) {
        if (mUpdateStaging) return;
        String feedUrl = UpdateManager.resolveDefaultFeedUrl(this);
        if (feedUrl.isEmpty()) {
            if (userInitiated) {
                Toast.makeText(this, Localize.t(this, "未配置更新源地址", "No update feed URL configured"), Toast.LENGTH_SHORT).show();
            }
            return;
        }
        if (userInitiated) {
            UiChrome.Palette p = UiChrome.palette(this);
            if (mCheckUpdatesBtn != null) mCheckUpdatesBtn.setEnabled(false);
            if (mUpdateBannerCard != null) mUpdateBannerCard.setVisibility(View.VISIBLE);
            if (mUpdateTitleText != null) mUpdateTitleText.setText(Localize.t(this, "正在检查更新…", "Checking for updates…"));
            if (mUpdateNotesText != null) mUpdateNotesText.setVisibility(View.GONE);
            if (mUpdateStatusText != null) {
                mUpdateStatusText.setTextColor(p.textSecondary);
                mUpdateStatusText.setText(Localize.t(this, "当前版本: ", "Current: ") + UpdateManager.getCurrentVersionLabel(this));
            }
            if (mUpdateProgressBar != null) mUpdateProgressBar.setVisibility(View.GONE);
            if (mInstallUpdateBtn != null) mInstallUpdateBtn.setVisibility(View.GONE);
        }
        UpdateManager.checkManifestAsync(this, feedUrl, new UpdateManager.CheckCallback() {
            @Override
            public void onUpToDate(String currentVersion, String shortSha) {
                if (mDestroyed) return;
                mMainHandler.post(() -> {
                    if (mDestroyed) return;
                    if (mCheckUpdatesBtn != null) mCheckUpdatesBtn.setEnabled(true);
                    mAvailableUpdate = null;
                    if (userInitiated && mUpdateBannerCard != null) {
                        UiChrome.Palette p = UiChrome.palette(PairingActivity.this);
                        mUpdateBannerCard.setVisibility(View.VISIBLE);
                        mUpdateTitleText.setText(Localize.t(PairingActivity.this, "● 已是最新版本", "● Up to date"));
                        mUpdateNotesText.setVisibility(View.GONE);
                        mUpdateStatusText.setTextColor(p.success);
                        mUpdateStatusText.setText(currentVersion + " [" + shortSha + "]");
                        mUpdateProgressBar.setVisibility(View.GONE);
                        mInstallUpdateBtn.setVisibility(View.GONE);
                    }
                });
            }

            @Override
            public void onUpdateAvailable(UpdateManager.UpdateManifestInfo info) {
                if (mDestroyed) return;
                mMainHandler.post(() -> {
                    if (mDestroyed) return;
                    if (mCheckUpdatesBtn != null) mCheckUpdatesBtn.setEnabled(true);
                    mAvailableUpdate = info;
                    mStagedUpdateApk = info.alreadyStaged ? info.stagedFile : null;
                    renderAvailableUpdateBanner(info);
                });
            }

            @Override
            public void onError(String message) {
                if (mDestroyed) return;
                mMainHandler.post(() -> {
                    if (mDestroyed) return;
                    if (mCheckUpdatesBtn != null) mCheckUpdatesBtn.setEnabled(true);
                    if (userInitiated && mUpdateBannerCard != null) {
                        UiChrome.Palette p = UiChrome.palette(PairingActivity.this);
                        mUpdateBannerCard.setVisibility(View.VISIBLE);
                        mUpdateTitleText.setText(Localize.t(PairingActivity.this, "检查更新失败", "Update check failed"));
                        mUpdateNotesText.setVisibility(View.GONE);
                        mUpdateStatusText.setTextColor(p.danger);
                        mUpdateStatusText.setText(message);
                        mUpdateProgressBar.setVisibility(View.GONE);
                        mInstallUpdateBtn.setVisibility(View.GONE);
                    }
                });
            }
        });
    }

    private void renderAvailableUpdateBanner(UpdateManager.UpdateManifestInfo info) {
        if (mUpdateBannerCard == null || info == null) return;
        UiChrome.Palette p = UiChrome.palette(this);
        mUpdateBannerCard.setVisibility(View.VISIBLE);
        mUpdateTitleText.setText(Localize.t(this, "发现新版本: ", "Update Available: ")
                + info.currentVersionLabel + " → " + info.versionLabel);
        if (info.releaseNotes != null && !info.releaseNotes.isEmpty()) {
            mUpdateNotesText.setText(info.releaseNotes);
            mUpdateNotesText.setVisibility(View.VISIBLE);
        } else {
            mUpdateNotesText.setVisibility(View.GONE);
        }
        String sizeSummary;
        if (mStagedUpdateApk != null && mStagedUpdateApk.isFile()) {
            sizeSummary = Localize.t(this, "更新包已下载校验完成，点击立即安装。", "Update verified and ready to install.");
            mInstallUpdateBtn.setText(Localize.t(this, "立即安装更新", "Install Now"));
        } else if (info.hasDelta) {
            int savedPct = (int) Math.max(0, Math.round((1.0 - (double) info.deltaSize / (double) Math.max(1L, info.fullSize)) * 100.0));
            sizeSummary = Localize.t(this,
                    "增量补丁: " + UpdateManager.formatBytes(info.deltaSize) + " / 完整包 "
                            + UpdateManager.formatBytes(info.fullSize) + "（节省 " + savedPct + "%）",
                    "Delta: " + UpdateManager.formatBytes(info.deltaSize) + " / Full: "
                            + UpdateManager.formatBytes(info.fullSize) + " (saves " + savedPct + "%)");
            mInstallUpdateBtn.setText(Localize.t(this, "下载并安装更新", "Download & Install"));
        } else {
            sizeSummary = Localize.t(this,
                    "完整安装包: " + UpdateManager.formatBytes(info.fullSize),
                    "Full APK: " + UpdateManager.formatBytes(info.fullSize));
            mInstallUpdateBtn.setText(Localize.t(this, "下载并安装更新", "Download & Install"));
        }
        mUpdateStatusText.setTextColor(p.blueAccent);
        mUpdateStatusText.setText(sizeSummary);
        mUpdateProgressBar.setVisibility(View.GONE);
        mInstallUpdateBtn.setVisibility(View.VISIBLE);
        mInstallUpdateBtn.setEnabled(true);
    }

    private void onInstallUpdateButtonClicked() {
        if (mUpdateStaging) return;
        if (mStagedUpdateApk != null && mStagedUpdateApk.isFile()) {
            launchStagedInstaller();
            return;
        }
        if (mAvailableUpdate == null) {
            runUpdateCheck(true);
            return;
        }
        UiChrome.Palette p = UiChrome.palette(this);
        mUpdateStaging = true;
        if (mCheckUpdatesBtn != null) mCheckUpdatesBtn.setEnabled(false);
        if (mInstallUpdateBtn != null) mInstallUpdateBtn.setEnabled(false);
        if (mUpdateProgressBar != null) {
            mUpdateProgressBar.setVisibility(View.VISIBLE);
            mUpdateProgressBar.setIndeterminate(false);
            mUpdateProgressBar.setProgress(5);
        }
        UpdateManager.stageFromInfoAsync(this, mAvailableUpdate, new UpdateManager.Callback() {
            @Override
            public void onStage(String message, int progressPercent) {
                if (mDestroyed) return;
                mMainHandler.post(() -> {
                    if (mDestroyed) return;
                    if (mUpdateStatusText != null) {
                        mUpdateStatusText.setTextColor(p.blueAccent);
                        mUpdateStatusText.setText(message + " (" + progressPercent + "%)");
                    }
                    if (mUpdateProgressBar != null) {
                        mUpdateProgressBar.setVisibility(View.VISIBLE);
                        mUpdateProgressBar.setProgress(Math.max(0, Math.min(100, progressPercent)));
                    }
                });
            }

            @Override
            public void onUpToDate(String currentVersion, String shortSha) {
                if (mDestroyed) return;
                mMainHandler.post(() -> {
                    if (mDestroyed) return;
                    mUpdateStaging = false;
                    if (mCheckUpdatesBtn != null) mCheckUpdatesBtn.setEnabled(true);
                    if (mUpdateProgressBar != null) mUpdateProgressBar.setVisibility(View.GONE);
                    if (mUpdateStatusText != null) {
                        mUpdateStatusText.setTextColor(p.success);
                        mUpdateStatusText.setText(Localize.t(PairingActivity.this, "已是最新版本", "Already up to date"));
                    }
                });
            }

            @Override
            public void onReady(File stagedApk, String versionLabel, boolean usedDelta, long downloadBytes, long fullBytes, String notes) {
                if (mDestroyed) return;
                mMainHandler.post(() -> {
                    if (mDestroyed) return;
                    mUpdateStaging = false;
                    mStagedUpdateApk = stagedApk;
                    if (mCheckUpdatesBtn != null) mCheckUpdatesBtn.setEnabled(true);
                    if (mUpdateProgressBar != null) mUpdateProgressBar.setVisibility(View.GONE);
                    if (mInstallUpdateBtn != null) {
                        mInstallUpdateBtn.setEnabled(true);
                        mInstallUpdateBtn.setText(Localize.t(PairingActivity.this, "立即安装更新", "Install Now"));
                    }
                    if (mUpdateStatusText != null) {
                        mUpdateStatusText.setTextColor(p.success);
                        mUpdateStatusText.setText(Localize.t(PairingActivity.this,
                                "更新包已校验就绪，正在拉起安装器…",
                                "Update verified. Launching installer…"));
                    }
                    launchStagedInstaller();
                });
            }

            @Override
            public void onError(String message) {
                if (mDestroyed) return;
                mMainHandler.post(() -> {
                    if (mDestroyed) return;
                    mUpdateStaging = false;
                    if (mCheckUpdatesBtn != null) mCheckUpdatesBtn.setEnabled(true);
                    if (mInstallUpdateBtn != null) mInstallUpdateBtn.setEnabled(true);
                    if (mUpdateProgressBar != null) mUpdateProgressBar.setVisibility(View.GONE);
                    if (mUpdateStatusText != null) {
                        mUpdateStatusText.setTextColor(p.danger);
                        mUpdateStatusText.setText(Localize.t(PairingActivity.this, "更新失败：", "Update failed: ") + message);
                    }
                });
            }
        });
    }

    private void launchStagedInstaller() {
        if (mStagedUpdateApk == null || !mStagedUpdateApk.isFile()) return;
        try {
            boolean launched = UpdateManager.launchInstaller(this, mStagedUpdateApk);
            if (!launched) {
                mPendingInstallAfterPerm = true;
                Toast.makeText(this, Localize.t(this,
                        "请先授予“安装未知应用”权限，返回后将自动继续安装",
                        "Allow installing unknown apps; installer will resume automatically on return"), Toast.LENGTH_LONG).show();
            } else {
                mPendingInstallAfterPerm = false;
            }
        } catch (Throwable t) {
            Toast.makeText(this, Localize.t(this, "拉起安装器失败：", "Installer error: ") + t.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void buildPairingUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(p.bgPaper);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(UiChrome.dp(this, 22), UiChrome.dp(this, 14), UiChrome.dp(this, 22), UiChrome.dp(this, 24));
        scroll.addView(root);

        root.addView(makeTopBarRow(p, mFromRnModal || mEditingConnection || mAddingConnection));

        root.addView(UiChrome.makeRokLogoView(this, 56, p));
        addSpacing(root, 14);

        TextView eybrow = new TextView(this);
        eybrow.setText(Localize.t(this,
                "RokBot · Android 原生接入补丁",
                "RokBot · Native Android Companion"));
        eybrow.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        eybrow.setTextColor(p.textSecondary);
        root.addView(eybrow);

        TextView title = new TextView(this);
        title.setText(mEditingConnection
                ? Localize.t(this, "修改 Host 连接", "Edit Host Connection")
                : (mAddingConnection
                        ? Localize.t(this, "添加新连接", "Add a connection")
                        : Localize.t(this, "连接你的 RokBot", "Connect your RokBot")));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(p.textPrimary);
        title.setPadding(0, UiChrome.dp(this, 6), 0, UiChrome.dp(this, 6));
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText(Localize.t(this,
                "填写 Host 地址，再到 Host 管理页「设备与通知」生成 6 位配对码或输入管理员密码。",
                "Enter the Host address, then pair automatically with the Host admin password or a six-character pairing code from Devices & Notifications."));
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        sub.setTextColor(p.textSecondary);
        sub.setPadding(0, 0, 0, UiChrome.dp(this, 16));
        root.addView(sub);

        // Clean Tailcat switch row matching official connect.html
        LinearLayout tcRow = new LinearLayout(this);
        tcRow.setOrientation(LinearLayout.HORIZONTAL);
        tcRow.setGravity(Gravity.CENTER_VERTICAL);
        tcRow.setPadding(0, UiChrome.dp(this, 6), 0, UiChrome.dp(this, 6));
        TextView tcLabel = new TextView(this);
        tcLabel.setText(TailcatBridge.isAvailable()
                ? "Tailcat"
                : Localize.t(this, "Tailcat (未检测到原生库)", "Tailcat (N/A)"));
        tcLabel.setTextColor(p.textPrimary);
        tcLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tcLabel.setTypeface(Typeface.DEFAULT_BOLD);
        tcLabel.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        tcRow.addView(tcLabel);

        Switch tcSwitch = new Switch(this);
        tcSwitch.setChecked(mTailcatMode);
        tcSwitch.setContentDescription("mode_tailcat_switch");
        tcSwitch.setOnCheckedChangeListener((btn, checked) -> {
            mTailcatMode = checked;
            updateModeTabs(p);
        });
        tcRow.addView(tcSwitch);
        root.addView(tcRow);

        TextView hostLabel = UiChrome.makeSectionLabel(this,
                Localize.t(this, "Host 地址", "Host address"), p);
        hostLabel.setTag("host_url_label");
        root.addView(hostLabel);

        mHostInput = new EditText(this);
        UiChrome.styleEditText(mHostInput, p, this);
        mHostInput.setSingleLine(true);
        mHostInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        mHostInput.setContentDescription("host_url_input");
        String existingHost = Storage.getGatewayUrl(this);
        String intentHost = getIntent() != null ? getIntent().getStringExtra(EXTRA_HOST) : null;
        String preHost = Storage.getPreconfiguredHost(this);
        String initialHost = "";
        if (mDraftHost != null) {
            initialHost = mDraftHost;
            mDraftHost = null;
        } else if (intentHost != null && !intentHost.isEmpty()) initialHost = intentHost;
        else if (!mAddingConnection && existingHost != null && !existingHost.isEmpty()) initialHost = existingHost;
        else if (!preHost.isEmpty()) initialHost = preHost;
        if (TailcatManager.looksLikeTailcatInput(initialHost)) mTailcatMode = true;
        tcSwitch.setChecked(mTailcatMode);
        mHostInput.setText(initialHost);
        mHostInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override
            public void afterTextChanged(Editable s) {
                String txt = s != null ? s.toString().trim() : "";
                if (TailcatManager.looksLikeTailcatInput(txt) && !mTailcatMode) {
                    mTailcatMode = true;
                    tcSwitch.setChecked(true);
                    updateModeTabs(p);
                }
            }
        });
        root.addView(mHostInput);

        // Compact Paste + LAN Scan utility chips
        LinearLayout helperRow = new LinearLayout(this);
        helperRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.topMargin = UiChrome.dp(this, 8);
        helperRow.setLayoutParams(hlp);

        TextView pasteBtn = UiChrome.makePillButton(this, Localize.t(this, "粘贴", "Paste"), false, p, v -> pasteFromClipboard());
        pasteBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        pasteBtn.setPadding(UiChrome.dp(this, 14), UiChrome.dp(this, 7), UiChrome.dp(this, 14), UiChrome.dp(this, 7));
        helperRow.addView(pasteBtn);

        mScanRow = UiChrome.makePillButton(this, Localize.t(this, "扫描局域网 Host", "Scan LAN Hosts"), false, p, v -> startLanScan(p));
        mScanRow.setContentDescription("scan_lan_button");
        ((TextView) mScanRow).setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mScanRow.setPadding(UiChrome.dp(this, 14), UiChrome.dp(this, 7), UiChrome.dp(this, 14), UiChrome.dp(this, 7));
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.leftMargin = UiChrome.dp(this, 8);
        mScanRow.setLayoutParams(slp);
        helperRow.addView(mScanRow);
        root.addView(helperRow);

        mScanResultsBox = new LinearLayout(this);
        mScanResultsBox.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams sblp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sblp.topMargin = UiChrome.dp(this, 8);
        mScanResultsBox.setLayoutParams(sblp);
        root.addView(mScanResultsBox);

        updateModeTabs(p);

        if (!mEditingConnection) {
            addSpacing(root, 14);
            LinearLayout authSeg = new LinearLayout(this);
            authSeg.setOrientation(LinearLayout.HORIZONTAL);
            authSeg.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 4));
            authSeg.setBackground(UiChrome.roundRect(p.bgSurface2, UiChrome.dp(this, 14), p.border, UiChrome.dp(this, 1)));

            mCodeModeBtn = new TextView(this);
            mCodeModeBtn.setText(Localize.t(this, "配对码", "Pairing code"));
            mCodeModeBtn.setContentDescription("auth_mode_code_tab");
            mCodeModeBtn.setGravity(Gravity.CENTER);
            mCodeModeBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            mCodeModeBtn.setTypeface(Typeface.DEFAULT_BOLD);
            mCodeModeBtn.setPadding(0, UiChrome.dp(this, 9), 0, UiChrome.dp(this, 9));
            mCodeModeBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            mCodeModeBtn.setOnClickListener(v -> {
                mUsePasswordMode = false;
                updateAuthModeTabs(p);
            });
            authSeg.addView(mCodeModeBtn);

            mPassModeBtn = new TextView(this);
            mPassModeBtn.setText(Localize.t(this, "管理员密码", "Admin password"));
            mPassModeBtn.setContentDescription("auth_mode_password_tab");
            mPassModeBtn.setGravity(Gravity.CENTER);
            mPassModeBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            mPassModeBtn.setTypeface(Typeface.DEFAULT_BOLD);
            mPassModeBtn.setPadding(0, UiChrome.dp(this, 9), 0, UiChrome.dp(this, 9));
            mPassModeBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            mPassModeBtn.setOnClickListener(v -> {
                mUsePasswordMode = true;
                updateAuthModeTabs(p);
            });
            authSeg.addView(mPassModeBtn);
            root.addView(authSeg);

            mCodeLabel = UiChrome.makeSectionLabel(this, Localize.t(this, "配对码", "Pairing code"), p);
            root.addView(mCodeLabel);

            mCodeInput = new EditText(this);
            UiChrome.styleEditText(mCodeInput, p, this);
            mCodeInput.setSingleLine(true);
            mCodeInput.setHint(Localize.t(this, "6 位配对码", "Six characters"));
            mCodeInput.setInputType(InputType.TYPE_CLASS_TEXT
                    | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
                    | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
            mCodeInput.setImeOptions(EditorInfo.IME_ACTION_DONE);
            mCodeInput.setOnEditorActionListener((v, actionId, ev) -> {
                if (actionId == EditorInfo.IME_ACTION_DONE) {
                    attemptPairing();
                    return true;
                }
                return false;
            });
            mCodeInput.setContentDescription("pairing_code_input");
            String intentCode = getIntent() != null ? getIntent().getStringExtra(EXTRA_CODE) : null;
            String preCode = Storage.getPreconfiguredPairingCode(this);
            if (mDraftCode != null) {
                mCodeInput.setText(mDraftCode);
                mDraftCode = null;
            } else if (intentCode != null && !intentCode.isEmpty()) mCodeInput.setText(intentCode);
            else if (!preCode.isEmpty()) mCodeInput.setText(preCode);
            root.addView(mCodeInput);

            mPassLabel = UiChrome.makeSectionLabel(this, Localize.t(this, "管理员密码", "Admin password"), p);
            root.addView(mPassLabel);

            mPasswordInput = new EditText(this);
            UiChrome.styleEditText(mPasswordInput, p, this);
            mPasswordInput.setSingleLine(true);
            mPasswordInput.setHint(Localize.t(this, "输入 Host 管理员密码", "Admin password"));
            mPasswordInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            mPasswordInput.setImeOptions(EditorInfo.IME_ACTION_DONE);
            mPasswordInput.setOnEditorActionListener((v, actionId, ev) -> {
                if (actionId == EditorInfo.IME_ACTION_DONE) {
                    attemptPairing();
                    return true;
                }
                return false;
            });
            mPasswordInput.setContentDescription("admin_password_input");
            root.addView(mPasswordInput);

            updateAuthModeTabs(p);
        }

        if (!Storage.isPaired(this) && !mEditingConnection && !ConnectionHistory.load(this).isEmpty()) {
            addSpacing(root, 16);
            root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "已保存的连接（无需重新配对）", "Saved connections (no pairing needed)"), p));
            root.addView(buildHistoryCard(p, false));
        }

        mProgress = new ProgressBar(this);
        mProgress.setVisibility(View.GONE);
        mProgress.setPadding(0, UiChrome.dp(this, 8), 0, UiChrome.dp(this, 4));
        root.addView(mProgress);

        mStatusText = new TextView(this);
        mStatusText.setTextColor(p.danger);
        mStatusText.setGravity(Gravity.CENTER);
        mStatusText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mStatusText.setPadding(0, UiChrome.dp(this, 6), 0, UiChrome.dp(this, 8));
        String lastErr = Storage.getLastError();
        if ("credential".equals(lastErr)) {
            mStatusText.setText(Localize.t(this,
                    "本地密钥无法解锁，请重新配对。",
                    "Stored credentials could not be unlocked. Please pair again."));
        }
        root.addView(mStatusText);

        LinearLayout actionRow = new LinearLayout(this);
        actionRow.setOrientation(LinearLayout.HORIZONTAL);
        actionRow.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        if (mEditingConnection || (mAddingConnection && Storage.isPaired(this))) {
            TextView cancelBtn = UiChrome.makePillButton(this, Localize.t(this, "取消", "Cancel"), false, p, v -> {
                mEditingConnection = false;
                mAddingConnection = false;
                renderScreen();
            });
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            clp.rightMargin = UiChrome.dp(this, 10);
            cancelBtn.setLayoutParams(clp);
            actionRow.addView(cancelBtn);
        }
        mPairButton = UiChrome.makePillButton(this,
                mEditingConnection ? Localize.t(this, "保存", "Save")
                                   : Localize.t(this, "连接", "Connect"),
                true, p, v -> attemptPairing());
        mPairButton.setPadding(UiChrome.dp(this, 26), UiChrome.dp(this, 12), UiChrome.dp(this, 26), UiChrome.dp(this, 12));
        mPairButton.setContentDescription("connect_pair_button");
        actionRow.addView(mPairButton);
        root.addView(actionRow);

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
    }

    private void updateAuthModeTabs(UiChrome.Palette p) {
        if (mCodeModeBtn != null && mPassModeBtn != null) {
            if (mUsePasswordMode) {
                mPassModeBtn.setBackground(UiChrome.roundRect(p.accent, UiChrome.dp(this, 10), 0, 0));
                mPassModeBtn.setTextColor(p.accentText);
                mCodeModeBtn.setBackground(null);
                mCodeModeBtn.setTextColor(p.textSecondary);
            } else {
                mCodeModeBtn.setBackground(UiChrome.roundRect(p.accent, UiChrome.dp(this, 10), 0, 0));
                mCodeModeBtn.setTextColor(p.accentText);
                mPassModeBtn.setBackground(null);
                mPassModeBtn.setTextColor(p.textSecondary);
            }
        }
        if (mCodeLabel != null) mCodeLabel.setVisibility(mUsePasswordMode ? View.GONE : View.VISIBLE);
        if (mCodeInput != null) mCodeInput.setVisibility(mUsePasswordMode ? View.GONE : View.VISIBLE);
        if (mPassLabel != null) mPassLabel.setVisibility(mUsePasswordMode ? View.VISIBLE : View.GONE);
        if (mPasswordInput != null) mPasswordInput.setVisibility(mUsePasswordMode ? View.VISIBLE : View.GONE);
    }

    private void updateModeTabs(UiChrome.Palette p) {
        if (mTailcatMode) {
            if (mHostInput != null) mHostInput.setHint("tailcat://connect/…");
            if (mScanRow != null) mScanRow.setVisibility(View.GONE);
            if (mScanResultsBox != null) mScanResultsBox.setVisibility(View.GONE);
        } else {
            if (mHostInput != null) mHostInput.setHint("https://bot.example.com");
            if (mScanRow != null) mScanRow.setVisibility(View.VISIBLE);
            if (mScanResultsBox != null) mScanResultsBox.setVisibility(View.VISIBLE);
        }
    }

    private void pasteFromClipboard() {
        try {
            ClipboardManager cm = getSystemService(ClipboardManager.class);
            if (cm != null && cm.hasPrimaryClip()) {
                ClipData clip = cm.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence text = clip.getItemAt(0).coerceToText(this);
                    if (text != null && text.length() > 0) {
                        String str = text.toString().trim();
                        mHostInput.setText(str);
                        if (TailcatManager.looksLikeTailcatInput(str)) {
                            mTailcatMode = true;
                            updateModeTabs(UiChrome.palette(this));
                        }
                        return;
                    }
                }
            }
            Toast.makeText(this, Localize.t(this, "剪贴板为空", "Clipboard is empty"), Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {}
    }

    private void startLanScan(UiChrome.Palette p) {
        if (mScanResultsBox == null) return;
        mScanResultsBox.removeAllViews();
        TextView scanning = new TextView(this);
        scanning.setText(Localize.t(this, "正在搜索同一网络下的 RokBot Host…", "Scanning local network for RokBot Hosts…"));
        scanning.setTextColor(p.textSecondary);
        scanning.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mScanResultsBox.addView(scanning);

        final List<String> added = new ArrayList<>();
        LanHostScanner.scan(this, new LanHostScanner.ScanCallback() {
            @Override
            public void onHostFound(LanHostScanner.DiscoveredHost host) {
                if (added.isEmpty()) mScanResultsBox.removeAllViews();
                if (added.contains(host.url)) return;
                added.add(host.url);
                TextView chip = UiChrome.makePillButton(PairingActivity.this,
                        host.source + " · " + host.label, false, p, v -> mHostInput.setText(host.url));
                chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
                LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                clp.bottomMargin = UiChrome.dp(PairingActivity.this, 6);
                chip.setLayoutParams(clp);
                mScanResultsBox.addView(chip);
            }

            @Override
            public void onScanFinished(List<LanHostScanner.DiscoveredHost> allHosts) {
                if (allHosts.isEmpty()) {
                    mScanResultsBox.removeAllViews();
                    TextView none = new TextView(PairingActivity.this);
                    none.setText(Localize.t(PairingActivity.this,
                            "未发现局域网 Host，可手动输入 IP 或使用 Tailcat。",
                            "No LAN Host found. Enter Host URL manually or use Tailcat."));
                    none.setTextColor(p.textMuted);
                    none.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                    mScanResultsBox.addView(none);
                }
            }
        });
    }

    private void attemptPairing() {
        String rawHost = mHostInput.getText().toString().trim();
        boolean useTc = mTailcatMode || TailcatManager.looksLikeTailcatInput(rawHost);
        String code = (mCodeInput != null && !mUsePasswordMode)
                ? mCodeInput.getText().toString() : "";
        String password = (mPasswordInput != null && mUsePasswordMode)
                ? mPasswordInput.getText().toString() : "";

        UiChrome.Palette p = UiChrome.palette(this);
        mPairButton.setEnabled(false);
        mProgress.setVisibility(View.VISIBLE);
        mStatusText.setTextColor(p.blueAccent);
        mStatusText.setText(useTc
                ? Localize.t(this, "正在建立 Tailcat 加密隧道…", "Establishing Tailcat tunnel…")
                : Localize.t(this, "正在连接 Host…", "Connecting to Host…"));

        new Thread(() -> {
            try {
                if (mEditingConnection) {
                    String historyKey = ConnectionHistory.currentKey(this);
                    String existingToken = Storage.getToken(this);
                    if (existingToken == null || existingToken.isEmpty()) {
                        throw new HostApiClient.ApiException(401, Localize.t(this,
                                "设备凭据丢失，请重新配对。",
                                "Device credentials missing. Please pair again."));
                    }
                    if (useTc) {
                        String link = TailcatManager.normalizeLink(this, rawHost);
                        TailcatManager.TunnelSession pending = TailcatManager.get().startPending(
                                this, link, Storage.getTailcatIdentity(this));
                        try {
                            HostApiClient.checkStatus(pending.localUrl, existingToken);
                        } catch (Exception verifyErr) {
                            TailcatManager.get().dropPending(pending);
                            throw new HostApiClient.ApiException(400, Localize.t(this,
                                    "无法验证此 Host 的设备凭据。",
                                    "Could not verify this device with the Host."));
                        }
                        Storage.updateTailcatConnection(this, pending.link, pending.identityJson);
                        TailcatManager.get().commitPending(pending);
                    } else {
                        String server = HostApiClient.normalizeServerUrl(rawHost);
                        try {
                            HostApiClient.checkStatus(server, existingToken);
                        } catch (Exception verifyErr) {
                            throw new HostApiClient.ApiException(400, Localize.t(this,
                                    "无法验证此 Host 的设备凭据。",
                                    "Could not verify this device with the Host."));
                        }
                        Storage.updateDirectConnection(this, server);
                        TailcatManager.get().clear();
                    }
                    ConnectionHistory.recordCurrent(this, historyKey);
                    NotificationService.sync(this, true);
                    PushManager.getInstance(this).syncDeviceAsync(RokBotBootstrap.isForeground(), true);
                    RokBotBootstrap.reloadReactHost(this);
                    mEditingConnection = false;
                    mMainHandler.post(() -> {
                        if (mDestroyed || isFinishing()) return;
                        Toast.makeText(this, Localize.t(this, "连接已验证", "Connection verified!"), Toast.LENGTH_SHORT).show();
                        renderScreen();
                    });
                    return;
                }

                // Keep the connection we are leaving (with its latest token) in the history.
                ConnectionHistory.recordCurrent(this);
                HostApiClient.PairResult res = HostApiClient.pair(this, rawHost, code, password, useTc);
                if (res.tailcat) {
                    Storage.saveTailcatCredentials(this, res.token, res.canonicalAddress, res.deviceId, res.networkIdentity, res.reportedGatewayUrl);
                } else {
                    Storage.saveCredentials(this, res.token, res.gatewayUrl, res.deviceId, res.reportedGatewayUrl);
                }

                try {
                    String resolved = HostApiClient.resolveServer(this);
                    if (HermesPatcher.hasGatewayTemplate(this)) {
                        mMainHandler.post(() -> {
                            if (mDestroyed || isFinishing()) return;
                            mStatusText.setText(Localize.t(this, "正在配置本地运行时…", "Preparing runtime bundle…"));
                        });
                        RokBotBootstrap.ensurePairedBundleFile(this, true);
                    }
                } catch (Throwable ignored) {}

                ConnectionHistory.recordCurrent(this);
                mAddingConnection = false;
                NotificationService.sync(this, true);
                PushManager.getInstance(this).syncDeviceAsync(RokBotBootstrap.isForeground(), true);
                // New pairing: drop the previous Host's profile and fetch this Host's one.
                HostProfile.clear();
                HostProfile.refresh(this, true);
                // ...and this Host's Android update channel.
                AppUpdater.onPairingChanged(this);
                AppUpdater.onAppForeground(this);

                boolean needsModel = false;
                try {
                    JSONObject hostStatus = HostApiClient.getHostStatus(this);
                    needsModel = hostStatus != null && hostStatus.optBoolean("needsModel", false);
                } catch (Throwable ignored) {}
                final boolean shouldOnboardModel = needsModel;

                mMainHandler.post(() -> {
                    if (mDestroyed || isFinishing()) return;
                    Toast.makeText(this, Localize.t(this, "配对成功", "Pairing Successful!"), Toast.LENGTH_SHORT).show();
                    if (shouldOnboardModel) {
                        RokBotBootstrap.reloadReactHost(this);
                        Intent i = new Intent(this, ModelsActivity.class);
                        i.putExtra(ModelsActivity.EXTRA_ONBOARDING, true);
                        startActivity(i);
                        finish();
                    } else {
                        returnToMainApp();
                    }
                });
            } catch (Exception e) {
                mMainHandler.post(() -> {
                    if (mDestroyed || isFinishing()) return;
                    mPairButton.setEnabled(true);
                    mProgress.setVisibility(View.GONE);
                    mStatusText.setTextColor(p.danger);
                    mStatusText.setText(e.getMessage() != null ? e.getMessage()
                            : Localize.t(this, "配对失败", "Pairing failed"));
                });
            }
        }).start();
    }

    // ---- Connection & Diagnostics (rokbot.3) ----

    private LinearLayout buildCurrentConnectionCard(UiChrome.Palette p) {
        LinearLayout card = UiChrome.makeCard(this, p);
        card.setContentDescription("current_connection_card");
        boolean isTc = Storage.isTailcatEnabled(this);

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView type = new TextView(this);
        type.setText(isTc ? "Tailcat" : Localize.t(this, "服务器", "Server"));
        type.setTextColor(p.textSecondary);
        type.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        type.setTypeface(Typeface.DEFAULT_BOLD);
        type.setPadding(UiChrome.dp(this, 8), UiChrome.dp(this, 2), UiChrome.dp(this, 8), UiChrome.dp(this, 2));
        type.setBackground(UiChrome.roundRect(p.bgSurface2, UiChrome.dp(this, 8), 0, 0));
        top.addView(type);
        mStatusBadge = new TextView(this);
        mStatusBadge.setText(isTc
                ? Localize.t(this, "  ● Tailcat 已连接", "  ● Tailcat connected")
                : Localize.t(this, "  ● 已连接到 Host", "  ● Connected to Host"));
        mStatusBadge.setTextColor(p.success);
        mStatusBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mStatusBadge.setTypeface(Typeface.DEFAULT_BOLD);
        top.addView(mStatusBadge);
        card.addView(top);

        String hostName = HostProfile.hostName(this);
        ConnectionHistory.Entry current = null;
        for (ConnectionHistory.Entry e : ConnectionHistory.load(this)) {
            if (ConnectionHistory.isCurrent(this, e)) { current = e; break; }
        }
        String title = current != null ? current.displayName()
                : (hostName != null ? hostName : ConnectionHistory.shortAddress(isTc ? ConnectionHistory.TYPE_TAILCAT : ConnectionHistory.TYPE_SERVER, Storage.getGatewayUrl(this)));
        TextView nameTv = new TextView(this);
        nameTv.setText(title);
        nameTv.setTextColor(p.textPrimary);
        nameTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        nameTv.setTypeface(Typeface.DEFAULT_BOLD);
        nameTv.setPadding(0, UiChrome.dp(this, 10), 0, 0);
        card.addView(nameTv);

        TextView addrTv = new TextView(this);
        addrTv.setText(Storage.getGatewayUrl(this));
        addrTv.setTextColor(p.textPrimary);
        addrTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        addrTv.setSingleLine(true);
        addrTv.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        addrTv.setPadding(0, UiChrome.dp(this, 4), 0, UiChrome.dp(this, 4));
        card.addView(addrTv);

        mStatusLine = new TextView(this);
        mStatusLine.setContentDescription("connection_path_status");
        mStatusLine.setText(Localize.t(this, "路径与延迟：检测中…", "Route & latency: checking…"));
        mStatusLine.setTextColor(p.blueAccent);
        mStatusLine.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mStatusLine.setTypeface(Typeface.DEFAULT_BOLD);
        mStatusLine.setPadding(0, UiChrome.dp(this, 2), 0, UiChrome.dp(this, 4));
        card.addView(mStatusLine);

        TextView devTv = new TextView(this);
        devTv.setText(Localize.t(this, "设备 ID: ", "Device ID: ") + Storage.getDeviceId(this));
        devTv.setTextColor(p.textSecondary);
        devTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        card.addView(devTv);
        if (mLastStatus != null) applyProbeStatus(mLastStatus);
        return card;
    }

    private LinearLayout buildHistoryCard(UiChrome.Palette p, boolean connectedPage) {
        LinearLayout card = UiChrome.makeCard(this, p);
        card.setContentDescription("connection_history_card");
        card.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 4));
        java.util.List<ConnectionHistory.Entry> entries = ConnectionHistory.load(this);
        boolean first = true;
        for (ConnectionHistory.Entry e : entries) {
            if (!first) card.addView(makeDivider(p));
            first = false;
            card.addView(makeHistoryRow(p, e));
        }
        if (connectedPage) {
            if (!first) card.addView(makeDivider(p));
            TextView add = new TextView(this);
            add.setText(Localize.t(this, "＋  添加新连接", "＋  Add a connection"));
            add.setContentDescription("add_connection_button");
            add.setTextColor(p.blueAccent);
            add.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            add.setTypeface(Typeface.DEFAULT_BOLD);
            add.setPadding(UiChrome.dp(this, 14), UiChrome.dp(this, 14), UiChrome.dp(this, 14), UiChrome.dp(this, 14));
            add.setOnClickListener(v -> startAddConnection(null, false));
            card.addView(add);
        }
        return card;
    }

    private View makeDivider(UiChrome.Palette p) {
        View d = new View(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, UiChrome.dp(this, 0.7f)));
        lp.leftMargin = UiChrome.dp(this, 46);
        d.setLayoutParams(lp);
        d.setBackgroundColor(p.border);
        return d;
    }

    @SuppressWarnings("ClickableViewAccessibility")
    private View makeHistoryRow(UiChrome.Palette p, ConnectionHistory.Entry e) {
        final boolean current = ConnectionHistory.isCurrent(this, e);
        android.widget.FrameLayout frame = new android.widget.FrameLayout(this);
        // Behind the row: revealed by a left swipe.
        TextView deleteBg = new TextView(this);
        deleteBg.setText(Localize.t(this, "删除", "Delete"));
        deleteBg.setTextColor(0xFFFFFFFF);
        deleteBg.setTypeface(Typeface.DEFAULT_BOLD);
        deleteBg.setGravity(Gravity.CENTER_VERTICAL | Gravity.END);
        deleteBg.setPadding(0, 0, UiChrome.dp(this, 22), 0);
        deleteBg.setBackground(UiChrome.roundRect(p.danger, UiChrome.dp(this, 12), 0, 0));
        deleteBg.setVisibility(View.INVISIBLE);
        frame.addView(deleteBg, new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackgroundColor(p.bgCard);
        row.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 11), UiChrome.dp(this, 12), UiChrome.dp(this, 11));
        row.setContentDescription((current ? "connection_row_current:" : "connection_row:") + e.displayName());

        TextView check = new TextView(this);
        check.setText(current ? "✓" : "");
        check.setTextColor(p.success);
        check.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        check.setTypeface(Typeface.DEFAULT_BOLD);
        check.setGravity(Gravity.CENTER);
        row.addView(check, new LinearLayout.LayoutParams(UiChrome.dp(this, 30), ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView name = new TextView(this);
        name.setText(e.displayName());
        name.setTextColor(p.textPrimary);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        texts.addView(name);
        TextView sub = new TextView(this);
        sub.setText((e.isTailcat() ? "Tailcat" : Localize.t(this, "服务器", "Server")) + " · "
                + ConnectionHistory.shortAddress(e.type, e.address));
        sub.setTextColor(p.textSecondary);
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        sub.setSingleLine(true);
        sub.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        texts.addView(sub);
        TextView meta = new TextView(this);
        meta.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        if (current) {
            meta.setText(Localize.t(this, "当前连接 · 检测中…", "Current · checking…"));
            meta.setTextColor(p.blueAccent);
            mCurrentRowStatus = meta;
        } else {
            meta.setText(Localize.t(this, "上次使用 ", "Last used ") + formatLastUsed(e.lastUsedAt));
            meta.setTextColor(p.textMuted);
        }
        texts.addView(meta);
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        frame.addView(row, new android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        row.setOnClickListener(v -> {
            if (current) {
                Toast.makeText(this, Localize.t(this, "已是当前连接", "Already the current connection"), Toast.LENGTH_SHORT).show();
            } else {
                confirmSwitch(e);
            }
        });
        row.setOnLongClickListener(v -> {
            showRowMenu(e, current);
            return true;
        });
        // Left swipe -> delete (not for the current connection).
        final float slop = android.view.ViewConfiguration.get(this).getScaledTouchSlop();
        final float[] down = new float[2];
        final boolean[] swiping = new boolean[1];
        row.setOnTouchListener((v, ev) -> {
            if (current) return false;
            switch (ev.getActionMasked()) {
                case android.view.MotionEvent.ACTION_DOWN:
                    down[0] = ev.getRawX();
                    down[1] = ev.getRawY();
                    swiping[0] = false;
                    return false;
                case android.view.MotionEvent.ACTION_MOVE: {
                    float dx = ev.getRawX() - down[0];
                    float dy = ev.getRawY() - down[1];
                    if (!swiping[0] && dx < -slop && Math.abs(dx) > Math.abs(dy) * 1.5f) {
                        swiping[0] = true;
                        v.getParent().requestDisallowInterceptTouchEvent(true);
                        v.setPressed(false);
                        v.cancelLongPress();
                        deleteBg.setVisibility(View.VISIBLE);
                    }
                    if (swiping[0]) {
                        v.setTranslationX(Math.min(0f, dx));
                        return true;
                    }
                    return false;
                }
                case android.view.MotionEvent.ACTION_UP:
                case android.view.MotionEvent.ACTION_CANCEL:
                    if (swiping[0]) {
                        swiping[0] = false;
                        boolean past = v.getTranslationX() < -v.getWidth() * 0.28f
                                && ev.getActionMasked() == android.view.MotionEvent.ACTION_UP;
                        v.animate().translationX(0f).setDuration(160).withEndAction(() -> deleteBg.setVisibility(View.INVISIBLE)).start();
                        if (past) confirmDelete(e);
                        return true;
                    }
                    return false;
                default:
                    return false;
            }
        });
        return frame;
    }

    private String formatLastUsed(long at) {
        if (at <= 0) return "—";
        long diff = System.currentTimeMillis() - at;
        if (diff < 60_000L) return Localize.t(this, "刚刚", "just now");
        if (diff < 3_600_000L) return Localize.t(this, (diff / 60_000L) + " 分钟前", (diff / 60_000L) + " min ago");
        if (diff < 86_400_000L) return Localize.t(this, (diff / 3_600_000L) + " 小时前", (diff / 3_600_000L) + " h ago");
        return new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.ROOT).format(new java.util.Date(at));
    }

    private void showRowMenu(ConnectionHistory.Entry e, boolean current) {
        java.util.List<String> items = new ArrayList<>();
        items.add(Localize.t(this, "重命名", "Rename"));
        if (!current) items.add(Localize.t(this, "删除", "Delete"));
        new android.app.AlertDialog.Builder(this)
                .setTitle(e.displayName())
                .setItems(items.toArray(new String[0]), (d, which) -> {
                    if (which == 0) showRenameDialog(e);
                    else confirmDelete(e);
                })
                .show();
    }

    private void showRenameDialog(ConnectionHistory.Entry e) {
        UiChrome.Palette p = UiChrome.palette(this);
        EditText input = new EditText(this);
        UiChrome.styleEditText(input, p, this);
        input.setSingleLine(true);
        input.setText(e.customName != null ? e.customName : "");
        input.setHint(e.name != null ? e.name : ConnectionHistory.shortAddress(e.type, e.address));
        input.setContentDescription("rename_connection_input");
        LinearLayout box = new LinearLayout(this);
        box.setPadding(UiChrome.dp(this, 20), UiChrome.dp(this, 8), UiChrome.dp(this, 20), 0);
        box.addView(input, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        new android.app.AlertDialog.Builder(this)
                .setTitle(Localize.t(this, "重命名连接", "Rename connection"))
                .setMessage(Localize.t(this, "留空则使用 Host 名称。", "Leave empty to use the Host name."))
                .setView(box)
                .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                .setPositiveButton(Localize.t(this, "保存", "Save"), (d, w) -> {
                    ConnectionHistory.rename(this, e.id, input.getText().toString());
                    renderScreen();
                })
                .show();
    }

    private void confirmDelete(ConnectionHistory.Entry e) {
        new android.app.AlertDialog.Builder(this)
                .setTitle(Localize.t(this, "删除这个连接？", "Delete this connection?"))
                .setMessage(Localize.t(this,
                        e.displayName() + "\n删除后再连接需要重新配对。",
                        e.displayName() + "\nConnecting again will need a new pairing."))
                .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                .setPositiveButton(Localize.t(this, "删除", "Delete"), (d, w) -> {
                    ConnectionHistory.delete(this, e.id);
                    renderScreen();
                })
                .show();
    }

    private void confirmSwitch(ConnectionHistory.Entry e) {
        new android.app.AlertDialog.Builder(this)
                .setTitle(Localize.t(this, "切换连接", "Switch connection"))
                .setMessage(Localize.t(this,
                        "切换到「" + e.displayName() + "」？\n当前连接会保存在历史中，可随时切回。",
                        "Switch to \"" + e.displayName() + "\"?\nThe current connection stays in the history."))
                .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                .setPositiveButton(Localize.t(this, "切换", "Switch"), (d, w) -> runSwitch(e))
                .show();
    }

    private void runSwitch(ConnectionHistory.Entry e) {
        showBusy(Localize.t(this, "正在切换到 " + e.displayName() + "…", "Switching to " + e.displayName() + "…"));
        final Context app = getApplicationContext();
        new Thread(() -> {
            ConnectionHistory.SwitchException failure = null;
            ConnectionHistory.Entry done = null;
            try {
                done = ConnectionHistory.switchTo(app, e.id);
                RokBotBootstrap.reloadReactHost(app);
            } catch (ConnectionHistory.SwitchException se) {
                failure = se;
            } catch (Throwable t) {
                failure = new ConnectionHistory.SwitchException(ConnectionHistory.SwitchException.KIND_UNREACHABLE,
                        t.getMessage() != null ? t.getMessage() : t.toString());
            }
            final ConnectionHistory.SwitchException err = failure;
            final ConnectionHistory.Entry ok = done;
            mMainHandler.post(() -> {
                if (mDestroyed) return;
                hideBusy();
                if (err == null) {
                    mLastStatus = null;
                    Toast.makeText(this, Localize.t(this, "已切换到 ", "Switched to ") + (ok != null ? ok.displayName() : e.displayName()),
                            Toast.LENGTH_SHORT).show();
                    renderScreen();
                    return;
                }
                android.app.AlertDialog.Builder b = new android.app.AlertDialog.Builder(this)
                        .setTitle(Localize.t(this, "无法切换", "Could not switch"))
                        .setMessage(err.getMessage())
                        .setNegativeButton(Localize.t(this, "好", "OK"), null);
                if (err.kind == ConnectionHistory.SwitchException.KIND_INVALID
                        || err.kind == ConnectionHistory.SwitchException.KIND_LOCKED) {
                    b.setPositiveButton(Localize.t(this, "重新配对", "Pair again"), (d, w) -> startAddConnection(e.address, e.isTailcat()));
                }
                b.show();
            });
        }, "RokBotConnectionSwitch").start();
    }

    private void startAddConnection(String prefillHost, boolean tailcat) {
        if (Storage.isPaired(this)) {
            final Context app = getApplicationContext();
            new Thread(() -> ConnectionHistory.recordCurrent(app), "RokBotHistorySave").start();
        }
        mAddingConnection = true;
        mEditingConnection = false;
        mUsePasswordMode = false;
        mDraftHost = prefillHost != null ? prefillHost : "";
        mDraftCode = "";
        mTailcatMode = tailcat;
        renderScreen();
    }

    private void showBusy(String message) {
        UiChrome.Palette p = UiChrome.palette(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(UiChrome.dp(this, 22), UiChrome.dp(this, 20), UiChrome.dp(this, 22), UiChrome.dp(this, 20));
        box.addView(new ProgressBar(this));
        TextView tv = new TextView(this);
        tv.setText(message);
        tv.setTextColor(p.textPrimary);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tv.setPadding(UiChrome.dp(this, 16), 0, 0, 0);
        box.addView(tv);
        mBusyDialog = new android.app.AlertDialog.Builder(this).setView(box).setCancelable(false).create();
        mBusyDialog.show();
    }

    private void hideBusy() {
        if (mBusyDialog != null) {
            try { mBusyDialog.dismiss(); } catch (Throwable ignored) {}
            mBusyDialog = null;
        }
    }

    private LinearLayout buildListSortCard(UiChrome.Palette p) {
        LinearLayout card = UiChrome.makeCard(this, p);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView t = new TextView(this);
        t.setText(Localize.t(this, "按最后消息排序", "Sort by last message"));
        t.setTextColor(p.textPrimary);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        texts.addView(t);
        TextView d = new TextView(this);
        d.setText(Localize.t(this,
                "与会话列表右上角的铜铃相同。开启后 Bot 按最后一条消息的时间排列，切换时会重新加载界面。",
                "Same as the bell on the chat list. Bots are ordered by their last message; switching reloads the app UI."));
        d.setTextColor(p.textSecondary);
        d.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        d.setPadding(0, UiChrome.dp(this, 3), UiChrome.dp(this, 10), 0);
        texts.addView(d);
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Switch sw = new Switch(this);
        sw.setChecked(ListArrangement.isLastMessage(this));
        sw.setContentDescription("list_sort_switch");
        sw.setOnCheckedChangeListener((btn, checked) -> {
            btn.setEnabled(false);
            ListArrangement.setLastMessage(this, checked, () -> btn.setEnabled(true));
        });
        row.addView(sw);
        card.addView(row);
        return card;
    }

    private LinearLayout buildAvatarStyleCard(UiChrome.Palette p) {
        LinearLayout card = UiChrome.makeCard(this, p);
        TextView hint = new TextView(this);
        hint.setText(Localize.t(this,
                "全局替换 Bot 的动态流体球图标，也可随时切回官方原版，选择后立即生效。",
                "Applies to every Bot avatar across the app, or switch back to the official fluid orb anytime."));
        hint.setTextColor(p.textSecondary);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hint.setPadding(0, 0, 0, UiChrome.dp(this, 10));
        card.addView(hint);

        final int count = RokBotAvatarRenderer.STYLES.length;
        final View[] cellViews = new View[count];
        final String[] selectedRef = new String[] { RokBotAvatarManager.getStyle(this) };

        for (int rowStart = 0; rowStart < count; rowStart += 3) {
            LinearLayout gridRow = new LinearLayout(this);
            gridRow.setOrientation(LinearLayout.HORIZONTAL);
            if (rowStart > 0) {
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rlp.topMargin = UiChrome.dp(this, 8);
                gridRow.setLayoutParams(rlp);
            }
            for (int col = 0; col < 3; col++) {
                final int idx = rowStart + col;
                final RokBotAvatarRenderer.StyleInfo info = RokBotAvatarRenderer.STYLES[idx];
                LinearLayout cell = new LinearLayout(this);
                cell.setOrientation(LinearLayout.VERTICAL);
                cell.setGravity(Gravity.CENTER_HORIZONTAL);
                cell.setPadding(UiChrome.dp(this, 8), UiChrome.dp(this, 10), UiChrome.dp(this, 8), UiChrome.dp(this, 10));
                cell.setContentDescription("avatar_style_" + info.id);
                LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                if (col > 0) clp.leftMargin = UiChrome.dp(this, 8);
                cell.setLayoutParams(clp);

                RokBotAvatarView preview = new RokBotAvatarView(this);
                preview.setStyleId(info.id);
                preview.setPreviewShape(info.previewShape);
                preview.setBaseColor(info.previewColor);
                preview.setActive(selectedRef[0].equals(info.id));
                LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(UiChrome.dp(this, 42), UiChrome.dp(this, 42));
                plp.bottomMargin = UiChrome.dp(this, 6);
                cell.addView(preview, plp);

                TextView title = new TextView(this);
                String nameText = Localize.t(this, info.zh, info.en);
                if (RokBotAvatarRenderer.STYLE_CHASSIS.equals(info.id)) {
                    nameText += Localize.t(this, " · 默认", " · Default");
                }
                title.setText(nameText);
                title.setTextColor(p.textPrimary);
                title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                title.setTypeface(Typeface.DEFAULT_BOLD);
                title.setGravity(Gravity.CENTER);
                cell.addView(title);

                TextView desc = new TextView(this);
                desc.setText(Localize.t(this, info.descZh, info.descEn));
                desc.setTextColor(p.textSecondary);
                desc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
                desc.setGravity(Gravity.CENTER);
                desc.setPadding(0, UiChrome.dp(this, 2), 0, 0);
                cell.addView(desc);

                cell.setTag(preview);
                cellViews[idx] = cell;
                styleAvatarCell(cell, p, selectedRef[0].equals(info.id));
                cell.setOnClickListener(v -> {
                    selectedRef[0] = info.id;
                    RokBotAvatarManager.setStyle(this, info.id);
                    for (int i = 0; i < count; i++) {
                        boolean on = RokBotAvatarRenderer.STYLES[i].id.equals(info.id);
                        styleAvatarCell(cellViews[i], p, on);
                        if (cellViews[i].getTag() instanceof RokBotAvatarView) {
                            ((RokBotAvatarView) cellViews[i].getTag()).setActive(on);
                        }
                    }
                    Toast.makeText(this, Localize.t(this, "已切换图标：", "Avatar style: ")
                            + Localize.t(this, info.zh, info.en), Toast.LENGTH_SHORT).show();
                });
                gridRow.addView(cell);
            }
            card.addView(gridRow);
        }
        return card;
    }

    private void styleAvatarCell(View cell, UiChrome.Palette p, boolean selected) {
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setCornerRadius(UiChrome.dp(this, 12));
        bg.setColor(selected ? ((p.accent & 0x00FFFFFF) | 0x1E000000) : p.bgSurface2);
        bg.setStroke(UiChrome.dp(this, selected ? 2 : 1), selected ? p.accent : p.border);
        cell.setBackground(bg);
    }

    private LinearLayout buildDiagnosticsCard(UiChrome.Palette p) {
        LinearLayout card = UiChrome.makeCard(this, p);
        card.setContentDescription("diagnostics_card");
        boolean isTc = Storage.isTailcatEnabled(this);
        mDiagPath = addDiagRow(card, p, Localize.t(this, "连接路径", "Route"), isTc ? "—" : Localize.t(this, "服务器直连（HTTP/HTTPS）", "Server (HTTP/HTTPS)"));
        mDiagLatency = addDiagRow(card, p, Localize.t(this, "延迟（/health 往返）", "Latency (/health round trip)"), "—");
        addDiagRow(card, p, Localize.t(this, "Tailcat 原生库", "Tailcat library"), TailcatBridge.isAvailable()
                ? Localize.t(this, "已加载", "Loaded")
                : Localize.t(this, "不可用", "Unavailable"));
        addDiagRow(card, p, Localize.t(this, "版本", "Version"), UpdateManager.getCurrentVersionLabel(this));
        TextView copy = UiChrome.makePillButton(this, Localize.t(this, "复制诊断信息", "Copy diagnostics"), false, p, v -> copyDiagnostics());
        copy.setContentDescription("copy_diagnostics_button");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = UiChrome.dp(this, 10);
        copy.setLayoutParams(lp);
        card.addView(copy);
        return card;
    }

    private TextView addDiagRow(LinearLayout card, UiChrome.Palette p, String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, UiChrome.dp(this, 5), 0, UiChrome.dp(this, 5));
        TextView l = new TextView(this);
        l.setText(label);
        l.setTextColor(p.textSecondary);
        l.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        row.addView(l, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextColor(p.textPrimary);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        v.setGravity(Gravity.END);
        row.addView(v, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.3f));
        card.addView(row);
        return v;
    }

    private void copyDiagnostics() {
        StringBuilder sb = new StringBuilder();
        boolean isTc = Storage.isTailcatEnabled(this);
        sb.append("RokBot ").append(UpdateManager.getCurrentVersionLabel(this)).append('\n');
        sb.append("type: ").append(isTc ? "tailcat" : "server").append('\n');
        sb.append("address: ").append(Storage.getGatewayUrl(this)).append('\n');
        sb.append("deviceId: ").append(Storage.getDeviceId(this)).append('\n');
        ConnectionProbe.Status st = mLastStatus;
        if (st != null) {
            sb.append("path: ").append(isTc ? st.path : "server/" + st.httpRoute
                    + (st.httpRouteSource != null ? " (" + st.httpRouteSource + ")" : "")).append('\n');
            sb.append("latencyMs: ").append(st.latencyMs).append('\n');
            sb.append("reachable: ").append(st.reachable).append('\n');
        }
        sb.append("tailcatLib: ").append(TailcatBridge.isAvailable()).append('\n');
        sb.append("listSort: ").append(ListArrangement.isLastMessage(this) ? "lastMessage" : "official").append('\n');
        sb.append("savedConnections: ").append(ConnectionHistory.load(this).size()).append('\n');
        try {
            ClipboardManager cm = getSystemService(ClipboardManager.class);
            cm.setPrimaryClip(ClipData.newPlainText("RokBot diagnostics", sb.toString()));
            Toast.makeText(this, Localize.t(this, "已复制诊断信息（不含凭证）", "Diagnostics copied (no credentials)"), Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {}
    }

    private void startProbeIfConnected() {
        if (mDestroyed || mStatusLine == null || !Storage.isPaired(this) || mEditingConnection || mAddingConnection) return;
        if (mProbe == null) mProbe = new ConnectionProbe(this, this::applyProbeStatus);
        mProbe.start();
    }

    private void stopProbe() {
        if (mProbe != null) mProbe.stop();
    }

    private void applyProbeStatus(ConnectionProbe.Status st) {
        mLastStatus = st;
        UiChrome.Palette p = UiChrome.palette(this);
        String text = ConnectionProbe.describe(this, st);
        if (mStatusLine != null) {
            mStatusLine.setText(text);
            mStatusLine.setTextColor(st.measured && (!st.reachable || st.credentialRejected) ? p.danger : p.blueAccent);
        }
        if (mStatusBadge != null && st.measured) {
            boolean isTc = st.tailcat;
            boolean ok = st.reachable && !st.credentialRejected;
            mStatusBadge.setText(ok
                    ? (isTc ? Localize.t(this, "  ● Tailcat 已连接", "  ● Tailcat connected") : Localize.t(this, "  ● 已连接到 Host", "  ● Connected to Host"))
                    : (st.credentialRejected ? Localize.t(this, "  ● 凭证失效", "  ● Credential rejected") : Localize.t(this, "  ● 连接异常", "  ● Connection problem")));
            mStatusBadge.setTextColor(ok ? p.success : p.danger);
        }
        if (mCurrentRowStatus != null) {
            mCurrentRowStatus.setText(Localize.t(this, "当前连接 · ", "Current · ") + text);
        }
        if (mDiagPath != null && st.tailcat) {
            String path = ConnectionProbe.PATH_DIRECT.equals(st.path) ? Localize.t(this, "直连（点对点）", "Direct (peer-to-peer)")
                    : ConnectionProbe.PATH_RELAY.equals(st.path) ? Localize.t(this, "中继（DERP）", "Relay (DERP)")
                    : Localize.t(this, "检测中（每 10 秒更新）", "Pending (updates every 10 s)");
            mDiagPath.setText(path);
        } else if (mDiagPath != null && st.measured) {
            String why = "header".equals(st.httpRouteSource)
                    ? Localize.t(this, "，由入口声明", ", declared by the entry")
                    : "address".equals(st.httpRouteSource) ? Localize.t(this, "，按地址判断", ", from the address") : "";
            String path = ConnectionProbe.PATH_DIRECT.equals(st.httpRoute)
                    ? Localize.t(this, "直连（局域网 HTTP/HTTPS）", "Direct (LAN HTTP/HTTPS)") + why
                    : ConnectionProbe.PATH_RELAY.equals(st.httpRoute)
                    ? Localize.t(this, "中继（公网入口转发到 Host）", "Relay (public entry in front of the Host)") + why
                    : Localize.t(this, "服务器（HTTP/HTTPS）", "Server (HTTP/HTTPS)");
            mDiagPath.setText(path);
        }
        if (mDiagLatency != null) {
            mDiagLatency.setText(!st.measured ? "—" : (!st.reachable ? Localize.t(this, "无响应", "No response")
                    : (st.latencyMs >= 0 ? st.latencyMs + " ms" : "—")));
        }
    }

    private void addSpacing(LinearLayout parent, int dp) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, dp)));
        parent.addView(v);
    }
}

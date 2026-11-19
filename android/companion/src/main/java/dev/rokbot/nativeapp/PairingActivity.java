package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
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
    private boolean mFromRnModal = false;
    private String mDraftHost = null;
    private String mDraftCode = null;
    private final Handler mMainHandler = new Handler(Looper.getMainLooper());

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
                returnToMainApp();
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
        }
        renderScreen();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putBoolean("state_tailcat", mTailcatMode);
        outState.putBoolean("state_pwd_mode", mUsePasswordMode);
        outState.putBoolean("state_editing", mEditingConnection);
        if (mHostInput != null && mHostInput.getText() != null) {
            outState.putString("state_host", mHostInput.getText().toString());
        }
        if (mCodeInput != null && mCodeInput.getText() != null) {
            outState.putString("state_code", mCodeInput.getText().toString());
        }
    }

    private void renderScreen() {
        boolean connected = Storage.isPaired(this) && !mEditingConnection;
        if (connected) {
            buildConnectedUi();
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
        heading.setText(Localize.t(this, "Host 连接", "Host Connection"));
        heading.setTextColor(p.textPrimary);
        heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 25);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        heading.setPadding(0, 0, 0, UiChrome.dp(this, 14));
        root.addView(heading);

        LinearLayout card = UiChrome.makeCard(this, p);
        boolean isTc = Storage.isTailcatEnabled(this);
        TextView badge = new TextView(this);
        badge.setText(isTc
                ? Localize.t(this, "● Tailcat 已连接", "● Tailcat Connected")
                : Localize.t(this, "● 已连接到 Host", "● Connected to Host"));
        badge.setTextColor(p.success);
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(badge);

        TextView addrTv = new TextView(this);
        addrTv.setText(Storage.getGatewayUrl(this));
        addrTv.setTextColor(p.textPrimary);
        addrTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        addrTv.setPadding(0, UiChrome.dp(this, 8), 0, UiChrome.dp(this, 4));
        card.addView(addrTv);

        String pathInfo = isTc ? (" (" + TailcatManager.get().getTransportPath(this) + ")") : "";
        TextView devTv = new TextView(this);
        devTv.setText(Localize.t(this, "设备 ID: ", "Device ID: ") + Storage.getDeviceId(this) + pathInfo);
        devTv.setTextColor(p.textSecondary);
        devTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        card.addView(devTv);
        root.addView(card);

        String originalReact = discoverOriginalReactActivity();
        if (mFromRnModal || originalReact != null) {
            addSpacing(root, 18);
            TextView doneBtn = UiChrome.makePillButton(this,
                    Localize.t(this, "回到 RokBot", "Return to RokBot"), true, p,
                    v -> returnToMainApp());
            doneBtn.setContentDescription("return_to_app_button");
            root.addView(doneBtn);
        }

        addSpacing(root, 12);
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
        TextView editBtn = UiChrome.makePillButton(this, Localize.t(this, "修改连接", "Edit Connection"), false, p, v -> {
            mEditingConnection = true;
            renderScreen();
        });
        editBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        quickGrid3.addView(editBtn);
        root.addView(quickGrid3);

        addSpacing(root, 16);
        TextView unpairBtn = UiChrome.makePillButton(this,
                Localize.t(this, "断开并解除配对", "Disconnect & Unpair"), false, p, v -> {
                    TailcatManager.get().clear();
                    Storage.clearCredentials(this);
                    RokBotBootstrap.clearPairedBundle(this);
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

        root.addView(makeTopBarRow(p, mFromRnModal || mEditingConnection));

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
                : Localize.t(this, "连接你的 RokBot", "Connect your RokBot"));
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
        else if (existingHost != null && !existingHost.isEmpty()) initialHost = existingHost;
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
        if (mEditingConnection) {
            TextView cancelBtn = UiChrome.makePillButton(this, Localize.t(this, "取消", "Cancel"), false, p, v -> {
                mEditingConnection = false;
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
                    NotificationService.sync(this, true);
                    PushManager.getInstance(this).syncDeviceAsync(RokBotBootstrap.isForeground(), true);
                    RokBotBootstrap.reloadReactHost(this);
                    mEditingConnection = false;
                    mMainHandler.post(() -> {
                        Toast.makeText(this, Localize.t(this, "连接已验证", "Connection verified!"), Toast.LENGTH_SHORT).show();
                        renderScreen();
                    });
                    return;
                }

                HostApiClient.PairResult res = HostApiClient.pair(this, rawHost, code, password, useTc);
                if (res.tailcat) {
                    Storage.saveTailcatCredentials(this, res.token, res.canonicalAddress, res.deviceId, res.networkIdentity, res.reportedGatewayUrl);
                } else {
                    Storage.saveCredentials(this, res.token, res.gatewayUrl, res.deviceId, res.reportedGatewayUrl);
                }

                try {
                    String resolved = HostApiClient.resolveServer(this);
                    if (HermesPatcher.hasGatewayTemplate(this)) {
                        mMainHandler.post(() -> mStatusText.setText(Localize.t(this, "正在配置本地运行时…", "Preparing runtime bundle…")));
                        HermesPatcher.generatePairedBundle(this, resolved, res.token);
                    }
                } catch (Throwable ignored) {}

                NotificationService.sync(this, true);
                PushManager.getInstance(this).syncDeviceAsync(RokBotBootstrap.isForeground(), true);

                mMainHandler.post(() -> {
                    Toast.makeText(this, Localize.t(this, "配对成功", "Pairing Successful!"), Toast.LENGTH_SHORT).show();
                    returnToMainApp();
                });
            } catch (Exception e) {
                mMainHandler.post(() -> {
                    mPairButton.setEnabled(true);
                    mProgress.setVisibility(View.GONE);
                    mStatusText.setTextColor(p.danger);
                    mStatusText.setText(e.getMessage() != null ? e.getMessage()
                            : Localize.t(this, "配对失败", "Pairing failed"));
                });
            }
        }).start();
    }

    private void addSpacing(LinearLayout parent, int dp) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, dp)));
        parent.addView(v);
    }
}

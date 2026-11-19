package dev.grokbot.nativeapp;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

public class PushSettingsActivity extends Activity {
    private CheckBox mBgSwitch;
    private Spinner mProviderSpinner;
    private Spinner mFrequencySpinner;
    private EditText mPrimaryInput;
    private EditText mSecondaryInput;
    private TextView mStatusView;
    private TextView mUnifiedPushPickBtn;
    private int mCurrentProviderPos = 0;
    private boolean mSkipNextSpinnerLoad = false;
    private final Handler mMain = new Handler(Looper.getMainLooper());

    private static final String[] PROVIDERS = { "none", "ntfy", "webhook", "unifiedpush", "fcm" };
    private static final String[] FREQUENCIES = { "every-reply", "task-complete" };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        buildUi();
        loadState();
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

        root.addView(UiChrome.makeHeaderBar(this,
                Localize.t(this, "推送通知设置", "Push Notification Settings"), p, v -> finish()));

        mStatusView = new TextView(this);
        mStatusView.setTextColor(p.blueAccent);
        mStatusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mStatusView.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 10));
        root.addView(mStatusView);

        LinearLayout card = UiChrome.makeCard(this, p);

        mBgSwitch = new CheckBox(this);
        mBgSwitch.setText(Localize.t(this, "启用后台 SSE 实时通知服务", "Background SSE Notification Service"));
        mBgSwitch.setTextColor(p.textPrimary);
        mBgSwitch.setChecked(Storage.isBackgroundNotificationsEnabled(this));
        card.addView(mBgSwitch);

        card.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "推送通道", "Push Transport Provider"), p));
        mProviderSpinner = new Spinner(this);
        mProviderSpinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, PROVIDERS));
        String curProv = Storage.getPushProvider(this);
        for (int i = 0; i < PROVIDERS.length; i++) {
            if (PROVIDERS[i].equals(curProv)) {
                mCurrentProviderPos = i;
                break;
            }
        }
        mProviderSpinner.setSelection(mCurrentProviderPos, false);
        card.addView(mProviderSpinner);

        card.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "URL / FCM 令牌", "URL / FCM Token"), p));
        mPrimaryInput = new EditText(this);
        UiChrome.styleEditText(mPrimaryInput, p, this);
        mPrimaryInput.setSingleLine(true);
        card.addView(mPrimaryInput);

        card.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "令牌 / 密钥 / UnifiedPush 分发器", "Token / Secret / UnifiedPush Distributor"), p));
        mSecondaryInput = new EditText(this);
        UiChrome.styleEditText(mSecondaryInput, p, this);
        mSecondaryInput.setSingleLine(true);
        card.addView(mSecondaryInput);

        applyProviderUi(PROVIDERS[mCurrentProviderPos], true);
        mProviderSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position < 0 || position >= PROVIDERS.length) return;
                boolean changed = position != mCurrentProviderPos;
                mCurrentProviderPos = position;
                boolean loadSaved = changed && !mSkipNextSpinnerLoad;
                mSkipNextSpinnerLoad = false;
                applyProviderUi(PROVIDERS[position], loadSaved);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });

        addSpacing(card, 8);
        mUnifiedPushPickBtn = UiChrome.makePillButton(this,
                Localize.t(this, "检测 UnifiedPush 分发器", "Pick UnifiedPush Distributor"),
                false, p, v -> pickUnifiedPushDistributor());
        mUnifiedPushPickBtn.setContentDescription("pick_unifiedpush_distributor_button");
        mUnifiedPushPickBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        card.addView(mUnifiedPushPickBtn);

        card.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "通知频率", "Notification Frequency"), p));
        mFrequencySpinner = new Spinner(this);
        mFrequencySpinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, FREQUENCIES));
        card.addView(mFrequencySpinner);

        root.addView(card);

        addSpacing(root, 14);
        TextView saveBtn = UiChrome.makePillButton(this, Localize.t(this, "保存推送设置", "Save Push Settings"), true, p, v -> save());
        root.addView(saveBtn);

        addSpacing(root, 10);
        TextView testBtn = UiChrome.makePillButton(this, Localize.t(this, "发送测试推送", "Send Test Push Notification"), false, p, v -> sendTestPush());
        testBtn.setContentDescription("send_test_push_button");
        testBtn.setTextColor(p.success);
        root.addView(testBtn);

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
    }

    private void applyProviderUi(String provider, boolean loadStoredValues) {
        if ("ntfy".equals(provider)) {
            mPrimaryInput.setEnabled(true);
            mSecondaryInput.setEnabled(true);
            mPrimaryInput.setHint(Localize.t(this, "ntfy 主题 URL（如 https://ntfy.sh/topic）", "ntfy topic URL (e.g. https://ntfy.sh/topic)"));
            mSecondaryInput.setHint(Localize.t(this, "可选 Bearer 访问令牌", "Optional Bearer access token"));
            if (loadStoredValues) {
                mPrimaryInput.setText(Storage.getNtfyUrl(this));
                mSecondaryInput.setText(Storage.getNtfyToken(this));
            }
        } else if ("webhook".equals(provider)) {
            mPrimaryInput.setEnabled(true);
            mSecondaryInput.setEnabled(true);
            mPrimaryInput.setHint(Localize.t(this, "Webhook URL（https://...）", "Webhook URL (https://...)"));
            mSecondaryInput.setHint(Localize.t(this, "可选 HMAC 签名密钥", "Optional HMAC secret"));
            if (loadStoredValues) {
                mPrimaryInput.setText(Storage.getWebhookUrl(this));
                mSecondaryInput.setText(Storage.getWebhookSecret(this));
            }
        } else if ("unifiedpush".equals(provider)) {
            mPrimaryInput.setEnabled(false);
            mSecondaryInput.setEnabled(true);
            mPrimaryInput.setHint(Localize.t(this, "由 UnifiedPush 分发器自动分配端点", "Endpoint managed by UnifiedPush distributor"));
            mSecondaryInput.setHint(Localize.t(this, "UnifiedPush 分发器包名", "UnifiedPush distributor package name"));
            if (loadStoredValues) {
                mPrimaryInput.setText("");
                mSecondaryInput.setText(Storage.getUnifiedPushDistributor(this));
            }
        } else if ("fcm".equals(provider)) {
            mPrimaryInput.setEnabled(true);
            mSecondaryInput.setEnabled(false);
            mPrimaryInput.setHint(Localize.t(this, "FCM 注册令牌", "FCM registration token"));
            mSecondaryInput.setHint(Localize.t(this, "无需额外参数", "Not used for FCM"));
            if (loadStoredValues) {
                mPrimaryInput.setText(Storage.getFcmToken(this));
                mSecondaryInput.setText("");
            }
        } else {
            mPrimaryInput.setEnabled(false);
            mSecondaryInput.setEnabled(false);
            mPrimaryInput.setHint(Localize.t(this, "未启用外部推送通道", "No external push provider"));
            mSecondaryInput.setHint(Localize.t(this, "未启用外部推送通道", "No external push provider"));
            if (loadStoredValues) {
                mPrimaryInput.setText("");
                mSecondaryInput.setText("");
            }
        }
    }

    private void pickUnifiedPushDistributor() {
        JSONArray dists = PushManager.getInstance(this).discoverUnifiedPushDistributors();
        if (dists == null || dists.length() == 0) {
            Toast.makeText(this,
                    Localize.t(this, "未检测到已安装的 UnifiedPush 分发器（如 ntfy / NextPush）。", "No UnifiedPush distributors installed (e.g. ntfy / NextPush)."),
                    Toast.LENGTH_LONG).show();
            return;
        }
        final String[] labels = new String[dists.length()];
        final String[] pkgs = new String[dists.length()];
        for (int i = 0; i < dists.length(); i++) {
            JSONObject obj = dists.optJSONObject(i);
            String pkg = obj != null ? UiChrome.jsonStr(obj, "packageName") : "";
            String lbl = obj != null ? UiChrome.jsonStr(obj, "label", pkg) : pkg;
            pkgs[i] = pkg;
            labels[i] = lbl + " (" + pkg + ")";
        }
        new AlertDialog.Builder(this)
                .setTitle(Localize.t(this, "选择 UnifiedPush 分发器", "Choose UnifiedPush Distributor"))
                .setItems(labels, (d, which) -> {
                    for (int i = 0; i < PROVIDERS.length; i++) {
                        if ("unifiedpush".equals(PROVIDERS[i])) {
                            if (mProviderSpinner.getSelectedItemPosition() != i) {
                                mSkipNextSpinnerLoad = true;
                                mCurrentProviderPos = i;
                                mProviderSpinner.setSelection(i, false);
                            }
                            applyProviderUi("unifiedpush", false);
                            break;
                        }
                    }
                    mPrimaryInput.setText("");
                    mSecondaryInput.setText(pkgs[which]);
                })
                .show();
    }

    private void loadState() {
        new Thread(() -> {
            try {
                JSONObject dev = HostApiClient.getDevice(this);
                JSONObject settings = HostApiClient.getNotificationSettings(this);
                String auth = PushManager.getInstance(this).getAuthorizationState();
                String freq = UiChrome.jsonStr(settings, "frequency", "every-reply");
                JSONArray dists = PushManager.getInstance(this).discoverUnifiedPushDistributors();
                int distCount = dists != null ? dists.length() : 0;
                String err = Storage.getRegistrationError(this);
                mMain.post(() -> {
                    mUnifiedPushPickBtn.setText(Localize.t(this,
                            "检测 UnifiedPush 分发器 (" + distCount + " 个可用)",
                            "Pick UnifiedPush Distributor (" + distCount + " found)"));
                    for (int i = 0; i < FREQUENCIES.length; i++) {
                        if (FREQUENCIES[i].equals(freq)) mFrequencySpinner.setSelection(i);
                    }
                    String status = Localize.t(this, "权限: ", "Auth: ") + auth
                            + " | " + Localize.t(this, "通道: ", "Provider: ") + Storage.getPushProvider(this);
                    if (err != null && !err.isEmpty()) status += "\nError: " + err;
                    if (dev.has("push") && dev.optJSONObject("push") != null) {
                        status += "\nForeground: " + dev.optJSONObject("push").optBoolean("foreground", false);
                    }
                    mStatusView.setText(status);
                });
            } catch (Throwable t) {
                mMain.post(() -> mStatusView.setText(Localize.t(this, "权限: ", "Auth: ") + PushManager.getInstance(this).getAuthorizationState()));
            }
        }).start();
    }

    private void save() {
        boolean bg = mBgSwitch.isChecked();
        String provider = PROVIDERS[mProviderSpinner.getSelectedItemPosition()];
        String primary = mPrimaryInput.getText().toString();
        String secondary = mSecondaryInput.getText().toString();
        String freq = FREQUENCIES[mFrequencySpinner.getSelectedItemPosition()];

        Storage.setBackgroundNotificationsEnabled(this, bg);
        NotificationService.sync(this, true);

        new Thread(() -> {
            try {
                PushManager.getInstance(this).configureProvider(provider, primary, secondary);
                HostApiClient.updateNotificationSettings(this, freq);
                mMain.post(() -> {
                    Toast.makeText(this, Localize.t(this, "推送设置已保存", "Push settings saved"), Toast.LENGTH_SHORT).show();
                    loadState();
                });
            } catch (Throwable t) {
                mMain.post(() -> Toast.makeText(this, "Error: " + t.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void sendTestPush() {
        new Thread(() -> {
            try {
                JSONObject res = HostApiClient.testPush(this, null);
                mMain.post(() -> Toast.makeText(this,
                        Localize.t(this, "测试推送已触发: ", "Push test sent: ") + res.toString(), Toast.LENGTH_LONG).show());
            } catch (Throwable t) {
                mMain.post(() -> Toast.makeText(this,
                        Localize.t(this, "测试推送失败: ", "Test push failed: ") + t.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void addSpacing(LinearLayout parent, int dp) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, dp)));
        parent.addView(v);
    }
}

package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
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

import java.io.File;

/**
 * "应用更新 / App Updates" screen: current version, whether it is the latest build on the paired
 * Host's android channel, release notes, download progress and the hand-off to the system
 * installer, including the "Install unknown apps" permission detour. Below it, the manual
 * incremental update (RBDELTA1 feed URL, UpdateManager) that used to sit on the profile page.
 */
public class UpdateActivity extends Activity {
    public static final String EXTRA_START_DOWNLOAD = "rokbot_update_start_download";
    static final String TITLE_ZH = "应用更新";
    static final String TITLE_EN = "App Updates";

    private TextView mStatus;
    private TextView mNewVersion;
    private TextView mNotesLabel;
    private TextView mNotes;
    private ProgressBar mProgress;
    private TextView mProgressText;
    private TextView mPrimary;
    private TextView mSecondary;
    private boolean mInstallAfterPermission;
    private boolean mAutoInstallWhenReady;
    private final Runnable mListener = this::render;
    private final android.os.Handler mMain = new android.os.Handler(android.os.Looper.getMainLooper());
    // Incremental update (UpdateManager feed URL).
    private EditText mDeltaUrl;
    private TextView mDeltaStatus;
    private TextView mDeltaCheck;
    private TextView mDeltaInstall;
    private File mDeltaStaged;
    private boolean mDeltaInstallAfterPermission;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        buildUi();
        AppUpdater.addListener(mListener);
        boolean startDownload = getIntent() != null && getIntent().getBooleanExtra(EXTRA_START_DOWNLOAD, false);
        int st = AppUpdater.state();
        if (savedInstanceState == null) {
            if (startDownload && st == AppUpdater.STATE_AVAILABLE) {
                mAutoInstallWhenReady = true;
                AppUpdater.download(this);
            } else if (startDownload && st == AppUpdater.STATE_READY) {
                install();
            } else if (st != AppUpdater.STATE_CHECKING && st != AppUpdater.STATE_DOWNLOADING
                    && st != AppUpdater.STATE_READY && st != AppUpdater.STATE_AVAILABLE) {
                AppUpdater.check(this, false);
            }
        }
        render();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (mDeltaInstallAfterPermission && mDeltaStaged != null && mDeltaStaged.isFile()
                && UpdateManager.canInstallPackages(this)) {
            mDeltaInstallAfterPermission = false;
            installDelta();
        }
        if (mInstallAfterPermission) {
            mInstallAfterPermission = false;
            if (UpdateManager.canInstallPackages(this)) {
                install();
            } else {
                Toast.makeText(this, Localize.t(this,
                        "未开启“允许安装未知应用”，暂时无法安装更新",
                        "\"Install unknown apps\" is still off; cannot install the update"), Toast.LENGTH_LONG).show();
            }
        }
        render();
    }

    @Override
    protected void onDestroy() {
        AppUpdater.removeListener(mListener);
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

        root.addView(UiChrome.makeHeaderBar(this, Localize.t(this, TITLE_ZH, TITLE_EN), p, v -> finish()));

        LinearLayout card = UiChrome.makeCard(this, p);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.topMargin = UiChrome.dp(this, 10);
        card.setLayoutParams(clp);

        View logo = UiChrome.makeRokLogoView(this, 64, p);
        card.addView(logo);

        TextView name = text(p.textPrimary, 20, true);
        name.setText("RokBot");
        name.setGravity(Gravity.CENTER);
        name.setPadding(0, UiChrome.dp(this, 10), 0, UiChrome.dp(this, 2));
        card.addView(name);

        TextView current = text(p.textSecondary, 13, false);
        current.setGravity(Gravity.CENTER);
        current.setText(Localize.t(this, "当前版本 ", "Version ") + AppUpdater.installedVersionLabel(this));
        current.setContentDescription("update_current_version");
        card.addView(current);

        mStatus = text(p.textPrimary, 15, true);
        mStatus.setGravity(Gravity.CENTER);
        mStatus.setPadding(0, UiChrome.dp(this, 14), 0, 0);
        mStatus.setContentDescription("update_status");
        card.addView(mStatus);

        mNewVersion = text(p.textSecondary, 13, false);
        mNewVersion.setGravity(Gravity.CENTER);
        mNewVersion.setPadding(0, UiChrome.dp(this, 4), 0, 0);
        card.addView(mNewVersion);

        mProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        mProgress.setMax(100);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, UiChrome.dp(this, 8));
        plp.topMargin = UiChrome.dp(this, 14);
        mProgress.setLayoutParams(plp);
        mProgress.setContentDescription("update_progress");
        card.addView(mProgress);

        mProgressText = text(p.textSecondary, 12, false);
        mProgressText.setGravity(Gravity.CENTER);
        mProgressText.setPadding(0, UiChrome.dp(this, 6), 0, 0);
        card.addView(mProgressText);
        root.addView(card);

        mNotesLabel = UiChrome.makeSectionLabel(this, Localize.t(this, "更新说明", "What's new"), p);
        root.addView(mNotesLabel);
        LinearLayout notesCard = UiChrome.makeCard(this, p);
        mNotes = text(p.textPrimary, 14, false);
        mNotes.setLineSpacing(0f, 1.15f);
        notesCard.addView(mNotes);
        root.addView(notesCard);
        mNotes.setTag(notesCard);

        addSpacing(root, 18);
        mPrimary = UiChrome.makePillButton(this, "", true, p, v -> onPrimary());
        mPrimary.setContentDescription("update_primary_button");
        root.addView(mPrimary);
        addSpacing(root, 10);
        mSecondary = UiChrome.makePillButton(this, Localize.t(this, "稍后", "Later"), false, p, v -> finish());
        root.addView(mSecondary);

        TextView foot = text(p.textMuted, 12, false);
        foot.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 16), UiChrome.dp(this, 4), 0);
        foot.setText(Localize.t(this,
                "更新来自已配对 Host 的 Android 更新通道。下载后会校验 SHA-256 和签名证书，签名与当前 App 不一致的安装包会被拒绝。连接 Host 时每 6 小时自动检查一次。",
                "Updates come from the paired Host's Android channel. Downloads are checked against their SHA-256 and the app signing certificate; "
                        + "packages signed by anyone else are refused. RokBot checks automatically every 6 hours while connected."));
        root.addView(foot);

        root.addView(buildDeltaCard(p));

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
    }

    private TextView text(int color, int sp, boolean bold) {
        TextView tv = new TextView(this);
        tv.setTextColor(color);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        if (bold) tv.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        tv.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return tv;
    }

    private void addSpacing(LinearLayout parent, int dp) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, dp)));
        parent.addView(v);
    }

    private void render() {
        if (mStatus == null || isFinishing()) return;
        UiChrome.Palette p = UiChrome.palette(this);
        int st = AppUpdater.state();
        UpdateManager.UpdateManifestInfo info = AppUpdater.info();
        boolean hasInfo = info != null && (st == AppUpdater.STATE_AVAILABLE || st == AppUpdater.STATE_DOWNLOADING
                || st == AppUpdater.STATE_READY || (st == AppUpdater.STATE_ERROR && AppUpdater.info() != null));

        String status;
        int statusColor = p.textPrimary;
        switch (st) {
            case AppUpdater.STATE_CHECKING:
                status = Localize.t(this, "正在检查更新…", "Checking for updates…");
                break;
            case AppUpdater.STATE_UP_TO_DATE:
                status = Localize.t(this, "已是最新版本", "You're up to date");
                statusColor = p.success;
                break;
            case AppUpdater.STATE_AVAILABLE:
                status = Localize.t(this, "发现新版本", "Update available");
                statusColor = p.blueAccent;
                break;
            case AppUpdater.STATE_DOWNLOADING:
                status = Localize.t(this, "正在下载更新…", "Downloading update…");
                statusColor = p.blueAccent;
                break;
            case AppUpdater.STATE_READY:
                status = Localize.t(this, "更新已下载，可以安装", "Update ready to install");
                statusColor = p.success;
                break;
            case AppUpdater.STATE_ERROR:
                status = AppUpdater.message();
                statusColor = p.danger;
                break;
            default:
                status = "";
        }
        mStatus.setText(status);
        mStatus.setTextColor(statusColor);

        if (hasInfo) {
            mNewVersion.setVisibility(View.VISIBLE);
            long size = info.hasDelta && info.deltaSize > 0 ? info.deltaSize : info.fullSize;
            mNewVersion.setText(Localize.t(this, "新版本 ", "New version ") + AppUpdater.availableVersionLabel(info)
                    + (size > 0 ? " · " + UpdateManager.formatBytes(size) : ""));
        } else if (st == AppUpdater.STATE_UP_TO_DATE && AppUpdater.noRelease()) {
            mNewVersion.setVisibility(View.VISIBLE);
            mNewVersion.setText(Localize.t(this, "Host 的 Android 更新通道暂无发布", "Nothing published on the Host's Android channel yet"));
        } else {
            mNewVersion.setVisibility(View.GONE);
        }

        String notes = hasInfo && info.releaseNotes != null ? info.releaseNotes.trim() : "";
        int notesVis = notes.isEmpty() ? View.GONE : View.VISIBLE;
        mNotes.setText(notes);
        mNotesLabel.setVisibility(notesVis);
        ((View) mNotes.getTag()).setVisibility(notesVis);

        boolean downloading = st == AppUpdater.STATE_DOWNLOADING;
        boolean ready = st == AppUpdater.STATE_READY;
        mProgress.setVisibility(downloading || ready ? View.VISIBLE : View.GONE);
        mProgress.setIndeterminate(downloading && AppUpdater.progress() <= 0);
        mProgress.setProgress(ready ? 100 : Math.max(0, AppUpdater.progress()));
        String pm = AppUpdater.message();
        mProgressText.setVisibility((downloading || ready) && !TextUtils.isEmpty(pm) ? View.VISIBLE : View.GONE);
        mProgressText.setText(downloading && AppUpdater.progress() >= 0 ? pm + "  " + AppUpdater.progress() + "%" : pm);

        String primary;
        boolean enabled = true;
        switch (st) {
            case AppUpdater.STATE_AVAILABLE:
                primary = Localize.t(this, "立即更新", "Update now");
                break;
            case AppUpdater.STATE_DOWNLOADING:
                primary = Localize.t(this, "正在下载…", "Downloading…");
                enabled = false;
                break;
            case AppUpdater.STATE_READY:
                primary = Localize.t(this, "安装更新", "Install update");
                break;
            case AppUpdater.STATE_CHECKING:
                primary = Localize.t(this, "正在检查…", "Checking…");
                enabled = false;
                break;
            case AppUpdater.STATE_ERROR:
                primary = Localize.t(this, "重试", "Try again");
                break;
            default:
                primary = Localize.t(this, "检查更新", "Check for updates");
        }
        mPrimary.setText(primary);
        mPrimary.setEnabled(enabled);
        mPrimary.setAlpha(enabled ? 1f : 0.55f);
        mSecondary.setVisibility(st == AppUpdater.STATE_AVAILABLE || st == AppUpdater.STATE_READY ? View.VISIBLE : View.GONE);

        if (ready && mAutoInstallWhenReady) {
            mAutoInstallWhenReady = false;
            install();
        }
    }

    private void onPrimary() {
        int st = AppUpdater.state();
        if (st == AppUpdater.STATE_AVAILABLE) {
            mAutoInstallWhenReady = true;
            AppUpdater.download(this);
        } else if (st == AppUpdater.STATE_READY) {
            install();
        } else if (st == AppUpdater.STATE_ERROR && AppUpdater.info() != null) {
            mAutoInstallWhenReady = true;
            AppUpdater.download(this);
        } else if (st != AppUpdater.STATE_CHECKING && st != AppUpdater.STATE_DOWNLOADING) {
            AppUpdater.check(this, false);
        }
    }

    private void install() {
        File apk = AppUpdater.stagedApk();
        if (apk == null || !apk.isFile()) {
            AppUpdater.check(this, false);
            return;
        }
        if (!UpdateManager.canInstallPackages(this)) {
            new AlertDialog.Builder(this, AppUpdater.dialogTheme(this))
                    .setTitle(Localize.t(this, "需要允许安装未知应用", "Allow installing apps"))
                    .setMessage(Localize.t(this,
                            "Android 需要你允许 RokBot 安装应用，才能安装更新。\n\n请在接下来的设置页中打开“允许来自此来源的应用”（或“允许安装未知应用”），然后返回 RokBot，安装会自动继续。",
                            "Android requires your permission before RokBot can install updates.\n\nOn the next screen, turn on \"Allow from this source\", then come back to RokBot and the installation continues automatically."))
                    .setPositiveButton(Localize.t(this, "去设置", "Open settings"), (d, w) -> {
                        mInstallAfterPermission = true;
                        try {
                            UpdateManager.openInstallPermissionSettings(this);
                        } catch (Throwable t) {
                            mInstallAfterPermission = false;
                            Toast.makeText(this, t.getMessage(), Toast.LENGTH_LONG).show();
                        }
                    })
                    .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
                    .show();
            return;
        }
        try {
            AppUpdater.notePendingInstall(this);
            UpdateManager.launchInstaller(this, apk);
        } catch (Throwable t) {
            Toast.makeText(this, Localize.t(this, "无法打开系统安装器：", "Cannot open the installer: ") + t.getMessage(),
                    Toast.LENGTH_LONG).show();
        }
    }

    // ---- incremental update (moved from the profile page) ----

    private View buildDeltaCard(UiChrome.Palette p) {
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "增量更新", "Incremental update"), p));
        LinearLayout card = UiChrome.makeCard(this, p);
        card.setContentDescription("delta_update_card");

        TextView ver = text(p.textSecondary, 12, false);
        ver.setText(Localize.t(this, "当前版本：", "Current version: ")
                + UpdateManager.getCurrentVersionLabel(this) + " (" + getPackageName() + ")");
        ver.setPadding(0, 0, 0, UiChrome.dp(this, 8));
        card.addView(ver);

        mDeltaUrl = new EditText(this);
        UiChrome.styleEditText(mDeltaUrl, p, this);
        mDeltaUrl.setHint(Localize.t(this, "更新清单地址 (https://.../update.json)", "Update manifest URL (https://.../update.json)"));
        mDeltaUrl.setContentDescription("update_feed_url_input");
        mDeltaUrl.setSingleLine(true);
        mDeltaUrl.setText(UpdateManager.resolveDefaultFeedUrl(this));
        mDeltaUrl.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        card.addView(mDeltaUrl);

        mDeltaStatus = text(p.textSecondary, 12, false);
        mDeltaStatus.setText(Localize.t(this, "支持 RBDELTA1 增量补丁（仅下载差异部分并校验签名）",
                "Supports RBDELTA1 incremental patches with SHA-256 & signature verification"));
        mDeltaStatus.setPadding(0, UiChrome.dp(this, 8), 0, UiChrome.dp(this, 10));
        card.addView(mDeltaStatus);

        mDeltaCheck = UiChrome.makePillButton(this, Localize.t(this, "检查增量更新", "Check for Incremental Update"), false, p,
                v -> checkDelta());
        mDeltaCheck.setContentDescription("check_incremental_update_button");
        card.addView(mDeltaCheck);

        mDeltaInstall = UiChrome.makePillButton(this, Localize.t(this, "立即安装更新", "Install Staged Update"), true, p,
                v -> installDelta());
        mDeltaInstall.setContentDescription("install_staged_update_button");
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ilp.topMargin = UiChrome.dp(this, 8);
        mDeltaInstall.setLayoutParams(ilp);
        mDeltaInstall.setVisibility(View.GONE);
        card.addView(mDeltaInstall);
        wrap.addView(card);
        return wrap;
    }

    private void checkDelta() {
        String url = mDeltaUrl.getText() != null ? mDeltaUrl.getText().toString().trim() : "";
        if (!url.isEmpty()) Storage.setUpdateFeedUrl(this, url);
        mDeltaCheck.setEnabled(false);
        mDeltaInstall.setVisibility(View.GONE);
        mDeltaStatus.setText(Localize.t(this, "正在检查更新…", "Checking for updates…"));
        UpdateManager.checkAndStageAsync(this, url, new UpdateManager.Callback() {
            @Override
            public void onStage(String message, int progressPercent) {
                mMain.post(() -> mDeltaStatus.setText(message + " (" + progressPercent + "%)"));
            }

            @Override
            public void onUpToDate(String currentVersion, String shortSha) {
                mMain.post(() -> {
                    mDeltaCheck.setEnabled(true);
                    mDeltaStatus.setText(Localize.t(UpdateActivity.this,
                            "已是最新版本：" + currentVersion + " [" + shortSha + "]",
                            "Already up to date: " + currentVersion + " [" + shortSha + "]"));
                });
            }

            @Override
            public void onReady(File stagedApk, String versionLabel, boolean usedDelta, long downloadBytes, long fullBytes, String notes) {
                mMain.post(() -> {
                    mDeltaStaged = stagedApk;
                    mDeltaCheck.setEnabled(true);
                    mDeltaInstall.setVisibility(View.VISIBLE);
                    String detail;
                    if (usedDelta && downloadBytes > 0 && fullBytes > 0) {
                        int savedPct = (int) Math.max(0, Math.round((1.0 - (double) downloadBytes / (double) fullBytes) * 100.0));
                        detail = Localize.t(UpdateActivity.this,
                                "增量更新已就绪：" + versionLabel + "（下载 " + UpdateManager.formatBytes(downloadBytes)
                                        + " / 原包 " + UpdateManager.formatBytes(fullBytes) + "，节省 " + savedPct + "%）",
                                "Incremental update ready: " + versionLabel + " (downloaded " + UpdateManager.formatBytes(downloadBytes)
                                        + " / " + UpdateManager.formatBytes(fullBytes) + ", saved " + savedPct + "%)");
                    } else if (usedDelta && downloadBytes == 0) {
                        detail = Localize.t(UpdateActivity.this,
                                "已缓存校验通过的更新包：" + versionLabel + "，点击下方按钮安装",
                                "Verified update already staged: " + versionLabel);
                    } else {
                        detail = Localize.t(UpdateActivity.this,
                                "完整更新包已就绪：" + versionLabel + "（" + UpdateManager.formatBytes(fullBytes) + "）",
                                "Full update ready: " + versionLabel + " (" + UpdateManager.formatBytes(fullBytes) + ")");
                    }
                    if (notes != null && !notes.isEmpty()) detail = detail + "\n" + notes;
                    mDeltaStatus.setText(detail);
                });
            }

            @Override
            public void onError(String message) {
                mMain.post(() -> {
                    mDeltaCheck.setEnabled(true);
                    mDeltaStatus.setText(Localize.t(UpdateActivity.this, "更新失败：", "Update failed: ") + message);
                });
            }
        });
    }

    private void installDelta() {
        if (mDeltaStaged == null || !mDeltaStaged.isFile()) {
            Toast.makeText(this, Localize.t(this, "请先检查并准备更新包", "Check for updates first"), Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            boolean launched = UpdateManager.launchInstaller(this, mDeltaStaged);
            mDeltaInstallAfterPermission = !launched;
            if (!launched) {
                Toast.makeText(this, Localize.t(this,
                        "请先授予“安装未知应用”权限，返回后将自动继续安装",
                        "Allow installing unknown apps; installer will resume automatically on return"), Toast.LENGTH_LONG).show();
            }
        } catch (Throwable t) {
            Toast.makeText(this, Localize.t(this, "拉起安装器失败：", "Installer error: ") + t.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}

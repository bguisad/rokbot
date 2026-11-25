package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import java.io.File;
import java.lang.ref.WeakReference;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * App-wide state of the RokBot Android update channel (paired Host {@code /local/updates/android.json}).
 *
 * <ul>
 *   <li>Automatic check when the RN app starts and whenever RokBot returns to the foreground,
 *       at most once per {@link #AUTO_CHECK_INTERVAL_MS}; failed checks retry after
 *       {@link #FAILURE_RETRY_MS}. Only runs while paired, with the device Bearer token.</li>
 *   <li>An update is offered only when the manifest versionCode is strictly higher than the
 *       installed one ({@link UpdateManager#isNewerVersionCode}).</li>
 *   <li>Downloads into {@code filesDir/updates} via {@link UpdateManager}, which verifies size,
 *       SHA-256, package name, signing certificate and versionCode before {@link UpdateActivity}
 *       hands the file to the system installer.</li>
 * </ul>
 * All listeners run on the main thread.
 */
public final class AppUpdater {
    private static final String TAG = "RokBotAppUpdater";

    public static final long AUTO_CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L;
    public static final long FAILURE_RETRY_MS = 30L * 60L * 1000L;

    static final String PREF_LAST_CHECK_OK_AT = "update_last_check_ok_at";
    static final String PREF_LAST_CHECK_ATTEMPT_AT = "update_last_check_attempt_at";
    static final String PREF_LATEST_VERSION_CODE = "update_latest_version_code";
    static final String PREF_LATEST_VERSION_NAME = "update_latest_version_name";
    static final String PREF_NO_RELEASE = "update_no_release";
    static final String PREF_PENDING_INSTALL_CODE = "update_pending_install_version_code";
    static final String PREF_PENDING_INSTALL_NAME = "update_pending_install_version_name";

    public static final int STATE_IDLE = 0;
    public static final int STATE_CHECKING = 1;
    public static final int STATE_UP_TO_DATE = 2;
    public static final int STATE_AVAILABLE = 3;
    public static final int STATE_DOWNLOADING = 4;
    public static final int STATE_READY = 5;
    public static final int STATE_ERROR = 6;

    private static Handler sMain;
    private static final CopyOnWriteArrayList<Runnable> LISTENERS = new CopyOnWriteArrayList<>();

    private static volatile int sState = STATE_IDLE;
    private static volatile UpdateManager.UpdateManifestInfo sInfo;
    private static volatile File sStagedApk;
    private static volatile String sMessage = "";
    private static volatile int sProgress = -1;
    private static volatile boolean sNoRelease;
    private static volatile boolean sCleanupDone;
    private static volatile boolean sPromptPending;
    private static WeakReference<AlertDialog> sPrompt = new WeakReference<>(null);

    private AppUpdater() {}

    private static synchronized Handler main() {
        if (sMain == null) sMain = new Handler(Looper.getMainLooper());
        return sMain;
    }

    // ---- pure policy (unit-tested) ----

    /**
     * Throttle for the automatic check: at least {@link #AUTO_CHECK_INTERVAL_MS} after the last
     * successful check, and {@link #FAILURE_RETRY_MS} after the last attempt (so an offline phone
     * does not hit the Host on every foreground). A clock that went backwards allows a check.
     */
    public static boolean shouldAutoCheck(long nowMs, long lastOkAtMs, long lastAttemptAtMs) {
        if (lastOkAtMs > nowMs || lastAttemptAtMs > nowMs) return true;
        if (lastOkAtMs > 0 && nowMs - lastOkAtMs < AUTO_CHECK_INTERVAL_MS) return false;
        return lastAttemptAtMs <= 0 || nowMs - lastAttemptAtMs >= FAILURE_RETRY_MS;
    }

    /** "1.26.0-rokbot.2 (321202)" */
    public static String formatVersion(String versionName, long versionCode) {
        String name = versionName != null && !versionName.trim().isEmpty() ? versionName.trim() : "?";
        return versionCode > 0 ? name + " (" + versionCode + ")" : name;
    }

    /**
     * Version line variants, longest first; the caller keeps the first one that fits on screen.
     * {@code base} is "versionName (versionCode)".
     */
    public static String[] versionLineCandidates(String base, String versionName, int state, boolean chinese) {
        String name = versionName != null && !versionName.isEmpty() ? versionName : base;
        boolean available = state == STATE_AVAILABLE || state == STATE_DOWNLOADING || state == STATE_READY;
        if (state == STATE_UP_TO_DATE) {
            return chinese
                    ? new String[] { base + " · 已是最新版本", name + " · 已是最新版本", name + " · 已是最新", name + " · 最新" }
                    : new String[] { base + " · Up to date", name + " · Up to date", name + " · Latest" };
        }
        if (available) {
            return chinese
                    ? new String[] { base + " · 有新版本", name + " · 有新版本", name + " · 可更新" }
                    : new String[] { base + " · Update available", name + " · Update available", name + " · Update" };
        }
        return new String[] { base };
    }

    // ---- state ----

    public static int state() { return sState; }
    public static UpdateManager.UpdateManifestInfo info() { return sInfo; }
    public static File stagedApk() { return sStagedApk; }
    public static String message() { return sMessage; }
    public static int progress() { return sProgress; }
    /** The Host answered 404: nothing has been published to the android channel yet. */
    public static boolean noRelease() { return sNoRelease; }

    public static void addListener(Runnable r) { if (r != null) LISTENERS.addIfAbsent(r); }
    public static void removeListener(Runnable r) { LISTENERS.remove(r); }

    private static void publish(int state, String message, int progress) {
        sState = state;
        sMessage = message != null ? message : "";
        sProgress = progress;
        main().post(() -> {
            for (Runnable r : LISTENERS) {
                try { r.run(); } catch (Throwable t) { Log.w(TAG, "listener failed", t); }
            }
            RokBotBootstrap.onUpdateStateChanged();
        });
    }

    public static String installedVersionLabel(Context ctx) {
        return formatVersion(UpdateManager.getInstalledVersionName(ctx), UpdateManager.getInstalledVersionCode(ctx));
    }

    public static String availableVersionLabel(UpdateManager.UpdateManifestInfo info) {
        return info == null ? "" : formatVersion(info.availableVersionName, info.availableVersionCode);
    }

    // ---- triggers ----

    /** RN MainActivity created (cold start) or RokBot came back to the foreground. */
    public static void onAppForeground(Activity activity) {
        if (activity == null) return;
        final Context app = activity.getApplicationContext();
        cleanupAfterUpgrade(app);
        if (!Storage.isPaired(app)) return;
        long now = System.currentTimeMillis();
        long lastOk = Storage.getLongPref(app, PREF_LAST_CHECK_OK_AT, 0L);
        if (!shouldAutoCheck(now, lastOk, Storage.getLongPref(app, PREF_LAST_CHECK_ATTEMPT_AT, 0L))) {
            if (sState == STATE_IDLE && lastOk > 0) {
                // New process inside the 6 h window: reuse the last answer for the settings version line.
                if (Storage.getLongPref(app, PREF_LATEST_VERSION_CODE, 0L) > UpdateManager.getInstalledVersionCode(app)) {
                    check(app, false); // the user chose "稍后": fetch the details again, but do not prompt
                } else {
                    sNoRelease = Storage.getLongPref(app, PREF_NO_RELEASE, 0L) == 1L;
                    publish(STATE_UP_TO_DATE, Localize.t(app, "已是最新版本", "You're up to date"), -1);
                }
            }
            return;
        }
        check(app, true);
    }

    /** Manual or automatic check. Automatic checks prompt on the foreground Activity when a newer build exists. */
    public static synchronized void check(Context context, final boolean automatic) {
        final Context app = context.getApplicationContext();
        int st = sState;
        if (st == STATE_CHECKING || st == STATE_DOWNLOADING) return;
        if (!Storage.isPaired(app)) {
            publish(STATE_ERROR, Localize.t(app, "尚未连接 Host，无法检查更新", "Not paired with a Host"), -1);
            return;
        }
        Storage.setLongPref(app, PREF_LAST_CHECK_ATTEMPT_AT, System.currentTimeMillis());
        sNoRelease = false;
        publish(STATE_CHECKING, Localize.t(app, "正在检查更新…", "Checking for updates…"), -1);
        UpdateManager.checkManifestAsync(app, "", new UpdateManager.CheckCallback() {
            @Override
            public void onUpToDate(String currentVersion, String shortSha) {
                onChecked(app, null, automatic);
            }

            @Override
            public void onUpdateAvailable(UpdateManager.UpdateManifestInfo info) {
                onChecked(app, info, automatic);
            }

            @Override
            public void onError(String message) {
                if (message != null && message.startsWith("HTTP 404")) {
                    sNoRelease = true;
                    onChecked(app, null, automatic);
                    return;
                }
                Log.w(TAG, "update check failed: " + message);
                sInfo = null;
                sStagedApk = null;
                publish(STATE_ERROR, Localize.t(app, "检查更新失败：", "Update check failed: ") + message, -1);
            }
        });
    }

    private static void onChecked(Context app, UpdateManager.UpdateManifestInfo info, boolean automatic) {
        Storage.setLongPref(app, PREF_LAST_CHECK_OK_AT, System.currentTimeMillis());
        Storage.setLongPref(app, PREF_NO_RELEASE, sNoRelease ? 1L : 0L);
        long installed = UpdateManager.getInstalledVersionCode(app);
        if (info == null || !UpdateManager.isNewerVersionCode(installed, info.availableVersionCode)) {
            sInfo = null;
            sStagedApk = null;
            Storage.setLongPref(app, PREF_LATEST_VERSION_CODE, Math.max(installed, 0L));
            publish(STATE_UP_TO_DATE, Localize.t(app, "已是最新版本", "You're up to date"), -1);
            return;
        }
        sInfo = info;
        Storage.setLongPref(app, PREF_LATEST_VERSION_CODE, info.availableVersionCode);
        Storage.setStringPref(app, PREF_LATEST_VERSION_NAME, info.availableVersionName);
        if (info.alreadyStaged && info.stagedFile != null) {
            sStagedApk = info.stagedFile;
            publish(STATE_READY, Localize.t(app, "新版本已下载并校验，可以安装", "Update downloaded and verified"), 100);
        } else {
            sStagedApk = null;
            publish(STATE_AVAILABLE, Localize.t(app, "发现新版本 ", "New version ") + availableVersionLabel(info), -1);
        }
        if (automatic) main().post(AppUpdater::promptOnForegroundActivity);
    }

    /** Downloads (delta or full APK) and verifies the update; ends in STATE_READY or STATE_ERROR. */
    public static synchronized void download(Context context) {
        final Context app = context.getApplicationContext();
        final UpdateManager.UpdateManifestInfo info = sInfo;
        if (info == null || sState == STATE_DOWNLOADING) return;
        publish(STATE_DOWNLOADING, Localize.t(app, "正在准备下载…", "Preparing download…"), 0);
        UpdateManager.stageFromInfoAsync(app, info, new UpdateManager.Callback() {
            @Override
            public void onStage(String message, int progressPercent) {
                publish(STATE_DOWNLOADING, message, Math.max(0, Math.min(100, progressPercent)));
            }

            @Override
            public void onUpToDate(String currentVersion, String shortSha) {
                publish(STATE_UP_TO_DATE, Localize.t(app, "已是最新版本", "You're up to date"), -1);
            }

            @Override
            public void onReady(File stagedApk, String versionLabel, boolean usedDelta, long downloadBytes, long fullBytes, String notes) {
                sStagedApk = stagedApk;
                publish(STATE_READY, Localize.t(app, "下载完成，SHA-256 与签名证书校验通过", "Downloaded; SHA-256 and signing certificate verified"), 100);
            }

            @Override
            public void onError(String message) {
                Log.w(TAG, "update download failed: " + message);
                publish(STATE_ERROR, Localize.t(app, "下载更新失败：", "Download failed: ") + message, -1);
            }
        });
    }

    /** Paired with a (possibly different) Host: forget the old channel's answer and check on the next foreground. */
    public static void onPairingChanged(Context context) {
        Context app = context.getApplicationContext();
        Storage.setLongPref(app, PREF_LAST_CHECK_OK_AT, 0L);
        Storage.setLongPref(app, PREF_LAST_CHECK_ATTEMPT_AT, 0L);
        Storage.setLongPref(app, PREF_LATEST_VERSION_CODE, 0L);
        Storage.setLongPref(app, PREF_NO_RELEASE, 0L);
        sInfo = null;
        sStagedApk = null;
        sNoRelease = false;
        if (sState != STATE_CHECKING && sState != STATE_DOWNLOADING) publish(STATE_IDLE, "", -1);
    }

    /** Remember what we asked the installer for, so the next launch can confirm and clean up. */
    static void notePendingInstall(Context context) {
        UpdateManager.UpdateManifestInfo info = sInfo;
        if (info == null) return;
        Storage.setLongPref(context, PREF_PENDING_INSTALL_CODE, info.availableVersionCode);
        Storage.setStringPref(context, PREF_PENDING_INSTALL_NAME, info.availableVersionName);
    }

    /**
     * After the system installer replaced the app: drop staged APKs (≈150 MB) and tell the user once.
     * Also removes stale staging leftovers whenever nothing newer is pending.
     */
    public static void cleanupAfterUpgrade(Context context) {
        if (sCleanupDone || context == null) return;
        sCleanupDone = true;
        final Context app = context.getApplicationContext();
        long installed = UpdateManager.getInstalledVersionCode(app);
        long pending = Storage.getLongPref(app, PREF_PENDING_INSTALL_CODE, 0L);
        long latest = Storage.getLongPref(app, PREF_LATEST_VERSION_CODE, 0L);
        boolean upgraded = pending > 0 && installed >= pending;
        if (upgraded || latest <= installed) {
            File dir = new File(app.getFilesDir(), "updates");
            File[] files = dir.listFiles();
            if (files != null) {
                for (File f : files) {
                    if (f.isFile() && !f.delete()) Log.w(TAG, "could not delete " + f.getName());
                }
            }
        }
        if (upgraded) {
            String name = Storage.getStringPref(app, PREF_PENDING_INSTALL_NAME, "");
            Storage.setLongPref(app, PREF_PENDING_INSTALL_CODE, 0L);
            final String label = formatVersion(name, installed);
            main().post(() -> Toast.makeText(app,
                    Localize.t(app, "RokBot 已更新到 " + label, "RokBot updated to " + label),
                    Toast.LENGTH_LONG).show());
        }
    }

    // ---- prompt ----

    /** Prompts on the RN main screen; anywhere else (pairing, native pages) it waits until RN resumes. */
    private static void promptOnForegroundActivity() {
        Activity a = RokBotBootstrap.getCurrentActivity();
        if (a != null && !a.isFinishing() && !a.isDestroyed() && RokBotBootstrap.isForeground()
                && RokBotBootstrap.isReactActivity(a)) {
            sPromptPending = false;
            showPrompt(a);
        } else {
            sPromptPending = true;
        }
    }

    /** RN MainActivity resumed: show a prompt that an automatic check left pending. */
    public static void onReactActivityResumed(Activity activity) {
        if (!sPromptPending || activity == null) return;
        if (sState != STATE_AVAILABLE && sState != STATE_READY) {
            sPromptPending = false;
            return;
        }
        main().post(AppUpdater::promptOnForegroundActivity);
    }

    /** "发现新版本" dialog with 立即更新 / 稍后. */
    public static void showPrompt(final Activity activity) {
        final UpdateManager.UpdateManifestInfo info = sInfo;
        if (info == null || activity == null) return;
        AlertDialog existing = sPrompt.get();
        if (existing != null && existing.isShowing()) return;
        StringBuilder msg = new StringBuilder();
        msg.append(Localize.t(activity, "新版本：", "New version: ")).append(availableVersionLabel(info)).append('\n');
        msg.append(Localize.t(activity, "当前版本：", "Installed: ")).append(installedVersionLabel(activity)).append('\n');
        long size = info.hasDelta && info.deltaSize > 0 ? info.deltaSize : info.fullSize;
        if (size > 0) {
            msg.append(Localize.t(activity, "下载大小：", "Download size: ")).append(UpdateManager.formatBytes(size)).append('\n');
        }
        if (info.releaseNotes != null && !info.releaseNotes.trim().isEmpty()) {
            msg.append('\n').append(Localize.t(activity, "更新说明：\n", "What's new:\n")).append(info.releaseNotes.trim());
        }
        try {
            AlertDialog dlg = new AlertDialog.Builder(activity, dialogTheme(activity))
                    .setTitle(Localize.t(activity, "发现 RokBot 新版本", "RokBot update available"))
                    .setMessage(msg.toString())
                    .setPositiveButton(Localize.t(activity, "立即更新", "Update now"), (d, w) -> {
                        Intent i = new Intent(activity, UpdateActivity.class);
                        i.putExtra(UpdateActivity.EXTRA_START_DOWNLOAD, true);
                        activity.startActivity(i);
                    })
                    .setNegativeButton(Localize.t(activity, "稍后", "Later"), (d, w) -> d.dismiss())
                    .create();
            dlg.setCanceledOnTouchOutside(false);
            dlg.show();
            sPrompt = new WeakReference<>(dlg);
        } catch (Throwable t) {
            Log.w(TAG, "could not show update prompt", t);
        }
    }

    static int dialogTheme(Context context) {
        return UiChrome.isDark(context)
                ? android.R.style.Theme_DeviceDefault_Dialog_Alert
                : android.R.style.Theme_DeviceDefault_Light_Dialog_Alert;
    }
}

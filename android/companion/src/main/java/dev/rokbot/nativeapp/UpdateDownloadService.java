package dev.rokbot.nativeapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import java.io.File;

/**
 * Foreground service handling resilient background APK / delta pre-downloads with HTTP Range
 * resumption and transient backoff retries, without popping or auto-launching the installer.
 */
public class UpdateDownloadService extends Service {
    private static final String TAG = "RokBotUpdateSvc";
    public static final String CHANNEL_UPDATES = "updates";
    public static final int NOTIFICATION_ID = 9009;
    public static final String ACTION_DOWNLOAD_UPDATE = "dev.rokbot.nativeapp.DOWNLOAD_UPDATE";

    private static volatile boolean sRunning = false;
    private static volatile UpdateManager.UpdateManifestInfo sPendingInfo;

    public static void enqueue(Context context, UpdateManager.UpdateManifestInfo info) {
        if (context == null || info == null) return;
        final Context app = context.getApplicationContext();
        if (!Storage.isAutoDownloadUpdatesEnabled(app)) return;
        sPendingInfo = info;
        Intent intent = new Intent(app, UpdateDownloadService.class);
        intent.setAction(ACTION_DOWNLOAD_UPDATE);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(intent);
            } else {
                app.startService(intent);
            }
        } catch (Throwable t) {
            Log.w(TAG, "ForegroundService start fallback: " + t.getMessage());
            AppUpdater.download(app);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel(this);
        promoteForeground(Localize.t(this, "正在后台准备应用更新…", "Downloading update in background…"), 0);

        final UpdateManager.UpdateManifestInfo info = sPendingInfo != null ? sPendingInfo : AppUpdater.info();
        if (info == null || !Storage.isAutoDownloadUpdatesEnabled(this)) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        synchronized (UpdateDownloadService.class) {
            if (sRunning) {
                return START_STICKY;
            }
            sRunning = true;
        }
        final Context app = getApplicationContext();
        new Thread(() -> {
            try {
                runWithRetry(app, info);
            } finally {
                synchronized (UpdateDownloadService.class) {
                    sRunning = false;
                }
                stopSelf(startId);
            }
        }, "RokBotBgUpdate").start();
        return START_STICKY;
    }

    private void runWithRetry(Context app, UpdateManager.UpdateManifestInfo info) {
        final int maxRetries = 3;
        for (int attempt = 1; attempt <= maxRetries; attempt++) {
            if (!Storage.isAutoDownloadUpdatesEnabled(app)) return;
            final int currentAttempt = attempt;
            final boolean[] succeeded = new boolean[1];
            final boolean[] fatal = new boolean[1];
            final Object latch = new Object();
            final boolean[] finished = new boolean[1];

            UpdateManager.stageFromInfoAsync(app, info, new UpdateManager.Callback() {
                @Override
                public void onStage(String message, int progressPercent) {
                    AppUpdater.onBackgroundProgress(message, progressPercent);
                    promoteForeground(message, progressPercent);
                }

                @Override
                public void onUpToDate(String currentVersion, String shortSha) {
                    succeeded[0] = true;
                    synchronized (latch) { finished[0] = true; latch.notifyAll(); }
                }

                @Override
                public void onReady(File stagedApk, String versionLabel, boolean usedDelta, long downloadBytes, long fullBytes, String notes) {
                    AppUpdater.onBackgroundReady(app, info, stagedApk);
                    succeeded[0] = true;
                    synchronized (latch) { finished[0] = true; latch.notifyAll(); }
                }

                @Override
                public void onError(String message) {
                    if (message != null && (message.contains("SHA-256") || message.contains("signature") || message.contains("证书"))) {
                        fatal[0] = true;
                    }
                    if (currentAttempt >= maxRetries || fatal[0]) {
                        AppUpdater.onBackgroundError(app, message);
                    }
                    synchronized (latch) { finished[0] = true; latch.notifyAll(); }
                }
            });

            synchronized (latch) {
                while (!finished[0]) {
                    try { latch.wait(120_000L); break; } catch (InterruptedException ignored) {}
                }
            }
            if (succeeded[0] || fatal[0]) return;
            if (attempt < maxRetries) {
                try { Thread.sleep(2000L * attempt); } catch (InterruptedException ignored) { return; }
            }
        }
    }

    private void promoteForeground(String text, int progress) {
        try {
            Intent open = new Intent(this, UpdateActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, 9010, open,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(this, CHANNEL_UPDATES)
                    : new Notification.Builder(this);
            NotificationService.applySmallIcon(this, b);
            b.setContentTitle(Localize.t(this, "RokBot 更新准备", "RokBot Update"))
                    .setContentText(text != null ? text : "")
                    .setContentIntent(pi)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true);
            if (progress > 0 && progress < 100) {
                b.setProgress(100, progress, false);
            }
            Notification n = b.build();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Throwable ignored) {}
    }

    private static void createChannel(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm == null) return;
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_UPDATES,
                    Localize.t(ctx, "应用后台更新", "Background App Updates"),
                    NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

package dev.rokbot.nativeapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import java.io.File;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            boolean fromBoot = Intent.ACTION_BOOT_COMPLETED.equals(action);
            if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
                cleanupStagedUpdates(context);
            }
            final PendingResult pendingResult = (fromBoot && Build.VERSION.SDK_INT >= 35) ? goAsync() : null;
            boolean handedOff = false;
            try {
                Storage.init(context);
                NotificationService.syncFromBoot(context, fromBoot, () -> {
                    if (pendingResult != null) {
                        try { pendingResult.finish(); } catch (Throwable ignored) {}
                    }
                });
                handedOff = true;
            } finally {
                if (!handedOff && pendingResult != null) {
                    try { pendingResult.finish(); } catch (Throwable ignored) {}
                }
            }
        }
    }

    private static void cleanupStagedUpdates(Context context) {
        if (context == null) return;
        try {
            File updatesDir = new File(context.getFilesDir(), "updates");
            File[] files = updatesDir.listFiles();
            if (files == null) return;
            for (File f : files) {
                String name = f.getName();
                if (name.endsWith(".apk") || name.endsWith(".tmp")) {
                    f.delete();
                }
            }
        } catch (Throwable ignored) {}
    }
}

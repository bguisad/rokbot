package dev.rokbot.nativeapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            boolean fromBoot = Intent.ACTION_BOOT_COMPLETED.equals(action);
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
}

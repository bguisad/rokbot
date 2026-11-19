package dev.rokbot.nativeapp;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

public class VoiceCallService extends Service {
    private static final int NOTIFICATION_ID = 9003;

    public static void start(Context context, String agentName) {
        Intent intent = new Intent(context, VoiceCallService.class);
        intent.putExtra("agentName", agentName);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Throwable ignored) {}
    }

    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, VoiceCallService.class));
        } catch (Throwable ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationService.createChannels(this);
        String name = intent != null ? intent.getStringExtra("agentName") : null;
        if (name == null || name.isEmpty()) name = "Bot";
        Intent openIntent = RokBotBootstrap.buildLauncherIntent(this);
        openIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, NotificationService.CHANNEL_MESSAGES)
            : new Notification.Builder(this);
        Notification notif = builder
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(Localize.t(this, "语音通话中", "Voice Call Active"))
            .setContentText(Localize.t(this, "正在与 " + name + " 通话", "Speaking with " + name))
            .setContentIntent(pi)
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 30) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notif);
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

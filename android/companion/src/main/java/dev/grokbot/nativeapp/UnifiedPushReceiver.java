package dev.grokbot.nativeapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

public class UnifiedPushReceiver extends BroadcastReceiver {
    public static final String ACTION_MESSAGE = "org.unifiedpush.android.connector.MESSAGE";
    public static final String ACTION_NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT";
    public static final String ACTION_UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED";
    public static final String ACTION_REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        Storage.init(context);
        String action = intent.getAction();
        String token = intent.getStringExtra("token");

        if (ACTION_NEW_ENDPOINT.equals(action)) {
            String endpoint = intent.getStringExtra("endpoint");
            if (endpoint != null && !endpoint.isEmpty() && token != null) {
                PushManager.getInstance(context).onUnifiedPushEndpoint(endpoint.trim(), token.trim());
            }
        } else if (ACTION_UNREGISTERED.equals(action)) {
            if (token != null) {
                PushManager.getInstance(context).onUnifiedPushUnregistered(token.trim());
            }
        } else if (ACTION_REGISTRATION_FAILED.equals(action)) {
            String message = intent.getStringExtra("message");
            PushManager.getInstance(context).onUnifiedPushFailed(message);
        } else if (ACTION_MESSAGE.equals(action)) {
            byte[] bytesMsg = intent.getByteArrayExtra("bytesMessage");
            String raw = (bytesMsg != null && bytesMsg.length > 0)
                ? new String(bytesMsg, StandardCharsets.UTF_8)
                : intent.getStringExtra("message");
            if (raw == null || raw.isEmpty()) return;
            PendingResult pending = goAsync();
            new Thread(() -> {
                try {
                    JSONObject parsed = new JSONObject(raw);
                    String deviceId = Storage.getDeviceId(context);
                    if (deviceId != null) {
                        NotificationService.deliverIncoming(context, deviceId, parsed, null, false);
                    }
                } catch (Throwable ignored) {
                    NotificationService.poke(context);
                } finally {
                    pending.finish();
                }
            }).start();
        }
    }
}

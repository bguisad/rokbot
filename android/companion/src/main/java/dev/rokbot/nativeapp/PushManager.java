package dev.rokbot.nativeapp;

import android.Manifest;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public class PushManager {
    private static volatile PushManager sInstance;

    public static PushManager getInstance(Context context) {
        if (sInstance == null) {
            synchronized (PushManager.class) {
                if (sInstance == null) sInstance = new PushManager(context.getApplicationContext());
            }
        }
        return sInstance;
    }

    private final Context mContext;
    private final ExecutorService mIo = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "rokbot-push-io");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService mScheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "rokbot-fg-hb");
        t.setDaemon(true);
        return t;
    });
    private ScheduledFuture<?> mHeartbeat;
    private ScheduledFuture<?> mUnifiedPushTimeout;

    private PushManager(Context context) {
        mContext = context;
    }

    public String getAuthorizationState() {
        NotificationManager nm = mContext.getSystemService(NotificationManager.class);
        boolean enabled = nm == null || nm.areNotificationsEnabled();
        if (Build.VERSION.SDK_INT >= 33) {
            boolean granted = mContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
            if (granted && enabled) return "granted";
            return (Storage.wasNotificationPermissionAsked(mContext) || !enabled) ? "denied" : "not_determined";
        }
        return enabled ? "granted" : "denied";
    }

    public JSONArray discoverUnifiedPushDistributors() {
        JSONArray arr = new JSONArray();
        try {
            Intent intent = new Intent("org.unifiedpush.android.distributor.REGISTER");
            PackageManager pm = mContext.getPackageManager();
            List<ResolveInfo> list = Build.VERSION.SDK_INT >= 33
                ? pm.queryBroadcastReceivers(intent, PackageManager.ResolveInfoFlags.of(PackageManager.GET_RESOLVED_FILTER))
                : pm.queryBroadcastReceivers(intent, PackageManager.GET_RESOLVED_FILTER);
            Set<String> seen = new HashSet<>();
            for (ResolveInfo info : list) {
                if (info.activityInfo == null) continue;
                String pkg = info.activityInfo.packageName;
                if (pkg == null || pkg.equals(mContext.getPackageName()) || !seen.add(pkg)) continue;
                CharSequence labelCs = info.loadLabel(pm);
                String label = labelCs != null && labelCs.length() > 0 ? labelCs.toString().trim() : pkg;
                arr.put(new JSONObject().put("packageName", pkg).put("label", label));
            }
        } catch (Throwable ignored) {}
        return arr;
    }

    public synchronized void onForegroundChanged(boolean active) {
        if (mHeartbeat != null) {
            mHeartbeat.cancel(false);
            mHeartbeat = null;
        }
        NotificationService.syncForeground(mContext, active);
        if (active && Storage.isPaired(mContext)) {
            mHeartbeat = mScheduler.scheduleWithFixedDelay(() -> {
                if (RokBotBootstrap.isForeground() && Storage.isPaired(mContext)) {
                    try {
                        HostApiClient.putDevice(mContext, new JSONObject().put("foreground", true));
                    } catch (Throwable ignored) {}
                }
            }, 25, 25, TimeUnit.SECONDS);
        }
        mIo.execute(() -> {
            try {
                if (active) syncDevice(true, false);
                else if (Storage.isPaired(mContext)) {
                    HostApiClient.putDevice(mContext, new JSONObject().put("foreground", false));
                }
            } catch (Throwable ignored) {}
        });
    }

    public void syncDeviceAsync(Boolean foreground, boolean includePush) {
        syncDeviceAsync(foreground, includePush, null);
    }

    public void syncDeviceAsync(Boolean foreground, boolean includePush, Runnable onComplete) {
        mIo.execute(() -> {
            try {
                syncDevice(foreground, includePush);
            } catch (Throwable ignored) {
            } finally {
                if (onComplete != null) {
                    try { onComplete.run(); } catch (Throwable ignored) {}
                }
            }
        });
    }

    public JSONObject syncDevice(Boolean foreground, boolean includePush) throws Exception {
        if (!Storage.isPaired(mContext)) return null;
        JSONObject payload = new JSONObject();
        payload.put("name", HostApiClient.deviceName(mContext));
        payload.put("kind", "desktop");
        payload.put("clientKind", "android");
        payload.put("clientDeviceId", HostApiClient.clientDeviceId(mContext));
        payload.put("bundleId", mContext.getPackageName());
        payload.put("appVersion", "1.16.0");
        payload.put("pushCapable", true);
        payload.put("authorization", getAuthorizationState());
        if (foreground != null) payload.put("foreground", foreground);

        if (includePush) {
            String provider = Storage.getPushProvider(mContext);
            JSONObject push = new JSONObject().put("provider", provider);
            if ("unifiedpush".equals(provider)) {
                String ep = Storage.getUnifiedPushEndpoint(mContext);
                if (ep.isEmpty()) return HostApiClient.putDevice(mContext, payload);
                push.put("endpoint", ep);
            } else if ("ntfy".equals(provider)) {
                push.put("ntfyUrl", Storage.getNtfyUrl(mContext));
                String tok = Storage.getNtfyToken(mContext);
                if (tok != null && !tok.isEmpty()) push.put("ntfyToken", tok);
            } else if ("webhook".equals(provider)) {
                push.put("webhookUrl", Storage.getWebhookUrl(mContext));
                String sec = Storage.getWebhookSecret(mContext);
                if (sec != null && !sec.isEmpty()) push.put("webhookSecret", sec);
            } else if ("fcm".equals(provider)) {
                String fcm = Storage.getFcmToken(mContext);
                if (fcm != null && !fcm.isEmpty()) push.put("fcmToken", fcm);
            }
            payload.put("push", push);
        }
        return HostApiClient.putDevice(mContext, payload);
    }

    public void configureProvider(String provider, String urlOrToken, String secretOrDist) throws Exception {
        if (provider == null) throw new IllegalArgumentException("Push provider is required");
        String normalized = provider.trim();
        String p1 = urlOrToken != null ? urlOrToken.trim() : "";
        String p2 = secretOrDist != null ? secretOrDist.trim() : "";

        if ("none".equals(normalized)) {
            // valid
        } else if ("ntfy".equals(normalized)) {
            if (p1.isEmpty()) throw new IllegalArgumentException("ntfy URL is required");
        } else if ("webhook".equals(normalized)) {
            if (p1.isEmpty()) throw new IllegalArgumentException("Webhook URL is required");
        } else if ("fcm".equals(normalized)) {
            if (p1.length() < 16) throw new IllegalArgumentException("Valid FCM token (>=16 chars) required");
        } else if ("unifiedpush".equals(normalized)) {
            if (p2.isEmpty()) p2 = Storage.getUnifiedPushDistributor(mContext);
            if (p2.isEmpty()) throw new IllegalArgumentException("UnifiedPush distributor package required");
        } else {
            throw new IllegalArgumentException("Unsupported push provider: " + normalized);
        }

        String prevProvider = Storage.getPushProvider(mContext);
        String prevNtfyUrl = Storage.getNtfyUrl(mContext);
        String prevNtfyToken = Storage.getNtfyToken(mContext);
        String prevWebhookUrl = Storage.getWebhookUrl(mContext);
        String prevWebhookSecret = Storage.getWebhookSecret(mContext);
        String prevFcmToken = Storage.getFcmToken(mContext);
        String prevDist = Storage.getUnifiedPushDistributor(mContext);
        String prevEp = Storage.getUnifiedPushEndpoint(mContext);

        Storage.setRegistrationError(mContext, null);
        cancelUnifiedPushTimeout();

        try {
            Storage.setPushProvider(mContext, normalized);
            if ("none".equals(normalized)) {
                syncDevice(RokBotBootstrap.isForeground(), true);
            } else if ("ntfy".equals(normalized)) {
                Storage.setNtfyUrl(mContext, p1);
                Storage.setNtfyToken(mContext, p2);
                syncDevice(RokBotBootstrap.isForeground(), true);
            } else if ("webhook".equals(normalized)) {
                Storage.setWebhookUrl(mContext, p1);
                Storage.setWebhookSecret(mContext, p2);
                syncDevice(RokBotBootstrap.isForeground(), true);
            } else if ("fcm".equals(normalized)) {
                Storage.setFcmToken(mContext, p1);
                syncDevice(RokBotBootstrap.isForeground(), true);
            } else {
                Storage.setUnifiedPushDistributor(mContext, p2);
                Storage.setUnifiedPushEndpoint(mContext, "");
                syncDevice(RokBotBootstrap.isForeground(), false);
                registerUnifiedPush(p2);
                scheduleUnifiedPushTimeout();
            }

            if ("unifiedpush".equals(prevProvider) && !"unifiedpush".equals(normalized)) {
                unregisterUnifiedPush(prevDist);
                Storage.resetUnifiedPushInstance(mContext);
            }
        } catch (Throwable t) {
            Storage.setPushProvider(mContext, prevProvider);
            Storage.setNtfyUrl(mContext, prevNtfyUrl);
            Storage.setNtfyToken(mContext, prevNtfyToken);
            Storage.setWebhookUrl(mContext, prevWebhookUrl);
            Storage.setWebhookSecret(mContext, prevWebhookSecret);
            Storage.setFcmToken(mContext, prevFcmToken);
            Storage.setUnifiedPushDistributor(mContext, prevDist);
            Storage.setUnifiedPushEndpoint(mContext, prevEp);
            Storage.setRegistrationError(mContext, t.getMessage());
            if (t instanceof Exception) throw (Exception) t;
            throw new RuntimeException(t);
        }
    }

    private void registerUnifiedPush(String distributor) {
        String token = Storage.getOrCreateUnifiedPushInstance(mContext);
        PendingIntent pi = PendingIntent.getBroadcast(
            mContext, 0, new Intent(mContext, UnifiedPushReceiver.class), PendingIntent.FLAG_IMMUTABLE
        );
        Intent intent = new Intent("org.unifiedpush.android.distributor.REGISTER")
            .setPackage(distributor)
            .putExtra("token", token)
            .putExtra("application", mContext.getPackageName())
            .putExtra("pi", pi);
        mContext.sendBroadcast(intent);
    }

    private void unregisterUnifiedPush(String dist) {
        if (dist == null || dist.isEmpty()) return;
        String token = Storage.getOrCreateUnifiedPushInstance(mContext);
        try {
            mContext.sendBroadcast(new Intent("org.unifiedpush.android.distributor.UNREGISTER")
                .setPackage(dist).putExtra("token", token));
        } catch (Throwable ignored) {}
    }

    private synchronized void cancelUnifiedPushTimeout() {
        if (mUnifiedPushTimeout != null) {
            mUnifiedPushTimeout.cancel(false);
            mUnifiedPushTimeout = null;
        }
    }

    private synchronized void scheduleUnifiedPushTimeout() {
        cancelUnifiedPushTimeout();
        mUnifiedPushTimeout = mScheduler.schedule(() -> {
            if ("unifiedpush".equals(Storage.getPushProvider(mContext)) && Storage.getUnifiedPushEndpoint(mContext).isEmpty()) {
                Storage.setRegistrationError(mContext, "UnifiedPush distributor did not return an endpoint within 12s.");
            }
        }, 12, TimeUnit.SECONDS);
    }

    public void onUnifiedPushEndpoint(String endpoint, String token) {
        if (!"unifiedpush".equals(Storage.getPushProvider(mContext))) return;
        if (!Storage.getOrCreateUnifiedPushInstance(mContext).equals(token)) return;
        cancelUnifiedPushTimeout();
        Storage.setUnifiedPushEndpoint(mContext, endpoint);
        Storage.setRegistrationError(mContext, null);
        mIo.execute(() -> {
            try { syncDevice(RokBotBootstrap.isForeground(), true); }
            catch (Throwable t) { Storage.setRegistrationError(mContext, t.getMessage()); }
        });
    }

    public void onUnifiedPushUnregistered(String token) {
        if (!Storage.getOrCreateUnifiedPushInstance(mContext).equals(token)) return;
        cancelUnifiedPushTimeout();
        Storage.setUnifiedPushEndpoint(mContext, "");
        Storage.setPushProvider(mContext, "none");
        syncDeviceAsync(RokBotBootstrap.isForeground(), true);
    }

    public void onUnifiedPushFailed(String message) {
        cancelUnifiedPushTimeout();
        String reason = (message != null && !message.isEmpty()) ? message : "UnifiedPush registration failed";
        Storage.setRegistrationError(mContext, reason);
        mIo.execute(() -> {
            try {
                HostApiClient.putDevice(mContext, new JSONObject()
                    .put("authorization", getAuthorizationState())
                    .put("push", new JSONObject().put("registrationError", reason)));
            } catch (Throwable ignored) {}
        });
    }
}

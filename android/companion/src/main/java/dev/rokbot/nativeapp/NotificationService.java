package dev.rokbot.nativeapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.Closeable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class NotificationService extends Service {
    private static final String TAG = "RokBotNotify";
    public static final String CHANNEL_MESSAGES = "messages";
    public static final String CHANNEL_ATTENTION = "attention";
    public static final String CHANNEL_CONNECTION = "connection";
    public static final int ID_CONNECTION = 9001;
    private static final int ID_EXPIRED = 9002;
    private static final String ACTION_ENSURE = "dev.rokbot.nativeapp.ENSURE_NOTIFICATIONS";
    private static final String ACTION_RESTART = "dev.rokbot.nativeapp.RESTART_NOTIFICATIONS";
    private static final String ACTION_SYNC_FOREGROUND = "dev.rokbot.nativeapp.SYNC_FOREGROUND";

    private static volatile NotificationService sActiveService;

    private static final Object sPresenceLock = new Object();
    private static volatile long sPresenceToken = 0L;
    private static volatile boolean sPresenceForeground = false;
    private static volatile Closeable sPresenceStream;
    private static Thread sPresenceWorker;

    private static final ExecutorService sDisconnectExecutor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "rokbot-sse-close");
        t.setDaemon(true);
        return t;
    });

    private final Object mLock = new Object();
    private volatile boolean mDestroyed = false;
    private volatile long mRunToken = 0L;
    private volatile boolean mLastForegroundSent = false;
    private volatile Closeable mActiveStream;
    private Thread mWorker;

    private static void closeStreamAsync(final Closeable stream) {
        if (stream == null) return;
        try {
            sDisconnectExecutor.execute(() -> {
                try {
                    stream.close();
                } catch (Throwable ignored) {}
            });
        } catch (Throwable ignored) {
            try { stream.close(); } catch (Throwable ignored2) {}
        }
    }

    public static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = context.getSystemService(NotificationManager.class);
            if (nm == null) return;
            NotificationChannel msgChannel = new NotificationChannel(
                CHANNEL_MESSAGES,
                Localize.t(context, "RokBot 消息", "RokBot Messages"),
                NotificationManager.IMPORTANCE_HIGH);
            msgChannel.setDescription(Localize.t(context, "接收 Bot 回复与任务完成通知", "Incoming Bot messages and task completion notifications"));

            NotificationChannel attentionChannel = new NotificationChannel(
                CHANNEL_ATTENTION,
                Localize.t(context, "RokBot 需要确认", "RokBot Attention"),
                NotificationManager.IMPORTANCE_HIGH);
            attentionChannel.setDescription(Localize.t(context, "需要您立即确认的审批与提醒", "Approvals and alerts requiring immediate attention"));

            NotificationChannel svcChannel = new NotificationChannel(
                CHANNEL_CONNECTION,
                Localize.t(context, "RokBot Host 连接", "RokBot Host Connection"),
                NotificationManager.IMPORTANCE_MIN);
            svcChannel.setDescription(Localize.t(context, "保持与 Host 的后台实时通知连接", "Keeps background notification stream connected to your Host"));
            svcChannel.setShowBadge(false);

            nm.createNotificationChannel(msgChannel);
            nm.createNotificationChannel(attentionChannel);
            nm.createNotificationChannel(svcChannel);
        }
    }

    public static void syncFromBoot(Context context, boolean fromBoot) {
        syncFromBoot(context, fromBoot, null);
    }

    public static void syncFromBoot(Context context, boolean fromBoot, Runnable onComplete) {
        if (context == null) {
            if (onComplete != null) onComplete.run();
            return;
        }
        if (fromBoot && Build.VERSION.SDK_INT >= 35) {
            // Android 15+ prohibits starting FOREGROUND_SERVICE_TYPE_DATA_SYNC from BOOT_COMPLETED.
            if (Storage.isPaired(context)) {
                PushManager.getInstance(context).syncDeviceAsync(RokBotBootstrap.isForeground(), true, onComplete);
            } else if (onComplete != null) {
                onComplete.run();
            }
            return;
        }
        try {
            sync(context, false);
        } finally {
            if (onComplete != null) onComplete.run();
        }
    }

    public static void sync(Context context) {
        sync(context, false);
    }

    public static void sync(Context context, boolean forceRestart) {
        if (context == null) return;
        Context appCtx = context.getApplicationContext();
        Intent intent = new Intent(appCtx, NotificationService.class);
        boolean paired = Storage.isPaired(appCtx);
        boolean bgEnabled = Storage.isBackgroundNotificationsEnabled(appCtx);
        boolean fg = RokBotBootstrap.isForeground();

        if (paired && bgEnabled) {
            stopForegroundPresenceStream();
            NotificationService svc = sActiveService;
            if (svc != null) {
                if (svc.mLastForegroundSent != fg) {
                    forceRestart = true;
                }
                if (forceRestart || !svc.isWorkerAlive()) {
                    svc.startOrRestartWorker(forceRestart);
                }
                return;
            }
            intent.setAction(forceRestart ? ACTION_RESTART : ACTION_ENSURE);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    appCtx.startForegroundService(intent);
                } else {
                    appCtx.startService(intent);
                }
            } catch (IllegalStateException | SecurityException e) {
                Log.w(TAG, "Unable to start NotificationService (" + e.getClass().getSimpleName() + "): " + e.getMessage());
                if (fg) {
                    ensureForegroundPresenceStream(appCtx);
                }
            } catch (Throwable t) {
                Log.w(TAG, "Unable to start NotificationService: " + t.getMessage());
                if (fg) {
                    ensureForegroundPresenceStream(appCtx);
                }
            }
        } else if (paired && fg) {
            try { appCtx.stopService(intent); } catch (Throwable ignored) {}
            ensureForegroundPresenceStream(appCtx);
        } else {
            stopForegroundPresenceStream();
            try { appCtx.stopService(intent); } catch (Throwable ignored) {}
        }
    }

    public static void syncForeground(Context context, boolean foreground) {
        if (context == null) return;
        Context appCtx = context.getApplicationContext();
        if (!Storage.isPaired(appCtx)) {
            stopForegroundPresenceStream();
            return;
        }
        if (Storage.isBackgroundNotificationsEnabled(appCtx)) {
            stopForegroundPresenceStream();
            NotificationService svc = sActiveService;
            if (svc != null) {
                if (svc.mLastForegroundSent != foreground) {
                    svc.reconnectNow();
                }
            } else {
                sync(appCtx, foreground);
            }
        } else {
            if (foreground) {
                ensureForegroundPresenceStream(appCtx);
            } else {
                stopForegroundPresenceStream();
            }
        }
    }

    public static void poke(Context context) {
        if (context == null) return;
        NotificationService svc = sActiveService;
        if (svc != null) {
            svc.reconnectNow();
        } else if (Storage.isPaired(context) && !Storage.isBackgroundNotificationsEnabled(context) && RokBotBootstrap.isForeground()) {
            stopForegroundPresenceStream();
            ensureForegroundPresenceStream(context.getApplicationContext());
        } else {
            sync(context);
        }
    }

    private static void ensureForegroundPresenceStream(Context appCtx) {
        if (appCtx == null || !Storage.isPaired(appCtx) || Storage.isBackgroundNotificationsEnabled(appCtx)
                || !RokBotBootstrap.isForeground()) {
            return;
        }
        synchronized (sPresenceLock) {
            if (sPresenceWorker != null && sPresenceWorker.isAlive() && sPresenceForeground) {
                return;
            }
            final long token = ++sPresenceToken;
            sPresenceForeground = true;
            closeStreamAsync(sPresenceStream);
            sPresenceStream = null;
            if (sPresenceWorker != null) sPresenceWorker.interrupt();
            sPresenceWorker = new Thread(() -> runForegroundPresenceLoop(appCtx, token), "rokbot-fg-presence-" + token);
            sPresenceWorker.setDaemon(true);
            sPresenceWorker.start();
        }
    }

    private static void stopForegroundPresenceStream() {
        synchronized (sPresenceLock) {
            sPresenceForeground = false;
            sPresenceToken++;
            closeStreamAsync(sPresenceStream);
            sPresenceStream = null;
            if (sPresenceWorker != null) {
                sPresenceWorker.interrupt();
                sPresenceWorker = null;
            }
        }
    }

    private static void runForegroundPresenceLoop(Context appCtx, long myToken) {
        int failures = 0;
        while (myToken == sPresenceToken
                && RokBotBootstrap.isForeground()
                && Storage.isPaired(appCtx)
                && !Storage.isBackgroundNotificationsEnabled(appCtx)) {
            String token = Storage.getToken(appCtx);
            String deviceId = Storage.getDeviceId(appCtx);
            if (token == null || deviceId == null) break;

            try {
                if (Storage.getNotificationCursor(appCtx) == null) {
                    JSONArray history = HostApiClient.getNotifications(appCtx);
                    Storage.seedNotifications(appCtx, deviceId, history);
                }
                HostApiClient.openLiveSseStream(
                        appCtx, "/notifications/events",
                        Storage.getNotificationCursor(appCtx), true,
                        () -> myToken == sPresenceToken
                                && RokBotBootstrap.isForeground()
                                && Storage.isPaired(appCtx)
                                && !Storage.isBackgroundNotificationsEnabled(appCtx),
                        new HostApiClient.SseListener() {
                            @Override
                            public void onOpening(Closeable stream) {
                                if (myToken != sPresenceToken) {
                                    closeStreamAsync(stream);
                                    return;
                                }
                                sPresenceStream = stream;
                            }

                            @Override
                            public void onConnected() {}

                            @Override
                            public void onEvent(String id, String event, String data) {
                                if (!"notification".equals(event)) return;
                                try {
                                    JSONObject item = new JSONObject(data);
                                    deliverIncoming(appCtx, deviceId, item, id, true);
                                } catch (Throwable ignored) {}
                            }
                        }
                );
                sPresenceStream = null;
                failures = 0;
            } catch (HostApiClient.ApiException apiEx) {
                sPresenceStream = null;
                if (apiEx.statusCode == 401) break;
            } catch (Throwable ignored) {
                sPresenceStream = null;
                if (myToken != sPresenceToken) break;
            }

            if (myToken != sPresenceToken || !RokBotBootstrap.isForeground()
                    || Storage.isBackgroundNotificationsEnabled(appCtx)) {
                break;
            }
            long delay = Math.min(1000L << Math.min(failures++, 5), 30000L);
            try {
                Thread.sleep(delay);
            } catch (InterruptedException ie) {
                failures = 0;
            }
        }
        synchronized (sPresenceLock) {
            if (myToken == sPresenceToken && sPresenceStream != null) {
                closeStreamAsync(sPresenceStream);
                sPresenceStream = null;
            }
        }
    }

    public static void cancelAgent(Context context, String agentId) {
        if (agentId == null || agentId.isEmpty()) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(idFor(agentId));
    }

    public static void deliverIncoming(Context context, String deviceId, JSONObject item, String explicitId, boolean updateCursor) {
        if (item == null) return;
        String itemId = (explicitId != null && !explicitId.isEmpty())
            ? explicitId
            : item.optString("notificationId", item.optString("id", ""));
        if (itemId.isEmpty()) return;

        if (!Storage.acceptNotification(context, deviceId, itemId, updateCursor)) {
            return;
        }
        String agentId = item.optString("agentId", "");
        boolean viewing = RokBotBootstrap.isForeground() && agentId.equals(RokBotBootstrap.getViewingAgentId());
        if (!viewing) {
            showNotification(context, item);
        }
    }

    public static void showNotification(Context context, JSONObject item) {
        createChannels(context);
        String agentId = UiChrome.jsonStr(item, "agentId", "agent-default");
        if (agentId.isEmpty()) agentId = "agent-default";
        boolean attention = "attention".equalsIgnoreCase(UiChrome.jsonStr(item, "type"));
        String title = UiChrome.jsonStr(item, "title", "RokBot");
        if (title.isEmpty()) title = "RokBot";
        String body = UiChrome.jsonStr(item, "body");
        String defaultDeepLink = "rokbot-local://agent/" + agentId;
        String deepLink = UiChrome.jsonStr(item, "deepLink", defaultDeepLink);
        if (deepLink.isEmpty() || (!deepLink.startsWith("rokbot-local://") && !deepLink.startsWith("grokbot://"))) {
            deepLink = defaultDeepLink;
        }

        Intent tapIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(deepLink));
        tapIntent.setPackage(context.getPackageName());
        tapIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        PendingIntent pi = PendingIntent.getActivity(
            context, idFor(agentId), tapIntent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        String channel = attention ? CHANNEL_ATTENTION : CHANNEL_MESSAGES;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, channel)
            : new Notification.Builder(context);

        applySmallIcon(context, builder);
        builder.setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE);

        try {
            NotificationManager nm = context.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(idFor(agentId), builder.build());
        } catch (SecurityException se) {
            Log.w(TAG, "POST_NOTIFICATIONS permission missing");
        }
    }

    private static void showExpiredNotification(Context context) {
        createChannels(context);
        Intent intent = new Intent(context, PairingActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            context, 1, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ATTENTION)
            : new Notification.Builder(context);
        applySmallIcon(context, builder);
        builder.setContentTitle("RokBot")
            .setContentText(Localize.t(context, "设备配对已失效，点击重新连接。", "Device pairing expired. Tap to reconnect."))
            .setContentIntent(pi)
            .setAutoCancel(true);
        try {
            NotificationManager nm = context.getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(ID_EXPIRED, builder.build());
        } catch (SecurityException ignored) {}
    }

    private static volatile Object sCachedSmallIcon;

    static void applySmallIcon(Context context, Notification.Builder builder) {
        if (context == null || builder == null) return;
        try {
            int resId = context.getResources().getIdentifier(
                "rokbot_notification_icon", "drawable", context.getPackageName());
            if (resId != 0) {
                builder.setSmallIcon(resId);
                return;
            }
        } catch (Throwable ignored) {}

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                Icon icon = getOrCreateMonochromeIcon();
                if (icon != null) {
                    builder.setSmallIcon(icon);
                    return;
                }
            } catch (Throwable ignored) {}
        }

        try {
            int appIcon = context.getApplicationInfo().icon;
            if (appIcon != 0) {
                builder.setSmallIcon(appIcon);
            }
        } catch (Throwable ignored) {}
    }

    private static Icon getOrCreateMonochromeIcon() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null;
        Object cached = sCachedSmallIcon;
        if (cached instanceof Icon) return (Icon) cached;

        final int size = 96;
        final float s = size / 1024f;
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);

        Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        fillPaint.setColor(Color.WHITE);
        fillPaint.setStyle(Paint.Style.FILL);

        // RokBot silhouette matching assets/logo/rokbot-logo.svg
        Path head = new Path();
        head.moveTo(340f * s, 148f * s);
        head.cubicTo(408f * s, 148f * s, 476f * s, 144f * s, 540f * s, 144f * s);
        head.cubicTo(618f * s, 144f * s, 664f * s, 60f * s, 756f * s, 56f * s);
        head.cubicTo(836f * s, 52f * s, 892f * s, 104f * s, 884f * s, 176f * s);
        head.cubicTo(878f * s, 214f * s, 932f * s, 272f * s, 956f * s, 368f * s);
        head.cubicTo(964f * s, 464f * s, 960f * s, 564f * s, 948f * s, 656f * s);
        head.cubicTo(928f * s, 816f * s, 820f * s, 924f * s, 636f * s, 944f * s);
        head.cubicTo(532f * s, 956f * s, 424f * s, 960f * s, 324f * s, 952f * s);
        head.cubicTo(156f * s, 938f * s, 76f * s, 836f * s, 68f * s, 668f * s);
        head.cubicTo(62f * s, 548f * s, 64f * s, 424f * s, 72f * s, 336f * s);
        head.cubicTo(84f * s, 200f * s, 184f * s, 148f * s, 340f * s, 148f * s);
        head.close();
        canvas.drawPath(head, fillPaint);

        Paint clearPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        clearPaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
        clearPaint.setStyle(Paint.Style.FILL);

        canvas.save();
        canvas.rotate(-26f, 376f * s, 564f * s);
        canvas.drawRoundRect(new RectF(304f * s, 396f * s, 448f * s, 732f * s), 72f * s, 72f * s, clearPaint);
        canvas.restore();

        canvas.save();
        canvas.rotate(-26f, 648f * s, 504f * s);
        canvas.drawRoundRect(new RectF(576f * s, 370f * s, 720f * s, 638f * s), 72f * s, 72f * s, clearPaint);
        canvas.restore();

        canvas.drawCircle(768f * s, 144f * s, 42f * s, clearPaint);

        Icon icon = Icon.createWithBitmap(bmp);
        sCachedSmallIcon = icon;
        return icon;
    }

    private static int idFor(String agentId) {
        return 1000 + (agentId.hashCode() & 0x7fffffff) % 1000000;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!Storage.isPaired(this) || !Storage.isBackgroundNotificationsEnabled(this)) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    Notification fg = buildConnectionNotification(false);
                    if (Build.VERSION.SDK_INT >= 29) {
                        startForeground(ID_CONNECTION, fg, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                    } else {
                        startForeground(ID_CONNECTION, fg);
                    }
                    stopForeground(true);
                } catch (Throwable ignored) {}
            }
            synchronized (mLock) {
                mDestroyed = true;
                mRunToken++;
                Closeable stream = mActiveStream;
                mActiveStream = null;
                closeStreamAsync(stream);
                if (mWorker != null) {
                    mWorker.interrupt();
                    mWorker = null;
                }
                if (sActiveService == this) sActiveService = null;
            }
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        sActiveService = this;
        stopForegroundPresenceStream();
        try {
            Notification fg = buildConnectionNotification(false);
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(ID_CONNECTION, fg, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(ID_CONNECTION, fg);
            }
        } catch (Throwable t) {
            Log.w(TAG, "startForeground failed: " + t.getClass().getSimpleName());
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        boolean fgNow = RokBotBootstrap.isForeground();
        String action = intent != null ? intent.getAction() : null;
        boolean restart = ACTION_RESTART.equals(action)
                || ACTION_SYNC_FOREGROUND.equals(action)
                || (ACTION_ENSURE.equals(action) && mLastForegroundSent != fgNow);
        startOrRestartWorker(restart);
        return START_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        synchronized (mLock) {
            mDestroyed = true;
            mRunToken++;
            Closeable stream = mActiveStream;
            mActiveStream = null;
            closeStreamAsync(stream);
            if (mWorker != null) mWorker.interrupt();
        }
        stopSelf(startId);
    }

    @Override
    public void onDestroy() {
        synchronized (mLock) {
            mDestroyed = true;
            mRunToken++;
            Closeable stream = mActiveStream;
            mActiveStream = null;
            closeStreamAsync(stream);
            if (sActiveService == this) sActiveService = null;
            if (mWorker != null) {
                mWorker.interrupt();
                mWorker = null;
            }
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private boolean isWorkerAlive() {
        synchronized (mLock) {
            return mWorker != null && mWorker.isAlive();
        }
    }

    public void reconnectNow() {
        startOrRestartWorker(true);
    }

    private void startOrRestartWorker(boolean forceDisconnect) {
        synchronized (mLock) {
            mDestroyed = false;
            if (mWorker != null && mWorker.isAlive() && !forceDisconnect) return;
            long token = ++mRunToken;
            if (forceDisconnect) {
                Closeable stream = mActiveStream;
                mActiveStream = null;
                closeStreamAsync(stream);
                if (mWorker != null) mWorker.interrupt();
            }
            mWorker = new Thread(() -> runLoop(token), "rokbot-notifications-" + token);
            mWorker.setDaemon(true);
            mWorker.start();
        }
    }

    private void runLoop(long myToken) {
        int failures = 0;
        while (!mDestroyed && myToken == mRunToken && Storage.isPaired(this)
                && Storage.isBackgroundNotificationsEnabled(this)) {
            String token = Storage.getToken(this);
            String deviceId = Storage.getDeviceId(this);
            if (token == null || deviceId == null) break;

            try {
                if (Storage.getNotificationCursor(this) == null) {
                    JSONArray history = HostApiClient.getNotifications(this);
                    Storage.seedNotifications(this, deviceId, history);
                }

                boolean sendFg = RokBotBootstrap.isForeground();
                mLastForegroundSent = sendFg;

                PowerManager.WakeLock wl = acquireWakeLock("RokBot:NotifyStream", 10000L);
                try {
                    HostApiClient.openLiveSseStream(
                        this, "/notifications/events",
                        Storage.getNotificationCursor(this), sendFg,
                        () -> !mDestroyed && myToken == mRunToken && Storage.isBackgroundNotificationsEnabled(this),
                        new HostApiClient.SseListener() {
                            @Override
                            public void onOpening(Closeable stream) {
                                if (mDestroyed || myToken != mRunToken) {
                                    closeStreamAsync(stream);
                                    return;
                                }
                                mActiveStream = stream;
                            }

                            @Override
                            public void onConnected() {
                                releaseWakeLock(wl);
                                updateForegroundNotification(false);
                                // Host connection (re)established: pick up profile edits made elsewhere.
                                HostProfile.refresh(NotificationService.this, true);
                            }

                            @Override
                            public void onEvent(String id, String event, String data) {
                                if (!"notification".equals(event)) return;
                                PowerManager.WakeLock showWl = acquireWakeLock("RokBot:NotifyShow", 5000L);
                                try {
                                    JSONObject item = new JSONObject(data);
                                    deliverIncoming(NotificationService.this, deviceId, item, id, true);
                                } catch (Throwable ignored) {
                                } finally {
                                    releaseWakeLock(showWl);
                                }
                            }
                        }
                    );
                    mActiveStream = null;
                    failures = 0;
                } finally {
                    mActiveStream = null;
                    releaseWakeLock(wl);
                }
            } catch (HostApiClient.ApiException apiEx) {
                if (apiEx.statusCode == 401) {
                    showExpiredNotification(this);
                    break;
                }
                Log.i(TAG, "Notification stream HTTP error: " + apiEx.statusCode);
            } catch (Throwable t) {
                if (mDestroyed || myToken != mRunToken) break;
                Log.i(TAG, "Notification stream error: " + t.getClass().getSimpleName());
            }

            if (mDestroyed || myToken != mRunToken || !Storage.isBackgroundNotificationsEnabled(this)) break;
            updateForegroundNotification(true);
            long delay = Math.min(1000L << Math.min(failures++, 5), 30000L);
            try {
                Thread.sleep(delay);
            } catch (InterruptedException ie) {
                failures = 0;
            }
        }
        synchronized (mLock) {
            if (!mDestroyed && myToken == mRunToken) stopSelf();
        }
    }

    private Notification buildConnectionNotification(boolean reconnecting) {
        Intent openIntent = RokBotBootstrap.buildLauncherIntent(this);
        PendingIntent pi = PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_CONNECTION)
            : new Notification.Builder(this);
        applySmallIcon(this, builder);
        return builder
            .setContentTitle(reconnecting
                ? Localize.t(this, "RokBot 重连中…", "RokBot Reconnecting…")
                : Localize.t(this, "RokBot 已连接", "RokBot Connected"))
            .setContentText(Localize.t(this, "正在后台接收实时消息通知", "Listening for real-time notifications"))
            .setContentIntent(pi)
            .setOngoing(true)
            .setShowWhen(false)
            .build();
    }

    private void updateForegroundNotification(boolean reconnecting) {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(ID_CONNECTION, buildConnectionNotification(reconnecting));
        } catch (Throwable ignored) {}
    }

    private PowerManager.WakeLock acquireWakeLock(String tag, long timeoutMs) {
        try {
            PowerManager pm = getSystemService(PowerManager.class);
            if (pm != null) {
                PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, tag);
                wl.acquire(timeoutMs);
                return wl;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    private void releaseWakeLock(PowerManager.WakeLock wl) {
        try {
            if (wl != null && wl.isHeld()) wl.release();
        } catch (Throwable ignored) {}
    }
}

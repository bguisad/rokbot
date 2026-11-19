package dev.grokbot.nativeapp;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ActionMode;
import android.view.KeyEvent;
import android.view.KeyboardShortcutGroup;
import android.view.Menu;
import android.view.MenuItem;
import android.view.MotionEvent;
import android.view.SearchEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.widget.CompoundButton;
import android.widget.HorizontalScrollView;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.lang.ref.WeakReference;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.WeakHashMap;

public class GrokBotBootstrap {
    private static volatile boolean sInitialized = false;
    private static volatile boolean sAppCreated = false;
    private static volatile boolean sInitialPairingModalShown = false;
    private static volatile int sStartedCount = 0;
    private static volatile String sViewingAgentId = null;
    private static volatile String sLastAgentId = null;
    private static volatile WeakReference<Activity> sCurrentActivity = new WeakReference<>(null);
    private static Handler sMainHandler;
    private static final WeakHashMap<Activity, Boolean> sHookedViews = new WeakHashMap<>();
    private static final Set<Activity> sStartedActivities = Collections.synchronizedSet(Collections.newSetFromMap(new WeakHashMap<>()));
    private static final WeakHashMap<Activity, Boolean> sHookedDeepLinks = new WeakHashMap<>();

    private static synchronized Handler getMainHandler() {
        if (sMainHandler == null) {
            sMainHandler = new Handler(Looper.getMainLooper());
        }
        return sMainHandler;
    }

    public static synchronized void init(Application app) {
        if (sInitialized) return;
        sInitialized = true;

        Storage.init(app);
        clearExpoCache(app);
        installNetworkInterceptor(app);
        NotificationService.createChannels(app);
        TailcatManager.get().setResetListener(() -> NotificationService.poke(app));
        TailcatManager.get().registerNetworkMonitor(app, hasInternet -> {
            if (hasInternet && Storage.isPaired(app)) {
                new Thread(() -> TailcatManager.get().probeAndRecover(app, 2500, true), "GrokBotNetRecover").start();
            }
        });

        app.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            @Override
            public void onActivityCreated(Activity activity, Bundle savedInstanceState) {
                sCurrentActivity = new WeakReference<>(activity);
                installNetworkInterceptor(app);
                normalizeIncomingDeepLinkIntent(activity);
                hookDeepLinkDelivery(activity);
                if (!sAppCreated) {
                    sAppCreated = true;
                    onAppCreate(app);
                }
                if (isReactActivity(activity) && !Storage.isPaired(activity)) {
                    boolean explicitSkip = activity.getIntent() != null
                            && activity.getIntent().getBooleanExtra("grokbot_skip_unpaired_redirect", false);
                    if (!explicitSkip && !sInitialPairingModalShown && !HermesPatcher.hasAppliedUnpairedBundle()) {
                        sInitialPairingModalShown = true;
                        Intent intent = new Intent(activity, PairingActivity.class);
                        intent.putExtra(PairingActivity.EXTRA_FROM_RN_MODAL, true);
                        activity.startActivity(intent);
                    }
                }
            }

            @Override
            public void onActivityStarted(Activity activity) {
                GrokBotBootstrap.onActivityStarted(activity);
            }

            @Override
            public void onActivityResumed(Activity activity) {
                sCurrentActivity = new WeakReference<>(activity);
                installNetworkInterceptor(app);
                normalizeIncomingDeepLinkIntent(activity);
                hookDeepLinkDelivery(activity);
                if (isReactActivity(activity) && (sViewingAgentId == null || sViewingAgentId.isEmpty())
                        && sLastAgentId != null && !sLastAgentId.isEmpty()) {
                    setViewingAgentId(sLastAgentId);
                }
                hookExpoClientsFromActivity(app, activity);
                maybeAttachRnViewInterceptor(activity);
            }

            @Override
            public void onActivityPaused(Activity activity) {
                if (isReactActivity(activity)) {
                    setViewingAgentId(null);
                }
            }

            @Override
            public void onActivityStopped(Activity activity) {
                GrokBotBootstrap.onActivityStopped(activity);
            }

            @Override public void onActivitySaveInstanceState(Activity activity, Bundle outState) {}
            @Override public void onActivityDestroyed(Activity activity) {
                sStartedActivities.remove(activity);
                sStartedCount = sStartedActivities.size();
                sHookedViews.remove(activity);
                sHookedDeepLinks.remove(activity);
            }
        });
    }

    public static void onActivityStarted(Activity activity) {
        if (activity == null) return;
        sCurrentActivity = new WeakReference<>(activity);
        normalizeIncomingDeepLinkIntent(activity);
        hookDeepLinkDelivery(activity);
        if (isReactActivity(activity) && (sViewingAgentId == null || sViewingAgentId.isEmpty())
                && sLastAgentId != null && !sLastAgentId.isEmpty()) {
            setViewingAgentId(sLastAgentId);
        }
        int prevCount;
        int nowCount;
        synchronized (sStartedActivities) {
            prevCount = sStartedActivities.size();
            sStartedActivities.add(activity);
            nowCount = sStartedActivities.size();
            sStartedCount = nowCount;
        }
        if (prevCount == 0 && nowCount > 0) {
            Application app = activity.getApplication();
            Context ctx = app != null ? app : activity.getApplicationContext();
            PushManager.getInstance(ctx).onForegroundChanged(true);
        }
    }

    public static void onActivityStopped(Activity activity) {
        if (activity == null) return;
        int prevCount;
        int nowCount;
        synchronized (sStartedActivities) {
            prevCount = sStartedActivities.size();
            sStartedActivities.remove(activity);
            nowCount = sStartedActivities.size();
            sStartedCount = nowCount;
        }
        if (prevCount > 0 && nowCount == 0) {
            Application app = activity.getApplication();
            Context ctx = app != null ? app : activity.getApplicationContext();
            PushManager.getInstance(ctx).onForegroundChanged(false);
        }
    }

    public static void onAppCreate(Application app) {
        sAppCreated = true;
        installNetworkInterceptor(app);
        if (Storage.isPaired(app)) {
            ensurePairedBundleFile(app);
        } else {
            ensureUnpairedBundleFile(app);
        }
        hookReactHost(app);
        NotificationService.sync(app);
        PushManager.getInstance(app).syncDeviceAsync(isForeground(), false);
    }

    public static File ensureUnpairedBundleFile(Context context) {
        if (context == null || Storage.isPaired(context)) return null;
        return HermesPatcher.ensureUnpairedBundleFile(context);
    }

    public static synchronized void clearPairedBundle(Context context) {
        if (context == null) return;
        try {
            File dir = new File(context.getFilesDir(), "GrokBotPaired");
            if (dir.exists()) deleteRecursively(dir);
        } catch (Throwable ignored) {}
    }

    public static File ensurePairedBundleFile(Context context) {
        return ensurePairedBundleFile(context, false);
    }

    public static synchronized File ensurePairedBundleFile(Context context, boolean force) {
        if (context == null || !Storage.isPaired(context)) return null;
        File dir = new File(context.getFilesDir(), "GrokBotPaired");
        File pairedBundle = new File(dir, "index.android.bundle");
        File metaFile = new File(dir, ".bundle-meta");
        String token = Storage.getToken(context);
        if (token == null || token.isEmpty()) return null;
        String url = Storage.getGatewayUrl(context);
        if (Storage.isTailcatEnabled(context)) {
            try {
                String resolved = TailcatManager.get().resolveServerUrl(context);
                if (resolved != null && !resolved.isEmpty()) url = resolved;
            } catch (RuntimeException e) {
                return pairedBundle.exists() ? pairedBundle : null;
            }
        }
        if (url == null || url.isEmpty()) return null;
        String expectedMeta = url + "\n" + token;
        if (!force && pairedBundle.exists() && pairedBundle.length() > 0 && metaFile.exists()) {
            try (FileInputStream fis = new FileInputStream(metaFile)) {
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                byte[] buf = new byte[512];
                int n;
                while ((n = fis.read(buf)) > 0) baos.write(buf, 0, n);
                String curMeta = new String(baos.toByteArray(), StandardCharsets.UTF_8);
                if (expectedMeta.equals(curMeta)) {
                    return pairedBundle;
                }
            } catch (Throwable ignored) {}
        }
        if (!HermesPatcher.hasGatewayTemplate(context)) {
            return pairedBundle.exists() ? pairedBundle : null;
        }
        try {
            File generated = HermesPatcher.generatePairedBundle(context, url, token);
            if (generated != null && generated.exists() && generated.length() > 0) {
                try (FileOutputStream fos = new FileOutputStream(metaFile)) {
                    fos.write(expectedMeta.getBytes(StandardCharsets.UTF_8));
                } catch (Throwable ignored) {}
            }
            return generated;
        } catch (Throwable ignored) {
            return pairedBundle.exists() ? pairedBundle : null;
        }
    }

    /**
     * Reflectively updates New-Architecture ReactHost / ReactNativeHost JS bundle loader.
     */
    public static void hookReactHost(Application app) {
        if (app == null) return;
        File targetBundle = Storage.isPaired(app)
                ? ensurePairedBundleFile(app, false)
                : ensureUnpairedBundleFile(app);
        if (targetBundle == null || !targetBundle.exists()) return;
        try {
            Object fileLoader = createFileBundleLoader(targetBundle.getAbsolutePath());
            if (fileLoader == null) return;

            Object reactHost = resolveReactHost(app);
            if (reactHost != null) {
                patchFieldAny(reactHost, new String[]{"mReactHostDelegate", "reactHostDelegate"}, delegate -> {
                    boolean patched = patchFieldAnyReturn(delegate, new String[]{"j", "b", "jsBundleLoader", "mJSBundleLoader"}, old -> fileLoader);
                    if (!patched) {
                        patchFieldByType(delegate, "com.facebook.react.bridge.JSBundleLoader", fileLoader);
                    }
                    return null;
                });
            }
        } catch (Throwable ignored) {}
    }

    public static void reloadReactHost(Context context) {
        if (context == null) return;
        Context appCtx = context.getApplicationContext();
        if (appCtx instanceof Application) {
            Application app = (Application) appCtx;
            R8OkHttpHook.refresh(app);
            if (Storage.isPaired(app)) {
                ensurePairedBundleFile(app, true);
            }
            hookReactHost(app);
            try {
                Object reactHost = resolveReactHost(app);
                if (reactHost != null) {
                    try {
                        Method reload = reactHost.getClass().getMethod("reload", String.class);
                        reload.invoke(reactHost, "grokbot-pairing-updated");
                        return;
                    } catch (Throwable reloadErr) {
                        File targetBundle = Storage.isPaired(app)
                                ? ensurePairedBundleFile(app, false)
                                : ensureUnpairedBundleFile(app);
                        if (targetBundle != null && targetBundle.exists()) {
                            Object fileLoader = createFileBundleLoader(targetBundle.getAbsolutePath());
                            if (fileLoader != null) {
                                Class<?> jsLoaderCls = Class.forName("com.facebook.react.bridge.JSBundleLoader");
                                Method loadBundle = reactHost.getClass().getMethod("loadBundle$ReactAndroid_release", jsLoaderCls);
                                loadBundle.invoke(reactHost, fileLoader);
                                return;
                            }
                        }
                    }
                }
            } catch (Throwable ignored) {}
            try {
                Method getRnHost = app.getClass().getMethod("getReactNativeHost");
                Object rnHost = getRnHost.invoke(app);
                if (rnHost != null) {
                    Method getMgr = rnHost.getClass().getMethod("getReactInstanceManager");
                    Object mgr = getMgr.invoke(rnHost);
                    if (mgr != null) {
                        Method recreate = mgr.getClass().getMethod("recreateReactContextInBackground");
                        recreate.invoke(mgr);
                    }
                }
            } catch (Throwable ignored) {}
        }
    }

    private static Object createFileBundleLoader(String filePath) {
        try {
            Class<?> jsLoaderCls = Class.forName("com.facebook.react.bridge.JSBundleLoader");
            try {
                Method createFileLoader = jsLoaderCls.getMethod("createFileLoader", String.class);
                return createFileLoader.invoke(null, filePath);
            } catch (NoSuchMethodException ignored) {
                Object companion = jsLoaderCls.getField("Companion").get(null);
                if (companion != null) {
                    Method createFileLoader = companion.getClass().getMethod("createFileLoader", String.class);
                    return createFileLoader.invoke(companion, filePath);
                }
            }
        } catch (Throwable ignored) {}
        return null;
    }

    private static Object resolveReactHost(Application app) {
        if (app == null) return null;
        try {
            return app.getClass().getMethod("getReactHost").invoke(app);
        } catch (Throwable ignored) {}
        try {
            Object candidate = app.getClass().getMethod("c").invoke(app);
            if (candidate != null) {
                String clsName = candidate.getClass().getName();
                if (clsName.contains("ReactHost") || hasMethod(candidate.getClass(), "reload", String.class)) {
                    return candidate;
                }
            }
        } catch (Throwable ignored) {}
        return null;
    }

    private static boolean hasMethod(Class<?> cls, String name, Class<?>... params) {
        try {
            cls.getMethod(name, params);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static void patchFieldAny(Object target, String[] fieldNames, FieldMapper mapper) {
        patchFieldAnyReturn(target, fieldNames, mapper);
    }

    private static boolean patchFieldAnyReturn(Object target, String[] fieldNames, FieldMapper mapper) {
        if (target == null) return false;
        for (String fieldName : fieldNames) {
            Class<?> cls = target.getClass();
            while (cls != null && cls != Object.class) {
                try {
                    Field f = cls.getDeclaredField(fieldName);
                    f.setAccessible(true);
                    Object cur = f.get(target);
                    Object next = mapper.map(cur);
                    if (next != null && next != cur) {
                        f.set(target, next);
                    }
                    return true;
                } catch (NoSuchFieldException ignored) {
                    cls = cls.getSuperclass();
                } catch (Throwable ignored) {
                    return false;
                }
            }
        }
        return false;
    }

    private static void patchFieldByType(Object target, String typeName, Object value) {
        if (target == null || value == null) return;
        try {
            Class<?> expected = Class.forName(typeName);
            Class<?> cls = target.getClass();
            while (cls != null && cls != Object.class) {
                for (Field f : cls.getDeclaredFields()) {
                    if (expected.isAssignableFrom(f.getType())) {
                        f.setAccessible(true);
                        f.set(target, value);
                        return;
                    }
                }
                cls = cls.getSuperclass();
            }
        } catch (Throwable ignored) {}
    }

    private interface FieldMapper {
        Object map(Object current);
    }

    private static void patchFieldRecursive(Object target, String fieldName, FieldMapper mapper) {
        if (target == null) return;
        Class<?> cls = target.getClass();
        while (cls != null && cls != Object.class) {
            try {
                Field f = cls.getDeclaredField(fieldName);
                f.setAccessible(true);
                Object cur = f.get(target);
                Object next = mapper.map(cur);
                if (next != null && next != cur) {
                    f.set(target, next);
                }
                return;
            } catch (NoSuchFieldException ignored) {
                cls = cls.getSuperclass();
            } catch (Throwable ignored) {
                return;
            }
        }
    }

    public static boolean isReactActivity(Activity activity) {
        if (activity == null) return false;
        String name = activity.getClass().getName();
        if (name.startsWith("dev.grokbot.nativeapp.")) return false;
        Class<?> cls = activity.getClass();
        while (cls != null && cls != Object.class) {
            String clsName = cls.getName();
            if ("com.facebook.react.ReactActivity".equals(clsName)
                    || "com.facebook.react.n".equals(clsName)) {
                return true;
            }
            cls = cls.getSuperclass();
        }
        return false;
    }

    public static boolean isForeground() {
        return sStartedCount > 0;
    }

    public static String getViewingAgentId() {
        return sViewingAgentId;
    }

    public static String getLastAgentId() {
        return sLastAgentId;
    }

    public static void setLastAgentId(String agentId) {
        if (agentId != null && !agentId.trim().isEmpty()) {
            String trimmed = agentId.trim();
            sLastAgentId = trimmed;
            if (isForeground()) {
                Activity act = sCurrentActivity.get();
                if (act == null || isReactActivity(act)) {
                    sViewingAgentId = trimmed;
                    if (act != null) {
                        NotificationService.cancelAgent(act, trimmed);
                    }
                }
            }
        }
    }

    public static void setViewingAgentId(String agentId) {
        if (agentId != null && !agentId.trim().isEmpty()) {
            String trimmed = agentId.trim();
            sViewingAgentId = trimmed;
            sLastAgentId = trimmed;
            Activity act = sCurrentActivity.get();
            if (act != null) {
                NotificationService.cancelAgent(act, trimmed);
            }
        } else {
            sViewingAgentId = null;
        }
    }

    public static Activity getCurrentActivity() {
        return sCurrentActivity.get();
    }

    public static Uri normalizeDeepLink(Uri uri) {
        String agentId = parseAgentId(uri);
        if (agentId == null || agentId.isEmpty()) return uri;
        return new Uri.Builder()
                .scheme("grokbot")
                .authority("app")
                .appendPath("v1")
                .appendPath("chat")
                .appendQueryParameter("id", agentId)
                .build();
    }

    private static void normalizeIncomingDeepLinkIntent(Activity activity) {
        if (activity == null) return;
        normalizeIncomingDeepLinkIntent(activity, activity.getIntent());
    }

    private static void normalizeIncomingDeepLinkIntent(Activity activity, Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;
        if ("grokbot-local".equalsIgnoreCase(data.getScheme())) {
            String agentId = parseAgentId(data);
            if (agentId != null && !agentId.isEmpty()) {
                setLastAgentId(agentId);
                setViewingAgentId(agentId);
                intent.setData(normalizeDeepLink(data));
                intent.putExtra("agentId", agentId);
            }
        } else if ("grokbot".equalsIgnoreCase(data.getScheme())) {
            String agentId = parseAgentId(data);
            if (agentId != null && !agentId.isEmpty()) {
                setLastAgentId(agentId);
                setViewingAgentId(agentId);
            }
        }
    }

    private static boolean isBootstrapProxy(Object obj) {
        if (obj == null || !Proxy.isProxyClass(obj.getClass())) return false;
        try {
            return Proxy.getInvocationHandler(obj).getClass().getName().startsWith("dev.grokbot.nativeapp.GrokBotBootstrap");
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static Object defaultReturnValue(Class<?> retType) {
        if (retType == boolean.class) return Boolean.FALSE;
        if (retType == byte.class) return (byte) 0;
        if (retType == short.class) return (short) 0;
        if (retType == int.class) return 0;
        if (retType == long.class) return 0L;
        if (retType == float.class) return 0f;
        if (retType == double.class) return 0d;
        if (retType == char.class) return '\0';
        return null;
    }

    private static void hookDeepLinkDelivery(final Activity activity) {
        if (activity == null || !isReactActivity(activity)) return;
        if (Boolean.TRUE.equals(sHookedDeepLinks.get(activity))) return;
        try {
            Object delegate = findReactActivityDelegate(activity);
            if (delegate == null) return;

            boolean listenerHooked = false;
            // 1. Prepend an Expo ReactActivityLifecycleListener (Fc.o.i / reactActivityLifecycleListeners)
            // so Intent normalization happens BEFORE Lqg/g (ExpoLinking) emits unnormalized grokbot-local:// URIs.
            Class<?> dCls = delegate.getClass();
            while (dCls != null && dCls != Object.class) {
                for (Field f : dCls.getDeclaredFields()) {
                    if (!List.class.isAssignableFrom(f.getType())) continue;
                    try {
                        f.setAccessible(true);
                        Object listObj = f.get(delegate);
                        if (!(listObj instanceof List<?>)) continue;
                        List<?> orig = (List<?>) listObj;
                        Class<?> listenerIface = resolveNewIntentListenerInterface(f, orig);
                        if (listenerIface == null) continue;
                        boolean already = false;
                        for (Object item : orig) {
                            if (isBootstrapProxy(item)) {
                                already = true;
                                break;
                            }
                        }
                        if (!already) {
                            Object proxyListener = Proxy.newProxyInstance(
                                    listenerIface.getClassLoader(),
                                    new Class<?>[]{listenerIface},
                                    (proxy, method, args) -> {
                                        if ("onNewIntent".equals(method.getName()) && args != null && args.length >= 1 && args[0] instanceof Intent) {
                                            normalizeIncomingDeepLinkIntent(activity, (Intent) args[0]);
                                            return Boolean.FALSE;
                                        }
                                        return defaultReturnValue(method.getReturnType());
                                    });
                            List<Object> replaced = new ArrayList<>(orig.size() + 1);
                            replaced.add(proxyListener);
                            replaced.addAll(orig);
                            f.set(delegate, replaced);
                            listenerHooked = true;
                        } else {
                            listenerHooked = true;
                        }
                    } catch (Throwable ignored) {}
                }
                dCls = dCls.getSuperclass();
            }

            // 2. Wrap ReactDelegate.mReactHost / com.facebook.react.u.g (ReactHost interface)
            // so ReactHostImpl.onNewIntent also receives normalized grokbot://app/v1/chat?id=...
            boolean hostHooked = false;
            Object reactDelegate = findReactDelegate(delegate);
            if (reactDelegate != null) {
                Class<?> uCls = reactDelegate.getClass();
                while (uCls != null && uCls != Object.class) {
                    for (Field f : uCls.getDeclaredFields()) {
                        Class<?> ft = f.getType();
                        if (!ft.isInterface() || !hasMethod(ft, "onNewIntent", Intent.class)) continue;
                        try {
                            f.setAccessible(true);
                            final Object realHost = f.get(reactDelegate);
                            if (realHost == null) {
                                continue;
                            }
                            if (isBootstrapProxy(realHost)) {
                                hostHooked = true;
                                continue;
                            }
                            Object hostProxy = Proxy.newProxyInstance(
                                    ft.getClassLoader(),
                                    new Class<?>[]{ft},
                                    (proxy, method, args) -> {
                                        if ("onNewIntent".equals(method.getName()) && args != null && args.length >= 1 && args[0] instanceof Intent) {
                                            normalizeIncomingDeepLinkIntent(activity, (Intent) args[0]);
                                        }
                                        try {
                                            return method.invoke(realHost, args);
                                        } catch (java.lang.reflect.InvocationTargetException ite) {
                                            throw ite.getCause() != null ? ite.getCause() : ite;
                                        }
                                    });
                            f.set(reactDelegate, hostProxy);
                            hostHooked = true;
                        } catch (Throwable ignored) {}
                    }
                    uCls = uCls.getSuperclass();
                }
            }

            if (listenerHooked && hostHooked) {
                sHookedDeepLinks.put(activity, Boolean.TRUE);
            }
        } catch (Throwable ignored) {}
    }

    private static void hookExpoClientsFromActivity(Application app, Activity activity) {
        if (app == null || activity == null || !isReactActivity(activity)) return;
        try {
            Object delegate = findReactActivityDelegate(activity);
            if (delegate == null) return;
            Method getCtx = null;
            Class<?> cls = delegate.getClass();
            while (cls != null && cls != Object.class) {
                try {
                    getCtx = cls.getDeclaredMethod("getCurrentReactContext");
                    break;
                } catch (NoSuchMethodException ignored) {
                    cls = cls.getSuperclass();
                }
            }
            if (getCtx != null) {
                getCtx.setAccessible(true);
                Object reactCtx = getCtx.invoke(delegate);
                if (reactCtx != null) {
                    R8OkHttpHook.hookReactContext(app, reactCtx);
                    return;
                }
            }
            Object reactHost = resolveReactHost(app);
            if (reactHost != null) {
                Method hostCtx = reactHost.getClass().getMethod("getCurrentReactContext");
                Object reactCtx = hostCtx.invoke(reactHost);
                if (reactCtx != null) {
                    R8OkHttpHook.hookReactContext(app, reactCtx);
                }
            }
        } catch (Throwable ignored) {}
    }

    private static Object findReactActivityDelegate(Activity activity) {
        Class<?> cls = activity.getClass();
        while (cls != null && cls != Object.class) {
            for (String fieldName : new String[]{"mDelegate", "c"}) {
                try {
                    Field f = cls.getDeclaredField(fieldName);
                    f.setAccessible(true);
                    Object val = f.get(activity);
                    if (val != null && hasMethod(val.getClass(), "onNewIntent", Intent.class)) {
                        return val;
                    }
                } catch (Throwable ignored) {}
            }
            cls = cls.getSuperclass();
        }
        return null;
    }

    private static Object findReactDelegate(Object delegate) {
        Object cur = delegate;
        for (int pass = 0; pass < 2 && cur != null; pass++) {
            Class<?> cls = cur.getClass();
            Object nestedDelegate = null;
            while (cls != null && cls != Object.class) {
                for (Field f : cls.getDeclaredFields()) {
                    try {
                        f.setAccessible(true);
                        Object val = f.get(cur);
                        if (val == null || val == cur) continue;
                        String n = val.getClass().getName();
                        if ("com.facebook.react.u".equals(n) || "com.facebook.react.ReactDelegate".equals(n)) {
                            return val;
                        }
                        if (nestedDelegate == null && !Proxy.isProxyClass(val.getClass())
                                && hasMethod(val.getClass(), "onNewIntent", Intent.class)
                                && !hasMethod(val.getClass(), "reload", String.class)) {
                            nestedDelegate = val;
                        }
                    } catch (Throwable ignored) {}
                }
                cls = cls.getSuperclass();
            }
            cur = nestedDelegate;
        }
        return null;
    }

    private static Class<?> resolveNewIntentListenerInterface(Field field, List<?> listeners) {
        try {
            java.lang.reflect.Type gen = field != null ? field.getGenericType() : null;
            if (gen instanceof java.lang.reflect.ParameterizedType) {
                java.lang.reflect.Type[] args = ((java.lang.reflect.ParameterizedType) gen).getActualTypeArguments();
                if (args.length == 1 && args[0] instanceof Class<?>) {
                    Class<?> elemType = (Class<?>) args[0];
                    if (elemType.isInterface() && hasMethod(elemType, "onNewIntent", Intent.class)) {
                        return elemType;
                    }
                    // Parameterized List whose element type lacks onNewIntent(Intent) (e.g. Fc.o.j: List<pe.k>).
                    if (elemType != Object.class) {
                        return null;
                    }
                }
            }
        } catch (Throwable ignored) {}

        boolean sawNonNullItem = false;
        if (listeners != null) {
            for (Object item : listeners) {
                if (item == null) continue;
                sawNonNullItem = true;
                for (Class<?> iface : item.getClass().getInterfaces()) {
                    if (hasMethod(iface, "onNewIntent", Intent.class)) {
                        return iface;
                    }
                }
            }
        }
        if (sawNonNullItem) {
            // Non-empty list whose existing items do not implement an onNewIntent listener interface (e.g. pe.k).
            return null;
        }
        String fieldName = field != null ? field.getName() : "";
        if (!"i".equals(fieldName)
                && !"mReactActivityLifecycleListeners".equals(fieldName)
                && !"reactActivityLifecycleListeners".equals(fieldName)) {
            return null;
        }
        for (String name : new String[]{"pe.j", "expo.modules.core.interfaces.ReactActivityLifecycleListener"}) {
            try {
                Class<?> c = Class.forName(name);
                if (c.isInterface() && hasMethod(c, "onNewIntent", Intent.class)) {
                    return c;
                }
            } catch (Throwable ignored) {}
        }
        return null;
    }

    public static Intent buildLauncherIntent(Context context) {
        if (context == null) return new Intent();
        Intent launch = null;
        try {
            if (context.getPackageManager() != null) {
                launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
            }
        } catch (Throwable ignored) {}
        if (launch == null) {
            launch = new Intent(context, PairingActivity.class);
        } else {
            launch = new Intent(launch);
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return launch;
    }

    public static void openAgentFromDeepLink(Context context, Uri uri) {
        if (context == null) return;
        String agentId = parseAgentId(uri);
        if (agentId != null && !agentId.isEmpty()) {
            setLastAgentId(agentId);
            setViewingAgentId(agentId);
            Intent intent = buildLauncherIntent(context);
            intent.setAction(Intent.ACTION_VIEW);
            intent.setData(normalizeDeepLink(uri));
            intent.putExtra("agentId", agentId);
            context.startActivity(intent);
        }
    }

    public static String parseAgentId(Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme();
        if ("grokbot-local".equalsIgnoreCase(scheme)) {
            if ("agent".equalsIgnoreCase(uri.getHost()) || "chat".equalsIgnoreCase(uri.getHost())) {
                String path = uri.getPath();
                if (path != null && path.startsWith("/")) {
                    String candidate = path.substring(1);
                    if (candidate.matches("^[A-Za-z0-9_-]{1,128}$")) return candidate;
                }
            }
        } else if ("grokbot".equalsIgnoreCase(scheme)) {
            String id = uri.getQueryParameter("id");
            if (id != null && id.matches("^[A-Za-z0-9_-]{1,128}$")) return id;
        }
        return null;
    }

    private static final int TAG_HOOKED_CLICK = 0x67626f74;
    private static final int TAG_OVERRIDDEN_TARGET = 0x67626f75;

    private static final class PendingTap {
        final Class<?> target;
        final float downX;
        final float downY;
        PendingTap(Class<?> target, float downX, float downY) {
            this.target = target;
            this.downX = downX;
            this.downY = downY;
        }
    }

    private static final class HitResult {
        final Class<?> target;
        HitResult(Class<?> target) {
            this.target = target;
        }
    }

    private static void maybeAttachRnViewInterceptor(Activity activity) {
        String cls = activity.getClass().getName();
        if (cls.startsWith("dev.grokbot.nativeapp.")) return;
        if (sHookedViews.containsKey(activity)) return;
        sHookedViews.put(activity, Boolean.TRUE);
        getMainHandler().post(() -> {
            try {
                attachWindowTouchInterceptor(activity);
                View decor = activity.getWindow() != null ? activity.getWindow().getDecorView() : null;
                if (decor == null) return;
                scanAndWireRnViews(activity, decor);
                final boolean[] scanScheduled = new boolean[1];
                final Runnable scanTask = () -> {
                    scanScheduled[0] = false;
                    if (activity.isFinishing() || activity.isDestroyed()) return;
                    try {
                        scanAndWireRnViews(activity, decor);
                    } catch (Throwable ignored) {}
                };
                decor.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
                    @Override
                    public void onGlobalLayout() {
                        if (activity.isFinishing() || activity.isDestroyed()) return;
                        if (!scanScheduled[0]) {
                            scanScheduled[0] = true;
                            getMainHandler().postDelayed(scanTask, 200L);
                        }
                    }
                });
            } catch (Throwable ignored) {}
        });
    }

    private static final class TouchInterceptWindowCallback implements Window.Callback {
        private final Activity mActivity;
        private final Window mWindow;
        private final Window.Callback mOrig;
        private PendingTap mPendingTap;

        TouchInterceptWindowCallback(Activity activity, Window window, Window.Callback orig) {
            this.mActivity = activity;
            this.mWindow = window;
            this.mOrig = orig;
        }

        @Override
        public boolean dispatchTouchEvent(MotionEvent ev) {
            if (ev != null) {
                try {
                    int action = ev.getActionMasked();
                    if (action == MotionEvent.ACTION_DOWN) {
                        mPendingTap = null;
                        View decor = mWindow.getDecorView();
                        if (decor != null) {
                            HitResult hit = findNativeTargetAtPoint(mActivity, decor, ev.getRawX(), ev.getRawY());
                            if (hit != null) {
                                mPendingTap = new PendingTap(hit.target, ev.getRawX(), ev.getRawY());
                            }
                        }
                    } else if (action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_CANCEL) {
                        mPendingTap = null;
                    } else if (mPendingTap != null && action == MotionEvent.ACTION_MOVE) {
                        PendingTap tap = mPendingTap;
                        float dist = (float) Math.hypot(ev.getRawX() - tap.downX, ev.getRawY() - tap.downY);
                        float touchSlop = ViewConfiguration.get(mActivity).getScaledTouchSlop();
                        if (dist > touchSlop) {
                            mPendingTap = null;
                        }
                    } else if (mPendingTap != null && action == MotionEvent.ACTION_UP) {
                        PendingTap tap = mPendingTap;
                        mPendingTap = null;
                        float dist = (float) Math.hypot(ev.getRawX() - tap.downX, ev.getRawY() - tap.downY);
                        float slop = Math.max(ViewConfiguration.get(mActivity).getScaledTouchSlop() * 1.5f,
                                16f * mActivity.getResources().getDisplayMetrics().density);
                        if (dist <= slop) {
                            MotionEvent cancelEv = MotionEvent.obtain(ev);
                            if (cancelEv != null) {
                                cancelEv.setAction(MotionEvent.ACTION_CANCEL);
                                try {
                                    mOrig.dispatchTouchEvent(cancelEv);
                                } catch (Throwable ignored) {
                                } finally {
                                    cancelEv.recycle();
                                }
                            }
                            launchNativeTarget(mActivity, tap.target);
                            return true;
                        }
                    }
                } catch (Throwable t) {
                    mPendingTap = null;
                    android.util.Log.w("GrokBotBootstrap", "Touch intercept error: " + t.getClass().getSimpleName());
                }
            }
            return mOrig.dispatchTouchEvent(ev);
        }

        @Override public boolean dispatchKeyEvent(KeyEvent event) { return mOrig.dispatchKeyEvent(event); }
        @Override public boolean dispatchKeyShortcutEvent(KeyEvent event) { return mOrig.dispatchKeyShortcutEvent(event); }
        @Override public boolean dispatchTrackballEvent(MotionEvent event) { return mOrig.dispatchTrackballEvent(event); }
        @Override public boolean dispatchGenericMotionEvent(MotionEvent event) { return mOrig.dispatchGenericMotionEvent(event); }
        @Override public boolean dispatchPopulateAccessibilityEvent(AccessibilityEvent event) { return mOrig.dispatchPopulateAccessibilityEvent(event); }
        @Override public View onCreatePanelView(int featureId) { return mOrig.onCreatePanelView(featureId); }
        @Override public boolean onCreatePanelMenu(int featureId, Menu menu) { return mOrig.onCreatePanelMenu(featureId, menu); }
        @Override public boolean onPreparePanel(int featureId, View view, Menu menu) { return mOrig.onPreparePanel(featureId, view, menu); }
        @Override public boolean onMenuOpened(int featureId, Menu menu) { return mOrig.onMenuOpened(featureId, menu); }
        @Override public boolean onMenuItemSelected(int featureId, MenuItem item) { return mOrig.onMenuItemSelected(featureId, item); }
        @Override public void onWindowAttributesChanged(WindowManager.LayoutParams attrs) { mOrig.onWindowAttributesChanged(attrs); }
        @Override public void onContentChanged() { mOrig.onContentChanged(); }
        @Override public void onWindowFocusChanged(boolean hasFocus) { mOrig.onWindowFocusChanged(hasFocus); }
        @Override public void onAttachedToWindow() { mOrig.onAttachedToWindow(); }
        @Override public void onDetachedFromWindow() { mOrig.onDetachedFromWindow(); }
        @Override public void onPanelClosed(int featureId, Menu menu) { mOrig.onPanelClosed(featureId, menu); }
        @Override public boolean onSearchRequested() { return mOrig.onSearchRequested(); }
        @Override public boolean onSearchRequested(SearchEvent searchEvent) { return mOrig.onSearchRequested(searchEvent); }
        @Override public ActionMode onWindowStartingActionMode(ActionMode.Callback callback) { return mOrig.onWindowStartingActionMode(callback); }
        @Override public ActionMode onWindowStartingActionMode(ActionMode.Callback callback, int type) { return mOrig.onWindowStartingActionMode(callback, type); }
        @Override public void onActionModeStarted(ActionMode mode) { mOrig.onActionModeStarted(mode); }
        @Override public void onActionModeFinished(ActionMode mode) { mOrig.onActionModeFinished(mode); }
        @Override public void onProvideKeyboardShortcuts(List<KeyboardShortcutGroup> data, Menu menu, int deviceId) { mOrig.onProvideKeyboardShortcuts(data, menu, deviceId); }
        @Override public void onPointerCaptureChanged(boolean hasCapture) { mOrig.onPointerCaptureChanged(hasCapture); }
    }

    private static void attachWindowTouchInterceptor(Activity activity) {
        Window window = activity.getWindow();
        if (window == null) return;
        final Window.Callback orig = window.getCallback();
        if (orig == null || orig instanceof TouchInterceptWindowCallback) return;
        window.setCallback(new TouchInterceptWindowCallback(activity, window, orig));
    }

    private static HitResult findNativeTargetAtPoint(Activity activity, View view, float rawX, float rawY) {
        int[] loc = new int[2];
        int marginPx = Math.round(96f * Math.max(1f, activity.getResources().getDisplayMetrics().density));
        return findNativeTargetAtPointInternal(activity, view, rawX, rawY, loc, marginPx);
    }

    private static HitResult findNativeTargetAtPointInternal(
            Activity activity, View view, float rawX, float rawY, int[] loc, int marginPx) {
        if (view == null || view.getVisibility() != View.VISIBLE || !view.isShown()) return null;
        int w = view.getWidth();
        int h = view.getHeight();
        if (w > 0 && h > 0) {
            view.getLocationOnScreen(loc);
            int left = loc[0];
            int top = loc[1];
            int right = left + w;
            int bottom = top + h;
            // Strictly prune scrollable viewports; prune other subtrees outside generous hit margin
            int pad = isScrollableContainer(view) ? 0 : marginPx;
            if (rawX < left - pad || rawX > right + pad || rawY < top - pad || rawY > bottom + pad) {
                return null;
            }
        }
        if (view instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) view;
            for (int i = vg.getChildCount() - 1; i >= 0; i--) {
                HitResult childHit = findNativeTargetAtPointInternal(activity, vg.getChildAt(i), rawX, rawY, loc, marginPx);
                if (childHit != null) return childHit;
            }
        }
        if (view.getTag(TAG_OVERRIDDEN_TARGET) == null && extractViewText(view) == null) {
            return null;
        }
        Class<?> target = resolveNativeTargetForView(activity, view);
        if (target != null) {
            Rect hitRect = (target == PushSettingsActivity.class)
                    ? resolveNotificationsRowHitRect(activity, view)
                    : resolveCompactHitRect(activity, view);
            if (hitRect != null && hitRect.contains((int) rawX, (int) rawY)) {
                return new HitResult(target);
            }
        }
        return null;
    }

    private static Rect resolveCompactHitRect(Activity activity, View leaf) {
        Rect best = getScreenRect(leaf);
        if (best == null) return null;
        float density = Math.max(1f, activity.getResources().getDisplayMetrics().density);
        float maxHeightPx = 120f * density;
        View cur = leaf;
        for (int depth = 0; depth < 3; depth++) {
            if (!(cur.getParent() instanceof ViewGroup)) break;
            ViewGroup parent = (ViewGroup) cur.getParent();
            String clsName = parent.getClass().getName();
            if ("com.android.internal.policy.DecorView".equals(clsName)
                    || parent.getId() == android.R.id.content
                    || parent.getVisibility() != View.VISIBLE
                    || !parent.isShown()) {
                break;
            }
            Rect pr = getScreenRect(parent);
            if (pr == null || pr.height() > maxHeightPx) {
                break;
            }
            int nodeCap = (pr.width() >= (int) (240f * density)) ? 32 : 16;
            if (countSmallTreeNodes(parent, nodeCap + 1) > nodeCap) {
                break;
            }
            best = pr;
            cur = parent;
        }
        return clipToScrollableAncestors(leaf, best);
    }

    private static boolean isScrollableContainer(View v) {
        if (v == null) return false;
        if (v instanceof ScrollView || v instanceof HorizontalScrollView) return true;
        String cls = v.getClass().getName();
        return cls.startsWith("com.facebook.react.views.scroll.");
    }

    private static Rect clipToScrollableAncestors(View leaf, Rect rect) {
        if (leaf == null || rect == null) return rect;
        int left = rect.left;
        int top = rect.top;
        int right = rect.right;
        int bottom = rect.bottom;
        View cur = leaf;
        while (cur.getParent() instanceof View) {
            View p = (View) cur.getParent();
            String clsName = p.getClass().getName();
            if ("com.android.internal.policy.DecorView".equals(clsName)
                    || p.getId() == android.R.id.content) {
                break;
            }
            if (isScrollableContainer(p)) {
                Rect sr = getScreenRect(p);
                if (sr != null && sr.width() > 0 && sr.height() > 0) {
                    left = Math.max(left, sr.left);
                    top = Math.max(top, sr.top);
                    right = Math.min(right, sr.right);
                    bottom = Math.min(bottom, sr.bottom);
                    if (right <= left || bottom <= top) {
                        return null;
                    }
                }
            }
            cur = p;
        }
        return (right > left && bottom > top) ? new Rect(left, top, right, bottom) : null;
    }

    private static Rect getScreenRect(View v) {
        if (v == null || v.getWidth() <= 0 || v.getHeight() <= 0) return null;
        int[] loc = new int[2];
        v.getLocationOnScreen(loc);
        return new Rect(loc[0], loc[1], loc[0] + v.getWidth(), loc[1] + v.getHeight());
    }

    private static boolean isRnView(View v) {
        return v != null && v.getClass().getName().startsWith("com.facebook.react.");
    }

    private static float resolveDensity(View v) {
        try {
            if (v != null && v.getResources() != null && v.getResources().getDisplayMetrics() != null) {
                float d = v.getResources().getDisplayMetrics().density;
                if (d > 0f) return d;
            }
        } catch (Throwable ignored) {}
        return 2f;
    }

    private static boolean isSwitchLikeView(View v) {
        if (v == null) return false;
        return containsSwitchDescendant(v, 0, new int[1]);
    }

    private static boolean containsSwitchDescendant(View v, int depth, int[] count) {
        if (v == null || depth > 4 || count[0] >= 12) return false;
        count[0]++;
        if (v instanceof CompoundButton) return true;
        String cls = v.getClass().getName();
        if ("expo.modules.ui.HostView".equals(cls)
                || "androidx.compose.ui.platform.AndroidComposeView".equals(cls)) {
            return true;
        }
        if (v instanceof ViewGroup && depth < 4) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                if (containsSwitchDescendant(vg.getChildAt(i), depth + 1, count)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean isSidebarIdentityFooterLabel(String raw) {
        if (raw == null || raw.isEmpty()) return false;
        String s = raw.trim();
        return s.equalsIgnoreCase("Connect apps")
                || s.equals("连接应用")
                || s.equals("連結應用程式")
                || s.equalsIgnoreCase("Conectar aplicativos")
                || s.equalsIgnoreCase("Conectar aplicaciones")
                || s.equalsIgnoreCase("Connecter des applications")
                || s.equalsIgnoreCase("Apps verbinden")
                || s.equals("ऐप कनेक्ट करें")
                || s.equalsIgnoreCase("Update to latest version")
                || s.equals("更新到最新版本");
    }

    private static boolean containsSidebarFooterText(View v, int[] visited) {
        if (v == null || visited[0] >= 128) return false;
        visited[0]++;
        String txt = extractViewText(v);
        if (isSidebarIdentityFooterLabel(txt)) return true;
        if (v instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                if (containsSidebarFooterText(vg.getChildAt(i), visited)) return true;
            }
        }
        return false;
    }

    private static View resolveIdentityContainer(Activity activity, View view, float density) {
        if (view == null) return null;
        View cur = view;
        for (int depth = 0; depth < 3; depth++) {
            float curW = cur.getWidth() / density;
            float curH = cur.getHeight() / density;
            if (curW > 300f && curH > 50f && curH <= 140f) {
                break;
            }
            if (!(cur.getParent() instanceof ViewGroup)) break;
            ViewGroup parent = (ViewGroup) cur.getParent();
            String clsName = parent.getClass().getName();
            if ("com.android.internal.policy.DecorView".equals(clsName)
                    || parent.getId() == android.R.id.content
                    || parent.getChildCount() > 8) {
                break;
            }
            cur = parent;
        }
        float curW = cur.getWidth() / density;
        float curH = cur.getHeight() / density;
        if (!(curW > 300f && curH > 50f && curH <= 140f)) return null;
        if (containsSidebarFooterText(cur, new int[1])) return null;
        View anc = cur;
        int maxBarH = (int) (220f * density);
        for (int up = 0; up < 4; up++) {
            if (!(anc.getParent() instanceof ViewGroup)) break;
            ViewGroup p = (ViewGroup) anc.getParent();
            String pCls = p.getClass().getName();
            if ("com.android.internal.policy.DecorView".equals(pCls)
                    || p.getId() == android.R.id.content
                    || isScrollableContainer(p)) {
                break;
            }
            if (p.getHeight() > maxBarH) {
                break;
            }
            if (containsSidebarFooterText(p, new int[1])) {
                return null;
            }
            anc = p;
        }
        return cur;
    }

    private static boolean hasWideAncestorRow(View view, float density, float maxRowWidthDp) {
        if (view == null) return false;
        View cur = view;
        for (int depth = 0; depth < 3; depth++) {
            if (!(cur.getParent() instanceof ViewGroup)) break;
            ViewGroup parent = (ViewGroup) cur.getParent();
            String clsName = parent.getClass().getName();
            if ("com.android.internal.policy.DecorView".equals(clsName)
                    || parent.getId() == android.R.id.content) {
                break;
            }
            float pw = parent.getWidth() / density;
            float ph = parent.getHeight() / density;
            if (pw > maxRowWidthDp && ph > 0f && ph <= 120f) {
                return true;
            }
            if (parent.getChildCount() > 8) break;
            cur = parent;
        }
        return false;
    }

    private static boolean isInSheetHeaderBar(View view) {
        if (view == null) return false;
        View host = findClickableHostView(view);
        float density = resolveDensity(view);
        int maxHeaderH = (int) (120f * density);
        View cur = host;
        for (int depth = 0; depth < 2; depth++) {
            if (!(cur.getParent() instanceof ViewGroup)) break;
            ViewGroup parent = (ViewGroup) cur.getParent();
            String clsName = parent.getClass().getName();
            if ("com.android.internal.policy.DecorView".equals(clsName)
                    || parent.getId() == android.R.id.content) {
                break;
            }
            for (int i = 0; i < parent.getChildCount(); i++) {
                View sib = parent.getChildAt(i);
                if (sib == null || sib == cur) continue;
                if (containsSheetCloseLabel(sib, 0, new int[1])) {
                    return true;
                }
            }
            if (parent.getChildCount() >= 2 && !parent.isClickable() && !parent.hasOnClickListeners()
                    && (depth == 0 || (parent.getHeight() > 0 && parent.getHeight() <= maxHeaderH))) {
                return true;
            }
            cur = parent;
        }
        return false;
    }

    private static boolean containsSheetCloseLabel(View v, int depth, int[] visited) {
        if (v == null || depth > 2 || visited[0] >= 12) return false;
        visited[0]++;
        String txt = extractViewText(v);
        if (txt != null) {
            String t = txt.trim();
            if (t.equalsIgnoreCase("Close") || t.equals("关闭") || t.equals("關閉")) {
                return true;
            }
        }
        if (v instanceof ViewGroup && depth < 2) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                if (containsSheetCloseLabel(vg.getChildAt(i), depth + 1, visited)) return true;
            }
        }
        return false;
    }

    private static boolean hasAncestor(View view, Class<?> ancestorClass) {
        View cur = view;
        while (cur != null && cur.getParent() instanceof View) {
            cur = (View) cur.getParent();
            if (ancestorClass.isInstance(cur)) return true;
        }
        return false;
    }

    private static boolean hasMultiTabRowSibling(View view) {
        if (view == null) return false;
        View anchor = findClickableHostView(view);
        View cur = anchor;
        for (int depth = 0; depth < 2; depth++) {
            if (!(cur.getParent() instanceof ViewGroup)) break;
            ViewGroup parent = (ViewGroup) cur.getParent();
            String clsName = parent.getClass().getName();
            if ("com.android.internal.policy.DecorView".equals(clsName)
                    || parent.getId() == android.R.id.content) {
                break;
            }
            int clickableTabs = 0;
            for (int i = 0; i < parent.getChildCount(); i++) {
                View child = parent.getChildAt(i);
                if (child == null || child.getVisibility() != View.VISIBLE) continue;
                if (isInteractiveTabChild(child)) {
                    clickableTabs++;
                    if (clickableTabs >= 3) return true;
                }
            }
            cur = parent;
        }
        return false;
    }

    private static boolean isInteractiveTabChild(View v) {
        boolean clickable = v.isClickable() || v.hasOnClickListeners();
        if (clickable && hasAnyTextDescendant(v, 0, new int[1])) return true;
        if (v instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                View c = vg.getChildAt(i);
                if (c != null && (c.isClickable() || c.hasOnClickListeners()) && hasAnyTextDescendant(c, 0, new int[1])) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean hasAnyTextDescendant(View v, int depth, int[] visited) {
        if (v == null || depth > 2 || visited[0] >= 10) return false;
        visited[0]++;
        String t = extractViewText(v);
        if (t != null && !t.isEmpty()) return true;
        if (v instanceof ViewGroup && depth < 2) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                if (hasAnyTextDescendant(vg.getChildAt(i), depth + 1, visited)) return true;
            }
        }
        return false;
    }

    private static final class FlattenedNotifMatch {
        final ViewGroup parent;
        final View anchor;
        final Rect textRect;
        final View sw;
        final Rect swRect;

        FlattenedNotifMatch(ViewGroup parent, View anchor, Rect textRect, View sw, Rect swRect) {
            this.parent = parent;
            this.anchor = anchor;
            this.textRect = textRect;
            this.sw = sw;
            this.swRect = swRect;
        }
    }

    private static FlattenedNotifMatch findFlattenedNotificationsRow(View view, float density) {
        if (!(view instanceof TextView)) return null;
        Rect textRect = getScreenRect(view);
        if (textRect == null) return null;
        View cur = view;
        for (int depth = 0; depth < 2; depth++) {
            if (!(cur.getParent() instanceof ViewGroup)) break;
            ViewGroup parent = (ViewGroup) cur.getParent();
            String clsName = parent.getClass().getName();
            if ("com.android.internal.policy.DecorView".equals(clsName)
                    || parent.getId() == android.R.id.content) {
                break;
            }
            if (parent.getWidth() >= (int) (300f * density)) {
                Rect parentRect = getScreenRect(parent);
                if (parentRect != null) {
                    View sw = null;
                    Rect swRect = null;
                    int maxCenterDiffY = Math.round(36f * density);
                    for (int i = 0; i < parent.getChildCount(); i++) {
                        View sib = parent.getChildAt(i);
                        if (sib == null || sib == view || sib == cur || sib.getVisibility() != View.VISIBLE) continue;
                        if (!isSwitchLikeView(sib)) continue;
                        Rect r = getScreenRect(sib);
                        if (r != null && r.centerX() > textRect.centerX()
                                && Math.abs(r.centerY() - textRect.centerY()) <= maxCenterDiffY) {
                            sw = sib;
                            swRect = r;
                            break;
                        }
                    }
                    if (sw != null) {
                        boolean hasSubtitle = false;
                        int subMinTop = textRect.bottom - Math.round(4f * density);
                        int subMaxTop = Math.max(textRect.bottom + Math.round(16f * density), swRect.bottom);
                        for (int i = 0; i < parent.getChildCount(); i++) {
                            View sib = parent.getChildAt(i);
                            if (!(sib instanceof TextView) || sib == view || sib.getVisibility() != View.VISIBLE) continue;
                            Rect sr = getScreenRect(sib);
                            if (sr == null) continue;
                            if (sr.right > textRect.left && sr.left < textRect.right
                                    && sr.top >= subMinTop && sr.top <= subMaxTop) {
                                hasSubtitle = true;
                                break;
                            }
                        }
                        if (!hasSubtitle) {
                            return new FlattenedNotifMatch(parent, cur, textRect, sw, swRect);
                        }
                    }
                }
            }
            cur = parent;
        }
        return null;
    }

    private static Rect resolveNotificationsRowHitRect(Activity activity, View view) {
        float density = Math.max(1f, activity.getResources().getDisplayMetrics().density);
        FlattenedNotifMatch m = findFlattenedNotificationsRow(view, density);
        if (m == null) {
            return resolveCompactHitRect(activity, view);
        }
        Rect parentRect = getScreenRect(m.parent);
        if (parentRect == null) return resolveCompactHitRect(activity, view);
        int padY = Math.round(12f * density);
        int bandTop = Math.max(parentRect.top, Math.min(m.textRect.top, m.swRect.top) - padY);
        int bandBottom = Math.min(parentRect.bottom, Math.max(m.textRect.bottom, m.swRect.bottom) + padY);
        int tolY = Math.round(4f * density);
        for (int i = 0; i < m.parent.getChildCount(); i++) {
            View sib = m.parent.getChildAt(i);
            if (sib == null || sib == view || sib == m.anchor || sib == m.sw || sib.getVisibility() != View.VISIBLE) continue;
            Rect sr = getScreenRect(sib);
            if (sr == null || sr.height() <= 0) continue;
            if (sr.top >= Math.max(m.textRect.bottom, m.swRect.bottom) - tolY) {
                bandBottom = Math.min(bandBottom, sr.top);
            } else if (sr.bottom <= Math.min(m.textRect.top, m.swRect.top) + tolY) {
                bandTop = Math.max(bandTop, sr.bottom);
            }
        }
        if (bandBottom <= bandTop) return null;
        return clipToScrollableAncestors(m.parent, new Rect(parentRect.left, bandTop, parentRect.right, bandBottom));
    }

    private static boolean hasNotificationsSubtitleSibling(View view, View host, float density) {
        Rect textRect = getScreenRect(view);
        if (textRect == null) return false;
        ViewGroup parent = (view.getParent() instanceof ViewGroup) ? (ViewGroup) view.getParent() : null;
        if (parent == null && host instanceof ViewGroup) parent = (ViewGroup) host;
        if (parent == null) return false;
        int subMinTop = textRect.bottom - Math.round(4f * density);
        int subMaxTop = textRect.bottom + Math.round(28f * density);
        for (int i = 0; i < parent.getChildCount(); i++) {
            View sib = parent.getChildAt(i);
            if (!(sib instanceof TextView) || sib == view || sib.getVisibility() != View.VISIBLE) continue;
            Rect sr = getScreenRect(sib);
            if (sr != null && sr.right > textRect.left && sr.left < textRect.right
                    && sr.top >= subMinTop && sr.top <= subMaxTop) {
                return true;
            }
        }
        return false;
    }

    private static boolean matchesLabelOrCommaPrefix(String s, String exact, boolean ignoreCase) {
        if (s == null) return false;
        if (ignoreCase) {
            if (s.equalsIgnoreCase(exact)) return true;
            String lower = s.toLowerCase(java.util.Locale.US);
            String el = exact.toLowerCase(java.util.Locale.US);
            return lower.startsWith(el + ",") || lower.startsWith(el + "，");
        }
        return s.equals(exact) || s.startsWith(exact + ",") || s.startsWith(exact + "，");
    }

    private static boolean matchesLibraryLabel(String s) {
        return matchesLabelOrCommaPrefix(s, "资料库", false) || matchesLabelOrCommaPrefix(s, "Library", true);
    }

    private static boolean matchesUsageLabel(String s) {
        return matchesLabelOrCommaPrefix(s, "用量", false) || matchesLabelOrCommaPrefix(s, "Usage", true);
    }

    private static boolean matchesComputersLabel(String s) {
        return matchesLabelOrCommaPrefix(s, "Bot 电脑", false)
                || matchesLabelOrCommaPrefix(s, "Bot Computer", true)
                || matchesLabelOrCommaPrefix(s, "Bot Computers", true);
    }

    private static boolean matchesNotificationsLabel(String s) {
        return s.equals("通知") || s.equals("推送设置") || s.equals("设备与通知")
                || s.equalsIgnoreCase("Notifications") || s.equalsIgnoreCase("Push Settings")
                || s.equalsIgnoreCase("Devices & Notifications");
    }

    private static String resolveDisplayHostLabel(Context context) {
        if (context == null) return "Host";
        String reported = Storage.getReportedGatewayUrl(context);
        if (reported != null && !reported.isEmpty()) {
            try {
                String h = Uri.parse(reported).getHost();
                if (h != null && !h.isEmpty() && !"connect".equalsIgnoreCase(h)) {
                    return h;
                }
            } catch (Throwable ignored) {}
        }
        if (Storage.isTailcatEnabled(context)) {
            String link = Storage.getTailcatLink(context);
            if (link != null && !link.isEmpty()) {
                try {
                    Uri u = Uri.parse(link);
                    if ("tailcat".equalsIgnoreCase(u.getScheme())) {
                        String path = u.getPath();
                        if (path != null) {
                            while (path.startsWith("/")) path = path.substring(1);
                            if (!path.isEmpty() && !"connect".equalsIgnoreCase(path)) {
                                return path;
                            }
                        }
                    }
                } catch (Throwable ignored) {}
            }
            try {
                String resolved = TailcatManager.get().resolveServerUrl(context);
                if (resolved != null && !resolved.isEmpty()) {
                    Uri ru = Uri.parse(resolved);
                    if (ru.getHost() != null && !ru.getHost().isEmpty()) {
                        return ru.getPort() > 0 ? (ru.getHost() + ":" + ru.getPort()) : ru.getHost();
                    }
                }
            } catch (Throwable ignored) {}
        }
        String rawUrl = Storage.getHostUrl(context);
        if (rawUrl == null || rawUrl.isEmpty()) rawUrl = Storage.getGatewayUrl(context);
        if (rawUrl != null && !rawUrl.isEmpty()) {
            try {
                Uri u = Uri.parse(rawUrl);
                if (!"tailcat".equalsIgnoreCase(u.getScheme())) {
                    String h = u.getHost();
                    if (h != null && !h.isEmpty() && !"connect".equalsIgnoreCase(h)) {
                        return h;
                    }
                }
            } catch (Throwable ignored) {}
        }
        return "Host";
    }

    private static Class<?> resolveNativeTargetForView(Activity activity, View view) {
        if (activity == null || view == null) return null;
        if (isSwitchLikeView(view)) return null;
        boolean paired = Storage.isPaired(activity);
        String label = extractViewText(view);
        Object tag = view.getTag(TAG_OVERRIDDEN_TARGET);
        if (tag instanceof String) {
            if (label != null && label.trim().equals(tag)) {
                if (!paired) return null;
                boolean isRn = isRnView(view) || isReactActivity(activity);
                if (!isRn) return ProfileActivity.class;
                if (view.getWidth() <= 0 || view.getHeight() <= 0) return null;
                float density = Math.max(1f, activity.getResources().getDisplayMetrics().density);
                return resolveIdentityContainer(activity, view, density) != null ? ProfileActivity.class : null;
            }
            // React Native Fabric recycled this TextView with a different string; clear stale tag.
            view.setTag(TAG_OVERRIDDEN_TARGET, null);
        }
        if (label == null || label.isEmpty()) return null;
        String s = label.trim();

        boolean isRnSurface = isRnView(view) || isReactActivity(activity);
        if (!isRnSurface) {
            if (!paired && (s.equalsIgnoreCase("dev-gateway@localhost")
                    || s.equalsIgnoreCase("dev-gateway@localhost avatar")
                    || s.equalsIgnoreCase("link")
                    || s.equalsIgnoreCase("Debug") || s.equals("调试")
                    || s.equalsIgnoreCase("Profile") || s.equals("个人资料")
                    || matchesNotificationsLabel(s)
                    || matchesLibraryLabel(s)
                    || matchesUsageLabel(s)
                    || matchesComputersLabel(s))) {
                return null;
            }
            return resolveNativeTargetForLabel(activity, s);
        }

        float density = Math.max(1f, activity.getResources().getDisplayMetrics().density);
        boolean hasBounds = view.getWidth() > 0 && view.getHeight() > 0;
        if (!hasBounds) return null;

        float dpW = view.getWidth() / density;
        float dpH = view.getHeight() / density;
        View host = findClickableHostView(view);
        float hostDpW = host.getWidth() / density;
        float hostDpH = host.getHeight() / density;
        float effW = Math.max(dpW, hostDpW);
        float effH = Math.max(dpH, hostDpH);
        boolean isInteractiveTarget = view.isClickable() || view.hasOnClickListeners()
                || host.isClickable() || host.hasOnClickListeners() || !(view instanceof TextView);

        if (s.equalsIgnoreCase("Log in")
                || s.equalsIgnoreCase("Login")
                || s.equalsIgnoreCase("Sign in")
                || s.equals("登录")
                || s.equals("登入")
                || s.equals("登陆")
                || s.equals("登录或注册")
                || s.equalsIgnoreCase("Log in or sign up")
                || s.equalsIgnoreCase("Connect your Grok Bot")
                || s.equals("连接你的 Grok Bot")) {
            return (!paired && isInteractiveTarget && effW > 100f && effH >= 32f && effH <= 140f) ? PairingActivity.class : null;
        }
        if (s.equals("连接服务端") || s.equalsIgnoreCase("Connect to Host")) {
            if (!paired) {
                return (isInteractiveTarget && effW > 100f && effH >= 32f && effH <= 140f) ? PairingActivity.class : null;
            }
            boolean inSheetHeader = isInSheetHeaderBar(view);
            float maxDpW = inSheetHeader ? 160f : 120f;
            float maxEffW = inSheetHeader ? 190f : 140f;
            return (dpW <= maxDpW && effW <= maxEffW && effH <= 72f && isInteractiveTarget
                    && (!hasWideAncestorRow(view, density, 140f) || inSheetHeader)) ? PairingActivity.class : null;
        }
        if (s.equals("调试")
                || s.equalsIgnoreCase("Debug")
                || s.equalsIgnoreCase("link")
                || s.equalsIgnoreCase("Connect Host")
                || s.equals("连接 Host")
                || s.equals("Host 连接")
                || s.equalsIgnoreCase("Host Connection")) {
            // Toolbar Host status icon only; never hijack wide SettingsSheet rows.
            boolean inSheetHeader = isInSheetHeaderBar(view);
            float maxDpW = inSheetHeader ? 160f : 120f;
            float maxEffW = inSheetHeader ? 190f : 140f;
            return (paired && dpW <= maxDpW && effW <= maxEffW && effH <= 72f && isInteractiveTarget
                    && (!hasWideAncestorRow(view, density, 140f) || inSheetHeader)) ? PairingActivity.class : null;
        }
        if (s.equalsIgnoreCase("dev-gateway@localhost avatar")) {
            // Avatar tap in SidebarIdentityBar must stay in RN to open SettingsSheet (GBProfile.m line 325).
            return null;
        }
        if (s.equalsIgnoreCase("dev-gateway@localhost")) {
            if (!paired) return null;
            return resolveIdentityContainer(activity, view, density) != null ? ProfileActivity.class : null;
        }
        if (s.equals("账号") || s.equals("账户") || s.equals("个人资料")
                || s.equalsIgnoreCase("Profile") || s.equalsIgnoreCase("Account")) {
            // Keep RN SettingsSheet Account section inside RN (matches iOS GBBootstrap.m / GBProfile.m).
            return null;
        }
        if (matchesLibraryLabel(s)) {
            return (paired && isInteractiveTarget && effW >= 200f && effH >= 40f && effH <= 120f
                    && !hasAncestor(view, HorizontalScrollView.class)
                    && !hasMultiTabRowSibling(view)) ? LibraryActivity.class : null;
        }
        if (matchesUsageLabel(s)) {
            return (paired && isInteractiveTarget && effW >= 240f && effH >= 40f && effH <= 140f) ? UsageActivity.class : null;
        }
        if (matchesComputersLabel(s)) {
            return (paired && isInteractiveTarget && effW >= 240f && effH >= 40f && effH <= 140f) ? ComputersActivity.class : null;
        }
        if (matchesNotificationsLabel(s)) {
            if (!paired) return null;
            if (isInteractiveTarget && effW >= 300f && effH >= 40f && effH <= 140f
                    && !hasNotificationsSubtitleSibling(view, host, density)) {
                return PushSettingsActivity.class;
            }
            if (findFlattenedNotificationsRow(view, density) != null) {
                return PushSettingsActivity.class;
            }
            return null;
        }
        return null;
    }

    private static void launchNativeTarget(Activity activity, Class<?> target) {
        if (activity == null || target == null) return;
        Class<?> dest = Storage.isPaired(activity) ? target : PairingActivity.class;
        Intent i = new Intent(activity, dest);
        if (dest == LibraryActivity.class) {
            String agentId = getLastAgentId();
            if (agentId == null || agentId.isEmpty()) agentId = getViewingAgentId();
            if (agentId != null && !agentId.isEmpty()) {
                i.putExtra(LibraryActivity.EXTRA_AGENT_ID, agentId);
            }
        } else if (dest == PairingActivity.class) {
            i.putExtra(PairingActivity.EXTRA_FROM_RN_MODAL, true);
        }
        try {
            activity.startActivity(i);
        } catch (Throwable t) {
            android.util.Log.w("GrokBotBootstrap", "launchNativeTarget failed for " + dest.getSimpleName(), t);
        }
    }

    private static void scanAndWireRnViews(Activity activity, View view) {
        if (view == null) return;
        String label = extractViewText(view);
        if (label != null && !label.isEmpty()) {
            Localize.observeAppLanguage(label);
            boolean paired = Storage.isPaired(activity);
            Object tag = view.getTag(TAG_OVERRIDDEN_TARGET);
            if (tag instanceof String && (!paired || !label.trim().equals(tag))) {
                view.setTag(TAG_OVERRIDDEN_TARGET, null);
            }
            if (view instanceof TextView && "dev-gateway@localhost".equalsIgnoreCase(label.trim()) && paired) {
                float density = Math.max(1f, activity.getResources().getDisplayMetrics().density);
                boolean allowRewrite = !isReactActivity(activity) || resolveIdentityContainer(activity, view, density) != null;
                if (allowRewrite) {
                    String hostLabel = resolveDisplayHostLabel(activity);
                    view.setTag(TAG_OVERRIDDEN_TARGET, hostLabel);
                    ((TextView) view).setText(hostLabel);
                }
            }
            if (!isReactActivity(activity)) {
                Class<?> target = resolveNativeTargetForView(activity, view);
                if (target != null) {
                    View clickTarget = findClickableHostView(view);
                    if (!Boolean.TRUE.equals(clickTarget.getTag(TAG_HOOKED_CLICK))) {
                        clickTarget.setTag(TAG_HOOKED_CLICK, Boolean.TRUE);
                        clickTarget.setOnClickListener(v -> launchNativeTarget(activity, target));
                    }
                }
            }
        } else if (view.getTag(TAG_OVERRIDDEN_TARGET) != null) {
            view.setTag(TAG_OVERRIDDEN_TARGET, null);
        }
        if (view instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) view;
            for (int i = 0; i < vg.getChildCount(); i++) {
                scanAndWireRnViews(activity, vg.getChildAt(i));
            }
        }
    }

    private static View findClickableHostView(View leaf) {
        View bestClickable = (leaf.isClickable() || leaf.hasOnClickListeners()) ? leaf : null;
        float density = resolveDensity(leaf);
        View cur = leaf;
        for (int depth = 0; depth < 3; depth++) {
            if (!(cur.getParent() instanceof ViewGroup)) break;
            ViewGroup parent = (ViewGroup) cur.getParent();
            String clsName = parent.getClass().getName();
            if ("com.android.internal.policy.DecorView".equals(clsName)
                    || parent.getId() == android.R.id.content) {
                break;
            }
            boolean heightOk = parent.getHeight() <= 0 || parent.getHeight() <= (int) (140f * density);
            int nodeCap = (parent.getWidth() >= (int) (240f * density)) ? 32 : 16;
            if (heightOk && (parent.isClickable() || parent.hasOnClickListeners())
                    && countSmallTreeNodes(parent, nodeCap + 1) <= nodeCap) {
                bestClickable = parent;
            }
            if (parent.getChildCount() > 8) {
                break;
            }
            cur = parent;
        }
        return bestClickable != null ? bestClickable : leaf;
    }

    private static int countSmallTreeNodes(View v, int cap) {
        if (v == null) return 0;
        int count = 1;
        if (v instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                count += countSmallTreeNodes(vg.getChildAt(i), cap);
                if (count >= cap) return cap;
            }
        }
        return count;
    }

    private static String extractViewText(View v) {
        if (v instanceof TextView) {
            CharSequence cs = ((TextView) v).getText();
            if (cs != null && cs.length() > 0) return cs.toString().trim();
        }
        CharSequence desc = v.getContentDescription();
        if (desc != null && desc.length() > 0) return desc.toString().trim();
        return null;
    }

    public static Class<?> resolveNativeTargetForLabel(Context context, String rawLabel) {
        if (rawLabel == null) return null;
        String s = rawLabel.trim();
        if (s.equalsIgnoreCase("link") && (context == null || !Storage.isPaired(context))) {
            return null;
        }
        return resolveNativeTargetForLabel(rawLabel);
    }

    public static Class<?> resolveNativeTargetForLabel(String rawLabel) {
        if (rawLabel == null) return null;
        String s = rawLabel.trim();
        if (s.equalsIgnoreCase("Log in")
                || s.equalsIgnoreCase("Login")
                || s.equalsIgnoreCase("Sign in")
                || s.equals("登录")
                || s.equals("登入")
                || s.equals("登陆")
                || s.equals("登录或注册")
                || s.equalsIgnoreCase("Log in or sign up")
                || s.equalsIgnoreCase("Connect Host")
                || s.equals("连接 Host")
                || s.equals("Host 连接")
                || s.equals("连接服务端")
                || s.equalsIgnoreCase("Connect to Host")
                || s.equalsIgnoreCase("Host Connection")
                || s.equalsIgnoreCase("Connect your Grok Bot")
                || s.equals("连接你的 Grok Bot")
                || s.equals("调试")
                || s.equalsIgnoreCase("Debug")
                || s.equalsIgnoreCase("link")) {
            return PairingActivity.class;
        }
        if (matchesLibraryLabel(s)) {
            return LibraryActivity.class;
        }
        if (matchesUsageLabel(s)) {
            return UsageActivity.class;
        }
        if (matchesComputersLabel(s)) {
            return ComputersActivity.class;
        }
        if (matchesNotificationsLabel(s)) {
            return PushSettingsActivity.class;
        }
        if (s.equals("账号") || s.equals("账户") || s.equals("个人资料")
                || s.equalsIgnoreCase("Profile") || s.equalsIgnoreCase("Account")
                || s.equalsIgnoreCase("dev-gateway@localhost")) {
            return ProfileActivity.class;
        }
        return null;
    }

    private static void installNetworkInterceptor(Context context) {
        PairipVmBridge.install();
        R8OkHttpHook.install(context);
        LegacyOkHttpHook.install(context);
    }

    private static void clearExpoCache(Context context) {
        try {
            File expoDir = new File(context.getFilesDir(), ".expo-internal");
            if (expoDir.exists()) deleteRecursively(expoDir);
            File dataDir = context.getApplicationInfo() != null ? new File(context.getApplicationInfo().dataDir) : null;
            if (dataDir != null) {
                File dbs = new File(dataDir, "databases");
                if (dbs.exists()) {
                    File[] files = dbs.listFiles((dir, name) -> name.startsWith("expo-updates"));
                    if (files != null) {
                        for (File f : files) f.delete();
                    }
                }
            }
        } catch (Throwable ignored) {}
    }

    private static void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursively(child);
            }
        }
        file.delete();
    }
}

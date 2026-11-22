package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.Application;
import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.res.Resources;
import android.database.MatrixCursor;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import com.pairip.VMRunner;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.CompletableFuture;
import kotlin.jvm.functions.Function2;
import org.json.JSONObject;

/**
 * Runtime dispatcher replacing Google Pairip's encrypted VM execution once DEX hooks are applied.
 * Invoked via VMRunner.invoke -> Function2.invoke(vmId, args).
 */
public final class PairipVmBridge {
    private static final String TAG = "RokBotPairipBridge";
    private static volatile boolean sInstalled = false;
    private static volatile boolean sStringsLoaded = false;

    private PairipVmBridge() {}

    public static void install() {
        install((ClassLoader) null);
    }

    public static void install(ClassLoader classLoader) {
        if (!sInstalled) {
            synchronized (PairipVmBridge.class) {
                if (!sInstalled) {
                    try {
                        Class<?> runnerCls = Class.forName("com.pairip.VMRunner");
                        Function2<Object, Object, Object> handler = (vmIdObj, argsObj) -> {
                            String vmId = vmIdObj != null ? String.valueOf(vmIdObj) : "";
                            Object[] args = argsObj instanceof Object[] ? (Object[]) argsObj : new Object[0];
                            return dispatch(vmId, args);
                        };
                        CompletableFuture<Function2<Object, Object, Object>> future =
                                CompletableFuture.completedFuture(handler);
                        try {
                            VMRunner.setJob(future);
                        } catch (Throwable ignored) {
                            Method setJob = runnerCls.getMethod("setJob", java.util.concurrent.Future.class);
                            setJob.invoke(null, future);
                        }
                        sInstalled = true;
                    } catch (NoClassDefFoundError | ClassNotFoundException ignored) {
                        sInstalled = true;
                    } catch (Throwable t) {
                        Log.w(TAG, "Failed to install PairipVmBridge", t);
                    }
                }
            }
        }
        if (!sStringsLoaded && classLoader != null) {
            populateStringsFromClassLoader(classLoader);
        }
    }

    public static void install(Context context) {
        install(context != null ? context.getClassLoader() : null);
        if (!sStringsLoaded && context != null) {
            populateStringsFromContext(context);
        }
    }

    private static synchronized void populateStringsFromClassLoader(ClassLoader cl) {
        if (sStringsLoaded || cl == null) return;
        try (InputStream is = cl.getResourceAsStream("assets/recipes/pairip-strings.json")) {
            if (is != null) {
                applyPairipStringMap(is, cl);
            }
        } catch (Throwable ignored) {}
    }

    private static synchronized void populateStringsFromContext(Context context) {
        if (sStringsLoaded || context == null) return;
        try (InputStream is = context.getAssets().open("recipes/pairip-strings.json")) {
            applyPairipStringMap(is, context.getClassLoader());
        } catch (Throwable ignored) {}
    }

    private static void applyPairipStringMap(InputStream is, ClassLoader cl) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) {
            baos.write(buf, 0, n);
        }
        JSONObject root = new JSONObject(new String(baos.toByteArray(), StandardCharsets.UTF_8));
        ClassLoader targetCl = cl != null ? cl : PairipVmBridge.class.getClassLoader();
        int populated = 0;
        Iterator<String> clsKeys = root.keys();
        while (clsKeys.hasNext()) {
            String clsName = clsKeys.next();
            try {
                Class<?> holderCls = Class.forName(clsName, false, targetCl);
                JSONObject fields = root.getJSONObject(clsName);
                Iterator<String> fKeys = fields.keys();
                while (fKeys.hasNext()) {
                    String fName = fKeys.next();
                    try {
                        Field f = holderCls.getDeclaredField(fName);
                        f.setAccessible(true);
                        f.set(null, fields.getString(fName));
                        populated++;
                    } catch (Throwable ignored) {}
                }
            } catch (Throwable ignored) {}
        }
        sStringsLoaded = true;
        Log.i(TAG, "Populated Pairip decrypted static strings: " + populated);
    }

    public static Object dispatch(String vmId, Object[] args) {
        try {
            switch (vmId) {
                case "WuyOlMkwWcZBkxUp":
                case "VQUbVTKQTL1qtJlp":
                    handleMainApplicationOnCreate(args);
                    return null;
                case "6IrZUIqGyM6AvaEM":
                case "wbaeflvl3wYdHcnN":
                    handleMainActivityOnCreate(args);
                    return null;
                case "2kt3kbedcjY9LmFn":
                    return handleVoiceCallServiceStart(args);
                case "AiKcMrBaBFTk4NAj":
                    handleExpoNotificationsOnReceive(args);
                    return null;
                case "6yVugsjKzNysknoL":
                case "GBAvda9b6VdXkwk8":
                    return handleFileProviderQuery(args, true);
                case "d1VB4OmIOrtlRvlX":
                case "YwstgKX7qsz4pQAu":
                    return handleFileProviderQuery(args, false);
                case "gPfXSxLeDsHS85uB":
                    return Integer.valueOf(Service.START_NOT_STICKY);
                case "ZFLJ0hjr1EuS34Jm":
                case "aGVaQw3uVgSshh8H":
                case "heZqubzfRJao8bhb":
                case "xalh73mU6HvhBRHu":
                case "RHhGPK9YBacRoUYw":
                case "M6G0fpsg1qPpAo7T":
                    return null;
                case "Kxck2Zh2u5FhF1tJ":
                case "5IFjnPl4DG0uh4Kg":
                case "t5fsBS6auL9smZvu":
                case "NGJoupytuCC5KK3U":
                case "fryyUFh1rxmUTPZT":
                case "7G1ELT3WWutyoSJu":
                case "PUVMLsjjxw6ZKJms":
                case "Pkq2lQp4VRLsamk4":
                case "yPnWNF0r6C07GQhs":
                case "0S9N6t3pFyc7VPPl":
                case "sAkN0RxZouDqCE6s":
                case "SoGry6x665HebzTB":
                case "GU0LCjESbvj9UT2P":
                case "5q5q5Yxdr81312tm":
                case "uX2I4kjoqIXRjoXt":
                case "L9rRYkEWpLsSoOnW":
                case "RKuIoSarf15NBRcX":
                    handleGenericActivityOnCreate(args);
                    return null;
                case "WbIJsghkGJChf1aD":
                case "I5hfm577V3jsppLY":
                    callZeroArgSynthetic(args, "onDestroy$001", Activity.class);
                    return null;
                case "64riMf9qOhm1Imox":
                case "v9LqZUpcQtcB3Nwo":
                    callZeroArgSynthetic(args, "onPause$009", Activity.class);
                    return null;
                case "6w7tcpHbdgFFcnqH":
                case "emzAGhE56MI9lYhl":
                    callZeroArgSynthetic(args, "onDestroy$001", Activity.class);
                    return null;
                default:
                    return null;
            }
        } catch (Throwable t) {
            Log.e(TAG, "Pairip dispatch error for " + vmId, t);
            if ("2kt3kbedcjY9LmFn".equals(vmId) || "gPfXSxLeDsHS85uB".equals(vmId)) {
                return Integer.valueOf(Service.START_NOT_STICKY);
            }
            return null;
        }
    }

    private static void handleMainApplicationOnCreate(Object[] args) {
        if (args.length < 1 || !(args[0] instanceof Application)) return;
        Application app = (Application) args[0];

        // 1. Call super.onCreate() via MainApplication.onCreate$001(Application)
        try {
            Method m = app.getClass().getMethod("onCreate$001", Application.class);
            m.invoke(null, app);
        } catch (Throwable ignored) {
            try {
                Class<?> ma = Class.forName("ai.x.grok.bot.MainApplication");
                ma.getMethod("onCreate$001", Application.class).invoke(null, app);
            } catch (Throwable t) {
                Log.w(TAG, "onCreate$001 failed", t);
            }
        }

        // 2. Register official XVF, XVF Mono, and system fonts via ReactFontManager (p9.a in 1.26.0, X7.a in 1.16.0)
        try {
            Class<?> fontMgrCls;
            Class<?> companionCls;
            try {
                fontMgrCls = Class.forName("p9.a");
                companionCls = Class.forName("p9.a$b");
            } catch (ClassNotFoundException ignored) {
                fontMgrCls = Class.forName("X7.a");
                companionCls = Class.forName("X7.a$b");
            }
            Object companion = fontMgrCls.getField("c").get(null);
            Object fontMgr = companionCls.getMethod("c").invoke(companion);
            Method addFont = fontMgrCls.getMethod("d", Context.class, String.class, int.class);

            int xvfId = app.getResources().getIdentifier("xml_xvf", "font", app.getPackageName());
            if (xvfId == 0) xvfId = app.getResources().getIdentifier("xml_xvf", "font", "ai.x.grok.bot");
            if (xvfId != 0) addFont.invoke(fontMgr, app, "XVF", xvfId);

            int xvfMonoId = app.getResources().getIdentifier("xml_xvf_mono", "font", app.getPackageName());
            if (xvfMonoId == 0) xvfMonoId = app.getResources().getIdentifier("xml_xvf_mono", "font", "ai.x.grok.bot");
            if (xvfMonoId != 0) addFont.invoke(fontMgr, app, "XVF Mono", xvfMonoId);

            try {
                Class<?> bodyFontHelperCls;
                try {
                    bodyFontHelperCls = Class.forName("Ii.R0");
                } catch (ClassNotFoundException ignored) {
                    bodyFontHelperCls = Class.forName("jg.g");
                }
                Object bodyFontHelper = bodyFontHelperCls.getField("a").get(null);
                String bodyFont = (String) bodyFontHelperCls.getMethod("a", Resources.class)
                        .invoke(bodyFontHelper, app.getResources());
                if (bodyFont != null && !bodyFont.isEmpty()) {
                    Method setTypeface = fontMgrCls.getMethod("e", String.class, Typeface.class);
                    setTypeface.invoke(fontMgr, bodyFont, Typeface.create(bodyFont, Typeface.NORMAL));
                }
            } catch (Throwable ignored) {}
        } catch (Throwable t) {
            Log.w(TAG, "Font registration warning", t);
        }

        // 3. Configure React Native release level (STABLE)
        try {
            Class<?> defaultsCls = Class.forName("com.facebook.react.defaults.a");
            Class<?> levelCls;
            try {
                levelCls = Class.forName("m9.d");
            } catch (ClassNotFoundException ignored) {
                levelCls = Class.forName("U7.d");
            }
            Object defaultsInst = defaultsCls.getField("a").get(null);
            Object stable = levelCls.getField("c").get(null);
            defaultsCls.getMethod("e", levelCls).invoke(defaultsInst, stable);
        } catch (Throwable ignored) {}

        // 4. Load native React/Hermes/AppModules via ReactNativeApplicationEntryPoint (com.facebook.react.H.a)
        try {
            Class<?> rnEntryCls = Class.forName("com.facebook.react.H");
            rnEntryCls.getMethod("a", Context.class).invoke(null, app);
        } catch (Throwable t) {
            Log.e(TAG, "ReactNativeApplicationEntryPoint load failed", t);
        }

        // 5. Notify Expo ApplicationLifecycleDispatcher (We.a.b in 1.26.0, Fc.a.b in 1.16.0)
        try {
            Class<?> expoDispCls;
            try {
                expoDispCls = Class.forName("We.a");
            } catch (ClassNotFoundException ignored) {
                expoDispCls = Class.forName("Fc.a");
            }
            expoDispCls.getMethod("b", Application.class).invoke(null, app);
        } catch (Throwable t) {
            Log.w(TAG, "Expo ApplicationLifecycleDispatcher failed", t);
        }
    }

    private static void handleMainActivityOnCreate(Object[] args) {
        if (args.length < 1 || !(args[0] instanceof Activity)) return;
        Activity activity = (Activity) args[0];
        Bundle savedState = (args.length > 1 && args[1] instanceof Bundle) ? (Bundle) args[1] : null;
        Intent intent = activity.getIntent();

        try {
            try {
                Class<?> linkingCls = Class.forName("p6.a");
                Object linking = linkingCls.getField("a").get(null);
                linkingCls.getMethod("a", Context.class, Intent.class, Bundle.class)
                        .invoke(linking, activity, intent, savedState);
            } catch (ClassNotFoundException ignored) {
                Class<?> linkingCls = Class.forName("X4.a");
                Object linking = linkingCls.getField("a").get(null);
                linkingCls.getMethod("a", Intent.class, Bundle.class).invoke(linking, intent, savedState);
            }
        } catch (Throwable ignored) {}

        try {
            Class<?> splashCls;
            try {
                splashCls = Class.forName("Ri.d");
            } catch (ClassNotFoundException ignored) {
                splashCls = Class.forName("rg.d");
            }
            Object splash = splashCls.getField("a").get(null);
            splashCls.getMethod("k", Activity.class).invoke(splash, activity);
        } catch (Throwable ignored) {}

        try {
            Class<?> reactActCls = Class.forName("com.facebook.react.n");
            Method m = activity.getClass().getMethod("onCreate$004", reactActCls, Bundle.class);
            m.invoke(null, activity, null);
        } catch (Throwable t) {
            Log.e(TAG, "MainActivity.onCreate$004 failed", t);
        }
    }

    private static Integer handleVoiceCallServiceStart(Object[] args) {
        if (args.length < 1 || !(args[0] instanceof Service)) {
            return Integer.valueOf(Service.START_NOT_STICKY);
        }
        Service svc = (Service) args[0];
        Intent intent = (args.length > 1 && args[1] instanceof Intent) ? (Intent) args[1] : null;
        String title = intent != null ? intent.getStringExtra("title") : null;
        String body = intent != null ? intent.getStringExtra("body") : null;
        if (title == null || title.isEmpty()) title = "RokBot Voice Call";
        if (body == null) body = "Active voice session";
        try {
            Method buildNotif = svc.getClass().getMethod("a$003", svc.getClass(), String.class, String.class);
            Notification notif = (Notification) buildNotif.invoke(null, svc, title, body);
            if (notif != null) {
                svc.startForeground(1001, notif);
            }
        } catch (Throwable t) {
            Log.w(TAG, "VoiceCallForegroundService startForeground warning", t);
        }
        return Integer.valueOf(Service.START_NOT_STICKY);
    }

    private static void handleExpoNotificationsOnReceive(Object[] args) {
        if (args.length < 3 || !(args[1] instanceof Context) || !(args[2] instanceof Intent)) return;
        Context ctx = (Context) args[1];
        Intent intent = (Intent) args[2];
        String action = intent.getAction();
        if (action == null || action.startsWith("android.intent.action.")) {
            // Avoid re-broadcasting protected system actions (e.g. BOOT_COMPLETED) which throws SecurityException.
            return;
        }
        try {
            Class<?> svcCls = Class.forName("expo.modules.notifications.service.NotificationsService");
            Object companion = svcCls.getField("Companion").get(null);
            companion.getClass().getMethod("doWork", Context.class, Intent.class).invoke(companion, ctx, intent);
        } catch (Throwable t) {
            Log.w(TAG, "NotificationsService.Companion.doWork failed", t);
        }
    }

    private static Object handleFileProviderQuery(Object[] args, boolean isQ1c) {
        try {
            if (args.length < 2 || !(args[1] instanceof Uri)) return new MatrixCursor(new String[0]);
            Object provider = args[0];
            Uri uri = (Uri) args[1];
            String[] projection = (args.length > 2 && args[2] instanceof String[])
                    ? (String[]) args[2]
                    : new String[]{"_display_name", "_size"};

            File file = null;
            if (isQ1c) {
                Method getStrategy = provider.getClass().getMethod("f$001", provider.getClass());
                Object strategy = getStrategy.invoke(null, provider);
                if (strategy != null) {
                    Method getFile = strategy.getClass().getMethod("b", Uri.class);
                    file = (File) getFile.invoke(strategy, uri);
                }
            } else {
                Field f = provider.getClass().getDeclaredField("b");
                f.setAccessible(true);
                Object strategy = f.get(provider);
                if (strategy != null) {
                    Method getFile = strategy.getClass().getMethod("b", Uri.class);
                    file = (File) getFile.invoke(strategy, uri);
                }
            }

            if (projection == null) projection = new String[]{"_display_name", "_size"};
            String[] cols = new String[projection.length];
            Object[] values = new Object[projection.length];
            int i = 0;
            String displayName = uri.getQueryParameter("displayName");
            for (String col : projection) {
                if ("_display_name".equals(col)) {
                    cols[i] = "_display_name";
                    values[i++] = (displayName != null && !displayName.isEmpty())
                            ? displayName
                            : (file != null ? file.getName() : "file");
                } else if ("_size".equals(col)) {
                    cols[i] = "_size";
                    values[i++] = file != null ? Long.valueOf(file.length()) : Long.valueOf(0L);
                }
            }
            String[] finalCols = new String[i];
            Object[] finalVals = new Object[i];
            System.arraycopy(cols, 0, finalCols, 0, i);
            System.arraycopy(values, 0, finalVals, 0, i);
            MatrixCursor cursor = new MatrixCursor(finalCols, 1);
            cursor.addRow(finalVals);
            return cursor;
        } catch (Throwable t) {
            Log.w(TAG, "FileProvider.query fallback error", t);
            return new MatrixCursor(new String[0]);
        }
    }

    private static void handleGenericActivityOnCreate(Object[] args) {
        if (args.length < 1 || !(args[0] instanceof Activity)) return;
        Activity act = (Activity) args[0];
        Bundle savedState = (args.length > 1 && args[1] instanceof Bundle) ? (Bundle) args[1] : null;
        for (Method m : act.getClass().getMethods()) {
            if ("onCreate$001".equals(m.getName())) {
                Class<?>[] pts = m.getParameterTypes();
                if (pts.length == 2 && pts[0].isAssignableFrom(act.getClass()) && pts[1] == Bundle.class) {
                    try {
                        m.invoke(null, act, savedState);
                        return;
                    } catch (Throwable ignored) {}
                }
            }
        }
    }

    private static void callZeroArgSynthetic(Object[] args, String methodName, Class<?> baseType) {
        if (args.length < 1 || args[0] == null) return;
        Object target = args[0];
        try {
            Method m = target.getClass().getMethod(methodName, baseType);
            m.invoke(null, target);
        } catch (Throwable ignored) {}
    }
}

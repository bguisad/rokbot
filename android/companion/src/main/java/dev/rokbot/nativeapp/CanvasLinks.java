package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.IBinder;
import android.util.Log;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Routes RokBot canvas links (`<host>/canvas/app/<id>`) to CanvasActivity instead of the browser.
 *
 * The official app opens chat links two ways: a Custom Tab through expo-web-browser's
 * BrowserProxyActivity, or a plain ACTION_VIEW (React Native Linking). The first is caught when the
 * proxy activity is created; the second by wrapping the React activity's Instrumentation, whose
 * execStartActivity every Activity.startActivity goes through. The wrapper is installed only when
 * it can delegate to the original (checked up front), so on a platform that hides those members
 * links keep opening exactly as before. The public link (`/canvas/<token>`) is never rerouted.
 */
final class CanvasLinks {
    private static final String TAG = "RokBotCanvasLinks";
    static final String EXTRA_ALLOW_EXTERNAL = "dev.rokbot.nativeapp.ALLOW_EXTERNAL";
    private static final String BROWSER_PROXY = "expo.modules.webbrowser.BrowserProxyActivity";
    private static final String EXTRA_BROWSER_URL = "expo.modules.webbrowser.EXTRA_URL";

    private CanvasLinks() {}

    static void open(Context from, String canvasId, String title) {
        if (!CanvasModel.isCanvasId(canvasId) || from == null) return;
        Intent i = new Intent(from, CanvasActivity.class);
        i.putExtra(CanvasActivity.EXTRA_CANVAS_ID, canvasId);
        if (title != null) i.putExtra(CanvasActivity.EXTRA_TITLE, title);
        if (!(from instanceof Activity)) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        from.startActivity(i);
    }

    /** The canvas id an implicit VIEW intent would send to the browser, or null. */
    static String canvasIdOf(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getComponent() != null) return null;
        if (intent.getBooleanExtra(EXTRA_ALLOW_EXTERNAL, false)) return null;
        Uri data = intent.getData();
        return data == null ? null : CanvasModel.appLinkId(data.toString());
    }

    /** expo-web-browser asked for a Custom Tab with a canvas link: open the canvas instead. */
    static boolean interceptBrowserProxy(Activity activity) {
        if (activity == null || !BROWSER_PROXY.equals(activity.getClass().getName())) return false;
        Intent intent = activity.getIntent();
        String url = intent != null ? intent.getStringExtra(EXTRA_BROWSER_URL) : null;
        if (url == null && intent != null) url = intent.getDataString();
        String id = CanvasModel.appLinkId(url);
        if (id == null) return false;
        intent.removeExtra(EXTRA_BROWSER_URL);
        intent.setData(null);
        try { open(activity, id, null); } catch (Throwable t) { Log.w(TAG, "open failed", t); }
        activity.setResult(Activity.RESULT_CANCELED);
        activity.finish();
        return true;
    }

    private static Field sInstrumentationField;
    private static Method sExecStartActivity;
    private static boolean sResolved;

    private static synchronized boolean resolve() {
        if (sResolved) return sInstrumentationField != null && sExecStartActivity != null;
        sResolved = true;
        try {
            Method exec = Instrumentation.class.getDeclaredMethod("execStartActivity",
                    Context.class, IBinder.class, IBinder.class, Activity.class, Intent.class, int.class, Bundle.class);
            exec.setAccessible(true);
            Field field = Activity.class.getDeclaredField("mInstrumentation");
            field.setAccessible(true);
            sExecStartActivity = exec;
            sInstrumentationField = field;
            return true;
        } catch (Throwable t) {
            Log.i(TAG, "canvas link routing for ACTION_VIEW unavailable: " + t.getClass().getSimpleName());
            return false;
        }
    }

    /** Wraps the activity's Instrumentation once; a no-op when the platform does not allow it. */
    static void install(Activity activity) {
        if (activity == null || !resolve()) return;
        try {
            Object current = sInstrumentationField.get(activity);
            if (!(current instanceof Instrumentation) || current instanceof Router) return;
            sInstrumentationField.set(activity, new Router((Instrumentation) current));
        } catch (Throwable t) {
            Log.w(TAG, "install failed: " + t.getClass().getSimpleName());
        }
    }

    static final class Router extends Instrumentation {
        final Instrumentation base;

        Router(Instrumentation base) { this.base = base; }

        /** Hidden framework method (Activity.startActivityForResult calls it); same signature, so this overrides it. */
        public ActivityResult execStartActivity(Context who, IBinder contextThread, IBinder token, Activity target,
                                                Intent intent, int requestCode, Bundle options) {
            String id = canvasIdOf(intent);
            if (id != null && who != null) {
                try {
                    open(who, id, null);
                    return null;
                } catch (Throwable t) {
                    Log.w(TAG, "canvas open failed, falling back to the browser", t);
                }
            }
            try {
                return (ActivityResult) sExecStartActivity.invoke(base, who, contextThread, token, target, intent, requestCode, options);
            } catch (InvocationTargetException e) {
                Throwable cause = e.getCause();
                if (cause instanceof RuntimeException) throw (RuntimeException) cause;
                if (cause instanceof Error) throw (Error) cause;
                throw new RuntimeException(cause);
            } catch (IllegalAccessException e) {
                throw new RuntimeException(e);
            }
        }
    }
}

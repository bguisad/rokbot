package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.IntentSender;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Bundle;
import android.os.Parcelable;
import android.os.ResultReceiver;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.Serializable;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import kotlin.jvm.functions.Function0;
import kotlin.jvm.functions.Function1;

/**
 * Java ports of official-APK lifecycle bodies that Google Pairip moved into its encrypted VM.
 *
 * <p>The pinned 1.26.0 (3212) build virtualizes these methods into {@code VMRunner.invoke(id, args)}.
 * Pairip leaves every external call of the original body behind as a public static {@code name$NNN}
 * trampoline on the same class, so each port below replays the upstream source (expo-video sdk-57,
 * expo-web-browser sdk-57, CanHub cropper, Play Core, Braze) through those trampolines and the few
 * R8-renamed members it needs. Every port verifies the concrete class name first and fails closed:
 * on any reflection error the Activity is finished instead of being left half-initialised, which is
 * what used to crash FullscreenPlayerActivity.onPostCreate (lateinit mContentView).</p>
 */
final class PairipActivityPorts {
    private static final String TAG = "RokBotPairipBridge";

    static final String FULLSCREEN_PLAYER = "expo.modules.video.FullscreenPlayerActivity";
    static final String BROWSER_PROXY = "expo.modules.webbrowser.BrowserProxyActivity";
    static final String CROP_IMAGE = "com.canhub.cropper.CropImageActivity";
    static final String PLAY_CORE_DIALOG = "com.google.android.play.core.common.PlayCoreDialogWrapperActivity";
    static final String BRAZE_WEBVIEW = "com.braze.ui.BrazeWebViewActivity";

    // R8 names in the pinned 1.26.0 (3212) dex.
    private static final String VIDEO_MANAGER = "Bj.h";               // expo.modules.video.managers.VideoManager
    private static final String ORIENTATION_HELPER = "Fj.c";          // FullscreenActivityOrientationHelper
    private static final String PIP_UTILS = "Fj.i";                   // expo.modules.video.utils.PictureInPictureUtils
    private static final String CROP_BINDING = "H7.a";                // CropImageActivityBinding
    // Resource ids compiled into the official dex; only used if name lookup fails.
    private static final int FALLBACK_FULLSCREEN_LAYOUT = 0x7f0d0055;
    private static final int FALLBACK_ENCLOSING_LAYOUT = 0x7f0a0139;
    private static final int FALLBACK_PLAYER_VIEW = 0x7f0a0250;

    private PairipActivityPorts() {}

    // ---------------------------------------------------------------- helpers

    static Activity activityArg(Object[] args, String expectedClass) {
        if (args == null || args.length < 1 || !(args[0] instanceof Activity)) return null;
        Activity act = (Activity) args[0];
        return isInstanceOf(act, expectedClass) ? act : null;
    }

    static Bundle bundleArg(Object[] args) {
        return (args != null && args.length > 1 && args[1] instanceof Bundle) ? (Bundle) args[1] : null;
    }

    private static boolean isInstanceOf(Object obj, String className) {
        for (Class<?> c = obj != null ? obj.getClass() : null; c != null; c = c.getSuperclass()) {
            if (className.equals(c.getName())) return true;
        }
        return false;
    }

    /** Finds a method by name/arity on {@code cls} or its superclasses (public or declared). */
    private static Method findMethod(Class<?> cls, String name, int arity) {
        for (Class<?> c = cls; c != null; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (m.getName().equals(name) && m.getParameterTypes().length == arity) {
                    m.setAccessible(true);
                    return m;
                }
            }
        }
        throw new IllegalStateException("missing method " + cls.getName() + "." + name + "/" + arity);
    }

    private static Object callStatic(Class<?> cls, String name, Object... args) throws Exception {
        return findMethod(cls, name, args.length).invoke(null, args);
    }

    private static Object callVirtual(Object target, String name, Object... args) throws Exception {
        return findMethod(target.getClass(), name, args.length).invoke(target, args);
    }

    private static Field findField(Class<?> cls, String name) throws NoSuchFieldException {
        for (Class<?> c = cls; c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f;
            } catch (NoSuchFieldException ignored) {}
        }
        throw new NoSuchFieldException(cls.getName() + "." + name);
    }

    private static Object getField(Object target, Class<?> owner, String name) throws Exception {
        return findField(owner, name).get(target);
    }

    private static void setField(Object target, Class<?> owner, String name, Object value) throws Exception {
        findField(owner, name).set(target, value);
    }

    private static Class<?> ownerClass(Object target, String className) {
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            if (className.equals(c.getName())) return c;
        }
        throw new IllegalStateException("not a " + className);
    }

    private static int resId(Context ctx, String name, String type, int fallback) {
        try {
            int id = ctx.getResources().getIdentifier(name, type, ctx.getPackageName());
            if (id == 0) id = ctx.getResources().getIdentifier(name, type, "ai.x.grok.bot");
            return id != 0 ? id : fallback;
        } catch (Throwable ignored) {
            return fallback;
        }
    }

    /** Super.onCreate via the pairip trampoline (onCreate$NNN wraps invoke-super). */
    private static void superOnCreate(Activity act, Class<?> owner, String trampoline, Bundle saved) throws Exception {
        findMethod(owner, trampoline, 2).invoke(null, act, saved);
    }

    private static void finishQuietly(Activity act, String why, Throwable t) {
        Log.e(TAG, act.getClass().getName() + ": " + why, t);
        try {
            if (!act.isFinishing()) act.finish();
        } catch (Throwable ignored) {}
    }

    // ------------------------------------------------- expo-video fullscreen

    /** FullscreenPlayerActivity.onCreate — upstream expo-video sdk-57 FullscreenPlayerActivity.kt:42-95. */
    static void fullscreenPlayerOnCreate(Activity act, Bundle saved) throws Exception {
        Class<?> fpa = ownerClass(act, FULLSCREEN_PLAYER);
        superOnCreate(act, fpa, "onCreate$001", saved);
        Class<?> vmCls = Class.forName(VIDEO_MANAGER, true, fpa.getClassLoader());
        Object videoManager = vmCls.getField("a").get(null);

        final Object videoView;
        final Object options;
        final String videoViewId;
        try {
            Intent intent = act.getIntent();
            videoViewId = intent != null ? intent.getStringExtra("player_uuid") : null;
            if (videoViewId == null) throw new IllegalStateException("FullScreenVideoViewNotFoundException");
            setField(act, fpa, "b", videoViewId);
            Serializable opts = intent.getSerializableExtra("fullscreen_options");
            if (opts == null) throw new IllegalStateException("FullScreenOptionsNotFoundException");
            options = opts;
            setField(act, fpa, "i", options);
            videoView = callStatic(fpa, "f$007", videoManager, videoViewId);
            if (videoView == null) throw new IllegalStateException("FullScreenVideoViewNotFoundException");
            setField(act, fpa, "e", videoView);

            try {
                Class<?> helperCls = Class.forName(ORIENTATION_HELPER, true, fpa.getClassLoader());
                Function0<Object> onShouldAutoExit = () -> {
                    act.finish();
                    return null;
                };
                Function0<Object> onShouldReleaseOrientation = () -> {
                    act.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                    return null;
                };
                Object helper = null;
                for (java.lang.reflect.Constructor<?> ctor : helperCls.getDeclaredConstructors()) {
                    if (ctor.getParameterTypes().length == 4) {
                        ctor.setAccessible(true);
                        helper = ctor.newInstance(act, options, onShouldAutoExit, onShouldReleaseOrientation);
                        break;
                    }
                }
                if (helper != null) {
                    setField(act, fpa, "j", helper);
                    callStatic(fpa, "l$008", helper);
                }
            } catch (Throwable t) {
                // Orientation auto-exit is optional; fullscreen still works without it.
                Log.w(TAG, "FullscreenPlayerActivity orientation helper unavailable", t);
            }
        } catch (Throwable t) {
            // Upstream: Log.e("ExpoVideo", ...) then finish(); finishing inside onCreate skips onPostCreate.
            finishQuietly(act, "fullscreen setup failed", t);
            return;
        }

        act.setContentView(resId(act, "fullscreen_player_activity", "layout", FALLBACK_FULLSCREEN_LAYOUT));
        View content = act.findViewById(resId(act, "enclosing_layout", "id", FALLBACK_ENCLOSING_LAYOUT));
        View playerView = act.findViewById(resId(act, "player_view", "id", FALLBACK_PLAYER_VIEW));
        if (content == null || playerView == null) {
            finishQuietly(act, "fullscreen layout views missing", null);
            return;
        }
        setField(act, fpa, "a", content);
        setField(act, fpa, "d", playerView);

        Object orientation = callStatic(fpa, "getOrientation$012", options);
        int requested = (Integer) callStatic(fpa, "toActivityOrientation$013", orientation);
        act.setRequestedOrientation(requested);

        Object videoPlayer = callStatic(fpa, "getVideoPlayer$015", videoView);
        setField(act, fpa, "c", videoPlayer);
        Object exo = videoPlayer != null ? callStatic(fpa, "p3$016", videoPlayer) : null;
        if (exo != null) {
            Object oldPlayerView = callStatic(fpa, "getPlayerView$017", videoView);
            // PlayerView.switchTargetView(player, oldView, newView) is R8-renamed to U.
            callStatic(playerView.getClass(), "U", exo, oldPlayerView, playerView);
            callStatic(fpa, "B3$018", videoPlayer); // hasBeenDisconnectedFromVideoView()
        }

        callStatic(fpa, "o$019", videoManager, videoViewId, act);  // registerFullscreenPlayerActivity
        callStatic(fpa, "p$020", videoManager, act);               // registerListener

        try {
            Object player = callStatic(fpa, "getPlayer$021", playerView);
            if (player != null) {
                Class<?> pip = Class.forName(PIP_UTILS, true, fpa.getClassLoader());
                Object videoSize = callStatic(fpa, "C0$022", player);
                int w = (Integer) callStatic(fpa, "getWidth$023", playerView);
                int h = (Integer) callStatic(fpa, "getHeight$024", playerView);
                Object contentFit = callStatic(fpa, "getContentFit$025", videoView);
                Object aspect = findMethod(pip, "h", 4).invoke(null, videoSize, w, h, contentFit);
                boolean autoPip = (Boolean) callStatic(fpa, "getAutoEnterPiP$026", videoView);
                findMethod(pip, "c", 3).invoke(null, act, autoPip, aspect);
            }
        } catch (Throwable t) {
            Log.w(TAG, "FullscreenPlayerActivity PiP params skipped", t);
        }
    }

    /** FullscreenPlayerActivity.onPause — upstream :152-162. */
    static void fullscreenPlayerOnPause(Activity act) throws Exception {
        Class<?> fpa = ownerClass(act, FULLSCREEN_PLAYER);
        try {
            Object videoPlayer = getField(act, fpa, "c");
            boolean didFinish = (Boolean) getField(act, fpa, "f");
            if (videoPlayer != null && !(Boolean) callStatic(fpa, "y3$001", videoPlayer) && !didFinish) {
                Object exo = callStatic(fpa, "p3$002", videoPlayer);
                boolean playing = exo != null && (Boolean) callStatic(fpa, "l$003", exo);
                setField(act, fpa, "g", playing);
                if (playing) {
                    Object playerView = getField(act, fpa, "d");
                    if (playerView != null) callStatic(fpa, "setUseController$004", playerView, false);
                    callStatic(fpa, "pause$006", callStatic(fpa, "p3$005", videoPlayer));
                }
            }
            Object helper = getField(act, fpa, "j");
            if (helper != null) callStatic(fpa, "m$008", helper);
        } finally {
            callStatic(fpa, "onPause$009", act);
        }
    }

    /** FullscreenPlayerActivity.onDestroy — upstream :175-192. */
    static void fullscreenPlayerOnDestroy(Activity act) throws Exception {
        Class<?> fpa = ownerClass(act, FULLSCREEN_PLAYER);
        callStatic(fpa, "onDestroy$001", act);
        Object listener = getField(act, fpa, "k");
        if (listener != null) {
            Object cm = callStatic(fpa, "getSystemService$002", act, Context.CAPTIONING_SERVICE);
            if (cm != null) callStatic(fpa, "removeCaptioningChangeListener$003", cm, listener);
            setField(act, fpa, "k", null);
        }
        Object videoView = getField(act, fpa, "e");
        if (videoView != null) callStatic(fpa, "exitFullscreen$004", videoView);
        Class<?> vmCls = Class.forName(VIDEO_MANAGER, true, fpa.getClassLoader());
        Object videoManager = vmCls.getField("a").get(null);
        callStatic(fpa, "y$005", videoManager, act);                         // unregisterListener
        Object id = getField(act, fpa, "b");
        if (id != null) callStatic(fpa, "x$006", videoManager, id);         // unregisterFullscreenPlayerActivity
        Object helper = getField(act, fpa, "j");
        if (helper != null) callStatic(fpa, "m$007", helper);
    }

    // ------------------------------------------------ expo-web-browser proxy

    /** BrowserProxyActivity.onCreate — upstream expo-web-browser BrowserProxyActivity.kt:25-53. */
    static void browserProxyOnCreate(Activity act, Bundle saved) throws Exception {
        Class<?> bpa = ownerClass(act, BROWSER_PROXY);
        superOnCreate(act, bpa, "onCreate$001", saved);
        if (saved != null) return;
        try {
            Intent intent = act.getIntent();
            String url = intent != null ? intent.getStringExtra("expo.modules.webbrowser.EXTRA_URL") : null;
            Parcelable data = intent != null
                    ? intent.getParcelableExtra("expo.modules.webbrowser.EXTRA_CUSTOM_TABS_INTENT_DATA")
                    : null;
            if (url == null || !(data instanceof Intent)) {
                act.finish();
                return;
            }
            Intent tabsData = (Intent) data;
            // androidx.browser CustomTabsIntent.Builder (R8: androidx.browser.customtabs.d$b).
            Class<?> builderCls = Class.forName("androidx.browser.customtabs.d$b", true, bpa.getClassLoader());
            Object builder = builderCls.getConstructor().newInstance();
            Object tabsIntent = callStatic(bpa, "a$007", builder);                 // build()
            Intent launch = (Intent) getField(tabsIntent, tabsIntent.getClass(), "a"); // CustomTabsIntent.intent
            Bundle extras = tabsData.getExtras();
            if (extras != null) launch.putExtras(extras);
            if (tabsData.getPackage() != null) launch.setPackage(tabsData.getPackage());
            callStatic(bpa, "a$012", tabsIntent, act, Uri.parse(url));           // launchUrl(this, uri)
            // companion `instance = WeakReference(this)`; field a = hasLaunchedCustomTab.
            Field instance = findField(bpa, "d");
            instance.set(null, new java.lang.ref.WeakReference<>(act));
            setField(act, bpa, "a", true);
        } catch (Throwable t) {
            finishQuietly(act, "custom tab launch failed", t);
        }
    }

    // ------------------------------------------------------- CanHub cropper

    /** CropImageActivity.onCreate — upstream CanHub CropImageActivity.kt:66-102. */
    static void cropImageOnCreate(Activity act, Bundle saved) throws Exception {
        Class<?> cia = ownerClass(act, CROP_IMAGE);
        superOnCreate(act, cia, "onCreate$001", saved);
        try {
            Class<?> bindingCls = Class.forName(CROP_BINDING, true, cia.getClassLoader());
            Object binding = findMethod(bindingCls, "c", 1).invoke(null, act.getLayoutInflater());
            View cropView = (View) callStatic(cia, "b$003", binding);   // binding.cropImageView (also the root)
            callStatic(cia, "setContentView$004", act, cropView);
            callStatic(cia, "s0$005", act, cropView);                 // setCropImageView (virtual)
            setField(act, cia, "f", binding);

            Intent intent = act.getIntent();
            Bundle bundle = intent != null ? intent.getBundleExtra("CROP_IMAGE_EXTRA_BUNDLE") : null;
            Uri source = bundle != null ? (Uri) bundle.getParcelable("CROP_IMAGE_EXTRA_SOURCE") : null;
            Object options = bundle != null ? bundle.getParcelable("CROP_IMAGE_EXTRA_OPTIONS") : null;
            if (options == null) {
                // Upstream falls back to CropImageOptions(); its only constructor here is the 70-arg
                // R8 one, so cancel instead (expo-image-picker always passes options).
                act.setResult(Activity.RESULT_CANCELED);
                finishQuietly(act, "crop options missing", null);
                return;
            }
            setField(act, cia, "c", source);
            setField(act, cia, "d", options);

            if (saved == null) {
                if (source == null || Uri.EMPTY.equals(source)) {
                    Class<?> optCls = options.getClass();
                    boolean chooser = findField(optCls, "B0").getBoolean(options);
                    boolean gallery = findField(optCls, "a").getBoolean(options);
                    boolean camera = findField(optCls, "b").getBoolean(options);
                    if (chooser) {
                        callStatic(cia, "z0$011", act);
                    } else if (gallery && camera) {
                        Function1<Object, Object> openSource = src -> {
                            try {
                                if (String.valueOf(src).toUpperCase(java.util.Locale.US).contains("CAMERA")) {
                                    callStatic(cia, "o0$014", act);
                                } else {
                                    callStatic(cia, "a$013", getField(act, cia, "h"), "image/*");
                                }
                            } catch (Throwable t) {
                                finishQuietly(act, "crop source launch failed", t);
                            }
                            return null;
                        };
                        callStatic(cia, "w0$012", act, openSource);
                    } else if (gallery) {
                        callStatic(cia, "a$013", getField(act, cia, "h"), "image/*");
                    } else if (camera) {
                        callStatic(cia, "o0$014", act);
                    } else {
                        act.finish();
                    }
                } else {
                    callStatic(cia, "setImageUriAsync$010", cropView, source);
                }
            } else {
                String tmp = saved.getString("bundle_key_tmp_uri");
                if (tmp != null) setField(act, cia, "g", Uri.parse(tmp));
            }
            callStatic(cia, "t0$017", act);  // setCustomizations()
            // The upstream back callback only does setResult(CANCELED)+finish(), which is the default.
        } catch (Throwable t) {
            act.setResult(Activity.RESULT_CANCELED);
            finishQuietly(act, "crop setup failed", t);
        }
    }

    // ------------------------------------------------------------ Play Core

    /** PlayCoreDialogWrapperActivity.onCreate — Play Core common, replayed through its $001..$019 stubs. */
    static void playCoreDialogOnCreate(Activity act, Bundle saved) throws Exception {
        Class<?> pcd = ownerClass(act, PLAY_CORE_DIALOG);
        Intent fillIn = null;
        Intent intent = act.getIntent();
        int flags = intent != null ? intent.getIntExtra("window_flags", 0) : 0;
        if (flags != 0) {
            Window w = act.getWindow();
            if (w != null) w.getDecorView().setSystemUiVisibility(flags);
            fillIn = new Intent();
            fillIn.putExtra("window_flags", flags);
        }
        superOnCreate(act, pcd, "onCreate$007", saved);
        if (saved != null) {
            setField(act, pcd, "a", saved.getParcelable("result_receiver"));
            return;
        }
        Object receiver = intent != null ? intent.getParcelableExtra("result_receiver") : null;
        setField(act, pcd, "a", receiver);
        Bundle extras = intent != null ? intent.getExtras() : null;
        Object pending = extras != null ? extras.get("confirmation_intent") : null;
        if (!(pending instanceof PendingIntent)) {
            sendPlayCoreCancel(receiver);
            act.finish();
            return;
        }
        try {
            IntentSender sender = ((PendingIntent) pending).getIntentSender();
            act.startIntentSenderForResult(sender, 0, fillIn, 0, 0, 0);
        } catch (IntentSender.SendIntentException e) {
            sendPlayCoreCancel(receiver);
            act.finish();
        }
    }

    private static void sendPlayCoreCancel(Object receiver) {
        if (receiver instanceof ResultReceiver) {
            ((ResultReceiver) receiver).send(3, new Bundle());
        }
    }

    // ---------------------------------------------------------------- Braze

    /** BrazeWebViewActivity.onCreate — Braze UI, replayed through its $001..$027 stubs. */
    static void brazeWebViewOnCreate(Activity act, Bundle saved) throws Exception {
        Class<?> bwa = ownerClass(act, BRAZE_WEBVIEW);
        superOnCreate(act, bwa, "onCreate$001", saved);
        try {
            Window window = act.getWindow();
            window.setFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                    WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
            try {
                Class<?> provider = Class.forName("com.braze.d", true, bwa.getClassLoader());
                Object config = callStatic(bwa, "d$004", provider.getField("a").get(null), act);
                if ((Boolean) callStatic(bwa, "getShouldUseWindowFlagSecureInActivities$005", config)) {
                    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
                }
            } catch (Throwable ignored) {}
            act.setContentView(resId(act, "com_braze_webview_activity", "layout", 0));
            WebView webView = (WebView) act.findViewById(resId(act, "com_braze_webview_activity_webview", "id", 0));
            if (webView == null) throw new IllegalStateException("Braze webview missing");
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            WebSettings s = webView.getSettings();
            s.setAllowFileAccess(false);
            s.setBuiltInZoomControls(true);
            s.setJavaScriptEnabled(true);
            s.setUseWideViewPort(true);
            s.setLoadWithOverviewMode(true);
            s.setDisplayZoomControls(false);
            s.setDomStorageEnabled(true);
            webView.setWebChromeClient((WebChromeClient) callStatic(bwa, "createWebChromeClient$020", act));
            webView.setWebViewClient((WebViewClient) callStatic(bwa, "createWebViewClient$022", act));
            Intent intent = act.getIntent();
            Bundle extras = intent != null ? intent.getExtras() : null;
            String url = extras != null ? extras.getString("url") : null;
            if (url != null) webView.loadUrl(url);
        } catch (Throwable t) {
            finishQuietly(act, "Error creating BrazeWebViewActivity. Webview will not display.", t);
        }
    }

    // ------------------------------------------- not ported: cancel cleanly

    /**
     * Billing proxies and Google Sign-In hub: RokBot never starts Play purchases or Google sign-in
     * (no Play services account flow on a self-hosted build). Instead of leaving an invisible
     * half-created Activity on top of the app, report RESULT_CANCELED and close it.
     */
    static void cancelUnsupportedOnCreate(Activity act, Bundle saved, String trampoline) {
        try {
            superOnCreate(act, act.getClass(), trampoline, saved);
        } catch (Throwable t) {
            Log.w(TAG, act.getClass().getName() + " super.onCreate failed", t);
        }
        try {
            act.setResult(Activity.RESULT_CANCELED);
        } catch (Throwable ignored) {}
        finishQuietly(act, "unsupported Pairip-virtualized flow; cancelled", null);
    }
}

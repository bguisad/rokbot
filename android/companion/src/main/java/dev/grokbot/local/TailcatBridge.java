package dev.grokbot.local;

/**
 * JNI bridge matching Go mobile native libraries libgroktailcat.so and libgroktailcatjni.so.
 * Package and class name MUST stay dev.grokbot.local.TailcatBridge for JNI symbol lookup.
 */
public final class TailcatBridge {
    private static final boolean sLoaded;
    private static final String sLoadError;

    static {
        boolean ok = false;
        String err = null;
        try {
            System.loadLibrary("groktailcat");
            System.loadLibrary("groktailcatjni");
            ok = true;
        } catch (Throwable t) {
            err = t.getClass().getSimpleName() + (t.getMessage() != null ? ": " + t.getMessage() : "");
        }
        sLoaded = ok;
        sLoadError = err;
    }

    private TailcatBridge() {}

    public static boolean isAvailable() {
        return sLoaded;
    }

    public static String getLoadError() {
        return sLoadError;
    }

    public static native String nativeIdentity();
    public static native String nativeStart(String configJson);
    public static native String nativeStatus(int handle);
    public static native void nativeStop(int handle);

    public static String safeIdentity() {
        if (!sLoaded) throw new IllegalStateException("Tailcat JNI unavailable: " + sLoadError);
        return nativeIdentity();
    }

    public static String safeStart(String configJson) {
        if (!sLoaded) throw new IllegalStateException("Tailcat JNI unavailable: " + sLoadError);
        return nativeStart(configJson);
    }

    public static String safeStatus(int handle) {
        if (!sLoaded) return "{}";
        try {
            String raw = nativeStatus(handle);
            return raw != null ? raw : "{}";
        } catch (Throwable ignored) {
            return "{}";
        }
    }

    public static void safeStop(int handle) {
        if (!sLoaded || handle <= 0) return;
        try {
            nativeStop(handle);
        } catch (Throwable ignored) {}
    }
}

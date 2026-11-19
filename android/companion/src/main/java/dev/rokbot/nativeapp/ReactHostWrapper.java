package dev.rokbot.nativeapp;

import android.app.Application;
import com.facebook.react.ReactNativeHost;
import com.facebook.react.ReactPackage;
import java.io.File;
import java.lang.reflect.Method;
import java.util.Collections;
import java.util.List;

final class ReactHostWrapper {
    private ReactHostWrapper() {}

    @SuppressWarnings("unchecked")
    static <T> T invokeOriginalHostMethod(ReactNativeHost original, String name, T fallback) {
        if (original == null) return fallback;
        Class<?> cls = original.getClass();
        while (cls != null && cls != Object.class) {
            try {
                Method m = cls.getDeclaredMethod(name);
                m.setAccessible(true);
                return (T) m.invoke(original);
            } catch (NoSuchMethodException ignored) {
                cls = cls.getSuperclass();
            } catch (Throwable ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    static ReactNativeHost wrap(final Application app, final ReactNativeHost original) {
        return new ReactNativeHost(app) {
            @Override
            public boolean getUseDeveloperSupport() {
                return original != null && original.getUseDeveloperSupport();
            }

            @Override
            protected List<ReactPackage> getPackages() {
                return invokeOriginalHostMethod(original, "getPackages", Collections.emptyList());
            }

            @Override
            protected String getJSMainModuleName() {
                return invokeOriginalHostMethod(original, "getJSMainModuleName", "index");
            }

            @Override
            protected boolean isNewArchEnabled() {
                Boolean v = invokeOriginalHostMethod(original, "isNewArchEnabled", Boolean.FALSE);
                return v != null && v;
            }

            @Override
            protected Boolean isHermesEnabled() {
                return invokeOriginalHostMethod(original, "isHermesEnabled", Boolean.TRUE);
            }

            @Override
            protected String getJSBundleFile() {
                if (Storage.isPaired(app)) {
                    File pairedBundle = RokBotBootstrap.ensurePairedBundleFile(app);
                    if (pairedBundle != null && pairedBundle.exists()) {
                        return pairedBundle.getAbsolutePath();
                    }
                } else {
                    File unpairedBundle = RokBotBootstrap.ensureUnpairedBundleFile(app);
                    if (unpairedBundle != null && unpairedBundle.exists()) {
                        return unpairedBundle.getAbsolutePath();
                    }
                }
                return invokeOriginalHostMethod(original, "getJSBundleFile", null);
            }

            @Override
            protected String getBundleAssetName() {
                String origAsset = invokeOriginalHostMethod(original, "getBundleAssetName", "index.android.bundle");
                return origAsset != null ? origAsset : "index.android.bundle";
            }
        };
    }
}

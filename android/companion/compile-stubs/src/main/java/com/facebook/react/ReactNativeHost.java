package com.facebook.react;

import android.app.Application;
import java.util.Collections;
import java.util.List;

public abstract class ReactNativeHost {
    private final Application mApplication;

    protected ReactNativeHost(Application application) {
        mApplication = application;
    }

    public Application getApplication() {
        return mApplication;
    }

    public boolean getUseDeveloperSupport() {
        return false;
    }

    protected List<ReactPackage> getPackages() {
        return Collections.emptyList();
    }

    protected String getJSMainModuleName() {
        return "index";
    }

    protected String getJSBundleFile() {
        return null;
    }

    protected String getBundleAssetName() {
        return "index.android.bundle";
    }

    protected boolean isNewArchEnabled() {
        return false;
    }

    protected Boolean isHermesEnabled() {
        return Boolean.TRUE;
    }
}

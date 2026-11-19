package dev.rokbot.nativeapp;

import android.content.Context;
import co.anysphere.sand.MainApplication;
import com.facebook.react.ReactNativeHost;

public class RokBotSandApplication extends MainApplication {
    private ReactNativeHost mCustomReactNativeHost;

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        RokBotBootstrap.init(this);
        RokBotBootstrap.onAppCreate(this);
        RokBotBootstrap.hookReactHost(this);
    }

    @Override
    public ReactNativeHost getReactNativeHost() {
        if (mCustomReactNativeHost == null) {
            mCustomReactNativeHost = ReactHostWrapper.wrap(this, super.getReactNativeHost());
        }
        return mCustomReactNativeHost;
    }
}

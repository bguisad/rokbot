package dev.grokbot.nativeapp;

import android.content.Context;
import co.anysphere.sand.MainApplication;
import com.facebook.react.ReactNativeHost;

public class GrokBotSandApplication extends MainApplication {
    private ReactNativeHost mCustomReactNativeHost;

    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        GrokBotBootstrap.init(this);
        GrokBotBootstrap.onAppCreate(this);
        GrokBotBootstrap.hookReactHost(this);
    }

    @Override
    public ReactNativeHost getReactNativeHost() {
        if (mCustomReactNativeHost == null) {
            mCustomReactNativeHost = ReactHostWrapper.wrap(this, super.getReactNativeHost());
        }
        return mCustomReactNativeHost;
    }
}

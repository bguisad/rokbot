package dev.rokbot.nativeapp;

import android.content.Context;
import ai.x.grok.bot.MainApplication;

public class RokBotApplication extends MainApplication {
    @Override
    protected void attachBaseContext(Context base) {
        PairipVmBridge.install(base);
        super.attachBaseContext(base);
    }

    @Override
    public void onCreate() {
        PairipVmBridge.install(this);
        R8OkHttpHook.install(this);
        super.onCreate();
        RokBotBootstrap.init(this);
        RokBotBootstrap.onAppCreate(this);
        RokBotBootstrap.hookReactHost(this);
    }
}

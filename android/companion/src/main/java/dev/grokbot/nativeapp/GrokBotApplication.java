package dev.grokbot.nativeapp;

import android.content.Context;
import ai.x.grok.bot.MainApplication;

public class GrokBotApplication extends MainApplication {
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
        GrokBotBootstrap.init(this);
        GrokBotBootstrap.onAppCreate(this);
        GrokBotBootstrap.hookReactHost(this);
    }
}

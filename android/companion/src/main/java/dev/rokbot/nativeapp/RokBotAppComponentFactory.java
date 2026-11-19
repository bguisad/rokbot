package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.AppComponentFactory;
import android.app.Application;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.ContentProvider;
import android.content.Intent;

/**
 * Early startup hook installed via android:appComponentFactory so the Pairip VM bridge
 * is active before Application.<init>, ContentProviders, or any Activity/Service runs.
 */
public class RokBotAppComponentFactory extends AppComponentFactory {
    static {
        PairipVmBridge.install();
    }

    public RokBotAppComponentFactory() {
        PairipVmBridge.install();
    }

    @Override
    public Application instantiateApplication(ClassLoader cl, String className)
            throws InstantiationException, IllegalAccessException, ClassNotFoundException {
        PairipVmBridge.install(cl);
        return super.instantiateApplication(cl, className);
    }

    @Override
    public Activity instantiateActivity(ClassLoader cl, String className, Intent intent)
            throws InstantiationException, IllegalAccessException, ClassNotFoundException {
        PairipVmBridge.install(cl);
        return super.instantiateActivity(cl, className, intent);
    }

    @Override
    public BroadcastReceiver instantiateReceiver(ClassLoader cl, String className, Intent intent)
            throws InstantiationException, IllegalAccessException, ClassNotFoundException {
        PairipVmBridge.install(cl);
        return super.instantiateReceiver(cl, className, intent);
    }

    @Override
    public Service instantiateService(ClassLoader cl, String className, Intent intent)
            throws InstantiationException, IllegalAccessException, ClassNotFoundException {
        PairipVmBridge.install();
        return super.instantiateService(cl, className, intent);
    }

    @Override
    public ContentProvider instantiateProvider(ClassLoader cl, String className)
            throws InstantiationException, IllegalAccessException, ClassNotFoundException {
        PairipVmBridge.install();
        return super.instantiateProvider(cl, className);
    }
}

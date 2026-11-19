package dev.rokbot.nativeapp;

import android.content.Context;
import com.facebook.react.modules.network.OkHttpClientFactory;
import com.facebook.react.modules.network.OkHttpClientProvider;
import okhttp3.OkHttpClient;

/**
 * Installs NetworkInterceptor on un-obfuscated RN OkHttpClientProvider (synthetic / debug targets).
 * Isolated from RokBotBootstrap so R8-obfuscated official APKs never resolve un-obfuscated okhttp3.* symbols eagerly.
 */
final class LegacyOkHttpHook {
    private LegacyOkHttpHook() {}

    static void install(Context context) {
        try {
            Class.forName("com.facebook.react.modules.network.OkHttpClientProvider");
            OkHttpClientProvider.setOkHttpClientFactory(new OkHttpClientFactory() {
                @Override
                public OkHttpClient createNewNetworkOrientedClient() {
                    OkHttpClient.Builder builder = OkHttpClientProvider.createClientBuilder();
                    builder.addInterceptor(new NetworkInterceptor(context));
                    return builder.build();
                }
            });
        } catch (Throwable ignored) {}
    }
}

package com.facebook.react.modules.network;

import okhttp3.OkHttpClient;

public class OkHttpClientProvider {
    private static OkHttpClientFactory sFactory;
    private static OkHttpClient sClient;

    public static void setOkHttpClientFactory(OkHttpClientFactory factory) {
        sFactory = factory;
    }

    public static OkHttpClient getOkHttpClient() {
        if (sClient == null) {
            sClient = createClient();
        }
        return sClient;
    }

    public static OkHttpClient createClient() {
        if (sFactory != null) {
            return sFactory.createNewNetworkOrientedClient();
        }
        return createClientBuilder().build();
    }

    public static OkHttpClient.Builder createClientBuilder() {
        return new OkHttpClient.Builder();
    }
}

package okhttp3;

import java.util.ArrayList;
import java.util.List;

public class OkHttpClient {
    private final List<Interceptor> mInterceptors;

    public OkHttpClient(Builder builder) {
        mInterceptors = new ArrayList<>(builder.mInterceptors);
    }

    public List<Interceptor> interceptors() {
        return mInterceptors;
    }

    public Builder newBuilder() {
        Builder b = new Builder();
        b.mInterceptors.addAll(mInterceptors);
        return b;
    }

    public static class Builder {
        final List<Interceptor> mInterceptors = new ArrayList<>();

        public Builder addInterceptor(Interceptor interceptor) {
            mInterceptors.add(interceptor);
            return this;
        }

        public OkHttpClient build() {
            return new OkHttpClient(this);
        }
    }
}

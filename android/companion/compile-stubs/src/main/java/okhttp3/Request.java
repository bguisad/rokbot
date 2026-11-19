package okhttp3;

import java.util.HashMap;
import java.util.Map;

public class Request {
    private final HttpUrl mUrl;
    private final String mMethod;
    private final Map<String, String> mHeaders;
    private final RequestBody mBody;

    public Request(Builder builder) {
        mUrl = builder.mUrl;
        mMethod = builder.mMethod;
        mHeaders = new HashMap<>(builder.mHeaders);
        mBody = builder.mBody;
    }

    public HttpUrl url() { return mUrl; }
    public String method() { return mMethod; }
    public String header(String name) {
        if (name == null) return null;
        String exact = mHeaders.get(name);
        if (exact != null) return exact;
        for (Map.Entry<String, String> e : mHeaders.entrySet()) {
            if (name.equalsIgnoreCase(e.getKey())) return e.getValue();
        }
        return null;
    }
    public Map<String, String> headers() { return mHeaders; }
    public RequestBody body() { return mBody; }
    public Builder newBuilder() { return new Builder(this); }

    public static class Builder {
        private HttpUrl mUrl;
        private String mMethod = "GET";
        private final Map<String, String> mHeaders = new HashMap<>();
        private RequestBody mBody;

        public Builder() {}

        public Builder(Request request) {
            mUrl = request.mUrl;
            mMethod = request.mMethod;
            mHeaders.putAll(request.mHeaders);
            mBody = request.mBody;
        }

        public Builder url(HttpUrl url) { mUrl = url; return this; }
        public Builder url(String url) { mUrl = HttpUrl.parse(url); return this; }
        public Builder header(String name, String value) {
            removeHeader(name);
            mHeaders.put(name, value);
            return this;
        }
        public Builder addHeader(String name, String value) { mHeaders.put(name, value); return this; }
        public Builder removeHeader(String name) {
            if (name != null) {
                java.util.Iterator<String> it = mHeaders.keySet().iterator();
                while (it.hasNext()) {
                    if (name.equalsIgnoreCase(it.next())) it.remove();
                }
            }
            return this;
        }
        public Builder method(String method, RequestBody body) { mMethod = method; mBody = body; return this; }
        public Request build() { return new Request(this); }
    }
}

package okhttp3;

import java.net.URI;

public class HttpUrl {
    private final String mUrl;
    private final String mScheme;
    private final String mHost;
    private final int mPort;
    private final String mEncodedPath;
    private final String mEncodedQuery;

    public HttpUrl(String url) {
        mUrl = url;
        URI uri = URI.create(url);
        mScheme = uri.getScheme() != null ? uri.getScheme() : "http";
        mHost = uri.getHost() != null ? uri.getHost() : "";
        int p = uri.getPort();
        mPort = p != -1 ? p : ("https".equalsIgnoreCase(mScheme) ? 443 : 80);
        mEncodedPath = uri.getRawPath() != null ? uri.getRawPath() : "/";
        mEncodedQuery = uri.getRawQuery();
    }

    public static HttpUrl parse(String url) {
        try {
            return new HttpUrl(url);
        } catch (Exception e) {
            return null;
        }
    }

    public String scheme() { return mScheme; }
    public String host() { return mHost; }
    public int port() { return mPort; }
    public String encodedPath() { return mEncodedPath; }
    public String encodedQuery() { return mEncodedQuery; }
    public String query() {
        try {
            return URI.create(mUrl).getQuery();
        } catch (Exception e) {
            return mEncodedQuery;
        }
    }

    public Builder newBuilder() {
        return new Builder(this);
    }

    @Override
    public String toString() {
        return mUrl;
    }

    public static class Builder {
        private String mScheme;
        private String mHost;
        private int mPort;
        private String mPath;

        public Builder(HttpUrl url) {
            mScheme = url.mScheme;
            mHost = url.mHost;
            mPort = url.mPort;
            mPath = url.mUrl;
        }

        public Builder scheme(String scheme) {
            mScheme = scheme;
            return this;
        }

        public Builder host(String host) {
            mHost = host;
            return this;
        }

        public Builder port(int port) {
            mPort = port;
            return this;
        }

        public Builder encodedPath(String encodedPath) {
            try {
                URI orig = URI.create(mPath);
                String q = orig.getRawQuery() != null ? "?" + orig.getRawQuery() : "";
                mPath = mScheme + "://" + mHost + ":" + mPort + encodedPath + q;
            } catch (Exception ignored) {}
            return this;
        }

        public HttpUrl build() {
            String portStr = (("http".equalsIgnoreCase(mScheme) && mPort == 80) ||
                              ("https".equalsIgnoreCase(mScheme) && mPort == 443)) ? "" : (":" + mPort);
            try {
                URI orig = URI.create(mPath);
                String path = orig.getRawPath();
                String query = orig.getRawQuery() != null ? "?" + orig.getRawQuery() : "";
                return new HttpUrl(mScheme + "://" + mHost + portStr + (path != null ? path : "") + query);
            } catch (Exception e) {
                return new HttpUrl(mScheme + "://" + mHost + portStr);
            }
        }
    }
}

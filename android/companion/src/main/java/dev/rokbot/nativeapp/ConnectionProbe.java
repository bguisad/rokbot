package dev.rokbot.nativeapp;

import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Live state of the active connection for the Connection & Diagnostics page.
 *
 * Route of a plain HTTP(S) connection (not Tailcat), decided in this order:
 *  1. the {@code X-RokBot-Route: relay|direct} response header of GET /health, if a relay in front of
 *     the Host adds it (e.g. Caddy {@code header X-RokBot-Route relay}; the e2e mock Host sends it
 *     when started with ROUTE=relay);
 *  2. the address: loopback, private (RFC 1918 / ULA), link-local, CGNAT 100.64/10 and *.local
 *     hosts are a direct LAN connection; anything else is a public entry, which for a self-hosted
 *     Host is a relay in front of it (reverse proxy, frp, ssh/Cloudflare tunnel).
 *
 * Path: the Tailcat library (host/network/tailcat/core/tunnel.go, Tunnel.monitor) pings the peer
 * every ~10 s and sets State.path to "direct" (DiscoPing answered from a direct UDP endpoint),
 * "relay" (answered through a DERP region) or "unknown"; GBTailcatStatus exposes it as JSON and
 * TailcatManager.getTransportPath() reads it. The library measures DiscoPing latency internally
 * but does not export it, so latency here is the app-level round trip of GET /health through the
 * same route (Tailcat loopback forwarder or the server URL), smoothed; it includes the Host's
 * (tiny) handling time.
 */
final class ConnectionProbe {
    static final String PATH_DIRECT = "direct";
    static final String PATH_RELAY = "relay";
    static final String PATH_UNKNOWN = "unknown";

    static final class Status {
        final boolean tailcat;
        final String path;        // direct | relay | unknown (Tailcat only)
        final long latencyMs;     // -1 = not measured yet
        final boolean reachable;
        final boolean measured;
        final boolean credentialRejected;  // GET /connect/status answered 401/403
        final String httpRoute;   // HTTP(S) only: direct | relay | unknown
        final String httpRouteSource; // header | address | null

        Status(boolean tailcat, String path, long latencyMs, boolean reachable, boolean measured, boolean credentialRejected) {
            this(tailcat, path, latencyMs, reachable, measured, credentialRejected, PATH_UNKNOWN, null);
        }

        Status(boolean tailcat, String path, long latencyMs, boolean reachable, boolean measured, boolean credentialRejected,
               String httpRoute, String httpRouteSource) {
            this.tailcat = tailcat;
            this.path = path;
            this.latencyMs = latencyMs;
            this.reachable = reachable;
            this.measured = measured;
            this.credentialRejected = credentialRejected;
            this.httpRoute = httpRoute == null ? PATH_UNKNOWN : httpRoute;
            this.httpRouteSource = httpRouteSource;
        }
    }

    interface Listener {
        void onStatus(Status status);
    }

    private static final long PATH_POLL_MS = 2_000L;
    private static final long LATENCY_POLL_MS = 6_000L;
    private static final long AUTH_POLL_MS = 30_000L;

    private final Context mContext;
    private final Listener mListener;
    private final Handler mMain = new Handler(Looper.getMainLooper());
    private HandlerThread mThread;
    private Handler mWorker;
    private volatile boolean mRunning;
    private volatile String mPath = PATH_UNKNOWN;
    private volatile long mLatency = -1L;
    private volatile boolean mReachable = true;
    private volatile boolean mMeasured = false;
    private long mLastLatencyAt = 0L;
    private long mLastAuthAt = 0L;
    private volatile boolean mRejected = false;
    private volatile String mHttpRoute = PATH_UNKNOWN;
    private volatile String mHttpRouteSource = null;
    private volatile String mRouteHeader = null;

    ConnectionProbe(Context context, Listener listener) {
        mContext = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        mListener = listener;
    }

    void start() {
        if (mRunning) return;
        mRunning = true;
        mThread = new HandlerThread("RokBotConnectionProbe");
        mThread.start();
        mWorker = new Handler(mThread.getLooper());
        mLastLatencyAt = 0L;
        mWorker.post(mTick);
    }

    void stop() {
        mRunning = false;
        if (mWorker != null) mWorker.removeCallbacksAndMessages(null);
        if (mThread != null) mThread.quitSafely();
        mThread = null;
        mWorker = null;
    }

    /** Forget measurements (connection switched). */
    void reset() {
        mPath = PATH_UNKNOWN;
        mLatency = -1L;
        mMeasured = false;
        mLastLatencyAt = 0L;
        mLastAuthAt = 0L;
        mRejected = false;
        mHttpRoute = PATH_UNKNOWN;
        mHttpRouteSource = null;
        mRouteHeader = null;
    }

    private final Runnable mTick = new Runnable() {
        @Override
        public void run() {
            if (!mRunning) return;
            boolean tailcat = Storage.isTailcatEnabled(mContext);
            if (tailcat) {
                try {
                    mPath = normalizePath(TailcatManager.get().getTransportPath(mContext));
                } catch (Throwable ignored) {}
            }
            long now = SystemClock.elapsedRealtime();
            if (mLastLatencyAt == 0L || now - mLastLatencyAt >= LATENCY_POLL_MS) {
                mLastLatencyAt = now;
                measure();
            }
            if (mReachable && (mLastAuthAt == 0L || now - mLastAuthAt >= AUTH_POLL_MS)) {
                mLastAuthAt = now;
                checkCredential();
            }
            publish(tailcat);
            Handler w = mWorker;
            if (mRunning && w != null) w.postDelayed(this, PATH_POLL_MS);
        }
    };

    private void measure() {
        String base;
        try {
            base = HostApiClient.resolveServer(mContext);
        } catch (Throwable t) {
            mReachable = false;
            mMeasured = true;
            return;
        }
        long best = -1L;
        String[] header = new String[1];
        // Two samples; the first may pay for a new TCP connection, keep the faster one.
        for (int i = 0; i < 2; i++) {
            long rtt = healthRoundTrip(base, 5_000, header);
            if (rtt >= 0 && (best < 0 || rtt < best)) best = rtt;
        }
        mMeasured = true;
        mReachable = best >= 0;
        if (best >= 0) mLatency = smooth(mLatency, best);
        if (!mReachable && Storage.isTailcatEnabled(mContext)) {
            TailcatManager.get().onRequestFailure(mContext);
        }
        if (!Storage.isTailcatEnabled(mContext)) {
            String hinted = normalizeHeaderRoute(header[0]);
            if (hinted != null) {
                mHttpRoute = hinted;
                mHttpRouteSource = "header";
            } else {
                mHttpRoute = classifyAddress(base);
                mHttpRouteSource = PATH_UNKNOWN.equals(mHttpRoute) ? null : "address";
            }
        }
    }

    /** X-RokBot-Route header value -> direct | relay, or null when absent/unknown. */
    static String normalizeHeaderRoute(String raw) {
        if (raw == null) return null;
        String p = raw.trim().toLowerCase(java.util.Locale.ROOT);
        if (p.equals("direct") || p.equals("lan")) return PATH_DIRECT;
        if (p.equals("relay") || p.equals("proxy") || p.equals("tunnel")) return PATH_RELAY;
        return null;
    }

    /** direct for loopback / private / link-local / CGNAT / *.local hosts, relay for public ones. */
    static String classifyAddress(String baseUrl) {
        String host;
        try {
            host = new URL(baseUrl).getHost();
        } catch (Throwable t) {
            return PATH_UNKNOWN;
        }
        if (host == null || host.isEmpty()) return PATH_UNKNOWN;
        String h = host.toLowerCase(java.util.Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        if (h.equals("localhost") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return PATH_DIRECT;
        Boolean literal = classifyLiteral(h);
        if (literal != null) return literal ? PATH_DIRECT : PATH_RELAY;
        try {
            java.net.InetAddress[] all = java.net.InetAddress.getAllByName(h);
            if (all.length == 0) return PATH_UNKNOWN;
            for (java.net.InetAddress a : all) {
                if (!isPrivate(a)) return PATH_RELAY;
            }
            return PATH_DIRECT;
        } catch (Throwable t) {
            return PATH_UNKNOWN;
        }
    }

    /** For IP literals: true = private/local, false = public, null = not an IP literal. */
    static Boolean classifyLiteral(String host) {
        if (host == null) return null;
        boolean v4 = host.matches("\\d{1,3}(\\.\\d{1,3}){3}");
        boolean v6 = host.indexOf(':') >= 0 && host.matches("[0-9a-f:.%a-z]+");
        if (!v4 && !v6) return null;
        try {
            return isPrivate(java.net.InetAddress.getByName(host));
        } catch (Throwable t) {
            return null;
        }
    }

    static boolean isPrivate(java.net.InetAddress a) {
        if (a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()) return true;
        byte[] b = a.getAddress();
        if (b.length == 4) {
            int b0 = b[0] & 0xff, b1 = b[1] & 0xff;
            return b0 == 100 && b1 >= 64 && b1 <= 127;   // CGNAT / Tailscale-style 100.64.0.0/10
        }
        return b.length == 16 && (b[0] & 0xfe) == 0xfc;   // IPv6 ULA fc00::/7
    }

    private void checkCredential() {
        try {
            String base = HostApiClient.resolveServer(mContext);
            String token = Storage.getToken(mContext);
            if (token == null || token.isEmpty()) { mRejected = true; return; }
            HostApiClient.checkStatus(base, token);
            mRejected = false;
        } catch (Throwable t) {
            mRejected = ConnectionHistory.isUnauthorized(t);
        }
    }

    private void publish(boolean tailcat) {
        final Status s = new Status(tailcat, mPath, mLatency, mReachable, mMeasured, mRejected, mHttpRoute, mHttpRouteSource);
        mMain.post(() -> {
            if (mRunning) mListener.onStatus(s);
        });
    }

    static String normalizePath(String raw) {
        if (raw == null) return PATH_UNKNOWN;
        String p = raw.trim().toLowerCase(java.util.Locale.ROOT);
        if (p.equals("direct") || p.equals("p2p")) return PATH_DIRECT;
        if (p.equals("relay") || p.equals("derp")) return PATH_RELAY;
        return PATH_UNKNOWN;
    }

    /** Exponential smoothing that follows big changes (path switch) quickly. */
    static long smooth(long previous, long sample) {
        if (previous < 0) return sample;
        if (sample > previous * 2 || sample * 2 < previous) return sample;
        return Math.round(previous * 0.6 + sample * 0.4);
    }

    static long healthRoundTrip(String baseUrl, int timeoutMs) {
        return healthRoundTrip(baseUrl, timeoutMs, null);
    }

    /** As above; routeHeader[0] receives the X-RokBot-Route response header (or null). */
    static long healthRoundTrip(String baseUrl, int timeoutMs, String[] routeHeader) {
        HttpURLConnection conn = null;
        long start = SystemClock.elapsedRealtime();
        try {
            conn = (HttpURLConnection) new URL(baseUrl + "/health").openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            int code = conn.getResponseCode();
            if (routeHeader != null && routeHeader.length > 0) routeHeader[0] = conn.getHeaderField("X-RokBot-Route");
            try {
                java.io.InputStream in = code < 400 ? conn.getInputStream() : conn.getErrorStream();
                if (in != null) {
                    byte[] buf = new byte[256];
                    while (in.read(buf) != -1) { /* drain for keep-alive */ }
                    in.close();
                }
            } catch (Throwable ignored) {}
            long rtt = SystemClock.elapsedRealtime() - start;
            // Body drained and closed: the socket goes back to the keep-alive pool, so the
            // second sample measures the request round trip rather than a new TCP handshake.
            return code >= 200 && code < 300 ? rtt : -1L;
        } catch (Throwable t) {
            if (conn != null) conn.disconnect();
            return -1L;
        }
    }

    /** "直连 · 38 ms" / "中继 · 120 ms" / "直连（局域网）· 3 ms" / "检测中…" / "无法连接". */
    static String describe(Context context, Status s) {
        if (s == null || !s.measured) return Localize.t(context, "检测中…", "Checking…");
        if (!s.reachable) return Localize.t(context, "无法连接", "Unreachable");
        if (s.credentialRejected) return Localize.t(context, "设备凭证已失效，请重新配对", "Device credential rejected — pair again");
        String route;
        if (s.tailcat) {
            if (PATH_DIRECT.equals(s.path)) route = Localize.t(context, "直连", "Direct");
            else if (PATH_RELAY.equals(s.path)) route = Localize.t(context, "中继", "Relay");
            else route = Localize.t(context, "路径检测中", "Path pending");
        } else if (PATH_DIRECT.equals(s.httpRoute)) {
            route = Localize.t(context, "直连（局域网）", "Direct (LAN)");
        } else if (PATH_RELAY.equals(s.httpRoute)) {
            route = Localize.t(context, "中继（公网入口）", "Relay (public entry)");
        } else {
            route = Localize.t(context, "服务器", "Server");
        }
        return s.latencyMs >= 0 ? route + " · " + s.latencyMs + " ms" : route;
    }
}

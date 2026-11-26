package dev.rokbot.nativeapp;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Speed test for the Connection & Diagnostics page: latency (median of several round trips) and
 * download / upload throughput (Mbps) for each configured way to reach the Host — the public
 * address, a Tailscale address (100.64.0.0/10 or *.ts.net) and Tailcat links. The active
 * connection is tested where it is; a saved Tailcat link gets a temporary tunnel
 * (TailcatManager.startPending, dropped afterwards), a saved server URL is used directly. Each
 * target uses its own saved device credential.
 *
 * Host routes (host/server/speedtest.mjs): GET /local/speedtest/ping, GET
 * /local/speedtest/download?bytes=N, POST /local/speedtest/upload. A Host without them answers
 * 404: latency then falls back to GET /health and throughput is reported as unsupported.
 *
 * Limits: transfers grow 512 KiB -> 2 MiB -> 8 MiB and stop once a run takes 1.5 s, so at most
 * 10.5 MiB per direction per target, and at most {@link #PHASE_BUDGET_MS} per direction.
 * {@link #cancel()} stops at once (the open connection is disconnected).
 */
final class SpeedTest {
    static final String KIND_PUBLIC = "public";
    static final String KIND_TAILSCALE = "tailscale";
    static final String KIND_TAILCAT = "tailcat";
    static final String KIND_LAN = "lan";

    static final int PING_SAMPLES = 7;
    static final int[] TRANSFER_STEPS = { 512 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024 };
    static final long LONG_ENOUGH_MS = 1_500L;
    static final long PHASE_BUDGET_MS = 10_000L;
    static final int MAX_TARGETS = 6;
    private static final int CONNECT_TIMEOUT_MS = 6_000;
    private static final int READ_TIMEOUT_MS = 10_000;

    static final class Target {
        final String key;
        final String kind;
        final String label;
        final String address;
        final boolean current;
        final ConnectionHistory.Entry entry;   // null for the active connection

        Target(String key, String kind, String label, String address, boolean current, ConnectionHistory.Entry entry) {
            this.key = key;
            this.kind = kind;
            this.label = label;
            this.address = address;
            this.current = current;
            this.entry = entry;
        }
    }

    static final class Result {
        final Target target;
        String phase = "";             // ping | download | upload | done
        long latencyMs = -1L;
        long[] samples = new long[0];
        double downMbps = -1;
        double upMbps = -1;
        long downBytes = 0;
        long upBytes = 0;
        boolean transfersUnsupported = false;
        String error;

        Result(Target target) {
            this.target = target;
        }
    }

    interface Listener {
        void onUpdate(Result result);

        void onFinished(boolean cancelled);
    }

    static final class CancelledException extends Exception {
        CancelledException() {
            super("cancelled");
        }
    }

    private final Context mContext;
    private final Listener mListener;
    private final Handler mMain = new Handler(Looper.getMainLooper());
    private volatile boolean mCancelled;
    private volatile boolean mRunning;
    private volatile HttpURLConnection mOpen;
    private Thread mThread;

    SpeedTest(Context context, Listener listener) {
        mContext = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        mListener = listener;
    }

    boolean isRunning() {
        return mRunning;
    }

    // ---- targets ----

    /** "public" | "tailscale" | "lan" for a server URL. */
    static String kindOfServer(String url) {
        String host;
        try {
            host = new URL(url.trim()).getHost();
        } catch (Throwable t) {
            return KIND_PUBLIC;
        }
        if (host == null || host.isEmpty()) return KIND_PUBLIC;
        String h = host.toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        if (h.endsWith(".ts.net") || h.endsWith(".beta.tailscale.net")) return KIND_TAILSCALE;
        Boolean literal = ConnectionProbe.classifyLiteral(h);
        if (literal != null && literal) {
            String[] p = h.split("\\.");
            if (p.length == 4) {
                try {
                    int b0 = Integer.parseInt(p[0]), b1 = Integer.parseInt(p[1]);
                    if (b0 == 100 && b1 >= 64 && b1 <= 127) return KIND_TAILSCALE;
                } catch (NumberFormatException ignored) {}
            }
            if (h.startsWith("fd7a:115c:a1e0:")) return KIND_TAILSCALE;
            return KIND_LAN;
        }
        if (h.equals("localhost") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return KIND_LAN;
        return KIND_PUBLIC;
    }

    static String kindLabel(Context context, String kind) {
        switch (kind) {
            case KIND_TAILCAT: return "Tailcat";
            case KIND_TAILSCALE: return "Tailscale";
            case KIND_LAN: return Localize.t(context, "局域网", "LAN");
            default: return Localize.t(context, "公网", "Public");
        }
    }

    /** The active connection first, then saved connections (most recent first), deduplicated. */
    static List<Target> targets(Context context) {
        Map<String, Target> out = new LinkedHashMap<>();
        List<ConnectionHistory.Entry> saved = ConnectionHistory.load(context);
        if (Storage.isPaired(context)) {
            boolean tailcat = Storage.isTailcatEnabled(context);
            String address = tailcat ? Storage.getTailcatLink(context) : Storage.getGatewayUrl(context);
            String type = tailcat ? ConnectionHistory.TYPE_TAILCAT : ConnectionHistory.TYPE_SERVER;
            if (address != null && !address.isEmpty()) {
                String key = ConnectionHistory.keyOf(type, address);
                String kind = tailcat ? KIND_TAILCAT : kindOfServer(address);
                ConnectionHistory.Entry known = ConnectionHistory.findByKey(saved, key);
                String label = known != null ? known.displayName() : ConnectionHistory.shortAddress(type, address);
                out.put(key, new Target(key, kind, label, address, true, null));
            }
        }
        for (ConnectionHistory.Entry e : saved) {
            if (out.size() >= MAX_TARGETS) break;
            String key = e.key();
            if (out.containsKey(key) || e.address == null || e.sealedToken == null) continue;
            String kind = e.isTailcat() ? KIND_TAILCAT : kindOfServer(e.address);
            out.put(key, new Target(key, kind, e.displayName(), e.address, false, e));
        }
        return new ArrayList<>(out.values());
    }

    // ---- running ----

    void start(List<Target> targets) {
        if (mRunning || targets == null || targets.isEmpty()) return;
        mRunning = true;
        mCancelled = false;
        final List<Target> list = new ArrayList<>(targets);
        mThread = new Thread(() -> {
            boolean cancelled = false;
            for (Target t : list) {
                if (mCancelled) { cancelled = true; break; }
                Result r = new Result(t);
                try {
                    runTarget(r);
                } catch (CancelledException ce) {
                    cancelled = true;
                    r.error = Localize.t(mContext, "已取消", "Cancelled");
                } catch (Throwable e) {
                    r.error = describeError(e);
                }
                r.phase = "done";
                post(r);
                if (cancelled) break;
            }
            mRunning = false;
            final boolean c = cancelled || mCancelled;
            mMain.post(() -> mListener.onFinished(c));
        }, "RokBotSpeedTest");
        mThread.start();
    }

    void cancel() {
        mCancelled = true;
        HttpURLConnection open = mOpen;
        if (open != null) {
            try { open.disconnect(); } catch (Throwable ignored) {}
        }
    }

    private void post(Result r) {
        final Result snapshot = copy(r);
        mMain.post(() -> mListener.onUpdate(snapshot));
    }

    private static Result copy(Result r) {
        Result c = new Result(r.target);
        c.phase = r.phase;
        c.latencyMs = r.latencyMs;
        c.samples = r.samples.clone();
        c.downMbps = r.downMbps;
        c.upMbps = r.upMbps;
        c.downBytes = r.downBytes;
        c.upBytes = r.upBytes;
        c.transfersUnsupported = r.transfersUnsupported;
        c.error = r.error;
        return c;
    }

    private void checkCancelled() throws CancelledException {
        if (mCancelled) throw new CancelledException();
    }

    private void runTarget(Result r) throws Exception {
        Target t = r.target;
        String base;
        String token;
        TailcatManager.TunnelSession pending = null;
        if (t.current) {
            base = HostApiClient.resolveServer(mContext);
            token = Storage.getToken(mContext);
        } else {
            token = Storage.openFromHistory(t.entry.sealedToken);
            if (token == null || token.isEmpty()) {
                throw new IllegalStateException(Localize.t(mContext, "无法读取保存的凭证", "Saved credential can't be read"));
            }
            if (t.entry.isTailcat()) {
                String identity = t.entry.sealedIdentity != null ? Storage.openFromHistory(t.entry.sealedIdentity) : null;
                r.phase = "tunnel";
                post(r);
                pending = TailcatManager.get().startPending(mContext, t.address, identity);
                base = pending.localUrl;
            } else {
                base = t.address;
            }
        }
        try {
            base = trimSlash(base);
            r.phase = "ping";
            post(r);
            boolean speedRoutes = measureLatency(r, base, token);
            if (!speedRoutes) {
                r.transfersUnsupported = true;
                return;
            }
            checkCancelled();
            r.phase = "download";
            post(r);
            measureDownload(r, base, token);
            checkCancelled();
            r.phase = "upload";
            post(r);
            measureUpload(r, base, token);
        } finally {
            if (pending != null) {
                try { TailcatManager.get().dropPending(pending); } catch (Throwable ignored) {}
            }
        }
    }

    /** Returns true when the Host has the speed test routes (else latency came from /health). */
    private boolean measureLatency(Result r, String base, String token) throws Exception {
        long[] samples = new long[PING_SAMPLES];
        int n = 0;
        boolean routes = true;
        for (int i = 0; i < PING_SAMPLES; i++) {
            checkCancelled();
            long start = SystemClock.elapsedRealtime();
            int code = routes ? request(base + "/local/speedtest/ping", "GET", token, null, 0)
                    : request(base + "/health", "GET", null, null, 0);
            long rtt = SystemClock.elapsedRealtime() - start;
            if (routes && code == 404) {
                routes = false;
                i--;           // retry this sample on /health
                continue;
            }
            if (code == 401 || code == 403) {
                throw new IllegalStateException(Localize.t(mContext, "设备凭证已失效", "Device credential rejected"));
            }
            if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code);
            samples[n++] = rtt;
            r.samples = Arrays.copyOf(samples, n);
            r.latencyMs = median(r.samples);
            post(r);
        }
        return routes;
    }

    private void measureDownload(Result r, String base, String token) throws Exception {
        long phaseStart = SystemClock.elapsedRealtime();
        for (int size : TRANSFER_STEPS) {
            checkCancelled();
            if (SystemClock.elapsedRealtime() - phaseStart >= PHASE_BUDGET_MS) break;
            long start = SystemClock.elapsedRealtime();
            long got = download(base + "/local/speedtest/download?bytes=" + size, token, size, phaseStart);
            long ms = Math.max(1L, SystemClock.elapsedRealtime() - start);
            r.downBytes += got;
            if (got > 0) r.downMbps = mbps(got, ms);
            post(r);
            if (got < size || ms >= LONG_ENOUGH_MS) break;
        }
    }

    private void measureUpload(Result r, String base, String token) throws Exception {
        long phaseStart = SystemClock.elapsedRealtime();
        byte[] chunk = new byte[64 * 1024];
        new java.security.SecureRandom().nextBytes(chunk);
        for (int size : TRANSFER_STEPS) {
            checkCancelled();
            if (SystemClock.elapsedRealtime() - phaseStart >= PHASE_BUDGET_MS) break;
            long start = SystemClock.elapsedRealtime();
            int code = request(base + "/local/speedtest/upload", "POST", token, chunk, size);
            long ms = Math.max(1L, SystemClock.elapsedRealtime() - start);
            if (code == 413) break;
            if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code);
            r.upBytes += size;
            r.upMbps = mbps(size, ms);
            post(r);
            if (ms >= LONG_ENOUGH_MS) break;
        }
    }

    /** Reads the download body; stops early (returning what arrived) once the phase budget is used. */
    private long download(String url, String token, int expected, long phaseStart) throws Exception {
        HttpURLConnection conn = open(url, "GET", token);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code);
            long total = 0;
            byte[] buf = new byte[64 * 1024];
            try (InputStream in = conn.getInputStream()) {
                int read;
                while ((read = in.read(buf)) != -1) {
                    total += read;
                    checkCancelled();
                    if (SystemClock.elapsedRealtime() - phaseStart >= PHASE_BUDGET_MS && total < expected) break;
                }
            }
            return total;
        } catch (CancelledException ce) {
            throw ce;
        } catch (Exception e) {
            checkCancelled();
            throw e;
        } finally {
            mOpen = null;
            conn.disconnect();
        }
    }

    /** One request; for uploads `size` bytes of `chunk` (repeated) are streamed. Returns the status. */
    private int request(String url, String method, String token, byte[] chunk, int size) throws Exception {
        HttpURLConnection conn = open(url, method, token);
        try {
            if (chunk != null) {
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(size);
                conn.setRequestProperty("Content-Type", "application/octet-stream");
                try (OutputStream out = conn.getOutputStream()) {
                    int left = size;
                    while (left > 0) {
                        checkCancelled();
                        int n = Math.min(left, chunk.length);
                        out.write(chunk, 0, n);
                        left -= n;
                    }
                }
            }
            int code = conn.getResponseCode();
            try (InputStream in = code < 400 ? conn.getInputStream() : conn.getErrorStream()) {
                if (in != null) {
                    byte[] buf = new byte[1024];
                    while (in.read(buf) != -1) { /* drain for keep-alive */ }
                }
            } catch (Throwable ignored) {}
            return code;
        } catch (CancelledException ce) {
            throw ce;
        } catch (Exception e) {
            checkCancelled();
            throw e;
        } finally {
            mOpen = null;
        }
    }

    private HttpURLConnection open(String url, String method, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setUseCaches(false);
        conn.setRequestProperty("Accept-Encoding", "identity");
        conn.setRequestProperty("Cache-Control", "no-store");
        if (token != null && !token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
        mOpen = conn;
        if (mCancelled) {
            conn.disconnect();
            throw new CancelledException();
        }
        return conn;
    }

    private String describeError(Throwable e) {
        if (e instanceof java.net.SocketTimeoutException) return Localize.t(mContext, "超时", "Timed out");
        if (e instanceof java.net.UnknownHostException) return Localize.t(mContext, "无法解析地址", "Unknown host");
        if (e instanceof java.net.ConnectException) return Localize.t(mContext, "无法连接", "Unreachable");
        String m = e.getMessage();
        return m != null && !m.isEmpty() ? m : e.getClass().getSimpleName();
    }

    // ---- pure helpers (JVM-tested) ----

    static long median(long[] values) {
        if (values == null || values.length == 0) return -1L;
        long[] s = values.clone();
        Arrays.sort(s);
        int m = s.length / 2;
        return s.length % 2 == 1 ? s[m] : Math.round((s[m - 1] + s[m]) / 2.0);
    }

    static double mbps(long bytes, long ms) {
        if (bytes <= 0 || ms <= 0) return 0;
        return bytes * 8.0 / (ms / 1000.0) / 1_000_000.0;
    }

    static String formatMbps(double v) {
        if (v < 0) return "—";
        if (v >= 100) return String.format(Locale.ROOT, "%.0f Mbps", v);
        if (v >= 10) return String.format(Locale.ROOT, "%.1f Mbps", v);
        return String.format(Locale.ROOT, "%.2f Mbps", v);
    }

    static String formatBytes(long bytes) {
        if (bytes >= 1024L * 1024L) return String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024.0));
        if (bytes >= 1024L) return String.format(Locale.ROOT, "%d KB", bytes / 1024L);
        return bytes + " B";
    }

    static String trimSlash(String base) {
        if (base == null) return "";
        String b = base.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        return b;
    }

    /** One line of results: "延迟 38 ms · 下载 52.3 Mbps · 上传 12.1 Mbps", with phase / errors. */
    static String summary(Context context, Result r) {
        if (r == null) return Localize.t(context, "未测试", "Not tested");
        StringBuilder sb = new StringBuilder();
        sb.append(Localize.t(context, "延迟 ", "Latency "))
                .append(r.latencyMs >= 0 ? r.latencyMs + " ms" : "—");
        if (r.samples.length > 0 && r.samples.length < PING_SAMPLES && !"done".equals(r.phase)) {
            sb.append(" (").append(r.samples.length).append('/').append(PING_SAMPLES).append(')');
        }
        if (r.transfersUnsupported) {
            sb.append(Localize.t(context, " · 上传/下载需升级 Host", " · upload/download needs a newer Host"));
        } else {
            sb.append(Localize.t(context, " · 下载 ", " · Down ")).append(formatMbps(r.downMbps));
            sb.append(Localize.t(context, " · 上传 ", " · Up ")).append(formatMbps(r.upMbps));
        }
        if (r.error != null) {
            sb.append(" · ").append(r.error);
        } else if (!"done".equals(r.phase)) {
            String phase;
            switch (r.phase) {
                case "tunnel": phase = Localize.t(context, "建立隧道…", "opening tunnel…"); break;
                case "ping": phase = Localize.t(context, "测延迟…", "latency…"); break;
                case "download": phase = Localize.t(context, "测下载…", "download…"); break;
                case "upload": phase = Localize.t(context, "测上传…", "upload…"); break;
                default: phase = Localize.t(context, "等待中", "waiting");
            }
            sb.append(" · ").append(phase);
        } else if (r.downBytes + r.upBytes > 0) {
            sb.append(Localize.t(context, " · 用量 ", " · used ")).append(formatBytes(r.downBytes + r.upBytes));
        }
        return sb.toString();
    }
}

package dev.rokbot.nativeapp;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import dev.grokbot.local.TailcatBridge;

/**
 * Native Tailcat forward tunnel lifecycle manager, mirroring iOS GBNetwork.m and shell Tailcat.kt.
 * Provides lazy startup, link normalization, identity persistence, /health probing, backoff, and auto-recovery.
 */
public final class TailcatManager {
    private static final String TAG = "RokBotTailcat";
    private static final long PEER_INITIAL_GRACE_MS = 25_000L;
    private static final long PEER_RECOVERY_GRACE_MS = 10_000L;
    private static final Pattern RAW_ADDRESS = Pattern.compile("^tc[A-Za-z0-9_-]{30,16384}$");
    private static final Pattern PORT_QUERY = Pattern.compile("^port=([1-9][0-9]{0,4})$");

    public static final class TunnelSession {
        public final int handle;
        public final String localUrl;
        public final String link;
        public final String identityJson;
        public volatile String path;

        public TunnelSession(int handle, String localUrl, String link, String identityJson, String path) {
            this.handle = handle;
            this.localUrl = localUrl;
            this.link = link;
            this.identityJson = identityJson;
            this.path = path != null && !path.isEmpty() ? path : "unknown";
        }
    }

    public static final class ProbeResult {
        public final boolean reachable;
        public final boolean restarted;

        public ProbeResult(boolean reachable, boolean restarted) {
            this.reachable = reachable;
            this.restarted = restarted;
        }
    }

    public interface ResetListener {
        void onTunnelReset();
    }

    public interface NetworkChangeListener {
        void onNetworkChanged(boolean hasInternet);
    }

    private static final TailcatManager INSTANCE = new TailcatManager();
    public static TailcatManager get() {
        return INSTANCE;
    }

    private final Object lock = new Object();
    private TunnelSession active;
    private long unhealthySinceMs = 0L;
    private boolean wasReady = false;
    private long lastAttemptMs = 0L;
    private int failures = 0;
    private volatile ResetListener resetListener;
    private volatile boolean monitorRegistered = false;
    private volatile String lastNetSignature = null;

    private TailcatManager() {}

    public void setResetListener(ResetListener listener) {
        this.resetListener = listener;
    }

    public static String normalizeHalfWidth(String input) {
        if (input == null) return "";
        StringBuilder sb = new StringBuilder(input.length());
        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);
            if (c == '\u3000') {
                sb.append(' ');
            } else if (c >= '\uFF01' && c <= '\uFF5E') {
                sb.append((char) (c - 0xFEE0));
            } else {
                sb.append(c);
            }
        }
        return sb.toString().trim();
    }

    public static boolean looksLikeTailcatInput(String input) {
        String raw = normalizeHalfWidth(input);
        if (raw.isEmpty()) return false;
        if (raw.toLowerCase(Locale.US).startsWith("tailcat://")) return true;
        return RAW_ADDRESS.matcher(raw).matches();
    }

    public static String normalizeLink(Context context, String input) throws IllegalArgumentException {
        String raw = normalizeHalfWidth(input);
        if (RAW_ADDRESS.matcher(raw).matches()) {
            return "tailcat://connect/" + raw + "?port=8000";
        }
        URI uri;
        try {
            uri = new URI(raw);
        } catch (Exception e) {
            throw new IllegalArgumentException(Localize.t(context,
                    "请输入有效的 Tailcat 连接链接。",
                    "Enter a valid Tailcat connection link."));
        }
        String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.US) : "";
        String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
        String address = uri.getRawPath() != null ? uri.getRawPath() : "";
        if (address.startsWith("/")) address = address.substring(1);
        String query = uri.getRawQuery() != null ? uri.getRawQuery() : "";
        Matcher pm = PORT_QUERY.matcher(query);
        int port = -1;
        if (pm.matches()) {
            try {
                port = Integer.parseInt(pm.group(1));
            } catch (NumberFormatException ignored) {}
        }
        if (!"tailcat".equals(scheme)
                || !"connect".equals(host)
                || uri.getRawUserInfo() != null
                || uri.getRawFragment() != null
                || !RAW_ADDRESS.matcher(address).matches()
                || port < 1 || port > 65535) {
            throw new IllegalArgumentException(Localize.t(context,
                    "请输入有效的 Tailcat 连接链接。",
                    "Enter a valid Tailcat connection link."));
        }
        return "tailcat://connect/" + address + "?port=" + port;
    }

    public TunnelSession startPending(Context context, String input, String reuseIdentity) {
        if (!TailcatBridge.isAvailable()) {
            throw new IllegalStateException(Localize.t(context,
                    "当前设备不支持 Tailcat 原生库。",
                    "Tailcat native library is unavailable on this device ABI."));
        }
        String link = normalizeLink(context, input);
        String identityJson = reuseIdentity != null && !reuseIdentity.trim().isEmpty()
                ? reuseIdentity.trim()
                : TailcatBridge.safeIdentity();
        JSONObject identityObj;
        try {
            identityObj = new JSONObject(identityJson);
        } catch (Exception e) {
            try {
                identityObj = new JSONObject(TailcatBridge.safeIdentity());
            } catch (Exception e2) {
                throw new IllegalStateException("Tailcat identity invalid", e2);
            }
        }
        JSONObject config = new JSONObject();
        try {
            config.put("mode", "forward");
            config.put("link", link);
            config.put("identity", identityObj);
        } catch (Exception e) {
            throw new IllegalStateException("Tailcat config build failed", e);
        }

        JSONObject reply;
        try {
            reply = new JSONObject(TailcatBridge.safeStart(config.toString()));
        } catch (Exception e) {
            throw new IllegalStateException(Localize.t(context,
                    "无法启动 Tailcat 连接。",
                    "Could not start Tailcat."));
        }
        int handle = reply.optInt("handle", 0);
        JSONObject status = reply.optJSONObject("status");
        String localUrl = status != null ? status.optString("localURL", "") : "";
        boolean listening = status != null && status.optBoolean("listening", false);
        if (handle <= 0 || !listening || !localUrl.startsWith("http://127.0.0.1:")) {
            if (handle > 0) TailcatBridge.safeStop(handle);
            throw new IllegalStateException(Localize.t(context,
                    "无法连接，请检查 Tailcat 链接后重试。",
                    "Could not connect. Check the Tailcat link and try again."));
        }
        String path = status != null ? status.optString("path", "unknown") : "unknown";
        return new TunnelSession(handle, localUrl, link, identityObj.toString(), path);
    }

    public void commitPending(TunnelSession pending) {
        if (pending == null) return;
        TunnelSession old;
        synchronized (lock) {
            old = active;
            active = pending;
            unhealthySinceMs = 0L;
            wasReady = false;
            lastAttemptMs = 0L;
            failures = 0;
        }
        if (old != null && old.handle != pending.handle) {
            TailcatBridge.safeStop(old.handle);
            ResetListener l = resetListener;
            if (l != null) l.onTunnelReset();
        }
    }

    public void dropPending(TunnelSession pending) {
        if (pending == null) return;
        boolean isActive;
        synchronized (lock) {
            isActive = active != null && active.handle == pending.handle;
        }
        if (!isActive) {
            TailcatBridge.safeStop(pending.handle);
        }
    }

    /**
     * Resolves the usable HTTP base URL for API/SSE/Voice calls.
     * For direct mode returns normalized Host URL; for Tailcat mode returns http://127.0.0.1:<port>.
     */
    public String resolveServerUrl(Context context) {
        return resolveServerUrl(context, true);
    }

    public String resolveServerUrl(Context context, boolean notifyOnReset) {
        if (!Storage.isTailcatEnabled(context)) {
            return Storage.getHostUrl(context);
        }
        String tailcatLink = Storage.getTailcatLink(context);
        if (tailcatLink.isEmpty()) {
            tailcatLink = Storage.getHostUrl(context);
        }
        if (tailcatLink.isEmpty()) return "";
        String storedIdentity = Storage.getTailcatIdentity(context);

        boolean restartedTunnel = false;
        String resolved;
        synchronized (lock) {
            long now = SystemClock.elapsedRealtime();
            TunnelSession current = active;
            if (current != null && tailcatLink.equals(current.link)) {
                JSONObject status = parseJson(TailcatBridge.safeStatus(current.handle));
                boolean listening = status != null && status.optBoolean("listening", false);
                if (listening) {
                    String path = status.optString("path", "");
                    if (!path.isEmpty()) current.path = path;
                    String state = status.optString("state", "");
                    String error = status.optString("error", "");
                    if ("ready".equals(state) && error.isEmpty()) {
                        unhealthySinceMs = 0L;
                        wasReady = true;
                        return current.localUrl;
                    }
                    if (unhealthySinceMs == 0L || now < unhealthySinceMs) unhealthySinceMs = now;
                    long grace = wasReady ? PEER_RECOVERY_GRACE_MS : PEER_INITIAL_GRACE_MS;
                    if (error.isEmpty() && now - unhealthySinceMs < grace) {
                        return current.localUrl;
                    }
                }
            }

            long backoffMs = Math.min(10_000L, 500L << Math.min(failures, 4));
            if (failures > 0 && now >= lastAttemptMs && now - lastAttemptMs < backoffMs) {
                if (current != null) return current.localUrl;
            }
            lastAttemptMs = now;
            active = null;
            if (current != null) {
                TailcatBridge.safeStop(current.handle);
                restartedTunnel = true;
            }
            try {
                TunnelSession restarted = startPending(context, tailcatLink, storedIdentity);
                active = restarted;
                if (storedIdentity.isEmpty() && !restarted.identityJson.isEmpty()) {
                    Storage.saveTailcatIdentity(context, restarted.identityJson);
                }
                unhealthySinceMs = now;
                wasReady = false;
                failures = 0;
                resolved = restarted.localUrl;
            } catch (RuntimeException e) {
                failures = Math.min(failures + 1, 8);
                Log.w(TAG, "Tailcat start failed: " + e.getMessage());
                throw e;
            }
        }
        if (restartedTunnel && notifyOnReset) {
            ResetListener l = resetListener;
            if (l != null) l.onTunnelReset();
        }
        return resolved;
    }

    public ProbeResult probeAndRecover(Context context, int timeoutMs, boolean notifyOnReset) {
        String base;
        try {
            base = resolveServerUrl(context, notifyOnReset);
        } catch (Exception e) {
            return new ProbeResult(false, false);
        }
        if (base == null || base.isEmpty()) return new ProbeResult(false, false);
        if (probeHealth(base, timeoutMs)) return new ProbeResult(true, false);
        if (!Storage.isTailcatEnabled(context)) return new ProbeResult(false, false);

        Log.i(TAG, "Tailcat /health failed; restarting tunnel");
        TunnelSession old;
        synchronized (lock) {
            old = active;
            active = null;
            unhealthySinceMs = 0L;
            wasReady = false;
            lastAttemptMs = 0L;
            failures = 0;
        }
        if (old != null) TailcatBridge.safeStop(old.handle);
        boolean ok = false;
        try {
            String next = resolveServerUrl(context, false);
            ok = next != null && !next.isEmpty();
        } catch (Exception ignored) {}
        if (notifyOnReset) {
            ResetListener l = resetListener;
            if (l != null) l.onTunnelReset();
        }
        return new ProbeResult(ok, true);
    }

    public void registerNetworkMonitor(Context context, NetworkChangeListener listener) {
        if (monitorRegistered || context == null) return;
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        monitorRegistered = true;
        lastNetSignature = currentNetworkSignature(cm);
        try {
            cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    handleNetworkChange(cm, listener);
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                    handleNetworkChange(cm, listener);
                }

                @Override
                public void onLost(Network network) {
                    handleNetworkChange(cm, listener);
                }
            });
        } catch (Exception e) {
            monitorRegistered = false;
        }
    }

    private void handleNetworkChange(ConnectivityManager cm, NetworkChangeListener listener) {
        String sig = currentNetworkSignature(cm);
        if (sig.equals(lastNetSignature)) return;
        lastNetSignature = sig;
        synchronized (lock) {
            unhealthySinceMs = 0L;
            failures = 0;
            lastAttemptMs = 0L;
        }
        if (listener != null) {
            listener.onNetworkChanged(!"none".equals(sig));
        }
    }

    private static String currentNetworkSignature(ConnectivityManager cm) {
        Network activeNet = cm.getActiveNetwork();
        if (activeNet == null) return "none";
        NetworkCapabilities caps = cm.getNetworkCapabilities(activeNet);
        if (caps == null) return "unknown";
        StringBuilder transports = new StringBuilder();
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) transports.append('W');
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) transports.append('C');
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) transports.append('E');
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) transports.append('V');
        return activeNet.getNetworkHandle() + ":" + transports;
    }

    public String getTransportPath(Context context) {
        if (!Storage.isTailcatEnabled(context)) return "direct";
        TunnelSession current;
        synchronized (lock) {
            current = active;
        }
        if (current == null) return "unknown";
        JSONObject status = parseJson(TailcatBridge.safeStatus(current.handle));
        if (status == null) return current.path;
        String path = status.optString("path", "");
        if (!path.isEmpty()) current.path = path;
        return current.path;
    }

    public void clear() {
        TunnelSession old;
        synchronized (lock) {
            old = active;
            active = null;
            unhealthySinceMs = 0L;
            wasReady = false;
            lastAttemptMs = 0L;
            failures = 0;
        }
        if (old != null) {
            TailcatBridge.safeStop(old.handle);
            ResetListener l = resetListener;
            if (l != null) l.onTunnelReset();
        }
    }

    public static boolean probeHealth(String baseUrl, int timeoutMs) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(baseUrl + "/health").openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            int code = conn.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static JSONObject parseJson(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }
}

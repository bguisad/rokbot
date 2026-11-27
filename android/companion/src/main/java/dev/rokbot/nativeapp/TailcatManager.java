package dev.rokbot.nativeapp;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import dev.grokbot.local.TailcatBridge;

/**
 * Native Tailcat forward tunnel lifecycle manager, mirroring iOS RBNetwork.m and shell Tailcat.kt.
 * Provides lazy startup, localPort pinning, stale loopback port tracking, link normalization,
 * identity persistence, /health probing, capped backoff retry, network monitor, and foreground recovery.
 */
public final class TailcatManager {
    private static final String TAG = "RokBotTailcat";
    private static final long PEER_INITIAL_GRACE_MS = 25_000L;
    private static final long PEER_RECOVERY_GRACE_MS = 10_000L;
    private static final int DEFAULT_PROBE_TIMEOUT_MS = 2_500;
    private static final int POST_RESTART_PROBE_TIMEOUT_MS = 3_500;
    private static final int MAX_KNOWN_LOOPBACK_PORTS = 32;
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
        public final String localUrl;
        public final boolean portChanged;

        public ProbeResult(boolean reachable, boolean restarted) {
            this(reachable, restarted, "", false);
        }

        public ProbeResult(boolean reachable, boolean restarted, String localUrl, boolean portChanged) {
            this.reachable = reachable;
            this.restarted = restarted;
            this.localUrl = localUrl != null ? localUrl : "";
            this.portChanged = portChanged;
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
    private int preferredPort = 0;
    private final LinkedHashSet<Integer> knownLoopbackPorts = new LinkedHashSet<>();
    private long unhealthySinceMs = 0L;
    private boolean wasReady = false;
    private long lastAttemptMs = 0L;
    private int failures = 0;
    private volatile ResetListener resetListener;
    private volatile Runnable recoveryListener;
    private volatile NetworkChangeListener networkChangeListener;
    private volatile Context appContext;
    private volatile boolean monitorRegistered = false;
    private volatile ConnectivityManager connectivityManager;
    private volatile TailcatReconnectStateMachine reconnectEngine;
    private final ScheduledExecutorService reconnectExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "RokBotTailcatRecover");
        t.setDaemon(true);
        return t;
    });

    private TailcatManager() {}

    public void setResetListener(ResetListener listener) {
        this.resetListener = listener;
    }

    public void setRecoveryListener(Runnable listener) {
        this.recoveryListener = listener;
    }

    private TailcatReconnectStateMachine ensureReconnectEngine(Context context) {
        if (context != null && this.appContext == null) {
            Context app = context.getApplicationContext();
            this.appContext = app != null ? app : context;
        }
        TailcatReconnectStateMachine engine = this.reconnectEngine;
        if (engine != null) return engine;
        synchronized (lock) {
            if (this.reconnectEngine == null) {
                this.reconnectEngine = new TailcatReconnectStateMachine(
                        SystemClock::elapsedRealtime,
                        (delayMs, task) -> {
                            ScheduledFuture<?> f = reconnectExecutor.schedule(task, Math.max(0L, delayMs), TimeUnit.MILLISECONDS);
                            return () -> f.cancel(false);
                        },
                        new TailcatReconnectStateMachine.Actions() {
                            @Override
                            public boolean isPaired() {
                                Context ctx = appContext;
                                return ctx != null && Storage.isPaired(ctx);
                            }

                            @Override
                            public boolean isTailcatEnabled() {
                                Context ctx = appContext;
                                return ctx != null && Storage.isTailcatEnabled(ctx);
                            }

                            @Override
                            public boolean hasActiveInternet() {
                                ConnectivityManager cm = resolveConnectivityManager();
                                if (cm == null) return true;
                                TailcatReconnectStateMachine.NetworkSnapshot snap = snapshotActiveNetwork(cm);
                                return snap.available && snap.hasInternet;
                            }

                            @Override
                            public TailcatReconnectStateMachine.ProbeOutcome probeAndRecover() {
                                Context ctx = appContext;
                                if (ctx == null) {
                                    return new TailcatReconnectStateMachine.ProbeOutcome(false, false, "", false);
                                }
                                ProbeResult res = TailcatManager.this.probeAndRecover(ctx, DEFAULT_PROBE_TIMEOUT_MS, true);
                                return new TailcatReconnectStateMachine.ProbeOutcome(
                                        res.reachable, res.restarted, res.localUrl, res.portChanged);
                            }

                            @Override
                            public void onRecovered(boolean restarted, String localUrl, boolean portChanged) {
                                Runnable l = recoveryListener;
                                if (l != null) {
                                    try { l.run(); } catch (Throwable ignored) {}
                                }
                            }

                            @Override
                            public void onDirectNetworkRestored() {
                                Runnable l = recoveryListener;
                                if (l != null) {
                                    try { l.run(); } catch (Throwable ignored) {}
                                }
                            }

                            @Override
                            public void onNetworkAvailabilityChanged(boolean hasInternet) {
                                NetworkChangeListener l = networkChangeListener;
                                if (l != null) {
                                    try { l.onNetworkChanged(hasInternet); } catch (Throwable ignored) {}
                                }
                            }
                        }
                );
            }
            return this.reconnectEngine;
        }
    }

    private ConnectivityManager resolveConnectivityManager() {
        ConnectivityManager cm = connectivityManager;
        if (cm != null) return cm;
        Context ctx = appContext;
        if (ctx != null) {
            try {
                cm = ctx.getSystemService(ConnectivityManager.class);
                if (cm != null) connectivityManager = cm;
            } catch (Throwable ignored) {}
        }
        return cm;
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

    public static int extractLoopbackPort(String url) {
        if (url == null || url.isEmpty()) return 0;
        try {
            String trimmed = url.trim();
            int q = trimmed.indexOf('?');
            if (q >= 0) trimmed = trimmed.substring(0, q);
            int h = trimmed.indexOf('#');
            if (h >= 0) trimmed = trimmed.substring(0, h);
            URI uri = URI.create(trimmed);
            String host = uri.getHost();
            if (!GatewayEndpointRouter.isLoopbackHost(host)) return 0;
            int port = uri.getPort();
            return (port >= 1 && port <= 65535) ? port : 0;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    public void rememberLoopbackUrl(String url) {
        int port = extractLoopbackPort(url);
        if (port > 0) {
            rememberLoopbackPort(port);
        }
    }

    public void rememberLoopbackPort(int port) {
        if (port < 1 || port > 65535) return;
        synchronized (lock) {
            recordLoopbackPortLocked(port);
            if (preferredPort <= 0) {
                preferredPort = port;
            }
        }
    }

    public boolean isKnownTailcatPort(int port) {
        if (port < 1 || port > 65535) return false;
        synchronized (lock) {
            if (active != null && extractLoopbackPort(active.localUrl) == port) {
                return true;
            }
            return knownLoopbackPorts.contains(port);
        }
    }

    private void recordLoopbackPortLocked(int port) {
        if (port < 1 || port > 65535) return;
        knownLoopbackPorts.remove(port);
        knownLoopbackPorts.add(port);
        Iterator<Integer> it = knownLoopbackPorts.iterator();
        while (knownLoopbackPorts.size() > MAX_KNOWN_LOOPBACK_PORTS && it.hasNext()) {
            it.next();
            it.remove();
        }
    }

    public TunnelSession startPending(Context context, String input, String reuseIdentity) {
        return startTunnelInternal(context, input, reuseIdentity, 0);
    }

    private TunnelSession startTunnelInternal(Context context, String input, String reuseIdentity, int desiredPort) {
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

        TunnelSession started = tryStartOnce(link, identityObj, desiredPort);
        if (started == null && desiredPort > 0) {
            Log.i(TAG, "Tailcat localPort " + desiredPort + " unavailable; falling back to ephemeral port");
            started = tryStartOnce(link, identityObj, 0);
        }
        if (started == null) {
            throw new IllegalStateException(Localize.t(context,
                    "无法连接，请检查 Tailcat 链接后重试。",
                    "Could not connect. Check the Tailcat link and try again."));
        }
        return started;
    }

    private TunnelSession tryStartOnce(String link, JSONObject identityObj, int localPort) {
        JSONObject config = new JSONObject();
        try {
            config.put("mode", "forward");
            config.put("link", link);
            config.put("identity", identityObj);
            if (localPort >= 1 && localPort <= 65535) {
                config.put("localPort", localPort);
            }
        } catch (Exception e) {
            throw new IllegalStateException("Tailcat config build failed", e);
        }

        JSONObject reply;
        try {
            reply = new JSONObject(TailcatBridge.safeStart(config.toString()));
        } catch (Exception e) {
            return null;
        }
        int handle = reply.optInt("handle", 0);
        JSONObject status = reply.optJSONObject("status");
        String localUrl = status != null ? status.optString("localURL", "") : "";
        boolean listening = status != null && status.optBoolean("listening", false);
        if (handle <= 0 || !listening || !localUrl.startsWith("http://127.0.0.1:")) {
            if (handle > 0) TailcatBridge.safeStop(handle);
            return null;
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
            if (old != null) {
                recordLoopbackPortLocked(extractLoopbackPort(old.localUrl));
            }
            int nextPort = extractLoopbackPort(pending.localUrl);
            if (nextPort > 0) {
                recordLoopbackPortLocked(nextPort);
                preferredPort = nextPort;
            }
            unhealthySinceMs = 0L;
            wasReady = false;
            lastAttemptMs = 0L;
            failures = 0;
        }
        TailcatReconnectStateMachine engine = reconnectEngine;
        if (engine != null) {
            engine.onTunnelCommitted();
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
        if (context != null && this.appContext == null) {
            Context app = context.getApplicationContext();
            this.appContext = app != null ? app : context;
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
                int curPort = extractLoopbackPort(current.localUrl);
                if (curPort > 0) {
                    recordLoopbackPortLocked(curPort);
                    if (preferredPort <= 0) preferredPort = curPort;
                }
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
            int desiredPort = preferredPort;
            if (current != null) {
                int curPort = extractLoopbackPort(current.localUrl);
                if (curPort > 0) {
                    recordLoopbackPortLocked(curPort);
                    desiredPort = curPort;
                }
                active = null;
                TailcatBridge.safeStop(current.handle);
                restartedTunnel = true;
            } else {
                active = null;
            }
            try {
                TunnelSession restarted = startTunnelInternal(context, tailcatLink, storedIdentity, desiredPort);
                active = restarted;
                int newPort = extractLoopbackPort(restarted.localUrl);
                if (newPort > 0) {
                    recordLoopbackPortLocked(newPort);
                    preferredPort = newPort;
                }
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
        int existingHandle;
        synchronized (lock) {
            existingHandle = active != null ? active.handle : 0;
        }
        String base;
        try {
            base = resolveServerUrl(context, notifyOnReset);
        } catch (Exception e) {
            return new ProbeResult(false, false, "", false);
        }
        if (base == null || base.isEmpty()) return new ProbeResult(false, false, "", false);
        int resolvedHandle;
        synchronized (lock) {
            resolvedHandle = active != null ? active.handle : 0;
        }
        boolean startedFreshInResolve = Storage.isTailcatEnabled(context)
                && resolvedHandle > 0
                && resolvedHandle != existingHandle;
        int initialProbeTimeout = startedFreshInResolve
                ? Math.max(timeoutMs, POST_RESTART_PROBE_TIMEOUT_MS)
                : timeoutMs;
        if (probeHealth(base, initialProbeTimeout)) {
            synchronized (lock) {
                unhealthySinceMs = 0L;
                wasReady = true;
                failures = 0;
            }
            return new ProbeResult(true, startedFreshInResolve, base, false);
        }
        if (!Storage.isTailcatEnabled(context)) {
            return new ProbeResult(false, false, base, false);
        }
        if (startedFreshInResolve) {
            return new ProbeResult(false, true, base, false);
        }

        Log.i(TAG, "Tailcat /health failed on " + base + "; restarting tunnel");
        int oldPort = extractLoopbackPort(base);
        TunnelSession old;
        synchronized (lock) {
            old = active;
            if (old != null) {
                int p = extractLoopbackPort(old.localUrl);
                if (p > 0) {
                    oldPort = p;
                    recordLoopbackPortLocked(p);
                    preferredPort = p;
                }
            } else if (oldPort > 0) {
                recordLoopbackPortLocked(oldPort);
                preferredPort = oldPort;
            }
            active = null;
            unhealthySinceMs = 0L;
            wasReady = false;
            lastAttemptMs = 0L;
            failures = 0;
        }
        if (old != null) TailcatBridge.safeStop(old.handle);

        String next = "";
        try {
            String resolved = resolveServerUrl(context, false);
            if (resolved != null) next = resolved;
        } catch (Exception e) {
            Log.w(TAG, "Tailcat restart failed: " + e.getMessage());
        }
        int newPort = extractLoopbackPort(next);
        boolean portChanged = oldPort > 0 && newPort > 0 && oldPort != newPort;
        if (notifyOnReset) {
            ResetListener l = resetListener;
            if (l != null) l.onTunnelReset();
        }
        boolean healthy = !next.isEmpty() && probeHealth(next, Math.max(timeoutMs, POST_RESTART_PROBE_TIMEOUT_MS));
        if (healthy) {
            synchronized (lock) {
                unhealthySinceMs = 0L;
                wasReady = true;
                failures = 0;
            }
        }
        return new ProbeResult(healthy, true, next, portChanged);
    }

    public void registerNetworkMonitor(Context context, NetworkChangeListener listener) {
        if (context == null) return;
        this.networkChangeListener = listener;
        Context app = context.getApplicationContext();
        this.appContext = app != null ? app : context;
        TailcatReconnectStateMachine engine = ensureReconnectEngine(this.appContext);
        if (monitorRegistered) return;
        ConnectivityManager cm = this.appContext.getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        this.connectivityManager = cm;
        monitorRegistered = true;
        engine.initNetworkSnapshot(snapshotActiveNetwork(cm));
        try {
            cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    resetResolverBackoff();
                    engine.onNetworkAvailable(snapshotForNetwork(cm, network, null, null));
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                    engine.onNetworkCapabilitiesChanged(snapshotForNetwork(cm, network, capabilities, null));
                }

                @Override
                public void onLinkPropertiesChanged(Network network, LinkProperties linkProperties) {
                    engine.onNetworkLinkPropertiesChanged(snapshotForNetwork(cm, network, null, linkProperties));
                }

                @Override
                public void onLost(Network network) {
                    resetResolverBackoff();
                    long lostHandle = network != null ? network.getNetworkHandle() : 0L;
                    engine.onNetworkLost(lostHandle, snapshotActiveNetwork(cm));
                }
            });
        } catch (Exception e) {
            monitorRegistered = false;
        }
    }

    public void onAppForeground(Context context) {
        if (context == null) return;
        resetResolverBackoff();
        ensureReconnectEngine(context).onAppForeground();
    }

    public void onForegroundActivityResumed(Context context) {
        if (context == null) return;
        ensureReconnectEngine(context).onForegroundResumed();
    }

    public void onAppBackground() {
        TailcatReconnectStateMachine engine = reconnectEngine;
        if (engine != null) {
            engine.onAppBackground();
        }
    }

    public void onRequestFailure(Context context) {
        if (context == null || !Storage.isPaired(context) || !Storage.isTailcatEnabled(context)) return;
        ensureReconnectEngine(context).onRequestFailure();
    }

    private void resetResolverBackoff() {
        synchronized (lock) {
            unhealthySinceMs = 0L;
            failures = 0;
            lastAttemptMs = 0L;
        }
    }

    private static TailcatReconnectStateMachine.NetworkSnapshot snapshotActiveNetwork(ConnectivityManager cm) {
        if (cm == null) return TailcatReconnectStateMachine.NetworkSnapshot.offline();
        Network activeNet;
        try {
            activeNet = cm.getActiveNetwork();
        } catch (Throwable ignored) {
            return TailcatReconnectStateMachine.NetworkSnapshot.offline();
        }
        if (activeNet == null) {
            return TailcatReconnectStateMachine.NetworkSnapshot.offline();
        }
        return snapshotForNetwork(cm, activeNet, null, null);
    }

    private static TailcatReconnectStateMachine.NetworkSnapshot snapshotForNetwork(
            ConnectivityManager cm, Network network, NetworkCapabilities capsHint, LinkProperties lpHint) {
        if (network == null) {
            return TailcatReconnectStateMachine.NetworkSnapshot.offline();
        }
        NetworkCapabilities caps = capsHint;
        if (caps == null && cm != null) {
            try {
                caps = cm.getNetworkCapabilities(network);
            } catch (Throwable ignored) {}
        }
        LinkProperties lp = lpHint;
        if (lp == null && cm != null) {
            try {
                lp = cm.getLinkProperties(network);
            } catch (Throwable ignored) {}
        }
        StringBuilder transports = new StringBuilder();
        boolean hasInternet = true;
        boolean validated = false;
        if (caps != null) {
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) transports.append('W');
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) transports.append('C');
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) transports.append('E');
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) transports.append('V');
            hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        }
        String linkFp = buildLinkFingerprint(lp);
        return new TailcatReconnectStateMachine.NetworkSnapshot(
                true, network.getNetworkHandle(), transports.toString(), hasInternet, validated, linkFp);
    }

    private static String buildLinkFingerprint(LinkProperties lp) {
        if (lp == null) return "";
        List<String> parts = new ArrayList<>();
        try {
            String iface = lp.getInterfaceName();
            if (iface != null && !iface.isEmpty()) {
                parts.add("if=" + iface);
            }
        } catch (Throwable ignored) {}
        try {
            List<LinkAddress> addrs = lp.getLinkAddresses();
            if (addrs != null) {
                List<String> ips = new ArrayList<>();
                for (LinkAddress la : addrs) {
                    if (la == null) continue;
                    InetAddress addr = la.getAddress();
                    if (addr == null || addr.isLoopbackAddress() || addr.isLinkLocalAddress()) continue;
                    String host = addr.getHostAddress();
                    if (host != null && !host.isEmpty()) ips.add(host);
                }
                Collections.sort(ips);
                parts.addAll(ips);
            }
        } catch (Throwable ignored) {}
        if (parts.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(parts.get(i));
        }
        return sb.toString();
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
            preferredPort = 0;
            knownLoopbackPorts.clear();
            unhealthySinceMs = 0L;
            wasReady = false;
            lastAttemptMs = 0L;
            failures = 0;
        }
        TailcatReconnectStateMachine engine = reconnectEngine;
        if (engine != null) {
            engine.onClear();
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

package dev.grokbot.nativeapp;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Local-network Grok Bot Host scanner mirroring iOS GBNetworkScanner.m.
 * Combines Android NSD (_grokbot._tcp.), emulator/loopback probes, and fast LAN /24 HTTP /health probing.
 */
public final class LanHostScanner {
    public static final class DiscoveredHost {
        public final String url;
        public final String label;
        public final String source;

        public DiscoveredHost(String url, String label, String source) {
            this.url = url;
            this.label = label;
            this.source = source;
        }
    }

    public interface ScanCallback {
        void onHostFound(DiscoveredHost host);
        void onScanFinished(List<DiscoveredHost> allHosts);
    }

    private LanHostScanner() {}

    public static void scan(Context context, ScanCallback callback) {
        final Context appCtx = context.getApplicationContext();
        final Handler mainHandler = new Handler(Looper.getMainLooper());
        final Map<String, DiscoveredHost> found = Collections.synchronizedMap(new LinkedHashMap<>());
        final AtomicBoolean finished = new AtomicBoolean(false);

        new Thread(() -> {
            NsdManager nsdManager = null;
            NsdManager.DiscoveryListener nsdListener = null;
            try {
                nsdManager = (NsdManager) appCtx.getSystemService(Context.NSD_SERVICE);
                if (nsdManager != null) {
                    final NsdManager mgrRef = nsdManager;
                    nsdListener = new NsdManager.DiscoveryListener() {
                        @Override public void onDiscoveryStarted(String regType) {}
                        @Override public void onDiscoveryStopped(String serviceType) {}
                        @Override public void onStartDiscoveryFailed(String serviceType, int errorCode) {}
                        @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) {}
                        @Override public void onServiceLost(NsdServiceInfo serviceInfo) {}
                        @Override public void onServiceFound(NsdServiceInfo serviceInfo) {
                            try {
                                mgrRef.resolveService(serviceInfo, new NsdManager.ResolveListener() {
                                    @Override public void onResolveFailed(NsdServiceInfo info, int err) {}
                                    @Override public void onServiceResolved(NsdServiceInfo resolved) {
                                        InetAddress addr = resolved.getHost();
                                        int port = resolved.getPort();
                                        if (addr != null && port > 0) {
                                            String url = "http://" + addr.getHostAddress() + ":" + port;
                                            String name = resolved.getServiceName();
                                            DiscoveredHost item = new DiscoveredHost(url,
                                                    name != null && !name.isEmpty() ? name : url,
                                                    "mDNS");
                                            if (!found.containsKey(url)) {
                                                found.put(url, item);
                                                mainHandler.post(() -> callback.onHostFound(item));
                                            }
                                        }
                                    }
                                });
                            } catch (Exception ignored) {}
                        }
                    };
                    nsdManager.discoverServices("_grokbot._tcp.", NsdManager.PROTOCOL_DNS_SD, nsdListener);
                }
            } catch (Exception ignored) {}

            // Priority candidates: Android emulator host bridge + adb reverse loopback first
            List<String> priorityHosts = new ArrayList<>();
            priorityHosts.add("http://10.0.2.2:18080");
            priorityHosts.add("http://127.0.0.1:18080");
            priorityHosts.add("http://10.0.2.2:8000");
            priorityHosts.add("http://127.0.0.1:8000");

            ExecutorService priorityPool = Executors.newFixedThreadPool(4);
            for (String candidateUrl : priorityHosts) {
                priorityPool.execute(() -> {
                    if (finished.get()) return;
                    DiscoveredHost hit = probeHostHealth(candidateUrl, 1200);
                    if (hit != null && !found.containsKey(hit.url)) {
                        found.put(hit.url, hit);
                        mainHandler.post(() -> callback.onHostFound(hit));
                    }
                });
            }
            priorityPool.shutdown();
            try {
                priorityPool.awaitTermination(1500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ignored) {}

            // Active LAN IPv4 /24 sweep (skipped on emulator 10.0.2.x NAT to avoid saturating QEMU slirp)
            String localPrefix = detectIpv4Prefix(appCtx);
            if (localPrefix != null) {
                List<String> lanHosts = new ArrayList<>();
                for (int hostByte = 1; hostByte <= 254; hostByte++) {
                    String ip = localPrefix + "." + hostByte;
                    lanHosts.add("http://" + ip + ":18080");
                    lanHosts.add("http://" + ip + ":8000");
                }
                ExecutorService lanPool = Executors.newFixedThreadPool(24);
                for (String candidateUrl : lanHosts) {
                    lanPool.execute(() -> {
                        if (finished.get()) return;
                        DiscoveredHost hit = probeHostHealth(candidateUrl, 500);
                        if (hit != null && !found.containsKey(hit.url)) {
                            found.put(hit.url, hit);
                            mainHandler.post(() -> callback.onHostFound(hit));
                        }
                    });
                }
                lanPool.shutdown();
                try {
                    lanPool.awaitTermination(2800, TimeUnit.MILLISECONDS);
                } catch (InterruptedException ignored) {}
            }
            finished.set(true);

            if (nsdManager != null && nsdListener != null) {
                try {
                    nsdManager.stopServiceDiscovery(nsdListener);
                } catch (Exception ignored) {}
            }

            List<DiscoveredHost> snapshot;
            synchronized (found) {
                snapshot = new ArrayList<>(found.values());
            }
            mainHandler.post(() -> callback.onScanFinished(snapshot));
        }, "GrokBotLanScan").start();
    }

    private static String detectIpv4Prefix(Context context) {
        try {
            ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
            if (cm == null) return null;
            Network active = cm.getActiveNetwork();
            if (active == null) return null;
            LinkProperties lp = cm.getLinkProperties(active);
            if (lp == null) return null;
            for (LinkAddress la : lp.getLinkAddresses()) {
                InetAddress addr = la.getAddress();
                if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                    String ip = addr.getHostAddress();
                    if (ip != null && !ip.startsWith("10.0.2.")) {
                        int lastDot = ip.lastIndexOf('.');
                        if (lastDot > 0) return ip.substring(0, lastDot);
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private static DiscoveredHost probeHostHealth(String baseUrl, int timeoutMs) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(baseUrl + "/health").openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return null;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null && sb.length() < 4096) {
                    sb.append(line);
                }
            }
            String body = sb.toString().trim();
            JSONObject obj = body.startsWith("{") ? new JSONObject(body) : null;
            if (obj == null || !obj.optBoolean("ok", false)) return null;
            String hostName = obj.optString("hostName", "");
            if (hostName.isEmpty()) hostName = obj.optString("name", "");
            String source = baseUrl.contains("10.0.2.2") ? "Emulator" : (baseUrl.contains("127.0.0.1") ? "Loopback" : "LAN");
            String label = hostName.isEmpty() ? baseUrl : hostName + " (" + baseUrl.replaceFirst("^https?://", "") + ")";
            return new DiscoveredHost(baseUrl, label, source);
        } catch (Exception ignored) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}

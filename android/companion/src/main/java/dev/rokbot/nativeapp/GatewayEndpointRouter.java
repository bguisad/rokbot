package dev.rokbot.nativeapp;

import android.content.Context;
import android.media.audiofx.AcousticEchoCanceler;
import org.json.JSONObject;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Pure R8-safe gateway routing & endpoint classification helpers (zero okhttp3.* imports).
 * Shared by both un-obfuscated NetworkInterceptor and R8-obfuscated R8OkHttpInterceptor.
 */
public final class GatewayEndpointRouter {
    private static final Set<String> DASHBOARD_METHODS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "ListMarketplacePlugins",
            "ListPrivateMarketplacePlugins",
            "ListMarketplaces",
            "GetEffectiveUserPlugins",
            "GetAvailableMcpServers",
            "ListSandMcpTools",
            "ValidateMcpOAuthTokens",
            "InstallUserPlugin",
            "UninstallUserPlugin",
            "UpdateUserPlugin",
            "UpdateUserPluginVariables",
            "UpdateUserPluginInstall",
            "GetTeamPluginPopularity",
            "RenameMcpOAuthAccount",
            "DeleteMcpOAuthAccount",
            "CheckHttpMcpStatus",
            "CompleteMcpOAuth",
            "GetPluginDetails"
    )));

    private static final Set<String> GROKBOT_MOBILE_RPC_METHODS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "GetGrokBotMcpToolPermissions",
            "SetGrokBotMcpToolPermissions",
            "ListPublicGrokBotMarketplaceListings"
    )));

    private GatewayEndpointRouter() {}

    public static String getLastAgentId() {
        return RokBotBootstrap.getLastAgentId();
    }

    public static void setLastAgentId(String agentId) {
        RokBotBootstrap.setLastAgentId(agentId);
    }

    public static boolean shouldObserveAgentIdPath(String path) {
        return "/api/openAgentWindowed".equals(path)
                || "/api/getAgentTranscriptTail".equals(path)
                || "/api/getAgentTranscript".equals(path)
                || "/api/sendPrompt".equals(path);
    }

    public static void observeAgentIdFromJson(byte[] raw) {
        JSONObject obj = parseJsonObject(raw);
        if (obj != null) {
            String id = obj.optString("agentId", "");
            if (id.isEmpty()) id = obj.optString("id", "");
            if (id.isEmpty()) id = obj.optString("agent_id", "");
            if (!id.isEmpty() && id.length() <= 256) {
                setLastAgentId(id);
            }
        }
    }

    public static JSONObject parseJsonObject(byte[] data) {
        if (data == null || data.length == 0) return null;
        try {
            return new JSONObject(new String(data, StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
            return null;
        }
    }

    public static boolean hasSseAcceptHeader(String acceptHeader) {
        return acceptHeader != null && acceptHeader.toLowerCase(Locale.US).contains("text/event-stream");
    }

    public static String resolveGatewayBaseUrl(Context context) {
        String gatewayUrl = TailcatManager.get().resolveServerUrl(context);
        if ((gatewayUrl == null || gatewayUrl.isEmpty()) && !Storage.isTailcatEnabled(context)) {
            gatewayUrl = Storage.getGatewayUrl(context);
        }
        return gatewayUrl;
    }

    public static boolean isLoopbackHost(String host) {
        String h = normalizeHost(host);
        return "127.0.0.1".equals(h) || "localhost".equals(h) || "::1".equals(h) || "[::1]".equals(h);
    }

    public static String resolveDirectServerOriginIfCandidate(Context context, String reqHost) {
        if (context == null || reqHost == null || reqHost.isEmpty()) return null;
        if (Storage.isTailcatEnabled(context)) {
            if (!isLoopbackHost(reqHost)) {
                return null;
            }
            try {
                return TailcatManager.get().resolveServerUrl(context);
            } catch (RuntimeException ignored) {
                return null;
            }
        }
        return Storage.getGatewayUrl(context);
    }

    public static int effectivePort(URI uri) {
        if (uri == null) return -1;
        int port = uri.getPort();
        if (port > 0) return port;
        String scheme = uri.getScheme();
        if ("https".equalsIgnoreCase(scheme) || "wss".equalsIgnoreCase(scheme)) return 443;
        if ("http".equalsIgnoreCase(scheme) || "ws".equalsIgnoreCase(scheme)) return 80;
        return -1;
    }

    private static String stripQueryAndFragment(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        int h = s.indexOf('#');
        if (h >= 0) s = s.substring(0, h);
        return s;
    }

    public static boolean matchesServerOrigin(String requestUrl, String serverUrl) {
        if (requestUrl == null || requestUrl.isEmpty() || serverUrl == null || serverUrl.isEmpty()) {
            return false;
        }
        try {
            URI req = URI.create(stripQueryAndFragment(requestUrl));
            URI srv = URI.create(stripQueryAndFragment(serverUrl));
            String rScheme = req.getScheme();
            String sScheme = srv.getScheme();
            String rHost = normalizeHost(req.getHost());
            String sHost = normalizeHost(srv.getHost());
            if (rScheme == null || sScheme == null || !rScheme.equalsIgnoreCase(sScheme)) {
                return false;
            }
            if (rHost.isEmpty() || sHost.isEmpty() || !rHost.equals(sHost)) {
                return false;
            }
            int rPort = effectivePort(req);
            int sPort = effectivePort(srv);
            return rPort > 0 && rPort == sPort;
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static String resolveAudioProcessingMode() {
        boolean aecAvail = false;
        try {
            aecAvail = AcousticEchoCanceler.isAvailable();
        } catch (Throwable ignored) {}
        return aecAvail ? "native-aec3-buffered-v1" : "legacy";
    }

    public static void rewriteVoiceCredentialUrls(Context context, JSONObject cred) {
        if (cred == null) return;
        try {
            for (String key : new String[]{"websocketUrl", "wsUrl", "url"}) {
                String wsVal = cred.optString(key, "");
                if (!wsVal.isEmpty()) {
                    cred.put(key, HostApiClient.rewriteVoiceWebsocketUrl(context, wsVal));
                }
            }
        } catch (Throwable ignored) {}
    }

    public static String getAppIntentMethod(String path) {
        if (path == null) return null;
        String prefix = "/aiserver.v1.GrokBotService/";
        if (!path.startsWith(prefix)) return null;
        String method = path.substring(prefix.length());
        if ("ListGrokBotAgents".equals(method)
                || "SendGrokBotUserMessage".equals(method)
                || "GetGrokBotSendStatus".equals(method)) {
            return method;
        }
        return null;
    }

    public static String getDashboardMethod(String path) {
        if (path == null) return null;
        String dashPrefix = "/aiserver.v1.DashboardService/";
        if (path.startsWith(dashPrefix)) {
            String method = path.substring(dashPrefix.length());
            return DASHBOARD_METHODS.contains(method) ? method : null;
        }
        String grokPrefix = "/aiserver.v1.GrokBotService/";
        if (path.startsWith(grokPrefix)) {
            String method = path.substring(grokPrefix.length());
            return GROKBOT_MOBILE_RPC_METHODS.contains(method) ? method : null;
        }
        return null;
    }

    public static String rewriteRpcPath(String path) {
        if (path == null) return null;
        if ("/aiserver.v1.GrokBotService/MintSandVoiceCallSecret".equals(path)) {
            return "/local/voice/session";
        }
        if ("/aiserver.v1.AiService/TranscribeAudio".equals(path)) {
            return "/local/audio/transcriptions";
        }
        String appIntentMethod = getAppIntentMethod(path);
        if (appIntentMethod != null) {
            return "/local/app-intents/" + appIntentMethod;
        }
        String dashMethod = getDashboardMethod(path);
        if (dashMethod != null) {
            return "/local/mobile-rpc/" + dashMethod;
        }
        return path;
    }

    public static boolean isTelemetryPath(String path) {
        return "/aiserver.v1.AnalyticsService/TrackEvents".equals(path)
                || "/aiserver.v1.AnalyticsService/SubmitLogs".equals(path);
    }

    public static String normalizeHost(String host) {
        if (host == null) return "";
        String h = host.trim().toLowerCase(Locale.US);
        while (h.endsWith(".")) {
            h = h.substring(0, h.length() - 1);
        }
        return h;
    }

    private static boolean matchesDomain(String host, String domain) {
        return host.equals(domain) || host.endsWith("." + domain);
    }

    public static boolean isTelemetryHost(String host) {
        String h = normalizeHost(host);
        if (h.isEmpty()) return false;
        return matchesDomain(h, "sentry.io")
                || matchesDomain(h, "appboy.com")
                || matchesDomain(h, "braze.com")
                || matchesDomain(h, "appsflyer.com")
                || matchesDomain(h, "appsflyersdk.com")
                || matchesDomain(h, "statsig.com")
                || matchesDomain(h, "statsigcdn.com")
                || matchesDomain(h, "statsigapi.net")
                || matchesDomain(h, "api3.cursor.sh")
                || matchesDomain(h, "u.expo.dev");
    }

    public static boolean isTargetCloudEndpoint(String host) {
        String h = normalizeHost(host);
        if (h.isEmpty()) return false;
        return matchesDomain(h, "grok.bot")
                || matchesDomain(h, "grok.ai")
                || matchesDomain(h, "grok.com")
                || matchesDomain(h, "x.ai")
                || matchesDomain(h, "api2.cursor.sh")
                || matchesDomain(h, "sand.cursor.sh")
                || matchesDomain(h, "cursor.sh")
                || matchesDomain(h, "cursor.com")
                || matchesDomain(h, "anysphere.co")
                || matchesDomain(h, "rokbot.local");
    }
}

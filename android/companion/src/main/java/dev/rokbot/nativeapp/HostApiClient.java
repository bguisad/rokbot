package dev.rokbot.nativeapp;

import android.content.Context;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

public class HostApiClient {
    public static final int CHUNK_BYTES = 4 * 1024 * 1024;
    public static final long REGULAR_FILE_LIMIT = 25L * 1024 * 1024;
    public static final long VIDEO_FILE_LIMIT = 200L * 1024 * 1024;
    public static final long LIBRARY_FILE_LIMIT = 20L * 1024 * 1024;

    public static class ApiException extends IOException {
        public final int statusCode;
        public ApiException(int statusCode, String message) {
            super(message);
            this.statusCode = statusCode;
        }
    }

    public static class PairResult {
        public final String deviceId;
        public final String token;
        public final String gatewayUrl;
        public final String notificationUrl;
        public final boolean tailcat;
        public final String canonicalAddress;
        public final String networkIdentity;
        public final String reportedGatewayUrl;

        public PairResult(String deviceId, String token, String gatewayUrl, String notificationUrl) {
            this(deviceId, token, gatewayUrl, notificationUrl, false, gatewayUrl, "", "");
        }

        public PairResult(String deviceId, String token, String gatewayUrl, String notificationUrl,
                          boolean tailcat, String canonicalAddress, String networkIdentity) {
            this(deviceId, token, gatewayUrl, notificationUrl, tailcat, canonicalAddress, networkIdentity, "");
        }

        public PairResult(String deviceId, String token, String gatewayUrl, String notificationUrl,
                          boolean tailcat, String canonicalAddress, String networkIdentity, String reportedGatewayUrl) {
            this.deviceId = deviceId;
            this.token = token;
            this.gatewayUrl = gatewayUrl;
            this.notificationUrl = notificationUrl;
            this.tailcat = tailcat;
            this.canonicalAddress = canonicalAddress;
            this.networkIdentity = networkIdentity != null ? networkIdentity : "";
            this.reportedGatewayUrl = reportedGatewayUrl != null ? reportedGatewayUrl : "";
        }
    }

    public static class AttachmentData {
        public final byte[] bytes;
        public final String mime;
        public AttachmentData(byte[] bytes, String mime) {
            this.bytes = bytes;
            this.mime = mime;
        }
    }

    public interface SseListener {
        default void onOpening(Closeable stream) {}
        void onConnected();
        void onEvent(String id, String event, String data);
    }

    public interface ActiveCheck {
        boolean isActive();
    }

    public interface ProgressListener {
        void onProgress(long sentBytes, long totalBytes);
    }

    public static String halfWidth(String input) {
        if (input == null) return "";
        String norm = Normalizer.normalize(input, Normalizer.Form.NFKC).replace('\u3002', '.');
        StringBuilder sb = new StringBuilder(norm.length());
        for (int i = 0; i < norm.length(); i++) {
            char c = norm.charAt(i);
            if (!Character.isWhitespace(c)) sb.append(c);
        }
        return sb.toString();
    }

    public static String normalizeServerUrl(String rawInput) throws ApiException {
        String cleaned = halfWidth(rawInput);
        if (cleaned.isEmpty()) {
            throw new ApiException(400, "Enter the Host http:// or https:// address.");
        }
        URI uri;
        try {
            uri = URI.create(cleaned);
        } catch (Exception e) {
            throw new ApiException(400, "Invalid Host URL.");
        }
        String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.US) : "";
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new ApiException(400, "Host URL must start with http:// or https://");
        }
        if (uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new ApiException(400, "Host URL must not include credentials, query, or fragment.");
        }
        String rawPath = uri.getRawPath();
        if (rawPath != null && !rawPath.isEmpty() && !"/".equals(rawPath)) {
            throw new ApiException(400, "Host URL must be an origin without a path.");
        }
        String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
        if (host.isEmpty()) {
            throw new ApiException(400, "Host URL is missing a valid hostname.");
        }
        int port = uri.getPort();
        if (port != -1 && (port < 1 || port > 65535)) {
            throw new ApiException(400, "Host URL port is out of range.");
        }
        boolean defaultPort = port == -1 || ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
        return defaultPort ? (scheme + "://" + host) : (scheme + "://" + host + ":" + port);
    }

    public static String deviceName(Context context) {
        String named = null;
        try {
            named = Settings.Global.getString(context.getContentResolver(), Settings.Global.DEVICE_NAME);
        } catch (Throwable ignored) {}
        String raw = (named != null && !named.trim().isEmpty())
            ? named.trim()
            : ((Build.MANUFACTURER != null ? Build.MANUFACTURER : "") + " " + (Build.MODEL != null ? Build.MODEL : "")).trim();
        if (raw.isEmpty()) return "Android";
        return raw.length() > 80 ? raw.substring(0, 80) : raw;
    }

    public static String clientDeviceId(Context context) {
        try {
            String androidId = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
            if (androidId != null && !androidId.trim().isEmpty() && !"9774d56d682e549c".equalsIgnoreCase(androidId.trim())) {
                String raw = androidId.trim() + ":" + context.getPackageName();
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] digest = md.digest(raw.getBytes(StandardCharsets.UTF_8));
                StringBuilder hex = new StringBuilder("android-");
                for (int i = 0; i < 16 && i < digest.length; i++) {
                    int b = digest[i] & 0xff;
                    if (b < 16) hex.append('0');
                    hex.append(Integer.toHexString(b));
                }
                return hex.toString();
            }
        } catch (Throwable ignored) {}
        return Storage.getOrCreateClientDeviceId(context);
    }

    public static PairResult pair(Context context, String rawAddress, String pairingKey, String password) throws Exception {
        return pair(context, rawAddress, pairingKey, password, TailcatManager.looksLikeTailcatInput(rawAddress));
    }

    public static PairResult pair(Context context, String rawAddress, String pairingKey, String password, boolean isTailcat) throws Exception {
        String trimmedKey = halfWidth(pairingKey).toUpperCase(Locale.US);
        boolean byPassword = password != null && !password.isEmpty();

        if (byPassword && !trimmedKey.isEmpty()) {
            throw new ApiException(400, Localize.t(context,
                    "请只填写配对码或管理员密码其中之一。",
                    "Provide either a pairing code or admin password, not both."));
        }
        JSONObject payload = new JSONObject();
        payload.put("deviceName", deviceName(context));
        payload.put("platform", "desktop");
        payload.put("clientKind", "android");
        payload.put("clientDeviceId", clientDeviceId(context));
        payload.put("bundleId", context.getPackageName());
        if (byPassword) {
            if (password.length() > 128) {
                throw new ApiException(400, Localize.t(context, "管理员密码过长。", "Admin password too long."));
            }
            payload.put("password", password);
        } else {
            if (trimmedKey.isEmpty()) {
                throw new ApiException(400, Localize.t(context, "请输入 6 位配对码。", "Enter a 6-character pairing code."));
            }
            payload.put("pairingKey", trimmedKey);
        }

        TailcatManager.TunnelSession pending = null;
        boolean committed = false;
        String server;
        String canonicalAddress;
        if (isTailcat) {
            canonicalAddress = TailcatManager.normalizeLink(context, rawAddress);
            String existingId = Storage.getTailcatIdentity(context);
            pending = TailcatManager.get().startPending(context, canonicalAddress, existingId);
            server = pending.localUrl;
        } else {
            server = normalizeServerUrl(rawAddress);
            canonicalAddress = server;
        }

        try {
            HttpResult res = rawRequest(
                    server + "/connect/pair",
                    "POST",
                    null,
                    payload.toString().getBytes(StandardCharsets.UTF_8),
                    "application/json",
                    15000,
                    35000,
                    false);
            JSONObject json = parseJsonObject(res.body);
            if (res.code < 200 || res.code >= 300) {
                String msg = json != null ? UiChrome.jsonStr(json, "error") : "";
                if (msg.isEmpty()) msg = json != null ? UiChrome.jsonStr(json, "message") : "";
                if (msg.isEmpty()) {
                    if (res.code == 401) {
                        msg = byPassword
                                ? Localize.t(context, "管理员密码不正确。", "Admin password is incorrect.")
                                : Localize.t(context, "配对码无效或已过期。", "Pairing code is invalid or expired.");
                    } else if (res.code == 429) {
                        msg = Localize.t(context, "尝试次数过多，请稍后再试。", "Too many attempts. Try again later.");
                    } else {
                        msg = Localize.t(context, "配对失败 (HTTP " + res.code + ")", "Pairing failed (HTTP " + res.code + ")");
                    }
                }
                throw new ApiException(res.code, msg);
            }
            if (json == null) {
                throw new ApiException(502, Localize.t(context, "Host 返回了无效的 JSON。", "Host returned invalid JSON."));
            }
            String token = UiChrome.jsonStr(json, "token");
            String deviceId = UiChrome.jsonStr(json, "deviceId");
            String gatewayRaw = UiChrome.jsonStr(json, "gatewayUrl").trim();
            String notificationUrl = UiChrome.jsonStr(json, "notificationUrl", server + "/notifications/events");
            if (token.length() < 16 || deviceId.isEmpty()) {
                throw new ApiException(502, Localize.t(context, "Host 返回了无效的设备凭证。", "Host returned invalid device credentials."));
            }
            String reportedGatewayUrl = !gatewayRaw.isEmpty() ? normalizeServerUrl(gatewayRaw) : "";
            if (isTailcat) {
                TailcatManager.get().commitPending(pending);
                committed = true;
                return new PairResult(deviceId, token, canonicalAddress, notificationUrl, true, canonicalAddress, pending.identityJson, reportedGatewayUrl);
            } else {
                return new PairResult(deviceId, token, server, notificationUrl, false, server, "", reportedGatewayUrl);
            }
        } finally {
            if (pending != null && !committed) {
                TailcatManager.get().dropPending(pending);
            }
        }
    }

    public static JSONObject checkStatus(String server, String token) throws Exception {
        String normalized = normalizeServerUrl(server);
        HttpResult res = rawRequest(normalized + "/connect/status", "GET", token, null, null, 10000, 20000, false);
        return requireJsonObject(res);
    }

    public static JSONObject getHostStatus(Context context) throws Exception {
        HttpResult res = authedRequest(context, "GET", "/local/status", null, 8000, null);
        return requireJsonObject(res);
    }

    private static Map<String, String> adminStepUpHeaders(String adminPassword) {
        if (adminPassword == null || adminPassword.isEmpty()) return null;
        return Collections.singletonMap("x-rokbot-admin-password", adminPassword);
    }

    public static JSONObject getModelConfig(Context context, String adminPassword) throws Exception {
        HttpResult res = authedRequest(context, "GET", "/local/model", null, 20000, adminStepUpHeaders(adminPassword));
        return requireJsonObject(res);
    }

    public static JSONObject saveModelConfig(Context context, JSONObject configPayload, String adminPassword) throws Exception {
        HttpResult res = authedRequest(
                context,
                "PUT",
                "/local/model",
                configPayload != null ? configPayload : new JSONObject(),
                30000,
                adminStepUpHeaders(adminPassword));
        return requireJsonObject(res);
    }

    public static JSONObject fetchModelCatalog(Context context, JSONObject requestPayload, String adminPassword) throws Exception {
        HttpResult res = authedRequest(
                context,
                "POST",
                "/local/model/catalog",
                requestPayload != null ? requestPayload : new JSONObject(),
                25000,
                adminStepUpHeaders(adminPassword));
        return requireJsonObject(res);
    }

    public static JSONObject testModelConfig(Context context, JSONObject requestPayload, String adminPassword) throws Exception {
        HttpResult res = authedRequest(
                context,
                "POST",
                "/local/model/test",
                requestPayload != null ? requestPayload : new JSONObject(),
                125000,
                adminStepUpHeaders(adminPassword));
        return requireJsonObject(res);
    }

    public static JSONArray listAgents(Context context) throws Exception {
        HttpResult res = authedPost(context, "/api/listAgents", new JSONObject());
        if (res.code < 200 || res.code >= 300) throw toException(res);
        String text = new String(res.body, StandardCharsets.UTF_8).trim();
        if (text.startsWith("[")) return new JSONArray(text);
        JSONObject obj = parseJsonObject(res.body);
        if (obj != null && obj.has("agents")) return obj.getJSONArray("agents");
        throw new ApiException(502, "Unexpected listAgents response");
    }

    public static JSONObject getTranscriptTail(Context context, String agentId, Long beforeSeq, int limit) throws Exception {
        JSONObject req = new JSONObject();
        req.put("id", agentId);
        if (beforeSeq != null) req.put("beforeSeq", beforeSeq);
        req.put("limit", limit);
        HttpResult res = authedPost(context, "/api/getAgentTranscriptTail", req);
        return requireJsonObject(res);
    }

    public static JSONObject sendPrompt(Context context, String agentId, String clientNonce, String prompt,
                                        List<String> attachmentPaths, List<String> attachmentNames) throws Exception {
        JSONObject req = new JSONObject();
        req.put("agentId", agentId);
        req.put("clientNonce", clientNonce != null && !clientNonce.isEmpty() ? clientNonce : UUID.randomUUID().toString());
        req.put("prompt", prompt != null ? prompt : "");
        req.put("directAddressedAcceptance", true);
        if (attachmentPaths != null && !attachmentPaths.isEmpty()) {
            req.put("attachmentPaths", new JSONArray(attachmentPaths));
            req.put("attachmentNames", new JSONArray(attachmentNames != null ? attachmentNames : attachmentPaths));
        }
        HttpResult res = authedPost(context, "/api/sendPrompt", req);
        return requireJsonObject(res);
    }

    public static JSONObject interruptAgentRun(Context context, String agentId) throws Exception {
        JSONObject req = new JSONObject().put("id", agentId);
        HttpResult res = authedPost(context, "/api/interruptAgentRun", req);
        return requireJsonObject(res);
    }

    public static JSONObject createGroup(Context context, String name, String description, List<String> memberAgentIds) throws Exception {
        JSONObject req = new JSONObject();
        req.put("name", name != null ? name.trim() : "");
        req.put("description", description != null ? description.trim() : "");
        JSONArray members = new JSONArray();
        if (memberAgentIds != null) {
            for (String id : memberAgentIds) {
                if (id != null && !id.trim().isEmpty()) {
                    members.put(id.trim());
                }
            }
        }
        req.put("memberAgentIds", members);
        HttpResult res = authedPost(context, "/api/createGroup", req);
        return requireJsonObject(res);
    }

    public static JSONObject getSuggestions(Context context, String agentId, String lastEntryId, String locale) throws Exception {
        JSONObject req = new JSONObject();
        if (agentId != null && !agentId.trim().isEmpty()) {
            req.put("agentId", agentId.trim());
        }
        if (lastEntryId != null && !lastEntryId.trim().isEmpty()) {
            req.put("lastEntryId", lastEntryId.trim());
        }
        if (locale != null && !locale.trim().isEmpty()) {
            req.put("locale", locale.trim());
        }
        HttpResult res = authedRequest(context, "POST", "/local/suggestions", req, 18000, null);
        return requireJsonObject(res);
    }

    /** Client read timeout of /local/suggestions/complete (the Host gives the model 8 s). */
    static final int COMPLETION_TIMEOUT_MS = 9000;

    /**
     * Lets another thread abort an in-flight request: {@link #cancel()} disconnects the
     * HttpURLConnection, which closes the socket so the Host aborts the model call.
     */
    public static final class CancelHandle {
        private volatile HttpURLConnection mConn;
        private volatile boolean mCancelled;

        public void cancel() {
            mCancelled = true;
            HttpURLConnection c = mConn;
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }

        public boolean isCancelled() {
            return mCancelled;
        }

        void attach(HttpURLConnection conn) throws IOException {
            mConn = conn;
            if (mCancelled) {
                conn.disconnect();
                throw new IOException("cancelled");
            }
        }
    }

    /**
     * POST /local/suggestions/complete: the predicted rest of {@code text} (the whole draft).
     * Response: { enabled, text, completion (suffix only, '' = nothing), source, cached, lang? }.
     */
    public static JSONObject complete(Context context, String agentId, String text, String locale,
                                      CancelHandle cancel) throws Exception {
        JSONObject req = new JSONObject();
        if (agentId != null && !agentId.trim().isEmpty()) {
            req.put("agentId", agentId.trim());
        }
        req.put("text", text != null ? text : "");
        if (locale != null && !locale.trim().isEmpty()) {
            req.put("locale", locale.trim());
        }
        String server = resolveServer(context);
        String token = Storage.getToken(context);
        if (server == null || server.isEmpty() || token == null || token.isEmpty()) {
            throw new ApiException(401, Localize.t(context, "设备尚未配对。", "Device is not paired."));
        }
        byte[] payload = req.toString().getBytes(StandardCharsets.UTF_8);
        HttpResult res = rawRequest(server + "/local/suggestions/complete", "POST", token, payload, "application/json",
                5000, COMPLETION_TIMEOUT_MS, RokBotBootstrap.isForeground(), null, cancel);
        return requireJsonObject(res);
    }

    public static JSONObject getSuggestionsSettings(Context context) throws Exception {
        HttpResult res = authedRequest(context, "GET", "/local/suggestions/settings", null, 10000, null);
        return requireJsonObject(res);
    }

    public static JSONObject updateSuggestionsSettings(Context context, Boolean enabled, Boolean aiEnabled) throws Exception {
        return updateSuggestionsSettings(context, enabled, aiEnabled, null);
    }

    /** PUT /local/suggestions/settings; null fields are left untouched (completionEnabled alone is accepted). */
    public static JSONObject updateSuggestionsSettings(Context context, Boolean enabled, Boolean aiEnabled,
                                                       Boolean completionEnabled) throws Exception {
        JSONObject req = new JSONObject();
        if (enabled != null) req.put("enabled", enabled.booleanValue());
        if (aiEnabled != null) req.put("aiEnabled", aiEnabled.booleanValue());
        if (completionEnabled != null) req.put("completionEnabled", completionEnabled.booleanValue());
        HttpResult res = authedRequest(context, "PUT", "/local/suggestions/settings", req, 10000, null);
        return requireJsonObject(res);
    }

    public static JSONObject addQuickPhrase(Context context, String text) throws Exception {
        JSONObject req = new JSONObject();
        req.put("text", text != null ? text : "");
        HttpResult res = authedRequest(context, "POST", "/local/suggestions/phrases", req, 10000, null);
        return requireJsonObject(res);
    }

    public static JSONObject updateQuickPhrase(Context context, String id, String text) throws Exception {
        JSONObject req = new JSONObject();
        req.put("text", text != null ? text : "");
        HttpResult res = authedRequest(context, "PUT", "/local/suggestions/phrases/" + encodePath(id), req, 10000, null);
        return requireJsonObject(res);
    }

    public static JSONObject deleteQuickPhrase(Context context, String id) throws Exception {
        HttpResult res = authedRequest(context, "DELETE", "/local/suggestions/phrases/" + encodePath(id), null, 10000, null);
        return requireJsonObject(res);
    }

    public static JSONObject reorderQuickPhrases(Context context, List<String> ids) throws Exception {
        JSONObject req = new JSONObject();
        JSONArray arr = new JSONArray();
        if (ids != null) {
            for (String id : ids) {
                if (id != null && !id.isEmpty()) arr.put(id);
            }
        }
        req.put("ids", arr);
        HttpResult res = authedRequest(context, "PUT", "/local/suggestions/phrases/reorder", req, 10000, null);
        return requireJsonObject(res);
    }

    private static String encodePath(String segment) {
        if (segment == null) return "";
        try {
            return java.net.URLEncoder.encode(segment, "UTF-8").replace("+", "%20");
        } catch (Exception ignored) {
            return segment;
        }
    }

    public static String uploadAttachmentChunked(Context context, String agentId, String filename,
                                               InputStream in, long totalSize, ProgressListener progress) throws Exception {
        String lower = filename != null ? filename.toLowerCase(Locale.US) : "";
        boolean isVideo = lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".webm")
            || lower.endsWith(".mkv") || lower.endsWith(".avi") || lower.endsWith(".m4v")
            || lower.endsWith(".mpeg") || lower.endsWith(".mpg") || lower.endsWith(".ogv");
        long maxSize = isVideo ? VIDEO_FILE_LIMIT : REGULAR_FILE_LIMIT;
        if (totalSize <= 0 || totalSize > maxSize) {
            throw new ApiException(413, "Attachment is empty or exceeds limit (" + (maxSize / (1024 * 1024)) + " MB)");
        }
        String uploadId = UUID.randomUUID().toString();
        byte[] buffer = new byte[CHUNK_BYTES];
        long offset = 0;
        String committedPath = null;
        while (offset < totalSize) {
            int maxRead = (int) Math.min(buffer.length, totalSize - offset);
            int readTotal = 0;
            while (readTotal < maxRead) {
                int n = in.read(buffer, readTotal, maxRead - readTotal);
                if (n < 0) break;
                readTotal += n;
            }
            if (readTotal <= 0) throw new ApiException(400, "Unexpected end of attachment stream");
            String b64 = Base64.encodeToString(buffer, 0, readTotal, Base64.NO_WRAP);
            JSONObject chunk = new JSONObject();
            chunk.put("agentId", agentId);
            chunk.put("uploadId", uploadId);
            chunk.put("filename", filename);
            chunk.put("offset", offset);
            chunk.put("totalSize", totalSize);
            chunk.put("bytesBase64", b64);
            HttpResult res = authedPost(context, "/api/uploadAttachmentChunk", chunk, 120000);
            JSONObject reply = requireJsonObject(res);
            offset += readTotal;
            if (progress != null) progress.onProgress(offset, totalSize);
            if (reply.has("committedPath") && !reply.isNull("committedPath")) {
                committedPath = reply.getString("committedPath");
            }
        }
        if (committedPath == null || committedPath.isEmpty()) {
            throw new ApiException(502, "Upload finished without committedPath");
        }
        return committedPath;
    }

    public static String fetchAttachmentDataUrl(Context context, String url) throws Exception {
        String normalized = url != null ? url.trim() : "";
        if (normalized.startsWith("/")) {
            normalized = "file://" + normalized;
        }
        JSONObject req = new JSONObject().put("url", normalized);
        HttpResult res = authedPost(context, "/connect/attachment", req);
        JSONObject reply = requireJsonObject(res);
        return reply.optString("dataUrl", "");
    }

    public static JSONObject listLibraryFiles(Context context, String agentId) throws Exception {
        HttpResult res = authedGet(context, "/local/files?agentId=" + encodeQuery(agentId));
        return requireJsonObject(res);
    }

    public static JSONObject uploadLibraryFile(Context context, String agentId, String fileName, String contentType, byte[] data) throws Exception {
        if (data.length > LIBRARY_FILE_LIMIT) {
            throw new ApiException(413, "Library files are limited to 20 MiB.");
        }
        JSONObject req = new JSONObject();
        req.put("agentId", agentId);
        req.put("fileName", fileName);
        req.put("contentType", contentType != null && !contentType.isEmpty() ? contentType : "application/octet-stream");
        req.put("base64", Base64.encodeToString(data, Base64.NO_WRAP));
        HttpResult res = authedPost(context, "/local/files", req, 60000);
        return requireJsonObject(res);
    }

    public static JSONObject deleteLibraryFile(Context context, String agentId, String fileName) throws Exception {
        JSONObject req = new JSONObject();
        req.put("agentId", agentId);
        req.put("name", fileName);
        HttpResult res = authedRequest(context, "DELETE", "/local/files", req, 20000);
        return requireJsonObject(res);
    }

    public static byte[] downloadLibraryFile(Context context, String agentId, String fileName) throws Exception {
        HttpResult res = authedGet(context, "/local/files/content?agentId=" + encodeQuery(agentId) + "&name=" + encodeQuery(fileName));
        if (res.code < 200 || res.code >= 300) throw toException(res);
        return res.body;
    }

    public static String transcribeAudio(Context context, byte[] audioBytes, String mimeType, String language) throws Exception {
        JSONObject req = new JSONObject();
        req.put("audioBase64", Base64.encodeToString(audioBytes, Base64.NO_WRAP));
        req.put("mimeType", mimeType != null ? mimeType : "audio/wav");
        if (language != null && !language.isEmpty()) req.put("language", language);
        HttpResult res = authedPost(context, "/local/audio/transcriptions", req, 125000);
        JSONObject reply = requireJsonObject(res);
        return reply.optString("text", "");
    }

    public static JSONObject createVoiceSession(Context context, String agentId, String audioProcessing) throws Exception {
        JSONObject req = new JSONObject();
        req.put("agentId", agentId);
        req.put("audioProcessing", audioProcessing != null ? audioProcessing : "legacy");
        HttpResult res = authedPost(context, "/local/voice/session", req, 30000);
        return requireJsonObject(res);
    }

    public static JSONObject getVoiceStatus(Context context) throws Exception {
        HttpResult res = authedGet(context, "/local/voice/status");
        return requireJsonObject(res);
    }

    public static JSONObject getProfile(Context context) throws Exception {
        HttpResult res = authedGet(context, "/local/profile");
        return requireJsonObject(res);
    }

    public static JSONObject updateProfile(Context context, String displayName, String avatarDataUrl) throws Exception {
        JSONObject req = new JSONObject();
        if (displayName != null) req.put("displayName", displayName);
        req.put("avatarDataUrl", (avatarDataUrl != null && !avatarDataUrl.isEmpty()) ? avatarDataUrl : JSONObject.NULL);
        HttpResult res = authedRequest(context, "PUT", "/local/profile", req, 30000);
        return requireJsonObject(res);
    }

    public static JSONObject getUsage(Context context) throws Exception {
        String tz = TimeZone.getDefault().getID();
        HttpResult res = authedGet(context, "/local/usage?timeZone=" + encodeQuery(tz));
        return requireJsonObject(res);
    }

    /**
     * GET /local/usage in the device time zone. `period` ("today", "7d" or "30d") keeps only that
     * period in periods[]; null or empty returns every period (the 30-day ranking colours the models).
     */
    public static JSONObject getUsage(Context context, String period) throws Exception {
        String tz = TimeZone.getDefault().getID();
        String path = "/local/usage?timeZone=" + encodeQuery(tz);
        if (period != null && !period.trim().isEmpty()) path += "&period=" + encodeQuery(period.trim());
        HttpResult res = authedGet(context, path);
        return requireJsonObject(res);
    }

    public static JSONObject getComputers(Context context) throws Exception {
        HttpResult res = authedGet(context, "/local/computers");
        return requireJsonObject(res);
    }

    public static JSONObject createAgent(Context context, String name, String title, String description) throws Exception {
        JSONObject req = new JSONObject();
        req.put("name", name != null ? name.trim() : "");
        req.put("description", description != null ? description.trim() : "");
        if (title != null && !title.trim().isEmpty()) req.put("title", title.trim());
        HttpResult res = authedPost(context, "/api/createAgent", req, 30000);
        return requireJsonObject(res);
    }

    public static JSONObject updateAgent(Context context, String agentId, String name, String title, String description) throws Exception {
        JSONObject profile = new JSONObject();
        profile.put("name", name != null ? name.trim() : "");
        profile.put("description", description != null ? description.trim() : "");
        if (title != null && !title.trim().isEmpty()) profile.put("title", title.trim());
        JSONObject req = new JSONObject();
        req.put("id", agentId);
        req.put("profile", profile);
        HttpResult res = authedPost(context, "/api/updateAgent", req, 30000);
        return requireJsonObject(res);
    }

    public static JSONObject deleteAgents(Context context, List<String> ids) throws Exception {
        JSONObject req = new JSONObject();
        req.put("ids", ids != null ? new JSONArray(ids) : new JSONArray());
        HttpResult res = authedPost(context, "/api/deleteAgents", req, 30000);
        return requireJsonObject(res);
    }

    public static JSONObject getHostSettings(Context context) throws Exception {
        HttpResult res = authedPost(context, "/api/getHostSettings", new JSONObject(), 20000);
        return requireJsonObject(res);
    }

    public static JSONObject setHostSettings(Context context, JSONObject settings) throws Exception {
        HttpResult res = authedPost(context, "/api/setHostSettings", settings != null ? settings : new JSONObject(), 20000);
        return requireJsonObject(res);
    }

    public static JSONObject readAttachmentChunk(Context context, String agentId, String path, long offset, int length) throws Exception {
        JSONObject req = new JSONObject();
        req.put("agentId", agentId != null ? agentId : "");
        req.put("path", path != null ? path : "");
        req.put("offset", Math.max(0L, offset));
        req.put("length", Math.max(1, length));
        HttpResult res = authedPost(context, "/api/readAttachmentChunk", req, 60000);
        return requireJsonObject(res);
    }

    public static AttachmentData readAttachmentAll(Context context, String agentId, String path) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        long offset = 0;
        String mime = "application/octet-stream";
        long totalSize = -1;
        while (offset < REGULAR_FILE_LIMIT) {
            JSONObject chunk = readAttachmentChunk(context, agentId, path, offset, CHUNK_BYTES);
            if (chunk.has("mime") && !chunk.optString("mime", "").isEmpty()) {
                mime = chunk.optString("mime");
            }
            if (chunk.has("totalSize")) {
                totalSize = chunk.optLong("totalSize", totalSize);
            }
            String b64 = chunk.optString("bytesBase64", "");
            if (b64.isEmpty()) break;
            byte[] part = Base64.decode(b64, Base64.DEFAULT);
            if (part.length == 0) break;
            baos.write(part);
            offset += part.length;
            if (totalSize >= 0 && offset >= totalSize) break;
            if (part.length < CHUNK_BYTES) break;
        }
        return new AttachmentData(baos.toByteArray(), mime);
    }

    public static JSONObject getForeverBoxStatus(Context context, String agentId) throws Exception {
        JSONObject req = new JSONObject().put("id", agentId);
        HttpResult res = authedPost(context, "/api/getForeverBoxStatus", req, 20000);
        return requireJsonObject(res);
    }

    public static JSONObject ensureForeverBox(Context context, String agentId) throws Exception {
        JSONObject req = new JSONObject().put("id", agentId);
        HttpResult res = authedPost(context, "/api/ensureForeverBox", req, 60000);
        return requireJsonObject(res);
    }

    public static JSONObject mobileRpc(Context context, String method, JSONObject args) throws Exception {
        HttpResult res = authedPost(context, "/local/mobile-rpc/" + method, args != null ? args : new JSONObject(), 30000);
        return requireJsonObject(res);
    }

    public static JSONObject appIntentRpc(Context context, String method, JSONObject args) throws Exception {
        HttpResult res = authedPost(context, "/local/app-intents/" + method, args != null ? args : new JSONObject(), 30000);
        return requireJsonObject(res);
    }

    private static final String UUID_REGEX =
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

    public static JSONObject shareSkillPublication(Context context, String method, String workflowId, String agentId) throws Exception {
        if (workflowId == null || workflowId.isEmpty() || workflowId.length() > 128
                || !workflowId.matches("^[A-Za-z0-9_-]{1,128}$")) {
            return new JSONObject().put("error", "Invalid request");
        }
        if ("status".equals(method)) {
            if (agentId == null || !agentId.matches(UUID_REGEX)) {
                return new JSONObject().put("error", "Invalid request");
            }
            if (!Storage.isPaired(context)) {
                return new JSONObject().put("error", "Not connected");
            }
            HttpResult res = authedPost(context, "/api/getAgentWorkflows", new JSONObject().put("id", agentId), 30000);
            if (res.code < 200 || res.code >= 300) return new JSONObject().put("error", "Request failed");
            String text = new String(res.body, StandardCharsets.UTF_8).trim();
            if (!text.startsWith("[")) return new JSONObject().put("error", "Invalid response");
            JSONArray rows = new JSONArray(text);
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.optJSONObject(i);
                if (row != null && workflowId.equals(row.optString("id"))) {
                    return new JSONObject().put("published", row.optBoolean("publishedByCurrentUser", false));
                }
            }
            return new JSONObject().put("error", "Skill not found");
        }
        String endpoint;
        if ("publish".equals(method)) endpoint = "/api/publishSkill";
        else if ("sync".equals(method)) endpoint = "/api/resyncPublishedSkill";
        else if ("unpublish".equals(method)) endpoint = "/api/unpublishSkill";
        else return new JSONObject().put("error", "Invalid request");

        if (!Storage.isPaired(context)) {
            return new JSONObject().put("error", "Not connected");
        }
        JSONObject body = new JSONObject().put("workflowId", workflowId).put("teamId", 1);
        HttpResult res = authedPost(context, endpoint, body, 30000);
        if (res.code < 200 || res.code >= 300) return new JSONObject().put("error", "Request failed");
        return new JSONObject().put("published", !"unpublish".equals(method));
    }

    private static boolean matchesVoiceEndpoint(URI ws, String wsScheme, String baseUrl) {
        if (baseUrl == null || baseUrl.isEmpty()) return false;
        try {
            URI hostUri = URI.create(baseUrl);
            String hostScheme = hostUri.getScheme() != null ? hostUri.getScheme().toLowerCase(Locale.US) : "";
            boolean secure = "https".equals(hostScheme);
            if (!wsScheme.equals(secure ? "wss" : "ws")) return false;
            String expectedHost = hostUri.getHost() != null ? hostUri.getHost().toLowerCase(Locale.US) : "";
            String wsHost = ws.getHost() != null ? ws.getHost().toLowerCase(Locale.US) : "";
            if (expectedHost.isEmpty() || !wsHost.equals(expectedHost)) return false;
            int hostPort = hostUri.getPort() != -1 ? hostUri.getPort() : (secure ? 443 : 80);
            int wsPort = ws.getPort() != -1 ? ws.getPort() : ("wss".equals(wsScheme) ? 443 : 80);
            return hostPort == wsPort;
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static String extractVoiceWebsocketUrl(JSONObject credential) {
        if (credential == null) return "";
        for (String key : new String[]{"websocketUrl", "wsUrl", "url"}) {
            String val = credential.optString(key, "").trim();
            if (!val.isEmpty()) return val;
        }
        return "";
    }

    public static String resolveVoiceOrigin(Context context, String rawWsUrl) {
        String wsOrigin = httpOriginFromUrl(rawWsUrl);
        if (!wsOrigin.isEmpty()) return wsOrigin;
        if (context != null) {
            String reported = httpOriginFromUrl(Storage.getReportedGatewayUrl(context));
            if (!reported.isEmpty()) return reported;
            String resolved = httpOriginFromUrl(GatewayEndpointRouter.resolveGatewayBaseUrl(context));
            if (!resolved.isEmpty()) return resolved;
        }
        return null;
    }

    private static String httpOriginFromUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return "";
        try {
            URI u = URI.create(rawUrl.trim());
            String scheme = u.getScheme() != null ? u.getScheme().toLowerCase(Locale.US) : "";
            String host = u.getHost();
            if (host == null || host.isEmpty()) return "";
            String httpScheme;
            if ("https".equals(scheme) || "wss".equals(scheme)) {
                httpScheme = "https";
            } else if ("http".equals(scheme) || "ws".equals(scheme)) {
                httpScheme = "http";
            } else {
                return "";
            }
            int port = u.getPort();
            boolean defaultPort = (port == -1)
                    || ("https".equals(httpScheme) && port == 443)
                    || ("http".equals(httpScheme) && port == 80);
            return httpScheme + "://" + host.toLowerCase(Locale.US) + (defaultPort ? "" : (":" + port));
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static String tailcatIngressUrl(Context context) {
        if (context == null || !Storage.isTailcatEnabled(context)) return null;
        String link = Storage.getTailcatLink(context);
        if (link == null || link.isEmpty()) return null;
        try {
            URI u = URI.create(link);
            if (!"tailcat".equalsIgnoreCase(u.getScheme())) return null;
            String path = u.getPath() != null ? u.getPath() : "";
            while (path.startsWith("/")) path = path.substring(1);
            if (path.isEmpty()) return null;
            int port = 8000;
            String query = u.getRawQuery();
            if (query != null) {
                for (String kv : query.split("&")) {
                    int eq = kv.indexOf('=');
                    if (eq > 0 && "port".equals(kv.substring(0, eq))) {
                        port = Integer.parseInt(kv.substring(eq + 1));
                    }
                }
            }
            return "http://" + path + ":" + port;
        } catch (Throwable ignored) {
            return null;
        }
    }

    public static boolean isValidVoiceCredential(Context context, JSONObject credential) {
        if (credential == null) return false;
        String secret = credential.optString("clientSecret", "");
        String model = credential.optString("model", "");
        String address = extractVoiceWebsocketUrl(credential);
        if (!secret.matches("^[A-Za-z0-9_-]{43}$")) return false;
        if (model.isEmpty() || model.length() > 256) return false;
        if (address.isEmpty()) return false;
        try {
            URI ws = URI.create(address);
            String wsScheme = ws.getScheme() != null ? ws.getScheme().toLowerCase(Locale.US) : "";
            String wsHost = ws.getHost() != null ? ws.getHost().toLowerCase(Locale.US) : "";
            if ((!"ws".equals(wsScheme) && !"wss".equals(wsScheme)) || wsHost.isEmpty()) return false;
            if (ws.getRawUserInfo() != null || ws.getRawQuery() != null || ws.getRawFragment() != null) return false;
            if (!"/local/voice/realtime".equals(ws.getRawPath())) return false;

            if (context != null) {
                boolean tailcat = Storage.isTailcatEnabled(context);
                String serverUrl = tailcat
                        ? TailcatManager.get().resolveServerUrl(context)
                        : Storage.getGatewayUrl(context);
                if (!tailcat && (serverUrl == null || serverUrl.isEmpty())) {
                    serverUrl = TailcatManager.get().resolveServerUrl(context);
                }
                String reportedGateway = Storage.getReportedGatewayUrl(context);
                String tailcatUrl = tailcatIngressUrl(context);

                boolean hasExpected = (serverUrl != null && !serverUrl.isEmpty())
                        || (reportedGateway != null && !reportedGateway.isEmpty())
                        || (tailcatUrl != null && !tailcatUrl.isEmpty());
                if (hasExpected) {
                    boolean matchesResolved = matchesVoiceEndpoint(ws, wsScheme, serverUrl);
                    boolean matchesReported = matchesVoiceEndpoint(ws, wsScheme, reportedGateway);
                    boolean matchesTailcatPeer = matchesVoiceEndpoint(ws, wsScheme, tailcatUrl);
                    if (!matchesResolved && !matchesReported && !matchesTailcatPeer) {
                        return false;
                    }
                }
            }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static String rewriteVoiceWebsocketUrl(Context context, String rawWsUrl) {
        if (rawWsUrl == null || rawWsUrl.isEmpty()) return rawWsUrl;
        String resolved = GatewayEndpointRouter.resolveGatewayBaseUrl(context);
        if (resolved == null || resolved.isEmpty()) return rawWsUrl;
        try {
            URI base = URI.create(resolved);
            String host = base.getHost();
            if (host == null || host.isEmpty()) return rawWsUrl;
            String wsScheme = "https".equalsIgnoreCase(base.getScheme()) ? "wss" : "ws";
            int port = base.getPort();
            return wsScheme + "://" + host + (port != -1 ? ":" + port : "") + "/local/voice/realtime";
        } catch (Throwable ignored) {
            return rawWsUrl;
        }
    }

    public static JSONArray getNotifications(Context context) throws Exception {
        HttpResult res = authedGet(context, "/notifications");
        if (res.code < 200 || res.code >= 300) throw toException(res);
        String text = new String(res.body, StandardCharsets.UTF_8).trim();
        if (text.startsWith("[")) return new JSONArray(text);
        JSONObject obj = parseJsonObject(res.body);
        if (obj != null && obj.has("items")) return obj.getJSONArray("items");
        return new JSONArray();
    }

    public static JSONObject getDevice(Context context) throws Exception {
        HttpResult res = authedGet(context, "/local/device");
        return requireJsonObject(res);
    }

    public static JSONObject putDevice(Context context, JSONObject payload) throws Exception {
        HttpResult res = authedRequest(context, "PUT", "/local/device", payload, 15000);
        return requireJsonObject(res);
    }

    public static JSONObject testPush(Context context, String agentId) throws Exception {
        JSONObject req = new JSONObject();
        if (agentId != null && !agentId.isEmpty()) req.put("agentId", agentId);
        req.put("bypassForeground", true);
        HttpResult res = authedPost(context, "/local/device/push/test", req, 15000);
        return requireJsonObject(res);
    }

    public static JSONObject getNotificationSettings(Context context) throws Exception {
        HttpResult res = authedGet(context, "/local/notification-settings");
        return requireJsonObject(res);
    }

    public static JSONObject updateNotificationSettings(Context context, String frequency) throws Exception {
        HttpResult res = authedRequest(context, "PUT", "/local/notification-settings",
            new JSONObject().put("frequency", frequency), 15000);
        return requireJsonObject(res);
    }

    public static Closeable openLiveSseStream(Context context, String path,
                                              String lastEventId, boolean foregroundHeader,
                                              ActiveCheck active, SseListener listener) throws Exception {
        String server = resolveServer(context);
        String token = Storage.getToken(context);
        if (server.isEmpty() || token == null || token.isEmpty()) {
            throw new ApiException(401, Localize.t(context, "设备尚未配对。", "Device is not paired."));
        }
        return openSseStream(server, token, path, lastEventId, foregroundHeader, active, listener);
    }

    public static Closeable openSseStream(String server, String token, String path,
                                          String lastEventId, boolean foregroundHeader,
                                          ActiveCheck active, SseListener listener) throws Exception {
        if (server == null || server.isEmpty()) {
            throw new IOException("Invalid SSE server URL");
        }
        String base = server.endsWith("/") ? server.substring(0, server.length() - 1) : server;
        String suffix = (path != null && !path.isEmpty()) ? path : "/";
        URI uri = URI.create(base + suffix);
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            throw new IOException("Unsupported SSE scheme: " + scheme);
        }
        String uriHost = uri.getHost();
        if (uriHost == null || uriHost.isEmpty()) {
            throw new IOException("Missing SSE host in " + server);
        }
        String connectHost = (uriHost.startsWith("[") && uriHost.endsWith("]") && uriHost.length() > 2)
                ? uriHost.substring(1, uriHost.length() - 1)
                : uriHost;
        int port = uri.getPort() > 0 ? uri.getPort() : ("https".equalsIgnoreCase(scheme) ? 443 : 80);
        String hostHeader = uri.getPort() > 0 ? (uriHost + ":" + uri.getPort()) : uriHost;
        String rawPath = (uri.getRawPath() == null || uri.getRawPath().isEmpty()) ? "/" : uri.getRawPath();
        String targetPath = rawPath + (uri.getRawQuery() != null && !uri.getRawQuery().isEmpty() ? "?" + uri.getRawQuery() : "");

        final AtomicReference<Socket> sockRef = new AtomicReference<>();
        Socket rawSocket = new Socket();
        sockRef.set(rawSocket);
        final Closeable closeHandle = () -> {
            Socket s = sockRef.getAndSet(null);
            if (s != null) {
                try { s.close(); } catch (Throwable ignored) {}
            }
        };
        if (listener != null) listener.onOpening(closeHandle);
        if ((active != null && !active.isActive()) || sockRef.get() == null) {
            closeHandle.close();
            return closeHandle;
        }

        try {
            rawSocket.connect(new InetSocketAddress(connectHost, port), 15000);
            rawSocket.setSoTimeout(45000);
            Socket ioSocket = rawSocket;
            if ("https".equalsIgnoreCase(scheme)) {
                SSLSocketFactory sf = (SSLSocketFactory) SSLSocketFactory.getDefault();
                SSLSocket ssl = (SSLSocket) sf.createSocket(rawSocket, connectHost, port, true);
                ssl.setSoTimeout(45000);
                if (!sockRef.compareAndSet(rawSocket, ssl)) {
                    try { ssl.close(); } catch (Throwable ignored) {}
                    try { rawSocket.close(); } catch (Throwable ignored) {}
                    throw new IOException("SSE stream cancelled");
                }
                ssl.startHandshake();
                HostnameVerifier hv = HttpsURLConnection.getDefaultHostnameVerifier();
                if (!hv.verify(connectHost, ssl.getSession())) {
                    throw new IOException("SSL hostname verification failed for " + connectHost);
                }
                ioSocket = ssl;
            }
            if ((active != null && !active.isActive()) || sockRef.get() == null) {
                throw new IOException("SSE stream cancelled");
            }

            StringBuilder req = new StringBuilder();
            req.append("GET ").append(targetPath).append(" HTTP/1.1\r\n");
            req.append("Host: ").append(hostHeader).append("\r\n");
            req.append("Authorization: Bearer ").append(sanitizeHeaderValue(token)).append("\r\n");
            req.append("Accept: text/event-stream\r\n");
            req.append("Cache-Control: no-cache\r\n");
            req.append("Connection: close\r\n");
            req.append("x-rokbot-client: android-native/1.26.0\r\n");
            if (foregroundHeader) req.append("X-RokBot-Foreground: 1\r\n");
            if (lastEventId != null && !lastEventId.isEmpty()) {
                req.append("Last-Event-ID: ").append(sanitizeHeaderValue(lastEventId)).append("\r\n");
            }
            req.append("\r\n");

            OutputStream os = ioSocket.getOutputStream();
            os.write(req.toString().getBytes(StandardCharsets.US_ASCII));
            os.flush();

            BufferedInputStream bis = new BufferedInputStream(ioSocket.getInputStream(), 8192);
            String statusLine = readAsciiLine(bis, 8192);
            if (statusLine == null) {
                throw new EOFException("Empty HTTP status line from " + targetPath);
            }
            int status = parseHttpStatusCode(statusLine);
            Map<String, String> headers = new HashMap<>();
            while (true) {
                String hdrLine = readAsciiLine(bis, 16384);
                if (hdrLine == null || hdrLine.isEmpty()) break;
                int colon = hdrLine.indexOf(':');
                if (colon > 0) {
                    String name = hdrLine.substring(0, colon).trim().toLowerCase(Locale.US);
                    String val = hdrLine.substring(colon + 1).trim();
                    if (!name.isEmpty()) headers.put(name, val);
                }
            }

            String transferEnc = headers.get("transfer-encoding");
            boolean isChunked = transferEnc != null && transferEnc.toLowerCase(Locale.US).contains("chunked");
            long contentLength = -1L;
            String contentLenHdr = headers.get("content-length");
            if (contentLenHdr != null && !contentLenHdr.isEmpty()) {
                try {
                    contentLength = Long.parseLong(contentLenHdr.trim());
                } catch (NumberFormatException ignored) {}
            }

            InputStream bodyStream;
            if (isChunked) {
                bodyStream = new ChunkedInputStream(bis);
            } else if (contentLength >= 0) {
                bodyStream = new BoundedInputStream(bis, contentLength);
            } else {
                bodyStream = bis;
            }

            if (status != 200) {
                if (!isChunked && contentLength < 0) {
                    try { ioSocket.setSoTimeout(2000); } catch (Throwable ignored) {}
                }
                byte[] errBytes = readBoundedBytesQuietly(bodyStream, 16384);
                throw new ApiException(status, extractErrorMessage(status, errBytes));
            }
            if (listener != null) listener.onConnected();

            BufferedReader reader = new BufferedReader(new InputStreamReader(bodyStream, StandardCharsets.UTF_8));
            String eventId = null;
            String eventType = null;
            StringBuilder data = new StringBuilder();
            String line;
            while ((active == null || active.isActive()) && sockRef.get() != null && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0 && listener != null) {
                        listener.onEvent(eventId, eventType, data.toString());
                    }
                    eventId = null;
                    eventType = null;
                    data.setLength(0);
                    continue;
                }
                if (line.startsWith(":")) continue;
                int colon = line.indexOf(':');
                String field = colon >= 0 ? line.substring(0, colon) : line;
                String value = colon >= 0 ? line.substring(colon + 1) : "";
                if (value.startsWith(" ")) value = value.substring(1);
                if ("id".equals(field)) eventId = value;
                else if ("event".equals(field)) eventType = value;
                else if ("data".equals(field)) {
                    if (data.length() > 0) data.append('\n');
                    data.append(value);
                }
            }
        } finally {
            try { closeHandle.close(); } catch (Throwable ignored) {}
        }
        return closeHandle;
    }

    private static String sanitizeHeaderValue(String raw) {
        if (raw == null) return "";
        return raw.replace("\r", "").replace("\n", "");
    }

    private static int parseHttpStatusCode(String statusLine) throws IOException {
        if (statusLine == null || !statusLine.startsWith("HTTP/")) {
            throw new IOException("Malformed HTTP status line: " + statusLine);
        }
        int sp1 = statusLine.indexOf(' ');
        if (sp1 < 0) throw new IOException("Malformed HTTP status line: " + statusLine);
        while (sp1 < statusLine.length() && statusLine.charAt(sp1) == ' ') sp1++;
        int sp2 = statusLine.indexOf(' ', sp1);
        String codeStr = sp2 > sp1 ? statusLine.substring(sp1, sp2) : statusLine.substring(sp1);
        try {
            return Integer.parseInt(codeStr.trim());
        } catch (NumberFormatException nfe) {
            throw new IOException("Invalid HTTP status code: " + statusLine, nfe);
        }
    }

    private static String readAsciiLine(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(64);
        int b;
        int count = 0;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') {
                if (++count > maxBytes) {
                    throw new IOException("HTTP line exceeded " + maxBytes + " bytes");
                }
                baos.write(b);
            }
        }
        if (b == -1 && baos.size() == 0) return null;
        return new String(baos.toByteArray(), StandardCharsets.US_ASCII);
    }

    private static byte[] readBoundedBytesQuietly(InputStream in, int maxBytes) {
        if (in == null) return new byte[0];
        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[2048];
            int remaining = maxBytes;
            while (remaining > 0) {
                int n = in.read(buf, 0, Math.min(buf.length, remaining));
                if (n <= 0) break;
                baos.write(buf, 0, n);
                remaining -= n;
            }
            return baos.toByteArray();
        } catch (Throwable ignored) {
            return new byte[0];
        }
    }

    private static final class BoundedInputStream extends InputStream {
        private final InputStream mIn;
        private long mRemaining;

        BoundedInputStream(InputStream in, long length) {
            mIn = in;
            mRemaining = length;
        }

        @Override
        public int read() throws IOException {
            if (mRemaining <= 0) return -1;
            int b = mIn.read();
            if (b != -1) mRemaining--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (mRemaining <= 0) return -1;
            int toRead = (int) Math.min(len, mRemaining);
            int n = mIn.read(b, off, toRead);
            if (n > 0) mRemaining -= n;
            return n;
        }
    }

    private static final class ChunkedInputStream extends InputStream {
        private final InputStream mIn;
        private int mRemaining = 0;
        private boolean mNeedTrailingCrlf = false;
        private boolean mEof = false;

        ChunkedInputStream(InputStream in) {
            mIn = in;
        }

        private boolean ensureChunk() throws IOException {
            if (mEof) return false;
            while (mRemaining <= 0) {
                if (mNeedTrailingCrlf) {
                    String empty = readAsciiLine(mIn, 64);
                    if (empty == null) {
                        mEof = true;
                        return false;
                    }
                    mNeedTrailingCrlf = false;
                }
                String sizeLine = readAsciiLine(mIn, 256);
                if (sizeLine == null) {
                    mEof = true;
                    return false;
                }
                int semi = sizeLine.indexOf(';');
                if (semi >= 0) sizeLine = sizeLine.substring(0, semi);
                String trimmed = sizeLine.trim();
                if (trimmed.isEmpty()) continue;
                int size;
                try {
                    size = Integer.parseInt(trimmed, 16);
                } catch (NumberFormatException nfe) {
                    throw new IOException("Malformed chunk size: " + sizeLine, nfe);
                }
                if (size <= 0) {
                    while (true) {
                        String trailer = readAsciiLine(mIn, 4096);
                        if (trailer == null || trailer.isEmpty()) break;
                    }
                    mEof = true;
                    return false;
                }
                mRemaining = size;
                mNeedTrailingCrlf = true;
            }
            return true;
        }

        @Override
        public int read() throws IOException {
            if (!ensureChunk()) return -1;
            int b = mIn.read();
            if (b == -1) {
                mEof = true;
                return -1;
            }
            mRemaining--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            if (!ensureChunk()) return -1;
            int n = mIn.read(b, off, Math.min(len, mRemaining));
            if (n == -1) {
                mEof = true;
                return -1;
            }
            mRemaining -= n;
            return n;
        }
    }

    // ---- Internal HTTP helpers ----

    public static String resolveServer(Context context) throws ApiException {
        try {
            String resolved = TailcatManager.get().resolveServerUrl(context);
            if (resolved == null || resolved.isEmpty()) {
                throw new ApiException(401, Localize.t(context, "设备尚未配对。", "Device is not paired."));
            }
            return resolved;
        } catch (ApiException ae) {
            throw ae;
        } catch (RuntimeException re) {
            throw new ApiException(502, re.getMessage() != null ? re.getMessage() : "Host unavailable");
        }
    }

    public static class HttpResult {
        public final int code;
        public final byte[] body;
        public HttpResult(int code, byte[] body) {
            this.code = code;
            this.body = body;
        }
    }

    private static HttpResult authedGet(Context context, String path) throws Exception {
        return authedRequest(context, "GET", path, null, 20000);
    }

    private static HttpResult authedPost(Context context, String path, JSONObject body) throws Exception {
        return authedRequest(context, "POST", path, body, 30000);
    }

    private static HttpResult authedPost(Context context, String path, JSONObject body, int readTimeoutMs) throws Exception {
        return authedRequest(context, "POST", path, body, readTimeoutMs);
    }

    private static HttpResult authedRequest(Context context, String method, String path, JSONObject body, int readTimeoutMs) throws Exception {
        return authedRequest(context, method, path, body, readTimeoutMs, null);
    }

    private static HttpResult authedRequest(Context context, String method, String path, JSONObject body,
                                            int readTimeoutMs, Map<String, String> extraHeaders) throws Exception {
        String server = resolveServer(context);
        String token = Storage.getToken(context);
        if (server == null || server.isEmpty() || token == null || token.isEmpty()) {
            throw new ApiException(401, Localize.t(context, "设备尚未配对。", "Device is not paired."));
        }
        byte[] payload = body != null ? body.toString().getBytes(StandardCharsets.UTF_8) : null;
        return rawRequest(server + path, method, token, payload, payload != null ? "application/json" : null,
                15000, readTimeoutMs, RokBotBootstrap.isForeground(), extraHeaders);
    }

    public static HttpResult rawRequest(String urlStr, String method, String token, byte[] body, String contentType,
                                        int connectTimeoutMs, int readTimeoutMs, boolean foreground) throws IOException {
        return rawRequest(urlStr, method, token, body, contentType, connectTimeoutMs, readTimeoutMs, foreground, null);
    }

    public static HttpResult rawRequest(String urlStr, String method, String token, byte[] body, String contentType,
                                        int connectTimeoutMs, int readTimeoutMs, boolean foreground,
                                        Map<String, String> extraHeaders) throws IOException {
        return rawRequest(urlStr, method, token, body, contentType, connectTimeoutMs, readTimeoutMs, foreground, extraHeaders, null);
    }

    public static HttpResult rawRequest(String urlStr, String method, String token, byte[] body, String contentType,
                                        int connectTimeoutMs, int readTimeoutMs, boolean foreground,
                                        Map<String, String> extraHeaders, CancelHandle cancel) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        if (cancel != null) cancel.attach(conn);
        conn.setInstanceFollowRedirects(false);
        conn.setRequestMethod(method);
        conn.setConnectTimeout(connectTimeoutMs);
        conn.setReadTimeout(readTimeoutMs);
        conn.setUseCaches(false);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("x-rokbot-client", "android-native/1.26.0");
        if (foreground) conn.setRequestProperty("x-rokbot-foreground", "1");
        if (token != null && !token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
        if (extraHeaders != null) {
            for (Map.Entry<String, String> entry : extraHeaders.entrySet()) {
                String k = entry.getKey();
                String v = sanitizeHeaderValue(entry.getValue());
                if (k != null && !k.isEmpty() && !v.isEmpty()) {
                    conn.setRequestProperty(k, v);
                }
            }
        }
        if (body != null) {
            conn.setDoOutput(true);
            if (contentType != null) conn.setRequestProperty("Content-Type", contentType);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body);
            }
        }
        try {
            int code = conn.getResponseCode();
            InputStream stream = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
            byte[] bytes = readStreamBytes(stream);
            return new HttpResult(code, bytes);
        } finally {
            conn.disconnect();
        }
    }

    private static byte[] readStreamBytes(InputStream is) throws IOException {
        if (is == null) return new byte[0];
        try (is) {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) {
                baos.write(buf, 0, n);
            }
            return baos.toByteArray();
        }
    }

    private static JSONObject parseJsonObject(byte[] body) {
        if (body == null || body.length == 0) return null;
        try {
            return new JSONObject(new String(body, StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static JSONObject requireJsonObject(HttpResult res) throws Exception {
        if (res.code < 200 || res.code >= 300) throw toException(res);
        JSONObject obj = parseJsonObject(res.body);
        return obj != null ? obj : new JSONObject();
    }

    private static ApiException toException(HttpResult res) {
        return new ApiException(res.code, extractErrorMessage(res.code, res.body));
    }

    private static String extractErrorMessage(int code, byte[] body) {
        JSONObject err = parseJsonObject(body);
        if (err != null) {
            String m = UiChrome.jsonStr(err, "error");
            if (m.isEmpty()) m = UiChrome.jsonStr(err, "message");
            if (!m.isEmpty()) return m;
        }
        return "HTTP " + code;
    }

    public static String encodeQuery(String value) {
        try {
            return URLEncoder.encode(value != null ? value : "", "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return "";
        }
    }
}

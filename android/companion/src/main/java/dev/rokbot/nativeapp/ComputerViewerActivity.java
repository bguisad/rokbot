package dev.rokbot.nativeapp;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Interactive Bot Computer (ForeverBox / noVNC Desktop) viewer with embedded loopback
 * HTTP + WebSocket proxy so WebView authenticates cleanly across HTTP, HTTPS, and Tailcat.
 */
public class ComputerViewerActivity extends Activity {
    public static final String EXTRA_AGENT_ID = "agentId";
    public static final String EXTRA_AGENT_NAME = "agentName";

    private static final Pattern SECURE_ATTR_PATTERN = Pattern.compile(";\\s*secure\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern VNC_STATIC_SUFFIX_PATTERN = Pattern.compile(
            "^/(?:vnc(?:_auto|_lite)?\\.html|(?:defaults|mandatory|package)\\.json|(?:app|core|vendor|include)/.+\\.(?:js|css|json|svg|png|gif|jpg|ico|woff2?|ttf|mp3|ogg|oga|map))$"
    );

    private String mAgentId;
    private String mAgentName;
    private volatile String mVncOrigin = null;
    private final String mLoopbackSecret = generateLoopbackSecret();
    private TextView mStatusLabel;
    private TextView mBootButton;
    private WebView mWebView;
    private ServerSocket mProxySocket;
    private int mProxyPort = -1;
    private volatile boolean mProxyRunning = false;
    private volatile boolean mDestroyed = false;
    private int mStartPollCount = 0;
    private final Handler mMain = new Handler(Looper.getMainLooper());
    private final Runnable mPollRunnable = this::refreshStatus;

    private static String generateLoopbackSecret() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.US, "%02x", b & 0xff));
        }
        return sb.toString();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);

        mAgentId = getIntent().getStringExtra(EXTRA_AGENT_ID);
        mAgentName = getIntent().getStringExtra(EXTRA_AGENT_NAME);
        if (mAgentName == null || mAgentName.isEmpty()) {
            mAgentName = Localize.t(this, "Bot 电脑", "Bot Computer");
        }
        buildUi();
        startLoopbackProxy();
        refreshStatus();
    }

    @Override
    protected void onDestroy() {
        mDestroyed = true;
        mMain.removeCallbacks(mPollRunnable);
        stopLoopbackProxy();
        if (mWebView != null) {
            try { mWebView.destroy(); } catch (Throwable ignored) {}
        }
        super.onDestroy();
    }

    private void buildUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(p.bgPaper);
        root.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 8), UiChrome.dp(this, 12), UiChrome.dp(this, 12));

        View reloadBtn = UiChrome.makeVectorIconButton(this, "refresh", "refresh_computer_button", p, v -> refreshStatus());
        mBootButton = UiChrome.makePillButton(this, Localize.t(this, "启动桌面", "Boot"), true, p, v -> ensureDesktop());
        mBootButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mBootButton.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 7), UiChrome.dp(this, 12), UiChrome.dp(this, 7));
        mBootButton.setVisibility(View.GONE);
        root.addView(UiChrome.makeHeaderBar(this, mAgentName, p, v -> finish(), mBootButton, reloadBtn));

        mStatusLabel = new TextView(this);
        mStatusLabel.setText(Localize.t(this, "正在检查桌面环境状态…", "Checking Bot computer status…"));
        mStatusLabel.setTextColor(p.textSecondary);
        mStatusLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mStatusLabel.setPadding(UiChrome.dp(this, 6), UiChrome.dp(this, 2), UiChrome.dp(this, 6), UiChrome.dp(this, 8));
        root.addView(mStatusLabel);

        mWebView = new WebView(this);
        WebSettings ws = mWebView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setBuiltInZoomControls(true);
        ws.setDisplayZoomControls(false);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest req, android.webkit.WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    mMain.post(() -> mStatusLabel.setText("VNC load error: " + err.getDescription()));
                }
            }
            @Override
            public void onReceivedHttpError(WebView view, android.webkit.WebResourceRequest req, android.webkit.WebResourceResponse resp) {
                if (req != null && req.isForMainFrame()) {
                    mMain.post(() -> mStatusLabel.setText("VNC HTTP " + resp.getStatusCode()));
                }
            }
        });
        mWebView.setContentDescription("computer_vnc_webview");
        root.addView(mWebView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        UiChrome.applyRootInsets(this, root);
    }

    private void refreshStatus() {
        if (mAgentId == null || mAgentId.isEmpty()) {
            mStatusLabel.setText(Localize.t(this, "未指定 Bot", "No Bot specified"));
            return;
        }
        new Thread(() -> {
            try {
                JSONObject st = HostApiClient.getForeverBoxStatus(this, mAgentId);
                applyBoxStatus(st);
            } catch (Throwable t) {
                mMain.post(() -> mStatusLabel.setText(Localize.t(this, "读取状态失败: ", "Error: ") + t.getMessage()));
            }
        }).start();
    }

    private void ensureDesktop() {
        mBootButton.setEnabled(false);
        mStatusLabel.setText(Localize.t(this, "正在唤醒 Linux 桌面…", "Starting Linux desktop…"));
        new Thread(() -> {
            try {
                JSONObject st = HostApiClient.ensureForeverBox(this, mAgentId);
                applyBoxStatus(st);
            } catch (Throwable t) {
                mMain.post(() -> {
                    mBootButton.setEnabled(true);
                    Toast.makeText(this, "Error: " + t.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private void applyBoxStatus(JSONObject st) {
        mMain.removeCallbacks(mPollRunnable);
        String state = UiChrome.jsonStr(st, "state");
        if (state.isEmpty()) state = "unknown";
        String vncUrl = UiChrome.jsonStr(st, "vncUrl");
        JSONArray windows = st.optJSONArray("windows");
        int winCount = windows != null ? windows.length() : 0;

        final String finalState = state;
        mMain.post(() -> {
            if (mDestroyed) return;
            mBootButton.setEnabled(true);
            boolean ready = !vncUrl.isEmpty();
            mBootButton.setVisibility(ready ? View.GONE : View.VISIBLE);
            mStatusLabel.setText(Localize.t(this,
                    "状态: " + finalState + " · 窗口数: " + winCount,
                    "State: " + finalState + " · Windows: " + winCount));

            if (ready && mProxyPort > 0) {
                try {
                    URI u = URI.create(vncUrl);
                    String rawPath = u.getRawPath() != null ? u.getRawPath() : "/";
                    if (!isAllowedVncPath(rawPath, false)) {
                        mStatusLabel.setText("Invalid VNC path");
                        return;
                    }
                    mStartPollCount = 0;
                    if (u.getScheme() != null && u.getAuthority() != null) {
                        mVncOrigin = u.getScheme() + "://" + u.getAuthority();
                    }
                    String query = u.getRawQuery();
                    if (query != null) {
                        query = query.replaceAll("(^|&)encrypt=1(&|$)", "$1encrypt=0$2");
                    }
                    String pathAndQuery = rawPath
                            + (query != null && !query.isEmpty() ? "?" + query : "");
                    String bootUrl = "http://127.0.0.1:" + mProxyPort + "/__gb_auth/"
                            + mLoopbackSecret + "?next=" + URLEncoder.encode(pathAndQuery, "UTF-8");
                    mWebView.loadUrl(bootUrl);
                } catch (Throwable t) {
                    mStatusLabel.setText("VNC URL error: " + t.getMessage());
                }
            } else if ("starting".equalsIgnoreCase(finalState)
                    || "booting".equalsIgnoreCase(finalState)
                    || "initializing".equalsIgnoreCase(finalState)) {
                if (mStartPollCount < 30) {
                    mStartPollCount++;
                    mMain.postDelayed(mPollRunnable, 2000L);
                }
            }
        });
    }

    private static boolean isAllowedVncPath(String rawPath, boolean upgrade) {
        if (rawPath == null || rawPath.isEmpty() || rawPath.contains("\\")) return false;
        if (!rawPath.startsWith("/vnc/")) return false;
        String rest = rawPath.substring("/vnc/".length());
        String sub;
        if (rest.startsWith("desktop/")) {
            sub = rest.substring("desktop".length());
        } else if (rest.startsWith("fork/")) {
            sub = rest.substring("fork".length());
        } else {
            return false;
        }
        String[] parts = sub.split("/");
        for (String part : parts) {
            if (".".equals(part) || "..".equals(part)) return false;
        }
        if (upgrade) {
            return "/websockify".equals(sub);
        }
        return "/".equals(sub) || VNC_STATIC_SUFFIX_PATTERN.matcher(sub).matches();
    }

    private void startLoopbackProxy() {
        try {
            mProxySocket = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
            mProxyPort = mProxySocket.getLocalPort();
            mProxyRunning = true;
            new Thread(() -> {
                while (mProxyRunning) {
                    try {
                        Socket client = mProxySocket.accept();
                        new Thread(() -> handleProxyClient(client), "RokBotVncConn").start();
                    } catch (Throwable ignored) {
                        if (!mProxyRunning) break;
                    }
                }
            }, "RokBotVncProxy").start();
        } catch (Throwable ignored) {}
    }

    private void stopLoopbackProxy() {
        mProxyRunning = false;
        if (mProxySocket != null) {
            try { mProxySocket.close(); } catch (Throwable ignored) {}
            mProxySocket = null;
        }
    }

    private static void sendSimpleResponse(OutputStream out, int code, String reason, String extraHeaders) {
        try {
            String resp = "HTTP/1.1 " + code + " " + reason + "\r\n"
                    + "Content-Length: 0\r\n"
                    + "Cache-Control: no-store\r\n"
                    + "Connection: close\r\n"
                    + (extraHeaders != null ? extraHeaders : "")
                    + "\r\n";
            out.write(resp.getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
        } catch (Throwable ignored) {}
    }

    private boolean isValidLoopbackSecret(String candidate) {
        if (candidate == null || candidate.isEmpty()) return false;
        return MessageDigest.isEqual(
                candidate.getBytes(StandardCharsets.UTF_8),
                mLoopbackSecret.getBytes(StandardCharsets.UTF_8)
        );
    }

    private void handleProxyClient(Socket client) {
        try (client) {
            client.setSoTimeout(30000);
            InputStream in = client.getInputStream();
            OutputStream out = client.getOutputStream();

            byte[] reqHeaderBytes = readHttpHeaderBlock(in, 32768);
            if (reqHeaderBytes == null || reqHeaderBytes.length == 0) return;

            String headerText = new String(reqHeaderBytes, StandardCharsets.ISO_8859_1);
            String[] lines = headerText.split("\r\n");
            if (lines.length == 0) return;

            String requestLine = lines[0];
            String[] reqParts = requestLine.split(" ");
            if (reqParts.length != 3) {
                sendSimpleResponse(out, 400, "Bad Request", null);
                return;
            }
            String method = reqParts[0].toUpperCase(Locale.US);
            String target = reqParts[1];
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                sendSimpleResponse(out, 405, "Method Not Allowed", null);
                return;
            }
            if (!target.startsWith("/") || target.startsWith("//") || target.indexOf('\r') >= 0 || target.indexOf('\n') >= 0) {
                sendSimpleResponse(out, 403, "Forbidden", null);
                return;
            }

            if (target.startsWith("/__gb_auth/")) {
                if (!"GET".equals(method)) {
                    sendSimpleResponse(out, 405, "Method Not Allowed", null);
                    return;
                }
                int qIdx = target.indexOf('?');
                String authPath = qIdx >= 0 ? target.substring(0, qIdx) : target;
                String candidateSecret = authPath.substring("/__gb_auth/".length());
                if (!isValidLoopbackSecret(candidateSecret)) {
                    sendSimpleResponse(out, 403, "Forbidden", null);
                    return;
                }
                String nextTarget = "/";
                if (qIdx >= 0) {
                    String qs = target.substring(qIdx + 1);
                    for (String param : qs.split("&")) {
                        int eq = param.indexOf('=');
                        if (eq > 0 && "next".equals(param.substring(0, eq))) {
                            nextTarget = URLDecoder.decode(param.substring(eq + 1), "UTF-8");
                            break;
                        }
                    }
                }
                int nextQ = nextTarget.indexOf('?');
                String nextPath = nextQ >= 0 ? nextTarget.substring(0, nextQ) : nextTarget;
                if (!nextTarget.startsWith("/") || nextTarget.startsWith("//")
                        || nextTarget.indexOf('\r') >= 0 || nextTarget.indexOf('\n') >= 0
                        || !isAllowedVncPath(nextPath, false)) {
                    sendSimpleResponse(out, 403, "Forbidden", null);
                    return;
                }
                String headers = "Set-Cookie: gb_vnc_gate=" + mLoopbackSecret + "; Path=/; HttpOnly; SameSite=Lax\r\n"
                        + "Location: " + nextTarget + "\r\n";
                sendSimpleResponse(out, 302, "Found", headers);
                return;
            }

            boolean isUpgrade = false;
            boolean hasGateCookie = false;
            StringBuilder forwardedCookie = new StringBuilder();
            StringBuilder otherHeaders = new StringBuilder();

            for (int i = 1; i < lines.length; i++) {
                String line = lines[i];
                if (line.isEmpty()) continue;
                String lower = line.toLowerCase(Locale.US);
                if (lower.startsWith("host:")) continue;
                if (lower.startsWith("origin:")) continue;
                if (lower.startsWith("authorization:")) continue;
                if (lower.startsWith("cookie:")) {
                    String rawCookie = line.substring("cookie:".length()).trim();
                    for (String pair : rawCookie.split(";")) {
                        String trimmed = pair.trim();
                        if (trimmed.isEmpty()) continue;
                        if (trimmed.startsWith("gb_vnc_gate=")) {
                            String val = trimmed.substring("gb_vnc_gate=".length());
                            if (isValidLoopbackSecret(val)) {
                                hasGateCookie = true;
                            }
                        } else {
                            if (forwardedCookie.length() > 0) forwardedCookie.append("; ");
                            forwardedCookie.append(trimmed);
                        }
                    }
                    continue;
                }
                if (lower.startsWith("connection:")) {
                    if (lower.contains("upgrade")) isUpgrade = true;
                    else continue;
                }
                if (lower.startsWith("upgrade:")) isUpgrade = true;
                otherHeaders.append(line).append("\r\n");
            }

            if (!hasGateCookie) {
                sendSimpleResponse(out, 403, "Forbidden", null);
                return;
            }
            if (isUpgrade && !"GET".equals(method)) {
                sendSimpleResponse(out, 405, "Method Not Allowed", null);
                return;
            }
            int qIdx = target.indexOf('?');
            String rawPath = qIdx >= 0 ? target.substring(0, qIdx) : target;
            if (!isAllowedVncPath(rawPath, isUpgrade)) {
                sendSimpleResponse(out, 403, "Forbidden", null);
                return;
            }

            String server = HostApiClient.resolveServer(this);
            String token = Storage.getToken(this);
            if (server == null || server.isEmpty() || token == null || token.isEmpty()) {
                sendSimpleResponse(out, 503, "Service Unavailable", null);
                return;
            }

            URI targetUri = URI.create(server);
            boolean tls = "https".equalsIgnoreCase(targetUri.getScheme());
            int port = targetUri.getPort() != -1 ? targetUri.getPort() : (tls ? 443 : 80);
            String hostHeader = targetUri.getHost() + ((tls && port == 443) || (!tls && port == 80) ? "" : ":" + port);
            String originHeader = (mVncOrigin != null && !mVncOrigin.isEmpty())
                    ? mVncOrigin
                    : (targetUri.getScheme() + "://" + hostHeader);

            StringBuilder rebuilt = new StringBuilder();
            rebuilt.append(requestLine).append("\r\n");
            rebuilt.append(otherHeaders);
            if (forwardedCookie.length() > 0) {
                rebuilt.append("Cookie: ").append(forwardedCookie).append("\r\n");
            }
            rebuilt.append("Host: ").append(hostHeader).append("\r\n");
            rebuilt.append("Origin: ").append(originHeader).append("\r\n");
            rebuilt.append("Authorization: Bearer ").append(token).append("\r\n");
            if (!isUpgrade) {
                rebuilt.append("Connection: close\r\n");
            } else {
                client.setSoTimeout(0);
            }
            rebuilt.append("\r\n");

            Socket upstream;
            if (tls) {
                SSLSocket ssl = (SSLSocket) SSLSocketFactory.getDefault().createSocket(targetUri.getHost(), port);
                SSLParameters params = ssl.getSSLParameters();
                params.setEndpointIdentificationAlgorithm("HTTPS");
                ssl.setSSLParameters(params);
                ssl.startHandshake();
                upstream = ssl;
            } else {
                upstream = new Socket(targetUri.getHost(), port);
            }
            try (upstream) {
                if (isUpgrade) upstream.setSoTimeout(0);
                OutputStream upOut = upstream.getOutputStream();
                InputStream upIn = upstream.getInputStream();
                upOut.write(rebuilt.toString().getBytes(StandardCharsets.ISO_8859_1));
                upOut.flush();

                byte[] upHeaders = readHttpHeaderBlock(upIn, 65536);
                if (upHeaders != null && upHeaders.length > 0) {
                    String upHeaderStr = new String(upHeaders, StandardCharsets.ISO_8859_1);
                    String rewrittenUp = rewriteResponseHeaders(upHeaderStr);
                    out.write(rewrittenUp.getBytes(StandardCharsets.ISO_8859_1));
                    out.flush();
                }

                if (isUpgrade) {
                    Thread t1 = new Thread(() -> pipe(in, upOut), "VncUp");
                    t1.start();
                    pipe(upIn, out);
                    try { t1.join(500); } catch (InterruptedException ignored) {}
                } else {
                    pipe(upIn, out);
                }
            }
        } catch (Throwable ignored) {}
    }

    private static byte[] readHttpHeaderBlock(InputStream in, int maxBytes) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;
        while (buf.size() < maxBytes) {
            int b = in.read();
            if (b == -1) break;
            buf.write(b);
            if ((state == 0 && b == '\r') || (state == 2 && b == '\r')) {
                state++;
            } else if ((state == 1 && b == '\n') || (state == 3 && b == '\n')) {
                state++;
                if (state == 4) break;
            } else {
                state = (b == '\r') ? 1 : 0;
            }
        }
        return buf.toByteArray();
    }

    private static String rewriteResponseHeaders(String rawHeaderBlock) {
        String trimmed = rawHeaderBlock.endsWith("\r\n\r\n")
                ? rawHeaderBlock.substring(0, rawHeaderBlock.length() - 4)
                : rawHeaderBlock;
        String[] respLines = trimmed.split("\r\n");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < respLines.length; i++) {
            String line = respLines[i];
            if (line.regionMatches(true, 0, "set-cookie:", 0, "set-cookie:".length())) {
                line = SECURE_ATTR_PATTERN.matcher(line).replaceAll("");
            }
            out.append(line).append("\r\n");
        }
        out.append("\r\n");
        return out.toString();
    }

    private static void pipe(InputStream src, OutputStream dst) {
        byte[] buf = new byte[8192];
        try {
            int n;
            while ((n = src.read(buf)) != -1) {
                dst.write(buf, 0, n);
                dst.flush();
            }
        } catch (Throwable ignored) {}
    }
}

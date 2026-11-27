package dev.rokbot.nativeapp;

import java.net.URI;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Canvas links and labels shared by CanvasActivity, the Library "画布" section and the link router.
 *
 * A RokBot canvas link is the Host's in-app link `http(s)://<host>/canvas/app/<id>` (WriteCanvas
 * hands it to the model, like the official `cursor.com/canvas/<store>/<id>` chat links). It opens
 * in CanvasActivity with this device's credential. The public link `/canvas/<token>` exists only
 * while the user shares the canvas and stays an ordinary web link.
 */
final class CanvasModel {
    private CanvasModel() {}

    static final ZoneId BEIJING = ZoneId.of("Asia/Shanghai");
    private static final Pattern ID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern APP_PATH = Pattern.compile("^/canvas/app/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/?$");
    private static final Pattern PUBLIC_PATH = Pattern.compile("^/canvas/[A-Za-z0-9_-]{43}/?$");

    static boolean isCanvasId(String value) {
        return value != null && ID.matcher(value).matches();
    }

    /** The canvas id of an in-app canvas link on any Host address, or null. */
    static String appLinkId(String url) {
        if (url == null || url.length() > 2048) return null;
        try {
            URI uri = new URI(url.trim());
            String scheme = uri.getScheme();
            if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) return null;
            if (uri.getRawUserInfo() != null || uri.getHost() == null) return null;
            String path = uri.getRawPath();
            if (path == null) return null;
            Matcher m = APP_PATH.matcher(path);
            return m.matches() ? m.group(1).toLowerCase(Locale.ROOT) : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Whether `url` is a public canvas link (`/canvas/<token>`), the only canvas link that may leave the app. */
    static boolean isPublicLink(String url) {
        try {
            URI uri = new URI(url);
            String scheme = uri.getScheme();
            return scheme != null && (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))
                    && uri.getRawUserInfo() == null && uri.getRawPath() != null && PUBLIC_PATH.matcher(uri.getRawPath()).matches();
        } catch (Exception e) {
            return false;
        }
    }

    /** Short update time in Beijing time: 今天 14:05, 11月26日 09:30, 2025年3月2日. */
    static String shortTime(long ms, long nowMs, boolean chinese) {
        if (ms <= 0) return "";
        ZonedDateTime at = Instant.ofEpochMilli(ms).atZone(BEIJING);
        ZonedDateTime now = Instant.ofEpochMilli(nowMs).atZone(BEIJING);
        String time = String.format(Locale.ROOT, "%02d:%02d", at.getHour(), at.getMinute());
        if (at.toLocalDate().equals(now.toLocalDate())) return chinese ? "今天 " + time : "Today " + time;
        if (at.getYear() == now.getYear()) {
            return chinese ? at.getMonthValue() + "月" + at.getDayOfMonth() + "日 " + time
                    : at.getMonthValue() + "/" + at.getDayOfMonth() + " " + time;
        }
        return chinese ? at.getYear() + "年" + at.getMonthValue() + "月" + at.getDayOfMonth() + "日"
                : at.getYear() + "/" + at.getMonthValue() + "/" + at.getDayOfMonth();
    }

    static String visibilityLabel(String visibility, boolean chinese) {
        boolean pub = "public".equals(visibility);
        return chinese ? (pub ? "公开" : "私有") : (pub ? "Public" : "Private");
    }

    /**
     * The Host's frame page for a WebView without the response headers: its sandbox CSP becomes a
     * meta CSP (scripts by nonce, no network, no forms, no frames). The WebView itself also blocks
     * network loads, so the canvas stays offline as it is in the desktop frame.
     */
    static String withMetaCsp(String html) {
        if (html == null) return "";
        Matcher nonce = Pattern.compile("<script nonce=\"([A-Za-z0-9+/=]{8,64})\">").matcher(html);
        String scripts = nonce.find() ? "'nonce-" + nonce.group(1) + "'" : "'none'";
        String csp = "default-src 'none'; script-src " + scripts + "; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; "
                + "font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'";
        String meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"" + csp + "\">";
        int head = html.indexOf("<head>");
        return head >= 0 ? html.substring(0, head + 6) + meta + html.substring(head + 6) : meta + html;
    }
}

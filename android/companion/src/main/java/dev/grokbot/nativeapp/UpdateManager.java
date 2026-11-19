package dev.grokbot.nativeapp;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * In-app incremental APK updater for GrokBot Native Android.
 * Checks update manifests (direct or via paired Host /local/updates/fetch),
 * prefers GBDELTA1 incremental patches matched by installed APK SHA-256,
 * verifies target SHA-256 + signing certificate, and launches PackageInstaller.
 */
public final class UpdateManager {
    private static final String TAG = "GrokBotUpdater";
    private static final String EXPECTED_SCHEMA = "grokbot-android-native-update/v1";
    private static final long MAX_APK_BYTES = 512L * 1024L * 1024L;

    public interface Callback {
        void onStage(String message, int progressPercent);
        void onUpToDate(String currentVersion, String shortSha);
        void onReady(File stagedApk, String versionLabel, boolean usedDelta, long downloadBytes, long fullBytes, String notes);
        void onError(String message);
    }

    private UpdateManager() {}

    public static String getCurrentVersionLabel(Context context) {
        try {
            PackageInfo pi = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            long vc = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            return (pi.versionName != null ? pi.versionName : "1.0.0") + " (" + vc + ")";
        } catch (Throwable ignored) {
            return "unknown";
        }
    }

    public static String computeInstalledApkSha256(Context context) {
        try {
            String src = context.getApplicationInfo().sourceDir;
            if (src == null || src.isEmpty()) return "";
            return sha256Hex(new File(src));
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static String resolveDefaultFeedUrl(Context context) {
        String saved = Storage.getUpdateFeedUrl(context);
        if (saved != null && !saved.isEmpty()) return saved;
        try (InputStream is = context.getAssets().open("recipes/update-config.json")) {
            byte[] raw = readAllBytes(is, 64 * 1024);
            JSONObject obj = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            String url = obj.optString("updateFeedUrl", "").trim();
            if (!url.isEmpty()) return url;
        } catch (Throwable ignored) {}
        return "";
    }

    public static void checkAndStageAsync(Context context, String feedUrl, Callback cb) {
        final Context appCtx = context.getApplicationContext();
        new Thread(() -> {
            try {
                performCheckAndStage(appCtx, feedUrl, cb);
            } catch (Throwable t) {
                Log.w(TAG, "Update failed", t);
                cb.onError(t.getMessage() != null && !t.getMessage().isEmpty() ? t.getMessage() : t.getClass().getSimpleName());
            }
        }, "GrokBotUpdater").start();
    }

    private static void performCheckAndStage(Context ctx, String rawFeedUrl, Callback cb) throws Exception {
        String feedUrl = rawFeedUrl != null ? rawFeedUrl.trim() : "";
        if (feedUrl.isEmpty() || (!feedUrl.startsWith("https://") && !feedUrl.startsWith("http://"))) {
            throw new IllegalArgumentException(Localize.t(ctx, "请先填写有效的更新源地址（http/https）", "Enter a valid update feed URL (http/https)"));
        }

        cb.onStage(Localize.t(ctx, "正在计算当前安装包指纹…", "Fingerprinting installed APK…"), 5);
        File baseApk = new File(ctx.getApplicationInfo().sourceDir);
        if (!baseApk.isFile()) {
            throw new IOException(Localize.t(ctx, "无法读取当前安装包路径", "Cannot read installed APK"));
        }
        String installedSha = sha256Hex(baseApk);
        String installedCert = getInstalledCertSha256(ctx);
        if (installedCert == null || installedCert.isEmpty()) {
            throw new IOException(Localize.t(ctx, "无法读取当前应用签名证书", "Cannot read installed app signing certificate"));
        }

        cb.onStage(Localize.t(ctx, "正在检查更新清单…", "Checking update manifest…"), 12);
        String sep = feedUrl.contains("?") ? "&" : "?";
        byte[] manifestBytes = fetchBytesWithHostFallback(ctx, feedUrl + sep + "t=" + System.currentTimeMillis(), 2 * 1024 * 1024);
        JSONObject manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));

        String schema = manifest.optString("schema", "");
        String pkgName = manifest.optString("packageName", "");
        String versionName = manifest.optString("versionName", "");
        long versionCode = manifest.optLong("versionCode", -1L);
        String buildId = manifest.optString("buildId", "");
        String targetSha = manifest.optString("sha256", "").toLowerCase(Locale.US);
        long targetSize = manifest.optLong("size", -1L);
        String certSha = manifest.optString("certificateSha256", "").toLowerCase(Locale.US);
        String fullUrl = manifest.optString("fullUrl", manifest.optString("url", "")).trim();
        String notes = manifest.optString("notes", "").trim();

        if (!EXPECTED_SCHEMA.equals(schema) || targetSha.length() != 64 || targetSize <= 0 || targetSize > MAX_APK_BYTES) {
            throw new IOException(Localize.t(ctx, "更新清单格式无效", "Malformed update manifest"));
        }
        if (!pkgName.equals(ctx.getPackageName())) {
            throw new IOException(Localize.t(ctx,
                    "包名不匹配：当前为 " + ctx.getPackageName() + "，更新包为 " + pkgName,
                    "Package mismatch: installed " + ctx.getPackageName() + ", update " + pkgName));
        }
        if (!certSha.isEmpty() && !certSha.equalsIgnoreCase(installedCert)) {
            throw new IOException(Localize.t(ctx, "签名证书不匹配，已拒绝更新", "Signing certificate mismatch"));
        }

        String versionLabel = versionName + (buildId.isEmpty() ? "" : (" · " + buildId));
        if (targetSha.equalsIgnoreCase(installedSha)) {
            cb.onUpToDate(getCurrentVersionLabel(ctx), installedSha.substring(0, 12));
            return;
        }

        File updatesDir = new File(ctx.getFilesDir(), "updates");
        if (!updatesDir.exists()) updatesDir.mkdirs();
        File readyApk = new File(updatesDir, "ready-" + targetSha.substring(0, 12) + ".apk");

        // Reuse already staged verified APK if present
        if (readyApk.isFile() && readyApk.length() == targetSize && sha256Hex(readyApk).equalsIgnoreCase(targetSha)) {
            verifyStagedApk(ctx, readyApk, installedCert);
            cb.onReady(readyApk, versionLabel, true, 0L, targetSize, notes);
            return;
        }

        // Look for matching incremental delta
        JSONObject matchedDelta = null;
        JSONArray deltas = manifest.optJSONArray("deltas");
        if (deltas != null) {
            for (int i = 0; i < deltas.length(); i++) {
                JSONObject d = deltas.optJSONObject(i);
                if (d == null) continue;
                String fromSha = d.optString("fromSha256", "").toLowerCase(Locale.US);
                String dUrl = d.optString("url", "").trim();
                String dSha = d.optString("sha256", "").toLowerCase(Locale.US);
                long dSize = d.optLong("size", -1L);
                if (fromSha.equalsIgnoreCase(installedSha) && !dUrl.isEmpty() && dSha.length() == 64 && dSize > 0) {
                    matchedDelta = d;
                    break;
                }
            }
        }

        File tmpApk = new File(updatesDir, "staging-" + targetSha.substring(0, 12) + ".apk.tmp");
        tmpApk.delete();

        boolean usedDelta = false;
        long downloadedBytes = 0L;

        if (matchedDelta != null) {
            String deltaUrl = resolveRelativeUrl(feedUrl, matchedDelta.getString("url"));
            String deltaSha = matchedDelta.getString("sha256").toLowerCase(Locale.US);
            long deltaSize = matchedDelta.getLong("size");
            File tmpDelta = new File(updatesDir, "patch-" + targetSha.substring(0, 12) + ".gbdelta.tmp");
            tmpDelta.delete();
            try {
                String sizeLabel = formatBytes(deltaSize) + " / " + formatBytes(targetSize);
                cb.onStage(Localize.t(ctx, "正在下载增量补丁 (" + sizeLabel + ")…", "Downloading delta patch (" + sizeLabel + ")…"), 20);
                downloadToFileWithHostFallback(ctx, deltaUrl, deltaSize, tmpDelta, (done, total) -> {
                    int pct = 20 + (int) (total > 0 ? (done * 40L / total) : 0L);
                    cb.onStage(Localize.t(ctx, "正在下载增量补丁 (" + formatBytes(done) + " / " + formatBytes(deltaSize) + ")…",
                            "Downloading delta (" + formatBytes(done) + " / " + formatBytes(deltaSize) + ")…"), Math.min(60, pct));
                });
                String actualDeltaSha = sha256Hex(tmpDelta);
                if (!actualDeltaSha.equalsIgnoreCase(deltaSha)) {
                    throw new IOException("Delta SHA-256 mismatch");
                }
                cb.onStage(Localize.t(ctx, "正在本地合并增量更新包…", "Applying incremental delta locally…"), 65);
                DeltaPatcher.apply(baseApk, tmpDelta, tmpApk, (written, total) -> {
                    int pct = 65 + (int) (total > 0 ? (written * 25L / total) : 0L);
                    cb.onStage(Localize.t(ctx, "正在合并增量包 (" + Math.min(100, (int) (written * 100L / Math.max(1L, total))) + "%)…",
                            "Applying delta (" + Math.min(100, (int) (written * 100L / Math.max(1L, total))) + "%)…"), Math.min(90, pct));
                });
                usedDelta = true;
                downloadedBytes = deltaSize;
            } catch (Throwable deltaErr) {
                Log.w(TAG, "Delta update failed, falling back to full APK if available", deltaErr);
                tmpApk.delete();
                if (fullUrl.isEmpty()) {
                    throw new IOException(Localize.t(ctx, "增量补丁应用失败：" + deltaErr.getMessage(), "Delta apply failed: " + deltaErr.getMessage()));
                }
            } finally {
                tmpDelta.delete();
            }
        }

        if (!usedDelta) {
            if (fullUrl.isEmpty()) {
                throw new IOException(Localize.t(ctx, "未找到匹配当前版本的增量补丁，且未配置完整包地址", "No matching delta or full APK URL"));
            }
            String resolvedFull = resolveRelativeUrl(feedUrl, fullUrl);
            cb.onStage(Localize.t(ctx, "正在下载完整安装包 (" + formatBytes(targetSize) + ")…",
                    "Downloading full APK (" + formatBytes(targetSize) + ")…"), 20);
            downloadToFileWithHostFallback(ctx, resolvedFull, targetSize, tmpApk, (done, total) -> {
                int pct = 20 + (int) (total > 0 ? (done * 70L / total) : 0L);
                cb.onStage(Localize.t(ctx, "正在下载完整包 (" + formatBytes(done) + " / " + formatBytes(targetSize) + ")…",
                        "Downloading full APK (" + formatBytes(done) + " / " + formatBytes(targetSize) + ")…"), Math.min(90, pct));
            });
            downloadedBytes = targetSize;
        }

        cb.onStage(Localize.t(ctx, "正在校验安装包哈希与签名…", "Verifying APK checksum and signature…"), 93);
        if (tmpApk.length() != targetSize || !sha256Hex(tmpApk).equalsIgnoreCase(targetSha)) {
            tmpApk.delete();
            throw new IOException(Localize.t(ctx, "合并后的 APK 校验失败（SHA-256 不一致）", "Reconstructed APK SHA-256 mismatch"));
        }
        verifyStagedApk(ctx, tmpApk, installedCert);

        // Clean older staged APKs
        File[] existing = updatesDir.listFiles();
        if (existing != null) {
            for (File f : existing) {
                if (f.getName().startsWith("ready-") && !f.equals(readyApk)) {
                    f.delete();
                }
            }
        }
        if (readyApk.exists()) readyApk.delete();
        if (!tmpApk.renameTo(readyApk)) {
            tmpApk.delete();
            throw new IOException("Failed to stage verified APK");
        }

        cb.onReady(readyApk, versionLabel, usedDelta, downloadedBytes, targetSize, notes);
    }

    public static boolean launchInstaller(Context context, File apkFile) throws IOException {
        if (apkFile == null || !apkFile.isFile()) {
            throw new IOException(Localize.t(context, "更新包文件不存在", "Staged APK missing"));
        }
        if (Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls()) {
            Intent perm = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.getPackageName()));
            perm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(perm);
            return false;
        }
        Uri contentUri = ApkUpdateProvider.uriFor(context, apkFile);
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(contentUri, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(install);
        return true;
    }

    @SuppressWarnings("deprecation")
    private static void verifyStagedApk(Context ctx, File apkFile, String expectedCertSha256) throws IOException {
        PackageManager pm = ctx.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo info = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
        if (info == null) {
            throw new IOException(Localize.t(ctx, "无法解析更新包信息", "Cannot parse staged APK"));
        }
        if (!ctx.getPackageName().equals(info.packageName)) {
            throw new IOException(Localize.t(ctx, "更新包包名不一致", "Staged APK package mismatch"));
        }
        String stagedCert = extractCertSha256(info);
        if (stagedCert == null || !stagedCert.equalsIgnoreCase(expectedCertSha256)) {
            throw new IOException(Localize.t(ctx, "更新包签名证书与当前应用不一致", "Staged APK certificate mismatch"));
        }
    }

    @SuppressWarnings("deprecation")
    private static String getInstalledCertSha256(Context ctx) {
        try {
            PackageManager pm = ctx.getPackageManager();
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            PackageInfo info = pm.getPackageInfo(ctx.getPackageName(), flags);
            return extractCertSha256(info);
        } catch (Throwable ignored) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private static String extractCertSha256(PackageInfo info) {
        if (info == null) return null;
        Signature[] sigs = null;
        if (Build.VERSION.SDK_INT >= 28) {
            SigningInfo si = info.signingInfo;
            if (si != null) {
                sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
            }
        }
        if (sigs == null || sigs.length == 0) {
            sigs = info.signatures;
        }
        if (sigs == null || sigs.length == 0) return null;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] dig = md.digest(sigs[0].toByteArray());
            return toHex(dig);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String resolveRelativeUrl(String baseUrl, String maybeRelative) {
        if (maybeRelative.startsWith("http://") || maybeRelative.startsWith("https://")) {
            return maybeRelative;
        }
        try {
            return new URL(new URL(baseUrl), maybeRelative).toString();
        } catch (Throwable ignored) {
            return maybeRelative;
        }
    }

    private static byte[] fetchBytesWithHostFallback(Context ctx, String targetUrl, int maxBytes) throws IOException {
        IOException lastErr = null;
        if (Storage.isPaired(ctx) && Storage.isTailcatEnabled(ctx)) {
            try {
                return fetchBytesViaHostProxy(ctx, targetUrl, maxBytes);
            } catch (IOException e) {
                lastErr = e;
            }
        }
        try {
            return fetchBytesDirect(targetUrl, null, maxBytes);
        } catch (IOException directErr) {
            if (Storage.isPaired(ctx) && !Storage.isTailcatEnabled(ctx)) {
                try {
                    return fetchBytesViaHostProxy(ctx, targetUrl, maxBytes);
                } catch (IOException ignored) {}
            }
            throw lastErr != null ? lastErr : directErr;
        }
    }

    private static void downloadToFileWithHostFallback(
            Context ctx, String targetUrl, long expectedSize, File outFile,
            DeltaPatcher.ProgressListener listener) throws IOException {
        IOException lastErr = null;
        if (Storage.isPaired(ctx) && Storage.isTailcatEnabled(ctx)) {
            try {
                downloadViaHostProxy(ctx, targetUrl, expectedSize, outFile, listener);
                return;
            } catch (IOException e) {
                lastErr = e;
            }
        }
        try {
            downloadDirect(targetUrl, null, expectedSize, outFile, listener);
        } catch (IOException directErr) {
            if (Storage.isPaired(ctx) && !Storage.isTailcatEnabled(ctx)) {
                try {
                    downloadViaHostProxy(ctx, targetUrl, expectedSize, outFile, listener);
                    return;
                } catch (IOException ignored) {}
            }
            throw lastErr != null ? lastErr : directErr;
        }
    }

    private static String buildHostProxyUrl(Context ctx, String targetUrl) throws IOException {
        String base = Storage.getGatewayUrl(ctx);
        if (Storage.isTailcatEnabled(ctx)) {
            String resolved = TailcatManager.get().resolveServerUrl(ctx);
            if (resolved != null && !resolved.isEmpty()) base = resolved;
        }
        if (base == null || base.isEmpty()) throw new IOException("No paired Host URL");
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base + "/local/updates/fetch?url=" + URLEncoder.encode(targetUrl, "UTF-8");
    }

    private static byte[] fetchBytesViaHostProxy(Context ctx, String targetUrl, int maxBytes) throws IOException {
        String proxyUrl = buildHostProxyUrl(ctx, targetUrl);
        return fetchBytesDirect(proxyUrl, Storage.getToken(ctx), maxBytes);
    }

    private static void downloadViaHostProxy(
            Context ctx, String targetUrl, long expectedSize, File outFile,
            DeltaPatcher.ProgressListener listener) throws IOException {
        String proxyUrl = buildHostProxyUrl(ctx, targetUrl);
        downloadDirect(proxyUrl, Storage.getToken(ctx), expectedSize, outFile, listener);
    }

    private static byte[] fetchBytesDirect(String urlStr, String bearerToken, int maxBytes) throws IOException {
        HttpURLConnection conn = openConnection(urlStr, bearerToken);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("HTTP " + code + " fetching " + urlStr);
            }
            try (InputStream is = new BufferedInputStream(conn.getInputStream())) {
                return readAllBytes(is, maxBytes);
            }
        } finally {
            conn.disconnect();
        }
    }

    private static void downloadDirect(
            String urlStr, String bearerToken, long expectedSize, File outFile,
            DeltaPatcher.ProgressListener listener) throws IOException {
        HttpURLConnection conn = openConnection(urlStr, bearerToken);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("HTTP " + code + " downloading update");
            }
            long total = conn.getContentLengthLong();
            if (total <= 0) total = expectedSize;
            byte[] buf = new byte[32768];
            long done = 0L;
            long lastReported = 0L;
            try (InputStream is = new BufferedInputStream(conn.getInputStream());
                 FileOutputStream fos = new FileOutputStream(outFile)) {
                int n;
                while ((n = is.read(buf)) != -1) {
                    fos.write(buf, 0, n);
                    done += n;
                    if (done > MAX_APK_BYTES) {
                        throw new IOException("Download exceeded size limit");
                    }
                    if (listener != null && (done - lastReported >= 65536L || done == total)) {
                        lastReported = done;
                        listener.onProgress(done, total);
                    }
                }
                fos.flush();
            }
        } finally {
            conn.disconnect();
        }
    }

    private static HttpURLConnection openConnection(String urlStr, String bearerToken) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(60000);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("Cache-Control", "no-store");
        if (bearerToken != null && !bearerToken.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
        }
        return conn;
    }

    private static byte[] readAllBytes(InputStream is, int maxBytes) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        while ((n = is.read(buf)) != -1) {
            total += n;
            if (total > maxBytes) throw new IOException("Response too large");
            baos.write(buf, 0, n);
        }
        return baos.toByteArray();
    }

    public static String sha256Hex(File file) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[65536];
            try (InputStream is = new BufferedInputStream(new FileInputStream(file))) {
                int n;
                while ((n = is.read(buf)) != -1) {
                    md.update(buf, 0, n);
                }
            }
            return toHex(md.digest());
        } catch (IOException e) {
            throw e;
        } catch (Throwable t) {
            throw new IOException("SHA-256 unavailable", t);
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >>> 4) & 0xf, 16));
            sb.append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }

    public static String formatBytes(long bytes) {
        if (bytes < 1024L) return bytes + " B";
        if (bytes < 1024L * 1024L) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
    }
}

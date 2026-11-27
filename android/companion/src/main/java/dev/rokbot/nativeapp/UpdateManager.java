package dev.rokbot.nativeapp;

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
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * In-app incremental APK updater for RokBot Native Android.
 * Checks update manifests (paired Host /local/updates/android.json with Bearer auth,
 * direct external URLs, or Host /local/updates/fetch proxy), prefers RBDELTA1 incremental
 * patches matched by installed APK SHA-256, verifies target SHA-256 + signing certificate,
 * and launches PackageInstaller.
 */
public final class UpdateManager {
    private static final String TAG = "RokBotUpdater";
    private static final String EXPECTED_SCHEMA = "rokbot-android-native-update/v1";
    private static final String LEGACY_SCHEMA = "grokbot-android-native-update/v1";
    private static final long MAX_APK_BYTES = 512L * 1024L * 1024L;

    public interface Callback {
        void onStage(String message, int progressPercent);
        void onUpToDate(String currentVersion, String shortSha);
        void onReady(File stagedApk, String versionLabel, boolean usedDelta, long downloadBytes, long fullBytes, String notes);
        void onError(String message);
    }

    public interface CheckCallback {
        void onUpToDate(String currentVersion, String shortSha);
        void onUpdateAvailable(UpdateManifestInfo info);
        void onError(String message);
    }

    public static final class UpdateManifestInfo {
        public final String currentVersionLabel;
        public final long currentVersionCode;
        public final String installedSha256;
        public final String installedCertSha256;
        public final String availableVersionName;
        public final long availableVersionCode;
        public final String versionLabel;
        public final String releaseNotes;
        public final String targetSha256;
        public final String fullUrl;
        public final long fullSize;
        public final boolean hasDelta;
        public final String deltaUrl;
        public final String deltaSha256;
        public final long deltaSize;
        public final boolean alreadyStaged;
        public final File stagedFile;
        public final String feedUrl;
        public final String rawManifestJson;

        UpdateManifestInfo(
                String currentVersionLabel,
                long currentVersionCode,
                String installedSha256,
                String installedCertSha256,
                String availableVersionName,
                long availableVersionCode,
                String versionLabel,
                String releaseNotes,
                String targetSha256,
                String fullUrl,
                long fullSize,
                boolean hasDelta,
                String deltaUrl,
                String deltaSha256,
                long deltaSize,
                boolean alreadyStaged,
                File stagedFile,
                String feedUrl,
                String rawManifestJson) {
            this.currentVersionLabel = currentVersionLabel;
            this.currentVersionCode = currentVersionCode;
            this.installedSha256 = installedSha256;
            this.installedCertSha256 = installedCertSha256;
            this.availableVersionName = availableVersionName;
            this.availableVersionCode = availableVersionCode;
            this.versionLabel = versionLabel;
            this.releaseNotes = releaseNotes;
            this.targetSha256 = targetSha256;
            this.fullUrl = fullUrl;
            this.fullSize = fullSize;
            this.hasDelta = hasDelta;
            this.deltaUrl = deltaUrl;
            this.deltaSha256 = deltaSha256;
            this.deltaSize = deltaSize;
            this.alreadyStaged = alreadyStaged;
            this.stagedFile = stagedFile;
            this.feedUrl = feedUrl;
            this.rawManifestJson = rawManifestJson;
        }
    }

    /** Non-2xx answer from the update feed or download endpoint (404 = nothing published yet). */
    public static final class HttpStatusException extends IOException {
        public final int status;

        HttpStatusException(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private UpdateManager() {}

    /** Android only replaces an installed package with an equal or higher versionCode; we only offer strictly higher ones. */
    public static boolean isNewerVersionCode(long installedVersionCode, long availableVersionCode) {
        return availableVersionCode > 0 && availableVersionCode > installedVersionCode;
    }

    public static String getInstalledVersionName(Context context) {
        try {
            PackageInfo pi = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return pi.versionName != null ? pi.versionName : "";
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static String getCurrentVersionLabel(Context context) {
        try {
            PackageInfo pi = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            long vc = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            return (pi.versionName != null ? pi.versionName : "1.0.0") + " (" + vc + ")";
        } catch (Throwable ignored) {
            return "unknown";
        }
    }

    @SuppressWarnings("deprecation")
    public static long getInstalledVersionCode(Context context) {
        try {
            PackageInfo pi = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Throwable ignored) {
            return -1L;
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

    private static String readBundledUpdateConfigUrl(Context context) {
        if (context == null) return "";
        try (InputStream is = context.getAssets().open("recipes/update-config.json")) {
            byte[] raw = readAllBytes(is, 64 * 1024);
            JSONObject obj = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            String url = UiChrome.jsonStr(obj, "updateFeedUrl").trim();
            if (url.startsWith("http://") || url.startsWith("https://")) {
                return url;
            }
        } catch (Throwable ignored) {}
        return "";
    }

    private static boolean isLoopbackHttpUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return false;
        try {
            URI u = URI.create(rawUrl.trim());
            return GatewayEndpointRouter.isLoopbackHost(u.getHost());
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static String resolveExternalFallbackFeedUrl(Context context) {
        if (context == null) return "";
        String saved = Storage.getUpdateFeedUrl(context);
        if (saved != null) {
            String trimmed = saved.trim();
            if ((trimmed.startsWith("http://") || trimmed.startsWith("https://")) && !isLoopbackHttpUrl(trimmed)) {
                return trimmed;
            }
        }
        String bundled = readBundledUpdateConfigUrl(context);
        if (!bundled.isEmpty()) return bundled;
        if (!Storage.isTailcatEnabled(context)) {
            String gw = Storage.getGatewayUrl(context);
            if (gw != null) {
                String trimmed = gw.trim();
                if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
                    while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
                    return trimmed + "/local/updates/android.json";
                }
            }
        }
        String reported = Storage.getReportedGatewayUrl(context);
        if (reported != null) {
            String trimmed = reported.trim();
            if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
                while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
                return trimmed + "/local/updates/android.json";
            }
        }
        return "";
    }

    public static String resolveDefaultFeedUrl(Context context) {
        if (context != null && Storage.isPaired(context)) {
            String base = resolvePairedHostBase(context);
            if (!base.isEmpty()) {
                return base + "/local/updates/android.json";
            }
        }
        String external = resolveExternalFallbackFeedUrl(context);
        if (!external.isEmpty()) return external;
        if (context != null) {
            String saved = Storage.getUpdateFeedUrl(context);
            if (saved != null && !saved.trim().isEmpty()) return saved.trim();
        }
        return "";
    }

    public static String resolveEffectiveFeedUrl(Context context, String rawUrl) {
        String trimmed = rawUrl != null ? rawUrl.trim() : "";
        if (trimmed.isEmpty()) {
            return resolveDefaultFeedUrl(context);
        }
        if (trimmed.startsWith("/")) {
            String base = resolvePairedHostBase(context);
            if (!base.isEmpty()) {
                return base + trimmed;
            }
            String fallback = resolveExternalFallbackFeedUrl(context);
            if (!fallback.isEmpty()) {
                return resolveRelativeUrl(fallback, trimmed);
            }
            return trimmed;
        }
        if (context != null && Storage.isPaired(context) && isPairedHostUrl(context, trimmed)) {
            String base = resolvePairedHostBase(context);
            if (!base.isEmpty()) {
                return rewriteUrlToBase(trimmed, base);
            }
        }
        return trimmed;
    }

    private static String resolvePairedHostBase(Context context) {
        if (context == null || !Storage.isPaired(context)) return "";
        String base = null;
        try {
            base = HostApiClient.resolveServer(context);
        } catch (Throwable ignored) {}
        if ((base == null || base.isEmpty()) && !Storage.isTailcatEnabled(context)) {
            base = Storage.getGatewayUrl(context);
        }
        if (base == null) return "";
        base = base.trim();
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            return "";
        }
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base;
    }

    public static void checkManifestAsync(Context context, String feedUrl, CheckCallback cb) {
        final Context appCtx = context.getApplicationContext();
        new Thread(() -> {
            try {
                String effectiveUrl = resolveEffectiveFeedUrl(appCtx, feedUrl);
                ParsedManifest parsed = fetchAndParseManifest(appCtx, effectiveUrl);
                if (parsed.upToDate) {
                    cb.onUpToDate(getCurrentVersionLabel(appCtx), parsed.shortSha);
                } else {
                    cb.onUpdateAvailable(parsed.info);
                }
            } catch (Throwable t) {
                Log.w(TAG, "Manifest check failed", t);
                cb.onError(t.getMessage() != null && !t.getMessage().isEmpty() ? t.getMessage() : t.getClass().getSimpleName());
            }
        }, "RokBotUpdateCheck").start();
    }

    public static void stageFromInfoAsync(Context context, UpdateManifestInfo info, Callback cb) {
        final Context appCtx = context.getApplicationContext();
        new Thread(() -> {
            try {
                if (info == null) {
                    throw new IllegalArgumentException(Localize.t(appCtx, "缺少更新信息", "Missing update metadata"));
                }
                File baseApk = new File(appCtx.getApplicationInfo().sourceDir);
                if (!baseApk.isFile()) {
                    throw new IOException(Localize.t(appCtx, "无法读取当前安装包路径", "Cannot read installed APK"));
                }
                stageUpdateFromInfo(appCtx, baseApk, info, cb);
            } catch (Throwable t) {
                Log.w(TAG, "Update staging failed", t);
                cb.onError(t.getMessage() != null && !t.getMessage().isEmpty() ? t.getMessage() : t.getClass().getSimpleName());
            }
        }, "RokBotUpdateStage").start();
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
        }, "RokBotUpdater").start();
    }

    private static final class ParsedManifest {
        final boolean upToDate;
        final String shortSha;
        final UpdateManifestInfo info;

        ParsedManifest(boolean upToDate, String shortSha, UpdateManifestInfo info) {
            this.upToDate = upToDate;
            this.shortSha = shortSha;
            this.info = info;
        }
    }

    private static void performCheckAndStage(Context ctx, String rawFeedUrl, Callback cb) throws Exception {
        String feedUrl = resolveEffectiveFeedUrl(ctx, rawFeedUrl);
        if (feedUrl.isEmpty() || (!feedUrl.startsWith("https://") && !feedUrl.startsWith("http://"))) {
            throw new IllegalArgumentException(Localize.t(ctx, "请先填写有效的更新源地址（http/https）", "Enter a valid update feed URL (http/https)"));
        }

        cb.onStage(Localize.t(ctx, "正在计算当前安装包指纹…", "Fingerprinting installed APK…"), 5);
        File baseApk = new File(ctx.getApplicationInfo().sourceDir);
        if (!baseApk.isFile()) {
            throw new IOException(Localize.t(ctx, "无法读取当前安装包路径", "Cannot read installed APK"));
        }

        cb.onStage(Localize.t(ctx, "正在检查更新清单…", "Checking update manifest…"), 12);
        ParsedManifest parsed = fetchAndParseManifest(ctx, feedUrl);
        if (parsed.upToDate) {
            cb.onUpToDate(getCurrentVersionLabel(ctx), parsed.shortSha);
            return;
        }
        stageUpdateFromInfo(ctx, baseApk, parsed.info, cb);
    }

    private static ParsedManifest fetchAndParseManifest(Context ctx, String rawFeedUrl) throws Exception {
        String feedUrl = resolveEffectiveFeedUrl(ctx, rawFeedUrl);
        if (feedUrl.isEmpty() || (!feedUrl.startsWith("https://") && !feedUrl.startsWith("http://"))) {
            throw new IllegalArgumentException(Localize.t(ctx, "请先填写有效的更新源地址（http/https）", "Enter a valid update feed URL (http/https)"));
        }

        File baseApk = new File(ctx.getApplicationInfo().sourceDir);
        if (!baseApk.isFile()) {
            throw new IOException(Localize.t(ctx, "无法读取当前安装包路径", "Cannot read installed APK"));
        }
        String installedSha = sha256Hex(baseApk);
        long installedVersionCode = getInstalledVersionCode(ctx);
        String installedCert = getInstalledCertSha256(ctx);
        if (installedCert == null || installedCert.isEmpty()) {
            throw new IOException(Localize.t(ctx, "无法读取当前应用签名证书", "Cannot read installed app signing certificate"));
        }

        String sep = feedUrl.contains("?") ? "&" : "?";
        byte[] manifestBytes = fetchBytesWithHostFallback(ctx, feedUrl + sep + "t=" + System.currentTimeMillis(), 2 * 1024 * 1024);
        String rawJson = new String(manifestBytes, StandardCharsets.UTF_8);
        JSONObject manifest = new JSONObject(rawJson);

        String schema = UiChrome.jsonStr(manifest, "schema");
        JSONObject latest = manifest.optJSONObject("latest");
        JSONObject meta = latest != null ? latest : manifest;

        String pkgName = optStringAny(meta, manifest, "packageName");
        String versionName = optStringAny(meta, manifest, "versionName");
        long versionCode = optLongAny(meta, manifest, "versionCode", -1L);
        String buildId = optStringAny(meta, manifest, "buildId");
        String targetSha = optStringAny(meta, manifest, "apkSha256", "sha256").toLowerCase(Locale.US);
        long targetSize = optLongAny(meta, manifest, "apkSize", "size", -1L);
        String certSha = normalizeCertSha(optStringAny(meta, manifest, "certificateSha256"));
        String fullUrl = optStringAny(meta, manifest, "apkUrl", "fullUrl", "url").trim();
        String notes = optStringAny(meta, manifest, "releaseNotes", "notes").trim();

        if ((!EXPECTED_SCHEMA.equals(schema) && !LEGACY_SCHEMA.equals(schema))
                || targetSha.length() != 64 || targetSize <= 0 || targetSize > MAX_APK_BYTES) {
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

        String shortSha = installedSha.length() >= 12 ? installedSha.substring(0, 12) : installedSha;
        if (targetSha.equalsIgnoreCase(installedSha)) {
            return new ParsedManifest(true, shortSha, null);
        }
        if (versionCode > 0 && installedVersionCode > 0 && versionCode < installedVersionCode) {
            return new ParsedManifest(true, shortSha, null);
        }

        String versionLabel = versionName;
        if (!buildId.isEmpty()) {
            versionLabel = versionLabel + " · " + buildId;
        } else if (versionCode > 0) {
            versionLabel = versionLabel + " (" + versionCode + ")";
        }

        File updatesDir = new File(ctx.getFilesDir(), "updates");
        if (!updatesDir.exists()) updatesDir.mkdirs();
        File readyApk = new File(updatesDir, "ready-" + targetSha.substring(0, 12) + ".apk");
        boolean alreadyStaged = false;
        if (readyApk.isFile() && readyApk.length() == targetSize && sha256Hex(readyApk).equalsIgnoreCase(targetSha)) {
            try {
                verifyStagedApk(ctx, readyApk, installedCert);
                alreadyStaged = true;
            } catch (Throwable ignored) {
                readyApk.delete();
            }
        }

        JSONArray deltas = meta.optJSONArray("deltas");
        if (deltas == null) deltas = manifest.optJSONArray("deltas");
        String deltaUrl = "";
        String deltaSha = "";
        long deltaSize = -1L;
        if (deltas != null) {
            for (int i = 0; i < deltas.length(); i++) {
                JSONObject d = deltas.optJSONObject(i);
                if (d == null) continue;
                String fromSha = UiChrome.jsonStr(d, "fromApkSha256", UiChrome.jsonStr(d, "fromSha256")).trim().toLowerCase(Locale.US);
                String format = UiChrome.jsonStr(d, "format").trim();
                if (!format.isEmpty() && !"RBDELTA1".equalsIgnoreCase(format) && !"GBDELTA1".equalsIgnoreCase(format)) {
                    continue;
                }
                String dUrl = UiChrome.jsonStr(d, "url").trim();
                String dSha = UiChrome.jsonStr(d, "sha256").trim().toLowerCase(Locale.US);
                long dSize = d.optLong("size", -1L);
                if (fromSha.equalsIgnoreCase(installedSha) && !dUrl.isEmpty() && dSha.length() == 64 && dSize > 0) {
                    deltaUrl = resolveManifestResourceUrl(ctx, feedUrl, dUrl);
                    deltaSha = dSha;
                    deltaSize = dSize;
                    break;
                }
            }
        }

        String resolvedFull = fullUrl.isEmpty() ? "" : resolveManifestResourceUrl(ctx, feedUrl, fullUrl);
        UpdateManifestInfo info = new UpdateManifestInfo(
                getCurrentVersionLabel(ctx),
                installedVersionCode,
                installedSha,
                installedCert,
                versionName,
                versionCode,
                versionLabel,
                notes,
                targetSha,
                resolvedFull,
                targetSize,
                !deltaUrl.isEmpty(),
                deltaUrl,
                deltaSha,
                deltaSize,
                alreadyStaged,
                alreadyStaged ? readyApk : null,
                feedUrl,
                rawJson
        );
        return new ParsedManifest(false, shortSha, info);
    }

    private static void stageUpdateFromInfo(Context ctx, File baseApk, UpdateManifestInfo info, Callback cb) throws Exception {
        File updatesDir = new File(ctx.getFilesDir(), "updates");
        if (!updatesDir.exists()) updatesDir.mkdirs();
        File readyApk = new File(updatesDir, "ready-" + info.targetSha256.substring(0, 12) + ".apk");

        if (readyApk.isFile() && readyApk.length() == info.fullSize && sha256Hex(readyApk).equalsIgnoreCase(info.targetSha256)) {
            verifyStagedApk(ctx, readyApk, info.installedCertSha256);
            cb.onReady(readyApk, info.versionLabel, true, 0L, info.fullSize, info.releaseNotes);
            return;
        }

        File tmpApk = new File(updatesDir, "staging-" + info.targetSha256.substring(0, 12) + ".apk.tmp");
        tmpApk.delete();

        boolean usedDelta = false;
        long downloadedBytes = 0L;

        if (info.hasDelta && !info.deltaUrl.isEmpty()) {
            File tmpDelta = new File(updatesDir, "patch-" + info.targetSha256.substring(0, 12) + ".rbdelta.tmp");
            tmpDelta.delete();
            try {
                String sizeLabel = formatBytes(info.deltaSize) + " / " + formatBytes(info.fullSize);
                cb.onStage(Localize.t(ctx, "正在下载增量补丁 (" + sizeLabel + ")…", "Downloading delta patch (" + sizeLabel + ")…"), 20);
                downloadToFileWithHostFallback(ctx, info.deltaUrl, info.deltaSize, tmpDelta, (done, total) -> {
                    int pct = 20 + (int) (total > 0 ? (done * 40L / total) : 0L);
                    cb.onStage(Localize.t(ctx, "正在下载增量补丁 (" + formatBytes(done) + " / " + formatBytes(info.deltaSize) + ")…",
                            "Downloading delta (" + formatBytes(done) + " / " + formatBytes(info.deltaSize) + ")…"), Math.min(60, pct));
                });
                String actualDeltaSha = sha256Hex(tmpDelta);
                if (!actualDeltaSha.equalsIgnoreCase(info.deltaSha256)) {
                    throw new IOException("Delta SHA-256 mismatch");
                }
                cb.onStage(Localize.t(ctx, "正在本地合并增量更新包…", "Applying incremental delta locally…"), 65);
                DeltaPatcher.apply(baseApk, tmpDelta, tmpApk, (written, total) -> {
                    int pct = 65 + (int) (total > 0 ? (written * 25L / total) : 0L);
                    cb.onStage(Localize.t(ctx, "正在合并增量包 (" + Math.min(100, (int) (written * 100L / Math.max(1L, total))) + "%)…",
                            "Applying delta (" + Math.min(100, (int) (written * 100L / Math.max(1L, total))) + "%)…"), Math.min(90, pct));
                });
                usedDelta = true;
                downloadedBytes = info.deltaSize;
            } catch (Throwable deltaErr) {
                Log.w(TAG, "Delta update failed, falling back to full APK if available", deltaErr);
                tmpApk.delete();
                if (info.fullUrl.isEmpty()) {
                    throw new IOException(Localize.t(ctx, "增量补丁应用失败：" + deltaErr.getMessage(), "Delta apply failed: " + deltaErr.getMessage()));
                }
            } finally {
                tmpDelta.delete();
            }
        }

        if (!usedDelta) {
            if (info.fullUrl.isEmpty()) {
                throw new IOException(Localize.t(ctx, "未找到匹配当前版本的增量补丁，且未配置完整包地址", "No matching delta or full APK URL"));
            }
            cb.onStage(Localize.t(ctx, "正在下载完整安装包 (" + formatBytes(info.fullSize) + ")…",
                    "Downloading full APK (" + formatBytes(info.fullSize) + ")…"), 20);
            downloadToFileWithHostFallback(ctx, info.fullUrl, info.fullSize, tmpApk, (done, total) -> {
                int pct = 20 + (int) (total > 0 ? (done * 70L / total) : 0L);
                cb.onStage(Localize.t(ctx, "正在下载完整包 (" + formatBytes(done) + " / " + formatBytes(info.fullSize) + ")…",
                        "Downloading full APK (" + formatBytes(done) + " / " + formatBytes(info.fullSize) + ")…"), Math.min(90, pct));
            });
            downloadedBytes = info.fullSize;
        }

        cb.onStage(Localize.t(ctx, "正在校验安装包哈希与签名…", "Verifying APK checksum and signature…"), 93);
        if (tmpApk.length() != info.fullSize || !sha256Hex(tmpApk).equalsIgnoreCase(info.targetSha256)) {
            tmpApk.delete();
            throw new IOException(Localize.t(ctx, "合并后的 APK 校验失败（SHA-256 不一致）", "Reconstructed APK SHA-256 mismatch"));
        }
        verifyStagedApk(ctx, tmpApk, info.installedCertSha256);

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

        cb.onReady(readyApk, info.versionLabel, usedDelta, downloadedBytes, info.fullSize, info.releaseNotes);
    }

    private static String optStringAny(JSONObject primary, JSONObject secondary, String... keys) {
        for (String key : keys) {
            String v = UiChrome.jsonStr(primary, key);
            if (!v.isEmpty()) return v;
        }
        if (secondary != null && secondary != primary) {
            for (String key : keys) {
                String v = UiChrome.jsonStr(secondary, key);
                if (!v.isEmpty()) return v;
            }
        }
        return "";
    }

    private static long optLongAny(JSONObject primary, JSONObject secondary, String k1, String k2, long fallback) {
        if (primary != null) {
            if (primary.has(k1) && !primary.isNull(k1)) return primary.optLong(k1, fallback);
            if (k2 != null && primary.has(k2) && !primary.isNull(k2)) return primary.optLong(k2, fallback);
        }
        if (secondary != null && secondary != primary) {
            if (secondary.has(k1) && !secondary.isNull(k1)) return secondary.optLong(k1, fallback);
            if (k2 != null && secondary.has(k2) && !secondary.isNull(k2)) return secondary.optLong(k2, fallback);
        }
        return fallback;
    }

    private static long optLongAny(JSONObject primary, JSONObject secondary, String k1, long fallback) {
        return optLongAny(primary, secondary, k1, null, fallback);
    }

    private static String normalizeCertSha(String raw) {
        if (raw == null) return "";
        return raw.replace(":", "").trim().toLowerCase(Locale.US);
    }

    /** REQUEST_INSTALL_PACKAGES is an app-op on Android 8+: the user must allow "install unknown apps" for RokBot. */
    public static boolean canInstallPackages(Context context) {
        if (Build.VERSION.SDK_INT < 26) return true;
        try {
            return context.getPackageManager().canRequestPackageInstalls();
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** Opens the per-app "Install unknown apps" switch for RokBot. */
    public static void openInstallPermissionSettings(Context context) {
        Intent perm = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.getPackageName()));
        perm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(perm);
    }

    public static boolean launchInstaller(Context context, File apkFile) throws IOException {
        if (apkFile == null || !apkFile.isFile()) {
            throw new IOException(Localize.t(context, "更新包文件不存在", "Staged APK missing"));
        }
        if (!canInstallPackages(context)) {
            openInstallPermissionSettings(context);
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
            throw new IOException(Localize.t(ctx, "更新包签名证书与当前应用不一致，已拒绝安装", "Staged APK certificate mismatch; refusing to install"));
        }
        long stagedVersionCode = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        long installedVersionCode = getInstalledVersionCode(ctx);
        if (stagedVersionCode > 0 && installedVersionCode > 0 && stagedVersionCode < installedVersionCode) {
            throw new IOException(Localize.t(ctx,
                    "更新包版本号 " + stagedVersionCode + " 低于当前版本 " + installedVersionCode + "，系统无法覆盖安装",
                    "Staged APK versionCode " + stagedVersionCode + " is lower than installed " + installedVersionCode));
        }
    }

    @SuppressWarnings("deprecation")
    static String getInstalledCertSha256(Context ctx) {
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

    private static boolean isLocalUpdatesPath(String urlStr) {
        if (urlStr == null || urlStr.isEmpty()) return false;
        try {
            String path = URI.create(urlStr.trim()).getRawPath();
            return path != null && (path.equals("/local/updates") || path.startsWith("/local/updates/"));
        } catch (Throwable ignored) {
            return false;
        }
    }

    static String resolveManifestResourceUrl(Context ctx, String feedUrl, String rawResourceUrl) {
        String resolved = resolveRelativeUrl(feedUrl, rawResourceUrl);
        if (ctx != null && Storage.isPaired(ctx)) {
            String activeBase = resolvePairedHostBase(ctx);
            if (!activeBase.isEmpty() && (isPairedHostUrl(ctx, resolved)
                    || (isPairedHostUrl(ctx, feedUrl) && isLocalUpdatesPath(resolved)))) {
                return rewriteUrlToBase(resolved, activeBase);
            }
        }
        return resolved;
    }

    private static boolean isReportedGatewayUrl(Context ctx, String targetUrl) {
        if (ctx == null || targetUrl == null || targetUrl.isEmpty()) return false;
        try {
            String reported = Storage.getReportedGatewayUrl(ctx);
            if (reported != null && (reported.startsWith("http://") || reported.startsWith("https://"))) {
                return sameOrigin(URI.create(targetUrl.trim()), URI.create(reported.trim()));
            }
        } catch (Throwable ignored) {}
        return false;
    }

    public static boolean isPairedHostUrl(Context ctx, String targetUrl) {
        if (ctx == null || targetUrl == null || targetUrl.isEmpty() || !Storage.isPaired(ctx)) {
            return false;
        }
        try {
            URI target = URI.create(targetUrl.trim());
            String path = target.getRawPath();
            String resolved = resolvePairedHostBase(ctx);
            if (!resolved.isEmpty() && sameOrigin(target, URI.create(resolved))) {
                return true;
            }
            String gw = Storage.getGatewayUrl(ctx);
            if (gw != null && (gw.startsWith("http://") || gw.startsWith("https://")) && sameOrigin(target, URI.create(gw))) {
                return true;
            }
            String reported = Storage.getReportedGatewayUrl(ctx);
            if (reported != null && (reported.startsWith("http://") || reported.startsWith("https://")) && sameOrigin(target, URI.create(reported))) {
                return true;
            }
            String bundled = readBundledUpdateConfigUrl(ctx);
            if (!bundled.isEmpty() && sameOrigin(target, URI.create(bundled)) && isLocalUpdatesPath(targetUrl)) {
                return true;
            }
            String saved = Storage.getUpdateFeedUrl(ctx);
            if (saved != null && !saved.isEmpty() && !isLoopbackHttpUrl(saved)
                    && (saved.startsWith("http://") || saved.startsWith("https://"))
                    && sameOrigin(target, URI.create(saved)) && isLocalUpdatesPath(targetUrl)) {
                return true;
            }
            int port = TailcatManager.extractLoopbackPort(targetUrl);
            if (port > 0 && TailcatManager.get().isKnownTailcatPort(port) && isLocalUpdatesPath(targetUrl)) {
                return true;
            }
            if (target.getScheme() == null && target.getHost() == null
                    && path != null && (path.equals("/local/updates/android.json") || path.startsWith("/local/updates/files/"))) {
                return true;
            }
        } catch (Throwable ignored) {}
        return false;
    }

    private static boolean sameOrigin(URI a, URI b) {
        if (a == null || b == null) return false;
        String sa = a.getScheme() != null ? a.getScheme().toLowerCase(Locale.US) : "";
        String sb = b.getScheme() != null ? b.getScheme().toLowerCase(Locale.US) : "";
        String ha = a.getHost() != null ? a.getHost().toLowerCase(Locale.US) : "";
        String hb = b.getHost() != null ? b.getHost().toLowerCase(Locale.US) : "";
        if (sa.isEmpty() || !sa.equals(sb) || ha.isEmpty() || !ha.equals(hb)) return false;
        int pa = a.getPort() != -1 ? a.getPort() : ("https".equals(sa) ? 443 : 80);
        int pb = b.getPort() != -1 ? b.getPort() : ("https".equals(sb) ? 443 : 80);
        return pa == pb;
    }

    private static String rewriteUrlToBase(String targetUrl, String baseOrigin) {
        if (baseOrigin == null || baseOrigin.isEmpty()) return targetUrl;
        String cleanBase = baseOrigin.trim();
        while (cleanBase.endsWith("/")) cleanBase = cleanBase.substring(0, cleanBase.length() - 1);
        try {
            URI baseUri = URI.create(cleanBase);
            String origin = baseUri.getScheme() + "://" + baseUri.getHost()
                    + (baseUri.getPort() != -1 ? (":" + baseUri.getPort()) : "");
            URI target = URI.create(targetUrl.trim());
            String path = target.getRawPath();
            if (path == null || path.isEmpty()) path = "/";
            String query = target.getRawQuery();
            return origin + path + (query != null && !query.isEmpty() ? ("?" + query) : "");
        } catch (Throwable ignored) {
            return targetUrl;
        }
    }

    private static String rewriteUrlToResolvedHost(Context ctx, String targetUrl) {
        String resolved = resolvePairedHostBase(ctx);
        return rewriteUrlToBase(targetUrl, resolved);
    }

    private static String resolveExternalFallbackUrlForTarget(Context ctx, String targetUrl, String activeBase) {
        String externalFeed = resolveExternalFallbackFeedUrl(ctx);
        if (externalFeed.isEmpty()) return "";
        try {
            URI extUri = URI.create(externalFeed);
            if (!activeBase.isEmpty() && sameOrigin(extUri, URI.create(activeBase))) {
                return "";
            }
            if (isLocalUpdatesPath(targetUrl)) {
                return rewriteUrlToBase(targetUrl, externalFeed);
            }
        } catch (Throwable ignored) {}
        return "";
    }

    private static boolean isTerminalHostStatus(IOException err) {
        if (!(err instanceof HttpStatusException)) return false;
        int status = ((HttpStatusException) err).status;
        return status == 401 || status == 403 || status == 404;
    }

    private static byte[] fetchBytesWithHostFallback(Context ctx, String targetUrl, int maxBytes) throws IOException {
        if (isPairedHostUrl(ctx, targetUrl)) {
            String token = Storage.getToken(ctx);
            String resolved = resolvePairedHostBase(ctx);
            if (!resolved.isEmpty()) {
                String directHostUrl = rewriteUrlToBase(targetUrl, resolved);
                try {
                    return fetchBytesDirect(directHostUrl, token, maxBytes);
                } catch (IOException hostErr) {
                    if (isTerminalHostStatus(hostErr)) throw hostErr;
                    String extUrl = resolveExternalFallbackUrlForTarget(ctx, targetUrl, resolved);
                    if (!extUrl.isEmpty()) {
                        try {
                            return fetchBytesDirect(extUrl, token, maxBytes);
                        } catch (IOException ignored) {}
                    }
                    throw hostErr;
                }
            }
            boolean tailcatBlockedReported = Storage.isTailcatEnabled(ctx)
                    && isReportedGatewayUrl(ctx, targetUrl)
                    && readBundledUpdateConfigUrl(ctx).isEmpty()
                    && (Storage.getUpdateFeedUrl(ctx) == null || Storage.getUpdateFeedUrl(ctx).trim().isEmpty());
            String extUrl = tailcatBlockedReported ? "" : resolveExternalFallbackUrlForTarget(ctx, targetUrl, "");
            if (!extUrl.isEmpty()) {
                return fetchBytesDirect(extUrl, token, maxBytes);
            }
            throw new IOException("Paired Host unavailable");
        }
        IOException lastErr = null;
        if (Storage.isPaired(ctx) && Storage.isTailcatEnabled(ctx)) {
            try {
                return fetchBytesViaHostProxy(ctx, targetUrl, maxBytes);
            } catch (IOException e) {
                lastErr = e;
            }
        }
        try {
            return fetchBytesDirect(targetUrl, isPairedHostUrl(ctx, targetUrl) ? Storage.getToken(ctx) : null, maxBytes);
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
        if (isPairedHostUrl(ctx, targetUrl)) {
            String token = Storage.getToken(ctx);
            String resolved = resolvePairedHostBase(ctx);
            if (!resolved.isEmpty()) {
                String directHostUrl = rewriteUrlToBase(targetUrl, resolved);
                try {
                    downloadDirect(directHostUrl, token, expectedSize, outFile, listener);
                    return;
                } catch (IOException hostErr) {
                    if (isTerminalHostStatus(hostErr)) throw hostErr;
                    String extUrl = resolveExternalFallbackUrlForTarget(ctx, targetUrl, resolved);
                    if (!extUrl.isEmpty()) {
                        try {
                            downloadDirect(extUrl, token, expectedSize, outFile, listener);
                            return;
                        } catch (IOException ignored) {}
                    }
                    throw hostErr;
                }
            }
            boolean tailcatBlockedReported = Storage.isTailcatEnabled(ctx)
                    && isReportedGatewayUrl(ctx, targetUrl)
                    && readBundledUpdateConfigUrl(ctx).isEmpty()
                    && (Storage.getUpdateFeedUrl(ctx) == null || Storage.getUpdateFeedUrl(ctx).trim().isEmpty());
            String extUrl = tailcatBlockedReported ? "" : resolveExternalFallbackUrlForTarget(ctx, targetUrl, "");
            if (!extUrl.isEmpty()) {
                downloadDirect(extUrl, token, expectedSize, outFile, listener);
                return;
            }
            throw new IOException("Paired Host unavailable");
        }
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
            downloadDirect(targetUrl, isPairedHostUrl(ctx, targetUrl) ? Storage.getToken(ctx) : null, expectedSize, outFile, listener);
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
        String base = resolvePairedHostBase(ctx);
        if (base.isEmpty()) throw new IOException("Paired Host unavailable");
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
                throw new HttpStatusException(code, "HTTP " + code + " fetching " + urlStr);
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
                throw new HttpStatusException(code, "HTTP " + code + " downloading update");
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
        conn.setRequestProperty("x-rokbot-client", "android-native/1.26.0");
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

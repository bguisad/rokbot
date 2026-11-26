package dev.rokbot.nativeapp;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * React Native resolves bundled images, SVGs, sounds and fonts next to the JS bundle when the bundle
 * is a file: {@code <bundle dir>/drawable-mdpi/<name>.png}, {@code <bundle dir>/raw/<name>}. The
 * companion runs the patched bundles from files/RokBotPaired and files/RokBotUnpaired, where those
 * folders did not exist, so every packaged asset failed to load (the RokBot app icon on the
 * notification prompt rendered as an empty tile, connector brand logos, sounds). This copies the
 * APK's React Native assets (res/raw and res/drawable-*, named assets_* / _node_modules_*) next to
 * the bundle once per install.
 */
final class BundleAssets {
    private static final String TAG = "RokBotBundleAssets";
    private static final String STAMP_FILE = ".assets-stamp";
    private static final Pattern ENTRY = Pattern.compile(
            "^res/(raw|drawable-(?:l|m|h|xh|xxh|xxxh)dpi)(?:-v\\d+)?/((?:assets_|_node_modules_)[^/]+)$");

    private BundleAssets() {}

    static synchronized void ensure(Context context, File bundleDir) {
        if (context == null || bundleDir == null) return;
        try {
            String stamp = HermesPatcher.installStamp(context);
            File stampFile = new File(bundleDir, STAMP_FILE);
            if (stampFile.isFile()) {
                try (InputStream is = new java.io.FileInputStream(stampFile)) {
                    if (stamp.equals(new String(HermesPatcher.readAllBytes(is), StandardCharsets.UTF_8))) return;
                }
            }
            ApplicationInfo ai = context.getApplicationInfo();
            List<String> apks = new ArrayList<>();
            if (ai.sourceDir != null) apks.add(ai.sourceDir);
            if (ai.splitSourceDirs != null) for (String s : ai.splitSourceDirs) apks.add(s);
            int copied = 0;
            byte[] buf = new byte[64 * 1024];
            for (String apk : apks) {
                try (ZipFile zip = new ZipFile(apk)) {
                    Enumeration<? extends ZipEntry> en = zip.entries();
                    while (en.hasMoreElements()) {
                        ZipEntry e = en.nextElement();
                        Matcher m = ENTRY.matcher(e.getName());
                        if (!m.matches()) continue;
                        File dir = new File(bundleDir, m.group(1));
                        if (!dir.isDirectory() && !dir.mkdirs()) continue;
                        File out = new File(dir, m.group(2));
                        File tmp = new File(dir, m.group(2) + ".tmp");
                        try (InputStream is = zip.getInputStream(e); FileOutputStream fos = new FileOutputStream(tmp)) {
                            int r;
                            while ((r = is.read(buf)) > 0) fos.write(buf, 0, r);
                        }
                        if (!tmp.renameTo(out)) tmp.delete();
                        else copied++;
                    }
                }
            }
            HermesPatcher.writeAtomically(stampFile, stamp.getBytes(StandardCharsets.UTF_8));
            Log.i(TAG, "copied " + copied + " React Native assets next to " + bundleDir.getName());
        } catch (Throwable t) {
            Log.w(TAG, "could not copy React Native assets: " + t);
        }
    }
}

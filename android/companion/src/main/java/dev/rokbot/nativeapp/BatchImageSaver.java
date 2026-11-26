package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.Dialog;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Multi-select batch image picker and gallery saver for Android.
 * Saves selected chat/viewer images to Pictures/RokBot via MediaStore (API 29+) or public Pictures dir.
 */
final class BatchImageSaver {
    private static final String TAG = "RokBotBatchSave";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> new Thread(r, "rokbot-batch-save"));

    private BatchImageSaver() {}

    static void showPicker(Activity activity, List<String> rawUris) {
        if (activity == null || activity.isFinishing() || rawUris == null || rawUris.isEmpty()) return;
        final List<String> uris = new ArrayList<>();
        final Set<String> seen = new HashSet<>();
        for (String u : rawUris) {
            if (u != null && !u.isEmpty() && seen.add(u)) uris.add(u);
        }
        if (uris.isEmpty()) return;

        final boolean dark = UiChrome.isDark(activity);
        final int bgColor = dark ? 0xFF1C1C20 : 0xFFFFFFFF;
        final int cardBg = dark ? 0xFF28282E : 0xFFF3F4F6;
        final int fgColor = dark ? 0xFFF4F4F5 : 0xFF18181B;
        final int mutedColor = dark ? 0xFFA1A1AA : 0xFF52525B;
        final int accentColor = 0xFF2563EB;

        final Dialog dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable rootBg = new GradientDrawable();
        rootBg.setColor(bgColor);
        rootBg.setCornerRadius(dp(activity, 18));
        root.setBackground(rootBg);
        int pad = dp(activity, 16);
        root.setPadding(pad, pad, pad, pad);

        // Header
        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(activity);
        title.setText(Localize.t(activity, "批量保存到相册", "Batch save to gallery"));
        title.setTextColor(fgColor);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        header.addView(title, titleLp);

        final TextView countBadge = new TextView(activity);
        countBadge.setTextColor(accentColor);
        countBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        header.addView(countBadge);
        root.addView(header);

        // Toolbar: Select all / Clear
        LinearLayout toolbar = new LinearLayout(activity);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setPadding(0, dp(activity, 10), 0, dp(activity, 10));
        TextView btnAll = pillButton(activity, Localize.t(activity, "全选", "Select all"), cardBg, fgColor);
        TextView btnClear = pillButton(activity, Localize.t(activity, "清空", "Clear"), cardBg, fgColor);
        LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnLp.rightMargin = dp(activity, 8);
        toolbar.addView(btnAll, btnLp);
        toolbar.addView(btnClear);
        root.addView(toolbar);

        // 3-column thumbnail grid inside ScrollView
        final Set<Integer> selected = new HashSet<>();
        for (int i = 0; i < uris.size(); i++) selected.add(i);
        final List<CheckTile> tiles = new ArrayList<>();

        ScrollView scroll = new ScrollView(activity);
        LinearLayout gridRows = new LinearLayout(activity);
        gridRows.setOrientation(LinearLayout.VERTICAL);
        int cols = 3;
        int gap = dp(activity, 8);
        final TextView saveBtn = pillButton(activity, "", accentColor, Color.WHITE);
        saveBtn.setGravity(Gravity.CENTER);
        saveBtn.setPadding(dp(activity, 16), dp(activity, 11), dp(activity, 16), dp(activity, 11));

        final Runnable updateUi = () -> {
            int n = selected.size();
            countBadge.setText(Localize.t(activity, "已选 " + n + " / " + uris.size(), n + " / " + uris.size()));
            saveBtn.setText(Localize.t(activity, "保存到相册 (" + n + ")", "Save to gallery (" + n + ")"));
            saveBtn.setEnabled(n > 0);
            saveBtn.setAlpha(n > 0 ? 1f : 0.45f);
            for (int i = 0; i < tiles.size(); i++) tiles.get(i).setChecked(selected.contains(i));
        };

        for (int rowStart = 0; rowStart < uris.size(); rowStart += cols) {
            LinearLayout row = new LinearLayout(activity);
            row.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rowLp.bottomMargin = gap;
            for (int c = 0; c < cols; c++) {
                int idx = rowStart + c;
                LinearLayout.LayoutParams cellLp = new LinearLayout.LayoutParams(0, dp(activity, 96), 1f);
                if (c < cols - 1) cellLp.rightMargin = gap;
                if (idx < uris.size()) {
                    CheckTile tile = new CheckTile(activity, cardBg, accentColor);
                    final int itemIndex = idx;
                    tile.setOnClickListener(v -> {
                        if (selected.contains(itemIndex)) selected.remove(itemIndex);
                        else selected.add(itemIndex);
                        updateUi.run();
                    });
                    tiles.add(tile);
                    row.addView(tile, cellLp);
                    loadThumbAsync(activity.getApplicationContext(), uris.get(idx), tile.image);
                } else {
                    row.addView(new View(activity), cellLp);
                }
            }
            gridRows.addView(row, rowLp);
        }
        scroll.addView(gridRows);
        LinearLayout.LayoutParams scrollLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        root.addView(scroll, scrollLp);

        // Footer
        LinearLayout footer = new LinearLayout(activity);
        footer.setOrientation(LinearLayout.HORIZONTAL);
        footer.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        footer.setPadding(0, dp(activity, 12), 0, 0);
        TextView cancelBtn = pillButton(activity, Localize.t(activity, "取消", "Cancel"), cardBg, mutedColor);
        cancelBtn.setOnClickListener(v -> dialog.dismiss());
        LinearLayout.LayoutParams cancelLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cancelLp.rightMargin = dp(activity, 10);
        footer.addView(cancelBtn, cancelLp);
        footer.addView(saveBtn);
        root.addView(footer);

        btnAll.setOnClickListener(v -> {
            for (int i = 0; i < uris.size(); i++) selected.add(i);
            updateUi.run();
        });
        btnClear.setOnClickListener(v -> {
            selected.clear();
            updateUi.run();
        });
        saveBtn.setOnClickListener(v -> {
            List<String> chosen = new ArrayList<>();
            for (int i = 0; i < uris.size(); i++) {
                if (selected.contains(i)) chosen.add(uris.get(i));
            }
            if (chosen.isEmpty()) return;
            dialog.dismiss();
            saveAllToGallery(activity, chosen);
        });

        updateUi.run();

        int maxW = Math.min(activity.getResources().getDisplayMetrics().widthPixels - dp(activity, 32), dp(activity, 420));
        int maxH = Math.min((int) (activity.getResources().getDisplayMetrics().heightPixels * 0.78f), dp(activity, 560));
        dialog.setContentView(root, new ViewGroup.LayoutParams(maxW, maxH));
        if (dialog.getWindow() != null) {
            dialog.getWindow().setBackgroundDrawableResource(android.R.color.transparent);
            dialog.getWindow().setLayout(maxW, maxH);
        }
        dialog.show();
    }

    private static void saveAllToGallery(Activity activity, List<String> uris) {
        final Context app = activity.getApplicationContext();
        Toast.makeText(app, Localize.t(app, "正在保存 " + uris.size() + " 张图片…", "Saving " + uris.size() + " images…"), Toast.LENGTH_SHORT).show();
        IO.execute(() -> {
            int saved = 0;
            String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
            for (int i = 0; i < uris.size(); i++) {
                try {
                    if (saveOneToGallery(app, uris.get(i), "RokBot_" + stamp + "_" + (i + 1))) {
                        saved++;
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "saveOne failed: " + t);
                }
            }
            final int okCount = saved;
            final int total = uris.size();
            MAIN.post(() -> {
                String msg = okCount == total
                        ? Localize.t(app, "已保存 " + okCount + " 张图片到相册", "Saved " + okCount + " images to gallery")
                        : Localize.t(app, "已保存 " + okCount + " / " + total + " 张图片", "Saved " + okCount + " of " + total + " images");
                Toast.makeText(app, msg, Toast.LENGTH_SHORT).show();
            });
        });
    }

    static boolean saveOneToGallery(Context app, String uri, String baseName) throws Exception {
        File sourceFile = resolveToTempOrLocalFile(app, uri);
        if (sourceFile == null || !sourceFile.isFile() || sourceFile.length() == 0) return false;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(sourceFile.getAbsolutePath(), opts);
        String mime = opts.outMimeType != null ? opts.outMimeType : "image/png";
        String ext = mimeToExt(mime);
        String displayName = baseName + ext;

        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = app.getContentResolver();
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.Images.Media.DISPLAY_NAME, displayName);
            cv.put(MediaStore.Images.Media.MIME_TYPE, mime);
            cv.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/RokBot");
            cv.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri dest = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
            if (dest == null) return false;
            try (InputStream in = new BufferedInputStream(new FileInputStream(sourceFile));
                 OutputStream out = cr.openOutputStream(dest)) {
                if (out == null) return false;
                copyStream(in, out);
            }
            cv.clear();
            cv.put(MediaStore.Images.Media.IS_PENDING, 0);
            cr.update(dest, cv, null, null);
            return true;
        } else {
            File pictures = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "RokBot");
            if (!pictures.isDirectory() && !pictures.mkdirs()) return false;
            File dest = new File(pictures, displayName);
            try (InputStream in = new BufferedInputStream(new FileInputStream(sourceFile));
                 OutputStream out = new FileOutputStream(dest)) {
                copyStream(in, out);
            }
            MediaScannerConnection.scanFile(app, new String[] { dest.getAbsolutePath() }, new String[] { mime }, null);
            return true;
        }
    }

    private static File resolveToTempOrLocalFile(Context app, String uri) throws Exception {
        String key = ImageViewerMath.sourceKey(uri);
        ZoomImageView.Source prepared = ImageViewerTakeover.prepare(app, uri, key);
        if (prepared != null && prepared.path != null) {
            return new File(prepared.path);
        }
        if (uri.startsWith("http://") || uri.startsWith("https://")) {
            File dir = new File(app.getCacheDir(), "rokbot-batch-save");
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            File out = new File(dir, key + ".img");
            HttpURLConnection conn = (HttpURLConnection) new URL(uri).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                copyStream(in, os);
            } finally {
                conn.disconnect();
            }
            return out;
        }
        return null;
    }

    private static void loadThumbAsync(Context app, String uri, ImageView target) {
        IO.execute(() -> {
            try {
                File f = resolveToTempOrLocalFile(app, uri);
                if (f == null || !f.isFile()) return;
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(f.getAbsolutePath(), bounds);
                int sample = 1;
                while (bounds.outWidth / (sample * 2) >= 220 && bounds.outHeight / (sample * 2) >= 220) sample *= 2;
                BitmapFactory.Options dec = new BitmapFactory.Options();
                dec.inSampleSize = sample;
                Bitmap bmp = BitmapFactory.decodeFile(f.getAbsolutePath(), dec);
                if (bmp != null) MAIN.post(() -> target.setImageBitmap(bmp));
            } catch (Throwable ignored) {}
        });
    }

    private static void copyStream(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    }

    private static String mimeToExt(String mime) {
        if ("image/jpeg".equals(mime)) return ".jpg";
        if ("image/webp".equals(mime)) return ".webp";
        if ("image/gif".equals(mime)) return ".gif";
        return ".png";
    }

    private static TextView pillButton(Context ctx, String label, int bgColor, int textColor) {
        TextView tv = new TextView(ctx);
        tv.setText(label);
        tv.setTextColor(textColor);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(bgColor);
        bg.setCornerRadius(dp(ctx, 10));
        tv.setBackground(bg);
        tv.setPadding(dp(ctx, 12), dp(ctx, 7), dp(ctx, 12), dp(ctx, 7));
        return tv;
    }

    private static int dp(Context ctx, float v) {
        return Math.round(v * ctx.getResources().getDisplayMetrics().density);
    }

    private static final class CheckTile extends FrameLayout {
        final ImageView image;
        final CheckBadge badge;
        final GradientDrawable border;
        final int cardBg;
        final int accent;

        CheckTile(Context ctx, int cardBg, int accent) {
            super(ctx);
            this.cardBg = cardBg;
            this.accent = accent;
            border = new GradientDrawable();
            border.setColor(cardBg);
            border.setCornerRadius(dp(ctx, 10));
            setBackground(border);
            setClipToOutline(true);

            image = new ImageView(ctx);
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
            addView(image, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

            badge = new CheckBadge(ctx, accent);
            LayoutParams blp = new LayoutParams(dp(ctx, 22), dp(ctx, 22), Gravity.END | Gravity.TOP);
            blp.topMargin = dp(ctx, 6);
            blp.rightMargin = dp(ctx, 6);
            addView(badge, blp);
        }

        void setChecked(boolean checked) {
            badge.setChecked(checked);
            border.setStroke(checked ? dp(getContext(), 2.5f) : 0, accent);
            invalidate();
        }
    }

    private static final class CheckBadge extends View {
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int accent;
        private boolean checked;

        CheckBadge(Context ctx, int accent) {
            super(ctx);
            this.accent = accent;
            stroke.setColor(Color.WHITE);
            stroke.setStyle(Paint.Style.STROKE);
            stroke.setStrokeCap(Paint.Cap.ROUND);
            stroke.setStrokeJoin(Paint.Join.ROUND);
            stroke.setStrokeWidth(2f * ctx.getResources().getDisplayMetrics().density);
        }

        void setChecked(boolean value) {
            this.checked = value;
            invalidate();
        }

        @Override protected void onDraw(Canvas c) {
            float r = Math.min(getWidth(), getHeight()) / 2f;
            float cx = getWidth() / 2f, cy = getHeight() / 2f;
            fill.setColor(checked ? accent : 0x80000000);
            c.drawCircle(cx, cy, r - 1f, fill);
            if (!checked) {
                c.drawCircle(cx, cy, r - stroke.getStrokeWidth(), stroke);
            } else {
                c.drawLine(cx - r * 0.36f, cy + r * 0.02f, cx - r * 0.08f, cy + r * 0.32f, stroke);
                c.drawLine(cx - r * 0.08f, cy + r * 0.32f, cx + r * 0.4f, cy - r * 0.26f, stroke);
            }
        }
    }
}

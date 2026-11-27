package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

public class LibraryActivity extends Activity {
    public static final String EXTRA_AGENT_ID = "agentId";
    public static final String EXTRA_AGENT_NAME = "agentName";
    private static final int REQ_PICK_LIB_FILE = 601;
    private static final int REQ_SAVE_LIB_FILE = 602;

    private String mAgentId;
    private String mAgentName;
    private LinearLayout mListContainer;
    private TextView mStatus;
    private CanvasLibrarySection mCanvases;
    private byte[] mPendingSaveBytes;
    private String mPendingSaveName;
    private final Handler mMain = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        mAgentId = getIntent().getStringExtra(EXTRA_AGENT_ID);
        if (mAgentId == null || mAgentId.isEmpty()) mAgentId = "agent-default";
        mAgentName = getIntent().getStringExtra(EXTRA_AGENT_NAME);
        if (mAgentName == null || mAgentName.isEmpty()) mAgentName = mAgentId;

        buildUi();
        reload();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Back from a canvas or its share sheet: visibility or the list may have changed.
        if (mCanvases != null) mCanvases.reload();
    }

    private void buildUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(p.bgPaper);
        root.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 10), UiChrome.dp(this, 16), UiChrome.dp(this, 16));

        TextView addText = makeSmallPill(Localize.t(this, "+文本", "+Text"), false, p, v -> showAddTextDialog());
        addText.setContentDescription("library_add_text_button");

        TextView addFile = makeSmallPill(Localize.t(this, "+文件", "+File"), true, p, v -> {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            startActivityForResult(i, REQ_PICK_LIB_FILE);
        });
        addFile.setContentDescription("library_add_file_button");

        root.addView(UiChrome.makeHeaderBar(this,
                Localize.t(this, "资料库: ", "Library: ") + mAgentName,
                p, v -> finish(), addText, addFile));

        // The Bot's canvases come first (official Library: 页面, then files), then its files.
        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        mCanvases = new CanvasLibrarySection(this, mAgentId);
        content.addView(mCanvases.view);

        TextView filesHeading = new TextView(this);
        filesHeading.setText(Localize.t(this, "文件", "Files"));
        filesHeading.setTextColor(p.textPrimary);
        filesHeading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        filesHeading.setTypeface(Typeface.DEFAULT_BOLD);
        filesHeading.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 14), 0, UiChrome.dp(this, 2));
        content.addView(filesHeading);

        mStatus = new TextView(this);
        mStatus.setText(Localize.t(this, "正在加载资料库…", "Loading library…"));
        mStatus.setTextColor(p.textSecondary);
        mStatus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mStatus.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 10));
        content.addView(mStatus);

        mListContainer = new LinearLayout(this);
        mListContainer.setOrientation(LinearLayout.VERTICAL);
        content.addView(mListContainer);
        scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        UiChrome.applyRootInsets(this, root);
    }

    private TextView makeSmallPill(String label, boolean primary, UiChrome.Palette p, android.view.View.OnClickListener listener) {
        TextView tv = UiChrome.makePillButton(this, label, primary, p, listener);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tv.setPadding(UiChrome.dp(this, 12), UiChrome.dp(this, 7), UiChrome.dp(this, 12), UiChrome.dp(this, 7));
        return tv;
    }

    private void reload() {
        mStatus.setText(Localize.t(this, "正在加载…", "Loading…"));
        new Thread(() -> {
            try {
                JSONObject res = HostApiClient.listLibraryFiles(this, mAgentId);
                JSONArray files = res.optJSONArray("files");
                long totalBytes = res.optLong("totalBytes", 0);
                mMain.post(() -> {
                    mListContainer.removeAllViews();
                    if (files == null || files.length() == 0) {
                        mStatus.setText(Localize.t(this, "资料库为空 (0 B)", "No files in library (0 B)"));
                        return;
                    }
                    mStatus.setText(Localize.t(this,
                            files.length() + " 个文件 · " + formatBytes(totalBytes),
                            files.length() + " file(s) • " + formatBytes(totalBytes)));
                    for (int i = 0; i < files.length(); i++) {
                        JSONObject f = files.optJSONObject(i);
                        if (f != null) addFileRow(f);
                    }
                });
            } catch (Throwable t) {
                mMain.post(() -> mStatus.setText(Localize.t(this, "错误: ", "Error: ") + t.getMessage()));
            }
        }).start();
    }

    private void addFileRow(JSONObject f) {
        UiChrome.Palette p = UiChrome.palette(this);
        String name = UiChrome.jsonStr(f, "name", "file");
        long size = f.optLong("sizeBytes", f.optLong("size", 0));
        String ctype = UiChrome.jsonStr(f, "contentType", "application/octet-stream");

        LinearLayout row = UiChrome.makeCard(this, p);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.bottomMargin = UiChrome.dp(this, 10);
        row.setLayoutParams(rlp);

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView nameTv = new TextView(this);
        nameTv.setText(name);
        nameTv.setTextColor(p.textPrimary);
        nameTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        nameTv.setTypeface(Typeface.DEFAULT_BOLD);
        nameTv.setSingleLine(true);
        nameTv.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        info.addView(nameTv);

        TextView metaTv = new TextView(this);
        metaTv.setText(formatBytes(size) + " • " + ctype);
        metaTv.setTextColor(p.textSecondary);
        metaTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        metaTv.setPadding(0, UiChrome.dp(this, 2), 0, 0);
        info.addView(metaTv);

        row.addView(info);

        TextView openBtn = makeSmallPill(Localize.t(this, "打开", "Open"), false, p, v -> downloadAndPreview(name, ctype));
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        olp.leftMargin = UiChrome.dp(this, 8);
        openBtn.setLayoutParams(olp);
        row.addView(openBtn);

        TextView delBtn = makeSmallPill(Localize.t(this, "删除", "Del"), false, p, v -> deleteLibraryFile(name));
        delBtn.setTextColor(p.danger);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dlp.leftMargin = UiChrome.dp(this, 6);
        delBtn.setLayoutParams(dlp);
        row.addView(delBtn);

        mListContainer.addView(row);
    }

    private void downloadAndPreview(String name, String contentType) {
        mStatus.setText(Localize.t(this, "正在下载 ", "Downloading ") + name + "…");
        new Thread(() -> {
            try {
                byte[] bytes = HostApiClient.downloadLibraryFile(this, mAgentId, name);
                mMain.post(() -> {
                    mStatus.setText(Localize.t(this, "已加载 ", "Loaded ") + name);
                    showPreviewDialog(name, contentType, bytes);
                });
            } catch (Throwable t) {
                mMain.post(() -> Toast.makeText(this,
                        Localize.t(this, "下载失败: ", "Download failed: ") + t.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void showPreviewDialog(String name, String contentType, byte[] bytes) {
        AlertDialog.Builder b = new AlertDialog.Builder(this).setTitle(name);
        String lower = name.toLowerCase(Locale.US);
        if (contentType.startsWith("image/") || lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) {
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bmp != null) {
                ImageView iv = new ImageView(this);
                iv.setImageBitmap(bmp);
                iv.setAdjustViewBounds(true);
                b.setView(iv);
            } else {
                b.setMessage(Localize.t(this, "图片文件 (", "Binary image (") + formatBytes(bytes.length) + ")");
            }
        } else if (contentType.startsWith("text/") || lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".json") || lower.endsWith(".csv")) {
            ScrollView sv = new ScrollView(this);
            TextView tv = new TextView(this);
            tv.setText(new String(bytes, StandardCharsets.UTF_8));
            tv.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 12), UiChrome.dp(this, 16), UiChrome.dp(this, 12));
            sv.addView(tv);
            b.setView(sv);
        } else {
            b.setMessage(Localize.t(this, "文件大小: ", "Binary file: ") + formatBytes(bytes.length) + " (" + contentType + ")");
        }
        b.setPositiveButton(Localize.t(this, "保存到设备", "Save Copy"), (d, w) -> {
            mPendingSaveBytes = bytes;
            mPendingSaveName = name;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(contentType);
            intent.putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(intent, REQ_SAVE_LIB_FILE);
        });
        b.setNegativeButton(Localize.t(this, "关闭", "Close"), null);
        b.show();
    }

    private void deleteLibraryFile(String name) {
        new Thread(() -> {
            try {
                HostApiClient.deleteLibraryFile(this, mAgentId, name);
                mMain.post(() -> {
                    Toast.makeText(this, Localize.t(this, "已删除 ", "Deleted ") + name, Toast.LENGTH_SHORT).show();
                    reload();
                });
            } catch (Throwable t) {
                mMain.post(() -> Toast.makeText(this, "Delete failed: " + t.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void showAddTextDialog() {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(UiChrome.dp(this, 20), UiChrome.dp(this, 10), UiChrome.dp(this, 20), UiChrome.dp(this, 10));

        EditText nameEt = new EditText(this);
        nameEt.setHint("notes.txt");
        form.addView(nameEt);

        EditText bodyEt = new EditText(this);
        bodyEt.setHint(Localize.t(this, "文本内容...", "Text content..."));
        bodyEt.setMinLines(4);
        form.addView(bodyEt);

        new AlertDialog.Builder(this)
            .setTitle(Localize.t(this, "添加文本笔记", "Add Text Note"))
            .setView(form)
            .setPositiveButton(Localize.t(this, "上传", "Upload"), (d, w) -> {
                String fname = nameEt.getText().toString().trim();
                if (fname.isEmpty()) fname = "note-" + System.currentTimeMillis() + ".txt";
                byte[] bytes = bodyEt.getText().toString().getBytes(StandardCharsets.UTF_8);
                uploadBytes(fname, "text/plain", bytes);
            })
            .setNegativeButton(Localize.t(this, "取消", "Cancel"), null)
            .show();
    }

    private void uploadBytes(String fileName, String contentType, byte[] data) {
        mStatus.setText(Localize.t(this, "正在上传 ", "Uploading ") + fileName + "…");
        new Thread(() -> {
            try {
                HostApiClient.uploadLibraryFile(this, mAgentId, fileName, contentType, data);
                mMain.post(() -> {
                    Toast.makeText(this, Localize.t(this, "已上传 ", "Uploaded ") + fileName, Toast.LENGTH_SHORT).show();
                    reload();
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    mStatus.setText(Localize.t(this, "上传失败: ", "Upload failed: ") + t.getMessage());
                    Toast.makeText(this, "Upload error: " + t.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        if (requestCode == REQ_PICK_LIB_FILE) {
            new Thread(() -> {
                try (InputStream is = getContentResolver().openInputStream(uri)) {
                    if (is == null) return;
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    long total = 0;
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        total += n;
                        if (total > HostApiClient.LIBRARY_FILE_LIMIT) {
                            throw new HostApiClient.ApiException(413, Localize.t(this,
                                    "文件大小超过 20 MB 上限。",
                                    "File exceeds the 20 MB limit."));
                        }
                        baos.write(buf, 0, n);
                    }
                    String name = queryFilename(uri);
                    String mime = getContentResolver().getType(uri);
                    if (mime == null) mime = "application/octet-stream";
                    uploadBytes(name, mime, baos.toByteArray());
                } catch (Throwable t) {
                    mMain.post(() -> Toast.makeText(this, "Read failed: " + t.getMessage(), Toast.LENGTH_LONG).show());
                }
            }).start();
        } else if (requestCode == REQ_SAVE_LIB_FILE && mPendingSaveBytes != null) {
            byte[] outBytes = mPendingSaveBytes;
            mPendingSaveBytes = null;
            new Thread(() -> {
                try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                    if (os != null) os.write(outBytes);
                    mMain.post(() -> Toast.makeText(this, Localize.t(this, "已保存 ", "Saved ") + mPendingSaveName, Toast.LENGTH_SHORT).show());
                } catch (Throwable t) {
                    mMain.post(() -> Toast.makeText(this, "Save failed: " + t.getMessage(), Toast.LENGTH_LONG).show());
                }
            }).start();
        }
    }

    private String queryFilename(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String n = c.getString(idx);
                    if (n != null && !n.isEmpty()) return n;
                }
            }
        } catch (Throwable ignored) {}
        String last = uri.getLastPathSegment();
        return last != null ? last : "file.bin";
    }

    private String formatBytes(long b) {
        if (b < 1024) return b + " B";
        if (b < 1024 * 1024) return String.format(Locale.US, "%.1f KB", b / 1024.0);
        return String.format(Locale.US, "%.2f MB", b / (1024.0 * 1024.0));
    }
}

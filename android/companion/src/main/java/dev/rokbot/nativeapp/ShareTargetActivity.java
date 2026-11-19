package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.MimeTypeMap;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Android System Share Sheet receiver (ACTION_SEND / ACTION_SEND_MULTIPLE)
 * allowing users to share text, images, and files directly from other apps to a chosen Bot.
 */
public class ShareTargetActivity extends Activity {
    private String mSharedText = "";
    private final List<Uri> mSharedUris = new ArrayList<>();
    private final List<JSONObject> mBots = new ArrayList<>();
    private String mSelectedBotId = "";
    private String mSelectedBotName = "";

    private LinearLayout mBotsBox;
    private EditText mPromptInput;
    private TextView mFilesSummary;
    private TextView mSendBtn;
    private final Handler mMain = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        Storage.init(this);

        if (!Storage.isPaired(this)) {
            Toast.makeText(this, Localize.t(this, "请先连接 Host 后再分享内容", "Connect to a Host first"), Toast.LENGTH_LONG).show();
            startActivity(new Intent(this, PairingActivity.class));
            finish();
            return;
        }

        extractSharedPayload(getIntent());
        buildUi();
        loadBots();
    }

    @SuppressWarnings("deprecation")
    private void extractSharedPayload(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String txt = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (txt == null || txt.isEmpty()) {
            txt = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        }
        if (txt != null) mSharedText = txt;

        Set<Uri> uniqueUris = new LinkedHashSet<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uniqueUris.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null) {
                for (Uri u : uris) {
                    if (u != null) uniqueUris.add(u);
                }
            }
        }
        ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                ClipData.Item item = clip.getItemAt(i);
                if (item == null) continue;
                if (item.getUri() != null) {
                    uniqueUris.add(item.getUri());
                } else if (mSharedText.isEmpty() && item.getText() != null) {
                    mSharedText = item.getText().toString();
                }
            }
        }
        mSharedUris.addAll(uniqueUris);
    }

    private void buildUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(p.bgPaper);
        root.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 10), UiChrome.dp(this, 16), UiChrome.dp(this, 16));

        root.addView(UiChrome.makeHeaderBar(this, Localize.t(this, "发送给 RokBot", "Share to RokBot"), p, v -> finish()));

        mFilesSummary = new TextView(this);
        mFilesSummary.setText(mSharedUris.isEmpty()
                ? Localize.t(this, "分享文本消息", "Sharing text message")
                : Localize.t(this, "已附带 " + mSharedUris.size() + " 个文件", mSharedUris.size() + " file(s) attached"));
        mFilesSummary.setTextColor(p.textSecondary);
        mFilesSummary.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mFilesSummary.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 4), UiChrome.dp(this, 8));
        root.addView(mFilesSummary);

        mPromptInput = new EditText(this);
        UiChrome.styleEditText(mPromptInput, p, this);
        mPromptInput.setText(mSharedText);
        mPromptInput.setHint(Localize.t(this, "附言或指令 (可选)…", "Add a message (optional)…"));
        mPromptInput.setMaxLines(4);
        mPromptInput.setContentDescription("share_prompt_input");
        root.addView(mPromptInput);

        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "选择目标 Bot", "Choose Bot"), p));

        ScrollView scroll = new ScrollView(this);
        mBotsBox = new LinearLayout(this);
        mBotsBox.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(mBotsBox);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        mSendBtn = UiChrome.makePillButton(this, Localize.t(this, "发送", "Send to Bot"), true, p, v -> sendToSelectedBot());
        mSendBtn.setContentDescription("share_send_button");
        mSendBtn.setEnabled(false);
        root.addView(mSendBtn);

        setContentView(root);
        UiChrome.applyRootInsets(this, root);
    }

    private void loadBots() {
        new Thread(() -> {
            try {
                JSONArray list = HostApiClient.listAgents(this);
                mBots.clear();
                for (int i = 0; i < list.length(); i++) {
                    JSONObject item = list.optJSONObject(i);
                    if (item != null) mBots.add(item);
                }
                if (!mBots.isEmpty() && mSelectedBotId.isEmpty()) {
                    mSelectedBotId = mBots.get(0).optString("id", "");
                    mSelectedBotName = mBots.get(0).optString("name", mSelectedBotId);
                }
                mMain.post(this::renderBots);
            } catch (Throwable t) {
                mMain.post(() -> Toast.makeText(this, "Error: " + t.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private void renderBots() {
        UiChrome.Palette p = UiChrome.palette(this);
        mBotsBox.removeAllViews();
        for (JSONObject bot : mBots) {
            String id = UiChrome.jsonStr(bot, "id");
            String name = UiChrome.jsonStr(bot, "name", id);
            String avatar = UiChrome.jsonStr(bot, "avatarDataUrl");
            boolean selected = id.equals(mSelectedBotId);

            LinearLayout row = UiChrome.makeCard(this, p);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            if (selected) {
                row.setBackground(UiChrome.roundRect(p.bgCard, UiChrome.dp(this, 18), p.blueAccent, UiChrome.dp(this, 2)));
            }
            LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rlp.bottomMargin = UiChrome.dp(this, 8);
            row.setLayoutParams(rlp);

            row.addView(UiChrome.makeAvatarView(this, name, avatar, 38, p));
            TextView tv = new TextView(this);
            tv.setText((selected ? "✓ " : "") + name);
            tv.setTextColor(p.textPrimary);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            tv.setTypeface(selected ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            tv.setPadding(UiChrome.dp(this, 12), 0, 0, 0);
            row.addView(tv);

            row.setContentDescription("share_bot_row_" + id);
            row.setOnClickListener(v -> {
                mSelectedBotId = id;
                mSelectedBotName = name;
                renderBots();
            });
            mBotsBox.addView(row);
        }
        mSendBtn.setEnabled(!mSelectedBotId.isEmpty());
    }

    private void sendToSelectedBot() {
        if (mSelectedBotId.isEmpty()) return;
        String prompt = mPromptInput.getText().toString().trim();
        if (prompt.isEmpty() && mSharedUris.isEmpty()) {
            Toast.makeText(this,
                    Localize.t(this, "请先输入内容或选择附件。", "Nothing to send yet."),
                    Toast.LENGTH_SHORT).show();
            return;
        }
        mSendBtn.setEnabled(false);
        mSendBtn.setText(Localize.t(this, "正在发送…", "Sending…"));

        new Thread(() -> {
            try {
                List<String> paths = new ArrayList<>();
                List<String> names = new ArrayList<>();
                for (Uri uri : mSharedUris) {
                    String fname = resolveFileName(uri);
                    long size = resolveFileSize(uri);
                    if (size >= 0) {
                        try (InputStream is = getContentResolver().openInputStream(uri)) {
                            if (is != null) {
                                String committed = HostApiClient.uploadAttachmentChunked(this, mSelectedBotId, fname, is, size, null);
                                paths.add(committed);
                                names.add(fname);
                            }
                        }
                    } else {
                        File tmp = File.createTempFile("share_upload_", ".bin", getCacheDir());
                        try {
                            long total = 0L;
                            long maxBytes = 128L * 1024L * 1024L;
                            try (InputStream is = getContentResolver().openInputStream(uri);
                                 FileOutputStream fos = new FileOutputStream(tmp)) {
                                if (is == null) throw new IllegalStateException("Cannot open shared URI");
                                byte[] buf = new byte[16384];
                                int n;
                                while ((n = is.read(buf)) != -1) {
                                    total += n;
                                    if (total > maxBytes) {
                                        throw new IllegalStateException("Shared file exceeds 128 MB limit");
                                    }
                                    fos.write(buf, 0, n);
                                }
                            }
                            try (FileInputStream fis = new FileInputStream(tmp)) {
                                String committed = HostApiClient.uploadAttachmentChunked(this, mSelectedBotId, fname, fis, tmp.length(), null);
                                paths.add(committed);
                                names.add(fname);
                            }
                        } finally {
                            tmp.delete();
                        }
                    }
                }
                HostApiClient.sendPrompt(this, mSelectedBotId, null, prompt, paths, names);
                mMain.post(() -> {
                    Toast.makeText(this, Localize.t(this, "已发送", "Sent"), Toast.LENGTH_SHORT).show();
                    RokBotBootstrap.openAgentFromDeepLink(this, Uri.parse("rokbot-local://agent/" + mSelectedBotId));
                    finish();
                });
            } catch (Throwable t) {
                mMain.post(() -> {
                    mSendBtn.setEnabled(true);
                    mSendBtn.setText(Localize.t(this, "发送", "Send to Bot"));
                    Toast.makeText(this, "Error: " + t.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private String resolveFileName(Uri uri) {
        String name = null;
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = c.getString(idx);
            }
        } catch (Throwable ignored) {}
        if (name == null || name.trim().isEmpty()) {
            String seg = uri.getLastPathSegment();
            if (seg != null) {
                int slash = seg.lastIndexOf('/');
                if (slash >= 0) seg = seg.substring(slash + 1);
                name = seg.trim();
            }
        }
        if (name == null || name.isEmpty()) {
            name = "shared-file";
        }
        name = name.replace('\\', '_').replace('/', '_');
        if (!name.contains(".")) {
            try {
                String mime = getContentResolver().getType(uri);
                if (mime != null) {
                    String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
                    if (ext != null && !ext.isEmpty()) name = name + "." + ext;
                }
            } catch (Throwable ignored) {}
        }
        return name;
    }

    private long resolveFileSize(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.SIZE);
                if (idx >= 0 && !c.isNull(idx)) {
                    long sz = c.getLong(idx);
                    if (sz >= 0) return sz;
                }
            }
        } catch (Throwable ignored) {}
        if ("file".equalsIgnoreCase(uri.getScheme()) && uri.getPath() != null) {
            try {
                File f = new File(uri.getPath());
                if (f.exists() && f.isFile()) return f.length();
            } catch (Throwable ignored) {}
        }
        try (AssetFileDescriptor afd = getContentResolver().openAssetFileDescriptor(uri, "r")) {
            if (afd != null && afd.getLength() >= 0) {
                return afd.getLength();
            }
        } catch (Throwable ignored) {}
        return -1L;
    }
}

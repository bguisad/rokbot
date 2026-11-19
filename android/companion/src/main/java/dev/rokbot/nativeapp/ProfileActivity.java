package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;

public class ProfileActivity extends Activity {
    private static final int REQ_PICK_AVATAR = 701;
    private ImageView mAvatar;
    private EditText mNameInput;
    private TextView mStatus;
    private EditText mUpdateUrlInput;
    private TextView mUpdateStatus;
    private TextView mCheckUpdateBtn;
    private TextView mInstallUpdateBtn;
    private File mStagedUpdateApk = null;
    private String mAvatarDataUrl = null;
    private final Handler mMain = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        buildUi();
        load();
    }

    private void buildUi() {
        UiChrome.Palette p = UiChrome.palette(this);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(p.bgPaper);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(UiChrome.dp(this, 18), UiChrome.dp(this, 12), UiChrome.dp(this, 18), UiChrome.dp(this, 24));
        scroll.addView(root);

        root.addView(UiChrome.makeHeaderBar(this, Localize.t(this, "个人资料与偏好", "Profile & Preferences"), p, v -> finish()));

        LinearLayout card = UiChrome.makeCard(this, p);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.topMargin = UiChrome.dp(this, 10);
        card.setLayoutParams(clp);

        int avPx = UiChrome.dp(this, 84);
        mAvatar = new ImageView(this);
        LinearLayout.LayoutParams avLp = new LinearLayout.LayoutParams(avPx, avPx);
        avLp.bottomMargin = UiChrome.dp(this, 10);
        mAvatar.setLayoutParams(avLp);
        mAvatar.setImageBitmap(UiChrome.decodeCircleAvatar("U", mAvatarDataUrl, avPx));
        mAvatar.setOnClickListener(v -> {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("image/*");
            startActivityForResult(i, REQ_PICK_AVATAR);
        });
        card.addView(mAvatar);

        mStatus = new TextView(this);
        mStatus.setText(Localize.t(this, "点击头像更换图片", "Tap avatar to change"));
        mStatus.setTextColor(p.textSecondary);
        mStatus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mStatus.setPadding(0, 0, 0, UiChrome.dp(this, 12));
        card.addView(mStatus);

        mNameInput = new EditText(this);
        UiChrome.styleEditText(mNameInput, p, this);
        mNameInput.setHint(Localize.t(this, "显示名称", "Display Name"));
        mNameInput.setSingleLine(true);
        mNameInput.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        card.addView(mNameInput);

        root.addView(card);

        addSpacing(root, 14);
        root.addView(UiChrome.makePillButton(this, Localize.t(this, "保存资料", "Save Profile"), true, p, v -> saveProfile()));

        addSpacing(root, 8);
        root.addView(UiChrome.makePillButton(this, Localize.t(this, "移除头像", "Remove Photo"), false, p, v -> {
            mAvatarDataUrl = null;
            mAvatar.setImageBitmap(UiChrome.decodeCircleAvatar(
                    mNameInput.getText().toString().trim(), null, UiChrome.dp(this, 84)));
            mStatus.setText(Localize.t(this, "头像已移除（点击保存生效）", "Photo removed (tap Save Profile to apply)"));
        }));

        // Interface Preferences card (Language + Theme)
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "外观与语言", "Appearance & Language"), p));
        LinearLayout prefCard = UiChrome.makeCard(this, p);
        LinearLayout prefRow = new LinearLayout(this);
        prefRow.setOrientation(LinearLayout.HORIZONTAL);

        String langCur = Localize.getPreferredLanguage(this);
        String langLabel = Localize.t(this, "语言: ", "Language: ")
                + (Localize.LANG_ZH.equals(langCur) ? "中文"
                   : (Localize.LANG_EN.equals(langCur) ? "English" : Localize.t(this, "跟随系统", "Auto")));
        TextView langBtn = UiChrome.makePillButton(this, langLabel, false, p, v -> {
            String cur = Localize.getPreferredLanguage(this);
            String next = Localize.LANG_AUTO.equals(cur) ? Localize.LANG_ZH
                    : (Localize.LANG_ZH.equals(cur) ? Localize.LANG_EN : Localize.LANG_AUTO);
            Localize.setPreferredLanguage(this, next);
            buildUi();
        });
        langBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        prefRow.addView(langBtn);

        View gap = new View(this);
        gap.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(this, 8), 1));
        prefRow.addView(gap);

        String themeCur = Storage.getThemePreference(this);
        String themeLabel = Localize.t(this, "主题: ", "Theme: ")
                + ("dark".equals(themeCur) ? Localize.t(this, "深色", "Dark")
                   : ("light".equals(themeCur) ? Localize.t(this, "浅色", "Light") : Localize.t(this, "自动", "Auto")));
        TextView themeBtn = UiChrome.makePillButton(this, themeLabel, false, p, v -> {
            String cur = Storage.getThemePreference(this);
            String next = "auto".equals(cur) ? "light" : ("light".equals(cur) ? "dark" : "auto");
            Storage.setThemePreference(this, next);
            buildUi();
        });
        themeBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        prefRow.addView(themeBtn);
        prefCard.addView(prefRow);
        root.addView(prefCard);

        // In-App Incremental Update card
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "内部增量更新", "In-App Incremental Update"), p));
        LinearLayout updateCard = UiChrome.makeCard(this, p);
        TextView verLabel = new TextView(this);
        verLabel.setText(Localize.t(this, "当前版本: ", "Current version: ")
                + UpdateManager.getCurrentVersionLabel(this) + " (" + getPackageName() + ")");
        verLabel.setTextColor(p.textSecondary);
        verLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        verLabel.setPadding(0, 0, 0, UiChrome.dp(this, 8));
        updateCard.addView(verLabel);

        mUpdateUrlInput = new EditText(this);
        UiChrome.styleEditText(mUpdateUrlInput, p, this);
        mUpdateUrlInput.setHint(Localize.t(this, "更新清单地址 (https://.../update.json)", "Update manifest URL (https://.../update.json)"));
        mUpdateUrlInput.setContentDescription("update_feed_url_input");
        mUpdateUrlInput.setSingleLine(true);
        mUpdateUrlInput.setText(UpdateManager.resolveDefaultFeedUrl(this));
        mUpdateUrlInput.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        updateCard.addView(mUpdateUrlInput);

        mUpdateStatus = new TextView(this);
        mUpdateStatus.setText(Localize.t(this, "支持 RBDELTA1 增量补丁（仅下载差异部分并校验签名）",
                "Supports RBDELTA1 incremental patches with SHA-256 & signature verification"));
        mUpdateStatus.setTextColor(p.textSecondary);
        mUpdateStatus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mUpdateStatus.setPadding(0, UiChrome.dp(this, 8), 0, UiChrome.dp(this, 10));
        updateCard.addView(mUpdateStatus);

        mCheckUpdateBtn = UiChrome.makePillButton(this, Localize.t(this, "检查增量更新", "Check for Incremental Update"), true, p,
                v -> checkIncrementalUpdate());
        mCheckUpdateBtn.setContentDescription("check_incremental_update_button");
        updateCard.addView(mCheckUpdateBtn);

        addSpacing(updateCard, 8);
        mInstallUpdateBtn = UiChrome.makePillButton(this, Localize.t(this, "立即安装更新", "Install Staged Update"), false, p,
                v -> installStagedUpdate());
        mInstallUpdateBtn.setContentDescription("install_staged_update_button");
        mInstallUpdateBtn.setVisibility(mStagedUpdateApk != null && mStagedUpdateApk.isFile() ? View.VISIBLE : View.GONE);
        updateCard.addView(mInstallUpdateBtn);

        root.addView(updateCard);

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
    }

    private void checkIncrementalUpdate() {
        String url = mUpdateUrlInput != null && mUpdateUrlInput.getText() != null
                ? mUpdateUrlInput.getText().toString().trim()
                : "";
        if (!url.isEmpty()) {
            Storage.setUpdateFeedUrl(this, url);
        }
        if (mCheckUpdateBtn != null) mCheckUpdateBtn.setEnabled(false);
        if (mInstallUpdateBtn != null) mInstallUpdateBtn.setVisibility(View.GONE);
        if (mUpdateStatus != null) mUpdateStatus.setText(Localize.t(this, "正在检查更新…", "Checking for updates…"));
        UpdateManager.checkAndStageAsync(this, url, new UpdateManager.Callback() {
            @Override
            public void onStage(String message, int progressPercent) {
                mMain.post(() -> {
                    if (mUpdateStatus != null) mUpdateStatus.setText(message + " (" + progressPercent + "%)");
                });
            }

            @Override
            public void onUpToDate(String currentVersion, String shortSha) {
                mMain.post(() -> {
                    if (mCheckUpdateBtn != null) mCheckUpdateBtn.setEnabled(true);
                    if (mUpdateStatus != null) {
                        mUpdateStatus.setText(Localize.t(ProfileActivity.this,
                                "已是最新版本：" + currentVersion + " [" + shortSha + "]",
                                "Already up to date: " + currentVersion + " [" + shortSha + "]"));
                    }
                });
            }

            @Override
            public void onReady(File stagedApk, String versionLabel, boolean usedDelta, long downloadBytes, long fullBytes, String notes) {
                mMain.post(() -> {
                    mStagedUpdateApk = stagedApk;
                    if (mCheckUpdateBtn != null) mCheckUpdateBtn.setEnabled(true);
                    if (mInstallUpdateBtn != null) mInstallUpdateBtn.setVisibility(View.VISIBLE);
                    String detail;
                    if (usedDelta && downloadBytes > 0 && fullBytes > 0) {
                        int savedPct = (int) Math.max(0, Math.round((1.0 - (double) downloadBytes / (double) fullBytes) * 100.0));
                        detail = Localize.t(ProfileActivity.this,
                                "增量更新已就绪：" + versionLabel + "（下载 " + UpdateManager.formatBytes(downloadBytes)
                                        + " / 原包 " + UpdateManager.formatBytes(fullBytes) + "，节省 " + savedPct + "%）",
                                "Incremental update ready: " + versionLabel + " (downloaded " + UpdateManager.formatBytes(downloadBytes)
                                        + " / " + UpdateManager.formatBytes(fullBytes) + ", saved " + savedPct + "%)");
                    } else if (usedDelta && downloadBytes == 0) {
                        detail = Localize.t(ProfileActivity.this,
                                "已缓存校验通过的更新包：" + versionLabel + "，点击下方按钮安装",
                                "Verified update already staged: " + versionLabel);
                    } else {
                        detail = Localize.t(ProfileActivity.this,
                                "完整更新包已就绪：" + versionLabel + "（" + UpdateManager.formatBytes(fullBytes) + "）",
                                "Full update ready: " + versionLabel + " (" + UpdateManager.formatBytes(fullBytes) + ")");
                    }
                    if (notes != null && !notes.isEmpty()) {
                        detail = detail + "\n" + notes;
                    }
                    if (mUpdateStatus != null) mUpdateStatus.setText(detail);
                });
            }

            @Override
            public void onError(String message) {
                mMain.post(() -> {
                    if (mCheckUpdateBtn != null) mCheckUpdateBtn.setEnabled(true);
                    if (mUpdateStatus != null) {
                        mUpdateStatus.setText(Localize.t(ProfileActivity.this, "更新失败：", "Update failed: ") + message);
                    }
                });
            }
        });
    }

    private void installStagedUpdate() {
        if (mStagedUpdateApk == null || !mStagedUpdateApk.isFile()) {
            Toast.makeText(this, Localize.t(this, "请先检查并准备更新包", "Check for updates first"), Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            boolean launched = UpdateManager.launchInstaller(this, mStagedUpdateApk);
            if (!launched) {
                Toast.makeText(this, Localize.t(this,
                        "请先授予“安装未知应用”权限，返回后再点安装",
                        "Allow installing unknown apps, then tap Install again"), Toast.LENGTH_LONG).show();
            }
        } catch (Throwable t) {
            Toast.makeText(this, Localize.t(this, "拉起安装器失败：", "Installer error: ") + t.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void load() {
        new Thread(() -> {
            try {
                JSONObject p = HostApiClient.getProfile(this);
                Storage.setProfileCache(this, p);
                mMain.post(() -> {
                    String name = p.isNull("displayName") ? "" : p.optString("displayName", "");
                    mNameInput.setText(name);
                    String dataUrl = p.isNull("avatarDataUrl") ? "" : p.optString("avatarDataUrl", "");
                    mAvatarDataUrl = dataUrl.startsWith("data:image/") ? dataUrl : null;
                    mAvatar.setImageBitmap(UiChrome.decodeCircleAvatar(name, mAvatarDataUrl, UiChrome.dp(this, 84)));
                    mStatus.setText(Localize.t(this, "点击头像更换图片", "Tap avatar to change"));
                });
            } catch (Throwable t) {
                mMain.post(() -> mStatus.setText(Localize.t(this, "读取失败: ", "Could not load profile: ") + t.getMessage()));
            }
        }).start();
    }

    private void saveProfile() {
        String name = mNameInput.getText().toString().trim();
        mStatus.setText(Localize.t(this, "正在保存…", "Saving…"));
        new Thread(() -> {
            try {
                JSONObject p = HostApiClient.updateProfile(this, name, mAvatarDataUrl);
                Storage.setProfileCache(this, p);
                mMain.post(() -> {
                    Toast.makeText(this, Localize.t(this, "资料已更新", "Profile updated"), Toast.LENGTH_SHORT).show();
                    finish();
                });
            } catch (Throwable t) {
                mMain.post(() -> mStatus.setText(Localize.t(this, "保存失败: ", "Error: ") + t.getMessage()));
            }
        }).start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_AVATAR && resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri uri = data.getData();
            new Thread(() -> {
                try (InputStream is = getContentResolver().openInputStream(uri)) {
                    Bitmap orig = BitmapFactory.decodeStream(is);
                    if (orig == null) return;
                    int side = Math.min(orig.getWidth(), orig.getHeight());
                    if (side <= 0) {
                        orig.recycle();
                        return;
                    }
                    int x = Math.max(0, (orig.getWidth() - side) / 2);
                    int y = Math.max(0, (orig.getHeight() - side) / 2);
                    Bitmap cropped = (orig.getWidth() == orig.getHeight())
                            ? orig
                            : Bitmap.createBitmap(orig, x, y, side, side);
                    Bitmap scaled = (side == 256)
                            ? cropped
                            : Bitmap.createScaledBitmap(cropped, 256, 256, true);
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    scaled.compress(Bitmap.CompressFormat.JPEG, 85, baos);
                    if (scaled != cropped && scaled != orig) scaled.recycle();
                    if (cropped != orig) cropped.recycle();
                    orig.recycle();
                    mAvatarDataUrl = "data:image/jpeg;base64," + Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
                    mMain.post(() -> mAvatar.setImageBitmap(
                            UiChrome.decodeCircleAvatar("U", mAvatarDataUrl, UiChrome.dp(this, 84))));
                } catch (Throwable ignored) {}
            }).start();
        }
    }

    private void addSpacing(LinearLayout parent, int dp) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, UiChrome.dp(this, dp)));
        parent.addView(v);
    }
}

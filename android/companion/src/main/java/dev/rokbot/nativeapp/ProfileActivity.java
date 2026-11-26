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
import java.io.InputStream;

/**
 * "个人资料 / Profile" (tap on the settings account row or the sidebar identity): avatar and
 * display name stored on the paired Host. Appearance & language are the official settings rows and
 * the incremental update lives on the "应用更新" page (UpdateActivity).
 */
public class ProfileActivity extends Activity {
    static final String TITLE_ZH = "个人资料";
    static final String TITLE_EN = "Profile";
    private static final int REQ_PICK_AVATAR = 701;
    private ImageView mAvatar;
    private EditText mNameInput;
    private TextView mStatus;
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

        root.addView(UiChrome.makeHeaderBar(this, Localize.t(this, TITLE_ZH, TITLE_EN), p, v -> finish()));

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
        mStatus.setGravity(Gravity.CENTER);
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

        TextView foot = new TextView(this);
        foot.setText(Localize.t(this,
                "资料保存在已配对的 Host 上，设置页账户行和侧栏会同步显示。外观、语言和应用更新在设置首页。",
                "Your profile is stored on the paired Host and shown in the settings account row and the sidebar. Appearance, language and app updates are on the main settings page."));
        foot.setTextColor(p.textMuted);
        foot.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        foot.setLineSpacing(0f, 1.15f);
        foot.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 16), UiChrome.dp(this, 4), 0);
        root.addView(foot);

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
    }

    private void load() {
        new Thread(() -> {
            try {
                JSONObject p = HostApiClient.getProfile(this);
                HostProfile.apply(this, p);
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
                // Persists profileCache and repaints the RN identity row/avatar immediately.
                HostProfile.apply(this, p);
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

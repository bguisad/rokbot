package dev.rokbot.nativeapp;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * "Bot 图标样式 / Bot Icon Style": the RokBot avatar style used for every Bot icon in the app
 * (RokBotAvatarManager). Opened from the rokbot row of the RN settings sheet
 * (hermes-settings.mjs applySettingsMenu, MENU_LABELS.avatar). A preview card shows the
 * selected style on four Bot shapes; the list below picks one, applied immediately.
 */
public class AvatarStyleActivity extends Activity {
    static final String TITLE_ZH = "Bot 图标样式";
    static final String TITLE_EN = "Bot Icon Style";

    private static final String[] PREVIEW_SHAPES = { "blob", "cloud", "hex", "heart" };
    private static final int[] PREVIEW_COLORS = { 0xFF1084FE, 0xFF9159FE, 0xFFFF6700, 0xFFFF309B };

    private final RokBotAvatarView[] mPreviews = new RokBotAvatarView[4];
    private TextView mPreviewName;
    private TextView mPreviewDesc;
    private final View[] mChecks = new View[RokBotAvatarRenderer.STYLES.length];
    private final RokBotAvatarView[] mRowAvatars = new RokBotAvatarView[RokBotAvatarRenderer.STYLES.length];

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        buildUi();
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

        View header = UiChrome.makeHeaderBar(this, Localize.t(this, TITLE_ZH, TITLE_EN), p, v -> finish());
        header.setContentDescription("avatar_style_title");
        root.addView(header);

        String current = RokBotAvatarManager.getStyle(this);

        // Preview: the selected style on four Bot shapes.
        LinearLayout preview = UiChrome.makeCard(this, p);
        preview.setGravity(Gravity.CENTER_HORIZONTAL);
        preview.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 20), UiChrome.dp(this, 16), UiChrome.dp(this, 18));
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        plp.topMargin = UiChrome.dp(this, 10);
        preview.setLayoutParams(plp);
        preview.setContentDescription("avatar_style_preview");
        LinearLayout marks = new LinearLayout(this);
        marks.setOrientation(LinearLayout.HORIZONTAL);
        marks.setGravity(Gravity.CENTER);
        for (int i = 0; i < mPreviews.length; i++) {
            RokBotAvatarView v = new RokBotAvatarView(this);
            v.setShape(PREVIEW_SHAPES[i]);
            v.setBaseColor(PREVIEW_COLORS[i]);
            v.setStyleId(current);
            v.setActive(i == 0);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(UiChrome.dp(this, 52), UiChrome.dp(this, 52));
            if (i > 0) lp.leftMargin = UiChrome.dp(this, 16);
            marks.addView(v, lp);
            mPreviews[i] = v;
        }
        preview.addView(marks);
        mPreviewName = new TextView(this);
        mPreviewName.setTextColor(p.textPrimary);
        mPreviewName.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        mPreviewName.setTypeface(Typeface.DEFAULT_BOLD);
        mPreviewName.setGravity(Gravity.CENTER);
        mPreviewName.setPadding(0, UiChrome.dp(this, 14), 0, UiChrome.dp(this, 2));
        preview.addView(mPreviewName);
        mPreviewDesc = new TextView(this);
        mPreviewDesc.setTextColor(p.textSecondary);
        mPreviewDesc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mPreviewDesc.setGravity(Gravity.CENTER);
        preview.addView(mPreviewDesc);
        root.addView(preview);

        // Style list.
        root.addView(UiChrome.makeSectionLabel(this, Localize.t(this, "样式", "Style"), p));
        LinearLayout group = UiChrome.makeRowGroup(this, p);
        group.setContentDescription("avatar_style_list");
        for (int i = 0; i < RokBotAvatarRenderer.STYLES.length; i++) {
            if (i > 0) group.addView(makeInsetDivider(p));
            group.addView(makeStyleRow(p, i));
        }
        root.addView(group);

        TextView foot = new TextView(this);
        foot.setText(Localize.t(this,
                "作用于 App 内所有 Bot 图标：Bot 列表、对话页、Bot 详情与编辑、创建新 Bot、搜索、分享面板和通知。选「官方原版」即恢复官方的动态流体球。",
                "Applies to every Bot icon in the app: the Bot list, chats, Bot details and editing, Create New Bot, search, the share sheet and notifications. Choose Official to go back to the official fluid orb."));
        foot.setTextColor(p.textMuted);
        foot.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        foot.setLineSpacing(0f, 1.15f);
        foot.setPadding(UiChrome.dp(this, 4), UiChrome.dp(this, 10), UiChrome.dp(this, 4), 0);
        root.addView(foot);

        setContentView(scroll);
        UiChrome.applyRootInsets(this, scroll);
        render(current);
    }

    private View makeStyleRow(UiChrome.Palette p, int index) {
        final RokBotAvatarRenderer.StyleInfo info = RokBotAvatarRenderer.STYLES[index];
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(UiChrome.dp(this, 68));
        row.setPadding(UiChrome.dp(this, 16), UiChrome.dp(this, 10), UiChrome.dp(this, 16), UiChrome.dp(this, 10));
        row.setContentDescription("avatar_style_" + info.id);
        row.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf((p.textPrimary & 0x00FFFFFF) | 0x1F000000), null,
                new android.graphics.drawable.ColorDrawable(0xFFFFFFFF)));
        row.setClickable(true);
        row.setOnClickListener(v -> select(info.id));

        RokBotAvatarView avatar = new RokBotAvatarView(this);
        avatar.setStyleId(info.id);
        avatar.setShape(info.previewShape);
        avatar.setBaseColor(info.previewColor);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(UiChrome.dp(this, 40), UiChrome.dp(this, 40));
        alp.rightMargin = UiChrome.dp(this, 14);
        row.addView(avatar, alp);
        mRowAvatars[index] = avatar;

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView name = new TextView(this);
        String nameText = Localize.t(this, info.zh, info.en);
        if (RokBotAvatarRenderer.STYLE_CHASSIS.equals(info.id)) nameText += Localize.t(this, " · 默认", " · Default");
        name.setText(nameText);
        name.setTextColor(p.textPrimary);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        texts.addView(name);
        TextView desc = new TextView(this);
        desc.setText(Localize.t(this, info.descZh, info.descEn));
        desc.setTextColor(p.textSecondary);
        desc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        desc.setSingleLine(true);
        desc.setEllipsize(TextUtils.TruncateAt.END);
        desc.setPadding(0, UiChrome.dp(this, 2), 0, 0);
        texts.addView(desc);
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        View check = new View(this);
        check.setBackground(new CheckDrawable(p.accent, UiChrome.dp(this, 2.2f)));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(UiChrome.dp(this, 20), UiChrome.dp(this, 20));
        clp.leftMargin = UiChrome.dp(this, 12);
        row.addView(check, clp);
        mChecks[index] = check;
        return row;
    }

    private View makeInsetDivider(UiChrome.Palette p) {
        View d = new View(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, UiChrome.dp(this, 0.7f)));
        lp.leftMargin = UiChrome.dp(this, 70);
        d.setLayoutParams(lp);
        d.setBackgroundColor(p.border);
        return d;
    }

    private void select(String styleId) {
        if (styleId.equals(RokBotAvatarManager.getStyle(this))) return;
        RokBotAvatarManager.setStyle(this, styleId);
        render(styleId);
    }

    private void render(String styleId) {
        RokBotAvatarRenderer.StyleInfo selected = RokBotAvatarRenderer.STYLES[0];
        for (int i = 0; i < RokBotAvatarRenderer.STYLES.length; i++) {
            RokBotAvatarRenderer.StyleInfo info = RokBotAvatarRenderer.STYLES[i];
            boolean on = info.id.equals(styleId);
            if (on) selected = info;
            mChecks[i].setVisibility(on ? View.VISIBLE : View.INVISIBLE);
            mRowAvatars[i].setActive(on);
            ((View) mChecks[i].getParent()).setSelected(on);
        }
        for (RokBotAvatarView v : mPreviews) v.setStyleId(selected.id);
        mPreviewName.setText(Localize.t(this, selected.zh, selected.en));
        mPreviewDesc.setText(Localize.t(this, selected.descZh, selected.descEn));
    }

    /** Vector check mark (selection), drawn with a rounded stroke like the platform pickers. */
    static final class CheckDrawable extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();

        CheckDrawable(int color, float strokePx) {
            paint.setColor(color);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(strokePx);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
        }

        @Override public void draw(Canvas canvas) {
            android.graphics.Rect b = getBounds();
            float w = b.width(), h = b.height();
            path.reset();
            path.moveTo(b.left + w * 0.16f, b.top + h * 0.53f);
            path.lineTo(b.left + w * 0.40f, b.top + h * 0.76f);
            path.lineTo(b.left + w * 0.86f, b.top + h * 0.26f);
            canvas.drawPath(path, paint);
        }

        @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
        @Override public void setColorFilter(android.graphics.ColorFilter cf) { paint.setColorFilter(cf); }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
    }
}

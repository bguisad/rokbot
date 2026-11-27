package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * The share sheet of a canvas, after the official CanvasShareSheet: "分享“标题”", "谁可以访问",
 * then the public-access switch (仅你可见 / 知道链接的任何人, official PRIVATE / PUBLIC). While public it
 * shows the link with 复制链接, 在浏览器中打开 and 重新生成链接 (the old link stops working).
 */
final class CanvasShareSheet {
    interface Listener { void onChanged(JSONObject canvas); }

    private CanvasShareSheet() {}

    static Dialog show(Activity act, JSONObject canvas, Listener listener) {
        Dialog dialog = new Dialog(act);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        Holder h = new Holder(act, dialog, canvas, listener);
        dialog.setContentView(h.root);
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawableResource(android.R.color.transparent);
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setGravity(Gravity.BOTTOM);
            w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            w.setDimAmount(0.35f);
        }
        h.render();
        dialog.show();
        return dialog;
    }

    private static final class Holder {
        final Activity act;
        final Dialog dialog;
        final Listener listener;
        final UiChrome.Palette p;
        final Handler main = new Handler(Looper.getMainLooper());
        final LinearLayout root;
        final LinearLayout body;
        JSONObject canvas;
        boolean pending;
        String error;
        boolean confirmRegenerate;

        Holder(Activity act, Dialog dialog, JSONObject canvas, Listener listener) {
            this.act = act;
            this.dialog = dialog;
            this.canvas = canvas;
            this.listener = listener;
            this.p = UiChrome.palette(act);
            root = new LinearLayout(act);
            root.setOrientation(LinearLayout.VERTICAL);
            root.setPadding(UiChrome.dp(act, 20), UiChrome.dp(act, 10), UiChrome.dp(act, 20), UiChrome.dp(act, 28));
            float r = UiChrome.dp(act, 22);
            android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
            bg.setColor(p.bgCard);
            bg.setCornerRadii(new float[] { r, r, r, r, 0, 0, 0, 0 });
            root.setBackground(bg);
            root.setContentDescription("canvas_share_sheet");
            View handle = new View(act);
            handle.setBackground(UiChrome.roundRect(p.border, UiChrome.dp(act, 3), 0, 0));
            LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(UiChrome.dp(act, 36), UiChrome.dp(act, 5));
            hlp.gravity = Gravity.CENTER_HORIZONTAL;
            hlp.bottomMargin = UiChrome.dp(act, 14);
            root.addView(handle, hlp);
            body = new LinearLayout(act);
            body.setOrientation(LinearLayout.VERTICAL);
            root.addView(body);
        }

        String t(String zh, String en) { return Localize.t(act, zh, en); }

        void render() {
            body.removeAllViews();
            String title = canvas.optString("title", t("画布", "Canvas"));
            boolean isPublic = "public".equals(canvas.optString("visibility"));
            String publicUrl = canvas.isNull("publicUrl") ? "" : canvas.optString("publicUrl", "");

            TextView heading = new TextView(act);
            heading.setText(t("分享“" + title + "”", "Share “" + title + "”"));
            heading.setTextColor(p.textPrimary);
            heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
            heading.setTypeface(Typeface.DEFAULT_BOLD);
            heading.setSingleLine(true);
            heading.setEllipsize(TextUtils.TruncateAt.END);
            body.addView(heading);

            TextView label = new TextView(act);
            label.setText(t("谁可以访问", "Who can access"));
            label.setTextColor(p.textMuted);
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            label.setPadding(0, UiChrome.dp(act, 14), 0, UiChrome.dp(act, 6));
            body.addView(label);

            LinearLayout access = new LinearLayout(act);
            access.setOrientation(LinearLayout.HORIZONTAL);
            access.setGravity(Gravity.CENTER_VERTICAL);
            access.setPadding(UiChrome.dp(act, 12), UiChrome.dp(act, 12), UiChrome.dp(act, 12), UiChrome.dp(act, 12));
            access.setBackground(UiChrome.roundRect(p.bgSurface2, UiChrome.dp(act, 14), 0, 0));
            LinearLayout circle = new LinearLayout(act);
            circle.setGravity(Gravity.CENTER);
            circle.setBackground(UiChrome.circle(p.bgCard, 0, 0));
            circle.addView(CanvasUi.icon(act, isPublic ? "globe" : "lock", isPublic ? CanvasUi.okColor(p) : p.textSecondary, 18));
            access.addView(circle, new LinearLayout.LayoutParams(UiChrome.dp(act, 36), UiChrome.dp(act, 36)));
            LinearLayout texts = new LinearLayout(act);
            texts.setOrientation(LinearLayout.VERTICAL);
            texts.setPadding(UiChrome.dp(act, 12), 0, UiChrome.dp(act, 8), 0);
            TextView name = new TextView(act);
            name.setText(t("公开访问", "Public access"));
            name.setTextColor(p.textPrimary);
            name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            name.setTypeface(Typeface.DEFAULT_BOLD);
            texts.addView(name);
            TextView desc = new TextView(act);
            desc.setText(pending ? t("正在更新…", "Updating…")
                    : isPublic ? t("知道链接的任何人 · 无需登录", "Anyone with the link · No sign-in needed")
                    : t("仅你可见 · 只能在已登录的 RokBot 中打开", "Private to you · Opens only in signed-in RokBot apps"));
            desc.setTextColor(p.textSecondary);
            desc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            texts.addView(desc);
            access.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            CanvasUi.Switch toggle = new CanvasUi.Switch(act);
            toggle.setColors(CanvasUi.okColor(p), p.dark ? 0xFF4A4A52 : 0x3D1C1C1C);
            toggle.setChecked(isPublic, false);
            toggle.setEnabled(!pending);
            toggle.setContentDescription(t("公开访问", "Public access"));
            toggle.setOnClickListener(v -> setPublic(!isPublic));
            access.addView(toggle);
            access.setOnClickListener(v -> { if (!pending) setPublic(!isPublic); });
            body.addView(access);

            if (isPublic && !publicUrl.isEmpty()) {
                LinearLayout link = new LinearLayout(act);
                link.setOrientation(LinearLayout.HORIZONTAL);
                link.setGravity(Gravity.CENTER_VERTICAL);
                link.setPadding(UiChrome.dp(act, 12), UiChrome.dp(act, 10), UiChrome.dp(act, 12), UiChrome.dp(act, 10));
                link.setBackground(UiChrome.roundRect(p.bgPaper, UiChrome.dp(act, 12), p.border, UiChrome.dp(act, 1)));
                link.addView(CanvasUi.icon(act, "globe", p.textSecondary, 14));
                TextView url = new TextView(act);
                url.setText(publicUrl);
                url.setTextColor(p.textSecondary);
                url.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                url.setTypeface(Typeface.MONOSPACE);
                url.setSingleLine(true);
                url.setEllipsize(TextUtils.TruncateAt.MIDDLE);
                url.setTextIsSelectable(true);
                url.setPadding(UiChrome.dp(act, 8), 0, 0, 0);
                url.setContentDescription("canvas_public_url");
                link.addView(url, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                llp.topMargin = UiChrome.dp(act, 12);
                body.addView(link, llp);

                LinearLayout actions = new LinearLayout(act);
                actions.setOrientation(LinearLayout.HORIZONTAL);
                LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                alp.topMargin = UiChrome.dp(act, 12);
                LinearLayout copy = CanvasUi.button(act, p, "copy", t("复制链接", "Copy link"), 1, v -> copy(publicUrl, (LinearLayout) v));
                actions.addView(copy);
                LinearLayout open = CanvasUi.button(act, p, "external", t("在浏览器中打开", "Open in browser"), 0, v -> openInBrowser(publicUrl));
                LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                olp.leftMargin = UiChrome.dp(act, 8);
                actions.addView(open, olp);
                body.addView(actions, alp);
                LinearLayout regenerate = CanvasUi.button(act, p, "rotate", t("重新生成链接", "Regenerate link"), 0, v -> { confirmRegenerate = true; render(); });
                regenerate.setEnabled(!pending && !confirmRegenerate);
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rlp.topMargin = UiChrome.dp(act, 8);
                body.addView(regenerate, rlp);
                if (confirmRegenerate) {
                    LinearLayout confirm = new LinearLayout(act);
                    confirm.setOrientation(LinearLayout.VERTICAL);
                    confirm.setPadding(UiChrome.dp(act, 12), UiChrome.dp(act, 10), UiChrome.dp(act, 12), UiChrome.dp(act, 12));
                    confirm.setBackground(UiChrome.roundRect(p.dark ? 0x26E5484D : 0x14E72E3B, UiChrome.dp(act, 12), 0, 0));
                    TextView warn = new TextView(act);
                    warn.setText(t("生成新链接后，旧链接会立即失效，已经发出去的旧链接将无法再打开。",
                            "The old link stops working right away; anyone holding it can no longer open the canvas."));
                    warn.setTextColor(p.textSecondary);
                    warn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                    confirm.addView(warn);
                    LinearLayout row = new LinearLayout(act);
                    row.setOrientation(LinearLayout.HORIZONTAL);
                    row.setPadding(0, UiChrome.dp(act, 8), 0, 0);
                    row.addView(CanvasUi.button(act, p, null, pending ? t("正在生成…", "Regenerating…") : t("生成新链接", "Regenerate"), 2, v -> regenerate()));
                    LinearLayout cancel = CanvasUi.button(act, p, null, t("取消", "Cancel"), 0, v -> { confirmRegenerate = false; render(); });
                    LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                    clp.leftMargin = UiChrome.dp(act, 8);
                    row.addView(cancel, clp);
                    confirm.addView(row);
                    LinearLayout.LayoutParams cfl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                    cfl.topMargin = UiChrome.dp(act, 10);
                    body.addView(confirm, cfl);
                }
            } else {
                TextView note = new TextView(act);
                note.setText(t("开启后会生成一个公开链接，拿到链接的人无需登录即可查看。关闭后该链接立即失效。",
                        "Turning this on creates a public link anyone can open without signing in. Turning it off disables the link right away."));
                note.setTextColor(p.textMuted);
                note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                note.setPadding(UiChrome.dp(act, 2), UiChrome.dp(act, 10), UiChrome.dp(act, 2), 0);
                body.addView(note);
            }
            if (error != null) {
                TextView err = new TextView(act);
                err.setText(error);
                err.setTextColor(p.danger);
                err.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                err.setPadding(UiChrome.dp(act, 2), UiChrome.dp(act, 10), 0, 0);
                body.addView(err);
            }
        }

        void setPublic(boolean value) {
            if (pending) return;
            pending = true; error = null; render();
            String id = canvas.optString("id");
            new Thread(() -> {
                try {
                    JSONObject next = HostApiClient.setCanvasVisibility(act, id, value).optJSONObject("canvas");
                    main.post(() -> { pending = false; if (next != null) { canvas = next; listener.onChanged(next); } render(); });
                } catch (Throwable t) {
                    main.post(() -> { pending = false; error = t("无法更新访问权限，请稍后再试。", "Couldn’t update access. Try again later."); render(); });
                }
            }).start();
        }

        void regenerate() {
            if (pending) return;
            pending = true; error = null; render();
            String id = canvas.optString("id");
            new Thread(() -> {
                try {
                    JSONObject next = HostApiClient.regenerateCanvasLink(act, id).optJSONObject("canvas");
                    main.post(() -> { pending = false; confirmRegenerate = false; if (next != null) { canvas = next; listener.onChanged(next); } render(); });
                } catch (Throwable t) {
                    main.post(() -> { pending = false; error = t("无法重新生成链接，请稍后再试。", "Could not regenerate the link. Try again later."); render(); });
                }
            }).start();
        }

        void copy(String url, LinearLayout button) {
            try {
                ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText(t("画布链接", "Canvas link"), url));
                TextView label = (TextView) button.getChildAt(button.getChildCount() - 1);
                ((CanvasUi.Icon) button.getChildAt(0)).set("check", p.accentText);
                label.setText(t("已复制", "Copied"));
                main.postDelayed(() -> { if (dialog.isShowing()) render(); }, 1600);
            } catch (Throwable t) {
                error = t("复制失败", "Failed to copy link");
                render();
            }
        }

        void openInBrowser(String url) {
            if (!CanvasModel.isPublicLink(url)) return;
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.putExtra(CanvasLinks.EXTRA_ALLOW_EXTERNAL, true);
                act.startActivity(i);
            } catch (Throwable ignored) {}
        }
    }
}

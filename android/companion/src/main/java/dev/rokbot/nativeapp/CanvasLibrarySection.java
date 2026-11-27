package dev.rokbot.nativeapp;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Typeface;
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

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The Bot's canvases in its Library, like the official Library "页面" rows: page glyph, title, update
 * time (Beijing time) and a 私有 / 公开 mark; tapping opens the canvas, the "更多" button offers
 * 打开, 分享… and 删除… (confirmed).
 */
final class CanvasLibrarySection {
    private static final int COLLAPSED = 5;

    private final Activity act;
    private final String agentId;
    private final UiChrome.Palette p;
    private final Handler main = new Handler(Looper.getMainLooper());
    final LinearLayout view;
    private final LinearLayout list;
    private final TextView status;
    private JSONArray canvases = new JSONArray();
    private boolean expanded;
    private int generation;

    CanvasLibrarySection(Activity act, String agentId) {
        this.act = act;
        this.agentId = agentId;
        this.p = UiChrome.palette(act);
        view = new LinearLayout(act);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setContentDescription("library_canvases");
        TextView heading = new TextView(act);
        heading.setText(t("画布", "Canvases"));
        heading.setTextColor(p.textPrimary);
        heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        heading.setPadding(UiChrome.dp(act, 4), UiChrome.dp(act, 4), 0, UiChrome.dp(act, 6));
        view.addView(heading);
        status = new TextView(act);
        status.setTextColor(p.textSecondary);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        status.setPadding(UiChrome.dp(act, 4), 0, 0, UiChrome.dp(act, 8));
        view.addView(status);
        list = new LinearLayout(act);
        list.setOrientation(LinearLayout.VERTICAL);
        view.addView(list);
    }

    private String t(String zh, String en) { return Localize.t(act, zh, en); }

    void reload() {
        final int gen = ++generation;
        if (canvases.length() == 0) status.setText(t("正在加载画布…", "Loading canvases…"));
        new Thread(() -> {
            try {
                JSONArray next = HostApiClient.listCanvases(act, agentId).optJSONArray("canvases");
                main.post(() -> { if (gen == generation) { canvases = next != null ? next : new JSONArray(); render(); } });
            } catch (Throwable e) {
                main.post(() -> {
                    if (gen != generation) return;
                    status.setVisibility(View.VISIBLE);
                    status.setText(t("无法加载画布。", "Couldn’t load canvases.") + (e instanceof HostApiClient.ApiException && ((HostApiClient.ApiException) e).statusCode == 404
                            ? t("当前 Host 版本不支持画布。", " This Host does not support canvases.") : ""));
                });
            }
        }).start();
    }

    private void render() {
        list.removeAllViews();
        if (canvases.length() == 0) {
            status.setVisibility(View.VISIBLE);
            status.setText(t("这个 Bot 创建的画布会显示在这里。", "Canvases this Bot makes show up here."));
            return;
        }
        status.setVisibility(View.GONE);
        int shown = expanded ? canvases.length() : Math.min(COLLAPSED, canvases.length());
        for (int i = 0; i < shown; i++) {
            JSONObject c = canvases.optJSONObject(i);
            if (c != null) list.addView(row(c));
        }
        if (canvases.length() > COLLAPSED) {
            LinearLayout more = CanvasUi.button(act, p, null, expanded ? t("收起", "Show less") : t("显示全部 " + canvases.length() + " 个", "Show all " + canvases.length()), 3,
                    v -> { expanded = !expanded; render(); });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.bottomMargin = UiChrome.dp(act, 6);
            list.addView(more, lp);
        }
    }

    private View row(JSONObject c) {
        String id = c.optString("id"), title = c.optString("title", t("画布", "Canvas"));
        LinearLayout row = new LinearLayout(act);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(UiChrome.dp(act, 12), UiChrome.dp(act, 10), UiChrome.dp(act, 4), UiChrome.dp(act, 10));
        row.setBackground(UiChrome.roundRect(p.bgCard, UiChrome.dp(act, 16), p.border, UiChrome.dp(act, 1)));
        row.setContentDescription("canvas_row_" + id);
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(v -> CanvasLinks.open(act, id, title));
        row.addView(CanvasUi.glyph(act, p, 34));
        LinearLayout texts = new LinearLayout(act);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setPadding(UiChrome.dp(act, 12), 0, UiChrome.dp(act, 6), 0);
        TextView name = new TextView(act);
        name.setText(title);
        name.setTextColor(p.textPrimary);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        texts.addView(name);
        LinearLayout meta = new LinearLayout(act);
        meta.setOrientation(LinearLayout.HORIZONTAL);
        meta.setGravity(Gravity.CENTER_VERTICAL);
        meta.setPadding(0, UiChrome.dp(act, 3), 0, 0);
        TextView time = new TextView(act);
        time.setText(CanvasModel.shortTime(c.optLong("updatedAtMs"), System.currentTimeMillis(), Localize.isChinese(act)) + "  ·  ");
        time.setTextColor(p.textMuted);
        time.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        meta.addView(time);
        meta.addView(CanvasUi.visibilityMark(act, p, c.optString("visibility"), false));
        texts.addView(meta);
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        LinearLayout more = CanvasUi.button(act, p, "more", null, 3, v -> actions(c));
        more.setContentDescription(t("“" + title + "”的更多操作", "More actions for " + title));
        row.addView(more);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = UiChrome.dp(act, 8);
        row.setLayoutParams(lp);
        return row;
    }

    private Dialog sheet(View content) {
        Dialog d = new Dialog(act);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        d.setContentView(content);
        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawableResource(android.R.color.transparent);
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setGravity(Gravity.BOTTOM);
            w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            w.setDimAmount(0.35f);
        }
        return d;
    }

    private LinearLayout sheetRoot() {
        LinearLayout root = new LinearLayout(act);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(UiChrome.dp(act, 12), UiChrome.dp(act, 14), UiChrome.dp(act, 12), UiChrome.dp(act, 24));
        float r = UiChrome.dp(act, 22);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(p.bgCard);
        bg.setCornerRadii(new float[] { r, r, r, r, 0, 0, 0, 0 });
        root.setBackground(bg);
        return root;
    }

    private View actionRow(String icon, String label, int color, View.OnClickListener onClick) {
        LinearLayout row = new LinearLayout(act);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(UiChrome.dp(act, 12), UiChrome.dp(act, 14), UiChrome.dp(act, 12), UiChrome.dp(act, 14));
        row.addView(CanvasUi.icon(act, icon, color, 18));
        TextView tv = new TextView(act);
        tv.setText(label);
        tv.setTextColor(color);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tv.setPadding(UiChrome.dp(act, 14), 0, 0, 0);
        row.addView(tv);
        row.setClickable(true);
        row.setFocusable(true);
        row.setContentDescription(label);
        row.setOnClickListener(onClick);
        return row;
    }

    private void actions(JSONObject c) {
        String title = c.optString("title");
        LinearLayout root = sheetRoot();
        root.setContentDescription("canvas_actions");
        TextView heading = new TextView(act);
        heading.setText(title);
        heading.setTextColor(p.textMuted);
        heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        heading.setSingleLine(true);
        heading.setEllipsize(TextUtils.TruncateAt.END);
        heading.setPadding(UiChrome.dp(act, 12), 0, UiChrome.dp(act, 12), UiChrome.dp(act, 6));
        root.addView(heading);
        Dialog d = sheet(root);
        root.addView(actionRow("open", t("打开", "Open"), p.textPrimary, v -> { d.dismiss(); CanvasLinks.open(act, c.optString("id"), title); }));
        root.addView(actionRow("share", t("分享…", "Share…"), p.textPrimary, v -> { d.dismiss(); CanvasShareSheet.show(act, c, next -> reload()); }));
        root.addView(actionRow("trash", t("删除…", "Delete…"), p.danger, v -> { d.dismiss(); confirmDelete(c); }));
        d.show();
    }

    private void confirmDelete(JSONObject c) {
        String id = c.optString("id"), title = c.optString("title");
        LinearLayout box = new LinearLayout(act);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(UiChrome.dp(act, 22), UiChrome.dp(act, 20), UiChrome.dp(act, 22), UiChrome.dp(act, 18));
        box.setBackground(UiChrome.roundRect(p.bgCard, UiChrome.dp(act, 20), 0, 0));
        box.setContentDescription("canvas_delete_confirm");
        TextView h = new TextView(act);
        h.setText(t("删除“" + title + "”", "Delete “" + title + "”"));
        h.setTextColor(p.textPrimary);
        h.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        h.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(h);
        TextView body = new TextView(act);
        body.setText(t("这会永久删除这个画布。它的公开链接会立即失效，聊天里的画布卡片会显示为已删除。此操作无法撤销。",
                "This permanently deletes the canvas. Its public link stops working and chat cards show it as deleted. This can’t be undone."));
        body.setTextColor(p.textSecondary);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        body.setPadding(0, UiChrome.dp(act, 8), 0, 0);
        box.addView(body);
        TextView err = new TextView(act);
        err.setTextColor(p.danger);
        err.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        err.setVisibility(View.GONE);
        box.addView(err);
        LinearLayout row = new LinearLayout(act);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.END);
        row.setPadding(0, UiChrome.dp(act, 20), 0, 0);
        Dialog d = new Dialog(act);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout cancel = CanvasUi.button(act, p, null, t("取消", "Cancel"), 0, v -> d.dismiss());
        row.addView(cancel);
        final LinearLayout[] remove = new LinearLayout[1];
        remove[0] = CanvasUi.button(act, p, null, t("删除画布", "Delete canvas"), 2, v -> {
            remove[0].setEnabled(false);
            cancel.setEnabled(false);
            ((TextView) remove[0].getChildAt(0)).setText(t("正在删除…", "Deleting…"));
            new Thread(() -> {
                try {
                    HostApiClient.deleteCanvas(act, id);
                    main.post(() -> { d.dismiss(); reload(); });
                } catch (Throwable e) {
                    main.post(() -> {
                        remove[0].setEnabled(true);
                        cancel.setEnabled(true);
                        ((TextView) remove[0].getChildAt(0)).setText(t("删除画布", "Delete canvas"));
                        err.setText(t("无法删除画布，请稍后再试。", "Couldn’t delete the canvas. Try again later."));
                        err.setVisibility(View.VISIBLE);
                    });
                }
            }).start();
        });
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp.leftMargin = UiChrome.dp(act, 10);
        row.addView(remove[0], rlp);
        box.addView(row);
        d.setContentView(box);
        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawableResource(android.R.color.transparent);
            w.setLayout(Math.min(act.getResources().getDisplayMetrics().widthPixels - UiChrome.dp(act, 48), UiChrome.dp(act, 400)), ViewGroup.LayoutParams.WRAP_CONTENT);
        }
        d.show();
    }
}

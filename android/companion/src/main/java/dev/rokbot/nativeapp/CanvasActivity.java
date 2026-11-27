package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * A canvas inside the app (the official stage / CanvasModalScreen): a bar with 返回聊天, the title
 * and its 私有 / 公开 mark, 刷新, 分享 and 关闭, over the canvas itself.
 *
 * The canvas page is read with this device's credential (GET /canvas/app/<id>/frame) and shown in a
 * WebView that blocks all network loads and has no bridge, file or storage access; links the canvas
 * opens go to the browser only for http(s) after a tap. A private canvas never needs a public link.
 */
public class CanvasActivity extends Activity {
    public static final String EXTRA_CANVAS_ID = "canvasId";
    public static final String EXTRA_TITLE = "title";

    private final Handler main = new Handler(Looper.getMainLooper());
    private UiChrome.Palette p;
    private String canvasId;
    private JSONObject canvas;
    private TextView titleView;
    private LinearLayout titleRow;
    private View markView;
    private WebView web;
    private TextView message;
    private View shareButton;
    private int generation;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        UiChrome.prepareWindow(this);
        super.onCreate(savedInstanceState);
        canvasId = getIntent().getStringExtra(EXTRA_CANVAS_ID);
        if (!CanvasModel.isCanvasId(canvasId)) { finish(); return; }
        p = UiChrome.palette(this);
        buildUi(getIntent().getStringExtra(EXTRA_TITLE));
        load();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String next = intent.getStringExtra(EXTRA_CANVAS_ID);
        if (CanvasModel.isCanvasId(next) && !next.equals(canvasId)) {
            canvasId = next;
            canvas = null;
            setTitleText(intent.getStringExtra(EXTRA_TITLE));
            load();
        }
    }

    private String t(String zh, String en) { return Localize.t(this, zh, en); }

    private void buildUi(String initialTitle) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(p.bgPaper);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(UiChrome.dp(this, 6), UiChrome.dp(this, 6), UiChrome.dp(this, 8), UiChrome.dp(this, 6));
        bar.setBackgroundColor(p.bgHeader);
        LinearLayout back = CanvasUi.button(this, p, "back", null, 3, v -> finish());
        back.setContentDescription(t("返回聊天", "Back to chat"));
        bar.addView(back);

        titleRow = new LinearLayout(this);
        titleRow.setOrientation(LinearLayout.HORIZONTAL);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        titleRow.addView(CanvasUi.glyph(this, p, 26));
        titleView = new TextView(this);
        titleView.setTextColor(p.textPrimary);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        titleView.setPadding(UiChrome.dp(this, 8), 0, UiChrome.dp(this, 6), 0);
        titleView.setContentDescription("canvas_title");
        titleRow.addView(titleView, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(titleRow, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        LinearLayout refresh = CanvasUi.button(this, p, "refresh", null, 3, v -> load());
        refresh.setContentDescription(t("刷新", "Refresh"));
        bar.addView(refresh);
        LinearLayout share = CanvasUi.button(this, p, "share", t("分享", "Share"), 0, v -> share());
        share.setContentDescription(t("分享", "Share"));
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.leftMargin = UiChrome.dp(this, 2);
        bar.addView(share, slp);
        shareButton = share;
        shareButton.setEnabled(false);
        shareButton.setAlpha(0.5f);
        LinearLayout close = CanvasUi.button(this, p, "close", null, 3, v -> finish());
        close.setContentDescription(t("关闭", "Close"));
        bar.addView(close);
        root.addView(bar);
        View line = new View(this);
        line.setBackgroundColor(p.border);
        root.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, UiChrome.dp(this, 0.6f))));

        FrameLayout stage = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(p.bgPaper);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(false);
        ws.setDatabaseEnabled(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setBlockNetworkLoads(true);
        ws.setGeolocationEnabled(false);
        ws.setSupportMultipleWindows(false);
        ws.setJavaScriptCanOpenWindowsAutomatically(false);
        ws.setMediaPlaybackRequiresUserGesture(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if (request.hasGesture() && request.isForMainFrame() && scheme != null && (scheme.equals("http") || scheme.equals("https"))) {
                    String id = CanvasModel.appLinkId(uri.toString());
                    if (id != null) CanvasLinks.open(CanvasActivity.this, id, null);
                    else try { startActivity(new Intent(Intent.ACTION_VIEW, uri).putExtra(CanvasLinks.EXTRA_ALLOW_EXTERNAL, true)); } catch (Throwable ignored) {}
                }
                return true;
            }
        });
        web.setContentDescription("canvas_webview");
        stage.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        message = new TextView(this);
        message.setTextColor(p.textSecondary);
        message.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        message.setGravity(Gravity.CENTER);
        message.setPadding(UiChrome.dp(this, 32), 0, UiChrome.dp(this, 32), 0);
        message.setBackgroundColor(p.bgPaper);
        message.setContentDescription("canvas_message");
        stage.addView(message, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(stage, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        UiChrome.applyRootInsets(this, root);
        setTitleText(initialTitle);
    }

    private void setTitleText(String title) {
        titleView.setText(title != null && !title.isEmpty() ? title : t("画布", "Canvas"));
    }

    private void showMessage(String text) {
        message.setText(text);
        message.setVisibility(text == null ? View.GONE : View.VISIBLE);
    }

    private void applyCanvas(JSONObject next) {
        canvas = next;
        setTitleText(next.optString("title"));
        if (markView != null) titleRow.removeView(markView);
        markView = CanvasUi.visibilityMark(this, p, next.optString("visibility"), true);
        markView.setContentDescription("canvas_visibility_" + next.optString("visibility"));
        titleRow.addView(markView);
        shareButton.setEnabled(true);
        shareButton.setAlpha(1f);
    }

    private void load() {
        final int gen = ++generation;
        final String id = canvasId;
        showMessage(t("正在打开画布…", "Opening canvas…"));
        new Thread(() -> {
            try {
                JSONObject meta = HostApiClient.getCanvas(this, id).optJSONObject("canvas");
                String html = HostApiClient.fetchCanvasFrame(this, id, p.dark);
                main.post(() -> {
                    if (gen != generation || isFinishing()) return;
                    if (meta != null) applyCanvas(meta);
                    web.loadDataWithBaseURL("https://canvas.rokbot.invalid/", CanvasModel.withMetaCsp(html), "text/html", "utf-8", null);
                    showMessage(null);
                });
            } catch (HostApiClient.ApiException e) {
                main.post(() -> {
                    if (gen != generation || isFinishing()) return;
                    showMessage(e.statusCode == 404
                            ? t("这个画布已被删除，或者不在当前连接的 Host 上。", "This canvas was deleted or is not on the connected Host.")
                            : t("无法打开画布：", "Could not open the canvas: ") + e.getMessage());
                });
            } catch (Throwable e) {
                main.post(() -> {
                    if (gen != generation || isFinishing()) return;
                    showMessage(t("无法打开画布，请检查与 Host 的连接后点刷新。", "Could not open the canvas. Check the Host connection and tap Refresh."));
                });
            }
        }).start();
    }

    private void share() {
        if (canvas == null) return;
        CanvasShareSheet.show(this, canvas, this::applyCanvas);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            try { web.destroy(); } catch (Throwable ignored) {}
        }
        super.onDestroy();
    }
}

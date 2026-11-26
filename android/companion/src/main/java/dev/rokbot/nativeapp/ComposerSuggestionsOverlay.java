package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.Log;
import android.util.LruCache;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.WeakHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Non-invasive native decor overlay rendering contextual input-box suggestion chips directly above
 * the React Native chat composer. Never mutates the RN Fabric view tree; fetches lazily from
 * POST /local/suggestions with an LRU cache and instant localized static presets as fallback.
 */
final class ComposerSuggestionsOverlay {
    private static final String TAG = "RokBotSuggestions";
    private static final long MIN_SCAN_INTERVAL_MS = 140L;
    private static final int BAR_HEIGHT_DP = 40;
    private static final int MAX_CHIP_WIDTH_DP = 216;

    private static final List<String> FALLBACK_ZH_EMPTY = Arrays.asList(
            "帮我梳理今天的重点事项",
            "帮我润色一段消息回复",
            "给我几个可行的思路和建议",
            "帮我拆解一下接下来的行动步骤"
    );
    private static final List<String> FALLBACK_ZH_ONGOING = Arrays.asList(
            "继续展开说说",
            "总结一下核心要点",
            "给我一个具体例子",
            "下一步应该怎么推进？"
    );
    private static final List<String> FALLBACK_EN_EMPTY = Arrays.asList(
            "Help me prioritize my tasks today",
            "Draft a concise reply for me",
            "Brainstorm a few practical ideas",
            "Break this down into clear next steps"
    );
    private static final List<String> FALLBACK_EN_ONGOING = Arrays.asList(
            "Tell me more about that",
            "Summarize the key points",
            "Give me a concrete example",
            "What should I do next?"
    );

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> new Thread(r, "rokbot-suggestions"));
    private static final WeakHashMap<View, Boolean> HOOKED = new WeakHashMap<>();
    private static final WeakHashMap<EditText, Boolean> WATCHED_INPUTS = new WeakHashMap<>();
    private static final LruCache<String, List<String>> CACHE = new LruCache<>(40);

    private static WeakReference<Activity> sActivity = new WeakReference<>(null);
    private static WeakReference<EditText> sActiveInput = new WeakReference<>(null);
    private static OverlayBar sBar;
    private static boolean sScanScheduled = false;
    private static long sLastScanAt = 0L;

    private static volatile String sObservedAgentId = "";
    private static final AtomicInteger sTurnGeneration = new AtomicInteger(1);
    private static String sLastFetchedKey = "";
    private static String sDismissedKey = "";
    private static List<String> sCurrentSuggestions = new ArrayList<>();

    private static final Runnable SCAN = () -> {
        sScanScheduled = false;
        sLastScanAt = SystemClock.uptimeMillis();
        Activity act = sActivity.get();
        if (act != null && !act.isFinishing() && !act.isDestroyed()) {
            try {
                scan(act);
            } catch (Throwable t) {
                Log.w(TAG, "scan failed: " + t.getClass().getSimpleName());
            }
        }
    };

    private ComposerSuggestionsOverlay() {}

    static void onReactResumed(Activity activity) {
        if (activity == null || activity.getWindow() == null) return;
        sActivity = new WeakReference<>(activity);
        View decor = activity.getWindow().getDecorView();
        if (decor != null && !HOOKED.containsKey(decor)) {
            HOOKED.put(decor, Boolean.TRUE);
            ViewTreeObserver vto = decor.getViewTreeObserver();
            vto.addOnGlobalLayoutListener(() -> scheduleScan(0L));
            vto.addOnDrawListener(() -> scheduleScan(0L));
        }
        scheduleScan(60L);
    }

    static void onReactPaused(Activity activity) {
        MAIN.removeCallbacks(SCAN);
        sScanScheduled = false;
        if (sBar != null) {
            sBar.setVisibility(View.GONE);
        }
    }

    static void notifyAgentActivity(String agentId) {
        if (agentId == null || agentId.isEmpty()) return;
        sObservedAgentId = agentId;
        sTurnGeneration.incrementAndGet();
        MAIN.post(() -> scheduleScan(250L));
    }

    private static void scheduleScan(long delayMs) {
        if (sScanScheduled) return;
        sScanScheduled = true;
        long since = SystemClock.uptimeMillis() - sLastScanAt;
        MAIN.postDelayed(SCAN, Math.max(delayMs, MIN_SCAN_INTERVAL_MS - since));
    }

    private static void scan(Activity act) {
        if (!Storage.isPaired(act)) {
            hideBar();
            return;
        }
        View decor = act.getWindow() != null ? act.getWindow().getDecorView() : null;
        if (!(decor instanceof ViewGroup)) {
            hideBar();
            return;
        }
        if (sBar != null && (sBar.activity != act || !sBar.isAttachedToWindow())) {
            sBar = null;
        }

        EditText composer = findChatComposerInput(act, decor);
        if (composer == null) {
            hideBar();
            return;
        }

        sActiveInput = new WeakReference<>(composer);
        attachTextWatcher(composer);

        CharSequence currentText = composer.getText();
        boolean hasDraft = currentText != null && currentText.toString().replace("\u200B", "").trim().length() > 0;
        if (hasDraft) {
            hideBar();
            return;
        }

        String agentId = resolveActiveAgentId();
        boolean zh = Localize.isChinese(act);
        String key = agentId + ":" + sTurnGeneration.get() + ":" + (zh ? "zh" : "en");
        if (key.equals(sDismissedKey)) {
            hideBar();
            return;
        }

        List<String> cached = CACHE.get(key);
        if (cached != null && !cached.isEmpty()) {
            sCurrentSuggestions = cached;
        } else if (!key.equals(sLastFetchedKey)) {
            sLastFetchedKey = key;
            // Show instant localized fallback immediately so the bar never blocks or flickers empty.
            sCurrentSuggestions = staticPresets(zh, !agentId.isEmpty());
            fetchAsync(act, agentId, key, zh);
        } else if (sCurrentSuggestions.isEmpty()) {
            sCurrentSuggestions = staticPresets(zh, !agentId.isEmpty());
        }

        Rect anchorRect = resolveComposerAnchorRect(act, composer);
        if (anchorRect == null || anchorRect.top < UiChrome.dp(act, 100)) {
            hideBar();
            return;
        }

        showBar(act, (ViewGroup) decor, anchorRect, key, sCurrentSuggestions);
    }

    private static void attachTextWatcher(EditText input) {
        if (WATCHED_INPUTS.containsKey(input)) return;
        WATCHED_INPUTS.put(input, Boolean.TRUE);
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable s) {
                scheduleScan(0L);
            }
        });
    }

    private static String resolveActiveAgentId() {
        String id = RokBotBootstrap.getViewingAgentId();
        if (id == null || id.isEmpty()) id = RokBotBootstrap.getLastAgentId();
        if (id == null || id.isEmpty()) id = sObservedAgentId;
        return id != null ? id : "";
    }

    private static List<String> staticPresets(boolean zh, boolean hasAgent) {
        if (zh) return hasAgent ? FALLBACK_ZH_ONGOING : FALLBACK_ZH_EMPTY;
        return hasAgent ? FALLBACK_EN_ONGOING : FALLBACK_EN_EMPTY;
    }

    private static void fetchAsync(Activity act, String agentId, String key, boolean zh) {
        final Context appCtx = act.getApplicationContext();
        final String locale = zh ? "zh-CN" : Locale.getDefault().toLanguageTag();
        IO.execute(() -> {
            try {
                JSONObject res = HostApiClient.getSuggestions(appCtx, agentId, "", locale);
                JSONArray arr = res != null ? res.optJSONArray("suggestions") : null;
                List<String> items = new ArrayList<>();
                if (arr != null) {
                    for (int i = 0; i < arr.length() && items.size() < 4; i++) {
                        String s = arr.optString(i, "").trim();
                        if (!s.isEmpty() && !"null".equals(s)) {
                            items.add(s);
                        }
                    }
                }
                if (items.size() >= 2) {
                    CACHE.put(key, items);
                    MAIN.post(() -> {
                        if (key.equals(sLastFetchedKey)) {
                            sCurrentSuggestions = items;
                            scheduleScan(0L);
                        }
                    });
                }
            } catch (Throwable ignored) {
                // Keep static fallback silently; never disturb typing or sending.
            }
        });
    }

    /**
     * Finds the chat composer EditText while rejecting search bars and multi-field forms
     * (like Edit Bot or New Bot screens).
     */
    private static EditText findChatComposerInput(Activity act, View root) {
        int screenW = act.getResources().getDisplayMetrics().widthPixels;
        int screenH = act.getResources().getDisplayMetrics().heightPixels;
        float density = Math.max(1f, act.getResources().getDisplayMetrics().density);

        List<EditText> visibleInputs = new ArrayList<>();
        collectVisibleEditTexts(root, visibleInputs);
        // Forms (New Bot / Edit Bot / Settings) have multiple EditTexts; chat screen has exactly 1 composer EditText.
        if (visibleInputs.size() != 1) return null;

        EditText candidate = visibleInputs.get(0);
        if (sBar != null && isDescendantOf(candidate, sBar)) return null;
        if (candidate.getWidth() < Math.round(140f * density)) return null;
        if (candidate.getHeight() <= 0 || candidate.getHeight() > Math.round(180f * density)) return null;

        int[] loc = new int[2];
        candidate.getLocationOnScreen(loc);
        int top = loc[1];
        int bottom = top + candidate.getHeight();
        // Must sit in the lower half of the screen (handles both keyboard-closed and keyboard-open states).
        if (bottom < screenH * 0.42f || top < Math.round(140f * density)) return null;
        if (loc[0] < 0 || loc[0] + candidate.getWidth() > screenW + Math.round(24f * density)) return null;

        // Exclude search inputs by hint text.
        CharSequence hint = candidate.getHint();
        if (hint != null) {
            String h = hint.toString().toLowerCase(Locale.US);
            if (h.contains("search") || h.contains("搜索") || h.contains("搜尋")
                    || h.contains("name") || h.contains("名称") || h.contains("名稱")) {
                return null;
            }
        }
        return candidate;
    }

    private static void collectVisibleEditTexts(View v, List<EditText> out) {
        if (v == null || v.getVisibility() != View.VISIBLE || !v.isShown()) return;
        if (v == sBar) return;
        if (v instanceof EditText) {
            if (v.getWidth() > 0 && v.getHeight() > 0) out.add((EditText) v);
            return;
        }
        if (v instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                collectVisibleEditTexts(vg.getChildAt(i), out);
            }
        }
    }

    private static boolean isDescendantOf(View child, View ancestor) {
        View cur = child;
        while (cur != null) {
            if (cur == ancestor) return true;
            cur = cur.getParent() instanceof View ? (View) cur.getParent() : null;
        }
        return false;
    }

    private static Rect resolveComposerAnchorRect(Activity act, EditText composer) {
        float density = Math.max(1f, act.getResources().getDisplayMetrics().density);
        int[] loc = new int[2];
        composer.getLocationOnScreen(loc);
        Rect best = new Rect(loc[0], loc[1], loc[0] + composer.getWidth(), loc[1] + composer.getHeight());
        // Walk up 1-3 lightweight wrappers to align cleanly above the rounded composer pill.
        View cur = composer;
        for (int i = 0; i < 3; i++) {
            if (!(cur.getParent() instanceof ViewGroup)) break;
            ViewGroup p = (ViewGroup) cur.getParent();
            if (p.getHeight() <= 0 || p.getHeight() > Math.round(130f * density)) break;
            p.getLocationOnScreen(loc);
            best = new Rect(loc[0], loc[1], loc[0] + p.getWidth(), loc[1] + p.getHeight());
            cur = p;
        }
        return best;
    }

    private static void hideBar() {
        if (sBar != null) {
            sBar.setVisibility(View.GONE);
        }
    }

    private static void showBar(Activity act, ViewGroup decor, Rect anchorRect, String key, List<String> suggestions) {
        if (suggestions == null || suggestions.isEmpty()) {
            hideBar();
            return;
        }
        if (sBar == null) {
            sBar = new OverlayBar(act);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, UiChrome.dp(act, BAR_HEIGHT_DP));
            lp.gravity = Gravity.TOP;
            decor.addView(sBar, lp);
        }
        sBar.bind(key, suggestions);

        int[] decorLoc = new int[2];
        decor.getLocationOnScreen(decorLoc);
        int barH = UiChrome.dp(act, BAR_HEIGHT_DP);
        int topMargin = Math.max(UiChrome.dp(act, 64), (anchorRect.top - decorLoc[1]) - barH - UiChrome.dp(act, 6));
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) sBar.getLayoutParams();
        if (lp.topMargin != topMargin) {
            lp.topMargin = topMargin;
            sBar.setLayoutParams(lp);
        }
        sBar.setVisibility(View.VISIBLE);
    }

    private static void fillComposer(String text) {
        EditText target = sActiveInput.get();
        if (target == null || !target.isAttachedToWindow()) return;
        try {
            target.requestFocus();
            target.setText(text);
            target.setSelection(text.length());
            hideBar();
        } catch (Throwable t) {
            Log.w(TAG, "fillComposer failed: " + t.getClass().getSimpleName());
        }
    }

    private static final class OverlayBar extends LinearLayout {
        final Activity activity;
        private final LinearLayout chipsRow;
        private final SparkleIconView iconView;
        private final CloseIconView closeBtn;
        private String boundSignature = "";
        private String activeKey = "";

        OverlayBar(Activity act) {
            super(act);
            this.activity = act;
            setOrientation(HORIZONTAL);
            setGravity(Gravity.CENTER_VERTICAL);
            setContentDescription("composer_suggestions_bar");
            setPadding(UiChrome.dp(act, 10), UiChrome.dp(act, 2), UiChrome.dp(act, 8), UiChrome.dp(act, 2));
            setElevation(UiChrome.dp(act, 4));

            iconView = new SparkleIconView(act);
            int iconSz = UiChrome.dp(act, 22);
            LayoutParams iconLp = new LayoutParams(iconSz, iconSz);
            iconLp.rightMargin = UiChrome.dp(act, 4);
            addView(iconView, iconLp);

            HorizontalScrollView hsv = new HorizontalScrollView(act);
            hsv.setHorizontalScrollBarEnabled(false);
            hsv.setOverScrollMode(OVER_SCROLL_NEVER);
            LayoutParams hsvLp = new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            addView(hsv, hsvLp);

            chipsRow = new LinearLayout(act);
            chipsRow.setOrientation(HORIZONTAL);
            chipsRow.setGravity(Gravity.CENTER_VERTICAL);
            hsv.addView(chipsRow, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            closeBtn = new CloseIconView(act);
            closeBtn.setContentDescription(Localize.t(act, "隐藏输入建议", "Dismiss suggestions"));
            int closeSz = UiChrome.dp(act, 28);
            LayoutParams closeLp = new LayoutParams(closeSz, closeSz);
            closeLp.leftMargin = UiChrome.dp(act, 4);
            closeBtn.setOnClickListener(v -> {
                sDismissedKey = activeKey;
                hideBar();
            });
            addView(closeBtn, closeLp);
        }

        void bind(String key, List<String> suggestions) {
            this.activeKey = key;
            UiChrome.Palette p = UiChrome.palette(activity);
            String sig = (p.dark ? "D:" : "L:") + TextUtils.join("\u001f", suggestions);
            if (sig.equals(boundSignature)) return;
            boundSignature = sig;

            iconView.setStrokeColor(p.textSecondary);
            closeBtn.setStrokeColor(p.textSecondary);
            chipsRow.removeAllViews();

            for (int i = 0; i < suggestions.size(); i++) {
                final String text = suggestions.get(i);
                TextView chip = new TextView(activity);
                chip.setText(text);
                chip.setContentDescription("suggestion_chip_" + i);
                chip.setTextColor(p.textPrimary);
                chip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
                chip.setSingleLine(true);
                chip.setEllipsize(TextUtils.TruncateAt.END);
                chip.setMaxWidth(UiChrome.dp(activity, MAX_CHIP_WIDTH_DP));
                chip.setPadding(UiChrome.dp(activity, 12), UiChrome.dp(activity, 6),
                        UiChrome.dp(activity, 12), UiChrome.dp(activity, 6));

                GradientDrawable bg = new GradientDrawable();
                bg.setColor(p.dark ? 0xEB26262C : 0xF5FFFFFF);
                bg.setCornerRadius(UiChrome.dp(activity, 16));
                bg.setStroke(Math.max(1, UiChrome.dp(activity, 0.75f)), p.border);
                chip.setBackground(bg);

                LayoutParams clp = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                if (i > 0) clp.leftMargin = UiChrome.dp(activity, 6);
                chip.setLayoutParams(clp);
                chip.setOnClickListener(v -> fillComposer(text));
                chipsRow.addView(chip);
            }
        }
    }

    /** Crisp vector four-point sparkle icon (zero emoji). */
    private static final class SparkleIconView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();

        SparkleIconView(Context ctx) {
            super(ctx);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            paint.setStrokeWidth(UiChrome.dp(ctx, 1.5f));
        }

        void setStrokeColor(int color) {
            paint.setColor(color);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight();
            float cx = w * 0.45f, cy = h * 0.50f, r = Math.min(w, h) * 0.34f;
            path.reset();
            path.moveTo(cx, cy - r);
            path.quadTo(cx, cy, cx + r, cy);
            path.quadTo(cx, cy, cx, cy + r);
            path.quadTo(cx, cy, cx - r, cy);
            path.quadTo(cx, cy, cx, cy - r);
            path.close();
            canvas.drawPath(path, paint);

            float sx = w * 0.80f, sy = h * 0.24f, sr = Math.min(w, h) * 0.12f;
            canvas.drawLine(sx, sy - sr, sx, sy + sr, paint);
            canvas.drawLine(sx - sr, sy, sx + sr, sy, paint);
        }
    }

    /** Crisp vector close icon for dismissing suggestions. */
    private static final class CloseIconView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        CloseIconView(Context ctx) {
            super(ctx);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeWidth(UiChrome.dp(ctx, 1.6f));
        }

        void setStrokeColor(int color) {
            paint.setColor(color);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight();
            float pad = Math.min(w, h) * 0.32f;
            canvas.drawLine(pad, pad, w - pad, h - pad, paint);
            canvas.drawLine(w - pad, pad, pad, h - pad, paint);
        }
    }
}

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
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Non-invasive native decor overlay rendering focus-activated input-box suggestion pills directly
 * above the React Native chat composer. Never mutates the RN Fabric view tree.
 *
 * Behavior:
 * - Activates ONLY while the chat composer EditText has focus (e.g. keyboard open) and is empty.
 * - Hides immediately when focus is lost or the user begins typing.
 * - Respects Host-synced settings (enabled, aiEnabled, quickPhrases) with zero static presets.
 * - Shows custom quick phrases first (vector bolt icon) and AI suggestions second (vector sparkle
 *   icon), with distinct pill styling.
 * - Tapping any pill fills the composer and triggers immediate send.
 */
final class ComposerSuggestionsOverlay {
    private static final String TAG = "RokBotSuggestions";
    private static final long MIN_SCAN_INTERVAL_MS = 120L;
    private static final long SETTINGS_TTL_MS = 15_000L;
    private static final int BAR_HEIGHT_DP = 42;
    private static final int MAX_CHIP_WIDTH_DP = 220;

    static final class SuggestionItem {
        final String type; // "phrase" or "ai"
        final String text;

        SuggestionItem(String type, String text) {
            this.type = type;
            this.text = text;
        }
    }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> new Thread(r, "rokbot-suggestions"));
    private static final WeakHashMap<View, Boolean> HOOKED = new WeakHashMap<>();
    private static final WeakHashMap<EditText, Boolean> WATCHED_INPUTS = new WeakHashMap<>();
    private static final LruCache<String, List<String>> AI_CACHE = new LruCache<>(40);

    private static WeakReference<Activity> sActivity = new WeakReference<>(null);
    private static WeakReference<EditText> sActiveInput = new WeakReference<>(null);
    private static OverlayBar sBar;
    private static boolean sScanScheduled = false;
    private static long sLastScanAt = 0L;

    private static volatile String sObservedAgentId = "";
    private static final AtomicInteger sTurnGeneration = new AtomicInteger(1);
    private static String sLastFetchedKey = "";
    private static String sDismissedKey = "";
    private static List<String> sCurrentAiSuggestions = new ArrayList<>();

    // Synced settings state (defaults: enabled=true, aiEnabled=true, quickPhrases=[])
    private static volatile boolean sSettingsEnabled = true;
    private static volatile boolean sSettingsAiEnabled = true;
    private static volatile List<String> sQuickPhrases = Collections.emptyList();
    private static volatile long sSettingsSyncedAt = 0L;
    private static final AtomicBoolean sSettingsLoading = new AtomicBoolean(false);

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
            vto.addOnGlobalFocusChangeListener((oldFocus, newFocus) -> scheduleScan(0L));
        }
        if (Storage.isPaired(activity)) {
            syncSettingsAsync(activity.getApplicationContext(), false);
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
        MAIN.post(() -> scheduleScan(200L));
    }

    static void invalidateSettingsCache() {
        sSettingsSyncedAt = 0L;
        sLastFetchedKey = "";
        sDismissedKey = "";
        Activity act = sActivity.get();
        if (act != null && !act.isFinishing() && !act.isDestroyed() && Storage.isPaired(act)) {
            syncSettingsAsync(act.getApplicationContext(), true);
        }
        MAIN.post(() -> scheduleScan(0L));
    }

    private static void scheduleScan(long delayMs) {
        if (sScanScheduled) return;
        sScanScheduled = true;
        long since = SystemClock.uptimeMillis() - sLastScanAt;
        MAIN.postDelayed(SCAN, Math.max(delayMs, MIN_SCAN_INTERVAL_MS - since));
    }

    private static void syncSettingsAsync(Context appCtx, boolean force) {
        long now = SystemClock.uptimeMillis();
        if (!force && sSettingsSyncedAt > 0L && now - sSettingsSyncedAt < SETTINGS_TTL_MS) return;
        if (!sSettingsLoading.compareAndSet(false, true)) return;
        IO.execute(() -> {
            try {
                JSONObject res = HostApiClient.getSuggestionsSettings(appCtx);
                applySettingsJson(res);
                MAIN.post(() -> scheduleScan(0L));
            } catch (Throwable ignored) {
                // Keep last known settings silently.
            } finally {
                sSettingsLoading.set(false);
            }
        });
    }

    private static void applySettingsJson(JSONObject res) {
        if (res == null) return;
        if (res.has("enabled")) {
            sSettingsEnabled = res.optBoolean("enabled", true);
        }
        if (res.has("aiEnabled")) {
            sSettingsAiEnabled = res.optBoolean("aiEnabled", true);
        }
        JSONArray phrasesArr = res.optJSONArray("quickPhrases");
        if (phrasesArr != null) {
            List<String> list = new ArrayList<>();
            for (int i = 0; i < phrasesArr.length(); i++) {
                JSONObject obj = phrasesArr.optJSONObject(i);
                String text = obj != null ? obj.optString("text", "").trim() : phrasesArr.optString(i, "").trim();
                if (!text.isEmpty() && !"null".equals(text)) {
                    list.add(text);
                }
            }
            sQuickPhrases = Collections.unmodifiableList(list);
        }
        sSettingsSyncedAt = SystemClock.uptimeMillis();
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
        if (BotProfileModelOverlay.isShowing() || SettingsSuggestionsOverlay.isShowing()) {
            hideBar();
            return;
        }

        EditText composer = findChatComposerInput(act, decor);
        if (composer == null) {
            hideBar();
            return;
        }

        sActiveInput = new WeakReference<>(composer);
        attachTextWatcher(composer);

        // Activate ONLY when the composer input currently holds focus.
        boolean focused = composer.hasFocus() || act.getCurrentFocus() == composer;
        if (!focused) {
            hideBar();
            return;
        }

        CharSequence currentText = composer.getText();
        boolean hasDraft = currentText != null && currentText.toString().replace("\u200B", "").trim().length() > 0;
        if (hasDraft) {
            hideBar();
            return;
        }

        // Refresh settings in background if TTL expired.
        syncSettingsAsync(act.getApplicationContext(), false);

        if (!sSettingsEnabled) {
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

        if (sSettingsAiEnabled) {
            List<String> cached = AI_CACHE.get(key);
            if (cached != null) {
                sCurrentAiSuggestions = cached;
            } else if (!key.equals(sLastFetchedKey)) {
                sLastFetchedKey = key;
                sCurrentAiSuggestions = Collections.emptyList();
                fetchAsync(act, agentId, key, zh);
            }
        } else {
            sCurrentAiSuggestions = Collections.emptyList();
        }

        List<SuggestionItem> merged = mergeItems(sQuickPhrases, sSettingsAiEnabled ? sCurrentAiSuggestions : Collections.emptyList());
        if (merged.isEmpty()) {
            hideBar();
            return;
        }

        Rect anchorRect = resolveComposerAnchorRect(act, composer);
        if (anchorRect == null || anchorRect.top < UiChrome.dp(act, 60)) {
            hideBar();
            return;
        }

        showBar(act, (ViewGroup) decor, anchorRect, key, merged);
    }

    private static List<SuggestionItem> mergeItems(List<String> phrases, List<String> ai) {
        List<SuggestionItem> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        if (phrases != null) {
            for (String p : phrases) {
                if (p == null) continue;
                String trimmed = p.trim();
                if (trimmed.isEmpty()) continue;
                String k = trimmed.toLowerCase(Locale.ROOT);
                if (seen.add(k)) {
                    out.add(new SuggestionItem("phrase", trimmed));
                }
            }
        }
        if (ai != null) {
            for (String s : ai) {
                if (s == null) continue;
                String trimmed = s.trim();
                if (trimmed.isEmpty()) continue;
                String k = trimmed.toLowerCase(Locale.ROOT);
                if (seen.add(k)) {
                    out.add(new SuggestionItem("ai", trimmed));
                }
            }
        }
        return out;
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

    private static void fetchAsync(Activity act, String agentId, String key, boolean zh) {
        final Context appCtx = act.getApplicationContext();
        final String locale = zh ? "zh-CN" : Locale.getDefault().toLanguageTag();
        IO.execute(() -> {
            try {
                JSONObject res = HostApiClient.getSuggestions(appCtx, agentId, "", locale);
                if (res == null) return;
                applySettingsJson(res);
                String source = res.optString("source", "");
                JSONArray arr = res.optJSONArray("aiSuggestions");
                List<String> aiItems = new ArrayList<>();
                if ("model".equals(source) && arr != null) {
                    for (int i = 0; i < arr.length() && aiItems.size() < 4; i++) {
                        String s = arr.optString(i, "").trim();
                        if (!s.isEmpty() && !"null".equals(s)) {
                            aiItems.add(s);
                        }
                    }
                }
                if (!aiItems.isEmpty()) {
                    AI_CACHE.put(key, Collections.unmodifiableList(aiItems));
                }
                MAIN.post(() -> {
                    if (key.equals(sLastFetchedKey)) {
                        sCurrentAiSuggestions = aiItems;
                        scheduleScan(0L);
                    }
                });
            } catch (Throwable ignored) {
                // Silent failure: never fall back to static presets; custom quick phrases stay visible.
                MAIN.post(() -> {
                    if (key.equals(sLastFetchedKey)) {
                        sCurrentAiSuggestions = Collections.emptyList();
                        scheduleScan(0L);
                    }
                });
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
        if (visibleInputs.size() != 1) return null;

        EditText candidate = visibleInputs.get(0);
        if (sBar != null && isDescendantOf(candidate, sBar)) return null;
        if (candidate.getWidth() < Math.round(120f * density)) return null;
        if (candidate.getHeight() <= 0 || candidate.getHeight() > Math.round(180f * density)) return null;

        int[] loc = new int[2];
        candidate.getLocationOnScreen(loc);
        int top = loc[1];
        int bottom = top + candidate.getHeight();
        // Allows both keyboard-closed (bottom) and keyboard-open (mid-screen) positions.
        if (bottom < screenH * 0.25f || top < Math.round(100f * density)) return null;
        if (loc[0] < 0 || loc[0] + candidate.getWidth() > screenW + Math.round(24f * density)) return null;

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

    private static void showBar(Activity act, ViewGroup decor, Rect anchorRect, String key, List<SuggestionItem> items) {
        if (items == null || items.isEmpty()) {
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
        sBar.bind(key, items);

        int[] decorLoc = new int[2];
        decor.getLocationOnScreen(decorLoc);
        int barH = UiChrome.dp(act, BAR_HEIGHT_DP);
        int topMargin = Math.max(UiChrome.dp(act, 48), (anchorRect.top - decorLoc[1]) - barH - UiChrome.dp(act, 6));
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) sBar.getLayoutParams();
        if (lp.topMargin != topMargin) {
            lp.topMargin = topMargin;
            sBar.setLayoutParams(lp);
        }
        sBar.setVisibility(View.VISIBLE);
    }

    /**
     * Fills the composer with the tapped suggestion and immediately triggers send on the RN composer.
     */
    private static void sendSuggestion(Activity act, String text) {
        EditText target = sActiveInput.get();
        if (target == null || !target.isAttachedToWindow()) return;
        try {
            hideBar();
            target.requestFocus();
            target.setText(text);
            target.setSelection(text.length());
            triggerSendWithRetry(act, target, 0);
        } catch (Throwable t) {
            Log.w(TAG, "sendSuggestion failed: " + t.getClass().getSimpleName());
        }
    }

    private static void triggerSendWithRetry(Activity act, EditText target, int attempt) {
        MAIN.postDelayed(() -> {
            if (act == null || act.isFinishing() || act.isDestroyed() || !target.isAttachedToWindow()) return;
            View decor = act.getWindow() != null ? act.getWindow().getDecorView() : null;
            View sendBtn = decor != null ? findComposerSendButton(act, decor, target) : null;
            if (sendBtn != null && sendBtn.isEnabled()) {
                sendBtn.performClick();
                return;
            }
            if (attempt < 4) {
                triggerSendWithRetry(act, target, attempt + 1);
                return;
            }
            // Fallback: trigger IME send action / Enter key on the EditText.
            try {
                target.onEditorAction(EditorInfo.IME_ACTION_SEND);
            } catch (Throwable ignored) {}
            try {
                target.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER));
                target.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER));
            } catch (Throwable ignored) {}
        }, attempt == 0 ? 75L : 90L);
    }

    /**
     * Locates the React Native send button adjacent to the composer EditText by accessibility
     * description first, then falling back to the rightmost clickable button aligned with the composer.
     */
    private static View findComposerSendButton(Activity act, View root, EditText composer) {
        float density = Math.max(1f, act.getResources().getDisplayMetrics().density);
        int[] cLoc = new int[2];
        composer.getLocationOnScreen(cLoc);
        int cTop = cLoc[1] - UiChrome.dp(act, 24);
        int cBottom = cLoc[1] + composer.getHeight() + UiChrome.dp(act, 24);
        int cRightMin = cLoc[0] + composer.getWidth() / 2;

        View[] labeledMatch = new View[1];
        View[] rightMostClickable = new View[1];
        int[] rightMostX = new int[] { -1 };
        int maxBtnSize = Math.round(72f * density);
        int minBtnSize = Math.round(22f * density);
        int[] vLoc = new int[2];

        scanForSendButton(root, composer, cTop, cBottom, cRightMin, minBtnSize, maxBtnSize, vLoc, labeledMatch, rightMostClickable, rightMostX, 0);
        return labeledMatch[0] != null ? labeledMatch[0] : rightMostClickable[0];
    }

    private static void scanForSendButton(View v, EditText composer, int cTop, int cBottom, int cRightMin,
                                          int minSize, int maxSize, int[] vLoc,
                                          View[] labeledMatch, View[] rightMostClickable, int[] rightMostX, int depth) {
        if (v == null || depth > 80 || v.getVisibility() != View.VISIBLE || !v.isShown()) return;
        if (v == sBar || v == composer) return;

        int w = v.getWidth(), h = v.getHeight();
        if (w >= minSize && h >= minSize && w <= maxSize && h <= maxSize && v.isClickable() && v.isEnabled()) {
            v.getLocationOnScreen(vLoc);
            int cy = vLoc[1] + h / 2;
            if (cy >= cTop && cy <= cBottom && vLoc[0] >= cRightMin) {
                CharSequence cd = v.getContentDescription();
                String desc = cd != null ? cd.toString().toLowerCase(Locale.US) : "";
                boolean isNonSend = desc.contains("attach") || desc.contains("plus") || desc.contains("add")
                        || desc.contains("mic") || desc.contains("voice") || desc.contains("audio")
                        || desc.contains("stop") || desc.contains("停止") || desc.contains("语音") || desc.contains("附件");
                boolean isSendDesc = desc.contains("send") || desc.contains("发送") || desc.contains("傳送");
                if (isSendDesc) {
                    labeledMatch[0] = v;
                } else if (!isNonSend && vLoc[0] > rightMostX[0]) {
                    rightMostX[0] = vLoc[0];
                    rightMostClickable[0] = v;
                }
            }
        }
        if (v instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                scanForSendButton(vg.getChildAt(i), composer, cTop, cBottom, cRightMin,
                        minSize, maxSize, vLoc, labeledMatch, rightMostClickable, rightMostX, depth + 1);
            }
        }
    }

    private static final class OverlayBar extends LinearLayout {
        final Activity activity;
        private final LinearLayout chipsRow;
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

        void bind(String key, List<SuggestionItem> items) {
            this.activeKey = key;
            UiChrome.Palette p = UiChrome.palette(activity);
            StringBuilder sb = new StringBuilder(p.dark ? "D:" : "L:");
            for (SuggestionItem item : items) {
                sb.append(item.type).append('=').append(item.text).append('\u001f');
            }
            String sig = sb.toString();
            if (sig.equals(boundSignature)) return;
            boundSignature = sig;

            closeBtn.setStrokeColor(p.textSecondary);
            chipsRow.removeAllViews();

            for (int i = 0; i < items.size(); i++) {
                final SuggestionItem item = items.get(i);
                final boolean isPhrase = "phrase".equals(item.type);

                LinearLayout pill = new LinearLayout(activity);
                pill.setOrientation(HORIZONTAL);
                pill.setGravity(Gravity.CENTER_VERTICAL);
                pill.setContentDescription("suggestion_chip_" + item.type + "_" + i);
                pill.setPadding(UiChrome.dp(activity, 10), UiChrome.dp(activity, 6),
                        UiChrome.dp(activity, 12), UiChrome.dp(activity, 6));

                GradientDrawable bg = new GradientDrawable();
                if (isPhrase) {
                    bg.setColor(p.dark ? 0xEB1D2B42 : 0xF5EEF5FF);
                    bg.setStroke(Math.max(1, UiChrome.dp(activity, 0.9f)), p.dark ? 0x993B82F6 : 0x661677FF);
                } else {
                    bg.setColor(p.dark ? 0xEB26262C : 0xF5FFFFFF);
                    bg.setStroke(Math.max(1, UiChrome.dp(activity, 0.75f)), p.border);
                }
                bg.setCornerRadius(UiChrome.dp(activity, 16));
                pill.setBackground(bg);

                int iconSz = UiChrome.dp(activity, 14);
                View iconView;
                if (isPhrase) {
                    PhraseIconView pv = new PhraseIconView(activity);
                    pv.setStrokeColor(p.blueAccent);
                    iconView = pv;
                } else {
                    SparkleIconView sv = new SparkleIconView(activity);
                    sv.setStrokeColor(p.textSecondary);
                    iconView = sv;
                }
                LayoutParams ilp = new LayoutParams(iconSz, iconSz);
                ilp.rightMargin = UiChrome.dp(activity, 5);
                pill.addView(iconView, ilp);

                TextView label = new TextView(activity);
                label.setText(item.text);
                label.setTextColor(p.textPrimary);
                label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
                label.setSingleLine(true);
                label.setEllipsize(TextUtils.TruncateAt.END);
                label.setMaxWidth(UiChrome.dp(activity, MAX_CHIP_WIDTH_DP));
                pill.addView(label);

                LayoutParams clp = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                if (i > 0) clp.leftMargin = UiChrome.dp(activity, 6);
                pill.setLayoutParams(clp);
                pill.setOnClickListener(v -> sendSuggestion(activity, item.text));
                chipsRow.addView(pill);
            }
        }
    }

    /** Crisp vector lightning-bolt icon for custom quick phrases (zero emoji). */
    static final class PhraseIconView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();

        PhraseIconView(Context ctx) {
            super(ctx);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            paint.setStrokeWidth(UiChrome.dp(ctx, 1.4f));
        }

        void setStrokeColor(int color) {
            paint.setColor(color);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight();
            path.reset();
            path.moveTo(w * 0.56f, h * 0.10f);
            path.lineTo(w * 0.20f, h * 0.56f);
            path.lineTo(w * 0.48f, h * 0.56f);
            path.lineTo(w * 0.44f, h * 0.90f);
            path.lineTo(w * 0.80f, h * 0.44f);
            path.lineTo(w * 0.52f, h * 0.44f);
            path.close();
            canvas.drawPath(path, paint);
        }
    }

    /** Crisp vector four-point sparkle icon for AI suggestions (zero emoji). */
    static final class SparkleIconView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();

        SparkleIconView(Context ctx) {
            super(ctx);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            paint.setStrokeWidth(UiChrome.dp(ctx, 1.4f));
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

package dev.rokbot.nativeapp;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.Editable;
import android.text.Layout;
import android.text.TextPaint;
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
import android.view.animation.LinearInterpolator;
import android.view.inputmethod.BaseInputConnection;
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
 * Non-invasive native decor overlay above the React Native chat composer. Never mutates the RN
 * Fabric view tree except by setting the composer text the way a user would.
 *
 * Suggestions bar (empty composer):
 * - Activates ONLY while the chat composer EditText has focus (e.g. keyboard open) and is empty.
 * - Respects Host-synced settings (enabled, aiEnabled, quickPhrases) with zero static presets.
 * - Custom quick phrases first (vector bolt icon), AI suggestions second (vector sparkle icon).
 * - While AI suggestions load (chat with history), shimmer placeholder pills stand in for them
 *   ({@link SuggestionLoadState}); they cross-fade into the real chips, or fade out silently on
 *   failure. With "Remove animations" the placeholders are static and nothing fades.
 * - Tapping any pill fills the composer and triggers immediate send.
 *
 * Inline completion (draft in the composer, {@link InlineCompletionEngine}):
 * - Debounced POST /local/suggestions/complete while typing (completionEnabled, draft of 2+
 *   characters, chat with history, no IME composition, cursor at the end); stale requests are
 *   disconnected and ignored, answers are cached per (chat, draft).
 * - The predicted suffix is drawn in gray right after the cursor inside the input, plus a
 *   "补全 / Complete" pill above the keyboard; tapping either appends it to the draft.
 * - Hidden when the composer loses focus.
 */
final class ComposerSuggestionsOverlay {
    private static final String TAG = "RokBotSuggestions";
    private static final long MIN_SCAN_INTERVAL_MS = 120L;
    private static final long SETTINGS_TTL_MS = 15_000L;
    private static final int BAR_HEIGHT_DP = 42;
    private static final int MAX_CHIP_WIDTH_DP = 220;
    private static final int CHIP_HEIGHT_DP = 30;
    private static final long CHIP_FADE_IN_MS = 200L;
    private static final long CHIP_STAGGER_MS = 45L;
    private static final long SHIMMER_PERIOD_MS = 1250L;

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
    private static final ExecutorService COMPLETION_IO = Executors.newSingleThreadExecutor(r -> new Thread(r, "rokbot-completion"));
    private static final ExecutorService CANCEL_IO = Executors.newSingleThreadExecutor(r -> new Thread(r, "rokbot-completion-cancel"));
    private static final WeakHashMap<View, Boolean> HOOKED = new WeakHashMap<>();
    private static final WeakHashMap<EditText, Boolean> WATCHED_INPUTS = new WeakHashMap<>();
    private static final LruCache<String, List<String>> AI_CACHE = new LruCache<>(40);

    static final ChatHistoryHints HISTORY = new ChatHistoryHints();
    static final SuggestionLoadState LOAD_STATE = new SuggestionLoadState();
    static final InlineCompletionEngine COMPLETION = new InlineCompletionEngine(HISTORY);

    private static WeakReference<Activity> sActivity = new WeakReference<>(null);
    private static WeakReference<EditText> sActiveInput = new WeakReference<>(null);
    private static OverlayBar sBar;
    private static CompletionPill sPill;
    private static GhostTextView sGhost;
    private static boolean sScanScheduled = false;
    private static long sLastScanAt = 0L;

    private static volatile String sObservedAgentId = "";
    private static final AtomicInteger sTurnGeneration = new AtomicInteger(1);
    private static String sLastFetchedKey = "";
    private static String sDismissedKey = "";

    // Completion state observed on the main thread.
    private static String sShownSuffix = "";
    private static String sLastObserved = "";
    private static HostApiClient.CancelHandle sCompletionHandle;

    // Synced settings state (defaults: enabled=true, aiEnabled=true, completionEnabled=true, quickPhrases=[])
    private static volatile boolean sSettingsEnabled = true;
    private static volatile boolean sSettingsAiEnabled = true;
    private static volatile boolean sSettingsCompletionEnabled = true;
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

    private static final Runnable COMPLETION_POLL = ComposerSuggestionsOverlay::pollCompletion;

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
        hideBar();
        clearCompletion();
    }

    static void notifyAgentActivity(String agentId) {
        if (agentId == null || agentId.isEmpty()) return;
        sObservedAgentId = agentId;
        sTurnGeneration.incrementAndGet();
        HISTORY.forget(agentId);
        COMPLETION.clearCache();
        MAIN.post(() -> scheduleScan(200L));
    }

    static void invalidateSettingsCache() {
        sSettingsSyncedAt = 0L;
        sLastFetchedKey = "";
        sDismissedKey = "";
        MAIN.post(() -> {
            LOAD_STATE.cancel();
            clearCompletion();
        });
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
        if (res.has("completionEnabled")) {
            sSettingsCompletionEnabled = res.optBoolean("completionEnabled", true);
            COMPLETION.setEnabled(sSettingsCompletionEnabled);
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

    /** "Remove animations" (developer options / accessibility) turns every animation off. */
    static boolean animationsEnabled(Context ctx) {
        try {
            if (!ValueAnimator.areAnimatorsEnabled()) return false;
        } catch (Throwable ignored) {
        }
        try {
            return Settings.Global.getFloat(ctx.getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f;
        } catch (Throwable ignored) {
            return true;
        }
    }

    private static void scan(Activity act) {
        if (!Storage.isPaired(act)) {
            hideBar();
            clearCompletion();
            return;
        }
        View decor = act.getWindow() != null ? act.getWindow().getDecorView() : null;
        if (!(decor instanceof ViewGroup)) {
            hideBar();
            clearCompletion();
            return;
        }
        if (sBar != null && (sBar.activity != act || !sBar.isAttachedToWindow())) {
            sBar = null;
        }
        if (sPill != null && (sPill.activity != act || !sPill.isAttachedToWindow())) {
            sPill = null;
        }
        if (sGhost != null && (sGhost.activity != act || !sGhost.isAttachedToWindow())) {
            sGhost = null;
        }
        if (BotProfileModelOverlay.isShowing()) {
            hideBar();
            clearCompletion();
            return;
        }

        EditText composer = findChatComposerInput(act, decor);
        if (composer == null) {
            hideBar();
            clearCompletion();
            return;
        }

        sActiveInput = new WeakReference<>(composer);
        attachTextWatcher(composer);

        // Activate ONLY when the composer input currently holds focus.
        boolean focused = composer.hasFocus() || act.getCurrentFocus() == composer;
        if (!focused) {
            hideBar();
            clearCompletion();
            return;
        }

        // Refresh settings in background if TTL expired.
        syncSettingsAsync(act.getApplicationContext(), false);

        CharSequence currentText = composer.getText();
        boolean hasDraft = currentText != null && currentText.toString().replace("​", "").trim().length() > 0;
        if (hasDraft) {
            hideBar();
            observeComposer(composer);
            Rect anchorRect = resolveComposerAnchorRect(act, composer);
            renderCompletion(act, (ViewGroup) decor, composer, anchorRect);
            return;
        }
        clearCompletion();

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

        long now = SystemClock.uptimeMillis();
        List<String> ai = Collections.emptyList();
        int placeholders = 0;
        if (sSettingsAiEnabled) {
            List<String> cached = AI_CACHE.get(key);
            if (cached != null) {
                if (!key.equals(LOAD_STATE.key()) || LOAD_STATE.phase() != SuggestionLoadState.Phase.READY) {
                    LOAD_STATE.ready(key, cached);
                }
                ai = cached;
            } else if (!key.equals(sLastFetchedKey)) {
                sLastFetchedKey = key;
                int token = LOAD_STATE.begin(key, now);
                fetchAsync(act, agentId, key, zh, token);
            }
            if (key.equals(LOAD_STATE.key())) {
                if (LOAD_STATE.phase() == SuggestionLoadState.Phase.READY) ai = LOAD_STATE.items();
                if (HISTORY.mayHaveHistory(agentId)) {
                    placeholders = LOAD_STATE.placeholdersAt(now);
                    long left = LOAD_STATE.placeholderDelayLeft(now);
                    if (left > 0L) MAIN.postDelayed(() -> scheduleScan(0L), left + 5L);
                }
            }
        } else if (LOAD_STATE.phase() != SuggestionLoadState.Phase.IDLE) {
            LOAD_STATE.cancel();
        }

        List<SuggestionItem> merged = mergeItems(sQuickPhrases, ai);
        boolean fading = sBar != null && sBar.getVisibility() == View.VISIBLE && LOAD_STATE.isFadingOut()
                && key.equals(LOAD_STATE.key());
        if (merged.isEmpty() && placeholders == 0 && !fading) {
            hideBar();
            return;
        }

        Rect anchorRect = resolveComposerAnchorRect(act, composer);
        if (anchorRect == null || anchorRect.top < UiChrome.dp(act, 60)) {
            hideBar();
            return;
        }

        showBar(act, (ViewGroup) decor, anchorRect, key, merged, placeholders);
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
                // Layout of the EditText is current on the next frame: re-observe there.
                MAIN.post(() -> {
                    if (input.isAttachedToWindow() && input == sActiveInput.get() && input.hasFocus()) {
                        observeComposer(input);
                        Activity act = sActivity.get();
                        View decor = act != null && act.getWindow() != null ? act.getWindow().getDecorView() : null;
                        if (decor instanceof ViewGroup && input.length() > 0) {
                            renderCompletion(act, (ViewGroup) decor, input, resolveComposerAnchorRect(act, input));
                        }
                    }
                });
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

    private static void fetchAsync(Activity act, String agentId, String key, boolean zh, int token) {
        final Context appCtx = act.getApplicationContext();
        final String locale = zh ? "zh-CN" : Locale.getDefault().toLanguageTag();
        IO.execute(() -> {
            try {
                JSONObject res = HostApiClient.getSuggestions(appCtx, agentId, "", locale);
                if (res == null) throw new IllegalStateException("empty response");
                applySettingsJson(res);
                String source = res.optString("source", "");
                HISTORY.record(agentId, source);
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
                    if (LOAD_STATE.succeed(token, aiItems)) onLoadSettled(token);
                });
            } catch (Throwable ignored) {
                // Silent failure: placeholders fade out; custom quick phrases stay visible.
                MAIN.post(() -> {
                    if (LOAD_STATE.fail(token)) onLoadSettled(token);
                });
            }
        });
    }

    /** After READY / FAILED: re-render; FAILED returns to IDLE once the placeholders faded out. */
    private static void onLoadSettled(int token) {
        scheduleScan(0L);
        if (LOAD_STATE.isFadingOut()) {
            Activity act = sActivity.get();
            long fade = act != null && animationsEnabled(act) ? SuggestionLoadState.FADE_OUT_MS : 0L;
            MAIN.postDelayed(() -> {
                if (LOAD_STATE.settle(token)) scheduleScan(0L);
            }, fade + 20L);
        }
    }

    // ---- Inline completion ------------------------------------------------------------------

    static boolean isComposing(CharSequence text) {
        if (!(text instanceof android.text.Spannable)) return false;
        android.text.Spannable sp = (android.text.Spannable) text;
        return BaseInputConnection.getComposingSpanStart(sp) != -1
                || BaseInputConnection.getComposingSpanEnd(sp) != -1;
    }

    /** Feeds the composer's current draft / composition / cursor into the engine (deduplicated). */
    private static void observeComposer(EditText composer) {
        Editable text = composer.getText();
        String draft = text != null ? text.toString() : "";
        boolean composing = isComposing(text);
        int selStart = composer.getSelectionStart();
        int selEnd = composer.getSelectionEnd();
        boolean cursorAtEnd = selStart == selEnd && selEnd == draft.length();
        String agentId = resolveActiveAgentId();
        String sig = agentId + '\u0001' + draft + '\u0001' + composing + '\u0001' + cursorAtEnd + '\u0001'
                + sSettingsCompletionEnabled;
        if (sig.equals(sLastObserved)) return;
        sLastObserved = sig;
        COMPLETION.setEnabled(sSettingsCompletionEnabled);
        int seqBefore = COMPLETION.sequence();
        sShownSuffix = COMPLETION.onDraftChanged(agentId, draft, composing, cursorAtEnd, SystemClock.uptimeMillis());
        if (COMPLETION.sequence() != seqBefore) cancelInFlightCompletion();
        MAIN.removeCallbacks(COMPLETION_POLL);
        if (COMPLETION.hasPending()) {
            MAIN.postDelayed(COMPLETION_POLL, Math.max(0L, COMPLETION.dueAt() - SystemClock.uptimeMillis()));
        }
    }

    private static void cancelInFlightCompletion() {
        HostApiClient.CancelHandle handle = sCompletionHandle;
        sCompletionHandle = null;
        if (handle != null) CANCEL_IO.execute(handle::cancel);
    }

    private static void pollCompletion() {
        long now = SystemClock.uptimeMillis();
        InlineCompletionEngine.Request req = COMPLETION.poll(now);
        if (req == null) {
            if (COMPLETION.hasPending()) {
                MAIN.postDelayed(COMPLETION_POLL, Math.max(1L, COMPLETION.dueAt() - now));
            }
            return;
        }
        Activity act = sActivity.get();
        if (act == null || act.isFinishing() || act.isDestroyed()) {
            COMPLETION.onFailure(req);
            return;
        }
        final Context appCtx = act.getApplicationContext();
        final String locale = Localize.isChinese(act) ? "zh-CN" : Locale.getDefault().toLanguageTag();
        final HostApiClient.CancelHandle handle = new HostApiClient.CancelHandle();
        cancelInFlightCompletion();
        sCompletionHandle = handle;
        COMPLETION_IO.execute(() -> {
            if (handle.isCancelled()) {
                MAIN.post(() -> COMPLETION.onFailure(req));
                return;
            }
            try {
                JSONObject res = HostApiClient.complete(appCtx, req.agentId, req.draft, locale, handle);
                String completion = res.optString("completion", "");
                String source = res.optString("source", "");
                if (res.has("enabled") && !res.optBoolean("enabled", true)) {
                    sSettingsCompletionEnabled = false;
                }
                MAIN.post(() -> {
                    if (sCompletionHandle == handle) sCompletionHandle = null;
                    EditText input = sActiveInput.get();
                    String current = input != null && input.getText() != null ? input.getText().toString() : null;
                    String shown = COMPLETION.onResponse(req, completion, source, current);
                    if (shown == null) return; // stale
                    sShownSuffix = shown;
                    sLastObserved = "";
                    scheduleScan(0L);
                });
            } catch (Throwable t) {
                MAIN.post(() -> {
                    if (sCompletionHandle == handle) sCompletionHandle = null;
                    COMPLETION.onFailure(req);
                });
            }
        });
    }

    private static void clearCompletion() {
        if (!sShownSuffix.isEmpty() || COMPLETION.hasPending()) {
            COMPLETION.reset();
        }
        sShownSuffix = "";
        sLastObserved = "";
        MAIN.removeCallbacks(COMPLETION_POLL);
        cancelInFlightCompletion();
        hideCompletionViews();
    }

    private static void hideCompletionViews() {
        if (sGhost != null) sGhost.setVisibility(View.GONE);
        if (sPill != null) sPill.setVisibility(View.GONE);
    }

    /** Draws the ghost suffix after the cursor and the Complete pill above the keyboard. */
    private static void renderCompletion(Activity act, ViewGroup decor, EditText composer, Rect anchorRect) {
        String suffix = sShownSuffix;
        if (suffix == null || suffix.isEmpty() || anchorRect == null || anchorRect.top < UiChrome.dp(act, 60)) {
            hideCompletionViews();
            return;
        }
        int[] decorLoc = new int[2];
        decor.getLocationOnScreen(decorLoc);
        UiChrome.Palette p = UiChrome.palette(act);

        // Complete pill, where the suggestions bar sits.
        if (sPill == null) {
            sPill = new CompletionPill(act);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, UiChrome.dp(act, BAR_HEIGHT_DP));
            lp.gravity = Gravity.TOP;
            decor.addView(sPill, lp);
        }
        sPill.bind(p, suffix);
        int barH = UiChrome.dp(act, BAR_HEIGHT_DP);
        int topMargin = Math.max(UiChrome.dp(act, 48), (anchorRect.top - decorLoc[1]) - barH - UiChrome.dp(act, 6));
        FrameLayout.LayoutParams plp = (FrameLayout.LayoutParams) sPill.getLayoutParams();
        if (plp.topMargin != topMargin) {
            plp.topMargin = topMargin;
            sPill.setLayoutParams(plp);
        }
        if (sPill.getVisibility() != View.VISIBLE) sPill.setVisibility(View.VISIBLE);

        // Ghost text right after the cursor, inside the input.
        Layout layout = composer.getLayout();
        Editable text = composer.getText();
        int sel = composer.getSelectionEnd();
        if (layout == null || text == null || sel != text.length()) {
            if (sGhost != null) sGhost.setVisibility(View.GONE);
            return;
        }
        int line = layout.getLineForOffset(sel);
        float x = layout.getPrimaryHorizontal(sel) + composer.getTotalPaddingLeft() - composer.getScrollX();
        int lineTop = layout.getLineTop(line) + composer.getTotalPaddingTop() - composer.getScrollY();
        int lineBottom = layout.getLineBottom(line) + composer.getTotalPaddingTop() - composer.getScrollY();
        int baseline = layout.getLineBaseline(line) + composer.getTotalPaddingTop() - composer.getScrollY();
        int available = Math.round(composer.getWidth() - composer.getTotalPaddingRight() - x);
        if (available < UiChrome.dp(act, 20) || lineBottom <= 0 || lineTop >= composer.getHeight()) {
            if (sGhost != null) sGhost.setVisibility(View.GONE);
            return;
        }
        int[] cLoc = new int[2];
        composer.getLocationOnScreen(cLoc);
        if (sGhost == null) {
            sGhost = new GhostTextView(act);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(1, 1);
            lp.gravity = Gravity.TOP | Gravity.START;
            decor.addView(sGhost, lp);
        }
        int hint = composer.getCurrentHintTextColor();
        int color = (hint >>> 24) != 0 ? hint : p.textMuted;
        sGhost.bind(composer.getPaint(), suffix, color, baseline - lineTop);
        int h = Math.max(1, lineBottom - lineTop);
        FrameLayout.LayoutParams glp = (FrameLayout.LayoutParams) sGhost.getLayoutParams();
        if (glp.width != available || glp.height != h) {
            glp.width = available;
            glp.height = h;
            sGhost.setLayoutParams(glp);
        }
        sGhost.setTranslationX(cLoc[0] - decorLoc[0] + x);
        sGhost.setTranslationY(cLoc[1] - decorLoc[1] + lineTop);
        if (sGhost.getVisibility() != View.VISIBLE) sGhost.setVisibility(View.VISIBLE);
    }

    /** Appends the shown completion to the draft (RN sees a normal text change) and moves the cursor to the end. */
    private static void acceptCompletion() {
        EditText target = sActiveInput.get();
        if (target == null || !target.isAttachedToWindow()) return;
        Editable current = target.getText();
        String draft = current != null ? current.toString() : "";
        String full = COMPLETION.accept(draft);
        sShownSuffix = "";
        hideCompletionViews();
        if (full == null) return;
        try {
            target.requestFocus();
            target.setText(full);
            target.setSelection(full.length());
        } catch (Throwable t) {
            Log.w(TAG, "acceptCompletion failed: " + t.getClass().getSimpleName());
        }
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
            sBar.stopShimmer();
        }
    }

    private static void showBar(Activity act, ViewGroup decor, Rect anchorRect, String key, List<SuggestionItem> items,
                                int placeholders) {
        if (sBar == null) {
            sBar = new OverlayBar(act);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, UiChrome.dp(act, BAR_HEIGHT_DP));
            lp.gravity = Gravity.TOP;
            decor.addView(sBar, lp);
        }
        sBar.bind(key, items, placeholders);

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
        if (v == sBar || v == composer || v == sPill || v == sGhost) return;

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
        private final List<SkeletonPillView> skeletons = new ArrayList<>();
        private ValueAnimator shimmer;
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

        boolean hasPlaceholders() {
            return !skeletons.isEmpty();
        }

        void bind(String key, List<SuggestionItem> items, int placeholders) {
            this.activeKey = key;
            UiChrome.Palette p = UiChrome.palette(activity);
            boolean animate = animationsEnabled(activity);
            StringBuilder sb = new StringBuilder(p.dark ? "D:" : "L:");
            for (SuggestionItem item : items) {
                sb.append(item.type).append('=').append(item.text).append('\u001f');
            }
            sb.append("#placeholders=").append(placeholders).append(animate ? ":a" : ":s");
            String sig = sb.toString();
            if (sig.equals(boundSignature)) {
                if (placeholders > 0 && animate) startShimmer();
                return;
            }
            boundSignature = sig;

            // Which AI chips are new compared with what is on screen: only those fade in.
            Set<String> shownAi = new HashSet<>();
            for (int i = 0; i < chipsRow.getChildCount(); i++) {
                Object tag = chipsRow.getChildAt(i).getTag();
                if (tag instanceof String) shownAi.add((String) tag);
            }
            boolean hadSkeletons = !skeletons.isEmpty();

            // Placeholders leave by fading out in place (row overlay), crossing the incoming chips.
            if (hadSkeletons && placeholders == 0) {
                for (SkeletonPillView sk : skeletons) {
                    if (animate && sk.isAttachedToWindow() && sk.getWidth() > 0) {
                        int l = sk.getLeft(), t = sk.getTop(), r = sk.getRight(), b = sk.getBottom();
                        chipsRow.getOverlay().add(sk);
                        sk.layout(l, t, r, b);
                        sk.animate().alpha(0f).setDuration(SuggestionLoadState.FADE_OUT_MS)
                                .setListener(new AnimatorListenerAdapter() {
                                    @Override public void onAnimationEnd(Animator animation) {
                                        chipsRow.getOverlay().remove(sk);
                                    }
                                }).start();
                    } else {
                        chipsRow.removeView(sk);
                    }
                }
                skeletons.clear();
                stopShimmer();
            }

            closeBtn.setStrokeColor(p.textSecondary);
            for (int i = chipsRow.getChildCount() - 1; i >= 0; i--) {
                View child = chipsRow.getChildAt(i);
                if (!(child instanceof SkeletonPillView)) chipsRow.removeView(child);
            }

            int aiIndex = 0;
            int pos = 0;
            for (int i = 0; i < items.size(); i++) {
                final SuggestionItem item = items.get(i);
                final boolean isPhrase = "phrase".equals(item.type);
                LinearLayout pill = makeChip(p, item, i);
                LayoutParams clp = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                if (pos > 0) clp.leftMargin = UiChrome.dp(activity, 6);
                pill.setLayoutParams(clp);
                chipsRow.addView(pill, pos++);
                if (!isPhrase) {
                    pill.setTag(item.text);
                    if (animate && hadSkeletons && !shownAi.contains(item.text)) {
                        pill.setAlpha(0f);
                        pill.setTranslationY(UiChrome.dp(activity, 3));
                        pill.animate().alpha(1f).translationY(0f).setStartDelay(aiIndex * CHIP_STAGGER_MS)
                                .setDuration(CHIP_FADE_IN_MS).start();
                    }
                    aiIndex++;
                }
            }

            // Shimmer placeholders after the quick phrases.
            if (placeholders > 0) {
                int[] widths = { 84, 112, 68 };
                while (skeletons.size() > placeholders) {
                    chipsRow.removeView(skeletons.remove(skeletons.size() - 1));
                }
                for (int k = 0; k < placeholders; k++) {
                    SkeletonPillView sk;
                    if (k < skeletons.size()) {
                        sk = skeletons.get(k);
                        chipsRow.removeView(sk);
                    } else {
                        sk = new SkeletonPillView(activity);
                        sk.setContentDescription("suggestion_placeholder_" + k);
                        skeletons.add(sk);
                        if (animate) {
                            sk.setAlpha(0f);
                            sk.animate().alpha(1f).setDuration(160L).setStartDelay(k * 60L).start();
                        }
                    }
                    sk.setColors(p.dark, animate);
                    LayoutParams slp = new LayoutParams(UiChrome.dp(activity, widths[k % widths.length]),
                            UiChrome.dp(activity, CHIP_HEIGHT_DP));
                    if (pos > 0) slp.leftMargin = UiChrome.dp(activity, 6);
                    chipsRow.addView(sk, pos++, slp);
                }
                if (animate) startShimmer(); else stopShimmer();
            }
        }

        private LinearLayout makeChip(UiChrome.Palette p, SuggestionItem item, int i) {
            final boolean isPhrase = "phrase".equals(item.type);
            LinearLayout pill = new LinearLayout(activity);
            pill.setOrientation(HORIZONTAL);
            pill.setGravity(Gravity.CENTER_VERTICAL);
            pill.setContentDescription("suggestion_chip_" + item.type + "_" + i);
            pill.setPadding(UiChrome.dp(activity, 10), UiChrome.dp(activity, 6),
                    UiChrome.dp(activity, 12), UiChrome.dp(activity, 6));
            pill.setMinimumHeight(UiChrome.dp(activity, CHIP_HEIGHT_DP));

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
            pill.setOnClickListener(v -> sendSuggestion(activity, item.text));
            return pill;
        }

        void startShimmer() {
            if (shimmer != null && shimmer.isRunning()) return;
            shimmer = ValueAnimator.ofFloat(0f, 1f);
            shimmer.setDuration(SHIMMER_PERIOD_MS);
            shimmer.setRepeatCount(ValueAnimator.INFINITE);
            shimmer.setInterpolator(new LinearInterpolator());
            final int[] loc = new int[2];
            shimmer.addUpdateListener(a -> {
                float f = (float) a.getAnimatedValue();
                // One highlight sweeps across the whole placeholder group, left to right.
                int from = Integer.MAX_VALUE, to = Integer.MIN_VALUE;
                for (SkeletonPillView sk : skeletons) {
                    sk.getLocationInWindow(loc);
                    from = Math.min(from, loc[0]);
                    to = Math.max(to, loc[0] + sk.getWidth());
                }
                if (from > to) return;
                for (SkeletonPillView sk : skeletons) sk.setPhase(f, from, to);
            });
            shimmer.start();
        }

        void stopShimmer() {
            if (shimmer != null) {
                shimmer.cancel();
                shimmer = null;
            }
        }

        @Override
        protected void onDetachedFromWindow() {
            stopShimmer();
            super.onDetachedFromWindow();
        }
    }

    /**
     * Placeholder pill: a rounded skeleton with a soft highlight sweeping left to right (one
     * shared animator per bar). Static (no highlight) when animations are off.
     */
    static final class SkeletonPillView extends View {
        private final Paint base = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint shine = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF rect = new RectF();
        private final Matrix matrix = new Matrix();
        private LinearGradient gradient;
        private int gradientWidth = -1;
        private int highlight;
        private boolean animated;
        private float phase;

        SkeletonPillView(Context ctx) {
            super(ctx);
        }

        void setColors(boolean dark, boolean animated) {
            base.setColor(dark ? 0xFF2A2A31 : 0xFFE4E6EB);
            int hl = dark ? 0x40FFFFFF : 0xF2FFFFFF;
            if (hl != highlight) {
                highlight = hl;
                gradientWidth = -1;
            }
            this.animated = animated;
            invalidate();
        }

        private int groupFrom;
        private int groupTo;

        void setPhase(float phase, int groupFrom, int groupTo) {
            this.phase = phase;
            this.groupFrom = groupFrom;
            this.groupTo = groupTo;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            int w = getWidth(), h = getHeight();
            if (w <= 0 || h <= 0) return;
            rect.set(0, 0, w, h);
            float r = h / 2f;
            canvas.drawRoundRect(rect, r, r, base);
            if (!animated) return;
            // One band crosses the placeholder group, so neighbouring pills shine one after another.
            int sweep = UiChrome.dp(getContext(), 200);
            if (gradient == null || gradientWidth != sweep) {
                gradientWidth = sweep;
                int clear = highlight & 0x00FFFFFF;
                gradient = new LinearGradient(0, 0, sweep * 0.5f, 0,
                        new int[] { clear, highlight, clear }, new float[] { 0f, 0.5f, 1f }, Shader.TileMode.CLAMP);
                shine.setShader(gradient);
            }
            int[] loc = new int[2];
            getLocationInWindow(loc);
            float travel = Math.max(1, groupTo - groupFrom) + sweep * 0.5f;
            float dx = groupFrom - sweep * 0.5f + phase * travel - loc[0];
            matrix.setTranslate(dx, 0);
            gradient.setLocalMatrix(matrix);
            canvas.drawRoundRect(rect, r, r, shine);
        }
    }

    /** "补全 / Complete" pill above the keyboard with a preview of the predicted suffix. */
    private static final class CompletionPill extends LinearLayout {
        final Activity activity;
        private final LinearLayout pill;
        private final TabIconView icon;
        private final TextView label;
        private final TextView preview;
        private String boundSignature = "";

        CompletionPill(Activity act) {
            super(act);
            this.activity = act;
            setOrientation(HORIZONTAL);
            setGravity(Gravity.CENTER_VERTICAL);
            setContentDescription("composer_completion_bar");
            setPadding(UiChrome.dp(act, 10), UiChrome.dp(act, 2), UiChrome.dp(act, 10), UiChrome.dp(act, 2));
            setElevation(UiChrome.dp(act, 4));

            pill = new LinearLayout(act);
            pill.setOrientation(HORIZONTAL);
            pill.setGravity(Gravity.CENTER_VERTICAL);
            pill.setContentDescription("composer_completion_accept");
            pill.setMinimumHeight(UiChrome.dp(act, CHIP_HEIGHT_DP));
            pill.setPadding(UiChrome.dp(act, 10), UiChrome.dp(act, 6), UiChrome.dp(act, 12), UiChrome.dp(act, 6));
            pill.setOnClickListener(v -> acceptCompletion());

            icon = new TabIconView(act);
            int iconSz = UiChrome.dp(act, 14);
            LayoutParams ilp = new LayoutParams(iconSz, iconSz);
            ilp.rightMargin = UiChrome.dp(act, 6);
            pill.addView(icon, ilp);

            label = new TextView(act);
            label.setText(Localize.t(act, "补全", "Complete"));
            label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            label.setTypeface(Typeface.DEFAULT_BOLD);
            label.setSingleLine(true);
            pill.addView(label);

            preview = new TextView(act);
            preview.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            preview.setSingleLine(true);
            preview.setEllipsize(TextUtils.TruncateAt.END);
            preview.setMaxWidth(UiChrome.dp(act, 240));
            LayoutParams plp = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            plp.leftMargin = UiChrome.dp(act, 8);
            pill.addView(preview, plp);

            addView(pill, new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }

        void bind(UiChrome.Palette p, String suffix) {
            String sig = (p.dark ? "D:" : "L:") + suffix;
            if (sig.equals(boundSignature)) return;
            boolean wasEmpty = boundSignature.isEmpty() || getVisibility() != View.VISIBLE;
            boundSignature = sig;
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(p.dark ? 0xEB1D2B42 : 0xF5EEF5FF);
            bg.setStroke(Math.max(1, UiChrome.dp(activity, 0.9f)), p.dark ? 0x993B82F6 : 0x661677FF);
            bg.setCornerRadius(UiChrome.dp(activity, 16));
            pill.setBackground(bg);
            icon.setStrokeColor(p.blueAccent);
            label.setTextColor(p.blueAccent);
            preview.setTextColor(p.textSecondary);
            preview.setText(suffix.trim().isEmpty() ? suffix : suffix.replace('\n', ' '));
            if (wasEmpty && animationsEnabled(activity)) {
                pill.setAlpha(0f);
                pill.animate().alpha(1f).setDuration(150L).start();
            } else {
                pill.setAlpha(1f);
            }
        }
    }

    /** Gray suffix drawn right after the composer's cursor, in the composer's own font. */
    private static final class GhostTextView extends View {
        final Activity activity;
        private final TextPaint paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        private String text = "";
        private float baseline;

        GhostTextView(Activity act) {
            super(act);
            this.activity = act;
            setContentDescription("composer_completion_ghost");
            setClickable(true);
            setOnClickListener(v -> acceptCompletion());
        }

        void bind(TextPaint source, String suffix, int color, float baselineInLine) {
            paint.set(source);
            paint.setColor(color);
            String oneLine = suffix.replace('\n', ' ');
            if (!oneLine.equals(text) || baseline != baselineInLine) {
                text = oneLine;
                baseline = baselineInLine;
                invalidate();
            }
        }

        @Override
        protected void onDraw(Canvas canvas) {
            if (text.isEmpty()) return;
            CharSequence fit = TextUtils.ellipsize(text, paint, Math.max(0, getWidth() - UiChrome.dp(activity, 2)),
                    TextUtils.TruncateAt.END);
            canvas.drawText(fit, 0, fit.length(), 0, baseline, paint);
        }
    }

    /** Vector "accept" icon of the Complete pill: an arrow into a bar, like a Tab key. */
    private static final class TabIconView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        TabIconView(Context ctx) {
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
            float cy = h * 0.5f;
            canvas.drawLine(w * 0.12f, cy, w * 0.70f, cy, paint);
            canvas.drawLine(w * 0.48f, h * 0.28f, w * 0.70f, cy, paint);
            canvas.drawLine(w * 0.48f, h * 0.72f, w * 0.70f, cy, paint);
            canvas.drawLine(w * 0.88f, h * 0.22f, w * 0.88f, h * 0.78f, paint);
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

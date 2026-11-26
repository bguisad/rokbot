package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Toast;

import java.lang.ref.WeakReference;

/**
 * Session list order for Android: the official order, or "sort by last message", the Web/desktop
 * list arrangement: three groups, Needs attention (pendingAction / awaitingUserResponse) -> Unread
 * -> Read, each newest last message first (Host >= a33d5dc stamps lastMessageAt and pendingAction
 * on every Bot).
 *
 * The RN sidebar sorts Bots itself with recencyOf() (it does not keep the API order), so the switch
 * is made in the bundle: when the mode is on, HermesPatcher applies the verified listSort edits from
 * gateway-template.json while generating the paired bundle, then React Native is reloaded. The
 * group headers reuse RN's own sidebar sections (hermes-settings.mjs listGroupEdits): resolve()
 * gets three generated sections whose membership follows each row's live state, so a Bot moves
 * between groups as soon as its row changes. The user's own sections are hidden (not changed)
 * while the mode is on; the titles are baked in the language of {@link #titleLanguage}.
 *
 * The toggle is a real RN header button: hermes-settings.mjs applyHomeBarBell adds a bell item to
 * useHomeBarButtons, so RN lays it out in the Bot list header row next to "+" (and Search where the
 * layout puts Search in the header); it never floats over the list. Its accessibilityLabel is the
 * bundle's existing string "sort" (default order) or "sorted" (last message; the listSort edits also
 * tint it copper), which is how the companion recognises it: RokBotBootstrap's touch interceptor
 * hands the tap to {@link #onHeaderBellTapped}, and {@link #refreshNow} replaces the raw label with a
 * readable, localized one for TalkBack.
 */
final class ListArrangement {
    static final String PREF_KEY = "listArrangement";
    static final String MODE_OFFICIAL = "official";
    static final String MODE_LAST_MESSAGE = "lastMessage";
    /** accessibilityLabel of the RN header bell (strings already in the bundle, see applyHomeBarBell). */
    static final String RN_LABEL_OFF = "sort";
    static final String RN_LABEL_ON = "sorted";

    private static Handler sMain;
    private static WeakReference<Activity> sActivity = new WeakReference<>(null);
    private static volatile boolean sSwitching = false;
    /** View tag key (no R class here); package 0x0e is never used by the app's own resources. */
    private static final int TAG_BELL_HOOK = 0x0e0b7a11;
    private static final int TAG_BELL_LABEL = 0x0e0b7a12;

    private ListArrangement() {}

    /** Created on first use: the label checks also run on a plain JVM (tests), where Looper is a stub. */
    private static synchronized Handler main() {
        if (sMain == null) sMain = new Handler(Looper.getMainLooper());
        return sMain;
    }

    static boolean isLastMessage(Context context) {
        return context != null && MODE_LAST_MESSAGE.equals(Storage.getStringPref(context, PREF_KEY, MODE_OFFICIAL));
    }

    static final String PREF_TITLE_LANGUAGE = "listTitleLanguage";

    /**
     * "zh" or "en": the language the group titles are generated in (part of .bundle-meta, see
     * HermesPatcher.listSortMeta). The companion's explicit language wins; else the language seen
     * in the RN UI, which is remembered because it is only known once RN has drawn its settings
     * (so a cold start does not flip back to the system language and regenerate the bundle);
     * else the system language.
     */
    static String titleLanguage(Context context) {
        if (context == null) return Localize.LANG_EN;
        String pref = Localize.getPreferredLanguage(context);
        if (Localize.LANG_ZH.equals(pref) || Localize.LANG_EN.equals(pref)) return pref;
        String saved = Storage.getStringPref(context, PREF_TITLE_LANGUAGE, "");
        String observed = Localize.getObservedLanguage();
        if (Localize.LANG_ZH.equals(observed) || Localize.LANG_EN.equals(observed)) {
            if (!observed.equals(saved)) Storage.setStringPref(context, PREF_TITLE_LANGUAGE, observed);
            return observed;
        }
        if (Localize.LANG_ZH.equals(saved) || Localize.LANG_EN.equals(saved)) return saved;
        return Localize.isChinese(context) ? Localize.LANG_ZH : Localize.LANG_EN;
    }

    static boolean isAvailable(Context context) {
        return context != null && Storage.isPaired(context) && HermesPatcher.hasListSort(context);
    }

    static boolean isSwitching() {
        return sSwitching;
    }

    /** Persists the mode, regenerates the paired bundle and reloads React Native (background). */
    static void setLastMessage(Context context, boolean on, Runnable onDone) {
        if (context == null || sSwitching) return;
        final Context app = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        Storage.setStringPref(app, PREF_KEY, on ? MODE_LAST_MESSAGE : MODE_OFFICIAL);
        sSwitching = true;
        new Thread(() -> {
            try {
                RokBotBootstrap.ensurePairedBundleFile(app, true);
                RokBotBootstrap.reloadReactHost(app);
            } catch (Throwable t) {
                android.util.Log.w("RokBotListSort", "reload after list sort change failed", t);
            } finally {
                sSwitching = false;
                main().post(() -> {
                    if (onDone != null) onDone.run();
                });
            }
        }, "RokBotListSort").start();
    }

    // ---- RN header bell ----

    /** Localized label the companion puts on the bell for TalkBack. */
    static String spokenLabel(Context context, boolean on) {
        return on
                ? Localize.t(context, "会话排序：按最后消息分组（点按恢复默认）", "Chat order: grouped by last message (tap for default)")
                : Localize.t(context, "会话排序：默认（点按改为按最后消息分组）", "Chat order: default (tap to group by last message)");
    }

    /** True for the RN header bell's label: the raw bundle strings or the localized ones set by refreshNow. */
    static boolean isHeaderBellLabel(Context context, String raw) {
        if (raw == null) return false;
        String s = raw.trim();
        if (s.equals(RN_LABEL_OFF) || s.equals(RN_LABEL_ON)) return true;
        return context != null && (s.equals(spokenLabel(context, false)) || s.equals(spokenLabel(context, true)));
    }

    /** Header-sized: a small square-ish control in the top part of the screen (not a list row). */
    static boolean isHeaderBellGeometry(Activity activity, View view, float effWdp, float effHdp) {
        if (activity == null || view == null) return false;
        if (effWdp < 20f || effHdp < 20f || effWdp > 72f || effHdp > 72f) return false;
        int[] loc = new int[2];
        view.getLocationOnScreen(loc);
        int screenH = activity.getResources().getDisplayMetrics().heightPixels;
        return loc[1] < screenH / 4;
    }

    static void onHeaderBellTapped(Activity activity) {
        if (activity == null || sSwitching || !isAvailable(activity)) return;
        boolean next = !isLastMessage(activity);
        Toast.makeText(activity, next
                ? Localize.t(activity, "会话列表：待处理 → 未读 → 已读，按最后消息排序", "Chats: needs attention → unread → read, by last message")
                : Localize.t(activity, "会话列表：默认排序", "Chats: default order"), Toast.LENGTH_SHORT).show();
        setLastMessage(activity, next, null);
    }

    static void onReactResumed(Activity activity) {
        if (activity == null) return;
        sActivity = new WeakReference<>(activity);
        ViewGroup content = activity.findViewById(android.R.id.content);
        if (content != null && content.getTag(TAG_BELL_HOOK) == null) {
            content.setTag(TAG_BELL_HOOK, Boolean.TRUE);
            content.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
                main().removeCallbacks(sRefresh);
                main().postDelayed(sRefresh, 120L);
            });
        }
        main().post(sRefresh);
    }

    static void onReactPaused(Activity activity) {
        main().removeCallbacks(sRefresh);
    }

    private static final Runnable sRefresh = ListArrangement::refreshNow;

    /** Gives the RN bell a readable contentDescription (RN only rewrites it when the label prop changes). */
    static void refreshNow() {
        Activity activity = sActivity.get();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) return;
        ViewGroup content = activity.findViewById(android.R.id.content);
        if (content == null) return;
        View bell = findRawBell(content, 0);
        if (bell == null) return;
        String raw = bell.getContentDescription().toString().trim();
        boolean on = RN_LABEL_ON.equals(raw);
        bell.setTag(TAG_BELL_LABEL, raw);
        bell.setContentDescription(spokenLabel(activity, on));
    }

    private static View findRawBell(View v, int depth) {
        if (v == null || depth > 40 || v.getVisibility() != View.VISIBLE) return null;
        CharSequence cd = v.getContentDescription();
        if (cd != null) {
            String s = cd.toString().trim();
            if (s.equals(RN_LABEL_OFF) || s.equals(RN_LABEL_ON)) return v;
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                View hit = findRawBell(g.getChildAt(i), depth + 1);
                if (hit != null) return hit;
            }
        }
        return null;
    }

    static String modeLabel(Context context) {
        return isLastMessage(context)
                ? Localize.t(context, "按最后消息", "Last message")
                : Localize.t(context, "默认", "Default");
    }
}

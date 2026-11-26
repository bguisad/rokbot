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
 * Session list arrangement for Android: the official list, or the Web/desktop arrangement in four
 * groups, Needs attention (pendingAction / awaitingUserResponse) -> In progress (isRunning /
 * isComposingMessage) -> Unread -> Read, each newest last message first (lastMessageAt, else
 * lastActivityAt, else createdAt; the Host stamps lastMessageAt and pendingAction on every Bot).
 *
 * rokbot.5b: everything happens inside React Native. The paired bundle always carries both
 * arrangements (hermes-settings.mjs listSortEdits, applied by HermesPatcher); the mode is the id
 * "sorted" in RN's own collapsed-sections state, so the RN bell (applyHomeBarBell, label
 * "sort" / "sorted") switches it like a section fold: the list is re-arranged in place, without
 * regenerating the bundle or reloading React Native, and RN's device mirror remembers it. The group
 * headers fold the same way (their state is remembered too).
 *
 * The companion no longer intercepts the bell tap. It only gives the bell a readable, localized
 * contentDescription for TalkBack ({@link #refreshNow}), notices the label flip to confirm the new
 * order with a toast, and remembers the last state it saw (diagnostics).
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
    /** The bell state last seen on screen (null until the bell is drawn in this process). */
    private static Boolean sSeenOn = null;
    /** View tag key (no R class here); package 0x0e is never used by the app's own resources. */
    private static final int TAG_BELL_HOOK = 0x0e0b7a11;
    private static final int TAG_BELL_LABEL = 0x0e0b7a12;

    private ListArrangement() {}

    /** Created on first use: the label checks also run on a plain JVM (tests), where Looper is a stub. */
    private static synchronized Handler main() {
        if (sMain == null) sMain = new Handler(Looper.getMainLooper());
        return sMain;
    }

    /** The arrangement last seen on the RN bell (RN owns the mode; this is for diagnostics). */
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

    /** Toast for a mode change seen on the bell (the tap itself is handled by React Native). */
    static String switchedMessage(Context context, boolean on) {
        return on
                ? Localize.t(context, "会话列表：待处理 → 进行中 → 未读 → 已读，按最后消息排序", "Chats: needs attention → in progress → unread → read, by last message")
                : Localize.t(context, "会话列表：默认排序", "Chats: default order");
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
        // Remembers the RN language once seen (the settings sheet), so the next cold start builds the
        // group titles in it; the bell itself no longer regenerates the bundle.
        titleLanguage(activity);
        ViewGroup content = activity.findViewById(android.R.id.content);
        if (content == null) return;
        View bell = findRawBell(content, 0);
        if (bell == null) return;
        String raw = bell.getContentDescription().toString().trim();
        boolean on = RN_LABEL_ON.equals(raw);
        bell.setTag(TAG_BELL_LABEL, raw);
        bell.setContentDescription(spokenLabel(activity, on));
        boolean changed = sSeenOn != null && sSeenOn != on;
        sSeenOn = on;
        if (isLastMessage(activity) != on) Storage.setStringPref(activity, PREF_KEY, on ? MODE_LAST_MESSAGE : MODE_OFFICIAL);
        if (changed) Toast.makeText(activity, switchedMessage(activity, on), Toast.LENGTH_SHORT).show();
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

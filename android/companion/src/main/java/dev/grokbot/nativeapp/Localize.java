package dev.grokbot.nativeapp;

import android.content.Context;
import android.content.res.Configuration;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * Bilingual localization helper (zh-Hans vs en), mirroring iOS GBLocalize.m.
 * Reads optional explicit preference ("auto", "zh", "en") from Storage.
 */
public final class Localize {
    public static final String LANG_AUTO = "auto";
    public static final String LANG_ZH = "zh";
    public static final String LANG_EN = "en";

    private static volatile String sObservedLanguage = null;

    private Localize() {}

    public static void observeAppLanguage(String label) {
        if (label == null) return;
        String s = label.trim();
        if ("账户".equals(s) || "调试".equals(s) || "用量".equals(s) || "语言".equals(s) || "连接服务端".equals(s)) {
            sObservedLanguage = LANG_ZH;
        } else if ("Account".equals(s) || "Debug".equals(s) || "Usage".equals(s) || "Language".equals(s) || "Connect to Host".equals(s)) {
            sObservedLanguage = LANG_EN;
        }
    }

    public static String getObservedLanguage() {
        return sObservedLanguage;
    }

    public static String getPreferredLanguage(Context context) {
        if (context == null) return LANG_AUTO;
        String pref = Storage.getStringPref(context, "interface_language", LANG_AUTO);
        if (LANG_ZH.equals(pref) || LANG_EN.equals(pref)) return pref;
        return LANG_AUTO;
    }

    public static void setPreferredLanguage(Context context, String lang) {
        if (context == null) return;
        String norm = (LANG_ZH.equals(lang) || LANG_EN.equals(lang)) ? lang : LANG_AUTO;
        Storage.setStringPref(context, "interface_language", norm);
    }

    public static boolean isChinese(Context context) {
        String pref = getPreferredLanguage(context);
        if (LANG_ZH.equals(pref)) return true;
        if (LANG_EN.equals(pref)) return false;

        String observed = sObservedLanguage;
        if (LANG_ZH.equals(observed)) return true;
        if (LANG_EN.equals(observed)) return false;

        Locale locale = null;
        if (context != null) {
            try {
                Configuration cfg = context.getResources().getConfiguration();
                if (!cfg.getLocales().isEmpty()) {
                    locale = cfg.getLocales().get(0);
                }
            } catch (Exception ignored) {}
        }
        if (locale == null) {
            locale = Locale.getDefault();
        }
        if (locale == null) return false;
        String lang = locale.getLanguage();
        return lang != null && lang.toLowerCase(Locale.US).startsWith("zh");
    }

    public static String t(Context context, String zh, String en) {
        return isChinese(context) ? zh : en;
    }

    public static String formatClockTime(long epochMs) {
        if (epochMs <= 0) return "";
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(epochMs));
    }

    public static String formatRelativeTime(Context context, long epochMs) {
        if (epochMs <= 0) return "";
        long now = System.currentTimeMillis();
        long diff = now - epochMs;
        if (diff >= 0 && diff < 60_000L) {
            return t(context, "刚刚", "Just now");
        }

        Calendar calMsg = Calendar.getInstance();
        calMsg.setTimeInMillis(epochMs);
        Calendar calNow = Calendar.getInstance();
        calNow.setTimeInMillis(now);

        boolean sameDay = calMsg.get(Calendar.YEAR) == calNow.get(Calendar.YEAR)
                && calMsg.get(Calendar.DAY_OF_YEAR) == calNow.get(Calendar.DAY_OF_YEAR);
        if (sameDay) {
            String hm = new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(epochMs));
            return t(context, "今天 " + hm, hm);
        }

        Calendar calYest = (Calendar) calNow.clone();
        calYest.add(Calendar.DAY_OF_YEAR, -1);
        boolean yesterday = calMsg.get(Calendar.YEAR) == calYest.get(Calendar.YEAR)
                && calMsg.get(Calendar.DAY_OF_YEAR) == calYest.get(Calendar.DAY_OF_YEAR);
        if (yesterday) {
            String hm = new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(epochMs));
            return t(context, "昨天 " + hm, "Yesterday " + hm);
        }

        if (calMsg.get(Calendar.YEAR) == calNow.get(Calendar.YEAR)) {
            return new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(new Date(epochMs));
        }
        return new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(new Date(epochMs));
    }
}

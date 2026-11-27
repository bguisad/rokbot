package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.WeakHashMap;

/**
 * Non-invasive native decor overlay shown when the user opens the main Settings sheet in React
 * Native. Provides a first-level "输入建议 / Input Suggestions" entry opening
 * SuggestionsSettingsActivity without mutating the pinned Hermes bytecode size or RN Fabric tree.
 */
final class SettingsSuggestionsOverlay {
    private static final String TAG = "RokBotSettingsSug";
    private static final long MIN_SCAN_INTERVAL_MS = 160L;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final WeakHashMap<View, Boolean> HOOKED = new WeakHashMap<>();

    private static WeakReference<Activity> sActivity = new WeakReference<>(null);
    private static EntryCard sCard;
    private static boolean sScanScheduled = false;
    private static long sLastScanAt = 0L;

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

    private SettingsSuggestionsOverlay() {}

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
        scheduleScan(90L);
    }

    static void onReactPaused(Activity activity) {
        MAIN.removeCallbacks(SCAN);
        sScanScheduled = false;
        if (sCard != null) {
            sCard.setVisibility(View.GONE);
        }
    }

    static boolean isShowing() {
        return sCard != null && sCard.isAttachedToWindow() && sCard.getVisibility() == View.VISIBLE;
    }

    private static void scheduleScan(long delayMs) {
        if (sScanScheduled) return;
        sScanScheduled = true;
        long since = SystemClock.uptimeMillis() - sLastScanAt;
        MAIN.postDelayed(SCAN, Math.max(delayMs, MIN_SCAN_INTERVAL_MS - since));
    }

    private static void scan(Activity act) {
        if (!Storage.isPaired(act)) {
            hideCard();
            return;
        }
        View decor = act.getWindow() != null ? act.getWindow().getDecorView() : null;
        if (!(decor instanceof ViewGroup)) {
            hideCard();
            return;
        }
        if (sCard != null && (sCard.activity != act || !sCard.isAttachedToWindow())) {
            sCard = null;
        }

        if (!isMainSettingsSheetVisible(act, decor)) {
            hideCard();
            return;
        }
        showCard(act, (ViewGroup) decor);
    }

    private static boolean isMainSettingsSheetVisible(Activity act, View root) {
        int screenW = act.getResources().getDisplayMetrics().widthPixels;
        int[] counts = new int[2]; // [0]=rokbotSettingsMarkers, [1]=botProfileMarkers
        int[] loc = new int[2];
        inspectTree(root, counts, loc, screenW, 0);
        return counts[0] >= 2 && counts[1] == 0;
    }

    private static void inspectTree(View v, int[] counts, int[] loc, int screenW, int depth) {
        if (v == null || depth > 96 || v.getVisibility() != View.VISIBLE || !v.isShown()) return;
        if (v == sCard) return;
        if (v instanceof TextView && !(v instanceof android.widget.EditText)) {
            CharSequence txt = ((TextView) v).getText();
            if (txt != null && txt.length() > 0 && txt.length() <= 64 && v.getWidth() > 0 && v.getHeight() > 0) {
                v.getLocationOnScreen(loc);
                if (loc[0] >= -16 && loc[0] < screenW) {
                    String s = txt.toString().trim();
                    if (RokBotBootstrap.matchesModelSettingsLabel(s)
                            || RokBotBootstrap.matchesAvatarStyleLabel(s)
                            || RokBotBootstrap.matchesSoftwareUpdateLabel(s)
                            || RokBotBootstrap.isConnectionEntryLabel(s)) {
                        counts[0]++;
                    } else if (s.equals("资料库") || s.equals("資料庫") || s.equalsIgnoreCase("Library")
                            || s.equals("定时任务") || s.equals("定時任務") || s.equalsIgnoreCase("Routines")) {
                        counts[1]++;
                    }
                }
            }
        }
        if (v instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                inspectTree(vg.getChildAt(i), counts, loc, screenW, depth + 1);
            }
        }
    }

    private static void hideCard() {
        if (sCard != null) {
            sCard.setVisibility(View.GONE);
        }
    }

    private static void showCard(Activity act, ViewGroup decor) {
        if (sCard == null) {
            sCard = new EntryCard(act);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.gravity = Gravity.BOTTOM;
            int side = UiChrome.dp(act, 16);
            lp.leftMargin = side;
            lp.rightMargin = side;
            lp.bottomMargin = resolveBottomInset(act, decor) + UiChrome.dp(act, 14);
            decor.addView(sCard, lp);
        } else {
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) sCard.getLayoutParams();
            int nextBottom = resolveBottomInset(act, decor) + UiChrome.dp(act, 14);
            if (lp.bottomMargin != nextBottom) {
                lp.bottomMargin = nextBottom;
                sCard.setLayoutParams(lp);
            }
        }
        sCard.applyThemeAndText();
        sCard.setVisibility(View.VISIBLE);
    }

    private static int resolveBottomInset(Activity act, View decor) {
        try {
            WindowInsets insets = decor.getRootWindowInsets();
            if (insets != null) {
                return Math.max(insets.getSystemWindowInsetBottom(), UiChrome.dp(act, 8));
            }
        } catch (Throwable ignored) {}
        return UiChrome.dp(act, 16);
    }

    private static final class EntryCard extends LinearLayout {
        final Activity activity;
        private final ComposerSuggestionsOverlay.SparkleIconView iconView;
        private final TextView titleView;
        private final TextView subView;
        private final ChevronView chevronView;

        EntryCard(Activity act) {
            super(act);
            this.activity = act;
            setOrientation(HORIZONTAL);
            setGravity(Gravity.CENTER_VERTICAL);
            setContentDescription("settings_input_suggestions_entry");
            setPadding(UiChrome.dp(act, 14), UiChrome.dp(act, 12), UiChrome.dp(act, 14), UiChrome.dp(act, 12));
            setElevation(UiChrome.dp(act, 6));

            iconView = new ComposerSuggestionsOverlay.SparkleIconView(act);
            int iconSz = UiChrome.dp(act, 22);
            LayoutParams ilp = new LayoutParams(iconSz, iconSz);
            ilp.rightMargin = UiChrome.dp(act, 12);
            addView(iconView, ilp);

            LinearLayout copy = new LinearLayout(act);
            copy.setOrientation(VERTICAL);
            LayoutParams clp = new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            addView(copy, clp);

            titleView = new TextView(act);
            titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            titleView.setTypeface(Typeface.DEFAULT_BOLD);
            copy.addView(titleView);

            subView = new TextView(act);
            subView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            subView.setPadding(0, UiChrome.dp(act, 2), 0, 0);
            copy.addView(subView);

            chevronView = new ChevronView(act);
            int chevSz = UiChrome.dp(act, 18);
            LayoutParams chLp = new LayoutParams(chevSz, chevSz);
            chLp.leftMargin = UiChrome.dp(act, 8);
            addView(chevronView, chLp);

            setOnClickListener(v -> {
                try {
                    activity.startActivity(new Intent(activity, SuggestionsSettingsActivity.class));
                } catch (Throwable t) {
                    Log.w(TAG, "launch SuggestionsSettingsActivity failed: " + t.getClass().getSimpleName());
                }
            });
        }

        void applyThemeAndText() {
            UiChrome.Palette p = UiChrome.palette(activity);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(p.dark ? 0xF51F1F24 : 0xF7FFFFFF);
            bg.setCornerRadius(UiChrome.dp(activity, 14));
            bg.setStroke(Math.max(1, UiChrome.dp(activity, 1f)), p.border);
            setBackground(bg);

            iconView.setStrokeColor(p.blueAccent);
            titleView.setTextColor(p.textPrimary);
            titleView.setText(Localize.t(activity, SuggestionsSettingsActivity.TITLE_ZH, SuggestionsSettingsActivity.TITLE_EN));
            subView.setTextColor(p.textSecondary);
            subView.setText(Localize.t(activity, "建议开关与自定义常用语", "Toggles & custom quick phrases"));
            chevronView.setStrokeColor(p.textSecondary);
        }
    }

    private static final class ChevronView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        ChevronView(Activity act) {
            super(act);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            paint.setStrokeWidth(UiChrome.dp(act, 1.7f));
        }

        void setStrokeColor(int color) {
            paint.setColor(color);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight();
            canvas.drawLine(w * 0.36f, h * 0.25f, w * 0.64f, h * 0.50f, paint);
            canvas.drawLine(w * 0.64f, h * 0.50f, w * 0.36f, h * 0.75f, paint);
        }
    }
}

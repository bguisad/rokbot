package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
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
 * Non-invasive native decor overlay shown when the user opens a Bot's Profile / Settings screen in
 * React Native. Provides direct per-Bot model configuration (persisted via Host botRoutes) without
 * mutating the RN Fabric view tree.
 */
final class BotProfileModelOverlay {
    private static final String TAG = "RokBotBotModelOverlay";
    private static final long MIN_SCAN_INTERVAL_MS = 160L;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final WeakHashMap<View, Boolean> HOOKED = new WeakHashMap<>();

    private static WeakReference<Activity> sActivity = new WeakReference<>(null);
    private static OverlayCard sCard;
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

    private BotProfileModelOverlay() {}

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
        scheduleScan(80L);
    }

    static void onReactPaused(Activity activity) {
        MAIN.removeCallbacks(SCAN);
        sScanScheduled = false;
        if (sCard != null) {
            sCard.setVisibility(View.GONE);
        }
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

        String agentId = RokBotBootstrap.getLastAgentId();
        if (agentId == null || agentId.isEmpty()) agentId = RokBotBootstrap.getViewingAgentId();
        String[] visibleBotName = new String[] { "" };
        if (!isBotProfileScreenVisible(act, decor, visibleBotName)) {
            hideCard();
            return;
        }
        if ((agentId == null || agentId.isEmpty()) && visibleBotName[0].isEmpty()) {
            hideCard();
            return;
        }

        showCard(act, (ViewGroup) decor, agentId != null ? agentId : "", visibleBotName[0]);
    }

    /**
     * Detects the official RN Bot Profile / Settings screen (`ProfileIndexScreen`):
     * has at least 2 on-screen Bot profile rows (Library / Routines / Instructions / Computer),
     * and does NOT show the main app SettingsSheet ("Model Settings" or "Connection & Diagnostics").
     * Also captures the visible Bot title rendered above the Edit button so ModelsActivity always
     * resolves the exact Bot even when RN opens a cached chat without making a network request.
     */
    private static boolean isBotProfileScreenVisible(Activity act, View root, String[] outBotName) {
        int screenW = act.getResources().getDisplayMetrics().widthPixels;
        int screenH = act.getResources().getDisplayMetrics().heightPixels;
        int[] counts = new int[2]; // [0]=botProfileMarkers, [1]=globalSettingsMarkers
        float[] bestTitleSize = new float[] { 0f };
        int[] loc = new int[2];
        inspectTree(root, counts, bestTitleSize, outBotName, loc, screenW, screenH, 0);
        return counts[0] >= 2 && counts[1] == 0;
    }

    private static void inspectTree(View v, int[] counts, float[] bestTitleSize, String[] outBotName,
                                    int[] loc, int screenW, int screenH, int depth) {
        if (v == null || depth > 96 || v.getVisibility() != View.VISIBLE || !v.isShown()) return;
        if (v == sCard) return;
        if (v instanceof TextView && !(v instanceof android.widget.EditText)) {
            TextView tv = (TextView) v;
            CharSequence txt = tv.getText();
            if (txt != null && txt.length() > 0 && txt.length() <= 64 && v.getWidth() > 0 && v.getHeight() > 0) {
                v.getLocationOnScreen(loc);
                if (loc[0] >= -16 && loc[0] < screenW) {
                    String s = txt.toString().trim();
                    if (s.equals("资料库") || s.equals("資料庫") || s.equalsIgnoreCase("Library")
                            || s.equals("定时任务") || s.equals("定時任務") || s.equalsIgnoreCase("Routines")
                            || s.equals("自动化") || s.equalsIgnoreCase("Automations")
                            || s.equals("指令") || s.equals("说明") || s.equalsIgnoreCase("Instructions")
                            || s.equals("电脑") || s.equals("電腦") || s.equalsIgnoreCase("Computer")) {
                        counts[0]++;
                    } else if (RokBotBootstrap.isConnectionEntryLabel(s)
                            || RokBotBootstrap.matchesModelSettingsLabel(s)
                            || RokBotBootstrap.matchesAvatarStyleLabel(s)) {
                        counts[1]++;
                    } else if (loc[1] > screenH * 0.14f && loc[1] < screenH * 0.42f
                            && !s.equalsIgnoreCase("Edit") && !s.equals("编辑") && !s.equals("編輯")
                            && s.length() >= 2 && tv.getTextSize() > bestTitleSize[0]) {
                        bestTitleSize[0] = tv.getTextSize();
                        outBotName[0] = s;
                    }
                }
            }
        }
        if (v instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) v;
            for (int i = 0; i < vg.getChildCount(); i++) {
                inspectTree(vg.getChildAt(i), counts, bestTitleSize, outBotName, loc, screenW, screenH, depth + 1);
            }
        }
    }

    static boolean isShowing() {
        return sCard != null && sCard.getVisibility() == View.VISIBLE && sCard.isAttachedToWindow();
    }

    private static void hideCard() {
        if (sCard != null) {
            sCard.setVisibility(View.GONE);
        }
    }

    private static void showCard(Activity act, ViewGroup decor, String agentId, String botName) {
        if (sCard == null) {
            sCard = new OverlayCard(act);
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.gravity = Gravity.BOTTOM;
            lp.leftMargin = UiChrome.dp(act, 16);
            lp.rightMargin = UiChrome.dp(act, 16);
            decor.addView(sCard, lp);
        }
        int navBottom = UiChrome.dp(act, 20);
        try {
            WindowInsets insets = decor.getRootWindowInsets();
            if (insets != null) {
                int sysBottom = insets.getSystemWindowInsetBottom();
                if (sysBottom > 0) navBottom = sysBottom + UiChrome.dp(act, 14);
            }
        } catch (Throwable ignored) {}
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) sCard.getLayoutParams();
        if (lp.bottomMargin != navBottom) {
            lp.bottomMargin = navBottom;
            sCard.setLayoutParams(lp);
        }
        sCard.bind(agentId, botName);
        sCard.setVisibility(View.VISIBLE);
    }

    private static final class OverlayCard extends LinearLayout {
        final Activity activity;
        private final SlidersIconView iconView;
        private final TextView titleTv;
        private final TextView subtitleTv;
        private final ChevronIconView chevronView;
        private String currentAgentId = "";
        private String currentBotName = "";
        private Boolean lastDark = null;

        OverlayCard(Activity act) {
            super(act);
            this.activity = act;
            setOrientation(HORIZONTAL);
            setGravity(Gravity.CENTER_VERTICAL);
            setContentDescription("bot_profile_model_button");
            setPadding(UiChrome.dp(act, 16), UiChrome.dp(act, 12), UiChrome.dp(act, 14), UiChrome.dp(act, 12));
            setElevation(UiChrome.dp(act, 6));

            iconView = new SlidersIconView(act);
            int iconSz = UiChrome.dp(act, 22);
            LayoutParams ilp = new LayoutParams(iconSz, iconSz);
            ilp.rightMargin = UiChrome.dp(act, 12);
            addView(iconView, ilp);

            LinearLayout col = new LinearLayout(act);
            col.setOrientation(VERTICAL);
            col.setLayoutParams(new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            titleTv = new TextView(act);
            titleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            titleTv.setTypeface(Typeface.DEFAULT_BOLD);
            col.addView(titleTv);

            subtitleTv = new TextView(act);
            subtitleTv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            col.addView(subtitleTv);
            addView(col);

            chevronView = new ChevronIconView(act);
            int chevSz = UiChrome.dp(act, 18);
            addView(chevronView, new LayoutParams(chevSz, chevSz));

            setOnClickListener(v -> {
                if ((currentAgentId == null || currentAgentId.isEmpty())
                        && (currentBotName == null || currentBotName.isEmpty())) return;
                Intent intent = new Intent(activity, ModelsActivity.class);
                if (currentAgentId != null && !currentAgentId.isEmpty()) {
                    intent.putExtra(ModelsActivity.EXTRA_AGENT_ID, currentAgentId);
                }
                if (currentBotName != null && !currentBotName.isEmpty()) {
                    intent.putExtra(ModelsActivity.EXTRA_AGENT_NAME, currentBotName);
                }
                activity.startActivity(intent);
            });
        }

        void bind(String agentId, String botName) {
            this.currentAgentId = agentId;
            this.currentBotName = botName != null ? botName : "";
            UiChrome.Palette p = UiChrome.palette(activity);
            if (lastDark == null || lastDark != p.dark) {
                lastDark = p.dark;
                GradientDrawable bg = new GradientDrawable();
                bg.setColor(p.dark ? 0xF5222228 : 0xFAFFFFFF);
                bg.setCornerRadius(UiChrome.dp(activity, 16));
                bg.setStroke(Math.max(1, UiChrome.dp(activity, 1f)), p.border);
                setBackground(bg);

                iconView.setStrokeColor(p.blueAccent);
                titleTv.setTextColor(p.textPrimary);
                subtitleTv.setTextColor(p.textSecondary);
                chevronView.setStrokeColor(p.textMuted);
            }
            titleTv.setText(Localize.t(activity, "独立模型配置", "Bot Model Settings"));
            subtitleTv.setText(Localize.t(activity, "为此 Bot 指定模型与推理强度，或跟随默认", "Choose a dedicated model & effort for this Bot"));
        }
    }

    private static final class SlidersIconView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        SlidersIconView(Context ctx) {
            super(ctx);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeWidth(UiChrome.dp(ctx, 1.7f));
        }

        void setStrokeColor(int color) {
            paint.setColor(color);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight();
            float pad = w * 0.14f;
            float r = h * 0.09f;
            float y1 = h * 0.28f, y2 = h * 0.50f, y3 = h * 0.72f;
            canvas.drawLine(pad, y1, w - pad, y1, paint);
            canvas.drawLine(pad, y2, w - pad, y2, paint);
            canvas.drawLine(pad, y3, w - pad, y3, paint);
            paint.setStyle(Paint.Style.FILL);
            canvas.drawCircle(w * 0.36f, y1, r, paint);
            canvas.drawCircle(w * 0.66f, y2, r, paint);
            canvas.drawCircle(w * 0.44f, y3, r, paint);
            paint.setStyle(Paint.Style.STROKE);
        }
    }

    private static final class ChevronIconView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        ChevronIconView(Context ctx) {
            super(ctx);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            paint.setStrokeWidth(UiChrome.dp(ctx, 1.8f));
        }

        void setStrokeColor(int color) {
            paint.setColor(color);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight();
            canvas.drawLine(w * 0.36f, h * 0.24f, w * 0.64f, h * 0.50f, paint);
            canvas.drawLine(w * 0.64f, h * 0.50f, w * 0.36f, h * 0.76f, paint);
        }
    }
}

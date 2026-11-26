package dev.rokbot.nativeapp;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Insets;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.util.Base64;
import android.util.LruCache;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * Adaptive Light/Dark theme palette, dpi scaling, rounded cards, circular glass pills,
 * window insets handling, and circular avatar rendering for production native screens.
 */
public final class UiChrome {
    public static final class Palette {
        public final boolean dark;
        public final int bgPaper;
        public final int bgCard;
        public final int bgSurface2;
        public final int bgHeader;
        public final int textPrimary;
        public final int textSecondary;
        public final int textMuted;
        public final int border;
        public final int accent;
        public final int accentText;
        public final int blueAccent;
        public final int userBubble;
        public final int userBubbleText;
        public final int assistantBubble;
        public final int assistantBubbleText;
        public final int toolBubble;
        public final int danger;
        public final int success;
        public final int warning;

        private Palette(boolean dark) {
            this.dark = dark;
            if (dark) {
                this.bgPaper = 0xFF141414;
                this.bgCard = 0xFF1E1E22;
                this.bgSurface2 = 0xFF2C2C32;
                this.bgHeader = 0xFF1A1A1E;
                this.textPrimary = 0xFFF5F5F7;
                this.textSecondary = 0xFFA1A1AA;
                this.textMuted = 0xFF71717A;
                this.border = 0xFF303038;
                this.accent = 0xFFF5F5F7;
                this.accentText = 0xFF141414;
                this.blueAccent = 0xFF60A5FA;
                this.userBubble = 0xFF2563EB;
                this.userBubbleText = 0xFFFFFFFF;
                this.assistantBubble = 0xFF1E1E24;
                this.assistantBubbleText = 0xFFF5F5F7;
                this.toolBubble = 0xFF25262E;
                this.danger = 0xFFF87171;
                this.success = 0xFF4ADE80;
                this.warning = 0xFFFBBF24;
            } else {
                this.bgPaper = 0xFFFCFCFC;
                this.bgCard = 0xFFFFFFFF;
                this.bgSurface2 = 0xFFF2F2F7;
                this.bgHeader = 0xFFF8F9FB;
                this.textPrimary = 0xFF141414;
                this.textSecondary = 0xFF6E6E73;
                this.textMuted = 0xFF8E8E93;
                this.border = 0xFFE5E5EA;
                this.accent = 0xFF141414;
                this.accentText = 0xFFFFFFFF;
                this.blueAccent = 0xFF2563EB;
                this.userBubble = 0xFF141414;
                this.userBubbleText = 0xFFFFFFFF;
                this.assistantBubble = 0xFFF2F2F7;
                this.assistantBubbleText = 0xFF141414;
                this.toolBubble = 0xFFECEEF3;
                this.danger = 0xFFDC2626;
                this.success = 0xFF16A34A;
                this.warning = 0xFFD97706;
            }
        }
    }

    private static final int[] AVATAR_PALETTE = new int[] {
        0xFF2563EB, 0xFF7C3AED, 0xFF059669, 0xFFD97706, 0xFFDB2777, 0xFF0891B2, 0xFF4F46E5
    };

    private static volatile LruCache<String, Bitmap> sAvatarCache;

    private static LruCache<String, Bitmap> getAvatarCache() {
        LruCache<String, Bitmap> c = sAvatarCache;
        if (c == null) {
            synchronized (UiChrome.class) {
                c = sAvatarCache;
                if (c == null) {
                    c = new LruCache<>(64);
                    sAvatarCache = c;
                }
            }
        }
        return c;
    }

    private UiChrome() {}

    public static boolean isDark(Context context) {
        if (context == null) return false;
        String pref = Storage.getThemePreference(context);
        if ("dark".equals(pref)) return true;
        if ("light".equals(pref)) return false;
        int mode = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    public static Palette palette(Context context) {
        return new Palette(isDark(context));
    }

    public static int dp(Context context, float dp) {
        float density = context != null ? context.getResources().getDisplayMetrics().density : 2.625f;
        return Math.round(dp * density);
    }

    public static float sp(Context context, float sp) {
        return sp;
    }

    public static void prepareWindow(Activity activity) {
        if (activity == null) return;
        try {
            activity.requestWindowFeature(Window.FEATURE_NO_TITLE);
            if (activity.getActionBar() != null) {
                activity.getActionBar().hide();
            }
        } catch (Throwable ignored) {}
    }

    @SuppressWarnings("deprecation")
    public static void applyRootInsets(Activity activity, View root) {
        if (activity == null || root == null) return;
        Palette p = palette(activity);
        try {
            if (activity.getActionBar() != null) {
                activity.getActionBar().hide();
            }
            Window window = activity.getWindow();
            if (window != null) {
                View decor = window.getDecorView();
                decor.setBackgroundColor(p.bgPaper);
                root.setBackgroundColor(p.bgPaper);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    window.setStatusBarColor(p.bgPaper);
                    window.setNavigationBarColor(p.bgPaper);
                }
                if (Build.VERSION.SDK_INT >= 30) {
                    WindowInsetsController controller = window.getInsetsController();
                    if (controller != null) {
                        int lightFlags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                        controller.setSystemBarsAppearance(p.dark ? 0 : lightFlags, lightFlags);
                    }
                } else if (Build.VERSION.SDK_INT >= 23) {
                    int flags = decor.getSystemUiVisibility();
                    if (p.dark) {
                        flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    } else {
                        flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    }
                    decor.setSystemUiVisibility(flags);
                }
            }

            final int baseLeft = root.getPaddingLeft();
            final int baseTop = root.getPaddingTop();
            final int baseRight = root.getPaddingRight();
            final int baseBottom = root.getPaddingBottom();

            if (Build.VERSION.SDK_INT >= 30) {
                root.setOnApplyWindowInsetsListener((v, insets) -> {
                    Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout()
                        | WindowInsets.Type.ime()
                    );
                    v.setPadding(
                        baseLeft + bars.left,
                        baseTop + bars.top,
                        baseRight + bars.right,
                        baseBottom + bars.bottom
                    );
                    return WindowInsets.CONSUMED;
                });
                root.requestApplyInsets();
            } else {
                int topFallback = getStatusBarHeight(activity);
                root.setPadding(baseLeft, Math.max(baseTop, topFallback), baseRight, baseBottom);
            }
        } catch (Throwable ignored) {}
    }

    private static int getStatusBarHeight(Activity activity) {
        int resId = activity.getResources().getIdentifier("status_bar_height", "dimen", "android");
        return resId > 0 ? activity.getResources().getDimensionPixelSize(resId) : dp(activity, 28);
    }

    public static GradientDrawable roundRect(int fillColor, float radiusPx, int strokeColor, int strokePx) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fillColor);
        d.setCornerRadius(radiusPx);
        if (strokePx > 0 && strokeColor != 0) {
            d.setStroke(strokePx, strokeColor);
        }
        return d;
    }

    public static GradientDrawable circle(int fillColor, int strokeColor, int strokePx) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(fillColor);
        if (strokePx > 0 && strokeColor != 0) {
            d.setStroke(strokePx, strokeColor);
        }
        return d;
    }

    public static ImageView makeVectorIconButton(Context context, final String kind, String contentDesc, final Palette p, View.OnClickListener onClick) {
        ImageView btn = new ImageView(context);
        int size = dp(context, 40);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(size, size);
        btn.setLayoutParams(lp);
        btn.setContentDescription(contentDesc);
        btn.setScaleType(ImageView.ScaleType.CENTER);
        btn.setBackground(circle(p.bgCard, p.border, dp(context, 1)));
        final float strokeW = Math.max(2f, dp(context, 2));
        btn.setImageDrawable(new Drawable() {
            @Override
            public void draw(Canvas canvas) {
                int w = getBounds().width();
                int h = getBounds().height();
                if (w <= 0 || h <= 0) return;
                float cx = w * 0.5f;
                float cy = h * 0.5f;
                float r = Math.min(w, h) * 0.23f;
                Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
                paint.setColor(p.textPrimary);
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(strokeW);
                paint.setStrokeCap(Paint.Cap.ROUND);
                paint.setStrokeJoin(Paint.Join.ROUND);

                if ("back".equals(kind)) {
                    Path path = new Path();
                    path.moveTo(cx + r * 0.35f, cy - r * 0.9f);
                    path.lineTo(cx - r * 0.55f, cy);
                    path.lineTo(cx + r * 0.35f, cy + r * 0.9f);
                    canvas.drawPath(path, paint);
                } else if ("close".equals(kind)) {
                    float d = r * 0.72f;
                    canvas.drawLine(cx - d, cy - d, cx + d, cy + d, paint);
                    canvas.drawLine(cx + d, cy - d, cx - d, cy + d, paint);
                } else if ("refresh".equals(kind)) {
                    RectF arc = new RectF(cx - r * 0.85f, cy - r * 0.85f, cx + r * 0.85f, cy + r * 0.85f);
                    canvas.drawArc(arc, -40f, 290f, false, paint);
                    float ax = (float) (cx + r * 0.85f * Math.cos(Math.toRadians(-40)));
                    float ay = (float) (cy + r * 0.85f * Math.sin(Math.toRadians(-40)));
                    Path arrow = new Path();
                    arrow.moveTo(ax - r * 0.45f, ay - r * 0.08f);
                    arrow.lineTo(ax, ay + r * 0.08f);
                    arrow.lineTo(ax + r * 0.1f, ay - r * 0.42f);
                    canvas.drawPath(arrow, paint);
                } else if ("moon".equals(kind)) {
                    Path moon = new Path();
                    moon.addCircle(cx, cy, r * 0.78f, Path.Direction.CW);
                    Path cut = new Path();
                    cut.addCircle(cx + r * 0.42f, cy - r * 0.32f, r * 0.68f, Path.Direction.CW);
                    moon.op(cut, Path.Op.DIFFERENCE);
                    paint.setStyle(Paint.Style.FILL);
                    canvas.drawPath(moon, paint);
                } else {
                    canvas.drawCircle(cx, cy, r * 0.42f, paint);
                    for (int i = 0; i < 8; i++) {
                        double a = Math.PI * 0.25 * i;
                        float x1 = (float) (cx + r * 0.72f * Math.cos(a));
                        float y1 = (float) (cy + r * 0.72f * Math.sin(a));
                        float x2 = (float) (cx + r * 0.98f * Math.cos(a));
                        float y2 = (float) (cy + r * 0.98f * Math.sin(a));
                        canvas.drawLine(x1, y1, x2, y2, paint);
                    }
                }
            }

            @Override public void setAlpha(int alpha) {}
            @Override public void setColorFilter(ColorFilter colorFilter) {}
            @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
            @Override public int getIntrinsicWidth() { return size; }
            @Override public int getIntrinsicHeight() { return size; }
        });
        btn.setOnClickListener(onClick);
        return btn;
    }

    /** The white-tile RokBot logo (assets/logo/rokbot-logo.svg), drawn as vectors at any size. */
    public static ImageView makeRokLogoView(Context context, int sizeDp, final Palette p) {
        final int size = dp(context, sizeDp);
        ImageView view = new ImageView(context);
        view.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        view.setImageDrawable(new RokBotLogo.LogoDrawable(size));
        view.setContentDescription("RokBot");
        return view;
    }

    public static TextView makeCircleButton(Context context, String glyph, String contentDesc, Palette p, View.OnClickListener onClick) {
        TextView btn = new TextView(context);
        int size = dp(context, 40);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(size, size);
        btn.setLayoutParams(lp);
        btn.setText(glyph);
        btn.setContentDescription(contentDesc);
        btn.setTextColor(p.textPrimary);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setGravity(Gravity.CENTER);
        btn.setBackground(circle(p.bgCard, p.border, dp(context, 1)));
        btn.setOnClickListener(onClick);
        return btn;
    }

    public static TextView makePillButton(Context context, String text, boolean primary, Palette p, View.OnClickListener onClick) {
        TextView btn = new TextView(context);
        btn.setText(text);
        btn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setGravity(Gravity.CENTER);
        btn.setPadding(dp(context, 16), dp(context, 10), dp(context, 16), dp(context, 10));
        int bg = primary ? p.accent : p.bgCard;
        int fg = primary ? p.accentText : p.textPrimary;
        int stroke = primary ? 0 : p.border;
        btn.setTextColor(fg);
        btn.setBackground(roundRect(bg, dp(context, 22), stroke, stroke == 0 ? 0 : dp(context, 1)));
        btn.setOnClickListener(onClick);
        return btn;
    }

    public static LinearLayout makeCard(Context context, Palette p) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14));
        card.setBackground(roundRect(p.bgCard, dp(context, 18), p.border, dp(context, 1)));
        return card;
    }

    public static LinearLayout makeHeaderBar(Activity activity, String title, Palette p,
                                             View.OnClickListener onBack, View... rightActions) {
        LinearLayout bar = new LinearLayout(activity);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(activity, 14), dp(activity, 10), dp(activity, 14), dp(activity, 10));
        bar.setBackgroundColor(p.bgPaper);

        if (onBack != null) {
            View back = makeVectorIconButton(activity, "back", "back_button", p, onBack);
            LinearLayout.LayoutParams blp = (LinearLayout.LayoutParams) back.getLayoutParams();
            blp.rightMargin = dp(activity, 12);
            back.setLayoutParams(blp);
            bar.addView(back);
        }

        TextView titleView = new TextView(activity);
        titleView.setText(title);
        titleView.setTextColor(p.textPrimary);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        titleView.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(titleView);

        if (rightActions != null) {
            for (View action : rightActions) {
                if (action == null) continue;
                LinearLayout.LayoutParams alp = action.getLayoutParams() instanceof LinearLayout.LayoutParams
                        ? (LinearLayout.LayoutParams) action.getLayoutParams()
                        : new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                alp.leftMargin = dp(activity, 8);
                action.setLayoutParams(alp);
                bar.addView(action);
            }
        }
        return bar;
    }

    public static String jsonStr(JSONObject obj, String key) {
        if (obj == null || key == null || obj.isNull(key)) return "";
        String v = obj.optString(key, "");
        return "null".equals(v) ? "" : v;
    }

    public static String jsonStr(JSONObject obj, String key, String fallback) {
        String v = jsonStr(obj, key);
        return v.isEmpty() ? (fallback != null ? fallback : "") : v;
    }

    public static ImageView makeAvatarView(Context context, String label, String avatarDataUrl, int sizeDp, Palette p) {
        int px = dp(context, sizeDp);
        ImageView iv = new ImageView(context);
        iv.setLayoutParams(new LinearLayout.LayoutParams(px, px));
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        Bitmap bmp = decodeCircleAvatar(label, avatarDataUrl, px);
        iv.setImageBitmap(bmp);
        return iv;
    }

    public static Bitmap decodeCircleAvatar(String label, String avatarDataUrl, int sizePx) {
        int px = Math.max(48, sizePx);
        String safeLabel = (label != null && !label.trim().isEmpty()) ? label.trim() : "G";
        boolean hasDataUri = avatarDataUrl != null && avatarDataUrl.startsWith("data:");
        String cacheKey = (hasDataUri ? ("img:" + avatarDataUrl.hashCode()) : ("mono:" + safeLabel)) + "@" + px;
        Bitmap cached = getAvatarCache().get(cacheKey);
        if (cached != null && !cached.isRecycled()) return cached;

        Bitmap src = hasDataUri ? decodeDataUrlBitmap(avatarDataUrl) : null;
        if (src == null && hasDataUri) {
            cacheKey = "mono:" + safeLabel + "@" + px;
            Bitmap monoCached = getAvatarCache().get(cacheKey);
            if (monoCached != null && !monoCached.isRecycled()) return monoCached;
        }

        Bitmap out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        if (src != null) {
            int sw = src.getWidth();
            int sh = src.getHeight();
            int min = Math.min(sw, sh);
            int x = Math.max(0, (sw - min) / 2);
            int y = Math.max(0, (sh - min) / 2);
            Bitmap cropped = Bitmap.createBitmap(src, x, y, min, min);
            Bitmap scaled = Bitmap.createScaledBitmap(cropped, px, px, true);
            paint.setShader(new BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
            canvas.drawCircle(px / 2f, px / 2f, px / 2f, paint);
        } else {
            int bgColor = AVATAR_PALETTE[Math.abs(safeLabel.hashCode()) % AVATAR_PALETTE.length];
            paint.setColor(bgColor);
            canvas.drawCircle(px / 2f, px / 2f, px / 2f, paint);

            String initial = extractInitials(safeLabel);
            Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            textPaint.setColor(Color.WHITE);
            textPaint.setTypeface(Typeface.DEFAULT_BOLD);
            textPaint.setTextAlign(Paint.Align.CENTER);
            textPaint.setTextSize(px * 0.42f);
            Paint.FontMetrics fm = textPaint.getFontMetrics();
            float cy = px / 2f - (fm.ascent + fm.descent) / 2f;
            canvas.drawText(initial, px / 2f, cy, textPaint);
        }
        getAvatarCache().put(cacheKey, out);
        return out;
    }

    public static Bitmap decodeDataUrlBitmap(String dataUrl) {
        if (dataUrl == null || !dataUrl.startsWith("data:")) return null;
        int comma = dataUrl.indexOf(',');
        if (comma <= 0) return null;
        try {
            byte[] raw = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(raw, 0, raw.length);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String extractInitials(String name) {
        if (name == null || name.isEmpty()) return "B";
        char first = name.charAt(0);
        if (first > 127) {
            return String.valueOf(first);
        }
        String[] parts = name.split("\\s+");
        if (parts.length >= 2 && !parts[0].isEmpty() && !parts[1].isEmpty()) {
            return (String.valueOf(parts[0].charAt(0)) + parts[1].charAt(0)).toUpperCase();
        }
        return String.valueOf(Character.toUpperCase(first));
    }

    public static void styleEditText(android.widget.EditText et, Palette p, Context ctx) {
        et.setTextColor(p.textPrimary);
        et.setHintTextColor(p.textMuted);
        et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        et.setPadding(dp(ctx, 14), dp(ctx, 12), dp(ctx, 14), dp(ctx, 12));
        et.setBackground(roundRect(p.bgSurface2, dp(ctx, 14), p.border, dp(ctx, 1)));
    }

    public static TextView makeSectionLabel(Context ctx, String text, Palette p) {
        TextView tv = new TextView(ctx);
        tv.setText(text);
        tv.setTextColor(p.textSecondary);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(ctx, 14);
        lp.bottomMargin = dp(ctx, 6);
        tv.setLayoutParams(lp);
        return tv;
    }

    public static RectF safeRect(float w, float h) {
        return new RectF(0, 0, w, h);
    }
}

package dev.rokbot.nativeapp;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Drawn icons, the public-access switch and small controls of the canvas screens (no platform widgets). */
final class CanvasUi {
    private CanvasUi() {}

    /** Line icons on a 16-unit grid, drawn like the desktop canvas icons. */
    static final class Icon extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private String name;

        Icon(Context ctx, String name, int color) {
            super(ctx);
            this.name = name;
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            paint.setColor(color);
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        void set(String name, int color) {
            this.name = name;
            paint.setColor(color);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            float s = Math.min(getWidth(), getHeight()) / 16f;
            if (s <= 0) return;
            c.save();
            c.translate((getWidth() - 16 * s) / 2f, (getHeight() - 16 * s) / 2f);
            paint.setStrokeWidth(1.4f * s);
            paint.setStyle(Paint.Style.STROKE);
            Path p = new Path();
            switch (name) {
                case "page":
                    p.moveTo(4.5f * s, 2.5f * s); p.lineTo(9.5f * s, 2.5f * s); p.lineTo(12.5f * s, 5.5f * s); p.lineTo(12.5f * s, 13.5f * s);
                    p.lineTo(3.5f * s, 13.5f * s); p.lineTo(3.5f * s, 2.5f * s); p.close();
                    p.moveTo(9.5f * s, 2.5f * s); p.lineTo(9.5f * s, 5.5f * s); p.lineTo(12.5f * s, 5.5f * s);
                    p.moveTo(5.75f * s, 8.5f * s); p.lineTo(10.25f * s, 8.5f * s);
                    p.moveTo(5.75f * s, 11f * s); p.lineTo(8.75f * s, 11f * s);
                    break;
                case "lock":
                    c.drawRoundRect(new RectF(3.5f * s, 7.5f * s, 12.5f * s, 14f * s), 1.2f * s, 1.2f * s, paint);
                    p.moveTo(5.75f * s, 7.5f * s); p.lineTo(5.75f * s, 5.25f * s);
                    p.arcTo(new RectF(5.75f * s, 3f * s, 10.25f * s, 7.5f * s), 180, 180);
                    p.lineTo(10.25f * s, 7.5f * s);
                    break;
                case "globe":
                    c.drawCircle(8 * s, 8 * s, 6.25f * s, paint);
                    p.moveTo(1.75f * s, 8 * s); p.lineTo(14.25f * s, 8 * s);
                    c.drawOval(new RectF(5.5f * s, 1.75f * s, 10.5f * s, 14.25f * s), paint);
                    break;
                case "refresh":
                    p.arcTo(new RectF(2.75f * s, 2.75f * s, 13.25f * s, 13.25f * s), -40, 310);
                    p.moveTo(13.25f * s, 2.75f * s); p.lineTo(13.25f * s, 5.75f * s); p.lineTo(10.25f * s, 5.75f * s);
                    break;
                case "share":
                    p.moveTo(8 * s, 10 * s); p.lineTo(8 * s, 2.25f * s);
                    p.moveTo(5.25f * s, 5 * s); p.lineTo(8 * s, 2.25f * s); p.lineTo(10.75f * s, 5 * s);
                    p.moveTo(3.75f * s, 8.5f * s); p.lineTo(3.75f * s, 13.75f * s); p.lineTo(12.25f * s, 13.75f * s); p.lineTo(12.25f * s, 8.5f * s);
                    break;
                case "close":
                    p.moveTo(4 * s, 4 * s); p.lineTo(12 * s, 12 * s); p.moveTo(12 * s, 4 * s); p.lineTo(4 * s, 12 * s);
                    break;
                case "back":
                    p.moveTo(10 * s, 3.5f * s); p.lineTo(5.5f * s, 8 * s); p.lineTo(10 * s, 12.5f * s);
                    break;
                case "more":
                    paint.setStyle(Paint.Style.FILL);
                    for (float x : new float[] { 3.5f, 8f, 12.5f }) c.drawCircle(x * s, 8 * s, 1.2f * s, paint);
                    break;
                case "copy":
                    c.drawRoundRect(new RectF(2.75f * s, 5.5f * s, 10.5f * s, 13.25f * s), 1.2f * s, 1.2f * s, paint);
                    p.moveTo(5.5f * s, 5.5f * s); p.lineTo(5.5f * s, 2.75f * s); p.lineTo(13.25f * s, 2.75f * s); p.lineTo(13.25f * s, 10.5f * s); p.lineTo(10.5f * s, 10.5f * s);
                    break;
                case "external":
                    p.moveTo(9.5f * s, 2.75f * s); p.lineTo(13.25f * s, 2.75f * s); p.lineTo(13.25f * s, 6.5f * s);
                    p.moveTo(13.25f * s, 2.75f * s); p.lineTo(7.5f * s, 8.5f * s);
                    p.moveTo(11.5f * s, 9.5f * s); p.lineTo(11.5f * s, 13.25f * s); p.lineTo(2.75f * s, 13.25f * s); p.lineTo(2.75f * s, 4.5f * s); p.lineTo(6.5f * s, 4.5f * s);
                    break;
                case "rotate":
                    p.arcTo(new RectF(2.75f * s, 2.75f * s, 13.25f * s, 13.25f * s), 180, 140);
                    p.moveTo(13.25f * s, 2.75f * s); p.lineTo(13.25f * s, 5.75f * s); p.lineTo(10.25f * s, 5.75f * s);
                    p.arcTo(new RectF(2.75f * s, 2.75f * s, 13.25f * s, 13.25f * s), 0, 140, true);
                    p.moveTo(2.75f * s, 13.25f * s); p.lineTo(2.75f * s, 10.25f * s); p.lineTo(5.75f * s, 10.25f * s);
                    break;
                case "trash":
                    p.moveTo(3 * s, 4.5f * s); p.lineTo(13 * s, 4.5f * s);
                    p.moveTo(6.25f * s, 4.5f * s); p.lineTo(6.25f * s, 2.5f * s); p.lineTo(9.75f * s, 2.5f * s); p.lineTo(9.75f * s, 4.5f * s);
                    p.moveTo(4.5f * s, 4.5f * s); p.lineTo(5.1f * s, 13.5f * s); p.lineTo(10.9f * s, 13.5f * s); p.lineTo(11.5f * s, 4.5f * s);
                    break;
                case "open":
                    p.moveTo(9.75f * s, 2.75f * s); p.lineTo(13.25f * s, 2.75f * s); p.lineTo(13.25f * s, 6.25f * s);
                    p.moveTo(13.25f * s, 2.75f * s); p.lineTo(9 * s, 7 * s);
                    p.moveTo(6.25f * s, 13.25f * s); p.lineTo(2.75f * s, 13.25f * s); p.lineTo(2.75f * s, 9.75f * s);
                    p.moveTo(2.75f * s, 13.25f * s); p.lineTo(7 * s, 9 * s);
                    break;
                case "check":
                    p.moveTo(3.5f * s, 8.5f * s); p.lineTo(6.5f * s, 11.5f * s); p.lineTo(12.5f * s, 4.5f * s);
                    break;
                default:
                    break;
            }
            c.drawPath(p, paint);
            c.restore();
        }
    }

    /** The "公开访问" switch: a drawn track and knob with switch semantics for accessibility. */
    static final class Switch extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private boolean checked;
        private float position;
        private int onColor = 0xFF1A8F5B, offColor = 0x3D1C1C1C;
        private ValueAnimator animator;

        Switch(Context ctx) {
            super(ctx);
            setClickable(true);
            setFocusable(true);
        }

        void setColors(int on, int off) { onColor = on; offColor = off; invalidate(); }

        boolean isChecked() { return checked; }

        void setChecked(boolean value, boolean animate) {
            checked = value;
            float target = value ? 1f : 0f;
            if (animator != null) animator.cancel();
            if (!animate) { position = target; invalidate(); }
            else {
                animator = ValueAnimator.ofFloat(position, target).setDuration(160);
                animator.addUpdateListener(a -> { position = (float) a.getAnimatedValue(); invalidate(); });
                animator.start();
            }
            sendAccessibilityEvent(android.view.accessibility.AccessibilityEvent.TYPE_VIEW_CLICKED);
        }

        @Override
        protected void onMeasure(int w, int h) {
            setMeasuredDimension(UiChrome.dp(getContext(), 44), UiChrome.dp(getContext(), 26));
        }

        @Override
        protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight(), r = h / 2f;
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(blend(offColor, onColor, position));
            c.drawRoundRect(new RectF(0, 0, w, h), r, r, paint);
            float knob = r - UiChrome.dp(getContext(), 3);
            float cx = r + (w - 2 * r) * position;
            paint.setColor(0x33000000);
            c.drawCircle(cx, r + UiChrome.dp(getContext(), 0.8f), knob, paint);
            paint.setColor(0xFFFFFFFF);
            c.drawCircle(cx, r, knob, paint);
            setAlpha(isEnabled() ? 1f : 0.55f);
        }

        @Override
        public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(info);
            info.setClassName("android.widget.Switch");
            info.setCheckable(true);
            info.setChecked(checked);
        }

        private static int blend(int a, int b, float t) {
            int aa = (a >>> 24), ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
            int ba = (b >>> 24), br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
            return ((int) (aa + (ba - aa) * t) << 24) | ((int) (ar + (br - ar) * t) << 16)
                    | ((int) (ag + (bg - ag) * t) << 8) | (int) (ab + (bb - ab) * t);
        }
    }

    static int okColor(UiChrome.Palette p) {
        return p.dark ? 0xFF3DD68C : 0xFF1A8F5B;
    }

    static View icon(Context ctx, String name, int color, int sizeDp) {
        Icon icon = new Icon(ctx, name, color);
        icon.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(ctx, sizeDp), UiChrome.dp(ctx, sizeDp)));
        return icon;
    }

    /** A rounded square with the page glyph, as the official page rows lead with. */
    static View glyph(Context ctx, UiChrome.Palette p, int sizeDp) {
        LinearLayout box = new LinearLayout(ctx);
        box.setGravity(Gravity.CENTER);
        box.setBackground(UiChrome.roundRect(p.bgSurface2, UiChrome.dp(ctx, sizeDp * 0.28f), 0, 0));
        box.addView(icon(ctx, "page", p.textSecondary, Math.round(sizeDp * 0.58f)));
        box.setLayoutParams(new LinearLayout.LayoutParams(UiChrome.dp(ctx, sizeDp), UiChrome.dp(ctx, sizeDp)));
        box.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return box;
    }

    /** "私有" / "公开" with its lock or globe. */
    static LinearLayout visibilityMark(Context ctx, UiChrome.Palette p, String visibility, boolean pill) {
        boolean pub = "public".equals(visibility);
        int color = pub ? okColor(p) : p.textSecondary;
        LinearLayout mark = new LinearLayout(ctx);
        mark.setOrientation(LinearLayout.HORIZONTAL);
        mark.setGravity(Gravity.CENTER_VERTICAL);
        mark.addView(icon(ctx, pub ? "globe" : "lock", color, 12));
        TextView label = new TextView(ctx);
        label.setText(CanvasModel.visibilityLabel(visibility, Localize.isChinese(ctx)));
        label.setTextColor(color);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        label.setPadding(UiChrome.dp(ctx, 3), 0, 0, 0);
        mark.addView(label);
        if (pill) {
            mark.setPadding(UiChrome.dp(ctx, 8), UiChrome.dp(ctx, 3), UiChrome.dp(ctx, 9), UiChrome.dp(ctx, 3));
            mark.setBackground(UiChrome.roundRect(pub ? ((okColor(p) & 0x00FFFFFF) | 0x1F000000) : p.bgSurface2, UiChrome.dp(ctx, 12), 0, 0));
        }
        mark.setContentDescription(label.getText());
        return mark;
    }

    /** A pill button with an optional leading icon. */
    static LinearLayout button(Context ctx, UiChrome.Palette p, String icon, String text, int style, View.OnClickListener onClick) {
        // style: 0 outline, 1 primary, 2 danger, 3 plain
        LinearLayout b = new LinearLayout(ctx);
        b.setOrientation(LinearLayout.HORIZONTAL);
        b.setGravity(Gravity.CENTER);
        int fg = style == 1 ? p.accentText : style == 2 ? 0xFFFFFFFF : p.textPrimary;
        int bg = style == 1 ? p.accent : style == 2 ? (p.dark ? 0xFFE5484D : 0xFFE72E3B) : style == 3 ? 0x00000000 : p.bgCard;
        int stroke = style == 0 ? p.border : 0;
        b.setBackground(UiChrome.roundRect(bg, UiChrome.dp(ctx, 20), stroke, stroke == 0 ? 0 : UiChrome.dp(ctx, 1)));
        b.setPadding(UiChrome.dp(ctx, text == null ? 9 : 12), UiChrome.dp(ctx, 8), UiChrome.dp(ctx, text == null ? 9 : 14), UiChrome.dp(ctx, 8));
        if (icon != null) b.addView(icon(ctx, icon, fg, 16));
        if (text != null) {
            TextView tv = new TextView(ctx);
            tv.setText(text);
            tv.setTextColor(fg);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            tv.setTypeface(Typeface.DEFAULT_BOLD);
            tv.setSingleLine(true);
            if (icon != null) tv.setPadding(UiChrome.dp(ctx, 6), 0, 0, 0);
            b.addView(tv);
            b.setContentDescription(text);
        }
        b.setClickable(true);
        b.setFocusable(true);
        b.setOnClickListener(onClick);
        return b;
    }
}

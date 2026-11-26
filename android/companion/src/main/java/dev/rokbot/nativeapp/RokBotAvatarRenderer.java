package dev.rokbot.nativeapp;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.graphics.Shader;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Pure vector Canvas renderer for RokBot's 5 custom dynamic Bot avatar styles plus the official
 * still mark. Every Bot silhouette is an {@link Path} in a 0..100 design box (the official SVG
 * geometry: live from React Native through {@link RokBotSvgVector}, or the built-in official shapes
 * of {@link RokBotAvatarShapes}); bodies, gradients, rims, eyes, visors and LEDs are drawn with
 * anti-aliased paths at the target pixel size, never through a scaled bitmap. The pixel style's
 * LED squares are snapped to whole device pixels so every square keeps hard edges.
 */
final class RokBotAvatarRenderer {
    static final String STYLE_CHASSIS = "chassis";
    static final String STYLE_ANTENNA = "antenna";
    static final String STYLE_VISOR = "visor";
    static final String STYLE_PIXEL = "pixel";
    static final String STYLE_ORB = "orb";
    static final String STYLE_OFFICIAL = "official";

    static final class StyleInfo {
        final String id;
        final String zh;
        final String en;
        final String descZh;
        final String descEn;
        final int previewColor;
        final String previewShape;

        StyleInfo(String id, String zh, String en, String descZh, String descEn, int previewColor, String previewShape) {
            this.id = id;
            this.zh = zh;
            this.en = en;
            this.descZh = descZh;
            this.descEn = descEn;
            this.previewColor = previewColor;
            this.previewShape = previewShape;
        }
    }

    static final StyleInfo[] STYLES = new StyleInfo[] {
        new StyleInfo(STYLE_CHASSIS, "机甲灵偶", "RokBot Chassis", "全形状兼容 + 脉冲信号灯", "Shape-aware + beacon", 0xFF06B6D4, "blob"),
        new StyleInfo(STYLE_ANTENNA, "双天线波波", "Twin Antenna", "弹性双天线 + 玻璃面罩", "Antennas + glass visor", 0xFF8B5CF6, "cloud"),
        new StyleInfo(STYLE_VISOR, "赛博护目镜", "Cyber Visor", "极客切角框 + 扫描灯带", "Cyber visor + scanner", 0xFFF97316, "hex"),
        new StyleInfo(STYLE_PIXEL, "像素精灵", "Pixel Sprite", "点阵 LED 屏 + 节奏灯条", "LED matrix + status bar", 0xFF10B981, "star"),
        new StyleInfo(STYLE_ORB, "流体光球", "Fluid Orb", "呼吸微动 + 轨道卫星", "Breathing + satellite", 0xFFEC4899, "heart"),
        new StyleInfo(STYLE_OFFICIAL, "官方原版", "Official", "保留官方动态流体球", "Original fluid orb", 0xFF3B82F6, "blob"),
    };

    static final class Palette {
        final int top;
        final int mid;
        final int bot;
        final int accent;
        final int rim;
        /** Body gradient in design units (y 8 -> 92), shared by every draw of this palette. */
        final Shader body;

        Palette(int top, int mid, int bot, int accent, int rim) {
            this.top = top;
            this.mid = mid;
            this.bot = bot;
            this.accent = accent;
            this.rim = rim;
            this.body = new LinearGradient(0f, 8f, 0f, 92f, new int[] { top, mid, bot },
                    new float[] { 0f, 0.55f, 1f }, Shader.TileMode.CLAMP);
        }
    }

    /** Share of the selected picker cell (inside its outline ring) taken by the shape itself (120 / 150 px). */
    static final float SELECTED_INNER_SCALE = 0.8f;

    private RokBotAvatarRenderer() {}

    static boolean isValidStyle(String style) {
        if (style == null) return false;
        for (StyleInfo info : STYLES) {
            if (info.id.equals(style)) return true;
        }
        return false;
    }

    // ---- caches: palettes (with their gradient) per color, and per-thread paints -----------------

    private static final Map<Long, Palette> PALETTES = new LinkedHashMap<Long, Palette>(32, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, Palette> eldest) {
            return size() > 48;
        }
    };

    /** Reused paints (draws happen on the UI thread and, for notification icons, a worker thread). */
    private static final class Paints {
        final Paint fill = new Paint();
        final Paint stroke = new Paint();
        final Paint crisp = new Paint();
        final Paint cut = new Paint();
        final RectF rect = new RectF();
        final Path path = new Path();
    }

    private static final ThreadLocal<Paints> PAINTS = new ThreadLocal<Paints>() {
        @Override
        protected Paints initialValue() {
            return new Paints();
        }
    };

    private static Paint fill(int color) {
        Paint p = PAINTS.get().fill;
        p.reset();
        p.setFlags(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.FILL);
        p.setColor(color);
        return p;
    }

    private static Paint stroke(int color, float width) {
        Paint p = PAINTS.get().stroke;
        p.reset();
        p.setFlags(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeJoin(Paint.Join.ROUND);
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeWidth(width);
        p.setColor(color);
        return p;
    }

    /** No anti-aliasing: for squares already on whole device pixels (pixel style LEDs). */
    private static Paint crisp(int color) {
        Paint p = PAINTS.get().crisp;
        p.reset();
        p.setStyle(Paint.Style.FILL);
        p.setColor(color);
        return p;
    }

    private static RectF rect(float l, float t, float r, float b) {
        RectF rf = PAINTS.get().rect;
        rf.set(l, t, r, b);
        return rf;
    }

    private static int mixRgb(int color, int target, float amount) {
        int r = Math.round(Color.red(color) + (Color.red(target) - Color.red(color)) * amount);
        int g = Math.round(Color.green(color) + (Color.green(target) - Color.green(color)) * amount);
        int b = Math.round(Color.blue(color) + (Color.blue(target) - Color.blue(color)) * amount);
        return Color.rgb(Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)));
    }

    static Palette paletteForColor(int argb, boolean isDark) {
        long key = ((long) argb << 1) | (isDark ? 1L : 0L);
        synchronized (PALETTES) {
            Palette cached = PALETTES.get(key);
            if (cached != null) return cached;
        }
        Palette pal = buildPalette(argb, isDark);
        synchronized (PALETTES) {
            PALETTES.put(key, pal);
        }
        return pal;
    }

    private static Palette buildPalette(int argb, boolean isDark) {
        int r = Color.red(argb);
        int g = Color.green(argb);
        int b = Color.blue(argb);
        int lum = (r * 299 + g * 587 + b * 114) / 1000;
        int maxC = Math.max(r, Math.max(g, b));
        int minC = Math.min(r, Math.min(g, b));
        if (lum < 48 && (maxC - minC) < 28) {
            return isDark
                    ? new Palette(0xFF64748B, 0xFF334155, 0xFF0F172A, 0xFF38BDF8, 0xFF94A3B8)
                    : new Palette(0xFF475569, 0xFF1E293B, 0xFF090D16, 0xFF38BDF8, 0xFF334155);
        }
        return new Palette(
                mixRgb(argb, Color.WHITE, 0.24f),
                Color.rgb(r, g, b),
                mixRgb(argb, 0xFF0A0F1C, 0.34f),
                mixRgb(argb, Color.WHITE, 0.56f),
                mixRgb(argb, 0xFF0F172A, 0.20f));
    }

    // ---- picker selection ring -----------------------------------------------------------------

    /**
     * The official picker's outline around the selected shape, following the shape itself: the
     * outside band between two vector strokes of the silhouette (inner box = SELECTED_INNER_SCALE).
     */
    static void drawSelectionRing(Canvas canvas, Path shape, float size, int ringColor) {
        if (size <= 0f) return;
        if (shape == null) shape = RokBotAvatarShapes.path(null);
        float inner = size * SELECTED_INNER_SCALE;
        float o = (size - inner) / 2f;
        canvas.save();
        canvas.translate(o, o);
        canvas.scale(inner / 100f, inner / 100f);
        // Design units: ring from 5 to 10 units outside the outline (6 px apart, 6 px wide at 120 px).
        int layer = canvas.saveLayer(-14f, -14f, 114f, 114f, null);
        Paint ring = stroke(ringColor, 20f);
        canvas.drawPath(shape, ring);
        Paint cut = PAINTS.get().cut;
        cut.reset();
        cut.setFlags(Paint.ANTI_ALIAS_FLAG);
        cut.setStyle(Paint.Style.FILL_AND_STROKE);
        cut.setStrokeJoin(Paint.Join.ROUND);
        cut.setStrokeWidth(10f);
        cut.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.DST_OUT));
        canvas.drawPath(shape, cut);
        canvas.restoreToCount(layer);
        canvas.restore();
    }

    // ---- entry point ---------------------------------------------------------------------------

    /**
     * Draws one Bot into a size x size box at the canvas origin. {@code shape} is the silhouette in
     * the 0..100 design box (null = the official blob). For crisp pixel LEDs, callers keep the canvas
     * origin on whole pixels.
     */
    static void draw(Canvas canvas, String styleId, Path shape, float size, double t, float blink,
                     boolean isActive, int baseColor, boolean isDark) {
        if (size <= 0f) return;
        if (shape == null) shape = RokBotAvatarShapes.path(null);
        if (STYLE_OFFICIAL.equals(styleId)) {
            drawOfficialStill(canvas, shape, size, baseColor);
            return;
        }
        Palette pal = paletteForColor(baseColor, isDark);
        String style = isValidStyle(styleId) ? styleId : STYLE_CHASSIS;
        switch (style) {
            case STYLE_ANTENNA:
                drawAntenna(canvas, shape, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_VISOR:
                drawVisor(canvas, shape, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_PIXEL:
                drawPixel(canvas, shape, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_ORB:
                drawOrb(canvas, shape, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_CHASSIS:
            default:
                drawChassis(canvas, shape, size, t, blink, isActive, pal, isDark);
                break;
        }
    }

    /**
     * Gradient-filled silhouette with the desktop's rim (rokFillShape). The rim only darkens the
     * inside of the outline (clipped to the shape, 1.2 units visible like the desktop's inner half):
     * a translucent stroke centered on the edge would also lay a grey band outside the body, which
     * reads as a soft, blurred edge at phone sizes. The outer edge stays the body fill's own edge.
     */
    private static void drawShapeBody(Canvas canvas, Path shape, Palette pal, boolean isDark) {
        Paint body = fill(Color.BLACK);
        body.setShader(pal.body);
        canvas.drawPath(shape, body);
        int save = canvas.save();
        canvas.clipPath(shape);
        canvas.drawPath(shape, stroke(isDark ? 0x38FFFFFF : 0x2E0F172A, 2.4f));
        canvas.restoreToCount(save);
    }

    private static void drawChassis(Canvas canvas, Path shape, float s,
                                    double t, float blink, boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float sc = s / 100f;
        float breath = (float) (1.0 + Math.sin(t * 2.8) * 0.024);
        float bob = (float) (isActive ? Math.sin(t * 3.4) * s * 0.016 : Math.sin(t * 2.2) * s * 0.010);
        float tiltDeg = isActive ? (float) (Math.sin(t * 2.4) * 3.2) : 0f;

        canvas.translate(s / 2f, s / 2f + bob);
        canvas.rotate(tiltDeg);
        canvas.scale(breath, breath);
        canvas.translate(-s / 2f, -s / 2f);
        canvas.scale(sc, sc);

        drawShapeBody(canvas, shape, pal, isDark);

        float bx = 74f, by = 22f;
        float beaconScale = isActive
                ? (float) (0.85 + Math.abs(Math.sin(t * 7.0)) * 0.45)
                : (float) (1.0 + Math.sin(t * 3.0) * 0.12);
        if (isActive) {
            float halo = (float) ((t * 1.4) % 1.0);
            Paint haloPaint = stroke(pal.accent, 1.8f);
            haloPaint.setAlpha(Math.max(0, Math.min(255, Math.round((1f - halo) * 0.65f * 255f))));
            canvas.drawCircle(bx, by, 4.2f + halo * 7.2f, haloPaint);
        }
        canvas.drawCircle(bx, by, 4.2f * beaconScale, fill(pal.accent));

        Paint eyePaint = fill(Color.WHITE);
        float gx = isActive ? (float) (Math.sin(t * 4.0) * 2.8) : 0f;
        float gy = isActive ? -2.0f : 0f;
        float sy = Math.max(0.08f, 1f - blink);
        drawTiltedCapsule(canvas, eyePaint, 40f + gx, 54f + gy, 10.2f, 23.5f, -26f, sy);
        drawTiltedCapsule(canvas, eyePaint, 60f + gx, 49f + gy, 10.2f, 19.0f, -26f, sy);
        canvas.restore();
    }

    private static void drawTiltedCapsule(Canvas canvas, Paint paint, float cx, float cy,
                                          float w, float h, float deg, float scaleY) {
        canvas.save();
        canvas.translate(cx, cy);
        canvas.rotate(deg);
        canvas.scale(1f, scaleY);
        canvas.drawRoundRect(rect(-w / 2f, -h / 2f, w / 2f, h / 2f), w / 2f, w / 2f, paint);
        canvas.restore();
    }

    private static void drawAntenna(Canvas canvas, Path shape, float s,
                                    double t, float blink, boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float sc = s / 100f;
        float bob = (float) (isActive ? Math.sin(t * 7.0) * s * 0.022 : Math.sin(t * 2.4) * s * 0.010);
        float sway = (float) (Math.sin(t * (isActive ? 7.5 : 2.6)) * 0.14);

        canvas.translate(0f, bob);
        canvas.scale(sc, sc);

        Path stem = PAINTS.get().path;
        for (int side = -1; side <= 1; side += 2) {
            float rootX = 50f + side * 14f;
            float rootY = 27f;
            float tipX = rootX + side * 6f + (float) Math.sin(t * 3.0 + side) * 2.2f + sway * 7f;
            float tipY = 8f + Math.abs(sway) * 2f;
            stem.rewind();
            stem.moveTo(rootX, rootY);
            stem.quadTo(rootX + side * 2f, (rootY + tipY) / 2f, tipX, tipY);
            canvas.drawPath(stem, stroke(pal.mid, 4.0f));
            if (isActive) {
                float pulse = (float) ((t * 1.8 + (side > 0 ? 0.5 : 0.0)) % 1.0);
                Paint pPaint = stroke(pal.accent, 1.8f);
                pPaint.setAlpha(Math.max(0, Math.min(255, Math.round((1f - pulse) * 0.6f * 255f))));
                canvas.drawCircle(tipX, tipY, 3.8f + pulse * 6.5f, pPaint);
            }
            canvas.drawCircle(tipX, tipY, 4.4f, fill(pal.accent));
        }

        canvas.save();
        canvas.translate(50f, 57f);
        canvas.scale(0.84f, 0.84f);
        canvas.translate(-50f, -50f);
        drawShapeBody(canvas, shape, pal, isDark);
        canvas.restore();

        float vw = 44f, vh = 24f, vx = 50f - vw / 2f, vy = 56f - vh / 2f;
        canvas.drawRoundRect(rect(vx, vy, vx + vw, vy + vh), vh * 0.45f, vh * 0.45f, fill(0xFF0F172A));

        float gx = isActive ? (float) (Math.sin(t * 4.5) * vw * 0.07) : 0f;
        float gy = isActive ? -vh * 0.06f : 0f;
        float eh = vh * 0.48f * Math.max(0.1f, 1f - blink);
        float ew = vw * 0.18f;
        for (int side = -1; side <= 1; side += 2) {
            float ex = vx + vw / 2f + side * vw * 0.21f + gx;
            float ey = vy + vh / 2f + gy;
            canvas.drawOval(rect(ex - ew / 2f, ey - eh / 2f, ex + ew / 2f, ey + eh / 2f), fill(Color.WHITE));
            if (eh > 5f) {
                canvas.drawCircle(ex - ew * 0.12f, ey - eh * 0.16f, ew * 0.16f, fill(pal.accent));
            }
        }
        canvas.restore();
    }

    private static void drawVisor(Canvas canvas, Path shape, float s,
                                  double t, float blink, boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float sc = s / 100f;
        float bob = (float) (isActive ? Math.sin(t * 7.2) * s * 0.02 : Math.sin(t * 2.0) * s * 0.01);
        canvas.translate(0f, bob);
        canvas.scale(sc, sc);

        drawShapeBody(canvas, shape, pal, isDark);

        float vw = 50f, vh = 22f, vx = 50f - vw / 2f, vy = 52f - vh / 2f;
        canvas.drawRoundRect(rect(vx, vy, vx + vw, vy + vh), 6.5f, 6.5f, fill(0xFF090D16));
        canvas.drawRoundRect(rect(vx, vy, vx + vw, vy + vh), 6.5f, 6.5f, stroke(0x2EFFFFFF, 1.6f));

        if (isActive) {
            float pos = (float) ((Math.sin(t * 2.4) + 1.0) / 2.0);
            float beamX = vx + vw * 0.18f + pos * vw * 0.64f;
            float beamW = vw * 0.24f;
            Paint beam = fill(Color.BLACK);
            beam.setShader(new LinearGradient(beamX - beamW, 0f, beamX + beamW, 0f,
                    new int[] { Color.TRANSPARENT, pal.accent, Color.TRANSPARENT },
                    new float[] { 0f, 0.5f, 1f }, Shader.TileMode.CLAMP));
            canvas.drawRoundRect(rect(vx + vw * 0.08f, vy + vh * 0.32f,
                    vx + vw * 0.92f, vy + vh * 0.68f), vh * 0.18f, vh * 0.18f, beam);
        } else {
            float h = vh * 0.46f * Math.max(0.12f, 1f - blink);
            for (int side = -1; side <= 1; side += 2) {
                float cx = vx + vw / 2f + side * vw * 0.21f;
                float cy = vy + vh / 2f;
                canvas.drawRoundRect(rect(cx - vw * 0.07f, cy - h / 2f, cx + vw * 0.07f, cy + h / 2f),
                        2.6f, 2.6f, fill(pal.accent));
            }
        }
        canvas.restore();
    }

    /**
     * LED matrix sprite. The body is a vector path; the 9 x 7 LED grid, its dots and the status
     * bars are laid out in whole device pixels (square cells, integer offsets) and filled without
     * anti-aliasing, so each square stays sharp at every size instead of smearing across pixels.
     */
    private static void drawPixel(Canvas canvas, Path shape, float s,
                                  double t, float blink, boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float sc = s / 100f;
        if (isActive) {
            canvas.translate(0f, Math.round(Math.sin(t * 7.0) * s * 0.018));
        }
        canvas.save();
        canvas.scale(sc, sc);
        drawShapeBody(canvas, shape, pal, isDark);
        canvas.restore();

        // Grid in device pixels: square cells, dots 72% of a cell, everything on integer coordinates.
        int cell = Math.max(2, Math.round(4.55f * sc));
        int dot = Math.max(1, Math.round(cell * 0.72f));
        int inset = (2 * cell - dot) / 2; // dot centered on the grid line after its cell
        int gw = cell * 9, gh = cell * 7;
        int gx = Math.round(50f * sc - gw / 2f);
        int gy = Math.round(55f * sc - gh / 2f);
        float radius = Math.max(1f, 6f * sc);
        canvas.drawRoundRect(rect(gx, gy, gx + gw, gy + gh), radius, radius, fill(0xFF0B101B));

        if (isActive) {
            int active = ((int) Math.floor(t * 4.0)) % 3;
            for (int i = 0; i < 3; i++) {
                ledDot(canvas, gx, gy, cell, dot, inset, 2 + i * 2, 3, i == active ? pal.accent : 0x48FFFFFF);
            }
        } else {
            boolean closed = blink > 0.55f;
            for (int baseC : new int[] { 2, 5 }) {
                if (closed) {
                    ledDot(canvas, gx, gy, cell, dot, inset, baseC, 3, 0xFFF8FAFC);
                } else {
                    ledDot(canvas, gx, gy, cell, dot, inset, baseC, 2, 0xFFF8FAFC);
                    ledDot(canvas, gx, gy, cell, dot, inset, baseC, 3, 0xFFF8FAFC);
                }
            }
        }

        int barPhase = ((int) Math.floor(t * 3.0)) % 3;
        int barW = Math.max(2, Math.round(5.6f * sc));
        int barH = Math.max(1, Math.round(2.8f * sc));
        int barStep = Math.max(barW + 1, Math.round(8.2f * sc));
        int barX = Math.round(50f * sc) - (barStep * 2 + barW) / 2;
        int barY = gy - Math.max(barH + 1, Math.round(6.2f * sc));
        for (int i = 0; i < 3; i++) {
            int x = barX + i * barStep;
            canvas.drawRect(x, barY, x + barW, barY + barH,
                    crisp(isActive && i == barPhase ? Color.WHITE : pal.accent));
        }
        canvas.restore();
    }

    private static void ledDot(Canvas canvas, int gx, int gy, int cell, int dot, int inset, int col, int row, int color) {
        int x = gx + col * cell + inset;
        int y = gy + row * cell + inset;
        canvas.drawRect(x, y, x + dot, y + dot, crisp(color));
    }

    private static void drawOrb(Canvas canvas, Path shape, float s,
                                double t, float blink, boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float sc = s / 100f;
        double speed = isActive ? 3.2 : 1.9;
        double wave = isActive ? 0.055 : 0.04;
        float sx = (float) (1.0 + wave * Math.sin(t * speed));
        float sy = (float) (1.0 + wave * Math.cos(t * speed * 1.15));

        canvas.translate(s / 2f, s / 2f);
        canvas.rotate((float) (Math.sin(t * speed * 0.7) * 2.0));
        canvas.scale(sx, sy);
        canvas.translate(-s / 2f, -s / 2f);
        canvas.scale(sc, sc);

        drawShapeBody(canvas, shape, pal, isDark);

        Paint eye = fill(Color.WHITE);
        float eyeSy = Math.max(0.1f, 1f - blink);
        float gx = isActive ? (float) (Math.sin(t * 4.0) * 3.0) : 0f;
        float gy = isActive ? -2.2f : 0f;
        drawTiltedCapsule(canvas, eye, 40.5f + gx, 52f + gy, 9.2f, 22f, -24f, eyeSy);
        drawTiltedCapsule(canvas, eye, 59.5f + gx, 48f + gy, 9.2f, 18f, -24f, eyeSy);

        double satA = t * (isActive ? 2.8 : 1.1) - 0.8;
        float satDist = 44f;
        canvas.drawCircle(50f + (float) (Math.cos(satA) * satDist),
                50f + (float) (Math.sin(satA) * satDist * 0.88), 4.6f, fill(pal.accent));
        canvas.restore();
    }

    /** Native stand-in for the official still mark: flat Bot color and the two slanted eyes. */
    static void drawOfficialStill(Canvas canvas, Path shape, float s, int color) {
        canvas.save();
        canvas.scale(s / 100f, s / 100f);
        canvas.drawPath(shape, fill(color | 0xFF000000));
        Paint eye = fill(Color.WHITE);
        drawTiltedCapsule(canvas, eye, 54.5f, 35f, 8.4f, 21f, -30f, 1f);
        drawTiltedCapsule(canvas, eye, 75.5f, 25f, 8.4f, 20f, -30f, 1f);
        canvas.restore();
    }
}

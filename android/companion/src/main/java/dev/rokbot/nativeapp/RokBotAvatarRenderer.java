package dev.rokbot.nativeapp;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;

/**
 * Pure Canvas renderer for RokBot's 5 custom dynamic Bot avatar styles plus an official orb
 * preview, matching the desktop and Web renderers (chassis, antenna, visor, pixel, orb, official).
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

        StyleInfo(String id, String zh, String en, String descZh, String descEn, int previewColor) {
            this.id = id;
            this.zh = zh;
            this.en = en;
            this.descZh = descZh;
            this.descEn = descEn;
            this.previewColor = previewColor;
        }
    }

    static final StyleInfo[] STYLES = new StyleInfo[] {
        new StyleInfo(STYLE_CHASSIS, "机甲灵偶", "RokBot Chassis", "斜胶囊眼 + 脉冲信号灯", "Capsule eyes + beacon", 0xFF06B6D4),
        new StyleInfo(STYLE_ANTENNA, "双天线波波", "Twin Antenna", "弹性双天线 + 玻璃面罩", "Antennas + glass visor", 0xFF8B5CF6),
        new StyleInfo(STYLE_VISOR, "赛博护目镜", "Cyber Visor", "极客切角 + 扫描灯带", "Cyber shell + scanner", 0xFFF97316),
        new StyleInfo(STYLE_PIXEL, "像素精灵", "Pixel Sprite", "点阵 LED 眼 + 节奏灯条", "LED matrix + status bar", 0xFF10B981),
        new StyleInfo(STYLE_ORB, "流体光球", "Fluid Orb", "液体变形 + 轨道卫星", "Morphing blob + satellite", 0xFFEC4899),
        new StyleInfo(STYLE_OFFICIAL, "官方原版", "Official", "保留官方动态流体球", "Original fluid orb", 0xFF3B82F6),
    };

    static final class Palette {
        final int top;
        final int mid;
        final int bot;
        final int accent;
        final int rim;

        Palette(int top, int mid, int bot, int accent, int rim) {
            this.top = top;
            this.mid = mid;
            this.bot = bot;
            this.accent = accent;
            this.rim = rim;
        }
    }

    private static final Path CHASSIS_PATH = buildChassisPath();

    private static Path buildChassisPath() {
        Path p = new Path();
        p.moveTo(340f, 148f);
        p.cubicTo(408f, 148f, 476f, 144f, 540f, 144f);
        p.cubicTo(618f, 144f, 664f, 60f, 756f, 56f);
        p.cubicTo(836f, 52f, 892f, 104f, 884f, 176f);
        p.cubicTo(878f, 214f, 932f, 272f, 956f, 368f);
        p.cubicTo(964f, 464f, 960f, 564f, 948f, 656f);
        p.cubicTo(928f, 816f, 820f, 924f, 636f, 944f);
        p.cubicTo(532f, 956f, 424f, 960f, 324f, 952f);
        p.cubicTo(156f, 938f, 76f, 836f, 68f, 668f);
        p.cubicTo(62f, 548f, 64f, 424f, 72f, 336f);
        p.cubicTo(84f, 200f, 184f, 148f, 340f, 148f);
        p.close();
        return p;
    }

    private RokBotAvatarRenderer() {}

    static boolean isValidStyle(String style) {
        if (style == null) return false;
        for (StyleInfo info : STYLES) {
            if (info.id.equals(style)) return true;
        }
        return false;
    }

    private static int mixRgb(int color, int target, float amount) {
        int r = Math.round(Color.red(color) + (Color.red(target) - Color.red(color)) * amount);
        int g = Math.round(Color.green(color) + (Color.green(target) - Color.green(color)) * amount);
        int b = Math.round(Color.blue(color) + (Color.blue(target) - Color.blue(color)) * amount);
        return Color.rgb(Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b)));
    }

    static Palette paletteForColor(int argb, boolean isDark) {
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

    /**
     * Samples the dominant body color directly by drawing the RN SVG node into a tiny offscreen
     * 16x16 bitmap. Immune to R8 class/method renaming inside react-native-svg.
     */
    static int extractDominantColor(View svgView, int fallbackColor) {
        if (svgView == null || svgView.getWidth() <= 0 || svgView.getHeight() <= 0) {
            return fallbackColor;
        }
        float prevAlpha = svgView.getAlpha();
        Bitmap bmp = null;
        try {
            bmp = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bmp);
            c.scale(16f / svgView.getWidth(), 16f / svgView.getHeight());
            if (prevAlpha < 0.99f) svgView.setAlpha(1f);
            svgView.draw(c);

            long sumR = 0, sumG = 0, sumB = 0;
            int count = 0;
            int bestSatPixel = fallbackColor;
            int bestScore = -1;
            for (int y = 2; y < 14; y++) {
                for (int x = 2; x < 14; x++) {
                    int px = bmp.getPixel(x, y);
                    int a = Color.alpha(px);
                    if (a < 180) continue;
                    int r = Color.red(px);
                    int g = Color.green(px);
                    int b = Color.blue(px);
                    if (r > 236 && g > 236 && b > 236) continue; // skip eyes / specular highlights
                    int maxC = Math.max(r, Math.max(g, b));
                    int minC = Math.min(r, Math.min(g, b));
                    int sat = maxC - minC;
                    sumR += r;
                    sumG += g;
                    sumB += b;
                    count++;
                    int score = sat * 3 + a;
                    if (score > bestScore) {
                        bestScore = score;
                        bestSatPixel = Color.rgb(r, g, b);
                    }
                }
            }
            if (count > 0) {
                int avg = Color.rgb((int) (sumR / count), (int) (sumG / count), (int) (sumB / count));
                int maxAvg = Math.max(Color.red(avg), Math.max(Color.green(avg), Color.blue(avg)));
                int minAvg = Math.min(Color.red(avg), Math.min(Color.green(avg), Color.blue(avg)));
                return (maxAvg - minAvg >= 20) ? avg : bestSatPixel;
            }
        } catch (Throwable ignored) {
        } finally {
            if (prevAlpha < 0.99f) {
                try { svgView.setAlpha(prevAlpha); } catch (Throwable ignored) {}
            }
            if (bmp != null) bmp.recycle();
        }
        return fallbackColor;
    }

    static void draw(Canvas canvas, String styleId, float size, double t, float blink,
                     boolean isActive, int baseColor, boolean isDark) {
        if (size <= 0f) return;
        if (STYLE_OFFICIAL.equals(styleId)) {
            drawOfficialPreview(canvas, size);
            return;
        }
        Palette pal = paletteForColor(baseColor, isDark);
        String style = isValidStyle(styleId) ? styleId : STYLE_CHASSIS;
        switch (style) {
            case STYLE_ANTENNA:
                drawAntenna(canvas, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_VISOR:
                drawVisor(canvas, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_PIXEL:
                drawPixel(canvas, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_ORB:
                drawOrb(canvas, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_CHASSIS:
            default:
                drawChassis(canvas, size, t, blink, isActive, pal, isDark);
                break;
        }
    }

    private static Paint bodyGradPaint(Palette pal, float y0, float y1) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.FILL);
        p.setShader(new LinearGradient(0f, y0, 0f, y1,
                new int[] { pal.top, pal.mid, pal.bot },
                new float[] { 0f, 0.55f, 1f },
                Shader.TileMode.CLAMP));
        return p;
    }

    private static void drawChassis(Canvas canvas, float s, double t, float blink,
                                    boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float sc = s / 1024f;
        float breath = (float) (1.0 + Math.sin(t * 2.8) * 0.025);
        float bob = (float) (isActive ? Math.sin(t * 3.4) * s * 0.018 : Math.sin(t * 2.2) * s * 0.012);
        float tiltDeg = isActive ? (float) (Math.sin(t * 2.4) * 3.4) : 0f;

        canvas.translate(s / 2f, s / 2f + bob);
        canvas.rotate(tiltDeg);
        canvas.scale(breath, breath);
        canvas.translate(-s / 2f, -s / 2f);

        canvas.save();
        canvas.scale(sc, sc);
        Paint bodyPaint = bodyGradPaint(pal, 56f, 960f);
        canvas.drawPath(CHASSIS_PATH, bodyPaint);

        Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setStrokeWidth(26f);
        strokePaint.setColor(isDark ? 0x38FFFFFF : 0x2E0F172A);
        canvas.drawPath(CHASSIS_PATH, strokePaint);

        float beaconScale = isActive
                ? (float) (0.85 + Math.abs(Math.sin(t * 7.0)) * 0.45)
                : (float) (1.0 + Math.sin(t * 3.0) * 0.12);
        if (isActive) {
            float halo = (float) ((t * 1.4) % 1.0);
            Paint haloPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            haloPaint.setStyle(Paint.Style.STROKE);
            haloPaint.setStrokeWidth(18f);
            haloPaint.setColor(pal.accent);
            haloPaint.setAlpha(Math.max(0, Math.min(255, Math.round((1f - halo) * 0.65f * 255f))));
            canvas.drawCircle(768f, 144f, 42f + halo * 74f, haloPaint);
        }
        Paint beaconPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        beaconPaint.setColor(pal.accent);
        canvas.drawCircle(768f, 144f, 44f * beaconScale, beaconPaint);

        Paint eyePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        eyePaint.setColor(Color.WHITE);
        float gx = isActive ? (float) (Math.sin(t * 4.0) * 32.0) : 0f;
        float gy = isActive ? -20f : 0f;
        float sy = Math.max(0.08f, 1f - blink);
        drawTiltedCapsule(canvas, eyePaint, 376f + gx, 564f + gy, 144f, 332f, -26f, sy);
        drawTiltedCapsule(canvas, eyePaint, 648f + gx, 504f + gy, 144f, 268f, -26f, sy);
        canvas.restore();
        canvas.restore();
    }

    private static void drawTiltedCapsule(Canvas canvas, Paint paint, float cx, float cy,
                                          float w, float h, float deg, float scaleY) {
        canvas.save();
        canvas.translate(cx, cy);
        canvas.rotate(deg);
        canvas.scale(1f, scaleY);
        RectF r = new RectF(-w / 2f, -h / 2f, w / 2f, h / 2f);
        canvas.drawRoundRect(r, w / 2f, w / 2f, paint);
        canvas.restore();
    }

    private static void drawAntenna(Canvas canvas, float s, double t, float blink,
                                    boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float bw = s * 0.76f;
        float bh = s * 0.66f;
        float bx = (s - bw) / 2f;
        float by = s * 0.26f;
        float bob = (float) (isActive ? Math.sin(t * 7.0) * s * 0.022 : Math.sin(t * 2.4) * s * 0.012);
        float sway = (float) (Math.sin(t * (isActive ? 7.5 : 2.6)) * 0.14);

        canvas.translate(0f, bob);

        Paint stemPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        stemPaint.setStyle(Paint.Style.STROKE);
        stemPaint.setColor(pal.mid);
        stemPaint.setStrokeWidth(Math.max(1.6f, s * 0.045f));
        stemPaint.setStrokeCap(Paint.Cap.ROUND);

        Paint tipPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        tipPaint.setColor(pal.accent);

        for (int side = -1; side <= 1; side += 2) {
            float rootX = s / 2f + side * s * 0.17f;
            float rootY = by + s * 0.03f;
            float tipX = rootX + side * s * 0.07f + (float) Math.sin(t * 3.0 + side) * s * 0.025f + sway * s * 0.08f;
            float tipY = s * 0.09f + Math.abs(sway) * s * 0.02f;
            Path stem = new Path();
            stem.moveTo(rootX, rootY);
            stem.quadTo(rootX + side * s * 0.02f, (rootY + tipY) / 2f, tipX, tipY);
            canvas.drawPath(stem, stemPaint);
            if (isActive) {
                float pulse = (float) ((t * 1.8 + (side > 0 ? 0.5 : 0.0)) % 1.0);
                Paint pPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                pPaint.setStyle(Paint.Style.STROKE);
                pPaint.setStrokeWidth(Math.max(1f, s * 0.02f));
                pPaint.setColor(pal.accent);
                pPaint.setAlpha(Math.max(0, Math.min(255, Math.round((1f - pulse) * 0.6f * 255f))));
                canvas.drawCircle(tipX, tipY, s * 0.04f + pulse * s * 0.07f, pPaint);
            }
            canvas.drawCircle(tipX, tipY, s * 0.048f, tipPaint);
        }

        RectF body = new RectF(bx, by, bx + bw, by + bh);
        canvas.drawRoundRect(body, s * 0.24f, s * 0.24f, bodyGradPaint(pal, by, by + bh));
        Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(Math.max(1.1f, s * 0.025f));
        stroke.setColor(isDark ? 0x38FFFFFF : 0x280F172A);
        canvas.drawRoundRect(body, s * 0.24f, s * 0.24f, stroke);

        float vx = bx + bw * 0.13f;
        float vy = by + bh * 0.22f;
        float vw = bw * 0.74f;
        float vh = bh * 0.56f;
        Paint visor = new Paint(Paint.ANTI_ALIAS_FLAG);
        visor.setColor(0xFF0F172A);
        canvas.drawRoundRect(new RectF(vx, vy, vx + vw, vy + vh), vh * 0.42f, vh * 0.42f, visor);

        Paint eye = new Paint(Paint.ANTI_ALIAS_FLAG);
        eye.setColor(Color.WHITE);
        Paint gl = new Paint(Paint.ANTI_ALIAS_FLAG);
        gl.setColor(pal.accent);
        float gx = isActive ? (float) (Math.sin(t * 4.5) * vw * 0.07) : 0f;
        float gy = isActive ? -vh * 0.06f : 0f;
        float eh = vh * 0.46f * Math.max(0.1f, 1f - blink);
        float ew = vw * 0.18f;
        for (int side = -1; side <= 1; side += 2) {
            float ex = vx + vw / 2f + side * vw * 0.20f + gx;
            float ey = vy + vh / 2f + gy;
            canvas.drawOval(new RectF(ex - ew / 2f, ey - eh / 2f, ex + ew / 2f, ey + eh / 2f), eye);
            if (eh > s * 0.06f) {
                canvas.drawCircle(ex - ew * 0.12f, ey - eh * 0.16f, ew * 0.16f, gl);
            }
        }
        canvas.restore();
    }

    private static void drawVisor(Canvas canvas, float s, double t, float blink,
                                  boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float bob = (float) (isActive ? Math.sin(t * 7.2) * s * 0.02 : Math.sin(t * 2.0) * s * 0.01);
        canvas.translate(0f, bob);

        float p = s * 0.11f;
        float c = s * 0.22f;
        Path shell = new Path();
        shell.moveTo(p + c, p * 1.15f);
        shell.lineTo(s - p - c, p * 1.15f);
        shell.lineTo(s - p, p * 1.15f + c);
        shell.lineTo(s - p, s - p - c);
        shell.lineTo(s - p - c, s - p);
        shell.lineTo(p + c, s - p);
        shell.lineTo(p, s - p - c);
        shell.lineTo(p, p * 1.15f + c);
        shell.close();

        canvas.drawPath(shell, bodyGradPaint(pal, p, s - p));
        Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(Math.max(1.1f, s * 0.025f));
        stroke.setColor(isDark ? 0x3DFFFFFF : 0x2E0F172A);
        canvas.drawPath(shell, stroke);

        float vx = s * 0.13f;
        float vy = s * 0.34f;
        float vw = s * 0.74f;
        float vh = s * 0.34f;
        Paint band = new Paint(Paint.ANTI_ALIAS_FLAG);
        band.setColor(0xFF090D16);
        canvas.drawRoundRect(new RectF(vx, vy, vx + vw, vy + vh), s * 0.09f, s * 0.09f, band);
        Paint bandBorder = new Paint(Paint.ANTI_ALIAS_FLAG);
        bandBorder.setStyle(Paint.Style.STROKE);
        bandBorder.setStrokeWidth(Math.max(0.9f, s * 0.02f));
        bandBorder.setColor(0x28FFFFFF);
        canvas.drawRoundRect(new RectF(vx, vy, vx + vw, vy + vh), s * 0.09f, s * 0.09f, bandBorder);

        if (isActive) {
            float pos = (float) ((Math.sin(t * 2.4) + 1.0) / 2.0);
            float beamX = vx + vw * 0.18f + pos * vw * 0.64f;
            float beamW = vw * 0.24f;
            Paint beam = new Paint(Paint.ANTI_ALIAS_FLAG);
            beam.setShader(new LinearGradient(beamX - beamW, 0f, beamX + beamW, 0f,
                    new int[] { Color.TRANSPARENT, pal.accent, Color.TRANSPARENT },
                    new float[] { 0f, 0.5f, 1f }, Shader.TileMode.CLAMP));
            canvas.drawRoundRect(new RectF(vx + vw * 0.08f, vy + vh * 0.32f,
                    vx + vw * 0.92f, vy + vh * 0.68f), vh * 0.18f, vh * 0.18f, beam);
        } else {
            Paint led = new Paint(Paint.ANTI_ALIAS_FLAG);
            led.setColor(pal.accent);
            float h = vh * 0.44f * Math.max(0.12f, 1f - blink);
            for (int side = -1; side <= 1; side += 2) {
                float cx = vx + vw / 2f + side * vw * 0.21f;
                float cy = vy + vh / 2f;
                canvas.drawRoundRect(new RectF(cx - vw * 0.065f, cy - h / 2f, cx + vw * 0.065f, cy + h / 2f),
                        s * 0.03f, s * 0.03f, led);
            }
        }
        canvas.restore();
    }

    private static void drawPixel(Canvas canvas, float s, double t, float blink,
                                  boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        if (isActive) {
            canvas.translate(0f, (float) (Math.sin(t * 7.0) * s * 0.018));
        }

        float pad = s * 0.10f;
        RectF shell = new RectF(pad, pad, s - pad, s - pad);
        canvas.drawRoundRect(shell, s * 0.20f, s * 0.20f, bodyGradPaint(pal, pad, s - pad));
        Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(Math.max(1.1f, s * 0.025f));
        stroke.setColor(isDark ? 0x38FFFFFF : 0x2E0F172A);
        canvas.drawRoundRect(shell, s * 0.20f, s * 0.20f, stroke);

        float mx = s * 0.19f;
        float my = s * 0.25f;
        float mw = s * 0.62f;
        float mh = s * 0.52f;
        Paint screen = new Paint(Paint.ANTI_ALIAS_FLAG);
        screen.setColor(0xFF0B101B);
        canvas.drawRoundRect(new RectF(mx, my, mx + mw, my + mh), s * 0.09f, s * 0.09f, screen);

        float cellW = mw / 9f;
        float cellH = mh / 7f;
        float px = Math.max(1.2f, cellW * 0.72f);
        float py = Math.max(1.2f, cellH * 0.72f);
        Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG);

        if (isActive) {
            int active = ((int) Math.floor(t * 4.0)) % 3;
            for (int i = 0; i < 3; i++) {
                dot.setColor(i == active ? pal.accent : 0x48FFFFFF);
                float dx = mx + (2 + i * 2 + 0.65f) * cellW;
                float dy = my + 3.65f * cellH;
                canvas.drawRect(dx, dy, dx + px, dy + py, dot);
            }
        } else {
            dot.setColor(0xFFF8FAFC);
            boolean closed = blink > 0.55f;
            for (int baseC : new int[] { 2, 5 }) {
                float dx = mx + (baseC + 0.65f) * cellW;
                if (closed) {
                    float dy = my + 3.65f * cellH;
                    canvas.drawRect(dx, dy, dx + px, dy + py, dot);
                } else {
                    float dy1 = my + 2.65f * cellH;
                    float dy2 = my + 3.65f * cellH;
                    canvas.drawRect(dx, dy1, dx + px, dy1 + py, dot);
                    canvas.drawRect(dx, dy2, dx + px, dy2 + py, dot);
                }
            }
        }

        int barPhase = ((int) Math.floor(t * 3.0)) % 3;
        float bw = s * 0.08f;
        float bh = Math.max(1.4f, s * 0.04f);
        for (int i = 0; i < 3; i++) {
            dot.setColor(isActive && i == barPhase ? Color.WHITE : pal.accent);
            float bx = s / 2f - s * 0.15f + i * s * 0.11f;
            float by = s * 0.145f;
            canvas.drawRect(bx, by, bx + bw, by + bh, dot);
        }
        canvas.restore();
    }

    private static void drawOrb(Canvas canvas, float s, double t, float blink,
                                boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float cx = s / 2f;
        float cy = s / 2f;
        canvas.translate(cx, cy);

        int pts = 32;
        float baseR = s * 0.37f;
        double speed = isActive ? 3.4 : 1.9;
        double amp = isActive ? 0.075 : 0.055;
        float[] xs = new float[pts];
        float[] ys = new float[pts];
        for (int i = 0; i < pts; i++) {
            double a = (i / (double) pts) * Math.PI * 2.0;
            double r = baseR * (1.0 + amp * Math.sin(a * 3.0 + t * speed) + amp * 0.6 * Math.cos(a * 2.0 - t * speed * 1.3));
            xs[i] = (float) (Math.cos(a) * r);
            ys[i] = (float) (Math.sin(a) * r);
        }
        Path blob = new Path();
        blob.moveTo((xs[pts - 1] + xs[0]) / 2f, (ys[pts - 1] + ys[0]) / 2f);
        for (int i = 0; i < pts; i++) {
            int next = (i + 1) % pts;
            blob.quadTo(xs[i], ys[i], (xs[i] + xs[next]) / 2f, (ys[i] + ys[next]) / 2f);
        }
        blob.close();

        canvas.drawPath(blob, bodyGradPaint(pal, -baseR, baseR));
        Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(Math.max(1.1f, s * 0.024f));
        stroke.setColor(isDark ? 0x33FFFFFF : 0x240F172A);
        canvas.drawPath(blob, stroke);

        Paint eye = new Paint(Paint.ANTI_ALIAS_FLAG);
        eye.setColor(Color.WHITE);
        float sy = Math.max(0.1f, 1f - blink);
        float gx = isActive ? (float) (Math.sin(t * 4.0) * s * 0.035) : 0f;
        float gy = isActive ? -s * 0.025f : 0f;
        drawTiltedCapsule(canvas, eye, -s * 0.105f + gx, s * 0.015f + gy, s * 0.104f, s * 0.25f, -24f, sy);
        drawTiltedCapsule(canvas, eye, s * 0.105f + gx, -s * 0.035f + gy, s * 0.104f, s * 0.20f, -24f, sy);

        double satA = t * (isActive ? 2.8 : 1.1) - 0.8;
        float satDist = baseR + s * 0.075f;
        Paint sat = new Paint(Paint.ANTI_ALIAS_FLAG);
        sat.setColor(pal.accent);
        canvas.drawCircle((float) (Math.cos(satA) * satDist),
                (float) (Math.sin(satA) * satDist * 0.86), s * 0.05f, sat);
        canvas.restore();
    }

    static void drawOfficialPreview(Canvas canvas, float s) {
        Palette blue = new Palette(0xFF60A5FA, 0xFF3B82F6, 0xFF1D4ED8, 0xFF93C5FD, 0xFF2563EB);
        float r = s * 0.36f;
        Paint p = bodyGradPaint(blue, s / 2f - r, s / 2f + r);
        canvas.drawCircle(s / 2f, s / 2f, r, p);
        Paint eye = new Paint(Paint.ANTI_ALIAS_FLAG);
        eye.setColor(Color.WHITE);
        float ew = s * 0.10f;
        float eh = s * 0.22f;
        canvas.drawRoundRect(new RectF(s * 0.33f, s / 2f - eh / 2f, s * 0.33f + ew, s / 2f + eh / 2f), ew / 2f, ew / 2f, eye);
        canvas.drawRoundRect(new RectF(s * 0.57f, s / 2f - eh / 2f, s * 0.57f + ew, s / 2f + eh / 2f), ew / 2f, ew / 2f, eye);
    }
}

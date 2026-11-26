package dev.rokbot.nativeapp;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffColorFilter;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;
import android.view.ViewGroup;

/**
 * Pure Canvas renderer for RokBot's 5 custom dynamic Bot avatar styles plus an official orb
 * preview. Supports exact silhouette masks extracted from react-native-svg GrokBotMark nodes
 * (all 26 official shapes) as well as procedural multi-shape previews in Settings.
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

        Palette(int top, int mid, int bot, int accent, int rim) {
            this.top = top;
            this.mid = mid;
            this.bot = bot;
            this.accent = accent;
            this.rim = rim;
        }
    }

    static final class SvgSample {
        final int color;
        final Bitmap mask;
        final int signature;

        SvgSample(int color, Bitmap mask, int signature) {
            this.color = color;
            this.mask = mask;
            this.signature = signature;
        }
    }

    private static final int MASK_DIM = 64;
    private static final Path PATH_BLOB = buildBlobPath();
    private static final Path PATH_CLOUD = buildCloudPath();
    private static final Path PATH_HEX = buildHexPath();
    private static final Path PATH_STAR = buildStarPath();
    private static final Path PATH_HEART = buildHeartPath();

    private static Path buildBlobPath() {
        Path p = new Path();
        p.moveTo(33f, 14f);
        p.cubicTo(40f, 14f, 47f, 14f, 53f, 14f);
        p.cubicTo(60f, 14f, 65f, 6f, 74f, 5.5f);
        p.cubicTo(82f, 5f, 87f, 10f, 86f, 17f);
        p.cubicTo(86f, 21f, 91f, 27f, 93f, 36f);
        p.cubicTo(94f, 45f, 94f, 55f, 93f, 64f);
        p.cubicTo(91f, 80f, 80f, 90f, 62f, 92f);
        p.cubicTo(52f, 93f, 41f, 94f, 32f, 93f);
        p.cubicTo(15f, 92f, 7f, 82f, 7f, 65f);
        p.cubicTo(6f, 54f, 6f, 41f, 7f, 33f);
        p.cubicTo(8f, 20f, 18f, 14f, 33f, 14f);
        p.close();
        return p;
    }

    private static Path buildCloudPath() {
        Path p = new Path();
        p.moveTo(28f, 74f);
        p.cubicTo(16f, 74f, 8f, 66f, 8f, 55f);
        p.cubicTo(8f, 46f, 14f, 39f, 22f, 37f);
        p.cubicTo(24f, 25f, 35f, 16f, 48f, 16f);
        p.cubicTo(60f, 16f, 70f, 23f, 73f, 34f);
        p.cubicTo(83f, 35f, 92f, 43f, 92f, 54f);
        p.cubicTo(92f, 65f, 83f, 74f, 71f, 74f);
        p.close();
        return p;
    }

    private static Path buildHexPath() {
        Path p = new Path();
        p.moveTo(50f, 8f);
        p.lineTo(86f, 29f);
        p.lineTo(86f, 71f);
        p.lineTo(50f, 92f);
        p.lineTo(14f, 71f);
        p.lineTo(14f, 29f);
        p.close();
        return p;
    }

    private static Path buildStarPath() {
        Path p = new Path();
        p.moveTo(50f, 8f);
        p.lineTo(62f, 33f);
        p.lineTo(90f, 37f);
        p.lineTo(69f, 57f);
        p.lineTo(74f, 85f);
        p.lineTo(50f, 72f);
        p.lineTo(26f, 85f);
        p.lineTo(31f, 57f);
        p.lineTo(10f, 37f);
        p.lineTo(38f, 33f);
        p.close();
        return p;
    }

    private static Path buildHeartPath() {
        Path p = new Path();
        p.moveTo(50f, 88f);
        p.cubicTo(20f, 68f, 8f, 49f, 8f, 33f);
        p.cubicTo(8f, 20f, 18f, 11f, 30f, 11f);
        p.cubicTo(39f, 11f, 46f, 16f, 50f, 23f);
        p.cubicTo(54f, 16f, 61f, 11f, 70f, 11f);
        p.cubicTo(82f, 11f, 92f, 20f, 92f, 33f);
        p.cubicTo(92f, 49f, 80f, 68f, 50f, 88f);
        p.close();
        return p;
    }

    private static Path pathForPreviewShape(String shape) {
        if ("cloud".equals(shape)) return PATH_CLOUD;
        if ("hex".equals(shape)) return PATH_HEX;
        if ("star".equals(shape)) return PATH_STAR;
        if ("heart".equals(shape)) return PATH_HEART;
        return PATH_BLOB;
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
     * Captures BOTH the dominant body color and the exact 64x64 solid silhouette mask mapped to
     * the SVG's parent container bounds, preserving all 26 official Bot shapes accurately.
     */
    static SvgSample extractSvgSample(View svgView, int fallbackColor) {
        if (svgView == null || svgView.getWidth() <= 0 || svgView.getHeight() <= 0) {
            return new SvgSample(fallbackColor, null, 0);
        }
        int pw = (svgView.getParent() instanceof ViewGroup) ? ((ViewGroup) svgView.getParent()).getWidth() : svgView.getWidth();
        int ph = (svgView.getParent() instanceof ViewGroup) ? ((ViewGroup) svgView.getParent()).getHeight() : svgView.getHeight();
        if (pw <= 0 || ph <= 0) return new SvgSample(fallbackColor, null, 0);

        float prevAlpha = svgView.getAlpha();
        Bitmap raw = null;
        try {
            raw = Bitmap.createBitmap(MASK_DIM, MASK_DIM, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(raw);
            float sx = MASK_DIM / (float) pw;
            float sy = MASK_DIM / (float) ph;
            c.save();
            c.translate(svgView.getLeft() * sx, svgView.getTop() * sy);
            c.scale(sx, sy);
            if (prevAlpha < 0.99f) svgView.setAlpha(1f);
            svgView.draw(c);
            c.restore();

            int[] pixels = new int[MASK_DIM * MASK_DIM];
            raw.getPixels(pixels, 0, MASK_DIM, 0, 0, MASK_DIM, MASK_DIM);

            long sumR = 0, sumG = 0, sumB = 0;
            int colorCount = 0;
            int maskCount = 0;
            int bestSatPixel = fallbackColor;
            int bestScore = -1;
            int sig = 17;

            int[] maskPixels = new int[MASK_DIM * MASK_DIM];
            for (int i = 0; i < pixels.length; i++) {
                int px = pixels[i];
                int a = Color.alpha(px);
                if (a >= 96) {
                    maskPixels[i] = 0xFFFFFFFF;
                    maskCount++;
                } else {
                    maskPixels[i] = 0;
                }
                if ((i & 31) == 0) sig = sig * 31 + (a >= 96 ? (px | 0xFF000000) : 0);
                if (a < 180) continue;
                int r = Color.red(px);
                int g = Color.green(px);
                int b = Color.blue(px);
                if (r > 236 && g > 236 && b > 236) continue;
                int maxC = Math.max(r, Math.max(g, b));
                int minC = Math.min(r, Math.min(g, b));
                int sat = maxC - minC;
                sumR += r;
                sumG += g;
                sumB += b;
                colorCount++;
                int score = sat * 3 + a;
                if (score > bestScore) {
                    bestScore = score;
                    bestSatPixel = Color.rgb(r, g, b);
                }
            }

            int color = fallbackColor;
            if (colorCount > 0) {
                int avg = Color.rgb((int) (sumR / colorCount), (int) (sumG / colorCount), (int) (sumB / colorCount));
                int maxAvg = Math.max(Color.red(avg), Math.max(Color.green(avg), Color.blue(avg)));
                int minAvg = Math.min(Color.red(avg), Math.min(Color.green(avg), Color.blue(avg)));
                color = (maxAvg - minAvg >= 20) ? avg : bestSatPixel;
            }

            if (maskCount < 32) {
                return new SvgSample(color, null, sig);
            }
            Bitmap mask = Bitmap.createBitmap(MASK_DIM, MASK_DIM, Bitmap.Config.ARGB_8888);
            mask.setPixels(maskPixels, 0, MASK_DIM, 0, 0, MASK_DIM, MASK_DIM);
            return new SvgSample(color, mask, sig);
        } catch (Throwable ignored) {
            return new SvgSample(fallbackColor, null, 0);
        } finally {
            if (prevAlpha < 0.99f) {
                try { svgView.setAlpha(prevAlpha); } catch (Throwable ignored) {}
            }
            if (raw != null) raw.recycle();
        }
    }

    static void draw(Canvas canvas, String styleId, Bitmap shapeMask, String previewShape,
                     float size, double t, float blink, boolean isActive, int baseColor, boolean isDark) {
        if (size <= 0f) return;
        if (STYLE_OFFICIAL.equals(styleId)) {
            drawOfficialPreview(canvas, size);
            return;
        }
        Palette pal = paletteForColor(baseColor, isDark);
        String style = isValidStyle(styleId) ? styleId : STYLE_CHASSIS;
        Path fallbackPath = pathForPreviewShape(previewShape);
        switch (style) {
            case STYLE_ANTENNA:
                drawAntenna(canvas, shapeMask, fallbackPath, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_VISOR:
                drawVisor(canvas, shapeMask, fallbackPath, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_PIXEL:
                drawPixel(canvas, shapeMask, fallbackPath, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_ORB:
                drawOrb(canvas, shapeMask, fallbackPath, size, t, blink, isActive, pal, isDark);
                break;
            case STYLE_CHASSIS:
            default:
                drawChassis(canvas, shapeMask, fallbackPath, size, t, blink, isActive, pal, isDark);
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

    /** Renders either an extracted 64x64 shape silhouette mask or a 0..100 procedural fallback path. */
    private static void drawShapeBody(Canvas canvas, Bitmap shapeMask, Path fallbackPath,
                                      Palette pal, boolean isDark) {
        if (shapeMask != null && !shapeMask.isRecycled()) {
            Rect src = new Rect(0, 0, shapeMask.getWidth(), shapeMask.getHeight());
            RectF dst = new RectF(0f, 0f, 100f, 100f);

            Paint rimPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
            rimPaint.setColorFilter(new PorterDuffColorFilter(isDark ? 0x38FFFFFF : 0x2E0F172A, PorterDuff.Mode.SRC_IN));
            canvas.save();
            canvas.translate(50f, 50f);
            canvas.scale(1.045f, 1.045f);
            canvas.translate(-50f, -50f);
            canvas.drawBitmap(shapeMask, src, dst, rimPaint);
            canvas.restore();

            int layer = canvas.saveLayer(dst, null);
            Paint bmpPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
            canvas.drawBitmap(shapeMask, src, dst, bmpPaint);
            Paint fillPaint = bodyGradPaint(pal, 8f, 92f);
            fillPaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
            canvas.drawRect(dst, fillPaint);
            canvas.restoreToCount(layer);
            return;
        }

        canvas.drawPath(fallbackPath, bodyGradPaint(pal, 8f, 92f));
        Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        strokePaint.setStyle(Paint.Style.STROKE);
        strokePaint.setStrokeWidth(2.4f);
        strokePaint.setColor(isDark ? 0x38FFFFFF : 0x2E0F172A);
        canvas.drawPath(fallbackPath, strokePaint);
    }

    private static void drawChassis(Canvas canvas, Bitmap shapeMask, Path fallbackPath, float s,
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

        drawShapeBody(canvas, shapeMask, fallbackPath, pal, isDark);

        float bx = 74f, by = 22f;
        float beaconScale = isActive
                ? (float) (0.85 + Math.abs(Math.sin(t * 7.0)) * 0.45)
                : (float) (1.0 + Math.sin(t * 3.0) * 0.12);
        if (isActive) {
            float halo = (float) ((t * 1.4) % 1.0);
            Paint haloPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            haloPaint.setStyle(Paint.Style.STROKE);
            haloPaint.setStrokeWidth(1.8f);
            haloPaint.setColor(pal.accent);
            haloPaint.setAlpha(Math.max(0, Math.min(255, Math.round((1f - halo) * 0.65f * 255f))));
            canvas.drawCircle(bx, by, 4.2f + halo * 7.2f, haloPaint);
        }
        Paint beaconPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        beaconPaint.setColor(pal.accent);
        canvas.drawCircle(bx, by, 4.2f * beaconScale, beaconPaint);

        Paint eyePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        eyePaint.setColor(Color.WHITE);
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
        RectF r = new RectF(-w / 2f, -h / 2f, w / 2f, h / 2f);
        canvas.drawRoundRect(r, w / 2f, w / 2f, paint);
        canvas.restore();
    }

    private static void drawAntenna(Canvas canvas, Bitmap shapeMask, Path fallbackPath, float s,
                                    double t, float blink, boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float sc = s / 100f;
        float bob = (float) (isActive ? Math.sin(t * 7.0) * s * 0.022 : Math.sin(t * 2.4) * s * 0.010);
        float sway = (float) (Math.sin(t * (isActive ? 7.5 : 2.6)) * 0.14);

        canvas.translate(0f, bob);
        canvas.scale(sc, sc);

        Paint stemPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        stemPaint.setStyle(Paint.Style.STROKE);
        stemPaint.setColor(pal.mid);
        stemPaint.setStrokeWidth(4.0f);
        stemPaint.setStrokeCap(Paint.Cap.ROUND);

        Paint tipPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        tipPaint.setColor(pal.accent);

        for (int side = -1; side <= 1; side += 2) {
            float rootX = 50f + side * 14f;
            float rootY = 27f;
            float tipX = rootX + side * 6f + (float) Math.sin(t * 3.0 + side) * 2.2f + sway * 7f;
            float tipY = 8f + Math.abs(sway) * 2f;
            Path stem = new Path();
            stem.moveTo(rootX, rootY);
            stem.quadTo(rootX + side * 2f, (rootY + tipY) / 2f, tipX, tipY);
            canvas.drawPath(stem, stemPaint);
            if (isActive) {
                float pulse = (float) ((t * 1.8 + (side > 0 ? 0.5 : 0.0)) % 1.0);
                Paint pPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                pPaint.setStyle(Paint.Style.STROKE);
                pPaint.setStrokeWidth(1.8f);
                pPaint.setColor(pal.accent);
                pPaint.setAlpha(Math.max(0, Math.min(255, Math.round((1f - pulse) * 0.6f * 255f))));
                canvas.drawCircle(tipX, tipY, 3.8f + pulse * 6.5f, pPaint);
            }
            canvas.drawCircle(tipX, tipY, 4.4f, tipPaint);
        }

        canvas.save();
        canvas.translate(50f, 57f);
        canvas.scale(0.84f, 0.84f);
        canvas.translate(-50f, -50f);
        drawShapeBody(canvas, shapeMask, fallbackPath, pal, isDark);
        canvas.restore();

        float vw = 44f, vh = 24f, vx = 50f - vw / 2f, vy = 56f - vh / 2f;
        Paint visor = new Paint(Paint.ANTI_ALIAS_FLAG);
        visor.setColor(0xFF0F172A);
        canvas.drawRoundRect(new RectF(vx, vy, vx + vw, vy + vh), vh * 0.45f, vh * 0.45f, visor);

        Paint eye = new Paint(Paint.ANTI_ALIAS_FLAG);
        eye.setColor(Color.WHITE);
        Paint gl = new Paint(Paint.ANTI_ALIAS_FLAG);
        gl.setColor(pal.accent);
        float gx = isActive ? (float) (Math.sin(t * 4.5) * vw * 0.07) : 0f;
        float gy = isActive ? -vh * 0.06f : 0f;
        float eh = vh * 0.48f * Math.max(0.1f, 1f - blink);
        float ew = vw * 0.18f;
        for (int side = -1; side <= 1; side += 2) {
            float ex = vx + vw / 2f + side * vw * 0.21f + gx;
            float ey = vy + vh / 2f + gy;
            canvas.drawOval(new RectF(ex - ew / 2f, ey - eh / 2f, ex + ew / 2f, ey + eh / 2f), eye);
            if (eh > 5f) {
                canvas.drawCircle(ex - ew * 0.12f, ey - eh * 0.16f, ew * 0.16f, gl);
            }
        }
        canvas.restore();
    }

    private static void drawVisor(Canvas canvas, Bitmap shapeMask, Path fallbackPath, float s,
                                  double t, float blink, boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float sc = s / 100f;
        float bob = (float) (isActive ? Math.sin(t * 7.2) * s * 0.02 : Math.sin(t * 2.0) * s * 0.01);
        canvas.translate(0f, bob);
        canvas.scale(sc, sc);

        drawShapeBody(canvas, shapeMask, fallbackPath, pal, isDark);

        float vw = 50f, vh = 22f, vx = 50f - vw / 2f, vy = 52f - vh / 2f;
        Paint band = new Paint(Paint.ANTI_ALIAS_FLAG);
        band.setColor(0xFF090D16);
        canvas.drawRoundRect(new RectF(vx, vy, vx + vw, vy + vh), 6.5f, 6.5f, band);
        Paint bandBorder = new Paint(Paint.ANTI_ALIAS_FLAG);
        bandBorder.setStyle(Paint.Style.STROKE);
        bandBorder.setStrokeWidth(1.6f);
        bandBorder.setColor(0x2EFFFFFF);
        canvas.drawRoundRect(new RectF(vx, vy, vx + vw, vy + vh), 6.5f, 6.5f, bandBorder);

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
            float h = vh * 0.46f * Math.max(0.12f, 1f - blink);
            for (int side = -1; side <= 1; side += 2) {
                float cx = vx + vw / 2f + side * vw * 0.21f;
                float cy = vy + vh / 2f;
                canvas.drawRoundRect(new RectF(cx - vw * 0.07f, cy - h / 2f, cx + vw * 0.07f, cy + h / 2f),
                        2.6f, 2.6f, led);
            }
        }
        canvas.restore();
    }

    private static void drawPixel(Canvas canvas, Bitmap shapeMask, Path fallbackPath, float s,
                                  double t, float blink, boolean isActive, Palette pal, boolean isDark) {
        canvas.save();
        float sc = s / 100f;
        if (isActive) {
            canvas.translate(0f, (float) (Math.sin(t * 7.0) * s * 0.018));
        }
        canvas.scale(sc, sc);

        drawShapeBody(canvas, shapeMask, fallbackPath, pal, isDark);

        float mw = 42f, mh = 31f, mx = 50f - mw / 2f, my = 55f - mh / 2f;
        Paint screen = new Paint(Paint.ANTI_ALIAS_FLAG);
        screen.setColor(0xFF0B101B);
        canvas.drawRoundRect(new RectF(mx, my, mx + mw, my + mh), 6f, 6f, screen);

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
        for (int i = 0; i < 3; i++) {
            dot.setColor(isActive && i == barPhase ? Color.WHITE : pal.accent);
            float bx = 50f - 11f + i * 8.2f;
            float by = my - 6.2f;
            canvas.drawRect(bx, by, bx + 5.6f, by + 2.8f, dot);
        }
        canvas.restore();
    }

    private static void drawOrb(Canvas canvas, Bitmap shapeMask, Path fallbackPath, float s,
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

        drawShapeBody(canvas, shapeMask, fallbackPath, pal, isDark);

        Paint eye = new Paint(Paint.ANTI_ALIAS_FLAG);
        eye.setColor(Color.WHITE);
        float eyeSy = Math.max(0.1f, 1f - blink);
        float gx = isActive ? (float) (Math.sin(t * 4.0) * 3.0) : 0f;
        float gy = isActive ? -2.2f : 0f;
        drawTiltedCapsule(canvas, eye, 40.5f + gx, 52f + gy, 9.2f, 22f, -24f, eyeSy);
        drawTiltedCapsule(canvas, eye, 59.5f + gx, 48f + gy, 9.2f, 18f, -24f, eyeSy);

        double satA = t * (isActive ? 2.8 : 1.1) - 0.8;
        float satDist = 44f;
        Paint sat = new Paint(Paint.ANTI_ALIAS_FLAG);
        sat.setColor(pal.accent);
        canvas.drawCircle(50f + (float) (Math.cos(satA) * satDist),
                50f + (float) (Math.sin(satA) * satDist * 0.88), 4.6f, sat);
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

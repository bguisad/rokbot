package dev.rokbot.nativeapp;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Path;
import android.graphics.PathMeasure;
import android.graphics.RectF;
import android.os.Build;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Reads the official Bot silhouette straight out of react-native-svg as a vector: every
 * {@code com.horcrux.svg.RenderableView} keeps the {@link Path} parsed from its SVG {@code d}
 * (in its own user units) and, once drawn, {@code mCTM}, the matrix from those units to the
 * SvgView's pixels. The body path(s) are mapped into a 0..100 design box over the host view, so
 * RokBot styles draw them with {@link Canvas#drawPath} at any size (no bitmap mask, no filtering).
 * Eye cut-outs are filled by a vector union of the outline's contours.
 */
final class RokBotSvgVector {
    private static final String TAG = "RokBotSvgVector";
    private static final String RENDERABLE = "com.horcrux.svg.RenderableView";
    private static final String VIRTUAL = "com.horcrux.svg.VirtualView";

    /** A Bot silhouette in 0..100 design units over its box, with the Bot's body color. */
    static final class Shape {
        final Path path;
        final int color;
        final long key;
        final RectF bounds = new RectF();

        Shape(Path path, int color, long key) {
            this.path = path;
            this.color = color;
            this.key = key;
            path.computeBounds(bounds, true);
        }
    }

    private static boolean sReflectReady;
    private static boolean sReflectOk;
    private static Class<?> sRenderable;
    private static Class<?> sVirtual;
    private static Field fCtm;
    private static Field fMPath;
    private static Field fFill;

    private RokBotSvgVector() {}

    private static synchronized boolean ready(View anyNode) {
        if (sReflectReady) return sReflectOk;
        sReflectReady = true;
        try {
            ClassLoader cl = anyNode.getClass().getClassLoader();
            sRenderable = Class.forName(RENDERABLE, false, cl);
            Class<?> virtual = Class.forName(VIRTUAL, false, cl);
            sVirtual = virtual;
            fCtm = virtual.getDeclaredField("mCTM");
            fCtm.setAccessible(true);
            fMPath = virtual.getDeclaredField("mPath");
            fMPath.setAccessible(true);
            try {
                fFill = sRenderable.getDeclaredField("fill");
                fFill.setAccessible(true);
            } catch (Throwable t) {
                fFill = null;
            }
            sReflectOk = true;
        } catch (Throwable t) {
            Log.w(TAG, "react-native-svg internals not found: " + t);
            sReflectOk = false;
        }
        return sReflectOk;
    }

    /** One drawable node of the SVG: its own path, the matrix to SvgView pixels and its fill. */
    private static final class Node {
        Path path;
        Matrix ctm;
        boolean filled;
    }

    private static void collect(View v, List<Node> out, int depth) {
        if (v == null || depth > 12) return;
        // Groups (G, Svg-in-Svg) are renderables too, but their path is their children's: only leaves count.
        boolean leaf = !(v instanceof ViewGroup) || ((ViewGroup) v).getChildCount() == 0;
        if (leaf && sRenderable.isInstance(v)) {
            Node n = new Node();
            try {
                n.ctm = (Matrix) fCtm.get(v);
                n.path = ownPath(v);
                // Only whether a fill is set: the brush array is a JNI-backed ReadableNativeArray that
                // belongs to React Native's threads, so its contents are never read from here.
                n.filled = fFill == null || fFill.get(v) != null;
            } catch (Throwable ignored) {}
            if (n.path != null && n.ctm != null) out.add(n);
        }
        // Definitions (Defs, Mask, Pattern, ...) are virtual but not renderable: never drawn as is.
        if (sVirtual.isInstance(v) && !sRenderable.isInstance(v)) return;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) collect(g.getChildAt(i), out, depth + 1);
        }
    }

    /** The node's parsed geometry: PathView keeps it in its own (obfuscated) Path field; others in mPath. */
    private static Path ownPath(View v) throws IllegalAccessException {
        for (Class<?> c = v.getClass(); c != null && c != sRenderable; c = c.getSuperclass()) {
            for (Field f : c.getDeclaredFields()) {
                if (f.getType() == Path.class && !java.lang.reflect.Modifier.isStatic(f.getModifiers())) {
                    f.setAccessible(true);
                    Object p = f.get(v);
                    if (p instanceof Path) return (Path) p;
                }
            }
        }
        Object p = fMPath.get(v);
        return p instanceof Path ? (Path) p : null;
    }

    private static boolean nearWhite(int c) {
        return Color.red(c) > 232 && Color.green(c) > 232 && Color.blue(c) > 232;
    }

    /**
     * The Bot body of one official mark as a vector shape over {@code box} (cropped by {@code inset}
     * of the box on each side; negative = margin), or {@code previous} when nothing changed.
     */
    static Shape extract(View svg, View box, float inset, Shape previous) {
        return extract(svg, box, inset, previous, true);
    }

    /**
     * {@code sampleColor = false} is the per-frame path for the animated mark: the SVG is only drawn
     * into a 1 x 1 canvas (which re-renders it, refreshing mCTM, only when React Native changed it)
     * and the previous color is kept.
     */
    static Shape extract(View svg, View box, float inset, Shape previous, boolean sampleColor) {
        if (svg == null || box == null || !ready(svg)) return null;
        int bw = box.getWidth();
        int bh = box.getHeight();
        if (bw <= 0 || bh <= 0 || svg.getWidth() <= 0 || svg.getHeight() <= 0) return null;
        float dx = 0f, dy = 0f;
        View cur = svg;
        while (cur != null && cur != box) {
            dx += cur.getLeft();
            dy += cur.getTop();
            if (!(cur.getParent() instanceof View)) return null;
            cur = (View) cur.getParent();
        }
        if (cur != box) return null;
        float rl = bw * inset, rt = bh * inset;
        float rw = bw * (1f - 2f * inset), rh = bh * (1f - 2f * inset);
        // A small draw brings mCTM up to date (the official view is hidden, so React Native no longer
        // draws it) and gives the dominant body color for gradient / currentColor fills.
        int sampled;
        if (sampleColor || previous == null) {
            sampled = sampleColor(svg, dx - rl, dy - rt, rw, rh);
        } else {
            refresh(svg);
            sampled = previous.color & 0xFFFFFF | 0xFF000000;
        }
        List<Node> nodes = new ArrayList<>();
        collect(svg, nodes, 0);
        if (nodes.isEmpty()) return null;
        long key = 17L + bw * 31L + bh * 131L + Float.floatToIntBits(inset) + Float.floatToIntBits(dx) * 7L
                + Float.floatToIntBits(dy) * 13L + sampled;
        float[] mv = new float[9];
        for (Node n : nodes) {
            key = key * 31L + System.identityHashCode(n.path) + (n.filled ? 1 : 0);
            n.ctm.getValues(mv);
            for (float f : mv) key = key * 31L + Float.floatToIntBits(f);
        }
        if (previous != null && previous.key == key) return previous;

        Matrix toDesign = new Matrix();
        toDesign.setTranslate(dx - rl, dy - rt);
        toDesign.postScale(100f / rw, 100f / rh);

        // Body = the largest filled leaf (eyes, highlights and the picker's unfilled ring are smaller
        // or unfilled); its color is the dominant drawn color.
        Path largest = null;
        float largestArea = 0f;
        RectF b = new RectF();
        for (Node n : nodes) {
            if (!n.filled) continue;
            Path p = new Path(n.path);
            p.transform(n.ctm);
            p.transform(toDesign);
            p.computeBounds(b, true);
            if (b.width() * b.height() > largestArea) {
                largestArea = b.width() * b.height();
                largest = p;
            }
        }
        if (largest == null || largestArea < 4f) return null;
        int color = sampled != 0 ? sampled : 0xFF1E86FC;
        return new Shape(fillContours(largest), 0xFF000000 | color, key);
    }

    /** Every contour filled on its own, unioned: the outline with any holes (eye cut-outs) filled. */
    static Path fillContours(Path src) {
        Path out = new Path();
        PathMeasure pm = new PathMeasure(src, false);
        boolean any = false;
        do {
            float len = pm.getLength();
            if (len <= 0f) continue;
            Path c = new Path();
            if (pm.getSegment(0f, len, c, true)) {
                c.close();
                c.setFillType(Path.FillType.WINDING);
                if (!any) out.set(c);
                else out.op(c, Path.Op.UNION);
                any = true;
            }
        } while (pm.nextContour());
        if (!any) return new Path(src);
        out.setFillType(Path.FillType.WINDING);
        return out;
    }

    private static Bitmap sTiny;
    private static Canvas sTinyCanvas;

    /** Lets the (hidden) SvgView re-render if its props changed, so mCTM matches its current path. */
    private static void refresh(View svg) {
        try {
            if (sTiny == null) {
                sTiny = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
                sTinyCanvas = new Canvas(sTiny);
            }
            int save = sTinyCanvas.save();
            sTinyCanvas.clipRect(0, 0, 1, 1);
            svg.draw(sTinyCanvas);
            sTinyCanvas.restoreToCount(save);
        } catch (Throwable ignored) {}
    }

    /** Dominant opaque, non-white color of the SVG drawn into 24 x 24 over the design box. */
    private static int sampleColor(View svg, float ox, float oy, float rw, float rh) {
        final int n = 24;
        Bitmap raw = null;
        try {
            raw = Bitmap.createBitmap(n, n, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(raw);
            c.scale(n / rw, n / rh);
            c.translate(ox, oy);
            svg.draw(c);
            int[] px = new int[n * n];
            raw.getPixels(px, 0, n, 0, 0, n, n);
            int[] counts = new int[4096];
            int best = -1, bestCount = 0;
            for (int p : px) {
                if ((p >>> 24) < 200 || nearWhite(p)) continue;
                int k = ((Color.red(p) >> 4) << 8) | ((Color.green(p) >> 4) << 4) | (Color.blue(p) >> 4);
                if (++counts[k] > bestCount) { bestCount = counts[k]; best = k; }
            }
            if (best < 0) return 0;
            long sr = 0, sg = 0, sb = 0; int cnt = 0;
            for (int p : px) {
                if ((p >>> 24) < 200 || nearWhite(p)) continue;
                int k = ((Color.red(p) >> 4) << 8) | ((Color.green(p) >> 4) << 4) | (Color.blue(p) >> 4);
                if (k != best) continue;
                sr += Color.red(p); sg += Color.green(p); sb += Color.blue(p); cnt++;
            }
            return Color.rgb((int) (sr / cnt), (int) (sg / cnt), (int) (sb / cnt));
        } catch (Throwable t) {
            return 0;
        } finally {
            if (raw != null) raw.recycle();
        }
    }

    /** SVG path data of {@code p} (absolute M/L/Q/C/Z, conics as cubics), for harvesting only (API 34+). */
    static String toPathData(Path p) {
        if (Build.VERSION.SDK_INT < 34) return null;
        StringBuilder sb = new StringBuilder();
        // Iterate a private copy: never walk a path React Native may still own.
        android.graphics.PathIterator it = new Path(p).getPathIterator();
        float[] pt = new float[8];
        while (it.hasNext()) {
            int verb = it.next(pt, 0);
            switch (verb) {
                case android.graphics.PathIterator.VERB_MOVE:
                    sb.append('M').append(num(pt[0])).append(' ').append(num(pt[1]));
                    break;
                case android.graphics.PathIterator.VERB_LINE:
                    sb.append('L').append(num(pt[2])).append(' ').append(num(pt[3]));
                    break;
                case android.graphics.PathIterator.VERB_QUAD:
                    sb.append('Q').append(num(pt[2])).append(' ').append(num(pt[3])).append(' ')
                            .append(num(pt[4])).append(' ').append(num(pt[5]));
                    break;
                case android.graphics.PathIterator.VERB_CONIC: {
                    float w = pt[6]; // next(float[], int) stores the conic weight after the 3 points
                    float k = 4f * w / (3f * (1f + w));
                    float c1x = pt[0] + (pt[2] - pt[0]) * k, c1y = pt[1] + (pt[3] - pt[1]) * k;
                    float c2x = pt[4] + (pt[2] - pt[4]) * k, c2y = pt[5] + (pt[3] - pt[5]) * k;
                    sb.append('C').append(num(c1x)).append(' ').append(num(c1y)).append(' ')
                            .append(num(c2x)).append(' ').append(num(c2y)).append(' ')
                            .append(num(pt[4])).append(' ').append(num(pt[5]));
                    break;
                }
                case android.graphics.PathIterator.VERB_CUBIC:
                    sb.append('C').append(num(pt[2])).append(' ').append(num(pt[3])).append(' ')
                            .append(num(pt[4])).append(' ').append(num(pt[5])).append(' ')
                            .append(num(pt[6])).append(' ').append(num(pt[7]));
                    break;
                case android.graphics.PathIterator.VERB_CLOSE:
                    sb.append('Z');
                    break;
                default:
                    break;
            }
        }
        return sb.toString();
    }

    private static String num(float f) {
        String s = String.format(Locale.ROOT, "%.2f", f);
        if (s.indexOf('.') >= 0) {
            int end = s.length();
            while (s.charAt(end - 1) == '0') end--;
            if (s.charAt(end - 1) == '.') end--;
            s = s.substring(0, end);
        }
        return "-0".equals(s) ? "0" : s;
    }

    /** Debug (adb shell setprop log.tag.RokBotSvgVector DEBUG): the SVG's drawable nodes. */
    static void dump(View svg, String label) {
        if (svg == null || !ready(svg) || !Log.isLoggable(TAG, Log.DEBUG)) return;
        dumpTree(svg, label, 0);
    }

    private static void dumpTree(View v, String label, int depth) {
        if (v == null || depth > 12) return;
        StringBuilder sb = new StringBuilder(label).append(' ');
        for (int i = 0; i < depth; i++) sb.append("  ");
        sb.append(v.getClass().getName()).append(' ').append(v.getWidth()).append('x').append(v.getHeight());
        if (sRenderable.isInstance(v)) {
            try {
                Path own = ownPath(v);
                Matrix ctm = (Matrix) fCtm.get(v);
                Object fill = fFill != null ? fFill.get(v) : null;
                sb.append(" fill=").append(fill == null ? "none" : "set");
                if (own != null) {
                    RectF b = new RectF();
                    Path p = new Path(own);
                    if (ctm != null) p.transform(ctm);
                    p.computeBounds(b, true);
                    sb.append(" bounds=").append(b.toShortString()).append(" id=").append(System.identityHashCode(own));
                }
                if (ctm != null) sb.append(" ctm=").append(ctm.toShortString());
            } catch (Throwable t) {
                sb.append(" err=").append(t);
            }
        }
        Log.d(TAG, sb.toString());
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) dumpTree(g.getChildAt(i), label, depth + 1);
        }
    }
}

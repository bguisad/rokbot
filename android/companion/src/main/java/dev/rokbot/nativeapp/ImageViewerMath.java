package dev.rokbot.nativeapp;

import java.util.ArrayList;
import java.util.List;

/**
 * Plain-Java geometry for the high-resolution chat image viewer (no android.* so it runs on a JVM
 * in tests). Scales are screen pixels per image pixel; image sizes are already EXIF-oriented.
 */
final class ImageViewerMath {
    private ImageViewerMath() {}

    /** Source tile edge, in pixels of the decoded (sampled) bitmap. */
    static final int TILE = 512;
    /** The base layer stays below this many pixels and this edge, so it is cheap and always uploadable as a texture. */
    static final long BASE_MAX_PIXELS = 4L * 1024 * 1024;
    static final int BASE_MAX_EDGE = 4096;

    /**
     * Whether the official viewer can not show this image sharply. expo-image decodes to the view size and its
     * zoom stops at about 4x the contain fit, so anything clearly larger than the screen goes to the native viewer;
     * screen-sized and smaller images keep the official viewer.
     */
    static boolean needsTakeover(int imageW, int imageH, int screenW, int screenH) {
        if (imageW <= 0 || imageH <= 0 || screenW <= 0 || screenH <= 0) return false;
        return imageW > screenW * 1.25f || imageH > screenH * 1.25f;
    }

    static float containScale(int imageW, int imageH, int viewW, int viewH) {
        if (imageW <= 0 || imageH <= 0 || viewW <= 0 || viewH <= 0) return 1f;
        return Math.min(viewW / (float) imageW, viewH / (float) imageH);
    }

    static float fitWidthScale(int imageW, int viewW) {
        if (imageW <= 0 || viewW <= 0) return 1f;
        return viewW / (float) imageW;
    }

    /** A tall image would be a thin strip when contained (under 60% of the width): open it at the full width. */
    static boolean isTall(int imageW, int imageH, int viewW, int viewH) {
        if (imageW <= 0 || imageH <= 0 || viewW <= 0 || viewH <= 0) return false;
        return imageW * containScale(imageW, imageH, viewW, viewH) < viewW * 0.6f;
    }

    static float initialScale(int imageW, int imageH, int viewW, int viewH) {
        return isTall(imageW, imageH, viewW, viewH) ? fitWidthScale(imageW, viewW) : containScale(imageW, imageH, viewW, viewH);
    }

    static float minScale(int imageW, int imageH, int viewW, int viewH) {
        return Math.min(containScale(imageW, imageH, viewW, viewH), initialScale(imageW, imageH, viewW, viewH));
    }

    /** Up to 4x the opening fit, and always at least 3 screen pixels per image pixel so small text gets large. */
    static float maxScale(int imageW, int imageH, int viewW, int viewH) {
        return Math.max(initialScale(imageW, imageH, viewW, viewH) * 4f, 3f);
    }

    /** Double tap: from the opening fit go to 1:1 (at least 2.5x the fit); from anywhere else go back. */
    static float doubleTapTarget(float current, float initial, float max) {
        if (current > initial * 1.2f) return initial;
        return Math.min(max, Math.max(initial * 2.5f, 1f));
    }

    /** Largest power of two that is at most the number of image pixels per screen pixel (at least 1). */
    static int sampleSize(float scale) {
        if (!(scale > 0f)) return 1;
        float perScreenPixel = 1f / scale;
        int sample = 1;
        while (sample * 2 <= perScreenPixel) sample *= 2;
        return sample;
    }

    /** Sample of the always-present base layer: good enough at the smallest zoom, within the size limits. */
    static int baseSampleSize(int srcW, int srcH, float minScale) {
        int sample = sampleSize(minScale);
        while ((srcW / sample > BASE_MAX_EDGE || srcH / sample > BASE_MAX_EDGE
                || (long) (srcW / sample) * (srcH / sample) > BASE_MAX_PIXELS) && sample < (1 << 12)) {
            sample *= 2;
        }
        return sample;
    }

    /**
     * Offset of content of the given size along one axis: centered when it fits, otherwise kept so no gap shows
     * at either edge.
     */
    static float clampOffset(float offset, float content, float view) {
        if (content <= view) return (view - content) / 2f;
        return Math.max(view - content, Math.min(0f, offset));
    }

    /** Tiles of the sampled grid (in source pixels) that cover the visible source rectangle. */
    static List<int[]> tiles(float left, float top, float right, float bottom, int srcW, int srcH, int sample) {
        List<int[]> out = new ArrayList<>();
        if (srcW <= 0 || srcH <= 0 || sample <= 0) return out;
        int edge = TILE * sample;
        int c0 = Math.max(0, (int) Math.floor(Math.max(0f, left) / edge));
        int r0 = Math.max(0, (int) Math.floor(Math.max(0f, top) / edge));
        int c1 = Math.min((srcW - 1) / edge, (int) Math.floor(Math.min(srcW - 1f, right) / edge));
        int r1 = Math.min((srcH - 1) / edge, (int) Math.floor(Math.min(srcH - 1f, bottom) / edge));
        for (int r = r0; r <= r1; r++) {
            for (int c = c0; c <= c1; c++) {
                int x = c * edge, y = r * edge;
                out.add(new int[] { c, r, x, y, Math.min(srcW, x + edge), Math.min(srcH, y + edge) });
            }
        }
        return out;
    }

    /** EXIF orientation tag (1..8) to a clockwise rotation; mirrored variants keep their rotation part. */
    static int rotationOf(int exifOrientation) {
        switch (exifOrientation) {
            case 3: case 4: return 180;
            case 5: case 6: return 90;
            case 7: case 8: return 270;
            default: return 0;
        }
    }

    /** Stable cache key for a (possibly multi-megabyte) data: or file URI. */
    static String sourceKey(String uri) {
        if (uri == null) return "";
        return Integer.toHexString(uri.hashCode()) + "-" + uri.length();
    }

    /**
     * Streams the base64 payload of a data URL (from {@code start}) to {@code out} in 64 KiB pieces, without copying
     * the multi-megabyte string; whitespace inside the payload is skipped.
     */
    static void decodeBase64(String uri, int start, java.io.OutputStream out) throws java.io.IOException {
        final int chunk = 64 * 1024;
        java.util.Base64.Decoder decoder = java.util.Base64.getDecoder();
        char[] chars = new char[chunk];
        byte[] ascii = new byte[chunk + 4];
        int carry = 0;
        for (int pos = start; pos < uri.length(); ) {
            int end = Math.min(uri.length(), pos + chunk);
            uri.getChars(pos, end, chars, 0);
            int n = carry;
            for (int i = 0; i < end - pos; i++) {
                char c = chars[i];
                if (c > ' ' && c < 128) ascii[n++] = (byte) c;
            }
            pos = end;
            int usable = pos < uri.length() ? n - (n % 4) : n;
            if (usable > 0) out.write(decoder.decode(java.util.Arrays.copyOf(ascii, usable)));
            carry = n - usable;
            System.arraycopy(ascii, usable, ascii, 0, carry);
        }
    }

    /** Index of the data payload in a base64 data URL, or -1. */
    static int base64PayloadStart(String uri) {
        if (uri == null || !uri.regionMatches(true, 0, "data:", 0, 5)) return -1;
        int comma = uri.indexOf(',');
        if (comma < 0) return -1;
        String meta = uri.substring(5, comma).toLowerCase(java.util.Locale.ROOT);
        return meta.endsWith(";base64") ? comma + 1 : -1;
    }
}

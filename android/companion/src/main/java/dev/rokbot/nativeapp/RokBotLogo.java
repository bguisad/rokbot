package dev.rokbot.nativeapp;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;

/**
 * The RokBot logo exactly as assets/logo/rokbot-logo.svg draws it, as vectors in a 1024 x 1024
 * design box: a 30%-radius tile with a 160 deg #F4FBFE -> #C9EEF7 gradient, a soft white inner rim
 * and a faint teal hairline edge, carrying the dark RokBot head (chassis, slanted eyes and the cyan
 * status node) at {@link #GLYPH_SCALE} of the tile.
 */
final class RokBotLogo {
    private RokBotLogo() {}

    static final float TILE_RADIUS = 308f;
    static final int TILE_TOP = 0xFFF4FBFE;
    static final int TILE_BOTTOM = 0xFFC9EEF7;
    static final float GLYPH_SCALE = 0.84f;
    static final float GLYPH_CENTER_Y = 506f;

    /** Parsed once; drawing only reads it. */
    private static final Path CHASSIS = buildChassis();
    private static final Shader HEAD_FILL = new LinearGradient(512f, 56f, 512f, 960f, 0xFF242936, 0xFF12141B, Shader.TileMode.CLAMP);

    /** A copy of the chassis outline (1024 design box) the caller may transform (notification icon). */
    static Path chassisPath() {
        return new Path(CHASSIS);
    }

    private static Path buildChassis() {
        Path head = new Path();
        head.moveTo(340f, 148f);
        head.cubicTo(408f, 148f, 476f, 144f, 540f, 144f);
        head.cubicTo(618f, 144f, 664f, 60f, 756f, 56f);
        head.cubicTo(836f, 52f, 892f, 104f, 884f, 176f);
        head.cubicTo(878f, 214f, 932f, 272f, 956f, 368f);
        head.cubicTo(964f, 464f, 960f, 564f, 948f, 656f);
        head.cubicTo(928f, 816f, 820f, 924f, 636f, 944f);
        head.cubicTo(532f, 956f, 424f, 960f, 324f, 952f);
        head.cubicTo(156f, 938f, 76f, 836f, 68f, 668f);
        head.cubicTo(62f, 548f, 64f, 424f, 72f, 336f);
        head.cubicTo(84f, 200f, 184f, 148f, 340f, 148f);
        head.close();
        return head;
    }

    /** Draws the logo into a size x size box at the canvas origin. */
    static void draw(Canvas canvas, float size) {
        if (size <= 0f) return;
        canvas.save();
        float s = size / 1024f;
        canvas.scale(s, s);

        // Tile: CSS linear-gradient(160deg) runs from (287.55, -104.66) to (736.45, 1128.66).
        Paint tile = new Paint(Paint.ANTI_ALIAS_FLAG);
        tile.setShader(new LinearGradient(287.55f, -104.66f, 736.45f, 1128.66f,
                TILE_TOP, TILE_BOTTOM, Shader.TileMode.CLAMP));
        canvas.drawRoundRect(new RectF(0f, 0f, 1024f, 1024f), TILE_RADIUS, TILE_RADIUS, tile);

        Paint rim = new Paint(Paint.ANTI_ALIAS_FLAG);
        rim.setStyle(Paint.Style.STROKE);
        rim.setStrokeWidth(8f);
        rim.setColor(0xE6FFFFFF);
        canvas.drawRoundRect(new RectF(12f, 12f, 1012f, 1012f), 296f, 296f, rim);

        // Hairline edge: at least one device pixel so the near-white tile reads on light pages.
        float edgeWidth = Math.max(4f, 1f / s);
        Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
        edge.setStyle(Paint.Style.STROKE);
        edge.setStrokeWidth(edgeWidth);
        edge.setColor(0x290E4A5C);
        float e = edgeWidth / 2f;
        canvas.drawRoundRect(new RectF(e, e, 1024f - e, 1024f - e), TILE_RADIUS - e, TILE_RADIUS - e, edge);

        // Head: translate(512 512) scale(0.84) translate(-512 -506), as in the master SVG.
        canvas.translate(512f, 512f);
        canvas.scale(GLYPH_SCALE, GLYPH_SCALE);
        canvas.translate(-512f, -GLYPH_CENTER_Y);
        drawHead(canvas);
        canvas.restore();
    }

    /** The dark head alone, in master coordinates. */
    static void drawHead(Canvas canvas) {
        Path head = CHASSIS;
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setShader(HEAD_FILL);
        canvas.drawPath(head, fill);
        Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(20f);
        stroke.setStrokeJoin(Paint.Join.ROUND);
        stroke.setColor(0xFF303747);
        canvas.drawPath(head, stroke);
        Paint eye = new Paint(Paint.ANTI_ALIAS_FLAG);
        eye.setColor(0xFFF5F5F4);
        canvas.save();
        canvas.rotate(-26f, 376f, 564f);
        canvas.drawRoundRect(new RectF(304f, 396f, 448f, 732f), 72f, 72f, eye);
        canvas.restore();
        canvas.save();
        canvas.rotate(-26f, 648f, 504f);
        canvas.drawRoundRect(new RectF(576f, 370f, 720f, 638f), 72f, 72f, eye);
        canvas.restore();
        Paint accent = new Paint(Paint.ANTI_ALIAS_FLAG);
        accent.setColor(0xFF38BDF8);
        canvas.drawCircle(768f, 144f, 42f, accent);
    }

    /** The logo as a Drawable, centered in its bounds (native pages, React Native app-mark overlays). */
    static final class LogoDrawable extends Drawable {
        private final int intrinsic;

        LogoDrawable() { this(-1); }

        LogoDrawable(int intrinsicSizePx) { this.intrinsic = intrinsicSizePx; }

        @Override
        public void draw(Canvas canvas) {
            Rect b = getBounds();
            float size = Math.min(b.width(), b.height());
            if (size <= 0) return;
            canvas.save();
            canvas.translate(b.left + (b.width() - size) / 2f, b.top + (b.height() - size) / 2f);
            RokBotLogo.draw(canvas, size);
            canvas.restore();
        }

        @Override public void setAlpha(int alpha) {}
        @Override public void setColorFilter(ColorFilter colorFilter) {}
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        @Override public int getIntrinsicWidth() { return intrinsic; }
        @Override public int getIntrinsicHeight() { return intrinsic; }
    }
}

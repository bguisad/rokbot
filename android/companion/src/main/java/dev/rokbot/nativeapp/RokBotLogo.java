package dev.rokbot.nativeapp;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * The RokBot logo exactly as assets/logo/rokbot-logo.svg draws it (the desktop, Web and launcher
 * icon): the chassis silhouette with its dark gradient and #4a556b rim, the two slanted eyes and the
 * cyan status node, in a 1024 x 1024 design box.
 */
final class RokBotLogo {
    private RokBotLogo() {}

    static Path chassisPath() {
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
        canvas.save();
        float s = size / 1024f;
        canvas.scale(s, s);
        Path head = chassisPath();
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setShader(new LinearGradient(512f, 56f, 512f, 960f, 0xFF242936, 0xFF12141B, Shader.TileMode.CLAMP));
        canvas.drawPath(head, fill);
        Paint rim = new Paint(Paint.ANTI_ALIAS_FLAG);
        rim.setStyle(Paint.Style.STROKE);
        rim.setStrokeWidth(20f);
        rim.setStrokeJoin(Paint.Join.ROUND);
        rim.setColor(0xFF4A556B);
        canvas.drawPath(head, rim);
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
        canvas.restore();
    }

    /** The logo as a Drawable, centered in its bounds (React Native app-mark overlays, native pages). */
    static final class LogoDrawable extends Drawable {
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
    }
}

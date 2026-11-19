#!/usr/bin/env python3
"""Reproducible multi-resolution icon & asset generator for RokBot.

Renders directly from the exact canonical 1024x1024 cubic Bezier chassis,
-26 deg asymmetric tilted pill eyes, and crest signal beacon defined in
assets/logo/rokbot-logo.svg using 4x supersampled Pillow rendering (LANCZOS),
plus macOS iconutil and multi-resolution ICO/Android/iOS exports.
"""

from __future__ import annotations

import hashlib
import json
import math
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

Image.init()

ROOT = Path(__file__).resolve().parents[2]
LOGO_DIR = Path(__file__).resolve().parent
HOST_ICON_PATH = ROOT / "host" / "server" / "public" / "rokbot-icon.png"

CANVAS = 1024.0
BEZIER_STEPS = 96
ARC_STEPS = 32
SSAA = 4

# Exact canonical cubic Bezier segments matching assets/logo/rokbot-logo.svg (1024x1024)
CHASSIS_SEGMENTS = [
    ((340.0, 148.0), (408.0, 148.0), (476.0, 144.0), (540.0, 144.0)),
    ((540.0, 144.0), (618.0, 144.0), (664.0, 60.0), (756.0, 56.0)),
    ((756.0, 56.0), (836.0, 52.0), (892.0, 104.0), (884.0, 176.0)),
    ((884.0, 176.0), (878.0, 214.0), (932.0, 272.0), (956.0, 368.0)),
    ((956.0, 368.0), (964.0, 464.0), (960.0, 564.0), (948.0, 656.0)),
    ((948.0, 656.0), (928.0, 816.0), (820.0, 924.0), (636.0, 944.0)),
    ((636.0, 944.0), (532.0, 956.0), (424.0, 960.0), (324.0, 952.0)),
    ((324.0, 952.0), (156.0, 938.0), (76.0, 836.0), (68.0, 668.0)),
    ((68.0, 668.0), (62.0, 548.0), (64.0, 424.0), (72.0, 336.0)),
    ((72.0, 336.0), (84.0, 200.0), (184.0, 148.0), (340.0, 148.0)),
]

# Exact tilted pill eyes: (cx, cy, width, height, radius, angle_deg)
EYES = [
    (376.0, 564.0, 144.0, 336.0, 72.0, -26.0),
    (648.0, 504.0, 144.0, 268.0, 72.0, -26.0),
]

# Exact crest signal beacon: (cx, cy, radius)
BEACON = (768.0, 144.0, 42.0)

# Color palette
CHASSIS_TOP = (0x24, 0x29, 0x36, 255)
CHASSIS_BOTTOM = (0x12, 0x14, 0x1B, 255)
RIM_COLOR = (0x4A, 0x55, 0x6B, 255)
EYE_COLOR = (0xF5, 0xF5, 0xF4, 255)
ACCENT_COLOR = (0x38, 0xBD, 0xF8, 255)

IOS_BG_COLOR = (0x12, 0x14, 0x1B)
IOS_FACE_TOP = (0xF8, 0xFA, 0xFC, 255)
IOS_FACE_BOTTOM = (0xE5, 0xE7, 0xEB, 255)
IOS_RIM_COLOR = (0xFF, 0xFF, 0xFF, 255)
IOS_EYE_COLOR = (0x11, 0x13, 0x18, 255)
IOS_ACCENT_COLOR = (0x1E, 0x86, 0xFC, 255)

ANDROID_ROUND_BG = (0x10, 0x12, 0x18, 255)

ROOT_PNG_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICONSET_ENTRIES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]
ANDROID_DENSITIES = [
    ("mdpi", 48, 108),
    ("hdpi", 72, 162),
    ("xhdpi", 96, 216),
    ("xxhdpi", 144, 324),
    ("xxxhdpi", 192, 432),
]
IOS_SIZES = [120, 152, 167, 180, 1024]


def sample_cubic_bezier(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    steps: int = BEZIER_STEPS,
) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for i in range(steps):
        t = i / steps
        u = 1.0 - t
        x = (
            (u**3) * p0[0]
            + 3.0 * (u**2) * t * p1[0]
            + 3.0 * u * (t**2) * p2[0]
            + (t**3) * p3[0]
        )
        y = (
            (u**3) * p0[1]
            + 3.0 * (u**2) * t * p1[1]
            + 3.0 * u * (t**2) * p2[1]
            + (t**3) * p3[1]
        )
        pts.append((x, y))
    return pts


def build_chassis_polygon(glyph_scale: float = 1.0, px_scale: float = 1.0) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for seg in CHASSIS_SEGMENTS:
        for x, y in sample_cubic_bezier(*seg, steps=BEZIER_STEPS):
            tx = 512.0 + (x - 512.0) * glyph_scale
            ty = 512.0 + (y - 512.0) * glyph_scale
            pts.append((tx * px_scale, ty * px_scale))
    return pts


def rotated_capsule_polygon(
    cx: float,
    cy: float,
    w: float,
    h: float,
    r: float,
    angle_deg: float,
    glyph_scale: float = 1.0,
    px_scale: float = 1.0,
    arc_steps: int = ARC_STEPS,
) -> list[tuple[float, float]]:
    tcx = 512.0 + (cx - 512.0) * glyph_scale
    tcy = 512.0 + (cy - 512.0) * glyph_scale
    hw = (w * glyph_scale) / 2.0
    hh = (h * glyph_scale) / 2.0
    rr = min(r * glyph_scale, hw, hh)
    rad = math.radians(angle_deg)
    cos_a = math.cos(rad)
    sin_a = math.sin(rad)

    corners = [
        (hw - rr, -(hh - rr), -math.pi / 2.0, 0.0),
        (hw - rr, hh - rr, 0.0, math.pi / 2.0),
        (-(hw - rr), hh - rr, math.pi / 2.0, math.pi),
        (-(hw - rr), -(hh - rr), math.pi, 3.0 * math.pi / 2.0),
    ]
    pts: list[tuple[float, float]] = []
    for acx, acy, a0, a1 in corners:
        for i in range(arc_steps + 1):
            theta = a0 + (a1 - a0) * (i / arc_steps)
            lx = acx + rr * math.cos(theta)
            ly = acy + rr * math.sin(theta)
            rx = tcx + lx * cos_a - ly * sin_a
            ry = tcy + lx * sin_a + ly * cos_a
            pts.append((rx * px_scale, ry * px_scale))
    return pts


def vertical_gradient(
    size: int,
    top_rgba: tuple[int, int, int, int],
    bottom_rgba: tuple[int, int, int, int],
    y0: float,
    y1: float,
) -> Image.Image:
    strip = Image.new("RGBA", (1, size))
    px = strip.load()
    span = max(1.0, y1 - y0)
    for y in range(size):
        t = min(1.0, max(0.0, (y - y0) / span))
        r = round(top_rgba[0] + (bottom_rgba[0] - top_rgba[0]) * t)
        g = round(top_rgba[1] + (bottom_rgba[1] - top_rgba[1]) * t)
        b = round(top_rgba[2] + (bottom_rgba[2] - top_rgba[2]) * t)
        a = round(top_rgba[3] + (bottom_rgba[3] - top_rgba[3]) * t)
        px[0, y] = (r, g, b, a)
    return strip.resize((size, size), Image.Resampling.NEAREST)


def offset_polygon(
    pts: list[tuple[float, float]],
    delta: float,
) -> list[tuple[float, float]]:
    """Offset a clockwise screen-space closed polygon along smooth vertex normals."""
    n = len(pts)
    out: list[tuple[float, float]] = []
    for i in range(n):
        px, py = pts[(i - 1) % n]
        nx_, ny_ = pts[(i + 1) % n]
        tx = nx_ - px
        ty = ny_ - py
        length = math.hypot(tx, ty) or 1.0
        # Clockwise in screen coords (+x right, +y down) -> outward normal is (ty, -tx)
        ox = ty / length
        oy = -tx / length
        x, y = pts[i]
        out.append((x + delta * ox, y + delta * oy))
    return out


def build_circle_alpha_mask(target_size: int, ssaa: int = 8) -> Image.Image:
    """Build a ringing-free circular alpha mask via supersampled BOX downsampling."""
    hi = target_size * ssaa
    radius = hi / 2.0
    r_sq = radius * radius
    mask = Image.new("L", (hi, hi), 0)
    px = mask.load()
    for y in range(hi):
        dy = y + 0.5 - radius
        dy_sq = dy * dy
        for x in range(hi):
            dx = x + 0.5 - radius
            if dx * dx + dy_sq <= r_sq:
                px[x, y] = 255
    return mask.resize((target_size, target_size), Image.Resampling.BOX)


def render_mark(
    target_size: int,
    *,
    glyph_scale: float = 1.0,
    background_rgba: tuple[int, int, int, int] = (0, 0, 0, 0),
    circle_clip: bool = False,
    light_face: bool = False,
    resampling: Image.Resampling = Image.Resampling.LANCZOS,
) -> Image.Image:
    hi = target_size * SSAA
    px_scale = hi / CANVAS

    img = Image.new("RGBA", (hi, hi), background_rgba)

    chassis_pts = build_chassis_polygon(glyph_scale=glyph_scale, px_scale=px_scale)
    rim_half = 10.0 * glyph_scale * px_scale
    outer_pts = offset_polygon(chassis_pts, rim_half)
    inner_pts = offset_polygon(chassis_pts, -rim_half)

    # Crisp vector rim (outer polygon)
    rim_col = IOS_RIM_COLOR if light_face else RIM_COLOR
    rim_layer = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    ImageDraw.Draw(rim_layer).polygon(outer_pts, fill=rim_col)
    img = Image.alpha_composite(img, rim_layer)

    # Smooth gradient interior (inner polygon)
    mask = Image.new("L", (hi, hi), 0)
    ImageDraw.Draw(mask).polygon(inner_pts, fill=255)

    y0 = (512.0 + (56.0 - 512.0) * glyph_scale) * px_scale
    y1 = (512.0 + (960.0 - 512.0) * glyph_scale) * px_scale
    top_col = IOS_FACE_TOP if light_face else CHASSIS_TOP
    bot_col = IOS_FACE_BOTTOM if light_face else CHASSIS_BOTTOM
    grad = vertical_gradient(hi, top_col, bot_col, y0, y1)

    chassis_layer = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    chassis_layer.paste(grad, (0, 0), mask)
    img = Image.alpha_composite(img, chassis_layer)

    draw = ImageDraw.Draw(img)
    eye_col = IOS_EYE_COLOR if light_face else EYE_COLOR
    for cx, cy, w, h, r, ang in EYES:
        eye_pts = rotated_capsule_polygon(
            cx, cy, w, h, r, ang, glyph_scale=glyph_scale, px_scale=px_scale
        )
        draw.polygon(eye_pts, fill=eye_col)

    bx, by, br = BEACON
    tbx = (512.0 + (bx - 512.0) * glyph_scale) * px_scale
    tby = (512.0 + (by - 512.0) * glyph_scale) * px_scale
    tbr = (br * glyph_scale) * px_scale
    accent_col = IOS_ACCENT_COLOR if light_face else ACCENT_COLOR
    draw.ellipse((tbx - tbr, tby - tbr, tbx + tbr, tby + tbr), fill=accent_col)

    out = img.resize((target_size, target_size), resampling)
    if circle_clip and background_rgba[3] > 0:
        out.putalpha(build_circle_alpha_mask(target_size, ssaa=8))
    return out


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def rel_posix(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def main() -> None:
    png_entries: list[dict[str, object]] = []
    for size in ROOT_PNG_SIZES:
        out_path = LOGO_DIR / f"rokbot-icon-{size}.png"
        im = render_mark(size, glyph_scale=1.0)
        im.save(out_path, format="PNG")
        png_entries.append({
            "path": rel_posix(out_path),
            "width": size,
            "height": size,
            "mode": im.mode,
            "sha256": file_sha256(out_path),
        })

    # Host /rokbot-icon.png (512x512 RGBA)
    HOST_ICON_PATH.parent.mkdir(parents=True, exist_ok=True)
    host_im = render_mark(512, glyph_scale=1.0)
    host_im.save(HOST_ICON_PATH, format="PNG")
    host_entry = {
        "path": rel_posix(HOST_ICON_PATH),
        "width": 512,
        "height": 512,
        "mode": host_im.mode,
        "sha256": file_sha256(HOST_ICON_PATH),
    }

    # Multi-resolution Windows .ico (each size rendered at 4x SSAA)
    ico_frames = [render_mark(sz, glyph_scale=1.0) for sz in ICO_SIZES]
    ico_path = LOGO_DIR / "rokbot.ico"
    ico_frames[-1].save(
        ico_path,
        format="ICO",
        sizes=[(sz, sz) for sz in ICO_SIZES],
        append_images=ico_frames[:-1],
    )
    ico_entry = {
        "path": rel_posix(ico_path),
        "sizes": ICO_SIZES,
        "sha256": file_sha256(ico_path),
    }

    # macOS .icns via /usr/bin/iconutil
    icns_path = LOGO_DIR / "rokbot.icns"
    with tempfile.TemporaryDirectory(prefix="rokbot_iconset_") as tmpdir:
        iconset_dir = Path(tmpdir) / "rokbot.iconset"
        iconset_dir.mkdir()
        rendered_cache: dict[int, Image.Image] = {}
        for filename, sz in ICONSET_ENTRIES:
            if sz not in rendered_cache:
                rendered_cache[sz] = render_mark(sz, glyph_scale=0.86)
            rendered_cache[sz].save(iconset_dir / filename, format="PNG")
        subprocess.run(
            ["/usr/bin/iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)],
            check=True,
        )
    icns_entry = {
        "path": rel_posix(icns_path),
        "iconsetEntries": [{"name": name, "size": sz} for name, sz in ICONSET_ENTRIES],
        "sha256": file_sha256(icns_path),
    }

    # Android mipmaps
    android_entries: list[dict[str, object]] = []
    for density, launcher_sz, fg_sz in ANDROID_DENSITIES:
        mipmap_dir = LOGO_DIR / "android" / f"mipmap-{density}"
        mipmap_dir.mkdir(parents=True, exist_ok=True)

        launcher_path = mipmap_dir / "ic_launcher.png"
        launcher_im = render_mark(launcher_sz, glyph_scale=0.92)
        launcher_im.save(launcher_path, format="PNG")
        android_entries.append({
            "density": density,
            "kind": "ic_launcher",
            "path": rel_posix(launcher_path),
            "width": launcher_sz,
            "height": launcher_sz,
            "mode": launcher_im.mode,
            "sha256": file_sha256(launcher_path),
        })

        round_path = mipmap_dir / "ic_launcher_round.png"
        round_im = render_mark(
            launcher_sz,
            glyph_scale=0.72,
            background_rgba=ANDROID_ROUND_BG,
            circle_clip=True,
        )
        round_im.save(round_path, format="PNG")
        android_entries.append({
            "density": density,
            "kind": "ic_launcher_round",
            "path": rel_posix(round_path),
            "width": launcher_sz,
            "height": launcher_sz,
            "mode": round_im.mode,
            "sha256": file_sha256(round_path),
        })

        fg_path = mipmap_dir / "ic_launcher_foreground.png"
        fg_im = render_mark(fg_sz, glyph_scale=0.53, resampling=Image.Resampling.HAMMING)
        fg_im.save(fg_path, format="PNG")
        android_entries.append({
            "density": density,
            "kind": "ic_launcher_foreground",
            "path": rel_posix(fg_path),
            "width": fg_sz,
            "height": fg_sz,
            "mode": fg_im.mode,
            "sha256": file_sha256(fg_path),
        })

    # iOS AppIcons (opaque RGB mode, no alpha channel)
    ios_dir = LOGO_DIR / "ios"
    ios_dir.mkdir(parents=True, exist_ok=True)
    ios_entries: list[dict[str, object]] = []
    for sz in IOS_SIZES:
        ios_path = ios_dir / f"AppIcon-{sz}.png"
        rgba_im = render_mark(
            sz,
            glyph_scale=0.76,
            background_rgba=(*IOS_BG_COLOR, 255),
            light_face=True,
        )
        rgb_im = Image.new("RGB", (sz, sz), IOS_BG_COLOR)
        rgb_im.paste(rgba_im, (0, 0), rgba_im)
        rgb_im.save(ios_path, format="PNG")
        ios_entries.append({
            "path": rel_posix(ios_path),
            "width": sz,
            "height": sz,
            "mode": rgb_im.mode,
            "hasAlpha": False,
            "sha256": file_sha256(ios_path),
        })

    manifest = {
        "schema": "rokbot-logo-manifest/v1",
        "masterSvg": "assets/logo/rokbot-logo.svg",
        "generator": "assets/logo/generate_icons.py",
        "hostIcon": host_entry,
        "png": png_entries,
        "ico": ico_entry,
        "icns": icns_entry,
        "android": android_entries,
        "ios": ios_entries,
    }
    manifest_path = LOGO_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Generated RokBot icon suite and manifest at {manifest_path}")


if __name__ == "__main__":
    main()

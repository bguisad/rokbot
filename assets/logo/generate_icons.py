#!/usr/bin/env python3
"""Reproducible multi-resolution icon & asset generator for RokBot.

Renders the white-tile RokBot logo defined in assets/logo/rokbot-logo.svg: a 30%-radius tile
filled with a 160 deg #F4FBFE -> #C9EEF7 gradient, a soft white inner rim and a faint teal
hairline edge, carrying the dark RokBot head (exact canonical 1024x1024 cubic Bezier chassis,
-26 deg asymmetric tilted pill eyes and crest signal beacon) at GLYPH_SCALE of the tile.
Uses 4x supersampled Pillow rendering, macOS iconutil and multi-resolution ICO/Android/iOS exports.
"""

from __future__ import annotations

import hashlib
import json
import math
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

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

# Head palette (matches the master SVG)
CHASSIS_TOP = (0x24, 0x29, 0x36, 255)
CHASSIS_BOTTOM = (0x12, 0x14, 0x1B, 255)
RIM_COLOR = (0x30, 0x37, 0x47, 255)
EYE_COLOR = (0xF5, 0xF5, 0xF4, 255)
ACCENT_COLOR = (0x38, 0xBD, 0xF8, 255)

# Tile (master SVG: <rect class="brand-tile" rx="308"> + rim + edge, glyph transform)
TILE_RADIUS = 308.0  # ~30% of the 1024 side
TILE_ANGLE_DEG = 160.0
TILE_TOP = (0xF4, 0xFB, 0xFE, 255)
TILE_BOTTOM = (0xC9, 0xEE, 0xF7, 255)
TILE_RIM_COLOR = (0xFF, 0xFF, 0xFF, 230)  # stroke-opacity 0.9
TILE_RIM_INSET = 12.0  # stroke centre line, 1024 units (rect x="12")
TILE_RIM_WIDTH = 8.0
TILE_EDGE_COLOR = (0x0E, 0x4A, 0x5C, 41)  # stroke-opacity 0.16
TILE_EDGE_WIDTH = 4.0
GLYPH_SCALE = 0.84
GLYPH_CENTER_Y = 506.0  # head bbox centre (beacon included) sits on the tile centre

# macOS icon grid: 824 px body in a 1024 canvas with a soft drop shadow
MAC_TILE_FRAC = 824.0 / 1024.0
SHADOW_ALPHA = 72
SHADOW_OFFSET_Y = 12.0
SHADOW_BLUR = 16.0

# Android: legacy square icon uses the 44/48 dp keyline; the adaptive foreground keeps the head
# inside the 66 dp safe circle of the 108 dp canvas, over the light @color/iconBackground.
ANDROID_LEGACY_TILE_FRAC = 44.0 / 48.0
ANDROID_ROUND_GLYPH_SCALE = 0.76
ANDROID_FOREGROUND_GLYPH_SCALE = 0.53
ANDROID_ICON_BACKGROUND = "#FFDFF4FA"  # mid-point of the tile gradient

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


def css_gradient_line(angle_deg: float, side: float) -> tuple[tuple[float, float], tuple[float, float]]:
    """Start/end points of CSS linear-gradient(<angle>deg) across a side x side box at the origin."""
    rad = math.radians(angle_deg)
    dx, dy = math.sin(rad), -math.cos(rad)
    half = side * (abs(dx) + abs(dy)) / 2.0
    c = side / 2.0
    return (c - dx * half, c - dy * half), (c + dx * half, c + dy * half)


def tile_gradient(hi: int, box: tuple[float, float, float]) -> Image.Image:
    """The tile's 160 deg two-stop gradient over box = (x0, y0, side) in hi-res pixels."""
    x0, y0, side = box
    (sx, sy), (ex, ey) = css_gradient_line(TILE_ANGLE_DEG, side)
    sx, sy, ex, ey = sx + x0, sy + y0, ex + x0, ey + y0
    vx, vy = ex - sx, ey - sy
    len_sq = vx * vx + vy * vy
    # Sample a 256-step vertical ramp: input y = 255 * t(x, y), t = projection onto the gradient line.
    ramp = Image.linear_gradient("L")
    k = 255.0 / len_sq
    t_img = ramp.transform(
        (hi, hi),
        Image.Transform.AFFINE,
        (0.0, 0.0, 128.0, vx * k, vy * k, -(sx * vx + sy * vy) * k),
        resample=Image.Resampling.BILINEAR,
    )
    bands = []
    for i in range(3):
        a, b = TILE_TOP[i], TILE_BOTTOM[i]
        bands.append(t_img.point(lambda v, a=a, b=b: round(a + (b - a) * v / 255.0)))
    return Image.merge("RGB", bands).convert("RGBA")


def rounded_box_mask(hi: int, box: tuple[float, float, float], inset: float, radius: float, shape: str) -> Image.Image:
    x0, y0, side = box
    mask = Image.new("L", (hi, hi), 0)
    rect = (x0 + inset, y0 + inset, x0 + side - inset - 1, y0 + side - inset - 1)
    draw = ImageDraw.Draw(mask)
    if shape == "circle":
        draw.ellipse(rect, fill=255)
    elif shape == "square":
        draw.rectangle(rect, fill=255)
    else:
        draw.rounded_rectangle(rect, radius=max(0.0, radius - inset), fill=255)
    return mask


def ring_mask(hi: int, box, outer_inset: float, width: float, radius: float, shape: str) -> Image.Image:
    outer = rounded_box_mask(hi, box, outer_inset, radius, shape)
    inner = rounded_box_mask(hi, box, outer_inset + width, radius, shape)
    return ImageChops.subtract(outer, inner)


def draw_glyph(img: Image.Image, scale: float, unit: float, cx: float, cy: float) -> Image.Image:
    """Composite the RokBot head (master 1024 coordinates) at `scale`, centered on (cx, cy) px.

    Mirrors the SVG transform translate(cx cy) scale(scale) translate(-512 -GLYPH_CENTER_Y).
    """
    hi = img.size[0]
    k = scale * unit

    def tx(x: float, y: float) -> tuple[float, float]:
        return cx + (x - 512.0) * k, cy + (y - GLYPH_CENTER_Y) * k

    chassis = []
    for seg in CHASSIS_SEGMENTS:
        chassis.extend(tx(x, y) for x, y in sample_cubic_bezier(*seg, steps=BEZIER_STEPS))
    rim_half = 10.0 * k
    outer_pts = offset_polygon(chassis, rim_half)
    inner_pts = offset_polygon(chassis, -rim_half)

    rim_layer = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    ImageDraw.Draw(rim_layer).polygon(outer_pts, fill=RIM_COLOR)
    img = Image.alpha_composite(img, rim_layer)

    mask = Image.new("L", (hi, hi), 0)
    ImageDraw.Draw(mask).polygon(inner_pts, fill=255)
    _, gy0 = tx(512.0, 56.0)
    _, gy1 = tx(512.0, 960.0)
    grad = vertical_gradient(hi, CHASSIS_TOP, CHASSIS_BOTTOM, gy0, gy1)
    chassis_layer = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    chassis_layer.paste(grad, (0, 0), mask)
    img = Image.alpha_composite(img, chassis_layer)

    draw = ImageDraw.Draw(img)
    for ecx, ecy, w, h, r, ang in EYES:
        local = rotated_capsule_polygon(ecx, ecy, w, h, r, ang)
        draw.polygon([tx(x, y) for x, y in local], fill=EYE_COLOR)
    bx, by, br = BEACON
    bcx, bcy = tx(bx, by)
    draw.ellipse((bcx - br * k, bcy - br * k, bcx + br * k, bcy + br * k), fill=ACCENT_COLOR)
    return img


def render_logo(
    target_size: int,
    *,
    shape: str | None = "squircle",
    tile_frac: float = 1.0,
    glyph_scale: float = GLYPH_SCALE,
    rim: bool = True,
    edge: bool = True,
    shadow: bool = False,
    circle_clip: bool = False,
    resampling: Image.Resampling = Image.Resampling.LANCZOS,
) -> Image.Image:
    """Render the white-tile RokBot logo.

    shape: "squircle" (the master: rx = 30% of the side), "circle", "square" (opaque full bleed,
    for platforms that mask the icon themselves) or None (the head alone, transparent).
    tile_frac: tile side as a fraction of the canvas, centered. glyph_scale is relative to the tile.
    """
    hi = target_size * SSAA
    unit = hi / CANVAS
    side = tile_frac * hi
    box = ((hi - side) / 2.0, (hi - side) / 2.0, side)
    tile_unit = side / CANVAS
    radius = TILE_RADIUS * tile_unit
    img = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))

    if shape is not None:
        # With circle_clip the final supersampled circle mask cuts the edge, so the fill bleeds to a
        # full square first: no resampling ringing can leave alpha < 255 inside the circle.
        tile_mask = rounded_box_mask(hi, box, 0.0, radius, "square" if circle_clip else shape)
        if shadow:
            sh = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
            sh_mask = tile_mask.point(lambda v: v * SHADOW_ALPHA // 255)
            sh.putalpha(sh_mask)
            sh = sh.transform(
                (hi, hi), Image.Transform.AFFINE, (1, 0, 0, 0, 1, -SHADOW_OFFSET_Y * tile_unit),
            ).filter(ImageFilter.GaussianBlur(SHADOW_BLUR * tile_unit))
            img = Image.alpha_composite(img, sh)
        tile_layer = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
        tile_layer.paste(tile_gradient(hi, box), (0, 0), tile_mask)
        img = Image.alpha_composite(img, tile_layer)
        if rim:
            rim_layer = Image.new("RGBA", (hi, hi), TILE_RIM_COLOR[:3] + (0,))
            ring = ring_mask(hi, box, (TILE_RIM_INSET - TILE_RIM_WIDTH / 2.0) * tile_unit,
                             TILE_RIM_WIDTH * tile_unit, radius, shape)
            rim_layer.putalpha(ring.point(lambda v: v * TILE_RIM_COLOR[3] // 255))
            img = Image.alpha_composite(img, rim_layer)
        if edge:
            # Hairline that separates the near-white tile from light backgrounds; never thinner than
            # ~0.85 output px so it still reads on the 16-48 px favicons and launcher icons.
            width = max(TILE_EDGE_WIDTH * tile_unit, 0.85 * SSAA)
            edge_layer = Image.new("RGBA", (hi, hi), TILE_EDGE_COLOR[:3] + (0,))
            ring = ring_mask(hi, box, 0.0, width, radius, shape)
            edge_layer.putalpha(ring.point(lambda v: v * TILE_EDGE_COLOR[3] // 255))
            img = Image.alpha_composite(img, edge_layer)

    img = draw_glyph(img, glyph_scale * tile_frac, unit, hi / 2.0, hi / 2.0)

    out = img.resize((target_size, target_size), resampling)
    if circle_clip:
        out.putalpha(ImageChops.multiply(out.getchannel("A"), build_circle_alpha_mask(target_size, ssaa=8)))
    return out


def opaque_rgb(img: Image.Image) -> Image.Image:
    rgb = Image.new("RGB", img.size, TILE_BOTTOM[:3])
    rgb.paste(img, (0, 0), img)
    return rgb


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
        im = render_logo(size)
        im.save(out_path, format="PNG")
        png_entries.append({
            "path": rel_posix(out_path),
            "width": size,
            "height": size,
            "mode": im.mode,
            "sha256": file_sha256(out_path),
        })

    # Host /rokbot-icon.png (512x512 RGBA, fully opaque): it is the apple-touch-icon of the Host
    # pages, and iOS fills transparent corners with black before applying its own mask.
    HOST_ICON_PATH.parent.mkdir(parents=True, exist_ok=True)
    host_im = render_logo(512, shape="square", rim=False, edge=False)
    host_im.save(HOST_ICON_PATH, format="PNG")
    host_entry = {
        "path": rel_posix(HOST_ICON_PATH),
        "width": 512,
        "height": 512,
        "mode": host_im.mode,
        "sha256": file_sha256(HOST_ICON_PATH),
    }

    # Multi-resolution Windows .ico (each size rendered at 4x SSAA)
    ico_frames = [render_logo(sz) for sz in ICO_SIZES]
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
                rendered_cache[sz] = render_logo(sz, tile_frac=MAC_TILE_FRAC, shadow=True)
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
        launcher_im = render_logo(launcher_sz, tile_frac=ANDROID_LEGACY_TILE_FRAC)
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
        round_im = render_logo(
            launcher_sz,
            shape="circle",
            glyph_scale=ANDROID_ROUND_GLYPH_SCALE,
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
        fg_im = render_logo(
            fg_sz, shape=None, glyph_scale=ANDROID_FOREGROUND_GLYPH_SCALE, resampling=Image.Resampling.HAMMING
        )
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
        # iOS masks the icon itself: opaque full-bleed gradient, no own corners or rim.
        rgb_im = opaque_rgb(render_logo(sz, shape="square", rim=False, edge=False))
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
        "tile": {
            "radius": TILE_RADIUS,
            "gradientAngle": TILE_ANGLE_DEG,
            "gradientStops": ["#%02X%02X%02X" % TILE_TOP[:3], "#%02X%02X%02X" % TILE_BOTTOM[:3]],
            "glyphScale": GLYPH_SCALE,
        },
        "androidIconBackground": ANDROID_ICON_BACKGROUND,
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

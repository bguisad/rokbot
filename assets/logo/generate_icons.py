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
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

Image.init()

ROOT = Path(__file__).resolve().parents[2]
LOGO_DIR = Path(__file__).resolve().parent
MASTER_SVG_PATH = LOGO_DIR / "rokbot-logo.svg"
HOST_ICON_PATH = ROOT / "host" / "server" / "public" / "rokbot-icon.png"

CANVAS = 1024.0
BEZIER_STEPS = 96
ARC_STEPS = 32
SSAA = 4

SVG_NS = "{http://www.w3.org/2000/svg}"


def _parse_hex_rgba(color: str, opacity: float = 1.0) -> tuple[int, int, int, int]:
    hex_str = color.strip().lstrip("#")
    if len(hex_str) != 6:
        raise ValueError(f"Expected 6-digit hex color, got {color!r}")
    return (
        int(hex_str[0:2], 16),
        int(hex_str[2:4], 16),
        int(hex_str[4:6], 16),
        round(opacity * 255.0),
    )


def _parse_cubic_path(d: str) -> list[tuple[tuple[float, float], tuple[float, float], tuple[float, float], tuple[float, float]]]:
    tokens = re.findall(r"[MCZ]|-?\d+(?:\.\d+)?", d)
    if not tokens or tokens[0] != "M":
        raise ValueError(f"Master SVG path must start with M: {d!r}")
    cur = (float(tokens[1]), float(tokens[2]))
    idx = 3
    segments: list[tuple[tuple[float, float], tuple[float, float], tuple[float, float], tuple[float, float]]] = []
    while idx < len(tokens):
        cmd = tokens[idx]
        if cmd == "Z":
            break
        if cmd != "C":
            raise ValueError(f"Unsupported SVG path command {cmd!r} in master SVG")
        p1 = (float(tokens[idx + 1]), float(tokens[idx + 2]))
        p2 = (float(tokens[idx + 3]), float(tokens[idx + 4]))
        p3 = (float(tokens[idx + 5]), float(tokens[idx + 6]))
        segments.append((cur, p1, p2, p3))
        cur = p3
        idx += 7
    if not segments:
        raise ValueError("Master SVG chassis path contains no cubic segments")
    return segments


def load_master_svg_spec(svg_path: Path = MASTER_SVG_PATH) -> dict[str, object]:
    """Parse geometry, tile styling, and palette directly from assets/logo/rokbot-logo.svg."""
    root = ET.fromstring(svg_path.read_text(encoding="utf-8"))

    def by_id(tag: str, elem_id: str) -> ET.Element:
        for el in root.iter(f"{SVG_NS}{tag}"):
            if el.attrib.get("id") == elem_id:
                return el
        raise ValueError(f"Missing <{tag} id={elem_id!r}> in {svg_path}")

    def by_class(tag: str, cls: str) -> list[ET.Element]:
        return [
            el for el in root.iter(f"{SVG_NS}{tag}")
            if cls in el.attrib.get("class", "").split()
        ]

    tile_grad = by_id("linearGradient", "rokbot-tile")
    tx1, ty1 = float(tile_grad.attrib["x1"]), float(tile_grad.attrib["y1"])
    tx2, ty2 = float(tile_grad.attrib["x2"]), float(tile_grad.attrib["y2"])
    tile_angle_deg = round((math.degrees(math.atan2(tx2 - tx1, -(ty2 - ty1))) + 360.0) % 360.0, 2)
    tile_stops = list(tile_grad.findall(f"{SVG_NS}stop"))
    tile_top = _parse_hex_rgba(tile_stops[0].attrib["stop-color"])
    tile_bottom = _parse_hex_rgba(tile_stops[-1].attrib["stop-color"])

    chassis_grad = by_id("linearGradient", "rokbot-chassis")
    chassis_stops = list(chassis_grad.findall(f"{SVG_NS}stop"))
    chassis_top = _parse_hex_rgba(chassis_stops[0].attrib["stop-color"])
    chassis_bottom = _parse_hex_rgba(chassis_stops[-1].attrib["stop-color"])
    chassis_y0 = float(chassis_grad.attrib["y1"])
    chassis_y1 = float(chassis_grad.attrib["y2"])

    tile_rect = by_class("rect", "brand-tile")[0]
    tile_radius = float(tile_rect.attrib["rx"])

    rim_rect = by_class("rect", "brand-tile-rim")[0]
    tile_rim_inset = float(rim_rect.attrib["x"])
    tile_rim_width = float(rim_rect.attrib["stroke-width"])
    tile_rim_color = _parse_hex_rgba(
        rim_rect.attrib["stroke"], float(rim_rect.attrib.get("stroke-opacity", "1")),
    )

    edge_rect = by_class("rect", "brand-tile-edge")[0]
    tile_edge_width = float(edge_rect.attrib["stroke-width"])
    tile_edge_color = _parse_hex_rgba(
        edge_rect.attrib["stroke"], float(edge_rect.attrib.get("stroke-opacity", "1")),
    )

    glyph_group = by_class("g", "brand-glyph")[0]
    tf_match = re.search(
        r"translate\(\s*([-\d.]+)\s+([-\d.]+)\s*\)\s*scale\(\s*([-\d.]+)\s*\)\s*translate\(\s*([-\d.]+)\s+([-\d.]+)\s*\)",
        glyph_group.attrib.get("transform", ""),
    )
    if not tf_match:
        raise ValueError(f"Could not parse brand-glyph transform in {svg_path}")
    glyph_scale = float(tf_match.group(3))
    glyph_center_y = -float(tf_match.group(5))

    face_path = by_class("path", "brand-face")[0]
    chassis_segments = _parse_cubic_path(face_path.attrib["d"])
    rim_color = _parse_hex_rgba(face_path.attrib["stroke"])
    rim_stroke_width = float(face_path.attrib.get("stroke-width", "20"))

    eyes_group = by_class("g", "brand-eyes")[0]
    eye_color = _parse_hex_rgba(eyes_group.attrib["fill"])
    eyes: list[tuple[float, float, float, float, float, float]] = []
    for eye_el in by_class("rect", "brand-eye"):
        ex = float(eye_el.attrib["x"])
        ey = float(eye_el.attrib["y"])
        ew = float(eye_el.attrib["width"])
        eh = float(eye_el.attrib["height"])
        er = float(eye_el.attrib["rx"])
        rot = re.search(r"rotate\(\s*([-\d.]+)", eye_el.attrib.get("transform", ""))
        angle = float(rot.group(1)) if rot else 0.0
        eyes.append((ex + ew / 2.0, ey + eh / 2.0, ew, eh, er, angle))

    accent_el = by_class("circle", "brand-accent")[0]
    beacon = (
        float(accent_el.attrib["cx"]),
        float(accent_el.attrib["cy"]),
        float(accent_el.attrib["r"]),
    )
    accent_color = _parse_hex_rgba(accent_el.attrib["fill"])

    return {
        "chassis_segments": chassis_segments,
        "chassis_top": chassis_top,
        "chassis_bottom": chassis_bottom,
        "chassis_y0": chassis_y0,
        "chassis_y1": chassis_y1,
        "rim_color": rim_color,
        "rim_stroke_width": rim_stroke_width,
        "eyes": eyes,
        "eye_color": eye_color,
        "beacon": beacon,
        "accent_color": accent_color,
        "tile_radius": tile_radius,
        "tile_angle_deg": tile_angle_deg,
        "tile_top": tile_top,
        "tile_bottom": tile_bottom,
        "tile_rim_color": tile_rim_color,
        "tile_rim_inset": tile_rim_inset,
        "tile_rim_width": tile_rim_width,
        "tile_edge_color": tile_edge_color,
        "tile_edge_width": tile_edge_width,
        "glyph_scale": glyph_scale,
        "glyph_center_y": glyph_center_y,
    }


MASTER_SPEC = load_master_svg_spec(MASTER_SVG_PATH)

# Geometry, palette, and tile parameters loaded directly from assets/logo/rokbot-logo.svg
CHASSIS_SEGMENTS = MASTER_SPEC["chassis_segments"]
EYES = MASTER_SPEC["eyes"]
BEACON = MASTER_SPEC["beacon"]

CHASSIS_TOP = MASTER_SPEC["chassis_top"]
CHASSIS_BOTTOM = MASTER_SPEC["chassis_bottom"]
CHASSIS_Y0 = MASTER_SPEC["chassis_y0"]
CHASSIS_Y1 = MASTER_SPEC["chassis_y1"]
RIM_COLOR = MASTER_SPEC["rim_color"]
RIM_STROKE_WIDTH = MASTER_SPEC["rim_stroke_width"]
EYE_COLOR = MASTER_SPEC["eye_color"]
ACCENT_COLOR = MASTER_SPEC["accent_color"]

TILE_RADIUS = MASTER_SPEC["tile_radius"]
TILE_ANGLE_DEG = MASTER_SPEC["tile_angle_deg"]
TILE_TOP = MASTER_SPEC["tile_top"]
TILE_BOTTOM = MASTER_SPEC["tile_bottom"]
TILE_RIM_COLOR = MASTER_SPEC["tile_rim_color"]
TILE_RIM_INSET = MASTER_SPEC["tile_rim_inset"]
TILE_RIM_WIDTH = MASTER_SPEC["tile_rim_width"]
TILE_EDGE_COLOR = MASTER_SPEC["tile_edge_color"]
TILE_EDGE_WIDTH = MASTER_SPEC["tile_edge_width"]
GLYPH_SCALE = MASTER_SPEC["glyph_scale"]
GLYPH_CENTER_Y = MASTER_SPEC["glyph_center_y"]

# macOS Big Sur+ icon grid: 824 px body in a 1024 canvas (100 px standard margin) with a soft drop shadow
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
    rim_half = (RIM_STROKE_WIDTH / 2.0) * k
    outer_pts = offset_polygon(chassis, rim_half)
    inner_pts = offset_polygon(chassis, -rim_half)

    rim_layer = Image.new("RGBA", (hi, hi), (0, 0, 0, 0))
    ImageDraw.Draw(rim_layer).polygon(outer_pts, fill=RIM_COLOR)
    img = Image.alpha_composite(img, rim_layer)

    mask = Image.new("L", (hi, hi), 0)
    ImageDraw.Draw(mask).polygon(inner_pts, fill=255)
    _, gy0 = tx(512.0, CHASSIS_Y0)
    _, gy1 = tx(512.0, CHASSIS_Y1)
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
        "masterSvgSha256": file_sha256(MASTER_SVG_PATH),
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

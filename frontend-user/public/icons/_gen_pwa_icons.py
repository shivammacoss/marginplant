"""Generate the PWA icon set (192 + 512 + maskable 512) from the brand
emerald + white-sprout mark.

    py frontend-user/public/icons/_gen_pwa_icons.py

Mirrors the visual the APK uses (see marginplant_apk/assets/images/
_gen_icon.py) so the install-prompt tile, splash, and the Android
home-screen all read as the same brand.
"""
import os
import math

from PIL import Image, ImageDraw

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

EMERALD = (16, 185, 129)
EMERALD_DARK = (5, 150, 105)
WHITE = (255, 255, 255, 255)


def diag_gradient(size: int, top: tuple, bot: tuple) -> Image.Image:
    img = Image.new("RGB", (size, size), top)
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            r = int(top[0] * (1 - t) + bot[0] * t)
            g = int(top[1] * (1 - t) + bot[1] * t)
            b = int(top[2] * (1 - t) + bot[2] * t)
            px[x, y] = (r, g, b)
    return img


def rounded_mask(size: int, radius_pct: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_pct)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
    return mask


def draw_leaf(area: int, tilt_deg: float, mirror: bool) -> Image.Image:
    leaf_w = int(area * 0.46)
    leaf_h = int(area * 0.95)
    tile = Image.new("RGBA", (area, area), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    cx = area // 2
    top_y = (area - leaf_h) // 2
    bot_y = top_y + leaf_h
    half = leaf_w // 2
    points = []
    steps = 60
    for i in range(steps + 1):
        t = i / steps
        wf = math.sin(math.pi * t) ** 0.7
        points.append((cx + half * wf, top_y + int(leaf_h * t)))
    for i in range(steps, -1, -1):
        t = i / steps
        wf = math.sin(math.pi * t) ** 0.7
        points.append((cx - half * wf, top_y + int(leaf_h * t)))
    d.polygon(points, fill=WHITE)
    spine_w = max(2, area // 110)
    d.line(
        [(cx, top_y + int(leaf_h * 0.08)), (cx, bot_y - int(leaf_h * 0.12))],
        fill=EMERALD + (255,),
        width=spine_w,
    )
    if mirror:
        tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
    if tilt_deg:
        tile = tile.rotate(tilt_deg, resample=Image.BICUBIC, expand=False)
    return tile


def draw_sprout(canvas: Image.Image, area_size: int, center: tuple[int, int]) -> None:
    cx, cy = center
    leaf_area = int(area_size * 0.62)
    left = draw_leaf(leaf_area, tilt_deg=32, mirror=False)
    right = draw_leaf(leaf_area, tilt_deg=-32, mirror=True)
    half = leaf_area // 2
    leaf_top = cy - half - int(area_size * 0.05)
    left_x = cx - leaf_area + int(area_size * 0.12)
    right_x = cx - int(area_size * 0.12)
    canvas.alpha_composite(left, (left_x, leaf_top))
    canvas.alpha_composite(right, (right_x, leaf_top))
    stem_top = cy + int(area_size * 0.12)
    stem_bot = cy + int(area_size * 0.42)
    stem_w = max(6, int(area_size * 0.045))
    d = ImageDraw.Draw(canvas)
    d.line([(cx, stem_top), (cx, stem_bot)], fill=WHITE, width=stem_w)
    cap_r = stem_w // 2
    d.ellipse((cx - cap_r, stem_top - cap_r, cx + cap_r, stem_top + cap_r), fill=WHITE)
    d.ellipse((cx - cap_r, stem_bot - cap_r, cx + cap_r, stem_bot + cap_r), fill=WHITE)


def make_rounded_tile(size: int) -> Image.Image:
    """Standard PWA app-icon tile — rounded square w/ gradient + sprout."""
    bg = diag_gradient(size, EMERALD, EMERALD_DARK).convert("RGBA")
    mask = rounded_mask(size, radius_pct=0.22)
    bg.putalpha(mask)
    draw_sprout(bg, area_size=size, center=(size // 2, size // 2))
    return bg


def make_maskable(size: int) -> Image.Image:
    """Android maskable icon — full-bleed background so the OS can crop
    into a circle/squircle without revealing transparent corners. Safe
    zone for the sprout is the inner 80%."""
    bg = diag_gradient(size, EMERALD, EMERALD_DARK).convert("RGBA")
    safe = int(size * 0.66)
    draw_sprout(bg, area_size=safe, center=(size // 2, size // 2))
    return bg


def main() -> None:
    for s in (192, 512):
        img = make_rounded_tile(s)
        path = os.path.join(OUT_DIR, f"icon-{s}.png")
        img.save(path, "PNG")
        print(f"wrote {path} ({s}x{s})")

    mask = make_maskable(512)
    mp = os.path.join(OUT_DIR, "icon-maskable-512.png")
    mask.save(mp, "PNG")
    print(f"wrote {mp} (512x512 maskable)")


if __name__ == "__main__":
    main()

"""Generate repo assets: README preview image and the macOS app icon.

    uv run python scripts/generate_assets.py

Draws a stylized top-down render of the practice table and a multi-resolution
macOS icon with Pillow.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

W, L = 1.78, 3.56
R = 0.034
CUSHION = 0.055
WOOD = 0.085


def lerp(a, b, f):
    return a + (b - a) * f


def mix(c1, c2, f):
    return tuple(int(lerp(a, b, f)) for a, b in zip(c1, c2, strict=False))


def table_transform(size):
    pad = 0.30
    sx = size[0] / (L + 2 * pad)
    sy = size[1] / (W + 2 * pad)
    s = min(sx, sy)
    ox = (size[0] - L * s) / 2
    oy = (size[1] - W * s) / 2

    def pt(x, y):
        return (ox + y * s, oy + x * s)

    def m(v):
        return v * s

    return pt, m, s


def rounded(draw, box, radius, **kw):
    draw.rounded_rectangle(box, radius=radius, **kw)


def draw_preview():
    size = (1560, 880)
    img = Image.new("RGB", size, (14, 18, 22))
    ImageDraw.Draw(img)
    # soft room glow behind the table
    glow = Image.new("L", size, 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([size[0] * 0.15, size[1] * 0.05, size[0] * 0.85, size[1] * 0.95], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    dark = Image.new("RGB", size, (24, 33, 40))
    img = Image.composite(dark, img, glow)
    draw = ImageDraw.Draw(img)

    pt, m, _ = table_transform(size)

    # wood frame
    frame = [pt(0, 0)[0] - m(CUSHION + WOOD), pt(0, 0)[1] - m(CUSHION + WOOD),
             pt(W, L)[0] + m(CUSHION + WOOD), pt(W, L)[1] + m(CUSHION + WOOD)]
    rounded(draw, frame, 26, fill=(66, 40, 22), outline=(40, 24, 12), width=3)

    # cushion band
    band = [pt(0, 0)[0] - m(CUSHION), pt(0, 0)[1] - m(CUSHION),
            pt(W, L)[0] + m(CUSHION), pt(W, L)[1] + m(CUSHION)]
    rounded(draw, band, 16, fill=(9, 92, 60))

    # cloth with vignette
    cloth_box = [pt(0, 0), pt(W, L)]
    rounded(draw, cloth_box, 4, fill=(15, 118, 76))
    vin = Image.new("L", size, 0)
    vd = ImageDraw.Draw(vin)
    vd.rounded_rectangle(cloth_box, radius=4, fill=110)
    vin = vin.filter(ImageFilter.GaussianBlur(70))
    shade = Image.new("RGB", size, (6, 66, 42))
    img.paste(shade, (0, 0), vin)
    draw = ImageDraw.Draw(img)

    # pockets
    corners = [(-0.0318, -0.0318), (W + 0.0318, -0.0318), (-0.0318, L + 0.0318),
               (W + 0.0318, L + 0.0318)]
    pockets = [(x, y) for x, y in corners] + [(W + 0.015, L / 2), (-0.015, L / 2)]
    for x, y in pockets:
        cx, cy = pt(x, y)
        r = m(0.05)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(4, 5, 6),
                     outline=(10, 14, 16), width=3)

    # sights
    for i in range(1, 8):
        if i == 4:
            continue
        for x in (0.0, W):
            cx, cy = pt(x, i * L / 8)
            dx = m(CUSHION + WOOD * 0.5) * (1 if x == 0 else -1)
            diamond(draw, cx - dx, cy, m(0.011), (232, 220, 192))

    # cue stick (aiming at the rack)
    phi = math.radians(90)
    cue = (W / 2, L * 0.30)
    back = (cue[0] - math.cos(phi) * (R + 0.10), cue[1] - math.sin(phi) * (R + 0.10))
    butt = (back[0] - math.cos(phi) * 1.2, back[1] - math.sin(phi) * 1.2)
    draw.line([pt(*back), pt(*butt)], fill=(92, 58, 27), width=int(m(0.009)))
    draw.line([pt(*back), pt((back[0] + butt[0]) / 2, (back[1] + butt[1]) / 2)],
              fill=(235, 228, 212), width=int(m(0.006)))

    # aim line
    tip = (cue[0] + math.cos(phi) * 0.55, cue[1] + math.sin(phi) * 0.55)
    dashed_line(draw, pt(*cue), pt(*tip), m(0.004), (255, 255, 255, 200))

    # rack (rows of ivory balls) + cue ball
    gap = 2 * R + 0.004
    apex = (W / 2, L * 0.68)
    n = 1
    for row in range(4):          # partial rack for the visual
        for i in range(row + 1):
            x = apex[0] + (i - row / 2) * gap
            y = apex[1] + row * gap * math.sin(math.pi / 3)
            ball(draw, pt, m, x, y, cue=False, number=n)
            n += 1
    ball(draw, pt, m, cue[0], cue[1], cue=True)

    ASSETS.mkdir(exist_ok=True)
    img.save(ASSETS / "preview.png", optimize=True)
    print("wrote", ASSETS / "preview.png")


def dashed_line(draw, p0, p1, width, color):
    import math as _m
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    dist = _m.hypot(dx, dy)
    if dist == 0:
        return
    ux, uy = dx / dist, dy / dist
    t = 0.0
    while t < dist:
        seg_end = min(t + 12, dist)
        draw.line([p0[0] + ux * t, p0[1] + uy * t, p0[0] + ux * seg_end, p0[1] + uy * seg_end],
                  fill=color[:3], width=max(1, int(width)))
        t = seg_end + 8


def diamond(draw, cx, cy, r, fill):
    draw.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=fill)


def ball(draw, pt, m, x, y, cue=False, number=None):
    cx, cy = pt(x, y)
    r = m(R)
    # shadow
    draw.ellipse([cx - r * 0.92 + r * 0.18, cy - r * 0.85 + r * 0.3,
                  cx + r * 1.02 + r * 0.18, cy + r * 1.1 + r * 0.3], fill=(4, 44, 28))
    base = (242, 201, 76) if cue else (245, 239, 224)
    edge = (185, 143, 30) if cue else (185, 176, 154)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=base, outline=edge, width=2)
    if number is not None and r > 9:
        nr = r * 0.45
        draw.ellipse([cx - nr, cy - nr, cx + nr, cy + nr], fill=(255, 253, 244))
        draw.text((cx, cy), str(number), fill=(38, 34, 26), anchor="mm")


def draw_icon():
    """App icon: three pyramid balls on green felt."""
    size = 1024
    dimensions = (size, size)
    tile = (73, 65, 951, 943)
    mask = Image.new("L", dimensions)
    ImageDraw.Draw(mask).rounded_rectangle(tile, radius=192, fill=255)
    shade = Image.linear_gradient("L").resize(dimensions)
    img = Image.composite(Image.new("RGB", dimensions, "#063425"),
                          Image.new("RGB", dimensions, "#20956d"), shade).convert("RGBA")
    ImageDraw.Draw(img).rounded_rectangle(tile, radius=192, outline="#2d9c75", width=4)
    img.putalpha(mask)

    radius = 152
    balls = [(512, 328), (348, 612), (676, 612)]
    shadows = Image.new("RGBA", dimensions)
    shadow_draw = ImageDraw.Draw(shadows)
    for x, y in balls:
        shadow_draw.ellipse((x - 131, y + 68, x + 156, y + 178), fill=(0, 21, 16, 220))
    img.alpha_composite(shadows.filter(ImageFilter.GaussianBlur(21)))

    diameter = 2 * radius + 1
    lighting = Image.new("L", (diameter, diameter))
    values = []
    for py in range(-radius, radius + 1):
        for px in range(-radius, radius + 1):
            x, y = px / radius, py / radius
            z = math.sqrt(max(0, 1 - x * x - y * y))
            diffuse = max(0, -0.32 * x - 0.48 * y + 0.82 * z)
            highlight = max(0, -0.16 * x - 0.25 * y + 0.95 * z) ** 32
            values.append(round(255 * min(1, 0.20 + 0.72 * diffuse + 0.18 * highlight)))
    lighting.putdata(values)
    ball_mask = Image.new("L", lighting.size)
    ImageDraw.Draw(ball_mask).ellipse((0, 0, diameter - 1, diameter - 1), fill=255)
    colors = [("#fff2a4", "#b85b08"), ("#fffdef", "#a09879"), ("#fffdef", "#a09879")]
    for (x, y), (light, dark) in zip(balls, colors, strict=True):
        ball = Image.composite(Image.new("RGB", lighting.size, light),
                               Image.new("RGB", lighting.size, dark), lighting)
        ball.putalpha(ball_mask)
        img.alpha_composite(ball, (x - radius, y - radius))

    img.save(ASSETS / "icon.icns")
    print("wrote", ASSETS / "icon.icns")


if __name__ == "__main__":
    draw_preview()
    draw_icon()

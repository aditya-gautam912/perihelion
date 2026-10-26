"""Generate the social preview artwork (cover.svg + cover.png) with no build step.

PNG rendering uses Pillow when it is available; the SVG is always written so the
repo keeps a vector copy. Social crawlers reject SVG og:images, so public/
cover.png is what index.html advertises.
"""

import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"

SVG = """\
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="bg" cx="50%" cy="45%" r="75%">
      <stop offset="0" stop-color="#1d1820"/>
      <stop offset="0.55" stop-color="#0a0f1d"/>
      <stop offset="1" stop-color="#05070f"/>
    </radialGradient>
    <radialGradient id="star">
      <stop offset="0" stop-color="#fff4c4"/>
      <stop offset="0.3" stop-color="#ffb457"/>
      <stop offset="1" stop-color="#ff5a3d" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="14"/></filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="600" cy="315" r="128" fill="url(#star)" filter="url(#glow)"/>
  <circle cx="600" cy="315" r="48" fill="#ffb457"/>
  <circle cx="600" cy="315" r="108" fill="none" stroke="#57e6ff" stroke-width="3" opacity=".75"/>
  <circle cx="600" cy="315" r="182" fill="none" stroke="#57e6ff" stroke-width="1" opacity=".28"/>
  <circle cx="600" cy="315" r="246" fill="none" stroke="#ff6bd6" stroke-width="1" opacity=".2"/>
  <text x="600" y="112" text-anchor="middle" fill="#e9eefc" font-family="Segoe UI, sans-serif"
        font-size="68" font-weight="800" letter-spacing="14">PERIHELION</text>
  <text x="600" y="535" text-anchor="middle" fill="#aeb8d3" font-family="Segoe UI, sans-serif"
        font-size="21" letter-spacing="5">ONE STAR. ONE FLARE. NOTHING BRAKES.</text>
</svg>
"""

WIDTH, HEIGHT = 1200, 630
CX, CY = 600, 315
SANS = "Segoe UI, sans-serif"
FONTS = "C:/Windows/Fonts"


def load_font(stem, size):
    from PIL import ImageFont

    for candidate in (f"{FONTS}/{stem}.ttf", f"{FONTS}/{stem}.otf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_png():
    """Draw the cover with Pillow; returns True when written."""
    try:
        from PIL import Image, ImageDraw, ImageFilter
    except ImportError:
        print("Pillow is not installed - wrote cover.svg only")
        return False

    # Background: deep space with a faint cool lift behind the star.
    base = Image.new("RGB", (WIDTH, HEIGHT), "#05070f")
    lift = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    lift_draw = ImageDraw.Draw(lift)
    for step in range(48, 0, -1):
        radius = int(760 * step / 48)
        alpha = int(26 * (1 - step / 48)) + 3
        lift_draw.ellipse(
            (CX - radius, CY - radius, CX + radius, CY + radius),
            fill=(26, 34, 66, alpha),
        )
    lift = lift.filter(ImageFilter.GaussianBlur(30))
    img = Image.alpha_composite(base.convert("RGBA"), lift)

    draw = ImageDraw.Draw(img)

    # Orbit rings.
    for radius, stroke, alpha, width in (
        (108, (87, 230, 255), 190, 3),
        (182, (87, 230, 255), 70, 1),
        (246, (255, 107, 214), 50, 1),
    ):
        draw.ellipse(
            (CX - radius, CY - radius, CX + radius, CY + radius),
            outline=stroke + (alpha,),
            width=width,
        )

    # Star: tight, hot corona over the core.
    corona = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    corona_draw = ImageDraw.Draw(corona)
    for step in range(40, 0, -1):
        radius = int(46 + 96 * (step / 40))
        alpha = int(70 * (1 - step / 40) ** 1.5) + 3
        corona_draw.ellipse(
            (CX - radius, CY - radius, CX + radius, CY + radius),
            fill=(255, 150, 60, min(120, alpha)),
        )
    corona = corona.filter(ImageFilter.GaussianBlur(12))
    img = Image.alpha_composite(img, corona)
    draw = ImageDraw.Draw(img)
    draw.ellipse((CX - 44, CY - 44, CX + 44, CY + 44), fill=(255, 172, 80, 255))
    draw.ellipse((CX - 30, CY - 30, CX + 30, CY + 30), fill=(255, 210, 130, 255))
    draw.ellipse((CX - 16, CY - 16, CX + 16, CY + 16), fill=(255, 244, 196, 255))

    # A flare: the thing everyone is racing for.
    fx, fy = CX + 128, CY - 152
    flare_glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(flare_glow).ellipse(
        (fx - 46, fy - 46, fx + 46, fy + 46), fill=(255, 209, 102, 90)
    )
    flare_glow = flare_glow.filter(ImageFilter.GaussianBlur(14))
    img = Image.alpha_composite(img, flare_glow)
    draw = ImageDraw.Draw(img)
    draw.polygon([(fx, fy - 17), (fx + 12, fy), (fx, fy + 17), (fx - 12, fy)], fill=(255, 224, 150, 255))

    # Two ships on converging orbits, so it reads as a duel rather than a diagram.
    ship(draw, CX - 196, CY - 46, math.atan2(-60, 150), (87, 230, 255))
    ship(draw, CX + 168, CY + 96, math.atan2(-120, -140), (255, 107, 214))

    # Starfield.
    rng = random.Random(7)
    for _ in range(150):
        x = rng.randrange(0, WIDTH)
        y = rng.randrange(0, HEIGHT)
        if (x - CX) ** 2 + (y - CY) ** 2 < 150 ** 2:
            continue
        alpha = rng.randrange(40, 160)
        draw.ellipse((x, y, x + 2, y + 2), fill=(207, 230, 255, alpha))

    title_font = load_font("segoeuib", 76)
    tag_font = load_font("segoeui", 22)
    draw_centered(draw, img, "PERIHELION", title_font, (233, 238, 252, 255), CY - 252, spacing=14)
    draw_centered(draw, img, "ONE STAR. ONE FLARE. NOTHING BRAKES.", tag_font, (174, 184, 211, 255), CY + 218, spacing=5)

    img.convert("RGB").save(PUBLIC / "cover.png", "PNG", optimize=True)
    print("wrote public/cover.png")
    return True


def ship(draw, x, y, heading, color):
    """A small dart-shaped ship with a faint trail, pointing at heading."""
    size = 15
    nose = (x + math.cos(heading) * size * 1.35, y + math.sin(heading) * size * 1.35)
    back = (x - math.cos(heading) * size * 0.8, y - math.sin(heading) * size * 0.8)
    left = (
        back[0] + math.cos(heading + 2.3) * size * 0.95,
        back[1] + math.sin(heading + 2.3) * size * 0.95,
    )
    right = (
        back[0] + math.cos(heading - 2.3) * size * 0.95,
        back[1] + math.sin(heading - 2.3) * size * 0.95,
    )
    draw.polygon([nose, left, back, right], fill=color + (255,))
    for step in range(10, 0, -2):
        alpha = int(70 * (1 - step / 10))
        cx = back[0] - math.cos(heading) * step * 5
        cy = back[1] - math.sin(heading) * step * 5
        draw.ellipse((cx - 3, cy - 3, cx + 3, cy + 3), fill=color + (alpha,))


def draw_centered(draw, img, text, font, fill, y, spacing=0):
    """Center text manually so we can honour letter-spacing."""
    widths = [draw.textlength(ch, font=font) for ch in text]
    total = sum(widths) + spacing * (len(text) - 1)
    x = (img.size[0] - total) / 2
    for ch, width in zip(text, widths):
        draw.text((x, y), ch, font=font, fill=fill)
        x += width + spacing


def main():
    PUBLIC.mkdir(exist_ok=True)
    PUBLIC.joinpath("cover.svg").write_text(SVG, encoding="utf-8")
    print("wrote public/cover.svg")
    render_png()


if __name__ == "__main__":
    main()

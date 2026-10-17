"""Draws the Dotion "D" icon at every size the apps need.

Run from the repository root:  python mobile/icon/make_icons.py
The D uses the same shape as the notification icon (res/drawable/ic_stat_dotion.xml).
"""
from pathlib import Path

from PIL import Image, ImageDraw

NAVY = (27, 38, 59, 255)  # #1b263b
PAPER = (244, 246, 249, 255)
ROOT = Path(__file__).resolve().parents[2]
SS = 4  # supersampling for smooth edges


def draw_d(draw: ImageDraw.ImageDraw, size: int, scale: float, fill, hole) -> None:
    """The D on a 24-unit grid (outer: x 5→20.5, y 3→21; counter: x 8.5→17, y 6.5→17.5),
    centred horizontally and scaled by `scale` of the canvas."""
    unit = size * scale / 24
    ox = size / 2 - 12.75 * unit  # the D's horizontal centre is x = 12.75
    oy = size / 2 - 12 * unit

    def p(x, y):
        return (ox + x * unit, oy + y * unit)

    draw.rectangle([p(5, 3), p(11.5, 21)], fill=fill)
    draw.pieslice([p(2.5, 3), p(20.5, 21)], -90, 90, fill=fill)
    draw.rectangle([p(8.5, 6.5), p(11.5, 17.5)], fill=hole)
    draw.pieslice([p(6, 6.5), p(17, 17.5)], -90, 90, fill=hole)


def render(size: int, shape: str, scale: float) -> Image.Image:
    """shape: "square" (rounded), "circle", or "none" (transparent background)."""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if shape == "square":
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22, fill=NAVY)
    elif shape == "circle":
        d.ellipse([0, 0, big - 1, big - 1], fill=NAVY)
    if shape == "none":
        # Draw on a separate layer so the counter is transparent, not navy.
        layer = Image.new("L", (big, big), 0)
        draw_d(ImageDraw.Draw(layer), big, scale, 255, 0)
        img.paste(Image.new("RGBA", (big, big), PAPER), mask=layer)
    else:
        draw_d(d, big, scale, PAPER, NAVY)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    res = ROOT / "mobile/android/app/src/main/res"
    for density, launcher, fg in [("mdpi", 48, 108), ("hdpi", 72, 162), ("xhdpi", 96, 216), ("xxhdpi", 144, 324), ("xxxhdpi", 192, 432)]:
        out = res / f"mipmap-{density}"
        render(launcher, "square", 0.62).save(out / "ic_launcher.png")
        render(launcher, "circle", 0.58).save(out / "ic_launcher_round.png")
        # Adaptive icon foreground: 108dp canvas, the D inside the 66dp safe zone.
        render(fg, "none", 0.42).save(out / "ic_launcher_foreground.png")

    # Splash screens (every density and orientation Capacitor generated): navy with the D.
    for splash in res.glob("drawable*/splash.png"):
        w, h = Image.open(splash).size
        img = Image.new("RGBA", (w * SS, h * SS), NAVY)
        side = min(w, h) * SS
        mark = Image.new("L", (side, side), 0)
        draw_d(ImageDraw.Draw(mark), side, 0.38, 255, 0)
        img.paste(Image.new("RGBA", (side, side), PAPER), ((w * SS - side) // 2, (h * SS - side) // 2), mask=mark)
        img.resize((w, h), Image.LANCZOS).convert("RGB").save(splash)

    (ROOT / "desktop/build").mkdir(exist_ok=True)
    render(1024, "square", 0.62).save(ROOT / "desktop/build/appicon.png")  # Wails builds the .ico from this

    public = ROOT / "ui/public"
    public.mkdir(exist_ok=True)
    render(180, "square", 0.62).save(public / "apple-touch-icon.png")
    render(512, "square", 0.62).save(public / "icon-512.png")
    print("icons written")


if __name__ == "__main__":
    main()

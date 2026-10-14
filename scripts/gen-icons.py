"""生成插件图标（16/32/48/128），输出目录 public/icons。

用法：python3 scripts/gen-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]

SIZES = (16, 32, 48, 128)
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = (47, 107, 255, 255)
FG = (255, 255, 255, 255)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_icon(size: int) -> Image.Image:
    scale = 8  # 先画大图再缩放，边缘更平滑
    big = size * scale
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = int(big * 0.22)
    draw.rounded_rectangle([(0, 0), (big - 1, big - 1)], radius=radius, fill=BG)

    font = load_font(int(big * 0.6))
    text = "P"
    box = draw.textbbox((0, 0), text, font=font)
    x = (big - (box[2] - box[0])) / 2 - box[0]
    y = (big - (box[3] - box[1])) / 2 - box[1]
    draw.text((x, y), text, font=font, fill=FG)

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        draw_icon(size).save(OUT_DIR / f"icon-{size}.png")
        print(f"wrote {OUT_DIR / f'icon-{size}.png'}")


if __name__ == "__main__":
    main()

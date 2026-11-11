# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow>=12"]
# ///
"""Build the motif masks the app serves from the generated source art.

Each design/motifs/<slug>.png (black on transparent) becomes
public/motifs/<slug>.webp: black RGB plus the source's alpha channel, which is
all CSS mask-image reads. The source art has uneven transparent margins, so the
script trims them and anchors the art to the bottom-right of the canvas: every
ornament sits flush in its corner. After writing each WebP it reads it back and
fails unless the art touches the bottom row and right column.

    uv run scripts/build-motifs.py
"""

from pathlib import Path

from PIL import Image

SRC = Path("design/motifs")
OUT = Path("public/motifs")
SIZE = 1024
TRIM_THRESHOLD = 10

OUT.mkdir(parents=True, exist_ok=True)
for src in sorted(SRC.glob("*.png")):
    alpha = Image.open(src).convert("RGBA").getchannel("A")
    box = alpha.point(lambda a: 255 if a > TRIM_THRESHOLD else 0).getbbox()
    if box is None:
        raise SystemExit(f"{src.stem}: image is fully transparent")
    art = alpha.crop(box)

    # Fit inside SIZE x SIZE, keep the aspect ratio, anchor bottom-right.
    scale = min(SIZE / art.width, SIZE / art.height)
    width, height = round(art.width * scale), round(art.height * scale)
    mask = Image.new("L", (SIZE, SIZE), 0)
    mask.paste(art.resize((width, height), Image.Resampling.LANCZOS),
               (SIZE - width, SIZE - height))

    black = Image.new("L", (SIZE, SIZE), 0)
    out = OUT / f"{src.stem}.webp"
    Image.merge("RGBA", (black, black, black, mask)).save(
        out, "WEBP", quality=70, alpha_quality=80, method=6
    )

    back = Image.open(out).convert("RGBA").getchannel("A")
    bottom = any(back.getpixel((i, SIZE - 1)) > 0 for i in range(SIZE))
    right = any(back.getpixel((SIZE - 1, i)) > 0 for i in range(SIZE))
    if not (bottom and right):
        raise SystemExit(f"{src.stem}: art is not flush with the bottom/right edges")
    print(src.stem)

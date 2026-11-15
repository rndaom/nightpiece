"""Lay a run of saved frames out as one contact sheet, to review an animation beat by beat.

    python tools/dev/sheet.py docs/screenshots/m4/seq- --out docs/screenshots/m4/sheet.jpg [--columns 4] [--crop x0,y0,x1,y1]

Takes every image whose path starts with the given prefix, in name order. Each tile is labelled
with the end of its file name. Needs Pillow.
"""
import argparse
import glob
import os

from PIL import Image, ImageDraw


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("prefix")
    ap.add_argument("--out", required=True)
    ap.add_argument("--columns", type=int, default=4)
    ap.add_argument("--width", type=int, default=480, help="width of each tile in pixels")
    ap.add_argument("--crop", default=None, help="x0,y0,x1,y1 as fractions of the frame")
    a = ap.parse_args()

    files = sorted(f for f in glob.glob(a.prefix + "*") if os.path.abspath(f) != os.path.abspath(a.out))
    if not files:
        raise SystemExit(f"no frames match {a.prefix}*")
    tiles = []
    for f in files:
        im = Image.open(f).convert("RGB")
        if a.crop:
            x0, y0, x1, y1 = (float(v) for v in a.crop.split(","))
            im = im.crop((int(x0 * im.width), int(y0 * im.height), int(x1 * im.width), int(y1 * im.height)))
        height = round(a.width * im.height / im.width)
        im = im.resize((a.width, height), Image.LANCZOS)
        label = os.path.splitext(os.path.basename(f))[0][-6:]
        draw = ImageDraw.Draw(im)
        draw.rectangle((0, 0, 8 + 7 * len(label), 16), fill=(0, 0, 0))
        draw.text((4, 2), label, fill=(236, 227, 204))
        tiles.append(im)

    rows = (len(tiles) + a.columns - 1) // a.columns
    w, h = tiles[0].size
    sheet = Image.new("RGB", (a.columns * w, rows * h), (12, 11, 9))
    for i, im in enumerate(tiles):
        sheet.paste(im, ((i % a.columns) * w, (i // a.columns) * h))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    sheet.save(a.out, quality=88)
    print(f"{len(tiles)} frames -> {a.out} ({sheet.width}x{sheet.height})")


if __name__ == "__main__":
    main()

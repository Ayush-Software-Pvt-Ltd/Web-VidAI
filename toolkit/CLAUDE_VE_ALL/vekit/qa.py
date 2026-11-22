"""Visual QA without a full build: one composited frame per shot, tiled into contact sheets.

`ve.py frames` renders a single frame from the middle of every shot through the same
`render.shot_cmd` the final render uses, so the sheet shows exactly what will be
composited (host, punch-in, b-roll, graphics, overlays) in about 20 s for a whole Short.
"""
from pathlib import Path

from PIL import Image, ImageDraw

from . import tools


def _font(size):
    return tools.label_font(size)


def tile(items, out, cols=6, width=260):
    """items = [(image path, label)] -> one labelled contact sheet."""
    ims = []
    for p, label in items:
        im = Image.open(p).convert("RGB")
        h = max(2, round(width * im.height / im.width))
        ims.append((im.resize((width, h), Image.LANCZOS), label))
    if not ims:
        raise ValueError("nothing to tile")
    cw, ch = ims[0][0].size
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw, rows * ch), "black")
    d = ImageDraw.Draw(sheet)
    f = _font(max(13, width // 14))
    for i, (im, label) in enumerate(ims):
        x, y = (i % cols) * cw, (i // cols) * ch
        sheet.paste(im, (x, y))
        text = label if len(label) <= 34 else label[:33] + "…"
        w = f.getlength(text) + 8
        d.rectangle([x, y, x + w, y + f.size + 6], fill="black")
        d.text((x + 4, y + 2), text, font=f, fill="yellow")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=88)
    return out

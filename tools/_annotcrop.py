"""
Crop each annotated screenshot to the region the blue stroke covers, and report where that is.

Why: a hand-drawn outline says *which* part of the frame matters but not *what is under it* — the
marked surface is a few hundred pixels of a 1920-wide frame, and reading it from the full image means
reading the whole room at once. Isolating the stroke and scaling the crop up turns "somewhere around
the doorway" into "this specific surface", which is what has to be identified before geometry moves.

The stroke is rgb(0, 112, 208) — measured, not guessed. A loose "blue-ish" test swept up the browser
chrome, the taskbar and the HUD, and put the box round nearly the whole frame.

Also emits a per-column occupancy table: the columns the stroke actually covers say whether the mark
is a wall (a tall band on one side), an opening (a frame round a gap) or a floor patch (a wide, short
band low in the frame) — three shapes that need three different fixes.
"""

import os

from PIL import Image

SRC = [
    (r"C:\Users\TIMOTHY\OneDrive\Desktop\Screenshot (256).png", "256"),
    (r"C:\Users\TIMOTHY\OneDrive\Desktop\Screenshot (257).png", "257"),
    (r"C:\Users\TIMOTHY\OneDrive\Desktop\Screenshot (259).png", "259"),
    (r"C:\Users\TIMOTHY\OneDrive\Desktop\Screenshot (239).png", "239"),
    (r"C:\Users\TIMOTHY\OneDrive\Desktop\Screenshot (255).png", "255"),
]
OUT = r"D:\daayan - main\shots\annot"
os.makedirs(OUT, exist_ok=True)

TARGET = (0, 112, 208)
TOL = 46


def is_stroke(r: int, g: int, b: int) -> bool:
    return abs(r - TARGET[0]) < TOL and abs(g - TARGET[1]) < TOL and abs(b - TARGET[2]) < TOL


for path, tag in SRC:
    if not os.path.exists(path):
        print(f"MISSING {path}")
        continue
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()

    # Only the game's own viewport: below the browser toolbar, above the taskbar.
    top, bottom = 90, min(h, 880)

    minx, miny, maxx, maxy = w, h, -1, -1
    hits = 0
    cols: dict[int, int] = {}
    for y in range(top, bottom):
        for x in range(w):
            r, g, b = px[x, y]
            if is_stroke(r, g, b):
                hits += 1
                cols[x] = cols.get(x, 0) + 1
                if x < minx:
                    minx = x
                if y < miny:
                    miny = y
                if x > maxx:
                    maxx = x
                if y > maxy:
                    maxy = y

    if hits == 0 or maxx < 0:
        print(f"{tag}: {w}x{h}  NO STROKE FOUND")
        continue

    mx = int((maxx - minx) * 0.20) + 30
    my = int((maxy - miny) * 0.20) + 30
    box = (max(0, minx - mx), max(top, miny - my), min(w, maxx + mx), min(bottom, maxy + my))
    crop = im.crop(box)
    scale = max(1, min(3, int(1300 / max(1, crop.width))))
    crop = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
    dest = os.path.join(OUT, f"{tag}-blue.png")
    crop.save(dest)

    # Occupancy by column, in tenths of the frame width, so the shape is visible as numbers.
    bands = []
    for i in range(10):
        lo = int(w * i / 10)
        hi = int(w * (i + 1) / 10)
        bands.append(sum(v for k, v in cols.items() if lo <= k < hi))
    shape = "tall narrow band" if (maxy - miny) > (maxx - minx) else "wide flat band"

    print(
        f"{tag}: {w}x{h}  stroke bbox x {minx}..{maxx} y {miny}..{maxy}  "
        f"({hits} px, {(maxx - minx)}x{(maxy - miny)} = {shape})"
    )
    print(f"     columns L->R by tenth: {bands}   -> {os.path.basename(dest)}")

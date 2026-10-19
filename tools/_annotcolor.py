"""
Report the dominant saturated colours in an annotated screenshot, so the annotation stroke can be
isolated by its exact colour rather than by a guess.

Why: the first pass used a loose "blue-ish" test and swept up the browser chrome, the taskbar and the
game's own HUD, which put the bounding box round almost the whole frame. The stroke is one specific
colour; finding it exactly is what makes the crop meaningful.
"""

import os
from collections import Counter

from PIL import Image

SRC = [
    r"C:\Users\TIMOTHY\OneDrive\Desktop\Screenshot (256).png",
    r"C:\Users\TIMOTHY\OneDrive\Desktop\Screenshot (239).png",
    r"C:\Users\TIMOTHY\OneDrive\Desktop\Screenshot (255).png",
]


def sat(r: int, g: int, b: int) -> bool:
    """Anything clearly coloured: one channel well above the others."""
    hi = max(r, g, b)
    lo = min(r, g, b)
    return hi > 110 and hi - lo > 70


for path in SRC:
    if not os.path.exists(path):
        print(f"MISSING {path}")
        continue
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    # Ignore the outer frame: browser chrome at the top, the Windows taskbar at the bottom.
    top, bottom = 90, min(h, 880)
    counts: Counter[tuple[int, int, int]] = Counter()
    for y in range(top, bottom, 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            if sat(r, g, b):
                # Quantise so near-identical stroke pixels group instead of splitting.
                counts[(r // 16 * 16, g // 16 * 16, b // 16 * 16)] += 1
    print(f"\n{os.path.basename(path)}  {w}x{h}  scene rows {top}..{bottom}")
    for (r, g, b), n in counts.most_common(6):
        kind = "BLUE" if b > r and b > g else ("GREEN" if g > r and g > b else "RED")
        print(f"   rgb({r:3d},{g:3d},{b:3d})  {kind}  {n} samples")

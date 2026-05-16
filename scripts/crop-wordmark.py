"""Crops the WISP wordmark from the source image: removes the dark background
via flood-fill from the four corners (preserves internal dark outlines that
are enclosed by yellow letter blocks), then tight-crops to the non-transparent
bounding box.

Outputs:
- apps/dashboard-web/public/wisp-wordmark.png  (sidebar wordmark)
- docs/assets/wisp-logo.png                    (README hero)
"""
from pathlib import Path
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "WISP_Schriftzug.png"
DASHBOARD_DST = REPO / "apps" / "dashboard-web" / "public" / "wisp-wordmark.png"
README_DST = REPO / "docs" / "assets" / "wisp-logo.png"


def main() -> None:
    img = Image.open(SRC).convert("RGBA")
    w, h = img.size
    print(f"source: {SRC.name}  {w}x{h}")

    # Sample BG from a corner. Flood-fill all four corners with high tolerance
    # so the entire surround turns transparent. Tolerance 40 lets us absorb
    # JPEG-ish noise while staying inside the yellow letter boundary.
    bg = img.getpixel((2, 2))
    print(f"bg corner: {bg}")
    for x, y in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(img, (x, y), (0, 0, 0, 0), thresh=40)

    # Second pass: kill enclosed counters (e.g. inside of P). After the
    # corner-flood-fill, anything still opaque AND dark-bg-coloured must be
    # a counter (enclosed inside a yellow letter). Probe a horizontal sweep
    # across the upper third of the image and seed flood-fill at any matching
    # pixel.
    bg_rgb = bg[:3]
    probe_y_range = [int(h * 0.20), int(h * 0.30), int(h * 0.40)]
    bg_tol = 40
    counters_killed = 0
    for py in probe_y_range:
        for px in range(0, w, 16):
            pixel = img.getpixel((px, py))
            if pixel[3] == 0:
                continue  # already transparent
            if all(abs(pixel[c] - bg_rgb[c]) < bg_tol for c in range(3)):
                ImageDraw.floodfill(img, (px, py), (0, 0, 0, 0), thresh=40)
                counters_killed += 1
    print(f"counter probes that fired: {counters_killed}")

    # Tight crop to alpha bbox.
    bbox = img.getbbox()
    if not bbox:
        raise SystemExit("ERROR: flood-fill removed everything — tolerance too high")
    cropped = img.crop(bbox)
    print(f"cropped: {cropped.size}  bbox={bbox}")

    DASHBOARD_DST.parent.mkdir(parents=True, exist_ok=True)
    README_DST.parent.mkdir(parents=True, exist_ok=True)
    cropped.save(DASHBOARD_DST, optimize=True)
    cropped.save(README_DST, optimize=True)
    print(f"wrote: {DASHBOARD_DST.relative_to(REPO)}")
    print(f"wrote: {README_DST.relative_to(REPO)}")


if __name__ == "__main__":
    main()

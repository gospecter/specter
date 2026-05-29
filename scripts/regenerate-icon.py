#!/usr/bin/env python3
"""
Regenerate the Specter app icon.

Removes the baked-in "Specter" wordmark from mac/Assets/AppIconSource.png
(Apple's HIG discourages text in app icons — it's redundant with the app name
and illegible at menu-bar / Spotlight sizes), then rebuilds the .iconset PNGs
and AppIcon.icns from the cleaned artwork.

Usage:   python3 scripts/regenerate-icon.py
Requires: Pillow, and macOS `iconutil` (built in).

The original artwork is kept as AppIconSource-with-text.png.
"""
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit('Pillow is required:  python3 -m pip install Pillow')

ASSETS = Path(__file__).resolve().parent.parent / 'mac' / 'Assets'
SOURCE = ASSETS / 'AppIconSource.png'
BACKUP = ASSETS / 'AppIconSource-with-text.png'
ICONSET = ASSETS / 'AppIcon.iconset'
ICNS = ASSETS / 'AppIcon.icns'


def dist(a, b):
    return sum((x - y) ** 2 for x, y in zip(a[:3], b[:3])) ** 0.5


def main():
    if not BACKUP.exists():
        shutil.copy(SOURCE, BACKUP)
        print(f'backed up original -> {BACKUP.name}')

    img = Image.open(BACKUP).convert('RGB')
    w, h = img.size
    px = img.load()
    print(f'source: {w}x{h}')

    purple = px[5, 5]  # corner = background
    print(f'background purple: {purple}')

    # The ghost body is grey, so any purple-ish pixel inside a central band of
    # the body can only be the wordmark. Find their bounding box.
    bx0, bx1 = int(w * 0.26), int(w * 0.74)
    by0, by1 = int(h * 0.54), int(h * 0.76)
    minx = miny = 10 ** 9
    maxx = maxy = -1
    for y in range(by0, by1):
        for x in range(bx0, bx1):
            if dist(px[x, y], purple) < 80:
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
    if maxx < 0:
        sys.exit('no wordmark detected in the expected region — aborting')
    print(f'wordmark bbox: x[{minx},{maxx}] y[{miny},{maxy}]')

    # Sample the ghost body grey from just above the wordmark.
    body = px[w // 2, max(0, miny - int(h * 0.04))]
    print(f'ghost body grey: {body}')

    # Paint the wordmark out with the body grey (+ a small margin).
    margin = int(w * 0.025)
    for y in range(max(0, miny - margin), min(h, maxy + margin + 1)):
        for x in range(max(0, minx - margin), min(w, maxx + margin + 1)):
            px[x, y] = body

    img.save(SOURCE)
    print(f'cleaned artwork -> {SOURCE.name}')

    # Rebuild every iconset size from the cleaned artwork.
    ICONSET.mkdir(exist_ok=True)
    for size in (16, 32, 128, 256, 512):
        for scale, suffix in ((1, ''), (2, '@2x')):
            px_size = size * scale
            out = ICONSET / f'icon_{size}x{size}{suffix}.png'
            img.resize((px_size, px_size), Image.LANCZOS).save(out)
    print(f'rebuilt {len(list(ICONSET.glob("*.png")))} iconset PNGs')

    subprocess.run(['iconutil', '-c', 'icns', str(ICONSET), '-o', str(ICNS)], check=True)
    print(f'built -> {ICNS.name}')


if __name__ == '__main__':
    main()

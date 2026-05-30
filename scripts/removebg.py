#!/usr/bin/env python3
"""
remove_magenta_bg.py
Removes the background color from all images in a directory by sampling
the four corner pixels of each image, then replaces matching pixels with
transparency and saves as PNG.

Usage:
    python remove_magenta_bg.py <input_dir> [output_dir] [--tolerance 30]

Arguments:
    input_dir     Directory containing images to process
    output_dir    (Optional) Directory to save results. Defaults to
                  a subfolder named 'output' inside input_dir.
    --tolerance   Color tolerance (0-255). Higher = more aggressive removal.
                  Default: 30

Supported input formats: PNG, JPG, JPEG, BMP, GIF, TIFF, WEBP
Output format: always PNG (required to support transparency)
"""

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
    import numpy as np
except ImportError:
    print("Missing dependencies. Install them with:")
    print("    pip install Pillow numpy")
    sys.exit(1)


SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tiff", ".tif", ".webp"}


def sample_background_color(data: np.ndarray) -> np.ndarray:
    """
    Return the average RGB of the four corner pixels as the background color.

    Using the mean of all four corners handles slight compression artifacts
    (e.g. JPEG) where corners may not be exactly the same value.
    """
    h, w = data.shape[:2]
    corners = np.array([
        data[0,   0,   :3],   # top-left
        data[0,   w-1, :3],   # top-right
        data[h-1, 0,   :3],   # bottom-left
        data[h-1, w-1, :3],   # bottom-right
    ], dtype=np.float32)
    return corners.mean(axis=0)


def remove_background(image: Image.Image, tolerance: int = 30) -> Image.Image:
    """
    Sample the background color from the four corners of *image*, then
    replace all pixels within *tolerance* of that color with transparency.

    A feathering zone (half the tolerance) softens hard edges so the
    result looks natural.

    Returns an RGBA Image.
    """
    img = image.convert("RGBA")
    data = np.array(img, dtype=np.float32)          # H x W x 4

    rgb = data[:, :, :3]                            # R, G, B channels
    alpha = data[:, :, 3]                           # existing alpha

    # Detect background color from corners
    bg_color = sample_background_color(data)

    # Euclidean distance from background color for every pixel
    diff = rgb - bg_color                           # broadcast
    distance = np.sqrt(np.sum(diff ** 2, axis=2))  # H x W

    # Build a soft mask: 0 = fully transparent, 1 = fully opaque
    # Pixels closer than tolerance fade out proportionally (feathering)
    feather = 0.5 * tolerance                       # inner fade zone
    mask = np.clip((distance - feather) / (tolerance - feather + 1e-6), 0.0, 1.0)

    # Multiply existing alpha by our mask
    new_alpha = (alpha * mask).astype(np.uint8)
    result = data.copy().astype(np.uint8)
    result[:, :, 3] = new_alpha

    return Image.fromarray(result, "RGBA"), bg_color


def process_directory(input_dir: Path, output_dir: Path, tolerance: int) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    image_files = [
        f for f in input_dir.iterdir()
        if f.is_file() and f.suffix.lower() in SUPPORTED_EXTENSIONS
    ]

    if not image_files:
        print(f"No supported images found in: {input_dir}")
        return

    print(f"Found {len(image_files)} image(s). Processing with tolerance={tolerance}…\n")

    success, failed = 0, 0

    for path in sorted(image_files):
        out_path = output_dir / (path.stem + ".png")
        try:
            with Image.open(path) as img:
                result, bg_color = remove_background(img, tolerance=tolerance)
                result.save(out_path, "PNG")
            r, g, b = (int(c) for c in bg_color)
            print(f"  ✓  {path.name}  →  {out_path.name}  (bg sampled: #{r:02X}{g:02X}{b:02X})")
            success += 1
        except Exception as exc:
            print(f"  ✗  {path.name}  —  ERROR: {exc}")
            failed += 1

    print(f"\nDone. {success} processed, {failed} failed.")
    print(f"Output saved to: {output_dir.resolve()}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Remove image backgrounds by sampling corner pixels, making them transparent."
    )
    parser.add_argument("input_dir", help="Directory containing images to process")
    parser.add_argument(
        "output_dir",
        nargs="?",
        default=None,
        help="Directory to save processed images (default: <input_dir>/output)",
    )
    parser.add_argument(
        "--tolerance",
        type=int,
        default=30,
        metavar="0-255",
        help="Color distance tolerance — higher removes more shades of magenta (default: 30)",
    )

    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    if not input_dir.is_dir():
        print(f"Error: '{input_dir}' is not a valid directory.")
        sys.exit(1)

    output_dir = Path(args.output_dir) if args.output_dir else input_dir / "output"

    if not (0 <= args.tolerance <= 255):
        print("Error: --tolerance must be between 0 and 255.")
        sys.exit(1)

    process_directory(input_dir, output_dir, args.tolerance)


if __name__ == "__main__":
    main()
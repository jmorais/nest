#!/usr/bin/env python3

from pathlib import Path
from PIL import Image
import argparse
import base64
import json
import math


IMAGE_EXTENSIONS = {
  ".png",
  ".webp",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".tif",
  ".tiff",
}


def is_primary_species_image(path: Path) -> bool:
  stem = path.stem.lower()

  if path.suffix.lower() not in IMAGE_EXTENSIONS:
    return False

  # Excludes names like "acanthis-flammea-2.png"
  if stem.endswith("-2"):
    return False

  return True


def slug_from_path(path: Path) -> str:
  return path.stem


def make_alpha_mask_bits(
  image: Image.Image,
  target_width: int,
  alpha_threshold: int
) -> dict:
  image = image.convert("RGBA")
  width, height = image.size

  mask_width = target_width
  mask_height = max(1, round(height * (mask_width / width)))

  small = image.resize((mask_width, mask_height), Image.Resampling.LANCZOS)
  alpha = small.getchannel("A")

  bits = []
  current_byte = 0
  bit_count = 0
  packed = bytearray()

  for y in range(mask_height):
    for x in range(mask_width):
      is_opaque = alpha.getpixel((x, y)) >= alpha_threshold

      current_byte = (current_byte << 1) | int(is_opaque)
      bit_count += 1

      if bit_count == 8:
        packed.append(current_byte)
        current_byte = 0
        bit_count = 0

  if bit_count:
    current_byte <<= 8 - bit_count
    packed.append(current_byte)

  return {
    "w": mask_width,
    "h": mask_height,
    "bits": base64.b64encode(bytes(packed)).decode("ascii"),
  }


def generate_metadata(
  input_dir: Path,
  output_dir: Path,
  target_mask_width: int,
  alpha_threshold: int,
  recursive: bool
) -> None:
  output_dir.mkdir(parents=True, exist_ok=True)

  if recursive:
    image_paths = sorted(input_dir.rglob("*"))
  else:
    image_paths = sorted(input_dir.glob("*"))

  image_paths = [
    path for path in image_paths
    if path.is_file() and is_primary_species_image(path)
  ]

  dims = {}
  masks = {}

  for image_path in image_paths:
    slug = slug_from_path(image_path)

    with Image.open(image_path) as img:
      width, height = img.size

      dims[slug] = [width, height]
      masks[slug] = make_alpha_mask_bits(
        image=img,
        target_width=target_mask_width,
        alpha_threshold=alpha_threshold
      )

    print(f"Processed: {slug}")

  dims_path = output_dir / "dims.json"
  masks_path = output_dir / "masks.json"

  dims_path.write_text(
    json.dumps(dims, separators=(",", ":"), ensure_ascii=False),
    encoding="utf-8"
  )

  masks_path.write_text(
    json.dumps(masks, separators=(",", ":"), ensure_ascii=False),
    encoding="utf-8"
  )

  print(f"Saved: {dims_path}")
  print(f"Saved: {masks_path}")


def main() -> None:
  parser = argparse.ArgumentParser(
    description="Generate dims.json and masks.json for bird species images."
  )
  parser.add_argument(
    "input_dir",
    type=Path,
    help="Directory containing bird species images"
  )
  parser.add_argument(
    "-o",
    "--output-dir",
    type=Path,
    default=Path("."),
    help="Directory where dims.json and masks.json will be written"
  )
  parser.add_argument(
    "--mask-width",
    type=int,
    default=93,
    help="Downsampled mask width"
  )
  parser.add_argument(
    "--alpha-threshold",
    type=int,
    default=16,
    help="Alpha threshold from 0 to 255 used to decide if a mask pixel is solid"
  )
  parser.add_argument(
    "-r",
    "--recursive",
    action="store_true",
    help="Search subdirectories too"
  )

  args = parser.parse_args()

  if not args.input_dir.is_dir():
    raise SystemExit(f"Input directory does not exist: {args.input_dir}")

  generate_metadata(
    input_dir=args.input_dir,
    output_dir=args.output_dir,
    target_mask_width=max(1, args.mask_width),
    alpha_threshold=max(0, min(args.alpha_threshold, 255)),
    recursive=args.recursive
  )


if __name__ == "__main__":
  main()
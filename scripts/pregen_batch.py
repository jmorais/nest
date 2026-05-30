#!/usr/bin/env python3
"""AvianVisitors - pre-generate kachō-e illustrations for a region using Gemini Batch API.

Reads a species list (BirdNET-Pi's labels.txt, eBird, or stdin), creates a
Gemini Batch API JSONL job, polls for completion, and saves PNGs into
avian/assets/illustrations/.

Each species gets two poses: <slug>.png (perched) and <slug>-2.png (flight).
Edit avian/scripts/prompt.template.md to change the visual style.

Usage:
    # Install the current SDK first:
    python3 -m pip install -U google-genai

    # Every species BirdNET-Pi knows, submit + wait + save images:
    python3 pregen_batch.py --labels ~/BirdNET-Pi/model/labels.txt

    # Only species observed in an eBird region:
    python3 pregen_batch.py --labels ~/BirdNET-Pi/model/labels.txt \
      --ebird-region US-CA --ebird-key YOUR_KEY

    # Re-render a single species:
    python3 pregen_batch.py --species "Calypte anna|Anna's Hummingbird" --force

    # Submit without waiting. The printed job name can be resumed later:
    python3 pregen_batch.py --labels ~/BirdNET-Pi/model/labels.txt --submit-only

    # Poll/download an existing batch job:
    python3 pregen_batch.py --job batches/123456789

Set GEMINI_API_KEY in the environment (preferred) or pass --gemini-key.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types

MODEL = "gemini-3.1-flash-image"
POSES = {1: "perched", 2: "in flight with wings spread"}
COMPLETED_STATES = {
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
}


def slugify(sci: str) -> str:
  """Match avian/frontend/apt.js slugify() exactly."""
  return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


def parse_species_line(line: str) -> tuple[str, str] | None:
  """Accept any of: 'Sci|Com', 'Sci_Com', 'Sci,Com'. Skip blanks + #."""
  line = line.strip()
  if not line or line.startswith("#"):
    return None
  for sep in ("|", "_", ","):
    if sep in line:
      sci, com = line.split(sep, 1)
      sci, com = sci.strip(), com.strip()
      if sci and com:
        return (sci, com)
  return None


def parse_species_list(lines: list[str]) -> tuple[list[tuple[str, str]], int]:
  """Returns (parsed, skipped_count)."""
  out, skipped = [], 0
  for line in lines:
    parsed = parse_species_line(line)
    if parsed:
      out.append(parsed)
    elif line.strip() and not line.lstrip().startswith("#"):
      skipped += 1
  return out, skipped


def load_prompt(path: Path) -> str:
  """Return text after `## Prompt`, ending before the next `##` heading."""
  text = path.read_text()
  m = re.search(r"##\s*Prompt\s*\n(.+?)(?=\n##\s|\Z)", text, flags=re.DOTALL)
  return (m.group(1) if m else text).strip()


def ebird_filter(species: list[tuple[str, str]], region: str, key: str) -> list[tuple[str, str]]:
  """Intersect a label set with the eBird species list for a region."""
  url = f"https://api.ebird.org/v2/product/spplist/{region}"
  req = urllib.request.Request(url, headers={"X-eBirdApiToken": key})
  with urllib.request.urlopen(req, timeout=30) as r:
    ebird_codes = set(json.loads(r.read()))

  tax_url = "https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json"
  req2 = urllib.request.Request(tax_url, headers={"X-eBirdApiToken": key})
  with urllib.request.urlopen(req2, timeout=60) as r:
    taxonomy = json.loads(r.read())

  code_to_sci = {t["speciesCode"]: t["sciName"] for t in taxonomy}
  allowed = {code_to_sci[c] for c in ebird_codes if c in code_to_sci}
  return [(s, c) for s, c in species if s in allowed]


def render_prompt(prompt: str, sci: str, com: str, pose: int) -> str:
  return (
    prompt
    .replace("{sci_name}", sci)
    .replace("{com_name}", com)
    .replace("{pose}", POSES[pose])
  )


def file_name_for_species(sci: str, pose: int) -> str:
  slug = slugify(sci)
  return f"{slug}.png" if pose == 1 else f"{slug}-{pose}.png"


def batch_key(file_name: str) -> str:
  return file_name.removesuffix(".png")


def build_batch_jsonl(
  species: list[tuple[str, str]],
  poses: list[int],
  prompt: str,
  out_dir: Path,
  jsonl_path: Path,
  force: bool,
  image_size: str,
  aspect_ratio: str,
) -> tuple[int, int]:
  """Write missing image requests to JSONL. Returns (request_count, skipped_count)."""
  request_count = 0
  skipped_existing = 0

  with jsonl_path.open("w", encoding="utf-8") as f:
    for sci, com in species:
      for pose in poses:
        file_name = file_name_for_species(sci, pose)
        target = out_dir / file_name
        if target.exists() and not force:
          skipped_existing += 1
          continue

        body = render_prompt(prompt, sci, com, pose)
        req = {
          "key": batch_key(file_name),
          "request": {
            "contents": [
              {
                "role": "user",
                "parts": [{"text": body}],
              }
            ],
            "generation_config": {
              "responseModalities": ["TEXT", "IMAGE"],
              "imageConfig": {
                "aspectRatio": aspect_ratio,
                "imageSize": image_size,
              },
            },
          },
        }
        f.write(json.dumps(req, ensure_ascii=False) + "\n")
        request_count += 1

  return request_count, skipped_existing


def state_name(batch_job: Any) -> str:
  state = getattr(batch_job, "state", "")
  return getattr(state, "name", state) or ""


def get_attr(obj: Any, *names: str) -> Any:
  for name in names:
    if isinstance(obj, dict) and name in obj:
      return obj[name]
    if hasattr(obj, name):
      return getattr(obj, name)
  return None


def make_client(api_key: str | None) -> genai.Client:
  return genai.Client(api_key=api_key) if api_key else genai.Client()


def submit_batch(client: genai.Client, jsonl_path: Path, model: str, display_name: str) -> str:
  uploaded = client.files.upload(
    file=str(jsonl_path),
    config=types.UploadFileConfig(
      display_name=display_name,
      mime_type="jsonl",
    ),
  )
  print(f"[batch] uploaded request file: {uploaded.name}")

  job = client.batches.create(
    model=model,
    src=uploaded.name,
    config={"display_name": display_name},
  )
  print(f"[batch] created job: {job.name}")
  return job.name


def wait_for_batch(client: genai.Client, job_name: str, poll_seconds: int) -> Any:
  print(f"[batch] polling {job_name}")
  job = client.batches.get(name=job_name)
  while state_name(job) not in COMPLETED_STATES:
    print(f"[batch] state: {state_name(job)}")
    time.sleep(poll_seconds)
    job = client.batches.get(name=job_name)
  print(f"[batch] final state: {state_name(job)}")
  return job


def extract_image_bytes(parsed_response: dict[str, Any]) -> bytes | None:
  response = parsed_response.get("response") or parsed_response.get("inlineResponse")
  if not response:
    return None

  for cand in response.get("candidates", []):
    for part in cand.get("content", {}).get("parts", []):
      inline = part.get("inlineData") or part.get("inline_data")
      if inline and inline.get("data"):
        return base64.b64decode(inline["data"])
  return None


def download_results(client: genai.Client, job: Any, out_dir: Path, results_path: Path | None) -> tuple[int, int]:
  if state_name(job) != "JOB_STATE_SUCCEEDED":
    err = get_attr(job, "error")
    if err:
      print(f"[batch] error: {err}", file=sys.stderr)
    return (0, 0)

  dest = get_attr(job, "dest")
  result_file_name = get_attr(dest, "file_name", "fileName")
  if not result_file_name:
    raise RuntimeError("batch succeeded but did not include dest.file_name")

  print(f"[batch] downloading results: {result_file_name}")
  content_bytes = client.files.download(file=result_file_name)
  content = content_bytes.decode("utf-8")

  if results_path:
    results_path.write_text(content, encoding="utf-8")
    print(f"[batch] wrote raw results: {results_path}")

  saved = failed = 0
  for line in content.splitlines():
    if not line.strip():
      continue

    parsed = json.loads(line)
    key = parsed.get("key") or parsed.get("metadata", {}).get("key")
    if not key:
      failed += 1
      print(f"[fail] response missing key: {parsed.keys()}", file=sys.stderr)
      continue

    if parsed.get("error"):
      failed += 1
      print(f"[fail] {key}.png: {parsed['error']}", file=sys.stderr)
      continue

    data = extract_image_bytes(parsed)
    if not data:
      failed += 1
      print(f"[fail] {key}.png: no image in response", file=sys.stderr)
      continue

    path = out_dir / f"{key}.png"
    path.write_bytes(data)
    saved += 1
    print(f"  [ok]   {path.name} ({len(data) // 1024} KB)")

  return saved, failed


def resolve_species(args: argparse.Namespace) -> tuple[list[tuple[str, str]], int]:
  if args.labels:
    species, skipped = parse_species_list(args.labels.read_text().splitlines())
  elif args.stdin:
    species, skipped = parse_species_list(sys.stdin.read().splitlines())
  else:
    species, skipped = parse_species_list(args.species)

  if args.ebird_region:
    ek = args.ebird_key or os.environ.get("EBIRD_API_KEY", "")
    if not ek:
      raise RuntimeError("--ebird-region requires --ebird-key or EBIRD_API_KEY")
    print(f"[ebird] filtering {len(species)} species against {args.ebird_region}...")
    species = ebird_filter(species, args.ebird_region, ek)

  if args.limit:
    species = species[:args.limit]

  return species, skipped


def main() -> int:
  ap = argparse.ArgumentParser(
    description=__doc__,
    formatter_class=argparse.RawDescriptionHelpFormatter,
  )
  src = ap.add_mutually_exclusive_group(required=False)
  src.add_argument("--labels", type=Path, help="Path to labels.txt or any file of Sci|Com lines")
  src.add_argument("--species", action="append", default=[], help="Manual 'Sci|Com' (repeatable)")
  src.add_argument("--stdin", action="store_true", help="Read Sci|Com lines from stdin")

  ap.add_argument("--job", help="Existing Gemini batch job name to poll/download, e.g. batches/123")
  ap.add_argument("--submit-only", action="store_true", help="Create the batch job and exit without polling")
  ap.add_argument("--poll-seconds", type=int, default=60, help="Seconds between status polls")
  ap.add_argument("--model", default=MODEL, help=f"Gemini image model (default: {MODEL})")
  ap.add_argument("--image-size", default="512px", help="Output size for Gemini 3.1 Flash Image (default: 512px)")
  ap.add_argument("--aspect-ratio", default="1:1", help="Output aspect ratio (default: 1:1)")

  ap.add_argument("--ebird-region", help="eBird region code (e.g. US-CA, US-CA-085) to filter labels")
  ap.add_argument("--ebird-key", help="eBird API key (or EBIRD_API_KEY env)")
  ap.add_argument("--gemini-key", help="Gemini API key (or GEMINI_API_KEY env)")
  ap.add_argument(
    "--out",
    type=Path,
    default=Path(__file__).resolve().parents[1] / "assets" / "illustrations",
    help="Output directory (default: avian/assets/illustrations/)",
  )
  ap.add_argument(
    "--prompt",
    type=Path,
    default=Path(__file__).resolve().parent / "prompt.template.md",
    help="Prompt template path",
  )
  ap.add_argument(
    "--batch-jsonl",
    type=Path,
    default=Path("gemini-image-batch.jsonl"),
    help="Where to write the batch input JSONL",
  )
  ap.add_argument(
    "--results-jsonl",
    type=Path,
    default=Path("gemini-image-batch-results.jsonl"),
    help="Where to save raw batch output JSONL",
  )
  ap.add_argument("--poses", nargs="+", type=int, default=[1, 2], choices=list(POSES.keys()))
  ap.add_argument("--force", action="store_true", help="Re-render even if file exists")
  ap.add_argument("--limit", type=int, default=0, help="Cap species count for testing")
  args = ap.parse_args()

  gemini_key = args.gemini_key or os.environ.get("GEMINI_API_KEY", "")
  if not gemini_key:
    print("error: GEMINI_API_KEY required (--gemini-key or env)", file=sys.stderr)
    return 2

  client = make_client(gemini_key)
  args.out.mkdir(parents=True, exist_ok=True)

  if args.job:
    job = wait_for_batch(client, args.job, args.poll_seconds)
    saved, failed = download_results(client, job, args.out, args.results_jsonl)
    print(f"\nsaved {saved} · failed {failed}")
    return 0 if failed == 0 and state_name(job) == "JOB_STATE_SUCCEEDED" else 1

  if not (args.labels or args.stdin or args.species):
    print("error: one of --labels, --stdin, --species, or --job is required", file=sys.stderr)
    return 2

  try:
    species, skipped = resolve_species(args)
  except RuntimeError as e:
    print(f"error: {e}", file=sys.stderr)
    return 2

  if skipped:
    print(f"[parse] skipped {skipped} malformed line(s)", file=sys.stderr)
  if not species:
    print("error: no species resolved", file=sys.stderr)
    return 2

  prompt = load_prompt(args.prompt)
  request_count, skipped_existing = build_batch_jsonl(
    species=species,
    poses=args.poses,
    prompt=prompt,
    out_dir=args.out,
    jsonl_path=args.batch_jsonl,
    force=args.force,
    image_size=args.image_size,
    aspect_ratio=args.aspect_ratio,
  )

  print(f"[batch] wrote {request_count} request(s) to {args.batch_jsonl}")
  print(f"[batch] skipped existing: {skipped_existing}")
  if request_count == 0:
    print("nothing to generate")
    return 0

  display_name = f"avian-illustrations-{int(time.time())}"
  job_name = submit_batch(client, args.batch_jsonl, args.model, display_name)
  if args.submit_only:
    print(f"\nsubmitted {job_name}")
    print(f"resume with: python3 {Path(__file__).name} --job {job_name} --out {args.out}")
    return 0

  job = wait_for_batch(client, job_name, args.poll_seconds)
  saved, failed = download_results(client, job, args.out, args.results_jsonl)
  print(f"\nsaved {saved} · skipped {skipped_existing} · failed {failed}")
  return 0 if failed == 0 and state_name(job) == "JOB_STATE_SUCCEEDED" else 1


if __name__ == "__main__":
  sys.exit(main())

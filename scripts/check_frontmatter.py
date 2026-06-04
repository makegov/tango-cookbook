#!/usr/bin/env python3
"""Validate frontmatter in every notebook under notebooks/.

Fails if any notebook is missing required fields. Warns (does not fail) on
unknown tags so contributors can typo-check vs. extend the taxonomy.

Convention: every notebook's first markdown cell contains a ```yaml code fence
with `title`, `description`, `tags`, `endpoints`. See notebooks/README.md.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
NOTEBOOKS = ROOT / "notebooks"

REQUIRED_FIELDS = {"title", "description", "tags", "endpoints"}

# Keep in sync with notebooks/README.md "Tag taxonomy".
KNOWN_TAGS = {
    # domains
    "budget", "contracts", "idvs", "otas", "opportunities", "notices",
    "grants", "entities", "forecasts", "protests", "recipients", "webhooks",
    # techniques
    "shape", "pagination", "filtering", "joining", "async",
}

FENCE_RE = re.compile(r"```yaml\s*\n(.*?)\n```", re.DOTALL)
IN_CI = bool(os.environ.get("GITHUB_ACTIONS"))


def extract_frontmatter(nb_path: Path) -> dict | None:
    nb = json.loads(nb_path.read_text())
    for cell in nb.get("cells", []):
        if cell.get("cell_type") != "markdown":
            continue
        source = "".join(cell.get("source", []))
        m = FENCE_RE.search(source)
        if not m:
            return None
        return yaml.safe_load(m.group(1))
    return None


def validate(fm: dict | None) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if fm is None:
        return (["missing YAML frontmatter in first markdown cell"], [])
    if not isinstance(fm, dict):
        return (["frontmatter is not a YAML mapping"], [])

    missing = sorted(REQUIRED_FIELDS - fm.keys())
    if missing:
        errors.append(f"missing required field(s): {missing}")

    for field in ("title", "description"):
        val = fm.get(field)
        if val is not None and not (isinstance(val, str) and val.strip()):
            errors.append(f"`{field}` must be a non-empty string")

    for field in ("tags", "endpoints"):
        val = fm.get(field)
        ok = isinstance(val, list) and val and all(isinstance(v, str) for v in val)
        if val is not None and not ok:
            errors.append(f"`{field}` must be a non-empty list of strings")

    for tag in fm.get("tags") or []:
        if isinstance(tag, str) and tag not in KNOWN_TAGS:
            warnings.append(
                f"unknown tag {tag!r} — fix the typo or add it to "
                "scripts/check_frontmatter.py and notebooks/README.md"
            )

    return errors, warnings


def report(rel: Path, errors: list[str], warnings: list[str]) -> None:
    for w in warnings:
        print(f"WARN  {rel}: {w}")
        if IN_CI:
            print(f"::warning file={rel}::{w}")
    for e in errors:
        print(f"FAIL  {rel}: {e}")
        if IN_CI:
            print(f"::error file={rel}::{e}")
    if not errors and not warnings:
        print(f"ok    {rel}")


def main() -> int:
    notebooks = sorted(NOTEBOOKS.glob("*.ipynb"))
    if not notebooks:
        print("No notebooks to check.")
        return 0

    failed = False
    for nb in notebooks:
        errors, warnings = validate(extract_frontmatter(nb))
        report(nb.relative_to(ROOT), errors, warnings)
        if errors:
            failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

"""
Incumbent-on-post — evals for the deterministic scorer.

The opportunities-agent README says the interesting work is upstream: tool design,
prompt, evals. This is the evals half for *this* recipe. It doesn't grade the LLM
(that's non-deterministic and paid). It grades the part you actually want pinned —
the scorer — on invariants that should hold no matter how the underlying data drifts.

These are structural, not "vendor X is the incumbent" (that rots as data changes):
  - ranked output is sorted by score, descending
  - every candidate is backed by at least one evidence id (no evidence-free guesses)
  - an office/NAICS with no expiring work returns [] — the "new work" answer
  - scores are finite and non-negative

Seed this set, then add a case every time the scorer surprises you. That's how you
find out whether the ranking is good enough before you wire it to a push notification.

Run:
    just incumbent-evals
Requires TANGO_API_KEY (live API; no LLM key needed).
"""

from __future__ import annotations

import os
import sys
from datetime import date

from tango import TangoClient

from scorer import rank_incumbents

# (label, office_code, naics, psc, notice_date, expectation)
#   expectation: "candidates" -> expect a ranked non-empty list
#                "new_work"   -> expect [] (no predecessor in this office/category/window)
CASES = [
    ("VA NCO 5, court reporting", "36C250", "561492", None, date(2026, 6, 18), "candidates"),
    ("VA NCO 5, IT services (broad)", "36C250", "541512", None, date(2026, 6, 18), "candidates"),
    # Valid office, but a recompete window a decade out — nothing expires there, so the
    # scorer should return []. This exercises the "no predecessor" path without relying
    # on an invalid agency code (the API rejects those loudly, which is correct).
    ("VA NCO 5, far-future window", "36C250", "561492", None, date(2035, 1, 1), "new_work"),
]


def check(label: str, cands: list, expectation: str) -> list[str]:
    failures: list[str] = []

    # Invariant 1: sorted by score, descending.
    scores = [c.score for c in cands]
    if scores != sorted(scores, reverse=True):
        failures.append(f"not sorted descending: {scores}")

    # Invariant 2: every candidate is backed by evidence.
    for c in cands:
        if not c.evidence:
            failures.append(f"candidate {c.vendor_name!r} has no evidence")

    # Invariant 3: scores finite and non-negative.
    for c in cands:
        if not (c.score >= 0):
            failures.append(f"candidate {c.vendor_name!r} has bad score {c.score}")

    # Invariant 4: the expectation about presence/absence.
    if expectation == "candidates" and not cands:
        failures.append("expected candidates, got none")
    if expectation == "new_work" and cands:
        failures.append(f"expected new_work (empty), got {len(cands)} candidate(s)")

    return failures


def main() -> int:
    if not os.environ.get("TANGO_API_KEY"):
        sys.exit("missing TANGO_API_KEY — see .env.example")

    tango = TangoClient()
    total_failures = 0

    for label, office, naics, psc, notice_date, expectation in CASES:
        cands = rank_incumbents(tango, office_code=office, naics=naics, psc=psc, notice_date=notice_date)
        failures = check(label, cands, expectation)
        if failures:
            total_failures += len(failures)
            print(f"✗ {label}")
            for f in failures:
                print(f"    - {f}")
        else:
            top = cands[0].vendor_name if cands else "(none — new work)"
            print(f"✓ {label}  →  {len(cands)} candidate(s), top: {top}")

    print()
    if total_failures:
        print(f"{total_failures} invariant failure(s)")
        return 1
    print("all invariants hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

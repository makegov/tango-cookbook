"""
Incumbent-on-post — the deterministic scorer.

The agent in brief.py gives you a *plausible* incumbent. This module gives you a
*reproducible* one. It does the one thing you don't want an LLM improvising on a
webhook-triggered pipeline: ranking candidate prior awards by the recompete signal.

It pivots on the contracting office (not the solicitation number — see brief.py for
why) and bounds the search to a recompete window server-side using the SDK's
`expiring_gte/lte` and `last_date_to_order_gte/lte` filters. The ranking is a plain
scored function: window membership, dollar magnitude, and how often a vendor recurs
in the expiring set. No model, no network non-determinism beyond the API itself —
so you can put it under evals.py and notice when it regresses.

Intended use: run this first. If it returns confident candidates, you may not need
the LLM at all. If it comes back thin or empty, that's the signal to fall through to
the agent's scope-match judgment — or to report "likely new work."
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from tango import TangoClient

# How far on either side of the notice an expiring award still counts as "the
# recompete." Recompetes slip; a year of slack each way is generous but honest.
RECOMPETE_WINDOW_MONTHS = 12


@dataclass
class Candidate:
    vendor_name: str
    uei: str | None
    prior_award_value: Decimal | None
    recompete_date: date | None
    evidence: list[str] = field(default_factory=list)  # PIIDs / IDV keys
    award_count: int = 0  # how many expiring awards this vendor holds in-window
    score: float = 0.0


def recompete_window(notice_date: date, months: int = RECOMPETE_WINDOW_MONTHS) -> tuple[date, date]:
    """The band around the notice in which an expiring award reads as the predecessor."""
    span = timedelta(days=30 * months)
    return notice_date - span, notice_date + span


def _f(row: Any, name: str, default: Any = None) -> Any:
    """Read a field whether the SDK handed back a dict or a model object."""
    if isinstance(row, dict):
        return row.get(name, default)
    return getattr(row, name, default)


def _recipient_name(row: Any) -> str:
    rec = _f(row, "recipient")
    if rec is None:
        return _f(row, "recipient_name", "(unknown)") or "(unknown)"
    return _f(rec, "display_name", None) or _f(rec, "name", None) or str(rec)


def fetch_candidates(
    tango: TangoClient,
    *,
    office_code: str,
    naics: str | None,
    psc: str | None,
    notice_date: date,
    limit: int = 50,
) -> list[Any]:
    """Pull contracts AND IDVs from the office whose clock runs out inside the window.

    `awarding_agency` here is the office code resolved from the notice — pass the most
    specific org you have, not the parent department. Coarse office in, noise out.
    """
    lo, hi = recompete_window(notice_date)
    rows: list[Any] = []

    contract_filters: dict[str, Any] = {
        "awarding_agency": office_code,
        "expiring_gte": lo.isoformat(),
        "expiring_lte": hi.isoformat(),
        "limit": limit,
    }
    if naics:
        contract_filters["naics_code"] = naics
    if psc:
        contract_filters["psc_code"] = psc
    rows.extend(tango.list_contracts(**contract_filters).results)

    # IDVs are where task-order recompetes actually live; same window, IDV-native filters.
    idv_filters: dict[str, Any] = {
        "awarding_agency": office_code,
        "last_date_to_order_gte": lo.isoformat(),
        "last_date_to_order_lte": hi.isoformat(),
        "limit": limit,
    }
    if naics:
        idv_filters["naics"] = naics
    if psc:
        idv_filters["psc"] = psc
    rows.extend(tango.list_idvs(**idv_filters).results)
    return rows


def score(rows: list[Any], notice_date: date, *, top_n: int = 3) -> list[Candidate]:
    """Rank vendors in the expiring set. Aggregates by vendor so a prime holding three
    expiring task orders outranks a one-off — that recurrence IS the incumbency signal.

    Score blends three normalized parts:
      - proximity: how close the expiry is to the notice (the recompete clock)
      - magnitude: dollar size, log-damped so a single mega-award doesn't dominate
      - recurrence: how many expiring awards the vendor holds in-window
    """
    if not rows:
        return []

    by_vendor: dict[str, Candidate] = {}
    max_value = max((float(_f(r, "total_contract_value") or 0) for r in rows), default=0.0) or 1.0
    span_days = float(timedelta(days=30 * RECOMPETE_WINDOW_MONTHS).days) or 1.0

    for r in rows:
        name = _recipient_name(r)
        rec = _f(r, "recipient")
        uei = _f(rec, "uei", None) if rec is not None else _f(r, "recipient_uei", None)
        value = _f(r, "total_contract_value")
        piid = _f(r, "piid") or _f(r, "key") or "(no id)"
        expiry = _f(r, "pop_end_date") or _f(r, "last_date_to_order") or _f(r, "expiring")
        expiry_date = expiry if isinstance(expiry, date) else None

        cand = by_vendor.get(name)
        if cand is None:
            cand = Candidate(vendor_name=name, uei=uei, prior_award_value=None, recompete_date=None)
            by_vendor[name] = cand
        cand.award_count += 1
        cand.evidence.append(str(piid))
        if value is not None:
            cand.prior_award_value = (cand.prior_award_value or Decimal(0)) + Decimal(str(value))
        # Keep the expiry closest to the notice as the headline recompete date.
        if expiry_date and (cand.recompete_date is None or abs((expiry_date - notice_date).days) < abs((cand.recompete_date - notice_date).days)):
            cand.recompete_date = expiry_date

    from math import log1p

    for cand in by_vendor.values():
        proximity = 0.0
        if cand.recompete_date is not None:
            proximity = max(0.0, 1.0 - abs((cand.recompete_date - notice_date).days) / span_days)
        magnitude = float(cand.prior_award_value or 0) / max_value
        recurrence = log1p(cand.award_count)
        cand.score = round(0.5 * proximity + 0.3 * magnitude + 0.2 * recurrence, 4)

    return sorted(by_vendor.values(), key=lambda c: c.score, reverse=True)[:top_n]


def rank_incumbents(
    tango: TangoClient,
    *,
    office_code: str,
    naics: str | None,
    psc: str | None,
    notice_date: date,
    top_n: int = 3,
) -> list[Candidate]:
    """One call: fetch the expiring set for the office and rank it. Empty list is a
    real answer — it means 'no clear predecessor in this office/category/window'."""
    rows = fetch_candidates(tango, office_code=office_code, naics=naics, psc=psc, notice_date=notice_date)
    return score(rows, notice_date, top_n=top_n)

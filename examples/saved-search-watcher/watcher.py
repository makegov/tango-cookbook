"""
A YAML-driven saved-search watcher for the Tango API.

Loads a list of named search profiles from a YAML file, runs each against the
Tango SDK, diffs results against a small JSON state file on disk, and emits
new matches to a sink (stdout or Slack incoming-webhook).

Idempotent: re-running yields nothing unless results changed. Pair with cron,
launchd, systemd timers, or a GitHub Action to make it recurring — the script
itself stays single-shot.

Run:
    just watch                              # uses profiles.yaml, state.json beside it
    just watch --profiles my-profiles.yaml
    just watch --seed                       # record current results as "seen" without alerting
    just watch --dry-run                    # diff + log stats but don't call any sinks

Or directly:
    uv run python examples/saved-search-watcher/watcher.py [flags]

Requires TANGO_API_KEY in the environment. SLACK_WEBHOOK_URL is only needed
when a profile sets `sink: slack`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

import yaml
from tango import TangoClient

HERE = Path(__file__).parent
STATE_VERSION = 1
SEEN_CAP = 5000  # per-profile cap on remembered IDs, to keep state bounded


# --- Endpoint dispatch ---------------------------------------------------------
# Each entry maps a profile's `endpoint:` to the SDK method we call. Keeping
# this small and explicit makes it obvious what the watcher does and doesn't
# support — and equally obvious how to add another endpoint.

def _endpoints(tango: TangoClient) -> dict[str, Callable[..., Any]]:
    return {
        "opportunities": tango.list_opportunities,
        "contracts": tango.list_contracts,
        "notices": tango.list_notices,
        "forecasts": tango.list_forecasts,
        "protests": tango.list_protests,
    }


# --- State ---------------------------------------------------------------------

def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": STATE_VERSION, "profiles": {}}
    state = json.loads(path.read_text())
    state.setdefault("profiles", {})
    return state


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.write_text(json.dumps(state, indent=2, sort_keys=True))


# --- Sinks ---------------------------------------------------------------------

def _fmt(v: Any) -> str:
    """Render a single value for an alert line. Keeps dates/datetimes readable."""
    if hasattr(v, "isoformat"):  # date or datetime
        return v.isoformat()
    return str(v)


def emit_stdout(profile: str, matches: list[dict[str, Any]], fields: list[str]) -> None:
    print(f"\n[{profile}] {len(matches)} new")
    for m in matches:
        bits = [f"{k}={_fmt(m.get(k))}" for k in fields if m.get(k) is not None]
        print("  - " + " | ".join(bits) if bits else "  - " + json.dumps(m, default=str))


def emit_slack(profile: str, matches: list[dict[str, Any]], fields: list[str]) -> None:
    url = os.environ.get("SLACK_WEBHOOK_URL")
    if not url:
        print(f"[{profile}] SLACK_WEBHOOK_URL not set — skipping slack sink", file=sys.stderr)
        return

    lines = [f"*{profile}* — {len(matches)} new"]
    for m in matches:
        bits = [f"*{k}:* {_fmt(m.get(k))}" for k in fields if m.get(k) is not None]
        lines.append("• " + " — ".join(bits) if bits else "• " + json.dumps(m, default=str))
    payload = json.dumps({"text": "\n".join(lines)}).encode()

    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status >= 300:
            print(f"[{profile}] slack POST got {resp.status}", file=sys.stderr)


SINKS = {"stdout": emit_stdout, "slack": emit_slack}


# --- Profile runner ------------------------------------------------------------

def _render_filters(filters: dict[str, Any]) -> dict[str, Any]:
    """Expand {today} -> ISO date. Add more placeholders here if you need them."""
    today = date.today().isoformat()
    return {
        k: v.replace("{today}", today) if isinstance(v, str) else v
        for k, v in filters.items()
    }


def run_profile(
    tango: TangoClient,
    profile: dict[str, Any],
    state: dict[str, Any],
    *,
    seed: bool,
    dry_run: bool,
) -> int:
    name = profile["name"]
    endpoint = profile["endpoint"]
    key = profile["key"]
    fields = profile.get("fields", [key])
    sink_name = profile.get("sink", "stdout")
    limit = int(profile.get("limit", 25))
    filters = _render_filters(profile.get("filters", {}))

    fn = _endpoints(tango).get(endpoint)
    if fn is None:
        print(f"[{name}] unknown endpoint {endpoint!r}", file=sys.stderr)
        return 0

    # Derive a `shape=` so the alert fields actually come back. Many Tango
    # endpoints omit non-default fields unless you ask. Users can override by
    # setting `shape:` explicitly in the profile (e.g. for nested shapes like
    # `recipient(*)`).
    shape = profile.get("shape") or ",".join(dict.fromkeys([key, *fields]))
    page = fn(limit=limit, shape=shape, **filters)
    results = list(page.results)
    ids_now = [r.get(key) for r in results if r.get(key) is not None]

    if results and not ids_now:
        # Loud fail: every result is missing the key. Almost always a typo in
        # the profile — e.g. `forecast_id` when the SDK actually returns `id`.
        # Without this guard, the watcher would happily report "no new matches"
        # while silently swallowing every record.
        sample = list(results[0].keys())[:8]
        print(
            f"[{name}] {len(results)} results but key {key!r} matched none. "
            f"Sample fields on first result: {sample}",
            file=sys.stderr,
        )
        return 0

    prior = state["profiles"].setdefault(name, {"seen": []})
    seen_set = set(prior.get("seen", []))

    new_results = [r for r in results if r.get(key) is not None and r.get(key) not in seen_set]

    if seed:
        # First-run mode: record everything as seen, alert on nothing.
        prior["seen"] = ids_now[:SEEN_CAP]
        prior["last_run"] = datetime.now(timezone.utc).isoformat()
        print(f"[{name}] seeded with {len(ids_now)} ids — no alerts emitted")
        return 0

    if new_results and not dry_run:
        sink = SINKS.get(sink_name, emit_stdout)
        sink(name, new_results, fields)
    elif new_results:
        print(f"[{name}] {len(new_results)} new (dry-run — sink skipped)")
    else:
        print(f"[{name}] no new matches ({len(results)} total)")

    # Remember the union, capped. We keep the most recent IDs so the watcher
    # forgets very old results if you ever loosen the filters and the set
    # grows — that's a feature, not a bug.
    merged = (ids_now + list(seen_set))[:SEEN_CAP]
    # de-dupe while preserving order
    prior["seen"] = list(dict.fromkeys(merged))
    prior["last_run"] = datetime.now(timezone.utc).isoformat()

    return len(new_results)


# --- Main ----------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--profiles", default=str(HERE / "profiles.yaml"))
    parser.add_argument("--state", default=str(HERE / "state.json"))
    parser.add_argument("--seed", action="store_true",
                        help="Record current matches as 'seen' without alerting. Use on first run.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Diff and log, but don't call sinks. State is still updated.")
    args = parser.parse_args()

    if not os.environ.get("TANGO_API_KEY"):
        sys.exit("missing TANGO_API_KEY — see .env.example")

    profiles_path = Path(args.profiles)
    if not profiles_path.exists():
        sys.exit(
            f"profiles file not found: {profiles_path}\n"
            f"Hint: copy profiles.example.yaml to profiles.yaml and edit."
        )
    profiles: list[dict[str, Any]] = yaml.safe_load(profiles_path.read_text()) or []

    state_path = Path(args.state)
    state = load_state(state_path)
    tango = TangoClient()

    total_new = 0
    for profile in profiles:
        try:
            total_new += run_profile(tango, profile, state, seed=args.seed, dry_run=args.dry_run)
        except Exception as e:
            print(f"[{profile.get('name', '?')}] error: {type(e).__name__}: {e}", file=sys.stderr)

    save_state(state_path, state)

    if args.seed:
        print(f"\nseeded {len(profiles)} profile(s) into {state_path}")
    else:
        print(f"\n{total_new} new across {len(profiles)} profile(s) — state: {state_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

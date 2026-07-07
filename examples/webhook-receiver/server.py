"""
A minimal FastAPI receiver for Tango webhooks.

Verifies the HMAC signature using the official tango-python helper, dedupes
recently-seen event ids, and routes each delivery to a sink (stdout or Slack).

Run (from the repo root):
    just webhook-serve                          # binds 0.0.0.0:8000

Or directly:
    uv run uvicorn examples.webhook-receiver.server:app --reload --port 8000

Then point a Tango webhook endpoint at http://<host>:8000/webhooks/tango.
Use examples/webhook-receiver/register.py to register one in two lines.

Environment:
    TANGO_WEBHOOK_SECRET   shared secret printed when you create the endpoint.
                           Required. The verifier rejects anything else.
    SLACK_WEBHOOK_URL      optional; enables the slack sink.
    WEBHOOK_SINK           "stdout" (default) or "slack".
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from collections import OrderedDict
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from tango.webhooks import SIGNATURE_HEADER, verify_signature

SECRET = os.environ.get("TANGO_WEBHOOK_SECRET")
SINK = os.environ.get("WEBHOOK_SINK", "stdout")
SEEN_CAP = 10_000  # how many recent delivery ids to remember for idempotency

app = FastAPI(title="Tango webhook receiver")
_seen: "OrderedDict[str, None]" = OrderedDict()


# --- Sinks ---------------------------------------------------------------------
# A delivery is a batch envelope: a top-level `delivery_id` plus an `events[]`
# array. Each sink takes one event dict — the handler loops the batch and calls
# the sink per event. This is the only place you should have to touch to route
# events. See the Webhooks payload format §6 for the full shape.

def _match_counts(event: dict[str, Any]) -> tuple[int, int]:
    m = event.get("matches") or {}
    new = m.get("new_count", len(m.get("new", [])))
    modified = m.get("modified_count", len(m.get("modified", [])))
    return new, modified


def emit_stdout(event: dict[str, Any]) -> None:
    new, modified = _match_counts(event)
    summary = {
        "event_type": event.get("event_type"),
        "alert_id": event.get("alert_id"),
        "new": new,
        "modified": modified,
    }
    print(json.dumps(summary, default=str))


def emit_slack(event: dict[str, Any]) -> None:
    url = os.environ.get("SLACK_WEBHOOK_URL")
    if not url:
        print("SLACK_WEBHOOK_URL not set — falling back to stdout", file=sys.stderr)
        emit_stdout(event)
        return
    new, modified = _match_counts(event)
    alert = (event.get("alert_id") or "?")[:8]
    text = f"*{event.get('event_type') or 'match'}* — {new} new, {modified} modified (alert `{alert}`)"
    payload = json.dumps({"text": text}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status >= 300:
            print(f"slack POST got {resp.status}", file=sys.stderr)


SINKS = {"stdout": emit_stdout, "slack": emit_slack}


# --- Idempotency ---------------------------------------------------------------
# Tango retries on non-2xx, and a retried dispatch reuses its `delivery_id`, so
# we dedupe by delivery_id and a redelivery becomes a no-op. Replace this
# in-memory LRU with Redis / a DB when you run >1 process.

def _already_seen(delivery_id: str | None) -> bool:
    if not delivery_id:
        return False
    if delivery_id in _seen:
        return True
    _seen[delivery_id] = None
    if len(_seen) > SEEN_CAP:
        _seen.popitem(last=False)
    return False


# --- The endpoint --------------------------------------------------------------

@app.post("/webhooks/tango")
async def receive(request: Request) -> dict[str, str]:
    if not SECRET:
        raise HTTPException(500, "TANGO_WEBHOOK_SECRET not set")

    body = await request.body()
    sig = request.headers.get(SIGNATURE_HEADER)
    if not verify_signature(body, SECRET, sig):
        # Constant-time check inside the helper. 401 is the conventional response.
        raise HTTPException(401, "bad signature")

    try:
        delivery = json.loads(body)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"invalid JSON: {e}")

    delivery_id = delivery.get("delivery_id")
    if _already_seen(delivery_id):
        # Idempotent. Return 200 so Tango stops retrying.
        return {"status": "duplicate", "delivery_id": delivery_id or ""}

    # A delivery batches one or more events; route each through the sink.
    sink = SINKS.get(SINK, emit_stdout)
    try:
        for event in delivery.get("events", []):
            sink(event)
    except Exception as e:
        # Returning a 5xx makes Tango retry — usually what you want for sink errors.
        raise HTTPException(500, f"sink failed: {type(e).__name__}: {e}")

    return {"status": "ok", "delivery_id": delivery_id or ""}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "secret_loaded": "yes" if SECRET else "no"}

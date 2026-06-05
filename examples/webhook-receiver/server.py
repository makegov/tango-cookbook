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
SEEN_CAP = 10_000  # how many recent event ids to remember for idempotency

app = FastAPI(title="Tango webhook receiver")
_seen: "OrderedDict[str, None]" = OrderedDict()


# --- Sinks ---------------------------------------------------------------------
# Each takes the parsed event dict and emits it somewhere. Replace or add as
# needed; this is the only file you should have to touch to route events.

def emit_stdout(event_type: str, event: dict[str, Any]) -> None:
    summary = {k: event.get(k) for k in ("event_id", "id", "occurred_at", "alert_id") if event.get(k)}
    print(f"[{event_type}] {json.dumps(summary, default=str)}")


def emit_slack(event_type: str, event: dict[str, Any]) -> None:
    url = os.environ.get("SLACK_WEBHOOK_URL")
    if not url:
        print("SLACK_WEBHOOK_URL not set — falling back to stdout", file=sys.stderr)
        emit_stdout(event_type, event)
        return
    text = f"*{event_type}* — `{event.get('event_id') or event.get('id') or '?'}`"
    payload = json.dumps({"text": text}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status >= 300:
            print(f"slack POST got {resp.status}", file=sys.stderr)


SINKS = {"stdout": emit_stdout, "slack": emit_slack}


# --- Idempotency ---------------------------------------------------------------
# Tango will retry on non-2xx. We dedupe by event_id so a redelivery is a no-op.
# Replace this in-memory LRU with Redis / a DB when you run >1 process.

def _already_seen(event_id: str | None) -> bool:
    if not event_id:
        return False
    if event_id in _seen:
        return True
    _seen[event_id] = None
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
        event = json.loads(body)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"invalid JSON: {e}")

    event_id = event.get("event_id") or event.get("id")
    if _already_seen(event_id):
        # Idempotent. Return 200 so Tango stops retrying.
        return {"status": "duplicate", "event_id": event_id}

    event_type = event.get("event_type") or event.get("type") or "unknown"
    sink = SINKS.get(SINK, emit_stdout)
    try:
        sink(event_type, event)
    except Exception as e:
        # Returning a 5xx makes Tango retry — usually what you want for sink errors.
        raise HTTPException(500, f"sink failed: {type(e).__name__}: {e}")

    return {"status": "ok", "event_id": event_id or ""}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "secret_loaded": "yes" if SECRET else "no"}

"""
Register a Tango webhook endpoint + alert and fire a test delivery.

Run (from the repo root):
    just webhook-register https://your-public-url.example.com/webhooks/tango

Or directly:
    uv run python examples/webhook-receiver/register.py <callback-url>

The script prints the endpoint id and the shared secret. Put the secret in your
environment as TANGO_WEBHOOK_SECRET before starting the server — that's what
the receiver uses to verify each delivery's signature.

For local development, expose port 8000 with a tunnel (ngrok, cloudflared,
tailscale funnel, etc.) and pass the public URL as the callback. Tango will
not deliver to localhost.
"""

from __future__ import annotations

import os
import sys
from tango import TangoClient


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit("usage: register.py <callback-url>")
    callback_url = sys.argv[1]

    if not os.environ.get("TANGO_API_KEY"):
        sys.exit("missing TANGO_API_KEY — see .env.example")

    tango = TangoClient()

    endpoint = tango.create_webhook_endpoint(
        callback_url=callback_url,
        name="cookbook webhook-receiver example",
        is_active=True,
    )

    print(f"endpoint_id: {endpoint.id}")
    print(f"callback_url: {endpoint.callback_url}")
    print()
    print("SECRET (copy this into your environment, only shown once):")
    print(f"  export TANGO_WEBHOOK_SECRET={endpoint.secret}")
    print()

    # Wire one example alert so the endpoint actually receives something.
    # Customize `filters` to whatever you care about; this mirrors the
    # saved-search-watcher's "small IT recompetes" profile.
    alert = tango.create_webhook_alert(
        name="cookbook example — small IT recompetes",
        query_type="opportunities",
        filters={
            "naics": "541512",
            "set_aside": "SBA",
            "notice_type": "o",
            "active": True,
        },
        frequency="realtime",
        endpoint=endpoint.id,
    )
    print(f"alert_id: {alert.alert_id}")
    print(f"status: {alert.status}")
    print()

    # Fire a synthetic delivery so you can confirm the receiver is up.
    test = tango.test_webhook_delivery(endpoint_id=endpoint.id)
    print(f"test delivery: {test}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

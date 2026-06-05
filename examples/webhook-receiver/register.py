"""
Register a Tango webhook endpoint + alert and fire a test delivery.

Run (from the repo root):
    just webhook-register https://your-public-url.example.com/webhooks/tango

Or directly:
    uv run python examples/webhook-receiver/register.py <callback-url>

The script creates the endpoint, writes the shared secret to a 0600 file
beside this script (default: ./webhook.secret), and tells you how to load it
into the receiver's environment. The secret is *not* printed to stdout —
print would land it in shell history, terminal recordings, and CI logs.

For local development, expose port 8000 with a tunnel (ngrok, cloudflared,
tailscale funnel, etc.) and pass the public URL as the callback. Tango will
not deliver to localhost.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from tango import TangoClient

SECRET_FILE = Path(__file__).parent / "webhook.secret"


def write_secret(secret: str) -> None:
    """Write the secret to a 0600 file, atomically, without ever printing it.

    Deliberately returns None so the caller can't accidentally pipe the path
    (or anything derived from a secret-handling function) into a log line and
    trip taint-propagation rules. Reference the module-level SECRET_FILE
    constant in user-facing output instead.
    """
    # os.open with O_CREAT|O_WRONLY|O_TRUNC + mode 0o600 creates the file with
    # the right permissions in one syscall. Avoids the open-then-chmod race
    # where the file briefly exists world-readable.
    fd = os.open(SECRET_FILE, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(f"TANGO_WEBHOOK_SECRET={secret}\n")


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

    print(f"endpoint_id:  {endpoint.id}")
    print(f"callback_url: {endpoint.callback_url}")

    write_secret(endpoint.secret)
    print(f"secret:       wrote to {SECRET_FILE} (mode 0600)")
    print()
    print("Load it before starting the receiver:")
    print(f"  set -a && source {SECRET_FILE} && set +a && just webhook-serve")
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
    print(f"status:   {alert.status}")
    print()

    # Fire a synthetic delivery so you can confirm the receiver is up.
    test = tango.test_webhook_delivery(endpoint_id=endpoint.id)
    print(f"test delivery: {test}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

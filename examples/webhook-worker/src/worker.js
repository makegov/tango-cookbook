/**
 * Tango webhooks → Slack, as a single Cloudflare Worker.
 *
 * This is the "easy button" version of examples/webhook-receiver: no server to
 * host, no tunnel, no SDK. Deploy it with the button in the README and you have
 * a public HTTPS endpoint that verifies Tango's signature, dedupes retries, and
 * posts each match to a Slack channel.
 *
 * The handler and the pure helpers below are exported separately so smoke.mjs
 * can exercise the parsing/signing/formatting logic with no network and no
 * Workers runtime. Only `default.fetch` touches the platform (KV, fetch).
 *
 * Bindings (set after deploy — see README):
 *   TANGO_WEBHOOK_SECRET  secret. Shared HMAC secret from create_webhook_endpoint.
 *   SLACK_WEBHOOK_URL     secret. Slack Incoming Webhook URL. Omit to log instead.
 *   SEEN_DELIVERIES       KV namespace. Idempotency store, keyed by delivery_id.
 *                         Provisioned automatically by the Deploy button.
 */

const RECEIVE_PATH = "/webhooks/tango";
const DEDUPE_TTL_SECONDS = 604800; // 7 days — comfortably longer than Tango's retry window.

// --- Signature verification --------------------------------------------------
// Tango signs the raw request body with HMAC-SHA256 and sends it as
// `X-Tango-Signature: sha256=<hex>`. We recompute and compare in constant time.

function toHex(buffer) {
  let out = "";
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time compare of two equal-length hex strings. */
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 of `bodyBytes` under `secret`, as a lowercase hex string. */
export async function hmacHex(secret, bodyBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, bodyBytes);
  return toHex(mac);
}

/**
 * Verify the `X-Tango-Signature` header against the raw body.
 * `bodyBytes` must be the exact bytes received (a Uint8Array/ArrayBuffer).
 */
export async function verifySignature(bodyBytes, secret, header) {
  if (!secret || !header) return false;
  const provided = (header.startsWith("sha256=") ? header.slice(7) : header).toLowerCase();
  return timingSafeEqualHex(await hmacHex(secret, bodyBytes), provided);
}

// --- Formatting --------------------------------------------------------------
// The canonical payload is a batch envelope: a top-level `delivery_id` plus an
// `events[]` array, each event carrying `matches.new[]` summary objects. See
// the Webhooks payload format §6 in the makegov docs. We turn each new match
// into one Slack message.

/** Rich Slack blocks for an opportunity match — the summary object has all we need. */
export function opportunityToBlocks(match, alertId) {
  const title = (match.title || "(untitled opportunity)").slice(0, 140);
  const sol = match.solicitation_number || "—";
  const deadline = match.response_deadline || "—";
  const naics = match.naics_code || "—";
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `New: ${title}` } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Solicitation*\n${sol}` },
        { type: "mrkdwn", text: `*Response by*\n${deadline}` },
        { type: "mrkdwn", text: `*NAICS*\n${naics}` },
        { type: "mrkdwn", text: `*Alert*\n${(alertId || "").slice(0, 8)}…` },
      ],
    },
  ];
  if (match.opportunity_id) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View on SAM.gov" },
          url: `https://sam.gov/opp/${match.opportunity_id}/view`,
        },
      ],
    });
  }
  return blocks;
}

/** Compact summary blocks for a non-opportunity event (contract/entity/grant/forecast). */
export function eventSummaryBlocks(event) {
  const m = event.matches || {};
  const newCount = m.new_count ?? (m.new || []).length;
  const modCount = m.modified_count ?? (m.modified || []).length;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${event.event_type || "match"}* — ${newCount} new, ${modCount} modified ` +
          `(alert \`${(event.alert_id || "?").slice(0, 8)}\`)`,
      },
    },
  ];
}

/** Turn one delivery into a list of Slack message bodies, one per match/event. */
export function buildMessages(payload) {
  const messages = [];
  for (const event of payload.events || []) {
    if (event.event_type === "alerts.opportunity.match") {
      for (const match of (event.matches && event.matches.new) || []) {
        messages.push({ blocks: opportunityToBlocks(match, event.alert_id) });
      }
    } else {
      messages.push({ blocks: eventSummaryBlocks(event) });
    }
  }
  return messages;
}

// --- The Worker --------------------------------------------------------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return json({ status: "ok", secret_loaded: Boolean(env.TANGO_WEBHOOK_SECRET) });
    }
    if (url.pathname !== RECEIVE_PATH) return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const secret = env.TANGO_WEBHOOK_SECRET;
    if (!secret) return new Response("TANGO_WEBHOOK_SECRET not set", { status: 500 });

    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    if (!(await verifySignature(bodyBytes, secret, request.headers.get("x-tango-signature")))) {
      return new Response("bad signature", { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch (e) {
      return new Response(`invalid JSON: ${e}`, { status: 400 });
    }

    // Idempotency: Tango retries on non-2xx, so a redelivery of the same dispatch
    // carries the same top-level delivery_id. Skip it if we've already handled it.
    // Without a KV binding we can't dedupe across invocations — a duplicate Slack
    // message is the worst case, so we degrade gracefully instead of failing.
    const deliveryId = payload.delivery_id;
    if (deliveryId && env.SEEN_DELIVERIES && (await env.SEEN_DELIVERIES.get(deliveryId))) {
      return json({ status: "duplicate", delivery_id: deliveryId });
    }

    const messages = buildMessages(payload);
    try {
      const slackUrl = env.SLACK_WEBHOOK_URL;
      if (slackUrl) {
        for (const message of messages) {
          const resp = await fetch(slackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
          });
          if (resp.status >= 300) throw new Error(`slack POST returned ${resp.status}`);
        }
      } else {
        console.log(`[tango] ${messages.length} message(s); SLACK_WEBHOOK_URL not set`);
      }
    } catch (e) {
      // A 5xx makes Tango retry the whole delivery (up to 5 attempts for 5xx),
      // so a transient Slack hiccup doesn't drop matches on the floor.
      return new Response(`sink failed: ${e}`, { status: 500 });
    }

    // Record the delivery only after the sink succeeded — a delivery that failed
    // and got retried should still fire, not be silently swallowed as a dupe.
    if (deliveryId && env.SEEN_DELIVERIES) {
      await env.SEEN_DELIVERIES.put(deliveryId, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
    }

    return json({ status: "ok", delivery_id: deliveryId || "", messages: messages.length });
  },
};

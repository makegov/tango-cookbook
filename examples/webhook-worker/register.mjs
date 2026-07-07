/**
 * Register a Tango webhook endpoint + alert for the Worker, using the official
 * Node SDK (@makegov/tango-node). This is a one-time admin step — it never runs
 * inside the Worker; it just wires Tango to your deployed Worker URL, in the
 * same language and toolchain you deployed with.
 *
 * Run (from the repo root):
 *   just webhook-worker-register https://<your-worker>.workers.dev/webhooks/tango
 *
 * Or directly (after `npm install` in this directory):
 *   node register.mjs https://<your-worker>.workers.dev/webhooks/tango
 *
 * It creates the endpoint, writes the shared secret to a 0600 file beside this
 * script (webhook.secret, gitignored) — never to stdout, so the secret can't
 * leak into shell history, terminal recorders, or CI logs — attaches one
 * example alert, and fires a test delivery. Set TANGO_WEBHOOK_SECRET on the
 * Worker (see the README) before that test can verify.
 *
 * Environment:
 *   TANGO_API_KEY   required. Used to create the endpoint + alert.
 */

import { writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TangoClient } from "@makegov/tango-node";

const SECRET_FILE = join(dirname(fileURLToPath(import.meta.url)), "webhook.secret");

async function main() {
  const callbackUrl = process.argv[2];
  if (!callbackUrl) {
    console.error("usage: node register.mjs <callback-url>");
    process.exit(1);
  }
  if (!process.env.TANGO_API_KEY) {
    console.error("missing TANGO_API_KEY — see the repo root .env.example");
    process.exit(1);
  }

  const tango = new TangoClient(); // reads TANGO_API_KEY from the environment

  const endpoint = await tango.createWebhookEndpoint({
    name: "cookbook webhook-worker example",
    callbackUrl,
    isActive: true,
  });
  console.log(`endpoint_id:  ${endpoint.id}`);
  console.log(`callback_url: ${endpoint.callback_url}`);

  // The shared secret is returned only on create. Write it to a 0600 file and
  // never print it — stdout ends up in shell history, terminal recordings, and
  // CI logs. The Worker verifies every delivery against this value.
  if (!endpoint.secret) {
    console.error("endpoint created but no secret was returned — cannot continue");
    process.exit(1);
  }
  writeFileSync(SECRET_FILE, `TANGO_WEBHOOK_SECRET=${endpoint.secret}\n`, { mode: 0o600 });
  chmodSync(SECRET_FILE, 0o600); // guarantee 0600 even if the file pre-existed
  console.log(`secret:       wrote to ${SECRET_FILE} (mode 0600)`);
  console.log();
  console.log("Set it on the Worker before the test delivery can verify:");
  console.log("  npx wrangler secret put TANGO_WEBHOOK_SECRET   # paste the value from that file");
  console.log();

  // One example alert so the endpoint receives something. `endpoint` is required
  // because Tango routes to the wrong receiver otherwise when an account has more
  // than one endpoint. `query_type` is singular; `filters` are the same params
  // you'd pass to GET /api/opportunities/ — customize freely.
  const alert = await tango.createWebhookAlert({
    name: "cookbook example — IT services opportunities",
    query_type: "opportunity",
    filters: { naics: "541512", active: true },
    frequency: "realtime",
    endpoint: endpoint.id,
  });
  console.log(`alert_id: ${alert.alert_id}`);
  console.log(`status:   ${alert.status}`);
  console.log();

  // Fire a synthetic delivery so you can confirm the Worker is wired up.
  const test = await tango.testWebhookEndpoint(endpoint.id);
  console.log(`test delivery: success=${test.success} status=${test.status_code ?? "?"}`);
  if (!test.success) {
    console.log(`  ${test.message ?? test.error ?? "(set TANGO_WEBHOOK_SECRET on the Worker, then re-test)"}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * Offline smoke test for the Worker's pure logic — no network, no Workers runtime.
 *
 * Signs the sample delivery exactly the way Tango would, then checks that the
 * handler's building blocks agree: the signature verifies, a tampered body is
 * rejected, and the batch envelope turns into the right Slack messages.
 *
 *   node smoke.mjs      # or: just webhook-worker-smoke
 *
 * Exits non-zero on the first failed assertion.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { hmacHex, verifySignature, buildMessages } from "./src/worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "test-secret-not-a-real-one";

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

const raw = await readFile(join(here, "sample_delivery.json"));
const bytes = new Uint8Array(raw);
const payload = JSON.parse(new TextDecoder().decode(bytes));

// 1. A signature we produce the way Tango does must verify — both bare hex and
//    the "sha256=" header form.
const sig = await hmacHex(SECRET, bytes);
assert(await verifySignature(bytes, SECRET, sig), "valid signature verifies (bare hex)");
assert(await verifySignature(bytes, SECRET, `sha256=${sig}`), "valid signature verifies (sha256= prefix)");

// 2. Wrong secret, tampered body, and missing header must all fail.
assert(!(await verifySignature(bytes, "wrong-secret", sig)), "wrong secret is rejected");
const tampered = new Uint8Array([...bytes, 0x20]);
assert(!(await verifySignature(tampered, SECRET, sig)), "tampered body is rejected");
assert(!(await verifySignature(bytes, SECRET, null)), "missing signature header is rejected");

// 3. The batch envelope becomes one Slack message per new opportunity match.
const messages = buildMessages(payload);
const expected = payload.events[0].matches.new.length;
assert(messages.length === expected, `builds one message per match (${expected})`);

const first = JSON.stringify(messages[0]);
assert(first.includes("IT Support Services"), "message carries the opportunity title");
assert(first.includes("75H70126R00042"), "message carries the solicitation number");
assert(first.includes("sam.gov/opp/"), "message links to the SAM.gov opportunity");

// 4. A non-opportunity event falls back to a compact summary block, not a crash.
const contractDelivery = {
  delivery_id: "x",
  events: [
    { event_type: "alerts.contract.match", alert_id: "abcdef123456", matches: { new_count: 3, modified_count: 1 } },
  ],
};
const [summary] = buildMessages(contractDelivery);
assert(JSON.stringify(summary).includes("3 new, 1 modified"), "non-opportunity event summarizes counts");

console.log("\nAll smoke checks passed.");

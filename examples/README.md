# Examples

More ambitious patterns built on the Tango API. Where [`notebooks/`](../notebooks/) shows recipes that read top-to-bottom and render their output, `examples/` shows runnable programs — scripts, agents, services — that you'd fork as a starting point for something real.

| Example | What it shows |
| --- | --- |
| [`opportunities-agent/`](./opportunities-agent/) | A minimal Claude tool-use loop that lets you ask plain-English questions about federal opportunities. |
| [`saved-search-watcher/`](./saved-search-watcher/) | A YAML-driven watcher: pull a saved search on a schedule, diff against a JSON state file, alert on what's new. |
| [`tango-lookup-extension/`](./tango-lookup-extension/) | A Chrome extension (Manifest V3, vanilla JS) for quick lookups of entities, contracts, IDVs, and opportunities from the toolbar. |
| [`webhook-receiver/`](./webhook-receiver/) | A FastAPI app that accepts Tango webhook deliveries — signature-verified, idempotent, with a pluggable sink. |

## Conventions

- One subdirectory per example, each with its own `README.md` and runnable entry point.
- Examples **are not run in CI**. They may depend on paid APIs, produce non-deterministic output, or take a long time. The README for each example notes what it needs.
- Anything beyond `TANGO_API_KEY` (e.g. `ANTHROPIC_API_KEY`) goes in `.env.example` at the repo root.
- Prefer clarity over completeness. These are scaffolds you read once, then fork — not products.

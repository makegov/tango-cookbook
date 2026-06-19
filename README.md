# Tango Cookbook

Recipes and reference apps for the [Tango API](https://tango.makegov.com), primarily via the [`tango-python`](https://pypi.org/project/tango-python/) SDK. Everything here runs against the live API; notebooks are re-executed nightly in CI, so what you see is what runs.

**▶ [Watch the 2-minute tour](https://youtu.be/A3VoMdVJt3Y)** — the Chrome extension, the USASpending-replacement notebook, and the automation examples, on live data.

## Two surfaces

**[`notebooks/`](./notebooks/)** — self-contained Jupyter recipes that read top-to-bottom and render their outputs on GitHub. Read one, fork the cells you need.

**[`examples/`](./examples/)** — runnable scripts, agents, and services to fork as the starting point for something real. Each ships with its own README.

## What's here

### Notebooks

| Recipe | What it shows |
| --- | --- |
| [`incumbent-radar`](./notebooks/incumbent-radar.ipynb) | Pull a competitor's contracts, IDVs, OTAs, and subaward flow from one UEI to surface agency mix, NAICS mix, and recompete windows. |
| [`naics-to-agency-map`](./notebooks/naics-to-agency-map.ipynb) | Given a NAICS code, rank the agencies actually spending money on it — with a year-over-year delta to spot risers and fallers. |
| [`protest-landmines`](./notebooks/protest-landmines.ipynb) | Pull GAO protest decisions for a target agency, sort by outcome, and pull the digests for the sustained ones to learn what went wrong. |
| [`budget-contractability-score`](./notebooks/budget-contractability-score.ipynb) | Which agency accounts actually buy things from contractors — and why the biggest ones usually don't. |
| [`budget-deep-space-exploration`](./notebooks/budget-deep-space-exploration.ipynb) | Trace a federal account from request through outlay, then see who got the contracts. |

### Examples

| Example | What it shows |
| --- | --- |
| [`opportunities-agent`](./examples/opportunities-agent/) | A minimal Claude tool-use loop that answers plain-English questions about federal opportunities. |
| [`incumbent-on-post`](./examples/incumbent-on-post/) | A new opportunity posts → brief the likely incumbent, prior award, and funding. A PydanticAI agent over the Tango MCP (the repo's first MCP integration), hardened with a deterministic scorer + evals. |
| [`saved-search-watcher`](./examples/saved-search-watcher/) | A YAML-driven watcher: poll a saved search on a schedule, diff against a JSON state file, alert on what's new. |
| [`webhook-receiver`](./examples/webhook-receiver/) | A FastAPI app that accepts Tango webhook deliveries — signature-verified, idempotent, with a pluggable sink. |

## Setup

Requires Python 3.12+, [`uv`](https://docs.astral.sh/uv/), and [`just`](https://just.systems/) (`brew install just`).

```bash
just setup     # installs deps, creates .env from .env.example
$EDITOR .env   # paste your TANGO_API_KEY
just lab       # launch JupyterLab
```

Get an API key from [tango.makegov.com](https://tango.makegov.com).

`just` auto-loads `.env`, so notebooks just do:

```python
import os
from tango import TangoClient

client = TangoClient(api_key=os.environ["TANGO_API_KEY"])
```

## Common tasks

| Command         | What it does                                                  |
| --------------- | ------------------------------------------------------------- |
| `just`          | List available recipes.                                       |
| `just setup`    | First-time install (deps + `.env` + `nbdime` git driver).     |
| `just sync`     | Refresh deps after `pyproject.toml` / `uv.lock` changes.      |
| `just lab`      | Launch JupyterLab with `.env` loaded.                         |
| `just execute`  | Run every notebook end-to-end (matches CI).                   |
| `just refresh`  | Re-execute every notebook in place to refresh outputs.        |

## Recipe conventions

- One notebook per recipe; descriptive slug for the filename.
- Read secrets from `os.environ` — `just` puts `.env` there for you.
- **Commit notebook outputs.** A recipe's *result* is part of what it teaches, so notebooks render fully on GitHub. CI re-executes on every PR to catch drift. Use `just refresh` before committing if you've edited code without re-running.
- `nbdime` is installed and wired as the git diff/merge driver (via `just setup`) so `git diff` on notebooks is readable.

## License

MIT

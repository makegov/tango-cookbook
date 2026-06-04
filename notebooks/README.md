# Recipes

Browse by tag below, or open any notebook directly.

## Budget

| Recipe | What it shows | Endpoints |
| ------ | ------------- | --------- |
| [Following NASA's Deep Space Exploration budget](./budget-deep-space-exploration.ipynb) | Trace a federal account from request through outlay, then see who got the contracts. | `list_budget_accounts`, `get_budget_account_recipients` |
| [Scoring federal accounts by contract share](./budget-contractability-score.ipynb) | Which agency accounts actually buy things from contractors — and why the biggest ones usually don't. | `list_budget_accounts` |

## Contracts

| Recipe | What it shows | Endpoints |
| ------ | ------------- | --------- |
| [Mapping a NAICS code to its real federal buyers](./naics-to-agency-map.ipynb) | Rank the departments actually spending on a NAICS, with a year-over-year delta to spot risers and fallers. | `list_contracts`, `list_naics` |

## Entities

| Recipe | What it shows | Endpoints |
| ------ | ------------- | --------- |
| [Building an incumbent radar from one UEI](./incumbent-radar.ipynb) | One UEI → entity profile, contracts, IDVs, OTAs, subawards. Agency mix, NAICS/PSC mix, and recompete windows. | `list_entities`, `get_entity`, `list_entity_contracts`, `list_entity_idvs`, `list_entity_otas`, `list_entity_subawards` |

## Protests

| Recipe | What it shows | Endpoints |
| ------ | ------------- | --------- |
| [Reading protest history before you bid](./protest-landmines.ipynb) | Pull an agency's protest record, filter to sustained outcomes, and read GAO's digest of what went wrong. | `list_protests`, `get_protest` |

<!-- Add new sections as tags accumulate (Opportunities, Notices, …). -->

---

## Recipe frontmatter convention

Every notebook starts with a **single markdown cell** containing:

1. A YAML code fence with metadata (machine-readable; renders nicely on GitHub).
2. An H1 title.
3. A 1–2 sentence intro.

````markdown
```yaml
title: Following NASA's Deep Space Exploration budget
description: Trace a federal account from request through outlay, then see who got the contracts.
tags: [budget, recipients, shape]
endpoints: [list_budget_accounts, get_budget_account_recipients]
```

# Following NASA's Deep Space Exploration budget

A quick tour of the budget endpoints: find a federal account, watch the dollars move
through the budget lifecycle, then see which companies actually got the contracts.
````

**Fields**

| Field         | Required | Notes                                                                |
| ------------- | -------- | -------------------------------------------------------------------- |
| `title`       | yes      | Mirrors the H1. One line.                                            |
| `description` | yes      | ≤ ~120 chars. Used as the table blurb in this README.                |
| `tags`        | yes      | Lowercase, kebab-case. See the tag list below. Pick 1–4.             |
| `endpoints`   | yes      | SDK methods the recipe calls (e.g. `list_contracts`).                |

## Tag taxonomy

Keep it small; add a new tag only when a recipe genuinely doesn't fit any existing one.

**Domains** (what the recipe is about)
`budget`, `contracts`, `idvs`, `otas`, `opportunities`, `notices`, `grants`, `entities`, `forecasts`, `protests`, `recipients`, `webhooks`

**Techniques** (how the recipe works)
`shape` (response shaping), `pagination`, `filtering`, `joining` (combining endpoints), `async`

**Goals** (what the recipe helps a user do)
`analysis`, `business-development`, `capture`, `proposals`

If a tag accumulates ~5 recipes, promote it to its own folder under `notebooks/`.

## Adding a recipe

1. Drop a notebook in `notebooks/` with a descriptive slug.
2. Add the frontmatter cell above.
3. Add a row to the relevant section of this README.
4. `just refresh` so committed outputs match the current code.
5. `just lint` (CI runs this on every PR), then commit.

> **Outputs are committed.** This is deliberate: a recipe's *result* is part of what it teaches. Reviewers see outputs in the diff thanks to `nbdime` (registered as the git diff/merge driver by `just setup`). CI re-executes every notebook to catch drift between code and committed outputs.

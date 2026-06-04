# Recipes

Browse by tag below, or open any notebook directly.

## Budget

| Recipe | What it shows | Endpoints |
| ------ | ------------- | --------- |
| [Following NASA's Deep Space Exploration budget](./budget-deep-space-exploration.ipynb) | Trace a federal account from request through outlay, then see who got the contracts. | `list_budget_accounts`, `get_budget_account_recipients` |

<!-- Add new sections as tags accumulate (Contracts, Opportunities, Notices, …). -->

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

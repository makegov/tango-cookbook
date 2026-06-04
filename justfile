# Tango Cookbook task runner. Run `just` to see recipes.
# `just` auto-loads .env into the environment of every recipe.
set dotenv-load := true

nb := "notebooks/*.ipynb"

# Show available recipes.
default:
    @just --list

# First-time setup: install deps, stub .env, register nbdime as git diff/merge driver.
setup:
    uv sync --all-groups
    @[ -f .env ] || cp .env.example .env
    uv run nbdime config-git --enable --global
    @echo "Edit .env to add your TANGO_API_KEY."

# Refresh the environment from pyproject.toml / uv.lock.
sync:
    uv sync --all-groups

# Launch JupyterLab.
lab:
    uv run jupyter lab

# Validate notebook frontmatter (title, description, tags, endpoints).
lint:
    uv run python scripts/check_frontmatter.py

# Execute every notebook end-to-end (same command CI runs).
execute:
    uv run jupyter execute --timeout=180 {{nb}}

# Re-execute every notebook in place, saving fresh outputs into the .ipynb files.
refresh:
    uv run jupyter execute --inplace --timeout=180 {{nb}}

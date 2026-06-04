# Tango Cookbook

Public recipes for working with the [Tango API](https://tango.makegov.com), primarily via the [`tango-python`](https://pypi.org/project/tango-python/) SDK.

Each recipe is a self-contained Jupyter notebook in [`notebooks/`](./notebooks/).

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
| `just setup`    | First-time install (deps + `.env`).                           |
| `just sync`     | Refresh deps after `pyproject.toml` / `uv.lock` changes.      |
| `just lab`      | Launch JupyterLab with `.env` loaded.                         |
| `just execute`  | Run every notebook end-to-end (matches CI).                   |
| `just strip`    | Strip outputs from notebooks before committing.               |

## Recipe conventions

- One notebook per recipe; number them (`00_`, `01_`, …) so they sort.
- Read secrets from `os.environ` — `just` puts `.env` there for you.
- Clear outputs before committing: `just strip`.
- Keep notebooks runnable end-to-end. CI runs `just execute` on every PR.

## License

MIT

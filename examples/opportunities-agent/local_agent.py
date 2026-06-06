"""
The local-model twin of agent.py — same Tango tools, same loop, swapped LLM.

Talks to any OpenAI-compatible server. Defaults to Ollama on localhost, so:

    ollama pull qwen2.5:14b           # or qwen2.5:32b, llama3.3:70b, gpt-oss:20b
    just local-agent                  # uses default question
    just local-agent "your question"

Or directly:

    uv run python examples/opportunities-agent/local_agent.py "your question"

Override the model / endpoint via env:

    LOCAL_MODEL=qwen2.5:32b LOCAL_BASE_URL=http://localhost:11434/v1 just local-agent

Requires TANGO_API_KEY. No ANTHROPIC_API_KEY needed.

The two scripts are intentionally mirror images so you can diff them and see
exactly where the Anthropic and OpenAI tool-use protocols differ.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from typing import Any

from openai import OpenAI
from tango import TangoClient

# Import the tools + implementations from the Anthropic version. The tool catalog
# itself is identical — only the wire format around it changes.
from agent import TOOLS, DEFAULT_QUESTION, run_tool

MODEL = os.environ.get("LOCAL_MODEL", "qwen2.5:14b")
BASE_URL = os.environ.get("LOCAL_BASE_URL", "http://localhost:11434/v1")
API_KEY = os.environ.get("LOCAL_API_KEY", "ollama")  # Ollama ignores; client requires non-empty.
MAX_TURNS = 6  # tighter than the Anthropic version — local models loop more.


# A separate, hardened system prompt for smaller local models.
#
# The Anthropic version (agent.py:SYSTEM_PROMPT) phrases stop conditions as soft
# guidance ("two empty searches is a signal to stop") and trusts the model to
# self-regulate. Sonnet does. A 7B–30B local model does not — it will burn
# every available turn keyword-grinding until MAX_TURNS cuts it off, never
# producing a final brief.
#
# This prompt:
#   - Front-loads the stop conditions as hard rules, numbered.
#   - Caps each phase of the pipeline (≤2 opp searches, ≤1 details, ≤1 contract search).
#   - Requires a final brief on the last allowed turn even if data is thin.
#   - Forbids near-duplicate searches (the actual failure mode observed locally).
LOCAL_SYSTEM_PROMPT = """You triage federal contracting opportunities from SAM.gov via the Tango API.

You have three tools:
- search_opportunities: find candidate opportunities.
- get_opportunity_details: pull the full record for one opportunity.
- search_contracts: find recent awarded contracts (to spot likely incumbents).

# Hard rules — follow exactly:

1. Pipeline: search_opportunities → get_opportunity_details (on the best hit) → search_contracts (for the incumbent) → write a final brief. In that order.
2. At most TWO search_opportunities calls. If both come back empty or irrelevant, stop searching and tell the user what was missing.
3. At most ONE get_opportunity_details call. Pick the single most promising opportunity from the search results.
4. At most ONE search_contracts call. Use the agency from the opportunity you picked.
5. NEVER make two searches with only minor keyword variations ("website" then "web app" then "web modernization"). One keyword attempt per search call. If a search returns nothing useful, change strategy — drop a filter, switch agency — don't just reword.
6. After your contract search (or after step 2 if no opportunity panned out), you MUST write the final brief. Do not call any more tools.
7. Do not think out loud. Either call a tool or write the final brief. Nothing else.

# Filter guidance:

- For real bid-able opportunities: notice_type='o' (Solicitation) or 'k' (Combined Synopsis/Solicitation).
- "active" alone does not mean the deadline is in the future. Always pair with response_deadline_after set to today.
- Keyword search is vector-backed. Use 1–2 word phrases ("website modernization", "court reporter"). Not long sentences.
- For incumbent search, prefer a specific awarding_agency over NAICS-only.

# Final brief format:

Three short sections: **Opportunity**, **Suspected incumbent**, **What to think about**. Under **Opportunity**, always include the SAM.gov link (the `sam_url` field from the tool result). Keep it tight. Be honest if data is thin — say so."""


# --- Translate the tool catalog into OpenAI's function-calling shape ----------
# Anthropic: {name, description, input_schema}
# OpenAI:    {type: "function", function: {name, description, parameters}}

OPENAI_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": t["name"],
            "description": t["description"],
            "parameters": t["input_schema"],
        },
    }
    for t in TOOLS
]


# --- The agent loop ------------------------------------------------------------

def run(question: str) -> None:
    client = OpenAI(base_url=BASE_URL, api_key=API_KEY)
    tango = TangoClient()

    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": f"{LOCAL_SYSTEM_PROMPT}\n\nToday's date is {date.today().isoformat()}.",
        },
        {"role": "user", "content": question},
    ]

    print(f"\n> {question}\n[model: {MODEL} @ {BASE_URL}]\n")

    for turn in range(MAX_TURNS):
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=OPENAI_TOOLS,
            max_tokens=2048,
        )
        msg = response.choices[0].message

        if msg.content and msg.content.strip():
            print(msg.content)

        # Local models often set finish_reason="stop" even when they emitted tool
        # calls, so trust tool_calls rather than finish_reason.
        if not msg.tool_calls:
            return

        # Append the assistant turn verbatim so the model sees its own tool calls.
        messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in msg.tool_calls
            ],
        })

        for tc in msg.tool_calls:
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError as e:
                args = {}
                result: Any = {"error": f"could not parse arguments: {e}; raw={tc.function.arguments!r}"}
            else:
                print(f"\n  → {name}({json.dumps(args)})")
                try:
                    result = run_tool(tango, name, dict(args))
                except Exception as e:
                    result = {"error": f"{type(e).__name__}: {e}"}

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(result, default=str),
            })

    print(f"\n[stopped: hit MAX_TURNS={MAX_TURNS}]")


if __name__ == "__main__":
    if not os.environ.get("TANGO_API_KEY"):
        sys.exit("missing TANGO_API_KEY — see .env.example")

    question = " ".join(sys.argv[1:]).strip() or DEFAULT_QUESTION
    run(question)

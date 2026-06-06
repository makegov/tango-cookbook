"""
A minimal agent that answers questions about federal contracting opportunities
by giving Claude two Tango tools and looping until the model is done calling them.

Run:
    just agent              # uses the default question
    just agent "your question here"

Or directly:
    uv run python examples/opportunities-agent/agent.py "your question"

Requires TANGO_API_KEY and ANTHROPIC_API_KEY in the environment (see .env.example).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from typing import Any

from anthropic import Anthropic
from tango import TangoClient

MODEL = "claude-sonnet-4-6"
MAX_TURNS = 12

DEFAULT_QUESTION = (
    "I run a small IT services firm. Find an active small-business set-aside "
    "solicitation for website or web-app modernization at a civilian agency, "
    "with the response deadline still in the future. For the most interesting "
    "one, search past contracts at that same agency to identify who's been "
    "doing the work — that's likely the incumbent I'd be competing against. "
    "Give me a short brief with the opp, the suspected incumbent, and what I "
    "should think about."
)

SYSTEM_PROMPT = """You help analysts triage federal contracting opportunities from SAM.gov, via the Tango API.

You have three tools:
- search_opportunities: find candidate opportunities by keyword, NAICS, set-aside, agency, notice type, deadline.
- get_opportunity_details: pull the full record for one opportunity by ID.
- search_contracts: find recent awarded contracts (useful for spotting likely incumbents on an upcoming opportunity — search by awarding agency + keyword, or NAICS).

The high-value pattern is: search opportunities → pick the most interesting → search past contracts at the same agency to identify the incumbent → brief the analyst.

Filtering rules of thumb:
- For real bid-able opportunities, set notice_type to 'o' (Solicitation) or 'k' (Combined Synopsis/Solicitation). Sources Sought, RFIs, and modifications are not solicitations you can respond to.
- 'active' alone does not mean the deadline is in the future — pair it with response_deadline_after set to today.
- Keyword `search` is vector-backed (semantic). Short phrases (1-2 words like "website modernization", "help desk", "court reporter") work better than long ones — extra words dilute the vector and can drop the strongest match out of the top results.
- For finding incumbents, prefer a specific agency over a NAICS-only contract search. NAICS-only searches across all of government are noisy.

When you have enough information, give a tight, action-oriented summary. Skip the field-by-field recap. Always include the SAM.gov link for the opportunity (the `sam_url` field from the tool result). Be honest if data is thin or a search returned nothing useful — say so and suggest what to try next.

Don't keep retrying searches that come back empty. Two empty searches on a question is a signal to stop, deliver what you have, and tell the user what was missing — not to keep guessing keyword variations."""


# --- Tool definitions exposed to Claude ----------------------------------------
# Each tool is (1) a JSON Schema description for the model, (2) a Python function
# that actually runs when the model picks it. The loop below ties them together.

TOOLS = [
    {
        "name": "search_opportunities",
        "description": (
            "Search active and historical federal contracting opportunities. "
            "Returns a list of matches with id, title, agency, NAICS, set-aside, "
            "and response deadline. Use this first to find candidates, then call "
            "get_opportunity_details for any you want to inspect."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "search": {
                    "type": "string",
                    "description": "Free-text keyword search (e.g. 'cybersecurity', 'cloud migration').",
                },
                "agency": {
                    "type": "string",
                    "description": "Agency name, code, or abbreviation (e.g. 'VA', 'Selective Service System', '9700'). Fuzzy-matched.",
                },
                "naics": {
                    "type": "string",
                    "description": "6-digit NAICS code (e.g. '541519' for Other Computer Related Services, '541511' for Custom Computer Programming, '541512' for Computer Systems Design).",
                },
                "set_aside": {
                    "type": "string",
                    "description": "Set-aside code (e.g. 'SBA' total small-business, '8AN' 8(a), 'WOSB', 'SDVOSBC', 'HZC' HUBZone).",
                },
                "notice_type": {
                    "type": "string",
                    "description": "Single-letter code. Use 'o' (Solicitation) or 'k' (Combined Synopsis/Solicitation) for real bid-able opportunities. Other codes: 'p' Presolicitation, 'r' Sources Sought, 's' Special Notice, 'a' Award.",
                },
                "active": {
                    "type": "boolean",
                    "description": "If true, only opportunities not yet awarded. Note: 'active' does NOT mean the deadline is still in the future — pair with response_deadline_after.",
                },
                "response_deadline_after": {
                    "type": "string",
                    "description": "ISO date (YYYY-MM-DD). Only opportunities due on or after this date. Use today's date to filter out already-closed solicitations.",
                },
                "response_deadline_before": {
                    "type": "string",
                    "description": "ISO date (YYYY-MM-DD). Only opportunities due on or before this date.",
                },
                "limit": {
                    "type": "integer",
                    "description": "How many results to return (default 5, max 25).",
                },
            },
        },
    },
    {
        "name": "get_opportunity_details",
        "description": "Fetch the full record for a single opportunity by its ID.",
        "input_schema": {
            "type": "object",
            "properties": {
                "opportunity_id": {"type": "string"},
            },
            "required": ["opportunity_id"],
        },
    },
    {
        "name": "search_contracts",
        "description": (
            "Search awarded federal contracts. The big use case: given an upcoming "
            "opportunity, find recent contracts in the same NAICS (and ideally the "
            "same awarding agency) to identify the likely incumbent. Returns "
            "recipient, PIID, award date, value, and a short description."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "keyword": {
                    "type": "string",
                    "description": "Free-text search over contract descriptions.",
                },
                "naics_code": {"type": "string", "description": "6-digit NAICS."},
                "awarding_agency": {
                    "type": "string",
                    "description": "Agency code (e.g. '9700' for DoD). Often matches the agency on the opportunity.",
                },
                "recipient_name": {
                    "type": "string",
                    "description": "Filter to a specific awardee (useful for confirming a suspected incumbent).",
                },
                "award_date_gte": {
                    "type": "string",
                    "description": "ISO date — only contracts awarded on/after this date (e.g. last 2 years).",
                },
                "limit": {
                    "type": "integer",
                    "description": "How many results (default 5, max 25).",
                },
            },
        },
    },
]


# --- Tool implementations ------------------------------------------------------
# These are deliberately thin wrappers around the Tango SDK. The interesting
# decisions — what to search for, which result to drill into — happen in the
# model, not here.

# Field list passed as Tango's `shape` parameter. Tango's default shape strips
# everything except 5 fields, including the `sam_url` that we want the model to
# surface in the brief. (Tango computes `sam_url` itself, using the *latest*
# notice id with hyphens stripped — which is what SAM.gov actually accepts —
# so we never want to construct it client-side.)
OPP_SHAPE = (
    "opportunity_id,title,solicitation_number,naics_code,psc_code,set_aside,"
    "response_deadline,first_notice_date,active,place_of_performance,office,sam_url"
)

# Details get the same fields plus description + primary contact for the brief.
OPP_DETAILS_SHAPE = OPP_SHAPE + ",description,primary_contact"


def _trim_opportunity(opp: dict[str, Any]) -> dict[str, Any]:
    """Drop null fields so the JSON we hand the model stays compact."""
    return {k: v for k, v in opp.items() if v is not None}


def run_tool(tango: TangoClient, name: str, args: dict[str, Any]) -> Any:
    if name == "search_opportunities":
        limit = min(int(args.pop("limit", 5)), 25)
        page = tango.list_opportunities(limit=limit, shape=OPP_SHAPE, **args)
        return {"count": page.count, "results": [_trim_opportunity(r) for r in page.results]}

    if name == "get_opportunity_details":
        return tango.get_opportunity(args["opportunity_id"], shape=OPP_DETAILS_SHAPE)

    if name == "search_contracts":
        limit = min(int(args.pop("limit", 5)), 25)
        page = tango.list_contracts(limit=limit, **args)
        return {"count": page.count, "results": list(page.results)}

    raise ValueError(f"Unknown tool: {name}")


# --- The agent loop ------------------------------------------------------------

def run(question: str) -> None:
    anthropic = Anthropic()  # reads ANTHROPIC_API_KEY
    tango = TangoClient()    # reads TANGO_API_KEY
    messages: list[dict[str, Any]] = [{"role": "user", "content": question}]

    print(f"\n> {question}\n")

    for turn in range(MAX_TURNS):
        response = anthropic.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=f"{SYSTEM_PROMPT}\n\nToday's date is {date.today().isoformat()}.",
            tools=TOOLS,
            messages=messages,
        )

        # Show any prose the model emitted this turn.
        for block in response.content:
            if block.type == "text" and block.text.strip():
                print(block.text)

        # If the model didn't ask for a tool, we're done.
        if response.stop_reason != "tool_use":
            return

        # Otherwise run each tool call and feed results back in.
        messages.append({"role": "assistant", "content": response.content})
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            print(f"\n  → {block.name}({json.dumps(block.input)})")
            try:
                result = run_tool(tango, block.name, dict(block.input))
            except Exception as e:
                result = {"error": f"{type(e).__name__}: {e}"}
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(result, default=str),
            })
        messages.append({"role": "user", "content": tool_results})

    print(f"\n[stopped: hit MAX_TURNS={MAX_TURNS}]")


if __name__ == "__main__":
    for var in ("TANGO_API_KEY", "ANTHROPIC_API_KEY"):
        if not os.environ.get(var):
            sys.exit(f"missing {var} — see .env.example")

    question = " ".join(sys.argv[1:]).strip() or DEFAULT_QUESTION
    run(question)

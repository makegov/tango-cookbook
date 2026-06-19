"""
Incumbent-on-post — the agent.

A new opportunity hits SAM.gov. This script takes that notice, points a PydanticAI
agent at the *hosted Tango MCP server*, and asks: who's the likely incumbent, what
was the prior award worth, and is the money still flowing? The model drives the
Tango tools (resolve / search / search_opportunities / get_details) itself and
returns a typed `IncumbentBrief`.

This is the cookbook's first MCP integration. Everything else in examples/ hand-wires
the tango-python SDK; here the tool catalog comes from the MCP server, so the only
thing this file owns is the *doctrine* (the office-pivot prompt) and the *output
contract* (the schema below).

This is the "easy version." It gets a plausible answer. Plausible isn't shippable —
see scorer.py for the deterministic ranking that makes the incumbent join reproducible
and eval-able, and the README for why you want both.

Run:
    just incumbent                       # uses sample_notice.json
    just incumbent path/to/notice.json

Requires TANGO_API_KEY (for the MCP server) and a model:
  - default: ANTHROPIC_API_KEY + the hosted Anthropic model.
  - local / OpenAI-compatible: set OPENAI_BASE_URL (e.g. http://localhost:1234/v1 for
    LM Studio or Ollama) and MODEL to the served model id. Pick a model that does
    real tool-calling — this agent lives or dies on driving the Tango MCP tools.

Not run in CI: it calls a paid LLM and a live API, and the output is non-deterministic.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerStreamableHTTP
from pydantic_ai.models import Model

# Default to the hosted Anthropic model. Override with MODEL, and point at any
# OpenAI-compatible server (LM Studio, Ollama, vLLM, ...) by setting OPENAI_BASE_URL.
MODEL = os.environ.get("MODEL", "anthropic:claude-sonnet-4-6")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL")
TANGO_MCP_URL = os.environ.get("TANGO_MCP_URL", "https://govcon.dev/mcp")


# --- The output contract -------------------------------------------------------
# The whole point of using a structured-output agent (vs. the free-text loop in
# opportunities-agent) is that a webhook-triggered pipeline needs a *typed* result
# it can route on — not a paragraph. Note what the schema refuses to let the model
# do: it cannot name a single incumbent. It can only rank candidates, and it must
# be able to say "this is new work."

class Candidate(BaseModel):
    """One suspected incumbent. Never the answer on its own — always one of a ranked list."""

    vendor_name: str
    uei: str | None = Field(None, description="UEI if resolved, else null.")
    confidence: Literal["high", "medium", "low"]
    prior_award_value: str | None = Field(
        None,
        description="Human-readable. Distinguish task-order obligation from IDV ceiling, "
        "e.g. '$4.2M obligated under a $50M-ceiling IDV'.",
    )
    recompete_date: str | None = Field(
        None,
        description="When this incumbent's clock runs out — PoP end or IDV last_date_to_order (ISO).",
    )
    evidence: list[str] = Field(
        default_factory=list,
        description="The contract PIIDs / IDV keys this candidate is inferred from. "
        "A candidate with no evidence is a guess and should be dropped.",
    )
    why: str = Field(description="One line: which signal carried this — expiry, scope match, magnitude.")


class FundingSignal(BaseModel):
    """The 'is the money real' read. Pivots on the same office/agency as the incumbent."""

    account: str | None = Field(None, description="Federal account symbol / title, if one is identifiable.")
    enacted_yoy: str | None = None
    obligated_yoy: str | None = None
    read: str | None = Field(
        None,
        description="Plain-English, e.g. 'enacted +8%, obligations -12% — appropriated but not yet flowing'.",
    )


class IncumbentBrief(BaseModel):
    solicitation_number: str
    office: str | None = Field(None, description="The contracting office the incumbent search pivoted on.")
    new_work_likely: bool = Field(
        description="True when no candidate clears the expiry-window/scope bar — i.e. likely a first-time "
        "buy, previously in-house, or otherwise no clear predecessor. When true, candidates may be empty."
    )
    candidates: list[Candidate] = Field(
        default_factory=list, description="Ranked shortlist, best first. At most 3. May be empty if new_work_likely."
    )
    funding: FundingSignal | None = None
    vulnerabilities: list[str] = Field(
        default_factory=list,
        description="Capture angles: scope expansion vs. prior award, set-aside change, no incumbent IDV, "
        "thinning pipeline, shrinking funding account.",
    )
    notes: str = Field("", description="Anything that qualifies the brief — thin data, coarse office, ambiguity.")


# --- The doctrine --------------------------------------------------------------
# This is the part that isn't in the API docs. It encodes the office-pivot heuristic
# we arrived at the hard way: a fresh recompete gets a NEW solicitation number, so you
# can never join the notice to the prior award on the number. You pivot on the office.

INSTRUCTIONS = """\
You research likely incumbents on newly posted federal opportunities, using the Tango MCP tools.

Hard rule — do NOT join on the solicitation number. A fresh recompete gets a brand-new
solicitation number; the prior award carries the OLD one. They never match. Pivot on the
CONTRACTING OFFICE instead.

Method:
1. Resolve the office. Use the most specific awarding org on the notice (office level, not just
   the parent department — department-level filtering returns noise). `resolve` and
   `get_details(type=organization)` help. The solicitation-number prefix can cross-check the office
   but is unreliable (civilian formats vary; GWAC/Schedule orders show the ordering office).
2. Find candidates. `search(type=contract)` and `search(type=idv)` filtered by that office plus the
   notice's NAICS (and PSC if present). Do NOT just take the most recent awards — recency surfaces
   brand-new awards, which are the OPPOSITE of a recompete. The incumbent is whoever's contract is
   EXPIRING: rank by period-of-performance end / IDV last_date_to_order landing near the notice
   (roughly the notice date minus 12 months through plus 12 months), then by scope match between the
   notice description and the award description, then by plausible dollar magnitude and set-aside continuity.
   A vendor merely appearing often at the agency is NOT evidence of incumbency on this scope.
3. Produce a RANKED shortlist of at most 3 — never assert a single incumbent. Each candidate must carry
   the contract/IDV identifiers it was inferred from as evidence; drop any candidate you can't back with
   an identifier.
4. If nothing clears the expiry-window/scope bar, set new_work_likely=true and return few or no candidates.
   "Likely new work / no clear predecessor" is a correct and useful answer — do not force a guess.
5. For the top candidate, optionally pull get_details(type=entity, include_related=true) for size,
   certifications, total obligations with this agency, and IDV/vehicle holdings.
6. Funding signal: identify the budget account funding this kind of work at the office/agency and report
   its enacted-vs-obligated year-over-year movement (get_details(type=budget_account)). Frame it as a
   funding-health read, not a claim that this specific opportunity is funded from that line.

Be honest about confidence. A coarse office, a wide NAICS, or thin results all mean LOW confidence —
say so in `notes` rather than inflating the shortlist.
"""


def build_model() -> str | Model:
    """A model spec for the Agent. A plain provider:id string for hosted models, or an
    OpenAI-compatible Model when OPENAI_BASE_URL points at a local/self-hosted server."""
    if not OPENAI_BASE_URL:
        return MODEL
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    # Strip a leading "openai:" if present — the provider already implies it.
    model_id = MODEL.split(":", 1)[1] if MODEL.startswith("openai:") else MODEL
    provider = OpenAIProvider(base_url=OPENAI_BASE_URL, api_key=os.environ.get("OPENAI_API_KEY", "not-needed"))
    return OpenAIChatModel(model_id, provider=provider)


def build_agent() -> Agent[None, IncumbentBrief]:
    api_key = os.environ["TANGO_API_KEY"]
    tango_mcp = MCPServerStreamableHTTP(TANGO_MCP_URL, headers={"X-Tango-API-Key": api_key})
    return Agent(
        build_model(),
        toolsets=[tango_mcp],
        output_type=IncumbentBrief,
        instructions=INSTRUCTIONS,
        defer_model_check=True,  # tolerate model ids newer than this pydantic-ai release
    )


def _notice_prompt(notice: dict) -> str:
    """Hand the model the notice as-is. We define the input shape; the README documents it."""
    return "A new federal opportunity was just posted. Research its likely incumbent(s) and funding.\n\n" + json.dumps(
        notice, indent=2, default=str
    )


async def run(notice: dict) -> IncumbentBrief:
    agent = build_agent()
    async with agent:  # opens the MCP connection for the duration of the run
        result = await agent.run(_notice_prompt(notice))
    return result.output


def main() -> None:
    required = ["TANGO_API_KEY"]
    if not OPENAI_BASE_URL:  # hosted Anthropic default needs a key; a local server doesn't
        required.append("ANTHROPIC_API_KEY")
    for var in required:
        if not os.environ.get(var):
            sys.exit(f"missing {var} — see .env.example")

    here = Path(__file__).parent
    notice_path = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "sample_notice.json"
    notice = json.loads(notice_path.read_text())

    print(f"\n> incumbent-on-post: {notice.get('solicitation_number', '?')} — {notice.get('title', '')}\n")
    brief = asyncio.run(run(notice))
    print(json.dumps(brief.model_dump(), indent=2, default=str))


if __name__ == "__main__":
    main()

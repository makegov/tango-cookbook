# Opportunities Agent

A ~150-line Python script that wires the Tango API into a Claude tool-use loop, so you can ask plain-English questions about federal contracting opportunities and let the model decide which calls to make.

This is the simplest honest version of "an agent": no framework, no abstraction layer — just the loop that's underneath every agent framework you'll see. Read it once and you'll recognize the same shape in LangChain, LangGraph, LlamaIndex, the OpenAI Agents SDK, and so on.

## Run it

From the repo root:

```bash
just agent                                 # default question — incumbent radar on a small-business IT recompete
just agent "Find an active SDVOSB-set-aside solicitation at the VA for courier or transcription services with a deadline in the next 60 days. Who's the likely incumbent at that VA medical center?"
just agent "Find a real solicitation (not Sources Sought) at the Selective Service System or another sub-1000-employee agency. Whoever's been doing the work is your incumbent — surface them."
```

Or directly:

```bash
uv run python examples/opportunities-agent/agent.py "your question here"
```

Needs `TANGO_API_KEY` and `ANTHROPIC_API_KEY` in `.env`. (`.env.example` lists both.)

### Questions that work well vs. questions that don't

The agent shines when the question is narrow enough that one or two contract searches can plausibly identify an incumbent. Examples:

- ✅ **Small agency, real solicitation:** "active IT-mod solicitations at SSS / OPM / FCC / NRC closing in next 90 days, suspected incumbent?"
- ✅ **Specific set-aside + agency:** "SDVOSBC services solicitations at the VA, find the incumbent at that VAMC"
- ✅ **Narrow services category:** "court reporter / lab courier / shred-and-haul recompetes under WOSB"
- ❌ **Broad agency + broad NAICS:** "IT mod RFPs at DHS" — DHS has 22 sub-components and thousands of contracts; incumbent search returns noise
- ❌ **Wide NAICS only:** "anything in 541512" — that NAICS catches everything from custom software to VTC installs to surplus phones

## What's actually happening

```
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ user question│───▶│ Claude (sonnet)  │───▶│  text answer     │
└──────────────┘    └──────────────────┘    └──────────────────┘
                          │     ▲
                          ▼     │
                    ┌──────────────────┐
                    │  Tango API       │
                    │  (search/details)│
                    └──────────────────┘
```

Each turn of the loop:

1. Send the full message history to Claude with the tool catalog attached.
2. If Claude wants to call a tool, run it locally against the Tango SDK and append the result.
3. If Claude returns plain text without a tool call, we're done.

That's it. The "agentic" behavior — deciding to search first, drill into one result, change its mind and search again — emerges from Claude's reasoning over the loop, not from anything in this script.

## Where to take it next

The script is intentionally bare so you can see all the seams. A few directions worth exploring:

- **More tools.** The agent ships with three (`search_opportunities`, `get_opportunity_details`, `search_contracts`), enough to do incumbent recon on an upcoming opportunity. Add `get_entity`, `list_forecasts`, `list_grants`, `get_entity_metrics`, etc. and watch the agent start cross-referencing — e.g., "is the suspected incumbent's pipeline drying up?"
- **More filters.** `search_opportunities` exposes the eight knobs we actually use. The Tango opportunities endpoint takes a dozen more (`first_notice_date_after`, `place_of_performance`, `psc`, `solicitation_number`, ordering, etc.). Add them and the agent's framing options grow accordingly.
- **Memory across runs.** Right now every invocation starts from zero. Persist `messages` to disk and reload, and you have a stateful research assistant. Persist a *summary* instead and you have something cheaper that still remembers context.
- **A real loop.** Wrap this in a REPL or a watch process that polls for new opportunities matching a saved profile and pings you when something looks interesting.
- **Eval.** Pick 10 questions where you know the right answer, run the agent on each, and grade. This is how you find out whether your tool descriptions are good enough.
- **Frameworks.** Once the bones make sense, the same agent in LangGraph or the OpenAI Agents SDK is mostly ceremony. The interesting work is upstream — tool design, prompt, evals.
- **MCP.** Tango ships an MCP server, so you can also expose these same tools to Claude Desktop, Cursor, or any MCP-aware client without writing this loop yourself. Useful for ad-hoc use; less useful when you want a script you can ship.

## Caveats

- This example is **not run in CI** — it calls a paid LLM API and has non-deterministic output. Treat it as a starting point, not a contract.
- The model is set to `claude-sonnet-4-6`. Bump to Opus if you want better reasoning, or Haiku if you want it cheap and fast.
- `MAX_TURNS = 8` is a safety rail to prevent runaway loops. Real production agents usually want this *and* a token budget cap.

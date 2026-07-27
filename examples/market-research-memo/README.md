# Market research memo

A Google Apps Script that does market research the way it actually gets done: by **reading the documents**. Describe a requirement in a Google Sheet, run **Tango ▸ Pull docs + draft memo**, and the script:

1. **Finds similar requirements** — SAM.gov opportunities like yours, open and recently closed.
2. **Pulls the docs themselves** — downloads each requirement's solicitation documents (SOWs, PWSs, RFP packages, attachments) into a Drive folder, one subfolder per requirement.
3. **Identifies the vendors** — matches each requirement to the FPDS award(s) it produced, by solicitation number.
4. **Drafts the memo** — a Google Doc in FAR Part 10 shape: purpose, findings summary, requirement-by-requirement history with quoted notice text and links to every exhibit, a vendor table, and the evidence folder as exhibits.

The output isn't rows about documents — it's the documents, organized, plus a draft memo that cites them. What a capture team reads before writing a proposal; what a CO assembles before writing a requirement.

Sibling to [`../market-research-sheet/`](../market-research-sheet/): the sheet surveys the market wide (award evidence, ranked vendor table); this goes deep on the N most recent similar requirements and produces the deliverable document.

## Install (~2 minutes)

1. Open a new Google Sheet ([sheets.new](https://sheets.new)).
2. **Extensions ▸ Apps Script**, replace `Code.gs` with [`Code.gs`](./Code.gs) from this directory.
3. **Project Settings ▸ Show "appsscript.json" manifest file**, replace its contents with [`appsscript.json`](./appsscript.json) — this one needs Drive and Docs scopes for the folder and the memo, so the manifest matters.
4. Reload the spreadsheet → **Tango** menu appears.
5. **Tango ▸ Set API key…** (from [tango.makegov.com](https://tango.makegov.com)). Stored in your user properties, never in the spreadsheet.
6. **Tango ▸ Reset research inputs**, fill in the yellow cells, then **Tango ▸ Pull docs + draft memo**. First run asks for authorization: this spreadsheet, external requests, Drive, and Docs.

## The inputs

| Cell | Input | Notes |
| --- | --- | --- |
| B3 | Requirement description | Plain English — "base custodial services". Semantic search. |
| B4 | NAICS code(s) | Optional. `561720`, or `561720\|561210` for OR. |
| B5 | PSC code(s) | Optional. `S201`, or `S201\|S214` for OR. |
| B6 | Agency | Optional. Name, abbreviation, or code — fuzzy matched. |
| B7 | Lookback (years) | How far back to scan closed requirements. Default 3. |
| B8 | Requirements to pull docs for | The N most recent get their documents downloaded. Default 8. |

## What a run produces

- **A Drive folder** — `Market research — <your requirement> — <timestamp>` — with one subfolder per requirement, containing its actual solicitation files, named as posted.
- **A draft memo Doc** inside that folder: quoted notice text per requirement, a link to every retrieved document, award outcomes with USASpending links, a vendor table, and an honest italic note that set-aside *history* isn't current size status.
- **A "Doc Index" tab** in the Sheet: every requirement found (pulled or not), files retrieved, folder links, winners, obligated dollars, SAM.gov links.

## How it works

- Similar requirements come from `GET /api/opportunities/` — an open pass plus a closed pass bounded by the lookback, with a structured-filter retry when closed-notice text search comes up dry.
- Each pulled requirement gets one detail call, `GET /api/opportunities/{id}/`, whose `attachments` list has two species: `type: "file"` (hosted documents with a public SAM.gov download URL) and `type: "link"` (external references — PIEE portals, agency pages). Files are downloaded; links are indexed.
- Document downloads hit SAM.gov's public attachment URLs directly — no API key on those requests. Every download is individually fault-tolerant: a file that fails is recorded in the index and memo (`not retrieved (HTTP 404)`) and the run continues.
- Winners come from `GET /api/contracts/?solicitation_identifier=…`. If the exact number misses, it retries with punctuation stripped — FPDS drops the hyphens SAM keeps (the same trick as [`../tango-lookup-extension/`](../tango-lookup-extension/)).

## Caveats

- **Not run in CI.** Live APIs on both sides (Tango and SAM.gov).
- **The memo is a draft, not a determination.** It assembles evidence and citations; the judgment — and the signature — are yours.
- **Downloads are the slow part.** 8 requirements × up to 10 files runs a few minutes. Files over 30MB are skipped by design (Apps Script's fetch ceiling is 50MB); the index says so when it happens.
- **Award notices and pre-solicitations often have no files.** The memo falls back to quoting the notice and linking SAM.gov. Sources sought and solicitations carry the good documents.
- **Solicitation-number matching is honest but imperfect.** Task orders under GWACs and mods can obscure lineage; "no award located" means *by this method*, not "never awarded."
- **Drive quota is yours.** Repeated runs create new timestamped folders; delete the ones you don't keep.

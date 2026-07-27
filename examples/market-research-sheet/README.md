# Market research sheet

A Google Apps Script that turns a Google Sheet into a federal market-research worksheet. Describe a requirement, click **Tango ▸ Run market research**, and get back:

1. **Similar requirements** — opportunities the government has posted for work like yours, open *and* recently closed.
2. **Award evidence** — the recent awards behind that work: who bought, who won, under what set-aside, for how much.
3. **Vendors** — the awards rolled up per vendor and ranked by dollars, with set-aside history and SAM registration data.

That's the core of a FAR Part 10 market research memo — *who can do this work, and can small businesses?* — and it's the same three tables a BD team needs for the mirror-image question: *who's winning this work, and who should we team with or expect to beat?*

Why a spreadsheet? Because that's where market research already happens. No server, no build step, no SDK — one file of Apps Script, `UrlFetchApp`, and a custom menu. Copy, paste, run.

## Install (~2 minutes)

1. Open a new Google Sheet ([sheets.new](https://sheets.new)).
2. **Extensions ▸ Apps Script**, replace the contents of `Code.gs` with [`Code.gs`](./Code.gs) from this directory, and save.
3. Reload the spreadsheet — a **Tango** menu appears.
4. **Tango ▸ Set API key…** — paste your key from [tango.makegov.com](https://tango.makegov.com). It's stored in your *user* properties (tied to your Google account), never written into the spreadsheet.
5. **Tango ▸ Reset research inputs**, fill in the yellow cells, then **Tango ▸ Run market research**.

The first run asks for Google authorization: access to this spreadsheet, external requests (the Tango API), and menu UI — exactly the three scopes declared in [`appsscript.json`](./appsscript.json).

**Prefer the CLI?** With [`clasp`](https://github.com/google/clasp): `clasp create --type sheets`, copy `Code.gs` and `appsscript.json` in, `clasp push`.

## The inputs

| Cell | Input | Notes |
| --- | --- | --- |
| B3 | Requirement description | Plain English — "enterprise IT service desk". The search is semantic, so describe the work; don't keyword-golf. |
| B4 | NAICS code(s) | Optional. `541512`, or `541511\|541512` for OR. |
| B5 | PSC code(s) | Optional. `DE01`, or `DA01\|DE01` for OR. |
| B6 | Agency | Optional. Name, abbreviation, or code — fuzzy matched ("VA", "Air Force"). |
| B7 | Lookback (years) | How far back to pull closed requirements and award evidence. Default 5. |

Description *or* a code filter is enough to run; description *plus* a NAICS or PSC gives the cleanest results.

## How it queries Tango

Three passes, all plain `GET`s against the REST API with `?shape=` trimming responses to just the fields the sheet uses:

1. `GET /api/opportunities/?active=true&search=…` — open requirements, newest first.
2. `GET /api/opportunities/?active=false&first_notice_date_after=<lookback>&search=…` — closed requirements. If this comes back empty and you gave both a description and a code filter, it retries on the codes alone — closed-notice text search can come up dry where the structured filters won't.
3. `GET /api/contracts/?search=…&award_date_gte=<lookback>` — the award evidence, followed through cursor pagination up to 150 awards.

The vendor rollup happens in the script: awards grouped by recipient UEI — award count, total obligated, agencies, NAICS codes, set-asides won, last award date — then the top 15 vendors get one `GET /api/entities/{uei}/` each for SAM registration status and business types (8(a), WOSB, SDVOSB, HUBZone…).

## Reading the results

**Like a contracting officer:** the summary block on the Research tab counts vendors with set-aside wins in this market. Two or more capable small businesses is the evidence pattern behind a set-aside decision (the "rule of two") — but set-aside *history* isn't *current* size status, so verify the finalists in SAM/DSBS before you write the memo.

**Like a BD team:** the Vendors tab is your competitive field — incumbents at the top by dollars, `Last award` telling you who's active versus aging out. The `Solicitation #` column on Award Evidence links awards back to the RFPs that produced them, which is where your recompete calendar starts. Vendors with complementary NAICS mix and set-aside status you lack are your teaming shortlist.

## Where to take it next

- **Recompete radar.** Add `expiring_gte`/`expiring_lte` to the contracts query to see which of these awards end in the next 18 months — the requirements that will post again.
- **Forecasts.** The requirements that *haven't* posted yet: query `/api/forecasts/` with the same filters for agency procurement forecasts.
- **Protest check.** Feed the solicitation numbers into the protests endpoint to see if this market litigates — the [`protest-landmines`](../../notebooks/protest-landmines.ipynb) notebook shows the pattern.
- **Vendor deep-dive.** The entity endpoint's `past_performance[top=10](summary,top_agencies)` shape gives a one-call dossier on any vendor in the table.
- **Re-run on a schedule.** Add a [time-driven trigger](https://developers.google.com/apps-script/guides/triggers/installable) calling `runMarketResearch` weekly; diff against the previous run if you want alerts (see [`../saved-search-watcher/`](../saved-search-watcher/) for the diff pattern).
- **Generate the memo.** The tabs are the exhibits — a `DocumentApp` export of the summary block plus the top of each table is most of a market research report.

## Caveats

- **Not run in CI.** Hits a live API; results move with the data.
- **Caps are deliberate.** 50 requirements per pass, 150 awards, 15 entity lookups — enough for a memo, comfortably inside Apps Script's 6-minute execution limit. Raise the constants at the top of `Code.gs` if you need more depth.
- **Award evidence is FPDS obligations.** Obligated ≠ ceiling, and de-obligations show up negative. Treat the dollars as magnitude, not price discovery.
- **The key is per-user, but the script is shared.** User properties keep your key out of the grid and away from other viewers, but anyone who can *edit the script* controls what runs under your authorization. Share the sheet accordingly.

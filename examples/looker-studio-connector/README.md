# Looker Studio connector

A [Looker Studio community connector](https://developers.google.com/looker-studio/connector) that turns Tango into a **market research dashboard**. One connector, two datasets, both filtered to the same market:

- **Requirements — what's posting.** SAM.gov opportunities matching your requirement, open *and* closed: how often it posts, under what set-asides, from which buying offices, with deadlines and links for the live ones.
- **Awards — who's winning.** FPDS obligations for the same work: spend over time, top vendors, set-aside dollars, agency mix.

Add the connector to a report twice — one data source per dataset, same market definition — and you get demand next to supply on one page: *"this requirement posts about once a month, mostly small-business set-asides, and these eight vendors split the dollars."* That's [`../market-research-sheet/`](../market-research-sheet/) turned into a wall dashboard that stays current, instead of a worksheet frozen at the moment you ran it.

Community connectors run on Apps Script — the same platform as the sheet example. One file of JavaScript, no server, no build step.

**Not a Google shop?** Skip to [Power BI and everything else](#power-bi-and-everything-else).

## Install (~5 minutes)

1. Open [script.new](https://script.new) and name the project.
2. Replace `Code.gs` with [`Code.gs`](./Code.gs) from this directory.
3. **Project Settings ▸ Show "appsscript.json" manifest file**, then replace its contents with [`appsscript.json`](./appsscript.json).
4. **Deploy ▸ Test deployments** — the connector appears as a *Google Workspace Add-on* with `Application(s): Data Studio` (this confirms the manifest registered). Copy the **Head Deployment ID** and open:
   ```
   https://lookerstudio.google.com/datasources/create?connectorId=<HEAD_DEPLOYMENT_ID>
   ```
   (Older editor versions show a clickable *Latest code* link instead — same destination.)
5. Authorize (expect the "unverified app" screen — it's your own script), then paste your Tango API key (from [tango.makegov.com](https://tango.makegov.com)) into Looker Studio's native KEY auth screen. The key lives in *your* user properties, never in the report.
6. Define the market and pick a **Dataset** — start with *Awards*, **Connect**, **Create report**. Then add the second side: in the report, **Add data ▸ your connector**, same market filters, Dataset = *Requirements*.

## Defining the market

Both datasets share one config. The **Requirement description** field is the semantic search — it's what makes this market research rather than a spend feed. A bare NAICS gives you category analytics; a description gives you *"work like ours."* Pair a description with a NAICS or PSC for the cleanest cut. Agency and set-aside narrow further; the row cap (500–5,000) bounds each refresh.

The report's date-range control drives both sources: posted dates for requirements, award dates for awards. Set it to a year or more — the 28-day default makes every market look dead.

## The market research layout

**Demand row** (Requirements data source):

| Widget | Dimension | Metric / setup | The question it answers |
| --- | --- | --- | --- |
| Time series | Posted (Year Month) | Requirements posted | Does this requirement recur? Seasonal? |
| Donut | Set-aside | Requirements posted | How does the government *intend* to compete this work? |
| Table | Agency, Office | Requirements posted | Who has this problem? |
| Table | Title, Response deadline, SAM.gov link — filter Status = Open | — | What can we bid *right now*? |

**Supply row** (Awards data source):

| Widget | Dimension | Metric / setup | The question it answers |
| --- | --- | --- | --- |
| Time series | Award date (Year Month) | Obligated | Are the dollars growing? |
| Bar | Vendor (top 10, sorted) | Obligated | Who wins this work — incumbents, teammates, competitors? |
| Donut | Set-aside | Obligated | How does the work *actually* get competed? |
| Table | Department, Agency | Obligated, Record Count | Where's the money coming from? |

The demand donut against the supply donut is the quiet star: intent (set-asides on notices) versus outcome (set-aside dollars on awards) is the rule-of-two conversation in two charts.

## The schemas

**Requirements:** posted date, title, solicitation #, status (Open/Closed), agency, office, NAICS, PSC, set-aside, response deadline, SAM.gov link, plus a `Requirements posted` count metric. Closed notices are most of the demand history; if text search over them comes up dry where a code filter wouldn't, the connector retries the closed pass on structure alone (same fallback as the sheet example).

**Awards:** award date, vendor, UEI, PIID, solicitation #, department/agency/office, NAICS and PSC code + description, set-aside, USASpending link, plus `Obligated` and `Total contract value` as SUM-aggregating USD metrics.

One row per notice or award, `?shape=`-trimmed to exactly these fields, cursor-paginated to the row cap.

## Power BI and everything else

Power Query does the same job in ~15 lines. **Get Data ▸ Blank Query ▸ Advanced Editor**, then:

```m
let
    ApiKey  = "YOUR_TANGO_API_KEY",
    BaseUrl = "https://tango.makegov.com/api/contracts/"
              & "?naics=541512&award_date_gte=2022-01-01"
              & "&shape=key,piid,award_date,obligated,recipient(display_name,uei),awarding_office(*)"
              & "&flat=true",
    GetPage = (url) => Json.Document(Web.Contents(url, [Headers = [#"X-API-KEY" = ApiKey]])),
    Pages   = List.Generate(
                () => GetPage(BaseUrl),
                (page) => page <> null,
                (page) => if page[next] <> null then GetPage(page[next]) else null),
    Rows    = List.Combine(List.Transform(Pages, each _[results])),
    Awards  = Table.FromRecords(Rows)
in
    Awards
```

Set the data source credential to **Anonymous** — auth rides in the `X-API-KEY` header. The `flat=true` parameter is the BI cheat code: nested objects arrive as dotted columns (`recipient.display_name`, `awarding_office.agency_name`), nothing to expand by hand. For the demand side, point the same pattern at `/api/opportunities/` with `search`/`naics`/`first_notice_date_after` filters.

Two honest notes: Power BI Desktop handles the pagination fine, but the *service*'s scheduled refresh dislikes dynamic URLs like cursor links — if you need scheduled refresh, land the data somewhere static first. And parameterize `ApiKey` instead of hardcoding it before you share the `.pbix`.

Tableau, Metabase, Superset, DuckDB: same story — any REST-to-table step plus `flat=true` gets you tidy tables; or schedule [`../market-research-sheet/`](../market-research-sheet/) and point your BI tool at the Sheet.

## Where to take it next

- **Forecasts as a third dataset.** The requirements that haven't posted yet: clone the requirements schema/fetch pair against `/api/forecasts/` for agency procurement forecasts.
- **Blends.** Blend demand and supply on NAICS + month to chart notices posted against dollars awarded on one axis.
- **Caching.** Add `CacheService` keyed on the query string if many viewers share a report — Looker Studio calls `getData` per widget.
- **Publishing.** This manifest is deliberately test-deployment-grade. For the connector gallery, put your own name/logo in `appsscript.json` and follow Google's [publishing checklist](https://developers.google.com/looker-studio/connector/publish).

## Caveats

- **Not run in CI.** Hits a live API; results move with the data.
- **Every widget is a query.** Looker Studio calls `getData` per chart per refresh; a busy report multiplied by the 5,000-row cap will feel it in Apps Script quotas and refresh time. Use the row cap, the date range, and *File ▸ Extract data* for big static views.
- **Obligations, not prices.** Obligated ≠ ceiling, de-obligations are negative — treat award dollars as magnitude.
- **Set-aside intent ≠ vendor size today.** A market full of set-aside history still deserves a SAM/DSBS check on the specific vendors before it goes in a memo.
- **Keys are per-user, code is shared.** KEY auth keeps credentials out of the report, but anyone who can edit the *script* controls what runs under connected users' authorization.

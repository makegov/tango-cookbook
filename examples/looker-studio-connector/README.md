# Looker Studio connector

A [Looker Studio community connector](https://developers.google.com/looker-studio/connector) that pipes Tango award data (FPDS obligations) straight into Google's free BI tool. Define a market — a description, a NAICS, a PSC, an agency, a set-aside — and dashboard the spend: obligations over time, top vendors, agency mix, set-aside split, all refreshing live from the API.

Where [`../market-research-sheet/`](../market-research-sheet/) answers *"who's winning this work?"* once, as a worksheet, this keeps the answer on a wall. Same platform, too: community connectors run on Apps Script, so it's still one file of JavaScript, no server, no build step.

**Not a Google shop?** Skip to [Power BI and everything else](#power-bi-and-everything-else) — the API's `flat=true` parameter makes Tango trivially tabular for any BI tool.

## Install (~5 minutes)

1. Open [script.new](https://script.new) and name the project.
2. Replace `Code.gs` with [`Code.gs`](./Code.gs) from this directory.
3. **Project Settings ▸ Show "appsscript.json" manifest file**, then replace its contents with [`appsscript.json`](./appsscript.json).
4. **Deploy ▸ Test deployments ▸ Select type: Looker Studio ▸ Done**, and click the *Latest code* link — it opens Looker Studio pointed at your connector.
5. Authorize, paste your Tango API key (from [tango.makegov.com](https://tango.makegov.com)) — Looker Studio's native KEY auth stores it in *your* user properties, never in the report.
6. Fill in the market filters (all optional, but give it at least a description, NAICS, or PSC), **Connect**, and **Create report**.

The report's own date-range control drives the query (`award_date_gte`/`lte`), so a viewer scrubbing the timeline re-pulls exactly that window.

## A starter dashboard, four widgets

| Widget | Dimension | Metric |
| --- | --- | --- |
| Time series | Award date (by month) | Obligated |
| Bar chart | Vendor (top 10) | Obligated |
| Donut | Set-aside | Obligated |
| Table | Department → Agency | Obligated, Record Count |

That's a market-share dashboard a BD lead or a small-business specialist can read in ten seconds: is spend growing, who owns it, and how much of it is set aside.

## The schema

Dimensions: award date, vendor, UEI, PIID, solicitation #, department, agency, office, NAICS code + description, PSC code + description, set-aside, USASpending link. Metrics: **Obligated** and **Total contract value**, both `SUM`-aggregating USD.

One row per award, capped by the *Max awards to pull* config option (500–5,000). The connector follows the API's cursor pagination until the cap; the `?shape=` parameter trims each record to exactly the fields above.

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

Set the data source credential to **Anonymous** — auth rides in the `X-API-KEY` header. The `flat=true` parameter is the BI cheat code: nested objects arrive as dotted columns (`recipient.display_name`, `awarding_office.agency_name`), so there's nothing to expand by hand.

Two honest notes: Power BI Desktop handles the pagination fine, but the *service*'s scheduled refresh dislikes dynamic URLs like cursor links — if you need scheduled refresh, land the data somewhere static first. And parameterize `ApiKey` instead of hardcoding it before you share the `.pbix`.

Tableau, Metabase, Superset, DuckDB: same story — any REST-to-table step plus `flat=true` gets you a tidy awards table; or schedule [`../market-research-sheet/`](../market-research-sheet/) and point your BI tool at the Sheet.

## Where to take it next

- **Opportunities as a second dataset.** Clone the schema/`getData` pair against `/api/opportunities/` and a config toggle — pipeline dashboards next to spend dashboards.
- **Blends.** Blend this source against itself on Vendor to chart a competitor's agency mix beside yours.
- **Caching.** Add `CacheService` keyed on the query string if many viewers share a report — Looker Studio re-calls `getData` per widget.
- **Publishing.** This manifest is deliberately test-deployment-grade. If you want it in the connector gallery, put your own name/logo in `appsscript.json` and follow Google's [publishing checklist](https://developers.google.com/looker-studio/connector/publish).

## Caveats

- **Not run in CI.** Hits a live API; results move with the data.
- **Every widget is a query.** Looker Studio calls `getData` per chart per refresh; a busy report multiplied by the 5,000-row cap will feel it in both Apps Script quotas and refresh time. Use the row cap, the date range, and *File ▸ Extract data* for big static views.
- **Obligations, not prices.** Same FPDS caveat as ever — obligated ≠ ceiling, de-obligations are negative, treat dollars as magnitude.
- **Keys are per-user, code is shared.** KEY auth keeps credentials out of the report, but anyone who can edit the *script* controls what runs under connected users' authorization.

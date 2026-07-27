/**
 * Tango Market Research — a Looker Studio community connector.
 *
 * One connector, two datasets, both filtered to the same market (a
 * description, a NAICS, a PSC, an agency, a set-aside):
 *
 *   Requirements — what's posting: SAM.gov opportunities, open and closed.
 *   Awards       — who's winning: FPDS obligations.
 *
 * Add the connector to a report twice — one data source per dataset —
 * and the dashboard shows demand next to supply: how often this
 * requirement posts, under what set-asides, and which vendors split the
 * dollars. Community connectors run on Apps Script, so this deploys from
 * the browser with no server and no build step.
 *
 * Auth: Looker Studio's native KEY flow — each user supplies their own
 * Tango API key once; it's stored in their user properties, never in the
 * report. Get a key at https://tango.makegov.com
 *
 * Docs: https://developers.google.com/looker-studio/connector
 */

const TANGO_BASE = "https://tango.makegov.com";

// Proven field shapes (the API's ?shape= parameter) — everything the
// schemas below need and nothing else, so pages stay small.
const AWARD_SHAPE = "key,piid,solicitation_identifier,award_date,obligated," +
  "total_contract_value,set_aside(*),recipient(uei,display_name)," +
  "awarding_office(*),naics(*),psc(*)";
const OPP_SHAPE = "opportunity_id,title,solicitation_number,active," +
  "response_deadline,first_notice_date,set_aside,naics_code,psc_code," +
  "sam_url,agency(name,code),office(office_name,office_code)";

const MAX_PAGES = 400; // hard backstop on cursor-following, whatever the row cap

// ----------------------------------------------------------------- auth --

function getAuthType() {
  const cc = DataStudioApp.createCommunityConnector();
  return cc.newAuthTypeResponse()
    .setAuthType(cc.AuthType.KEY)
    .setHelpUrl("https://tango.makegov.com")
    .build();
}

function isAuthValid() {
  const key = PropertiesService.getUserProperties().getProperty("TANGO_API_KEY");
  return key ? checkKey_(key) : false;
}

function setCredentials(request) {
  const key = (request.key || "").trim();
  if (!checkKey_(key)) return {errorCode: "INVALID_CREDENTIALS"};
  PropertiesService.getUserProperties().setProperty("TANGO_API_KEY", key);
  return {errorCode: "NONE"};
}

function resetAuth() {
  PropertiesService.getUserProperties().deleteProperty("TANGO_API_KEY");
}

function isAdminUser() {
  return false;
}

function checkKey_(key) {
  const resp = UrlFetchApp.fetch(TANGO_BASE + "/api/contracts/?shape=key", {
    headers: {"X-API-KEY": key},
    muteHttpExceptions: true,
  });
  return resp.getResponseCode() === 200;
}

// --------------------------------------------------------------- config --

function getConfig() {
  const cc = DataStudioApp.createCommunityConnector();
  const config = cc.getConfig();

  config.newInfo()
    .setId("about")
    .setText("Define the market once, then pick which side of it this data " +
      "source shows. Add the connector twice — one source per dataset — to " +
      "put demand (requirements) and supply (awards) in the same report.");

  config.newSelectSingle()
    .setId("dataset")
    .setName("Dataset")
    .setHelpText("Requirements = SAM.gov opportunities (what's posting). " +
      "Awards = FPDS obligations (who's winning). Defaults to Awards.")
    .addOption(config.newOptionBuilder().setLabel("Awards — who's winning (FPDS)").setValue("awards"))
    .addOption(config.newOptionBuilder().setLabel("Requirements — what's posting (SAM.gov)").setValue("requirements"));

  config.newTextInput()
    .setId("search")
    .setName("Requirement description")
    .setHelpText("Plain English — \"enterprise IT service desk\". Semantic search; this is what makes it market research rather than a spend feed.")
    .setAllowOverride(true);

  config.newTextInput()
    .setId("naics")
    .setName("NAICS code(s)")
    .setHelpText("541512, or 541511|541512 for OR.")
    .setAllowOverride(true);

  config.newTextInput()
    .setId("psc")
    .setName("PSC code(s)")
    .setHelpText("DE01, or DA01|DE01 for OR.")
    .setAllowOverride(true);

  config.newTextInput()
    .setId("agency")
    .setName("Agency")
    .setHelpText("Name, abbreviation, or code — fuzzy matched (\"VA\", \"Air Force\").")
    .setAllowOverride(true);

  config.newTextInput()
    .setId("set_aside")
    .setName("Set-aside code")
    .setHelpText("Optional — e.g. SBA, 8AN, WOSB.")
    .setAllowOverride(true);

  config.newSelectSingle()
    .setId("max_records")
    .setName("Max records to pull")
    .setHelpText("Per refresh. Higher = slower refreshes; Apps Script quotas apply.")
    .addOption(config.newOptionBuilder().setLabel("500").setValue("500"))
    .addOption(config.newOptionBuilder().setLabel("1,000").setValue("1000"))
    .addOption(config.newOptionBuilder().setLabel("2,500").setValue("2500"))
    .addOption(config.newOptionBuilder().setLabel("5,000").setValue("5000"));

  config.setDateRangeRequired(true);
  return config.build();
}

// --------------------------------------------------------------- schema --

function getFields_(dataset) {
  return dataset === "requirements" ? requirementFields_() : awardFields_();
}

function awardFields_() {
  const cc = DataStudioApp.createCommunityConnector();
  const fields = cc.getFields();
  const types = cc.FieldType;
  const aggs = cc.AggregationType;

  fields.newDimension().setId("award_date").setName("Award date").setType(types.YEAR_MONTH_DAY);
  fields.newDimension().setId("vendor").setName("Vendor").setType(types.TEXT);
  fields.newDimension().setId("uei").setName("UEI").setType(types.TEXT);
  fields.newDimension().setId("piid").setName("PIID").setType(types.TEXT);
  fields.newDimension().setId("solicitation").setName("Solicitation #").setType(types.TEXT);
  fields.newDimension().setId("department").setName("Department").setType(types.TEXT);
  fields.newDimension().setId("agency").setName("Agency").setType(types.TEXT);
  fields.newDimension().setId("office").setName("Office").setType(types.TEXT);
  fields.newDimension().setId("naics_code").setName("NAICS code").setType(types.TEXT);
  fields.newDimension().setId("naics_description").setName("NAICS description").setType(types.TEXT);
  fields.newDimension().setId("psc_code").setName("PSC code").setType(types.TEXT);
  fields.newDimension().setId("psc_description").setName("PSC description").setType(types.TEXT);
  fields.newDimension().setId("set_aside").setName("Set-aside").setType(types.TEXT);
  fields.newDimension().setId("usaspending_url").setName("USASpending link").setType(types.URL);

  fields.newMetric().setId("obligated").setName("Obligated").setType(types.CURRENCY_USD).setAggregation(aggs.SUM);
  fields.newMetric().setId("total_value").setName("Total contract value").setType(types.CURRENCY_USD).setAggregation(aggs.SUM);

  fields.setDefaultDimension("award_date");
  fields.setDefaultMetric("obligated");
  return fields;
}

function requirementFields_() {
  const cc = DataStudioApp.createCommunityConnector();
  const fields = cc.getFields();
  const types = cc.FieldType;
  const aggs = cc.AggregationType;

  fields.newDimension().setId("posted_date").setName("Posted").setType(types.YEAR_MONTH_DAY);
  fields.newDimension().setId("title").setName("Title").setType(types.TEXT);
  fields.newDimension().setId("solicitation_number").setName("Solicitation #").setType(types.TEXT);
  fields.newDimension().setId("status").setName("Status").setType(types.TEXT);
  fields.newDimension().setId("agency").setName("Agency").setType(types.TEXT);
  fields.newDimension().setId("office").setName("Office").setType(types.TEXT);
  fields.newDimension().setId("naics_code").setName("NAICS code").setType(types.TEXT);
  fields.newDimension().setId("psc_code").setName("PSC code").setType(types.TEXT);
  fields.newDimension().setId("set_aside").setName("Set-aside").setType(types.TEXT);
  fields.newDimension().setId("response_deadline").setName("Response deadline").setType(types.YEAR_MONTH_DAY);
  fields.newDimension().setId("sam_url").setName("SAM.gov link").setType(types.URL);

  fields.newMetric().setId("opportunity_count").setName("Requirements posted").setType(types.NUMBER).setAggregation(aggs.SUM);

  fields.setDefaultDimension("posted_date");
  fields.setDefaultMetric("opportunity_count");
  return fields;
}

function getSchema(request) {
  const dataset = datasetOf_(request.configParams);
  return {schema: getFields_(dataset).build()};
}

function datasetOf_(configParams) {
  return configParams && configParams.dataset === "requirements" ? "requirements" : "awards";
}

// ----------------------------------------------------------------- data --

function getData(request) {
  const params = request.configParams || {};
  const dataset = datasetOf_(params);
  const range = request.dateRange || {};
  const sample = request.scriptParams && request.scriptParams.sampleExtraction;
  const cap = sample ? 25 : Number(params.max_records) || 1000;

  let records;
  try {
    records = dataset === "requirements"
      ? fetchRequirements_(params, range, cap)
      : fetchAwards_(params, range, cap);
  } catch (err) {
    DataStudioApp.createCommunityConnector()
      .newUserError()
      .setText("Tango request failed: " + err.message)
      .setDebugText(String(err))
      .throwException();
  }

  const ids = request.fields.map((f) => f.name);
  const mapper = dataset === "requirements" ? rowValuesRequirement_ : rowValuesAward_;
  return {
    schema: getFields_(dataset).forIds(ids).build(),
    rows: records.map((r) => ({values: mapper(ids, r)})),
  };
}

function fetchAwards_(params, range, cap) {
  return tangoList_("/api/contracts/", {
    search: params.search,
    naics: params.naics,
    psc: params.psc,
    awarding_agency: params.agency,
    set_aside: params.set_aside,
    award_date_gte: range.startDate,
    award_date_lte: range.endDate,
    shape: AWARD_SHAPE,
  }, cap);
}

/**
 * Open + closed opportunities in the report's date window. Closed notices
 * are most of the demand history; if text search over them comes up dry
 * and a code filter exists, retry the closed pass on structure alone —
 * same fallback as the market-research-sheet example.
 */
function fetchRequirements_(params, range, cap) {
  const base = {
    search: params.search,
    naics: params.naics,
    psc: params.psc,
    agency: params.agency,
    set_aside: params.set_aside,
    first_notice_date_after: range.startDate,
    first_notice_date_before: range.endDate,
    ordering: "-first_notice_date",
    shape: OPP_SHAPE,
  };
  const open = tangoList_("/api/opportunities/", Object.assign({}, base, {active: "true"}), cap);
  const remaining = cap - open.length;
  let closed = [];
  if (remaining > 0) {
    closed = tangoList_("/api/opportunities/", Object.assign({}, base, {active: "false"}), remaining);
    if (!closed.length && base.search && (base.naics || base.psc)) {
      closed = tangoList_("/api/opportunities/", Object.assign({}, base, {active: "false", search: null}), remaining);
    }
  }
  return open.concat(closed);
}

/** Maps one award record onto the requested field ids, in order. */
function rowValuesAward_(ids, a) {
  const recipient = a.recipient || {};
  const office = a.awarding_office || {};
  return ids.map((id) => {
    switch (id) {
      case "award_date": return ymd_(a.award_date);
      case "vendor": return recipient.display_name || "";
      case "uei": return recipient.uei || "";
      case "piid": return a.piid || "";
      case "solicitation": return a.solicitation_identifier || "";
      case "department": return office.department_name || "";
      case "agency": return office.agency_name || "";
      case "office": return office.office_name || "";
      case "naics_code": return a.naics && a.naics.code != null ? String(a.naics.code) : "";
      case "naics_description": return (a.naics && a.naics.description) || "";
      case "psc_code": return (a.psc && a.psc.code) || "";
      case "psc_description": return (a.psc && a.psc.description) || "";
      case "set_aside": return (a.set_aside && (a.set_aside.code || a.set_aside.description)) || "";
      case "usaspending_url": return a.key ? "https://www.usaspending.gov/award/" + encodeURIComponent(a.key) : "";
      case "obligated": return Number(a.obligated) || 0;
      case "total_value": return Number(a.total_contract_value) || 0;
      default: return "";
    }
  });
}

/** Maps one opportunity record onto the requested field ids, in order. */
function rowValuesRequirement_(ids, o) {
  return ids.map((id) => {
    switch (id) {
      case "posted_date": return ymd_(o.first_notice_date);
      case "title": return o.title || "";
      case "solicitation_number": return o.solicitation_number || "";
      case "status": return o.active ? "Open" : "Closed";
      case "agency": return (o.agency && o.agency.name) || "";
      case "office": return (o.office && o.office.office_name) || "";
      case "naics_code": return o.naics_code != null && o.naics_code !== "" ? String(o.naics_code) : "";
      case "psc_code": return o.psc_code || "";
      case "set_aside": return o.set_aside || "";
      case "response_deadline": return ymd_(o.response_deadline);
      case "sam_url": return o.sam_url || "";
      case "opportunity_count": return 1;
      default: return "";
    }
  });
}

/** "2026-07-07T15:48:23Z" or "2026-07-07" -> "20260707" (Looker Studio YEAR_MONTH_DAY). */
function ymd_(value) {
  return value ? String(value).slice(0, 10).replace(/-/g, "") : "";
}

// ---------------------------------------------------------------- tango --

function tangoFetch_(url) {
  const key = PropertiesService.getUserProperties().getProperty("TANGO_API_KEY");
  const resp = UrlFetchApp.fetch(url, {
    headers: {"X-API-KEY": key},
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code === 401 || code === 403) {
    throw new Error("Tango rejected the API key — reconnect the data source to re-enter it.");
  }
  if (code >= 400) {
    throw new Error("HTTP " + code + ": " + String(resp.getContentText()).slice(0, 300));
  }
  return JSON.parse(resp.getContentText());
}

/** GETs a list endpoint and follows cursor pagination until `cap` records. */
function tangoList_(path, params, cap) {
  let url = TANGO_BASE + path + "?" + buildQuery_(params);
  const out = [];
  let pages = 0;
  while (url && out.length < cap && pages < MAX_PAGES) {
    const body = tangoFetch_(url);
    const page = body.results || [];
    for (let i = 0; i < page.length && out.length < cap; i++) out.push(page[i]);
    url = body.next || null;
    pages += 1;
  }
  return out;
}

function buildQuery_(params) {
  const parts = [];
  for (const k in params) {
    if (params[k] !== "" && params[k] != null) {
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
  }
  return parts.join("&");
}

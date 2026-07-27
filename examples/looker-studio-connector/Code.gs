/**
 * Tango Federal Awards — a Looker Studio community connector.
 *
 * Pipes Tango award data (FPDS obligations) straight into Looker Studio,
 * so a market — a NAICS, a PSC, an agency, a search phrase — becomes a
 * live dashboard: spend over time, top vendors, agency mix, set-aside
 * split. Community connectors run on Apps Script, so this deploys from
 * the browser with no server and no build step.
 *
 * Auth: Looker Studio's native KEY flow — each viewer-turned-editor
 * supplies their own Tango API key once; it's stored in their user
 * properties, never in the report. Get a key at https://tango.makegov.com
 *
 * Docs: https://developers.google.com/looker-studio/connector
 */

const TANGO_BASE = "https://tango.makegov.com";

// Proven field shape (the API's ?shape= parameter) — everything the
// schema below needs and nothing else, so pages stay small.
const AWARD_SHAPE = "key,piid,solicitation_identifier,award_date,obligated," +
  "total_contract_value,set_aside(*),recipient(uei,display_name)," +
  "awarding_office(*),naics(*),psc(*)";

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
    .setText("Define the market. Every filter is optional, but at least one " +
      "of description / NAICS / PSC keeps the data volume sane. The " +
      "report's date range controls the award dates pulled.");

  config.newTextInput()
    .setId("search")
    .setName("Requirement description")
    .setHelpText("Plain English — \"enterprise IT service desk\". Semantic search over award descriptions.")
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
    .setName("Awarding agency")
    .setHelpText("Name, abbreviation, or code — fuzzy matched (\"VA\", \"Air Force\").")
    .setAllowOverride(true);

  config.newTextInput()
    .setId("set_aside")
    .setName("Set-aside code")
    .setHelpText("Optional — e.g. SBA, 8AN, WOSB.")
    .setAllowOverride(true);

  config.newSelectSingle()
    .setId("max_records")
    .setName("Max awards to pull")
    .setHelpText("Per refresh. Higher = slower refreshes; Apps Script quotas apply.")
    .addOption(config.newOptionBuilder().setLabel("500").setValue("500"))
    .addOption(config.newOptionBuilder().setLabel("1,000").setValue("1000"))
    .addOption(config.newOptionBuilder().setLabel("2,500").setValue("2500"))
    .addOption(config.newOptionBuilder().setLabel("5,000").setValue("5000"));

  config.setDateRangeRequired(true);
  return config.build();
}

// --------------------------------------------------------------- schema --

function getFields_() {
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

function getSchema() {
  return {schema: getFields_().build()};
}

// ----------------------------------------------------------------- data --

function getData(request) {
  const params = request.configParams || {};
  const range = request.dateRange || {};
  const sample = request.scriptParams && request.scriptParams.sampleExtraction;
  const cap = sample ? 25 : Number(params.max_records) || 1000;

  const query = {
    search: params.search,
    naics: params.naics,
    psc: params.psc,
    awarding_agency: params.agency,
    set_aside: params.set_aside,
    award_date_gte: range.startDate,
    award_date_lte: range.endDate,
    shape: AWARD_SHAPE,
  };

  let awards;
  try {
    awards = tangoList_("/api/contracts/", query, cap);
  } catch (err) {
    DataStudioApp.createCommunityConnector()
      .newUserError()
      .setText("Tango request failed: " + err.message)
      .setDebugText(String(err))
      .throwException();
  }

  const ids = request.fields.map((f) => f.name);
  const requested = getFields_().forIds(ids);
  return {
    schema: requested.build(),
    rows: awards.map((a) => ({values: rowValues_(ids, a)})),
  };
}

/** Maps one award record onto the requested field ids, in order. */
function rowValues_(ids, a) {
  const recipient = a.recipient || {};
  const office = a.awarding_office || {};
  return ids.map((id) => {
    switch (id) {
      case "award_date": return String(a.award_date || "").replace(/-/g, "");
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
